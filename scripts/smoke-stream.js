import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

// Real model + HTTP + WebSocket + worker + scheduler, without recording or saving audio.
// Synthetic tones verify transport/decoding, not speech recognition quality.
const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: '0', MAX_CLIENTS: '8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = ''; let serverError; let base;
server.on('error', error => { serverError = error; });
server.stdout.on('data', data => { output += data; base ||= output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; });
server.stderr.on('data', data => { output += data; });
const sockets = new Set();
const timeout = setTimeout(() => { server.kill(); console.error('Streaming smoke test timed out.'); process.exit(1); }, 120000);

async function client({ seconds = 2.2, frequency = 220, invalid = false, silence = false } = {}) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/audio`, { origin: base });
  sockets.add(socket);
  const messages = [];
  let readyResolve; let doneResolve; let doneReject;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  // Attach the rejection handler before awaiting readiness.
  done.catch(() => {});
  socket.on('error', error => { readyResolve(); doneReject(error); });
  socket.on('message', data => {
    const message = JSON.parse(data.toString()); messages.push(message);
    if (message.type === 'ready') readyResolve();
    if (message.type === 'done' || (invalid && message.type === 'error')) doneResolve();
    else if (message.type === 'error') doneReject(new Error(message.message));
  });
  socket.on('close', () => {
    sockets.delete(socket); readyResolve();
    if (!messages.some(message => message.type === 'done' || (invalid && message.type === 'error'))) {
      doneReject(new Error('Socket closed before completion'));
    }
  });
  await ready;
  if (!messages.some(message => message.type === 'ready')) { await done; throw new Error('No ready message'); }
  if (invalid) {
    const bytes = Buffer.alloc(4); bytes.writeFloatLE(NaN); socket.send(bytes);
  } else {
    const started = performance.now();
    for (let packet = 0; packet < Math.round(seconds * 10); packet++) {
      const bytes = Buffer.alloc(1600 * 4);
      for (let sample = 0; sample < 1600; sample++) {
        const value = silence ? 0 : 0.1 * Math.sin(2 * Math.PI * frequency * (packet * 1600 + sample) / 16000);
        bytes.writeFloatLE(value, sample * 4);
      }
      socket.send(bytes);
      await delay(Math.max(0, started + (packet + 1) * 100 - performance.now()));
    }
    socket.send(JSON.stringify({ type: 'stop' }));
  }
  await done;
  const transcripts = messages.filter(message => message.type === 'transcript');
  if (invalid) assert.match(messages.at(-1).message, /Invalid PCM/);
  else if (silence) assert.equal(transcripts.length, 0);
  else {
    assert.ok(transcripts.some(message => message.final), 'Final transcript must arrive before done');
    for (const message of transcripts) {
      assert.equal(typeof message.text, 'string'); assert.ok(message.audioSeconds > 0);
      assert.equal(typeof message.rawText, 'string'); assert.equal(typeof message.correctedText, 'string');
      assert.equal(message.text, message.correctedText);
      if (!message.correctionsEnabled) assert.equal(message.rawText, message.correctedText);
      assert.ok(Number.isFinite(message.inferenceMs)); assert.ok(Number.isFinite(message.queueMs));
    }
    assert.equal(messages.at(-1).type, 'done');
  }
  return { packets: transcripts.length, finals: transcripts.filter(message => message.final).length,
    inferenceMs: transcripts.map(message => Math.round(message.inferenceMs)),
    queueMs: transcripts.map(message => Math.round(message.queueMs)) };
}

try {
  const start = performance.now();
  while (true) {
    if (serverError) throw serverError;
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
    if (base) {
      const response = await fetch(`${base}/health`);
      const health = await response.json();
      if (health.error) throw new Error(health.error);
      if (health.ready) break;
    }
    if (performance.now() - start > 90000) throw new Error(`Model loading timed out: ${output}`);
    await delay(200);
  }
  const parallel = await Promise.all([client(), client({ frequency: 330 })]);
  assert.ok(parallel.some(result => result.packets > 1), 'Expected a partial update before final');
  console.log('Two concurrent clients:', JSON.stringify(parallel));
  console.log('Short stop flush:', JSON.stringify(await client({ seconds: 0.4 })));
  await client({ seconds: 0.3, silence: true }); console.log('Silence: no transcription jobs');
  await client({ invalid: true }); console.log('Invalid audio: explicit rejection');
  console.log('Streaming smoke passed. Microphone capture and speech quality still require a browser test.');
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  clearTimeout(timeout);
  for (const socket of sockets) socket.terminate();
  const exit = once(server, 'exit'); server.kill();
  if (server.exitCode === null) await exit;
}
