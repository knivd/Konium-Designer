/**
 * 26.203 (R21, step 3): approval in the world parts library. What others say of a part (it is
 * right, a board with it works, something is wrong with it) is kept in the library's note, and
 * the part's standing follows from it. The app's client is driven against the service's own code
 * with GitHub and the mail stood in for: the real ones can't be reached from the tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, type LibraryEnv } from '../cloudflare/library/src/handler';
import { LibraryStoreLogic } from '../cloudflare/library/src/store';
import { ENV, T0, sqlite, world } from './helpers/libraryWorld';
import { examplePart } from '../src/model/partExample';
import { partKey } from '../src/model/partKey';
import { CHECKS_TO_CONFIRM, MAX_WORDS, PROBLEMS_TO_DISPUTE, partFolder, readEntry, standing, standingText, type LibraryEntry } from '../src/model/worldLibrary';
import { SHELF_SCH } from '../src/model/partPackage';
import { SR, bagOf, ownedBy } from '../src/model/sch';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { LIVE_EXAMPLES, liveExampleBytes, liveExampleFile } from '../src/app/liveExamples';
import { libraryWarnings } from '../src/app/worldLibrary';
import { LibraryError, askSignIn, findInLibrary, keptSession, libraryNote, publishPart, resetLibraryConfig, sayOfPart, sessionFor, signOut } from '../src/platform/libraryService';

const PART = examplePart('26.203');
const KEY = partKey(PART.record.mpn);
const WRONG = 'Pin 3 is VOUT in the datasheet, not GND';

function service(env: LibraryEnv = ENV) {
  const w = world(), store = new LibraryStoreLogic(sqlite());
  const clock = { now: T0 };
  const lines: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), headers = (init?.headers ?? {}) as Record<string, string>;
    lines.push(`${init?.method ?? 'GET'} ${url.replace('https://konium.app/api/library', '')}`);
    return handle(new Request(url, { ...init, headers: { 'CF-Connecting-IP': '203.0.113.7', ...headers } }), env, store, w.fetchFn, clock.now);
  }) as typeof fetch;
  /** Somebody signs in (the link in their mail opened and confirmed); what the app does next is theirs. */
  const as = async (email: string) => {
    clock.now += 3_600_000;   // (an hour on: the service counts the sign-in links asked for from one place in an hour)
    const { ticket } = await askSignIn(email, f);
    const link = /confirm\?id=([0-9a-f]{32})&code=([0-9a-f]{40})/.exec(w.mails.at(-1)!.text)!;
    await handle(new Request('https://konium.app/api/library/confirm', { method: 'POST', body: new URLSearchParams({ id: link[1]!, code: link[2]! }).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env, store, w.fetchFn, clock.now);
    const s = await sessionFor(ticket, f, clock.now);
    if (s === 'pending') throw new Error('still pending');
    clock.now += 1000;
    return s.user.id;
  };
  const say = (entry: Pick<LibraryEntry, 'key' | 'revision'>, verdict: 'confirm' | 'built' | 'problem', o: { note?: string; name?: string } = {}) => sayOfPart(entry, verdict, o, f, clock.now).then((a) => { clock.now += 1000; return a; });
  const publish = (name?: string) => publishPart(PART, { agreed: true, name, app: '26.203' }, f, clock.now).then((a) => { clock.now += 1000; return a; });
  /** The library's own file in the repository as it stands. */
  const noteInRepo = () => JSON.parse(w.filesAt(w.head())[`${partFolder(KEY)}/library.json`]!) as LibraryEntry;
  const commitsMade = () => [...w.commits.values()].length;
  return { w, store, clock, f, lines, as, say, publish, noteInRepo, commitsMade };
}

let kept: Map<string, string>;
beforeEach(() => {
  kept = new Map();
  vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });
  resetLibraryConfig();
});
afterEach(() => { vi.unstubAllGlobals(); });
const refusal = async (p: Promise<unknown>): Promise<LibraryError> => { try { await p; } catch (e) { return e as LibraryError; } throw new Error('it was not refused'); };

describe('a part\'s standing by what is said of it (26.203)', () => {
  const w = (by: string, note?: string) => ({ by, name: '', at: '2026-11-21T10:00:00.000Z', ...(note ? { note } : {}) });
  it('two checks confirm, a board proves, two problems send it back', () => {
    expect([CHECKS_TO_CONFIRM, PROBLEMS_TO_DISPUTE]).toEqual([2, 2]);
    expect(standing({})).toBe('unverified');
    expect(standing({ checked: [w('k-00000001')], built: [w('k-00000009')] })).toBe('unverified');
    expect(standing({ checked: [w('k-00000001'), w('k-00000002')] })).toBe('confirmed');
    expect(standing({ checked: [w('k-00000001'), w('k-00000002')], built: [w('k-00000009')] })).toBe('proven');
    expect(standing({ checked: [w('k-00000001'), w('k-00000002')], built: [w('k-00000009')], problems: [w('k-00000003', WRONG)] })).toBe('proven');
    expect(standing({ checked: [w('k-00000001'), w('k-00000002')], built: [w('k-00000009')], problems: [w('k-00000003', WRONG), w('k-00000004', WRONG)] })).toBe('unverified');
    expect(standingText({})).toBe('0 of 2 checks');
    expect(standingText({ checked: [w('k-00000001')], problems: [w('k-00000003', WRONG)] })).toBe('1 of 2 checks, 1 problem reported');
    expect(standingText({ checked: [w('k-00000001'), w('k-00000002')], built: [w('k-00000009')] })).toBe('checked by 2, built by 1');
  });

  it('a note read from outside keeps one word from each contributor, the latest, ten at most, each on one line', () => {
    const base = { key: KEY, mpn: PART.record.mpn, status: 'confirmed', by: 'k-0123abcd', name: 'Ada', published: '2026-11-20T12:00:00.000Z', revision: 1, licence: 'CC0-1.0', app: '26.203' };
    const many = Array.from({ length: 30 }, (_, i) => w(`k-${String(i).padStart(8, '0')}`));
    const e = readEntry({ ...base, checked: [w('k-00000001'), { by: 'ada@example.org', name: 'x' }, 'nobody', w('k-00000001'), w('k-00000002')], built: many,
      problems: [{ ...w('k-00000003'), note: `Pin 3\nis <b>wrong</b>${'!'.repeat(400)}`, name: 'Grace <script>' }] })!;
    expect(e.checked!.map((x) => x.by)).toEqual(['k-00000001', 'k-00000002']);
    expect(e.built).toHaveLength(MAX_WORDS);
    expect(e.built!.at(-1)!.by).toBe('k-00000029');
    expect(e.problems![0]!.note).toMatch(/^Pin 3 is <b>wrong<\/b>!+$/);
    expect(e.problems![0]!.note!.length).toBe(200);
    expect(e.problems![0]!.name).toBe('Grace script');
    // (a note nobody has spoken in is as it was before there were words)
    expect(Object.keys(readEntry({ ...base, checked: [], problems: 'none' })!)).not.toContain('checked');
  });
});

describe('approval through the service (26.203)', () => {
  it('two others\' checks make a part Confirmed, a board that works makes it Proven; each word is a commit of the note alone', async () => {
    const s = service();
    const ada = await s.as('ada@example.org');
    const first = (await s.publish('Ada L.')).entry;
    const published = s.w.head();
    const grace = await s.as('grace@example.org');
    s.lines.length = 0;
    const one = await s.say(first, 'confirm', { name: 'Grace H.' });
    expect(s.lines).toEqual(['POST /check']);
    expect(one.entry).toMatchObject({ status: 'unverified', revision: 1, checked: [{ by: grace, name: 'Grace H.', at: expect.stringMatching(/^2026-11-20T/) }] });
    expect(standingText(one.entry)).toBe('1 of 2 checks');
    expect(keptSession(s.clock.now)!.user.name).toBe('Grace H.');
    // The commit: the note alone, in the checker's name and number (never an address); the part's files are the ones published
    const c = s.w.commits.get(one.commit)!;
    expect(c.parent).toBe(published);
    expect(c.message.split('\n')[0]).toBe(`Checked: ${PART.record.mpn} (1 of 2 checks; Unverified)`);
    expect(c.author).toMatchObject({ name: 'Grace H.', email: `${grace}@parts.konium.app` });
    expect(JSON.stringify([...s.w.commits.values()])).not.toMatch(/example\.org/);
    const before = s.w.filesAt(published), after = s.w.filesAt(one.commit);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const path of Object.keys(before)) if (!path.endsWith('library.json')) expect(after[path]).toBe(before[path]);
    expect(s.noteInRepo()).toEqual(one.entry);
    // Said twice: nothing new, and nothing committed
    const made = s.commitsMade();
    expect((await s.say(one.entry, 'confirm')).entry).toEqual(one.entry);
    expect(s.commitsMade()).toBe(made);
    // The second check, by a third person
    const linus = await s.as('linus@example.org');
    const two = await s.say(one.entry, 'confirm');
    expect(two.entry.status).toBe('confirmed');
    expect(two.entry.checked!.map((x) => x.by)).toEqual([grace, linus]);
    expect(s.w.commits.get(two.commit)!.message.split('\n')[0]).toBe(`Checked: ${PART.record.mpn} (checked by 2; Confirmed)`);
    expect(s.w.commits.get(two.commit)!.author.name).toBe(linus);   // (no name chosen: the number)
    // Its author's board works: Proven
    await s.as('ada@example.org');
    const three = await s.say(two.entry, 'built');
    expect(three.entry).toMatchObject({ status: 'proven', built: [{ by: ada, name: 'Ada L.' }] });
    // Whoever looks the number up gets the part whole, at the last commit, with the note as it stands
    signOut();
    const found = (await findInLibrary(PART.record.mpn, s.f))!;
    expect(found.entry).toEqual(three.entry);
    expect([...found.part.pcblib]).toEqual([...PART.pcblib]);
    expect((await libraryNote(PART.record.mpn, s.f))).toEqual({ entry: three.entry, commit: three.commit });
    expect(await libraryNote('NOSUCH-PART-1', s.f)).toBeNull();
  });

  it('a board that works before the checks are in is kept, and counts once they are', async () => {
    const s = service();
    await s.as('ada@example.org');
    const e0 = (await s.publish()).entry;
    expect((await s.say(e0, 'built')).entry).toMatchObject({ status: 'unverified', built: [{}] });
    await s.as('grace@example.org');
    await s.say(e0, 'confirm');
    await s.as('linus@example.org');
    expect((await s.say(e0, 'confirm')).entry.status).toBe('proven');
  });

  it('its author can neither confirm it nor report a problem with it; a word about a revision the library has moved on from is refused, with the note as it is', async () => {
    const s = service();
    await s.as('ada@example.org');
    const e1 = (await s.publish('Ada')).entry;
    const made = s.commitsMade();
    expect(await refusal(s.say(e1, 'confirm'))).toMatchObject({ status: 403, message: 'A confirmation is somebody else\'s check: this part is your own' });
    expect(await refusal(s.say(e1, 'problem', { note: WRONG }))).toMatchObject({ status: 403, message: 'This part is your own: publish it again with the fault put right' });
    const e2 = (await s.publish()).entry;
    expect(e2.revision).toBe(2);
    await s.as('grace@example.org');
    const late = await refusal(s.say(e1, 'confirm'));
    expect(late).toMatchObject({ status: 409, message: `${PART.record.mpn} is at revision 2 in the parts library now: look it up again` });
    expect(late.entry).toMatchObject({ revision: 2 });
    expect(await refusal(s.say({ key: 'NOSUCHPART1', revision: 1 }, 'confirm'))).toMatchObject({ status: 404 });
    expect(await refusal(s.say(e2, 'problem', { note: 'bad' }))).toMatchObject({ message: 'Say what is wrong with it, in a line' });
    // (the same from a client that sends whatever it likes)
    const raw = (body: object) => s.f('https://konium.app/api/library/check', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keptSession(s.clock.now)!.token}` }, body: JSON.stringify(body) });
    expect((await raw({ key: KEY, revision: 2, verdict: 'problem', note: 'bad' })).status).toBe(400);
    expect((await raw({ key: KEY, revision: 2, verdict: 'approve' })).status).toBe(400);
    expect((await raw({ key: KEY, revision: '2', verdict: 'confirm' })).status).toBe(400);
    expect((await raw({ key: '../x', revision: 2, verdict: 'confirm' })).status).toBe(400);
    signOut();
    expect(await refusal(s.say(e2, 'confirm'))).toMatchObject({ status: 401 });
    // (none of the refusals reached the repository)
    expect(s.commitsMade()).toBe(made + 1);
  });

  it('two people\'s problems send a part back to Unverified; its author publishes the next revision, and the words start again', async () => {
    const s = service();
    await s.as('ada@example.org');
    let e = (await s.publish('Ada')).entry;
    for (const who of ['grace@example.org', 'linus@example.org']) { await s.as(who); e = (await s.say(e, 'confirm')).entry; }
    expect(e.status).toBe('confirmed');
    // Confirmed: no longer its author's to change by publishing
    await s.as('ada@example.org');
    expect((await refusal(s.publish())).status).toBe(409);
    const alan = await s.as('alan@example.org');
    e = (await s.say(e, 'problem', { note: `  ${WRONG}\n(see its page 4) @someone #12 `, name: 'Alan' })).entry;
    expect(e).toMatchObject({ status: 'confirmed', problems: [{ by: alan, name: 'Alan', note: `${WRONG} (see its page 4) @someone #12` }] });
    expect(standingText(e)).toBe('checked by 2, 1 problem reported');
    // (in the commit's message the marks a repository's site reads as a mention or a reference are in their wide forms)
    expect(s.w.commits.get(s.w.head())!.message).toMatch(/^Problem with KD-EX1833-SO8 \(checked by 2, 1 problem reported; Confirmed\)\n\nPin 3 is VOUT in the datasheet, not GND \(see its page 4\) ＠someone ＃12\n/);
    await s.as('edsger@example.org');
    e = (await s.say(e, 'problem', { note: 'The pads are 0.2 mm too narrow for the body' })).entry;
    expect(e.status).toBe('unverified');
    expect(e.checked).toHaveLength(2);
    expect(e.problems).toHaveLength(2);
    // Its author puts it right: revision 2, Unverified, nothing said of it yet
    await s.as('ada@example.org');
    const next = (await s.publish()).entry;
    expect(next).toMatchObject({ revision: 2, status: 'unverified', name: 'Ada' });
    expect([next.checked, next.built, next.problems]).toEqual([undefined, undefined, undefined]);
    expect(s.noteInRepo()).toEqual(next);
  });

  it('whoever finds it right no longer finds it wrong, and the other way round; a problem said again replaces the one before', async () => {
    const s = service();
    await s.as('ada@example.org');
    let e = (await s.publish()).entry;
    const grace = await s.as('grace@example.org');
    e = (await s.say(e, 'confirm')).entry;
    e = (await s.say(e, 'problem', { note: WRONG })).entry;
    expect([e.checked, e.problems!.map((x) => x.by)]).toEqual([undefined, [grace]]);
    e = (await s.say(e, 'problem', { note: 'Pin 3 and pin 4 are swapped in the symbol' })).entry;
    expect(e.problems!.map((x) => x.note)).toEqual(['Pin 3 and pin 4 are swapped in the symbol']);
    e = (await s.say(e, 'confirm')).entry;
    expect([e.checked!.map((x) => x.by), e.problems]).toEqual([[grace], undefined]);
  });

  it('a contributor\'s words in a day are counted', async () => {
    const s = service({ ...ENV, CHECK_PER_DAY: '2' });
    await s.as('ada@example.org');
    let e = (await s.publish()).entry;
    await s.as('grace@example.org');
    e = (await s.say(e, 'confirm')).entry;
    e = (await s.say(e, 'built')).entry;
    expect(await refusal(s.say(e, 'problem', { note: WRONG }))).toMatchObject({ status: 429, message: 'That\'s today\'s 2 checks sent: the count starts again tomorrow (UTC)' });
    s.clock.now += 86_400_000;
    expect((await s.say(e, 'problem', { note: WRONG })).entry.problems).toHaveLength(1);
  });
});

describe('a design that uses the library\'s parts (26.203)', () => {
  it('a compile names each part from the shelf that is Unverified, or that people have found wrong; nothing else', () => {
    const ex = LIVE_EXAMPLES.find((e) => e.id === 'ohm')!;
    const doc = readSchDoc(liveExampleBytes(ex), liveExampleFile(ex));
    // Two parts of the sheet made out to be the shelf's: placed from My Parts, with the part number a shelf part carries
    const kids = ownedBy(doc), comps = doc.objects.filter((o) => o.kind === 'component');
    const fromShelf = (i: number, lib: string, mpn: string) => {
      const c = comps[i]!;
      bagOf(doc, c)!.set('SOURCELIBRARYNAME', lib);
      const param = (kids.get(c.index) ?? []).map((k) => bagOf(doc, k)!).find((b) => b.int('RECORD', -1) === SR.PARAMETER)!;
      param.set('NAME', 'Manufacturer Part Number'); param.set('TEXT', mpn);
      return c.kind === 'component' ? c.designator : '';
    };
    const a = fromShelf(0, SHELF_SCH, 'kd-ex1833-so8'), b = fromShelf(1, 'Somebody Else.SchLib', PART.record.mpn);
    const entry: LibraryEntry = { key: KEY, mpn: PART.record.mpn, status: 'unverified', by: 'k-0123abcd', name: 'Ada', published: '2026-11-20T12:00:00.000Z', revision: 1, licence: 'CC0-1.0', app: '26.203' };
    const word = (by: string, note?: string) => ({ by, name: '', at: '2026-11-21T10:00:00.000Z', ...(note ? { note } : {}) });
    const sheets = [{ name: 'Sheet1.SchDoc', doc }];
    const shelfWith = (library?: LibraryEntry) => [{ ...PART, record: { ...PART.record, library } }];
    expect(b).not.toBe('');
    expect(libraryWarnings(sheets, shelfWith(undefined))).toEqual([]);   // (on the shelf only: not the library's)
    expect(libraryWarnings(sheets, shelfWith(entry))).toEqual([{ doc: 'Sheet1.SchDoc', level: 'warn', message: `${a} (KD-EX1833-SO8) is an Unverified part of the world library (0 of 2 checks): check it against its datasheet` }]);
    const confirmed = { ...entry, status: 'confirmed' as const, checked: [word('k-00000001'), word('k-00000002')] };
    expect(libraryWarnings(sheets, shelfWith(confirmed))).toEqual([]);
    expect(libraryWarnings(sheets, shelfWith({ ...confirmed, problems: [word('k-00000003', WRONG)] })).map((m) => m.message)).toEqual([`${a} (KD-EX1833-SO8): a problem has been reported with this part in the world library: ${WRONG}`]);
    expect(libraryWarnings(sheets, [])).toEqual([]);
  });
});

