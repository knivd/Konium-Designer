import { describe, expect, it } from 'vitest';
import { handle, type Env, type R2Like, type R2Object } from '../cloudflare/vcs/src/handler';
import { LedgerLogic, type Sql } from '../cloudflare/vcs/src/ledger';
import { KoniumStore, StoreConflict } from '../src/vcs/store';
import { newTeamKey } from '../src/vcs/keys';

/** R2 in memory: ETags, conditional writes by If-Match / If-None-Match. */
function memoryR2(): R2Like & { keys(): string[] } {
  const m = new Map<string, { data: Uint8Array; etag: string }>();
  let n = 0;
  const obj = (o: { data: Uint8Array; etag: string }): R2Object & { body: ReadableStream } => ({
    httpEtag: o.etag, size: o.data.length, body: new Response(o.data as Uint8Array<ArrayBuffer>).body!, arrayBuffer: async () => o.data.slice().buffer as ArrayBuffer,
  });
  return {
    keys: () => [...m.keys()],
    async get(k) { const o = m.get(k); return o ? obj(o) : null; },
    async head(k) { const o = m.get(k); return o ? obj(o) : null; },
    async put(k, v, o) {
      const cur = m.get(k);
      const im = o?.onlyIf?.get('If-Match'), inm = o?.onlyIf?.get('If-None-Match');
      if ((im && cur?.etag !== im) || (inm === '*' && cur)) return null;
      const data = v instanceof Uint8Array ? v : new Uint8Array(v instanceof ArrayBuffer ? v : await new Response(v).arrayBuffer());
      const e = { data, etag: `"e${++n}"` };
      m.set(k, e);
      return obj(e);
    },
  };
}
const env = (o: Partial<Env> = {}): Env & { STORE: ReturnType<typeof memoryR2> } => ({ STORE: memoryR2(), SALT: 'pepper', ...o }) as Env & { STORE: ReturnType<typeof memoryR2> };

function sqlite(): Sql {
  // Node's own SQLite, as a Durable Object's: a statement runs when given
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}
/** A request as a browser sends it: a body goes with its length said. */
function sent(u: string | URL, init: RequestInit & { ip?: string } = {}): Request {
  const h = new Headers(init.headers);
  const b = init.body as Uint8Array | string | undefined;
  if (b !== undefined && !h.has('Content-Length')) h.set('Content-Length', String(typeof b === 'string' ? new TextEncoder().encode(b).length : b.byteLength));
  if (init.ip) h.set('CF-Connecting-IP', init.ip);
  return new Request(String(u), { ...init, headers: h });
}

describe('Version control (R7): the konium-vcs Worker', () => {
  it('the store: what a team keeps, sealed, written only if new or unchanged, kept apart from other teams', async () => {
    const e = env(), ledger = new LedgerLogic(sqlite());
    const via = (async (u: string | URL, init?: RequestInit) => handle(sent(u, init), e, fetch, ledger)) as typeof fetch;
    const a = await KoniumStore.open(newTeamKey(), 'https://konium.app/api/vcs', via), b = await KoniumStore.open(newTeamKey(), 'https://konium.app/api/vcs', via);
    const t = await a.putJson('index', { projects: [{ id: 'x', name: 'Demo board', at: 1 }] }, null);
    await expect(a.putJson('index', {}, null)).rejects.toBeInstanceOf(StoreConflict);
    await expect(a.putJson('index', {}, '"stale"')).rejects.toBeInstanceOf(StoreConflict);
    await a.putJson('index', { projects: [] }, t);
    expect(await b.get('index')).toBeNull();
    expect((await a.getJson('index'))?.value).toEqual({ projects: [] });
    // Kept under a folder named from the token and the salt; nothing readable
    expect(e.STORE.keys().every((k) => /^t\/[0-9a-f]{32}\//.test(k))).toBe(true);
    for (const k of e.STORE.keys().filter((k) => !k.endsWith('.usage'))) expect(new TextDecoder().decode(new Uint8Array(await (await e.STORE.get(k))!.arrayBuffer!()))).not.toContain('Demo');
  });

  it('refused: no key, a bad name, too large, a full team, too many requests; preflight answered', async () => {
    const e = env({ MAX_BLOB_MB: '0.001', MAX_TEAM_MB: '0.002' }), ledger = new LedgerLogic(sqlite());
    const tok = 'a'.repeat(64);
    const put = (name: string, size: number, auth = `Bearer ${tok}`) => handle(sent(`https://konium.app/api/vcs/blob/${name}`, { method: 'PUT', headers: { Authorization: auth }, body: new Uint8Array(size) }), e, fetch, ledger);
    expect((await put('index', 10, 'Bearer nope')).status).toBe(401);
    expect((await put('../x', 10)).status).toBe(404);
    expect((await put('a%2F..%2Fb', 10)).status).toBe(400);
    expect((await put('r/a/b/c/d/e', 10)).status).toBe(400);
    expect((await put('big', 2000)).status).toBe(413);
    expect((await put('one', 1000)).status).toBe(200);
    expect((await put('two', 1000)).status).toBe(200);
    const full = await put('three', 1000);
    expect([full.status, ((await full.json()) as { error: string }).error]).toEqual([507, 'The team\'s store is full (0 MB)']);
    expect((await put('one', 900)).status).toBe(200);
    const pre = await handle(new Request('https://konium.app/api/vcs/blob/index', { method: 'OPTIONS' }), e);
    expect([pre.status, pre.headers.get('Access-Control-Allow-Headers')]).toEqual([204, expect.stringContaining('If-Match')]);
    const limited = env({ LIMITER: { limit: async () => ({ success: false }) } });
    expect((await handle(new Request('https://konium.app/api/vcs/blob/index', { headers: { Authorization: `Bearer ${tok}` } }), limited)).status).toBe(429);
    expect((await handle(new Request('https://konium.app/api/vcs/blob/index', { headers: { Authorization: `Bearer ${tok}` } }), env({ SALT: '' }))).status).toBe(503);
  });

  it('the relay: Git\'s own requests passed on over HTTPS with the sign-in, CORS added, cookies kept back; anything else refused', async () => {
    const seen: { url: string; method: string; auth: string | null; cookie: string | null }[] = [];
    const out = (async (u: string | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen.push({ url: String(u), method: init?.method ?? 'GET', auth: h.get('authorization'), cookie: h.get('cookie') });
      return new Response('001e# service=git-upload-pack\n', { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'set-cookie': 'a=b' } });
    }) as typeof fetch;
    const e = env();
    const r = await handle(new Request('https://konium.app/api/git/github.com/acme/board.git/info/refs?service=git-upload-pack', { headers: { Authorization: 'Basic eDp5', Cookie: 'konium=1' } }), e, out);
    expect([r.status, r.headers.get('access-control-allow-origin'), r.headers.get('set-cookie'), r.headers.get('content-type')]).toEqual([200, '*', null, 'application/x-git-upload-pack-advertisement']);
    expect(seen[0]).toEqual({ url: 'https://github.com/acme/board.git/info/refs?service=git-upload-pack', method: 'GET', auth: 'Basic eDp5', cookie: null });
    const post = await handle(new Request('https://konium.app/api/git/gitea.example.com:3000/t/p.git/git-receive-pack', { method: 'POST', body: 'x' }), e, out);
    expect([post.status, seen[1]!.url, seen[1]!.method]).toEqual([200, 'https://gitea.example.com:3000/t/p.git/git-receive-pack', 'POST']);
    for (const bad of ['https://konium.app/api/git/github.com/acme/board.git/HEAD', 'https://konium.app/api/git/github.com/', 'https://konium.app/api/git/konium.app/x/info/refs?service=git-upload-pack', 'https://konium.app/api/git/localhost/x/info/refs?service=git-upload-pack', 'https://konium.app/api/git/github.com/a/info/refs?service=other'])
      expect((await handle(new Request(bad), e, out)).status).toBeGreaterThanOrEqual(400);
    expect(seen).toHaveLength(2);
  });

  it('the relay (26.200): nothing a server sends can be taken by a browser for a page of konium.app', async () => {
    let asked = 0;
    // A server that is not a Git server at all: a page with a script, and headers that would let it stay
    const hostile = (async () => { asked++; return new Response('<script>alert(document.domain)</script>', { status: 200, headers: {
      'content-type': 'text/html; charset=utf-8', 'service-worker-allowed': '/', 'www-authenticate': 'Basic realm="konium.app"', 'refresh': '0;url=https://evil.example/',
      'content-security-policy': "script-src 'unsafe-inline'", 'link': '<https://evil.example/x.css>; rel=stylesheet', 'x-frame-options': 'ALLOWALL' } }); }) as typeof fetch;
    const e = env();
    const at = 'https://konium.app/api/git/evil.example/a/info/refs?service=git-upload-pack';
    const r = await handle(new Request(at), e, hostile);
    expect(asked).toBe(1);
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('content-disposition')).toBe('attachment');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(r.headers.get('cache-control')).toBe('no-store');
    for (const h of ['service-worker-allowed', 'www-authenticate', 'refresh', 'link', 'x-frame-options', 'set-cookie']) expect(r.headers.get(h), h).toBeNull();
    // A Git client's own answer keeps its type, and nothing else of the server's
    const git = (async () => new Response('0000', { headers: { 'content-type': 'Application/X-Git-Upload-Pack-Result; charset=x', etag: 'W/"1"' } })) as typeof fetch;
    const g = await handle(new Request('https://konium.app/api/git/github.com/a/b.git/git-upload-pack', { method: 'POST', body: 'x' }), e, git);
    expect([g.headers.get('content-type'), g.headers.get('etag'), g.headers.get('x-content-type-options')]).toEqual(['application/x-git-upload-pack-result', null, 'nosniff']);
    // Asked for as a page, a frame, a script or a worker: refused, and the server is not asked
    asked = 0;
    const asked4: Record<string, string>[] = [{ 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-Mode': 'navigate' }, { 'Sec-Fetch-Dest': 'iframe' }, { 'Sec-Fetch-Dest': 'script' }, { 'Sec-Fetch-Dest': 'serviceworker' }, { 'Sec-Fetch-Dest': 'style' }];
    for (const h of asked4) {
      const res = await handle(new Request(at, { headers: h }), e, hostile);
      expect([res.status, res.headers.get('content-type')], JSON.stringify(h)).toEqual([403, 'application/json']);
    }
    expect(asked).toBe(0);
    // A page's own fetch (as the program makes it) goes through
    expect((await handle(new Request(at, { headers: { 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } }), e, hostile)).status).toBe(200);
  });

  it('the store (26.200): its limits hold against strangers and against pushes sent together', async () => {
    const MB = 1048576;
    const tok = (c: string) => c.repeat(64);
    const put = (e: Env, ledger: LedgerLogic | undefined, t: string, name: string, size: number, o: { ip?: string; now?: number; length?: boolean } = {}) => {
      const req = sent(`https://konium.app/api/vcs/blob/${name}`, { method: 'PUT', headers: { Authorization: `Bearer ${t}`, 'If-None-Match': '*' }, body: new Uint8Array(size), ip: o.ip ?? '203.0.113.5' });
      if (o.length === false) req.headers.delete('Content-Length');
      return handle(req, e, fetch, ledger, o.now ?? Date.UTC(2026, 10, 20, 12));
    };
    // No ledger, or a size not said: nothing is read or kept
    const bare = env();
    expect((await put(bare, undefined, tok('a'), 'x', 10)).status).toBe(503);
    expect((await put(bare, new LedgerLogic(sqlite()), tok('a'), 'x', 10, { length: false })).status).toBe(411);
    expect(bare.STORE.keys()).toEqual([]);

    // Three new teams a day from one user (an IPv6 subscriber is one user, whatever address they use); others are not held up; tomorrow again
    const e1 = env(), l1 = new LedgerLogic(sqlite());
    for (const c of ['1', '2', '3']) expect((await put(e1, l1, tok(c), 'index', 10, { ip: `2001:db8:5:6::${c}` })).status).toBe(200);
    const fourth = await put(e1, l1, tok('4'), 'index', 10, { ip: '2001:db8:5:6:ffff::9' });
    expect([fourth.status, ((await fourth.json()) as { error: string }).error]).toEqual([429, 'Too many new teams from here today: try again tomorrow (UTC)']);
    expect(e1.STORE.keys().some((k) => k.includes('.usage'))).toBe(false);
    expect((await put(e1, l1, tok('1'), 'more', 10, { ip: '2001:db8:5:6::1' })).status).toBe(200);
    expect((await put(e1, l1, tok('5'), 'index', 10, { ip: '198.51.100.8' })).status).toBe(200);
    expect((await put(e1, l1, tok('4'), 'index', 10, { ip: '2001:db8:5:6::1', now: Date.UTC(2026, 10, 21, 0, 1) })).status).toBe(200);
    // …and so many for the whole service
    const e2 = env({ NEW_TEAMS_PER_DAY: '2' }), l2 = new LedgerLogic(sqlite());
    expect((await put(e2, l2, tok('1'), 'i', 10, { ip: '192.0.2.1' })).status).toBe(200);
    expect((await put(e2, l2, tok('2'), 'i', 10, { ip: '192.0.2.2' })).status).toBe(200);
    expect((await put(e2, l2, tok('3'), 'i', 10, { ip: '192.0.2.3' })).status).toBe(429);

    // A team from before the ledger comes in with what it kept, and is no new team
    const e3 = env({ NEW_TEAMS_PER_USER: '0', MAX_TEAM_MB: '1' }), l3 = new LedgerLogic(sqlite());
    const old = await (async () => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${tok('9')}:pepper`)); return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32); })();
    await e3.STORE.put(`t/${old}/.usage`, new TextEncoder().encode(String(MB - 500)));
    expect((await put(e3, l3, tok('9'), 'a', 400)).status).toBe(200);
    expect(l3.team(old)).toBe(MB - 100);
    expect((await put(e3, l3, tok('9'), 'b', 400)).status).toBe(507);
    expect((await put(e3, l3, tok('8'), 'a', 10)).status).toBe(429);

    // Pushes sent together: the team's allowance is taken with the check, so no more gets in than fits
    const e4 = env({ MAX_TEAM_MB: '0.004' }), l4 = new LedgerLogic(sqlite());           // 4,194 bytes
    const together = await Promise.all(Array.from({ length: 12 }, (_, k) => put(e4, l4, tok('c'), `pack${k}`, 1000)));
    expect(together.filter((r) => r.status === 200)).toHaveLength(4);
    expect(together.filter((r) => r.status === 507)).toHaveLength(8);
    expect(e4.STORE.keys()).toHaveLength(4);
    expect(l4.total()).toBe(4000);
    // A write that R2 refuses (there already) gives its room back
    expect((await put(e4, l4, tok('c'), 'pack0', 100)).status).toBe(412);
    expect(l4.total()).toBe(4000);

    // What one user may write a day, and the whole store's ceiling
    const e5 = env({ USER_MB_PER_DAY: '2', MAX_BLOB_MB: '2' }), l5 = new LedgerLogic(sqlite());
    expect((await put(e5, l5, tok('d'), 'a', MB)).status).toBe(200);
    expect((await put(e5, l5, tok('d'), 'b', MB)).status).toBe(200);
    const over = await put(e5, l5, tok('d'), 'c', 10);
    expect([over.status, ((await over.json()) as { error: string }).error]).toEqual([429, 'That\'s today\'s 2 MB written from here: try again tomorrow (UTC)']);
    const e6 = env({ MAX_STORE_GB: String(1500 / (1024 * MB)) }), l6 = new LedgerLogic(sqlite());
    expect((await put(e6, l6, tok('e'), 'a', 1000, { ip: '192.0.2.10' })).status).toBe(200);
    const full = await put(e6, l6, tok('f'), 'a', 1000, { ip: '192.0.2.11' });
    expect([full.status, ((await full.json()) as { error: string }).error]).toEqual([507, 'Konium\'s store is full: nothing more can be kept in it for now']);
  });
});
