// Markdown rendering for the handoff report (slice 07 / PR12: `agent/report.ts` assembles the full
// `Report` — summary, findings, problems, pros/cons, links, images — and this module will grow a
// `toMarkdown(report)` to turn it into a paste-ready brief). This file lands early as the slice-14
// hook that PR12 wires in: identity extraction (14) already produces a token-like `IdentityResult`
// (role-tagged palette + type scale + spacing/radius/shadow rhythm), and the report is supposed to
// "speak in tokens, not raw hex" — so the identity→Markdown renderer is written and tested now,
// against the real `IdentityResult` shape, rather than re-derived when PR12 assembles the rest of
// the report around it.
//
// Pure string builder: no chrome.*, no I/O, deterministic (same `IdentityResult` in, same Markdown
// out) — unit-testable exactly like `system-prompt.ts`. `renderIdentityTokens` is the piece PR12's
// `toMarkdown(report)` calls for the report's tokens table + typography/spacing sections.

import type { IdentityColor, IdentityResult } from '@/shared/messages';

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
