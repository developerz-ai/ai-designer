import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// release.yml publishes to the Chrome Web Store with --auto-publish, i.e. to every user. Two
// invariants keep that from shipping something nobody meant to ship, read off the workflow text
// (the same text-parse approach as check-pipeline.test.ts — no YAML dependency).

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8');

/** The `if:` of the step whose `- name:` line is `name`. */
function stepIf(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`);
  expect(start, `step "${name}" exists`).toBeGreaterThan(-1);
  const next = workflow.indexOf('- name:', start + 1);
  const body = workflow.slice(start, next === -1 ? undefined : next);
  return body.match(/^\s+if: (.+)$/m)?.[1] ?? '';
}

describe('release.yml', () => {
  it('builds nothing until the verify job (lint + typecheck + tests) passes', () => {
    expect(workflow).toMatch(/^ {2}release:\n(?: {4}.*\n)*? {4}needs: \[verify\]/m);
    expect(workflow).toMatch(/^ {2}verify:/m);
    for (const command of ['bun run lint', 'bun run typecheck', 'bun run test']) {
      expect(workflow).toContain(`run: ${command}`);
    }
  });

  it('never sends a prerelease tag to the Chrome Web Store', () => {
    expect(workflow).toContain("PRERELEASE: ${{ contains(github.ref_name, '-') }}");
    for (const step of ['Build store zip', 'Publish to Chrome Web Store']) {
      expect(stepIf(step)).toContain("env.PRERELEASE != 'true'");
    }
  });
});
