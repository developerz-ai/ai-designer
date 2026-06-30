// OpenRouter REST client. SW-ONLY — network lives in the service worker
// (CLAUDE.md "MV3 three worlds"). Never import this from content.ts.

const BASE = 'https://openrouter.ai/api/v1';

export type ModelInfo = { id: string; name: string };

/** Cheap auth check: GET /key returns 200 for a valid key, 401 otherwise. */
export async function validateKey(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${key}` } });
    return res.ok;
  } catch {
    return false; // network failure -> treat as not-yet-valid; the UI surfaces it
  }
}

/** List available models (auth optional). Returns id + display name. */
export async function listModels(key: string | null): Promise<ModelInfo[]> {
  const init = key ? { headers: { Authorization: `Bearer ${key}` } } : undefined;
  const res = await fetch(`${BASE}/models`, init);
  if (!res.ok) throw new Error(`OpenRouter /models responded ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown }> };
  const data = Array.isArray(body.data) ? body.data : [];
  return data
    .filter((m): m is { id: string; name?: unknown } => typeof m.id === 'string')
    .map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id }));
}
