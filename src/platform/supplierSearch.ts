/**
 * Searches at Digi-Key and Mouser, through Konium's parts service (konium.app/api/parts,
 * cloudflare/parts), which holds the author's keys: only what is asked for goes (a part number,
 * or a few words), nothing of the design. The service keeps answers for a day and limits each
 * user's new searches; see its README.
 */
import { OFFLINE_NOTE, mayConnect } from './network';
import type { SupplierId, SupplierPart } from '../model/suppliers';

/** The service: this site's when Konium is served from konium.app, else konium.app's. */
export function partsService(): string {
  const host = globalThis.location?.hostname ?? '';
  return /(^|\.)konium\.app$/.test(host) ? `${globalThis.location.origin}/api/parts` : 'https://konium.app/api/parts';
}

export interface PartsConfig { sources: { id: SupplierId; name: string; ready: boolean }[]; left: number; perDay: number; cacheHours: number }
export interface PartsAnswer { parts: SupplierPart[]; at: number; cached?: boolean; left?: number }

let config: Promise<PartsConfig | null> | null = null;
/** Which distributors the service searches (null: it can't be reached, or isn't there yet). Asked once. */
export function partsConfig(f: typeof fetch = fetch, again = false): Promise<PartsConfig | null> {
  if (!mayConnect('parts')) return Promise.resolve(null);
  if (!config || again) {
    config = f(`${partsService()}/config`, { headers: { Accept: 'application/json' } })
      .then(async (r) => (r.ok ? await r.json() as PartsConfig : null))
      .catch(() => null)
      .then((c) => { if (!c) config = null; return c; });
  }
  return config;
}

/** Parts at a distributor matching a search (or its own part number, exact). */
export async function searchSupplier(source: SupplierId, q: string, exact = false, f: typeof fetch = fetch): Promise<PartsAnswer> {
  if (!mayConnect('parts')) throw new Error(OFFLINE_NOTE);
  let res: Response;
  try {
    res = await f(`${partsService()}/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ source, q: q.trim(), exact }) });
  } catch {
    throw new Error('Konium\'s parts service can\'t be reached');
  }
  if (res.status === 404) throw new Error('Konium\'s parts service isn\'t there yet');
  const body = await res.json().catch(() => ({})) as Partial<PartsAnswer> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Konium's parts service: HTTP ${res.status}`);
  return { parts: body.parts ?? [], at: body.at ?? Date.now(), cached: body.cached, left: body.left };
}

/** Forget the service's answer about itself (tests). */
export function resetPartsConfig(): void { config = null; }
