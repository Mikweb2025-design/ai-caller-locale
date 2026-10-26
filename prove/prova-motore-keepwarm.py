#!/usr/bin/env python3
import importlib.util
import json
import queue
import stat
import subprocess
import tempfile
import threading
import unittest
import wave
from pathlib import Path

import numpy as np


RADICE = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('motore_test', RADICE / 'motore' / 'motore.py')
motore = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(motore)


class MotoreKeepWarmTest(unittest.TestCase):
    def setUp(self):
        self.keepwarm = motore.KEEPWARM_SECONDI
        self.ultimo_tts = motore.ultimo_uso_tts
        self.ultimo_stt = motore.ultimo_uso_stt
        self.servizi = motore.SERVIZI_CONCORRENTI
        self.timeout_stt = getattr(motore, 'timeout_stt_consecutivi', 0)
        self.riavvio_stt = getattr(motore, 'riavvio_motore_richiesto', False)
        self.pcm_riscaldamento_stt = getattr(motore, 'pcm_riscaldamento_stt', b'')
        self.rif_riscaldamento_tts = getattr(motore, 'rif_riscaldamento_tts', None)
        motore.servizi_spenti.clear()

    def tearDown(self):
        motore.KEEPWARM_SECONDI = self.keepwarm
        motore.ultimo_uso_tts = self.ultimo_tts
        motore.ultimo_uso_stt = self.ultimo_stt
        motore.SERVIZI_CONCORRENTI = self.servizi
        if hasattr(motore, 'timeout_stt_consecutivi'):
            motore.timeout_stt_consecutivi = self.timeout_stt
        if hasattr(motore, 'riavvio_motore_richiesto'):
            motore.riavvio_motore_richiesto = self.riavvio_stt
        if hasattr(motore, 'pcm_riscaldamento_stt'):
            motore.pcm_riscaldamento_stt = self.pcm_riscaldamento_stt
        if hasattr(motore, 'rif_riscaldamento_tts'):
            motore.rif_riscaldamento_tts = self.rif_riscaldamento_tts
        motore.servizi_spenti.clear()

    def test_legge_la_voce_scelta_nell_admin_per_riscaldare_tts(self):
        with tempfile.TemporaryDirectory() as temporanea:
            radice = Path(temporanea)
            dati, voci = radice / 'dati', radice / 'voci'
            dati.mkdir()
            voci.mkdir()
            (voci / 'maria.wav').write_bytes(b'wav')
            (voci / 'maria.json').write_text(json.dumps({'testo': 'Buongiorno da Maria.'}))
            (dati / 'impostazioni.json').write_text(json.dumps({
                'receptionist': {'voce': {'campione': 'maria.wav'}},
            }))

            self.assertEqual(
                motore.riferimento_voce_attiva(dati_dir=dati, voci_dir=voci),
                (str(voci / 'maria.wav'), 'Buongiorno da Maria.'),
            )

    def test_voce_admin_non_puo_uscire_dalla_cartella_voci(self):
        with tempfile.TemporaryDirectory() as temporanea:
            radice = Path(temporanea)
            dati, voci = radice / 'dati', radice / 'voci'
            dati.mkdir()
            voci.mkdir()
            (dati / 'impostazioni.json').write_text(json.dumps({
                'receptionist': {'voce': {'campione': '../segreto.wav'}},
            }))
            self.assertIsNone(motore.riferimento_voce_attiva(dati_dir=dati, voci_dir=voci))

    def test_riscaldamento_tts_passa_il_riferimento_admin(self):
        originale = motore.parla
        chiamate = []
        motore.rif_riscaldamento_tts = ('/tmp/maria.wav', 'Testo Maria')

        def parla_finta(testo, rif=None):
            chiamate.append((testo, rif))
            yield b'audio'

        motore.parla = parla_finta
        try:
            self.assertEqual(list(motore.parla_riscaldamento_tts('Pronto.')), [b'audio'])
        finally:
            motore.parla = originale
        self.assertEqual(chiamate, [('Pronto.', ('/tmp/maria.wav', 'Testo Maria'))])

    def test_carica_un_campione_parlato_a_8khz_per_scaldare_stt(self):
        with tempfile.TemporaryDirectory() as temporanea:
            percorso = Path(temporanea) / 'voce.wav'
            audio = (np.sin(np.arange(16000) * 2 * np.pi * 440 / 16000) * 12000).astype('<i2')
            with wave.open(str(percorso), 'wb') as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(audio.tobytes())

            pcm = motore.carica_pcm_riscaldamento_stt(percorso)
            self.assertEqual(len(pcm), 16000)  # un secondo, mono 16 bit a 8 kHz
            self.assertNotEqual(pcm, bytes(len(pcm)))

    def test_campione_stt_mancante_ripiega_sul_silenzio(self):
        pcm = motore.carica_pcm_riscaldamento_stt(Path('/file/inesistente.wav'))
        self.assertEqual(pcm, np.zeros(8000, dtype='<i2').tobytes())

    def test_scalda_tts_e_stt_solo_dopo_inattivita(self):
        motore.KEEPWARM_SECONDI = 300
        motore.ultimo_uso_tts = 10
        motore.ultimo_uso_stt = 10
        chiamate = []

        def parla_finta(testo):
            chiamate.append(('tts', testo))
            yield b'audio'

        def ascolta_finto(audio):
            chiamate.append(('stt', len(audio)))
            return ''

        motore.pcm_riscaldamento_stt = b'voce-rappresentativa'
        self.assertEqual(
            motore.mantieni_caldi_una_volta(adesso=400, parla_fn=parla_finta, ascolta_fn=ascolta_finto),
            ('tts', 'stt'),
        )
        self.assertEqual(chiamate, [('tts', 'Pronto.'), ('stt', len(b'voce-rappresentativa'))])
        self.assertEqual(
            motore.mantieni_caldi_una_volta(adesso=401, parla_fn=parla_finta, ascolta_fn=ascolta_finto),
            (),
        )

    def test_zero_disabilita_keepwarm(self):
        motore.KEEPWARM_SECONDI = 0
        motore.ultimo_uso_tts = 0
        motore.ultimo_uso_stt = 0
        self.assertEqual(
            motore.mantieni_caldi_una_volta(adesso=999, parla_fn=lambda _: (), ascolta_fn=lambda _: ''),
            (),
        )

    def test_non_aspetta_un_modello_gia_occupato(self):
        motore.KEEPWARM_SECONDI = 300
        motore.ultimo_uso_tts = 0
        motore.ultimo_uso_stt = 999
        motore.blocco_tts.acquire()
        try:
            self.assertEqual(
                motore.mantieni_caldi_una_volta(adesso=400, parla_fn=lambda _: (), ascolta_fn=lambda _: ''),
                (),
            )
        finally:
            motore.blocco_tts.release()

    def test_ferma_e_ricorda_un_servizio_launchd(self):
        motore.SERVIZI_CONCORRENTI = ('com.qwen3tts.8091',)
        chiamate = []

        def esegui(comando, **_):
            chiamate.append(comando)
            if comando[1] == 'print':
                return subprocess.CompletedProcess(comando, 0, '    path = /tmp/qwen.plist\n', '')
            return subprocess.CompletedProcess(comando, 0, '', '')

        self.assertEqual(motore.ferma_servizi_concorrenti(esegui=esegui), ('com.qwen3tts.8091',))
        self.assertEqual(motore.servizi_spenti, {'com.qwen3tts.8091': '/tmp/qwen.plist'})
        self.assertIn(['/bin/launchctl', 'bootout', motore.DOMINIO + '/com.qwen3tts.8091'], chiamate)

        motore.riaccendi_servizi_concorrenti(esegui=esegui)
        self.assertIn(['/bin/launchctl', 'bootstrap', motore.DOMINIO, '/tmp/qwen.plist'], chiamate)

    def test_intervalli_invalidi_zero_e_limiti_minimi(self):
        leggi = motore._leggi_intervallo
        self.assertEqual(leggi('X', 300, 60, {'X': 'non-numero'}), 300)
        self.assertEqual(leggi('X', 300, 60, {'X': 'inf'}), 300)
        self.assertEqual(leggi('X', 300, 60, {'X': '-2'}), 300)
        self.assertEqual(leggi('X', 300, 60, {'X': '0'}), 0)
        self.assertEqual(leggi('X', 300, 60, {'X': '1'}), 60)
        self.assertEqual(leggi('X', 60, 30, {'X': '31.5'}), 31.5)

    def test_timeout_avvio_stt_predefinito_120_secondi(self):
        self.assertEqual(motore.STT_AVVIO_TIMEOUT_S, 120)

    def test_log_motore_hanno_permessi_riservati(self):
        with tempfile.TemporaryDirectory() as temporanea:
            cartella = Path(temporanea) / 'registrazioni'
            motore.proteggi_log_motore(cartella)
            self.assertEqual(stat.S_IMODE(cartella.stat().st_mode), 0o700)
            for nome in ('launchd-motore.log', 'launchd-motore-error.log'):
                self.assertEqual(stat.S_IMODE((cartella / nome).stat().st_mode), 0o600)

    def test_non_esegue_label_fuori_allowlist(self):
        motore.SERVIZI_CONCORRENTI = ('com.qwen3tts.8092', 'com.esempio.non-consentito')
        chiamate = []

        def esegui(comando, **_):
            chiamate.append(comando)
            return subprocess.CompletedProcess(comando, 1, '', '')

        motore.ferma_servizi_concorrenti(esegui=esegui)
        bersagli = ' '.join(' '.join(x) for x in chiamate)
        self.assertIn('com.qwen3tts.8092', bersagli)
        self.assertNotIn('com.esempio.non-consentito', bersagli)

    def test_bootstrap_fallito_conserva_lo_stato(self):
        motore.servizi_spenti['com.qwen3tts.8091'] = '/tmp/qwen.plist'

        def fallisce(comando, **_):
            return subprocess.CompletedProcess(comando, 1, '', 'errore')

        self.assertEqual(motore.riaccendi_servizi_concorrenti(esegui=fallisce), ())
        self.assertEqual(motore.servizi_spenti, {'com.qwen3tts.8091': '/tmp/qwen.plist'})

    def test_keepwarm_continua_dopo_una_eccezione(self):
        motore.KEEPWARM_SECONDI = 60
        chiamate = []

        class StopDopoDueCicli:
            def __init__(self):
                self.cicli = 0

            def wait(self, _):
                self.cicli += 1
                return self.cicli > 2

        def scalda():
            chiamate.append('ciclo')
            if len(chiamate) == 1:
                raise RuntimeError('guasto temporaneo')
            return ()

        motore.mantieni_modelli_caldi(stop=StopDopoDueCicli(), scalda_fn=scalda)
        self.assertEqual(chiamate, ['ciclo', 'ciclo'])

    def test_ascolta_va_in_timeout_senza_bloccarsi(self):
        class Richieste:
            def __init__(self):
                self.valori = []

            def put(self, valore):
                self.valori.append(valore)

        class Risposte:
            def get(self, timeout):
                raise queue.Empty

        richieste = Richieste()
        with self.assertRaises(TimeoutError):
            motore.ascolta(b'pcm', timeout=0.01, richieste_queue=richieste,
                           risposte_queue=Risposte(), processo=None)
        self.assertEqual(len(richieste.valori), 1)

    def test_ascolta_rileva_il_figlio_stt_terminato(self):
        class FiglioMorto:
            def is_alive(self):
                return False

        with self.assertRaises(motore.STTNonDisponibile):
            motore.ascolta(b'pcm', timeout=1, richieste_queue=object(),
                           risposte_queue=object(), processo=FiglioMorto())

    def test_figlio_morto_richiede_riavvio_del_parent_una_volta(self):
        motore.timeout_stt_consecutivi = 0
        motore.riavvio_motore_richiesto = False
        riavvii = []

        self.assertTrue(motore.gestisci_errore_stt(
            motore.STTNonDisponibile('morto'), riavvia_fn=lambda: riavvii.append('restart')))
        self.assertFalse(motore.gestisci_errore_stt(
            motore.STTNonDisponibile('morto'), riavvia_fn=lambda: riavvii.append('restart')))
        self.assertEqual(riavvii, ['restart'])

    def test_due_timeout_stt_consecutivi_richiedono_riavvio(self):
        motore.timeout_stt_consecutivi = 0
        motore.riavvio_motore_richiesto = False
        riavvii = []
        riavvia = lambda: riavvii.append('restart')

        self.assertFalse(motore.gestisci_errore_stt(TimeoutError(), riavvia_fn=riavvia))
        self.assertTrue(motore.gestisci_errore_stt(TimeoutError(), riavvia_fn=riavvia))
        self.assertEqual(riavvii, ['restart'])

    def test_salute_riflette_lo_stato_del_figlio_stt(self):
        class Figlio:
            def __init__(self, vivo):
                self.vivo = vivo

            def is_alive(self):
                return self.vivo

        self.assertTrue(motore.stt_vivo(Figlio(True)))
        self.assertFalse(motore.stt_vivo(Figlio(False)))

    def test_guardia_si_ferma_prima_del_servizio_successivo(self):
        motore.SERVIZI_CONCORRENTI = ('com.qwen3tts.8091', 'com.qwen3tts.8092')
        stop = threading.Event()
        chiamate = []

        def esegui(comando, **_):
            chiamate.append(comando)
            stop.set()
            return subprocess.CompletedProcess(comando, 0, '    path = /tmp/qwen.plist\n', '')

        motore.ferma_servizi_concorrenti(esegui=esegui, stop=stop)
        self.assertEqual(len(chiamate), 1)
        self.assertEqual(chiamate[0][1], 'print')

    def test_bootstrap_ritenta_una_volta_e_poi_riesce(self):
        motore.servizi_spenti['com.qwen3tts.8091'] = '/tmp/qwen.plist'
        chiamate = []

        def esegui(comando, **_):
            chiamate.append(comando)
            return subprocess.CompletedProcess(comando, 0 if len(chiamate) == 2 else 1, '', '')

        self.assertEqual(motore.riaccendi_servizi_concorrenti(
            esegui=esegui, tentativi=2, attesa_fn=lambda _: None), ('com.qwen3tts.8091',))
        self.assertEqual(len(chiamate), 2)
        self.assertEqual(motore.servizi_spenti, {})

    def test_shutdown_attende_guardia_prima_del_bootstrap(self):
        stop = threading.Event()
        eventi = []

        def guardia():
            stop.wait()
            eventi.append('guardia-ferma')

        thread = threading.Thread(target=guardia)
        thread.start()
        motore.servizi_spenti['com.qwen3tts.8091'] = '/tmp/qwen.plist'

        def esegui(comando, **_):
            if comando[1] == 'bootstrap':
                self.assertEqual(eventi, ['guardia-ferma'])
            return subprocess.CompletedProcess(comando, 0, '', '')

        motore.arresta_guardia_e_riaccendi(esegui=esegui, stop=stop, thread=thread)
        self.assertFalse(thread.is_alive())

    def test_shutdown_limita_attesa_guardia(self):
        stop = threading.Event()
        attese = []

        class GuardiaBloccata:
            def join(self, timeout):
                attese.append(timeout)

            def is_alive(self):
                return True

        motore.arresta_guardia_e_riaccendi(
            esegui=lambda comando, **_: subprocess.CompletedProcess(comando, 0, '', ''),
            stop=stop, thread=GuardiaBloccata())
        self.assertEqual(attese, [motore.TIMEOUT_JOIN_GUARDIA_S])


if __name__ == '__main__':
    unittest.main()
