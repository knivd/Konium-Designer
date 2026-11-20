import { describe, expect, it } from 'vitest';
import { limitKey } from '../cloudflare/limitKey';
import { handle as vcs, type Env as VcsEnv } from '../cloudflare/vcs/src/handler';
import { handle as parts, type PartsEnv, type PartsStoreApi } from '../cloudflare/parts/src/handler';
import ai from '../cloudflare/ai/src/handler.ts?raw';
import report from '../cloudflare/report/src/index.ts?raw';

/**
 * The Workers after their review (26.169): a per-user limit counts an IPv6 user by their network
 * (/64), not by each address in it; the Git relay follows a server's redirect only to another
 * address it would pass a request to.
 */

describe("the Workers' per-user limits", () => {
  it('an IPv4 address as it is; an IPv6 one by its /64, however it is written', () => {
    expect(limitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(limitKey('unknown')).toBe('unknown');
    const net = '2001:db8:12:3400::/64';
    for (const a of ['2001:db8:12:3400::1', '2001:0db8:0012:3400:aaaa:bbbb:cccc:dddd', '2001:DB8:12:3400:1::', '2001:db8:12:3400:ffff:ffff:ffff:ffff']) expect(limitKey(a), a).toBe(net);
    expect(limitKey('2001:db8:12:3401::1')).not.toBe(net);
    expect(limitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(limitKey('::1')).toBe('0:0:0:0::/64');
    expect(limitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    // An IPv4 address written as IPv6
    expect(limitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('every service counts by it: the parts service gives two addresses of one network one allowance', async () => {
    for (const src of [ai, report]) expect(src).toContain("limitKey(req.headers.get('CF-Connecting-IP') ?? 'unknown')");
    const who: string[] = [];
    const store = {
      take: async (_d: string, w: string) => { who.push(w); return { ok: true, left: 1 }; }, left: async (_d: string, w: string) => { who.push(w); return 5; },
      takeMinute: async () => true, answer: async () => null, keep: async () => undefined, token: async () => null, setToken: async () => undefined, prune: async () => undefined,
    } as unknown as PartsStoreApi;
    const ask = (ip: string) => parts(new Request('https://konium.app/api/parts/config', { headers: { 'CF-Connecting-IP': ip } }), { SALT: 's' } as PartsEnv, store);
    await ask('2001:db8:12:3400::1'); await ask('2001:db8:12:3400:9999::2'); await ask('2001:db8:12:3401::1'); await ask('203.0.113.7'); await ask('203.0.113.8');
    expect(who[0]).toBe(who[1]);
    expect(new Set(who).size).toBe(4);
  });
});

describe("the Git relay and a server's redirects", () => {
  const env = { STORE: {}, SALT: 'pepper' } as unknown as VcsEnv;
  /** A Git server (or several): what each address answers. */
  const server = (routes: Record<string, [number, string?]>) => {
    const seen: { url: string; auth: string | null; redirect: unknown }[] = [];
    const fetcher = (async (u: string | URL, init?: RequestInit) => {
      seen.push({ url: String(u), auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
      const [status, location] = routes[String(u)] ?? [404];
      return new Response(status === 200 ? '001e# service=git-upload-pack\n' : null, { status, headers: location ? { location } : {} });
    }) as typeof fetch;
    return { seen, fetcher };
  };
  const refs = (repo: string) => `https://konium.app/api/git/${repo}/info/refs?service=git-upload-pack`;
  const get = (repo: string, f: typeof fetch) => vcs(new Request(refs(repo), { headers: { Authorization: 'Basic eDp5' } }), env, f);

  it('followed to the same server (a .git added, a repository renamed), the sign-in with it; never by itself', async () => {
    const s = server({
      'https://gitlab.example.com/team/board/info/refs?service=git-upload-pack': [301, '/team/board.git/info/refs?service=git-upload-pack'],
      'https://gitlab.example.com/team/board.git/info/refs?service=git-upload-pack': [200],
    });
    const r = await get('gitlab.example.com/team/board', s.fetcher);
    expect([r.status, r.headers.get('access-control-allow-origin'), r.headers.get('location')]).toEqual([200, '*', null]);
    expect(s.seen.map((x) => [x.url, x.auth, x.redirect])).toEqual([
      ['https://gitlab.example.com/team/board/info/refs?service=git-upload-pack', 'Basic eDp5', 'manual'],
      ['https://gitlab.example.com/team/board.git/info/refs?service=git-upload-pack', 'Basic eDp5', 'manual'],
    ]);
  });

  it('to another Git server: without the sign-in', async () => {
    const s = server({
      'https://old.example.com/a/b.git/info/refs?service=git-upload-pack': [302, 'https://new.example.org/a/b.git/info/refs?service=git-upload-pack'],
      'https://new.example.org/a/b.git/info/refs?service=git-upload-pack': [200],
    });
    expect((await get('old.example.com/a/b.git', s.fetcher)).status).toBe(200);
    expect(s.seen.map((x) => x.auth)).toEqual(['Basic eDp5', null]);
  });

  it("not to anything that isn't Git's own request over HTTPS, nor to konium.app, nor round and round", async () => {
    const from = 'https://git.example.com/a/b.git/info/refs?service=git-upload-pack';
    for (const to of ['https://example.com/private/report.pdf', 'http://git.example.com/a/b.git/info/refs?service=git-upload-pack', 'https://konium.app/a/b.git/info/refs?service=git-upload-pack',
      'https://localhost/a/b.git/info/refs?service=git-upload-pack', 'https://git.example.com/a/b.git/info/refs', '/a/b.git/HEAD']) {
      const s = server({ [from]: [302, to] });
      const r = await get('git.example.com/a/b.git', s.fetcher);
      expect([r.status, s.seen.length], to).toEqual([502, 1]);
      expect(((await r.json()) as { error: string }).error, to).toMatch(/redirected/);
    }
    const loop = server({ [from]: [302, from] });
    const r = await get('git.example.com/a/b.git', loop.fetcher);
    expect([r.status, loop.seen.length]).toEqual([502, 6]);
    // Git's second request (the pack) is never sent on to a new address
    const post = server({ 'https://git.example.com/a/b.git/git-upload-pack': [307, 'https://git.example.com/c/d.git/git-upload-pack'] });
    const p = await vcs(new Request('https://konium.app/api/git/git.example.com/a/b.git/git-upload-pack', { method: 'POST', body: 'x' }), env, post.fetcher);
    expect([p.status, post.seen.length]).toEqual([502, 1]);
  });
});
