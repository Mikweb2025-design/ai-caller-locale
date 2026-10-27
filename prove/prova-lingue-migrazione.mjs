// Le impostazioni salvate prima dei pulsanti per lingua usavano due spunte ("solo tedesco",
// "multilingua"). Devono continuare a valere: la migrazione le trasforma in "lingue.attive"
// una volta sola, senza perdere la lingua scelta per il saluto.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cartella = mkdtempSync(join(tmpdir(), 'maria-lingue-migrazione-'));
process.env.DATI_DIR = cartella;
const file = join(cartella, 'impostazioni.json');

const scenari = [
  { nome: 'niente lingue', lingue: {}, attese: ['it'] },
  { nome: 'solo tedesco', lingue: { tedesco: true }, attese: ['de', 'it'] },
  { nome: 'multilingua', lingue: { multilingua: true }, attese: ['de', 'en', 'es', 'fr', 'it'] },
  { nome: 'multilingua e tedesco', lingue: { tedesco: true, multilingua: true }, attese: ['de', 'en', 'es', 'fr', 'it'] },
  // le impostazioni nuove vincono: qui resta l'inglese, anche se "tedesco" era rimasto acceso
  { nome: 'elenco già presente', lingue: { attive: ['it', 'en'], tedesco: true }, attese: ['en', 'it'] },
];

try {
  for (const s of scenari) {
    writeFileSync(file, JSON.stringify({ lingue: { ...s.lingue, predefinita: 'it' } }));
    // ogni scenario legge il file da zero: la query string crea un modulo nuovo (la cache si azzera)
    const modulo = await import(`../src/impostazioni.mjs?scenario=${encodeURIComponent(s.nome)}`);
    assert.deepEqual([...modulo.lingueAttive()].sort(), s.attese, s.nome);
    // i vecchi campi non restano appesi: il pannello non li deve più vedere
    assert.equal(modulo.impostazioni().lingue.tedesco, undefined, s.nome);
    assert.equal(modulo.impostazioni().lingue.multilingua, undefined, s.nome);
    assert.equal(modulo.impostazioni().lingue.predefinita, 'it', s.nome);
  }

  // Da qui in poi si salva: riparto da un file pulito.
  writeFileSync(file, '{}');
  const { salvaImpostazioni, impostazioni, lingueAttive } = await import('../src/impostazioni.mjs');

  // Una lingua che non sappiamo parlare non entra nell'elenco; la lingua del saluto si salva con le altre.
  salvaImpostazioni({ lingue: { attive: ['it', 'es', 'xx'], predefinita: 'es' } });
  assert.deepEqual([...lingueAttive()].sort(), ['es', 'it']);
  assert.equal(impostazioni().lingue.predefinita, 'es');
  const salvato = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(salvato.lingue.attive.sort(), ['es', 'it'], 'le lingue attive finiscono nel file');
  assert.equal(salvato.lingue.tedesco, undefined, 'i vecchi campi spariscono dal file');
  assert.equal(salvato.lingue.multilingua, undefined, 'i vecchi campi spariscono dal file');

  // Saluto in una lingua non spuntata: il server sceglie l'italiano (default sicuro).
  // Il pannello, quando salvi, aggiunge da solo la lingua del saluto alle attive.
  salvaImpostazioni({ lingue: { attive: ['it'], predefinita: 'fr' } });
  assert.deepEqual([...lingueAttive()], ['it']);
  assert.equal(impostazioni().lingue.predefinita, 'it');
  // Come fa il pannello: inglese spuntato e scelto per il saluto.
  salvaImpostazioni({ lingue: { attive: ['it', 'en'], predefinita: 'en' } });
  assert.deepEqual([...lingueAttive()].sort(), ['en', 'it']);
  assert.equal(impostazioni().lingue.predefinita, 'en');

  // I saluti pronti delle versioni precedenti non dicevano il nome dell'attività: si aggiornano
  // da soli, mentre un saluto scritto a mano resta com'è.
  writeFileSync(file, JSON.stringify({ lingue: { salutoTedesco: 'Guten Tag, hier ist {nome}. Wie kann ich Ihnen helfen?', salutoInglese: 'Good morning, this is {nome}. How can I help you?', salutoFrancese: 'Ciao, sono {nome}.' } }));
  const migrato = await import('../src/impostazioni.mjs?saluti=1');
  assert.match(migrato.impostazioni().lingue.salutoTedesco, /\{attivita\}/, 'il vecchio saluto pronto si aggiorna');
  assert.match(migrato.impostazioni().lingue.salutoInglese, /\{attivita\}/, 'il vecchio saluto pronto si aggiorna');
  assert.equal(migrato.impostazioni().lingue.salutoFrancese, 'Ciao, sono {nome}.', 'il saluto scritto a mano non si tocca');

  // Elenco vuoto o rotto: si torna all'italiano, senza salti di lingua a metà telefonata.
  salvaImpostazioni({ lingue: { attive: 'de', predefinita: 'de' } });
  assert.deepEqual([...lingueAttive()], ['it']);
  assert.equal(impostazioni().lingue.predefinita, 'it');

  // Il saluto che comincia col nome dell'attività diventa parametrico: se importi un'altra
  // azienda il saluto la segue, e il file su disco è già aggiornato (nessun salvataggio a mano).
  writeFileSync(file, JSON.stringify({ attivita: { nome: 'Officina Verdi' }, receptionist: { saluto: 'Officina Verdi, buongiorno. Sono Maria.' }, lingue: { attive: ['it'], predefinita: 'it' } }));
  const conSaluto = await import('../src/impostazioni.mjs?saluto=1');
  assert.equal(conSaluto.impostazioni().receptionist.saluto, '{attivita}, buongiorno. Sono Maria.');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).receptionist.saluto, '{attivita}, buongiorno. Sono Maria.', 'la migrazione si scrive da sola nel file');

  console.log('Migrazione lingue verificata: vecchie spunte, elenco nuovo e lingua del saluto.');
} finally {
  rmSync(cartella, { recursive: true, force: true });
}
