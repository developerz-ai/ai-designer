import { RESOURCE_OF } from '@/agent/tools/resources';

// Build the `tool-call` stream part a model emits, in the CONSOLIDATED shape.
//
// The model-facing surface is four resources (`inspect`/`edit`/`interact`/`session`) discriminated
// on `op`, not forty-seven verbs — so a mock model that emits `toolName: 'setStyle'` is no longer
// modelling anything the real loop can receive. This maps a verb to the resource that owns it, so
// tests stay written in the vocabulary a reader recognises (`setStyle`, `waitFor`) while exercising
// the real routing.
//
// Deriving the resource from the SHIPPED `RESOURCE_OF` rather than hard-coding it is the point: if
// a verb is re-homed, these tests follow it instead of silently testing a stale grouping.

/** `intent` is REQUIRED on every `edit` op (an intentless changeset must be impossible to produce
 *  through the agent), so a test calling a mutation gets a default rather than a schema rejection
 *  it did not mean to exercise. */
const TEST_INTENT = 'Test intent';

export interface ResourceCall {
  readonly toolName: string;
  readonly input: string;
}

/**
 * The `{ toolName, input }` pair for calling `verb` with `params`. A verb no resource claims
 * (`handoff`, an MCP tool) is returned unchanged — those are still top-level tools, and a test that
 * calls one must keep working exactly as it did.
 */
export function resourceCall(verb: string, params: Record<string, unknown> = {}): ResourceCall {
  const resource = RESOURCE_OF[verb];
  if (!resource) return { toolName: verb, input: JSON.stringify(params) };
  const intent = resource === 'edit' ? { intent: TEST_INTENT } : {};
  return { toolName: resource, input: JSON.stringify({ op: verb, ...intent, ...params }) };
}

/** What the bus receives for `verb` — the params plus the `intent` an `edit` op carries through to
 *  the recorder. The shape a `dispatch` spy should be asserted against. */
export function dispatchedAs(verb: string, params: Record<string, unknown> = {}): object {
  const intent = RESOURCE_OF[verb] === 'edit' ? { intent: TEST_INTENT } : {};
  return { type: verb, ...intent, ...params };
}
