import { describe, expect, it } from 'vitest';
import { reduceSessionState } from '@/entrypoints/sidepanel/stores/session';

describe('reduceSessionState', () => {
  it('adopts a session-state push', () => {
    expect(reduceSessionState('idle', { type: 'session-state', state: 'running' })).toBe('running');
  });

  it('moves running -> stopped without ending the session (still non-idle)', () => {
    expect(reduceSessionState('running', { type: 'session-state', state: 'stopped' })).toBe(
      'stopped',
    );
  });

  it('ignores unrelated messages', () => {
    const tokenMsg = { type: 'token', text: 'hi' } as Parameters<typeof reduceSessionState>[1];
    expect(reduceSessionState('running', tokenMsg)).toBe('running');
  });
});
