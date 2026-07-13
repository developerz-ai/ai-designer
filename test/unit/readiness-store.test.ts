import { describe, expect, it } from 'vitest';
import { reduceReadiness } from '@/entrypoints/sidepanel/stores/readiness';
import type { ReadinessState } from '@/shared/messages';

const ready: ReadinessState = {
  provider: 'ok',
  model: 'ok',
  hostPermission: 'granted',
  mcp: { connected: 1, total: 1 },
  ready: true,
};

const notReady: ReadinessState = {
  provider: 'missing',
  model: 'missing',
  hostPermission: 'needed',
  mcp: { connected: 0, total: 0 },
  ready: false,
};

describe('reduceReadiness', () => {
  it('replaces state on a readiness push', () => {
    expect(reduceReadiness(notReady, { type: 'readiness', state: ready })).toEqual(ready);
  });

  it('adopts a readiness push from null', () => {
    expect(reduceReadiness(null, { type: 'readiness', state: ready })).toEqual(ready);
  });

  it('ignores unrelated messages', () => {
    const tokenMsg = { type: 'token', text: 'hi' } as Parameters<typeof reduceReadiness>[1];
    expect(reduceReadiness(notReady, tokenMsg)).toBe(notReady);
  });

  it('is pure / does not mutate input', () => {
    reduceReadiness(notReady, { type: 'readiness', state: ready });
    expect(notReady.provider).toBe('missing');
  });
});
