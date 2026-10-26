import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dati = mkdtempSync(join(tmpdir(), 'cosmio-prenotazione-atomica-'));
process.env.DATI_DIR = dati;

try {
  const impostazioni = await import(`../src/impostazioni.mjs?atomica=${Date.now()}`);
  impostazioni.salvaImpostazioni({
    orari: Object.fromEntries(impostazioni.GIORNI.map((giorno) => [giorno, '09:00-12:00'])),
    agenda: { durataMinuti: 60, postiPerFascia: 1, preavvisoOre: 0, giorniAvanti: 14, calendariOccupato: '' },
    calendari: [],
    email: { attiva: false },
  });

  const agenda = await import(`../src/agenda.mjs?atomica=${Date.now()}`);
  const slot = (await agenda.postiLiberi())[0];
  assert.ok(slot, 'serve almeno uno slot di prova');

  const datiBase = { giorno: slot.giorno, ora: slot.ora, dettagli: 'prova concorrenza', canale: 'test' };
  const risultati = await Promise.allSettled([
    agenda.prenota({ ...datiBase, nome: 'Primo' }),
    agenda.prenota({ ...datiBase, nome: 'Secondo' }),
  ]);

  assert.equal(risultati.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(risultati.filter((r) => r.status === 'rejected' && /slot non disponibile/.test(r.reason?.message || '')).length, 1);
  assert.equal(agenda.appuntamenti().filter((a) => a.giorno === slot.giorno && a.ora === slot.ora).length, 1);
  console.log('Prenotazione atomica: una sola registrazione sullo stesso slot');
} finally {
  rmSync(dati, { recursive: true, force: true });
}
