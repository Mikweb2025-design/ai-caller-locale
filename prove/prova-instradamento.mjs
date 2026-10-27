import test from 'node:test';
import assert from 'node:assert/strict';
import { emailDaVoce, evitaRichiestaEmailPreventivo, gestisciChiamata, numeroDaVoce } from '../src/chiamata.mjs';
import { istruzioni } from '../src/persona.mjs';

const AUDIO = Buffer.from([0xff]);

assert.equal(emailDaVoce('mario chiocciola esempio punto it'), 'mario@esempio.it');
assert.equal(emailDaVoce('Mi chiamo Mario. La mia email è mario chiocciola esempio punto it, grazie.'), 'mario@esempio.it');
assert.equal(emailDaVoce('Per contatto può usare mario.rossi@example.com.'), 'mario.rossi@example.com');

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
    attaccaTelefonoRichiamo: async (id, telefono) => {
      (salvati.telefoni ||= []).push({ id, telefono });
      return { ok: true };
    },
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

test('l’opzione scherza richiede di riconoscere semanticamente il gioco e ricambiarlo', () => {
  const prompt = istruzioni();
  assert.match(prompt, /riconosci il gioco dal significato, non da parole fisse/i);
  assert.match(prompt, /battuta.*provocazione bonaria.*invito giocoso.*ironia su di sé/is);
  assert.match(prompt, /risposta soltanto neutra, letterale o formale.*è sbagliata/is);
  assert.match(prompt, /prima parte della risposta deve fargli sentire che hai colto il tono/i);
  assert.match(prompt, /caffè, un aperitivo o una cena insieme/i);
  assert.match(prompt, /rispecchia il suo grado di formalità, il ritmo, le parole e il tipo di ironia/i);
  assert.match(prompt, /formale usa ironia asciutta.*dà del tu.*autoironia.*provocazione bonaria.*inviti personali/is);
  assert.match(prompt, /non riciclare formule o la stessa risposta con clienti diversi/i);
  assert.match(prompt, /battuta cambia soltanto il tono, MAI i fatti/i);
  assert.match(prompt, /non accettare per scherzo pagamenti, sconti, prezzi, lavori, appuntamenti, promesse o condizioni/i);
  assert.match(prompt, /risatina scritta "eh eh".*umorismo evidente/is);
});

test('chiamata dal browser: il prompt dice che il numero non è noto e va chiesto', () => {
  const prompt = istruzioni({ chiamante: 'browser', posti: '- martedì 27 ottobre 2026 (2026-10-27): 09:00' });
  assert.match(prompt, /Il numero del cliente NON lo hai/);
  assert.match(prompt, /a che numero la possiamo richiamare/);
  assert.match(prompt, /quarto campo/);
  assert.match(prompt, /non insistere: ammettilo e chiediglolo/);
  assert.doesNotMatch(prompt, /lo hai già/);
});

test('chiamata con numero noto: il prompt non lo fa chiedere', () => {
  const prompt = istruzioni({ chiamante: '+393331234567', posti: '- martedì 27 ottobre 2026 (2026-10-27): 09:00' });
  assert.match(prompt, /lo hai già \(\+393331234567\)/);
  assert.match(prompt, /senza chiederglielo/);
  assert.doesNotMatch(prompt, /NON lo hai/);
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

test('l’email anticipata dal cliente viene acquisita e non viene chiesta di nuovo', async () => {
  const s = await scenario();
  await s.chiamata.alTestoScritto('Vorrei un appuntamento. Sono Mario Rossi e la mia email è mario chiocciola esempio punto it.');
  assert.match(s.cervello.richieste.at(-1).testo, /email del cliente è già stato acquisito/i);
  assert.match(s.cervello.richieste.at(-1).testo, /non chiederlo.*non richiederlo.*non farlo ripetere/i);
  await s.cervello.rispondi('Martedì alle nove va bene? <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Sì, per due targhe.');
  await s.cervello.rispondi('Mario Rossi, martedì alle nove, due targhe. Conferma? <<CONFERMA|Mario Rossi|2026-10-27|09:00|due targhe>> <<INTENTO|appuntamento>>');
  await s.chiamata.alTestoScritto('Sì, confermo.');
  assert.equal(s.salvati.appuntamenti[0]?.email, 'mario@esempio.it');
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

test('richiamo dal browser: il numero dettato dal cliente viene salvato, senza finire nel motivo', async () => {
  const s = await scenario();
  s.chiamata.chiamante = 'browser';
  await s.chiamata.alTestoScritto('La macchina dà un errore.');
  await s.cervello.rispondi('Posso farla richiamare da un tecnico, a che numero la possiamo richiamare? <<INTENTO|assistenza_problema>>');
  await s.chiamata.alTestoScritto('Sì, va bene: zero tre tre tre, uno due tre, quattro cinque sei sette.');
  await s.cervello.rispondi('Perfetto, la faccio richiamare al tre tre tre uno due tre quattro cinque sei sette. <<RICHIAMA|Mario Rossi|errore macchina|3331234567>> <<INTENTO|richiamata>>');
  assert.equal(s.salvati.richiami.length, 1);
  assert.equal(s.salvati.richiami[0].telefono, '3331234567');
  assert.equal(s.salvati.richiami[0].motivo, 'errore macchina', 'il numero non deve finire nel motivo');
});

test('cliente detta il numero dopo la domanda: è consenso, il richiamo si registra', async () => {
  const s = await scenario();
  s.chiamata.chiamante = 'browser';
  await s.chiamata.alTestoScritto('La macchina dà un errore.');
  await s.cervello.rispondi('Posso farla richiamare da un tecnico, a che numero la possiamo richiamare? <<INTENTO|assistenza_problema>>');
  await s.chiamata.alTestoScritto('3331234567');
  await s.cervello.rispondi('La faccio richiamare. <<RICHIAMA|Mario Rossi|errore macchina|3331234567>> <<INTENTO|richiamata>>');
  assert.equal(s.salvati.richiami.length, 1, s.chiamata.logRighe.join('\n'));
  assert.equal(s.salvati.richiami[0].telefono, '3331234567');
  assert.equal(s.salvati.richiami[0].motivo, 'errore macchina');
});

test('se il modello scrive solo il marcatore, la chiamata non resta muta', async () => {
  const s = await scenario();
  s.chiamata.chiamante = 'browser';
  await s.chiamata.alTestoScritto('La macchina dà un errore.');
  await s.cervello.rispondi('Posso farla richiamare da un tecnico, a che numero la possiamo richiamare? <<INTENTO|assistenza_problema>>');
  const prima = s.chiamata.trascrizione.filter((r) => r.chi === 'receptionist').length;
  await s.chiamata.alTestoScritto('3331234567');
  await s.cervello.rispondi('<<RICHIAMA|Mario Rossi|errore macchina|3331234567>> <<INTENTO|richiamata>>');
  const dette = s.chiamata.trascrizione.filter((r) => r.chi === 'receptionist').slice(prima);
  assert.ok(dette.length >= 1, `silenzio totale dopo il numero:\n${s.chiamata.logRighe.join('\n')}`);
  assert.ok(dette.at(-1).testo.trim().length > 0, 'la frase di ripiego non può essere vuota');
});

test('richiamo da un numero noto: si usa quello del centralino, non serve chiederlo', async () => {
  const s = await scenario();
  await s.chiamata.alTestoScritto('La macchina dà un errore.');
  await s.cervello.rispondi('Posso farla richiamare da un tecnico? <<RICHIAMA|Mario Rossi|errore macchina>> <<INTENTO|assistenza_problema>>');
  await s.chiamata.alTestoScritto('Sì, va bene.');
  await s.cervello.rispondi('La faccio richiamare. <<RICHIAMA|Mario Rossi|errore macchina>> <<INTENTO|richiamata>>');
  assert.equal(s.salvati.richiami[0].telefono, '');
  assert.equal(s.salvati.richiami[0].motivo, 'errore macchina');
});

test('il numero detto a parole: cifre scritte, cifre parolate, doppio, spazzatura', () => {
  assert.equal(numeroDaVoce('Sì, va bene: tre tre tre uno due tre quattro cinque sei sette.'), '3331234567');
  assert.equal(numeroDaVoce('Il numero è 333 123 4567.'), '3331234567');
  assert.equal(numeroDaVoce('doppio tre uno doppio zero quattro cinque sei sette.'), '331004567');
  assert.equal(numeroDaVoce('+3906 1234 5678'), '+390612345678');
  assert.equal(numeroDaVoce('Domani alle nove, due gomme.'), '', 'una frase senza numero non produce cifre');
  assert.equal(numeroDaVoce('tre tre tre.'), '', 'meno di sei cifre: non è un numero');
  assert.equal(numeroDaVoce(''), '');
});

test('richiamo dal browser: il numero dettato a parole nell\'accettazione arriva nel salvataggio', async () => {
  const s = await scenario();
  s.chiamata.chiamante = 'browser';
  await s.chiamata.alTestoScritto('La macchina dà un errore.');
  await s.cervello.rispondi('Posso farla richiamare da un tecnico? <<RICHIAMA|Mario Rossi|errore macchina>> <<INTENTO|assistenza_problema>>');
  await s.chiamata.alTestoScritto('Sì, va bene: tre tre tre uno due tre quattro cinque sei sette.');
  assert.equal(s.salvati.richiami.length, 1);
  assert.equal(s.salvati.richiami[0].telefono, '3331234567', 'il numero a parole va nel campo telefono');
  assert.equal(s.salvati.richiami[0].motivo, 'errore macchina');
});

test('richiamo già registrato: il numero dettato dopo viene attaccato al richiamo', async () => {
  const s = await scenario();
  s.chiamata.chiamante = 'browser';
  await s.chiamata.alTestoScritto('La macchina dà un errore.');
  await s.cervello.rispondi('Posso farla richiamare da un tecnico? <<RICHIAMA|Mario Rossi|errore macchina>> <<INTENTO|assistenza_problema>>');
  await s.chiamata.alTestoScritto('Sì, va bene.');
  assert.equal(s.salvati.richiami[0].telefono, '');
  await s.chiamata.alTestoScritto('Il numero è tre tre tre uno due tre quattro cinque sei sette.');
  await s.cervello.rispondi('Segno tre tre tre uno due tre quattro cinque sei sette. <<INTENTO|richiamata>>');
  assert.deepEqual(s.salvati.telefoni, [{ id: 'r1', telefono: '3331234567' }], 'il numero dettato dopo si attacca al richiamo');
  await s.chiamata.alTestoScritto('Altro: il veicolo ha 123456 km dietro.');
  await s.cervello.rispondi('Va bene. <<INTENTO|richiamata>>');
  assert.equal(s.salvati.telefoni.length, 1, 'il numero non si sovrascrive due volte');
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
