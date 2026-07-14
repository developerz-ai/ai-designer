import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultOutput,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { runTurn } from '@/agent/loop';
import type { DomDispatch } from '@/agent/tools/dom';
import type { IdentityDispatch } from '@/agent/tools/identity';
import { createDomExecutor } from '@/dom/execute';
import { extractIdentity } from '@/dom/identity';
import { createMutator } from '@/dom/mutate';
import { createRecorder } from '@/dom/recorder';
import type { IdentityResult, SwToPanel, ToolResult } from '@/shared/messages';

// Integration: the slice-14 copy spine end to end — `extractIdentity` reads a *reference*
// document's real design identity (src/dom/identity.ts, no fakes), the loop hands that identity to
// the model as its tool result, and the model's follow-up `setStyle` call lands on the *user's own*
// fixture DOM through the real executor/mutator/recorder (mirrors dom-execute.test.ts). Two
// separate `Document`s stand in for the reference tab and the user's own tab, exactly as
// `contentDispatchFor`'s `Target.tabId` addresses two different tabs in the real extension —
// proving "copy applies the extracted palette to the target fixture" without a chrome.* bus.

function usage(input: number, output: number): LanguageModelV4Usage {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: output, text: output, reasoning: undefined },
  };
}

const stream = (parts: LanguageModelV4StreamPart[]) => ({
  stream: convertArrayToReadableStream(parts),
});

const finish = (
  u: LanguageModelV4Usage,
  unified: 'stop' | 'tool-calls',
): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage: u,
  finishReason: { unified, raw: unified },
});

// Step 1 reads the reference's identity; step 2 applies its accent to the user's CTA; step 3 wraps up.
function copyModel(accentHex: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'Reading the reference identity. ' },
        { type: 'text-end', id: '1' },
        {
          type: 'tool-call',
          toolCallId: 'i1',
          toolName: 'extractIdentity',
          input: JSON.stringify({ tabId: 2 }),
        },
        finish(usage(300, 40), 'tool-calls'),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '2' },
        { type: 'text-delta', id: '2', delta: 'Applying its accent to your CTA. ' },
        { type: 'text-end', id: '2' },
        {
          type: 'tool-call',
          toolCallId: 's1',
          toolName: 'setStyle',
          input: JSON.stringify({ selector: '#cta', props: { 'background-color': accentHex } }),
        },
        finish(usage(350, 30), 'tool-calls'),
      ]),
      stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '3' },
        { type: 'text-delta', id: '3', delta: 'Done — your CTA now matches the reference brand.' },
        { type: 'text-end', id: '3' },
        finish(usage(400, 20), 'stop'),
      ]),
    ],
  });
}

// The reference "tab" — a distinct jsdom Document, extracted with the real, unmocked
// `extractIdentity`. Its CTA button is the only call-to-action, so its fill is unambiguously `accent`.
const REFERENCE_HTML = `<!doctype html><html><body style="background-color:#ffffff">
  <h1 style="color:#101014">Reference Co</h1>
  <button id="ref-cta" style="background-color:#ff3366;color:#ffffff">Shop</button>
</body></html>`;

function referenceIdentityDispatch(): IdentityDispatch {
  const dom = new JSDOM(REFERENCE_HTML);
  return async () => {
    const data: IdentityResult = extractIdentity(dom.window.document, dom.window as never);
    return { type: 'tool-result', ok: true, data };
  };
}

// The user's own fixture — the live jsdom `document`, mutated through the real DOM executor
// (mutator + recorder), exactly like dom-execute.test.ts.
function ownDomDispatch(): DomDispatch {
  document.head.innerHTML = '';
  document.body.innerHTML = '<h1 id="hero">My Hero</h1><button id="cta">Buy now</button>';
  const executor = createDomExecutor({
    mutator: createMutator(document),
    recorder: createRecorder(
      () => {},
      () => 0,
    ),
    doc: document,
  });
  return async (msg) => {
    if (msg.type === 'screenshot' || msg.type === 'diagnostics') {
      return { type: 'tool-result', ok: false, error: 'not supported in this fixture' };
    }
    return executor.exec(msg);
  };
}

function collectEmit() {
  const events: SwToPanel[] = [];
  return { events, emit: (event: SwToPanel) => events.push(event) };
}

function toolResultShownToModel(
  model: MockLanguageModelV4,
  step: number,
): LanguageModelV4ToolResultOutput | undefined {
  const prompt = model.doStreamCalls[step]?.prompt as LanguageModelV4Prompt | undefined;
  const last = prompt?.[prompt.length - 1];
  if (last?.role !== 'tool') return undefined;
  const [part] = last.content;
  return part?.type === 'tool-result' ? part.output : undefined;
}

describe('integration: copy mode reads a reference identity and applies it to the users own page', () => {
  it('extractIdentity reaches the model as the real reference palette, then setStyle paints its accent onto the CTA', async () => {
    const identity = referenceIdentityDispatch();
    const dispatch = ownDomDispatch();
    const { events, emit } = collectEmit();
    const model = copyModel('#ff3366');

    const outcome = await runTurn({
      tabId: 1,
      messages: [{ role: 'user', content: 'Copy the reference site colors onto my CTA' }],
      model,
      instructions: 'You are a design agent. This turn is a copy task.',
      dispatch,
      identity,
      emit,
    });

    // The reference's REAL extracted identity reached the model — role-tagged accent, not raw guesswork.
    const afterExtract = toolResultShownToModel(model, 1);
    expect(afterExtract?.type).toBe('json');
    if (afterExtract?.type !== 'json') throw new Error('unreachable');
    const extractResult = afterExtract.value as ToolResult;
    expect(extractResult.ok).toBe(true);
    const extracted = extractResult.data as IdentityResult;
    expect(extracted.palette).toContainEqual({ hex: '#ff3366', role: 'accent', count: 1 });

    // The CTA on the user's OWN page actually took the reference's accent color.
    expect(document.getElementById('cta')?.getAttribute('style')).toBeNull(); // via overrides, never inline
    expect(document.getElementById('dz-designer-overrides')?.textContent).toContain('#ff3366');

    const afterSetStyle = toolResultShownToModel(model, 2);
    expect(afterSetStyle?.type).toBe('json');
    if (afterSetStyle?.type !== 'json') throw new Error('unreachable');
    expect((afterSetStyle.value as ToolResult).ok).toBe(true);

    expect(events).toContainEqual({ type: 'tool-call', tool: 'extractIdentity' });
    expect(events).toContainEqual({ type: 'tool-call', tool: 'setStyle' });
    expect(outcome.stop).toBe('done');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
