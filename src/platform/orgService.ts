/**
 * A company's own parts library (R21, step 4): the client for the library service's /org routes.
 * A company proves a domain by a record in its DNS; whoever does so runs its library and lets
 * members in by their addresses; its parts are its members' only and are in no public repository.
 * Every request is the signed-in member's, and names the company's domain.
 *
 * What comes back is read as carefully as the world library's: sizes first, the record through
 * the part file's reader, the number asked for, the part's checks run again here.
 */
import { readLocal, writeLocal } from '../core/storage';
import { partChecks, partKey, readPartPieces, type PartPackage } from '../model/partPackage';
import {
  FOOTPRINT_FILE, KEY_FORMAT, MAX_FOOTPRINT, MAX_RECORD, MAX_SYMBOL, RECORD_FILE, SYMBOL_FILE, cleanRecord, mailAddress, oneLine, orgDomain, readEntry, shownName,
  type LibraryEntry, type LibraryFile, type OrgEvent, type OrgMember, type OrgPart, type OrgRole, type OrgStatus,
} from '../model/worldLibrary';
import { JSON_HEAD, LibraryError, base64, bytesUpTo, mine, mineRaw, publishProblems, type FoundPart } from './libraryService';

const line = (v: unknown, max = 200): string => (typeof v === 'string' ? oneLine(v).slice(0, max) : '');
const q = (domain: string) => `domain=${encodeURIComponent(domain)}`;
const GET = { headers: { Accept: 'application/json' } };
const post = (body: object): RequestInit => ({ method: 'POST', headers: JSON_HEAD, body: JSON.stringify(body) });

const KEPT = 'library.org';
/** The company whose library this browser works with ('' for none): remembered, so that it need not be typed again. */
export function keptOrg(): string { try { return orgDomain(readLocal(KEPT) ?? ''); } catch { return ''; } }
export function keepOrg(domain: string): void { try { writeLocal(KEPT, orgDomain(domain)); } catch { /* not kept */ } }

const roleOf = (v: unknown): OrgRole | null => (v === 'admin' || v === 'member' ? v : null);
const membersOf = (v: unknown): OrgMember[] => (Array.isArray(v) ? v.slice(0, 2000) : []).flatMap((m: Record<string, unknown>) => {
  const email = mailAddress(m?.email), role = roleOf(m?.role);
  return email && role ? [{ email, role, since: line(m.since, 40), seen: line(m.seen, 40), by: line(m.by, 254) }] : [];
});

/** How a company's library stands for whoever is signed in. */
export async function orgStatus(domain: string, f: typeof fetch = fetch, now = Date.now()): Promise<OrgStatus> {
  const d = orgDomain(domain);
  if (!d) throw new LibraryError('Name the company\'s domain (example.com)');
  const a = await mine<Record<string, unknown>>(f, `/org?${q(d)}`, GET, now);
  const rec = (a.record && typeof a.record === 'object' ? a.record : {}) as Record<string, unknown>;
  const role = roleOf(a.role);
  return {
    domain: d, open: a.open === true, exists: a.exists === true, role,
    ...(line(rec.name) && line(rec.value) ? { record: { name: line(rec.name, 260), value: line(rec.value, 120) } } : {}),
    ...(role ? { parts: Number(a.parts) || 0, allowance: Number(a.allowance) || 0 } : {}),
    ...(role === 'admin' ? { members: membersOf(a.members) } : {}),
  };
}

/** The domain's record looked for in its DNS: found, whoever asks runs the library from now on. */
export async function orgClaim(domain: string, f: typeof fetch = fetch, now = Date.now()): Promise<'opened' | 'claimed' | 'was'> {
  const a = await mine<{ how?: unknown }>(f, '/org/claim', post({ domain: orgDomain(domain) }), now);
  return a.how === 'claimed' || a.how === 'was' ? a.how : 'opened';
}

/** A member let in (or given another part in it), or put out. The members as they are afterwards. */
export async function orgMember(domain: string, email: string, o: { role?: OrgRole; remove?: boolean } = {}, f: typeof fetch = fetch, now = Date.now()): Promise<{ members: OrgMember[]; added: boolean; mailed: boolean; removed: boolean }> {
  const who = mailAddress(email);
  if (!who) throw new LibraryError('That is not an email address');
  const a = await mine<Record<string, unknown>>(f, '/org/member', post({ domain: orgDomain(domain), email: who, ...(o.remove ? { remove: true } : { role: o.role ?? 'member' }) }), now);
  return { members: membersOf(a.members), added: a.added === true, mailed: a.mailed === true, removed: a.removed === true };
}

/** The library's parts, as a list. */
export async function orgParts(domain: string, f: typeof fetch = fetch, now = Date.now()): Promise<OrgPart[]> {
  const a = await mine<{ parts?: unknown }>(f, `/org/parts?${q(orgDomain(domain))}`, GET, now);
  return (Array.isArray(a.parts) ? a.parts.slice(0, 2000) : []).flatMap((p: Record<string, unknown>) => {
    const key = line(p?.key, 80), mpn = line(p?.mpn, 80);
    return KEY_FORMAT.test(key) && partKey(mpn) === key ? [{ key, mpn, maker: line(p.maker, 80), package: line(p.package, 60), pins: Number(p.pins) || 0, by: line(p.by, 10), name: shownName(p.name), published: line(p.published, 40), revision: Number(p.revision) || 1 }] : [];
  });
}

/** What happened in the library, the latest first (its administrators'). */
export async function orgAudit(domain: string, f: typeof fetch = fetch, now = Date.now()): Promise<OrgEvent[]> {
  const a = await mine<{ events?: unknown }>(f, `/org/audit?${q(orgDomain(domain))}`, GET, now);
  return (Array.isArray(a.events) ? a.events.slice(0, 500) : []).map((e: Record<string, unknown>) => ({ at: line(e?.at, 40), who: line(e?.who, 254), what: line(e?.what, 120), about: line(e?.about, 254) }));
}

/** A part number looked up in a company's library: the part whole, with the library's note; null when it has none of that number. */
export async function orgFind(domain: string, mpn: string, f: typeof fetch = fetch, now = Date.now()): Promise<FoundPart | null> {
  const d = orgDomain(domain), key = partKey(mpn);
  if (!KEY_FORMAT.test(key)) throw new LibraryError('A part number has three letters or digits at least');
  const found = await mine<{ found?: unknown; entry?: unknown }>(f, `/org/part/${key}?${q(d)}`, GET, now);
  if (found.found !== true) return null;
  const entry = readEntry(found.entry);
  if (!entry || entry.key !== key || entry.org !== d) throw new LibraryError('The library\'s note about that part can\'t be read');
  const file = async (name: LibraryFile, most: number, what: string) => {
    const res = await mineRaw(f, `/org/part/${key}/${name}?${q(d)}`, {}, now);
    if (!res.ok) throw new LibraryError(`The library's ${what} for ${entry.mpn} couldn't be fetched`, res.status);
    return bytesUpTo(res, most, what);
  };
  // (one after the other: each is the signed-in member's own request)
  const json = await file(RECORD_FILE, MAX_RECORD, 'record'), schlib = await file(SYMBOL_FILE, MAX_SYMBOL, 'symbol'), pcblib = await file(FOOTPRINT_FILE, MAX_FOOTPRINT, 'footprint');
  let part: PartPackage;
  try { part = readPartPieces(json, schlib, pcblib); } catch (e) { throw new LibraryError(`The library's copy of ${entry.mpn} can't be read: ${(e as Error).message}`); }
  if (partKey(part.record.mpn) !== key) throw new LibraryError(`The library's copy of ${entry.mpn} is of another part number (${part.record.mpn}): not taken`);
  part.record.library = entry;
  return { part, entry, checks: partChecks(part) };
}

/** A part published to a company's library: its members' only, given to nobody else. The library's note about it. */
export async function orgPublish(domain: string, p: PartPackage, o: { name?: string; app?: string } = {}, f: typeof fetch = fetch, now = Date.now()): Promise<LibraryEntry> {
  const d = orgDomain(domain), problems = publishProblems(p);
  if (problems.length) throw new LibraryError('This part can\'t be published as it is', 400, problems);
  const a = await mine<{ entry?: unknown }>(f, '/org/publish', post({ domain: d, record: cleanRecord(p.record), symbol: base64(p.schlib), footprint: base64(p.pcblib), ...(o.name === undefined ? {} : { name: shownName(o.name) }), app: o.app ?? '' }), now);
  const entry = readEntry(a.entry);
  if (!entry || entry.key !== partKey(p.record.mpn) || entry.org !== d) throw new LibraryError('The library took the part but its answer can\'t be read: look the part up to see it');
  return entry;
}

/** A part taken out of a company's library (by whoever published it, or an administrator). */
export async function orgDrop(domain: string, key: string, f: typeof fetch = fetch, now = Date.now()): Promise<void> {
  await mine<object>(f, '/org/drop', post({ domain: orgDomain(domain), key }), now);
}
