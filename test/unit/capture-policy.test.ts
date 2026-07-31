import { describe, expect, it } from 'vitest';
import { shouldRideCaptureLock, UNLOCKED_READS } from '@/agent/capture-policy';

// capture-policy.ts unit: which content-routed message types ride the per-tab capture lock
// (#136) vs. run unlocked for read throughput (#168 widened the pure-read set). The integration
// suite pins the serialization behavior against the real lock; this pins the CLASSIFICATION so
// a policy regression fails fast and by name.

describe('UNLOCKED_READS: pure, scroll-independent reads run outside the capture lock', () => {
  it.each([
    'query', // selector resolve + stable-selector derivation — no rects, no scrolling
    'getStyles', // getComputedStyle projection — scroll-independent
    'a11ySnapshot', // role/name tree walk off attributes/text — scroll-independent
    'describe',
    'extractIdentity',
    'readImageContent',
    'readImages',
    'readChart',
    'pageFacts',
    'checkResponsive',
  ])('%s is unlocked', (type) => {
    expect(UNLOCKED_READS.has(type)).toBe(true);
    expect(shouldRideCaptureLock(type)).toBe(false);
  });
});

describe('shouldRideCaptureLock: everything that mutates, drives, scrolls, or captures locks', () => {
  it.each([
    // capture itself
    'screenshot',
    // mutations
    'setStyle',
    'setText',
    'setAttr',
    'addClass',
    'removeClass',
    'insertNode',
    'moveNode',
    'removeNode',
    'undo',
    // page drivers
    'click',
    'type',
    'hover',
    'scrollTo',
    'selectOption',
    'pressKey',
    'waitFor',
    // synthetic hover by another name (#145 review) — must stay locked
    'chartTooltip',
    // widget driver scrolls
    'widgetAct',
    // diagnostics `scan` reads layout geometry a mid-sweep resize would skew
    'diagnostics',
  ])('%s rides the lock', (type) => {
    expect(shouldRideCaptureLock(type)).toBe(true);
  });

  it('defaults unknown/future message types to locked — fail safe, not fast', () => {
    expect(shouldRideCaptureLock('someFutureTool')).toBe(true);
  });
});
