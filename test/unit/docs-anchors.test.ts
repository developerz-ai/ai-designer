import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve directly from `import.meta.url` (a `file:` URL) rather than
// `new URL('.', import.meta.url)` — under Vitest's jsdom env the relative-URL
// constructor rewrites the `file:` base to `http://localhost:3000/...`, so
// fileURLToPath would throw "The URL must be of scheme file".
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DOCS_ROOT = resolve(REPO_ROOT, 'docs');

/** Every markdown file under `docs/` — the guard's whole input set. */
function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full);
  }
  return found.sort();
}

/**
 * GitHub's heading slug: lowercase, drop every character that is not a letter,
 * digit, space, hyphen or underscore, then turn each space into a hyphen.
 * `Provider — BYOK, any endpoint` → `provider--byok-any-endpoint`.
 */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/\s/g, '-');
}

/** Drop fenced code blocks — their content is sample text, not prose. */
function stripFencedCode(markdown: string): string {
  const kept: string[] = [];
  let fenceChar = '';
  let fenceLength = 0;
  for (const line of markdown.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceChar === '') {
      if (marker === undefined) {
        kept.push(line);
      } else {
        fenceChar = marker[0] ?? '`';
        fenceLength = marker.length;
      }
      continue;
    }
    // A closing fence repeats the opening character, at least as long.
    if (marker?.startsWith(fenceChar) && marker.length >= fenceLength) {
      fenceChar = '';
      fenceLength = 0;
    }
  }
  return kept.join('\n');
}

/** Drop inline code spans — a `code` literal is not a link. */
function stripInlineCode(text: string): string {
  return text.replace(/`+[^`]*`+/g, '');
}

/**
 * The slugs GitHub generates for a document's headings. A repeated heading
 * gets GitHub's `-1`, `-2`, … suffix, so the set matches what a browser
 * resolves `#fragment` against.
 */
function headingSlugs(markdown: string): string[] {
  const slugs: string[] = [];
  const seen = new Map<string, number>();
  for (const line of stripFencedCode(markdown).split('\n')) {
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line)?.[1];
    if (heading === undefined) continue;
    const base = slugify(heading);
    if (base === '') continue;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.push(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

interface DocLink {
  /** The link destination — empty for a same-page `#fragment` link. */
  readonly target: string;
  readonly anchor: string;
  /** 1-based line in the source document, for the failure message. */
  readonly line: number;
}

/** `](file.md#anchor)` and `](#anchor)` destinations — the links this guard resolves. */
function collectLinks(markdown: string): DocLink[] {
  const links: DocLink[] = [];
  const lines = stripFencedCode(markdown).split('\n');
  for (const [index, line] of lines.entries()) {
    const text = stripInlineCode(line);
    const pattern = /\]\(([^()\s]*\.md)?#([^()\s]+)\)/g;
    let match = pattern.exec(text);
    while (match !== null) {
      links.push({ target: match[1] ?? '', anchor: match[2] ?? '', line: index + 1 });
      match = pattern.exec(text);
    }
  }
  return links;
}

/** Heading slugs per file — the same target is visited from several sources. */
const slugCache = new Map<string, string[]>();

function slugsOf(file: string): string[] {
  const cached = slugCache.get(file);
  if (cached !== undefined) return cached;
  const slugs = headingSlugs(readFileSync(file, 'utf8'));
  slugCache.set(file, slugs);
  return slugs;
}

interface ResolvedLink {
  /** Repo-relative source file + line. */
  readonly from: string;
  /** Docs-relative target + `#` + anchor — the key a reader clicks. */
  readonly key: string;
  /** Absolute path of the target document. */
  readonly target: string;
  readonly anchor: string;
}

/** The only I/O the classifier needs — injected, so the classifier stays pure. */
interface TargetReader {
  /** Does the target file exist on disk? */
  readonly exists: (file: string) => boolean;
  /** The heading slugs the target file defines. */
  readonly slugs: (file: string) => string[];
}

/**
 * Why a resolved link cannot be followed — `null` when it resolves. Pure: the
 * repo root and the target's facts arrive as arguments, so each failure mode
 * is pinnable by a test instead of only ever running against valid docs.
 * Module-local: Biome's `noExportsInTest` forbids exporting from a test file.
 */
function classifyLink(link: ResolvedLink, repoRoot: string, reader: TargetReader): string | null {
  if (relative(repoRoot, link.target).startsWith('..')) {
    return `${link.from} → ${link.key} (target outside the repo)`;
  }
  if (!reader.exists(link.target)) {
    return `${link.from} → ${link.key} (target file missing)`;
  }
  if (!reader.slugs(link.target).includes(link.anchor)) {
    return `${link.from} → ${link.key} (no such heading)`;
  }
  return null;
}

/** The real filesystem, behind the classifier's I/O seam. */
const targetReader: TargetReader = {
  exists: existsSync,
  slugs: slugsOf,
};

/** Every `#fragment` link in the docs, resolved against its source file. */
function resolveLinks(): ResolvedLink[] {
  const resolved: ResolvedLink[] = [];
  for (const file of markdownFiles(DOCS_ROOT)) {
    for (const link of collectLinks(readFileSync(file, 'utf8'))) {
      const target = link.target === '' ? file : resolve(dirname(file), link.target);
      resolved.push({
        from: `${relative(REPO_ROOT, file)}:${link.line}`,
        key: `${relative(DOCS_ROOT, target)}#${link.anchor}`,
        target,
        anchor: link.anchor,
      });
    }
  }
  return resolved;
}

/**
 * The anchors the docs already depend on. They double as the guard's
 * non-vacuity floor: a collector that stopped matching links, or a slug rule
 * that drifted, fails here instead of silently checking nothing.
 */
const KNOWN_ANCHORS = [
  'idea/agent.md#memory',
  'idea/agent.md#readiness--start',
  'idea/agent.md#tool-catalog',
  'idea/agent.md#modes--copy-debug-srcagentmodests',
  'idea/agent.md#provider--byok-any-endpoint',
  'idea/mcp.md#namespacing',
  'architecture/mv3-worlds.md#service-worker-ephemerality',
  'architecture/mv3-worlds.md#main-world-bridge-srcdombridgets-srcentrypointsinjectedcontentts',
  'idea/ui.md#overlay',
  'idea/ui.md#side-panel-tabs',
  'idea/ui.md#history',
];

describe('docs cross-page anchors', () => {
  const links = resolveLinks();

  it('every #fragment link lands on a real heading', () => {
    const broken: string[] = [];
    for (const link of links) {
      const problem = classifyLink(link, REPO_ROOT, targetReader);
      if (problem !== null) broken.push(problem);
    }
    expect(broken).toEqual([]);
  });

  it('collects the anchors the docs already rely on', () => {
    const keys = links.map((link) => link.key);
    for (const known of KNOWN_ANCHORS) {
      expect(keys, `no doc links to ${known}`).toContain(known);
    }
  });
});

describe('broken-link classification', () => {
  /** A resolved link to a synthetic target — the classifier never touches disk. */
  function fakeLink(target: string, anchor: string): ResolvedLink {
    return {
      from: 'idea/agent.md:111',
      key: `${relative(DOCS_ROOT, target)}#${anchor}`,
      target,
      anchor,
    };
  }

  it('flags an anchor no heading has', () => {
    const target = resolve(DOCS_ROOT, 'idea/ui.md');
    const reader: TargetReader = { exists: () => true, slugs: () => ['overlay'] };
    const problem = classifyLink(fakeLink(target, 'history'), REPO_ROOT, reader);
    expect(problem).not.toBeNull();
    expect(problem).toContain('(no such heading)');
  });

  it('flags a missing .md target', () => {
    const target = resolve(DOCS_ROOT, 'idea/gone.md');
    const reader: TargetReader = { exists: () => false, slugs: () => [] };
    const problem = classifyLink(fakeLink(target, 'history'), REPO_ROOT, reader);
    expect(problem).not.toBeNull();
    expect(problem).toContain('(target file missing)');
  });

  it('flags a target outside the repo', () => {
    const target = resolve(REPO_ROOT, '../outside.md');
    const reader: TargetReader = { exists: () => true, slugs: () => ['history'] };
    const problem = classifyLink(fakeLink(target, 'history'), REPO_ROOT, reader);
    expect(problem).not.toBeNull();
    expect(problem).toContain('(target outside the repo)');
  });

  it('resolves a link that lands on a real heading', () => {
    const target = resolve(DOCS_ROOT, 'idea/ui.md');
    const reader: TargetReader = { exists: () => true, slugs: () => ['overlay', 'history'] };
    expect(classifyLink(fakeLink(target, 'history'), REPO_ROOT, reader)).toBeNull();
  });
});

describe('anchor guard self-check', () => {
  it('slugs headings the way GitHub does', () => {
    const doc = [
      '# UI',
      '',
      '## Provider — BYOK, any endpoint',
      '',
      '## Readiness / Start',
      '',
      '## Modes — copy, debug (`src/agent/modes.ts`)',
    ].join('\n');
    expect(headingSlugs(doc)).toEqual([
      'ui',
      'provider--byok-any-endpoint',
      'readiness--start',
      'modes--copy-debug-srcagentmodests',
    ]);
  });

  it('ignores links inside code fences and inline code', () => {
    const doc = [
      '```md',
      '[fenced](other.md#fenced)',
      '```',
      'See `[inline](other.md#inline)` but [real](other.md#history).',
    ].join('\n');
    expect(collectLinks(doc).map((link) => link.anchor)).toEqual(['history']);
  });

  it('separates a real heading from an anchor no heading has', () => {
    const slugs = headingSlugs('# Other\n\n## Overlay\n');
    expect(slugs).toEqual(['other', 'overlay']);
    expect(slugs).not.toContain('history');
  });

  it('suffixes a repeated heading the way GitHub does', () => {
    const doc = ['## Overview', '', '## Overview'].join('\n');
    expect(headingSlugs(doc)).toEqual(['overview', 'overview-1']);
  });

  it('ignores links inside a ~~~ fence', () => {
    const doc = ['~~~md', '[fenced](other.md#fenced)', '~~~', 'See [real](other.md#history).'].join(
      '\n',
    );
    expect(collectLinks(doc).map((link) => link.anchor)).toEqual(['history']);
  });
});

describe('docs/idea/ui.md#history', () => {
  const uiPath = resolve(DOCS_ROOT, 'idea/ui.md');

  it('pins the `## History` heading', () => {
    const markdown = readFileSync(uiPath, 'utf8');
    expect(markdown).toMatch(/^## History$/m);
    expect(headingSlugs(markdown)).toContain('history');
  });

  for (const source of ['idea/agent.md', 'idea/handoff.md']) {
    it(`${source} links to ui.md#history`, () => {
      const links = collectLinks(readFileSync(resolve(DOCS_ROOT, source), 'utf8'));
      expect(links.map((link) => `${link.target}#${link.anchor}`)).toContain('ui.md#history');
    });
  }
});
