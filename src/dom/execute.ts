import { attrDenyReason, type ElementMutation, type Mutator } from '@/dom/mutate';
import { a11ySnapshot, getStyles, query, queryOne } from '@/dom/read';
import type { Recorder } from '@/dom/recorder';
import { pickUnique } from '@/dom/selector';
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
    ? `setText would delete ${n} child element(s); target a leaf, or use insertNode/removeNode for structure.`
    : null;
}

export function createDomExecutor(deps: DomExecutorDeps): DomExecutor {
  const doc = deps.doc ?? document;
  const { mutator, recorder } = deps;

  // Resolve `selector` to a single element, apply the mutation, record it, and report its
  // computed result + the resilient selector the agent should keep using.
  function mutate(
    selector: string,
    apply: (el: Element) => ElementMutation,
    guard?: (el: Element) => string | null,
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
    recorder.record(stable, mutation);
    return ok(mutation.computed, stable);
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
        return mutate(tool.selector, (el) => mutator.setStyle(el, tool.props));
      case 'setText':
        return mutate(tool.selector, (el) => mutator.setText(el, tool.value), leafOnly);
      case 'setAttr': {
        // Security deny-list (on* / src / javascript:) — refuse before touching the DOM so the
        // agent gets a clean error instead of the primitive's safe-at-source throw.
        const denied = attrDenyReason(tool.name, tool.value);
        if (denied) return refused(denied);
        return mutate(tool.selector, (el) => mutator.setAttr(el, tool.name, tool.value));
      }
      case 'addClass':
        return mutate(tool.selector, (el) => mutator.addClass(el, tool.name));
      case 'removeClass':
        return mutate(tool.selector, (el) => mutator.removeClass(el, tool.name));
      case 'undo': {
        const event = recorder.undo();
        // An empty undo log is a valid no-op, not an error: undoing with nothing to revert is a
        // benign state the agent should not have to treat as a failure.
        return event ? ok(event) : ok({ undone: false });
      }
    }
  }

  return { exec };
}
