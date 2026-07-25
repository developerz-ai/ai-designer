// The design-turn tool gate (#117). Connected MCP backends contribute their namespaced tools
// to every agent turn (#21 — kb/token read tools), but write-shaped backend tools must NOT
// ride along: the only sanctioned dispatch path is the user-clicked Ship RPC
// (`runHandoffRoute` → `backend.create`), and the in-loop `handoff` tool is approval-gated
// (pinned to deny in background.ts). Offering the raw `<serverId>__task` tool to the model
// would bypass that gate entirely — the model could dispatch a task without the user ever
// clicking Ship.
//
// Filtering is by tool NAME, not MCP annotations: `readOnlyHint` and friends are untrusted
// hints the MCP spec forbids relying on for security decisions. The deny-set lives here —
// one place to grow when backends gain other write verbs. SW-only by usage, chrome-free by
// construction (pure).
import type { ToolSet } from 'ai';
import { TASK_TOOL } from './backend';
import { NAMESPACE_SEP } from './client';

/** Backend tool base names that dispatch work (write-shaped) — never offered to the design
 *  loop. `TASK_TOOL` is the Ship dispatch verb; the ship route resolves it from the UNFILTERED
 *  `toolsForShip()` merge, so gating it here cannot break Ship. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([TASK_TOOL]);

/** True when a merged-ToolSet name is a write-shaped backend tool. Suffix match
 *  (`…__task`) rather than a namespace split: a sanitized server id may itself contain `__`,
 *  so the trailing segment is the only reliable read — and over-matching (`id__my__task`)
 *  errs on the safe side (a read tool a backend chose to name `*__task` stays out). */
function isWriteTool(name: string): boolean {
  const folded = name.toLowerCase();
  for (const write of WRITE_TOOLS) {
    if (folded === write || folded.endsWith(`${NAMESPACE_SEP}${write}`)) return true;
  }
  return false;
}

/** The base name of a namespaced tool (`<serverId>__<base>` → `<base>`; the trailing segment —
 *  a sanitized server id may itself contain `__`). Unnamespaced names return as-is. */
export function toolBaseName(name: string): string {
  const at = name.lastIndexOf(NAMESPACE_SEP);
  return at === -1 ? name : name.slice(at + NAMESPACE_SEP.length);
}

// --- per-tool opt-in heuristic (#120) ----------------------------------------------------------
// `task` is not the only side-effecting tool a third-party backend can expose — but MCP
// annotations are untrusted, so the gate reads the NAME: a base name carrying a side-effect verb
// is "write-shaped" and offered to a design turn ONLY when the user granted it (`tool-grants.ts`).
// False positives cost one toggle click in the MCP panel (the grant persists); false negatives
// are the security failure mode, so the verb set errs broad — while sparing generic `set`/`run`/
// `open` (they flood read tools: `run_query`, `settings_list`, `open_issues`).

/** Side-effect verbs matched as whole words on `_`/`-`-separated base names. */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  'apply',
  'approve',
  'close',
  'comment',
  'create',
  'delete',
  'deploy',
  'drop',
  'execute',
  'grant',
  'insert',
  'merge',
  'modify',
  'patch',
  'post',
  'publish',
  'put',
  'reject',
  'remove',
  'revoke',
  'send',
  'submit',
  'trigger',
  'update',
  'write',
]);

/** True when a tool BASE name reads as side-effecting (#120) — the per-tool opt-in class.
 *  Word-split on `_`/`-`/`::` + camelCase humps, so `create_pr`, `createPr`, and `send-email`
 *  all match while `creator_stats` and `kb.search` do not. */
export function isWriteShaped(baseName: string): boolean {
  const words = baseName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camel humps
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  return words.some((w) => WRITE_VERBS.has(w.toLowerCase()));
}

/** Strip write-shaped backend tools from a namespaced MCP ToolSet before the design-turn
 *  merge. Two tiers: `WRITE_TOOLS` (the Ship dispatch verb) is hard-denied always; write-SHAPED
 *  base names (#120) are denied UNLESS granted (`granted` = this server's per-tool opt-ins from
 *  tool-grants.ts). Pure — returns a new object, never mutates the input. */
export function designSafeTools(tools: ToolSet, granted?: ReadonlySet<string>): ToolSet {
  const safe: ToolSet = {};
  for (const [name, entry] of Object.entries(tools)) {
    if (isWriteTool(name)) continue;
    const base = toolBaseName(name);
    if (isWriteShaped(base) && !granted?.has(base)) continue;
    safe[name] = entry;
  }
  return safe;
}
