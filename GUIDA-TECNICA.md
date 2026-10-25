# Guida tecnica

Come funziona il receptionist AI locale, come avviarlo e come adattarlo. Il README racconta cosa fa; qui c'è il come.

## Come funziona

```
telefono (Twilio)  ─┐                         ┌─ motore/motore.py (Python, MLX)
                    ├─ μ-law 8 kHz ─ server ──┤   /stt  Parakeet v3 (o faster-whisper)
browser (web.mjs)  ─┘   Media Streams   │     └─  /tts  Qwen3-TTS, in streaming
                                        └──── claude -p (stream-json): il cervello
```

- **Un solo protocollo.** Twilio e la pagina web parlano lo stesso protocollo Media Streams (μ-law 8 kHz, `mark`, `clear`), quindi passano per la stessa pipeline in `src/chiamata.mjs`. La pagina web in più riceve la trascrizione e può scrivere al receptionist come in una chat.
- **Fine frase.** VAD a energia sul server: `VAD_SILENZIO_MS` (750 ms) di silenzio chiudono la frase, che va al motore per la trascrizione.
- **Cervello.** Per ogni chiamata parte un processo `claude -p --input-format stream-json --output-format stream-json --include-partial-messages`, senza strumenti, senza MCP e senza impostazioni del progetto, con le istruzioni di `persona.mjs` come system prompt e `MAX_THINKING_TOKENS=0`. Per le telefonate Twilio parte mentre il telefono squilla.
- **Azioni.** Claude non ha strumenti: per registrare l'appuntamento e riagganciare scrive i marcatori `<<CONFERMA|nome|AAAA-MM-GG|HH:MM|dettagli>>` e `<<FINE>>`, che il server esegue e non fa sentire. I posti liberi gli arrivano nelle istruzioni a ogni chiamata.
- **Voce.** Il testo di Claude arriva token per token; appena c'è una frase intera (almeno 20 caratteri) va a Qwen3-TTS, che restituisce l'audio a pezzi mentre lo genera. Saluto e riempitivo ("Mmh, allora...") sono pronti in memoria dall'avvio.
- **Interruzioni.** Se il cliente parla sopra al receptionist, il server svuota l'audio (`clear`), interrompe la sintesi e ignora il resto della risposta.
- **Motore.** La trascrizione gira in un processo separato, così non aspetta mai che la voce finisca di generare. Si chiude sempre insieme al motore, anche con kill.
- **Memoria.** Appena parte, il motore spegne i servizi launchd elencati in `SPEGNI_SERVIZI` (altri server di modelli che occuperebbero RAM) e li riaccende quando lo chiudi. Lascialo vuoto per non toccare niente.

```
src/
  server.mjs         webhook Twilio, pagina web, pannello, WebSocket
  chiamata.mjs       la pipeline: VAD → trascrizione → Claude Code → voce, interruzioni, azioni
  cervello.mjs       il processo Claude Code in streaming
  voce.mjs           client del motore vocale, codifica μ-law
  web.mjs            pagina per chiamare dal browser (microfono + chat)
  persona.mjs        chi è il receptionist, come parla, cosa sa, come va la chiamata
  impostazioni.mjs   impostazioni del pannello admin (dati/impostazioni.json)
  agenda.mjs         posti liberi, appuntamenti, calendari iCal, email di conferma
  caldav.mjs         calendari CalDAV: ricerca, lettura, creazione, spostamento, cancellazione
  admin.mjs          pagina del pannello admin
  twilio.mjs         numero Twilio: credenziali, verifica, webhook automatico, SMS, chiamate in uscita
  strumenti.mjs      registrazione dell'appuntamento e SMS di conferma
  twilio-stream.mjs  lato Twilio della chiamata: audio, marche, riaggancio
  pannello.mjs       pagina del pannello
motore/motore.py     orecchie e voce, tutto in locale
prove/               chiamate simulate e misure dei ritardi
```

## Cosa serve

- Un Mac con Apple Silicon (MLX). Con 16 GB di RAM va bene.
- Node.js 20.12 o più recente.
- Python 3.11+ con `pip install -r motore/requirements.txt`. Al primo avvio scarica i modelli da Hugging Face (~1,5 GB).
- Claude Code installato e con accesso fatto (`claude` nel terminale).
- Facoltativo, per il numero vero: un account Twilio e un indirizzo HTTPS pubblico (Cloudflare Tunnel va benissimo).

## Avvio

1. `npm install`
2. `cp .env.example .env` (i valori predefiniti vanno già bene per provare in locale).
3. `npm run motore` e aspetta "Motore vocale pronto".
4. In un altro terminale `npm start` e apri **http://localhost:5050**: premi Chiama e parla (meglio con le cuffie), oppure scrivi in chat.
5. Le impostazioni sono su **http://localhost:5050/admin**.

## Pannello admin

Tutto si cambia da `/admin` (con `SEGRETO`: `/admin/<SEGRETO>`) e vale dalla chiamata successiva. I dati stanno in `dati/impostazioni.json` e `dati/appuntamenti.json`.
- **Appuntamenti:** elenco, spostamento e annullamento (anche nei calendari collegati). "Da verificare" = il cliente ha preso un orario già occupato o fuori orario.
- **Attività e Receptionist:** nome, indirizzo, servizi, cosa chiedere a chi prenota, saluto, istruzioni in più.
- **Orari:** fasce per giorno, chiusure straordinarie, durata degli appuntamenti, quanti in contemporanea, preavviso, quanto avanti si prenota. Il receptionist propone solo i posti davvero liberi.
- **Calendari collegati (CalDAV):** Nextcloud, iCloud, Fastmail, Synology, mailbox.org, Zoho, Yahoo, Radicale, Baïkal e ogni server CalDAV, anche più di uno insieme.
  - Si accede con utente e **password per le app**. "Cerca calendari" trova i calendari anche partendo dal solo indirizzo del server; "Prova" legge gli impegni.
  - **Legge** gli impegni dei prossimi giorni, compresi quelli ricorrenti (espansi dal server), e quegli orari non li propone. Si rileggono ogni 5 minuti e subito dopo ogni modifica.
  - **Scrive** ogni appuntamento preso; quando lo **sposti** o lo **annulli** dal pannello, l'evento viene aggiornato o cancellato. Gli eventi scritti dal receptionist hanno UID `…@ai-caller-locale` e non contano come impegni.
  - Google Calendar non accetta password per le app su CalDAV: per Google usa l'abbonamento qui sotto (per vedere gli appuntamenti) e l'indirizzo iCal segreto (per bloccare gli orari).
- **Calendari in sola lettura:**
  - l'indirizzo `/calendario/<SEGRETO>.ics` si aggiunge come abbonamento in Google Calendar, Apple Calendario o Outlook e mostra gli appuntamenti;
  - gli indirizzi iCal privati dei tuoi calendari bloccano gli orari in cui sei impegnato (letti ogni 5 minuti; qui gli eventi ricorrenti contano solo alla prima occorrenza).
- **Email e SMS:** server SMTP (con Gmail: smtp.gmail.com, porta 465 sicura, password per le app). A ogni prenotazione parte un'email al titolare e, se il cliente ha lasciato l'email, la conferma a lui, tutte e due con l'evento allegato. Gli SMS passano da Twilio.

### Con il numero Twilio

Si fa tutto dal pannello admin, scheda **Telefono**:
1. Metti `SEGRETO` (una stringa casuale lunga) nel `.env` e riavvia: il pannello diventa `/admin/<SEGRETO>`. Senza, chiunque conosca l'indirizzo pubblico potrebbe aprirlo (il pannello lo segnala in rosso).
2. Rendi il server raggiungibile in https, per esempio con `cloudflared tunnel --url http://localhost:5050`, e scrivi l'indirizzo in "Indirizzo pubblico del server".
3. Inserisci Account SID e API Key (SK… + secret) oppure Auth Token, poi premi **Verifica credenziali**: compaiono il nome dell'account, l'avviso se è un account di prova e i numeri che possiedi.
4. Scegli il numero e premi **Collega il numero automaticamente**: il server imposta su Twilio "A call comes in" → Webhook `https://…/twilio/<SEGRETO>/voce`, HTTP POST. In alternativa copia l'indirizzo e incollalo a mano su Twilio.
5. **Chiamami ora** fa partire una chiamata dal receptionist al tuo cellulare.

Le credenziali stanno in `dati/impostazioni.json` (il token non torna mai al browser); i valori `TWILIO_*` e `URL_PUBBLICO` del `.env` valgono come partenza.

## Pannello admin

Tutto si cambia da `/admin` (con `SEGRETO`: `/admin/<SEGRETO>`) e vale dalla chiamata successiva. I dati stanno in `dati/impostazioni.json` e `dati/appuntamenti.json`.
- **Appuntamenti:** elenco, spostamento e annullamento (anche nei calendari collegati). "Da verificare" = il cliente ha preso un orario già occupato o fuori orario.
- **Attività e Receptionist:** nome, indirizzo, servizi, cosa chiedere a chi prenota, saluto, istruzioni in più.
- **Orari:** fasce per giorno, chiusure straordinarie, durata degli appuntamenti, quanti in contemporanea, preavviso, quanto avanti si prenota. Il receptionist propone solo i posti davvero liberi.
- **Calendari collegati (CalDAV):** Nextcloud, iCloud, Fastmail, Synology, mailbox.org, Zoho, Yahoo, Radicale, Baïkal e ogni server CalDAV, anche più di uno insieme.
  - Si accede con utente e **password per le app**. "Cerca calendari" trova i calendari anche partendo dal solo indirizzo del server; "Prova" legge gli impegni.
  - **Legge** gli impegni dei prossimi giorni, compresi quelli ricorrenti (espansi dal server), e quegli orari non li propone. Si rileggono ogni 5 minuti e subito dopo ogni modifica.
  - **Scrive** ogni appuntamento preso; quando lo **sposti** o lo **annulli** dal pannello, l'evento viene aggiornato o cancellato. Gli eventi scritti dal receptionist hanno UID `…@ai-caller-locale` e non contano come impegni.
  - Google Calendar non accetta password per le app su CalDAV: per Google usa l'abbonamento qui sotto (per vedere gli appuntamenti) e l'indirizzo iCal segreto (per bloccare gli orari).
- **Calendari in sola lettura:**
  - l'indirizzo `/calendario/<SEGRETO>.ics` si aggiunge come abbonamento in Google Calendar, Apple Calendario o Outlook e mostra gli appuntamenti;
  - gli indirizzi iCal privati dei tuoi calendari bloccano gli orari in cui sei impegnato (letti ogni 5 minuti; qui gli eventi ricorrenti contano solo alla prima occorrenza).
- **Email e SMS:** server SMTP (con Gmail: smtp.gmail.com, porta 465 sicura, password per le app). A ogni prenotazione parte un'email al titolare e, se il cliente ha lasciato l'email, la conferma a lui, tutte e due con l'evento allegato. Gli SMS passano da Twilio.

### Con il numero Twilio

1. Metti `SEGRETO` (una stringa casuale lunga) e `URL_PUBBLICO` nel `.env`. Per provare: `cloudflared tunnel --url http://localhost:5050`.
2. Su Twilio, **Phone Numbers → il tuo numero → A call comes in**: Webhook `URL_PUBBLICO/twilio/<SEGRETO>/voce`, **HTTP POST**.
3. La pagina web diventa `URL_PUBBLICO/web/<SEGRETO>` e il pannello `URL_PUBBLICO/pannello/<SEGRETO>`.

## La voce

- La voce predefinita è `voci/receptionist.wav`: un uomo milanese sui 35 anni, naturale e professionale, con l'accento di Milano. Il campione non contiene intercalari ("allora", "ehm"), che il clone tenderebbe a ripetere. È stata creata con Qwen3-TTS VoiceDesign e il motore la clona a ogni frase con il modello Base 0.6B.
- Per crearne un'altra: cambia la descrizione in `motore/disegna-voce.py` e lancia `python3 motore/disegna-voce.py 4`. Ascolta le proposte in `voci/`, poi copia la migliore (5–10 secondi) in `voci/receptionist.wav` e il suo testo in `voci/testo.txt`. Si può usare anche una registrazione vera, con il consenso di chi parla.
- `TTS_TEMPERATURA` (0.3) tiene la voce calma e regolare: più alta = più espressiva e meno prevedibile.
- Senza campione si usano gli speaker di Qwen3-TTS CustomVoice (`TTS_VOCE`), che però hanno un filo di accento straniero.

## Adattarlo alla tua attività

Quasi tutto si fa dal pannello admin. Il modo di parlare (tono, regole, flusso della chiamata) è in `src/persona.mjs`.

## Prove senza telefono

| Comando | Cosa fa |
|---|---|
| `npm run genera-cliente` | crea la voce del cliente di prova (speaker `aiden`) per i copioni `base`, `scorbutico`, `disordine`, `improvvisato` |
| `OUT=chiamata.ulaw node prove/chat-prova.mjs "frase 1" "frase 2"…` | chiamata in chat al server acceso, come dalla pagina web: stampa il dialogo e salva l'audio del receptionist |
| `prove/esegui.sh <nome> [copione]` | telefonata simulata con lo stesso percorso di Twilio: ritardo di ogni risposta e registrazione in `prove/out/<nome>.mp3` |

## Cosa abbiamo misurato (MacBook Apple Silicon, 16 GB)

- Trascrizione: Parakeet v3 ~0,1–0,2 s a frase; faster-whisper `small` su CPU ~1,1 s.
- Claude Code (Haiku, senza ragionamento): primo testo ~0,9–1,7 s.
- Qwen3-TTS 0.6B 8 bit con voce clonata: primo audio ~0,2–0,3 s, circa due volte e mezza più veloce del tempo reale.
- Dalla fine della frase del cliente al primo audio: ~2–2,5 s.
- La trascrizione con MLX costa ~1 s la prima volta che vede una lunghezza nuova: per questo l'audio si arrotonda a blocchi di 2 secondi, preparati all'avvio (~0,1 s a frase).
- Qwen3-TTS 0.6B ogni tanto sbaglia sui frammenti di due o tre parole o non si ferma più: per questo le frasi si mandano intere e l'audio ha un tetto di lunghezza.

## Note

- **Trasparenza.** Il receptionist ammette sempre di essere un'AI se glielo chiedono. Nell'Unione Europea l'AI Act chiede di dirlo subito a chi chiama: per un uso reale aggiungilo al saluto.
- **Privacy.** In `registrazioni/` finiscono i numeri di chi chiama e il testo delle telefonate, quindi vanno trattati secondo il GDPR. L'audio non lascia il Mac; il testo delle frasi passa da Claude Code.
- **Crediti.** Basato su [Henry12034/ai-caller-cosmio](https://github.com/Henry12034/ai-caller-cosmio) di Cosmio (OpenAI Realtime ed ElevenLabs), a sua volta ispirato da [jasonc00person/bland-ai-receptionist](https://github.com/jasonc00person/bland-ai-receptionist).
