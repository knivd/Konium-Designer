/**
 * Konium's store (the konium-vcs Worker at konium.app/api/vcs): blobs a team keeps, each sealed
 * with the team's key before it leaves and opened after it arrives. A blob is read with its tag
 * and written only if it is still that version (or only if it is new), so two people pushing at
 * once can't overwrite each other: the second is told to update first.
 *
 * What a team keeps: "index" (its projects: id and name), and for each project "r/<id>/refs"
 * (its branch and the packs it is made of, in order) and "r/<id>/p/<pack>" (Git pack files).
 */
import { teamCrypto, type TeamCrypto } from './keys';

export const STORE_URL = 'https://konium.app/api/vcs';

/** Someone else wrote the blob since it was read. */
export class StoreConflict extends Error { constructor() { super('Changed in the store since it was read'); } }

export interface Blob2 { data: Uint8Array; tag: string }

export class KoniumStore {
  private constructor(private c: TeamCrypto, private base: string, private fetcher: typeof fetch) {}
  static async open(key: string, base = STORE_URL, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<KoniumStore> {
    return new KoniumStore(await teamCrypto(key), base.replace(/\/$/, ''), fetcher);
  }
  get teamId(): string { return this.c.id; }
  private async call(method: string, name: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    let r: Response;
    try {
      r = await this.fetcher(`${this.base}/blob/${name.split('/').map(encodeURIComponent).join('/')}`, {
        method, headers: { authorization: `Bearer ${this.c.token}`, ...init.headers }, body: init.body as BodyInit | undefined,
      });
    } catch (e) { throw new Error(`Konium's store can't be reached (${(e as Error).message}): check the connection`); }
    if (r.status === 412) throw new StoreConflict();
    if (r.status === 404 && method === 'GET') return r;
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      let msg = t;
      try { msg = (JSON.parse(t) as { error?: string }).error ?? t; } catch { /* plain text */ }
      throw new Error(`Konium's store: ${msg || r.statusText || r.status}`);
    }
    return r;
  }
  /** A blob and its tag, or null when there is none. */
  async get(name: string): Promise<Blob2 | null> {
    const r = await this.call('GET', name);
    if (r.status === 404) return null;
    const sealed = new Uint8Array(await r.arrayBuffer());
    return { data: await this.c.open(name, sealed), tag: r.headers.get('etag') ?? '' };
  }
  /** A blob written: new only (tag null), or only if it is still the version tagged; its new tag. */
  async put(name: string, data: Uint8Array, tag: string | null): Promise<string> {
    const body = await this.c.seal(name, data);
    const r = await this.call('PUT', name, { body, headers: tag === null ? { 'if-none-match': '*' } : { 'if-match': tag } });
    return r.headers.get('etag') ?? (await r.json().catch(() => ({})) as { etag?: string }).etag ?? '';
  }
  async getJson<T>(name: string): Promise<{ value: T; tag: string } | null> {
    const b = await this.get(name);
    return b && { value: JSON.parse(new TextDecoder().decode(b.data)) as T, tag: b.tag };
  }
  putJson(name: string, value: unknown, tag: string | null): Promise<string> { return this.put(name, new TextEncoder().encode(JSON.stringify(value)), tag); }
}

/** The team's projects. */
export interface TeamIndex { name?: string; projects: { id: string; name: string; at: number }[] }
/** A project in the store: its branch head and the packs it is made of. */
export interface StoreRefs { head: string | null; packs: string[] }

/** A new project id. */
export const newRepoId = (): string => [...crypto.getRandomValues(new Uint8Array(9))].map((x) => x.toString(36).padStart(2, '0')).join('').slice(0, 14);
