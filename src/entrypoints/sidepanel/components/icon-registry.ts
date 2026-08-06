// The panel's entire glyph set, drawn inline — ported from the v0 redesign
// (`docs/design/v0-redesign-prompt.md`, realised in `docs/design/designer/app/app.tsx`).
//
// One visual language, no exceptions: a 16×16 viewBox, 1.5px stroke, round caps and
// joins, `currentColor`. That is the whole reason this replaced FontAwesome — the free
// solid set is a *filled* language, so every FA glyph read a weight heavier than the
// hairline chrome around it and the panel looked like a dev tool wearing icons borrowed
// from somewhere else. Filled nodes are the deliberate exception (Play, Stop, the status
// dot), and they carry `fill`/`stroke` on the node itself.
//
// Adding a glyph = one entry below. Nothing is fetched at runtime, nothing goes through
// `innerHTML`, and there is no icon package in `package.json` left to tree-shake.

/** One SVG child node: its tag and its attributes. Attribute values are literals from
 *  this file only — never interpolated from anything a page or a message supplies. */
type GlyphNode = readonly [tag: 'path' | 'circle' | 'rect', attrs: Record<string, string>];

// Shorthands, so the table below reads as glyph data and not as attribute noise.
const p = (d: string): GlyphNode => ['path', { d }];
const c = (cx: number, cy: number, r: number, solid = false): GlyphNode => [
  'circle',
  {
    cx: String(cx),
    cy: String(cy),
    r: String(r),
    ...(solid ? { fill: 'currentColor', stroke: 'none' } : {}),
  },
];
const rect = (x: number, y: number, w: number, h: number, r: number, solid = false): GlyphNode => [
  'rect',
  {
    x: String(x),
    y: String(y),
    width: String(w),
    height: String(h),
    rx: String(r),
    ...(solid ? { fill: 'currentColor', stroke: 'none' } : {}),
  },
];

const REGISTRY = {
  // ── v0's set, path data verbatim ──────────────────────────────────────────
  check: [p('M3 8.5 6.2 11.6 13 4.6')],
  warning: [p('M8 2.6 14.4 13.4H1.6L8 2.6Z'), p('M8 6.6v3.1M8 11.7h.01')],
  close: [p('M4 4l8 8M12 4l-8 8')],
  chevronDown: [p('M4 6.5 8 10.5 12 6.5')],
  chevronRight: [p('M6.5 4 10.5 8 6.5 12')],
  arrowUp: [p('M8 13V3.5M8 3.5 4.2 7.3M8 3.5l3.8 3.8')],
  stop: [rect(4.5, 4.5, 7, 7, 1.5, true)],
  play: [p('M5 3.6 12.4 8 5 12.4V3.6Z')],
  spinner: [c(8, 8, 5.5), p('M13.5 8A5.5 5.5 0 0 0 8 2.5')],
  target: [p('M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3'), rect(5, 5, 6, 6, 1)],
  diff: [p('M4 2.5v11M2 5h4M2.5 11.5h3'), p('M12 13.5v-11M10 11h4')],
  history: [p('M8 4.2V8l2.6 1.6'), p('M2.6 8a5.4 5.4 0 1 0 1.6-3.8L2.4 6'), p('M2.2 2.8v3.3h3.3')],
  info: [c(8, 8, 6), p('M8 7.4v3.4M8 5.3h.01')],
  externalLink: [
    p('M9 3h4v4M12.6 3.4 7.4 8.6'),
    p('M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.6'),
  ],
  trash: [p('M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2')],
  search: [c(7, 7, 4.3), p('M10.2 10.2 14 14')],
  download: [p('M8 2.5v7.5M8 10 4.6 6.6M8 10l3.4-3.4M3 13h10')],
  // A paper plane. The previous glyph was a teardrop with a circle in it, meant to read as a
  // rocket/pin; at 16px next to the word "Ship" it read as a leaf, and nobody could name it.
  // A plane is the one shape that already means "send this off" everywhere else.
  ship: [p('M14.2 2.2 1.9 7.4l4.6 1.9 1.9 4.6 5.8-11.7Z'), p('M6.5 9.3 14.2 2.2')],
  copy: [rect(5.5, 2.5, 8, 9, 1.5), p('M10.5 13.5H4a1.5 1.5 0 0 1-1.5-1.5V5')],
  bug: [
    rect(5, 5.5, 6, 7.5, 3),
    p('M5 8H2.5M11 8h2.5M5.4 11.4 3.4 12.6M10.6 11.4l2 1.2M6 5.2 5 3.4M10 5.2l1-1.8'),
  ],
  mcp: [p('M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0V5.5ZM8 11.2v2.3')],
  // v0 knocks the three handles out with `fill="var(--dz-elev-card)"`. A presentation
  // attribute resolving a custom property only holds if the glyph sits on that exact
  // surface — ours also renders on `--dz-elev-base` and inside an accent-filled button.
  // Gapped rails give the identical read on any background with no surface assumption.
  sliders: [
    p('M3 4.5h1.6M7.4 4.5h5.6M3 8h5.6M11.4 8h1.6M3 11.5h.6M6.4 11.5h6.6'),
    c(6, 4.5, 1.4),
    c(10, 8, 1.4),
    c(5, 11.5, 1.4),
  ],

  // ── drawn for this panel, same language: 16 viewBox, 1.5 stroke, round ────
  add: [p('M8 3.5v9M3.5 8h9')],
  back: [p('M12.5 8H3.5M3.5 8 7.1 4.4M3.5 8l3.6 3.6')],
  eye: [p('M1.8 8S4.4 4 8 4s6.2 4 6.2 4-2.6 4-6.2 4-6.2-4-6.2-4Z'), c(8, 8, 1.9)],
  undo: [p('M5.6 4 2.6 7l3 3'), p('M2.6 7h5.6a3.4 3.4 0 1 1 0 6.8H5.6')],
  redo: [p('M10.4 4 13.4 7l-3 3'), p('M13.4 7H7.8a3.4 3.4 0 1 0 0 6.8h2.6')],
  repo: [
    c(4.5, 3.5, 1.6),
    c(4.5, 12.5, 1.6),
    c(11.5, 3.5, 1.6),
    p('M4.5 5.1v5.8'),
    p('M11.5 5.1v1.5a2.9 2.9 0 0 1-2.9 2.9H6.1'),
  ],
  report: [
    p(
      'M8.8 1.8H4.5A1.5 1.5 0 0 0 3 3.3v9.4a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.8L8.8 1.8Z',
    ),
    p('M8.8 2v3.8h4'),
    p('M5.5 8.8h5M5.5 11.2h3.4'),
  ],
  settings: [
    c(8, 8, 2.2),
    p(
      'M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2M12.5 12.5l-1.2-1.2M4.7 4.7 3.5 3.5',
    ),
  ],
  site: [c(8, 8, 6), p('M2 8h12'), p('M8 2c1.9 1.9 1.9 10.1 0 12M8 2c-1.9 1.9-1.9 10.1 0 12')],
  status: [c(8, 8, 5.5), c(8, 8, 1.9, true)],
  agent: [
    p('M2.6 13.4 9.4 6.6'),
    p('M11.9 1.9l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z'),
    p('M5.4 2.4l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4.4-1.1Z'),
  ],
} as const satisfies Record<string, readonly GlyphNode[]>;

/**
 * The reusable icon-name union. Import this type wherever a component/message accepts
 * an icon name — do not redeclare a parallel union elsewhere.
 */
export type IconName = keyof typeof REGISTRY;

/** All registered names, e.g. for a Storybook-less visual smoke check or a <select>. */
export const ICON_NAMES = Object.keys(REGISTRY) as IconName[];

export type IconSize = 'sm' | 'md' | 'lg';

export interface IconClassOptions {
  size?: IconSize;
  spin?: boolean;
  /**
   * Sizes the glyph in absolute px (the --dz-icon-size-* tokens) instead of `em`.
   * The `em` default is right for an icon inline with a label, and wrong for chrome:
   * a header ghost action inside a container carrying `font-size: 0.8em` otherwise
   * shrinks with it. Use for toolbar/header/button glyphs that must not scale.
   */
  fixed?: boolean;
  class?: string;
}

/**
 * Builds the host `<span>` class list for `Icon` (size + spin + caller-supplied class).
 * Pure and side-effect-free so it's unit-testable without mounting Solid (CLAUDE.md
 * "no business logic in components" — Icon.tsx only maps this string onto the DOM).
 */
export function buildIconClass(options: IconClassOptions = {}): string {
  const size = options.size ?? 'md';
  const classes = ['dz-icon', `dz-icon--${size}`];
  if (options.fixed) classes.push('dz-icon--fixed');
  if (options.spin) classes.push('dz-icon--spin');
  if (options.class) classes.push(options.class);
  return classes.join(' ');
}

const FALLBACK_ICON: IconName = 'warning';

function isIconName(name: string): name is IconName {
  return Object.hasOwn(REGISTRY, name);
}

/**
 * Resolves an arbitrary string to a registered icon name, falling back to a visible
 * placeholder glyph instead of throwing or rendering nothing. `name` is typed `IconName`
 * at the `Icon` call site, but values that cross a serialization boundary (e.g. persisted
 * settings, a message from another world) aren't checked at runtime — this keeps those
 * safe.
 */
export function resolveIconName(name: string): IconName {
  return isIconName(name) ? name : FALLBACK_ICON;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// The stroke language, set once on the root and inherited by every child. A filled node
// overrides it with its own `fill`/`stroke` attributes, which beat an inherited value.
const ROOT_ATTRS: Record<string, string> = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.5',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
};

/**
 * Builds an icon's markup as a real SVG DOM tree from the literal glyph table above — no
 * `innerHTML`, no HTML-string parsing, so nothing here can execute injected or remote
 * markup, and no network request is made at runtime.
 */
export function buildIconSvg(name: string): SVGElement {
  const resolved = resolveIconName(name);
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [key, value] of Object.entries(ROOT_ATTRS)) svg.setAttribute(key, value);
  svg.setAttribute('data-icon', resolved);
  for (const [tag, attrs] of REGISTRY[resolved]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  return svg;
}
