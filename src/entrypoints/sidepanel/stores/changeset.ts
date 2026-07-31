import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { i18n } from '#i18n';
import { addEdit, type Changeset } from '@/shared/changeset';
import type { Mode, PanelToSw, SwToPanel } from '@/shared/messages';
import { ChangesetResult, HandoffResult, type ShipRequest } from '@/shared/messages';
import { request } from './bus';
import { connectPort, onReconnect, subscribeToSw } from './sw-stream';

// Changeset/Ship store: thin reflection of the SW session (src/changeset/store.ts) driving
// ShipBar + TaskTimeline. Every mutation is an RPC (`ship`/`download-report`/`send-report`,
// src/entrypoints/background.ts `runHandoffRoute`) — this module never authors a report or talks
// to MCP itself, it only dispatches and folds the `changeset`/`task-status` push stream into local
// state (CLAUDE.md "SolidJS + SRP" — ShipBar/TaskTimeline stay render + dispatch only). The one
// piece of real logic it owns is the download side-effect: a report route replies with Markdown,
// not a file, so turning that into a saved `.md` (blob URL, own origin — CSP-clean, no remote
// fetch) belongs here rather than in a component.

/** One task's live status on the Ship timeline — the non-`type` fields of the `task-status`
 *  stream message (`src/shared/messages.ts` `SwToPanel`), plus the row identity below. */
export type TaskStatus = Omit<Extract<SwToPanel, { type: 'task-status' }>, 'type'> & {
  /** Row identity for the timeline — `taskId` is NOT one: a `create` that throws never got an id,
   *  and `src/mcp/handoff.ts`'s `dispatchTask` emits its catch with `taskId: ''` (see its
   *  `let taskId = ''`). Three failing creates then collapsed onto a single row reading
   *  "task 3/3", telling the user two tasks had been created. `index` is unique per fan-out. */
  key: string;
};

/** Row identity for one `task-status` push (see `TaskStatus.key`). */
export function taskRowKey(msg: { taskId: string; index: number }): string {
  return msg.taskId || `idx:${msg.index}`;
}

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
 *  recorded Edit object (storage round-trip vs live push), so key order is stable in practice.
 *  Accepted residual (#142 item 7): two genuinely byte-identical consecutive recordEdits in one
 *  turn read as a delivery-duplicate — the second push is dropped, and the view heals at settle. */
function sameEdit(a: Changeset['edits'][number], b: Changeset['edits'][number]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Undo-shape test for a `changeset` push against the view it replaces (#142 item 15): same
 *  session, exactly one edit shorter, the survivor a strict prefix. An agent session-undo always
 *  has this shape — and so can a fork that drops the last edit (another panel's remove-last, a
 *  preserveRedo retract of it), which the panel cannot tell apart without a new bus field. */
function isUndoShaped(prior: Changeset | null, incoming: Changeset): boolean {
  if (!prior || prior.sessionId !== incoming.sessionId) return false;
  if (incoming.edits.length !== prior.edits.length - 1) return false;
  return incoming.edits.every((e, i) => {
    const before = prior.edits[i];
    return before !== undefined && sameEdit(before, e);
  });
}

/** Pure fold: upsert one task's status by row identity onto the timeline, preserving arrival order
 *  for unseen tasks (index/total come from the SW's fan-out, not recomputed here). */
export function reduceTasks(tasks: TaskStatus[], msg: SwToPanel): TaskStatus[] {
  if (msg.type !== 'task-status') return tasks;
  const { type: _type, ...status } = msg;
  const row: TaskStatus = { ...status, key: taskRowKey(msg) };
  const idx = tasks.findIndex((t) => t.key === row.key);
  if (idx === -1) return [...tasks, row];
  const next = tasks.slice();
  next[idx] = row;
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

// Set when a tab-switch retarget (onActivated/onFocusChanged) or a settle signal (turn-done /
// session-state non-running) arrived while a curation RPC was in flight: the in-flight reply is
// newer, so the trigger is swallowed — but if the curate then fails or rejects without refreshing
// the view, the skipped trigger is lost until the next event (#142 items 3+4). `curate`'s settle
// path re-fires whatever its own outcome didn't already cover (see its `finally`).
let pendingRetarget = false;
let pendingTurnRefresh = false;

/** Shared fold for the settle signals (turn-done / session-state non-running): refresh now, or —
 *  while a curation RPC is in flight (its reply is newer) — remember the skip so the curate's
 *  settle path can re-fire it if the curate fails to land a fresh view (#142 item 4). */
function onSettleSignal(): void {
  if (curating()) {
    pendingTurnRefresh = true;
    return;
  }
  pendingTurnRefresh = false; // a direct refresh covers any earlier skip
  void refreshChangeset();
}

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
      // A stamped push arriving while the view was NEVER keyed (viewTabId null — a fresh panel's
      // first turn) would be dropped until turn-done re-keys, leaving the edit count/Diff view
      // dark for the whole turn: fire the re-key refresh instead of silently dropping (recordEdit
      // persists before emitting, so the get reply carries the pushed edit; #142 item 6).
      if (msg.tabId !== undefined && msg.tabId !== viewTabId()) {
        if (viewTabId() === null) void refreshChangeset();
        return;
      }
      const prior = changeset(); // the pre-fold view — the undo-shape check below compares against it
      const next = reduceChangeset(prior, msg);
      setChangeset(next);
      // Keep canUndo live off the record; canRedo stays owned by the RPC replies — except on
      // pushes that provably fork history server-side (store.ts `record`/`removeAt`/`replaceAt`/
      // `clear` all drop the redo tail), where canRedo is derivable: false. That is EVERY
      // `edit-recorded`, and every non-undo-shaped `changeset` push that is NOT the echo of this
      // store's own curation RPC — the nav-clear wipe cleared the redo tail, so leaving canRedo
      // would keep it stale-true (#9 review round 4). The own-RPC echo is exempt (`curating`):
      // its authoritative reply follows on the RPC channel and re-asserts canRedo (an undo can
      // leave it true). An agent session-UNDO push GROWS the redo tail instead of forking it —
      // forcing false there sent Redo stale-false for the rest of the turn (#142 item 15), so an
      // undo-shaped push asserts canRedo: true outright (an undone edit is always redoable).
      // Accepted residual: a redo-ORIGIN push (the tail shrinks but may stay >0) keeps
      // force-false — stale-false heals at the settle refresh — and a fork wearing the undo
      // shape (another panel's remove-last-edit, a preserveRedo retract of the last edit with an
      // empty tail) can leave Redo stale-true — a click no-ops server-side and the reply
      // re-asserts false. Distinguishing those needs a bus field the push schema doesn't carry.
      setCanUndo((next?.edits.length ?? 0) > 0);
      if (msg.type === 'edit-recorded') setCanRedo(false);
      else if (!curating()) setCanRedo(isUndoShaped(prior, msg.changeset));
    }
    // reconcile (keyed by `taskId`) so a status push updates only the changed task's fields —
    // a plain array replace remounts every keyed `<For>` row in TaskTimeline.
    else if (msg.type === 'task-status')
      // Keyed by the row identity, not `taskId`: a failed fan-out emits several rows with an EMPTY
      // taskId, and duplicate reconcile keys mis-map rows onto each other.
      setTasks(reconcile(reduceTasks(tasks, msg), { key: 'key' }));
    // A turn just finished (or was Stopped — the aborted turn's finally never emits turn-done, so
    // the non-running session-state is the only settle signal on that path) — the agent may have
    // recorded/undone edits, so refresh authoritative undo/redo availability for the now-enabled
    // Diff-tab controls. Skipped while a curation RPC is in flight: its reply is newer.
    else if (msg.type === 'turn-done') {
      onSettleSignal();
    } else if (msg.type === 'session-state' && msg.state !== 'running') {
      onSettleSignal();
    }
  });
  // The side panel is window-scoped but the changeset is per-tab: follow tab switches so the Diff
  // view always shows the record of the tab the user is looking at (guarded — the unit-test chrome
  // fake carries only `runtime`; #141 review). A switch landing mid-curate is remembered and
  // re-fired when the curate settles, or the view would stay keyed to the pre-switch tab until
  // the next trigger (#142 item 3).
  const retarget = (): void => {
    if (curating()) {
      pendingRetarget = true;
      return;
    }
    void refreshChangeset();
  };
  chrome.tabs?.onActivated?.addListener?.(retarget);
  chrome.windows?.onFocusChanged?.addListener?.(retarget);
  // Every `edit-recorded`/`changeset` push sent while the Port was down is gone — the durable
  // record lives on in `chrome.storage.session`, so re-read it rather than show the pre-drop view
  // (#165 S5). Same guard as a tab switch: never race an in-flight curation reply.
  onReconnect(retarget);
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
    // The same staleness guard as the success path: a superseded refresh's failure must not post
    // the error banner over a newer view that already landed clean (#142 item 8).
    if (seq !== viewSeq || refresh !== refreshSeq) return;
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
  // True when this settle landed an authoritative fresh view (a clean reply applied, or the
  // tab-drift auto-refresh re-keyed) — a settle that covers a turn-refresh skipped mid-curate
  // (#142 item 4). A busy echo, a hard failure, or a transport throw does NOT cover it.
  let landedFreshView = false;
  try {
    const r = await request(msg, ChangesetResult);
    if (!r.ok && r.error === 'tab-drift') {
      setDiffError(i18n.t('diff.tabDrift'));
      landedFreshView = true; // the auto-refresh below re-keys the view
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
      landedFreshView = true;
    }
  } catch (e) {
    setDiffError(errMsg(e));
  } finally {
    setCurating(false);
    // Re-fire whatever was swallowed mid-curate and NOT covered by this settle (#142 items 3+4):
    // a skipped retarget is never covered by the curate's own reply (the view is still keyed to
    // the pre-switch tab); a skipped turn-refresh is covered only when this settle landed a fresh
    // view — on a failure (transport throw, busy/hard-failure reply) it must be retried, or the
    // panel shows the pre-turn record until the next event.
    const refire = pendingRetarget || (pendingTurnRefresh && !landedFreshView);
    pendingRetarget = false;
    pendingTurnRefresh = false;
    if (refire) void refreshChangeset();
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
  // A ship's timeline is that ship's tasks. Left uncleared, a second ship appended its rows under
  // the first ship's, and the two fan-outs' "task 1/2" counters read as one six-task dispatch.
  setTasks(reconcile([], { key: 'key' }));
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
  setTasks(reconcile([], { key: 'key' })); // same fresh-timeline rule as `ship`
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
