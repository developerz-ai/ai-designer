import { createRoot, createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import { createPresence } from '@/entrypoints/sidepanel/components/presence';

// Exit animations for `<Show>`-mounted overlays. The contract that matters is asymmetric: OPEN
// must be synchronous (a menu that mounts a tick late loses the focus effect that runs on open —
// which is exactly how ModelPicker's open-focus broke when this was first written), while CLOSE
// deliberately lags so the leave animation has frames to run in.

function withPresence<T>(
  open: () => boolean,
  run: (p: ReturnType<typeof createPresence>) => T,
  exitMs = 140,
): T {
  return createRoot(() => run(createPresence(open, exitMs)));
}

describe('createPresence', () => {
  it('mounts synchronously on open — no effect tick in between', () => {
    const [open, setOpen] = createSignal(false);
    withPresence(open, (p) => {
      expect(p.mounted()).toBe(false);
      setOpen(true);
      // Read in the same turn: `mounted` derives from `open`, it is not a signal an effect sets.
      expect(p.mounted()).toBe(true);
      expect(p.leaving()).toBe(false);
    });
  });

  it('stays mounted and marks itself leaving for the exit window', () => {
    vi.useFakeTimers();
    const [open, setOpen] = createSignal(true);
    withPresence(open, (p) => {
      setOpen(false);
      expect(p.leaving()).toBe(true);
      expect(p.mounted()).toBe(true);

      vi.advanceTimersByTime(139);
      expect(p.mounted()).toBe(true);

      vi.advanceTimersByTime(2);
      expect(p.leaving()).toBe(false);
      expect(p.mounted()).toBe(false);
    });
    vi.useRealTimers();
  });

  it('cancels the exit when reopened mid-animation', () => {
    // Double-clicking a trigger: without this the node unmounts out from under a menu the user
    // has just re-opened.
    vi.useFakeTimers();
    const [open, setOpen] = createSignal(true);
    withPresence(open, (p) => {
      setOpen(false);
      setOpen(true);
      expect(p.leaving()).toBe(false);

      vi.advanceTimersByTime(500);
      expect(p.mounted()).toBe(true);
      expect(p.leaving()).toBe(false);
    });
    vi.useRealTimers();
  });

  it('never animates out of a state it was never in', () => {
    vi.useFakeTimers();
    const [open, setOpen] = createSignal(false);
    withPresence(open, (p) => {
      // A closed overlay whose state is re-asserted as closed must not flash `leaving` and mount
      // itself for 140ms — that would put an invisible node over the panel on every render.
      setOpen(false);
      expect(p.leaving()).toBe(false);
      expect(p.mounted()).toBe(false);
    });
    vi.useRealTimers();
  });

  it('drops its timer when the owner is disposed mid-exit', () => {
    vi.useFakeTimers();
    const [open, setOpen] = createSignal(true);
    const dispose = createRoot((d) => {
      const p = createPresence(open, 140);
      setOpen(false);
      expect(p.leaving()).toBe(true);
      return d;
    });

    dispose();
    // Firing against a disposed scope is the leak this guards; advancing must not throw.
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    vi.useRealTimers();
  });
});
