import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The waitlist-reachable mirror of test/unit/waitlist-workflow-invariant.test.ts.
//
// Why this file exists at all: the root CI workflow paths-ignores `waitlist/**`
// (.github/workflows/ci.yml), and the root vitest project only includes `test/**`
// (vitest.config.ts). So on a waitlist-only PR GitHub runs NO root check, and
// the root guard never executes — while .github/workflows/waitlist.yml is the
// ONLY place waitlist lint/typecheck are enforced. That is exactly the case
// this file has to cover, so the chain invariant is asserted here, in the
// waitlist suite the `Waitlist tests` job actually runs.
//
// The two copies pin the same facts and must not drift: if either changes,
// change both.
//
// Resolve from `import.meta.url` (a `file:` URL) rather than `new URL('.',
// import.meta.url)` — the relative-URL constructor rewrites the `file:` base
// under some environments, and fileURLToPath would then throw "The URL must be
// of scheme file".
const __dirname = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = resolve(__dirname, '../..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/waitlist.yml');
const WAITLIST_PACKAGE_PATH = resolve(REPO_ROOT, 'waitlist/package.json');

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const waitlistPackage = readFileSync(WAITLIST_PACKAGE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Text parsers (no YAML dependency: the workflow is read as text, same shape as
// the root copy of this guard).
// ---------------------------------------------------------------------------

/** The body of a top-level block (`jobs:`) — its indented lines. */
function blockOf(src: string, key: string): string {
  const lines = src.split('\n');
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return '';
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      body.push(line);
      continue;
    }
    if (!/^\s/.test(line)) break; // next top-level key ends the block
    body.push(line);
  }
  return body.join('\n');
}

/** Job ids declared under `jobs:` — keys at exactly two spaces of indent. */
function jobIds(src: string): string[] {
  return blockOf(src, 'jobs')
    .split('\n')
    .map((line) => /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1])
    .filter((id): id is string => Boolean(id));
}

/** One CI step: its display name, its shell command and its working directory. */
type Step = { name: string; run: string; workingDirectory: string };

/**
 * The ordered step list of a job.
 * A step starts at `- uses:` / `- name:` under `steps:` (six spaces of indent
 * for the `-`, four for the keys).
 */
function jobSteps(src: string, jobId: string): Step[] {
  const lines = blockOf(src, 'jobs').split('\n');
  const start = lines.findIndex((line) => /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1] === jobId);
  if (start === -1) return [];
  const steps: Step[] = [];
  let current: Step | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break; // next job
    // A step opens with `- uses:` / `- name:` at six spaces of indent. The
    // `- name:` form carries the step's display name, so keep it.
    const stepStart = /^ {6}- (uses|name):\s*(.+?)\s*$/.exec(line);
    if (stepStart) {
      if (current) steps.push(current);
      current = {
        name: stepStart[1] === 'name' ? (stepStart[2] ?? '') : '',
        run: '',
        workingDirectory: '',
      };
      continue;
    }
    if (!current) continue;
    const name = /^ {8}name:\s*(.+?)\s*$/.exec(line);
    if (name?.[1]) {
      current.name = name[1].replace(/^['"]|['"]$/g, '');
      continue;
    }
    const run = /^ {8}run:\s*(.+?)\s*$/.exec(line);
    if (run?.[1]) {
      current.run = run[1].replace(/^['"]|['"]$/g, '');
      continue;
    }
    const dir = /^ {8}working-directory:\s*(.+?)\s*$/.exec(line);
    if (dir?.[1]) {
      current.workingDirectory = dir[1].replace(/^['"]|['"]$/g, '');
    }
  }
  if (current) steps.push(current);
  return steps;
}

/** The `scripts` map of waitlist/package.json. */
function waitlistScripts(): Record<string, string> {
  const parsed = JSON.parse(waitlistPackage) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

// ---------------------------------------------------------------------------

describe('waitlist package.json runs lint and typecheck before the suite', () => {
  it('chains `bun run lint` -> `bun run typecheck` -> `vitest run`, in that order', () => {
    // The chain is what carries waitlist lint and typecheck into CI: the
    // workflow's single Test step runs `bun run test` inside waitlist/, and
    // this script is what that step executes. Without lint and typecheck in
    // the chain, a waitlist-only PR is linted by nothing at all.
    const test = waitlistScripts().test;
    expect(test).toBeTypeOf('string');
    const chain = (test as string)
      .split('&&')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    expect(chain).toEqual(['bun run lint', 'bun run typecheck', 'vitest run']);
  });

  it('keeps lint and typecheck as the scripts the chain invokes', () => {
    // The chain calls the package's own scripts, so the names must exist.
    const scripts = waitlistScripts();
    expect(scripts.lint).toBeTypeOf('string');
    expect(scripts.typecheck).toBeTypeOf('string');
    expect(scripts.test as string).toContain('bun run lint');
    expect(scripts.test as string).toContain('bun run typecheck');
  });

  it('short-circuits on the first failure so a lint error fails the job', () => {
    // `&&` and not `;` / `||`: a nonzero lint or typecheck exit must stop the
    // chain, otherwise the job would stay green on a broken waitlist.
    const test = waitlistScripts().test as string;
    expect(test).toContain('&&');
    expect(test).not.toMatch(/;|\|\|/);
  });
});

describe('waitlist CI workflow invariants', () => {
  it('declares exactly one job, id `waitlist`', () => {
    // One job, one check name (`Waitlist tests`). A second job would mint a
    // check name the external branch-protection ruleset never requires.
    expect(jobIds(workflow)).toEqual(['waitlist']);
  });

  it('invokes `bun run test` inside waitlist/ — the link that brings lint+typecheck into CI', () => {
    const steps = jobSteps(workflow, 'waitlist');
    const testSteps = steps.filter((step) => step.run.startsWith('bun run test'));
    expect(testSteps.length).toBeGreaterThanOrEqual(1);
    for (const step of testSteps) {
      expect(step.workingDirectory, `step "${step.name}" runs outside waitlist/`).toBe('waitlist');
    }
  });

  it('runs the waitlist dependency install before the test step', () => {
    const steps = jobSteps(workflow, 'waitlist');
    const install = steps.findIndex((step) => step.run === 'bun install --frozen-lockfile');
    const test = steps.findIndex((step) => step.run.startsWith('bun run test'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(install);
  });
});
