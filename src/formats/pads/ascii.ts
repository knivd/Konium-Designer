/**
 * What PADS's ASCII files share: their header (product, version, units), sections (*NAME* lines,
 * *REMARK* comments), whitespace-separated fields, and the units: mils, inches, millimetres or
 * BASIC (2/3 nm: 38100 a mil), here as AD's units (1/10000 mil).
 */
export type PadsUnits = 'MILS' | 'METRIC' | 'INCHES' | 'BASIC';

export interface PadsHeader { product: string; version: string; units: PadsUnits }

/** "!PADS-POWERPCB-V9.5-BASIC! …" or "*PADS-LOGIC-V9.0* …". */
export function padsHeader(first: string): PadsHeader | null {
  const m = /^[!*]PADS-([A-Z-]+?)-V?([\d.]+[A-Z]*)(?:-(MILS|METRIC|MM|INCHES|INCH|BASIC))?[-!* ]/i.exec(first);
  if (!m) return null;
  const u = (m[3] ?? 'MILS').toUpperCase();
  return { product: m[1]!.toUpperCase(), version: m[2]!, units: u === 'MM' ? 'METRIC' : u === 'INCH' ? 'INCHES' : u as PadsUnits };
}

/** AD units per file unit. */
export const UNIT_FACTOR: Record<PadsUnits, number> = { MILS: 1e4, INCHES: 1e7, METRIC: 1e7 / 25.4, BASIC: 1e4 / 38100 };

export const tokens = (line: string): string[] => { const t = line.trim(); return t ? t.split(/\s+/) : []; };
export const num = (s: string | undefined, def = 0): number => { const v = s === undefined ? NaN : Number(s); return Number.isFinite(v) ? v : def; };
/** A section line: *NAME* (and what follows on it). */
export const sectionOf = (line: string): string | null => { const m = /^\*([A-Z][A-Z ]*?)\*/.exec(line); return m ? m[1]!.trim() : null; };
/** A font line (PADS 2005 and later write one after each text's position line). */
export const isFontLine = (line: string): boolean => /^(Regular|Bold|Italic|Underline)\b|^"?(Default Font|<)/.test(line.trim());

/** Lines with a cursor. */
export class Lines {
  i = 0;
  constructor(readonly lines: string[]) {}
  get done(): boolean { return this.i >= this.lines.length; }
  peek(): string { return this.lines[this.i] ?? ''; }
  next(): string { return this.lines[this.i++] ?? ''; }
  /** The next line that isn't blank or a remark (undefined at the end). */
  nextData(): string | undefined {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i++]!;
      if (!l.trim() || l.startsWith('*REMARK*')) continue;
      return l;
    }
    return undefined;
  }
  peekData(): string | undefined {
    let j = this.i;
    while (j < this.lines.length) { const l = this.lines[j]!; if (l.trim() && !l.startsWith('*REMARK*')) return l; j++; }
    return undefined;
  }
}

/** A file's text from its bytes: in the code page its header names (…-CP1250*), else UTF-8 when it is, else Windows-1252 (PADS's default). */
export function padsText(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 120));
  const cp = /^[!*]PADS-[^\r\n]*?-CP(\d{3,4})[-!* ]/i.exec(head)?.[1];
  if (cp) { try { return new TextDecoder(`windows-${cp}`).decode(bytes); } catch { /* not a code page this browser has */ } }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** Windows code pages PADS writes, and what each byte above 127 is in them. */
const CODE_PAGES = [1252, 1250, 1251, 1253, 1254, 1257, 1255, 1256, 874, 1258];
const cpTables = new Map<number, Map<string, number>>();
function cpTable(cp: number): Map<string, number> | null {
  let t = cpTables.get(cp);
  if (t) return t;
  try {
    const dec = new TextDecoder(`windows-${cp}`);
    t = new Map();
    for (let b = 0x80; b <= 0xff; b++) { const ch = dec.decode(new Uint8Array([b])); if (ch !== '\ufffd' && !t.has(ch)) t.set(ch, b); }
    cpTables.set(cp, t);
    return t;
  } catch { return null; }
}

/**
 * Text as a PADS file's bytes: in Windows-1252 when that holds it all, else the first code page
 * that does (its number then in the header, after the version: *PADS-LOGIC-V9.0-CP1250*); what
 * none holds becomes '?'.
 */
export function padsBytes(text: string, header = true): Uint8Array {
  const extra = new Set<string>();
  for (const ch of text) if (ch.charCodeAt(0) > 127) extra.add(ch);
  let cp = 1252, table = cpTable(1252);
  if (extra.size) {
    for (const c of CODE_PAGES) { const t = cpTable(c); if (t && [...extra].every((ch) => t.has(ch))) { cp = c; table = t; break; } }
  }
  if (cp !== 1252 && header) text = text.replace(/^([!*]PADS-[A-Z-]+-V[\d.]+)([!*])/, `$1-CP${cp}$2`);
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 128) out.push(code);
    else { const b = table?.get(ch); out.push(b ?? 63); }
  }
  return new Uint8Array(out);
}
