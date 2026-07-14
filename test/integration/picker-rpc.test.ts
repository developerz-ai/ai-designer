import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPicker } from '@/dom/picker';
import type { ContentToSw, PanelToSw, PickerCmd } from '@/shared/messages';
import { PickerCmd as PickerCmdSchema } from '@/shared/messages';

// Integration — the START/STOP half of the element-picker seam: panel `start-picker`/`stop-picker`
// -> SW resolves the target tab and dispatches a `PickerCmd` to that tab's content script ->
// content parses it and drives the real picker. The pick -> focus RETURN path is covered by
// picker-focus.test.ts; this covers the outbound dispatch, which no test exercises.
//
// background.ts imports the WXT `#imports` virtual module and can't be imported under Vitest, so the
// `start-picker`/`stop-picker` `handle()` case is reproduced 1:1 (resolveTargetTab -> build PickerCmd
// -> chrome.tabs.sendMessage). REAL vs faked: real = the PickerCmd schema + the actual content-side
// consumption (content.ts's `PickerCmd.safeParse` -> `picker.start()/stop()` branch, driving a REAL
// createPicker on jsdom); faked = chrome.tabs.query/sendMessage (the cross-world bus). Assertions are
// on schema-parsed output + the real picker's emitted `picker-state`, not on a mock call count alone.

interface FakeTabs {
  query: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

// The content command bus: whatever the SW dispatches to a tab is captured, then (mirroring
// content.ts's onMessage listener) parsed with PickerCmd and applied to the real picker.
function installChromeFakes(
  opts: { tab?: { id?: number }; onCmd?: (cmd: PickerCmd) => void } = {},
): FakeTabs {
  const sendMessage = vi.fn(async (_tabId: number, raw: unknown) => {
    const parsed = PickerCmdSchema.safeParse(raw);
    if (parsed.success) opts.onCmd?.(parsed.data);
  });
  const query = vi.fn(async () => (opts.tab ? [opts.tab] : []));
  (globalThis as { chrome?: unknown }).chrome = { tabs: { query, sendMessage } };
  return { query, sendMessage };
}

// Mirrors background.ts's `case 'start-picker' | 'stop-picker'`.
async function handlePicker(msg: PanelToSw & { type: 'start-picker' | 'stop-picker' }) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id !== undefined) {
    const cmd: PickerCmd = { type: msg.type === 'start-picker' ? 'picker-start' : 'picker-stop' };
    await chrome.tabs.sendMessage(tab.id, cmd).catch(() => {});
  }
  return { ok: true };
}

afterEach(() => {
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

describe('integration: start-picker / stop-picker panel -> SW -> content', () => {
  it('start-picker dispatches a schema-valid picker-start that starts the real content picker', async () => {
    document.body.innerHTML = '<button id="b" data-testid="cta">Buy</button>';
    // The content half: a REAL picker whose emitted events we capture (content.ts wires this exact
    // PickerCmd.safeParse -> picker.start()/stop() branch).
    const pickerEvents: ContentToSw[] = [];
    const picker = createPicker((m) => pickerEvents.push(m), document);
    const applyToContent = (cmd: PickerCmd): void => {
      if (cmd.type === 'picker-start') picker.start();
      else picker.stop();
    };

    const { query, sendMessage } = installChromeFakes({ tab: { id: 42 }, onCmd: applyToContent });

    const ack = await handlePicker({ type: 'start-picker' });
    expect(ack).toEqual({ ok: true });

    // The SW resolved the active tab and dispatched to it.
    expect(query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(sendMessage).toHaveBeenCalledWith(42, { type: 'picker-start' });
    // The dispatched command is a valid PickerCmd (the cross-world contract holds).
    expect(PickerCmdSchema.safeParse({ type: 'picker-start' }).success).toBe(true);
    // …and it actually STARTED the real picker: it emitted picker-state active:true.
    expect(picker.isActive()).toBe(true);
    expect(pickerEvents).toContainEqual({ type: 'picker-state', active: true });
    picker.destroy();
  });

  it('stop-picker dispatches a schema-valid picker-stop that stops the real content picker', async () => {
    document.body.innerHTML = '<button id="b">Buy</button>';
    const pickerEvents: ContentToSw[] = [];
    const picker = createPicker((m) => pickerEvents.push(m), document);
    picker.start();
    pickerEvents.length = 0; // ignore the start event; assert only the stop dispatch's effect
    const applyToContent = (cmd: PickerCmd): void => {
      if (cmd.type === 'picker-start') picker.start();
      else picker.stop();
    };

    const { sendMessage } = installChromeFakes({ tab: { id: 7 }, onCmd: applyToContent });

    await handlePicker({ type: 'stop-picker' });

    expect(sendMessage).toHaveBeenCalledWith(7, { type: 'picker-stop' });
    expect(picker.isActive()).toBe(false);
    expect(pickerEvents).toContainEqual({ type: 'picker-state', active: false });
    picker.destroy();
  });

  it('no active tab is a silent no-op — nothing is dispatched to content', async () => {
    const { query, sendMessage } = installChromeFakes({ tab: undefined });

    const ack = await handlePicker({ type: 'start-picker' });

    expect(ack).toEqual({ ok: true });
    expect(query).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
