// Il server del receptionist: risponde a Twilio quando arriva una chiamata, serve la pagina
// per chiamare dal browser e collega l'audio alla pipeline locale
// (faster-whisper → Claude Code → Qwen3-TTS).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CONFIG, twilioConfigurato } from './config.mjs';
import { ChiamataTwilio } from './twilio-stream.mjs';
import { gestisciChiamata, preriscalda } from './chiamata.mjs';
import { chiamaNumero } from './strumenti.mjs';
import { paginaPannello } from './pannello.mjs';
import { paginaWeb } from './web.mjs';
import { saluto } from './persona.mjs';
import { frasePronta } from './voce.mjs';

const segreto = process.env.SEGRETO || 'locale';
if (CONFIG.urlPubblico && !process.env.SEGRETO) console.warn('⚠️ Manca SEGRETO nel .env: il webhook e il pannello hanno un indirizzo facile da indovinare.');
const gettoni = new Map(); // gettone monouso → scadenza

function nuovoGettone() {
  const g = randomBytes(12).toString('hex');
  gettoni.set(g, Date.now() + 60000);
  return g;
}

const xml = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

async function leggiCorpo(req) {
  let s = '';
  for await (const c of req) s += c;
  return s;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (codice, o) => { res.writeHead(codice, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const html = (h) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(h); };
  try {
    // Twilio: è arrivata (o è partita) una chiamata → rispondi con le istruzioni TwiML
    if (req.method === 'POST' && url.pathname === `/twilio/${segreto}/voce`) {
      const p = Object.fromEntries(new URLSearchParams(await leggiCorpo(req)));
      const inUscita = url.searchParams.get('uscita') === '1';
      const cliente = inUscita ? p.To : p.From;
      const numeroTwilio = inUscita ? p.From : p.To;
      console.log(`📞 ${p.CallSid} ${inUscita ? 'in uscita verso' : 'da'} ${cliente}`);
      preriscalda(p.CallSid, cliente); // Claude Code si avvia mentre squilla
      const host = CONFIG.urlPubblico ? new URL(CONFIG.urlPubblico).host : req.headers.host;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${xml(host)}/media/tel/${nuovoGettone()}">
      <Parameter name="from" value="${xml(cliente)}"/>
      <Parameter name="to" value="${xml(numeroTwilio)}"/>
    </Stream>
  </Connect>
</Response>`);
    }

    // Chiamata dal browser: microfono, altoparlante e chat
    if (req.method === 'GET' && (url.pathname === `/web/${segreto}` || (url.pathname === '/' && segreto === 'locale'))) {
      return html(paginaWeb({ ws: `/media/web/${segreto}` }));
    }

    // Pannello: fatti chiamare al telefono
    if (url.pathname === `/pannello/${segreto}`) {
      let messaggio = '';
      if (req.method === 'POST') {
        const p = Object.fromEntries(new URLSearchParams(await leggiCorpo(req)));
        if (p.chiama) {
          try { messaggio = `Ti sto chiamando (${await chiamaNumero(p.chiama.replace(/\s+/g, ''))}).`; } catch (e) { messaggio = `Chiamata non partita: ${e.message}`; }
        }
      }
      return html(paginaPannello({ messaggio, twilio: twilioConfigurato(), numero: CONFIG.twilio.numero, web: `/web/${segreto}` }));
    }

    if (req.method === 'GET' && url.pathname === '/salute') {
      let motore = false;
      try { motore = (await fetch(`${CONFIG.motore}/salute`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      return json(200, { ok: true, motore, twilio: twilioConfigurato() });
    }

    res.writeHead(404);
    res.end();
  } catch (e) {
    console.error(e);
    // Se qualcosa va storto, chi chiama sente un messaggio invece del silenzio.
    if (url.pathname.includes('/voce')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Say language="it-IT">Ci scusi, al momento non riusciamo a rispondere. Riprovi tra poco.</Say></Response>');
    }
    res.writeHead(500);
    res.end();
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const [, primo, tipo, gettone] = new URL(req.url, 'http://x').pathname.split('/');
  const locale = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['cf-connecting-ip'];
  const valido = tipo === 'web'
    ? gettone === segreto
    : tipo === 'tel' && ((gettoni.get(gettone) ?? 0) > Date.now() || (locale && gettone === 'prova'));
  if (primo !== 'media' || !valido) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  gettoni.delete(gettone);
  wss.handleUpgrade(req, socket, head, (ws) => gestisciChiamata(new ChiamataTwilio(ws, tipo, { web: tipo === 'web' })));
});

setInterval(() => { for (const [g, scade] of gettoni) if (scade < Date.now()) gettoni.delete(g); }, 60000).unref();

// il saluto e il riempitivo si preparano subito, così la chiamata parte senza attese
const prepara = () => Promise.all([frasePronta(saluto()), frasePronta('Mmh, allora...')])
  .then(() => console.log('🔊 saluto pronto'))
  .catch(() => { console.log('⏳ motore vocale non ancora acceso (npm run motore), riprovo...'); setTimeout(prepara, 5000).unref(); });
prepara();

server.listen(CONFIG.porta, () => {
  console.log(`Receptionist in ascolto sulla porta ${CONFIG.porta}`);
  console.log(`Chiamata dal browser: http://localhost:${CONFIG.porta}/${segreto === 'locale' ? '' : `web/${segreto}`}`);
});
