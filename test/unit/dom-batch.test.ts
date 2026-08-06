import { describe, expect, it } from 'vitest';
import { createDomExecutor, type DomExecutor } from '@/dom/execute';
import { createMutator } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import { BATCH_MAX_OPS, BatchInput, type ContentToSw } from '@/shared/messages';

// #173 — `batch`: one tool call, many property-level mutations.
//
// The contract that matters is that a batch is a TRANSPORT optimization and nothing more: each op
// takes the same path it would have taken alone, so the guards still fire, the recorder still
// emits one edit per op, and undo granularity is per-op. The other half is the failure shape — a
// partially-applied batch must never read as success, and it must name which ops failed, because
// the applied ones are already live on the page and re-sending them is a double mutation.

function setup(html: string): { exec: DomExecutor['exec']; emitted: ContentToSw[] } {
  document.head.innerHTML = '';
  document.body.innerHTML = html;
  const emitted: ContentToSw[] = [];
  const recorder = createRecorder(
    (m) => emitted.push(m),
    () => 0,
  );
  const executor = createDomExecutor({ mutator: createMutator(document), recorder, doc: document });
  return { exec: executor.exec, emitted };
}

const PAGE = '<h1 id="hero">Old</h1><p class="sub">sub</p><a id="cta" href="#">Buy</a>';

describe('batch', () => {
  it('applies every op in one call and records one edit per op', () => {
    const { exec, emitted } = setup(PAGE);

    const result = exec({
      type: 'batch',
      ops: [
        { type: 'setStyle', selector: '#hero', props: { color: 'rgb(255, 0, 0)' } },
        { type: 'setText', selector: '#hero', value: 'New' },
        { type: 'addClass', selector: '.sub', name: 'lead' },
        { type: 'setAttr', selector: '#cta', name: 'title', value: 'Buy now' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ applied: 4, failed: 0 });
    expect(document.getElementById('hero')?.textContent).toBe('New');
    expect(document.querySelector('.sub')?.classList.contains('lead')).toBe(true);
    expect(document.getElementById('cta')?.getAttribute('title')).toBe('Buy now');

    // One recorder event per op — a batch must not collapse four changes into one undo step, or
    // the user's undo would revert work they never asked to undo. (`recorder-event` is the
    // content->SW message; `edit-recorded` is what the SW later streams to the panel.)
    const events = emitted.filter((m) => m.type === 'recorder-event');
    expect(events).toHaveLength(4);
  });

  it('reports failures by index, keeps the good ops applied, and is not ok', () => {
    const { exec } = setup(PAGE);

    const result = exec({
      type: 'batch',
      ops: [
        { type: 'setStyle', selector: '#hero', props: { color: 'rgb(0, 0, 255)' } },
        { type: 'setText', selector: '#nope', value: 'x' },
        { type: 'addClass', selector: '.sub', name: 'lead' },
      ],
    });

    // Partial application is NOT success — otherwise the model reads `ok` and moves on with two
    // of three changes silently missing.
    expect(result.ok).toBe(false);
    expect(result.error).toContain('#1');
    expect(result.error).toContain('2 of 3 applied');
    // The structured result rides along on the FAILURE too, carrying each op's own error. A
    // summary string alone cannot distinguish "selector matched nothing" (retry elsewhere) from
    // "refused by a guard" (never retry), and those need opposite next moves.
    const data = result.data as {
      applied: number;
      results: { index: number; ok: boolean; error?: string }[];
    };
    expect(data.applied).toBe(2);
    expect(data.results[1]).toMatchObject({ index: 1, ok: false });
    expect(data.results[1]?.error).toBeTruthy();
    expect(data.results[0]?.error).toBeUndefined();
    // …and the ops that did land stayed landed, which is why the error tells the model not to
    // re-send the whole batch.
    expect(document.querySelector('.sub')?.classList.contains('lead')).toBe(true);
  });

  it('still enforces the per-op guards it would enforce alone', () => {
    const { exec } = setup(PAGE);

    // `setAttr`'s security deny-list (on* / src / javascript:) is not something a batch may
    // launder — this is the whole reason each op re-enters `exec` rather than calling the
    // mutator directly.
    const result = exec({
      type: 'batch',
      ops: [{ type: 'setAttr', selector: '#cta', name: 'onclick', value: 'alert(1)' }],
    });

    expect(result.ok).toBe(false);
    expect(document.getElementById('cta')?.getAttribute('onclick')).toBeNull();
  });

  it('rejects a nested batch and an over-long one at the schema', () => {
    // Nesting buys nothing and would need a depth bound; structural ops shift the anchors the
    // later ops were written against. Both are refused before they reach the executor.
    expect(BatchInput.safeParse({ type: 'batch', ops: [{ type: 'batch', ops: [] }] }).success).toBe(
      false,
    );
    expect(
      BatchInput.safeParse({
        type: 'batch',
        ops: [{ type: 'removeNode', selector: '#hero' }],
      }).success,
    ).toBe(false);
    expect(BatchInput.safeParse({ type: 'batch', ops: [] }).success).toBe(false);

    const tooMany = Array.from({ length: BATCH_MAX_OPS + 1 }, () => ({
      type: 'addClass' as const,
      selector: '.sub',
      name: 'x',
    }));
    expect(BatchInput.safeParse({ type: 'batch', ops: tooMany }).success).toBe(false);
  });
});
