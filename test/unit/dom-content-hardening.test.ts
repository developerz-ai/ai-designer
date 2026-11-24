import { describe, expect, it } from 'vitest';
import '@/dom/zod-jitless';
import { z } from 'zod';
import { isOwnSignal } from '@/dom/diagnostics-collector';
import type { CollectorSignal } from '@/shared/diagnostics';

describe('zod jitless', () => {
  it('is switched on for the worlds that run inside a page', () => {
    // Zod probes for eval by constructing an empty `Function` while a `z.object()` is BUILT. On a
    // Trusted-Types site the throw is caught and validation still works, but the browser has
    // already reported the blocked attempt — so the page console fills with
    // "This document requires 'TrustedScript' assignment" and it looks like our extension is doing
    // something forbidden. `jitless` skips the probe.
    expect(z.config().jitless).toBe(true);
  });

  it('still parses correctly without the JIT fast path', () => {
    const schema = z.object({ a: z.string(), b: z.number().optional() });
    expect(schema.safeParse({ a: 'x' }).success).toBe(true);
    expect(schema.safeParse({ a: 1 }).success).toBe(false);
  });
});

describe('the diagnostics collector does not report our own bugs as the page bugs', () => {
  // The collector hooks the ISOLATED world's console and `window` — which is OUR world. An uncaught
  // throw anywhere in src/dom or the content entrypoint arrives as an `error` event carrying a
  // chrome-extension:// filename, and the agent would dutifully report our bug as a finding about
  // the user's site.
  const at = (over: Partial<CollectorSignal>): CollectorSignal =>
    ({ kind: 'exception', message: 'boom', ts: 0, ...over }) as CollectorSignal;

  it('drops an exception attributed to an extension URL', () => {
    expect(
      isOwnSignal(at({ source: 'chrome-extension://abcdef/content-scripts/content.js' })),
    ).toBe(true);
    expect(isOwnSignal(at({ stack: 'at x (moz-extension://abc/injected.js:3:1)' }))).toBe(true);
  });

  it('keeps a genuine page exception', () => {
    expect(isOwnSignal(at({ source: 'https://news.ycombinator.com/news.js' }))).toBe(false);
  });

  it('drops our own failed requests and console noise, keeps the page own', () => {
    expect(
      isOwnSignal({
        kind: 'network',
        method: 'GET',
        url: 'chrome-extension://abc/icon.png',
        ok: false,
        ts: 0,
      } as CollectorSignal),
    ).toBe(true);
    expect(
      isOwnSignal({
        kind: 'network',
        method: 'GET',
        url: 'https://example.com/missing.png',
        ok: false,
        ts: 0,
      } as CollectorSignal),
    ).toBe(false);
    expect(
      isOwnSignal({
        kind: 'console',
        level: 'error',
        text: 'failed at chrome-extension://abc/content.js',
        ts: 0,
      } as CollectorSignal),
    ).toBe(true);
  });

  it('leaves signal kinds with no attribution alone', () => {
    expect(
      isOwnSignal({
        kind: 'a11y',
        impact: 'serious',
        rule: 'x',
        detail: 'y',
        ts: 0,
      } as CollectorSignal),
    ).toBe(false);
  });
});
