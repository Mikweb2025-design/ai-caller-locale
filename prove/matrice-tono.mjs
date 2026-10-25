// Matrice del tono: telefonate in chat di 4-6 battute per vari tipi di cliente, in parallelo (max 3).
// Stampa ogni dialogo con i controlli automatici (cifre, simboli, intercalari vietati, frasi ripetute,
// cose inventate) e gli appuntamenti nuovi creati. Il giudizio sul tono resta a chi legge.
//   node prove/matrice-tono.mjs               tutti gli scenari
//   SOLO=fretta,ia node prove/matrice-tono.mjs  solo alcuni (nomi separati da virgola)
//   PORTA=5062 DATI_DIR=/percorso/dati ...    istanza di prova diversa da quella su 5050
// Gli appuntamenti creati dalla prova finiscono nell'agenda: toglili o usa DATI_DIR.
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORTA = process.env.PORTA || 5050;
const DATI = process.env.DATI_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'dati');
const CONCORRENZA = 3;

export const SCENARI = [
  { nome: 'fretta', cliente: 'ha fretta', frasi: ['Veloce, mi serve un appuntamento, ho due minuti.', 'Il primo che c\'è.', 'Rossi.', 'Sì, basta così.', 'No, grazie, ciao.'] },
  { nome: 'sgarbato', cliente: 'sgarbato / provocatore', frasi: ['Oh, finalmente qualcuno risponde. Siete sempre così lenti voi?', 'Sentite, devo far tagliare dei pezzi in plexiglass, voi lo sapete fare o no?', 'Va bene, fissatemi qualcosa domani.', 'Bianchi.', 'Sì, tutto qui. Ciao.'] },
  { nome: 'preoccupato', cliente: 'preoccupato dopo un incidente (niente battute)', frasi: ['Buongiorno, scusi, ieri nel mio laboratorio è partito un principio d\'incendio vicino alla macchina laser, mi hanno detto di farla controllare.', 'Ho paura che si sia rovinato qualcosa, è un impianto che uso tutti i giorni.', 'Mi può dare un appuntamento il prima possibile?', 'Mi chiamo Giovanni Ferri.', 'Sì, è tutto, grazie.', 'No, nient\'altro. Arrivederci.'] },
  { nome: 'arrabbiato', cliente: 'arrabbiato per un disservizio (richiamo da una persona)', frasi: ['Sono molto arrabbiato! La settimana scorsa ho portato dei pezzi e mi sono stati consegnati sbagliati e in ritardo, una vergogna!', 'Voglio un rimborso, subito, e voglio parlare con il responsabile.', 'Il mio nome è Carlo Mauri, e vi dico che è la seconda volta.'] },
  { nome: 'chiacchierone', cliente: 'chiacchierone che divaga', frasi: ['Buongiorno! Sa, mi ha dato il vostro numero mio cognato, che ha il capannone a Cesano, bravissima persona, fa il carpentiere da una vita, e io avrei bisogno di un lavoretto con il laser.', 'Eh, sapesse che caldo in questi giorni, mia moglie dice sempre che a ottobre non c\'è più la mezza stagione, comunque, dicevo, mi servirebbe un appuntamento.', 'Ah, il mio nome è Ettore Cattaneo, come il dottore, ma non siamo parenti, purtroppo!', 'Devo incidere dei nomi su venti targhette in ottone, per le cassette della posta del condominio.', 'Sì, è tutto, grazie mille, lei è proprio gentile.', 'No no, a posto così, buona giornata a lei e alla famiglia!'] },
  { nome: 'disordinato', cliente: 'disordinato (dice tutto in una frase)', frasi: ['Sono Luca Pozzi, vorrei venire giovedì mattina verso le dieci per far incidere venti portachiavi in legno con il logo della mia pizzeria, il file ce l\'ho già in vettoriale.', 'Sì, esatto, è tutto.', 'No, grazie, arrivederci.'] },
  { nome: 'incerto', cliente: 'incerto / anziano che esita', frasi: ['Pronto... buongiorno... ehm... non so bene... mio nipote mi ha detto di chiamare, dovrei far fare una cosa con il laser, ma non so se... non so come si fa.', 'Eh... è una targa per la tomba di mia moglie, in ottone credo... non so.', 'Sì... va bene, come dice lei.', 'Mi chiamo Aldo Brambilla.', 'Sì, va bene così, grazie.', 'No, grazie signorina... cioè signore. Arrivederci.'] },
  { nome: 'informale', cliente: 'informale, dà del tu', frasi: ['Ciao! Senti, mi serve una mano: devo far tagliare dei pannelli di compensato per un progetto, mi dai un appuntamento?', 'Domani mattina va benissimo, quando vuoi tu.', 'Sono Franz Colombo, ma chiamami Franz.', 'Ok perfetto, è tutto, sei un grande!', 'Niente altro, grazie mille, ciao ciao!'] },
  { nome: 'prezzo', cliente: 'chiede prezzo / tempi / garanzie (non deve inventare)', frasi: ['Buongiorno, quanto costa incidere cento penne in alluminio?', 'E in quanto tempo me le fate? Mi servono per fine mese. Garantite il risultato?', 'Ma almeno un prezzo indicativo, a pezzo?', 'Va bene, allora me lo dice qualcuno di persona. Grazie, arrivederci.'] },
  { nome: 'fuoritema', cliente: 'fuori tema / venditore', frasi: ['Buongiorno, sono Marco di Energia Facile, volevo proporvi un\'offerta sulla luce e sul gas per la vostra azienda, ha due minuti?', 'Ma guardi che risparmiate il trenta per cento, mi passa il titolare?', 'Va bene, allora mi dica almeno che tempo fa da voi, ah ah.'] },
  { nome: 'ia', cliente: 'chiede se è un\'intelligenza artificiale', frasi: ['Buongiorno. Scusi la domanda, ma lei è un\'intelligenza artificiale?', 'Preferisco parlare con una persona, mi fate richiamare?', 'Mi chiamo Sara Villa.'] },
];

function chiama(frasi) {
  return new Promise((risolvi) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORTA}/media/web/locale`);
    const sid = 'MZmatrice' + Math.random().toString(36).slice(2, 7);
    const dialogo = []; let marche = []; let ultimoAudio = 0; let attesa = false; let turno = 0; let tTesto = 0;
    const invia = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    const timer = [];
    ws.on('open', () => {
      invia({ event: 'start', streamSid: sid, start: { streamSid: sid, callSid: 'CAmatrice' + Date.now() + sid, customParameters: { from: 'browser' } } });
      timer.push(setInterval(() => invia({ event: 'media', streamSid: sid, media: { payload: Buffer.alloc(160, 0xff).toString('base64') } }), 20));
      timer.push(setInterval(() => {
        for (const m of marche) invia({ event: 'mark', streamSid: sid, mark: { name: m } });
        marche = [];
        if (attesa && ultimoAudio > tTesto - 8000 && Date.now() - ultimoAudio > 2500 && Date.now() - tTesto > 3000 && turno < frasi.length) { attesa = false; invia({ event: 'testo', testo: frasi[turno++] }); }
        // finite le battute e dato il tempo all'ultima risposta: si chiude
        if (attesa && turno >= frasi.length && Date.now() - ultimoAudio > 4000 && Date.now() - tTesto > 5000) ws.close();
      }, 200));
    });
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.event === 'media') ultimoAudio = Date.now();
      if (m.event === 'mark') marche.push(m.mark.name);
      if (m.event === 'testo') { dialogo.push({ chi: m.chi === 'cliente' ? 'C' : 'R', testo: m.testo }); if (m.chi === 'receptionist') { attesa = true; tTesto = Date.now(); } }
    });
    const fine = () => { timer.forEach(clearInterval); risolvi(dialogo); };
    ws.on('close', fine); ws.on('error', fine);
    setTimeout(() => ws.close(), 150000);
  });
}

const VIETATI = /^\s*(allora|dunque|ecco|guardi|beh|mmh|ehm)\b/i;
const FRASI_DA_CALL_CENTER = /comprendo|le confermo che|come da lei indicato|mi scuso per il disagio|la prego di fornirmi|in cosa posso esserle utile/i;
export function controlli(nome, dialogo) {
  const r = dialogo.filter((x) => x.chi === 'R').slice(1); // senza il saluto
  const problemi = [];
  for (const x of r) {
    const t = x.testo;
    if (/\d/.test(t)) problemi.push(`cifre: "${t.match(/\S*\d\S*/)[0]}"`);
    if (/[€%@*#_\/]|\.\.\.|…/.test(t)) problemi.push(`simbolo: "${t.match(/[€%@*#_\/]|\.\.\.|…/)[0]}"`);
    for (const f of t.split(/(?<=[.!?:;])\s+/)) if (VIETATI.test(f)) problemi.push(`intercalare: "${f.slice(0, 30)}"`);
    if (FRASI_DA_CALL_CENTER.test(t)) problemi.push(`frase da call center: "${t.match(FRASI_DA_CALL_CENTER)[0]}"`);
    if (/controll(o|iamo)|guardo|verifico|sul (computer|gestionale|sistema)|nell'agenda/i.test(t)) problemi.push('dice di controllare');
    if (/\b(euro|costa|costano|garanti|giorni|settimane)\b/i.test(t) && nome === 'prezzo') problemi.push(`da verificare a mano (prezzi/tempi): "${(t.match(/\b(euro|costa|costano|garanti\w*|giorni|settimane)\b/i) || [''])[0]}"`);
    if (/<<|>>/.test(t)) problemi.push('marcatore nel testo parlato');
  }
  const viste = new Map();
  for (const x of r) for (const f of x.testo.split(/(?<=[.!?])\s+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 12)) { if (viste.has(f)) problemi.push(`frase ripetuta: "${f.slice(0, 40)}"`); viste.set(f, 1); }
  return [...new Set(problemi)];
}

const leggiAgenda = () => { try { return JSON.parse(readFileSync(join(DATI, 'appuntamenti.json'), 'utf8')); } catch { return []; } };

const scelti = process.env.SOLO ? process.env.SOLO.split(',').map((s) => s.trim()) : null;
const daFare = SCENARI.filter((s) => !scelti || scelti.includes(s.nome));
const prima = new Set(leggiAgenda().map((a) => a.id));
const risultati = new Array(daFare.length);
let prossimo = 0;
async function operaio() {
  while (prossimo < daFare.length) {
    const i = prossimo++;
    const s = daFare[i];
    const t0 = Date.now();
    const dialogo = await chiama(s.frasi);
    risultati[i] = { s, dialogo, secondi: Math.round((Date.now() - t0) / 1000) };
  }
}
await Promise.all(Array.from({ length: CONCORRENZA }, operaio));

for (const { s, dialogo, secondi } of risultati) {
  console.log(`\n===== ${s.nome.toUpperCase()}: ${s.cliente} (${secondi}s) =====`);
  for (const x of dialogo) console.log(`${x.chi === 'C' ? '👤' : '🤖'} ${x.testo}`);
  const p = controlli(s.nome, dialogo);
  console.log(p.length ? `⚠ controlli automatici: ${p.join(' | ')}` : '✓ controlli automatici: nessun problema (cifre, simboli, intercalari, ripetizioni)');
}
const nuovi = leggiAgenda().filter((a) => !prima.has(a.id));
console.log(`\n===== APPUNTAMENTI CREATI DALLA PROVA (${nuovi.length}) =====`);
for (const a of nuovi) console.log(`${a.id} | ${a.nome} | ${a.giorno} ${a.ora} | ${a.dettagli}${a.email ? ' | ' + a.email : ''}`);
process.exit(0);
