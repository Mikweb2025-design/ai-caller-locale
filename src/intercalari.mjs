const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const leggiIntercalari = (valore) => String(valore || '').split(',').map((x) => x.trim()).filter(Boolean);

const INIZIO_COMUNE = /^(Un|Una|Il|Lo|La|I|Gli|Le|Mi|Ti|Si|Ci|Vi|Quale|Che|Come|Quando|Dove|Per|Se|Posso|Può|Puoi|Possiamo|Preferisce|Vuole|Deve|Siamo|Ho|Ha|Certo|Va|Perfetto|Bene)\b/;
const dopoVirgola = (testo) => INIZIO_COMUNE.test(testo) ? testo[0].toLocaleLowerCase('it') + testo.slice(1) : testo;

// Garantisce una cadenza umana anche se il modello ignora il prompt: uno entro la
// seconda risposta (così si percepisce anche nelle chiamate brevi), poi almeno due
// risposte senza intercalari.
export function creaRegolatoreIntercalari(valore) {
  const voci = leggiIntercalari(valore);
  let ultimoTurno = 0;
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
      return out;
    }
    if (trovato) {
      out = out.replace(rx(trovato), '$1').replace(/\s{2,}/g, ' ').trim();
      out = out.replace(/(^|[.!?]\s+)([a-zà-ÿ])/gu, (_tutto, prima, lettera) => prima + lettera.toLocaleUpperCase('it'));
    }
    if (!ultimoTurno && turno >= 2 && out) {
      ultimoTurno = turno;
      return `${voci[0]}, ${dopoVirgola(out)}`;
    }
    return out;
  };
}
