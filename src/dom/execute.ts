import { detectFrameworkHints } from '@/dom/framework-hints';
import { attrDenyReason, type ElementMutation, type Mutator, SHEET_ID } from '@/dom/mutate';
import { a11ySnapshot, getStyles, query, queryOne } from '@/dom/read';
import type { RecordExtras, Recorder } from '@/dom/recorder';
import { pickUnique } from '@/dom/selector';
import type { StructuralChange } from '@/shared/changeset';
import type { DomTool, StableSelector, ToolResult } from '@/shared/messages';

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
 *  `screenshot` (async SW capture) and `diagnostics` (collector/scan, no selector). */
export type SyncDomTool = Exclude<DomTool, { type: 'screenshot' } | { type: 'diagnostics' }>;

export interface DomExecutorDeps {
  mutator: Mutator;
  recorder: Recorder;
  /** The page document. Defaults to the live `document`; tests pass a jsdom one. */
  doc?: Document;
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
    recorder.record(stable, mutation, extras(el, structural?.({ el, mutation, stable })));
    return ok(mutation.computed, stable);
  }

  // The RecordExtras every element-targeting record shares (#9): the target's framework hints,
  // plus the structural delta when the op has one.
  function extras(el: Element, structural?: StructuralChange): RecordExtras {
    return {
      frameworkHints: detectFrameworkHints(el),
      ...(structural ? { structural } : {}),
    };
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
        return ok(query(doc, tool.selector));
      case 'getStyles':
        return read(tool.selector, (el) => getStyles(el));
      case 'a11ySnapshot':
        return read(tool.selector, (el) => a11ySnapshot(el));
      case 'setStyle':
        return mutate(tool.selector, (el) => mutator.setStyle(el, tool.props), contentGuard());
      case 'setText':
        return mutate(
          tool.selector,
          (el) => mutator.setText(el, tool.value),
          contentGuard(leafOnly),
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
        );
      }
      case 'addClass':
        return mutate(tool.selector, (el) => mutator.addClass(el, tool.name), contentGuard());
      case 'removeClass':
        return mutate(tool.selector, (el) => mutator.removeClass(el, tool.name), contentGuard());
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
            ...extras(el),
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
          recorder.record(stable, mutation, { ...extras(el), structural: { op: 'remove' } });
          return ok(mutation.computed, stable);
        } catch (err) {
          return refused(err instanceof Error ? err.message : String(err));
        }
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
