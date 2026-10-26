// Cosa succede quando il receptionist usa uno strumento durante la chiamata.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RADICE } from './config.mjs';
import { twilio, twilioConfigurato, inviaSms } from './twilio.mjs';
import { prenota, testoConferma, aggiungiRichiamo } from './agenda.mjs';
import { impostazioni } from './impostazioni.mjs';

const cartella = join(RADICE, 'registrazioni');
mkdirSync(cartella, { recursive: true, mode: 0o700 });
try { chmodSync(cartella, 0o700); } catch {}
const fileEventi = join(cartella, 'appuntamenti.jsonl');
try { chmodSync(fileEventi, 0o600); } catch {}

function bonificaEventiStorici() {
  if (!existsSync(fileEventi)) return;
  try {
    const righe = readFileSync(fileEventi, 'utf8').split('\n').filter(Boolean);
    let cambiato = false;
    const sicure = righe.map((riga) => {
      let voce;
      try { voce = JSON.parse(riga); } catch { cambiato = true; return null; }
      if (['nome', 'telefono', 'email', 'dettagli', 'motivo'].some((chiave) => Object.hasOwn(voce, chiave))) cambiato = true;
      return {
        id: String(voce.id || ''),
        tipo: String(voce.tipo || (voce.giorno ? 'appuntamento' : 'evento')),
        stato: String(voce.stato || ''),
        creato: String(voce.creato || ''),
      };
    }).filter((voce) => voce?.id);
    if (cambiato) writeFileSync(fileEventi, sicure.map((voce) => JSON.stringify(voce)).join('\n') + (sicure.length ? '\n' : ''), { mode: 0o600 });
    chmodSync(fileEventi, 0o600);
  } catch (errore) {
    console.warn('⚠️ bonifica log eventi non riuscita:', errore.message);
  }
}

bonificaEventiStorici();

function registraEvento(tipo, voce) {
  const evento = { id: voce.id, tipo, stato: voce.stato, creato: voce.creato };
  appendFileSync(fileEventi, JSON.stringify(evento) + '\n', { mode: 0o600 });
  try { chmodSync(fileEventi, 0o600); } catch {}
}

export async function confermaAppuntamento({ nome, giorno, ora, dettagli, email }, chiamata) {
  const telefono = chiamata.chiamante && chiamata.chiamante !== 'browser' ? chiamata.chiamante : '';
  let esito;
  try {
    esito = await prenota({ nome, giorno, ora, dettagli, email, telefono, canale: chiamata.versione === 'web' ? 'browser' : 'telefono' });
  } catch (e) {
    chiamata.log('⚠️ appuntamento non registrato:', e.message);
    return { ok: false, errore: e.message };
  }
  registraEvento('appuntamento', esito.appuntamento);
  chiamata.log('📅 appuntamento registrato', { id: esito.appuntamento.id, stato: esito.appuntamento.stato, emailTitolare: esito.emailTitolare, emailCliente: esito.emailCliente });

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

// Il cliente ha accettato di essere richiamato da un collega: lo segno, senza giorno né orario.
export async function registraRichiamo({ nome, motivo }, chiamata) {
  const telefono = chiamata.chiamante && chiamata.chiamante !== 'browser' ? chiamata.chiamante : '';
  const canale = chiamata.versione === 'web' ? 'browser' : 'telefono';
  try {
    const r = await aggiungiRichiamo({ nome, motivo, telefono, canale });
    registraEvento('richiamo', r);
    chiamata.log('📞 richiamo registrato', { id: r.id, stato: r.stato, contattoDisponibile: Boolean(telefono) });
    return { ok: true, richiamo: r };
  } catch (e) {
    chiamata.log('⚠️ richiamo non registrato:', e.message);
    return { ok: false, errore: e.message };
  }
}
