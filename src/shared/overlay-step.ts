// Pure mapping from an agent tool call to the on-page overlay's step info (slice 09). Lives in
// src/shared (not src/agent or src/dom) so it has zero chrome.*/DOM deps: `agent/loop.ts` (SW)
// calls `classifyTool` to enrich the `tool-call` stream event, and `background.ts`'s
// `forwardOverlayStep` calls `overlayLabel` to compose the on-page card's text from that same
// event — one source of truth for both, easy to unit-test in isolation.

/** Cosmetic accent — `read`/`info` outline in indigo (the picker's hover color), `act` in emerald
 *  (its committed-selection color). Mirrors `src/dom/overlay.ts`'s `OverlayStepKind` without
 *  importing it (dom/ imports FROM shared/, never the reverse). */
export type OverlayStepKind = 'read' | 'act' | 'info';

// Tools that mutate the page (src/dom/mutate.ts, interact.ts, widgets.ts, the session recorder) —
// rendered in the overlay's "act" accent. Everything else is a "read" when it names a selector,
// else "info" (navigation, vision, tab/frame control, waits).
const ACT_TOOLS = new Set([
  'setStyle',
  'setText',
  'undo',
  'redo',
  'click',
  'type',
  'press',
  'hover',
  'select',
  'dragAndDrop',
  'widgetAct',
  'scrollTo',
  'setDevice',
  'recordEdit',
]);

export interface ToolCallClassification {
  selector?: string;
  kind: OverlayStepKind;
}

function selectorOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('selector' in input)) return undefined;
  const { selector } = input as { selector?: unknown };
  return typeof selector === 'string' ? selector : undefined;
}

/** Classify one tool call for the overlay: the element it targets (when its input names one) +
 *  a cosmetic read/act/info accent. */
export function classifyTool(tool: string, input: unknown): ToolCallClassification {
  const selector = selectorOf(input);
  const kind: OverlayStepKind = ACT_TOOLS.has(tool) ? 'act' : selector ? 'read' : 'info';
  return selector ? { selector, kind } : { kind };
}

/** Human-legible current-action label, e.g. `setStyle → .hero` or a bare `navigate` when there's
 *  no target selector. */
export function overlayLabel(tool: string, selector?: string): string {
  return selector ? `${tool} → ${selector}` : tool;
}
