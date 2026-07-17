import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve directly from `import.meta.url` (a `file:` URL) rather than
// `new URL('.', import.meta.url)` — under Vitest's jsdom env the relative-URL
// constructor rewrites the `file:` base to `http://localhost:3000/...`, so
// fileURLToPath would throw "The URL must be of scheme file".
const __dirname = dirname(fileURLToPath(import.meta.url));

// Reads the live wxt.config.ts as text (no `wxt` import → no esbuild) and extracts
// the manifest permission/host arrays. The manifest arrays are static string
// literals in wxt.config.ts, so a regex extract is exact and drift-sensitive:
// any change to the granted surface still flows through this parser.
function readManifestArrays(): {
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
} {
  const configPath = resolve(__dirname, '../../wxt.config.ts');
  const src = readFileSync(configPath, 'utf8');
  const extract = (key: string): string[] => {
    const match = src.match(new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`, 'm'));
    if (!match?.[1]) return [];
    return match[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => s.replace(/^['"]/, '').replace(/['"]$/, ''));
  };
  return {
    permissions: extract('permissions'),
    host_permissions: extract('host_permissions'),
    optional_host_permissions: extract('optional_host_permissions'),
  };
}

// Guards the least-privilege manifest invariant documented in
// docs/architecture/security.md. Parses the live wxt.config.ts manifest as text
// (no `wxt` import — importing wxt pulls in esbuild, which crashes under
// Vitest's jsdom env) so any drift in the granted surface fails this test.
const manifest = readManifestArrays();

describe('manifest least-privilege invariants', () => {
  it('retains exactly the approved permission set', () => {
    const expected = [
      'activeTab',
      'debugger',
      'identity',
      'sidePanel',
      'storage',
      'tabs',
      'webNavigation',
    ];
    expect([...(manifest.permissions ?? [])].sort()).toStrictEqual([...expected].sort());
  });

  it('does not request scripting (removed as unused)', () => {
    expect(manifest.permissions).not.toContain('scripting');
  });

  it('keeps activeTab as the static host-access grant', () => {
    expect(manifest.permissions).toContain('activeTab');
  });

  it('declares <all_urls> only as opt-in optional_host_permissions, never static', () => {
    expect(manifest.optional_host_permissions?.includes('<all_urls>')).toBe(true);
    expect(manifest.host_permissions?.includes('<all_urls>')).toBe(false);
    expect(manifest.permissions?.includes('<all_urls>')).toBe(false);
  });

  it('has no static broad/grant-all host permission other than the two named endpoints', () => {
    const expected = ['https://glitchtip.infra.developerz.ai/*', 'https://openrouter.ai/*'];
    expect([...(manifest.host_permissions ?? [])].sort()).toStrictEqual([...expected].sort());
  });
});
