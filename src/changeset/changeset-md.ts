import type { Changeset, Edit, StableSelector } from '@/shared/changeset';

// Rendering a Changeset for the EXPORT — the `.md` a user downloads when no coding backend is
// connected and hands to their own coding agent. That file is the durable product: the live page
// edits vanish on reload, the conversation stays in the panel, and this Markdown is the only thing
// that leaves. It is read by an agent working in a repo it has never seen, with nothing else.
//
// Which sets the bar. A faithful dump of the record — a `margin: 0px 464.5px` against a four-deep
// nth-of-type path — is technically accurate and operationally worthless: the value is a computed
// number that is wrong at every other window width, and the selector names one database row on one
// page load. So this renderer does three things a dump does not:
//
//   1. Emits the style deltas as REAL CSS, one rule per edit, intent as the comment above it. A
//      coding agent can lift a stylesheet; it cannot lift a table of property deltas.
//   2. Says out loud when a selector cannot be trusted, instead of presenting it as authoritative.
//      A fragile selector with a "find this element by its content" note is actionable; the same
//      selector presented as a fact sends the agent looking for markup that does not exist.
//   3. Describes structural edits as structure, not as a sequence of node operations.
//
// Pure string builders — no chrome.*, no I/O, deterministic. Split out of report-md.ts (which
// renders the model-authored prose) because this half renders the MECHANICAL record; they meet
// only in `toMarkdown`.

const FENCE = '```';
const CSS_FENCE = `${FENCE}css`;
const HTML_FENCE = `${FENCE}html`;
const COMMENT_CLOSE = `*${'/'}`;

/** How the honesty note reads per selector strategy. `null` = the selector is trustworthy enough
 *  to present without a caveat. */
function selectorCaveat(selector: StableSelector): string | null {
  if (!selector.fragile) return null;
  if (selector.value.includes('nth-of-type')) {
    return 'positional path — it encodes where the element sat in the DOM, not what it is. Locate it by its text or its role, then apply the rule to whatever selector your source actually uses.';
  }
  if (selector.strategy === 'id') {
    return 'record-key id — it identifies one row of data, not an element in the template. Find the template that renders this row.';
  }
  if (selector.strategy === 'shadow') {
    return 'shadow-DOM host path — the element lives inside a custom element; the rule belongs in that component, not in a page stylesheet.';
  }
  return 'not a stable handle — confirm the target before applying this.';
}

/** A CSS comment body, with any comment terminator neutralized so an intent string can never close
 *  the comment it sits in and turn the rest of the rule into CSS. */
function comment(text: string): string {
  return text.split(COMMENT_CLOSE).join('*\\/').trim();
}

/**
 * The edits as a stylesheet — the section a coding agent actually lifts. One rule per edit that
 * changed style properties, the edit's intent as the comment above it, and a caveat comment when
 * the selector cannot be trusted.
 *
 * Empty string when no edit carries a style change (a purely structural or copy session).
 */
export function renderStylesheet(changeset: Changeset): string {
  const sections: string[] = [];

  // AUTHORED sheets first. An `injectCss` sheet is CSS a human wrote with real selectors, custom
  // properties and media queries — it is the thing a developer lifts, and it outranks anything
  // reconstructed from per-element deltas. Held at most one entry per id (a re-injection replaces),
  // so this is the LATEST version of each sheet, not a history of the agent's attempts.
  for (const sheet of changeset.stylesheets) {
    const header = sheet.intent ? `### ${sheet.intent}` : `### Stylesheet \`${sheet.id}\``;
    sections.push([header, '', CSS_FENCE, sheet.css.trim(), FENCE].join('\n'));
  }

  // Then the per-element edits, reconstructed as rules. These are the changes made BEFORE or
  // BESIDE a stylesheet — one-off nudges the agent pinned to a single element.
  const rules = changeset.edits.filter((e) => e.changes.length > 0).map(cssRule);
  if (rules.length > 0) {
    sections.push(
      [
        changeset.stylesheets.length > 0 ? '### Per-element adjustments' : '',
        '',
        CSS_FENCE,
        rules.join('\n\n'),
        FENCE,
      ]
        .filter((line, i) => !(i === 0 && line === ''))
        .join('\n'),
    );
  }

  if (sections.length === 0) return '';
  return [
    '## Proposed CSS',
    '',
    'Lift these rules into the stylesheet that owns each element. Values are what the page ended up with, not necessarily what the source should say — prefer the intent over the literal number where they disagree.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

function cssRule(edit: Edit): string {
  const open = `/${'*'} `;
  const close = ` ${COMMENT_CLOSE}`;
  const lines: string[] = [`${open}${comment(edit.intent)}${close}`];
  const caveat = selectorCaveat(edit.selector);
  if (caveat) lines.push(`${open}selector: ${comment(caveat)}${close}`);
  if (edit.breakpoint) {
    lines.push(`${open}applies at breakpoint: ${comment(edit.breakpoint)}${close}`);
  }
  lines.push(`${edit.selector.value} {`);
  for (const change of edit.changes) lines.push(`  ${change.prop}: ${change.after};`);
  lines.push('}');
  return lines.join('\n');
}

/**
 * The edits as a reviewable list — intent, target, honesty about the target, and the non-style
 * deltas (structure, copy, attributes, classes) that a stylesheet cannot express. Complements
 * {@link renderStylesheet}: that section is what gets applied, this one is what gets read.
 *
 * Empty string for an empty changeset, so a prose-only report never renders a bare heading.
 */
export function renderChangeset(changeset: Changeset): string {
  if (changeset.edits.length === 0) return '';
  const sections = changeset.edits.map((edit, index) => editSection(edit, index + 1));
  return ['## Edits', '', confidenceLine(changeset), '', sections.join('\n\n')].join('\n');
}

/** One line stating how much of this changeset can be mapped back to source at all. A reviewer
 *  reads this before deciding how much to trust the rest. */
function confidenceLine(changeset: Changeset): string {
  const total = changeset.edits.length;
  const plural = total === 1 ? '' : 's';
  const shaky = changeset.edits.filter((e) => e.selector.fragile).length;
  if (shaky === 0) {
    return `${total} edit${plural}; every target has a stable selector.`;
  }
  return `${total} edit${plural}, ${shaky} of them against a selector that will not survive the next page load (marked below). Those need the element found by what it contains, not by the path given.`;
}

function editSection(edit: Edit, n: number): string {
  const lines: string[] = [`### ${n}. ${edit.intent}`, ''];
  const caveat = selectorCaveat(edit.selector);
  lines.push(`**Target:** \`${edit.selector.value}\` (${edit.selector.strategy})`);
  if (caveat) lines.push('', `> **Unreliable selector** — ${caveat}`);
  if (edit.breakpoint) lines.push('', `**Breakpoint:** ${edit.breakpoint}`);
  if (edit.frameworkHints.length > 0) {
    lines.push('', `**Styling approach:** ${edit.frameworkHints.join(', ')}`);
  }

  if (edit.changes.length > 0) {
    lines.push('', '| Property | Was | Now |', '| --- | --- | --- |');
    for (const c of edit.changes) {
      lines.push(`| \`${c.prop}\` | ${c.before ?? '—'} | ${c.after} |`);
    }
  }
  const structural = structuralProse(edit);
  if (structural) lines.push('', structural);
  if (edit.text) {
    lines.push('', `**Copy:** "${edit.text.before}" → "${edit.text.after}"`);
  }
  for (const a of edit.attrs) {
    lines.push(
      '',
      a.after === null
        ? `**Attribute removed:** \`${a.name}\` (was \`${a.before ?? ''}\`)`
        : `**Attribute:** \`${a.name}\` → \`${a.after}\``,
    );
  }
  for (const c of edit.classes) {
    lines.push('', `**Class ${c.op === 'add' ? 'added' : 'removed'}:** \`${c.name}\``);
  }
  return lines.join('\n');
}

/** A structural edit described as STRUCTURE. "Move this node after that node" is a replay script;
 *  what a coding agent needs is what the markup should become. */
function structuralProse(edit: Edit): string {
  const s = edit.structural;
  if (!s) return '';
  switch (s.op) {
    case 'remove':
      return '**Structure:** this element is removed from the page.';
    case 'move':
      return `**Structure:** this element moves to \`${s.refSelector.value}\` (${s.position ?? 'beforeend'}). In source this is a change of where the element is rendered, not a runtime move.`;
    case 'insert':
      return [
        `**Structure:** new markup added ${s.position ?? 'beforeend'} \`${s.refSelector?.value ?? 'the target'}\`:`,
        '',
        HTML_FENCE,
        s.html,
        FENCE,
      ].join('\n');
    case 'wrap':
      // The restructuring ops are described as the SHAPE THE MARKUP SHOULD TAKE, because that is
      // what a coding agent edits. "Insert a node then move six siblings into it" is a replay
      // script for a live DOM and means nothing in a template.
      return [
        s.endSelector
          ? `**Structure:** this element **through** \`${s.endSelector.value}\` — the whole run of siblings — is wrapped in a new container. In source, render that range inside:`
          : '**Structure:** this element is wrapped in a new container. In source, render it inside:',
        '',
        HTML_FENCE,
        s.html,
        FENCE,
      ].join('\n');
    case 'unwrap':
      return [
        '**Structure:** this wrapper is removed and its children take its place — one level of nesting deleted, no content lost. The wrapper was:',
        '',
        HTML_FENCE,
        s.html,
        FENCE,
      ].join('\n');
    case 'replace': {
      const lines = [
        '**Structure:** this element and its whole subtree become:',
        '',
        HTML_FENCE,
        s.html,
        FENCE,
      ];
      if (s.replacedHtml) {
        lines.push('', 'Replacing:', '', HTML_FENCE, s.replacedHtml, FENCE);
      }
      return lines.join('\n');
    }
  }
}
