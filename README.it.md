# Receptionist AI in locale

> 🇬🇧 **English:** [README.md](README.md) è il README principale, in inglese e più dettagliato. Questa è la **versione italiana** (più breve), con le stesse immagini e gli stessi link.


Fork di [Henry12034/ai-caller-cosmio](https://github.com/Henry12034/ai-caller-cosmio), il receptionist AI di [Cosmio](https://cosmio.it), rifatto per girare tutto in locale con modelli open source e Claude Code.

🎧 [Ascolta una telefonata](demo/telefonata-lasercamp.mp3)

## Ogni telefonata persa è un cliente che chiama il concorrente

Sei sotto una macchina, con un cliente davanti, in pausa pranzo o a casa la sera. Il telefono squilla e nessuno risponde. Chi chiama quasi mai lascia un messaggio: torna su Google e prova il numero dopo il tuo.

Il receptionist AI risponde al primo squillo, ogni volta. Accoglie il cliente, capisce cosa gli serve, gli fissa l'appuntamento e ti lascia tutto scritto. Tu ti occupi del lavoro.

## Cosa fa per te

- **Risponde sempre.** 24 ore su 24, sabato e domenica compresi, anche a più clienti nello stesso momento. Niente musichetta d'attesa, niente "richiami più tardi".
- **Prende l'appuntamento.** Propone gli orari liberi e segna nome, auto (o servizio) e tutto quello che c'è da fare. Poi ripete il riepilogo, perché nessun dettaglio vada perso.
- **Parla come una persona.** Frasi brevi, qualche "allora…", una battuta quando ci sta. Se lo interrompi si ferma e ti ascolta.
- **Tiene testa a tutti.** Al cliente di fretta risponde in due parole, a quello scorbutico con una battuta, a quello preoccupato con calma ("si è fatto male qualcuno?").
- **Capisce anche il cliente disordinato.** Se nella prima frase gli dici nome, macchina e problema, se li tiene e ti chiede solo quello che manca.
- **Non inventa.** Niente prezzi o promesse a caso: "il preventivo glielo fanno i ragazzi quando vedono la macchina".
- **È onesto.** Se qualcuno chiede "ma sto parlando con un'intelligenza artificiale?", risponde di sì e offre di farlo richiamare da una persona.
- **Chiude da solo.** Saluta, ricorda giorno e ora e riattacca. Se vuoi, manda anche l'SMS di conferma.

## Ascolta come suona

🎧 [Una telefonata simulata](demo/telefonata-locale.mp3): il cliente è una voce di prova, il receptionist è l'AI, esattamente come risponde al telefono.

## Tutto in locale, niente modelli a pagamento

| | |
|---|---|
| **Orecchie** | [Parakeet TDT v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) (NVIDIA, open source) su MLX: ~0,15 s per frase. In alternativa faster-whisper |
| **Cervello** | **Claude Code** (`claude -p` in streaming), con il tuo abbonamento: nessuna chiave API |
| **Voce** | [Qwen3-TTS](https://huggingface.co/Qwen) (open source, Apache 2.0) su MLX: primo audio in ~0,2 s, anche clonando una voce italiana da un campione |
| **Telefono** | Twilio, facoltativo. Per provarlo basta il browser: microfono, altoparlante e chat |

Su un Mac con Apple Silicon il receptionist risponde in circa 2 secondi dalla fine della frase del cliente.

**Pannello admin** (`/admin`): importazione automatica dei dati dal sito dell'attività, orari di apertura e chiusure, posti liberi veri, calendari Nextcloud, iCloud e CalDAV collegati in lettura e scrittura (crea, sposta, cancella), calendario da abbonarsi in Google/Outlook, numero Twilio (credenziali, webhook collegato in automatico, chiamata di prova), email di conferma, SMS ed elenco degli appuntamenti.

## Come appare

**Chiamata dal browser:** si parla col microfono oppure si scrive, e la conversazione resta scritta.

<p align="center"><img src="docs/screenshot/chiamata-browser.png" alt="Chiamata di prova dal browser con la chat" width="420"></p>

**Pannello admin** (`/admin`): appuntamenti, attività, orari, calendari, telefono, email e SMS.

**Importa dal sito:** scrivi l'indirizzo del sito, il receptionist ne legge fino a 30 pagine e Claude ne estrae tutto quello che serve al telefono (servizi, materiali e limiti tecnici, contatti, domande frequenti), senza inventare quello che non c'è.

<p align="center"><img src="docs/screenshot/admin-attivita.png" alt="Importa dal sito: i dati dell'attività estratti in automatico" width="720"></p>

| Appuntamenti | Orari e posti liberi |
|---|---|
| ![Elenco degli appuntamenti con Sposta e Annulla](docs/screenshot/admin-appuntamenti.png) | ![Orari di apertura, agenda e prossimi posti liberi](docs/screenshot/admin-orari.png) |
| **Calendari (Nextcloud, iCloud, CalDAV)** | **Telefono (Twilio)** |
| ![Calendario Nextcloud collegato in lettura e scrittura](docs/screenshot/admin-calendari.png) | ![Credenziali Twilio, webhook e collegamento automatico del numero](docs/screenshot/admin-telefono.png) |

## Per chi è

L'esempio qui è il centralino di un'officina, ma funziona per qualsiasi attività che riceve telefonate e prende appuntamenti. Basta cambiare nome, orari, servizi e tono:

- officine, carrozzerie e gommisti
- studi medici, dentistici e fisioterapisti
- parrucchieri, barbieri e centri estetici
- ristoranti e locali (prenotazioni dei tavoli)
- palestre, scuole e studi professionali

## Sei uno sviluppatore?

Il codice è tutto in questa repository. In [GUIDA-TECNICA.md](GUIDA-TECNICA.md) trovi come funziona, come avviarlo (anche solo dal browser) e come adattarlo alla tua attività.

```bash
npm install && npm run motore   # in un terminale: orecchie e voce
npm start                       # in un altro: poi apri http://localhost:5050 (impostazioni su /admin)
```
