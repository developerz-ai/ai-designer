import { beforeEach, describe, expect, it } from 'vitest';
import { createDomExecutor } from '@/dom/execute';
import { createMutator } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import { MAX_BULK_TARGETS } from '@/dom/structural-bulk';
import type {
  BulkStructuralResult,
  ContentToSw,
  MutationEvent,
  ToolResult,
} from '@/shared/messages';

// The executor seam for #184: one `bulkStructural` bus message becomes N page changes and N
// SEPARATE changeset entries, each of the kind it actually is. The bulk module's own invariants
// (resolve-once, nested-target skip, the cap) are covered in structural-restructure.test.ts;
// what this file asserts is the WIRING — that the executor preserves them and that the durable
// record is indistinguishable from N single-target calls.

function harness() {
  const events: MutationEvent[] = [];
  const emit = (msg: ContentToSw): void => {
    if (msg.type === 'recorder-event') events.push(msg.event);
  };
  const mutator = createMutator(document);
  const recorder = createRecorder(emit, () => 1_000);
  return { exec: createDomExecutor({ mutator, recorder, emit, doc: document }), events };
}

const data = (r: ToolResult): BulkStructuralResult => r.data as BulkStructuralResult;

describe('bulkStructural remove', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<main><div class="spacer" id="s1"></div><p id="k">keep</p>' +
      '<div class="spacer" id="s2"></div><div class="spacer" id="s3"></div></main>';
  });

  it('removes every match in one call and records one edit PER ELEMENT', () => {
    const h = harness();
    const res = h.exec.exec({
      type: 'bulkStructural',
      selector: '.spacer',
      action: 'remove',
      intent: 'Strip the spacer rows',
    });

    expect(res.ok).toBe(true);
    expect(data(res)).toMatchObject({ applied: 3, failed: 0 });
    expect(document.querySelectorAll('.spacer')).toHaveLength(0);
    expect(document.getElementById('k')).not.toBeNull();
    // Per-element record: three events, each the kind a single removeNode would have recorded.
    expect(h.events).toHaveLength(3);
    for (const event of h.events) {
      expect(event.kind).toBe('removeNode');
      expect(event.structural).toEqual({ op: 'remove' });
      expect(event.intent).toBe('Strip the spacer rows');
    }
  });

  it('names each removed element by its PRE-removal selector', () => {
    // Post-detach nothing resolves, so the selector must be computed at the target's own turn
    // BEFORE the mutation — the same rule the single removeNode case follows.
    const h = harness();
    const res = h.exec.exec({ type: 'bulkStructural', selector: '.spacer', action: 'remove' });

    expect(h.events.map((e) => e.selector.value)).toEqual(['#s1', '#s2', '#s3']);
    expect(data(res).results.map((r) => r.selector)).toEqual(['#s1', '#s2', '#s3']);
  });

  it('undo steps back ONE element, not the whole call', () => {
    // A bulk call is a transport optimization, never a transaction: undoing once gives the user
    // one row back, not twelve.
    const h = harness();
    h.exec.exec({ type: 'bulkStructural', selector: '.spacer', action: 'remove' });
    expect(document.querySelectorAll('.spacer')).toHaveLength(0);

    const undone = h.exec.exec({ type: 'undo' });
    expect(undone.ok).toBe(true);
    expect(document.querySelectorAll('.spacer')).toHaveLength(1);
  });

  it('reports an unmatched selector as not-found, never as an empty success', () => {
    const h = harness();
    const res = h.exec.exec({ type: 'bulkStructural', selector: '.nope', action: 'remove' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/No element matches/);
  });
});

describe('bulkStructural safety properties through the executor', () => {
  it('skips a target an earlier target contained — never applied into a detached tree', () => {
    document.body.innerHTML = '<div class="x" id="outer"><div class="x" id="inner"></div></div>';
    const h = harness();
    const res = h.exec.exec({ type: 'bulkStructural', selector: '.x', action: 'remove' });

    expect(res.ok).toBe(false);
    expect(data(res)).toMatchObject({ applied: 1, failed: 1 });
    expect(data(res).results[1]?.error).toMatch(/left the document/);
    // Exactly ONE recorded edit — the skipped target must not produce an undo entry.
    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.selector.value).toBe('#outer');
  });

  it('refuses outright over the cap rather than half-applying', () => {
    document.body.innerHTML = `<main>${'<div class="z"></div>'.repeat(MAX_BULK_TARGETS + 1)}</main>`;
    const h = harness();
    const res = h.exec.exec({ type: 'bulkStructural', selector: '.z', action: 'remove' });

    expect(res.ok).toBe(false);
    expect(res.error).toContain(`capped at ${MAX_BULK_TARGETS}`);
    expect(document.querySelectorAll('.z')).toHaveLength(MAX_BULK_TARGETS + 1);
    expect(h.events).toHaveLength(0);
  });

  it('keeps going past a refused target and reports the partial honestly', () => {
    document.body.innerHTML = '<div class="x" id="a"></div><div class="x" id="b"></div>';
    const h = harness();
    // `body` is refused as a structural target; the two .x elements must still be removed.
    const res = h.exec.exec({ type: 'bulkStructural', selector: 'body, .x', action: 'remove' });

    expect(res.ok).toBe(false);
    expect(data(res)).toMatchObject({ applied: 2, failed: 1 });
    expect(res.error).toMatch(/already live/);
    expect(document.body).not.toBeNull();
    expect(document.querySelectorAll('.x')).toHaveLength(0);
    expect(h.events).toHaveLength(2);
  });

  it('turns a malformed call into a refusal, never a throw — wrap/replace need html', () => {
    document.body.innerHTML = '<p class="q">x</p>';
    const h = harness();
    for (const action of ['wrap', 'replace'] as const) {
      const res = h.exec.exec({ type: 'bulkStructural', selector: '.q', action });
      expect(res.ok).toBe(false);
      expect(res.error).toContain('`html`');
    }
    const res = h.exec.exec({ type: 'bulkStructural', selector: '.q', action: 'removeAttr' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('`name`');
    expect(h.events).toHaveLength(0);
  });
});

describe('bulkStructural actions beyond remove', () => {
  it('wraps every match, recording the WRAP kind and the sanitized wrapper', () => {
    document.body.innerHTML = '<main><p class="q">a</p><p class="q">b</p><p class="q">c</p></main>';
    const h = harness();
    const res = h.exec.exec({
      type: 'bulkStructural',
      selector: '.q',
      action: 'wrap',
      html: '<div class="card"></div>',
    });

    expect(res.ok).toBe(true);
    expect(document.querySelectorAll('main > div.card > p.q')).toHaveLength(3);
    expect(h.events).toHaveLength(3);
    for (const event of h.events) {
      expect(event.kind).toBe('wrapNode');
      expect(event.structural).toEqual({ op: 'wrap', html: '<div class="card">' });
    }
  });

  it('unwraps every match, leaving the children exactly where they were', () => {
    document.body.innerHTML =
      '<main><div class="w"><p id="a">a</p></div><div class="w"><p id="b">b</p></div></main>';
    const h = harness();
    const res = h.exec.exec({ type: 'bulkStructural', selector: '.w', action: 'unwrap' });

    expect(res.ok).toBe(true);
    expect(document.querySelectorAll('.w')).toHaveLength(0);
    expect(document.querySelectorAll('main > p')).toHaveLength(2);
    for (const event of h.events) expect(event.kind).toBe('unwrapNode');
  });

  it('replaces every match, recording the delta both ways', () => {
    document.body.innerHTML = '<main><img class="rule" /><img class="rule" /></main>';
    const h = harness();
    const res = h.exec.exec({
      type: 'bulkStructural',
      selector: '.rule',
      action: 'replace',
      html: '<hr class="divider" />',
    });

    expect(res.ok).toBe(true);
    expect(document.querySelectorAll('hr.divider')).toHaveLength(2);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    for (const event of h.events) {
      expect(event.kind).toBe('replaceNode');
      expect(event.structural?.op).toBe('replace');
      expect(event.structural?.op === 'replace' && event.structural.replacedHtml).toContain('img');
    }
  });

  it('strips an attribute from every match, recording the null-after delta and no structural', () => {
    document.body.innerHTML = '<main><img width="85" id="c1" /><img width="15" id="c2" /></main>';
    const h = harness();
    const res = h.exec.exec({
      type: 'bulkStructural',
      selector: 'img[width]',
      action: 'removeAttr',
      name: 'width',
    });

    expect(res.ok).toBe(true);
    expect(document.querySelectorAll('img[width]')).toHaveLength(0);
    expect(h.events).toHaveLength(2);
    expect(h.events[0]?.kind).toBe('setAttr');
    expect(h.events[0]?.attrChange).toEqual({ name: 'width', before: '85', after: null });
    // Property-level: the attr delta already describes it, exactly as the single removeAttr case.
    expect(h.events[0]?.structural).toBeUndefined();
  });
});
