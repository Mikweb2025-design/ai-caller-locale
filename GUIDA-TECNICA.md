# Guida tecnica

Come funziona il receptionist AI locale, come avviarlo, come metterlo in sicurezza e come provarlo. Il [README](README.md) (in inglese, con la versione italiana in [README.it.md](README.it.md)) racconta cosa fa; qui c'è il come. Tutto quello che segue descrive il codice com'è oggi.

Indice: [Come funziona](#come-funziona) · [Cosa serve](#cosa-serve) · [Avvio](#avvio) · [Sicurezza](#sicurezza) · [Pannello admin](#pannello-admin-scheda-per-scheda) · [Variabili del .env](#variabili-del-env) · [Prove senza telefono](#prove-senza-telefono) · [Tempi misurati](#tempi-misurati) · [Limiti noti](#limiti-noti) · [File del progetto](#file-del-progetto) · [Crediti](#crediti)

## Come funziona

```
telefono (Twilio) ─┐   μ-law 8 kHz     ┌───────────────────────────────────────────┐
                   ├─ Media Streams ──▶│ server Node (src/, porta 5050)            │
browser (web.mjs) ─┘  (mark, clear)    │  VAD a energia ─▶ fine frase (PCM 8 kHz)  │
                                       │        │                                  │
                                       │        ▼  HTTP :5051                      │
                                       │  motore Python (motore/motore.py)         │
                                       │   /stt  Parakeet v3 (processo a parte)    │
                                       │   /tts  Qwen3-TTS, voce clonata, stream   │
                                       │        │ testo                            │
                                       │        ▼                                  │
                                       │  cervello (cervello.mjs)                  │
                                       │   ├─ Claude Code: claude -p, stream-json  │
                                       │   └─ o servizio compatibile OpenAI        │
                                       │      (+ riserva)                          │
                                       │        │ testo in streaming               │
                                       │        ▼                                  │
                                       │  taglio in frasi ─▶ /tts ─▶ μ-law ─▶ chi  │
                                       │  marcatori <<CONFERMA…>> / <<FINE>>       │
                                       │   ─▶ agenda, calendari, email, SMS        │
                                       └───────────────────────────────────────────┘
```

In breve: **telefono (Twilio) o browser → server Node → motore Python (Parakeet v3 per ascoltare, Qwen3-TTS su MLX per parlare) → cervello (Claude Code o un servizio compatibile OpenAI) → di nuovo la voce.**

### Il percorso dell'audio

1. **Ingresso.** Twilio apre un WebSocket Media Streams verso il server (`/media/tel/<gettone>`); la pagina del browser apre lo stesso protocollo su `/media/web/<SEGRETO>`. L'audio è μ-law a 8 kHz in pacchetti da 20 ms, con gli eventi `mark` (audio riprodotto fino a qui) e `clear` (butta l'audio non ancora riprodotto). Per questo telefono e browser passano per la stessa pipeline, `src/chiamata.mjs`. La pagina web in più riceve la trascrizione e può scrivere al receptionist come in una chat (evento `testo`, al massimo 500 caratteri).
2. **VAD a energia** (in `chiamata.mjs`). Ogni pacchetto da 20 ms viene decodificato in PCM 16 bit e se ne calcola l'energia (RMS).
   - Sopra `VAD_SOGLIA` (700) il pacchetto è "voce". Dopo `VAD_INIZIO_MS` (120 ms) di voce continua il cliente sta parlando; gli ultimi 300 ms precedenti (pre-roll) vengono tenuti, così l'inizio della frase non si perde.
   - La frase finisce dopo `VAD_SILENZIO_MS` (750 ms) di silenzio, oppure dopo 30 secondi. Frasi più brevi di `VAD_MINIMO_MS` (250 ms) più il silenzio finale sono scartate come rumore.
   - Mentre il receptionist sta parlando (ci sono `mark` non ancora tornati) la soglia sale di 1,6 volte e servono `VAD_INTERRUZIONE_MS` (500 ms) di voce continua: l'eco dell'altoparlante o un colpo di tosse non lo zittiscono.
3. **Trascrizione.** La frase (PCM 8 kHz) va al motore con `POST /stt`. Nel motore la trascrizione gira in un **processo separato** (`lavoratore_stt`, avviato con `multiprocessing` in modalità `spawn`), così non aspetta mai che la voce finisca di generare. Il processo porta l'audio a 16 kHz e lo arrotonda a **blocchi di 2 secondi** con silenzio in coda: MLX prepara i calcoli per ogni lunghezza nuova (~1 s la prima volta), quindi le lunghezze più comuni (2, 4 … 20 s) sono preparate all'avvio e dopo costa ~0,1–0,2 s a frase. Il lavoratore si chiude da solo se il motore principale muore (anche con `kill`), perché un processo orfano terrebbe occupati 3–6 GB di memoria. Il modello è Parakeet TDT v3 su MLX (25 lingue europee, sceglie la lingua da solo); in alternativa un modello faster-whisper su CPU, ma forzato sull'italiano.
4. **Filtro.** Il server scarta le trascrizioni vuote o fatte di sola punteggiatura, quelle tipiche del silenzio ("sottotitoli…", "amara.org", "grazie per la visione") e quelle fatte soprattutto di parole inglesi (Parakeet trasforma eco e rumori in frasette come "Yeah, we're here"). Per questo **i clienti che parlano inglese non vengono serviti**.
5. **Cervello.** Il testo della frase va al cervello (sezione sotto). La risposta torna **token per token**.
6. **Taglio delle frasi.** Il testo che arriva viene tagliato per mandarlo alla voce un pezzo alla volta:
   - si taglia a fine frase (`. ! ? … : ;` seguiti da spazio) solo se il pezzo è lungo almeno 20 caratteri, perché Qwen3-TTS 0.6B sui frammenti di due o tre parole ogni tanto sbaglia;
   - se la frase è lunga si taglia alla virgola: oltre 40 caratteri per il primo pezzo della risposta (così si comincia a parlare prima), oltre 90 per i successivi, e la virgola deve stare dopo il trentesimo carattere;
   - da `<<` in poi non si legge niente: i marcatori stanno in fondo alla risposta e si aspetta che finisca.
   Dal testo si tolgono anche i marcatori, le parti tra parentesi quadre e `* _ # \``.
7. **Voce.** Ogni pezzo va a `POST /tts` con la lingua (`it` o `de`, scelta pezzo per pezzo con un riconoscimento a parole chiave: se la frase è troppo corta per decidere resta la lingua di prima). Qwen3-TTS restituisce l'audio a pezzi da 0,25 s mentre lo genera; il server lo converte in μ-law, lo manda a Twilio e dopo ogni pezzo manda un `mark`. Le frasi si leggono in ordine, una alla volta.
8. **Interruzioni.** Se il cliente parla sopra al receptionist, o scrive una nuova frase, il server annulla la sintesi in corso, manda `clear` (l'audio già in coda sparisce) e ignora il resto della risposta di prima.
9. **Fine chiamata.** Dopo `<<FINE>>` il server aspetta che il cliente abbia sentito tutto l'audio (al massimo 15 s), poi altri 600 ms, e riaggancia.

### La voce

- La voce predefinita è `voci/receptionist.wav` (campione di un uomo milanese sui 35 anni, naturale e professionale), con il suo testo in `voci/testo.txt`. È stata creata con **Qwen3-TTS VoiceDesign** (una descrizione a parole, `motore/disegna-voce.py`) e il motore la **clona a ogni frase** con il modello Qwen3-TTS 0.6B Base (8 bit). Il campione non contiene intercalari ("allora", "ehm"), che il clone tenderebbe a ripetere.
- **Un'altra voce progettata.** Cambia `DESCRIZIONE` in `motore/disegna-voce.py` e lancia `python3 motore/disegna-voce.py 4` (quattro proposte, la prima volta scarica il modello da 1,7 B). Ascolta `voci/proposta-N.wav`, copia la migliore (5–10 secondi) in `voci/receptionist.wav` e il testo parlato in `voci/testo.txt`. Attenzione: lo script **riscrive `voci/testo.txt` a ogni esecuzione** con il suo `TESTO` (lo stesso per tutte le proposte), anche se `receptionist.wav` non è cambiato. Dopo aver scelto la proposta, `voci/testo.txt` deve contenere esattamente quello che si sente nel campione copiato: se hai tagliato l'audio, taglia anche il testo; se hai cambiato `TESTO`, il file è già giusto per le proposte nuove ma non per il vecchio `receptionist.wav` finché non lo sostituisci. Se rilanci lo script senza sostituire il campione attivo, rimetti a posto il testo (o salvane una copia prima).
- **Una voce tua.** Registra 5–15 secondi di parlato pulito, senza intercalari, e scrivi esattamente cosa dici. Sostituisci i due file, oppure imposta `TTS_RIF_AUDIO` (wav a 24 kHz) e `TTS_RIF_TESTO` nel `.env`. **Clona solo la voce di chi ha dato il consenso esplicito**, e non presentare a chi chiama una persona vera clonata come se fosse un'altra.
- **Senza campione** si usa uno speaker di Qwen3-TTS CustomVoice (`TTS_VOCE`, predefinito `ryan`), che però ha un filo di accento straniero. Il motore sceglie il modello da solo: Base se esiste `voci/receptionist.wav`, CustomVoice altrimenti (si forza con `TTS_MODELLO`).
- `TTS_TEMPERATURA` (0,6) regola l'espressività: più bassa = più piatta e regolare, più alta = più espressiva e meno prevedibile.
- **Salvagenti contro i difetti del modello.** L'audio di ogni frase ha un tetto di lunghezza (12 passi del codec al secondo, per `testo/8 + 1,5` secondi), altrimenti ogni tanto il modello non si ferma e genera minuti di silenzio o rumore. Con la voce clonata, quando ha già detto praticamente tutto (circa 12 caratteri al secondo) e arriva una pausa di mezzo secondo, la sintesi si ferma. Il motore sintetizza un pezzo alla volta (MLX lavora un pezzo alla volta): le chiamate contemporanee si mettono in coda.
- **Saluto in memoria.** Il saluto (italiano, più quello tedesco se attivo) è sintetizzato all'avvio del server e rifatto quando lo cambi nel pannello. Ogni sintesi viene riascoltata con la trascrizione: se manca qualche parola o la voce è andata avanti a vuoto, si rifà (fino a 4 tentativi) e si tiene la migliore. Se il motore non è ancora acceso, il server riprova ogni 5 secondi.
- **Riempitivo.** Se `RIEMPITIVO_S` è 0 o più e Claude tarda quei secondi, il receptionist dice "Sì, un attimo.". Il predefinito è `-1` (mai): detto spesso suona da centralino.

### Il cervello

Si sceglie nella scheda **Cervello**: un servizio principale e, facoltativo, una riserva. Le istruzioni (`src/persona.mjs`) si rifanno **a ogni chiamata**, con le impostazioni di quel momento e l'elenco dei posti liberi giorno per giorno.

| Servizio | Tipo | Note |
|---|---|---|
| **Claude Code** | `claude -p` in streaming | Modelli `haiku`, `sonnet`, `opus`. Tre modi per accedere: il login già fatto sul computer, un token di `claude setup-token` (`sk-ant-oat…`) o una chiave API Anthropic (`sk-ant-api…`). |
| Groq, Google Gemini, OpenRouter, Cerebras, Mistral, OpenAI, Ollama, IONOS AI Model Hub, "Altro" | compatibili OpenAI | Indirizzo `/v1` e chiave. Ollama è locale e senza chiave. Il pannello propone un modello di partenza e l'elenco vero lo chiede al servizio ("Elenca modelli"). |

- **Claude Code.** Per ogni chiamata resta aperto un solo processo `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --model <modello> --effort <impegno> --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence --system-prompt <istruzioni>`, con `MAX_THINKING_TOKENS=0`: nessuno strumento, nessun MCP, nessuna impostazione di progetto, nessun ragionamento (al telefono sarebbero secondi di silenzio). Per le chiamate Twilio parte mentre il telefono squilla (il server lo avvia appena riceve il webhook e lo tiene in attesa fino a 60 s). Una chiave che comincia con `sk-ant-api` diventa `ANTHROPIC_API_KEY`, qualunque altra `CLAUDE_CODE_OAUTH_TOKEN`.
- **Servizi compatibili OpenAI.** Una richiesta `chat/completions` in streaming per ogni frase del cliente, con tutta la conversazione (temperatura 0,7, massimo 400 token, 30 s di tempo massimo; per i modelli `gpt-oss` si chiede `reasoning_effort: low`). Il "pensiero" scritto tra `<think>…</think>` si filtra e non viene letto. Se arriva una frase nuova, la richiesta precedente viene annullata per risparmiare quota.
- **Riserva automatica.** Se il principale risponde con un errore, raggiunge il limite o non scrive il primo testo entro 9 secondi, risponde la riserva alla stessa frase, con la conversazione fatta fino a lì. Un servizio che ha raggiunto il limite (HTTP 429) viene saltato per 60 secondi; uno con la chiave errata (401, 403) per 10 minuti; se il principale è in pausa, la chiamata parte direttamente dalla riserva. Se non risponde nessuno, chi chiama sente "Mi scusi, ho un problema con la linea. Può richiamare tra qualche minuto?". Se il principale ha già detto qualcosa quando va in errore, il turno si chiude con quello che c'è.
- **Prova una conversazione.** Il pulsante della scheda Cervello fa una conversazione di cinque frasi con le istruzioni vere e controlla che il modello scriva bene `<<CONFERMA|…>>` (data e ora valide, un posto davvero libero) e `<<FINE>>`, che scriva i numeri in lettere, non usi simboli o elenchi e non risponda in inglese. Mostra anche il tempo del primo testo. Non scrive nessun appuntamento.

### Marcatori e azioni

Il modello non ha strumenti: per le azioni scrive dei marcatori in fondo alla risposta, dopo le parole da dire. Il server li toglie dal parlato (il cliente non li sente) e li esegue.

- **`<<CONFERMA|nome|AAAA-MM-GG|HH:MM|dettagli|email>>`**, una volta sola, quando il cliente ha confermato tutto. `nome`, `giorno`, `ora` e `dettagli` sono obbligatori nel prompt; `email` (sesto campo) si aggiunge solo se il cliente l'ha detta di sua iniziativa e solo se nel pannello email e conferma al cliente sono attive: il receptionist non la chiede mai. Il server registra l'appuntamento in `dati/appuntamenti.json` (e una riga in `registrazioni/appuntamenti.jsonl`), lo scrive nei calendari CalDAV con scrittura attiva, manda le email e l'SMS (se attivi). Lo stato è `confermato` se l'orario è davvero libero, `da verificare` se è già occupato o fuori orario.
- **`<<FINE>>`** subito dopo il saluto finale: il server riaggancia dopo l'ultimo audio.

### Lingue

- **L'italiano c'è sempre.** Saluto, voce e prompt sono pensati per l'italiano, con un registro da professionista milanese (chiaro, diretto, senza dialetto).
- **Tedesco, facoltativo** (scheda Receptionist, "Rispondi anche in tedesco"). Il saluto diventa italiano seguito da quello tedesco (modificabile, `{nome}` è il nome del receptionist). Il receptionist risponde **nella lingua di chi chiama**, anche cambiando dentro la stessa telefonata: tedesco standard, formale con "Sie", orari e date in lettere. I dettagli dentro `<<CONFERMA…>>` si scrivono sempre in italiano. La lingua di ogni frase detta si sceglie con il riconoscimento a parole chiave descritto sopra; la voce riceve `it` o `de` frase per frase.
- Un'altra lingua (inglese, francese…): il receptionist non risponde mai in quella lingua, nemmeno una frase. Dice con garbo, in italiano e poi in tedesco (due brevi frasi), che parla solo queste due e offre un richiamo da un collega; se il cliente insiste, ripete solo l'offerta del richiamo. Con il tedesco spento parla solo italiano. Il tedesco funziona solo con Parakeet (faster-whisper è forzato sull'italiano).

### Adattarsi a chi chiama

Le istruzioni dicono al modello di ascoltare come parla il cliente e cambiare il modo, mai la cortesia o la precisione: chi ha fretta riceve risposte cortissime; chi è sgarbato trova calma e cordialità (a volte una battuta leggera), senza prediche; chi è preoccupato (incidente, guasto) trova un tono calmo e vicino, mai battute; chi è arrabbiato non riceve difese né promesse, ma un "lo segno" e l'offerta di un richiamo da una persona; chi divaga viene riportato con garbo a quello che manca; chi è disordinato non si sente richiedere niente di già detto; chi è incerto riceve parole semplici e una domanda facile alla volta; chi dà del tu viene ricambiato, chi dà del Lei no; a chi chiede prezzi, tempi o garanzie si dice con franchezza che non si può dire adesso e chi glielo dirà; a chi vuole vendere qualcosa si risponde breve e si chiude con garbo. Il receptionist non inventa mai prezzi o promesse, e se glielo chiedono ammette sempre di essere un'AI e offre di far richiamare da una persona.

## Cosa serve

- Un Mac con Apple Silicon (MLX). Con 16 GB di RAM va bene. Il motore usa `launchctl` (macOS) per `SPEGNI_SERVIZI`.
- Node.js 20.12 o più recente. Dipendenze npm: solo `ws` e `nodemailer`.
- Python 3.11 o più recente, con `pip install -r motore/requirements.txt` (`mlx-audio`, `faster-whisper`, `numpy`, `scipy`, `soundfile`). Al primo avvio scarica i modelli da Hugging Face (circa 1,5 GB).
- Il cervello: [Claude Code](https://claude.com/claude-code) installato e con accesso fatto (`claude` funziona nel terminale), **oppure** la chiave di un servizio compatibile OpenAI.
- `ffmpeg` nel PATH, solo per le [prove senza telefono](#prove-senza-telefono) (`genera-cliente`, `finto-twilio`).
- Facoltativo, per un numero vero: un account Twilio **non di prova** (in prova Twilio legge un avviso a ogni chiamata), un numero e un indirizzo https pubblico (un VPS, oppure `cloudflared tunnel --url http://localhost:5050`).

## Avvio

```bash
npm install
pip install -r motore/requirements.txt
cp .env.example .env        # i valori predefiniti vanno già bene per provare in locale

npm run motore              # terminale 1: orecchie e voce. Aspetta "Motore vocale pronto"
npm start                   # terminale 2: il server
```

- Apri **http://localhost:5050**, premi Chiama e parla (meglio con le cuffie, altrimenti l'eco dell'altoparlante può interrompere il receptionist), oppure scrivi nella chat.
- Le impostazioni sono su **http://localhost:5050/admin**.
- `GET /salute` dice se il server è acceso e se raggiunge il motore.
- Il motore ascolta solo su `127.0.0.1:5051` (`MOTORE_PORTA`). Se la porta è occupata dice subito che probabilmente c'è già un motore acceso. Si chiude con Ctrl-C, `kill` o chiudendo il terminale, e in uscita riaccende i servizi che aveva spento.
- **`SPEGNI_SERVIZI`.** Appena parte, il motore ferma i servizi launchd elencati (il predefinito sono due altri server Qwen3-TTS del Mac dell'autore, `com.qwen3tts.8091` e `.8092`, che occuperebbero RAM) e li riaccende quando si chiude. Se non esistono non succede niente; `SPEGNI_SERVIZI=` (vuoto) garantisce che non tocchi nulla.

## Sicurezza

- **`SEGRETO`.** Senza, il server presume di essere usato solo in locale. Per un server pubblico imposta `SEGRETO` a una stringa lunga e casuale nel `.env` e riavvia: il pannello passa a `/admin/<SEGRETO>`, la pagina di chiamata a `/web/<SEGRETO>`, il calendario da abbonarsi a `/calendario/<SEGRETO>.ics`, il pannello "fatti chiamare" a `/pannello/<SEGRETO>` e il webhook Twilio a `/twilio/<SEGRETO>/voce`. **Non esporre il pannello senza segreto**: chi conosce l'indirizzo potrebbe leggere i dati dei clienti e cambiare le impostazioni. Il segreto nell'indirizzo protegge tutto; per il webhook Twilio c'è in più la verifica della firma (vedi sotto).
- **Solo localhost, di default.** Il server ascolta su `127.0.0.1` (`HOST`). Con `HOST=0.0.0.0` si apre alla rete locale: da fare solo dietro un proxy https e con `SEGRETO`.
- **Rifiuto di proxy e tunnel senza segreto.** Senza `SEGRETO`, il server risponde 403 (e chiude i WebSocket) a ogni richiesta con un nome `Host` diverso da `localhost`, `127.0.0.1` o `[::1]`, oppure con intestazioni da proxy (`cf-connecting-ip`, `x-forwarded-for`, `x-forwarded-host`, `x-real-ip`, `forwarded`). Così un tunnel o un proxy messi per sbaglio davanti a un server senza segreto non pubblicano il pannello. Se `URL_PUBBLICO` è impostato ma manca `SEGRETO`, all'avvio il server lo scrive in rosso nel terminale e il pannello lo segnala nella scheda Telefono.
- **Firma delle chiamate Twilio (`X-Twilio-Signature`).** Se è impostato l'**Auth Token** primario dell'account, il webhook `/twilio/<SEGRETO>/voce` accetta solo richieste firmate da Twilio e risponde 403 a quelle senza firma o con la firma sbagliata (il motivo finisce nel log del server). Il token si imposta nel campo "Auth Token dell'account" della scheda Telefono o con `TWILIO_AUTH_TOKEN`; se come credenziali usi Account SID e Auth Token (nessuna API Key), vale già quello. La firma è un HMAC-SHA1 in base64 dell'URL pubblico (`URL_PUBBLICO` più percorso e query) seguito dai parametri del POST ordinati per nome: dietro un proxy l'`Host` della richiesta non è affidabile, quindi serve l'indirizzo pubblico; con l'Auth Token ma senza indirizzo pubblico le richieste vengono rifiutate. Si prova l'URL con e senza la porta predefinita. **Senza Auth Token** il webhook accetta chiunque conosca l'indirizzo segreto (come prima): la scheda Telefono lo segnala in giallo, e in verde quando la firma è attiva. Twilio firma sempre con l'Auth Token primario, mai con il secret di una API Key.
- **Gettoni dello stream.** Il WebSocket di Twilio si apre con un gettone monouso (valido 60 s) che il server mette nel TwiML; quello della pagina web usa il `SEGRETO`. Esiste anche il gettone speciale `prova` (`/media/tel/prova`, per `finto-twilio.mjs` e i test locali): vale solo per una connessione diretta da questo computer (indirizzo di origine locale), senza intestazioni di proxy e con `Host` locale, e mai quando sono impostati sia `SEGRETO` sia l'indirizzo pubblico (server esposto).
- **Controlli anti-SSRF (`src/rete.mjs`).** Le richieste verso indirizzi scelti dall'utente passano da `recupera()`: solo `http`/`https`, il nome dell'host viene risolto (tutte le risposte DNS) prima di decidere, ogni salto di reindirizzamento viene ricontrollato (al massimo 5) e l'intestazione `Authorization` non segue un reindirizzamento verso un altro sito. **Importa dal sito** (`privati: false`) rifiuta gli host che puntano a reti private, loopback o link-local (127.0.0.0/8 e 0.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, `::1`, `fc00::/7`, `fe80::/10`, anche in forma IPv4-mapped): bastano risposte DNS miste con un solo indirizzo privato per bloccare. Con `ALLOW_PRIVATE_FETCH=1` il blocco delle reti private si toglie. **CalDAV e iCal** (`privati: true`) ammettono le reti private (un Nextcloud in casa). In ogni caso è rifiutato il server stesso (`localhost:PORTA` o uno dei suoi indirizzi di rete sulla stessa porta).
- **Chiavi.** Chiavi API, token e password stanno in `dati/impostazioni.json` con permessi `600` (la cartella `dati/` è `700`; anche `appuntamenti.json` è `600`): all'avvio e a ogni salvataggio i permessi vengono riportati a questi valori anche se cartella e file esistevano già più aperti. **Non tornano mai al browser**: lasciare vuoto un campo password mantiene quella salvata. `.env` e `dati/` sono nel `.gitignore`. Le credenziali Twilio e `URL_PUBBLICO` del `.env` valgono solo come partenza.
- **Dati personali su disco.** `registrazioni/` contiene i numeri di chi chiama e il testo delle telefonate (un `.log` per chiamata, più `appuntamenti.jsonl`); `dati/appuntamenti.json` le prenotazioni. Vanno trattati secondo il GDPR: decidi per quanto tempo tenerli e cancella quello che non serve. L'audio non viene conservato.
- **Dati che lasciano il Mac.** L'audio no. Il testo della conversazione va al cervello scelto, e dentro ci sono nomi, telefoni ed email dei clienti: con un piano gratuito di alcuni servizi, quel testo può essere usato per addestrare i modelli (è una questione di GDPR da risolvere prima di usarlo con clienti veri). Claude Code a pagamento, una API a pagamento o un Ollama locale evitano o semplificano il problema.
- **Trasparenza e AI Act.** Il receptionist ammette sempre di essere un'AI se glielo chiedono. Nell'Unione Europea l'AI Act chiede di dirlo **all'inizio**: per un uso reale aggiungilo al saluto (scheda Receptionist), per esempio "…Sono Luca, l'assistente virtuale di Lasercamp, mi dica."
- **Voci clonate** solo con il consenso di chi parla.
- Un abbonamento Claude (login o `setup-token`) usato per rispondere a un server pubblico va verificato sui limiti e sulle condizioni d'uso di Anthropic; una chiave API evita la domanda.

## Pannello admin, scheda per scheda

Si apre da `/admin` (con `SEGRETO`: `/admin/<SEGRETO>`) e le modifiche valgono dalla chiamata successiva. I dati stanno in `dati/impostazioni.json` e `dati/appuntamenti.json`. Il pulsante Salva controlla le fasce orarie e la durata degli appuntamenti prima di scrivere.

**Appuntamenti.** L'elenco di quelli presi dal receptionist, con **Sposta** e **Annulla** (anche nei calendari collegati) e la possibilità di mostrare anche passati e annullati. "Da verificare" significa che il cliente ha avuto un orario già occupato o fuori orario: guardalo tu.

**Attività.**
- **Importa dal sito.** Scrivi l'indirizzo e premi *Importa dal sito*. Il server legge **fino a 30 pagine dello stesso dominio**: prima la home e le pagine con nomi come contatti, servizi, prezzi, FAQ, chi siamo, più quelle della `sitemap.xml`; toglie menu e piè di pagina ripetuti e manda il testo (al massimo 120.000 caratteri) a Claude (Sonnet, se il cervello è Claude Code; altrimenti il modello che hai configurato). Prima di leggere, ogni indirizzo e ogni reindirizzamento passano dai [controlli anti-SSRF](#sicurezza). Si ottengono i campi dell'attività, il saluto e una "scheda per il telefono" completa (servizi, materiali e limiti tecnici, contatti, domande frequenti), usando solo quello che c'è sul sito: i prezzi solo se il sito li scrive. Gli orari di apertura si riempiono solo se il sito li indica davvero; il pannello dice anche cosa non ha trovato. La richiesta a Claude passa da `completa()`: se il cervello principale fallisce, prova la riserva (se impostata). Dura circa un minuto. Niente viene salvato finché non controlli i campi e premi Salva.
- **I campi.** Nome, che cos'è, indirizzo, sito, telefono, email, servizi, cosa chiedere a chi prenota (oltre a nome e orario), altre informazioni utili e la **scheda per il telefono**: va nelle istruzioni del modello a ogni chiamata (i primi 8.000 caratteri), quindi puoi correggerla a mano per aggiungere quello che il sito non dice.

**Receptionist.** Nome, genere (per l'italiano "pronto/pronta"), saluto (vuoto = "<attività>, buongiorno! Sono <nome>, mi dica."), istruzioni in più, e le **Lingue**: la casella "Rispondi anche in tedesco" con il suo saluto in tedesco.

**Orari.** Fasce di apertura per ogni giorno (`08:00-12:30, 14:00-18:30`, vuoto = chiuso), chiusure straordinarie (date `AAAA-MM-GG`), e l'agenda: durata dell'appuntamento (5–600 minuti), appuntamenti in contemporanea, preavviso minimo in ore, quanti giorni avanti si può prenotare, quanti orari proporre al cliente. Sotto, l'elenco dei prossimi posti liberi, cioè quello che il receptionist può proporre. I posti si calcolano da orari di apertura, chiusure, appuntamenti già presi (esclusi gli annullati), impegni dei calendari collegati e preavviso, in ora italiana (Europe/Rome).

**Calendari.**
- **CalDAV (lettura e scrittura).** Nextcloud, iCloud, Fastmail, Synology Calendar, mailbox.org, Zoho, Yahoo, Radicale, Baïkal e ogni altro server CalDAV, anche più di uno insieme. Si accede con utente e **password per le app** (non con quella principale). *Cerca calendari* trova i calendari partendo anche dal solo indirizzo del server; *Prova* legge gli eventi come controllo. Per ogni calendario si sceglie se **legge** gli impegni e se **scrive** gli appuntamenti.
  - Legge gli eventi dei prossimi giorni (quanti ne dice "prenotabile fino a", più due), ricorrenti compresi (li espande il server), e quegli orari non li propone. Si rileggono ogni 5 minuti e subito dopo ogni modifica.
  - Scrive ogni appuntamento preso; quando lo **sposti** o lo **annulli** dal pannello, l'evento viene aggiornato o cancellato. Gli eventi scritti dal receptionist hanno UID che finisce con `@ai-caller-locale` e non contano come impegni.
  - Google Calendar non accetta password per le app su CalDAV: per Google usa le due opzioni qui sotto.
- **Abbonamento (sola lettura).** `/calendario/<SEGRETO>.ics` (l'indirizzo è mostrato nella scheda, con il pulsante Copia) si aggiunge come abbonamento in Google Calendar, Apple Calendario o Outlook e mostra gli appuntamenti. Google e Outlook lo ricaricano ogni qualche ora e devono raggiungere il server da internet (`URL_PUBBLICO`).
- **Indirizzi iCal privati (sola lettura).** Incolla uno per riga l'indirizzo segreto iCal dei tuoi calendari (Google "indirizzo segreto in formato iCal", link pubblico di iCloud, ICS pubblicato da Outlook): i loro impegni tolgono i posti liberi. Si leggono ogni 5 minuti; qui gli eventi ricorrenti contano solo alla prima occorrenza. *Verifica calendari* mostra quanti eventi legge e il prossimo.

**Cervello.** Quale servizio risponde alle telefonate (principale) e una riserva facoltativa. Per ognuno: servizio, indirizzo, chiave, modello (con *Elenca modelli*), impegno (basso, medio, alto: basso risponde prima) e *Prova una conversazione*. Dettagli nella sezione [Il cervello](#il-cervello).

**Telefono.** Tutto quello che serve per un numero Twilio vero.
1. Metti `SEGRETO` nel `.env` e riavvia.
2. Rendi il server raggiungibile in https e scrivi l'indirizzo in "Indirizzo pubblico del server".
3. Inserisci Account SID e API Key (SK… più secret) oppure Auth Token, poi premi **Verifica credenziali**: compaiono il nome dell'account, l'avviso se è di prova e i numeri che possiedi.
4. Scegli il numero e premi **Collega il numero automaticamente**: il server imposta su Twilio "A call comes in" sul webhook `https://…/twilio/<SEGRETO>/voce` (HTTP POST). In alternativa copia l'indirizzo e incollalo a mano. Il collegamento automatico vuole un indirizzo `https://`.
5. **Chiamami ora** fa partire una chiamata dal receptionist al tuo cellulare, e il receptionist parla per primo.

Il secret e l'Auth Token non tornano mai al browser. Il campo **Auth Token dell'account** (facoltativo ma consigliato) attiva la verifica della firma delle chiamate in arrivo, vedi [Sicurezza](#sicurezza); sotto i campi la scheda dice se la firma è verificata o no. Lo stream audio torna sullo stesso indirizzo pubblico (host ed eventuale prefisso di percorso), non sull'`Host` della richiesta.

**Email e SMS.**
- **Email (SMTP).** Server, porta, connessione sicura (porta 465), utente, password, mittente (se vuoto, l'utente), a chi avvisare a ogni prenotazione (indirizzi separati da virgola) e se mandare la conferma al cliente che ha lasciato l'email. Con Gmail: `smtp.gmail.com`, porta 465 con "sicura" attiva, password per le app. Le email portano allegato l'evento `.ics`. *Manda email di prova* verifica le impostazioni.
- **SMS.** Con Twilio configurato e "SMS attivi" (oppure `CON_SMS=1` come partenza), al numero di chi ha chiamato arriva un SMS con giorno e ora. Non parte per le chiamate dal browser né se il numero non comincia con `+`.

## Variabili del .env

Il `.env` si legge all'avvio, sia dal server (`process.loadEnvFile`) sia dal motore. Il file `.env.example` le elenca tutte, con un commento. I valori scelti dal pannello (in `dati/impostazioni.json`) hanno la precedenza su quelli del `.env`, che valgono solo come partenza dove indicato.

| Variabile | Predefinito | Cosa fa |
|---|---|---|
| `PORTA` | `5050` | Porta del server |
| `HOST` | `127.0.0.1` | Indirizzo su cui ascolta il server. `0.0.0.0` apre alla rete (solo dietro proxy https e con `SEGRETO`) |
| `SEGRETO` | vuoto | Vuoto = solo localhost (internamente il segreto vale `locale`). Per internet: stringa lunga e casuale, obbligatoria |
| `URL_PUBBLICO` | vuoto | Indirizzo https pubblico, solo per Twilio. Si può impostare anche dal pannello, che ha la precedenza |
| `MOTORE_PORTA` | `5051` | Porta del motore vocale (ascolta sempre su 127.0.0.1) |
| `MOTORE_URL` | `http://127.0.0.1:<MOTORE_PORTA>` | Dove il server trova il motore |
| `CLAUDE_COMANDO` | `claude` | Percorso del comando `claude`, se non è nel PATH |
| `CLAUDE_MODELLO` | `haiku` | Modello di Claude Code; valore di partenza della scheda Cervello |
| `CLAUDE_IMPEGNO` | `low` | Livello di `--effort` (`low`, `medium`, `high`); di partenza per il pannello. `low` dà il primo testo più in fretta |
| `STT_MODELLO` | `mlx-community/parakeet-tdt-0.6b-v3` | Modello di ascolto. Un nome con `/` è un modello MLX; altrimenti è un modello faster-whisper (`small`, `large-v3-turbo`…, su CPU, forzato sull'italiano) |
| `TTS_MODELLO` | vuoto | Vuoto = `mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit` se esiste `voci/receptionist.wav`, altrimenti `…0.6B-CustomVoice-8bit` |
| `TTS_VOCE` | `ryan` | Solo senza campione: speaker CustomVoice (`ryan`, `aiden`, `serena`, `vivian`…) |
| `TTS_TEMPERATURA` | `0.6` | Più bassa = più piatta e regolare, più alta = più espressiva |
| `TTS_ISTRUZIONI` | vuoto | Istruzioni di stile per i modelli CustomVoice |
| `TTS_RIF_AUDIO` | vuoto | Wav a 24 kHz (5–15 s) da clonare. Vuoto = `voci/receptionist.wav`, se il modello è un "Base" |
| `TTS_RIF_TESTO` | vuoto | Cosa si dice nel campione. Vuoto = `voci/testo.txt` |
| `SPEGNI_SERVIZI` | `com.qwen3tts.8091,com.qwen3tts.8092` | Servizi launchd da fermare mentre il motore è acceso, separati da virgola. Vuoto = non tocca niente |
| `VAD_SOGLIA` | `700` | Energia (RMS, 16 bit) sopra cui è voce; alzala con rumore di fondo |
| `VAD_INIZIO_MS` | `120` | Voce continua per dire "sta parlando" |
| `VAD_SILENZIO_MS` | `750` | Silenzio dopo cui il cliente ha finito di parlare |
| `VAD_MINIMO_MS` | `250` | Frasi più corte di così sono rumore |
| `VAD_INTERRUZIONE_MS` | `500` | Voce continua per interrompere il receptionist mentre parla |
| `RIEMPITIVO_S` | `-1` | Se Claude tarda, dopo questi secondi dice "Sì, un attimo." (`-1` = mai) |
| `NOME_RECEPTIONIST` | `Luca` | Nome di partenza; si cambia dal pannello |
| `GENERE_RECEPTIONIST` | `m` | `m` o `f`, di partenza; si cambia dal pannello |
| `TWILIO_NUMERO` | vuoto | Numero che risponde (es. `+15551234567`); di partenza |
| `TWILIO_ACCOUNT_SID` | vuoto | Account SID; di partenza |
| `TWILIO_API_KEY` | vuoto | API Key SID (`SK…`), oppure vuoto se usi l'Auth Token; di partenza |
| `TWILIO_API_SECRET` | vuoto | Secret della API Key oppure Auth Token; di partenza |
| `TWILIO_AUTH_TOKEN` | vuoto | Auth Token primario dell'account: serve a verificare la firma (`X-Twilio-Signature`) delle chiamate in arrivo. Consigliato; di partenza |
| `TWILIO_API_BASE` | `https://api.twilio.com` | Solo per i test: un finto Twilio al posto dell'API vera (`prove/prova-twilio.mjs` e `prove/finto-twilio-api.mjs`, 55 controlli) |
| `ALLOW_PRIVATE_FETCH` | vuoto | `1` = Importa dal sito può leggere anche reti private o locali (il server stesso resta escluso) |
| `DATI_DIR` | `./dati` | Cartella di impostazioni e appuntamenti, per istanze di prova separate che non toccano quelle vere (`registrazioni/` resta dov'è) |
| `CON_SMS` | `0` | `1` = SMS di conferma attivi; di partenza |

## Prove senza telefono

Servono il motore acceso (`npm run motore`) e, per alcune, `ffmpeg`. Tutte tranne `prova-twilio.mjs` e `prova-sicurezza.mjs` (che avviano istanze proprie con dati temporanei) usano il percorso `/twilio/locale/voce` e `/media/web/locale`, quindi **vanno fatte senza `SEGRETO` nel `.env`**.

| Comando | Cosa fa |
|---|---|
| `npm run genera-cliente` (`prove/genera-cliente.mjs`) | crea una volta sola, in `prove/audio-cliente/<copione>/`, l'audio dei clienti di prova (voce `aiden` di Qwen3-TTS, o `VOCE_CLIENTE`) in μ-law 8 kHz, per tutti i copioni di `copione.mjs`. Le frasi già generate non si rifanno |
| `npm run prova` (`prove/esegui.sh prova base`) | avvia il server, fa una telefonata simulata e lo spegne |
| `prove/esegui.sh <etichetta> [copione]` | come sopra con un'etichetta e un copione a scelta. Stampa i ritardi di ogni risposta e salva il log del server in `prove/out/server-<etichetta>.log` e la registrazione in `prove/out/<etichetta>.mp3` (stereo: cliente a sinistra, receptionist a destra) |
| `node prove/finto-twilio.mjs <url> [etichetta] [copione]` | il cliente finto: con il webhook (`http://127.0.0.1:5050/twilio/locale/voce`) fa prima la richiesta che farebbe Twilio, legge il TwiML, apre il WebSocket Media Streams, manda l'audio del cliente in tempo reale, "riproduce" quello del receptionist (con `mark` e `clear` come il telefono) e misura il ritardo di ogni risposta. Scrive `prove/out/<etichetta>.mp3` e `.json` con medio e mediano. Il server deve essere già acceso |
| `OUT=chiamata.ulaw node prove/chat-prova.mjs "frase 1" "frase 2"…` | chiamata in sola chat al server acceso, come dalla pagina web: scrive le frasi una alla volta aspettando che il receptionist finisca, stampa il dialogo e salva l'audio del receptionist in `$OUT` (μ-law, senza intestazione) |
| `node prove/matrice-tono.mjs` | la "matrice del tono": telefonate in chat di 4–6 battute per undici tipi di cliente (`fretta`, `sgarbato`, `preoccupato`, `arrabbiato`, `chiacchierone`, `disordinato`, `incerto`, `informale`, `prezzo`, `fuoritema`, `ia`), tre alla volta. Stampa ogni dialogo con i controlli automatici (cifre, simboli, intercalari vietati, frasi da call center, frasi ripetute, prezzi o tempi inventati, marcatori nel parlato) e gli appuntamenti nuovi; il giudizio sul tono resta a chi legge. `SOLO=fretta,ia` ne sceglie alcuni; `PORTA` e `DATI_DIR` puntano a un'istanza di prova diversa (gli appuntamenti creati finiscono nell'agenda: toglili o usa `DATI_DIR`) |
| `node prove/prova-twilio.mjs` | prova end to end del collegamento Twilio senza account Twilio: avvia il finto Twilio (`finto-twilio-api.mjs`) e un'**istanza separata** del server (porta 5061, `SEGRETO` di prova, dati in una cartella temporanea: non tocca il server vero né `dati/`). Controlla la formula della firma, le credenziali (API Key e Auth Token), il collegamento del numero, il webhook con e senza firma giusta, il WebSocket dello stream, la chiamata in uscita e gli SMS, poi cancella la cartella temporanea e i log delle sue telefonate. Stampa ✓/✗ per ogni controllo |
| `node prove/prova-sicurezza.mjs` | avvia istanze separate del server (porta 5072, `PORTA_PROVA` per cambiarla; dati in una cartella temporanea) e controlla: il gettone `prova` del WebSocket (da locale sì; con `X-Forwarded-For`, `Forwarded` o `Host` esterno no; con `SEGRETO` e URL pubblico mai), le impostazioni vecchie con `personaggio` (si caricano e il campo non viene riscritto), i permessi (`dati/` 700, `impostazioni.json` e `appuntamenti.json` 600 anche se esistevano a 644) e i controlli anti-SSRF di `src/rete.mjs` (indirizzi privati e loopback, DNS con risposte miste, reindirizzamenti, `ALLOW_PRIVATE_FETCH`, CalDAV e iCal in rete locale). Solo l'ultimo controllo legge un sito pubblico vero (lasercamp.it) e vuole la rete |
| `prove/finto-twilio-api.mjs` | non è una prova da sola: un finto Twilio che imita l'API REST (account, numeri, `VoiceUrl`, SMS, chiamate) e il comportamento verso il webhook (POST firmato con l'Auth Token, poi il WebSocket se il TwiML ha `<Stream>`). Lo usa `prova-twilio.mjs`; da riga di comando si avvia da solo e il server lo raggiunge con `TWILIO_API_BASE` |
| `prove/copione.mjs` | non si lancia: contiene le battute dei clienti di prova |

Copioni disponibili (`copione.mjs`): `base` (tagliando, il percorso del video originale), `scorbutico` (cliente sgarbato che chiede se è un robot), `improvvisato` (fuori copione, con domande difficili), `disordine` (dice tutto subito e in disordine), `lasercamp` (eventi con oggetti incisi) e `tedesco` (cliente di lingua tedesca: il receptionist deve rispondere in tedesco; serve la lingua tedesca attiva). I primi quattro sono scritti per l'officina di esempio, le impostazioni predefinite.

`prove/out/` e `prove/audio-cliente/` si rigenerano con questi script e non vanno su GitHub.

## Tempi misurati

Su un MacBook Apple Silicon con 16 GB:

| Passo | Tempo |
|---|---|
| Voce: primo audio di una frase | ~0,2 s |
| Trascrizione | ~0,1–0,2 s a frase |
| Claude: primo testo (`--effort low`) | ~0,65–1,3 s |
| **Totale, dalla fine della frase del cliente al primo audio** | **~1,5–2,5 s** |

Dipendono dalla macchina e da quanto è carica. Il server scrive nel log di ogni chiamata il tempo di ogni passo (`⏱ primo audio … ms dopo la fine della frase`, `🧠 primo testo di Claude dopo … ms`), e `prove/esegui.sh` li riassume.

## Limiti noti

Cosa è stato provato, onestamente:
- telefonate simulate che passano dallo stesso percorso di Twilio (un finto Twilio che apre il WebSocket Media Streams e fa parlare un cliente sintetico), e chiamate e chat dal browser;
- il collegamento Twilio **con un Twilio finto**: `prove/prova-twilio.mjs` (55 controlli: firma, credenziali, collegamento del numero, webhook con e senza firma giusta, stream, chiamata in uscita, SMS);
- il tono per tipo di cliente (`prove/matrice-tono.mjs`, controlli automatici; il giudizio resta a chi legge), le chiamate in sola chat (`prove/chat-prova.mjs`) e la sicurezza (`prove/prova-sicurezza.mjs`);
- i calendari su un **server CalDAV locale (Radicale)**;
- il cervello compatibile OpenAI su un **servizio finto di prova** che imita il protocollo.

Cosa **non** è stato ancora provato:
- un **vero numero Twilio**: il webhook, la verifica della firma, il collegamento automatico del numero e "Chiamami ora" sono provati **solo con un Twilio finto**, non con uno reale (la firma usa la formula documentata da Twilio ma non è mai stata controllata da una richiesta vera);
- un **vero Nextcloud** (o iCloud, Fastmail, Synology…): solo il server CalDAV locale (Radicale);
- i **veri servizi gratuiti** (Groq, Gemini, OpenRouter…) oltre al servizio finto: limiti e comportamento possono essere diversi da quelli descritti.

Limiti noti:
- **Tedesco.** È ancora in fase di prova (nel README il punto è segnato a parte).
- **Frammenti brevi.** Qwen3-TTS 0.6B può sbagliare sulle frasi di due o tre parole: per questo le frasi si mandano intere e l'audio ha un tetto di lunghezza.
- **Una sintesi alla volta.** Il motore sintetizza un pezzo alla volta (MLX lavora un pezzo alla volta): le chiamate contemporanee si mettono in coda.
- **La voce non è un madrelingua perfetto.** È buona e coerente, ma un orecchio italiano attento capisce che è sintetica.
- **Latenza variabile.** I tempi sopra sono quelli misurati sul MacBook di sviluppo. Nei primi log di prova i ritardi erano più lunghi (circa 1,4–4 s dalla fine della frase), prima di `--effort low` e delle altre modifiche; una macchina carica sarà più lenta.
- **I clienti che parlano inglese non vengono serviti** (le trascrizioni che sembrano inglese sono scartate come rumore).
- **Con faster-whisper al posto di Parakeet** la trascrizione è forzata sull'italiano, quindi il tedesco non funziona.
- **Abbonamento Claude su un server pubblico.** Va verificato sui limiti e sulle condizioni d'uso correnti di Anthropic prima di farci affidamento; una chiave API evita la domanda.
- **Eventi ricorrenti negli indirizzi iCal privati** contano solo alla prima occorrenza (CalDAV li espande bene).

## File del progetto

```
src/
  server.mjs         webhook Twilio, pagina web, pannello admin, API, WebSocket, protezione senza SEGRETO
  chiamata.mjs       la pipeline: VAD → trascrizione → cervello → voce, interruzioni, azioni
  cervello.mjs       il cervello: processo Claude Code o servizi compatibili OpenAI, riserva
  voce.mjs           client del motore vocale, codifica μ-law, frasi pronte in memoria
  web.mjs            pagina per chiamare dal browser (microfono + chat)
  persona.mjs        chi è il receptionist, come parla, cosa sa, come va la chiamata
  impostazioni.mjs   impostazioni del pannello (dati/impostazioni.json) e valori predefiniti
  agenda.mjs         posti liberi, appuntamenti, calendari iCal, email di conferma, abbonamento .ics
  caldav.mjs         CalDAV: ricerca, lettura, creazione, spostamento, cancellazione
  sito.mjs           importa dal sito: lettura delle pagine ed estrazione dei dati
  rete.mjs           richieste verso indirizzi scelti dall'utente (sito, CalDAV, iCal) con i controlli anti-SSRF
  admin.mjs          la pagina del pannello admin
  twilio.mjs         Twilio: credenziali, verifica, webhook automatico, SMS, chiamate in uscita
  twilio-stream.mjs  lato Twilio della chiamata: audio, mark, clear, riaggancio, log
  strumenti.mjs      registrazione dell'appuntamento e SMS di conferma
  pannello.mjs       pagina semplice "fatti chiamare" (/pannello/<SEGRETO>)
  config.mjs         lettura del .env e valori di partenza di porta, motore, Claude, VAD
motore/
  motore.py          orecchie (Parakeet v3) e voce (Qwen3-TTS), tutto in locale
  disegna-voce.py    crea i campioni di voce con Qwen3-TTS VoiceDesign
  requirements.txt
prove/               chiamate simulate e misure dei ritardi (vedi sopra)
voci/                il campione della voce (receptionist.wav, testo.txt)
demo/                due telefonate di esempio (mp3)
docs/screenshot/     gli screenshot del README
dati/                impostazioni e appuntamenti (creati all'avvio, fuori da git)
registrazioni/       log delle chiamate (creati all'avvio, fuori da git)
```

Il codice e i commenti sono in italiano (nomi come `chiamata`, `cervello`, `agenda`, `impostazioni`).

Rotte HTTP principali del server: `POST /twilio/<SEGRETO>/voce` (webhook, risponde con il TwiML che apre lo stream; con `?uscita=1` per le chiamate in uscita), `GET /` o `/web/<SEGRETO>` (pagina di chiamata), `GET /admin` o `/admin/<SEGRETO>` (pannello), `/api/<SEGRETO>/…` (API del pannello: impostazioni, appuntamenti, posti, cervello, importazione dal sito, Twilio, CalDAV, email di prova), `GET /calendario/<SEGRETO>.ics`, `/pannello/<SEGRETO>`, `GET /salute`. Se il webhook Twilio fallisce, chi chiama sente un breve messaggio di scuse invece del silenzio.

## Crediti

- Basato su [Henry12034/ai-caller-cosmio](https://github.com/Henry12034/ai-caller-cosmio) di [Cosmio](https://cosmio.it) (nato su OpenAI Realtime ed ElevenLabs), a sua volta ispirato da [jasonc00person/bland-ai-receptionist](https://github.com/jasonc00person/bland-ai-receptionist).
- Ascolto: [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) di NVIDIA, licenza CC-BY-4.0.
- Voce: [Qwen3-TTS](https://huggingface.co/Qwen), Apache-2.0.
- Esecuzione dei modelli su Apple Silicon: [MLX](https://github.com/ml-explore/mlx) e [mlx-audio](https://github.com/Blaizzy/mlx-audio).
- Cervello: [Claude Code](https://claude.com/claude-code) di Anthropic, oppure il servizio compatibile OpenAI che scegli.
- Lasercamp ([lasercamp.it](https://lasercamp.it)) è usato solo come esempio realistico di piccola attività; i dati dell'esempio vengono dal suo sito pubblico.
