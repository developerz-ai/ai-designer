import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SANDBOX_ROOT = join(import.meta.dirname, '..', '..', 'docs', 'design', 'designer');
const pkgRaw = readFileSync(join(SANDBOX_ROOT, 'package.json'), 'utf-8');
const pkg = JSON.parse(pkgRaw);

// the script must name a prebuilt @biomejs/biome binary under the sandbox
// node_modules, reachable by relative path — a bare `biome` resolves to
// nothing in the gate's clean-checkout invocation
const LINT = pkg.scripts.lint as string;
const BIN_RE = /node node_modules\/(@biomejs\/biome\/bin\/biome)/;

describe('sandbox lint contract (docs/design/designer)', () => {
  it('pins scripts.lint to the prebuilt @biomejs/biome binary under sandbox node_modules', () => {
    const binMatch = BIN_RE.exec(LINT);
    expect(binMatch?.[1]).toBeTruthy();
    const binPath = join(SANDBOX_ROOT, 'node_modules', ...(binMatch?.[1]?.split('/') ?? []));
    if (!existsSync(binPath)) {
      // sandbox node_modules is never committed; CI installs only root deps —
      // self-heal the missing install so a clean runner fails the real contract,
      // not a missing-install fault (the shape of PR #232's ci_wait_timeout)
      execSync(`bun install --cwd ${SANDBOX_ROOT}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    expect(existsSync(binPath)).toBe(true);
    expect(pkgRaw.includes('eslint')).toBe(false);
    expect(pkgRaw.includes('lint-doctor')).toBe(false);
  });

  it('pins @biomejs/biome as a devDependency and ships the biome config', () => {
    expect(String(pkg.devDependencies?.['@biomejs/biome'])).toMatch(/^\^?2\./);
    expect(existsSync(join(SANDBOX_ROOT, 'biome.json'))).toBe(true);
    const cfg = JSON.parse(readFileSync(join(SANDBOX_ROOT, 'biome.json'), 'utf-8'));
    expect(cfg.css?.parser?.tailwindDirectives).toBe(true);
    expect(JSON.stringify(cfg).includes('eslint')).toBe(false);
    // no vcs.files ignore entry aimed at source files
    const includes = cfg.files?.includes ?? [];
    for (const entry of includes) {
      expect(entry).not.toMatch(/\.(ts|tsx|css)['"]?$/);
    }
  });

  it('marks the sandbox tree as its Biome root and hides no rules', () => {
    const cfg = JSON.parse(readFileSync(join(SANDBOX_ROOT, 'biome.json'), 'utf-8'));
    expect(cfg.root).toBe(true);
    expect(cfg.overrides).toBeUndefined();
  });

  it('runs the sandbox lint script and gets real lint violations, not a broken command', () => {
    let out = '';
    try {
      execSync(pkg.scripts.lint as string, {
        cwd: SANDBOX_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err: unknown) {
      out = `${(err as { stdout?: string }).stdout ?? ''}${(err as { stderr?: string }).stderr ?? ''}`;
    }
    expect(out.length).toBeGreaterThan(0);
    // a real lint run, not a missing tool or missing config
    expect(out).not.toMatch(/ENOENT|Cannot find module|not found|Failed to resolve/i);
    // pre-existing violations surface as lint findings: app.tsx carries a11y errors,
    // button.tsx or globals.css complete the flagged file set (css parses clean →
    // the flagged trio's remaining findings come from the tsx/eslint-less toolchain)
    expect(out).toMatch(/app\.tsx/);
    expect(out).toMatch(/icon\.svg|placeholder/);
    expect(out).toMatch(/Some errors were emitted/);
  });
});
