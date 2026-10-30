import { parentPort } from 'node:worker_threads';
import { loadModel } from './model.js';
import { loadCorrector } from './corrections.js';

try {
  const corrector = await loadCorrector();
  const model = await loadModel();
  parentPort.on('message', async ({ pcm }) => {
    const start = performance.now();
    try {
      const rawText = await model.transcribe(pcm);
      const inferenceMs = performance.now() - start;
      const correctedText = corrector.apply(rawText);
      parentPort.postMessage({ text: correctedText, rawText, correctedText,
        correctionsEnabled: corrector.enabled, inferenceMs });
    } catch (error) { parentPort.postMessage({ error: error.message }); }
  });
  parentPort.postMessage({ ready: true, corrections: { enabled: corrector.enabled, rules: corrector.rules } });
} catch (error) {
  parentPort.postMessage({ fatal: error.message });
}
