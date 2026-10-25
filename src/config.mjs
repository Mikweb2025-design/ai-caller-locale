import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = join(RADICE, '.env');
if (existsSync(env)) process.loadEnvFile(env);

const numero = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const CONFIG = {
  porta: numero(process.env.PORTA, 5050),
  // Indirizzo pubblico del server (https://...), serve a Twilio per raggiungerci.
  urlPubblico: (process.env.URL_PUBBLICO || '').replace(/\/$/, ''),

  // Il motore vocale locale (motore/motore.py): faster-whisper + Qwen3-TTS
  motore: (process.env.MOTORE_URL || `http://127.0.0.1:${process.env.MOTORE_PORTA || 5051}`).replace(/\/$/, ''),

  // Il cervello: Claude Code (comando `claude`), con il tuo abbonamento
  cervello: {
    comando: process.env.CLAUDE_COMANDO || 'claude',
    modello: process.env.CLAUDE_MODELLO || 'haiku', // haiku = il più pronto al telefono
    // impegno "low": primo testo in ~0,65 s invece di ~1,8 s, con risposte che restano buone
    impegno: process.env.CLAUDE_IMPEGNO || 'low', // low | medium | high
  },

  // Quando il cliente ha finito di parlare
  vad: {
    soglia: numero(process.env.VAD_SOGLIA, 700), // energia (RMS su 16 bit) sopra cui è voce
    inizioMs: numero(process.env.VAD_INIZIO_MS, 120), // voce continua per dire "sta parlando"
    silenzioMs: numero(process.env.VAD_SILENZIO_MS, 750), // silenzio dopo cui la frase è finita
    minimoMs: numero(process.env.VAD_MINIMO_MS, 250), // frasi più corte = rumore
    interruzioneMs: numero(process.env.VAD_INTERRUZIONE_MS, 500), // voce continua per interrompere il receptionist
  },
  // se Claude tarda, dopo questi secondi dice "Sì, un attimo." (-1 = mai, il predefinito:
  // detto spesso suona da centralino)
  riempitivoSecondi: numero(process.env.RIEMPITIVO_S, -1),

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    apiKey: process.env.TWILIO_API_KEY,
    apiSecret: process.env.TWILIO_API_SECRET,
    numero: process.env.TWILIO_NUMERO || '', // il numero Twilio che risponde, es. +15551234567
  },
  inviaSms: process.env.INVIA_SMS !== '0',
};

export const twilioConfigurato = () => Boolean(CONFIG.twilio.accountSid && CONFIG.twilio.apiKey && CONFIG.twilio.apiSecret);
