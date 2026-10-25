// L'aspetto delle pagine (logo, colore, tema): si cambia dal pannello admin, scheda Design,
// oppure si riempiono da solo con "Importa dal sito" (logo della home e colore del CSS).
import { impostazioni } from './impostazioni.mjs';

const ESAD = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

export function vista() {
  const d = impostazioni().design || {};
  return {
    logo: /^https?:\/\//i.test(String(d.logo || '').trim()) ? String(d.logo).trim() : '',
    colore: ESAD.test(String(d.colore || '').trim()) ? String(d.colore).trim().toLowerCase() : '',
    tema: d.tema === 'scuro' || d.tema === 'chiaro' ? d.tema : '',
  };
}

// Il CSS di apertura delle pagine: chiari e scuri sono i due blocchi ":root { … }" originali,
// variabili sono i nomi delle variabili da tingere col colore scelto (es. ['oro'] o ['accento']).
export function temaCss(chiari, scuri, variabili = []) {
  const v = vista();
  const colore = v.colore && variabili.length ? `:root { ${variabili.map((x) => `--${x}:${v.colore};`).join(' ')} }` : '';
  if (v.tema === 'scuro') return scuri + colore;
  if (v.tema === 'chiaro') return chiari + colore;
  return `${chiari}@media (prefers-color-scheme: dark) { ${scuri} }${colore}`;
}

// Il tag del logo da mettere sopra il titolo (scompare da solo se l'indirizzo non risponde).
export function tagLogo(classe = 'logo') {
  const v = vista();
  return v.logo ? `<img class="${classe}" src="${v.logo.replace(/"/g, '&quot;')}" alt="" onerror="this.remove()">` : '';
}
