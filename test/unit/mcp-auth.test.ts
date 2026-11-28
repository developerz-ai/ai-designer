// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hasSecret, setSecret } from '@/agent/key-store';
import {
  authHeaders,
  buildAuthorizationUrl,
  clearAuth,
  deriveCodeChallenge,
  generateCodeVerifier,
  getAccessToken,
  getApiKey,
  getTokenSet,
  headerResolverFor,
  mcpSecretNames,
  type OAuthConfig,
  refreshToken,
  saveApiKey,
  startOAuth,
} from '@/mcp/auth';
import { createConnection, type McpClientFactory } from '@/mcp/client';

// mcp/auth custody + PKCE path with real WebCrypto (node env) + a real (fake) IDB + an
// in-memory chrome.storage.local. chrome.identity + fetch are injected per call, so the flow
// is exercised without a browser or a live OAuth server. SW-only module; jsdom lacks
// crypto.subtle, hence the node env.

function installChromeStorageLocalFake(): void {
  const store = new Map<string, unknown>();
  const local = {
    get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const names = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const name of names) if (store.has(name)) out[name] = store.get(name);
      return Promise.resolve(out);
    },
    set(items: Record<string, unknown>): Promise<void> {
      for (const [name, value] of Object.entries(items)) store.set(name, value);
      return Promise.resolve();
    },
    remove(keys: string | string[]): Promise<void> {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      return Promise.resolve();
    },
  };
  (globalThis as { chrome?: unknown }).chrome = { storage: { local } };
}

const OAUTH: OAuthConfig = {
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'client-123',
  scope: 'mcp.read mcp.write',
};

/** Minimal fetch-response stand-in for the token endpoint. */
function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 400),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** A fetch fake typed to satisfy `AuthDeps.fetch`. */
function fetchReturning(...responses: Response[]): typeof fetch {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  return fn as unknown as typeof fetch;
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  installChromeStorageLocalFake();
});

describe('PKCE primitives (RFC 7636)', () => {
  it('generateCodeVerifier: 43-char base64url, unique per call', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('deriveCodeChallenge: matches the RFC 7636 Appendix B S256 test vector', async () => {
    // The canonical verifier/challenge pair from the spec — proves the exact derivation.
    const challenge = await deriveCodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('buildAuthorizationUrl: carries the PKCE + flow params', () => {
    const url = new URL(
      buildAuthorizationUrl(OAUTH, {
        codeChallenge: 'CHAL',
        state: 'STATE',
        redirectUri: 'https://ext.chromiumapp.org/cb',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.example.com/authorize');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-123',
      redirect_uri: 'https://ext.chromiumapp.org/cb',
      code_challenge: 'CHAL',
      code_challenge_method: 'S256',
      state: 'STATE',
      scope: 'mcp.read mcp.write',
    });
  });
});

describe('API-key path', () => {
  it('stores the key encrypted and resolves a Bearer header', async () => {
    await saveApiKey('srv', 'admin-key-abc');
    expect(await getApiKey('srv')).toBe('admin-key-abc');
    // Persisted only as ciphertext under the key-store namespace.
    expect(await hasSecret(mcpSecretNames('srv').apiKey)).toBe(true);
    const persisted = await chrome.storage.local.get(null);
    expect(JSON.stringify(persisted)).not.toContain('admin-key-abc');

    expect(await authHeaders({ id: 'srv', authKind: 'apikey' })).toEqual({
      Authorization: 'Bearer admin-key-abc',
    });
  });

  it('authHeaders: none -> undefined; apikey with no stored key -> undefined', async () => {
    expect(await authHeaders({ id: 'srv', authKind: 'none' })).toBeUndefined();
    expect(await authHeaders({ id: 'unknown', authKind: 'apikey' })).toBeUndefined();
  });
});

describe('OAuth 2.0 PKCE flow', () => {
  /** A launch fake that echoes the request `state` back on the redirect (the happy path). */
  function launchEchoing(code = 'auth-code-xyz') {
    return vi.fn(async ({ url }: { url: string }) => {
      const state = new URL(url).searchParams.get('state');
      return `https://ext.chromiumapp.org/cb?code=${code}&state=${state}`;
    });
  }
  const getRedirectURL = (): string => 'https://ext.chromiumapp.org/cb';

  it('runs the code flow, exchanges with the verifier, and stores the bundle', async () => {
    const launchWebAuthFlow = launchEchoing();
    const fetch = fetchReturning(
      jsonResponse({
        access_token: 'acc-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'ref-1',
        scope: 'mcp.read',
      }),
    );
    const now = (): number => 1_000_000;

    const tokens = await startOAuth('srv1', OAUTH, {
      launchWebAuthFlow,
      getRedirectURL,
      fetch,
      now,
    });

    expect(tokens).toEqual({
      accessToken: 'acc-1',
      refreshToken: 'ref-1',
      tokenType: 'Bearer',
      scope: 'mcp.read',
      expiresAt: 1_000_000 + 3600 * 1000,
    });
    // Persisted encrypted under `mcp:<id>:token` and readable back.
    expect(await getTokenSet('srv1')).toEqual(tokens);
    const persisted = await chrome.storage.local.get(null);
    expect(JSON.stringify(persisted)).not.toContain('acc-1');

    // The consent URL used S256 + our redirect.
    const authUrl = launchWebAuthFlow.mock.calls[0]?.[0].url ?? '';
    expect(authUrl).toContain('code_challenge_method=S256');
    // The token exchange sent the verifier + auth code.
    const body = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '');
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code_verifier=');
    expect(body).toContain('code=auth-code-xyz');

    // A subsequent header resolve returns the fresh (unexpired) access token.
    expect(await authHeaders({ id: 'srv1', authKind: 'oauth', oauth: OAUTH }, { now })).toEqual({
      Authorization: 'Bearer acc-1',
    });
  });

  it('rejects a state mismatch (CSRF guard)', async () => {
    const launchWebAuthFlow = vi.fn(
      async () => 'https://ext.chromiumapp.org/cb?code=c&state=wrong-state',
    );
    await expect(
      startOAuth('srv', OAUTH, { launchWebAuthFlow, getRedirectURL, fetch: fetchReturning() }),
    ).rejects.toThrow(/state mismatch/i);
  });

  it('surfaces a provider error redirect', async () => {
    const launchWebAuthFlow = vi.fn(
      async () => 'https://ext.chromiumapp.org/cb?error=access_denied&error_description=nope',
    );
    await expect(
      startOAuth('srv', OAUTH, { launchWebAuthFlow, getRedirectURL, fetch: fetchReturning() }),
    ).rejects.toThrow(/nope/);
  });

  it('rejects when the user cancels (no redirect URL)', async () => {
    const launchWebAuthFlow = vi.fn(async () => undefined);
    await expect(
      startOAuth('srv', OAUTH, { launchWebAuthFlow, getRedirectURL, fetch: fetchReturning() }),
    ).rejects.toThrow(/cancel/i);
  });
});

describe('token refresh', () => {
  /** Seed a stored bundle directly (as the SW would after an earlier auth). */
  async function seedToken(id: string, tokens: unknown): Promise<void> {
    await setSecret(mcpSecretNames(id).token, JSON.stringify(tokens));
  }

  it('exchanges the refresh token and keeps the prior one when the server omits it', async () => {
    await seedToken('srv', { accessToken: 'old', refreshToken: 'r1', expiresAt: 500 });
    const fetch = fetchReturning(jsonResponse({ access_token: 'acc-2', expires_in: 3600 }));
    const now = (): number => 1_000_000;

    const refreshed = await refreshToken('srv', OAUTH, { fetch, now });
    expect(refreshed.accessToken).toBe('acc-2');
    expect(refreshed.refreshToken).toBe('r1'); // reused — server rotated none
    expect(refreshed.expiresAt).toBe(1_000_000 + 3600 * 1000);
    expect(await getTokenSet('srv')).toEqual(refreshed);

    const body = String(vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? '');
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=r1');
  });

  it('getAccessToken: returns a still-valid token without hitting the network', async () => {
    await seedToken('srv', { accessToken: 'live', expiresAt: 9_999_999_999_999 });
    const fetch = fetchReturning();
    expect(await getAccessToken('srv', OAUTH, { fetch, now: () => 1_000_000 })).toBe('live');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('getAccessToken: refreshes an expired token when a config is available', async () => {
    await seedToken('srv', { accessToken: 'old', refreshToken: 'r1', expiresAt: 500 });
    const fetch = fetchReturning(jsonResponse({ access_token: 'acc-2', expires_in: 3600 }));
    expect(await getAccessToken('srv', OAUTH, { fetch, now: () => 1_000_000 })).toBe('acc-2');
  });

  it('getAccessToken: degrades to the stale token when refresh fails', async () => {
    await seedToken('srv', { accessToken: 'old', refreshToken: 'r1', expiresAt: 500 });
    const fetch = fetchReturning(
      jsonResponse({ error: 'invalid_grant' }, { ok: false, status: 400 }),
    );
    expect(await getAccessToken('srv', OAUTH, { fetch, now: () => 1_000_000 })).toBe('old');
  });

  it('getAccessToken: null when the server was never authorized', async () => {
    expect(await getAccessToken('never', OAUTH, { now: () => 1_000_000 })).toBeNull();
  });

  it('accepts a numeric-string expires_in (real providers send "3600")', async () => {
    await seedToken('srv', { accessToken: 'old', refreshToken: 'r1', expiresAt: 500 });
    const fetch = fetchReturning(jsonResponse({ access_token: 'acc-2', expires_in: '3600' }));
    const refreshed = await refreshToken('srv', OAUTH, { fetch, now: () => 1_000_000 });
    expect(refreshed.expiresAt).toBe(1_000_000 + 3600 * 1000);
  });

  it('still refuses a non-numeric expires_in', async () => {
    await seedToken('srv', { accessToken: 'old', refreshToken: 'r1', expiresAt: 500 });
    const fetch = fetchReturning(jsonResponse({ access_token: 'acc-2', expires_in: 'soon' }));
    await expect(refreshToken('srv', OAUTH, { fetch, now: () => 1_000_000 })).rejects.toThrow();
  });

  it('getAccessToken: concurrent callers on an expired token share ONE refresh grant', async () => {
    // Per-request header resolution means an expiry meets several calls at once; a rotating
    // provider revokes the session on a second use of the old refresh token.
    await seedToken('srv', { accessToken: 'old', refreshToken: 'r1', expiresAt: 500 });
    const fetch = fetchReturning(
      jsonResponse({ access_token: 'acc-2', expires_in: 3600, refresh_token: 'r2' }),
      jsonResponse({ access_token: 'acc-3', expires_in: 3600, refresh_token: 'r3' }),
    );
    const deps = { fetch, now: () => 1_000_000 };
    const tokens = await Promise.all([
      getAccessToken('srv', OAUTH, deps),
      getAccessToken('srv', OAUTH, deps),
      getAccessToken('srv', OAUTH, deps),
    ]);
    expect(tokens).toEqual(['acc-2', 'acc-2', 'acc-2']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getTokenSet('srv'))?.refreshToken).toBe('r2');
  });

  it('refreshToken: throws with no stored refresh token', async () => {
    await seedToken('srv', { accessToken: 'a', expiresAt: 500 });
    await expect(refreshToken('srv', OAUTH, { fetch: fetchReturning() })).rejects.toThrow(
      /refresh token/i,
    );
  });
});

describe('headerResolverFor', () => {
  it('produces a resolver that re-reads the current credential on each open', async () => {
    await saveApiKey('srv', 'k1');
    const resolve = headerResolverFor({ id: 'srv', authKind: 'apikey' });
    expect(await resolve()).toEqual({ Authorization: 'Bearer k1' });

    await saveApiKey('srv', 'k2'); // rotated between opens
    expect(await resolve()).toEqual({ Authorization: 'Bearer k2' });
  });
});

describe('OAuth refresh: hung endpoints and deleted credentials', () => {
  async function seedToken(id: string, tokens: unknown): Promise<void> {
    await setSecret(mcpSecretNames(id).token, JSON.stringify(tokens));
  }

  it('a hung token endpoint is abandoned after the timeout; the stale token is used', async () => {
    await seedToken('srv', { accessToken: 'old', refreshToken: 'r1', expiresAt: 500 });
    // Never answers on its own — settles only when the request is aborted.
    const fetch = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof globalThis.fetch;
    const token = await getAccessToken('srv', OAUTH, {
      fetch,
      now: () => 1_000_000,
      tokenTimeoutMs: 20,
    });
    expect(token).toBe('old');
  });

  it('a refresh that lands after the credentials were deleted does not write them back', async () => {
    await seedToken('srv', { accessToken: 'old', refreshToken: 'r1', expiresAt: 500 });
    let answer!: (r: Response) => void;
    const fetch = vi.fn(
      () => new Promise<Response>((r) => (answer = r)),
    ) as unknown as typeof globalThis.fetch;
    const pending = getAccessToken('srv', OAUTH, { fetch, now: () => 1_000_000 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await clearAuth('srv'); // the server was removed / the user signed out mid-refresh
    answer(jsonResponse({ access_token: 'acc-2', expires_in: 3600, refresh_token: 'r2' }));
    await pending;

    expect(await getTokenSet('srv')).toBeNull();
    expect(await hasSecret(mcpSecretNames('srv').token)).toBe(false);
  });

  it('a refresh that lands after a re-authorization does not overwrite the new tokens', async () => {
    await seedToken('srv', { accessToken: 'old', refreshToken: 'r1', expiresAt: 500 });
    let answer!: (r: Response) => void;
    const fetch = vi.fn(
      () => new Promise<Response>((r) => (answer = r)),
    ) as unknown as typeof globalThis.fetch;
    const pending = getAccessToken('srv', OAUTH, { fetch, now: () => 1_000_000 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await seedToken('srv', { accessToken: 'reauth', refreshToken: 'fresh', expiresAt: 9e15 });
    answer(jsonResponse({ access_token: 'acc-2', expires_in: 3600, refresh_token: 'r2' }));
    await pending;

    expect((await getTokenSet('srv'))?.accessToken).toBe('reauth');
  });
});

describe('OAuth refresh: re-authorization that keeps the refresh token', () => {
  it('a refresh landing after a re-auth with the SAME refresh token keeps the re-auth tokens', async () => {
    await setSecret(
      mcpSecretNames('srv').token,
      JSON.stringify({ accessToken: 'old', refreshToken: 'r1', expiresAt: 500 }),
    );
    let answer!: (r: Response) => void;
    const fetch = vi.fn(
      () => new Promise<Response>((r) => (answer = r)),
    ) as unknown as typeof globalThis.fetch;
    const pending = getAccessToken('srv', OAUTH, { fetch, now: () => 1_000_000 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    await setSecret(
      mcpSecretNames('srv').token,
      JSON.stringify({ accessToken: 'reauth', refreshToken: 'r1', expiresAt: 9e15 }),
    );
    answer(jsonResponse({ access_token: 'acc-2', expires_in: 3600 }));
    await pending;

    expect((await getTokenSet('srv'))?.accessToken).toBe('reauth');
  });
});

describe('a real connection refreshes an expired OAuth token mid-session', () => {
  it('the request after expiry carries the refreshed token, with no reopen', async () => {
    // One real connection whose auth comes from headerResolverFor, a token that expires, a clock
    // that moves past it. Lives here (node env) because the key-store needs crypto.subtle.
    await setSecret(
      mcpSecretNames('srv').token,
      JSON.stringify({ accessToken: 'acc-1', refreshToken: 'r1', expiresAt: 2_000_000 }),
    );
    let clock = 1_000_000;
    const tokenFetch = fetchReturning(
      jsonResponse({ access_token: 'acc-2', expires_in: 3600, refresh_token: 'r2' }),
    );
    const getHeaders = headerResolverFor(
      { id: 'srv', authKind: 'oauth', oauth: OAUTH },
      { fetch: tokenFetch, now: () => clock },
    );
    let transport!: { fetch: typeof globalThis.fetch };
    const connect = vi.fn(async (config: { transport: unknown }) => {
      transport = config.transport as typeof transport;
      return { tools: async () => ({}), close: async () => {} };
    }) as unknown as McpClientFactory;
    const conn = createConnection({ id: 'srv', url: 'https://s/mcp', getHeaders }, { connect });
    await conn.tools();

    const sent: (string | null)[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('Authorization'));
      return new Response('{}');
    }) as typeof globalThis.fetch;
    try {
      await transport.fetch('https://s/mcp', { method: 'POST' });
      clock = 2_000_000; // past expiresAt (and its skew window)
      await transport.fetch('https://s/mcp', { method: 'POST' });
    } finally {
      globalThis.fetch = original;
    }

    expect(sent).toEqual(['Bearer acc-1', 'Bearer acc-2']);
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
