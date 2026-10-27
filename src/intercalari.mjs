const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const leggiIntercalari = (valore) => String(valore || '').split(',').map((x) => x.trim()).filter(Boolean);

const INIZIO_COMUNE = /^(Un|Una|Il|Lo|La|I|Gli|Le|Mi|Ti|Si|Ci|Vi|Quale|Che|Come|Quando|Dove|Per|Se|Posso|Può|Puoi|Possiamo|Preferisce|Vuole|Deve|Siamo|Ho|Ha|Certo|Va|Perfetto|Bene)\b/;
const dopoVirgola = (testo) => INIZIO_COMUNE.test(testo) ? testo[0].toLocaleLowerCase('it') + testo.slice(1) : testo;

// Garantisce una cadenza umana anche se il modello ignora il prompt: uno entro la
// seconda risposta (così si percepisce anche nelle chiamate brevi), poi almeno due
// risposte senza intercalari. La scelta è a caso: usare sempre il primo della lista
// faceva riconoscere subito la formula ("Allora, ..." a ogni chiamata).
export function creaRegolatoreIntercalari(valore, casuale = Math.random) {
  const voci = leggiIntercalari(valore);
  let ultimoTurno = 0;
  let ultimaVoce = '';
  const pesca = () => {
    const possibili = voci.length > 1 ? voci.filter((x) => x !== ultimaVoce) : voci;
    const scelta = possibili[Math.min(possibili.length - 1, Math.floor(casuale() * possibili.length))] || voci[0];
    ultimaVoce = scelta;
    return scelta;
  };
  return (testo, turno) => {
    let out = String(testo || '').trim();
    if (!out || !voci.length) return out;
    const rx = (x) => new RegExp(`(^|[.!?]\\s+)${escapeRx(x)}(?:[,;:]|\\s)+`, 'i');
    const risata = /(^|[.!?]\s+)(?:eh eh|eheh|ah ah|ahah)(?:[,;:]|\s)+/i;
    const trovato = voci.find((x) => rx(x).test(out));
    const permesso = ultimoTurno === 0 || (ultimoTurno <= 3 ? turno >= 6 : turno - ultimoTurno >= 3);
    if (risata.test(out) && permesso) {
      ultimoTurno = turno;
      return out;
    }
    if (risata.test(out)) {
      out = out.replace(risata, '$1').replace(/\s{2,}/g, ' ').trim();
      out = out.replace(/(^|[.!?]\s+)([a-zà-ÿ])/gu, (_tutto, prima, lettera) => prima + lettera.toLocaleUpperCase('it'));
    }
    if (trovato && permesso) {
      ultimoTurno = turno;
      ultimaVoce = trovato;
      return out;
    }
    if (trovato) {
      out = out.replace(rx(trovato), '$1').replace(/\s{2,}/g, ' ').trim();
      out = out.replace(/(^|[.!?]\s+)([a-zà-ÿ])/gu, (_tutto, prima, lettera) => prima + lettera.toLocaleUpperCase('it'));
    }
    if (!ultimoTurno && turno >= 2 && out) {
      ultimoTurno = turno;
      const voce = pesca();
      const conMaiuscola = voce.charAt(0).toLocaleUpperCase('it') + voce.slice(1);
      return `${conMaiuscola}, ${dopoVirgola(out)}`;
    }
    return out;
  };
}

// Sceglie una variante evitando quella appena usata: la stessa frase identica a ogni
// telefonata è il modo più rapido per sembrare un centralino.
export function scegliVariante(varianti, ultima = null, casuale = Math.random) {
  const lista = (Array.isArray(varianti) ? varianti : [varianti]).filter((x) => x !== '' && x !== null && x !== undefined);
  if (!lista.length) return null;
  if (lista.length === 1) return lista[0];
  const possibili = lista.filter((x) => x !== ultima);
  return possibili[Math.min(possibili.length - 1, Math.floor(casuale() * possibili.length))];
}
