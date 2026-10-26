import assert from 'node:assert/strict';
import { creaAddolcitoreVoce } from '../src/timbro.mjs';

const SR = 8000;

function tono(hz, secondi = 1, ampiezza = 10000) {
  const pcm = Buffer.alloc(Math.round(SR * secondi) * 2);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(ampiezza * Math.sin(2 * Math.PI * hz * i / SR)), i * 2);
  return pcm;
}

function rms(pcm, salta = 800) {
  let somma = 0, n = 0;
  for (let i = salta * 2; i < pcm.length; i += 2) { const x = pcm.readInt16LE(i); somma += x * x; n++; }
  return Math.sqrt(somma / n);
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

function guadagno(hz) {
  const ingresso = tono(hz);
  const uscita = creaAddolcitoreVoce('voce-f-2.wav').applica(ingresso);
  return rms(uscita) / rms(ingresso);
}

const basso = guadagno(250);
const parlato = guadagno(1000);
const asprezza = guadagno(3000);
assert.ok(basso / parlato > 1.08 && basso / parlato < 1.25, `corpo inatteso: ${basso / parlato}`);
assert.ok(parlato > 0.28 && parlato < 1.08, `parlato alterato: ${parlato}`);
assert.ok(asprezza / parlato > 0.42 && asprezza / parlato < 0.58, `medio-alte non attenuate correttamente: ${asprezza / parlato}`);

const nota = creaAddolcitoreVoce('voce-f-2.wav').applica(tono(220));
const notaUscita = frequenza(nota);
assert.ok(notaUscita > 210 && notaUscita < 217, `cadenza non scaldata correttamente: ${notaUscita} Hz`);

const dinamica = Buffer.concat([tono(600, 1, 5000), tono(600, 1, 15000)]);
const dinamicaUscita = creaAddolcitoreVoce('voce-f-2.wav').applica(dinamica);
const meta = (dinamicaUscita.length >> 1) & ~1;
const piano = rms(dinamicaUscita.subarray(0, meta), 2400);
const forte = rms(dinamicaUscita.subarray(meta), 2400);
assert.ok(forte / piano < 2.35, `volume ancora troppo variabile: ${forte / piano}`);

const originale = tono(1200, 0.2);
assert.strictEqual(creaAddolcitoreVoce('altra-voce.wav').applica(originale), originale, 'le altre voci non devono essere toccate');

const intero = creaAddolcitoreVoce('voce-f-2.wav').applica(originale);
const aPezzi = creaAddolcitoreVoce('voce-f-2.wav');
const diviso = Buffer.concat([
  aPezzi.applica(originale.subarray(0, 318)),
  aPezzi.applica(originale.subarray(318, 1436)),
  aPezzi.applica(originale.subarray(1436)),
]);
assert.deepEqual(diviso, intero, 'il filtro deve essere continuo anche durante lo streaming');

console.log('7 controlli timbro voce superati', { basso, parlato, asprezza, notaUscita, rapportoVolume: forte / piano });
