// "The work happens on the page the user is looking at" — enforced, not merely intended.
//
// THE HOLE THIS CLOSES: `background.ts` `contentDispatchFor` resolves every content-routed message
// with `message.tabId ?? defaultTabId`, and `Target.tabId` is on EVERY DomTool input — mutations
// included. Copy mode legitimately puts two tabs in play within one turn (the user's page, and a
// reference site opened in the background to copy FROM), so nothing about a second tab id looks
// wrong at the dispatch layer. The consequence: a model that passes the reference tab's id to
// `setStyle`/`batch`/`insertNode` restyles the site it was supposed to be LEARNING from, while the
// user watches their own page not change. Nothing anywhere enforced read-only on a reference tab.
//
// THE LINE IS PER-TAB, NEVER PER-FRAME. Editing inside an iframe of the active page is ordinary,
// legitimate work (payment widgets, embeds, cross-origin sections), so `frameId` is untouched here
// — every frame of the turn's tab stays writable.
//
// AND IT IS DRAWN AT *DESIGN MUTATIONS*, NOT AT EVERY SIDE EFFECT. Reads may target any tab; so may
// the page DRIVERS (`click`/`type`/`scrollTo`/…), because reaching content on a reference site is
// exactly how copy mode reads it — the system prompt tells the model to do that. Drivers change no
// design and are never recorded as edits. What is refused is the set that mutates the page's
// appearance and lands in the changeset: those must only ever hit the tab the turn owns, because a
// changeset is shipped as a diff against the user's page and an edit recorded against some other
// origin is not merely useless, it is wrong.
//
// Pure + chrome-free + no `any`, so the policy is unit-testable in isolation and the SW keeps one
// source of truth for it (same reasoning as `capture-policy.ts`, which this deliberately mirrors).

import type {
  CheckResponsiveInput,
  ControlTool,
  DescribeCmd,
  DomTool,
  PageOpInput,
} from '@/shared/messages';

/** Every message the SW routes to a content script — the exact `ContentDispatch` input union. */
export type ContentRoutedMessage = DomTool | ControlTool | DescribeCmd | CheckResponsiveInput;
type ContentRoutedType = ContentRoutedMessage['type'];

/** `true` = CHANGES THE DESIGN of a page (pinned to the turn's tab); `false` = read / driver /
 *  capture (any tab). An exhaustive `Record` over the content-routed union, so a new message type
 *  is a COMPILE ERROR until someone decides which side it is on — a mutation that silently
 *  defaults to "allowed anywhere" is exactly the failure this module exists to prevent. (The old
 *  hand-kept literal set missed seven mutators: removeAttr, the structural four, bulkStructural,
 *  injectCss.) `pageOp` is decided per sub-op below. */
const MUTATES_DESIGN: Readonly<Record<ContentRoutedType, boolean>> = {
  // DomTool — mutations
  setStyle: true,
  setText: true,
  setAttr: true,
  removeAttr: true,
  addClass: true,
  removeClass: true,
  batch: true,
  insertNode: true,
  moveNode: true,
  removeNode: true,
  wrapNode: true,
  unwrapNode: true,
  replaceNode: true,
  bulkStructural: true,
  injectCss: true,
  undo: true,
  discardUndo: true,
  // `pageOp` is a dispatcher: its verdict depends on the op (see PAGE_OP_MUTATES_DESIGN).
  pageOp: false,
  // DomTool — reads
  query: false,
  getStyles: false,
  screenshot: false,
  a11ySnapshot: false,
  diagnostics: false,
  // ControlTool — drivers + reads (copy mode reaches reference content by driving it)
  click: false,
  type: false,
  pressKey: false,
  hover: false,
  scrollTo: false,
  selectOption: false,
  waitFor: false,
  handleDialog: false,
  readImages: false,
  readChart: false,
  chartTooltip: false,
  widgetAct: false,
  pageFacts: false,
  // DescribeCmd + responsive scan — reads
  describe: false,
  extractIdentity: false,
  readImageContent: false,
  checkResponsive: false,
};

/** Per-op verdict for `pageOp`, exhaustive for the same reason. Only `pageCall` is pinned: it
 *  invokes an arbitrary page-owned function (`myChart.update`, `theme.set`) and so can restyle the
 *  page in ways nothing can bound. The rest are reads, or drivers in the `click`/`type` sense —
 *  `setField` (a form write, like `type`), `media`, and `freezeMotion` (reversible; it is how a
 *  reference site is made screenshot-deterministic) — none of which lands in the changeset. */
const PAGE_OP_MUTATES_DESIGN: Readonly<Record<PageOpInput['op']['op'], boolean>> = {
  pageCall: true,
  box: false,
  overflow: false,
  scrollContainer: false,
  stacking: false,
  visibility: false,
  animations: false,
  freezeMotion: false,
  media: false,
  formState: false,
  setField: false,
  storageKeys: false,
  frameworkState: false,
  pageValue: false,
  flush: false,
  designSystem: false,
};

/** The message types that always mutate the design — derived from the exhaustive table. */
export const DESIGN_MUTATIONS: ReadonlySet<ContentRoutedType> = new Set(
  (Object.keys(MUTATES_DESIGN) as ContentRoutedType[]).filter((type) => MUTATES_DESIGN[type]),
);

/** Whether one content-routed message mutates the design (and so is pinned to the turn's tab).
 *  Everything else — every read, every driver, every capture — may address any tab. */
export function isDesignMutation(message: ContentRoutedMessage): boolean {
  if (message.type === 'pageOp') return PAGE_OP_MUTATES_DESIGN[message.op.op];
  return MUTATES_DESIGN[message.type];
}

/**
 * Why this message may not run, or `null` when it may. A design mutation aimed at a tab other than
 * the one the turn resolved at start is refused; everything else passes.
 *
 * The refusal is phrased as an INSTRUCTION the model can act on, in the same register as
 * `capture-target.ts`'s screenshot refusal (which likewise refuses rather than silently
 * auto-retargeting): it names the two tabs, says which one is the subject, and tells the model what
 * to do instead. A bare "not allowed" would send it retrying the same call with the same id.
 */
export function mutationBlockedReason(
  message: ContentRoutedMessage,
  turnTabId: number,
): string | null {
  const messageTabId = message.tabId;
  if (messageTabId === undefined || messageTabId === turnTabId) return null;
  if (!isDesignMutation(message)) return null;
  const type = message.type === 'pageOp' ? `pageOp(${message.op.op})` : message.type;
  return (
    `\`${type}\` was aimed at tab ${messageTabId}, but this turn is designing tab ${turnTabId} — ` +
    'the page the user is looking at. Edits only ever apply to that tab, because the changeset ' +
    'they produce is shipped as a diff against it. Another tab is read-only: you may inspect it, ' +
    'screenshot it and drive it to reach content, but not restyle it. Re-send this without ' +
    '`tabId` (which defaults to the tab being designed), or apply the change there instead.'
  );
}
