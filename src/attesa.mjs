// Piccoli tocchi di tastiera durante l'attesa del cervello. L'audio e gia nel formato
// telefonico μ-law 8 kHz e viene inviato senza mark: non conta come voce di Maria.
import { aMulaw, daMulaw } from './voce.mjs';

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

// Fruscio di carta: un foglio spostato sulla scrivania, sussurrato e breve.
export function creaFruscioCarta({ volume = 0.025, casuale = Math.random } = {}) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  if (livello === 0) return Buffer.alloc(0);
  const campioni = Math.floor(intero(180, 380, casuale) * SR / 1000);
  const pcm = Buffer.alloc(campioni * 2);
  let prima = 0;
  for (let i = 0; i < campioni; i++) {
    const inviluppo = Math.sin(Math.PI * i / campioni) ** 2;
    const rumore = casuale() * 2 - 1;
    const acuto = rumore - prima * 0.55; // leva via la parte grave: resta solo il fruscio
    prima = rumore;
    pcm.writeInt16LE(limita(Math.round(32767 * livello * inviluppo * acuto * 0.5), -32768, 32767), i * 2);
  }
  return aMulaw(pcm);
}

export function creaRumoreAttesa({
  invia,
  attivo = true,
  volume = 0.025,
  tipo = 'tastiera',
  casuale = Math.random,
  pianifica = setTimeout,
  annulla = clearTimeout,
} = {}) {
  // attivo, volume e tipo si possono passare anche come funzione: si leggono a ogni avvio,
  // così l'interruttore del pannello vale subito, anche a chiamata già in corso.
  const leggiAttivo = typeof attivo === 'function' ? attivo : () => Boolean(attivo);
  const leggiVolume = typeof volume === 'function' ? volume : () => volume;
  const leggiTipo = typeof tipo === 'function' ? tipo : () => tipo;
  const genera = (livello) => (leggiTipo() === 'ufficio' && casuale() < 0.25
    ? creaFruscioCarta({ volume: livello, casuale })
    : creaToccoTastiera({ volume: livello, casuale }));
  let inCorso = false;
  let haInviato = false;
  let timer = null;
  let livello = 0;

  const programma = (iniziale) => {
    const ritardo = iniziale ? tra(350, 500, casuale) : tra(700, 1400, casuale);
    timer = pianifica(() => {
      timer = null;
      if (!inCorso) return;
      const audio = genera(livello);
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
      livello = limita(leggiVolume(), 0, VOLUME_MASSIMO);
      if (!leggiAttivo() || livello <= 0 || typeof invia !== 'function' || inCorso) return false;
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

// Sorgente continua di suoni d'ufficio da mescolare sotto la voce di Maria: a ogni pezzo di
// voce si chiede lo stesso numero di byte di sottofondo, dentro ci sono i tocchi nel loro ritmo.
export function creaSuonoContinuo({
  attivo = () => true,
  volume = () => 0.025,
  tipo = () => 'tastiera',
  casuale = Math.random,
} = {}) {
  const leggiAttivo = typeof attivo === 'function' ? attivo : () => Boolean(attivo);
  const leggiVolume = typeof volume === 'function' ? volume : () => volume;
  const leggiTipo = typeof tipo === 'function' ? tipo : () => tipo;
  let resto = Buffer.alloc(0); // il tocco in corso, se è avanzato rispetto all'ultimo pezzo chiesto
  let pausa = Math.round(tra(700, 1400, casuale) * SR / 1000); // silenzio prima del prossimo tocco

  const genera = () => {
    pausa = Math.round(tra(700, 1400, casuale) * SR / 1000);
    const livello = limita(leggiVolume(), 0, VOLUME_MASSIMO);
    if (livello <= 0) return Buffer.alloc(0);
    return leggiTipo() === 'ufficio' && casuale() < 0.25
      ? creaFruscioCarta({ volume: livello, casuale })
      : creaToccoTastiera({ volume: livello, casuale });
  };

  return {
    // n byte di μ-law di sottofondo (silenzio 0xff compreso), oppure null se spento dal pannello
    strappa(n) {
      if (!leggiAttivo() || !(n > 0)) return null;
      const out = Buffer.alloc(n, 0xff);
      let scritti = 0;
      while (scritti < n) {
        if (resto.length) {
          const t = Math.min(resto.length, n - scritti);
          resto.copy(out, scritti, 0, t);
          resto = resto.slice(t);
          scritti += t;
        } else if (pausa > 0) {
          const t = Math.min(pausa, n - scritti);
          pausa -= t;
          scritti += t;
        } else {
          resto = genera();
        }
      }
      return out;
    },
  };
}

// Somma il sottofondo sulla voce: μ-law → PCM 16 bit → somma con taglio → μ-law. Nulla di
// bloccante: è matematica sul flusso in uscita, non aggiunge attesa alla risposta.
export function mescolaSuono(voce, sottofondo) {
  if (!sottofondo || !sottofondo.length || !voce?.length) return voce;
  const pcm = daMulaw(voce);
  const att = daMulaw(sottofondo.length >= voce.length ? sottofondo.slice(0, voce.length) : sottofondo);
  for (let i = 0; i < att.length; i += 2) {
    let s = pcm.readInt16LE(i) + att.readInt16LE(i);
    if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
    pcm.writeInt16LE(s, i);
  }
  return aMulaw(pcm);
}
