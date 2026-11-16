import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A tracked file is a public document: this repository is public, and so is every build of the
 * extension. This guard keeps facts about our own infrastructure out of both (#256).
 *
 * **No internal host on our own domain.** Only the public hosts below may be named. The error
 * tracker's host and the internal service endpoints are not public, and nothing that builds,
 * tests or uses this project needs them.
 *
 * **No internal setup mode and no private word.** The name of the setup mode that generated some
 * files is already public in every sibling repository's history, so it is assembled from parts
 * below. The private words (the CI provider for the organisation's private repositories, and the
 * like) are never in this file, whole or in parts: two quoted fragments joined in a public file are
 * the word to anyone who reads it. They come from the PUBLIC_TREE_PRIVATE_WORDS CI secret (comma-
 * or newline-separated). A run without it (a fork's PR, Dependabot's, a local run) says it skipped
 * them; this repository's own CI runs set PUBLIC_TREE_PRIVATE_WORDS_REQUIRED=1, where an empty
 * secret fails.
 *
 * **No one's machine.** A path under a home directory names a person and lays out their machine;
 * the tree names a file by its repository path and an upstream project by its name. A `~/` path
 * into a dotfile stays: that is where a tool keeps its config, the same on every machine.
 *
 * **No crash-report grant.** Crash reporting is off (#212). The manifest's static host grants are
 * the BYOK model endpoint only — read from `wxt.config.ts` on every run, and from the built
 * manifest whenever one is present (CI's build job requires it: DZ_REQUIRE_BUILT_MANIFEST=1).
 *
 * Git is the oracle for "tracked", invoked as a real `git ls-files` subprocess, and the repository
 * is checked to be this one first: a checkout nested inside another repository would have git
 * answer with the outer tree's index. The scan must read this file itself and a floor of files,
 * so a scan that read nothing cannot pass green.
 *
 * A failure names the file and the class, NEVER the value it matched: CI logs are public, and a
 * red run must not print the value it exists to keep out.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

/** This file's own path, repo-relative: the sentinel that proves the scan read itself. */
const SELF = 'test/unit/public-tree.test.ts';

/** Fewer tracked files than this means the oracle answered for the wrong tree. */
const MIN_TRACKED_FILES = 300;

/**
 * The hosts on our own domain a tracked file may name, each public on its own:
 * the product homepage, its www alias, this extension's own site (`site/`, the waitlist), and the
 * platform's public MCP endpoint, which the side panel's built-in quick-add preset connects to.
 */
const PERMITTED_OWN_HOSTS = new Set([
  'developerz.ai',
  'www.developerz.ai',
  'designer.developerz.ai',
  'mcp.developerz.ai',
]);

const OWN_DOMAIN = ['developerz', 'ai'].join('.');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Any host on our own domain. DNS names are case-insensitive, so the match is too. */
const OWN_HOST = new RegExp(`\\b(?:[a-z0-9-]+\\.)*${escapeRe(OWN_DOMAIN)}\\b`, 'gi');

/** The internal-zone classes, named on their own so a failure says which zone leaked. */
const INTERNAL_ZONES = ['infra', 'dev'].map(
  (zone) => new RegExp(`\\.${zone}\\.${escapeRe(OWN_DOMAIN)}\\b`, 'i'),
);

/** The setup mode that wrote the generated files, assembled from parts (already public). */
const SETUP_MODE = ['dz', 'runner'].join('-');

const PRIVATE_WORDS_ENV = 'PUBLIC_TREE_PRIVATE_WORDS';
const REQUIRED_ENV = 'PUBLIC_TREE_PRIVATE_WORDS_REQUIRED';

/** The private words in a secret's value: comma- or newline-separated, case-insensitive. */
function privateWords(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[,\n]/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word.length > 0);
}

/** The private words for this run, or an error when the run must check them and has none. */
function privateWordsForRun(raw: string | undefined, required: boolean): string[] {
  const words = privateWords(raw);
  if (words.length === 0 && required) {
    throw new Error(
      `${PRIVATE_WORDS_ENV} is empty, and ${REQUIRED_ENV}=1 says this run must check the private words`,
    );
  }
  return words;
}

const WORDS = privateWordsForRun(process.env[PRIVATE_WORDS_ENV], process.env[REQUIRED_ENV] === '1');

/** A home directory: one under `/home` or `/Users`, or a `~/` path into a plain directory. */
const HOME_PATH = /(?:^|[^\w.-])\/(?:home|Users)\/[\w.-]+|~\/[\w-]/m;

/**
 * The platform's own working directory, rewritten wholesale on every onboarding run: a rule over
 * it would fail the platform's commits rather than a change made here. Out of scope per #256.
 */
const PLATFORM_OWNED = [/^\.dz\//];

type Rule = {
  name: string;
  applies: (path: string) => boolean;
  finds: (text: string, words: readonly string[]) => boolean;
};

/** The hosts on our own domain in one text that the rule does not permit. */
function forbiddenOwnHosts(text: string): number {
  let count = 0;
  for (const match of text.matchAll(OWN_HOST)) {
    if (!PERMITTED_OWN_HOSTS.has(match[0].toLowerCase())) count++;
  }
  return count;
}

const RULES: Rule[] = [
  {
    name: 'internal host on our own domain',
    applies: () => true,
    finds: (t) => forbiddenOwnHosts(t) > 0,
  },
  {
    name: 'internal-zone host',
    applies: () => true,
    finds: (t) => INTERNAL_ZONES.some((re) => re.test(t)),
  },
  {
    name: 'internal setup mode name',
    applies: () => true,
    finds: (t) => t.toLowerCase().includes(SETUP_MODE),
  },
  {
    name: 'private word (from the secret)',
    applies: () => true,
    finds: (t, words) => {
      const lower = t.toLowerCase();
      return words.some((word) => lower.includes(word));
    },
  },
  { name: 'home-directory path', applies: () => true, finds: (t) => HOME_PATH.test(t) },
];

function repoRoot(): string {
  const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: REPO_ROOT });
  if (proc.status !== 0) throw new Error(`git rev-parse --show-toplevel exited ${proc.status}`);
  const toplevel = proc.stdout.toString().trim().replace(/\/+$/, '');
  if (toplevel !== REPO_ROOT.replace(/\/+$/, '')) {
    throw new Error('git answers for another repository: this checkout is nested inside one');
  }
  return toplevel;
}

function trackedFiles(root: string): string[] {
  const proc = spawnSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (proc.status !== 0) throw new Error(`git ls-files exited ${proc.status}`);
  return proc.stdout
    .toString()
    .split('\0')
    .filter((p) => p.length > 0 && !PLATFORM_OWNED.some((re) => re.test(p)));
}

/** A file we cannot read as text (binary, or deleted in the working tree) carries no string. */
function readText(root: string, path: string): string | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(root, path));
  } catch {
    return null;
  }
  return bytes.includes(0) ? null : bytes.toString('utf8');
}

/** `path — class` for every rule a text breaks. Never the matched value. */
function offenses(path: string, text: string, words: readonly string[] = WORDS): string[] {
  return RULES.filter((r) => r.applies(path) && r.finds(text, words)).map(
    (r) => `${path} — ${r.name}`,
  );
}

describe('the public tree', () => {
  if (WORDS.length === 0)
    console.warn(`public-tree: ${PRIVATE_WORDS_ENV} is unset, private words not checked`);
  const root = repoRoot();
  const files = trackedFiles(root);
  let read = 0;
  let readSelf = false;
  const found: string[] = [];
  for (const path of files) {
    const text = readText(root, path);
    if (text === null) continue;
    read++;
    if (path === SELF) readSelf = true;
    found.push(...offenses(path, text));
  }

  it('reads the tracked tree, this file included', () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_TRACKED_FILES);
    expect(read).toBeGreaterThanOrEqual(MIN_TRACKED_FILES);
    expect(readSelf, `${SELF} was not among the files read`).toBe(true);
  });

  it('carries no fact about our own infrastructure', () => {
    console.warn(
      `public-tree: read ${read} of ${files.length} tracked files, ${WORDS.length} private words`,
    );
    // A failure lists `file — class` only, so a red CI log never repeats the value.
    expect(found, `${found.length} offending file/class pair(s) in ${read} files read`).toEqual([]);
  });
});

// --- the manifest: no crash-report grant ----------------------------------------------------

/** The static `host_permissions` array in wxt.config.ts, read as text (no `wxt` import). */
function configHostPermissions(): string[] {
  const src = readFileSync(join(REPO_ROOT, 'wxt.config.ts'), 'utf8');
  const match = src.match(/\bhost_permissions\s*:\s*\[([^\]]*)\]/m);
  if (!match?.[1]) throw new Error('wxt.config.ts has no parsable host_permissions array');
  return match[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]/, '').replace(/['"]$/, ''))
    .filter((s) => s.length > 0);
}

/** Why a host grant is refused, or null when it is the one the extension needs. */
function badGrant(grant: string): string | null {
  if (grant !== 'https://openrouter.ai/*')
    return 'a static host grant other than the BYOK model endpoint';
  return null;
}

function grantOffenses(where: string, grants: string[]): string[] {
  return grants.flatMap((g) => {
    const out: string[] = [];
    if (forbiddenOwnHosts(g) > 0 || offenses(where, g).length > 0) {
      out.push(`${where} — host grant on our own infrastructure`);
    }
    const why = badGrant(g);
    if (why) out.push(`${where} — ${why}`);
    return out;
  });
}

describe('manifest host grants', () => {
  it('wxt.config.ts grants the BYOK model endpoint and nothing else', () => {
    const grants = configHostPermissions();
    expect(grants.length).toBeGreaterThan(0);
    expect(grantOffenses('wxt.config.ts', grants)).toEqual([]);
  });

  const BUILD = join(REPO_ROOT, 'build/chrome-mv3');
  const built = existsSync(join(BUILD, 'manifest.json'));
  const required = process.env.DZ_REQUIRE_BUILT_MANIFEST === '1';

  describe.skipIf(!built && !required)('the built extension', () => {
    it('the emitted manifest grants the BYOK model endpoint and nothing else', () => {
      expect(built, 'Missing build/chrome-mv3/manifest.json; run bun run build first').toBe(true);
      const manifest = JSON.parse(readFileSync(join(BUILD, 'manifest.json'), 'utf8')) as {
        host_permissions?: string[];
      };
      const grants = manifest.host_permissions ?? [];
      expect(grants.length).toBeGreaterThan(0);
      expect(grantOffenses('build/chrome-mv3/manifest.json', grants)).toEqual([]);
    });

    it('the emitted bundle names no host on our own infrastructure', () => {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const full = join(dir, name);
          return statSync(full).isDirectory() ? walk(full) : [full];
        });
      const texts = walk(BUILD).filter((f) =>
        ['.js', '.json', '.html', '.css'].includes(extname(f)),
      );
      expect(texts.length).toBeGreaterThan(0);
      const bad = texts
        .map((f) => f.slice(REPO_ROOT.length + 1))
        .filter((rel) => {
          const t = readFileSync(join(REPO_ROOT, rel), 'utf8');
          return forbiddenOwnHosts(t) > 0 || INTERNAL_ZONES.some((re) => re.test(t));
        });
      expect(bad).toEqual([]);
    });
  });
});

// --- each rule fires on the shape it exists to catch ---------------------------------------

describe('the guard is not vacuous', () => {
  const internalZoneHost = ['errors', 'infra', OWN_DOMAIN].join('.');
  const tracker = `https://${internalZoneHost}/api/1/`;
  const internal = ['some-service', OWN_DOMAIN].join('.');
  const words = privateWords(' Quimtel ,\n\nzorblax.io\n');

  it.each([
    ['internal host on our own domain', `"url": "https://${internal}/v1/mcp"`],
    ['internal-zone host', `see https://grafana.${['infra', OWN_DOMAIN].join('.')}`],
    ['internal-zone host', tracker],
    ['internal setup mode name', `# established by ${SETUP_MODE} setup mode`],
    ['private word (from the secret)', 'runs-on: QUIMTEL-standard-2'],
    ['home-directory path', `see ${['', 'home', 'someone', 'src'].join('/')}`],
  ])('%s fires', (rule, sample) => {
    expect(offenses('fixture.txt', sample, words)).toContain(`fixture.txt — ${rule}`);
  });

  it('a failure names the file and the class, never the value', () => {
    for (const line of offenses('fixture.txt', `${tracker} runs-on: quimtel`, words)) {
      expect(line.toLowerCase()).not.toContain(internalZoneHost);
      expect(line.toLowerCase()).not.toContain('quimtel');
    }
  });

  it('lets the public hosts, a package scope and a dotfile path through', () => {
    expect(forbiddenOwnHosts('https://developerz.ai/docs https://www.developerz.ai')).toBe(0);
    expect(forbiddenOwnHosts('https://designer.developerz.ai/')).toBe(0);
    expect(forbiddenOwnHosts('https://mcp.developerz.ai/v1/mcp')).toBe(0);
    expect(forbiddenOwnHosts('"@developerz.ai/ui-debugger-mcp"')).toBe(0);
    expect(offenses('fixture.txt', 'config lives in ~/.config/tool')).toEqual([]);
  });

  it('refuses an internal-zone grant in a manifest', () => {
    const grants = ['https://openrouter.ai/*', `https://${internalZoneHost}/*`];
    expect(grantOffenses('manifest.json', grants)).toContain(
      'manifest.json — host grant on our own infrastructure',
    );
    expect(grantOffenses('manifest.json', ['https://openrouter.ai/*'])).toEqual([]);
  });

  it('applies the private-word rule to every file, the review config included', () => {
    expect(offenses('.coderabbit.yaml', 'runs-on: quimtel', words)).toHaveLength(1);
    expect(offenses('.github/workflows/ci.yml', 'runs-on: quimtel', words)).toHaveLength(1);
    expect(offenses('fixture.txt', 'zorblax-io and quim', words)).toEqual([]);
  });

  it('reads the private words from the secret, and a required run without them fails', () => {
    expect(words).toEqual(['quimtel', 'zorblax.io']);
    expect(privateWords(undefined)).toEqual([]);
    expect(() => privateWordsForRun(undefined, true)).toThrow(REQUIRED_ENV);
    expect(() => privateWordsForRun(' , \n', true)).toThrow(REQUIRED_ENV);
    expect(privateWordsForRun(undefined, false)).toEqual([]);
    expect(privateWordsForRun('quimtel', true)).toEqual(['quimtel']);
  });
});

// --- CI passes the secret to every step that runs this guard ------------------------------

describe('CI wiring', () => {
  // Deleting, commenting out or weakening either line would switch the private-word check off
  // with every test still green, so each step's live (uncommented) lines are matched exactly.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally
  const SECRET_LINE = 'PUBLIC_TREE_PRIVATE_WORDS: ${{ secrets.PUBLIC_TREE_PRIVATE_WORDS }}';
  const REQUIRED_LINE =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, matched literally
    "PUBLIC_TREE_PRIVATE_WORDS_REQUIRED: ${{ (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) && github.actor != 'dependabot[bot]' && '1' || '' }}";
  const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');

  it.each([
    ['- name: Unit + integration tests\n', 'run: bun run test\n'],
    [
      '- name: Validate emitted manifest grants (public-tree guard)\n',
      'run: bun run test test/unit/public-tree.test.ts',
    ],
  ])('%s passes the secret and the required flag', (step, run) => {
    const start = ci.indexOf(step);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = ci.indexOf(run, start);
    expect(end).toBeGreaterThan(start);
    const live = ci
      .slice(start, end)
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .map((line) => line.trim());
    expect(live).toContain(SECRET_LINE);
    expect(live).toContain(REQUIRED_LINE);
  });
});
