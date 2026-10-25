// Importa dal sito: legge le pagine di un sito (stesso dominio), ne tira fuori il testo e chiede
// a Claude Code di estrarre tutto quello che serve al receptionist per rispondere al telefono.
import { spawn } from 'node:child_process';
import { CONFIG } from './config.mjs';

const MAX_PAGINE = 30;
const MAX_TESTO = 120000; // caratteri mandati a Claude

// pagine che di solito contengono quello che chiedono al telefono: si leggono per prime
const IMPORTANTI = /contatt|chi-siamo|chisiamo|about|azienda|serviz|lavoraz|prodott|prezz|listino|tariff|orari|dove|faq|domande|come-funziona|materiali|portfolio|consulenz|prenot|team|spedizion|condizion/i;
const DA_SALTARE = /\.(jpe?g|png|gif|webp|svg|pdf|zip|mp4|mp3|docx?|xlsx?|css|js|ico|woff2?)(\?|$)|\/(wp-admin|wp-login|wp-json|feed|tag|author|cart|carrello|checkout|account|login)\b|privacy|cookie|#/i;

const entita = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', egrave: 'è', eacute: 'é', agrave: 'à', igrave: 'ì', ograve: 'ò', ugrave: 'ù', Egrave: 'È', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—', euro: '€', copy: '©' };
const decodifica = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return entita[e] ?? m;
});

// HTML → testo leggibile, con i titoli e gli elenchi ancora riconoscibili.
export function testoDaHtml(html) {
  const titolo = decodifica((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim());
  const descrizione = decodifica(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)?.[1] || '');
  let t = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(h[1-6])[^>]*>/gi, '\n\n## ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/header|\/footer)[^>]*>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  t = decodifica(t).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { titolo, descrizione, testo: t };
}

function collegamenti(html, base) {
  const host = new URL(base).host.replace(/^www\./, '');
  const out = new Set();
  for (const [, h] of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)/gi)) {
    try {
      const u = new URL(decodifica(h), base);
      if (!/^https?:$/.test(u.protocol) || u.host.replace(/^www\./, '') !== host || DA_SALTARE.test(u.href)) continue;
      u.hash = ''; u.search = '';
      out.add(u.href.replace(/\/$/, ''));
    } catch {}
  }
  return [...out];
}

// Legge fino a MAX_PAGINE pagine partendo dall'indirizzo dato: prima la home e le pagine "importanti".
export async function leggiSito(indirizzo, { avanzamento = () => {} } = {}) {
  let partenza = indirizzo.trim();
  if (!/^https?:\/\//i.test(partenza)) partenza = 'https://' + partenza;
  const daLeggere = [partenza.replace(/\/$/, '')];
  const visti = new Set(daLeggere);
  const pagine = [];
  // anche la sitemap, se c'è, per non perdere pagine non collegate dal menu
  try {
    const r = await fetch(new URL('/sitemap.xml', partenza), { signal: AbortSignal.timeout(8000) });
    if (r.ok) for (const [, loc] of (await r.text()).matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const u = loc.trim().replace(/\/$/, '');
      if (!/sitemap/i.test(u) && !DA_SALTARE.test(u) && !visti.has(u)) { visti.add(u); daLeggere.push(u); }
    }
  } catch {}
  while (daLeggere.length && pagine.length < MAX_PAGINE) {
    // prima le pagine con nomi "importanti"
    daLeggere.sort((a, b) => (IMPORTANTI.test(b) ? 1 : 0) - (IMPORTANTI.test(a) ? 1 : 0));
    const u = daLeggere.shift();
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (receptionist AI; lettura informazioni pubbliche)', 'Accept-Language': 'it' }, signal: AbortSignal.timeout(12000) });
      if (!r.ok || !/text\/html/i.test(r.headers.get('content-type') || '')) continue;
      const html = await r.text();
      const p = testoDaHtml(html);
      if (p.testo.length > 80) pagine.push({ url: u, ...p });
      avanzamento(`lette ${pagine.length} pagine…`);
      for (const l of collegamenti(html, r.url)) if (!visti.has(l)) { visti.add(l); daLeggere.push(l); }
    } catch {}
  }
  if (!pagine.length) throw new Error('nessuna pagina leggibile a questo indirizzo');
  return pagine;
}

// Toglie le righe ripetute su tutte le pagine (menu, piè di pagina): restano una volta sola.
function senzaRipetizioni(pagine) {
  const conta = new Map();
  for (const p of pagine) for (const r of new Set(p.testo.split('\n'))) conta.set(r, (conta.get(r) || 0) + 1);
  const comuni = new Set([...conta].filter(([r, n]) => n > Math.max(2, pagine.length * 0.5) && r.length < 200).map(([r]) => r));
  const giaDetto = new Set();
  return pagine.map((p) => ({ ...p, testo: p.testo.split('\n').filter((r) => !comuni.has(r) || (!giaDetto.has(r) && giaDetto.add(r))).join('\n') }));
}

const ISTRUZIONI = `Sei un assistente che prepara la scheda informativa per il receptionist telefonico di un'attività, leggendo il suo sito.
Riceverai il testo delle pagine del sito. Estrai SOLO informazioni presenti nel testo, senza inventare niente, e rispondi SOLO con un oggetto JSON valido (niente altro testo, niente blocchi di codice) con questi campi, tutti in italiano:
{
  "nome": "nome dell'attività",
  "tipo": "cos'è e cosa fa, in una frase che completa 'Sei il receptionist di <nome>, ...' (es. 'un laboratorio di lavorazioni laser di Settimo Milanese, per aziende e privati')",
  "indirizzo": "indirizzo completo, o vuoto",
  "telefono": "telefono principale, o vuoto",
  "email": "email principale, o vuoto",
  "sito": "dominio del sito",
  "servizi": "elenco discorsivo dei servizi e prodotti offerti",
  "domande": "cosa conviene chiedere a chi chiama per un appuntamento o un preventivo, oltre a nome e orario (es. 'che lavorazione serve, su quale materiale e quanti pezzi')",
  "conoscenza": "scheda completa per rispondere al telefono: tutto quello che un cliente potrebbe chiedere e che il sito dice. Servizi e prodotti con dettagli, materiali e limiti tecnici, prezzi e listini SOLO se scritti sul sito, orari, come si arriva, modalità di pagamento, tempi, spedizioni, garanzie, condizioni, domande frequenti con le risposte, persone e ruoli, come richiedere un preventivo o mandare file, contatti (WhatsApp, email). Frasi brevi raggruppate per argomento con titoletti tipo 'Servizi:', 'Contatti:'. Numeri di telefono ed email come sono scritti. Massimo 6000 caratteri.",
  "orari": { "lunedi": "08:30-12:30, 14:00-18:00", "martedi": "", "mercoledi": "", "giovedi": "", "venerdi": "", "sabato": "", "domenica": "" },
  "orariTrovati": true o false (true solo se il sito indica davvero gli orari di apertura),
  "saluto": "frase con cui rispondere al telefono, breve e cordiale, es. '<nome>, buongiorno! Sono {nome}, mi dica.' (lascia {nome} così)",
  "nonTrovato": "cosa NON c'è sul sito e sarebbe utile (es. orari, prezzi), in una frase"
}
Se un'informazione non c'è, lascia la stringa vuota.`;

// Claude Code legge il testo del sito e restituisce la scheda (JSON).
export function estraiDati(pagine, { modello = 'sonnet' } = {}) {
  let testo = senzaRipetizioni(pagine).map((p) => `### PAGINA: ${p.url}\nTitolo: ${p.titolo}${p.descrizione ? `\nDescrizione: ${p.descrizione}` : ''}\n${p.testo}`).join('\n\n');
  if (testo.length > MAX_TESTO) testo = testo.slice(0, MAX_TESTO);
  return new Promise((risolvi, rifiuta) => {
    const p = spawn(CONFIG.cervello.comando, ['-p', '--output-format', 'json', '--model', modello, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--system-prompt', ISTRUZIONI], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const tempo = setTimeout(() => { p.kill(); rifiuta(new Error('Claude ci mette troppo (oltre 3 minuti)')); }, 180000);
    p.on('close', () => {
      clearTimeout(tempo);
      try {
        const r = JSON.parse(out);
        if (r.is_error) throw new Error(r.result || 'errore di Claude');
        const j = r.result.match(/\{[\s\S]*\}/);
        if (!j) throw new Error('risposta senza JSON');
        risolvi(JSON.parse(j[0]));
      } catch (e) { rifiuta(new Error(`estrazione non riuscita: ${e.message}${err ? ` (${err.slice(0, 200)})` : ''}`)); }
    });
    p.stdin.end(`Testo del sito (${pagine.length} pagine):\n\n${testo}`);
  });
}

// Lavori in corso (l'estrazione dura un minuto o due): il pannello chiede a che punto sono.
const lavori = new Map();
export function avviaImportazione(indirizzo) {
  const id = Math.random().toString(36).slice(2, 10);
  const lavoro = { stato: 'in corso', messaggio: 'leggo il sito…', inizio: Date.now() };
  lavori.set(id, lavoro);
  (async () => {
    try {
      const pagine = await leggiSito(indirizzo, { avanzamento: (m) => (lavoro.messaggio = m) });
      lavoro.pagine = pagine.map((p) => p.url);
      lavoro.messaggio = `lette ${pagine.length} pagine, Claude sta estraendo i dati…`;
      lavoro.dati = await estraiDati(pagine);
      lavoro.stato = 'fatto';
      lavoro.messaggio = `fatto: ${pagine.length} pagine lette in ${Math.round((Date.now() - lavoro.inizio) / 1000)} s`;
    } catch (e) { lavoro.stato = 'errore'; lavoro.messaggio = e.message; }
  })();
  setTimeout(() => lavori.delete(id), 3600000).unref();
  return id;
}
export const statoImportazione = (id) => lavori.get(id) || null;
