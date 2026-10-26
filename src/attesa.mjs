// Piccoli tocchi di tastiera durante l'attesa del cervello. L'audio e gia nel formato
// telefonico μ-law 8 kHz e viene inviato senza mark: non conta come voce di Maria.
import { aMulaw } from './voce.mjs';

const SR = 8000;
const VOLUME_MASSIMO = 0.04;

const limita = (valore, minimo, massimo) => Math.min(massimo, Math.max(minimo, Number.isFinite(Number(valore)) ? Number(valore) : minimo));
const intero = (minimo, massimo, casuale) => Math.floor(minimo + casuale() * (massimo - minimo + 1));
const tra = (minimo, massimo, casuale) => minimo + casuale() * (massimo - minimo);

export function creaToccoTastiera({ volume = 0.025, casuale = Math.random } = {}) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  if (livello === 0) return Buffer.alloc(0);

  const tocchi = intero(2, 4, casuale);
  const partenze = [];
  let durataTotale = 0;
  for (let n = 0; n < tocchi; n++) {
    partenze.push(durataTotale);
    const durata = intero(18, 28, casuale);
    durataTotale += durata + (n + 1 < tocchi ? intero(38, 72, casuale) : 18);
  }

  const pcm = Buffer.alloc(Math.ceil(durataTotale * SR / 1000) * 2);
  for (const partenzaMs of partenze) {
    const inizio = Math.floor(partenzaMs * SR / 1000);
    const durata = intero(18, 28, casuale);
    const campioni = Math.floor(durata * SR / 1000);
    const frequenza = tra(1250, 2100, casuale);
    for (let i = 0; i < campioni; i++) {
      const inviluppo = Math.exp(-i / (SR * 0.0065));
      const metallico = Math.sin(2 * Math.PI * frequenza * i / SR);
      const fruscio = casuale() * 2 - 1;
      const valore = Math.round(32767 * livello * inviluppo * (0.68 * metallico + 0.32 * fruscio));
      pcm.writeInt16LE(limita(valore, -32768, 32767), (inizio + i) * 2);
    }
  }
  return aMulaw(pcm);
}

export function creaRumoreAttesa({
  invia,
  attivo = true,
  volume = 0.025,
  casuale = Math.random,
  pianifica = setTimeout,
  annulla = clearTimeout,
} = {}) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  const abilitato = Boolean(attivo && livello > 0 && typeof invia === 'function');
  let inCorso = false;
  let haInviato = false;
  let timer = null;

  const programma = (iniziale) => {
    const ritardo = iniziale ? tra(350, 500, casuale) : tra(700, 1400, casuale);
    timer = pianifica(() => {
      timer = null;
      if (!inCorso) return;
      const audio = creaToccoTastiera({ volume: livello, casuale });
      if (audio.length) {
        invia(audio);
        haInviato = true;
      }
      if (inCorso) programma(false);
    }, ritardo);
  };

  return {
    get inCorso() { return inCorso; },
    get haInviato() { return haInviato; },
    avvia() {
      if (!abilitato || inCorso) return false;
      inCorso = true;
      haInviato = false;
      programma(true);
      return true;
    },
    ferma() {
      if (timer !== null) annulla(timer);
      timer = null;
      inCorso = false;
      const inviato = haInviato;
      haInviato = false;
      return inviato;
    },
  };
}

export function fermaAttesaPrimaDellaVoce(attesa, svuota) {
  const avevaAudio = Boolean(attesa?.ferma());
  if (avevaAudio) svuota();
  return avevaAudio;
}
