import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { aMulaw, daMulaw } from '../src/voce.mjs';
import { gestisciChiamata } from '../src/chiamata.mjs';
import {
  creaRumoreAttesa,
  creaToccoTastiera,
  fermaAttesaPrimaDellaVoce,
} from '../src/attesa.mjs';

function timerFinti() {
  const coda = [];
  return {
    coda,
    pianifica(fn, ms) {
      const timer = { fn, ms, annullato: false };
      coda.push(timer);
      return timer;
    },
    annulla(timer) { timer.annullato = true; },
    esegui(timer = coda.find((x) => !x.annullato)) {
      assert.ok(timer, 'manca un timer da eseguire');
      timer.annullato = true;
      timer.fn();
    },
  };
}

function rmsPcm(pcm) {
  let somma = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    const valore = pcm.readInt16LE(i);
    somma += valore * valore;
  }
  return Math.sqrt(somma / (pcm.length / 2));
}

test('il tocco e percepibile ma resta molto sotto la soglia del VAD', () => {
  const audio = creaToccoTastiera({ volume: 1, casuale: () => 0.5 });
  assert.ok(Buffer.isBuffer(audio));
  assert.ok(audio.length >= 160, 'serve almeno un breve tocco audio');
  assert.ok(audio.some((x) => x !== 0xff), 'non deve essere silenzio');
  const rms = rmsPcm(daMulaw(audio));
  assert.ok(rms > 10, `RMS troppo basso: ${rms}`);
  assert.ok(rms < 500, `RMS non sicuro per il VAD: ${rms}`);
});

test('avvio idempotente, burst irregolari e stop senza emissioni residue', () => {
  const timer = timerFinti();
  const inviati = [];
  const attesa = creaRumoreAttesa({
    invia: (audio) => inviati.push(audio),
    casuale: () => 0.5,
    pianifica: timer.pianifica,
    annulla: timer.annulla,
  });

  assert.equal(attesa.avvia(), true);
  assert.equal(attesa.avvia(), false);
  assert.equal(timer.coda.length, 1);
  assert.ok(timer.coda[0].ms >= 350 && timer.coda[0].ms <= 500);

  timer.esegui(timer.coda[0]);
  assert.equal(inviati.length, 1);
  assert.ok(inviati[0].length > 0);
  assert.equal(timer.coda.length, 2);
  assert.ok(timer.coda[1].ms >= 700 && timer.coda[1].ms <= 1400);
  assert.equal(attesa.haInviato, true);

  assert.equal(attesa.ferma(), true, 'segnala che il buffer remoto va svuotato');
  assert.equal(timer.coda[1].annullato, true);
  timer.coda[1].fn(); // anche una callback gia accodata non deve emettere dopo stop
  assert.equal(inviati.length, 1);
  assert.equal(attesa.ferma(), false);
});

test('disabilitata o a volume zero non pianifica nulla', () => {
  for (const opzioni of [{ attivo: false }, { volume: 0 }]) {
    const timer = timerFinti();
    const attesa = creaRumoreAttesa({
      ...opzioni,
      invia: () => assert.fail('non deve inviare audio'),
      pianifica: timer.pianifica,
      annulla: timer.annulla,
    });
    assert.equal(attesa.avvia(), false);
    assert.equal(timer.coda.length, 0);
  }
});

test('prima della voce elimina il rumore accodato una sola volta', () => {
  const eventi = [];
  const attesa = {
    ferma() { eventi.push('stop'); return true; },
  };
  assert.equal(fermaAttesaPrimaDellaVoce(attesa, () => eventi.push('clear')), true);
  eventi.push('voce');
  assert.deepEqual(eventi, ['stop', 'clear', 'voce']);

  attesa.ferma = () => false;
  assert.equal(fermaAttesaPrimaDellaVoce(attesa, () => eventi.push('clear-inutile')), false);
  assert.ok(!eventi.includes('clear-inutile'));
});

test('la configurazione disattiva e limita il volume non valido', () => {
  const script = "import { CONFIG } from './src/config.mjs'; console.log(JSON.stringify(CONFIG.tastiera))";
  const esegui = (variabili) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...variabili },
    encoding: 'utf8',
  }));
  assert.deepEqual(esegui({ TASTIERA_ATTESA: 'off', TASTIERA_VOLUME: '9' }), { attiva: false, volume: 0.04 });
  assert.deepEqual(esegui({ TASTIERA_ATTESA: '1', TASTIERA_VOLUME: 'non-numero' }), { attiva: true, volume: 0.025 });
});

const AUDIO_TASTIERA = Buffer.from([0xa1, 0xa2, 0xa3]);
const AUDIO_VOCE = Buffer.from([0xb1, 0xb2, 0xb3]);

function creaCervelloFinto() {
  let numero = 0;
  const richieste = [];
  return {
    richieste,
    alTesto: null,
    allaFine: null,
    ascolta(testo) { richieste.push({ numero: ++numero, testo }); return numero; },
    rispondi(testo = 'Va bene, controllo subito.') {
      const n = richieste.at(-1).numero;
      this.alTesto?.('Va bene', n);
      this.allaFine?.(testo, n);
    },
    chiudi() {},
  };
}

function creaChiamataFinta(nome) {
  const eventi = [], log = [], marche = [];
  return {
    callSid: `CA-attesa-${nome}`,
    chiamante: '+390000000000',
    chiusa: false,
    eventi,
    logRighe: log,
    get sta_parlando() { return marche.length > 0; },
    inviaAudio(payload) { eventi.push({ tipo: 'media', audio: Buffer.from(payload, 'base64') }); },
    marca() { marche.push(`m${marche.length + 1}`); eventi.push({ tipo: 'mark' }); },
    svuota() { marche.length = 0; eventi.push({ tipo: 'clear' }); },
    log(...parti) { log.push(parti.join(' ')); },
    testo() {},
    async finitoDiParlare() {},
    riaggancia() {},
    azzera() { eventi.length = 0; log.length = 0; marche.length = 0; },
  };
}

function creaTastieraFinta(contenitore) {
  return ({ invia, attivo }) => {
    const abilitato = attivo !== false;
    let inCorso = false, inviato = false;
    const controller = {
      get inCorso() { return inCorso; },
      get haInviato() { return inviato; },
      avvia() {
        if (!abilitato || inCorso) return false;
        inCorso = true;
        inviato = true;
        invia(AUDIO_TASTIERA);
        return true;
      },
      ferma() {
        inCorso = false;
        const prima = inviato;
        inviato = false;
        return prima;
      },
    };
    contenitore.push(controller);
    return controller;
  };
}

function frameAudio(ampiezza) {
  const pcm = Buffer.alloc(320);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(ampiezza, i);
  return aMulaw(pcm).toString('base64');
}
const FRAME_VOCE = frameAudio(5000);
const FRAME_SILENZIO = frameAudio(0);

function completaFraseVocale(chiamata) {
  for (let i = 0; i < 16; i++) chiamata.alAudio(FRAME_VOCE);
  for (let i = 0; i < 45; i++) chiamata.alAudio(FRAME_SILENZIO);
}

async function attendi(condizione, messaggio) {
  for (let i = 0; i < 100; i++) {
    if (condizione()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail(messaggio);
}

async function scenario(nome, { web = false } = {}) {
  const chiamata = creaChiamataFinta(nome);
  chiamata.web = web;
  const cervello = creaCervelloFinto();
  const controller = [];
  gestisciChiamata(chiamata, {
    preparaCervello: async () => cervello,
    trascrivi: async () => ({ testo: 'Vorrei un appuntamento.', ms: 12, voce_occupata: false }),
    pronuncia: async (_testo, alPezzo) => alPezzo(AUDIO_VOCE),
    frasePronta: async () => AUDIO_VOCE,
    salutoCompleto: () => 'Buongiorno.',
    salutoSegmenti: () => [{ testo: 'Buongiorno.', lingua: 'it' }],
    creaRumoreAttesa: creaTastieraFinta(controller),
  });
  await chiamata.alPartire();
  chiamata.azzera(); // il saluto non appartiene alla prova dell'attesa
  return { chiamata, cervello, controller: controller[0] };
}

test('integrazione vocale: media raw, clear prima della voce e latenza non falsata', async () => {
  const { chiamata, cervello } = await scenario('ordine');
  completaFraseVocale(chiamata);
  await attendi(() => cervello.richieste.length === 1, 'la frase non e arrivata al cervello');

  const tastieraPrima = chiamata.eventi.filter((x) => x.tipo === 'media' && x.audio.equals(AUDIO_TASTIERA));
  assert.ok(tastieraPrima.length >= 1, 'manca il rumore durante STT/AI');
  assert.equal(chiamata.eventi.some((x) => x.tipo === 'mark'), false, 'la tastiera non deve avere mark');
  assert.equal(chiamata.logRighe.some((x) => x.includes('primo audio')), false, 'la tastiera non deve contare come risposta');

  cervello.rispondi();
  await attendi(() => chiamata.eventi.some((x) => x.tipo === 'media' && x.audio.equals(AUDIO_VOCE)), 'Maria non ha parlato');
  const voce = chiamata.eventi.findIndex((x) => x.tipo === 'media' && x.audio.equals(AUDIO_VOCE));
  assert.equal(chiamata.eventi[voce - 1]?.tipo, 'media', 'prima della voce va il silenzio protettivo della risposta');
  assert.equal(chiamata.eventi[voce - 2]?.tipo, 'clear', 'il buffer tastiera va cancellato subito prima della voce');
  assert.equal(chiamata.eventi.slice(0, voce).some((x) => x.tipo === 'mark'), false);
  assert.equal(chiamata.eventi[voce + 1]?.tipo, 'mark');
  assert.equal(chiamata.logRighe.filter((x) => x.includes('primo audio')).length, 1);
  await chiamata.allaFine();
});

test('integrazione: barge-in e fine chiamata arrestano la tastiera', async () => {
  const primo = await scenario('barge-in');
  completaFraseVocale(primo.chiamata);
  await attendi(() => primo.cervello.richieste.length === 1, 'attesa AI non iniziata');
  primo.chiamata.azzera();
  for (let i = 0; i < 8; i++) primo.chiamata.alAudio(FRAME_VOCE);
  assert.equal(primo.controller.inCorso, false);
  assert.ok(primo.chiamata.eventi.some((x) => x.tipo === 'clear'));
  await primo.chiamata.allaFine();

  const secondo = await scenario('fine');
  completaFraseVocale(secondo.chiamata);
  await attendi(() => secondo.cervello.richieste.length === 1, 'attesa AI non iniziata');
  secondo.chiamata.azzera();
  await secondo.chiamata.allaFine();
  assert.equal(secondo.controller.inCorso, false);
  assert.deepEqual(secondo.chiamata.eventi.map((x) => x.tipo), ['clear']);
});

test('integrazione: la chat scritta non avvia la tastiera', async () => {
  const { chiamata, cervello, controller } = await scenario('testo');
  await chiamata.alTestoScritto('Vorrei un appuntamento.');
  assert.equal(cervello.richieste.length, 1);
  assert.equal(controller.inCorso, false);
  assert.equal(chiamata.eventi.some((x) => x.tipo === 'media' && x.audio.equals(AUDIO_TASTIERA)), false);
  assert.equal(chiamata.eventi.some((x) => x.tipo === 'mark'), false);
  await chiamata.allaFine();
});

test('integrazione: la chiamata vocale dal browser non riceve rumori artificiali', async () => {
  const { chiamata, cervello, controller } = await scenario('browser-mobile', { web: true });
  completaFraseVocale(chiamata);
  await attendi(() => cervello.richieste.length === 1, 'la frase browser non e arrivata al cervello');
  assert.equal(controller.inCorso, false);
  assert.equal(chiamata.eventi.some((x) => x.tipo === 'media' && x.audio.equals(AUDIO_TASTIERA)), false);
  await chiamata.allaFine();
});
