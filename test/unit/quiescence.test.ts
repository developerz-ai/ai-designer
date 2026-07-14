import { describe, expect, it, vi } from 'vitest';
import { createRouteObserver, waitForQuiescence } from '@/dom/quiescence';

// Unit: hydration/quiescence awaiting + SPA route observation (slice 15A). Every timing source is
// injected (timers, the mutation-observe subscription, readiness) so the branches resolve
// deterministically with no real clock — the same "injectable for tests" pattern as src/dom/bridge.ts.

type Handle = ReturnType<Window['setTimeout']>;

function timers(): {
  set: (fn: () => void) => Handle;
  clear: (h: Handle) => void;
  fire: (h: Handle) => void;
  ids: () => number[];
  size: () => number;
} {
  let seq = 0;
  const map = new Map<number, () => void>();
  return {
    set: (fn): Handle => {
      seq += 1;
      map.set(seq, fn);
      return seq as unknown as Handle;
    },
    clear: (h): void => {
      map.delete(h as unknown as number);
    },
    fire: (h): void => {
      const id = h as unknown as number;
      const fn = map.get(id);
      map.delete(id);
      fn?.();
    },
    ids: (): number[] => [...map.keys()],
    size: (): number => map.size,
  };
}

describe('waitForQuiescence', () => {
  it('resolves quiescent after a quiet window with no mutations', async () => {
    const t = timers();
    // hard timer = id 1 (created first), quiet timer = id 2 (armed once ready).
    const promise = waitForQuiescence(window, document, {
      isReady: () => true,
      observe: () => () => {},
      setTimer: t.set,
      clearTimer: t.clear,
      now: () => 0,
    });

    expect(t.ids()).toEqual([1, 2]);
    t.fire(2 as unknown as Handle); // quiet window elapsed
    const result = await promise;

    expect(result.quiescent).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(t.size()).toBe(0); // both timers torn down
  });

  it('resets the quiet window on every mutation (no early settle)', async () => {
    const t = timers();
    let onMutation = (): void => {};
    const promise = waitForQuiescence(window, document, {
      isReady: () => true,
      observe: (cb) => {
        onMutation = cb;
        return () => {};
      },
      setTimer: t.set,
      clearTimer: t.clear,
      now: () => 0,
    });

    onMutation(); // a late hydration mutation re-arms the quiet window (id 2 -> id 3)
    expect(t.ids()).toEqual([1, 3]);
    t.fire(3 as unknown as Handle);

    expect((await promise).quiescent).toBe(true);
  });

  it('times out (not quiescent) when the page never settles', async () => {
    const t = timers();
    const promise = waitForQuiescence(window, document, {
      isReady: () => true,
      observe: () => () => {},
      setTimer: t.set,
      clearTimer: t.clear,
      now: () => 0,
    });

    t.fire(1 as unknown as Handle); // hard timeout wins
    const result = await promise;

    expect(result.timedOut).toBe(true);
    expect(result.quiescent).toBe(false);
  });

  it('waits for hydration before it starts counting quiet', async () => {
    const t = timers();
    let becomeReady = (): void => {};
    const observe = vi.fn(() => () => {});
    const promise = waitForQuiescence(window, document, {
      isReady: () => false,
      onReady: (cb) => {
        becomeReady = cb;
        return () => {};
      },
      observe,
      setTimer: t.set,
      clearTimer: t.clear,
      now: () => 0,
    });

    // Not ready yet: only the hard timer exists, and nothing is observed.
    expect(observe).not.toHaveBeenCalled();
    expect(t.ids()).toEqual([1]);

    becomeReady(); // hydration finished -> observe + arm the quiet window
    expect(observe).toHaveBeenCalledOnce();
    expect(t.ids()).toEqual([1, 2]);

    t.fire(2 as unknown as Handle);
    expect((await promise).quiescent).toBe(true);
  });
});

describe('createRouteObserver', () => {
  function fakeWin(href: string): {
    win: Window;
    emit: (type: string) => void;
    setHref: (next: string) => void;
  } {
    const listeners = new Map<string, Set<() => void>>();
    const location = { href };
    const win = {
      location,
      addEventListener(type: string, fn: () => void): void {
        const set = listeners.get(type) ?? new Set<() => void>();
        set.add(fn);
        listeners.set(type, set);
      },
      removeEventListener(type: string, fn: () => void): void {
        listeners.get(type)?.delete(fn);
      },
    } as unknown as Window;
    return {
      win,
      emit: (type): void => {
        for (const fn of listeners.get(type) ?? []) fn();
      },
      setHref: (next): void => {
        location.href = next;
      },
    };
  }

  it('fires once per navigation via the href poll, de-duped', () => {
    const { win, setHref } = fakeWin('https://app.test/a');
    let poll = (): void => {};
    const changes: string[] = [];
    const observer = createRouteObserver((url) => changes.push(url), {
      win,
      setPoll: (fn) => {
        poll = fn;
        return 1 as unknown as Handle;
      },
      clearPoll: () => {},
    });

    setHref('https://app.test/b');
    poll();
    poll(); // href unchanged -> no second fire
    expect(changes).toEqual(['https://app.test/b']);

    observer.dispose();
  });

  it('fires on popstate for back/forward navigation', () => {
    const { win, emit, setHref } = fakeWin('https://app.test/a');
    const changes: string[] = [];
    const observer = createRouteObserver((url) => changes.push(url), { win, pollMs: 0 });

    setHref('https://app.test/c');
    emit('popstate');
    expect(changes).toEqual(['https://app.test/c']);

    observer.dispose();
    setHref('https://app.test/d');
    emit('popstate'); // disposed -> silent
    expect(changes).toEqual(['https://app.test/c']);
  });

  it('clears the poll timer on dispose', () => {
    const { win } = fakeWin('https://app.test/a');
    const clearPoll = vi.fn();
    const observer = createRouteObserver(() => {}, {
      win,
      setPoll: () => 7 as unknown as Handle,
      clearPoll,
    });

    observer.dispose();
    expect(clearPoll).toHaveBeenCalledWith(7);
  });
});
