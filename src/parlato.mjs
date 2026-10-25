// Converte i numeri rimasti nel testo parlato: il TTS rende meglio con le parole.
const PICCOLI = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
const DECINE = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];

export function interoInParole(valore) {
  const n = Number(valore);
  if (!Number.isSafeInteger(n) || n < 0) return String(valore);
  if (n < 20) return PICCOLI[n];
  if (n < 100) {
    const u = n % 10;
    let d = DECINE[Math.floor(n / 10)];
    if (u === 1 || u === 8) d = d.slice(0, -1);
    const coda = u ? PICCOLI[u] : '';
    return d + (u === 3 ? 'tré' : coda);
  }
  if (n < 1000) {
    const r = n % 100;
    let testa = n < 200 ? 'cento' : interoInParole(Math.floor(n / 100)) + 'cento';
    if (r >= 80 && r < 90) testa = testa.slice(0, -1);
    return testa + (r ? interoInParole(r) : '');
  }
  if (n < 1_000_000) {
    const r = n % 1000, migliaia = Math.floor(n / 1000);
    return (migliaia === 1 ? 'mille' : interoInParole(migliaia) + 'mila') + (r ? interoInParole(r) : '');
  }
  return String(valore).split('').map((x) => PICCOLI[Number(x)]).join(' ');
}

export function numeriInParole(testo) {
  return String(testo)
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_m, h, m) => `${interoInParole(h)}${Number(m) ? ` e ${interoInParole(m)}` : ''}`)
    .replace(/\b(\d+)[,.](\d+)\b/g, (_m, a, b) => `${interoInParole(a)} virgola ${b.split('').map((x) => PICCOLI[Number(x)]).join(' ')}`)
    .replace(/\b\d+\b/g, (n) => interoInParole(n));
}

// Ripulisce la punteggiatura prima del TTS. Qwen usa questi segni per ritmo e pause:
// virgola = respiro breve, punto = pausa piena, domanda = intonazione interrogativa.
export function punteggiaturaDaVoce(testo) {
  let s = String(testo || '')
    .replace(/\r?\n+/g, '. ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,.;:!?])(?=[^\s,.;:!?])/g, '$1 ')
    .replace(/\.{2,}/g, '.')
    .replace(/([!?])\1+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s && !/[,.!?;:]$/.test(s)) s += '.';
  return s;
}
