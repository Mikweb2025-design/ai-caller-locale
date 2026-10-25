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
- **Azioni.** Claude non ha strumenti: per registrare l'appuntamento e riagganciare scrive i marcatori `<<CONFERMA|nome|ora|auto>>` e `<<FINE>>`, che il server esegue e non fa sentire.
- **Voce.** Il testo di Claude arriva token per token; appena c'è una frase intera (almeno 20 caratteri) va a Qwen3-TTS, che restituisce l'audio a pezzi mentre lo genera. Saluto e riempitivo ("Mmh, allora...") sono pronti in memoria dall'avvio.
- **Interruzioni.** Se il cliente parla sopra al receptionist, il server svuota l'audio (`clear`), interrompe la sintesi e ignora il resto della risposta.
- **Motore.** La trascrizione gira in un processo separato, così non aspetta mai che la voce finisca di generare.

```
src/
  server.mjs         webhook Twilio, pagina web, pannello, WebSocket
  chiamata.mjs       la pipeline: VAD → trascrizione → Claude Code → voce, interruzioni, azioni
  cervello.mjs       il processo Claude Code in streaming
  voce.mjs           client del motore vocale, codifica μ-law
  web.mjs            pagina per chiamare dal browser (microfono + chat)
  persona.mjs        chi è il receptionist, come parla, cosa sa, come va la chiamata
  strumenti.mjs      registrazione dell'appuntamento, SMS, chiamate in uscita (Twilio)
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

### Con il numero Twilio

1. Metti `SEGRETO` (una stringa casuale lunga) e `URL_PUBBLICO` nel `.env`. Per provare: `cloudflared tunnel --url http://localhost:5050`.
2. Su Twilio, **Phone Numbers → il tuo numero → A call comes in**: Webhook `URL_PUBBLICO/twilio/<SEGRETO>/voce`, **HTTP POST**.
3. La pagina web diventa `URL_PUBBLICO/web/<SEGRETO>` e il pannello `URL_PUBBLICO/pannello/<SEGRETO>`.

## La voce

- `TTS_VOCE` sceglie uno speaker di Qwen3-TTS (`ryan` è il predefinito; `serena` e `vivian` per una voce femminile). Gli speaker non sono italiani madrelingua: si capiscono benissimo, ma con un filo di accento.
- Per un italiano madrelingua clona una voce: `TTS_MODELLO=mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit`, `TTS_RIF_AUDIO` = un wav a 24 kHz di 5–15 secondi, `TTS_RIF_TESTO` = cosa si dice. Usa solo voci di cui hai il consenso.
- I modelli 1.7B suonano meglio ma sono più lenti.

## Adattarlo alla tua attività

Tutto il personaggio è in `src/persona.mjs`:
- `OFFICINA`: nome, indirizzo, orari;
- `RECEPTIONIST`: nome e genere, presi dal `.env`;
- `martediProssimo()`: il giorno con i posti liberi;
- `istruzioni()`: tono, flusso della chiamata, cosa non deve mai dire o promettere (c'è anche il personaggio `napoletano`);
- `saluto()`: la prima frase.

Dopo una modifica riavvia il server.

## Prove senza telefono

| Comando | Cosa fa |
|---|---|
| `npm run genera-cliente` | crea la voce del cliente di prova (speaker `aiden`) per i copioni `base`, `scorbutico`, `disordine`, `improvvisato` |
| `prove/esegui.sh <nome> [copione]` | telefonata simulata con lo stesso percorso di Twilio: ritardo di ogni risposta e registrazione in `prove/out/<nome>.mp3` |

## Cosa abbiamo misurato (MacBook Apple Silicon, 16 GB)

- Trascrizione: Parakeet v3 ~0,1–0,2 s a frase; faster-whisper `small` su CPU ~1,1 s.
- Claude Code (Haiku, senza ragionamento): primo testo ~0,9–1,7 s.
- Qwen3-TTS 0.6B 8 bit: primo audio ~0,2 s, circa tre volte più veloce del tempo reale.
- Dalla fine della frase del cliente al primo audio: ~1,3–2,2 s.
- Qwen3-TTS 0.6B ogni tanto sbaglia sui frammenti di due o tre parole o non si ferma più: per questo le frasi si mandano intere e l'audio ha un tetto di lunghezza.

## Note

- **Trasparenza.** Il receptionist ammette sempre di essere un'AI se glielo chiedono. Nell'Unione Europea l'AI Act chiede di dirlo subito a chi chiama: per un uso reale aggiungilo al saluto.
- **Privacy.** In `registrazioni/` finiscono i numeri di chi chiama e il testo delle telefonate, quindi vanno trattati secondo il GDPR. L'audio non lascia il Mac; il testo delle frasi passa da Claude Code.
- **Crediti.** Basato su [Henry12034/ai-caller-cosmio](https://github.com/Henry12034/ai-caller-cosmio) di Cosmio (OpenAI Realtime ed ElevenLabs), a sua volta ispirato da [jasonc00person/bland-ai-receptionist](https://github.com/jasonc00person/bland-ai-receptionist).
