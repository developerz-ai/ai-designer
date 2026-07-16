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
 *  `toolsFor()` merge, so gating it here cannot break Ship. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([TASK_TOOL]);

/** True when a merged-ToolSet name is a write-shaped backend tool. Suffix match
 *  (`…__task`) rather than a namespace split: a sanitized server id may itself contain `__`,
 *  so the trailing segment is the only reliable read — and over-matching (`id__my__task`)
 *  errs on the safe side (a read tool a backend chose to name `*__task` stays out). */
function isWriteTool(name: string): boolean {
  for (const write of WRITE_TOOLS) {
    if (name === write || name.endsWith(`${NAMESPACE_SEP}${write}`)) return true;
  }
  return false;
}

/** Strip write-shaped backend tools from a namespaced MCP ToolSet before the design-turn
 *  merge. Pure — returns a new object, never mutates the input. */
export function designSafeTools(tools: ToolSet): ToolSet {
  const safe: ToolSet = {};
  for (const [name, entry] of Object.entries(tools)) {
    if (isWriteTool(name)) continue;
    safe[name] = entry;
  }
  return safe;
}
