import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { runTurn } from '@/agent/loop';
import type { DomDispatch } from '@/agent/tools/dom';
import { createOverlay, OVERLAY_HOST_ID, type Overlay } from '@/dom/overlay';
import type { OverlayCmd, SwToPanel } from '@/shared/messages';
import { overlayLabel } from '@/shared/overlay-step';

// Integration: a real agent turn's `tool-call` stream -> background.ts's `forwardOverlayStep`
// mirror -> content.ts's OverlayCmd handling -> the real overlay (src/dom/overlay.ts), minus the
// chrome bus (mirrors picker-focus.test.ts's "compose the way content.ts + background.ts actually
// wire them" approach; background.ts/content.ts themselves can't be imported under Vitest — they
// pull the WXT `#imports` virtual module, same reason agent-loop.test.ts reproduces the SW wiring
// rather than importing it).
//
// `forwardOverlayStep` below is a verbatim reproduction of background.ts's function of the same
// name (gate on `overlayEnabled`/`update.type`, compose the OverlayCmd via `overlayLabel`); the
// OverlayCmd handling is a verbatim reproduction of content.ts's `OverlayCmd.safeParse` branch.

function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: convertArrayToReadableStream(parts),
});

const finish = (u: LanguageModelV4Usage): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage: u,
  finishReason: { unified: 'stop', raw: 'stop' },
});

// A model that narrates a setStyle on #cta then wraps up — one `tool-call` event, mirroring
// agent-loop.test.ts's `twoStepModel` but trimmed to what this test needs (the forwarded step).
function setStyleModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 't1',
          toolName: 'setStyle',
          input: JSON.stringify({ selector: '#cta', props: { 'background-color': '#f97316' } }),
        },
        finish(usage(50, 10)),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '2' },
        { type: 'text-delta', id: '2', delta: 'Done.' },
        { type: 'text-end', id: '2' },
        finish(usage(20, 5)),
      ]),
    ],
  });
}

function fakeContent(): DomDispatch {
  return async () => ({
    type: 'tool-result',
    ok: true,
    data: { 'background-color': '#f97316' },
  });
}

// Verbatim mirror of background.ts's `forwardOverlayStep`: gated on the opt-in flag, forwards only
// `tool-call` events as an `overlay-step` OverlayCmd via the injected `send` (stands in for
// `chrome.tabs.sendMessage`).
function makeForwarder(overlayEnabled: boolean, send: (cmd: OverlayCmd) => void) {
  return (update: SwToPanel): void => {
    if (!overlayEnabled || update.type !== 'tool-call') return;
    const cmd: OverlayCmd = {
      type: 'overlay-step',
      label: overlayLabel(update.tool, update.selector),
      selector: update.selector,
      kind: update.kind,
    };
    send(cmd);
  };
}

// Verbatim mirror of content.ts's `OverlayCmd.safeParse` branch: toggle vs step, driving the real
// overlay instance exactly as the content script does.
function driveOverlayFromContent(overlay: Overlay, cmd: OverlayCmd): void {
  if (cmd.type === 'overlay-toggle') overlay.toggle(cmd.enabled);
  else overlay.step({ label: cmd.label, selector: cmd.selector, kind: cmd.kind });
}

const alive: Overlay[] = [];
function spawnOverlay(): Overlay {
  const overlay = createOverlay(document);
  alive.push(overlay);
  return overlay;
}

afterEach(() => {
  for (const o of alive.splice(0)) o.destroy();
  document.body.innerHTML = '';
});

describe('integration: tool-call forwarding to the on-page overlay', () => {
  it('overlay-on: a tool-call reaches content and renders on the real overlay', async () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    const overlay = spawnOverlay();
    overlay.enable(); // content.ts's restore-from-storage at document_idle, opted in

    const sent: OverlayCmd[] = [];
    const forward = makeForwarder(true, (cmd) => {
      sent.push(cmd);
      driveOverlayFromContent(overlay, cmd);
    });
    const panelEvents: SwToPanel[] = [];
    const emit = (update: SwToPanel): void => {
      panelEvents.push(update);
      forward(update);
    };

    await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA orange' }],
      model: setStyleModel(),
      instructions: 'You are a design agent.',
      dispatch: fakeContent(),
      emit,
    });

    // The panel still saw the tool-call chip (forwarding is additive, never a replacement).
    expect(panelEvents).toContainEqual(
      expect.objectContaining({ type: 'tool-call', tool: 'setStyle', selector: '#cta' }),
    );

    // Exactly one step forwarded, composed via the same `overlayLabel` the panel chip would use.
    expect(sent).toEqual([
      { type: 'overlay-step', label: 'setStyle → #cta', selector: '#cta', kind: 'act' },
    ]);

    // Content rendered it on the real overlay: banner text + a visible highlight on #cta.
    const host = document.getElementById(OVERLAY_HOST_ID);
    const root = host?.shadowRoot;
    if (!root) throw new Error('overlay host not mounted');
    expect(root.querySelector('.dz-now')?.textContent).toBe('setStyle → #cta');
    expect(root.querySelector('.dz-now')?.classList.contains('dz-act')).toBe(true);
    expect(root.querySelector('.dz-mark')?.classList.contains('dz-hidden')).toBe(false);
    expect(root.querySelector('.dz-mark')?.classList.contains('dz-act')).toBe(true);
  });

  it('overlay-off: nothing is forwarded and the page gets no overlay DOM', async () => {
    document.body.innerHTML = '<button id="cta">Buy</button>';
    // Deliberately never `enable()`d — mirrors the default opt-out: content.ts's restore reads
    // `false` from storage and never mounts the host.
    const overlay = spawnOverlay();

    const sent: OverlayCmd[] = [];
    const forward = makeForwarder(false, (cmd) => {
      sent.push(cmd);
      driveOverlayFromContent(overlay, cmd);
    });
    const emit = (update: SwToPanel): void => forward(update);

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'make the CTA orange' }],
      model: setStyleModel(),
      instructions: 'You are a design agent.',
      dispatch: fakeContent(),
      emit,
    });

    expect(outcome.stop).toBe('done'); // the turn itself is unaffected by the opt-out
    expect(sent).toEqual([]); // nothing forwarded
    expect(document.getElementById(OVERLAY_HOST_ID)).toBeNull(); // no DOM added
  });
});
