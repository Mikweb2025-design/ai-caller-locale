import assert from 'node:assert/strict';
import { creaAddolcitoreVoce } from '../src/timbro.mjs';

const SR = 8000;

function tono(hz, secondi = 1, ampiezza = 10000) {
  const pcm = Buffer.alloc(Math.round(SR * secondi) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(ampiezza * Math.sin(2 * Math.PI * hz * i / SR)), i * 2);
  return pcm;
}

// Rumore bianco riproducibile: serve a misurare la risposta in frequenza anche con il
// livellatore acceso (che alza o abbassa il volume, ma non cambia il timbro).
function rumore(secondi = 4, ampiezza = 3000) {
  const pcm = Buffer.alloc(Math.round(SR * secondi) * 2);
  let seme = 12345;
  for (let i = 0; i < pcm.length / 2; i++) {
    seme = (seme * 1103515245 + 12345) & 0x7fffffff;
    pcm.writeInt16LE(Math.round((seme / 0x7fffffff * 2 - 1) * ampiezza), i * 2);
  }
  return pcm;
}

const campioni = (pcm) => new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);

function rms(pcm, da = 0) {
  const x = campioni(pcm);
  let somma = 0, n = 0;
  for (let i = da; i < x.length; i++) { somma += x[i] * x[i]; n++; }
  return Math.sqrt(somma / n);
}

// RMS delle sole parti "parlate": il silenzio non deve falsare il livello.
function rmsParlato(pcm) {
  const x = campioni(pcm);
  const frame = [];
  for (let i = 0; i + 320 <= x.length; i += 320) {
    let somma = 0;
    for (let k = 0; k < 320; k++) somma += x[i + k] * x[i + k];
    const r = Math.sqrt(somma / 320);
    if (r > 500) frame.push(r);
  }
  return frame.length ? frame.reduce((a, b) => a + b, 0) / frame.length : 0;
}

function frequenza(pcm, salta = 800) {
  let passaggi = 0, precedente = pcm.readInt16LE(salta * 2);
  for (let i = salta + 1; i < pcm.length / 2; i++) {
    const x = pcm.readInt16LE(i * 2);
    if (precedente <= 0 && x > 0) passaggi++;
    precedente = x;
  }
  return passaggi / ((pcm.length / 2 - salta) / SR);
}

// Risposta in frequenza misurata sul rumore, normalizzata a 800 Hz (0 dB = banda parlate).
const ingresso = rumore();
const uscita = creaAddolcitoreVoce('voce-f-2.wav').applica(ingresso);
function risposta(hz) {
  const n = 1024, hop = 512, win = [...Array(n)].map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
  const nu = new Float64Array(n / 2 + 1), usc = new Float64Array(n / 2 + 1);
  const a = campioni(ingresso), b = campioni(uscita);
  for (let i = SR; i + n < a.length; i += hop) {
    const re = new Float64Array(n / 2 + 1), im = new Float64Array(n / 2 + 1);
    const re2 = new Float64Array(n / 2 + 1), im2 = new Float64Array(n / 2 + 1);
    for (let k = 0; k < n; k++) {
      const v = a[i + k] * win[k], w = b[i + k] * win[k];
      for (let m = 0; m <= n / 2; m++) {
        const c = Math.cos(2 * Math.PI * m * k / n), s = Math.sin(2 * Math.PI * m * k / n);
        re[m] += v * c; im[m] -= v * s; re2[m] += w * c; im2[m] -= w * s;
      }
    }
    for (let m = 0; m <= n / 2; m++) { nu[m] += re[m] ** 2 + im[m] ** 2; usc[m] += re2[m] ** 2 + im2[m] ** 2; }
  }
  const centro = Math.round(hz * n / SR);
  const somma = (v) => { let s = 0, c = 0; for (let m = centro - 7; m <= centro + 7; m++) { s += v[m]; c++; } return s / c; };
  return 10 * Math.log10(somma(usc) / somma(nu));
}

const corpo = risposta(250) - risposta(800);
const squillo = risposta(1600) - risposta(800);
const vocoder = risposta(3050) - risposta(800);
const bordo = risposta(3800) - risposta(800);

// Corpo: un filo di calore in più, senza diventare cupa.
assert.ok(corpo > -0.5 && corpo < 3.5, `corpo inatteso: ${corpo.toFixed(1)} dB`);
// Squillo: la banda che fa "squillare" la voce sintetica deve essere chiaramente attenuata.
assert.ok(squillo < -2.5 && squillo > -6, `squillo non attenuato: ${squillo.toFixed(1)} dB`);
assert.ok(squillo < corpo - 2.5, 'lo squillo deve stare sotto il corpo di almeno 2,5 dB');
assert.ok(vocoder < -4 && vocoder > -9, `punta del vocoder non attenuata: ${vocoder.toFixed(1)} dB`);
assert.ok(bordo < -8, `bordo del vocoder ancora presente: ${bordo.toFixed(1)} dB`);

// Livello: la voce esce già al volume giusto, così non serve alzare il telefono (e non stride).
const voceFinta = Buffer.concat([tono(320, 0.5, 2200), tono(900, 0.4, 2600), tono(1700, 0.4, 1400), tono(2600, 0.3, 1200), Buffer.alloc(SR),
  tono(320, 0.5, 2200), tono(900, 0.4, 2600), tono(1700, 0.4, 1400), tono(2600, 0.3, 1200), Buffer.alloc(SR)]);
const livello = rmsParlato(creaAddolcitoreVoce('voce-f-2.wav').applica(voceFinta));
const livelloIngresso = rmsParlato(voceFinta);
const guadagnoVoce = livello / livelloIngresso;
assert.ok(guadagnoVoce > 0.9 && guadagnoVoce < 1.9, `livello fuori scala: ${guadagnoVoce.toFixed(2)}x (${Math.round(livello)})`);

let picco = 0;
for (const v of campioni(uscita)) picco = Math.max(picco, Math.abs(v));
assert.ok(picco < 32700, `l'audio va in distorsione: picco ${picco}`);

// Cadenza appena più calma, sotto un semitono: l'identità della voce non cambia.
const nota = creaAddolcitoreVoce('voce-f-2.wav').applica(tono(220));
const notaUscita = frequenza(nota);
assert.ok(notaUscita > 208 && notaUscita < 218, `cadenza non scaldata correttamente: ${notaUscita} Hz`);

// Ogni voce passa dalla stessa catena: nessuna resta squillante solo perché è un altro file.
const originale = tono(1200, 0.2);
assert.deepEqual(creaAddolcitoreVoce('altra-voce.wav').applica(originale), creaAddolcitoreVoce('voce-f-2.wav').applica(originale), 'la catena deve valere per ogni voce');

const intero = creaAddolcitoreVoce('voce-f-2.wav').applica(originale);
const aPezzi = creaAddolcitoreVoce('voce-f-2.wav');
const diviso = Buffer.concat([
  aPezzi.applica(originale.subarray(0, 318)),
  aPezzi.applica(originale.subarray(318, 1436)),
  aPezzi.applica(originale.subarray(1436)),
]);
assert.deepEqual(diviso, intero, 'il filtro deve essere continuo anche durante lo streaming');

// Dinamica: un pezzo piano non sparisce e uno forte non urla.
const dinamica = Buffer.concat([tono(600, 1, 1200), tono(600, 1, 9000)]);
const dinamicaUscita = creaAddolcitoreVoce('voce-f-2.wav').applica(dinamica);
const meta = (dinamicaUscita.length >> 1) & ~1;
const piano = rms(dinamicaUscita.subarray(0, meta), 2400);
const forte = rms(dinamicaUscita.subarray(meta), 2400);
assert.ok(forte / piano < 2.6, `volume ancora troppo variabile: ${(forte / piano).toFixed(2)}`);

console.log('9 controlli timbro voce superati', {
  corpo: corpo.toFixed(1), squillo: squillo.toFixed(1), vocoder: vocoder.toFixed(1), bordo: bordo.toFixed(1), livello: Math.round(livello), notaUscita,
});
