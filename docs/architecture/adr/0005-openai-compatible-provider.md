# ADR 0005 — Generalized OpenAI-compatible provider

**Status:** accepted

## Context

Initially the agent used OpenRouter exclusively (ADR-0003), a fine provider but now we need flexibility: users might prefer OpenAI, local llama.cpp, Anthropic's Claude, or any `/v1`-compatible endpoint. Hardcoding OpenRouter locks design/implementation to one vendor.

## Decision

**Generalize to OpenAI-compatible provider** — `@ai-sdk/openai-compatible` from Vercel AI SDK, configured at runtime via ProviderConfig. User supplies baseURL + apiKey; the agent works with any endpoint that implements OpenAI's `/v1` spec. OpenRouter remains the sensible preset (auto-failover, new models first) but is no longer required.

## Consequences

- ✅ User choice: OpenAI, OpenRouter, local/self-hosted, or custom — one code path, zero reimplementation.
- ✅ No vendor lock-in. The extension is provider-agnostic by design.
- ✅ BYOK principle stays intact: keys encrypted at rest, SW-only, never in content script.
- ✅ ProviderConfig (store + settings UI) is a new shared layer for all providers.
- ➖ User must choose a provider (vs. "works out of the box with OpenRouter"). Mitigated by clear onboarding + a sensible OpenRouter default.
- ➖ baseURL validation is loose (we probe `/models`), so typos only fail at chat time — improved by Settings live validation.

## Related

- [ADR 0003](0003-openrouter-byok.md) — originally provider-specific; this generalizes it.
- [Stack in CLAUDE.md](../../../CLAUDE.md) — `@ai-sdk/openai-compatible`, runtime config.
- [`docs/reference/agent-sdk.md`](../../reference/agent-sdk.md) — provider setup examples.
