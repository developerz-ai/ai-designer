import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A GUARD, not a behavioural test — "make the machine careful" (00-philosophy.md §5): a rule in a
// comment is advice the next agent can miss, a failing test is a fact it cannot.
//
// WHAT IT PROTECTS: `src/shared/messages.ts` is the shared message hub. `src/dom/bridge.ts` imports
// `BridgeRequest`/`BridgeResponse` from it at RUNTIME (it `.safeParse`s them) and
// `src/entrypoints/injected.content.ts` imports that bridge — so this module is evaluated in the
// MAIN world of EVERY FRAME OF EVERY PAGE the user visits.
//
// It used to carry `import { modelMessageSchema } from 'ai'`, consumed at module scope by
// `Conversation`'s `messages` field. Module-scope consumption makes it un-tree-shakeable, so the
// ENTIRE `ai` SDK shipped into every page's world to serve a bridge with two read-only methods —
// and on a strict-CSP site Zod's `new Function` JIT probe produced a `TrustedScript` violation per
// realm (~7 on a Google SERP). Those violations land in the very console
// `src/dom/diagnostics-collector.ts` drains for the agent's `diagnostics` tool, so the agent could
// report our own extension's noise back to the user as bugs in their page.
//
// The fix was a TYPE-ONLY import plus `z.custom<ModelMessage>()`; deep validation moved to
// `src/agent/history-store.ts`, which is service-worker-only and may legitimately hold the SDK.
// This test fails the moment someone turns it back into a value import.

const read = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../', rel), 'utf8');

/** Value imports only — `import type { … } from 'x'` and `import { type A } from 'x'` are erased at
 *  compile time and cost the page nothing. */
function valueImportsOf(source: string, moduleName: string): string[] {
  const pattern = new RegExp(`^import\\s+(?!type\\s)([^;]*?)\\s+from\\s+'${moduleName}';`, 'gm');
  const out: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const clause = (match[1] ?? '').trim();
    // `import { type X, type Y } from 'ai'` is still fully erased.
    const named = clause.match(/^\{([\s\S]*)\}$/);
    if (named) {
      const specifiers = (named[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (specifiers.length > 0 && specifiers.every((s) => s.startsWith('type '))) continue;
    }
    out.push(clause);
  }
  return out;
}

describe('the shared message hub stays off the page', () => {
  it('src/shared/messages.ts never imports the `ai` SDK as a value', () => {
    // It is reached at runtime from the MAIN world of every frame via dom/bridge.ts. A value import
    // here ships the whole SDK into every page.
    expect(valueImportsOf(read('src/shared/messages.ts'), 'ai')).toEqual([]);
  });

  it('nothing under src/shared/ imports the `ai` SDK as a value', () => {
    for (const file of ['messages.ts', 'attachments.ts', 'diagnostics.ts', 'overlay-step.ts']) {
      expect(valueImportsOf(read(`src/shared/${file}`), 'ai'), file).toEqual([]);
    }
  });

  it('the type-only import that replaced it is still type-only', () => {
    const source = read('src/shared/messages.ts');
    expect(source).toContain("import type { ModelMessage } from 'ai'");
  });

  it('the SW-only history store still runs the REAL schema — validation moved, it did not vanish', () => {
    const source = read('src/agent/history-store.ts');
    expect(source).toContain("from 'ai'");
    expect(source).toContain('modelMessageSchema.safeParse');
  });
});

describe('the guard itself detects what it claims to', () => {
  // A guard that cannot fail is worse than no guard: it reads as protection and provides none.
  it('flags a value import and ignores an erased one', () => {
    expect(valueImportsOf("import { modelMessageSchema } from 'ai';", 'ai')).toHaveLength(1);
    expect(valueImportsOf("import type { ModelMessage } from 'ai';", 'ai')).toHaveLength(0);
    expect(valueImportsOf("import { type ModelMessage } from 'ai';", 'ai')).toHaveLength(0);
    expect(valueImportsOf("import { tool, type ToolSet } from 'ai';", 'ai')).toHaveLength(1);
  });
});
