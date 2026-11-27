import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The Firefox sources zip (`wxt zip -b firefox`, attached to every GitHub Release) is packed from
// the repo root and ignores .gitignore. Read as text, like manifest-invariant.test.ts, so the test
// needs no `wxt` import.
const __dirname = dirname(fileURLToPath(import.meta.url));
const config = readFileSync(resolve(__dirname, '../../wxt.config.ts'), 'utf8');
// The array literal, with comment lines dropped so a commented-out pattern never counts.
const excluded = (config.match(/excludeSources:\s*\[([^\]]*)\]/)?.[1] ?? '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');
const patterns = Array.from(excluded.matchAll(/'([^']+)'/g), (m) => m[1]);

describe('wxt zip sources', () => {
  it('never packs the signing key, any PEM, or any local .env file', () => {
    expect(patterns).toEqual(expect.arrayContaining(['keys/**', '**/*.pem', '.env', '.env.*']));
  });
});
