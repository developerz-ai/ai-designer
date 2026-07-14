import { describe, expect, it } from 'vitest';
import {
  classifyFetchError,
  contrastRatio,
  createDiagnosticsCollector,
  domLayoutProbe,
  errorEventSignal,
  type FetchOutcome,
  type HookTarget,
  type LayoutProbe,
  networkSignal,
  requestMethod,
  requestUrl,
  scanA11y,
  scanLayout,
} from '@/dom/diagnostics-collector';

// diagnostics-collector.ts unit: the content half of the debug engine. The runtime/network hooks
// are driven through a FAKE HookTarget (no real fetch/console mutation — global-coupling lives in
// defaultHookTarget), and the a11y/layout scans run on jsdom fixtures with an injected LayoutProbe
// (jsdom has no layout engine). Pure DOM in, typed CollectorSignal out.

// --- fake hook target -----------------------------------------------------

interface FakeTarget {
  target: HookTarget;
  fire: {
    console(level: 'error' | 'warn', args: unknown[]): void;
    window(type: 'error' | 'unhandledrejection', ev: unknown): void;
    fetch(outcome: FetchOutcome): void;
  };
  restores: { count: number };
  setClock(n: number): void;
}

function fakeTarget(): FakeTarget {
  const consoleHandlers = new Map<string, (args: unknown[]) => void>();
  const windowHandlers = new Map<string, (ev: unknown) => void>();
  let fetchHandler: ((o: FetchOutcome) => void) | null = null;
  const restores = { count: 0 };
  let clock = 1000;
  const restore = () => () => {
    restores.count += 1;
  };
  const target: HookTarget = {
    now: () => clock,
    onConsole: (level, handler) => {
      consoleHandlers.set(level, handler);
      return restore();
    },
    onWindowEvent: (type, handler) => {
      windowHandlers.set(type, handler);
      return restore();
    },
    onFetch: (handler) => {
      fetchHandler = handler;
      return restore();
    },
  };
  return {
    target,
    restores,
    setClock: (n) => {
      clock = n;
    },
    fire: {
      console: (level, args) => consoleHandlers.get(level)?.(args),
      window: (type, ev) => windowHandlers.get(type)?.(ev),
      fetch: (outcome) => fetchHandler?.(outcome),
    },
  };
}

describe('createDiagnosticsCollector', () => {
  it('buffers console errors/warnings with the injected clock', () => {
    const fake = fakeTarget();
    const collector = createDiagnosticsCollector({ target: fake.target });
    fake.setClock(1234);
    fake.fire.console('error', ['Boom', 42]);
    fake.fire.console('warn', ['careful']);
    const [err, warn] = collector.snapshot();
    expect(err).toMatchObject({ kind: 'console', level: 'error', text: 'Boom 42', ts: 1234 });
    expect(warn).toMatchObject({ kind: 'console', level: 'warn', text: 'careful' });
  });

  it('captures uncaught exceptions and unhandled rejections from window events', () => {
    const fake = fakeTarget();
    const collector = createDiagnosticsCollector({ target: fake.target });
    fake.fire.window('error', {
      message: 'x is undefined',
      filename: 'app.js',
      lineno: 12,
      error: { stack: 'trace' },
    });
    fake.fire.window('unhandledrejection', { reason: new Error('nope') });
    const signals = collector.snapshot();
    expect(signals[0]).toMatchObject({
      kind: 'exception',
      message: 'x is undefined',
      source: 'app.js',
      line: 12,
      stack: 'trace',
    });
    expect(signals[1]).toMatchObject({ kind: 'rejection', reason: 'Error: nope' });
  });

  it('reports a broken asset (resource error event with no message) as a network failure', () => {
    const fake = fakeTarget();
    const collector = createDiagnosticsCollector({ target: fake.target });
    fake.fire.window('error', { target: { tagName: 'IMG', src: 'https://cdn.test/hero.png' } });
    expect(collector.snapshot()[0]).toMatchObject({
      kind: 'network',
      ok: false,
      failure: 'network',
      url: 'https://cdn.test/hero.png',
    });
  });

  it('keeps failed and slow requests but drops fast successes', () => {
    const fake = fakeTarget();
    const collector = createDiagnosticsCollector({ target: fake.target, slowMs: 2000 });
    fake.fire.fetch({ method: 'get', url: 'https://a/ok', ok: true, status: 200, durationMs: 10 }); // dropped
    fake.fire.fetch({
      method: 'POST',
      url: 'https://a/fail',
      ok: false,
      status: 500,
      durationMs: 5,
    });
    fake.fire.fetch({
      method: 'GET',
      url: 'https://a/slow',
      ok: true,
      status: 200,
      durationMs: 3000,
    });
    const signals = collector.snapshot();
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({ kind: 'network', method: 'POST', ok: false, status: 500 });
    expect(signals[1]).toMatchObject({
      kind: 'network',
      method: 'GET',
      ok: true,
      durationMs: 3000,
    });
  });

  it('drain empties the buffer; dispose restores every hook and stops buffering', () => {
    const fake = fakeTarget();
    const collector = createDiagnosticsCollector({ target: fake.target });
    fake.fire.console('error', ['one']);
    expect(collector.drain()).toHaveLength(1);
    expect(collector.snapshot()).toHaveLength(0);

    collector.dispose();
    expect(fake.restores.count).toBe(5); // console error+warn, window error+rejection, fetch
    fake.fire.console('error', ['after dispose']);
    expect(collector.snapshot()).toHaveLength(0);
    collector.dispose(); // idempotent
    expect(fake.restores.count).toBe(5);
  });

  it('evicts the oldest signals past maxBuffer', () => {
    const fake = fakeTarget();
    const collector = createDiagnosticsCollector({ target: fake.target, maxBuffer: 2 });
    fake.fire.console('error', ['1']);
    fake.fire.console('error', ['2']);
    fake.fire.console('error', ['3']);
    const texts = collector.snapshot().map((s) => (s.kind === 'console' ? s.text : ''));
    expect(texts).toEqual(['2', '3']);
  });
});

// --- pure fetch/error helpers ---------------------------------------------

describe('fetch + error helpers', () => {
  it('extracts a request url from a string, URL, or Request-like', () => {
    expect(requestUrl('https://a/x')).toBe('https://a/x');
    expect(requestUrl(new URL('https://a/y'))).toBe('https://a/y');
    expect(requestUrl({ url: 'https://a/z' })).toBe('https://a/z');
    expect(requestUrl(123)).toBe('');
  });

  it('resolves the method from init, then the request, then GET', () => {
    expect(requestMethod('u', { method: 'PUT' })).toBe('PUT');
    expect(requestMethod({ method: 'DELETE' }, undefined)).toBe('DELETE');
    expect(requestMethod('u', undefined)).toBe('GET');
  });

  it('classifies aborts and timeouts, defaulting other throws to a network failure', () => {
    expect(classifyFetchError({ name: 'AbortError' })).toBe('abort');
    expect(classifyFetchError({ name: 'TimeoutError' })).toBe('timeout');
    expect(classifyFetchError(new TypeError('Failed to fetch'))).toBe('network');
  });

  it('networkSignal drops only fast successes', () => {
    expect(networkSignal({ method: 'GET', url: 'u', ok: true, durationMs: 5 }, 2000, 1)).toBeNull();
    expect(networkSignal({ method: 'GET', url: 'u', ok: false }, 2000, 1)).not.toBeNull();
  });

  it('errorEventSignal returns null for an event that is neither an error nor a known asset', () => {
    expect(errorEventSignal({ target: { tagName: 'DIV' } }, 1)).toBeNull();
  });
});

// --- a11y scan ------------------------------------------------------------

function mount(html: string): void {
  document.documentElement.setAttribute('lang', 'en'); // silence html-lang unless a test clears it
  document.head.innerHTML = '';
  document.body.innerHTML = html;
}

function rules(signals: ReturnType<typeof scanA11y>): string[] {
  return signals.flatMap((s) => (s.kind === 'a11y' || s.kind === 'layout' ? [s.rule] : []));
}

describe('scanA11y', () => {
  it('flags interactive controls with no accessible name, images with no alt, and unlabeled fields', () => {
    mount(`
      <button></button>
      <button>Save</button>
      <a href="/x"></a>
      <img src="a.png" />
      <img src="b.png" alt="" />
      <input type="text" />
      <label>Email <input type="email" /></label>
    `);
    const found = rules(scanA11y(document, window, { now: () => 1 }));
    expect(found.filter((r) => r === 'control-name')).toHaveLength(2); // empty button + empty link
    expect(found.filter((r) => r === 'image-alt')).toHaveLength(1); // only the alt-less image
    expect(found.filter((r) => r === 'field-label')).toHaveLength(1); // wrapped-label input is fine
  });

  it('flags positive tabindex and a missing document lang', () => {
    mount('<div tabindex="3">focus trap</div><div tabindex="0">ok</div>');
    document.documentElement.removeAttribute('lang');
    const found = rules(scanA11y(document, window, { now: () => 1 }));
    expect(found).toContain('focus-order');
    expect(found).toContain('html-lang');
  });

  it('flags low text/background contrast but not a high-contrast pair', () => {
    mount(
      '<p style="color:#999999;background-color:#ffffff">low</p><p style="color:#111111;background-color:#ffffff">high</p>',
    );
    const contrast = scanA11y(document, window, { now: () => 1 }).filter(
      (s) => s.kind === 'a11y' && s.rule === 'contrast',
    );
    expect(contrast).toHaveLength(1);
  });
});

describe('scanLayout', () => {
  const probe = (rights: Record<string, number>): LayoutProbe => ({
    viewportWidth: () => 400,
    scrollWidth: (el) => (el === document.documentElement ? 800 : 0),
    right: (el) => rights[el.id] ?? 0,
  });

  it('flags page overflow, element overflow, and a size-less image (CLS)', () => {
    mount('<img id="wide" src="hero.png" />');
    const found = rules(
      scanLayout(document, window, { now: () => 1, probe: probe({ wide: 900 }) }),
    );
    expect(found).toContain('overflow-x'); // both the page and the wide image
    expect(found).toContain('cls-image');
  });

  it('does not flag CLS for an image with explicit dimensions', () => {
    mount('<img id="sized" src="hero.png" width="200" height="100" />');
    const found = rules(scanLayout(document, window, { now: () => 1, probe: probe({ sized: 0 }) }));
    expect(found).not.toContain('cls-image');
  });

  it('domLayoutProbe reads real geometry without throwing', () => {
    mount('<div id="x">y</div>');
    const el = document.getElementById('x');
    const built = domLayoutProbe(window);
    expect(typeof built.viewportWidth()).toBe('number');
    expect(el ? typeof built.right(el) : 'number').toBe('number');
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white and 1:1 for identical colors', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#123456', '#123456')).toBeCloseTo(1, 5);
  });
});
