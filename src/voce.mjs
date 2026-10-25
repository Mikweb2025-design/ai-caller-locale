// Il collegamento col motore vocale locale (motore/motore.py) e la conversione
// tra l'audio del telefono (μ-law 8 kHz) e PCM 16 bit.
import { CONFIG } from './config.mjs';

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

// Legge una frase ad alta voce: chiama alPezzo(μ-law) man mano che l'audio è pronto.
export async function pronuncia(testo, alPezzo, { segnale, voce, lingua = 'it' } = {}) {
  const r = await fetch(`${CONFIG.motore}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testo, voce, lingua }),
    signal: segnale,
  });
  if (!r.ok) throw new Error(`motore /tts ${r.status}`);
  let resto = Buffer.alloc(0);
  for await (const c of r.body) {
    const b = Buffer.concat([resto, Buffer.from(c)]);
    const pari = b.length & ~1;
    resto = b.subarray(pari);
    if (pari) alPezzo(aMulaw(b.subarray(0, pari)));
  }
}

// Frasi fisse (saluto, riempitivo): sintetizzate una volta sola e tenute in memoria.
// Si ascoltano subito: se la voce ha mangiato parole o è andata avanti a vuoto, si rifanno.
const parole = (t) => t.toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
async function sintetizzaBene(testo, lingua, tentativi = 4) {
  let migliore = null;
  for (let i = 0; i < tentativi; i++) {
    const pezzi = [];
    await pronuncia(testo, (p) => pezzi.push(p), { lingua });
    const audio = Buffer.concat(pezzi);
    const sentite = new Set(parole((await trascrivi(daMulaw(audio))).testo));
    const attese = parole(testo);
    const voto = attese.filter((p) => sentite.has(p)).length / attese.length - Math.max(0, audio.length / 8000 - testo.length / 9) / 5;
    if (!migliore || voto > migliore.voto) migliore = { audio, voto };
    if (voto >= 0.99) break;
  }
  return migliore.audio;
}

const cache = new Map();
export async function frasePronta(testo, lingua = 'it') {
  const k = `${lingua}|${testo}`;
  if (!cache.has(k)) cache.set(k, sintetizzaBene(testo, lingua).catch((e) => { cache.delete(k); throw e; }));
  return cache.get(k);
}
