// La telefonata: ascolta il cliente (VAD a energia + faster-whisper), passa le frasi a
// Claude Code e legge la risposta con Qwen3-TTS, una frase alla volta mentre Claude scrive.
// Funziona uguale per Twilio e per la chiamata dal browser (stesso protocollo Media Streams).
import { CONFIG } from './config.mjs';
import { istruzioni, salutoSegmenti, salutoCompleto } from './persona.mjs';
import { postiPerIstruzioni } from './agenda.mjs';
import { confermaAppuntamento } from './strumenti.mjs';
import { Cervello } from './cervello.mjs';
import { daMulaw, trascrivi, pronuncia, frasePronta } from './voce.mjs';

const FRAME_MS = 20;
export const RIEMPITIVO = 'Sì, un attimo.';

// Claude scritto con i marcatori: quali azioni ci sono e cosa resta da dire.
function separa(testo) {
  const azioni = [...testo.matchAll(/<<\s*(CONFERMA|FINE)\s*(?:\|([^>]*))?>>/g)].map(([, tipo, a]) => ({ tipo, argomenti: (a || '').split('|').map((x) => x.trim()) }));
  const parlato = testo.replace(/<<[^>]*(?:>>|$)/g, '').replace(/\[[^\]]*\]/g, '').replace(/[*_#`]/g, '');
  return { azioni, parlato };
}

// Dove si può tagliare la frase per mandarla alla voce: fine frase, oppure una virgola se è lunga.
// Pezzi troppo corti no: Qwen3-TTS sui frammenti di poche parole ogni tanto sbaglia.
// Il primo pezzo di una risposta può partire già a una virgola: si comincia a parlare prima.
function taglio(s, primo = false) {
  // I marcatori stanno in fondo alla risposta: da "<<" in poi non si legge niente, si aspetta la fine.
  const marcatore = s.search(/<<|<$/);
  if (marcatore >= 0) return s.slice(0, marcatore).trim() ? marcatore : -1;
  const m = [...s.matchAll(/[.!?…:;](?=\s)|\.\.\.(?=\s)/g)].pop();
  if (m && m.index >= 20) return m.index + m[0].length;
  if (s.length > (primo ? 40 : 90)) { const v = s.lastIndexOf(', '); if (v > 30) return v + 1; }
  return -1;
}

// Parakeet sceglie la lingua da solo: eco dell'altoparlante e rumori diventano spesso frasette
// in inglese ("Yeah, we're here"). Se la frase è fatta soprattutto di parole inglesi, non è il cliente.
const INGLESE = new Set("yeah yes yep so uh um oh the a an you and hmm we we're here there that that's it it's is are was just why because with what i i'm my me your this of to in on for be have do not but all can will like know right well hi hello bye thank thanks".split(' '));
const ITALIANO = /[àèéìòù]|\b(che|non|per|sono|il|la|lo|gli|le|un|una|di|da|con|mi|ti|si|ci|ok|okay|no|ciao|grazie|buongiorno|pronto|vorrei|appuntamento|va|bene)\b/i;
// Parole che distinguono il tedesco dall'italiano (non quelle uguali nelle due lingue).
const TEDESCO = /[äöüß]|\b(ich|sie|wir|ihr|ihre|ihnen|nicht|und|der|die|das|ein|eine|ist|sind|haben|habe|bitte|danke|guten|tag|termin|gerne|ja|nein|wann|möchte|moechte|können|koennen|kann|uhr|montag|dienstag|mittwoch|donnerstag|freitag|auch|dann|wie|für|mit|noch|hier|zu|von|bei|dem|den|auf|aber|oder|gut|schön|hallo|wieder|sehen|ihnen|mir|mich|dich|machen|brauche|brauchen|wollen|will)\b/gi;
const SOLO_ITALIANO = /[àèéìòù]|\b(che|non|per|sono|il|la|lo|gli|le|un|una|di|con|mi|ti|si|ci|ho|alle|ma|come|quale|va|bene|grazie|buongiorno|perfetto|certo|vorrei|appuntamento|mattina|pomeriggio)\b/gi;
export function rilevaLingua(testo, precedente = 'it') {
  const de = (testo.match(TEDESCO) || []).length, it = (testo.match(SOLO_ITALIANO) || []).length;
  if (de === 0 && it === 0) return precedente; // frase cortissima: resta nella lingua di prima
  return de > it ? 'de' : 'it';
}
export function nonItaliano(frase) {
  if (ITALIANO.test(frase) || /[äöüß]|\b(ich|wir|sie|nicht|und|bitte|danke|guten|termin|gerne|ja|nein|haben)\b/i.test(frase)) return false;
  const parole = frase.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
  return parole.length > 0 && parole.filter((p) => INGLESE.has(p)).length / parole.length >= 0.5;
}

// Le istruzioni si rifanno a ogni chiamata: impostazioni e posti liberi sono sempre quelli di adesso.
export async function preparaCervello(chiamante) {
  let posti = '';
  try { posti = await postiPerIstruzioni(); } catch (e) { console.error('posti liberi non calcolati:', e.message); }
  return new Cervello(istruzioni({ chiamante, posti }));
}

const inAttesa = new Map(); // callSid → Cervello aperto mentre squilla
export function preriscalda(callSid, chiamante) {
  if (!callSid || inAttesa.has(callSid)) return;
  const c = preparaCervello(chiamante);
  inAttesa.set(callSid, c);
  setTimeout(() => { if (inAttesa.get(callSid) === c) { inAttesa.delete(callSid); c.then((x) => x.chiudi()); } }, 60000).unref();
}

export function gestisciChiamata(chiamata) {
  const v = CONFIG.vad;
  let cervello = null;
  let cervelloPronto = null; // Claude si avvia mentre parte il saluto
  let parlando = false; // il cliente sta parlando
  let voce = 0, muto = 0; // frame consecutivi sopra/sotto soglia
  let preRoll = [];
  let frase = [];
  let turno = 0; // turno di risposta che vogliamo sentire
  let bufferTesto = '';
  let giaDetto = false; // il primo pezzo della risposta è già partito
  let coda = Promise.resolve(); // frasi da leggere, in ordine
  let annulla = new AbortController();
  let fineTurno = 0; // quando il cliente ha smesso di parlare
  let primoAudio = true;
  let riempitivo = null;
  let chiudere = false;
  const ritardi = [];

  const testo = (chi, t) => chiamata.testo?.(chi, t);

  function interrompi(motivo) {
    annulla.abort();
    annulla = new AbortController();
    coda = Promise.resolve();
    bufferTesto = '';
    giaDetto = false;
    clearTimeout(riempitivo);
    if (chiamata.sta_parlando) { chiamata.svuota(); chiamata.log(`✂ ${motivo}`); }
  }

  function inviaAudio(mulaw) {
    if (primoAudio && fineTurno) {
      const ms = Date.now() - fineTurno;
      ritardi.push(ms);
      chiamata.log(`⏱ primo audio ${ms} ms dopo la fine della frase`);
      fineTurno = 0;
    }
    primoAudio = false;
    clearTimeout(riempitivo);
    chiamata.inviaAudio(mulaw.toString('base64'));
    chiamata.marca();
  }

  let linguaVoce = 'it';
  function leggi(frase) {
    const segnale = annulla.signal;
    linguaVoce = rilevaLingua(frase, linguaVoce);
    const lingua = linguaVoce;
    coda = coda.then(async () => {
      if (segnale.aborted) return;
      try { await pronuncia(frase, (p) => { if (!segnale.aborted) inviaAudio(p); }, { segnale, lingua }); } catch (e) { if (!segnale.aborted) chiamata.log('errore voce', e.message); }
    });
  }

  async function allaFrase(pcm) {
    fineTurno = Date.now();
    let t;
    try { t = await trascrivi(pcm); } catch (e) { return chiamata.log('errore ascolto', e.message); }
    const detto = t.testo.trim();
    if (!detto || /^[\s.,!?…-]*$/.test(detto) || /sottotitoli|amara\.org|grazie per la visione/i.test(detto) || nonItaliano(detto)) {
      fineTurno = 0; // rumore o "allucinazione" tipica di Whisper sul silenzio
      return;
    }
    chiamata.log(`👤 ${detto} (ascolto ${t.ms} ms${t.voce_occupata ? ", voce occupata" : ""})`);
    testo('cliente', detto);
    await cervelloPronto;
    nuovoTurno(detto);
  }

  function nuovoTurno(detto) {
    interrompi('nuova frase del cliente');
    primoAudio = true;
    if (!fineTurno) fineTurno = Date.now();
    turno = cervello.ascolta(detto);
    if (CONFIG.riempitivoSecondi >= 0) {
      riempitivo = setTimeout(async () => {
        const audio = await frasePronta(RIEMPITIVO).catch(() => null);
        if (audio && primoAudio) { chiamata.log('🫧 riempitivo'); inviaAudio(audio); primoAudio = true; }
      }, CONFIG.riempitivoSecondi * 1000);
    }
  }

  function collegaCervello() {
    cervello.alTesto = (pezzo, n) => {
      if (n !== turno) return; // risposta a una frase ormai superata
      if (!bufferTesto && !giaDetto && fineTurno) chiamata.log(`🧠 primo testo di Claude dopo ${Date.now() - fineTurno} ms`);
      bufferTesto += pezzo;
      let i;
      while ((i = taglio(bufferTesto, !giaDetto)) > 0) {
        giaDetto = true;
        const { parlato } = separa(bufferTesto.slice(0, i));
        bufferTesto = bufferTesto.slice(i).trimStart();
        if (parlato.trim()) leggi(parlato.trim());
      }
    };
    cervello.allaFine = async (completo, n) => {
      if (n !== turno) return;
      const { parlato } = separa(bufferTesto);
      bufferTesto = '';
      if (parlato.trim()) leggi(parlato.trim());
      const { azioni, parlato: tutto } = separa(completo);
      chiamata.log(`🤖 ${tutto.trim()}`);
      testo('receptionist', tutto.trim());
      for (const a of azioni) {
        chiamata.log(`🔧 ${a.tipo}`, a.argomenti);
        if (a.tipo === 'CONFERMA') {
          const [nome, giorno, ora, dettagli, email] = a.argomenti;
          await confermaAppuntamento({ nome, giorno, ora, dettagli, email }, chiamata);
        }
        if (a.tipo === 'FINE' && !chiudere) {
          chiudere = true;
          await coda;
          await chiamata.finitoDiParlare();
          await new Promise((r) => setTimeout(r, 600));
          chiamata.riaggancia();
        }
      }
    };
  }

  chiamata.alPartire = async () => {
    const pronto = inAttesa.get(chiamata.callSid) || preparaCervello(chiamata.chiamante);
    inAttesa.delete(chiamata.callSid);
    cervelloPronto = pronto;
    // il saluto parte subito, Claude intanto si avvia
    const s = salutoCompleto();
    testo('receptionist', s);
    chiamata.log(`🤖 ${s}`);
    const t = Date.now();
    const audio = Buffer.concat(await Promise.all(salutoSegmenti().map((x) => frasePronta(x.testo, x.lingua))));
    chiamata.log(`⏱ saluto pronto in ${Date.now() - t} ms`);
    inviaAudio(audio);
    cervello = await pronto;
    collegaCervello();
    if (chiamata.chiusa) cervello.chiudi();
  };

  // Frase scritta (chat dal browser): come se l'avesse detta.
  chiamata.alTestoScritto = async (t) => {
    if (!cervelloPronto || !t.trim()) return;
    await cervelloPronto;
    chiamata.log(`⌨️ ${t}`);
    testo('cliente', t.trim());
    fineTurno = Date.now();
    nuovoTurno(t.trim());
  };

  chiamata.alAudio = (payload) => {
    const pcm = daMulaw(Buffer.from(payload, 'base64'));
    let somma = 0;
    for (let i = 0; i < pcm.length; i += 2) { const s = pcm.readInt16LE(i); somma += s * s; }
    const rms = Math.sqrt(somma / (pcm.length / 2));
    // Mentre il receptionist parla serve una voce più forte e più lunga per interromperlo:
    // l'eco dell'altoparlante (browser senza cuffie) o un colpo di tosse non devono zittirlo.
    const sopra = chiamata.sta_parlando;
    const forte = rms > v.soglia * (sopra ? 1.6 : 1);
    if (!parlando) {
      preRoll.push(pcm);
      if (preRoll.length > 15) preRoll.shift();
      voce = forte ? voce + 1 : 0;
      if (voce * FRAME_MS >= (sopra ? v.interruzioneMs : v.inizioMs)) {
        parlando = true;
        muto = 0;
        frase = [...preRoll];
        preRoll = [];
        // il cliente parla sopra al receptionist: si zittisce subito
        if (chiamata.sta_parlando) interrompi('il cliente parla sopra');
      }
      return;
    }
    frase.push(pcm);
    muto = forte ? 0 : muto + 1;
    if (muto * FRAME_MS >= v.silenzioMs || frase.length * FRAME_MS > 30000) {
      parlando = false;
      voce = 0;
      const audio = Buffer.concat(frase);
      frase = [];
      if (audio.length / 16 >= v.minimoMs + v.silenzioMs) allaFrase(audio);
    }
  };

  chiamata.allaFine = () => {
    interrompi('fine chiamata');
    cervello?.chiudi();
    if (ritardi.length) chiamata.log('⏱ ritardi (fine frase → primo audio):', ritardi.join(', '), 'ms');
  };
}
