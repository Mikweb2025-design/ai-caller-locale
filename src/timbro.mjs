// Equalizzazione leggera dell'audio telefonico. Lavora sul PCM 16 bit a 8 kHz
// dopo la sintesi: l'identita della voce clonata non cambia, si attenua soltanto
// l'asprezza che il canale telefonico mette in evidenza.

const SR = 8000;

class Biquad {
  constructor({ b0, b1, b2, a1, a2 }) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2;
    this.a1 = a1; this.a2 = a2;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  passa(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

function scaffale(tipo, frequenza, db, pendenza = 0.8, sr = SR) {
  const a = 10 ** (db / 40);
  const w = 2 * Math.PI * frequenza / sr;
  const c = Math.cos(w), s = Math.sin(w);
  const alfa = s / 2 * Math.sqrt((a + 1 / a) * (1 / pendenza - 1) + 2);
  const beta = 2 * Math.sqrt(a) * alfa;
  let b0, b1, b2, a0, a1, a2;
  if (tipo === 'basso') {
    b0 = a * ((a + 1) - (a - 1) * c + beta);
    b1 = 2 * a * ((a - 1) - (a + 1) * c);
    b2 = a * ((a + 1) - (a - 1) * c - beta);
    a0 = (a + 1) + (a - 1) * c + beta;
    a1 = -2 * ((a - 1) + (a + 1) * c);
    a2 = (a + 1) + (a - 1) * c - beta;
  } else {
    b0 = a * ((a + 1) + (a - 1) * c + beta);
    b1 = -2 * a * ((a - 1) + (a + 1) * c);
    b2 = a * ((a + 1) + (a - 1) * c - beta);
    a0 = (a + 1) - (a - 1) * c + beta;
    a1 = 2 * ((a - 1) - (a + 1) * c);
    a2 = (a + 1) - (a - 1) * c - beta;
  }
  return new Biquad({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });
}

const limita16 = (n) => Math.max(-32768, Math.min(32767, Math.round(n)));

export function creaAddolcitoreVoce(campione, sr = SR) {
  // Taratura dedicata alla voce scelta da Lasercamp: +0,8 dB di corpo e
  // -2,8 dB sulle medio-alte. Le altre voci restano esattamente come sono.
  if (campione !== 'voce-f-2.wav') return { applica: (pcm) => pcm };
  const filtri = [scaffale('basso', 430, 0.8, 0.8, sr), scaffale('alto', 2100, -2.8, 0.8, sr)];
  return {
    applica(pcm) {
      const uscita = Buffer.allocUnsafe(pcm.length);
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        let valore = pcm.readInt16LE(i);
        for (const filtro of filtri) valore = filtro.passa(valore);
        uscita.writeInt16LE(limita16(valore), i);
      }
      return uscita;
    },
  };
}
