// Importa dal sito: legge le pagine di un sito (stesso dominio), ne tira fuori il testo e chiede
// a Claude Code di estrarre tutto quello che serve al receptionist per rispondere al telefono.
import { completa } from './cervello.mjs';
import { recupera, controllaUrl } from './rete.mjs';

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

// --- design del sito: logo e colore principale, per le impostazioni (pannello admin, scheda Design) ---
const assolutizza = (u, base) => {
  try { const x = new URL(u, base); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; }
};
const contenuto = (html) => decodifica((html.match(/content=["']([^"']*)>/i)?.[1] || '').trim());
const tagMeta = (html, nome) => contenuto(html.match(new RegExp(`<meta\\b[^>]*${nome}[^>]*>`, 'i'))?.[0] || '');

const esadecimale = (s) => /^#[0-9a-f]{3}$/.test(s) || /^#[0-9a-f]{6}$/.test(s);
// un colore "vivo" va bene come colore dell'attività: niente grigi, niente quasi bianco o nero
function vivace(hex) {
  let s = hex.slice(1); if (s.length === 3) s = [...s].map((c) => c + c).join('');
  const n = parseInt(s, 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max - min > 60 && min > 0 && max < 252;
}
const aSei = (hex) => { let s = hex.slice(1); if (s.length === 3) s = [...s].map((c) => c + c).join(''); return '#' + s.toLowerCase(); };

// Dai fogli di stile del sito (inline + al massimo 3 esterni): il colore che esce più spesso tra quelli "vivi".
async function coloreDaCss(html, base, controlli) {
  const pezzi = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) pezzi.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (pezzi.length > 3 || !/stylesheet/i.test(m[0])) continue;
    const u = assolutizza(decodifica((m[0].match(/href=["']([^"']+)/i)?.[1] || '').trim()), base);
    if (!u) continue;
    try {
      const r = await recupera(u, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (receptionist AI; lettura stili)' } }, controlli);
      if (r.ok) pezzi.push((await r.text()).slice(0, 400000));
    } catch {}
  }
  const conta = new Map();
  for (const pezzo of pezzi) for (const c of pezzo.match(/#[0-9a-f]{3}\b|#[0-9a-f]{6}\b/gi) || []) conta.set(aSei(c).toUpperCase(), (conta.get(aSei(c).toUpperCase()) || 0) + 1);
  const scelto = [...conta].sort((a, b) => b[1] - a[1]).find(([h]) => vivace(h));
  return scelto ? aSei(scelto[0]) : '';
}

// Ridotto a un immagine del logo: prima le immagini "og:image" (di solito una grande con il marchio),
// poi le icone dei link (apple-touch-icon e compagnie), poi la favicon.
function logoDaHtml(html, base) {
  const valido = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && (x.pathname !== '/' || x.search); } catch { return false; } };
  // prima le immagini social (og:image, di solito una grande con il marchio), poi le icone large, poi le altre
  for (const nome of [/og:image/, /og:logo/, /twitter:image/]) {
    const u = assolutizza(tagMeta(html, nome), base);
    if (u && valido(u)) return u;
  }
  const icone = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=("|')[^"']*icon[^"']*\1/i.test(tag)) continue;
    const href = assolutizza(decodifica((tag.match(/href=("|')([^"']+)/i)?.[2] || '').trim()), base);
    if (href && valido(href)) icone.push({ tag, href });
  }
  const grandi = icone.filter((x) => !/\.ico$/i.test(x.href) && (/apple-touch/i.test(x.tag) || /sizes=["'][1-9]\d{2,}/i.test(x.tag)));
  const piccole = icone.filter((x) => !/\.ico$/i.test(x.href));
  return grandi.find((x) => x.href)?.href || piccole[0]?.href || '';
}

// Logo e colore principale della home del sito (indirizzo base per gli indirizzi relativi).
export async function datiDesign(html, base, controlli = {}) {
  let colore = tagMeta(html, /theme-color/);
  if (!esadecimale(colore.trim())) colore = await coloreDaCss(html, base, controlli);
  return { logo: logoDaHtml(html, base), colore: colore && aSei(colore.trim()) };
}

// Legge fino a MAX_PAGINE pagine partendo dall'indirizzo dato: prima la home e le pagine "importanti".
// suPrimoHtml(html, base, controlli) riceve la home appena letta (per logo e colori, executor datiDesign).
export async function leggiSito(indirizzo, { avanzamento = () => {}, risolvi, suPrimaPagina } = {}) {
  const controlli = { privati: false, ...(risolvi ? { risolvi } : {}) }; // solo siti pubblici (ALLOW_PRIVATE_FETCH=1 per la rete interna)
  let partenza = indirizzo.trim();
  if (!/^https?:\/\//i.test(partenza)) partenza = 'https://' + partenza;
  await controllaUrl(partenza, controlli); // indirizzo non consentito: errore chiaro subito
  const daLeggere = [partenza.replace(/\/$/, '')];
  const visti = new Set(daLeggere);
  const pagine = [];
  let primaHome = null;
  // anche la sitemap, se c'è, per non perdere pagine non collegate dal menu
  try {
    const r = await recupera(new URL('/sitemap.xml', partenza), { signal: AbortSignal.timeout(8000) }, controlli);
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
      const r = await recupera(u, { headers: { 'User-Agent': 'Mozilla/5.0 (receptionist AI; lettura informazioni pubbliche)', 'Accept-Language': 'it' }, signal: AbortSignal.timeout(12000) }, controlli);
      if (!r.ok || !/text\/html/i.test(r.headers.get('content-type') || '')) continue;
      const html = await r.text();
      if (!primaHome) primaHome = { html, base: r.urlFinale };
      const p = testoDaHtml(html);
      if (p.testo.length > 80) pagine.push({ url: u, ...p });
      avanzamento(`lette ${pagine.length} pagine…`);
      for (const l of collegamenti(html, r.urlFinale)) if (!visti.has(l)) { visti.add(l); daLeggere.push(l); }
    } catch {}
  }
  if (!pagine.length) throw new Error('nessuna pagina leggibile a questo indirizzo');
  if (primaHome && suPrimaPagina) await suPrimaPagina(primaHome.html, primaHome.base, controlli).catch(() => {});
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

// Il cervello scelto nel pannello (Claude Code, Gemini, Groq...) legge il testo del sito e restituisce la scheda (JSON).
export async function estraiDati(pagine) {
  let testo = senzaRipetizioni(pagine).map((p) => `### PAGINA: ${p.url}\nTitolo: ${p.titolo}${p.descrizione ? `\nDescrizione: ${p.descrizione}` : ''}\n${p.testo}`).join('\n\n');
  if (testo.length > MAX_TESTO) testo = testo.slice(0, MAX_TESTO);
  const risposta = await completa(ISTRUZIONI, `Testo del sito (${pagine.length} pagine):\n\n${testo}`, { modello: 'sonnet', massimoToken: 6000 });
  const j = risposta.match(/\{[\s\S]*\}/);
  if (!j) throw new Error('estrazione non riuscita: la risposta non contiene i dati');
  try { return JSON.parse(j[0]); } catch (e) { throw new Error(`estrazione non riuscita: ${e.message}`); }
}

// Lavori in corso (l'estrazione dura un minuto o due): il pannello chiede a che punto sono.
const lavori = new Map();
export function avviaImportazione(indirizzo) {
  const id = Math.random().toString(36).slice(2, 10);
  const lavoro = { stato: 'in corso', messaggio: 'leggo il sito…', inizio: Date.now() };
  lavori.set(id, lavoro);
  (async () => {
    try {
      const pagine = await leggiSito(indirizzo, {
        avanzamento: (m) => (lavoro.messaggio = m),
        // logo e colore principale della home, per la scheda Design
        suPrimaPagina: async (html, base, controlli) => {
          if (lavoro.designGiaPreso) return;
          lavoro.designGiaPreso = true;
          lavoro.messaggio = 'leggo il sito…';
          const design = await datiDesign(html, base, controlli).catch(() => null);
          if (design && (design.logo || design.colore)) lavoro.design = design;
        },
      });
      lavoro.pagine = pagine.map((p) => p.url);
      lavoro.messaggio = `lette ${pagine.length} pagine, Claude sta estraendo i dati…`;
      lavoro.dati = await estraiDati(pagine);
      if (lavoro.design) lavoro.dati.design = lavoro.design;
      lavoro.stato = 'fatto';
      lavoro.messaggio = `fatto: ${pagine.length} pagine lette in ${Math.round((Date.now() - lavoro.inizio) / 1000)} s`;
    } catch (e) { lavoro.stato = 'errore'; lavoro.messaggio = e.message; }
  })();
  setTimeout(() => lavori.delete(id), 3600000).unref();
  return id;
}
export const statoImportazione = (id) => lavori.get(id) || null;
