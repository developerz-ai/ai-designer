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
      'scripting',
      'sidePanel',
      'storage',
      'tabs',
      'webNavigation',
    ];
    expect([...(manifest.permissions ?? [])].sort()).toStrictEqual([...expected].sort());
  });

  it('requests scripting ONLY to re-inject the manifest’s own content scripts', () => {
    // Re-added deliberately after being dropped as unused. A tab that was already open when the
    // extension is installed/updated/reloaded has no content script until it reloads, so every
    // DOM tool fails with "Receiving end does not exist"; background.ts's `reinjectAllTabs`
    // repairs that on `onInstalled`. The guard is that it stays limited to that: injecting
    // FILES the manifest already declares, never a string of code (no remote code — CLAUDE.md).
    expect(manifest.permissions).toContain('scripting');
    const background = readFileSync(
      resolve(__dirname, '../../src/entrypoints/background.ts'),
      'utf8',
    );
    expect(background).toContain('reinjectAllTabs');
    // `func:`/`args:` would mean injecting code we composed at runtime rather than shipped files.
    const injectCall = background.slice(background.indexOf('chrome.scripting'));
    expect(injectCall.slice(0, 600)).not.toMatch(/\bfunc\s*:/);
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

// ---------------------------------------------------------------------------
// Docs guard — the permissions tables must state the real `scripting` boundary.
//
// The manifest grants `scripting` for one thing only: the service worker
// re-injects the extension's OWN shipped content scripts into tabs it can
// already access (background.ts `reinjectAllTabs`). A doc row that calls the
// permission "unused", or that describes it as "inject the content script"
// without naming the actor, states something false about the granted surface —
// the drift this guard exists to stop. Parsed as markdown text, same shape as
// the wxt.config.ts parser above (no doc tooling, no build step).
// ---------------------------------------------------------------------------

type TableRow = { cells: string[]; line: number };

const DOCS = {
  wiki: 'docs/wiki/privacy-keys.md',
  architecture: 'docs/architecture/privacy.md',
} as const;

/** Rows of the markdown table in the first "…permissions…" section of a doc. */
function permissionsTableRows(docPath: string): TableRow[] {
  const src = readFileSync(resolve(__dirname, '../../', docPath), 'utf8');
  const lines = src.split('\n');
  const heading = lines.findIndex((line) => /^#{1,6}\s.*permissions/i.test(line));
  if (heading === -1) return [];
  const rows: TableRow[] = [];
  for (const [offset, raw] of lines.slice(heading + 1).entries()) {
    if (/^#{1,6}\s/.test(raw)) break; // next heading — the table ends here
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // |---|---|
    rows.push({ cells, line: heading + 2 + offset });
  }
  return rows;
}

/** "Side panel" / "`sidePanel`" → "sidepanel": the manifest id, case- and punctuation-free. */
function permissionKey(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The permissions-table row naming a manifest permission, if the doc has one. */
function rowForPermission(docPath: string, permission: string): TableRow | undefined {
  return permissionsTableRows(docPath).find(
    (row) => permissionKey(row.cells[0] ?? '') === permissionKey(permission),
  );
}

// Require a prohibition, not merely a mention (e.g. "Allows remote code").
const remoteCodeProhibition = /\b(?:no remote code|never fetching or running remote code)\b/i;

describe('documentation states the granted surface honestly', () => {
  for (const docPath of Object.values(DOCS)) {
    it(`${docPath} documents scripting as service-worker-only reinjection`, () => {
      const row = rowForPermission(docPath, 'scripting');
      expect(row, `${docPath} has no permissions-table row for "scripting"`).toBeDefined();
      const text = (row?.cells ?? []).join(' ');
      expect(text).toMatch(/re-?inject/i); // the actual use
      expect(text).toMatch(/service[\s-]?worker/i); // who does it — only the SW holds the permission
      expect(text).toMatch(/shipped|bundled/i); // the extension's OWN shipped files, never code composed at runtime
      expect(text).toMatch(remoteCodeProhibition); // and it never fetches or runs any
      expect(text).not.toMatch(/unused|not used/i); // it IS used — the stale claim
    });

    it.each(['Allows remote code', 'Fetches and runs remote code', 'Remote code'])(
      `${docPath} rejects "%s" instead of a remote-code prohibition`,
      (replacement) => {
        const row = rowForPermission(docPath, 'scripting');
        const text = (row?.cells ?? []).join(' ');
        const mutated = text.replace(
          /no remote code|never fetching or running remote code/i,
          replacement,
        );
        expect(mutated).not.toBe(text);
        expect(mutated).not.toMatch(remoteCodeProhibition);
      },
    );
  }

  it('both docs list every permission the manifest grants', () => {
    for (const docPath of Object.values(DOCS)) {
      for (const permission of manifest.permissions ?? []) {
        expect(
          rowForPermission(docPath, permission),
          `${docPath} has no permissions-table row for "${permission}"`,
        ).toBeDefined();
      }
    }
  });
});
