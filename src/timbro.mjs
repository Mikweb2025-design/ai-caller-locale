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
    this.media = 0;
    this.guadagno = 1;
    this.target = 2800; // energia media delle frasi: una voce al telefono si sente senza dover alzare il volume
    this.minimo = 0.5;
    this.massimo = 2.0;
    this.finestra = 1 - Math.exp(-1 / (0.5 * sr)); // 0,5 s: segue il volume della frase, non le singole sillabe
    this.attaccoGuadagno = 1 - Math.exp(-1 / (0.06 * sr));
    this.rilascioGuadagno = 1 - Math.exp(-1 / (0.3 * sr));
  }

  applica(pcm) {
    const uscita = Buffer.allocUnsafe(pcm.length);
    const tetto = 0.94 * 32767;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const x = pcm.readInt16LE(i);
      this.media += (x * x - this.media) * this.finestra;
      const livello = Math.sqrt(Math.max(1, this.media));
      const desiderato = livello < 300 ? this.guadagno : Math.max(this.minimo, Math.min(this.massimo, this.target / livello));
      const velocita = desiderato < this.guadagno ? this.attaccoGuadagno : this.rilascioGuadagno;
      this.guadagno += (desiderato - this.guadagno) * velocita;
      let y = x * this.guadagno;
      // oltre il tetto si comprime dolcemente: niente distorsione se una sillaba è più forte
      if (y > tetto) y = tetto + (y - tetto) * 0.1;
      else if (y < -tetto) y = -tetto + (y + tetto) * 0.1;
      uscita.writeInt16LE(limita16(y), i);
    }
    return uscita;
  }
}

// Campana (peaking EQ): colpisce solo la banda attorno a frequenza, lasciando il resto com'è.
function campana(frequenza, q, db, sr = SR) {
  const a = 10 ** (db / 40);
  const w = 2 * Math.PI * frequenza / sr;
  const alfa = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const b0 = 1 + alfa * a, b1 = -2 * c, b2 = 1 - alfa * a;
  const a0 = 1 + alfa / a, a1 = -2 * c, a2 = 1 - alfa / a;
  return new Biquad({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });
}

// Passa-basso: toglie il bordo del vocoder sopra la banda utile della voce.
function passaBasso(frequenza, q = Math.SQRT1_2, sr = SR) {
  const w = 2 * Math.PI * frequenza / sr;
  const alfa = Math.sin(w) / (2 * q);
  const c = Math.cos(w);
  const b0 = (1 - c) / 2, b1 = 1 - c, b2 = (1 - c) / 2;
  const a0 = 1 + alfa, a1 = -2 * c, a2 = 1 - alfa;
  return new Biquad({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });
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

export const VERSIONE_TIMBRO = '3';

export function creaAddolcitoreVoce(campione, sr = SR) {
  // Catena telefonica: non cambia chi è la voce, toglie solo quello che al telefono
  // fa "squillare" una voce sintetica, cioè il picco nasale attorno a 1,6 kHz, la
  // punta del vocoder a 3 kHz e il bordo oltre i 3,4 kHz. Il corpo (300-800 Hz) resta.
  const filtri = [
    campana(1600, 0.75, -4.5, sr),
    campana(3050, 1.15, -2.5, sr),
    scaffale('basso', 360, 0.5, 0.8, sr),
    passaBasso(3600, Math.SQRT1_2, sr),
  ];
  const rallentatore = new RallentatoreNaturale(1.035);
  const livellatore = new LivellatoreNaturale(sr);
  return {
    applica(pcm) {
      const equalizzato = Buffer.allocUnsafe(pcm.length);
      for (let i = 0; i + 1 < pcm.length; i += 2) {
        let valore = pcm.readInt16LE(i);
        for (const filtro of filtri) valore = filtro.passa(valore);
        equalizzato.writeInt16LE(limita16(valore), i);
      }
      return rallentatore.applica(livellatore.applica(equalizzato));
    },
  };
}
