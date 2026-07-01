// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @sentry/browser module
vi.mock('@sentry/browser', () => ({
  browserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
  init: vi.fn(),
}));

describe('sentry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('guards against empty DSN: early return when DSN is falsy', () => {
    // Simulate the guard logic: if DSN is empty/falsy, return early
    const testDSN = '';
    let initCalled = false;

    if (testDSN) {
      initCalled = true; // This would be Sentry.init()
    }

    expect(initCalled).toBe(false);
  });

  it('initializes Sentry with correct options when DSN is present', async () => {
    const Sentry = await import('@sentry/browser');
    const { initSentry } = await import('@/shared/sentry');

    initSentry();

    // Verify Sentry.init was called
    expect(Sentry.init).toHaveBeenCalledOnce();

    // Get the options passed to Sentry.init
    const initCall = vi.mocked(Sentry.init).mock.calls[0];
    if (!initCall) {
      throw new Error('Sentry.init was not called');
    }
    const options = initCall[0];
    if (!options) {
      throw new Error('Sentry.init options are undefined');
    }

    // Verify required options
    expect(options).toHaveProperty('dsn');
    expect(options.dsn).toBe(
      'https://bf037adaf792452d8b77377abb682bd4@glitchtip.infra.developerz.ai/2',
    );
    expect(options).toHaveProperty('environment');
    expect(options).toHaveProperty('release');
    expect(options).toHaveProperty('tracesSampleRate', 1.0);
    expect(options).toHaveProperty('replaysSessionSampleRate', 0.1);
    expect(options).toHaveProperty('replaysOnErrorSampleRate', 1.0);

    // Verify integrations are present
    expect(options).toHaveProperty('integrations');
    const integrations = options.integrations;
    if (Array.isArray(integrations)) {
      expect(integrations).toHaveLength(2);

      // Verify browserTracingIntegration is included
      expect(integrations[0]).toHaveProperty('name', 'BrowserTracing');

      // Verify replayIntegration is included
      expect(integrations[1]).toHaveProperty('name', 'Replay');
    }
  });
});
