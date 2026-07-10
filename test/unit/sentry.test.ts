// @vitest-environment node
import type { Breadcrumb, ErrorEvent } from '@sentry/browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scrubBreadcrumb, scrubEvent } from '@/shared/sentry';

vi.mock('@sentry/browser', () => ({ init: vi.fn() }));

describe('initSentry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('inits Sentry with the GlitchTip DSN + environment, error tracking only', async () => {
    const Sentry = await import('@sentry/browser');
    const { initSentry } = await import('@/shared/sentry');

    initSentry();

    expect(Sentry.init).toHaveBeenCalledOnce();
    const options = vi.mocked(Sentry.init).mock.calls[0]?.[0];
    if (!options) {
      throw new Error('Sentry.init was not called with options');
    }

    expect(options.dsn).toBe(
      'https://bf037adaf792452d8b77377abb682bd4@glitchtip.infra.developerz.ai/2',
    );
    expect(options).toHaveProperty('environment');

    // GlitchTip supports neither Session Replay nor performance tracing, and
    // replay in the all_urls content script would leak the user's browsing — so
    // assert those stay off (regression guard).
    expect(options).not.toHaveProperty('integrations');
    expect(options).not.toHaveProperty('tracesSampleRate');
    expect(options).not.toHaveProperty('replaysSessionSampleRate');
    expect(options).not.toHaveProperty('replaysOnErrorSampleRate');
  });

  it('wires the privacy scrub hooks: beforeSend + console/dom breadcrumb suppression', async () => {
    const Sentry = await import('@sentry/browser');
    const { initSentry } = await import('@/shared/sentry');

    initSentry();

    const options = vi.mocked(Sentry.init).mock.calls[0]?.[0];
    if (!options) {
      throw new Error('Sentry.init was not called with options');
    }

    // A beforeSend hook scrubs page-derived content off every event.
    expect(typeof options.beforeSend).toBe('function');

    // Console + DOM breadcrumb capture is disabled: console breadcrumbs record
    // logged arguments and `ui.*` breadcrumbs record clicked-element identifiers.
    // Assert through the wired hook that both are dropped and safe crumbs kept.
    expect(typeof options.beforeBreadcrumb).toBe('function');
    expect(options.beforeBreadcrumb?.({ category: 'console' })).toBeNull();
    expect(options.beforeBreadcrumb?.({ category: 'ui.click' })).toBeNull();
    expect(options.beforeBreadcrumb?.({ category: 'ui.input' })).toBeNull();
    const navCrumb: Breadcrumb = { category: 'navigation' };
    expect(options.beforeBreadcrumb?.(navCrumb)).toBe(navCrumb);
  });
});

describe('scrubEvent', () => {
  const genuineStack = {
    frames: [
      {
        filename: 'chrome-extension://abc/background.js',
        function: 'handleShip',
        lineno: 42,
        colno: 7,
        in_app: true,
      },
      {
        filename: 'chrome-extension://abc/agent.js',
        function: 'runTool',
        lineno: 88,
        colno: 3,
        in_app: true,
      },
    ],
  };

  it('redacts an exception message that embeds page text', () => {
    const pageText = 'Bank balance: $12,345 — account 4444-3333-2222-1111';
    const event: ErrorEvent = {
      type: undefined,
      event_id: 'evt-1',
      level: 'error',
      exception: {
        values: [
          {
            type: 'Error',
            value: `Selector .acct matched <div class="acct">${pageText}</div>`,
            stacktrace: genuineStack,
          },
        ],
      },
    };

    const scrubbed = scrubEvent(event);

    // The page text is gone from every field of the serialized event.
    expect(JSON.stringify(scrubbed)).not.toContain('Bank balance');
    expect(JSON.stringify(scrubbed)).not.toContain(pageText);
    expect(scrubbed.exception?.values?.[0]?.value).toBe('[redacted]');
    // The error class + stack survive so the crash is still actionable.
    expect(scrubbed.exception?.values?.[0]?.type).toBe('Error');
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames).toHaveLength(2);
  });

  it('strips a base64 image payload carried in extra/contexts', () => {
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const dataUri = `data:image/png;base64,${base64}`;
    const event: ErrorEvent = {
      type: undefined,
      event_id: 'evt-2',
      exception: {
        values: [{ type: 'Error', value: 'ship failed', stacktrace: genuineStack }],
      },
      extra: { screenshot: dataUri, prompt: 'make the hero purple' },
      contexts: { design: { screenshots: [dataUri] } },
    };

    const scrubbed = scrubEvent(event);

    // No attachment-shaped field survives anywhere in the event.
    expect(JSON.stringify(scrubbed)).not.toContain(base64);
    expect(scrubbed.extra).toBeUndefined();
    expect(scrubbed.contexts).toBeUndefined();
    // The crash is still reported: stack frames survive.
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames).toHaveLength(2);
  });

  it('keeps a genuine stack trace with no page content so crash reporting still works', () => {
    const event: ErrorEvent = {
      type: undefined,
      event_id: 'evt-3',
      level: 'error',
      platform: 'javascript',
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'Cannot read properties of undefined',
            mechanism: { type: 'onunhandledrejection', handled: false },
            stacktrace: genuineStack,
          },
        ],
      },
    };

    const scrubbed = scrubEvent(event);

    // The scrubber never drops the event — it returns a real, sendable event...
    expect(scrubbed).not.toBeNull();
    // ...that still carries the diagnostic payload: error class, mechanism, and
    // the full stack (function names, files, line numbers) reach the transport.
    expect(scrubbed.exception?.values?.[0]?.type).toBe('TypeError');
    expect(scrubbed.exception?.values?.[0]?.mechanism?.handled).toBe(false);
    const frames = scrubbed.exception?.values?.[0]?.stacktrace?.frames;
    expect(frames).toHaveLength(2);
    expect(frames?.[0]?.function).toBe('handleShip');
    expect(frames?.[1]?.filename).toBe('chrome-extension://abc/agent.js');
    // Event metadata survives too.
    expect(scrubbed.event_id).toBe('evt-3');
    expect(scrubbed.platform).toBe('javascript');
  });

  // Sentry merges the scope's breadcrumbs onto the event before beforeSend runs, so
  // this is the layer that decides what ships. The allowlist omits `breadcrumbs`, and
  // that is the actual privacy guarantee — scrubBreadcrumb only stops two kinds from
  // being recorded. Pin it: a crumb scrubBreadcrumb happily keeps still never ships.
  it('transmits no breadcrumbs at all, even ones scrubBreadcrumb keeps', () => {
    const event: ErrorEvent = {
      type: undefined,
      event_id: 'evt-4',
      breadcrumbs: [
        { category: 'navigation', data: { to: '/panel' } },
        { category: 'fetch', data: { url: 'https://openrouter.ai/api/v1/chat' } },
      ],
    };

    const scrubbed = scrubEvent(event);

    expect(scrubbed.breadcrumbs).toBeUndefined();
    expect(JSON.stringify(scrubbed)).not.toContain('openrouter.ai');
  });
});

describe('scrubBreadcrumb', () => {
  it('drops console breadcrumbs (they capture logged arguments)', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'user typed: secret' })).toBeNull();
  });

  it('drops DOM breadcrumbs (they capture clicked-element identifiers)', () => {
    expect(scrubBreadcrumb({ category: 'ui.click', message: 'button#pay.checkout' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'ui.input', message: 'input#card' })).toBeNull();
  });

  // scrubBreadcrumb is a recording filter, not a transmission filter: what it keeps
  // still never leaves the browser, because scrubEvent drops the whole breadcrumbs
  // array. See the scrubEvent test below that pins that contract.
  it('keeps non-page breadcrumbs in the in-memory trail', () => {
    const navCrumb: Breadcrumb = { category: 'navigation', data: { to: '/panel' } };
    expect(scrubBreadcrumb(navCrumb)).toBe(navCrumb);
    const fetchCrumb: Breadcrumb = { category: 'fetch' };
    expect(scrubBreadcrumb(fetchCrumb)).toBe(fetchCrumb);
  });

  it('keeps a breadcrumb with no category', () => {
    const crumb: Breadcrumb = { message: 'x' };
    expect(scrubBreadcrumb(crumb)).toBe(crumb);
  });
});
