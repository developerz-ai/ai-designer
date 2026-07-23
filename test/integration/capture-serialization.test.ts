// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createCaptureLock } from '@/agent/capture-lock';
import type { ToolResult } from '@/shared/messages';

// Integration — the #136 page-driver-vs-stitch serialization (src/entrypoints/background.ts
// `contentDispatchFor` + `screenshotDispatchFor` + `captureFullPage`). background.ts can't be
// imported under Vitest (WXT `#imports`), so its dispatch topology is reproduced 1:1 here against
// the REAL per-tab capture lock (src/agent/capture-lock.ts) and a fake content world, exactly the
// established pattern (key-rpcs.test.ts, changeset-curate.test.ts):
//   - every DomTool/ControlTool message rides withCaptureLock; the UNLOCKED_READS set is pure reads
//   - captureFullPage's band scrolls + metrics are RAW sends (never the locking dispatch — the
//     deadlock invariant), and the stitch itself holds the lock for its whole duration
//   - setDevice / responsiveCapture's sweep hold the lock; the sweep's internal captures are raw
// The fake content world records every scroll/mutation/capture with its scrollY at the time, so a
// corrupted band (a driver scroll landing mid-stitch) is directly observable.

const TAB_ID = 3;
const UNLOCKED_READS = new Set([
  'describe',
  'extractIdentity',
  'readImageContent',
  'readImages',
  'readChart',
  'chartTooltip',
  'pageFacts',
  'checkResponsive',
]);

type ContentMessage = { type: string; [k: string]: unknown };

/** The fake page + content-script world. scrollY/viewportWidth are the page state a driver or an
 *  emulation change moves; `log` is the observable timeline every assertion reads. */
function fakeWorld() {
  const page = { scrollY: 0, viewportWidth: 1280, mutations: 0 };
  const log: string[] = [];
  // chrome.tabs.sendMessage — the content side. Band scrolls arrive as ControlTool scrollTo (the
  // stitch's raw channel), drivers as their own types, page-metrics as itself.
  const sendMessage = (tabId: number, message: ContentMessage): Promise<unknown> => {
    expect(tabId).toBe(TAB_ID);
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
  return { page, log, bandGrabs, sendMessage, captureVisibleTab };
}

type World = ReturnType<typeof fakeWorld>;

/** Reproduces background.ts's contentDispatchFor 1:1 (the #136 widened form): every
 *  DomTool/ControlTool rides the lock; the pure-read set skips it. */
function contentDispatchFor(world: World, lock: ReturnType<typeof createCaptureLock>) {
  return async (message: ContentMessage): Promise<ToolResult> => {
    const send = async (): Promise<ToolResult> =>
      (await world.sendMessage(TAB_ID, message)) as ToolResult;
    return UNLOCKED_READS.has(message.type) ? send() : lock(TAB_ID, send);
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
    (await world.sendMessage(TAB_ID, { type: 'page-metrics' })) as {
      metrics: { scrollY: number };
    }
  ).metrics;
  const frames: string[] = [];
  try {
    for (let i = 0; i < bands.length; i++) {
      await world.sendMessage(TAB_ID, { type: 'scrollTo', y: bands[i] });
      onSettle?.(i);
      await new Promise((r) => setTimeout(r, 1)); // the settle window
      frames.push(await world.captureVisibleTab());
    }
  } finally {
    await world.sendMessage(TAB_ID, { type: 'scrollTo', y: metrics.scrollY }).catch(() => {});
  }
  return frames.join('|');
}

/** Reproduces screenshotDispatchFor's fullPage branch 1:1: the stitch holds the lock. */
function screenshotDispatchFor(world: World, lock: ReturnType<typeof createCaptureLock>) {
  return {
    fullPage: (bands: number[], onSettle?: (bandIndex: number) => void) =>
      lock(TAB_ID, () => captureFullPage(world, bands, onSettle)),
  };
}

/** The scroll timeline condensed: every `scroll:`/`driver:click->scroll:` event in order, with
 *  band-grab markers removed (they read scrollY without moving it). */
const scrollEvents = (world: World): string[] =>
  world.log.filter((l) => l.startsWith('scroll:') || l.startsWith('driver:click'));

describe('integration: #136 page-driver vs full-page stitch serialization', () => {
  it('same-step click + fullPage: the driver scroll lands outside the stitch; bands are uncorrupted', async () => {
    const world = fakeWorld();
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
    const world = fakeWorld();
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
    const world = fakeWorld();
    const lock = createCaptureLock();
    const unlockedDispatch = async (message: ContentMessage): Promise<ToolResult> =>
      (await world.sendMessage(TAB_ID, message)) as ToolResult;
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
    const world = fakeWorld();
    const lock = createCaptureLock();
    const screenshot = screenshotDispatchFor(world, lock);
    const bands = [0, 500, 1000];

    // Reproduce the responsive sweep topology 1:1: the WHOLE sweep holds the lock; its internal
    // element capture rides the RAW send (never the locking dispatch — or it self-deadlocks).
    const sweep = lock(TAB_ID, async () => {
      for (const width of [375, 768]) {
        world.page.viewportWidth = width; // applyDevice (fake CDP)
        await new Promise((r) => setTimeout(r, 1)); // EMULATION_SETTLE
        // The sweep's internal element capture — raw send, mirroring sendContentRaw's role.
        await world.sendMessage(TAB_ID, { type: 'screenshot', selector: '#hero' });
      }
      world.page.viewportWidth = 1280; // restoreDevice
    });

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

  it('a pure read (pageFacts) is NOT stalled behind an in-flight stitch', async () => {
    const world = fakeWorld();
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
