import { asSchema } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createResourceTools,
  type NamedTools,
  RESOURCE_NAMES,
  RESOURCE_OF,
} from '@/agent/tools/resources';

// The consolidation's safety net: four resources instead of forty-seven verbs, and NOT ONE
// capability lost on the way.
//
// `agent-work-limits.md`'s rule binds here — reducing the agent's WORK is always wrong, reducing the
// bytes it carries to do that work is right. So the test that matters most is the coverage one: every
// operation that was reachable before is reachable now, either as an `op` of a resource or as a
// top-level tool the grouping deliberately declined to claim.

/** A stand-in for a built per-verb tool. */
function fakeTool(inputSchema: z.ZodObject<z.ZodRawShape>, description = 'does a thing') {
  return {
    description,
    inputSchema,
    execute: vi.fn(async (input: unknown) => ({ type: 'tool-result', ok: true, data: input })),
  };
}

// Mirrors a real per-verb tool: every DOM/control input spreads `Target.shape`, so tab/frame
// addressing is part of the schema rather than an extra key Zod would strip.
const sel = z.object({
  selector: z.string(),
  tabId: z.number().int().optional(),
  frameId: z.number().int().nonnegative().optional(),
});

/** The pre-consolidation surface, in the shape `buildTools` hands over. */
function surface(): NamedTools {
  const tools: Record<string, ReturnType<typeof fakeTool>> = {};
  for (const name of Object.keys(RESOURCE_OF)) tools[name] = fakeTool(sel);
  // `pageOp` carries a nested union in the real build; its members are flattened by the resource.
  tools.pageOp = fakeTool(z.object({ op: z.unknown() }));
  // Not claimed by any resource — these must survive as top-level tools.
  tools.handoff = fakeTool(z.object({}));
  tools.invalidTool = fakeTool(z.object({}));
  tools.acme__task = fakeTool(z.object({ title: z.string() }));
  return tools as unknown as NamedTools;
}

// These read a resource through the SDK's `asSchema` rather than through Zod internals, because a
// resource's `inputSchema` is no longer a bare Zod union: a union root converts to `oneOf` with no
// `type`, which the OpenAI-compatible contract rejects outright, so it is wrapped by
// `src/agent/tools/provider-schema.ts`. Reading the CONVERTED schema is also the stronger assertion —
// it is what the provider and the tool-call path actually see, so these tests now fail if the wire
// representation stops naming an operation, which Zod introspection could never catch.

/** The JSON Schema the provider receives. Plain object, not a promise: `provider-schema.ts` keeps
 *  the conversion synchronous for a Zod source precisely so readers like this stay simple. */
function parametersOf(tool: unknown): Record<string, unknown> {
  const { inputSchema } = tool as { inputSchema: Parameters<typeof asSchema>[0] };
  return asSchema(inputSchema).jsonSchema as unknown as Record<string, unknown>;
}

/** Every `op` a resource's schema accepts, off the root `op` enum the model is shown. */
function opsOf(tool: unknown): string[] {
  const properties = parametersOf(tool).properties as
    | Record<string, { enum?: unknown[] } | undefined>
    | undefined;
  return (properties?.op?.enum ?? []).filter((v): v is string => typeof v === 'string');
}

/** Validate through the SDK schema — the same validator the tool-call path runs, so strictness is
 *  asserted where it actually applies. Awaited because `Schema.validate` is typed as thenable. */
async function parse(
  tool: unknown,
  input: unknown,
): Promise<{ success: boolean; value?: unknown }> {
  const { inputSchema } = tool as { inputSchema: Parameters<typeof asSchema>[0] };
  const result = await asSchema(inputSchema).validate?.(input);
  if (!result) throw new Error('schema exposes no validator');
  return result;
}

const call = (tool: unknown, input: unknown) =>
  (tool as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {});

describe('every pre-consolidation capability is still reachable', () => {
  const built = createResourceTools(surface());

  it('presents exactly four resources plus the unclaimed tools', () => {
    expect(Object.keys(built).sort()).toEqual(
      ['acme__task', 'edit', 'handoff', 'inspect', 'interact', 'invalidTool', 'session'].sort(),
    );
  });

  it.each(Object.entries(RESOURCE_OF))('%s is an op of `%s`', (name, resource) => {
    // `pageOp` is the one deliberate exception: its members are FLATTENED into `interact`, so the
    // wrapper name disappears while every operation it carried stays callable (asserted below).
    if (name === 'pageOp') return;
    expect(opsOf(built[resource])).toContain(name);
  });

  it('flattens the page ops in rather than nesting a second dispatcher', () => {
    const ops = opsOf(built.interact);
    // Derived layout, motion and form control — the operations `pageOp` used to hide behind itself.
    for (const op of ['box', 'overflow', 'stacking', 'visibility', 'freezeMotion']) {
      expect(ops, op).toContain(op);
    }
    expect(ops).not.toContain('pageOp');
  });

  it('lists every operation in the resource description — no discovery round-trip', () => {
    // A capability the model cannot see reads to it as impossible, and a `describe_resource` step
    // would buy a whole step on a surface this small.
    const description = String((built.inspect as { description: string }).description);
    for (const op of opsOf(built.inspect)) expect(description, op).toContain(`\`${op}\``);
  });
});

describe('the properties the rest of the system depends on', () => {
  const built = createResourceTools(surface());

  it('keeps `handoff` TOP-LEVEL — the Ship approval gate keys on that exact name', () => {
    // `loop.ts` gates Ship with `toolApproval: { handoff: … }`. Folding it into `session` would make
    // approval fire on every session call or none; "never auto-ship" is a hard rule.
    expect(built.handoff).toBeDefined();
    expect(opsOf(built.session)).not.toContain('handoff');
  });

  it('passes through the repair channel and MCP backend tools untouched', () => {
    expect(built.invalidTool).toBeDefined();
    expect(built.acme__task).toBeDefined();
  });

  it('puts the OPERATION in the input, which is what the overlay classifies on', () => {
    // `src/shared/overlay-step.ts` reads `op` off the input precisely so regrouping cannot change
    // the on-page accent. Every resource must discriminate on a literal `op`.
    for (const resource of RESOURCE_NAMES) {
      expect(opsOf(built[resource]).length, resource).toBeGreaterThan(0);
    }
  });

  it('REQUIRES `intent` on every edit op, and requires it nowhere else', async () => {
    expect((await parse(built.edit, { op: 'setStyle', selector: '.a' })).success).toBe(false);
    expect(
      (await parse(built.edit, { op: 'setStyle', selector: '.a', intent: 'Lift the CTA' })).success,
    ).toBe(true);
    expect((await parse(built.inspect, { op: 'query', selector: '.a' })).success).toBe(true);
  });
});

describe('routing', () => {
  it('routes an op to its per-verb tool with the op stripped', async () => {
    const tools = surface();
    const built = createResourceTools(tools);
    await call(built.edit, { op: 'setStyle', selector: '.hero', intent: 'Warm the hero' });
    const spy = (tools as unknown as Record<string, { execute: ReturnType<typeof vi.fn> }>).setStyle
      ?.execute;
    if (!spy) throw new Error('setStyle was not built');
    expect(spy).toHaveBeenCalledTimes(1);
    const [params] = spy.mock.calls[0] ?? [];
    expect(params).not.toHaveProperty('op');
    expect(params).toMatchObject({ selector: '.hero' });
    // `intent` rides through to the bus — the recorder folds it into the durable Edit.
    expect(params).toMatchObject({ intent: 'Warm the hero' });
  });

  it('re-nests a flattened page op onto the pageOp transport', async () => {
    const tools = surface();
    const built = createResourceTools(tools);
    await call(built.interact, { op: 'overflow', tabId: 3 });
    const spy = (tools as unknown as Record<string, { execute: ReturnType<typeof vi.fn> }>).pageOp
      ?.execute;
    if (!spy) throw new Error('pageOp was not built');
    expect(spy).toHaveBeenCalledTimes(1);
    const [params] = spy.mock.calls[0] ?? [];
    expect(params).toMatchObject({ op: { op: 'overflow' }, tabId: 3 });
  });

  it('is total — an unroutable op returns an error result, never a throw', async () => {
    const built = createResourceTools(surface());
    await expect(call(built.edit, { op: 'nonsense' })).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('the vision self-correction loop survives grouping', () => {
  it('dispatches toModelOutput by op, so a screenshot still returns an IMAGE', () => {
    // Losing this would silently end self-correction: the agent would stop being able to see its own
    // work, and nothing would throw. `toModelOutput` receives `input`, which is what makes the
    // per-op dispatch possible at all.
    const tools = surface() as unknown as Record<string, Record<string, unknown>>;
    const shot = tools.screenshot;
    if (!shot) throw new Error('screenshot was not built');
    shot.toModelOutput = () => ({
      type: 'content',
      value: [{ type: 'text', text: 'IMG' }],
    });
    const built = createResourceTools(tools as unknown as NamedTools);
    const hook = (built.inspect as unknown as { toModelOutput: (o: unknown) => unknown })
      .toModelOutput;

    expect(hook({ toolCallId: 't', input: { op: 'screenshot' }, output: {} })).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'IMG' }],
    });
    // An op with no hook keeps the SDK's default JSON view.
    expect(hook({ toolCallId: 't', input: { op: 'query' }, output: { ok: true } })).toEqual({
      type: 'json',
      value: { ok: true },
    });
  });
});

describe('a resource with no available ops is not offered at all', () => {
  it('omits the resource rather than shipping an empty one', () => {
    // Dispatches are injected per turn (no `browse` dispatch ⇒ no browse tool), so a resource can
    // legitimately end up with nothing in it.
    const built = createResourceTools({ handoff: fakeTool(z.object({})) } as unknown as NamedTools);
    expect(Object.keys(built)).toEqual(['handoff']);
  });
});

describe('the SCHEMA, not just the routing', () => {
  // The routing tests above call `execute` directly, which bypasses parsing — that is exactly how a
  // real bug hid: flattened page ops lost `tabId`/`frameId`, because `PageOp`'s members carry only
  // their own parameters and tab addressing lived on the `PageOpInput` wrapper the flattening
  // removes. Zod objects STRIP unknown keys rather than throwing, so the loss was silent: every
  // page op would have run against the turn's default tab and top frame regardless of what was
  // asked for. These parse first.
  const built = createResourceTools(surface());

  it('keeps tab/frame addressing on a flattened page op', async () => {
    const r = await parse(built.interact, { op: 'overflow', tabId: 3, frameId: 2 });
    expect(r.success).toBe(true);
    expect(r.value).toMatchObject({ tabId: 3, frameId: 2 });
  });

  it('keeps tab/frame addressing on an ordinary op', async () => {
    const r = await parse(built.inspect, { op: 'query', selector: '.a', tabId: 9 });
    expect(r.success).toBe(true);
    expect(r.value).toMatchObject({ tabId: 9 });
  });

  it('carries `intent` through on an edit op rather than stripping it', async () => {
    // It rides the bus message so the recorder can fold it into the durable Edit.
    const r = await parse(built.edit, { op: 'setStyle', selector: '.a', intent: 'Lift the CTA' });
    expect(r.success).toBe(true);
    expect(r.value).toMatchObject({ intent: 'Lift the CTA' });
  });

  it('rejects an op that belongs to a different resource', async () => {
    expect((await parse(built.inspect, { op: 'setStyle', selector: '.a' })).success).toBe(false);
    expect((await parse(built.edit, { op: 'query', selector: '.a' })).success).toBe(false);
  });
});
