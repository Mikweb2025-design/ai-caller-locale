// La prima sillaba del saluto si perdeva quando il browser programmava l'audio nel passato
// (uscita audio appena svegliata, scheda in background, jitter di iPhone): Web Audio allora
// fa partire il buffer "da dove sarebbe dovuto iniziare" e mangia la testa della voce.
// Qui si prova la regola di programmazione e il fatto che la pagina la usi davvero.
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { codiceProgrammazioneAudio, codiceRicampionamentoAudio, MARGINE_AVVIO_SECONDI, MARGINE_AVVIO_IOS_SECONDI } from '../src/audio-browser.mjs';
import { paginaWeb } from '../src/web.mjs';

const contesto = vm.createContext({});
vm.runInContext(codiceProgrammazioneAudio(), contesto);
const inizioBuffer = contesto.inizioBuffer;
vm.runInContext(codiceRicampionamentoAudio(), contesto);
const ricampionaPacchetto = contesto.ricampionaPacchetto;

// 8 kHz → 48 kHz a pacchetti da 20 ms, come fa la pagina con la voce che arriva dal server.
function aPacchetti(su, pacchetti = 50) {
  const stato = { resto: 0, ultimo: null }, uscita = [];
  for (let p = 0; p < pacchetti; p++) {
    const valori = new Float32Array(160);
    for (let i = 0; i < 160; i++) valori[i] = Math.sin(2 * Math.PI * 440 * (p * 160 + i) / 8000);
    uscita.push(...ricampionaPacchetto(valori, stato, su));
  }
  return Float32Array.from(uscita);
}

test('coda vuota: si parte con un margine vero, mai adesso', () => {
  const adesso = 12.5;
  assert.equal(inizioBuffer(0, adesso, false), adesso + MARGINE_AVVIO_SECONDI);
  assert.equal(inizioBuffer(adesso - 0.4, adesso, false), adesso + MARGINE_AVVIO_SECONDI);
  assert.equal(inizioBuffer(adesso + 0.001, adesso, false), adesso + MARGINE_AVVIO_SECONDI);
});

test('iPhone: margine più largo, il jitter di Safari non tocca la voce', () => {
  const adesso = 3;
  assert.equal(inizioBuffer(0, adesso, true), adesso + MARGINE_AVVIO_IOS_SECONDI);
  assert.ok(MARGINE_AVVIO_IOS_SECONDI > MARGINE_AVVIO_SECONDI);
});

test('coda già avviata: nessun buco e nessun ritardo aggiunto', () => {
  const adesso = 7.2;
  const prossimo = adesso + 2.4;
  assert.equal(inizioBuffer(prossimo, adesso, false), prossimo);
  assert.equal(inizioBuffer(prossimo, adesso, true), prossimo);
});

test('mai una programmazione nel passato', () => {
  for (const adesso of [0, 0.05, 1, 33.3, 3600]) {
    for (const prossimo of [-5, 0, adesso - 0.001, adesso, adesso + 0.001]) {
      for (const ios of [false, true]) {
        const quando = inizioBuffer(prossimo, adesso, ios);
        assert.ok(quando > adesso, `${prossimo} @ ${adesso} (ios ${ios}): parte a ${quando}`);
      }
    }
  }
});

test('la pagina usa la regola e scalda l\'uscita audio prima del saluto', () => {
  const html = paginaWeb({ ws: '/web/prova', admin: '/admin/prova', avatar: '' });
  assert.match(html, /function inizioBuffer/, 'manca la regola di programmazione');
  assert.match(html, /inizioBuffer\(prossimo, ctx\.currentTime, ios\)/, 'suona() non usa la regola');
  assert.match(html, /scaldaAudio\(\)/, 'manca il preriscaldamento dell\'uscita audio');
  assert.ok(html.indexOf('scaldaAudio();') < html.indexOf('getUserMedia'), 'l\'audio va scaldato prima del microfono');
});

test('ricampionamento a pacchetti: nessuna fase persa ai confini', () => {
  for (const su of [48000, 44100, 24000]) {
    const a = aPacchetti(su);
    // la stessa sinusoide ricampionata in un colpo solo, con la stessa regola
    const valori = new Float32Array(160 * 50);
    for (let i = 0; i < valori.length; i++) valori[i] = Math.sin(2 * Math.PI * 440 * i / 8000);
    const intera = ricampionaPacchetto(valori, { resto: 0, ultimo: null }, su);
    assert.ok(Math.abs(a.length - intera.length) <= 1, `${su}: lunghezza ${a.length} contro ${intera.length}`);
    let scarto = 0;
    for (let i = 0; i < Math.min(a.length, intera.length); i++) scarto = Math.max(scarto, Math.abs(a[i] - intera[i]));
    assert.ok(scarto < 1e-6, `${su}: a pacchetti e in un colpo solo non coincidono (${scarto})`);
    // e nessun salto di fase ai confini dei pacchetti (ogni 20 ms)
    const perPacchetto = Math.round(0.02 * su);
    let saltoConfine = 0, saltoInterno = 0;
    for (let i = 1; i < a.length; i++) {
      const d = Math.abs(a[i] - a[i - 1]);
      if (i % perPacchetto === 0) saltoConfine = Math.max(saltoConfine, d);
      else saltoInterno = Math.max(saltoInterno, d);
    }
    assert.ok(saltoConfine < saltoInterno * 1.5, `${su}: salto al confine ${saltoConfine.toFixed(4)} contro ${saltoInterno.toFixed(4)} interno`);
  }
});

test('la pagina ricampiona con lo stato condiviso, non da zero a ogni pacchetto', () => {
  const html = paginaWeb({ ws: '/web/prova', admin: '/admin/prova', avatar: '' });
  assert.match(html, /function ricampionaPacchetto/, 'manca la funzione di ricampionamento');
  assert.match(html, /ricampionaPacchetto\(valori, ricampionamento, su\)/, 'suona() non usa lo stato condiviso');
});
