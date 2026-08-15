import { describe, expect, it } from 'vitest';
import {
  createEditShots,
  type EditShotsDeps,
  guardShots,
  MAX_CHANGESET_SHOT_CHARS,
  MAX_EDIT_SHOT_CHARS,
  RECORDED_MUTATION_TYPES,
  screenshotChars,
} from '@/agent/edit-shots';
import { emptyChangeset } from '@/shared/changeset';

// edit-shots unit (#148 item 1): the per-edit before/after auto-capture orchestration. Pins the
// arming rule (BEFORE only when the slot is free AND nothing unrecorded is buffered), the drain
// pair (slot consumed + AFTER captured, after-only when no before exists), the best-effort
// contract (a failing/rejecting capture NEVER throws out of beforeMutation/capturePair), and the
// size guard (per-image ceiling, whole-changeset budget, capture skipped entirely once the
// budget is spent). `screenshotChars` and `guardShots` are pinned directly as the pure halves.

const TAB = 7;

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function harness(opts: { bufferEmpty?: boolean; shots?: (string | undefined)[] } = {}) {
  const captured: number[] = [];
  const queue = [...(opts.shots ?? ['data:before', 'data:after'])];
  const deps: EditShotsDeps = {
    capture: (tabId) => {
      captured.push(tabId);
      return Promise.resolve(queue.shift());
    },
    bufferEmpty: () => opts.bufferEmpty ?? true,
  };
  return { captured, shots: createEditShots(deps) };
}

describe('createEditShots: arming the BEFORE slot', () => {
  it('captures once ahead of the first mutation and not again while the slot is held', async () => {
    const { captured, shots } = harness();
    await shots.beforeMutation(TAB);
    await shots.beforeMutation(TAB); // sibling mutation of the same unrecorded batch
    expect(captured).toEqual([TAB]);
  });

  it('does not arm while unrecorded mutations are already buffered (a "before" would lie)', async () => {
    const { captured, shots } = harness({ bufferEmpty: false });
    await shots.beforeMutation(TAB);
    expect(captured).toEqual([]);
  });

  it('shares one in-flight capture between concurrent same-step mutations', async () => {
    let resolve: ((v: string | undefined) => void) | undefined;
    const captured: number[] = [];
    const shots = createEditShots({
      capture: (tabId) => {
        captured.push(tabId);
        return new Promise((r) => {
          resolve = r;
        });
      },
      bufferEmpty: () => true,
    });
    const first = shots.beforeMutation(TAB);
    const second = shots.beforeMutation(TAB);
    resolve?.('data:before');
    await Promise.all([first, second]);
    expect(captured).toEqual([TAB]);
  });

  it('swallows a rejecting capture — the mutation must proceed', async () => {
    const shots = createEditShots({
      capture: () => Promise.reject(new Error('no page access')),
      bufferEmpty: () => true,
    });
    await expect(shots.beforeMutation(TAB)).resolves.toBeUndefined();
    // The rejected slot is consumed as "no before" and the pair degrades to after-only.
    const pair = await createEditShots({
      capture: () => Promise.resolve('data:after'),
      bufferEmpty: () => true,
    }).capturePair(TAB, 0);
    expect(pair).toEqual({ after: 'data:after' });
  });
});

describe('createEditShots: the drain pair', () => {
  it('pairs the armed before with a fresh after and consumes the slot', async () => {
    const { captured, shots } = harness({ shots: ['data:before', 'data:after', 'data:late'] });
    await shots.beforeMutation(TAB);
    const pair = await shots.capturePair(TAB, 0);
    expect(pair).toEqual({ before: 'data:before', after: 'data:after' });
    // Slot consumed: the next pair has no before (buffer empty ⇒ a NEW beforeMutation would
    // re-arm, but capturePair alone yields after-only).
    const next = await shots.capturePair(TAB, 0);
    expect(next).toEqual({ after: 'data:late' });
    expect(captured).toEqual([TAB, TAB, TAB]);
  });

  it('returns undefined when both captures fail — never a half-empty screenshots object', async () => {
    const shots = createEditShots({
      capture: () => Promise.resolve(undefined),
      bufferEmpty: () => true,
    });
    await shots.beforeMutation(TAB);
    await expect(shots.capturePair(TAB, 0)).resolves.toBeUndefined();
  });

  it('skips both capture rides once the changeset budget is spent', async () => {
    const { captured, shots } = harness();
    await shots.beforeMutation(TAB);
    const pair = await shots.capturePair(TAB, MAX_CHANGESET_SHOT_CHARS);
    expect(pair).toBeUndefined();
    expect(captured).toEqual([TAB]); // only the armed before ran; the after ride was skipped
  });

  it('clear() drops the slot so a dead document’s before never pairs', async () => {
    const { shots } = harness({ shots: ['data:stale', 'data:after'] });
    await shots.beforeMutation(TAB);
    shots.clear(TAB);
    const pair = await shots.capturePair(TAB, 0);
    expect(pair).toEqual({ after: 'data:after' });
  });
});

describe('guardShots: the size guard', () => {
  it('drops a side over the per-image ceiling and keeps the other', () => {
    const big = 'x'.repeat(MAX_EDIT_SHOT_CHARS + 1);
    expect(guardShots({ before: big, after: 'small' }, 0)).toEqual({ after: 'small' });
    expect(guardShots({ before: 'small', after: big }, 0)).toEqual({ before: 'small' });
    expect(guardShots({ before: big, after: big }, 0)).toBeUndefined();
  });

  it('drops the pair when it would push the changeset past its screenshot budget', () => {
    const half = 'x'.repeat(1_000);
    expect(guardShots({ before: half, after: half }, MAX_CHANGESET_SHOT_CHARS - 1_999)).toBe(
      undefined,
    );
    expect(guardShots({ before: half, after: half }, MAX_CHANGESET_SHOT_CHARS - 2_000)).toEqual({
      before: half,
      after: half,
    });
  });
});

describe('screenshotChars', () => {
  it('sums the before/after chars across every edit', () => {
    const changeset = {
      ...emptyChangeset('https://example.com/', '2026-08-15T00:00:00Z', SESSION_ID),
      edits: [
        {
          intent: 'one',
          selector: { value: '#a', strategy: 'id' as const, fragile: false },
          changes: [],
          attrs: [],
          classes: [],
          frameworkHints: [],
          screenshots: { before: 'xx', after: 'yyy' },
        },
        {
          intent: 'two',
          selector: { value: '#b', strategy: 'id' as const, fragile: false },
          changes: [],
          attrs: [],
          classes: [],
          frameworkHints: [],
          screenshots: { after: 'zzzz' },
        },
        {
          intent: 'bare',
          selector: { value: '#c', strategy: 'id' as const, fragile: false },
          changes: [],
          attrs: [],
          classes: [],
          frameworkHints: [],
        },
      ],
    };
    expect(screenshotChars(changeset)).toBe(9);
  });
});

describe('RECORDED_MUTATION_TYPES', () => {
  it('covers the recorder-emitting mutations and none of the reads', () => {
    for (const type of ['setStyle', 'removeAttr', 'batch', 'bulkStructural', 'wrapNode']) {
      expect(RECORDED_MUTATION_TYPES.has(type), type).toBe(true);
    }
    for (const type of ['query', 'getStyles', 'screenshot', 'injectCss', 'describe', 'undo']) {
      expect(RECORDED_MUTATION_TYPES.has(type), type).toBe(false);
    }
  });
});
