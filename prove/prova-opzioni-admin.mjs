import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copia isolata: simula i salvataggi dell'admin senza toccare la configurazione vera.
const cartella = mkdtempSync(join(tmpdir(), 'maria-opzioni-admin-'));
const produzione = fileURLToPath(new URL('../dati/impostazioni.json', import.meta.url));
copyFileSync(produzione, join(cartella, 'impostazioni.json'));
process.env.DATI_DIR = cartella;

try {
  const { impostazioni, salvaImpostazioni } = await import('../src/impostazioni.mjs');
  const { istruzioni } = await import('../src/persona.mjs');
  const { creaRegolatoreIntercalari } = await import('../src/intercalari.mjs');

  salvaImpostazioni({ receptionist: { scherza: false, intercalare: '' } });
  assert.equal(impostazioni().receptionist.scherza, false);
  assert.equal(impostazioni().receptionist.intercalare, '');
  let prompt = istruzioni();
  assert.match(prompt, /“Scherza con il cliente” è DISATTIVATA/i);
  assert.match(prompt, /senza ricambiare la battuta, senza ironia, giochi di parole o metafore giocose/i);
  assert.doesNotMatch(prompt, /risatina scritta "eh eh"/i);
  assert.match(prompt, /Niente intercalari/i);
  assert.equal(creaRegolatoreIntercalari('')('Quale lavorazione le serve?', 2), 'Quale lavorazione le serve?');

  salvaImpostazioni({ receptionist: { scherza: false, intercalare: 'dunque, controllo' } });
  prompt = istruzioni();
  assert.match(prompt, /"dunque", "controllo"/i);
  assert.match(prompt, /“Scherza con il cliente” è DISATTIVATA/i);
  assert.equal(creaRegolatoreIntercalari(impostazioni().receptionist.intercalare)('Quale lavorazione le serve?', 2), 'dunque, quale lavorazione le serve?');

  salvaImpostazioni({ receptionist: { scherza: true, intercalare: 'senta, verifico' } });
  prompt = istruzioni();
  assert.equal(impostazioni().receptionist.scherza, true);
  assert.equal(impostazioni().receptionist.intercalare, 'senta, verifico');
  assert.match(prompt, /“Scherza con il cliente” è ATTIVA/i);
  assert.match(prompt, /risatina scritta "eh eh".*al massimo una volta/is);
  assert.match(prompt, /"senta", "verifico"/i);
  assert.equal(creaRegolatoreIntercalari(impostazioni().receptionist.intercalare)('Mi racconti il progetto?', 2), 'senta, mi racconti il progetto?');

  console.log('Admin verificato: scherzi e intercalari seguono i valori salvati.');
} finally {
  rmSync(cartella, { recursive: true, force: true });
}
