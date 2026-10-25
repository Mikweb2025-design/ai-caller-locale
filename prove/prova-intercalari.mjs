import assert from 'node:assert/strict';
import { creaRegolatoreIntercalari } from '../src/intercalari.mjs';

let regola = creaRegolatoreIntercalari('Allora, un attimo solo, mmm vediamo, controllo');
assert.equal(regola('Un attimo solo, guardo gli orari.', 1), 'Un attimo solo, guardo gli orari.');
assert.equal(regola('Perfetto, mi dice il nome?', 2), 'Perfetto, mi dice il nome?');
assert.equal(regola('Allora, le torna tutto?', 3), 'le torna tutto?');
assert.equal(regola('Allora, è tutto segnato.', 4), 'è tutto segnato.');
assert.equal(regola('Allora, le serve altro?', 5), 'le serve altro?');
assert.equal(regola('Allora, posso aiutarla ancora?', 6), 'Allora, posso aiutarla ancora?');
regola = creaRegolatoreIntercalari('Allora, vediamo');
assert.equal(regola('Mi dice il nome?', 1), 'Mi dice il nome?');
assert.equal(regola('Quale orario preferisce?', 2), 'Quale orario preferisce?');
assert.equal(regola('Paolo Rossi, martedì alle nove. Le torna tutto?', 3), 'Allora, Paolo Rossi, martedì alle nove. Le torna tutto?');
console.log('9 controlli intercalari superati');
