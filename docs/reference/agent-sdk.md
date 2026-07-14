# Reference — Agent SDK (Vercel AI SDK 7 + OpenAI-compatible providers + MCP)

The design agent runs on the **Vercel AI SDK** (`ai` v7) in the MV3 service worker, talks to models via any **OpenAI-compatible provider** (BYOK), and mounts **MCP** backend tools (ai-dev) for handoff. This doc pins the *current* API — the SDK renamed core pieces across v4→v5→v6→v7, so old examples mislead.

Cross-refs: [docs/idea/agent.md](../idea/agent.md) (loop + tool catalog), [docs/idea/mcp.md](../idea/mcp.md) (backends + auth), [docs/idea/handoff.md](../idea/handoff.md).

## Packages

| Package | Role | Version |
|---------|------|---------|
| `ai` | Core — `streamText`, `generateText`, `tool`, `ToolLoopAgent`, `isStepCount`, `wrapLanguageModel`, `Output` | **7.x** |
| `@ai-sdk/mcp` | MCP client — `createMCPClient`, transports | 2.x |
| `@ai-sdk/openai-compatible` | Generalized OpenAI-compatible provider (default) | 1.x (peer: `ai@^7`) |
| `@openrouter/ai-sdk-provider` | OpenRouter provider (community alternative) | 3.x (peer: `ai@^7`) |
| `zod` | Tool input/output schemas | 4.x |

Why OpenAI-compatible: the provider is generalized to any `/v1` endpoint (OpenRouter, OpenAI, local llama.cpp, custom…) — one package, no vendor lock-in (see [principles.md](../idea/principles.md)). Endpoints are configured at runtime via ProviderConfig (see [agent.md](../idea/agent.md), Stack in [../../CLAUDE.md](../../CLAUDE.md)). OpenRouter is a sensible preset with automatic failover + immediate access to new models. Same pattern Tesote ai-dev's workers use.

## Provider setup (OpenAI-compatible, BYOK)

**Generalized default** — any `/v1` endpoint:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const provider = createOpenAICompatible({
  name: 'my-endpoint',
  baseURL: 'https://api.openrouter.ai/api/v1', // or OpenAI, local llama.cpp, etc.
  apiKey,                                        // from chrome.storage.local, SW only
  includeUsage: true,                            // else streamed token counts can come back 0
});

const model = provider(modelId);
```

**OpenRouter preset** (if using OpenRouter):

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

const openrouter = createOpenRouter({ apiKey });
const model = openrouter(modelId, {
  usage: { include: true },
  extraBody: {
    plugins: [{ id: 'context-compression', enabled: true }], // middle-out compress
  },
});
```

- Key lives **only** in the service worker. Never in the content script (shares the page world) — see [mv3-worlds](../architecture/mv3-worlds.md).
- `baseURL` is configured at runtime via [ProviderConfig](../idea/agent.md#settings-and-provider-selection).
- The callable form `provider(id)` is the pattern ai-dev uses in prod.

## Agent loop — our case

`ToolLoopAgent` is the v7 agent class: model + tools + a loop with stop conditions. It manages message history and looping for you.

```ts
import { ToolLoopAgent, isStepCount } from 'ai';

const agent = new ToolLoopAgent({
  model,                      // wrapped OpenRouter model
  instructions: SYSTEM,       // design-agent system prompt (v7: `instructions`, NOT `system`)
  tools: { ...domTools, ...mcpTools },
  stopWhen: isStepCount(12),  // budget ceiling; default is isStepCount(20)
  maxRetries: 5,
  toolApproval: { handoff: async () => true }, // v7: approval lives here, NOT on tool()
  onStepFinish: ({ text, toolCalls, usage }) => postToPanel({ text, toolCalls, usage }),
});

// Streaming — drive the Solid side panel
const result = agent.stream({ messages });
for await (const part of result.stream) {
  port.postMessage(part); // chrome.runtime port → side panel (NOT an HTTP Response)
}
```

- `stopWhen` replaces the old `maxSteps`. Compose: `stopWhen: [isStepCount(12), hasToolCall('handoff')]`.
- `stepCountIs` still resolves — v7 re-exports it as `isStepCount as stepCountIs` — but `isStepCount` is the canonical name. `result.fullStream` likewise still resolves and is marked `@deprecated`; use `result.stream`.
- Raw `streamText`/`generateText` accept the same options when you want explicit control flow instead of the agent class.
- **Vision self-correction**: after a mutation, feed a screenshot back as an image content part so the model sees its own result:
  ```ts
  { role: 'user', content: [{ type: 'image', image: pngBytes }, { type: 'text', text: 'Result — refine?' }] }
  ```

## DOM tools as `tool()`

Each page primitive (see [agent.md](../idea/agent.md)) is an AI SDK tool. The `execute` proxies to the content script over the message bus and returns the result to the model.

```ts
import { tool } from 'ai';
import { z } from 'zod';

const setStyle = tool({
  description: 'Apply CSS properties to elements matching a stable selector.',
  inputSchema: z.object({                       // v6+: inputSchema (NOT `parameters`)
    selector: z.string(),
    props: z.record(z.string(), z.string()),
  }),
  outputSchema: z.object({ ok: z.boolean(), computed: z.record(z.string(), z.string()) }),
  execute: async ({ selector, props }, { abortSignal }) =>
    sendToContentScript({ kind: 'setStyle', selector, props }, abortSignal),
});
```

- `handoff` and destructive structural tools are gated by the agent's **`toolApproval`** setting → the SDK pauses for the user's **Ship** click (human-in-the-loop). The agent never ships on its own (see [principles.md](../idea/principles.md)). In v7 approval is declared on the agent / `streamText` call, **not** as `needsApproval` on `tool()` — that property is deprecated.
- Static tools (no `execute`) stop the loop — useful for a terminal `proposeChangeset` step.

## MCP backend tools (ai-dev)

At handoff (and optionally for design-time read tools), open an MCP client to the configured backend and merge its tools into the agent's `ToolSet`.

```ts
import { createMCPClient } from '@ai-sdk/mcp';

const client = await createMCPClient({
  transport: {
    type: 'http',                                  // Streamable HTTP — SSE is deprecated
    url: 'https://ai-dev.miamibeachstart.com/mcp',
    headers: { Authorization: `Bearer ${token}` }, // or authProvider for OAuth/PKCE
  },
});

const mcpTools = await client.tools();             // auto-discover → AI SDK tools
// handoff: agent calls mcpTools.task with { action: 'create', spec: changeset }
// close when the turn ends: await client.close();
```

- Tool names are namespaced per backend to avoid collisions (mirrors ai-dev's `<server>_<id>__<tool>`). See [mcp.md](../idea/mcp.md).
- Pass `schemas` to `client.tools({ schemas })` for type-safe, validated MCP tools when you know the shape.

## Model / cost tiering

| Tier | Use | Example model id |
|------|-----|------------------|
| quick | chat, planning, clarifying | a cheap fast chat model |
| vision | screenshot reasoning / self-correction | a vision-capable model |
| smart | tricky restructure / ambiguous intent | a stronger model |

Pick the cheapest tier per turn; only escalate to vision when a screenshot is in play. Tiers are config, resolved at call time (ai-dev uses `quick/general/smart/planning`).

## Version gotchas — do NOT copy from older examples

| Old (v4/v5) | Current (v7) |
|-------------|--------------|
| `maxSteps: n` on generateText | `stopWhen: isStepCount(n)` |
| `parameters:` in `tool()` | `inputSchema:` |
| `maxTokens` | `maxOutputTokens` |
| `experimental_createMCPClient` from `'ai'` | `createMCPClient` from `'@ai-sdk/mcp'` |
| `Experimental_Agent` / `Agent` | `ToolLoopAgent` |
| MCP **SSE** transport | Streamable **HTTP** (`type: 'http'`) — SSE deprecated since MCP 2025-03-26 |
| `.toDataStreamResponse()` | `createUIMessageStreamResponse(...)` (HTTP only — N/A in an extension; stream via `chrome.runtime` ports) |
| stdio MCP transport | unavailable in the browser/SW — HTTP transport only |

Renamed in **v6 → v7** specifically:

| v6 | v7 |
|----|----|
| `system:` on the agent / call | `instructions:` |
| `stepCountIs(n)` | `isStepCount(n)` (old name still re-exported as an alias) |
| `result.fullStream` | `result.stream` (`fullStream` still present, `@deprecated`) |
| `needsApproval: true` on `tool()` | `toolApproval` on the agent / `streamText` call |
| `experimental_context` on a tool | `contextSchema` + typed `context` |
| `experimental_prepareStep` | `prepareStep` (the experimental alias was removed) |
| `result.toUIMessageStreamResponse()` | top-level `createUIMessageStreamResponse(...)` |

## Browser / MV3 constraints

- SDK core is **fetch-based** → runs in the service worker. No Node APIs, no `stdio`.
- Stream to the UI via a `chrome.runtime` port, not the SDK's HTTP `Response` helpers (those assume a server).
- Service worker can be killed mid-turn — persist in-flight state to `chrome.storage.session` and resume (see [mv3-worlds](../architecture/mv3-worlds.md)).
- No remote code / `eval` (MV3 CSP) — the SDK is bundled, fine.
- v7 is **ESM-only** (`require()` unsupported). `package.json` already sets `"type": "module"`, and WXT/Vite bundles ESM — nothing to do.
- v7 declares **Node 22+**. That bound applies to a Node host; the extension runs in the browser and the test suite runs under Bun. It has no effect here today, but do not assume a Node-18 CI runner would work.

## Sources

- [AI SDK 7 announcement](https://vercel.com/changelog/ai-sdk-7) · [v6 → v7 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0)
- [ToolLoopAgent reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) · [Agents: Loop Control](https://ai-sdk.dev/docs/agents/loop-control)
- [MCP tools (AI SDK Core)](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools) · [createMCPClient reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client) · [@ai-sdk/mcp on npm](https://www.npmjs.com/package/@ai-sdk/mcp)
- [OpenRouter provider](https://openrouter.ai/docs) · OpenRouter [usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting)
- Local: `tesote/ai-dev/docs/vercel-ai-sdk-v6-reference.md`, `tesote/ai-dev/worker/src/` (real prod patterns: `ToolLoopAgent`, `createOpenRouter`, `createMCPClient`)
