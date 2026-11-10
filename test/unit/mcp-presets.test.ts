import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVELOPERZ_MCP_ENDPOINT, MCP_BACKEND_PRESETS } from '@/mcp/presets';

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../', rel), 'utf8');

function developerzMcpLinks(source: string): string[] {
  return [...source.matchAll(/\[developerz\.ai MCP endpoint\]\(([^)]+)\)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('developerz.ai MCP preset', () => {
  it('uses the canonical Streamable HTTP endpoint', () => {
    expect(DEVELOPERZ_MCP_ENDPOINT).toBe('https://mcp.developerz.ai/v1/mcp');
    expect(MCP_BACKEND_PRESETS).toContainEqual({
      id: 'developerz',
      label: 'developerz.ai',
      url: DEVELOPERZ_MCP_ENDPOINT,
      authKind: 'oauth',
    });
  });

  it.each(['README.md', 'docs/idea/mcp.md', 'docs/idea/README.md'])(
    '%s links its developerz.ai handoff reference to the canonical endpoint',
    (path) => {
      const links = developerzMcpLinks(read(path));
      expect(links).toEqual([DEVELOPERZ_MCP_ENDPOINT]);
    },
  );

  it('keeps the panel quick-add control bound to the shared presets', () => {
    expect(read('src/entrypoints/sidepanel/components/McpPanel.tsx')).toContain(
      'MCP_BACKEND_PRESETS',
    );
  });
});

describe('developerz.ai MCP documentation guard', () => {
  it('detects a stale handoff URL fixture', () => {
    const stale = '[developerz.ai MCP endpoint](https://developerz.ai/mcp)';
    expect(developerzMcpLinks(stale)).not.toEqual([DEVELOPERZ_MCP_ENDPOINT]);
  });

  it('detects a fixture with no handoff link', () => {
    expect(developerzMcpLinks('No endpoint is documented.')).toEqual([]);
  });
});
