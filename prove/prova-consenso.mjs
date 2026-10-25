import assert from 'node:assert/strict';
import { consensoPrenotazione as consenso, congedoCliente as congedo } from '../src/consenso.mjs';
const riepilogo = 'Paolo Rossi, martedì alle nove, due targhe in legno. Conferma questi dati?';
for (const testo of ['Sì', 'Sì, è tutto corretto.', 'Confermo.', 'Va bene', 'Okay, ciao.']) {
  assert.equal(consenso(testo, riepilogo, 'Paolo Rossi'), true, testo);
}
for (const testo of ['Mi chiamo Paolo Rossi', 'Sì, ma alle dieci', 'Non confermo', 'Preferisco martedì', 'No, grazie']) {
  assert.equal(consenso(testo, riepilogo, 'Paolo Rossi'), false, testo);
}
assert.equal(consenso('Sì', 'A che nome lo segno?', 'Paolo Rossi'), false);
assert.equal(consenso('Sì', riepilogo, 'Mario Bianchi'), false);
for (const domanda of ['Le torna tutto?', 'È giusto così?', 'Ho capito bene?']) {
  assert.equal(consenso('Sì', `Paolo Rossi, martedì alle nove, due targhe in legno. ${domanda}`, 'Paolo Rossi'), true, domanda);
}
for (const testo of ['È tutto corretto', 'Grazie', 'Confermo', 'Arrivederci, ma quanto costa?', 'Non è tutto']) {
  assert.equal(congedo(testo, 5), false, testo);
}
for (const testo of ['Arrivederci', 'Non mi serve altro, grazie', 'No, grazie, è tutto', 'Basta così', 'Okay, ciao.']) {
  assert.equal(congedo(testo, 5), true, testo);
}
console.log('22 controlli consenso/congedo superati');
