/**
 * Konium's parts service's own records, in its Durable Object's SQLite (one object for the whole
 * service, so counts are exact): each user's lookups a day (users known only by a salted hash of
 * their IP address), each distributor's calls a day and a minute (its own limits), the answers kept
 * for a while (the same search answered without asking the distributor again), and Digi-Key's
 * access token while it lasts.
 */

/** The part of SQLite this needs (Durable Objects' ctx.storage.sql; node:sqlite in tests). */
export interface Sql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

export interface Taken { ok: boolean; left: number }

export class PartsStoreLogic {
  constructor(private sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS counts (day TEXT, who TEXT, kind TEXT, n INTEGER, PRIMARY KEY (day, who, kind))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS minutes (kind TEXT, minute INTEGER, n INTEGER, PRIMARY KEY (kind, minute))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, at INTEGER, body TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, value TEXT, until INTEGER)`);
  }

  /** One more of a kind today for someone (a user, or a distributor's whole day), if the limit allows. */
  take(day: string, who: string, kind: string, limit: number): Taken {
    const n = this.count(day, who, kind);
    if (n + 1 > limit) return { ok: false, left: Math.max(0, limit - n) };
    this.sql.exec(`INSERT INTO counts (day, who, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, who, kind) DO UPDATE SET n = n + 1`, day, who, kind);
    return { ok: true, left: limit - n - 1 };
  }
  left(day: string, who: string, kind: string, limit: number): number { return Math.max(0, limit - this.count(day, who, kind)); }
  private count(day: string, who: string, kind: string): number {
    return Number(this.sql.exec(`SELECT n FROM counts WHERE day = ? AND who = ? AND kind = ?`, day, who, kind).toArray()[0]?.n ?? 0);
  }

  /** One more call this minute to a distributor, if its per-minute limit allows. */
  takeMinute(kind: string, minute: number, limit: number): boolean {
    const n = Number(this.sql.exec(`SELECT n FROM minutes WHERE kind = ? AND minute = ?`, kind, minute).toArray()[0]?.n ?? 0);
    if (n + 1 > limit) return false;
    this.sql.exec(`INSERT INTO minutes (kind, minute, n) VALUES (?, ?, 1) ON CONFLICT (kind, minute) DO UPDATE SET n = n + 1`, kind, minute);
    return true;
  }

  /** An answer kept since `since` (ms), with when it was looked up. */
  answer(key: string, since: number): { at: number; body: unknown } | null {
    const r = this.sql.exec(`SELECT at, body FROM answers WHERE key = ? AND at >= ?`, key, since).toArray()[0];
    if (!r) return null;
    try { return { at: Number(r.at), body: JSON.parse(String(r.body)) }; } catch { return null; }
  }
  keep(key: string, at: number, body: unknown): void {
    this.sql.exec(`INSERT INTO answers (key, at, body) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at, body = excluded.body`, key, at, JSON.stringify(body));
  }

  token(id: string, now: number): string | null {
    const r = this.sql.exec(`SELECT value, until FROM tokens WHERE id = ?`, id).toArray()[0];
    return r && Number(r.until) > now ? String(r.value) : null;
  }
  setToken(id: string, value: string, until: number): void {
    this.sql.exec(`INSERT INTO tokens (id, value, until) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET value = excluded.value, until = excluded.until`, id, value, until);
  }

  /** Days and answers long past: forgotten. */
  prune(beforeDay: string, beforeAt: number, beforeMinute: number): void {
    this.sql.exec(`DELETE FROM counts WHERE day < ?`, beforeDay);
    this.sql.exec(`DELETE FROM answers WHERE at < ?`, beforeAt);
    this.sql.exec(`DELETE FROM minutes WHERE minute < ?`, beforeMinute);
  }
}
