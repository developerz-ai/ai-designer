import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A GUARD, not a behavioural test — "make the machine careful" (00-philosophy.md §5): a rule in a
// comment is advice the next agent can miss, a failing test is a fact it cannot.
//
// WHAT IT PROTECTS: the image encoder Next uses for next/image in docs/design/designer. That
// sandbox is NOT part of this repo's gate — biome.json excludes it, tsconfig.json does not include
// it, and no workflow installs it; the only thing that touches it is the Dependabot npm entry for
// that directory. So `bun run verify` cannot see a regression here, and a lockfile-only edit has
// nothing holding it: next declares its encoder as an OPTIONAL dependency on a caret range, so the
// next install (or the Dependabot run) re-resolves to whatever the registry calls latest. The
// pinned `pnpm.overrides` entry in the manifest is what holds the fixed version — this test is the
// machine that notices if either the override or the lock drifts off it.
//
// SOURCE guard on purpose: the defect is a text edit in a lockfile no TypeScript ever loads. Shape
// follows test/unit/waitlist-image-pin.test.ts: read the file as text, extract the part that
// matters, assert a fact about it — then prove the matcher can still fail.

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../', rel), 'utf8');

const DESIGNER = 'docs/design/designer';
const LOCKFILE = `${DESIGNER}/pnpm-lock.yaml`;
const MANIFEST = `${DESIGNER}/package.json`;

/** The fixed encoder version. The next one up is `latest` and is deliberately not taken. */
const SHARP_VERSION = '0.35.4';
/** The native-lib archive set the fixed encoder itself pins. Never chosen independently of it. */
const LIBVIPS_VERSION = '1.3.3';

/** A package reference of the encoder family, wherever it sits in the lock. */
type EncoderRef = { name: string; version: string };

/**
 * The two shapes a reference takes in a pnpm lock: a packages/snapshots KEY (`sharp@0.35.4:`,
 * `'@img/sharp-linux-x64@0.35.4':`, `sharp@0.35.4(@types/node@24.10.4):`) and a dependency MAP
 * entry (`'@img/sharp-linux-x64': 0.35.4` in a snapshot, `sharp: 0.35.4(@types/node@24.10.4)` in
 * next's). Both are read, so a version can hide in neither.
 */
const KEYED_REF = /((?:@img\/)?sharp[a-z0-9-]*)@(\d+\.\d+\.\d+)/g;
const MAP_REF = /'?((?:@img\/)?sharp[a-z0-9-]*)'?:\s*(\d+\.\d+\.\d+)/g;

/**
 * Every encoder reference in a lockfile, in file order. Throws on an empty result rather than
 * returning [] — a matcher that finds NOTHING must not read as "nothing wrong", or the guard would
 * pass forever on a rewritten, renamed or truncated file.
 */
function encoderRefs(source: string): EncoderRef[] {
  const refs: EncoderRef[] = [];
  for (const pattern of [KEYED_REF, MAP_REF]) {
    for (const [, name, version] of source.matchAll(pattern)) {
      if (name && version) refs.push({ name, version });
    }
  }
  if (refs.length === 0) throw new Error(`no sharp or @img/sharp-* reference in ${LOCKFILE}`);
  return refs;
}

/** The version this package name must carry: native-lib archives ride libvips, the rest ride sharp. */
const expectedVersion = (name: string): string =>
  name.includes('libvips') ? LIBVIPS_VERSION : SHARP_VERSION;

/**
 * Every reason a lockfile is not on the fixed encoder. Empty = every sharp and @img/sharp-*
 * reference names the expected version. The entries say WHICH package drifted and to where, so a
 * failure reads as a defect, not as "not empty".
 */
function versionViolations(source: string): string[] {
  const violations: string[] = [];
  for (const { name, version } of encoderRefs(source)) {
    const expected = expectedVersion(name);
    if (version !== expected) violations.push(`${name}@${version} is not ${name}@${expected}`);
  }
  return violations;
}

/**
 * Every reason the lock no longer wires the fixed encoder into the graph. Version agreement alone
 * is not enough: a lock that agrees with itself while having dropped the encoder — or the edge
 * from next to it — installs nothing that next/image can use.
 */
function wiringViolations(source: string): string[] {
  const violations: string[] = [];
  if (!new RegExp(`^ {2}sharp@${SHARP_VERSION}:$`, 'm').test(source)) {
    violations.push(`the packages section has no sharp@${SHARP_VERSION} entry`);
  }
  if (!new RegExp(`^ {2}sharp@${SHARP_VERSION}\\(@types\\/node@[\\d.]+\\):$`, 'm').test(source)) {
    violations.push(`the snapshots section has no sharp@${SHARP_VERSION} snapshot`);
  }
  if (!new RegExp(`^\\s+sharp: ${SHARP_VERSION}\\(`, 'm').test(source)) {
    violations.push(`next's optional dependency does not resolve to sharp@${SHARP_VERSION}`);
  }
  if (!new RegExp(`^ {2}sharp: ${SHARP_VERSION}$`, 'm').test(source)) {
    violations.push(`the lock's overrides map does not pin sharp to ${SHARP_VERSION}`);
  }
  return violations;
}

/** The manifest's pinned override, or '' when it is missing — the drift this guard exists for. */
function overridePin(manifest: string): string {
  const parsed = JSON.parse(manifest) as { pnpm?: { overrides?: Record<string, string> } };
  return parsed.pnpm?.overrides?.sharp ?? '';
}

describe('the designer stays on the fixed image encoder', () => {
  it('pins sharp in the manifest, so no install re-resolves it away', () => {
    // next's optional dependency is a caret range; without this entry the next install — or the
    // Dependabot run that watches this directory — picks the registry's latest instead.
    expect(overridePin(read(MANIFEST))).toBe(SHARP_VERSION);
  });

  it('resolves no encoder version but the pinned one', () => {
    expect(versionViolations(read(LOCKFILE))).toEqual([]);
  });

  it('keeps every native-lib archive on the version the pinned encoder itself asks for', () => {
    const libvips = encoderRefs(read(LOCKFILE)).filter(({ name }) => name.includes('libvips'));
    // A lock with no libvips reference at all would satisfy "no violations" — assert the set exists.
    expect(libvips.length).toBeGreaterThan(0);
    expect([...new Set(libvips.map(({ version }) => version))]).toEqual([LIBVIPS_VERSION]);
  });

  it('still wires the pinned encoder into next', () => {
    expect(wiringViolations(read(LOCKFILE))).toEqual([]);
  });
});

describe('the guard itself detects what it claims to', () => {
  // A guard that cannot fail is worse than no guard: it reads as protection and provides none.
  const lockfile = read(LOCKFILE);

  it('flags the lock reverted to the pre-fix encoder', () => {
    const reverted = lockfile
      .replaceAll(SHARP_VERSION, '0.35.3')
      .replaceAll(LIBVIPS_VERSION, '1.3.2');
    const violations = versionViolations(reverted);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join('\n')).toContain('sharp@0.35.3 is not sharp@0.35.4');
    expect(violations.join('\n')).toContain('1.3.2 is not');
  });

  it('flags a lock where only the archives drifted, encoder untouched', () => {
    // The half-migration: the headline version moved, the pinned native set did not.
    const violations = versionViolations(lockfile.replaceAll(LIBVIPS_VERSION, '1.3.2'));
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join('\n')).not.toContain('sharp@0.35.4 is not');
  });

  it('flags a self-consistent lock that lost the edge from next to the encoder', () => {
    const severed = lockfile.replace(new RegExp(`^\\s+sharp: ${SHARP_VERSION}\\(`, 'gm'), '');
    const violations = wiringViolations(severed);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("next's optional dependency");
  });

  it('flags a lock whose overrides map lost the pin', () => {
    const violations = wiringViolations(
      lockfile.replace(new RegExp(`^ {2}sharp: ${SHARP_VERSION}$`, 'm'), ''),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('overrides map');
  });

  it('reads both the keyed and the mapped spelling of a reference', () => {
    const refs = encoderRefs(
      ['  sharp@0.35.4(@types/node@24.10.4):', "      '@img/sharp-wasm32': 0.35.4"].join('\n'),
    );
    expect(refs).toEqual([
      { name: 'sharp', version: '0.35.4' },
      { name: '@img/sharp-wasm32', version: '0.35.4' },
    ]);
  });

  it('throws instead of passing when there is no reference to read', () => {
    expect(() => encoderRefs("lockfileVersion: '9.0'\n")).toThrow(/no sharp or @img\/sharp-\*/);
  });

  it('reads a missing override as a missing pin, not as a passing one', () => {
    expect(overridePin('{ "pnpm": { "overrides": { "hono": "4.12.25" } } }')).toBe('');
  });
});
