// Prova reale del modello configurato, senza scrivere appuntamenti: un dato anticipato
// deve restare acquisito e non essere richiesto nei turni successivi.
import assert from 'node:assert/strict';
import { impostazioni } from '../src/impostazioni.mjs';
import { provaConversazione } from '../src/cervello.mjs';
import { istruzioni } from '../src/persona.mjs';

const posti = '- martedì 27 ottobre 2026 (2026-10-27): 09:00';
const frasi = [
  'Vorrei un appuntamento martedì alle nove. Sono Mario Rossi, devo incidere due targhe e la mia email è mario chiocciola esempio punto it.',
  'Ho già il file pronto.',
];
const risultato = await provaConversazione(
  impostazioni().cervello.principale,
  istruzioni({ posti }),
  { posti, frasi },
);

for (const turno of risultato.turni) {
  assert.ok(!turno.errore, turno.errore);
  console.log(`👤 ${turno.cliente}\n🤖 ${turno.testo}\n`);
}

const dopoEmail = risultato.turni.map((x) => x.testo || '').join(' ');
assert.doesNotMatch(dopoEmail, /(?:qual(?:e| è)|mi (?:dice|dà|lascia)|ripet).{0,60}(?:email|e-mail|indirizzo)|(?:email|e-mail|indirizzo).{0,60}(?:qual(?:e| è)|mi (?:dice|dà|lascia)|ripet)/i);
