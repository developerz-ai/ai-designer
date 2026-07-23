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

/** The UNLOCKED sweep body, reproducing runResponsiveCapture 1:1: per breakpoint it applies the
 *  fake emulation, settles, and captures through the RAW path with the per-shot try/catch (one
 *  failed grab becomes that shot's `error`, never an aborted sweep — device-emulation.ts's
 *  contract). The LOCK belongs to the wrapper (background.ts's capture wrapper), so callers wrap
 *  this in the resolved-tab lock — a fused helper would make a wrong-key discriminator test
 *  impossible. */
async function sweepBody(
  world: World,
  widths: number[],
  opts: { failWidths?: Set<number>; fullPage?: boolean } = {},
) {
  const shots: Array<{ width: number; image?: string; error?: string }> = [];
  for (const width of widths) {
    world.page.viewportWidth = width; // applyDevice (fake CDP)
    await new Promise((r) => setTimeout(r, 1)); // EMULATION_SETTLE
    // The raw capture branch, mirroring background.ts: fullPage → captureFullPage direct with
    // try/catch; element → raw sendMessage.
    let shot: { image?: string; error?: string } = {};
    try {
      if (opts.failWidths?.has(width)) throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
      shot.image = opts.fullPage
        ? await captureFullPage(world, [0, 500])
        : ((await world.sendMessage(world.tabId, { type: 'screenshot' })) as { data: string }).data;
    } catch (err) {
      shot = { error: String(err) };
    }
    shots.push({ width, ...shot });
  }
  world.page.viewportWidth = 1280; // restoreDevice
  return shots;
}

/** Reproduces the responsiveCapture WRAPPER 1:1 (the #136 form): resolve the target tab, then
 *  hold THAT tab's lock for the whole sweep. */
function responsiveCaptureSweep(
  world: World,
  lock: Lock,
  widths: number[],
  opts: { failWidths?: Set<number>; fullPage?: boolean } = {},
) {
  return lock(world.tabId, () => sweepBody(world, widths, opts));
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
    // tablet. Robust under timer stretch: both chains are macrotask-chained, so the phases
    // interleave rather than collapsing into one tick.
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
    // tab). The wrapper's resolution step is reproduced here — `msg.tabId ?? defaultTab` — so a
    // source revert to locking the default tab fails this test (the discriminator leg proves it).
    const worldA = fakeWorld(3);
    const worldB = fakeWorld(9);
    const lock = createCaptureLock();
    const worlds = new Map([
      [3, worldA],
      [9, worldB],
    ]);
    const screenshotB = screenshotDispatchFor(worldB, lock);

    // The wrapper shape, mirrored 1:1: resolve the target, lock THAT tab, sweep its world.
    const sweepWrapper = (msg: { tabId?: number }, widths: number[], keyOverride?: number) => {
      const target = msg.tabId ?? worldA.tabId;
      return lock(keyOverride ?? target, () => sweepBody(worlds.get(target) ?? worldA, widths));
    };

    // Leg 1 (the fix): the sweep resolves + locks B; B's same-step stitch serializes behind it.
    const sweepOnB = sweepWrapper({ tabId: 9 }, [375, 768]);
    const stitchB = (async () => {
      await new Promise((r) => setTimeout(r, 1));
      return screenshotB.fullPage([0, 500, 1000]);
    })();
    await Promise.all([sweepOnB, stitchB]);
    await new Promise((r) => setTimeout(r, 10));

    expect(new Set(worldB.bandGrabs.map((b) => b.width)).size).toBe(1); // serialized
    expect(worldA.log).toEqual([]); // the default tab was never touched

    // Leg 2 (the discriminator): the pre-fix shape — the sweep runs on B but locks A — and B's
    // stitch interleaves with it (a width mix). This is the bug the resolution fix closes.
    const worldB2 = fakeWorld(19);
    const screenshotB2 = screenshotDispatchFor(worldB2, lock);
    const buggyWrapper = (msg: { tabId?: number }, widths: number[]) => {
      const target = msg.tabId ?? worldA.tabId;
      // The round-1 bug: resolve B for the sweep but take A's lock — B's stitch stays unlocked
      // against B's sweep.
      return lock(worldA.tabId, () => sweepBody(target === 19 ? worldB2 : worldA, widths));
    };
    const buggySweep = buggyWrapper({ tabId: 19 }, [375, 768]);
    const stitchB2 = (async () => {
      await new Promise((r) => setTimeout(r, 1));
      return screenshotB2.fullPage([0, 500, 1000]);
    })();
    await Promise.all([buggySweep, stitchB2]);

    expect(new Set(worldB2.bandGrabs.map((b) => b.width)).size).toBeGreaterThan(1);
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

  function teardown(
    reg: ReturnType<typeof registry>,
    lock: Lock,
    emulatedTabs: ReadonlySet<number>,
    owner: string,
  ) {
    // Mirrors background.ts's turn-finally teardown 1:1 (the Set form): per emulated tab, an
    // outer owns-check, then inside the lock callback a SECOND owns-check guards the queue-wait
    // window.
    const jobs: Promise<unknown>[] = [];
    for (const tabId of emulatedTabs) {
      if (!reg.owns(tabId, owner)) continue;
      jobs.push(
        lock(tabId, () => {
          if (!reg.owns(tabId, owner)) return Promise.resolve();
          return reg.restore(tabId);
        }),
      );
    }
    return Promise.all(jobs);
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
    const restoreA = teardown(reg, lock, new Set([9]), 'turn-A');

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

    await teardown(reg, lock, new Set([9]), 'turn-A');

    expect(reg.restored).toEqual([9]);
    expect(reg.owners.has(9)).toBe(false);
  });

  it('a turn that emulated TWO tabs tears BOTH down (the single-slot tracker would leak the first)', async () => {
    const reg = registry();
    const lock = createCaptureLock();
    reg.stamp(9, 'turn-A');
    reg.stamp(11, 'turn-A');

    await teardown(reg, lock, new Set([9, 11]), 'turn-A');

    expect(reg.restored.slice().sort((a, b) => a - b)).toEqual([9, 11]);
    expect(reg.owners.size).toBe(0);
  });

  it('a bare setDevice reset on the default tab does NOT clobber the record of an earlier emulated tab', async () => {
    // Mirrors the wrapper's Set bookkeeping 1:1: apply adds the resolved tab; reset deletes ONLY
    // its target. Turn A emulates tab 9, then issues setDevice({reset: true}) with no tabId
    // (resolving the default tab 3) — the reset must not erase tab 9's record.
    const reg = registry();
    const lock = createCaptureLock();
    reg.stamp(9, 'turn-A');
    const emulatedTabs = new Set<number>([9]);
    const defaultTabId = 3;
    // setDevice({reset:true}) with no tabId:
    const resetTarget = defaultTabId;
    emulatedTabs.delete(resetTarget);

    await teardown(reg, lock, emulatedTabs, 'turn-A');

    expect(reg.restored).toEqual([9]); // tab 9 still torn down
    expect(reg.owners.size).toBe(0);
  });
});
