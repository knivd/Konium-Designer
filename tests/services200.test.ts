/**
 * 26.200: what the review before the source went public found in the services, each with the test
 * that shows it closed (docs/REVIEW-26.200.md, S4 to S10; S1 and S2 are in vcsWorker140.test.ts,
 * S3 and S7 in report196.test.ts). GitHub, OpenRouter, the mail and other sites are stand-ins.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { bodyUpTo, jsonUpTo } from '../cloudflare/body';
import { fetchable, handle as ai, likelyCost, resetModelCache, type AiEnv, type ServiceModel } from '../cloudflare/ai/src/handler';
import { StoreLogic, type Sql } from '../cloudflare/ai/src/store';
import { handle as parts } from '../cloudflare/parts/src/handler';
import { PartsStoreLogic } from '../cloudflare/parts/src/store';
import { handle as library, type LibraryEnv } from '../cloudflare/library/src/handler';
import { LibraryStoreLogic } from '../cloudflare/library/src/store';
import { examplePart } from '../src/model/partExample';
import { cleanRecord, forMessage, oneLine } from '../src/model/worldLibrary';
import type { Survey, SurveyInput } from '../src/ai/jobs';

function sqlite(): Sql {
  const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(m: string): unknown } }).process.getBuiltinModule('node:sqlite') as
    { DatabaseSync: new (p: string) => { prepare(q: string): { all(...b: unknown[]): Record<string, unknown>[] } } };
  const db = new DatabaseSync(':memory:');
  return { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } };
}
/** A body that comes in pieces and says nothing of its length. */
const streamed = (total: number, piece = 1 << 20): ReadableStream<Uint8Array> => {
  let sent = 0;
  return new ReadableStream({ pull(c) { if (sent >= total) { c.close(); return; } const n = Math.min(piece, total - sent); sent += n; c.enqueue(new Uint8Array(n).fill(0x61)); } });
};

describe('a body is read no further than it may be long (26.200)', () => {
  it('whatever its Content-Length says or leaves unsaid', async () => {
    const req = (init: RequestInit) => new Request('https://konium.app/x', { method: 'POST', ...init, duplex: 'half' } as RequestInit);
    expect((await bodyUpTo(req({ body: 'hello' }), 10))!.length).toBe(5);
    expect(await bodyUpTo(req({ body: 'hello world' }), 10)).toBeNull();
    // A length said that is over: not read at all; a length said that is under, and untrue: stopped at the limit
    expect(await bodyUpTo(req({ body: 'x', headers: { 'Content-Length': '11' } }), 10)).toBeNull();
    expect(await bodyUpTo(req({ body: streamed(5 << 20), headers: { 'Content-Length': '3' } }), 1 << 20)).toBeNull();
    // No length said, coming in pieces: taken while it fits, dropped when it doesn't
    expect((await bodyUpTo(req({ body: streamed(3000, 1000) }), 3000))!.length).toBe(3000);
    expect(await bodyUpTo(req({ body: streamed(50 << 20) }), 2 << 20)).toBeNull();
    expect((await bodyUpTo(new Request('https://konium.app/x'), 10))!.length).toBe(0);
    expect(await jsonUpTo(req({ body: '{"a":1}' }), 100)).toEqual({ a: 1 });
    expect(await jsonUpTo(req({ body: '{"a":' }), 100)).toBe('bad');
    expect(await jsonUpTo(req({ body: streamed(5000) }), 100)).toBe('long');
  });
});

const MODELS = [
  { id: '~google/gemini-pro-latest', name: 'Google: Gemini Pro Latest', created: 380, pricing: { prompt: '0.000002', completion: '0.000012' }, architecture: { input_modalities: ['text', 'image'] } },
  { id: '~anthropic/claude-opus-latest', name: 'Anthropic: Claude Opus Latest', created: 370, pricing: { prompt: '0.000004', completion: '0.00002' }, architecture: { input_modalities: ['text', 'image'] } },
];
const answer: Survey = { maker: 'TI', device: 'LMV358', description: 'Dual op amp', variants: [{ partNumbers: ['LMV358DGKR'], package: 'VSSOP-8', pins: 8, leadForm: 'gull-wing' }] } as unknown as Survey;
const input: SurveyInput = { pages: [{ page: 1, text: 'LMV358 LMV358DGKR VSSOP 8 pins ordering information' }], pageCount: 1, partNumber: 'LMV358DGKR' };

describe('the AI service (26.200)', () => {
  const env: AiEnv = { OPENROUTER_KEY: 'sk-or-service', SALT: 's', JOBS_PER_DAY: '5', DAILY_BUDGET_USD: '0.5' };
  const now = Date.parse('2026-11-20T12:00:00Z'), day = '2026-11-20';
  let store: StoreLogic;
  beforeEach(() => { store = new StoreLogic(sqlite()); resetModelCache(); });
  const post = (path: string, body: object | BodyInit, ip = '1.2.3.4', headers: Record<string, string> = {}) => new Request(`https://konium.app/api/ai${path}`, {
    method: 'POST', headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'object' && !(body instanceof ReadableStream) ? JSON.stringify(body) : body as BodyInit, duplex: 'half',
  } as RequestInit);

  it('the day\'s budget is taken before the model is asked: jobs started together cannot run past it', async () => {
    let asked = 0, open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const fetchFn = (async (url: string) => {
      if (url.endsWith('/models')) return new Response(JSON.stringify({ data: MODELS }));
      asked++;
      await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }], usage: { prompt_tokens: 40_000, completion_tokens: 2_000, cost: 0.11 } }));
    }) as typeof fetch;
    // What one such job is set aside at, on the dearest model it may run on
    const model = (id: string): ServiceModel => ({ id, name: id, roles: ['text', 'vision'], vision: true, priceIn: 4, priceOut: 20, weight: 1 });
    const aside = likelyCost([{ role: 'user', content: 'x'.repeat(3000) }], model('m'), 4000);
    expect(aside).toBeCloseTo((1000 * 4 + 4000 * 20) / 1e6, 9);
    expect(likelyCost([{ role: 'user', content: [{ type: 'text', text: 'abc' }, { type: 'image_url', image_url: { url: 'data:' } }] as never }], model('m'), 0)).toBeCloseTo((1 + 1500) * 4 / 1e6, 9);
    // Forty users start a job in the same instant
    const all = Array.from({ length: 40 }, (_, k) => ai(post('/job', { job: 'survey', input }, `10.0.${k}.1`), env, store, fetchFn, now));
    await new Promise((r) => setTimeout(r, 30));
    const aheadOfAnswers = store.spent(day);
    open();
    const done = await Promise.all(all);
    const ok = done.filter((r) => r.status === 200).length, refused = done.filter((r) => r.status === 503).length;
    // Before a single answer was in, the day's budget was already spoken for, and no more than that had been let through
    expect(aheadOfAnswers).toBeGreaterThanOrEqual(0.5);
    expect(asked).toBe(ok);
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThan(40);
    expect(refused).toBe(40 - ok);
    expect(((await done.find((r) => r.status === 503)!.json()) as { error: string }).error).toContain('today\'s budget');
    // Settled to what the jobs did cost
    expect(store.spent(day)).toBeCloseTo(ok * 0.11, 6);
    // Those refused used none of their allowance
    const left = await (await ai(new Request('https://konium.app/api/ai/config', { headers: { 'CF-Connecting-IP': '10.0.39.1' } }), env, store, fetchFn, now)).json() as { allowance: { left: number } };
    expect(left.allowance.left).toBe(5);
  });

  it('a job the model could not do gives back what was set aside for it', async () => {
    const fetchFn = (async (url: string) => (url.endsWith('/models') ? new Response(JSON.stringify({ data: MODELS })) : new Response('busy', { status: 529 }))) as typeof fetch;
    const r = await ai(post('/job', { job: 'survey', input }), env, store, fetchFn, now);
    expect(r.status).toBe(502);
    expect(store.spent(day)).toBe(0);
    store.settle(day, -5);
    expect(store.spent(day)).toBe(0);
  });

  it('the shared cache has an end: past it the answers longest untouched go', () => {
    const small = new StoreLogic(sqlite(), 10);
    for (let k = 0; k < 14; k++) small.accept(`survey@1:${String(k).padStart(64, '0')}`, `c${k}`, { n: k }, 1000 + k);
    expect(small.answers()).toBeLessThanOrEqual(10);
    expect(small.cached(`survey@1:${'0'.repeat(64)}`)).toBeNull();
    expect(small.cached(`survey@1:${String(13).padStart(64, '0')}`)).toEqual({ answer: { n: 13 }, acceptedBy: 1 });
  });

  it('a job is read no further than a job may be long', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ data: MODELS }))) as typeof fetch;
    const r = await ai(post('/job', streamed(9 << 20)), env, store, fetchFn, now);
    expect([r.status, await r.json()]).toEqual([413, { error: 'Too much to send at once' }]);
    expect((await ai(post('/job', '[1,2'), env, store, fetchFn, now)).status).toBe(400);
  });

  it('a datasheet is fetched from named hosts on the web\'s own ports only, at every step', async () => {
    for (const ok of ['https://www.ti.com/lit/ds/symlink/lmv358.pdf', 'http://maker.example/a.pdf', 'https://xn--bcher-kva.example/x']) expect(fetchable(new URL(ok)), ok).toBe(true);
    for (const bad of ['https://192.168.1.1/x.pdf', 'http://127.0.0.1/', 'https://2130706433/', 'https://0x7f.0.0.1/', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://router/x', 'https://printer.local/x',
      'https://db.internal/x', 'https://maker.example:8443/a.pdf', 'https://maker.example:22/', 'https://user:pw@maker.example/a.pdf', 'ftp://maker.example/a.pdf', 'file:///etc/passwd', 'https://konium.app/api/ai/config', 'https://www.konium.app/x', 'https://100.64.0.1/x'])
      expect(fetchable(new URL(bad)), bad).toBe(false);

    const PDF = new TextEncoder().encode('%PDF-1.7 a datasheet');
    const seen: string[] = [];
    const site = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      expect(init?.redirect).toBe('manual');
      const to = (location: string) => new Response(null, { status: 302, headers: { location } });
      if (url === 'https://maker.example/ds.pdf') return new Response(PDF);
      if (url === 'https://maker.example/moved') return to('https://cdn.maker.example/ds.pdf');
      if (url === 'https://cdn.maker.example/ds.pdf') return new Response(PDF);
      if (url === 'https://maker.example/inside') return to('http://192.168.0.10/admin');
      if (url === 'https://maker.example/port') return to('https://maker.example:8080/ds.pdf');
      if (url === 'https://maker.example/loop') return to('https://maker.example/loop');
      if (url === 'https://maker.example/endless') return new Response(streamed(40 << 20), { headers: { 'content-type': 'application/pdf' } });
      if (url === 'https://maker.example/page') return new Response('<a href="http://10.0.0.5/secret.pdf">x</a> <a href="https://maker.example:9000/y.pdf">y</a> <a href="/ds.pdf">datasheet</a>');
      if (url === 'https://maker.example/onlybad') return new Response('<a href="http://10.0.0.5/secret.pdf">x</a>');
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const get = (u: string, ip = '1.2.3.4') => ai(new Request(`https://konium.app/api/ai/fetch?url=${encodeURIComponent(u)}`, { headers: { 'CF-Connecting-IP': ip } }), env, store, site, now);
    const pdf = await get('https://maker.example/ds.pdf');
    expect(pdf.status).toBe(200);
    // Handed on as a file, never as a page of konium.app's
    expect([pdf.headers.get('Content-Type'), pdf.headers.get('X-Content-Type-Options'), pdf.headers.get('Content-Disposition'), pdf.headers.get('Content-Security-Policy')]).toEqual(['application/pdf', 'nosniff', 'attachment', "default-src 'none'; sandbox"]);
    // A redirect to another named host is followed by hand; one to an address inside a network, or to another port, is not followed
    const moved = await get('https://maker.example/moved');
    expect([moved.status, moved.headers.get('X-Source-Url')]).toEqual([200, 'https://cdn.maker.example/ds.pdf']);
    seen.length = 0;
    expect((await get('https://maker.example/inside')).status).toBe(502);
    expect((await get('https://maker.example/port')).status).toBe(502);
    expect(seen).toEqual(['https://maker.example/inside', 'https://maker.example/port']);
    seen.length = 0;
    expect((await get('https://maker.example/loop')).status).toBe(502);
    expect(seen).toHaveLength(6);
    // A site that never stops sending: read no further than a datasheet may be long
    expect((await get('https://maker.example/endless')).status).toBe(413);
    // A page's links are held to the same rule: only the one that may be fetched is
    seen.length = 0;
    expect((await get('https://maker.example/page')).status).toBe(200);
    expect(seen).toEqual(['https://maker.example/page', 'https://maker.example/ds.pdf']);
    seen.length = 0;
    expect((await get('https://maker.example/onlybad')).status).toBe(415);
    expect(seen).toEqual(['https://maker.example/onlybad']);
    // Asked for an address it does not fetch: refused before anything is counted or fetched
    seen.length = 0;
    expect((await get('http://169.254.169.254/latest/meta-data/')).status).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe('the distributors\' service (26.200)', () => {
  it('a search is read no further than a search may be long', async () => {
    const store = new PartsStoreLogic(sqlite());
    const env = { DIGIKEY_ID: 'i', DIGIKEY_SECRET: 's', SALT: 'x' };
    const r = await parts(new Request('https://konium.app/api/parts/search', { method: 'POST', body: streamed(200_000), duplex: 'half' } as RequestInit), env as never, store as never, (async () => new Response('{}')) as typeof fetch);
    expect(r.status).toBe(413);
  });
});

describe('the world parts library (26.200)', () => {
  const ENV: LibraryEnv = { GITHUB_TOKEN: 't', LIBRARY_REPO: 'o/parts', LIBRARY_SECRET: 'a long secret', RESEND_KEY: 're' };
  const T0 = Date.UTC(2026, 10, 20, 12);
  const post = (path: string, body: unknown, ip: string) => new Request(`https://konium.app/api/library${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json' } });

  it('a part\'s words go into its commit on one line, naming nobody and closing nothing', () => {
    const sly = 'x)\n\nfixes #3, closes owner/repo#4\nCo-authored-by: A Person <person@example.org>\n@somebody (';
    expect(oneLine(sly)).toBe('x) fixes #3, closes owner/repo#4 Co-authored-by: A Person <person@example.org> @somebody (');
    const m = forMessage(sly);
    expect(m).not.toMatch(/[\n\r@#]/);
    expect(m).toContain('fixes ＃3');
    expect(m).toContain('＠somebody');
    expect(m.length).toBeLessThanOrEqual(120);
    // The record the library keeps has every text on one line (the marks themselves stay: they are the part's)
    const kept = cleanRecord({ ...examplePart('26.200').record, maker: sly, mpn: 'LM358#PBF\n', description: 'a\tb\u0000c d' });
    expect(kept.maker).toBe(oneLine(sly));
    expect(kept.mpn).toBe('LM358#PBF');
    expect(kept.description).toBe('a b c d');
    expect(JSON.stringify(kept)).not.toMatch(/\\n|\\t|\\u0000|\\u2028/);
  });

  it('sign-in mails have an end for the whole service; strangers cannot keep a contributor out', async () => {
    const mails: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => { if (url === 'https://api.resend.com/emails') { const m = JSON.parse(String(init!.body)) as { to: string[]; text: string }; mails.push(`${m.to[0]} ${m.text}`); } return new Response('{}'); }) as typeof fetch;
    const store = new LibraryStoreLogic(sqlite());
    const ask = async (email: string, ip: string, now = T0) => (await library(post('/signin', { email }, ip), ENV, store, fetchFn, now)).status;
    // Sixty an hour for everyone together, whoever asks and from wherever
    for (let k = 0; k < 60; k++) expect(await ask(`u${k}@example.org`, `10.1.${k}.1`), String(k)).toBe(200);
    expect(await ask('u99@example.org', '10.2.0.1')).toBe(429);
    expect(mails).toHaveLength(60);
    expect(await ask('u99@example.org', '10.2.0.1', T0 + 3_600_000)).toBe(200);

    // A contributor signs in from home; later strangers use up the links to her address; from home she still gets hers
    const s2 = new LibraryStoreLogic(sqlite());
    mails.length = 0;
    const home = '203.0.113.50';
    const asked = await (await library(post('/signin', { email: 'ada@example.org' }, home), ENV, s2, fetchFn, T0)).json() as { ticket: string };
    const link = /confirm\?id=([0-9a-f]{32})&code=([0-9a-f]{40})/.exec(mails[0]!)!;
    await library(new Request('https://konium.app/api/library/confirm', { method: 'POST', body: new URLSearchParams({ id: link[1]!, code: link[2]! }).toString() }), ENV, s2, fetchFn, T0 + 1000);
    expect((await library(post('/session', { ticket: asked.ticket }, home), ENV, s2, fetchFn, T0 + 2000)).status).toBe(200);
    const later = T0 + 5 * 3_600_000;
    for (let k = 0; k < 3; k++) expect(await (async () => (await library(post('/signin', { email: 'ada@example.org' }, `198.51.100.${k + 1}`), ENV, s2, fetchFn, later)).status)()).toBe(200);
    expect((await library(post('/signin', { email: 'ada@example.org' }, '198.51.100.9'), ENV, s2, fetchFn, later)).status).toBe(429);
    expect((await library(post('/signin', { email: 'ada@example.org' }, home), ENV, s2, fetchFn, later)).status).toBe(200);
    // …her own lot has an end too (three more), so her inbox is not filled from there either
    for (let k = 0; k < 2; k++) expect((await library(post('/signin', { email: 'ada@example.org' }, home), ENV, s2, fetchFn, later)).status).toBe(200);
    expect((await library(post('/signin', { email: 'ada@example.org' }, home), ENV, s2, fetchFn, later)).status).toBe(429);
  });

  it('a library file is GitHub\'s own request to the letter: nothing can be carried in beside it', async () => {
    const store = new LibraryStoreLogic(sqlite());
    let blobs = 0;
    const fetchFn = (async (url: string) => { if (url.endsWith('/git/blobs')) blobs++; return new Response(JSON.stringify({ sha: 'a'.repeat(40), id: 'm' }), { status: 201 }); }) as typeof fetch;
    // A session, made as the service makes one
    const { sessionFor, uidOf } = await import('../cloudflare/library/src/handler');
    const { token } = await sessionFor(ENV, await uidOf(ENV, 'ada@example.org'), T0);
    const send = (body: string) => library(new Request('https://konium.app/api/library/blob?kind=symbol', { method: 'POST', body, headers: { Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '1.1.1.1' } }), ENV, store, fetchFn, T0 + 1000);
    expect((await send('{"content":"0M8R4KGxGuEAAAA","encoding":"base64"}')).status).toBe(200);
    expect((await send('{"content":"0M8R4KGxGuEAAAA","x":"y","encoding":"base64"}')).status).toBe(400);
    expect((await send('{"content":"0M8R4KGxGuEAA\\"AA","encoding":"base64"}')).status).toBe(400);
    expect(blobs).toBe(1);
  });
});
