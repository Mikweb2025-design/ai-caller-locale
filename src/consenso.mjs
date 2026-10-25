// I marcatori del modello non bastano: serve il consenso al riepilogo precedente.
export function consensoPrenotazione(cliente, precedente, nome) {
  const normalizza = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const risposta = normalizza(cliente);
  const riepilogo = normalizza(precedente);
  const nominativo = normalizza(nome);
  if (!nominativo || !riepilogo.includes(nominativo)) return false;
  if (!/\?/.test(riepilogo) || !/conferm|tutto (?:corretto|giusto)|è corretto|le torna|ti torna|giusto così|capito bene|stimmt|bestätig/.test(riepilogo)) return false;
  // Correzioni e ripensamenti richiedono un nuovo riepilogo.
  if (/\b(no|non|ma|però|invece|anzi|cambi\w*|spost\w*|nein|nicht|aber|sondern)\b/.test(risposta)) return false;
  return /^(?:sì|si|ok|okay|okey|d'accordo|confermo|esatto|corretto|va bene|è tutto corretto|tutto corretto|ja|genau|das stimmt|ich bestätige)(?=$|[\s,.!])/u.test(risposta);
}

export function congedoCliente(cliente, turno) {
  const t = String(cliente || '').trim();
  if (/\?|\b(ma|però|ancora|aspetti|aspetta|nicht|aber)\b/i.test(t)) return false;
  return /\b(arrivederci|a presto|buona giornata|buon proseguimento|basta così|nient'altro|niente altro|non mi serve altro|non serve altro|auf wiedersehen|tschüss)(?=$|[\s,.!])/i.test(t)
    || /^(?:no[, .]*)?(?:grazie[, .]*)?(?:è|e) tutto[.!\s]*$/i.test(t)
    || (turno > 1 && /(?:^|[\s,.!])ciao[.!\s]*$/i.test(t));
}
