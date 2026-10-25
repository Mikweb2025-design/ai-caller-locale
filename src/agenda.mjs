// L'agenda: appuntamenti presi, orari liberi (dagli orari di apertura, dagli appuntamenti
// e dagli impegni dei calendari collegati), il calendario da abbonarsi e le email di conferma.
// Tutti gli orari sono in ora italiana (Europe/Rome).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { impostazioni, fasce, GIORNI, CARTELLA_DATI } from './impostazioni.mjs';
import { leggiEventi, salvaEvento, cancellaEvento, eventoNostro } from './caldav.mjs';

const FILE = join(CARTELLA_DATI, 'appuntamenti.json');
const ZONA = 'Europe/Rome';
const NOMI_GIORNI = ['lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica'];
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

// --- ora italiana ---
const formato = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
export function inRoma(data = new Date()) {
  const p = Object.fromEntries(formato.formatToParts(data).map((x) => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}`, minuti: Number(p.hour) * 60 + Number(p.minute), giorno: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) };
}
// "2026-10-27" + 540 minuti (ora di Roma) → istante
export function daRoma(iso, minuti) {
  const [a, m, g] = iso.split('-').map(Number);
  const ipotesi = Date.UTC(a, m - 1, g, Math.floor(minuti / 60), minuti % 60);
  const r = inRoma(new Date(ipotesi));
  const scarto = (Date.UTC(...r.iso.split('-').map((x, i) => (i === 1 ? x - 1 : +x)), 0, r.minuti) - ipotesi);
  return new Date(ipotesi - scarto);
}
const piuGiorni = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minutiDa = (s) => { const m = String(s).match(/(\d{1,2})[:.](\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

export function giornoParlato(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  return `${NOMI_GIORNI[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MESI[d.getUTCMonth()]}`;
}
// --- appuntamenti ---
export function appuntamenti() {
  if (!existsSync(FILE)) return [];
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; }
}
const salva = (lista) => writeFileSync(FILE, JSON.stringify(lista, null, 2));

export async function annulla(id) {
  const lista = appuntamenti();
  const a = lista.find((x) => x.id === id);
  if (!a) return null;
  a.stato = 'annullato';
  salva(lista);
  await sincronizza(a);
  return a;
}

// Sposta un appuntamento (dal pannello admin): nuovo giorno e ora, aggiornato anche nei calendari.
export async function sposta(id, giorno, ora) {
  const min = minutiDa(ora);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(giorno || '') || min === null) throw new Error(`data o ora non valida: ${giorno} ${ora}`);
  const lista = appuntamenti();
  const a = lista.find((x) => x.id === id);
  if (!a) return null;
  const libero = (await postiLiberi({ escludi: id })).some((p) => p.giorno === giorno && p.minuti === min);
  Object.assign(a, { giorno, ora: hhmm(min), stato: libero ? 'confermato' : 'da verificare', spostato: new Date().toISOString() });
  salva(lista);
  await sincronizza(a);
  return a;
}

// --- calendari CalDAV collegati (Nextcloud, iCloud, ...) ---
const conti = () => (impostazioni().calendari || []).filter((c) => c.url && c.utente && c.calendario);

// Porta l'appuntamento in ogni calendario con la scrittura attiva: crea, aggiorna o cancella.
export async function sincronizza(a) {
  const errori = [];
  a.calendari ||= {};
  for (const c of conti().filter((x) => x.scrivi)) {
    const conto = { ...c, url: c.calendario };
    try {
      if (a.stato === 'annullato') {
        if (a.calendari[c.id]) { await cancellaEvento(conto, a.calendari[c.id]); delete a.calendari[c.id]; }
      } else {
        a.calendari[c.id] = await salvaEvento(conto, c.calendario, { uid: `${a.id}@ai-caller-locale`, ics: ics([a]), hrefEsistente: a.calendari[c.id] });
      }
    } catch (e) { errori.push(`${c.nome || c.url}: ${e.message}`); }
  }
  // salva gli indirizzi degli eventi creati
  const lista = appuntamenti();
  const i = lista.findIndex((x) => x.id === a.id);
  if (i >= 0) { lista[i] = a; salva(lista); }
  occupatoCache.quando = 0;
  if (errori.length) console.warn('⚠️ calendario non aggiornato:', errori.join('; '));
  return errori;
}

// --- impegni dai calendari collegati (URL iCal privati) ---
let occupatoCache = { quando: 0, chiave: '', eventi: [] };
function leggiData(riga) {
  // DTSTART;TZID=Europe/Rome:20261027T090000  |  DTSTART:20261027T080000Z  |  DTSTART;VALUE=DATE:20261027
  const [testa, valore] = [riga.slice(0, riga.indexOf(':')), riga.slice(riga.indexOf(':') + 1).trim()];
  const m = valore.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { data: daRoma(iso, 0), tuttoIlGiorno: true };
  if (m[7]) return { data: new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) };
  void testa; // con TZID o senza zona: si considera ora italiana
  return { data: daRoma(iso, Number(m[4]) * 60 + Number(m[5])) };
}
export function analizzaIcs(testo) {
  const righe = testo.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const eventi = [];
  let ev = null;
  for (const r of righe) {
    if (r === 'BEGIN:VEVENT') ev = {};
    else if (r === 'END:VEVENT') {
      // gli appuntamenti scritti da noi non contano come impegni: li conosciamo già
      if (ev?.inizio && ev.stato !== 'CANCELLED' && ev.trasparenza !== 'TRANSPARENT' && !eventoNostro(ev.uid)) {
        const fine = ev.fine || { data: new Date(ev.inizio.data.getTime() + (ev.inizio.tuttoIlGiorno ? 86400000 : 3600000)) };
        eventi.push({ inizio: ev.inizio.data, fine: fine.data, titolo: ev.titolo || '' });
      }
      ev = null;
    } else if (ev) {
      if (r.startsWith('DTSTART')) ev.inizio = leggiData(r);
      else if (r.startsWith('DTEND')) ev.fine = leggiData(r);
      else if (r.startsWith('SUMMARY')) ev.titolo = r.slice(r.indexOf(':') + 1);
      else if (r.startsWith('UID')) ev.uid = r.slice(r.indexOf(':') + 1).trim();
      else if (r.startsWith('STATUS')) ev.stato = r.slice(r.indexOf(':') + 1).trim();
      else if (r.startsWith('TRANSP')) ev.trasparenza = r.slice(r.indexOf(':') + 1).trim();
    }
  }
  return eventi;
}
export async function leggiCalendari(testo) {
  const urls = String(testo || '').split(/\s+/).map((u) => u.trim().replace(/^webcal:/, 'https:')).filter(Boolean);
  const eventi = [], errori = [];
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const t = await r.text();
      if (!t.includes('BEGIN:VCALENDAR')) throw new Error('non è un calendario iCal');
      eventi.push(...analizzaIcs(t));
    } catch (e) { errori.push(`${u.slice(0, 50)}…: ${e.message}`); }
  }
  return { eventi, errori };
}
export async function leggiCaldav(lista = conti().filter((c) => c.leggi)) {
  const da = new Date(Date.now() - 86400000), a = new Date(Date.now() + ((Number(impostazioni().agenda.giorniAvanti) || 14) + 2) * 86400000);
  const eventi = [], errori = [];
  for (const c of lista) {
    try {
      for (const t of await leggiEventi({ ...c, url: c.calendario }, c.calendario, da, a)) eventi.push(...analizzaIcs(t));
    } catch (e) { errori.push(`${c.nome || c.url}: ${e.message}`); }
  }
  return { eventi, errori };
}
export async function impegniEsterni({ forza = false } = {}) {
  const i = impostazioni();
  const chiave = i.agenda.calendariOccupato + JSON.stringify((i.calendari || []).map((c) => [c.id, c.calendario, c.leggi]));
  if (!forza && occupatoCache.chiave === chiave && Date.now() - occupatoCache.quando < 5 * 60000) return occupatoCache.eventi;
  const [ics1, cal] = await Promise.all([leggiCalendari(i.agenda.calendariOccupato), leggiCaldav()]);
  const eventi = [...ics1.eventi, ...cal.eventi], errori = [...ics1.errori, ...cal.errori];
  occupatoCache = { quando: Date.now(), chiave, eventi, errori };
  if (errori.length) console.warn('⚠️ calendari non letti:', errori.join('; '));
  return eventi;
}
export const erroriCalendari = () => occupatoCache.errori || [];

// --- orari liberi ---
export async function postiLiberi({ da = new Date(), giorni, escludi } = {}) {
  const { orari, agenda } = impostazioni();
  const durata = Number(agenda.durataMinuti) || 60;
  const presi = appuntamenti().filter((a) => a.stato !== 'annullato' && a.id !== escludi).map((a) => {
    const inizio = daRoma(a.giorno, minutiDa(a.ora));
    return { inizio, fine: new Date(inizio.getTime() + (a.durata || durata) * 60000) };
  });
  const esterni = await impegniEsterni();
  const chiusure = new Set(String(orari.chiusure || '').split(/[\s,;]+/).filter(Boolean));
  const minimo = da.getTime() + (Number(agenda.preavvisoOre) || 0) * 3600000;
  const oggi = inRoma(da).iso;
  const liberi = [];
  for (let n = 0; n <= (giorni ?? (Number(agenda.giorniAvanti) || 14)); n++) {
    const iso = piuGiorni(oggi, n);
    if (chiusure.has(iso)) continue;
    const g = (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7;
    for (const [a, b] of fasce(orari[GIORNI[g]])) {
      for (let m = a; m + durata <= b; m += durata) {
        const inizio = daRoma(iso, m), fine = new Date(inizio.getTime() + durata * 60000);
        if (inizio.getTime() < minimo) continue;
        const sovrapposti = presi.filter((p) => p.inizio < fine && p.fine > inizio).length;
        if (sovrapposti >= (Number(agenda.postiPerFascia) || 1)) continue;
        if (esterni.some((e) => e.inizio < fine && e.fine > inizio)) continue;
        liberi.push({ giorno: iso, ora: hhmm(m), minuti: m });
      }
    }
  }
  return liberi;
}

// Per le istruzioni di Claude: i posti liberi giorno per giorno, a voce e con la data esatta.
export async function postiPerIstruzioni() {
  const liberi = await postiLiberi();
  const perGiorno = new Map();
  for (const p of liberi) (perGiorno.get(p.giorno) || perGiorno.set(p.giorno, []).get(p.giorno)).push(p);
  return [...perGiorno].map(([iso, posti]) => `- ${giornoParlato(iso)} (${iso}): ${posti.map((p) => p.ora).join(', ')}`).join('\n');
}

// --- prenotazione ---
export async function prenota({ nome, giorno, ora, dettagli = '', email = '', telefono = '', canale = '' }) {
  const { agenda } = impostazioni();
  const min = minutiDa(ora);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(giorno || '') || min === null) throw new Error(`data o ora non valida: ${giorno} ${ora}`);
  const libero = (await postiLiberi()).some((p) => p.giorno === giorno && p.minuti === min);
  const a = {
    id: randomBytes(6).toString('hex'),
    nome: String(nome || '').trim(), telefono, email: String(email || '').trim(),
    giorno, ora: hhmm(min), durata: Number(agenda.durataMinuti) || 60,
    dettagli: String(dettagli || '').trim(),
    stato: libero ? 'confermato' : 'da verificare', // orario già occupato o fuori orario: lo guarda una persona
    canale, creato: new Date().toISOString(),
  };
  const lista = appuntamenti();
  lista.push(a);
  salva(lista);
  const [esiti, erroriCalendario] = await Promise.all([avvisa(a).catch((e) => ({ errore: e.message })), sincronizza(a)]);
  return { appuntamento: a, ...esiti, calendari: erroriCalendario.length ? erroriCalendario : 'ok' };
}

// --- email ---
function postino() {
  const e = impostazioni().email;
  if (!e.attiva || !e.host) return null;
  return nodemailer.createTransport({ host: e.host, port: Number(e.porta) || 587, secure: Boolean(e.sicura), auth: e.utente ? { user: e.utente, pass: e.password } : undefined });
}

export function testoConferma(a) {
  const { attivita } = impostazioni();
  return `${attivita.nome}: ciao ${a.nome.split(' ')[0] || ''}, appuntamento confermato per ${giornoParlato(a.giorno)} alle ${a.ora}${a.dettagli ? ` (${a.dettagli})` : ''}.${attivita.indirizzo ? ` Ci trovi in ${attivita.indirizzo}.` : ''} A presto!`;
}

export async function avvisa(a) {
  const e = impostazioni().email;
  const t = postino();
  const esiti = { emailTitolare: 'no', emailCliente: 'no' };
  if (!t) return esiti;
  const { attivita } = impostazioni();
  const da = e.mittente || e.utente;
  if (e.avvisaA) {
    await t.sendMail({
      from: da, to: e.avvisaA,
      subject: `Nuovo appuntamento: ${a.nome} – ${giornoParlato(a.giorno)} ${a.ora}${a.stato !== 'confermato' ? ' (DA VERIFICARE)' : ''}`,
      text: `Nome: ${a.nome}\nGiorno: ${giornoParlato(a.giorno)} alle ${a.ora}\nTelefono: ${a.telefono || '-'}\nEmail: ${a.email || '-'}\nDettagli: ${a.dettagli || '-'}\nStato: ${a.stato}\nCanale: ${a.canale}\n`,
      icalEvent: { method: 'PUBLISH', content: ics([a]) },
    });
    esiti.emailTitolare = 'inviata';
  }
  if (e.confermaAlCliente && a.email) {
    await t.sendMail({ from: da, to: a.email, subject: `Appuntamento confermato – ${attivita.nome}`, text: testoConferma(a), icalEvent: { method: 'PUBLISH', content: ics([a]) } });
    esiti.emailCliente = 'inviata';
  }
  return esiti;
}

export async function emailDiProva(a) {
  const t = postino();
  if (!t) throw new Error('email non attiva o server SMTP mancante');
  await t.verify();
  const e = impostazioni().email;
  await t.sendMail({ from: e.mittente || e.utente, to: a, subject: 'Prova dal receptionist AI', text: 'Le email di conferma funzionano.' });
}

// --- calendario da abbonarsi (Google Calendar, Apple Calendario, Outlook) ---
const dataIcs = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const testoIcs = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
export function ics(lista = appuntamenti().filter((a) => a.stato !== 'annullato')) {
  const { attivita } = impostazioni();
  const righe = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ai-caller-locale//IT', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${testoIcs(`Appuntamenti ${attivita.nome}`)}`, 'X-WR-TIMEZONE:Europe/Rome'];
  for (const a of lista) {
    const inizio = daRoma(a.giorno, minutiDa(a.ora));
    righe.push('BEGIN:VEVENT', `UID:${a.id}@ai-caller-locale`, `DTSTAMP:${dataIcs(new Date(a.creato))}`, `DTSTART:${dataIcs(inizio)}`,
      `DTEND:${dataIcs(new Date(inizio.getTime() + (a.durata || 60) * 60000))}`,
      `SUMMARY:${testoIcs(`${a.nome}${a.stato !== 'confermato' ? ' (da verificare)' : ''}`)}`,
      `DESCRIPTION:${testoIcs(`${a.dettagli}\nTelefono: ${a.telefono || '-'}\nEmail: ${a.email || '-'}`)}`,
      attivita.indirizzo ? `LOCATION:${testoIcs(attivita.indirizzo)}` : null, 'END:VEVENT');
  }
  righe.push('END:VCALENDAR');
  return righe.filter(Boolean).join('\r\n') + '\r\n';
}
