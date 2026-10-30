import { readFile } from 'node:fs/promises';
import { loadModel } from '../server/model.js';

// Optional argument: mono 16 kHz, little-endian Float32 PCM (not a WAV container).
const file = process.argv[2];
let pcm = new Float32Array(16000);
if (file) {
  const bytes = await readFile(file);
  if (!bytes.length || bytes.length % 4) throw new Error('Expected raw Float32 PCM');
  pcm = new Float32Array(bytes.length / 4);
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readFloatLE(i * 4);
}
const model = await loadModel();
try {
  const start = performance.now();
  const text = await model.transcribe(pcm);
  console.log(JSON.stringify({ text, audioSeconds: pcm.length / 16000, inferenceMs: Math.round(performance.now() - start) }, null, 2));
  if (!file) console.log('Silence smoke test only. Test microphone speech in the browser to assess recognition.');
} finally { await model.close(); }
