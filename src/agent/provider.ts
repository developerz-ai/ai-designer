// Provider client for any openai-compatible /v1 endpoint (OpenRouter, OpenAI, a local
// llama.cpp server, ...). SW-ONLY — network + keys live in the service worker
// (CLAUDE.md "MV3 three worlds"). Never import this from content.ts. Generalizes the
// former OpenRouter-only client (src/agent/openrouter.ts) to a BYOK base URL.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { ProviderConfig } from './config-store';

export type ModelInfo = {
  id: string;
  name: string;
  /** The model's context window in tokens, when the endpoint reports one. OPTIONAL and it must
   *  stay optional: a plain OpenAI-compatible `/models` response is only required to carry `id`,
   *  and a gateway that omits the field must still list its models. Consumers fall back visibly
   *  (`budget.ts` `DEFAULT_CONTEXT_WINDOW`) rather than guessing per-model. */
  contextWindow?: number;
};

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
  const body = (await res.json()) as { data?: unknown };
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .filter((m): m is Record<string, unknown> & { id: string } => typeof m.id === 'string')
    .map((m) => {
      const contextWindow = contextWindowOf(m);
      return {
        id: m.id,
        name: typeof m.name === 'string' ? m.name : m.id,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
    });
}

/** Every spelling of "context window" seen across OpenAI-compatible endpoints, in preference
 *  order. There is no standard field: OpenRouter uses `context_length` (and repeats it under
 *  `top_provider`, which can differ per routed provider and is the more accurate figure when
 *  present), llama.cpp-style servers use `context_window` or `n_ctx`, and several gateways mirror
 *  OpenAI and report nothing at all. Read tolerantly; never fail the listing over it. */
function contextWindowOf(model: Record<string, unknown>): number | undefined {
  const top = model.top_provider;
  const nested =
    typeof top === 'object' && top !== null
      ? (top as Record<string, unknown>).context_length
      : undefined;
  for (const candidate of [
    nested,
    model.context_length,
    model.context_window,
    model.max_context_length,
    model.n_ctx,
  ]) {
    // A finite positive integer only — a provider reporting 0, null, "8192" or NaN yields
    // "unknown", which falls back visibly, rather than a window of 0 that would compact forever.
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * The context window for ONE model id, or `undefined` when the endpoint doesn't say. Best-effort by
 * construction: a `/models` request that fails, times out, or omits the field resolves to
 * `undefined` rather than throwing, because this runs on the Save-provider path and a gateway
 * without a model catalogue must still be usable.
 */
export async function resolveContextWindow(
  endpoint: ProviderEndpoint,
  modelId: string,
): Promise<number | undefined> {
  try {
    const models = await listModels(endpoint);
    return models.find((m) => m.id === modelId)?.contextWindow;
  } catch {
    return undefined;
  }
}
