// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
