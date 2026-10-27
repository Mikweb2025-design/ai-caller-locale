// Worklet del microfono browser: Safari/iPhone usa normalmente 48 kHz anche quando si chiede
// un AudioContext a 8 kHz. Questo filtro passa-basso e ricampiona davvero a 8 kHz, producendo
// sempre frame telefonici da 160 campioni (20 ms).
export const FREQUENZA_MICROFONO_SERVER = 8000;
export const CAMPIONI_PER_FRAME = 160;
// Quanto audio già programmato deve esserci davanti alla voce quando la coda è vuota:
// un inizio nel passato fa perdere la testa del buffer (la prima sillaba del saluto).
export const MARGINE_AVVIO_SECONDI = 0.15;
export const MARGINE_AVVIO_IOS_SECONDI = 0.25;
export const MARGINE_MINIMO_SECONDI = 0.02;

// Programmatore dell'uscita audio della pagina: vive nel browser, ma la regola sta qui
// perché si possa provare senza orecchie (prove/prova-avvio-browser.mjs).
export function codiceProgrammazioneAudio() {
  return `const MARGINE_AVVIO = ${MARGINE_AVVIO_SECONDI};
const MARGINE_AVVIO_IOS = ${MARGINE_AVVIO_IOS_SECONDI};
const MARGINE_MINIMO = ${MARGINE_MINIMO_SECONDI};
// Quando parte un buffer: la coda continua senza buchi, ma se è vuota (inizio chiamata,
// dopo un'interruzione, contesto audio appena svegliato) si riparte con un margine vero.
// Programmare nel passato è quello che ogni tanto mangiava la prima sillaba.
function inizioBuffer(prossimo, adesso, ios) {
  if (prossimo > adesso + MARGINE_MINIMO) return prossimo;
  return adesso + (ios ? MARGINE_AVVIO_IOS : MARGINE_AVVIO);
}`;
}

// Ricampionamento di andata della voce (8 kHz → rate del dispositivo). La posizione
// frazionaria continua da un pacchetto all'altro: ripartire da zero a ogni 20 ms sposta la
// fase a ogni confine e si sente come un ronzio metallico che va e viene. Vive nel browser,
// ma la regola sta qui perché si possa provare senza orecchie (prove/prova-avvio-browser.mjs).
export function codiceRicampionamentoAudio() {
  return `function ricampionaPacchetto(valori, stato, su) {
  const n = valori.length, passo = 8000 / su;
  const campione = (i) => i < 0 ? (stato.ultimo ?? valori[0]) : (i < n ? valori[i] : valori[n - 1]);
  const pezzi = [];
  let x = stato.resto;
  while (x < n - 1) {
    const j = Math.floor(x), fr = x - j;
    const a = campione(j), b = campione(j + 1);
    pezzi.push(a + (b - a) * fr);
    x += passo;
  }
  stato.resto = x - n;          // dove riprende il prossimo pacchetto (tra -1 e 0)
  stato.ultimo = valori[n - 1];
  return pezzi;
}`;
}

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
