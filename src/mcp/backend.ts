// The Ship route's MCP glue as chrome-free, unit-testable seams (slice 07): pick a connected coding
// backend that exposes a `task` tool, adapt that tool into the injected {@link TaskBackend} the
// `ship` orchestrator drives, and decide — for one page — whether Ship dispatches tasks or falls back
// to a downloadable report. `background.ts` wires the real merged MCP `ToolSet` + origin→repo map
// into these; the logic here stays testable against plain fakes (no `chrome.*`, no MCP transport),
// exactly like `handoff.ts`'s `ship`/`planTasks`.
//
// SW-ONLY by usage (it drives a transport that carries auth tokens) but import-clean: it depends only
// on `handoff.ts` + `client.ts`'s pure `namespaceTool`, never on `chrome.*` or the AI SDK. Ship is
// ALWAYS user-triggered (docs/idea/principles.md) — nothing here starts itself.

import { z } from 'zod';
import { namespaceTool } from './client';
import {
  type OriginRepoMap,
  resolveRepo,
  type TaskBackend,
  type TaskHandle,
  type TaskStatus,
} from './handoff';

/** The backend tool name Ship dispatches through (docs/idea/handoff.md "The task call"). */
export const TASK_TOOL = 'task';

/** A connected backend that can accept a handoff: its server id + label + the namespaced `task`
 *  tool name (`<id>__task`) present in the merged agent ToolSet. */
export interface BackendCandidate {
  readonly id: string;
  readonly label: string;
  readonly taskToolName: string;
}

/** The connected backends exposing a `task` tool, derived from the configured servers + the merged
 *  ToolSet's tool names. A server whose `<id>__task` tool isn't present (unconnected, or it exposes
 *  no task tool) is skipped, so `ship` only ever targets a backend that can actually take a task. */
export function taskBackends(
  servers: readonly { id: string; label: string }[],
  toolNames: readonly string[],
): BackendCandidate[] {
  const present = new Set(toolNames);
  const candidates: BackendCandidate[] = [];
  for (const server of servers) {
    const taskToolName = namespaceTool(server.id, TASK_TOOL);
    if (present.has(taskToolName)) {
      candidates.push({ id: server.id, label: server.label, taskToolName });
    }
  }
  return candidates;
}

/** Choose the backend to dispatch through: the one whose id or label matches `target`
 *  (case-insensitive, trimmed), else the first connected candidate. `null` when none can take a
 *  task, or when an explicit `target` matches nothing. */
export function pickBackend(
  candidates: readonly BackendCandidate[],
  target?: string,
): BackendCandidate | null {
  const want = target?.trim().toLowerCase();
  if (want) {
    return (
      candidates.find((c) => c.id.toLowerCase() === want || c.label.toLowerCase() === want) ?? null
    );
  }
  return candidates[0] ?? null;
}

/** Why Ship fell back to a downloadable report instead of dispatching tasks. */
export type HandoffFallbackReason = 'no-backend' | 'no-repo';

/** Where a ship routes: dispatch `task(create)` to a connected backend + mapped repo, or fall back
 *  to a downloadable MD report (no backend connected/targeted, or this origin has no repo mapped). */
export type HandoffRoute =
  | { readonly kind: 'tasks'; readonly backend: BackendCandidate; readonly repo: string }
  | { readonly kind: 'report'; readonly reason: HandoffFallbackReason };

/** Decide a ship's route for one page (pure): a connected backend that can take a `task` AND a repo
 *  mapped to the page's origin ⇒ dispatch tasks; otherwise a downloadable report, with the reason.
 *  Never dispatches on its own — the SW only calls this from a user-triggered Ship/Send RPC. */
export function routeHandoff(args: {
  url: string;
  originRepoMap: OriginRepoMap;
  candidates: readonly BackendCandidate[];
  target?: string;
}): HandoffRoute {
  const backend = pickBackend(args.candidates, args.target);
  if (!backend) return { kind: 'report', reason: 'no-backend' };
  const repo = resolveRepo(args.url, args.originRepoMap);
  if (!repo) return { kind: 'report', reason: 'no-repo' };
  return { kind: 'tasks', backend, repo };
}

/** A short, user-facing explanation for a report fallback — shown by the panel beside the download.
 *  ShipBar composes it with the `ship.fallback` wrapper ('{reason} — downloaded a brief instead.'),
 *  so keep the reason CLAUSE-FREE: the wrapper already reports the auto-download. */
export function fallbackMessage(reason: HandoffFallbackReason): string {
  return reason === 'no-backend'
    ? 'No coding backend connected — download the brief and paste it into your coding agent.'
    : 'No repo is mapped for this page yet.';
}

// --- the task tool adapter ---------------------------------------------------------------------

/** The minimal call surface the adapter needs from an MCP `task` tool — `background.ts` binds this to
 *  the AI SDK tool's `execute`. Injecting it keeps this module chrome-/SDK-free and unit-testable. */
export type TaskToolExecute = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

// The backend's create/status payloads, parsed defensively from the tool result (see `unwrap`): an
// MCP tool may reply with the bare object, a `structuredContent`, or a `content` text envelope.
const CreatePayload = z.object({
  id: z.string().min(1),
  status: z.string().min(1).optional(),
  prUrl: z.string().optional(),
});
const StatusPayload = z.object({
  status: z.string().min(1),
  prUrl: z.string().optional(),
});

/** Adapt an MCP `task` tool into the {@link TaskBackend} `ship` drives: `create` →
 *  `task(action:'create', …spec)`, `watch` → `task(action:'watch', taskId)` — a single call whose
 *  parsed result is the terminal status, streamed once via `onStatus`. Result shapes are parsed
 *  leniently (via {@link unwrap}) so a backend that wraps its reply in an MCP content envelope still
 *  works. (Intermediate-status polling is a later enhancement; today the create status + the terminal
 *  status are what stream.) */
export function createTaskBackend(execute: TaskToolExecute): TaskBackend {
  return {
    async create(args, signal) {
      const parsed = CreatePayload.safeParse(unwrap(await execute({ ...args }, signal)));
      if (!parsed.success) throw new Error('ship: backend did not return a task id');
      return parsed.data.status
        ? {
            id: parsed.data.id,
            status: { status: parsed.data.status, prUrl: parsed.data.prUrl },
          }
        : ({ id: parsed.data.id } satisfies TaskHandle);
    },
    async watch(taskId, onStatus, signal) {
      const parsed = StatusPayload.safeParse(
        unwrap(await execute({ action: 'watch', taskId }, signal)),
      );
      const status: TaskStatus = parsed.success
        ? { status: parsed.data.status, prUrl: parsed.data.prUrl }
        : { status: 'unknown' };
      onStatus(status);
      return status;
    },
  };
}

/** Best-effort unwrap of an MCP tool result to its payload object: a bare object with `id`/`status`
 *  as-is, a `structuredContent` object, or the JSON in the first `content` text part. A non-object
 *  (or an envelope with nothing parseable) yields the original object so the schema parse fails
 *  cleanly rather than throwing here. */
export function unwrap(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  if ('id' in obj || 'status' in obj) return obj;
  if (obj.structuredContent && typeof obj.structuredContent === 'object') {
    return obj.structuredContent;
  }
  if (Array.isArray(obj.content)) {
    for (const part of obj.content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') {
          try {
            return JSON.parse(text);
          } catch {
            // Not JSON — keep scanning; fall through to the object itself.
          }
        }
      }
    }
  }
  return obj;
}
