import { createSignal } from 'solid-js';
import { createStore, reconcile } from 'solid-js/store';
import { i18n } from '#i18n';
import type { Changeset } from '@/shared/changeset';
import type { Mode, SwToPanel } from '@/shared/messages';
import { HandoffResult, type ShipRequest } from '@/shared/messages';
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
  if (msg.type !== 'changeset') return changeset;
  return msg.changeset;
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

export { changeset, error, fallbackReason, shipping, tasks };

let wired = false;

/** Open the SW port and fold incoming `changeset`/`task-status` pushes into local state. Idempotent
 *  — safe to call on every ShipBar/TaskTimeline mount. */
export function initChangesetStore(): void {
  if (wired) return;
  wired = true;
  connectPort();
  subscribeToSw((msg) => {
    if (msg.type === 'changeset') setChangeset(reduceChangeset(changeset(), msg));
    // reconcile (keyed by `taskId`) so a status push updates only the changed task's fields —
    // a plain array replace remounts every keyed `<For>` row in TaskTimeline.
    else if (msg.type === 'task-status')
      setTasks(reconcile(reduceTasks(tasks, msg), { key: 'taskId' }));
  });
}

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
