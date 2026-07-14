// The debug engine — the SW half of slice 06's "the agent genuinely *debugs*, not just lints". It
// turns the raw signals the content collector streams (src/dom/diagnostics-collector.ts) into a
// correlated set of findings, then drives each one through the plan's method:
//
//   observe → hypothesize → reproduce → capture → confirm → propose fix (with a root-cause note)
//
// `aggregate` does observe + hypothesize (dedupe/group signals into findings, grade severity, seed
// a root-cause guess + a heuristic fix); `correlate` links cross-category findings (a runtime error
// caused by a failing request); `investigate` does reproduce → capture → confirm by DRIVING the
// page and CONFIRMING with vision, both via an injected `DiagnosticsDriver` (the control tools land
// in PR13, vision in PR13/14 — injected exactly like `BrowseTabDriver`, so this module stays
// chrome-free + unit-testable now). `buildReport` assembles the findings into the report input the
// handoff/report pass consumes (PR12).
//
// SW-ONLY by usage, chrome-free by construction: no `chrome.*`, no DOM, no `any`.

import type {
  A11yImpact,
  CollectorSignal,
  DiagnosticCategory,
  Evidence,
  Finding,
  FindingStatus,
  ReproStep,
  Severity,
} from '@/shared/diagnostics';
import { DiagnosticsReport } from '@/shared/diagnostics';
import type { ToolResult } from '@/shared/messages';

// --- observe + hypothesize: signals → findings ----------------------------

const MAX_EVIDENCE_PER_FINDING = 6;

/**
 * Collapse raw collector signals into findings: group by a normalized dedupe key (so a chatty page
 * that logs the same error 400 times becomes one finding with `occurrences: 400`), grade severity,
 * carry a few sample signals as evidence, and seed a root-cause hypothesis + heuristic fix where the
 * category makes one obvious. Deterministic (content-addressed ids, stable sort) so a re-run yields
 * the same report and `correlate` can reference findings by id.
 */
export function aggregate(signals: CollectorSignal[]): Finding[] {
  const groups = new Map<string, { signals: CollectorSignal[] }>();
  for (const signal of signals) {
    const key = dedupeKey(signal);
    const group = groups.get(key);
    if (group) group.signals.push(signal);
    else groups.set(key, { signals: [signal] });
  }

  const findings: Finding[] = [];
  for (const [key, group] of groups) {
    const head = group.signals[0];
    if (!head) continue;
    findings.push(findingFrom(key, head, group.signals));
  }
  return sortFindings(findings);
}

function findingFrom(key: string, head: CollectorSignal, group: CollectorSignal[]): Finding {
  const category = categoryOf(head.kind);
  const rule = ruleOf(head);
  const selector = selectorOf(head);
  const rootCause = rootCauseHypothesis(head);
  const proposedFix = rule ? FIX_HINTS[rule] : undefined;
  return {
    id: stableId(`${category}:${key}`),
    category,
    severity: severityOf(head),
    title: titleOf(head),
    detail: detailOf(head),
    status: 'observed',
    occurrences: group.length,
    evidence: evidenceFrom(group),
    repro: [],
    relatedIds: [],
    ...(selector ? { selector } : {}),
    ...(rootCause ? { rootCause } : {}),
    ...(proposedFix ? { proposedFix } : {}),
  };
}

// --- hypothesize: cross-category correlation ------------------------------

/**
 * Link findings that are almost certainly the same failure seen from two angles: a runtime error
 * (console/exception/rejection) whose text mentions a URL that ALSO has a failed network finding is
 * very likely *caused* by that request. Wires reciprocal `relatedIds` and, when the runtime finding
 * has no root cause yet, points it at the network failure. This is the "correlate" step that lifts
 * the output from a lint list to an actual diagnosis. Pure + immutable.
 */
export function correlate(findings: Finding[]): Finding[] {
  const networkTargets = findings
    .filter((f) => f.category === 'network')
    .map((f) => ({ id: f.id, needle: hostPath(f.detail).toLowerCase() }))
    .filter((n) => n.needle.length > 0);
  if (networkTargets.length === 0) return findings;

  const links = new Map<string, Set<string>>();
  const relatedTo = (id: string): Set<string> => {
    const existing = links.get(id);
    if (existing) return existing;
    const created = new Set<string>();
    links.set(id, created);
    return created;
  };
  const link = (a: string, b: string): void => {
    relatedTo(a).add(b);
    relatedTo(b).add(a);
  };

  for (const finding of findings) {
    if (finding.category !== 'runtime') continue;
    const haystack = haystackOf(finding);
    for (const target of networkTargets) {
      if (haystack.includes(target.needle)) link(finding.id, target.id);
    }
  }

  if (links.size === 0) return findings;
  return findings.map((finding) => {
    const related = links.get(finding.id);
    if (!related || related.size === 0) return finding;
    const relatedIds = unique([...finding.relatedIds, ...related]).slice(0, 24);
    const rootCause =
      finding.category === 'runtime' && !finding.rootCause
        ? `Likely caused by a failing network request (see finding${related.size > 1 ? 's' : ''} ${[...related].join(', ')}).`
        : finding.rootCause;
    return { ...finding, relatedIds, ...(rootCause ? { rootCause } : {}) };
  });
}

// --- reproduce → capture → confirm ----------------------------------------

/** Vision/observation verdict on whether a reproduction actually surfaced the problem. */
export interface ConfirmVerdict {
  readonly confirmed: boolean;
  readonly detail: string;
}

/** The side effects `investigate` drives, injected so the engine stays chrome-free + testable — the
 *  same "inject the side effect" doctrine as `BrowseTabDriver`. `drive` runs one control action
 *  (PR13 interaction tools), `capture` grabs post-repro evidence (screenshot + drained
 *  console/network), `confirm` asks the vision model whether the failure is real (PR13/14). */
export interface DiagnosticsDriver {
  drive(step: ReproStep, signal?: AbortSignal): Promise<ToolResult>;
  capture(signal?: AbortSignal): Promise<Evidence[]>;
  confirm(question: string, signal?: AbortSignal): Promise<ConfirmVerdict>;
}

/**
 * Drive one finding through reproduce → capture → confirm and return it enriched: the repro steps
 * appended, post-repro evidence attached, and `status` advanced to `reproduced`/`confirmed` — or
 * left `observed` (a repro step failed) / set `ruled-out` (confirmation says it didn't happen). A
 * driver method that throws degrades to a note rather than throwing the turn. Immutable: returns a
 * new finding, never mutates the input.
 */
export async function investigate(
  finding: Finding,
  repro: ReproStep[],
  driver: DiagnosticsDriver,
  signal?: AbortSignal,
): Promise<Finding> {
  if (signal?.aborted) return finding;

  const evidence: Evidence[] = [...finding.evidence];
  const ranSteps: ReproStep[] = [];
  let driveFailed = false;

  for (const step of repro) {
    if (signal?.aborted) break;
    ranSteps.push(step);
    const result = await driver.drive(step, signal).catch((err) => errorResult(String(err)));
    if (!result.ok) {
      driveFailed = true;
      evidence.push({
        kind: 'note',
        detail: `Repro step "${describeStep(step)}" failed: ${result.error ?? 'unknown error'}`,
      });
      break;
    }
  }

  const captured = await driver.capture(signal).catch(() => [] as Evidence[]);
  for (const item of captured) evidence.push(item);

  let status: FindingStatus = driveFailed ? 'observed' : 'reproduced';
  if (!driveFailed && !signal?.aborted) {
    const verdict = await driver
      .confirm(confirmQuestion(finding), signal)
      .catch(() => ({ confirmed: false, detail: 'confirmation unavailable' }));
    status = verdict.confirmed ? 'confirmed' : 'ruled-out';
    evidence.push({
      kind: 'note',
      detail: `Confirmation: ${verdict.confirmed ? 'reproduced as described' : 'could not reproduce'} — ${verdict.detail}`,
    });
  }

  return {
    ...finding,
    status,
    repro: [...finding.repro, ...ranSteps].slice(0, 24),
    evidence: dedupeEvidence(evidence).slice(0, 24),
  };
}

/** The yes/no question the vision/observation pass answers to confirm a finding is real. */
export function confirmQuestion(finding: Finding): string {
  switch (finding.category) {
    case 'interaction':
      return `After the reproduction steps, is "${finding.title}" still broken — the action had no visible effect or the widget did not respond?`;
    case 'layout':
      return `In the current screenshot, is "${finding.title}" visibly wrong (content overflowing, overlapping, clipped, or a broken image)?`;
    case 'a11y':
      return `Does the element for "${finding.title}" still fail this accessibility check after the steps?`;
    case 'state':
      return `After the steps, is the page in the wrong state for "${finding.title}" (empty/error/stale where real content was expected)?`;
    case 'network':
    case 'runtime':
      return `Did reproducing the steps surface "${finding.title}" (an error in the console/network or a visibly wrong result)?`;
  }
}

// --- assemble the report --------------------------------------------------

/**
 * Assemble the findings into the report input the handoff/report pass consumes (PR12): severity-then
 * -category ordered, bounded, with per-category and per-severity summary counts. Validated through
 * the schema so a malformed finding can't reach the report.
 */
export function buildReport(
  url: string,
  generatedAt: string,
  findings: Finding[],
): DiagnosticsReport {
  const ordered = sortFindings(findings).slice(0, 200);
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const finding of ordered) {
    byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }
  return DiagnosticsReport.parse({
    url: url.slice(0, 2048),
    generatedAt,
    findings: ordered,
    summary: { total: ordered.length, byCategory, bySeverity },
  });
}

/** One-shot observe → hypothesize → report over collected signals (no reproduction). The reproduce
 *  → confirm pass runs per-finding via {@link investigate} before the final report is built. */
export function diagnose(
  signals: CollectorSignal[],
  url: string,
  generatedAt: string,
): DiagnosticsReport {
  return buildReport(url, generatedAt, correlate(aggregate(signals)));
}

// --- signal → finding mapping (pure) --------------------------------------

function categoryOf(kind: CollectorSignal['kind']): DiagnosticCategory {
  switch (kind) {
    case 'console':
    case 'exception':
    case 'rejection':
      return 'runtime';
    case 'network':
      return 'network';
    case 'a11y':
      return 'a11y';
    case 'layout':
      return 'layout';
  }
}

function severityOf(signal: CollectorSignal): Severity {
  switch (signal.kind) {
    case 'exception':
      return 'critical';
    case 'rejection':
      return 'error';
    case 'console':
      return signal.level === 'error' ? 'error' : 'warning';
    case 'network':
      return networkSeverity(signal);
    case 'a11y':
      return A11Y_SEVERITY[signal.impact];
    case 'layout':
      return signal.rule === 'cls-image' ? 'info' : 'warning';
  }
}

const A11Y_SEVERITY: Record<A11yImpact, Severity> = {
  critical: 'critical',
  serious: 'error',
  moderate: 'warning',
  minor: 'info',
};

function networkSeverity(signal: Extract<CollectorSignal, { kind: 'network' }>): Severity {
  if (signal.ok) return 'warning'; // a slow-but-successful request
  if (signal.failure === 'abort') return 'info';
  if (signal.status !== undefined && signal.status >= 400 && signal.status < 500) return 'warning';
  return 'error';
}

function ruleOf(signal: CollectorSignal): string {
  if (signal.kind === 'a11y' || signal.kind === 'layout') return signal.rule;
  return '';
}

function selectorOf(signal: CollectorSignal): Finding['selector'] {
  return signal.kind === 'a11y' || signal.kind === 'layout' ? signal.selector : undefined;
}

function titleOf(signal: CollectorSignal): string {
  switch (signal.kind) {
    case 'console':
      return `Console ${signal.level}: ${firstLine(signal.text)}`;
    case 'exception':
      return `Uncaught exception: ${firstLine(signal.message)}`;
    case 'rejection':
      return `Unhandled promise rejection: ${firstLine(signal.reason)}`;
    case 'network':
      return `${signal.method} ${networkOutcomeLabel(signal)} — ${hostPath(signal.url) || signal.url}`;
    case 'a11y':
      return `Accessibility: ${signal.rule}`;
    case 'layout':
      return `Layout: ${signal.rule}`;
  }
}

function detailOf(signal: CollectorSignal): string {
  switch (signal.kind) {
    case 'console':
      return signal.text.slice(0, 2000);
    case 'exception': {
      const where = signal.source
        ? ` (${signal.source}${signal.line ? `:${signal.line}` : ''})`
        : '';
      return `${signal.message}${where}`.slice(0, 2000);
    }
    case 'rejection':
      return signal.reason.slice(0, 2000);
    case 'network':
      return signal.url.slice(0, 2000);
    case 'a11y':
    case 'layout':
      return signal.detail.slice(0, 2000);
  }
}

function networkOutcomeLabel(signal: Extract<CollectorSignal, { kind: 'network' }>): string {
  if (signal.ok) return `slow${signal.durationMs ? ` (${signal.durationMs}ms)` : ''}`;
  if (signal.status !== undefined) return String(signal.status);
  return signal.failure ?? 'failed';
}

function rootCauseHypothesis(signal: CollectorSignal): string | undefined {
  if (signal.kind !== 'network' || signal.ok) return undefined;
  switch (signal.failure) {
    case 'cors':
      return "The request was blocked by the browser's CORS policy (no matching Access-Control-Allow-Origin).";
    case 'timeout':
      return 'The request did not complete before its timeout — a slow or unreachable endpoint.';
    case 'network':
      return 'No response arrived — DNS/connection failure or a broken/blocked asset.';
    default:
      if (signal.status !== undefined && signal.status >= 500)
        return 'The server returned a 5xx error; the endpoint is failing.';
      if (signal.status !== undefined && signal.status >= 400)
        return 'The request was rejected (4xx) — likely a bad URL, auth, or payload.';
      return undefined;
  }
}

// rule id → an actionable, category-appropriate fix direction. The model can override, but a
// deterministic default makes every scan finding immediately useful in the report.
const FIX_HINTS: Record<string, string> = {
  'control-name':
    'Give the control an accessible name: visible text, aria-label, or aria-labelledby.',
  'image-alt': 'Add an alt attribute — describe the image, or alt="" if it is purely decorative.',
  'field-label': 'Associate a <label for> (or aria-label / aria-labelledby) with the field.',
  contrast:
    'Raise the text/background contrast to at least 4.5:1 (3:1 for large text) for WCAG AA.',
  'focus-order':
    'Avoid positive tabindex; rely on DOM order or tabindex="0" for a natural focus flow.',
  'html-lang': 'Set a lang attribute on <html> (e.g. lang="en").',
  'overflow-x':
    'Constrain width (max-width:100%, overflow-wrap, or a flex/grid min-width:0) to stop horizontal overflow.',
  'cls-image':
    'Set explicit width/height attributes or an aspect-ratio so the image reserves space and does not shift layout.',
};

// --- dedupe / evidence / correlation helpers ------------------------------

function dedupeKey(signal: CollectorSignal): string {
  switch (signal.kind) {
    case 'console':
      return `console:${signal.level}:${normalizeText(signal.text)}`;
    case 'exception':
      return `exception:${normalizeText(signal.message)}`;
    case 'rejection':
      return `rejection:${normalizeText(signal.reason)}`;
    case 'network':
      return `network:${signal.method}:${hostPath(signal.url)}:${signal.ok ? 'slow' : (signal.failure ?? signal.status ?? 'fail')}`;
    case 'a11y':
      return `a11y:${signal.rule}:${signal.selector.value}`;
    case 'layout':
      return `layout:${signal.rule}:${signal.selector.value}`;
  }
}

function evidenceFrom(group: CollectorSignal[]): Evidence[] {
  const out: Evidence[] = [];
  for (const signal of group.slice(0, MAX_EVIDENCE_PER_FINDING)) {
    out.push({ kind: evidenceKindOf(signal.kind), detail: evidenceDetail(signal).slice(0, 4000) });
  }
  return dedupeEvidence(out);
}

function evidenceKindOf(kind: CollectorSignal['kind']): Evidence['kind'] {
  if (kind === 'network') return 'network';
  if (kind === 'a11y' || kind === 'layout') return 'selector';
  return 'log';
}

function evidenceDetail(signal: CollectorSignal): string {
  switch (signal.kind) {
    case 'console':
      return signal.text;
    case 'exception':
      return signal.stack ?? signal.message;
    case 'rejection':
      return signal.reason;
    case 'network':
      return `${signal.method} ${networkOutcomeLabel(signal)} ${signal.url}`;
    case 'a11y':
    case 'layout':
      return `${signal.selector.value} — ${signal.detail}`;
  }
}

function dedupeEvidence(evidence: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const item of evidence) {
    const key = `${item.kind}:${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function haystackOf(finding: Finding): string {
  return [finding.title, finding.detail, ...finding.evidence.map((e) => e.detail)]
    .join('\n')
    .toLowerCase();
}

// --- small pure utilities -------------------------------------------------

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, error: 1, warning: 2, info: 3 };
const CATEGORY_RANK: Record<DiagnosticCategory, number> = {
  runtime: 0,
  network: 1,
  interaction: 2,
  state: 3,
  a11y: 4,
  layout: 5,
};

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] ||
      b.occurrences - a.occurrences ||
      a.id.localeCompare(b.id),
  );
}

/** Host + path of a URL (query/hash/protocol stripped) so the same endpoint dedupes and correlates
 *  regardless of cache-busting query params. Falls back to the trimmed input for a non-URL. */
export function hostPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.replace(/\/$/, '');
  } catch {
    return url.trim();
  }
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/:\d+:\d+/g, '') // drop trailing line:col so the same error at shifting positions merges
    .replace(/\d{3,}/g, '#') // collapse long numbers (ids, timestamps)
    .trim()
    .slice(0, 200);
}

function describeStep(step: ReproStep): string {
  return `${step.action}${step.selector ? ` ${step.selector}` : ''}${step.value ? ` = ${step.value}` : ''}`;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorResult(error: string): ToolResult {
  return { type: 'tool-result', ok: false, error };
}

// FNV-1a hash → base36: a stable, dependency-free content address for a finding id, so the same
// signals always yield the same id (dedupe/correlate/report re-runs stay referentially stable).
function stableId(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
