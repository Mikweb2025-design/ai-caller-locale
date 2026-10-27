const INCERTO_O_CONDIZIONALE = /\?|\b(?:forse|se|dipende|devo pensarci|ci penso|non (?:sono|ne sono) sicur[oa]|vielleicht|wenn|ich überlege)\b/u;

function rispostaAffermativa(testo) {
  if (!testo || INCERTO_O_CONDIZIONALE.test(testo) || /\?/.test(testo)) return false;
  // "Sì, confermo tutti i dati del riepilogo." è un sì: basta l'apertura affermativa, senza
  // negazioni, correzioni o domande. Prima serviva la frase fatta e il consenso andava perso
  // (l'appuntamento o il richiamo non venivano registrati).
  if (/^(?:sì|si|ok|okay|okey|d'accordo|confermo|esatto|corretto|va bene|è tutto corretto|tutto corretto|ja|genau|das stimmt|ich bestätige)(?![a-zàèéìòùäöüß0-9])/u.test(testo)
    && !/\b(?:no|non|nein|nicht|ma|però|invece|anzi|piuttosto|solo che)\b/u.test(testo)
    && testo.split(/\s+/).length <= 12) return true;
  return /^(?:sì|si|ok|okay|okey|d'accordo|confermo|esatto|corretto|va bene|è tutto corretto|tutto corretto|ja|genau|das stimmt|ich bestätige)(?:[, ]+(?:certo|grazie|grazie mille|perfetto|ciao|arrivederci|confermo|esatto|corretto|è tutto corretto|tutto corretto|va bene|va benissimo|gerne|danke|perfekt))*[.!]*$/u.test(testo);
}

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
  return rispostaAffermativa(risposta);
}

// Un marcatore del modello non autorizza un richiamo: deve averlo chiesto il cliente,
// oppure deve aver accettato in modo esplicito un'offerta di richiamo appena ricevuta.
export function consensoRichiamo(cliente, precedente = '') {
  const normalizza = (s) => String(s || '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  const risposta = normalizza(cliente);
  const proposta = normalizza(precedente);
  if (!risposta || /\b(no|non|nein|nicht)\b/.test(risposta)) return false;
  if (/\b(?:forse|se|dipende|devo pensarci|ci penso|non (?:sono|ne sono) sicur[oa]|vielleicht|wenn|ich überlege)\b/u.test(risposta)) return false;
  if (/\b(?:richiamatemi|richiamami|chiamatemi voi|fatemi richiamare|vorrei che mi richiamaste|mi richiam(?:a|ate)(?: (?:un|una) collega)?|mi (?:faccia|fai|faccia pure|fate|può|puo|potete) richiamare(?: da (?:un|una) collega)?|(?:può|puo|potete) (?:farmi richiamare|richiamarmi)|vorrei essere richiamat[oa]|preferisco essere richiamat[oa]|voglio essere richiamat[oa])\b/.test(risposta)) return true;
  const offerta = /\b(?:richiam\w*|collega.*chiam\w*|chiamare da (?:un|una) collega)\b/.test(proposta) && /\?/.test(proposta);
  if (offerta && rispostaAffermativa(risposta.replace(/^volentieri(?=$|[,.!])/u, 'sì').replace(/^certo(?=$|[,.!])/u, 'sì'))) return true;
  // "Sì, va bene: tre tre tre uno due tre..." — il cliente accetta e intanto detta il numero.
  return offerta && /^(?:sì|si|ok|okay|okey|d'accordo|confermo|esatto|va bene|certo|volentieri|perfetto|ja|genau)(?![a-zàèéìòù])/u.test(risposta)
    && !INCERTO_O_CONDIZIONALE.test(risposta) && !/\b(?:no|non|nein|nicht)\b/u.test(risposta);
}

export function congedoCliente(cliente, turno) {
  const t = String(cliente || '').trim();
  if (/\?|\b(ma|però|ancora|aspetti|aspetta|nicht|aber)\b/i.test(t)) return false;
  return /\b(arrivederci|a presto|buona giornata|buon proseguimento|basta così|nient'altro|niente altro|non mi serve altro|non serve altro|auf wiedersehen|tschüss)(?=$|[\s,.!])/i.test(t)
    || /^(?:no[, .]*)?(?:grazie[, .]*)?(?:è|e) tutto[.!\s]*$/i.test(t)
    || (turno > 1 && /(?:^|[\s,.!])ciao[.!\s]*$/i.test(t));
}
