/**
 * The team store's ledger, in a Durable Object's SQLite (one object for the whole store, so its
 * counts are exact): how much each team keeps, and what each user and the whole service have
 * taken today. The bucket holds the teams' sealed blobs; this holds only sizes and counts.
 *
 * It is what makes the limits hold: a team's allowance checked and taken in one step (so pushes
 * sent together can't each see room that only one of them has), new teams a day for each user
 * and for the service, megabytes a day for each user, and a ceiling on the whole store.
 */

/** The part of SQLite this needs (Durable Objects' ctx.storage.sql; node:sqlite in tests). */
export interface Sql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

export interface Taken { ok: boolean; left: number }
export interface Room { ok: boolean; why?: 'team' | 'store' }

export class LedgerLogic {
  constructor(private sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS teams (team TEXT PRIMARY KEY, bytes INTEGER, since INTEGER, last INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS counts (day TEXT, who TEXT, kind TEXT, n INTEGER, PRIMARY KEY (day, who, kind))`);
  }

  /** What a team keeps, in bytes; null for a team the ledger has not seen. */
  team(team: string): number | null {
    const r = this.sql.exec(`SELECT bytes FROM teams WHERE team = ?`, team).toArray()[0];
    return r ? Number(r.bytes) : null;
  }
  /** A team entered (a new one at 0, or one from before the ledger at what it kept). */
  enter(team: string, bytes: number, now: number): void {
    this.sql.exec(`INSERT INTO teams (team, bytes, since, last) VALUES (?, ?, ?, ?) ON CONFLICT (team) DO NOTHING`, team, Math.max(0, Math.round(bytes)), now, now);
  }
  /** Everything kept, in bytes. */
  total(): number { return Number(this.sql.exec(`SELECT COALESCE(SUM(bytes), 0) AS n FROM teams`).toArray()[0]?.n ?? 0); }

  /** Room for `delta` more bytes taken for a team, if its allowance and the store's ceiling allow (one step). */
  reserve(team: string, delta: number, maxTeam: number, maxStore: number, now: number): Room {
    const have = this.team(team) ?? 0;
    if (delta > 0 && have + delta > maxTeam) return { ok: false, why: 'team' };
    if (delta > 0 && this.total() + delta > maxStore) return { ok: false, why: 'store' };
    this.sql.exec(`UPDATE teams SET bytes = MAX(0, bytes + ?), last = ? WHERE team = ?`, Math.round(delta), now, team);
    return { ok: true };
  }
  /** Room given back (the write it was taken for did not happen). */
  release(team: string, delta: number): void { this.sql.exec(`UPDATE teams SET bytes = MAX(0, bytes - ?) WHERE team = ?`, Math.round(delta), team); }

  /** `units` more of a kind today for someone (a user, or 'everyone'), if the limit allows. */
  take(day: string, who: string, kind: string, limit: number, units = 1): Taken {
    const n = Number(this.sql.exec(`SELECT n FROM counts WHERE day = ? AND who = ? AND kind = ?`, day, who, kind).toArray()[0]?.n ?? 0);
    if (n + units > limit) return { ok: false, left: Math.max(0, limit - n) };
    this.sql.exec(`INSERT INTO counts (day, who, kind, n) VALUES (?, ?, ?, ?) ON CONFLICT (day, who, kind) DO UPDATE SET n = n + excluded.n`, day, who, kind, units);
    return { ok: true, left: limit - n - units };
  }
  /** Days long past: forgotten. */
  prune(beforeDay: string): void { this.sql.exec(`DELETE FROM counts WHERE day < ?`, beforeDay); }
}
