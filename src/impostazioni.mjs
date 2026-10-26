// Le impostazioni che si cambiano dal pannello admin: l'attività, gli orari, il calendario,
// le email e gli SMS. Stanno in dati/impostazioni.json; quello che manca prende i valori qui sotto.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RADICE, CONFIG } from './config.mjs';
import { normalizzaGestioneRichieste } from './intenti.mjs';

// DATI_DIR cambia la cartella dei dati (per i test: un'istanza separata non tocca quella vera)
export const CARTELLA_DATI = process.env.DATI_DIR ? resolve(process.env.DATI_DIR) : join(RADICE, 'dati');
mkdirSync(CARTELLA_DATI, { recursive: true, mode: 0o700 });
const FILE = join(CARTELLA_DATI, 'impostazioni.json');

// Contiene chiavi, password e dati dei clienti: cartella solo per te (700), file riservati (600), anche se esistevano già.
export function proteggi(...file) {
  try { chmodSync(CARTELLA_DATI, 0o700); } catch {}
  for (const f of file) try { if (existsSync(f)) chmodSync(f, 0o600); } catch {}
}
proteggi(FILE);

export const GIORNI = ['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica'];

export const PREDEFINITE = {
  attivita: {
    nome: 'Officina Marchetti',
    tipo: "un'officina meccanica indipendente",
    indirizzo: "via dell'Artigianato 12",
    telefono: '',
    sito: '',
    info: "È un'officina di famiglia, dei fratelli Marchetti, aperta da più di vent'anni. Un sito internet non ce l'avete: si fa tutto per telefono.",
    // cosa chiedere al cliente oltre a nome e orario
    domande: 'marca, modello e anno della macchina; i lavori da fare',
    servizi: 'tagliando, freni, gomme, diagnosi elettronica, climatizzatore, revisione',
    email: '',
    // scheda completa per rispondere al telefono (si può importare dal sito: pannello → Attività)
    conoscenza: '',
    sitoImportato: '', // da quale indirizzo e quando
  },
  receptionist: {
    nome: process.env.NOME_RECEPTIONIST || 'Luca',
    genere: process.env.GENERE_RECEPTIONIST || 'm',
    avatar: '', // file immagine caricato dal pannello; vuoto = avatar di Maria incluso nell'app
    saluto: '', // vuoto = "<attività>, buongiorno! Sono <nome>, mi dica."
    note: '', // istruzioni in più, in italiano
    voce: { campione: '' }, // nome del file .wav in voci/ scelto dal pannello; vuoto = voci/receptionist.wav
    scherza: true, // se il cliente scherza, scherza anche lui (una battuta ogni tanto; può disattivarlo qui)
    intercalare: '', // espressioni come "senti", "guarda": vuoto = nessuno, niente intercalari
  },
  orari: {
    // fasce di apertura per giorno, "08:00-12:30, 14:00-18:30" (vuoto = chiuso)
    lunedi: '08:00-12:30, 14:00-18:30',
    martedi: '08:00-12:30, 14:00-18:30',
    mercoledi: '08:00-12:30, 14:00-18:30',
    giovedi: '08:00-12:30, 14:00-18:30',
    venerdi: '08:00-12:30, 14:00-18:30',
    sabato: '08:00-12:30',
    domenica: '',
    chiusure: '', // giorni di chiusura straordinaria, "2026-12-24, 2026-12-31"
  },
  agenda: {
    durataMinuti: 60,
    postiPerFascia: 1, // appuntamenti in contemporanea (es. ponti in officina)
    preavvisoOre: 2, // non prenotare prima di così
    giorniAvanti: 14, // quanto avanti si può prenotare
    propostePerChiamata: 3, // orari da proporre al cliente
    calendariOccupato: '', // URL iCal (ICS) privati, uno per riga: i loro impegni bloccano gli orari
  },
  // il cervello: quale servizio risponde alle telefonate, e una riserva (servizio '' = nessuna)
  cervello: {
    principale: { servizio: 'claude', url: '', chiave: '', modello: process.env.CLAUDE_MODELLO || 'haiku', impegno: process.env.CLAUDE_IMPEGNO || 'low' },
    riserva: { servizio: '', url: '', chiave: '', modello: '', impegno: '' },
  },
  // lingue: l'italiano c'è sempre; con il tedesco il receptionist risponde nella lingua di chi chiama
  lingue: { tedesco: false, salutoTedesco: 'Guten Tag, hier ist {nome}. Wie kann ich Ihnen helfen?' },
  // calendari CalDAV collegati: { id, servizio, nome, url, utente, password, calendario, calendarioNome, leggi, scrivi }
  // l'aspetto delle pagine (pannello e chiamata dal browser): si modifica nel pannello, oppure si
  // riempiono da sole con "Importa dal sito" (logo e colore principale della home del sito)
  design: {
    logo: '', // indirizzo completo dell'immagine (http/https)
    colore: '', // colore di accento, "#c9a227"; vuoto = predefinito
    tema: '', // 'chiaro', 'scuro', o vuoto = segue il sistema
  },
  calendari: [],
  email: {
    attiva: false,
    host: '',
    porta: 587,
    sicura: false, // true per la porta 465
    utente: '',
    password: '',
    mittente: '', // es. "Officina Marchetti <prenotazioni@officina.it>"
    avvisaA: '', // chi riceve un'email a ogni nuova prenotazione (separati da virgola)
    confermaAlCliente: true, // se il cliente ha lasciato l'email
    chiediEmail: false, // se attivo: alla fine della prenotazione il receptionist chiede all'ora l'indirizzo email ("le mando la conferma")
    chiediConferma: false, // se true, il titolare deve chiedere la conferma; se false, la conferma è automatica a ogni prenotazione
  },
  // il numero di telefono: vuoto = valori del .env
  twilio: {
    accountSid: '',
    apiKey: '', // API Key SID (SK...), oppure vuoto se usi l'Auth Token
    apiSecret: '', // API Key secret oppure Auth Token
    authToken: '', // Auth Token primario dell'account: serve solo a verificare la firma delle chiamate in arrivo
    numero: '',
    urlPubblico: '', // https://... da cui Twilio raggiunge questo server
  },
  sms: {
    attivo: process.env.CON_SMS === '1',
  },
  // suoni d'ufficio in sottofondo mentre il receptionist prepara la risposta (si regge dal pannello, scheda Suoni)
  suoni: {
    attiva: CONFIG.tastiera.attiva,
    volume: CONFIG.tastiera.volume,
    tipo: 'tastiera',
    dopo: true, // piccoli rumori di stanza subito dopo la voce, prima che il cliente risponda
  },
  gestioneRichieste: normalizzaGestioneRichieste(),
};

const CHIAVI_PERICOLOSE = new Set(['__proto__', 'prototype', 'constructor']);

function clonaSicuro(valore) {
  if (Array.isArray(valore)) return valore.map(clonaSicuro);
  if (!valore || typeof valore !== 'object') return valore;
  const copia = {};
  for (const [chiave, contenuto] of Object.entries(valore)) {
    if (!CHIAVI_PERICOLOSE.has(chiave)) copia[chiave] = clonaSicuro(contenuto);
  }
  return copia;
}

export function unisciSicuro(base, sopra) {
  const out = clonaSicuro(base);
  for (const [k, v] of Object.entries(sopra || {})) {
    if (CHIAVI_PERICOLOSE.has(k)) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? unisciSicuro(base[k], v)
      : clonaSicuro(v);
  }
  return out;
}

let cache = null;
export function impostazioni() {
  if (!cache) {
    let salvate = {};
    if (existsSync(FILE)) { try { salvate = JSON.parse(readFileSync(FILE, 'utf8')); } catch (e) { console.error('impostazioni.json illeggibile:', e.message); } }
    if (salvate.receptionist && typeof salvate.receptionist === 'object') delete salvate.receptionist.personaggio; // campo tolto: nelle impostazioni vecchie si ignora
    cache = unisciSicuro(PREDEFINITE, salvate);
    cache.gestioneRichieste = normalizzaGestioneRichieste(cache.gestioneRichieste);
  }
  return cache;
}

const ascoltatori = new Set();
export const alCambio = (f) => ascoltatori.add(f);

export function salvaImpostazioni(nuove) {
  const attuali = impostazioni();
  // la password non torna mai al browser: se arriva vuota, resta quella di prima
  if (nuove?.email && !nuove.email.password) nuove.email.password = attuali.email.password;
  if (nuove?.twilio && !nuove.twilio.apiSecret) nuove.twilio.apiSecret = nuove.twilio.accountSid === '' ? '' : attuali.twilio?.apiSecret || ''; // senza account niente token
  if (nuove?.twilio && !nuove.twilio.authToken) nuove.twilio.authToken = nuove.twilio.accountSid === '' ? '' : attuali.twilio?.authToken || ''; // non torna mai al browser: vuoto = resta quello di prima
  for (const slot of ['principale', 'riserva']) {
    const n = nuove?.cervello?.[slot];
    if (n && !n.chiave) {
      const vecchio = attuali.cervello?.[slot];
      if (vecchio && vecchio.servizio === n.servizio) n.chiave = vecchio.chiave || ''; // stesso servizio: la chiave resta
    }
  }
  if (Array.isArray(nuove?.calendari)) {
    for (const c of nuove.calendari) {
      c.id ||= Math.random().toString(36).slice(2, 10);
      if (!c.password) c.password = (attuali.calendari || []).find((x) => x.id === c.id)?.password || '';
      delete c.passwordImpostata;
    }
  }
  const tutte = unisciSicuro(PREDEFINITE, unisciSicuro(attuali, nuove));
  if (Array.isArray(nuove?.calendari)) tutte.calendari = nuove.calendari; // l'elenco arriva sempre intero
  for (const g of GIORNI) tutte.orari[g] = String(tutte.orari[g] || '').trim();
  if (tutte.design) {
    tutte.design.logo = String(tutte.design.logo || '').trim();
    tutte.design.colore = String(tutte.design.colore || '').trim();
    tutte.design.tema = ['chiaro', 'scuro'].includes(tutte.design.tema) ? tutte.design.tema : '';
  }
  if (tutte.suoni) {
    tutte.suoni.attiva = Boolean(tutte.suoni.attiva);
    tutte.suoni.volume = Math.min(0.04, Math.max(0, Number(tutte.suoni.volume) || 0));
    tutte.suoni.tipo = ['tastiera', 'ufficio', 'ambiente'].includes(tutte.suoni.tipo) ? tutte.suoni.tipo : 'tastiera';
    tutte.suoni.dopo = tutte.suoni.dopo !== false;
  }
  tutte.gestioneRichieste = normalizzaGestioneRichieste(tutte.gestioneRichieste);
  delete tutte.receptionist.personaggio;
  delete tutte.twilio.segretoImpostato;
  delete tutte.twilio.authTokenImpostato;
  for (const slot of ['principale', 'riserva']) delete tutte.cervello[slot].chiaveImpostata;
  writeFileSync(FILE, JSON.stringify(tutte, null, 2), { mode: 0o600 }); // contiene chiavi e password: solo per te
  proteggi(FILE);
  cache = tutte;
  for (const f of ascoltatori) try { f(tutte); } catch {}
  return tutte;
}

// Per il browser: tutto tranne la password.
export function impostazioniPubbliche() {
  const i = structuredClone(impostazioni());
  i.email.passwordImpostata = Boolean(i.email.password);
  i.email.password = '';
  i.twilio.segretoImpostato = Boolean(i.twilio.apiSecret || process.env.TWILIO_API_SECRET);
  i.twilio.apiSecret = '';
  i.twilio.authTokenImpostato = Boolean(i.twilio.authToken || process.env.TWILIO_AUTH_TOKEN);
  i.twilio.authToken = '';
  for (const slot of ['principale', 'riserva']) { i.cervello[slot].chiaveImpostata = Boolean(i.cervello[slot].chiave); i.cervello[slot].chiave = ''; }
  for (const c of i.calendari || []) { c.passwordImpostata = Boolean(c.password); c.password = ''; }
  return i;
}

// "08:00-12:30, 14:00-18:30" → [[480, 750], [840, 1110]] (minuti dalla mezzanotte)
export function fasce(testo) {
  return String(testo || '').split(',').map((f) => f.trim()).filter(Boolean).map((f) => {
    const m = f.match(/^(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})$/);
    if (!m) throw new Error(`fascia oraria non valida: "${f}" (es. 08:00-12:30)`);
    return [Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])];
  });
}

export function controllaImpostazioni(i) {
  const errori = [];
  for (const g of GIORNI) { try { fasce(i.orari?.[g]); } catch (e) { errori.push(`${g}: ${e.message}`); } }
  const d = Number(i.agenda?.durataMinuti);
  if (!(d >= 5 && d <= 600)) errori.push('la durata di un appuntamento va da 5 a 600 minuti');
  const vista = i.design || {};
  if (vista.colore && !/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(String(vista.colore).trim())) errori.push('il colore di accento deve essere un codice esadecimale, per esempio #c9a227');
  if (vista.tema && !['chiaro', 'scuro'].includes(vista.tema)) errori.push("il tema è 'chiaro', 'scuro' o vuoto (segue il sistema)");
  if (vista.logo && !/^https?:\/\//i.test(String(vista.logo).trim())) errori.push('logo: serve un indirizzo completo che comincia con http o https');
  const c = String(i.receptionist?.voce?.campione || '').trim();
  if (c && !/^[\w-]+\.wav$/.test(c)) errori.push("la voce è il nome di un file .wav dell'elenco, oppure vuoto (voce predefinita)");
  const suoni = i.suoni || {};
  if (!(Number(suoni.volume) >= 0 && Number(suoni.volume) <= 0.04)) errori.push('il volume dei suoni va da 0 a 0.04');
  if (suoni.tipo && !['tastiera', 'ufficio', 'ambiente'].includes(suoni.tipo)) errori.push("il tipo di suono è 'tastiera', 'ufficio' oppure 'ambiente'");
  return errori;
}
