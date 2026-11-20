/**
 * EDIF 2 0 0 schematics as AD's: a SchDoc per page of the top cell (and of each cell a hierarchical
 * block places), a SchLib of the cells placed (each cell's symbol with its pins, the pin numbers its
 * ports or the instances give), parts placed as EDIF turns and mirrors them (R90 … MYR90), the
 * designator and value where the symbol shows them, the other properties as parameters, a
 * footprint property as the footprint model; nets drawn as their wires with junctions, their names
 * as net labels where EDIF shows them; the page's ports, power symbols in nets as power ports, and
 * the page's comment graphics and texts. Every pin EDIF joins to a net is checked against the
 * wires drawn: one no wire reaches gets a net label of its net on it, so the connections are
 * EDIF's whatever the drawing. Names a net keeps across pages join by name (AD's Global scope;
 * Hierarchical with blocks). A netlist-only EDIF (Konium's own EDIF for PCB, an FPGA tool's) gets
 * its parts drawn as boxes in rows, each pin's net named at it. The library's unit is AD's 10 mil.
 *
 * A text the file says is not shown is hidden (a designator, a value, a parameter, a pin's name
 * or number) or left out (a net's name where it is hidden: a name of the designer's own is still
 * put on the net once, a generated one not). What an instance shows of its own is where the page
 * has it; what its symbol shows is placed with the symbol. A ground or supply symbol the page
 * places in a port (xDX Designer's way) is a power port at its place, named as the global net its
 * wire joins, so that the pieces of a ground drawn apart are one net as they were.
 */
import { PropertyBag } from '../altium/props';
import { cfbPut, newEntry, writeCfb } from '../cfb/cfb';
import { joinSchRecords } from '../altium/framing';
import { binToBytes } from '../text';
import { writeSchLib } from '../altium/schlib';
import { SR } from '../../model/sch';
import { toBgr } from '../../model/common';
import { uniqueId } from '../../model/schEdit';
import { COL, Fonts, Records, fontPts, arcThrough, lengthKeys, orientOf, radius, type Props } from '../kicad/schematic';
import { uniqueIdFor } from '../kicad/board';
import type { ECell, EDisplay, EFigure, EInstance, ENet, EPage, EPort, EPortImpl, ESymbol, EView, EdifDoc, Pt } from './read';

export interface EdifSchResult {
  sheets: { name: string; bytes: Uint8Array }[];
  library: Uint8Array;
  symbols: number;
  warnings: string[];
  /** AD's Net Identifier Scope: 3 Global (flat), 2 Hierarchical (blocks). */
  scope: number;
  /** Designator → footprint the part names. */
  footprints: Map<string, string>;
  /** The connections as EDIF joins them (flat designs): net name → "designator-pin". */
  expected: Map<string, Set<string>> | null;
  stats: { sheets: number; parts: number; nets: number; symbols: number };
}

const lc = (s: string) => s.toLowerCase();
/** A name a tool made up for a net nothing names (AD's NetR1_2 among them). */
const generated = (n: string) => !n || /^(N|NET|\$N|NETN|N\$)[_$]?\d+$/i.test(n) || /^\$\d+N\d+$/.test(n) || /^Net[A-Za-z_]+\d+[A-Za-z]*_[A-Za-z0-9]+$/.test(n);
const busName = (n: string) => n.replace(/\[(\d+)\s*(?::|-|\.\.)\s*(\d+)\]/g, '[$1..$2]').replace(/<(\d+)\s*(?::|\.\.)\s*(\d+)>/g, '[$1..$2]');
const ELECTRICAL: Record<string, number> = { INPUT: 0, OUTPUT: 2, INOUT: 1 };
/** A pin's electrical type where a Pin Type property says it (xDX Designer's): over the port's direction. */
const PIN_TYPE: Record<string, number> = { ANALOG: 4, TERMINAL: 4, PASSIVE: 4, POWER: 7, GROUND: 7, OCL: 3, OEM: 6, TRI: 5, IN: 0, OUT: 2, BI: 1 };
const electricalOf = (port: EPort): number => { const t = [...port.props].find(([k]) => /^pin[ _]?type$/i.test(k))?.[1]?.toUpperCase(); return (t !== undefined ? PIN_TYPE[t] : undefined) ?? ELECTRICAL[port.dir] ?? 4; };
const shownOf = (ds: EDisplay[]): EDisplay | undefined => ds.find((d) => d.visible !== false && d.at);
const FOOTPRINT = ['PCB_FOOTPRINT', 'PCB FOOTPRINT', 'FOOTPRINT', 'PACKAGE', 'JEDEC_TYPE', 'PCBFOOTPRINT', 'PATTERN'];
const VALUE = ['VALUE', 'COMMENT', 'PART_NAME', 'PARTNAME', 'PART_NUMBER', 'DEVICE'];
const REFDES = ['REFDES', 'REF_DES', 'DESIGNATOR', 'REFERENCE', 'PART_REFERENCE', 'REF'];

/** An EDIF orientation as a matrix [a b c d]: x' = a·x + b·y, y' = c·x + d·y (EDIF and AD both Y up). */
const ORIENT: Record<string, [number, number, number, number]> = {
  R0: [1, 0, 0, 1], R90: [0, -1, 1, 0], R180: [-1, 0, 0, -1], R270: [0, 1, -1, 0],
  MX: [1, 0, 0, -1], MY: [-1, 0, 0, 1], MXR90: [0, 1, 1, 0], MYR90: [0, -1, -1, 0],
};
/** AD's ORIENTATION and ISMIRRORED for a matrix: AD mirrors left-right, then turns. */
function adOf(m: [number, number, number, number]): { orient: number; mirrored: boolean } {
  for (const mirrored of [false, true]) for (let k = 0; k < 4; k++) {
    const c = Math.round(Math.cos((k * Math.PI) / 2)), s = Math.round(Math.sin((k * Math.PI) / 2)), f = mirrored ? -1 : 1;
    if (c * f === m[0] && -s === m[1] && s * f === m[2] && c === m[3]) return { orient: k, mirrored };
  }
  return { orient: 0, mirrored: false };
}
const JUST: Record<string, [number, number]> = {
  UPPERLEFT: [0, 2], UPPERCENTER: [1, 2], UPPERRIGHT: [2, 2], CENTERLEFT: [0, 1], CENTERCENTER: [1, 1], CENTERRIGHT: [2, 1], LOWERLEFT: [0, 0], LOWERCENTER: [1, 0], LOWERRIGHT: [2, 0],
};

interface LibComp { libRef: string; cell: ECell; view: EView; sym: ESymbol | null; numbers: Map<string, string>; description: string; prefix: string }
interface Placer { pt: (p: Pt) => Pt; m: [number, number, number, number] }

function sheetBytes(r: Records): Uint8Array {
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', joinSchRecords(r.bags.map((bag) => ({ kind: 0, data: bag.toBytes(), bag }))));
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  return writeCfb(root);
}

/** A generated box symbol for a cell with no symbol (a netlist view): inputs left, outputs right, the rest shared. */
function boxSymbol(ports: EPort[]): ESymbol {
  const left: EPort[] = [], right: EPort[] = [];
  for (const p of ports) { if (p.dir === 'OUTPUT') right.push(p); else if (p.dir === 'INPUT') left.push(p); else (left.length <= right.length ? left : right).push(p); }
  const rows = Math.max(1, left.length, right.length);
  const longest = Math.max(1, ...ports.map((p) => p.name.text.length));
  const w = Math.max(4, Math.ceil((longest * 2 * 6 + 20) / 10)) * 10;
  const h = rows * 10 + 10;
  const pins = new Map<string, EPortImpl>();
  const put = (list: EPort[], x0: number, dx: number) => list.forEach((p, i) => {
    const y = -10 - i * 10;
    pins.set(lc(p.name.id), { name: p.name.id, figures: [{ group: 'PIN', shapes: [{ kind: 'path', pts: [{ x: x0, y }, { x: x0 + dx, y }] }] }], connect: { x: x0 + dx, y }, displays: [], nameDisplays: [], symbols: [] });
  });
  put(left, 0, -20);
  put(right, w, 20);
  return { figures: [{ group: 'BODY', shapes: [{ kind: 'rect', a: { x: 0, y: 0 }, b: { x: w, y: -h } }] }], pins, texts: [], shows: [], box: { a: { x: -20, y: 0 }, b: { x: w + 20, y: -h } } };
}

export function convertEdif(doc: EdifDoc, stem: string, footprintLib = ''): EdifSchResult {
  const warnings: string[] = [...doc.warnings];
  const warnOnce = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  const cellOf = (cell: string, lib?: string): ECell | undefined => {
    if (lib) { const c = doc.libraries.get(lib)?.cells.get(cell); if (c) return c; }
    for (const l of doc.libraries.values()) { const c = l.cells.get(cell); if (c) return c; }
    return undefined;
  };
  const unitOf = (c: ECell | undefined) => (doc.libraries.get(c?.lib ?? '')?.mmPerUnit ?? 0.254) / 0.254;
  const pagesView = (c: ECell | undefined): EView | undefined => c?.views.filter((v) => v.pages.length).sort((a, b) => (a.type === 'SCHEMATIC' ? 0 : 1) - (b.type === 'SCHEMATIC' ? 0 : 1))[0];
  const symbolView = (c: ECell, name: string): EView | undefined => c.views.find((v) => v.name === lc(name) && v.symbol) ?? c.views.find((v) => v.symbol) ?? c.views.find((v) => v.name === lc(name)) ?? c.views[0];

  // The top cell: the design's, else one with pages no instance places
  let top = doc.design ? cellOf(doc.design.cell, doc.design.lib) : undefined;
  if (!top || !pagesView(top)) {
    const placed = new Set<string>();
    for (const l of doc.libraries.values()) for (const c of l.cells.values()) for (const v of c.views) for (const p of v.pages) for (const i of p.instances) placed.add(i.cell);
    top = [...doc.libraries.values()].flatMap((l) => [...l.cells.values()]).find((c) => pagesView(c) && !placed.has(lc(c.name.id))) ?? top;
  }
  const topView = pagesView(top);
  if (!top || !topView) throw new Error('no design in it (no cell with contents)');
  const isBlock = (i: EInstance) => { const c = cellOf(i.cell, i.lib); return !!c && c !== top && !!pagesView(c); };
  const blockCells: ECell[] = [];
  const collect = (v: EView, seen: ECell[]) => {
    for (const p of v.pages) for (const i of p.instances) {
      if (!isBlock(i)) continue;
      const c = cellOf(i.cell, i.lib)!;
      if (seen.includes(c)) { warnOnce('A block that places itself (recursion) left out'); continue; }
      if (!blockCells.includes(c)) { blockCells.push(c); collect(pagesView(c)!, [...seen, c]); }
    }
  };
  collect(topView, [top]);
  const hierarchical = blockCells.length > 0;
  const scope = hierarchical ? 2 : 3;
  const netlistOnly = !topView.pages.some((p) => p.instances.some((i) => { const c = cellOf(i.cell, i.lib); return !!c && !!symbolView(c, i.view)?.symbol; }) || p.nets.some((n) => n.figures.length));

  /* ── the library: each cell (and view) placed, a component ── */
  const libs = new Map<string, LibComp>();
  const libRefs = new Set<string>();
  const libFor = (i: EInstance): LibComp | null => {
    const cell = cellOf(i.cell, i.lib);
    if (!cell) { warnOnce('Instances of cells the file doesn\'t define left out'); return null; }
    const view = symbolView(cell, i.view)!;
    if (!view) return null;
    // Pin numbers: this instance's (the design's own numbering), else the port's designator, else the port's name
    const numbers = new Map<string, string>();
    for (const p of view.ports) numbers.set(lc(p.name.id), i.pinNumbers.get(lc(p.name.id)) ?? p.designator ?? p.name.text);
    const sig = [...numbers].map(([k, v]) => `${k}=${v}`).join(';');
    const key = `${cell.lib}|${lc(cell.name.id)}|${view.name}|${sig}`;
    let comp = libs.get(key);
    if (!comp) {
      const want = cell.name.text.replace(/[\r\n]/g, ' ') || 'Part';
      let libRef = want;
      for (let k = 2; libRefs.has(lc(libRef)); k++) libRef = `${want}_${k}`;
      libRefs.add(lc(libRef));
      const sym = view.symbol ?? (view.ports.length ? boxSymbol(view.ports) : null);
      const prefix = /^([A-Za-z]+)/.exec(i.designator ?? i.name.text)?.[1] ?? 'U';
      comp = { libRef, cell, view, sym, numbers, description: view.props.get('DESCRIPTION') ?? '', prefix };
      libs.set(key, comp);
      if (!view.symbol && !netlistOnly) warnOnce('Cells with no symbol drawn as boxes with their pins');
    }
    return comp;
  };

  /* ── drawing ── */
  const fonts = new Fonts();
  /**
   * A text's font from the height the file gives it: its capitals stand 0.63 of that height [est: a
   * sheet of xDX Designer's set against the same sheet as a PDF, where a text 2.54 mm high is set
   * in type of 6.36 points]; 1.27 mm of capitals (10 points) where the file gives none.
   */
  const CAPS = 0.63;
  const fontOf = (d: EDisplay | undefined): number => fonts.id(d?.height ? d.height * CAPS : 1.27);
  // Pins are drawn in the sheet's system font (font 1): the size most of the file's pin names and numbers have
  {
    const count = new Map<number, number>();
    for (const lib of doc.libraries.values()) for (const c of lib.cells.values()) for (const v of c.views) for (const impl of v.symbol?.pins.values() ?? []) {
      for (const d of [...impl.nameDisplays, ...impl.displays.map((x) => x.d)]) if (d.height && d.visible !== false) { const pts = fontPts(d.height * CAPS); count.set(pts, (count.get(pts) ?? 0) + 1); }
    }
    const most = [...count].sort((a, b) => b[1] - a[1])[0];
    if (most) fonts.sizes[0] = most[0] * 4;
  }
  const look = (group: string): Props => ({ COLOR: /wire|net/i.test(group) ? COL.wire : COL.body, LINEWIDTH: /wide|thick|bold/i.test(group) ? 2 : 1 });
  const drawFigures = (r: Records, figs: EFigure[], pl: Placer, own: Props, color?: number) => {
    for (const f of figs) {
      if (/^pin/i.test(f.group)) continue;
      const lk: Props = { ...look(f.group), ...(color !== undefined ? { COLOR: color } : {}) };
      const fill: Props = /fill|solid/i.test(f.group) ? { AREACOLOR: lk.COLOR, ISSOLID: true } : { AREACOLOR: COL.fill, ISSOLID: false, TRANSPARENT: true };
      for (const s of f.shapes) {
        if (s.kind === 'path' || s.kind === 'polygon') {
          const pts = s.pts.map(pl.pt);
          if (pts.length < 2) continue;
          if (s.kind === 'polygon' && pts.length >= 3) r.points({ RECORD: SR.POLYGON, ...own, ...lk, ...fill }, pts);
          else if (pts.length === 2) r.add({ RECORD: SR.LINE, ...own, ...lk }, { LOCATION: pts[0]!, CORNER: pts[1]! });
          else r.points({ RECORD: SR.POLYLINE, ...own, ...lk }, pts);
        } else if (s.kind === 'rect') {
          const a = pl.pt(s.a), b = pl.pt(s.b);
          r.add({ RECORD: SR.RECTANGLE, ...own, ...lk, ...fill }, { LOCATION: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, CORNER: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } });
        } else if (s.kind === 'circle') {
          const a = pl.pt(s.a), b = pl.pt(s.b);
          const rr = Math.hypot(a.x - b.x, a.y - b.y) / 2;
          r.add({ RECORD: SR.ELLIPSE, ...own, ...lk, ...fill, ...radius('RADIUS', rr), ...radius('SECONDARYRADIUS', rr) }, { LOCATION: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
        } else if (s.kind === 'arc') {
          const t = arcThrough(pl.pt(s.a), pl.pt(s.m), pl.pt(s.b));
          if (t) r.add({ RECORD: SR.ARC, ...own, ...lk, ...radius('RADIUS', t.r), STARTANGLE: t.start.toFixed(3), ENDANGLE: t.end.toFixed(3) }, { LOCATION: t.c });
          else r.add({ RECORD: SR.LINE, ...own, ...lk }, { LOCATION: pl.pt(s.a), CORNER: pl.pt(s.b) });
        } else if (s.kind === 'dot') {
          r.add({ RECORD: SR.ELLIPSE, ...own, ...lk, AREACOLOR: lk.COLOR, ISSOLID: true, ...radius('RADIUS', 0.5), ...radius('SECONDARYRADIUS', 0.5) }, { LOCATION: pl.pt(s.at) });
        }
      }
    }
  };
  /** A text where its display puts it: turned and justified as shown (AD's JUSTIFICATION, ORIENTATION). */
  const textProps = (d: EDisplay | undefined, pl: Placer): { props: Props; at: Pt | undefined } => {
    if (!d?.at) return { props: {}, at: undefined };
    const [h, v] = JUST[d.justify ?? 'LOWERLEFT'] ?? [0, 0];
    const own = ORIENT[d.orient ?? 'R0'] ?? ORIENT.R0!;
    // The text's direction, placed: the placement's turn on top of the display's own
    const m = pl.m, dx = m[0] * own[0] + m[1] * own[2], dy = m[2] * own[0] + m[3] * own[2];
    const o = Math.round(((Math.atan2(dy, dx) * 2) / Math.PI + 4)) % 4;
    // AD can't draw text upside down: a half turn turns its justification round instead
    const flip = o >= 2;
    return { props: { ORIENTATION: o % 2, JUSTIFICATION: (flip ? 2 - v : v) * 3 + (flip ? 2 - h : h), FONTID: fontOf(d) }, at: pl.pt(d.at) };
  };
  /** A symbol's pins: at the body end, pointing out to where they connect; returns where each connects. */
  const drawPins = (r: Records, comp: LibComp, pl: Placer, own: Props, inst?: EInstance): Map<string, Pt> => {
    const out = new Map<string, Pt>();
    const sym = comp.sym;
    if (!sym) return out;
    const box = sym.box ?? boxOfFigures(sym.figures);
    const centre = box ? { x: (box.a.x + box.b.x) / 2, y: (box.a.y + box.b.y) / 2 } : { x: 0, y: 0 };
    for (const port of comp.view.ports) {
      const impl = sym.pins.get(lc(port.name.id));
      if (!impl) continue;
      const path = impl.figures.flatMap((f) => f.shapes).find((s) => s.kind === 'path' && s.pts.length >= 2);
      let hotE = impl.connect, bodyE: Pt | undefined;
      if (path && path.kind === 'path') {
        const a = path.pts[0]!, b = path.pts[path.pts.length - 1]!;
        if (!hotE) hotE = Math.hypot(a.x - centre.x, a.y - centre.y) > Math.hypot(b.x - centre.x, b.y - centre.y) ? a : b;
        bodyE = Math.hypot(a.x - hotE.x, a.y - hotE.y) > Math.hypot(b.x - hotE.x, b.y - hotE.y) ? a : b;
      }
      if (!hotE) continue;
      const hot = pl.pt(hotE), body = bodyE ? pl.pt(bodyE) : hot;
      const len = Math.hypot(body.x - hot.x, body.y - hot.y);
      const o = len > 0.01 ? orientOf(body, hot) : orientOf(pl.pt(centre), hot);
      const name = busName(port.name.text);
      const number = comp.numbers.get(lc(port.name.id)) ?? name;
      // Shown as the file says where it says (the name by its display, the number by the instance's or the symbol's); else a name that is not the number
      const said = impl.nameDisplays.some((d) => d.visible !== undefined);
      const showName = said ? impl.nameDisplays.some((d) => d.visible !== false) : name !== number || !!impl.nameDisplays.length;
      const numberSaid = impl.displays.filter((d) => d.kw === 'designator' && d.d.visible !== undefined);
      const showNumber = inst?.pinShown.get(lc(port.name.id)) ?? (numberSaid.length ? numberSaid.some((d) => d.d.visible !== false) : true);
      r.add({ RECORD: SR.PIN, ...own, ELECTRICAL: electricalOf(port), PINCONGLOMERATE: o | (showName ? 0x08 : 0) | (showNumber ? 0x10 : 0), ...lengthKeys(len), NAME: name, DESIGNATOR: number, COLOR: COL.pin }, { LOCATION: len > 0.01 ? body : hot });
      out.set(lc(port.name.id), hot);
    }
    return out;
  };

  /* ── the sheets ── */
  const sheets: { name: string; bytes: Uint8Array }[] = [];
  const taken = new Set<string>();
  const fileFor = (base: string) => {
    const b = base.replace(/[\\/:*?"<>|;]/g, '_').replace(/\s+/g, ' ').trim() || 'Sheet';
    let name = `${b}.SchDoc`;
    for (let k = 2; taken.has(lc(name)); k++) name = `${b}_${k}.SchDoc`;
    taken.add(lc(name));
    return name;
  };
  const cellFiles = new Map<ECell, string[]>();
  const filesOf = (c: ECell): string[] => {
    let f = cellFiles.get(c);
    if (!f) {
      const pages = pagesView(c)!.pages;
      f = pages.map((p, k) => fileFor(c === top && pages.length === 1 ? stem : pages.length === 1 ? c.name.text : `${c === top ? stem : c.name.text} ${p.name.text || k + 1}`));
      cellFiles.set(c, f);
    }
    return f;
  };
  filesOf(top);
  for (const c of blockCells) filesOf(c);

  const footprints = new Map<string, string>();
  const expected: Map<string, Set<string>> | null = hierarchical ? null : new Map();
  let nParts = 0;
  const netNames = new Set<string>();
  const designatorsSeen = new Map<string, number>();
  // Names a net has on more than one page of its cell: labelled so they join
  const pageCount = (v: EView) => { const m = new Map<string, number>(); for (const p of v.pages) for (const n of new Set(p.nets.map((x) => lc(x.name.text)))) m.set(n, (m.get(n) ?? 0) + 1); return m; };

  const convertCell = (cell: ECell, view: EView) => {
    const files = filesOf(cell);
    const k = unitOf(cell);
    const spans = pageCount(view);
    const portDir = new Map(view.ports.map((p) => [lc(p.name.id), p.dir]));
    view.pages.forEach((page, pi) => {
      const r = new Records();
      r.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
      const sheetIndex = r.bags.length;
      r.bags.push(PropertyBag.from({ RECORD: SR.SHEET }));
      const topRec = (props: Props, coords?: Record<string, Pt>) => r.add({ ...props, OWNERPARTID: -1 }, coords);
      // The page's extent: its size, else what is drawn on it
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const see = (q: Pt) => { if (q.x < x0) x0 = q.x; if (q.y < y0) y0 = q.y; if (q.x > x1) x1 = q.x; if (q.y > y1) y1 = q.y; };
      if (page.size) { see(page.size.a); see(page.size.b); }
      else {
        for (const i of page.instances) {
          see(i.at);
          // The symbol's extent where it is placed (and room for the names a netlist puts at its pins)
          const c = cellOf(i.cell, i.lib), sv = c ? symbolView(c, i.view) : undefined;
          const sym = sv?.symbol ?? (netlistOnly && sv?.ports.length ? boxSymbol(sv.ports) : undefined);
          const bb = sym ? sym.box ?? boxOfFigures(sym.figures) : undefined;
          const m = ORIENT[i.orient] ?? ORIENT.R0!, ku = unitOf(c) / unitOf(cell), pad = netlistOnly ? 60 : 0;
          if (bb) for (const q of [bb.a, bb.b, { x: bb.a.x, y: bb.b.y }, { x: bb.b.x, y: bb.a.y }]) {
            const x = i.at.x + (m[0] * q.x + m[1] * q.y) * ku, y = i.at.y + (m[2] * q.x + m[3] * q.y) * ku;
            see({ x: x - pad, y: y - 10 }); see({ x: x + pad, y: y + 10 });
          }
        }
        for (const n of page.nets) for (const f of n.figures) for (const s of f.shapes) for (const q of ptsOf(s)) see(q);
        for (const f of page.comments.figures) for (const s of f.shapes) for (const q of ptsOf(s)) see(q);
      }
      if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = 1000; y1 = 750; }
      const M = page.size ? 0 : 100;
      // AD's title block (on when EDIF gives no page size) takes the bottom right: room under the drawing for it
      if (!page.size) y0 -= 80 / k;
      const P = (q: Pt): Pt => ({ x: Math.round(((q.x - x0) * k + M) * 1000) / 1000, y: Math.round(((q.y - y0) * k + M) * 1000) / 1000 });
      const pagePl: Placer = { pt: P, m: [1, 0, 0, 1] };
      const pinAt = new Map<string, Pt>();   // "instance|port" → where it connects
      const instDesignator = new Map<string, string>();

      /* parts and blocks */
      const placeOf = (i: EInstance, ku: number): Placer => {
        const m = ORIENT[i.orient] ?? ORIENT.R0!;
        if (!ORIENT[i.orient]) warnOnce(`Instances turned ${i.orient} placed unturned`);
        return { m, pt: (q) => P({ x: i.at.x + (m[0] * q.x + m[1] * q.y) * ku / k, y: i.at.y + (m[2] * q.x + m[3] * q.y) * ku / k }) };
      };
      const designatorOf = (i: EInstance) => {
        const prop = (names: string[]) => { for (const [n, v] of i.props) if (names.includes(n.toUpperCase().replace(/\s+/g, '_')) && v.value) return v.value; return undefined; };
        return i.designator || prop(REFDES) || i.name.text;
      };
      for (const inst of page.instances) {
        const cellI = cellOf(inst.cell, inst.lib);
        if (isBlock(inst)) {
          const c = cellI!;
          const pl = placeOf(inst, unitOf(c));
          const sv = symbolView(c, inst.view);
          const sym = sv?.symbol;
          const bb = sym?.box ?? (sym ? boxOfFigures(sym.figures) : undefined) ?? { a: { x: 0, y: 0 }, b: { x: 200, y: -100 } };
          const ca = pl.pt(bb.a), cb = pl.pt(bb.b);
          const xa = Math.min(ca.x, cb.x), xb = Math.max(ca.x, cb.x), ya = Math.min(ca.y, cb.y), yb = Math.max(ca.y, cb.y);
          const w = Math.max(20, xb - xa), h = Math.max(20, yb - ya);
          const si = topRec({ RECORD: SR.SHEET_SYMBOL, XSIZE: Math.round(w), YSIZE: Math.round(h), LINEWIDTH: 1, COLOR: COL.sheet, AREACOLOR: COL.sheetFill, ISSOLID: true, UNIQUEID: uniqueIdFor(`edif:${stem}:${files[pi]}:${inst.name.id}`) }, { LOCATION: { x: xa, y: yb } });
          topRec({ RECORD: SR.SHEET_NAME, OWNERINDEX: si - 1, TEXT: designatorOf(inst), FONTID: fonts.id(1.27), COLOR: COL.text }, { LOCATION: { x: xa, y: yb + 2 } });
          topRec({ RECORD: SR.FILE_NAME, OWNERINDEX: si - 1, TEXT: filesOf(c).join(';'), FONTID: fonts.id(1.27), COLOR: COL.text }, { LOCATION: { x: xa, y: ya - 10 } });
          // An entry for each port, on the side its pin reaches
          for (const port of sv?.ports ?? []) {
            const impl = sym?.pins.get(lc(port.name.id));
            const q = impl?.connect ?? impl?.figures.flatMap((f) => f.shapes).flatMap(ptsOf)[0];
            if (!q) continue;
            const at = pl.pt(q);
            const dl = Math.abs(at.x - xa), dr = Math.abs(at.x - xb), dt = Math.abs(at.y - yb), db = Math.abs(at.y - ya);
            const best = Math.min(dl, dr, dt, db);
            const side = best === dl ? 0 : best === dr ? 1 : best === dt ? 2 : 3;
            const dist = side < 2 ? yb - at.y : at.x - xa;
            const whole = Math.max(1, Math.round(dist / 10));
            topRec({ RECORD: SR.SHEET_ENTRY, OWNERINDEX: si - 1, SIDE: side, DISTANCEFROMTOP: whole, NAME: busName(port.name.text), IOTYPE: port.dir === 'INPUT' ? 2 : port.dir === 'OUTPUT' ? 1 : 3, STYLE: side < 2 ? 3 : 7,
              COLOR: COL.port, AREACOLOR: COL.portFill, TEXTCOLOR: COL.port, FONTID: fonts.id(1.27), UNIQUEID: uniqueId() });
            // Where the entry's wire meets it: on the symbol's edge
            pinAt.set(`${lc(inst.name.id)}|${lc(port.name.id)}`, side === 0 ? { x: xa, y: yb - whole * 10 } : side === 1 ? { x: xb, y: yb - whole * 10 } : side === 2 ? { x: xa + whole * 10, y: yb } : { x: xa + whole * 10, y: ya });
          }
          continue;
        }
        const comp = libFor(inst);
        if (!comp) continue;
        nParts++;
        const pl = placeOf(inst, unitOf(comp.cell));
        const ad = adOf(pl.m);
        let des = designatorOf(inst);
        const seen = designatorsSeen.get(des) ?? 0;
        designatorsSeen.set(des, seen + 1);
        if (seen) { warnOnce('Designators used twice: the second and later get a suffix'); des = `${des}_${seen + 1}`; }
        instDesignator.set(lc(inst.name.id), des);
        // (the first of the names that the part has, in the list's order: a Value before a Part Name)
        const propOf = (names: string[]) => { for (const want of names) for (const [n, v] of inst.props) if (n.toUpperCase().replace(/\s+/g, '_') === want && v.value.trim()) return { name: n, ...v, value: v.value.trim() }; return undefined; };
        const value = propOf(VALUE);
        const fp = propOf(FOOTPRINT)?.value;
        if (fp) footprints.set(des, fp);
        const ci = topRec({ RECORD: SR.COMPONENT, LIBREFERENCE: comp.libRef, PARTCOUNT: 2, DISPLAYMODECOUNT: 1, CURRENTPARTID: 1, ORIENTATION: ad.orient, ISMIRRORED: ad.mirrored || undefined,
          AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: comp.libRef, SOURCELIBRARYNAME: `${stem}.SchLib`, COMPONENTDESCRIPTION: comp.description || undefined,
          UNIQUEID: uniqueIdFor(`edif:${stem}:${files[pi]}:${inst.name.id}`) }, { LOCATION: pl.pt({ x: 0, y: 0 }) });
        const own: Props = { OWNERINDEX: ci - 1, OWNERPARTID: 1 };
        if (comp.sym) {
          drawFigures(r, comp.sym.figures, pl, own);
          for (const t of comp.sym.texts) { const tp = textProps(t.display.find((d) => d.visible !== false), pl); if (tp.at) r.add({ RECORD: SR.LABEL, ...own, TEXT: t.text, COLOR: COL.body, ...tp.props }, { LOCATION: tp.at }); }
        }
        for (const [port, at] of drawPins(r, comp, pl, own, inst)) pinAt.set(`${lc(inst.name.id)}|${port}`, at);
        // Designator and value where the symbol (or the instance) shows them, else by the body
        const bb = comp.sym ? comp.sym.box ?? boxOfFigures(comp.sym.figures) : undefined;
        const corner = (top: boolean) => { const q = bb ? pl.pt({ x: Math.min(bb.a.x, bb.b.x), y: top ? Math.max(bb.a.y, bb.b.y) : Math.min(bb.a.y, bb.b.y) }) : pl.pt({ x: 0, y: 0 }); return { x: q.x, y: q.y + (top ? 2 : -10) }; };
        // Each text where the file shows it: what the instance shows of its own is where the page has it, what its symbol
        // shows is placed with the symbol; one the file says is not shown is hidden
        const symShow = (what: string[]): EDisplay[] => comp.sym?.shows.filter((s) => what.includes(s.what)).map((s) => s.d) ?? [];
        const field = (rec: number, name: string, text: string, mine: EDisplay[], theirs: EDisplay[], fallbackTop: boolean, hideBare = false) => {
          const m = mine.filter((d) => d.at), t = theirs.filter((d) => d.at);
          const tp = m.length ? textProps(shownOf(m) ?? m[0], pagePl) : t.length ? textProps(shownOf(t) ?? t[0], pl) : { props: {} as Props, at: undefined };
          const hidden = m.length ? !shownOf(m) : t.length ? !shownOf(t) : hideBare;
          r.add({ RECORD: rec, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: name, TEXT: text, COLOR: COL.text, FONTID: fonts.id(1.27), ...tp.props, ...(hidden ? { ISHIDDEN: true } : {}) }, { LOCATION: tp.at ?? corner(fallbackTop) });
        };
        field(SR.DESIGNATOR, 'Designator', des, inst.designatorDisplays, symShow(['designator', 'refdes', 'ref_des', 'reference']), true);
        if (value) field(SR.PARAMETER, 'Comment', value.value, value.displays, symShow(['value', 'cell', 'comment', 'part_name']), false);
        else field(SR.PARAMETER, 'Comment', comp.cell.name.text, inst.cellDisplays, symShow(['cell', 'comment', 'part_name']), false);
        // (the cell's name shown beside a value: a parameter of its own)
        if (value && shownOf(inst.cellDisplays)) field(SR.PARAMETER, 'Cell', comp.cell.name.text, inst.cellDisplays, [], false);
        for (const [n, v] of inst.props) {
          const N = n.toUpperCase().replace(/\s+/g, '_');
          if (!v.value.trim() || n === value?.name || REFDES.includes(N) || /^(Comment|Designator)$/i.test(n)) continue;
          field(SR.PARAMETER, n, v.value.trim(), v.displays, symShow([lc(n), lc(n).replace(/\s+/g, '_')]), false, true);
        }
        if (fp) {
          const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci - 1, OWNERPARTID: -1 });
          const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: fp, MODELTYPE: 'PCBLIB',
            DATAFILECOUNT: 1, MODELDATAFILEENTITY0: fp, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: true, UNIQUEID: uniqueId() });
          r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl, OWNERPARTID: -1 });
          r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl, OWNERPARTID: -1 });
        }
      }

      /* netlist-only: the parts in rows, every pin's net named at it */
      if (netlistOnly) layoutNetlist(r, page, pinAt, instDesignator);

      /* nets: wires, junctions, labels — and every joined pin on its net */
      const segs: { a: Pt; b: Pt; net: number }[] = [];
      const ends = new Map<string, number>();
      const key = (q: Pt) => `${Math.round(q.x * 100)},${Math.round(q.y * 100)}`;
      // Where a net's power symbols stand: a pin there is on the net without a wire
      const powerAt: { at: Pt; net: number }[] = [];
      const onNet = (q: Pt, net: number) => segs.some((s) => s.net === net && onSeg(q, s.a, s.b)) || powerAt.some((p) => p.net === net && Math.hypot(p.at.x - q.x, p.at.y - q.y) < 0.05);
      // A net that joins a global of the cell through an off-page connector no port is drawn for (xDX Designer's grounds and
      // supplies) is that global: its first name where it has several ("GND,AGND")
      const globalOf = (net: ENet): string | undefined => {
        for (const j of net.joined) {
          if (j.inst || page.ports.some((q) => lc(q.name) === j.port)) continue;
          const t = view.offPage.get(j.port);
          if (t) return busName(t.replace(/_\(offpage::\d+\)$/i, '').split(',')[0]!.trim()) || undefined;
        }
        return undefined;
      };
      const nameOfNet = (net: ENet): string => globalOf(net) ?? busName(net.name.text);
      /** A ground or supply symbol as a power port of its net's name, where it connects. */
      const powerSymbol = (ps: EInstance, name: string, ni: number, where?: Pt): void => {
        const c = cellOf(ps.cell, ps.lib);
        const sv = c ? symbolView(c, ps.view) : undefined;
        const pl = placeOf(ps, unitOf(c));
        const impl = sv?.symbol ? [...sv.symbol.pins.values()][0] : undefined;
        const at = where ?? pl.pt(impl?.connect ?? { x: 0, y: 0 });
        const body = sv?.symbol ? boxOfFigures(sv.symbol.figures) : undefined;
        const o = body ? orientOf(at, pl.pt({ x: (body.a.x + body.b.x) / 2, y: (body.a.y + body.b.y) / 2 })) : 1;
        const ground = /gnd|ground|vss|earth/i.test(`${c?.name.text ?? ''} ${name}`);
        // A stem and one line across it is a bar; a ground drawn otherwise is the power ground
        const shapes = sv?.symbol?.figures.flatMap((f) => f.shapes) ?? [];
        const bar = shapes.length > 0 && shapes.length <= 2 && shapes.every((q) => q.kind === 'path' && q.pts.length === 2);
        topRec({ RECORD: SR.POWER_PORT, STYLE: bar ? 2 : ground ? 4 : 2, ORIENTATION: o, TEXT: name, SHOWNETNAME: !ground, COLOR: COL.power, FONTID: fonts.id(1.27), UNIQUEID: uniqueId() }, { LOCATION: at });
        powerAt.push({ at, net: ni });
      };
      /** A net's wires as the pieces they are drawn in: segments that share an end, or end on one another, are one piece. */
      const piecesOf = (list: { a: Pt; b: Pt }[]): { a: Pt; b: Pt }[][] => {
        const of = list.map((_, i) => i);
        const root = (i: number): number => (of[i] === i ? i : (of[i] = root(of[i]!)));
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const p = list[i]!, q = list[j]!;
          if (onSeg(p.a, q.a, q.b) || onSeg(p.b, q.a, q.b) || onSeg(q.a, p.a, p.b) || onSeg(q.b, p.a, p.b)) of[root(i)] = root(j);
        }
        const groups = new Map<number, { a: Pt; b: Pt }[]>();
        list.forEach((sg, i) => { const g = groups.get(root(i)); if (g) g.push(sg); else groups.set(root(i), [sg]); });
        return [...groups.values()];
      };
      const symbolNets = new Set<number>();
      page.nets.forEach((net, ni) => {
        const name = nameOfNet(net);
        for (const f of net.figures) for (const s of f.shapes) {
          if (s.kind !== 'path' || s.pts.length < 2) continue;
          const pts = s.pts.map(P);
          r.points({ RECORD: /bus/i.test(f.group) ? SR.BUS : SR.WIRE, OWNERPARTID: -1, COLOR: COL.wire, LINEWIDTH: 1, UNIQUEID: uniqueId() }, pts);
          for (let q = 1; q < pts.length; q++) segs.push({ a: pts[q - 1]!, b: pts[q]!, net: ni });
          for (const e of [pts[0]!, pts[pts.length - 1]!]) ends.set(key(e), (ends.get(key(e)) ?? 0) + 1);
          for (let q = 1; q < pts.length - 1; q++) ends.set(key(pts[q]!), (ends.get(key(pts[q]!)) ?? 0) + 2);
        }
        // Power symbols drawn in the net: power ports at their pin (or origin)
        for (const ps of net.instances) powerSymbol(ps, name, ni);
      });
      // Ground and supply symbols the page places in ports: power ports where they connect, on the net whose wire is there
      for (const pimpl of page.ports) for (const ps of pimpl.symbols) {
        const q = P(pimpl.connect ?? ps.at);
        const ni = segs.find((sg) => onSeg(q, sg.a, sg.b))?.net ?? -1;
        const shownName = [...ps.props].find(([n]) => /^global[ _]signal[ _]name$/i.test(n))?.[1].value.split('|').pop();
        powerSymbol(ps, ni >= 0 ? nameOfNet(page.nets[ni]!) : busName(shownName || pimpl.name), ni, q);
        if (ni >= 0) symbolNets.add(ni);
      }
      // Junctions: three wire ends meet, or an end lands on another wire's middle
      for (const [kq, n] of ends) {
        const [xs, ys] = kq.split(',').map((v) => Number(v) / 100);
        const q = { x: xs!, y: ys! };
        const through = segs.filter((s) => onSeg(q, s.a, s.b) && key(s.a) !== kq && key(s.b) !== kq).length;
        if (n + 2 * through >= 3) topRec({ RECORD: SR.JUNCTION, COLOR: COL.wire }, { LOCATION: q });
      }
      const labelled = new Set<string>();
      let added = 0;
      page.nets.forEach((net, ni) => {
        const name = nameOfNet(net);
        if (!name) return;
        // (a net that joins nothing and has no wire, such as the one a global is declared by, is no net of the sheet)
        if (net.joined.length || net.figures.length) netNames.add(name);
        // (where the file shows the name; a display it says is not shown is no place for a label)
        const shownAt = net.name.displays.filter((d) => d.visible !== false);
        // (a label where the file shows the name is turned and justified as the file has it: one that ends at its place reads back over its wire)
        const label = (at: Pt, vertical: boolean, d?: EDisplay) => {
          const how = d ? textProps(d, pagePl).props : {};
          topRec({ RECORD: SR.NET_LABEL, TEXT: name, FONTID: how.FONTID ?? fonts.id(1.27), COLOR: COL.wire, ORIENTATION: vertical ? 1 : 0, ...(d ? { JUSTIFICATION: how.JUSTIFICATION } : {}), UNIQUEID: uniqueId() }, { LOCATION: at });
          labelled.add(`${ni}|${key(at)}`);
        };
        /** Where a label the file gives no place for goes: the middle of the longest of some wires, on the grid. */
        const middle = (list: { a: Pt; b: Pt }[]): { at: Pt; vertical: boolean } => {
          const sg = list.reduce((p, q) => (Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) > Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) ? q : p));
          const vertical = sg.a.x === sg.b.x, horizontal = sg.a.y === sg.b.y;
          const mid = (p: number, q: number) => Math.min(Math.max(p, q), Math.max(Math.min(p, q), Math.round((p + q) / 20) * 10));
          const at = vertical ? { x: sg.a.x, y: mid(sg.a.y, sg.b.y) } : horizontal ? { x: mid(sg.a.x, sg.b.x), y: sg.a.y } : sg.a;
          return { at, vertical };
        };
        const mine = segs.filter((s) => s.net === ni);
        // Where EDIF shows the name: on the wire nearest it
        for (const d of shownAt) {
          if (!d.at || !mine.length) continue;
          const q = P(d.at);
          let best = mine[0]!, bd = Infinity, bq = best.a;
          for (const s of mine) { const n = nearest(q, s.a, s.b); const dd = Math.hypot(n.x - q.x, n.y - q.y); if (dd < bd) { bd = dd; best = s; bq = n; } }
          label({ x: Math.round(bq.x), y: Math.round(bq.y) }, best.a.x === best.b.x, d);
        }
        // A net on other pages of its cell too: joined by name — a label (an off-sheet connector under blocks, where labels stay on their sheet)
        // (Power symbols name it themselves, joined everywhere)
        if (net.instances.length || symbolNets.has(ni)) { /* named */ }
        else if (mine.length && (spans.get(lc(net.name.text)) ?? 0) > 1) {
          if (hierarchical) topRec({ RECORD: SR.POWER_PORT, ISCROSSSHEETCONNECTOR: true, ORIENTATION: 0, TEXT: name, SHOWNETNAME: true, COLOR: COL.power, FONTID: fonts.id(1.27), UNIQUEID: uniqueId() }, { LOCATION: mine[0]!.a });
          else if (!shownAt.length) label(mine[0]!.a, mine[0]!.a.x === mine[0]!.b.x);
        } else if (mine.length && !shownAt.length && !generated(name)) { const m = middle(mine); label(m.at, m.vertical); } // a name of its own, kept
        // A net drawn in pieces: every piece carries the name (a label on one that has neither a label nor a power symbol), so
        // that the pieces are one net as EDIF has them
        const pieces = piecesOf(mine);
        if (pieces.length > 1) for (const piece of pieces) {
          const named = [...labelled].some((l) => l.startsWith(`${ni}|`) && piece.some((sg) => onSeg(pointOf(l), sg.a, sg.b))) || powerAt.some((q) => q.net === ni && piece.some((sg) => onSeg(q.at, sg.a, sg.b)));
          if (!named) { const m = middle(piece); label(m.at, m.vertical); }
        }
        // Each pin it joins: on its wire, else a label on the pin
        const pins = new Set<string>();
        for (const j of net.joined) {
          if (!j.inst) {
            // The cell's own port: a port where the page draws it
            const pimpl = page.ports.find((p) => lc(p.name) === j.port);
            if (pimpl) {
              const drawn = pimpl.figures.flatMap((f) => f.shapes).flatMap(ptsOf).map(P);
              const q = pimpl.connect ? P(pimpl.connect) : drawn[0] ?? P({ x: 0, y: 0 });
              // The port over what EDIF draws for it, from its far end to where it connects (AD's port joins at either end)
              const far = drawn.reduce((a, b) => (Math.hypot(b.x - q.x, b.y - q.y) > Math.hypot(a.x - q.x, a.y - q.y) ? b : a), q);
              const vertical = Math.abs(far.y - q.y) > Math.abs(far.x - q.x);
              const len = Math.max(20, Math.round(vertical ? Math.abs(far.y - q.y) : Math.abs(far.x - q.x)));
              const loc = vertical ? { x: q.x, y: far.y < q.y ? q.y - len : q.y } : { x: far.x < q.x ? q.x - len : q.x, y: q.y };
              const io = portDir.get(j.port) === 'INPUT' ? 2 : portDir.get(j.port) === 'OUTPUT' ? 1 : 3;
              topRec({ RECORD: SR.PORT, NAME: busName(view.ports.find((p) => lc(p.name.id) === j.port)?.name.text ?? pimpl.text ?? j.port), STYLE: vertical ? 7 : 3, IOTYPE: io, WIDTH: len, HEIGHT: 10, ALIGNMENT: 0,
                COLOR: COL.port, AREACOLOR: COL.portFill, TEXTCOLOR: COL.port, FONTID: fonts.id(1.27), UNIQUEID: uniqueId() }, { LOCATION: loc });
              if (!onNet(q, ni) && (mine.length || net.joined.length > 1 || net.instances.length)) { label(q, false); added++; }
            }
            continue;
          }
          const at = pinAt.get(`${j.inst}|${j.port}`);
          const des = instDesignator.get(j.inst);
          if (des) pins.add(`${des}-${numberOf(j.inst, j.port)}`);
          if (!at || netlistOnly) continue;
          if (!onNet(at, ni) && !labelled.has(`${ni}|${key(at)}`)) {
            label(at, false); added++;
            // The net's drawn part carries the name too, so the label joins it
            if (mine.length && ![...labelled].some((l) => l.startsWith(`${ni}|`) && mine.some((s) => onSeg(pointOf(l), s.a, s.b)))) label(mine[0]!.a, mine[0]!.a.x === mine[0]!.b.x);
          }
        }
        if (expected && view === topView) {
          const set = expected.get(name) ?? new Set<string>();
          for (const p of pins) set.add(p);
          if (set.size) expected.set(name, set);
        }
      });
      if (added && !netlistOnly) warnOnce('Pins EDIF joins to a net that no wire drawn reaches: a net label of the net at each');
      function numberOf(inst: string, port: string): string {
        const i = page.instances.find((x) => lc(x.name.id) === inst);
        const comp = i ? libFor(i) : null;
        return comp?.numbers.get(port) ?? port;
      }

      /* comment graphics and texts */
      drawFigures(r, page.comments.figures, pagePl, { OWNERPARTID: -1 }, COL.graphic);
      for (const t of page.comments.texts) {
        const shown = t.display.find((d) => d.visible !== false), tp = textProps(shown, pagePl);
        // (its lines one under the other, as far apart as its height asks)
        const step = shown?.height ? Math.max(10, Math.round((shown.height * 1.2) / 0.254)) : 10;
        if (tp.at) for (const [li, line] of t.text.split(/\r?\n/).entries()) topRec({ RECORD: SR.LABEL, TEXT: line, COLOR: COL.text, ...tp.props }, { LOCATION: { x: tp.at.x, y: tp.at.y - li * step } });
      }

      const W = Math.max(300, Math.ceil(((x1 - x0) * k + 2 * M) / 10) * 10), H = Math.max(200, Math.ceil(((y1 - y0) * k + 2 * M) / 10) * 10);
      r.bags[sheetIndex] = PropertyBag.from({ RECORD: SR.SHEET, ...fonts.keys(), USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true, CUSTOMX: W, CUSTOMY: H, CUSTOMXZONES: 4, CUSTOMYZONES: 4, CUSTOMMARGINWIDTH: 20,
        BORDERON: true, TITLEBLOCKON: !page.size, AREACOLOR: toBgr(0xffffff), SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 4, SYSTEMFONT: 1 } as Record<string, string | number | boolean>);
      r.bags[0]!.setRaw('WEIGHT', String(r.bags.length - 1));
      sheets.push({ name: files[pi]!, bytes: sheetBytes(r) });
    });
  };

  /** Netlist-only parts: in rows on the page, a short wire from every pin with its net's label. */
  function layoutNetlist(r: Records, page: EPage, pinAt: Map<string, Pt>, des: Map<string, string>) {
    void r; void des;
    // Their pins were drawn where the part was placed; a stub out of each, the label at its end
    const netOf = new Map<string, ENet>();
    for (const n of page.nets) for (const j of n.joined) if (j.inst) netOf.set(`${j.inst}|${j.port}`, n);
    for (const [k, at] of [...pinAt]) {
      const n = netOf.get(k);
      if (!n) continue;
      // The stub runs on, away from the body (pins point left or right)
      const left = (pinSide.get(k) ?? 0) < 0;
      const end = { x: at.x + (left ? -10 : 10), y: at.y };
      r.points({ RECORD: SR.WIRE, OWNERPARTID: -1, COLOR: COL.wire, LINEWIDTH: 1, UNIQUEID: uniqueId() }, [at, end]);
      r.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: busName(n.name.text), FONTID: fonts.id(1.27), COLOR: COL.wire, ...(left ? { JUSTIFICATION: 2 } : {}), UNIQUEID: uniqueId() }, { LOCATION: end });
      pinAt.set(k, end);
    }
  }
  const pinSide = new Map<string, number>();

  // Netlist-only: give the instances places (rows) before drawing them
  if (netlistOnly) {
    for (const page of topView.pages) {
      let x = 0, y = 0, rowH = 0;
      const perRow = Math.max(4, Math.ceil(Math.sqrt(page.instances.length)));
      page.instances.forEach((inst, n) => {
        const comp = libFor(inst);
        const sym = comp?.sym;
        const bb = sym?.box ?? { a: { x: 0, y: 0 }, b: { x: 60, y: -40 } };
        const w = Math.abs(bb.b.x - bb.a.x), h = Math.abs(bb.b.y - bb.a.y);
        if (n && n % perRow === 0) { x = 0; y -= rowH + 60; rowH = 0; }
        inst.at = { x: x + 40, y: y - 30 };
        inst.orient = 'R0';
        x += w + 120;
        rowH = Math.max(rowH, h);
        for (const [k, impl] of sym?.pins ?? []) pinSide.set(`${lc(inst.name.id)}|${k}`, (impl.connect?.x ?? 0) <= 0 ? -1 : 1);
      });
      page.size = undefined;
    }
    warnOnce('A netlist with no drawings: its parts drawn as boxes in rows, each pin\'s net named at it');
  }

  convertCell(top, topView);
  for (const c of blockCells) convertCell(c, pagesView(c)!);
  // Blocks under a top of several pages: a top sheet with one symbol listing them (AD's hierarchy needs one root)
  if (hierarchical && topView.pages.length > 1) {
    const r = new Records();
    r.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
    r.bags.push(PropertyBag.from({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Times New Roman', USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true, CUSTOMX: 1100, CUSTOMY: 850,
      CUSTOMXZONES: 4, CUSTOMYZONES: 4, CUSTOMMARGINWIDTH: 20, BORDERON: true, TITLEBLOCKON: true, AREACOLOR: toBgr(0xffffff), SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, SYSTEMFONT: 1 } as Record<string, string | number | boolean>));
    const si = r.add({ RECORD: SR.SHEET_SYMBOL, OWNERPARTID: -1, XSIZE: 200, YSIZE: 100, LINEWIDTH: 1, COLOR: COL.sheet, AREACOLOR: COL.sheetFill, ISSOLID: true, UNIQUEID: uniqueIdFor(`edif:root:${stem}`) }, { LOCATION: { x: 200, y: 600 } });
    r.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: si - 1, OWNERPARTID: -1, TEXT: top.name.text, FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 200, y: 602 } });
    r.add({ RECORD: SR.FILE_NAME, OWNERINDEX: si - 1, OWNERPARTID: -1, TEXT: filesOf(top).join(';'), FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 200, y: 492 } });
    r.bags[0]!.setRaw('WEIGHT', String(r.bags.length - 1));
    sheets.unshift({ name: fileFor(`${stem} Top`), bytes: sheetBytes(r) });
  }

  /* ── the library ── */
  const symbols: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[] = [];
  for (const c of libs.values()) {
    const r = new Records();
    r.add({ RECORD: SR.COMPONENT, LIBREFERENCE: c.libRef, COMPONENTDESCRIPTION: c.description || undefined, PARTCOUNT: 2, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1,
      LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*', AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: c.libRef, UNIQUEID: uniqueId() });
    const k = unitOf(c.cell);
    const pl: Placer = { m: [1, 0, 0, 1], pt: (q) => ({ x: q.x * k, y: q.y * k }) };
    if (c.sym) {
      drawFigures(r, c.sym.figures, pl, { OWNERPARTID: 1 });
      for (const t of c.sym.texts) { const tp = textProps(t.display.find((d) => d.visible !== false), pl); if (tp.at) r.add({ RECORD: SR.LABEL, OWNERPARTID: 1, TEXT: t.text, COLOR: COL.body, ...tp.props }, { LOCATION: tp.at }); }
      drawPins(r, c, pl, { OWNERPARTID: 1 });
    }
    r.add({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, NAME: 'Designator', TEXT: `${c.prefix}?`, FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 0, y: 10 } });
    r.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: 'Comment', TEXT: '*', FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 0, y: -10 } });
    symbols.push({ libRef: c.libRef, description: c.description, parts: 1, bags: r.bags });
  }
  if (!sheets.length) warnings.push('No pages in it');
  return { sheets, library: writeSchLib(symbols), symbols: symbols.length, warnings, scope, footprints, expected, stats: { sheets: sheets.length, parts: nParts, nets: netNames.size, symbols: symbols.length } };
}

function ptsOf(s: EFigure['shapes'][number]): Pt[] {
  switch (s.kind) {
    case 'path': case 'polygon': return s.pts;
    case 'rect': case 'circle': return [s.a, s.b];
    case 'arc': return [s.a, s.m, s.b];
    case 'dot': return [s.at];
  }
}
function boxOfFigures(figs: EFigure[]): { a: Pt; b: Pt } | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of figs) for (const s of f.shapes) for (const q of ptsOf(s)) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  return Number.isFinite(x0) ? { a: { x: x0, y: y1 }, b: { x: x1, y: y0 } } : undefined;
}
function onSeg(q: Pt, a: Pt, b: Pt): boolean {
  const e = 0.05;
  if (q.x < Math.min(a.x, b.x) - e || q.x > Math.max(a.x, b.x) + e || q.y < Math.min(a.y, b.y) - e || q.y > Math.max(a.y, b.y) + e) return false;
  const cross = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
  return Math.abs(cross) <= e * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
}
/** A point back from its key ("net|x,y" in hundredths). */
function pointOf(l: string): Pt { const [x, y] = l.split('|')[1]!.split(',').map((v) => Number(v) / 100); return { x: x!, y: y! }; }
function nearest(q: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}
