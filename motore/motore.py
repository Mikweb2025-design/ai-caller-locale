# Il motore vocale locale: orecchie (Parakeet v3 su MLX, oppure faster-whisper) e voce (Qwen3-TTS su MLX).
# Tutto open source e tutto su questo Mac: niente servizi a pagamento.
#
#   POST /stt   corpo: PCM 16 bit mono 8 kHz (audio del telefono)  → {"testo": "..."}
#   POST /tts   {"testo": "...", "voce": "ryan"}  → PCM 16 bit mono 8 kHz, in streaming
#   GET  /salute
#
# Uso: python3 motore/motore.py   (le impostazioni arrivano dal .env del progetto)
import json, os, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

RADICE = Path(__file__).resolve().parent.parent
env = RADICE / '.env'
if env.exists():
    for riga in env.read_text().splitlines():
        riga = riga.split('#', 1)[0].strip()
        if '=' in riga:
            k, v = riga.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

PORTA = int(os.environ.get('MOTORE_PORTA', '5051'))
# Parakeet TDT v3 (NVIDIA, CC-BY-4.0): 25 lingue europee, ~0,15 s a frase sulla GPU del Mac.
# In alternativa un modello faster-whisper (tiny | base | small | medium | large-v3-turbo), che gira su CPU.
STT_MODELLO = os.environ.get('STT_MODELLO', 'mlx-community/parakeet-tdt-0.6b-v3')
# Predefinito: la voce del receptionist in voci/receptionist.wav (creata con motore/disegna-voce.py),
# clonata dal modello Base. Senza campione, uno speaker predefinito del modello CustomVoice.
CAMPIONE = RADICE / 'voci' / 'receptionist.wav'
TTS_MODELLO = os.environ.get('TTS_MODELLO') or ('mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit' if CAMPIONE.exists()
                                                else 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit')
TTS_TEMPERATURA = float(os.environ.get('TTS_TEMPERATURA') or 0.6)  # più bassa = più piatta, più alta = più espressiva (e meno prevedibile)
TTS_VOCE = os.environ.get('TTS_VOCE', 'ryan')
TTS_ISTRUZIONI = os.environ.get('TTS_ISTRUZIONI', '') or None
# clonazione da un campione (solo con i modelli "Base"): file wav a 24 kHz e la sua trascrizione
TTS_RIF_AUDIO = os.environ.get('TTS_RIF_AUDIO', '') or None
TTS_RIF_TESTO = os.environ.get('TTS_RIF_TESTO', '') or None
if not TTS_RIF_AUDIO and CAMPIONE.exists() and 'Base' in TTS_MODELLO:
    TTS_RIF_AUDIO = str(CAMPIONE)
    TTS_RIF_TESTO = (RADICE / 'voci' / 'testo.txt').read_text().strip()

STT_MLX = '/' in STT_MODELLO

if __name__ == '__main__':
    # porta occupata = c'è già un motore acceso: meglio dirlo subito che dopo aver caricato i modelli
    import socket, sys
    with socket.socket() as prova:
        if prova.connect_ex(('127.0.0.1', PORTA)) == 0:
            sys.exit(f'La porta {PORTA} è già occupata: probabilmente il motore vocale è già acceso '
                     f'(curl http://127.0.0.1:{PORTA}/salute). Spegnilo o cambia MOTORE_PORTA nel .env.')

    # Altri servizi pesanti (launchd) da spegnere mentre il receptionist è acceso, per non finire
    # la memoria: si fermano adesso e si riaccendono quando il motore si chiude.
    import atexit, re, subprocess
    DOMINIO = f'gui/{os.getuid()}'
    spenti = []
    for etichetta in filter(None, (x.strip() for x in os.environ.get('SPEGNI_SERVIZI', 'com.qwen3tts.8091,com.qwen3tts.8092').split(','))):
        info = subprocess.run(['launchctl', 'print', f'{DOMINIO}/{etichetta}'], capture_output=True, text=True)
        percorso = re.search(r'^\s*path = (.+)$', info.stdout, re.M)
        if info.returncode != 0 or not percorso:
            continue  # non caricato
        if subprocess.run(['launchctl', 'bootout', f'{DOMINIO}/{etichetta}'], capture_output=True).returncode == 0:
            spenti.append(percorso.group(1).strip())
            print(f'spento {etichetta} (si riaccende quando chiudi il motore)', flush=True)

    def riaccendi():
        for plist in spenti:
            subprocess.run(['launchctl', 'bootstrap', DOMINIO, plist], capture_output=True)
        if spenti:
            print(f'riacceso: {", ".join(os.path.basename(p) for p in spenti)}', flush=True)
    atexit.register(riaccendi)


def lavoratore_stt(richieste, risposte, genitore):
    # Processo a parte: così l'ascolto non aspetta mai che la voce finisca di generare.
    # Se il motore principale muore (anche con kill), questo si chiude da solo: un processo
    # orfano terrebbe occupati ~3-6 GB di memoria per sempre.
    import queue, signal
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # Ctrl-C lo gestisce il motore principale, che chiude anche questo
    if STT_MLX:
        import mlx.core as mx
        from mlx_audio.stt.utils import load_model as carica_stt
        modello = carica_stt(STT_MODELLO)
    else:
        from faster_whisper import WhisperModel
        modello = WhisperModel(STT_MODELLO, device='cpu', compute_type='int8')
    if STT_MLX:  # le lunghezze più comuni, preparate all'avvio
        for secondi in range(2, 22, 2):
            modello.generate(mx.zeros(secondi * 16000, dtype=mx.float32))
    risposte.put('pronto')
    while True:
        try:
            pcm8k = richieste.get(timeout=2)
        except queue.Empty:
            if os.getppid() != genitore:
                return
            continue
        a = np.frombuffer(pcm8k, dtype='<i2').astype(np.float32) / 32768
        a = resample_poly(a, 2, 1).astype(np.float32)  # i modelli vogliono 16 kHz
        # MLX prepara i calcoli per ogni lunghezza nuova (~1 s la prima volta): si arrotonda a blocchi
        # di 2 secondi con silenzio in coda, così le lunghezze si ripetono e sono già pronte.
        blocco = 32000
        a = np.pad(a, (0, -len(a) % blocco))
        try:
            if STT_MLX:
                testo = modello.generate(mx.array(a)).text
            else:
                segmenti, _ = modello.transcribe(a, language='it', beam_size=1, vad_filter=False,
                                                 condition_on_previous_text=False)
                testo = ' '.join(x.text.strip() for x in segmenti)
        except Exception as e:  # audio troppo corto o strano: come se non avesse detto niente
            print('errore ascolto:', e, flush=True)
            testo = ''
        risposte.put(testo.strip())


voce = None
SR_TTS = 24000
if __name__ == '__main__':
    print(f'carico Qwen3-TTS "{TTS_MODELLO}"...', flush=True)
    from mlx_audio.tts.utils import load_model
    voce = load_model(TTS_MODELLO)
    SR_TTS = voce.sample_rate
blocco_tts = threading.Lock()  # MLX lavora un pezzo alla volta
blocco_stt = threading.Lock()


def a_8k(audio):
    a = resample_poly(np.asarray(audio, dtype=np.float32), 1, SR_TTS // 8000) if SR_TTS % 8000 == 0 \
        else resample_poly(np.asarray(audio, dtype=np.float32), 8000, SR_TTS)
    return (np.clip(a, -1, 1) * 32767).astype('<i2').tobytes()


LINGUE = {'it': 'italian', 'de': 'german'}  # lingua della frase → lingua di Qwen3-TTS


def parla(testo, nome_voce=None, lingua='italian'):
    # tetto all'audio: il codec fa 12 passi al secondo e una persona dice almeno ~8 caratteri al secondo.
    # Senza tetto, ogni tanto il modello non si ferma più e genera minuti di silenzio o rumore.
    massimo = int(12 * (len(testo) / 8 + 1.5))
    kw = dict(text=testo, lang_code=lingua, stream=True, streaming_interval=0.25, temperature=TTS_TEMPERATURA,
              max_tokens=massimo)
    if TTS_RIF_AUDIO:
        kw.update(ref_audio=TTS_RIF_AUDIO, ref_text=TTS_RIF_TESTO)
    else:
        kw.update(voice=nome_voce or TTS_VOCE, instruct=TTS_ISTRUZIONI)
    # Con la voce clonata, finita la frase il modello a volte va avanti con rumore o pezzi del campione.
    # Quando ha già detto praticamente tutto (~12 caratteri al secondo) e arriva una pausa lunga, ci si ferma.
    atteso = len(testo) / 12
    passo = SR_TTS // 20  # 50 ms
    detto = silenzio = 0.0
    for r in voce.generate(**kw):
        a = np.asarray(r.audio, dtype=np.float32)
        for i in range(0, len(a), passo):
            pezzo = a[i:i + passo]
            silenzio = silenzio + 0.05 if np.sqrt(np.mean(pezzo ** 2)) < 0.01 else 0.0
            detto += 0.05
            if detto > 0.9 * atteso and silenzio >= 0.5:
                yield a_8k(a[:i + len(pezzo)])
                return
        yield a_8k(a)


def ascolta(pcm8k):
    richieste.put(pcm8k)
    return risposte.get()


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Node chiude le connessioni inattive o interrompe una frase: è normale, niente traceback
        import sys
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


class Gestore(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _json(self, codice, o):
        b = json.dumps(o).encode()
        self.send_response(codice)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path == '/salute':
            return self._json(200, {'ok': True, 'stt': STT_MODELLO, 'tts': TTS_MODELLO, 'voce': TTS_RIF_AUDIO or TTS_VOCE})
        self._json(404, {})

    def do_POST(self):
        corpo = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if self.path == '/stt':
            t = time.time()
            voce_occupata = blocco_tts.locked()
            with blocco_stt:
                testo = ascolta(corpo)
            return self._json(200, {'testo': testo, 'ms': round((time.time() - t) * 1000), 'voce_occupata': voce_occupata})
        if self.path == '/tts':
            richiesta = json.loads(corpo or b'{}')
            self.send_response(200)
            self.send_header('Content-Type', 'audio/L16; rate=8000')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            try:
                with blocco_tts:
                    for pezzo in parla(richiesta.get('testo', ''), richiesta.get('voce'), LINGUE.get(richiesta.get('lingua'), 'italian')):
                        self.wfile.write(f'{len(pezzo):X}\r\n'.encode() + pezzo + b'\r\n')
                        self.wfile.flush()
                self.wfile.write(b'0\r\n\r\n')
            except (BrokenPipeError, ConnectionResetError):
                pass  # il cliente ha interrotto: la frase non serve più
            return
        self._json(404, {})


if __name__ == '__main__':
    import multiprocessing as mp
    ctx = mp.get_context('spawn')
    richieste, risposte = ctx.Queue(), ctx.Queue()
    print(f'carico "{STT_MODELLO}" (processo a parte)...', flush=True)
    figlio = ctx.Process(target=lavoratore_stt, args=(richieste, risposte, os.getpid()), daemon=True)
    figlio.start()
    import signal, atexit
    atexit.register(figlio.terminate)
    def esci(*_):
        # una volta sola: un secondo Ctrl-C durante la chiusura non deve interromperla
        for x in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(x, signal.SIG_IGN)
        sys.exit(0)
    for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):  # kill, Ctrl-C, terminale chiuso → uscita pulita
        signal.signal(s, esci)
    risposte.get()
    # un giro a vuoto: il primo uso di MLX è lento, meglio farlo adesso
    for _ in parla('Pronto.'):
        pass
    ascolta(np.zeros(8000, dtype='<i2').tobytes())
    print(f'Motore vocale pronto su http://127.0.0.1:{PORTA}', flush=True)
    Server(('127.0.0.1', PORTA), Gestore).serve_forever()
