// Prova end to end del collegamento Twilio, senza account Twilio.
// Avvia il finto Twilio (prove/finto-twilio-api.mjs) e un'ISTANZA SEPARATA del server (porta 5061, dati in una
// cartella temporanea: non tocca il server vero né dati/). Serve il motore vocale su :5051 (npm run motore).
//
// Uso: node prove/prova-twilio.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { avviaFintoTwilio, consegnaWebhook, apriStream, richiesta, firma as firmaFinto } from './finto-twilio-api.mjs';

const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = 5061;
const SEGRETO = 'segreto-di-prova';
const URL_PUBBLICO = 'https://receptionist.esempio.test';
const LOCALE = `http://127.0.0.1:${PORTA}`;
const WEBHOOK = `${URL_PUBBLICO}/twilio/${SEGRETO}/voce`;
const API = `${LOCALE}/api/${SEGRETO}`;
const CLIENTE = '+393331112233';

let ok = 0, ko = 0;
const verifica = (nome, cond, dettaglio = '') => {
  if (cond) { ok++; console.log(`  ✓ ${nome}`); } else { ko++; console.log(`  ✗ ${nome}${dettaglio ? `  → ${dettaglio}` : ''}`); }
};
const sezione = (t) => console.log(`\n${t}`);
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

const cartellaRegistrazioni = join(RADICE, 'registrazioni');
const registrazioniPrima = new Set(existsSync(cartellaRegistrazioni) ? readdirSync(cartellaRegistrazioni) : []);
const callSidUsati = new Set(['CAws']);

const dati = mkdtempSync(join(tmpdir(), 'cosmio-prova-twilio-'));
// anche questo processo (che importa src/twilio.mjs per la prova dell'SMS) usa SOLO la cartella temporanea: prima di ogni import
process.env.DATI_DIR = dati;
for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY', 'TWILIO_API_SECRET', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMERO']) delete process.env[k];
const finto = await avviaFintoTwilio({ locale: LOCALE, aspettaSaluto: true });
process.env.TWILIO_API_BASE = finto.base;
console.log(`Finto Twilio su ${finto.base}, dati temporanei in ${dati}`);

// l'istanza separata del server: niente variabili Twilio ereditate dall'ambiente
const ambiente = { ...process.env, PORTA: String(PORTA), SEGRETO, URL_PUBBLICO, DATI_DIR: dati, TWILIO_API_BASE: finto.base, HOST: '127.0.0.1',
  TWILIO_ACCOUNT_SID: '', TWILIO_API_KEY: '', TWILIO_API_SECRET: '', TWILIO_AUTH_TOKEN: '', TWILIO_NUMERO: '', CON_SMS: '0' };
const server = spawn('node', ['src/server.mjs'], { cwd: RADICE, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
let uscita = '';
server.stdout.on('data', (d) => { uscita += d; });
server.stderr.on('data', (d) => { uscita += d; });

async function pulisci() {
  server.kill('SIGTERM');
  await pausa(300);
  await finto.chiudi();
  rmSync(dati, { recursive: true, force: true });
  // i log delle telefonate di prova (solo i nostri: li riconosco dal CallSid)
  if (existsSync(cartellaRegistrazioni)) {
    for (const f of readdirSync(cartellaRegistrazioni)) {
      if (registrazioniPrima.has(f) || !f.endsWith('.log')) continue;
      const testo = readFileSync(join(cartellaRegistrazioni, f), 'utf8');
      if ([...callSidUsati].some((s) => testo.includes(s))) rmSync(join(cartellaRegistrazioni, f), { force: true });
    }
  }
}

const chiedi = async (percorso, corpo) => {
  const r = await richiesta(API + percorso, corpo === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  return { stato: r.status, json: await r.json().catch(() => ({})) };
};
const salva = (twilio) => chiedi('/impostazioni', { twilio });

// una chiamata in arrivo come la manderebbe Twilio al nostro webhook
const inArrivo = (opzioni = {}) => {
  const callSid = 'CA' + Math.random().toString(16).slice(2).padEnd(32, '0');
  callSidUsati.add(callSid);
  return consegnaWebhook({
    urlFirmato: opzioni.url || WEBHOOK, locale: LOCALE, authToken: opzioni.token || finto.authToken, firmaTipo: opzioni.firma || 'giusta',
    parametri: { AccountSid: finto.accountSid, CallSid: callSid, From: CLIENTE, To: finto.numero, Direction: 'inbound', CallStatus: 'ringing', ...(opzioni.parametri || {}) },
  });
};

try {
  // attesa avvio
  for (let i = 0; i < 100; i++) {
    try { if ((await richiesta(`${LOCALE}/salute`)).ok) break; } catch {}
    await pausa(200);
    if (i === 99) throw new Error(`il server di prova non parte:\n${uscita}`);
  }

  sezione('Firma: formula');
  const parametriDoc = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  const { firmaTwilio } = await import('../src/twilio.mjs').catch(() => ({})); // anche solo per il confronto di formula
  const esempio = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  verifica('vettore della documentazione Twilio (0/KCTR6DLpKmkAf8muzZqo1nDgQ=)', firmaFinto(esempio, parametriDoc, '12345') === '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  verifica('src/twilio.mjs firma come la documentazione', firmaTwilio?.(esempio, parametriDoc, '12345') === '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');

  sezione('Credenziali: API Key (SK...) senza Auth Token');
  let r = await salva({ accountSid: finto.accountSid, apiKey: finto.apiKey, apiSecret: finto.apiSecret, numero: finto.numero });
  verifica('salvataggio impostazioni', r.stato === 200, JSON.stringify(r.json));
  verifica('apiSecret e authToken non tornano al browser', r.json.twilio?.apiSecret === '' && r.json.twilio?.authToken === '' && r.json.twilio?.segretoImpostato === true && r.json.twilio?.authTokenImpostato === false);
  r = await chiedi('/twilio/verifica', {});
  verifica('verifica credenziali OK', r.stato === 200 && r.json.conto === 'Account di prova' && r.json.numeri?.some((n) => n.numero === finto.numero), JSON.stringify(r.json));
  verifica('lo stato dell\'account arriva (Full)', r.json.tipo === 'Full');
  r = await salva({ apiSecret: 'segreto-sbagliato' });
  r = await chiedi('/twilio/verifica', {});
  verifica('verifica con credenziali errate → errore chiaro (401 di Twilio)', r.stato === 400 && /rifiuta le credenziali/.test(r.json.errore || ''), JSON.stringify(r.json));
  await salva({ apiSecret: finto.apiSecret });
  r = await chiedi('/twilio/verifica', {});
  verifica('credenziali ripristinate: di nuovo OK', r.stato === 200);
  verifica('il finto ha risposto 401 alle credenziali sbagliate', finto.rifiutate401 >= 1, String(finto.rifiutate401));

  sezione('Collegamento del numero');
  r = await chiedi('/twilio/stato');
  verifica('indirizzo webhook = URL pubblico + /twilio/<segreto>/voce', r.json.webhook === WEBHOOK, r.json.webhook);
  verifica('/twilio/stato: firma false (manca l\'Auth Token) → il pannello mostra l\'avviso', r.json.firma === false && r.json.configurato === true, JSON.stringify(r.json));
  const pagina = await (await richiesta(`${LOCALE}/admin/${SEGRETO}`)).text();
  verifica('il pannello ha il campo Auth Token, l\'aiuto e l\'avviso giallo "firma non verificata"', pagina.includes('data-k="twilio.authToken"') && pagina.includes('id="avvisoFirma"') && /Firma non verificata/.test(pagina) && /Auth Token/.test(pagina));
  r = await chiedi('/twilio/collega', {});
  verifica('collega il numero', r.stato === 200 && r.json.numero === finto.numero, JSON.stringify(r.json));
  verifica('Twilio ha registrato VoiceUrl = indirizzoWebhook() e VoiceMethod POST', finto.numeriWebhook[finto.numero]?.VoiceUrl === WEBHOOK && finto.numeriWebhook[finto.numero]?.VoiceMethod === 'POST', JSON.stringify(finto.numeriWebhook));
  verifica('collega ha cercato il numero con ?PhoneNumber= (+ codificato)', finto.richieste.some((x) => x.metodo === 'GET' && x.percorso.includes('IncomingPhoneNumbers.json?PhoneNumber=%2B15551234567')));

  sezione('Webhook senza Auth Token (come prima, ma segnalato)');
  let w = await inArrivo({ firma: 'assente' });
  verifica('senza Auth Token il webhook passa anche senza firma → TwiML con <Stream>', w.stato === 200 && !!w.stream, `${w.stato} ${w.twiml.slice(0, 120)}`);
  const sbagliato = await richiesta(`${LOCALE}/twilio/altro-segreto/voce`, { method: 'POST', body: new URLSearchParams({ CallSid: 'CAx', From: CLIENTE, To: finto.numero }).toString() });
  verifica('il segreto nel percorso resta il secondo livello (segreto sbagliato → non risponde TwiML)', sbagliato.status !== 200);

  sezione('Auth Token: Account SID + Auth Token come credenziali (nessuna API Key)');
  r = await salva({ apiKey: '', apiSecret: finto.authToken });
  r = await chiedi('/twilio/stato');
  verifica('l\'Auth Token si ricava dal secret → firma true', r.json.firma === true, JSON.stringify(r.json));
  r = await chiedi('/twilio/verifica', {});
  verifica('verifica con Account SID + Auth Token OK', r.stato === 200, JSON.stringify(r.json));
  w = await inArrivo();
  verifica('webhook con firma giusta (token ricavato dal secret) → 200', w.stato === 200 && !!w.stream, String(w.stato));

  sezione('Auth Token separato (API Key per l\'API, Auth Token per la firma)');
  r = await salva({ apiKey: finto.apiKey, apiSecret: finto.apiSecret, authToken: finto.authToken });
  verifica('salvataggio con authToken', r.stato === 200 && r.json.twilio.authTokenImpostato === true && r.json.twilio.authToken === '' && r.json.twilio.apiSecret === '', JSON.stringify(r.json.twilio));
  r = await salva({ authToken: '' });
  verifica('salvare con il campo vuoto non cancella l\'Auth Token', r.json.twilio.authTokenImpostato === true);
  r = await chiedi('/twilio/stato');
  verifica('/twilio/stato: firma true', r.json.firma === true && r.json.configurato === true, JSON.stringify(r.json));
  const pagina2 = await (await richiesta(`${LOCALE}/admin/${SEGRETO}`)).text();
  verifica('la pagina admin non contiene l\'Auth Token', !pagina2.includes(finto.authToken));
  const impostazioniJson = await (await richiesta(`${API}/impostazioni`)).text();
  verifica('GET /impostazioni non contiene né Auth Token né secret', !impostazioniJson.includes(finto.authToken) && !impostazioniJson.includes(finto.apiSecret));

  sezione('Webhook con Auth Token');
  w = await inArrivo();
  const flusso = w.twiml;
  verifica('firma giusta → 200 con <Stream>', w.stato === 200 && !!w.stream, `${w.stato} ${flusso.slice(0, 200)}`);
  verifica('il TwiML esce con l\'host di urlPubblico() (non con l\'Host della richiesta)', w.stream?.startsWith(`wss://receptionist.esempio.test/media/tel/`), w.stream);
  verifica('parametri from/to nel TwiML (from = chi chiama)', w.parametriStream.from === CLIENTE && w.parametriStream.to === finto.numero, JSON.stringify(w.parametriStream));
  const tokenGiusto = w.stream?.split('/').pop();
  const tokenSecondo = (await inArrivo()).stream?.split('/').pop();
  w = await inArrivo({ firma: 'errata' });
  verifica('firma sbagliata → 403', w.stato === 403 && !w.stream, String(w.stato));
  w = await inArrivo({ firma: 'assente' });
  verifica('firma mancante → 403', w.stato === 403 && !w.stream, String(w.stato));
  w = await inArrivo({ token: finto.apiSecret });
  verifica('firma col secret della API Key (non l\'Auth Token) → 403', w.stato === 403, String(w.stato));
  w = await inArrivo({ token: 'altro-token' });
  verifica('firma con un altro token → 403', w.stato === 403, String(w.stato));
  // firma calcolata per una richiesta, ma i parametri sono stati cambiati
  {
    const corpo = new URLSearchParams({ CallSid: 'CAfirmato', From: CLIENTE, To: finto.numero });
    const f = firmaFinto(WEBHOOK, corpo, finto.authToken);
    corpo.set('From', '+390000000000');
    const rr = await richiesta(`${LOCALE}/twilio/${SEGRETO}/voce`, { method: 'POST', headers: { 'X-Twilio-Signature': f, 'Content-Type': 'application/x-www-form-urlencoded' }, body: corpo.toString() });
    verifica('firma giusta ma parametri manomesso → 403', rr.status === 403, String(rr.status));
  }
  w = await inArrivo({ url: WEBHOOK, parametri: {} });
  // URL firmato senza query ma richiesta con ?uscita=1 (e viceversa) → 403
  {
    const corpo = new URLSearchParams({ CallSid: 'CAq', From: finto.numero, To: CLIENTE });
    const rr = await richiesta(`${LOCALE}/twilio/${SEGRETO}/voce?uscita=1`, { method: 'POST', headers: { 'X-Twilio-Signature': firmaFinto(WEBHOOK, corpo, finto.authToken), 'Content-Type': 'application/x-www-form-urlencoded' }, body: corpo.toString() });
    verifica('la query fa parte dell\'URL firmato: firma senza ?uscita=1 su richiesta con ?uscita=1 → 403', rr.status === 403, String(rr.status));
  }
  w = await inArrivo({ url: `${WEBHOOK}?uscita=1`, parametri: { From: finto.numero, To: CLIENTE, Direction: 'outbound-api' } });
  verifica('firma giusta con ?uscita=1 → 200', w.stato === 200 && !!w.stream, String(w.stato));
  verifica('in uscita from = il cliente (To), to = il nostro numero', w.parametriStream.from === CLIENTE && w.parametriStream.to === finto.numero, JSON.stringify(w.parametriStream));
  verifica('il log del server spiega i rifiuti', /webhook Twilio rifiutato \(403\): manca X-Twilio-Signature/.test(uscita) && /webhook Twilio rifiutato \(403\): firma errata/.test(uscita));
  // Host diverso da quello pubblico (dietro un proxy non è affidabile): la firma vale lo stesso
  {
    const corpo = new URLSearchParams({ CallSid: 'CAhost', From: CLIENTE, To: finto.numero });
    callSidUsati.add('CAhost');
    const rr = await richiesta(`${LOCALE}/twilio/${SEGRETO}/voce`, { method: 'POST', headers: { Host: 'altro.host.test', 'X-Twilio-Signature': firmaFinto(WEBHOOK, corpo, finto.authToken), 'Content-Type': 'application/x-www-form-urlencoded' }, body: corpo.toString() });
    const t = await rr.text();
    verifica('con un Host diverso nella richiesta la firma vale lo stesso e lo stream esce su urlPubblico()', rr.status === 200 && t.includes('wss://receptionist.esempio.test/media/tel/'), `${rr.status} ${t.slice(0, 100)}`);
  }

  sezione('WebSocket del media stream');
  let s = await apriStream({ urlStream: `wss://receptionist.esempio.test/media/tel/gettone-inventato`, locale: LOCALE, callSid: 'CAws', accountSid: finto.accountSid });
  verifica('gettone sbagliato → rifiutato (403)', s.rifiutato === 403 && !s.aperto, JSON.stringify(s));
  s = await apriStream({ urlStream: `wss://receptionist.esempio.test/media/tel/`, locale: LOCALE, callSid: 'CAws', accountSid: finto.accountSid });
  verifica('gettone vuoto → rifiutato', s.rifiutato !== null && !s.aperto, JSON.stringify(s));
  const callSidWs = 'CA' + 'c'.repeat(32);
  callSidUsati.add(callSidWs);
  s = await apriStream({ urlStream: `wss://receptionist.esempio.test/media/tel/${tokenGiusto}`, locale: LOCALE, callSid: callSidWs, accountSid: finto.accountSid, parametri: { from: CLIENTE, to: finto.numero }, aspettaSaluto: true });
  verifica('gettone giusto → WebSocket aperto', s.aperto, JSON.stringify(s));
  verifica('il receptionist saluta (audio μ-law verso il "telefono")', s.salutoRicevuto && s.byteAudio > 8000, `${s.mediaRicevuti} messaggi media, ${s.byteAudio} byte (8000 byte = 1 s)`);
  s = await apriStream({ urlStream: `wss://receptionist.esempio.test/media/tel/${tokenGiusto}`, locale: LOCALE, callSid: callSidWs, accountSid: finto.accountSid });
  verifica('gettone già usato → rifiutato (monouso)', s.rifiutato === 403 && !s.aperto, JSON.stringify(s));
  s = await apriStream({ urlStream: `wss://receptionist.esempio.test/media/web/${tokenSecondo}`, locale: LOCALE, callSid: callSidWs, accountSid: finto.accountSid });
  verifica('il gettone di una telefonata non vale sul canale "web"', s.rifiutato === 403 && !s.aperto, JSON.stringify(s));
  s = await apriStream({ urlStream: `wss://receptionist.esempio.test/media/tel/${tokenSecondo}`, locale: LOCALE, callSid: callSidWs, accountSid: finto.accountSid, attesaMs: 300 });
  verifica('un altro gettone (non ancora usato) è ancora valido', s.aperto, JSON.stringify(s));

  sezione('Chiamata in uscita (chiamaNumero → Calls.json → webhook firmato → WebSocket)');
  const prima = finto.chiamate.length;
  r = await chiedi('/twilio/chiamami', { numero: CLIENTE.replace('+39', '+39 ') });
  verifica('/twilio/chiamami → SID della chiamata', r.stato === 200 && /^CA/.test(r.json.sid || ''), JSON.stringify(r.json));
  const c = finto.chiamate[prima];
  verifica('Calls.json ha ricevuto From = numero, To = cliente (senza spazi), Url = webhook?uscita=1', c && c.From === finto.numero && c.To === CLIENTE && c.Url === `${WEBHOOK}?uscita=1`, JSON.stringify(c && { From: c.From, To: c.To, Url: c.Url }));
  if (c) { callSidUsati.add(c.sid); await c.fatta; }
  verifica('il webhook firmato è stato accettato (200 + <Stream>)', c?.webhook?.stato === 200 && !!c?.webhook?.stream, JSON.stringify(c?.webhook && { stato: c.webhook.stato, errore: c.errore }));
  verifica('lo stream si apre e arrivano i parametri from/to dal <Parameter>', c?.stream?.aperto === true && c?.webhook?.parametriStream?.from === CLIENTE, JSON.stringify(c?.stream));
  verifica('in uscita il receptionist parla per primo (saluto)', c?.stream?.salutoRicevuto === true && c.stream.byteAudio > 8000, `${c?.stream?.byteAudio} byte`);
  verifica('la chiamata si chiude pulita dopo lo stop', c?.stream?.chiusura != null, JSON.stringify(c?.stream?.chiusura));

  sezione('SMS');
  const tw = await import('../src/twilio.mjs');
  await tw.inviaSms(CLIENTE, 'Appuntamento confermato: martedì alle 10:00');
  const sms = finto.sms[0];
  verifica('SMS inviato (POST Messages.json con Basic auth API Key)', !!sms && sms.To === CLIENTE && sms.From === finto.numero && /Appuntamento confermato/.test(sms.Body), JSON.stringify(sms));
  const ultima = finto.richieste.filter((x) => x.percorso.endsWith('/Messages.json')).length;
  verifica('una sola richiesta Messages.json', ultima === 1, String(ultima));
  let errore = '';
  // l'istanza in questo processo ha la sua cache: la ricarico leggendo il file come fa un riavvio
  const imp = await import('../src/impostazioni.mjs');
  imp.salvaImpostazioni({ twilio: { apiSecret: 'sbagliato' } });
  await tw.inviaSms(CLIENTE, 'x').catch((e) => { errore = e.message; });
  verifica('SMS con credenziali errate → errore chiaro', /rifiuta le credenziali/.test(errore), errore);

  sezione('Server');
  verifica('il server di prova non è andato in crash', server.exitCode === null, uscita.split('\n').slice(-5).join(' | '));
} catch (e) {
  ko++;
  console.log(`  ✗ errore imprevisto: ${e.stack || e}`);
  console.log('--- uscita del server di prova ---\n' + uscita.split('\n').slice(-30).join('\n'));
} finally {
  await pulisci();
}

console.log(`\n${ko === 0 ? '✅' : '❌'} ${ok} verifiche riuscite, ${ko} fallite`);
process.exit(ko === 0 ? 0 : 1);
