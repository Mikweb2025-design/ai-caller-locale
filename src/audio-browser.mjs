// Worklet del microfono browser: Safari/iPhone usa normalmente 48 kHz anche quando si chiede
// un AudioContext a 8 kHz. Questo filtro passa-basso e ricampiona davvero a 8 kHz, producendo
// sempre frame telefonici da 160 campioni (20 ms).
export const FREQUENZA_MICROFONO_SERVER = 8000;
export const CAMPIONI_PER_FRAME = 160;

export function codiceCatturaBrowser() {
  return `class Cattura extends AudioWorkletProcessor {
    constructor() {
      super();
      this.destinazione = ${FREQUENZA_MICROFONO_SERVER};
      this.frame = new Float32Array(${CAMPIONI_PER_FRAME});
      this.indiceFrame = 0;
      this.fase = 0;
      this.indiceFiltro = 0;
      this.storia = new Float32Array(31);
      this.filtro = new Float32Array(31);
      const centro = 15;
      const taglio = Math.min(3400, sampleRate * 0.45) / sampleRate;
      let somma = 0;
      for (let n = 0; n < this.filtro.length; n++) {
        const x = n - centro;
        const sinc = x === 0 ? 2 * taglio : Math.sin(2 * Math.PI * taglio * x) / (Math.PI * x);
        const finestra = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (this.filtro.length - 1));
        this.filtro[n] = sinc * finestra;
        somma += this.filtro[n];
      }
      for (let n = 0; n < this.filtro.length; n++) this.filtro[n] /= somma;
    }
    campioneFiltrato() {
      let valore = 0;
      let indice = this.indiceFiltro;
      for (let n = 0; n < this.filtro.length; n++) {
        indice = (indice - 1 + this.storia.length) % this.storia.length;
        valore += this.storia[indice] * this.filtro[n];
      }
      return valore;
    }
    process(ingressi) {
      const canale = ingressi[0] && ingressi[0][0];
      if (!canale) return true;
      for (const valore of canale) {
        this.storia[this.indiceFiltro] = valore;
        this.indiceFiltro = (this.indiceFiltro + 1) % this.storia.length;
        this.fase += this.destinazione;
        if (this.fase < sampleRate) continue;
        this.fase -= sampleRate;
        this.frame[this.indiceFrame++] = this.campioneFiltrato();
        if (this.indiceFrame === this.frame.length) {
          this.port.postMessage(this.frame.slice());
          this.indiceFrame = 0;
        }
      }
      return true;
    }
  }
  registerProcessor('cattura', Cattura);`;
}
