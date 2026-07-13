// Provider client for any openai-compatible /v1 endpoint (OpenRouter, OpenAI, a local
// llama.cpp server, ...). SW-ONLY — network + keys live in the service worker
// (CLAUDE.md "MV3 three worlds"). Never import this from content.ts. Generalizes the
// former OpenRouter-only client (src/agent/openrouter.ts) to a BYOK base URL.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from './config-store';

export type ModelInfo = { id: string; name: string };

// Outcome of an auth/reachability probe. `ok:false` with an `error` is a definitive
// rejection (e.g. 401); `ok:false` with no `error` is not-yet-valid — the endpoint was
// unreachable, so the UI surfaces it without treating the key as wrong.
export type ValidateResult = { ok: boolean; error?: string };

// validateProvider + listModels run during setup, before a model is chosen, so they
// take only the endpoint (base URL + optional key) — not the full config with `model`.
export type ProviderEndpoint = Pick<ProviderConfig, 'baseURL' | 'apiKey'>;

/** `Authorization: Bearer` header when a key is set; none for keyless local endpoints. */
function authHeaders(apiKey: string | undefined): Record<string, string> | undefined {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

/** `{baseURL}/models`, tolerating a trailing slash on the configured base URL. */
function modelsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, '')}/models`;
}

/** Build the AI SDK language model the agent loop drives for `cfg.model`. */
export function createProvider(cfg: ProviderConfig): LanguageModel {
  const provider = createOpenAICompatible({
    name: cfg.label ?? 'openai-compatible',
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    includeUsage: true, // else streamed token counts can come back 0 (budget needs them)
  });
  return provider(cfg.model);
}

/** Cheap auth/reachability check: GET {baseURL}/models. 2xx → valid; a non-2xx is a
 *  definitive rejection carrying the status; a network failure is treated as
 *  not-yet-valid (mirrors the former OpenRouter client). */
export async function validateProvider(endpoint: ProviderEndpoint): Promise<ValidateResult> {
  try {
    const res = await fetch(modelsUrl(endpoint.baseURL), { headers: authHeaders(endpoint.apiKey) });
    if (res.ok) return { ok: true };
    return { ok: false, error: `Provider /models responded ${res.status}` };
  } catch {
    return { ok: false }; // network failure -> not-yet-valid, no hard error
  }
}

/** List available models from {baseURL}/models. Returns id + display name (the name
 *  falls back to the id for endpoints like OpenAI that omit it). */
export async function listModels(endpoint: ProviderEndpoint): Promise<ModelInfo[]> {
  const res = await fetch(modelsUrl(endpoint.baseURL), { headers: authHeaders(endpoint.apiKey) });
  if (!res.ok) throw new Error(`Provider /models responded ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .filter((m): m is { id: string; name?: unknown } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id }));
}
