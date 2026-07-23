import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { i18n } from '#i18n';
import { addEdit, type Changeset } from '@/shared/changeset';
import type { Mode, PanelToSw, SwToPanel } from '@/shared/messages';
import { ChangesetResult, HandoffResult, type ShipRequest } from '@/shared/messages';
import { request } from './bus';
import { connectPort, subscribeToSw } from './sw-stream';

// Changeset/Ship store: thin reflection of the SW session (src/changeset/store.ts) driving
// ShipBar + TaskTimeline. Every mutation is an RPC (`ship`/`download-report`/`send-report`,
// src/entrypoints/background.ts `runHandoffRoute`) — this module never authors a report or talks
// to MCP itself, it only dispatches and folds the `changeset`/`task-status` push stream into local
// state (CLAUDE.md "SolidJS + SRP" — ShipBar/TaskTimeline stay render + dispatch only). The one
// piece of real logic it owns is the download side-effect: a report route replies with Markdown,
// not a file, so turning that into a saved `.md` (blob URL, own origin — CSP-clean, no remote
// fetch) belongs here rather than in a component.

/** One task's live status on the Ship timeline — the non-`type` fields of the `task-status`
 *  stream message (`src/shared/messages.ts` `SwToPanel`). */
export type TaskStatus = Omit<Extract<SwToPanel, { type: 'task-status' }>, 'type'>;

/** Pure fold: apply one SW->panel message onto the live changeset. Unrelated message types are a
 *  no-op (identity) — mirrors `stores/mcp.ts` `reduceServers`. Exported for a mock-free unit test. */
export function reduceChangeset(changeset: Changeset | null, msg: SwToPanel): Changeset | null {
  if (msg.type === 'changeset') return msg.changeset;
  // A live `edit-recorded` (the agent's recordEdit mid-turn) appends to the running changeset so the
  // Diff tab stays live. It carries only the Edit (no url/sessionId), so it can only EXTEND an
  // existing changeset — the Diff tab seeds the base via `changeset-get` on mount, and a `changeset`
  // push (agent undo/redo) replaces it wholesale.
  if (msg.type === 'edit-recorded') {
    if (!changeset) return changeset;
    // Mount race: recordEdit emits the push AFTER persisting, so a `changeset-get` reply can already
    // carry this edit while its in-flight push arrives later (the two channels are unordered) —
    // drop the immediate duplicate instead of showing one row twice (#141 review).
    const last = changeset.edits[changeset.edits.length - 1];
    if (last && sameEdit(last, msg.edit)) return changeset;
    return addEdit(changeset, msg.edit);
  }
  return changeset;
}

/** Structural equality for the duplicate-append guard above: both copies derive from the same
 *  recorded Edit object (storage round-trip vs live push), so key order is stable in practice. */
function sameEdit(a: Changeset['edits'][number], b: Changeset['edits'][number]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Pure fold: upsert one task's status by `taskId` onto the timeline, preserving arrival order for
 *  unseen tasks (index/total come from the SW's fan-out, not recomputed here). */
export function reduceTasks(tasks: TaskStatus[], msg: SwToPanel): TaskStatus[] {
  if (msg.type !== 'task-status') return tasks;
  const { type: _type, ...status } = msg;
  const idx = tasks.findIndex((t) => t.taskId === status.taskId);
  if (idx === -1) return [...tasks, status];
  const next = tasks.slice();
  next[idx] = status;
  return next;
}

const [changeset, setChangeset] = createSignal<Changeset | null>(null);
const [tasks, setTasks] = createStore<TaskStatus[]>([]);
const [shipping, setShipping] = createSignal(false);
const [error, setError] = createSignal<string | null>(null);
// Set on a `routed:'report'` reply with a `reason` (e.g. "no backend connected") so ShipBar can
// show why Ship fell back to a download instead of dispatching — informational, not an error.
const [fallbackReason, setFallbackReason] = createSignal<string | null>(null);
// Diff-tab undo/redo availability (#10). `canUndo` is derivable from the record's edit count, but
// `canRedo` is NOT (a `Changeset` doesn't carry the redo stack), so both are owned by the
// authoritative `ChangesetResult` RPC replies (`refreshChangeset` / `curate`). `curating` disables
// the Diff-tab controls while one of those RPCs is in flight.
const [canUndo, setCanUndo] = createSignal(false);
const [canRedo, setCanRedo] = createSignal(false);
const [curating, setCurating] = createSignal(false);
// The tab the Diff view is currently keyed to (from the last applied `ChangesetResult.tabId`), and
// the Diff tab's OWN error surface — kept separate from the shared `error` so a curation hint can
// neither overwrite nor erase an unread Ship error on the Chat surface (#141 review).
const [viewTabId, setViewTabId] = createSignal<number | null>(null);
const [diffError, setDiffError] = createSignal<string | null>(null);

export {
  canRedo,
  canUndo,
  changeset,
  curating,
  diffError,
  error,
  fallbackReason,
  shipping,
  tasks,
  viewTabId,
};

let wired = false;

/** Open the SW port and fold incoming `changeset`/`task-status` pushes into local state. Idempotent
 *  — safe to call on every ShipBar/TaskTimeline mount. */
export function initChangesetStore(): void {
  if (wired) return;
  wired = true;
  connectPort();
  subscribeToSw((msg) => {
    if (msg.type === 'changeset' || msg.type === 'edit-recorded') {
      // A record push stamped for ANOTHER tab must not overwrite this panel's view (the SW
      // broadcasts to every open panel, and a turn keeps running when the user switches tabs
      // mid-turn — its pushes arrive stamped for the turn's tab). Unstamped pushes fold as before.
      if (msg.tabId !== undefined && msg.tabId !== viewTabId()) return;
      const next = reduceChangeset(changeset(), msg);
      setChangeset(next);
      // Keep canUndo live off the record; canRedo stays owned by the RPC replies — except on
      // `edit-recorded`, where a record mid-turn always forks history (clears the redo stack), so
      // canRedo is derivable: false (store.ts `record`).
      setCanUndo((next?.edits.length ?? 0) > 0);
      if (msg.type === 'edit-recorded') setCanRedo(false);
    }
    // reconcile (keyed by `taskId`) so a status push updates only the changed task's fields —
    // a plain array replace remounts every keyed `<For>` row in TaskTimeline.
    else if (msg.type === 'task-status')
      setTasks(reconcile(reduceTasks(tasks, msg), { key: 'taskId' }));
    // A turn just finished (or was Stopped — the aborted turn's finally never emits turn-done, so
    // the non-running session-state is the only settle signal on that path) — the agent may have
    // recorded/undone edits, so refresh authoritative undo/redo availability for the now-enabled
    // Diff-tab controls. Skipped while a curation RPC is in flight: its reply is newer.
    else if (msg.type === 'turn-done') {
      if (!curating()) void refreshChangeset();
    } else if (msg.type === 'session-state' && msg.state !== 'running') {
      if (!curating()) void refreshChangeset();
    }
  });
  // The side panel is window-scoped but the changeset is per-tab: follow tab switches so the Diff
  // view always shows the record of the tab the user is looking at (guarded — the unit-test chrome
  // fake carries only `runtime`; #141 review).
  const retarget = (): void => {
    if (!curating()) void refreshChangeset();
  };
  chrome.tabs?.onActivated?.addListener?.(retarget);
  chrome.windows?.onFocusChanged?.addListener?.(retarget);
}

// --- diff review: changeset curation (slice 10) --------------------------------------------------
// The Diff tab's read + mutators. Each is a dispatch-only RPC through the SW, which owns the durable
// ChangesetStore; `ChangesetPreview` stays render + dispatch only. These curate the shippable record
// — never the live page. Fold the authoritative reply (`changeset` + undo/redo availability) into
// local state; a `busy` reply means a turn is in flight, so the op was rejected server-side.

/** Fold an authoritative `ChangesetResult` (RPC reply) into local state. A clean success also
 *  clears any prior Diff hint (a drift banner / busy hint must not outlive the state that resolved
 *  it); busy + failure replies leave `diffError` as their caller set it. */
function applyChangesetView(r: ChangesetResult): void {
  setChangeset(r.changeset);
  setCanUndo(r.canUndo);
  setCanRedo(r.canRedo);
  if (r.tabId !== null) setViewTabId(r.tabId);
  if (r.ok && !r.busy) setDiffError(null);
}

// Monotonic counters making view application last-writer-wins: `viewSeq` is bumped at every
// `curate` start, so a `changeset-get` whose reply lands AFTER a mutator began is stale (it read
// the pre-op record) and must not be applied; `refreshSeq` is bumped at every refresh CALL, so
// back-to-back refreshes (rapid tab switches) apply only the newest reply (#141 review).
let viewSeq = 0;
let refreshSeq = 0;

/** Pull the active tab's changeset + undo/redo availability — Diff-tab mount, tab switch, or after
 *  a turn. The reply keys the view to the tab it describes (`viewTabId`). A not-ok reply (SW-side
 *  read failure) surfaces its error and leaves the current view alone. */
export async function refreshChangeset(): Promise<void> {
  const seq = viewSeq;
  const refresh = ++refreshSeq;
  try {
    const r = await request({ type: 'changeset-get' }, ChangesetResult);
    if (seq !== viewSeq || refresh !== refreshSeq) return;
    if (!r.ok) {
      setDiffError(r.error ?? i18n.t('diff.failed'));
      return;
    }
    applyChangesetView(r);
  } catch (e) {
    setDiffError(errMsg(e));
  }
}

/** One curation round-trip (undo/redo/clear/remove). Disables the controls (`curating`) for its
 *  duration; a `busy` reply (turn in flight) surfaces a hint and leaves state as the SW reports it.
 *  A `tab-drift` reply means the view was stale (tab switch) and the op was refused — refresh to
 *  the newly active tab's record. A hard-failure reply (`!ok`, e.g. a storage error) surfaces the
 *  error and leaves the view alone — the durable record is intact, so blanking the list would lie.
 *  Errors land in the Diff-local `diffError`, never the Ship one. */
async function curate(msg: PanelToSw): Promise<void> {
  // Never curate an unkeyed view: with no confirmed viewTabId the SW's drift check is blind
  // (`forTabId` undefined) — re-key first instead of gambling on the active tab (#141 review).
  if (viewTabId() === null) {
    setDiffError(i18n.t('diff.failed'));
    void refreshChangeset();
    return;
  }
  viewSeq++;
  setCurating(true);
  setDiffError(null);
  try {
    const r = await request(msg, ChangesetResult);
    if (!r.ok && r.error === 'tab-drift') {
      setDiffError(i18n.t('diff.tabDrift'));
      void refreshChangeset();
      return;
    }
    if (r.busy) {
      setDiffError(i18n.t('diff.busy'));
      applyChangesetView(r); // busy echoes the current record — safe to reflect
    } else if (!r.ok) {
      setDiffError(r.error ?? i18n.t('diff.failed'));
    } else {
      applyChangesetView(r);
    }
  } catch (e) {
    setDiffError(errMsg(e));
  } finally {
    setCurating(false);
  }
}

export const undoEdit = (): Promise<void> =>
  curate({ type: 'changeset-undo', forTabId: viewTabId() ?? undefined });
export const redoEdit = (): Promise<void> =>
  curate({ type: 'changeset-redo', forTabId: viewTabId() ?? undefined });
export const clearChangeset = (): Promise<void> =>
  curate({ type: 'changeset-clear', forTabId: viewTabId() ?? undefined });
export const removeEdit = (index: number): Promise<void> =>
  curate({ type: 'changeset-remove-edit', index, forTabId: viewTabId() ?? undefined });

export interface ShipOptions {
  /** Raw recorded edits vs. the agent-authored brief. Defaults to `'report'` — the brief is what
   *  both the tasks route and the download fallback ship. */
  source?: 'changeset' | 'report';
  /** Named backend (MCP server id/label) to prefer; omitted lets the SW pick the first connected
   *  one that maps this page's origin to a repo. */
  target?: string;
  mode?: Mode;
  /** Non-empty ⇒ one `task(create)` per problem (multi-task fan-out). */
  problems?: string[];
  title?: string;
}

/** Ship button: connected backend + mapped repo ⇒ dispatches `task(create)` and the `task-status`
 *  stream (folded by `initChangesetStore`) drives TaskTimeline; otherwise the reply carries the
 *  Markdown brief, saved immediately via a blob-URL download. Never throws — failures land in
 *  `error()`. */
export async function ship(opts: ShipOptions = {}): Promise<void> {
  setShipping(true);
  setError(null);
  setFallbackReason(null);
  try {
    const msg: ShipRequest = {
      type: 'ship',
      source: opts.source ?? 'report',
      target: opts.target,
      mode: opts.mode,
      problems: opts.problems,
      title: opts.title,
    };
    const r = await request(msg, HandoffResult);
    applyHandoffResult(r);
  } catch (e) {
    setError(errMsg(e));
  } finally {
    setShipping(false);
  }
}

/** Download-brief button: always the agent-authored Markdown brief, never a dispatch — saved via a
 *  blob URL as soon as the SW replies. */
export async function downloadReport(mode?: Mode): Promise<void> {
  setShipping(true);
  setError(null);
  try {
    const r = await request({ type: 'download-report', mode }, HandoffResult);
    applyHandoffResult(r);
  } catch (e) {
    setError(errMsg(e));
  } finally {
    setShipping(false);
  }
}

/** "Send to <backend>" — from ShipBar's picker or a chat command. Falls back to a downloadable
 *  brief (same as `ship`) when `target` isn't connected or the origin has no repo mapped. */
export async function sendReport(
  target: string,
  opts: { mode?: Mode; problems?: string[] } = {},
): Promise<void> {
  setShipping(true);
  setError(null);
  setFallbackReason(null);
  try {
    const r = await request(
      { type: 'send-report', target, mode: opts.mode, problems: opts.problems },
      HandoffResult,
    );
    applyHandoffResult(r);
  } catch (e) {
    setError(errMsg(e));
  } finally {
    setShipping(false);
  }
}

function applyHandoffResult(r: HandoffResult): void {
  if (!r.ok) {
    setError(r.error ?? i18n.t('ship.error.failed'));
    return;
  }
  if (r.routed === 'report' && r.markdown) {
    saveMarkdown(r.markdown, r.filename ?? 'design-report.md');
    if (r.reason) setFallbackReason(r.reason);
  }
  // routed === 'tasks': task-status pushes (already wired via initChangesetStore) drive the
  // timeline; nothing further to apply from the RPC reply itself.
}

/** Save a Markdown string as a downloaded file via a blob URL — own-origin, no network, no remote
 *  code (CLAUDE.md "MV3 three worlds"). The only DOM touched by this store; isolated here so the
 *  ship/download/send actions above stay chrome-and-DOM-free apart from this one side effect. */
export function saveMarkdown(markdown: string, filename: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
