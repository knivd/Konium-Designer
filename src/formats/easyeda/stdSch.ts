/**
 * EasyEDA Standard schematics (a schematic's sheets, docType 5 holding docType 1 sheets, or one
 * sheet) as AD's: a SchDoc per sheet, a SchLib of the symbols placed (one per symbol name, from its
 * first instance turned back upright), parts as components turned as EasyEDA places them (their
 * graphics as placed), pins by their lines (length, the way they point, dot, clock, number and
 * name and whether shown, electrical type), the designator and value (as the comment) where they
 * are, the part's other attributes as parameters, its package as the footprint; wires, net labels,
 * power and ground flags as power ports in their style, net ports as ports, junctions, no-connect
 * flags, text, lines, polygons, paths, arcs, rectangles, ellipses; the sheet's frame and title
 * block kept as drawn (AD's off). EasyEDA's nets join by name across sheets: the project's Net
 * Identifier Scope is Global, and where one name is both a label and a port or a power flag a net
 * label at the port or flag joins them as EasyEDA does. EasyEDA's unit is 10 mil, AD's sheet unit
 * (Y down there, up here).
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
import { arcCentre, at, backtick, fields, flattenSub, num, parsePath, pointList, textValue } from './common';

type Pt = { x: number; y: number };
export interface EasyedaSchResult { sheets: { name: string; bytes: Uint8Array }[]; library: Uint8Array; symbols: number; warnings: string[]; stats: { sheets: number; parts: number; nets: number; symbols: number } }

const colour = (s: string | undefined, def: number): number => { const m = /^#([0-9a-f]{6})$/i.exec((s ?? '').trim()); return m ? toBgr(parseInt(m[1]!, 16)) : def; };
const lineWidth = (w: number) => (w <= 0.5 ? 0 : w <= 1.5 ? 1 : w <= 3.5 ? 2 : 3);
/** EasyEDA's font size (its unit an em: "9pt" or a number) as AD's points: AD's em is 5 mil a point over 0.716 [est]. */
const fontPtsOf = (s: string | undefined) => Math.max(4, Math.round((num((s ?? '').replace(/pt$/i, ''), 7) || 7) * 1.43));
const H_ANCHOR: Record<string, number> = { start: 0, middle: 1, end: 2 };
const V_BASE = (s: string) => (/middle|central/.test(s) ? 1 : /hanging|before-edge|text-top/.test(s) ? 2 : 0);
const ELECTRICAL: Record<string, number> = { '0': 4, '1': 0, '2': 2, '3': 1, '4': 7 };

/** The sheets of an EasyEDA Standard schematic document (docType 5's, or a lone sheet). */
export function easyedaSheets(doc: Record<string, unknown>): { title: string; data: Record<string, unknown> }[] {
  const list = Array.isArray(doc.schematics) ? doc.schematics as Record<string, unknown>[] : null;
  if (!list) return [{ title: String(doc.title ?? (doc.head as Record<string, unknown> | undefined)?.title ?? 'Sheet_1'), data: doc }];
  const out: { title: string; data: Record<string, unknown> }[] = [];
  list.forEach((s, i) => {
    if (num(s.docType as string, 1) !== 1) return;
    let data = s.dataStr as unknown;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
    if (data && typeof data === 'object') out.push({ title: String(s.title ?? `Sheet_${i + 1}`), data: data as Record<string, unknown> });
  });
  return out;
}

  /** A primitive (a part's or the sheet's), its points by `map`, its texts and pins turned back by `turn` quarters. */
function draw(rr: Records, rec: string, map: (p: Pt) => Pt, own: Props, turn: number, lib: boolean, ctx: { fonts: Fonts; warnOnce: (w: string) => void }, roles?: { des?: (t: string[], at: Pt, o: number) => void; com?: (t: string[], at: Pt, o: number) => void }): void {
const { fonts, warnOnce } = ctx;
    const segs = rec.split('^^');
    const f = fields(segs[0]!);
    const look = (stroke: string | undefined, w: number, style?: string) => ({ COLOR: colour(stroke, COL.body), LINEWIDTH: lineWidth(w), ...(num(style) > 0 ? { LINESTYLE: Math.min(2, num(style)), LINESTYLEEXT: Math.min(2, num(style)) } : {}) });
    const fillOf = (fill: string | undefined, stroke: string | undefined) => (fill && fill !== 'none' && fill !== 'transparent' ? { AREACOLOR: colour(fill, COL.fill), ISSOLID: true } : { AREACOLOR: colour(stroke, COL.fill), ISSOLID: false, TRANSPARENT: true });
    switch (f[0]) {
      case 'PL': case 'PG': {
        const pts = pointList(at(f, 1)).map(map);
        if (pts.length < 2) return;
        if (f[0] === 'PG' && pts.length >= 3) rr.points({ RECORD: SR.POLYGON, ...own, ...look(f[2], num(f[3]), f[4]), ...fillOf(f[5], f[2]) }, pts);
        else rr.points({ RECORD: SR.POLYLINE, ...own, ...look(f[2], num(f[3]), f[4]) }, pts);
        return;
      }
      case 'PT': {
        for (const sp of parsePath(at(f, 1))) {
          const pts = flattenSub(sp, 10).map(map);
          if (pts.length < 2) continue;
          if (sp.closed && pts.length >= 3) rr.points({ RECORD: SR.POLYGON, ...own, ...look(f[2], num(f[3]), f[4]), ...fillOf(f[5], f[2]) }, pts);
          else rr.points({ RECORD: SR.POLYLINE, ...own, ...look(f[2], num(f[3]), f[4]) }, pts);
        }
        return;
      }
      case 'A': {
        for (const sp of parsePath(at(f, 1))) for (const s of sp.segs) {
          if (s.kind !== 'A') continue;
          const a = arcCentre(s), t = ((a.a0 + a.sweepDeg / 2) * Math.PI) / 180;
          const arc = arcThrough(map(s.a), map({ x: a.c.x + a.r * Math.cos(t), y: a.c.y + a.r * Math.sin(t) }), map(s.b));
          if (arc) rr.add({ RECORD: SR.ARC, ...own, ...look(f[3], num(f[4]), f[5]), ...radius('RADIUS', arc.r), STARTANGLE: arc.start.toFixed(3), ENDANGLE: arc.end.toFixed(3) }, { LOCATION: arc.c });
        }
        return;
      }
      case 'R': {
        const a = map({ x: num(f[1]), y: num(f[2]) }), b = map({ x: num(f[1]) + num(f[5]), y: num(f[2]) + num(f[6]) });
        rr.add({ RECORD: SR.RECTANGLE, ...own, ...look(f[7], num(f[8]), f[9]), ...fillOf(f[10], f[7]) }, { LOCATION: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, CORNER: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } });
        return;
      }
      case 'E': {
        const c = map({ x: num(f[1]), y: num(f[2]) });
        rr.add({ RECORD: SR.ELLIPSE, ...own, ...look(f[5], num(f[6]), f[7]), ...fillOf(f[8], f[5]), ...radius('RADIUS', num(f[3])), ...radius('SECONDARYRADIUS', num(f[4], num(f[3]))) }, { LOCATION: c });
        return;
      }
      case 'T': {
        const s = textValue(at(f, 12));
        if (!s.trim()) return;
        const p = map({ x: num(f[2]), y: num(f[3]) });
        const o = ((Math.round((360 - num(f[4])) / 90) % 4) + 4 - turn) % 4;
        const font = fonts.id(fontPtsOf(f[7]) * 0.127, /bold/i.test(f[8] ?? ''), /italic/i.test(f[9] ?? ''));
        if (roles && f[1] === 'P' && roles.des) { roles.des(f, p, o); return; }
        if (roles && f[1] === 'N' && roles.com) { roles.com(f, p, o); return; }
        if (f[13] === '0') return;
        rr.add({ RECORD: SR.LABEL, ...own, TEXT: s, FONTID: lib ? 1 : font, COLOR: colour(f[5], COL.text), ORIENTATION: o, JUSTIFICATION: justification(H_ANCHOR[f[14] ?? ''] ?? 0, V_BASE(f[10] ?? '')) }, { LOCATION: p });
        return;
      }
      case 'P': {
        const hotRaw = fields(segs[1] ?? '');
        const hot0 = hotRaw.length >= 2 ? { x: num(hotRaw[0]), y: num(hotRaw[1]) } : { x: num(f[4]), y: num(f[5]) };
        const line = parsePath(fields(segs[2] ?? '')[0] ?? '')[0];
        let body0 = hot0;
        if (line) {
          const ends = [line.start, line.segs.length ? line.segs[line.segs.length - 1]!.b : line.start];
          const d = (q: Pt) => Math.hypot(q.x - hot0.x, q.y - hot0.y);
          body0 = d(ends[0]!) >= d(ends[1]!) ? ends[0]! : ends[1]!;
        }
        const hot = map(hot0), body = map(body0);
        const len = Math.hypot(body.x - hot.x, body.y - hot.y);
        const nameSeg = fields(segs[3] ?? ''), numSeg = fields(segs[4] ?? ''), dot = fields(segs[5] ?? ''), clock = fields(segs[6] ?? '');
        const name = textValue(nameSeg[4] ?? ''), number = textValue(numSeg[4] ?? '') || (f[3] ?? '');
        const hidden = f[1] !== undefined && f[1] !== '' && f[1] !== 'show';
        const o = len > 0 ? orientOf(body, hot) : 0;
        rr.add({ RECORD: SR.PIN, ...own, ELECTRICAL: ELECTRICAL[f[2] ?? '0'] ?? 4,
          PINCONGLOMERATE: o | (nameSeg[0] === '1' && name ? 0x08 : 0) | (numSeg[0] !== '0' ? 0x10 : 0) | (hidden ? 0x04 : 0),
          ...lengthKeys(len), NAME: name, DESIGNATOR: number, COLOR: COL.pin,
          ...(dot[0] === '1' ? { SYMBOL_OUTEREDGE: 1 } : {}), ...(clock[0] === '1' ? { SYMBOL_INNEREDGE: 3 } : {}) }, { LOCATION: len > 0 ? body : hot });
        return;
      }
      case 'Pimage': case 'I': warnOnce('Images in schematics left out'); return;
      default:
    }
  }

/** The sheet's frame (EasyEDA's frame_lib_1, or a part on no board drawn as one). */
const isFrame = (f: string[], cpara: Map<string, string>, subs: string[]) =>
  f[6] === 'frame_lib_1' || (cpara.get('package') === 'NONE' && (cpara.get('spicePre') === '.' || subs.some((s) => /frame_(outbox|innerbox|title)/.test(s))));

export function convertEasyedaSch(doc: Record<string, unknown>, fileName: string, footprintLib = ''): EasyedaSchResult {
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/^SCH_/, '').replace(/_\d{4}-\d{2}-\d{2}$/, '') || 'Schematic';
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (w: string) => { if (!warned.has(w)) { warned.add(w); warnings.push(w); } };
  const sheets = easyedaSheets(doc);

  // Names design-wide by what names them: a name both a label and a port or a power flag needs a label at the port or flag
  const kinds = new Map<string, Set<string>>();
  const saw = (n: string, k: string) => { const key = n.toUpperCase(); if (!kinds.has(key)) kinds.set(key, new Set()); kinds.get(key)!.add(k); };
  for (const s of sheets) for (const rec of (s.data.shape as string[] | undefined) ?? []) {
    const segs = String(rec).split('^^'), f = fields(segs[0]!);
    if (f[0] === 'N' && f[5]) saw(textValue(f[5]), 'label');
    if (f[0] === 'F') { const n = textValue(fields(segs[2] ?? '')[0] ?? ''); if (n) saw(n, /netPort/i.test(f[1] ?? '') ? 'port' : 'power'); }
  }
  const joinByLabel = (n: string) => (kinds.get(n.toUpperCase())?.size ?? 0) > 1;

  const symbols: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[] = [];
  const symbolNames = new Map<string, string>();   // a symbol's key → its library name
  const out: { name: string; bytes: Uint8Array }[] = [];
  let nParts = 0;
  const netNames = new Set<string>();

  /* ── the parts' symbols, first: a part of a multi-part package (U1.1, U1.2 …) a part of one symbol ── */
  interface Lib { si: number; ri: number; f: string[]; subs: string[]; cpara: Map<string, string>; quarter: number; des: string; libRef0: string }
  const libs: Lib[] = [];
  sheets.forEach((sheet, si) => ((sheet.data.shape as string[] | undefined) ?? []).forEach((rec, ri) => {
    const parts = String(rec).split('#@$');
    const f = fields(parts[0]!);
    if (f[0] !== 'LIB') return;
    const cpara = backtick(at(f, 3));
    const subs = parts.slice(1);
    if (isFrame(f, cpara, subs)) return;
    const d = subs.map(fields).find((q) => q[0] === 'T' && q[1] === 'P');
    libs.push({ si, ri, f, subs, cpara, quarter: ((Math.round(num(f[4]) / 90) % 4) + 4) % 4, des: textValue(at(d ?? [], 12)), libRef0: cpara.get('name') || cpara.get('spiceSymbolName') || 'Part' });
  }));
  const PART = /^(.+)\.(\d+)$/;
  const groups = new Map<string, Lib[]>();
  for (const l of libs) { const m = PART.exec(l.des); if (m) groups.set(m[1]!, [...(groups.get(m[1]!) ?? []), l]); }
  for (const [base, list] of groups) if (new Set(list.map((l) => l.libRef0)).size > 1) groups.delete(base);
  /** Which symbol each placed part is, and which of its parts. */
  const placed = new Map<string, { libRef: string; part: number; parts: number; designator: string; uid: string }>();
  // A part's points relative to its origin (AD's Y up), turned back upright
  const backOf = (l: Lib) => (p: Pt): Pt => {
    let x = p.x - num(l.f[1]), y = num(l.f[2]) - p.y;
    for (let i = 0; i < l.quarter; i++) [x, y] = [y, -x];
    return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
  };
  const newSymbol = (base0: string, key: string, parts: Lib[][], prefix: string) => {
    let libRef = base0;
    for (let k = 1; symbols.some((s) => s.libRef.toLowerCase() === libRef.toLowerCase()); k++) libRef = `${base0}_${k}`;
    symbolNames.set(key, libRef);
    const lr = new Records();
    lr.add({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, PARTCOUNT: parts.length + 1, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1, LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*',
      AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: libRef, UNIQUEID: uniqueId() });
    const fonts = new Fonts();
    parts.forEach((list, i) => {
      const l = list[0];
      if (!l) return;
      for (const s of l.subs) draw(lr, s, backOf(l), { OWNERPARTID: i + 1 }, l.quarter, true, { fonts, warnOnce }, { des: () => {}, com: () => {} });
    });
    const l = parts[0]![0]!;
    const T = (k: string) => l.subs.map(fields).find((q) => q[0] === 'T' && q[1] === k);
    const des = T('P'), val = T('N');
    const dp = des ? backOf(l)({ x: num(des[2]), y: num(des[3]) }) : { x: 0, y: 0 }, cp = val ? backOf(l)({ x: num(val[2]), y: num(val[3]) }) : { x: 0, y: -10 };
    lr.add({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, NAME: 'Designator', TEXT: `${prefix}?`.replace(/\?\?$/, '?'), FONTID: 1, COLOR: COL.text }, { LOCATION: dp });
    lr.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: 'Comment', TEXT: '*', FONTID: 1, COLOR: COL.text }, { LOCATION: cp });
    symbols.push({ libRef, parts: parts.length, bags: lr.bags });
    return libRef;
  };
  const pinKeyOf = (l: Lib) => l.subs.filter((s) => s.startsWith('P~')).map((s) => { const g = s.split('^^'); const h = fields(g[1] ?? ''); const b = backOf(l)({ x: num(h[0]), y: num(h[1]) }); return `${fields(g[4] ?? '')[4] ?? ''}@${b.x},${b.y}`; }).sort().join('|');
  const prefixOf = (l: Lib) => (l.cpara.get('pre') || l.cpara.get('spicePre') || 'U').replace(/\?.*$/, '') || 'U';
  for (const [base, list] of groups) {
    const byPart = new Map<number, Lib[]>();
    for (const l of list) { const k = Number(PART.exec(l.des)![2]); byPart.set(k, [...(byPart.get(k) ?? []), l]); }
    const n = Math.max(...byPart.keys());
    const parts = Array.from({ length: n }, (_, i) => byPart.get(i + 1) ?? []);
    const key = `${list[0]!.libRef0}\u0000multi\u0000${parts.map((pl) => (pl[0] ? pinKeyOf(pl[0]) : '')).join('/')}`;
    const libRef = symbolNames.get(key) ?? newSymbol(list[0]!.libRef0, key, parts.map((pl) => pl.length ? pl : [list[0]!]), prefixOf(list[0]!));
    const uid = (byPart.get(1)?.[0] ?? list[0]!).f[6] ?? '';
    for (const l of list) placed.set(`${l.si}:${l.ri}`, { libRef, part: Number(PART.exec(l.des)![2]), parts: n, designator: base, uid });
  }
  for (const l of libs) {
    if (placed.has(`${l.si}:${l.ri}`)) continue;
    const key = `${l.libRef0}\u0000${pinKeyOf(l)}`;
    const libRef = symbolNames.get(key) ?? newSymbol(l.libRef0, key, [[l]], prefixOf(l));
    placed.set(`${l.si}:${l.ri}`, { libRef, part: 1, parts: 1, designator: l.des, uid: l.f[6] ?? '' });
  }
  if (groups.size) warnOnce('Parts named U1.1, U1.2 … read as the parts of one multi-part part');

  sheets.forEach((sheet, si) => {
    const shapes = ((sheet.data.shape as string[] | undefined) ?? []).map(String);
    const r = new Records(), fonts = new Fonts();
    r.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
    const sheetIndex = r.bags.length;
    r.bags.push(PropertyBag.from({ RECORD: SR.SHEET }));
    const top = (props: Props, coords?: Record<string, Pt>) => r.add({ ...props, OWNERPARTID: -1 }, coords);
    const dc = { fonts, warnOnce };

    /* Where everything is: the sheet 500 mil round it */
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const see = (p: Pt) => { if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return; x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); };
    for (const rec of shapes) for (const part of rec.split('#@$')) for (const seg of part.split('^^')) {
      const f = fields(seg);
      switch (f[0]) {
        case 'W': case 'PL': case 'PG': case 'B': for (const p of pointList(at(f, 1))) see(p); break;
        case 'LIB': case 'N': case 'J': case 'O': case 'E': see({ x: num(f[1]), y: num(f[2]) }); break;
        case 'R': see({ x: num(f[1]), y: num(f[2]) }); see({ x: num(f[1]) + num(f[5]), y: num(f[2]) + num(f[6]) }); break;
        case 'T': see({ x: num(f[2]), y: num(f[3]) }); break;
        default: if (f.length === 2 && /^-?[\d.]+$/.test(f[0] ?? '') && /^-?[\d.]+$/.test(f[1] ?? '')) see({ x: num(f[0]), y: num(f[1]) });
      }
    }
    if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = 1000; y1 = 800; }
    // The corner on EasyEDA's grid (100 mil), so what was on it stays on it
    x0 = Math.floor(x0 / 10) * 10; y1 = Math.ceil(y1 / 10) * 10;
    const M = 50;
    const P = (p: Pt): Pt => ({ x: Math.round((p.x - x0 + M) * 1000) / 1000, y: Math.round((y1 - p.y + M) * 1000) / 1000 });
    let framed = false;

    /* ── parts ── */
    for (const [ri, rec] of shapes.entries()) {
      const parts = rec.split('#@$');
      const f = fields(parts[0]!);
      if (f[0] !== 'LIB') continue;
      const cpara = backtick(at(f, 3));
      const subs = parts.slice(1);
      if (isFrame(f, cpara, subs)) {
        framed = true;
        for (const s of subs) draw(r, s, P, { OWNERPARTID: -1 }, 0, false, dc);
        continue;
      }
      const origin = P({ x: num(f[1]), y: num(f[2]) });
      const quarter = ((Math.round(num(f[4]) / 90) % 4) + 4) % 4;
      const libRef0 = cpara.get('name') || cpara.get('spiceSymbolName') || 'Part';
      const textOf = (k: string) => subs.map(fields).find((q) => q[0] === 'T' && q[1] === k);
      const val = textOf('N');
      const pl = placed.get(`${si}:${ri}`)!;
      const designator = pl.designator || `${cpara.get('pre') || cpara.get('spicePre') || 'U'}?`;
      const comment = textValue(at(val ?? [], 12)) || libRef0;
      const libRef = pl.libRef;
      // The component as placed
      const notOnBoard = (cpara.get('package') ?? '') === 'NONE';
      const ci = top({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, PARTCOUNT: pl.parts + 1, DISPLAYMODECOUNT: 1, CURRENTPARTID: pl.part, ORIENTATION: quarter,
        AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: libRef, SOURCELIBRARYNAME: `${stem}.SchLib`, UNIQUEID: pl.uid ? uniqueIdFor(`easyeda:${pl.uid}`) : uniqueId(),
        ...(notOnBoard ? { COMPONENTKIND: 2 } : {}) }, { LOCATION: origin });
      const own: Props = { OWNERINDEX: ci - 1, OWNERPARTID: pl.part };
      const textProps = (t: string[], o: number) => ({ FONTID: fonts.id(fontPtsOf(t[7]) * 0.127, /bold/i.test(t[8] ?? ''), /italic/i.test(t[9] ?? '')), COLOR: colour(t[5], COL.text), ORIENTATION: o,
        JUSTIFICATION: justification(H_ANCHOR[t[14] ?? ''] ?? 0, V_BASE(t[10] ?? '')), ISHIDDEN: t[13] === '0' || undefined });
      let gotDes = false, gotCom = false;
      for (const s of subs) draw(r, s, P, own, 0, false, dc, {
        des: (t, p, o) => { gotDes = true; r.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: 'Designator', TEXT: designator, ...textProps(t, o) }, { LOCATION: p }); },
        com: (t, p, o) => { gotCom = true; r.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: 'Comment', TEXT: comment, ...textProps(t, o) }, { LOCATION: p }); },
      });
      if (!gotDes) r.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: 'Designator', TEXT: designator, FONTID: 1, COLOR: COL.text, ISHIDDEN: true }, { LOCATION: origin });
      if (!gotCom) r.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: 'Comment', TEXT: comment, FONTID: 1, COLOR: COL.text, ISHIDDEN: true }, { LOCATION: origin });
      // Its attributes as parameters (hidden), its package as the footprint
      for (const [k, v] of cpara) {
        if (/^(package|pre|spicePre|name|spiceSymbolName|nameAlias|Contributor|timeStamp|sourceId|image)$/.test(k) || !v) continue;
        r.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: k === 'link' ? 'Datasheet' : k, TEXT: v, COLOR: COL.text, FONTID: 1, ISHIDDEN: true }, { LOCATION: origin });
      }
      const pkg = cpara.get('package') ?? '';
      if (pkg && !notOnBoard) {
        const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci - 1, OWNERPARTID: -1 });
        const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list - 1, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: pkg, MODELTYPE: 'PCBLIB',
          DATAFILECOUNT: 1, MODELDATAFILEENTITY0: pkg, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: true, UNIQUEID: uniqueId() });
        r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
        r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
      }
      nParts++;
    }

    /* ── the sheet's own records ── */
    for (const rec of shapes) {
      const segs = rec.split('^^');
      const f = fields(segs[0]!);
      switch (f[0]) {
        case 'LIB': break;
        case 'W': case 'B': {
          const pts = pointList(at(f, 1)).map(P);
          if (pts.length >= 2) r.points(f[0] === 'W' ? { RECORD: SR.WIRE, OWNERPARTID: -1, LINEWIDTH: 1, COLOR: COL.wire, UNIQUEID: uniqueId() } : { RECORD: SR.BUS, OWNERPARTID: -1, LINEWIDTH: 2, COLOR: COL.bus }, pts);
          break;
        }
        case 'N': {
          const name = textValue(at(f, 5));
          if (!name) break;
          netNames.add(name);
          let o = ((Math.round(num(f[3]) / 90) % 4) + 4) % 4;
          if (f[7] === 'end') o = (o + 2) % 4;
          top({ RECORD: SR.NET_LABEL, TEXT: name, FONTID: fonts.id(fontPtsOf(f[11]) * 0.127), COLOR: COL.wire, ORIENTATION: o, UNIQUEID: uniqueId() }, { LOCATION: P({ x: num(f[1]), y: num(f[2]) }) });
          break;
        }
        case 'F': {
          const label = fields(segs[2] ?? '');
          const name = textValue(label[0] ?? '');
          const hotF = fields(segs[1] ?? '');
          const hot0 = hotF.length >= 2 ? { x: num(hotF[0]), y: num(hotF[1]) } : { x: num(f[2]), y: num(f[3]) };
          const hot = P(hot0);
          // Which way its body lies: from its point to its drawing's middle (the angle can't be trusted on mirrored ones)
          const pts = segs.slice(3).flatMap((g) => { const k = fields(g); return k[0] === 'PL' || k[0] === 'PG' ? pointList(at(k, 1)) : k[0] === 'E' ? [{ x: num(k[1]), y: num(k[2]) }] : []; }).map(P);
          const type = f[1] ?? '';
          const ground = /gnd/i.test(type), down = ground || /VEE|-5V/i.test(type);
          let orient = ((((down ? 3 : 1) + Math.round(num(f[4]) / 90)) % 4) + 4) % 4;
          if (pts.length) { const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length }; if (Math.hypot(c.x - hot.x, c.y - hot.y) > 0.5) orient = orientOf(hot, c); }
          if (!name) break;
          netNames.add(name);
          if (/netPort/i.test(type)) {
            // As long as its drawing reaches (its far end joins what it touches), else as its name needs
            const dir = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }][orient]!;
            const reach = Math.max(0, ...pts.map((q) => (q.x - hot.x) * dir.x + (q.y - hot.y) * dir.y));
            const w = reach >= 10 ? Math.round(reach) : Math.max(30, Math.ceil((name.length * 6 + 12) / 10) * 10);
            const loc = orient === 2 ? { x: hot.x - w, y: hot.y } : orient === 3 ? { x: hot.x, y: hot.y - w } : hot;
            top({ RECORD: SR.PORT, NAME: name, STYLE: orient % 2 ? 7 : 3, IOTYPE: 3, WIDTH: w, HEIGHT: 10, ALIGNMENT: 0, COLOR: COL.port, AREACOLOR: COL.portFill, TEXTCOLOR: COL.port, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: loc });
          } else {
            const style = /gnD$/.test(type) ? 4 : /GNd$/.test(type) ? 5 : /GnD$/.test(type) ? 6 : /gNd$/.test(type) ? 2 : /Bar$/i.test(type) ? 0 : 2;
            top({ RECORD: SR.POWER_PORT, STYLE: style, ORIENTATION: orient, TEXT: name, SHOWNETNAME: label[6] !== '0', COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: hot });
          }
          if (joinByLabel(name)) top({ RECORD: SR.NET_LABEL, TEXT: name, FONTID: 1, COLOR: COL.wire, ORIENTATION: orient % 2 ? 1 : 0, UNIQUEID: uniqueId() }, { LOCATION: hot });
          break;
        }
        case 'J': top({ RECORD: SR.JUNCTION, COLOR: COL.wire, LOCKED: true }, { LOCATION: P({ x: num(f[1]), y: num(f[2]) }) }); break;
        case 'O': top({ RECORD: SR.NO_ERC, COLOR: COL.noerc, ISACTIVE: true, SUPPRESSALL: true, SYMBOL: 'Thin Cross' }, { LOCATION: P({ x: num(f[1]), y: num(f[2]) }) }); break;
        case 'BE': warnOnce('Bus entries drawn as lines'); {
          const pts = pointList(`${at(f, 2)} ${at(f, 3)} ${at(f, 4)} ${at(f, 5)}`).map(P);
          if (pts.length >= 2) r.add({ RECORD: SR.BUS_ENTRY, OWNERPARTID: -1, LINEWIDTH: 1, COLOR: COL.wire }, { LOCATION: pts[0]!, CORNER: pts[1]! });
        }
          break;
        default: draw(r, rec, P, { OWNERPARTID: -1 }, 0, false, dc);
      }
    }

    /* ── the sheet record: as large as what's on it, AD's border and title block off where the sheet has its own frame ── */
    const W = Math.ceil((x1 - x0 + 2 * M) / 10) * 10, Hh = Math.ceil((y1 - y0 + 2 * M) / 10) * 10;
    r.bags[sheetIndex] = PropertyBag.from({ RECORD: SR.SHEET, ...fonts.keys(), USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true,
      CUSTOMX: W, CUSTOMY: Hh, CUSTOMXZONES: Math.max(4, Math.round(W / 250)), CUSTOMYZONES: Math.max(4, Math.round(Hh / 250)), CUSTOMMARGINWIDTH: 20,
      BORDERON: !framed, TITLEBLOCKON: !framed, AREACOLOR: toBgr(0xffffff),
      SNAPGRIDON: true, SNAPGRIDSIZE: 5, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 2, SYSTEMFONT: 1, DOCUMENTBORDERSTYLE: 0 } as Record<string, string | number | boolean>);
    r.bags[0]!.setRaw('WEIGHT', String(r.bags.length - 1));
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'FileHeader', joinSchRecords(r.bags.map((bag) => ({ kind: 0, data: bag.toBytes(), bag }))));
    cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
    const base = (sheet.title || `Sheet${si + 1}`).replace(/[\\/:*?"<>|]/g, '_');
    let name = sheets.length === 1 ? `${stem}.SchDoc` : `${base}.SchDoc`;
    for (let k = 2; out.some((o) => o.name.toLowerCase() === name.toLowerCase()); k++) name = `${base}_${k}.SchDoc`;
    out.push({ name, bytes: writeCfb(root) });
  });
  if (!out.length) warnings.push('No sheets in it');
  return { sheets: out, library: writeSchLib(symbols), symbols: symbols.length, warnings, stats: { sheets: out.length, parts: nParts, nets: netNames.size, symbols: symbols.length } };
}
