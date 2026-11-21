/**
 * 26.204 (R21, step 4): a company's own parts library. A domain proved by a record in its DNS,
 * members let in and put out by its administrators, parts that are its members' only, a log of
 * who fetched what, and a sign-in that is asked for again. The app's client is driven against
 * the service's own code; GitHub, the mail and the DNS are stood in for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, orgOpen, type LibraryEnv } from '../cloudflare/library/src/handler';
import { LibraryStoreLogic } from '../cloudflare/library/src/store';
import { OrgStoreLogic } from '../cloudflare/library/src/org';
import { ENV, T0, sqlite, world } from './helpers/libraryWorld';
import { examplePart } from '../src/model/partExample';
import { partKey } from '../src/model/partKey';
import type { PartPackage } from '../src/model/partPackage';
import { atDomain, orgDomain, readEntry } from '../src/model/worldLibrary';
import { LibraryError, askSignIn, findInLibrary, keptSession, publishPart, resetLibraryConfig, sessionFor } from '../src/platform/libraryService';
import { keepOrg, keptOrg, orgAudit, orgClaim, orgDrop, orgFind, orgMember, orgParts, orgPublish, orgStatus } from '../src/platform/orgService';

const PART = examplePart('26.204');
const KEY = partKey(PART.record.mpn);
const DAY = 86_400_000;

function service(more: Partial<LibraryEnv> = {}) {
  const env: LibraryEnv = { ...ENV, ORG_DOMAINS: 'example.com, acme.test', ...more };
  const w = world(), store = new LibraryStoreLogic(sqlite());
  const made = new Map<string, OrgStoreLogic>();
  const orgs = (domain: string) => { let o = made.get(domain); if (!o) made.set(domain, o = new OrgStoreLogic(sqlite())); return o; };
  /** The DNS as the world sees it: a name's TXT records. */
  const dns = new Map<string, string[]>(), lookups: string[] = [];
  const outside = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith('https://cloudflare-dns.com/dns-query?')) return w.fetchFn(input, init);
    const name = new URL(url).searchParams.get('name')!;
    lookups.push(name);
    return new Response(JSON.stringify({ Status: 0, Answer: (dns.get(name) ?? []).map((t) => ({ name, type: 16, data: `"${t}"` })) }), { headers: { 'Content-Type': 'application/dns-json' } });
  }) as typeof fetch;
  const clock = { now: T0 };
  const lines: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), headers = (init?.headers ?? {}) as Record<string, string>;
    lines.push(`${init?.method ?? 'GET'} ${url.replace('https://konium.app/api/library', '')}`);
    return handle(new Request(url, { ...init, headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers } }), env, store, outside, clock.now, orgs);
  }) as typeof fetch;
  const as = async (email: string) => {
    clock.now += 3_600_000;
    const { ticket } = await askSignIn(email, f);
    const link = /confirm\?id=([0-9a-f]{32})&code=([0-9a-f]{40})/.exec(w.mails.at(-1)!.text)!;
    await handle(new Request('https://konium.app/api/library/confirm', { method: 'POST', body: new URLSearchParams({ id: link[1]!, code: link[2]! }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env, store, outside, clock.now, orgs);
    const s = await sessionFor(ticket, f, clock.now);
    if (s === 'pending') throw new Error('still pending');
    return s.user.id;
  };
  /** A company's library opened by its domain's record, as whoever is signed in. */
  const open = async (domain: string) => {
    const st = await orgStatus(domain, f, clock.now);
    dns.set(st.record!.name, [st.record!.value]);
    return orgClaim(domain, f, clock.now);
  };
  const t = () => clock.now;
  return { env, w, f, lines, dns, lookups, clock, as, open, t, made };
}

let kept: Map<string, string>;
beforeEach(() => {
  kept = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
  resetLibraryConfig();
});
afterEach(() => { vi.unstubAllGlobals(); });
const refusal = async (p: Promise<unknown>): Promise<LibraryError> => { try { await p; } catch (e) { return e as LibraryError; } throw new Error('it was not refused'); };

describe('a company\'s domain (26.204)', () => {
  it('is a host\'s name and nothing else; an address is at it or at a part of it', () => {
    expect(['Example.COM.', ' eng.example.co.uk ', 'example', 'exa mple.com', '10.0.0.1', 'example.com/x', '-a.com', 'a..com', ''].map(orgDomain)).toEqual(['example.com', 'eng.example.co.uk', '', '', '', '', '', '', '']);
    expect([atDomain('ada@example.com', 'example.com'), atDomain('ada@eng.example.com', 'example.com'), atDomain('ada@notacme.test', 'acme.test'), atDomain('ada@acme.test.evil.example', 'acme.test'), atDomain('ada@example.com', '')]).toEqual([true, true, false, false, false]);
    expect(readEntry({ key: KEY, mpn: PART.record.mpn, org: 'Example.com', licence: 'private' })).toMatchObject({ org: 'example.com', licence: 'private' });
    expect(readEntry({ key: KEY, mpn: PART.record.mpn, org: 'not a domain' })!.org).toBeUndefined();
    expect([orgOpen(ENV, 'example.com'), orgOpen({ ...ENV, ORG_DOMAINS: '*' }, 'example.com'), orgOpen({ ...ENV, ORG_DOMAINS: 'acme.test,example.com' }, 'example.com'), orgOpen({ ...ENV, ORG_DOMAINS: 'acme.test' }, 'example.com')]).toEqual([false, true, true, false]);
    keepOrg(' Example.com ');
    expect(keptOrg()).toBe('example.com');
  });
});

describe('a company\'s own library, through the service (26.204)', () => {
  it('is opened by a record in the domain\'s DNS, by somebody with an address at the domain', async () => {
    const s = service();
    await s.as('ada@example.com');
    const st = await orgStatus('example.com', s.f, s.t());
    expect(st).toEqual({ domain: 'example.com', open: true, exists: false, role: null, record: { name: '_konium.example.com', value: expect.stringMatching(/^konium-library=[0-9a-f]{32}$/) } });
    // Not in the DNS yet; then a record that is not the one; then the one
    expect(await refusal(orgClaim('example.com', s.f, s.t()))).toMatchObject({ status: 409, message: 'The record isn\'t in example.com\'s DNS yet (a new record can take some minutes to be seen)' });
    s.dns.set('_konium.example.com', ['v=spf1 -all', 'konium-library=0123456789abcdef0123456789abcdef']);
    expect((await refusal(orgClaim('example.com', s.f, s.t()))).status).toBe(409);
    s.dns.set('_konium.example.com', ['v=spf1 -all', st.record!.value]);
    expect(await orgClaim('example.com', s.f, s.t())).toBe('opened');
    expect(s.lookups).toEqual(['_konium.example.com', '_konium.example.com', '_konium.example.com']);
    expect(await orgStatus('example.com', s.f, s.t())).toEqual({ domain: 'example.com', open: true, exists: true, role: 'admin', record: st.record, parts: 0, allowance: 200,
      members: [{ email: 'ada@example.com', role: 'admin', since: expect.stringMatching(/^2026-/), seen: expect.stringMatching(/^2026-/), by: 'the domain\'s record' }] });
    expect(await orgClaim('example.com', s.f, s.t())).toBe('was');
    // Somebody with no address at the domain: the library looks as if it were not there, and is not theirs to open
    await s.as('mallory@elsewhere.example');
    expect(await orgStatus('example.com', s.f, s.t())).toEqual({ domain: 'example.com', open: true, exists: false, role: null });
    expect(await refusal(orgClaim('example.com', s.f, s.t()))).toMatchObject({ status: 403, message: 'A library for example.com is opened by somebody with an address at example.com' });
    // A domain the service's owner has not opened one for: not even with its record in place
    expect(await orgStatus('elsewhere.example', s.f, s.t())).toEqual({ domain: 'elsewhere.example', open: false, exists: false, role: null });
    expect(await refusal(orgClaim('elsewhere.example', s.f, s.t()))).toMatchObject({ status: 403, message: 'Company libraries aren\'t open for elsewhere.example: ask Konium Designer\'s author' });
    expect((await refusal(orgStatus('not a domain', s.f, s.t()))).message).toBe('Name the company\'s domain (example.com)');
  });

  it('members are let in and put out by its administrators; whoever is put out has nothing of it from that moment', async () => {
    const s = service();
    await s.as('ada@example.com');
    await s.open('example.com');
    const mails = s.w.mails.length;
    const let1 = await orgMember('example.com', ' Bob@Example.com ', {}, s.f, s.t());
    expect(let1).toMatchObject({ added: true, mailed: true });
    expect(let1.members.map((m) => [m.email, m.role, m.by])).toEqual([['ada@example.com', 'admin', 'the domain\'s record'], ['bob@example.com', 'member', 'ada@example.com']]);
    expect(s.w.mails).toHaveLength(mails + 1);
    expect(s.w.mails.at(-1)).toMatchObject({ to: ['bob@example.com'], subject: 'You have been let in to example.com\'s parts library' });
    expect(s.w.mails.at(-1)!.text).toMatch(/ada@example\.com has let you in to example\.com's parts library/);
    // (somebody from outside the company, by the administrator's own choice: a contractor)
    await orgMember('example.com', 'carol@contractor.example', {}, s.f, s.t());
    const entry = await orgPublish('example.com', PART, { name: 'Ada L.', app: '26.204' }, s.f, s.t());
    expect(entry).toMatchObject({ key: KEY, mpn: PART.record.mpn, org: 'example.com', licence: 'private', revision: 1, name: 'Ada L.', by: expect.stringMatching(/^k-[0-9a-f]{8}$/) });

    // A member: sees the library and its parts, runs nothing
    await s.as('bob@example.com');
    expect(await orgStatus('example.com', s.f, s.t())).toEqual({ domain: 'example.com', open: true, exists: true, role: 'member', parts: 1, allowance: 200 });
    expect(await refusal(orgMember('example.com', 'dave@example.com', {}, s.f, s.t()))).toMatchObject({ status: 403 });
    expect(await refusal(orgAudit('example.com', s.f, s.t()))).toMatchObject({ status: 403 });
    expect((await orgParts('example.com', s.f, s.t())).map((p) => [p.mpn, p.maker, p.package, p.pins, p.revision, p.name])).toEqual([[PART.record.mpn, PART.record.maker, 'SO-8', 8, 1, 'Ada L.']]);
    const found = (await orgFind('example.com', PART.record.mpn, s.f, s.t()))!;
    expect(found.entry).toEqual(entry);
    expect(found.part.record.library).toEqual(entry);
    expect([...found.part.schlib]).toEqual([...PART.schlib]);
    expect([...found.part.pcblib]).toEqual([...PART.pcblib]);
    expect(found.checks.some((c) => c.level === 'error')).toBe(false);
    expect(await orgFind('example.com', 'NOSUCH-PART-1', s.f, s.t())).toBeNull();
    await s.as('carol@contractor.example');
    expect((await orgStatus('example.com', s.f, s.t())).role).toBe('member');
    expect((await orgFind('example.com', PART.record.mpn, s.f, s.t()))!.entry.revision).toBe(1);

    // Put out: nothing from this moment, with the sign-in they still hold
    await s.as('ada@example.com');
    expect((await orgMember('example.com', 'bob@example.com', { remove: true }, s.f, s.t())).removed).toBe(true);
    await s.as('bob@example.com');
    // (each asked when its turn comes: a refusal nobody is waiting for yet would be an error of its own)
    for (const ask of [() => orgFind('example.com', PART.record.mpn, s.f, s.t()), () => orgParts('example.com', s.f, s.t()), () => orgPublish('example.com', PART, {}, s.f, s.t())]) expect(await refusal(ask())).toMatchObject({ status: 403, message: 'You are not a member of example.com\'s library' });
    expect(await orgStatus('example.com', s.f, s.t())).toMatchObject({ exists: true, role: null });

    // A library keeps an administrator; a second one can be made, and then the first may go
    await s.as('ada@example.com');
    for (const o of [{ remove: true }, { role: 'member' as const }]) expect(await refusal(orgMember('example.com', 'ada@example.com', o, s.f, s.t()))).toMatchObject({ status: 409, message: 'A library keeps one administrator at least: make somebody else one first' });
    await orgMember('example.com', 'carol@contractor.example', { role: 'admin' }, s.f, s.t());
    expect((await orgMember('example.com', 'ada@example.com', { remove: true }, s.f, s.t())).members.map((m) => [m.email, m.role])).toEqual([['carol@contractor.example', 'admin']]);
  });

  it('whoever holds the domain takes its library back; the log says so', async () => {
    const s = service();
    await s.as('ada@example.com');
    await s.open('example.com');
    await orgPublish('example.com', PART, {}, s.f, s.t());
    // Ada has left and nobody else runs the library: somebody at the company puts the record in the DNS again (it is the same for the domain)
    await s.as('eve@example.com');
    expect((await orgStatus('example.com', s.f, s.t())).record!.value).toBe(s.dns.get('_konium.example.com')![0]);
    expect(await orgClaim('example.com', s.f, s.t())).toBe('claimed');
    expect((await orgMember('example.com', 'ada@example.com', { remove: true }, s.f, s.t())).removed).toBe(true);
    await orgFind('example.com', PART.record.mpn, s.f, s.t());
    expect((await orgAudit('example.com', s.f, s.t())).map((e) => `${e.who} ${e.what} ${e.about}`.trim())).toEqual([
      `eve@example.com fetched ${PART.record.mpn}`, 'eve@example.com put out ada@example.com', 'eve@example.com took the library over by the domain\'s record',
      `ada@example.com published ${PART.record.mpn}`, 'ada@example.com opened the library by the domain\'s record',
    ]);
  });

  it('asks for a new sign-in every thirty days: a mailbox that is closed loses the library with it', async () => {
    const s = service();
    await s.as('ada@example.com');
    await s.open('example.com');
    s.clock.now += 29 * DAY;
    expect(await orgParts('example.com', s.f, s.t())).toEqual([]);
    s.clock.now += 2 * DAY;
    expect(await refusal(orgParts('example.com', s.f, s.t()))).toMatchObject({ status: 401, message: 'example.com\'s library asks for a new sign-in every 30 days: sign in again' });
    // (the app forgets the sign-in it had, and the next one is made by the mailbox's holder)
    expect(keptSession(s.t())).toBeNull();
    await s.as('ada@example.com');
    expect(await orgParts('example.com', s.f, s.t())).toEqual([]);
    // (shorter where the service says so)
    const short = service({ ORG_SESSION_DAYS: '7' });
    await short.as('ada@example.com');
    await short.open('example.com');
    short.clock.now += 8 * DAY;
    expect((await refusal(orgParts('example.com', short.f, short.t()))).message).toMatch(/every 7 days/);
  });

  it('its parts are in no public repository; published again as revisions; taken out by their publisher or an administrator; as many as the library may hold', async () => {
    const s = service({ ORG_PARTS: '1' });
    await s.as('ada@example.com');
    await s.open('example.com');
    await orgMember('example.com', 'bob@example.com', {}, s.f, s.t());
    await orgMember('example.com', 'dan@example.com', {}, s.f, s.t());
    await s.as('bob@example.com');
    const commits = s.w.commits.size, calls = s.w.calls.length;
    expect((await orgPublish('example.com', PART, {}, s.f, s.t())).revision).toBe(1);
    expect((await orgPublish('example.com', PART, {}, s.f, s.t())).revision).toBe(2);
    expect([s.w.commits.size, s.w.calls.length]).toEqual([commits, calls]);          // (GitHub was not spoken to at all)
    expect(await findInLibrary(PART.record.mpn, s.f)).toBeNull();                  // (and the world library has none of it)
    const other: PartPackage = { ...PART, record: { ...PART.record, mpn: 'KD-EX1833-SO8-B' } };
    expect(await refusal(orgPublish('example.com', other, {}, s.f, s.t()))).toMatchObject({ status: 409, message: 'example.com\'s library is full (1 parts): take one out, or ask for more room' });
    expect(await refusal(orgPublish('example.com', { ...PART, record: { ...PART.record, maker: '' } }, {}, s.f, s.t()))).toMatchObject({ problems: ['It names no manufacturer'] });
    // (what is sent must be libraries: a client that sends something else is told so)
    const raw = (body: object) => s.f('https://konium.app/api/library/org/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keptSession(s.t())!.token}` }, body: JSON.stringify(body) });
    expect((await raw({ domain: 'example.com', record: PART.record, symbol: 'PGh0bWw+', footprint: 'PGh0bWw+' })).status).toBe(400);
    expect((await raw({ domain: 'example.com', record: PART.record, symbol: '0M8R4KGxGuE"},{"x":"', footprint: '0M8R4KGxGuE=' })).status).toBe(400);
    // Another member may not take it out; its publisher may, and so may an administrator
    await s.as('dan@example.com');
    expect(await refusal(orgDrop('example.com', KEY, s.f, s.t()))).toMatchObject({ status: 403 });
    await s.as('ada@example.com');
    await orgDrop('example.com', KEY, s.f, s.t());
    expect(await orgFind('example.com', PART.record.mpn, s.f, s.t())).toBeNull();
    expect((await refusal(orgDrop('example.com', KEY, s.f, s.t()))).status).toBe(404);
    expect((await orgPublish('example.com', other, {}, s.f, s.t())).revision).toBe(1);
    // The same part may be in the world library too, by its author's own choice: the two know nothing of each other
    expect((await publishPart(other, { agreed: true }, s.f, s.t())).entry.org).toBeUndefined();
  });

  it('one company\'s library is not another\'s', async () => {
    const s = service();
    await s.as('zed@acme.test');
    await s.open('acme.test');
    await orgPublish('acme.test', PART, {}, s.f, s.t());
    await s.as('ada@example.com');
    await s.open('example.com');
    expect(s.made.size).toBe(2);
    expect(await orgParts('example.com', s.f, s.t())).toEqual([]);
    expect(await orgFind('example.com', PART.record.mpn, s.f, s.t())).toBeNull();
    expect(await orgStatus('acme.test', s.f, s.t())).toEqual({ domain: 'acme.test', open: true, exists: false, role: null });
    for (const ask of [() => orgParts('acme.test', s.f, s.t()), () => orgFind('acme.test', PART.record.mpn, s.f, s.t()), () => orgAudit('acme.test', s.f, s.t()), () => orgMember('acme.test', 'ada@example.com', {}, s.f, s.t()), () => orgDrop('acme.test', KEY, s.f, s.t())]) expect((await refusal(ask())).status).toBe(403);
    // (without the store for companies the service says that there are none)
    const none = await handle(new Request('https://konium.app/api/library/org?domain=example.com', { headers: { Authorization: `Bearer ${keptSession(s.t())!.token}` } }), s.env, new LibraryStoreLogic(sqlite()), s.w.fetchFn, s.t());
    expect(none.status).toBe(503);
  });
});
