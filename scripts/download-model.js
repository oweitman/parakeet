import { mkdir, rename, stat, rm, writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';

const repository = 'ysdede/parakeet-tdt-0.6b-v3-onnx';
const directory = resolve(process.env.MODEL_DIR || 'models');
const files = ['encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx', 'vocab.txt'];
await mkdir(directory, { recursive: true });
try {
  // Resolve main once so every file belongs to the same revision.
  const metadata = await fetch(`https://huggingface.co/api/models/${repository}`, { signal: AbortSignal.timeout(30000) });
  if (!metadata.ok) throw new Error(`Model metadata: HTTP ${metadata.status}`);
  const { sha } = await metadata.json();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid model revision');
  const provenance = { repository, revision: sha, files };
  const manifestPath = resolve(directory, 'model.json');
  let previous;
  try { previous = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* first download */ }
  for (const file of files) {
    const target = resolve(directory, file);
    if (previous?.revision === sha && previous?.sizes?.[file] &&
        await stat(target).then(s => s.size === previous.sizes[file]).catch(() => false)) {
      console.log(`Already downloaded: ${file}`); continue;
    }
    const temporary = `${target}.part`;
    console.log(`Downloading ${file} (${sha}) …`);
    try {
      const response = await fetch(`https://huggingface.co/${repository}/resolve/${sha}/${file}`, { signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
      const size = (await stat(temporary)).size;
      const expected = Number(response.headers.get('content-length'));
      if (!size || (expected && size !== expected)) throw new Error('Incomplete model download');
      await rename(temporary, target);
      console.log(`${file}: ${(size / 1024 / 1024).toFixed(1)} MiB`);
    } catch (error) { await rm(temporary, { force: true }); throw new Error(`${file}: ${error.message}`); }
  }
  provenance.sizes = Object.fromEntries(await Promise.all(files.map(async file => [file, (await stat(resolve(directory, file))).size])));
  await writeFile(manifestPath, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log('Model ready. Run npm run smoke, then npm start.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
