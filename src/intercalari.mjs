const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const leggiIntercalari = (valore) => String(valore || '').split(',').map((x) => x.trim()).filter(Boolean);

// Garantisce una cadenza umana anche se il modello ignora il prompt: uno nei primi tre
// turni, poi almeno due risposte senza intercalari.
export function creaRegolatoreIntercalari(valore) {
  const voci = leggiIntercalari(valore);
  let ultimoTurno = 0;
  return (testo, turno) => {
    let out = String(testo || '').trim();
    if (!out || !voci.length) return out;
    const trovato = voci.find((x) => new RegExp(`^${escapeRx(x)}(?:[,;:]|\\s)+`, 'i').test(out));
    const permesso = ultimoTurno === 0 || (ultimoTurno <= 3 ? turno >= 6 : turno - ultimoTurno >= 3);
    if (trovato && permesso) {
      ultimoTurno = turno;
      return out;
    }
    if (trovato) out = out.replace(new RegExp(`^${escapeRx(trovato)}(?:[,;:]|\\s)+`, 'i'), '').trim();
    if (!ultimoTurno && turno >= 3 && out) {
      ultimoTurno = turno;
      return `${voci[0]}, ${out}`;
    }
    return out;
  };
}
