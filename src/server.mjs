// Il server del receptionist: risponde a Twilio quando arriva una chiamata, serve la pagina
// per chiamare dal browser e collega l'audio alla pipeline locale
// (Parakeet → Claude Code o servizio compatibile OpenAI → Qwen3-TTS).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { CONFIG, RADICE } from './config.mjs';
import { twilio, twilioConfigurato, firmaAttiva, firmaValida, urlPubblico, indirizzoWebhook, verifica, collegaNumero, chiamaNumero, SEGRETO } from './twilio.mjs';
import { ChiamataTwilio } from './twilio-stream.mjs';
import { gestisciChiamata, preriscalda, RIEMPITIVO } from './chiamata.mjs';
import { paginaPannello } from './pannello.mjs';
import { paginaWeb } from './web.mjs';
import { salutoSegmenti } from './persona.mjs';
import { frasePronta } from './voce.mjs';
import { paginaAdmin } from './admin.mjs';
import { paginaDomandaConferma, paginaEsitoConferma } from './conferma.mjs';
import { cercaCalendari, SERVIZI } from './caldav.mjs';
import { avviaImportazione, statoImportazione, datiDesign } from './sito.mjs';
import { recupera, controllaUrl } from './rete.mjs';
import { SERVIZI_CERVELLO, elencaModelli, provaConversazione } from './cervello.mjs';
import { istruzioni } from './persona.mjs';
import { postiPerIstruzioni } from './agenda.mjs';
import { CARTELLA_DATI, proteggi, impostazioniPubbliche, salvaImpostazioni, controllaImpostazioni, impostazioni, alCambio } from './impostazioni.mjs';
import { appuntamenti, annulla, sposta, richiamoFatto, leggiCaldav, postiLiberi, leggiCalendari, impegniEsterni, ics, emailDiProva, inRoma, sincronizzaManca, chiediConferma, chiediConfermaProssimi, rispondiConferma } from './agenda.mjs';

const segreto = SEGRETO;
if (urlPubblico() && !process.env.SEGRETO) console.error('⚠️ URL pubblico impostato ma manca SEGRETO nel .env: il server rifiuta le richieste da internet finché non lo metti.');
const gettoni = new Map(); // gettone monouso → scadenza

function nuovoGettone() {
  const g = randomBytes(12).toString('hex');
  gettoni.set(g, Date.now() + 60000);
  return g;
}

const xml = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// Le voci del receptionist: i campioni .wav della cartella voci/ (quello attivo lo sceglie il pannello)
const CARTELLA_VOCI = join(RADICE, 'voci');
const AVATAR_PREDEFINITO = join(RADICE, 'assets', 'maria-avatar.png');
const avatarCaricato = () => {
  const nome = String(impostazioni().receptionist?.avatar || '');
  return /^avatar-receptionist\.(?:jpg|png|webp)$/.test(nome) && existsSync(join(CARTELLA_DATI, nome)) ? join(CARTELLA_DATI, nome) : '';
};

// PCM 16 bit mono 24 kHz → file WAV con l'intestazione standard da 44 byte
function wav24k(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Senza SEGRETO il server vale solo per questo computer: richieste da un altro nome (Host), da un tunnel
// o da un proxy (che aggiungono intestazioni X-Forwarded-*) vengono rifiutate, così pannello e API
// con le tue chiavi non finiscono per sbaglio su internet.
const NOMI_LOCALI = new Set(['localhost', '127.0.0.1', '[::1]']);
const daProxy = (req) => ['cf-connecting-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded'].some((h) => req.headers[h]);
const ospiteLocale = (req) => NOMI_LOCALI.has((req.headers.host || '').replace(/:\d+$/, '').toLowerCase());
const rifiutaSenzaSegreto = (req) => segreto === 'locale' && (daProxy(req) || !ospiteLocale(req));
const MESSAGGIO_SEGRETO = 'Questo server non ha un SEGRETO e risponde solo a localhost. Per usarlo da internet metti SEGRETO=una-stringa-lunga-a-caso nel file .env e riavvia.\nThis server has no SECRET and only answers on localhost. To use it over the internet set SECRET in .env (SEGRETO=a-long-random-string) and restart.\n';

async function leggiCorpo(req) {
  let s = '';
  let byte = 0;
  for await (const c of req) {
    byte += c.length;
    if (byte > 8 * 1024 * 1024) { const e = new Error('richiesta troppo grande'); e.codiceHttp = 413; throw e; }
    s += c;
  }
  return s;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (codice, o) => { res.writeHead(codice, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const html = (h) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(h); };
  try {
    if (rifiutaSenzaSegreto(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(MESSAGGIO_SEGRETO); }
    // Twilio: è arrivata (o è partita) una chiamata → rispondi con le istruzioni TwiML
    if (req.method === 'POST' && url.pathname === `/twilio/${segreto}/voce`) {
      const corpoForm = new URLSearchParams(await leggiCorpo(req));
      // Con l'Auth Token impostato, vale solo ciò che Twilio ha firmato (l'URL firmato è quello pubblico, non l'Host della richiesta)
      const firma = firmaValida(req.url, corpoForm, req.headers['x-twilio-signature']);
      if (!firma.ok) {
        console.error(`⛔ webhook Twilio rifiutato (403): ${firma.motivo}`);
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Firma Twilio non valida.\n');
      }
      const p = Object.fromEntries(corpoForm);
      const inUscita = url.searchParams.get('uscita') === '1';
      const cliente = inUscita ? p.To : p.From;
      const numeroTwilio = inUscita ? p.From : p.To;
      console.log(`📞 ${p.CallSid} ${inUscita ? 'in uscita verso' : 'da'} ${cliente}`);
      preriscalda(p.CallSid, cliente); // Claude Code si avvia mentre squilla
      // lo stream torna sullo stesso indirizzo pubblico (host e eventuale prefisso), non sull'Host della richiesta
      const base = urlPubblico() ? new URL(urlPubblico()) : null;
      const host = base ? base.host + base.pathname.replace(/\/$/, '') : req.headers.host;
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${xml(host)}/media/tel/${nuovoGettone()}">
      <Parameter name="from" value="${xml(cliente)}"/>
      <Parameter name="to" value="${xml(numeroTwilio)}"/>
    </Stream>
  </Connect>
</Response>`);
    }

    // Chiamata dal browser: microfono, altoparlante e chat
    if (req.method === 'GET' && (url.pathname === `/web/${segreto}` || (url.pathname === '/' && segreto === 'locale'))) {
      return html(paginaWeb({ ws: `/media/web/${segreto}`, admin: segreto === 'locale' ? '/admin' : `/admin/${segreto}`, avatar: `/avatar/${segreto}` }));
    }

    // Pannello admin: impostazioni, calendari, email, appuntamenti
    if (req.method === 'GET' && (url.pathname === `/admin/${segreto}` || (url.pathname === '/admin' && segreto === 'locale'))) {
      const base = urlPubblico() || `http://${req.headers.host}`;
      return html(paginaAdmin({ api: `/api/${segreto}`, web: segreto === 'locale' ? '/' : `/web/${segreto}`, feed: `${base}/calendario/${segreto}.ics`, avatar: `/avatar/${segreto}` }));
    }
    // Foto del receptionist: quella caricata dal pannello, oppure Maria inclusa nell'app.
    if (req.method === 'GET' && url.pathname === `/avatar/${segreto}`) {
      const f = avatarCaricato() || AVATAR_PREDEFINITO;
      if (!existsSync(f)) return json(404, { errore: 'avatar non trovato' });
      const dati = readFileSync(f);
      const tipo = f.endsWith('.jpg') ? 'image/jpeg' : f.endsWith('.webp') ? 'image/webp' : 'image/png';
      res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': dati.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(dati);
    }
    // Conferma dell'appuntamento dal cliente: il link che arriva per email (id + token, nessun segreto del pannello)
    const conferma = url.pathname.match(/^\/conferma\/([a-f0-9]+)\/([a-f0-9]+)(?:\/(si|no))?$/);
    if (req.method === 'GET' && conferma) {
      const [, id, token, scelta] = conferma;
      const r = rispondiConferma(id, token, scelta || '');
      if (!r.ok) return html(paginaEsitoConferma({ appuntamento: r.appuntamento, esito: r.motivo }));
      if (!scelta) return html(paginaDomandaConferma({ appuntamento: r.appuntamento, si: `${url.pathname}/si`, no: `${url.pathname}/no` }));
      console.log(`✉️ ${r.appuntamento.nome}: ${r.risposta === 'si' ? 'confermato' : 'non può venire'} (${r.appuntamento.giorno} ${r.appuntamento.ora})`);
      return html(paginaEsitoConferma({ appuntamento: r.appuntamento, esito: r.appuntamento.confermaEsito }));
    }
    if (url.pathname.startsWith(`/api/${segreto}/`)) {
      const percorso = url.pathname.slice(`/api/${segreto}`.length);
      const corpo = req.method === 'POST' ? JSON.parse((await leggiCorpo(req)) || '{}') : null;
      if (percorso === '/impostazioni' && req.method === 'GET') return json(200, impostazioniPubbliche());
      if (percorso === '/impostazioni' && req.method === 'POST') {
        const prova = structuredClone(impostazioni());
        for (const [sez, v] of Object.entries(corpo)) if (typeof v === 'object' && prova[sez]) Object.assign(prova[sez], v);
        const errori = controllaImpostazioni(prova);
        if (errori.length) return json(400, { errore: errori.join('; ') });
        salvaImpostazioni(corpo);
        await impegniEsterni({ forza: true }).catch(() => {});
        sincronizzaManca().catch((e) => console.warn('⚠️ risincronizzazione calendario:', e.message));
        return json(200, impostazioniPubbliche());
      }
      if (percorso === '/receptionist/avatar' && req.method === 'POST') {
        const vecchio = String(impostazioni().receptionist?.avatar || '');
        const eliminaVecchio = () => {
          if (!/^avatar-receptionist\.(?:jpg|png|webp)$/.test(vecchio)) return;
          const f = join(CARTELLA_DATI, vecchio);
          if (existsSync(f)) unlinkSync(f);
        };
        if (corpo.rimuovi) {
          eliminaVecchio();
          salvaImpostazioni({ receptionist: { avatar: '' } });
          return json(200, { ok: true, avatar: `/avatar/${segreto}` });
        }
        const m = String(corpo.immagine || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=\s]+)$/);
        if (!m) return json(400, { errore: 'formato non valido: usa JPG, PNG o WebP' });
        const dati = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
        if (!dati.length || dati.length > 3 * 1024 * 1024) return json(400, { errore: 'la foto deve pesare al massimo 3 MB' });
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const firmaOk = ext === 'jpg' ? dati[0] === 0xff && dati[1] === 0xd8 && dati[2] === 0xff
          : ext === 'png' ? dati.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
            : dati.subarray(0, 4).toString() === 'RIFF' && dati.subarray(8, 12).toString() === 'WEBP';
        if (!firmaOk) return json(400, { errore: 'il file non contiene una foto valida' });
        const nome = `avatar-receptionist.${ext}`;
        const f = join(CARTELLA_DATI, nome);
        writeFileSync(f, dati, { mode: 0o600 });
        proteggi(f);
        if (vecchio && vecchio !== nome) eliminaVecchio();
        salvaImpostazioni({ receptionist: { avatar: nome } });
        return json(200, { ok: true, avatar: `/avatar/${segreto}` });
      }
      if (percorso === '/appuntamenti') return json(200, { appuntamenti: appuntamenti() });
      // Chiedi al cliente di confermare l'appuntamento: un'email con i due link (uno solo, o a tutti i prossimi)
      if (percorso === '/appuntamenti/chiedi-conferma' && req.method === 'POST') {
        try { return json(200, await chiediConfermaProssimi()); } catch (e) { return json(400, { errore: e.message }); }
      }
      const cc = percorso.match(/^\/appuntamenti\/([a-f0-9]+)\/chiedi-conferma$/);
      if (cc && req.method === 'POST') {
        try { const r = await chiediConferma(cc[1]); return json(200, { appuntamento: r.appuntamento, link: r.link }); }
        catch (e) { return json(400, { errore: e.message }); }
      }
      // Voci del receptionist: elenco, ascolto, nuova voce registrata dal microfono, attivazione, rimozione
      if (percorso === '/voce/elenco') {
        const attiva = String(impostazioni().receptionist?.voce?.campione || '') || 'receptionist.wav';
        const voci = readdirSync(CARTELLA_VOCI)
          .filter((f) => f.endsWith('.wav') && statSync(join(CARTELLA_VOCI, f)).isFile())
          .map((nome) => ({ nome, attivo: nome === attiva, secondi: Math.round((statSync(join(CARTELLA_VOCI, nome)).size / 48000) * 10) / 10 }))
          .sort((a, b) => (Number(b.attivo) - Number(a.attivo)) || a.nome.localeCompare(b.nome, 'it'));
        return json(200, { attiva, voci });
      }
      const va = percorso.match(/^\/voce\/audio\/([\w-]+\.wav)$/);
      if (va && req.method === 'GET') {
        const f = join(CARTELLA_VOCI, va[1]);
        if (!existsSync(f)) return json(404, { errore: 'voce non trovata' });
        const dati = readFileSync(f);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': dati.length, 'Cache-Control': 'no-store' });
        return res.end(dati);
      }
      if (percorso === '/voce/campione' && req.method === 'POST') {
        const nome = String(corpo.nome || '').trim().toLowerCase().replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        if (!nome) return json(400, { errore: 'scrivi il nome della voce (es. Maria)' });
        if (nome === 'receptionist') return json(400, { errore: '"receptionist" è riservato alla voce di partenza: scegli un altro nome' });
        const pcm = Buffer.from(String(corpo.pcm || ''), 'base64');
        const secondi = pcm.length / 48000; // PCM 16 bit a 24 kHz monocanale
        if (!(secondi >= 3)) return json(400, { errore: `registrazione troppo corta (${secondi.toFixed(1)} s): leggi il testo per almeno 20 secondi, meglio di più` });
        if (secondi > 60) return json(400, { errore: `registrazione troppo lunga (${secondi.toFixed(0)} s): massimo un minuto` });
        const testo = String(corpo.testo || '').trim();
        if (!testo) return json(400, { errore: "serve il testo che hai letto: senza di esso la voce non impara a parlare" });
        writeFileSync(join(CARTELLA_VOCI, nome + '.wav'), wav24k(pcm));
        writeFileSync(join(CARTELLA_VOCI, nome + '.json'), JSON.stringify({ testo }, null, 2), { mode: 0o600 });
        return json(200, { ok: true, nome: nome + '.wav', secondi: Math.round(secondi * 10) / 10 });
      }
      if (percorso === '/voce/attiva' && req.method === 'POST') {
        const nome = String(corpo.nome || '').trim();
        if (nome && !/^(receptionist|[\w-]+)\.wav$/.test(nome)) return json(400, { errore: 'nome voce non valido' });
        if (nome && nome !== 'receptionist.wav' && !existsSync(join(CARTELLA_VOCI, nome))) return json(400, { errore: 'voce non trovata: aggiorna l\u2019elenco' });
        salvaImpostazioni({ receptionist: { voce: { campione: nome === 'receptionist.wav' ? '' : nome } } });
        return json(200, impostazioniPubbliche());
      }
      if (percorso === '/voce/elimina' && req.method === 'POST') {
        const nome = String(corpo.nome || '').trim();
        if (!/^[\w-]+\.wav$/.test(nome) || nome === 'receptionist.wav') return json(400, { errore: 'questa voce non si può eliminare' });
        if (nome === impostazioni().receptionist?.voce?.campione) return json(400, { errore: 'prima attiva un\u2019altra voce, poi elimina questa' });
        const f = join(CARTELLA_VOCI, nome);
        if (!existsSync(f)) return json(404, { errore: 'voce non trovata' });
        unlinkSync(f);
        const j = f.replace(/\.wav$/, '.json');
        if (existsSync(j)) unlinkSync(j);
        return json(200, { ok: true });
      }
      const m = percorso.match(/^\/appuntamenti\/([a-f0-9]+)\/annulla$/);
      if (m && req.method === 'POST') { const a = await annulla(m[1]); return a ? json(200, a) : json(404, { errore: 'appuntamento non trovato' }); }
      const sp = percorso.match(/^\/appuntamenti\/([a-f0-9]+)\/sposta$/);
      if (sp && req.method === 'POST') {
        try { const a = await sposta(sp[1], corpo.giorno, corpo.ora); return a ? json(200, a) : json(404, { errore: 'appuntamento non trovato' }); } catch (e) { return json(400, { errore: e.message }); }
      }
      const rf = percorso.match(/^\/appuntamenti\/([a-f0-9]+)\/fatto$/);
      if (rf && req.method === 'POST') { const r = await richiamoFatto(rf[1]); return r ? json(200, r) : json(404, { errore: 'richiamo non trovato' }); }
      // CalDAV: servizi noti, ricerca dei calendari di un conto, prova di lettura
      if (percorso === '/caldav/servizi') return json(200, SERVIZI);
      // Cervello: servizi pronti, elenco modelli, prova di una conversazione (nessun appuntamento viene scritto)
      if (percorso === '/cervello/servizi') return json(200, SERVIZI_CERVELLO);
      if (percorso.startsWith('/cervello/') && req.method === 'POST') {
        const slot = corpo.slot === 'riserva' ? 'riserva' : 'principale';
        const cfg = { ...corpo.config };
        const salvato = impostazioni().cervello?.[slot];
        if (!cfg.chiave && salvato && salvato.servizio === cfg.servizio) cfg.chiave = salvato.chiave; // chiave già salvata
        try {
          if (percorso === '/cervello/modelli') return json(200, { modelli: await elencaModelli(cfg) });
          if (percorso === '/cervello/prova') { const posti = await postiPerIstruzioni(); return json(200, await provaConversazione(cfg, istruzioni({ posti }), { posti })); }
        } catch (e) { return json(400, { errore: e.message }); }
      }
      // Importa dal sito: parte un lavoro, il pannello ne chiede lo stato
      if (percorso === '/sito/importa' && req.method === 'POST') {
        if (!String(corpo.url || '').trim()) return json(400, { errore: "scrivi l'indirizzo del sito" });
        return json(200, { id: avviaImportazione(String(corpo.url)) });
      }
      const imp = percorso.match(/^\/sito\/importa\/(\w+)$/);
      if (imp) { const l = statoImportazione(imp[1]); return l ? json(200, l) : json(404, { errore: 'importazione non trovata' }); }
      // Design: dalla home del sito solo logo e colore (nessuna estrazione, nessun salvataggio)
      if (percorso === '/design/dal-sito' && req.method === 'POST') {
        try {
          let u = String(corpo.url || '').trim() || impostazioni().attivita?.sito || '';
          if (!u) return json(400, { errore: "scrivi l'indirizzo del sito" });
          if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
          const controlli = { privati: false };
          await controllaUrl(u, controlli);
          const r = await recupera(u, { headers: { 'User-Agent': 'Mozilla/5.0 (receptionist AI; lettura informazioni pubbliche)', 'Accept-Language': 'it' }, signal: AbortSignal.timeout(12000) }, controlli);
          if (!r.ok) throw new Error(`il sito risponde con errore ${r.status}`);
          const design = await datiDesign(await r.text(), r.urlFinale || u, controlli);
          if (!design.logo && !design.colore) return json(200, { design: null, nota: 'in quella home non ho trovato né logo né colore' });
          return json(200, { design, nota: 'logo e colore tolti dalla home: premi Salva per applicarli' });
        } catch (e) { return json(400, { errore: e.message }); }
      }
      // Twilio: stato, verifica delle credenziali, collegamento del webhook, chiamata di prova
      if (percorso === '/twilio/stato') return json(200, { webhook: indirizzoWebhook(), segretoLocale: segreto === 'locale', configurato: twilioConfigurato(), numero: twilio().numero, firma: firmaAttiva() });
      if (percorso.startsWith('/twilio/') && req.method === 'POST') {
        try {
          if (percorso === '/twilio/verifica') return json(200, await verifica());
          if (percorso === '/twilio/collega') return json(200, await collegaNumero());
          if (percorso === '/twilio/chiamami') return json(200, { sid: await chiamaNumero(String(corpo.numero || '').replace(/\s+/g, '')) });
        } catch (e) { return json(400, { errore: e.message }); }
      }
      if (percorso.startsWith('/caldav/') && req.method === 'POST') {
        const conto = { ...corpo };
        if (!conto.password) conto.password = (impostazioni().calendari || []).find((c) => c.id === conto.id)?.password || '';
        try {
          if (percorso === '/caldav/cerca') return json(200, { calendari: await cercaCalendari(conto) });
          if (percorso === '/caldav/prova') {
            const { eventi, errori } = await leggiCaldav([{ ...conto, leggi: true }]);
            if (errori.length) throw new Error(errori[0]);
            return json(200, { eventi: eventi.length });
          }
        } catch (e) { return json(400, { errore: e.message }); }
      }
      if (percorso === '/posti') return json(200, { posti: await postiLiberi() });
      if (percorso === '/calendari/verifica' && req.method === 'POST') {
        const { eventi, errori } = await leggiCalendari(corpo.calendariOccupato);
        const ora = new Date();
        const prossimo = eventi.filter((e) => e.fine > ora).sort((a, b) => a.inizio - b.inizio)[0];
        return json(200, { eventi: eventi.length, errori, prossimo: prossimo ? `${prossimo.titolo || 'impegno'} il ${inRoma(prossimo.inizio).iso}` : null });
      }
      if (percorso === '/email/prova' && req.method === 'POST') {
        try { await emailDiProva(String(corpo.a || '')); return json(200, { ok: true }); } catch (e) { return json(400, { errore: e.message }); }
      }
      return json(404, { errore: 'non trovato' });
    }

    // Calendario da abbonarsi (Google Calendar, Apple Calendario, Outlook)
    if (req.method === 'GET' && url.pathname === `/calendario/${segreto}.ics`) {
      res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(ics());
    }

    // Pannello: fatti chiamare al telefono
    if (url.pathname === `/pannello/${segreto}`) {
      let messaggio = '';
      if (req.method === 'POST') {
        const p = Object.fromEntries(new URLSearchParams(await leggiCorpo(req)));
        if (p.chiama) {
          try { messaggio = `Ti sto chiamando (${await chiamaNumero(p.chiama.replace(/\s+/g, ''))}).`; } catch (e) { messaggio = `Chiamata non partita: ${e.message}`; }
        }
      }
      return html(paginaPannello({ messaggio, twilio: twilioConfigurato(), numero: twilio().numero, web: `/web/${segreto}` }));
    }

    if (req.method === 'GET' && url.pathname === '/salute') {
      let motore = false;
      try { motore = (await fetch(`${CONFIG.motore}/salute`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      return json(200, { ok: true, motore, twilio: twilioConfigurato() });
    }

    res.writeHead(404);
    res.end();
  } catch (e) {
    console.error(e);
    // Se qualcosa va storto, chi chiama sente un messaggio invece del silenzio.
    if (url.pathname.includes('/voce')) {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      return res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Say language="it-IT">Ci scusi, al momento non riusciamo a rispondere. Riprovi tra poco.</Say></Response>');
    }
    res.writeHead(e.codiceHttp || 500, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ errore: e.message || 'errore interno' }));
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (rifiutaSenzaSegreto(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  const [, primo, tipo, gettone] = new URL(req.url, 'http://x').pathname.split('/');
  // gettone speciale 'prova' (per i test locali): solo connessione diretta da questo computer, senza
  // intestazioni di proxy, con Host locale; e mai se c'è un URL pubblico con SEGRETO (server esposto)
  const locale = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !daProxy(req) && ospiteLocale(req)
    && !(segreto !== 'locale' && urlPubblico());
  const valido = tipo === 'web'
    ? gettone === segreto
    : tipo === 'tel' && ((gettoni.get(gettone) ?? 0) > Date.now() || (locale && gettone === 'prova'));
  if (primo !== 'media' || !valido) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  gettoni.delete(gettone);
  wss.handleUpgrade(req, socket, head, (ws) => gestisciChiamata(new ChiamataTwilio(ws, tipo, { web: tipo === 'web' })));
});

setInterval(() => { for (const [g, scade] of gettoni) if (scade < Date.now()) gettoni.delete(g); }, 60000).unref();

// il saluto e il riempitivo si preparano subito, così la chiamata parte senza attese
const prepara = () => Promise.all([...salutoSegmenti().map((x) => frasePronta(x.testo, x.lingua)), ...(CONFIG.riempitivoSecondi >= 0 ? [frasePronta(RIEMPITIVO)] : [])])
  .then(() => console.log('🔊 saluto pronto'))
  .catch(() => { console.log('⏳ motore vocale non ancora acceso (npm run motore), riprovo...'); setTimeout(prepara, 5000).unref(); });
prepara();
alCambio(() => { for (const x of salutoSegmenti()) frasePronta(x.testo, x.lingua).catch(() => {}); }); // saluto nuovo: si prepara subito

// Di default solo questo computer. HOST=0.0.0.0 per aprire alla rete (dietro un proxy con https e con SEGRETO).
server.listen(CONFIG.porta, process.env.HOST || '127.0.0.1', () => {
  console.log(`Receptionist in ascolto sulla porta ${CONFIG.porta}`);
  console.log(`Chiamata dal browser: http://localhost:${CONFIG.porta}/${segreto === 'locale' ? '' : `web/${segreto}`}`);
  console.log(`Impostazioni:        http://localhost:${CONFIG.porta}/admin${segreto === 'locale' ? '' : `/${segreto}`}`);
});
