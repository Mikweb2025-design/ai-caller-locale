// Il cervello non deve dimenticare quello che il cliente ha già detto, e il riepilogo prima
// del sì non può dipendere dalla sua memoria: se il modello chiude senza riepilogare, lo dice
// il sistema con i dati che ha già.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gestisciChiamata } from '../src/chiamata.mjs';
import { inRoma } from '../src/agenda.mjs';

const AUDIO = Buffer.from([0xff]);
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// Il riepilogo varia a ogni chiamata: queste sono le chiuse possibili.
const RIEPILOGO = /torna tutto|ricapitolo|mi confermi|giusto così|capito bene/i;

function cervelloFinto() {
  let numero = 0;
  return {
    richieste: [],
    alTesto: null,
    allaFine: null,
    ascolta(testo) {
      const turno = ++numero;
      this.richieste.push({ turno, testo });
      return turno;
    },
    async rispondi(testo) {
      const { turno } = this.richieste.at(-1);
      this.alTesto?.(testo, turno);
      await this.allaFine?.(testo, turno);
    },
    chiudi() {},
  };
}

function chiamataFinta() {
  const log = [];
  return {
    callSid: `CA-promemoria-${Math.random()}`,
    chiamante: '+390000000000',
    versione: 'web',
    chiusa: false,
    sta_parlando: false,
    logRighe: log,
    inviaAudio() {},
    marca() {},
    svuota() {},
    testo() {},
    async finitoDiParlare() {},
    riaggancia() {},
    scrivi(...parti) { log.push(parti.join(' ')); },
  };
}

async function scenario(posti = [{ giorno: '2026-10-27', ora: '09:00', minuti: 540 }]) {
  const cervello = cervelloFinto();
  const chiamata = chiamataFinta();
  chiamata.log = (...parti) => chiamata.scrivi(...parti);
  const dette = []; // le frasi che il receptionist ha davvero pronunciato
  const salvati = { appuntamenti: [], richiami: [] };
  gestisciChiamata(chiamata, {
    preparaCervello: async () => cervello,
    pronuncia: async (testo) => { dette.push(testo); },
    frasePronta: async () => AUDIO,
    salutoCompleto: () => 'Buongiorno.',
    salutoSegmenti: () => [{ testo: 'Buongiorno.', lingua: 'it' }],
    creaRumoreAttesa: () => ({ inCorso: false, avvia: () => false, ferma: () => false }),
    postiLiberi: async () => posti,
    confermaAppuntamento: async (dati) => { salvati.appuntamenti.push(dati); return { ok: true }; },
    registraRichiamo: async (dati) => { salvati.richiami.push(dati); return { ok: true, richiamo: { id: 'r1' } }; },
    attaccaTelefonoRichiamo: async () => ({ ok: true }),
  });
  await chiamata.alPartire();
  return { cervello, chiamata, dette, salvati };
}

test('il promemoria riporta al cervello i dati già acquisiti', async () => {
  const s = await scenario();
  await s.chiamata.alTestoScritto('Sono Mario Rossi, la mia email è mario chiocciola esempio punto it. Vorrei un appuntamento.');
  await s.cervello.rispondi('Perfetto. <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Martedì alle nove va bene.');
  const ultimo = s.cervello.richieste.at(-1).testo;
  assert.match(ultimo, /^Promemoria del sistema/, `manca il promemoria: ${ultimo}`);
  assert.match(ultimo, /email: mario@esempio\.it/);
  assert.match(ultimo, /richiesta in corso: appuntamento/);
  assert.match(ultimo, /Martedì alle nove va bene\.$/);
});

test('senza niente da ricordare il testo del cliente arriva com’è', async () => {
  const s = await scenario();
  await s.chiamata.alTestoScritto('Il codice è 300456.');
  assert.equal(s.cervello.richieste.at(-1).testo, 'Il codice è 300456.');
});

test('se il modello chiude senza riepilogare, il riepilogo lo dice il sistema', async () => {
  const s = await scenario();
  await s.chiamata.alTestoScritto('Vorrei un appuntamento per delle targhe incise.');
  await s.cervello.rispondi('Quando le andrebbe? <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Martedì alle nove, sono Mario Rossi.');
  await s.cervello.rispondi('Perfetto, è tutto pronto. <<CONFERMA|Mario Rossi|2026-10-27|09:00|targhe incise|mario@esempio.it>> <<INTENTO|appuntamento>>');
  await pausa(50);
  assert.equal(s.salvati.appuntamenti.length, 0, 'senza il sì del cliente non si registra niente');
  const riepilogo = s.dette.find((t) => RIEPILOGO.test(t));
  assert.ok(riepilogo, `manca il riepilogo: ${s.dette.join(' | ')}`);
  assert.match(riepilogo, /Mario Rossi/);
  assert.match(riepilogo, /martedì ventisette ottobre/);
  assert.match(riepilogo, /alle nove/i, 'l’ora va detta a parole');
  assert.match(riepilogo, /targhe incise/);
});

test('dopo il sì al riepilogo l’appuntamento si registra', async () => {
  const s = await scenario();
  await s.chiamata.alTestoScritto('Vorrei un appuntamento per delle targhe incise.');
  await s.cervello.rispondi('Quando le andrebbe? <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Martedì alle nove, sono Mario Rossi.');
  await s.cervello.rispondi('Perfetto, è tutto pronto. <<CONFERMA|Mario Rossi|2026-10-27|09:00|targhe incise|mario@esempio.it>> <<INTENTO|appuntamento>>');
  await pausa(50);
  await s.chiamata.alTestoScritto('Sì, va bene.');
  await s.cervello.rispondi('Fatto. <<INTENTO|appuntamento>>');
  await pausa(50);
  assert.equal(s.salvati.appuntamenti.length, 1);
  assert.equal(s.salvati.appuntamenti[0].nome, 'Mario Rossi');
});

test('il giorno detto dal cliente vince sulla data sbagliata del modello', async () => {
  const oggi = inRoma();
  const base = Date.parse(`${oggi.iso}T12:00:00Z`);
  const domani = new Date(base + 86400000).toISOString().slice(0, 10);
  const sbagliato = new Date(base + 3 * 86400000).toISOString().slice(0, 10);
  const s = await scenario([
    { giorno: domani, ora: '09:00', minuti: 540 },
    { giorno: sbagliato, ora: '09:00', minuti: 540 },
  ]);
  await s.chiamata.alTestoScritto('Vorrei un appuntamento per delle targhe incise.');
  await s.cervello.rispondi('Quando le andrebbe? <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Domani alle nove va bene, sono Mario Rossi.');
  await s.cervello.rispondi(`Sì, perfetto. <<CONFERMA|Mario Rossi|${sbagliato}|09:00|targhe incise|mario@esempio.it>> <<INTENTO|appuntamento>>`);
  await pausa(50);
  const riepilogo = s.dette.find((t) => RIEPILOGO.test(t));
  assert.ok(riepilogo, `manca il riepilogo: ${s.dette.join(' | ')}`);
  assert.match(riepilogo, /domani|ventotto|ventinove|trenta|novembre/i);
  await s.chiamata.alTestoScritto('Sì, va bene.');
  await s.cervello.rispondi('Fatto. <<INTENTO|appuntamento>>');
  await pausa(50);
  assert.equal(s.salvati.appuntamenti.length, 1, s.chiamata.logRighe.join('\n'));
  assert.equal(s.salvati.appuntamenti[0].giorno, domani, 'il cliente ha detto "domani": la data è quella');
});
