import { z } from 'zod';

// The handoff report domain model — the agent-authored developer brief `src/agent/report.ts`
// produces from a design session (changeset + diagnostics + extracted identity + screenshots) and
// `src/changeset/report-md.ts` renders to paste-ready Markdown (docs/idea/handoff.md). Kept OUT of
// `messages.ts` (the bus-transport hub) on purpose, exactly like `diagnostics.ts`: this is the
// domain shape; the `download-report` / `send-report` message + result variants that carry a
// `Report` over the bus are wired in the handoff task (slice 07). Every list is length-bounded so an
// over-eager model reply can't blow the panel's render or a downstream token budget.

// The design identity distilled for the brief: display-ready token lists, not the raw
// `IdentityResult`. `report.ts` grounds these from the extracted identity (slice 14) so the brief
// "speaks in tokens, not raw hex" (docs/idea/agent.md) rather than letting the model invent values.
export const ReportIdentity = z.object({
  colors: z.array(z.string().max(40)).max(24).default([]),
  fonts: z.array(z.string().max(120)).max(12).default([]),
  spacing: z.array(z.string().max(40)).max(16).default([]),
});
export type ReportIdentity = z.infer<typeof ReportIdentity>;

// A reference link in the brief — the edited page, a browsed reference site, or a doc. `label` is
// what the reader clicks; `url` is grounded from the session (page URL, `browse` targets), never
// free-typed by the model.
export const ReportLink = z.object({
  label: z.string().max(200),
  url: z.string().max(2048),
});
export type ReportLink = z.infer<typeof ReportLink>;

// An embedded image in the brief — a before/after edit screenshot or a captured shot (slice 13).
// `src` is a `data:` URL (base64 capture) or an `http(s)` URL; the Markdown renderer embeds it.
// Grounded from the session, so the brief shows what the page actually looked like.
export const ReportImage = z.object({
  label: z.string().max(200),
  src: z.string(),
  caption: z.string().max(400).optional(),
});
export type ReportImage = z.infer<typeof ReportImage>;

// The prose the model authors — the senior-dev voice of the brief. Split out from `Report` so the
// summarization pass asks the model for exactly these fields (grounded identity/links/images are
// merged in afterward, never hallucinated). Bullets, not paragraphs: paste-ready for a coding agent.
export const ReportDraft = z.object({
  summary: z.string().max(4000),
  findings: z.array(z.string().max(600)).max(40).default([]),
  problems: z.array(z.string().max(600)).max(40).default([]),
  pros: z.array(z.string().max(400)).max(24).default([]),
  cons: z.array(z.string().max(400)).max(24).default([]),
  recommendations: z.array(z.string().max(600)).max(24).default([]),
});
export type ReportDraft = z.infer<typeof ReportDraft>;

// The full brief: the model-authored prose ({@link ReportDraft}) plus the deterministically grounded
// identity tokens, links, and images. This is what downloads as Markdown or dispatches to a coding
// backend over MCP (slice 07). `.default`s let a partial value (a sparse model reply merged with
// grounded fields) still parse into a complete, renderable report.
export const Report = ReportDraft.extend({
  identity: ReportIdentity.default({ colors: [], fonts: [], spacing: [] }),
  links: z.array(ReportLink).max(40).default([]),
  images: z.array(ReportImage).max(24).default([]),
});
export type Report = z.infer<typeof Report>;
