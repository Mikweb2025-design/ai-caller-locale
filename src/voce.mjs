// Il collegamento col motore vocale locale (motore/motore.py) e la conversione
// tra l'audio del telefono (μ-law 8 kHz) e PCM 16 bit.
import { CONFIG } from './config.mjs';
import { creaAddolcitoreVoce } from './timbro.mjs';

// --- G.711 μ-law ---
const DECODIFICA = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  DECODIFICA[i] = u & 0x80 ? 0x84 - t : t - 0x84;
}

export function daMulaw(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) out.writeInt16LE(DECODIFICA[buf[i]], i * 2);
  return out;
}

export function aMulaw(pcm) {
  const n = pcm.length >> 1;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    let s = pcm.readInt16LE(i * 2);
    const segno = s < 0 ? 0x80 : 0;
    if (s < 0) s = -s;
    s = Math.min(s, 32635) + 0x84;
    let esp = 7;
    for (let m = 0x4000; (s & m) === 0 && esp > 0; m >>= 1) esp--;
    out[i] = ~(segno | (esp << 4) | ((s >> (esp + 3)) & 0x0f)) & 0xff;
  }
  return out;
}

// Trascrive l'audio del cliente (PCM 16 bit 8 kHz).
export async function trascrivi(pcm) {
  const r = await fetch(`${CONFIG.motore}/stt`, { method: 'POST', body: pcm });
  if (!r.ok) throw new Error(`motore /stt ${r.status}`);
  return r.json();
}

// La voce scelta nel pannello (nome del file .wav in voci/): vuoto = quella predefinita.
import { impostazioni } from './impostazioni.mjs';
const campioneAttivo = () => String(impostazioni().receptionist?.voce?.campione || '').trim();

// La catena di timbro di una telefonata: una sola per tutta la chiamata. Ricrearla a ogni
// frase faceva ripartire da zero il livellatore e il volume saltava tra una battuta e l'altra.
export function creaCatenaVoce() {
  return creaAddolcitoreVoce(campioneAttivo());
}

// Legge una frase ad alta voce: chiama alPezzo(μ-law) man mano che l'audio è pronto.
export async function pronuncia(testo, alPezzo, { segnale, voce, lingua = 'it', catena } = {}) {
  const campione = campioneAttivo();
  const addolcitore = catena || creaAddolcitoreVoce(campione);
  const r = await fetch(`${CONFIG.motore}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testo, voce, lingua, campione }),
    signal: segnale,
  });
  if (!r.ok) throw new Error(`motore /tts ${r.status}`);
  try {
    let resto = Buffer.alloc(0);
    for await (const c of r.body) {
      const b = Buffer.concat([resto, Buffer.from(c)]);
      const pari = b.length & ~1;
      resto = b.subarray(pari);
      if (pari) alPezzo(aMulaw(addolcitore.applica(b.subarray(0, pari))));
    }
    // coda dell'abbassamento di tono: senza questo l'ultima consonante si sente troncata
    const coda = addolcitore.chiudi ? addolcitore.chiudi() : null;
    if (coda && coda.length) alPezzo(aMulaw(coda));
  } catch (e) {
    // frase interrotta a metà: il pezzo rimasto nella catena non deve finire nella successiva
    addolcitore.riparti?.();
    throw e;
  }
}

// Frasi fisse (saluto, riempitivo): sintetizzate una volta sola, tenute in memoria e su disco.
// Si ascoltano subito: se la voce ha mangiato parole o è andata avanti a vuoto, si rifanno.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CARTELLA_DATI } from './impostazioni.mjs';
import { VERSIONE_TIMBRO } from './timbro.mjs';

const parole = (t) => t.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);

// Distanza di Levenshtein: "intelligenzia" detta "intelligenza" resta una parola sola.
function distanza(a, b) {
  let precedente = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const corrente = [i];
    for (let j = 1; j <= b.length; j++) {
      corrente[j] = Math.min(precedente[j] + 1, corrente[j - 1] + 1, precedente[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    precedente = corrente;
  }
  return precedente[b.length];
}

// Quanto della frase è stato davvero pronunciato: le parole si cercano anche attaccate
// ("Lasercamp" spesso torna "Laser Camp") e con un refuso si accetta la parola simile.
function copertura(attese, sentito) {
  const sentite = new Set(parole(sentito));
  const compatto = parole(sentito).join('');
  let trovate = 0;
  for (const parola of attese) {
    if (sentite.has(parola) || (parola.length >= 4 && compatto.includes(parola))) { trovate++; continue; }
    if (parola.length >= 4 && [...sentite].some((s) => Math.abs(s.length - parola.length) <= 2 && distanza(parola, s) <= Math.max(1, Math.floor(parola.length / 5)))) trovate++;
  }
  return trovate / attese.length;
}

const CARTELLA_CACHE = join(CARTELLA_DATI, 'cache-voce');
const chiave = (testo, lingua) => createHash('sha1').update(`${VERSIONE_TIMBRO}|${lingua}|${campioneAttivo()}|${testo}`).digest('hex');
const percorsoCache = (testo, lingua) => join(CARTELLA_CACHE, `${chiave(testo, lingua)}.mulaw`);

// Il saluto non deve mai dipendere da una sintesi fatta al momento: si tiene su disco.
try {
  mkdirSync(CARTELLA_CACHE, { recursive: true, mode: 0o700 });
  const scaduto = Date.now() - 30 * 24 * 3600 * 1000;
  for (const f of readdirSync(CARTELLA_CACHE)) {
    if (!f.endsWith('.mulaw')) continue;
    const p = join(CARTELLA_CACHE, f);
    try { if (statSync(p).mtimeMs < scaduto) unlinkSync(p); } catch { /* già sparito */ }
  }
} catch { /* senza cache su disco si sintetizza come prima */ }

const cache = new Map(); // chiave → Buffer μ-law già equalizzato
const inCorso = new Map(); // chiave → sintesi avviata ma non ancora finita

function salva(k, audio) {
  cache.set(k, audio);
  try { writeFileSync(join(CARTELLA_CACHE, `${k}.mulaw`), audio, { mode: 0o600 }); } catch { /* la cache è un di più */ }
}

// Audio già pronto (memoria o disco): nessuna attesa, nessuna rete.
export function fraseSubito(testo, lingua = 'it') {
  const k = chiave(testo, lingua);
  if (cache.has(k)) return cache.get(k);
  try {
    const audio = readFileSync(join(CARTELLA_CACHE, `${k}.mulaw`));
    if (audio.length) { cache.set(k, audio); return audio; }
  } catch { /* non ancora in cache */ }
  return null;
}

async function sintetizzaBene(testo, lingua, tentativi = 3) {
  let migliore = null;
  for (let i = 0; i < tentativi; i++) {
    const pezzi = [];
    await pronuncia(testo, (p) => pezzi.push(p), { lingua });
    const audio = Buffer.concat(pezzi);
    const attese = parole(testo);
    const voto = copertura(attese, (await trascrivi(daMulaw(audio))).testo) - Math.max(0, audio.length / 8000 - testo.length / 9) / 5;
    if (!migliore || voto > migliore.voto) migliore = { audio, voto };
    if (voto >= 0.97) break;
  }
  return migliore.audio;
}

// Frasi fisse verificate (saluto, riempitivo): si preparano in anticipo e restano pronte.
export async function frasePronta(testo, lingua = 'it') {
  const k = chiave(testo, lingua);
  const pronto = fraseSubito(testo, lingua);
  if (pronto) return pronto;
  if (!inCorso.has(k)) {
    const sintesi = sintetizzaBene(testo, lingua)
      .then((audio) => { salva(k, audio); return audio; })
      .finally(() => inCorso.delete(k));
    inCorso.set(k, sintesi);
  }
  return inCorso.get(k);
}

// Prima volta di una frase nuova: una sola passata, trasmessa mentre arriva, così la voce
// parte subito. La versione verificata si prepara dopo, in sottofondo.
export async function fraseInDiretta(testo, lingua = 'it', alPezzo = () => {}) {
  const k = chiave(testo, lingua);
  const pronto = fraseSubito(testo, lingua);
  if (pronto) { alPezzo(pronto); return pronto; }
  const inAttesa = inCorso.get(k);
  if (inAttesa) {
    const audio = await inAttesa.catch(() => null);
    if (audio) { alPezzo(audio); return audio; }
  }
  const pezzi = [];
  await pronuncia(testo, (p) => { pezzi.push(p); alPezzo(p); }, { lingua });
  const audio = Buffer.concat(pezzi);
  if (audio.length) salva(k, audio);
  return audio;
}
