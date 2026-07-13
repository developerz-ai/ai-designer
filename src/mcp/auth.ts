// Auth for MCP backends — three levels checked by the server in order (docs/idea/mcp.md
// "Auth"): admin/worker API key -> `Authorization: Bearer <key>`; OAuth 2.0 with PKCE via
// `chrome.identity.launchWebAuthFlow`; refreshable user token. Secrets never touch the page
// world: the API key and the OAuth token bundle live only in the encrypted key-store
// (`mcp:<id>:apikey` / `mcp:<id>:token`, SW-only decrypt), and the resolved `Authorization`
// header is applied by the SW transport at connection-open time (see `client.ts` getHeaders).
//
// SW-ONLY: never import this from content.ts or the page world. See
// docs/architecture/security.md "Key custody".

import { z } from 'zod';
import { clearSecret, getSecret, setSecret } from '@/agent/key-store';
import type { HeaderResolver } from './client';
import type { AuthKind } from './store';

// Refresh a little before the real expiry so a token can't lapse mid-request.
const EXPIRY_SKEW_MS = 60_000;

// --- secret names (single source of truth; store.ts purges these on remove) --------------

/** key-store secret names for a server's credentials. `token` matches the reference
 *  (`mcp:<id>:token`); the raw API key is a sibling secret. */
export function mcpSecretNames(serverId: string): { apiKey: string; token: string } {
  return { apiKey: `mcp:${serverId}:apikey`, token: `mcp:${serverId}:token` };
}

// --- schemas -----------------------------------------------------------------------------

/** OAuth endpoints + public-client id for one backend. Non-secret (the token is the secret);
 *  supplied by the caller — discovered (RFC 8414) or entered in the Add-server form. */
export const OAuthConfig = z.object({
  authorizationEndpoint: z.string().url(),
  tokenEndpoint: z.string().url(),
  clientId: z.string().min(1),
  scope: z.string().optional(),
});
export type OAuthConfig = z.infer<typeof OAuthConfig>;

/** The stored OAuth credential bundle. `expiresAt` is epoch ms; absent = unknown expiry
 *  (treated as non-expiring). Persisted JSON-encoded under `mcp:<id>:token`. */
export const TokenSet = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.number().optional(),
  tokenType: z.string().optional(),
  scope: z.string().optional(),
});
export type TokenSet = z.infer<typeof TokenSet>;

// The token endpoint's snake_case OAuth response (RFC 6749 §5.1). Mapped to `TokenSet`.
const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(), // seconds
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

// --- injectable environment --------------------------------------------------------------
// chrome.* / fetch / clock are resolved lazily (never at module load) so unit tests can run
// in a plain node env with no `chrome` global, injecting fakes per call.

type LaunchWebAuthFlow = (details: {
  url: string;
  interactive: boolean;
}) => Promise<string | undefined>;

export type AuthDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  launchWebAuthFlow?: LaunchWebAuthFlow;
  getRedirectURL?: (path?: string) => string;
};

const theFetch = (deps: AuthDeps): typeof fetch => deps.fetch ?? fetch;
const theNow = (deps: AuthDeps): (() => number) => deps.now ?? (() => Date.now());
const theLaunch = (deps: AuthDeps): LaunchWebAuthFlow =>
  deps.launchWebAuthFlow ?? ((details) => chrome.identity.launchWebAuthFlow(details));
const theRedirect = (deps: AuthDeps): ((path?: string) => string) =>
  deps.getRedirectURL ?? ((path) => chrome.identity.getRedirectURL(path));

// --- PKCE primitives (RFC 7636) — pure, testable ----------------------------------------

/** A high-entropy `code_verifier`: base64url(32 random bytes) = 43 chars of the unreserved
 *  set, within the RFC 7636 43–128 length bound. */
export function generateCodeVerifier(byteLength = 32): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** The `S256` `code_challenge` for a verifier: base64url(SHA-256(ASCII(verifier))). */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** An opaque `state` value binding the auth request to its redirect (CSRF guard). */
export function randomState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
}

/** Build the authorization-endpoint URL for the PKCE code flow. */
export function buildAuthorizationUrl(
  config: OAuthConfig,
  params: { codeChallenge: string; state: string; redirectUri: string },
): string {
  const url = new URL(config.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  if (config.scope) url.searchParams.set('scope', config.scope);
  return url.toString();
}

// --- API-key path ------------------------------------------------------------------------

/** Persist a server's API key (admin/worker key) encrypted, SW-only. */
export async function saveApiKey(serverId: string, key: string): Promise<void> {
  await setSecret(mcpSecretNames(serverId).apiKey, key);
}

/** Read a server's API key, or null if none is stored. */
export function getApiKey(serverId: string): Promise<string | null> {
  return getSecret(mcpSecretNames(serverId).apiKey);
}

// --- OAuth 2.0 PKCE flow -----------------------------------------------------------------

/**
 * Run the full PKCE authorization-code flow for a server and persist the resulting token
 * bundle. Opens the provider's consent page in `chrome.identity.launchWebAuthFlow`, verifies
 * the returned `state`, exchanges the code (with the `code_verifier`) at the token endpoint,
 * and stores `{access,refresh,expiresAt}` in the key-store. Returns the stored bundle.
 */
export async function startOAuth(
  serverId: string,
  config: OAuthConfig,
  deps: AuthDeps = {},
): Promise<TokenSet> {
  const cfg = OAuthConfig.parse(config);
  const redirectUri = theRedirect(deps)();
  const verifier = generateCodeVerifier();
  const state = randomState();
  const authUrl = buildAuthorizationUrl(cfg, {
    codeChallenge: await deriveCodeChallenge(verifier),
    state,
    redirectUri,
  });

  const redirect = await theLaunch(deps)({ url: authUrl, interactive: true });
  if (!redirect) throw new Error('OAuth flow was cancelled');
  const returned = parseRedirect(redirect);
  if (returned.state !== state) throw new Error('OAuth state mismatch — possible CSRF');

  const tokens = await requestToken(
    cfg.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code: returned.code,
      redirect_uri: redirectUri,
      client_id: cfg.clientId,
      code_verifier: verifier,
    }),
    deps,
  );
  await saveTokenSet(serverId, tokens);
  return tokens;
}

/** Exchange the stored refresh token for a fresh access token and persist it. Reuses the
 *  prior refresh token when the server does not rotate one. Throws if no refresh token. */
export async function refreshToken(
  serverId: string,
  config: OAuthConfig,
  deps: AuthDeps = {},
): Promise<TokenSet> {
  const cfg = OAuthConfig.parse(config);
  const current = await getTokenSet(serverId);
  if (!current?.refreshToken) throw new Error('No refresh token stored for this server');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: cfg.clientId,
  });
  if (cfg.scope) body.set('scope', cfg.scope);

  const refreshed = await requestToken(cfg.tokenEndpoint, body, deps);
  const merged: TokenSet = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? current.refreshToken,
  };
  await saveTokenSet(serverId, merged);
  return merged;
}

/**
 * The current access token for a server, refreshing first if it has expired (or is within
 * the skew window) and a refresh is possible. Returns null when the server has never been
 * authorized. A failed refresh degrades to the stale token so the caller's request surfaces
 * the server's 401 (which drives re-auth in the UI) rather than a silent no-auth.
 */
export async function getAccessToken(
  serverId: string,
  config?: OAuthConfig,
  deps: AuthDeps = {},
): Promise<string | null> {
  const current = await getTokenSet(serverId);
  if (!current) return null;
  if (!isExpired(current, theNow(deps)())) return current.accessToken;
  if (config && current.refreshToken) {
    try {
      return (await refreshToken(serverId, config, deps)).accessToken;
    } catch {
      // Refresh failed (revoked/offline) — fall through to the stale token.
    }
  }
  return current.accessToken;
}

/** Read a server's stored OAuth bundle, or null if unset/corrupt. */
export async function getTokenSet(serverId: string): Promise<TokenSet | null> {
  const raw = await getSecret(mcpSecretNames(serverId).token);
  if (raw === null) return null;
  const parsed = TokenSet.safeParse(safeJsonParse(raw));
  return parsed.success ? parsed.data : null;
}

/** Forget both of a server's credentials (API key + OAuth bundle). Called on server remove
 *  and on sign-out so no orphaned token survives. */
export async function clearAuth(serverId: string): Promise<void> {
  const { apiKey, token } = mcpSecretNames(serverId);
  await Promise.all([clearSecret(apiKey), clearSecret(token)]);
}

// --- header resolution (consumed by client.ts `getHeaders`) ------------------------------

/** What `authHeaders` needs to resolve a connection's credentials: the server id, its auth
 *  kind, and — for `oauth` — the endpoints used to refresh. */
export type AuthTarget = {
  id: string;
  authKind: AuthKind;
  oauth?: OAuthConfig;
};

/**
 * Resolve the `Authorization` header for a connection at open time, or undefined when the
 * server needs none / has no stored credential yet. Dispatches on the server's auth kind;
 * the OAuth branch transparently refreshes an expired token before returning it.
 */
export async function authHeaders(
  target: AuthTarget,
  deps: AuthDeps = {},
): Promise<Record<string, string> | undefined> {
  switch (target.authKind) {
    case 'none':
      return undefined;
    case 'apikey': {
      const key = await getApiKey(target.id);
      return key ? { Authorization: `Bearer ${key}` } : undefined;
    }
    case 'oauth': {
      const token = await getAccessToken(target.id, target.oauth, deps);
      return token ? { Authorization: `Bearer ${token}` } : undefined;
    }
  }
}

/** A `HeaderResolver` (client.ts) that re-resolves this server's auth on every (re)open, so
 *  a refreshed OAuth token is picked up without re-registering the connection. */
export function headerResolverFor(target: AuthTarget, deps: AuthDeps = {}): HeaderResolver {
  return () => authHeaders(target, deps);
}

// --- internals ---------------------------------------------------------------------------

function isExpired(tokens: TokenSet, now: number): boolean {
  return tokens.expiresAt != null && now >= tokens.expiresAt - EXPIRY_SKEW_MS;
}

async function saveTokenSet(serverId: string, tokens: TokenSet): Promise<void> {
  await setSecret(mcpSecretNames(serverId).token, JSON.stringify(TokenSet.parse(tokens)));
}

// POST an `application/x-www-form-urlencoded` grant to the token endpoint and map the OAuth
// response to a `TokenSet` (stamping `expiresAt` from `expires_in` against the injected clock).
async function requestToken(
  endpoint: string,
  body: URLSearchParams,
  deps: AuthDeps,
): Promise<TokenSet> {
  const res = await theFetch(deps)(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Token endpoint ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const json = TokenResponse.parse(await res.json());
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenType: json.token_type ?? 'Bearer',
    scope: json.scope,
    expiresAt: json.expires_in != null ? theNow(deps)() + json.expires_in * 1000 : undefined,
  };
}

// Pull `code`/`state` from the flow's redirect URL; surface an `error`/`error_description`
// the provider returned instead of a code.
function parseRedirect(redirect: string): { code: string; state: string | null } {
  const url = new URL(redirect);
  const error = url.searchParams.get('error');
  if (error) {
    throw new Error(`OAuth error: ${url.searchParams.get('error_description') ?? error}`);
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('OAuth redirect missing authorization code');
  return { code, state: url.searchParams.get('state') };
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// base64url (RFC 4648 §5): standard base64, `+/`->`-_`, padding stripped.
function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
