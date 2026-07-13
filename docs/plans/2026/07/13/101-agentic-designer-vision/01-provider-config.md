# 01 — Provider config (openai-compatible, BYOK)

> Part of [`overview.md`](overview.md). Depends on: none. World: **service worker** (network + keys) + **side panel** (form only).

## Why
Vision: "provider llm (openai compatible url), model name". Today hardcoded to OpenRouter (`src/agent/openrouter.ts:4` `BASE`). Generalize to any openai-compatible `/v1` endpoint while keeping OpenRouter as a preset. AI SDK 7 supports this via `@openrouter/ai-sdk-provider` OR `@ai-sdk/openai-compatible` — prefer a single `createOpenAICompatible({ baseURL, apiKey })` so custom endpoints work uniformly (verify pkg present; add if missing — see `docs/reference/agent-sdk.md`).

## Files to change
- `src/shared/messages.ts:22-91` — extend `SaveKey`/settings RPCs: add `ProviderConfig` = `{ baseURL: string(url), apiKey?: string, model: string, label?: string }`; new msgs `save-provider`, `get-provider`, `list-models` (already exists — make baseURL-aware). Keep back-compat alias for `save-openrouter-key` or migrate callers.
- `src/agent/key-store.ts:11-77` — generalize to **named** secrets: parametrize `STORAGE_KEY` → `secret(name)`; add `setSecret(name, plaintext)`/`getSecret(name)`/`hasSecret`/`clearSecret`. Keep the AES-GCM wrapping-key design intact. Provider key stored under `provider:<id>:key`.
- `src/agent/provider.ts` — **new**. `createProvider(cfg: ProviderConfig)` → AI SDK model factory via `createOpenAICompatible`. `validateProvider(cfg)` (auth ping — `GET {baseURL}/models` or `/key`), `listModels(cfg)`. Replaces the OpenRouter-only client; keep `openrouter.ts` as a thin preset (`baseURL: https://openrouter.ai/api/v1`) or fold in.
- `src/agent/config-store.ts` — **new**. Read/write `ProviderConfig` (non-secret fields plaintext in `chrome.storage.local`, key via `key-store.setSecret`). Single source the SW reads at agent-init.
- `src/entrypoints/background.ts:63-97` — replace `save-openrouter-key`/`set-model` handlers with `save-provider`/`get-provider`; `list-models` calls `provider.listModels(cfg)`; `key-status` → provider-readiness.
- `src/entrypoints/sidepanel/stores/settings.ts` — drive from `save-provider`/`get-provider`; expose `provider` signal.
- `src/entrypoints/sidepanel/components/SettingsPanel.tsx:9-100` + `.scss` — add fields: **Provider base URL** (preset dropdown: OpenRouter / OpenAI / Custom → free URL), **API key** (password, presence-only placeholder as today), **Model** (existing `<select>` + Refresh, now baseURL-aware). Keep SRP — form only, logic in store.
- `wxt.config.ts:12-35` — do **not** hardcode custom provider hosts; rely on `optional_host_permissions`. Add a runtime grant request when a non-preset baseURL is saved (host derived from URL). Keep `https://openrouter.ai/*` static.

## Steps
1. `key-store.ts`: refactor to named-secret API; keep existing `getOpenRouterKey` as a shim delegating to `getSecret('provider:default:key')` (or migrate call sites and delete). Preserve tests.
2. Add `ProviderConfig` Zod schema in `messages.ts`; wire new RPCs into the `PanelToSw` union + result schemas.
3. Write `provider.ts` (`createOpenAICompatible`) + `config-store.ts`. `validateProvider` returns `{ok, error?}`; treat network failure as not-yet-valid (mirror `openrouter.ts:13-15`).
4. Rewrite SW handlers; on `save-provider` with a custom host, request `optional_host_permissions` for that origin (`chrome.permissions.request`) before persisting; surface denial to the UI.
5. Update `settings.ts` store + `SettingsPanel.tsx` (preset dropdown + custom URL + key + model). Tokens/SCSS scoped to `.dz-settings`.
6. Migration: on first load, if legacy `openrouter-key` present, port it to `provider:default:key` with the OpenRouter preset baseURL.

## Tests
- Unit: `key-store` named-secret round-trip (extend `test/unit/key-store.test.ts`); `provider.validateProvider`/`listModels` with mocked fetch (baseURL respected); `messages` schema accepts `ProviderConfig`, rejects bad URL.
- Integration: `save-provider` → `get-provider` round-trip through the bus; legacy-key migration.
- E2E: extend `test/e2e/settings.spec.ts` — set a custom baseURL (route-stubbed), validate → list-models → persist across reload.
- `bun run typecheck`, `bun run lint`.

## Done when
- User can save any openai-compatible `{baseURL, key, model}`; OpenRouter/OpenAI presets one-click.
- Key encrypted via named-secret key-store; SW-only decrypt; custom host permission requested at save.
- Legacy OpenRouter config auto-migrates. Settings persist across reload. Gate green.
