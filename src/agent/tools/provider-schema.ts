// A tool's ROOT input schema must be a JSON Schema `object`. Discriminated unions are not.
//
// WHY THIS EXISTS. `z.discriminatedUnion(...)` converts to `{ oneOf: [...] }` with NO root `type`,
// and the OpenAI-compatible tool contract requires `function.parameters.type === "object"`.
// OpenRouter enforces it literally, so every resource tool built by `./resources.ts` was rejected
// before the model ever saw it:
//
//   AI_APICallError: tools.function.parameters.type is required and must be "object"
//
// That error is raised for the whole REQUEST, not one tool, so a single union-rooted tool took down
// every turn — the agent produced `AI_NoOutputGeneratedError` and nothing else. It is invisible to
// unit tests that only ever `safeParse` the Zod schema: the shape only becomes wrong once it is
// converted to JSON Schema and put on the wire. `test/unit/tool-schema-root.test.ts` closes that gap
// by asserting the converted root of every tool the loop builds.
//
// WHAT IT DOES. Hoists the discriminator to a real root property and keeps the members as `anyOf`:
//
//   { oneOf: [ {op:'setStyle', selector, …}, {op:'setText', …} ] }                     // rejected
//   { type:'object', properties:{op:{enum:['setStyle','setText']}}, required:['op'],
//     anyOf: [ … the same members, untouched … ] }                                     // accepted
//
// Both halves are load-bearing. The root gives the provider the `object` it demands and puts the
// operation list where even a provider that ignores `anyOf` will still show the model every `op` it
// may call. The `anyOf` keeps the PER-OP parameters precise — the alternative (flattening every op's
// parameters into one optional bag) is not sound here: distinct ops carry the same property name at
// different types (`value` is a string for `setStyle` and an object for others), so a flat bag would
// have to describe them as one, and the model would be guessing.
//
// VALIDATION IS UNCHANGED. The `validate` half comes straight from the SDK's own `zodSchema()`, so
// the Zod union still parses input exactly as strictly as before — a malformed call is caught and
// routed to the repair channel (`../tool-repair.ts`) rather than reaching `execute`. This widens
// only what the PROVIDER is told, never what we accept.

import { jsonSchema, type Schema, zodSchema } from 'ai';
import type { z } from 'zod';

/**
 * The slice of JSON Schema this module reads or rewrites. Deliberately local and structural: the
 * SDK's `JSONSchema7` comes from `@types/json-schema`, which is not a dependency of this package
 * (only a transitive one), and the four keywords below are all the rewrite touches.
 */
interface JsonSchemaNode {
  type?: unknown;
  properties?: Record<string, JsonSchemaNode | undefined>;
  required?: readonly string[];
  anyOf?: readonly JsonSchemaNode[];
  oneOf?: readonly JsonSchemaNode[];
  const?: unknown;
  enum?: readonly unknown[];
  [keyword: string]: unknown;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/** The literal values one union member accepts for the discriminator. Zod emits a literal as
 *  `{type:'string', const:'setStyle'}`; `enum` is accepted too so a member built from
 *  `z.enum([...])` rather than `z.literal(...)` still contributes its names. */
function discriminatorValues(member: JsonSchemaNode, discriminator: string): string[] {
  const field = member.properties?.[discriminator];
  if (!field) return [];
  if (typeof field.const === 'string') return [field.const];
  if (Array.isArray(field.enum))
    return field.enum.filter((v): v is string => typeof v === 'string');
  return [];
}

/**
 * Rewrite a union-rooted schema into an object-rooted one. A root that is ALREADY an object is
 * returned untouched — this is a repair for a specific malformed shape, not a transform every
 * schema pays for.
 */
function hoistDiscriminator(root: JsonSchemaNode, discriminator: string): JsonSchemaNode {
  const members = root.oneOf ?? root.anyOf;
  if (root.type === 'object' || !Array.isArray(members) || members.length === 0) return root;

  // Preserve member order; de-duplicate because two members may legitimately share an `op`.
  const ops = [...new Set(members.flatMap((member) => discriminatorValues(member, discriminator)))];
  if (ops.length === 0) return root;

  // `oneOf`/`anyOf` are dropped from the spread and re-added as `anyOf` — with mutually exclusive
  // const discriminators exactly one member can ever match, so the two are equivalent here, and
  // `anyOf` is the keyword tool-calling providers document support for.
  const { oneOf: _oneOf, anyOf: _anyOf, properties, required, ...rest } = root;

  return {
    ...rest,
    type: 'object',
    properties: {
      ...properties,
      [discriminator]: {
        type: 'string',
        enum: ops,
        description:
          'Which operation to perform. The other parameters are the chosen operation’s own — ' +
          'see the operation list in this tool’s description.',
      },
    },
    required: [...new Set([...(required ?? []), discriminator])],
    anyOf: members,
  };
}

/**
 * Wrap a discriminated-union Zod schema as a tool `inputSchema` a provider will accept.
 *
 * Returns the SDK's own conversion with only the ROOT repaired, and the SDK's own validator
 * untouched, so this stays a presentation fix and cannot loosen what the tool actually accepts.
 */
export function discriminatedUnionInputSchema<T>(
  schema: z.ZodType<T>,
  discriminator: string,
): Schema<T> {
  const converted = zodSchema<T>(schema);
  const source = converted.jsonSchema;
  const repair = (root: typeof source & JsonSchemaNode) =>
    hoistDiscriminator(root, discriminator) as typeof source;

  // `Schema.jsonSchema` is TYPED as possibly-thenable but is a plain object for a Zod source, and it
  // is kept plain here rather than uniformly wrapped in a promise: `.jsonSchema` is what tests and
  // any future introspection read, and a gratuitous `await` on every reader is a worse contract than
  // one `isThenable` check. The thenable branch stays correct if the SDK ever defers conversion.
  const rewritten = isThenable(source)
    ? Promise.resolve(source).then((root) => repair(root as typeof source & JsonSchemaNode))
    : repair(source as typeof source & JsonSchemaNode);

  return jsonSchema<T>(
    rewritten,
    converted.validate ? { validate: converted.validate } : undefined,
  );
}
