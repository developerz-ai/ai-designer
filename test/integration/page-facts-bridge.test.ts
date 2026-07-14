import { describe, expect, it, vi } from 'vitest';
import { type Bridge, createBridge, serveBridge } from '@/dom/bridge';
import { createPageFacts } from '@/dom/page-facts';
import { BRIDGE_SOURCE, type PageFacts } from '@/shared/messages';

// Integration: the real MAIN-world bridge (src/dom/bridge.ts) client + server wired over a controllable
// same-window message bus, plus the content-side page-facts orchestrator (cache + DOM-only fallback).
// The fake window mimics `window.postMessage` (same-window, async, our own origin as `source`/`origin`)
// so we can also inject spoofed messages the guard must drop — the cross-world flow this slice adds
// without a loaded extension. Mirrors control-dispatch.test.ts's "real dispatch, faked bus" pattern.

type MessageListener = (event: MessageEvent) => void;

function makeWindow(origin = 'https://app.example'): {
  win: Window;
  posts: unknown[];
  deliver: (event: { data: unknown; origin?: string; source?: unknown }) => void;
} {
  const listeners = new Set<MessageListener>();
  const posts: unknown[] = [];
  const dispatch = (event: { data: unknown; origin?: string; source?: unknown }): void => {
    const full = { data: event.data, origin: event.origin ?? origin, source: event.source ?? win };
    for (const fn of [...listeners]) fn(full as unknown as MessageEvent);
  };
  const win = {
    location: { origin, href: `${origin}/dashboard` },
    addEventListener(type: string, fn: MessageListener): void {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener(type: string, fn: MessageListener): void {
      if (type === 'message') listeners.delete(fn);
    },
    // Real postMessage is same-window + async: record it, then deliver on a microtask so a client's
    // pending state is registered before its response arrives.
    postMessage(data: unknown): void {
      posts.push(data);
      queueMicrotask(() => dispatch({ data }));
    },
  } as unknown as Window;
  return { win, posts, deliver: dispatch };
}

const FACTS: PageFacts = {
  frameworks: ['next', 'react'],
  chartLibs: ['chartjs'],
  libraries: ['jquery'],
  spa: true,
  url: 'https://app.example/dashboard',
};

// A setTimer we can fire by hand — makes the client's timeout deterministic (no real clock).
type TimerHandle = ReturnType<typeof setTimeout>;
function manualTimer(): {
  setTimer: (fn: () => void) => TimerHandle;
  clearTimer: () => void;
  fire: () => void;
} {
  let pending: (() => void) | null = null;
  return {
    setTimer: (fn: () => void): TimerHandle => {
      pending = fn;
      return 0 as unknown as TimerHandle;
    },
    clearTimer: (): void => {
      pending = null;
    },
    fire: (): void => pending?.(),
  };
}

describe('MAIN-world bridge — round-trip', () => {
  it('resolves a request with the handler result over postMessage', async () => {
    const { win } = makeWindow();
    const server = serveBridge({ 'page-facts': () => FACTS }, { win });
    const bridge = createBridge({ win });

    const raw = await bridge.request('page-facts');
    expect(raw).toEqual(FACTS);

    bridge.dispose();
    server.dispose();
  });

  it('rejects when the requested method has no handler', async () => {
    const { win } = makeWindow();
    const server = serveBridge({}, { win });
    const bridge = createBridge({ win });

    await expect(bridge.request('page-facts')).rejects.toThrow(/Unknown bridge method/);

    bridge.dispose();
    server.dispose();
  });

  it('rejects on timeout when no MAIN world answers', async () => {
    const { win } = makeWindow();
    const timer = manualTimer();
    const bridge = createBridge({ win, setTimer: timer.setTimer, clearTimer: timer.clearTimer });

    const pending = bridge.request('page-facts');
    timer.fire();
    await expect(pending).rejects.toThrow(/timed out/);

    bridge.dispose();
  });
});

describe('MAIN-world bridge — origin/nonce guard', () => {
  it('drops a response from a foreign origin (spoof), then times out', async () => {
    const { win, deliver } = makeWindow('https://app.example');
    const timer = manualTimer();
    const bridge = createBridge({
      win,
      nonce: () => 'nonce-1',
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    const pending = bridge.request('page-facts');
    // A cross-origin frame forges a well-formed reply carrying the correct nonce.
    deliver({
      data: {
        source: BRIDGE_SOURCE,
        dir: 'res',
        nonce: 'nonce-1',
        ok: true,
        result: { hacked: true },
      },
      origin: 'https://evil.example',
    });
    // Origin guard held — nothing resolved; the injected timeout is what finally settles it.
    timer.fire();
    await expect(pending).rejects.toThrow(/timed out/);

    bridge.dispose();
  });

  it('drops a response whose source is not the bridge window', async () => {
    const { win, deliver } = makeWindow();
    const timer = manualTimer();
    const bridge = createBridge({
      win,
      nonce: () => 'nonce-2',
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    const pending = bridge.request('page-facts');
    deliver({
      data: { source: BRIDGE_SOURCE, dir: 'res', nonce: 'nonce-2', ok: true, result: {} },
      source: { note: 'an iframe contentWindow, not our window' },
    });
    timer.fire();
    await expect(pending).rejects.toThrow(/timed out/);

    bridge.dispose();
  });

  it('server drops a request from a foreign origin (no reply, handler not run)', () => {
    const { win, posts, deliver } = makeWindow('https://app.example');
    const handler = vi.fn(() => FACTS);
    const server = serveBridge({ 'page-facts': handler }, { win });

    deliver({
      data: { source: BRIDGE_SOURCE, dir: 'req', nonce: 'x', method: 'page-facts' },
      origin: 'https://evil.example',
    });

    expect(handler).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
    server.dispose();
  });
});

describe('createPageFacts — cache + fallback', () => {
  function stubBridge(request: Bridge['request']): Bridge {
    return { request, dispose: () => {} };
  }

  it('caches per URL: a second get() does not re-hit the bridge', async () => {
    const request = vi.fn(async () => FACTS);
    const provider = createPageFacts({ bridge: stubBridge(request) });

    const a = await provider.get();
    const b = await provider.get();

    expect(a).toEqual(FACTS);
    expect(b).toBe(a);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent get() calls onto one probe', async () => {
    const request = vi.fn(async () => FACTS);
    const provider = createPageFacts({ bridge: stubBridge(request) });

    const [a, b] = await Promise.all([provider.get(), provider.get()]);

    expect(a).toBe(b);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('falls back to DOM-only detection when the bridge rejects', async () => {
    document.body.innerHTML = '<div id="__next"><main>App</main></div>';
    const request = vi.fn(async () => {
      throw new Error('no MAIN world');
    });
    const provider = createPageFacts({ bridge: stubBridge(request) });

    const facts = await provider.get();

    expect(facts.frameworks).toContain('next');
    expect(request).toHaveBeenCalledTimes(1);
    document.body.innerHTML = '';
  });

  it('invalidate() forces a re-fetch', async () => {
    const request = vi.fn(async () => FACTS);
    const provider = createPageFacts({ bridge: stubBridge(request) });

    await provider.get();
    provider.invalidate();
    await provider.get();

    expect(request).toHaveBeenCalledTimes(2);
  });
});
