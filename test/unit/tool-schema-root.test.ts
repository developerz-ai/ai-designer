import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createResourceTools, type NamedTools, RESOURCE_OF } from '@/agent/tools/resources';

// THE GATE FOR A BUG CLASS THAT ONLY EXISTS ON THE WIRE.
//
// Every tool definition is re-sent on every step of every turn, and the OpenAI-compatible contract
// requires each one's `parameters` to be a JSON Schema whose root is `type: "object"`. Break that and
// the provider rejects the WHOLE REQUEST — not the offending tool — so a single bad schema takes down
// every turn:
//
//   AI_APICallError: tools.function.parameters.type is required and must be "object"
//   AI_NoOutputGeneratedError: No output generated.
//
// That shipped once (#185 gave each resource a `z.discriminatedUnion` root, which converts to a bare
// `oneOf`) and no test caught it, because every existing test asserts against the ZOD schema — where
// the shape is perfectly valid. The defect only appears after conversion to JSON Schema. So these
// tests convert, exactly as the SDK does before the request, and assert on the result.
//
// Cheaper than reproducing it: this is the difference between finding it in `bun run verify` and
// finding it by spending a real API call and reading a minified stack trace out of the service worker.

/** A stand-in for a built per-verb tool, mirroring the real shape (`Target.shape` is spread onto
 *  every DOM/control input, so tab/frame addressing is part of the schema). */
function fakeTool(inputSchema: z.ZodObject<z.ZodRawShape>) {
  return {
    description: 'does a thing',
    inputSchema,
    execute: async (input: unknown) => ({ type: 'tool-result', ok: true, data: input }),
  };
}

const sel = z.object({
  selector: z.string(),
  tabId: z.number().int().optional(),
  frameId: z.number().int().nonnegative().optional(),
});

function surface(): NamedTools {
  const tools: Record<string, ReturnType<typeof fakeTool>> = {};
  for (const name of Object.keys(RESOURCE_OF)) tools[name] = fakeTool(sel);
  tools.pageOp = fakeTool(z.object({ op: z.unknown() }));
  tools.handoff = fakeTool(z.object({ summary: z.string() }));
  tools.invalidTool = fakeTool(z.object({}));
  tools.acme__task = fakeTool(z.object({ title: z.string() }));
  return tools as unknown as NamedTools;
}

/** The JSON Schema the provider will actually receive for a tool. `asSchema` is the SDK's own
 *  normaliser — the same call `streamText` makes — so this cannot drift from what is sent. */
async function parametersOf(tool: unknown): Promise<Record<string, unknown>> {
  const { inputSchema } = tool as { inputSchema: Parameters<typeof asSchema>[0] };
  return (await asSchema(inputSchema).jsonSchema) as unknown as Record<string, unknown>;
}

describe('every tool the model is offered has a provider-valid root schema', () => {
  const built = createResourceTools(surface());

  it.each(Object.keys(built))('`%s` declares root type "object"', async (name) => {
    const parameters = await parametersOf(built[name]);
    // The literal requirement. `undefined` is the failure #185 shipped; anything else ('string',
    // an array of types) is equally rejected.
    expect(parameters.type, `${name} parameters: ${JSON.stringify(parameters).slice(0, 200)}`).toBe(
      'object',
    );
  });

  it('offers the four resources plus the unclaimed tools, so the guard covers the real surface', () => {
    // Guards the guard: if `createResourceTools` ever returned {} this file would vacuously pass.
    expect(Object.keys(built)).toEqual(
      expect.arrayContaining(['inspect', 'edit', 'interact', 'session', 'handoff', 'invalidTool']),
    );
  });
});

describe('the repaired root keeps every operation discoverable and precise', () => {
  const built = createResourceTools(surface());

  it('lists every op in a root `op` enum, reachable even by a provider that ignores anyOf', async () => {
    const parameters = await parametersOf(built.edit);
    const properties = parameters.properties as Record<string, { enum?: unknown[] }>;
    const ops = properties?.op?.enum ?? [];
    // Every `edit` verb from the allow-list must be named.
    const expected = Object.entries(RESOURCE_OF)
      .filter(([, resource]) => resource === 'edit')
      .map(([op]) => op);
    expect(ops).toEqual(expect.arrayContaining(expected));
    expect(parameters.required).toContain('op');
  });

  it('keeps the per-op parameters as anyOf members rather than flattening them away', async () => {
    // Flattening would have to merge properties that collide at different types across ops. The
    // members are what keep `setStyle`'s parameters distinguishable from `insertNode`'s.
    const parameters = await parametersOf(built.edit);
    const members = parameters.anyOf as unknown[] | undefined;
    expect(Array.isArray(members)).toBe(true);
    expect((members ?? []).length).toBeGreaterThan(1);
  });

  it('still VALIDATES as strictly as the Zod union did — the fix widens the wire, not the contract', async () => {
    // `intent` is required on every edit op; the repaired schema must not have relaxed that.
    const schema = asSchema(
      (built.edit as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema,
    );
    const missingIntent = await schema.validate?.({ op: 'setStyle', selector: '.a' });
    expect(missingIntent?.success).toBe(false);
    const withIntent = await schema.validate?.({
      op: 'setStyle',
      selector: '.a',
      intent: 'Lift the CTA',
    });
    expect(withIntent?.success).toBe(true);
  });
});
