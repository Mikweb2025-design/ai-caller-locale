# Genera una frase dimostrativa a 24 kHz con una voce clonata di voci/.
# Serve per i file audio della landing (demo-marco.mp3, demo-maria.mp3): stessa voce
# delle telefonate, ma senza il passaggio a 8 kHz del canale telefonico.
#
#   python3 motore/genera-demo.py --voce voci/marco.wav --testo "Buongiorno..." --uscita demo/demo-marco.mp3
#
# Se la voce ha la trascrizione in voci/<nome>.json, viene usata come riferimento (clonazione).
import argparse, json, subprocess, sys, wave
from pathlib import Path

import numpy as np

RADICE = Path(__file__).resolve().parent.parent
MODELLO = 'mlx-community/Qwen3-TTS-12Hz-0.6B-Base-8bit'
LINGUA = 'italian'
SEME = 18


def genera(testo, campione):
    import mlx.core as mx
    from mlx_audio.tts.utils import load_model

    voce = load_model(MODELLO)
    sr = voce.sample_rate
    meta = campione.with_suffix('.json')
    rif_testo = ''
    if meta.is_file():
        rif_testo = str(json.loads(meta.read_text()).get('testo') or '')
    mx.random.seed(SEME)
    pezzi = []
    for r in voce.generate(
        text=testo, lang_code=LINGUA, stream=True, streaming_interval=0.5,
        temperature=0.5, top_p=0.9, top_k=40, repetition_penalty=1.08,
        max_tokens=int(12 * (len(testo) / 8 + 1.5)),
        ref_audio=str(campione), ref_text=rif_testo,
    ):
        pezzi.append(np.asarray(r.audio, dtype=np.float32))
    audio = np.concatenate(pezzi) if pezzi else np.zeros(0, dtype=np.float32)
    # via il silenzio in testa e in coda (sotto -45 dBFS), con un margine di 40 ms
    soglia = 10 ** (-45 / 20)
    attivi = np.where(np.abs(audio) > soglia)[0]
    if len(attivi):
        margine = int(0.04 * sr)
        inizio, fine = max(0, attivi[0] - margine), min(len(audio), attivi[-1] + margine)
        audio = audio[inizio:fine]
    # dissolvenza di 15 ms e normalizzazione di picco a -1 dBFS
    n = min(int(0.015 * sr), len(audio) // 2)
    if n:
        audio[:n] *= np.linspace(0, 1, n)
        audio[-n:] *= np.linspace(1, 0, n)
    picco = float(np.max(np.abs(audio))) or 1.0
    audio = audio * (10 ** (-1 / 20) / picco)
    return (np.clip(audio, -1, 1) * 32767).astype('<i2'), sr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--testo', required=True)
    ap.add_argument('--voce', required=True, help='campione .wav in voci/ (24 kHz)')
    ap.add_argument('--uscita', required=True, help='file .wav o .mp3')
    a = ap.parse_args()

    campione = Path(a.voce)
    if not campione.is_absolute():
        campione = RADICE / campione
    if not campione.is_file():
        sys.exit(f'voce non trovata: {campione}')

    pcm, sr = genera(a.testo, campione)
    uscita = Path(a.uscita)
    if not uscita.is_absolute():
        uscita = RADICE / uscita
    uscita.parent.mkdir(parents=True, exist_ok=True)
    wav = uscita.with_suffix('.wav')
    with wave.open(str(wav), 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(sr)
        f.writeframes(pcm.tobytes())
    if uscita.suffix.lower() == '.mp3':
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(wav), '-ac', '1', '-b:a', '96k', str(uscita)], check=True)
    print(f'{uscita} — {len(pcm) / sr:.1f} s')
    if uscita.suffix.lower() == '.mp3':
        wav.unlink()


if __name__ == '__main__':
    main()
