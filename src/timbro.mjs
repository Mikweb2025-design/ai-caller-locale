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

class RallentatoreNaturale {
  constructor(fattore = 1.035) {
    this.passo = 1 / fattore;
    this.posizione = 0;
    this.precedente = null;
  }

  applica(pcm) {
    const n = pcm.length >> 1;
    if (!n) return Buffer.alloc(0);
    const campioni = new Int16Array(n + (this.precedente === null ? 0 : 1));
    let offset = 0;
    if (this.precedente !== null) { campioni[0] = this.precedente; offset = 1; }
    for (let i = 0; i < n; i++) campioni[i + offset] = pcm.readInt16LE(i * 2);
    if (this.precedente === null) this.posizione = 0;
    const valori = [];
    while (this.posizione < campioni.length - 1) {
      const i = Math.floor(this.posizione);
      const frazione = this.posizione - i;
      valori.push(limita16(campioni[i] + (campioni[i + 1] - campioni[i]) * frazione));
      this.posizione += this.passo;
    }
    this.posizione -= campioni.length - 1;
    this.precedente = campioni[campioni.length - 1];
    const uscita = Buffer.allocUnsafe(valori.length * 2);
    for (let i = 0; i < valori.length; i++) uscita.writeInt16LE(valori[i], i * 2);
    return uscita;
  }
}

class LivellatoreNaturale {
  constructor(sr = SR) {
    this.inviluppo = 0;
    this.guadagno = 1;
    this.attaccoInviluppo = 1 - Math.exp(-1 / (0.02 * sr));
    this.rilascioInviluppo = 1 - Math.exp(-1 / (0.25 * sr));
    this.attaccoGuadagno = 1 - Math.exp(-1 / (0.035 * sr));
    this.rilascioGuadagno = 1 - Math.exp(-1 / (0.35 * sr));
  }

  applica(pcm) {
    const uscita = Buffer.allocUnsafe(pcm.length);
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const x = pcm.readInt16LE(i);
      const energia = x * x;
      const coefficiente = energia > this.inviluppo ? this.attaccoInviluppo : this.rilascioInviluppo;
      this.inviluppo += (energia - this.inviluppo) * coefficiente;
      const livello = Math.sqrt(Math.max(1, this.inviluppo));
      const desiderato = livello < 350 ? this.guadagno : Math.max(0.35, Math.min(1.22, 2700 / livello));
      const velocita = desiderato < this.guadagno ? this.attaccoGuadagno : this.rilascioGuadagno;
      this.guadagno += (desiderato - this.guadagno) * velocita;
      uscita.writeInt16LE(limita16(x * this.guadagno), i);
    }
    return uscita;
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
  // Taratura dedicata alla voce scelta da Lasercamp: piu corpo, meno energia
  // squillante tra 2 e 4 kHz e cadenza appena piu calma (-3,4% circa).
  // L'intervento resta sotto un semitono, quindi l'identita non cambia.
  if (campione !== 'voce-f-2.wav') return { applica: (pcm) => pcm };
  const filtri = [scaffale('basso', 400, 1.0, 0.75, sr), scaffale('alto', 1800, -4.5, 0.75, sr)];
  const rallentatore = new RallentatoreNaturale(1.035);
  const livellatore = new LivellatoreNaturale(sr);
  return {
    applica(pcm) {
      const livellato = livellatore.applica(pcm);
      const equalizzato = Buffer.allocUnsafe(livellato.length);
      for (let i = 0; i + 1 < livellato.length; i += 2) {
        let valore = livellato.readInt16LE(i);
        for (const filtro of filtri) valore = filtro.passa(valore);
        equalizzato.writeInt16LE(limita16(valore), i);
      }
      return rallentatore.applica(equalizzato);
    },
  };
}
