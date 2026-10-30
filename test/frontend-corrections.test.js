import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
async function browser(enabled = true) {
  const elements = new Map(); let socket;
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: '', textContent: '', checked: selector === '#corrections', disabled: false });
    return elements.get(selector);
  };
  class Socket {
    static OPEN = 1; static CLOSING = 2;
    constructor() { socket = this; this.readyState = 1; }
    close() { this.readyState = 3; }
  }
  class Context {
    constructor() { this.state = 'running'; this.destination = {}; this.audioWorklet = { async addModule() {} }; }
    async resume() {}
    async close() { this.state = 'closed'; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  class Worklet { constructor() { this.port = {}; } connect() {} disconnect() {} }
  runInNewContext(source, {
    document: { querySelector: element },
    window: { isSecureContext: true, AudioWorkletNode: Worklet, addEventListener() {} },
    navigator: { mediaDevices: { async getUserMedia() { return { getTracks: () => [], getAudioTracks: () => [] }; } } },
    AudioContext: Context, AudioWorkletNode: Worklet, WebSocket: Socket,
    location: { protocol: 'http:', host: 'localhost:9999' },
    fetch: async () => ({ json: async () => ({ ready: true, clients: 0, corrections: { enabled, rules: 1 } }) }),
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  return { element, async start() {
    await element('#start').onclick();
    await socket.onmessage({ data: JSON.stringify({ type: 'ready', corrections: { enabled, rules: 1 } }) });
  }, async message(message) { await socket.onmessage({ data: JSON.stringify(message) }); } };
}
const transcript = (rawText, final = false) => ({ type: 'transcript', segment: 1, text: 'ioBroker',
  rawText, correctedText: 'ioBroker', inferenceMs: 100, audioSeconds: 1, queueMs: 0, final });

test('browser compares original and corrected partials, replaces final, and toggles after stop', async () => {
  const page = await browser(); await page.start();
  await page.message(transcript('IO broker'));
  assert.equal(page.element('#transcript').value, 'ioBroker');
  assert.equal(page.element('#original').value, 'IO broker');
  page.element('#corrections').checked = false; page.element('#corrections').onchange();
  assert.equal(page.element('#transcript').value, 'IO broker');
  await page.message(transcript('eio broker', true));
  assert.equal(page.element('#transcript').value, 'eio broker');
  assert.equal(page.element('#original').value, 'eio broker');
  await page.message({ type: 'done' });
  page.element('#corrections').checked = true; page.element('#corrections').onchange();
  assert.equal(page.element('#transcript').value, 'ioBroker');
  assert.equal(page.element('#original').value, 'eio broker');
  page.element('#clear').onclick();
  assert.equal(page.element('#transcript').value, ''); assert.equal(page.element('#original').value, '');
});
test('backend-disabled dictionary disables browser correction control', async () => {
  const page = await browser(false); await page.start();
  assert.equal(page.element('#corrections').disabled, true);
  assert.equal(page.element('#corrections').checked, false);
  await page.message({ ...transcript('IO broker', true), text: 'IO broker', correctedText: 'IO broker' });
  assert.equal(page.element('#transcript').value, 'IO broker');
  assert.equal(page.element('#original').value, 'IO broker');
});
