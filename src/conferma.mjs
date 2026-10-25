// La pagina che apre il cliente dal link dell'email: "confermo" oppure "non posso venire".
// È volutamente piccola e senza JavaScript né segreto: la apro solo con id + token dell'appuntamento.
import { impostazioni } from './impostazioni.mjs';
import { temaCss, tagLogo } from './design.mjs';
import { giornoParlato } from './agenda.mjs';

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function pagina({ titolo, dentro }) {
  const { attivita } = impostazioni();
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titolo)} – ${esc(attivita.nome)}</title>
<style>
  ${temaCss(
    ':root { --sfondo:#f6f5f2; --testo:#1d1d1b; --tenue:#6b6a66; --accento:#2f6f5e; --bordo:#dedbd3; --carta:#fff; --rosso:#b03a2e; }',
    ':root { --sfondo:#141413; --testo:#f1efe9; --tenue:#a19f98; --accento:#5fb39b; --bordo:#33322f; --carta:#1e1e1c; --rosso:#b03a2e; }',
    ['accento'],
  )}
  * { box-sizing:border-box; }
  html, body { background:var(--sfondo); }
  body { margin:0; min-height:100vh; font:16px/1.5 system-ui, sans-serif; color:var(--testo); display:flex; justify-content:center; align-items:center; padding:20px; }
  main { width:100%; max-width:520px; background:var(--carta); border:1px solid var(--bordo); border-radius:20px; padding:26px 22px; text-align:center; }
  .logo { height:58px; max-width:220px; object-fit:contain; margin-bottom:12px; }
  h1 { font-size:22px; margin:0 0 6px; letter-spacing:-.01em; }
  p { margin:10px 0; }
  .quando { font-size:19px; font-weight:600; margin:16px 0; }
  .tenue { color:var(--tenue); font-size:14px; }
  .bottoni { display:flex; gap:10px; flex-wrap:wrap; justify-content:center; margin-top:20px; }
  a.scelta { display:inline-block; padding:13px 24px; border-radius:999px; text-decoration:none; font-weight:600; color:#fff; background:var(--accento); }
  a.scelta.no { background:transparent; color:var(--rosso); border:1px solid var(--rosso); }
  .esito { font-size:15px; }
</style></head>
<body><main>
  ${tagLogo()}
  ${dentro}
</main></body></html>`;
}

// La domanda: confermi l'appuntamento?
export function paginaDomandaConferma({ appuntamento: a, si, no }) {
  const { attivita } = impostazioni();
  return pagina({
    titolo: 'Confermi l’appuntamento?',
    dentro: `<h1>Confermi l’appuntamento?</h1>
  <p>Ciao ${esc(a.nome.split(' ')[0] || '')}, manca poco:</p>
  <p class="quando">${esc(giornoParlato(a.giorno))} alle ${esc(a.ora)}</p>
  ${a.dettagli ? `<p class="tenue">${esc(a.dettagli)}</p>` : ''}
  ${attivita.indirizzo ? `<p class="tenue">${esc(attivita.indirizzo)}</p>` : ''}
  <div class="bottoni">
    <a class="scelta" href="${esc(si)}">Sì, confermo</a>
    <a class="scelta no" href="${esc(no)}">Non posso venire</a>
  </div>`,
  });
}

const MESSAGGI = {
  confermata: { titolo: 'Grazie, appuntamento confermato', testo: 'Ci vediamo presto. Se qualcosa cambia ci chiami pure.' },
  'non puo': { titolo: 'Grazie per avercelo detto', testo: 'La richiameremo per trovare insieme un altro momento.' },
  annullato: { titolo: 'Questo appuntamento è annullato', testo: 'Se le serve un nuovo appuntamento ci chiami pure.' },
  link: { titolo: 'Questo link non è più valido', testo: 'Ci chiami pure: sistemiamo l’appuntamento in due minuti.' },
  'non trovato': { titolo: 'Appuntamento non trovato', testo: 'Ci chiami pure: sistemiamo l’appuntamento in due minuti.' },
};

// L'esito dopo il clic (o quando il link è vecchio/sbagliato).
export function paginaEsitoConferma({ appuntamento: a, esito }) {
  const { attivita } = impostazioni();
  const m = MESSAGGI[esito] || MESSAGGI.link;
  const dettagli = a && (esito === 'confermata' || esito === 'non puo')
    ? `<p class="quando">${esc(giornoParlato(a.giorno))} alle ${esc(a.ora)}</p>${a.dettagli ? `<p class="tenue">${esc(a.dettagli)}</p>` : ''}`
    : '';
  return pagina({
    titolo: m.titolo,
    dentro: `<h1>${esc(m.titolo)}</h1>
  ${dettagli}
  <p class="esito">${esc(m.testo)}</p>
  ${attivita.telefono ? `<p class="tenue">${esc(attivita.nome)} · ${esc(attivita.telefono)}</p>` : `<p class="tenue">${esc(attivita.nome)}</p>`}`,
  });
}
