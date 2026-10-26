export const INTENTI_RICHIESTA = Object.freeze([
  'informazione',
  'preventivo_file',
  'assistenza_problema',
  'richiamata',
  'appuntamento',
  'altro',
]);

export const COMPORTAMENTI_RICHIESTA = Object.freeze([
  'rispondi',
  'raccogli_dati',
  'proponi_appuntamento',
  'offri_richiamata',
  'non_proporre',
]);

const INTENTI = new Set(INTENTI_RICHIESTA);
const COMPORTAMENTI = new Set(COMPORTAMENTI_RICHIESTA);
const CHIAVI_PERICOLOSE = new Set(['__proto__', 'prototype', 'constructor']);
const MASSIMO_REGOLE = 50;
const MASSIMO_INDICATORI = 50;
const MASSIMO_PROMPT_REGOLE = 12000;

function testoSemplice(valore, massimo) {
  if (typeof valore !== 'string') return '';
  return valore
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/<</g, '‹‹')
    .replace(/>>/g, '››')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, massimo)
    .trim();
}

function idSicuro(valore) {
  const id = testoSemplice(valore, 64).toLowerCase();
  if (CHIAVI_PERICOLOSE.has(id) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return '';
  return id;
}

function generaId(indice, usati) {
  const base = `regola-${indice + 1}`;
  let id = base;
  let suffisso = 2;
  while (usati.has(id)) id = `${base}-${suffisso++}`;
  return id;
}

function normalizzaPriorita(valore) {
  const numero = Number(valore);
  if (!Number.isFinite(numero)) return 0;
  return Math.max(0, Math.min(1000, Math.trunc(numero)));
}

function normalizzaIndicatori(valore) {
  if (!Array.isArray(valore)) return [];
  const visti = new Set();
  const risultato = [];
  for (const grezzo of valore) {
    const indicatore = testoSemplice(grezzo, 120);
    const chiave = indicatore.toLocaleLowerCase('it-IT');
    if (!indicatore || visti.has(chiave)) continue;
    visti.add(chiave);
    risultato.push(indicatore);
    if (risultato.length === MASSIMO_INDICATORI) break;
  }
  return risultato;
}

/**
 * Converte anche configurazioni mancanti o parziali nel formato corrente.
 * Costruisce ogni oggetto da zero: nessuna chiave ricevuta diventa una proprietà.
 */
export function normalizzaGestioneRichieste(valore) {
  const origine = valore && typeof valore === 'object' && !Array.isArray(valore) ? valore : {};
  const usati = new Set();
  const regole = [];
  const ricevute = Array.isArray(origine.regole) ? origine.regole.slice(0, MASSIMO_REGOLE) : [];

  for (let indice = 0; indice < ricevute.length; indice += 1) {
    const grezza = ricevute[indice] && typeof ricevute[indice] === 'object' && !Array.isArray(ricevute[indice])
      ? ricevute[indice]
      : {};
    let id = idSicuro(grezza.id);
    if (!id || usati.has(id)) id = generaId(indice, usati);
    usati.add(id);
    regole.push({
      id,
      nome: testoSemplice(grezza.nome, 80) || `Regola ${indice + 1}`,
      attiva: grezza.attiva !== false,
      indicatori: normalizzaIndicatori(grezza.indicatori),
      intento: INTENTI.has(grezza.intento) ? grezza.intento : 'altro',
      comportamento: COMPORTAMENTI.has(grezza.comportamento) ? grezza.comportamento : 'rispondi',
      obiettivo: testoSemplice(grezza.obiettivo, 2000),
      nonProporre: testoSemplice(grezza.nonProporre, 2000),
      priorita: normalizzaPriorita(grezza.priorita),
    });
  }

  return {
    automatica: origine.automatica !== false,
    azionePredefinita: COMPORTAMENTI.has(origine.azionePredefinita) ? origine.azionePredefinita : 'rispondi',
    regole,
  };
}

function minuscolo(valore) {
  return String(valore || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    .toLocaleLowerCase('it-IT')
    .replace(/\s+/g, ' ')
    .trim();
}

function alfanumerico(carattere) {
  return Boolean(carattere && /[\p{L}\p{N}]/u.test(carattere));
}

function contieneIndicatore(testo, indicatore) {
  let da = 0;
  while (da <= testo.length) {
    const posizione = testo.indexOf(indicatore, da);
    if (posizione < 0) return false;
    const prima = testo[posizione - 1];
    const dopo = testo[posizione + indicatore.length];
    const inizioValido = !alfanumerico(indicatore[0]) || !alfanumerico(prima);
    const fineValida = !alfanumerico(indicatore.at(-1)) || !alfanumerico(dopo);
    if (inizioValido && fineValida) return true;
    da = posizione + 1;
  }
  return false;
}

/** Restituisce guardrail compatibili col testo, senza eseguire alcuna azione. */
export function regoleCandidate(testo, gestione) {
  const configurazione = normalizzaGestioneRichieste(gestione);
  const frase = minuscolo(testo);
  if (!frase) return [];
  return configurazione.regole
    .map((regola, ordine) => ({ regola, ordine }))
    .filter(({ regola }) => regola.attiva && regola.indicatori.some((indicatore) => contieneIndicatore(frase, minuscolo(indicatore))))
    .sort((a, b) => b.regola.priorita - a.regola.priorita || a.ordine - b.ordine)
    .map(({ regola }) => regola);
}

function rigaRegola(regola) {
  const dettagli = [
    `intento=${regola.intento}`,
    `comportamento=${regola.comportamento}`,
    regola.obiettivo && `obiettivo=${regola.obiettivo}`,
    regola.nonProporre && `non proporre=${regola.nonProporre}`,
    regola.indicatori.length && `indicatori=${regola.indicatori.join(', ')}`,
  ].filter(Boolean).join('; ');
  return `- ${regola.nome}: ${dettagli}.`;
}

/** Testo pronto per il prompt: le regole orientano la decisione, non attivano funzioni. */
export function descriviGestioneRichieste(gestione) {
  const configurazione = normalizzaGestioneRichieste(gestione);
  const attive = configurazione.regole.filter((regola) => regola.attiva).sort((a, b) => b.priorita - a.priorita);
  const righe = [
    configurazione.automatica
      ? 'Decidi semanticamente l’intento reale della richiesta usando l’intera conversazione.'
      : 'Modalità manuale: assegna l’intento di una regola solo quando la frase del cliente contiene uno dei suoi indicatori; altrimenti usa altro.',
    'Non trasformare automaticamente ogni richiesta in un appuntamento: rispondi, raccogli dati, offri una richiamata o proponi un appuntamento soltanto quando è utile.',
    'Gli indicatori e le regole seguenti sono guardrail: non eseguono azioni da soli e non sostituiscono la comprensione del contesto.',
    `Se nessuna regola è pertinente, usa il comportamento predefinito: ${configurazione.azionePredefinita}.`,
    `Alla fine della risposta aggiungi esattamente un marcatore non parlato nel formato <<INTENTO|valore>>. Valori ammessi: ${INTENTI_RICHIESTA.join(', ')}.`,
  ];
  if (attive.length) {
    righe.push('Regole configurate:');
    let caratteri = righe.join('\n').length;
    for (const regola of attive) {
      const riga = rigaRegola(regola);
      if (caratteri + riga.length + 1 > MASSIMO_PROMPT_REGOLE) break;
      righe.push(riga);
      caratteri += riga.length + 1;
    }
  }
  return righe.join('\n');
}

/** Separa il marcatore tecnico dalla frase destinata alla voce. */
export function estraiIntento(testoCompleto, candidati = [], { automatica = true } = {}) {
  const intentiAI = [];
  const testo = String(testoCompleto || '').replace(/<<\s*INTENTO\s*\|\s*([^<>]*?)\s*>>/gi, (_marcatore, intento) => {
    const normalizzato = String(intento).trim().toLowerCase();
    if (INTENTI.has(normalizzato)) intentiAI.push(normalizzato);
    return ' ';
  }).replace(/\s+/g, ' ').trim();

  const regola = Array.isArray(candidati) ? candidati.find((candidata) => INTENTI.has(candidata?.intento)) : null;
  if (!automatica) {
    if (regola) return { testo, intento: regola.intento, fonte: 'regola' };
    return { testo, intento: 'altro', fonte: 'fallback' };
  }
  if (intentiAI.length) return { testo, intento: intentiAI.at(-1), fonte: 'ai' };
  if (regola) return { testo, intento: regola.intento, fonte: 'regola' };
  return { testo, intento: 'altro', fonte: 'fallback' };
}
