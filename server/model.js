import * as ort from 'onnxruntime-node';
import { ParakeetModel } from 'parakeet.js/parakeet';
import { JsPreprocessor } from 'parakeet.js/mel';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function loadModel() {
  const directory = resolve(process.env.MODEL_DIR || 'models');
  const threads = Number(process.env.CPU_THREADS || 4);
  if (!Number.isInteger(threads) || threads < 1 || threads > 128) {
    throw new Error('CPU_THREADS must be an integer between 1 and 128');
  }
  const options = {
    executionProviders: ['cpu'], intraOpNumThreads: threads, interOpNumThreads: 1,
    executionMode: 'sequential', graphOptimizationLevel: 'all',
  };
  // Internal tokenizer path is tied to the pinned parakeet.js version.
  const tokenizerUrl = new URL('./tokenizer.js', import.meta.resolve('parakeet.js/parakeet'));
  const { ParakeetTokenizer } = await import(tokenizerUrl.href);
  const vocabulary = await readFile(resolve(directory, 'vocab.txt'), 'utf8');
  const tokens = [];
  for (const line of vocabulary.split(/\r?\n/).filter(Boolean)) {
    const [token, id] = line.trim().split(/\s+/);
    if (!token || !/^\d+$/.test(id)) throw new Error('Invalid vocab.txt');
    tokens[Number(id)] = token;
  }
  if (!tokens.includes('<blk>')) throw new Error('Missing blank token in vocabulary');
  const encoderSession = await ort.InferenceSession.create(resolve(directory, 'encoder-model.int8.onnx'), options);
  let joinerSession;
  try {
    joinerSession = await ort.InferenceSession.create(resolve(directory, 'decoder_joint-model.int8.onnx'), options);
    const model = new ParakeetModel({
      tokenizer: new ParakeetTokenizer(tokens), encoderSession, joinerSession,
      preprocessor: new JsPreprocessor({ nMels: 128 }), ort, nMels: 128,
    });
    return {
      async transcribe(pcm) {
        model.resetMelCache(); model.clearIncrementalCache();
        const result = await model.transcribe(pcm, 16000, { enableProfiling: false });
        return result.utterance_text;
      },
      async close() { await encoderSession.release(); await joinerSession.release(); },
    };
  } catch (error) {
    await encoderSession.release(); await joinerSession?.release(); throw error;
  }
}
