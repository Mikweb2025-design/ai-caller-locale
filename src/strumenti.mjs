// Cosa succede quando il receptionist usa uno strumento durante la chiamata.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, RADICE, twilioConfigurato } from './config.mjs';
import { prenota, testoConferma } from './agenda.mjs';
import { impostazioni } from './impostazioni.mjs';

const cartella = join(RADICE, 'registrazioni');
mkdirSync(cartella, { recursive: true });

export async function confermaAppuntamento({ nome, giorno, ora, dettagli, email }, chiamata) {
  const telefono = chiamata.chiamante && chiamata.chiamante !== 'browser' ? chiamata.chiamante : '';
  let esito;
  try {
    esito = await prenota({ nome, giorno, ora, dettagli, email, telefono, canale: chiamata.versione === 'web' ? 'browser' : 'telefono' });
  } catch (e) {
    chiamata.log('⚠️ appuntamento non registrato:', e.message);
    return { ok: false, errore: e.message };
  }
  appendFileSync(join(cartella, 'appuntamenti.jsonl'), JSON.stringify(esito.appuntamento) + '\n');
  chiamata.log('📅 appuntamento', esito.appuntamento, esito.errore ? `⚠️ email: ${esito.errore}` : `email titolare: ${esito.emailTitolare}, cliente: ${esito.emailCliente}`);

  let sms = 'non inviato';
  if (impostazioni().sms.attivo && twilioConfigurato() && telefono.startsWith('+') && telefono !== CONFIG.twilio.numero) {
    try {
      await inviaSms(telefono, testoConferma(esito.appuntamento));
      sms = 'inviato';
    } catch (e) {
      chiamata.log('⚠️ SMS non partito:', e.message);
      sms = 'errore';
    }
  }
  chiamata.log('✉️ SMS', sms);
  return { ok: true, ...esito, sms };
}

async function inviaSms(a, testo) {
  const { accountSid, apiKey, apiSecret, numero } = CONFIG.twilio;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: numero, To: a, Body: testo }),
  });
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

export async function chiamaNumero(a) {
  const { accountSid, apiKey, apiSecret, numero } = CONFIG.twilio;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: numero, To: a, Url: `${CONFIG.urlPubblico}/twilio/${process.env.SEGRETO}/voce?uscita=1` }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Twilio ${r.status}: ${j.message}`);
  return j.sid;
}
