import test from 'node:test';
import assert from 'node:assert/strict';
import { evitaRichiestaEmailPreventivo, gestisciChiamata } from '../src/chiamata.mjs';
import { istruzioni } from '../src/persona.mjs';

const AUDIO = Buffer.from([0xff]);

assert.equal(
  evitaRichiestaEmailPreventivo('Capisco la richiesta. Le mando la proposta per email, quale indirizzo?', 'info@lasercamp.it'),
  'Capisco la richiesta. Può inviare il file a info chiocciola lasercamp punto it.',
);
assert.equal(
  evitaRichiestaEmailPreventivo('Può inviare il file a info chiocciola lasercamp punto it.', 'info@lasercamp.it'),
  'Può inviare il file a info chiocciola lasercamp punto it.',
);
for (const richiesta of [
  'Per il preventivo mi lasci la sua email.',
  'Mi comunica il suo indirizzo email, per favore.',
  'Qual è la sua mail?',
  'Mi lascia la mail?',
]) {
  assert.equal(
    evitaRichiestaEmailPreventivo(`Ho capito. ${richiesta}`, 'info@lasercamp.it'),
    'Ho capito. Può inviare il file a info chiocciola lasercamp punto it.',
  );
}

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
  const trascrizione = [];
  return {
    callSid: `CA-intenti-${Math.random()}`,
    chiamante: '+390000000000',
    versione: 'web',
    chiusa: false,
    sta_parlando: false,
    logRighe: log,
    trascrizione,
    inviaAudio() {},
    marca() {},
    svuota() {},
    testo(chi, testo) { trascrizione.push({ chi, testo }); },
    async finitoDiParlare() {},
    riaggancia() {},
    scrivi(...parti) { log.push(parti.join(' ')); },
  };
}

function tastieraFinta() {
  return { inCorso: false, avvia: () => false, ferma: () => false };
}

async function scenario({ posti = [{ giorno: '2026-10-27', ora: '09:00', minuti: 540 }] } = {}) {
  const cervello = cervelloFinto();
  const chiamata = chiamataFinta();
  chiamata.log = (...parti) => chiamata.scrivi(...parti);
  const salvati = { appuntamenti: [], richiami: [] };
  gestisciChiamata(chiamata, {
    preparaCervello: async () => cervello,
    pronuncia: async () => {},
    frasePronta: async () => AUDIO,
    salutoCompleto: () => 'Buongiorno.',
    salutoSegmenti: () => [{ testo: 'Buongiorno.', lingua: 'it' }],
    creaRumoreAttesa: tastieraFinta,
    postiLiberi: async () => posti,
    confermaAppuntamento: async (dati) => {
      salvati.appuntamenti.push(dati);
      return { ok: true };
    },
    registraRichiamo: async (dati) => {
      salvati.richiami.push(dati);
      return { ok: true, richiamo: { id: `r${salvati.richiami.length}` } };
    },
    aggiornaRichiamo: async () => null,
  });
  await chiamata.alPartire();
  return { cervello, chiamata, salvati };
}

test('il prompt decide semanticamente ogni turno e non forza l’appuntamento', () => {
  const prompt = istruzioni({ posti: '- martedì 27 ottobre 2026 (2026-10-27): 09:00' });
  for (const intento of ['informazione', 'preventivo_file', 'assistenza_problema', 'richiamata', 'appuntamento', 'altro']) {
    assert.match(prompt, new RegExp(`\\b${intento}\\b`));
  }
  assert.match(prompt, /<<INTENTO\|categoria>>/);
  assert.match(prompt, /ogni turno/i);
  assert.match(prompt, /non.*proporre.*appuntamento/i);
});

test('informazioni e preventivi non possono creare appuntamenti dal solo marker azione', async () => {
  const s = await scenario();
  await s.chiamata.alTestoScritto('Quali sono i vostri orari?');
  await s.cervello.rispondi('Siamo aperti al mattino. <<CONFERMA|Mario Rossi|2026-10-27|09:00|informazioni>> <<INTENTO|informazione>>');
  await s.chiamata.alTestoScritto('Vorrei un preventivo, posso inviarvi il file?');
  await s.cervello.rispondi('Può mandarci il file. <<CONFERMA|Mario Rossi|2026-10-27|09:00|preventivo>> <<INTENTO|preventivo_file>>');
  assert.deepEqual(s.salvati.appuntamenti, []);
  assert.ok(s.chiamata.logRighe.some((r) => r.includes('🎯 informazione')));
  assert.ok(s.chiamata.logRighe.some((r) => r.includes('🎯 preventivo_file')));
  assert.ok(s.chiamata.trascrizione.filter((r) => r.chi === 'receptionist').every((r) => !r.testo.includes('INTENTO')));
  await s.chiamata.allaFine();
  assert.deepEqual(s.salvati.appuntamenti, [], 'la chiusura non deve salvare una conferma pendente');
});

test('la prenotazione richiede intento, riepilogo precedente, sì esplicito e slot libero', async () => {
  const s = await scenario();
  await s.chiamata.alTestoScritto('Vorrei fissare un appuntamento.');
  await s.cervello.rispondi('Le propongo martedì alle nove. <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Mario Rossi, va bene martedì alle nove, per due targhe.');
  await s.cervello.rispondi('Mario Rossi, martedì alle nove, per due targhe. Le torna tutto? <<CONFERMA|Mario Rossi|2026-10-27|09:00|due targhe>> <<INTENTO|appuntamento>>');
  assert.equal(s.salvati.appuntamenti.length, 0);
  await s.chiamata.alTestoScritto('mario chiocciola esempio punto it');
  await s.cervello.rispondi('Mario Rossi, martedì alle nove, per due targhe. Le torna tutto? <<CONFERMA|Mario Rossi|2026-10-27|09:00|due targhe|mario@esempio.it>> <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Sì, confermo.');
  assert.equal(s.salvati.appuntamenti.length, 1, s.chiamata.logRighe.join('\n'));
  await s.cervello.rispondi('È tutto segnato. <<INTENTO|appuntamento>>');
});

test('un richiamo resta pendente finché il cliente non lo richiede o accetta esplicitamente', async () => {
  const s = await scenario();
  await s.chiamata.alTestoScritto('La macchina dà un errore.');
  await s.cervello.rispondi('Posso farla richiamare da un tecnico? <<RICHIAMA|Mario Rossi|errore macchina>> <<INTENTO|assistenza_problema>>');
  assert.equal(s.salvati.richiami.length, 0);
  await s.chiamata.alTestoScritto('Sì, va bene.');
  await s.cervello.rispondi('La farà richiamare un tecnico. <<RICHIAMA|Mario Rossi|errore macchina>> <<INTENTO|richiamata>>');
  assert.equal(s.salvati.richiami.length, 1);
});

test('uno slot non disponibile non viene mai registrato', async () => {
  const s = await scenario({ posti: [] });
  await s.chiamata.alTestoScritto('Vorrei un appuntamento.');
  await s.cervello.rispondi('Posso proporle martedì alle nove. <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Mario Rossi, martedì alle nove, per due targhe.');
  await s.cervello.rispondi('Le mando la conferma per email, quale indirizzo? <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('mario chiocciola esempio punto it');
  await s.cervello.rispondi('Mario Rossi, martedì alle nove, per due targhe. Le torna tutto? <<CONFERMA|Mario Rossi|2026-10-27|09:00|due targhe|mario@esempio.it>> <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Sì, confermo.');
  assert.equal(s.salvati.appuntamenti.length, 0);
  assert.ok(s.chiamata.logRighe.some((r) => r.includes('slot non più disponibile')));
  await s.chiamata.alTestoScritto('Sì, confermo di nuovo.');
  assert.equal(s.salvati.appuntamenti.length, 0, 'uno slot rifiutato non deve restare prenotabile in attesa');
});
