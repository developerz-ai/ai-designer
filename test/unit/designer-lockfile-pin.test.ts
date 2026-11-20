import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A GUARD, not a behavioural test — "make the machine careful" (00-philosophy.md §5): a rule in a
// comment is advice the next agent can miss, a failing test is a fact it cannot.
//
// WHAT IT PROTECTS: the designer sub-project's transitive `fast-uri` resolution. Nothing in
// docs/design/designer/package.json names it — it arrives under ajv — so no specifier bump can
// hold it in place: the next `pnpm install` (any dependency added, any lockfile refresh) is free
// to re-resolve it downwards, and no CI job installs this directory (`ci.yml` ignores docs/**;
// only `.github/dependabot.yml` reads it). The lockfile is therefore the only record of the floor,
// and this guard is the only thing that keeps a re-resolve from silently dropping under it.
//
// SOURCE guard on purpose: the defect is one version string (and the sha512 beside it) in
// docs/design/designer/pnpm-lock.yaml, which is where the next agent is looking. A version alone is
// not the whole pin — pnpm verifies the tarball against the recorded integrity, so a hand-typed hash
// with one wrong character fails `pnpm install --frozen-lockfile` with EINTEGRITY while a
// version-only guard stays green. Shape follows test/unit/waitlist-image-pin.test.ts:
// read the file as text, extract the part that matters into a pure function, assert a fact about
// it — then prove the matcher can still fail.

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../', rel), 'utf8');

const LOCKFILE = 'docs/design/designer/pnpm-lock.yaml';

/** The floor: every fast-uri reference in the designer's lockfile must be at least this version. */
const MIN_FAST_URI = '3.1.7';

/**
 * The registry sha512 for fast-uri@3.1.7 (npm packument `dist.integrity`, from
 * https://registry.npmjs.org/fast-uri/3.1.7). The lockfile records it verbatim, and pnpm fails the
 * frozen install if it does not match the published tarball — so it is a pin in its own right and is
 * asserted here beside the version.
 */
const FAST_URI_INTEGRITY =
  'sha512-dOvZVzjdZdz7phd9v6jCbwxrBW3fK6n8Rc0CtdmM4bumzMnxywBYhuph6J819RRw/ku+rLbelwfMunktuzVVHg==';

/** A `packages:` / `snapshots:` key line: `  fast-uri@X.Y.Z:` (pnpm indents entries by two). */
const FAST_URI_KEY = /^ {2}fast-uri@(\d+\.\d+\.\d+):/;
/** A dependency ref inside another package's snapshot: `      fast-uri: X.Y.Z`. */
const FAST_URI_DEP = /^\s+fast-uri: (\d+\.\d+\.\d+)\s*$/;
/** A column-0 block header — `packages:` — so a failure can say WHERE the ref sits. */
const TOP_LEVEL_BLOCK = /^([a-z][a-z-]*):\s*$/;
/** The `resolution` line pnpm indents under a package key: `    resolution: {integrity: sha512-…}`. */
const INTEGRITY_LINE = /^ {4}resolution: \{integrity: (sha512-\S+)\}/;

type Section = 'packages' | 'snapshots' | 'dependency';
type FastUriRef = { section: Section; version: string };

const parseVersion = (version: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return [major, minor, patch];
};

/** `a` >= `b`, compared numerically — string compare would call 3.1.10 older than 3.1.9. */
function isAtLeast(a: string, b: string): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

/**
 * Every fast-uri version this lockfile records, wherever it records it. Throws on an empty result
 * rather than returning [] — a matcher that finds NOTHING must not read as "nothing wrong", or the
 * guard would pass forever on a renamed or relocated lockfile.
 */
function fastUriRefs(lockfile: string): FastUriRef[] {
  const refs: FastUriRef[] = [];
  let block = '';
  for (const raw of lockfile.split('\n')) {
    const header = TOP_LEVEL_BLOCK.exec(raw);
    if (header?.[1]) {
      block = header[1];
      continue;
    }
    const key = FAST_URI_KEY.exec(raw)?.[1];
    if (key) {
      refs.push({ section: block === 'snapshots' ? 'snapshots' : 'packages', version: key });
      continue;
    }
    const dep = FAST_URI_DEP.exec(raw)?.[1];
    if (dep) refs.push({ section: 'dependency', version: dep });
  }
  if (refs.length === 0) throw new Error(`no fast-uri reference in ${LOCKFILE}`);
  return refs;
}

/**
 * The sha512 recorded for the fast-uri package entry, or null when the entry carries none. Only the
 * `packages:` entry has a `resolution` block — the `snapshots:` entry is a bare key — so this reads
 * the lines under the package key until the next entry begins.
 */
function fastUriIntegrity(lockfile: string): string | null {
  let block = '';
  let inPackagesEntry = false;
  for (const raw of lockfile.split('\n')) {
    const header = TOP_LEVEL_BLOCK.exec(raw);
    if (header?.[1]) {
      block = header[1];
      inPackagesEntry = false;
      continue;
    }
    if (FAST_URI_KEY.test(raw)) {
      inPackagesEntry = block !== 'snapshots';
      continue;
    }
    // A two-space-indented line is the next package key, so this entry has ended.
    if (inPackagesEntry && /^ {2}\S/.test(raw)) inPackagesEntry = false;
    if (!inPackagesEntry) continue;
    const integrity = INTEGRITY_LINE.exec(raw)?.[1];
    if (integrity) return integrity;
  }
  return null;
}

/**
 * Every reason the recorded floor is not held. Empty = every fast-uri ref reads >= MIN_FAST_URI and
 * the lockfile still carries all three shapes ajv's tree produces (a resolved package entry, its
 * snapshot, and the dependency ref that pulls it in) — so a partially re-resolved lockfile that
 * drops one of them is a defect too, not a quietly smaller file.
 */
function floorViolations(lockfile: string): string[] {
  const refs = fastUriRefs(lockfile);
  const violations: string[] = [];
  for (const ref of refs) {
    if (!isAtLeast(ref.version, MIN_FAST_URI)) {
      violations.push(`${ref.section}: fast-uri ${ref.version} < ${MIN_FAST_URI}`);
    }
  }
  for (const section of ['packages', 'snapshots', 'dependency'] as const) {
    if (!refs.some((ref) => ref.section === section)) {
      violations.push(`no fast-uri ${section} entry — the lockfile no longer records this floor`);
    }
  }
  return violations;
}

describe(`the designer lockfile pins fast-uri at or above ${MIN_FAST_URI}`, () => {
  it('every resolution and dependency ref meets the floor', () => {
    expect(floorViolations(read(LOCKFILE))).toEqual([]);
  });

  it('records the registry sha512 for the resolved version, not just its number', () => {
    expect(fastUriIntegrity(read(LOCKFILE))).toBe(FAST_URI_INTEGRITY);
  });
});

describe('the guard itself detects what it claims to', () => {
  // A guard that cannot fail is worse than no guard: it reads as protection and provides none.
  const fixed = [
    'lockfileVersion: 9.0',
    '',
    'packages:',
    '',
    `  fast-uri@${MIN_FAST_URI}:`,
    `    resolution: {integrity: ${FAST_URI_INTEGRITY}}`,
    '',
    'snapshots:',
    '',
    '  ajv@8.20.0:',
    '    dependencies:',
    `      fast-uri: ${MIN_FAST_URI}`,
    '',
    `  fast-uri@${MIN_FAST_URI}: {}`,
    '',
  ].join('\n');

  it('accepts the shape the lockfile ships', () => {
    expect(floorViolations(fixed)).toEqual([]);
    expect(fastUriRefs(fixed)).toEqual([
      { section: 'packages', version: MIN_FAST_URI },
      { section: 'dependency', version: MIN_FAST_URI },
      { section: 'snapshots', version: MIN_FAST_URI },
    ]);
  });

  it('reads the integrity under the packages entry, and rejects a mistyped hash', () => {
    expect(fastUriIntegrity(fixed)).toBe(FAST_URI_INTEGRITY);
    // One character of the hand-typed hash: pnpm would fail the frozen install with EINTEGRITY.
    const typo = fixed.replace('sha512-dOvZ', 'sha512-dOvX');
    expect(typo).not.toBe(fixed);
    expect(fastUriIntegrity(typo)).not.toBe(FAST_URI_INTEGRITY);
    // No resolution block at all — the matcher finds nothing and says so, not "nothing wrong".
    expect(fastUriIntegrity(fixed.replace('    resolution:', '    # resolution:'))).toBeNull();
  });

  it('flags 3.1.5 in every place it can hide', () => {
    const old = fixed.replaceAll(MIN_FAST_URI, '3.1.5');
    const violations = floorViolations(old);
    expect(violations).toHaveLength(3);
    expect(violations.join('\n')).toContain('packages: fast-uri 3.1.5 < 3.1.7');
    expect(violations.join('\n')).toContain('snapshots: fast-uri 3.1.5 < 3.1.7');
    expect(violations.join('\n')).toContain('dependency: fast-uri 3.1.5 < 3.1.7');
  });

  it('flags one stale ref left behind in an otherwise fixed lockfile', () => {
    // The realistic re-resolve: the packages entry moves, a snapshot ref does not.
    const mixed = fixed.replace(`      fast-uri: ${MIN_FAST_URI}`, '      fast-uri: 3.1.5');
    const violations = floorViolations(mixed);
    expect(violations).toEqual(['dependency: fast-uri 3.1.5 < 3.1.7']);
  });

  it('flags a lockfile that dropped one of the three recorded shapes', () => {
    const withoutSnapshot = fixed.replace(`  fast-uri@${MIN_FAST_URI}: {}\n`, '');
    expect(floorViolations(withoutSnapshot).join('\n')).toContain('no fast-uri snapshots entry');
  });

  it('compares numerically, not as strings — 3.1.10 is newer than 3.1.9', () => {
    expect(isAtLeast('3.1.10', '3.1.9')).toBe(true);
    expect(isAtLeast('3.10.0', '3.9.0')).toBe(true);
    expect(isAtLeast(MIN_FAST_URI, MIN_FAST_URI)).toBe(true);
    expect(isAtLeast('3.1.6', MIN_FAST_URI)).toBe(false);
    expect(isAtLeast('4.0.0', MIN_FAST_URI)).toBe(true);
  });

  it('throws instead of passing when there is no fast-uri line to read', () => {
    expect(() => fastUriRefs('packages:\n\n  zod@3.23.8: {}\n')).toThrow(/no fast-uri reference/);
  });
});
