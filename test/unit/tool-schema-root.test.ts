import { asSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDomTools } from '@/agent/tools/dom';
import { providerSafeToolSet, sanitizeSchema } from '@/agent/tools/provider-schema';
import { createResourceTools, type NamedTools, RESOURCE_OF } from '@/agent/tools/resources';

// THE PORTABILITY GATE. "OpenAI-compatible" is a wire format, not a JSON Schema dialect: each
// provider validates `function.parameters` with its own validator, and a rejection is raised for the
// WHOLE REQUEST rather than the offending tool — so one bad schema takes down every turn. Two have
// already done exactly that here, for contradictory reasons:
//
//   OpenRouter  AI_APICallError: tools.function.parameters.type is required and must be "object"
//   Moonshot    tools.function.parameters is not a valid moonshot flavored json schema, details:
//               <At path 'root': when using anyOf, type should be defined in anyOf items
//                instead of the parent schema>
//
// Neither was catchable by the existing tests, which assert against the ZOD schema — where the shape
// is perfectly valid. The defect only exists after conversion to JSON Schema, on the wire. So this
// file converts through the SDK's own `asSchema` (the same call `streamText` makes) and asserts the
// PORTABLE SUBSET over every node of every tool the loop builds.
//
// Sources for the Moonshot rules: MoonshotAI/kimi-cli#1595, MoonshotAI/kimi-code#792.

interface Node {
  type?: unknown;
  properties?: Record<string, Node | undefined>;
  // `readonly`, so a sanitized schema (whose union arrays are readonly) is assignable here without
  // a cast at every call site.
  anyOf?: readonly Node[];
  oneOf?: readonly Node[];
  items?: unknown;
  additionalProperties?: unknown;
  $ref?: unknown;
  [k: string]: unknown;
}

/** Every violation of the portable subset in a schema tree, each with the path that carries it.
 *  Returning a LIST rather than a boolean is deliberate: a failure has to say which node and why,
 *  or the next person hits the same minified provider error this file exists to prevent. */
function violations(node: Node, path = 'root'): string[] {
  const found: string[] = [];
  const union = node.anyOf ?? node.oneOf;

  // Rule 3: `oneOf` is never emitted — `anyOf` is the keyword tool-calling providers document.
  if (node.oneOf) found.push(`${path}: uses oneOf (must be anyOf)`);
  // Rule 2 — the Moonshot rule, verbatim: type belongs to the union's items, not their parent.
  if (union && node.type !== undefined) {
    found.push(`${path}: declares type "${String(node.type)}" alongside a union`);
  }
  // Rule 4: every non-union, non-$ref node states a type.
  if (!union && node.type === undefined && node.$ref === undefined) {
    found.push(`${path}: no type`);
  }
  // Rule 5: a $ref stands alone and points into #/$defs/.
  if (typeof node.$ref === 'string') {
    const siblings = Object.keys(node).filter((k) => k !== '$ref');
    if (siblings.length > 0) found.push(`${path}: $ref has siblings (${siblings.join(', ')})`);
    if (!node.$ref.startsWith('#/$defs/')) found.push(`${path}: $ref "${node.$ref}" not #/$defs/`);
  }

  for (const [i, item] of (union ?? []).entries()) {
    found.push(...violations(item, `${path}.anyOf[${i}]`));
  }
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    if (child) found.push(...violations(child, `${path}.${name}`));
  }
  if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
    found.push(...violations(node.items as Node, `${path}[]`));
  }
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    found.push(...violations(node.additionalProperties as Node, `${path}.*`));
  }
  return found;
}

function fakeTool(inputSchema: z.ZodTypeAny) {
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
  // An MCP backend tool: a third-party schema, which is where the awkward shapes come from.
  tools.acme__task = fakeTool(
    z.object({
      title: z.string(),
      // Nullable + union + untyped: the three shapes that break strict validators.
      assignee: z.string().nullable().optional(),
      payload: z.union([z.string(), z.object({ id: z.number() })]).optional(),
      meta: z.unknown().optional(),
    }),
  );
  return tools as unknown as NamedTools;
}

async function parametersOf(tool: unknown): Promise<Node> {
  const { inputSchema } = tool as { inputSchema: Parameters<typeof asSchema>[0] };
  return (await asSchema(inputSchema).jsonSchema) as unknown as Node;
}

describe('every tool the model is offered is in the portable subset', () => {
  // Exactly what the loop hands to `streamText`: grouped, then sanitized set-wide.
  const built = providerSafeToolSet(createResourceTools(surface()));

  it.each(Object.keys(built))('`%s` has no portability violations', async (name) => {
    const parameters = await parametersOf(built[name]);
    expect(violations(parameters), `${name}:\n${violations(parameters).join('\n')}`).toEqual([]);
  });

  it.each(Object.keys(built))('`%s` declares root type "object"', async (name) => {
    // OpenRouter's rule, stated separately because it is about the ROOT specifically and is what
    // makes a union-rooted schema impossible to keep.
    const parameters = await parametersOf(built[name]);
    expect(parameters.type, `${name} root: ${JSON.stringify(parameters).slice(0, 200)}`).toBe(
      'object',
    );
    expect(parameters.anyOf, `${name} must not union at the root`).toBeUndefined();
    expect(parameters.oneOf).toBeUndefined();
  });

  it('covers the real surface — four resources plus the tools grouping declined to claim', () => {
    // Guards the guard: were `createResourceTools` to return {}, everything above passes vacuously.
    expect(Object.keys(built)).toEqual(
      expect.arrayContaining([
        'inspect',
        'edit',
        'interact',
        'session',
        'handoff',
        'invalidTool',
        'acme__task',
      ]),
    );
  });
});

describe('flattening keeps every operation discoverable and precise', () => {
  const built = providerSafeToolSet(createResourceTools(surface()));

  it('lists every op of the resource in a root `op` enum', async () => {
    const parameters = await parametersOf(built.edit);
    const ops = (parameters.properties?.op as { enum?: unknown[] } | undefined)?.enum ?? [];
    const expected = Object.entries(RESOURCE_OF)
      .filter(([, resource]) => resource === 'edit')
      .map(([op]) => op);
    expect(ops).toEqual(expect.arrayContaining(expected));
  });

  it('requires the discriminator, and only what EVERY op requires besides', async () => {
    const parameters = (await parametersOf(built.edit)) as { required?: string[] };
    expect(parameters.required).toContain('op');
    // Every `edit` member here carries `selector` + `intent` as required, so both may be global.
    // Nothing OPTIONAL may be: `tabId` is optional on every op and must not become mandatory.
    expect(parameters.required).not.toContain('tabId');
    expect(parameters.required).not.toContain('frameId');
  });

  it('names each op with its required parameters in the description', async () => {
    // The flat schema cannot say "`intent` is required when `op` is `setStyle`", so the description
    // has to. Without this the model reads a property bag and guesses.
    const description = String((built.edit as { description: string }).description);
    expect(description).toMatch(/`setStyle`\([^)]*selector[^)]*\)/);
    expect(description).toMatch(/`setStyle`\([^)]*intent[^)]*\)/);
  });

  it('STILL validates as strictly as the Zod union — the fix widens the wire, not the contract', async () => {
    const schema = asSchema(
      (built.edit as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema,
    );
    expect((await schema.validate?.({ op: 'setStyle', selector: '.a' }))?.success).toBe(false);
    expect(
      (await schema.validate?.({ op: 'setStyle', selector: '.a', intent: 'Lift the CTA' }))
        ?.success,
    ).toBe(true);
    // An op from another resource is still refused.
    expect((await schema.validate?.({ op: 'query', selector: '.a' }))?.success).toBe(false);
  });

  it('merges a property that COLLIDES across ops into a union of its variants', async () => {
    // Two ops can carry the same property name at different types; a flat bag has one slot, so the
    // variants must survive as an `anyOf` rather than one of them silently winning.
    const collide = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), value: z.string() }),
      z.object({ op: z.literal('b'), value: z.object({ id: z.number() }) }),
    ]);
    const root = sanitizeSchema(
      JSON.parse(JSON.stringify(z.toJSONSchema(collide, { io: 'input' }))),
    );
    // Sanitizing alone leaves the root union; flattening is what the tool path applies. Assert the
    // collision handling through the real tool instead.
    const tools = providerSafeToolSet(
      createResourceTools({
        setStyle: fakeTool(z.object({ value: z.string() })),
        insertNode: fakeTool(z.object({ value: z.object({ id: z.number() }) })),
      } as unknown as NamedTools),
    );
    const parameters = await parametersOf(tools.edit);
    const value = parameters.properties?.value as { anyOf?: unknown[] } | undefined;
    expect(Array.isArray(value?.anyOf)).toBe(true);
    expect(value?.anyOf).toHaveLength(2);
    expect(violations(parameters)).toEqual([]);
    expect(root).toBeDefined();
  });
});

describe('the REAL tool schemas, not stand-ins', () => {
  // The fakes above pin the flattening and the set-wide pass, but they cannot catch what the actual
  // schemas contain — `z.record`, nested unions, nullable fields, the deep `PageOp` union. These are
  // the schemas that were on the wire when both providers rejected the request, so they are the ones
  // that have to be clean.
  const dispatch = async () => ({ type: 'tool-result' as const, ok: true });
  const real = providerSafeToolSet(
    createResourceTools(createDomTools(dispatch) as unknown as NamedTools),
  );

  it.each(Object.keys(real))('real `%s` has no portability violations', async (name) => {
    const parameters = await parametersOf(real[name]);
    const found = violations(parameters);
    expect(found, `${name}:\n${found.join('\n')}`).toEqual([]);
  });

  it('really did build the DOM surface, so the assertions above are not vacuous', () => {
    expect(Object.keys(real).length).toBeGreaterThan(0);
    expect(real.inspect ?? real.edit).toBeDefined();
  });
});

describe('sanitizeSchema', () => {
  it('moves a parent type into the union items — the Moonshot rule', () => {
    const out = sanitizeSchema({
      type: 'object',
      anyOf: [{ properties: { a: { type: 'string' } } }, { type: 'array' }],
    });
    expect(out.type).toBeUndefined();
    // The typeless item inherits the parent's type; the one with its own keeps it.
    expect((out.anyOf as Node[])[0]?.type).toBe('object');
    expect((out.anyOf as Node[])[1]?.type).toBe('array');
  });

  it('rewrites oneOf to anyOf', () => {
    const out = sanitizeSchema({ oneOf: [{ type: 'string' }] });
    expect(out.oneOf).toBeUndefined();
    expect(out.anyOf).toEqual([{ type: 'string' }]);
  });

  it('infers a missing type from the keywords that imply one', () => {
    expect(sanitizeSchema({ properties: { a: { type: 'string' } } }).type).toBe('object');
    expect(sanitizeSchema({ items: { type: 'string' } }).type).toBe('array');
    expect(sanitizeSchema({ enum: ['a', 'b'] }).type).toBe('string');
    expect(sanitizeSchema({ const: 7 }).type).toBe('number');
  });

  it('spells a genuinely untyped node as a union of primitives, not a guess', () => {
    // `z.unknown()` has no single correct type, and guessing `string` would reject the objects the
    // field was declared to accept.
    const out = sanitizeSchema({ description: 'anything' });
    expect(out.type).toBeUndefined();
    expect((out.anyOf as Node[]).map((i) => i.type)).toEqual([
      'string',
      'number',
      'boolean',
      'object',
      'array',
    ]);
    expect(violations(out)).toEqual([]);
  });

  it('strips the siblings of a $ref and points it at #/$defs/', () => {
    const out = sanitizeSchema({ $ref: '#/definitions/Thing', description: 'dropped' });
    expect(out).toEqual({ $ref: '#/$defs/Thing' });
  });

  it('renames a draft-07 `definitions` block so the pointers still resolve', () => {
    const out = sanitizeSchema({ type: 'object', definitions: { Thing: { type: 'string' } } });
    expect(out.definitions).toBeUndefined();
    expect(out.$defs).toEqual({ Thing: { type: 'string' } });
  });

  it('recurses into nested unions, array items and property bags', () => {
    const out = sanitizeSchema({
      type: 'object',
      properties: {
        list: { type: 'array', items: { oneOf: [{ type: 'string' }] } },
        nested: { type: 'string', anyOf: [{ description: 'no type' }] },
      },
    });
    expect(violations(out)).toEqual([]);
  });

  it('leaves an already-portable schema untouched', () => {
    const portable = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    };
    expect(sanitizeSchema(structuredClone(portable))).toEqual(portable);
  });
});
