import type { AbstractElement, IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { icon as faIcon } from '@fortawesome/fontawesome-svg-core';
import {
  faArrowLeft,
  faArrowPointer,
  faArrowUpRightFromSquare,
  faBug,
  faCheck,
  faChevronDown,
  faCircleDot,
  faClockRotateLeft,
  faCodeBranch,
  faCopy,
  faDownload,
  faEye,
  faFileLines,
  faGear,
  faGlobe,
  faPaperPlane,
  faPlug,
  faPlus,
  faRocket,
  faSpinner,
  faTrash,
  faTriangleExclamation,
  faWandMagicSparkles,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';

// Registered icon subset — the ONLY icons bundled into the extension (tree-shaken JS,
// not the webfont; CLAUDE.md "Icon component (inline SVG, tree-shaken, no
// innerHTML-of-remote)"). Add an entry here (import + map) whenever a slice needs a
// new glyph; nothing outside this file should import `@fortawesome/free-solid-svg-icons`
// directly, so the bundled set — and therefore the bundle size — has one source of truth.
const REGISTRY = {
  send: faPaperPlane,
  settings: faGear,
  mcp: faPlug,
  ship: faRocket,
  check: faCheck,
  close: faXmark,
  warning: faTriangleExclamation,
  spinner: faSpinner,
  picker: faArrowPointer,
  trash: faTrash,
  add: faPlus,
  chevronDown: faChevronDown,
  externalLink: faArrowUpRightFromSquare,
  copy: faCopy,
  eye: faEye,
  agent: faWandMagicSparkles,
  status: faCircleDot,
  download: faDownload,
  history: faClockRotateLeft,
  back: faArrowLeft,
  site: faGlobe,
  report: faFileLines,
  repo: faCodeBranch,
  bug: faBug,
} as const satisfies Record<string, IconDefinition>;

/**
 * The reusable icon-name union. Import this type wherever a component/message accepts
 * an icon name — do not redeclare a parallel union elsewhere (CLAUDE.md "document the
 * `name` union for reuse").
 */
export type IconName = keyof typeof REGISTRY;

/** All registered names, e.g. for a Storybook-less visual smoke check or a <select>. */
export const ICON_NAMES = Object.keys(REGISTRY) as IconName[];

export type IconSize = 'sm' | 'md' | 'lg';

export interface IconClassOptions {
  size?: IconSize;
  spin?: boolean;
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

function setAttributes(el: SVGElement, attributes: unknown): void {
  if (!attributes || typeof attributes !== 'object') return;
  for (const [key, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (typeof value === 'string') el.setAttribute(key, value);
  }
}

function buildNode(node: AbstractElement): SVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', node.tag);
  setAttributes(el, node.attributes);
  for (const child of node.children ?? []) {
    el.appendChild(buildNode(child));
  }
  return el;
}

/**
 * Builds an icon's markup as a real SVG DOM tree from FontAwesome's precomputed
 * abstract node data — no `innerHTML`, no HTML-string parsing, so nothing here can
 * execute injected or remote markup. The icon data is bundled at build time (svg-core,
 * tree-shaken import above); building it costs zero network requests at runtime.
 */
export function buildIconSvg(name: string): SVGElement {
  const definition = REGISTRY[resolveIconName(name)];
  const rendered = faIcon(definition);
  const [root] = rendered.abstract;
  if (!root) {
    // Unreachable for any REGISTRY entry — fontawesome-svg-core always returns one
    // root <svg> node — but keeps buildIconSvg total instead of throwing on a null-check
    // TypeScript can't otherwise prove.
    throw new Error(`icon-registry: fontawesome returned an empty abstract for "${name}"`);
  }
  return buildNode(root);
}
