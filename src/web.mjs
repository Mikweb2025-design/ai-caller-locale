// Chiamata dal browser: la pagina parla con il server lo stesso protocollo di Twilio Media
// Streams (μ-law 8 kHz, mark, clear), quindi passa per la stessa identica pipeline del telefono.
// In più riceve la trascrizione e si può scrivere al receptionist come in una chat.
import { impostazioni } from './impostazioni.mjs';

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function paginaWeb({ ws, admin }) {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chiama il receptionist</title>
<style>
  :root { --sfondo:#f6f5f2; --testo:#1d1d1b; --tenue:#6b6a66; --oro:#c9a227; --bordo:#dedbd3; --carta:#fff; --rosso:#c0392b; --verde:#2e8b57; }
  @media (prefers-color-scheme: dark) { :root { --sfondo:#141413; --testo:#f1efe9; --tenue:#a19f98; --bordo:#33322f; --carta:#1e1e1c; } }
  * { box-sizing:border-box; }
  html, body { background:var(--sfondo); }
  body { margin:0; min-height:100vh; font:16px/1.45 system-ui, sans-serif; color:var(--testo); display:flex; justify-content:center; }
  main { width:100%; max-width:560px; padding:24px 16px; display:flex; flex-direction:column; gap:16px; min-height:100vh; }
  h1 { font-size:21px; margin:0; }
  .tenue { color:var(--tenue); font-size:14px; margin:0; }
  .barra { display:flex; gap:10px; align-items:center; }
  button { padding:12px 18px; border-radius:999px; border:0; font:inherit; font-weight:600; cursor:pointer; color:#fff; background:var(--verde); }
  button.chiudi { background:var(--rosso); }
  button.muto { background:var(--carta); color:var(--testo); border:1px solid var(--bordo); }
  button:disabled { opacity:.4; cursor:default; }
  .stato { font-size:14px; color:var(--tenue); flex:1; text-align:right; }
  .livello { height:6px; border-radius:3px; background:var(--bordo); overflow:hidden; }
  .livello div { height:100%; width:0; background:var(--oro); transition:width .08s; }
  #chat { flex:1; display:flex; flex-direction:column; gap:8px; overflow-y:auto; padding:4px 0; }
  .msg { max-width:85%; padding:9px 13px; border-radius:16px; background:var(--carta); border:1px solid var(--bordo); white-space:pre-wrap; }
  .msg.cliente { align-self:flex-end; background:color-mix(in srgb, var(--oro) 22%, var(--carta)); border-color:transparent; }
  .msg small { display:block; font-size:12px; color:var(--tenue); }
  form { display:flex; gap:8px; }
  input { flex:1; min-width:0; padding:12px; border-radius:999px; border:1px solid var(--bordo); background:var(--carta); color:var(--testo); font:inherit; }
</style></head>
<body><main>
  <div>
    <h1>📞 ${esc(impostazioni().attivita.nome)}</h1>
    <p class="tenue">Chiamata di prova dal browser. Meglio con le cuffie: così il receptionist non sente sé stesso. <a href="${esc(admin)}">⚙️ Impostazioni</a></p>
  </div>
  <div class="barra">
    <button id="chiama">Chiama</button>
    <button id="muto" class="muto" disabled>Microfono acceso</button>
    <span class="stato" id="stato">pronto</span>
  </div>
  <div class="livello"><div id="livello"></div></div>
  <div id="chat"></div>
  <form id="scrivi"><input id="frase" placeholder="…oppure scrivi al receptionist" autocomplete="off" disabled><button id="invia" disabled>Invia</button></form>
</main>
<script>
const WS_PATH = ${JSON.stringify(ws)};
const $ = (id) => document.getElementById(id);
let ws, ctx, sorgente, nodo, flusso, prossimo = 0, attivi = [], marche = [], muto = false;
const streamSid = 'MZweb' + Math.random().toString(16).slice(2);

// μ-law G.711
const DEC = new Float32Array(256);
for (let i = 0; i < 256; i++) { const u = ~i & 255; const t = (((u & 15) << 3) + 132) << ((u & 112) >> 4); DEC[i] = (u & 128 ? 132 - t : t - 132) / 32768; }
function enc(f) { let s = Math.max(-1, Math.min(1, f)) * 32767 | 0; const sg = s < 0 ? 128 : 0; if (s < 0) s = -s; s = Math.min(s, 32635) + 132; let e = 7; for (let m = 16384; (s & m) === 0 && e > 0; m >>= 1) e--; return ~(sg | (e << 4) | ((s >> (e + 3)) & 15)) & 255; }
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };

function messaggio(chi, testo) {
  const d = document.createElement('div');
  d.className = 'msg ' + chi;
  d.innerHTML = '<small>' + (chi === 'cliente' ? 'tu' : 'receptionist') + '</small>';
  d.append(testo);
  $('chat').append(d);
  $('chat').scrollTop = 1e9;
}
const stato = (s) => { $('stato').textContent = s; };
const invia = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));

function suona(payload) {
  const raw = atob(payload), n = raw.length;
  const buf = ctx.createBuffer(1, n, 8000), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = DEC[raw.charCodeAt(i)];
  const s = ctx.createBufferSource();
  s.buffer = buf; s.connect(ctx.destination);
  prossimo = Math.max(prossimo, ctx.currentTime + 0.03);
  s.start(prossimo);
  prossimo += buf.duration;
  attivi.push(s);
  s.onended = () => { attivi = attivi.filter((x) => x !== s); };
  stato('parla il receptionist');
}

function marca(nome) {
  // si rimanda indietro quando l'audio arrivato prima è stato davvero ascoltato, come fa Twilio
  const ms = Math.max(0, (prossimo - ctx.currentTime) * 1000);
  const t = setTimeout(() => { marche = marche.filter((m) => m.t !== t); invia({ event: 'mark', streamSid, mark: { name: nome } }); if (!marche.length) stato('in ascolto'); }, ms);
  marche.push({ t, nome });
}

function svuota() {
  for (const s of attivi) try { s.stop(); } catch {}
  attivi = []; prossimo = 0;
  for (const m of marche) { clearTimeout(m.t); invia({ event: 'mark', streamSid, mark: { name: m.nome } }); }
  marche = [];
  stato('in ascolto');
}

async function chiama() {
  $('chiama').disabled = true;
  stato('collegamento…');
  ctx = new AudioContext({ sampleRate: 8000 });
  let senzaMicrofono = false;
  try {
    flusso = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (e) {
    // senza microfono la chiamata va lo stesso: si ascolta e si scrive in chat
    senzaMicrofono = true;
    flusso = new MediaStream([ctx.createMediaStreamDestination().stream.getAudioTracks()[0]]);
  }
  const codice = \`class Cattura extends AudioWorkletProcessor {
    constructor() { super(); this.b = new Float32Array(160); this.i = 0; }
    process(ing) { const c = ing[0][0]; if (c) for (const v of c) { this.b[this.i++] = v; if (this.i === 160) { this.port.postMessage(this.b.slice()); this.i = 0; } } return true; }
  }
  registerProcessor('cattura', Cattura);\`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([codice], { type: 'application/javascript' })));
  sorgente = ctx.createMediaStreamSource(flusso);
  nodo = new AudioWorkletNode(ctx, 'cattura');
  sorgente.connect(nodo);

  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + WS_PATH);
  let tick = 0;
  ws.onopen = () => {
    invia({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    invia({ event: 'start', streamSid, start: { streamSid, callSid: 'CAweb' + Date.now(), customParameters: { from: 'browser' }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } });
    nodo.port.onmessage = ({ data }) => {
      let e = 0; const u = new Uint8Array(160);
      for (let i = 0; i < 160; i++) { const v = muto ? 0 : data[i]; u[i] = enc(v); e += v * v; }
      $('livello').style.width = Math.min(100, Math.sqrt(e / 160) * 400) + '%';
      invia({ event: 'media', streamSid, media: { track: 'inbound', chunk: String(tick), timestamp: String(tick++ * 20), payload: b64(u) } });
    };
    $('chiama').textContent = 'Riaggancia'; $('chiama').className = 'chiudi'; $('chiama').disabled = false;
    $('muto').disabled = $('frase').disabled = $('invia').disabled = false;
    stato(senzaMicrofono ? 'senza microfono: scrivi in chat' : 'squilla…');
  };
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.event === 'media') suona(m.media.payload);
    else if (m.event === 'mark') marca(m.mark.name);
    else if (m.event === 'clear') svuota();
    else if (m.event === 'testo') messaggio(m.chi, m.testo);
  };
  ws.onclose = () => {
    // lascia finire il saluto finale prima di spegnere tutto
    setTimeout(chiudi, Math.max(0, (prossimo - (ctx?.currentTime || 0)) * 1000) + 200);
    stato('chiamata terminata');
  };
}

function chiudi() {
  try { invia({ event: 'stop', streamSid }); ws?.close(); } catch {}
  nodo?.disconnect(); sorgente?.disconnect(); flusso?.getTracks().forEach((t) => t.stop()); ctx?.close();
  ws = ctx = null; prossimo = 0; attivi = []; marche.forEach((m) => clearTimeout(m.t)); marche = [];
  $('chiama').textContent = 'Chiama'; $('chiama').className = ''; $('chiama').disabled = false;
  $('muto').disabled = $('frase').disabled = $('invia').disabled = true;
  $('livello').style.width = '0';
  stato('chiamata terminata');
}

$('chiama').onclick = () => (ws ? chiudi() : chiama());
$('muto').onclick = () => { muto = !muto; $('muto').textContent = muto ? 'Microfono spento' : 'Microfono acceso'; };
$('scrivi').onsubmit = (e) => { e.preventDefault(); const t = $('frase').value.trim(); if (!t) return; invia({ event: 'testo', testo: t }); $('frase').value = ''; };
</script>
</body></html>`;
}
