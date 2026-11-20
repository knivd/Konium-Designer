/**
 * Konium's version control Worker, two jobs:
 *
 * /api/vcs/blob/<name>: the store teams keep their projects in (an R2 bucket). A team is known
 * by the token its key gives (the key itself never comes here); what it keeps arrives sealed with
 * that key, so this can't read any of it. GET a blob (with its ETag), PUT one only if it is new
 * (If-None-Match: *) or still the version read (If-Match): 412 when someone else wrote it first.
 * A team is whoever holds its token, so anyone can start one: what keeps the bucket from being
 * filled by strangers is the ledger (ledger.ts, a Durable Object): each blob and each team's
 * store limited in size (MAX_BLOB_MB, MAX_TEAM_MB), the room taken in one step with the check;
 * new teams a day for each user and for the service; megabytes a day for each user; a ceiling on
 * the whole store (MAX_STORE_GB).
 *
 * /api/git/<host>/<path>: a relay for a team's own Git server, for servers that don't let pages
 * reach them (most hosted ones): only Git's own requests (info/refs, git-upload-pack,
 * git-receive-pack) are passed on over HTTPS, with the user's sign-in as it came; nothing is
 * kept or logged. A server's redirect is followed only to another address the relay would pass a
 * request to (so a server can't have it fetch anything else), the sign-in only to the same host.
 * The answer comes back from konium.app's own address, where the program itself lives, so
 * nothing of the server's choosing may be taken by a browser for a page: only Git's own content
 * types are passed on (anything else as plain bytes), never the server's other headers; it is
 * marked as a download that is not to be sniffed or run; and a browser that asks for it as a
 * page is refused.
 */

import { limitKey } from '../../limitKey';
import type { Room, Taken } from './ledger';

export interface R2Object { httpEtag: string; size: number; body?: ReadableStream; arrayBuffer?(): Promise<ArrayBuffer> }
export interface R2Like {
  get(key: string): Promise<(R2Object & { body: ReadableStream }) | null>;
  head(key: string): Promise<R2Object | null>;
  put(key: string, value: ArrayBuffer | Uint8Array | ReadableStream, o?: { onlyIf?: Headers }): Promise<R2Object | null>;
}
export interface Env {
  STORE: R2Like;
  /** A secret mixed into each team's token before it names the team's folder. */
  SALT: string;
  MAX_TEAM_MB?: string;
  MAX_BLOB_MB?: string;
  /** The whole store's ceiling, in GB; megabytes a user may write a day; new teams a day for a user, and for the service. */
  MAX_STORE_GB?: string;
  USER_MB_PER_DAY?: string;
  NEW_TEAMS_PER_USER?: string;
  NEW_TEAMS_PER_DAY?: string;
  LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

/** The ledger's methods (LedgerLogic's), called over RPC. */
export interface LedgerApi {
  team(team: string): number | null | Promise<number | null>;
  enter(team: string, bytes: number, now: number): void | Promise<void>;
  reserve(team: string, delta: number, maxTeam: number, maxStore: number, now: number): Room | Promise<Room>;
  release(team: string, delta: number): void | Promise<void>;
  take(day: string, who: string, kind: string, limit: number, units?: number): Taken | Promise<Taken>;
  prune(beforeDay: string): void | Promise<void>;
}
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && v !== undefined && v !== '' ? n : d; };

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match, Git-Protocol, Accept, Content-Encoding',
  'Access-Control-Expose-Headers': 'ETag, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
};
const reply = (body: object, status: number, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });

const NAME = /^[A-Za-z0-9._-]{1,64}(\/[A-Za-z0-9._-]{1,64}){0,3}$/;
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function handle(req: Request, env: Env, fetcher: typeof fetch = fetch, ledger?: LedgerApi, now = Date.now()): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const ip = limitKey(req.headers.get('CF-Connecting-IP') ?? 'unknown');
  if (env.LIMITER && !(await env.LIMITER.limit({ key: ip })).success) return reply({ error: 'Too many requests from here just now: try again in a minute' }, 429);
  if (url.pathname.startsWith('/api/vcs/blob/')) {
    let name: string;
    try { name = decodeURIComponent(url.pathname.slice('/api/vcs/blob/'.length)); } catch { return reply({ error: 'Not a name the store takes' }, 400); }
    return blob(req, env, name, ip, ledger, now);
  }
  if (url.pathname.startsWith('/api/git/')) return relay(req, url, fetcher);
  return reply({ error: 'Not here' }, 404);
}

async function blob(req: Request, env: Env, name: string, ip: string, ledger: LedgerApi | undefined, now: number): Promise<Response> {
  const auth = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('Authorization') ?? '');
  if (!auth) return reply({ error: 'No team key' }, 401);
  if (!NAME.test(name) || name.split('/').some((s) => s === '.' || s === '..')) return reply({ error: 'Not a name the store takes' }, 400);
  if (!env.SALT) return reply({ error: 'The store isn\'t set up on the server yet' }, 503);
  const team = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${auth[1]}:${env.SALT}`))).slice(0, 32);
  const key = `t/${team}/${name}`;
  if (req.method === 'GET') {
    const o = await env.STORE.get(key);
    if (!o) return reply({ error: 'None' }, 404);
    return new Response(o.body, { headers: { ...CORS, 'Content-Type': 'application/octet-stream', ETag: o.httpEtag, 'Cache-Control': 'no-store' } });
  }
  if (req.method !== 'PUT') return reply({ error: 'GET or PUT' }, 405);
  if (!ledger) return reply({ error: 'The store isn\'t set up on the server yet' }, 503);
  const MB = 1048576;
  const maxBlob = num(env.MAX_BLOB_MB, 95) * MB, maxTeam = num(env.MAX_TEAM_MB, 1024) * MB, maxStore = num(env.MAX_STORE_GB, 50) * 1024 * MB;
  // Its size is said before it is read: one that doesn't say, or says too much, is not read at all
  const said = req.headers.get('Content-Length');
  if (said === null || !/^\d+$/.test(said)) return reply({ error: 'Its size must be said (Content-Length)' }, 411);
  if (Number(said) > maxBlob) return reply({ error: `Too large to keep in one go (${Math.round(maxBlob / MB)} MB at most)` }, 413);
  const day = new Date(now).toISOString().slice(0, 10);
  const user = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ip|${ip}|${env.SALT}`))).slice(0, 24);
  // A team the ledger has not seen: one from before the ledger comes in with what it kept; a new one counts against today's new teams
  if ((await ledger.team(team)) === null) {
    const before = await env.STORE.get(`t/${team}/.usage`);
    const kept = before ? Number(await before.arrayBuffer?.().then((b) => new TextDecoder().decode(b)).catch(() => '0') ?? 0) || 0 : null;
    if (kept === null) {
      if (!(await ledger.take(day, user, 'teams', num(env.NEW_TEAMS_PER_USER, 3))).ok) return reply({ error: 'Too many new teams from here today: try again tomorrow (UTC)' }, 429);
      if (!(await ledger.take(day, 'everyone', 'teams', num(env.NEW_TEAMS_PER_DAY, 200))).ok) return reply({ error: 'Konium\'s store takes no more new teams today: try again tomorrow (UTC)' }, 429);
    }
    await ledger.enter(team, kept ?? 0, now);
    await ledger.prune(new Date(now - 3 * 86_400_000).toISOString().slice(0, 10));
  }
  const data = new Uint8Array(await req.arrayBuffer());
  if (data.length > maxBlob) return reply({ error: `Too large to keep in one go (${Math.round(maxBlob / MB)} MB at most)` }, 413);
  const perDay = num(env.USER_MB_PER_DAY, 1024);
  if (!(await ledger.take(day, user, 'mb', perDay, Math.ceil(data.length / MB))).ok) return reply({ error: `That's today's ${perDay} MB written from here: try again tomorrow (UTC)` }, 429);
  const head = await env.STORE.head(key);
  const was = head?.size ?? 0;
  const ifMatch = req.headers.get('If-Match'), ifNone = req.headers.get('If-None-Match');
  // New only: refused when it's there already (checked first, as well as asked of R2)
  if (ifNone === '*' && head) return reply({ error: 'There already' }, 412, { ETag: head.httpEtag });
  // The room is taken with the check, in the ledger's one step: pushes sent together can't each see room only one of them has
  const delta = data.length - was;
  const room = await ledger.reserve(team, delta, maxTeam, maxStore, now);
  if (!room.ok) return reply({ error: room.why === 'store' ? 'Konium\'s store is full: nothing more can be kept in it for now' : `The team's store is full (${Math.round(maxTeam / MB)} MB)` }, 507);
  const onlyIf = new Headers();
  if (ifMatch) onlyIf.set('If-Match', ifMatch);
  if (ifNone) onlyIf.set('If-None-Match', ifNone);
  let put: R2Object | null;
  try { put = await env.STORE.put(key, data, ifMatch || ifNone ? { onlyIf } : undefined); } catch (e) { await ledger.release(team, delta); throw e; }
  if (!put) { await ledger.release(team, delta); return reply({ error: 'Changed since it was read' }, 412); }
  return reply({ ok: true, etag: put.httpEtag }, 200, { ETag: put.httpEtag });
}

/** Git's own requests only. */
function gitRequest(method: string, path: string, q: URLSearchParams): boolean {
  if (method === 'GET') return /\/info\/refs$/.test(path) && /^git-(upload|receive)-pack$/.test(q.get('service') ?? '');
  if (method === 'POST') return /\/git-(upload|receive)-pack$/.test(path);
  return false;
}
const PASS_ON = ['authorization', 'content-type', 'accept', 'git-protocol', 'content-encoding'];

/** A host the relay passes requests to: a name with a dot in it (and a port), not konium.app's own. */
const gitHost = (host: string): boolean => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i.test(host) && !/(^|\.)konium\.app(:\d+)?$/i.test(host);
/** Redirects followed for one request at most (a renamed repository, a .git added: one or two). */
const MAX_REDIRECTS = 5;

async function relay(req: Request, url: URL, fetcher: typeof fetch): Promise<Response> {
  const rest = url.pathname.slice('/api/git/'.length);
  const i = rest.indexOf('/');
  const host = i < 0 ? rest : rest.slice(0, i), path = i < 0 ? '/' : rest.slice(i);
  // Asked for as a page, a frame or anything else a browser would show or run: not a Git client's request
  const dest = req.headers.get('Sec-Fetch-Dest') ?? '', mode = req.headers.get('Sec-Fetch-Mode') ?? '';
  if (mode === 'navigate' || (dest !== '' && dest !== 'empty')) return reply({ error: 'The relay answers Git\'s requests only' }, 403);
  if (!gitHost(host)) return reply({ error: 'Not a Git server this passes requests to' }, 400);
  if (!gitRequest(req.method, path, url.searchParams)) return reply({ error: 'Only Git\'s own requests are passed on' }, 403);
  const headers = new Headers({ 'User-Agent': 'git/konium-relay' });
  for (const h of PASS_ON) { const v = req.headers.get(h); if (v) headers.set(h, v); }
  let r: Response;
  try {
    let target = new URL(`https://${host}${path}${url.search}`);
    for (let hop = 0; ; hop++) {
      r = await fetcher(target.href, { method: req.method, headers, body: req.method === 'POST' ? req.body : undefined, redirect: 'manual' });
      const to = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
      if (!to) break;
      // A redirect: followed for Git's first request only (as Git itself does), and only to where the relay goes
      if (req.method !== 'GET') return reply({ error: 'The Git server has moved this repository: use its new address' }, 502);
      if (hop >= MAX_REDIRECTS) return reply({ error: 'The Git server keeps redirecting' }, 502);
      let next: URL;
      try { next = new URL(to, target); } catch { return reply({ error: 'The Git server redirected to no address' }, 502); }
      if (next.protocol !== 'https:' || !gitHost(next.host) || !gitRequest('GET', next.pathname, next.searchParams)) return reply({ error: 'The Git server redirected to an address this relay does not pass requests to' }, 502);
      if (next.host !== target.host) headers.delete('authorization');
      target = next;
    }
  } catch (e) { return reply({ error: `The Git server can't be reached: ${(e as Error).message}` }, 502); }
  return new Response(r.body, { status: r.status, headers: relayed(r) });
}

/** Git's own content types: the only ones passed on as they are. */
const GIT_TYPE = /^application\/x-git-(upload|receive)-pack-(advertisement|result)$/;
/**
 * What goes back with a Git server's answer. None of the server's own headers but its content
 * type, and that only when it is Git's: the answer is served from konium.app's address, and a
 * server must not be able to have a browser take it for a page, a script or a worker there.
 */
function relayed(r: Response): Headers {
  const out = new Headers(CORS);
  const type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  out.set('Content-Type', GIT_TYPE.test(type) ? type : 'application/octet-stream');
  out.set('Cache-Control', 'no-store');
  out.set('X-Content-Type-Options', 'nosniff');
  out.set('Content-Disposition', 'attachment');
  out.set('Content-Security-Policy', "default-src 'none'; sandbox");
  out.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return out;
}
