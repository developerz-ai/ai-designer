// Tool schemas in the PORTABLE SUBSET — the shape every OpenAI-compatible endpoint accepts.
//
// THE PROBLEM. "OpenAI-compatible" covers the wire format, not the JSON Schema dialect. Providers
// police `function.parameters` with their own validators, and they disagree in ways that are
// mutually exclusive, so a schema tuned for one is rejected by the next:
//
//   OpenRouter  AI_APICallError: tools.function.parameters.type is required and must be "object"
//   Moonshot    tools.function.parameters is not a valid moonshot flavored json schema, details:
//               <At path 'root': when using anyOf, type should be defined in anyOf items
//                instead of the parent schema>
//
// OpenRouter demands a root `type: "object"`. Moonshot ("Moonshot Flavored JSON Schema", validated
// server-side) forbids `type` on any node that carries `anyOf`, requires an explicit `type` on every
// other node, and constrains `$ref`. Both errors are raised for the WHOLE REQUEST, not the offending
// tool, so one bad schema takes down every turn — which is what both of these did.
//
// WHY THEY DIFFER AT ALL, which is what makes this permanent rather than a bug to wait out. A tool
// schema is not merely validated — it is COMPILED. Providers implement tool calling with constrained
// decoding: the schema becomes a grammar/state machine, and at each step the tokens that would break
// it are masked to -inf. Compiling JSON Schema into that machine over a subword tokenizer is the hard
// part, and the composition keywords (`anyOf`, `oneOf`, `$ref`, absent `type`) are the expensive,
// ambiguous ones. So every provider restricts the dialect to what ITS compiler handles, and those
// restrictions are artefacts of independent engines — Moonshot's MFJS, OpenAI's strict-mode subset,
// vLLM/Outlines' grammar support. They will keep disagreeing, and no one of them is wrong.
//
// THE RULE THIS MODULE ENCODES. Do not detect the provider; emit the intersection. BYOK means the
// endpoint is the user's choice and can change between turns, so a per-provider branch would be a
// matrix we cannot test. The intersection is small and checkable, and `test/unit/tool-schema-root.
// test.ts` asserts it over every tool the loop builds:
//
//   1. The ROOT is `type: "object"` with no `anyOf`/`oneOf` on it.
//   2. No node carries both a `type` and a union — the type belongs to the union's ITEMS.
//   3. `oneOf` is never emitted; `anyOf` is the keyword tool-calling providers document.
//   4. Every non-union node states a `type`.
//   5. A `$ref` stands alone (no sibling keywords) and points at `#/$defs/`.
//
// Rule 1 is why unions get FLATTENED rather than hoisted: a discriminated union converts to a root
// `oneOf`, and no arrangement that keeps a union at the root can satisfy rules 1 and 2 at once.
//
// WHAT FLATTENING COSTS, AND WHY IT IS SAFE. A flat object cannot say "`prop` is required, but only
// when `op` is `setStyle`", so only the discriminator plus anything EVERY member requires stays in
// `required`. Two things cover the gap: the Zod union still validates every call at full strictness
// (`validate` below is the SDK's own, untouched), so a call missing an op's parameter is rejected and
// routed to the repair channel (`../tool-repair.ts`) instead of executed; and `./resources.ts` names
// each op's parameters in the tool description, so the model reads a spec rather than guessing.
// This widens what the provider is TOLD, never what we accept.
//
// Sources for the Moonshot constraints: MoonshotAI/kimi-cli#1595, MoonshotAI/kimi-code#792.

import { asSchema, jsonSchema, type Schema, zodSchema } from 'ai';
import type { z } from 'zod';

/**
 * The slice of JSON Schema this module reads or rewrites. Deliberately local and structural: the
 * SDK's `JSONSchema7` comes from `@types/json-schema`, which is not a dependency of this package
 * (only a transitive one).
 */
interface JsonSchemaNode {
  type?: unknown;
  properties?: Record<string, JsonSchemaNode | undefined>;
  required?: readonly string[];
  anyOf?: readonly JsonSchemaNode[];
  oneOf?: readonly JsonSchemaNode[];
  items?: unknown;
  additionalProperties?: unknown;
  const?: unknown;
  enum?: readonly unknown[];
  $ref?: unknown;
  $defs?: unknown;
  definitions?: unknown;
  [keyword: string]: unknown;
}

/**
 * "Any JSON value", spelled portably. Rule 4 requires a `type`, but a genuinely untyped node
 * (`z.unknown()`, `z.any()`, an MCP tool that omitted it) has no single correct one — and GUESSING
 * `string` would silently reject the objects the field was declared to accept. A union of the
 * primitive types says the true thing and satisfies rules 2 and 4 together, because each type sits
 * in an item and the parent carries none.
 */
const ANY_JSON_VALUE: JsonSchemaNode = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'object' },
    { type: 'array' },
  ],
};

/** The `type` a node's other keywords already imply, or `null` when nothing implies one. */
function inferredType(node: JsonSchemaNode): string | null {
  if (node.properties || node.additionalProperties !== undefined) return 'object';
  if (node.items !== undefined) return 'array';
  const literals = node.enum ?? (node.const !== undefined ? [node.const] : undefined);
  if (literals && literals.length > 0) {
    const kinds = new Set(literals.map((v) => (v === null ? 'null' : typeof v)));
    if (kinds.size === 1) {
      const [kind] = [...kinds];
      if (kind === 'string' || kind === 'number' || kind === 'boolean') return kind;
    }
  }
  return null;
}

/**
 * Rewrite one schema tree into the portable subset (rules 2–5 above).
 *
 * Recursive, because every rule is about ANY path — Zod emits unions inside members (a nested
 * `z.union`, a nullable field, an array's `items`), and an MCP backend's schema is arbitrary.
 */
export function sanitizeSchema(node: JsonSchemaNode): JsonSchemaNode {
  const out: JsonSchemaNode = { ...node };

  // Rule 5: a `$ref` stands alone. Providers reject sibling keywords beside it, and `#/definitions/`
  // (JSON Schema draft-07, which is what the SDK's converter emits) must become `#/$defs/`.
  if (typeof out.$ref === 'string') {
    return { $ref: out.$ref.replace('#/definitions/', '#/$defs/') };
  }
  // The pointer target has to move with the pointers.
  if (out.definitions && !out.$defs) {
    out.$defs = out.definitions;
    delete out.definitions;
  }

  // Rule 3: `oneOf` becomes `anyOf`. With mutually exclusive members exactly one can match either
  // way, so this preserves meaning while using the better-supported keyword.
  if (Array.isArray(out.oneOf)) {
    out.anyOf = [...(out.anyOf ?? []), ...out.oneOf];
    delete out.oneOf;
  }

  if (Array.isArray(out.anyOf)) {
    // Rule 2: the parent's `type` moves down into any item that does not state its own, then off the
    // parent. An item with a type keeps it — the parent's is a weaker claim about the same node.
    //
    // The injection happens BEFORE recursing, and that order is the whole correctness of it. Recurse
    // first and a typeless item hits rule 4 on the way up, becomes the any-value union, and then
    // receives the parent's `type` beside its own `anyOf` — reintroducing the exact violation this
    // function exists to remove. Injecting first also keeps the narrower claim: parent `string` over
    // an untyped item means string, not "anything".
    const parentType = out.type;
    if (parentType !== undefined) delete out.type;
    out.anyOf = out.anyOf.map((item) => {
      const needsType =
        parentType !== undefined &&
        item.type === undefined &&
        item.$ref === undefined &&
        item.anyOf === undefined &&
        item.oneOf === undefined;
      return sanitizeSchema(needsType ? { ...item, type: parentType } : item);
    });
  }

  if (out.properties) {
    const properties: Record<string, JsonSchemaNode | undefined> = {};
    for (const [name, child] of Object.entries(out.properties)) {
      properties[name] = child ? sanitizeSchema(child) : child;
    }
    out.properties = properties;
  }

  // `additionalProperties` and `items` are schema POSITIONS: a boolean there is a valid JSON Schema
  // node but not a portable one, so only object forms are recursed into. `false` is left as-is —
  // it is the one boolean every provider reads, and OpenAI's strict mode requires it.
  if (out.items && typeof out.items === 'object' && !Array.isArray(out.items)) {
    out.items = sanitizeSchema(out.items as JsonSchemaNode);
  }
  if (out.additionalProperties && typeof out.additionalProperties === 'object') {
    out.additionalProperties = sanitizeSchema(out.additionalProperties as JsonSchemaNode);
  }

  // Rule 4, last: only now is it clear whether this node ended up a union.
  if (out.type === undefined && out.anyOf === undefined) {
    const inferred = inferredType(out);
    if (inferred) out.type = inferred;
    else return { ...out, ...ANY_JSON_VALUE };
  }

  return out;
}

/** Structural identity, for de-duplicating property variants across union members. */
const fingerprint = (node: JsonSchemaNode): string => JSON.stringify(node);

/** The literal values one union member accepts for the discriminator. Zod emits a literal as
 *  `{type:'string', const:'setStyle'}`; `enum` is read too, so a member built from `z.enum([...])`
 *  rather than `z.literal(...)` still contributes its names. */
function discriminatorValues(member: JsonSchemaNode, discriminator: string): string[] {
  const field = member.properties?.[discriminator];
  if (!field) return [];
  if (typeof field.const === 'string') return [field.const];
  if (Array.isArray(field.enum))
    return field.enum.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Flatten a union-rooted schema into ONE object schema (rule 1). A root with no union on it is
 * returned untouched — this repairs a specific shape, it is not a tax every schema pays.
 */
export function flattenUnionRoot(root: JsonSchemaNode, discriminator: string): JsonSchemaNode {
  const members = root.oneOf ?? root.anyOf;
  if (!Array.isArray(members) || members.length === 0) return root;

  const ops: string[] = [];
  /** property name -> its distinct schemas across members, in first-seen order. */
  const variants = new Map<string, JsonSchemaNode[]>();
  /** property name -> how many members REQUIRE it. */
  const requiredIn = new Map<string, number>();

  for (const rawMember of members) {
    const member = sanitizeSchema(rawMember);
    ops.push(...discriminatorValues(member, discriminator));

    for (const [name, schema] of Object.entries(member.properties ?? {})) {
      if (name === discriminator || !schema) continue;
      const seen = variants.get(name) ?? [];
      if (!seen.some((v) => fingerprint(v) === fingerprint(schema))) seen.push(schema);
      variants.set(name, seen);
    }
    for (const name of member.required ?? []) {
      if (name === discriminator) continue;
      requiredIn.set(name, (requiredIn.get(name) ?? 0) + 1);
    }
  }

  const uniqueOps = [...new Set(ops)];
  if (uniqueOps.length === 0) return root;

  const properties: Record<string, JsonSchemaNode> = {
    [discriminator]: {
      type: 'string',
      enum: uniqueOps,
      description:
        'Which operation to perform. The other parameters are the chosen operation’s own — ' +
        'each operation lists the ones it takes in this tool’s description.',
    },
  };
  for (const [name, seen] of variants) {
    // One variant: use it. Several: a property-level union, types in the ITEMS (rule 2). This is the
    // collision case — two ops carrying the same property name at different types.
    properties[name] = seen.length === 1 ? (seen[0] as JsonSchemaNode) : { anyOf: seen };
  }

  const alwaysRequired = [...requiredIn]
    .filter(([, count]) => count === members.length)
    .map(([name]) => name);

  const { oneOf: _oneOf, anyOf: _anyOf, properties: _p, required: _r, ...rest } = root;
  return { ...rest, type: 'object', properties, required: [discriminator, ...alwaysRequired] };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/** Apply a rewrite to a `Schema`'s JSON half while keeping its validator, resolving the
 *  possibly-thenable `jsonSchema` without forcing every reader to await. */
function rewrite<T>(
  source: Schema<T>,
  transform: (root: JsonSchemaNode) => JsonSchemaNode,
): Schema<T> {
  const json = source.jsonSchema;
  const apply = (root: typeof json) => transform(root as JsonSchemaNode) as typeof json;
  // Kept plain for a Zod source (where it IS plain), because `.jsonSchema` is what tests and any
  // future introspection read. The thenable branch stays correct if the SDK defers conversion.
  const next = isThenable(json) ? Promise.resolve(json).then(apply) : apply(json);
  return jsonSchema<T>(next, source.validate ? { validate: source.validate } : undefined);
}

/**
 * Wrap a discriminated-union Zod schema as a tool `inputSchema` every supported provider accepts.
 * Flattens the root, then sanitizes the whole tree.
 */
export function providerSafeInputSchema<T>(schema: z.ZodType<T>, discriminator: string): Schema<T> {
  return rewrite(zodSchema<T>(schema), (root) =>
    sanitizeSchema(flattenUnionRoot(root, discriminator)),
  );
}

/**
 * Sanitize EVERY tool in a set — including ones this codebase did not author.
 *
 * MCP backend tools are the reason this exists as a set-wide pass rather than only wrapping the
 * resources: their schemas arrive from third-party servers, they are exactly where `$ref`, untyped
 * fields and nullable-as-`anyOf` show up, and one of them is enough to have the provider reject
 * every turn. Validators are preserved per tool, so nothing about what we ACCEPT changes.
 */
export function providerSafeToolSet<T extends Record<string, unknown>>(tools: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    const candidate = tool as { inputSchema?: unknown };
    if (!candidate?.inputSchema) {
      out[name] = tool;
      continue;
    }
    out[name] = {
      ...candidate,
      inputSchema: rewrite(
        asSchema(candidate.inputSchema as Parameters<typeof asSchema>[0]),
        sanitizeSchema,
      ),
    };
  }
  return out as T;
}
