// L'agenda: appuntamenti presi, orari liberi (dagli orari di apertura, dagli appuntamenti
// e dagli impegni dei calendari collegati), il calendario da abbonarsi e le email di conferma.
// Tutti gli orari sono in ora italiana (Europe/Rome).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import nodemailer from 'nodemailer';
import { impostazioni, fasce, GIORNI, CARTELLA_DATI, proteggi } from './impostazioni.mjs';
import { recupera } from './rete.mjs';
import { leggiEventi, salvaEvento, cancellaEvento, eventoNostro, cercaTaskCalendario } from './caldav.mjs';
import { urlPubblico } from './twilio.mjs';

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
const salva = (lista) => { writeFileSync(FILE, JSON.stringify(lista, null, 2), { mode: 0o600 }); proteggi(FILE); };
proteggi(FILE); // anche se esiste già con permessi larghi
let codaPrenotazioni = Promise.resolve();

export async function annulla(id) {
  const lista = appuntamenti();
  const a = lista.find((x) => x.id === id);
  if (!a) return null;
  a.stato = 'annullato';
  salva(lista);
  if (a.tipo === 'richiamo') await sincronizzaTask(a);
  else await sincronizza(a);
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

// Rimette in calendario gli appuntamenti presi quando un conto era scollegato o sbagliato:
// solo i futuri confermati senza la voce di quel conto. Restituisce quanti ne ha sistemati.
export async function sincronizzaManca() {
  let fatti = 0;
  const oggi = inRoma().iso;
  for (const a of appuntamenti()) {
    if (a.tipo || a.stato !== 'confermato' || (a.giorno || '') < oggi) continue;
    if (conti().every((c) => !c.scrivi || a.calendari?.[c.id])) continue;
    await sincronizza(a);
    fatti++;
  }
  return fatti;
}

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
      const r = await recupera(u, { signal: AbortSignal.timeout(8000) }, { privati: true });
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
  // i richiami non sono appuntamenti: niente posti occupati
  const presi = appuntamenti().filter((a) => !a.tipo && a.stato !== 'annullato' && a.id !== escludi).map((a) => {
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

// --- richiami promessi ---
// Quando il receptionist promette un richiamo da un collega (cliente in un'altra lingua,
// arrabbiato, o cliente che preferisce parlare con una persona) si segna qui: nessun giorno
// né orario, nessun calendario, solo il motivo. Il titolare lo trova nel pannello.
export async function aggiungiRichiamo({ nome, motivo, telefono = '', canale = '' }) {
  const r = {
    id: randomBytes(6).toString('hex'),
    tipo: 'richiamo',
    nome: String(nome || '').trim() || 'non detto',
    telefono: String(telefono || '').trim(),
    motivo: String(motivo || '').trim(),
    stato: 'da richiamare',
    canale: String(canale || '').trim(),
    creato: new Date().toISOString(),
  };
  const lista = appuntamenti();
  lista.push(r);
  salva(lista);
  // il task su calendario non deve rallentare la chiamata: parte in parallelo
  sincronizzaTask(r).catch(() => {});
  return r;
}

export async function aggiornaRichiamo(id, { nome = '', motivo = '', telefono = '' } = {}) {
  const lista = appuntamenti();
  const r = lista.find((x) => x.id === id);
  if (!r || r.tipo !== 'richiamo') return null;
  if (nome.trim() && nome.trim() !== 'non detto') r.nome = nome.trim();
  if (motivo.trim()) r.motivo = motivo.trim();
  const tel = String(telefono || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  if (tel.length >= 6) {
    r.telefono = tel;
    // il task su calendario va aggiornato col nuovo numero, ma senza rallentare la chiamata
    sincronizzaTask(r).catch(() => {});
  }
  salva(lista);
  return r;
}

// --- richiami come task (VTODO) su calendario CalDAV ---
// Il richiamo locale resta l'autorità: su calendario va una copia come task, così il titolare
// lo vede anche nell'app Attività di Nextcloud. La cartella dei task (per es. "Attività") è
// diversa da quella degli eventi, ma stesso server e stesse credenziali: la cerco una volta.
const tasche = new Map(); // conto.id → URL della cartella dei task
const quandoTask = new Map(); // conto.id → quando la ricerca è fallita l'ultima volta (niente loop)

function icsTask(r) {
  const completato = r.stato === 'richiamato';
  const righe = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ai-caller-locale//IT', 'CALSCALE:GREGORIAN',
    'BEGIN:VTODO', `UID:${r.id}@ai-caller-locale`, `DTSTAMP:${dataIcs(new Date())}`,
    `SUMMARY:${testoIcs(`📞 Richiamare ${r.nome}`)}`,
    `DESCRIPTION:${testoIcs(`${r.motivo || '-'}\nTelefono: ${r.telefono || '-'}\nCanale: ${r.canale || '-'}\nRichiesto il ${String(r.creato).slice(0, 16).replace('T', ' ')}`)}`,
    completato ? `STATUS:COMPLETED` : 'STATUS:NEEDS-ACTION',
    completato ? `COMPLETED:${dataIcs(new Date(r.fatto || Date.now()))}` : null,
    'END:VTODO', 'END:VCALENDAR'];
  return righe.filter(Boolean).join('\r\n') + '\r\n';
}

export async function sincronizzaTask(r) {
  const errori = [];
  r.task ||= {};
  for (const c of conti().filter((x) => x.scrivi)) {
    const conto = { ...c, url: c.calendario };
    try {
      if (!tasche.has(c.id) && Date.now() - (quandoTask.get(c.id) || 0) > 60000) {
        try { tasche.set(c.id, (await cercaTaskCalendario(conto))?.url || c.calendario); }
        catch { quandoTask.set(c.id, Date.now()); tasche.set(c.id, c.calendario); }
      }
      const tasca = tasche.get(c.id) || c.calendario;
      if (r.stato === 'annullato') {
        if (r.task[c.id]) { await cancellaEvento(conto, r.task[c.id]); delete r.task[c.id]; }
      } else {
        const ics = icsTask(r);
        r.task[c.id] = await salvaEvento(conto, tasca, { uid: `${r.id}@ai-caller-locale`, ics, hrefEsistente: r.task[c.id] });
      }
    } catch (e) { errori.push(`${c.nome || c.url}: ${e.message}`); }
  }
  const lista = appuntamenti();
  const i = lista.findIndex((x) => x.id === r.id);
  if (i >= 0) { lista[i] = r; salva(lista); }
  if (errori.length) console.warn('⚠️ task del richiamo non aggiornato:', errori.join('; '));
  return errori;
}

export async function richiamoFatto(id) {
  const lista = appuntamenti();
  const r = lista.find((x) => x.id === id);
  if (!r || r.tipo !== 'richiamo') return null;
  r.stato = 'richiamato';
  r.fatto = new Date().toISOString();
  salva(lista);
  await sincronizzaTask(r);
  return r;
}

// --- prenotazione ---
export async function prenota({ nome, giorno, ora, dettagli = '', email = '', telefono = '', canale = '' }) {
  let sblocca;
  const precedente = codaPrenotazioni;
  codaPrenotazioni = new Promise((risolvi) => { sblocca = risolvi; });
  await precedente;
  let a;
  let libretto;
  try {
    const { agenda, email: cfgEmail } = impostazioni();
    const min = minutiDa(ora);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(giorno || '') || min === null) throw new Error(`data o ora non valida: ${giorno} ${ora}`);
    const libero = (await postiLiberi()).some((p) => p.giorno === giorno && p.minuti === min);
    if (!libero) throw new Error(`slot non disponibile: ${giorno} ${hhmm(min)}`);
    a = {
      id: randomBytes(6).toString('hex'),
      nome: String(nome || '').trim(), telefono, email: String(email || '').trim(),
      giorno, ora: hhmm(min), durata: Number(agenda.durataMinuti) || 60,
      dettagli: String(dettagli || '').trim(),
      stato: 'confermato',
      canale, creato: new Date().toISOString(),
    };
    const lista = appuntamenti();
    lista.push(a);
    salva(lista);
    libretto = cfgEmail.attiva && cfgEmail.chiediConferma;
  } finally {
    sblocca();
  }
  // email di conferma al cliente: solo se l'admin ha attivato l'opzione; l'avviso al titolare (avvisaA) parte sempre
  const [esiti, erroriCalendario] = await Promise.all([
    avvisa(a, { cliente: libretto }).catch((e) => ({ errore: e.message })),
    sincronizza(a),
  ]);
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

export async function avvisa(a, { cliente = true } = {}) {
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
  if (cliente && e.confermaAlCliente && a.email) {
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

// --- chiedere al cliente di confermare l'appuntamento ---
// Dal pannello (scheda Appuntamenti) si manda al cliente un'email con due link: confermo / non posso venire.
// I link portano a /conferma/<id>/<token>/<si|no>; il token è casuale e sta nell'appuntamento.
const basePubblica = () => String(urlPubblico() || '').trim().replace(/\/+$/, '');
const linkBase = (a) => `${basePubblica()}/conferma/${a.id}/${a.confermaToken}`;
export const linkConferma = (a) => (basePubblica() && a.confermaToken ? linkBase(a) : null);

export function testoChiediConferma(a, { si, no } = {}) {
  const { attivita } = impostazioni();
  const quando = `${giornoParlato(a.giorno)} alle ${a.ora}`;
  return [
    `${attivita.nome}: ciao ${a.nome.split(' ')[0] || ''},`,
    `le scriviamo per il suo appuntamento di ${quando}${a.dettagli ? ` (${a.dettagli})` : ''}.`,
    si ? `Ci conferma che viene? Basta un clic qui: ${si}` : 'Ci conferma che viene rispondendo a questa email?',
    no ? `Se non riesce a venire, lo dica qui: ${no}` : '',
    attivita.indirizzo ? `Ci trovi in ${attivita.indirizzo}.` : '',
    attivita.telefono ? `Per parlare con noi: ${attivita.telefono}.` : '',
    'Grazie e a presto!',
  ].filter(Boolean).join('\n\n');
}

function htmlChiediConferma(a, { si, no } = {}) {
  const { attivita } = impostazioni();
  const bottone = (href, testo, sfondo) => `<a href="${href}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:${sfondo};color:#fff;text-decoration:none;font-weight:600">${testo}</a>`;
  return `<div style="font:16px/1.5 system-ui,sans-serif;color:#1d1d1b;max-width:520px">
  <p>Ciao ${a.nome.split(' ')[0] || ''},</p>
  <p>le scriviamo per il suo appuntamento di <strong>${giornoParlato(a.giorno)} alle ${a.ora}</strong>${a.dettagli ? ` (${a.dettagli})` : ''}.</p>
  <p>Ci conferma che viene?</p>
  <p>${si ? bottone(si, 'Sì, confermo', '#2e8b57') : ''}${no ? ' ' + bottone(no, 'Non posso venire', '#b03a2e') : ''}</p>
  ${attivita.indirizzo ? `<p>Ci trovi in ${attivita.indirizzo}.</p>` : ''}
  ${attivita.telefono ? `<p>Per parlare con noi: ${attivita.telefono}.</p>` : ''}
  <p>Grazie e a presto!<br>${attivita.nome}</p>
</div>`;
}

export async function chiediConferma(id) {
  const t = postino();
  if (!t) throw new Error('le email non sono attive: configura il server SMTP nella scheda "Email e SMS"');
  const lista = appuntamenti();
  const a = lista.find((x) => x.id === id);
  if (!a) throw new Error('appuntamento non trovato');
  if (a.tipo === 'richiamo') throw new Error('questo è un richiamo, non un appuntamento');
  if (a.stato === 'annullato') throw new Error("l'appuntamento è annullato");
  if (!String(a.email || '').trim()) throw new Error('il cliente non ha lasciato un indirizzo email');
  if (a.confermaEsito === 'confermata') throw new Error('il cliente ha già confermato questo appuntamento');

  // il token si salva prima di spedire: se l'invio riesce, il link funziona già
  a.confermaToken ||= randomBytes(16).toString('hex');
  salva(lista);

  const base = linkConferma(a);
  const si = base ? `${base}/si` : null;
  const no = base ? `${base}/no` : null;
  const { attivita } = impostazioni();
  const e = impostazioni().email;
  await t.sendMail({
    from: e.mittente || e.utente,
    to: a.email,
    subject: `Confermi l'appuntamento di ${giornoParlato(a.giorno)} alle ${a.ora}? – ${attivita.nome}`,
    text: testoChiediConferma(a, { si, no }),
    html: htmlChiediConferma(a, { si, no }),
  });

  a.confermaChiesta = new Date().toISOString();
  a.confermaInvii = (Number(a.confermaInvii) || 0) + 1;
  salva(lista);
  return { appuntamento: a, link: Boolean(base) };
}

// Chiede la conferma a tutti i prossimi appuntamenti che hanno un'email e non hanno ancora confermato.
export async function chiediConfermaProssimi() {
  const { agenda } = impostazioni();
  const oggi = inRoma().iso;
  const fino = piuGiorni(oggi, Number(agenda.giorniAvanti) || 14);
  const candidati = appuntamenti().filter((a) => !a.tipo && a.stato !== 'annullato' && String(a.email || '').trim()
    && (a.giorno || '') >= oggi && a.giorno <= fino && a.confermaEsito !== 'confermata');
  const esiti = { inviate: 0, errori: [] };
  for (const a of candidati) {
    try { await chiediConferma(a.id); esiti.inviate++; } catch (err) { esiti.errori.push(`${a.nome}: ${err.message}`); }
  }
  return esiti;
}

// Il cliente ha aperto il link: con scelta '' si controlla solo che sia valido, con 'si'/'no' si registra la risposta.
const tokenValido = (a, token) => {
  const atteso = Buffer.from(String(a.confermaToken || ''));
  const dato = Buffer.from(String(token || ''));
  return atteso.length > 0 && atteso.length === dato.length && timingSafeEqual(atteso, dato);
};

export function rispondiConferma(id, token, scelta = '') {
  const lista = appuntamenti();
  const a = lista.find((x) => x.id === id);
  if (!a) return { ok: false, motivo: 'non trovato' };
  if (!tokenValido(a, token)) return { ok: false, motivo: 'link' };
  if (a.stato === 'annullato') return { ok: false, motivo: 'annullato', appuntamento: a };
  if (scelta !== 'si' && scelta !== 'no') return { ok: true, appuntamento: a };
  a.confermaCliente = new Date().toISOString();
  a.confermaEsito = scelta === 'si' ? 'confermata' : 'non puo';
  salva(lista);
  return { ok: true, appuntamento: a, risposta: scelta };
}

// --- calendario da abbonarsi (Google Calendar, Apple Calendario, Outlook) ---
const dataIcs = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const testoIcs = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
export function ics(lista = appuntamenti().filter((a) => !a.tipo && a.stato !== 'annullato')) {
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
