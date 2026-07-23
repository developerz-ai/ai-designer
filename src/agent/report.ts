// The report summarization pass (slice 07) — an AI SDK call (the turn's own provider model) that
// reads a finished design session (changeset + debug diagnostics + extracted identity from slice 14
// + captured screenshots from slice 13) and authors a senior-web-developer brief: what changed, the
// design identity in tokens, problems, pros/cons, and actionable recommendations. Runs on the panel's
// "Download report" and on a chat "make a report" / "send to <backend>" command (docs/idea/handoff.md).
//
// The model authors only the prose ({@link ReportDraft}); identity tokens, links, and images are
// merged in deterministically afterward, so the brief "speaks in tokens, not raw hex" and embeds the
// real screenshots instead of anything hallucinated (docs/idea/agent.md). SW-only by usage (it owns
// the model — the key never leaves the service worker), chrome-free by construction: the model call
// is injected ({@link GenerateReport}), so this stays unit-testable against a fake `generate` with no
// `chrome.*`, exactly like `src/agent/vision.ts`. `background.ts` adapts the real `generateObject`.

import type { ImagePart, LanguageModel, ModelMessage } from 'ai';
import type { z } from 'zod';
import type { Changeset, Edit } from '@/shared/changeset';
import type { DiagnosticsReport, Finding } from '@/shared/diagnostics';
import type { IdentityResult } from '@/shared/messages';
import {
  Report,
  ReportDraft,
  type ReportIdentity,
  type ReportImage,
  type ReportLink,
} from '@/shared/report';

/** The turn's copy/debug framing (slice 06), so the brief leads with design fidelity vs diagnosed
 *  problems. Omitted ⇒ a neutral review. */
export type ReportMode = 'copy' | 'debug';

/** Everything the summarization pass reads about a session — assembled by the SW from the live
 *  changeset store, the debug engine, the identity extractor, and any captured shots. All but the
 *  changeset are optional: a plain copy turn has no diagnostics; a turn that never extracted identity
 *  has none. */
export interface ReportInput {
  /** The session's accepted edits — the durable record the brief is built around. */
  readonly changeset: Changeset;
  /** The correlated debug findings (slice 06), when this was a debug turn. */
  readonly diagnostics?: DiagnosticsReport;
  /** The page's extracted design identity (slice 14) — grounds the report's token lists. */
  readonly identity?: IdentityResult;
  /** Extra captured screenshots beyond each edit's before/after (full-page / responsive shots,
   *  slice 13) — embedded in the brief and shown to the vision model. */
  readonly images?: readonly ReportImage[];
  /** Reference links surfaced during the turn (e.g. `browse` targets) — merged after the page URL. */
  readonly links?: readonly ReportLink[];
  readonly mode?: ReportMode;
}

/** The structured-generation call — a structural subset of the AI SDK's `generateObject` so a fake
 *  stands in for tests; `background.ts` adapts the real `generateObject` to this shape (as it does
 *  `generateText` for {@link import('./vision').GenerateVision}). Returns the raw object; we
 *  re-validate it with {@link ReportDraft} so a loose reply can't skip the schema. */
export type GenerateReport = (args: {
  model: LanguageModel;
  schema: z.ZodType<ReportDraft>;
  system: string;
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
}) => Promise<{ object: unknown }>;

export interface ReportDeps {
  /** The turn's provider model (vision-capable — the brief reads screenshots). */
  readonly model: LanguageModel;
  readonly generate: GenerateReport;
}

// Schema caps mirrored from `src/shared/report.ts`, applied while grounding so `Report.parse` never
// rejects an over-long list (a session can hold more edits/shots than the brief should embed).
const MAX_IMAGES = 24;
const MAX_LINKS = 40;
// How many screenshots to actually feed the vision model — capped independently of the embedded set
// so a screenshot-heavy session doesn't blow the summarization call's token budget.
const MAX_VISION_IMAGES = 6;
// How much of a long session to describe in the prompt (defense-in-depth above the schema bounds).
const MAX_PROMPT_EDITS = 40;
const MAX_PROMPT_FINDINGS = 40;

const ROLE_LABEL: Record<IdentityResult['palette'][number]['role'], string> = {
  bg: 'background',
  fg: 'foreground',
  accent: 'accent',
  border: 'border',
};

/**
 * Run the summarization pass: show the model the assembled session (context text + screenshots),
 * have it author the brief's prose, then merge in the grounded identity tokens, links, and images.
 * A model reply that doesn't fit {@link ReportDraft} degrades to a deterministic summary rather than
 * throwing — the caller always gets a renderable {@link Report}. A model/transport error propagates
 * for the caller to surface.
 */
export async function generateReport(
  deps: ReportDeps,
  input: ReportInput,
  signal?: AbortSignal,
): Promise<Report> {
  const { object } = await deps.generate({
    model: deps.model,
    schema: ReportDraft,
    system: reportSystemPrompt(input.mode),
    messages: buildReportMessages(input),
    abortSignal: signal,
  });

  const parsed = ReportDraft.safeParse(object);
  const draft = parsed.success ? parsed.data : fallbackDraft(input);

  return Report.parse({
    ...draft,
    ...(input.identity ? { identity: identityTokens(input.identity) } : {}),
    links: collectLinks(input),
    images: collectImages(input),
  });
}

// --- prompt -----------------------------------------------------------------------------------

/** The reviewer persona + output contract, sharpened by mode. Bullets not essays; ground every
 *  claim in the provided session and screenshots; name tokens, not vibes. */
export function reportSystemPrompt(mode?: ReportMode): string {
  const focus =
    mode === 'debug'
      ? 'This was a DEBUG session: lead with the confirmed problems and concrete fixes.'
      : mode === 'copy'
        ? 'This was a COPY session: lead with the design identity and how faithfully it was applied.'
        : 'Lead with what changed and why it matters.';
  return (
    'You are a senior web developer writing a concise design review and handoff brief for another ' +
    'developer (or a coding agent) to act on. Speak in tokens — name the actual colors, fonts, and ' +
    'spacing — never vague adjectives. Be specific and concrete: cite real problems, honest ' +
    'pros/cons, and actionable recommendations. Ground EVERY claim in the provided changeset, ' +
    'diagnostics, identity, and screenshots — do not invent findings or values not present in the ' +
    `session. Write bullets, not paragraphs; keep it paste-ready. ${focus} Fill only the requested ` +
    'structured fields (identity tokens, links, and images are added for you — do not restate them).'
  );
}

/** Assemble the user turn: the session described as text, plus up to {@link MAX_VISION_IMAGES}
 *  screenshots as image parts so the vision model reviews what the page actually looks like. */
export function buildReportMessages(input: ReportInput): ModelMessage[] {
  const parts: Array<{ type: 'text'; text: string } | ImagePart> = [
    { type: 'text', text: buildReportContext(input) },
  ];
  for (const img of visionImages(input)) {
    parts.push({ type: 'text', text: `Screenshot: ${img.label}` });
    parts.push({ type: 'image', image: img.src });
  }
  return [{ role: 'user', content: parts }];
}

/** The session as a compact, bounded text digest the model reads before writing the brief. */
export function buildReportContext(input: ReportInput): string {
  const { changeset, diagnostics, identity, mode } = input;
  const sections: string[] = [
    `Mode: ${mode ?? 'review'}`,
    `Page: ${changeset.url}`,
    `Edits recorded: ${changeset.edits.length}`,
  ];

  if (changeset.edits.length > 0) {
    const rows = changeset.edits.slice(0, MAX_PROMPT_EDITS).map(summarizeEdit);
    if (changeset.edits.length > MAX_PROMPT_EDITS) {
      rows.push(`…and ${changeset.edits.length - MAX_PROMPT_EDITS} more edit(s).`);
    }
    sections.push(['Changes:', ...rows].join('\n'));
  }

  if (diagnostics && diagnostics.findings.length > 0) {
    const rows = diagnostics.findings.slice(0, MAX_PROMPT_FINDINGS).map(summarizeFinding);
    if (diagnostics.findings.length > MAX_PROMPT_FINDINGS) {
      rows.push(`…and ${diagnostics.findings.length - MAX_PROMPT_FINDINGS} more finding(s).`);
    }
    sections.push([`Diagnostics (${diagnostics.summary.total} total):`, ...rows].join('\n'));
  }

  if (identity) {
    const tokens = identityTokens(identity);
    const lines: string[] = [];
    if (tokens.colors.length > 0) lines.push(`Colors: ${tokens.colors.join(', ')}`);
    if (tokens.fonts.length > 0) lines.push(`Fonts: ${tokens.fonts.join(', ')}`);
    if (tokens.spacing.length > 0) lines.push(`Spacing: ${tokens.spacing.join(', ')}`);
    if (lines.length > 0) sections.push(['Design identity:', ...lines].join('\n'));
  }

  return sections.join('\n\n');
}

// One edit as a `intent — selector [breakpoint]: prop before→after` line. Grounds the model in what
// was actually changed, in the changeset's own vocabulary — style, attribute, class, and text deltas
// alike, so the brief speaks the structured delta, not just the intent prose (#139).
function summarizeEdit(edit: Edit): string {
  const changes = edit.changes.map((c) => `${c.prop} ${c.before ?? '∅'}→${c.after}`).join('; ');
  const attrs = edit.attrs
    .map((a) => `attr ${a.name} ${a.before ?? '∅'}→${a.after ?? '∅'}`)
    .join('; ');
  const classes = edit.classes.length
    ? `class ${edit.classes.map((c) => `${c.op === 'add' ? '+' : '-'}${c.name}`).join(', ')}`
    : '';
  const structural = edit.structural
    ? `struct ${edit.structural.op}${edit.structural.position ? ` ${edit.structural.position}` : ''}`
    : '';
  const text = edit.text ? ` text "${edit.text.before}"→"${edit.text.after}"` : '';
  const at = edit.breakpoint ? ` @${edit.breakpoint}` : '';
  const detail = [changes, attrs, classes, structural, text].filter(Boolean).join(';');
  return `- ${edit.intent} — \`${edit.selector.value}\`${at}${detail ? `: ${detail}` : ''}`;
}

// One diagnosed finding as a `severity/category: title (status) → fix` line.
function summarizeFinding(finding: Finding): string {
  const fix = finding.proposedFix ? ` → fix: ${finding.proposedFix}` : '';
  return `- ${finding.severity}/${finding.category}: ${finding.title} (${finding.status})${fix}`;
}

// --- deterministic grounding (pure, exported for unit coverage) --------------------------------

/** Distill an extracted identity (slice 14) into the brief's display-ready token lists — role-tagged
 *  colors, font families, spacing rhythm — so the report shows the page's real tokens, not the
 *  model's guess. Capped to the schema bounds. */
export function identityTokens(identity: IdentityResult): ReportIdentity {
  return {
    colors: identity.palette.slice(0, 24).map((c) => `${c.hex} (${ROLE_LABEL[c.role]})`),
    fonts: identity.type.families.slice(0, 12),
    spacing: identity.spacing.slice(0, 16).map((s) => `${s}px`),
  };
}

/** The brief's reference links: the edited page first, then any session links (browsed references),
 *  deduped by URL and capped. */
export function collectLinks(input: ReportInput): ReportLink[] {
  const seen = new Set<string>();
  const links: ReportLink[] = [];
  const push = (link: ReportLink): void => {
    if (seen.has(link.url) || links.length >= MAX_LINKS) return;
    seen.add(link.url);
    links.push(link);
  };
  if (input.changeset.url) push({ label: 'Edited page', url: input.changeset.url });
  for (const link of input.links ?? []) push(link);
  return links;
}

/** The brief's embedded images: each edit's before/after screenshot, then any extra captured shots,
 *  deduped by source and capped. Shows how the page actually looked, per breakpoint/edit. */
export function collectImages(input: ReportInput): ReportImage[] {
  const seen = new Set<string>();
  const images: ReportImage[] = [];
  const push = (img: ReportImage): void => {
    if (seen.has(img.src) || images.length >= MAX_IMAGES) return;
    seen.add(img.src);
    images.push(img);
  };
  for (const edit of input.changeset.edits) {
    if (edit.screenshots?.before)
      push({ label: `${edit.intent} — before`, src: edit.screenshots.before });
    if (edit.screenshots?.after)
      push({ label: `${edit.intent} — after`, src: edit.screenshots.after });
  }
  for (const img of input.images ?? []) push(img);
  return images;
}

// The screenshots actually shown to the model — data-URL/base64 sources only (a remote URL would
// need a fetch the SW shouldn't do here), capped so the vision call stays affordable.
function visionImages(input: ReportInput): ReportImage[] {
  return collectImages(input)
    .filter((img) => img.src.startsWith('data:') || !img.src.startsWith('http'))
    .slice(0, MAX_VISION_IMAGES);
}

// When the model's reply doesn't fit ReportDraft, still return a usable brief: a one-line summary
// assembled from the session, with empty prose lists the caller can render around the grounded
// identity/links/images.
function fallbackDraft(input: ReportInput): ReportDraft {
  const edits = input.changeset.edits.length;
  const problems = input.diagnostics?.summary.total ?? 0;
  const bits = [`${edits} edit(s) on ${input.changeset.url}`];
  if (problems > 0) bits.push(`${problems} diagnosed problem(s)`);
  return ReportDraft.parse({ summary: `Design session: ${bits.join(', ')}.` });
}
