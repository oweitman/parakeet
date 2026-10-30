import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const modelFiles = ['encoder-model.int8.onnx', 'decoder_joint-model.int8.onnx', 'vocab.txt'];
const target = resolve(root, 'dist/parakeet-demo.tar.gz');
const temporary = `${target}.part`;
try {
  const manifest = JSON.parse(await readFile(resolve(root, 'models/model.json'), 'utf8'));
  for (const file of modelFiles) {
    const info = await stat(resolve(root, 'models', file));
    if (!info.isFile() || !info.size || info.size !== manifest.sizes?.[file]) {
      throw new Error(`Model file incomplete: ${file}. Run npm run download-model.`);
    }
  }
  await mkdir(resolve(root, 'dist'), { recursive: true });
  console.log('Packing source and existing model files. No node_modules or audio are included.');
  const entries = ['package.json', 'package-lock.json', 'README.md', 'SERVER.md',
    'server', 'public', 'scripts', 'test', 'deploy', 'config', 'models/model.json', ...modelFiles.map(file => `models/${file}`)];
  await new Promise((done, fail) => {
    const child = spawn('tar', ['-czf', temporary, '--', ...entries], { cwd: root, stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`tar exited with code ${code}`)));
  });
  await rename(temporary, target);
  const { size } = await stat(target);
  console.log(`Ready: ${target} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
  console.log('Upload this archive to the server; see SERVER.md for installation and HTTPS setup.');
} catch (error) {
  await rm(temporary, { force: true });
  console.error(error.message); process.exitCode = 1;
}
