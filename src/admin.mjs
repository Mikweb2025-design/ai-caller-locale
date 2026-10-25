// Pannello admin: attività, orari, agenda, calendari, email e SMS, più l'elenco degli appuntamenti.
// Una pagina sola che parla con le API /api/<segreto>/... del server.
import { temaCss } from './design.mjs';

export function paginaAdmin({ api, web, feed }) {
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Impostazioni receptionist</title>
<style>
  ${temaCss(
    ':root { --sfondo:#f6f5f2; --testo:#1d1d1b; --tenue:#6b6a66; --accento:#2f6f5e; --bordo:#dedbd3; --carta:#fff; --rosso:#b03a2e; --giallo:#b7791f; }',
    ':root { --sfondo:#141413; --testo:#f1efe9; --tenue:#a19f98; --accento:#5fb39b; --bordo:#33322f; --carta:#1e1e1c; --rosso:#b03a2e; --giallo:#b7791f; }',
    ['accento'],
  )}
  * { box-sizing:border-box; }
  html, body { background:var(--sfondo); }
  body { margin:0; font:15px/1.45 system-ui, sans-serif; color:var(--testo); }
  header { position:sticky; top:0; z-index:2; background:var(--sfondo); border-bottom:1px solid var(--bordo); }
  .barra { max-width:980px; margin:0 auto; padding:12px 16px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  .barra h1 { font-size:18px; margin:0; flex:1; min-width:180px; }
  nav { max-width:980px; margin:0 auto; padding:0 16px 8px; display:flex; gap:6px; overflow-x:auto; }
  nav a { padding:6px 12px; border-radius:999px; color:var(--testo); text-decoration:none; white-space:nowrap; border:1px solid var(--bordo); font-size:14px; }
  nav a.attiva { background:var(--accento); color:#fff; border-color:var(--accento); }
  main { max-width:980px; margin:0 auto; padding:16px; }
  section { display:none; background:var(--carta); border:1px solid var(--bordo); border-radius:14px; padding:18px; margin-bottom:16px; }
  section.attiva { display:block; }
  h2 { font-size:17px; margin:0 0 4px; }
  .aiuto { color:var(--tenue); font-size:13px; margin:2px 0 14px; }
  .griglia { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:12px 16px; }
  label { display:block; font-weight:600; font-size:13px; margin-bottom:4px; }
  label small { font-weight:400; color:var(--tenue); }
  input, select, textarea { width:100%; padding:9px 10px; border-radius:9px; border:1px solid var(--bordo); background:var(--sfondo); color:var(--testo); font:inherit; }
  textarea { min-height:70px; resize:vertical; }
  .riga { display:flex; gap:8px; align-items:center; }
  .check { display:flex; gap:8px; align-items:center; font-weight:500; }
  .check input { width:auto; }
  button { padding:9px 16px; border-radius:999px; border:0; font:inherit; font-weight:600; cursor:pointer; background:var(--accento); color:#fff; }
  button.secondario { background:transparent; color:var(--testo); border:1px solid var(--bordo); }
  button.pericolo { background:transparent; color:var(--rosso); border:1px solid var(--rosso); padding:5px 12px; font-size:13px; }
  .giorni { display:grid; grid-template-columns:110px 1fr; gap:8px 12px; align-items:center; }
  .msg { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); background:var(--testo); color:var(--sfondo); padding:10px 16px; border-radius:10px; display:none; max-width:calc(100% - 32px); z-index:3; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--bordo); vertical-align:top; }
  th { color:var(--tenue); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .tabella { overflow-x:auto; }
  .stato { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid currentColor; white-space:nowrap; }
  .stato.confermato { color:var(--accento); } .stato.annullato { color:var(--tenue); } .stato.da { color:var(--giallo); } .stato.richiamo { color:var(--rosso); } .stato.richiamato { color:var(--tenue); }
  code { background:var(--sfondo); padding:2px 6px; border-radius:6px; word-break:break-all; }
  .posti { display:grid; gap:6px; font-size:14px; }
  .vuoto { color:var(--tenue); font-style:italic; }
  .conto { border:1px solid var(--bordo); border-radius:12px; padding:14px; margin-bottom:12px; }
  .conto .riga { flex-wrap:wrap; }
  .esito { font-size:13px; color:var(--tenue); }
</style></head>
<body>
<header>
  <div class="barra">
    <h1>⚙️ Impostazioni del receptionist</h1>
    <a href="${web}"><button class="secondario" type="button">📞 Prova una chiamata</button></a>
    <button id="salva">Salva</button>
  </div>
  <nav id="schede"></nav>
</header>
<main>
  <section data-scheda="Appuntamenti">
    <h2>Appuntamenti</h2>
    <p class="aiuto">Quelli presi dal receptionist, e i richiami che ha promesso (stanno in cima: premi "Fatto" quando li chiami tu). "Da verificare" = orario già occupato o fuori orario: controllalo tu.</p>
    <div class="riga" style="margin-bottom:10px"><label class="check"><input type="checkbox" id="anchePassati"> mostra anche passati e annullati</label></div>
    <div class="tabella"><table><thead><tr><th>Quando</th><th>Nome</th><th>Contatti</th><th>Dettagli</th><th>Stato</th><th></th></tr></thead><tbody id="elenco"></tbody></table></div>
  </section>

  <section data-scheda="Attività">
    <h2>Importa dal sito</h2>
    <p class="aiuto">Scrivi l'indirizzo del sito: leggo fino a 30 pagine e Claude ne tira fuori tutto quello che serve per rispondere al telefono (servizi, materiali, contatti, domande frequenti…). I campi qui sotto si riempiono: controllali e premi Salva.</p>
    <div class="riga"><input id="sitoUrl" placeholder="es. lasercamp.it" style="max-width:340px"><button type="button" id="sitoImporta">Importa dal sito</button><span class="esito" id="sitoEsito"></span></div>
    <p class="aiuto" id="sitoNota" style="margin-top:8px"></p>
    <h2 style="margin-top:22px">L'attività</h2>
    <p class="aiuto">Quello che il receptionist sa e racconta a chi chiama.</p>
    <div class="griglia">
      <div><label>Nome</label><input data-k="attivita.nome"></div>
      <div><label>Che cos'è <small>(es. "un'officina meccanica indipendente")</small></label><input data-k="attivita.tipo"></div>
      <div><label>Indirizzo</label><input data-k="attivita.indirizzo"></div>
      <div><label>Sito</label><input data-k="attivita.sito"></div>
      <div><label>Telefono</label><input data-k="attivita.telefono"></div>
      <div><label>Email</label><input data-k="attivita.email"></div>
    </div>
    <div style="margin-top:12px"><label>Servizi</label><textarea data-k="attivita.servizi"></textarea></div>
    <div style="margin-top:12px"><label>Cosa chiedere a chi prenota <small>(oltre a nome e orario)</small></label><input data-k="attivita.domande"></div>
    <div style="margin-top:12px"><label>Altre informazioni utili <small>(storia, parcheggio, pagamenti…)</small></label><textarea data-k="attivita.info"></textarea></div>
    <div style="margin-top:12px"><label>Scheda per il telefono <small>(tutto quello che il receptionist deve sapere; si riempie con "Importa dal sito")</small></label><textarea data-k="attivita.conoscenza" style="min-height:260px"></textarea></div>
  </section>

  <section data-scheda="Receptionist">
    <h2>Il receptionist</h2>
    <p class="aiuto">Nome, saluto e istruzioni in più. La voce si cambia in voci/receptionist.wav.</p>
    <div class="griglia">
      <div><label>Nome</label><input data-k="receptionist.nome"></div>
      <div><label>Genere <small>(per l'italiano: pronto/pronta)</small></label><select data-k="receptionist.genere"><option value="m">uomo</option><option value="f">donna</option></select></div>
    </div>
    <h2 style="margin-top:18px">Lingue</h2>
    <p class="aiuto">L'italiano c'è sempre. Con il tedesco il receptionist risponde nella lingua di chi chiama (italiano o Deutsch), anche dentro la stessa telefonata.</p>
    <label class="check"><input type="checkbox" data-k="lingue.tedesco"> Rispondi anche in tedesco</label>
    <div style="margin-top:12px"><label>Saluto in tedesco <small>(si aggiunge a quello italiano; {nome} = nome del receptionist)</small></label><input data-k="lingue.salutoTedesco"></div>
    <div style="margin-top:12px"><label>Saluto <small>(vuoto = "&lt;attività&gt;, buongiorno! Sono &lt;nome&gt;, mi dica.")</small></label><input data-k="receptionist.saluto"></div>
    <div style="margin-top:12px"><label>Istruzioni in più <small>(in italiano, es. "Il venerdì pomeriggio niente revisioni")</small></label><textarea data-k="receptionist.note"></textarea></div>
  </section>

  <section data-scheda="Orari">
    <h2>Orari di apertura</h2>
    <p class="aiuto">Fasce separate da virgola, es. <code>08:00-12:30, 14:00-18:30</code>. Vuoto = chiuso.</p>
    <div class="giorni" id="giorni"></div>
    <div style="margin-top:14px"><label>Chiusure straordinarie <small>(date AAAA-MM-GG separate da virgola)</small></label><input data-k="orari.chiusure" placeholder="2026-12-24, 2026-12-31"></div>
    <h2 style="margin-top:22px">Agenda</h2>
    <div class="griglia" style="margin-top:10px">
      <div><label>Durata appuntamento <small>(minuti)</small></label><input type="number" min="5" step="5" data-k="agenda.durataMinuti"></div>
      <div><label>Appuntamenti in contemporanea</label><input type="number" min="1" data-k="agenda.postiPerFascia"></div>
      <div><label>Preavviso minimo <small>(ore)</small></label><input type="number" min="0" data-k="agenda.preavvisoOre"></div>
      <div><label>Prenotabile fino a <small>(giorni avanti)</small></label><input type="number" min="1" data-k="agenda.giorniAvanti"></div>
      <div><label>Orari da proporre al cliente</label><input type="number" min="1" max="6" data-k="agenda.propostePerChiamata"></div>
    </div>
    <h2 style="margin-top:22px">Prossimi posti liberi</h2>
    <p class="aiuto">Calcolati da orari, appuntamenti e calendari collegati (dopo il salvataggio).</p>
    <div class="posti" id="posti"></div>
  </section>

  <section data-scheda="Calendari">
    <h2>Calendari collegati</h2>
    <p class="aiuto">Nextcloud, iCloud, Fastmail, Synology e ogni calendario CalDAV: il receptionist legge i tuoi impegni (quegli orari non li propone), scrive gli appuntamenti che prende e li sposta o cancella quando lo fai qui. Si accede con una <strong>password per le app</strong>, non con quella principale.</p>
    <div id="conti"></div>
    <button class="secondario" type="button" id="aggiungiConto">+ Aggiungi calendario</button>
    <h2 style="margin-top:26px">Vedere gli appuntamenti in Google o Outlook</h2>
    <p class="aiuto">Abbonati a questo indirizzo da Google Calendar (Altri calendari → Da URL), Apple Calendario (Archivio → Nuovo abbonamento) o Outlook (Aggiungi calendario → Da Internet). Si aggiorna da solo.</p>
    <div class="riga"><code id="feed">${feed}</code><button class="secondario" type="button" id="copiaFeed">Copia</button></div>
    <p class="aiuto" style="margin-top:6px">Google e Outlook ricaricano i calendari abbonati ogni qualche ora e devono raggiungere il server da internet (URL_PUBBLICO). Apple Calendario sullo stesso Mac va anche in locale.</p>
    <h2 style="margin-top:22px">Bloccare gli orari da un calendario in sola lettura</h2>
    <p class="aiuto">Incolla l'indirizzo iCal privato dei tuoi calendari, uno per riga: i loro impegni tolgono i posti liberi.<br>
      Google: Impostazioni → il calendario → "Indirizzo segreto in formato iCal". iCloud: condividi il calendario come pubblico e copia il link (webcal://). Outlook: Impostazioni → Calendari condivisi → Pubblica → ICS.</p>
    <textarea data-k="agenda.calendariOccupato" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"></textarea>
    <div class="riga" style="margin-top:10px"><button class="secondario" type="button" id="verificaCal">Verifica calendari</button><span id="esitoCal" class="aiuto" style="margin:0"></span></div>
  </section>

  <section data-scheda="Design">
    <h2>L'aspetto delle pagine</h2>
    <p class="aiuto">Logo, colore e tema della pagina per chiamare dal browser e del pannello "Fatti chiamare". Vuoto = l'aspetto di partenza. Si riempiono da soli anche con <strong>Importa dal sito</strong> (scheda Attività).</p>
    <div class="griglia">
      <div><label>Logo <small>(indirizzo completo, es. https://…/logo.png)</small></label><input data-k="design.logo" placeholder="https://lasercamp.it/logo.png"></div>
      <div><label>Colore di accento <small>(es. #c9a227, vuoto = predefinito)</small></label><input data-k="design.colore" placeholder="#c9a227"></div>
      <div><label>Tema</label><select data-k="design.tema"><option value="">automatico (segue il sistema)</option><option value="chiaro">chiaro</option><option value="scuro">scuro</option></select></div>
    </div>
    <div class="riga" style="margin-top:12px;flex-wrap:wrap"><input id="designUrl" placeholder="es. lasercamp.it (vuoto = il sito nell'attività)" style="max-width:320px"><button class="secondario" type="button" id="designSito">Prendi logo e colore dal sito</button><span class="esito" id="designEsito"></span></div>
    <p class="aiuto" style="margin-top:6px">Fuori da qui si vedono solo dopo <strong>Salva</strong>, che cambia l'aspetto del pannello e della pagina per chiamare dal browser.</p>
    <div id="designAnteprima" style="margin-top:12px"></div>
  </section>

  <section data-scheda="Cervello">
    <h2>Il cervello</h2>
    <p class="aiuto">Il servizio che capisce il cliente e scrive le risposte. Puoi usare <strong>Claude</strong> oppure un servizio gratuito (Groq, Gemini, OpenRouter, Cerebras…) incollando la sua chiave. L'account "chat" gratuito di ChatGPT o Gemini non si può collegare: serve la chiave API del servizio.</p>
    <p class="aiuto"><strong>Privacy:</strong> in ogni chiamata nomi, telefoni ed email dei clienti passano dal servizio scelto. I piani gratuiti possono usare i dati per addestrare i modelli: leggi le loro condizioni.</p>
    <div id="cervelli"></div>
  </section>

  <section data-scheda="Telefono">
    <h2>Numero di telefono (Twilio)</h2>
    <p class="aiuto">Per rispondere a un numero vero: un account Twilio <strong>non di prova</strong> (in prova Twilio legge un avviso a ogni chiamata), un numero, e questo server raggiungibile da internet in https (VPS, oppure <code>cloudflared tunnel --url http://localhost:5050</code>).</p>
    <div id="avvisoSegreto" class="aiuto" style="display:none;color:var(--rosso)">⚠️ Il server è pubblico ma senza SEGRETO: chiunque conosca l'indirizzo può aprire questo pannello. Metti <code>SEGRETO=una-stringa-lunga-a-caso</code> nel file .env e riavvia: il pannello diventa /admin/&lt;segreto&gt;.</div>
    <div class="griglia" style="margin-top:12px">
      <div><label>Account SID <small>(AC…)</small></label><input data-k="twilio.accountSid" autocomplete="off"></div>
      <div><label>API Key SID <small>(SK…, vuoto se usi l'Auth Token)</small></label><input data-k="twilio.apiKey" autocomplete="off"></div>
      <div><label>API Key secret o Auth Token <small id="twInfo"></small></label><input type="password" data-k="twilio.apiSecret" autocomplete="new-password" placeholder="lascia vuoto per non cambiarlo"></div>
      <div><label>Auth Token dell'account <small id="twInfoAuth"></small></label><input type="password" data-k="twilio.authToken" autocomplete="new-password" placeholder="lascia vuoto per non cambiarlo"></div>
      <div><label>Indirizzo pubblico del server</label><input data-k="twilio.urlPubblico" placeholder="https://receptionist.tuodominio.it"></div>
      <div><label>Numero che risponde</label><input data-k="twilio.numero" placeholder="+39 02 1234567" list="numeriTwilio"><datalist id="numeriTwilio"></datalist></div>
    </div>
    <p class="aiuto" style="margin-top:10px"><strong>Auth Token:</strong> serve solo a verificare che le chiamate arrivino davvero da Twilio (e non da qualcuno che ha scoperto l'indirizzo). Lo trovi nella Console Twilio, pagina principale dell'account. Twilio firma sempre con l'Auth Token primario, anche se per il resto usi una API Key. Se come credenziali usi Account SID + Auth Token, è lo stesso valore di sopra e lo prendo da lì.</p>
    <div id="avvisoFirma" class="aiuto" style="display:none;color:var(--giallo)">⚠️ Firma non verificata: senza Auth Token il server accetta le chiamate di chiunque conosca l'indirizzo segreto. Inserisci l'Auth Token e salva.</div>
    <div id="firmaOk" class="aiuto" style="display:none;color:var(--accento)">✅ Firma delle chiamate Twilio verificata.</div>
    <div class="riga" style="margin-top:12px"><button class="secondario" type="button" id="twVerifica">Verifica credenziali</button><span class="esito" id="twEsito"></span></div>
    <h2 style="margin-top:22px">Collegare il numero</h2>
    <p class="aiuto">Su Twilio: Phone Numbers → il tuo numero → Voice configuration → "A call comes in" = Webhook, <strong>HTTP POST</strong>, con questo indirizzo. Oppure lo imposto io col pulsante.</p>
    <div class="riga"><code id="twWebhook">—</code><button class="secondario" type="button" id="twCopia">Copia</button><button type="button" id="twCollega">Collega il numero automaticamente</button></div>
    <p class="esito" id="twCollegaEsito"></p>
    <h2 style="margin-top:22px">Prova</h2>
    <p class="aiuto">Il receptionist chiama il tuo cellulare e parla per primo (serve tutto quello sopra).</p>
    <div class="riga"><input id="twChiama" placeholder="+39 3xx xxx xxxx" style="max-width:240px"><button class="secondario" type="button" id="twChiamami">Chiamami ora</button><span class="esito" id="twChiamaEsito"></span></div>
  </section>

  <section data-scheda="Email e SMS">
    <h2>Email di conferma</h2>
    <p class="aiuto">A ogni prenotazione: un'email a te (con l'evento da aggiungere al calendario) e, se il cliente ha lasciato l'email, la conferma a lui. Con Gmail usa smtp.gmail.com, porta 465 sicura e una "password per le app".</p>
    <label class="check"><input type="checkbox" data-k="email.attiva"> Email attive</label>
    <div class="griglia" style="margin-top:12px">
      <div><label>Server SMTP</label><input data-k="email.host" placeholder="smtp.gmail.com"></div>
      <div><label>Porta</label><input type="number" data-k="email.porta"></div>
      <div><label class="check" style="margin-top:22px"><input type="checkbox" data-k="email.sicura"> Connessione sicura (porta 465)</label></div>
      <div><label>Utente</label><input data-k="email.utente" autocomplete="off"></div>
      <div><label>Password <small id="pwInfo"></small></label><input type="password" data-k="email.password" autocomplete="new-password" placeholder="lascia vuoto per non cambiarla"></div>
      <div><label>Mittente</label><input data-k="email.mittente" placeholder="Officina Marchetti &lt;prenotazioni@…&gt;"></div>
      <div><label>Avvisa a ogni prenotazione <small>(email, separate da virgola)</small></label><input data-k="email.avvisaA"></div>
    </div>
    <label class="check" style="margin-top:12px"><input type="checkbox" data-k="email.confermaAlCliente"> Manda la conferma al cliente se ha lasciato l'email</label>
    <div class="riga" style="margin-top:12px"><input id="emailProva" placeholder="la tua email" style="max-width:280px"><button class="secondario" type="button" id="provaEmail">Manda email di prova</button></div>
    <h2 style="margin-top:22px">SMS di conferma</h2>
    <p class="aiuto">Con Twilio configurato (scheda Telefono, oppure nel file .env), al cliente che chiama arriva un SMS con giorno e ora.</p>
    <label class="check"><input type="checkbox" data-k="sms.attivo"> SMS attivi</label>
  </section>
</main>
<div class="msg" id="msg"></div>
<script>
const API = ${JSON.stringify(api)};
const $ = (s) => document.querySelector(s);
const GIORNI = { lunedi: 'Lunedì', martedi: 'Martedì', mercoledi: 'Mercoledì', giovedi: 'Giovedì', venerdi: 'Venerdì', sabato: 'Sabato', domenica: 'Domenica' };
let dati = null;

$('#giorni').innerHTML = Object.entries(GIORNI).map(([k, n]) => '<label style="margin:0">' + n + '</label><input data-k="orari.' + k + '" placeholder="chiuso">').join('');

// schede
const sezioni = [...document.querySelectorAll('section')];
const scheda = (nome) => {
  sezioni.forEach((s) => s.classList.toggle('attiva', s.dataset.scheda === nome));
  [...$('#schede').children].forEach((a) => a.classList.toggle('attiva', a.textContent === nome));
  try { localStorage.setItem('scheda', nome); } catch {}
};
for (const s of sezioni) { const a = document.createElement('a'); a.href = '#'; a.textContent = s.dataset.scheda; a.onclick = (e) => { e.preventDefault(); scheda(s.dataset.scheda); }; $('#schede').append(a); }
let iniziale = 'Appuntamenti'; try { iniziale = localStorage.getItem('scheda') || iniziale; } catch {}
if (location.hash) iniziale = decodeURIComponent(location.hash.slice(1));
scheda(sezioni.some((s) => s.dataset.scheda === iniziale) ? iniziale : 'Appuntamenti');

const avviso = (t, ms = 3000) => { const m = $('#msg'); m.textContent = t; m.style.display = 'block'; clearTimeout(avviso.t); avviso.t = setTimeout(() => (m.style.display = 'none'), ms); };
const prendi = (o, k) => k.split('.').reduce((x, p) => x?.[p], o);
const metti = (o, k, v) => { const p = k.split('.'); const u = p.pop(); p.reduce((x, q) => (x[q] ??= {}), o)[u] = v; };
async function chiedi(percorso, opz = {}) {
  const r = await fetch(API + percorso, { headers: { 'Content-Type': 'application/json' }, ...opz, body: opz.body && JSON.stringify(opz.body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.errore || 'errore ' + r.status);
  return j;
}

let servizi = {};
let serviziCervello = {};
const NOMI_SLOT = { principale: 'Principale', riserva: 'Riserva (facoltativa): risponde se il principale sbaglia, tarda o ha raggiunto il limite' };
function schedaCervello(slot, c = {}) {
  const d = document.createElement('div');
  d.className = 'conto cervello'; d.dataset.slot = slot;
  const opz = (slot === 'riserva' ? '<option value="">— nessuna riserva —</option>' : '') + Object.entries(serviziCervello).map(([k, v]) => '<option value="' + k + '"' + (k === c.servizio ? ' selected' : '') + '>' + v.nome + '</option>').join('');
  d.innerHTML = '<h2 style="font-size:15px">' + NOMI_SLOT[slot] + '</h2><div class="griglia">'
    + '<div><label>Servizio</label><select class="k-servizio">' + opz + '</select></div>'
    + '<div class="k-urlbox"><label>Indirizzo</label><input class="k-url"></div>'
    + '<div><label class="k-chiavenome">Chiave</label><input class="k-chiave" type="password" autocomplete="new-password" placeholder="lascia vuoto per non cambiarla"></div>'
    + '<div><label>Modello <small>(Elenca modelli lo chiede al servizio)</small></label><div class="riga"><input class="k-modello" list="mod-' + slot + '"><datalist id="mod-' + slot + '"></datalist><button class="secondario k-elenca" type="button" style="padding:7px 12px">Elenca</button></div></div>'
    + '<div class="k-impbox"><label>Impegno <small>(basso = risponde prima)</small></label><select class="k-impegno"><option value="low">basso</option><option value="medium">medio</option><option value="high">alto</option></select></div>'
    + '</div><p class="aiuto k-aiuto" style="margin:8px 0"></p>'
    + '<div class="riga"><button class="secondario k-prova" type="button">Prova una conversazione</button><span class="esito k-esito"></span></div><div class="k-risultato" style="margin-top:10px"></div>';
  const q = (k) => d.querySelector('.k-' + k);
  q('url').value = c.url || ''; q('modello').value = c.modello || ''; q('impegno').value = c.impegno || 'low';
  q('chiave').placeholder = c.chiaveImpostata ? 'chiave impostata: lascia vuoto per non cambiarla' : 'incolla la chiave';
  const aggiorna = (cambio) => {
    const sv = serviziCervello[q('servizio').value];
    d.querySelector('.k-risultato').innerHTML = '';
    q('aiuto').textContent = sv ? sv.aiuto : '';
    d.querySelector('.k-urlbox').style.display = sv && sv.tipo === 'openai' ? '' : 'none';
    d.querySelector('.k-impbox').style.display = sv && sv.tipo === 'claude' ? '' : 'none';
    q('chiavenome').textContent = sv && sv.tipo === 'claude' ? 'Token o chiave API (vuoto = login già fatto sul computer)' : 'Chiave';
    q('prova').style.display = sv ? '' : 'none';
    if (cambio && sv) { q('url').value = sv.url || ''; q('modello').value = sv.modello || ''; q('chiave').value = ''; q('chiave').placeholder = 'incolla la chiave'; }
  };
  q('servizio').onchange = () => aggiorna(true);
  aggiorna(false);
  q('elenca').onclick = async () => {
    q('esito').textContent = 'chiedo i modelli…';
    try { const { modelli } = await chiedi('/cervello/modelli', { method: 'POST', body: { slot, config: leggiCervello(d) } }); q('modello').nextElementSibling.innerHTML = modelli.map((m) => '<option value="' + esc(m) + '">').join(''); q('esito').textContent = '✅ ' + modelli.length + ' modelli: scrivi nel campo per sceglierne uno'; }
    catch (e) { q('esito').textContent = '⚠️ ' + e.message; }
  };
  q('prova').onclick = async () => {
    q('esito').textContent = 'provo una conversazione (fino a 1 minuto)…'; q('prova').disabled = true; d.querySelector('.k-risultato').innerHTML = '';
    try {
      const r = await chiedi('/cervello/prova', { method: 'POST', body: { slot, config: leggiCervello(d) } });
      q('esito').textContent = (r.ok ? '✅ ' : '⚠️ ') + r.servizio + ' · ' + r.modello + (r.primoMedianoMs ? ' · primo testo in ~' + (r.primoMedianoMs / 1000).toFixed(1) + ' s' : '');
      d.querySelector('.k-risultato').innerHTML = (r.problemi.length ? '<div class="aiuto" style="color:var(--rosso)">' + r.problemi.map(esc).join('<br>') + '</div>' : '<div class="aiuto" style="color:var(--accento)">Ha risposto bene e nel formato giusto per prendere l\u2019appuntamento.</div>')
        + '<div class="posti" style="margin-top:6px">' + r.turni.map((t) => '<div><strong>Cliente:</strong> ' + esc(t.cliente) + '<br><strong>Risposta' + (t.primoMs ? ' (' + (t.primoMs / 1000).toFixed(1) + ' s)' : '') + ':</strong> ' + esc((t.testo || t.errore || '').replace(/<<[^>]*>>?/g, ' [azione] ')) + '</div>').join('') + '</div>';
    } catch (e) { q('esito').textContent = '⚠️ ' + e.message; }
    q('prova').disabled = false;
  };
  $('#cervelli').append(d);
}
function leggiCervello(d) {
  const q = (k) => d.querySelector('.k-' + k);
  return { servizio: q('servizio').value, url: q('url').value.trim(), chiave: q('chiave').value.trim(), modello: q('modello').value.trim(), impegno: q('impegno').value };
}
function schedaConto(c = {}) {
  const d = document.createElement('div');
  d.className = 'conto';
  d.dataset.id = c.id || '';
  const opzioni = Object.entries(servizi).map(([k, v]) => '<option value="' + k + '"' + (k === (c.servizio || 'nextcloud') ? ' selected' : '') + '>' + v.nome + '</option>').join('');
  d.innerHTML = '<div class="griglia">'
    + '<div><label>Servizio</label><select class="c-servizio">' + opzioni + '</select></div>'
    + '<div><label>Nome <small>(per te)</small></label><input class="c-nome" placeholder="es. Calendario laboratorio"></div>'
    + '<div style="grid-column:1/-1"><label>Indirizzo CalDAV</label><input class="c-url"></div>'
    + '<div><label>Utente</label><input class="c-utente" autocomplete="off"></div>'
    + '<div><label>Password per le app <small class="c-pwinfo"></small></label><input class="c-password" type="password" autocomplete="new-password" placeholder="lascia vuoto per non cambiarla"></div>'
    + '</div><p class="aiuto c-aiuto" style="margin:8px 0"></p>'
    + '<div class="riga" style="margin:8px 0"><button class="secondario c-cerca" type="button">Cerca calendari</button><select class="c-calendario" style="max-width:320px"></select><span class="esito c-esito"></span></div>'
    + '<div class="riga"><label class="check"><input type="checkbox" class="c-leggi"> legge gli impegni</label><label class="check"><input type="checkbox" class="c-scrivi"> scrive gli appuntamenti</label><button class="secondario c-prova" type="button">Prova</button><button class="pericolo c-togli" type="button">Rimuovi</button></div>';
  const q = (k) => d.querySelector('.c-' + k);
  q('nome').value = c.nome || ''; q('url').value = c.url || ''; q('utente').value = c.utente || '';
  q('leggi').checked = c.leggi ?? true; q('scrivi').checked = c.scrivi ?? true;
  q('pwinfo').textContent = c.passwordImpostata ? '(impostata)' : '';
  if (c.calendario) q('calendario').innerHTML = '<option value="' + esc(c.calendario) + '">' + esc(c.calendarioNome || c.calendario) + '</option>';
  else q('calendario').innerHTML = '<option value="">— prima cerca i calendari —</option>';
  const aiuto = () => { const sv = servizi[q('servizio').value]; q('aiuto').textContent = sv ? sv.aiuto : ''; };
  q('servizio').onchange = () => { const sv = servizi[q('servizio').value]; if (sv && (!q('url').value || Object.values(servizi).some((x) => x.url === q('url').value))) q('url').value = sv.url; aiuto(); };
  aiuto();
  q('cerca').onclick = async () => {
    q('esito').textContent = 'cerco…';
    try {
      const { calendari } = await chiedi('/caldav/cerca', { method: 'POST', body: leggiConto(d) });
      q('calendario').innerHTML = calendari.map((x) => '<option value="' + esc(x.url) + '">' + esc(x.nome) + (x.soloLettura ? ' (sola lettura)' : '') + '</option>').join('');
      q('esito').textContent = calendari.length ? '✅ ' + calendari.length + ' calendari: scegli quello giusto e salva' : 'nessun calendario trovato';
    } catch (e) { q('esito').textContent = '⚠️ ' + e.message; }
  };
  q('prova').onclick = async () => {
    q('esito').textContent = 'provo…';
    try { const r = await chiedi('/caldav/prova', { method: 'POST', body: leggiConto(d) }); q('esito').textContent = '✅ letti ' + r.eventi + ' impegni dei prossimi giorni'; }
    catch (e) { q('esito').textContent = '⚠️ ' + e.message; }
  };
  q('togli').onclick = () => { if (confirm('Scollegare questo calendario? (gli eventi già scritti restano)')) d.remove(); };
  $('#conti').append(d);
}
function leggiConto(d) {
  const q = (k) => d.querySelector('.c-' + k);
  const sel = q('calendario');
  return { id: d.dataset.id || undefined, servizio: q('servizio').value, nome: q('nome').value.trim(), url: q('url').value.trim(), utente: q('utente').value.trim(), password: q('password').value,
    calendario: sel.value, calendarioNome: sel.selectedOptions[0]?.textContent.replace(/ \(sola lettura\)$/, '') || '', leggi: q('leggi').checked, scrivi: q('scrivi').checked };
}
$('#aggiungiConto').onclick = () => schedaConto({ url: servizi.nextcloud?.url });

function riempi() {
  $('#cervelli').innerHTML = '';
  for (const slot of ['principale', 'riserva']) schedaCervello(slot, dati.cervello?.[slot]);
  $('#conti').innerHTML = '';
  for (const c of dati.calendari || []) schedaConto(c);
  for (const el of document.querySelectorAll('[data-k]')) {
    const v = prendi(dati, el.dataset.k);
    if (el.type === 'checkbox') el.checked = Boolean(v); else el.value = v ?? '';
  }
  $('#pwInfo').textContent = dati.email.passwordImpostata ? '(impostata)' : '(non impostata)';
  $('#twInfo').textContent = dati.twilio.segretoImpostato ? '(impostato)' : '';
  $('#twInfoAuth').textContent = dati.twilio.authTokenImpostato ? '(impostato)' : '';
  statoTwilio();
  anteprimaDesign();
}
function raccogli() {
  const o = {};
  for (const el of document.querySelectorAll('[data-k]')) metti(o, el.dataset.k, el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value);
  o.calendari = [...document.querySelectorAll('.conto:not(.cervello)')].map(leggiConto);
  o.cervello = {};
  for (const d of document.querySelectorAll('.cervello')) o.cervello[d.dataset.slot] = leggiCervello(d);
  return o;
}

const quando = (a) => new Date(a.giorno + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + a.ora;
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const classeStato = (s) => (s === 'da verificare' ? 'da' : s === 'da richiamare' ? 'richiamo' : s);
async function elenco() {
  const { appuntamenti } = await chiedi('/appuntamenti');
  const oggi = new Date().toISOString().slice(0, 10);
  const lista = appuntamenti.filter((a) => $('#anchePassati').checked || (a.tipo === 'richiamo' ? a.stato === 'da richiamare' : a.stato !== 'annullato' && a.giorno >= oggi))
    .sort((a, b) => (a.tipo === 'richiamo' ? ' ' + (a.creato || '') : a.giorno + a.ora).localeCompare(b.tipo === 'richiamo' ? ' ' + (b.creato || '') : b.giorno + b.ora));
  $('#elenco').innerHTML = lista.length ? lista.map((a) => {
    const richiamo = a.tipo === 'richiamo';
    const quandoTxt = richiamo ? '📞 Richiamo' : quando(a);
    const bottone = (classe, az, testo) => '<button class="' + classe + '" ' + az + ' style="padding:5px 12px;font-size:13px;margin:0 6px 6px 0">' + testo + '</button>';
    const bottoni = richiamo
      ? (a.stato === 'da richiamare' ? bottone('secondario', 'data-fatto="' + a.id + '"', 'Fatto') + bottone('pericolo', 'data-annulla="' + a.id + '"', 'Annulla') : '')
      : (a.stato !== 'annullato' ? bottone('secondario', 'data-sposta="' + a.id + '" data-quando="' + a.giorno + ' ' + a.ora + '"', 'Sposta') + bottone('pericolo', 'data-annulla="' + a.id + '"', 'Annulla') : '');
    return '<tr><td>' + quandoTxt + '</td><td>' + esc(a.nome) + '</td><td>' + esc([a.telefono, a.email].filter(Boolean).join('<br>') || '-').replace(/&lt;br&gt;/g, '<br>') + '</td><td>' + esc(richiamo ? a.motivo : a.dettagli) + '<br><small class="aiuto">' + esc(a.canale) + '</small></td><td><span class="stato ' + classeStato(a.stato) + '">' + esc(a.stato) + '</span></td><td>' + bottoni + '</td></tr>';
  }).join('')
    : '<tr><td colspan="6" class="vuoto">Nessun appuntamento.</td></tr>';
}
async function posti() {
  const { posti } = await chiedi('/posti');
  const g = {};
  for (const p of posti) (g[p.giorno] ??= []).push(p.ora);
  const righe = Object.entries(g).slice(0, 7).map(([d, o]) => '<div><strong>' + new Date(d + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }) + '</strong>: ' + o.join(', ') + '</div>');
  $('#posti').innerHTML = righe.join('') || '<div class="vuoto">Nessun posto libero.</div>';
}

function anteprimaDesign() {
  const logo = ($('[data-k="design.logo"]').value || '').trim();
  const colore = ($('[data-k="design.colore"]').value || '').trim();
  const tema = $('[data-k="design.tema"]').value;
  if (!logo && !colore) { $('#designAnteprima').innerHTML = '<p class="aiuto">Vuoto: resta l&#39;aspetto di partenza.</p>'; return; }
  const scuro = tema === 'scuro';
  const sfondo = scuro ? '#141413' : '#f6f5f2', carta = scuro ? '#1e1e1c' : '#fff', testo = scuro ? '#f1efe9' : '#1d1d1b';
  $('#designAnteprima').innerHTML = '<div style="border:1px solid var(--bordo);border-radius:12px;padding:14px;display:flex;gap:14px;align-items:center;background:' + carta + ';color:' + testo + '">'
    + (logo ? '<img src="' + esc(logo) + '" alt="" style="height:46px;max-width:170px;object-fit:contain" onerror="this.remove()">' : '')
    + '<strong style="margin:0">' + esc(dati.attivita?.nome || "l'attività") + '</strong>'
    + (colore ? '<span title="' + esc(colore) + '" style="width:24px;height:24px;border-radius:7px;display:inline-block;background:' + esc(colore) + '' + (scuro ? '' : '') + '"></span>' : '')
    + '<span class="esito" style="margin-left:auto">tema: ' + (tema || 'automatico') + '</span></div>';
}
$('#designSito').onclick = async () => {
  $('#designEsito').textContent = 'leggo la home del sito…';
  try {
    const r = await chiedi('/design/dal-sito', { method: 'POST', body: { url: $('#designUrl').value.trim() } });
    if (!r.design) { $('#designEsito').textContent = '⚠️ ' + (r.nota || 'niente'); return; }
    if (r.design.logo) $('[data-k="design.logo"]').value = r.design.logo;
    if (r.design.colore) $('[data-k="design.colore"]').value = r.design.colore;
    anteprimaDesign();
    $('#designEsito').textContent = '✅ ' + (r.nota || 'trovato');
  } catch (e) { $('#designEsito').textContent = '⚠️ ' + e.message; }
};
for (const k of ['design.logo', 'design.colore', 'design.tema']) $('[data-k="' + k + '"]').addEventListener('input', anteprimaDesign);

$('#elenco').onclick = async (e) => {
  if (e.target.dataset.sposta) {
    const nuovo = prompt('Nuovo giorno e ora (AAAA-MM-GG HH:MM)', e.target.dataset.quando);
    const m = nuovo && nuovo.trim().match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}[:.]\d{2})$/);
    if (!nuovo) return;
    if (!m) return avviso('Formato: 2026-10-30 15:00');
    try { const a = await chiedi('/appuntamenti/' + e.target.dataset.sposta + '/sposta', { method: 'POST', body: { giorno: m[1], ora: m[2] } }); avviso(a.stato === 'confermato' ? 'Appuntamento spostato' : 'Spostato, ma quell’orario non era libero: è "da verificare"'); elenco(); posti(); }
    catch (err) { avviso(err.message); }
    return;
  }
  if (e.target.dataset.fatto) {
    try { await chiedi('/appuntamenti/' + e.target.dataset.fatto + '/fatto', { method: 'POST' }); avviso('Segnato come richiamato'); elenco(); }
    catch (err) { avviso(err.message); }
    return;
  }
  const id = e.target.dataset.annulla;
  if (!id || !confirm('Annullare questo appuntamento?')) return;
  try { await chiedi('/appuntamenti/' + id + '/annulla', { method: 'POST' }); avviso('Appuntamento annullato'); elenco(); posti(); } catch (err) { avviso(err.message); }
};
$('#anchePassati').onchange = elenco;
$('#salva').onclick = async () => {
  try { dati = await chiedi('/impostazioni', { method: 'POST', body: raccogli() }); riempi(); avviso('Salvato. Vale dalla prossima chiamata.'); posti(); }
  catch (e) { avviso('Non salvato: ' + e.message, 6000); }
};
$('#copiaFeed').onclick = () => navigator.clipboard.writeText($('#feed').textContent).then(() => avviso('Indirizzo copiato'));
$('#verificaCal').onclick = async () => {
  $('#esitoCal').textContent = 'controllo…';
  try {
    const r = await chiedi('/calendari/verifica', { method: 'POST', body: { calendariOccupato: prendi(raccogli(), 'agenda.calendariOccupato') } });
    $('#esitoCal').textContent = r.errori.length ? '⚠️ ' + r.errori.join(' · ') : '✅ ' + r.eventi + ' impegni letti' + (r.prossimo ? ', il prossimo: ' + r.prossimo : '');
  } catch (e) { $('#esitoCal').textContent = '⚠️ ' + e.message; }
};
async function statoTwilio() {
  try {
    const s = await chiedi('/twilio/stato');
    $('#twWebhook').textContent = s.webhook || 'metti prima l\u2019indirizzo pubblico e salva';
    $('#avvisoSegreto').style.display = s.segretoLocale && s.webhook ? 'block' : 'none';
    $('#avvisoFirma').style.display = !s.firma && s.webhook ? 'block' : 'none';
    $('#firmaOk').style.display = s.firma && s.webhook ? 'block' : 'none';
  } catch {}
}
const salvaPrima = () => chiedi('/impostazioni', { method: 'POST', body: raccogli() }).then((d) => { dati = d; $('#twInfo').textContent = d.twilio.segretoImpostato ? '(impostato)' : ''; $('#twInfoAuth').textContent = d.twilio.authTokenImpostato ? '(impostato)' : ''; statoTwilio(); });
$('#twVerifica').onclick = async () => {
  $('#twEsito').textContent = 'controllo…';
  try {
    await salvaPrima();
    const r = await chiedi('/twilio/verifica', { method: 'POST' });
    $('#numeriTwilio').innerHTML = r.numeri.map((n) => '<option value="' + esc(n.numero) + '">' + esc(n.nome) + '</option>').join('');
    if (!$('[data-k="twilio.numero"]').value && r.numeri[0]) $('[data-k="twilio.numero"]').value = r.numeri[0].numero;
    $('#twEsito').textContent = '✅ ' + r.conto + (r.tipo === 'Trial' ? ' (account di PROVA: le chiamate iniziano con un avviso di Twilio)' : '') + ' · numeri: ' + (r.numeri.map((n) => n.numero).join(', ') || 'nessuno');
    statoTwilio();
  } catch (e) { $('#twEsito').textContent = '⚠️ ' + e.message; }
};
$('#twCopia').onclick = () => navigator.clipboard.writeText($('#twWebhook').textContent).then(() => avviso('Indirizzo copiato'));
$('#twCollega').onclick = async () => {
  $('#twCollegaEsito').textContent = 'collego…';
  try { await salvaPrima(); const r = await chiedi('/twilio/collega', { method: 'POST' }); $('#twCollegaEsito').textContent = '✅ ' + r.numero + ' ora risponde con il receptionist'; statoTwilio(); }
  catch (e) { $('#twCollegaEsito').textContent = '⚠️ ' + e.message; }
};
$('#twChiamami').onclick = async () => {
  const n = $('#twChiama').value.trim();
  if (!n) return avviso('Scrivi il tuo numero');
  $('#twChiamaEsito').textContent = 'chiamo…';
  try { await salvaPrima(); const r = await chiedi('/twilio/chiamami', { method: 'POST', body: { numero: n } }); $('#twChiamaEsito').textContent = '📞 ti sto chiamando (' + r.sid + ')'; }
  catch (e) { $('#twChiamaEsito').textContent = '⚠️ ' + e.message; }
};
$('#sitoImporta').onclick = async () => {
  const url = $('#sitoUrl').value.trim();
  if (!url) return avviso("Scrivi l'indirizzo del sito");
  $('#sitoImporta').disabled = true; $('#sitoNota').textContent = '';
  try {
    const { id } = await chiedi('/sito/importa', { method: 'POST', body: { url } });
    let l;
    do { await new Promise((r) => setTimeout(r, 1500)); l = await chiedi('/sito/importa/' + id); $('#sitoEsito').textContent = '⏳ ' + l.messaggio; } while (l.stato === 'in corso');
    if (l.stato === 'errore') throw new Error(l.messaggio);
    const d = l.dati, metti1 = (k, v) => { const el = document.querySelector('[data-k="' + k + '"]'); if (el && v) el.value = v; };
    for (const k of ['nome', 'tipo', 'indirizzo', 'telefono', 'email', 'sito', 'servizi', 'domande', 'conoscenza']) metti1('attivita.' + k, d[k]);
    if (d.design) { metti1('design.logo', d.design.logo); metti1('design.colore', d.design.colore); }
    if (d.saluto) metti1('receptionist.saluto', d.saluto.replace('{nome}', $('[data-k="receptionist.nome"]').value || 'Luca'));
    if (d.orariTrovati && d.orari) for (const [g, v] of Object.entries(d.orari)) { const el = document.querySelector('[data-k="orari.' + g + '"]'); if (el) el.value = v || ''; }
    $('#sitoEsito').textContent = '✅ ' + l.messaggio + '. Controlla i campi e premi Salva.';
    $('#sitoNota').textContent = (d.orariTrovati ? 'Ho preso anche gli orari di apertura (scheda Orari). ' : 'Orari di apertura non trovati sul sito: mettili tu nella scheda Orari. ') + (d.design && (d.design.logo || d.design.colore) ? 'Ho preso anche logo e colore principale del sito (scheda Design). ' : '') + (d.nonTrovato || '');
  } catch (e) { $('#sitoEsito').textContent = '⚠️ ' + e.message; }
  $('#sitoImporta').disabled = false;
};
$('#provaEmail').onclick = async () => {
  const a = $('#emailProva').value.trim();
  if (!a) return avviso('Scrivi a chi mandarla');
  try { await chiedi('/impostazioni', { method: 'POST', body: raccogli() }); await chiedi('/email/prova', { method: 'POST', body: { a } }); avviso('Email di prova inviata a ' + a); }
  catch (e) { avviso('Email non partita: ' + e.message, 8000); }
};

(async () => {
  try { servizi = await chiedi('/caldav/servizi'); serviziCervello = await chiedi('/cervello/servizi'); dati = await chiedi('/impostazioni'); riempi(); await Promise.all([elenco(), posti()]); }
  catch (e) { avviso('Server non raggiungibile: ' + e.message, 8000); }
})();
</script>
</body></html>`;
}
