// Il cervello del receptionist: Claude Code, tenuto aperto per tutta la telefonata.
// Un solo processo `claude -p` in modalità stream-json: ogni frase del cliente entra come
// messaggio, il testo della risposta esce token per token mentre viene scritto.
// Niente strumenti, niente MCP, niente impostazioni del progetto: solo il personaggio.
import { spawn } from 'node:child_process';
import { CONFIG } from './config.mjs';

export class Cervello {
  constructor(istruzioni) {
    this.inviati = 0; // messaggi del cliente mandati
    this.finiti = 0; // risposte complete ricevute
    this.alTesto = null; // (pezzo, turno)
    this.allaFine = null; // (testoCompleto, turno)
    this.testo = '';
    this.chiuso = false;
    this.p = spawn(CONFIG.cervello.comando, [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--model', CONFIG.cervello.modello, '--effort', CONFIG.cervello.impegno,
      '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
      '--system-prompt', istruzioni,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // niente "ragionamento" prima di rispondere: al telefono sono secondi di silenzio
      env: { ...process.env, MAX_THINKING_TOKENS: '0' },
    });
    let buf = '';
    this.p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const riga = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let e;
        try { e = JSON.parse(riga); } catch { continue; }
        this.#evento(e);
      }
    });
    this.p.stderr.on('data', (d) => process.stderr.write(`[claude] ${d}`));
    this.p.on('exit', () => { this.chiuso = true; });
    this.p.stdin.on('error', () => {});
  }

  #evento(e) {
    const turno = this.finiti + 1;
    if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') {
      this.testo += e.event.delta.text;
      this.alTesto?.(e.event.delta.text, turno);
    } else if (e.type === 'result') {
      const t = this.testo;
      this.testo = '';
      this.finiti++;
      if (e.is_error) console.error('[claude] errore:', e.result);
      this.allaFine?.(t, turno);
    }
  }

  // Manda la frase del cliente; restituisce il numero del turno della risposta.
  ascolta(frase) {
    if (this.chiuso) return -1;
    this.p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: frase } }) + '\n');
    return ++this.inviati;
  }

  chiudi() {
    if (this.chiuso) return;
    this.chiuso = true;
    this.p.stdin.end();
    setTimeout(() => this.p.kill(), 2000).unref();
  }
}
