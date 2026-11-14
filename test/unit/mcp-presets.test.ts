import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_BACKEND_PRESETS } from '@/mcp/presets';

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../', rel), 'utf8');

// The public product homepage — the one developerz.ai address the handoff docs link to. A
// backend's own MCP endpoint is account-specific and is added by URL in the MCP panel (#256).
const DEVELOPERZ_HOMEPAGE = 'https://developerz.ai';

function developerzLinks(source: string): string[] {
  return [...source.matchAll(/\[developerz\.ai(?: MCP endpoint)?\]\(([^)]+)\)/g)].flatMap(
    (match) => (match[1] === undefined ? [] : [match[1]]),
  );
}

describe('built-in MCP presets', () => {
  it('ship no built-in backend URL', () => {
    // A preset puts its URL in every published build. The list is empty until a backend with a
    // public address is chosen; the public-tree guard polices the hosts if one is added back.
    expect(MCP_BACKEND_PRESETS).toEqual([]);
  });

  it.each(['README.md', 'docs/idea/mcp.md', 'docs/idea/README.md'])(
    '%s links its developerz.ai handoff reference to the public homepage',
    (path) => {
      const links = developerzLinks(read(path));
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) expect(link).toBe(DEVELOPERZ_HOMEPAGE);
    },
  );

  it('keeps the panel quick-add control bound to the shared presets, hidden while empty', () => {
    const panel = read('src/entrypoints/sidepanel/components/McpPanel.tsx');
    expect(panel).toContain('MCP_BACKEND_PRESETS');
    expect(panel).toContain('MCP_BACKEND_PRESETS.length > 0');
  });
});

describe('developerz.ai handoff documentation guard', () => {
  it('detects a link to an endpoint rather than the homepage', () => {
    const endpoint = `[developerz.ai MCP endpoint](${'https://developerz.ai'}/mcp)`;
    expect(developerzLinks(endpoint)).not.toEqual([DEVELOPERZ_HOMEPAGE]);
  });

  it('detects a fixture with no handoff link', () => {
    expect(developerzLinks('No endpoint is documented.')).toEqual([]);
  });
});
