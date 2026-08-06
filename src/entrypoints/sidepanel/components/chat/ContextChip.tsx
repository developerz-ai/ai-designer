import { createMemo, createSignal, Show } from 'solid-js';
import { i18n } from '#i18n';
import type { StableSelector } from '@/shared/messages';
import { Icon } from '../Icon';
import './ContextChip.scss';

// One attached element, Cursor-style: a numbered, removable chip that names the element the
// way a person would ("Hero heading", "Pricing card 2") and keeps the raw CSS selector one
// disclosure away. The index it carries is the index its rectangle carries on the page, so a
// chip and its outline identify each other without hovering.
//
// Presentational + dispatch-only (CLAUDE.md "SolidJS + SRP"): the row above it (ElementRefs)
// owns which references exist and what removing one means.

const STRATEGY_LABEL: Record<StableSelector['strategy'], string> = {
  'data-attr': i18n.t('contextChip.strategy.dataAttr'),
  id: i18n.t('contextChip.strategy.id'),
  aria: i18n.t('contextChip.strategy.aria'),
  text: i18n.t('contextChip.strategy.text'),
  'css-path': i18n.t('contextChip.strategy.cssPath'),
  shadow: i18n.t('contextChip.strategy.shadow'),
  xpath: i18n.t('contextChip.strategy.xpath'),
};

/** Formats a pinned selector for the chip's expanded detail line and its tooltip: value first
 *  (truncated so a long CSS path or text match doesn't blow out the composer's width), strategy
 *  as context. Pure so it's unit-testable without mounting Solid. */
export function describeSelector(sel: StableSelector, maxLength = 40): string {
  const value = sel.value.length > maxLength ? `${sel.value.slice(0, maxLength - 1)}…` : sel.value;
  return `${value} · ${STRATEGY_LABEL[sel.strategy]}`;
}

// Tags whose own name is already the human word for what they are. Anything absent from this
// map falls back to its class name, then to the tag itself — never to a guess.
const TAG_WORD: Record<string, string> = {
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  h4: 'Heading',
  h5: 'Heading',
  h6: 'Heading',
  p: 'Text',
  a: 'Link',
  img: 'Image',
  button: 'Button',
  input: 'Field',
  textarea: 'Field',
  select: 'Field',
  form: 'Form',
  nav: 'Nav',
  header: 'Header',
  footer: 'Footer',
  main: 'Main',
  aside: 'Sidebar',
  ul: 'List',
  ol: 'List',
  li: 'List item',
  table: 'Table',
  video: 'Video',
  svg: 'Icon',
};

/** `hero-title` / `heroTitle` / `hero_title` -> `Hero title`. One capital, at the front — title
 *  case on every word turns a class list into a headline and reads louder than the chip it sits in. */
function titleise(raw: string): string {
  const words = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : raw;
}

/**
 * A human name for an attached element — the chip's PRIMARY label, because `.hero > div:nth-child(2)`
 * tells a designer nothing about what they pinned. Derived from the selector's last segment, in
 * descending order of how much a person would recognise it:
 *
 *   `#cta`                          -> `#cta`          (an id already IS the human name)
 *   `.pricing .card:nth-of-type(2)` -> `Card 2`        (class, plus its position among siblings)
 *   `section.hero > h1`             -> `Heading`       (known tag word)
 *   `x-widget`                      -> `X widget`      (unknown tag, titleised)
 *
 * Strategy-independent by design: `StableSelector.value` is ALWAYS a legal `querySelector`
 * argument whatever the strategy says (src/dom/selector.ts — a `text` candidate carries the bare
 * tag, not the matched text, because text content cannot be matched by `querySelector`). Pure and
 * total: an unparseable value returns itself, never an empty chip.
 */
export function humanName(sel: StableSelector, maxLength = 28): string {
  const name = deriveName(sel);
  return name.length > maxLength ? `${name.slice(0, maxLength - 1)}…` : name;
}

function deriveName(sel: StableSelector): string {
  // Last segment of the path: what the selector actually resolves TO. Everything before it is
  // scope, and scope is not what the user pinned.
  const segment =
    sel.value
      .split(/\s*[>+~]\s*|\s+/)
      .filter(Boolean)
      .at(-1) ?? sel.value;

  const id = segment.match(/#([\w-]+)/)?.[1];
  if (id) return `#${id}`;

  // `:nth-of-type(2)` / `:nth-child(2)` — the position is the only thing distinguishing this
  // element from its siblings, so it belongs in the name rather than being dropped as noise.
  const nth = segment.match(/:nth-(?:of-type|child)\((\d+)\)/)?.[1];
  const suffix = nth ? ` ${nth}` : '';

  const className = segment.match(/\.([\w-]+)/)?.[1];
  if (className) return `${titleise(className)}${suffix}`;

  const tag = segment.match(/^([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase();
  if (tag) return `${TAG_WORD[tag] ?? titleise(tag)}${suffix}`;

  return sel.value;
}

export interface ContextChipProps {
  /** 1-based position, shared with the element's on-page rectangle. */
  index: number;
  selector: StableSelector;
  onRemove: () => void;
}

export function ContextChip(props: ContextChipProps) {
  const [expanded, setExpanded] = createSignal(false);
  const detail = createMemo(() => describeSelector(props.selector));

  return (
    <span class="dz-context-chip-wrap">
      <span
        class="dz-context-chip"
        classList={{ 'dz-context-chip--fragile': props.selector.fragile }}
      >
        <span class="dz-context-chip__index">{props.index}</span>
        {/* A fragile selector is the one thing about a reference that can bite later — it earns
            a glyph in the chip rather than only a colour, which alone is not a distinction. */}
        <Show when={props.selector.fragile}>
          <span class="dz-context-chip__fragile" title={i18n.t('contextChip.fragile')}>
            <Icon name="warning" size="sm" class="dz-icon--fixed" />
          </span>
        </Show>
        {/* The name is the button: tapping a reference reveals what it actually resolves to.
            `title` carries the same string for a pointer user who only hovers. */}
        <button
          type="button"
          class="dz-context-chip__label"
          title={detail()}
          aria-expanded={expanded()}
          onClick={() => setExpanded((v) => !v)}
        >
          {humanName(props.selector)}
        </button>
        <button
          type="button"
          class="dz-context-chip__dismiss"
          aria-label={i18n.t('contextChip.remove.ariaLabel')}
          onClick={() => props.onRemove()}
        >
          <Icon name="close" size="sm" class="dz-icon--fixed" />
        </button>
      </span>
      <Show when={expanded()}>
        <code class="dz-context-chip__detail">{detail()}</code>
      </Show>
    </span>
  );
}
