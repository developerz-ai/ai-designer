import { beforeEach, describe, expect, it } from 'vitest';
import { isMainOp, pathDenyReason, runMainOp, safeValue } from '@/dom/page-main-ops';

// The MAIN-world half of the page-operations library. This is the file that runs inside the page's
// own JS realm, so most of what matters here is what it REFUSES.

type Win = Window & Record<string, unknown>;

// The MAIN world's `window` is the page's own object bag; the tests hang page globals off it the
// same way a real site would.

function win(extra: Record<string, unknown> = {}): Win {
  const w = window as unknown as Win;
  for (const [k, v] of Object.entries(extra)) w[k] = v;
  return w;
}

describe('pathDenyReason — the boundary that keeps this from being eval', () => {
  it('refuses every code-construction root', () => {
    for (const path of ['eval', 'Function', 'setTimeout', 'queueMicrotask']) {
      expect([path, pathDenyReason(path)]).not.toEqual([path, null]);
    }
  });

  it('refuses network roots — the page world carries the user real cookies', () => {
    for (const path of ['fetch', 'XMLHttpRequest', 'WebSocket', 'navigator.sendBeacon']) {
      expect([path, pathDenyReason(path)]).not.toEqual([path, null]);
    }
  });

  it('refuses navigation, storage and extension roots', () => {
    for (const path of ['location.href', 'history.pushState', 'localStorage', 'chrome.runtime']) {
      expect([path, pathDenyReason(path)]).not.toEqual([path, null]);
    }
  });

  it('refuses a prototype walk, the standard route from a property read to a code constructor', () => {
    // `app.__proto__.constructor` is `Function`. Blocking the roots alone is not enough.
    for (const path of ['app.__proto__', 'app.constructor', 'app.x.prototype']) {
      expect([path, pathDenyReason(path)]).not.toEqual([path, null]);
    }
  });

  it('refuses anything that is not a plain property name', () => {
    for (const path of ['a["b"]', 'a[0]', 'a.b()', 'a-b', 'a b', '']) {
      expect([path, pathDenyReason(path)]).not.toEqual([path, null]);
    }
  });

  it('refuses markup-injecting leaves wherever they appear', () => {
    for (const path of ['document.write', 'myEditor.insertAdjacentHTML']) {
      expect([path, pathDenyReason(path)]).not.toEqual([path, null]);
    }
  });

  it('allows an ordinary page API path', () => {
    for (const path of ['myChart.update', '__NEXT_DATA__.props.pageProps', 'app.store.state']) {
      expect([path, pathDenyReason(path)]).toEqual([path, null]);
    }
  });
});

describe('pageCall', () => {
  it('calls a page function with its own receiver and returns a bounded result', () => {
    interface Chart {
      scale: number;
      update(factor: number): { updated: boolean; scale: number };
    }
    const chart: Chart = {
      scale: 1,
      update(factor: number) {
        this.scale = factor;
        return { updated: true, scale: this.scale };
      },
    };
    const w = win({ myChart: chart });
    const res = runMainOp({ op: 'pageCall', path: 'myChart.update', args: [2] }, w);
    expect(res.ok).toBe(true);
    expect(chart.scale).toBe(2); // called with its own receiver, not detached
  });

  it('catches an ALIASED code constructor by identity, not by name', () => {
    // The deny-list is by path, and a page can call `eval` anything it likes. Identity closes it.
    const realEval = Reflect.get(globalThis, 'eval');
    const w = win({ harmlessHelper: realEval });
    const res = runMainOp({ op: 'pageCall', path: 'harmlessHelper', args: ['alert(1)'] }, w);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('code-construction');
  });

  it('reports a page-thrown error as an answer rather than failing the turn', () => {
    const w = win({
      boom: () => {
        throw new Error('page said no');
      },
    });
    const res = runMainOp({ op: 'pageCall', path: 'boom', args: [] }, w);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('page said no');
  });

  it('refuses a path that is not a function instead of guessing', () => {
    const res = runMainOp({ op: 'pageCall', path: 'notThere', args: [] }, win());
    expect(res.ok).toBe(false);
  });
});

describe('safeValue — the page is hostile', () => {
  it('breaks cycles instead of hanging', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(safeValue(a)).toEqual({ name: 'a', self: '[Circular]' });
  });

  it('survives a getter that throws', () => {
    const evil = {};
    Object.defineProperty(evil, 'trap', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(safeValue(evil)).toEqual({ trap: '[Threw on access]' });
  });

  it('describes a function rather than invoking it', () => {
    expect(safeValue(function doThing() {})).toBe('[Function doThing]');
  });

  it('describes a DOM node rather than dragging its subtree into the transcript', () => {
    document.body.innerHTML = '<div id="huge"><p>a</p><p>b</p></div>';
    expect(safeValue(document.getElementById('huge'))).toBe('[div#huge]');
  });

  it('bounds depth, breadth and string length', () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(JSON.stringify(safeValue(deep))).toContain('Depth limit');
    const wide = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(safeValue(wide) as object)).toHaveLength(50);
    const long = 'x'.repeat(20_000);
    expect((safeValue(long) as string).length).toBe(8_000);
  });
});

describe('frameworkState', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="card"></div>';
  });

  it('names the component that rendered an element — a name that exists in the repo', () => {
    const el = document.getElementById('card');
    if (!el) throw new Error('fixture');
    function ProductCard() {}
    (el as unknown as Record<string, unknown>).__reactFiber$abc = {
      elementType: ProductCard,
      memoizedProps: { variant: 'sale' },
    };
    const res = runMainOp({ op: 'frameworkState', selector: '#card' }, win());
    expect(res.ok).toBe(true);
    const data = (res as { data: { framework: string; componentName: string; props: unknown } })
      .data;
    expect(data.framework).toBe('react');
    expect(data.componentName).toBe('ProductCard');
    expect(data.props).toEqual({ variant: 'sale' });
  });

  it('says it found nothing rather than inventing a framework', () => {
    const res = runMainOp({ op: 'frameworkState', selector: '#card' }, win());
    expect((res as { data: { framework: string | null } }).data.framework).toBeNull();
  });
});

describe('isMainOp', () => {
  it('rejects a malformed message from the page world', () => {
    for (const bad of [null, {}, { op: 'evaluate' }, { op: 'pageCall', path: 'x' }]) {
      expect(isMainOp(bad)).toBe(false);
    }
    expect(isMainOp({ op: 'pageCall', path: 'x.y', args: [] })).toBe(true);
  });
});
