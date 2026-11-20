/**
 * OrCAD Capture designs as AD's: a SchDoc per page, a SchLib of the parts (a package's units its
 * parts, the pin numbers its devices give), parts placed as Capture turns and mirrors them (Capture
 * keeps the turned symbol's box where the unturned one was), the reference, value and other shown
 * properties where Capture shows them, the other properties as parameters, the PCB Footprint as the
 * footprint model; wires and buses with their net aliases as net labels, bus entries, junctions
 * where wires meet, power and ground symbols as power ports in their style, off-page connectors as
 * off-sheet connectors, hierarchical ports as ports, hierarchical blocks as sheet symbols with their
 * entries (a block's schematic folder of several pages one symbol listing them all, as AD allows),
 * no-connects as No ERC marks, the page's text and drawings, its title block as drawn.
 *
 * Capture names nets folder-wide (an alias on one page joins the same alias on the folder's other
 * pages) and its power symbols design-wide. A flat design keeps AD's Global scope (labels join
 * across the pages); a hierarchical one AD's Hierarchical, a name shared by a folder's pages then
 * joined by off-sheet connectors. Where Capture joins a name across kinds (an alias on one page, an
 * off-page connector on another), the pages get what AD needs to join them (it joins kind to kind).
 * Wires of different nets that only touch (an end on another's middle, which AD would join) are
 * cut there, the gap drawn as a line. Capture's unit (0.01 inch) is AD's; Y turned up.
 */
import { PropertyBag } from '../altium/props';
import { cfbPut, newEntry, writeCfb } from '../cfb/cfb';
import { joinSchRecords } from '../altium/framing';
import { binToBytes } from '../text';
import { writeSchLib } from '../altium/schlib';
import { SR } from '../../model/sch';
import { toBgr } from '../../model/common';
import { uniqueId } from '../../model/schEdit';
import { COL, Records, justification, lengthKeys, orientOf, radius, type Props } from '../kicad/schematic';
import { uniqueIdFor } from '../kicad/board';
import { orientPoint, ORIENT, type OrBlock, type OrDesign, type OrDisplayProp, type OrFont, type OrGraphic, type OrPackage, type OrPage, type OrPlaced, type OrPrim, type OrScope, type OrSymbol, type OrSymbolPin, type OrWire } from './dsnRead';

type Pt = { x: number; y: number };
export interface OrSchResult {
  sheets: { name: string; bytes: Uint8Array }[];
  library: Uint8Array;
  symbols: number;
  warnings: string[];
  /** AD's Net Identifier Scope for the project: 3 Global (flat designs), 2 Hierarchical. */
  scope: number;
  /** Designator → the PCB Footprint the part names. */
  footprints: Map<string, string>;
  stats: { sheets: number; parts: number; nets: number; symbols: number };
}

/* ── Capture's look ── */

const PALETTE = [[0, 0, 0], [255, 255, 128], [128, 255, 128], [0, 255, 128], [128, 255, 255], [0, 128, 255], [255, 128, 192], [255, 128, 255], [255, 0, 0], [255, 255, 0], [128, 255, 0], [0, 255, 64],
  [0, 255, 255], [0, 128, 192], [128, 128, 192], [255, 0, 255], [128, 64, 64], [255, 128, 64], [0, 255, 0], [0, 128, 128], [0, 64, 128], [128, 128, 255], [128, 0, 64], [255, 0, 128],
  [128, 0, 0], [255, 128, 0], [0, 128, 0], [0, 128, 64], [0, 0, 255], [0, 0, 160], [128, 0, 128], [128, 0, 255], [64, 0, 0], [128, 64, 0], [0, 64, 0], [0, 64, 64],
  [0, 0, 128], [0, 0, 64], [64, 0, 64], [64, 0, 128], [0, 0, 0], [128, 128, 0], [128, 128, 64], [128, 128, 128], [64, 128, 128], [192, 192, 192], [64, 0, 64], [255, 255, 255]];
const colour = (i: number, def: number): number => { const c = PALETTE[i]; return i >= 1 && c ? toBgr((c[0]! << 16) | (c[1]! << 8) | c[2]!) : def; };
/** Capture's widths (thin, medium, wide, default) as AD's. */
const width = (w: number) => (w === 0 ? 0 : w === 1 ? 2 : w === 2 ? 3 : 1);
/** Capture's line styles (solid, dash, dot, dash-dot, dash-dot-dot, default) as AD's. */
const lineStyle = (st: number): Props => { const v = st === 1 ? 1 : st === 2 ? 2 : st === 3 || st === 4 ? 3 : 0; return v ? { LINESTYLE: v, LINESTYLEEXT: v } : {}; };
/** A generated net name (N12345): no label for it. */
const generated = (n: string) => !n || /^N\d+$/i.test(n);
/** Capture's bus ranges (A[0:7], A[0-7]) as AD's (A[0..7]). */
const busName = (n: string) => n.replace(/\[(\d+)\s*(?::|-|\.\.)\s*(\d+)\]/g, '[$1..$2]');
const plain = (t: string) => t.replace(/\r\n?/g, '\n');

/** AD fonts by face, size, weight and slant. Font 1 is the system font (pins, power ports). */
class Fonts {
  list: { face: string; size: number; bold: boolean; italic: boolean }[] = [];
  id(face: string, size: number, bold = false, italic = false): number {
    let i = this.list.findIndex((f) => f.face === face && f.size === size && f.bold === bold && f.italic === italic);
    if (i < 0) { this.list.push({ face, size, bold, italic }); i = this.list.length - 1; }
    return i + 1;
  }
  keys(): Record<string, string | number | boolean> {
    const o: Record<string, string | number | boolean> = { FONTIDCOUNT: Math.max(1, this.list.length) };
    if (!this.list.length) { o.SIZE1 = 10; o.FONTNAME1 = 'Times New Roman'; }
    this.list.forEach((f, i) => { o[`SIZE${i + 1}`] = f.size; o[`FONTNAME${i + 1}`] = f.face; if (f.bold) o[`BOLD${i + 1}`] = true; if (f.italic) o[`ITALIC${i + 1}`] = true; });
    return o;
  }
}
/** A Capture font (its height in 0.01 inch, the character's em) as AD's points [est: AD draws a point as 5 mil of capital height]. */
function points(f: OrFont | undefined): number {
  if (!f) return 10;
  const face = f.face.toLowerCase();
  const comp = face === 'arial narrow' ? (f.bold ? 1.6 : 1.46) : face === 'verdana' ? 1.46 : 1.4;
  return Math.max(4, Math.round((Math.abs(f.height) * 25.4) / (96 * comp) / 0.127));
}

/* ── placing ── */

/** AD's ORIENTATION and ISMIRRORED for an AD-frame linear map m (AD turns after mirroring left to right). */
function adOrient(m: number[]): { orient: number; mirrored: boolean } {
  for (const mirrored of [false, true]) for (let k = 0; k < 4; k++) {
    const c = [1, 0, -1, 0][k]!, s = [0, 1, 0, -1][k]!, f = mirrored ? -1 : 1;
    const r = [c * f, -s, s * f, c];
    if (r.every((v, i) => v === m[i])) return { orient: k, mirrored };
  }
  return { orient: 0, mirrored: false };
}
interface Placement {
  /** Symbol point (Capture's, Y down) → AD sheet. */
  place: (p: Pt) => Pt;
  /** The AD component's origin, orientation, mirror. */
  at: Pt; orient: number; mirrored: boolean;
  /** A direction in the symbol (degrees, AD's sense) → AD's. */
  dir: (deg: number) => number;
}
function placement(o: number, w: number, h: number, bx: number, by: number, P: (p: Pt) => Pt): Placement {
  const e = ORIENT[o & 7]!;
  const m = [e.a, -e.b, -e.c, e.d];   // in AD's frame (both Y up)
  const ad = adOrient(m);
  return {
    place: (p) => P(orientPoint(o, w, h, bx, by, p.x, p.y)),
    at: P(orientPoint(o, w, h, bx, by, 0, 0)), orient: ad.orient, mirrored: ad.mirrored,
    dir: (deg) => (ad.mirrored ? 180 - deg : deg) + ad.orient * 90,
  };
}
const quarter = (a: number) => ((Math.round((((a % 360) + 360) % 360) / 90) % 4) + 4) % 4;
/**
 * Text whose box hangs from its anchor as AD's, kept readable: Capture turns a property's text
 * clockwise in quarter turns about its box's top left (a quarter turn reads downwards).
 */
function textAt(rot: number): { ORIENTATION: number; JUSTIFICATION: number } {
  switch (rot & 3) {
    case 1: return { ORIENTATION: 1, JUSTIFICATION: justification(2, 0) };
    case 2: return { ORIENTATION: 0, JUSTIFICATION: justification(2, 0) };
    case 3: return { ORIENTATION: 1, JUSTIFICATION: justification(0, 2) };
    default: return { ORIENTATION: 0, JUSTIFICATION: justification(0, 2) };
  }
}
/** Display mode: 1 value, 2 name and value, 3 name, 4 both if the value is there; else hidden. */
const shown = (dp: OrDisplayProp) => { const t = (dp.dispMode >> 8) & 0xff; return t >= 1 && t <= 4; };
const showsName = (dp: OrDisplayProp) => { const t = (dp.dispMode >> 8) & 0xff; return t === 2 || t === 3; };

/* ── the design ── */

export function convertOrcadSch(d: OrDesign, stem: string, footprintLib = '', footprintField = ''): OrSchResult {
  const warnings: string[] = [...d.warnings];
  const warnOnce = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  const lib = d.library;
  const fontAt = (i: number): OrFont | undefined => (i > 0 && i <= lib.fonts.length ? lib.fonts[i - 1] : undefined);
  const template = (slot: number): OrFont | undefined => { const t = lib.templateFonts; const m = t[slot] ?? 0; return fontAt(m > 0 ? m : (t[0] ?? 0) > 0 ? t[0]! : 1); };
  /** A display property's font: its own, else the Design Template's (reference, value, other). */
  const dispFont = (dp: OrDisplayProp) => (dp.fontIdx > 0 ? fontAt(dp.fontIdx) : lib.templateFonts.length ? template(dp.name === 'Part Reference' || dp.name === 'Reference' ? 2 : dp.name === 'Value' ? 9 : 10) : fontAt(1));
  const aliasFont = (i: number) => (lib.templateFonts.length ? template(i > 0 && i < lib.templateFonts.length ? i : 5) : fontAt(i));
  const pinFont = template(10) ?? fontAt(1);

  /* The folders the design uses: the root and those its blocks reach */
  const folderOf = new Map(d.folders.map((f) => [f.name.toLowerCase(), f]));
  const links = new Map<number, string>();
  const walk = (s: OrScope | undefined) => { for (const b of s?.blocks ?? []) { links.set(b.targetDbId, b.childFolder); walk(b.scope); } };
  walk(d.occurrences);
  const childOf = (b: OrBlock) => b.childName || links.get(b.dbId) || b.props['Implementation'] || b.props['Implementation Name'] || '';
  const used: string[] = [];
  const reach = (name: string) => {
    const f = folderOf.get(name.toLowerCase());
    if (!f || used.includes(f.name)) return;
    used.push(f.name);
    for (const p of f.pages) for (const b of p.blocks) { const c = childOf(b); if (c) reach(c); }
  };
  reach(d.root);
  for (const f of d.folders) if (!used.includes(f.name) && f.pages.length) warnOnce(`Schematic folder ${f.name} isn't part of the design (no block places it): left out`);
  const hierarchical = used.some((n) => folderOf.get(n.toLowerCase())!.pages.some((p) => p.blocks.length));
  for (const n of used) for (const p of folderOf.get(n.toLowerCase())!.pages) for (const b of p.blocks) if (!childOf(b)) warnOnce('Blocks whose schematic is missing drawn without their sheets');

  /*
   * The sheets: each page once per occurrence of its folder (a folder that several blocks place
   * gets a copy of its pages per block, with that occurrence's designators, as Capture annotates it).
   */
  interface SheetOcc { folder: string; page: OrPage; pageIdx: number; scope?: OrScope; tag: string; file: string; path: string; blockFiles: Map<number, string[]> }
  const sheetsOcc: SheetOcc[] = [];
  const taken = new Set<string>();
  const fileFor = (base: string) => {
    const b = base.replace(/[\\/:*?"<>|;]/g, '_').replace(/\s+/g, ' ').trim() || 'Sheet';
    let name = `${b}.SchDoc`;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${b}_${k}.SchDoc`;
    taken.add(name.toLowerCase());
    return name;
  };
  const uses = new Map<string, number>();
  const count = (name: string, seen: string[]) => {
    const f = folderOf.get(name.toLowerCase());
    if (!f || seen.includes(f.name)) return;
    uses.set(f.name, (uses.get(f.name) ?? 0) + 1);
    for (const p of f.pages) for (const b of p.blocks) { const c = childOf(b); if (c) count(c, [...seen, f.name]); }
  };
  count(d.root, []);
  const rootPages = folderOf.get(d.root.toLowerCase())?.pages ?? [];
  const wrapper = hierarchical && rootPages.length > 1 ? fileFor(stem) : '';
  const instantiate = (name: string, scope: OrScope | undefined, tag: string, path: string, seen: string[]): string[] => {
    const f = folderOf.get(name.toLowerCase());
    if (!f || seen.includes(f.name)) return [];
    const mine = f.pages.map((page, pageIdx) => {
      const single = f.pages.length === 1 && f.name === d.root && !hierarchical;
      const so: SheetOcc = { folder: f.name, page, pageIdx, scope, tag, path, file: fileFor(single ? stem : tag ? `${page.name} - ${tag}` : page.name), blockFiles: new Map() };
      sheetsOcc.push(so);
      return so;
    });
    for (const so of mine) for (const b of so.page.blocks) {
      const c = childOf(b);
      if (!c) continue;
      const cs = scope?.blocks.find((x) => x.targetDbId === b.dbId)?.scope;
      const label = (b.reference || b.name || String(b.dbId)).trim();
      const childTag = (uses.get(folderOf.get(c.toLowerCase())?.name ?? '') ?? 0) > 1 ? (tag ? `${tag} ${label}` : label) : '';
      so.blockFiles.set(b.dbId, instantiate(c, cs, childTag, `${path}/${b.dbId}`, [...seen, f.name]));
    }
    return mine.map((x) => x.file);
  };
  instantiate(d.root, d.occurrences, '', '', []);

  /* ── parts: which symbol, which library component ── */

  const normPath = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const symPinFor = (sym: OrSymbol, pinIndex: number, i: number): OrSymbolPin | undefined => {
    const slot = pinIndex ? Math.abs(pinIndex) - 1 : i;
    return sym.pins.find((p) => p.position === slot) ?? sym.pins[i];
  };
  const boxOf = (s: OrSymbol) => s.bbox ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
  const displacement = (sym: OrSymbol, inst: OrPlaced): number => {
    if (inst.pins.length > sym.pins.length) return Infinity;
    const b = boxOf(sym), o = (inst.rotation & 3) | (inst.mirror ? 4 : 0);
    let dsum = 0;
    inst.pins.forEach((pin, i) => {
      const sp = symPinFor(sym, pin.pinIndex, i);
      if (!sp) { dsum += 1e6; return; }
      const q = orientPoint(o, b.x2 - b.x1, b.y2 - b.y1, inst.x, inst.y, sp.hotX, sp.hotY);
      dsum += Math.abs(q.x - pin.x) + Math.abs(q.y - pin.y);
    });
    return dsum;
  };
  /** Fitted copies (pins moved to where the page has them), by placement. */
  const fitted = new Map<string, OrSymbol>();
  const symbolFor = (inst: OrPlaced): OrSymbol | undefined => {
    const base = d.symbols.get(inst.pkgName);
    if (!base) return undefined;
    const all = [base, ...base.variants];
    const exact = all.filter((s) => displacement(s, inst) === 0);
    if (exact.length) return exact.find((s) => normPath(s.sourceLib) === normPath(inst.sourceLibrary)) ?? exact[0];
    // None fits: the nearest, its pins moved to the page's
    const best = all.reduce((a, s) => (displacement(s, inst) < displacement(a, inst) ? s : a), base);
    const b = boxOf(best), o = (inst.rotation & 3) | (inst.mirror ? 4 : 0), e = ORIENT[o]!;
    const w = b.x2 - b.x1, h = b.y2 - b.y1;
    const t = orientPoint(o, w, h, 0, 0, 0, 0);
    const copy: OrSymbol = { ...best, variants: [], pins: best.pins.map((p) => ({ ...p })) };
    inst.pins.forEach((pin, i) => {
      const sp = symPinFor(copy, pin.pinIndex, i);
      if (!sp) return;
      // Inverse of the (orthonormal) turn: its transpose
      const dx = pin.x - inst.x - t.x, dy = pin.y - inst.y - t.y;
      const lx = e.a * dx + e.c * dy, ly = e.b * dx + e.d * dy;
      const sx = lx - sp.hotX, sy = ly - sp.hotY;
      sp.hotX += sx; sp.hotY += sy; sp.startX += sx; sp.startY += sy;
    });
    // One copy for every placement that needs the same pins
    const sig = `${best.name}|${copy.pins.map((p) => `${p.hotX},${p.hotY},${p.startX},${p.startY}`).join(';')}`;
    const seen = fitted.get(sig);
    if (seen) return seen;
    fitted.set(sig, copy);
    warnOnce('Parts whose pins sit apart from their cached symbol: their pins moved to where the page has them (a library part of their own)');
    return copy;
  };

  /** The package (of its stored versions) that goes with the symbol placed: from its library, else one with pins enough. */
  const pkgKeys = new Map<OrPackage, string>();
  const pkgKey = (p: OrPackage) => { let k = pkgKeys.get(p); if (!k) { k = `p${pkgKeys.size}`; pkgKeys.set(p, k); } return k; };
  const packageFor = (inst: OrPlaced, sym: OrSymbol): OrPackage | undefined => {
    const base = d.packages.get(inst.sourcePackage) ?? d.packages.get(inst.pkgName.replace(/\.(Normal|Convert)$/i, ''));
    if (!base || !base.variants.length) return base;
    const all = [base, ...base.variants];
    const slots = Math.max(0, ...sym.pins.map((p) => p.position + 1));
    const enough = (p: OrPackage) => (p.devices[inst.unitIndex]?.pinNumbers.length ?? 0) >= slots;
    return all.find((p) => enough(p) && normPath(p.sourceLib) === normPath(sym.sourceLib)) ?? all.find((p) => enough(p) && normPath(p.sourceLib) === normPath(inst.sourceLibrary)) ?? all.find(enough) ?? base;
  };
  interface LibComp { libRef: string; pkg?: OrPackage; units: (OrSymbol | undefined)[]; description: string; footprints: Set<string>; prefix: string }
  const libs = new Map<string, LibComp>();
  const libRefs = new Set<string>();
  const symKey = new Map<OrSymbol, string>();
  let symN = 0;
  const keyOfSym = (s: OrSymbol) => { let k = symKey.get(s); if (!k) { k = `s${symN++}`; symKey.set(s, k); } return k; };
  const libFor = (inst: OrPlaced, sym: OrSymbol): { comp: LibComp; unit: number } => {
    const pkg = packageFor(inst, sym);
    const view = /\.Convert$/i.test(inst.pkgName) ? ' (Convert)' : '';
    const pkgName = (pkg?.name || inst.sourcePackage || inst.pkgName.replace(/\.(Normal|Convert)$/i, '')).trim();
    const base0 = d.symbols.get(inst.pkgName);
    const isDefault = sym === base0;
    const key = `${pkgName}${view}|${isDefault ? '' : keyOfSym(sym)}|${pkg ? pkgKey(pkg) : ''}`;
    let comp = libs.get(key);
    const unit = Math.max(0, Math.min(inst.unitIndex, Math.max(0, (pkg?.devices.length ?? 1) - 1)));
    if (!comp) {
      const want = `${pkgName}${view}`.replace(/[\r\n]/g, ' ') || 'Part';
      let libRef = want;
      for (let k = 2; libRefs.has(libRef.toLowerCase()); k++) libRef = `${want}_${k}`;
      libRefs.add(libRef.toLowerCase());
      comp = { libRef, pkg, units: [], description: pkg?.props.Description || sym.props.Description || '', footprints: new Set(), prefix: pkg?.refDes || '' };
      libs.set(key, comp);
    }
    if (!comp.units[unit]) comp.units[unit] = sym;
    return { comp, unit };
  };

  /* Drawing a symbol's primitives and pins */
  const drawPrims = (r: Records, prims: OrPrim[], place: (p: Pt) => Pt, dir: (deg: number) => number, mirrored: boolean, own: Props, color: number, fonts: Fonts | null, off: Pt = { x: 0, y: 0 }) => {
    const fid = (f: OrFont | undefined) => (fonts ? fonts.id(f?.face || 'Arial', points(f), f?.bold, f?.italic) : 1);
    for (const pr of prims) {
      const p = (x: number, y: number) => place({ x: x + off.x, y: y + off.y });
      const col = colour(color, COL.body);
      const look: Props = { COLOR: col, LINEWIDTH: width(pr.lineWidth), ...lineStyle(pr.lineStyle) };
      const fill: Props = pr.fillStyle === 0 || pr.fillStyle === 2 ? { AREACOLOR: col, ISSOLID: true } : { AREACOLOR: COL.fill, ISSOLID: false, TRANSPARENT: true };
      switch (pr.kind) {
        case 'group': drawPrims(r, pr.children, place, dir, mirrored, own, color, fonts, { x: off.x + pr.x1, y: off.y + pr.y1 }); break;
        case 'rect': {
          const a = p(pr.x1, pr.y1), b = p(pr.x2, pr.y2);
          r.add({ RECORD: SR.RECTANGLE, ...own, ...look, ...fill }, { LOCATION: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, CORNER: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } });
          break;
        }
        case 'line': r.add({ RECORD: SR.LINE, ...own, ...look }, { LOCATION: p(pr.x1, pr.y1), CORNER: p(pr.x2, pr.y2) }); break;
        case 'ellipse': {
          const c = p((pr.x1 + pr.x2) / 2, (pr.y1 + pr.y2) / 2);
          let rx = Math.abs(pr.x2 - pr.x1) / 2, ry = Math.abs(pr.y2 - pr.y1) / 2;
          if (quarter(dir(0)) % 2 === 1) [rx, ry] = [ry, rx];
          r.add({ RECORD: SR.ELLIPSE, ...own, ...look, ...fill, ...radius('RADIUS', rx), ...radius('SECONDARYRADIUS', ry) }, { LOCATION: c });
          break;
        }
        case 'arc': {
          if (!pr.start || !pr.end || (pr.start.x === pr.end.x && pr.start.y === pr.end.y)) break;
          const cx = (pr.x1 + pr.x2) / 2, cy = (pr.y1 + pr.y2) / 2;
          let rx = Math.abs(pr.x2 - pr.x1) / 2 || 0.01, ry = Math.abs(pr.y2 - pr.y1) / 2 || 0.01;
          const c = p(cx, cy);
          // Capture's arcs run anticlockwise as seen; mirrored, the other way
          let s = p(pr.start.x, pr.start.y), e = p(pr.end.x, pr.end.y);
          if (mirrored) [s, e] = [e, s];
          if (quarter(dir(0)) % 2 === 1) [rx, ry] = [ry, rx];
          const ang = (q: Pt) => ((Math.atan2((q.y - c.y) / ry, (q.x - c.x) / rx) * 180) / Math.PI + 360) % 360;
          const a0 = ang(s), a1 = ang(e);
          if (Math.abs(rx - ry) < 0.01) r.add({ RECORD: SR.ARC, ...own, ...look, ...radius('RADIUS', rx), STARTANGLE: a0.toFixed(3), ENDANGLE: a1.toFixed(3) }, { LOCATION: c });
          else r.add({ RECORD: SR.ELLIPTICAL_ARC, ...own, ...look, ...radius('RADIUS', rx), ...radius('SECONDARYRADIUS', ry), STARTANGLE: a0.toFixed(3), ENDANGLE: a1.toFixed(3) }, { LOCATION: c });
          break;
        }
        case 'polygon': case 'polyline': {
          const pts = pr.points.map((q) => p(q.x, q.y));
          if (pts.length < 2) break;
          if (pr.kind === 'polygon' && pts.length >= 3) r.points({ RECORD: SR.POLYGON, ...own, ...look, ...fill }, pts);
          else if (pts.length === 2) r.add({ RECORD: SR.LINE, ...own, ...look }, { LOCATION: pts[0]!, CORNER: pts[1]! });
          else r.points({ RECORD: SR.POLYLINE, ...own, ...look }, pts);
          break;
        }
        case 'bezier': {
          const pts = pr.points.map((q) => p(q.x, q.y));
          if (pts.length >= 4) r.points({ RECORD: SR.BEZIER, ...own, ...look }, pts.slice(0, 1 + Math.floor((pts.length - 1) / 3) * 3));
          break;
        }
        case 'text': {
          const text = plain(pr.text ?? '');
          if (!text.trim()) break;
          const f = fontAt(pr.fontIdx);
          const turns = f ? Math.round(f.escapement / 900) : 0;
          const lines = text.split('\n');
          const boxed = pr.x1 !== pr.x2 || pr.y1 !== pr.y2;
          const em = Math.abs(f?.height ?? 9) * 1.15;
          const deg = dir(turns * 90);
          let o = quarter(deg), hh = boxed && lines.length === 1 ? 1 : 0, vv = boxed && lines.length === 1 ? 1 : 2;
          if (o >= 2) { o -= 2; hh = 2 - hh; vv = 2 - vv; }
          lines.forEach((line, i) => {
            if (!line.trim()) return;
            const at = boxed && lines.length === 1 ? p((pr.x1 + pr.x2) / 2, (pr.y1 + pr.y2) / 2) : turns % 2 ? p(pr.x1 + i * em, pr.y2) : p(pr.x1, pr.y1 + i * em);
            r.add({ RECORD: SR.LABEL, ...own, TEXT: line, FONTID: fid(f), COLOR: colour(color, COL.text), ORIENTATION: o, JUSTIFICATION: justification(hh, vv) }, { LOCATION: at });
          });
          break;
        }
        case 'image': warnOnce('Pictures left out'); break;
        default:
      }
    }
  };
  /** A pin: Capture's free end and connection point; its number from the device. */
  const drawPin = (r: Records, pin: OrSymbolPin, place: (p: Pt) => Pt, own: Props, number: string, sym: OrSymbol, hiddenPower: boolean) => {
    const hot = place({ x: pin.hotX, y: pin.hotY }), start = place({ x: pin.startX, y: pin.startY });
    const len = Math.hypot(pin.startX - pin.hotX, pin.startY - pin.hotY);
    const flags = sym.generalFlags;
    let showName = flags < 0 ? true : (flags & 1) !== 0, showNumber = flags < 0 ? true : (flags & 4) === 0;
    const nd = pin.displayProps.find((p) => /^(pin )?name$/i.test(p.name)), md = pin.displayProps.find((p) => /^(pin )?number$/i.test(p.name));
    if (nd) showName = shown(nd);
    if (md) showNumber = shown(md);
    const name = pin.name.startsWith('$PIN') ? '' : pin.name;
    // Zero length: it points into the symbol's box from where it is
    let o: number;
    if (len > 0) o = orientOf(start, hot);
    else {
      const b = boxOf(sym), c = place({ x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 });
      o = (orientOf(c, hot) + 0) % 4;
    }
    r.add({ RECORD: SR.PIN, ...own, ELECTRICAL: pin.portType,
      PINCONGLOMERATE: o | (hiddenPower ? 0x04 : 0) | (showName && name ? 0x08 : 0) | (showNumber ? 0x10 : 0),
      ...lengthKeys(len), NAME: busName(name), DESIGNATOR: number, COLOR: COL.pin,
      ...(pin.shapeBits & 4 ? { SYMBOL_OUTEREDGE: 1 } : {}), ...(pin.shapeBits & 2 ? { SYMBOL_INNEREDGE: 3 } : {}),
      HIDDENNETNAME: hiddenPower && name ? name : undefined }, { LOCATION: len > 0 ? start : hot });
  };
  const isHiddenPower = (p: OrSymbolPin) => p.portType === 7 && (p.shapeBits & 0x80) !== 0 && p.hotX === p.startX && p.hotY === p.startY && !!p.name && !p.name.startsWith('$PIN');
  const pinNumber = (pkg: OrPackage | undefined, unit: number, pin: OrSymbolPin) => {
    const dev = pkg?.devices[unit];
    const n = dev?.pinNumbers[pin.position];
    return n !== undefined && n !== '' ? n : pkg ? '' : String(pin.position + 1);
  };

  /* ── the pages ── */

  // Each child folder's interface: its blocks' pins by name
  const portTypes = new Map<string, Map<string, number>>();
  for (const n of used) for (const p of folderOf.get(n.toLowerCase())!.pages) for (const b of p.blocks) {
    const c = childOf(b).toLowerCase();
    if (!portTypes.has(c)) portTypes.set(c, new Map());
    for (const q of b.pins) if (!portTypes.get(c)!.has(busName(q.name).toUpperCase())) portTypes.get(c)!.set(busName(q.name).toUpperCase(), q.portType);
  }

  const out: { name: string; bytes: Uint8Array }[] = [];
  const footprints = new Map<string, string>();
  const netNames = new Set<string>();
  let nParts = 0;
  const scope = hierarchical ? 2 : 3;

  /** A page's wires joined where they meet, with every name on them (the net's, its aliases', its connectors') and how each is given. */
  interface Group { page: OrPage; wires: OrWire[]; names: Map<string, { name: string; kinds: Set<string> }>; ends: Pt[] }
  const nameOf = (g: Group, nm: string) => { const k = nm.trim().toUpperCase(); let e = g.names.get(k); if (!e) { e = { name: nm.trim(), kinds: new Set() }; g.names.set(k, e); } return e; };
  /** Per folder: the wire groups of each page, by net name, for joining names across pages. */
  const plans = new Map<OrPage, { label: { name: string; at: Pt; vertical: boolean }[]; offsheet: { name: string; at: Pt; orient: number }[] }>();
  const groupsOf = new Map<OrPage, Group[]>();
  const graphicPin = (g: OrGraphic): Pt | null => {
    const sym = graphicSymbol(g);
    if (!sym) return null;
    const pin = sym.pins[0];
    const b = boxOf(sym), w = b.x2 - b.x1, h = b.y2 - b.y1;
    const base = graphicBase(g);
    if (!pin) return null;
    return orientPoint((g.rotation & 3) | (g.mirror ? 4 : 0), w, h, base.x, base.y, pin.hotX, pin.hotY);
  };
  function graphicSymbol(g: OrGraphic): OrSymbol | undefined {
    const s = d.symbols.get(g.name);
    if (!s) return g.nested;
    const all = [s, ...s.variants];
    const src = g.props['Source Library'];
    return (src && all.find((x) => normPath(x.sourceLib) === normPath(src))) || s;
  }
  function graphicBase(g: OrGraphic): Pt {
    const enc = g.bbox.x2 < g.bbox.x1 || g.bbox.y2 < g.bbox.y1;
    return enc ? { x: g.bbox.x1, y: g.bbox.y1 } : { x: Math.min(g.bbox.x1, g.bbox.x2), y: Math.min(g.bbox.y1, g.bbox.y2) };
  }
  const onSeg = (q: Pt, w: { x1: number; y1: number; x2: number; y2: number }) => {
    if (q.x < Math.min(w.x1, w.x2) || q.x > Math.max(w.x1, w.x2) || q.y < Math.min(w.y1, w.y2) || q.y > Math.max(w.y1, w.y2)) return false;
    return (w.x2 - w.x1) * (q.y - w.y1) - (w.y2 - w.y1) * (q.x - w.x1) === 0;
  };
  const isEnd = (q: Pt, w: OrWire) => (q.x === w.x1 && q.y === w.y1) || (q.x === w.x2 && q.y === w.y2);

  // Groups: a page's wires joined where they meet (and are of one net)
  for (const n of used) for (const page of folderOf.get(n.toLowerCase())!.pages) {
    const ws = page.wires.filter((w) => !w.bus);
    const parent = ws.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
      const a = ws[i]!, b = ws[j]!;
      if (a.netId !== b.netId) continue;
      const ea = [{ x: a.x1, y: a.y1 }, { x: a.x2, y: a.y2 }], eb = [{ x: b.x1, y: b.y1 }, { x: b.x2, y: b.y2 }];
      if (ea.some((q) => onSeg(q, b)) || eb.some((q) => onSeg(q, a))) parent[find(i)] = find(j);
    }
    const by = new Map<number, Group>();
    ws.forEach((w, i) => {
      const k = find(i);
      let g = by.get(k);
      if (!g) { g = { page, wires: [], names: new Map(), ends: [] }; by.set(k, g); const nn = page.nets.get(w.netId) ?? ''; if (nn) nameOf(g, nn); }
      g.wires.push(w);
      for (const a of w.aliases) if (a.name.trim()) nameOf(g, a.name).kinds.add('label');
    });
    const groups = [...by.values()];
    const groupAt = (q: Pt) => groups.find((g) => g.wires.some((w) => onSeg(q, w)));
    // Each group's free ends (where a connector or label may go)
    for (const g of groups) {
      const pts = g.wires.flatMap((w) => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]);
      g.ends = pts.filter((q) => pts.filter((x) => x.x === q.x && x.y === q.y).length === 1 && !page.wires.some((w) => !g.wires.includes(w) && onSeg(q, w)));
      if (!g.ends.length) g.ends = pts.slice(0, 1);
    }
    // Power symbols, off-page connectors and ports on the groups; one on a pin with no wire is a group of its own
    // (Capture joins it by name like any other)
    for (const [list, kind] of [[page.globals, 'power'], [page.offpage, 'offpage'], [page.ports, 'port']] as const) {
      for (const gr of list) {
        const q = graphicPin(gr);
        const nm = (gr.logicalName || gr.props.Name || (kind === 'power' ? gr.name : '')).trim();
        if (!q || !nm) continue;
        let g = groupAt(q) ?? groups.find((x) => !x.wires.length && x.ends[0]!.x === q.x && x.ends[0]!.y === q.y);
        if (!g) { g = { page, wires: [], names: new Map(), ends: [q] }; groups.push(g); }
        nameOf(g, nm).kinds.add(kind);
      }
    }
    groupsOf.set(page, groups);
    plans.set(page, { label: [], offsheet: [] });
  }
  // Names Capture joins across the folder's pages: what AD needs to join them
  for (const n of used) {
    const f = folderOf.get(n.toLowerCase())!;
    const byName = new Map<string, { g: Group; e: { name: string; kinds: Set<string> } }[]>();
    for (const p of f.pages) for (const g of groupsOf.get(p) ?? []) for (const [k, e] of g.names) {
      if (generated(e.name)) continue;
      byName.set(k, [...(byName.get(k) ?? []), { g, e }]);
    }
    for (const es of byName.values()) {
      if (es.length < 2) continue;
      const all = (kind: string) => es.every((x) => x.e.kinds.has(kind));
      if (all('power') || all('offpage') || all('port')) continue;
      const pagesOf = new Set(es.map((x) => x.g.page));
      if (!hierarchical || pagesOf.size === 1) {
        if (all('label')) continue;
        for (const { g, e } of es) if (!e.kinds.has('label')) addLabel(g, e);
        continue;
      }
      // Hierarchical, across pages: off-sheet connectors (the folder's pages are one symbol's sheets)
      for (const { g, e } of es) if (!e.kinds.has('offpage')) {
        const at = g.ends[0]!;
        const w = g.wires.find((x) => isEnd(at, x)) ?? g.wires[0];
        const other = !w ? { x: at.x - 1, y: at.y } : at.x === w.x1 && at.y === w.y1 ? { x: w.x2, y: w.y2 } : { x: w.x1, y: w.y1 };
        // Pointing away from its wire (Capture's Y down; AD's orientation in AD's frame)
        const o = orientOf({ x: other.x, y: -other.y }, { x: at.x, y: -at.y });
        plans.get(g.page)!.offsheet.push({ name: e.name, at, orient: o });
        e.kinds.add('offpage');
      }
    }
  }
  /** A block whose folder is missing or empty: a file name no produced sheet has (AD reports its child sheet missing). */
  function missingFile(child: string): string {
    warnOnce('Hierarchical blocks with no schematic folder in the design: their sheet symbols name a missing sheet');
    return `${(child || 'Block').replace(/[\\/:*?"<>|;]/g, '_')} (missing).SchDoc`;
  }
  function addLabel(g: Group, e: { name: string; kinds: Set<string> }) {
    const at = g.ends[0]!;
    const w = g.wires.find((x) => onSeg(at, x)) ?? g.wires[0];
    // On its wire, or (a group of no wire) on the pin it touches
    plans.get(g.page)!.label.push({ name: e.name, at, vertical: !!w && w.x1 === w.x2 });
    e.kinds.add('label');
  }

  for (const so of sheetsOcc) {
    const folder = folderOf.get(so.folder.toLowerCase())!;
    const occ = so.scope;
    const { page, pageIdx } = so;
    {
      const r = new Records(), fonts = new Fonts();
      fonts.id(pinFont?.face || 'Arial', points(pinFont), pinFont?.bold, pinFont?.italic);
      r.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
      const sheetIndex = r.bags.length;
      r.bags.push(PropertyBag.from({ RECORD: SR.SHEET }));
      const top = (props: Props, coords?: Record<string, Pt>) => r.add({ ...props, OWNERPARTID: -1 }, coords);
      const st = page.settings;
      const unit = (v: number) => (st.isMetric ? v / 254 : v / 10);
      const W = Math.max(100, Math.round(unit(st.width))), H = Math.max(100, Math.round(unit(st.height)));
      const P = (q: Pt): Pt => ({ x: q.x, y: H - q.y });
      const fid = (f: OrFont | undefined) => fonts.id(f?.face || 'Arial', points(f), f?.bold, f?.italic);
      const dispText = (dp: OrDisplayProp, base: Pt, text: string, own: Props) => {
        r.add({ RECORD: SR.LABEL, ...own, TEXT: text, FONTID: fid(dispFont(dp)), COLOR: colour(dp.color, COL.text), ...textAt(dp.rotation) }, { LOCATION: P({ x: base.x + dp.x, y: base.y + dp.y }) });
      };

      /* ── wires: cut where another net only touches them ── */
      const wires = page.wires;
      for (const w of wires) {
        const cuts: Pt[] = [];
        if (!w.bus) for (const o of wires) {
          if (o === w || o.bus || o.netId === w.netId) continue;
          for (const q of [{ x: o.x1, y: o.y1 }, { x: o.x2, y: o.y2 }]) if (onSeg(q, w) && !isEnd(q, w)) cuts.push(q);
        }
        const look: Props = { COLOR: colour(w.color, w.bus ? COL.bus : COL.wire), LINEWIDTH: w.bus ? 2 : 1, UNIQUEID: uniqueId() };
        const a = { x: w.x1, y: w.y1 }, b = { x: w.x2, y: w.y2 };
        if (!cuts.length) { r.points({ RECORD: w.bus ? SR.BUS : SR.WIRE, OWNERPARTID: -1, ...look }, [P(a), P(b)]); continue; }
        const L = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
        const ts = [...new Set(cuts.map((q) => Math.round(((q.x - a.x) * ux + (q.y - a.y) * uy) * 1000) / 1000))].sort((x, y) => x - y);
        let cur = 0;
        const at = (t: number) => ({ x: a.x + ux * t, y: a.y + uy * t });
        for (const t of ts) {
          const t0 = Math.max(cur, t - 0.5), t1 = Math.min(L, t + 0.5);
          if (t0 > cur) r.points({ RECORD: SR.WIRE, OWNERPARTID: -1, ...look, UNIQUEID: uniqueId() }, [P(at(cur)), P(at(t0))]);
          top({ RECORD: SR.LINE, COLOR: look.COLOR, LINEWIDTH: 1 }, { LOCATION: P(at(t0)), CORNER: P(at(t1)) });
          cur = t1;
        }
        if (cur < L) r.points({ RECORD: SR.WIRE, OWNERPARTID: -1, ...look, UNIQUEID: uniqueId() }, [P(at(cur)), P(b)]);
        warnOnce('Wires of other nets that only touched cut apart there (touching would join them), the gap drawn as a line');
      }
      // Aliases as net labels, clear of other nets' wires and pins (AD's label joins whatever it touches; Capture's only its own wire)
      const pinsAt = new Set(page.instances.flatMap((i) => i.pins.map((q) => `${q.x},${q.y}`)));
      const clear = (q: Pt, w: OrWire) => !wires.some((o) => o.netId !== w.netId && onSeg(q, o)) && (!pinsAt.has(`${q.x},${q.y}`) || isEnd(q, w));
      const safe = (q0: Pt, w: OrWire): Pt => {
        // Onto its wire first
        const L = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
        if (!L) return { x: w.x1, y: w.y1 };
        const ux = (w.x2 - w.x1) / L, uy = (w.y2 - w.y1) / L;
        const t0 = Math.max(0, Math.min(L, (q0.x - w.x1) * ux + (q0.y - w.y1) * uy));
        const at = (t: number) => ({ x: Math.round((w.x1 + ux * t) * 1000) / 1000, y: Math.round((w.y1 + uy * t) * 1000) / 1000 });
        if (clear(at(t0), w)) return at(t0);
        for (let k = 1; k <= L; k++) for (const t of [t0 + k, t0 - k]) if (t >= 0 && t <= L && clear(at(t), w)) { warnOnce('Aliases that sat on another net\'s wire (touching would join them) moved along their own'); return at(t); }
        return at(t0);
      };
      for (const w of wires) for (const a of w.aliases) {
        const name = busName(a.name.trim());
        if (!name) continue;
        netNames.add(name);
        const f = aliasFont(a.fontIdx);
        top({ RECORD: SR.NET_LABEL, TEXT: name, FONTID: fid(f), COLOR: colour(a.color, COL.wire), ORIENTATION: a.rotation & 1, UNIQUEID: uniqueId() }, { LOCATION: P(safe({ x: a.x, y: a.y }, w)) });
      }
      for (const l of plans.get(page)?.label ?? []) {
        top({ RECORD: SR.NET_LABEL, TEXT: busName(l.name), FONTID: 1, COLOR: COL.wire, ORIENTATION: l.vertical ? 1 : 0, UNIQUEID: uniqueId() }, { LOCATION: P(l.at) });
        warnOnce('Names Capture joins across pages without a label on each (an alias here, an off-page connector there): labels added where they are needed');
      }
      for (const s of plans.get(page)?.offsheet ?? []) {
        top({ RECORD: SR.POWER_PORT, ISCROSSSHEETCONNECTOR: true, ORIENTATION: s.orient, TEXT: busName(s.name), SHOWNETNAME: true, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: P(s.at) });
        warnOnce('Names a block\'s schematic shares across its pages: off-sheet connectors added where they are needed (net labels join on one sheet only)');
      }
      for (const n of page.nets.values()) if (!generated(n)) netNames.add(n);
      // Junctions: three wire ends at a point, or an end on another wire's middle (of one net)
      const ends = new Map<string, { at: Pt; count: number; net: number }>();
      for (const w of wires) for (const e of [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]) {
        const k = `${e.x},${e.y}`;
        const v = ends.get(k) ?? { at: e, count: 0, net: w.netId };
        v.count++;
        ends.set(k, v);
      }
      for (const { at, count, net } of ends.values()) {
        const through = wires.filter((w) => w.netId === net && onSeg(at, w) && !isEnd(at, w)).length;
        if (count + 2 * through >= 3) top({ RECORD: SR.JUNCTION, COLOR: COL.wire }, { LOCATION: P(at) });
      }
      // Bus entries
      for (const be of page.busEntries) top({ RECORD: SR.BUS_ENTRY, COLOR: colour(be.color, COL.bus), LINEWIDTH: 1 }, { LOCATION: P({ x: be.x1, y: be.y1 }), CORNER: P({ x: be.x2, y: be.y2 }) });

      /* ── parts ── */
      for (const inst of page.instances) {
        const sym = symbolFor(inst);
        if (!sym) { warnOnce('Parts whose symbol is not in the design\'s cache left out'); continue; }
        const { comp, unit } = libFor(inst, sym);
        const pkg = comp.pkg;
        const b = boxOf(sym), o = (inst.rotation & 3) | (inst.mirror ? 4 : 0);
        const pl = placement(o, b.x2 - b.x1, b.y2 - b.y1, inst.x, inst.y, P);
        const ref = occ?.partRefs.get(inst.dbId) || inst.reference || `${comp.prefix || 'U'}?`;
        const unitRef = occ?.partUnitRefs.get(inst.dbId);
        let partIdx = unit;
        if (unitRef && pkg) { const k = pkg.devices.findIndex((dv) => dv.unitRef === unitRef); if (k >= 0) partIdx = k; }
        const props: Record<string, string> = { ...(pkg?.props ?? {}), ...sym.props, ...inst.props, ...(occ?.partProps.get(inst.dbId) ?? {}) };
        const value = props.Value || inst.value || '';
        // The footprint from the part field chosen (Preferences › Schematic › Orcad), else PCB Footprint
        const footprint = ((footprintField && props[footprintField]) || props['PCB Footprint'] || pkg?.pcbFootprint || '').trim();
        if (footprint) { comp.footprints.add(footprint); if (!ref.endsWith('?')) footprints.set(ref, footprint); }
        const uid = ref.endsWith('?') ? uniqueIdFor(`orcad:${inst.dbId}`) : uniqueIdFor(`orcad:${ref}`);
        const parts = Math.max(1, pkg?.devices.length ?? 1);
        const ci = top({ RECORD: SR.COMPONENT, LIBREFERENCE: comp.libRef, PARTCOUNT: parts + 1, DISPLAYMODECOUNT: 1, CURRENTPARTID: partIdx + 1, ORIENTATION: pl.orient, ISMIRRORED: pl.mirrored || undefined,
          AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: comp.libRef, SOURCELIBRARYNAME: `${stem}.SchLib`, COMPONENTDESCRIPTION: comp.description || undefined, UNIQUEID: uid }, { LOCATION: pl.at });
        const own: Props = { OWNERINDEX: ci - 1, OWNERPARTID: partIdx + 1 };
        drawPrims(r, sym.prims, pl.place, pl.dir, pl.mirrored, own, sym.color === 48 ? 0 : sym.color, fonts);
        for (const pin of sym.pins) drawPin(r, pin, pl.place, own, pinNumber(pkg, partIdx, pin), sym, isHiddenPower(pin));
        // No-connects
        for (const pin of inst.pins) if (pin.pinIndex < 0) top({ RECORD: SR.NO_ERC, COLOR: COL.noerc, ISACTIVE: true, SUPPRESSALL: true, SYMBOL: 'Thin Cross' }, { LOCATION: P(pin) });
        // Reference, value, the rest: shown where Capture shows them
        const disp = (names: string[]) => inst.displayProps.find((dp) => names.some((n) => dp.name.toLowerCase() === n.toLowerCase()) && shown(dp)) ?? inst.displayProps.find((dp) => names.some((n) => dp.name.toLowerCase() === n.toLowerCase()));
        const field = (rec: number, name: string, text: string, dp: OrDisplayProp | undefined) => {
          const vis = !!dp && shown(dp);
          const t = vis && showsName(dp!) ? `${dp!.name}=${text}` : text;
          r.add({ RECORD: rec, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: name, TEXT: rec === SR.DESIGNATOR ? text : t, ...(vis ? { FONTID: fid(dispFont(dp!)), COLOR: colour(dp!.color, COL.text), ...textAt(dp!.rotation), SHOWNAME: showsName(dp!) || undefined } : { FONTID: 1, COLOR: COL.text, ISHIDDEN: true }) },
            { LOCATION: dp ? P({ x: inst.x + dp.x, y: inst.y + dp.y }) : pl.at });
        };
        field(SR.DESIGNATOR, 'Designator', ref, disp(['Part Reference', 'Reference']));
        field(SR.PARAMETER, 'Comment', value || comp.libRef, disp(['Value']));
        const skip = /^(Part Reference|Reference|Value|PCB Footprint|Source Library|Source Package|Source Part|Implementation|Implementation Path|Implementation Type|Graphic|Name|Primitive|Part Number|OriginalSymbolOrigin|Description)$/i;
        for (const [k, v] of Object.entries(props)) {
          if (!k || skip.test(k) || !v.trim()) continue;
          field(SR.PARAMETER, k, v, disp([k]));
        }
        if (props['Part Number']?.trim()) field(SR.PARAMETER, 'Part Number', props['Part Number'], disp(['Part Number']));
        // The footprint is the model; shown, a parameter too (as Capture shows it)
        const fpDp = disp(['PCB Footprint']);
        if (footprint && fpDp && shown(fpDp)) field(SR.PARAMETER, 'PCB Footprint', footprint, fpDp);
        if (footprint) {
          const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci - 1, OWNERPARTID: -1 });
          const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list - 1, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: footprint, MODELTYPE: 'PCBLIB',
            DATAFILECOUNT: 1, MODELDATAFILEENTITY0: footprint, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: true, UNIQUEID: uniqueId() });
          r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
          r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
        }
        nParts++;
      }

      /* ── power symbols, off-page connectors, ports: at their pin, pointing where their drawing lies ── */
      const connector = (g: OrGraphic) => {
        const sym = graphicSymbol(g);
        const base = graphicBase(g);
        const b = sym ? boxOf(sym) : { x1: 0, y1: 0, x2: 0, y2: 0 };
        const o = (g.rotation & 3) | (g.mirror ? 4 : 0);
        const w = b.x2 - b.x1, h = b.y2 - b.y1;
        const hot0 = graphicPin(g) ?? base;
        const flat = (sym?.prims ?? []).flatMap(function f(p: OrPrim): Pt[] { return p.kind === 'group' ? p.children.flatMap(f) : p.kind === 'polygon' || p.kind === 'polyline' ? p.points : [{ x: p.x1, y: p.y1 }, { x: p.x2, y: p.y2 }]; });
        const pts = flat.map((q) => orientPoint(o, w, h, base.x, base.y, q.x, q.y));
        const cen = pts.length ? { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length } : { x: base.x + w / 2, y: base.y + h / 2 };
        const hot = P(hot0), c = P(cen);
        const orient = Math.hypot(c.x - hot.x, c.y - hot.y) > 0.5 ? orientOf(hot, c) : 3;
        const nameDp = g.displayProps.find((dp) => dp.name === 'Name');
        return { hot, orient, nameShown: nameDp ? shown(nameDp) : true, sym, ext: Math.max(...pts.map((q) => Math.hypot(q.x - hot0.x, q.y - hot0.y)), 0) };
      };
      for (const g of page.globals) {
        const name = (g.logicalName || g.props.Name || g.name).trim();
        if (!name) continue;
        netNames.add(name);
        const cn = connector(g);
        const t = `${g.name} ${name}`.toUpperCase();
        const style = /EARTH|CHASSIS/.test(t) ? 6 : /GND_SIGNAL|SIGNAL|AGND|GNDA/.test(t) ? 5 : /GND|GROUND|VSS/.test(t) ? 4 : /CIRCLE/.test(t) ? 0 : /ARROW/.test(t) ? 1 : /WAVE/.test(t) ? 3 : 2;
        top({ RECORD: SR.POWER_PORT, STYLE: style, ORIENTATION: cn.orient, TEXT: busName(name), SHOWNETNAME: cn.nameShown, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: cn.hot });
      }
      for (const g of page.offpage) {
        const name = (g.logicalName || g.props.Name || g.name).trim();
        if (!name) continue;
        netNames.add(name);
        const cn = connector(g);
        top({ RECORD: SR.POWER_PORT, ISCROSSSHEETCONNECTOR: true, ORIENTATION: cn.orient, TEXT: busName(name), SHOWNETNAME: true, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: cn.hot });
        // Capture's off-page reference ([3]) where it shows it
        for (const dp of g.displayProps) if (dp.name !== 'Name' && shown(dp) && g.props[dp.name]) dispText(dp, graphicBase(g), g.props[dp.name]!, { OWNERPARTID: -1 });
      }
      for (const g of page.ports) {
        const name = (g.logicalName || g.props.Name || g.name).trim();
        if (!name) continue;
        netNames.add(name);
        const cn = connector(g);
        const t = g.name.toUpperCase();
        // Its direction: the parent block's pin of its name (Capture's interface), else its symbol's
        const pt = portTypes.get(folder.name.toLowerCase())?.get(name.toUpperCase()) ?? cn.sym?.pins[0]?.portType;
        const io = pt === 0 ? 2 : pt === 2 ? 1 : pt === 1 || pt === 5 || (pt === undefined && /BOTH/.test(t)) ? 3 : 0;
        // AD's ports join at both ends, Capture's at their tip: the far end clear of other wires and pins
        const w0 = Math.max(30, Math.ceil(Math.max(cn.ext, name.length * 6 + 12) / 10) * 10);
        const farEnd = (len: number): Pt => (cn.orient === 0 ? { x: cn.hot.x + len, y: cn.hot.y } : cn.orient === 2 ? { x: cn.hot.x - len, y: cn.hot.y } : cn.orient === 1 ? { x: cn.hot.x, y: cn.hot.y + len } : { x: cn.hot.x, y: cn.hot.y - len });
        const blocked = (q: Pt) => {
          const c = { x: q.x, y: H - q.y }, at = (x: number, y: number) => x === c.x && y === c.y;
          return page.wires.some((wr) => onSeg(c, wr)) || page.instances.some((i) => i.pins.some((pn) => at(pn.x, pn.y))) || page.blocks.some((b) => b.pins.some((pn) => at(pn.x, pn.y)))
            || [...page.globals, ...page.offpage, ...page.ports].some((o) => o !== g && ((h) => !!h && at(h.x, h.y))(graphicPin(o)));
        };
        const w = [w0, w0 + 10, w0 + 20, w0 - 10, w0 + 30, w0 - 20].find((x) => x >= 20 && !blocked(farEnd(x))) ?? w0;
        const loc = cn.orient === 2 ? { x: cn.hot.x - w, y: cn.hot.y } : cn.orient === 3 ? { x: cn.hot.x, y: cn.hot.y - w } : cn.hot;
        top({ RECORD: SR.PORT, NAME: busName(name), STYLE: cn.orient % 2 ? 7 : 3, IOTYPE: io, WIDTH: w, HEIGHT: 10, ALIGNMENT: 0, COLOR: COL.port, AREACOLOR: COL.portFill, TEXTCOLOR: COL.port, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: loc });
      }

      /* ── blocks: sheet symbols with their entries ── */
      for (const blk of page.blocks) {
        const files = so.blockFiles.get(blk.dbId) ?? [];
        const child = folderOf.get(childOf(blk).toLowerCase());
        const a = P({ x: blk.x1, y: blk.y1 });
        const si = top({ RECORD: SR.SHEET_SYMBOL, XSIZE: Math.max(1, blk.w), YSIZE: Math.max(1, blk.h), LINEWIDTH: 1, COLOR: COL.sheet, AREACOLOR: COL.sheetFill, ISSOLID: true, UNIQUEID: uniqueIdFor(`orcad:block:${so.path}/${blk.dbId}`) }, { LOCATION: a });
        const nameDp = blk.displayProps.find((dp) => /^(reference|part reference|name)$/i.test(dp.name));
        const fileDp = blk.displayProps.find((dp) => /^implementation( name)?$/i.test(dp.name));
        const designator = blk.reference || blk.name || child?.name || 'Sheet';
        r.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: si - 1, OWNERPARTID: -1, TEXT: designator, FONTID: nameDp ? fid(dispFont(nameDp)) : 1, COLOR: COL.text }, { LOCATION: nameDp ? P({ x: blk.x1 + nameDp.x, y: blk.y1 + nameDp.y }) : { x: a.x, y: a.y + 2 } });
        r.add({ RECORD: SR.FILE_NAME, OWNERINDEX: si - 1, OWNERPARTID: -1, TEXT: files.join(';') || missingFile(childOf(blk)), FONTID: fileDp ? fid(dispFont(fileDp)) : 1, COLOR: COL.text }, { LOCATION: fileDp ? P({ x: blk.x1 + fileDp.x, y: blk.y1 + fileDp.y }) : { x: a.x, y: a.y - blk.h - 8 } });
        for (const pin of blk.pins) {
          const side = pin.x <= blk.x1 ? 0 : pin.x >= blk.x1 + blk.w ? 1 : pin.y <= blk.y1 ? 2 : 3;
          const dist = side < 2 ? pin.y - blk.y1 : pin.x - blk.x1;
          const whole = Math.floor(dist / 10 + 1e-9), frac = Math.round((dist / 10 - whole) * 1_000_000); // _FRAC1: 1,000,000 a 100 mil
          const io = pin.portType === 0 ? 2 : pin.portType === 2 ? 1 : pin.portType === 1 || pin.portType === 5 ? 3 : 0;
          r.add({ RECORD: SR.SHEET_ENTRY, OWNERINDEX: si - 1, OWNERPARTID: -1, SIDE: side, DISTANCEFROMTOP: whole, DISTANCEFROMTOP_FRAC1: frac || undefined, NAME: busName(pin.name), IOTYPE: io, STYLE: side < 2 ? 3 : 7,
            COLOR: COL.port, AREACOLOR: COL.portFill, TEXTCOLOR: COL.port, TEXTFONTID: 1, UNIQUEID: uniqueId() });
          if (pin.noConnect) top({ RECORD: SR.NO_ERC, COLOR: COL.noerc, ISACTIVE: true, SUPPRESSALL: true, SYMBOL: 'Thin Cross' }, { LOCATION: P(pin) });
        }
      }

      /* ── text and drawings; the title block as drawn ── */
      for (const g of page.graphics) {
        if (!g.nested) continue;
        drawPrims(r, g.nested.prims, P, (deg) => deg, false, { OWNERPARTID: -1 }, g.color === 48 ? 0 : g.color, fonts);
      }
      let titled = false;
      for (const tb of page.titleBlocks) {
        const sym = graphicSymbol(tb);
        const base = graphicBase(tb);
        const o = (tb.rotation & 3) | (tb.mirror ? 4 : 0);
        if (sym) {
          const b = boxOf(sym);
          const pl = placement(o, b.x2 - b.x1, b.y2 - b.y1, base.x, base.y, P);
          drawPrims(r, sym.prims, pl.place, pl.dir, pl.mirrored, { OWNERPARTID: -1 }, 0, fonts);
          titled = true;
        }
        const value = (k: string): string => {
          if (k === 'Page Size') return page.pageSize;
          if (k === 'Page Number') return String(pageIdx + 1);
          if (k === 'Page Count') return String(folder.pages.length);
          if (/Modify Date|Create Date/.test(k)) return '';
          return tb.props[k] || page.props[k] || sym?.props[k] || '';
        };
        for (const dp of tb.displayProps) {
          if (!shown(dp)) continue;
          let v = value(dp.name);
          if (!v || v === '?') v = /date/i.test(dp.name) ? '' : `<${dp.name}>`;
          if (!v) continue;
          dispText(dp, base, showsName(dp) ? `${dp.name}: ${v}` : v, { OWNERPARTID: -1 });
        }
      }
      // Capture's border: AD's own, with Capture's zones
      const zx = Math.max(1, st.horizontalCount || 4), zy = Math.max(1, st.verticalCount || 4);
      r.bags[sheetIndex] = PropertyBag.from({ RECORD: SR.SHEET, ...fonts.keys(), USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true,
        CUSTOMX: W, CUSTOMY: H, CUSTOMXZONES: zx, CUSTOMYZONES: zy, CUSTOMMARGINWIDTH: Math.max(5, Math.round(unit(st.horizontalWidth || 200))),
        BORDERON: st.borderDisplayed, TITLEBLOCKON: !titled && st.titleblockDisplayed, AREACOLOR: toBgr(0xffffff),
        SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 4, SYSTEMFONT: 1, DOCUMENTBORDERSTYLE: 0 } as Record<string, string | number | boolean>);
      r.bags[0]!.setRaw('WEIGHT', String(r.bags.length - 1));
      out.push({ name: so.file, bytes: sheetBytes(r) });
    }
  }

  // A hierarchical design whose root has several pages: a top sheet with one symbol listing them
  if (wrapper) {
    const r = new Records();
    r.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
    const files = sheetsOcc.filter((x) => x.folder === d.root && !x.path).map((x) => x.file);
    const si = r.add({ RECORD: SR.SHEET_SYMBOL, OWNERPARTID: -1, XSIZE: 200, YSIZE: 100, LINEWIDTH: 1, COLOR: COL.sheet, AREACOLOR: COL.sheetFill, ISSOLID: true, UNIQUEID: uniqueIdFor(`orcad:root:${stem}`) }, { LOCATION: { x: 200, y: 600 } });
    r.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: si - 1, OWNERPARTID: -1, TEXT: d.root, FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 200, y: 602 } });
    r.add({ RECORD: SR.FILE_NAME, OWNERINDEX: si - 1, OWNERPARTID: -1, TEXT: files.join(';'), FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 200, y: 492 } });
    r.bags.splice(1, 0, PropertyBag.from({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Times New Roman', USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true, CUSTOMX: 1100, CUSTOMY: 850,
      CUSTOMXZONES: 4, CUSTOMYZONES: 4, CUSTOMMARGINWIDTH: 20, BORDERON: true, TITLEBLOCKON: true, AREACOLOR: toBgr(0xffffff), SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, SYSTEMFONT: 1 } as Record<string, string | number | boolean>));
    // The symbol's index moved by the sheet record put before it: its texts' owner too
    for (const bag of r.bags) { const ow = bag.get('OWNERINDEX'); if (ow !== undefined && Number(ow) === si - 1) bag.setRaw('OWNERINDEX', String(si)); }
    r.bags[0]!.setRaw('WEIGHT', String(r.bags.length - 1));
    out.unshift({ name: wrapper, bytes: sheetBytes(r) });
  }
  if (!out.length) warnings.push('No pages in it');

  /* ── the library: each package a component, its units its parts ── */
  const symbols: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[] = [];
  const byPkg = new Map<string, LibComp[]>();
  for (const c of libs.values()) { const k = c.pkg?.name ?? c.libRef; byPkg.set(k, [...(byPkg.get(k) ?? []), c]); }
  for (const c of libs.values()) {
    const n = Math.max(1, c.pkg?.devices.length ?? 1, c.units.length);
    // Units never placed: as another library entry of the package has them, else as the first (Capture's homogeneous parts)
    for (let u = 0; u < n; u++) if (!c.units[u]) c.units[u] = (byPkg.get(c.pkg?.name ?? c.libRef) ?? []).map((x) => x.units[u]).find(Boolean) ?? c.units.find(Boolean);
    const r = new Records();
    r.add({ RECORD: SR.COMPONENT, LIBREFERENCE: c.libRef, COMPONENTDESCRIPTION: c.description || undefined, PARTCOUNT: n + 1, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1,
      LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*', AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: c.libRef, UNIQUEID: uniqueId() });
    for (let u = 0; u < n; u++) {
      const sym = c.units[u];
      if (!sym) continue;
      const place = (p: Pt) => ({ x: p.x, y: -p.y });
      drawPrims(r, sym.prims, place, (deg) => deg, false, { OWNERPARTID: u + 1 }, sym.color === 48 ? 0 : sym.color, null);
      for (const pin of sym.pins) drawPin(r, pin, place, { OWNERPARTID: u + 1 }, pinNumber(c.pkg, u, pin), sym, isHiddenPower(pin));
    }
    r.add({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, NAME: 'Designator', TEXT: `${c.prefix || 'U'}?`, FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 0, y: 10 } });
    r.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: 'Comment', TEXT: '*', FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 0, y: -10 } });
    const fps = [...c.footprints];
    if (fps.length) {
      const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERPARTID: -1 });
      fps.forEach((fp, k) => {
        const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: fp, MODELTYPE: 'PCBLIB',
          DATAFILECOUNT: 1, MODELDATAFILEENTITY0: fp, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: k === 0, UNIQUEID: uniqueId() });
        r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl, OWNERPARTID: -1 });
        r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl, OWNERPARTID: -1 });
      });
    }
    symbols.push({ libRef: c.libRef, description: c.description, parts: n, bags: r.bags });
  }
  return { sheets: out, library: writeSchLib(symbols), symbols: symbols.length, warnings, scope, footprints, stats: { sheets: out.length, parts: nParts, nets: netNames.size, symbols: symbols.length } };
}

function sheetBytes(r: Records): Uint8Array {
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', joinSchRecords(r.bags.map((bag) => ({ kind: 0, data: bag.toBytes(), bag }))));
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  return writeCfb(root);
}

/** An OLB's parts as a SchLib (each package a component, its units its parts). */
export function convertOrcadLib(d: OrDesign): { library: Uint8Array; symbols: number; warnings: string[] } {
  const fake: OrDesign = { ...d, folders: [{ name: 'Library', pages: [] }], root: 'Library' };
  const res = convertOrcadSch(fake, 'Library');
  // No placements: every package's symbols straight from the library
  const symbols: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[] = [];
  const warnings = res.warnings.filter((w) => w !== 'No pages in it');
  for (const pkg of d.packages.values()) {
    const units = pkg.devices.length ? pkg.devices : [{ unitRef: '', refDes: '', pinNumbers: [], pinIgnore: [] }];
    const syms = units.map((_, u) => d.symbols.get(`${pkg.name}.Normal`) ?? d.symbols.get(pkg.name) ?? [...d.symbols.values()].find((s) => s.name.split('.')[0] === pkg.name) ?? (u ? undefined : undefined));
    const r = new Records();
    r.add({ RECORD: SR.COMPONENT, LIBREFERENCE: pkg.name, COMPONENTDESCRIPTION: pkg.props.Description || undefined, PARTCOUNT: units.length + 1, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1,
      LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*', AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: pkg.name, UNIQUEID: uniqueId() });
    syms.forEach((sym, u) => { if (sym) libDraw(r, sym, pkg, u); });
    r.add({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, NAME: 'Designator', TEXT: `${pkg.refDes || 'U'}?`, FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 0, y: 10 } });
    r.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: 'Comment', TEXT: '*', FONTID: 1, COLOR: COL.text }, { LOCATION: { x: 0, y: -10 } });
    if (pkg.pcbFootprint) {
      const list = r.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERPARTID: -1 });
      const impl = r.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: pkg.pcbFootprint, MODELTYPE: 'PCBLIB', DATAFILECOUNT: 1, MODELDATAFILEENTITY0: pkg.pcbFootprint, MODELDATAFILEKIND0: 'PCBLib', ISCURRENT: true, UNIQUEID: uniqueId() });
      r.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl, OWNERPARTID: -1 });
      r.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl, OWNERPARTID: -1 });
    }
    symbols.push({ libRef: pkg.name, description: pkg.props.Description, parts: units.length, bags: r.bags });
  }
  return { library: writeSchLib(symbols), symbols: symbols.length, warnings };
}

/** A symbol drawn into a library component's part (no sheet fonts: font 1). */
function libDraw(r: Records, sym: OrSymbol, pkg: OrPackage, u: number) {
  const place = (p: Pt) => ({ x: p.x, y: -p.y });
  const own: Props = { OWNERPARTID: u + 1 };
  const drawn = (prims: OrPrim[], off: Pt) => {
    for (const pr of prims) {
      const p = (x: number, y: number) => place({ x: x + off.x, y: y + off.y });
      const look: Props = { COLOR: COL.body, LINEWIDTH: width(pr.lineWidth), ...lineStyle(pr.lineStyle) };
      const fill: Props = pr.fillStyle === 0 || pr.fillStyle === 2 ? { AREACOLOR: COL.body, ISSOLID: true } : { AREACOLOR: COL.fill, ISSOLID: false, TRANSPARENT: true };
      if (pr.kind === 'group') drawn(pr.children, { x: off.x + pr.x1, y: off.y + pr.y1 });
      else if (pr.kind === 'rect') { const a = p(pr.x1, pr.y1), b = p(pr.x2, pr.y2); r.add({ RECORD: SR.RECTANGLE, ...own, ...look, ...fill }, { LOCATION: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, CORNER: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) } }); }
      else if (pr.kind === 'line') r.add({ RECORD: SR.LINE, ...own, ...look }, { LOCATION: p(pr.x1, pr.y1), CORNER: p(pr.x2, pr.y2) });
      else if (pr.kind === 'ellipse') r.add({ RECORD: SR.ELLIPSE, ...own, ...look, ...fill, ...radius('RADIUS', Math.abs(pr.x2 - pr.x1) / 2), ...radius('SECONDARYRADIUS', Math.abs(pr.y2 - pr.y1) / 2) }, { LOCATION: p((pr.x1 + pr.x2) / 2, (pr.y1 + pr.y2) / 2) });
      else if (pr.kind === 'polygon' || pr.kind === 'polyline') { const pts = pr.points.map((q) => p(q.x, q.y)); if (pts.length >= 2) r.points({ RECORD: pr.kind === 'polygon' && pts.length >= 3 ? SR.POLYGON : SR.POLYLINE, ...own, ...look, ...(pr.kind === 'polygon' ? fill : {}) }, pts); }
      else if (pr.kind === 'arc' && pr.start && pr.end) {
        const cx = (pr.x1 + pr.x2) / 2, cy = (pr.y1 + pr.y2) / 2, rx = Math.abs(pr.x2 - pr.x1) / 2 || 0.01, ry = Math.abs(pr.y2 - pr.y1) / 2 || 0.01;
        const c = p(cx, cy), s = p(pr.start.x, pr.start.y), e = p(pr.end.x, pr.end.y);
        const ang = (q: Pt) => ((Math.atan2((q.y - c.y) / ry, (q.x - c.x) / rx) * 180) / Math.PI + 360) % 360;
        r.add({ RECORD: Math.abs(rx - ry) < 0.01 ? SR.ARC : SR.ELLIPTICAL_ARC, ...own, ...look, ...radius('RADIUS', rx), ...(Math.abs(rx - ry) < 0.01 ? {} : radius('SECONDARYRADIUS', ry)), STARTANGLE: ang(s).toFixed(3), ENDANGLE: ang(e).toFixed(3) }, { LOCATION: c });
      } else if (pr.kind === 'text' && pr.text?.trim()) r.add({ RECORD: SR.LABEL, ...own, TEXT: plain(pr.text).split('\n')[0]!, FONTID: 1, COLOR: COL.text }, { LOCATION: p(pr.x1, pr.y1) });
    }
  };
  drawn(sym.prims, { x: 0, y: 0 });
  for (const pin of sym.pins) {
    const hot = place({ x: pin.hotX, y: pin.hotY }), start = place({ x: pin.startX, y: pin.startY });
    const len = Math.hypot(pin.startX - pin.hotX, pin.startY - pin.hotY);
    const name = pin.name.startsWith('$PIN') ? '' : pin.name;
    const hidden = pin.portType === 7 && (pin.shapeBits & 0x80) !== 0 && len === 0 && !!name;
    const num = pkg.devices[u]?.pinNumbers[pin.position] ?? String(pin.position + 1);
    const showName = sym.generalFlags < 0 || (sym.generalFlags & 1) !== 0, showNumber = sym.generalFlags < 0 || (sym.generalFlags & 4) === 0;
    r.add({ RECORD: SR.PIN, ...own, ELECTRICAL: pin.portType, PINCONGLOMERATE: (len > 0 ? orientOf(start, hot) : 0) | (hidden ? 0x04 : 0) | (showName && name ? 0x08 : 0) | (showNumber ? 0x10 : 0),
      ...lengthKeys(len), NAME: busName(name), DESIGNATOR: num, COLOR: COL.pin, ...(pin.shapeBits & 4 ? { SYMBOL_OUTEREDGE: 1 } : {}), ...(pin.shapeBits & 2 ? { SYMBOL_INNEREDGE: 3 } : {}),
      HIDDENNETNAME: hidden ? name : undefined }, { LOCATION: len > 0 ? start : hot });
  }
}
