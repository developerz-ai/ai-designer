import { describe, expect, it } from 'vitest';
import { onboardingSteps } from '@/entrypoints/sidepanel/components/Onboarding';
import type { ReadinessState } from '@/shared/messages';

// `onboardingSteps` derives the three first-run steps from live readiness. Pure (no Solid),
// so the done/current logic is asserted here directly — mirroring readiness-dropdown.test.ts's
// `sessionButton`. The component only maps this array onto the DOM.

function readiness(over: Partial<ReadinessState> = {}): ReadinessState {
  return {
    provider: 'missing',
    model: 'missing',
    hostPermission: 'needed',
    mcp: { connected: 0, total: 0 },
    ready: false,
    ...over,
  };
}

describe('onboardingSteps', () => {
  it('a fresh install: nothing done, provider is the current step', () => {
    const [provider, mcp, start] = onboardingSteps(null);
    expect(provider).toEqual({ id: 'provider', done: false, current: true });
    expect(mcp).toEqual({ id: 'mcp', done: false, current: false });
    expect(start).toEqual({ id: 'start', done: false, current: false });
  });

  it('needs BOTH key and model for the provider step to complete', () => {
    expect(onboardingSteps(readiness({ provider: 'ok', model: 'missing' }))[0].done).toBe(false);
    expect(onboardingSteps(readiness({ provider: 'missing', model: 'ok' }))[0].done).toBe(false);
    expect(onboardingSteps(readiness({ provider: 'ok', model: 'ok' }))[0].done).toBe(true);
  });

  it('once the provider is configured, "start" becomes the current step (not provider)', () => {
    const [provider, mcp, start] = onboardingSteps(readiness({ provider: 'ok', model: 'ok' }));
    expect(provider.current).toBe(false);
    expect(mcp.current).toBe(false);
    expect(start.current).toBe(true);
  });

  it('the mcp step completes on ≥1 connected backend but never becomes the current step', () => {
    const none = onboardingSteps(readiness({ mcp: { connected: 0, total: 2 } }))[1];
    expect(none).toEqual({ id: 'mcp', done: false, current: false });
    const some = onboardingSteps(readiness({ mcp: { connected: 1, total: 2 } }))[1];
    expect(some).toEqual({ id: 'mcp', done: true, current: false });
  });

  it('"start" is never auto-marked done — it is the terminal action', () => {
    const fullyReady = readiness({
      provider: 'ok',
      model: 'ok',
      mcp: { connected: 1, total: 1 },
      ready: true,
    });
    expect(onboardingSteps(fullyReady)[2].done).toBe(false);
  });
});
