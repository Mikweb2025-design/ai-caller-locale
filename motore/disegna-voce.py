# Crea il campione della voce del receptionist con Qwen3-TTS VoiceDesign (descrizione a parole),
# poi il motore la clona con il modello Base: stessa voce in ogni frase, e veloce.
# Uso: python3 motore/disegna-voce.py [quante proposte]   → voci/proposta-N.wav
import sys, time
from pathlib import Path
import numpy as np, soundfile as sf
from mlx_audio.tts.utils import load_model

RADICE = Path(__file__).resolve().parent.parent
DESCRIZIONE = (
    "A 35-year-old man born and raised in Milan, Italy, answering the phone at work. "
    "Native Italian with a clear, natural Milanese accent: northern Italian vowels, typical Milan intonation and rhythm. "
    "Relaxed, friendly and professional, conversational like a real person on a normal call, not a voice-over and not reading. "
    "Medium-low warm voice, calm even pace, natural small pauses, no excitement, no theatrical emphasis."
)
# Testo del campione: frasi normali, senza intercalari ("allora", "ehm"), che il clone tende poi a ripetere.
TESTO = ("Buongiorno, la sento bene. Per il tagliando ho posto giovedì mattina alle nove, oppure venerdì alle due "
         "del pomeriggio. Mi lascia il suo nome e il modello della macchina, così la segno subito.")

n = int(sys.argv[1]) if len(sys.argv) > 1 else 3
m = load_model("mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit")
(RADICE / 'voci').mkdir(exist_ok=True)
for i in range(1, n + 1):
    t = time.time()
    a = np.concatenate([np.array(r.audio) for r in m.generate(text=TESTO, instruct=DESCRIZIONE, lang_code='italian', temperature=0.6)])
    f = RADICE / 'voci' / f'proposta-{i}.wav'
    sf.write(f, a, m.sample_rate)
    print(f'{f.name}: {len(a) / m.sample_rate:.1f} s di audio in {time.time() - t:.1f} s', flush=True)
(RADICE / 'voci' / 'testo.txt').write_text(TESTO)
