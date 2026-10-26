// Chiamata dal browser: la pagina parla con il server lo stesso protocollo di Twilio Media
// Streams (μ-law 8 kHz, mark, clear), quindi passa per la stessa identica pipeline del telefono.
// In più riceve la trascrizione e si può scrivere al receptionist come in una chat.
import { impostazioni } from './impostazioni.mjs';
import { temaCss, tagLogo } from './design.mjs';
import { codiceCatturaBrowser } from './audio-browser.mjs';

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function paginaWeb({ ws, admin, avatar }) {
  const dati = impostazioni();
  const attivita = dati.attivita;
  const receptionist = dati.receptionist;
  const nomeReceptionist = receptionist.nome || 'il receptionist';
  const nomeVisuale = nomeReceptionist.charAt(0).toUpperCase() + nomeReceptionist.slice(1);
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b1214"><meta name="description" content="Parla subito con il receptionist di ${esc(attivita.nome)}: informazioni e appuntamenti, direttamente dal browser.">
<title>${esc(attivita.nome)} · Parla con ${esc(nomeVisuale)}</title>
<style>
  ${temaCss(
    ':root { --sfondo:#edf3f1; --testo:#0a1819; --tenue:#587071; --oro:#0bbbad; --bordo:#bed0cc; --carta:#f9fcfb; --rosso:#df493e; --verde:#087f76; --profondo:#0b1618; --ombra:0 28px 80px rgba(8,32,33,.14); }',
    ':root { --sfondo:#081012; --testo:#effcf9; --tenue:#92aaa7; --oro:#15d7c8; --bordo:#24403e; --carta:#101c1e; --rosso:#ff6256; --verde:#12bbae; --profondo:#050a0b; --ombra:0 28px 90px rgba(0,0,0,.42); }',
    ['oro', 'verde'],
  )}
  * { box-sizing:border-box; }
  html { background:var(--sfondo); scroll-behavior:smooth; }
  body { margin:0; min-height:100vh; overflow-x:hidden; color:var(--testo); font:16px/1.55 "Avenir Next", "Trebuchet MS", sans-serif; background:var(--sfondo); }
  body::before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.32; background-image:linear-gradient(color-mix(in srgb, var(--bordo) 45%, transparent) 1px, transparent 1px),linear-gradient(90deg,color-mix(in srgb, var(--bordo) 45%, transparent) 1px,transparent 1px); background-size:42px 42px; mask-image:linear-gradient(to bottom,#000,transparent 72%); }
  body::after { content:""; position:fixed; width:46vw; height:46vw; min-width:360px; min-height:360px; right:-16vw; top:-18vw; border:1px solid color-mix(in srgb,var(--oro) 32%,transparent); border-radius:50%; box-shadow:0 0 0 8vw color-mix(in srgb,var(--oro) 4%,transparent),0 0 0 16vw color-mix(in srgb,var(--oro) 3%,transparent); pointer-events:none; }
  button,input { font:inherit; }
  button { cursor:pointer; }
  button:focus-visible,input:focus-visible { outline:3px solid color-mix(in srgb,var(--oro) 45%,transparent); outline-offset:3px; }
  button:disabled { opacity:.44; cursor:default; }
  .site { position:relative; width:min(1180px,calc(100% - 40px)); margin:auto; }
  .topbar { min-height:96px; display:flex; align-items:center; justify-content:space-between; gap:20px; border-bottom:1px solid var(--bordo); }
  .brand { display:flex; align-items:center; gap:13px; min-width:0; font-weight:700; letter-spacing:-.02em; }
  .logo { width:48px; height:48px; object-fit:contain; border-radius:13px; }
  .brand-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .presenza { display:flex; align-items:center; gap:9px; color:var(--tenue); font:700 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.09em; text-transform:uppercase; }
  .presenza i { width:9px; height:9px; border-radius:50%; background:var(--oro); box-shadow:0 0 0 5px color-mix(in srgb,var(--oro) 16%,transparent); animation:respiro 2.1s ease-in-out infinite; }
  main { padding:70px 0 36px; }
  .hero { display:grid; grid-template-columns:minmax(0,1.04fr) minmax(400px,.96fr); gap:clamp(40px,7vw,100px); align-items:center; }
  .eyebrow { display:flex; align-items:center; gap:12px; margin:0 0 25px; color:var(--verde); font:800 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.13em; text-transform:uppercase; }
  .eyebrow::before { content:""; width:38px; height:2px; background:var(--oro); }
  h1 { margin:0; max-width:680px; font:500 clamp(50px,7vw,92px)/.94 Georgia,"Times New Roman",serif; letter-spacing:-.065em; }
  h1 em { color:var(--verde); font-weight:500; }
  .intro { max-width:590px; margin:28px 0 0; color:var(--tenue); font-size:clamp(18px,2vw,22px); line-height:1.48; }
  .intro strong { color:var(--testo); font-weight:700; }
  .vantaggi { display:flex; flex-wrap:wrap; gap:10px 24px; padding:0; margin:34px 0 0; list-style:none; color:var(--testo); font-size:14px; font-weight:650; }
  .vantaggi li { display:flex; align-items:center; gap:8px; }
  .vantaggi li::before { content:"✓"; display:grid; place-items:center; width:20px; height:20px; border:1px solid color-mix(in srgb,var(--oro) 68%,var(--bordo)); border-radius:50%; color:var(--verde); font-size:12px; }
  .nota { margin:23px 0 0; color:var(--tenue); font-size:13px; }
  .console { position:relative; isolation:isolate; min-height:650px; display:flex; flex-direction:column; border:1px solid color-mix(in srgb,var(--bordo) 86%,transparent); border-radius:30px; overflow:hidden; background:color-mix(in srgb,var(--carta) 92%,transparent); box-shadow:var(--ombra); backdrop-filter:blur(16px); }
  .console::before { content:""; position:absolute; z-index:-1; width:280px; height:280px; left:50%; top:80px; translate:-50% 0; border-radius:50%; background:radial-gradient(circle,color-mix(in srgb,var(--oro) 16%,transparent),transparent 66%); }
  .console-head { display:flex; justify-content:space-between; align-items:center; padding:19px 22px; border-bottom:1px solid var(--bordo); color:var(--tenue); font:700 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; text-transform:uppercase; }
  .segnale { display:flex; gap:4px; align-items:flex-end; height:12px; }
  .segnale i { display:block; width:3px; border-radius:2px; background:var(--oro); }
  .segnale i:nth-child(1){height:4px}.segnale i:nth-child(2){height:7px}.segnale i:nth-child(3){height:10px}.segnale i:nth-child(4){height:12px}
  .call-stage { display:grid; justify-items:center; padding:30px 24px 22px; }
  .avatar { position:relative; display:grid; place-items:center; width:112px; height:112px; margin-bottom:18px; border:3px solid color-mix(in srgb,var(--oro) 72%,#fff); border-radius:50%; color:var(--profondo); background:var(--oro); font:500 42px/1 Georgia,serif; box-shadow:0 18px 42px color-mix(in srgb,var(--oro) 28%,transparent); }
  .avatar span { grid-area:1/1; }
  .avatar img { position:relative; z-index:1; grid-area:1/1; width:100%; height:100%; border-radius:50%; object-fit:cover; object-position:center 34%; }
  .avatar::before,.avatar::after { content:""; position:absolute; inset:-11px; border:1px solid color-mix(in srgb,var(--oro) 36%,transparent); border-radius:50%; opacity:0; }
  .avatar::after { inset:-24px; }
  .chiamata-attiva .avatar::before,.chiamata-attiva .avatar::after { animation:onda 2.2s ease-out infinite; }
  .chiamata-attiva .avatar::after { animation-delay:1.1s; }
  .nome-operatore { margin:0; font:500 25px/1.15 Georgia,serif; }
  .ruolo-operatore { margin:7px 0 0; color:var(--tenue); font-size:13px; }
  .stato { min-height:22px; margin:13px 0 17px; color:var(--verde); font:800 11px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; text-transform:uppercase; }
  .stato::before { content:"•"; margin-right:7px; }
  .barra { width:100%; display:flex; justify-content:center; flex-wrap:wrap; gap:10px; }
  .barra button { min-height:48px; padding:0 20px; border:0; border-radius:14px; font-weight:800; transition:translate .18s,box-shadow .18s,background .18s; }
  .barra button:not(:disabled):hover { translate:0 -2px; }
  #chiama { min-width:194px; color:var(--profondo); background:var(--oro); box-shadow:0 12px 30px color-mix(in srgb,var(--oro) 24%,transparent); }
  #chiama.chiudi { color:#fff; background:var(--rosso); box-shadow:0 12px 30px color-mix(in srgb,var(--rosso) 22%,transparent); }
  button.muto { color:var(--testo); background:transparent; border:1px solid var(--bordo); }
  .meter-wrap { width:100%; max-width:300px; display:flex; align-items:center; gap:10px; margin-top:15px; color:var(--tenue); font:700 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace; text-transform:uppercase; }
  .livello { flex:1; height:4px; border-radius:4px; background:var(--bordo); overflow:hidden; }
  .livello div { height:100%; width:0; border-radius:inherit; background:var(--oro); transition:width .08s; }
  .conversation { flex:1; min-height:240px; display:flex; flex-direction:column; border-top:1px solid var(--bordo); background:color-mix(in srgb,var(--sfondo) 38%,transparent); }
  #chat { flex:1; max-height:280px; min-height:180px; display:flex; flex-direction:column; gap:10px; overflow-y:auto; padding:20px; scrollbar-width:thin; }
  .vuoto { margin:auto; max-width:260px; color:var(--tenue); text-align:center; font-size:13px; }
  .vuoto b { display:block; margin-bottom:5px; color:var(--testo); font:500 18px/1.2 Georgia,serif; }
  .msg { max-width:88%; padding:11px 14px; border:1px solid var(--bordo); border-radius:16px 16px 16px 4px; background:var(--carta); white-space:pre-wrap; font-size:14px; animation:entra .25s ease both; }
  .msg.cliente { align-self:flex-end; border-color:transparent; border-radius:16px 16px 4px 16px; background:color-mix(in srgb,var(--oro) 18%,var(--carta)); }
  .msg small { display:block; margin-bottom:3px; color:var(--tenue); font:700 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.11em; text-transform:uppercase; }
  form { display:flex; gap:8px; padding:13px; border-top:1px solid var(--bordo); background:var(--carta); }
  input { flex:1; min-width:0; padding:12px 14px; border:1px solid var(--bordo); border-radius:12px; color:var(--testo); background:var(--sfondo); }
  #invia { width:48px; border:0; border-radius:12px; color:var(--profondo); background:var(--oro); font-size:0; }
  #invia::before { content:"→"; font-size:22px; }
  .come-funziona { display:grid; grid-template-columns:repeat(3,1fr); margin-top:80px; border-top:1px solid var(--bordo); border-bottom:1px solid var(--bordo); }
  .passo { min-height:150px; padding:26px; border-right:1px solid var(--bordo); }
  .passo:last-child { border:0; }
  .passo span { color:var(--verde); font:800 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; }
  .passo h2 { margin:30px 0 7px; font:500 20px/1.15 Georgia,serif; }
  .passo p { margin:0; color:var(--tenue); font-size:13px; }
  footer { display:flex; justify-content:space-between; gap:20px; padding:26px 0 0; color:var(--tenue); font-size:12px; }
  @keyframes respiro { 50% { box-shadow:0 0 0 8px color-mix(in srgb,var(--oro) 5%,transparent); } }
  @keyframes onda { 0% { opacity:.75; scale:.9; } 100% { opacity:0; scale:1.22; } }
  @keyframes entra { from { opacity:0; translate:0 6px; } }
  @media (max-width:850px) { .site { width:min(100% - 28px,620px); } .topbar{min-height:78px}.hero{grid-template-columns:1fr}.hero-copy{text-align:center}.eyebrow{justify-content:center}.intro{margin-inline:auto}.vantaggi{justify-content:center}.console{min-height:610px}.come-funziona{margin-top:55px}.passo{padding:22px 16px} }
  @media (max-width:560px) { main{padding-top:42px}h1{font-size:50px}.presenza{font-size:10px}.brand-name{max-width:150px}.console{border-radius:23px}.come-funziona{grid-template-columns:1fr}.passo{min-height:auto;border-right:0;border-bottom:1px solid var(--bordo)}.passo h2{margin-top:16px}.barra{display:grid;grid-template-columns:1fr 1fr}.barra button{padding-inline:12px}#chiama{min-width:0}footer{display:block;text-align:center}footer span{display:block}footer span+span{margin-top:6px}.nota{line-height:1.5} }
  @media (prefers-reduced-motion:reduce) { *,*::before,*::after { animation:none!important; transition:none!important; scroll-behavior:auto!important; } }
</style></head>
<body><div class="site">
  <header class="topbar">
    <div class="brand">${tagLogo()}<span class="brand-name">${esc(attivita.nome)}</span></div>
    <div class="presenza"><i></i>Receptionist online</div>
  </header>
  <main>
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Una linea diretta, senza attese</p>
        <h1>Il tuo progetto<br><em>inizia da qui.</em></h1>
        <p class="intro">Parla subito con <strong>${esc(nomeVisuale)}</strong>, il receptionist di ${esc(attivita.nome)}. Ti ascolta, risponde alle domande e trova il momento giusto per incontrarci.</p>
        <ul class="vantaggi"><li>Informazioni immediate</li><li>Appuntamenti in tempo reale</li><li>Voce oppure chat</li></ul>
        <p class="nota">La chiamata parte dal browser. Per un audio più nitido, usa le cuffie.</p>
      </div>
      <section class="console" aria-label="Chiamata con il receptionist">
        <div class="console-head"><span>Linea digitale / ${esc(attivita.nome)}</span><span class="segnale" aria-label="segnale disponibile"><i></i><i></i><i></i><i></i></span></div>
        <div class="call-stage">
          <div class="avatar"><span aria-hidden="true">${esc(nomeVisuale.slice(0,1))}</span><img src="${esc(avatar)}" alt="Foto di ${esc(nomeVisuale)}" onerror="this.remove()"></div>
          <h2 class="nome-operatore">${esc(nomeVisuale)}</h2>
          <p class="ruolo-operatore">Receptionist · ${esc(attivita.nome)}</p>
          <div class="stato" id="stato" role="status" aria-live="polite">pronto a rispondere</div>
          <div class="barra">
            <button id="chiama" type="button">Inizia la chiamata</button>
            <button id="muto" class="muto" type="button" disabled>Microfono acceso</button>
          </div>
          <div class="meter-wrap"><span>voce</span><div class="livello"><div id="livello"></div></div></div>
        </div>
        <div class="conversation">
          <div id="chat" aria-live="polite"><div class="vuoto" id="vuoto"><b>Qui appare la conversazione</b>Puoi parlare oppure scrivere: ${esc(nomeVisuale)} risponderà nello stesso modo.</div></div>
          <form id="scrivi"><input id="frase" aria-label="Messaggio per il receptionist" placeholder="Scrivi un messaggio…" autocomplete="off" disabled><button id="invia" aria-label="Invia messaggio" disabled>Invia</button></form>
        </div>
      </section>
    </section>
    <section class="come-funziona" aria-label="Come funziona">
      <article class="passo"><span>01 / PARLA</span><h2>Raccontaci cosa ti serve</h2><p>Una domanda, un’idea o un progetto ancora da definire.</p></article>
      <article class="passo"><span>02 / APPROFONDISCI</span><h2>Ottieni risposte utili</h2><p>Il receptionist conosce servizi, materiali e modalità di lavoro.</p></article>
      <article class="passo"><span>03 / INCONTRIAMOCI</span><h2>Prenota il tuo appuntamento</h2><p>Scegli tra gli orari davvero disponibili, senza scambi di email.</p></article>
    </section>
  </main>
  <footer><span>© ${new Date().getFullYear()} ${esc(attivita.nome)}</span><span>${esc(attivita.indirizzo || 'Assistenza tramite voce e chat')}</span></footer>
</div>
<script>
const WS_PATH = ${JSON.stringify(ws)};
const $ = (id) => document.getElementById(id);
let ws, ctx, sorgente, nodo, monitor, filtroVoce, flusso, prossimo = 0, attivi = [], marche = [], muto = false;
const streamSid = 'MZweb' + Math.random().toString(16).slice(2);
const ios = /iP(?:hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// μ-law G.711
const DEC = new Float32Array(256);
for (let i = 0; i < 256; i++) { const u = ~i & 255; const t = (((u & 15) << 3) + 132) << ((u & 112) >> 4); DEC[i] = (u & 128 ? 132 - t : t - 132) / 32768; }
function enc(f) { let s = Math.max(-1, Math.min(1, f)) * 32767 | 0; const sg = s < 0 ? 128 : 0; if (s < 0) s = -s; s = Math.min(s, 32635) + 132; let e = 7; for (let m = 16384; (s & m) === 0 && e > 0; m >>= 1) e--; return ~(sg | (e << 4) | ((s >> (e + 3)) & 15)) & 255; }
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };

function messaggio(chi, testo) {
  $('vuoto')?.remove();
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
  // μ-law → float 8 kHz e poi alzo io alla campionatura reale del contesto (iOS Safari
  // ignora sampleRate:8000 e il suo ricampionatore interno a rate così bassi crea crepe e sibili).
  const su = ctx.sampleRate, passo = 8000 / su, nSu = Math.max(1, Math.round(n / passo));
  const buf = ctx.createBuffer(1, nSu, su), d = buf.getChannelData(0);
  for (let i = 0; i < nSu; i++) {
    const x = i * passo, j = x | 0, fr = x - j;
    const a = DEC[raw.charCodeAt(j)] ?? 0, b = j + 1 < n ? DEC[raw.charCodeAt(j + 1)] : a;
    d[i] = a + (b - a) * fr;
  }
  const s = ctx.createBufferSource();
  s.buffer = buf; s.connect(filtroVoce);
  // Safari mobile ha più jitter: accumula un piccolo margine solo quando la coda è vuota.
  if (prossimo < ctx.currentTime + 0.01) prossimo = ctx.currentTime + (ios ? 0.09 : 0.05);
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
  // iOS ignora sampleRate:8000; si usa il rate nativo e il worklet ricampiona a 8 kHz.
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
  // L'audio arriva a 8 kHz e qui viene alzato al rate del dispositivo con interpolazione
  // lineare: sopra i 4 kHz restano "immagini" che fanno sibilare la voce. Due passa-basso
  // in cascata (Linkwitz-Riley a 3,4 kHz) le tolgono prima delle casse.
  filtroVoce = ctx.createBiquadFilter();
  filtroVoce.type = 'lowpass';
  filtroVoce.frequency.value = Math.min(3400, ctx.sampleRate * 0.45);
  filtroVoce.Q.value = 0.54;
  const filtroVoce2 = ctx.createBiquadFilter();
  filtroVoce2.type = 'lowpass';
  filtroVoce2.frequency.value = filtroVoce.frequency.value;
  filtroVoce2.Q.value = 1.3;
  filtroVoce.connect(filtroVoce2);
  filtroVoce2.connect(ctx.destination);
  let senzaMicrofono = false;
  stato('consenti l\u2019uso del microfono…');
  try {
    flusso = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: { ideal: true }, noiseSuppression: { ideal: true }, autoGainControl: { ideal: false }, channelCount: { ideal: 1 } } });
  } catch (e) {
    // senza microfono la chiamata va lo stesso: si ascolta e si scrive in chat
    senzaMicrofono = true;
    flusso = new MediaStream([ctx.createMediaStreamDestination().stream.getAudioTracks()[0]]);
  }
  const codice = ${JSON.stringify(codiceCatturaBrowser())};
  const indirizzoWorklet = URL.createObjectURL(new Blob([codice], { type: 'application/javascript' }));
  try { await ctx.audioWorklet.addModule(indirizzoWorklet); } finally { URL.revokeObjectURL(indirizzoWorklet); }
  sorgente = ctx.createMediaStreamSource(flusso);
  nodo = new AudioWorkletNode(ctx, 'cattura');
  sorgente.connect(nodo);
  // Mantiene vivo il worklet anche su Safari; gain zero evita di rimandare il microfono in cuffia.
  monitor = ctx.createGain(); monitor.gain.value = 0; nodo.connect(monitor); monitor.connect(ctx.destination);

  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + WS_PATH);
  let tick = 0;
  ws.onopen = () => {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    invia({ event: 'connected', protocol: 'Call', version: '1.0.0' });
    invia({ event: 'start', streamSid, start: { streamSid, callSid: 'CAweb' + Date.now(), customParameters: { from: 'browser', client: ios ? 'ios' : 'browser' }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } });
    nodo.port.onmessage = ({ data }) => {
      let e = 0; const u = new Uint8Array(160);
      for (let i = 0; i < 160; i++) { const v = muto ? 0 : data[i]; u[i] = enc(v); e += v * v; }
      $('livello').style.width = Math.min(100, Math.sqrt(e / 160) * 400) + '%';
      invia({ event: 'media', streamSid, media: { track: 'inbound', chunk: String(tick), timestamp: String(tick++ * 20), payload: b64(u) } });
    };
    document.body.classList.add('chiamata-attiva');
    $('chiama').textContent = 'Termina chiamata'; $('chiama').className = 'chiudi'; $('chiama').disabled = false;
    $('muto').disabled = $('frase').disabled = $('invia').disabled = false;
    stato(senzaMicrofono ? 'senza microfono: scrivi in chat' : 'squilla…');
    if (senzaMicrofono) { $('muto').textContent = 'Senza microfono'; $('muto').disabled = true; }
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
  nodo?.disconnect(); monitor?.disconnect(); sorgente?.disconnect(); flusso?.getTracks().forEach((t) => t.stop()); ctx?.close();
  ws = ctx = monitor = null; prossimo = 0; attivi = []; marche.forEach((m) => clearTimeout(m.t)); marche = [];
  document.body.classList.remove('chiamata-attiva');
  $('chiama').textContent = 'Inizia la chiamata'; $('chiama').className = ''; $('chiama').disabled = false;
  $('muto').disabled = $('frase').disabled = $('invia').disabled = true;
  $('livello').style.width = '0';
  stato('chiamata terminata');
}

$('chiama').onclick = () => (ws ? chiudi() : chiama());
$('muto').onclick = () => { muto = !muto; $('muto').textContent = muto ? 'Microfono spento' : 'Microfono acceso'; };
$('scrivi').onsubmit = (e) => { e.preventDefault(); const t = $('frase').value.trim(); if (!t) return; invia({ event: 'testo', testo: t }); $('frase').value = ''; };
const riprendiAudio = () => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) riprendiAudio(); });
window.addEventListener('pageshow', riprendiAudio);
</script>
</body></html>`;
}
