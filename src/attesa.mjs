// Piccoli tocchi di tastiera durante l'attesa del cervello. L'audio e gia nel formato
// telefonico μ-law 8 kHz e viene inviato senza mark: non conta come voce del receptionist.
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

// Sedia che scricchiola: legno che flette, attrito grave e irregolare.
export function creaSedia({ volume = 0.02, casuale = Math.random } = {}) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  if (livello === 0) return Buffer.alloc(0);
  const campioni = Math.floor(intero(220, 430, casuale) * SR / 1000);
  const pcm = Buffer.alloc(campioni * 2);
  const frequenza = tra(65, 125, casuale);
  let grave = 0;
  let prima = 0;
  for (let i = 0; i < campioni; i++) {
    const inviluppo = Math.sin(Math.PI * i / campioni) ** 1.4;
    const rumore = casuale() * 2 - 1;
    const crepitio = rumore - prima; // solo la parte acuta: il cigolio del legno
    prima = rumore;
    grave += (rumore - grave) * 0.03; // e la parte molto grave: la struttura che flette
    const valore = grave * 2.6 + crepitio * 0.22 + Math.sin(2 * Math.PI * frequenza * i / SR) * 0.16;
    pcm.writeInt16LE(limita(Math.round(32767 * livello * inviluppo * valore), -32768, 32767), i * 2);
  }
  return aMulaw(pcm);
}

// Tazzina appoggiata sulla scrivania: ceramica, due o tre parziali che muoiono subito.
export function creaTazzina({ volume = 0.02, casuale = Math.random } = {}) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  if (livello === 0) return Buffer.alloc(0);
  const campioni = Math.floor(intero(110, 180, casuale) * SR / 1000);
  const pcm = Buffer.alloc(campioni * 2);
  const somma = (n, valore) => {
    if (n < 0 || n >= campioni) return;
    pcm.writeInt16LE(limita(pcm.readInt16LE(n * 2) + Math.round(valore), -32768, 32767), n * 2);
  };
  const colpo = (inizioMs, forza) => {
    const i0 = Math.floor(inizioMs * SR / 1000);
    const parziali = [tra(2100, 2600, casuale), tra(3300, 3900, casuale), tra(4700, 5400, casuale)];
    const durata = intero(16, 26, casuale);
    for (let i = 0; i < durata; i++) {
      const inviluppo = Math.exp(-i * 4 / durata);
      let valore = 0;
      for (let p = 0; p < parziali.length; p++) valore += Math.sin(2 * Math.PI * parziali[p] * i / SR) / (p + 1.1);
      somma(i0 + i, 32767 * livello * forza * inviluppo * valore * 1.8);
    }
  };
  colpo(0, 1);
  if (casuale() < 0.45) colpo(intero(35, 70, casuale), 0.5); // il piattino che si riassesta
  return aMulaw(pcm);
}

// Mazzo di chiavi: più tintinnii metallici vicini, come quando si cercano in tasca.
export function creaChiavi({ volume = 0.018, casuale = Math.random } = {}) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  if (livello === 0) return Buffer.alloc(0);
  const quanti = intero(4, 7, casuale);
  const campioni = Math.floor(intero(240, 380, casuale) * SR / 1000);
  const pcm = Buffer.alloc(campioni * 2);
  const somma = (n, valore) => {
    if (n < 0 || n >= campioni) return;
    pcm.writeInt16LE(limita(pcm.readInt16LE(n * 2) + Math.round(valore), -32768, 32767), n * 2);
  };
  for (let k = 0; k < quanti; k++) {
    const i0 = Math.floor(tra(0, campioni * 0.75, casuale));
    const frequenza = tra(2400, 5200, casuale);
    const durata = intero(8, 16, casuale);
    const forza = tra(0.35, 0.9, casuale);
    for (let i = 0; i < durata && i0 + i < campioni; i++) {
      somma(i0 + i, Math.sin(2 * Math.PI * frequenza * i / SR) * 32767 * livello * forza * Math.exp(-i * 4 / durata) * 2.4);
    }
  }
  return aMulaw(pcm);
}

// Notifica del computer: due bip bassi, quasi coperti dall'ambiente.
export function creaNotifica({ volume = 0.014, casuale = Math.random } = {}) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  if (livello === 0) return Buffer.alloc(0);
  const campioni = Math.floor(intero(150, 210, casuale) * SR / 1000);
  const pcm = Buffer.alloc(campioni * 2);
  const bip = (inizioMs, frequenza, durataMs) => {
    const i0 = Math.floor(inizioMs * SR / 1000);
    const durata = Math.floor(durataMs * SR / 1000);
    for (let i = 0; i < durata && i0 + i < campioni; i++) {
      const inviluppo = Math.sin(Math.PI * i / durata) ** 2;
      pcm.writeInt16LE(limita(Math.round(Math.sin(2 * Math.PI * frequenza * i / SR) * 32767 * livello * 0.55 * inviluppo), -32768, 32767), (i0 + i) * 2);
    }
  };
  bip(0, tra(620, 720, casuale), 55);
  bip(90, tra(880, 980, casuale), 55);
  return aMulaw(pcm);
}

// Porta lontana: un tonfo sordo con la coda della stanza.
export function creaPorta({ volume = 0.018, casuale = Math.random } = {}) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  if (livello === 0) return Buffer.alloc(0);
  const campioni = Math.floor(intero(180, 300, casuale) * SR / 1000);
  const pcm = Buffer.alloc(campioni * 2);
  const frequenza = tra(55, 85, casuale);
  let filtro = 0;
  for (let i = 0; i < campioni; i++) {
    const t = i / SR;
    const tonfo = Math.sin(2 * Math.PI * frequenza * t) * Math.exp(-t * 22);
    const rumore = casuale() * 2 - 1;
    filtro += (rumore - filtro) * 0.08;
    const coda = filtro * 1.4 * Math.exp(-t * 9);
    pcm.writeInt16LE(limita(Math.round(32767 * livello * 0.7 * (tonfo * 1.1 + coda)), -32768, 32767), i * 2);
  }
  return aMulaw(pcm);
}

// La miscela d'ufficio: tasti, carta, mouse, penna, e ogni tanto qualcosa intorno.
function suonoUfficio(livello, casuale) {
  const r = casuale();
  if (r < 0.42) return creaToccoTastiera({ volume: livello, casuale });
  if (r < 0.62) return creaFruscioCarta({ volume: livello, casuale });
  if (r < 0.71) return creaClicMouse({ volume: livello, casuale });
  if (r < 0.78) return creaClicPenna({ volume: livello, casuale });
  if (r < 0.86) return creaSedia({ volume: livello, casuale });
  if (r < 0.92) return creaTazzina({ volume: livello, casuale });
  if (r < 0.96) return creaChiavi({ volume: livello, casuale });
  if (r < 0.985) return creaNotifica({ volume: livello, casuale });
  return creaPorta({ volume: livello, casuale });
}

// Un ritaglio di ufficio da mandare dopo la voce: il segno che la stanza c'è anche quando
// il receptionist tace (un foglio spostato, la sedia, la tazzina).
export function creaCodaUfficio({ volume = 0.02, tipo = 'ufficio', casuale = Math.random } = {}) {
  const livello = limita(volume, 0, VOLUME_MASSIMO);
  if (livello === 0) return Buffer.alloc(0);
  if (tipo === 'tastiera') return creaToccoTastiera({ volume: livello * 0.8, casuale });
  const r = casuale();
  if (r < 0.34) return creaFruscioCarta({ volume: livello, casuale });
  if (r < 0.55) return creaSedia({ volume: livello * 0.9, casuale });
  if (r < 0.74) return creaTazzina({ volume: livello * 0.85, casuale });
  if (r < 0.88) return creaChiavi({ volume: livello * 0.8, casuale });
  if (r < 0.96) return creaNotifica({ volume: livello * 0.7, casuale });
  return creaPorta({ volume: livello * 0.8, casuale });
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
  // la miscela d'ufficio: per lo più tasti, poi carta, mouse, penna e i rumori della stanza
  const genera = (livello) => {
    if (leggiTipo() !== 'ufficio' && leggiTipo() !== 'ambiente') return creaToccoTastiera({ volume: livello, casuale });
    return suonoUfficio(livello, casuale);
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

// Sorgente continua di suoni d'ufficio da mescolare sotto la voce del receptionist: a ogni pezzo di
// voce si chiede lo stesso numero di byte di sottofondo, dentro ci sono i tocchi nel loro ritmo.
export function creaSuonoContinuo({
  attivo = () => true,
  volume = () => 0.025,
  tipo = () => 'tastiera',
  casuale = Math.random,
  clima = true,
} = {}) {
  const leggiAttivo = typeof attivo === 'function' ? attivo : () => Boolean(attivo);
  const leggiVolume = typeof volume === 'function' ? volume : () => volume;
  const leggiTipo = typeof tipo === 'function' ? tipo : () => tipo;
  const pause = (modo) => {
    if (modo === 'ambiente') return intero(1500, 3000, casuale);
    if (modo === 'ufficio') return intero(900, 1900, casuale);
    return intero(700, 1400, casuale);
  };
  let resto = Buffer.alloc(0); // il suono in corso, in PCM: avanza di pezzo in pezzo
  let pausa = Math.round(pause('tastiera') * SR / 1000); // silenzio prima del prossimo suono
  let filtroClima = 0; // stato del soffio d'ambiente: continua da un pezzo all'altro
  let faseClima = 0;

  const genera = (livello) => {
    const modo = leggiTipo();
    pausa = Math.round(pause(modo) * SR / 1000);
    if (modo === 'tastiera') return creaToccoTastiera({ volume: livello, casuale });
    return suonoUfficio(livello, casuale);
  };

  return {
    // n byte di μ-law di sottofondo (silenzio 0xff compreso), oppure null se spento dal pannello
    strappa(n) {
      if (!leggiAttivo() || !(n > 0)) return null;
      const livello = limita(leggiVolume(), 0, VOLUME_MASSIMO);
      if (livello <= 0) return Buffer.alloc(n, 0xff);
      const modo = leggiTipo();
      // tutto si somma in PCM e si converte una volta sola: clima, suoni e silenzio
      const pcm = Buffer.alloc(n * 2);
      const somma = (i, valore) => {
        if (i < 0 || i >= n) return;
        pcm.writeInt16LE(limita(pcm.readInt16LE(i * 2) + Math.round(valore), -32768, 32767), i * 2);
      };
      // il soffio della stanza (ventilazione, computer accesi): basso e continuo, non un fruscio
      if (clima && modo !== 'tastiera') {
        const ampiezza = 32767 * livello * (modo === 'ambiente' ? 1.5 : 1.1);
        for (let i = 0; i < n; i++) {
          filtroClima += ((casuale() * 2 - 1) - filtroClima) * 0.05;
          faseClima += 2 * Math.PI * 90 / SR;
          if (faseClima > 2 * Math.PI) faseClima -= 2 * Math.PI;
          somma(i, (filtroClima * 1.4 + Math.sin(faseClima) * 0.05) * ampiezza);
        }
      }
      let scritti = 0;
      while (scritti < n) {
        if (resto.length) {
          const quanti = Math.min(Math.floor(resto.length / 2), n - scritti);
          for (let i = 0; i < quanti; i++) somma(scritti + i, resto.readInt16LE(i * 2));
          resto = resto.slice(quanti * 2);
          scritti += quanti;
        } else if (pausa > 0) {
          const quanti = Math.min(pausa, n - scritti);
          pausa -= quanti;
          scritti += quanti;
        } else {
          resto = daMulaw(genera(livello));
        }
      }
      return aMulaw(pcm);
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
