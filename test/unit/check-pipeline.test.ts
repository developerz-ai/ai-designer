import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Repo files resolve from `import.meta.url` (house convention, see
// test/unit/manifest-invariant.test.ts), never from the cwd - the suite must
// read the same files no matter where Vitest was started.
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const checkScript = resolve(repoRoot, 'bin/check');
const fixtures: string[] = [];
const gates = ['verify', 'release', 'test:e2e', 'actionlint'];
const scripts = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).scripts;
const ciWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');

function ciRunCommands(workflow: string): string[] {
  return [...workflow.matchAll(/^[ \t]+(?:- )?run:[ \t]*(.*)$/gm)].map((match) => {
    const command = (match[1] ?? '').trim();
    if (!command || /^[|>]/.test(command)) {
      throw new Error('Unsupported multiline CI run declaration: use inline run commands');
    }
    return command;
  });
}

function ciJobIds(workflow: string): string[] {
  const jobs = workflow.slice(workflow.indexOf('\njobs:'));
  return [...jobs.matchAll(/^ {2}([A-Za-z][\w-]*):$/gm)]
    .map((match) => match[1] ?? '')
    .filter((id) => id !== '');
}

function coverageRows(stdout: string) {
  const rows = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const match = /^ {2}([A-Za-z][\w-]*)\s+(RAN|NOT RUN)\b/.exec(line);
    const job = match?.[1];
    const status = match?.[2];
    if (job && status) rows.set(job, status);
  }
  return rows;
}

// bash keeps a LOGICAL PWD: symlinks stay unresolved and `..` is popped
// textually, so a logged directory is canonicalised before it is compared with
// the fixture root (on macOS the tmpdir is /var/folders -> /private/var).
function canonical(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

function executable(name: string) {
  const path = process.env.PATH ?? '';
  for (const directory of path.split(delimiter)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`Test prerequisite missing from PATH: ${name}`);
}

function fixture({ actionlint = true, rootActionlint = '', realVerify = false } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'check-pipeline-'));
  fixtures.push(temporary);
  const root = join(temporary, 'repository with spaces');
  const tools = join(temporary, 'tools with spaces');
  const outside = join(temporary, 'outside repository');
  const log = join(temporary, 'commands.log');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(tools);
  mkdirSync(outside);
  copyFileSync(checkScript, join(root, 'bin/check'));
  // The repository root sentinel bin/check validates a path-less $0 against.
  writeFileSync(join(root, 'package.json'), '{}\n');
  if (realVerify) {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(resolve(repoRoot, 'scripts/verify.sh'), join(root, 'scripts/verify.sh'));
  }

  // Isolate PATH: host Bun/actionlint must never escape these doubles.
  for (const name of ['bash', 'dirname', 'mktemp', 'rm', 'cat']) {
    symlinkSync(executable(name), join(tools, name));
  }
  function double(path: string, name: string, mode = 0o755) {
    writeFileSync(
      path,
      `#!/usr/bin/env bash
set -eu
printf '%s\\t%s\\t%s\\n' '${name}' "$PWD" "$*" >> "$CHECK_LOG"
if [[ '${name}' == bun ]]; then
  [[ "$#" == 2 && "$1" == run ]] || exit 91
  case "$2" in verify|release|test:e2e|lint|typecheck|test) ;; *) exit 92 ;; esac
  gate="$2"
  if [[ "$gate" == verify && "$CHECK_REAL_VERIFY" == 1 ]]; then
    exec bash -c "$CHECK_VERIFY_SCRIPT"
  fi
else
  gate=actionlint
fi
if [[ "$gate" == "$CHECK_FAIL" ]]; then exit 43; fi
`,
      { mode },
    );
  }
  double(join(tools, 'bun'), 'bun');
  if (actionlint) double(join(tools, 'actionlint'), 'actionlint');
  if (rootActionlint) {
    double(
      join(root, 'actionlint'),
      'root-actionlint',
      rootActionlint === 'executable' ? 0o755 : 0o644,
    );
  }

  return {
    root,
    outside,
    tools,
    expected(rootLint = false, actionlintPresent = true) {
      return gates
        .filter((gate) => actionlintPresent || gate !== 'actionlint')
        .map((gate) => ({
          command: gate === 'actionlint' ? (rootLint ? 'root-actionlint' : 'actionlint') : 'bun',
          directory: canonical(root),
          args: gate === 'actionlint' ? '-color' : `run ${gate}`,
        }));
    },
    run(cwd = root, fail = '', options: { args?: string[]; path?: string } = {}) {
      const result = spawnSync(join(tools, 'bash'), options.args ?? [join(root, 'bin/check')], {
        cwd,
        env: {
          ...process.env,
          PATH: options.path ?? tools,
          CHECK_LOG: log,
          CHECK_FAIL: fail,
          CHECK_REAL_VERIFY: realVerify ? '1' : '0',
          CHECK_VERIFY_SCRIPT: scripts.verify,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      const calls = existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((line) => {
              const [command = '', directory = '', args = ''] = line.split('\t');
              return { command, directory: canonical(directory), args };
            })
        : [];
      return { ...result, calls };
    },
  };
}

afterEach(() => {
  for (const path of fixtures.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe('bin/check CI gate coverage', () => {
  it.each(['|', '>', '|-', '>-', '|+', '>+', '|2', '>2-', ''])(
    'rejects unsupported multiline CI run declarations (%s)',
    (indicator) => {
      const workflow = `steps:\n  - name: Validate\n    run: ${indicator}\n      bun run lint\n`;
      expect(() => ciRunCommands(workflow)).toThrow('Unsupported multiline CI run declaration');
    },
  );

  it('covers actual extension CI validation commands, including the independent E2E build', () => {
    const workflow = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8');
    // Provisioning is external to bin/check; do not exclude new validation commands by name.
    const setupCommands = [
      'bun run postinstall',
      `echo "version=$(bunx playwright --version | awk '{print $NF}')" >> "$GITHUB_OUTPUT"`,
      'bunx playwright install --with-deps chromium',
      'bash <(curl -fsSL https://raw.githubusercontent.com/rhysd/actionlint/v1.7.12/scripts/download-actionlint.bash) 1.7.12',
    ];
    const ciCommands = ciRunCommands(workflow);
    for (const command of setupCommands) expect(ciCommands).toContain(command);
    const validationCommands = ciCommands.filter((command) => !setupCommands.includes(command));
    const project = fixture({ realVerify: true, rootActionlint: 'executable' });
    const result = project.run();

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const localCommands = result.calls
      .filter((call) => call.args !== 'run verify')
      .map((call) =>
        call.command === 'root-actionlint' ? `./actionlint ${call.args}` : `bun ${call.args}`,
      );
    // release delegates to build + zip locally and in CI. CI also calls build directly for E2E.
    const expandRelease = (commands: string[]) =>
      commands.flatMap((command) =>
        command === 'bun run release' ? [command, ...scripts.release.split(' && ')] : [command],
      );
    expect([...new Set(expandRelease(localCommands))].sort()).toEqual(
      [...new Set(expandRelease(validationCommands))].sort(),
    );
  });

  it('runs every gate in exact order with exact arguments through PATH doubles', () => {
    const project = fixture();
    const result = project.run();

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(project.expected());
  });

  it('resolves the repository root from outside, with spaces in repository and tool paths', () => {
    const project = fixture();
    const result = project.run(project.outside);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(project.expected());
  });

  it('resolves the repository root when $0 carries no path (script found through PATH)', () => {
    const project = fixture();
    // bash runs "./check" from the current directory, so $0 has no slash: the
    // script must be resolved through PATH, never guessed from the cwd - the
    // cwd's parent is not the repository root.
    copyFileSync(checkScript, join(project.outside, 'check'));
    const result = project.run(project.outside, '', {
      args: ['check'],
      path: `${project.tools}:${join(project.root, 'bin')}`,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(project.expected());
  });

  it('fails loudly instead of running the gates in the wrong tree when $0 cannot be resolved', () => {
    const project = fixture();
    copyFileSync(checkScript, join(project.outside, 'check'));
    // Without the repository's bin/ on PATH there is no way to locate the
    // repository root, so the gate must refuse to run and name the invocation
    // it needs - running it from the cwd's parent would lint the wrong tree.
    const result = project.run(project.outside, '', { args: ['check'] });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
    expect(result.stderr).toContain('./bin/check');
  });

  it('prefers an executable repo-root actionlint over PATH', () => {
    const project = fixture({ rootActionlint: 'executable' });
    const result = project.run(project.outside);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(project.expected(true));
  });

  it('falls back to PATH when repo-root actionlint is not executable', () => {
    const project = fixture({ rootActionlint: 'non-executable' });
    const result = project.run();

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual(project.expected());
  });

  it.each(gates)('propagates the exact %s failure without any later commands', (gate) => {
    const project = fixture();
    const result = project.run(project.root, gate);

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(43);
    expect(result.calls).toEqual(project.expected().slice(0, gates.indexOf(gate) + 1));
    // The coverage summary is printed only after every gate passed.
    expect(result.stdout).not.toContain('CI job coverage');
  });

  it.each(['', 'non-executable'])(
    'warns on stderr and still runs the other gates when actionlint is missing (%s root)',
    (rootActionlint) => {
      const project = fixture({ actionlint: false, rootActionlint });
      const result = project.run(project.outside);

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      // A missing actionlint must not abort the gate: the other gates still ran, in order.
      expect(result.calls).toEqual(project.expected(false, false));
      // The warning names the mirrored CI job, the pinned version and the release URL.
      expect(result.stderr).toContain('NOT RUN');
      expect(result.stderr).toContain('actionlint');
      expect(result.stderr).toContain('1.7.12');
      expect(result.stderr).toContain('https://github.com/rhysd/actionlint/releases/tag/v1.7.12');
      // The coverage summary reports the skipped job as NOT RUN and the rest as RAN.
      const rows = coverageRows(result.stdout);
      expect(rows.get('actionlint')).toBe('NOT RUN');
      for (const job of ciJobIds(ciWorkflow)) {
        if (job !== 'actionlint') expect(rows.get(job)).toBe('RAN');
      }
    },
  );

  it('reports the missing-actionlint warning before running the gates', () => {
    const project = fixture({ actionlint: false });
    const result = project.run(project.root, 'verify');

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(43);
    expect(result.stderr).toContain('NOT RUN');
    expect(result.calls).toEqual([project.expected(false, false)[0]]);
  });

  it('summarises every ci.yml job with its local run status', () => {
    const project = fixture();
    const result = project.run();

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const rows = coverageRows(result.stdout);
    expect([...rows.keys()].sort()).toEqual([...ciJobIds(ciWorkflow)].sort());
    for (const job of ciJobIds(ciWorkflow)) expect(rows.get(job)).toBe('RAN');
  });

  it('resolves actionlint only from the repo root or PATH, and installs nothing', () => {
    const source = readFileSync(checkScript, 'utf8');
    expect(source).toContain('./actionlint');
    expect(source).toContain('command -v actionlint');
    expect(source).not.toMatch(
      /\b(curl|wget|npm\s+install|pnpm\s+add|bun\s+add|yarn\s+add|pip\s+install|apt-get|brew\s+install)\b/,
    );
  });

  it('delegates to actual verify lint/typecheck/tests and release build packaging scripts', () => {
    expect(scripts.release).toBe('bun run build && wxt zip');
    expect(scripts.lint).toBe('biome check .');
    expect(scripts.typecheck).toBe('tsgo --noEmit');
    expect(scripts.test).toBe('vitest run');
    expect(scripts['test:e2e']).toBe('playwright test');
    const project = fixture({ realVerify: true });
    const result = project.run(project.outside);

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const expected = project.expected();
    expect(result.calls[0]).toEqual(expected[0]);
    // These two gates run concurrently; neither may be omitted or deferred past tests.
    expect(result.calls.slice(1, 3).sort((a, b) => a.args.localeCompare(b.args))).toEqual(
      ['lint', 'typecheck'].map((gate) => ({ ...expected[0], args: `run ${gate}` })),
    );
    expect(result.calls.slice(3)).toEqual([
      { ...expected[0], args: 'run test' },
      ...expected.slice(1),
    ]);
  });

  it.each(['lint', 'typecheck', 'test'])(
    'stops the actual verify pipeline when %s fails',
    (gate) => {
      const project = fixture({ realVerify: true });
      const result = project.run(project.root, gate);

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(gate === 'test' ? 43 : 1);
      const args = result.calls.map((call) => call.args);
      expect(args[0]).toBe('run verify');
      expect(args.slice(1, 3).sort()).toEqual(['run lint', 'run typecheck']);
      expect(args.slice(3)).toEqual(gate === 'test' ? ['run test'] : []);
    },
  );
});
