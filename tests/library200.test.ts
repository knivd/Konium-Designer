/**
 * 26.200 (R21, step 2 in the making): the world parts library's service (cloudflare/library) and
 * what it shares with the app (src/model/worldLibrary.ts). GitHub and the mail are stand-ins here:
 * the real ones can't be reached from the tests.
 */
import { describe, expect, it } from 'vitest';
import { PASS_MS, SESSION_MS, SIGNIN_MS, byOf, handle, uidOf } from '../cloudflare/library/src/handler';
import { LibraryStoreLogic } from '../cloudflare/library/src/store';
import { ENV, T0, b64, sqlite, world } from './helpers/libraryWorld';
import { examplePart } from '../src/model/partExample';
import { partKey } from '../src/model/partKey';
import { readPartPieces, partFile, readPartFile } from '../src/model/partPackage';
import { CONTRIBUTOR, KEY_FORMAT, LIBRARY_LICENCE, cleanRecord, mailAddress, partFolder, readEntry, recordProblems, shownName, type LibraryEntry } from '../src/model/worldLibrary';

const at = (path: string, init: RequestInit & { ip?: string; token?: string } = {}) => new Request(`https://konium.app/api/library${path}`, {
  ...init, headers: { 'CF-Connecting-IP': init.ip ?? '203.0.113.7', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
});
const post = (path: string, body: unknown, o: { ip?: string; token?: string } = {}) => at(path, { method: 'POST', body: JSON.stringify(body), ...o });

/** A whole sign-in, as the app and a person with the mail would do it: the session's token. */
async function signIn(w: ReturnType<typeof world>, store: LibraryStoreLogic, email: string, now = T0, ip = '203.0.113.7'): Promise<{ token: string; user: { id: string; name: string; email: string } }> {
  const asked = await (await handle(post('/signin', { email }, { ip }), ENV, store, w.fetchFn, now)).json() as { ticket: string };
  const link = /https:\/\/konium\.app\/api\/library\/confirm\?id=([0-9a-f]{32})&code=([0-9a-f]{40})/.exec(w.mails.at(-1)!.text)!;
  await handle(new Request('https://konium.app/api/library/confirm', { method: 'POST', body: new URLSearchParams({ id: link[1]!, code: link[2]! }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), ENV, store, w.fetchFn, now + 1000);
  return (await handle(post('/session', { ticket: asked.ticket }), ENV, store, w.fetchFn, now + 2000)).json() as Promise<{ token: string; user: { id: string; name: string; email: string } }>;
}

const PART = examplePart('26.200');
const blobBody = (bytes: Uint8Array) => JSON.stringify({ content: b64(bytes), encoding: 'base64' });
async function sendBlobs(w: ReturnType<typeof world>, store: LibraryStoreLogic, token: string, now = T0 + 5000) {
  const send = async (kind: string, bytes: Uint8Array) => (await handle(at(`/blob?kind=${kind}`, { method: 'POST', body: blobBody(bytes), token, headers: { 'Content-Type': 'application/json' } }), ENV, store, w.fetchFn, now)).json() as Promise<{ sha: string; pass: string }>;
  return { symbol: await send('symbol', PART.schlib), footprint: await send('footprint', PART.pcblib) };
}

describe('what the app and the library agree on (26.200)', () => {
  it('a part\'s place in the repository, a contributor\'s number, a shown name, an address', () => {
    expect(partKey('PIC18F06Q41-E/ST')).toBe('PIC18F06Q41EST');
    expect(partFolder('PIC18F06Q41EST')).toBe('parts/PI/PIC18F06Q41EST');
    expect(KEY_FORMAT.test('AB')).toBe(false);
    expect(KEY_FORMAT.test('../../ETC')).toBe(false);
    expect(CONTRIBUTOR.test('k-0123abcd')).toBe(true);
    expect(shownName('  Ada   <script>Lovelace</script>  ')).toBe('Ada scriptLovelacescript');
    expect(shownName('x'.repeat(60))).toHaveLength(40);
    expect(shownName(7)).toBe('');
    expect(mailAddress(' Ada@Example.ORG ')).toBe('ada@example.org');
    for (const bad of ['ada', 'ada@', 'ada@localhost', 'a b@example.org', 'ada@example.org\nBcc: x@y.z', 'ada@exa mple.org', `${'a'.repeat(250)}@example.org`, 7]) expect(mailAddress(bad), String(bad)).toBe('');
  });

  it('a record is checked as text: the example part has no problems; each thing wrong is said', () => {
    expect(recordProblems(PART.record)).toEqual([]);
    expect(recordProblems(null)).toContain('It is not a part record');
    expect(recordProblems({ ...PART.record, mpn: 'A?' })).toEqual(['Its part number must have three letters or digits at least, and 80 characters at most']);
    expect(recordProblems({ ...PART.record, maker: ' ' })).toEqual(['It names no manufacturer']);
    expect(recordProblems({ ...PART.record, pins: [] })).toEqual(['It lists no pins']);
    expect(recordProblems({ ...PART.record, pins: [{ number: '', name: 'A', type: '' }] })).toEqual(['One of its pins has no number, or a name too long']);
    expect(recordProblems({ ...PART.record, datasheet: { ...PART.record.datasheet, url: 'javascript:alert(1)' } })).toEqual(['Its datasheet\'s link is not a web address']);
    expect(recordProblems({ ...PART.record, datasheet: { ...PART.record.datasheet, url: 'https://example.org/a b' } })).toEqual(['Its datasheet\'s link is not a web address']);
    expect(recordProblems({ ...PART.record, package: { ...PART.record.package, from: 'guessed' } })).toEqual(['It doesn\'t say where its footprint came from']);
  });

  it('the record the library keeps has a part record\'s fields and nothing more', () => {
    const sent = { ...PART.record, library: { key: 'X' }, extra: 'x'.repeat(5000), package: { ...PART.record.package, more: 1 } };
    const kept = cleanRecord(sent) as unknown as Record<string, unknown>;
    expect(Object.keys(kept).sort()).toEqual(['datasheet', 'description', 'device', 'format', 'made', 'maker', 'mpn', 'package', 'pins', 'symbol']);
    expect(Object.keys(kept.package as object).sort()).toEqual(['footprint', 'from', 'name', 'pins']);
    expect(kept.mpn).toBe(PART.record.mpn);
    expect(kept.pins).toEqual(PART.record.pins);
  });

  it('the library\'s note about a part is read with care; a part keeps it in its file', () => {
    const e: LibraryEntry = { key: 'KDEX1833SO8', mpn: 'KD-EX1833-SO8', status: 'unverified', by: 'k-0123abcd', name: 'Ada', published: '2026-11-20T12:00:00.000Z', revision: 2, licence: LIBRARY_LICENCE, app: '26.200' };
    expect(readEntry(e)).toEqual(e);
    expect(readEntry({ ...e, key: 'OTHER' })).toBeNull();
    expect(readEntry({ ...e, status: 'blessed', by: 'root', revision: -3 })).toMatchObject({ status: 'unverified', by: '', revision: 1 });
    expect(readEntry('x')).toBeNull();
    // In a part file the note travels with the record, and only when it is this part's
    const mine = readPartFile(partFile({ ...PART, record: { ...PART.record, library: e } }));
    expect(mine.record.library).toEqual(e);
    const other = readPartFile(partFile({ ...PART, record: { ...PART.record, library: { ...e, key: 'ABC123', mpn: 'ABC-123' } } }));
    expect(other.record.library).toBeUndefined();
    // …and a part is read from its three pieces as from its one file
    const pieces = readPartPieces(new TextEncoder().encode(JSON.stringify(PART.record)), PART.schlib, PART.pcblib);
    expect(pieces.record).toEqual(readPartFile(partFile(PART)).record);
  });
});

describe('the world parts library\'s service (26.200)', () => {
  it('says whether it is set up; without its secrets nothing else answers', async () => {
    const w = world(), store = new LibraryStoreLogic(sqlite());
    expect(await (await handle(at('/config'), ENV, store, w.fetchFn, T0)).json()).toEqual({ ready: true, signIn: true, repo: 'o/parts', web: 'https://github.com/o/parts', licence: 'CC0-1.0', publishPerDay: 20, parts: 0 });
    expect(await (await handle(at('/config'), { ...ENV, RESEND_KEY: undefined }, store, w.fetchFn, T0)).json()).toMatchObject({ ready: true, signIn: false });
    const bare = await handle(at('/config'), { LIBRARY_REPO: 'o/parts' }, store, w.fetchFn, T0);
    expect(await bare.json()).toMatchObject({ ready: false, signIn: false, parts: 0 });
    expect((await handle(at('/part/KDEX1833SO8'), { LIBRARY_REPO: 'o/parts' }, store, w.fetchFn, T0)).status).toBe(503);
    expect((await handle(at('/config', { method: 'OPTIONS' }), ENV, store, w.fetchFn, T0)).headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization');
    expect((await handle(at('/nowhere'), ENV, store, w.fetchFn, T0)).status).toBe(404);
  });

  it('signs in by a mailed link that only a press confirms; the ticket is good once', async () => {
    const w = world(), store = new LibraryStoreLogic(sqlite());
    expect((await handle(post('/signin', { email: 'not an address' }), ENV, store, w.fetchFn, T0)).status).toBe(400);
    const res = await handle(post('/signin', { email: ' Ada@Example.org ' }), ENV, store, w.fetchFn, T0);
    const { ticket, minutes } = await res.json() as { ticket: string; minutes: number };
    expect(ticket).toMatch(/^[0-9a-f]{32}$/);
    expect(minutes).toBe(SIGNIN_MS / 60_000);
    expect(w.mails).toHaveLength(1);
    expect(w.mails[0]).toMatchObject({ to: ['ada@example.org'], from: 'Konium parts library <library@konium.app>', subject: 'Your sign-in link for the Konium parts library' });
    const link = /https:\/\/konium\.app\/api\/library\/confirm\?id=([0-9a-f]{32})&code=([0-9a-f]{40})/.exec(w.mails[0]!.text)!;
    expect(link[1]).toBe(ticket);
    // Until confirmed the app is told to wait
    expect(await (await handle(post('/session', { ticket }), ENV, store, w.fetchFn, T0 + 500)).json()).toEqual({ pending: true });
    // The link itself (a mail scanner follows it) signs nobody in: it shows a page with a button
    const shown = await handle(new Request(`https://konium.app/api/library/confirm?id=${link[1]}&code=${link[2]}`), ENV, store, w.fetchFn, T0 + 600);
    const page = await shown.text();
    expect(shown.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(shown.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(shown.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(page).toContain('<form method="post" action="/api/library/confirm">');
    expect(page).toContain('Confirm My Sign-In');
    expect(await (await handle(post('/session', { ticket }), ENV, store, w.fetchFn, T0 + 700)).json()).toEqual({ pending: true });
    // A wrong code, or the right one too late: the same page saying the link is no longer good
    const form = (id: string, code: string, now: number) => handle(new Request('https://konium.app/api/library/confirm', { method: 'POST', body: new URLSearchParams({ id, code }).toString() }), ENV, store, w.fetchFn, now);
    expect((await form(link[1]!, '0'.repeat(40), T0 + 800)).status).toBe(410);
    expect((await form(link[1]!, link[2]!, T0 + SIGNIN_MS + 1)).status).toBe(410);
    expect(await (await handle(post('/session', { ticket }), ENV, store, w.fetchFn, T0 + 900)).json()).toEqual({ pending: true });
    // The press
    const done = await form(link[1]!, link[2]!, T0 + 1000);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('You are signed in');
    const session = await (await handle(post('/session', { ticket }), ENV, store, w.fetchFn, T0 + 2000)).json() as { token: string; until: number; user: { id: string; name: string; email: string } };
    expect(session.until).toBe(T0 + 2000 + SESSION_MS);
    expect(session.user).toEqual({ id: byOf(await uidOf(ENV, 'ada@example.org')), name: '', email: 'ada@example.org' });
    expect(session.user.id).toMatch(CONTRIBUTOR);
    expect(session.token).toMatch(/^[0-9a-f]{16}\.\d+\.[0-9a-f]{64}$/);
    // The ticket is spent
    expect((await handle(post('/session', { ticket }), ENV, store, w.fetchFn, T0 + 3000)).status).toBe(410);
    // The session: good as it is, not when altered, not once it is over, not under another secret
    const me = (token: string, now = T0 + 4000, env = ENV) => handle(at('/me', { token }), env, store, w.fetchFn, now);
    expect(await (await me(session.token)).json()).toEqual({ user: session.user });
    expect((await me(session.token.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).status).toBe(401);
    const [uid, until, sig] = session.token.split('.');
    expect((await me(`${uid}.${Number(until) + 1}.${sig}`)).status).toBe(401);
    expect((await me(session.token, T0 + 2000 + SESSION_MS + 1)).status).toBe(401);
    expect((await me(session.token, T0 + 4000, { ...ENV, LIBRARY_SECRET: 'another' })).status).toBe(401);
    expect((await handle(at('/me'), ENV, store, w.fetchFn, T0)).status).toBe(401);
  });

  it('limits the sign-in mails: from one place, and to one address', async () => {
    const w = world(), store = new LibraryStoreLogic(sqlite());
    const ask = async (email: string, ip: string, now = T0) => (await handle(post('/signin', { email }, { ip }), ENV, store, w.fetchFn, now)).status;
    // Five an hour from one address of the network…
    for (let k = 0; k < 5; k++) expect(await ask(`a${k}@example.org`, '203.0.113.9')).toBe(200);
    expect(await ask('a9@example.org', '203.0.113.9')).toBe(429);
    // …an IPv6 subscriber counts as one, whatever address in their /64 they use
    for (let k = 0; k < 5; k++) expect(await ask(`b${k}@example.org`, `2001:db8:1:2::${k + 1}`)).toBe(200);
    expect(await ask('b9@example.org', '2001:db8:1:2:ffff::1')).toBe(429);
    // …and three an hour to one address, wherever they are asked from
    for (let k = 0; k < 3; k++) expect(await ask('victim@example.org', `198.51.100.${k + 1}`)).toBe(200);
    expect(await ask('Victim@Example.org', '198.51.100.77')).toBe(429);
    expect(w.mails.filter((m) => m.to[0] === 'victim@example.org')).toHaveLength(3);
    // The next hour they may again
    expect(await ask('victim@example.org', '198.51.100.77', T0 + 3_600_000)).toBe(200);
    // A mail that can't be sent is said, and leaves no sign-in behind
    w.state.mailFails = true;
    const failed = await handle(post('/signin', { email: 'c@example.org' }, { ip: '192.0.2.1' }), ENV, store, w.fetchFn, T0);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: 'The sign-in link couldn\'t be sent: try again shortly' });
  });

  it('takes a part\'s two libraries as they come, when they are compound files of a size it allows', async () => {
    const w = world(), store = new LibraryStoreLogic(sqlite());
    const { token } = await signIn(w, store, 'ada@example.org');
    const send = (kind: string, body: string, t: string | undefined = token) => handle(at(`/blob?kind=${kind}`, { method: 'POST', body, token: t, headers: { 'Content-Type': 'application/json' } }), ENV, store, w.fetchFn, T0 + 5000);
    expect((await send('symbol', blobBody(PART.schlib), '')).status).toBe(401);
    expect((await send('datasheet', blobBody(PART.schlib))).status).toBe(400);
    expect(await (await send('symbol', JSON.stringify({ content: b64(new TextEncoder().encode('<html>not a library</html>')), encoding: 'base64' }))).json()).toEqual({ error: 'That is not a symbol\'s library' });
    expect((await send('symbol', `{"content":"0M8R4KGxGuE","encoding":"base64","extra":1}`)).status).toBe(400);
    expect((await send('symbol', blobBody(new Uint8Array(401 * 1024).fill(1)))).status).toBe(413);
    const before = w.blobs.size;
    const ok = await (await send('symbol', blobBody(PART.schlib))).json() as { sha: string; pass: string };
    expect(ok.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(ok.pass).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(Number(ok.pass.split('.')[0])).toBe(T0 + 5000 + PASS_MS);
    expect(w.blobs.size).toBe(before + 1);
    // What GitHub got is what was sent, to the byte
    expect(w.blobs.get(ok.sha)).toBe(b64(PART.schlib));
  });

  it('publishes a part as one commit of four files, unverified, under its contributor\'s number; then anyone fetches it', async () => {
    const w = world(), store = new LibraryStoreLogic(sqlite());
    const { token, user } = await signIn(w, store, 'ada@example.org');
    const blobs = await sendBlobs(w, store, token);
    const publish = (body: Record<string, unknown>, t = token, now = T0 + 6000) => handle(post('/publish', body, { token: t }), ENV, store, w.fetchFn, now);
    const good = { record: PART.record, ...blobs, licence: 'CC0-1.0', name: 'Ada L.', app: '26.200' };
    // Refused: no sign-in; a record with something wrong; no licence given; a pass that isn't this file's
    expect((await publish(good, '')).status).toBe(401);
    expect(await (await publish({ ...good, record: { ...PART.record, maker: '' } })).json()).toEqual({ error: 'This part can\'t be published as it is', problems: ['It names no manufacturer'] });
    expect(await (await publish({ ...good, licence: 'MIT' })).json()).toEqual({ error: 'The parts library takes parts given to the public domain (CC0 1.0) only' });
    expect((await publish({ ...good, symbol: blobs.footprint })).status).toBe(400);
    expect((await publish({ ...good, symbol: { sha: blobs.symbol.sha, pass: blobs.symbol.pass.replace(/.$/, (c) => (c === '0' ? '1' : '0')) } })).status).toBe(400);
    expect((await publish(good, token, T0 + 5000 + PASS_MS + 1)).status).toBe(400);
    expect(w.commits.size).toBe(1);

    const res = await publish(good);
    const out = await res.json() as { ok: boolean; entry: LibraryEntry; commit: string; url: string };
    expect(res.status).toBe(200);
    expect(out.entry).toEqual({ key: 'KDEX1833SO8', mpn: 'KD-EX1833-SO8', status: 'unverified', by: user.id, name: 'Ada L.', published: new Date(T0 + 6000).toISOString(), revision: 1, licence: 'CC0-1.0', app: '26.200' });
    expect(out.url).toBe('https://github.com/o/parts/tree/main/parts/KD/KDEX1833SO8');
    expect(out.commit).toBe(w.head());
    const commit = w.commits.get(out.commit)!;
    expect(commit.message.split('\n')[0]).toBe('Add KD-EX1833-SO8 (Konium (example); SO-8, 8 pins)');
    expect(commit.message).toContain(`by Ada L. (${user.id}), under CC0-1.0.`);
    // The address is nowhere in what is published
    expect(commit.author).toEqual({ name: 'Ada L.', email: `${user.id}@parts.konium.app`, date: new Date(T0 + 6000).toISOString() });
    const files = w.filesAt(out.commit);
    expect(Object.keys(files).sort()).toEqual(['footprint.PcbLib', 'library.json', 'part.json', 'symbol.SchLib'].map((f) => `parts/KD/KDEX1833SO8/${f}`));
    expect(JSON.stringify([commit, files])).not.toContain('ada@example.org');
    expect(JSON.parse(files['parts/KD/KDEX1833SO8/part.json']!)).toEqual(cleanRecord(PART.record));
    expect(JSON.parse(files['parts/KD/KDEX1833SO8/library.json']!)).toEqual(out.entry);
    expect(files['parts/KD/KDEX1833SO8/symbol.SchLib']).toBe(blobs.symbol.sha);

    // Fetching: no sign-in; the note first, then the three files as the repository has them, at that commit
    const found = await (await handle(at('/part/KDEX1833SO8', { ip: '198.51.100.20' }), ENV, store, w.fetchFn, T0 + 7000)).json() as { found: boolean; entry: LibraryEntry; commit: string };
    expect(found).toEqual({ found: true, entry: out.entry, commit: out.commit });
    const file = async (name: string) => handle(at(`/part/KDEX1833SO8/${name}?c=${out.commit}`), ENV, store, w.fetchFn, T0 + 7000);
    const record = await file('part.json'), sym = await file('symbol.SchLib'), fp = await file('footprint.PcbLib');
    expect(record.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(record.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const got = readPartPieces(new Uint8Array(await record.arrayBuffer()), new Uint8Array(await sym.arrayBuffer()), new Uint8Array(await fp.arrayBuffer()));
    expect(got.record).toEqual(cleanRecord(PART.record));
    expect([...got.schlib]).toEqual([...PART.schlib]);
    expect([...got.pcblib]).toEqual([...PART.pcblib]);
    expect((await file('library.json')).status).toBe(404);
    expect((await handle(at('/part/KDEX1833SO8/..%2F..%2FREADME.md'), ENV, store, w.fetchFn, T0)).status).toBe(404);
    expect((await handle(at('/part/ab'), ENV, store, w.fetchFn, T0)).status).toBe(400);
    expect(await (await handle(at('/part/NOSUCHPART1'), ENV, store, w.fetchFn, T0)).json()).toEqual({ found: false });
    expect(await (await handle(at('/config'), ENV, store, w.fetchFn, T0)).json()).toMatchObject({ parts: 1 });
  });

  it('a part there already: its own publisher may correct it while it is unverified; nobody else may', async () => {
    const w = world(), store = new LibraryStoreLogic(sqlite());
    const ada = await signIn(w, store, 'ada@example.org');
    const first = await sendBlobs(w, store, ada.token);
    const body = (blobs: typeof first, name?: string) => ({ record: PART.record, ...blobs, licence: 'CC0-1.0', app: '26.200', ...(name === undefined ? {} : { name }) });
    await handle(post('/publish', body(first, 'Ada'), { token: ada.token }), ENV, store, w.fetchFn, T0 + 6000);
    // Someone else
    const bob = await signIn(w, store, 'bob@example.org', T0 + 10_000, '198.51.100.3');
    const theirs = await sendBlobs(w, store, bob.token, T0 + 13_000);
    const refused = await handle(post('/publish', body(theirs, 'Bob'), { token: bob.token }), ENV, store, w.fetchFn, T0 + 14_000);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'KD-EX1833-SO8 is in the parts library already, published by Ada', entry: { by: ada.user.id, revision: 1 } });
    expect(JSON.stringify(await (await handle(at('/part/KDEX1833SO8'), ENV, store, w.fetchFn, T0)).json())).not.toContain('example.org');
    // Its publisher, again: a second revision, the name kept when none is sent; another commit came between and it was tried again
    w.state.refuseMove = 1;
    const again = await sendBlobs(w, store, ada.token, T0 + 20_000);
    const second = await (await handle(post('/publish', body(again), { token: ada.token }), ENV, store, w.fetchFn, T0 + 21_000)).json() as { entry: LibraryEntry; commit: string };
    expect(second.entry).toMatchObject({ revision: 2, name: 'Ada', by: ada.user.id });
    expect(w.commits.get(second.commit)!.message.split('\n')[0]).toBe('Update KD-EX1833-SO8 (Konium (example); SO-8, 8 pins), revision 2');
    expect(w.head()).toBe(second.commit);
    expect(w.calls.filter((c) => c === 'PATCH gh:/git/refs/heads/main')).toHaveLength(3);
    // Twenty parts a day, each person
    const fresh = new LibraryStoreLogic(sqlite()), w2 = world();
    const eve = await signIn(w2, fresh, 'eve@example.org');
    let last = 0;
    for (let k = 0; k < 21; k++) {
      const b = await sendBlobs(w2, fresh, eve.token, T0 + 30_000);
      last = (await handle(post('/publish', { record: { ...PART.record, mpn: `KD-EX${1000 + k}` }, ...b, licence: 'CC0-1.0' }, { token: eve.token }), ENV, fresh, w2.fetchFn, T0 + 31_000)).status;
      if (k < 20) expect(last, String(k)).toBe(200);
    }
    expect(last).toBe(429);
  });

  it('a part put into the repository by hand is found there, and is nobody\'s to overwrite through the service', async () => {
    const w = world(), store = new LibraryStoreLogic(sqlite());
    const entry: LibraryEntry = { key: 'ABC123', mpn: 'ABC-123', status: 'confirmed', by: '', name: '', published: '2026-11-01T00:00:00.000Z', revision: 4, licence: 'CC0-1.0', app: '' };
    w.put('parts/AB/ABC123/library.json', JSON.stringify(entry));
    w.put('parts/AB/ABC123/part.json', JSON.stringify({ ...PART.record, mpn: 'ABC-123' }));
    expect(await (await handle(at('/part/ABC123'), ENV, store, w.fetchFn, T0)).json()).toEqual({ found: true, entry, commit: '' });
    // (asked a second time it comes from the index: the repository is not asked again)
    const asked = w.calls.length;
    await handle(at('/part/ABC123'), ENV, store, w.fetchFn, T0);
    expect(w.calls.length).toBe(asked);
    const record = await handle(at('/part/ABC123/part.json'), ENV, store, w.fetchFn, T0);
    expect(record.headers.get('Cache-Control')).toBe('public, max-age=120');
    expect((await record.json() as { mpn: string }).mpn).toBe('ABC-123');
    const { token } = await signIn(w, store, 'ada@example.org');
    const blobs = await sendBlobs(w, store, token);
    const res = await handle(post('/publish', { record: { ...PART.record, mpn: 'ABC-123' }, ...blobs, licence: 'CC0-1.0' }, { token }), ENV, store, w.fetchFn, T0 + 6000);
    expect(res.status).toBe(409);
    // A note in the repository that is another part's, or no note at all, is not taken
    w.put('parts/ZZ/ZZZ999/library.json', JSON.stringify({ ...entry, key: 'ABC123' }));
    expect(await (await handle(at('/part/ZZZ999'), ENV, store, w.fetchFn, T0)).json()).toEqual({ found: false });
  });
});
