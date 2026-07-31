// SW-side readiness compute: derives the header status-pill's `ReadinessState` from the
// provider config-store (01), the live MCP registry (02), and the runtime host-permission
// grant. `ready = provider && model` — MCP is optional (copy/debug flows in 06/07 still
// work with zero connected servers). SW-ONLY — imports config-store, which imports the
// key-store's WebCrypto decrypt; never import this from content.ts.

import type { McpHealth } from '@/mcp/manager';
import { hasPageAccess, originPattern } from '@/shared/host-permissions';
import type { ReadinessState } from '@/shared/messages';
import { getProviderConfig } from './config-store';
import { isLocalEndpoint, keyMissing } from './provider';

// Structural subset of `McpManager` this module needs — keeps `computeReadiness` testable
// against a plain health-list stub instead of a real (connection-owning) McpManager.
export interface McpHealthSource {
  allHealth(): McpHealth[];
}

/** Host-permission status for the configured provider's origin. No provider configured
 *  yet, or an unparseable baseURL (shouldn't happen past `ProviderConfig`'s `.url()`
 *  guard), reads as `'needed'` rather than throwing — there's nothing granted to check. */
async function hostPermissionCheck(
  baseURL: string | undefined,
): Promise<ReadinessState['hostPermission']> {
  const pattern = baseURL ? originPattern(baseURL) : null;
  if (!pattern) return 'needed';
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  return granted ? 'granted' : 'needed';
}

/** Compute the current `ReadinessState`. Never throws: a missing/corrupt config reads as
 *  `provider: 'missing'`, an unreachable host as `hostPermission: 'needed'`. Provider readiness
 *  keys off a valid stored config (baseURL); the KEY is its own row, because the two fail
 *  differently: a keyless local openai-compatible endpoint (llama.cpp) is a supported setup, so
 *  its row reads `not-required` and never blocks Start, while a hosted endpoint with no stored
 *  key can only ever 401 — it blocks Start here instead of dying mid-turn with a provider-worded
 *  "Missing Authentication header". */
export async function computeReadiness(mcpManager: McpHealthSource): Promise<ReadinessState> {
  const cfg = await getProviderConfig();
  const provider: ReadinessState['provider'] = cfg?.baseURL ? 'ok' : 'missing';
  const model: ReadinessState['model'] = cfg?.model ? 'ok' : 'missing';
  const apiKey: ReadinessState['apiKey'] = !cfg?.baseURL
    ? 'missing' // no endpoint yet: the provider row owns that failure, this one just isn't satisfied
    : isLocalEndpoint(cfg.baseURL)
      ? 'not-required'
      : keyMissing(cfg)
        ? 'missing'
        : 'ok';
  const hostPermission = await hostPermissionCheck(cfg?.baseURL);
  // Advisory, like the MCP row — it gates the vision tools, not the ability to design.
  const pageAccess: ReadinessState['pageAccess'] = (await hasPageAccess().catch(() => false))
    ? 'granted'
    : 'needed';

  // The mcp row counts ENABLED servers only (#17): a disabled backend is neither reachable
  // (its tools never merge) nor expected capacity, so it must not inflate `total` either.
  const enabled = mcpManager.allHealth().filter((h) => h.enabled);
  const mcp = {
    connected: enabled.filter((h) => h.status === 'connected').length,
    total: enabled.length,
  };

  return {
    provider,
    model,
    apiKey,
    hostPermission,
    pageAccess,
    mcp,
    ready: provider === 'ok' && model === 'ok' && apiKey !== 'missing',
  };
}
