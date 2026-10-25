// Twilio: il numero di telefono vero. Le credenziali si mettono nel pannello admin
// (oppure nel .env, che vale come valore di partenza). Qui: SMS, chiamate in uscita,
// verifica delle credenziali e collegamento automatico del webhook al numero.
import { impostazioni } from './impostazioni.mjs';

export const SEGRETO = process.env.SEGRETO || 'locale';

export function twilio() {
  const t = impostazioni().twilio || {};
  return {
    accountSid: (t.accountSid || process.env.TWILIO_ACCOUNT_SID || '').trim(),
    // API Key (SK...) + secret, oppure Account SID + Auth Token: Twilio accetta tutte e due
    apiKey: (t.apiKey || process.env.TWILIO_API_KEY || '').trim(),
    apiSecret: (t.apiSecret || process.env.TWILIO_API_SECRET || '').trim(),
    numero: (t.numero || process.env.TWILIO_NUMERO || '').replace(/\s+/g, ''),
  };
}

export const urlPubblico = () => (impostazioni().twilio?.urlPubblico || process.env.URL_PUBBLICO || '').trim().replace(/\/$/, '');
export const twilioConfigurato = () => { const t = twilio(); return Boolean(t.accountSid && t.apiSecret); };
export const indirizzoWebhook = () => (urlPubblico() ? `${urlPubblico()}/twilio/${SEGRETO}/voce` : '');

async function api(percorso, { metodo = 'GET', corpo } = {}) {
  const t = twilio();
  if (!t.accountSid || !t.apiSecret) throw new Error('mancano Account SID e chiave/Auth Token di Twilio');
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}${percorso}`, {
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
