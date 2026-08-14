import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMAGE_WORKER_FILE } from '@/entrypoints/sidepanel/lib/image-encode-protocol';

// The guard for a bug NO OTHER TEST IN THIS SUITE CAN SEE.
//
// The encode worker was originally spawned the canonical Vite way:
//
//   new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' })
//
// which cannot work under WXT. `wxt/.../plugins/defineImportMeta.mjs` sets Vite's
// `define: { 'import.meta.url': 'self.location.href' }` for every build; Vite registers
// `vite:define` BEFORE `vite:worker-import-meta-url` (`resolvePlugins`); and that plugin's
// transform filter is the literal regex `/new\s+(?:Worker|SharedWorker)\s*\(\s*new\s+URL.+?
// import\.meta\.url/s`. By the time it runs the marker is gone, nothing matches, NO WORKER CHUNK
// IS EMITTED, and `./image-worker.ts` survives verbatim into the bundle. At runtime `new Worker`
// 404s, the client's inline fallback catches it, and every image encodes on the main thread.
//
// That is the nasty part: the fallback is silent and CORRECT, so the feature works, the unit
// suite is green, `bun run build` succeeds — and the worker is inert. Only looking at the emitted
// bundle finds it. So this file looks at the source (always) and at the emitted bundle (whenever
// one is present).
//
// Resolve from `import.meta.url` as a `file:` URL — the same jsdom pitfall `manifest-invariant.
// test.ts` documents: `new URL('.', import.meta.url)` rewrites the base to http://localhost.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '../..');
const SRC = join(REPO, 'src');
const BUILD = join(REPO, 'build/chrome-mv3');

const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

function sourceFiles(): string[] {
  return walk(SRC, (f) => SCRIPT_EXTENSIONS.has(extname(f)));
}

/**
 * Comments out. Load-bearing, and learned the hard way: the fix for this very bug DOCUMENTS the
 * broken expression in prose (`src/entrypoints/image-worker.ts` spells out
 * `new Worker(new URL('./image-worker.ts', import.meta.url))` so nobody reintroduces it), and a
 * scanner that cannot tell code from an explanation fails on the explanation. A guard that cries
 * wolf gets deleted, and then it guards nothing.
 *
 * Whole-line only, deliberately: block comments and lines that are entirely a comment are
 * dropped, and a trailing `//` is cut only when it is not part of a `://` URL. Code lines are
 * never partially rewritten, so this cannot hide a real construction from the scan.
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

/**
 * Every `new Worker(...)` construction in a file, as the text of its arguments.
 *
 * Balances parentheses rather than regex-matching the closing one. The first version of this
 * ended the match at `)` followed by `as`/`;`/`)` and MISSED THE REAL BUG: minified output reads
 * `new Worker(new URL("./image-worker.ts",self.location.href),{type:"module"})}catch(e){…`, whose
 * next character is `}`. A guard that only recognises pretty-printed source does not guard the
 * artifact, which is the only place this bug is visible.
 */
function workerConstructions(code: string): string[] {
  const out: string[] = [];
  for (const match of code.matchAll(/new\s+(?:Shared)?Worker\s*\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
    }
    out.push(code.slice(start, i - 1));
  }
  return out;
}

describe('encode worker — source invariants', () => {
  // The exact assertion that would have failed on the broken build: a `.ts` specifier is a source
  // path, and there is no source path in a built extension.
  it('never points a Worker at a .ts/.tsx path', () => {
    const offenders = sourceFiles().filter((file) =>
      workerConstructions(stripComments(readFileSync(file, 'utf8'))).some((args) =>
        /\.tsx?\b/.test(args),
      ),
    );

    expect(offenders).toEqual([]);
  });

  // The other half of the same defect: under WXT's define this expression is dead on arrival, so
  // it must not come back — including via a copy-paste from any Vite tutorial.
  it('never spawns a Worker through import.meta.url — WXT defines it away', () => {
    const offenders = sourceFiles().filter((file) =>
      workerConstructions(stripComments(readFileSync(file, 'utf8'))).some((args) =>
        args.includes('import.meta.url'),
      ),
    );

    expect(offenders).toEqual([]);
  });

  // WXT discovers `entrypoints/*.ts` as an unlisted script and emits `<name>.js` at the output
  // root (`find-entrypoints.mjs` + `getEntrypointOutputFile`). If the file moves or is renamed,
  // `IMAGE_WORKER_FILE` stops resolving and the worker silently 404s again.
  it('keeps the worker a top-level WXT entrypoint whose name matches IMAGE_WORKER_FILE', () => {
    const entry = join(SRC, 'entrypoints/image-worker.ts');

    expect(existsSync(entry)).toBe(true);
    expect(IMAGE_WORKER_FILE).toBe('image-worker.js');
    // An unlisted script must default-export a `defineUnlistedScript` call, or WXT builds nothing.
    expect(readFileSync(entry, 'utf8')).toMatch(/export default defineUnlistedScript\(/);
  });

  // WXT builds unlisted scripts with `formats: ['iife']`, so there is no module graph to load.
  it('spawns a CLASSIC worker — an IIFE bundle cannot be loaded as a module', () => {
    const client = readFileSync(
      join(SRC, 'entrypoints/sidepanel/lib/image-encode-client.ts'),
      'utf8',
    );

    for (const args of workerConstructions(stripComments(client))) {
      expect(args).not.toMatch(/type\s*:\s*['"]module['"]/);
    }
    expect(client).toContain('chrome.runtime.getURL');
  });
});

// Only meaningful against a real build. Skipped on a clean checkout so the unit suite still runs
// without one; run after `wxt build` (the gate does) and these are the assertions that would have
// caught the shipped-but-inert worker.
const built = existsSync(BUILD);

describe.skipIf(!built)('encode worker — emitted bundle', () => {
  const emitted = (): string[] => walk(BUILD, (f) => extname(f) === '.js');

  it('emits the worker file at the path the client asks chrome for', () => {
    expect(existsSync(join(BUILD, IMAGE_WORKER_FILE))).toBe(true);
  });

  it('emits no Worker construction pointing at a source path', () => {
    const offenders = emitted().filter((file) =>
      workerConstructions(readFileSync(file, 'utf8')).some((args) => /\.tsx?\b/.test(args)),
    );

    expect(offenders).toEqual([]);
  });

  // The classic-worker choice depends on this: an unlisted script must come out self-contained.
  it('emits the worker as a self-contained script with no import/export', () => {
    const code = readFileSync(join(BUILD, IMAGE_WORKER_FILE), 'utf8');

    expect(code).not.toMatch(/^\s*import\s.*\sfrom\s/m);
    expect(code).not.toMatch(/^\s*export\s/m);
    // It is the encoder, not an empty shell.
    expect(code).toMatch(/createImageBitmap|convertToBlob/);
  });

  it('has the panel referencing the built worker by name', () => {
    const referenced = emitted().some((file) =>
      readFileSync(file, 'utf8').includes(IMAGE_WORKER_FILE),
    );

    expect(referenced).toBe(true);
  });
});
