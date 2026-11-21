/**
 * 26.201 (R21, step 2): the app's client for the world parts library (src/platform/libraryService.ts),
 * driven against the service's own code (cloudflare/library) with GitHub and the mail stood in for:
 * the real ones can't be reached from the tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle } from '../cloudflare/library/src/handler';
import { LibraryStoreLogic } from '../cloudflare/library/src/store';
import { ENV, T0, sqlite, world } from './helpers/libraryWorld';
import { examplePart } from '../src/model/partExample';
import { partKey } from '../src/model/partKey';
import type { PartPackage } from '../src/model/partPackage';
import { LIBRARY_LICENCE, MAX_SYMBOL, type LibraryEntry } from '../src/model/worldLibrary';
import { settings } from '../src/core/settings';
import { FEATURES, STAGE } from '../src/core/release';
import { CONNECTIONS, OFFLINE_NOTE, shownConnections } from '../src/platform/network';
import {
  LibraryError, askSignIn, findInLibrary, keptSession, libraryConfig, publishPart, publishProblems, resetLibraryConfig, sessionFor, signOut, whoAmI,
} from '../src/platform/libraryService';

const PART = examplePart('26.201');
const KEY = partKey(PART.record.mpn);

/** The service as the app reaches it: every request the client makes goes to the service's own code. */
function service(ip = '203.0.113.7') {
  const w = world(), store = new LibraryStoreLogic(sqlite());
  const clock = { now: T0 };
  const calls: { line: string; body: string; auth: string }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ line: `${init?.method ?? 'GET'} ${url.replace('https://konium.app/api/library', '')}`, body: typeof init?.body === 'string' ? init.body : '', auth: headers.Authorization ?? '' });
    return handle(new Request(url, { ...init, headers: { 'CF-Connecting-IP': ip, ...headers } }), ENV, store, w.fetchFn, clock.now);
  }) as typeof fetch;
  /** The person with the mail: the link opened and confirmed. */
  const confirm = async () => {
    const link = /https:\/\/konium\.app\/api\/library\/confirm\?id=([0-9a-f]{32})&code=([0-9a-f]{40})/.exec(w.mails.at(-1)!.text)!;
    await handle(new Request('https://konium.app/api/library/confirm', { method: 'POST', body: new URLSearchParams({ id: link[1]!, code: link[2]! }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), ENV, store, w.fetchFn, clock.now);
  };
  /** A whole sign-in as the app does it. */
  const signIn = async (email: string) => {
    const { ticket } = await askSignIn(email, f);
    await confirm();
    const s = await sessionFor(ticket, f, clock.now);
    if (s === 'pending') throw new Error('still pending');
    return s;
  };
  return { w, store, clock, calls, f, confirm, signIn, lines: () => calls.map((c) => c.line) };
}

let kept: Map<string, string>;
beforeEach(() => {
  kept = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
  resetLibraryConfig();
});
afterEach(() => { vi.unstubAllGlobals(); Object.assign(settings, { offline: false }); });

const refusal = async (p: Promise<unknown>): Promise<LibraryError> => { try { await p; } catch (e) { return e as LibraryError; } throw new Error('it was not refused'); };

describe('the world parts library from the app (26.201)', () => {
  it('the service says what it is; the app asks once', async () => {
    const s = service();
    const c = await libraryConfig(s.f);
    expect(c).toEqual({ ready: true, signIn: true, repo: 'o/parts', web: 'https://github.com/o/parts', licence: LIBRARY_LICENCE, publishPerDay: c!.publishPerDay, parts: 0 });
    await libraryConfig(s.f);
    expect(s.lines()).toEqual(['GET /config']);
  });

  it('looking a number up sends the number and nothing else; a number the library has not answers null', async () => {
    const s = service();
    expect(await findInLibrary(' kd-ex1833/so8 ', s.f)).toBeNull();
    expect(s.calls).toEqual([{ line: `GET /part/${KEY}`, body: '', auth: '' }]);
    expect((await refusal(findInLibrary('A?', s.f))).message).toMatch(/three letters or digits/);
    expect(s.calls).toHaveLength(1);
  });

  it('signing in: a link is mailed, the app waits, and the confirmed sign-in is kept in this browser', async () => {
    const s = service();
    const { ticket, minutes } = await askSignIn(' Ada@Example.org ', s.f);
    expect(minutes).toBe(15);
    expect(s.w.mails.at(-1)!.to).toEqual(['ada@example.org']);
    expect(await sessionFor(ticket, s.f, s.clock.now)).toBe('pending');
    expect(keptSession(s.clock.now)).toBeNull();
    await s.confirm();
    const got = await sessionFor(ticket, s.f, s.clock.now);
    expect(got).not.toBe('pending');
    const session = keptSession(s.clock.now)!;
    expect(session.user).toEqual({ id: expect.stringMatching(/^k-[0-9a-f]{8}$/), name: '', email: 'ada@example.org' });
    expect(session.token).toMatch(/^[0-9a-f]{16}\.\d+\.[0-9a-f]{64}$/);
    expect(await whoAmI(s.f, s.clock.now)).toEqual(session.user);
    // (a ticket is good once)
    expect((await refusal(sessionFor(ticket, s.f, s.clock.now))).status).toBe(410);
    // (the sign-in runs out with its pass; signing out forgets it at once)
    expect(keptSession(session.until + 1)).toBeNull();
    signOut();
    expect(keptSession(s.clock.now)).toBeNull();
    expect((await refusal(askSignIn('not an address', s.f))).message).toBe('That is not an email address');
  });

  it('a part published is in the library as Unverified, and comes back whole to whoever looks its number up', async () => {
    const s = service();
    const me = await s.signIn('ada@example.org');
    s.calls.length = 0;
    const done = await publishPart(PART, { agreed: true, name: 'Ada L.', app: '26.201' }, s.f, s.clock.now);
    expect(done.entry).toMatchObject({ key: KEY, mpn: PART.record.mpn, status: 'unverified', by: me.user.id, name: 'Ada L.', revision: 1, licence: LIBRARY_LICENCE, app: '26.201' });
    expect(done.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(done.url).toBe(`https://github.com/o/parts/tree/main/parts/${KEY.slice(0, 2)}/${KEY}`);
    expect(s.lines()).toEqual(['POST /blob?kind=symbol', 'POST /blob?kind=footprint', 'POST /publish']);
    // What went: the two libraries as the repository's own blob requests, then the record with the agreement. Nothing else
    expect(s.calls[0]!.body).toMatch(/^\{"content":"0M8R4KGxGuE[A-Za-z0-9+/=]*","encoding":"base64"\}$/);
    const sent = JSON.parse(s.calls[2]!.body) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['app', 'footprint', 'licence', 'name', 'record', 'symbol']);
    expect(sent.licence).toBe('CC0-1.0');
    expect(Object.keys(sent.record as object).sort()).toEqual(['datasheet', 'description', 'device', 'format', 'made', 'maker', 'mpn', 'package', 'pins', 'symbol']);
    expect(s.calls.every((c) => c.auth === `Bearer ${me.token}`)).toBe(true);
    expect(keptSession(s.clock.now)!.user.name).toBe('Ada L.');

    // Somebody else, signed in nowhere, looks the number up
    signOut();
    s.calls.length = 0;
    const found = (await findInLibrary(PART.record.mpn, s.f))!;
    expect(s.lines()).toEqual([`GET /part/${KEY}`, ...['part.json', 'symbol.SchLib', 'footprint.PcbLib'].map((n) => `GET /part/${KEY}/${n}?c=${done.commit}`)]);
    expect(s.calls.every((c) => !c.auth && !c.body)).toBe(true);
    expect(found.entry).toEqual(done.entry);
    expect(found.part.record.library).toEqual(done.entry);
    expect({ ...found.part.record, library: undefined }).toEqual({ ...PART.record, library: undefined });
    expect([...found.part.schlib]).toEqual([...PART.schlib]);
    expect([...found.part.pcblib]).toEqual([...PART.pcblib]);
    expect(found.checks.some((c) => c.level === 'error')).toBe(false);
  });

  it('its author publishes it again as the next revision; anyone else is told whose it is', async () => {
    const s = service();
    await s.signIn('ada@example.org');
    await publishPart(PART, { agreed: true, name: 'Ada' }, s.f, s.clock.now);
    s.clock.now += 60_000;
    // (no name given: the one chosen before stays)
    expect((await publishPart(PART, { agreed: true }, s.f, s.clock.now)).entry).toMatchObject({ revision: 2, name: 'Ada' });
    await s.signIn('grace@example.org');
    const no = await refusal(publishPart(PART, { agreed: true, name: 'Grace' }, s.f, s.clock.now));
    expect(no.status).toBe(409);
    expect(no.message).toBe(`${PART.record.mpn} is in the parts library already, published by Ada`);
    expect(no.entry).toMatchObject({ key: KEY, name: 'Ada', revision: 2 });
  });

  it('nothing is sent without the agreement, without a sign-in, or of a part with a fault', async () => {
    const s = service();
    expect((await refusal(publishPart(PART, { agreed: true }, s.f, s.clock.now))).status).toBe(401);
    await s.signIn('ada@example.org');
    s.calls.length = 0;
    expect((await refusal(publishPart(PART, { agreed: false }, s.f, s.clock.now))).message).toMatch(/public domain \(CC0 1\.0\) only/);
    const faulty: PartPackage = { ...PART, record: { ...PART.record, maker: ' ' } };
    expect(publishProblems(PART)).toEqual([]);
    expect(publishProblems(faulty)).toEqual(['It names no manufacturer']);
    const no = await refusal(publishPart(faulty, { agreed: true }, s.f, s.clock.now));
    expect(no.problems).toEqual(['It names no manufacturer']);
    expect(publishProblems({ ...PART, schlib: new Uint8Array(MAX_SYMBOL + 1) }).join(' ')).toMatch(/symbol's library is too large \(400 KB at most\)/);
    // (a part that fails its own checks is stopped by them too)
    expect(publishProblems({ ...PART, pcblib: new Uint8Array(600) })).toEqual(['No footprint could be read from it']);
    expect(s.calls).toEqual([]);
  });

  it('a pass the service no longer takes is forgotten here', async () => {
    const s = service();
    const me = await s.signIn('ada@example.org');
    // (the pass has run out by the service's clock, though this browser's still takes it)
    s.clock.now = me.until + 1000;
    expect((await refusal(publishPart(PART, { agreed: true }, s.f, T0))).status).toBe(401);
    expect(keptSession(T0)).toBeNull();
    // (and one that was never the service's)
    kept.set('konium.library.session', JSON.stringify({ ...me, token: me.token.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }));
    s.clock.now = T0;
    expect(await whoAmI(s.f, T0)).toBeNull();
    expect(keptSession(T0)).toBeNull();
    // (what is kept is read as carefully as what is fetched)
    kept.set('konium.library.session', JSON.stringify({ token: 'x', until: T0 * 2, user: { id: 'k-00000000' } }));
    expect(keptSession(T0)).toBeNull();
  });

  it('with network activity off nothing is asked at all', async () => {
    const s = service();
    await s.signIn('ada@example.org');
    s.calls.length = 0;
    settings.offline = true;
    expect(await libraryConfig(s.f, true)).toBeNull();
    for (const p of [findInLibrary(PART.record.mpn, s.f), askSignIn('ada@example.org', s.f), sessionFor('0'.repeat(32), s.f), publishPart(PART, { agreed: true }, s.f, s.clock.now)]) expect((await refusal(p)).message).toBe(OFFLINE_NOTE);
    expect(s.calls).toEqual([]);
  });

  it('the connection is in the list for whoever has the feature on, and only for them', () => {
    const row = CONNECTIONS.find((c) => c.use === 'library')!;
    expect(row).toMatchObject({ what: 'World parts library', feature: 'partsLibrary' });
    expect(row.to).toMatch(/^konium\.app, then the library's public repository at GitHub \(github\.com\)/);
    expect(row.sends).toMatch(/the part number.*your email address.*never published.*of the datasheet only its link and its fingerprint.*Nothing of your designs/);
    // (outside a browser every feature is on, so the row shows here; in the program it shows from the feature's release on)
    expect(shownConnections()).toContain(row);
    expect(FEATURES.partsLibrary.stage).toBeGreaterThan(STAGE);
  });
});

describe('what comes back from the library is somebody else\'s (26.201)', () => {
  const ENTRY: LibraryEntry = { key: KEY, mpn: PART.record.mpn, status: 'unverified', by: 'k-0123abcd', name: 'Ada', published: '2026-11-20T12:00:00.000Z', revision: 1, licence: LIBRARY_LICENCE, app: '26.201' };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const text = (r: object) => new TextEncoder().encode(JSON.stringify(r));
  const raw = (b: Uint8Array) => new Response(b as Uint8Array<ArrayBuffer>);
  /** A library that answers whatever it is told to. */
  const library = (o: { entry?: unknown; record?: Uint8Array; symbol?: Uint8Array; footprint?: Uint8Array; commit?: string }) => (async (input: RequestInfo | URL) => {
    const path = String(input).replace('https://konium.app/api/library', '').replace(/\?.*$/, '');
    if (path === `/part/${KEY}`) return json({ found: true, entry: o.entry ?? ENTRY, commit: o.commit ?? '' });
    if (path.endsWith('/part.json')) return raw(o.record ?? text(PART.record));
    if (path.endsWith('/symbol.SchLib')) return raw(o.symbol ?? PART.schlib);
    if (path.endsWith('/footprint.PcbLib')) return raw(o.footprint ?? PART.pcblib);
    return json({ error: 'Not here' }, 404);
  }) as typeof fetch;

  it('a good answer is taken, with the library\'s note and not the record\'s own', async () => {
    const boast = { ...PART.record, library: { ...ENTRY, status: 'proven', name: 'Somebody Else' } };
    const found = (await findInLibrary(PART.record.mpn, library({ record: text(boast) })))!;
    expect(found.part.record.library).toEqual(ENTRY);
    expect(found.entry.status).toBe('unverified');
  });

  it('a note about another part, a record of another part, a file that is no library: none is taken', async () => {
    expect((await refusal(findInLibrary(PART.record.mpn, library({ entry: { ...ENTRY, key: 'OTHERKEY', mpn: 'OTHER-KEY' } })))).message).toBe('The library\'s note about that part can\'t be read');
    expect((await refusal(findInLibrary(PART.record.mpn, library({ record: text({ ...PART.record, mpn: 'LM317T' }) })))).message).toMatch(/is of another part number \(LM317T\): not taken/);
    expect((await refusal(findInLibrary(PART.record.mpn, library({ symbol: new Uint8Array(2000) })))).message).toMatch(/can't be read: This part file's symbol or footprint can't be read/);
    expect((await refusal(findInLibrary(PART.record.mpn, library({ record: new TextEncoder().encode('<html>') })))).message).toMatch(/can't be read: Not a part file/);
  });

  it('a file larger than a part\'s file may be is not read to its end', async () => {
    let pulled = 0;
    const endless = () => new Response(new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)); } }));
    const f = (async (input: RequestInfo | URL) => (String(input).includes('/symbol.SchLib') ? endless() : library({})(input))) as typeof fetch;
    expect((await refusal(findInLibrary(PART.record.mpn, f))).message).toBe('The library\'s symbol is too large to be one');
    expect(pulled).toBeLessThan(MAX_SYMBOL / (64 * 1024) + 4);
    const says = (async (input: RequestInfo | URL) => (String(input).includes('/part.json') ? new Response('{}', { headers: { 'Content-Length': '900000' } }) : library({})(input))) as typeof fetch;
    expect((await refusal(findInLibrary(PART.record.mpn, says))).message).toBe('The library\'s record is too large to be one');
  });

  it('the service\'s refusals arrive in its own words, on one line; a site without the service is told apart', async () => {
    const refused = (async () => json({ error: 'That\'s today\'s 500 look-ups\nin the parts library', problems: ['one', 7, 'two'] }, 429)) as typeof fetch;
    const no = await refusal(findInLibrary(PART.record.mpn, refused));
    expect(no).toMatchObject({ message: 'That\'s today\'s 500 look-ups in the parts library', status: 429, problems: ['one', 'two'] });
    const page = (async () => new Response('<html>Not found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })) as typeof fetch;
    expect((await refusal(findInLibrary(PART.record.mpn, page))).message).toBe('The world parts library isn\'t there yet');
    expect(await libraryConfig(page, true)).toBeNull();
    const down = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    expect((await refusal(findInLibrary(PART.record.mpn, down))).message).toBe('The world parts library can\'t be reached');
  });
});
