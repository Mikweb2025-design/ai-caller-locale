// Genera l'audio delle battute del cliente finto (Qwen3-TTS locale) in μ-law 8 kHz,
// lo stesso formato audio delle telefonate Twilio. Uso: node prove/genera-cliente.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPIONI } from './copione.mjs';

// lingua del copione → lingua del motore vocale (it|en|de|es|fr); il resto si legge in italiano
const LINGUE = { tedesco: 'de', inglese: 'en', spagnolo: 'es', francese: 'fr' };

const qui = dirname(fileURLToPath(import.meta.url));

for (const [nome, battute] of Object.entries(COPIONI)) {
  const cartella = join(qui, 'audio-cliente', nome);
  mkdirSync(cartella, { recursive: true });
  const lingua = LINGUE[nome] || 'it';
  for (const [i, frase] of battute.entries()) {
    const ulaw = join(cartella, `${i + 1}.ulaw`);
    if (existsSync(ulaw)) continue;
    // voce del cliente: un altro speaker di Qwen3-TTS, dal motore locale (deve essere acceso)
    // un pezzo alla volta: sulle frasi lunghe il modello piccolo ogni tanto si ferma a metà
    const pezzi = [];
    for (const pezzo of frase.split(/(?<=[.!?…])\s+/).filter(Boolean)) {
      const r = await fetch('http://127.0.0.1:5051/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testo: pezzo, voce: process.env.VOCE_CLIENTE || 'aiden', lingua }),
      });
      if (!r.ok) throw new Error(`TTS ${r.status}: ${await r.text()}`);
      pezzi.push(Buffer.from(await r.arrayBuffer()));
    }
    const pcm = join(cartella, `${i + 1}.pcm`);
    writeFileSync(pcm, Buffer.concat(pezzi));
    // PCM 8 kHz → μ-law, togliendo il silenzio iniziale e finale
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', '8000', '-ac', '1', '-i', pcm,
      '-af', 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
      '-ar', '8000', '-ac', '1', '-f', 'mulaw', ulaw]);
    unlinkSync(pcm);
    console.log(`${nome} ${i + 1}. ${frase}`);
  }
}
console.log('Audio del cliente pronto.');
