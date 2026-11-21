/**
 * A company's own parts library (R21, step 4): one Durable Object for each company, named by its
 * domain, holding in SQLite its members, its parts (the record and the two libraries, never in a
 * public repository), what happened (who fetched what, who was let in and put out) and its
 * counts. Nothing of one company's is in another's object.
 *
 * The logic is here, free of the Workers runtime (the tests run it on node:sqlite); index.ts
 * wraps it as the Durable Object.
 */
import type { OrgEvent, OrgMember, OrgPart, OrgRole } from '../../../src/model/worldLibrary';
import type { Sql, Taken } from './store';

/** A part as a company's library keeps it: its note's fields, the record as text and the two libraries as base64. */
export interface OrgStored extends OrgPart { app: string; record: string; symbol: string; footprint: string }
export type OrgFile = 'record' | 'symbol' | 'footprint';
/** What stays of what happened: the latest of it. */
export const AUDIT_KEPT = 2000;

export class OrgStoreLogic {
  constructor(private sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS members (email TEXT PRIMARY KEY, role TEXT, since INTEGER, seen INTEGER, by TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS parts (key TEXT PRIMARY KEY, mpn TEXT, maker TEXT, package TEXT, pins INTEGER, by TEXT, name TEXT, published TEXT, revision INTEGER, app TEXT,
      record TEXT, symbol TEXT, footprint TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS audit (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, who TEXT, what TEXT, about TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS counts (period TEXT, kind TEXT, n INTEGER, PRIMARY KEY (period, kind))`);
  }
  private one(query: string, ...b: unknown[]): Record<string, unknown> | undefined { return this.sql.exec(query, ...b).toArray()[0]; }
  private n(query: string, ...b: unknown[]): number { return Number(this.one(query, ...b)?.n ?? 0); }

  /** Whether the library exists (somebody has proved the domain), and how large it is. */
  info(): { exists: boolean; members: number; admins: number; parts: number } {
    const members = this.n(`SELECT COUNT(*) AS n FROM members`);
    return { exists: members > 0, members, admins: this.n(`SELECT COUNT(*) AS n FROM members WHERE role = 'admin'`), parts: this.n(`SELECT COUNT(*) AS n FROM parts`) };
  }
  /** A member's part in it (null: not one), noted as seen now. */
  member(email: string, now: number): OrgRole | null {
    const r = this.one(`SELECT role FROM members WHERE email = ?`, email);
    if (!r) return null;
    this.sql.exec(`UPDATE members SET seen = ? WHERE email = ?`, now, email);
    return r.role === 'admin' ? 'admin' : 'member';
  }
  members(): OrgMember[] {
    const iso = (v: unknown) => (Number(v) > 0 ? new Date(Number(v)).toISOString() : '');
    return this.sql.exec(`SELECT * FROM members ORDER BY role, email`).toArray().map((r) => ({ email: String(r.email), role: r.role === 'admin' ? 'admin' : 'member', since: iso(r.since), seen: iso(r.seen), by: String(r.by ?? '') }));
  }
  /** Whoever has proved the domain runs its library: made an administrator, whoever else is one (a library taken back by its domain). */
  claim(email: string, now: number): 'opened' | 'claimed' | 'was' {
    const had = this.info().exists, was = this.one(`SELECT role FROM members WHERE email = ?`, email)?.role;
    if (was === 'admin') return 'was';
    this.sql.exec(`INSERT INTO members (email, role, since, seen, by) VALUES (?, 'admin', ?, ?, 'the domain''s record') ON CONFLICT (email) DO UPDATE SET role = 'admin'`, email, now, now);
    this.log(now, email, had ? 'took the library over by the domain\'s record' : 'opened the library by the domain\'s record', '');
    return had ? 'claimed' : 'opened';
  }
  /** A member let in, or given another part in it. */
  invite(email: string, role: OrgRole, by: string, now: number): 'added' | 'changed' | 'same' | 'last-admin' {
    const was = this.one(`SELECT role FROM members WHERE email = ?`, email)?.role;
    if (was === role) return 'same';
    if (was === 'admin' && this.info().admins < 2) return 'last-admin';
    this.sql.exec(`INSERT INTO members (email, role, since, seen, by) VALUES (?, ?, ?, 0, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role`, email, role, now, by);
    this.log(now, by, was ? `made ${role === 'admin' ? 'an administrator' : 'a member'}` : `let in as ${role === 'admin' ? 'an administrator' : 'a member'}`, email);
    return was ? 'changed' : 'added';
  }
  /** A member put out: they have nothing of the library from this moment. The last administrator stays. */
  remove(email: string, by: string, now: number): 'removed' | 'none' | 'last-admin' {
    const was = this.one(`SELECT role FROM members WHERE email = ?`, email)?.role;
    if (!was) return 'none';
    if (was === 'admin' && this.info().admins < 2) return 'last-admin';
    this.sql.exec(`DELETE FROM members WHERE email = ?`, email);
    this.log(now, by, 'put out', email);
    return 'removed';
  }

  parts(): OrgPart[] {
    return this.sql.exec(`SELECT key, mpn, maker, package, pins, by, name, published, revision FROM parts ORDER BY mpn LIMIT 2000`).toArray().map((r) => this.listed(r));
  }
  private listed(r: Record<string, unknown>): OrgPart {
    return { key: String(r.key), mpn: String(r.mpn), maker: String(r.maker ?? ''), package: String(r.package ?? ''), pins: Number(r.pins ?? 0), by: String(r.by ?? ''), name: String(r.name ?? ''), published: String(r.published ?? ''), revision: Number(r.revision ?? 1) };
  }
  part(key: string): (OrgPart & { app: string }) | null {
    const r = this.one(`SELECT key, mpn, maker, package, pins, by, name, published, revision, app FROM parts WHERE key = ?`, key);
    return r ? { ...this.listed(r), app: String(r.app ?? '') } : null;
  }
  /** One of a part's three files as it is kept: the record's text, or a library as base64. Fetching the record is noted (it is how a part is fetched). */
  partFile(key: string, file: OrgFile, who: string, now: number): string | null {
    if (file !== 'record' && file !== 'symbol' && file !== 'footprint') return null;   // (a column's name: never anything but one of the three)
    const r = this.one(`SELECT mpn, ${file} AS f FROM parts WHERE key = ?`, key);
    if (!r) return null;
    if (file === 'record') this.log(now, who, 'fetched', String(r.mpn));
    return String(r.f ?? '');
  }
  /** A part kept: new, or as the next revision of the one there. */
  putPart(p: Omit<OrgStored, 'revision'>, who: string, now: number): OrgPart & { app: string } {
    const revision = this.n(`SELECT revision AS n FROM parts WHERE key = ?`, p.key) + 1;
    this.sql.exec(`INSERT INTO parts (key, mpn, maker, package, pins, by, name, published, revision, app, record, symbol, footprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET mpn = excluded.mpn, maker = excluded.maker, package = excluded.package, pins = excluded.pins, by = excluded.by, name = excluded.name, published = excluded.published,
      revision = excluded.revision, app = excluded.app, record = excluded.record, symbol = excluded.symbol, footprint = excluded.footprint`,
    p.key, p.mpn, p.maker, p.package, p.pins, p.by, p.name, p.published, revision, p.app, p.record, p.symbol, p.footprint);
    this.log(now, who, revision > 1 ? `published revision ${revision} of` : 'published', p.mpn);
    return this.part(p.key)!;
  }
  dropPart(key: string, who: string, now: number): boolean {
    const r = this.one(`SELECT mpn FROM parts WHERE key = ?`, key);
    if (!r) return false;
    this.sql.exec(`DELETE FROM parts WHERE key = ?`, key);
    this.log(now, who, 'took out', String(r.mpn));
    return true;
  }

  log(at: number, who: string, what: string, about: string): void {
    this.sql.exec(`INSERT INTO audit (at, who, what, about) VALUES (?, ?, ?, ?)`, at, who, what, about);
    this.sql.exec(`DELETE FROM audit WHERE n <= (SELECT MAX(n) FROM audit) - ?`, AUDIT_KEPT);
  }
  /** What happened, the latest first. */
  audit(limit = 200): OrgEvent[] {
    return this.sql.exec(`SELECT at, who, what, about FROM audit ORDER BY n DESC LIMIT ?`, Math.max(1, Math.min(500, limit))).toArray()
      .map((r) => ({ at: new Date(Number(r.at)).toISOString(), who: String(r.who), what: String(r.what), about: String(r.about ?? '') }));
  }
  /** One more of a kind in a period, if the period's allowance has room. */
  take(period: string, kind: string, limit: number): Taken {
    const had = this.n(`SELECT n FROM counts WHERE period = ? AND kind = ?`, period, kind);
    if (had >= limit) return { ok: false, left: 0 };
    this.sql.exec(`INSERT INTO counts (period, kind, n) VALUES (?, ?, 1) ON CONFLICT (period, kind) DO UPDATE SET n = n + 1`, period, kind);
    this.sql.exec(`DELETE FROM counts WHERE period < ? AND length(period) = length(?)`, period, period);
    return { ok: true, left: limit - had - 1 };
  }
}

/** The Durable Object's methods (OrgStoreLogic's), called over RPC. */
export interface OrgStoreApi {
  info(): ReturnType<OrgStoreLogic['info']> | Promise<ReturnType<OrgStoreLogic['info']>>;
  member(email: string, now: number): OrgRole | null | Promise<OrgRole | null>;
  members(): OrgMember[] | Promise<OrgMember[]>;
  claim(email: string, now: number): ReturnType<OrgStoreLogic['claim']> | Promise<ReturnType<OrgStoreLogic['claim']>>;
  invite(email: string, role: OrgRole, by: string, now: number): ReturnType<OrgStoreLogic['invite']> | Promise<ReturnType<OrgStoreLogic['invite']>>;
  remove(email: string, by: string, now: number): ReturnType<OrgStoreLogic['remove']> | Promise<ReturnType<OrgStoreLogic['remove']>>;
  parts(): OrgPart[] | Promise<OrgPart[]>;
  part(key: string): (OrgPart & { app: string }) | null | Promise<(OrgPart & { app: string }) | null>;
  partFile(key: string, file: OrgFile, who: string, now: number): string | null | Promise<string | null>;
  putPart(p: Omit<OrgStored, 'revision'>, who: string, now: number): (OrgPart & { app: string }) | Promise<OrgPart & { app: string }>;
  dropPart(key: string, who: string, now: number): boolean | Promise<boolean>;
  audit(limit?: number): OrgEvent[] | Promise<OrgEvent[]>;
  take(period: string, kind: string, limit: number): Taken | Promise<Taken>;
}
