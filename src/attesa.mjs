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

  // Una manciata di tasti, come si scrive: ritmo umano, mai perfettamente regolare.
  const tasti = intero(2, 5, casuale);
  const partenze = [];
  let durataTotale = 0;
  for (let n = 0; n < tasti; n++) {
    partenze.push({ inizio: durataTotale, forza: tra(0.65, 1, casuale) });
    durataTotale += intero(90, 240, casuale);
  }
  durataTotale += 60; // spazio per il rimbalzo dell'ultimo tasto

  const campioni = Math.ceil(durataTotale * SR / 1000);
  const pcm = Buffer.alloc(campioni * 2);
  const somma = (n, valore) => {
    if (n < 0 || n >= campioni) return;
    pcm.writeInt16LE(limita(pcm.readInt16LE(n * 2) + Math.round(valore), -32768, 32767), n * 2);
  };
  for (const { inizio, forza } of partenze) {
    const i0 = Math.floor(inizio * SR / 1000);
    // colpo d'urto: uno spike corto e ampio, come il contatto meccanico
    somma(i0, (casuale() * 2 - 1) * 32767 * livello * forza * 2.2);
    somma(i0 + 1, (casuale() * 2 - 1) * 32767 * livello * forza);
    // corpo: la risonanza del meccanismo che muore in fretta
    const frequenza = tra(1350, 2350, casuale);
    const durata = intero(7, 14, casuale);
    for (let i = 0; i < durata; i++) {
      const inviluppo = Math.exp(-i * 3.2 / durata);
      somma(i0 + i, Math.sin(2 * Math.PI * frequenza * i / SR) * 32767 * livello * forza * inviluppo * 0.9);
    }
    // il tasto che risale: clic più leggero e più acuto, un istante dopo
    const risalita = i0 + intero(45, 95, casuale);
    const frequenzaSu = tra(1800, 2900, casuale);
    const durataSu = intero(4, 9, casuale);
    for (let i = 0; i < durataSu; i++) {
      const inviluppo = Math.exp(-i * 3 / durataSu);
      somma(risalita + i, Math.sin(2 * Math.PI * frequenzaSu * i / SR) * 32767 * livello * forza * 0.45 * inviluppo);
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

// Aiuto comune: un clic meccanico con urto secco e corpo risonante; a volte doppio clic.
function sintetizzaClic({ volume, casuale, minF, maxF, doppioProbabilita = 0 }) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  if (livello === 0) return Buffer.alloc(0);
  const distanza = doppioProbabilita && casuale() < doppioProbabilita ? intero(90, 160, casuale) : 0;
  const campioni = Math.ceil((distanza + 40) * SR / 1000);
  const pcm = Buffer.alloc(campioni * 2);
  const somma = (n, valore) => {
    if (n < 0 || n >= campioni) return;
    pcm.writeInt16LE(limita(pcm.readInt16LE(n * 2) + Math.round(valore), -32768, 32767), n * 2);
  };
  const unClic = (inizioMs, forza) => {
    const i0 = Math.floor(inizioMs * SR / 1000);
    if (i0 >= campioni) return;
    somma(i0, (casuale() * 2 - 1) * 32767 * livello * forza * 1.8);
    if (i0 + 1 < campioni) somma(i0 + 1, (casuale() * 2 - 1) * 32767 * livello * forza);
    const frequenza = tra(minF, maxF, casuale);
    const durata = intero(4, 10, casuale);
    for (let i = 0; i < durata; i++) {
      const inviluppo = Math.exp(-i * 3.6 / durata);
      somma(i0 + i, Math.sin(2 * Math.PI * frequenza * i / SR) * 32767 * livello * forza * inviluppo * 1.2);
    }
  };
  unClic(0, 1);
  if (distanza) unClic(distanza, tra(0.55, 0.85, casuale));
  return aMulaw(pcm);
}

// Clic del mouse: un ticchettio asciutto e acuto; ogni tanto doppio clic.
export function creaClicMouse(opzioni = {}) {
  return sintetizzaClic({ minF: 2600, maxF: 3600, doppioProbabilita: 0.3, volume: 0.025, casuale: Math.random, ...opzioni });
}

// Clic di penna: più profondo e asciutto del mouse, sempre singolo.
export function creaClicPenna(opzioni = {}) {
  return sintetizzaClic({ minF: 900, maxF: 1400, volume: 0.025, casuale: Math.random, ...opzioni });
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
  // la miscela d'ufficio: per lo più tasti, poi carta, mouse e penna
  const genera = (livello) => {
    if (leggiTipo() !== 'ufficio') return creaToccoTastiera({ volume: livello, casuale });
    const r = casuale();
    if (r < 0.55) return creaToccoTastiera({ volume: livello, casuale });
    if (r < 0.75) return creaFruscioCarta({ volume: livello, casuale });
    if (r < 0.9) return creaClicMouse({ volume: livello, casuale });
    return creaClicPenna({ volume: livello, casuale });
  };
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
    if (leggiTipo() !== 'ufficio') return creaToccoTastiera({ volume: livello, casuale });
    const r = casuale();
    if (r < 0.55) return creaToccoTastiera({ volume: livello, casuale });
    if (r < 0.75) return creaFruscioCarta({ volume: livello, casuale });
    if (r < 0.9) return creaClicMouse({ volume: livello, casuale });
    return creaClicPenna({ volume: livello, casuale });
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
