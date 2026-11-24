import { describe, expect, it } from 'vitest';
import { type CommitAbortContext, shouldAbortTurnOnCommit } from '@/agent/nav-abort';

// nav-abort unit (#148 item 2): the full decision table for "does this main-frame commit kill the
// running turn". The chrome glue (background.ts onCommitted) only reads state and applies the
// session-stop clears; every branch that must NOT abort is pinned here.

const base: CommitAbortContext = {
  frameId: 0,
  tabId: 7,
  runningTurnTabId: 7,
  turnRunning: true,
  agentNavInFlight: false,
};

describe('shouldAbortTurnOnCommit', () => {
  it('aborts on a cross-document main-frame commit of the running turn’s tab', () => {
    expect(shouldAbortTurnOnCommit(base)).toBe(true);
  });

  it('never aborts for an iframe commit', () => {
    expect(shouldAbortTurnOnCommit({ ...base, frameId: 3 })).toBe(false);
  });

  it('never aborts when no turn is running', () => {
    expect(shouldAbortTurnOnCommit({ ...base, turnRunning: false })).toBe(false);
    expect(shouldAbortTurnOnCommit({ ...base, turnRunning: false, runningTurnTabId: null })).toBe(
      false,
    );
  });

  it('never aborts for a commit on another tab', () => {
    expect(shouldAbortTurnOnCommit({ ...base, tabId: 8 })).toBe(false);
  });

  it('never aborts the agent’s own navigation (the runNav marker)', () => {
    expect(shouldAbortTurnOnCommit({ ...base, agentNavInFlight: true })).toBe(false);
  });
});
