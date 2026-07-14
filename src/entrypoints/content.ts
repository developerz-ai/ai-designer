import { defineContentScript } from '#imports';
import { extractDesignRead } from '@/dom/design-read';
import { createDomExecutor } from '@/dom/execute';
import { createMutator } from '@/dom/mutate';
import { createPicker } from '@/dom/picker';
import { queryOne, screenshotRect } from '@/dom/read';
import { createRecorder } from '@/dom/recorder';
import {
  type CaptureRequest,
  CaptureResult,
  type ContentToSw,
  DesignReadRequest,
  type DesignReadResult,
  DomTool,
  PickerCmd,
  type ToolResult,
} from '@/shared/messages';

// Content script — the only world with DOM access. It stays a THIN wire: Zod-gate inbound
// messages, hand them to the testable src/dom modules (executor + picker + recorder), and forward
// their ContentToSw events to the service worker. All logic lives in src/dom (jsdom-testable,
// coverage-counted); this entrypoint is coverage-excluded, so keep it minimal. Page mutations are
// EPHEMERAL + reversible (docs/idea/live-edit.md); the only durable output is the changeset (07).

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // Push picker/recorder events to the SW (fire-and-forget). relay.ts maps them to the panel;
    // the SW folds recorder events into the changeset (slice 07). A dropped push (SW evicted
    // mid-session) is recoverable, so swallow the rejection rather than spam the page console.
    const emit = (msg: ContentToSw): void => {
      void chrome.runtime.sendMessage(msg).catch(() => {});
    };

    const mutator = createMutator();
    const recorder = createRecorder(emit);
    const executor = createDomExecutor({ mutator, recorder });
    const picker = createPicker(emit);

    // Screenshot is split across worlds: content computes the crop rect (read.ts), the SW captures
    // + crops (only it has chrome.tabs.captureVisibleTab). Returns a base64 PNG data URL as
    // ToolResult.data for the agent's vision self-correction (slice 04).
    async function screenshot(selector?: string): Promise<ToolResult> {
      const el = selector ? queryOne(document, selector) : null;
      if (selector && !el) {
        return {
          type: 'tool-result',
          ok: false,
          error: `No element matches selector: ${selector}`,
        };
      }
      const { rect, devicePixelRatio } = screenshotRect(el);
      const request: CaptureRequest = { type: 'capture-visible-tab', rect, devicePixelRatio };
      const parsed = CaptureResult.safeParse(await chrome.runtime.sendMessage(request));
      if (!parsed.success) {
        return { type: 'tool-result', ok: false, error: 'Malformed capture result from the SW' };
      }
      const { ok, dataUrl, error } = parsed.data;
      return ok && dataUrl
        ? { type: 'tool-result', ok: true, data: dataUrl }
        : { type: 'tool-result', ok: false, error: error ?? 'Screenshot capture failed' };
    }

    function handleTool(tool: DomTool): Promise<ToolResult> {
      return tool.type === 'screenshot'
        ? screenshot(tool.selector)
        : Promise.resolve(executor.exec(tool));
    }

    // The SW addresses this tab with two message kinds: agent DomTool calls (reply with a
    // ToolResult) and user-driven PickerCmds (start/stop the overlay, no reply). Parse each with
    // its own schema; anything else is a foreign message and is ignored.
    chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
      // Cross-site browse (slice 06): the SW opened this page in a background tab and wants its
      // compact design identity. Pure DOM read (src/dom/design-read.ts); reply with a typed result
      // (an extraction failure degrades to an error the SW surfaces, never a dropped response).
      const design = DesignReadRequest.safeParse(raw);
      if (design.success) {
        try {
          const read = extractDesignRead(document, window, { maxColors: design.data.maxColors });
          sendResponse({ type: 'design-read-result', ok: true, read } satisfies DesignReadResult);
        } catch (err) {
          sendResponse({ type: 'design-read-result', ok: false, error: String(err) });
        }
        return; // responded synchronously
      }

      const tool = DomTool.safeParse(raw);
      if (tool.success) {
        // Always answer: a rejected round-trip (e.g. the SW evicted mid-screenshot) degrades to
        // an error ToolResult the agent can react to, never a dropped response / unhandled reject.
        handleTool(tool.data)
          .then(sendResponse)
          .catch((err) => sendResponse({ type: 'tool-result', ok: false, error: String(err) }));
        return true; // async ToolResult
      }
      const cmd = PickerCmd.safeParse(raw);
      if (cmd.success) {
        if (cmd.data.type === 'picker-start') picker.start();
        else picker.stop();
      }
      return; // no response for picker commands / foreign messages
    });
  },
});
