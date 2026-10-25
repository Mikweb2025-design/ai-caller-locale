// Calendari CalDAV (Nextcloud, iCloud, Fastmail, Synology, mailbox.org, Radicale, Baïkal...):
// accesso con utente e password per le app, lettura degli impegni, creazione, spostamento e
// cancellazione degli appuntamenti. Solo fetch e XML a mano: nessuna libreria esterna.

// Indirizzi di partenza per i servizi più comuni (il resto lo trova la ricerca automatica).
export const SERVIZI = {
  nextcloud: { nome: 'Nextcloud', url: 'https://TUO-SERVER/remote.php/dav', aiuto: 'Impostazioni personali → Sicurezza → "Crea nuova password per le applicazioni".' },
  icloud: { nome: 'iCloud', url: 'https://caldav.icloud.com', aiuto: 'appleid.apple.com → Accesso e sicurezza → Password specifiche per le app. Utente: la tua email Apple.' },
  fastmail: { nome: 'Fastmail', url: 'https://caldav.fastmail.com/dav/', aiuto: 'Impostazioni → Privacy e sicurezza → Password per app (accesso CalDAV).' },
  synology: { nome: 'Synology Calendar', url: 'https://TUO-NAS:5001/caldav/', aiuto: "Utente e password del NAS (meglio un utente apposta). L'indirizzo CalDAV è nelle impostazioni del calendario." },
  mailbox: { nome: 'mailbox.org', url: 'https://dav.mailbox.org/', aiuto: 'Impostazioni → Sicurezza → Password per le applicazioni.' },
  zoho: { nome: 'Zoho Calendar', url: 'https://calendar.zoho.eu/caldav/', aiuto: 'Account Zoho → Sicurezza → Password specifiche per le applicazioni.' },
  yahoo: { nome: 'Yahoo', url: 'https://caldav.calendar.yahoo.com', aiuto: 'Sicurezza account → Genera password per le app.' },
  altro: { nome: 'Altro CalDAV', url: 'https://', aiuto: "L'indirizzo CalDAV del tuo servizio (anche quello di un singolo calendario)." },
};

import { recupera } from './rete.mjs';

const UID_NOSTRO = '@ai-caller-locale';

function intestazioni(conto, extra = {}) {
  return { Authorization: 'Basic ' + Buffer.from(`${conto.utente}:${conto.password}`).toString('base64'), ...extra };
}

async function richiesta(conto, metodo, url, { corpo, profondita, tipo = 'application/xml; charset=utf-8', extra = {} } = {}) {
  // reti private ok (Nextcloud in casa), ma solo http/https e mai il server stesso
  const r = await recupera(url, {
    method: metodo,
    headers: intestazioni(conto, { ...(corpo ? { 'Content-Type': tipo } : {}), ...(profondita !== undefined ? { Depth: String(profondita) } : {}), ...extra }),
    body: corpo,
    signal: AbortSignal.timeout(15000),
  }, { privati: true });
  if (r.status === 401) throw new Error('accesso negato: controlla utente e password per le app');
  if (!r.ok && r.status !== 207) throw new Error(`${metodo} ${new URL(url).pathname} → HTTP ${r.status}`);
  return { stato: r.status, testo: await r.text(), etag: r.headers.get('etag'), url: r.urlFinale };
}

// --- XML minimo: le risposte multistatus, senza dipendere dai prefissi dei namespace ---
const tag = (nome) => new RegExp(`<(?:[\\w-]+:)?${nome}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${nome}>`, 'gi');
const primo = (xml, nome) => { const m = tag(nome).exec(xml); return m ? m[1] : null; };
const tutti = (xml, nome) => [...xml.matchAll(tag(nome))].map((m) => m[1]);
const href = (xml) => { const h = primo(xml, 'href'); return h ? decodeXml(h.trim()) : null; };
const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const assoluto = (base, h) => new URL(h, base).toString();

const PROP = (corpo) => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:i="http://apple.com/ns/ical/"><d:prop>${corpo}</d:prop></d:propfind>`;

// Trova i calendari del conto: dall'indirizzo dato → utente (principal) → cartella dei calendari → elenco.
export async function cercaCalendari(conto) {
  let base = conto.url.trim();
  if (!/^https?:\/\//.test(base)) throw new Error("l'indirizzo deve cominciare con https://");
  // l'indirizzo è già un calendario?
  const diretto = await richiesta(conto, 'PROPFIND', base, { corpo: PROP('<d:resourcetype/><d:displayname/><d:current-user-principal/><c:calendar-home-set/>'), profondita: 0 })
    .catch(async (e) => {
      // molti server rispondono solo da /.well-known/caldav
      if (!/HTTP 40[45]/.test(e.message)) throw e;
      return richiesta(conto, 'PROPFIND', assoluto(base, '/.well-known/caldav'), { corpo: PROP('<d:current-user-principal/>'), profondita: 0 });
    });
  base = diretto.url || base;
  if (/<(?:[\w-]+:)?calendar\b/i.test(primo(diretto.testo, 'resourcetype') || '')) {
    return [{ url: base, nome: decodeXml(primo(diretto.testo, 'displayname') || 'Calendario').trim() }];
  }
  let casa = primo(diretto.testo, 'calendar-home-set');
  if (!casa) {
    const principalXml = primo(diretto.testo, 'current-user-principal');
    if (!principalXml) throw new Error('il server non dice dove sono i calendari: prova con l\'indirizzo di un calendario');
    const principal = assoluto(base, href(principalXml));
    const p = await richiesta(conto, 'PROPFIND', principal, { corpo: PROP('<c:calendar-home-set/>'), profondita: 0 });
    casa = primo(p.testo, 'calendar-home-set');
    base = principal;
  }
  const home = assoluto(base, href(casa));
  const elenco = await richiesta(conto, 'PROPFIND', home, { corpo: PROP('<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><d:current-user-privilege-set/>'), profondita: 1 });
  return tutti(elenco.testo, 'response')
    .filter((r) => /<(?:[\w-]+:)?calendar\b/i.test(primo(r, 'resourcetype') || ''))
    .filter((r) => { const comp = primo(r, 'supported-calendar-component-set'); return !comp || /VEVENT/i.test(comp); })
    .map((r) => {
      const permessi = primo(r, 'current-user-privilege-set');
      return { url: assoluto(home, href(r)), nome: decodeXml(primo(r, 'displayname') || href(r)).trim(), soloLettura: permessi ? !/<(?:[\w-]+:)?(write|write-content|all|bind)\b/i.test(permessi) : false };
    });
}

const dataCal = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Gli eventi (anche ricorrenti, espansi dal server) tra due date, come testo iCal.
export async function leggiEventi(conto, calendario, da, a) {
  const corpo = `<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data><c:expand start="${dataCal(da)}" end="${dataCal(a)}"/></c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${dataCal(da)}" end="${dataCal(a)}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
  const r = await richiesta(conto, 'REPORT', calendario, { corpo, profondita: 1 });
  return tutti(r.testo, 'calendar-data').map(decodeXml);
}

// Crea o aggiorna (sposta) un evento: PUT del file .ics. Restituisce l'indirizzo dell'evento.
export async function salvaEvento(conto, calendario, { uid, ics, hrefEsistente }) {
  const url = hrefEsistente || assoluto(calendario.endsWith('/') ? calendario : calendario + '/', `${encodeURIComponent(uid)}.ics`);
  await richiesta(conto, 'PUT', url, { corpo: ics, tipo: 'text/calendar; charset=utf-8', extra: hrefEsistente ? {} : { 'If-None-Match': '*' } });
  return url;
}

export async function cancellaEvento(conto, url) {
  await richiesta(conto, 'DELETE', url).catch((e) => { if (!/HTTP 404/.test(e.message)) throw e; });
}

export const eventoNostro = (uid) => String(uid || '').endsWith(UID_NOSTRO);
export const uidNostro = (id) => `${id}${UID_NOSTRO}`;
