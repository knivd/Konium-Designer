/**
 * Konium's parts service (konium.app/api/parts): a BOM document's searches at Digi-Key and Mouser,
 * with the developer's own keys (Worker secrets), for anyone using Konium — within the
 * distributors' limits, which are the developer's:
 * - only searches: a part number or a few words in, the parts found out (src/model/suppliers.ts);
 * - an answer is kept for CACHE_HOURS and given again without asking the distributor (nor counting);
 * - each user (a salted hash of the IP address) gets LOOKUPS_PER_USER new searches a day;
 * - each distributor gets no more than its own day's and minute's calls (DIGIKEY_PER_DAY,
 *   MOUSER_PER_DAY, MOUSER_PER_MINUTE …), a little under what the distributor allows.
 *
 * GET  /config  which distributors are set up, and the user's searches left today
 * POST /search  { source: 'digikey' | 'mouser', q, exact? } → { parts, at, cached?, left }
 *               exact: q is the distributor's own part number (Update Supplier Data)
 */
import { SUPPLIER_NAMES, digikeyParts, mouserParts, type SupplierId, type SupplierPart } from '../../../src/model/suppliers';
import type { Taken } from './store';
import { limitKey } from '../../limitKey';
import { jsonUpTo } from '../../body';

export interface PartsEnv {
  DIGIKEY_CLIENT_ID?: string;
  DIGIKEY_CLIENT_SECRET?: string;
  MOUSER_KEY?: string;
  /** Mixed into the hash that stands for a user's IP address (a secret). */
  SALT?: string;
  /** Digi-Key's locale: site (UK, US, DE …), language, currency (GBP, USD, EUR …). */
  DIGIKEY_SITE?: string;
  DIGIKEY_LANGUAGE?: string;
  DIGIKEY_CURRENCY?: string;
  DIGIKEY_PER_DAY?: string;
  DIGIKEY_PER_MINUTE?: string;
  MOUSER_PER_DAY?: string;
  MOUSER_PER_MINUTE?: string;
  LOOKUPS_PER_USER?: string;
  CACHE_HOURS?: string;
}

/** The Durable Object's methods (PartsStoreLogic's), called over RPC. */
export interface PartsStoreApi {
  take(day: string, who: string, kind: string, limit: number): Taken | Promise<Taken>;
  left(day: string, who: string, kind: string, limit: number): number | Promise<number>;
  takeMinute(kind: string, minute: number, limit: number): boolean | Promise<boolean>;
  answer(key: string, since: number): { at: number; body: unknown } | null | Promise<{ at: number; body: unknown } | null>;
  keep(key: string, at: number, body: unknown): void | Promise<void>;
  token(id: string, now: number): string | null | Promise<string | null>;
  setToken(id: string, value: string, until: number): void | Promise<void>;
  prune(beforeDay: string, beforeAt: number, beforeMinute: number): void | Promise<void>;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const reply = (body: object, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const DIGIKEY = 'https://api.digikey.com';
const MOUSER = 'https://api.mouser.com/api/v1';
/** Parts asked for in one search. */
const RECORDS = 20;
const int = (v: string | undefined, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 0 && v !== undefined && v !== '' ? n : d; };

export const limits = (env: PartsEnv) => ({
  user: int(env.LOOKUPS_PER_USER, 100),
  day: { digikey: int(env.DIGIKEY_PER_DAY, 950), mouser: int(env.MOUSER_PER_DAY, 950) } as Record<SupplierId, number>,
  minute: { digikey: int(env.DIGIKEY_PER_MINUTE, 100), mouser: int(env.MOUSER_PER_MINUTE, 28) } as Record<SupplierId, number>,
  cacheMs: int(env.CACHE_HOURS, 24) * 3_600_000,
});
const ready = (env: PartsEnv, s: SupplierId) => (s === 'digikey' ? !!(env.DIGIKEY_CLIENT_ID && env.DIGIKEY_CLIENT_SECRET) : !!env.MOUSER_KEY);
const currencyOf = (env: PartsEnv) => (env.DIGIKEY_CURRENCY || 'GBP').toUpperCase();

async function clientOf(req: Request, env: PartsEnv): Promise<string> {
  // (an IPv6 address by its /64: one subscriber, however many addresses they use)
  const ip = limitKey(req.headers.get('CF-Connecting-IP') ?? 'unknown');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SALT ?? ''}|${ip}`)));
  return [...h.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a search may be: a part number or a few words, nothing else. */
const QUERY = /^[\p{L}\p{N} .,+\-_/#%()µΩ±°]{1,80}$/u;

export async function handle(req: Request, env: PartsEnv, store: PartsStoreApi, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const path = new URL(req.url).pathname.replace(/\/+$/, '');
  const day = new Date(now).toISOString().slice(0, 10);
  const lim = limits(env);
  const client = await clientOf(req, env);

  if (req.method === 'GET' && path.endsWith('/config')) {
    return reply({
      sources: (Object.keys(SUPPLIER_NAMES) as SupplierId[]).map((id) => ({ id, name: SUPPLIER_NAMES[id], ready: ready(env, id) })),
      left: await store.left(day, client, 'lookups', lim.user), perDay: lim.user, cacheHours: lim.cacheMs / 3_600_000,
    });
  }
  if (req.method !== 'POST' || !path.endsWith('/search')) return reply({ error: 'Not here' }, 404);
  // (a search is a few words: read no further than that, whatever its Content-Length says or leaves unsaid)
  const read = await jsonUpTo<{ source?: string; q?: string; exact?: boolean }>(req, 8192);
  if (read === 'long' || read === 'bad' || !read || typeof read !== 'object') return reply({ error: 'Not a search' }, read === 'long' ? 413 : 400);
  const body = read;
  const source = body.source as SupplierId;
  if (!(source in SUPPLIER_NAMES)) return reply({ error: 'Not a distributor the service searches' }, 400);
  const name = SUPPLIER_NAMES[source];
  if (!ready(env, source)) return reply({ error: `${name} searches aren't set up on the Konium service yet` }, 503);
  const q = String(body.q ?? '').trim().replace(/\s+/g, ' ');
  if (!QUERY.test(q)) return reply({ error: 'Search for a part number or a few words (up to 80 characters)' }, 400);
  const exact = !!body.exact;

  const key = `${source}|${exact ? 'n' : 'k'}|${source === 'digikey' ? currencyOf(env) : ''}|${q.toLowerCase()}`;
  const kept = await store.answer(key, now - lim.cacheMs);
  if (kept) return reply({ parts: kept.body, at: kept.at, cached: true, left: await store.left(day, client, 'lookups', lim.user) });

  const mine = await store.take(day, client, 'lookups', lim.user);
  if (!mine.ok) return reply({ error: `That's today's ${lim.user} new searches from here: searches already made today still answer, and the count starts again tomorrow (UTC)` }, 429);
  if (!(await store.takeMinute(source, Math.floor(now / 60_000), lim.minute[source]))) return reply({ error: `${name} is busy with Konium's searches: try again in a minute`, left: mine.left }, 429);
  if (!(await store.take(day, 'service', source, lim.day[source])).ok) return reply({ error: `Konium's ${name} searches for today are used up: try again tomorrow (UTC)`, left: mine.left }, 429);

  let parts: SupplierPart[];
  try {
    parts = source === 'digikey' ? await searchDigikey(env, store, fetchFn, q, exact, now) : await searchMouser(env, fetchFn, q, exact);
  } catch (e) {
    return reply({ error: `${name}: ${(e as Error).message}`, left: mine.left }, 502);
  }
  await store.keep(key, now, parts);
  await store.prune(new Date(now - 2 * 86_400_000).toISOString().slice(0, 10), now - 2 * lim.cacheMs, Math.floor(now / 60_000) - 5);
  return reply({ parts, at: now, left: mine.left });
}

/* ─── Digi-Key ─── */

async function digikeyToken(env: PartsEnv, store: PartsStoreApi, fetchFn: typeof fetch, now: number, fresh = false): Promise<string> {
  const have = fresh ? null : await store.token('digikey', now + 60_000);
  if (have) return have;
  const res = await fetchFn(`${DIGIKEY}/v1/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.DIGIKEY_CLIENT_ID!, client_secret: env.DIGIKEY_CLIENT_SECRET!, grant_type: 'client_credentials' }).toString(),
  });
  if (!res.ok) throw new Error(`sign-in refused (HTTP ${res.status})`);
  const t = await res.json() as { access_token?: string; expires_in?: number };
  if (!t.access_token) throw new Error('sign-in gave no token');
  await store.setToken('digikey', t.access_token, now + Math.max(60, Number(t.expires_in) || 600) * 1000);
  return t.access_token;
}

async function searchDigikey(env: PartsEnv, store: PartsStoreApi, fetchFn: typeof fetch, q: string, exact: boolean, now: number): Promise<SupplierPart[]> {
  const currency = currencyOf(env);
  const call = async (token: string) => {
    const headers = {
      Authorization: `Bearer ${token}`, 'X-DIGIKEY-Client-Id': env.DIGIKEY_CLIENT_ID!, 'X-DIGIKEY-Locale-Site': (env.DIGIKEY_SITE || 'UK').toUpperCase(),
      'X-DIGIKEY-Locale-Language': (env.DIGIKEY_LANGUAGE || 'en').toLowerCase(), 'X-DIGIKEY-Locale-Currency': currency, 'Content-Type': 'application/json', Accept: 'application/json',
    };
    return exact
      ? fetchFn(`${DIGIKEY}/products/v4/search/${encodeURIComponent(q)}/productdetails`, { headers })
      : fetchFn(`${DIGIKEY}/products/v4/search/keyword`, { method: 'POST', headers, body: JSON.stringify({ Keywords: q, Limit: RECORDS, Offset: 0 }) });
  };
  let res = await call(await digikeyToken(env, store, fetchFn, now));
  if (res.status === 401) res = await call(await digikeyToken(env, store, fetchFn, now, true));
  if (exact && res.status === 404) return [];
  if (!res.ok) throw new Error(res.status === 429 ? 'too many searches just now' : `HTTP ${res.status}`);
  const parts = digikeyParts(await res.json(), currency);
  // A Digi-Key number asked for: that packaging only, when it is among them
  if (exact) { const one = parts.filter((p) => p.spn.toLowerCase() === q.toLowerCase()); return one.length ? one : parts; }
  return parts;
}

/* ─── Mouser ─── */

async function searchMouser(env: PartsEnv, fetchFn: typeof fetch, q: string, exact: boolean): Promise<SupplierPart[]> {
  const url = `${MOUSER}/search/${exact ? 'partnumber' : 'keyword'}?apiKey=${encodeURIComponent(env.MOUSER_KEY!)}`;
  const body = exact
    ? { SearchByPartRequest: { mouserPartNumber: q, partSearchOptions: 'Exact' } }
    : { SearchByKeywordRequest: { keyword: q, records: RECORDS, startingRecord: 0, searchOptions: '', searchWithYourSignUpLanguage: '' } };
  const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(res.status === 429 ? 'too many searches just now' : `HTTP ${res.status}`);
  const parts = mouserParts(await res.json());
  if (exact) { const one = parts.filter((p) => p.spn.toLowerCase() === q.toLowerCase()); return one.length ? one : parts; }
  return parts;
}
