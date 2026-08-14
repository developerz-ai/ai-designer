import { detectFrameworkHints } from '@/dom/framework-hints';
import {
  attrDenyReason,
  type ElementMutation,
  type Mutator,
  type PageMutation,
  SHEET_ID,
} from '@/dom/mutate';
import { a11ySnapshot, getStyles, query, queryOne } from '@/dom/read';
import type { RecordExtras, Recorder, RecorderEmit } from '@/dom/recorder';
import { pickUnique } from '@/dom/selector';
import type { StructuralChange } from '@/shared/changeset';
import type {
  BatchResult,
  DomTool,
  InjectCssResult,
  StableSelector,
  ToolResult,
} from '@/shared/messages';

// Synchronous DOM-tool executor — the content script's dispatch core. Routes a validated DomTool
// to the reversible mutators (src/dom/mutate.ts) + readers (src/dom/read.ts), recording every
// mutation through the changeset recorder. `screenshot` and `diagnostics` are excluded here:
// `screenshot` needs an async SW capture round-trip (chrome.tabs.captureVisibleTab), and
// `diagnostics` reads the collector/scan surface (src/dom/diagnostics-collector.ts) rather than a
// selector-targeted element — both are handled directly in the entrypoint. Selector -> element
// resolution is best-effort: an unmatched selector returns an error ToolResult the model can react
// to, never a throw that would kill the turn. Pure DOM + injected deps → jsdom-testable (the
// content entrypoint stays a thin wire). See src/agent/tools/dom.ts + docs/idea/live-edit.md.

/** Every DomTool the executor resolves synchronously in the content world — everything except
 *  `screenshot` (async SW capture), `diagnostics` (collector/scan, no selector) and `pageOp`
 *  (its MAIN-world members are an async bridge round-trip — src/dom/page-ops). */
export type SyncDomTool = Exclude<
  DomTool,
  { type: 'screenshot' } | { type: 'diagnostics' } | { type: 'pageOp' }
>;

export interface DomExecutorDeps {
  mutator: Mutator;
  recorder: Recorder;
  /** The page document. Defaults to the live `document`; tests pass a jsdom one. */
  doc?: Document;
  /** Sink for content-originated events that are NOT element mutations. Today that is exactly
   *  `stylesheet-recorded` (`injectCss`): a page-level sheet has no element target, so it cannot
   *  ride the recorder's `MutationEvent` path — which requires a selector — yet it is the single
   *  most shippable thing a session produces and must reach the changeset. Optional so existing
   *  callers and tests construct an executor unchanged. */
  emit?: RecorderEmit;
}

export interface DomExecutor {
  exec(tool: SyncDomTool): ToolResult;
}

function ok(data?: unknown, selector?: StableSelector): ToolResult {
  return {
    type: 'tool-result',
    ok: true,
    ...(data !== undefined ? { data } : {}),
    ...(selector ? { selector } : {}),
  };
}

function notFound(selector: string): ToolResult {
  return { type: 'tool-result', ok: false, error: `No element matches selector: ${selector}` };
}

function refused(error: string): ToolResult {
  return { type: 'tool-result', ok: false, error };
}

// setText replaces every descendant with a single text node. Refuse a target that has element
// children: the agent almost never means to delete a whole subtree, and a leaf keeps the edit
// intent unambiguous. The primitive itself stays lossless (undo restores innerHTML) — this is the
// agent-facing guard, not a mechanism limit.
function leafOnly(el: Element): string | null {
  const n = el.children.length;
  return n > 0
    ? `setText would delete ${n} child element(s); target a leaf element (one with no child elements) instead.`
    : null;
}

// Own-chrome guard (#165 F2): the extension's own DOM is never an editable target, for ANY
// mutation — not just the structural ones. `#dz-designer-overrides` is a <style> with no element
// children, so `leafOnly` waves a `setText` on it straight through and our stylesheet becomes
// arbitrary page-wide CSS (the exact channel #165 F1 closed in the render path) AND desyncs the
// mutator: `overrides` still holds the real entries, so the next setStyle's renderSheet wipes the
// injected CSS while the recorded undo restores a stale sheet. The picker/overlay hosts are ours
// too — recorded and undoable, but invisible to the agent's selectors.
function ownChromeReason(el: Element): string | null {
  if (el.id === SHEET_ID) return `Refused: #${SHEET_ID} is the editor's own overrides sheet.`;
  if (el.closest('[data-dz-designer="picker"], [data-dz-designer="overlay"]'))
    return 'Refused: that is part of the editor’s own UI, not page content.';
  return null;
}

// Structural target guard (#58): refuse the mutations whose blast radius a user can't reasonably
// review — blanking the whole page (removing/moving <html>/<head>/<body>) or tearing down the
// extension's own chrome ({@link ownChromeReason}). `body` stays legal as an insert/move
// DESTINATION ('beforeend' a banner at page bottom is a normal design action); it is refused only
// as the element being moved/removed.
//
// WIRING NOTE for the restructuring ops (src/dom/mutate.ts `wrapNode`/`unwrapNode`/
// `replaceSubtree`, built ahead of their bus schemas): each one is a 'target' for this guard, and
// `wrapNode`'s RANGE form must guard BOTH ends — a range whose end is `<body>` absorbs the page
// just as surely as a range whose start is. The bulk form (src/dom/structural-bulk.ts) takes this
// same function as its `guard`, so the policy stays in one place rather than being re-derived.
function structuralTargetReason(el: Element, role: 'target' | 'ref'): string | null {
  const own = ownChromeReason(el);
  if (own) return own;
  if (el === el.ownerDocument.documentElement || el === el.ownerDocument.head)
    return 'Refused: structural mutations on <html>/<head> would blank or hijack the page.';
  if (role === 'target' && el === el.ownerDocument.body)
    return 'Refused: removing or moving <body> would blank the page; target a content element.';
  return null;
}

// The guard every CONTENT mutation (setStyle / setText / setAttr / add|removeClass) runs: our own
// chrome first, then the op's own check.
// A wrapper element's OWN markup — its opening tag and attributes, children stripped. The
// changeset records what the wrapper IS, not the page content that ended up inside it (which the
// rest of the record already describes); a full serialization would duplicate the whole subtree
// into the durable Edit and into every later step of the transcript.
function wrapperMarkup(html: string): string {
  const openTag = /^\s*<[^>]*>/.exec(html);
  return openTag ? openTag[0].trim() : html.slice(0, 200);
}

function contentGuard(extra?: (el: Element) => string | null) {
  return (el: Element): string | null => ownChromeReason(el) ?? extra?.(el) ?? null;
}

export function createDomExecutor(deps: DomExecutorDeps): DomExecutor {
  const doc = deps.doc ?? document;
  const { mutator, recorder } = deps;

  // Resolve `selector` to a single element, apply the mutation, record it, and report its
  // computed result + the resilient selector the agent should keep using. Every element-targeting
  // record carries the target's framework hints (#9); `structural` lets a case add the
  // StructuralChange its tool input describes (insert/move/remove).
  function mutate(
    selector: string,
    apply: (el: Element) => ElementMutation,
    guard?: (el: Element) => string | null,
    structural?: (args: {
      el: Element;
      mutation: ElementMutation;
      stable: StableSelector;
    }) => StructuralChange,
    intent?: string,
  ): ToolResult {
    const el = queryOne(doc, selector);
    if (!el) return notFound(selector);
    const reason = guard?.(el);
    if (reason) return refused(reason);
    let mutation: ElementMutation;
    try {
      mutation = apply(el);
    } catch (err) {
      // exec() never throws out of the turn (see header). A token the DOM rejects — an empty or
      // whitespace-bearing class (classList.add) or an invalid attribute name (setAttribute) — and
      // the mutator's safe-at-source deny throw all become a clean refusal the agent can react to.
      return refused(err instanceof Error ? err.message : String(err));
    }
    const stable = pickUnique(el, doc);
    recorder.record(stable, mutation, extras(el, structural?.({ el, mutation, stable }), intent));
    return ok(mutation.computed, stable);
  }

  // The RecordExtras every element-targeting record shares (#9): the target's framework hints,
  // plus the structural delta when the op has one, plus the caller's INTENT — the WHY, taken
  // straight from the tool input so the durable Edit says what the change was for instead of
  // "Auto-recorded agent edit (no recordEdit call)".
  function extras(el: Element, structural?: StructuralChange, intent?: string): RecordExtras {
    return {
      frameworkHints: detectFrameworkHints(el),
      ...(structural ? { structural } : {}),
      ...(intent ? { intent } : {}),
    };
  }

  // A batch's failure text. The model's next move is to fix the named op, so the message leads
  // with which indices failed rather than with a count it would have to cross-reference.
  function batchError(data: BatchResult): string {
    const bad = data.results
      .filter((r) => !r.ok)
      .map((r) => `#${r.index} (${r.type})`)
      .join(', ');
    return `${data.applied} of ${data.results.length} applied; failed: ${bad}. Re-check those selectors — the applied ops are already live and must not be re-sent.`;
  }

  // Resolve `selector` to a single element and project it through a pure reader.
  function read(selector: string, project: (el: Element) => unknown): ToolResult {
    const el = queryOne(doc, selector);
    if (!el) return notFound(selector);
    return ok(project(el), pickUnique(el, doc));
  }

  function exec(tool: SyncDomTool): ToolResult {
    switch (tool.type) {
      // `query` never fails: no matches is the valid `{ matches: [] }` result the model reads.
      case 'query':
        return ok(query(doc, tool.selector, { offset: tool.offset, limit: tool.limit }));
      case 'getStyles':
        return read(tool.selector, (el) => getStyles(el));
      case 'a11ySnapshot':
        return read(tool.selector, (el) => a11ySnapshot(el));
      case 'setStyle':
        return mutate(
          tool.selector,
          (el) => mutator.setStyle(el, tool.props),
          contentGuard(),
          undefined,
          tool.intent,
        );
      case 'setText':
        return mutate(
          tool.selector,
          (el) => mutator.setText(el, tool.value),
          contentGuard(leafOnly),
          undefined,
          tool.intent,
        );
      case 'setAttr': {
        // Security deny-list (on* / src / javascript:) — refuse before touching the DOM so the
        // agent gets a clean error instead of the primitive's safe-at-source throw.
        const denied = attrDenyReason(tool.name, tool.value);
        if (denied) return refused(denied);
        return mutate(
          tool.selector,
          (el) => mutator.setAttr(el, tool.name, tool.value),
          contentGuard(),
          undefined,
          tool.intent,
        );
      }
      case 'addClass':
        return mutate(
          tool.selector,
          (el) => mutator.addClass(el, tool.name),
          contentGuard(),
          undefined,
          tool.intent,
        );
      case 'removeClass':
        return mutate(
          tool.selector,
          (el) => mutator.removeClass(el, tool.name),
          contentGuard(),
          undefined,
          tool.intent,
        );
      // One round-trip, many mutations (#173). Each op goes through the SAME `exec` path it would
      // have taken alone — same guards, same deny-list, same recorder entry — so undo/redo
      // granularity is per-op and unchanged: a batch is a transport optimization, never a
      // transaction. A failing op is reported by INDEX and the rest still run, because the common
      // failure is one stale selector out of eight and aborting there would throw away seven good
      // mutations the model would then have to re-derive.
      case 'batch': {
        const results = tool.ops.map((op, index) => {
          const result = exec(op);
          return {
            index,
            type: op.type,
            ok: result.ok,
            // The op's OWN error, kept verbatim: "op #1 failed" cannot tell a selector that
            // matched nothing (worth retrying elsewhere) from a deny-list refusal (never worth
            // retrying), and those call for opposite next moves.
            ...(result.error !== undefined ? { error: result.error } : {}),
          };
        });
        const failed = results.filter((r) => !r.ok).length;
        const data: BatchResult = { applied: results.length - failed, failed, results };
        // `ok` is all-or-nothing so a partially-applied batch cannot read as success — but `data`
        // rides along either way. Returning only the summary string on failure threw away every
        // op's own error, i.e. exactly the detail the model needs to decide what to do next.
        return failed === 0
          ? ok(data)
          : { type: 'tool-result', ok: false, data, error: batchError(data) };
      }
      // Structural mutations (#58): the mutator clipboard-tracks every inserted/moved/removed
      // node, so the recorded undo restores node identity + the original parent/nextSibling
      // anchor (never an index — sibling indices shift under concurrent mutations).
      case 'insertNode':
        // The resolved selector is the insertion REFERENCE (destination) — body is legal here.
        // The structural delta's html is the mutation's `after`: the SANITIZED, serialized markup
        // actually inserted (never the raw tool input, which the sanitizer may have cut down).
        return mutate(
          tool.selector,
          (el) => mutator.insertNode(el, tool.html, tool.position),
          (el) => structuralTargetReason(el, 'ref'),
          ({ mutation, stable }) => ({
            op: 'insert',
            html: mutation.after,
            position: tool.position,
            refSelector: stable,
          }),
          tool.intent,
        );
      case 'moveNode': {
        // Two resolutions: the element to move and the reference anchor — the single-selector
        // `mutate()` helper can't express the pair, so the flow is spelled out (same
        // resolve → guard → apply → record → ok contract).
        const el = queryOne(doc, tool.selector);
        if (!el) return notFound(tool.selector);
        const elReason = structuralTargetReason(el, 'target');
        if (elReason) return refused(elReason);
        const ref = queryOne(doc, tool.refSelector);
        if (!ref) return notFound(tool.refSelector);
        const refReason = structuralTargetReason(ref, 'ref');
        if (refReason) return refused(refReason);
        try {
          const mutation = mutator.moveNode(el, ref, tool.position);
          const stable = pickUnique(el, doc);
          // The event target is the MOVED element; the structural delta's refSelector identifies
          // the anchor it moved relative to (its own stable selector, not the raw tool string).
          recorder.record(stable, mutation, {
            ...extras(el, undefined, tool.intent),
            structural: {
              op: 'move',
              refSelector: pickUnique(ref, doc),
              position: tool.position,
            },
          });
          return ok(mutation.computed, stable);
        } catch (err) {
          // e.g. moving an element into its own descendant (HierarchyRequestError) — a clean
          // refusal the agent can react to, never a throw out of the turn.
          return refused(err instanceof Error ? err.message : String(err));
        }
      }
      case 'removeNode': {
        // Selector invalidation is recorded EXPLICITLY (#58's design point): the stable selector
        // is computed BEFORE the detach — post-removal every candidate fails `resolvesToExactly`
        // and pickUnique would silently degrade to a fragile bare tag. The recorded selector
        // describes the pre-removal location (which no longer resolves, by design).
        const el = queryOne(doc, tool.selector);
        if (!el) return notFound(tool.selector);
        const reason = structuralTargetReason(el, 'target');
        if (reason) return refused(reason);
        const stable = pickUnique(el, doc);
        try {
          const mutation = mutator.removeNode(el);
          recorder.record(stable, mutation, {
            ...extras(el, undefined, tool.intent),
            structural: { op: 'remove' },
          });
          return ok(mutation.computed, stable);
        } catch (err) {
          return refused(err instanceof Error ? err.message : String(err));
        }
      }
      case 'removeAttr':
        // Not a `setAttr` with an empty value: `href=""` is a live link to the current page and
        // `alt=""` means "decorative", so emptying is a different edit from removing. The recorder
        // reuses `kind: 'setAttr'` with `attrChange.after = null` — the branch `AttrChange`
        // documented from the start and that nothing had ever produced.
        return mutate(
          tool.selector,
          (el) => mutator.removeAttr(el, tool.name),
          contentGuard(),
          undefined,
          tool.intent,
        );
      // --- restructuring (#overhaul) -----------------------------------------------------------
      // Each is its own kind because each is its own INVERSE. A `wrapNode` recorded as an
      // `insertNode` would undo by deleting the wrapper and orphaning everything it wrapped.
      case 'wrapNode': {
        // Up to two resolutions (range start + end), so the single-selector `mutate()` helper
        // can't express it. BOTH ends are guarded: a range whose END is <body> absorbs the page
        // just as surely as one whose start is.
        const el = queryOne(doc, tool.selector);
        if (!el) return notFound(tool.selector);
        const elReason = structuralTargetReason(el, 'target');
        if (elReason) return refused(elReason);
        let endEl: Element | undefined;
        if (tool.endSelector !== undefined) {
          const found = queryOne(doc, tool.endSelector);
          if (!found) return notFound(tool.endSelector);
          const endReason = structuralTargetReason(found, 'target');
          if (endReason) return refused(endReason);
          endEl = found;
        }
        // The stable selector is taken BEFORE the wrap: afterwards the element sits one level
        // deeper, so a path selector computed now describes where the agent found it, which is
        // what a reader mapping this back to source needs.
        const stable = pickUnique(el, doc);
        const endStable = endEl ? pickUnique(endEl, doc) : undefined;
        try {
          const mutation = mutator.wrapNode(el, tool.html, endEl);
          recorder.record(stable, mutation, {
            ...extras(el, undefined, tool.intent),
            structural: {
              op: 'wrap',
              // The SANITIZED wrapper as it actually landed, tag + attributes only (its children
              // are the wrapped page content, which the changeset already describes elsewhere).
              html: wrapperMarkup(mutation.after),
              ...(endStable ? { endSelector: endStable } : {}),
            },
          });
          return ok(mutation.computed, stable);
        } catch (err) {
          return refused(err instanceof Error ? err.message : String(err));
        }
      }
      case 'unwrapNode': {
        const el = queryOne(doc, tool.selector);
        if (!el) return notFound(tool.selector);
        const reason = structuralTargetReason(el, 'target');
        if (reason) return refused(reason);
        // Same rule as removeNode: the selector is computed BEFORE the wrapper leaves the tree.
        const stable = pickUnique(el, doc);
        try {
          const mutation = mutator.unwrapNode(el);
          recorder.record(stable, mutation, {
            ...extras(el, undefined, tool.intent),
            structural: { op: 'unwrap', html: wrapperMarkup(mutation.before) },
          });
          return ok(mutation.computed, stable);
        } catch (err) {
          return refused(err instanceof Error ? err.message : String(err));
        }
      }
      case 'replaceNode': {
        const el = queryOne(doc, tool.selector);
        if (!el) return notFound(tool.selector);
        const reason = structuralTargetReason(el, 'target');
        if (reason) return refused(reason);
        const stable = pickUnique(el, doc);
        try {
          const mutation = mutator.replaceSubtree(el, tool.html);
          recorder.record(stable, mutation, {
            ...extras(el, undefined, tool.intent),
            // Both halves: what it became AND what it was, so the record is a delta a reviewer can
            // reason about rather than a one-way write.
            structural: { op: 'replace', html: mutation.after, replacedHtml: mutation.before },
          });
          return ok(mutation.computed, stable);
        } catch (err) {
          return refused(err instanceof Error ? err.message : String(err));
        }
      }
      case 'injectCss': {
        // Page-level: no element target, so this does NOT go through the recorder (a
        // `MutationEvent` requires a selector). It emits `stylesheet-recorded` instead, which the
        // SW folds into `Changeset.stylesheets` — the shape a full-page overhaul actually ships.
        let mutation: PageMutation<{ bytes: number; id: string; replaced: boolean }>;
        try {
          mutation = mutator.injectCss(tool.css, tool.id);
        } catch (err) {
          // The CSS policy refusal (@import / remote url() / legacy script channels) — a message
          // the agent can act on, never a throw out of the turn.
          return refused(err instanceof Error ? err.message : String(err));
        }
        deps.emit?.({
          type: 'stylesheet-recorded',
          sheet: {
            id: mutation.computed.id,
            css: tool.css,
            ...(tool.intent ? { intent: tool.intent } : {}),
          },
        });
        const data: InjectCssResult = {
          bytes: mutation.computed.bytes,
          replaced: mutation.computed.replaced,
        };
        return ok(data);
      }
      case 'undo': {
        try {
          const event = recorder.undo();
          // An empty undo log is a valid no-op, not an error: undoing with nothing to revert is
          // a benign state the agent should not have to treat as a failure.
          return event ? ok(event) : ok({ undone: false });
        } catch (err) {
          // A failed revert (e.g. a structural anchor churned away by the page) keeps its log
          // entry (the recorder re-pushes on throw) and surfaces an honest refusal.
          return refused(err instanceof Error ? err.message : String(err));
        }
      }
      case 'discardUndo': {
        // Pop the top entry WITHOUT reverting it — the deliberate, loud escape when a permanently
        // churned anchor wedges the LIFO top (every `undo` retries the same failing entry,
        // bricking the older ones). An empty log is the same benign no-op as `undo`.
        const event = recorder.drop();
        return event ? ok({ discarded: event.kind }) : ok({ discarded: false });
      }
    }
  }

  return { exec };
}
