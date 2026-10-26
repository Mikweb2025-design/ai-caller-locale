// Il saluto deve partire subito: l'audio delle frasi fisse sta in cache, non si sintetizza
// mentre il cliente aspetta in silenzio. Questo controllo blinda il caso delle "ultime due
// chiamate" in cui il saluto è partito dopo 5-10 secondi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gestisciChiamata } from '../src/chiamata.mjs';
import { fraseSubito } from '../src/voce.mjs';

const AUDIO = Buffer.alloc(3200, 1); // 0,2 s di μ-law

function cervelloFinto() {
  return { ascolta: () => 1, chiudi() {}, alTesto: null, alFine: null };
}

function chiamataFinta() {
  const log = [];
  const inviati = [];
  return {
    callSid: 'CAtest-saluto',
    web: true,
    chiusa: false,
    sta_parlando: false,
    log: (...parti) => log.push(parti.join(' ')),
    inviaAudio: (base64) => inviati.push({ quando: Date.now(), base64 }),
    marca() {},
    svuota() {},
    testo() {},
    riaggancia() {},
    riassumi() {},
    log: (...parti) => log.push(parti.join(' ')),
    _log: log,
    _inviati: inviati,
  };
}

test('al telefono il saluto parte con un breve silenzio: la prima parola non si perde', async () => {
  const chiamata = chiamataFinta();
  chiamata.web = false;
  let attesa = false;
  chiamata.aspettaIngresso = async () => { attesa = true; return true; };
  gestisciChiamata(chiamata, {
    preparaCervello: async () => cervelloFinto(),
    pronuncia: async () => { throw new Error('non deve sintetizzare'); },
    fraseSubito: () => AUDIO,
    salutoCompleto: () => 'Buongiorno, sono Maria.',
    salutoSegmenti: () => [{ testo: 'Buongiorno, sono Maria.', lingua: 'it' }],
    creaRumoreAttesa: () => ({ inCorso: false, avvia: () => false, ferma: () => false }),
    postiLiberi: async () => [],
    confermaAppuntamento: async () => ({ ok: true }),
    registraRichiamo: async () => ({ ok: true, richiamo: { id: 'r1' } }),
    aggiornaRichiamo: async () => null,
  });
  await chiamata.alPartire();
  assert.ok(attesa, 'deve aspettare che la linea sia aperta');
  assert.equal(chiamata._inviati.length, 2, 'silenzio + saluto');
  const primo = Buffer.from(chiamata._inviati[0].base64, 'base64');
  assert.equal(primo.length, 1200 * 8, 'silenzio iniziale di 1200 ms');
  assert.ok(primo.every((b) => b === 0xff), 'il silenzio μ-law è 0xFF');
  assert.deepEqual(Buffer.from(chiamata._inviati[1].base64, 'base64'), AUDIO);
});

test('il saluto in cache parte senza attese', async () => {
  const chiamata = chiamataFinta();
  gestisciChiamata(chiamata, {
    preparaCervello: async () => cervelloFinto(),
    pronuncia: async () => { throw new Error('non deve sintetizzare: il saluto è già pronto'); },
    fraseSubito: () => AUDIO,
    frasePronta: (testo) => { assert.ok(fraseSubito(testo)); return Promise.resolve(AUDIO); },
    salutoCompleto: () => 'Buongiorno, sono Maria.',
    salutoSegmenti: () => [{ testo: 'Buongiorno, sono Maria.', lingua: 'it' }],
    creaRumoreAttesa: () => ({ inCorso: false, avvia: () => false, ferma: () => false }),
    postiLiberi: async () => [],
    confermaAppuntamento: async () => ({ ok: true }),
    registraRichiamo: async () => ({ ok: true, richiamo: { id: 'r1' } }),
    aggiornaRichiamo: async () => null,
  });
  const prima = Date.now();
  await chiamata.alPartire();
  const ritardo = chiamata._inviati[0].quando - prima;
  assert.equal(chiamata._inviati.length, 1, 'il saluto deve essere inviato una volta sola');
  assert.ok(ritardo < 120, `il saluto è partito dopo ${ritardo} ms`);
  assert.ok(chiamata._log.some((r) => /saluto pronto in \d+ ms/.test(r)), 'manca la misura del saluto nei log');
});

test('un saluto mai sintetizzato viene trasmesso mentre arriva, non atteso fino alla fine', async () => {
  const chiamata = chiamataFinta();
  const pezzi = [Buffer.alloc(1600, 1), Buffer.alloc(1600, 1), Buffer.alloc(1600, 1)];
  gestisciChiamata(chiamata, {
    preparaCervello: async () => cervelloFinto(),
    fraseSubito: () => null,
    fraseInDiretta: async (testo, lingua, alPezzo) => { for (const p of pezzi) alPezzo(p); return Buffer.concat(pezzi); },
    frasePronta: async () => Buffer.concat(pezzi),
    salutoCompleto: () => 'Buongiorno, sono Maria.',
    salutoSegmenti: () => [{ testo: 'Buongiorno, sono Maria.', lingua: 'it' }],
    creaRumoreAttesa: () => ({ inCorso: false, avvia: () => false, ferma: () => false }),
    postiLiberi: async () => [],
    confermaAppuntamento: async () => ({ ok: true }),
    registraRichiamo: async () => ({ ok: true, richiamo: { id: 'r1' } }),
    aggiornaRichiamo: async () => null,
  });
  await chiamata.alPartire();
  assert.equal(chiamata._inviati.length, 3, 'ogni pezzo deve partire appena è pronto');
  assert.ok(chiamata._log.some((r) => /saluto in diretta in \d+ ms/.test(r)));
});
