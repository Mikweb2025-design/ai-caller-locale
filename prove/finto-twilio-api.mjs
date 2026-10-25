// Finto Twilio: un server HTTP che imita l'API REST di Twilio e il suo comportamento verso il webhook,
// per provare il collegamento col numero senza un account vero.
//
//   API REST (Basic auth controllata, 401 se sbagliata):
//     GET  /2010-04-01/Accounts/{sid}.json
//     GET  /2010-04-01/Accounts/{sid}/IncomingPhoneNumbers.json[?PhoneNumber=+39...]
//     POST /2010-04-01/Accounts/{sid}/IncomingPhoneNumbers/{pn}.json   (registra VoiceUrl / VoiceMethod)
//     POST /2010-04-01/Accounts/{sid}/Messages.json                    (registra gli SMS)
//     POST /2010-04-01/Accounts/{sid}/Calls.json                       (poi fa come Twilio: POST firmato al Url ricevuto,
//                                                                       e se il TwiML ha <Stream> apre il WebSocket)
//
// Come Twilio, FIRMA con l'Auth Token primario dell'account (HMAC-SHA1 di URL + parametri ordinati), usando l'URL
// pubblico del webhook, ma la richiesta la manda al server locale (l'URL pubblico di prova non esiste davvero).
//
// Uso da riga di comando:  node prove/finto-twilio-api.mjs   (poi TWILIO_API_BASE=http://127.0.0.1:5062 sul server)
// Uso da codice:           const finto = await avviaFintoTwilio({ locale: 'http://127.0.0.1:5061' })
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Stessa formula di Twilio, scritta qui per conto suo (così verifica anche il codice del server).
export function firma(url, parametri, authToken) {
  const coppie = parametri instanceof URLSearchParams ? [...parametri.entries()] : Object.entries(parametri);
  const per = new Map();
  for (const [k, v] of coppie) per.set(k, [...(per.get(k) || []), String(v)]);
  let dati = url;
  for (const k of [...per.keys()].sort()) for (const v of per.get(k).sort()) dati += k + v;
  return createHmac('sha1', authToken).update(dati).digest('base64');
}

const sid = (prefisso) => prefisso + randomBytes(16).toString('hex');
// fetch di Node rifiuta le porte "cattive" (5060 e 5061 sono SIP): per parlare con il server di prova uso http.request
export function richiesta(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((risolvi, rifiuta) => {
    const corpo = body === undefined ? undefined : String(body);
    const req = http.request(url, { method, headers: { ...headers, ...(corpo !== undefined ? { 'Content-Length': Buffer.byteLength(corpo) } : {}) }, timeout: 20000 }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { t += c; });
      res.on('end', () => risolvi({ status: res.statusCode, ok: res.statusCode < 300, text: async () => t, json: async () => JSON.parse(t) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', rifiuta);
    if (corpo !== undefined) req.write(corpo);
    req.end();
  });
}

const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// Comportamento di Twilio quando una chiamata arriva (o parte): POST al webhook, poi, se c'è <Stream>, il WebSocket.
//  urlFirmato: l'URL pubblico (quello che Twilio ha in configurazione, e che entra nella firma)
//  locale:     dove consegnare davvero la richiesta, es. http://127.0.0.1:5061
//  firmaTipo:  'giusta' | 'errata' | 'assente'
export async function consegnaWebhook({ urlFirmato, locale, parametri, authToken, firmaTipo = 'giusta' }) {
  const u = new URL(urlFirmato);
  const corpo = new URLSearchParams(parametri);
  const intestazioni = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'TwilioProxy/1.1' };
  if (firmaTipo === 'giusta') intestazioni['X-Twilio-Signature'] = firma(urlFirmato, corpo, authToken);
  if (firmaTipo === 'errata') intestazioni['X-Twilio-Signature'] = firma(urlFirmato + 'x', corpo, authToken);
  const r = await richiesta(locale + u.pathname + u.search, { method: 'POST', headers: intestazioni, body: corpo.toString() });
  const twiml = await r.text();
  return { stato: r.status, twiml, stream: twiml.match(/<Stream url="([^"]+)"/)?.[1] || null, parametriStream: Object.fromEntries([...twiml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]])) };
}

// Apre il WebSocket come fa Twilio: connected, start (con i customParameters dei <Parameter>), frame media di silenzio, stop.
//  urlStream: quello del TwiML (wss://host/media/tel/<gettone>): l'host viene sostituito con quello locale
//  attesaMs:  quanto resta in linea; se aspettaSaluto, almeno finché il receptionist non manda audio
export async function apriStream({ urlStream, locale, callSid, accountSid, parametri = {}, attesaMs = 1500, aspettaSaluto = false, massimoMs = 40000 }) {
  const url = urlStream.replace(/^wss?:\/\/[^/]+/, locale.replace(/^http/, 'ws'));
  const esito = { aperto: false, rifiutato: null, eventi: [], mediaRicevuti: 0, byteAudio: 0, marche: 0, chiusura: null };
  const streamSid = sid('MZ');
  const ws = new WebSocket(url);
  await new Promise((risolvi) => {
    ws.once('open', () => { esito.aperto = true; risolvi(); });
    ws.once('unexpected-response', (req, res) => { esito.rifiutato = res.statusCode; risolvi(); });
    ws.once('error', (e) => { if (!esito.aperto && esito.rifiutato === null) esito.rifiutato = e.message; risolvi(); });
  });
  if (!esito.aperto) return esito;
  const chiuso = new Promise((r) => ws.once('close', (codice) => { esito.chiusura = codice; r(); }));
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    esito.eventi.push(m.event);
    if (m.event === 'media') { esito.mediaRicevuti++; esito.byteAudio += Buffer.from(m.media?.payload || '', 'base64').length; esito.primoMedia ??= Date.now(); }
    if (m.event === 'mark') { esito.marche++; setTimeout(() => { try { ws.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: m.mark.name } })); } catch {} }, 80); } // il "telefono" ha riprodotto
  });
  ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  ws.send(JSON.stringify({ event: 'start', sequenceNumber: '1', start: { accountSid, streamSid, callSid, tracks: ['inbound'], customParameters: parametri, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } }, streamSid }));
  const silenzio = Buffer.alloc(160, 0xff).toString('base64'); // 20 ms di silenzio μ-law
  const t0 = Date.now();
  let n = 1;
  while (ws.readyState === WebSocket.OPEN) {
    const tr = Date.now() - t0;
    const saluto = !aspettaSaluto || (esito.primoMedia && Date.now() - esito.primoMedia > 1500); // aspetta il saluto e ne ascolta un po'
    if ((tr >= attesaMs && saluto) || tr > massimoMs) break;
    ws.send(JSON.stringify({ event: 'media', sequenceNumber: String(++n), media: { track: 'inbound', chunk: String(n - 1), timestamp: String(tr), payload: silenzio }, streamSid }));
    await pausa(20);
  }
  esito.salutoRicevuto = esito.mediaRicevuti > 0;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ event: 'stop', sequenceNumber: String(++n), stop: { accountSid, callSid }, streamSid }));
    await pausa(150);
    ws.close();
  }
  await Promise.race([chiuso, pausa(3000)]);
  esito.streamSid = streamSid;
  return esito;
}

export async function avviaFintoTwilio({
  porta = 0,
  accountSid = 'AC' + 'a'.repeat(32), // Account SID di prova
  authToken = 'auth-token-di-prova', // Auth Token primario: con questo Twilio FIRMA i webhook
  apiKey = 'SK' + 'b'.repeat(32),
  apiSecret = 'secret-api-key-di-prova',
  numero = '+15551234567',
  locale = 'http://127.0.0.1:5050', // dove sta davvero il server da chiamare
  aspettaSaluto = false,
  attesaMs = 1500,
} = {}) {
  const stato = { accountSid, authToken, apiKey, apiSecret, numero, locale, richieste: [], numeriWebhook: {}, sms: [], chiamate: [], rifiutate401: 0 };
  const numeroSid = 'PN' + '1'.repeat(32);
  const numeri = [{ sid: numeroSid, phone_number: numero, friendly_name: 'Numero di prova', voice_url: '' }];
  const credenzialiValide = new Set([`${accountSid}:${authToken}`, `${apiKey}:${apiSecret}`]);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (codice, o) => { res.writeHead(codice, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    let corpo = '';
    for await (const c of req) corpo += c;
    const form = new URLSearchParams(corpo);
    stato.richieste.push({ metodo: req.method, percorso: url.pathname + url.search, corpo: Object.fromEntries(form) });
    const basic = (req.headers.authorization || '').match(/^Basic (.+)$/);
    const cred = basic ? Buffer.from(basic[1], 'base64').toString() : '';
    if (!credenzialiValide.has(cred)) {
      stato.rifiutate401++;
      return json(401, { code: 20003, message: 'Authenticate', more_info: 'https://www.twilio.com/docs/errors/20003', status: 401 });
    }
    const m = url.pathname.match(/^\/2010-04-01\/Accounts\/([^/]+?)(\.json|\/.+)$/);
    if (!m || m[1] !== accountSid) return json(404, { code: 20404, message: 'The requested resource was not found', status: 404 });
    const resto = m[2];
    if (resto === '.json' && req.method === 'GET') return json(200, { sid: accountSid, friendly_name: 'Account di prova', status: 'active', type: 'Full' });
    if (resto === '/IncomingPhoneNumbers.json' && req.method === 'GET') {
      const filtro = url.searchParams.get('PhoneNumber');
      return json(200, { incoming_phone_numbers: numeri.filter((n) => !filtro || n.phone_number === filtro) });
    }
    const mn = resto.match(/^\/IncomingPhoneNumbers\/(\w+)\.json$/);
    if (mn && req.method === 'POST') {
      const n = numeri.find((x) => x.sid === mn[1]);
      if (!n) return json(404, { code: 20404, message: 'numero non trovato', status: 404 });
      n.voice_url = form.get('VoiceUrl') || n.voice_url;
      stato.numeriWebhook[n.phone_number] = { VoiceUrl: form.get('VoiceUrl'), VoiceMethod: form.get('VoiceMethod') };
      return json(200, n);
    }
    if (resto === '/Messages.json' && req.method === 'POST') {
      const sms = { sid: sid('SM'), From: form.get('From'), To: form.get('To'), Body: form.get('Body') };
      stato.sms.push(sms);
      return json(201, { sid: sms.sid, status: 'queued', ...sms });
    }
    if (resto === '/Calls.json' && req.method === 'POST') {
      const chiamata = { sid: sid('CA'), From: form.get('From'), To: form.get('To'), Url: form.get('Url') };
      if (!chiamata.Url) return json(400, { code: 21205, message: 'Url parameter is required', status: 400 });
      stato.chiamate.push(chiamata);
      json(201, { sid: chiamata.sid, status: 'queued', from: chiamata.From, to: chiamata.To });
      // come Twilio: la chiamata squilla, il cliente risponde, e Twilio chiede le istruzioni al Url (POST firmato)
      chiamata.fatta = (async () => {
        await pausa(150);
        const w = await consegnaWebhook({
          urlFirmato: chiamata.Url, locale, authToken,
          parametri: { AccountSid: accountSid, CallSid: chiamata.sid, From: chiamata.From, To: chiamata.To, Direction: 'outbound-api', CallStatus: 'in-progress', ApiVersion: '2010-04-01' },
        });
        chiamata.webhook = w;
        if (w.stato === 200 && w.stream) {
          await pausa(300); // Twilio apre lo stream poco dopo aver ricevuto il TwiML
          chiamata.stream = await apriStream({ urlStream: w.stream, locale, callSid: chiamata.sid, accountSid, parametri: w.parametriStream, aspettaSaluto, attesaMs });
        }
        return chiamata;
      })().catch((e) => { chiamata.errore = e.message; return chiamata; });
      return;
    }
    return json(404, { code: 20404, message: `non gestito dal finto Twilio: ${req.method} ${url.pathname}`, status: 404 });
  });
  await new Promise((r) => server.listen(porta, '127.0.0.1', r));
  stato.porta = server.address().port;
  stato.base = `http://127.0.0.1:${stato.porta}`;
  stato.chiudi = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return stato;
}

// da riga di comando
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await avviaFintoTwilio({
    porta: Number(process.env.PORTA_FINTA || 5062),
    locale: process.env.SERVER_LOCALE || 'http://127.0.0.1:5050',
    authToken: process.env.FINTO_AUTH_TOKEN || undefined,
  });
  console.log(`Finto Twilio su ${f.base}
  Account SID:  ${f.accountSid}
  Auth Token:   ${f.authToken}   (con questo firma i webhook)
  API Key:      ${f.apiKey} / ${f.apiSecret}
  Numero:       ${f.numero}
  Consegna i webhook a ${f.locale}
Sul server: TWILIO_API_BASE=${f.base}`);
}
