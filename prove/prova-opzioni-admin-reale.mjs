import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usa il modello configurato, ma una copia temporanea delle impostazioni: la prova
// non cambia mai i valori visibili nell'admin vero.
const cartella = mkdtempSync(join(tmpdir(), 'maria-opzioni-admin-reale-'));
copyFileSync(fileURLToPath(new URL('../dati/impostazioni.json', import.meta.url)), join(cartella, 'impostazioni.json'));
process.env.DATI_DIR = cartella;

try {
  const { impostazioni, salvaImpostazioni } = await import('../src/impostazioni.mjs');
  const { istruzioni } = await import('../src/persona.mjs');
  const { provaConversazione } = await import('../src/cervello.mjs');
  const frase = 'Dopo il preventivo vieni anche tu a fare un aperitivo con me, eh?';

  salvaImpostazioni({ receptionist: { scherza: false, intercalare: '' } });

  // Le opzioni admin devono arrivare nel prompt: verifica deterministica, senza modello.
  const spente = istruzioni();
  assert.match(spente, /“Scherza con il cliente” è DISATTIVATA/i);
  assert.doesNotMatch(spente, /è ATTIVA/i);
  assert.match(spente, /Niente intercalari/i);
  assert.doesNotMatch(spente, /Il titolare ha scelto questi intercalari/i);

  const professionale = await provaConversazione(impostazioni().cervello.principale, spente, { frasi: [frase] });
  assert.ok(!professionale.turni[0]?.errore, professionale.turni[0]?.errore);
  assert.doesNotMatch(professionale.turni[0].testo, /“Scherza con il cliente”|DISATTIVATA|ATTIVA/i);
  console.log(`[scherza spento]\n${professionale.turni[0].testo}\n`);

  salvaImpostazioni({ receptionist: { scherza: true, intercalare: 'dunque, controllo' } });

  // Il modello è libero di variare le parole: qui verifichiamo che le opzioni salvate
  // finiscano davvero nel prompt (veloce e stabile), non che le pronunci.
  const attive = istruzioni();
  assert.match(attive, /“Scherza con il cliente” è ATTIVA/i);
  assert.doesNotMatch(attive, /è DISATTIVATA/i);
  assert.match(attive, /Il titolare ha scelto questi intercalari/i);
  assert.match(attive, /"dunque"/i);
  assert.match(attive, /"controllo"/i);
  assert.doesNotMatch(attive, /Niente intercalari/i);

  const umano = await provaConversazione(impostazioni().cervello.principale, attive, {
    frasi: [frase, 'Va bene, intanto mi dice dove siete?'],
  });
  for (const turno of umano.turni) assert.ok(!turno.errore, turno.errore);
  for (const turno of umano.turni) {
    assert.doesNotMatch(turno.testo || '', /“Scherza con il cliente”|DISATTIVATA|ATTIVA|intercalar/i);
  }
  console.log(`[scherza attivo, intercalari personalizzati]\n${umano.turni.map((x) => x.testo).join('\n')}\n`);
} finally {
  rmSync(cartella, { recursive: true, force: true });
}
