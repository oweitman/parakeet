import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = /[\p{L}\p{M}\p{N}_]/u;

export function createCorrector(config) {
  if (!config || typeof config.enabled !== 'boolean' || !Array.isArray(config.rules)) {
    throw new Error('Expected enabled (boolean) and rules (array)');
  }
  const replacements = new Map();
  for (const rule of config.rules) {
    if (!rule || typeof rule.replacement !== 'string' || !rule.replacement.trim() ||
        !Array.isArray(rule.variants) || !rule.variants.length) throw new Error('Each rule needs replacement and variants');
    for (const variant of rule.variants) {
      if (typeof variant !== 'string' || !variant.trim()) throw new Error('Variants must be non-empty strings');
      const normalized = variant.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
      if (replacements.has(normalized) && replacements.get(normalized) !== rule.replacement) {
        throw new Error(`Conflicting correction for ${JSON.stringify(variant)}`);
      }
      replacements.set(normalized, rule.replacement);
    }
  }
  // One pass, longest aliases first. Replacement output is never matched again.
  const alternatives = [...replacements.keys()].sort((a, b) => b.length - a.length)
    .map(variant => variant.split(' ').map(escapeRegex).join('\\s+'));
  const pattern = alternatives.length ? new RegExp(alternatives.join('|'), 'giu') : null;
  return {
    enabled: config.enabled,
    rules: config.rules.length,
    apply(rawText) {
      if (!config.enabled || !pattern) return rawText;
      const text = rawText;
      return text.replace(pattern, (match, offset) => {
        const before = [...text.slice(0, offset)].at(-1) || '';
        const after = String.fromCodePoint(text.codePointAt(offset + match.length) || 0);
        if (word.test(before) || word.test(after)) return match;
        return replacements.get(match.replace(/\s+/g, ' ').toLowerCase()) ?? match;
      });
    },
  };
}

export async function loadCorrector(env = process.env) {
  const setting = env.CORRECTIONS_ENABLED;
  if (setting !== undefined && !['0', '1'].includes(setting)) throw new Error('CORRECTIONS_ENABLED must be 0 or 1');
  if (setting === '0') return createCorrector({ enabled: false, rules: [] });
  const file = resolve(env.CORRECTIONS_FILE || 'config/corrections.json');
  try {
    const config = JSON.parse(await readFile(file, 'utf8'));
    return createCorrector(config);
  } catch (error) { throw new Error(`Correction dictionary ${file}: ${error.message}`); }
}
