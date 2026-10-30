const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const clearButton = document.querySelector('#clear');
const status = document.querySelector('#status');
const transcript = document.querySelector('#transcript');
const metrics = document.querySelector('#metrics');
const original = document.querySelector('#original');
const correctionToggle = document.querySelector('#corrections');
const correctionStatus = document.querySelector('#correction-status');
const transcriptLabel = document.querySelector('#transcript-label');
let active = null;
let displayedSession = null;
let checking = false;

function setCorrectionStatus(corrections) {
  correctionToggle.disabled = !corrections?.enabled;
  if (!corrections?.enabled) correctionToggle.checked = false;
  correctionStatus.textContent = corrections?.enabled
    ? `${corrections.rules} Wörterbuchregel(n) geladen. Umschalten zeigt vorhandenen Text mit oder ohne Korrektur; die Modellerkennung bleibt unverändert.`
    : 'Das Korrekturwörterbuch ist auf dem Backend deaktiviert oder noch nicht verfügbar.';
  render(displayedSession);
}

async function health() {
  if (active || checking) return;
  checking = true;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      throw new Error('Mikrofon benötigt einen aktuellen Browser und localhost oder HTTPS.');
    }
    const response = await fetch('/health');
    const data = await response.json();
    // Do not reset the user's initial checkbox while the model is still loading.
    if (data.ready) setCorrectionStatus(data.corrections);
    startButton.disabled = !data.ready;
    status.textContent = data.ready ? `Bereit · CPU · ${data.clients} verbundene Browser` : data.error || 'Backend lädt das Modell …';
  } catch (error) { startButton.disabled = true; status.textContent = error.message; }
  finally { checking = false; }
}
void health(); setInterval(health, 5000);

async function releaseMicrophone(session) {
  session.stream?.getTracks().forEach(track => track.stop());
  session.node?.disconnect(); session.source?.disconnect();
  if (session.context && session.context.state !== 'closed') await session.context.close();
}
async function cleanup(session) {
  if (active !== session) return;
  clearTimeout(session.timeout);
  session.finished = true;
  await releaseMicrophone(session);
  if (session.socket && session.socket.readyState < WebSocket.CLOSING) session.socket.close();
  if (active === session) active = null;
  stopButton.disabled = true; clearButton.disabled = false;
  startButton.disabled = false;
}
async function fail(session, error) {
  if (active !== session || session.finished) return;
  status.textContent = `Fehler: ${error.message}`;
  await cleanup(session);
}
function render(session) {
  const segments = [...(session?.segments || new Map()).entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
  const raw = value => value.rawText ?? value.text;
  transcript.value = segments.map(value => correctionToggle.checked ? (value.correctedText ?? value.text) : raw(value)).filter(Boolean).join('\n');
  original.value = segments.map(raw).filter(Boolean).join('\n');
  transcriptLabel.textContent = correctionToggle.checked ? 'Transkript mit Wörterbuch · vorläufiger Text kann sich ändern' : 'Transkript ohne Korrektur · vorläufiger Text kann sich ändern';
  transcript.scrollTop = transcript.scrollHeight;
  original.scrollTop = original.scrollHeight;
}
correctionToggle.onchange = () => render(displayedSession);
startButton.onclick = async () => {
  if (active) return;
  const session = { segments: new Map(), stopping: false, finished: false };
  displayedSession = session;
  active = session; startButton.disabled = true; clearButton.disabled = true;
  render(session); metrics.textContent = 'Noch keine Messung.';
  status.textContent = 'Mikrofonzugriff wird angefragt …';
  try {
    session.context = new AudioContext({ sampleRate: 16000 });
    await session.context.resume();
    session.stream = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    } });
    if (session.finished) { await releaseMicrophone(session); return; }
    await session.context.audioWorklet.addModule('/capture.js');
    const socket = session.socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/audio`);
    socket.binaryType = 'arraybuffer';
    session.timeout = setTimeout(() => void fail(session, new Error('Backend antwortet nicht.')), 15000);
    socket.onerror = () => void fail(session, new Error('WebSocket-Verbindung fehlgeschlagen. Backend bereit oder Nutzerlimit erreicht?'));
    socket.onclose = () => {
      if (!session.finished) void fail(session, new Error('Verbindung unterbrochen; verbleibendes Audio wurde verworfen.'));
    };
    socket.onmessage = async ({ data }) => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'ready') {
          setCorrectionStatus(message.corrections);
          clearTimeout(session.timeout);
          session.node = new AudioWorkletNode(session.context, 'capture');
          session.node.port.onmessage = ({ data: audio }) => {
            if (audio.stopped) { session.flushed?.(); return; }
            if (session.finished || socket.readyState !== WebSocket.OPEN) return;
            if (socket.bufferedAmount > 256000) { void fail(session, new Error('Audio-Verbindung zu langsam.')); return; }
            // Convert explicitly to little-endian, independent of client architecture.
            const pcm = new Float32Array(audio.pcm);
            const bytes = new ArrayBuffer(pcm.byteLength); const view = new DataView(bytes);
            for (let i = 0; i < pcm.length; i++) view.setFloat32(i * 4, pcm[i], true);
            socket.send(bytes);
          };
          session.source = session.context.createMediaStreamSource(session.stream);
          session.source.connect(session.node); session.node.connect(session.context.destination);
          for (const track of session.stream.getAudioTracks()) track.onended = () => {
            if (!session.stopping && !session.finished) void stopRecording(session);
          };
          status.textContent = 'Mikrofon aktiv · Audio wird zum Backend gestreamt'; stopButton.disabled = false;
        } else if (message.type === 'transcript') {
          const previous = session.segments.get(message.segment);
          if (!previous?.final) session.segments.set(message.segment, message);
          render(session);
          const rtf = message.inferenceMs / (message.audioSeconds * 1000);
          metrics.textContent = `Inferenz: ${Math.round(message.inferenceMs)} ms · Warteschlange: ${Math.round(message.queueMs)} ms · Audiofenster: ${message.audioSeconds.toFixed(1)} s · RTF: ${rtf.toFixed(2)} · ${message.final ? 'Abschnitt abgeschlossen' : 'Vorläufig'} (keine Ende-zu-Ende-Latenzmessung)`;
        } else if (message.type === 'done') {
          status.textContent = 'Mikrofon aus · Transkription abgeschlossen'; await cleanup(session);
        } else if (message.type === 'error') throw new Error(message.message);
      } catch (error) { await fail(session, error); }
    };
  } catch (error) { await fail(session, error); }
};
async function stopRecording(session) {
  if (active !== session || session.stopping || session.finished) return;
  session.stopping = true; stopButton.disabled = true;
  status.textContent = 'Mikrofon wird deaktiviert · Restliches Audio wird verarbeitet …';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Audioaufnahme konnte nicht abgeschlossen werden.')), 3000);
      session.flushed = () => { clearTimeout(timeout); resolve(); };
      session.node.port.postMessage('stop');
    });
    await releaseMicrophone(session);
    if (session.socket.readyState !== WebSocket.OPEN) throw new Error('Verbindung beim Stoppen verloren.');
    session.socket.send(JSON.stringify({ type: 'stop' }));
    session.timeout = setTimeout(() => void fail(session, new Error('Abschluss dauert länger als 120 Sekunden; Backend möglicherweise überlastet.')), 120000);
  } catch (error) { await fail(session, error); }
}
stopButton.onclick = () => { if (active) void stopRecording(active); };
clearButton.onclick = () => { if (!active) { displayedSession = null; render(null); metrics.textContent = 'Noch keine Messung.'; } };
window.addEventListener('pagehide', () => {
  if (!active) return;
  active.stream?.getTracks().forEach(track => track.stop()); active.socket?.close();
});
