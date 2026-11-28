import { describe, expect, it } from 'vitest';
import { AGENT_NAV_GRACE_MS, AgentNavMarker, mayNavigate } from '@/agent/agent-nav';
import type { ContentRoutedMessage } from '@/agent/tab-guard';

// agent-nav unit: the "did the AGENT cause this commit?" window. Before it, only the nav drivers
// marked their tab, so an agent click on a link / a form submit that committed a new document
// aborted the turn as "page navigated away mid-turn".

const msg = (m: object): ContentRoutedMessage => m as ContentRoutedMessage;

describe('mayNavigate', () => {
  it('claims the interactions that can commit a new document', () => {
    expect(mayNavigate(msg({ type: 'click', selector: 'a' }))).toBe(true);
    expect(mayNavigate(msg({ type: 'pressKey', key: 'Enter' }))).toBe(true);
    expect(mayNavigate(msg({ type: 'selectOption', selector: 'select' }))).toBe(true);
    expect(mayNavigate(msg({ type: 'type', selector: 'input', text: 'q', submit: true }))).toBe(
      true,
    );
    expect(mayNavigate(msg({ type: 'pageOp', op: { op: 'pageCall', path: 'router.push' } }))).toBe(
      true,
    );
  });

  it('does not claim reads, plain typing, or design mutations', () => {
    expect(mayNavigate(msg({ type: 'type', selector: 'input', text: 'q' }))).toBe(false);
    expect(mayNavigate(msg({ type: 'query', selector: 'a' }))).toBe(false);
    expect(mayNavigate(msg({ type: 'hover', selector: 'a' }))).toBe(false);
    expect(mayNavigate(msg({ type: 'setStyle', selector: 'a' }))).toBe(false);
    expect(mayNavigate(msg({ type: 'pageOp', op: { op: 'box', selector: 'a' } }))).toBe(false);
  });
});

describe('AgentNavMarker', () => {
  function clocked() {
    let t = 1_000;
    const marker = new AgentNavMarker(AGENT_NAV_GRACE_MS, () => t);
    return { marker, advance: (ms: number) => (t += ms) };
  }

  it('is closed for a tab nothing marked', () => {
    expect(clocked().marker.has(7)).toBe(false);
  });

  it('is open while a marked call runs, only for its tab', () => {
    const { marker } = clocked();
    marker.begin(7);
    expect(marker.has(7)).toBe(true);
    expect(marker.has(8)).toBe(false);
  });

  it('stays open for the grace after the call returns — the commit lands after the click', () => {
    const { marker, advance } = clocked();
    marker.begin(7)();
    advance(AGENT_NAV_GRACE_MS - 1);
    expect(marker.has(7)).toBe(true);
    advance(1);
    expect(marker.has(7)).toBe(false);
  });

  it('nests overlapping calls: the window closes only after the last one', () => {
    const { marker, advance } = clocked();
    const first = marker.begin(7);
    const second = marker.begin(7);
    first();
    advance(AGENT_NAV_GRACE_MS * 2);
    expect(marker.has(7)).toBe(true); // second still running
    second();
    second(); // idempotent
    advance(AGENT_NAV_GRACE_MS);
    expect(marker.has(7)).toBe(false);
  });

  it('within() releases on throw', async () => {
    const { marker, advance } = clocked();
    await expect(
      marker.within(7, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    advance(AGENT_NAV_GRACE_MS);
    expect(marker.has(7)).toBe(false);
  });

  it('forget() drops a closed tab entirely', () => {
    const { marker } = clocked();
    marker.begin(7);
    marker.forget(7);
    expect(marker.has(7)).toBe(false);
  });
});

describe('AgentNavMarker.forget — outstanding releases go inert', () => {
  it('a release that lands after forget() does not recreate the window', () => {
    let t = 0;
    const marker = new AgentNavMarker(AGENT_NAV_GRACE_MS, () => t);
    const release = marker.begin(7);
    marker.forget(7); // the tab closed while the click was in flight
    release();
    expect(marker.has(7)).toBe(false);
    t += 1;
    expect(marker.has(7)).toBe(false);
  });
});
