/**
 * The Design Adviser's datasheets: each part's found (a file the designer gave, the address in its
 * parameters, else the web through the Konium service or OpenRouter), fetched through the Konium
 * service (a maker's site won't let a page elsewhere read its PDFs), read here, and the pages a
 * check of the part needs picked from it. Kept for the session by part number.
 */
import { OFFLINE_NOTE, mayConnect } from '../platform/network';
import { allText, openDatasheet, type Datasheet } from './datasheet';
import { FIND, type PageText } from './jobs';
import { AiError, connection, runJob, serviceUrl, shareAccepted } from './client';
import { settings } from '../core/settings';

export type SheetSource = 'file' | 'parameter' | 'online';
export interface PartSheet { mpn: string; source: SheetSource; where: string; sheet: Datasheet; pages: PageText[] }

/** A part number as compared: upper case, letters and digits only. */
export const normMpn = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
const kept = new Map<string, PartSheet>();
export const keptSheet = (mpn: string) => kept.get(normMpn(mpn)) ?? null;
export const forgetSheet = (mpn: string) => { kept.delete(normMpn(mpn)); };


/** Reads a PDF (a file or a download) and keeps it for its part. */
export async function keepSheet(bytes: Uint8Array, name: string, mpn: string, source: SheetSource, where: string): Promise<PartSheet> {
  const sheet = await openDatasheet(bytes, name);
  const pages = await allText(sheet);
  const ps: PartSheet = { mpn, source, where, sheet, pages };
  kept.set(normMpn(mpn), ps);
  return ps;
}

/**
 * The part number a dropped datasheet is for: the one whose longest start (six characters at least:
 * a family's datasheet covers its packing and voltage variants, TPS7A02 for TPS7A0233PDBVR) its
 * name, else its first pages, give.
 */
export function matchFile(name: string, firstText: string, mpns: string[]): string | null {
  const reach = (hay: string, m: string) => { const n = normMpn(m); for (let k = n.length; k >= 6; k--) if (hay.includes(n.slice(0, k))) return k; return 0; };
  for (const hay of [normMpn(name), normMpn(firstText)]) {
    const best = mpns.map((m) => ({ m, k: reach(hay, m) })).filter((x) => x.k).sort((a, b) => b.k - a.k)[0];
    if (best) return best.m;
  }
  return null;
}

/** A PDF fetched through the Konium service (any mode: a maker's site doesn't let this page read it itself). */
export async function fetchPdf(url: string, mpn: string): Promise<{ bytes: Uint8Array; final: string }> {
  if (!mayConnect('ai')) throw new AiError(OFFLINE_NOTE);
  let res: Response;
  try { res = await fetch(`${serviceUrl()}/fetch?url=${encodeURIComponent(url)}&mpn=${encodeURIComponent(mpn)}`); } catch { throw new AiError('Can\'t reach the Konium service to fetch the datasheet'); }
  if (!res.ok) {
    let why = '';
    try { why = ((await res.json()) as { error?: string }).error ?? ''; } catch { /* no reason */ }
    throw new AiError(why || `The datasheet couldn't be fetched (${res.status})`);
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), final: res.headers.get('X-Source-Url') ?? url };
}

/** Whether datasheets can be looked for on the web here: through the service, or with an OpenRouter key. */
export const canSearch = () => settings.aiMode === 'konium' || (settings.aiMode === 'key' && connection('key').openrouter);

/**
 * A part's datasheet: kept already, else the address in its parameters, else found on the web
 * (each address the search gave tried in turn). What happened, for the steps shown.
 */
export async function findSheet(mpn: string, o: { url?: string; maker?: string; description?: string; onStep?: (s: string) => void }): Promise<PartSheet> {
  const had = keptSheet(mpn);
  if (had) return had;
  const tried: string[] = [];
  const attempt = async (url: string, source: SheetSource) => {
    try {
      const got = await fetchPdf(url, mpn);
      return await keepSheet(got.bytes, decodeURIComponent(got.final.split(/[?#]/)[0]!.split('/').pop() || `${mpn}.pdf`), mpn, source, got.final);
    } catch (e) { tried.push(`${url}: ${(e as Error).message}`); return null; }
  };
  if (o.url) {
    o.onStep?.('fetching the datasheet its parameters give');
    const ps = await attempt(o.url, 'parameter');
    if (ps) return ps;
  }
  if (!canSearch()) throw new AiError(o.url ? `Its datasheet couldn't be fetched (${tried[0] ?? ''}): drop the PDF here` : 'No datasheet given: drop the PDF here (finding one on the web needs the Konium service or an OpenRouter key)');
  o.onStep?.('looking for its datasheet on the web');
  const key = await mpnKey(mpn);
  const found = await runJob(FIND, { mpn, maker: o.maker ?? '', description: o.description ?? '' }, { cacheKey: key });
  for (const url of found.value.urls.slice(0, 4)) {
    o.onStep?.(`fetching ${hostOf(url)}`);
    const ps = await attempt(url, 'online');
    // A datasheet that came: kept for the next designer using the part (only its address: the part number is public)
    if (ps) { if (!found.cached) void shareAccepted('datasheet', key, { url: ps.where, maker: found.value.maker, title: found.value.title }); return ps; }
  }
  throw new AiError(`No datasheet could be fetched (${found.value.urls.slice(0, 2).map(hostOf).join(', ')}): drop the PDF here`);
}
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };

/** The shared cache's key for a part number's datasheet (the maker's part number is public). */
export async function mpnKey(mpn: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mpn:${normMpn(mpn)}`)));
  return [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** What a page is about, for a part's check: the more of these, the more it is wanted (pin functions and ratings most). */
const WANTED: [RegExp, number][] = [
  [/pin (configuration|description|functions?|assignments?|definitions?)|terminal functions|pinout|ball (map|assignment)/i, 6],
  [/absolute maximum/i, 5], [/recommended operating/i, 5],
  [/typical application|application (circuit|information|schematic)|reference design|simplified schematic/i, 4],
  [/layout|decoupling|bypass|input capacitor|output capacitor|external components|power supply recommendations|exposed (thermal )?pad|thermal pad/i, 3],
  [/electrical characteristics/i, 2], [/feature description|functional description|detailed description|pull-?up|enable|reset/i, 1],
];
/** Pages a part's check needs, within `budget` characters (the first page always: what the part is); the application circuit's pages too as pictures. */
export function pagesForCheck(pages: PageText[], budget: number): { pages: PageText[]; circuit: number[] } {
  const score = (p: PageText) => WANTED.reduce((s, [re, w]) => s + (re.test(p.text) ? w : 0), 0) - (/ordering information|package (outline|dimensions)|tape and reel|revision history|important notice/i.test(p.text) ? 4 : 0);
  const ranked = pages.filter((p) => p.page !== 1 && p.text.trim()).map((p) => ({ p, s: score(p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.p.page - b.p.page);
  const out: PageText[] = [];
  let used = 0;
  const per = Math.max(3000, Math.round(budget / 6));
  const add = (p: PageText) => { const text = p.text.length > per ? `${p.text.slice(0, per)} …` : p.text; if (used + text.length > budget) return false; out.push({ page: p.page, text }); used += text.length; return true; };
  const first = pages.find((p) => p.page === 1);
  if (first) add(first);
  for (const { p } of ranked) if (!add(p) && used > budget * 0.9) break;
  const circuit = ranked.filter((x) => /typical application|application (circuit|schematic)|simplified schematic|reference design/i.test(x.p.text)).map((x) => x.p.page).slice(0, 2);
  return { pages: out.sort((a, b) => a.page - b.page), circuit };
}
