# Receptionist AI, tutto in locale

Questo è un fork di [Henry12034/ai-caller-cosmio](https://github.com/Henry12034/ai-caller-cosmio), il receptionist AI di [Cosmio](https://cosmio.it), riscritto per girare interamente sul tuo computer.

English version: [README.md](README.md) · Guida tecnica: [GUIDA-TECNICA.md](GUIDA-TECNICA.md)

🎧 [Ascolta una telefonata](demo/telefonata-lasercamp.mp3) (in italiano, l'esempio Lasercamp qui sotto) · [Una seconda telefonata simulata](demo/telefonata-locale.mp3)

## Indice

1. [Cosa è e cosa fa](#cosa-è-e-cosa-fa)
2. [Perché in locale](#perché-in-locale)
3. [Architettura](#architettura)
4. [Requisiti](#requisiti)
5. [Avvio rapido](#avvio-rapido)
6. [Il pannello admin, scheda per scheda](#il-pannello-admin-scheda-per-scheda)
7. [Il cervello: Claude Code e altri servizi](#il-cervello-claude-code-e-altri-servizi)
8. [Lingue](#lingue)
9. [Calendari](#calendari)
10. [Email e SMS di conferma](#email-e-sms-di-conferma)
11. [Twilio: un numero di telefono vero](#twilio-un-numero-di-telefono-vero)
12. [Importa dal tuo sito](#importa-dal-tuo-sito)
13. [La voce](#la-voce)
14. [Come funziona una telefonata](#come-funziona-una-telefonata)
15. [Come si adatta a chi chiama](#come-si-adatta-a-chi-chiama)
16. [Sicurezza e privacy](#sicurezza-e-privacy)
17. [Esempio completo: Lasercamp](#esempio-completo-lasercamp)
18. [Stato e limiti](#stato-e-limiti)
19. [Struttura del repository](#struttura-del-repository)
20. [Licenza e crediti](#licenza-e-crediti)

## Cosa è e cosa fa

Un receptionist che risponde al telefono per una piccola attività. Saluta chi chiama, capisce cosa gli serve, propone gli appuntamenti liberi, scrive l'appuntamento nel tuo calendario e chiude la chiamata. Il riconoscimento vocale e la voce girano sul tuo Mac; il "cervello" che decide cosa dire è Claude Code per impostazione predefinita, oppure un qualsiasi servizio compatibile OpenAI.

**Le telefonate sono in italiano** (il tedesco è un extra facoltativo, vedi [Lingue](#lingue)). Gli esempi di questo README sono dialoghi italiani veri.

Cosa fa:

- **Risponde a ogni chiamata**, a qualsiasi ora, weekend compresi, senza musichetta d'attesa (il motore vocale gestisce una chiamata alla volta, vedi i limiti).
- **Prende gli appuntamenti.** Propone i primi posti liberi (il numero è configurabile), chiede il nome e quello che serve alla tua attività (per esempio materiale e quantità), ripete il riepilogo e scrive l'appuntamento. Propone solo posti davvero liberi: orari di apertura, appuntamenti già presi e calendari esterni sono tutti presi in considerazione.
- **Parla come una persona.** Frasi brevi, niente elenchi, numeri e date scritti in lettere perché la voce li legga bene. Se chi chiama parla sopra, si ferma e ascolta.
- **Non inventa.** Niente prezzi, tempi o promesse. Quello che non sa lo passa a una persona ("glielo dicono i tecnici").
- **È onesto sul fatto di essere un'AI.** Se glielo chiedono, risponde di sì e offre di far richiamare da una persona.
- **Chiude la chiamata da solo**, ripetendo giorno e ora. Se vuoi, manda anche un'email di conferma e un SMS.

## Perché in locale

- **Niente conto al minuto per la voce nel cloud.** Ascolto e voce girano sul Mac con modelli aperti (Parakeet v3, Qwen3-TTS su MLX). L'unica cosa che può uscire dal computer è il testo della conversazione, mandato al cervello che scegli.
- **L'audio non lascia mai il Mac.** Con Claude Code o con una API a pagamento esce solo il testo trascritto. Con il piano gratuito di alcuni servizi, nomi e telefoni dei clienti passano da quel servizio, e questo conta per il GDPR (vedi [Sicurezza e privacy](#sicurezza-e-privacy)).
- **Tutto si può modificare.** Tono, regole e svolgimento della chiamata stanno in un solo file (`src/persona.mjs`); il resto è un piccolo server Node e un piccolo motore Python. Nessun framework, due dipendenze npm (`ws`, `nodemailer`).

## Architettura

```
                        ┌──────────────────────────────────────────────────────┐
 telefono (Twilio) ─┐   │ server Node  (src/, porta 5050)                       │
   μ-law 8 kHz      │   │                                                      │
   Media Streams    ├──▶│  VAD (energia)  ──▶  fine frase                      │
                    │   │                         │ PCM 8 kHz                  │
 browser ───────────┘   │                         ▼                            │
   microfono / chat     │               ┌───────────────────┐  HTTP :5051      │
   (stesso protocollo)  │               │ motore Python     │◀────────────────┐│
                        │               │ motore/motore.py  │                 ││
                        │               │ /stt  Parakeet v3 │  (MLX, GPU Apple)││
                        │               │ /tts  Qwen3-TTS   │                 ││
                        │               └───────────────────┘                 ││
                        │                         │ testo                     ││
                        │                         ▼                           ││
                        │  cervello (src/cervello.mjs)                        ││
                        │   ├─ Claude Code: `claude -p` stream-json           ││
                        │   └─ oppure una API compatibile OpenAI (+ riserva)  ││
                        │                         │ testo in streaming        ││
                        │                         ▼                           ││
                        │  taglio in frasi ──▶ /tts ──▶ μ-law ──▶ chi chiama ─┘│
                        │  marcatori <<CONFERMA…>> / <<FINE>> ──▶ agenda, email│
                        └──────────────────────────────────────────────────────┘
```

In breve: **telefono (Twilio) o browser → server Node → motore Python (Parakeet v3 per ascoltare, Qwen3-TTS su MLX per parlare) → cervello (Claude Code, oppure un servizio compatibile OpenAI) → di nuovo la voce.**

Punti chiave:

- **Un solo protocollo.** Twilio e la pagina del browser parlano lo stesso protocollo Media Streams (μ-law 8 kHz, `mark`, `clear`), quindi passano per la stessa pipeline in `src/chiamata.mjs`. La pagina del browser mostra anche la trascrizione e permette di scrivere al receptionist come in una chat.
- **Motore in un processo a parte.** La trascrizione gira in un processo proprio, così non aspetta mai che la voce finisca di generare.
- **Nessuno strumento per il cervello.** Il modello non può chiamare niente. Per fissare un appuntamento o riagganciare scrive dei marcatori in fondo alla risposta, che il server esegue e chi chiama non sente mai.

## Requisiti

| | |
|---|---|
| Computer | Mac con Apple Silicon (MLX). 16 GB di RAM bastano. |
| Node.js | 20.12 o più recente |
| Python | 3.11 o più recente, con `pip install -r motore/requirements.txt` (`mlx-audio`, `faster-whisper`, `numpy`, `scipy`, `soundfile`). Il primo avvio scarica i modelli da Hugging Face (circa 1,5 GB). |
| Cervello | [Claude Code](https://claude.com/claude-code) installato e con accesso fatto (`claude` funziona nel terminale), **oppure** la chiave API di un altro servizio, vedi sotto |
| ffmpeg | Nel PATH, **solo per le prove senza telefono** (`prove/genera-cliente.mjs` e `prove/finto-twilio.mjs`); per usare il receptionist non serve |
| Facoltativo | Un account Twilio e un indirizzo https pubblico (va bene un Cloudflare Tunnel), solo se vuoi un numero di telefono vero |

## Avvio rapido

```bash
npm install
pip install -r motore/requirements.txt
cp .env.example .env        # i valori predefiniti vanno bene per una prova in locale

npm run motore              # terminale 1: orecchie e voce. Aspetta "Motore vocale pronto"
npm start                   # terminale 2: il server
```

- Apri **http://localhost:5050**, premi il pulsante Chiama e parla (meglio con le cuffie, altrimenti l'eco dell'altoparlante può interrompere il receptionist), oppure scrivi nella chat.
- Le impostazioni sono su **http://localhost:5050/admin**.
- **Senza `SEGRETO` il server è solo per questo computer.** Ascolta su `127.0.0.1` (`HOST`) e risponde 403 a ogni richiesta con un nome `Host` diverso da `localhost`, `127.0.0.1` o `[::1]`, o con intestazioni di proxy o tunnel (`X-Forwarded-For`, `CF-Connecting-IP`…). Per usarlo da internet serve un `SEGRETO` lungo e casuale e un proxy https davanti (vedi [Sicurezza](#sicurezza-e-privacy)).

![Una chiamata di prova dal browser, con la chat](docs/screenshot/chiamata-browser.png)

Una telefonata simulata, che passa esattamente dallo stesso percorso di Twilio (il motore deve essere acceso):

```bash
npm run genera-cliente      # una volta: crea la voce del cliente di prova
npm run prova               # lancia prove/esegui.sh: avvia il server, fa una chiamata, stampa i ritardi
```

Le opzioni principali del `.env`:

| Variabile | Predefinito | Significato |
|---|---|---|
| `PORTA` | `5050` | Porta del server |
| `HOST` | `127.0.0.1` | Indirizzo su cui ascolta il server. `0.0.0.0` apre alla rete: solo dietro un proxy https e con `SEGRETO` |
| `SEGRETO` | vuoto | Vuoto = solo localhost (rifiuta `Host` non locali e proxy/tunnel). Per internet è **obbligatorio**: stringa lunga e casuale (vedi [Sicurezza](#sicurezza-e-privacy)) |
| `URL_PUBBLICO` | vuoto | Indirizzo https pubblico, solo per Twilio |
| `DATI_DIR` | `./dati` | Cartella di impostazioni e appuntamenti; per istanze di prova separate |
| `MOTORE_PORTA` / `MOTORE_URL` | `5051` / `http://127.0.0.1:<MOTORE_PORTA>` | Porta del motore vocale e indirizzo con cui il server lo raggiunge |
| `CLAUDE_MODELLO` | `haiku` | Modello di Claude (`haiku` è il più pronto al telefono) |
| `CLAUDE_IMPEGNO` | `low` | Livello di `--effort`; `low` dà il primo testo più in fretta |
| `STT_MODELLO` | `mlx-community/parakeet-tdt-0.6b-v3` | Oppure un modello faster-whisper (`small`, `large-v3-turbo`, ...) |
| `TTS_TEMPERATURA` | `0.6` nel codice | Più bassa = voce più piatta e regolare, più alta = più espressiva e meno prevedibile |
| `TTS_TOP_P` / `TTS_TOP_K` | `0.92` / `40` | Mantengono variazioni naturali escludendo le cadenze meno probabili |
| `TTS_RIPETIZIONE` | `1.08` | Riduce ripetizioni, balbettii e code vocali |
| `VAD_SOGLIA` | `700` | Energia sopra cui è voce (alzala con rumore di fondo) |
| `VAD_SILENZIO_MS` | `750` | Silenzio dopo cui chi chiama ha finito |
| `VAD_INIZIO_MS` / `VAD_MINIMO_MS` | `120` / `250` | Voce continua per dire "sta parlando" / frasi più corte di così sono rumore |
| `VAD_INTERRUZIONE_MS` | `500` | Voce continua per interrompere il receptionist mentre parla |
| `RIEMPITIVO_S` | `-1` | Se Claude tarda questi secondi, dice "Sì, un attimo." (`-1` = mai) |
| `TTS_ISTRUZIONI` | vuoto | Istruzioni di stile, solo per i modelli CustomVoice (senza campione di voce) |
| `TWILIO_AUTH_TOKEN` | vuoto | Auth Token primario dell'account: verifica la firma delle chiamate Twilio in arrivo (vedi [Twilio](#twilio-un-numero-di-telefono-vero)) |
| `TWILIO_API_BASE` | `https://api.twilio.com` | **Solo per i test**: un finto Twilio al posto dell'API vera (`prove/finto-twilio-api.mjs`) |
| `ALLOW_PRIVATE_FETCH` | vuoto | `1` = l'importazione dal sito può leggere indirizzi privati o locali (vedi [Importa dal tuo sito](#importa-dal-tuo-sito)) |
| `NOME_RECEPTIONIST` / `GENERE_RECEPTIONIST` | `Luca` / `m` | Valori di partenza; si cambiano anche dal pannello |

Altre variabili (`TWILIO_NUMERO`, `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `STT_MODELLO`, `TTS_MODELLO`, `TTS_VOCE`, `SPEGNI_SERVIZI`, `CON_SMS`…) e i valori predefiniti letti dal codice sono nella [guida tecnica](GUIDA-TECNICA.md#variabili-del-env); `.env.example` le elenca con un commento. Quasi tutto quello che riguarda l'attività si modifica nel pannello admin e si salva in `dati/impostazioni.json`.

> `motore.py` ferma anche i servizi launchd elencati in `SPEGNI_SERVIZI` finché è acceso e li riavvia quando si chiude (la lista predefinita sono altri due server Qwen3-TTS sul Mac dell'autore). Se non ne hai, non succede niente; imposta `SPEGNI_SERVIZI=` per essere sicuro che non tocchi nulla.

## Il pannello admin, scheda per scheda

Tutto si modifica da `/admin` (o `/admin/<SEGRETO>`), e le modifiche valgono dalla chiamata successiva. I dati stanno in `dati/impostazioni.json` e `dati/appuntamenti.json`.

| Scheda | Cosa fa |
|---|---|
| **Appuntamenti** | Gli appuntamenti presi dal receptionist, con **Sposta** e **Annulla** (anche nei calendari collegati). "Da verificare" significa che chi chiama ha avuto un orario già occupato o fuori orario: guardalo tu. In cima stanno anche i **richiami promessi** ("un collega la richiamerà"): nome, telefono e motivo; quando li hai richiamati premi **Fatto**. |
| **Attività** | Nome, indirizzo, telefono, email, servizi, cosa chiedere a chi prenota, la "scheda per il telefono" (tutto quello che il receptionist deve sapere). Qui c'è il riquadro **Importa dal sito**. |
| **Design** | Logo, colore di accento e tema delle pagine per chiamare dal browser e del pannello "Fatti chiamare", con un'**anteprima** mentre li cambi. Vuoto = l'aspetto di partenza. Si riempiono da soli con **Importa dal sito** o col pulsante **Prendi logo e colore dal sito** (legge solo la home). |
| **Receptionist** | Nome, genere (per l'italiano "pronto/pronta"), saluto, istruzioni in più, tedesco sì/no. |
| **Orari** | Orari di apertura per giorno, chiusure straordinarie, durata dell'appuntamento, quanti in contemporanea, preavviso minimo, quanto avanti si prenota, quanti posti proporre e l'elenco dei prossimi posti liberi. |
| **Calendari** | Account CalDAV, l'abbonamento, gli indirizzi iCal privati che bloccano gli orari. |
| **Cervello** | Quale servizio risponde alle telefonate, una riserva facoltativa e il pulsante di prova. |
| **Telefono** | Credenziali Twilio, webhook automatico, chiamata di prova. |
| **Email e SMS** | Impostazioni SMTP, chi viene avvisato, conferma al cliente, SMS sì/no. |

**Appuntamenti**

![Elenco degli appuntamenti con Sposta e Annulla](docs/screenshot/admin-appuntamenti.png)

**Attività: importa dal sito.** Scrivi l'indirizzo del sito; il receptionist ne legge fino a 30 pagine e Claude estrae quello che serve al telefono, senza inventare quello che non c'è. I campi si riempiono e li controlli prima di salvare.

![Importa dal sito: i dati dell'attività estratti in automatico](docs/screenshot/admin-attivita.png)

**Orari e posti liberi**

![Orari di apertura, impostazioni dell'agenda e prossimi posti liberi](docs/screenshot/admin-orari.png)

**Calendari** (CalDAV, in lettura e scrittura, più le opzioni in sola lettura)

![Un calendario CalDAV collegato in lettura e scrittura](docs/screenshot/admin-calendari.png)

**Telefono** (Twilio)

![Credenziali Twilio, webhook e collegamento automatico del numero](docs/screenshot/admin-telefono.png)

Le schede Receptionist, Cervello ed Email e SMS non hanno ancora uno screenshot; sono semplici moduli, descritti nelle sezioni qui sotto.

## Il cervello: Claude Code e altri servizi

Il "cervello" è il servizio che capisce chi chiama e scrive le risposte. Lo scegli nella scheda **Cervello**. C'è un cervello principale e una **riserva** facoltativa.

| Servizio | Tipo | Note |
|---|---|---|
| **Claude Code** | `claude -p` in streaming | Tre modi per accedere: il login già fatto sul computer (non serve inserire niente); un token di `claude setup-token` (`sk-ant-oat…`) incollato nel pannello; oppure una chiave API Anthropic (`sk-ant-api…`). Modelli: `haiku`, `sonnet`, `opus`. |
| Groq | compatibile OpenAI | Chiave gratuita su console.groq.com. I limiti gratuiti sono circa 30 richieste al minuto. |
| Google Gemini | compatibile OpenAI | Chiave gratuita su aistudio.google.com. Il piano gratuito ha pochissime richieste al giorno: meglio come riserva. |
| OpenRouter | compatibile OpenAI | Modelli `:free`. Senza credito circa 50 richieste al giorno; con una ricarica una tantum di 10 USD, 1.000. |
| Cerebras | compatibile OpenAI | Può chiedere una carta prima di sbloccare il credito gratuito. |
| Mistral | compatibile OpenAI | Il piano gratuito chiede la verifica del telefono. |
| OpenAI | compatibile OpenAI | Solo chiave API a pagamento. |
| Ollama | compatibile OpenAI | Locale, gratuito, senza chiave; i modelli locali sono più lenti, meglio come ultima riserva. |
| IONOS AI Model Hub | compatibile OpenAI | Token del tuo contratto IONOS. |
| Altro | compatibile OpenAI | Qualsiasi servizio con un indirizzo `/v1` e una chiave. |

Come si comporta:

- **Claude Code** tiene aperto per tutta la telefonata un solo processo `claude -p --input-format stream-json --output-format stream-json --include-partial-messages`: nessuno strumento, nessun MCP, nessuna impostazione di progetto, ragionamento disattivato, con le istruzioni di `persona.mjs` come system prompt. Per le chiamate Twilio parte mentre il telefono sta ancora squillando.
- **I servizi compatibili OpenAI** ricevono una richiesta in streaming per ogni frase di chi chiama, con tutta la cronologia della conversazione. I modelli che scrivono il loro ragionamento dentro `<think>…</think>` vengono filtrati, così non viene mai letto ad alta voce.
- **Riserva automatica.** Se il cervello principale restituisce un errore, raggiunge il limite o non scrive il primo testo entro 9 secondi, la riserva risponde alla stessa frase, con la conversazione fatta fino a lì. Un servizio che ha raggiunto il limite viene saltato per 60 secondi; uno con la chiave sbagliata per 10 minuti. Se non risponde nessuno, chi chiama sente un breve scusa e la richiesta di richiamare.
- **Pulsante di prova.** "Prova una conversazione" fa una conversazione di prova di cinque frasi con le istruzioni vere e controlla che il cervello scriva correttamente i marcatori `<<CONFERMA|…>>` e `<<FINE>>`, scelga un giorno davvero libero, scriva i numeri in lettere, non usi simboli e resti in italiano. Mostra anche il tempo del primo testo. Non viene scritto nessun appuntamento.
- L'elenco dei modelli viene chiesto al servizio, quindi non devi scrivere i nomi a mano.

**Avvertenze oneste**

- **I limiti gratuiti cambiano spesso.** I numeri qui sopra sono quelli scritti nell'app e il mese prossimo possono essere superati. Controlla la pagina del servizio prima di fare affidamento su un piano gratuito.
- **Non si può collegare un account "chat" gratuito di ChatGPT o Gemini.** Sono prodotti diversi dalla API. Serve una chiave API (che può avere un piano gratuito, oppure no).
- **Piani gratuiti e dati dei clienti.** Con un piano gratuito, nomi, telefoni ed email detti durante le chiamate vanno a quel servizio, e alcuni piani gratuiti possono usare i dati per addestrare i modelli (Gemini fuori dall'UE, piano gratuito di Mistral). È una questione di GDPR a cui devi rispondere prima di usarlo con clienti veri. Claude Code a pagamento, una API a pagamento o un Ollama locale evitano il problema o lo rendono più semplice.

## Lingue

- **L'italiano c'è sempre.** Il saluto, la voce e il prompt sono pensati per l'italiano, con un registro da "professionista milanese" (chiaro, diretto, senza dialetto).
- **Tedesco, facoltativo.** Nella scheda **Receptionist** spunta "Rispondi anche in tedesco". Il saluto diventa italiano seguito da tedesco, e il receptionist risponde **nella lingua di chi chiama**, anche cambiando dentro la stessa telefonata. Il tedesco è formale ("Sie"), numeri e date sono scritti in lettere. Il testo dentro il marcatore di prenotazione è sempre scritto in italiano. Parakeet v3 riconosce 25 lingue europee, e alla voce si dice frase per frase in che lingua parlare.
- Qualunque altra lingua: il receptionist dice con garbo (in italiano e in tedesco) che parla solo queste due e offre il richiamo di un collega. Le trascrizioni che sembrano inglese vengono scartate come rumore, perché il riconoscitore tende a inventare frasette inglesi dall'eco e dal silenzio, quindi **i clienti che parlano inglese non vengono serviti**.

Il tedesco è ancora in fase di prova, vedi [Stato e limiti](#stato-e-limiti).

## Calendari

I posti liberi si calcolano da orari di apertura, appuntamenti già presi e dai tuoi calendari.

**CalDAV (lettura e scrittura).** Nextcloud, iCloud, Fastmail, Synology Calendar, mailbox.org, Zoho, Yahoo, Radicale, Baïkal e qualsiasi altro server CalDAV, anche più di uno insieme.

- Si accede con un nome utente e una **password per le app** (non la password principale). "Cerca calendari" trova i calendari partendo dal solo indirizzo del server; "Prova" legge gli eventi come controllo.
- **Legge** gli eventi dei prossimi giorni, ricorrenti compresi (espansi dal server), e quegli orari non li propone. Si rileggono ogni 5 minuti e subito dopo ogni modifica.
- **Scrive** ogni appuntamento che prende. Quando **sposti** o **annulli** un appuntamento nel pannello, l'evento viene aggiornato o cancellato nel calendario. Gli eventi scritti dal receptionist hanno un UID che finisce con `@ai-caller-locale` e non contano come tempo occupato.
- Google Calendar non accetta password per le app su CalDAV, quindi per Google usa le due opzioni qui sotto.

**Opzioni in sola lettura**

- **Abbonamento.** `/calendario/<SEGRETO>.ics` si può aggiungere come abbonamento in Google Calendar, Apple Calendario o Outlook e mostra gli appuntamenti. Google e Outlook ricaricano i calendari in abbonamento ogni qualche ora e devono raggiungere il tuo server da internet.
- **Indirizzi iCal privati.** Incolla l'indirizzo iCal segreto dei tuoi calendari (Google "indirizzo segreto in formato iCal", link pubblico di iCloud, ICS pubblicato da Outlook), uno per riga: i loro eventi tolgono i posti liberi. Si leggono ogni 5 minuti; qui gli eventi ricorrenti contano solo alla prima occorrenza.

## Email e SMS di conferma

- **Email (SMTP).** Imposta server, porta, utente e password nella scheda **Email e SMS** (Gmail: `smtp.gmail.com`, porta 465 con "sicura" attiva, una password per le app). Nella stessa scheda trovi tre opzioni:
  - **Manda la conferma al cliente**: a ogni prenotazione parte un'email al titolare (sempre, se l'indirizzo è impostato) e, se il cliente ha lasciato l'email, una conferma anche a lui (entrambe con allegato `.ics`).
  - **Chiedi l'email al cliente alla fine della prenotazione**: il receptionist, prima di salutare, chiede "Le mando la conferma per email, quale indirizzo?" e lo segna nell'appuntamento. Disattivo (predefinito): la chiamata resta normale e l'email viene usata solo se il cliente la dice da solo.
  - **Manda l'email di conferma a ogni prenotazione (link Sì/No)**: il cliente riceve subito un'email con i pulsanti *Sì, confermo* / *Non posso venire*; l'esito compare nel pannello. Disattivo: niente email automatiche, ma puoi sempre chiederla dopo dalla scheda **Appuntamenti**.
  Il receptionist non chiede l'email se non con l'opzione qui sopra.
- **SMS.** Con Twilio configurato e "SMS attivi" spuntato (oppure `CON_SMS=1`), al numero di chi ha chiamato arriva un SMS con giorno e ora.
- **Chiedere al cliente di confermare.** Nella scheda **Appuntamenti** il pulsante **✉️ Chiedi conferma** (su una riga, o su tutti i prossimi) manda al cliente un'email con due pulsanti: *Sì, confermo* e *Non posso venire*. Il cliente risponde con un clic e l'esito compare accanto all'appuntamento ("confermato dal cliente", "non può venire: richiamalo"). I link usano l'indirizzo pubblico del server (scheda Telefono): senza, l'email chiede di rispondere per confermare.

## Twilio: un numero di telefono vero

Per un numero vero serve un account Twilio **non di prova** (un account di prova legge un avviso a ogni chiamata), un numero e il server raggiungibile in https (un VPS, oppure `cloudflared tunnel --url http://localhost:5050`). Si fa tutto nella scheda **Telefono**:

1. Metti `SEGRETO` (una stringa lunga e casuale) nel `.env` e riavvia: il pannello diventa `/admin/<SEGRETO>`.
2. Inserisci l'indirizzo pubblico del server.
3. Inserisci l'Account SID e una API Key (SK… più secret) oppure l'Auth Token, poi premi **Verifica credenziali**: mostra il nome dell'account, se è un account di prova e i numeri che possiedi. Compila anche **Auth Token dell'account** (vedi sotto): serve l'Auth Token **primario** dell'account anche se per le chiamate all'API usi una API Key.
4. Scegli il numero e premi **Collega il numero automaticamente**: il server imposta su Twilio "A call comes in" sul webhook `https://…/twilio/<SEGRETO>/voce` (HTTP POST). Oppure copia l'indirizzo e incollalo a mano.
5. **Chiamami ora** fa chiamare il tuo cellulare dal receptionist, che parla per primo.

Le credenziali sono salvate in `dati/impostazioni.json`; il secret e l'Auth Token non vengono mai rimandati al browser. `TWILIO_*` e `URL_PUBBLICO` nel `.env` sono solo valori di partenza.

**Firma delle chiamate (`X-Twilio-Signature`).** Con l'Auth Token impostato (campo del pannello o `TWILIO_AUTH_TOKEN`; se come credenziali usi Account SID e Auth Token vale già quello) il webhook accetta solo richieste firmate da Twilio e risponde 403 alle altre. Twilio firma sempre con l'Auth Token primario, mai con il secret di una API Key. La firma si calcola sull'indirizzo pubblico, quindi **se c'è l'Auth Token ma manca l'indirizzo pubblico le richieste vengono rifiutate**. **Senza Auth Token** la richiesta passa (basta conoscere l'indirizzo con il segreto) e la scheda Telefono lo segnala.

## Importa dal tuo sito

Nella scheda **Attività**, scrivi l'indirizzo del sito dell'attività e premi **Importa dal sito**.

- Legge **fino a 30 pagine dello stesso dominio**: prima la home e le pagine con nomi come contatti, servizi, prezzi, FAQ, chi siamo, e quelle elencate in `sitemap.xml`. Menu e piè di pagina ripetuti su ogni pagina vengono tolti.
- Il testo viene mandato a Claude (Sonnet quando il cervello è Claude Code; altrimenti il modello che hai configurato), che restituisce i campi dell'attività, il **saluto** e una **scheda per il telefono** completa (servizi, materiali e limiti tecnici, contatti, FAQ), usando solo quello che c'è sul sito. I prezzi sono inclusi solo se il sito li dichiara. Se il cervello principale fallisce, la richiesta passa alla riserva (se l'hai impostata).
- Gli orari di apertura si riempiono **solo se il sito li indica davvero**. Il pannello ti dice anche cosa non ha trovato.
- Oltre ai dati del telefono, dalla home prende **logo e colore principale del sito** (`og:image` o l'icona; il `theme-color` o il colore più usato nei fogli di stile) e li porta nella scheda **Design**, che cambia l'aspetto della pagina per chiamare dal browser e del pannello "Fatti chiamare". Se non li trova, quelle schede restano come sono.
- Non viene salvato niente finché non controlli i campi e premi **Salva**.
- **Controllo anti-SSRF:** prima di leggere, ogni indirizzo (e ogni salto di reindirizzamento, al massimo 5) viene controllato: solo `http` e `https`, il nome dell'host viene risolto (tutte le risposte DNS) e se punta a una rete privata, locale o link-local (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, `::1`, `fc00::/7`, `fe80::/10`) l'importazione si ferma con un errore chiaro. Così il pulsante non si può usare per far leggere al server pagine della tua rete interna o i servizi dei metadati cloud. Con `ALLOW_PRIVATE_FETCH=1` nel `.env` il blocco delle reti private si toglie (per importare da un sito interno); il server stesso (`localhost:PORTA`) resta comunque escluso. Gli indirizzi CalDAV e iCal, invece, possono stare nella tua rete (un Nextcloud in casa), ma passano dagli stessi controlli su schema e reindirizzamenti e non possono mai puntare al server stesso.

La scheda per il telefono finisce nelle istruzioni del modello a ogni chiamata (i primi 8.000 caratteri), quindi puoi correggerla a mano per aggiungere quello che il sito non dice.

## La voce

- La voce predefinita è `voci/receptionist.wav`: un uomo milanese di circa 35 anni, naturale e professionale, con `voci/testo.txt` come trascrizione. È stata **progettata con Qwen3-TTS VoiceDesign** (una descrizione a parole della voce, `motore/disegna-voce.py`) e poi **clonata a ogni frase** dal modello Qwen3-TTS 0.6B Base. Il campione non contiene intercalari ("allora", "ehm") perché il clone tenderebbe a ripeterli.
- **Sostituirla con un'altra voce progettata.** Cambia la descrizione in `motore/disegna-voce.py` e lancia `python3 motore/disegna-voce.py 4` (quattro proposte). Ascolta `voci/proposta-N.wav` e copia la migliore (da 5 a 10 secondi) in `voci/receptionist.wav`. **Attenzione:** lo script **riscrive `voci/testo.txt` a ogni esecuzione** con il suo testo di esempio (la variabile `TESTO` dello script, lo stesso per tutte le proposte), anche se `receptionist.wav` non è cambiato. Dopo aver scelto la proposta, `voci/testo.txt` deve contenere esattamente quello che si sente nel campione che hai copiato: se hai tagliato l'audio, taglia anche il testo; se hai cambiato `TESTO`, il file è già giusto per le proposte nuove ma non per il vecchio `receptionist.wav` finché non lo sostituisci. Se rilanci lo script senza sostituire il campione attivo, rimetti a posto il testo (o salvane una copia prima).
- **Clonare una voce tua.** Registra da 5 a 15 secondi di parlato pulito, senza intercalari, e scrivi esattamente quello che dici. Sostituisci i due file qui sopra, oppure imposta `TTS_RIF_AUDIO` (un wav a 24 kHz) e `TTS_RIF_TESTO` nel `.env`. **Clona una voce solo con il consenso esplicito di chi parla**, e non presentare a chi chiama una persona vera clonata come se fosse un'altra.
- Senza un campione il motore usa uno speaker CustomVoice incorporato di Qwen3-TTS (`TTS_VOCE`), che ha un leggero accento straniero.
- `TTS_TEMPERATURA` regola quanto è espressiva.

## Come funziona una telefonata

1. **Saluto.** Viene sintetizzato una volta sola e tenuto in memoria, così parte subito. Claude si avvia in background (per Twilio, mentre il telefono squilla).
2. **Ascolto (VAD).** Un semplice rilevatore a energia sul server decide quando chi chiama ha finito: `VAD_SILENZIO_MS` (750 ms) di silenzio chiude la frase, che va al motore per la trascrizione. I suoni molto brevi sono trattati come rumore.
3. **Trascrizione.** Parakeet v3 su MLX. Le trascrizioni che sembrano allucinazioni da silenzio o eco inglese vengono scartate.
4. **Risposta, in streaming.** Il testo di Claude arriva token per token. Appena c'è una frase intera (almeno 20 caratteri), o una virgola in una frase lunga, va a Qwen3-TTS, che restituisce l'audio a pezzi mentre lo genera. Le frasi si mandano intere perché il modello da 0,6 B può sbagliare sui frammenti di due o tre parole.
5. **Interruzioni.** Se chi chiama parla sopra al receptionist, il server svuota l'audio già in coda (`clear`), ferma la sintesi e ignora il resto della risposta. Mentre il receptionist parla, per interromperlo serve una voce più forte e più lunga, così l'eco dell'altoparlante o un colpo di tosse non lo zittiscono.
6. **Markers.** Il modello non ha strumenti. In fondo alla risposta scrive `<<CONFERMA|nome|AAAA-MM-GG|HH:MM|dettagli|email>>` una volta che chi chiama ha confermato tutto (l'email è facoltativa, solo se l'ha detta lui), `<<RICHIAMA|nome|motivo>>` una volta sola quando il cliente accetta un richiamo da un collega (viene segnalato in cima alla scheda Appuntamenti, senza giorno né orario), e `<<FINE>>` dopo il saluto finale. Il server li toglie dal parlato, fissa l'appuntamento o il richiamo e riaggancia dopo che l'ultimo audio è stato riprodotto.

**Tempi** misurati su un MacBook Apple Silicon con 16 GB:

| Passo | Tempo |
|---|---|
| Voce: primo audio di una frase | ~0,2 s |
| Trascrizione | ~0,1–0,2 s a frase |
| Claude: primo testo (`--effort low`) | ~0,65–1,3 s |
| **Totale, dalla fine della frase di chi chiama al primo audio** | **~1,5–2,5 s** |

Dipendono dalla macchina e da quanto è carica; vedi la nota in [Stato e limiti](#stato-e-limiti).

## Come si adatta a chi chiama

Le istruzioni dicono al modello di ascoltare come parla chi chiama e di cambiare il modo, mai la cortesia o la precisione:

| Chi chiama | Cosa fa il receptionist |
|---|---|
| Ha fretta | Risposte cortissime, una cosa alla volta, niente convenevoli |
| Sgarbato o provocatorio | Resta calmo e cordiale, niente scuse, niente prediche, magari una battuta leggera, poi va avanti |
| Preoccupato (incidente, guasto, scadenza) | Calmo e vicino, prima la persona e poi il lavoro, mai battute |
| Arrabbiato per un problema | Non si difende e non promette niente, dice che lo segna e offre il richiamo di una persona |
| Chiacchierone | Risponde in una frase e riporta a quello che manca |
| Disordinato | Tiene tutto quello che è stato detto, non richiede mai quello che ha già avuto |
| Incerto | Più lento, parole semplici, una domanda facile alla volta, propone la strada più semplice |
| Informale (dà del "tu") | Passa al "tu" e si rilassa, restando professionale; con chi è formale resta sul "Lei" |
| Chiede quello che non sa (prezzi, tempi, garanzie) | Dice con franchezza che adesso non può dirlo e chi lo farà |
| Fuori tema o vuole vendere qualcosa | Breve e gentile, poi chiude lo scambio con garbo |

## Sicurezza e privacy

- **`SEGRETO`.** Senza, il server presume di essere usato solo in locale. Per un server pubblico imposta `SEGRETO` a una stringa lunga e casuale: il pannello passa a `/admin/<SEGRETO>`, la pagina di chiamata dal web a `/web/<SEGRETO>`, il feed a `/calendario/<SEGRETO>.ics` e il webhook Twilio a `/twilio/<SEGRETO>/voce`. **Non esporre il pannello senza un segreto**: chiunque conosca l'indirizzo potrebbe leggere i dati dei clienti e cambiare le impostazioni (la scheda Telefono ti avvisa in rosso). Il segreto nell'indirizzo protegge il pannello e le API; per il webhook Twilio c'è in più la verifica della firma (vedi sotto).
- **Solo localhost, di default (`HOST`).** Il server ascolta su `127.0.0.1` (`HOST`). Con `HOST=0.0.0.0` si apre alla rete locale: da fare solo dietro un proxy https e con `SEGRETO`.
- **Senza `SEGRETO` rifiuta proxy e tunnel.** Il server risponde 403 (e chiude i WebSocket) a ogni richiesta con un nome `Host` diverso da `localhost`, `127.0.0.1` o `[::1]`, oppure con intestazioni da proxy (`cf-connecting-ip`, `x-forwarded-for`, `x-forwarded-host`, `x-real-ip`, `forwarded`). Così un tunnel o un proxy messi per sbaglio davanti a un server senza segreto non pubblicano il pannello. **Per internet:** `SEGRETO` obbligatorio più un proxy https (o un tunnel) davanti, con `URL_PUBBLICO` impostato.
- **Firma Twilio.** Con l'Auth Token primario impostato il webhook verifica `X-Twilio-Signature` (HMAC-SHA1 sull'indirizzo pubblico) e risponde 403 se manca o è sbagliata. Senza Auth Token la richiesta passa ma il pannello avvisa; con l'Auth Token ma senza indirizzo pubblico viene rifiutata. Vedi [Twilio](#twilio-un-numero-di-telefono-vero).
- **WebSocket di prova:** il gettone speciale `prova` del WebSocket delle chiamate (`/media/tel/prova`, usato dai test locali) vale solo per una connessione diretta da questo computer, senza intestazioni di proxy e con `Host` locale, e mai quando sono impostati sia `SEGRETO` sia l'indirizzo pubblico (server esposto). Per Twilio i WebSocket usano gettoni monouso validi 60 secondi.
- **Chiavi.** Chiavi API, token e password sono salvati in `dati/impostazioni.json` con permessi `600` (la cartella `dati/` è `700`; all'avvio e a ogni salvataggio i permessi vengono riportati a `700`/`600` anche se cartella e file esistevano già più aperti) e **non vengono mai rimandati al browser**: lasciare vuoto un campo password mantiene quella salvata. `.env` e `dati/` sono nel `.gitignore`.
- **Dati personali su disco.** `registrazioni/` contiene i numeri di chi chiama e il testo delle telefonate, e `dati/appuntamenti.json` (anch'esso `600`) le prenotazioni. Trattali secondo il GDPR: decidi un periodo di conservazione e cancella quello che non ti serve. L'audio non viene conservato.
- **Dati che lasciano il Mac.** Il testo della conversazione va al cervello che hai scelto (vedi le [avvertenze](#il-cervello-claude-code-e-altri-servizi)). Nome, telefono ed email dei clienti sono in quel testo.
- **Trasparenza e AI Act.** Il receptionist ammette sempre di essere un'AI se glielo chiedono. Nell'Unione Europea l'AI Act chiede di dire a chi chiama **all'inizio** che sta parlando con un'AI: per un uso reale, aggiungilo al saluto (scheda Receptionist, "Saluto"), per esempio "...Sono Luca, l'assistente virtuale di Lasercamp, mi dica."
- **Voci clonate.** Solo con consenso, vedi [La voce](#la-voce).

## Esempio completo: Lasercamp

[Lasercamp](https://lasercamp.it) è un laboratorio di lavorazioni laser a Settimo Milanese (Milano): incisione, marcatura e taglio su legno, plexiglas, pelle, tessuto e metalli, per aziende e privati. Ecco come è impostato, passo per passo. Tutto quello che segue è stato eseguito nella configurazione locale descritta in [Stato e limiti](#stato-e-limiti).

### 1. Importa dal sito

In **Attività**, scrivi `lasercamp.it` e premi **Importa dal sito**. Nell'esecuzione mostrata nello screenshot qui sopra ha letto **30 pagine in circa 49 secondi** e ha compilato:

- l'attività: nome *Lasercamp*, cos'è (un servizio di laser conto terzi), indirizzo, telefono, email;
- i servizi e i materiali (compresi i limiti tecnici, come il fatto che il vetro si può incidere ma non tagliare);
- cosa chiedere a chi chiama: quale lavorazione (incisione, marcatura o taglio), quale materiale e spessore, quanti pezzi, se il file è pronto;
- la **scheda per il telefono**: chi sono, servizi, materiali, contatti, FAQ, in frasi brevi raggruppate per argomento.

Il sito non indica gli orari di apertura, quindi l'importazione li lascia vuoti e lo dice. Controlla i campi, correggi quello che vuoi e premi **Salva**.

### 2. Orari di apertura, a mano

Dato che il sito non li indica, in **Orari** scriviamo gli orari da lunedì a venerdì:

```
Lun-Ven   09:00-13:00, 14:00-18:00
Sab, Dom  (vuoto = chiuso)
```

Durata dell'appuntamento 60 minuti, uno alla volta, preavviso minimo e orizzonte come nello screenshot qui sopra. L'elenco "Prossimi posti liberi" sotto mostra quello che il receptionist proporrà.

### 3. La voce

La voce predefinita (un uomo milanese, di nome "Luca") si adatta a un laboratorio vicino a Milano, quindi la teniamo. Per cambiarla, vedi [La voce](#la-voce). Saluto: `Lasercamp, buongiorno! Sono Luca, mi dica.`

### 4. Calendario

In **Calendari** colleghiamo il calendario del laboratorio via CalDAV (per esempio un server Nextcloud: indirizzo `https://<il-tuo-server>/remote.php/dav`, utente, password per le app, poi "Cerca calendari", scegli il calendario, spunta "legge gli impegni" e "scrive gli appuntamenti", "Prova"). Da quel momento i posti già occupati in quel calendario non vengono proposti, e ogni prenotazione ci viene scritta. (Lo screenshot nella [sezione Calendari](#il-pannello-admin-scheda-per-scheda) mostra questo modulo compilato con valori illustrativi; la funzione è stata provata contro un server Radicale locale, vedi sotto.)

### 5. Una telefonata di prova e l'appuntamento che ne risulta

Una telefonata simulata, dallo stesso percorso di Twilio, con una cliente che vuole portachiavi incisi e targhette in plexiglas per un evento aziendale.

| Chi | Cosa dice |
|---|---|
| **Receptionist:** | Lasercamp, buongiorno! Sono Luca, mi dica. |
| **Cliente:** | Buongiorno! Volevo delle informazioni per delle lavorazioni laser. |
| **Receptionist:** | Certo, mi dica pure. Le serve un taglio, un'incisione o una marcatura? |
| **Cliente:** | Allora, per un evento della mia azienda vorremmo regalare dei portachiavi in legno con il nostro logo inciso. E magari anche delle targhette in Plexiglas. |
| **Receptionist:** | Perfetto, quindi per l'azienda: portachiavi in legno con incisione del logo, e targhette in plexiglas. Quanti pezzi pensa di farne, più o meno? E avete già il file del logo? |
| **Cliente:** | Saranno più o meno 200 pezzi. Il logo ce l'ho. Ma non so se va bene per il laser. |
| **Receptionist:** | Certo, si può verificare benissimo. Può mandare il logo a info@lasercamp.it, così i nostri grafici le dicono subito se è adatto all'incisione. [...] Intanto, vuole che le fissi un appuntamento in laboratorio per vedere i campioni e parlare del progetto? |
| **Cliente:** | Ah perfetto, martedì alle 10 mi andrebbe benissimo. |
| **Receptionist:** | Perfetto, martedì ventisette alle dieci è libero. A che nome lo segno? |
| **Cliente:** | Chiara Galli della Galli Eventi. |
| **Receptionist:** | Perfetto, segno Chiara Galli di Galli Eventi per martedì ventisette alle dieci. Quindi portachiavi in legno e targhette in plexiglas con incisione del logo, circa duecento pezzi, e ha già il file. È tutto così? |
| **Cliente:** | Sì, è tutto. Le mando il logo per email allora. |
| **Receptionist:** | Perfetto, è tutto segnato. Lo mandi pure a info@lasercamp.it, così ce l'hanno prima di martedì. Le serve altro? |
| **Cliente:** | No, a posto così. Grazie mille. |
| **Receptionist:** | Perfetto Chiara, ci vediamo martedì alle dieci. Buona giornata. |

L'estratto viene dal log del server di una telefonata simulata (la "cliente" è una voce sintetica; il numero di telefono nel log è un segnaposto), leggermente accorciato dove indicato con `[...]`. Alla fine della risposta di conferma il server ha registrato il marcatore:

```
🔧 CONFERMA ["Chiara Galli","2026-10-27","10:00","Galli Eventi, azienda: incisione logo su portachiavi
   in legno e targhette in plexiglas, circa 200 pezzi, file del logo da inviare via email"]
📅 appuntamento {"nome":"Chiara Galli","giorno":"2026-10-27","ora":"10:00","durata":60,"stato":"confermato","canale":"telefono", ...}
🔧 FINE
```

e l'appuntamento compare nella scheda **Appuntamenti** (prima riga dello screenshot qui sopra), viene scritto nel calendario collegato se c'è, e il posto delle 10:00 sparisce dai posti liberi. Una telefonata che finisce con `<<FINE>>` viene riagganciata dal receptionist dopo che l'ultimo audio è stato riprodotto.

### Cosa il receptionist non sa

Sul sito non c'è niente su **prezzi, tempi di consegna, garanzie o sulla fattibilità di un lavoro specifico**, quindi il receptionist non se li inventa. Dice che adesso non può dirlo e che i tecnici risponderanno quando vedranno il file o l'oggetto: per questo, nella telefonata qui sopra, manda il logo al team tecnico invece di dire "sì, si può fare". Tutto quello che vuoi che dica su questi temi, aggiungilo tu alla scheda per il telefono o al campo "istruzioni in più".

## Stato e limiti

Cosa è stato provato, onestamente:

- Telefonate simulate che passano dallo stesso percorso di Twilio (un finto client Twilio che apre il WebSocket Media Streams e fa parlare un cliente sintetico), e chiamate e chat dal browser.
- **Il collegamento Twilio con un Twilio finto:** `prove/prova-twilio.mjs` (55 controlli, con `prove/finto-twilio-api.mjs`) verifica la formula della firma, le credenziali, il collegamento del numero, il webhook con e senza firma giusta, il WebSocket dello stream, la chiamata in uscita e gli SMS, su un'istanza separata del server.
- **Il tono per tipo di cliente:** `prove/matrice-tono.mjs` fa telefonate in chat per undici tipi di cliente (fretta, sgarbato, preoccupato, arrabbiato…) con controlli automatici su cifre, simboli, frasi ripetute e cose inventate; il giudizio sul tono resta a chi legge. `prove/chat-prova.mjs` fa una chiamata in sola chat con le frasi che dai.
- **La sicurezza:** `prove/prova-sicurezza.mjs` controlla il gettone `prova` del WebSocket, i permessi dei dati, le impostazioni vecchie e i controlli anti-SSRF (l'ultimo controllo legge un sito pubblico vero e vuole la rete).
- I calendari su un **server CalDAV locale (Radicale)**.
- Il percorso del cervello compatibile OpenAI su un **servizio finto di prova** che imita il protocollo.

Cosa **non** è stato ancora provato:

- Un **vero numero Twilio**: il webhook, la verifica della firma, il collegamento automatico del numero e il pulsante "Chiamami ora" sono stati provati **solo con un Twilio finto**, non con uno reale (la firma è calcolata con la formula documentata da Twilio, ma non è mai stata controllata da una richiesta vera).
- **Nessun test con un Nextcloud reale** (né con iCloud, Fastmail, Synology...): solo il server CalDAV locale.
- I **veri servizi gratuiti** (Groq, Gemini, OpenRouter, ...), mai provati oltre a quel servizio finto: i loro limiti e il loro comportamento possono essere diversi da quelli descritti.

Limiti noti:

- **Tedesco e adattamento del tono.** Il tedesco è stato provato in chat e con telefonate simulate: cliente che parla tedesco per tutta la chiamata, tedesco che passa all'italiano e viceversa, cliente in inglese (il receptionist si scusa in italiano e in tedesco e offre il richiamo) e tedesco disattivato (resta in italiano e lo dice). Date, orari ed email escono in lettere nella lingua giusta e i dettagli del marcatore `<<CONFERMA…>>` restano in italiano. La voce è la stessa voce clonata, con suono italiano, che parla tedesco: si sente l'accento, e non è mai stata provata con veri clienti di lingua tedesca. I 11 scenari di `prove/matrice-tono.mjs` sono stati giudicati leggendo i dialoghi, non con un punteggio automatico. Haiku con impegno basso segue le regole sul tono solo in parte: ogni tanto sbaglia una data relativa ("domani" di domenica) o infila una parola inglese in italiano. I richiami promessi (cliente arrabbiato, in un'altra lingua, o che preferisce una persona) vengono registrati con il marcatore `<<RICHIAMA|nome|motivo>>` e compaiono in cima alla scheda Appuntamenti: richiamati, si preme "Fatto".
- **Frammenti brevi.** Qwen3-TTS 0.6B può sbagliare sulle frasi di due o tre parole, quindi le frasi si mandano intere; anche la lunghezza dell'audio ha un tetto.
- **Una chiamata alla volta per il motore vocale.** Il motore gestisce una sintesi alla volta (MLX lavora un pezzo alla volta), quindi le chiamate contemporanee si metterebbero in coda.
- **La voce non è un madrelingua perfetto.** È buona e coerente, ma un orecchio italiano attento capisce che è sintetica.
- **La latenza varia.** I tempi qui sopra sono quelli misurati sul MacBook di sviluppo. I primi log di prova in questo repository avevano ritardi più lunghi (circa da 1,4 a 4 s dalla fine della frase), prima di `--effort low` e di altre modifiche, e le macchine cariche saranno più lente.
- **I clienti che parlano inglese non vengono serviti** (le trascrizioni che sembrano inglese vengono scartate come rumore).
- **Se scegli il motore faster-whisper** al posto di Parakeet, la trascrizione è forzata sull'italiano, quindi il tedesco non funzionerebbe.
- **Abbonamento Claude su un server pubblico.** Usare un abbonamento Claude (login o `setup-token`) per rispondere alle chiamate su un server pubblico va verificato sui limiti e sulle condizioni d'uso correnti di Anthropic prima di farci affidamento. Una chiave API evita la domanda.
- Gli eventi ricorrenti negli indirizzi iCal privati contano solo alla prima occorrenza (CalDAV li espande correttamente).

## Struttura del repository

```
src/
  server.mjs         webhook Twilio, pagina web, pannello admin, WebSocket
  chiamata.mjs       la pipeline: VAD → trascrizione → cervello → voce, interruzioni, azioni
  cervello.mjs       il cervello: processo Claude Code o servizi compatibili OpenAI, riserva
  voce.mjs           client del motore vocale, codifica μ-law
  web.mjs            la pagina per chiamare dal browser (microfono + chat)
  persona.mjs        chi è il receptionist, come parla, cosa sa, come va una chiamata
  impostazioni.mjs   impostazioni del pannello admin (dati/impostazioni.json)
  agenda.mjs         posti liberi, appuntamenti, calendari iCal, email di conferma
  caldav.mjs         CalDAV: ricerca, lettura, creazione, spostamento, cancellazione
  sito.mjs           importa dal sito: lettura delle pagine ed estrazione dei dati
  admin.mjs          la pagina del pannello admin
  twilio.mjs         Twilio: credenziali, verifica, webhook automatico, SMS, chiamate in uscita
  twilio-stream.mjs  lato Twilio della chiamata: audio, mark, riaggancio
  strumenti.mjs      registrazione dell'appuntamento e SMS di conferma
  pannello.mjs       semplice pagina "fatti chiamare"
  config.mjs         lettura del .env e valori di partenza (porta, motore, Claude, VAD)
  rete.mjs           richieste verso indirizzi scelti dall'utente (sito, CalDAV, iCal) con i controlli anti-SSRF
motore/
  motore.py          orecchie (Parakeet v3) e voce (Qwen3-TTS), tutto in locale
  disegna-voce.py    crea i campioni di voce con Qwen3-TTS VoiceDesign
  requirements.txt
prove/               telefonate simulate, prova Twilio con un Twilio finto, matrice del tono, misure dei ritardi
voci/                il campione della voce del receptionist (receptionist.wav, testo.txt)
demo/                due telefonate di esempio (mp3)
docs/screenshot/     gli screenshot usati in questo README
dati/                impostazioni e appuntamenti (creati all'avvio, esclusi da git)
registrazioni/       log delle chiamate (creati all'avvio, esclusi da git)
GUIDA-TECNICA.md     guida tecnica (italiano)
```

Il codice e i suoi commenti sono in italiano (nomi come `chiamata`, `cervello`, `agenda`, `impostazioni`); anche la guida tecnica è in italiano.

## Licenza e crediti

**Licenza: vedi sotto.**

<!-- TODO-LICENSE -->

Crediti:

- Basato su [Henry12034/ai-caller-cosmio](https://github.com/Henry12034/ai-caller-cosmio) di [Cosmio](https://cosmio.it) (nato su OpenAI Realtime ed ElevenLabs), a sua volta ispirato da [jasonc00person/bland-ai-receptionist](https://github.com/jasonc00person/bland-ai-receptionist).
- Riconoscimento vocale: [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) di NVIDIA, licenza CC-BY-4.0.
- Voce: [Qwen3-TTS](https://huggingface.co/Qwen), Apache-2.0.
- Esecuzione: [MLX](https://github.com/ml-explore/mlx) e [mlx-audio](https://github.com/Blaizzy/mlx-audio) per far girare i modelli su Apple Silicon.
- Cervello: [Claude Code](https://claude.com/claude-code) di Anthropic, oppure il servizio compatibile OpenAI che scegli.
- Lasercamp ([lasercamp.it](https://lasercamp.it)) è usato solo come esempio realistico di piccola attività; i dati dell'esempio vengono dal suo sito pubblico.

### Come usare la conferma degli appuntamenti

1. **Configura l'indirizzo pubblico** (scheda Telefono) se vuoi che i link funzionino: senza, il cliente deve rispondere all'email.
2. **Manda la richiesta di conferma:**
   - Singolo appuntamento: pulsante **✉️ Chiedi conferma** nella riga dell'appuntamento.
   - Tutti i prossimi: pulsante **✉️ Chiedi conferma ai prossimi** in cima alla scheda.
3. **Il cliente riceve un'email** con due pulsanti: *Sì, confermo* e *Non posso venire*.
4. **L'esito compare nel pannello:** "confermato dal cliente" (verde) o "non può venire: richiamalo" (rosso).

**Nota:** i link non usano il segreto del pannello (solo id + token), quindi il cliente li può aprire da qualsiasi dispositivo.
