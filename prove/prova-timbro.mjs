import assert from 'node:assert/strict';
import { creaAddolcitoreVoce, creaEqualizzatoreVoce, VocePiuCalda } from '../src/timbro.mjs';

const SR = 8000;

function tono(hz, secondi = 1, ampiezza = 10000) {
  const pcm = Buffer.alloc(Math.round(SR * secondi) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(ampiezza * Math.sin(2 * Math.PI * hz * i / SR)), i * 2);
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

// Frequenza fondamentale per autocorrelazione: regge anche i battimenti del grano.
function frequenza(pcm, da = 0) {
  const x = campioni(pcm);
  const n = 1024;
  const misure = [];
  for (let i = da; i + n < x.length; i += n / 2) {
    let energia = 0;
    for (let k = 0; k < n; k++) energia += x[i + k] * x[i + k];
    if (Math.sqrt(energia / n) < 500) continue;
    let migliore = 0, ritardo = 0;
    for (let lag = Math.ceil(SR / 400); lag < Math.floor(SR / 66); lag++) {
      let somma = 0;
      for (let k = 0; k < n - lag; k++) somma += x[i + k] * x[i + k + lag];
      if (somma > migliore) { migliore = somma; ritardo = lag; }
    }
    if (ritardo) misure.push(SR / ritardo);
  }
  misure.sort((a, b) => a - b);
  return misure[Math.floor(misure.length / 2)] || 0;
}

// Risposta dell'equalizzatore, misurata su toni puri: 0 dB = 800 Hz.
const eq = creaEqualizzatoreVoce('voce-f-2.wav');
const risposta = (hz) => 20 * Math.log10(rms(eq(tono(hz, 1, 6000)), 2000) / rms(tono(hz, 1, 6000), 2000));
const corpo = risposta(250) - risposta(800);
const squillo = risposta(1600) - risposta(800);
const bordo = risposta(3800) - risposta(800);

// Corpo: la voce non deve diventare cupa.
assert.ok(corpo > -2 && corpo < 1, `corpo inatteso: ${corpo.toFixed(1)} dB`);
// Squillo: la banda che fa "squillare" la voce sintetica deve essere attenuata.
assert.ok(squillo < -0.5 && squillo > -3.5, `squillo non attenuato: ${squillo.toFixed(1)} dB`);
// Bordo del vocoder: tagliato prima di arrivare al telefono.
assert.ok(bordo < -5, `bordo del vocoder ancora presente: ${bordo.toFixed(1)} dB`);

// Tono: la voce scende di ~3 semitoni (235 Hz del motore -> ~198 Hz) senza allungare la frase.
const caldo = new VocePiuCalda(0.84);
const nota = caldo.applica(tono(220));
const notaUscita = frequenza(nota);
const rapporto = notaUscita / 220;
assert.ok(rapporto > 0.80 && rapporto < 0.88, `tono non abbassato come previsto: ${notaUscita.toFixed(0)} Hz (${rapporto.toFixed(2)}x)`);
const secondi = nota.length / 2 / SR;
assert.ok(secondi > 0.95 && secondi < 1.05, `la frase si è allungata: ${secondi.toFixed(2)} s invece di 1,00 s`);

// Durata e continuità anche con pezzi piccoli, come arriva l'audio dal motore.
const pezzi = new VocePiuCalda(0.84);
const aPezzi = [pezzi.applica(tono(220).subarray(0, 1200)), pezzi.applica(tono(220).subarray(1200, 8000)), pezzi.applica(tono(220).subarray(8000))];
const unito = Buffer.concat(aPezzi);
assert.ok(Math.abs(unito.length - nota.length) < 4 * 120 * 2, `pezzi e intero non tornano: ${unito.length} vs ${nota.length}`);

// Niente scatti: il passaggio grano-grano non deve produrre clic.
const saltoMax = (pcm) => {
  const x = campioni(pcm);
  let massimo = 0;
  for (let i = 1; i < x.length; i++) massimo = Math.max(massimo, Math.abs(x[i] - x[i - 1]));
  return massimo;
};
const saltoIngresso = saltoMax(tono(600, 1, 9000));
const saltoUscita = saltoMax(creaAddolcitoreVoce('voce-f-2.wav').applica(tono(600, 1, 9000)));
assert.ok(saltoUscita < saltoIngresso * 1.2, `clic nell'audio: salto ${saltoUscita} contro ${saltoIngresso}`);

// Livello: la voce esce già al volume giusto, così non serve alzare il telefono (e non stride).
const voceFinta = Buffer.concat([tono(320, 0.5, 2200), tono(900, 0.4, 2600), tono(1700, 0.4, 1400), tono(2600, 0.3, 1200), Buffer.alloc(SR),
  tono(320, 0.5, 2200), tono(900, 0.4, 2600), tono(1700, 0.4, 1400), tono(2600, 0.3, 1200), Buffer.alloc(SR)]);
const uscita = creaAddolcitoreVoce('voce-f-2.wav').applica(voceFinta);
const livello = rmsParlato(uscita);
const livelloIngresso = rmsParlato(voceFinta);
const guadagnoVoce = livello / livelloIngresso;
assert.ok(guadagnoVoce > 0.9 && guadagnoVoce < 1.9, `livello fuori scala: ${guadagnoVoce.toFixed(2)}x (${Math.round(livello)})`);

let picco = 0;
for (const v of campioni(uscita)) picco = Math.max(picco, Math.abs(v));
assert.ok(picco < 32700, `l'audio va in distorsione: picco ${picco}`);

// Ogni voce passa dalla stessa catena: nessuna resta squillante solo perché è un altro file.
const originale = tono(1200, 0.2);
assert.deepEqual(creaAddolcitoreVoce('altra-voce.wav').applica(originale), creaAddolcitoreVoce('voce-f-2.wav').applica(originale), 'la catena deve valere per ogni voce');

// Dinamica: un pezzo piano non sparisce e uno forte non urla.
const dinamica = Buffer.concat([tono(600, 1, 1200), tono(600, 1, 9000)]);
const dinamicaUscita = creaAddolcitoreVoce('voce-f-2.wav').applica(dinamica);
const meta = (dinamicaUscita.length >> 1) & ~1;
const piano = rms(dinamicaUscita.subarray(0, meta), 2400);
const forte = rms(dinamicaUscita.subarray(meta), 2400);
assert.ok(forte / piano < 2.6, `volume ancora troppo variabile: ${(forte / piano).toFixed(2)}`);

console.log('10 controlli timbro voce superati', {
  corpo: corpo.toFixed(1), squillo: squillo.toFixed(1), bordo: bordo.toFixed(1), livello: Math.round(livello), notaUscita, secondi: secondi.toFixed(2), clic: `${saltoUscita}/${saltoIngresso}`,
});
