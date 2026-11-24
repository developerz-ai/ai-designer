// Send THIS BUILD's real tool schemas to a list of OpenAI-compatible endpoints and report which
// accept them. Local-only diagnostics — not part of the extension, not imported by it.
//
// WHY A SCRIPT AND NOT A TEST. `test/unit/tool-schema-root.test.ts` asserts the portable subset we
// BELIEVE providers require. This asks the providers. The unit test is the gate (offline, free, runs
// in CI); this is how the subset gets validated against reality when a new endpoint is added or a
// provider changes its validator — the failure mode it exists for is "our rule was wrong", which no
// amount of self-consistent testing can catch.
//
// Cost: one request per endpoint, `max_tokens: 1`, one-word prompt. Schema validation happens before
// generation, so a rejection costs nothing at all and an acceptance costs a rounding error.
//
// Keys come from the environment and are never written anywhere. Usage:
//
//   DZ_PROBE_ENDPOINTS='[{"label":"moonshot","baseURL":"https://api.moonshot.ai/v1",
//                         "model":"kimi-k2-0905-preview","apiKey":"…"}]' \
//     bun scripts/probe-tool-schemas.ts

import { asSchema } from 'ai';
import { createDomTools } from '../src/agent/tools/dom';
import { providerSafeToolSet } from '../src/agent/tools/provider-schema';
import { createResourceTools, type NamedTools } from '../src/agent/tools/resources';

interface Endpoint {
  label: string;
  baseURL: string;
  model: string;
  apiKey: string;
}

/** The exact `tools` array the agent puts on the wire, built from the real builders. */
async function toolsPayload(): Promise<unknown[]> {
  // The dispatch is never called — only the SCHEMAS are read.
  const dispatch = async () => ({ type: 'tool-result' as const, ok: true });
  const built = providerSafeToolSet(
    createResourceTools(createDomTools(dispatch) as unknown as NamedTools),
  );

  const out: unknown[] = [];
  for (const [name, tool] of Object.entries(built)) {
    const { inputSchema, description } = tool as {
      inputSchema: Parameters<typeof asSchema>[0];
      description?: string;
    };
    out.push({
      type: 'function',
      function: {
        name,
        description: description ?? '',
        parameters: await asSchema(inputSchema).jsonSchema,
      },
    });
  }
  return out;
}

async function probe(endpoint: Endpoint, tools: unknown[]): Promise<void> {
  const url = `${endpoint.baseURL.replace(/\/$/, '')}/chat/completions`;
  let status = 0;
  let body = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify({
        model: endpoint.model,
        messages: [{ role: 'user', content: 'hi' }],
        tools,
        max_tokens: 1,
      }),
    });
    status = res.status;
    body = await res.text();
  } catch (err) {
    console.log(`\n✗ ${endpoint.label} — network error: ${String(err)}`);
    return;
  }

  if (status === 200) {
    console.log(
      `\n✓ ${endpoint.label} (${endpoint.model}) — ${tools.length} tool schemas ACCEPTED`,
    );
    return;
  }
  reportFailure(endpoint, status, body);
}

/**
 * Acceptance is not usability. The schemas are FLATTENED (one object with an `op` enum) precisely
 * because no union-rooted shape is portable — so the question this answers is whether a model can
 * still drive that shape: does it pick the right resource, and does it put a real `op` in the
 * arguments? A provider that accepts the schema and then cannot call it would be a silent
 * regression, invisible to both the unit gate and the acceptance probe above.
 */
async function probeCall(endpoint: Endpoint, tools: unknown[]): Promise<void> {
  const url = `${endpoint.baseURL.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [
        {
          role: 'user',
          content:
            'Look at the element `.hero` on the page and tell me its styles. Use your tools.',
        },
      ],
      tools,
      tool_choice: 'auto',
      max_tokens: 512,
    }),
  });
  const body = await res.text();
  if (res.status !== 200) {
    reportFailure(endpoint, res.status, body);
    return;
  }

  const parsed = JSON.parse(body) as {
    choices?: {
      message?: { tool_calls?: { function?: { name?: string; arguments?: string } }[] };
    }[];
  };
  const calls = parsed.choices?.[0]?.message?.tool_calls ?? [];
  if (calls.length === 0) {
    console.log(`  ! ${endpoint.label} — accepted the tools but called none (model choice)`);
    return;
  }
  for (const call of calls) {
    const name = call.function?.name ?? '(unnamed)';
    let op = '(none)';
    try {
      op = String(
        (JSON.parse(call.function?.arguments ?? '{}') as { op?: unknown }).op ?? '(none)',
      );
    } catch {
      op = '(unparseable arguments)';
    }
    const ok = op !== '(none)' && op !== '(unparseable arguments)';
    console.log(`  ${ok ? '✓' : '✗'} ${endpoint.label} — called \`${name}\` with op=\`${op}\``);
  }
}

function reportFailure(endpoint: Endpoint, status: number, body: string): void {
  // A schema rejection and an auth/quota failure look nothing alike, and conflating them would make
  // this script lie in the most expensive direction ("provider rejects our schemas" when the key was
  // simply wrong). So the body is printed verbatim and classified only loosely.
  const lower = body.toLowerCase();
  const schemaish =
    lower.includes('schema') || lower.includes('parameters') || lower.includes('tools');
  const label = schemaish ? 'SCHEMA REJECTED' : 'failed (not schema-related)';
  console.log(`\n✗ ${endpoint.label} (${endpoint.model}) — HTTP ${status} — ${label}`);
  console.log(`   ${body.slice(0, 600).replace(/\s+/g, ' ')}`);
}

const raw = process.env.DZ_PROBE_ENDPOINTS;
if (!raw) {
  console.error('DZ_PROBE_ENDPOINTS is required (JSON array of {label,baseURL,model,apiKey}).');
  process.exit(1);
}

const endpoints = JSON.parse(raw) as Endpoint[];
const tools = await toolsPayload();
console.log(`Probing ${endpoints.length} endpoint(s) with ${tools.length} real tool schemas.`);
// Sequential: the output is a report a human reads, and interleaved failures are harder to attribute
// than a run that takes a few extra seconds.
const callToo = process.argv.includes('--call');
for (const endpoint of endpoints) {
  await probe(endpoint, tools);
  // Only worth asking whether the model can CALL the schema once the provider has accepted it.
  if (callToo) await probeCall(endpoint, tools);
}
