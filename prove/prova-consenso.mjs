import assert from 'node:assert/strict';
import {
  consensoPrenotazione as consenso,
  consensoRichiamo,
  congedoCliente as congedo,
} from '../src/consenso.mjs';
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
for (const testo of [
  'Vorrei essere richiamato',
  'Mi faccia richiamare da un collega',
  'Richiamatemi domani',
  'Può richiamarmi?',
  'Mi può richiamare un collega?',
  'Potete richiamarmi domani?',
  'Chiamatemi voi',
  'Mi richiamate?',
  'Mi richiama un collega?',
  'Vorrei che mi richiamaste',
  'Fatemi richiamare',
  'Può farmi richiamare?',
]) {
  assert.equal(consensoRichiamo(testo, ''), true, testo);
}
for (const testo of ['Sì, va bene', 'Okay', 'D’accordo']) {
  assert.equal(consensoRichiamo(testo, 'Preferisce che la faccia richiamare da un collega?'), true, testo);
}
for (const testo of ['Sì, certo.', 'Va bene, grazie mille.', 'Okay, va benissimo.']) {
  assert.equal(consenso(testo, riepilogo, 'Paolo Rossi'), true, testo);
  assert.equal(consensoRichiamo(testo, 'Preferisce che la faccia richiamare da un collega?'), true, testo);
}
for (const testo of ['Mi chiamo Paolo', 'Va bene', 'No, non richiamatemi', 'Vorrei informazioni']) {
  assert.equal(consensoRichiamo(testo, ''), false, testo);
}
assert.equal(consensoRichiamo('Sì, ma non voglio essere richiamato', 'La faccio richiamare?'), false);
assert.equal(consensoRichiamo('Sì', 'Le serve altro?'), false);
for (const testo of ['Sì, forse.', 'Sì, se costa meno.', 'Okay, devo pensarci.', 'Sì?', 'Va bene, dipende.']) {
  assert.equal(consenso(testo, riepilogo, 'Paolo Rossi'), false, testo);
  assert.equal(consensoRichiamo(testo, 'Preferisce che la faccia richiamare da un collega?'), false, testo);
}
console.log('34 controlli consenso/congedo/richiamo superati');
