// Prova reale del modello configurato: verifica a colpo d'occhio che Maria colga
// tipi diversi di umorismo, senza basarsi sulla sola parola "aperitivo".
import { impostazioni } from '../src/impostazioni.mjs';
import { provaConversazione } from '../src/cervello.mjs';
import { istruzioni } from '../src/persona.mjs';

const scenari = [
  ['formale e asciutto', 'Mi permetta una domanda: oltre al laser operate anche miracoli, per caso?'],
  ['informale e giocoso', 'Oh, se viene bene ti pago in caffè e siamo pari, affare fatto?'],
  ['autoironico', 'Con i file sono un disastro, riesco a litigare pure con il PDF.'],
  ['invito personale', 'Dopo il preventivo vieni anche tu a fare un aperitivo con me, eh?'],
];

for (const [tipo, frase] of scenari) {
  const risultato = await provaConversazione(
    impostazioni().cervello.principale,
    istruzioni(),
    { frasi: [frase] },
  );
  const turno = risultato.turni[0];
  if (turno.errore) throw new Error(turno.errore);
  console.log(`[${tipo}]\n👤 ${turno.cliente}\n🤖 ${turno.testo}\n`);
}
