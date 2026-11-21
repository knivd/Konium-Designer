/**
 * The world parts library's own records, in its Durable Object's SQLite (one object for the whole
 * service). The parts themselves are in the public Git repository; here are only:
 * - counts for the limits (fetches, sign-in mails, publications), by hour or day;
 * - sign-ins under way (the ticket the app waits with, a hash of the code in the mailed link);
 * - contributors: the address each signed in with (kept here alone, never published), the name
 *   they chose to show, and when;
 * - an index of the parts published through this service (which commit holds each, its standing,
 *   who published it), so that a part is found without asking GitHub. Lost, it fills again from
 *   the repository, which is the truth.
 */

/** The part of SQLite this needs (Durable Objects' ctx.storage.sql; node:sqlite in tests). */
export interface Sql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

export interface Taken { ok: boolean; left: number }
export interface SignIn { id: string; uid: string; email: string; code: string; until: number; confirmed: boolean }
/** `client`: where this contributor last signed in from (the hash the limits use), so that strangers asking for links in their name cannot keep them out. */
export interface Contributor { uid: string; email: string; name: string; since: number; client: string }
/** A part in the index: the library's note about it, the commit that holds this revision, and whose it is. */
export interface Indexed {
  key: string; mpn: string; status: string; by: string; name: string; published: string; revision: number; licence: string; app: string; commit: string; uid: string;
  /** What has been said of this revision (who checked it, who built it, what was found wrong), as JSON; '' for nothing. */
  more?: string;
}

export class LibraryStoreLogic {
  constructor(private sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS counts (period TEXT, who TEXT, kind TEXT, n INTEGER, PRIMARY KEY (period, who, kind))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS signins (id TEXT PRIMARY KEY, uid TEXT, email TEXT, code TEXT, until INTEGER, confirmed INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS contributors (uid TEXT PRIMARY KEY, email TEXT, name TEXT, since INTEGER, last INTEGER, client TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS parts (key TEXT PRIMARY KEY, mpn TEXT, status TEXT, by TEXT, name TEXT, published TEXT, revision INTEGER, licence TEXT, app TEXT, commit_sha TEXT, uid TEXT, more TEXT)`);
    // (a table made before the approval step has no column for what is said of a part)
    try { sql.exec(`ALTER TABLE parts ADD COLUMN more TEXT`); } catch { /* it has one */ }
  }

  /** One more of a kind in a period (an hour, a day) for someone, if the limit allows. */
  take(period: string, who: string, kind: string, limit: number): Taken {
    const n = Number(this.sql.exec(`SELECT n FROM counts WHERE period = ? AND who = ? AND kind = ?`, period, who, kind).toArray()[0]?.n ?? 0);
    if (n + 1 > limit) return { ok: false, left: Math.max(0, limit - n) };
    this.sql.exec(`INSERT INTO counts (period, who, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (period, who, kind) DO UPDATE SET n = n + 1`, period, who, kind);
    return { ok: true, left: limit - n - 1 };
  }

  startSignIn(s: SignIn): void {
    this.sql.exec(`INSERT INTO signins (id, uid, email, code, until, confirmed) VALUES (?, ?, ?, ?, ?, 0)`, s.id, s.uid, s.email, s.code, s.until);
  }
  signIn(id: string): SignIn | null {
    const r = this.sql.exec(`SELECT id, uid, email, code, until, confirmed FROM signins WHERE id = ?`, id).toArray()[0];
    return r ? { id: String(r.id), uid: String(r.uid), email: String(r.email), code: String(r.code), until: Number(r.until), confirmed: Number(r.confirmed) === 1 } : null;
  }
  confirmSignIn(id: string): void { this.sql.exec(`UPDATE signins SET confirmed = 1 WHERE id = ?`, id); }
  endSignIn(id: string): void { this.sql.exec(`DELETE FROM signins WHERE id = ?`, id); }

  contributor(uid: string): Contributor | null {
    const r = this.sql.exec(`SELECT uid, email, name, since, client FROM contributors WHERE uid = ?`, uid).toArray()[0];
    return r ? { uid: String(r.uid), email: String(r.email), name: String(r.name ?? ''), since: Number(r.since), client: String(r.client ?? '') } : null;
  }
  /** A contributor seen: made the first time; the name kept when one is given, and where they signed in from when that is said. */
  keepContributor(uid: string, email: string, name: string | null, now: number, client: string | null = null): void {
    this.sql.exec(`INSERT INTO contributors (uid, email, name, since, last, client) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (uid) DO UPDATE SET last = excluded.last, email = excluded.email${name === null ? '' : ', name = excluded.name'}${client === null ? '' : ', client = excluded.client'}`,
      uid, email, name ?? '', now, now, client ?? '');
  }

  part(key: string): Indexed | null {
    const r = this.sql.exec(`SELECT * FROM parts WHERE key = ?`, key).toArray()[0];
    return r ? {
      key: String(r.key), mpn: String(r.mpn), status: String(r.status), by: String(r.by), name: String(r.name ?? ''), published: String(r.published),
      revision: Number(r.revision), licence: String(r.licence), app: String(r.app ?? ''), commit: String(r.commit_sha ?? ''), uid: String(r.uid ?? ''), more: String(r.more ?? ''),
    } : null;
  }
  keepPart(p: Indexed): void {
    this.sql.exec(`INSERT INTO parts (key, mpn, status, by, name, published, revision, licence, app, commit_sha, uid, more) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET mpn = excluded.mpn, status = excluded.status, by = excluded.by, name = excluded.name, published = excluded.published,
      revision = excluded.revision, licence = excluded.licence, app = excluded.app, commit_sha = excluded.commit_sha, uid = excluded.uid, more = excluded.more`,
    p.key, p.mpn, p.status, p.by, p.name, p.published, p.revision, p.licence, p.app, p.commit, p.uid, p.more ?? '');
  }
  /** How many parts the index holds. */
  partCount(): number { return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM parts`).toArray()[0]?.n ?? 0); }

  /** Periods long past and sign-ins that ran out: forgotten. */
  prune(beforePeriod: string, now: number): void {
    this.sql.exec(`DELETE FROM counts WHERE period < ?`, beforePeriod);
    this.sql.exec(`DELETE FROM signins WHERE until < ?`, now);
  }
}
