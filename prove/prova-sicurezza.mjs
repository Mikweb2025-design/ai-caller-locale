// Prove di sicurezza: gettone 'prova' del WebSocket, permessi dei dati, impostazioni vecchie, SSRF (src/rete.mjs).
// Non tocca il server vero né dati/: avvia istanze sulla porta 5072 (PORTA_PROVA per cambiarla) con una cartella dati temporanea.
// Uso: node prove/prova-sicurezza.mjs   (con rete, per il sito pubblico)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import WebSocket from 'ws';

const radice = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = Number(process.env.PORTA_PROVA) || 5072; // non 5060/5061 (SIP: fetch le rifiuta)
let ok = 0, ko = 0;
const verifica = (nome, cond, dettaglio = '') => { if (cond) { ok++; console.log(`  ✓ ${nome}`); } else { ko++; console.log(`  ✗ ${nome} ${dettaglio}`); } };
const modo = (f) => (statSync(f).mode & 0o777).toString(8);

// --- 1. WebSocket: gettone 'prova' ---
function avvia(env) {
  const dati = mkdtempSync(join(tmpdir(), 'cosmio-sic-'));
  const figlio = spawn('node', ['src/server.mjs'], { cwd: radice, env: { ...process.env, PORTA: String(PORTA), DATI_DIR: dati, SEGRETO: '', URL_PUBBLICO: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => {
    let log = '';
    const f = (d) => { log += d; if (log.includes('in ascolto')) res({ figlio, dati }); if (log.includes('EADDRINUSE')) rej(new Error('porta occupata')); };
    figlio.stdout.on('data', f); figlio.stderr.on('data', f);
    setTimeout(() => rej(new Error('server non partito: ' + log)), 15000);
  });
}
function ws(percorso, headers = {}) {
  return new Promise((res) => {
    const c = new WebSocket(`ws://127.0.0.1:${PORTA}${percorso}`, { headers });
    c.on('open', () => { c.close(); res(101); });
    c.on('unexpected-response', (_, r) => res(r.statusCode));
    c.on('error', () => res(0));
    setTimeout(() => res(-1), 5000);
  });
}
for (const [etichetta, env, attese] of [
  ['senza SEGRETO', {}, { diretto: 101, proxy: 403, esterno: 403 }],
  ['con SEGRETO, senza URL pubblico', { SEGRETO: 'abc123' }, { diretto: 101, proxy: 403, esterno: 403 }],
  ['con SEGRETO e URL pubblico', { SEGRETO: 'abc123', URL_PUBBLICO: 'https://esempio.example' }, { diretto: 403, proxy: 403, esterno: 403 }],
]) {
  console.log(`WebSocket /media/tel/prova, ${etichetta}`);
  const { figlio, dati } = await avvia(env);
  try {
    verifica('da locale diretto', (await ws('/media/tel/prova')) === attese.diretto, `atteso ${attese.diretto}`);
    verifica('con X-Forwarded-For rifiutato', (await ws('/media/tel/prova', { 'X-Forwarded-For': '1.2.3.4' })) === attese.proxy);
    verifica('con Forwarded rifiutato', (await ws('/media/tel/prova', { Forwarded: 'for=1.2.3.4' })) === attese.proxy);
    verifica('con Host esterno rifiutato', (await ws('/media/tel/prova', { Host: 'receptionist.example.com' })) === attese.esterno);
    verifica('gettone sbagliato rifiutato', (await ws('/media/tel/altro')) === 403);
    if (!env.SEGRETO) { /* permessi: solo qui, i file esistono già */ }
  } finally { figlio.kill(); }
}

// --- 2. Permessi: cartella e file esistenti con permessi larghi ---
console.log('Permessi dei dati');
{
  const dati = mkdtempSync(join(tmpdir(), 'cosmio-perm-'));
  chmodSync(dati, 0o755);
  writeFileSync(join(dati, 'appuntamenti.json'), '[]', { mode: 0o644 });
  writeFileSync(join(dati, 'impostazioni.json'), JSON.stringify({ receptionist: { nome: 'Anna', personaggio: 'napoletano' }, attivita: { nome: 'Prova Srl' } }), { mode: 0o644 });
  const script = `
    const { impostazioni, salvaImpostazioni } = await import('./src/impostazioni.mjs');
    const { appuntamenti } = await import('./src/agenda.mjs');
    const a = impostazioni();
    console.log(JSON.stringify({ nome: a.receptionist.nome, personaggio: a.receptionist.personaggio, attivita: a.attivita.nome }));
    salvaImpostazioni({ receptionist: { personaggio: 'napoletano', saluto: 'ciao' } });
    console.log(JSON.stringify({ salvato: impostazioni().receptionist.personaggio }));`;
  const out = await new Promise((res) => { let o = ''; const p = spawn('node', ['--input-type=module', '-e', script], { cwd: radice, env: { ...process.env, DATI_DIR: dati } }); p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d)); p.on('close', () => res(o)); });
  const righe = out.trim().split('\n');
  verifica('impostazioni vecchie con "personaggio" si caricano, il campo è ignorato', righe[0] === '{"nome":"Anna","attivita":"Prova Srl"}', righe[0]);
  verifica('salvando, "personaggio" non viene riscritto', righe[1] === '{}' && !readFileSafe(join(dati, 'impostazioni.json')).includes('personaggio'), righe[1]);
  verifica('cartella dati 700', modo(dati) === '700', modo(dati));
  verifica('impostazioni.json 600', modo(join(dati, 'impostazioni.json')) === '600');
  verifica('appuntamenti.json 600 (già esistente a 644)', modo(join(dati, 'appuntamenti.json')) === '600');
}
function readFileSafe(f) { return existsSync(f) ? process.getBuiltinModule('node:fs').readFileSync(f, 'utf8') : ''; }

// --- 3. SSRF: src/rete.mjs, sito, CalDAV/iCal ---
console.log('SSRF');
process.env.DATI_DIR = mkdtempSync(join(tmpdir(), 'cosmio-rete-'));
process.env.PORTA = String(PORTA);
const { controllaUrl, recupera, ePrivato } = await import('../src/rete.mjs');
const { leggiSito } = await import('../src/sito.mjs');
const { leggiCalendari } = await import('../src/agenda.mjs');
const rifiuta = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
const fintoDns = (mappa) => async (h) => { if (!mappa[h]) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' }); return mappa[h]; };

for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '127.9.9.9', '169.254.169.254', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '0.0.0.0'])
  verifica(`ePrivato(${ip})`, ePrivato(ip) === true);
for (const ip of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '93.184.216.34', '2606:4700::1111', '::ffff:8.8.8.8'])
  verifica(`non privato ${ip}`, ePrivato(ip) === false);

const sito = (u, o = {}) => leggiSito(u, o);
verifica('sito: http://127.0.0.1:5050 rifiutato', /rete interna|stesso server/.test(await rifiuta(() => sito('http://127.0.0.1:5050')) || ''));
verifica('sito: metadata cloud 169.254.169.254 rifiutato', /rete interna/.test(await rifiuta(() => sito('http://169.254.169.254/latest/meta-data')) || ''));
verifica('sito: localhost rifiutato', /rete interna|stesso server/.test(await rifiuta(() => sito('localhost:5050')) || ''));
verifica('sito: [::1] rifiutato', /rete interna|stesso server/.test(await rifiuta(() => sito('http://[::1]:8080')) || ''));
verifica('sito: file:// rifiutato', Boolean(await rifiuta(() => sito('file:///etc/passwd'))));
verifica('sito: ftp:// rifiutato (schema)', /solo http e https/.test(await rifiuta(() => controllaUrl('ftp://esempio.it/x')) || ''));
verifica('sito: host che risolve a 10.x rifiutato (DNS finto)', /rete interna.*10\.0\.0\.7/.test(await rifiuta(() => sito('https://interno.test', { risolvi: fintoDns({ 'interno.test': ['10.0.0.7'] }) })) || ''));
verifica('sito: host con risposte miste (pubblico + 192.168) rifiutato', /rete interna/.test(await rifiuta(() => sito('https://misto.test', { risolvi: fintoDns({ 'misto.test': ['93.184.216.34', '192.168.1.5'] }) })) || ''));
{
  process.env.ALLOW_PRIVATE_FETCH = '1';
  const m = await rifiuta(() => controllaUrl('https://interno.test', { risolvi: fintoDns({ 'interno.test': ['10.0.0.7'] }) }));
  verifica('ALLOW_PRIVATE_FETCH=1 consente la rete privata', m === null, m);
  const m2 = await rifiuta(() => controllaUrl(`http://127.0.0.1:${PORTA}/`));
  verifica('...ma mai il server stesso', /stesso server/.test(m2 || ''), m2);
  delete process.env.ALLOW_PRIVATE_FETCH;
}
// redirect: ogni salto è ricontrollato (fetch finto, nessuna rete)
{
  const vero = globalThis.fetch;
  let chiamate = [];
  globalThis.fetch = async (u) => { chiamate.push(String(u)); return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } }); };
  const dns = fintoDns({ 'pubblico.test': ['93.184.216.34'] });
  const m = await rifiuta(() => recupera('https://pubblico.test/', {}, { privati: false, risolvi: dns }));
  verifica('redirect verso 169.254.169.254 bloccato al secondo salto', /rete interna/.test(m || '') && chiamate.length === 1, `${m} ${chiamate}`);
  chiamate = [];
  globalThis.fetch = async (u) => { chiamate.push(String(u)); return new Response(null, { status: 302, headers: { location: `/${chiamate.length}` } }); };
  const m2 = await rifiuta(() => recupera('https://pubblico.test/', {}, { privati: false, risolvi: dns }));
  verifica('catena di redirect: massimo 5 salti', /troppi reindirizzamenti/.test(m2 || '') && chiamate.length === 6, `${m2} ${chiamate.length}`);
  // l'intestazione Authorization non segue un redirect verso un altro sito
  let viste = [];
  globalThis.fetch = async (u, o) => { viste.push([String(u), o.headers.Authorization]); return viste.length === 1 ? new Response(null, { status: 301, headers: { location: 'https://altro.test/x' } }) : new Response('ok'); };
  await recupera('https://pubblico.test/', { headers: { Authorization: 'Basic xxx' } }, { privati: true, risolvi: fintoDns({ 'pubblico.test': ['93.184.216.34'], 'altro.test': ['93.184.216.35'] }) });
  verifica('Authorization non segue il redirect su un altro sito', viste[0][1] === 'Basic xxx' && viste[1][1] === undefined, JSON.stringify(viste));
  globalThis.fetch = vero;
}
// CalDAV / iCal: reti private ok, schemi strani e server stesso no
{
  const pr = { privati: true, porta: PORTA };
  verifica('CalDAV: 192.168.1.20 (Nextcloud in casa) consentito', (await rifiuta(() => controllaUrl('https://192.168.1.20/remote.php/dav', pr))) === null);
  verifica('CalDAV: host che risolve a 10.x consentito', (await rifiuta(() => controllaUrl('https://nextcloud.casa/dav', { ...pr, risolvi: fintoDns({ 'nextcloud.casa': ['10.0.0.9'] }) }))) === null);
  verifica('CalDAV: 127.0.0.1 su un\'altra porta consentito (Radicale locale)', (await rifiuta(() => controllaUrl('http://127.0.0.1:5232/', pr))) === null);
  verifica(`CalDAV: http://localhost:${PORTA} (il server stesso) rifiutato`, /stesso server/.test((await rifiuta(() => controllaUrl(`http://localhost:${PORTA}/impostazioni`, pr))) || ''));
  verifica(`CalDAV: http://127.0.0.1:${PORTA} rifiutato`, /stesso server/.test((await rifiuta(() => controllaUrl(`http://127.0.0.1:${PORTA}/`, pr))) || ''));
  verifica(`CalDAV: http://[::1]:${PORTA} rifiutato`, /stesso server/.test((await rifiuta(() => controllaUrl(`http://[::1]:${PORTA}/`, pr))) || ''));
  verifica('CalDAV: file:// rifiutato', /solo http e https/.test((await rifiuta(() => controllaUrl('file:///etc/passwd', pr))) || ''));
  const r = await leggiCalendari(`file:///etc/passwd http://127.0.0.1:${PORTA}/api/impostazioni`);
  verifica('iCal (leggiCalendari): file:// e server stesso finiscono negli errori', r.errori.length === 2 && r.eventi.length === 0, JSON.stringify(r.errori));
}
// un server HTTP locale (altra porta) serve un iCal: con privati:true si legge
{
  const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20300101T090000Z\r\nDTEND:20300101T100000Z\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
  const s = http.createServer((q, r) => r.end(ics)).listen(0, '127.0.0.1');
  await new Promise((r) => s.on('listening', r));
  const r = await leggiCalendari(`http://127.0.0.1:${s.address().port}/c.ics`);
  verifica('iCal su rete locale (altra porta) si legge', r.eventi.length === 1 && !r.errori.length, JSON.stringify(r));
  s.close();
}
// sito pubblico vero
{
  const pagine = await leggiSito('lasercamp.it').catch((e) => e);
  verifica('sito pubblico vero (lasercamp.it) funziona ancora', Array.isArray(pagine) && pagine.length > 0, String(pagine?.message || ''));
  if (Array.isArray(pagine)) console.log(`    (${pagine.length} pagine lette)`);
}

console.log(`\n${ok} ✓, ${ko} ✗`);
process.exit(ko ? 1 : 0);
