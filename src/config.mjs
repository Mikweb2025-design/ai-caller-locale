import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RADICE = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = join(RADICE, '.env');
if (existsSync(env)) process.loadEnvFile(env);

const numero = (v, d) => (v === undefined || v === '' ? d : Number(v));
const limitato = (v, d, minimo, massimo) => {
  const n = numero(v, d);
  return Number.isFinite(n) ? Math.min(massimo, Math.max(minimo, n)) : d;
};
const acceso = (v, d = true) => v === undefined || v === '' ? d : !/^(?:0|false|no|off)$/i.test(String(v).trim());

export const CONFIG = {
  porta: numero(process.env.PORTA, 5050),

  // Il motore vocale locale (motore/motore.py): Parakeet (ascolto) + Qwen3-TTS (voce)
  motore: (process.env.MOTORE_URL || `http://127.0.0.1:${process.env.MOTORE_PORTA || 5051}`).replace(/\/$/, ''),

  // Il cervello: Claude Code (comando `claude`), con il tuo abbonamento
  cervello: {
    comando: process.env.CLAUDE_COMANDO || 'claude',
    modello: process.env.CLAUDE_MODELLO || 'haiku', // haiku = il più pronto al telefono
    // impegno "low": primo testo in ~0,65 s invece di ~1,8 s, con risposte che restano buone
    impegno: process.env.CLAUDE_IMPEGNO || 'low', // low | medium | high
  },

  // OpenCode: il server locale usato come cervello alternativo (scheda Cervello del pannello).
  // L'indirizzo si ricava da `opencode service status`; la password dal file di servizio.
  opencode: {
    comando: process.env.OPENCODE_COMANDO || 'opencode',
    agente: process.env.OPENCODE_AGENTE || 'build',
    cartella: process.env.OPENCODE_CARTELLA || join(tmpdir(), 'ai-caller-opencode'),
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

  // Tocchi molto leggeri durante STT/AI: solo al chiamante e rimossi prima della voce.
  tastiera: {
    attiva: acceso(process.env.TASTIERA_ATTESA, true),
    volume: limitato(process.env.TASTIERA_VOLUME, 0.025, 0, 0.04),
  },

  // I log tecnici non contengono trascrizioni o contatti; i file più vecchi vengono rimossi.
  log: {
    conservazioneGiorni: limitato(process.env.LOG_CONSERVAZIONE_GIORNI, 30, 1, 365),
  },

};

