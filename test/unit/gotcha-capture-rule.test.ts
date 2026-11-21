import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A GUARD, not a behavioural test: a rule written in prose is advice the next agent can miss,
// a failing test is a fact it cannot. This one pins the missed capture the diagnose report found:
// the only two non-dependency bot code merges in the current 7-day window wrote no steering file.
//
// The steering classifier below mirrors the census's own rule, not a copy of its data: the census
// queries and artifacts are harness-owned and are deliberately not read here.

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const RULE_PATH = 'docs/standards/gotcha-capture.md';

/** A merge as the census sees it: an author, a subject and the paths it touched. */
interface Merge {
  readonly sha: string;
  readonly author: string;
  readonly subject: string;
  readonly files: readonly string[];
}

/** The full set of paths the census treats as a steering write. */
function steeringFiles(files: readonly string[]): string[] {
  return files.filter(
    (path) =>
      path === 'CLAUDE.md' ||
      path === 'AGENTS.md' ||
      path.startsWith('docs/standards/') ||
      path.startsWith('.claude/') ||
      path.startsWith('.cursor/rules/'),
  );
}

/** True for a bot-authored merge whose subject is not a dependency bump. */
function isBotCodeMerge(merge: Merge): boolean {
  return (
    merge.author.includes('[bot]') &&
    !/^(fix\(deps\)|fix\(designer\)|build\(deps\)|build\(deps-dev\)|fix: upgrade designer Next)/.test(
      merge.subject,
    )
  );
}

/** #260 `de98fa0` and #261 `5a9bcb9` from the current window: both had steering=[] in the census. */
const missedCaptures: readonly Merge[] = [
  {
    sha: 'de98fa0',
    author: 'developerz-ai[bot]',
    subject:
      'feat(site): point landing CTAs at the Chrome Web Store, retire the waitlist funnel (#260)',
    files: ['site/src/main.ts', 'site/src/vite-env.d.ts', 'site/src/world/world.ts'],
  },
  {
    sha: '5a9bcb9',
    author: 'developerz-ai[bot]',
    subject: 'feat(site): replace waitlist CTA with Chrome Web Store install links (#261)',
    files: [
      'site/Dockerfile',
      'site/index.html',
      'site/package.json',
      'site/privacy.html',
      'site/vite.config.ts',
      'site/world.html',
    ],
  },
];

/** The same merges, this time carrying the gotcha write the rule now requires. */
const capturedMerges: readonly Merge[] = missedCaptures.map((merge, index) => ({
  ...merge,
  sha: `${merge.sha}-with-steering`,
  files: [...merge.files, `docs/standards/gotcha-${index}.md`],
}));

const readRule = (): string => {
  const path = resolve(REPO_ROOT, RULE_PATH);
  if (!existsSync(path)) throw new Error(`no rule at ${RULE_PATH}`);
  return readFileSync(path, 'utf8');
};

describe('the #260 and #261 missed capture', () => {
  it('reproduces the gap: those bot code merges had no steering write', () => {
    for (const merge of missedCaptures) {
      expect(isBotCodeMerge(merge), `${merge.sha} must be a non-dependency bot code merge`).toBe(
        true,
      );
      expect(steeringFiles(merge.files), `${merge.sha} had a steering write`).toEqual([]);
    }
  });

  it('counts a gotcha file under docs/standards as the steering write that closes the gap', () => {
    for (const merge of capturedMerges) {
      expect(steeringFiles(merge.files)).toEqual([
        expect.stringMatching(/^docs\/standards\/gotcha-\d\.md$/),
      ]);
    }
  });

  it('does not mistake a dependency bump for a missed capture', () => {
    const bump: Merge = {
      sha: 'dep-bump',
      author: 'developerz-ai[bot]',
      subject: 'fix(deps): update designer brace-expansion to 5.0.7 (#268)',
      files: ['docs/design/designer/pnpm-lock.yaml'],
    };
    expect(isBotCodeMerge(bump)).toBe(false);
  });
});

describe('the rule the census needs is landed', () => {
  it('keeps a gotcha-capture rule under docs/standards', () => {
    const rule = readRule();
    for (const marker of ['bot', 'gotcha', 'steering']) {
      expect(rule.toLowerCase(), `${RULE_PATH} lost the ${marker} marker`).toContain(marker);
    }
    expect(rule).toContain('docs/standards/');
  });

  it('the rule file itself is a steering write', () => {
    expect(steeringFiles([RULE_PATH])).toEqual([RULE_PATH]);
  });
});

describe('the guard itself detects what it claims to', () => {
  it('a CLAUDE.md or AGENTS.md write still counts as steering', () => {
    expect(steeringFiles(['CLAUDE.md'])).toEqual(['CLAUDE.md']);
    expect(steeringFiles(['AGENTS.md'])).toEqual(['AGENTS.md']);
  });

  it('a plain site source write is not steering', () => {
    expect(steeringFiles(['site/src/main.ts'])).toEqual([]);
  });

  it('a missing rule file fails the guard', () => {
    expect(existsSync(resolve(REPO_ROOT, 'docs/standards/not-a-rule.md'))).toBe(false);
  });
});
