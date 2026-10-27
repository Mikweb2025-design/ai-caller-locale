import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Copia isolata delle impostazioni: il test non tocca la configurazione vera.
const cartella = mkdtempSync(join(tmpdir(), 'maria-multilingua-'));
const produzione = fileURLToPath(new URL('../dati/impostazioni.json', import.meta.url));
copyFileSync(produzione, join(cartella, 'impostazioni.json'));
process.env.DATI_DIR = cartella;

try {
  const { impostazioni, salvaImpostazioni, lingueAttive } = await import('../src/impostazioni.mjs');
  const { istruzioni, salutoSegmenti } = await import('../src/persona.mjs');
  const { rilevaLingua, linguaDetta, nonItaliano } = await import('../src/chiamata.mjs');
  const { consensoPrenotazione, consensoRichiamo, congedoCliente } = await import('../src/consenso.mjs');

  // Spento: solo italiano.
  salvaImpostazioni({ lingue: { attive: ['it'], predefinita: 'it' } });
  assert.deepEqual([...lingueAttive()], ['it']);
  assert.equal(salutoSegmenti().length, 1);
  let prompt = istruzioni();
  assert.match(prompt, /Parla sempre e solo in italiano/i);
  assert.doesNotMatch(prompt, /In inglese:/i);

  // Solo tedesco, come prima.
  salvaImpostazioni({ lingue: { attive: ['it', 'de'], predefinita: 'it' } });
  assert.deepEqual([...lingueAttive()].sort(), ['de', 'it']);
  assert.deepEqual(salutoSegmenti().map((s) => s.lingua), ['it']);
  prompt = istruzioni();
  assert.match(prompt, /Parli italiano e tedesco/i);

  // Le lingue si accendono una per una: solo spagnolo, per esempio.
  salvaImpostazioni({ lingue: { attive: ['it', 'es'], predefinita: 'it' } });
  assert.deepEqual([...lingueAttive()].sort(), ['es', 'it']);
  assert.match(istruzioni(), /Parli italiano e spagnolo/i);
  assert.equal(linguaDetta('Good morning, I would like to book an appointment', 'it'), null);

  // Le vecchie impostazioni (solo tedesco, multilingua) valgono ancora.
  assert.deepEqual([...lingueAttive({ tedesco: true })].sort(), ['de', 'it']);
  assert.deepEqual([...lingueAttive({ multilingua: true })].sort(), ['de', 'en', 'es', 'fr', 'it']);

  // Lingua di default scelta dall'admin: il saluto parte in quella lingua.
  salvaImpostazioni({ lingue: { attive: ['it', 'de'], predefinita: 'de' } });
  assert.deepEqual(salutoSegmenti().map((s) => s.lingua), ['de']);
  assert.match(salutoSegmenti()[0].testo, /Guten Tag/);

  // Multilingua: italiano, tedesco, inglese, spagnolo e francese.
  salvaImpostazioni({ lingue: { attive: ['it', 'en', 'de', 'es', 'fr'], predefinita: 'it' } });
  assert.deepEqual([...lingueAttive()].sort(), ['de', 'en', 'es', 'fr', 'it']);
  assert.deepEqual(salutoSegmenti().map((s) => s.lingua), ['it']);
  salvaImpostazioni({ lingue: { predefinita: 'en' } });
  assert.deepEqual(salutoSegmenti().map((s) => s.lingua), ['en']);
  assert.match(salutoSegmenti()[0].testo, /this is/i);
  salvaImpostazioni({ lingue: { predefinita: 'fr' } });
  assert.match(salutoSegmenti()[0].testo, /Bonjour/);
  salvaImpostazioni({ lingue: { predefinita: 'es' } });
  assert.match(salutoSegmenti()[0].testo, /Buenos días/);
  salvaImpostazioni({ lingue: { predefinita: 'it' } });
  prompt = istruzioni();
  assert.match(prompt, /Parli italiano, inglese, tedesco, spagnolo e francese/i);
  for (const lingua of ['In inglese:', 'In tedesco:', 'In spagnolo:', 'In francese:']) assert.ok(prompt.includes(lingua), lingua);

  // Una lingua predefinita non attiva non si usa: resta l'italiano.
  salvaImpostazioni({ lingue: { attive: ['it'], predefinita: 'fr' } });
  assert.equal(salutoSegmenti()[0].lingua, 'it');
  salvaImpostazioni({ lingue: { attive: ['it', 'en', 'de', 'es', 'fr'], predefinita: 'it' } });
  assert.deepEqual([...lingueAttive()].sort(), ['de', 'en', 'es', 'fr', 'it']);

  // Riconoscimento della lingua frase per frase.
  const attive = lingueAttive();
  const casi = [
    ['Buongiorno, vorrei un appuntamento per domani mattina', 'it'],
    ['Guten Tag, ich möchte einen Termin für morgen', 'de'],
    ['Good morning, I would like to book an appointment for tomorrow', 'en'],
    ['Hola, quiero una cita para mañana por la mañana', 'es'],
    ['Bonjour, je voudrais un rendez-vous pour demain matin', 'fr'],
    ['Sì, va bene, grazie', 'it'],
  ];
  for (const [frase, attesa] of casi) assert.equal(rilevaLingua(frase, 'it', attive), attesa, frase);

  // La lingua di default della telefonata segue quella detta dal cliente, ma solo con un
  // segnale netto: "ok", un nome o un numero non fanno cambiare lingua.
  assert.equal(linguaDetta('Hola, quiero una cita para mañana', 'it', attive), 'es');
  assert.equal(linguaDetta('Good morning, I would like to book an appointment', 'it', attive), 'en');
  assert.equal(linguaDetta('Bonjour, je voudrais un rendez-vous', 'it', attive), 'fr');
  assert.equal(linguaDetta('Guten Tag, ich möchte einen Termin', 'it', attive), 'de');
  assert.equal(linguaDetta('Sì, va bene, grazie', 'en', attive), 'it');
  assert.equal(linguaDetta('ok', 'en', attive), null);
  assert.equal(linguaDetta('Marco Rossi', 'en', attive), null);

  // Con il multilingua spento non si cambia lingua: resta quella scelta dall'admin.
  salvaImpostazioni({ lingue: { attive: ['it'] } });
  assert.equal(linguaDetta('Good morning, I would like to book an appointment', 'it'), null);
  salvaImpostazioni({ lingue: { attive: ['it', 'en', 'de', 'es', 'fr'] } });

  // Le frasi dei clienti in inglese non sono più scartate come rumore, con il multilingua attivo.
  assert.equal(nonItaliano('yes, that is right'), false);
  assert.deepEqual([...lingueAttive()].sort(), ['de', 'en', 'es', 'fr', 'it']);

  // Consenso e congedo funzionano anche nelle altre lingue.
  const riepilogoEn = 'Marco Rossi, Tuesday at nine, two wooden signs. Does that work for you?';
  assert.equal(consensoPrenotazione('Yes, that is correct.', riepilogoEn, 'Marco Rossi'), true);
  assert.equal(consensoPrenotazione('Sí, es correcto.', 'Marco Rossi, martes a las nueve, dos placas. ¿Le viene bien?', 'Marco Rossi'), true);
  assert.equal(consensoPrenotazione("Oui, c'est correct.", 'Marco Rossi, mardi à neuf heures, deux plaques. Ça vous convient ?', 'Marco Rossi'), true);
  assert.equal(consensoRichiamo('Yes, please', 'Can a colleague call you back?'), true);
  assert.equal(consensoRichiamo('Oui, merci', 'Je demande à un collègue de vous rappeler ?'), true);
  assert.equal(congedoCliente('Goodbye, thank you.', 4), true);
  assert.equal(congedoCliente('Au revoir, merci.', 4), true);
  assert.equal(congedoCliente('Adiós, gracias.', 4), true);

  console.log('Multilingua verificato: saluti, istruzioni, riconoscimento lingua, consenso e congedo.');
} finally {
  rmSync(cartella, { recursive: true, force: true });
}
