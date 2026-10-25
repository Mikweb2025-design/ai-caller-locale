// Richieste verso indirizzi scelti dall'utente (sito da importare, calendari CalDAV/iCal) con controlli
// contro l'SSRF: solo http/https, ogni salto di redirect ricontrollato (max 5), e il nome dell'host
// viene risolto (tutte le risposte DNS) prima di decidere.
//   privati: false → rifiuta anche reti private/loopback/link-local (importa dal sito)
//   privati: true  → le reti private sono ok (un Nextcloud in casa), ma mai il server stesso (localhost:PORTA)
// ALLOW_PRIVATE_FETCH=1 nell'ambiente toglie il blocco delle reti private anche per l'importazione dal sito.
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { CONFIG } from './config.mjs';

const MAX_SALTI = 5;

// "1.2.3.4" → numero a 32 bit
const v4 = (ip) => ip.split('.').reduce((n, x) => n * 256 + Number(x), 0);
const IN_RETE = (ip, base, bit) => Math.floor(v4(ip) / 2 ** (32 - bit)) === Math.floor(v4(base) / 2 ** (32 - bit));

// IPv4-mapped (::ffff:a.b.c.d o ::ffff:7f00:1) → IPv4 puro
function normalizza(ip) {
  ip = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const m = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || null;
  if (m) return m[1];
  const h = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (h) { const a = parseInt(h[1], 16), b = parseInt(h[2], 16); return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`; }
  return ip;
}

export function eLoopback(ip) {
  ip = normalizza(ip);
  if (net.isIPv4(ip)) return IN_RETE(ip, '127.0.0.0', 8) || IN_RETE(ip, '0.0.0.0', 8); // 0.0.0.0 = questo computer
  return ip === '::1' || ip === '::';
}

// 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16 (+ 0/8), ::1, fc00::/7, fe80::/10
export function ePrivato(ip) {
  ip = normalizza(ip);
  if (net.isIPv4(ip)) return eLoopback(ip) || IN_RETE(ip, '10.0.0.0', 8) || IN_RETE(ip, '172.16.0.0', 12) || IN_RETE(ip, '192.168.0.0', 16) || IN_RETE(ip, '169.254.0.0', 16);
  if (net.isIPv6(ip)) {
    if (eLoopback(ip)) return true;
    const primo = parseInt(ip.split(':')[0] || '0', 16);
    return (primo & 0xfe00) === 0xfc00 || (primo & 0xffc0) === 0xfe80;
  }
  return true; // non è un indirizzo: nel dubbio no
}

const risolviDns = (host) => dns.lookup(host, { all: true }).then((r) => r.map((x) => x.address));

// indirizzi di questo computer (il server può essere raggiungibile anche dal suo IP di rete)
const indirizziMiei = () => new Set(Object.values(os.networkInterfaces()).flat().map((i) => normalizza(i.address)));

// Controlla un indirizzo. Lancia un Error con un messaggio comprensibile se non va bene.
export async function controllaUrl(indirizzo, { privati = false, porta = CONFIG.porta, risolvi = risolviDns } = {}) {
  let u;
  try { u = new URL(indirizzo); } catch { throw new Error(`indirizzo non valido: ${String(indirizzo).slice(0, 80)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`indirizzo non consentito (solo http e https): ${u.protocol}//…`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const porteUrl = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const ip = net.isIP(host) ? [host] : await risolvi(host).catch((e) => { throw new Error(`indirizzo non raggiungibile (${host}): ${e.code || e.message}`); });
  if (!ip.length) throw new Error(`indirizzo non raggiungibile (${host})`);
  const consentitoPrivato = privati || process.env.ALLOW_PRIVATE_FETCH === '1';
  for (const a of ip) {
    if (!consentitoPrivato && ePrivato(a)) throw new Error(`indirizzo non consentito: ${host} punta alla rete interna (${a})`);
    if (porteUrl === Number(porta) && (eLoopback(a) || indirizziMiei().has(normalizza(a)))) throw new Error(`indirizzo non consentito: ${host}:${porteUrl} è questo stesso server`);
  }
  return u;
}

// Come fetch, ma con i controlli di sopra a ogni salto. Restituisce la Response; l'indirizzo
// finale (dopo i redirect) è in risposta.urlFinale.
export async function recupera(indirizzo, opzioni = {}, controlli = {}) {
  let url = String(indirizzo);
  let { method = 'GET', body, headers = {} } = opzioni;
  for (let salto = 0; ; salto++) {
    const u = await controllaUrl(url, controlli);
    const r = await fetch(u, { ...opzioni, method, body, headers, redirect: 'manual' });
    const dove = r.headers.get('location');
    if (![301, 302, 303, 307, 308].includes(r.status) || !dove) {
      Object.defineProperty(r, 'urlFinale', { value: u.href });
      return r;
    }
    await r.body?.cancel().catch(() => {});
    if (salto >= MAX_SALTI) throw new Error(`troppi reindirizzamenti (oltre ${MAX_SALTI})`);
    const prossimo = new URL(dove, u);
    // come fetch: 303 (e POST su 301/302) diventano GET senza corpo; cambiando sito le credenziali non seguono
    if (r.status === 303 && method !== 'HEAD' || (method === 'POST' && (r.status === 301 || r.status === 302))) { method = 'GET'; body = undefined; headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^content-/i.test(k))); }
    if (prossimo.origin !== u.origin) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^authorization$/i.test(k)));
    url = prossimo.href;
  }
}
