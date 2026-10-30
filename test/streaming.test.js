import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioSession, RATE } from '../server/audio-session.js';
import { Scheduler } from '../server/scheduler.js';
import { Resampler } from '../public/resampler.js';

const frame = (value = 0.1) => new Float32Array(1600).fill(value);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('partial updates reuse segment; silence finalizes once and next speech starts new segment', () => {
  const jobs = []; const session = new AudioSession(job => jobs.push(job));
  for (let i = 0; i < 15; i++) session.push(frame());
  assert.equal(jobs.length, 1); assert.equal(jobs[0].final, false);
  for (let i = 0; i < 8; i++) session.push(frame(0));
  assert.equal(jobs.at(-1).final, true); assert.equal(jobs.at(-1).segment, 1);
  session.flush(); assert.equal(jobs.length, 2);
  session.push(frame()); session.flush();
  assert.equal(jobs.at(-1).segment, 2);
});
test('stop flushes a short utterance and idle silence produces no transcript', () => {
  const jobs = []; const session = new AudioSession(job => jobs.push(job));
  for (let i = 0; i < 100; i++) session.push(frame(0));
  assert.equal(jobs.length, 0); assert.ok(session.preSamples <= RATE * 0.3);
  session.push(frame()); session.flush();
  assert.equal(jobs.length, 1); assert.equal(jobs[0].final, true);
  assert.ok(jobs[0].pcm.length >= 1600);
});
test('continuous speech is bounded by a segment limit', () => {
  const jobs = []; const session = new AudioSession(job => jobs.push(job));
  for (let i = 0; i < 130; i++) session.push(frame());
  assert.ok(jobs.some(job => job.final));
  assert.ok(jobs.every(job => job.pcm.length <= 12 * RATE));
  assert.equal(session.segment, 2);
});
test('invalid audio is rejected before inference', () => {
  const session = new AudioSession(() => {});
  for (const pcm of [new Float32Array(), new Float32Array([NaN]), new Float32Array([2]), new Float32Array(8001)]) {
    assert.throws(() => session.push(pcm));
  }
});
test('resampling preserves duration and DC level across irregular chunks', () => {
  for (const rate of [16000, 44100, 48000]) {
    const resampler = new Resampler(rate); const output = [];
    const input = new Float32Array(rate).fill(0.25);
    for (let i = 0; i < input.length; i += 128) output.push(...resampler.push(input.subarray(i, i + 128)));
    assert.ok(Math.abs(output.length - 16000) <= 1);
    assert.ok(output.every(sample => Math.abs(sample - 0.25) < 1e-6));
  }
});
test('scheduler serializes users and replaces stale partials with final snapshot', async () => {
  const runs = []; const resultsA = []; const resultsB = []; let finish;
  const scheduler = new Scheduler(pcm => {
    runs.push(pcm[0]); return new Promise(resolve => { finish = resolve; });
  }, () => assert.fail('Unexpected inference failure'));
  const a = { id: 'a', result: result => resultsA.push(result) };
  const b = { id: 'b', result: result => resultsB.push(result) };
  const job = (value, final = false) => ({ segment: 1, pcm: new Float32Array([value]), final });
  scheduler.enqueue(a, job(1)); scheduler.enqueue(b, job(2));
  scheduler.enqueue(a, job(3)); scheduler.enqueue(a, job(4, true));
  assert.deepEqual(runs, [1]); assert.equal(scheduler.pending.size, 2);
  finish({ text: 'a-partial' }); await tick(); assert.deepEqual(runs, [1, 2]);
  finish({ text: 'b' }); await tick(); assert.deepEqual(runs, [1, 2, 4]);
  finish({ text: 'a-final' }); await tick();
  assert.equal(resultsA.at(-1).text, 'a-final'); assert.equal(resultsA.at(-1).final, true);
  assert.equal(resultsB[0].text, 'b'); assert.equal(scheduler.has(a), false);
});
test('cancel removes disconnected users; active inference cannot schedule more work for them', async () => {
  let finish; const runs = [];
  const scheduler = new Scheduler(pcm => { runs.push(pcm[0]); return new Promise(resolve => { finish = resolve; }); }, () => {});
  const owner = { id: 'x', result() {} };
  scheduler.enqueue(owner, { segment: 1, pcm: frame() });
  scheduler.enqueue(owner, { segment: 2, pcm: frame() });
  scheduler.cancel(owner); finish({ text: '' }); await tick();
  assert.equal(runs.length, 1); assert.equal(scheduler.has(owner), false);
});
test('queue overflow is explicit instead of silently dropping final audio', async () => {
  let finish;
  const scheduler = new Scheduler(() => new Promise(resolve => { finish = resolve; }), () => {});
  const owner = { id: 'x', result() {} };
  scheduler.enqueue(owner, { segment: 0, pcm: frame() });
  scheduler.enqueue(owner, { segment: 1, pcm: new Float32Array(40 * RATE), final: true });
  assert.throws(() => scheduler.enqueue(owner, { segment: 2, pcm: new Float32Array(6 * RATE), final: true }), /overloaded/);
  scheduler.cancel(owner); finish({ text: '' }); await tick();
});
test('metrics preserve audio duration when worker transfers the audio buffer', async () => {
  let result;
  const scheduler = new Scheduler(async pcm => {
    structuredClone(pcm, { transfer: [pcm.buffer] }); return { text: 'ok' };
  }, () => assert.fail());
  scheduler.enqueue({ id: 'x', result: value => { result = value; } }, { segment: 1, pcm: frame(), final: true });
  await tick(); assert.equal(result.audioSeconds, 0.1);
});

test('AudioWorklet batches microphone PCM and flushes its final short packet before stop acknowledgement', async () => {
  const messages = []; let Capture;
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class {
    constructor() { this.port = { postMessage: message => messages.push(message) }; }
  };
  globalThis.registerProcessor = (name, implementation) => { assert.equal(name, 'capture'); Capture = implementation; };
  try {
    await import('../public/capture.js');
    const processor = new Capture();
    // 110 ms -> one full 100 ms packet, then a 10 ms tail.
    processor.process([[new Float32Array(5280).fill(0.1)]]);
    assert.equal(messages.length, 1); assert.equal(messages[0].pcm.byteLength, 1600 * 4);
    processor.port.onmessage({ data: 'stop' });
    assert.equal(messages[1].pcm.byteLength, 160 * 4);
    assert.deepEqual(messages[2], { stopped: true });
    assert.equal(processor.process([]), false);
  } finally {
    delete globalThis.sampleRate; delete globalThis.AudioWorkletProcessor; delete globalThis.registerProcessor;
  }
});
