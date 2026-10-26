# Report sessione — 26 ottobre 2026

## Risultato

Maria è attiva con un motore vocale più resiliente dopo inattività, rumore leggero di tastiera durante l'attesa, instradamento automatico delle richieste e guardrail che impediscono appuntamenti o richiami senza consenso. Il server e il motore risultano entrambi sani; Twilio non è configurato nell'istanza locale verificata.

## 1. Stabilità dopo standby e inattività

- Il servizio launchd del motore usa `caffeinate -i`, così lo standby automatico per inattività non sospende il processo. Restano inevitabilmente esclusi chiusura del portatile, stop manuale, riavvio e mancanza di corrente.
- `motore/motore.py` mantiene caldi STT e TTS dopo periodi di inattività (`MOTORE_KEEPWARM_S`, predefinito 300 secondi).
- Il preriscaldamento STT usa un breve campione di parlato reale, con silenzio come fallback sicuro.
- Il TTS preriscalda la voce realmente selezionata nell'admin, senza accettare percorsi esterni.
- Il lavoratore STT usa ID di richiesta, coda e timeout per evitare risposte scambiate o blocchi.
- Se lo STT non risponde, il motore richiede un riavvio controllato invece di restare apparentemente vivo.
- I servizi Qwen concorrenti ammessi sono limitati a una allowlist; una guardia li ricontrolla e li ferma se un watchdog li riavvia. In uscita vengono ripristinati con retry e timeout.
- Nuove variabili: `MOTORE_KEEPWARM_S`, `MOTORE_STT_AVVIO_TIMEOUT_S`, `MOTORE_CONTROLLO_SERVIZI_S`.

## 2. Velocità e feedback durante l'attesa

- Aggiunto `src/attesa.mjs`: genera tocchi di tastiera bassi, brevi e irregolari mentre Maria trascrive o prepara la risposta.
- Il rumore viene inviato soltanto al chiamante, non entra nel riconoscimento vocale, non parte nella chat scritta e viene cancellato prima della voce o quando il cliente interrompe.
- Il volume è limitato a `0`–`0.04` per non attivare il VAD. Nell'istanza attiva è stato impostato a `0.035`.
- Nuove variabili: `TASTIERA_ATTESA` e `TASTIERA_VOLUME`.
- Latenze osservate nelle prove reali finali: primo testo AI circa 0,4–0,7 secondi; primo audio complessivo circa 1,0–1,9 secondi nei percorsi provati.

## 3. Riconoscimento automatico delle richieste

- Aggiunto `src/intenti.mjs` con sei categorie: `informazione`, `preventivo_file`, `assistenza_problema`, `richiamata`, `appuntamento`, `altro`.
- L'intento viene deciso nella stessa risposta del modello mediante `<<INTENTO|categoria>>`: nessuna seconda chiamata AI e quindi nessuna latenza aggiuntiva di classificazione.
- Il marker viene eliminato prima del parlato e della trascrizione mostrata al browser.
- L'intento viene rivalutato a ogni turno: una telefonata può passare, per esempio, da preventivo ad assistenza.
- Se il riconoscimento automatico è disattivato, il server ignora l'intento scelto dall'AI e usa soltanto gli indicatori delle regole admin.
- Le parole chiave sono solo candidati/guardrail: da sole non prenotano, non registrano richiami e non chiudono la chiamata.

## 4. Nuova sezione admin “Gestione richieste”

- Aggiunta dopo la scheda Receptionist.
- Contiene:
  - interruttore riconoscimento automatico;
  - azione predefinita;
  - elenco dinamico di regole;
  - nome, priorità, indicatori, intento, comportamento, obiettivo e “cosa non proporre”;
  - aggiunta e rimozione delle regole.
- I valori sono normalizzati e limitati: massimo 50 regole e 50 indicatori per regola, allowlist per intenti/comportamenti, limiti di lunghezza e neutralizzazione dei token `<<...>>`.
- Il testo complessivo delle regole inviato al modello ha un budget massimo di 12.000 caratteri.
- L'interfaccia fa escaping dei contenuti e i test XSS sono verdi.

### Regole attive configurate per Lasercamp

1. Informazioni semplici: risponde a orari, indirizzo, apertura e materiali senza proporre appuntamenti.
2. Preventivi e file: raccoglie solo i dati mancanti e indica email/WhatsApp per il progetto.
3. Assistenza e problemi: capisce il problema e può offrire un richiamo umano.
4. Richiesta di una persona: raccoglie nome e motivo minimo, poi registra solo con consenso.
5. Appuntamenti e consulenze: propone esclusivamente slot liberi e registra solo dopo riepilogo e conferma.

La vecchia istruzione attiva “in entrambi i casi proponi un appuntamento” è stata rimossa da `dati/impostazioni.json`. Questo file è intenzionalmente escluso da Git perché contiene credenziali e configurazione privata.

## 5. Guardrail conversazionali

- `CONFERMA` è accettato solo con intento `appuntamento`, campi validi, riepilogo precedente, sì esplicito e slot ancora disponibile.
- `RICHIAMA` è accettato solo se il cliente lo chiede direttamente oppure accetta esplicitamente un'offerta appena fatta.
- Risposte incerte o condizionali come “sì, forse”, “se costa meno”, “devo pensarci” o una domanda non autorizzano azioni.
- Formulazioni naturali come “sì, certo”, “va bene, grazie mille”, “mi richiamate?” e “può farmi richiamare?” sono riconosciute.
- Rimossa la registrazione automatica di un'azione rimasta pendente alla chiusura della telefonata.
- I campi dei marker sono validati per formato, lunghezza, caratteri di controllo e singola email valida.
- Nel percorso preventivo un filtro deterministico blocca la richiesta dell'email personale del cliente: Maria indica l'indirizzo dell'attività a cui inviare il file.
- Gli esempi del prompt includono ora `INTENTO` in ogni turno e definiscono l'ordine rispetto a `CONFERMA`, `RICHIAMA` e `FINE`.

## 6. Agenda e concorrenza

- La prenotazione è serializzata: due conferme contemporanee per lo stesso slot non possono creare due appuntamenti.
- Se lo slot è stato occupato nel frattempo, la seconda prenotazione viene rifiutata; non viene più salvata automaticamente come “da verificare”.
- Test dedicato: due prenotazioni concorrenti sullo stesso slot producono una sola registrazione.

## 7. Sicurezza e privacy

- Corretto un prototype pollution nel `POST /impostazioni`: la validazione usa ora lo stesso merge sicuro e ricorsivo della persistenza; `__proto__`, `constructor` e `prototype` vengono scartati anche annidati.
- I log tecnici nuovi non contengono trascrizioni, nomi, numeri, email o dettagli degli appuntamenti.
- `registrazioni/appuntamenti.jsonl` registra solo ID, tipo, stato e data di creazione. I dati completi restano in `dati/appuntamenti.json`, dove servono al servizio.
- Cartella log a `700`, file a `600`; i `.log` più vecchi di `LOG_CONSERVAZIONE_GIORNI` vengono eliminati all'avvio (30 giorni predefiniti, intervallo 1–365).
- I record storici di `appuntamenti.jsonl` vengono migrati automaticamente al formato senza PII. Anche i vecchi `.log` ancora entro la conservazione vengono bonificati automaticamente, mantenendo tempi ed eventi tecnici ma rimuovendo trascrizioni, contatti e segreti negli URL.

## 8. Prove eseguite

- `node prove/prova-intenti.mjs`
- `node prove/prova-admin-intenti.mjs`
- `node prove/prova-consenso.mjs`
- `node --test prove/prova-instradamento.mjs prove/prova-attesa.mjs`
- `node prove/prova-prenotazione-atomica.mjs`
- `node prove/prova-log-privacy.mjs`
- `node prove/prova-email.mjs`
- `node prove/prova-intercalari.mjs`
- `node prove/prova-parlato.mjs`
- `python3 prove/prova-motore-keepwarm.py` — 24 test
- `node prove/prova-sicurezza.mjs` — 64 controlli, 0 errori
- controlli sintattici Node e `git diff --check`.

### Conversazioni reali verificate

- Informazioni: Maria ha dato orari e indirizzo, senza proporre appuntamenti.
- Cambio intento: preventivo → assistenza nella stessa chiamata; nessun appuntamento o richiamo registrato senza consenso.
- Appuntamento: ha proposto soltanto slot liberi e non ha registrato nulla dopo il rifiuto.
- Preventivo: ha riconosciuto quantità, materiale e file, indicato `info@lasercamp.it` e non ha proposto appuntamenti né chiesto l'email personale.
- I log finali mostrano gli intenti corretti ma soltanto lunghezze/metadati, non le frasi.

## 9. Stato operativo finale

- Motore: `GET http://127.0.0.1:5051/salute` → `ok`, STT vivo, Qwen TTS con voce `receptionist.wav`.
- Server: `GET http://127.0.0.1:5050/salute` → `ok`, motore raggiungibile.
- Admin API: riconoscimento automatico attivo; caricate le cinque regole Lasercamp; assente la vecchia nota che forzava gli appuntamenti.
- Twilio: non configurato nell'istanza locale (`twilio: false`).

## 10. File principali modificati

- Motore/resilienza: `motore/motore.py`, `.env.example`.
- Attesa naturale: `src/attesa.mjs`, `src/config.mjs`, `src/chiamata.mjs`.
- Intenti/admin: `src/intenti.mjs`, `src/admin.mjs`, `src/impostazioni.mjs`, `src/persona.mjs`, `src/consenso.mjs`.
- Agenda/sicurezza/privacy: `src/agenda.mjs`, `src/server.mjs`, `src/strumenti.mjs`, `src/twilio-stream.mjs`.
- Documentazione: `GUIDA-TECNICA.md`, questo report.
- Test nuovi: `prove/prova-attesa.mjs`, `prove/prova-intenti.mjs`, `prove/prova-admin-intenti.mjs`, `prove/prova-instradamento.mjs`, `prove/prova-motore-keepwarm.py`, `prove/prova-prenotazione-atomica.mjs`.

## 11. Come continuare

1. Aprire l'admin e usare “Gestione richieste” per aggiungere o rifinire indicatori e obiettivi.
2. Lasciare “Riconoscimento automatico” attivo per la comprensione semantica; disattivarlo soltanto se si vuole un instradamento strettamente basato sugli indicatori.
3. Per ascoltare una prova locale usare la pagina web del server o `node prove/chat-prova.mjs "prima frase" "seconda frase"`.
4. Prima dell'uso telefonico reale completare e verificare Twilio e la firma webhook.
5. Se un altro agente riprende il lavoro, partire da questo report, da `GUIDA-TECNICA.md` e dalle suite elencate sopra.
