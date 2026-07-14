import { describe, expect, it } from 'vitest';
import { sessionButton } from '@/entrypoints/sidepanel/components/ReadinessDropdown';

// The header toggle is a three-state button: `idle` (pre-Start) and `stopped` (Stop hit mid-turn,
// session still open) both (re)Start; only `running` Stops. Before the fix `stopped` re-labelled
// "Stop" and re-aborted an already-idle turn, dead-ending the UI with no path back to chat.
describe('sessionButton', () => {
  it('Starts from the pre-Start idle state', () => {
    expect(sessionButton('idle')).toEqual({ label: 'Start', action: 'start' });
  });

  it('Stops a running session', () => {
    expect(sessionButton('running')).toEqual({ label: 'Stop', action: 'stop' });
  });

  it('treats a stopped session as resumable — Start, not a no-op re-Stop', () => {
    expect(sessionButton('stopped')).toEqual({ label: 'Start', action: 'start' });
  });
});
