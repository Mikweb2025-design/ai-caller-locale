import assert from 'node:assert/strict';
import { creaRegolatoreIntercalari } from '../src/intercalari.mjs';

let regola = creaRegolatoreIntercalari('Allora, un attimo solo, mmm vediamo, controllo');
assert.equal(regola('Un attimo solo, guardo gli orari.', 1), 'Un attimo solo, guardo gli orari.');
assert.equal(regola('Perfetto, mi dice il nome?', 2), 'Perfetto, mi dice il nome?');
assert.equal(regola('Allora, le torna tutto?', 3), 'Le torna tutto?');
assert.equal(regola('Allora, è tutto segnato.', 4), 'È tutto segnato.');
assert.equal(regola('Allora, le serve altro?', 5), 'Le serve altro?');
assert.equal(regola('Allora, posso aiutarla ancora?', 6), 'Allora, posso aiutarla ancora?');
regola = creaRegolatoreIntercalari('Allora, vediamo', () => 0);
assert.equal(regola('Mi dice il nome?', 1), 'Mi dice il nome?');
assert.equal(regola('Quale orario preferisce?', 2), 'Allora, quale orario preferisce?');
assert.equal(regola('Paolo Rossi, martedì alle nove. Le torna tutto?', 3), 'Paolo Rossi, martedì alle nove. Le torna tutto?');
regola = creaRegolatoreIntercalari('Allora, vediamo', () => 0);
assert.equal(regola('Un caffè va bene. Allora, mi racconti il progetto?', 2), 'Un caffè va bene. Allora, mi racconti il progetto?');
assert.equal(regola('Perfetto. Allora, quale materiale usa?', 3), 'Perfetto. Quale materiale usa?');

const conRisata = creaRegolatoreIntercalari('allora, un attimo solo');
assert.equal(conRisata('Eh eh, questa è bella. Mi racconti il progetto?', 1), 'Eh eh, questa è bella. Mi racconti il progetto?');
assert.equal(conRisata('Quale materiale preferisce?', 2), 'Quale materiale preferisce?');
assert.equal(conRisata('Eh eh, vediamo cosa si può fare.', 3), 'Vediamo cosa si può fare.');
console.log('14 controlli intercalari superati');
