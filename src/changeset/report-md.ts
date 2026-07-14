// Markdown rendering for the handoff report (slice 07 / PR12: `agent/report.ts` assembles the full
// `Report` — summary, findings, problems, pros/cons, links, images — and this module will grow a
// `toMarkdown(report)` to turn it into a paste-ready brief). This file lands early as the slice-14/16
// hooks that PR12 wires in: identity extraction (14) already produces a token-like `IdentityResult`
// (role-tagged palette + type scale + spacing/radius/shadow rhythm), and the responsive scanner (16)
// produces per-breakpoint `CheckResponsiveResult`s + `ResponsiveShot`s — the report is supposed to
// "speak in tokens, not raw hex" and to show findings/shots per breakpoint, not just at whatever width
// happened to be current — so those renderers are written and tested now, against the real shapes,
// rather than re-derived when PR12 assembles the rest of the report around them.
//
// Pure string builders: no chrome.*, no I/O, deterministic (same input, same Markdown out) —
// unit-testable exactly like `system-prompt.ts`. `renderIdentityTokens` is the piece PR12's
// `toMarkdown(report)` calls for the report's tokens table + typography/spacing sections;
// `renderResponsiveFindings` / `renderResponsiveShots` are the pieces it calls for the per-breakpoint
// responsive section.

import type {
  CheckResponsiveResult,
  IdentityColor,
  IdentityResult,
  ResponsiveSeverity,
  ResponsiveShot,
} from '@/shared/messages';

/** One breakpoint's `checkResponsive` result, labeled for the report — the shape a turn accumulates
 *  by calling `checkResponsive` once per breakpoint (after `setDevice`) across a debug/copy pass. */
export interface ResponsiveBreakpointFindings {
  /** Human label for the breakpoint, e.g. a device preset name or a custom "768×1024". */
  readonly label: string;
  readonly result: CheckResponsiveResult;
}

const SEVERITY_LABEL: Record<ResponsiveSeverity, string> = {
  serious: 'Serious',
  moderate: 'Moderate',
  minor: 'Minor',
};

// Most severe first within a breakpoint's table — mirrors the scanner's own ordering guarantee
// (src/dom/responsive.ts), re-asserted here in case a caller passes findings from elsewhere.
const SEVERITY_RANK: Record<ResponsiveSeverity, number> = { serious: 0, moderate: 1, minor: 2 };

const ROLE_LABEL: Record<IdentityColor['role'], string> = {
  bg: 'Background',
  fg: 'Foreground',
  accent: 'Accent',
  border: 'Border',
};

/**
 * Render an extracted design identity as a Markdown tokens table (color roles + hex + sample
 * count) followed by compact typography / spacing / radius / shadow lines — the shape a developer
 * brief or handoff spec can act on directly, per `docs/idea/agent.md`'s "reports speak in tokens,
 * not raw hex". Returns `''` for an identity with nothing extracted (an empty palette and type
 * scale) so an empty section never renders as a bare heading in the assembled report.
 */
export function renderIdentityTokens(identity: IdentityResult): string {
  const sections: string[] = [];

  if (identity.palette.length > 0) sections.push(paletteTable(identity.palette));
  const type = typeScaleLines(identity);
  if (type) sections.push(type);
  const rhythm = rhythmLines(identity);
  if (rhythm) sections.push(rhythm);

  return sections.join('\n\n');
}

function paletteTable(palette: readonly IdentityColor[]): string {
  const rows = palette.map((c) => `| ${ROLE_LABEL[c.role]} | \`${c.hex}\` | ${c.count} |`);
  return [
    '### Color tokens',
    '',
    '| Role | Token | Sampled |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function typeScaleLines(identity: IdentityResult): string | undefined {
  const { families, sizes, weights } = identity.type;
  if (families.length === 0 && sizes.length === 0 && weights.length === 0) return undefined;
  const lines = ['### Typography'];
  if (families.length > 0) lines.push(`- **Families:** ${families.join(', ')}`);
  if (sizes.length > 0) lines.push(`- **Scale:** ${sizes.map((s) => `${s}px`).join(', ')}`);
  if (weights.length > 0) lines.push(`- **Weights:** ${weights.join(', ')}`);
  return lines.join('\n');
}

function rhythmLines(identity: IdentityResult): string | undefined {
  const { spacing, radius, shadows } = identity;
  if (spacing.length === 0 && radius.length === 0 && shadows.length === 0) return undefined;
  const lines = ['### Spacing & effects'];
  if (spacing.length > 0) lines.push(`- **Spacing:** ${spacing.map((s) => `${s}px`).join(', ')}`);
  if (radius.length > 0) lines.push(`- **Radius:** ${radius.map((r) => `${r}px`).join(', ')}`);
  if (shadows.length > 0) lines.push(`- **Shadows:** ${shadows.join('; ')}`);
  return lines.join('\n');
}

/**
 * Render `checkResponsive` results across breakpoints as one Markdown table per breakpoint (most
 * severe finding first), so a reviewer sees which viewport a mobile/tablet problem shows up at
 * instead of one undifferentiated list (per slice 16's "check mobile + tablet" doctrine). Skips a
 * breakpoint with no findings — a clean breakpoint doesn't need a table — and returns `''` when
 * every breakpoint is clean.
 */
export function renderResponsiveFindings(
  breakpoints: readonly ResponsiveBreakpointFindings[],
): string {
  const sections = breakpoints
    .filter((bp) => bp.result.findings.length > 0)
    .map((bp) => {
      const rows = [...bp.result.findings]
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
        .map(
          (f) =>
            `| ${SEVERITY_LABEL[f.severity]} | ${f.category} | ${f.detail} | \`${f.selector.value}\` |`,
        );
      return [
        `### ${bp.label} (${bp.result.viewportWidth}px)`,
        '',
        '| Severity | Category | Detail | Selector |',
        '| --- | --- | --- | --- |',
        ...rows,
      ].join('\n');
    });

  return sections.join('\n\n');
}

/**
 * Render a `responsiveCapture` shot set as one image (or failure note) per breakpoint, so the
 * report shows how the page actually looked at each size instead of only the width the reviewer
 * happens to be reading on. Embeds successful shots as data-URI Markdown images; a breakpoint whose
 * capture failed gets a one-line note instead of a broken image link. Returns `''` for an empty set.
 */
export function renderResponsiveShots(shots: readonly ResponsiveShot[]): string {
  if (shots.length === 0) return '';

  const items = shots.map((shot) => {
    const dims = `${shot.metrics.width}×${shot.metrics.height}`;
    if (shot.image) {
      return `**${shot.label}** (${dims})\n\n![${shot.label}](data:image/png;base64,${shot.image})`;
    }
    return `**${shot.label}** (${dims}) — capture failed: ${shot.error ?? 'unknown error'}`;
  });

  return ['### Responsive captures', '', ...items].join('\n\n');
}
