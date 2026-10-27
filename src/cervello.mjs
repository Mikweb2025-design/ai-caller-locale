// Il cervello del receptionist. Tre tipi, a scelta nel pannello admin (scheda Cervello):
//  - Claude Code: un processo `claude -p` aperto per tutta la telefonata (token, chiave API
//    Anthropic o il login già fatto sul computer);
//  - OpenCode: il server OpenCode già aperto sul computer, con i modelli che ha collegato
//    (per esempio IONOS). Una sessione per telefonata, testo in streaming;
//  - servizi compatibili OpenAI (Gemini, Groq, Cerebras, Mistral, OpenRouter, OpenAI, Ollama,
//    IONOS...): una richiesta in streaming per ogni frase del cliente.
// In più una riserva: se il principale sbaglia, ha raggiunto il limite gratuito o tarda troppo,
// risponde lei. Il testo esce sempre token per token, con la stessa interfaccia.
import { spawn, execFileSync } from 'node:child_process';
import { consensoPrenotazione, congedoCliente } from './consenso.mjs';
import { numeriInParole } from './parlato.mjs';
import { creaRegolatoreIntercalari } from './intercalari.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG } from './config.mjs';
import { impostazioni } from './impostazioni.mjs';

// Servizi pronti: indirizzo, un modello di partenza (l'elenco vero si chiede al servizio)
// e cosa sapere prima di usarlo.
export const SERVIZI_CERVELLO = {
  claude: { nome: 'Claude Code', tipo: 'claude', modello: 'haiku', aiuto: 'Con il login già fatto sul computer non serve niente. Per un server: nel terminale `claude setup-token` e incolla qui il token (sk-ant-oat…), oppure una chiave API Anthropic (sk-ant-api…).' },
  opencode: { nome: 'OpenCode (server locale)', tipo: 'opencode', url: '', modello: 'ionos/openai/gpt-oss-120b', aiuto: 'Usa il server OpenCode già aperto sul computer e i modelli che ha collegato. Il modello si scrive provider/modello, per esempio ionos/openai/gpt-oss-120b oppure opencode/deepseek-v4.1-flash-free. Non serve una chiave: OpenCode usa le sue.' },
  groq: { nome: 'Groq (gratis, velocissimo)', tipo: 'openai', url: 'https://api.groq.com/openai/v1', modello: 'llama-3.3-70b-versatile', aiuto: 'Chiave gratuita su console.groq.com → API Keys. Limiti gratuiti: circa 30 richieste al minuto.' },
  gemini: { nome: 'Google Gemini (gratis, pochi limiti)', tipo: 'openai', url: 'https://generativelanguage.googleapis.com/v1beta/openai', modello: 'gemini-flash-latest', aiuto: 'Chiave gratuita su aistudio.google.com → Get API key. Il piano gratuito ha pochissime richieste al giorno: meglio come riserva. Fuori dall’Unione Europea il gratuito può usare i dati per addestrare i modelli.' },
  openrouter: { nome: 'OpenRouter (modelli :free)', tipo: 'openai', url: 'https://openrouter.ai/api/v1', modello: 'meta-llama/llama-3.3-70b-instruct:free', aiuto: 'Chiave su openrouter.ai/keys. Senza credito: 50 richieste al giorno; con 10 $ una tantum, 1.000.' },
  cerebras: { nome: 'Cerebras (gratis, veloce)', tipo: 'openai', url: 'https://api.cerebras.ai/v1', modello: 'llama-3.3-70b', aiuto: 'Chiave su cloud.cerebras.ai. Può chiedere una carta prima di sbloccare il credito gratuito.' },
  mistral: { nome: 'Mistral', tipo: 'openai', url: 'https://api.mistral.ai/v1', modello: 'mistral-small-latest', aiuto: 'Chiave su console.mistral.ai. Il piano gratuito chiede la verifica del telefono e può usare i dati per addestrare i modelli.' },
  openai: { nome: 'OpenAI (a pagamento)', tipo: 'openai', url: 'https://api.openai.com/v1', modello: 'gpt-4o-mini', aiuto: 'Solo chiave API a pagamento (platform.openai.com). L’account ChatGPT gratuito non si può collegare.' },
  ionos: { nome: 'IONOS AI Model Hub', tipo: 'openai', url: 'https://openai.inference.ionos.com/openai/v1', modello: 'meta-llama/Llama-3.3-70B-Instruct', aiuto: 'Token del tuo contratto IONOS (Data Center Designer → Token manager).' },
  ollama: { nome: 'Ollama (sul tuo computer)', tipo: 'openai', url: 'http://127.0.0.1:11434/v1', modello: '', aiuto: 'Nessuna chiave. Gratis e senza limiti, ma i modelli locali sono più lenti: meglio come ultima riserva.' },
  altro: { nome: 'Altro servizio compatibile OpenAI', tipo: 'openai', url: 'https://', modello: '', aiuto: "L'indirizzo che finisce con /v1 e la chiave del servizio." },
};

export const PREDEFINITO = {
  principale: { servizio: 'claude', url: '', chiave: '', modello: CONFIG.cervello.modello, impegno: CONFIG.cervello.impegno },
  riserva: { servizio: '', url: '', chiave: '', modello: '', impegno: '' },
};

const FRASE_GUASTO = 'Mi scusi, ho un problema con la linea. Può richiamare tra qualche minuto?';

// Una configurazione completa del servizio (indirizzo e modello di partenza se mancano).
export function risolvi(c) {
  const sv = SERVIZI_CERVELLO[c?.servizio];
  if (!sv) return null;
  return { ...c, tipo: sv.tipo, nome: sv.nome, url: (c.url || sv.url || '').replace(/\/$/, ''), modello: c.modello || sv.modello, impegno: c.impegno || 'low' };
}

// --- OpenCode: il server locale che fa da cervello ---
// Il modello si scrive "provider/modello" (ionos/openai/gpt-oss-120b). Il server è quello
// del servizio OpenCode già in esecuzione; la password sta nel suo file di servizio.
let urlOpenCode = '';
function indirizzoOpenCode(c) {
  if (c.url && /^https?:\/\//.test(c.url)) return c.url.replace(/\/$/, '');
  if (process.env.OPENCODE_URL) return process.env.OPENCODE_URL.replace(/\/$/, '');
  if (urlOpenCode) return urlOpenCode;
  try {
    const out = execFileSync(CONFIG.opencode.comando, ['service', 'status'], { encoding: 'utf8', timeout: 4000 }).trim();
    const m = out.match(/https?:\/\/[^\s]+/);
    if (m) return (urlOpenCode = m[0].replace(/\/$/, ''));
  } catch {}
  return (urlOpenCode = 'http://127.0.0.1:49374');
}

function chiaveOpenCode(c) {
  if (c.chiave) return c.chiave;
  try { return JSON.parse(readFileSync(join(homedir(), '.config/opencode/service.json'), 'utf8')).password || ''; } catch { return ''; }
}

function intestazioniOpenCode(c) {
  const password = chiaveOpenCode(c);
  return {
    'Content-Type': 'application/json',
    ...(password ? { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } : {}),
  };
}

function modelloOpenCode(c) {
  const testo = String(c.modello || '');
  const taglio = testo.indexOf('/');
  if (taglio < 1 || taglio === testo.length - 1) throw new Error('modello OpenCode scritto come provider/modello, per esempio ionos/openai/gpt-oss-120b');
  const providerID = testo.slice(0, taglio);
  const id = testo.slice(taglio + 1);
  return { providerID, id, ...(/gpt-oss/i.test(id) ? { variant: c.variante || 'low' } : c.variante ? { variant: c.variante } : {}) };
}

function messaggioOpenCode(status, dettaglio) {
  const base = MESSAGGI_HTTP[status] || `errore ${status}`;
  return `${base}${dettaglio ? ` (${dettaglio})` : ''}`;
}


// --- Claude Code ---
class CervelloClaude {
  constructor(istruzioni, c) {
    this.inviati = 0; this.finiti = 0; this.testo = ''; this.chiuso = false;
    this.alTesto = null; this.allaFine = null; this.alErrore = null;
    const env = { ...process.env, MAX_THINKING_TOKENS: '0' }; // niente "ragionamento": al telefono sono secondi di silenzio
    if (c.chiave) {
      if (c.chiave.startsWith('sk-ant-api')) env.ANTHROPIC_API_KEY = c.chiave; else env.CLAUDE_CODE_OAUTH_TOKEN = c.chiave;
    }
    this.p = spawn(CONFIG.cervello.comando, [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--model', c.modello, '--effort', c.impegno,
      '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
      '--system-prompt', istruzioni,
    ], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let buf = '';
    this.p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const riga = buf.slice(0, i); buf = buf.slice(i + 1);
        let e; try { e = JSON.parse(riga); } catch { continue; }
        this.#evento(e);
      }
    });
    this.p.stderr.on('data', (d) => process.stderr.write(`[claude] ${d}`));
    this.p.on('exit', () => { this.chiuso = true; });
    this.p.on('error', (e) => { this.chiuso = true; this.alErrore?.(this.finiti + 1, `Claude Code non parte: ${e.message}`, false); });
    this.p.stdin.on('error', () => {});
  }

  #evento(e) {
    const turno = this.finiti + 1;
    if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') {
      this.testo += e.event.delta.text;
      this.alTesto?.(e.event.delta.text, turno);
    } else if (e.type === 'result') {
      const t = this.testo; this.testo = ''; this.finiti++;
      if (e.is_error) this.alErrore?.(turno, String(e.result || 'errore di Claude').slice(0, 200), Boolean(t));
      else this.allaFine?.(t, turno);
    }
  }

  // storia: la conversazione fatta finora da un altro cervello (se questo subentra a metà chiamata)
  ascolta(frase, storia = []) {
    if (this.chiuso) { queueMicrotask(() => this.alErrore?.(this.inviati + 1, 'Claude Code non è in esecuzione', false)); return ++this.inviati; }
    let testo = frase;
    if (this.inviati === 0 && storia.length) {
      testo = `Conversazione finora:\n${storia.map((m) => `${m.ruolo === 'cliente' ? 'Cliente' : 'Tu'}: ${m.testo}`).join('\n')}\n\nUltima frase del cliente, a cui rispondi ora: ${frase}`;
    }
    this.p.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: testo } }) + '\n');
    return ++this.inviati;
  }

  chiudi() {
    if (this.chiuso) return;
    this.chiuso = true;
    this.p.stdin.end();
    setTimeout(() => this.p.kill(), 2000).unref();
  }
}

// --- Servizi compatibili OpenAI (chat/completions in streaming) ---
// Alcuni modelli scrivono il "pensiero" tra <think>…</think>: non va letto al telefono.
function senzaPensiero() {
  let dentro = false, resto = '';
  return (pezzo) => {
    let t = resto + pezzo; resto = ''; let out = '';
    for (;;) {
      if (dentro) { const i = t.indexOf('</think>'); if (i < 0) { resto = t.slice(-8); return out; } t = t.slice(i + 8).replace(/^\s+/, ''); dentro = false; }
      else {
        const i = t.indexOf('<think>');
        if (i >= 0) { out += t.slice(0, i); t = t.slice(i + 7); dentro = true; continue; }
        const parziale = t.match(/<(t(h(i(n(k)?)?)?)?)?$/); // tag spezzato fra due pezzi
        if (parziale) { out += t.slice(0, parziale.index); resto = parziale[0]; } else out += t;
        return out;
      }
    }
  };
}

const MESSAGGI_HTTP = { 401: 'chiave non valida', 403: 'chiave senza permessi o servizio non disponibile nel tuo paese', 404: 'modello o indirizzo non trovato', 429: 'limite di richieste raggiunto' };

class CervelloApi {
  constructor(istruzioni, c) {
    this.istruzioni = istruzioni; this.c = c;
    this.inviati = 0; this.chiuso = false; this.storia = [];
    this.alTesto = null; this.allaFine = null; this.alErrore = null;
    this.controllo = null;
  }

  ascolta(frase, storia = []) {
    const turno = ++this.inviati;
    if (this.storia.length === 0 && storia.length) this.storia = storia.map((m) => ({ role: m.ruolo === 'cliente' ? 'user' : 'assistant', content: m.testo }));
    const messaggio = { role: 'user', content: frase };
    this.storia.push(messaggio);
    this.controllo?.abort(); // la frase precedente non serve più: si risparmia la quota
    this.controllo = new AbortController();
    this.#richiedi(turno, this.controllo, true, messaggio);
    return turno;
  }

  async #richiedi(turno, controllo, conRagionamentoBasso, messaggio) {
    const { url, chiave, modello } = this.c;
    let testo = '', haParlato = false;
    try {
      const corpo = { model: modello, stream: true, temperature: 0.55, max_tokens: 400, messages: [{ role: 'system', content: this.istruzioni }, ...this.storia] };
      if (conRagionamentoBasso && /gpt-oss/i.test(modello)) corpo.reasoning_effort = 'low'; // meno attesa prima di parlare
      const r = await fetch(`${url}/chat/completions`, {
        method: 'POST', signal: AbortSignal.any([controllo.signal, AbortSignal.timeout(30000)]),
        headers: { 'Content-Type': 'application/json', ...(chiave ? { Authorization: `Bearer ${chiave}` } : {}) },
        body: JSON.stringify(corpo),
      });
      if (!r.ok) {
        const dettaglio = (await r.text().catch(() => '')).slice(0, 200);
        if (r.status === 400 && corpo.reasoning_effort) return this.#richiedi(turno, controllo, false, messaggio); // il modello non accetta quel parametro
        const e = new Error(`${MESSAGGI_HTTP[r.status] || `errore ${r.status}`}${dettaglio ? ` (${dettaglio.replace(/\s+/g, ' ')})` : ''}`);
        e.limite = r.status === 429; e.chiave = r.status === 401 || r.status === 403;
        throw e;
      }
      const filtro = senzaPensiero();
      const lettore = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await lettore.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const riga = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!riga.startsWith('data:')) continue;
          const dati = riga.slice(5).trim();
          if (dati === '[DONE]') continue;
          let j; try { j = JSON.parse(dati); } catch { continue; }
          if (j.error) throw new Error(String(j.error.message || j.error).slice(0, 200));
          const pezzo = filtro(j.choices?.[0]?.delta?.content || '');
          if (pezzo) { testo += pezzo; haParlato = true; this.alTesto?.(pezzo, turno); }
        }
      }
      if (!testo.trim()) throw new Error('risposta vuota');
      this.storia.push({ role: 'assistant', content: testo });
      this.allaFine?.(testo, turno);
    } catch (e) {
      if (controllo.signal.aborted) return; // sostituita da una frase più nuova
      // toglie la PROPRIA frase rimasta senza risposta: un pop() cieco poteva togliere
      // la frase del turno successivo, già arrivata nel frattempo (memoria che si perdeva).
      const i = this.storia.indexOf(messaggio);
      if (i >= 0) this.storia.splice(i, 1);
      this.alErrore?.(turno, e.name === 'TimeoutError' ? 'il servizio non risponde' : e.message, haParlato, e);
    }
  }

  annulla() { this.controllo?.abort(); } // la richiesta in corso non serve più (si passa alla riserva)
  chiudi() { this.chiuso = true; this.controllo?.abort(); }
}

// --- OpenCode (server locale, sessione per telefonata) ---
const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

class CervelloOpenCode {
  constructor(istruzioni, c) {
    this.istruzioni = istruzioni; this.c = c;
    this.base = indirizzoOpenCode(c);
    this.intestazioni = intestazioniOpenCode(c);
    this.inviati = 0; this.chiuso = false;
    this.alTesto = null; this.allaFine = null; this.alErrore = null;
    this.sessione = null; this.lettore = null;
    this.controlloEventi = null;
    this.coda = Promise.resolve();
    this.inCorso = null; this.ultimo = null;
    try { mkdirSync(CONFIG.opencode.cartella, { recursive: true }); } catch {}
    this.pronta = this.#apri();
    this.pronta.catch(() => {}); // l'errore viene consegnato al primo turno
  }

  async #apri() {
    const r = await fetch(`${this.base}/api/session`, {
      method: 'POST', headers: this.intestazioni, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        title: `Telefonata ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        agent: CONFIG.opencode.agente,
        model: modelloOpenCode(this.c),
        location: { directory: CONFIG.opencode.cartella },
        permissions: [{ action: '*', resource: '*', effect: 'deny' }],
        metadata: { origine: 'ai-caller-cosmio' },
      }),
    });
    if (!r.ok) {
      const dettaglio = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      throw new Error(messaggioOpenCode(r.status, dettaglio));
    }
    const j = await r.json();
    this.sessione = j?.data?.id;
    if (!this.sessione) throw new Error('OpenCode non ha aperto la sessione');
    await this.#connetti();
  }

  async #connetti() {
    this.controlloEventi = new AbortController();
    const r = await fetch(`${this.base}/api/event`, { headers: this.intestazioni, signal: this.controlloEventi.signal });
    if (!r.ok) throw new Error(messaggioOpenCode(r.status, 'eventi OpenCode non disponibili'));
    this.lettore = r.body.getReader();
    void this.#leggiEventi().catch(() => {});
  }

  async #leggiEventi() {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await this.lettore.read();
        if (done || this.chiuso) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const blocco = buf.slice(0, i); buf = buf.slice(i + 2);
          const dati = blocco.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!dati) continue;
          let e; try { e = JSON.parse(dati); } catch { continue; }
          const sid = e?.data?.sessionID || e?.sessionID;
          if (sid !== this.sessione) continue;
          this.#evento(e);
        }
      }
    } catch (e) {
      if (!this.chiuso) console.error(`⚠️ eventi OpenCode: ${e.message}`);
    }
  }

  #evento(e) {
    const t = this.inCorso;
    if (!t) return;
    if (e.type === 'session.step.started' && e.data?.assistantMessageID && !t.messaggio) t.messaggio = e.data.assistantMessageID;
    if (e.type === 'session.text.delta') {
      if (e.data?.assistantMessageID && t.messaggio && e.data.assistantMessageID !== t.messaggio) return;
      if (!t.messaggio) t.messaggio = e.data?.assistantMessageID;
      const pezzo = e.data?.delta || '';
      if (!pezzo) return;
      t.testo += pezzo;
      if (!t.annullato) this.alTesto?.(pezzo, t.n);
      return;
    }
    if (e.type === 'session.execution.succeeded') { this.#fine(t, null); return; }
    if (e.type === 'session.execution.failed') {
      const err = e.data?.error || e.error || {};
      const msg = String(err.message || err.type || 'errore OpenCode').slice(0, 220);
      this.#fine(t, msg, err.status || err.statusCode);
      return;
    }
    if (e.type === 'session.execution.interrupted') this.#fine(t, t.annullato ? null : 'risposta interrotta');
  }

  #fine(t, errore, status) {
    if (t.finito) return;
    t.finito = true;
    t._risolvi?.();
    if (this.inCorso === t) this.inCorso = null;
    if (t.annullato) return;
    if (errore) {
      const e = new Error(errore);
      e.limite = status === 429 || /limite|limit|429/i.test(errore);
      e.chiave = status === 401 || status === 403;
      this.alErrore?.(t.n, errore, Boolean(t.testo.trim()), e);
      return;
    }
    if (!t.testo.trim()) { this.alErrore?.(t.n, 'risposta vuota', false); return; }
    this.allaFine?.(t.testo, t.n);
  }

  #prompt(t) {
    const parti = [];
    if (t.n === 1) {
      parti.push('ISTRUZIONI PER LA CHIAMATA (seguile alla lettera, sono la tua unica fonte):');
      parti.push(this.istruzioni);
      if (t.storia.length) {
        parti.push('Conversazione già avvenuta:');
        parti.push(t.storia.map((m) => `${m.ruolo === 'cliente' ? 'Cliente' : 'Tu'}: ${m.testo}`).join('\n'));
      }
      parti.push('---');
    }
    parti.push(`Cliente al telefono: "${t.frase}"`);
    parti.push(t.n === 1 ? 'Rispondi ora come il receptionist, solo con le parole da pronunciare.' : 'Rispondi come il receptionist, solo con le parole da pronunciare.');
    parti.push('Promemoria: scrivi <<CONFERMA|...>> una sola volta, e solo quando hai già nome, giorno, ora e dettagli e il cliente ha confermato; prima non scriverlo. Non ripeterlo nelle risposte successive.');
    parti.push('Usa solo i giorni e gli orari dell’elenco dei posti liberi, senza inventarli; dì date e orari in lettere, mai in cifre (le cifre vanno solo dentro i marcatori).');
    return parti.join('\n\n');
  }

  // storia: la conversazione fatta finora da un altro cervello (se questo subentra a metà chiamata)
  ascolta(frase, storia = []) {
    const t = {
      n: ++this.inviati, frase, storia: this.inviati === 1 ? storia : [],
      testo: '', messaggio: null, finito: false, annullato: false,
    };
    t.attesa = new Promise((r) => { t._risolvi = r; });
    if (this.ultimo) this.ultimo.annullato = true;
    this.ultimo = t;
    this.coda = this.coda.then(() => this.#manda(t));
    this.coda.catch(() => {});
    return t.n;
  }

  async #manda(t) {
    try {
      await this.pronta;
      if (t.annullato) return;
      if (this.inCorso && !this.inCorso.finito) {
        this.inCorso.annullato = true;
        await this.#interrompi();
        await Promise.race([this.inCorso.attesa, attesa(1500)]);
      }
      if (t.annullato) return;
      this.inCorso = t;
      const r = await fetch(`${this.base}/api/session/${this.sessione}/prompt`, {
        method: 'POST', headers: this.intestazioni, signal: AbortSignal.timeout(30000),
        body: JSON.stringify({ text: this.#prompt(t), delivery: 'queue' }),
      });
      if (!r.ok) {
        const dettaglio = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        throw new Error(messaggioOpenCode(r.status, dettaglio));
      }
    } catch (e) {
      if (t.annullato || t.finito) return;
      t.finito = true;
      t._risolvi?.();
      if (this.inCorso === t) this.inCorso = null;
      this.alErrore?.(t.n, e.name === 'TimeoutError' ? 'OpenCode non risponde' : e.message, false, e);
    }
  }

  async #interrompi() {
    if (!this.sessione) return;
    try {
      await fetch(`${this.base}/api/session/${this.sessione}/interrupt`, {
        method: 'POST', headers: this.intestazioni, signal: AbortSignal.timeout(2000),
      });
    } catch {}
  }

  annulla() {
    if (this.inCorso) { this.inCorso.annullato = true; void this.#interrompi(); }
    if (this.ultimo) this.ultimo.annullato = true;
  }

  chiudi() {
    if (this.chiuso) return;
    this.chiuso = true;
    this.annulla();
    try { this.controlloEventi?.abort(); } catch {}
    try { this.lettore?.cancel().catch(() => {}); } catch {}
    const sessione = this.sessione;
    if (sessione) fetch(`${this.base}/api/session/${sessione}`, { method: 'DELETE', headers: this.intestazioni, signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
}

function crea(istruzioni, c) {
  if (c.tipo === 'claude') return new CervelloClaude(istruzioni, c);
  if (c.tipo === 'opencode') return new CervelloOpenCode(istruzioni, c);
  return new CervelloApi(istruzioni, c);
}

// --- Il cervello della telefonata: principale + riserva ---
const pausa = new Map(); // servizio+modello → fino a quando evitarlo (limite raggiunto, chiave errata)
const chiaveBackend = (c) => `${c.servizio}|${c.modello}`;
const PRIMO_TESTO_MAX_MS = 9000;

export class Cervello {
  constructor(istruzioni) {
    const { cervello } = impostazioni();
    this.istruzioni = istruzioni;
    this.configurazioni = [risolvi(cervello?.principale) || risolvi(PREDEFINITO.principale), risolvi(cervello?.riserva)].filter(Boolean);
    this.backend = this.configurazioni.map(() => null);
    this.attivo = 0; // indice del cervello che sta rispondendo
    this.storia = []; // { ruolo: 'cliente'|'receptionist', testo }
    this.turni = 0; this.corrente = null;
    this.chiuso = false;
    this.alTesto = null; this.allaFine = null;
    // il principale parte subito (Claude Code impiega un po' ad avviarsi); la riserva solo se Claude Code
    this.#prepara(0);
    if (this.configurazioni[1]?.tipo === 'claude') this.#prepara(1);
    // se il principale è in pausa (limite raggiunto poco fa) si parte dalla riserva
    if (this.configurazioni.length > 1 && (pausa.get(chiaveBackend(this.configurazioni[0])) || 0) > Date.now()) this.attivo = 1;
  }

  get nome() { return this.configurazioni[this.attivo]?.nome; }

  #prepara(i) {
    if (this.backend[i]) return this.backend[i];
    const b = crea(this.istruzioni, this.configurazioni[i]);
    b.alTesto = (pezzo, n) => this.#suTesto(i, n, pezzo);
    b.allaFine = (testo, n) => this.#suFine(i, n, testo);
    b.alErrore = (n, msg, haParlato, e) => this.#suErrore(i, n, msg, haParlato, e);
    return (this.backend[i] = b);
  }

  #mio(i, n) { return this.corrente && this.corrente.indice === i && this.corrente.interno === n && !this.corrente.chiuso; }

  #suTesto(i, n, pezzo) {
    if (!this.#mio(i, n)) return;
    this.corrente.haParlato = true;
    clearTimeout(this.corrente.timer);
    this.alTesto?.(pezzo, this.corrente.esterno);
  }

  #suFine(i, n, testo) {
    if (!this.#mio(i, n)) return;
    const c = this.corrente; c.chiuso = true; clearTimeout(c.timer);
    this.storia.push({ ruolo: 'receptionist', testo });
    this.allaFine?.(testo, c.esterno);
  }

  #suErrore(i, n, msg, haParlato, e) {
    if (!this.#mio(i, n)) return;
    const c = this.corrente; clearTimeout(c.timer);
    const nome = this.configurazioni[i].nome;
    console.error(`⚠️ cervello ${nome}: ${msg}`);
    if (e?.limite || e?.chiave) pausa.set(chiaveBackend(this.configurazioni[i]), Date.now() + (e.chiave ? 600000 : 60000));
    if (haParlato) { // ha già detto qualcosa: si chiude il turno con quello che c'è
      c.chiuso = true;
      this.allaFine?.(c.testoParziale || '', c.esterno);
      return;
    }
    this.#riserva(c, `${nome}: ${msg}`);
  }

  // Passa alla riserva per la frase in corso (se c'è e non l'abbiamo già provata); altrimenti scusa e basta.
  #riserva(c, motivo) {
    const prossimo = this.configurazioni.findIndex((_, k) => k !== c.indice && !c.provati.has(k));
    if (prossimo < 0) {
      c.chiuso = true;
      console.error(`⚠️ nessun cervello ha risposto (${motivo})`);
      this.alTesto?.(FRASE_GUASTO, c.esterno);
      this.storia.push({ ruolo: 'receptionist', testo: FRASE_GUASTO });
      this.allaFine?.(FRASE_GUASTO, c.esterno);
      return;
    }
    console.error(`↪ passo a ${this.configurazioni[prossimo].nome} (${motivo})`);
    this.backend[c.indice]?.annulla?.();
    this.attivo = prossimo;
    this.#invia(c.frase, prossimo, c);
  }

  #invia(frase, indice, c) {
    c.provati.add(indice); c.indice = indice; c.haParlato = false; c.chiuso = false;
    const b = this.#prepara(indice);
    c.interno = b.ascolta(frase, this.storia.slice(0, -1)); // la storia senza la frase appena aggiunta
    clearTimeout(c.timer);
    if (this.configurazioni.length > 1 && c.provati.size < this.configurazioni.length) {
      c.timer = setTimeout(() => { if (!c.haParlato && !c.chiuso) this.#riserva(c, `${this.configurazioni[indice].nome}: troppo lento`); }, PRIMO_TESTO_MAX_MS);
    }
  }

  // Manda la frase del cliente; restituisce il numero del turno della risposta.
  ascolta(frase) {
    if (this.chiuso) return -1;
    if (this.corrente) { clearTimeout(this.corrente.timer); this.corrente.chiuso = true; }
    this.storia.push({ ruolo: 'cliente', testo: frase });
    const c = this.corrente = { esterno: ++this.turni, frase, provati: new Set(), timer: null };
    this.#invia(frase, this.attivo, c);
    return c.esterno;
  }

  chiudi() {
    if (this.chiuso) return;
    this.chiuso = true;
    clearTimeout(this.corrente?.timer);
    for (const b of this.backend) b?.chiudi();
  }
}

// --- Una richiesta sola, senza conversazione (importazione dal sito, prove) ---
export async function completa(sistema, utente, { modello, config, massimoToken = 4000 } = {}) {
  const lista = [risolvi(config), ...(config ? [] : [risolvi(impostazioni().cervello?.principale) || risolvi(PREDEFINITO.principale), risolvi(impostazioni().cervello?.riserva)])].filter(Boolean);
  let ultimo;
  for (const c of lista) {
    try {
      if (c.tipo === 'claude') return await completaClaude(sistema, utente, { ...c, modello: modello || c.modello });
      if (c.tipo === 'opencode') {
        const r = await fetch(`${indirizzoOpenCode(c)}/api/experimental/generate`, {
          method: 'POST', signal: AbortSignal.timeout(180000), headers: intestazioniOpenCode(c),
          body: JSON.stringify({ prompt: `${sistema}\n\n---\n\n${utente}`, model: modelloOpenCode({ ...c, modello: modello || c.modello }) }),
        });
        if (!r.ok) throw new Error(messaggioOpenCode(r.status, ''));
        const j = await r.json();
        const t = String(j?.data?.text || '').trim();
        if (!t) throw new Error('risposta vuota');
        return t;
      }
      const r = await fetch(`${c.url}/chat/completions`, {
        method: 'POST', signal: AbortSignal.timeout(180000),
        headers: { 'Content-Type': 'application/json', ...(c.chiave ? { Authorization: `Bearer ${c.chiave}` } : {}) },
        body: JSON.stringify({ model: c.modello, temperature: 0.2, max_tokens: massimoToken, messages: [{ role: 'system', content: sistema }, { role: 'user', content: utente }] }),
      });
      if (!r.ok) throw new Error(`${MESSAGGI_HTTP[r.status] || `errore ${r.status}`}`);
      const j = await r.json();
      const t = (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!t) throw new Error('risposta vuota');
      return t;
    } catch (e) { ultimo = new Error(`${c.nome}: ${e.message}`); }
  }
  throw ultimo || new Error('nessun cervello configurato');
}

function completaClaude(sistema, utente, c) {
  return new Promise((risolvi, rifiuta) => {
    const env = { ...process.env };
    if (c.chiave) { if (c.chiave.startsWith('sk-ant-api')) env.ANTHROPIC_API_KEY = c.chiave; else env.CLAUDE_CODE_OAUTH_TOKEN = c.chiave; }
    const p = spawn(CONFIG.cervello.comando, ['-p', '--output-format', 'json', '--model', c.modello, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--system-prompt', sistema], { stdio: ['pipe', 'pipe', 'pipe'], env });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    const tempo = setTimeout(() => { p.kill(); rifiuta(new Error('Claude ci mette troppo (oltre 3 minuti)')); }, 180000);
    p.on('error', (e) => { clearTimeout(tempo); rifiuta(new Error(`Claude Code non parte: ${e.message}`)); });
    p.on('close', () => {
      clearTimeout(tempo);
      try { const r = JSON.parse(out); if (r.is_error) throw new Error(r.result || 'errore di Claude'); risolvi(r.result); }
      catch (e) { rifiuta(new Error(`${e.message}${err ? ` (${err.slice(0, 200)})` : ''}`)); }
    });
    p.stdin.end(utente);
  });
}

// --- Elenco dei modelli del servizio (così non si scrivono a mano nomi che cambiano) ---
export async function elencaModelli(config) {
  const c = risolvi(config);
  if (!c) throw new Error('scegli un servizio');
  if (c.tipo === 'claude') return ['haiku', 'sonnet', 'opus'];
  if (c.tipo === 'opencode') {
    const r = await fetch(`${indirizzoOpenCode(c)}/api/model`, { signal: AbortSignal.timeout(15000), headers: intestazioniOpenCode(c) });
    if (!r.ok) throw new Error(messaggioOpenCode(r.status, ''));
    const j = await r.json();
    const provider = String(c.modello || '').includes('/') ? String(c.modello).slice(0, String(c.modello).indexOf('/')) : '';
    const nomi = (j.data || [])
      .filter((m) => m.providerID && (!provider || m.providerID === provider))
      .map((m) => `${m.providerID}/${m.id}`);
    if (!nomi.length) throw new Error(`OpenCode non ha modelli per il provider ${provider || 'scelto'}`);
    return [...new Set(nomi)].sort();
  }
  const r = await fetch(`${c.url}/models`, { signal: AbortSignal.timeout(15000), headers: c.chiave ? { Authorization: `Bearer ${c.chiave}` } : {} });
  if (!r.ok) throw new Error(MESSAGGI_HTTP[r.status] || `errore ${r.status}`);
  const j = await r.json();
  const nomi = (j.data || j.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean);
  if (!nomi.length) throw new Error('il servizio non ha elencato modelli');
  return nomi.sort();
}

// --- Prova di una conversazione: stessa istruzione di una chiamata vera, nessun appuntamento scritto ---
export async function provaConversazione(config, istruzioni, { posti = '', frasi = null } = {}) {
  const c = risolvi(config);
  if (!c) throw new Error('scegli un servizio');
  const dialogo = frasi || ['Buongiorno, vorrei prendere un appuntamento.', 'Va bene il primo orario che mi ha proposto.', 'Mi chiamo Paolo Rossi.', 'Devo fare una verifica, è una cosa semplice.', 'Sì, è tutto. Grazie, arrivederci.'];
  const turni = [];
  const b = crea(istruzioni, c);
  try {
    for (const frase of dialogo) {
      const r = await new Promise((ok) => {
        const t0 = Date.now(); let primo = null, testo = '';
        const tempo = setTimeout(() => ok({ errore: 'nessuna risposta in 40 secondi' }), 40000);
        b.alTesto = () => { primo ??= Date.now() - t0; };
        b.allaFine = (t) => { clearTimeout(tempo); ok({ testo: t, primoMs: primo ?? Date.now() - t0, totaleMs: Date.now() - t0 }); };
        b.alErrore = (_n, msg) => { clearTimeout(tempo); ok({ errore: msg }); };
        void testo;
        b.ascolta(frase, []);
      });
      turni.push({ cliente: frase, ...r });
      if (r.errore) break;
    }
  } finally { b.chiudi(); }
  // La chiamata applica questa stessa cadenza prima della sintesi: il test deve giudicare
  // ciò che il cliente sentirà, non gli intercalari grezzi eventualmente ripetuti dal modello.
  const regolaIntercalare = creaRegolatoreIntercalari(impostazioni().receptionist?.intercalare);
  for (let i = 0; i < turni.length; i++) {
    if (!turni[i].testo) continue;
    const marcatori = [...turni[i].testo.matchAll(/<<[^>]*(?:>>|$)/g)].map((m) => m[0]);
    const parlato = turni[i].testo.replace(/<<[^>]*(?:>>|$)/g, '').trim();
    turni[i].testo = [regolaIntercalare(parlato, i + 1), ...marcatori].filter(Boolean).join(' ');
  }
  const tutti = turni.map((t) => t.testo || '').join('\n');
  const parlato = (t) => numeriInParole(t.replace(/<<[^>]*(?:>>|$)/g, ''));
  const problemi = [];
  const errore = turni.find((t) => t.errore);
  if (errore) problemi.push(`errore: ${errore.errore}`);
  else {
    if (turni.some((t, i) => /<<\s*FINE\s*>>/.test(t.testo || '') && !congedoCliente(t.cliente, i + 1))) problemi.push('riaggancia prima che il cliente abbia finito');
    if (turni.some((t, i) => {
      const m = (t.testo || '').match(/<<\s*CONFERMA\s*\|([^|>]*)/);
      return m && !consensoPrenotazione(t.cliente, turni[i - 1]?.testo, m[1]);
    })) problemi.push('conferma l’appuntamento senza il consenso al riepilogo');
    const conferma = tutti.match(/<<\s*CONFERMA\s*\|([^>]*)>>/);
    const campi = conferma ? conferma[1].split('|').map((x) => x.trim()) : [];
    if (!conferma) problemi.push('non ha scritto il marcatore <<CONFERMA|…>> per registrare l’appuntamento');
    else if (campi.length < 4 || !/^\d{4}-\d{2}-\d{2}$/.test(campi[1]) || !/^\d{1,2}:\d{2}$/.test(campi[2])) problemi.push(`marcatore CONFERMA scritto male: ${conferma[0]}`);
    else if (posti && !posti.includes(campi[1])) problemi.push(`ha confermato un giorno non libero (${campi[1]})`);
    if (!/<<\s*FINE\s*>>/.test(tutti)) problemi.push('non ha scritto il marcatore <<FINE>> per riagganciare');
    if (/\d/.test(parlato(tutti))) problemi.push('scrive cifre invece di parole (la voce le legge male)');
    if (/[*#`]/.test(parlato(tutti))) problemi.push('usa simboli o elenchi (la voce li legge)');
    if (/\b(sure|okay|however|please)\b/i.test(parlato(tutti))) problemi.push('a tratti risponde in inglese');
  }
  const primi = turni.filter((t) => t.primoMs).map((t) => t.primoMs).sort((a, b) => a - b);
  return { servizio: c.nome, modello: c.modello, turni, problemi, ok: problemi.length === 0, primoMedianoMs: primi.length ? primi[Math.floor(primi.length / 2)] : null };
}
