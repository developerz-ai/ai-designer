// MAIN-world page operations — the only things on the "let the agent run JS" list that genuinely
// cannot be done from the isolated content world, because they need the page's own JS realm:
// framework internals, page globals, and calling a page's own API.
//
// SECURITY POSTURE — read this before adding an operation.
//
//   * NO SECRETS, EVER. MAIN is the page's own world; anything here is readable by page script.
//     No key, no token, no MCP credential crosses this boundary in either direction. This module
//     also never reads any extension storage — it has no access and must never be given any.
//   * NO DYNAMIC CODE. No `eval`, no `new Function`, no `<script>`, no code strings. The agent
//     chooses an operation NAME and supplies JSON arguments; every line that runs is bundled here
//     and was reviewed. That is what makes this shippable under MV3 and under a Trusted-Types CSP,
//     and it is why `pageCall` takes a path and JSON args rather than an expression.
//   * THE PAGE IS HOSTILE. It can delete, shadow or proxy any global, define throwing getters, and
//     return cyclic or enormous objects. Every read goes through `safeValue` (bounded depth, bounded
//     size, cycle-safe, getter-throw-safe), every call is wrapped, and nothing throws out of a
//     handler — the bridge server turns a rejection into an `ok:false` reply.
//   * NO ZOD. Schema validation in this world is theatre: the page can replace the validator. The
//     authoritative validation happens on the ISOLATED side when the result comes back. Keeping
//     zod out also keeps it out of the MAIN-world bundle, which is injected into every frame of
//     every page the user visits.
//
// This file is the WRITE-capable half of a bridge previously described as read-only. `pageCall`
// invokes page code the page already shipped. That is a real widening and is called out in the PR.

/** Result envelope. Never throws; a refusal is data, so a bad op costs one tool result, not a turn. */
export type MainOpResult = { ok: true; data: unknown } | { ok: false; error: string };

const ok = (data: unknown): MainOpResult => ({ ok: true, data });
const fail = (error: string): MainOpResult => ({ ok: false, error });

const MAX_DEPTH = 4;
const MAX_CHARS = 8_000;
const MAX_KEYS = 50;
const MAX_ARRAY = 50;
const MAX_PATH_SEGMENTS = 8;

// --- safe serialization ----------------------------------------------------

/**
 * Turn an arbitrary page value into something that can cross a `postMessage` boundary and land in a
 * model transcript: bounded depth, bounded breadth, cycles broken, throwing getters swallowed,
 * functions described rather than invoked. The page controls this input completely.
 */
export function safeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string') return (value as string).slice(0, MAX_CHARS);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return `${(value as bigint).toString()}n`;
  if (type === 'undefined') return undefined;
  if (type === 'symbol') return String(value);
  if (type === 'function') {
    const name = (value as { name?: unknown }).name;
    return `[Function ${typeof name === 'string' && name ? name : 'anonymous'}]`;
  }
  const obj = value as object;
  if (seen.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Depth limit]';
  seen.add(obj);

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => safeValue(v, depth + 1, seen));
    if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY} more]`);
    return out;
  }
  // A DOM node serializes to a description, never to its tree: a single element would otherwise
  // drag its whole subtree (and its parent chain) into the transcript.
  const nodeName = (obj as { nodeName?: unknown }).nodeName;
  if (typeof nodeName === 'string') {
    const id = (obj as { id?: unknown }).id;
    return `[${nodeName.toLowerCase()}${typeof id === 'string' && id ? `#${id}` : ''}]`;
  }
  const out: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(obj).slice(0, MAX_KEYS);
  } catch {
    return '[Unreadable object]';
  }
  for (const key of keys) {
    try {
      out[key] = safeValue((obj as Record<string, unknown>)[key], depth + 1, seen);
    } catch {
      // A getter that throws is a fact about the page, not a failure of the read.
      out[key] = '[Threw on access]';
    }
  }
  return out;
}

// --- path resolution -------------------------------------------------------

// Only plain identifier segments. No brackets, no computed access, no prototype walking: `__proto__`
// / `constructor` / `prototype` are the standard route from "read a property" to "reach Function and
// build code", which is exactly the thing this module exists to avoid.
const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

// Roots refused outright. Each is either a code-execution channel, a network channel (the page world
// is the one place an exfiltration would carry the user's real cookies), a navigation channel, or a
// storage-write channel. The agent has purpose-built, reviewed tools for the legitimate versions of
// all of these — `browse` for navigation, the diagnostics collector for network, the DOM tools for
// the page. There is no design task that needs `window.fetch` from here.
const DENIED_ROOTS = new Set([
  'eval',
  'Function',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'requestIdleCallback',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'navigator',
  'location',
  'history',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'crypto',
  'open',
  'close',
  'postMessage',
  'import',
  'importScripts',
  'chrome',
  'browser',
  'trustedTypes',
]);

// Method names refused wherever they appear in a path — `document.write` and `document.execCommand`
// both inject markup, and `insertAdjacentHTML` on a page object is the same channel.
const DENIED_LEAVES = new Set([
  'write',
  'writeln',
  'execCommand',
  'insertAdjacentHTML',
  'createContextualFragment',
  'sendBeacon',
  'assign',
  'replace',
  'reload',
]);

export function pathDenyReason(path: string): string | null {
  const segments = path.split('.');
  if (segments.length > MAX_PATH_SEGMENTS) {
    return `Refused: path is more than ${MAX_PATH_SEGMENTS} segments deep.`;
  }
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) {
      return `Refused: "${segment}" is not a plain property name (no brackets, indexes or computed access).`;
    }
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return `Refused: "${segment}" walks the prototype chain, which is a route to code construction.`;
    }
  }
  const root = segments[0] ?? '';
  if (DENIED_ROOTS.has(root)) {
    return `Refused: "${root}" is a code-execution, network, navigation or storage capability; it is not reachable from a design tool.`;
  }
  const leaf = segments.at(-1) ?? '';
  if (DENIED_LEAVES.has(leaf)) {
    return `Refused: "${leaf}" injects markup or navigates; use the DOM tools instead.`;
  }
  return null;
}

/** Walk a validated path from `win`, returning `{ owner, value }` so a call can keep its receiver.
 *  Any throw (a hostile getter) is a miss, not an exception. */
function resolvePath(
  win: Window,
  path: string,
): { owner: unknown; value: unknown; missing: string | null } {
  let owner: unknown = win;
  let value: unknown = win;
  for (const segment of path.split('.')) {
    if (value === null || value === undefined) return { owner, value: undefined, missing: segment };
    owner = value;
    try {
      value = (value as Record<string, unknown>)[segment];
    } catch {
      return { owner, value: undefined, missing: segment };
    }
  }
  return { owner, value, missing: null };
}

// --- framework state -------------------------------------------------------

// The internal handles the major frameworks hang off a host element. None is public API; all are
// stable enough in practice to be worth reading, and a miss is reported honestly rather than guessed.
const REACT_FIBER = /^__reactFiber\$|^__reactInternalInstance\$/;
const REACT_PROPS = /^__reactProps\$/;

export interface FrameworkState {
  readonly framework: string | null;
  readonly props: unknown;
  readonly state: unknown;
  readonly componentName: string | null;
}

/** What the page's framework believes about this element: its props, its component name, its local
 *  state. This is the single highest-value thing the MAIN world can offer a design agent — it turns
 *  "some div" into "the `<PriceTag variant="sale">` rendered by `ProductCard`", which is a name that
 *  exists in the repo the changeset is going to be shipped against. */
export function readFrameworkState(el: Element): FrameworkState {
  const bag = el as unknown as Record<string, unknown>;
  let keys: string[] = [];
  try {
    keys = Object.keys(bag);
  } catch {
    keys = [];
  }

  const fiberKey = keys.find((k) => REACT_FIBER.test(k));
  const propsKey = keys.find((k) => REACT_PROPS.test(k));
  if (fiberKey || propsKey) {
    const fiber = fiberKey ? (bag[fiberKey] as Record<string, unknown> | undefined) : undefined;
    const type = fiber?.elementType ?? fiber?.type;
    const name =
      typeof type === 'function'
        ? ((type as { displayName?: string; name?: string }).displayName ??
          (type as { name?: string }).name ??
          null)
        : typeof type === 'string'
          ? type
          : null;
    return {
      framework: 'react',
      props: safeValue(propsKey ? bag[propsKey] : fiber?.memoizedProps),
      state: safeValue(fiber?.memoizedState),
      componentName: name,
    };
  }

  const vue = bag.__vue__ ?? bag.__vueParentComponent ?? bag._vnode;
  if (vue) {
    const inst = vue as Record<string, unknown>;
    return {
      framework: 'vue',
      props: safeValue(inst.props ?? inst.$props),
      state: safeValue(inst.setupState ?? inst.$data ?? inst.data),
      componentName:
        typeof inst.type === 'object' ? ((inst.type as { name?: string }).name ?? null) : null,
    };
  }

  const svelte = keys.find((k) => k.startsWith('__svelte'));
  if (svelte) return { framework: 'svelte', props: null, state: null, componentName: null };

  return { framework: null, props: null, state: null, componentName: null };
}

// --- the MAIN-world dispatcher ---------------------------------------------

/** The op shapes this world serves. Deliberately a plain type, not a Zod schema — see the header.
 *  The isolated side validates before sending and validates again on the way back. */
export type MainOp =
  | { op: 'frameworkState'; selector: string }
  | { op: 'pageValue'; path: string }
  | { op: 'pageCall'; path: string; args: ReadonlyArray<string | number | boolean | null> }
  | { op: 'flush' };

/** Structural guard for a message arriving over `postMessage`. The isolated world validates against
 *  the real schema; this only ensures the MAIN handler cannot be fed a shape it will trip over. */
export function isMainOp(value: unknown): value is MainOp {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.op) {
    case 'frameworkState':
      return typeof v.selector === 'string';
    case 'pageValue':
      return typeof v.path === 'string';
    case 'pageCall':
      return typeof v.path === 'string' && Array.isArray(v.args);
    case 'flush':
      return true;
    default:
      return false;
  }
}

/**
 * Run one MAIN-world operation. Never throws: a refusal, a miss and a page-thrown error are all
 * results the agent can read and act on.
 */
export function runMainOp(op: MainOp, win: Window = window): MainOpResult {
  try {
    switch (op.op) {
      case 'frameworkState': {
        const el = win.document.querySelector(op.selector);
        if (!el) return fail(`No element matches selector: ${op.selector}`);
        return ok(readFrameworkState(el));
      }
      case 'pageValue': {
        const denied = pathDenyReason(op.path);
        if (denied) return fail(denied);
        const { value, missing } = resolvePath(win, op.path);
        if (missing) return fail(`Nothing at window.${op.path} (stopped at "${missing}").`);
        return ok({ path: op.path, value: safeValue(value) });
      }
      case 'pageCall': {
        const denied = pathDenyReason(op.path);
        if (denied) return fail(denied);
        const { owner, value, missing } = resolvePath(win, op.path);
        if (missing) return fail(`Nothing at window.${op.path} (stopped at "${missing}").`);
        if (typeof value !== 'function') {
          return fail(`window.${op.path} is not a function (it is ${typeof value}).`);
        }
        // Identity check on top of the name check: a page can alias `eval` to any name it likes,
        // and the deny-list is by path. This catches the alias.
        if (isCodeConstructor(value, win)) {
          return fail('Refused: that path resolves to a code-construction function.');
        }
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(owner, [...op.args]);
        } catch (err) {
          // The PAGE threw. That is an answer, not our failure.
          return fail(`window.${op.path} threw: ${String(err)}`);
        }
        return ok({ path: op.path, result: safeValue(result) });
      }
      case 'flush': {
        // Force the page to lay out and paint whatever it has queued, so a screenshot taken next
        // shows the settled result. `offsetHeight` is a synchronous layout flush; the framework's
        // own microtasks have already run by the time this handler is reached.
        const height = win.document.documentElement.offsetHeight;
        return ok({ flushed: true, documentHeight: height });
      }
    }
  } catch (err) {
    return fail(String(err));
  }
}

// `Function`, `eval` and the async/generator function constructors, compared by identity so an
// alias (`window.myHelper = eval`) is caught even though its PATH is innocent.
function isCodeConstructor(fn: unknown, win: Window): boolean {
  const globals = win as unknown as Record<string, unknown>;
  const suspects = [globals.eval, globals.Function];
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
    suspects.push(AsyncFunction, GeneratorFunction);
  } catch {
    // Exotic realm; the two named globals above still cover the common case.
  }
  return suspects.some((s) => s === fn);
}
