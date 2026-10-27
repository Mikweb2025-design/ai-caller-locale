// "Le stesse frasi a ogni chiamata" era metà del problema della voce meccanica.
// Qui si prova che le varianti girino davvero: mai due volte di fila la stessa.
import assert from 'node:assert/strict';
import test from 'node:test';
import { creaRegolatoreIntercalari, scegliVariante } from '../src/intercalari.mjs';
import { RIEMPITIVO, RIEMPITIVI } from '../src/chiamata.mjs';

test('scegliVariante non ripete quella appena usata', () => {
  const lista = ['a', 'b', 'c'];
  let ultima = null;
  const viste = [];
  for (let i = 0; i < 9; i++) {
    const scelta = scegliVariante(lista, ultima, () => 0);
    assert.notEqual(scelta, ultima, 'due volte di fila la stessa variante');
    ultima = scelta;
    viste.push(scelta);
  }
  assert.ok(new Set(viste).size >= 2, 'la scelta deve girare');
});

test('scegliVariante copre tutte le varianti e regge le liste di uno', () => {
  const lista = ['x', 'y', 'z'];
  const viste = new Set();
  let ultima = null;
  for (const casuale of [0, 0.4, 0.9, 0.2, 0.7, 0.5]) {
    ultima = scegliVariante(lista, ultima, () => casuale);
    viste.add(ultima);
  }
  assert.deepEqual([...viste].sort(), ['x', 'y', 'z']);
  assert.equal(scegliVariante(['solo'], null), 'solo');
  assert.equal(scegliVariante([], null), null);
});

test('i riempitivi hanno più versioni, così non si sente sempre lo stesso', () => {
  assert.ok(Array.isArray(RIEMPITIVI.it) && RIEMPITIVI.it.length >= 3);
  assert.equal(RIEMPITIVI.it[0], RIEMPITIVO, 'il primo resta quello storico');
  for (const [lingua, testi] of Object.entries(RIEMPITIVI)) {
    assert.ok(Array.isArray(testi), `${lingua}: deve essere una lista`);
    assert.ok(testi.length >= 2, `${lingua}: almeno due varianti`);
    assert.equal(new Set(testi).size, testi.length, `${lingua}: niente doppioni`);
  }
});

test('gli intercalari girano invece di essere sempre il primo della lista', () => {
  const conPrimo = creaRegolatoreIntercalari('Allora, mmm vediamo, un attimo solo', () => 0);
  const conUltimo = creaRegolatoreIntercalari('Allora, mmm vediamo, un attimo solo', () => 0.99);
  const a = conPrimo('Quale orario preferisce?', 2);
  const b = conUltimo('Quale orario preferisce?', 2);
  assert.equal(a, 'Allora, quale orario preferisce?');
  assert.equal(b, 'Un attimo solo, quale orario preferisce?');
  assert.notEqual(a, b, 'due chiamate devono poter aprire in modo diverso');
  // se il modello ha già aperto con un intercalare, non se ne aggiunge un secondo
  const dopo = creaRegolatoreIntercalari('Allora, mmm vediamo', () => 0);
  assert.equal(dopo('Allora, guardo gli orari.', 1), 'Allora, guardo gli orari.');
  assert.equal(dopo('Le va bene martedì?', 2), 'Le va bene martedì?');
});

test('un intercalare solo in apertura: poi non si accatastano', () => {
  const regola = creaRegolatoreIntercalari('Allora, mmm vediamo', () => 0);
  assert.match(regola('Prima frase utile.', 2), /^(Allora|Mmm vediamo), /);
  assert.equal(regola('Seconda frase utile.', 6), 'Seconda frase utile.');
  // se il modello ne mette un altro troppo presto (meno di tre risposte dopo), si toglie
  assert.equal(regola('Allora, terza frase.', 4), 'Terza frase.');
  // dopo qualche risposta torna lecito, e resta quello scelto dal modello
  assert.equal(regola('Allora, quarta frase.', 6), 'Allora, quarta frase.');
});
