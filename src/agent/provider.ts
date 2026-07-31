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

/** Error surfaced when a hosted provider is configured with no key — the exact setup that used to
 *  validate green (see {@link authProbeUrl}) and then died mid-turn with a provider-worded 401. */
export const MISSING_KEY_ERROR =
  'This provider needs an API key — paste one above, then Save again.';

/** Error surfaced when the provider actively rejects the key we sent. */
export const REJECTED_KEY_ERROR =
  'Provider rejected this API key. Check it (and that it has credit) and save again.';

/** `Authorization: Bearer` header when a key is set; none for keyless local endpoints. */
function authHeaders(apiKey: string | undefined): Record<string, string> | undefined {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

/** `{baseURL}` without its trailing slash — the join point for every probe path below. */
function trimmed(baseURL: string): string {
  return baseURL.replace(/\/+$/, '');
}

/** `{baseURL}/models`, tolerating a trailing slash on the configured base URL. */
function modelsUrl(baseURL: string): string {
  return `${trimmed(baseURL)}/models`;
}

/** Loopback / `.local` hosts are a local model server (llama.cpp, Ollama, LM Studio) — the one
 *  supported keyless setup. Every other endpoint is hosted and needs a key, so a keyless config
 *  there is not "not yet validated", it's a guaranteed 401 on the first model call. An
 *  unparseable URL reads as remote (the strict side: it asks for a key rather than waving it
 *  through). */
export function isLocalEndpoint(baseURL: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  // `new URL('http://[::1]/').hostname` keeps the brackets; normalize both spellings.
  const host = hostname.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  );
}

/** Whether this endpoint config can possibly authenticate: a hosted provider with no key can't.
 *  Checked at save time (validate), at Start time (readiness) and again at turn time, so the
 *  failure is named in Settings instead of arriving as a provider-worded 401 mid-conversation. */
export function keyMissing(endpoint: ProviderEndpoint): boolean {
  return !endpoint.apiKey && !isLocalEndpoint(endpoint.baseURL);
}

/**
 * The endpoint to probe for an AUTH verdict. `/models` is the openai-compatible convention and
 * 401s without a key on OpenAI and most hosts — but OpenRouter serves its catalogue PUBLICLY, so
 * probing it there returns 200 for a config with no key at all (or a revoked one) and Settings
 * reports "saved and reachable" for a provider that cannot run a single turn. OpenRouter's `/key`
 * describes the calling key and 401s without one, so it's the honest probe there.
 */
export function authProbeUrl(baseURL: string): string {
  const base = trimmed(baseURL);
  try {
    const { hostname } = new URL(base);
    if (hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')) return `${base}/key`;
  } catch {
    // Unparseable base URL: fall through to the generic probe (fetch reports the real problem).
  }
  return `${base}/models`;
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

/** Cheap AUTH check: GET the endpoint's auth probe (see {@link authProbeUrl}) with the key. A
 *  hosted endpoint with no key fails outright — no request is worth making. 2xx → valid; 401/403
 *  is the key being rejected; any other non-2xx is a definitive rejection carrying the status; a
 *  network failure is treated as not-yet-valid (mirrors the former OpenRouter client). */
export async function validateProvider(endpoint: ProviderEndpoint): Promise<ValidateResult> {
  if (keyMissing(endpoint)) return { ok: false, error: MISSING_KEY_ERROR };
  try {
    const res = await fetch(authProbeUrl(endpoint.baseURL), {
      headers: authHeaders(endpoint.apiKey),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: REJECTED_KEY_ERROR };
    return { ok: false, error: `Provider responded ${res.status}` };
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
