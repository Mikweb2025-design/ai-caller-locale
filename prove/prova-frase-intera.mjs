// Una frase sola, detta con una pausa naturale in mezzo, deve arrivare al receptionist
// INTERA: una sola trascrizione, con tutte e due le metà. È il difetto che faceva perdere
// pezzi di frase nella chiamata dal browser (la pausa di 750 ms chiudeva il turno).
//
// Uso: node prove/prova-frase-intera.mjs                     (pausa di 900 ms: una frase sola)
//      PAUSA_MS=1700 node prove/prova-frase-intera.mjs       (pausa lunga: due frasi, va bene)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const radice = new URL('..', import.meta.url).pathname;
const PAUSA_MS = Number(process.env.PAUSA_MS || 900);
const ATTESO_INTERA = PAUSA_MS < 1500;
// due battute vere di una cliente (non sintetiche: il riconoscitore le capisce come al telefono)
if (!existsSync(join(radice, 'prove/audio-cliente/lasercamp/2.ulaw'))) {
  console.log('salto: le registrazioni in prove/audio-cliente/lasercamp non ci sono (cartella non versionata)');
  process.exit(0);
}
const PRIMA = readFileSync(join(radice, 'prove/audio-cliente/lasercamp/2.ulaw'));
const SECONDA = readFileSync(join(radice, 'prove/audio-cliente/lasercamp/5.ulaw'));
const porta = '5064';
const segreto = 'segreto-prova-frase';
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

const dati = mkdtempSync(join(tmpdir(), 'ai-caller-frase-'));
const impostazioni = JSON.parse(readFileSync(join(radice, 'dati/impostazioni.json'), 'utf8'));
impostazioni.calendari = [];
impostazioni.email.attiva = false;
impostazioni.email.chiediEmail = false;
impostazioni.suoni = { ...(impostazioni.suoni || {}), attiva: false };
writeFileSync(join(dati, 'impostazioni.json'), JSON.stringify(impostazioni));
writeFileSync(join(dati, 'appuntamenti.json'), '[]');

const ambiente = { ...process.env, PORTA: porta, HOST: '127.0.0.1', SEGRETO: segreto, DATI_DIR: dati, URL_PUBBLICO: '', TASTIERA_ATTESA: '0' };
const server = spawn('node', ['src/server.mjs'], { cwd: radice, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
let uscita = '';
server.stdout.on('data', (d) => { uscita += d; });
server.stderr.on('data', (d) => { uscita += d; });

// Una chiamata dal browser: silenzio finché parla il receptionist, poi la frase del cliente.
function chiama(audio) {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/media/web/${segreto}`);
  const sid = 'MZprova';
  const cliente = [];
  let ultimoAudio = 0;
  let posizione = 0;
  let parla = false;
  let orologio = null;
  const invia = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.event === 'media') ultimoAudio = Date.now();
    else if (m.event === 'mark') invia({ event: 'mark', streamSid: sid, mark: { name: m.mark.name } });
    else if (m.event === 'testo' && m.chi === 'cliente') cliente.push(m.testo);
  });

  return new Promise((risolvi, rifiuta) => {
    ws.on('error', rifiuta);
    ws.on('open', async () => {
      invia({ event: 'start', streamSid: sid, start: { streamSid: sid, callSid: 'CAprova' + Date.now(), customParameters: { from: 'browser' } } });
      // un solo orologio da 20 ms, come il worklet del browser: silenzio oppure audio del cliente
      orologio = setInterval(() => {
        let frame;
        if (parla && posizione < audio.length) {
          frame = audio.subarray(posizione, posizione + 160);
          posizione += 160;
          if (frame.length < 160) frame = Buffer.concat([frame, Buffer.alloc(160 - frame.length, 0xff)]);
        } else frame = Buffer.alloc(160, 0xff);
        invia({ event: 'media', streamSid: sid, media: { payload: frame.toString('base64') } });
      }, 20);
      // si aspetta la fine del saluto, poi si parla
      while (!ultimoAudio || Date.now() - ultimoAudio < 1500) await pausa(100);
      parla = true;
      while (posizione < audio.length) await pausa(100);
      parla = false;
      // coda di silenzio: la frase deve chiudersi (si aspetta che il server abbia finito)
      await pausa(8000);
      await pausa(1500);
      clearInterval(orologio);
      ws.close();
      risolvi(cliente);
    });
  });
}

try {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${porta}/salute`)).ok) break; } catch {}
    await pausa(200);
    if (i === 149) throw new Error(`server di prova non partito:\n${uscita}`);
  }

  const audio = Buffer.concat([PRIMA, Buffer.alloc((PAUSA_MS / 20) * 160, 0xff), SECONDA]);
  const cliente = await chiama(audio);
  const normalizza = (t) => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tutto = normalizza(cliente.join(' | '));
  console.log(`frase ricevuta (${cliente.length} trascrizioni): ${cliente.join(' | ')}`);
  assert.ok(cliente.length > 0, `nessuna trascrizione\n${uscita}`);
  assert.match(tutto, /portachiavi/, `la prima metà è andata persa: ${tutto}`);
  assert.match(tutto, /chiara/, `la seconda metà è andata persa: ${tutto}`);
  if (ATTESO_INTERA) assert.equal(cliente.length, 1, `la frase è stata spezzata in ${cliente.length} pezzi: ${cliente.join(' | ')}`);
  console.log(`OK: pausa di ${PAUSA_MS} ms → ${cliente.length} frase/i, nessun pezzo perso`);
} finally {
  server.kill('SIGTERM');
  rmSync(dati, { recursive: true, force: true });
}
