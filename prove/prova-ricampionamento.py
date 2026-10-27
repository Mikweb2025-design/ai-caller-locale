# La voce "metallica a tratti" nasceva qui: ogni pezzo da 0,25 s veniva ricampionato da
# solo, quindi il filtro ripartiva da zero a ogni confine. Il convertitore nuovo deve
# dare lo stesso risultato di un ricampionamento unico di tutta la frase.
import importlib.util
import sys
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

radice = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('motore', radice / 'motore' / 'motore.py')
motore = importlib.util.module_from_spec(spec)
sys.modules['motore'] = motore
spec.loader.exec_module(motore)

SR = 24000
rng = np.random.default_rng(7)
t = np.arange(int(SR * 1.5)) / SR
segnale = (0.4 * np.sin(2 * np.pi * 180 * t) + 0.2 * np.sin(2 * np.pi * 900 * t)
           + 0.05 * rng.standard_normal(len(t))).astype(np.float32)
segnale *= np.hanning(len(segnale)).astype(np.float32)

from scipy.signal import sosfilt, sosfilt_zi
sos = motore.Convertitore8k(SR).sos
# riferimento: stesso filtro, tutta la frase in un colpo
y, _ = sosfilt(sos, segnale, zi=sosfilt_zi(sos).astype(np.float32) * segnale[0])
unico = (np.clip(y[::3], -1, 1) * 32767).astype('<i2')

conv = motore.Convertitore8k(SR)
pezzi = [conv.pezzo(segnale[i:i + 6000]) for i in range(0, len(segnale), 6000)]
streaming = np.frombuffer(b''.join(pezzi), dtype='<i2')

n = min(len(unico), len(streaming))
differenza = np.abs(unico[:n].astype(np.int32) - streaming[:n].astype(np.int32))
print(f'campioni: unico {len(unico)}, streaming {len(streaming)}')
print(f'scarto massimo: {differenza.max()} (su 32767)  scarto medio: {differenza.mean():.2f}')
assert len(unico) == len(streaming), 'il convertitore streaming deve produrre gli stessi campioni'
assert differenza.max() <= 2, 'lo streaming deve coincidere col ricampionamento unico'

# il vecchio metodo, per memoria: salti enormi a ogni confine di pezzo
vecchio = np.frombuffer(b''.join(
    (np.clip(resample_poly(segnale[i:i + 6000], 1, 3), -1, 1) * 32767).astype('<i2').tobytes()
    for i in range(0, len(segnale), 6000)), dtype='<i2')
confini = [2000 * k for k in range(1, len(vecchio) // 2000)]
salti_vecchi = max(abs(int(vecchio[c]) - int(vecchio[c - 1])) for c in confini if c < len(vecchio))
salti_nuovi = max(abs(int(streaming[c]) - int(streaming[c - 1])) for c in confini if c < len(streaming))
print(f'salto al confine: vecchio {salti_vecchi}, nuovo {salti_nuovi}')
assert salti_nuovi < salti_vecchi, 'il convertitore nuovo non deve avere salti ai confini'
print('ricampionamento continuo: ok')
