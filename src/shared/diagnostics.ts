import { z } from 'zod';
import { StableSelector } from './changeset';

// Diagnostics domain vocabulary — the debug engine's data model, shared across the content
// collector (`src/dom/diagnostics-collector.ts`) and the SW engine (`src/agent/diagnostics.ts`)
// the way `changeset.ts` is shared across worlds. Kept OUT of `messages.ts` (the bus-transport
// hub) on purpose: this slice owns the domain shapes here; the `ContentToSw` / `DomTool` transport
// that carries them over the bus is wired in the next task. Every list is length-bounded so a
// hostile page's collector reply can't blow the agent's token budget (defense-in-depth above the
// collector's own caps, mirroring the `DesignRead` bounds).

// Re-exported so both worlds import the selector type from the diagnostics hub, exactly as
// `messages.ts` re-exports it for the message vocabulary.
export { StableSelector };

// The problem catalog the agent debugs across (plan 06). Every finding is filed under exactly one.
export const DiagnosticCategory = z.enum([
  'runtime', // console errors/warnings, uncaught exceptions, unhandled rejections, CSP violations
  'network', // failed / 4xx / 5xx / slow / CORS requests, broken assets
  'interaction', // dead handlers, forms that don't submit, broken widgets/routes, stuck loaders
  'a11y', // role/name/contrast/focus-order/keyboard-trap
  'layout', // overflow, overlap, responsive breakage, broken/oversize images
  'state', // empty/error states, stale data, hydration mismatch
]);
export type DiagnosticCategory = z.infer<typeof DiagnosticCategory>;

export const Severity = z.enum(['critical', 'error', 'warning', 'info']);
export type Severity = z.infer<typeof Severity>;

// The observe → reproduce → confirm lifecycle of one finding (plan 06 method). `ruled-out` = the
// reproduce/confirm pass could NOT reproduce it, so the agent must not report it as a real bug.
export const FindingStatus = z.enum(['observed', 'reproduced', 'confirmed', 'ruled-out']);
export type FindingStatus = z.infer<typeof FindingStatus>;

// --- raw collector signals (content → SW) ---------------------------------
// What the page-world-safe collectors emit before the SW aggregates them into findings. A
// discriminated union on `kind`; `ts` is the (injectable-clock) time the signal fired, so the SW
// can order/correlate them and tests stay deterministic.

export const ConsoleSignal = z.object({
  kind: z.literal('console'),
  level: z.enum(['error', 'warn']),
  text: z.string().max(2000),
  ts: z.number(),
});
export type ConsoleSignal = z.infer<typeof ConsoleSignal>;

export const ExceptionSignal = z.object({
  kind: z.literal('exception'),
  message: z.string().max(2000),
  source: z.string().max(2048).optional(),
  line: z.number().int().nonnegative().optional(),
  column: z.number().int().nonnegative().optional(),
  stack: z.string().max(4000).optional(),
  ts: z.number(),
});
export type ExceptionSignal = z.infer<typeof ExceptionSignal>;

export const RejectionSignal = z.object({
  kind: z.literal('rejection'),
  reason: z.string().max(2000),
  ts: z.number(),
});
export type RejectionSignal = z.infer<typeof RejectionSignal>;

// How a request failed. `http` = a response arrived but status ≥ 400; `network` = no response
// (DNS/connection/broken asset); `cors` = blocked by the browser's CORS policy; `timeout` /
// `abort` are self-describing. Kept broad so the SW can grade severity from the failure mode.
export const NetworkFailureKind = z.enum(['http', 'network', 'timeout', 'cors', 'abort']);
export type NetworkFailureKind = z.infer<typeof NetworkFailureKind>;

export const NetworkSignal = z.object({
  kind: z.literal('network'),
  method: z.string().max(12),
  url: z.string().max(2048),
  status: z.number().int().optional(), // absent for a network-level failure (no response arrived)
  ok: z.boolean(), // true only for a slow-but-successful request buffered as a perf signal
  durationMs: z.number().nonnegative().optional(),
  failure: NetworkFailureKind.optional(),
  ts: z.number(),
});
export type NetworkSignal = z.infer<typeof NetworkSignal>;

// axe-core's impact vocabulary — the SW maps it onto `Severity`.
export const A11yImpact = z.enum(['critical', 'serious', 'moderate', 'minor']);
export type A11yImpact = z.infer<typeof A11yImpact>;

export const A11ySignal = z.object({
  kind: z.literal('a11y'),
  rule: z.string().max(80), // stable rule id (e.g. `control-name`, `contrast`) — keys the fix map
  detail: z.string().max(400),
  impact: A11yImpact,
  selector: StableSelector, // source-mappable target, so a finding is actionable + handoff-ready
  ts: z.number(),
});
export type A11ySignal = z.infer<typeof A11ySignal>;

export const LayoutSignal = z.object({
  kind: z.literal('layout'),
  rule: z.string().max(80), // e.g. `overflow-x`, `cls-image`
  detail: z.string().max(400),
  selector: StableSelector,
  ts: z.number(),
});
export type LayoutSignal = z.infer<typeof LayoutSignal>;

export const CollectorSignal = z.discriminatedUnion('kind', [
  ConsoleSignal,
  ExceptionSignal,
  RejectionSignal,
  NetworkSignal,
  A11ySignal,
  LayoutSignal,
]);
export type CollectorSignal = z.infer<typeof CollectorSignal>;

// --- findings -------------------------------------------------------------
// Evidence backs a finding so the agent (and the eventual report/handoff, PR12) can *show* its
// work, not just assert. `detail` is a short excerpt / selector / data-URL ref — bounded.
export const EvidenceKind = z.enum(['log', 'network', 'screenshot', 'selector', 'note']);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const Evidence = z.object({
  kind: EvidenceKind,
  detail: z.string().max(4000),
});
export type Evidence = z.infer<typeof Evidence>;

// One step in a reproduction — a drive action mirroring the control tools (PR13
// navigate/click/type/hover/scrollTo/pressKey/waitFor) so the engine can hand a repro plan
// straight to them. `wait` is bounded by the executor; `note` documents the expected outcome.
export const ReproAction = z.enum([
  'navigate',
  'click',
  'type',
  'hover',
  'scrollTo',
  'pressKey',
  'wait',
]);
export type ReproAction = z.infer<typeof ReproAction>;

export const ReproStep = z.object({
  action: ReproAction,
  selector: z.string().max(1024).optional(),
  value: z.string().max(2048).optional(),
  note: z.string().max(400).optional(),
});
export type ReproStep = z.infer<typeof ReproStep>;

// One diagnosed problem: the observe→reproduce→confirm output for a single issue. `id` is
// content-addressed (category + a normalized key) in `aggregate`, so dedupe/correlate are
// deterministic and cross-references (`relatedIds`) stay stable across a re-run. This is the unit
// the report (PR12) and any MCP handoff (PR12) are assembled from.
export const Finding = z.object({
  id: z.string(),
  category: DiagnosticCategory,
  severity: Severity,
  title: z.string().max(300),
  detail: z.string().max(2000),
  status: FindingStatus,
  selector: StableSelector.optional(),
  rootCause: z.string().max(2000).optional(),
  proposedFix: z.string().max(2000).optional(),
  occurrences: z.number().int().positive(), // raw signals that collapsed into this finding
  evidence: z.array(Evidence).max(24).default([]),
  repro: z.array(ReproStep).max(24).default([]),
  relatedIds: z.array(z.string()).max(24).default([]), // other findings this correlates with
});
export type Finding = z.infer<typeof Finding>;

// The aggregated debug report — the SW's correlated output, and the input to the report/handoff
// pass (PR12). `summary` maps are plain string→count (not enum-keyed records) so a category or
// severity with zero findings is simply absent rather than forced to 0.
export const DiagnosticsReport = z.object({
  url: z.string().max(2048),
  generatedAt: z.string(),
  findings: z.array(Finding).max(200),
  summary: z.object({
    total: z.number().int().nonnegative(),
    byCategory: z.record(z.string(), z.number().int().nonnegative()),
    bySeverity: z.record(z.string(), z.number().int().nonnegative()),
  }),
});
export type DiagnosticsReport = z.infer<typeof DiagnosticsReport>;
