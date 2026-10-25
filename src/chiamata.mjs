// La telefonata: ascolta il cliente (VAD a energia + faster-whisper), passa le frasi a
// Claude Code e legge la risposta con Qwen3-TTS, una frase alla volta mentre Claude scrive.
// Funziona uguale per Twilio e per la chiamata dal browser (stesso protocollo Media Streams).
import { CONFIG } from './config.mjs';
import { istruzioni, salutoSegmenti, salutoCompleto } from './persona.mjs';
import { postiPerIstruzioni } from './agenda.mjs';
import { confermaAppuntamento, registraRichiamo } from './strumenti.mjs';
import { aggiornaRichiamo } from './agenda.mjs';
import { Cervello } from './cervello.mjs';
import { consensoPrenotazione, congedoCliente } from './consenso.mjs';
import { numeriInParole, punteggiaturaDaVoce } from './parlato.mjs';
import { creaRegolatoreIntercalari } from './intercalari.mjs';
import { impostazioni } from './impostazioni.mjs';
import { daMulaw, trascrivi, pronuncia, frasePronta } from './voce.mjs';

const FRAME_MS = 20;
export const RIEMPITIVO = 'Sì, un attimo.';

// Claude scritto con i marcatori: quali azioni ci sono e cosa resta da dire.
function separa(testo) {
  const azioni = [...testo.matchAll(/<<\s*(CONFERMA|RICHIAMA|FINE)\s*(?:\|([^>]*))?>>/g)].map(([, tipo, a]) => ({ tipo, argomenti: (a || '').split('|').map((x) => x.trim()) }));
  const parlato = punteggiaturaDaVoce(numeriInParole(testo.replace(/<<[^>]*(?:>>|$)/g, '').replace(/\[[^\]]*\]/g, '').replace(/[*_#`]/g, '')));
  return { azioni, parlato };
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

export function gestisciChiamata(chiamata) {
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
  let riempitivo = null;
  let chiudere = false;
  let richiamoId = null; // il primo RICHIAMA della chiamata: gli altri lo aggiornano invece di duplicarlo
  let confermato = false; // un solo appuntamento per chiamata: i CONFERMA ripetuti si ignorano
  const deveChiedereEmail = Boolean(impostazioni().email?.chiediEmail);
  let emailChiesta = false;
  let attendeRispostaEmail = false;
  let ultimoCliente = ''; // l'ultima frase del cliente, per capire se ha davvero salutato
  let ultimoReceptionist = '';
  const regolaIntercalare = creaRegolatoreIntercalari(impostazioni().receptionist?.intercalare);
  const ritardi = [];

  const testo = (chi, t) => chiamata.testo?.(chi, t);

  function interrompi(motivo) {
    annulla.abort();
    annulla = new AbortController();
    coda = Promise.resolve();
    bufferTesto = '';
    testoTurno = '';
    giaDetto = false;
    clearTimeout(riempitivo);
    if (chiamata.sta_parlando) { chiamata.svuota(); chiamata.log(`✂ ${motivo}`); }
  }

  function inviaAudio(mulaw) {
    if (primoAudio && fineTurno) {
      const ms = Date.now() - fineTurno;
      ritardi.push(ms);
      chiamata.log(`⏱ primo audio ${ms} ms dopo la fine della frase`);
      fineTurno = 0;
    }
    primoAudio = false;
    clearTimeout(riempitivo);
    chiamata.inviaAudio(mulaw.toString('base64'));
    chiamata.marca();
  }

  let linguaVoce = 'it';
  function leggi(frase) {
    const segnale = annulla.signal;
    linguaVoce = rilevaLingua(frase, linguaVoce);
    const lingua = linguaVoce;
    coda = coda.then(async () => {
      if (segnale.aborted) return;
      try { await pronuncia(frase, (p) => { if (!segnale.aborted) inviaAudio(p); }, { segnale, lingua }); } catch (e) { if (!segnale.aborted) chiamata.log('errore voce', e.message); }
    });
  }

  async function allaFrase(pcm) {
    fineTurno = Date.now();
    let t;
    try { t = await trascrivi(pcm); } catch (e) { return chiamata.log('errore ascolto', e.message); }
    const detto = t.testo.trim();
    if (!detto || /^[\s.,!?…-]*$/.test(detto) || /sottotitoli|amara\.org|grazie per la visione/i.test(detto) || nonItaliano(detto)) {
      fineTurno = 0; // rumore o "allucinazione" tipica di Whisper sul silenzio
      return;
    }
    chiamata.log(`👤 ${detto} (ascolto ${t.ms} ms${t.voce_occupata ? ", voce occupata" : ""})`);
    testo('cliente', detto);
    ultimoCliente = detto;
    await attendiCervello();
    nuovoTurno(detto);
  }

  function nuovoTurno(detto) {
    interrompi('nuova frase del cliente');
    primoAudio = true;
    if (!fineTurno) fineTurno = Date.now();
    const perCervello = attendeRispostaEmail
      ? `Risposta del cliente alla domanda "Le mando la conferma per email, quale indirizzo?": ${detto}`
      : detto;
    attendeRispostaEmail = false;
    turno = cervello.ascolta(perCervello);
    if (CONFIG.riempitivoSecondi >= 0) {
      riempitivo = setTimeout(async () => {
        const audio = await frasePronta(RIEMPITIVO).catch(() => null);
        if (audio && primoAudio) { chiamata.log('🫧 riempitivo'); inviaAudio(audio); primoAudio = true; }
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
      // Una sola sintesi per tutta la battuta: Qwen conserva l'arco naturale tra virgole,
      // punti e domanda. Spezzare ogni frase faceva ripartire il tono da zero e suonava robotico.
      const separata = separa(completo);
      const primaConferma = separata.azioni.find((a) => a.tipo === 'CONFERMA');
      // Il modello può tentare di chiudere la prenotazione appena riceve il motivo. Se nel pannello
      // è attiva la raccolta email, la domanda viene imposta qui: non dipende dalla memoria del modello.
      if (deveChiedereEmail && !emailChiesta && primaConferma && !primaConferma.argomenti[4]) {
        bufferTesto = '';
        emailChiesta = true;
        attendeRispostaEmail = true;
        const domanda = linguaVoce === 'de'
          ? 'Ich schicke Ihnen die Bestätigung per E-Mail. Wie lautet Ihre E-Mail-Adresse?'
          : 'Le mando la conferma per email, quale indirizzo?';
        emetti(domanda, n);
        ultimoReceptionist = testoTurno.trim();
        chiamata.log(`🤖 ${ultimoReceptionist}`);
        testo('receptionist', ultimoReceptionist);
        chiamata.log('⚠️ CONFERMA rimandata: prima va chiesta l’email');
        return;
      }
      const { parlato, azioni } = separata;
      bufferTesto = '';
      emetti(parlato, n);
      const tutto = testoTurno.trim();
      if (deveChiedereEmail && !emailChiesta && /(?:email|e-mail).*(?:indirizzo|adresse)|(?:indirizzo|adresse).*(?:email|e-mail)/i.test(tutto)) {
        emailChiesta = true;
        attendeRispostaEmail = true;
      }
      const precedente = ultimoReceptionist;
      ultimoReceptionist = tutto.trim();
      chiamata.log(`🤖 ${tutto.trim()}`);
      testo('receptionist', tutto.trim());
      for (const a of azioni) {
        chiamata.log(`🔧 ${a.tipo}`, a.argomenti);
        if (a.tipo === 'CONFERMA') {
          const [nome, giorno, ora, dettagli, email] = a.argomenti;
          if (confermato) {
            chiamata.log('⚠️ CONFERMA ignorata: l’appuntamento di questa chiamata è già stato registrato');
          } else if (!consensoPrenotazione(ultimoCliente, precedente, nome)) {
            chiamata.log('⚠️ CONFERMA ignorata: manca il consenso al riepilogo precedente');
          } else if (!nome || !giorno || !ora || !dettagli || !/^\d{4}-\d{2}-\d{2}$/.test(giorno) || !/^\d{1,2}:\d{2}$/.test(ora)) {
            chiamata.log('⚠️ CONFERMA ignorata: mancano nome, giorno, ora o dettagli');
          } else {
            confermato = true;
            const esito = await confermaAppuntamento({ nome, giorno, ora, dettagli, email }, chiamata);
            if (!esito.ok) confermato = false;
          }
        }
        if (a.tipo === 'RICHIAMA') {
          const [nome, ...motivo] = a.argomenti;
          if (richiamoId) {
            const r = await aggiornaRichiamo(richiamoId, { nome, motivo: motivo.join(' ') });
            if (r) chiamata.log('📞 richiamo aggiornato', r);
          } else {
            const esito = await registraRichiamo({ nome, motivo: motivo.join(' ') }, chiamata);
            if (esito.ok) richiamoId = esito.richiamo.id;
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

  chiamata.alPartire = async () => {
    const pronto = inAttesa.get(chiamata.callSid) || preparaCervello(chiamata.chiamante);
    inAttesa.delete(chiamata.callSid);
    cervelloPronto = pronto;
    // il saluto parte subito, Claude intanto si avvia
    const s = salutoCompleto();
    testo('receptionist', s);
    chiamata.log(`🤖 ${s}`);
    const t = Date.now();
    const audio = Buffer.concat(await Promise.all(salutoSegmenti().map((x) => frasePronta(x.testo, x.lingua))));
    chiamata.log(`⏱ saluto pronto in ${Date.now() - t} ms`);
    inviaAudio(audio);
    await attendiCervello();
    if (chiamata.chiusa) cervello.chiudi();
  };

  // Frase scritta (chat dal browser): come se l'avesse detta.
  chiamata.alTestoScritto = async (t) => {
    if (!cervelloPronto || !t.trim()) return;
    await attendiCervello();
    chiamata.log(`⌨️ ${t}`);
    testo('cliente', t.trim());
    ultimoCliente = t.trim();
    fineTurno = Date.now();
    nuovoTurno(t.trim());
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
        // il cliente parla sopra al receptionist: si zittisce subito
        if (chiamata.sta_parlando) interrompi('il cliente parla sopra');
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

  chiamata.allaFine = () => {
    interrompi('fine chiamata');
    cervello?.chiudi();
    if (ritardi.length) chiamata.log('⏱ ritardi (fine frase → primo audio):', ritardi.join(', '), 'ms');
  };
}
