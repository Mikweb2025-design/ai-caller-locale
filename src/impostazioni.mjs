// Le impostazioni che si cambiano dal pannello admin: l'attività, gli orari, il calendario,
// le email e gli SMS. Stanno in dati/impostazioni.json; quello che manca prende i valori qui sotto.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { RADICE } from './config.mjs';

export const CARTELLA_DATI = join(RADICE, 'dati');
mkdirSync(CARTELLA_DATI, { recursive: true });
const FILE = join(CARTELLA_DATI, 'impostazioni.json');

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
    saluto: '', // vuoto = "<attività>, buongiorno! Sono <nome>, mi dica."
    personaggio: 'standard', // 'standard' | 'napoletano'
    note: '', // istruzioni in più, in italiano
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
  // calendari CalDAV collegati: { id, servizio, nome, url, utente, password, calendario, calendarioNome, leggi, scrivi }
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
  },
  // il numero di telefono: vuoto = valori del .env
  twilio: {
    accountSid: '',
    apiKey: '', // API Key SID (SK...), oppure vuoto se usi l'Auth Token
    apiSecret: '', // API Key secret oppure Auth Token
    numero: '',
    urlPubblico: '', // https://... da cui Twilio raggiunge questo server
  },
  sms: {
    attivo: process.env.CON_SMS === '1',
  },
};

function unisci(base, sopra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(sopra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? unisci(base[k], v) : v;
  }
  return out;
}

let cache = null;
export function impostazioni() {
  if (!cache) {
    let salvate = {};
    if (existsSync(FILE)) { try { salvate = JSON.parse(readFileSync(FILE, 'utf8')); } catch (e) { console.error('impostazioni.json illeggibile:', e.message); } }
    cache = unisci(PREDEFINITE, salvate);
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
  if (Array.isArray(nuove?.calendari)) {
    for (const c of nuove.calendari) {
      c.id ||= Math.random().toString(36).slice(2, 10);
      if (!c.password) c.password = (attuali.calendari || []).find((x) => x.id === c.id)?.password || '';
      delete c.passwordImpostata;
    }
  }
  const tutte = unisci(PREDEFINITE, unisci(attuali, nuove));
  if (Array.isArray(nuove?.calendari)) tutte.calendari = nuove.calendari; // l'elenco arriva sempre intero
  for (const g of GIORNI) tutte.orari[g] = String(tutte.orari[g] || '').trim();
  delete tutte.twilio.segretoImpostato;
  writeFileSync(FILE, JSON.stringify(tutte, null, 2));
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
  return errori;
}
