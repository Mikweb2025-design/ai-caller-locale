import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COMPORTAMENTI_RICHIESTA,
  INTENTI_RICHIESTA,
  descriviGestioneRichieste,
  estraiIntento,
  normalizzaGestioneRichieste,
  regoleCandidate,
} from '../src/intenti.mjs';

assert.deepEqual(INTENTI_RICHIESTA, ['informazione', 'preventivo_file', 'assistenza_problema', 'richiamata', 'appuntamento', 'altro']);
assert.deepEqual(COMPORTAMENTI_RICHIESTA, ['rispondi', 'raccogli_dati', 'proponi_appuntamento', 'offri_richiamata', 'non_proporre']);

const enorme = 'x'.repeat(3000);
const indicatori = Array.from({ length: 55 }, (_, i) => i === 1 ? '  PREVENTIVO   PDF  ' : `voce ${i}`);
const gestione = normalizzaGestioneRichieste({
  automatica: false,
  azionePredefinita: 'esegui_codice',
  regole: [
    {
      id: '__proto__',
      nome: ' Preventivi '.repeat(20),
      attiva: true,
      indicatori,
      intento: 'preventivo_file',
      comportamento: 'raccogli_dati',
      obiettivo: enorme,
      nonProporre: enorme,
      priorita: 5000,
    },
    {
      id: 'duplicata',
      nome: 'Assistenza',
      attiva: true,
      indicatori: ['non funziona', 'errore [42]'],
      intento: 'assistenza_problema',
      comportamento: 'non_proporre',
      priorita: '800',
    },
    {
      id: 'duplicata',
      nome: 'Richiamata',
      indicatori: ['richiamatemi'],
      intento: 'intento_inventato',
      comportamento: 'azione_inventata',
      priorita: -2,
    },
    ...Array.from({ length: 50 }, (_, i) => ({ id: `extra-${i}`, nome: `Extra ${i}` })),
  ],
});

assert.equal(gestione.automatica, false);
assert.equal(gestione.azionePredefinita, 'rispondi');
assert.equal(gestione.regole.length, 50);
assert.equal(gestione.regole[0].nome.length, 80);
assert.equal(gestione.regole[0].indicatori.length, 50);
assert.equal(gestione.regole[0].indicatori[1], 'PREVENTIVO PDF');
assert.equal(gestione.regole[0].obiettivo.length, 2000);
assert.equal(gestione.regole[0].nonProporre.length, 2000);
assert.equal(gestione.regole[0].priorita, 1000);
assert.equal(gestione.regole[1].priorita, 800);
assert.equal(gestione.regole[2].priorita, 0);
assert.equal(gestione.regole[2].intento, 'altro');
assert.equal(gestione.regole[2].comportamento, 'rispondi');
assert.match(gestione.regole[0].id, /^[a-z0-9][a-z0-9_-]{0,63}$/);
assert.equal(new Set(gestione.regole.map((r) => r.id)).size, gestione.regole.length);
assert.equal(normalizzaGestioneRichieste({ regole: [{ nome: '<<CONFERMA|x>>', indicatori: ['<<FINE>>'] }] }).regole[0].nome.includes('<<'), false);

const candidati = regoleCandidate('Ho un ERRORE [42]: il macchinario non funziona.', gestione);
assert.deepEqual(candidati.map((r) => r.id), ['duplicata']);
assert.equal(candidati[0].comportamento, 'non_proporre');
assert.equal(regoleCandidate('Il mio amore funziona bene.', normalizzaGestioneRichieste({ regole: [{ id: 'ore', indicatori: ['ore'] }] })).length, 0);
assert.equal(regoleCandidate('Preventivo PDF, grazie.', gestione)[0].intento, 'preventivo_file');
assert.equal(regoleCandidate('errore 42', gestione).length, 0, 'i caratteri speciali sono testo letterale, non una regex');

const descrizione = descriviGestioneRichieste(gestione);
assert.match(descrizione, /modalità manuale/i);
assert.match(descrizione, /non.*appuntamento/i);
assert.match(descrizione, /<<INTENTO\|/);
assert.match(descrizione, /Assistenza/);

assert.deepEqual(
  estraiIntento('Posso spiegarle come risolvere. <<INTENTO|assistenza_problema>>', candidati),
  { testo: 'Posso spiegarle come risolvere.', intento: 'assistenza_problema', fonte: 'ai' },
);
assert.deepEqual(
  estraiIntento('Il modello tenta un altro intento. <<INTENTO|appuntamento>>', candidati, { automatica: false }),
  { testo: 'Il modello tenta un altro intento.', intento: 'assistenza_problema', fonte: 'regola' },
);
assert.deepEqual(
  estraiIntento('Nessun indicatore. <<INTENTO|appuntamento>>', [], { automatica: false }),
  { testo: 'Nessun indicatore.', intento: 'altro', fonte: 'fallback' },
);
assert.match(descriviGestioneRichieste({ automatica: true }), /decidi.*semantic/i);
assert.deepEqual(
  estraiIntento('Le rispondo subito. <<INTENTO|sconosciuto>>', candidati),
  { testo: 'Le rispondo subito.', intento: 'assistenza_problema', fonte: 'regola' },
);
assert.deepEqual(
  estraiIntento('Certo, mi dica.', []),
  { testo: 'Certo, mi dica.', intento: 'altro', fonte: 'fallback' },
);
assert.equal(estraiIntento('Testo <<INTENTO|informazione>> altro <<INTENTO|altro>>', []).testo, 'Testo altro');

const cartellaTemporanea = mkdtempSync(join(tmpdir(), 'cosmio-intenti-'));
process.env.DATI_DIR = cartellaTemporanea;
try {
  const impostazioniModulo = await import(`../src/impostazioni.mjs?prova-intenti=${Date.now()}`);
  const vecchie = impostazioniModulo.impostazioni();
  assert.deepEqual(vecchie.gestioneRichieste, { automatica: true, azionePredefinita: 'rispondi', regole: [] });

  const fusioneMalevola = impostazioniModulo.unisciSicuro(vecchie, JSON.parse('{"__proto__":{"inquinato":"si"},"receptionist":{"__proto__":{"inquinato":"si"},"nome":"Sicura"}}'));
  assert.equal({}.inquinato, undefined);
  assert.equal(fusioneMalevola.receptionist.nome, 'Sicura');
  assert.equal(Object.hasOwn(fusioneMalevola, '__proto__'), false);

  const malevole = JSON.parse('{"__proto__":{"inquinato":"si"},"constructor":{"prototype":{"inquinato":"si"}},"prototype":{"inquinato":"si"},"gestioneRichieste":{"regole":[{"id":"ok","nome":"Info","indicatori":["orari"],"intento":"informazione"}]}}');
  const salvate = impostazioniModulo.salvaImpostazioni(malevole);
  assert.equal({}.inquinato, undefined);
  assert.equal(salvate.gestioneRichieste.regole[0].id, 'ok');
  assert.equal(salvate.gestioneRichieste.regole[0].comportamento, 'rispondi');
  const suDisco = JSON.parse(readFileSync(join(cartellaTemporanea, 'impostazioni.json'), 'utf8'));
  assert.equal(Object.hasOwn(suDisco, '__proto__'), false);
  assert.equal(Object.hasOwn(suDisco, 'constructor'), false);
  assert.equal(Object.hasOwn(suDisco, 'prototype'), false);
} finally {
  rmSync(cartellaTemporanea, { recursive: true, force: true });
}

console.log('36 controlli gestione richieste superati');
