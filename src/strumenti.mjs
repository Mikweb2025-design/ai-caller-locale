// Cosa succede quando il receptionist usa uno strumento durante la chiamata.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RADICE } from './config.mjs';
import { twilio, twilioConfigurato, inviaSms } from './twilio.mjs';
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
  if (impostazioni().sms.attivo && twilioConfigurato() && telefono.startsWith('+') && telefono !== twilio().numero) {
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
