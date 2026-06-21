# Reference — Agent SDK (Vercel AI SDK 6 + OpenRouter + MCP)

The design agent runs on the **Vercel AI SDK** (`ai` v6) in the MV3 service worker, talks to models via **OpenRouter** (BYOK), and mounts **MCP** backend tools (ai-dev) for handoff. This doc pins the *current* API — the SDK renamed core pieces across v4→v5→v6, so old examples mislead.

Cross-refs: [docs/idea/agent.md](../idea/agent.md) (loop + tool catalog), [docs/idea/mcp.md](../idea/mcp.md) (backends + auth), [docs/idea/handoff.md](../idea/handoff.md).

## Packages

| Package | Role | Version |
|---------|------|---------|
| `ai` | Core — `streamText`, `generateText`, `tool`, `ToolLoopAgent`, `stepCountIs`, `wrapLanguageModel`, `Output` | **6.x** |
| `@ai-sdk/mcp` | MCP client — `createMCPClient`, transports | 6.x |
| `@openrouter/ai-sdk-provider` | OpenRouter provider (community) | latest |
| `zod` | Tool input/output schemas | 3.x |

Why OpenRouter: one key, every model, per-token pricing, automatic failover, immediate access to new models — model-agnostic by design (see [principles.md](../idea/principles.md)). It's the same provider Tesote ai-dev's workers use.

## Provider setup (OpenRouter, BYOK)

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';

const openrouter = createOpenRouter({ apiKey }); // apiKey from chrome.storage.local, SW only

const model = openrouter(modelId, {
  usage: { include: true }, // OpenRouter usage accounting — else token counts can come back 0
  extraBody: {
    plugins: [{ id: 'context-compression', enabled: true }], // middle-out compress oversized prompts
  },
});
```

- Key lives **only** in the service worker. Never in the content script (shares the page world) — see [mv3-worlds](../architecture/mv3-worlds.md).
- `openrouter(id, opts)` (callable) or `openrouter.chat(id)`. The callable form is what ai-dev uses in prod.

## Agent loop — our case

`ToolLoopAgent` is the v6 agent class: model + tools + a loop with stop conditions. It manages message history and looping for you.

```ts
import { ToolLoopAgent, stepCountIs } from 'ai';

const agent = new ToolLoopAgent({
  model,                      // wrapped OpenRouter model
  instructions: SYSTEM,       // design-agent system prompt
  tools: { ...domTools, ...mcpTools },
  stopWhen: stepCountIs(12),  // budget ceiling; default is stepCountIs(20)
  maxRetries: 5,
  onStepFinish: ({ text, toolCalls, usage }) => postToPanel({ text, toolCalls, usage }),
});

// Streaming — drive the Solid side panel
const result = agent.stream({ messages });
for await (const part of result.fullStream) {
  port.postMessage(part); // chrome.runtime port → side panel (NOT an HTTP Response)
}
```

- `stopWhen` replaces the old `maxSteps`. Compose: `stopWhen: [stepCountIs(12), hasToolCall('handoff')]`.
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
  inputSchema: z.object({                       // v6: inputSchema (NOT `parameters`)
    selector: z.string(),
    props: z.record(z.string(), z.string()),
  }),
  outputSchema: z.object({ ok: z.boolean(), computed: z.record(z.string(), z.string()) }),
  execute: async ({ selector, props }, { abortSignal }) =>
    sendToContentScript({ kind: 'setStyle', selector, props }, abortSignal),
});
```

- `handoff` and destructive structural tools set `needsApproval: true` → the SDK pauses for the user's **Ship** click (human-in-the-loop). The agent never ships on its own (see [principles.md](../idea/principles.md)).
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

| Old (v4/v5) | Current (v6) |
|-------------|--------------|
| `maxSteps: n` on generateText | `stopWhen: stepCountIs(n)` |
| `parameters:` in `tool()` | `inputSchema:` |
| `maxTokens` | `maxOutputTokens` |
| `experimental_createMCPClient` from `'ai'` | `createMCPClient` from `'@ai-sdk/mcp'` |
| `Experimental_Agent` / `Agent` | `ToolLoopAgent` |
| MCP **SSE** transport | Streamable **HTTP** (`type: 'http'`) — SSE deprecated since MCP 2025-03-26 |
| `.toDataStreamResponse()` | `.toUIMessageStreamResponse()` (HTTP only — N/A in an extension; stream via `chrome.runtime` ports) |
| stdio MCP transport | unavailable in the browser/SW — HTTP transport only |

## Browser / MV3 constraints

- SDK core is **fetch-based** → runs in the service worker. No Node APIs, no `stdio`.
- Stream to the UI via a `chrome.runtime` port, not the SDK's HTTP `Response` helpers (those assume a server).
- Service worker can be killed mid-turn — persist in-flight state to `chrome.storage.session` and resume (see [mv3-worlds](../architecture/mv3-worlds.md)).
- No remote code / `eval` (MV3 CSP) — the SDK is bundled, fine.

## Sources

- [AI SDK 6 announcement](https://vercel.com/blog/ai-sdk-6)
- [ToolLoopAgent reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) · [Agents: Loop Control](https://ai-sdk.dev/docs/agents/loop-control) · [stepCountIs](https://ai-sdk.dev/docs/reference/ai-sdk-core/step-count-is)
- [MCP tools (AI SDK Core)](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools) · [createMCPClient reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/create-mcp-client) · [@ai-sdk/mcp on npm](https://www.npmjs.com/package/@ai-sdk/mcp)
- [OpenRouter provider](https://openrouter.ai/docs) · OpenRouter [usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting)
- Local: `tesote/ai-dev/docs/vercel-ai-sdk-v6-reference.md`, `tesote/ai-dev/worker/src/` (real prod patterns: `ToolLoopAgent`, `createOpenRouter`, `createMCPClient`)
