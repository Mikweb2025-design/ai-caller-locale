// Il server del receptionist: risponde a Twilio quando arriva una chiamata, serve la pagina
// per chiamare dal browser e collega l'audio alla pipeline locale
// (faster-whisper → Claude Code → Qwen3-TTS).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CONFIG } from './config.mjs';
import { twilio, twilioConfigurato, urlPubblico, indirizzoWebhook, verifica, collegaNumero, chiamaNumero, SEGRETO } from './twilio.mjs';
import { ChiamataTwilio } from './twilio-stream.mjs';
import { gestisciChiamata, preriscalda, RIEMPITIVO } from './chiamata.mjs';
import { paginaPannello } from './pannello.mjs';
import { paginaWeb } from './web.mjs';
import { saluto } from './persona.mjs';
import { frasePronta } from './voce.mjs';
import { paginaAdmin } from './admin.mjs';
import { cercaCalendari, SERVIZI } from './caldav.mjs';
import { avviaImportazione, statoImportazione } from './sito.mjs';
import { impostazioniPubbliche, salvaImpostazioni, controllaImpostazioni, impostazioni, alCambio } from './impostazioni.mjs';
import { appuntamenti, annulla, sposta, leggiCaldav, postiLiberi, leggiCalendari, impegniEsterni, ics, emailDiProva, inRoma } from './agenda.mjs';

const segreto = SEGRETO;
if (urlPubblico() && !process.env.SEGRETO) console.warn('⚠️ Manca SEGRETO nel .env: il webhook e il pannello hanno un indirizzo facile da indovinare.');
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
      const host = urlPubblico() ? new URL(urlPubblico()).host : req.headers.host;
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
      return html(paginaWeb({ ws: `/media/web/${segreto}`, admin: segreto === 'locale' ? '/admin' : `/admin/${segreto}` }));
    }

    // Pannello admin: impostazioni, calendari, email, appuntamenti
    if (req.method === 'GET' && (url.pathname === `/admin/${segreto}` || (url.pathname === '/admin' && segreto === 'locale'))) {
      const base = urlPubblico() || `http://${req.headers.host}`;
      return html(paginaAdmin({ api: `/api/${segreto}`, web: segreto === 'locale' ? '/' : `/web/${segreto}`, feed: `${base}/calendario/${segreto}.ics` }));
    }
    if (url.pathname.startsWith(`/api/${segreto}/`)) {
      const percorso = url.pathname.slice(`/api/${segreto}`.length);
      const corpo = req.method === 'POST' ? JSON.parse((await leggiCorpo(req)) || '{}') : null;
      if (percorso === '/impostazioni' && req.method === 'GET') return json(200, impostazioniPubbliche());
      if (percorso === '/impostazioni' && req.method === 'POST') {
        const prova = structuredClone(impostazioni());
        for (const [sez, v] of Object.entries(corpo)) if (typeof v === 'object' && prova[sez]) Object.assign(prova[sez], v);
        const errori = controllaImpostazioni(prova);
        if (errori.length) return json(400, { errore: errori.join('; ') });
        salvaImpostazioni(corpo);
        await impegniEsterni({ forza: true }).catch(() => {});
        return json(200, impostazioniPubbliche());
      }
      if (percorso === '/appuntamenti') return json(200, { appuntamenti: appuntamenti() });
      const m = percorso.match(/^\/appuntamenti\/([a-f0-9]+)\/annulla$/);
      if (m && req.method === 'POST') { const a = await annulla(m[1]); return a ? json(200, a) : json(404, { errore: 'appuntamento non trovato' }); }
      const sp = percorso.match(/^\/appuntamenti\/([a-f0-9]+)\/sposta$/);
      if (sp && req.method === 'POST') {
        try { const a = await sposta(sp[1], corpo.giorno, corpo.ora); return a ? json(200, a) : json(404, { errore: 'appuntamento non trovato' }); } catch (e) { return json(400, { errore: e.message }); }
      }
      // CalDAV: servizi noti, ricerca dei calendari di un conto, prova di lettura
      if (percorso === '/caldav/servizi') return json(200, SERVIZI);
      // Importa dal sito: parte un lavoro, il pannello ne chiede lo stato
      if (percorso === '/sito/importa' && req.method === 'POST') {
        if (!String(corpo.url || '').trim()) return json(400, { errore: "scrivi l'indirizzo del sito" });
        return json(200, { id: avviaImportazione(String(corpo.url)) });
      }
      const imp = percorso.match(/^\/sito\/importa\/(\w+)$/);
      if (imp) { const l = statoImportazione(imp[1]); return l ? json(200, l) : json(404, { errore: 'importazione non trovata' }); }
      // Twilio: stato, verifica delle credenziali, collegamento del webhook, chiamata di prova
      if (percorso === '/twilio/stato') return json(200, { webhook: indirizzoWebhook(), segretoLocale: segreto === 'locale', configurato: twilioConfigurato(), numero: twilio().numero });
      if (percorso.startsWith('/twilio/') && req.method === 'POST') {
        try {
          if (percorso === '/twilio/verifica') return json(200, await verifica());
          if (percorso === '/twilio/collega') return json(200, await collegaNumero());
          if (percorso === '/twilio/chiamami') return json(200, { sid: await chiamaNumero(String(corpo.numero || '').replace(/\s+/g, '')) });
        } catch (e) { return json(400, { errore: e.message }); }
      }
      if (percorso.startsWith('/caldav/') && req.method === 'POST') {
        const conto = { ...corpo };
        if (!conto.password) conto.password = (impostazioni().calendari || []).find((c) => c.id === conto.id)?.password || '';
        try {
          if (percorso === '/caldav/cerca') return json(200, { calendari: await cercaCalendari(conto) });
          if (percorso === '/caldav/prova') {
            const { eventi, errori } = await leggiCaldav([{ ...conto, leggi: true }]);
            if (errori.length) throw new Error(errori[0]);
            return json(200, { eventi: eventi.length });
          }
        } catch (e) { return json(400, { errore: e.message }); }
      }
      if (percorso === '/posti') return json(200, { posti: await postiLiberi() });
      if (percorso === '/calendari/verifica' && req.method === 'POST') {
        const { eventi, errori } = await leggiCalendari(corpo.calendariOccupato);
        const ora = new Date();
        const prossimo = eventi.filter((e) => e.fine > ora).sort((a, b) => a.inizio - b.inizio)[0];
        return json(200, { eventi: eventi.length, errori, prossimo: prossimo ? `${prossimo.titolo || 'impegno'} il ${inRoma(prossimo.inizio).iso}` : null });
      }
      if (percorso === '/email/prova' && req.method === 'POST') {
        try { await emailDiProva(String(corpo.a || '')); return json(200, { ok: true }); } catch (e) { return json(400, { errore: e.message }); }
      }
      return json(404, { errore: 'non trovato' });
    }

    // Calendario da abbonarsi (Google Calendar, Apple Calendario, Outlook)
    if (req.method === 'GET' && url.pathname === `/calendario/${segreto}.ics`) {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(ics());
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
      return html(paginaPannello({ messaggio, twilio: twilioConfigurato(), numero: twilio().numero, web: `/web/${segreto}` }));
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
const prepara = () => Promise.all([frasePronta(saluto()), ...(CONFIG.riempitivoSecondi >= 0 ? [frasePronta(RIEMPITIVO)] : [])])
  .then(() => console.log('🔊 saluto pronto'))
  .catch(() => { console.log('⏳ motore vocale non ancora acceso (npm run motore), riprovo...'); setTimeout(prepara, 5000).unref(); });
prepara();
alCambio(() => { frasePronta(saluto()).catch(() => {}); }); // saluto nuovo: si prepara subito

server.listen(CONFIG.porta, () => {
  console.log(`Receptionist in ascolto sulla porta ${CONFIG.porta}`);
  console.log(`Chiamata dal browser: http://localhost:${CONFIG.porta}/${segreto === 'locale' ? '' : `web/${segreto}`}`);
  console.log(`Impostazioni:        http://localhost:${CONFIG.porta}/admin${segreto === 'locale' ? '' : `/${segreto}`}`);
});
