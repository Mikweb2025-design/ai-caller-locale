# Il motore vocale locale: orecchie (Parakeet v3 su MLX, oppure faster-whisper) e voce (Qwen3-TTS su MLX).
# Tutto open source e tutto su questo Mac: niente servizi a pagamento.
#
#   POST /stt   corpo: PCM 16 bit mono 8 kHz (audio del telefono)  → {"testo": "..."}
#   POST /tts   {"testo": "...", "voce": "ryan"}  → PCM 16 bit mono 8 kHz, in streaming
#   GET  /salute
#
# Uso: python3 motore/motore.py   (le impostazioni arrivano dal .env del progetto)
import itertools, json, math, os, queue, re, subprocess, sys, threading, time, wave
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
TTS_TEMPERATURA = float(os.environ.get('TTS_TEMPERATURA') or 0.72)  # più bassa = più piatta, più alta = più espressiva (e meno prevedibile)
TTS_TOP_P = float(os.environ.get('TTS_TOP_P') or 0.93)  # varietà sufficiente per una cadenza meno meccanica
TTS_TOP_K = int(os.environ.get('TTS_TOP_K') or 40)
TTS_RIPETIZIONE = float(os.environ.get('TTS_RIPETIZIONE') or 1.08)
TTS_SEME = int(os.environ.get('TTS_SEME') or 18)  # stessa voce e cadenza anche dopo un riavvio
TTS_VOCE = os.environ.get('TTS_VOCE', 'ryan')
TTS_ISTRUZIONI = os.environ.get('TTS_ISTRUZIONI', '') or None
# clonazione da un campione (solo con i modelli "Base"): file wav a 24 kHz e la sua trascrizione
TTS_RIF_AUDIO = os.environ.get('TTS_RIF_AUDIO', '') or None
TTS_RIF_TESTO = os.environ.get('TTS_RIF_TESTO', '') or None
if not TTS_RIF_AUDIO and CAMPIONE.exists() and 'Base' in TTS_MODELLO:
    TTS_RIF_AUDIO = str(CAMPIONE)
    TTS_RIF_TESTO = (RADICE / 'voci' / 'testo.txt').read_text().strip()

STT_MLX = '/' in STT_MODELLO
SILENZIO_STT = np.zeros(8000, dtype='<i2').tobytes()
pcm_riscaldamento_stt = SILENZIO_STT
rif_riscaldamento_tts = None


def carica_pcm_riscaldamento_stt(percorso=CAMPIONE):
    """Converte un breve parlato WAV in PCM telefonico; il silenzio resta il fallback sicuro."""
    try:
        with wave.open(str(percorso), 'rb') as wav:
            canali = wav.getnchannels()
            frequenza = wav.getframerate()
            if wav.getsampwidth() != 2 or canali < 1 or frequenza <= 0:
                return SILENZIO_STT
            audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2')
        if canali > 1:
            audio = audio[:len(audio) - len(audio) % canali].reshape(-1, canali).mean(axis=1)
        audio = audio.astype(np.float32)
        if frequenza != 8000:
            divisore = math.gcd(frequenza, 8000)
            audio = resample_poly(audio, 8000 // divisore, frequenza // divisore)
        if len(audio) == 0:
            return SILENZIO_STT
        return np.clip(audio, -32768, 32767).astype('<i2').tobytes()
    except (OSError, EOFError, wave.Error, ValueError):
        return SILENZIO_STT


def riferimento_voce_attiva(dati_dir=None, voci_dir=None):
    """Restituisce campione e testo scelti nell'admin, senza accettare percorsi esterni."""
    dati_dir = Path(os.environ.get('DATI_DIR') or RADICE / 'dati') if dati_dir is None else Path(dati_dir)
    voci_dir = RADICE / 'voci' if voci_dir is None else Path(voci_dir)
    try:
        impostazioni = json.loads((dati_dir / 'impostazioni.json').read_text())
        campione = str(impostazioni.get('receptionist', {}).get('voce', {}).get('campione') or '').strip()
        if not campione or campione.startswith('.') or Path(campione).name != campione:
            return None
        audio = voci_dir / campione
        if not audio.is_file():
            return None
        metadati = voci_dir / (campione[:-4] + '.json' if campione.endswith('.wav') else campione + '.json')
        testo = json.loads(metadati.read_text()).get('testo') if metadati.is_file() else None
        return str(audio), testo
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _leggi_intervallo(nome, predefinito, minimo, environ=None):
    """Legge secondi finiti e non negativi: zero spegne, i valori positivi hanno un minimo."""
    environ = os.environ if environ is None else environ
    try:
        valore = float(environ.get(nome, str(predefinito)))
    except (TypeError, ValueError):
        return predefinito
    if not math.isfinite(valore) or valore < 0:
        return predefinito
    if valore == 0:
        return 0
    return max(minimo, valore)


# Dopo una lunga inattività macOS può comprimere o spostare su swap i modelli MLX. Un piccolo
# giro periodico evita che la prima frase del cliente debba ricaricarli. Zero disabilita la funzione.
KEEPWARM_SECONDI = _leggi_intervallo('MOTORE_KEEPWARM_S', 300, 60)
CONTROLLO_SERVIZI_SECONDI = _leggi_intervallo('MOTORE_CONTROLLO_SERVIZI_S', 60, 30)
STT_AVVIO_TIMEOUT_S = _leggi_intervallo('MOTORE_STT_AVVIO_TIMEOUT_S', 120, 30)
if STT_AVVIO_TIMEOUT_S == 0:  # l'avvio non può essere atteso indefinitamente né saltato
    STT_AVVIO_TIMEOUT_S = 120
ALLOWLIST_SERVIZI = frozenset(('com.qwen3tts.8091', 'com.qwen3tts.8092'))
SERVIZI_CONCORRENTI = tuple(dict.fromkeys(
    x for x in (voce.strip() for voce in os.environ.get(
        'SPEGNI_SERVIZI', 'com.qwen3tts.8091,com.qwen3tts.8092').split(','))
    if x in ALLOWLIST_SERVIZI
))
DOMINIO = f'gui/{os.getuid()}'
servizi_spenti = {}
blocco_servizi = threading.Lock()
stop_guardia_servizi = threading.Event()
thread_guardia_servizi = None
LAUNCHCTL = '/bin/launchctl'
TIMEOUT_LAUNCHCTL_S = 5
TIMEOUT_JOIN_GUARDIA_S = TIMEOUT_LAUNCHCTL_S + 2
TENTATIVI_BOOTSTRAP = 2
RITARDO_BOOTSTRAP_S = 0.2


def _launchctl(argomenti, esegui):
    try:
        return esegui([LAUNCHCTL, *argomenti], capture_output=True, text=True,
                      timeout=TIMEOUT_LAUNCHCTL_S)
    except (subprocess.TimeoutExpired, OSError) as errore:
        print(f'launchctl {argomenti[0]} non riuscito: {type(errore).__name__}', flush=True)
        return None


def ferma_servizi_concorrenti(esegui=subprocess.run, stop=None):
    """Ferma i servizi launchd pesanti ricomparsi e ricorda solo quelli davvero attivi."""
    fermati = []
    for etichetta in SERVIZI_CONCORRENTI:
        if stop is not None and stop.is_set():
            break
        if etichetta not in ALLOWLIST_SERVIZI:
            continue
        info = _launchctl(['print', f'{DOMINIO}/{etichetta}'], esegui)
        if info is None:
            continue
        percorso = re.search(r'^\s*path = (.+)$', info.stdout or '', re.M)
        if info.returncode != 0 or not percorso:
            continue
        if stop is not None and stop.is_set():
            break
        fermato = _launchctl(['bootout', f'{DOMINIO}/{etichetta}'], esegui)
        if fermato is not None and fermato.returncode == 0:
            with blocco_servizi:
                servizi_spenti.setdefault(etichetta, percorso.group(1).strip())
            fermati.append(etichetta)
    for etichetta in fermati:
        print(f'spento {etichetta} (si riaccende quando chiudi il motore)', flush=True)
    return tuple(fermati)


def riaccendi_servizi_concorrenti(esegui=subprocess.run, tentativi=TENTATIVI_BOOTSTRAP,
                                  attesa_fn=time.sleep):
    """Riattiva una sola volta i servizi che questo processo aveva fermato."""
    with blocco_servizi:
        da_riaccendere = tuple(servizi_spenti.items())
    riaccesi = []
    for etichetta, plist in da_riaccendere:
        risultato = None
        for numero in range(max(1, tentativi)):
            risultato = _launchctl(['bootstrap', DOMINIO, plist], esegui)
            if risultato is not None and risultato.returncode == 0:
                break
            if numero + 1 < max(1, tentativi):
                attesa_fn(RITARDO_BOOTSTRAP_S)
        if risultato is not None and risultato.returncode == 0:
            with blocco_servizi:
                if servizi_spenti.get(etichetta) == plist:
                    servizi_spenti.pop(etichetta, None)
            riaccesi.append(etichetta)
        else:
            print(f'riavvio fallito: {etichetta}', flush=True)
    if riaccesi:
        print(f'riacceso: {", ".join(riaccesi)}', flush=True)
    return tuple(riaccesi)


def sorveglia_servizi_concorrenti(stop=None):
    """Ricontrolla launchd: altri watchdog non devono riaccendere Qwen mentre Maria è attiva."""
    if not SERVIZI_CONCORRENTI or CONTROLLO_SERVIZI_SECONDI <= 0:
        return
    stop = stop or threading.Event()
    while not stop.wait(CONTROLLO_SERVIZI_SECONDI):
        ferma_servizi_concorrenti(stop=stop)


def arresta_guardia_e_riaccendi(esegui=subprocess.run, stop=None, thread=None):
    """Ferma e attende la guardia prima di ripristinare i servizi senza corse all'uscita."""
    stop = stop_guardia_servizi if stop is None else stop
    thread = thread_guardia_servizi if thread is None else thread
    stop.set()
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=TIMEOUT_JOIN_GUARDIA_S)
        if thread.is_alive():
            print('guardia servizi: arresto oltre il timeout', flush=True)
    return riaccendi_servizi_concorrenti(esegui=esegui)


def proteggi_log_motore(cartella=None):
    """Restringe i log launchd senza modificare registrazioni e output delle chiamate."""
    cartella = RADICE / 'registrazioni' if cartella is None else Path(cartella)
    try:
        cartella.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(cartella, 0o700)
        for nome in ('launchd-motore.log', 'launchd-motore-error.log'):
            percorso = cartella / nome
            percorso.touch(mode=0o600, exist_ok=True)
            os.chmod(percorso, 0o600)
    except OSError as errore:
        print(f'permessi log motore non aggiornati: {type(errore).__name__}', flush=True)

if __name__ == '__main__':
    proteggi_log_motore()
    # porta occupata = c'è già un motore acceso: meglio dirlo subito che dopo aver caricato i modelli
    import socket, sys
    with socket.socket() as prova:
        if prova.connect_ex(('127.0.0.1', PORTA)) == 0:
            sys.exit(f'La porta {PORTA} è già occupata: probabilmente il motore vocale è già acceso '
                     f'(curl http://127.0.0.1:{PORTA}/salute). Spegnilo o cambia MOTORE_PORTA nel .env.')

    # Altri servizi pesanti (launchd) da spegnere mentre il receptionist è acceso, per non finire
    # la memoria: si fermano adesso e si riaccendono quando il motore si chiude.
    import atexit
    ferma_servizi_concorrenti()
    atexit.register(arresta_guardia_e_riaccendi)
    if SERVIZI_CONCORRENTI and CONTROLLO_SERVIZI_SECONDI > 0:
        stop_guardia_servizi.clear()
        thread_guardia_servizi = threading.Thread(
            target=sorveglia_servizi_concorrenti, args=(stop_guardia_servizi,),
            name='guardia-servizi', daemon=True)
        thread_guardia_servizi.start()


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
            richiesta = richieste.get(timeout=2)
        except queue.Empty:
            if os.getppid() != genitore:
                return
            continue
        if isinstance(richiesta, tuple) and len(richiesta) == 2:
            id_richiesta, pcm8k = richiesta
        else:  # compatibilità con eventuali richieste già accodate durante un aggiornamento
            id_richiesta, pcm8k = None, richiesta
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
        risposta = testo.strip()
        risposte.put((id_richiesta, risposta) if id_richiesta is not None else risposta)


voce = None
SR_TTS = 24000
if __name__ == '__main__':
    print(f'carico Qwen3-TTS "{TTS_MODELLO}"...', flush=True)
    from mlx_audio.tts.utils import load_model
    voce = load_model(TTS_MODELLO)
    SR_TTS = voce.sample_rate
blocco_tts = threading.Lock()  # MLX lavora un pezzo alla volta
blocco_stt = threading.Lock()
blocco_ultimo_uso = threading.Lock()
ultimo_uso_tts = time.monotonic()
ultimo_uso_stt = time.monotonic()


def a_8k(audio):
    a = resample_poly(np.asarray(audio, dtype=np.float32), 1, SR_TTS // 8000) if SR_TTS % 8000 == 0 \
        else resample_poly(np.asarray(audio, dtype=np.float32), 8000, SR_TTS)
    return (np.clip(a, -1, 1) * 32767).astype('<i2').tobytes()


LINGUE = {'it': 'italian', 'de': 'german'}  # lingua della frase → lingua di Qwen3-TTS


def parla(testo, nome_voce=None, lingua='italian', rif=None, seme=None):
    # tetto all'audio: il codec fa 12 passi al secondo e una persona dice almeno ~8 caratteri al secondo.
    # Senza tetto, ogni tanto il modello non si ferma più e genera minuti di silenzio o rumore.
    massimo = int(12 * (len(testo) / 8 + 1.5))
    kw = dict(text=testo, lang_code=lingua, stream=True, streaming_interval=0.25, temperature=TTS_TEMPERATURA,
              top_p=TTS_TOP_P, top_k=TTS_TOP_K, repetition_penalty=TTS_RIPETIZIONE, max_tokens=massimo)
    if 'CustomVoice' in TTS_MODELLO:
        # Le voci integrate accettano istruzioni di stile a ogni battuta; un eventuale campione scelto
        # nel pannello non va passato, perché CustomVoice non è un modello di clonazione.
        kw.update(voice=nome_voce or TTS_VOCE, instruct=TTS_ISTRUZIONI)
    elif rif:
        # campione scelto dal pannello: (percorso, trascrizione); se non ha trascrizione propria, quella globale
        kw.update(ref_audio=rif[0], ref_text=rif[1] or TTS_RIF_TESTO or '')
    elif TTS_RIF_AUDIO:
        kw.update(ref_audio=TTS_RIF_AUDIO, ref_text=TTS_RIF_TESTO)
    else:
        kw.update(voice=nome_voce or TTS_VOCE, instruct=TTS_ISTRUZIONI)
    # Con la voce clonata, finita la frase il modello a volte va avanti con rumore o pezzi del campione.
    # Quando ha già detto praticamente tutto (~12 caratteri al secondo) e arriva una pausa lunga, ci si ferma.
    atteso = len(testo) / 12
    passo = SR_TTS // 20  # 50 ms
    detto = silenzio = 0.0
    import mlx.core as mx
    mx.random.seed(int(TTS_SEME if seme is None else seme) & 0xffffffff)
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


def parla_riscaldamento_tts(testo):
    """Scalda la stessa voce configurata nell'admin, non solo il campione predefinito."""
    yield from parla(testo, rif=rif_riscaldamento_tts)


STT_RISPOSTA_TIMEOUT_S = 30.0
SOGLIA_TIMEOUT_STT = 2
_id_richieste_stt = itertools.count(1)
blocco_stato_stt = threading.Lock()
timeout_stt_consecutivi = 0
riavvio_motore_richiesto = False


class STTNonDisponibile(RuntimeError):
    pass


def stt_vivo(processo=None):
    processo = globals().get('figlio') if processo is None else processo
    if processo is None:
        return False
    try:
        return bool(processo.is_alive())
    except (AttributeError, AssertionError, OSError):
        return False


def _verifica_figlio_stt(processo):
    if processo is None:
        return
    if not stt_vivo(processo):
        raise STTNonDisponibile('processo STT terminato')


def registra_successo_stt():
    global timeout_stt_consecutivi
    with blocco_stato_stt:
        timeout_stt_consecutivi = 0


def richiedi_riavvio_motore(termina_fn=None, timer_factory=threading.Timer):
    """Termina il parent poco dopo la risposta HTTP; launchd KeepAlive lo ricrea pulito."""
    if termina_fn is None:
        def termina_fn():
            import signal
            os.kill(os.getpid(), signal.SIGTERM)
    timer = timer_factory(0.2, termina_fn)
    timer.daemon = True
    timer.start()


def gestisci_errore_stt(errore, riavvia_fn=None):
    """Riavvia subito col figlio morto, o dopo due timeout consecutivi col figlio vivo."""
    global riavvio_motore_richiesto, timeout_stt_consecutivi
    riavvia_fn = richiedi_riavvio_motore if riavvia_fn is None else riavvia_fn
    with blocco_stato_stt:
        if isinstance(errore, TimeoutError):
            timeout_stt_consecutivi += 1
            deve_riavviare = timeout_stt_consecutivi >= SOGLIA_TIMEOUT_STT
        else:
            deve_riavviare = isinstance(errore, STTNonDisponibile)
        if not deve_riavviare or riavvio_motore_richiesto:
            return False
        riavvio_motore_richiesto = True
    print('riavvio motore richiesto: STT non disponibile', flush=True)
    riavvia_fn()
    return True


def ascolta(pcm8k, timeout=STT_RISPOSTA_TIMEOUT_S, richieste_queue=None,
            risposte_queue=None, processo=None):
    """Invia audio allo STT e fallisce in modo controllato se il figlio non risponde."""
    richieste_queue = globals().get('richieste') if richieste_queue is None else richieste_queue
    risposte_queue = globals().get('risposte') if risposte_queue is None else risposte_queue
    processo = globals().get('figlio') if processo is None else processo
    if richieste_queue is None or risposte_queue is None:
        raise STTNonDisponibile('code STT non inizializzate')
    _verifica_figlio_stt(processo)
    id_richiesta = next(_id_richieste_stt)
    richieste_queue.put((id_richiesta, pcm8k))
    scadenza = time.monotonic() + max(0.0, timeout)
    while True:
        _verifica_figlio_stt(processo)
        restante = scadenza - time.monotonic()
        if restante <= 0:
            raise TimeoutError(f'STT non risponde da {timeout:g}s')
        try:
            risposta = risposte_queue.get(timeout=min(0.25, restante))
        except queue.Empty:
            continue
        except (EOFError, OSError) as errore:
            raise STTNonDisponibile('coda STT chiusa') from errore
        if isinstance(risposta, tuple) and len(risposta) == 2:
            id_risposta, testo = risposta
            if id_risposta != id_richiesta:  # risultato tardivo di una richiesta scaduta
                continue
            registra_successo_stt()
            return testo
        registra_successo_stt()
        return risposta


def segna_uso(quale, adesso=None):
    global ultimo_uso_tts, ultimo_uso_stt
    adesso = time.monotonic() if adesso is None else adesso
    with blocco_ultimo_uso:
        if quale == 'tts':
            ultimo_uso_tts = adesso
        else:
            ultimo_uso_stt = adesso


def _inattivo(quale, adesso):
    with blocco_ultimo_uso:
        ultimo = ultimo_uso_tts if quale == 'tts' else ultimo_uso_stt
    return adesso - ultimo >= KEEPWARM_SECONDI


def mantieni_caldi_una_volta(adesso=None, parla_fn=None, ascolta_fn=None):
    """Scalda senza attendere lock occupati; ritorna i modelli effettivamente toccati."""
    if KEEPWARM_SECONDI <= 0:
        return ()
    parla_fn = parla_riscaldamento_tts if parla_fn is None else parla_fn
    ascolta_fn = ascolta if ascolta_fn is None else ascolta_fn
    tempo_forzato = adesso
    adesso = time.monotonic() if adesso is None else adesso
    scaldati = []

    if _inattivo('tts', adesso) and blocco_tts.acquire(blocking=False):
        try:
            if _inattivo('tts', adesso):  # una richiesta può essere arrivata mentre prendevamo il lock
                for _ in parla_fn('Pronto.'):
                    pass
                segna_uso('tts', tempo_forzato)
                scaldati.append('tts')
        finally:
            blocco_tts.release()

    if _inattivo('stt', adesso) and blocco_stt.acquire(blocking=False):
        try:
            if _inattivo('stt', adesso):
                ascolta_fn(pcm_riscaldamento_stt)
                segna_uso('stt', tempo_forzato)
                scaldati.append('stt')
        finally:
            blocco_stt.release()
    return tuple(scaldati)


def mantieni_modelli_caldi(stop=None, scalda_fn=None):
    if KEEPWARM_SECONDI <= 0:
        return
    stop = stop or threading.Event()
    scalda_fn = mantieni_caldi_una_volta if scalda_fn is None else scalda_fn
    attesa = max(1.0, min(60.0, KEEPWARM_SECONDI / 2))
    while not stop.wait(attesa):
        try:
            scaldati = scalda_fn()
        except Exception as errore:
            print(f'keepwarm non riuscito: {type(errore).__name__}', flush=True)
            if isinstance(errore, (TimeoutError, STTNonDisponibile)):
                gestisci_errore_stt(errore)
            continue
        if scaldati:
            print(f'modelli mantenuti caldi: {", ".join(scaldati)}', flush=True)


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
            vivo = stt_vivo()
            self._json(200 if vivo else 503, {
                'ok': vivo, 'stt_vivo': vivo, 'stt': STT_MODELLO,
                'tts': TTS_MODELLO, 'voce': TTS_RIF_AUDIO or TTS_VOCE,
            })
            if not vivo:
                gestisci_errore_stt(STTNonDisponibile('processo STT terminato'))
            return
        self._json(404, {})

    def do_POST(self):
        corpo = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        if self.path == '/stt':
            t = time.time()
            voce_occupata = blocco_tts.locked()
            segna_uso('stt')
            try:
                try:
                    with blocco_stt:
                        testo = ascolta(corpo)
                except (TimeoutError, STTNonDisponibile) as errore:
                    print(f'stt non disponibile: {errore}', flush=True)
                    self._json(503, {'testo': '', 'errore': 'STT non disponibile'})
                    gestisci_errore_stt(errore)
                    return
            finally:
                segna_uso('stt')
            return self._json(200, {'testo': testo, 'ms': round((time.time() - t) * 1000), 'voce_occupata': voce_occupata})
        if self.path == '/tts':
            richiesta = json.loads(corpo or b'{}')
            # la voce cambiata dal pannello: un file .wav della cartella voci/ (la trascrizione sta in voci/<nome>.json)
            rif = None
            campione = str(richiesta.get('campione') or '').strip()
            if campione:
                a = RADICE / 'voci' / campione
                if '/' not in campione and not campione.startswith('.') and a.is_file():
                    t = None
                    j = RADICE / 'voci' / (campione[:-4] + '.json' if campione.endswith('.wav') else campione + '.json')
                    if j.is_file():
                        try:
                            t = json.loads(j.read_text()).get('testo')
                        except Exception:
                            pass
                    rif = (str(a), t)
            self.send_response(200)
            self.send_header('Content-Type', 'audio/L16; rate=8000')
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()
            segna_uso('tts')
            try:
                try:
                    with blocco_tts:
                        for pezzo in parla(richiesta.get('testo', ''), richiesta.get('voce'), LINGUE.get(richiesta.get('lingua'), 'italian'), rif=rif, seme=richiesta.get('seme')):
                            self.wfile.write(f'{len(pezzo):X}\r\n'.encode() + pezzo + b'\r\n')
                            self.wfile.flush()
                    self.wfile.write(b'0\r\n\r\n')
                except (BrokenPipeError, ConnectionResetError):
                    pass  # il cliente ha interrotto: la frase non serve più
            finally:
                segna_uso('tts')
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
    try:
        pronto = risposte.get(timeout=STT_AVVIO_TIMEOUT_S)
    except queue.Empty:
        sys.exit(f'STT non pronto dopo {STT_AVVIO_TIMEOUT_S:g}s')
    if pronto != 'pronto':
        sys.exit('risposta inattesa durante avvio STT')
    # Un giro prima di aprire la porta: la prima decodifica MLX è lenta. Per STT serve parlato
    # reale, perché il silenzio non esercita il percorso dei token usato durante una telefonata.
    pcm_riscaldamento_stt = carica_pcm_riscaldamento_stt()
    rif_riscaldamento_tts = riferimento_voce_attiva()
    for _ in parla_riscaldamento_tts('Pronto.'):
        pass
    ascolta(pcm_riscaldamento_stt)
    segna_uso('tts')
    segna_uso('stt')
    if KEEPWARM_SECONDI > 0:
        threading.Thread(target=mantieni_modelli_caldi, name='keepwarm-modelli', daemon=True).start()
    print(f'Motore vocale pronto su http://127.0.0.1:{PORTA}', flush=True)
    Server(('127.0.0.1', PORTA), Gestore).serve_forever()
