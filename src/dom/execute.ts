import type { ElementMutation, Mutator } from '@/dom/mutate';
import { a11ySnapshot, getStyles, query, queryOne } from '@/dom/read';
import type { Recorder } from '@/dom/recorder';
import { pickUnique } from '@/dom/selector';
import type { DomTool, StableSelector, ToolResult } from '@/shared/messages';

// Synchronous DOM-tool executor — the content script's dispatch core. Routes a validated DomTool
// to the reversible mutators (src/dom/mutate.ts) + readers (src/dom/read.ts), recording every
// mutation through the changeset recorder. `screenshot` is excluded here: it needs an async SW
// capture round-trip (chrome.tabs.captureVisibleTab), which the entrypoint owns. Selector ->
// element resolution is best-effort: an unmatched selector returns an error ToolResult the model
// can react to, never a throw that would kill the turn. Pure DOM + injected deps → jsdom-testable
// (the content entrypoint stays a thin wire). See src/agent/tools/dom.ts + docs/idea/live-edit.md.

/** Every DomTool except `screenshot` — the calls resolvable synchronously in the content world. */
export type SyncDomTool = Exclude<DomTool, { type: 'screenshot' }>;

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

export function createDomExecutor(deps: DomExecutorDeps): DomExecutor {
  const doc = deps.doc ?? document;
  const { mutator, recorder } = deps;

  // Resolve `selector` to a single element, apply the mutation, record it, and report its
  // computed result + the resilient selector the agent should keep using.
  function mutate(selector: string, apply: (el: Element) => ElementMutation): ToolResult {
    const el = queryOne(doc, selector);
    if (!el) return notFound(selector);
    const mutation = apply(el);
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
        return mutate(tool.selector, (el) => mutator.setText(el, tool.value));
      case 'undo': {
        const event = recorder.undo();
        return event ? ok(event) : { type: 'tool-result', ok: false, error: 'Nothing to undo' };
      }
    }
  }

  return { exec };
}
