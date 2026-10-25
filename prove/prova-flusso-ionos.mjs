// Test reale del modello configurato, senza registrare appuntamenti o inviare email.
import assert from 'node:assert/strict';
import { impostazioni } from '../src/impostazioni.mjs';
import { provaConversazione } from '../src/cervello.mjs';
import { istruzioni } from '../src/persona.mjs';
import { consensoPrenotazione, congedoCliente } from '../src/consenso.mjs';
const posti = '2026-10-27 (martedì): 09:00, 10:00\n2026-10-28 (mercoledì): 09:00';
const frasi = [
  'Buongiorno, vorrei prendere un appuntamento.',
  'Va bene martedì alle nove.',
  'Mi chiamo Paolo Rossi. Voglio incidere due targhe in legno spesso cinque millimetri. Porto io il legno, ho già il file pronto e mi servono per dicembre. La mia email è paolo@example.com.',
  'Sì, confermo tutti i dati del riepilogo.',
  'Non mi serve altro, grazie, arrivederci.',
];
const r = await provaConversazione(impostazioni().cervello.principale, istruzioni({ posti }), { posti, frasi });
console.log(JSON.stringify(r, null, 2));
assert.equal(r.turni.length, 5);
for (const t of r.turni) assert.ok(!t.errore, t.errore);
for (const t of r.turni.slice(0, 3)) assert.doesNotMatch(t.testo, /<<\s*(CONFERMA|FINE)/);
assert.match(r.turni[2].testo, /(?:conferm|le torna|giusto così|capito bene).+\?/i);
assert.match(r.turni[3].testo, /<<\s*CONFERMA\|Paolo Rossi\|2026-10-27\|09:00\|/);
assert.doesNotMatch(r.turni[3].testo, /<<\s*FINE/);
assert.equal(consensoPrenotazione(frasi[3], r.turni[2].testo, 'Paolo Rossi'), true);
assert.equal(congedoCliente(frasi[3], 4), false);
assert.match(r.turni[4].testo, /<<\s*FINE/);
assert.equal(congedoCliente(frasi[4], 5), true);
const configurati = impostazioni().receptionist.intercalare.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const primeTre = r.turni.slice(0, 3).map((x) => x.testo || '').join(' ').toLowerCase();
const usati = configurati.reduce((n, x) => n + (primeTre.match(new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 0);
assert.equal(usati, 1, `atteso un intercalare nei primi tre turni, trovati ${usati}`);
console.log('Flusso completo verificato: raccolta, riepilogo, consenso, registrazione, congedo.');
