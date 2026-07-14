// The Ship handoff (slice 07) — turn an accepted design session into real code tasks on a connected
// coding backend (ai-dev / developerz.ai) over MCP: `task(action:'create', {template,repo,title,spec})`
// per problem, then `task(action:'watch')` streaming each task's status back to the panel as
// `task-status`. Two shapes route through here (docs/idea/handoff.md):
//   • a bare `Changeset` → one task whose spec is the recorded edits, and
//   • an agent-authored `Report` → a single-task brief, or (multi-task) one task PER identified
//     problem, each with its own focused brief + images, tracked independently.
//
// SW-ONLY by usage (the MCP transport carries auth tokens — never import from content.ts) but
// chrome-FREE by construction: the backend is injected ({@link TaskBackend}), exactly like
// `agent/report.ts` injects its model call, so this whole module is unit-testable against a fake
// backend with no `chrome.*`. `background.ts` adapts the real namespaced `<serverId>__task` tool to
// {@link TaskBackend}. Ship is ALWAYS user-triggered (docs/idea/principles.md); nothing here starts
// itself.

import { toMarkdown } from '@/changeset/report-md';
import type { Changeset, Edit } from '@/shared/changeset';
import type { Report, ReportImage } from '@/shared/report';

/** ai-dev's UI-work agent template (docs/idea/handoff.md "The task call"). */
export const TASK_TEMPLATE = 'frontend_dev';
/** Stamped on every task spec so the backend knows the edits came from the Designer. */
export const HANDOFF_SOURCE = 'developerz-designer';
/** Task titles are commit/PR headlines — keep them one short line. */
const MAX_TITLE = 72;

// --- origin → repo mapping ---------------------------------------------------------------------

/** Page origin (`host[:port]`, no scheme/path) → repo slug (`owner/name`). The user maps a page's
 *  origin to a repo once in the MCP panel; Ship reuses it (docs/idea/mcp.md "Connecting"). Persisted
 *  by `src/mcp/store.ts`. */
export type OriginRepoMap = Record<string, string>;

/** The map key for a page URL — its lowercased `host:port`, or `null` for an unparseable URL. Scheme
 *  and path are dropped: the same repo serves `http` and `https`, and every path under an origin. */
export function originOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Resolve the repo mapped to a page URL's origin, or `null` when the origin is unmapped (Ship then
 *  routes to a downloadable report instead of a task). */
export function resolveRepo(url: string, map: OriginRepoMap): string | null {
  const origin = originOf(url);
  if (!origin) return null;
  return map[origin] ?? null;
}

// --- the task spec -----------------------------------------------------------------------------

/** The `spec` payload of a `task(create)` — the changeset (or a decomposed problem) as the backend's
 *  task input. The dev-agent maps `edits[].selector`/`frameworkHints` back to source; `brief` is the
 *  paste-ready Markdown review; `problem` names the one focused issue a multi-task split addresses. */
export interface TaskSpecPayload {
  readonly source: typeof HANDOFF_SOURCE;
  readonly url: string;
  /** The session's recorded edits — always present (may be empty for a diagnostics-only report). */
  readonly edits: readonly Edit[];
  /** The agent-authored Markdown brief; set for a `Report` handoff, omitted for a bare changeset. */
  readonly brief?: string;
  /** The single problem this task addresses, when a report was decomposed into one task per problem. */
  readonly problem?: string;
  /** Screenshots for the dev-agent to verify its result against intent; set for a `Report` handoff. */
  readonly images?: readonly ReportImage[];
}

/** One `task(action:'create', …)` to dispatch — the exact `{template,repo,title,spec}` shape from
 *  docs/idea/handoff.md. A ship produces one of these (changeset / single report) or N (multi-task). */
export interface TaskSpec {
  readonly template: string;
  readonly repo: string;
  readonly title: string;
  readonly spec: TaskSpecPayload;
}

/** What Ship hands off: a bare changeset, or an agent-authored report (optionally split per problem).
 *  A report carries its own `changeset` so the edits still ride along as source-mapping context. */
export type ShipSource =
  | { readonly kind: 'changeset'; readonly changeset: Changeset; readonly title?: string }
  | {
      readonly kind: 'report';
      readonly report: Report;
      readonly changeset?: Changeset;
      readonly title?: string;
      /** Split `report.problems` into one task each (falls back to a single task when there are
       *  none). Default `false` → one task carrying the whole brief. */
      readonly multiTask?: boolean;
    };

/** Where the handoff lands: the resolved repo (via {@link resolveRepo}) and the backend connection id
 *  it dispatches through (informational — the transport itself is the injected {@link TaskBackend}). */
export interface ShipTarget {
  readonly repo: string;
  readonly backend?: string;
}

// --- planning (pure) ---------------------------------------------------------------------------

/**
 * Expand a ship request into the concrete `task(create)` specs to dispatch — the multi-task fan-out.
 * One spec for a changeset or a single-task report; one spec PER problem for a decomposed report
 * (each a focused brief narrowed to that problem, sharing the session's identity/images/edits).
 * Throws on nothing to hand off (an empty changeset) or a missing repo — Ship keeps the user's work
 * rather than opening a meaningless PR (docs/idea/handoff.md "Failure").
 */
export function planTasks(source: ShipSource, target: ShipTarget): TaskSpec[] {
  const repo = target.repo.trim();
  if (!repo) throw new Error('ship: no repo mapped for this page');

  if (source.kind === 'changeset') {
    if (source.changeset.edits.length === 0) throw new Error('ship: changeset has no edits');
    return [changesetSpec(source.changeset, repo, source.title)];
  }

  const { report, changeset, multiTask } = source;
  const url = changeset?.url ?? report.links[0]?.url ?? '';
  const edits = changeset?.edits ?? [];

  if (multiTask && report.problems.length > 0) {
    return report.problems.map((problem) =>
      reportSpec(focusReport(report, problem), repo, url, edits, problem),
    );
  }
  return [reportSpec(report, repo, url, edits, undefined, source.title)];
}

function changesetSpec(changeset: Changeset, repo: string, title?: string): TaskSpec {
  return {
    template: TASK_TEMPLATE,
    repo,
    title: title ? clampTitle(title) : titleFromEdits(changeset),
    spec: { source: HANDOFF_SOURCE, url: changeset.url, edits: changeset.edits },
  };
}

function reportSpec(
  report: Report,
  repo: string,
  url: string,
  edits: readonly Edit[],
  problem?: string,
  title?: string,
): TaskSpec {
  return {
    template: TASK_TEMPLATE,
    repo,
    title: title ? clampTitle(title) : problem ? clampTitle(problem) : titleFromSummary(report),
    spec: {
      source: HANDOFF_SOURCE,
      url,
      edits,
      brief: toMarkdown(report),
      images: report.images,
      ...(problem ? { problem } : {}),
    },
  };
}

/** Narrow a report to a single problem for a per-problem task — same shared context (summary,
 *  identity, links, images, recommendations) but only the one problem to fix, so each task's brief
 *  reads focused rather than repeating the whole findings list. */
function focusReport(report: Report, problem: string): Report {
  return { ...report, problems: [problem] };
}

/** First edit's intent as the task headline, else a generic fallback. */
function titleFromEdits(changeset: Changeset): string {
  const first = changeset.edits[0];
  return clampTitle(first?.intent || 'Apply design changes');
}

/** The report summary's first line as the task headline, else a generic fallback. */
function titleFromSummary(report: Report): string {
  const firstLine = report.summary.split('\n')[0]?.trim();
  return clampTitle(firstLine || 'Apply design review');
}

/** Collapse to one line and cap to {@link MAX_TITLE}, ellipsizing an over-long headline. */
function clampTitle(raw: string): string {
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}

// --- dispatch ----------------------------------------------------------------------------------

/** A task's lifecycle status streamed from the backend — mirrors the `task-status` bus message
 *  (docs/idea/handoff.md: `queued → working → pr_open → ci_green / ci_red`). `status` is an open
 *  string, not an enum, so a backend can report phases we don't yet model. */
export interface TaskStatus {
  readonly status: string;
  readonly prUrl?: string;
}

/** A created task's handle — its backend id (used to `watch`) and any status returned at create. */
export interface TaskHandle {
  readonly id: string;
  readonly status?: TaskStatus;
}

/** The injected MCP `task` backend. `background.ts` implements this over the connected server's
 *  namespaced `<serverId>__task` tool: `create` → `task(action:'create', …)`; `watch` →
 *  `task(action:'watch', …)`, translating the stream/poll into `onStatus` calls and resolving with
 *  the terminal status. Injecting it keeps this module chrome-free and unit-testable. */
export interface TaskBackend {
  create(args: TaskCreateArgs, signal?: AbortSignal): Promise<TaskHandle>;
  watch(
    taskId: string,
    onStatus: (status: TaskStatus) => void,
    signal?: AbortSignal,
  ): Promise<TaskStatus>;
}

/** The exact arguments of a `task(action:'create')` call. */
export interface TaskCreateArgs extends TaskSpec {
  readonly action: 'create';
}

/** One status update as Ship surfaces it — the underlying {@link TaskStatus} plus which task (of a
 *  multi-task fan-out) it belongs to, so the panel can drive a separate timeline per task. */
export interface TaskStatusUpdate extends TaskStatus {
  readonly taskId: string;
  readonly title: string;
  /** 0-based position and total in this ship's task list (`1 / 1` for a single task). */
  readonly index: number;
  readonly total: number;
  /** Set when this task's create/watch failed — the update carries `status: 'error'`. */
  readonly error?: string;
}

/** One dispatched task's outcome. `error` is set (and `final.status` is `'error'`) when the backend
 *  create/watch threw — one failed task never aborts the others in a multi-task ship. */
export interface ShipTaskResult {
  readonly title: string;
  readonly repo: string;
  readonly taskId: string;
  readonly final: TaskStatus;
  readonly error?: string;
}

export interface ShipResult {
  readonly tasks: ShipTaskResult[];
}

export interface ShipDeps {
  readonly backend: TaskBackend;
  /** Per-task status stream → the panel's `task-status` (one timeline per task). */
  readonly onStatus?: (update: TaskStatusUpdate) => void;
  readonly signal?: AbortSignal;
}

/**
 * Dispatch a ship: plan the `task(create)` specs, then create + watch each independently and in
 * parallel so a multi-task fan-out's statuses stream side-by-side (docs/idea/handoff.md). Planning
 * failures (empty changeset / no repo) throw for the caller to surface; a per-task backend failure is
 * captured as an `error` result and streamed as `status: 'error'` — the changeset survives and the
 * other tasks keep going. Never auto-invoked — the panel's Ship button is the only trigger.
 */
export async function ship(
  source: ShipSource,
  target: ShipTarget,
  deps: ShipDeps,
): Promise<ShipResult> {
  const specs = planTasks(source, target);
  const total = specs.length;

  const tasks = await Promise.all(
    specs.map((spec, index) => dispatchTask(spec, index, total, deps)),
  );
  return { tasks };
}

async function dispatchTask(
  spec: TaskSpec,
  index: number,
  total: number,
  deps: ShipDeps,
): Promise<ShipTaskResult> {
  const emit = (status: TaskStatus, taskId: string, error?: string): void =>
    deps.onStatus?.({
      ...status,
      taskId,
      title: spec.title,
      index,
      total,
      ...(error ? { error } : {}),
    });

  // Retained across the try so a watch-phase failure still reports the id the create returned.
  let taskId = '';
  try {
    const handle = await deps.backend.create({ action: 'create', ...spec }, deps.signal);
    taskId = handle.id;
    if (handle.status) emit(handle.status, taskId);
    const final = await deps.backend.watch(taskId, (status) => emit(status, taskId), deps.signal);
    return { title: spec.title, repo: spec.repo, taskId, final };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const final: TaskStatus = { status: 'error' };
    emit(final, taskId, message);
    return { title: spec.title, repo: spec.repo, taskId, final, error: message };
  }
}
