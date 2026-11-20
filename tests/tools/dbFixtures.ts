/**
 * Small database files for the readers' tests, written the way the formats lay them out: an
 * Excel 97–2003 workbook (BIFF8 in a compound file, its shared strings split over a CONTINUE
 * record) and a Jet 4 (Access 2000–2003) database (catalogue, table definition, data pages,
 * compressed and wide text, an inline and a single-page memo, a deleted row).
 */
import { newEntry, writeCfb, cfbPut } from '../../src/formats/cfb/cfb';

class W {
  b: number[] = [];
  u8(v: number) { this.b.push(v & 255); return this; }
  u16(v: number) { this.u8(v); this.u8(v >> 8); return this; }
  u32(v: number) { this.u16(v & 0xffff); this.u16(v >>> 16); return this; }
  f64(v: number) { const d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v, true); for (let i = 0; i < 8; i++) this.u8(d.getUint8(i)); return this; }
  ascii(s: string) { for (const c of s) this.u8(c.charCodeAt(0)); return this; }
  wide(s: string) { for (const c of s) this.u16(c.charCodeAt(0)); return this; }
  bytes(a: ArrayLike<number>) { for (let i = 0; i < a.length; i++) this.u8(a[i]!); return this; }
  get length() { return this.b.length; }
}

/* ─── BIFF8 ─────────────────────────────────────────────────────────────────────────── */

const rec = (type: number, body: W | number[]) => { const data = Array.isArray(body) ? body : body.b; return new W().u16(type).u16(data.length).bytes(data).b; };

/** A workbook of one sheet "Parts": header and records as text, numbers, RKs, a formula's text, a boolean and a date. */
export function makeXls(): Uint8Array {
  // Shared strings; the last one's characters run on into a CONTINUE record (which starts with its own high-byte flag)
  const strings = ['Part Number', 'Value', 'Qty', 'Price', 'Fitted', 'Added', 'Note', 'R-1', '10k', 'C-2', '100nF', '2.2 kΩ'];
  const sst = new W().u32(strings.length + 1).u32(strings.length + 1);
  for (const s of strings) {
    const wide = [...s].some((c) => c.charCodeAt(0) > 255);
    sst.u16(s.length).u8(wide ? 1 : 0);
    if (wide) sst.wide(s); else sst.ascii(s);
  }
  const long = 'A long note that runs on';
  sst.u16(long.length).u8(0).ascii(long.slice(0, 10));
  const cont = new W().u8(1).wide(long.slice(10)); // the rest as two-byte characters
  const xf = (fmt: number) => new W().u16(0).u16(fmt).u16(0).u8(0).u8(0).u32(0).u32(0).u16(0);
  const name = 'Parts';
  const globals = (sheetPos: number) => [
    ...rec(0x0809, new W().u16(0x0600).u16(0x0005).u16(0).u16(0).u32(0).u32(0)),
    ...rec(0x0022, new W().u16(0)),
    ...rec(0x041e, new W().u16(164).u16(10).u8(0).ascii('yyyy-mm-dd')),
    ...rec(0x00e0, xf(0)), ...rec(0x00e0, xf(164)), ...rec(0x00e0, xf(14)),
    ...rec(0x0085, new W().u32(sheetPos).u8(0).u8(0).u8(name.length).u8(0).ascii(name)),
    ...rec(0x00fc, sst), ...rec(0x003c, cont),
    ...rec(0x000a, []),
  ];
  const lsst = (r: number, c: number, i: number) => rec(0x00fd, new W().u16(r).u16(c).u16(0).u32(i));
  const rk = (v: number) => (v << 2) | 2;
  const sheet = [
    ...rec(0x0809, new W().u16(0x0600).u16(0x0010).u16(0).u16(0).u32(0).u32(0)),
    ...[0, 1, 2, 3, 4, 5, 6].flatMap((c) => lsst(0, c, c)),
    // R-1: 10k, 5 (RK), 0.25 (RK hundredths), TRUE, a date (2026-03-01 = 46082), the long note
    ...lsst(1, 0, 7), ...lsst(1, 1, 8), ...rec(0x027e, new W().u16(1).u16(2).u16(0).u32(rk(5))), ...rec(0x027e, new W().u16(1).u16(3).u16(0).u32((25 << 2) | 3)),
    ...rec(0x0205, new W().u16(1).u16(4).u16(0).u8(1).u8(0)), ...rec(0x0203, new W().u16(1).u16(5).u16(1).f64(46082)), ...lsst(1, 6, strings.length),
    // C-2: a formula giving text, 12 and 3.5 as MULRK, FALSE, a built-in date format, a plain LABEL
    ...lsst(2, 0, 9), ...rec(0x0006, new W().u16(2).u16(1).u16(0).bytes([0, 0, 0, 0, 0, 0, 0xff, 0xff]).u16(0).u32(0).u16(0)), ...rec(0x0207, new W().u16(5).u8(0).ascii('100nF')),
    ...rec(0x00bd, new W().u16(2).u16(2).u16(0).u32(rk(12)).u16(0).u32((350 << 2) | 3).u16(3)),
    ...rec(0x0205, new W().u16(2).u16(4).u16(0).u8(0).u8(0)), ...rec(0x0203, new W().u16(2).u16(5).u16(2).f64(46082.5)),
    ...rec(0x0204, new W().u16(2).u16(6).u16(0).u16(6).u8(1).wide('2.2 kΩ')),
    ...rec(0x000a, []),
  ];
  const g = globals(0);
  const wb = new Uint8Array([...globals(g.length), ...sheet]);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'Workbook', wb);
  return writeCfb(root);
}

/* ─── Jet 4 ─────────────────────────────────────────────────────────────────────────── */

const PG = 4096;
interface JCol { name: string; type: number; size: number; fixed: boolean }
type JVal = string | number | boolean | null | { lval: 'page'; row: number; page: number; len: number };

/** UCS-2 text, or Jet 4's compressed form (FF FE then one byte a character) when it is all Latin-1. */
const jetText = (s: string, compress: boolean): number[] => (compress && [...s].every((c) => c.charCodeAt(0) < 256 && c.charCodeAt(0) > 0)
  ? [0xff, 0xfe, ...[...s].map((c) => c.charCodeAt(0))] : new W().wide(s).b);

function tdef(cols: JCol[], rows: number): Uint8Array {
  const p = new Uint8Array(PG);
  const dv = new DataView(p.buffer);
  p[0] = 2; p[1] = 1;
  dv.setUint32(16, rows, true);
  p[40] = 0x4e;
  const vars = cols.filter((c) => !c.fixed).length;
  dv.setUint16(41, cols.length, true); dv.setUint16(43, vars, true); dv.setUint16(45, cols.length, true);
  let at = 63, fixedOff = 0, varNum = 0;
  cols.forEach((c, i) => {
    p[at] = c.type;
    dv.setUint16(at + 5, i, true); dv.setUint16(at + 7, c.fixed ? 0 : varNum++, true); dv.setUint16(at + 9, i, true);
    p[at + 15] = c.fixed ? 1 : 2;
    dv.setUint16(at + 21, c.fixed ? fixedOff : 0, true); dv.setUint16(at + 23, c.size, true);
    if (c.fixed && c.type !== 1) fixedOff += c.size;
    at += 25;
  });
  for (const c of cols) { const n = new W().wide(c.name).b; dv.setUint16(at, n.length, true); p.set(n, at + 2); at += 2 + n.length; }
  dv.setUint32(8, at, true);
  return p;
}

function rowBytes(cols: JCol[], vals: JVal[]): number[] {
  const fixed: number[] = [], vars: number[][] = [];
  const mask = new Array<number>(Math.ceil(cols.length / 8)).fill(0);
  cols.forEach((c, i) => {
    const v = vals[i];
    const present = c.type === 1 ? v === true : v !== null && v !== undefined;
    if (present) mask[i >> 3]! |= 1 << (i & 7);
    if (c.type === 1) return;
    if (c.fixed) {
      const w = new W();
      if (c.type === 4) w.u32(Number(v ?? 0)); else if (c.type === 3) w.u16(Number(v ?? 0)); else if (c.type === 7 || c.type === 8) w.f64(Number(v ?? 0));
      fixed.push(...w.b);
      return;
    }
    if (!present) { vars.push([]); return; }
    if (c.type === 12) {
      if (typeof v === 'object' && v && 'lval' in v) vars.push(new W().u32(0x40000000 | v.len).u8(v.row).u8(v.page).u8(v.page >> 8).u8(v.page >> 16).u32(0).b);
      else { const t = jetText(String(v), true); vars.push(new W().u32(0x80000000 | t.length).u32(0).u32(0).bytes(t).b); }
    } else vars.push(jetText(String(v), i % 2 === 1));
  });
  const head = new W().u16(cols.length).bytes(fixed);
  const offs: number[] = [];
  for (const v of vars) { offs.push(head.length); head.bytes(v); }
  offs.push(head.length);
  const tail = new W();
  for (let i = offs.length - 1; i >= 0; i--) tail.u16(offs[i]!);
  tail.u16(vars.length).bytes(mask);
  return [...head.b, ...tail.b];
}

/** A data page of a table: rows packed from the page's end, a row's offset flagged 0x8000 when deleted. */
function dataPage(tdefPage: number, rows: { bytes: number[]; deleted?: boolean }[]): Uint8Array {
  const p = new Uint8Array(PG);
  const dv = new DataView(p.buffer);
  p[0] = 1; p[1] = 1;
  dv.setUint32(4, tdefPage, true);
  dv.setUint16(12, rows.length, true);
  let end = PG;
  rows.forEach((r, i) => { const start = end - r.bytes.length; p.set(r.bytes, start); dv.setUint16(14 + 2 * i, start | (r.deleted ? 0x8000 : 0), true); end = start; });
  return p;
}

export interface JetFixture { bytes: Uint8Array; expect: { name: string; columns: string[]; rows: Record<string, string>[] }[] }

export function makeJet(): JetFixture {
  const head = new Uint8Array(PG);
  head.set([0, 1, 0, 0], 0);
  head.set([...'Standard Jet DB'].map((c) => c.charCodeAt(0)), 4);
  new DataView(head.buffer).setUint32(0x14, 1, true);
  const cat: JCol[] = [{ name: 'Id', type: 4, size: 4, fixed: true }, { name: 'ParentId', type: 4, size: 4, fixed: true }, { name: 'Name', type: 10, size: 510, fixed: false },
    { name: 'Type', type: 3, size: 2, fixed: true }, { name: 'Flags', type: 4, size: 4, fixed: true }];
  const parts: JCol[] = [{ name: 'Part Number', type: 10, size: 100, fixed: false }, { name: 'Value', type: 10, size: 100, fixed: false }, { name: 'Qty', type: 4, size: 4, fixed: true },
    { name: 'Price', type: 7, size: 8, fixed: true }, { name: 'Fitted', type: 1, size: 0, fixed: true }, { name: 'Added', type: 8, size: 8, fixed: true },
    { name: 'Note', type: 12, size: 0, fixed: false }, { name: 'Datasheet', type: 12, size: 0, fixed: false }];
  const memo = 'A memo on a page of its own: Ω';
  const memoBytes = new W().wide(memo).b;
  const catRows = [
    { bytes: rowBytes(cat, [2, 0, 'MSysObjects', 1, 0x80000002 | 0]) },
    { bytes: rowBytes(cat, [4, 0, 'Parts', 1, 0]) },
    { bytes: rowBytes(cat, [9, 0, 'Q_Parts', 5, 0]) },
  ];
  const pages = [
    head, new Uint8Array(PG), tdef(cat, catRows.length), dataPage(2, catRows),
    tdef(parts, 2),
    dataPage(4, [
      { bytes: rowBytes(parts, ['R-1', '10k', 5, 0.25, true, 46082, 'Inline memo', { lval: 'page', row: 0, page: 6, len: memoBytes.length }]) },
      { bytes: rowBytes(parts, ['GONE', 'x', 1, 1, false, 0, null, null]), deleted: true },
      { bytes: rowBytes(parts, ['C-2', '2.2 kΩ', -3, 1e-7, false, 46082.5, null, null]) },
    ]),
    dataPage(0, [{ bytes: memoBytes }]),
  ];
  const out = new Uint8Array(PG * pages.length);
  pages.forEach((p, i) => out.set(p, i * PG));
  return {
    bytes: out,
    expect: [{ name: 'Parts', columns: parts.map((c) => c.name), rows: [
      { 'Part Number': 'R-1', Value: '10k', Qty: '5', Price: '0.25', Fitted: 'True', Added: '2026-03-01', Note: 'Inline memo', Datasheet: memo },
      { 'Part Number': 'C-2', Value: '2.2 kΩ', Qty: '-3', Price: '1e-7', Fitted: 'False', Added: '2026-03-01 12:00:00', Note: '', Datasheet: '' },
    ] }],
  };
}
