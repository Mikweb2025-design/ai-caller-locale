// Il lato Twilio di una chiamata (Media Streams): riceve l'audio del telefono e ci rimanda
// quello del receptionist, tenendo il conto di cosa il cliente ha davvero già sentito.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, RADICE } from './config.mjs';

const cartellaLog = join(RADICE, 'registrazioni');
mkdirSync(cartellaLog, { recursive: true, mode: 0o700 });
try { chmodSync(cartellaLog, 0o700); } catch {}
const scadenzaLog = Date.now() - CONFIG.log.conservazioneGiorni * 86400000;
export function bonificaTestoLog(contenuto) {
  return String(contenuto || '').split('\n').map((riga) => riga
    .replace(/(👤|🤖|⌨️|🔧|📅|📞|✉️)[^\n]*/gu, '$1 [dato personale storico rimosso]')
    .replace(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi, '[email rimossa]')
    .replace(/\/(web|admin)\/[a-z0-9_-]{16,}/gi, '/$1/<SEGRETO>')
    .replace(/(?:\+?\d[\s,().-]*){8,}/g, '[telefono rimosso]'))
    .join('\n');
}

let logStoriciBonificati = 0;
for (const nome of readdirSync(cartellaLog)) {
  if (!nome.endsWith('.log')) continue;
  const file = join(cartellaLog, nome);
  try {
    if (statSync(file).mtimeMs < scadenzaLog) unlinkSync(file);
    else {
      const prima = readFileSync(file, 'utf8');
      const dopo = bonificaTestoLog(prima);
      if (dopo !== prima) {
        writeFileSync(file, dopo, { mode: 0o600 });
        logStoriciBonificati += 1;
      }
      chmodSync(file, 0o600);
    }
  } catch {}
}
if (logStoriciBonificati) console.log(`🔒 bonificati ${logStoriciBonificati} log storici`);

export class ChiamataTwilio {
  constructor(ws, versione, { web = false } = {}) {
    this.ws = ws;
    this.web = web; // chiamata dal browser: riceve anche la trascrizione e può scrivere
    this.versione = versione;
    this.streamSid = null;
    this.callSid = null;
    this.chiamante = null;
    this.parametri = {};
    this.t0 = Date.now();
    this.msTwilio = 0; // timestamp dell'ultimo pacchetto audio ricevuto dal telefono
    this.marche = []; // marche inviate e non ancora tornate (= audio non ancora riprodotto)
    this.contatoreMarche = 0;
    this.chiusa = false;
    this.alPartire = null;
    this.hoRicevutoAudio = false;
    this.alAudio = null;
    this.allaFine = null;
    this.allaMarca = null;
    this.file = null;

    ws.on('message', (dati) => {
      let m;
      try { m = JSON.parse(dati); } catch { return; }
      switch (m.event) {
        case 'start':
          this.streamSid = m.start.streamSid;
          this.callSid = m.start.callSid;
          this.parametri = m.start.customParameters || {};
          this.chiamante = this.parametri.from || null;
          this.file = join(cartellaLog, `${new Date().toISOString().replace(/[:.]/g, '-')}-${versione}.log`);
          this.log('📞 chiamata', { callSid: this.callSid, web: this.web, contattoDisponibile: Boolean(this.chiamante && this.chiamante !== 'browser') });
          Promise.resolve(this.alPartire?.()).catch((e) => {
            this.log('errore avvio chiamata', e.message);
            this.ws.close();
          });
          break;
        case 'media':
          this.hoRicevutoAudio = true;
          this.msTwilio = Number(m.media.timestamp);
          this.alAudio?.(m.media.payload);
          break;
        case 'mark': {
          const i = this.marche.indexOf(m.mark.name);
          if (i >= 0) this.marche.splice(0, i + 1);
          this.allaMarca?.(m.mark.name);
          break;
        }
        case 'testo': // solo dal browser: frase scritta in chat
          if (this.web) Promise.resolve(this.alTestoScritto?.(String(m.testo || '').slice(0, 500)))
            .catch((e) => this.log('errore testo chiamata', e.message));
          break;
        case 'stop':
          this.log('📴 Twilio ha chiuso lo stream');
          break;
      }
    });
    ws.on('close', () => { this.chiusa = true; this.log('fine chiamata'); this.allaFine?.(); });
    ws.on('error', (e) => this.log('errore websocket Twilio', e.message));
  }

  // trascrizione per la pagina web (Twilio non la riceve)
  testo(chi, testo) {
    if (this.web && !this.chiusa) this.ws.send(JSON.stringify({ event: 'testo', chi, testo }));
  }

  get sta_parlando() { return this.marche.length > 0; }

  // Aspetta il primo pacchetto audio del chiamante: quando arriva, il percorso audio
  // della telefonata è davvero aperto (prima, i primi istanti si perdono).
  async aspettaIngresso(massimoMs = 700) {
    const fine = Date.now() + massimoMs;
    while (!this.hoRicevutoAudio && !this.chiusa && Date.now() < fine) await new Promise((r) => setTimeout(r, 20));
    return this.hoRicevutoAudio;
  }

  inviaAudio(base64) {
    if (this.chiusa || !this.streamSid) return;
    this.ws.send(JSON.stringify({ event: 'media', streamSid: this.streamSid, media: { payload: base64 } }));
  }

  marca(nome = `m${++this.contatoreMarche}`) {
    if (this.chiusa || !this.streamSid) return nome;
    this.marche.push(nome);
    this.ws.send(JSON.stringify({ event: 'mark', streamSid: this.streamSid, mark: { name: nome } }));
    return nome;
  }

  // Butta via l'audio non ancora riprodotto (il cliente ha interrotto).
  svuota() {
    if (this.chiusa || !this.streamSid) return;
    this.ws.send(JSON.stringify({ event: 'clear', streamSid: this.streamSid }));
    this.marche = [];
  }

  // Aspetta che il cliente abbia sentito tutto l'audio già inviato.
  async finitoDiParlare(massimoMs = 15000) {
    const fine = Date.now() + massimoMs;
    while (this.marche.length > 0 && !this.chiusa && Date.now() < fine) await new Promise((r) => setTimeout(r, 50));
  }

  riaggancia() {
    if (this.chiusa) return;
    this.log('📴 il receptionist chiude la chiamata');
    this.ws.close();
  }

  log(...a) {
    const riga = `[${((Date.now() - this.t0) / 1000).toFixed(2)}s] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    console.log(`[${this.versione}] ${riga}`);
    if (this.file) {
      appendFileSync(this.file, riga + '\n', { mode: 0o600 });
      try { chmodSync(this.file, 0o600); } catch {}
    }
  }

  // Per dati personali scrive soltanto tipo e metadati tecnici, mai il contenuto.
  logSensibile(tipo, metadati = {}) {
    this.log(tipo, metadati);
  }
}
