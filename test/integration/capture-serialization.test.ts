// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createCaptureLock } from '@/agent/capture-lock';
import { shouldRideCaptureLock } from '@/agent/capture-policy';
import type { ToolResult } from '@/shared/messages';

// Integration — the #136 page-driver-vs-stitch serialization (src/entrypoints/background.ts
// `contentDispatchFor` + `screenshotDispatchFor` + `captureFullPage` + the emulation wrappers).
// background.ts can't be imported under Vitest (WXT `#imports`), so its dispatch topology is
// reproduced 1:1 here against the REAL per-tab capture lock (src/agent/capture-lock.ts) and a fake
// content world, exactly the established pattern (key-rpcs.test.ts, changeset-curate.test.ts).
// The lock POLICY (which message types ride) is NOT reproduced — it is imported from
// src/agent/capture-policy.ts, the same module the service worker reads, so the pin and the
// shipped policy can never drift apart. What remains a reproduction is the dispatch SHAPE (lock
// call sites + raw stitch internals) — an accepted residual while background.ts is unimportable.

type ContentMessage = { type: string; [k: string]: unknown };

/** The fake page + content-script world for ONE tab. scrollY/viewportWidth are the page state a
 *  driver or an emulation change moves; `log` is the observable timeline assertions read. */
function fakeWorld(tabId: number) {
  const page = { scrollY: 0, viewportWidth: 1280, mutations: 0 };
  const log: string[] = [];
  // chrome.tabs.sendMessage — the content side. Band scrolls arrive as ControlTool scrollTo (the
  // stitch's raw channel), drivers as their own types, page-metrics as itself.
  const sendMessage = (tab: number, message: ContentMessage): Promise<unknown> => {
    expect(tab).toBe(tabId);
    switch (message.type) {
      case 'page-metrics':
        return Promise.resolve({
          ok: true,
          metrics: {
            scrollY: page.scrollY,
            viewportHeight: 800,
            pageHeight: 2000,
            viewportWidth: page.viewportWidth,
          },
        });
      case 'scrollTo': // the stitch's raw per-band scroll AND the restore
        page.scrollY = message.y as number;
        log.push(`scroll:${page.scrollY}`);
        return Promise.resolve({ type: 'tool-result', ok: true });
      case 'click': // a driver: scrollIntoView under the hood
        page.scrollY = 777;
        log.push(`driver:click->scroll:${page.scrollY}`);
        return Promise.resolve({ type: 'tool-result', ok: true });
      case 'setStyle':
        page.mutations++;
        log.push('driver:setStyle');
        return Promise.resolve({ type: 'tool-result', ok: true });
      case 'screenshot': // element/viewport shot: captures the CURRENT scrollY
        log.push(`element-shot@${page.scrollY}`);
        return Promise.resolve({ type: 'tool-result', ok: true, data: `shot@${page.scrollY}` });
      case 'pageFacts': // a pure read — never locks
        log.push('read:pageFacts');
        return Promise.resolve({ type: 'tool-result', ok: true, data: {} });
      default:
        return Promise.resolve({ type: 'tool-result', ok: true });
    }
  };
  // chrome.tabs.captureVisibleTab — a band grab records the scrollY + viewport width at that
  // instant, so a mid-stitch driver scroll or emulation resize shows up as a corrupted band.
  const bandGrabs: Array<{ scrollY: number; width: number }> = [];
  const captureVisibleTab = (): Promise<string> => {
    bandGrabs.push({ scrollY: page.scrollY, width: page.viewportWidth });
    log.push(`band@${page.scrollY}w${page.viewportWidth}`);
    return Promise.resolve(`data:image/png;base64,band-${page.scrollY}`);
  };
  return { tabId, page, log, bandGrabs, sendMessage, captureVisibleTab };
}

type World = ReturnType<typeof fakeWorld>;
type Lock = ReturnType<typeof createCaptureLock>;

/** Reproduces background.ts's contentDispatchFor 1:1 (the #136 widened form): the policy decides
 *  (imported, never copied); the lock call is here. */
function contentDispatchFor(world: World, lock: Lock) {
  return async (message: ContentMessage): Promise<ToolResult> => {
    const send = async (): Promise<ToolResult> =>
      (await world.sendMessage(world.tabId, message)) as ToolResult;
    return shouldRideCaptureLock(message.type) ? lock(world.tabId, send) : send();
  };
}

/** Reproduces captureFullPage's band loop 1:1: raw band scrolls + settle + per-band grab +
 *  best-effort restore — never through the locking dispatch (the deadlock invariant). `onSettle`
 *  lets a test fire a contending driver INTO a settle window deterministically. */
async function captureFullPage(
  world: World,
  bands: number[],
  onSettle?: (bandIndex: number) => void,
): Promise<string> {
  const metrics = (
    (await world.sendMessage(world.tabId, { type: 'page-metrics' })) as {
      metrics: { scrollY: number };
    }
  ).metrics;
  const frames: string[] = [];
  try {
    for (let i = 0; i < bands.length; i++) {
      await world.sendMessage(world.tabId, { type: 'scrollTo', y: bands[i] });
      onSettle?.(i);
      await new Promise((r) => setTimeout(r, 1)); // the settle window
      frames.push(await world.captureVisibleTab());
    }
  } finally {
    await world.sendMessage(world.tabId, { type: 'scrollTo', y: metrics.scrollY }).catch(() => {});
  }
  return frames.join('|');
}

/** Reproduces screenshotDispatchFor's fullPage branch 1:1: the stitch holds the lock. */
function screenshotDispatchFor(world: World, lock: Lock) {
  return {
    fullPage: (bands: number[], onSettle?: (bandIndex: number) => void) =>
      lock(world.tabId, () => captureFullPage(world, bands, onSettle)),
  };
}

/** Reproduces the responsiveCapture sweep 1:1 (the #136 form): the WHOLE sweep holds the lock on
 *  the RESOLVED tab; per breakpoint it applies the fake emulation, settles, and captures through
 *  the RAW path with the per-shot try/catch (one failed grab becomes that shot's `error`, never
 *  an aborted sweep — device-emulation.ts's contract). */
function responsiveCaptureSweep(
  world: World,
  lock: Lock,
  widths: number[],
  opts: { failWidths?: Set<number>; fullPage?: boolean } = {},
) {
  const shots: Array<{ width: number; image?: string; error?: string }> = [];
  return lock(world.tabId, async () => {
    for (const width of widths) {
      world.page.viewportWidth = width; // applyDevice (fake CDP)
      await new Promise((r) => setTimeout(r, 1)); // EMULATION_SETTLE
      // The raw capture branch, mirroring background.ts: fullPage → captureFullPage direct with
      // try/catch; element → raw sendMessage.
      let shot: { image?: string; error?: string } = {};
      try {
        if (opts.failWidths?.has(width))
          throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
        shot.image = opts.fullPage
          ? await captureFullPage(world, [0, 500])
          : ((await world.sendMessage(world.tabId, { type: 'screenshot' })) as { data: string })
              .data;
      } catch (err) {
        shot = { error: String(err) };
      }
      shots.push({ width, ...shot });
    }
    world.page.viewportWidth = 1280; // restoreDevice
    return shots;
  });
}

/** The scroll timeline condensed: every `scroll:`/`driver:click->scroll:` event in order. */
const scrollEvents = (world: World): string[] =>
  world.log.filter((l) => l.startsWith('scroll:') || l.startsWith('driver:click'));

describe('integration: #136 page-driver vs full-page stitch serialization', () => {
  it('same-step click + fullPage: the driver scroll lands outside the stitch; bands are uncorrupted', async () => {
    const world = fakeWorld(3);
    const lock = createCaptureLock();
    const dispatch = contentDispatchFor(world, lock);
    const screenshot = screenshotDispatchFor(world, lock);
    const bands = [0, 500, 1000];

    // Same-step (the AI SDK Promise.all's them): the stitch starts; during band 0's settle the
    // click is dispatched. Under the widened lock it must queue behind the WHOLE stitch.
    const stitch = screenshot.fullPage(bands, (i) => {
      if (i === 0) void dispatch({ type: 'click', selector: '#cta' });
    });
    await stitch;
    // Let the queued driver's lock-turn complete.
    await new Promise((r) => setTimeout(r, 10));

    // Every band grabbed EXACTLY its planned scrollY — no 777-band corruption.
    expect(world.bandGrabs.map((b) => b.scrollY)).toEqual(bands);
    // The click's scroll landed AFTER the stitch's restore scroll (back to the pre-stitch 0).
    expect(scrollEvents(world)).toEqual([
      'scroll:0',
      'scroll:500',
      'scroll:1000',
      'scroll:0', // restore
      'driver:click->scroll:777',
    ]);
    // The driver's own intent still ran — correctly serialized, not lost.
    expect(world.page.scrollY).toBe(777);
  });

  it('same-step setStyle + fullPage: the mutation lands outside the stitch', async () => {
    const world = fakeWorld(3);
    const lock = createCaptureLock();
    const dispatch = contentDispatchFor(world, lock);
    const screenshot = screenshotDispatchFor(world, lock);
    const bands = [0, 500, 1000];

    const stitch = screenshot.fullPage(bands, (i) => {
      if (i === 1) void dispatch({ type: 'setStyle', selector: '#x', props: { color: 'red' } });
    });
    await stitch;
    await new Promise((r) => setTimeout(r, 10));

    expect(world.bandGrabs.map((b) => b.scrollY)).toEqual(bands);
    // setStyle ran exactly once, after the stitch (no interleaved layout shift).
    expect(world.page.mutations).toBe(1);
    expect(world.log.indexOf('driver:setStyle')).toBeGreaterThan(
      world.log.lastIndexOf('band@1000w1280'),
    );
  });

  it('REVERT DISCRIMINATOR: the pre-#136 topology (only screenshots locked) DOES corrupt a band', async () => {
    // This test pins the bug the widened lock fixes: with drivers UNLOCKED, a same-step click
    // lands mid-settle and a band captures the click target's viewport instead of its own. If the
    // family lock is ever reverted, the two tests above fail and this one documents why.
    const world = fakeWorld(3);
    const lock = createCaptureLock();
    const unlockedDispatch = async (message: ContentMessage): Promise<ToolResult> =>
      (await world.sendMessage(world.tabId, message)) as ToolResult;
    const screenshot = screenshotDispatchFor(world, lock);
    const bands = [0, 500, 1000];

    const stitch = screenshot.fullPage(bands, (i) => {
      if (i === 0) void unlockedDispatch({ type: 'click', selector: '#cta' });
    });
    await stitch;

    // The corrupted reality the lock exists to prevent: band 0's settle let the click through,
    // so band 0's grab captured the click target's viewport (777), not its own (0).
    expect(world.bandGrabs.map((b) => b.scrollY)).toEqual([777, 500, 1000]);
  });

  it('same-step responsiveCapture sweep + fullPage: no viewport resize lands mid-stitch, no self-deadlock', async () => {
    const world = fakeWorld(3);
    const lock = createCaptureLock();
    const screenshot = screenshotDispatchFor(world, lock);
    const bands = [0, 500, 1000];

    // The sweep holds the lock for its whole duration; its internal element capture rides the
    // RAW send (never the locking dispatch — or it self-deadlocks).
    const sweep = responsiveCaptureSweep(world, lock, [375, 768]);

    // Same-step: the stitch fires DURING the sweep's first breakpoint settle.
    const stitch = (async () => {
      await new Promise((r) => setTimeout(r, 1));
      return screenshot.fullPage(bands);
    })();

    await Promise.all([sweep, stitch]);
    await new Promise((r) => setTimeout(r, 10));

    // Both completed (no deadlock), and whichever ran second saw ONE consistent viewport width
    // across all its bands — never a mid-sweep mix.
    const widths = new Set(world.bandGrabs.map((b) => b.width));
    expect(widths.size).toBe(1);
    expect(world.bandGrabs.map((b) => b.scrollY)).toEqual(bands);
  });

  it('REVERT DISCRIMINATOR (emulation): an UNLOCKED sweep resizes mid-stitch and mixes band widths', async () => {
    // The emulation leg of the revert evidence: without the sweep holding the lock, its
    // applyDevice lands between the stitch's bands — some bands capture at phone width, some at
    // tablet. Deterministic: the width mix is in the sweep's own settle, no timing luck.
    const world = fakeWorld(3);
    const lock = createCaptureLock();
    const screenshot = screenshotDispatchFor(world, lock);
    const bands = [0, 500, 1000];

    // Unlocked sweep (the pre-#136 shape): apply + settle + raw capture, no lock.
    const sweep = (async () => {
      for (const width of [375, 768]) {
        world.page.viewportWidth = width;
        await new Promise((r) => setTimeout(r, 2));
      }
      world.page.viewportWidth = 1280;
    })();
    const stitch = screenshot.fullPage(bands, (i) => {
      if (i === 0) void sweep;
    });

    await Promise.all([sweep.catch(() => {}), stitch]);

    const widths = new Set(world.bandGrabs.map((b) => b.width));
    expect(widths.size).toBeGreaterThan(1); // the mix the lock exists to prevent
  });

  it('the emulation lock keys on the RESOLVED tab (a cross-tab sweep serializes against that tab’s stitch)', async () => {
    // Copy mode: the turn's default tab is A, but the model sweeps/captures tab B (the reference
    // tab). Locking A (the pre-fix shape) lets B's stitch interleave with B's sweep; the resolved
    // key serializes them.
    const worldB = fakeWorld(9);
    const lock = createCaptureLock();
    const screenshotB = screenshotDispatchFor(worldB, lock);

    // setDevice/sweep wrapper shape, mirrored 1:1: resolve the target, lock THAT tab.
    const sweepOnB = responsiveCaptureSweep(worldB, lock, [375, 768]);
    const stitchB = (async () => {
      await new Promise((r) => setTimeout(r, 1));
      return screenshotB.fullPage([0, 500, 1000]);
    })();

    await Promise.all([sweepOnB, stitchB]);
    await new Promise((r) => setTimeout(r, 10));

    const widths = new Set(worldB.bandGrabs.map((b) => b.width));
    expect(widths.size).toBe(1); // serialized: no mid-sweep resize landed in B's stitch
  });

  it('a failing fullPage grab inside a sweep becomes that shot’s error, never aborts the sweep', async () => {
    const world = fakeWorld(3);
    const lock = createCaptureLock();

    const shots = await responsiveCaptureSweep(world, lock, [375, 768, 1280], {
      failWidths: new Set([768]),
      fullPage: true,
    });

    // The 768 grab failed — the sweep kept going and reported per-shot.
    expect(shots).toHaveLength(3);
    expect(shots[0]?.image).toBeDefined();
    expect(shots[1]?.error).toContain('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
    expect(shots[2]?.image).toBeDefined();
    expect(world.page.viewportWidth).toBe(1280); // restoreDevice still ran
  });

  it('a pure read (pageFacts) is NOT stalled behind an in-flight stitch', async () => {
    const world = fakeWorld(3);
    const lock = createCaptureLock();
    const dispatch = contentDispatchFor(world, lock);
    const screenshot = screenshotDispatchFor(world, lock);

    const stitch = screenshot.fullPage([0, 500, 1000], (i) => {
      if (i === 1) void dispatch({ type: 'pageFacts' });
    });
    await stitch;

    // The read landed mid-stitch (between bands), unlocked — without moving the page.
    const readAt = world.log.indexOf('read:pageFacts');
    expect(readAt).toBeGreaterThan(world.log.indexOf('band@0w1280'));
    expect(readAt).toBeLessThan(world.log.indexOf('band@1000w1280'));
    expect(world.bandGrabs.map((b) => b.scrollY)).toEqual([0, 500, 1000]);
  });
});

describe('integration: #136 emulation teardown re-check (the TOCTOU the lock widened)', () => {
  // Reproduces background.ts's turn-finally teardown wrapper 1:1: owns-check outside, then
  // inside the lock callback a SECOND owns-check guards the queue-wait window.
  function registry() {
    const owners = new Map<number, string>();
    const restored: number[] = [];
    return {
      owners,
      restored,
      owns: (tabId: number, owner: string) => owners.get(tabId) === owner,
      stamp: (tabId: number, owner: string) => owners.set(tabId, owner),
      restore: async (tabId: number) => {
        restored.push(tabId);
        owners.delete(tabId);
      },
    };
  }

  function teardown(reg: ReturnType<typeof registry>, lock: Lock, tabId: number, owner: string) {
    if (reg.owns(tabId, owner)) {
      return lock(tabId, () => {
        if (!reg.owns(tabId, owner)) return Promise.resolve();
        return reg.restore(tabId);
      });
    }
    return Promise.resolve();
  }

  it('a superseding setDevice that stamps a new owner during the queue wait is NOT torn down', async () => {
    const reg = registry();
    const lock = createCaptureLock();
    reg.stamp(9, 'turn-A');

    // Turn B's setDevice is ALREADY QUEUED (T1) when turn A's finally runs (T2) — so A's
    // teardown entry lands behind it on the FIFO chain.
    const applyB = lock(9, async () => {
      reg.stamp(9, 'turn-B');
    });
    const restoreA = teardown(reg, lock, 9, 'turn-A');

    await Promise.all([restoreA, applyB]);
    await new Promise((r) => setTimeout(r, 10));

    // B stamped first; A's queued restore saw it inside the lock and SKIPPED — B's emulation
    // survives (a mid-turn detach of B's phone viewport, the silent-wrong-capture class, averted).
    expect(reg.restored).toEqual([]);
    expect(reg.owners.get(9)).toBe('turn-B');
  });

  it('the restore still runs when the turn genuinely still owns the emulation', async () => {
    const reg = registry();
    const lock = createCaptureLock();
    reg.stamp(9, 'turn-A');

    await teardown(reg, lock, 9, 'turn-A');

    expect(reg.restored).toEqual([9]);
    expect(reg.owners.has(9)).toBe(false);
  });
});
