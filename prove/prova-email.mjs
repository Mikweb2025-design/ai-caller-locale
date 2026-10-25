import assert from 'node:assert/strict';
import { emailDaVoce } from '../src/chiamata.mjs';

assert.equal(emailDaVoce('Info chiocciola Daniele-Michelin.com'), 'info@daniele-michelin.com');
assert.equal(emailDaVoce('mario punto rossi chiocciola esempio punto it'), 'mario.rossi@esempio.it');
assert.equal(emailDaVoce('mario.rossi@example.com'), 'mario.rossi@example.com');
assert.equal(emailDaVoce('non voglio lasciare la mail'), '');
console.log('4 controlli riconoscimento email superati');
