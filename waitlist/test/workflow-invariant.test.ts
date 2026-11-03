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

/** The trigger names declared under `on:` — the events that can start this workflow. */
function onTriggers(src: string): string[] {
  const lines = src.split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/.test(line));
  if (start === -1) {
    // Shorthand form: `on: [push, pull_request]`, or the single-event scalar.
    const value = (lines.find((line) => /^on:\s*\S/.test(line)) ?? '')
      .replace(/^on:\s*/, '')
      .trim();
    const items = /^\[(.*)\]$/.exec(value)?.[1] ?? value;
    return items
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter((item) => item.length > 0);
  }
  const triggers: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^ {2}/.test(line)) break; // the next top-level key ends the `on:` block
    const match = /^ {2}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match?.[1]) triggers.push(match[1]);
  }
  return triggers;
}

/**
 * `[scope, value]` pairs of one `permissions:` grant — inline map, indented
 * map, or the `read-all` / `write-all` scalar. Line comments (` # …`) are
 * stripped first, so a suffix cannot hide the grant's shape from either
 * branch. Any nonempty remainder that does not parse THROWS: an unparseable
 * widened grant must fail the test, never silently parse to zero entries and
 * pass the caller's `contents: read` pin.
 */
function permissionScopes(block: string): Array<[string, string]> {
  const lines = block.split('\n').map((line) => line.replace(/\s+#.*$/, '').trimEnd());
  const keyLine = lines.find((line) => /^\s*permissions:/.test(line)) ?? '';
  const inlineValue = keyLine.replace(/^\s*permissions:\s*/, '').trim();
  const entries: Array<[string, string]> = [];

  // The key line's own value: an inline map or a scalar shorthand.
  if (inlineValue.length > 0) {
    const inlineBody = /^\{(.*)\}$/.exec(inlineValue)?.[1] ?? null;
    if (inlineBody !== null) {
      // Inline map: `permissions: { contents: read, issues: read }`.
      for (const pair of inlineBody.split(',')) {
        const entry = pair.trim();
        if (entry === '') continue; // `{ }` — an explicit empty grant
        const match = /^([A-Za-z0-9_-]+):\s*([A-Za-z0-9_-]+)$/.exec(entry);
        if (!match?.[1] || !match?.[2]) {
          throw new Error(`unparseable permissions entry: "${entry}"`);
        }
        entries.push([match[1], match[2]]);
      }
    } else {
      // Scalar shorthand: `read-all` / `write-all` — every scope, i.e. wider
      // than the grant. Recorded as one entry the caller's `contents: read`
      // pin rejects.
      if (!/^(read|write)-all$/.test(inlineValue)) {
        throw new Error(`unparseable permissions value: "${inlineValue}"`);
      }
      entries.push(['all', inlineValue]);
    }
  }

  // Indented map: one `scope: value` line under the key. The key line never
  // reaches here — its remainder starts with `permissions:`, not a scope.
  for (const line of lines) {
    if (/^\s*permissions:/.test(line)) continue;
    const entry = line.trim();
    if (entry === '') continue;
    const match = /^([A-Za-z0-9_-]+):\s*([A-Za-z0-9_-]+)$/.exec(entry);
    if (!match?.[1] || !match?.[2]) {
      throw new Error(`unparseable permissions line: "${entry}"`);
    }
    entries.push([match[1], match[2]]);
  }
  return entries;
}

/** Every `permissions:` key nested inside `jobs:` — a job-level override. */
function jobPermissions(src: string): string[] {
  const lines = blockOf(src, 'jobs').split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^( +)permissions:\s*(.*)$/.exec(lines[i] ?? '');
    if (!match) continue;
    const indent = (match[1] ?? '').length;
    const body: string[] = [lines[i] ?? ''];
    for (const line of lines.slice(i + 1)) {
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      if ((/^( +)/.exec(line)?.[1] ?? '').length <= indent) break; // next key at this indent
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

describe('permissionScopes: every widened or unparseable grant must fail', () => {
  // The exact predicate the workflow guards apply: each parsed pair must be
  // `contents: read`; an unparseable grant throws out of the parser itself.
  const withinGrant = (block: string): void => {
    for (const [scope, value] of permissionScopes(block)) {
      expect(`${scope}: ${value}`, 'permissions widen the grant').toBe('contents: read');
    }
  };

  it('accepts the narrow shapes the workflow uses, comments included', () => {
    expect(() => withinGrant('')).not.toThrow(); // no grant at all
    expect(() => withinGrant('  contents: read')).not.toThrow();
    expect(() => withinGrant('  contents: read # why')).not.toThrow();
    expect(() => withinGrant('    permissions: { contents: read }')).not.toThrow();
    expect(() => withinGrant('    permissions: { contents: read } # why')).not.toThrow();
    expect(() => withinGrant('    permissions: { }')).not.toThrow(); // empty grant
  });

  it('rejects a widened inline map even when a comment follows it', () => {
    // Regression: `{ contents: read, issues: read } # CI` used to defeat the
    // inline regex (`\}\s*$`) and parse to zero entries, so the second scope
    // slipped past the `contents: read` pin.
    const widened = '    permissions: { contents: read, issues: read } # CI';
    expect(() => withinGrant(widened)).toThrow();
  });

  it('rejects the read-all / write-all scalars even when a comment follows them', () => {
    // Regression: `read-all # CI` used to parse to zero entries the same way
    // and leave every override check passing on a grant wider than the repo's.
    expect(() => withinGrant('    permissions: read-all # CI')).toThrow();
    expect(() => withinGrant('    permissions: write-all # CI')).toThrow();
    expect(() => withinGrant('    permissions: read-all')).toThrow();
  });

  it('fails closed on a nonempty grant it cannot parse', () => {
    // The parser must never mistake an unparseable grant for an empty one.
    expect(() => withinGrant(`    permissions: \${{ github.token }}`)).toThrow();
    expect(() => withinGrant('    permissions: contents read')).toThrow();
    expect(() => withinGrant('  contents: read\n  issues: read, write')).toThrow();
  });
});

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

// Mirrors of the permission and trigger guards in
// test/unit/waitlist-workflow-invariant.test.ts — pinned here too because a
// waitlist-only PR runs this suite, never the root one.
describe('waitlist CI workflow invariants: permissions and triggers', () => {
  it('pins the top-level grant to `contents: read`', () => {
    // The base the job-level check below is measured against: a job with no
    // `permissions:` key of its own inherits exactly this.
    const permissions = blockOf(workflow, 'permissions');
    expect(permissions).toMatch(/contents:\s*read/);
    expect(permissions).not.toMatch(/write/);
    for (const [scope, value] of permissionScopes(permissions)) {
      expect(`${scope}: ${value}`).toBe('contents: read');
    }
  });

  it('keeps every job-level permissions override within the top-level grant', () => {
    // A job-level `permissions:` key REPLACES the top-level block for that
    // job (GitHub does not intersect the two), so `permissions: { contents:
    // write }` on the job widens what CI can do while the top-level block
    // still reads `contents: read`. Every override must stay within the
    // grant: only `contents`, only `read` — an explicit `write` value, the
    // `write-all` shorthand and any second scope fail here, even when a
    // trailing comment follows the grant (the parser strips comments first
    // and throws on any nonempty grant it cannot parse).
    for (const block of jobPermissions(workflow)) {
      expect(block).not.toMatch(/write/);
      for (const [scope, value] of permissionScopes(block)) {
        expect(`${scope}: ${value}`, 'job-level permissions widen the grant').toBe(
          'contents: read',
        );
      }
    }
  });

  it('declares both triggers that put the job on PRs and main pushes', () => {
    // Deleting a trigger disables the check for everything it covered. This
    // existence pin is what makes "no `paths:` filter" mean "unrestricted"
    // rather than "never runs" in the paths-coverage guard of the root copy.
    expect(onTriggers(workflow)).toEqual(expect.arrayContaining(['pull_request', 'push']));
  });
});
