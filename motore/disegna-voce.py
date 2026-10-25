# Crea il campione della voce del receptionist con Qwen3-TTS VoiceDesign (descrizione a parole),
# poi il motore la clona con il modello Base: stessa voce in ogni frase, e veloce.
# Uso: python3 motore/disegna-voce.py [maschile|femminile] [quante proposte]  → voci/proposta-*.wav
import sys, time
from pathlib import Path
import numpy as np, soundfile as sf
from mlx_audio.tts.utils import load_model

RADICE = Path(__file__).resolve().parent.parent
TIPO = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].isdigit() else 'maschile'
n = int(sys.argv[2]) if TIPO != 'maschile' and len(sys.argv) > 2 else (int(sys.argv[1]) if len(sys.argv) > 1 else 3)
DESCRIZIONI = {
    'maschile': (
        "A 35-year-old man from Milan, Italy, talking on the phone with a customer he likes. "
        "Native Italian with a natural Milanese accent and the lively, musical intonation of a real Milanese speaker. "
        "Warm, friendly and confident, you can hear him smiling; engaging and persuasive like a good salesperson, "
        "expressive and dynamic, varied pitch and natural rhythm, never monotone, never flat, never robotic. "
        "Spontaneous conversational delivery, not reading a script."
    ),
    'femminile': (
        "A 32-year-old woman from Milan, Italy, talking on the phone with a customer she knows well. "
        "Native Italian with a natural, lightly Milanese accent and lively musical intonation. "
        "Warm, natural and professional: friendly and clear, composed but with warmth, you can hear a subtle smile. "
        "Expressive but never exaggerated, varied pitch and natural rhythm, never monotone, never flat, never robotic. "
        "Spontaneous conversational delivery, not reading a script."
    ),
    'femminile-anziene': (
        "A 40-year-old professional woman from Milan, Italy, with experience as a front-desk secretary, "
        "talking on the phone with a customer. Native Italian, clear and precise diction, lightly Milanese accent. "
        "Calm, trustworthy and professional voice, warm and reassuring, natural conversational rhythm, "
        "varied pitch, never monotone, never robotic, not reading a script."
    ),
}
DESCRIZIONE = DESCRIZIONI.get(TIPO, DESCRIZIONI['maschile'])
PREFISSO = 'proposta' if TIPO == 'maschile' else f'proposta-{TIPO}'
# Testo del campione: frasi normali, senza intercalari ("allora", "ehm"), che il clone tende poi a ripetere.
TESTO = ("Buongiorno, la sento bene. Per il tagliando ho posto giovedì mattina alle nove, oppure venerdì alle due "
         "del pomeriggio. Mi lascia il suo nome e il modello della macchina, così la segno subito.")

m = load_model("mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit")
(RADICE / 'voci').mkdir(exist_ok=True)
for i in range(1, n + 1):
    t = time.time()
    a = np.concatenate([np.array(r.audio) for r in m.generate(text=TESTO, instruct=DESCRIZIONE, lang_code='italian', temperature=0.8)])
    f = RADICE / 'voci' / f'{PREFISSO}-{i}.wav'
    sf.write(f, a, m.sample_rate)
    print(f'{f.name}: {len(a) / m.sample_rate:.1f} s di audio in {time.time() - t:.1f} s', flush=True)
(RADICE / 'voci' / 'testo.txt').write_text(TESTO)
