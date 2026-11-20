/**
 * Parts at JLCPCB (LCSC numbers, stock, price breaks, JLCPCB's Basic / Preferred / Extended
 * assembly library), looked up at jlcsearch.tscircuit.com: a free, open service over JLCPCB's
 * parts list (MIT-licensed, refreshed from JLCPCB) that answers browsers directly. Only what is
 * asked for goes (a part number, or a value and package); nothing of the design.
 */
import { OFFLINE_NOTE, mayConnect } from './network';
import type { PriceBreak } from '../model/activeBom';

export const JLC_SEARCH = 'https://jlcsearch.tscircuit.com';

export interface JlcPart {
  lcsc: string;
  mpn: string;
  package: string;
  description: string;
  /** Units in stock; undefined when the service doesn't say (not none). */
  stock?: number;
  prices: PriceBreak[];
  library: 'Basic' | 'Preferred' | 'Extended';
  category: string;
}

/** Price breaks as the service gives them: JSON [{ qFrom, qTo, price }], or "1-9:0.01,10-99:0.008". */
export function parsePrices(p: unknown): PriceBreak[] {
  if (typeof p === 'number') return [{ qty: 1, price: p }];
  if (typeof p !== 'string' || !p.trim()) return [];
  try {
    const a = JSON.parse(p) as { qFrom?: number; min_qty?: number; price?: number }[];
    if (Array.isArray(a)) return a.map((x) => ({ qty: Number(x.qFrom ?? x.min_qty ?? 1), price: Number(x.price) })).filter((x) => Number.isFinite(x.price) && x.price > 0).sort((x, y) => x.qty - y.qty);
  } catch { /* the text form */ }
  return p.split(',').map((t) => { const [q, v] = t.split(':'); return { qty: Number((q ?? '').split('-')[0]), price: Number(v) }; }).filter((x) => Number.isFinite(x.qty) && Number.isFinite(x.price) && x.price > 0);
}

interface Row { lcsc?: number; mfr?: string; package?: string; description?: string; stock?: number | null; price?: unknown; price1?: number; is_basic?: boolean; is_preferred?: boolean; category?: string; subcategory?: string }
export function toPart(r: Row): JlcPart {
  const prices = parsePrices(r.price ?? r.price1);
  return {
    lcsc: `C${r.lcsc ?? 0}`, mpn: r.mfr ?? '', package: r.package ?? '', description: r.description ?? '', stock: r.stock === null || r.stock === undefined || !Number.isFinite(Number(r.stock)) ? undefined : Number(r.stock), prices,
    library: r.is_basic ? 'Basic' : r.is_preferred ? 'Preferred' : 'Extended', category: [r.category, r.subcategory].filter(Boolean).join(' › '),
  };
}

/** Parts matching a search (an LCSC number, a part number, or words: "100nF 0402"), most in stock first. */
export async function searchJlc(query: string, f: typeof fetch = fetch): Promise<JlcPart[]> {
  const q = query.trim();
  if (!q) return [];
  if (!mayConnect('parts')) throw new Error(OFFLINE_NOTE);
  const res = await f(`${JLC_SEARCH}/components/list.json?search=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`JLCPCB parts search: HTTP ${res.status}`);
  const body = await res.json() as { components?: Row[] };
  const parts = (body.components ?? []).filter((r) => r.lcsc).map(toPart);
  const exact = /^C(\d+)$/i.exec(q);
  if (exact) return parts.filter((p) => p.lcsc.toUpperCase() === q.toUpperCase());
  const lower = q.toLowerCase();
  // The part number asked for first, then Basic parts, then by stock
  return parts.sort((a, b) => Number(b.mpn.toLowerCase() === lower) - Number(a.mpn.toLowerCase() === lower) || Number(b.library === 'Basic') - Number(a.library === 'Basic') || (b.stock ?? -1) - (a.stock ?? -1));
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * A part someone named (a model's suggestion) found at JLCPCB: by its LCSC number when given and
 * the part there is the one named, else by its part number exactly. `note` says what didn't match.
 */
export async function verifyPart(mpn: string, lcsc: string, f: typeof fetch = fetch): Promise<{ part: JlcPart | null; note: string }> {
  let note = '';
  if (lcsc) {
    const h = (await searchJlc(lcsc, f))[0];
    if (h && (!mpn || norm(h.mpn) === norm(mpn))) return { part: h, note };
    note = h ? `${lcsc} is ${h.mpn} at JLCPCB, not ${mpn}` : `${lcsc} isn't at JLCPCB`;
  }
  if (mpn) {
    const h = (await searchJlc(mpn, f)).find((x) => norm(x.mpn) === norm(mpn));
    if (h) return { part: h, note: note ? `${note}; found as ${h.lcsc}` : '' };
    note = note || 'not at JLCPCB';
  }
  return { part: null, note };
}
