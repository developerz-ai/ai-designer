import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureHostAccess, originPattern } from '@/shared/host-permissions';

// originPattern is pure; ensureHostAccess is exercised against a minimal chrome.permissions
// fake (contains/request) so the grant / deny / already-granted / gesture-rejection branches
// are all covered without a real browser.

describe('host-permissions: originPattern', () => {
  it('maps an https base URL to an origin-scoped match pattern, dropping the path', () => {
    expect(originPattern('https://api.openai.com/v1')).toBe('https://api.openai.com/*');
    expect(originPattern('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/*');
  });

  it('drops the port (match patterns are origin+scheme, port matches all)', () => {
    expect(originPattern('http://localhost:1234/v1')).toBe('http://localhost/*');
  });

  it('preserves the http scheme for local endpoints', () => {
    expect(originPattern('http://127.0.0.1/v1/')).toBe('http://127.0.0.1/*');
  });

  it('returns null for an unparseable or non-http(s) URL', () => {
    expect(originPattern('not a url')).toBeNull();
    expect(originPattern('')).toBeNull();
    expect(originPattern('ftp://example.com/x')).toBeNull();
    expect(originPattern('file:///etc/passwd')).toBeNull();
  });
});

interface PermFake {
  contains: (p: { origins?: string[] }) => Promise<boolean>;
  request: ReturnType<typeof vi.fn>;
}

// granted: origins already held (static host_permissions or prior grant). grant: the answer
// a fresh request() resolves to. rejectRequest: request() throws (no user gesture in the SW).
function installPermissions(opts: {
  granted?: string[];
  grant?: boolean;
  rejectRequest?: boolean;
}): PermFake {
  const held = new Set(opts.granted ?? []);
  const request = vi.fn((p: { origins?: string[] }) => {
    if (opts.rejectRequest) return Promise.reject(new Error('user gesture required'));
    if (opts.grant) for (const o of p.origins ?? []) held.add(o);
    return Promise.resolve(Boolean(opts.grant));
  });
  const permissions: PermFake = {
    contains: (p) => Promise.resolve((p.origins ?? []).every((o) => held.has(o))),
    request,
  };
  (globalThis as { chrome?: unknown }).chrome = { permissions };
  return permissions;
}

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { chrome?: unknown }).chrome = undefined;
});

describe('host-permissions: ensureHostAccess', () => {
  it('is a no-op when the origin is already granted (no request prompt)', async () => {
    const perm = installPermissions({ granted: ['https://openrouter.ai/*'] });
    expect(await ensureHostAccess('https://openrouter.ai/api/v1')).toEqual({ ok: true });
    expect(perm.request).not.toHaveBeenCalled();
  });

  it('requests a grant for a not-yet-held custom host and reports ok on accept', async () => {
    const perm = installPermissions({ grant: true });
    expect(await ensureHostAccess('https://api.openai.com/v1')).toEqual({ ok: true });
    expect(perm.request).toHaveBeenCalledWith({ origins: ['https://api.openai.com/*'] });
  });

  it('surfaces a user denial without treating it as a crash', async () => {
    installPermissions({ grant: false });
    const res = await ensureHostAccess('https://api.openai.com/v1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('https://api.openai.com/*');
  });

  it('surfaces a request rejection (e.g. no user gesture in the SW)', async () => {
    installPermissions({ rejectRequest: true });
    const res = await ensureHostAccess('http://localhost:1234/v1');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Could not request host access');
  });

  it('rejects an invalid provider URL before touching chrome.permissions', async () => {
    const perm = installPermissions({ grant: true });
    const res = await ensureHostAccess('not a url');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Invalid provider URL');
    expect(perm.request).not.toHaveBeenCalled();
  });
});
