// La telefonata: ascolta il cliente (VAD a energia + faster-whisper), passa le frasi a
// Claude Code e legge la risposta con Qwen3-TTS, una frase alla volta mentre Claude scrive.
// Funziona uguale per Twilio e per la chiamata dal browser (stesso protocollo Media Streams).
import { CONFIG } from './config.mjs';
import { istruzioni, salutoSegmenti, salutoCompleto, numeroNoto } from './persona.mjs';
import { postiLiberi, postiPerIstruzioni, giornoParlato, inRoma } from './agenda.mjs';
import { confermaAppuntamento, registraRichiamo, attaccaTelefonoRichiamo } from './strumenti.mjs';
import { Cervello } from './cervello.mjs';
import { consensoPrenotazione, consensoRichiamo, congedoCliente } from './consenso.mjs';
import { numeriInParole, punteggiaturaDaVoce } from './parlato.mjs';
import { creaRegolatoreIntercalari } from './intercalari.mjs';
import { impostazioni, lingueAttive, linguaPredefinita } from './impostazioni.mjs';
import { estraiIntento, regoleCandidate } from './intenti.mjs';
import { daMulaw, trascrivi, pronuncia, frasePronta, fraseSubito, fraseInDiretta, creaCatenaVoce } from './voce.mjs';
import { creaCodaUfficio, creaRumoreAttesa, creaSuonoContinuo, fermaAttesaPrimaDellaVoce, mescolaSuono } from './attesa.mjs';

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
export const RIEMPITIVI = { it: RIEMPITIVO, de: 'Ja, einen Moment.', en: 'One moment, please.', es: 'Sí, un momento.', fr: 'Oui, un instant.' };

// Le frasi fisse che il sistema dice da solo (riepilogo, richiamo, ripetere) nella lingua
// della telefonata: il modello tace o sbaglia, queste restano sempre corrette.
const FRASI = {
  de: {
    riepilogo: (nome, parti, motivo) => `Also: ${[nome, parti, motivo].filter(Boolean).join(', ')}. Passt das so für Sie?`,
    richiamoSenzaNumero: 'Gerne, ich lasse Sie zurückrufen. Unter welcher Nummer?',
    richiamo: 'Gerne, ich lasse Sie von einem Kollegen zurückrufen.',
    richiamoFatto: 'Gerne, ein Kollege ruft Sie zurück. Kann ich sonst noch helfen?',
    ripeti: 'Entschuldigung, können Sie das wiederholen?',
    email: 'Ich schicke Ihnen die Bestätigung per E-Mail. Wie lautet Ihre E-Mail-Adresse?',
  },
  en: {
    riepilogo: (nome, parti, motivo) => `So: ${[nome, parti, motivo].filter(Boolean).join(', ')}. Does that work for you?`,
    richiamoSenzaNumero: 'Of course, I can have a colleague call you back. What number should we use?',
    richiamo: 'Of course, I will have a colleague call you back.',
    richiamoFatto: 'Perfect, I have noted the callback. Is there anything else?',
    ripeti: 'Sorry, could you repeat that?',
    email: 'I will send you the confirmation by email. What is your email address?',
  },
  es: {
    riepilogo: (nome, parti, motivo) => `Entonces: ${[nome, parti, motivo].filter(Boolean).join(', ')}. ¿Le viene bien?`,
    richiamoSenzaNumero: 'Claro, puedo pedir a un compañero que le llame. ¿A qué número le llamamos?',
    richiamo: 'Claro, pediré a un compañero que le llame.',
    richiamoFatto: 'Perfecto, he anotado el aviso. ¿Necesita algo más?',
    ripeti: 'Perdone, ¿puede repetirlo?',
    email: 'Le envío la confirmación por correo electrónico. ¿Cuál es su dirección de correo?',
  },
  fr: {
    riepilogo: (nome, parti, motivo) => `Donc : ${[nome, parti, motivo].filter(Boolean).join(', ')}. Ça vous convient ?`,
    richiamoSenzaNumero: 'Bien sûr, je peux demander à un collègue de vous rappeler. À quel numéro ?',
    richiamo: 'Bien sûr, je demande à un collègue de vous rappeler.',
    richiamoFatto: 'Parfait, j’ai noté le rappel. Autre chose ?',
    ripeti: 'Pardon, pouvez-vous répéter ?',
    email: 'Je vous envoie la confirmation par e-mail. Quelle est votre adresse e-mail ?',
  },
};

// Claude scritto con i marcatori: quali azioni ci sono e cosa resta da dire.
// I numeri si sciolgono in parole solo in italiano: negli altri TTS li leggono bene così.
function separa(testo, lingua = 'it') {
  const azioni = [...testo.matchAll(/<<\s*(CONFERMA|RICHIAMA|FINE)\s*(?:\|([^>]*))?>>/g)].map(([, tipo, a]) => ({ tipo, argomenti: (a || '').split('|').map((x) => x.trim()) }));
  const senzaMarcatori = testo.replace(/<<[^>]*(?:>>|$)/g, '').replace(/\[[^\]]*\]/g, '').replace(/[*_#`]/g, '');
  const parlato = punteggiaturaDaVoce(lingua === 'it' ? numeriInParole(senzaMarcatori) : senzaMarcatori);
  return { azioni, parlato };
}

// Numero dettato a voce: restano le cifre (con eventuale +), spazi e trattini via.
export function numeroDettato(valore) {
  const cifre = String(valore || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return cifre.replace(/\D/g, '').length >= 6 && cifre.length <= 20 ? cifre : '';
}

// Il numero detto a parole: "tre tre tre uno due tre" → "333123". Lo vocale lo si
// prende dal discorso del cliente, anche quando il marcatore RICHIAMA arriva senza cifre.
const PAROLE_CIFRE = { zero: '0', uno: '1', un: '1', due: '2', tre: '3', quattro: '4', cinque: '5', sei: '6', sette: '7', otto: '8', nove: '9', piu: '+', più: '+' };
export function numeroDaVoce(testo) {
  const pulito = String(testo || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\bdoppio\s+(\S+)\b/g, '$1 $1');
  const simboli = pulito.split(/[^a-z0-9+]+/).map((t) => PAROLE_CIFRE[t] ?? (t.replace(/[^\d+]/g, '') || ''));
  return numeroDettato(simboli.join(''));
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
// Inglese, spagnolo e francese: solo parole e lettere che non si confondono con l'italiano.
const INGLESE_PAROLE = /\b(?:the|this|that|these|those|there|here|you|your|yours|we|our|i|my|me|is|are|am|was|were|be|been|have|has|had|do|does|did|can|could|would|should|will|shall|may|might|must|please|thanks|thank|hello|hi|good|morning|afternoon|evening|appointment|book|booking|schedule|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|need|want|like|help|with|for|from|about|when|what|where|which|who|how|not|yes|sorry|sure|okay|speak|speaking|name|number|price|email|send|file|material|quantity|laser|cut|engrave|bye|goodbye|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|o'clock)\b/gi;
const SPAGNOLO_PAROLE = /[ñ¿¡]|\b(?:el|los|las|una|unos|unas|del|al|es|son|está|están|estoy|tengo|quiero|necesito|puedo|puede|podría|para|por|con|sin|muy|también|pero|porque|cuando|dónde|cómo|qué|quién|hola|buenos|buenas|días|tardes|gracias|favor|hablar|habla|llamo|nombre|número|cita|reserva|mañana|hoy|hora|precio|correo|enviar|archivo|material|cantidad|láser|cortar|grabar|adiós|hasta|luego|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|media|cuarto)\b/gi;
const FRANCESE_PAROLE = /[çœ]|\b(?:le|les|des|une|du|au|aux|est|sont|je|tu|il|elle|nous|vous|ils|elles|mon|ma|mes|votre|vos|notre|nos|pour|par|avec|sans|très|aussi|mais|quand|où|comment|quoi|qui|bonjour|bonsoir|salut|merci|plaît|parler|parlez|appelle|nom|numéro|rendez-vous|demain|aujourd'hui|heure|heures|prix|courriel|envoyer|fichier|matériau|quantité|couper|graver|voudrais|aimerais|revoyure|bonne|deux|trois|quatre|cinq|sept|huit|neuf|dix|onze|douze|demie)\b/gi;
const MARCATORI = { it: SOLO_ITALIANO, de: TEDESCO, en: INGLESE_PAROLE, es: SPAGNOLO_PAROLE, fr: FRANCESE_PAROLE };

export function rilevaLingua(testo, precedente = 'it', attive = null) {
  const lingue = attive instanceof Set ? attive : lingueAttive();
  const frase = String(testo || '');
  const punteggi = {};
  let migliore = 'it', massimo = 0;
  for (const lingua of lingue) {
    const espressione = MARCATORI[lingua];
    if (!espressione) continue;
    const n = (frase.match(espressione) || []).length;
    punteggi[lingua] = n;
    if (n > massimo) { massimo = n; migliore = lingua; }
  }
  if (massimo === 0) return lingue.has(precedente) ? precedente : 'it'; // frase cortissima: resta nella lingua di prima
  // a parità vince la lingua di prima: la frase non fa saltare la telefonata da una lingua all'altra
  if (punteggi[precedente] === massimo) return precedente;
  return migliore;
}
export function nonItaliano(frase) {
  if (ITALIANO.test(frase) || /[äöüß]|\b(ich|wir|sie|nicht|und|bitte|danke|guten|termin|gerne|ja|nein|haben)\b/i.test(frase)) return false;
  // Con una seconda lingua attiva le frasi in quella lingua sono clienti veri, non eco: passano.
  const attive = lingueAttive();
  if (attive.size > 1 && rilevaLingua(frase, 'it', attive) !== 'it') return false;
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
  const creaSottofondo = dipendenze.creaSuonoContinuo || creaSuonoContinuo;
  const creaCoda = dipendenze.creaCodaUfficio || creaCodaUfficio;
  const mescolaVoceSottofondo = dipendenze.mescolaSuono || mescolaSuono;
  const conferma = dipendenze.confermaAppuntamento || confermaAppuntamento;
  const registra = dipendenze.registraRichiamo || registraRichiamo;
  const aggiornaNumero = dipendenze.attaccaTelefonoRichiamo || attaccaTelefonoRichiamo;
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
  let sospesa = null; // frase finita ma ancora "aperta" un attimo: { audio, promessa, timer }
  let grazia = []; // frame arrivati durante la grazia (possono essere l'inizio della ripresa)
  let voceGrazia = 0;
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
  let telefonoRichiamo = ''; // il numero già attaccato al richiamo registrato: non si riscrive due volte
  let confermato = false; // un solo appuntamento per chiamata: i CONFERMA ripetuti si ignorano
  const deveChiedereEmail = Boolean(impostazioni().email?.chiediEmail);
  let emailChiesta = false;
  let attendeRispostaEmail = false;
  let emailRaccolta = '';
  let confermaInAttesa = null;
  let richiamoInAttesa = null;
  let ultimoCliente = ''; // l'ultima frase del cliente, per capire se ha davvero salutato
  let ultimoReceptionist = '';
  let dettoInTurno = false; // questa battuta ha prodotto qualcosa da dire al cliente
  let richiamoAppenaSalvato = false; // il RICHIAMA di questa battuta è stato registrato adesso
  let ultimoNumeroDettato = ''; // numero detto dopo "a che numero la possiamo richiamare?"
  // Quello che il sistema ha già capito in questa telefonata: si ripete al cervello a ogni
  // battuta, così non lo dimentica e non lo richiede (nome, motivo, giorno, email, recapito).
  const fatti = { nome: '', motivo: '', giorno: '', ora: '', email: '', telefono: '' };
  const dettoDalCliente = []; // le ultime frasi del cliente: servono a capire il giorno che ha detto
  let consensoRichiamoDato = false; // il cliente ha chiesto o accettato il richiamo in questa telefonata
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
  const ambientale = creaSottofondo({
    attivo: () => Boolean(impostazioni().suoni?.attiva ?? CONFIG.tastiera.attiva),
    volume: () => impostazioni().suoni?.volume ?? CONFIG.tastiera.volume,
    tipo: () => impostazioni().suoni?.tipo || 'tastiera',
  });

  // Rumori di stanza subito dopo la voce (pannello: "suoni dopo la voce"): il segno che
  // l'ufficio continua anche quando Maria tace. Audio raw senza mark: non conta come voce.
  let timerCoda = null;
  let ultimoAudioVoce = 0;
  const vuoleCoda = () => Boolean(impostazioni().suoni?.attiva ?? CONFIG.tastiera.attiva)
    && (impostazioni().suoni?.dopo ?? true);
  function fermaCoda() {
    if (timerCoda) clearTimeout(timerCoda);
    timerCoda = null;
  }
  function programmaCoda(ritardoMs = 420 + Math.round(Math.random() * 380)) {
    fermaCoda();
    if (chiudere || chiamata.chiusa || !vuoleCoda()) return;
    timerCoda = setTimeout(() => {
      timerCoda = null;
      if (chiudere || chiamata.chiusa || chiamata.sta_parlando) return;
      // la voce può essere ancora in coda: si aspetta che l'ultimo pezzo sia uscito davvero
      const passato = Date.now() - ultimoAudioVoce;
      if (passato < 380) return programmaCoda(380 - passato + Math.round(Math.random() * 200));
      try {
        const audio = creaCoda({
          volume: Number(impostazioni().suoni?.volume ?? CONFIG.tastiera.volume),
          tipo: impostazioni().suoni?.tipo || 'tastiera',
        });
        if (audio && audio.length) chiamata.inviaAudio(audio.toString('base64'));
      } catch (e) { chiamata.log('⚠️ rumore di stanza non inviato:', e.message); }
    }, ritardoMs);
    if (typeof timerCoda.unref === 'function') timerCoda.unref();
  }

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
    fermaCoda();
    scartaSospesa();
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
      chiamata.inviaAudio(silenzioTurno().toString('base64'));
    }
    clearTimeout(riempitivo);
    // la voce parte con lo stesso timing di sempre: il sottofondo si somma al volo, senza attese
    const sottofondo = ambientale.strappa(mulaw.length);
    chiamata.inviaAudio(mescolaVoceSottofondo(mulaw, sottofondo).toString('base64'));
    ultimoAudioVoce = Date.now();
    chiamata.marca();
  }

  let linguaVoce = linguaPredefinita();
  // una sola catena di timbro per tutta la telefonata: il livello non riparte da zero a ogni frase
  const catenaVoce = creaCatenaVoce();
  function leggi(frase) {
    const segnale = annulla.signal;
    linguaVoce = rilevaLingua(frase, linguaVoce);
    const lingua = linguaVoce;
    coda = coda.then(async () => {
      if (segnale.aborted) return;
      try { await pronunciaTesto(frase, (p) => { if (!segnale.aborted) inviaAudio(p); }, { segnale, lingua, catena: catenaVoce }); } catch (e) { if (!segnale.aborted) chiamata.log('errore voce', e.message); }
      if (!segnale.aborted) programmaCoda();
    });
  }

  // La frase è finita (silenzio): la trascrizione parte subito, in parallelo, ma il turno
  // resta aperto per la grazia. Se il cliente riprende a parlare (una pausa in mezzo alla
  // frase) le due parti si uniscono e si trascrive una volta sola.
  function sospendi(audio) {
    scartaSospesa();
    fineTurno = Date.now();
    const promessa = trascriviAudio(audio);
    promessa.catch(() => {}); // l'errore lo raccoglie allaFrase
    const s = { audio, promessa, timer: null };
    s.timer = setTimeout(() => {
      if (sospesa !== s) return;
      sospesa = null;
      const uniti = voceGrazia > 0 ? Buffer.concat([audio, ...grazia]) : audio;
      grazia = [];
      voceGrazia = 0;
      if (chiudere || chiamata.chiusa) return;
      allaFrase(uniti, promessa).catch((e) => chiamata.log('errore elaborazione frase', e.message));
    }, chiamata.web ? v.graziaWebMs : v.graziaMs);
    if (typeof s.timer.unref === 'function') s.timer.unref();
    sospesa = s;
  }

  function scartaSospesa() {
    if (sospesa) clearTimeout(sospesa.timer);
    sospesa = null;
    grazia = [];
    voceGrazia = 0;
  }

  async function allaFrase(pcm, promessa = null) {
    if (!fineTurno) fineTurno = Date.now();
    tastiera.avvia();
    let t;
    try { t = await (promessa || trascriviAudio(pcm)); } catch (e) {
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
    annotaNumeroDettato(detto);
    annotaConsensoRichiamo(detto);
    const registrato = await registraConfermaInAttesa(detto);
    const richiamoRegistrato = await registraRichiamoInAttesa(detto);
    await attaccaNumero(detto);
    await attendiCervello();
    nuovoTurno(detto, registrato, true, richiamoRegistrato);
  }

  function nuovoTurno(detto, registratoAdesso = false, conTastiera = false, richiamoRegistrato = false) {
    interrompi('nuova frase del cliente');
    dettoDalCliente.push(detto);
    if (dettoDalCliente.length > 12) dettoDalCliente.shift();
    primoAudio = true;
    silenzioDaInviare = true; // silenzio protettivo in testa alla risposta: telefono e browser, altrimenti la prima sillaba a volte si perde
    if (!fineTurno) fineTurno = Date.now();
    const rispondevaEmail = attendeRispostaEmail;
    const emailDetta = emailDaVoce(detto);
    if (emailDetta) {
      emailRaccolta = emailDetta;
      fatti.email = emailDetta;
      emailChiesta = true;
    }
    let perCervello = rispondevaEmail
      ? `Risposta del cliente alla domanda "Le mando la conferma per email, quale indirizzo?": ${detto}${emailDetta ? '' : '. Non ha dato un indirizzo: non chiederlo più, fai il riepilogo e prosegui senza email.'}`
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
    const stato = promemoria();
    if (stato) perCervello = `${stato}\n${perCervello}`;
    statoIntento.candidati = regoleCandidate(detto, gestioneRichieste);
    turno = cervello.ascolta(perCervello);
    if (conTastiera) tastiera.avvia();
    if (CONFIG.riempitivoSecondi >= 0) {
      riempitivo = setTimeout(async () => {
        const audio = await fraseInCache(RIEMPITIVI[linguaVoce] || RIEMPITIVO).catch(() => null);
        if (audio && primoAudio) { chiamata.log('🫧 riempitivo'); inviaAudio(audio, true); primoAudio = true; }
      }, CONFIG.riempitivoSecondi * 1000);
    }
  }

  // Il cliente detta il numero dopo che il receptionist l'ha chiesto: è la risposta alla domanda,
  // quindi vale come consenso al richiamo.
  function numeroChiestoEDetto(proposta) {
    if (!/\bnumero\b/i.test(String(proposta || ''))) return '';
    return numeroDaVoce(ultimoCliente);
  }

  // Lo stesso numero resta buono per tutta la telefonata: se il modello scrive il marcatore
  // RICHIAMA qualche battuta dopo, senza ripetere le cifre, il richiamo non resta senza recapito.
  function annotaNumeroDettato(detto) {
    if (!/\bnumero\b/i.test(ultimoReceptionist)) return;
    const numero = numeroDaVoce(detto);
    if (numero) { ultimoNumeroDettato = numero; fatti.telefono = numero; }
  }

  // Il sì al richiamo vale per tutta la telefonata: se il modello scrive il marcatore più tardi,
  // il consenso già dato non va perso (e il richiamo non resta appeso).
  function annotaConsensoRichiamo(detto) {
    if (consensoRichiamo(detto, ultimoReceptionist)) consensoRichiamoDato = true;
  }

  // Riga di stato messa davanti a ogni battuta: il modello non deve ricostruire a memoria
  // cose che il sistema ha già registrato (ed era proprio lì che "dimenticava" i dati).
  const NOMI_INTENTO = { appuntamento: 'appuntamento', preventivo_file: 'preventivo', assistenza_problema: 'assistenza', richiamata: 'richiesta di richiamo', informazioni: 'informazioni' };
  function promemoria() {
    const righe = [];
    if (fatti.nome) righe.push(`nome del cliente: ${fatti.nome}`);
    if (fatti.motivo) righe.push(`motivo: ${fatti.motivo}`);
    if (fatti.giorno || fatti.ora) righe.push(`giorno e ora scelti: ${[fatti.giorno, fatti.ora].filter(Boolean).join(' ')}`);
    if (fatti.email || emailRaccolta) righe.push(`email: ${emailRaccolta || fatti.email}`);
    if (fatti.telefono || telefonoRichiamo) righe.push(`telefono: ${telefonoRichiamo || fatti.telefono}`);
    if (confermato) righe.push('appuntamento GIÀ registrato');
    if (richiamoId) righe.push('richiamo GIÀ registrato');
    if (confermaInAttesa) righe.push('riepilogo in attesa del sì del cliente');
    if (richiamoInAttesa) righe.push('richiamo in attesa del consenso esplicito');
    // senza niente di acquisito non si aggiunge nulla: la riga serve a non perdere i dati,
    // non a ripetere a ogni battuta quello che il cervello sa già dalla conversazione.
    if (!righe.length) return '';
    const intento = NOMI_INTENTO[statoIntento.intento];
    if (intento) righe.push(`richiesta in corso: ${intento}`);
    return `Promemoria del sistema su questa telefonata (dati già acquisiti: non richiederli, non contraddirli; cambiali solo se il cliente li cambia): ${righe.join('; ')}.`;
  }

  // Il riepilogo prima del sì lo sa fare il sistema con i dati che ha già: nome, giorno, ora,
  // motivo. Il modello a volte lo salta e chiude subito: la telefonata va avanti lo stesso.
  function riepilogoConferma() {
    const { nome, giorno, ora, dettagli } = confermaInAttesa || {};
    const quando = giorno ? giornoParlato(giorno) : '';
    const parti = [quando, ora ? `alle ${ora}` : ''].filter(Boolean).join(' ');
    const motivo = String(dettagli || '').replace(/\s+/g, ' ').slice(0, 110).trim();
    const f = FRASI[linguaVoce];
    if (f) return f.riepilogo(nome, parti, motivo);
    return numeriInParole(`Allora: ${nome ? `${nome}, ` : ''}${parti}${motivo ? `, per ${motivo}` : ''}. Le torna tutto?`);
  }

  // Aggiunge una frase a quella già detta in questa battuta (senza buttare via la precedente).
  function aggiungiAllaBattuta(parlato) {    const pulito = String(parlato || '').trim();
    if (!pulito) return;
    testoTurno = `${testoTurno} ${pulito}`.trim();
    ultimoReceptionist = testoTurno;
    dettoInTurno = true;
    logFrase('🤖', pulito);
    testo('receptionist', pulito);
    leggi(pulito);
  }

  // Il giorno detto a voce ("martedì", "domani"): il modello sceglie la data da solo e a volte
  // sbaglia di qualche giorno. Se il cliente ha nominato un giorno, vince quello.
  const GIORNI_VOCE = { lunedi: 0, martedi: 1, mercoledi: 2, giovedi: 3, venerdi: 4, sabato: 5, domenica: 6 };
  function giornoDellaVoce() {
    for (let i = dettoDalCliente.length - 1; i >= 0; i--) {
      const t = dettoDalCliente[i].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const m = t.match(/\b(domenica|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|dopodomani|domani|oggi)\b/);
      if (m) return m[1];
    }
    return '';
  }

  function dataDaGiornoParola(parola) {
    const oggi = inRoma();
    const base = Date.parse(`${oggi.iso}T12:00:00Z`);
    const iso = (n) => new Date(base + n * 86400000).toISOString().slice(0, 10);
    if (parola === 'oggi') return oggi.minuti < 12 * 60 ? oggi.iso : '';
    if (parola === 'domani') return iso(1);
    if (parola === 'dopodomani') return iso(2);
    const voluto = GIORNI_VOCE[parola];
    if (voluto === undefined) return '';
    for (let n = 0; n <= 7; n++) {
      // inRoma(): 0 = lunedì … 6 = domenica; Date.getUTCDay(): 0 = domenica
      if (new Date(base + n * 86400000).getUTCDay() !== (voluto + 1) % 7) continue;
      if (n === 0 && oggi.minuti >= 12 * 60) continue; // oggi è ormai passato: si intende la settimana dopo
      return iso(n);
    }
    return '';
  }

  // Se il cliente ha detto "martedì" e il modello ha scritto un altro giorno, si corregge —
  // ma solo se in quel giorno c'è davvero lo stesso orario libero (niente invenzioni).
  function giornoCorretto(giornoModello, ora, liberi) {
    const parola = giornoDellaVoce();
    if (!parola) return giornoModello;
    const giusto = dataDaGiornoParola(parola);
    if (!giusto || giusto === giornoModello) return giornoModello;
    if (!liberi.some((p) => p.giorno === giusto && p.ora === ora)) return giornoModello;
    chiamata.log(`📅 giorno corretto: il cliente ha detto ${parola} (${giusto}), il modello aveva scritto ${giornoModello}`);
    return giusto;
  }

  // Se il modello scrive solo i marcatori non resta niente da dire e la linea cade nel silenzio:
  // chi chiama crede che la telefonata si sia bloccata. Meglio una frase di servizio.
  function fraseDiRipiego() {
    const f = FRASI[linguaVoce];
    if (richiamoInAttesa) {
      if (!richiamoInAttesa.telefono && !numeroNoto(chiamata.chiamante)) {
        return f ? f.richiamoSenzaNumero : 'Certo, la faccio richiamare da un collega. A che numero la possiamo richiamare?';
      }
      return f ? f.richiamo : 'Certo, la faccio richiamare da un collega.';
    }
    if (richiamoAppenaSalvato) return f ? f.richiamoFatto : 'Perfetto, ho segnato il richiamo. Le serve altro?';
    if (confermaInAttesa) return riepilogoConferma();
    return f ? f.ripeti : 'Mi scusi, può ripetere?';
  }

  function collegaCervello() {
    const emetti = (grezzo, n) => {
      const parlato = regolaIntercalare(grezzo, n).trim();
      if (!parlato) return;
      testoTurno = parlato;
      dettoInTurno = true;
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
      dettoInTurno = false;
      richiamoAppenaSalvato = false;
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
      const separata = separa(riconosciuto.testo, linguaVoce);
      const primaConferma = separata.azioni.find((a) => a.tipo === 'CONFERMA');
      if (primaConferma && emailRaccolta) primaConferma.argomenti[4] = emailRaccolta;
      // Il modello può tentare di chiudere la prenotazione appena riceve il motivo. Se nel pannello
      // è attiva la raccolta email, la domanda viene imposta qui: non dipende dalla memoria del modello.
      if (statoIntento.intento === 'appuntamento' && deveChiedereEmail && !emailChiesta && primaConferma && !primaConferma.argomenti[4]) {
        bufferTesto = '';
        emailChiesta = true;
        attendeRispostaEmail = true;
        const domanda = FRASI[linguaVoce]?.email || 'Le mando la conferma per email, quale indirizzo?';
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
          if (nome && giorno && ora) {
            fatti.nome = nome; fatti.giorno = giorno; fatti.ora = ora;
            if (dettagli) fatti.motivo = dettagli;
            if (email) fatti.email = email;
          }
          if (confermato) {
            chiamata.log('⚠️ CONFERMA ignorata: l’appuntamento di questa chiamata è già stato registrato');
          } else if (statoIntento.intento !== 'appuntamento') {
            confermaInAttesa = null;
            chiamata.log(`⚠️ CONFERMA ignorata: intento ${statoIntento.intento}, non appuntamento`);
          } else if (!nome || !giorno || !ora || !dettagli || !/^\d{4}-\d{2}-\d{2}$/.test(giorno) || !/^\d{1,2}:\d{2}$/.test(ora) || (emailOriginale && !email)) {
            chiamata.log('⚠️ CONFERMA ignorata: campi mancanti o non validi');
          } else if (!consensoPrenotazione(ultimoCliente, precedente, nome)) {
            // il giorno che il cliente ha detto a voce vince su quello scritto dal modello
            let giornoRiepilogo = giorno;
            try {
              giornoRiepilogo = giornoCorretto(giorno, ora, await leggiPostiLiberi());
            } catch { /* si riepiloga il giorno del modello */ }
            fatti.giorno = giornoRiepilogo;
            confermaInAttesa = { nome, giorno: giornoRiepilogo, ora, dettagli, email: email || emailRaccolta };
            chiamata.log('⏸️ CONFERMA in attesa del sì al riepilogo');
            // Il modello ha provato a chiudere senza riepilogare: il riepilogo lo dice il sistema,
            // con i dati che ha già. Altrimenti il cliente sente "è tutto pronto" senza aver mai
            // sentito giorno e ora, e il sì non arriva.
            const giaRiepilogato = /torna tutto|passt das/i.test(testoTurno)
              || (nome && /\?/.test(testoTurno) && testoTurno.toLowerCase().includes(nome.toLowerCase()));
            if (!giaRiepilogato) aggiungiAllaBattuta(riepilogoConferma());
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
          // "A che numero la possiamo richiamare?" → "333 123 4567": il numero dato è la risposta,
          // non serve un altro "sì". Senza questo il richiamo restava in attesa per sempre.
          const dettatoDalCliente = numeroChiestoEDetto(precedente);
          const telefono = dettato || dettatoDalCliente || ultimoNumeroDettato;
          const dati = { nome: nome || 'non detto', motivo, telefono };
          if (nome) fatti.nome = nome;
          if (motivo) fatti.motivo = motivo;
          if (telefono) fatti.telefono = telefono;
          const haRecapito = Boolean(telefono) || numeroNoto(chiamata.chiamante);
          if (!['assistenza_problema', 'richiamata'].includes(statoIntento.intento)) {
            richiamoInAttesa = null;
            chiamata.log(`⚠️ RICHIAMA ignorato: intento ${statoIntento.intento}`);
          } else if (!dati.motivo) {
            chiamata.log('⚠️ RICHIAMA ignorato: manca il motivo');
          } else if (richiamoId) {
            chiamata.log('⚠️ RICHIAMA ignorato: il richiamo di questa chiamata è già stato registrato');
          } else if (consensoRichiamo(ultimoCliente, precedente) || dettatoDalCliente || (consensoRichiamoDato && haRecapito)) {
            richiamoAppenaSalvato = await salvaRichiamo(dati, 'con richiesta o consenso esplicito');
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
            fermaCoda();
            await coda;
            await chiamata.finitoDiParlare();
            await new Promise((r) => setTimeout(r, 600));
            chiamata.riaggancia();
          }
        }
      }
      // Niente da dire ma azione sì (o risposta fatta di soli marcatori): la linea non deve
      // restare muta in attesa che il cliente parli di nuovo.
      if (!dettoInTurno && !chiudere && n === turno) {
        const ripiego = fraseDiRipiego();
        emetti(ripiego, n);
        const servizio = testoTurno.trim();
        ultimoReceptionist = servizio;
        logFrase('🤖', servizio);
        testo('receptionist', servizio);
        chiamata.log('🩹 il modello non ha scritto nulla da dire: frase di servizio');
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
    const giorno = giornoCorretto(dati.giorno, ora, liberi);
    if (!liberi.some((p) => p.giorno === giorno && p.ora === ora)) {
      confermaInAttesa = null;
      chiamata.log(`⚠️ CONFERMA ignorata: slot non più disponibile ${giorno} ${ora}`);
      return false;
    }
    confermato = true;
    const esito = await conferma({ ...dati, giorno, ora }, chiamata);
    if (!esito.ok) {
      confermato = false;
      return false;
    }
    confermaInAttesa = null;
    fatti.nome = dati.nome || fatti.nome;
    fatti.giorno = giorno;
    fatti.ora = ora;
    if (dati.dettagli) fatti.motivo = dati.dettagli;
    if (dati.email) fatti.email = dati.email;
    chiamata.log(`✅ appuntamento registrato ${motivo}`);
    return true;
  }

  async function salvaRichiamo(dati, motivo) {
    if (richiamoId) return true;
    const esito = await registra(dati, chiamata);
    if (!esito.ok) return false;
    richiamoId = esito.richiamo.id;
    telefonoRichiamo = dati.telefono || '';
    if (telefonoRichiamo) fatti.telefono = telefonoRichiamo;
    if (dati.nome && dati.nome !== 'non detto') fatti.nome = dati.nome;
    if (dati.motivo) fatti.motivo = dati.motivo;
    richiamoInAttesa = null;
    chiamata.log(`✅ richiamo registrato ${motivo}`);
    return true;
  }

  // Il numero può arrivare dopo che il richiamo è già stato registrato: lo si attacca al volo.
  async function attaccaNumero(detto) {
    if (!richiamoId || telefonoRichiamo) return false;
    const numero = numeroDaVoce(detto);
    if (!numero) return false;
    try {
      const esito = await aggiornaNumero(richiamoId, numero, chiamata);
      if (esito?.ok) {
        telefonoRichiamo = numero;
        fatti.telefono = numero;
        chiamata.log('📞 numero dettato attaccato al richiamo');
        return true;
      }
    } catch (e) {
      chiamata.log('⚠️ numero dettato non attaccato al richiamo:', e.message);
    }
    return false;
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
    // se nella frase d'accettazione il cliente detta il numero, lo prendo subito
    if (!richiamoInAttesa.telefono) {
      const dettoNumero = numeroDaVoce(detto);
      if (dettoNumero) richiamoInAttesa.telefono = dettoNumero;
    }
    // il numero detto dopo "a che numero la possiamo richiamare?" è la risposta alla domanda
    if (!consensoRichiamo(detto, ultimoReceptionist) && !numeroChiestoEDetto(ultimoReceptionist)) {
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
    if (!chiamata.chiusa) programmaCoda(700 + Math.round(Math.random() * 400));
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
    annotaNumeroDettato(t.trim());
    annotaConsensoRichiamo(t.trim());
    fineTurno = Date.now();
    const registrato = await registraConfermaInAttesa(t.trim());
    const richiamoRegistrato = await registraRichiamoInAttesa(t.trim());
    await attaccaNumero(t.trim());
    nuovoTurno(t.trim(), registrato, false, richiamoRegistrato);
  };

  chiamata.alAudio = (payload) => {
    if (chiudere || chiamata.chiusa) return;
    const pcm = daMulaw(Buffer.from(payload, 'base64'));
    let somma = 0;
    for (let i = 0; i < pcm.length; i += 2) { const s = pcm.readInt16LE(i); somma += s * s; }
    const rms = Math.sqrt(somma / (pcm.length / 2));
    // Mentre il receptionist parla serve una voce più forte e più lunga per interromperlo:
    // l'eco dell'altoparlante (browser senza cuffie) o un colpo di tosse non devono zittirlo.
    const sopra = chiamata.sta_parlando;
    const fattore = sopra ? (chiamata.web ? v.interruzioneFattoreWeb : v.interruzioneFattore) : 1;
    const forte = rms > (chiamata.web ? v.sogliaWeb : v.soglia) * fattore;
    // Frase finita ma ancora in grazia: se il cliente riprende, si unisce alla stessa frase.
    if (sospesa) {
      grazia.push(pcm);
      voceGrazia = forte ? voceGrazia + 1 : 0;
      if (voceGrazia * FRAME_MS >= v.inizioMs) {
        const ripresa = sospesa;
        sospesa = null;
        clearTimeout(ripresa.timer);
        parlando = true;
        muto = 0;
        voce = 0;
        frase = [Buffer.concat([ripresa.audio, ...grazia])];
        grazia = [];
        voceGrazia = 0;
        if (chiamata.sta_parlando || tastiera.inCorso) interrompi('il cliente riprende la frase');
      }
      return;
    }
    if (!parlando) {
      preRoll.push(pcm);
      if (preRoll.length > 25) preRoll.shift(); // 500 ms: l'attacco della parola non si perde
      voce = forte ? voce + 1 : 0;
      const sogliaInizioMs = sopra ? (chiamata.web ? v.interruzioneMsWeb : v.interruzioneMs) : v.inizioMs;
      if (voce * FRAME_MS >= sogliaInizioMs) {
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
      if (audio.length / 16 >= v.minimoMs + v.silenzioMs) sospendi(audio);
    }
  };

  chiamata.allaFine = async () => {
    interrompi('fine chiamata');
    scartaSospesa();
    cervello?.chiudi();
    if (ritardi.length) chiamata.log('⏱ ritardi (fine frase → primo audio):', ritardi.join(', '), 'ms');
  };
}
