// La telefonata: ascolta il cliente (VAD a energia + faster-whisper), passa le frasi a
// Claude Code e legge la risposta con Qwen3-TTS, una frase alla volta mentre Claude scrive.
// Funziona uguale per Twilio e per la chiamata dal browser (stesso protocollo Media Streams).
import { CONFIG } from './config.mjs';
import { istruzioni, saluto } from './persona.mjs';
import { confermaAppuntamento } from './strumenti.mjs';
import { Cervello } from './cervello.mjs';
import { daMulaw, trascrivi, pronuncia, frasePronta } from './voce.mjs';

const FRAME_MS = 20;
const RIEMPITIVO = 'Mmh, allora...';

// Claude non ha strumenti veri: per le azioni scrive dei marcatori che il cliente non sente.
const AZIONI = `
# Azioni (importante)
Non hai strumenti da chiamare: quando le istruzioni dicono di chiamare uno strumento, scrivi invece un marcatore alla fine della risposta, dopo le parole da dire. Il marcatore non viene letto al cliente.
- Al posto di "conferma_appuntamento": <<CONFERMA|nome|ora|auto>> (es. <<CONFERMA|Marco Rossi|9:00|Alfa Romeo Giulia 2019>>), una volta sola.
- Al posto di "termina_chiamata": <<FINE>>, subito dopo il saluto finale.
Il passo 1 è già fatto: hai già risposto al telefono dicendo "${saluto()}" e il cliente l'ha sentito. Non ripetere mai il saluto, non ripresentarti e non dire di nuovo il nome dell'officina: rispondi direttamente alla sua prima frase (se chiede un appuntamento, passa subito al passo 2).
Ogni messaggio che ricevi è la trascrizione automatica di quello che ha detto il cliente: può contenere errori di ascolto, interpretala con buon senso.`;

// Claude scritto con i marcatori: quali azioni ci sono e cosa resta da dire.
function separa(testo) {
  const azioni = [...testo.matchAll(/<<\s*(CONFERMA|FINE)\s*(?:\|([^>]*))?>>/g)].map(([, tipo, a]) => ({ tipo, argomenti: (a || '').split('|').map((x) => x.trim()) }));
  const parlato = testo.replace(/<<[^>]*>>?/g, '').replace(/\[[^\]]*\]/g, '').replace(/[*_#`]/g, '');
  return { azioni, parlato };
}

// Dove si può tagliare la frase per mandarla alla voce: fine frase, oppure una virgola se è lunga.
// Pezzi troppo corti no: Qwen3-TTS sui frammenti di poche parole ogni tanto sbaglia.
// Il primo pezzo di una risposta può partire già a una virgola: si comincia a parlare prima.
function taglio(s, primo = false) {
  if (s.lastIndexOf('<<') > s.lastIndexOf('>>')) return -1; // marcatore a metà
  const m = [...s.matchAll(/[.!?…:;](?=\s)|\.\.\.(?=\s)/g)].pop();
  if (m && m.index >= 20) return m.index + m[0].length;
  if (s.length > (primo ? 40 : 90)) { const v = s.lastIndexOf(', '); if (v > 30) return v + 1; }
  return -1;
}

export function preparaCervello(chiamante) {
  return new Cervello(istruzioni({ perTts: true, chiamante, fine: 'termina_chiamata' }) + AZIONI);
}

const inAttesa = new Map(); // callSid → Cervello aperto mentre squilla
export function preriscalda(callSid, chiamante) {
  if (!callSid || inAttesa.has(callSid)) return;
  const c = preparaCervello(chiamante);
  inAttesa.set(callSid, c);
  setTimeout(() => { if (inAttesa.get(callSid) === c) { inAttesa.delete(callSid); c.chiudi(); } }, 60000).unref();
}

export function gestisciChiamata(chiamata) {
  const v = CONFIG.vad;
  let cervello = null;
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

  function leggi(frase) {
    const segnale = annulla.signal;
    coda = coda.then(async () => {
      if (segnale.aborted) return;
      try { await pronuncia(frase, (p) => { if (!segnale.aborted) inviaAudio(p); }, { segnale }); } catch (e) { if (!segnale.aborted) chiamata.log('errore voce', e.message); }
    });
  }

  async function allaFrase(pcm) {
    fineTurno = Date.now();
    let t;
    try { t = await trascrivi(pcm); } catch (e) { return chiamata.log('errore ascolto', e.message); }
    const detto = t.testo.trim();
    if (!detto || /^[\s.,!?…-]*$/.test(detto) || /sottotitoli|amara\.org|grazie per la visione/i.test(detto) || /^(yeah|yes|so|uh|um|oh|the|you|and|hmm)[.!?]?$/i.test(detto)) {
      fineTurno = 0; // rumore o "allucinazione" tipica di Whisper sul silenzio
      return;
    }
    chiamata.log(`👤 ${detto} (ascolto ${t.ms} ms${t.voce_occupata ? ", voce occupata" : ""})`);
    testo('cliente', detto);
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
          const [nome, ora, auto] = a.argomenti;
          await confermaAppuntamento({ nome, ora, auto }, chiamata);
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
    cervello = inAttesa.get(chiamata.callSid);
    if (cervello) inAttesa.delete(chiamata.callSid);
    else cervello = preparaCervello(chiamata.chiamante);
    collegaCervello();
    const s = saluto();
    testo('receptionist', s);
    chiamata.log(`🤖 ${s}`);
    const t = Date.now();
    const audio = await frasePronta(s);
    chiamata.log(`⏱ saluto pronto in ${Date.now() - t} ms`);
    inviaAudio(audio);
  };

  // Frase scritta (chat dal browser): come se l'avesse detta.
  chiamata.alTestoScritto = (t) => {
    if (!cervello || !t.trim()) return;
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
