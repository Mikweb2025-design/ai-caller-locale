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

// Voce più calda: abbassa il tono (f0 ~235 Hz del motore, troppo acuto al telefono)
// senza allungare la frase. Ricampiona (tono giù) e poi ricompatta con WSOLA: la
// durata resta quella originale, quindi il parlato rimane naturale e non "strascicato".
class VocePiuCalda {
  constructor(fattore = 0.82) {
    this.passo = fattore;      // <1 = tono più basso
    this.L = 240;              // grano 30 ms a 8 kHz
    this.Hs = 120;             // avanzo d'uscita 15 ms
    this.SALTO = 60;           // ricerca di allineamento ±7,5 ms
    this.finestra = new Float32Array(this.L);
    for (let i = 0; i < this.L; i++) this.finestra[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.L);
    this.buf = new Float32Array(8192);
    this.len = 0;
    this.pos = 0;
    this.ultimo = null;
    this.ideale = 0;
    this.atteso = null;
    this.acc = new Float32Array(8192);
    this.peso = new Float32Array(8192);
    this.scritto = 0;
    this.primo = true;
  }

  #aggiungi(campioni) {
    if (this.len + campioni.length > this.buf.length) {
      const nuovo = new Float32Array(Math.max(this.buf.length * 2, this.len + campioni.length + 4096));
      nuovo.set(this.buf.subarray(0, this.len));
      this.buf = nuovo;
    }
    this.buf.set(campioni, this.len);
    this.len += campioni.length;
  }

  #ricampiona(pcm) {
    const n = pcm.length >> 1;
    if (!n) return;
    const src = new Float32Array(n + (this.ultimo === null ? 0 : 1));
    let off = 0;
    if (this.ultimo !== null) { src[0] = this.ultimo; off = 1; }
    for (let i = 0; i < n; i++) src[i + off] = pcm.readInt16LE(i * 2) / 32768;
    const uscita = [];
    let pos = this.pos;
    while (pos < src.length - 1) {
      const i = Math.floor(pos);
      const frazione = pos - i;
      uscita.push(src[i] + (src[i + 1] - src[i]) * frazione);
      pos += this.passo;
    }
    this.pos = pos - (src.length - 1);
    this.ultimo = src[src.length - 1];
    if (uscita.length) this.#aggiungi(Float32Array.from(uscita));
  }

  #grano() {
    const { L, Hs, SALTO, buf } = this;
    if (Math.round(this.ideale) + L + SALTO > this.len) return false;
    let inizio = Math.round(this.ideale);
    if (!this.primo && this.atteso) {
      let migliore = 0;
      let punteggio = -Infinity;
      for (let delta = -SALTO; delta <= SALTO; delta++) {
        const p = inizio + delta;
        if (p < 0 || p + SALTO > this.len) continue;
        let somma = 0;
        for (let i = 0; i < SALTO; i++) somma += buf[p + i] * this.atteso[i];
        if (somma > punteggio) { punteggio = somma; migliore = delta; }
      }
      inizio += migliore;
    }
    if (this.scritto + L > this.acc.length) {
      const nuovo = new Float32Array(Math.max(this.acc.length * 2, this.scritto + L + 4096));
      nuovo.set(this.acc.subarray(0, this.scritto));
      this.acc = nuovo;
      const nuovoPeso = new Float32Array(nuovo.length);
      nuovoPeso.set(this.peso.subarray(0, this.scritto));
      this.peso = nuovoPeso;
    }
    for (let i = 0; i < L; i++) {
      const w = this.finestra[i];
      this.acc[this.scritto + i] += buf[inizio + i] * w;
      this.peso[this.scritto + i] += w;
    }
    // il seguito naturale del grano appena messo: dove l'audio originale proseguirebbe
    this.atteso = Float32Array.from(buf.subarray(inizio + Hs, inizio + Hs + SALTO));
    // la posizione avanza con passo fisso: l'allineamento non deve far derivare la durata
    this.ideale += Hs / this.passo;
    this.scritto += Hs;
    this.primo = false;
    return true;
  }

  applica(pcm) {
    this.#ricampiona(pcm);
    while (this.#grano()) { /* grani finché ci sono dati */ }
    const uscita = Buffer.allocUnsafe(this.scritto * 2);
    for (let i = 0; i < this.scritto; i++) {
      const peso = this.peso[i];
      const v = Math.max(-1, Math.min(1, peso > 1e-6 ? this.acc[i] / peso : 0));
      uscita.writeInt16LE(limita16(v * 32767), i * 2);
    }
    // resta solo la coda del grano ancora incompleta (Hs campioni), non tutto il buffer
    const coda = this.acc.slice(this.scritto, this.scritto + (this.L - this.Hs));
    const codaPeso = this.peso.slice(this.scritto, this.scritto + (this.L - this.Hs));
    this.acc = new Float32Array(8192);
    this.acc.set(coda);
    this.peso = new Float32Array(8192);
    this.peso.set(codaPeso);
    this.scritto = 0;
    return uscita;
  }

  // Fine frase: qualche decina di ms di coda, altrimenti l'ultima consonante si perde.
  chiudi() {
    return this.applica(Buffer.alloc((this.L + this.SALTO) * 2));
  }

  // Frase interrotta a metà: si butta quello che resta nei buffer, senza toccare il livello.
  riparti() {
    this.len = 0;
    this.pos = 0;
    this.ultimo = null;
    this.ideale = 0;
    this.atteso = null;
    this.scritto = 0;
    this.primo = true;
    this.buf = new Float32Array(8192);
    this.acc = new Float32Array(8192);
    this.peso = new Float32Array(8192);
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

export const VERSIONE_TIMBRO = '5';

export { VocePiuCalda };

// Equalizzazione telefonica: toglie solo quello che al telefono fa "squillare" una voce
// sintetica (picco nasale a 1,6 kHz e bordo oltre i 3,6 kHz), senza toccare il corpo.
export function creaEqualizzatoreVoce(campione, sr = SR) {
  const filtri = [
    campana(1600, 0.75, -1.0, sr),
    passaBasso(3600, Math.SQRT1_2, sr),
  ];
  return (pcm) => {
    const uscita = Buffer.allocUnsafe(pcm.length);
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      let valore = pcm.readInt16LE(i);
      for (const filtro of filtri) valore = filtro.passa(valore);
      uscita.writeInt16LE(limita16(valore), i);
    }
    return uscita;
  };
}

export function creaAddolcitoreVoce(campione, sr = SR) {
  // Catena completa: prima il tono (così l'equalizzazione colpisce le frequenze giuste),
  // poi il timbro, infine il livello.
  const calda = new VocePiuCalda(0.84);
  const livellatore = new LivellatoreNaturale(sr);
  const equalizza = creaEqualizzatoreVoce(campione, sr);
  return {
    // Prima il tono (così l'equalizzazione colpisce le frequenze giuste), poi il livello.
    applica(pcm) {
      return livellatore.applica(equalizza(calda.applica(pcm)));
    },
    chiudi() {
      const coda = calda.chiudi();
      return coda.length ? livellatore.applica(equalizza(coda)) : coda;
    },
    riparti() {
      calda.riparti();
    },
  };
}
