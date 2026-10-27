const INCERTO_O_CONDIZIONALE = /\?|\b(?:forse|se|dipende|devo pensarci|ci penso|non (?:sono|ne sono) sicur[oa]|vielleicht|wenn|ich überlege|maybe|perhaps|not sure|quizás|tal vez|no estoy seguro|peut-être|je ne suis pas sûr)\b/u;

// Le aperture affermative valgono in italiano, tedesco, inglese, spagnolo e francese.
const AFFERMATIVO = 'sì|si|ok|okay|okey|d\'accordo|confermo|esatto|corretto|va bene|è tutto corretto|tutto corretto|ja|genau|das stimmt|ich bestätige|yes|yeah|yep|sure|of course|certainly|correct|that\'s right|that\'s correct|sounds good|works for me|perfect|sí|claro|vale|correcto|de acuerdo|perfecto|por supuesto|oui|d\'accord|parfait|très bien|exact';
const AFFERMATIVO_APERTURA = new RegExp(`^(?:${AFFERMATIVO})(?![a-zàèéìòùäöüßñç0-9])`, 'u');
const AFFERMATIVO_CORTO = new RegExp(`^(?:${AFFERMATIVO})(?:[, ]+(?:certo|grazie|grazie mille|perfetto|ciao|arrivederci|confermo|esatto|corretto|è tutto corretto|tutto corretto|va bene|va benissimo|gerne|danke|perfekt|please|thanks|thank you|great|sí|claro|vale|oui|merci|parfait))*[.!]*$`, 'u');

function rispostaAffermativa(testo) {
  if (!testo || INCERTO_O_CONDIZIONALE.test(testo) || /\?/.test(testo)) return false;
  // "Sì, confermo tutti i dati del riepilogo." è un sì: basta l'apertura affermativa, senza
  // negazioni, correzioni o domande. Prima serviva la frase fatta e il consenso andava perso
  // (l'appuntamento o il richiamo non venivano registrati). Vale anche per le altre lingue.
  if (AFFERMATIVO_APERTURA.test(testo)
    && !/\b(?:no|non|nein|nicht|ma|però|invece|anzi|piuttosto|solo che|not|don't|doesn't|can't|pas|jamais|nunca|tampoco)\b/u.test(testo)
    && testo.split(/\s+/).length <= 12) return true;
  return AFFERMATIVO_CORTO.test(testo);
}

// I marcatori del modello non bastano: serve il consenso al riepilogo precedente.
export function consensoPrenotazione(cliente, precedente, nome) {
  const normalizza = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const risposta = normalizza(cliente);
  const riepilogo = normalizza(precedente);
  const nominativo = normalizza(nome);
  if (!nominativo || !riepilogo.includes(nominativo)) return false;
  if (!/\?/.test(riepilogo) || !/conferm|tutto (?:corretto|giusto)|è corretto|le torna|ti torna|giusto così|capito bene|stimmt|bestätig|does that (?:work|sound)|work for you|is that (?:right|correct)|sounds good|viene bien|correcto|convient|ça vous (?:va|convient)/.test(riepilogo)) return false;
  // Correzioni e ripensamenti richiedono un nuovo riepilogo.
  if (/\b(no|non|ma|però|invece|anzi|cambi\w*|spost\w*|nein|nicht|aber|sondern|not|but|change|pas|mais)\b/.test(risposta)) return false;
  return rispostaAffermativa(risposta);
}

// Un marcatore del modello non autorizza un richiamo: deve averlo chiesto il cliente,
// oppure deve aver accettato in modo esplicito un'offerta di richiamo appena ricevuta.
export function consensoRichiamo(cliente, precedente = '') {
  const normalizza = (s) => String(s || '').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  const risposta = normalizza(cliente);
  const proposta = normalizza(precedente);
  if (!risposta || /\b(no|non|nein|nicht|not|don't|pas|jamais)\b/.test(risposta)) return false;
  if (/\b(?:forse|se|dipende|devo pensarci|ci penso|non (?:sono|ne sono) sicur[oa]|vielleicht|wenn|ich überlege|maybe|perhaps|not sure|quizás|tal vez|peut-être)\b/u.test(risposta)) return false;
  if (/\b(?:richiamatemi|richiamami|chiamatemi voi|fatemi richiamare|vorrei che mi richiamaste|mi richiam(?:a|ate)(?: (?:un|una) collega)?|mi (?:faccia|fai|faccia pure|fate|può|puo|potete) richiamare(?: da (?:un|una) collega)?|(?:può|puo|potete) (?:farmi richiamare|richiamarmi)|vorrei essere richiamat[oa]|preferisco essere richiamat[oa]|voglio essere richiamat[oa]|call me back|have (?:a|your) colleague call me|have someone call me|can you call me|please call me|llámeme|que me llame|puede llamarme|prefiero que me llame|rappelez-moi|qu'un collègue me rappelle|pouvez-vous me rappeler|je préfère être rappelé)\b/.test(risposta)) return true;
  const offerta = /\b(?:richiam\w*|collega.*chiam\w*|chiamare da (?:un|una) collega|call you back|call back|rappel\w*|llam\w*)\b/.test(proposta) && /\?/.test(proposta);
  if (offerta && rispostaAffermativa(risposta.replace(/^volentieri(?=$|[,.!])/u, 'sì').replace(/^certo(?=$|[,.!])/u, 'sì'))) return true;
  // "Sì, va bene: tre tre tre uno due tre..." — il cliente accetta e intanto detta il numero.
  return offerta && /^(?:sì|si|ok|okay|okey|d'accordo|confermo|esatto|va bene|certo|volentieri|perfetto|ja|genau|yes|yeah|sure|of course|sí|claro|vale|oui|d'accord|parfait)(?![a-zàèéìòùñç])/u.test(risposta)
    && !INCERTO_O_CONDIZIONALE.test(risposta) && !/\b(?:no|non|nein|nicht|not|pas)\b/u.test(risposta);
}

export function congedoCliente(cliente, turno) {
  const t = String(cliente || '').trim();
  if (/\?|\b(ma|però|ancora|aspetti|aspetta|nicht|aber|but|still|wait|mais|attendez|pero|espera)\b/i.test(t)) return false;
  return /\b(arrivederci|a presto|buona giornata|buon proseguimento|basta così|nient'altro|niente altro|non mi serve altro|non serve altro|auf wiedersehen|tschüss|goodbye|bye|have a (?:good|nice) day|that's all|nothing else|i'm done|all good|adiós|hasta luego|buen día|nada más|eso es todo|au revoir|bonne journée|c'est tout|rien d'autre)(?=$|[\s,.!])/i.test(t)
    || /^(?:no[, .]*)?(?:grazie[, .]*)?(?:è|e) tutto[.!\s]*$/i.test(t)
    || /^(?:(?:no|thanks|thank you|merci|gracias)[, .]*)*(?:that's all|nothing else|bye|goodbye|c'est tout|rien d'autre|nada más|eso es todo)[.!\s]*$/i.test(t)
    || (turno > 1 && /(?:^|[\s,.!])(ciao|bye|goodbye|salut|adiós)[.!\s]*$/i.test(t));
}
