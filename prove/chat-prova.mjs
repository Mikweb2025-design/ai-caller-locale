// Chiamata in sola chat (stesso protocollo della pagina web): scrive le frasi date una alla volta,
// aspettando che il receptionist abbia finito di parlare, e salva l'audio ricevuto in $OUT.
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
const frasi = process.argv.slice(2);
const ws = new WebSocket('ws://127.0.0.1:5050/media/web/locale');
const sid = 'MZprova'; const audio = []; let marche = []; let ultimoAudio = 0; let attesa = false; let turno = 0; let tTesto = 0;
const invia = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
ws.on('open', () => {
  invia({ event: 'start', streamSid: sid, start: { streamSid: sid, callSid: 'CAprova' + Date.now(), customParameters: { from: 'browser' } } });
  setInterval(() => invia({ event: 'media', streamSid: sid, media: { payload: Buffer.alloc(160, 0xff).toString('base64') } }), 20);
  setInterval(() => {
    for (const m of marche) invia({ event: 'mark', streamSid: sid, mark: { name: m } });
    marche = [];
    if (attesa && ultimoAudio > tTesto - 8000 && Date.now() - ultimoAudio > 2500 && Date.now() - tTesto > 3000 && turno < frasi.length) { attesa = false; invia({ event: 'testo', testo: frasi[turno++] }); }
  }, 200);
});
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.event === 'media') { audio.push(Buffer.from(m.media.payload, 'base64')); ultimoAudio = Date.now(); }
  if (m.event === 'mark') marche.push(m.mark.name);
  if (m.event === 'testo') { console.log(`${m.chi === 'cliente' ? '👤' : '🤖'} ${m.testo}`); if (m.chi === 'receptionist') { attesa = true; tTesto = Date.now(); } }
});
ws.on('close', () => { if (process.env.OUT) writeFileSync(process.env.OUT, Buffer.concat(audio)); process.exit(0); });
setTimeout(() => ws.close(), 180000);
