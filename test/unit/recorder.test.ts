import { describe, expect, it, vi } from 'vitest';
import type { ElementMutation } from '@/dom/mutate';
import { createRecorder, type Recorder, type RecorderEmit } from '@/dom/recorder';
import type { ContentToSw, StableSelector } from '@/shared/messages';

// Recorder unit tests. The recorder is pure logic over an injected `emit` + clock, so we drive it
// with fake ElementMutations (a spy `undo`) — no DOM needed. Reversibility against a real mutator
// is covered end-to-end by the executor integration test.

const selector: StableSelector = { value: '#cta', strategy: 'id', fragile: false };

function fakeMutation(over: Partial<ElementMutation> = {}): ElementMutation {
  return {
    kind: 'setText',
    computed: 'after',
    before: 'before',
    after: 'after',
    undo: vi.fn(),
    ...over,
  };
}

function spawn(now = (): number => 42): { emitted: ContentToSw[]; recorder: Recorder } {
  const emitted: ContentToSw[] = [];
  const emit: RecorderEmit = (m) => emitted.push(m);
  return { emitted, recorder: createRecorder(emit, now) };
}

describe('createRecorder.record', () => {
  it('emits a recorder-event stamped with the selector + injected clock', () => {
    const { emitted, recorder } = spawn(() => 123);
    const event = recorder.record(selector, fakeMutation());

    expect(emitted).toEqual([{ type: 'recorder-event', event }]);
    expect(event).toEqual({
      kind: 'setText',
      selector,
      before: 'before',
      after: 'after',
      ts: 123,
    });
    expect(recorder.size()).toBe(1);
  });

  it('carries ruleId only when the mutation has one', () => {
    const { recorder } = spawn();
    const withRule = recorder.record(selector, fakeMutation({ kind: 'setStyle', ruleId: 'dz-1' }));
    expect(withRule.ruleId).toBe('dz-1');
    // A non-setStyle event omits the field entirely (not an explicit undefined).
    const withoutRule = recorder.record(selector, fakeMutation());
    expect('ruleId' in withoutRule).toBe(false);
  });
});

describe('createRecorder.undo', () => {
  it('reverses the most recent mutation LIFO and returns its event', () => {
    const { recorder } = spawn();
    const firstUndo = vi.fn();
    const secondUndo = vi.fn();
    const firstEvent = recorder.record(selector, fakeMutation({ after: '1', undo: firstUndo }));
    const secondEvent = recorder.record(selector, fakeMutation({ after: '2', undo: secondUndo }));

    expect(recorder.undo()).toEqual(secondEvent);
    expect(secondUndo).toHaveBeenCalledOnce();
    expect(firstUndo).not.toHaveBeenCalled();

    expect(recorder.undo()).toEqual(firstEvent);
    expect(firstUndo).toHaveBeenCalledOnce();
    expect(recorder.size()).toBe(0);
  });

  it('returns null and reverses nothing on an empty log', () => {
    const { recorder } = spawn();
    expect(recorder.undo()).toBeNull();
  });
});

describe('createRecorder.clear', () => {
  it('drops the log without reversing the mutations', () => {
    const { recorder } = spawn();
    const undo = vi.fn();
    recorder.record(selector, fakeMutation({ undo }));
    recorder.clear();
    expect(recorder.size()).toBe(0);
    expect(recorder.undo()).toBeNull();
    expect(undo).not.toHaveBeenCalled();
  });
});
