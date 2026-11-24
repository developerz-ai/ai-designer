import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A GUARD, not a behavioural test — "make the machine careful" (00-philosophy.md §5): a rule in a
// comment is advice the next agent can miss, a failing test is a fact it cannot.
//
// WHAT IT PROTECTS: the waitlist image's base. `FROM oven/bun:1` re-resolves every time that
// major tag is repushed, so two builds of one commit can run different Bun runtimes; and the
// header claimed the base was digest-pinned "at deploy time" by a rule no workflow implements.
// waitlist-deploy.yml builds this file exactly as written and pushes the APP image; the ArgoCD
// Image Updater repin it names (infra#870) moves that published image in-cluster, never the base.
// PR #226 corrected the pin and left the false comment standing — this guard covers both.
//
// SOURCE guard on purpose: both defects are a one-line edit in waitlist/Dockerfile, which is where
// the next agent is looking. Shape follows test/unit/app-header.test.ts: read the file as text,
// extract the part that matters, assert a fact about it — then prove the matcher can still fail.

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../', rel), 'utf8');

const DOCKERFILE = 'waitlist/Dockerfile';
const WAITLIST_WORKFLOW = '.github/workflows/waitlist.yml';
const CI_WORKFLOW = '.github/workflows/ci.yml';

/** This build's base image, and the Bun version every other source in the repo agrees on. */
const BUN_IMAGE = 'oven/bun';
const BUN_VERSION = /^\s*BUN_VERSION:\s*(\S+)\s*$/m.exec(read(WAITLIST_WORKFLOW))?.[1] ?? '';

/** An exact X.Y.Z version. `1`, `1.4` and `1.4.4-slim` all fail — none is a fixed image. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
/** A sha256 index digest: 64 hex chars. The short form docker prints is not a pin. */
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;

/**
 * Every image reference a build of this file would pull — one per FROM, in file order. Throws on
 * an empty result rather than returning [] — a matcher that finds NOTHING must not read as
 * "nothing wrong", or the guard would pass forever on a rewritten or renamed file.
 */
function fromImages(source: string): string[] {
  const images: string[] = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    // A comment that says FROM is not a FROM — the header of this very file documents its base.
    if (line === '' || line.startsWith('#') || !/^FROM\s/i.test(line)) continue;
    const image = line
      .split(/\s+/)
      .slice(1)
      .find((field) => !field.startsWith('--'));
    if (image) images.push(image);
  }
  if (images.length === 0) throw new Error(`no FROM instruction in ${DOCKERFILE}`);
  return images;
}

type ImageRef = { repository: string; tag: string | null; digest: string | null };

/** `repo[:tag][@digest]`; null when the reference cannot be read at all. */
function parseImageRef(ref: string): ImageRef | null {
  const parsed = /^([^:@\s]+)(?::([^:@\s]+))?(?:@([a-z0-9]+:[a-f0-9]+))?$/.exec(ref);
  const repository = parsed?.[1];
  if (!repository) return null;
  return { repository, tag: parsed?.[2] ?? null, digest: parsed?.[3] ?? null };
}

/**
 * Every reason a base image is not reproducibly pinned. Empty = every reference names `oven/bun`
 * at BUN_VERSION with a sha256 digest. The entries say WHICH pin broke and how, so a failure
 * reads as a defect, not as "not empty".
 */
function pinViolations(refs: readonly string[]): string[] {
  const violations: string[] = [];
  for (const ref of refs) {
    const parsed = parseImageRef(ref);
    if (!parsed) {
      violations.push(`${ref}: not a parseable image reference`);
      continue;
    }
    if (parsed.repository !== BUN_IMAGE) {
      violations.push(`${ref}: image ${parsed.repository} is not ${BUN_IMAGE}`);
    }
    if (parsed.digest === null) {
      violations.push(`${ref}: no @sha256 digest — a tag alone can be repushed to other bytes`);
    } else if (!SHA256_DIGEST.test(parsed.digest)) {
      violations.push(`${ref}: ${parsed.digest} is not a sha256:<64 hex> index digest`);
    }
    if (parsed.tag === null) {
      violations.push(`${ref}: no tag at all`);
    } else if (!EXACT_SEMVER.test(parsed.tag)) {
      violations.push(`${ref}: tag "${parsed.tag}" is not an exact X.Y.Z version`);
    } else if (parsed.tag !== BUN_VERSION) {
      violations.push(`${ref}: tag "${parsed.tag}" != BUN_VERSION ${BUN_VERSION}`);
    }
  }
  return violations;
}

/**
 * The invented deploy-time pinning rule, in either spelling (the old header hyphenated it; an
 * author rewording the claim need not). Built from parts, matcher and fixtures alike: the tree is
 * meant to carry no occurrence of this phrase, so the guard that forbids it must not be the one
 * place that keeps it alive.
 */
const DEAD_RULE_REGEX = new RegExp(['registry', 'standardiz'].join('[-\\s]?'), 'i');
const deadRulePhrase = (separator: string): string =>
  ['registry', 'standardization', 'rule'].join(separator);

/**
 * Every reason the Dockerfile header still tells the deploy-time-repin story. A comment is part of
 * the contract here: it is what the next agent reads instead of opening the workflow, and the
 * false version of it survived the pin fix once already.
 */
function headerViolations(source: string): string[] {
  const violations: string[] = [];
  if (DEAD_RULE_REGEX.test(source)) {
    violations.push('the header asserts a deploy-time pinning rule nothing implements');
  }
  if (/digest[- ]pinned/i.test(source)) {
    violations.push('the header claims this BASE image is digest-pinned, not just the pin');
  }
  if (!source.includes('waitlist-deploy.yml')) {
    violations.push('the header does not name waitlist-deploy.yml as what builds this file');
  }
  if (!/published app image/i.test(source)) {
    violations.push('the header does not scope the ArgoCD repin to the published app image');
  }
  if (!/infra#870/.test(source)) {
    violations.push('the header does not cite the ArgoCD Image Updater issue (infra#870)');
  }
  return violations;
}

describe('the waitlist base image is pinned to one reproducible image', () => {
  it('reads a BUN_VERSION to pin against', () => {
    expect(BUN_VERSION).toMatch(EXACT_SEMVER);
  });

  it('every FROM names oven/bun at BUN_VERSION with a sha256 digest', () => {
    expect(pinViolations(fromImages(read(DOCKERFILE)))).toEqual([]);
  });

  it('all three sources that name the toolchain agree, so the pin has one truth', () => {
    expect(/^\s*BUN_VERSION:\s*(\S+)\s*$/m.exec(read(CI_WORKFLOW))?.[1]).toBe(BUN_VERSION);
    expect(/"packageManager":\s*"bun@([^"]+)"/.exec(read('package.json'))?.[1]).toBe(BUN_VERSION);
  });
});

describe('the Dockerfile header states how the base image is actually pinned', () => {
  it('claims no deploy-time repin of the base and scopes the real one', () => {
    expect(headerViolations(read(DOCKERFILE))).toEqual([]);
  });
});

describe('the guard itself detects what it claims to', () => {
  // A guard that cannot fail is worse than no guard: it reads as protection and provides none.
  const DIGEST = 'a'.repeat(64);
  const pinned = `FROM ${BUN_IMAGE}:${BUN_VERSION}@sha256:${DIGEST}`;

  it('accepts the exact pin it ships', () => {
    expect(pinViolations(fromImages(pinned))).toEqual([]);
  });

  it('flags an identical tag+digest pin from a different repository', () => {
    // The supply-chain swap the repository check exists for: exact version, full 64-hex digest,
    // wrong owner. Delete that check and this reference reads as an accepted pin.
    const ref = `FROM attacker/bun:${BUN_VERSION}@sha256:${DIGEST}`;
    const violations = pinViolations(fromImages(ref));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`is not ${BUN_IMAGE}`);
  });

  it('flags a bare major tag — the tag this file used to carry', () => {
    const violations = pinViolations(fromImages(`FROM ${BUN_IMAGE}:1`));
    // Both detectors fire: `1` is not an exact version, and there is no digest behind it.
    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain('not an exact X.Y.Z');
    expect(violations.join('\n')).toContain('no @sha256 digest');
  });

  it('flags an exact version with no digest — still a floating tag', () => {
    const violations = pinViolations(fromImages(`FROM ${BUN_IMAGE}:${BUN_VERSION}`));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('no @sha256 digest');
  });

  it('flags a pinned digest at a version the rest of the repo does not run', () => {
    const violations = pinViolations(fromImages(`FROM ${BUN_IMAGE}:1.3.0@sha256:${DIGEST}`));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`!= BUN_VERSION ${BUN_VERSION}`);
  });

  it('flags a variant swap dressed as a pin (-slim)', () => {
    const ref = `FROM ${BUN_IMAGE}:${BUN_VERSION}-slim@sha256:${DIGEST}`;
    const violations = pinViolations(fromImages(ref));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('is not an exact X.Y.Z version');
  });

  it('flags a digest that is not a full 64 hex index digest', () => {
    const ref = `FROM ${BUN_IMAGE}:${BUN_VERSION}@sha256:${'a'.repeat(12)}`;
    const violations = pinViolations(fromImages(ref));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('is not a sha256:<64 hex> index digest');
  });

  it('reads FROM through comments, flags and multi-stage aliases', () => {
    const source = [
      '# FROM oven/bun:1 — a comment is not an instruction',
      `FROM --platform=linux/amd64 ${BUN_IMAGE}:${BUN_VERSION}@sha256:${DIGEST} AS build`,
    ].join('\n');
    expect(fromImages(source)).toEqual([`${BUN_IMAGE}:${BUN_VERSION}@sha256:${DIGEST}`]);
    expect(pinViolations(fromImages(source))).toEqual([]);
  });

  it('throws instead of passing when there is no FROM to read', () => {
    expect(() => fromImages('# FROM-less file\nRUN true')).toThrow(/no FROM instruction/);
  });

  it('flags the header this change replaced', () => {
    // The pre-fix story as it read, hyphen and all: it survived the pin fix once already.
    const old = [
      '# designer-waitlist — Bun + Hono double-opt-in service (:3000, non-root).',
      '# Bun runs the TS directly (no build step, no dist). Image base is digest-pinned',
      `# by the ${deadRulePhrase('-')} at deploy time; the tag here is the`,
      '# dev-local build target.',
    ].join('\n');
    const violations = headerViolations(old);
    // Both story detectors fire, and every claim the honest header has to make is missing.
    expect(violations).toHaveLength(5);
    expect(violations.join('\n')).toContain('deploy-time pinning rule');
    expect(violations.join('\n')).toContain('digest-pinned');
    expect(violations.join('\n')).toContain('waitlist-deploy.yml');
    expect(violations.join('\n')).toContain('published app image');
    expect(violations.join('\n')).toContain('infra#870');
  });

  it('flags the space-separated respelling of that rule too', () => {
    const respelled = `# base is pinned by the ${deadRulePhrase(' ')}`;
    expect(headerViolations(respelled).join('\n')).toContain('deploy-time pinning rule');
  });
});
