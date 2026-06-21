# ADR 0003 — OpenRouter + BYOK inference

**Status:** accepted

## Context

The design agent needs strong vision-capable models, cost control, and no vendor lock-in. We don't want to operate a billing relationship or resell tokens. Sibling products (ai-dev, tesote.ai) already standardize on OpenRouter.

## Decision

Use **OpenRouter** as a model-agnostic gateway, **BYOK** — the user supplies their own key. The key is stored encrypted and used only from the service worker.

## Consequences

- ✅ Any model, switchable per session; cheap text model for chat, vision model only when a screenshot is in the loop.
- ✅ No first-party inference cost or token resale → simpler trust + billing story.
- ✅ Aligns with the BYOK principle across the product family.
- ➖ User must obtain a key (onboarding friction); mitigated with clear setup + a sensible default model.
- ➖ Key custody is on us — encrypted at rest, SW-only (see [../security.md](../security.md)).
