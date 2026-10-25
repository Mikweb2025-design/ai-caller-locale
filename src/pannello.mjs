// Pannello di controllo: una pagina sola, da aprire sul telefono prima di girare il video.
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function paginaPannello({ messaggio = '', twilio, numero, web }) {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Centralino officina</title>
<style>
  :root { --sfondo:#f6f5f2; --testo:#1d1d1b; --tenue:#6b6a66; --oro:#c9a227; --bordo:#dedbd3; --carta:#fff; }
  @media (prefers-color-scheme: dark) { :root { --sfondo:#141413; --testo:#f1efe9; --tenue:#a19f98; --bordo:#33322f; --carta:#1e1e1c; } }
  * { box-sizing: border-box; }
  html { background:var(--sfondo); }
  body { margin:0; min-height:100vh; padding:24px 16px; font:16px/1.45 system-ui, sans-serif; background:var(--sfondo); color:var(--testo); }
  main { max-width:520px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  p.tenue { color:var(--tenue); margin:0 0 20px; }
  .numero { font-size:26px; font-weight:700; letter-spacing:.5px; margin:8px 0 24px; }
  form { margin:0 0 20px; }
  .scelta { display:grid; gap:12px; }
  button { width:100%; text-align:left; padding:14px 16px; border-radius:12px; border:2px solid var(--bordo); background:var(--carta); color:var(--testo); font:inherit; cursor:pointer; }
  button span { display:block; color:var(--tenue); font-size:14px; }
  button.attivo { border-color:var(--oro); box-shadow:0 0 0 3px color-mix(in srgb, var(--oro) 25%, transparent); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .msg { padding:12px 14px; border-radius:10px; background:color-mix(in srgb, var(--oro) 18%, var(--carta)); margin-bottom:16px; }
  label { display:block; font-weight:600; margin-bottom:6px; }
  input, select { width:100%; padding:12px; border-radius:10px; border:1px solid var(--bordo); background:var(--carta); color:var(--testo); font:inherit; margin-bottom:10px; }
  h2 { font-size:17px; margin:28px 0 10px; }
</style></head>
<body><main>
  <h1>Centralino Officina Marchetti</h1>
  <p class="tenue">Receptionist AI tutto locale: faster-whisper, Claude Code, Qwen3-TTS.</p>
  ${messaggio ? `<div class="msg">${esc(messaggio)}</div>` : ''}
  <div>Numero da chiamare:</div>
  <div class="numero">${esc(numero || 'numero non impostato')}</div>
  <p><a href="${esc(web)}">🎧 Prova dal browser (microfono e chat)</a></p>
  <h2>Fatti chiamare dal receptionist</h2>
  ${twilio ? `<form method="post">
    <label for="chiama">Il tuo numero</label>
    <input id="chiama" name="chiama" type="tel" placeholder="+39 3xx xxx xxxx" required>
    <button><strong>Chiamami ora</strong><span>Il receptionist ti chiama e parla per primo</span></button>
  </form>` : '<p class="tenue">Per farti chiamare serve la chiave API Twilio nel file .env del server.</p>'}
</main></body></html>`;
}
