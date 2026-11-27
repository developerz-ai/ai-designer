import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// release.yml publishes to the Chrome Web Store with --auto-publish, i.e. to every user. These
// invariants keep it from shipping something nobody meant to ship. Parsed as text (no YAML
// dependency, same approach as check-pipeline.test.ts), with comment lines stripped first so a
// commented-out step can never satisfy an assertion.

const __dirname = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(resolve(__dirname, '../../.github/workflows/release.yml'), 'utf8')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

/** The body of a top-level job: everything after `  <id>:` up to the next 2-space key. */
function job(id: string): string {
  const match = new RegExp(`^ {2}${id}:\\n((?: {4,}.*\\n|\\s*\\n)*)`, 'm').exec(`${text}\n`);
  expect(match, `job "${id}" exists`).not.toBeNull();
  return match?.[1] ?? '';
}

interface Step {
  readonly name: string;
  readonly if: string;
  readonly run: string;
}

/** A job's steps, in order. */
function steps(jobBody: string): Step[] {
  return jobBody
    .split(/^ {6}- /m)
    .slice(1)
    .map((chunk) => ({
      name: /(?:^|\n)\s*name: (.+)/.exec(chunk)?.[1]?.trim() ?? '',
      if: /(?:^|\n)\s*if: (.+)/.exec(chunk)?.[1]?.trim() ?? '',
      run: chunk,
    }));
}

describe('release.yml', () => {
  it('builds nothing until verify passes, and verify runs lint, typecheck and the tests', () => {
    expect(job('release')).toMatch(/^ {4}needs: \[verify\]$/m);
    const verify = steps(job('verify'));
    for (const command of ['bun run lint', 'bun run typecheck', 'bun run test']) {
      expect(
        verify.some((step) => step.run.includes(`run: ${command}`)),
        command,
      ).toBe(true);
    }
  });

  it('refuses a non-tag ref as the very first step, case-sensitively', () => {
    const [first] = steps(job('verify'));
    expect(first?.name).toBe('Require a v* tag');
    expect(first?.if).toBe(''); // unconditional — not a case-insensitive startsWith()
    expect(first?.run).toContain('refs/tags/v*) ;;');
    expect(first?.run).toContain('exit 1');
  });

  it('lets nothing bypass a red verify: no job-level if on release, no continue-on-error anywhere', () => {
    // `if: always()` on release would publish after verify failed; `continue-on-error` on a step
    // would turn a failing suite green.
    expect(job('release')).not.toMatch(/^ {4}if:/m);
    expect(text).not.toMatch(/continue-on-error/);
  });

  it('gives write access only to the publishing job', () => {
    expect(job('verify')).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
  });

  it('never sends a prerelease tag to the Chrome Web Store', () => {
    expect(job('release')).toContain("PRERELEASE: ${{ contains(github.ref_name, '-') }}");
    const release = steps(job('release'));
    for (const name of ['Build store zip', 'Publish to Chrome Web Store']) {
      const step = release.find((s) => s.name === name);
      expect(step?.if, name).toBe("env.HAS_CWS == 'true' && env.PRERELEASE != 'true'");
    }
  });
});
