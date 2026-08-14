import { z } from 'zod';
import { readDesignSystem } from '@/dom/page-ops/design-system';
import { readFormState, setField } from '@/dom/page-ops/forms';
import {
  boxOf,
  overflowOf,
  scrollContainerOf,
  stackingOf,
  visibilityOf,
} from '@/dom/page-ops/geometry';
import { controlMedia, freezeMotion, listAnimations } from '@/dom/page-ops/motion';
import { queryOne } from '@/dom/read';
import { pickUnique } from '@/dom/selector';
import type { ToolResult } from '@/shared/messages';
import type { PageOp } from '@/shared/page-ops';
import { MAIN_WORLD_OPS } from '@/shared/page-ops';

// The `pageOp` dispatcher — one entry point for the whole page-operations library.
//
// This is the answer to "let the agent execute JS on the page". It executes no JS the agent wrote:
// every operation is bundled, reviewed code, and the agent picks a name and passes parameters. No
// `eval`, no `new Function`, no `<script>`, nothing a Trusted-Types page can block.
//
// ONE dispatcher rather than fifteen tools: the tool surface is re-sent on every model step, so
// composition belongs in parameters, not in more tools
// (../gold-standards-in-ai/docs/ai-agents/tools-and-mcp.md). Adding an operation costs one union
// member in schema.ts and one `case` here.
//
// Isolated-world ops are answered here. MAIN-world ops (`frameworkState`, `pageValue`, `pageCall`,
// `flush`) need the page's own JS realm and are answered by src/dom/page-main-ops.ts over the
// bridge; this module routes them and never runs them itself.

/**
 * The reply envelope a MAIN-world op returns (`MainOpResult` in src/dom/page-main-ops.ts), validated
 * HERE — on the isolated side, on the way back.
 *
 * This is the authoritative check and the only one. The MAIN world is the page's own realm: it can
 * replace any validator we put there, so schema enforcement in that world is theatre (which is also
 * why `page-main-ops.ts` carries no zod, and why the MAIN-world bundle stays free of it). A reply
 * that does not match this shape is treated as a malformed answer from an untrusted party, never as
 * data.
 */
export const MainOpReply = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string().max(2000) }),
]);
export type MainOpReply = z.infer<typeof MainOpReply>;

export interface PageOpsDeps {
  readonly doc?: Document;
  readonly win?: Window;
  /** Round-trips a MAIN-world op through the bridge (src/dom/bridge.ts). Injected so this module
   *  stays synchronous-testable and so the content entrypoint owns the transport. Omit and a
   *  MAIN-world op reports honestly that the bridge is unavailable. */
  readonly main?: (op: PageOp) => Promise<ToolResult>;
}

export interface PageOps {
  run(op: PageOp): Promise<ToolResult>;
}

function ok(data: unknown): ToolResult {
  return { type: 'tool-result', ok: true, data };
}

function fail(error: string): ToolResult {
  return { type: 'tool-result', ok: false, error };
}

export function createPageOps(deps: PageOpsDeps = {}): PageOps {
  const doc = deps.doc ?? document;
  const win = deps.win ?? doc.defaultView ?? window;

  // Every geometry answer names other elements (the clipping ancestor, the occluder). They are
  // named through the same selector engine the changeset uses, so a name in a diagnosis is a name
  // the agent can turn round and mutate.
  const describe = (el: Element): string => pickUnique(el, doc).value;

  const resolve = (selector: string): Element | null => queryOne(doc, selector);

  async function run(op: PageOp): Promise<ToolResult> {
    if (MAIN_WORLD_OPS.has(op.op)) {
      if (!deps.main) {
        return fail(
          `"${op.op}" needs the page's own JS world and the MAIN-world bridge is not available in this frame.`,
        );
      }
      return deps.main(op);
    }

    switch (op.op) {
      case 'box': {
        const el = resolve(op.selector);
        return el ? ok(boxOf(el, win)) : notFound(op.selector);
      }
      case 'overflow': {
        // No selector = audit the document. Horizontal overflow on <body> is the single most
        // common responsive defect and no per-element read finds it.
        const el = op.selector ? resolve(op.selector) : doc.documentElement;
        if (!el) return notFound(op.selector ?? 'documentElement');
        return ok(overflowOf(el, win, describe));
      }
      case 'scrollContainer': {
        const el = resolve(op.selector);
        return el ? ok(scrollContainerOf(el, win, describe)) : notFound(op.selector);
      }
      case 'stacking': {
        const el = resolve(op.selector);
        return el ? ok(stackingOf(el, win, describe)) : notFound(op.selector);
      }
      case 'visibility': {
        const el = resolve(op.selector);
        return el ? ok(visibilityOf(el, win, describe)) : notFound(op.selector);
      }
      case 'animations': {
        const root = op.selector ? resolve(op.selector) : doc;
        if (!root) return notFound(op.selector ?? 'document');
        return ok({ animations: listAnimations(root) });
      }
      case 'freezeMotion':
        return ok(freezeMotion(doc, op.frozen));
      case 'media': {
        const el = resolve(op.selector);
        if (!el) return notFound(op.selector);
        const result = controlMedia(el, op.action, op.time);
        return result ? ok(result) : fail(`${op.selector} is not a <video> or <audio> element.`);
      }
      case 'formState': {
        const root = op.selector ? resolve(op.selector) : doc;
        if (!root) return notFound(op.selector ?? 'document');
        return ok({ fields: readFormState(root) });
      }
      case 'setField': {
        const el = resolve(op.selector);
        if (!el) return notFound(op.selector);
        if (op.value === undefined && op.checked === undefined) {
          return fail('setField needs `value` or `checked`.');
        }
        const result = setField(el, { value: op.value, checked: op.checked });
        return result ? ok(result) : fail(`${op.selector} is not a form field.`);
      }
      case 'storageKeys':
        return ok(storageKeys(win, op.area));
      case 'designSystem':
        return ok(readDesignSystem(doc));
      default:
        // Exhaustive over the isolated-world ops; a MAIN-world op returned above.
        return fail(`Unknown page operation: ${(op as { op: string }).op}`);
    }
  }

  return { run };
}

function notFound(selector: string): ToolResult {
  return fail(`No element matches selector: ${selector}`);
}

// Key NAMES and byte sizes only — never values. Web storage is where sites keep session tokens, and
// a values read would put a credential into the model transcript, which is then re-sent to the
// provider on every later step of the turn. The names answer the question this exists for ("does
// this app keep its cart / auth / feature flags client-side?") without carrying the payload.
function storageKeys(win: Window, area: 'local' | 'session'): unknown {
  let store: Storage | null = null;
  try {
    store = area === 'local' ? win.localStorage : win.sessionStorage;
  } catch {
    // Third-party-cookie blocking and file:// origins both make web storage throw on access.
    return { area, available: false, keys: [] };
  }
  if (!store) return { area, available: false, keys: [] };
  const keys: Array<{ key: string; bytes: number }> = [];
  try {
    for (let i = 0; i < store.length && keys.length < 100; i += 1) {
      const key = store.key(i);
      if (key === null) continue;
      keys.push({ key, bytes: (store.getItem(key) ?? '').length });
    }
  } catch {
    return { area, available: false, keys };
  }
  return { area, available: true, keys };
}
