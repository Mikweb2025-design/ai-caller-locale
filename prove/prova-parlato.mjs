import assert from 'node:assert/strict';
import { interoInParole, numeriInParole, punteggiaturaDaVoce } from '../src/parlato.mjs';

assert.equal(interoInParole(27), 'ventisette');
assert.equal(interoInParole(33), 'trentatré');
assert.equal(interoInParole(180), 'centottanta');
assert.equal(interoInParole(2026), 'duemilaventisei');
assert.equal(numeriInParole('martedì 27 ottobre alle 09:00'), 'martedì ventisette ottobre alle nove');
assert.equal(numeriInParole('2 targhe da 5,5 mm'), 'due targhe da cinque virgola cinque mm');
assert.equal(punteggiaturaDaVoce('Va bene , controllo\nQuale preferisce??'), 'Va bene, controllo. Quale preferisce?');
assert.equal(punteggiaturaDaVoce('Un attimo solo'), 'Un attimo solo.');
assert.equal(punteggiaturaDaVoce('Per martedì,'), 'Per martedì,');
console.log('9 controlli parlato e punteggiatura superati');
