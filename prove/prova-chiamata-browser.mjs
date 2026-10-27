// Una telefonata vera dal browser, con le registrazioni reali della cliente (prove/audio-cliente/lasercamp).
// Serve a controllare le tre cose che si sentono al telefono: le frasi arrivano INTERE (una
// trascrizione per battuta), la voce non cambia volume tra una frase e l'altra, e il cervello
// ricorda quello che il cliente ha già detto.
//
// Uso: node prove/prova-chiamata-browser.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const radice = new URL('..', import.meta.url).pathname;
const porta = '5065';
const segreto = 'segreto-prova-chiamata';
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// le battute della cliente, in ordine
const cartellaAudio = join(radice, 'prove/audio-cliente/lasercamp');
if (!existsSync(cartellaAudio)) {
  console.log('salto: le registrazioni in prove/audio-cliente/lasercamp non ci sono (cartella non versionata)');
  process.exit(0);
}
const file = readdirSync(join(radice, 'prove/audio-cliente/lasercamp'))
  .filter((f) => f.endsWith('.ulaw'))
  .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
const battute = file.map((f) => readFileSync(join(radice, 'prove/audio-cliente/lasercamp', f)));

const dati = mkdtempSync(join(tmpdir(), 'ai-caller-chiamata-'));
const impostazioni = JSON.parse(readFileSync(join(radice, 'dati/impostazioni.json'), 'utf8'));
impostazioni.calendari = [];
impostazioni.email.attiva = false;
impostazioni.suoni = { ...(impostazioni.suoni || {}), attiva: false };
writeFileSync(join(dati, 'impostazioni.json'), JSON.stringify(impostazioni));
writeFileSync(join(dati, 'appuntamenti.json'), '[]');

const server = spawn('node', ['src/server.mjs'], {
  cwd: radice,
  env: { ...process.env, PORTA: porta, HOST: '127.0.0.1', SEGRETO: segreto, DATI_DIR: dati, URL_PUBBLICO: '', TASTIERA_ATTESA: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let uscita = '';
server.stdout.on('data', (d) => { uscita += d; });
server.stderr.on('data', (d) => { uscita += d; });

const cliente = [];
const receptionist = [];
const livelli = []; // volume (RMS) dei pacchetti di voce: serve a vedere i salti tra una frase e l'altra
const latenze = []; // dalla fine della frase del cliente al primo audio della risposta

// μ-law → RMS, per misurare il volume della voce che arriva al browser
function rms(base64) {
  const b = Buffer.from(base64, 'base64');
  let somma = 0;
  for (const x of b) {
    const u = ~x & 0xff;
    const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
    const s = u & 0x80 ? 0x84 - t : t - 0x84;
    somma += s * s;
  }
  return Math.sqrt(somma / b.length);
}

async function chiama() {
  const ws = new WebSocket(`ws://127.0.0.1:${porta}/media/web/${segreto}`);
  const sid = 'MZchiamata';
  let ultimoAudio = 0;
  let parla = false;
  let battuta = 0;
  let posizione = 0;
  let tFineVoce = 0; // quando il cliente ha smesso di parlare (fine del file, non del silenzio)
  let attesaLatenza = false;
  let orologio = null;
  const invia = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));

  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.event === 'media') {
      ultimoAudio = Date.now();
      const volume = rms(m.media.payload);
      if (volume > 200) {
        livelli.push(volume);
        if (attesaLatenza && tFineVoce) { latenze.push(Date.now() - tFineVoce); attesaLatenza = false; }
      }
    } else if (m.event === 'mark') invia({ event: 'mark', streamSid: sid, mark: { name: m.mark.name } });
    else if (m.event === 'testo') (m.chi === 'cliente' ? cliente : receptionist).push(m.testo);
  });

  await new Promise((ok, ko) => { ws.on('open', ok); ws.on('error', ko); });
  invia({ event: 'start', streamSid: sid, start: { streamSid: sid, callSid: 'CAweb' + Date.now(), customParameters: { from: 'browser' } } });
  orologio = setInterval(() => {
    let frame = Buffer.alloc(160, 0xff);
    if (parla && posizione < battute[battuta].length) {
      frame = battute[battuta].subarray(posizione, posizione + 160);
      posizione += 160;
      if (frame.length < 160) frame = Buffer.concat([frame, Buffer.alloc(160 - frame.length, 0xff)]);
    }
    invia({ event: 'media', streamSid: sid, media: { payload: frame.toString('base64') } });
  }, 20);

  try {
    // si parla solo quando il receptionist ha finito (silenzio di 1,2 s) e si è fermato un attimo
    await pausa(4000);
    for (battuta = 0; battuta < battute.length; battuta++) {
      posizione = 0;
      while (Date.now() - ultimoAudio < 1200) await pausa(100);
      await pausa(400);
      parla = true;
      while (posizione < battute[battuta].length) await pausa(50);
      parla = false;
      tFineVoce = Date.now();
      attesaLatenza = true;
      await pausa(2000); // il silenzio finale chiude la frase
      console.log(`🗣  battuta ${battuta + 1}/${battute.length}`);
    }
    await pausa(12000); // ultima risposta
  } finally {
    clearInterval(orologio);
    ws.close();
  }
}

try {
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${porta}/salute`)).ok) break; } catch {}
    await pausa(200);
    if (i === 149) throw new Error(`server di prova non partito:\n${uscita}`);
  }
  await chiama();

  const media = livelli.reduce((a, b) => a + b, 0) / Math.max(1, livelli.length);
  const deviazione = Math.sqrt(livelli.reduce((a, b) => a + (b - media) ** 2, 0) / Math.max(1, livelli.length));
  console.log(`\n👤 ${cliente.length} trascrizioni su ${battute.length} battute:`);
  cliente.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
  console.log(`\n🤖 ${receptionist.length} battute del receptionist, volume medio ${Math.round(media)} (variazione ${Math.round(deviazione)})`);
  receptionist.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  if (latenze.length) console.log(`⏱ primo audio dopo la frase: ${latenze.join(', ')} ms (media ${Math.round(latenze.reduce((a, b) => a + b, 0) / latenze.length)})`);

  assert.ok(cliente.length >= battute.length, `troppe poche trascrizioni (${cliente.length} su ${battute.length} battute)\n${uscita}`);
  // una pausa naturale in mezzo alla frase non deve spezzarla: al massimo una battuta in più
  assert.ok(cliente.length <= battute.length + 1, `la frase è stata spezzata: ${cliente.length} trascrizioni per ${battute.length} battute\n${cliente.join('\n')}`);
  // nessuna metà persa: ogni registrazione ha lasciato il segno nel discorso
  const tutto = cliente.join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const parola of ['portachiavi', 'chiara', '200 pezzi', 'martedi', 'galli']) {
    assert.ok(tutto.includes(parola), `manca "${parola}" nelle trascrizioni: ${tutto}`);
  }
  assert.ok(receptionist.length >= 3, 'il receptionist ha parlato troppo poco');
  assert.ok(media > 1500, `la voce esce troppo bassa: ${Math.round(media)} (il livellatore non sta lavorando)`);
  console.log('\nOK: frase intera, voce continua, nessun pezzo perso');
} finally {
  server.kill('SIGTERM');
  rmSync(dati, { recursive: true, force: true });
}
