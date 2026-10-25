# Crea il campione della voce del receptionist con Qwen3-TTS VoiceDesign (descrizione a parole),
# poi il motore la clona con il modello Base: stessa voce in ogni frase, e veloce.
# Uso: python3 motore/disegna-voce.py [maschile|femminile] [quante proposte]  → voci/proposta-*.wav
import sys, time, os
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
    'femminile-v2': [
        "A 28-year-old Italian woman from Milan, born and raised in Italy, talking on the phone with a customer she knows well. Completely native Italian, light Milanese accent, lively melodic intonation typical of real Italian speakers. Warm and quick, you can hear her smile, natural rhythm changes, expressive but never theatrical. Not robotic, not flat, not reading a script, no English-sounding pronunciation.",
        "A 35-year-old Italian woman from northern Italy who has answered the phone for years in a small family business. Fully native Italian, natural northern accent, clear and friendly. She speaks exactly like a real Italian business owner on the phone: relaxed, brisk enough to sound human, warm emphasis on the important words, melodic Italian prosody with natural ups and downs. Not robotic, not flat, not a newsreader, no English pronunciation.",
        "A 45-year-old Italian woman, experienced and serene, from Milan, talking politely on the phone with a loyal customer. Fully native Italian, natural and calm, medium-low warm female voice, measured but alive, with the melodic cadence of spoken Italian. Kind and reassuring, like a trusted person of the family business. Natural rhythm with slight tempo changes, never robotic, never flat, never like an advert, no English pronunciation.",
        "A 24-year-old Italian woman from Milan, young and energetic, warmly joking on the phone with a friendly customer. Completely native Italian with authentic young Milanese intonation. Lively and bright but polite, expressive Italian melody with natural ups and downs. Sounds like a real young Italian talking to someone she likes, not a synthesizer: no monotone, no robotic pauses, no English accent.",
        "A 32-year-old Italian woman, warm and a little playful, from northern Italy, chatting amiably with a customer she likes on the phone. Fully native Italian, natural accent, soft warm voice with a fine smile in the tone. Italian conversational melody, expressive emphasis, human rhythm with natural breathing. Professional but with charm, never cold, never robotic, never flat, never reading, no English pronunciation.",
    ],
    'maria-naturale': (
        "A 32-year-old Italian receptionist from Milan speaking calmly with one customer on the phone. "
        "Fully native Italian, a soft medium-low voice and a light northern Italian accent. Restrained, everyday "
        "conversational delivery: relaxed pace, subtle smile, modest pitch variation and small natural breaths. "
        "She follows commas, full stops and questions with realistic pauses, without overacting. No advertising tone, "
        "no sing-song melody, no theatrical emotion, no exaggerated smile, no newsreader style, no robotic cadence."
    ),
}
des = DESCRIZIONI.get(TIPO)
DESCRIZIONE = des[0] if isinstance(des, list) else des
PREFISSO = 'proposta' if TIPO == 'maschile' else ('voce-f' if isinstance(des, list) else f'proposta-{TIPO}')
# Un riferimento breve e coerente clona meglio ritmo e timbro. Evitiamo intercalari e frasi isolate
# come "Bene.", che il modello tenderebbe a ripetere nelle telefonate.
TESTO = ("Buongiorno, mi dica pure. Sì, ho capito. Per martedì c'è un posto alle nove; "
         "in alternativa, mercoledì alle due del pomeriggio. Quale preferisce?")

m = load_model("mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit")
(RADICE / 'voci').mkdir(exist_ok=True)

RIPRESE = max(1, int(os.environ.get('RIPRESE', '1')))

def vivacita(a, sr):
    """Quanto la voce è viva: scarto del tono (Hz) sulle sillabe sonore e quante sono."""
    w, h = 960, 480  # 40 ms, salto 20 ms
    f0s = []
    for i in range(0, len(a) - w, h):
        fr = a[i:i+w]
        if float(np.sqrt((fr * fr).mean())) < 0.01:
            continue
        fr = fr - fr.mean()
        ac = np.correlate(fr, fr, 'full')[w - 1:]
        seg = ac[69:343]  # 70–350 Hz
        if float(seg.max()) < 0.25 * float(ac[0]):
            continue
        f0s.append(sr / (69 + int(seg.argmax())))
    if len(f0s) < 10:
        return 0.0, 0.0
    return float(np.std(f0s)), float(np.median(f0s))

for i in range(1, n + 1):
    t = time.time()
    d = des[(i - 1) % len(des)] if isinstance(des, list) else DESCRIZIONE
    f = RADICE / 'voci' / f'{PREFISSO}-{i}.wav'
    migliore = None
    for rip in range(RIPRESE):
        temperatura = float(os.environ.get('DESIGN_TEMPERATURA', '0.72'))
        a = np.concatenate([np.array(r.audio) for r in m.generate(text=TESTO, instruct=d, lang_code='italian', temperature=temperatura)])
        scarto, mediana = vivacita(a, m.sample_rate)
        if migliore is None or scarto > migliore[1]:
            migliore = (a, scarto, mediana, rip)
    sf.write(f, migliore[0], m.sample_rate)
    print(f'{f.name}: {len(migliore[0]) / m.sample_rate:.1f} s, tono {migliore[2]:.0f} Hz ± {migliore[1]:.1f} (ripresa {migliore[3] + 1}/{RIPRESE}), {time.time() - t:.1f} s', flush=True)
(RADICE / 'voci' / 'testo.txt').write_text(TESTO)
