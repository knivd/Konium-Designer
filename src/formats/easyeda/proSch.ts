/**
 * EasyEDA Pro schematics as AD's: a SchDoc per page, a SchLib of the symbols (their parts as AD's
 * parts; the footprints their devices use as their footprint models), parts placed as EasyEDA turns
 * and mirrors them, pins (length, the way they point, dot, clock, name and number and whether
 * shown, electrical type), the designator and the comment (the device's name or value) where they
 * are, the device's other attributes as parameters (shown where EasyEDA shows them), its footprint;
 * wires with their net labels (a net named but not labelled gets a label, as its name joins it
 * across the pages), junctions where wires meet, net flags as power ports in their style, net ports
 * as ports, no-connect marks, text, lines, polygons, arcs, circles, ellipses, rectangles, curves;
 * the page's frame and title block kept as drawn (AD's off). EasyEDA's names join across the pages:
 * the project's Net Identifier Scope is Global, and a name both a label and a flag or a port gets a
 * net label at the flag or port, as EasyEDA joins them. EasyEDA's unit (0.01 inch) is AD's.
 */
import { PropertyBag } from '../altium/props';
import { cfbPut, newEntry, writeCfb } from '../cfb/cfb';
import { joinSchRecords } from '../altium/framing';
import { binToBytes } from '../text';
import { writeSchLib } from '../altium/schlib';
import { SR } from '../../model/sch';
import { toBgr } from '../../model/common';
import { uniqueId } from '../../model/schEdit';
import { COL, Fonts, Records, arcThrough, justification, lengthKeys, orientOf, radius, type Props } from '../kicad/schematic';
import { uniqueIdFor } from '../kicad/board';
import { textValue } from './common';
import { proValue } from './proPcb';
import { proNames, type ProDoc, type ProProject, type Rec } from './proRead';

type Pt = { x: number; y: number };
export interface ProSchResult { sheets: { name: string; bytes: Uint8Array }[]; library: Uint8Array; symbols: number; warnings: string[]; stats: { sheets: number; parts: number; nets: number; symbols: number } }

const n = (v: unknown, d = 0): number => { const x = typeof v === 'number' ? v : v === null || v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(x) ? x : d; };
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const yes = (v: unknown) => v === true || v === 1 || v === '1' || v === 'yes' || v === 'true';
const norm = (a: number) => ((a % 360) + 360) % 360;
const quarter = (a: number) => ((Math.round(norm(a) / 90) % 4) + 4) % 4;
const colour = (v: unknown, def: number): number => { const m = /^#?([0-9a-f]{6})$/i.exec(s(v).trim()); return m ? toBgr(parseInt(m[1]!, 16)) : def; };
/** EasyEDA's line width (0.01 inch) as AD's: smallest, small, medium, large. */
const lineWidth = (w: number | undefined) => (w === undefined || !Number.isFinite(w) ? 1 : w < 0.75 ? 0 : w < 1.5 ? 1 : w < 3.5 ? 2 : 3);
/** An automatic net name ($1N123): no label for it. */
const autoNet = (name: string) => !name || /^\$\d*N\d+$/i.test(name);

/* ── styles: v2's named ones, v3's on each record ── */

interface FontLook { size?: number; color?: unknown; bold?: boolean; italic?: boolean; /** 0 left, 1 centre, 2 right */ h: number; /** 0 top, 1 middle, 2 bottom */ v: number }
interface LineLook { color?: unknown; dash: number; fill?: unknown; width?: number }
class Styles {
  fonts = new Map<string, FontLook>();
  lines = new Map<string, LineLook>();
  constructor(recs: Rec[]) {
    for (const r of recs) {
      if (r[0] === 'FONTSTYLE') this.fonts.set(s(r[1]), { size: n(r[5], NaN) || undefined, color: r[3] ?? r[2], italic: yes(r[6]), bold: yes(r[7]), h: n(r[11], 0), v: r[10] === null || r[10] === undefined ? 2 : n(r[10]) });
      else if (r[0] === 'LINESTYLE') this.lines.set(s(r[1]), { color: r[2], dash: n(r[3]), fill: r[4], width: n(r[5], NaN) });
    }
  }
  font(v: unknown): FontLook {
    if (typeof v === 'string') return this.fonts.get(v) ?? { h: 0, v: 2 };
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const [hs, vs] = s(o.align).toUpperCase().split('_');
      return { size: n(o.size, NaN) || undefined, color: o.color, bold: o.bold === true || /bold/i.test(s(o.bold)) || n(o.bold) >= 600, italic: yes(o.italic),
        h: hs === 'CENTER' ? 1 : hs === 'RIGHT' ? 2 : 0, v: vs === 'TOP' ? 0 : vs === 'MIDDLE' || vs === 'CENTER' ? 1 : 2 };
    }
    return { h: 0, v: 2 };
  }
  line(v: unknown): LineLook {
    if (typeof v === 'string') return this.lines.get(v) ?? { dash: 0 };
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const d = s(o.dash).toUpperCase();
      const fill = s(o.fillStyle).toUpperCase() === 'NONE' ? undefined : o.fill;
      return { color: o.color, dash: d === 'DASH' ? 1 : d === 'DOT' ? 2 : d === 'DASH_DOT' ? 3 : n(o.dash), fill, width: n(o.width, NaN) };
    }
    return { dash: 0 };
  }
}
const filled = (l: LineLook) => { const f = s(l.fill).trim().toLowerCase(); return !!f && f !== 'none' && f !== 'transparent'; };
const look = (l: LineLook, def = COL.body): Props => ({ COLOR: colour(l.color, def), LINEWIDTH: lineWidth(l.width), ...(l.dash > 0 ? { LINESTYLE: Math.min(3, l.dash), LINESTYLEEXT: Math.min(3, l.dash) } : {}) });
const fillOf = (l: LineLook): Props => (filled(l) ? { AREACOLOR: colour(l.fill, COL.fill), ISSOLID: true } : { AREACOLOR: colour(l.color, COL.fill), ISSOLID: false, TRANSPARENT: true });

/** A text's AD orientation and justification, kept readable (AD's text at 180° or 270° turned back, its anchor's side swapped). */
function textFrame(dirDeg: number, h: number, v: number, mirrored: boolean): { ORIENTATION: number; JUSTIFICATION: number } {
  let o = quarter(dirDeg), hh = h, vv = mirrored ? 2 - v : v;
  if (o >= 2) { o -= 2; hh = 2 - hh; vv = 2 - vv; }
  return { ORIENTATION: o, JUSTIFICATION: justification(hh, 2 - vv) };
}

/* ── symbols ── */

interface Sym { doc: ProDoc; type: number; parts: string[]; byPart: Map<string, Rec[]>; attrs: Map<string, Rec>; pinAttrs: Map<string, Map<string, Rec>>; st: Styles; bbox?: number[] }
function symbolOf(doc: ProDoc): Sym {
  const st = new Styles(doc.recs);
  const parts: string[] = [];
  const byPart = new Map<string, Rec[]>();
  const attrs = new Map<string, Rec>();
  const pinAttrs = new Map<string, Map<string, Rec>>();
  let cur = '';
  let bbox: number[] | undefined;
  for (const r of doc.recs) {
    if (r[0] === 'PART') {
      cur = s(r[1]);
      if (!parts.includes(cur)) parts.push(cur);
      const bb = (r[2] as { BBOX?: number[] } | undefined)?.BBOX;
      if (Array.isArray(bb) && !bbox) bbox = bb.map((x) => n(x));
      continue;
    }
    if (r[0] === 'ATTR') {
      const parent = s(r[2]);
      if (!parent) { if (!attrs.has(s(r[3]))) attrs.set(s(r[3]), r); }
      else { if (!pinAttrs.has(parent)) pinAttrs.set(parent, new Map()); pinAttrs.get(parent)!.set(s(r[3]), r); }
      continue;
    }
    if (!['PIN', 'RECT', 'CIRCLE', 'ELLIPSE', 'ARC', 'POLY', 'BEZIER', 'TEXT', 'OBJ', 'TABLE'].includes(s(r[0]))) continue;
    const part = r.part ?? cur;
    if (!parts.includes(part)) parts.push(part);
    if (!byPart.has(part)) byPart.set(part, []);
    byPart.get(part)!.push(r);
  }
  if (!parts.length) parts.push('');
  return { doc, type: doc.symbolType ?? 2, parts, byPart, attrs, pinAttrs, st, bbox };
}
const pinText = (sym: Sym, pinId: string, ...keys: string[]) => { const m = sym.pinAttrs.get(pinId); for (const k of keys) { const a = m?.get(k); if (a) return a; } return undefined; };
const PIN_TYPE: Record<string, number> = { IN: 0, INPUT: 0, OUT: 2, OUTPUT: 2, BI: 1, BIDIRECTIONAL: 1, POWER: 7, OPEN_COLLECTOR: 3, OC: 3, PASSIVE: 4, HIZ: 5 };

/**
 * A symbol's part drawn into records: its points by `place` (symbol → AD), `dir` its angles
 * (symbol → AD), `mirrored` its handedness; `own` OWNERINDEX and OWNERPARTID.
 */
function drawPart(rr: Records, sym: Sym, part: string, place: (p: Pt) => Pt, dir: (deg: number) => number, mirrored: boolean, own: Props, fonts: Fonts, warn: (w: string) => void, lib = false, pins = true, resolve: (v: string) => string = (v) => v): void {
  // A library's text keeps its font 1 (the SchLib has no font table of its own)
  const fontId = (f: FontLook) => (f.size && !lib ? fonts.id(f.size * 1.24 * 0.127, f.bold, f.italic) : 1);
  for (const r of sym.byPart.get(part) ?? []) {
    switch (r[0]) {
      case 'RECT': {
        const l = sym.st.line(r[9]);
        const a = place({ x: n(r[2]), y: n(r[3]) }), b = place({ x: n(r[4]), y: n(r[5]) });
        const rx = Math.abs(n(r[6])), ry = Math.abs(n(r[7]));
        if (n(r[8]) % 90 !== 0) {
          const c = Math.cos((n(r[8]) * Math.PI) / 180), sn = Math.sin((n(r[8]) * Math.PI) / 180), o = { x: n(r[2]), y: n(r[3]) };
          const w = n(r[4]) - o.x, h = n(r[5]) - o.y;
          const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([dx, dy]) => place({ x: o.x + dx! * c - dy! * sn, y: o.y + dx! * sn + dy! * c }));
          rr.points({ RECORD: SR.POLYGON, ...own, ...look(l), ...fillOf(l) }, pts);
          break;
        }
        const box = { LOCATION: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, CORNER: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } };
        if (rx > 0 || ry > 0) rr.add({ RECORD: SR.ROUND_RECTANGLE, ...own, ...look(l), ...fillOf(l), ...radius('CORNERXRADIUS', rx), ...radius('CORNERYRADIUS', ry || rx) }, box);
        else rr.add({ RECORD: SR.RECTANGLE, ...own, ...look(l), ...fillOf(l) }, box);
        break;
      }
      case 'CIRCLE': case 'ELLIPSE': {
        const ell = r[0] === 'ELLIPSE';
        const l = sym.st.line(r[ell ? 7 : 5]);
        const c = place({ x: n(r[2]), y: n(r[3]) });
        let rx = Math.abs(n(r[4])), ry = ell ? Math.abs(n(r[5])) : rx;
        if (ell && quarter(dir(n(r[6]))) % 2 === 1) [rx, ry] = [ry, rx];
        rr.add({ RECORD: SR.ELLIPSE, ...own, ...look(l), ...fillOf(l), ...radius('RADIUS', rx), ...radius('SECONDARYRADIUS', ry) }, { LOCATION: c });
        break;
      }
      case 'ARC': {
        const l = sym.st.line(r[8]);
        const arc = arcThrough(place({ x: n(r[2]), y: n(r[3]) }), place({ x: n(r[4]), y: n(r[5]) }), place({ x: n(r[6]), y: n(r[7]) }));
        if (arc) rr.add({ RECORD: SR.ARC, ...own, ...look(l), ...radius('RADIUS', arc.r), STARTANGLE: arc.start.toFixed(3), ENDANGLE: arc.end.toFixed(3) }, { LOCATION: arc.c });
        break;
      }
      case 'POLY': {
        const l = sym.st.line(r[4]);
        const v = (Array.isArray(r[2]) ? r[2] : []).map((x) => n(x));
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push(place({ x: v[i]!, y: v[i + 1]! }));
        if (pts.length < 2) break;
        const closed = yes(r[3]) || (pts.length > 2 && Math.hypot(pts[0]!.x - pts.at(-1)!.x, pts[0]!.y - pts.at(-1)!.y) < 1e-6);
        if (closed && filled(l) && pts.length >= 3) rr.points({ RECORD: SR.POLYGON, ...own, ...look(l), ...fillOf(l) }, pts);
        else if (pts.length === 2) rr.add({ RECORD: SR.LINE, ...own, ...look(l) }, { LOCATION: pts[0]!, CORNER: pts[1]! });
        else rr.points({ RECORD: SR.POLYLINE, ...own, ...look(l) }, closed && Math.hypot(pts[0]!.x - pts.at(-1)!.x, pts[0]!.y - pts.at(-1)!.y) > 1e-6 ? [...pts, pts[0]!] : pts);
        break;
      }
      case 'BEZIER': {
        const l = sym.st.line(r[3]);
        const v = (Array.isArray(r[2]) ? r[2] : []).map((x) => n(x));
        if (v.length >= 8) rr.points({ RECORD: SR.BEZIER, ...own, ...look(l) }, [0, 2, 4, 6].map((i) => place({ x: v[i]!, y: v[i + 1]! })));
        break;
      }
      case 'TEXT': {
        const text = textValue(s(r[5]));
        if (!text.trim() || r[2] === null || r[2] === undefined) break;
        const f = sym.st.font(r[6]);
        rr.add({ RECORD: SR.LABEL, ...own, TEXT: text, FONTID: fontId(f), COLOR: colour(f.color, COL.text), ...textFrame(dir(n(r[4])), f.h, f.v, mirrored) }, { LOCATION: place({ x: n(r[2]), y: n(r[3]) }) });
        break;
      }
      case 'PIN': {
        if (!pins) break;
        const id = s(r[1]);
        const hot0 = { x: n(r[4]), y: n(r[5]) }, len = Math.max(0, n(r[6])), rot = n(r[7]);
        const body0 = { x: hot0.x + len * Math.cos((rot * Math.PI) / 180), y: hot0.y + len * Math.sin((rot * Math.PI) / 180) };
        const hot = place(hot0), body = place(body0);
        const name = pinText(sym, id, 'NAME', 'Pin Name'), num = pinText(sym, id, 'NUMBER', 'Pin Number');
        const type = s(pinText(sym, id, 'Pin Type')?.[4]).toUpperCase();
        const elec = type ? PIN_TYPE[type] ?? 4 : ({ 1: 0, 2: 2, 3: 1 } as Record<number, number>)[n(r[3])] ?? 4;
        const shape = n(r[9]);
        const o = len > 0 ? orientOf(body, hot) : quarter(dir(rot + 180));
        rr.add({ RECORD: SR.PIN, ...own, ELECTRICAL: elec,
          PINCONGLOMERATE: o | (name && yes(name[6]) && s(name[4]) ? 0x08 : 0) | (num && yes(num[6]) ? 0x10 : 0) | (r[2] === false || r[2] === 0 ? 0x04 : 0),
          ...lengthKeys(len), NAME: textValue(s(name?.[4])), DESIGNATOR: s(num?.[4]) || id, COLOR: COL.pin,
          ...(shape & 2 ? { SYMBOL_OUTEREDGE: 1 } : {}), ...(shape & 1 ? { SYMBOL_INNEREDGE: 3 } : {}) }, { LOCATION: len > 0 ? body : hot });
        break;
      }
      case 'OBJ': warn('Images left out'); break;
      case 'TABLE': {
        // Its cells' edges and text (a title block): rows down from its top left, columns across
        const x0 = n(r[2]), y0 = n(r[3]);
        const rows = (Array.isArray(r[4]) ? r[4] : []).map((v) => n(v)), cols = (Array.isArray(r[5]) ? r[5] : []).map((v) => n(v));
        if (n(r[6]) % 360 !== 0) { warn('Turned tables left out'); break; }
        const xs = cols.reduce((a, w) => [...a, a.at(-1)! + w], [x0]), ys = rows.reduce((a, h) => [...a, a.at(-1)! - h], [y0]);
        const cells = (Array.isArray(r[7]) ? r[7] : []) as Record<string, unknown>[];
        // Cells a merged one covers: not drawn
        const covered = new Set<string>();
        for (const cell of cells) for (let i = 0; i < Math.max(1, n(cell.rowSpan, 1)); i++) for (let j = 0; j < Math.max(1, n(cell.colSpan, 1)); j++) if (i || j) covered.add(`${n(cell.rowIndex) + i},${n(cell.columnIndex) + j}`);
        for (const cell of cells) {
          const ri = n(cell.rowIndex), ci = n(cell.columnIndex), rs = Math.max(1, n(cell.rowSpan, 1)), cs = Math.max(1, n(cell.colSpan, 1));
          if (ri >= rows.length || ci >= cols.length || covered.has(`${ri},${ci}`)) continue;
          const a = { x: xs[ci]!, y: ys[ri]! }, b = { x: xs[Math.min(cols.length, ci + cs)]!, y: ys[Math.min(rows.length, ri + rs)]! };
          const pa = place(a), pb = place(b);
          rr.add({ RECORD: SR.RECTANGLE, ...own, COLOR: COL.body, LINEWIDTH: 1, ISSOLID: false, TRANSPARENT: true }, { LOCATION: { x: Math.min(pa.x, pb.x), y: Math.min(pa.y, pb.y) }, CORNER: { x: Math.max(pa.x, pb.x), y: Math.max(pa.y, pb.y) } });
          const text = textValue(resolve(s(cell.value)));
          if (!text.trim()) continue;
          const fs = (cell.fontStyle ?? {}) as Record<string, unknown>;
          const h = s(fs.hAlign).toUpperCase() === 'CENTER' ? 1 : s(fs.hAlign).toUpperCase() === 'RIGHT' ? 2 : 0;
          const v = s(fs.vAlign).toUpperCase() === 'TOP' ? 0 : s(fs.vAlign).toUpperCase() === 'BOTTOM' ? 2 : 1;
          const at = { x: h === 0 ? a.x + 3 : h === 1 ? (a.x + b.x) / 2 : b.x - 3, y: v === 0 ? a.y - 2 : v === 1 ? (a.y + b.y) / 2 : b.y + 2 };
          const f: FontLook = { size: n(fs.fontSize, NaN) || undefined, h, v };
          rr.add({ RECORD: SR.LABEL, ...own, TEXT: text, FONTID: fontId(f), COLOR: COL.text, ...textFrame(dir(0), h, v, mirrored) }, { LOCATION: place(at) });
        }
        break;
      }
      default:
    }
  }
}

/** A component's way onto the sheet: EasyEDA turns, then mirrors left to right. */
function placement(x: number, y: number, rot: number, mirror: boolean, P: (p: Pt) => Pt) {
  const q = quarter(rot), c = [1, 0, -1, 0][q]!, sn = [0, 1, 0, -1][q]!;
  return {
    place: (p: Pt) => { let px = p.x * c - p.y * sn; const py = p.x * sn + p.y * c; if (mirror) px = -px; return P({ x: x + px, y: y + py }); },
    dir: (deg: number) => (mirror ? 180 - (deg + q * 90) : deg + q * 90),
    // AD mirrors, then turns: the same placement
    orient: mirror ? (4 - q) % 4 : q, q,
  };
}

/* ── the schematic ── */

export function convertProSch(p: ProProject, schId: string, stem: string, footprintLib = ''): ProSchResult {
  const sch = p.schematics.get(schId);
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (w: string) => { if (!warned.has(w)) { warned.add(w); warnings.push(w); } };
  const names = proNames(p);
  const symCache = new Map<string, Sym>();
  const symOf = (uuid: string): Sym | undefined => {
    if (!uuid) return undefined;
    let sy = symCache.get(uuid);
    if (!sy) { const d = p.symbols.get(uuid); if (!d) return undefined; sy = symbolOf(d); symCache.set(uuid, sy); }
    return sy;
  };
  const pages = sch?.pages ?? [];
  const libUsed = new Map<string, Set<string>>();   // symbol → the footprints placed with it
  const out: { name: string; bytes: Uint8Array }[] = [];
  const netNames = new Set<string>();
  let nParts = 0;

  /* What each page holds, read once: components with their attributes, wires with their nets */
  interface Page { doc: ProDoc; st: Styles; attrs: Map<string, Rec[]>; comps: Rec[] }
  const read: Page[] = pages.map((doc) => {
    const attrs = new Map<string, Rec[]>();
    for (const r of doc.recs) if (r[0] === 'ATTR') { const k = s(r[2]); if (!attrs.has(k)) attrs.set(k, []); attrs.get(k)!.push(r); }
    return { doc, st: new Styles(doc.recs), attrs, comps: doc.recs.filter((r) => r[0] === 'COMPONENT') };
  });
  const attrOf = (pg: Page, id: string, key: string) => pg.attrs.get(id)?.find((a) => s(a[3]) === key);
  const deviceOf = (pg: Page, c: Rec) => p.devices.get(s(attrOf(pg, s(c[1]), 'Device')?.[4]));
  const symbolFor = (pg: Page, c: Rec) => symOf(s(attrOf(pg, s(c[1]), 'Symbol')?.[4]) || s(deviceOf(pg, c)?.attributes.Symbol));
  /** A flag's net name: the instance's Global Net Name (or v3's Name), the device's, the symbol's. */
  const flagName = (pg: Page, c: Rec, sym: Sym) => {
    const id = s(c[1]), dev = deviceOf(pg, c);
    return s(attrOf(pg, id, 'Global Net Name')?.[4]) || (p.version === 3 ? s(attrOf(pg, id, 'Name')?.[4]) : '') || s(dev?.attributes['Global Net Name']) || s(dev?.attributes.Name) || s(sym.attrs.get('Global Net Name')?.[4]) || s(sym.attrs.get('Name')?.[4]);
  };
  const portName = (pg: Page, c: Rec, sym: Sym) => s(attrOf(pg, s(c[1]), 'Name')?.[4]) || s(deviceOf(pg, c)?.attributes.Name) || s(sym.attrs.get('Name')?.[4]) || s(attrOf(pg, s(c[1]), 'Global Net Name')?.[4]);

  // Names design-wide by what names them: a name both a label and a flag or a port needs a label at the flag or port
  const kinds = new Map<string, Set<string>>();
  const saw = (nm: string, k: string) => { const key = nm.toUpperCase(); if (!kinds.has(key)) kinds.set(key, new Set()); kinds.get(key)!.add(k); };
  for (const pg of read) {
    // (a name shown on a wire is a label's; one not shown is the net's name, as EasyEDA names a flag's or a port's wires)
    for (const r of pg.doc.recs) if (r[0] === 'WIRE' || r[0] === 'BUS') { const a = attrOf(pg, s(r[1]), 'NET'); if (a && !autoNet(s(a[4])) && yes(a[6])) saw(s(a[4]), 'label'); }
    for (const c of pg.comps) {
      const sym = symbolFor(pg, c);
      if (sym?.type === 18) { const nm = flagName(pg, c, sym); if (nm) saw(nm, 'power'); }
      else if (sym?.type === 19) { const nm = portName(pg, c, sym); if (nm) saw(nm, 'port'); }
    }
  }
  const joinByLabel = (nm: string) => (kinds.get(nm.toUpperCase())?.size ?? 0) > 1;

  read.forEach((pg, pi) => {
    const r = new Records(), fonts = new Fonts();
    r.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
    const sheetIndex = r.bags.length;
    r.bags.push(PropertyBag.from({ RECORD: SR.SHEET }));
    const top = (props: Props, coords?: Record<string, Pt>) => r.add({ ...props, OWNERPARTID: -1 }, coords);
    const fontId = (f: FontLook) => (f.size ? fonts.id(f.size * 1.24 * 0.127, f.bold, f.italic) : 1);

    /* Where everything is: the sheet 50 (0.5 inch) round it */
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const see = (q: Pt) => { if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) return; x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); };
    for (const rec of pg.doc.recs) {
      switch (rec[0]) {
        case 'WIRE': case 'BUS': for (const l of (Array.isArray(rec[2]) ? rec[2] : []) as unknown[][]) for (let i = 0; i + 1 < l.length; i += 2) see({ x: n(l[i]), y: n(l[i + 1]) }); break;
        case 'TEXT': case 'CIRCLE': case 'ELLIPSE': see({ x: n(rec[2], NaN), y: n(rec[3], NaN) }); break;
        case 'RECT': see({ x: n(rec[2]), y: n(rec[3]) }); see({ x: n(rec[4]), y: n(rec[5]) }); break;
        case 'POLY': { const v = (Array.isArray(rec[2]) ? rec[2] : []).map((x) => n(x)); for (let i = 0; i + 1 < v.length; i += 2) see({ x: v[i]!, y: v[i + 1]! }); break; }
        case 'COMPONENT': {
          see({ x: n(rec[3]), y: n(rec[4]) });
          const sym = symbolFor(pg, rec);
          const bb = sym?.bbox;
          if (bb && bb.length >= 4) {
            const pl = placement(n(rec[3]), n(rec[4]), n(rec[5]), yes(rec[6]), (q) => q);
            see(pl.place({ x: bb[0]!, y: bb[1]! })); see(pl.place({ x: bb[2]!, y: bb[3]! }));
          }
          // A v3 frame: the page's width and height
          const fw = n(attrOf(pg, s(rec[1]), 'Width')?.[4]), fh = n(attrOf(pg, s(rec[1]), 'Height')?.[4]);
          if (sym?.type === 20 && fw > 0 && fh > 0) { see({ x: n(rec[3]), y: n(rec[4]) }); see({ x: n(rec[3]) + fw, y: n(rec[4]) + fh }); }
          break;
        }
        case 'ATTR': if (rec[7] !== null && rec[7] !== undefined && yes(rec[6])) see({ x: n(rec[7]), y: n(rec[8]) }); break;
        default:
      }
    }
    if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = 1000; y1 = 800; }
    // The corner on EasyEDA's grid (0.1 inch), so what was on it stays on it
    x0 = Math.floor(x0 / 10) * 10; y0 = Math.floor(y0 / 10) * 10;
    const M = 50;
    const P = (q: Pt): Pt => ({ x: Math.round((q.x - x0 + M) * 1000) / 1000, y: Math.round((q.y - y0 + M) * 1000) / 1000 });
    let framed = false;

    /* Text an attribute shows (its own place, angle and style), if shown */
    const attrText = (a: Rec | undefined): { at: Pt; props: Props } | null => {
      if (!a || a[7] === null || a[7] === undefined) return null;
      const f = pg.st.font(a[10]);
      return { at: P({ x: n(a[7]), y: n(a[8]) }), props: { FONTID: fontId(f), COLOR: colour(f.color, COL.text), ...textFrame(n(a[9]), f.h, f.v, false) } };
    };

    /* Page values for the title block (its @ fields) */
    const pageValue = (k: string): string | undefined => ({
      '@Page No': String(pi + 1), '@Page Count': String(read.length), '@Page Name': pg.doc.title, '@Schematic Name': sch?.name ?? stem, '@Project Name': p.title, '@Board Name': stem,
    } as Record<string, string>)[k];

    /* ── components ── */
    const marks = new Map<string, Pt[]>();   // flags and ports by name, where they connect
    const mark = (nm: string, ...pts: Pt[]) => marks.set(nm.toUpperCase(), [...(marks.get(nm.toUpperCase()) ?? []), ...pts]);
    const joins: { name: string; at: Pt; orient: number }[] = [];   // flags and ports whose name is also a label's
    const pinPoints: { at: Pt; comp: string; pin: string }[] = [];
    // What a port's far end mustn't land on (EasyEDA's port joins at its point alone, AD's at both ends): wires and pins
    const busy: { a: Pt; b: Pt }[] = [];
    for (const rec of pg.doc.recs) if (rec[0] === 'WIRE' || rec[0] === 'BUS') for (const v of (Array.isArray(rec[2]) ? rec[2] : []) as unknown[][]) for (let i = 2; i + 1 < v.length; i += 2) busy.push({ a: P({ x: n(v[i - 2]), y: n(v[i - 1]) }), b: P({ x: n(v[i]), y: n(v[i + 1]) }) });
    for (const c of pg.comps) {
      const sym = symbolFor(pg, c);
      if (!sym || sym.type === 19) continue;
      const pl = placement(n(c[3]), n(c[4]), n(c[5]), yes(c[6]), P);
      for (const q of sym.byPart.get(sym.parts[Math.max(0, sym.parts.indexOf(s(c[2])))] ?? '') ?? []) if (q[0] === 'PIN') { const at = pl.place({ x: n(q[4]), y: n(q[5]) }); busy.push({ a: at, b: at }); }
    }
    const isBusy = (q: Pt) => busy.some((g) => {
      const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((q.x - g.a.x) * dx + (q.y - g.a.y) * dy) / L2)) : 0;
      return Math.hypot(g.a.x + t * dx - q.x, g.a.y + t * dy - q.y) < 0.01;
    });
    for (const c of pg.comps) {
      const id = s(c[1]);
      const sym = symbolFor(pg, c);
      if (!sym) { warnOnce('Parts whose symbol is missing left out'); continue; }
      const dev = deviceOf(pg, c);
      const pl = placement(n(c[3]), n(c[4]), n(c[5]), yes(c[6]), P);
      if (n(c[5]) % 90 !== 0) warnOnce('Parts turned other than by quarter turns: turned to the nearest');
      const partIdx = Math.max(0, sym.parts.indexOf(s(c[2])));
      const part = sym.parts[partIdx] ?? '';
      const get = (k: string): string | undefined => {
        const a = attrOf(pg, id, k);
        if (a && s(a[4])) return s(a[4]);
        const sv = sym.attrs.get(k);
        return dev?.attributes[k] || s(sv?.[4]) || pageValue(k) || undefined;
      };
      const val = (k: string) => proValue(get(k) ?? '', get);

      // The frame and title block, and drawings: as drawn
      if (sym.type === 20 || sym.type === 21) {
        // Where the page put its title block (EasyEDA keeps it in the page's corner): the shift between the symbol's attributes and the page's
        let dx = 0, dy = 0;
        for (const [k, sa] of sym.attrs) {
          const ia = attrOf(pg, id, k);
          if (ia && ia[7] !== null && ia[7] !== undefined && sa[7] !== null && sa[7] !== undefined) {
            const q = placement(n(c[3]), n(c[4]), n(c[5]), yes(c[6]), (v) => v).place({ x: n(sa[7]), y: n(sa[8]) });
            dx = n(ia[7]) - q.x; dy = n(ia[8]) - q.y;
            break;
          }
        }
        const fpl = placement(n(c[3]) + dx, n(c[4]) + dy, n(c[5]), yes(c[6]), P);
        if (sym.type === 20) {
          framed = true;
          // v3's frame: its border drawn by the page (its width, height, margin and zones)
          const W = n(get('Width')), H = n(get('Height'));
          if (W > 0 && H > 0 && get('Border') !== '0') {
            const blade = n(get('Blade Width'), 10), nx = Math.max(1, n(get('X Region Count'), 6)), ny = Math.max(1, n(get('Y Region Count'), 4));
            const o = (x: number, y: number) => P({ x: n(c[3]) + x, y: n(c[4]) + y });
            const rect = (a: Pt, b: Pt) => top({ RECORD: SR.RECTANGLE, COLOR: COL.body, LINEWIDTH: 1, ISSOLID: false, TRANSPARENT: true }, { LOCATION: a, CORNER: b });
            rect(o(0, 0), o(W, H));
            if (blade > 0) {
              rect(o(blade, blade), o(W - blade, H - blade));
              for (let i = 0; i < nx; i++) {
                const xa = blade + ((W - 2 * blade) * i) / nx, xm = blade + ((W - 2 * blade) * (i + 0.5)) / nx;
                if (i) for (const [y1, y2] of [[0, blade], [H - blade, H]]) top({ RECORD: SR.LINE, COLOR: COL.body, LINEWIDTH: 1 }, { LOCATION: o(xa, y1!), CORNER: o(xa, y2!) });
                for (const y of [blade / 2, H - blade / 2]) top({ RECORD: SR.LABEL, TEXT: String(i + 1), FONTID: 1, COLOR: COL.body, JUSTIFICATION: 4 }, { LOCATION: o(xm, y) });
              }
              for (let j = 0; j < ny; j++) {
                const ya = H - blade - ((H - 2 * blade) * j) / ny, ym = H - blade - ((H - 2 * blade) * (j + 0.5)) / ny;
                if (j) for (const [x1, x2] of [[0, blade], [W - blade, W]]) top({ RECORD: SR.LINE, COLOR: COL.body, LINEWIDTH: 1 }, { LOCATION: o(x1!, ya), CORNER: o(x2!, ya) });
                for (const x of [blade / 2, W - blade / 2]) top({ RECORD: SR.LABEL, TEXT: String.fromCharCode(65 + (j % 26)), FONTID: 1, COLOR: COL.body, JUSTIFICATION: 4 }, { LOCATION: o(x, ym) });
              }
            }
          }
        }
        drawPart(r, sym, part, fpl.place, fpl.dir, yes(c[6]), { OWNERPARTID: -1 }, fonts, warnOnce, false, false, (v) => proValue(v, (k) => get(k) ?? ''));
        const keys = new Set([...sym.attrs.keys(), ...(pg.attrs.get(id) ?? []).map((a) => s(a[3]))]);
        for (const k of keys) {
          if (/^(Symbol|Device|Footprint|Designator|Unique ID|Name|Reuse Block|Group ID|Channel ID|Border|Width|Height|Blade Width|Region Start|X Region Count|Y Region Count|Title Block|Title Block Position|Color)$/.test(k)) continue;
          const ia = attrOf(pg, id, k), sa = sym.attrs.get(k);
          // Shown as the page says, else as the symbol does
          const shownHere = ia && ia[6] !== null && ia[6] !== undefined ? yes(ia[6]) : yes(sa?.[6]);
          if (!shownHere) continue;
          const t = ia && ia[7] !== null && ia[7] !== undefined ? attrText(ia)
            : sa && sa[7] !== null && sa[7] !== undefined ? { at: fpl.place({ x: n(sa[7]), y: n(sa[8]) }), props: { FONTID: fontId(sym.st.font(sa[10])), COLOR: COL.text, ...textFrame(fpl.dir(n(sa[9])), sym.st.font(sa[10]).h, sym.st.font(sa[10]).v, yes(c[6])) } } : null;
          const text = proValue(s(ia?.[4]) || pageValue(k) || s(sa?.[4]), get);
          if (t && text) top({ RECORD: SR.LABEL, TEXT: textValue(text), ...t.props }, { LOCATION: t.at });
        }
        continue;
      }
      // The pins' places on the sheet (no-connect marks and flags find them there)
      const pins = (sym.byPart.get(part) ?? []).filter((q) => q[0] === 'PIN');
      for (const q of pins) pinPoints.push({ at: pl.place({ x: n(q[4]), y: n(q[5]) }), comp: id, pin: s(q[1]) });
      // A net flag: a power port at its pin, pointing where its drawing lies
      if (sym.type === 18 || sym.type === 19) {
        const pin = pins[0];
        const hot = pin ? pl.place({ x: n(pin[4]), y: n(pin[5]) }) : pl.place({ x: 0, y: 0 });
        const gfx = (sym.byPart.get(part) ?? []).filter((q) => q[0] !== 'PIN' && q[0] !== 'TEXT');
        const gp: Pt[] = gfx.flatMap((q) => q[0] === 'POLY' ? (() => { const v = (q[2] as unknown[]).map((x) => n(x)); const o: Pt[] = []; for (let i = 0; i + 1 < v.length; i += 2) o.push({ x: v[i]!, y: v[i + 1]! }); return o; })()
          : q[0] === 'RECT' ? [{ x: n(q[2]), y: n(q[3]) }, { x: n(q[4]), y: n(q[5]) }] : q[0] === 'CIRCLE' || q[0] === 'ELLIPSE' ? [{ x: n(q[2]), y: n(q[3]) }] : q[0] === 'ARC' ? [{ x: n(q[4]), y: n(q[5]) }] : []).map(pl.place);
        const cen = gp.length ? { x: gp.reduce((a, q) => a + q.x, 0) / gp.length, y: gp.reduce((a, q) => a + q.y, 0) / gp.length } : pin ? pl.place({ x: n(pin[4]) + Math.cos((n(pin[7]) * Math.PI) / 180), y: n(pin[5]) + Math.sin((n(pin[7]) * Math.PI) / 180) }) : { x: hot.x, y: hot.y + 1 };
        const orient = Math.hypot(cen.x - hot.x, cen.y - hot.y) > 0.01 ? orientOf(hot, cen) : 1;
        if (sym.type === 18) {
          const name = flagName(pg, c, sym);
          if (!name) continue;
          netNames.add(name);
          const title = `${sym.doc.title} ${name}`;
          const ground = /gnd|ground|vss|earth/i.test(title);
          const style = /earth|chassis|\bpe\b/i.test(title) ? 6 : /agnd|signal/i.test(title) ? 5 : ground ? 4 : gfx.some((q) => q[0] === 'CIRCLE') ? 0 : 2;
          const label = attrOf(pg, id, 'Global Net Name');
          top({ RECORD: SR.POWER_PORT, STYLE: style, ORIENTATION: orient, TEXT: name, SHOWNETNAME: label ? yes(label[6]) : true, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: hot });
          mark(name, hot);
          if (joinByLabel(name)) joins.push({ name, at: hot, orient });
        } else {
          const name = portName(pg, c, sym);
          if (!name) continue;
          netNames.add(name);
          const type = s(pinText(sym, s(pin?.[1]), 'Pin Type')?.[4]).toUpperCase();
          const io = type === 'IN' || type === 'INPUT' ? 2 : type === 'OUT' || type === 'OUTPUT' ? 1 : type === 'BI' ? 3 : ({ 1: 2, 2: 1, 3: 3 } as Record<number, number>)[n(pin?.[3])] ?? 0;
          // AD's port: from its point the way the flag's drawing goes
          let w = Math.max(30, Math.ceil((name.length * 6 + 12) / 10) * 10);
          const farOf = (len: number) => (orient === 0 ? { x: hot.x + len, y: hot.y } : orient === 1 ? { x: hot.x, y: hot.y + len } : orient === 2 ? { x: hot.x - len, y: hot.y } : { x: hot.x, y: hot.y - len });
          while (w > 5 && isBusy(farOf(w))) w -= 5;
          const loc = orient === 2 ? { x: hot.x - w, y: hot.y } : orient === 3 ? { x: hot.x, y: hot.y - w } : hot;
          top({ RECORD: SR.PORT, NAME: name, STYLE: orient % 2 ? 7 : 3, IOTYPE: io, WIDTH: w, HEIGHT: 10, ALIGNMENT: 0, COLOR: COL.port, AREACOLOR: COL.portFill, TEXTCOLOR: COL.port, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: loc });
          mark(name, loc, orient % 2 ? { x: loc.x, y: loc.y + w } : { x: loc.x + w, y: loc.y });
          if (joinByLabel(name)) joins.push({ name, at: hot, orient });
        }
        continue;
      }
      // A short: EasyEDA joins the nets on its two pins; drawn as it is with a wire across
      if (sym.type === 22) {
        drawPart(r, sym, part, pl.place, pl.dir, yes(c[6]), { OWNERPARTID: -1 }, fonts, warnOnce, false, false);
        const ends = pins.map((q) => pl.place({ x: n(q[4]), y: n(q[5]) }));
        if (ends.length >= 2) r.points({ RECORD: SR.WIRE, OWNERPARTID: -1, LINEWIDTH: 1, COLOR: COL.wire, UNIQUEID: uniqueId() }, [ends[0]!, ends[1]!]);
        warnOnce('Shorts (net ties) drawn with a wire across: EasyEDA joins their nets, as its board has them');
        continue;
      }
      if (sym.type === 17) warnOnce('Block symbols (hierarchical blocks) placed as parts: their sheets are not linked');
      // A part: its symbol from the library, placed
      const libRef = names.symbols.get(sym.doc.uuid) ?? sym.doc.title;
      const fpId = s(attrOf(pg, id, 'Footprint')?.[4]) || s(dev?.attributes.Footprint);
      const pattern = names.footprints.get(fpId) ?? (p.footprints.size ? '' : fpId);
      if (!libUsed.has(sym.doc.uuid)) libUsed.set(sym.doc.uuid, new Set());
      if (pattern) libUsed.get(sym.doc.uuid)!.add(pattern);
      const uid = get('Unique ID');
      const onBoard = (get('Convert to PCB') ?? 'yes') !== 'no', inBom = (get('Add into BOM') ?? 'yes') !== 'no';
      const ci = top({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, PARTCOUNT: sym.parts.length + 1, DISPLAYMODECOUNT: 1, CURRENTPARTID: partIdx + 1, ORIENTATION: pl.orient, ISMIRRORED: yes(c[6]) || undefined,
        AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: libRef, SOURCELIBRARYNAME: `${stem}.SchLib`, COMPONENTDESCRIPTION: get('Description') || undefined,
        UNIQUEID: uid ? uniqueIdFor(`easyedapro:${uid}`) : uniqueId(),
        ...(sym.type === 22 ? { COMPONENTKIND: 4 } : !onBoard ? { COMPONENTKIND: 2 } : !inBom ? { COMPONENTKINDVERSION2: 5 } : {}) }, { LOCATION: pl.place({ x: 0, y: 0 }) });
      drawPart(r, sym, part, pl.place, pl.dir, yes(c[6]), { OWNERINDEX: ci - 1, OWNERPARTID: partIdx + 1 }, fonts, warnOnce);
      // Designator, comment (the name or value shown), the other attributes
      const desA = attrOf(pg, id, 'Designator');
      const designator = s(desA?.[4]) || `${s(sym.attrs.get('Designator')?.[4]).replace(/\?$/, '') || 'U'}?`;
      const shown = (k: string) => { const a = attrOf(pg, id, k); return !!a && yes(a[6]) && a[7] !== null && a[7] !== undefined; };
      const comKey = shown('Value') ? 'Value' : shown('Name') ? 'Name' : get('Value') ? 'Value' : 'Name';
      const comment = val(comKey) || val(comKey === 'Value' ? 'Name' : 'Value') || libRef;
      const field = (rec: number, name: string, text: string, a: Rec | undefined) => {
        const t = a && yes(a[6]) ? attrText(a) : null;
        r.add({ RECORD: rec, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: name, TEXT: text, ...(t ? t.props : { FONTID: 1, COLOR: COL.text, ISHIDDEN: true }) }, { LOCATION: t ? t.at : pl.place({ x: 0, y: 0 }) });
      };
      field(SR.DESIGNATOR, 'Designator', designator, desA);
      field(SR.PARAMETER, 'Comment', comment, attrOf(pg, id, comKey));
      const skip = /^(Symbol|Device|Footprint|Designator|Unique ID|Reuse Block|Group ID|Channel ID|Relevance|Multi-Part Group|3D Model|3D Model Title|3D Model Transform|Add into BOM|Convert to PCB|Global Net Name|Description|Supplier Footprint|NO_CONNECT)$/;
      const keys = new Set([...Object.keys(dev?.attributes ?? {}), ...(pg.attrs.get(id) ?? []).map((a) => s(a[3]))]);
      for (const k of keys) {
        if (skip.test(k) || k === comKey || k.startsWith('@')) continue;
        const v = val(k);
        if (!v) continue;
        field(SR.PARAMETER, k === 'Datasheet' ? 'Datasheet' : k, v, attrOf(pg, id, k));
      }
      if (pattern && onBoard) {
        const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci - 1, OWNERPARTID: -1 });
        const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list - 1, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: pattern, MODELTYPE: 'PCBLIB',
          DATAFILECOUNT: 1, MODELDATAFILEENTITY0: pattern, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: true, UNIQUEID: uniqueId() });
        r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
        r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
      }
      nParts++;
    }

    /* ── wires, their labels, junctions ── */
    const segs: { a: Pt; b: Pt; wire: string }[] = [];
    const wireNet = new Map<string, string>();
    const labelsAt: { at: Pt; name: string }[] = [];
    for (const rec of pg.doc.recs) {
      if (rec[0] !== 'WIRE' && rec[0] !== 'BUS') continue;
      const id = s(rec[1]);
      const l = pg.st.line(rec[3]);
      const lines = ((Array.isArray(rec[2]) ? rec[2] : []) as unknown[][]).map((v) => { const pts: Pt[] = []; for (let i = 0; i + 1 < v.length; i += 2) pts.push(P({ x: n(v[i]), y: n(v[i + 1]) })); return pts; }).filter((x) => x.length >= 2);
      for (const pts of lines) {
        if (rec[0] === 'WIRE') r.points({ RECORD: SR.WIRE, OWNERPARTID: -1, LINEWIDTH: 1, COLOR: colour(l.color, COL.wire), UNIQUEID: uniqueId() }, pts);
        else r.points({ RECORD: SR.BUS, OWNERPARTID: -1, LINEWIDTH: 2, COLOR: COL.bus }, pts);
        for (let i = 1; i < pts.length; i++) segs.push({ a: pts[i - 1]!, b: pts[i]!, wire: id });
      }
      const net = attrOf(pg, id, 'NET');
      const name = s(net?.[4]);
      if (!name) continue;
      wireNet.set(id, name);
      if (!autoNet(name)) netNames.add(name);
      // Its label where EasyEDA shows it, on the wire
      if (net && yes(net[6]) && net[7] !== null && net[7] !== undefined && lines.length) {
        const at0 = P({ x: n(net[7]), y: n(net[8]) });
        const at = nearestOn(at0, lines);
        const f = pg.st.font(net[10]);
        let o = quarter(n(net[9]));
        if (f.h === 2) o = (o + 2) % 4;
        top({ RECORD: rec[0] === 'BUS' ? SR.NET_LABEL : SR.NET_LABEL, TEXT: name, FONTID: fontId(f), COLOR: COL.wire, ORIENTATION: o, UNIQUEID: uniqueId() }, { LOCATION: at });
        labelsAt.push({ at, name });
      }
    }
    // A name EasyEDA joins without a label (a named wire with nothing of its name on it): a label at its start
    const onSeg = (q: Pt, g: { a: Pt; b: Pt }) => {
      const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((q.x - g.a.x) * dx + (q.y - g.a.y) * dy) / L2)) : 0;
      return Math.hypot(g.a.x + t * dx - q.x, g.a.y + t * dy - q.y) < 0.01;
    };
    const groups = wireGroups(segs);
    const named = new Map<string, Pt[]>();   // names marked on the page (labels, flags, ports) and where
    for (const l of labelsAt) named.set(l.name.toUpperCase(), [...(named.get(l.name.toUpperCase()) ?? []), l.at]);
    for (const [nm, pts] of marks) named.set(nm, [...(named.get(nm) ?? []), ...pts]);
    for (const g of groups) {
      const nm = g.wires.map((w) => wireNet.get(w)).find((x) => x && !autoNet(x));
      if (!nm) continue;
      const mine = segs.filter((q) => g.wires.includes(q.wire));
      if ((named.get(nm.toUpperCase()) ?? []).some((q) => mine.some((sg) => onSeg(q, sg)))) continue;
      const at = mine[0]!.a;
      // A flag's name (and no label's): a power port of it, as AD joins a flag's name only to flags
      const k = kinds.get(nm.toUpperCase());
      if (k?.has('power') && !k.has('label')) { top({ RECORD: SR.POWER_PORT, STYLE: 2, ORIENTATION: 1, TEXT: nm, SHOWNETNAME: true, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: at }); continue; }
      top({ RECORD: SR.NET_LABEL, TEXT: nm, FONTID: 1, COLOR: COL.wire, ORIENTATION: 0, UNIQUEID: uniqueId() }, { LOCATION: at });
      labelsAt.push({ at, name: nm });
    }
    // A flag or port whose name is a label's elsewhere: a label too, unless its wires carry one (AD joins names only kind to kind)
    for (const j of joins) {
      const g = groups.find((x) => segs.some((q) => x.wires.includes(q.wire) && onSeg(j.at, q)));
      const mine = g ? segs.filter((q) => g.wires.includes(q.wire)) : [];
      if (labelsAt.some((l) => l.name.toUpperCase() === j.name.toUpperCase() && (Math.hypot(l.at.x - j.at.x, l.at.y - j.at.y) < 0.01 || mine.some((q) => onSeg(l.at, q))))) continue;
      top({ RECORD: SR.NET_LABEL, TEXT: j.name, FONTID: 1, COLOR: COL.wire, ORIENTATION: j.orient % 2 ? 0 : 1, UNIQUEID: uniqueId() }, { LOCATION: j.at });
    }
    // Junctions: three wire ends at a point, or a wire's end on another's middle
    const ends = new Map<string, { at: Pt; count: number }>();
    for (const g of segs) for (const e of [g.a, g.b]) { const k = `${e.x.toFixed(2)},${e.y.toFixed(2)}`; const v = ends.get(k) ?? { at: e, count: 0 }; v.count++; ends.set(k, v); }
    for (const { at, count } of ends.values()) {
      const through = segs.filter((g) => onSeg(at, g) && Math.hypot(g.a.x - at.x, g.a.y - at.y) > 0.01 && Math.hypot(g.b.x - at.x, g.b.y - at.y) > 0.01).length;
      if (count + 2 * through >= 3) top({ RECORD: SR.JUNCTION, COLOR: COL.wire }, { LOCATION: at });
    }

    /* ── no-connect marks (pin attributes), text and drawings ── */
    for (const [parent, list] of pg.attrs) {
      const nc = list.find((a) => s(a[3]) === 'NO_CONNECT' && yes(s(a[4]).toLowerCase() === 'yes' ? 1 : a[4]));
      if (!nc) continue;
      const pp = pinPoints.find((q) => parent === `${q.comp}${q.pin}` || parent === `${q.comp}-${q.pin}`);
      if (pp) top({ RECORD: SR.NO_ERC, COLOR: COL.noerc, ISACTIVE: true, SUPPRESSALL: true, SYMBOL: 'Thin Cross' }, { LOCATION: pp.at });
    }
    const sheetSym: Sym = { doc: pg.doc, type: 0, parts: [''], byPart: new Map([['', pg.doc.recs.filter((q) => ['RECT', 'CIRCLE', 'ELLIPSE', 'ARC', 'POLY', 'BEZIER', 'TEXT', 'OBJ', 'TABLE'].includes(s(q[0])))]]), attrs: new Map(), pinAttrs: new Map(), st: pg.st };
    drawPart(r, sheetSym, '', P, (d) => d, false, { OWNERPARTID: -1 }, fonts, warnOnce);
    for (const q of pg.doc.recs) if (q[0] === 'BUSENTRY') warnOnce('Bus entries left out');

    /* ── the sheet record: as large as what's on it, AD's border and title block off where the page has its own frame ── */
    const W = Math.ceil((x1 - x0 + 2 * M) / 10) * 10, H = Math.ceil((y1 - y0 + 2 * M) / 10) * 10;
    r.bags[sheetIndex] = PropertyBag.from({ RECORD: SR.SHEET, ...fonts.keys(), USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true,
      CUSTOMX: W, CUSTOMY: H, CUSTOMXZONES: Math.max(4, Math.round(W / 250)), CUSTOMYZONES: Math.max(4, Math.round(H / 250)), CUSTOMMARGINWIDTH: 20,
      BORDERON: !framed, TITLEBLOCKON: !framed, AREACOLOR: toBgr(0xffffff),
      SNAPGRIDON: true, SNAPGRIDSIZE: 5, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 2, SYSTEMFONT: 1, DOCUMENTBORDERSTYLE: 0 } as Record<string, string | number | boolean>);
    r.bags[0]!.setRaw('WEIGHT', String(r.bags.length - 1));
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'FileHeader', joinSchRecords(r.bags.map((bag) => ({ kind: 0, data: bag.toBytes(), bag }))));
    cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
    const base = (pg.doc.title || `Sheet${pi + 1}`).replace(/[\\/:*?"<>|]/g, '_');
    let name = read.length === 1 ? `${stem}.SchDoc` : `${base}.SchDoc`;
    for (let k = 2; out.some((o) => o.name.toLowerCase() === name.toLowerCase()); k++) name = `${base}_${k}.SchDoc`;
    out.push({ name, bytes: writeCfb(root) });
  });
  if (!out.length) warnings.push('No pages in it');
  const lib = proSymbolLibrary(p, [...libUsed.keys()], libUsed, footprintLib);
  return { sheets: out, library: lib.bytes, symbols: lib.count, warnings: [...warnings, ...lib.warnings.filter((w) => !warned.has(w))], stats: { sheets: out.length, parts: nParts, nets: netNames.size, symbols: lib.count } };
}

/** The nearest point on the lines. */
function nearestOn(q: Pt, lines: Pt[][]): Pt {
  let best = q, bd = Infinity;
  for (const pts of lines) for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!, dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2)) : 0;
    const c = { x: a.x + t * dx, y: a.y + t * dy }, d = Math.hypot(c.x - q.x, c.y - q.y);
    if (d < bd) { bd = d; best = { x: Math.round(c.x * 1000) / 1000, y: Math.round(c.y * 1000) / 1000 }; }
  }
  return best;
}

/** Wires that touch (end to end, or an end on another's middle) grouped. */
function wireGroups(segs: { a: Pt; b: Pt; wire: string }[]): { wires: string[] }[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  for (const g of segs) if (!parent.has(g.wire)) parent.set(g.wire, g.wire);
  const touches = (q: Pt, g: { a: Pt; b: Pt }) => {
    const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((q.x - g.a.x) * dx + (q.y - g.a.y) * dy) / L2)) : 0;
    return Math.hypot(g.a.x + t * dx - q.x, g.a.y + t * dy - q.y) < 0.01;
  };
  for (let i = 0; i < segs.length; i++) for (let j = 0; j < segs.length; j++) {
    if (i === j || segs[i]!.wire === segs[j]!.wire) continue;
    if (touches(segs[i]!.a, segs[j]!) || touches(segs[i]!.b, segs[j]!)) { const a = find(segs[i]!.wire), b = find(segs[j]!.wire); if (a !== b) parent.set(a, b); }
  }
  const out = new Map<string, string[]>();
  for (const w of parent.keys()) { const r = find(w); if (!out.has(r)) out.set(r, []); out.get(r)!.push(w); }
  return [...out.values()].map((wires) => ({ wires }));
}

/** Symbols as a SchLib: each part an AD part, the footprints placed with it its models (the first current). */
export function proSymbolLibrary(p: ProProject, ids: string[] = [...p.symbols.keys()], footprints = new Map<string, Set<string>>(), footprintLib = ''): { bytes: Uint8Array; count: number; warnings: string[] } {
  const names = proNames(p);
  const warnings: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  const symbols: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[] = [];
  for (const id of ids) {
    const d = p.symbols.get(id);
    if (!d) continue;
    const sym = symbolOf(d);
    if (sym.type === 18 || sym.type === 19 || sym.type === 20) continue;
    const libRef = names.symbols.get(id) ?? d.title;
    const r = new Records(), fonts = new Fonts();
    const desc = s(sym.attrs.get('Description')?.[4]);
    r.add({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, COMPONENTDESCRIPTION: desc || undefined, PARTCOUNT: sym.parts.length + 1, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1,
      LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*', AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: libRef, UNIQUEID: uniqueId() });
    sym.parts.forEach((part, i) => drawPart(r, sym, part, (q) => ({ x: q.x, y: q.y }), (deg) => deg, false, { OWNERPARTID: i + 1 }, fonts, warn, true));
    const at = (k: string) => { const a = sym.attrs.get(k); return a && a[7] !== null && a[7] !== undefined ? { x: n(a[7]), y: n(a[8]) } : { x: 0, y: 0 }; };
    const des = s(sym.attrs.get('Designator')?.[4]) || 'U?';
    r.add({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, NAME: 'Designator', TEXT: des.endsWith('?') ? des : `${des}?`, FONTID: 1, COLOR: COL.text }, { LOCATION: at('Designator') });
    r.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: 'Comment', TEXT: '*', FONTID: 1, COLOR: COL.text }, { LOCATION: at('Name') });
    const fps = [...(footprints.get(id) ?? [])];
    if (fps.length) {
      const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERPARTID: -1 });
      fps.forEach((fp, k) => {
        const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: fp, MODELTYPE: 'PCBLIB',
          DATAFILECOUNT: 1, MODELDATAFILEENTITY0: fp, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: k === 0, UNIQUEID: uniqueId() });
        r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl, OWNERPARTID: -1 });
        r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl, OWNERPARTID: -1 });
      });
    }
    symbols.push({ libRef, description: desc, parts: sym.parts.length, bags: r.bags });
  }
  return { bytes: writeSchLib(symbols), count: symbols.length, warnings };
}
