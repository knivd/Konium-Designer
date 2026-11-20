/**
 * The Konium AI service's own records, in its Durable Object's SQLite (one object for the whole
 * service, so counts are exact): each user's jobs per day (users known only by a salted hash of
 * their IP address), what the day's jobs cost, and the shared cache — answers designers accepted,
 * by the datasheet's fingerprint and what was asked. A key's answer is the one most users
 * accepted (each user counts once per key), the newest on a tie: one person can't overrule many.
 */

/** The part of SQLite this needs (Durable Objects' ctx.storage.sql; node:sqlite in tests). */
export interface Sql { exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] } }

/** The most answers the shared cache keeps (each up to 64 KB: some hundreds of megabytes at the very most). */
export const MAX_ANSWERS = 20_000;

export interface Taken { ok: boolean; left: number }
export interface Cached { answer: unknown; acceptedBy: number }

export class StoreLogic {
  constructor(private sql: Sql, private maxAnswers = MAX_ANSWERS) {
    sql.exec(`CREATE TABLE IF NOT EXISTS jobs (day TEXT, client TEXT, kind TEXT, n INTEGER, PRIMARY KEY (day, client, kind))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS spend (day TEXT PRIMARY KEY, usd REAL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS answers (key TEXT, hash TEXT, answer TEXT, updated INTEGER, PRIMARY KEY (key, hash))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS votes (key TEXT, client TEXT, hash TEXT, PRIMARY KEY (key, client))`);
  }

  /** One more job of a kind for a user today, using `units` of the day's limit (a dearer model's job uses more), if it allows. */
  take(day: string, client: string, kind: string, limit: number, units = 1): Taken {
    const n = Number(this.sql.exec(`SELECT n FROM jobs WHERE day = ? AND client = ? AND kind = ?`, day, client, kind).toArray()[0]?.n ?? 0);
    const u = Math.max(1, Math.round(units));
    if (n + u > limit) return { ok: false, left: Math.max(0, limit - n) };
    this.sql.exec(`INSERT INTO jobs (day, client, kind, n) VALUES (?, ?, ?, ?) ON CONFLICT (day, client, kind) DO UPDATE SET n = n + excluded.n`, day, client, kind, u);
    return { ok: true, left: limit - n - u };
  }

  /** How many jobs of a kind a user has left today. */
  left(day: string, client: string, kind: string, limit: number): number {
    const n = Number(this.sql.exec(`SELECT n FROM jobs WHERE day = ? AND client = ? AND kind = ?`, day, client, kind).toArray()[0]?.n ?? 0);
    return Math.max(0, limit - n);
  }

  spent(day: string): number { return Number(this.sql.exec(`SELECT usd FROM spend WHERE day = ?`, day).toArray()[0]?.usd ?? 0); }
  spend(day: string, usd: number): void {
    if (!(usd > 0)) return;
    this.sql.exec(`INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd`, day, usd);
  }
  /**
   * A job's likely cost set aside before the model is asked, if the day's budget is not used up:
   * looked at and taken in one step, so jobs started together cannot each see a budget only one
   * of them may use. Settled to what the job did cost when it ends (settle).
   */
  reserve(day: string, usd: number, budget: number): boolean {
    if (this.spent(day) >= budget) return false;
    this.sql.exec(`INSERT INTO spend (day, usd) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET usd = usd + excluded.usd`, day, Math.max(0, usd));
    return true;
  }
  /** What was set aside put right: `delta` is what the job cost less what was set aside (so it may take away). */
  settle(day: string, delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;
    this.sql.exec(`INSERT INTO spend (day, usd) VALUES (?, MAX(0, ?)) ON CONFLICT (day) DO UPDATE SET usd = MAX(0, usd + ?)`, day, delta, delta);
  }

  /** The answer most users accepted for a key. */
  cached(key: string): Cached | null {
    const best = this.sql.exec(
      `SELECT v.hash AS hash, COUNT(*) AS n, a.answer AS answer FROM votes v JOIN answers a ON a.key = v.key AND a.hash = v.hash
       WHERE v.key = ? GROUP BY v.hash ORDER BY n DESC, a.updated DESC LIMIT 1`, key).toArray()[0];
    if (!best) return null;
    try { return { answer: JSON.parse(String(best.answer)), acceptedBy: Number(best.n) }; } catch { return null; }
  }

  /** A user accepted this answer for a key (their earlier choice for it is replaced). */
  accept(key: string, client: string, answer: unknown, now: number): void {
    const text = JSON.stringify(answer);
    const hash = fnv(text);
    this.sql.exec(`INSERT INTO answers (key, hash, answer, updated) VALUES (?, ?, ?, ?) ON CONFLICT (key, hash) DO UPDATE SET updated = excluded.updated`, key, hash, text, now);
    this.sql.exec(`INSERT INTO votes (key, client, hash) VALUES (?, ?, ?) ON CONFLICT (key, client) DO UPDATE SET hash = excluded.hash`, key, client, hash);
    // Answers nobody stands by any more go
    this.sql.exec(`DELETE FROM answers WHERE key = ? AND hash NOT IN (SELECT hash FROM votes WHERE key = ?)`, key, key);
    // The cache has an end: past it the answers longest untouched go, with what was said for them
    const over = Number(this.sql.exec(`SELECT COUNT(*) AS n FROM answers`).toArray()[0]?.n ?? 0) - this.maxAnswers;
    if (over > 0) {
      this.sql.exec(`DELETE FROM answers WHERE rowid IN (SELECT rowid FROM answers ORDER BY updated ASC, rowid ASC LIMIT ?)`, over + Math.ceil(this.maxAnswers / 50));
      this.sql.exec(`DELETE FROM votes WHERE NOT EXISTS (SELECT 1 FROM answers a WHERE a.key = votes.key AND a.hash = votes.hash)`);
    }
  }
  /** How many answers the cache holds. */
  answers(): number { return Number(this.sql.exec(`SELECT COUNT(*) AS n FROM answers`).toArray()[0]?.n ?? 0); }

  /** Days long past: forgotten (the cache stays). */
  prune(before: string): void {
    this.sql.exec(`DELETE FROM jobs WHERE day < ?`, before);
    this.sql.exec(`DELETE FROM spend WHERE day < ?`, before);
  }
}

/** A short hash of an answer's JSON (FNV-1a, 2 × 32 bits). */
function fnv(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
