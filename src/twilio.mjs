// Twilio: il numero di telefono vero. Le credenziali si mettono nel pannello admin
// (oppure nel .env, che vale come valore di partenza). Qui: SMS, chiamate in uscita,
// verifica delle credenziali e collegamento automatico del webhook al numero.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { impostazioni } from './impostazioni.mjs';

// solo per i test: un finto Twilio al posto di api.twilio.com
const apiBase = () => (process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/$/, '');

export const SEGRETO = process.env.SEGRETO || 'locale';

export function twilio() {
  const t = impostazioni().twilio || {};
  return {
    accountSid: (t.accountSid || process.env.TWILIO_ACCOUNT_SID || '').trim(),
    // API Key (SK...) + secret, oppure Account SID + Auth Token: Twilio accetta tutte e due
    apiKey: (t.apiKey || process.env.TWILIO_API_KEY || '').trim(),
    apiSecret: (t.apiSecret || process.env.TWILIO_API_SECRET || '').trim(),
    // Auth Token primario dell'account: Twilio firma SEMPRE le richieste con questo (mai col secret di una API Key).
    // Se come credenziali usi Account SID + Auth Token (nessuna API Key), il secret è già l'Auth Token.
    authToken: (t.authToken || process.env.TWILIO_AUTH_TOKEN || (!(t.apiKey || process.env.TWILIO_API_KEY) ? t.apiSecret || process.env.TWILIO_API_SECRET : '') || '').trim(),
    numero: (t.numero || process.env.TWILIO_NUMERO || '').replace(/\s+/g, ''),
  };
}

export const urlPubblico = () => (impostazioni().twilio?.urlPubblico || process.env.URL_PUBBLICO || '').trim().replace(/\/$/, '');
export const firmaAttiva = () => Boolean(twilio().authToken);
export const twilioConfigurato = () => { const t = twilio(); return Boolean(t.accountSid && t.apiSecret); };
export const indirizzoWebhook = () => (urlPubblico() ? `${urlPubblico()}/twilio/${SEGRETO}/voce` : '');

async function api(percorso, { metodo = 'GET', corpo } = {}) {
  const t = twilio();
  if (!t.accountSid || !t.apiSecret) throw new Error('mancano Account SID e chiave/Auth Token di Twilio');
  const r = await fetch(`${apiBase()}/2010-04-01/Accounts/${t.accountSid}${percorso}`, {
    method: metodo,
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${t.apiKey || t.accountSid}:${t.apiSecret}`).toString('base64'),
      ...(corpo ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: corpo ? new URLSearchParams(corpo) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error('Twilio rifiuta le credenziali: controlla Account SID e chiave/Auth Token');
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${j.message || 'errore'}`);
  return j;
}

// Credenziali giuste? Nome dell'account e numeri che possiede.
export async function verifica() {
  const [conto, numeri] = await Promise.all([api('.json'), api('/IncomingPhoneNumbers.json?PageSize=50')]);
  return {
    conto: conto.friendly_name, stato: conto.status, tipo: conto.type, // type "Trial" = account di prova
    numeri: (numeri.incoming_phone_numbers || []).map((n) => ({ numero: n.phone_number, nome: n.friendly_name, webhook: n.voice_url })),
  };
}

// Imposta su Twilio "A call comes in" → webhook di questo server, metodo POST.
export async function collegaNumero() {
  const { numero } = twilio();
  const webhook = indirizzoWebhook();
  if (!numero) throw new Error('scegli prima il numero');
  if (!webhook) throw new Error("serve l'indirizzo pubblico del server (https://...)");
  if (!webhook.startsWith('https://')) throw new Error("Twilio vuole un indirizzo https://");
  const trovati = await api(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(numero)}`);
  const n = trovati.incoming_phone_numbers?.[0];
  if (!n) throw new Error(`il numero ${numero} non è in questo account Twilio`);
  await api(`/IncomingPhoneNumbers/${n.sid}.json`, { metodo: 'POST', corpo: { VoiceUrl: webhook, VoiceMethod: 'POST' } });
  return { numero: n.phone_number, webhook };
}

export async function inviaSms(a, testo) {
  await api('/Messages.json', { metodo: 'POST', corpo: { From: twilio().numero, To: a, Body: testo } });
}

export async function chiamaNumero(a) {
  if (!urlPubblico()) throw new Error("serve l'indirizzo pubblico del server");
  const j = await api('/Calls.json', { metodo: 'POST', corpo: { From: twilio().numero, To: a, Url: `${indirizzoWebhook()}?uscita=1` } });
  return j.sid;
}

// --- Firma delle richieste di Twilio (X-Twilio-Signature) ---
// HMAC-SHA1, in base64, di: URL completo + parametri POST ordinati per nome, ciascuno come nome+valore.
export function firmaTwilio(url, parametri, authToken) {
  const coppie = parametri instanceof URLSearchParams ? [...parametri.entries()] : Object.entries(parametri || {});
  const per = new Map();
  for (const [k, v] of coppie) per.set(k, [...(per.get(k) || []), String(v)]);
  let dati = url;
  for (const k of [...per.keys()].sort()) for (const v of per.get(k).sort()) dati += k + v;
  return createHmac('sha1', authToken).update(dati, 'utf8').digest('base64');
}

// Twilio può calcolare la firma con o senza la porta di default nell'URL: si prova con tutte e due.
function varianti(url) {
  const u = new URL(url);
  const out = new Set([url]);
  const porta = u.protocol === 'https:' ? '443' : '80';
  const resta = url.slice(url.indexOf(u.host) + u.host.length);
  if (u.port) { if (u.port === porta) out.add(`${u.protocol}//${u.hostname}${resta}`); }
  else out.add(`${u.protocol}//${u.host}:${porta}${resta}`);
  return [...out];
}

const uguali = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// L'URL da firmare è quello pubblico (urlPubblico + percorso + query esatti): dietro un proxy l'Host non è affidabile.
export function firmaValida(percorsoConQuery, parametri, intestazione) {
  const { authToken } = twilio();
  if (!authToken) return { ok: true, verificata: false };
  if (!urlPubblico()) return { ok: false, motivo: "c'è l'Auth Token ma manca l'indirizzo pubblico del server: non posso ricostruire l'URL firmato" };
  if (!intestazione) return { ok: false, motivo: 'manca X-Twilio-Signature' };
  const url = urlPubblico() + percorsoConQuery;
  const ok = varianti(url).some((v) => uguali(firmaTwilio(v, parametri, authToken), String(intestazione)));
  return ok ? { ok: true, verificata: true } : { ok: false, motivo: `firma errata (URL firmato: ${url})` };
}
