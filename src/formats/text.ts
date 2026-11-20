/**
 * Altium property strings are ANSI (Windows-1252 in practice) with optional %UTF8%-prefixed
 * duplicate keys for non-ASCII text. Internally we keep property values as "binary strings"
 * (one char per byte, U+0000–U+00FF) so untouched values round-trip byte-for-byte.
 */

export function bytesToBin(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return s;
}

export function binToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Windows-1252 0x80–0x9F block. 0 = undefined in cp1252, passes through as the C1 control.
const CP1252_HI = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];
const CP1252_REV = new Map<number, number>();
CP1252_HI.forEach((u, i) => { if (u) CP1252_REV.set(u, 0x80 + i); });

/** Binary string (cp1252 bytes) → display string. */
export function cp1252ToStr(bin: string): string {
  // (nothing to map: as it is; a long value built a character at a time takes a rope node a character)
  if (!/[\x80-\x9f]/.test(bin)) return bin;
  let out = '';
  for (let i = 0; i < bin.length; i++) {
    const c = bin.charCodeAt(i);
    out += c >= 0x80 && c <= 0x9f && CP1252_HI[c - 0x80] ? String.fromCharCode(CP1252_HI[c - 0x80]!) : bin[i];
  }
  return out;
}

/** Display string → cp1252 binary string. Returns null if any char is unrepresentable. */
export function strToCp1252(s: string): string | null {
  // (all Latin-1 but cp1252's 0x80–0x9F block: as it is)
  if (!/[^\x00-\x7f\xa0-\xff]/.test(s)) return s;
  let out = '';
  for (const ch of s) {
    const u = ch.codePointAt(0)!;
    if (u < 0x80 || (u >= 0xa0 && u <= 0xff)) out += String.fromCharCode(u);
    else if (CP1252_REV.has(u)) out += String.fromCharCode(CP1252_REV.get(u)!);
    else return null;
  }
  return out;
}

/** Display string → cp1252 binary string, a character it can't hold as '?' (an 8-bit field). */
export function toCp1252Lossy(s: string): string {
  const all = strToCp1252(s);
  if (all !== null) return all;
  let out = '';
  for (const ch of s) out += strToCp1252(ch) ?? '?';
  return out;
}

/* ─── Other Windows code pages ───────────────────────────────────────────────────────── */

/**
 * The desktop software writes 8-bit text in the code page of the author's Windows (a %UTF8% twin
 * beside it only where it had one): Cyrillic in 1251 on a Bulgarian or Russian system, and so on.
 * Read as Western (1252) it comes out as ÇÀÕÐÀÍÂÀÍÅ. These are the single-byte pages it may be.
 */
export const CODE_PAGES = [1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258] as const;
export type CodePage = (typeof CODE_PAGES)[number];
const pageTables = new Map<number, string[] | null>();
/** Bytes 0x80–0xFF in a code page. */
function pageTable(cp: number): string[] | null {
  if (pageTables.has(cp)) return pageTables.get(cp)!;
  let t: string[] | null = null;
  try {
    const d = new TextDecoder(`windows-${cp}`);
    t = [];
    // (a byte the page leaves undefined shows as � : it can't be what the author typed)
    for (let b = 0x80; b <= 0xff; b++) { const c = d.decode(new Uint8Array([b])); t.push(c || '\ufffd'); }
  } catch { t = null; }
  pageTables.set(cp, t);
  return t;
}
const pageRevs = new Map<number, Map<string, number>>();
/** 8-bit text in a code page → display string. */
export function ansiToStr(bin: string, cp: number): string {
  if (cp === 1252 || !/[\x80-\xff]/.test(bin)) return cp1252ToStr(bin);
  const t = pageTable(cp);
  if (!t) return cp1252ToStr(bin);
  let out = '';
  for (let i = 0; i < bin.length; i++) { const c = bin.charCodeAt(i); out += c >= 0x80 && c <= 0xff ? t[c - 0x80]! : bin[i]; }
  return out;
}
/** Display string → 8-bit text in a code page; null if a character isn't in it. */
export function strToAnsi(s: string, cp: number): string | null {
  if (cp === 1252) return strToCp1252(s);
  if (!/[^\x00-\x7f]/.test(s)) return s;
  const t = pageTable(cp);
  if (!t) return strToCp1252(s);
  let rev = pageRevs.get(cp);
  if (!rev) { rev = new Map(t.map((c, i) => [c, 0x80 + i])); pageRevs.set(cp, rev); }
  let out = '';
  for (const ch of s) {
    const u = ch.codePointAt(0)!;
    if (u < 0x80) out += ch;
    else { const b = rev.get(ch); if (b === undefined) return null; out += String.fromCharCode(b); }
  }
  return out;
}

/** The code page of a browser language's Windows (bg → 1251, pl → 1250, el → 1253 …; else 1252). */
export function langCodePage(lang: string): CodePage {
  const l = lang.toLowerCase().split(/[-_]/)[0] ?? '';
  if (/^(bg|ru|uk|be|mk|sr|kk|ky|mn|tg|tt|ba)$/.test(l)) return 1251;
  if (/^(cs|pl|hu|sk|sl|hr|ro|bs|sq)$/.test(l)) return 1250;
  if (l === 'el') return 1253;
  if (/^(tr|az)$/.test(l)) return 1254;
  if (/^(he|iw|yi)$/.test(l)) return 1255;
  if (/^(ar|fa|ur)$/.test(l)) return 1256;
  if (/^(lt|lv|et)$/.test(l)) return 1257;
  if (l === 'vi') return 1258;
  return 1252;
}
const LATIN_PAGES = new Set<number>([1250, 1252, 1254, 1257, 1258]);
const LETTER = /\p{L}/u;
const LATIN = /\p{Script=Latin}/u;
/**
 * How unlikely a code page makes a file's words (lower: likelier): a byte past 0x7F that reads as
 * no letter inside a word (£ in Łódź read as Western, � where the page has no character); a word
 * of three or more letters none of them plain ASCII in a Latin page (ÇÀÕÐÀÍÂÀÍÅ); a word mixing
 * plain letters with another alphabet's (Јуdџ: Polish read as Cyrillic).
 */
function misfits(values: string[], cp: number): number {
  const latin = LATIN_PAGES.has(cp);
  let bad = 0;
  for (const v of values) {
    for (const w of v.split(/[^A-Za-z\x80-\xff]+/)) {
      if (w.length < 2) continue;
      let hi = 0, ascii = 0;
      for (let i = 0; i < w.length; i++) { if (w.charCodeAt(i) >= 0x80) hi++; else ascii++; }
      if (!hi) continue;
      const shown = ansiToStr(w, cp);
      let foreign = 0;
      for (let i = 0; i < w.length; i++) {
        if (w.charCodeAt(i) < 0x80) continue;
        const ch = shown[i] ?? '';
        if (!LETTER.test(ch)) bad++;
        else if (!LATIN.test(ch)) foreign++;
      }
      if (latin && !ascii && w.length >= 3) bad += hi;
      // (mixing alphabets inside a word is the least likely of all)
      if (!latin && ascii && foreign) bad += 2 * hi;
    }
  }
  return bad;
}
/**
 * The code page a file's 8-bit text is in, as best it can be told [est]: the page that makes its
 * words likeliest (misfits), the browser language's first when it does as well, then Western and
 * Cyrillic. Pages whose letters sit on the same bytes (Turkish and Western, Greek and Cyrillic,
 * Hebrew and Cyrillic) can't be told apart that way: the browser's language, or Preferences, decides.
 */
export function guessCodePage(values: Iterable<string>, lang = 'en'): CodePage {
  const vals: string[] = [];
  for (const v of values) if (/[\x80-\xff]/.test(v)) vals.push(v);
  const mine = langCodePage(lang);
  const pages = [...new Set<CodePage>([mine, 1252, 1251, 1250, 1253, 1254, 1255, 1256, 1257, 1258])];
  if (!vals.length) return LATIN_PAGES.has(mine) ? mine : 1252;
  let best = pages[0]!, least = Infinity;
  for (const cp of pages) { const n = misfits(vals, cp); if (n < least) { least = n; best = cp; } }
  return best;
}
/** Preferences › System › General › Text without Unicode: 'auto' (guessCodePage), or a code page. */
export const textPrefs: { codePage: 'auto' | CodePage; lang: string } = { codePage: 'auto', lang: typeof navigator !== 'undefined' ? navigator.language || 'en' : 'en' };
/** The code page for a file's text (its property values): as chosen, or guessed. */
export function codePageFor(values: Iterable<string>): CodePage {
  return textPrefs.codePage === 'auto' ? guessCodePage(values, textPrefs.lang) : textPrefs.codePage;
}

/** Display string → 8-bit text in a code page, a character it can't hold as '?' (an 8-bit field). */
export function toAnsiLossy(s: string, cp: number): string {
  const all = strToAnsi(s, cp);
  if (all !== null) return all;
  let out = '';
  for (const ch of s) out += strToAnsi(ch, cp) ?? '?';
  return out;
}

let readingPage: CodePage = 1252;
/** The code page of the file being read (property bags parsed now take it; 8-bit strings decode in it). */
export const currentCodePage = (): CodePage => readingPage;
/** Read a file in a code page: what is parsed meanwhile is in it. */
export function withCodePage<T>(cp: CodePage, f: () => T): T {
  const was = readingPage;
  readingPage = cp;
  try { return f(); } finally { readingPage = was; }
}
/** The property values in a file's raw streams ("|KEY=value"), %UTF8% twins left out. */
export function* rawValues(...streams: (Uint8Array | undefined | null)[]): Iterable<string> {
  for (const s of streams) {
    if (!s?.length) continue;
    const bin = bytesToBin(s);
    if (!/[\x80-\xff]/.test(bin)) continue;
    for (const m of bin.matchAll(/\|([A-Za-z0-9_.%]{1,64})=([^|\0]*)/g)) if (!m[1]!.startsWith('%UTF8%') && /[\x80-\xff]/.test(m[2]!)) yield m[2]!;
  }
}
/** The code page of a file, told from its raw property streams (or as chosen in Preferences). */
export const codePageOfStreams = (...streams: (Uint8Array | undefined | null)[]): CodePage => codePageFor(rawValues(...streams));

const te = new TextEncoder();
const td = new TextDecoder('utf-8', { fatal: false });

export function utf8ToBin(s: string): string { return bytesToBin(te.encode(s)); }
export function binToUtf8(bin: string): string { return td.decode(binToBytes(bin)); }

export function utf16le(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    const c = b[i]! | (b[i + 1]! << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function toUtf16le(s: string, withNul = true): Uint8Array {
  const out = new Uint8Array((s.length + (withNul ? 1 : 0)) * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[i * 2] = c & 0xff; out[i * 2 + 1] = c >> 8; }
  return out;
}

export const isAscii = (s: string): boolean => /^[\x00-\x7f]*$/.test(s);
