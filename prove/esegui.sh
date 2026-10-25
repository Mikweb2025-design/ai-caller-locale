#!/usr/bin/env bash
# Avvia il server, fa una chiamata simulata e spegne il server.
# Serve il motore vocale già acceso (npm run motore). Uso: prove/esegui.sh <etichetta> [copione]
cd "$(dirname "$0")/.."
etichetta="${1:-prova}"
copione="${2:-base}"
mkdir -p prove/out
node src/server.mjs > "prove/out/server-$etichetta.log" 2>&1 &
pid=$!
for i in $(seq 1 80); do grep -q 'saluto pronto' "prove/out/server-$etichetta.log" && break; sleep 0.25; done
if grep -q EADDRINUSE "prove/out/server-$etichetta.log"; then echo "porta 5050 occupata"; exit 1; fi
node prove/finto-twilio.mjs "http://127.0.0.1:5050/twilio/locale/voce" "$etichetta" "$copione" 2>&1 | grep -E "⏱|RITARDI|medio|webhook|chiuso|registrazione"
kill $pid 2>/dev/null
echo "----- server"
grep -E "🤖|👤|⏱|🔧|✂|🫧|📅|errore" "prove/out/server-$etichetta.log"
