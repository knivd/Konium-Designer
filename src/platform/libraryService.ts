/**
 * The world parts library's client (R21, step 2): Konium's library service (konium.app/api/library,
 * cloudflare/library), which keeps the parts in a public repository.
 *
 * Looking a part up needs no sign-in and sends the part number only. Publishing needs one: a link
 * mailed to an address, after which the service gives this copy a pass good for 90 days (kept in
 * this browser; Sign Out forgets it). A part goes as its record and its two libraries; the
 * datasheet never goes, only its link and fingerprint. Nothing of a design is sent.
 *
 * What comes back is somebody else's work and is treated so: sizes are checked before anything is
 * read, the record goes through the part file's own reader (which keeps only what a record has),
 * the part number must be the one asked for, and the part's checks are run again here.
 */
import { OFFLINE_NOTE, mayConnect } from './network';
import { readLocal, writeLocal } from '../core/storage';
import { partChecks, partKey, readPartPieces, type PartCheck, type PartPackage } from '../model/partPackage';
import {
  FOOTPRINT_FILE, KEY_FORMAT, LIBRARY_LICENCE, MAX_FOOTPRINT, MAX_RECORD, MAX_SYMBOL, RECORD_FILE, SYMBOL_FILE,
  MAX_NOTE, MIN_NOTE, cleanRecord, mailAddress, oneLine, readEntry, recordProblems, shownName, type LibraryEntry, type LibraryFile, type Verdict,
} from '../model/worldLibrary';

/** The service: this site's when Konium is served from konium.app, else konium.app's. */
export function libraryService(): string {
  const host = globalThis.location?.hostname ?? '';
  return /(^|\.)konium\.app$/.test(host) ? `${globalThis.location.origin}/api/library` : 'https://konium.app/api/library';
}

export interface LibraryConfig { ready: boolean; signIn: boolean; repo: string; web: string; licence: string; publishPerDay: number; parts: number }
export interface LibraryUser { id: string; name: string; email: string }
export interface LibrarySession { token: string; until: number; user: LibraryUser }
export interface FoundPart { part: PartPackage; entry: LibraryEntry; checks: PartCheck[] }
export interface Published { entry: LibraryEntry; commit: string; url: string }

/** What the service refused, in its own words; `problems` and `entry` when it sent them. */
export class LibraryError extends Error {
  constructor(message: string, readonly status = 0, readonly problems: string[] = [], readonly entry: LibraryEntry | null = null) { super(message); this.name = 'LibraryError'; }
}

const UNREACHABLE = 'The world parts library can\'t be reached';
const NOT_THERE = 'The world parts library isn\'t there yet';

async function ask(f: typeof fetch, path: string, init?: RequestInit): Promise<Response> {
  if (!mayConnect('library')) throw new LibraryError(OFFLINE_NOTE);
  let res: Response;
  try { res = await f(`${libraryService()}${path}`, init); } catch { throw new LibraryError(UNREACHABLE); }
  // (a site without the service answers its own "not found" page: the service's own are JSON)
  if (res.status === 404 && !(res.headers.get('Content-Type') ?? '').includes('json')) throw new LibraryError(NOT_THERE, 404);
  return res;
}
const one = (s: unknown): string => (typeof s === 'string' ? oneLine(s).slice(0, 300) : '');
async function answer<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({})) as T & { error?: unknown; problems?: unknown; entry?: unknown };
  if (res.ok) return body;
  const problems = Array.isArray(body.problems) ? body.problems.map(one).filter(Boolean).slice(0, 30) : [];
  throw new LibraryError(one(body.error) || `The world parts library: HTTP ${res.status}`, res.status, problems, readEntry(body.entry));
}
const JSON_HEAD = { 'Content-Type': 'application/json', Accept: 'application/json' };

let config: Promise<LibraryConfig | null> | null = null;
/** What the service says of itself (null: it can't be reached, or isn't there yet). Asked once. */
export function libraryConfig(f: typeof fetch = fetch, again = false): Promise<LibraryConfig | null> {
  if (!mayConnect('library')) return Promise.resolve(null);
  if (!config || again) {
    config = ask(f, '/config', { headers: { Accept: 'application/json' } })
      .then(async (r) => {
        if (!r.ok) return null;
        const c = await r.json() as Partial<LibraryConfig>;
        const web = one(c.web);
        return { ready: c.ready === true, signIn: c.signIn === true, repo: one(c.repo), web: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(web) ? web : '', licence: one(c.licence), publishPerDay: Number(c.publishPerDay) || 0, parts: Number(c.parts) || 0 };
      })
      .catch(() => null)
      .then((c) => { if (!c) config = null; return c; });
  }
  return config;
}
/** Forget the service's answer about itself (tests). */
export function resetLibraryConfig(): void { config = null; }

/* ---- fetching ---- */

/** A file's bytes, read only as far as its limit: more than that is not a part's file. */
async function bytesUpTo(res: Response, most: number, what: string): Promise<Uint8Array> {
  if (Number(res.headers.get('Content-Length') ?? 0) > most) throw new LibraryError(`The library's ${what} is too large to be one`);
  const reader = res.body?.getReader();
  if (!reader) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.byteLength > most) throw new LibraryError(`The library's ${what} is too large to be one`);
    return all;
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > most) { void reader.cancel().catch(() => { /* gone already */ }); throw new LibraryError(`The library's ${what} is too large to be one`); }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * A part number looked up in the world library: the part with the library's note about it and
 * what its checks say here, or null when the library has none of that number.
 */
export async function findInLibrary(mpn: string, f: typeof fetch = fetch): Promise<FoundPart | null> {
  const noted = await libraryNote(mpn, f);
  if (!noted) return null;
  const { entry, commit } = noted, key = entry.key;
  const at = commit ? `?c=${commit}` : '';
  const file = async (name: LibraryFile, most: number, what: string) => {
    const res = await ask(f, `/part/${key}/${name}${at}`);
    if (!res.ok) throw new LibraryError(`The library's ${what} for ${entry.mpn} couldn't be fetched`, res.status);
    return bytesUpTo(res, most, what);
  };
  const [json, schlib, pcblib] = await Promise.all([file(RECORD_FILE, MAX_RECORD, 'record'), file(SYMBOL_FILE, MAX_SYMBOL, 'symbol'), file(FOOTPRINT_FILE, MAX_FOOTPRINT, 'footprint')]);
  let part: PartPackage;
  try { part = readPartPieces(json, schlib, pcblib); } catch (e) { throw new LibraryError(`The library's copy of ${entry.mpn} can't be read: ${(e as Error).message}`); }
  if (partKey(part.record.mpn) !== key) throw new LibraryError(`The library's copy of ${entry.mpn} is of another part number (${part.record.mpn}): not taken`);
  // (the note is the library's to give: whatever the record itself said of one is replaced)
  part.record.library = entry;
  return { part, entry, checks: partChecks(part) };
}

/**
 * The library's note about a part number, without the part: its standing, its revision, who has
 * checked it and what has been found wrong. Null when the library has none of that number. The
 * number is all that is sent.
 */
export async function libraryNote(mpn: string, f: typeof fetch = fetch): Promise<{ entry: LibraryEntry; commit: string } | null> {
  const key = partKey(mpn);
  if (!KEY_FORMAT.test(key)) throw new LibraryError('A part number has three letters or digits at least');
  const found = await answer<{ found?: unknown; entry?: unknown; commit?: unknown }>(await ask(f, `/part/${key}`, { headers: { Accept: 'application/json' } }));
  if (found.found !== true) return null;
  const entry = readEntry(found.entry);
  if (!entry || entry.key !== key) throw new LibraryError('The library\'s note about that part can\'t be read');
  return { entry, commit: typeof found.commit === 'string' && /^[0-9a-f]{40}$/.test(found.commit) ? found.commit : '' };
}

/* ---- the session ---- */

const KEPT = 'library.session';
const TOKEN = /^[0-9a-f]{16}\.\d{1,16}\.[0-9a-f]{64}$/;
const userOf = (v: unknown): LibraryUser | null => {
  const u = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return typeof u.id === 'string' && /^k-[0-9a-f]{8}$/.test(u.id) ? { id: u.id, name: shownName(u.name), email: mailAddress(u.email) } : null;
};
const sessionOf = (v: unknown, now: number): LibrarySession | null => {
  const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const user = userOf(s.user);
  return typeof s.token === 'string' && TOKEN.test(s.token) && typeof s.until === 'number' && s.until > now && user ? { token: s.token, until: s.until, user } : null;
};

/** The sign-in kept in this browser (null: none, or it has run out). */
export function keptSession(now = Date.now()): LibrarySession | null {
  try { return sessionOf(JSON.parse(readLocal(KEPT) ?? 'null'), now); } catch { return null; }
}
function keepSession(s: LibrarySession | null): void {
  try { writeLocal(KEPT, s ? JSON.stringify(s) : ''); } catch { /* a browser that keeps nothing: signed in for the session's requests only */ }
}
/** Forget the sign-in kept here. (The service keeps no list of passes: one simply runs out.) */
export function signOut(): void { keepSession(null); }

/** A sign-in link asked for: the ticket to wait with, and for how many minutes the link is good. */
export async function askSignIn(email: string, f: typeof fetch = fetch): Promise<{ ticket: string; minutes: number }> {
  const to = mailAddress(email);
  if (!to) throw new LibraryError('That is not an email address');
  const a = await answer<{ ticket?: unknown; minutes?: unknown }>(await ask(f, '/signin', { method: 'POST', headers: JSON_HEAD, body: JSON.stringify({ email: to }) }));
  if (typeof a.ticket !== 'string' || !/^[0-9a-f]{32}$/.test(a.ticket)) throw new LibraryError('The world parts library gave no sign-in to wait for');
  return { ticket: a.ticket, minutes: Number(a.minutes) || 15 };
}

/** Has the link been confirmed? The session (kept from here on), or 'pending' while it has not. Throws once the link has run out. */
export async function sessionFor(ticket: string, f: typeof fetch = fetch, now = Date.now()): Promise<LibrarySession | 'pending'> {
  const a = await answer<{ pending?: unknown }>(await ask(f, '/session', { method: 'POST', headers: JSON_HEAD, body: JSON.stringify({ ticket }) }));
  if (a.pending === true) return 'pending';
  const s = sessionOf(a, now);
  if (!s) throw new LibraryError('The world parts library gave no sign-in');
  keepSession(s);
  return s;
}

const signed = (s: LibrarySession) => ({ Authorization: `Bearer ${s.token}` });
/** A request as the one signed in. A pass the service no longer takes is forgotten here. */
async function mine<T>(f: typeof fetch, path: string, init: RequestInit, now: number): Promise<T> {
  const s = keptSession(now);
  if (!s) throw new LibraryError('Sign in to the world parts library first', 401);
  const res = await ask(f, path, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...signed(s) } });
  if (res.status === 401) signOut();
  return answer<T>(res);
}

/** Who the service says is signed in here (null: nobody; a pass it no longer takes is forgotten). */
export async function whoAmI(f: typeof fetch = fetch, now = Date.now()): Promise<LibraryUser | null> {
  const s = keptSession(now);
  if (!s) return null;
  try {
    const user = userOf((await mine<{ user?: unknown }>(f, '/me', { headers: { Accept: 'application/json' } }, now)).user);
    if (user) keepSession({ ...s, user });
    return user;
  } catch (e) {
    if (e instanceof LibraryError && e.status === 401) return null;
    throw e;
  }
}

/* ---- publishing ---- */

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * What stops a part from being published, in words for its author (none: it may go): the record's
 * own problems, a check that finds a fault, and a library too large for the world library.
 */
export function publishProblems(p: PartPackage): string[] {
  const out = [...recordProblems(p.record), ...partChecks(p).filter((c) => c.level === 'error').map((c) => c.text)];
  if (p.schlib.byteLength > MAX_SYMBOL) out.push(`Its symbol's library is too large (${Math.round(MAX_SYMBOL / 1024)} KB at most)`);
  if (p.pcblib.byteLength > MAX_FOOTPRINT) out.push(`Its footprint's library is too large (${Math.round(MAX_FOOTPRINT / 1024)} KB at most): a lighter 3D body would do it`);
  return out;
}

/**
 * A part published to the world library, given to the public domain (CC0 1.0): its two libraries
 * go first, then its record with the agreement. `agreed` is the author's own tick, asked for with
 * every part; `name` is the name to show beside it (none: the contributor's number). The answer
 * is the library's note about the part, to keep with the copy on the shelf.
 */
export async function publishPart(p: PartPackage, o: { agreed: boolean; name?: string; app?: string }, f: typeof fetch = fetch, now = Date.now()): Promise<Published> {
  if (!o.agreed) throw new LibraryError('The world parts library takes parts given to the public domain (CC0 1.0) only');
  const problems = publishProblems(p);
  if (problems.length) throw new LibraryError('This part can\'t be published as it is', 400, problems);
  const blob = (kind: 'symbol' | 'footprint', bytes: Uint8Array) =>
    mine<{ sha?: unknown; pass?: unknown }>(f, `/blob?kind=${kind}`, { method: 'POST', headers: JSON_HEAD, body: `{"content":"${base64(bytes)}","encoding":"base64"}` }, now)
      .then((a) => ({ sha: String(a.sha ?? ''), pass: String(a.pass ?? '') }));
  // (one after the other: the second is not sent when the first is refused)
  const symbol = await blob('symbol', p.schlib);
  const footprint = await blob('footprint', p.pcblib);
  const a = await mine<{ entry?: unknown; commit?: unknown; url?: unknown }>(f, '/publish', {
    method: 'POST', headers: JSON_HEAD,
    body: JSON.stringify({ record: cleanRecord(p.record), symbol, footprint, licence: LIBRARY_LICENCE, ...(o.name === undefined ? {} : { name: shownName(o.name) }), app: o.app ?? '' }),
  }, now);
  const entry = readEntry(a.entry);
  if (!entry || entry.key !== partKey(p.record.mpn)) throw new LibraryError('The world parts library took the part but its answer can\'t be read: look the part up to see it');
  const url = one(a.url);
  const s = keptSession(now);
  if (s && o.name !== undefined) keepSession({ ...s, user: { ...s.user, name: entry.name } });
  return { entry, commit: one(a.commit), url: /^https:\/\/github\.com\/[^\s"'<>]+$/.test(url) ? url : '' };
}

/* ---- approval ---- */

/**
 * A word about a part of the library, from whoever is signed in (step 3): it is right (compared
 * with its datasheet), a board built with it works, or something is wrong with it (`note`, a
 * line). It is said of the revision named: the library refuses a word about a revision it has
 * moved on from, and gives its note as it is now. The answer is the note with the word in it.
 */
export async function sayOfPart(entry: Pick<LibraryEntry, 'key' | 'revision'>, verdict: Verdict, o: { note?: string; name?: string } = {}, f: typeof fetch = fetch, now = Date.now()): Promise<{ entry: LibraryEntry; commit: string }> {
  const line = oneLine(o.note ?? '').slice(0, MAX_NOTE);
  if (verdict === 'problem' && line.length < MIN_NOTE) throw new LibraryError('Say what is wrong with it, in a line');
  const a = await mine<{ entry?: unknown; commit?: unknown }>(f, '/check', {
    method: 'POST', headers: JSON_HEAD, body: JSON.stringify({ key: entry.key, revision: entry.revision, verdict, ...(verdict === 'problem' ? { note: line } : {}), ...(o.name === undefined ? {} : { name: shownName(o.name) }) }),
  }, now);
  const said = readEntry(a.entry);
  if (!said || said.key !== entry.key) throw new LibraryError('The world parts library took it but its answer can\'t be read: look the part up to see it');
  const s = keptSession(now);
  if (s && o.name !== undefined) keepSession({ ...s, user: { ...s.user, name: shownName(o.name) } });
  return { entry: said, commit: one(a.commit) };
}
