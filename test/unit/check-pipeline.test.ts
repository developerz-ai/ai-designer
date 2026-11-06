import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Resolve directly from `import.meta.url` (a `file:` URL) rather than
// `new URL('.', import.meta.url)` — under Vitest's jsdom env the relative-URL
// constructor rewrites the `file:` base to `http://localhost:3000/...`, so
// fileURLToPath would throw "The URL must be of scheme file".
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

/** Read a repo-relative file as text — every input here is text, never executed. */
function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

/**
 * The one classification the gate can have. A ci.yml job is either MIRRORED — run locally by
 * `bin/check` → `bun run verify` → `scripts/verify.sh` — or CI-ONLY, in which case the gate
 * must still report it. A job in neither list is a rename the gate would silently drop.
 */
const MIRRORED_JOBS: readonly string[] = ['Lint', 'Typecheck', 'Test (unit + integration)'];
const CI_ONLY_JOBS: readonly string[] = ['Build extension', 'Test (e2e)', 'actionlint'];

interface CiJob {
  /** The `jobs:` key (`lint`, `test-e2e`) — what `needs:` refers to. */
  readonly id: string;
  /** The `name:` a human sees in the checks list. */
  readonly name: string;
  /** Every single-line `run:` command, in file order. */
  readonly runs: string[];
}

/**
 * Jobs of `.github/workflows/ci.yml`, parsed as text: 2-space `id:` under `jobs:`, 4-space
 * `name:`, `run:` at step-body indent. Module-local (Biome's `noExportsInTest` forbids
 * exports from a test file) and pure, so every drift case below is pinnable on a fixture.
 *
 * Fails closed on `run: |` blocks: silently skipping one would turn this guard into a shape
 * check that passes while a real CI step goes unmirrored.
 */
function parseCiWorkflow(workflow: string): CiJob[] {
  const jobs: CiJob[] = [];
  let jobId: string | null = null;
  let name: string | null = null;
  let runs: string[] = [];
  let withinJobs = false;
  const flush = (): void => {
    if (jobId !== null) jobs.push({ id: jobId, name: name ?? jobId, runs });
    jobId = null;
    name = null;
    runs = [];
  };
  for (const line of workflow.split('\n')) {
    if (/^jobs:\s*$/.test(line)) {
      withinJobs = true;
      continue;
    }
    if (!withinJobs) continue;
    // Columns 0-1 are the workflow root or the top-level primer above the jobs block.
    if (/^[^\s]/.test(line)) {
      flush();
      withinJobs = false;
      continue;
    }
    const foundId = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
    if (foundId !== undefined) {
      flush();
      jobId = foundId;
      continue;
    }
    if (jobId === null) continue;
    if (/^\s*-\s*run:\s*[|>]/.test(line)) {
      throw new Error(`ci.yml has a multi-line \`run:\` block this parser cannot mirror: ${line}`);
    }
    const foundName = /^ {4}name:\s*(.+?)\s*$/.exec(line)?.[1];
    if (foundName !== undefined) {
      name = foundName;
      continue;
    }
    // Both step shapes ci.yml uses: `- run: <cmd>` and `- name: …` + `run: <cmd>`.
    const foundRun = /^ {6,}(?:-\s*)?run:\s*(.+?)\s*$/.exec(line)?.[1];
    if (foundRun !== undefined) runs.push(foundRun);
  }
  flush();
  return jobs;
}

/**
 * A shell script's EXECUTED lines: full-line comments dropped, heredoc bodies dropped. Prose
 * that names a command (the header comment, the coverage table) must never satisfy the mirror,
 * or the guard would check what the gate says rather than what it runs.
 */
function commandText(shell: string): string {
  const kept: string[] = [];
  let heredoc: string | null = null;
  for (const line of shell.split('\n')) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    const marker = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/.exec(line)?.[1];
    if (marker !== undefined) {
      heredoc = marker;
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** The `<script>` of every `bun run <script>` in a chunk of shell or yaml, in order. */
function bunScripts(text: string): string[] {
  return [...text.matchAll(/\bbun run ([A-Za-z0-9:_.-]+)/g)].map((match) => match[1] ?? '');
}

/**
 * The BODY of bin/check's `cat <<'TABLE'` heredoc — the coverage map itself. The whole file will
 * not do: bin/check:14-24 names the same six jobs in prose, so `toContain(name)` on the file passes
 * with the table deleted, flipped to `merged` or missing its route. Empty when there is no heredoc.
 */
function coverageTable(shell: string): string[] {
  const lines = shell.split('\n');
  const heredoc = /^cat <<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?\s*$/;
  const start = lines.findIndex((line) => heredoc.test(line));
  if (start === -1) return [];
  const marker = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(lines[start] ?? '')?.[1];
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === marker) break;
    rows.push(line);
  }
  return rows;
}

interface TableRow {
  /** `merged` (run by this gate) or `ci-only` (reported, run by CI). */
  readonly mark: string;
  /** The ci.yml `jobs:` key. */
  readonly id: string;
  /** The ci.yml `name:` a human sees in the checks list. */
  readonly name: string;
  /** The first column of the arrow — what the row claims runs the job. */
  readonly route: string;
}

/**
 * Coverage rows, split on the table's own 2+-space columns: `mark  id  name  route -> detail`.
 * The arrow is padded to align the detail column, so the tail is split on whitespace around it.
 * Restricted to `knownIds` — the `jobs:` keys of the workflow — which is what separates a row from
 * the `merged = … ci-only = …` legend line underneath the table.
 */
function tableRows(table: readonly string[], knownIds: readonly string[]): TableRow[] {
  const rows: TableRow[] = [];
  for (const line of table) {
    const found = /^ {2}(\S+) +(\S+) +(.+?) {2,}(.+)$/.exec(line);
    if (found === null) continue;
    const [, mark = '', id = '', name = '', rest = ''] = found;
    if (!knownIds.includes(id)) continue;
    rows.push({ mark, id, name, route: rest.split(/\s+->\s+/)[0]?.trim() ?? '' });
  }
  return rows;
}

/**
 * Failure branches that lose the failing step's own exit code. bin/check:70 prints
 * `✗ gate FAILED (exit %s)`, so the number a reader sees has to be the step's, not a stand-in:
 *
 *  - `exit 1` collapses every failure to one number;
 *  - `exit $?` written AFTER the banner exits 0 — printf's own status — reporting red as green;
 *  - a `status=$?` written BELOW the banner captures that same 0.
 *
 * So every `✗ … failed` line needs a capture above it and `exit "$status"` as its next statement.
 * Empty when each branch keeps the status it captured.
 */
function exitPropagationGaps(shell: string): string[] {
  const gaps: string[] = [];
  const lines = shell.split('\n').map((line) => line.trim());
  for (const [index, line] of lines.entries()) {
    if (!line.includes('✗') || !line.includes('failed')) continue;
    // The capture sits ABOVE the banner: printf overwrites `$?` with its own 0.
    if (!lines.slice(0, index).some((seen) => /\bstatus=\$\?/.test(seen))) {
      gaps.push(`line ${index + 1}: banner prints before any \`status=$?\` captured its code`);
    }
    const next = lines.slice(index + 1).find((candidate) => candidate !== '');
    if (next !== 'exit "$status"') {
      gaps.push(
        `line ${index + 1}: the branch exits \`${next ?? 'nothing'}\`, not the captured status`,
      );
    }
  }
  return gaps;
}

/** The route each CI-only job's row must name — CI owns it, the gate reports it. */
const CI_ONLY_ROUTES: Readonly<Record<string, string>> = {
  'Build extension': 'bun run gate',
  'Test (e2e)': 'bun run gate',
  actionlint: 'probed below',
};

/** Coverage rows that misclassify or misroute a job — empty when the table matches the workflow. */
function coverageGaps(rows: readonly TableRow[]): string[] {
  const gaps: string[] = [];
  const expectRow = (name: string, mark: string, route: string): void => {
    const row = rows.find((candidate) => candidate.name === name);
    if (row?.mark !== mark) {
      gaps.push(`${name}: coverage table marks it \`${row?.mark ?? 'nowhere'}\`, not \`${mark}\``);
    } else if (row.route !== route) {
      gaps.push(`${name}: coverage table routes it \`${row.route}\`, not \`${route}\``);
    }
  };
  for (const name of MIRRORED_JOBS) expectRow(name, 'merged', 'bun run verify');
  for (const name of CI_ONLY_JOBS) {
    expectRow(name, 'ci-only', CI_ONLY_ROUTES[name] ?? 'no route declared for this job');
  }
  return gaps;
}

/** CI steps a mirrored job runs that the local gate never executes — empty when in sync. */
function mirrorGaps(jobs: readonly CiJob[], executed: readonly string[]): string[] {
  const gaps: string[] = [];
  for (const job of jobs) {
    if (!MIRRORED_JOBS.includes(job.name)) continue;
    const scripts = job.runs.flatMap(bunScripts);
    if (scripts.length === 0) gaps.push(`${job.name}: no \`run:\` step left to mirror`);
    for (const script of scripts) {
      if (!executed.includes(script)) gaps.push(`${job.name}: \`bun run ${script}\` is unmirrored`);
    }
  }
  return gaps;
}

const ciYaml = read('.github/workflows/ci.yml');
const binCheck = read('bin/check');
const verifySh = read('scripts/verify.sh');

/** Only the lines the two scripts actually run — not what their comments claim. */
const binCheckCommands = commandText(binCheck);
const verifyCommands = commandText(verifySh);

describe('bin/check mirrors the ci.yml validation jobs', () => {
  const jobs = parseCiWorkflow(ciYaml);

  it('sees exactly the six jobs ci.yml defines, each classified once', () => {
    expect(jobs.map((job) => job.name).sort()).toEqual([...MIRRORED_JOBS, ...CI_ONLY_JOBS].sort());
    expect(new Set(jobs.map((job) => job.id)).size).toBe(jobs.length);
  });

  it('runs every step of the mirrored jobs locally', () => {
    const executed = [...bunScripts(verifyCommands), ...bunScripts(binCheckCommands)];
    expect(mirrorGaps(jobs, executed)).toEqual([]);
  });

  it('keeps bin/check an alias for `bun run verify` — the documented gate', () => {
    // .dz/maintainer/reviewer.md:10: "The gate is `bin/check` (`bun run verify`)".
    expect(bunScripts(binCheckCommands)).toEqual(['verify']);
    expect(binCheckCommands).toContain('if bun run verify; then');
    // `set -e` must not swallow the status: only the advice path or verify's status may exit.
    const exits = binCheckCommands
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^exit\s/.test(line));
    expect(exits).toEqual(['exit 0', 'exit "$status"']);
  });

  it('prepares WXT types before typecheck, as ci.yml does', () => {
    expect(jobs.find((job) => job.name === 'Typecheck')?.runs).toEqual([
      'bun run postinstall',
      'bun run typecheck',
    ]);
    const prepare = verifyCommands.indexOf('bun run postinstall');
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeLessThan(verifyCommands.indexOf('bun run typecheck'));
  });

  it('names the step that failed instead of listing every candidate', () => {
    // A red gate once reported `✗ lint/typecheck failed` as a *candidate* while the only failure
    // was one vitest spec, sending the reader after the wrong step. Each step now banners itself
    // where it fails, and the verdict accuses nobody.
    expect(verifyCommands).toContain('✗ lint/typecheck failed');
    expect(verifyCommands).toContain('✗ tests failed');
    // Every step banners itself — including postinstall, whose bare `set -e` abort used to print no
    // ✗ at all while bin/check pointed the reader at "the ✗ line scripts/verify.sh printed".
    expect(verifyCommands).toContain('✗ wxt prepare (postinstall) failed');
    expect(binCheckCommands).not.toContain('lint/typecheck failed');
  });

  it("propagates the failing step's own exit code to `gate FAILED (exit %s)`", () => {
    // The three banners used to exit 1 for every failure — bin/check:70 then printed `exit 1` no
    // matter what the step returned, so no code was ever distinguishable. Each branch now exits the
    // status it captured BEFORE the banner overwrote `$?` with printf's 0.
    expect(exitPropagationGaps(verifyCommands)).toEqual([]);
    expect(verifyCommands).not.toMatch(/^\s*exit 1$/m);
    expect(verifyCommands).not.toMatch(/^\s*exit \$\?$/m);
  });

  it('fails when a banner exits `$?` after printf, or collapses to 1', () => {
    // The exact shape the finding suggested — `printf` … then `exit $?` — would exit 0 and report
    // a red gate as clean, so the guard has to reject it, not accept it.
    const afterPrintf = verifySh.replace(
      /status=\$\?\n(\s*)printf([^\n]*✗[^\n]*)\n\s*exit "\$status"/,
      '$1printf$2\n  exit $?',
    );
    expect(afterPrintf).not.toBe(verifySh);
    expect(exitPropagationGaps(commandText(afterPrintf)).join('\n')).toMatch(
      /not the captured status/,
    );
    const collapsed = verifySh.replace(/exit "\$status"/, 'exit 1');
    expect(collapsed).not.toBe(verifySh);
    expect(exitPropagationGaps(commandText(collapsed)).join('\n')).toMatch(
      /not the captured status/,
    );
    // And dropping the capture above a banner is caught too — the banner would print a stale code.
    const noCapture = verifySh.replace(/^\s*status=\$\?\n(?=\s*printf[^\n]*✗)/m, '');
    expect(noCapture).not.toBe(verifySh);
    expect(exitPropagationGaps(commandText(noCapture)).join('\n')).toMatch(
      /before any `status=\$\?`/,
    );
  });

  it('probes actionlint instead of aborting when it is absent', () => {
    expect(binCheckCommands).toContain('command -v actionlint');
  });

  it('names all six jobs in its coverage table, classified and routed', () => {
    const rows = tableRows(
      coverageTable(binCheck),
      jobs.map((job) => job.id),
    );
    // Exactly the six jobs, in workflow order — a row added or dropped is drift, not coverage.
    expect(rows.map((row) => row.name)).toEqual([...MIRRORED_JOBS, ...CI_ONLY_JOBS]);
    // One row per `jobs:` key, so a renamed job cannot sit in the table under its old id.
    expect(rows.map((row) => row.id)).toEqual(jobs.map((job) => job.id));
    expect(coverageGaps(rows)).toEqual([]);
    // Spelled out, so the pin does not inherit a mistake from the constants above.
    const marks = Object.fromEntries(rows.map((row) => [row.name, row.mark]));
    const routes = Object.fromEntries(rows.map((row) => [row.name, row.route]));
    expect(marks['Test (unit + integration)']).toBe('merged');
    expect(routes['Test (unit + integration)']).toBe('bun run verify');
    expect(marks['Build extension']).toBe('ci-only');
    expect(routes['Build extension']).toBe('bun run gate');
    expect(marks.actionlint).toBe('ci-only');
    expect(routes.actionlint).toBe('probed below');
  });

  it('fails when a coverage row is stripped or its class is flipped', () => {
    const ids = parseCiWorkflow(ciYaml).map((job) => job.id);
    // The header comment names these jobs too, so only the heredoc body is evidence.
    const stripped = binCheck.replace(/^ {2}ci-only {2}actionlint.*\n/m, '');
    expect(stripped).not.toBe(binCheck);
    expect(coverageGaps(tableRows(coverageTable(stripped), ids))).toContain(
      'actionlint: coverage table marks it `nowhere`, not `ci-only`',
    );
    const flipped = binCheck.replace(/^ {2}merged( {2,})test {2,}/m, '  ci-only$1test  ');
    expect(flipped).not.toBe(binCheck);
    expect(coverageGaps(tableRows(coverageTable(flipped), ids))).toContain(
      'Test (unit + integration): coverage table marks it `ci-only`, not `merged`',
    );
    // The exact unpinned case: relabelling a CI-only job `merged` claims the gate runs it.
    const relabelled = binCheck.replace(/^ {2}ci-only {2,}actionlint/m, '  merged   actionlint');
    expect(relabelled).not.toBe(binCheck);
    expect(coverageGaps(tableRows(coverageTable(relabelled), ids))).toContain(
      'actionlint: coverage table marks it `merged`, not `ci-only`',
    );
    const detabled = binCheck.replace(/^cat <<'TABLE'[\s\S]*?^TABLE\n/m, '');
    expect(detabled).not.toBe(binCheck);
    expect(coverageGaps(tableRows(coverageTable(detabled), ids))).toContain(
      'Lint: coverage table marks it `nowhere`, not `merged`',
    );
  });
});

describe('the mirror cannot go stale or vacuous', () => {
  const sample = [
    'jobs:',
    '  lint:',
    '    name: Lint',
    '    steps:',
    '      - uses: actions/checkout@v7.0.1',
    '      - name: Biome',
    '        run: bun run lint',
    '  test:',
    '    name: Test (unit + integration)',
    '    steps:',
    '      - name: Unit + integration tests',
    '        run: bun run test',
  ].join('\n');

  it('parses ids, names and run steps out of a workflow', () => {
    expect(parseCiWorkflow(sample)).toEqual([
      { id: 'lint', name: 'Lint', runs: ['bun run lint'] },
      { id: 'test', name: 'Test (unit + integration)', runs: ['bun run test'] },
    ]);
  });

  it('flags a CI step the gate does not run', () => {
    expect(mirrorGaps(parseCiWorkflow(sample), ['lint'])).toContain(
      'Test (unit + integration): `bun run test` is unmirrored',
    );
  });

  it('fails closed on a multi-line run block instead of skipping it', () => {
    const block = ['jobs:', '  lint:', '    steps:', '      - run: |', '          echo hi'].join(
      '\n',
    );
    expect(() => parseCiWorkflow(block)).toThrow(/multi-line/);
  });

  it('reads executed commands only, never comments or heredoc data', () => {
    const shell = [
      '# bun run lint is what CI runs',
      "cat <<'TABLE'",
      '  lint  bun run test',
      'TABLE',
      'bun run postinstall',
      'bun run typecheck',
    ].join('\n');
    expect(bunScripts(commandText(shell))).toEqual(['postinstall', 'typecheck']);
  });

  it('fails when a real step disappears from the gate', () => {
    const mutated = verifySh.replace(/^if bun run postinstall; then$/m, 'if true; then');
    expect(mutated).not.toBe(verifySh);
    const gaps = mirrorGaps(parseCiWorkflow(ciYaml), bunScripts(commandText(mutated)));
    expect(gaps).toContain('Typecheck: `bun run postinstall` is unmirrored');
  });

  it('fails when a ci.yml step is added to a mirrored job', () => {
    const mutated = ciYaml.replace(
      '        run: bun run lint',
      '        run: bun run lint\n      - name: Docs\n        run: bun run docs:check',
    );
    expect(mutated).not.toBe(ciYaml);
    const gaps = mirrorGaps(parseCiWorkflow(mutated), bunScripts(verifyCommands));
    expect(gaps).toContain('Lint: `bun run docs:check` is unmirrored');
  });

  it('fails when a job is renamed into neither class', () => {
    const mutated = ciYaml.replace('    name: Test (unit + integration)', '    name: Unit tests');
    expect(mutated).not.toBe(ciYaml);
    // The same comparison the real assertion makes, so a rename cannot pass it.
    const names = parseCiWorkflow(mutated).map((job) => job.name);
    expect(names.sort()).not.toEqual([...MIRRORED_JOBS, ...CI_ONLY_JOBS].sort());
    expect(names).toContain('Unit tests');
  });
});

describe('docs/RELEASING.md states the CI gate it really has', () => {
  const releasing = read('docs/RELEASING.md');

  it('lists the six job names ci.yml defines', () => {
    for (const name of [...MIRRORED_JOBS, ...CI_ONLY_JOBS]) expect(releasing).toContain(name);
  });

  it('documents the local mirror and the CI-only remainder', () => {
    expect(releasing).toContain('bin/check');
    expect(releasing).toContain('CI-only');
  });

  it('never claims the gate runs `bun run verify` and nothing else', () => {
    // That strong claim contradicted the actionlint bullet two lines below it inside the same
    // subsection: the gate also probes actionlint and reports it. A reader who believes the
    // absolute version assumes the gate executes nothing beyond verify.
    const start = releasing.indexOf('### Locally: `./bin/check`');
    expect(start).toBeGreaterThan(-1);
    const subsection = releasing.slice(start).split(/\n## /)[0] ?? '';
    // The section must still send the reader to the probe, or the assertion below goes vacuous.
    expect(subsection).toContain('actionlint');
    expect(subsection).not.toMatch(/nothing else/);
  });

  it('makes no claim about the split test jobs CI does not have', () => {
    expect(releasing).not.toMatch(/\btest-unit\b|\btest-integration\b/);
  });
});
