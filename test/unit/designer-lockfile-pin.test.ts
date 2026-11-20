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

const MIN_ZOD = '4.6.6';
// Registry dist.integrity: https://registry.npmjs.org/zod/4.6.6
const ZOD_INTEGRITY =
  'sha512-4UmzQUF5fxvfcYHlbjBmejU+w+hbDnWFx4aS8kBx7nPBHcO2SqPbpAG8snbdg+Xse4pRefR98hgjFgIMCI/UhA==';

/** Only resolved entries, not peer ranges or zod-to-json-schema's own version. */
function zodFloorViolations(lockfile: string): string[] {
  const refs: { section: Section | 'peer'; version: string }[] = [];
  const violations: string[] = [];
  let block = '';
  let packageVersion: string | undefined;
  let integrity: string | undefined;
  const finishPackage = () => {
    if (!packageVersion) return;
    if (!integrity || (packageVersion === MIN_ZOD && integrity !== ZOD_INTEGRITY)) {
      violations.push(`incorrect integrity for zod@${packageVersion}`);
    }
    packageVersion = undefined;
    integrity = undefined;
  };
  for (const line of lockfile.split('\n')) {
    const header = TOP_LEVEL_BLOCK.exec(line)?.[1];
    if (header || /^ {2}\S/.test(line)) finishPackage();
    if (header) block = header;
    if (block !== 'packages' && block !== 'snapshots') continue;
    const key = /^ {2}['"]?zod@([^:('\s]+)(?=[:('"])/.exec(line)?.[1];
    if (key) {
      refs.push({ section: block, version: key });
      if (block === 'packages') packageVersion = key;
    }
    if (packageVersion) integrity = INTEGRITY_LINE.exec(line)?.[1] ?? integrity;
    if (block !== 'snapshots') continue;
    const dep = /^ {6}zod: ['"]?([^\s('"]+)/.exec(line)?.[1];
    if (dep) refs.push({ section: 'dependency', version: dep });
    for (const match of line.matchAll(/\(zod@([^()]+)\)/g)) {
      refs.push({ section: 'peer', version: match[1] ?? '' });
    }
  }
  finishPackage();
  for (const ref of refs) {
    if (!/^\d+\.\d+\.\d+$/.test(ref.version) || !isAtLeast(ref.version, MIN_ZOD)) {
      violations.push(`${ref.section}: zod ${ref.version} < ${MIN_ZOD}`);
    }
  }
  for (const section of ['packages', 'snapshots', 'dependency', 'peer'] as const) {
    if (!refs.some((ref) => ref.section === section)) violations.push(`no zod ${section} entry`);
  }
  return violations;
}

describe('designer zod resolution floor', () => {
  it('holds every resolved reference and the registry integrity', () => {
    expect(zodFloorViolations(read(LOCKFILE))).toEqual([]);
  });

  it('holds the override in both manifest and lockfile', () => {
    const manifest = JSON.parse(read('docs/design/designer/package.json'));
    expect(manifest.pnpm.overrides.zod).toBe(MIN_ZOD);
    const overrides = read(LOCKFILE).split('overrides:\n')[1]?.split('\n\n')[0];
    expect(overrides).toContain(`  zod: ${MIN_ZOD}`);
  });

  const fixed = [
    'packages:',
    `  zod@${MIN_ZOD}:`,
    `    resolution: {integrity: ${ZOD_INTEGRITY}}`,
    '  zod-to-json-schema@3.25.2:',
    '    peerDependencies:',
    '      zod: ^3.25.28 || ^4',
    'snapshots:',
    `  zod@${MIN_ZOD}: {}`,
    `  sdk@1.0.0(zod@${MIN_ZOD}):`,
    '    dependencies:',
    `      zod: ${MIN_ZOD}`,
    `      zod-to-json-schema: 3.25.2(zod@${MIN_ZOD})`,
  ].join('\n');

  it('accepts resolved versions without confusing peer ranges or similarly named packages', () => {
    expect(zodFloorViolations(fixed)).toEqual([]);
    expect(zodFloorViolations(fixed.replaceAll(MIN_ZOD, '4.10.0'))).toEqual([]);
  });

  it.each([
    [`  zod@${MIN_ZOD}:\n`, 'packages'],
    [`  zod@${MIN_ZOD}: {}`, 'snapshots'],
    [`      zod: ${MIN_ZOD}`, 'dependency'],
    [`  sdk@1.0.0(zod@${MIN_ZOD}):`, 'peer'],
    [`      zod-to-json-schema: 3.25.2(zod@${MIN_ZOD})`, 'peer'],
  ])('rejects an independently stale reference: %s', (line, section) => {
    const stale = fixed.replace(line, line.replace(MIN_ZOD, '3.25.76'));
    expect(stale).not.toBe(fixed);
    expect(zodFloorViolations(stale)).toContain(`${section}: zod 3.25.76 < ${MIN_ZOD}`);
  });

  it.each(['packages', 'snapshots', 'dependency', 'peer'])(
    'rejects missing %s entries',
    (section) => {
      const without = fixed
        .split('\n')
        .filter((line) => {
          if (section === 'packages') return line !== `  zod@${MIN_ZOD}:`;
          if (section === 'snapshots') return line !== `  zod@${MIN_ZOD}: {}`;
          if (section === 'dependency') return line !== `      zod: ${MIN_ZOD}`;
          return !line.includes('(zod@');
        })
        .join('\n');
      expect(zodFloorViolations(without)).toContain(`no zod ${section} entry`);
    },
  );

  it('rejects absent matches, prereleases and missing or mistyped integrity', () => {
    expect(zodFloorViolations('packages:\nsnapshots:\n')).toHaveLength(4);
    expect(zodFloorViolations(fixed.replaceAll(MIN_ZOD, '4.6.6-beta.1'))).not.toEqual([]);
    for (const hash of ['', ZOD_INTEGRITY.replace('4Umz', '4Umx')]) {
      expect(zodFloorViolations(fixed.replace(ZOD_INTEGRITY, hash))).toContain(
        `incorrect integrity for zod@${MIN_ZOD}`,
      );
    }
  });
});
