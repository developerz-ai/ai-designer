// SW-side readiness compute: derives the header status-pill's `ReadinessState` from the
// provider config-store (01), the live MCP registry (02), and the runtime host-permission
// grant. `ready = provider && model` — MCP is optional (copy/debug flows in 06/07 still
// work with zero connected servers). SW-ONLY — imports config-store, which imports the
// key-store's WebCrypto decrypt; never import this from content.ts.

import type { McpHealth } from '@/mcp/manager';
import { originPattern } from '@/shared/host-permissions';
import type { ReadinessState } from '@/shared/messages';
import { getProviderConfig } from './config-store';

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
 *  keys off a valid stored config (baseURL), NOT the key: a keyless local openai-compatible
 *  endpoint (llama.cpp) is a supported setup — requiring a key would permanently block Start for it. */
export async function computeReadiness(mcpManager: McpHealthSource): Promise<ReadinessState> {
  const cfg = await getProviderConfig();
  const provider: ReadinessState['provider'] = cfg?.baseURL ? 'ok' : 'missing';
  const model: ReadinessState['model'] = cfg?.model ? 'ok' : 'missing';
  const hostPermission = await hostPermissionCheck(cfg?.baseURL);

  const health = mcpManager.allHealth();
  const mcp = {
    connected: health.filter((h) => h.status === 'connected').length,
    total: health.length,
  };

  return { provider, model, hostPermission, mcp, ready: provider === 'ok' && model === 'ok' };
}
