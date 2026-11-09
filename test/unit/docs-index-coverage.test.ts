import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve directly from `import.meta.url` (a `file:` URL) rather than
// `new URL('.', import.meta.url)` — under Vitest's jsdom env the relative-URL
// constructor rewrites the `file:` base to `http://localhost:3000/...`, so
// fileURLToPath would throw "The URL must be of scheme file".
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

/** The docs index — the one page every other doc must be reachable through. */
const DOCS_INDEX = 'docs/README.md';

/**
 * The documentation surface outside `docs/`. A reader hunting the release steps, the store copy
 * or the agent brain starts at `README.md` like everyone else, so these are indexed too.
 */
const ROOT_DOCS = [
  'CONTRIBUTING.md',
  'AGENTS.md',
  'CLAUDE.md',
  'store/README.md',
  'store/listing-copy.md',
];

/**
 * The chain's seed. From here the guard expands ONLY files named `README.md`: the index chain is
 * root README → `docs/README.md` → each area README. A page may link sideways to a sibling, but
 * that does not make the sibling indexed — the index row is what a reader clicks.
 */
const INDEX_ROOT = 'README.md';

/** Vendored/hidden directories hold other people's markdown — never this repo's docs. */
function skippedDir(name: string): boolean {
  return name === 'node_modules' || name.startsWith('.');
}

/** The directory entry shape the walker needs — injected below so the skip rule is testable. */
interface DirEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
}

/** The real filesystem, behind the walker's I/O seam. */
const realReadDir = (dir: string): DirEntry[] => readdirSync(dir, { withFileTypes: true });

/** An absolute path as the repo-relative POSIX key every failure message speaks in. */
function toKey(absolute: string): string {
  return absolute
    .slice(REPO_ROOT.length + 1)
    .split(sep)
    .join('/');
}

/** Every markdown file under `dir`, as sorted repo-relative keys. */
function markdownKeys(dir: string, readDir: (dir: string) => DirEntry[] = realReadDir): string[] {
  const found: string[] = [];
  for (const entry of readDir(dir)) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (skippedDir(entry.name)) continue;
      found.push(...markdownKeys(full, readDir));
    } else if (entry.isFile() && entry.name.endsWith('.md')) found.push(toKey(full));
  }
  return found.sort();
}

/** A directory listing entry, as the audit needs it. */
interface TreeEntry {
  readonly name: string;
  readonly directory: boolean;
}

/** The tree the audit reads — injected, so each failure mode is pinnable by a fixture. */
interface TreeFs {
  readonly exists: (key: string) => boolean;
  readonly isDirectory: (key: string) => boolean;
  readonly read: (key: string) => string;
  readonly list: (key: string) => readonly TreeEntry[];
}

/** The real checkout, behind the audit's I/O seam. */
const realFs: TreeFs = {
  exists: (key) => existsSync(resolve(REPO_ROOT, key)),
  isDirectory: (key) => {
    try {
      return statSync(resolve(REPO_ROOT, key)).isDirectory();
    } catch {
      return false;
    }
  },
  read: (key) => readFileSync(resolve(REPO_ROOT, key), 'utf8'),
  list: (key) => {
    try {
      return realReadDir(resolve(REPO_ROOT, key)).map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      }));
    } catch {
      return [];
    }
  },
};

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

/** Every link destination in a document, in document order. Image sources are not links. */
function collectTargets(markdown: string): string[] {
  const targets: string[] = [];
  for (const line of stripFencedCode(markdown).split('\n')) {
    // Drop inline code spans first: `code` is a literal, and a reader clicking it goes nowhere.
    const text = line.replace(/`+[^`]*`+/g, '');
    const pattern = /(!?)\[[^\]]*\]\(\s*([^()\s]+?)\s*\)/g;
    let match = pattern.exec(text);
    while (match !== null) {
      const destination = match[2];
      if (match[1] !== '!' && destination !== undefined) targets.push(destination);
      match = pattern.exec(text);
    }
  }
  return targets;
}

/** The repo-relative path a destination names, or `null` for an off-site/anchor-only link. */
function localTarget(destination: string): string | null {
  if (destination.startsWith('#') || destination.startsWith('//')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination)) return null;
  const cut = destination.search(/[#?]/);
  const path = cut === -1 ? destination : destination.slice(0, cut);
  return path === '' ? null : path;
}

/** Join a destination onto the linking file's directory, collapsing `.` and `..`. */
function joinKey(dir: string, target: string): string {
  const parts = dir === '' ? [] : dir.split('/');
  for (const piece of target.split('/')) {
    if (piece === '' || piece === '.') continue;
    if (piece === '..') {
      parts.pop();
      continue;
    }
    parts.push(piece);
  }
  return parts.join('/');
}

/** The directory key of a file key (`''` at the repo root). */
function dirnameKey(key: string): string {
  const cut = key.lastIndexOf('/');
  return cut === -1 ? '' : key.slice(0, cut);
}

/** A chain node: the root README or any `README.md` reached from it. */
function isIndex(key: string): boolean {
  return key === INDEX_ROOT || key.endsWith('/README.md');
}

/** What one index page names, and the entries it names that are not in the tree. */
interface Coverage {
  readonly covered: Set<string>;
  readonly dangling: string[];
}

/**
 * Everything one page links to, resolved onto the doc set. A `.md` link covers that file; a
 * directory link covers its whole prefix — that is how a many-file area with no README
 * (`architecture/adr/`, `plans/2026/…/101-agentic-designer-vision/`) is covered by ONE row.
 * GitHub renders the listing, so a per-file row would be noise.
 */
function coverageOf(file: string, docs: readonly string[], fs: TreeFs): Coverage {
  const covered = new Set<string>();
  const dangling: string[] = [];
  for (const destination of collectTargets(fs.read(file))) {
    const path = localTarget(destination);
    if (path === null) continue;
    const key = joinKey(dirnameKey(file), path);
    if (!fs.exists(key)) {
      dangling.push(`${file} → ${destination} (no such path)`);
      continue;
    }
    if (fs.isDirectory(key)) {
      for (const doc of docs) {
        if (doc === key || doc.startsWith(`${key}/`)) covered.add(doc);
      }
      continue;
    }
    covered.add(key);
  }
  return { covered, dangling };
}

interface IndexAudit {
  /** Every doc the chain reaches by clicking from `README.md`. */
  readonly reachable: readonly string[];
  /** Tracked docs no index row names — the gap this guard exists to catch. */
  readonly orphans: readonly string[];
  /** Index entries naming a path that is not in the tree — a row with nothing behind it. */
  readonly dangling: readonly string[];
  /** The `docs/` children `docs/README.md` itself gives no row to. */
  readonly unindexedAreas: readonly string[];
}

/**
 * Walk the index chain from `README.md`, expanding only READMEs, and report what it covers.
 * Pure: the doc set and the tree arrive as arguments.
 *
 * Reachability alone is not enough. A file linked from the root README is reachable even after
 * its `docs/README.md` row is deleted — the index looks complete while the area row a maintainer
 * is meant to edit is gone. So the areas are also audited against the docs index directly.
 */
function auditIndex(docs: readonly string[], fs: TreeFs): IndexAudit {
  const reachable = new Set<string>();
  const dangling: string[] = [];
  const expanded = new Set<string>();
  const queue: string[] = [INDEX_ROOT];

  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || expanded.has(file)) continue;
    expanded.add(file);
    const coverage = coverageOf(file, docs, fs);
    dangling.push(...coverage.dangling);
    for (const key of coverage.covered) {
      reachable.add(key);
      if (isIndex(key) && !expanded.has(key)) queue.push(key);
    }
  }

  const docsIndex = coverageOf(DOCS_INDEX, docs, fs);
  const unindexedAreas: string[] = [];
  for (const entry of fs.list('docs')) {
    const key = `docs/${entry.name}`;
    if (key === DOCS_INDEX) continue;
    // A child is indexed when the docs index links it directly, links anything inside it, or
    // links its directory — the three shapes a legitimate area row takes.
    const named =
      docsIndex.covered.has(key) ||
      [...docsIndex.covered].some((covered) => covered.startsWith(`${key}/`));
    if (!named) unindexedAreas.push(key);
  }

  const orphans = docs.filter((doc) => !reachable.has(doc)).sort();
  return {
    reachable: [...reachable].sort(),
    orphans,
    dangling,
    unindexedAreas: unindexedAreas.sort(),
  };
}

/** Every markdown under `docs/`, plus the root/store pages beside it — the full doc surface. */
function trackedDocs(): string[] {
  return [...markdownKeys(resolve(REPO_ROOT, 'docs')), ...ROOT_DOCS].sort();
}

describe('docs index coverage', () => {
  const docs = trackedDocs();
  const audit = auditIndex(docs, realFs);

  it('reads the whole documentation surface, not a sample', () => {
    // A walker that silently returned nothing would make every assertion below vacuous.
    expect(docs.length).toBeGreaterThan(50);
    for (const known of ['docs/README.md', 'docs/wiki/README.md', 'store/listing-copy.md']) {
      expect(docs, `walker missed ${known}`).toContain(known);
    }
  });

  it('reaches the docs index from the root README', () => {
    expect(audit.reachable).toContain(DOCS_INDEX);
  });

  it('gives every docs area and docs-root page a row in the docs index', () => {
    expect(
      audit.unindexedAreas,
      `no row in ${DOCS_INDEX} for: ${audit.unindexedAreas.join(', ')}`,
    ).toEqual([]);
  });

  it('reaches every tracked doc from README.md through the README chain', () => {
    expect(audit.orphans, `docs with no index row: ${audit.orphans.join(', ')}`).toEqual([]);
  });

  it('names only index paths that exist in the tree', () => {
    expect(audit.dangling, `index rows pointing nowhere: ${audit.dangling.join('; ')}`).toEqual([]);
  });
});

describe('index audit self-check', () => {
  /** A tree the audit can be pointed at — no temp files, no cleanup. */
  const fakeFs = (files: Record<string, string>, dirs: readonly string[]): TreeFs => {
    const children = (dir: string): TreeEntry[] =>
      [...dirs, ...Object.keys(files)]
        .filter((key) => dirnameKey(key) === dir && key !== dir)
        .map((key) => ({
          name: key.slice(dir === '' ? 0 : dir.length + 1),
          directory: dirs.includes(key),
        }));
    return {
      exists: (key) => key in files || dirs.includes(key),
      isDirectory: (key) => dirs.includes(key),
      read: (key) => files[key] ?? '',
      list: (key) => children(key),
    };
  };

  it('flags a dropped docs-index row even when the area is linked from the root README', () => {
    // The regression reachability alone misses: `docs/wiki/` is still one click from the root
    // README, so every wiki page stays reachable while the row a maintainer edits is gone.
    const tree = fakeFs(
      {
        'README.md': '[docs](docs/README.md) · [wiki](docs/wiki/README.md)',
        'docs/README.md': '| [`idea/`](idea/README.md) | why |',
        'docs/idea/README.md': '| [overview](overview.md) |',
        'docs/idea/overview.md': '# Overview',
        'docs/wiki/README.md': '| [history](history.md) |',
        'docs/wiki/history.md': '# History',
      },
      ['docs', 'docs/idea', 'docs/wiki'],
    );
    const audit = auditIndex(
      [
        'docs/idea/README.md',
        'docs/idea/overview.md',
        'docs/wiki/README.md',
        'docs/wiki/history.md',
      ],
      tree,
    );
    expect(audit.unindexedAreas).toEqual(['docs/wiki']);
    expect(audit.orphans).toEqual([]);
  });

  it('flags an index row pointing at a directory that is not in the tree', () => {
    // `docs/README.md` carried exactly this row for a `standards/` area that was never created.
    const tree = fakeFs(
      {
        'README.md': '[docs](docs/README.md)',
        'docs/README.md': '| [`standards/`](standards/) | how work is done |',
      },
      ['docs'],
    );
    const audit = auditIndex([], tree);
    expect(audit.dangling).toHaveLength(1);
    expect(audit.dangling[0]).toContain('docs/README.md → standards/ (no such path)');
  });

  it('covers a many-file directory from one directory link', () => {
    const tree = fakeFs(
      {
        'README.md': '[docs](docs/README.md)',
        'docs/README.md': '| [`adr/`](adr/) | decisions |',
        'docs/adr/0001-thing.md': '# Thing',
        'docs/adr/0002-other.md': '# Other',
      },
      ['docs', 'docs/adr'],
    );
    const audit = auditIndex(['docs/adr/0001-thing.md', 'docs/adr/0002-other.md'], tree);
    expect(audit.orphans).toEqual([]);
    // The directory row itself covers both pages, without a per-file row for either.
    expect(audit.reachable).toEqual([
      'docs/README.md',
      'docs/adr/0001-thing.md',
      'docs/adr/0002-other.md',
    ]);
  });

  it('does not count a page reachable only sideways from a non-index page', () => {
    // `docs/idea/ui.md` links `../wiki/history.md` in prose; that is not an index row, so the
    // wiki page stays orphaned until the coarser area row names it.
    const tree = fakeFs(
      {
        'README.md': '[docs](docs/README.md)',
        'docs/README.md': '| [`idea/`](idea/README.md) | why |',
        'docs/idea/README.md': '| [ui](ui.md) |',
        'docs/idea/ui.md': 'see [history](../wiki/history.md)',
        'docs/wiki/history.md': '# History',
      },
      ['docs', 'docs/idea', 'docs/wiki'],
    );
    const audit = auditIndex(['docs/idea/ui.md', 'docs/wiki/history.md'], tree);
    expect(audit.reachable).toContain('docs/idea/ui.md');
    expect(audit.orphans).toEqual(['docs/wiki/history.md']);
  });

  it('flags a root README that never links the docs index', () => {
    // The shipped defect: `README.md` linked two area READMEs directly and never the index,
    // which left the index itself orphaned.
    const tree = fakeFs(
      {
        'README.md': '[idea](docs/idea/README.md) · [architecture](docs/architecture/README.md)',
        'docs/README.md': '| [`idea/`](idea/README.md) | why |',
        'docs/idea/README.md': '| [overview](overview.md) |',
        'docs/idea/overview.md': '# Overview',
      },
      ['docs', 'docs/idea'],
    );
    const audit = auditIndex(
      ['docs/README.md', 'docs/idea/README.md', 'docs/idea/overview.md'],
      tree,
    );
    expect(audit.reachable).not.toContain('docs/README.md');
    expect(audit.orphans).toEqual(['docs/README.md']);
  });
});
