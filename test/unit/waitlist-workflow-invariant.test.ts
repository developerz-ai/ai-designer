import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve directly from `import.meta.url` (a `file:` URL) rather than
// `new URL('.', import.meta.url)` — under Vitest's jsdom env the relative-URL
// constructor rewrites the `file:` base to `http://localhost:3000/...`, so
// fileURLToPath would throw "The URL must be of scheme file".
const __dirname = dirname(fileURLToPath(import.meta.url));

const WORKFLOW_PATH = resolve(__dirname, '../../.github/workflows/waitlist.yml');
const MAINTAINER_PATH = resolve(__dirname, '../../.dz/maintainer/maintainer.yml');
const WAITLIST_PACKAGE_PATH = resolve(__dirname, '../../waitlist/package.json');

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const maintainer = readFileSync(MAINTAINER_PATH, 'utf8');
const waitlistPackage = readFileSync(WAITLIST_PACKAGE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Text parsers (no YAML dependency: the workflow is read as text, same shape as
// the wxt.config.ts parser in manifest-invariant.test.ts).
// ---------------------------------------------------------------------------

/** The body of a top-level block (`jobs:`, `permissions:`) — its indented lines. */
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

/** The start line of a job block, addressed by job id (not by position). */
function jobStart(src: string, jobId: string): number {
  const lines = blockOf(src, 'jobs').split('\n');
  return lines.findIndex((line) => /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1] === jobId);
}

/** The `name:` value of a job block (the GitHub check name). */
function jobCheckName(src: string, jobId: string): string | undefined {
  const lines = blockOf(src, 'jobs').split('\n');
  const start = jobStart(src, jobId);
  if (start === -1) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) break; // next job
    const match = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].replace(/^['"]|['"]$/g, '');
  }
  return undefined;
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
  const start = jobStart(src, jobId);
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

/** The `paths:` filter entries of one `on:` trigger (pull_request / push). */
function onPaths(src: string, trigger: string): string[] {
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(lines[i] ?? '');
    if (match?.[1] !== trigger) continue;
    // The `paths:` filter belongs to THIS trigger only: stop at the next
    // two-space key. Without that bound a trigger with no filter of its own
    // borrows the next trigger's paths, and the assertion passes for the wrong
    // reason.
    const pathsIndex = lines.findIndex((line, index) => index > i && /^ {4}paths:\s*$/.test(line));
    if (pathsIndex === -1) return [];
    const ownsPaths = !lines
      .slice(i + 1, pathsIndex)
      .some((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
    if (!ownsPaths) return [];
    const paths: string[] = [];
    for (const line of lines.slice(pathsIndex + 1)) {
      // A comment may sit between two entries; it is not an entry.
      if (/^ {6}#/.test(line)) continue;
      if (!/^ {6}- /.test(line)) break;
      paths.push(line.replace(/^ {6}- /, '').replace(/^['"]|['"]$/g, ''));
    }
    return paths;
  }
  return [];
}

/** The `required_checks:` entries of the maintainer policy. */
function requiredChecks(src: string): string[] {
  const lines = src.split('\n');
  const start = lines.findIndex((line) => /^ {2}required_checks:\s*$/.test(line));
  if (start === -1) return [];
  const checks: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^ {4}- /.test(line)) break;
    checks.push(line.replace(/^ {4}- /, '').replace(/^['"]|['"]$/g, ''));
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Glob matching (GitHub path filters): `**` spans any number of segments,
// `*` stays inside one segment. Small on purpose — the workflow only uses
// these two wildcards.
// ---------------------------------------------------------------------------

/** Translate one GitHub path-filter glob into an anchored regular expression. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    // `charAt` (not `glob[i]`): under `noUncheckedIndexedAccess` an index
    // access is `string | undefined`, which would not narrow at the `.replace`
    // below.
    const char = glob.charAt(i);
    if (char === '*') {
      const isDoubleStar = glob[i + 1] === '*';
      if (isDoubleStar) {
        // `**/` may also match zero segments, so `a/**/b` matches `a/b`.
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
        continue;
      }
      source += '[^/]*';
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Does any path-filter glob of this trigger cover the given repo-relative path? */
function pathsCover(paths: string[], path: string): boolean {
  return paths.some((glob) => globToRegExp(glob).test(path));
}

// ---------------------------------------------------------------------------
// waitlist/package.json — the script chain that carries lint+typecheck into CI.
// ---------------------------------------------------------------------------

/** The `scripts` map of waitlist/package.json. */
function waitlistScripts(): Record<string, string> {
  const parsed = JSON.parse(waitlistPackage) as { scripts?: Record<string, string> };
  return parsed.scripts ?? {};
}

// ---------------------------------------------------------------------------
// MIRRORED in waitlist/test/workflow-invariant.test.ts — keep the two in sync.
//
// This copy is the canonical one, but it does NOT run on a waitlist-only PR:
// ci.yml paths-ignores `waitlist/**`, so GitHub runs no root check there, and
// the root vitest project only includes `test/**`. The waitlist copy is the
// one the `Waitlist tests` job actually executes (waitlist/vitest.config.ts
// includes `test/**` from waitlist/), so the chain invariant must be asserted
// there too — otherwise the only PR where waitlist lint/typecheck enforcement
// matters is the one PR where the guard never executes.

describe('waitlist package.json runs lint and typecheck before the suite', () => {
  it('chains `bun run lint` -> `bun run typecheck` -> `vitest run`, in that order', () => {
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
    // One job, one check name. A second job would add a check name the external
    // branch-protection ruleset never requires, and the maintainer bot would
    // wait forever on a check that reports under a different name.
    expect(jobIds(workflow)).toEqual(['waitlist']);
  });

  it('keeps the GitHub check name `Waitlist tests`', () => {
    expect(jobCheckName(workflow, 'waitlist')).toBe('Waitlist tests');
  });

  it('runs the waitlist dependency install before the test step', () => {
    const steps = jobSteps(workflow, 'waitlist');
    const install = steps.findIndex((step) => step.run === 'bun install --frozen-lockfile');
    const test = steps.findIndex((step) => step.run.startsWith('bun run test'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThan(install);
  });

  it('invokes `bun run test` inside waitlist/ — the link that brings lint+typecheck into CI', () => {
    const testSteps = jobSteps(workflow, 'waitlist').filter((step) =>
      step.run.startsWith('bun run test'),
    );
    expect(testSteps.length).toBeGreaterThanOrEqual(1);
    for (const step of testSteps) {
      expect(step.workingDirectory, `step "${step.name}" runs outside waitlist/`).toBe('waitlist');
    }
  });

  it('has no separate lint or typecheck step — they live in the script chain', () => {
    // Lint and typecheck are steps of the `bun run test` chain inside
    // waitlist/package.json, not steps of this job: a step of their own would
    // be a second place to keep in sync, and `Waitlist lint` / `Waitlist
    // typecheck` are not check names this workflow reports.
    const runs = jobSteps(workflow, 'waitlist').map((step) => step.run);
    expect(runs).not.toContain('bun run lint');
    expect(runs).not.toContain('bun run typecheck');
    for (const run of runs) {
      expect(run).not.toMatch(/biome check|tsc --noEmit/);
    }
  });

  it('runs every waitlist step inside waitlist/', () => {
    const steps = jobSteps(workflow, 'waitlist').filter((step) => step.run.startsWith('bun '));
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.workingDirectory, `step "${step.name}" runs outside waitlist/`).toBe('waitlist');
    }
  });

  it('keeps `permissions: contents: read` and references no secrets', () => {
    expect(blockOf(workflow, 'permissions')).toMatch(/contents:\s*read/);
    expect(workflow).not.toMatch(/secrets\./);
  });

  it('does not widen the workflow permissions', () => {
    // `contents: read` only. A `write` permission or a second scope would
    // widen what an untrusted PR can reach from CI.
    const permissions = blockOf(workflow, 'permissions');
    expect(permissions).not.toMatch(/write/);
    const scopes = permissions
      .split('\n')
      .map((line) => /^\s{2}([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line))
      .filter((match): match is RegExpExecArray => Boolean(match));
    // group 1 is the scope name, group 2 its value.
    expect(scopes.map(([, , value]) => value)).toEqual(['read']);
    expect(scopes.map(([, name]) => name)).toEqual(['contents']);
  });

  it('triggers on the waitlist sources, tests, manifest and lockfile', () => {
    // The filter is matched, not compared literally: a filter that covers
    // `waitlist/**` also covers the source, the tests, package.json and
    // bun.lock. What matters is that a change to any of them runs this job.
    const required = [
      'waitlist/src/index.ts',
      'waitlist/test/app.test.ts',
      'waitlist/package.json',
      'waitlist/bun.lock',
    ];
    for (const trigger of ['pull_request', 'push']) {
      const paths = onPaths(workflow, trigger);
      // No filter at all means the trigger runs on every change: that covers
      // everything, so the check below passes for the right reason.
      const coversEverything = paths.length === 0;
      for (const path of required) {
        const covered = coversEverything || pathsCover(paths, path);
        expect(covered, `${trigger} paths do not cover ${path}`).toBe(true);
      }
    }
  });

  it('never ignores waitlist paths', () => {
    // A `paths-ignore:` key would let a waitlist change skip the job entirely.
    // Match the YAML key, not the prose: the header comment may name it.
    expect(workflow).not.toMatch(/^\s*paths-ignore\s*:/m);
  });
});

describe('maintainer required-check list matches the checks that actually report', () => {
  it('requires `Waitlist tests`', () => {
    expect(requiredChecks(maintainer)).toContain('Waitlist tests');
  });

  it('does not require the `Waitlist lint` / `Waitlist typecheck` checks', () => {
    // Those names would never report: lint and typecheck are steps of the single
    // `Waitlist tests` job, not jobs of their own. Naming them here would make
    // the maintainer bot wait on checks that can never arrive.
    const checks = requiredChecks(maintainer);
    expect(checks).not.toContain('Waitlist lint');
    expect(checks).not.toContain('Waitlist typecheck');
  });

  it('keeps every root check entry unchanged', () => {
    expect(requiredChecks(maintainer)).toEqual([
      'Lint',
      'Typecheck',
      'Test (unit + integration)',
      'Build extension',
      'Test (e2e)',
      'Waitlist tests',
    ]);
  });
});
