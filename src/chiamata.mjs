// La telefonata: ascolta il cliente (VAD a energia + faster-whisper), passa le frasi a
// Claude Code e legge la risposta con Qwen3-TTS, una frase alla volta mentre Claude scrive.
// Funziona uguale per Twilio e per la chiamata dal browser (stesso protocollo Media Streams).
import { CONFIG } from './config.mjs';
import { istruzioni, salutoSegmenti, salutoCompleto } from './persona.mjs';
import { postiLiberi, postiPerIstruzioni } from './agenda.mjs';
import { confermaAppuntamento, registraRichiamo } from './strumenti.mjs';
import { Cervello } from './cervello.mjs';
import { consensoPrenotazione, consensoRichiamo, congedoCliente } from './consenso.mjs';
import { numeriInParole, punteggiaturaDaVoce } from './parlato.mjs';
import { creaRegolatoreIntercalari } from './intercalari.mjs';
import { impostazioni } from './impostazioni.mjs';
import { estraiIntento, regoleCandidate } from './intenti.mjs';
import { daMulaw, trascrivi, pronuncia, frasePronta, fraseSubito, fraseInDiretta } from './voce.mjs';
import { creaRumoreAttesa, creaSuonoContinuo, fermaAttesaPrimaDellaVoce, mescolaSuono } from './attesa.mjs';

const FRAME_MS = 20;
// Al telefono i primi istanti della chiamata si perdono: un breve silenzio in testa al
// saluto fa perdere quello, non la prima parola ("Lasercamp" che diventava "camp").
const SILENZIO_AVVIO_MS = 1200;
const silenzioAvvio = () => Buffer.alloc(SILENZIO_AVVIO_MS * 8, 0xff);
// Ogni risposta al telefono riparte col playout da zero (spesso subito dopo un clear del
// rumore d'attesa): un silenzio in testa alla prima frase protegge la prima sillaba.
const SILENZIO_TURNO_MS = 200;
const silenzioTurno = () => Buffer.alloc(SILENZIO_TURNO_MS * 8, 0xff);
export const RIEMPITIVO = 'Sì, un attimo.';

// Claude scritto con i marcatori: quali azioni ci sono e cosa resta da dire.
function separa(testo) {
  const azioni = [...testo.matchAll(/<<\s*(CONFERMA|RICHIAMA|FINE)\s*(?:\|([^>]*))?>>/g)].map(([, tipo, a]) => ({ tipo, argomenti: (a || '').split('|').map((x) => x.trim()) }));
  const parlato = punteggiaturaDaVoce(numeriInParole(testo.replace(/<<[^>]*(?:>>|$)/g, '').replace(/\[[^\]]*\]/g, '').replace(/[*_#`]/g, '')));
  return { azioni, parlato };
}

// Numero dettato a voce: restano le cifre (con eventuale +), spazi e trattini via.
export function numeroDettato(valore) {
  const cifre = String(valore || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return cifre.replace(/\D/g, '').length >= 6 && cifre.length <= 20 ? cifre : '';
}

function campoAzione(valore, massimo) {
  const testo = String(valore || '').trim();
  if (!testo || testo.length > massimo || /[\u0000-\u001f\u007f]|<<|>>/.test(testo)) return '';
  return testo;
}

function emailAzione(valore) {
  const email = campoAzione(valore, 254);
  return email && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email) ? email : '';
}

// "info chiocciola nome punto it" oppure "info@nome.it" → indirizzo scritto.
export function emailDaVoce(testo) {
  const normalizzato = String(testo || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s*\b(?:chiocciola|at)\b\s*/g, '@')
    .replace(/\s*\b(?:punto|dot)\b\s*/g, '.');
  const trovato = normalizzato.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/i)?.[0] || '';
  return emailAzione(trovato);
}

export function evitaRichiestaEmailPreventivo(testo, emailAttivita = '') {
  const originale = String(testo || '').trim();
  const richiestaContatto = /(?:\bmi\s+(?:lasci|lascia|comunichi|comunica|dice|dia)\b|(?:qual\s*(?:è|e)?|quale|a che)).{0,100}\b(?:e-?mail|mail|indirizzo)\b|\b(?:e-?mail|mail|indirizzo)\b.{0,100}(?:qual\s*(?:è|e)?|quale|a che|\bmi\s+(?:lasci|lascia|comunichi|comunica|dice|dia)\b)/i;
  const filtrato = (originale.match(/[^.!?]+[.!?]?/g) || [])
    .filter((frase) => !richiestaContatto.test(frase))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (filtrato === originale) return originale;
  const email = emailAzione(emailAttivita);
  const destinazione = email ? email.replace('@', ' chiocciola ').replace(/\./g, ' punto ') : '';
  return `${filtrato}${filtrato && !/[.!?]$/.test(filtrato) ? '.' : ''}${destinazione ? ` Può inviare il file a ${destinazione}.` : ''}`.trim();
}

// Parakeet sceglie la lingua da solo: eco dell'altoparlante e rumori diventano spesso frasette
// in inglese ("Yeah, we're here"). Se la frase è fatta soprattutto di parole inglesi, non è il cliente.
const INGLESE = new Set("yeah yes yep so uh um oh the a an you and hmm we we're here there that that's it it's is are was just why because with what i i'm my me your this of to in on for be have do not but all can will like know right well hi hello bye thank thanks".split(' '));
const ITALIANO = /[àèéìòù]|\b(che|non|per|sono|il|la|lo|gli|le|un|una|di|da|con|mi|ti|si|ci|ok|okay|no|ciao|grazie|buongiorno|pronto|vorrei|appuntamento|va|bene)\b/i;
// Parole che distinguono il tedesco dall'italiano (non quelle uguali nelle due lingue).
const TEDESCO = /[äöüß]|\b(ich|sie|wir|ihr|ihre|ihnen|nicht|und|der|die|das|ein|eine|ist|sind|haben|habe|bitte|danke|guten|tag|termin|gerne|ja|nein|wann|möchte|moechte|können|koennen|kann|uhr|montag|dienstag|mittwoch|donnerstag|freitag|auch|dann|wie|für|mit|noch|hier|zu|von|bei|dem|den|auf|aber|oder|gut|schön|hallo|wieder|sehen|ihnen|mir|mich|dich|machen|brauche|brauchen|wollen|will|frei|belegt|herr|frau|termine|montage|gern|vielen|dank|perfekt|wunderbar|leider|einen|moment|ordnung|wiedersehen|zeit|name|nummer|sehr|passt|stück)\b/gi;
const SOLO_ITALIANO = /[àèéìòù]|\b(che|non|per|sono|il|la|lo|gli|le|un|una|di|con|mi|ti|si|ci|ho|alle|ma|come|quale|va|bene|grazie|buongiorno|perfetto|certo|vorrei|appuntamento|mattina|pomeriggio|piacere|buona|giornata|arrivederci|ciao|prego|mezzogiorno|signor|signora|dodici|dieci|undici|quattordici)\b/gi;
export function rilevaLingua(testo, precedente = 'it') {
  const de = (testo.match(TEDESCO) || []).length, it = (testo.match(SOLO_ITALIANO) || []).length;
  if (de === 0 && it === 0) return precedente; // frase cortissima: resta nella lingua di prima
  return de > it ? 'de' : 'it';
}
export function nonItaliano(frase) {
  if (ITALIANO.test(frase) || /[äöüß]|\b(ich|wir|sie|nicht|und|bitte|danke|guten|termin|gerne|ja|nein|haben)\b/i.test(frase)) return false;
  const parole = frase.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
  // Le frasi corte sono quasi sempre eco o rumore; un cliente inglese vero parla più a lungo e deve arrivare al receptionist
  // (che si scusa in italiano): sopra le quattro parole serve quasi solo inglese da eco ("Yeah, we're here, that's it, it's").
  return parole.length > 0 && parole.filter((p) => INGLESE.has(p)).length / parole.length >= (parole.length <= 4 ? 0.5 : 0.9);
}

// Le istruzioni si rifanno a ogni chiamata: impostazioni e posti liberi sono sempre quelli di adesso.
export async function preparaCervello(chiamante) {
  let posti = '';
  try { posti = await postiPerIstruzioni(); } catch (e) { console.error('posti liberi non calcolati:', e.message); }
  return new Cervello(istruzioni({ chiamante, posti }));
}

const inAttesa = new Map(); // callSid → Cervello aperto mentre squilla
export function preriscalda(callSid, chiamante) {
  if (!callSid || inAttesa.has(callSid)) return;
  const c = preparaCervello(chiamante);
  inAttesa.set(callSid, c);
  setTimeout(() => { if (inAttesa.get(callSid) === c) { inAttesa.delete(callSid); c.then((x) => x.chiudi()); } }, 60000).unref();
}

export function gestisciChiamata(chiamata, dipendenze = {}) {
  const trascriviAudio = dipendenze.trascrivi || trascrivi;
  const pronunciaTesto = dipendenze.pronuncia || pronuncia;
  const fraseInCache = dipendenze.frasePronta || frasePronta;
  // prove con la voce finta: se è iniettata solo frasePronta, il saluto resta quello atteso dai test
  const salutoIniettato = Boolean(dipendenze.frasePronta) && !dipendenze.fraseSubito && !dipendenze.fraseInDiretta;
  const salutoPronto = salutoIniettato ? null : (dipendenze.fraseSubito || fraseSubito);
  const salutoInDiretta = salutoIniettato ? null : (dipendenze.fraseInDiretta || fraseInDiretta);
  const prepara = dipendenze.preparaCervello || preparaCervello;
  const salutoIntero = dipendenze.salutoCompleto || salutoCompleto;
  const segmentiSaluto = dipendenze.salutoSegmenti || salutoSegmenti;
  const creaTastiera = dipendenze.creaRumoreAttesa || creaRumoreAttesa;
  const conferma = dipendenze.confermaAppuntamento || confermaAppuntamento;
  const registra = dipendenze.registraRichiamo || registraRichiamo;
  const leggiPostiLiberi = dipendenze.postiLiberi || postiLiberi;
  const logFrase = (chi, frase, metadati = {}) => {
    if (typeof chiamata.logSensibile === 'function') chiamata.logSensibile(`${chi} frase`, { caratteri: String(frase || '').length, ...metadati });
    else chiamata.log(`${chi} ${frase}${metadati.ascoltoMs !== undefined ? ` (ascolto ${metadati.ascoltoMs} ms${metadati.voceOccupata ? ', voce occupata' : ''})` : ''}`);
  };
  const v = CONFIG.vad;
  let cervello = null;
  let cervelloPronto = null; // Claude si avvia mentre parte il saluto
  let parlando = false; // il cliente sta parlando
  let voce = 0, muto = 0; // frame consecutivi sopra/sotto soglia
  let preRoll = [];
  let frase = [];
  let turno = 0; // turno di risposta che vogliamo sentire
  let bufferTesto = '';
  let testoTurno = '';
  let giaDetto = false; // il primo pezzo della risposta è già partito
  let coda = Promise.resolve(); // frasi da leggere, in ordine
  let annulla = new AbortController();
  let fineTurno = 0; // quando il cliente ha smesso di parlare
  let primoAudio = true;
  let silenzioDaInviare = false; // la prima frase della risposta porta un silenzio protettivo (solo telefono)
  let riempitivo = null;
  let chiudere = false;
  let richiamoId = null; // il primo RICHIAMA della chiamata: gli altri lo aggiornano invece di duplicarlo
  let confermato = false; // un solo appuntamento per chiamata: i CONFERMA ripetuti si ignorano
  const deveChiedereEmail = Boolean(impostazioni().email?.chiediEmail);
  let emailChiesta = false;
  let attendeRispostaEmail = false;
  let emailRaccolta = '';
  let confermaInAttesa = null;
  let richiamoInAttesa = null;
  let ultimoCliente = ''; // l'ultima frase del cliente, per capire se ha davvero salutato
  let ultimoReceptionist = '';
  const statoIntento = { intento: 'altro', fonte: 'fallback', candidati: [], visti: [] };
  const gestioneRichieste = impostazioni().gestioneRichieste;
  const regolaIntercalare = creaRegolatoreIntercalari(impostazioni().receptionist?.intercalare);
  const ritardi = [];
  const tastiera = creaTastiera({
    // impostazioni del pannello (scheda Suoni) lette a ogni avvio: vale subito, anche a chiamata in corso.
    // Nel browser mobile i tocchi compressi possono sembrare crepitii: restano solo sul telefono Twilio.
    attivo: () => Boolean(impostazioni().suoni?.attiva ?? CONFIG.tastiera.attiva) && !chiamata.web,
    volume: () => impostazioni().suoni?.volume ?? CONFIG.tastiera.volume,
    tipo: () => impostazioni().suoni?.tipo || 'tastiera',
    // Audio raw: niente mark e niente inviaAudio(), quindi non altera latenza o stato parlante.
    invia: (mulaw) => chiamata.inviaAudio(mulaw.toString('base64')),
  });
  // sottofondo d'ufficio da mescolare sotto la voce di Maria (pannello: scheda Suoni);
  // la voce resta identica nei tempi: il mix è solo aritmetica sui pacchetti in uscita.
  const ambientale = creaSuonoContinuo({
    attivo: () => Boolean(impostazioni().suoni?.attiva ?? CONFIG.tastiera.attiva),
    volume: () => impostazioni().suoni?.volume ?? CONFIG.tastiera.volume,
    tipo: () => impostazioni().suoni?.tipo || 'tastiera',
  });

  const testo = (chi, t) => chiamata.testo?.(chi, t);

  function interrompi(motivo) {
    turno = 0; // scarta anche una risposta del cervello che arriva mentre il cliente riprende a parlare
    annulla.abort();
    annulla = new AbortController();
    coda = Promise.resolve();
    bufferTesto = '';
    testoTurno = '';
    giaDetto = false;
    clearTimeout(riempitivo);
    const avevaTastiera = tastiera.ferma();
    if (chiamata.sta_parlando || avevaTastiera) chiamata.svuota();
    if (chiamata.sta_parlando) chiamata.log(`✂ ${motivo}`);
  }

  function inviaAudio(mulaw, soloRiempitivo = false) {
    fermaAttesaPrimaDellaVoce(tastiera, () => chiamata.svuota());
    if (primoAudio && fineTurno) {
      const ms = Date.now() - fineTurno;
      ritardi.push(ms);
      chiamata.log(`⏱ primo audio ${ms} ms dopo la fine della frase`);
      fineTurno = 0;
    }
    primoAudio = false;
    if (silenzioDaInviare) {
      silenzioDaInviare = false;
      if (!chiamata.web) chiamata.inviaAudio(silenzioTurno().toString('base64'));
    }
    clearTimeout(riempitivo);
    // la voce parte con lo stesso timing di sempre: il sottofondo si somma al volo, senza attese
    const sottofondo = ambientale.strappa(mulaw.length);
    chiamata.inviaAudio(mescolaSuono(mulaw, sottofondo).toString('base64'));
    chiamata.marca();
  }

  let linguaVoce = 'it';
  function leggi(frase) {
    const segnale = annulla.signal;
    linguaVoce = rilevaLingua(frase, linguaVoce);
    const lingua = linguaVoce;
    coda = coda.then(async () => {
      if (segnale.aborted) return;
      try { await pronunciaTesto(frase, (p) => { if (!segnale.aborted) inviaAudio(p); }, { segnale, lingua }); } catch (e) { if (!segnale.aborted) chiamata.log('errore voce', e.message); }
    });
  }

  async function allaFrase(pcm) {
    fineTurno = Date.now();
    tastiera.avvia();
    let t;
    try { t = await trascriviAudio(pcm); } catch (e) {
      fermaAttesaPrimaDellaVoce(tastiera, () => chiamata.svuota());
      return chiamata.log('errore ascolto', e.message);
    }
    const detto = t.testo.trim();
    if (!detto || /^[\s.,!?…-]*$/.test(detto) || /sottotitoli|amara\.org|grazie per la visione/i.test(detto) || nonItaliano(detto)) {
      fineTurno = 0; // rumore o "allucinazione" tipica di Whisper sul silenzio
      fermaAttesaPrimaDellaVoce(tastiera, () => chiamata.svuota());
      return;
    }
    logFrase('👤', detto, { ascoltoMs: t.ms, voceOccupata: Boolean(t.voce_occupata) });
    testo('cliente', detto);
    ultimoCliente = detto;
    const registrato = await registraConfermaInAttesa(detto);
    const richiamoRegistrato = await registraRichiamoInAttesa(detto);
    await attendiCervello();
    nuovoTurno(detto, registrato, true, richiamoRegistrato);
  }

  function nuovoTurno(detto, registratoAdesso = false, conTastiera = false, richiamoRegistrato = false) {
    interrompi('nuova frase del cliente');
    primoAudio = true;
    silenzioDaInviare = !chiamata.web;
    if (!fineTurno) fineTurno = Date.now();
    const rispondevaEmail = attendeRispostaEmail;
    const emailDetta = emailDaVoce(detto);
    if (emailDetta) {
      emailRaccolta = emailDetta;
      emailChiesta = true;
    }
    let perCervello = rispondevaEmail
      ? `Risposta del cliente alla domanda "Le mando la conferma per email, quale indirizzo?": ${detto}`
      : detto;
    attendeRispostaEmail = false;
    if (registratoAdesso) {
      perCervello = `Il cliente ha confermato il riepilogo e il sistema ha registrato l'appuntamento. Digli che è tutto segnato e chiedi se gli serve altro. Non scrivere di nuovo CONFERMA. Il cliente ha detto: ${detto}`;
    } else if (richiamoRegistrato) {
      perCervello = `Il cliente ha accettato il richiamo e il sistema lo ha registrato. Digli brevemente che un collega lo richiamerà. Non scrivere di nuovo RICHIAMA. Il cliente ha detto: ${detto}`;
    }
    if (emailRaccolta) {
      perCervello = `Stato certo: l'indirizzo email del cliente è già stato acquisito dal sistema. Non chiederlo, non richiederlo e non farlo ripetere.\n${perCervello}`;
    }
    statoIntento.candidati = regoleCandidate(detto, gestioneRichieste);
    turno = cervello.ascolta(perCervello);
    if (conTastiera) tastiera.avvia();
    if (CONFIG.riempitivoSecondi >= 0) {
      riempitivo = setTimeout(async () => {
        const audio = await fraseInCache(RIEMPITIVO).catch(() => null);
        if (audio && primoAudio) { chiamata.log('🫧 riempitivo'); inviaAudio(audio, true); primoAudio = true; }
      }, CONFIG.riempitivoSecondi * 1000);
    }
  }

  function collegaCervello() {
    const emetti = (grezzo, n) => {
      const parlato = regolaIntercalare(grezzo, n).trim();
      if (!parlato) return;
      testoTurno = parlato;
      leggi(parlato);
    };
    cervello.alTesto = (pezzo, n) => {
      if (n !== turno) return; // risposta a una frase ormai superata
      if (!bufferTesto && !giaDetto && fineTurno) chiamata.log(`🧠 primo testo di Claude dopo ${Date.now() - fineTurno} ms`);
      bufferTesto += pezzo;
      giaDetto = true;
    };
    cervello.allaFine = async (completo, n) => {
      if (n !== turno) return;
      const riconosciuto = estraiIntento(completo, statoIntento.candidati, {
        automatica: gestioneRichieste?.automatica !== false,
      });
      statoIntento.intento = riconosciuto.intento;
      statoIntento.fonte = riconosciuto.fonte;
      statoIntento.visti.push({ intento: riconosciuto.intento, fonte: riconosciuto.fonte });
      if (riconosciuto.intento !== 'appuntamento') confermaInAttesa = null;
      if (!['assistenza_problema', 'richiamata'].includes(riconosciuto.intento)) richiamoInAttesa = null;
      const candidati = statoIntento.candidati.map((r) => r.id || r.nome).filter(Boolean);
      chiamata.log(`🎯 ${riconosciuto.intento} (${riconosciuto.fonte}${candidati.length ? `; candidati: ${candidati.join(', ')}` : ''})`);
      // Una sola sintesi per tutta la battuta: Qwen conserva l'arco naturale tra virgole,
      // punti e domanda. Spezzare ogni frase faceva ripartire il tono da zero e suonava robotico.
      const separata = separa(riconosciuto.testo);
      const primaConferma = separata.azioni.find((a) => a.tipo === 'CONFERMA');
      if (primaConferma && emailRaccolta) primaConferma.argomenti[4] = emailRaccolta;
      // Il modello può tentare di chiudere la prenotazione appena riceve il motivo. Se nel pannello
      // è attiva la raccolta email, la domanda viene imposta qui: non dipende dalla memoria del modello.
      if (statoIntento.intento === 'appuntamento' && deveChiedereEmail && !emailChiesta && primaConferma && !primaConferma.argomenti[4]) {
        bufferTesto = '';
        emailChiesta = true;
        attendeRispostaEmail = true;
        const domanda = linguaVoce === 'de'
          ? 'Ich schicke Ihnen die Bestätigung per E-Mail. Wie lautet Ihre E-Mail-Adresse?'
          : 'Le mando la conferma per email, quale indirizzo?';
        emetti(domanda, n);
        ultimoReceptionist = testoTurno.trim();
        logFrase('🤖', ultimoReceptionist);
        testo('receptionist', ultimoReceptionist);
        chiamata.log('⚠️ CONFERMA rimandata: prima va chiesta l’email');
        return;
      }
      let { parlato } = separata;
      const { azioni } = separata;
      if (statoIntento.intento === 'preventivo_file') {
        const filtrato = evitaRichiestaEmailPreventivo(parlato, impostazioni().attivita?.email);
        if (filtrato !== parlato) chiamata.log('🛡️ richiesta email personale rimossa dal preventivo');
        parlato = filtrato;
      }
      bufferTesto = '';
      emetti(parlato, n);
      const tutto = testoTurno.trim();
      if (deveChiedereEmail && !emailChiesta && /(?:email|e-mail).*(?:indirizzo|adresse)|(?:indirizzo|adresse).*(?:email|e-mail)/i.test(tutto)) {
        emailChiesta = true;
        attendeRispostaEmail = true;
      }
      const precedente = ultimoReceptionist;
      ultimoReceptionist = tutto.trim();
      logFrase('🤖', tutto.trim());
      testo('receptionist', tutto.trim());
      for (const a of azioni) {
        if (typeof chiamata.logSensibile === 'function') chiamata.logSensibile('🔧 azione', { tipo: a.tipo, campi: a.argomenti.length });
        else chiamata.log(`🔧 ${a.tipo}`, a.argomenti);
        if (a.tipo === 'CONFERMA') {
          const nome = campoAzione(a.argomenti[0], 120);
          const giorno = campoAzione(a.argomenti[1], 10);
          const ora = campoAzione(a.argomenti[2], 5);
          const dettagli = campoAzione(a.argomenti[3], 1000);
          const emailOriginale = a.argomenti[4];
          const email = emailAzione(emailOriginale);
          if (confermato) {
            chiamata.log('⚠️ CONFERMA ignorata: l’appuntamento di questa chiamata è già stato registrato');
          } else if (statoIntento.intento !== 'appuntamento') {
            confermaInAttesa = null;
            chiamata.log(`⚠️ CONFERMA ignorata: intento ${statoIntento.intento}, non appuntamento`);
          } else if (!nome || !giorno || !ora || !dettagli || !/^\d{4}-\d{2}-\d{2}$/.test(giorno) || !/^\d{1,2}:\d{2}$/.test(ora) || (emailOriginale && !email)) {
            chiamata.log('⚠️ CONFERMA ignorata: campi mancanti o non validi');
          } else if (!consensoPrenotazione(ultimoCliente, precedente, nome)) {
            confermaInAttesa = { nome, giorno, ora, dettagli, email: email || emailRaccolta };
            chiamata.log('⏸️ CONFERMA in attesa del sì al riepilogo');
          } else {
            await salvaConferma({ nome, giorno, ora, dettagli, email: email || emailRaccolta }, 'con il sì al riepilogo');
          }
        }
        if (a.tipo === 'RICHIAMA') {
          const nome = campoAzione(a.argomenti[0], 120);
          // ultimo campo facoltativo: il numero dettato dal cliente (serve quando non arriva dal centralino)
          const ultimo = a.argomenti[a.argomenti.length - 1];
          const dettato = a.argomenti.length > 2 ? numeroDettato(ultimo) : '';
          const motivo = campoAzione((dettato ? a.argomenti.slice(1, -1) : a.argomenti.slice(1)).join(' '), 1000);
          const dati = { nome: nome || 'non detto', motivo, telefono: dettato };
          if (!['assistenza_problema', 'richiamata'].includes(statoIntento.intento)) {
            richiamoInAttesa = null;
            chiamata.log(`⚠️ RICHIAMA ignorato: intento ${statoIntento.intento}`);
          } else if (!dati.motivo) {
            chiamata.log('⚠️ RICHIAMA ignorato: manca il motivo');
          } else if (richiamoId) {
            chiamata.log('⚠️ RICHIAMA ignorato: il richiamo di questa chiamata è già stato registrato');
          } else if (consensoRichiamo(ultimoCliente, precedente)) {
            await salvaRichiamo(dati, 'con richiesta o consenso esplicito');
          } else {
            richiamoInAttesa = dati;
            chiamata.log('⏸️ RICHIAMA in attesa della richiesta o del consenso esplicito');
          }
        }
        if (a.tipo === 'FINE' && !chiudere) {
          // Il modello a volte scrive <<FINE>> troppo presto: si riaggancia solo se il cliente ha salutato.
          const saluta = congedoCliente(ultimoCliente, turno);
          if (!saluta) {
            chiamata.log('⚠️ FINE ignorato: il cliente non ha ancora salutato');
          } else {
            chiudere = true;
            await coda;
            await chiamata.finitoDiParlare();
            await new Promise((r) => setTimeout(r, 600));
            chiamata.riaggancia();
          }
        }
      }
    };
  }

  async function attendiCervello() {
    const pronto = await cervelloPronto;
    if (!cervello) {
      cervello = pronto;
      collegaCervello();
    }
    return cervello;
  }

  async function salvaConferma(dati, motivo) {
    if (confermato) return true;
    let liberi;
    try { liberi = await leggiPostiLiberi(); } catch (e) {
      chiamata.log('⚠️ CONFERMA ignorata: impossibile verificare lo slot', e.message);
      return false;
    }
    const ora = String(dati.ora || '').padStart(5, '0');
    if (!liberi.some((p) => p.giorno === dati.giorno && p.ora === ora)) {
      confermaInAttesa = null;
      chiamata.log(`⚠️ CONFERMA ignorata: slot non più disponibile ${dati.giorno} ${ora}`);
      return false;
    }
    confermato = true;
    const esito = await conferma({ ...dati, ora }, chiamata);
    if (!esito.ok) {
      confermato = false;
      return false;
    }
    confermaInAttesa = null;
    chiamata.log(`✅ appuntamento registrato ${motivo}`);
    return true;
  }

  async function salvaRichiamo(dati, motivo) {
    if (richiamoId) return true;
    const esito = await registra(dati, chiamata);
    if (!esito.ok) return false;
    richiamoId = esito.richiamo.id;
    richiamoInAttesa = null;
    chiamata.log(`✅ richiamo registrato ${motivo}`);
    return true;
  }

  async function registraConfermaInAttesa(detto) {
    if (!confermaInAttesa || confermato || statoIntento.intento !== 'appuntamento') return false;
    if (!consensoPrenotazione(detto, ultimoReceptionist, confermaInAttesa.nome)) {
      if (/\b(no|non|ma|però|invece|anzi|cambi\w*|spost\w*|nein|nicht|aber|sondern)\b/i.test(detto)) confermaInAttesa = null;
      return false;
    }
    const dati = confermaInAttesa;
    const salvato = await salvaConferma(dati, 'dopo il sì al riepilogo');
    return salvato;
  }

  async function registraRichiamoInAttesa(detto) {
    if (!richiamoInAttesa || richiamoId) return false;
    if (!consensoRichiamo(detto, ultimoReceptionist)) {
      if (/\b(no|non|lasci|niente|nein|nicht)\b/i.test(detto)) richiamoInAttesa = null;
      return false;
    }
    const dati = richiamoInAttesa;
    const salvato = await salvaRichiamo(dati, 'dopo il consenso esplicito');
    if (!salvato) richiamoInAttesa = dati;
    return salvato;
  }

  chiamata.alPartire = async () => {
    const pronto = inAttesa.get(chiamata.callSid) || prepara(chiamata.chiamante);
    inAttesa.delete(chiamata.callSid);
    cervelloPronto = pronto;
    // il saluto parte subito, Claude intanto si avvia
    const s = salutoIntero();
    testo('receptionist', s);
    logFrase('🤖', s);
    const t = Date.now();
    let primo = true;
    const annuncia = (quando, testoLog) => { if (primo) chiamata.log(`⏱ ${testoLog} in ${quando} ms`); primo = false; };
    if (!chiamata.web) {
      // prima si aspetta che la linea sia davvero aperta, poi si parte col silenzio
      const arrivato = chiamata.aspettaIngresso ? await chiamata.aspettaIngresso() : true;
      chiamata.log(`🔌 linea pronta: ${arrivato ? 'audio del chiamante arrivato' : 'nessun audio dal chiamante'} (${Date.now() - t} ms)`);
      inviaAudio(silenzioAvvio());
    }
    if (!salutoPronto) {
      // prove con la voce finta: si aspetta l'audio iniettato, come prima
      const audio = Buffer.concat(await Promise.all(segmentiSaluto().map((x) => fraseInCache(x.testo, x.lingua))));
      chiamata.log(`⏱ saluto pronto in ${Date.now() - t} ms`);
      inviaAudio(audio);
    } else {
      for (const x of segmentiSaluto()) {
        if (chiamata.chiusa) break;
        const pronto = salutoPronto(x.testo, x.lingua);
        if (pronto) {
          annuncia(Date.now() - t, 'saluto pronto');
          inviaAudio(pronto);
          continue;
        }
        // saluto mai sintetizzato (primo avvio o testo appena cambiato): si trasmette mentre arriva
        await salutoInDiretta(x.testo, x.lingua, (p) => {
          annuncia(Date.now() - t, 'saluto in diretta');
          inviaAudio(p);
        });
        fraseInCache(x.testo, x.lingua).catch(() => {}); // versione verificata, pronta per la prossima chiamata
      }
    }
    await attendiCervello();
    if (chiamata.chiusa) cervello.chiudi();
  };

  // Frase scritta (chat dal browser): come se l'avesse detta.
  chiamata.alTestoScritto = async (t) => {
    if (!cervelloPronto || !t.trim()) return;
    await attendiCervello();
    logFrase('⌨️', t);
    testo('cliente', t.trim());
    ultimoCliente = t.trim();
    fineTurno = Date.now();
    const registrato = await registraConfermaInAttesa(t.trim());
    const richiamoRegistrato = await registraRichiamoInAttesa(t.trim());
    nuovoTurno(t.trim(), registrato, false, richiamoRegistrato);
  };

  chiamata.alAudio = (payload) => {
    const pcm = daMulaw(Buffer.from(payload, 'base64'));
    let somma = 0;
    for (let i = 0; i < pcm.length; i += 2) { const s = pcm.readInt16LE(i); somma += s * s; }
    const rms = Math.sqrt(somma / (pcm.length / 2));
    // Mentre il receptionist parla serve una voce più forte e più lunga per interromperlo:
    // l'eco dell'altoparlante (browser senza cuffie) o un colpo di tosse non devono zittirlo.
    const sopra = chiamata.sta_parlando;
    const forte = rms > v.soglia * (sopra ? 1.6 : 1);
    if (!parlando) {
      preRoll.push(pcm);
      if (preRoll.length > 15) preRoll.shift();
      voce = forte ? voce + 1 : 0;
      if (voce * FRAME_MS >= (sopra ? v.interruzioneMs : v.inizioMs)) {
        parlando = true;
        muto = 0;
        frase = [...preRoll];
        preRoll = [];
        // Se Maria parlava o stava ancora preparando la risposta, la si zittisce subito.
        if (chiamata.sta_parlando || tastiera.inCorso) interrompi('il cliente parla sopra');
      }
      return;
    }
    frase.push(pcm);
    muto = forte ? 0 : muto + 1;
    if (muto * FRAME_MS >= v.silenzioMs || frase.length * FRAME_MS > 30000) {
      parlando = false;
      voce = 0;
      const audio = Buffer.concat(frase);
      frase = [];
      if (audio.length / 16 >= v.minimoMs + v.silenzioMs) {
        allaFrase(audio).catch((e) => chiamata.log('errore elaborazione frase', e.message));
      }
    }
  };

  chiamata.allaFine = async () => {
    interrompi('fine chiamata');
    cervello?.chiudi();
    if (ritardi.length) chiamata.log('⏱ ritardi (fine frase → primo audio):', ritardi.join(', '), 'ms');
  };
}
