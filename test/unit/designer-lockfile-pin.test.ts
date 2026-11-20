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

const MANIFEST = 'docs/design/designer/package.json';
const NEXT_VERSION = '16.3.8';
// Registry dist.integrity from https://registry.npmjs.org/<package>/16.3.8.
// Pin the bytes too: matching version strings alone cannot prevent EINTEGRITY.
const NEXT_INTEGRITIES = {
  next: 'sha512-U7QEZaTini6wKrb8A8hqLLqYQyCetegKjCpJOyxk642vWoMoU1x5PyZCJFvgYgiptA8xc5j/9xYlZFO7w9Sjmw==',
  '@next/env':
    'sha512-Al9zqHVV7TJv0eFuOU4U7Lvv74PTih4Ch63sk2xCIpSTkE3udFnaOcnzP2lQVymiL7yS9Cj2iClUXlR3EQ5sEw==',
  '@next/swc-darwin-arm64':
    'sha512-2JPRMh2nmQG5CiL7cXGL9AGwnPWJQ//cTtAUCT+w511QHk79SYz3LGv/pc5X643B/WEO0rvu3Yww0hqwt3kgeA==',
  '@next/swc-darwin-x64':
    'sha512-GZtCCOBKJ4leVIT/Th0llWKhD1ca92lzbQiS5R5ON9QkoiFnilFsebDae1JU2a3HWoKMEmEZWGs1AGLavVM72Q==',
  '@next/swc-linux-arm64-gnu':
    'sha512-O659ygeQYqneJ1fBKMpFxIFqYkYswu8IAS1OCKK/4f3ZgJJm1dRz4fVJZRi/kLLWjnBKnebOePA4WNv+sV1pVA==',
  '@next/swc-linux-arm64-musl':
    'sha512-dSjKSyWpzxoO1d3DIZZcP4XJcNaKeLmxQMFOiYl5vuBRMmweIqnAhty8tAmRsvTss779cK1FtYnDMj40e4TQlg==',
  '@next/swc-linux-x64-gnu':
    'sha512-lbqOuz3RPRcv+o9msNsJw5x4+Y1ZwPTs6vmL6DCf7i0fZfvng/F59wyeDwqHIvV0mK//RBy/jJkZ+nCKsSMXjQ==',
  '@next/swc-linux-x64-musl':
    'sha512-+316WswI8ScVgZeUd+1KGaXkHhaYQzCjvH/05TZSpJ8zBizb1a4G7DtO7F12jcBIqMOtsz9ji1t48fmKtzqsGA==',
  '@next/swc-win32-arm64-msvc':
    'sha512-ji0gd4kMYUxO+1fJBIbiBVRCjzG/lloiyCccnlebvb1ZJ5qXCPZqYg4Jl1DrrixnWNMKylzgpmMWx0yNDYXlzw==',
  '@next/swc-win32-x64-msvc':
    'sha512-WcTlaKt/TWkh5kUjdJcUmB1XgZ+1c6fz4Y9fDHL73YNSdGaUWjceeWrrlwF0nv19iABYWC4iAq1oX1w4Bn0vfg==',
};

/** Read pnpm's two-space package entries without depending on a YAML parser. */
function lockEntries(section: string): Map<string, string> {
  return new Map(
    [...section.matchAll(/^ {2}'?([^\n]+?)'?:([^\n]*(?:\n(?: {4}[^\n]*|))*)/gm)].map((match) => [
      match[1] ?? '',
      match[2] ?? '',
    ]),
  );
}

function nextViolations(manifest: string, lockfile: string): string[] {
  const violations: string[] = [];
  const check = (ok: boolean, label: string) => {
    if (!ok) violations.push(label);
  };
  check(JSON.parse(manifest).dependencies?.next === NEXT_VERSION, 'manifest pin');
  const importer = /^ {6}next:\n {8}specifier: ([^\n]+)\n {8}version: ([^\n]+)/m.exec(
    lockfile.split('\npackages:')[0] ?? '',
  );
  check(importer?.[1] === NEXT_VERSION, 'importer specifier');
  check(importer?.[2]?.split('(')[0] === NEXT_VERSION, 'importer resolution');
  const packages = lockEntries(lockfile.split('\npackages:\n')[1]?.split('\nsnapshots:')[0] ?? '');
  const snapshots = lockEntries(lockfile.split('\nsnapshots:\n')[1] ?? '');
  const nextSnapshot = snapshots.get(`next@${importer?.[2]}`);
  check(nextSnapshot !== undefined, 'Next snapshot matches importer');
  for (const [name, integrity] of Object.entries(NEXT_INTEGRITIES)) {
    const key = `${name}@${NEXT_VERSION}`;
    check(packages.get(key)?.includes(`resolution: {integrity: ${integrity}}`) === true, key);
    if (name === 'next') continue;
    check(snapshots.has(key), `${name} snapshot`);
    check(nextSnapshot?.includes(`      '${name}': ${NEXT_VERSION}\n`) === true, `${name} wiring`);
  }
  // Includes peer-qualified analytics importer/snapshot keys, not just standalone Next entries.
  for (const ref of lockfile.matchAll(
    /(?:\bnext@|@next\/[\w-]+@|(?:next|'@next\/[\w-]+'): )(\d[^\s'():]*)/g,
  )) {
    check(ref[1] === NEXT_VERSION, `stale reference: ${ref[0]}`);
  }
  const analytics = /'@vercel\/analytics':\n {8}specifier: [^\n]+\n {8}version: ([^\n]+)/.exec(
    lockfile,
  )?.[1];
  check(analytics?.includes(`(next@${importer?.[2]})`) === true, 'analytics peer importer');
  check(
    snapshots.get(`@vercel/analytics@${analytics}`)?.includes(`      next: ${importer?.[2]}\n`) ===
      true,
    'analytics peer snapshot',
  );
  return violations;
}

describe('designer Next pin and complete lock closure', () => {
  const manifest = () => read(MANIFEST);
  const lock = () => read(LOCKFILE);

  it('pins the supplied verified target with registry integrities and matching peers', () => {
    expect(nextViolations(manifest(), lock())).toEqual([]);
  });

  it.each(['16.3.0', '16.3.3', '16.3.6'])('rejects %s, even in a consistent old lock', (old) => {
    expect(
      nextViolations(
        manifest().replaceAll(NEXT_VERSION, old),
        lock().replaceAll(NEXT_VERSION, old),
      ),
    ).not.toEqual([]);
  });

  it.each(['^16.3.8', '~16.3.8', '16.3.3'])('rejects manifest-only drift to %s', (pin) => {
    expect(nextViolations(manifest().replace(NEXT_VERSION, pin), lock())).toContain('manifest pin');
  });

  it('rejects every individually stale version reference', () => {
    const fixed = lock();
    const refs = [...fixed.matchAll(/16\.3\.8/g)];
    expect(refs.length).toBeGreaterThan(30);
    for (const ref of refs) {
      const mixed = `${fixed.slice(0, ref.index)}16.3.3${fixed.slice(ref.index + NEXT_VERSION.length)}`;
      expect(nextViolations(manifest(), mixed), mixed).not.toEqual([]);
    }
  });

  it('rejects missing package/snapshot entries, wiring and corrupt integrity for every companion', () => {
    const fixed = lock();
    for (const [name, integrity] of Object.entries(NEXT_INTEGRITIES)) {
      expect(
        nextViolations(manifest(), fixed.replace(integrity, `${integrity.slice(0, -3)}x==`)),
      ).not.toEqual([]);
      const lines = fixed.split('\n');
      const indexes = lines.flatMap((line, index) =>
        line.startsWith(`  ${name}@${NEXT_VERSION}`) ||
        line.startsWith(`  '${name}@${NEXT_VERSION}`) ||
        line === `      '${name}': ${NEXT_VERSION}`
          ? [index]
          : [],
      );
      expect(indexes.length).toBeGreaterThanOrEqual(2);
      for (const index of indexes) {
        expect(
          nextViolations(manifest(), lines.filter((_, i) => i !== index).join('\n')),
        ).not.toEqual([]);
      }
    }
    expect(nextViolations(manifest(), '')).not.toEqual([]);
  });
});

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

const SOURCE_MAP_VERSION = '1.2.2';
// Registry dist.integrity: https://registry.npmjs.org/source-map-js/1.2.2
const SOURCE_MAP_INTEGRITY =
  'sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==';

function bunSourceMapViolations(lockfile: string): string[] {
  // Only resolution tuples, not consumers' compatible dependency ranges. Include nested copies.
  const entries = [...lockfile.matchAll(/^\s*"(?:[^"\n]+\/)?source-map-js": \[(.+)\],?\s*$/gm)];
  if (entries.length === 0) return ['missing Bun source-map-js resolution'];
  return entries.flatMap((entry) => {
    const tuple = JSON.parse(`[${entry[1]}]`) as unknown[];
    const violations: string[] = [];
    if (tuple[0] !== `source-map-js@${SOURCE_MAP_VERSION}`) {
      violations.push('Bun source-map-js version mismatch');
    }
    if (tuple[3] !== SOURCE_MAP_INTEGRITY) {
      violations.push('Bun source-map-js integrity mismatch');
    }
    return violations;
  });
}

function pnpmSourceMapViolations(lockfile: string): string[] {
  const violations: string[] = [];
  const counts = { packages: 0, snapshots: 0, dependency: 0 };
  let block = '';
  let inPackage = false;
  let integrityFound = false;
  const finishPackage = () => {
    if (inPackage && !integrityFound) violations.push('missing source-map-js integrity');
    inPackage = false;
    integrityFound = false;
  };
  for (const line of lockfile.split('\n')) {
    const header = TOP_LEVEL_BLOCK.exec(line)?.[1];
    if (header || /^ {2}\S/.test(line)) finishPackage();
    if (header) block = header;
    const key = /^ {2}source-map-js@([^:]+):/.exec(line)?.[1];
    if (key && (block === 'packages' || block === 'snapshots')) {
      counts[block] += 1;
      if (key !== SOURCE_MAP_VERSION) violations.push(`${block}: source-map-js version mismatch`);
      inPackage = block === 'packages';
    }
    const integrity = inPackage ? INTEGRITY_LINE.exec(line)?.[1] : undefined;
    if (integrity) {
      integrityFound = true;
      if (integrity !== SOURCE_MAP_INTEGRITY) violations.push('source-map-js integrity mismatch');
    }
    const dep = /^\s+source-map-js: (\S+)\s*$/.exec(line)?.[1];
    if (dep && block === 'snapshots') {
      counts.dependency += 1;
      if (dep !== SOURCE_MAP_VERSION) violations.push('dependency: source-map-js version mismatch');
    }
  }
  finishPackage();
  for (const section of ['packages', 'snapshots', 'dependency'] as const) {
    if (counts[section] === 0) violations.push(`missing source-map-js ${section}`);
  }
  return violations;
}

describe('source-map-js resolutions pin the version and registry integrity', () => {
  const bun = `    "source-map-js": ["source-map-js@${SOURCE_MAP_VERSION}", "", {}, "${SOURCE_MAP_INTEGRITY}"],`;
  const pnpm = [
    'packages:',
    `  source-map-js@${SOURCE_MAP_VERSION}:`,
    `    resolution: {integrity: ${SOURCE_MAP_INTEGRITY}}`,
    'snapshots:',
    `  source-map-js@${SOURCE_MAP_VERSION}: {}`,
    '  consumer@1.0.0:',
    '    dependencies:',
    `      source-map-js: ${SOURCE_MAP_VERSION}`,
    '  other@1.0.0:',
    '    dependencies:',
    `      source-map-js: ${SOURCE_MAP_VERSION}`,
  ].join('\n');

  it('guards both shipped lockfiles', () => {
    expect(bunSourceMapViolations(read('bun.lock'))).toEqual([]);
    expect(pnpmSourceMapViolations(read(LOCKFILE))).toEqual([]);
  });

  it('accepts fixed fixtures and ignores Bun dependency ranges', () => {
    const consumer =
      '    "consumer": ["consumer@1.0.0", "", { "dependencies": { "source-map-js": "^1.2.1" } }, "sha512-other"],';
    expect(bunSourceMapViolations(`${consumer}\n${bun}`)).toEqual([]);
    expect(pnpmSourceMapViolations(pnpm)).toEqual([]);
    expect(bunSourceMapViolations(consumer)).toEqual(['missing Bun source-map-js resolution']);
  });

  it('rejects old resolutions, including nested Bun copies', () => {
    expect(bunSourceMapViolations(bun.replace('1.2.2', '1.2.1'))).toEqual([
      'Bun source-map-js version mismatch',
    ]);
    const nested = bun
      .replace('"source-map-js":', '"consumer/source-map-js":')
      .replace('1.2.2', '1.2.1');
    expect(bunSourceMapViolations(`${bun}\n${nested}`)).toHaveLength(1);
    expect(
      pnpmSourceMapViolations(pnpm.replaceAll('source-map-js@1.2.2', 'source-map-js@1.2.1')),
    ).toEqual([
      'packages: source-map-js version mismatch',
      'snapshots: source-map-js version mismatch',
    ]);
  });

  it('rejects a single stale dependency reference', () => {
    expect(
      pnpmSourceMapViolations(pnpm.replace('source-map-js: 1.2.2', 'source-map-js: 1.2.1')),
    ).toEqual(['dependency: source-map-js version mismatch']);
  });

  it('rejects absent entries and missing integrity', () => {
    expect(bunSourceMapViolations('')).toHaveLength(1);
    expect(pnpmSourceMapViolations('')).toHaveLength(3);
    for (const line of [
      '  source-map-js@1.2.2:',
      '  source-map-js@1.2.2: {}',
      '      source-map-js: 1.2.2',
      `    resolution: {integrity: ${SOURCE_MAP_INTEGRITY}}`,
    ]) {
      const missing = pnpm
        .split('\n')
        .filter((raw) => raw !== line)
        .join('\n');
      expect(pnpmSourceMapViolations(missing)).not.toEqual([]);
    }
    expect(bunSourceMapViolations(bun.replace(SOURCE_MAP_INTEGRITY, ''))).toEqual([
      'Bun source-map-js integrity mismatch',
    ]);
  });

  it('rejects one-character integrity corruption in each lock format', () => {
    expect(bunSourceMapViolations(bun.replace('sha512-KGj', 'sha512-XGj'))).toEqual([
      'Bun source-map-js integrity mismatch',
    ]);
    expect(pnpmSourceMapViolations(pnpm.replace('sha512-KGj', 'sha512-XGj'))).toEqual([
      'source-map-js integrity mismatch',
    ]);
  });
});
