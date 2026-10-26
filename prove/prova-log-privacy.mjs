import assert from 'node:assert/strict';
import { bonificaTestoLog } from '../src/twilio-stream.mjs';

const storico = [
  '[web] [1.00s] 👤 Mi chiamo Mario, telefono +39 333 123 4567 e email mario@example.com',
  '[web] [2.00s] 🤖 Certo Mario, la richiameremo.',
  'Impostazioni: http://localhost:5050/admin/segreto1234567890abcdef',
].join('\n');
const pulito = bonificaTestoLog(storico);

assert.doesNotMatch(pulito, /Mario|333|mario@example|segreto1234567890abcdef/);
assert.match(pulito, /dato personale storico rimosso/);
assert.match(pulito, /admin\/<SEGRETO>/);
console.log('Bonifica log storici: dati personali e segreto rimossi');
