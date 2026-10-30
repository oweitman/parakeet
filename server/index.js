import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { AudioSession } from './audio-session.js';
import { Scheduler } from './scheduler.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 9999);
const maxClients = Number(process.env.MAX_CLIENTS || 8);
const threshold = Number(process.env.VAD_THRESHOLD || 0.008);
if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 128 ||
    !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error('Invalid MAX_CLIENTS or VAD_THRESHOLD');
let ready = false;
let failure = '';
let corrections = { enabled: false, rules: 0 };
let waiting;
const worker = new Worker(new URL('./worker.js', import.meta.url));
const send = (socket, data) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, 'Client too slow'); return; }
  socket.send(JSON.stringify(data));
};
function workerFailure(error) {
  ready = false; failure = error.message;
  console.error('Inference worker:', failure);
  waiting?.reject(error); waiting = null;
  for (const socket of wss.clients) { send(socket, { type: 'error', message: failure }); socket.close(1011); }
}
worker.on('error', workerFailure);
worker.on('exit', code => { if (!shuttingDown) workerFailure(new Error(`Inference worker exited (${code})`)); });
worker.on('message', message => {
  if (message.ready) { corrections = message.corrections; ready = true; console.log('CPU model ready'); return; }
  if (message.fatal) { workerFailure(new Error(message.fatal)); void worker.terminate(); return; }
  const current = waiting; waiting = null;
  if (message.error) current?.reject(new Error(message.error));
  else current?.resolve(message);
});
const scheduler = new Scheduler(pcm => new Promise((resolve, reject) => {
  if (!ready) { reject(new Error(failure || 'Model not ready')); return; }
  waiting = { resolve, reject };
  worker.postMessage({ pcm }, [pcm.buffer]);
}), (owner, error) => owner.fail(error));

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/capture.js', ['capture.js', 'text/javascript; charset=utf-8']],
  ['/resampler.js', ['resampler.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'; frame-ancestors 'none'");
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/health') {
    response.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ready, error: failure || undefined, corrections, clients: wss.clients.size,
      queued: scheduler.pending.size, busy: scheduler.busy, model: 'parakeet-tdt-0.6b-v3 int8', backend: 'cpu' }));
    return;
  }
  const file = files.get(path);
  if (!file) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(new URL(`../public/${file[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': file[1] }); response.end(body);
  } catch { response.writeHead(500).end('Could not load page'); }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 32000, perMessageDeflate: false });
server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;
  let allowedOrigin = false;
  try { allowedOrigin = !!origin && new URL(origin).host === request.headers.host; } catch { /* reject */ }
  if (request.url !== '/audio' || !allowedOrigin || !ready || wss.clients.size >= maxClients) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
});
wss.on('connection', socket => {
  let state = 'recording';
  let completed = false;
  const started = performance.now();
  let received = 0;
  const owner = {
    id: randomUUID(),
    result(result) { if (state !== 'closed') send(socket, { type: 'transcript', ...result }); },
    idle() {
      if (state === 'stopping' && !completed && !scheduler.has(owner)) {
        completed = true; send(socket, { type: 'done' }); socket.close(1000);
      }
    },
    fail(error) {
      if (state === 'closed') return;
      state = 'closed'; audio.reset(); scheduler.cancel(owner);
      send(socket, { type: 'error', message: error.message }); socket.close(1011);
    },
  };
  const audio = new AudioSession(job => scheduler.enqueue(owner, job), { threshold });
  const timer = setTimeout(() => owner.fail(new Error('Maximum demo session length is 30 minutes')), 30 * 60 * 1000);
  socket.on('message', (data, binary) => {
    try {
      if (state !== 'recording') throw new Error('Recording already stopped');
      if (!binary) {
        const message = JSON.parse(data.toString());
        if (message.type !== 'stop') throw new Error('Unknown control message');
        state = 'stopping'; audio.flush(); owner.idle(); return;
      }
      if (!data.length || data.length % 4) throw new Error('Expected Float32 little-endian PCM');
      const pcm = new Float32Array(data.length / 4);
      for (let i = 0; i < pcm.length; i++) pcm[i] = data.readFloatLE(i * 4);
      received += pcm.length;
      if (received > ((performance.now() - started) / 1000 + 3) * 16000) throw new Error('Audio sent faster than real time');
      audio.push(pcm);
    } catch (error) { owner.fail(error); }
  });
  socket.on('error', () => { /* close cleans up */ });
  socket.on('close', () => {
    state = 'closed'; clearTimeout(timer); scheduler.cancel(owner);
    audio.reset(); audio.preRoll = [];
  });
  send(socket, { type: 'ready', sampleRate: 16000, corrections });
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of wss.clients) socket.terminate();
  wss.close(); server.close(); await worker.terminate();
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
server.on('error', async error => { console.error(error.message); await shutdown(); process.exitCode = 1; });
server.listen(port, host, () => console.log(`Demo: http://${host}:${server.address().port} (loading CPU model…)`));
