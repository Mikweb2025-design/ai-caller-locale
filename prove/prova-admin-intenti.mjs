import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { htmlRegolaRichiesta, paginaAdmin } from '../src/admin.mjs';

const pagina = paginaAdmin({ api: '/api/prova', web: '/prova', feed: '/feed', avatar: '/avatar' });
const sorgente = await readFile(new URL('../src/admin.mjs', import.meta.url), 'utf8');

const receptionist = pagina.indexOf('<section data-scheda="Receptionist">');
const richieste = pagina.indexOf('<section data-scheda="Gestione richieste">');
const voce = pagina.indexOf('<section data-scheda="Voce">');
assert(receptionist >= 0 && richieste > receptionist && voce > richieste, 'Gestione richieste deve stare subito dopo Receptionist');

for (const testo of [
  'riconosce semanticamente',
  'Riconoscimento automatico',
  'Azione predefinita',
  'Aggiungi regola',
  'Indicatori del cliente',
  'Obiettivo',
  'Cosa non proporre',
  'Priorità',
]) assert(pagina.includes(testo), `testo/campo mancante: ${testo}`);

for (const valore of [
  'informazione', 'preventivo_file', 'assistenza_problema', 'richiamata', 'appuntamento', 'altro',
  'rispondi', 'raccogli_dati', 'proponi_appuntamento', 'offri_richiamata', 'non_proporre',
]) assert(pagina.includes(`value="${valore}"`), `opzione mancante: ${valore}`);

const attacco = '"><img src=x onerror=alert(1)>';
const html = htmlRegolaRichiesta({
  nome: attacco,
  indicatori: [attacco],
  obiettivo: attacco,
  nonProporre: attacco,
  intento: 'informazione',
  comportamento: 'rispondi',
  priorita: 7,
});
assert(!html.includes('<img'), 'il renderer non deve inserire HTML dai valori');
assert.equal((html.match(/&lt;img/g) || []).length, 4, 'ogni campo testuale dinamico deve essere escapato');

assert.match(sorgente, /function\s+leggiRegolaRichiesta\s*\(/, 'manca la raccolta dedicata della regola');
assert.match(sorgente, /function\s+riempiGestioneRichieste\s*\(/, 'manca il caricamento dedicato delle regole');
assert.match(sorgente, /function\s+leggiGestioneRichieste\s*\(/, 'manca la raccolta dedicata della sezione');
assert.match(sorgente, /o\.gestioneRichieste\s*=\s*leggiGestioneRichieste\(\)/, 'raccogli() non salva gestioneRichieste');
assert(pagina.includes("indicatori: q('indicatori').value.split('\\n')"), 'gli indicatori devono fare round-trip come elenco, uno per riga');
assert(!sorgente.match(/regola-richiesta[^\n]{0,120}conto|conto[^\n]{0,120}regola-richiesta/), 'le regole non devono riutilizzare la classe .conto');

// Lingue: una spunta per lingua e un solo saluto, scelto con i pulsanti (niente più "multilingua"/"solo tedesco").
for (const testo of ['id="lingueAttive"', 'id="linguaSaluto"', 'role="group"', 'role="radiogroup"', 'Lingua del saluto']) assert(pagina.includes(testo), `manca il controllo lingua: ${testo}`);
assert(!pagina.includes('data-k="lingue.multilingua"'), 'il vecchio multilingua non deve più stare nel pannello');
assert(!pagina.includes('data-k="lingue.tedesco"'), 'il vecchio "solo tedesco" non deve più stare nel pannello');
assert.match(sorgente, /function\s+riempiLingue\s*\(/, 'manca il caricamento delle lingue');
assert.match(sorgente, /function\s+raccogliLingue\s*\(/, 'manca la raccolta delle lingue');
assert.match(sorgente, /o\.lingue\s*=\s*\{\s*\.\.\.\(o\.lingue \|\| \{\}\), attive:/, 'raccogli() non salva le lingue attive');
assert.match(sorgente, /raccogliLingue\(o\)/, 'raccogli() non chiama raccogliLingue');
assert.match(sorgente, /if \(scelta !== 'it' && !attive\.includes\(scelta\)\) attive\.push\(scelta\)/, 'la lingua del saluto deve finire tra le attive');

console.log('OK admin Gestione richieste: rendering, raccolta ed escape XSS');
