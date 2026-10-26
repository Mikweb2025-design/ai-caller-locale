import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CAMPIONI_PER_FRAME, FREQUENZA_MICROFONO_SERVER, codiceCatturaBrowser } from '../src/audio-browser.mjs';

function ricampiona(frequenzaIngresso, frequenzaTono, dimensioneBlocco = 128) {
  const frame = [];
  let Classe;
  class AudioWorkletProcessorFinto {
    constructor() { this.port = { postMessage: (dati) => frame.push(Float32Array.from(dati)) }; }
  }
  vm.runInNewContext(codiceCatturaBrowser(), {
    AudioWorkletProcessor: AudioWorkletProcessorFinto,
    Float32Array,
    Math,
    sampleRate: frequenzaIngresso,
    registerProcessor: (_nome, Cattura) => { Classe = Cattura; },
  });
  const cattura = new Classe();
  const ingresso = Float32Array.from({ length: frequenzaIngresso }, (_, i) => Math.sin(2 * Math.PI * frequenzaTono * i / frequenzaIngresso) * 0.5);
  for (let i = 0; i < ingresso.length; i += dimensioneBlocco) cattura.process([[ingresso.slice(i, i + dimensioneBlocco)]]);
  return { frame, uscita: Float32Array.from(frame.flatMap((x) => [...x])) };
}

function rms(campioni) {
  return Math.sqrt(campioni.reduce((somma, valore) => somma + valore * valore, 0) / campioni.length);
}

function frequenzaStimata(campioni) {
  let salite = 0;
  for (let i = 1; i < campioni.length; i++) if (campioni[i - 1] <= 0 && campioni[i] > 0) salite += 1;
  return salite / (campioni.length / FREQUENZA_MICROFONO_SERVER);
}

for (const frequenzaIngresso of [44100, 48000]) {
  const { frame, uscita } = ricampiona(frequenzaIngresso, 440);
  assert.equal(frame.length, 50, `${frequenzaIngresso}: frame al secondo`);
  assert.ok(frame.every((x) => x.length === CAMPIONI_PER_FRAME));
  assert.equal(uscita.length, FREQUENZA_MICROFONO_SERVER);
  assert.ok(Math.abs(frequenzaStimata(uscita.slice(200)) - 440) < 3, `${frequenzaIngresso}: frequenza conservata`);

  const intera = ricampiona(frequenzaIngresso, 440, frequenzaIngresso).uscita;
  assert.deepEqual([...uscita], [...intera], `${frequenzaIngresso}: indipendente dai confini dei blocchi`);

  const alta = ricampiona(frequenzaIngresso, 12000).uscita.slice(200);
  assert.ok(rms(alta) < rms(uscita.slice(200)) * 0.12, `${frequenzaIngresso}: anti-alias sopra la banda voce`);
}

console.log('Audio iPhone: 44,1/48 kHz → 8 kHz stabile, 50 frame/s, filtro anti-alias attivo');
