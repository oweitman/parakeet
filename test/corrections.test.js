import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCorrector, loadCorrector } from '../server/corrections.js';

const dictionary = { enabled: true, rules: [
  { replacement: 'ioBroker', variants: ['io broker', 'eio broker', 'iobokrer'] },
] };

test('normalizes configured spellings case-insensitively and preserves punctuation', () => {
  const corrector = createCorrector(dictionary);
  const raw = 'IO broker, eio BROKER und iobokrer. ioBroker bleibt ioBroker.';
  assert.equal(corrector.apply(raw), 'ioBroker, ioBroker und ioBroker. ioBroker bleibt ioBroker.');
  assert.equal(raw, 'IO broker, eio BROKER und iobokrer. ioBroker bleibt ioBroker.');
});
test('matches complete Unicode words and phrases without changing unrelated text', () => {
  const corrector = createCorrector(dictionary);
  const untouched = 'Ein Broker, Bio broker, io brokerage, äio broker, io brokerü, _iobokrer, iobokrer2, e\u0301.';
  assert.equal(corrector.apply(untouched), untouched);
  assert.equal(corrector.apply('„IO\t broker“ und (eio   broker)!'), '„ioBroker“ und (ioBroker)!');
});
test('aliases are literal strings, replacements are literal and never cascade', () => {
  const corrector = createCorrector({ enabled: true, rules: [
    { replacement: '$& io broker', variants: ['c++'] },
    { replacement: 'ioBroker', variants: ['io broker'] },
  ] });
  assert.equal(corrector.apply('c++ und io broker'), '$& io broker und ioBroker');
  assert.equal(corrector.apply('ccccc'), 'ccccc');
});
test('longest matching phrase wins and duplicate aliases cannot disagree', () => {
  const corrector = createCorrector({ enabled: true, rules: [
    { replacement: 'SHORT', variants: ['io broker'] },
    { replacement: 'LONG', variants: ['io broker adapter'] },
  ] });
  assert.equal(corrector.apply('IO broker adapter und IO broker.'), 'LONG und SHORT.');
  assert.throws(() => createCorrector({ enabled: true, rules: [
    { replacement: 'A', variants: ['io broker'] }, { replacement: 'B', variants: ['IO   BROKER'] },
  ] }), /Conflicting/);
});
test('disabled dictionary and empty dictionary leave the model output untouched', () => {
  assert.equal(createCorrector({ ...dictionary, enabled: false }).apply('IO broker'), 'IO broker');
  assert.equal(createCorrector({ enabled: true, rules: [] }).apply('IO broker'), 'IO broker');
});
test('invalid dictionary fails with an actionable error', () => {
  for (const config of [null, {}, { rules: [] }, { enabled: true, rules: [{}] },
    { enabled: true, rules: [{ replacement: '', variants: ['test'] }] },
    { enabled: true, rules: [{ replacement: 'test', variants: [' '] }] }]) {
    assert.throws(() => createCorrector(config));
  }
});
test('loads a custom JSON dictionary; global off works without a dictionary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'parakeet-corrections-'));
  const file = join(directory, 'corrections.json');
  try {
    await writeFile(file, JSON.stringify(dictionary));
    const corrector = await loadCorrector({ CORRECTIONS_FILE: file });
    assert.equal(corrector.apply('IO broker'), 'ioBroker');
    assert.equal(corrector.enabled, true);
    assert.equal((await loadCorrector({ CORRECTIONS_ENABLED: '0', CORRECTIONS_FILE: 'missing.json' })).apply('IO broker'), 'IO broker');
    await writeFile(file, '{bad json');
    await assert.rejects(loadCorrector({ CORRECTIONS_FILE: file }), /Correction dictionary/);
    await assert.rejects(loadCorrector({ CORRECTIONS_ENABLED: 'false' }), /must be 0 or 1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
