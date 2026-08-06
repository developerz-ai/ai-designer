import { createMemo, createSignal, For, Show } from 'solid-js';
import { i18n } from '#i18n';
import { Icon } from '../Icon';
import type { IconName } from '../icon-registry';
import { ToolChip, type ToolChipStatus } from './ToolChip';
import './ToolCallList.scss';

// The tool-activity region of one assistant turn (split out of `Message.tsx` — CLAUDE.md "SolidJS
// + SRP": that file was rendering prose, tool activity, an edits summary and an error, and the
// tool region takes the *opposite* visual grammar to the prose it sits under — quiet cards against
// unboxed body text). Render + map only: no fetching, no store import.
//
// Status is READ, never invented. The previous derivation in `Message.tsx` marked every non-last
// call `'done'`, on the claim that the SW only emits `tool-call` once a tool has run — that claim
// is false: `src/agent/loop.ts` emits on the AI SDK's tool-call stream part, i.e. when the model
// *requests* the call, before it executes. A failed edit (stale selector -> `ok: false` -> the
// agent retries elsewhere) therefore rendered as a green check claiming it landed. So: an outcome
// is shown only when the entry carries one, and the absence of an outcome is its own state.
export type ToolCallOutcome = 'pending' | 'running' | 'done' | 'failed';

/** One tool call as this list needs it. Structurally a superset of the store's `ToolCallEntry`,
 *  declared locally (not imported) so the list stays decoupled from the store's shape and keeps
 *  compiling while `ok`/`error` are being added upstream. */
export interface ToolCallView {
  tool: string;
  selector?: string;
  kind?: 'read' | 'act' | 'info';
  /** The call's real outcome, once the SW's `tool-result` event has been folded in. `undefined`
   *  means "we have not heard back" — rendered as pending/running, never as success. */
  ok?: boolean;
  /** Failure detail from the tool result, surfaced verbatim under a failed call. */
  error?: string;
}

export interface ToolCallListProps {
  calls: ToolCallView[];
  /** Whether the turn these calls belong to is still streaming. Only distinguishes "in flight"
   *  (spinner) from "settled with no result we ever saw" (static) — it can never turn an unknown
   *  outcome into a successful one. */
  streaming?: boolean;
}

/** The display state for one call. Pure so the truth table is unit-testable without mounting
 *  Solid (this is the derivation that moved out of `Message.tsx`).
 *
 *  `Partial<ToolCallView>` rather than `Pick<…, 'ok'>` deliberately — do not tighten it back. A
 *  type whose properties are all optional is a "weak type", and TS rejects an argument sharing
 *  none of them: the store's current `ToolCallEntry` (tool/selector/kind, no `ok` yet) is exactly
 *  that argument, so `Pick<…, 'ok'>` rejects the very call site this function exists for.
 *  `Partial<ToolCallView>` shares `tool` with an entry and `ok` with a bare `{ ok: true }`. */
export function toolCallOutcome(call: Partial<ToolCallView>, streaming = false): ToolCallOutcome {
  if (call.ok === true) return 'done';
  if (call.ok === false) return 'failed';
  return streaming ? 'running' : 'pending';
}

// `ToolChip` only speaks three states; pending and running share its spinner glyph and the list
// stills the animation for pending (see ToolCallList.scss).
const CHIP_STATUS: Record<ToolCallOutcome, ToolChipStatus> = {
  pending: 'running',
  running: 'running',
  done: 'done',
  failed: 'error',
};

/** Maps a display outcome onto the chip status `ToolChip` accepts. */
export function toolChipStatusFor(outcome: ToolCallOutcome): ToolChipStatus {
  return CHIP_STATUS[outcome];
}

// Resolved once at module scope (mirrors `ToolChip`'s KIND_LABEL).
const STATUS_LABEL: Record<ToolCallOutcome, string> = {
  pending: i18n.t('toolChip.status.pending'),
  running: i18n.t('toolChip.status.running'),
  done: i18n.t('toolChip.status.done'),
  failed: i18n.t('toolChip.status.failed'),
};

/** The outcome as a word. `ToolChip` carries status as an icon glyph and a border color, and
 *  both are `aria-hidden`/invisible to assistive tech — color alone is not a distinction (WCAG
 *  1.4.1). This is what actually tells a screen-reader user that a call failed. */
export function toolCallStatusLabel(outcome: ToolCallOutcome): string {
  return STATUS_LABEL[outcome];
}

/** The calls that stay on screen while the run is COLLAPSED: whatever is in flight, plus every
 *  failure. A plain "12 actions ⌄" that hides the one call currently running (and the one that
 *  just failed) buys tidiness by hiding the only two rows anybody wants — so the collapse keeps
 *  them and folds away the eleven successful ones instead. Pure: unit-testable without Solid. */
export function pinnedCalls(calls: ToolCallView[], streaming = false): ToolCallView[] {
  return calls.filter((call) => {
    const outcome = toolCallOutcome(call, streaming);
    return outcome === 'running' || outcome === 'failed';
  });
}

/** Glyph for the group header: what the run as a whole is doing. Spinner while anything is in
 *  flight, warning if anything failed, check once it all landed. Pure for the same reason. */
export function runGlyph(calls: ToolCallView[], streaming = false): IconName {
  const outcomes = calls.map((call) => toolCallOutcome(call, streaming));
  if (outcomes.includes('running')) return 'spinner';
  if (outcomes.includes('failed')) return 'warning';
  return 'check';
}

/** How many calls in this run failed — the "· 2 failed" the header appends. */
export function failedCount(calls: ToolCallView[], streaming = false): number {
  return calls.filter((call) => toolCallOutcome(call, streaming) === 'failed').length;
}

export function ToolCallList(props: ToolCallListProps) {
  // Collapsed by default. A turn routinely fires 6–12 calls, and a dozen expanded cards
  // pushed the assistant's actual answer off the top of the thread — the working notes
  // outweighed the work. Expanding is one click and the state is per-turn.
  const [open, setOpen] = createSignal(false);

  const streaming = () => props.streaming ?? false;
  const failed = createMemo(() => failedCount(props.calls, streaming()));
  const visible = createMemo(() => (open() ? props.calls : pinnedCalls(props.calls, streaming())));

  return (
    <Show when={props.calls.length > 0}>
      <div class="dz-tool-call-list">
        <button
          type="button"
          class="dz-tool-call-list__header"
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
        >
          <Icon
            name={runGlyph(props.calls, streaming())}
            size="sm"
            spin={runGlyph(props.calls, streaming()) === 'spinner'}
            class={`dz-tool-call-list__glyph is-${runGlyph(props.calls, streaming())}`}
          />
          <span class="dz-tool-call-list__count">
            {i18n.t('toolRun.actions', props.calls.length)}
          </span>
          <Show when={failed() > 0}>
            <span class="dz-tool-call-list__failed">· {i18n.t('toolRun.failed', failed())}</span>
          </Show>
          <Icon
            name="chevronDown"
            size="sm"
            class={`dz-tool-call-list__chevron${open() ? ' is-open' : ''}`}
          />
        </button>

        {/* Ordered: the sequence a turn's calls ran in is information, not incidental layout. */}
        <ol class="dz-tool-call-list__items">
          <For each={visible()}>
            {(call) => {
              const outcome = () => toolCallOutcome(call, streaming());
              return (
                <li
                  class="dz-tool-call-list__item"
                  classList={{ [`dz-tool-call-list__item--${outcome()}`]: true }}
                  data-status={outcome()}
                >
                  <ToolChip
                    tool={call.tool}
                    selector={call.selector}
                    kind={call.kind}
                    status={toolChipStatusFor(outcome())}
                  />
                  {/* Reads as "setStyle act — failed — no element matches #gone". Outside the
                      chip's button because `ToolChip` is another component's markup; inside the
                      same list item, so it is still part of the call it describes. */}
                  <span class="dz-tool-call-list__status">{toolCallStatusLabel(outcome())}</span>
                  {/* A failure says why, in the tool's own words — the one thing that makes a red
                      chip actionable rather than decorative. */}
                  <Show when={outcome() === 'failed' && call.error}>
                    {(message) => <p class="dz-tool-call-list__error">{message()}</p>}
                  </Show>
                </li>
              );
            }}
          </For>
        </ol>
      </div>
    </Show>
  );
}
