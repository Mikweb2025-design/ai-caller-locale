// Prova reale del flusso browser con dati temporanei: email, riepilogo, consenso e salvataggio.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const radice = new URL('..', import.meta.url).pathname;
const dati = mkdtempSync(join(tmpdir(), 'ai-caller-prenotazione-'));
const porta = '5063';
const segreto = 'segreto-prova-browser';
const impostazioni = JSON.parse(readFileSync(join(radice, 'dati/impostazioni.json'), 'utf8'));
impostazioni.calendari = [];
impostazioni.email.attiva = false;
impostazioni.email.chiediEmail = true;
writeFileSync(join(dati, 'impostazioni.json'), JSON.stringify(impostazioni));
writeFileSync(join(dati, 'appuntamenti.json'), '[]');

const ambiente = { ...process.env, PORTA: porta, HOST: '127.0.0.1', SEGRETO: segreto, DATI_DIR: dati, URL_PUBBLICO: '' };
const server = spawn('node', ['src/server.mjs'], { cwd: radice, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
let uscitaServer = '';
server.stdout.on('data', (d) => { uscitaServer += d; });
server.stderr.on('data', (d) => { uscitaServer += d; });
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${porta}/salute`)).ok) break; } catch {}
    await pausa(200);
    if (i === 99) throw new Error(`server di prova non partito:\n${uscitaServer}`);
  }
  const chat = spawn('node', ['prove/chat-prova.mjs',
    'Vorrei fissare un appuntamento per lunedì ventisei ottobre alle quattordici. Mi chiamo Mario Prova e vorrei una consulenza.',
    'mario punto prova chiocciola esempio punto it',
    'Okay, ciao.'
  ], { cwd: radice, env: { ...ambiente, WS_BASE: `ws://127.0.0.1:${porta}`, DURATA_MS: '60000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let uscitaChat = '';
  chat.stdout.on('data', (d) => { uscitaChat += d; });
  chat.stderr.on('data', (d) => { uscitaChat += d; });
  await new Promise((resolve, reject) => { chat.on('exit', (c) => c === 0 ? resolve() : reject(new Error(uscitaChat))); });
  await pausa(500);
  const lista = JSON.parse(readFileSync(join(dati, 'appuntamenti.json'), 'utf8'));
  assert.equal(lista.length, 1, `${uscitaChat}\n${uscitaServer}`);
  assert.equal(lista[0].nome, 'Mario Prova');
  assert.equal(lista[0].email, 'mario.prova@esempio.it');
  assert.equal(lista[0].giorno, '2026-10-26');
  assert.equal(lista[0].ora, '14:00');
  console.log('prenotazione browser salvata con email: OK');
} finally {
  server.kill('SIGTERM');
  await pausa(300);
  rmSync(dati, { recursive: true, force: true });
}
