/**
 * EAGLE schematics as AD's: a SchDoc per sheet, a SchLib of the devices placed (each device set and
 * package variant a symbol, its gates the symbol's parts, each pin's designator the pad it connects
 * to — a pin on several pads one pin per pad, stacked), parts placed as EAGLE mirrors and turns them,
 * the name, value and attributes where the symbol or the smashed part shows them, the package as
 * the footprint; supply symbols as power ports named by their net; nets drawn as their wires with
 * their junctions and labels; busses with their names; frames and the sheet's drawing as drawn.
 * EAGLE's nets are its own (a net is its name, on every sheet): the project's Net Identifier Scope is
 * Global, every piece of a net drawn apart gets a label of its name (a net label as well at one supply
 * symbol where it also has labels: AD joins names kind to kind), and a named net no label names gets
 * one. EAGLE's millimetres, Y up, are AD's 10 mil units.
 */
import { PropertyBag } from '../altium/props';
import { cfbPut, newEntry, writeCfb } from '../cfb/cfb';
import { joinSchRecords } from '../altium/framing';
import { binToBytes } from '../text';
import { writeSchLib } from '../altium/schlib';
import { SR } from '../../model/sch';
import { toBgr } from '../../model/common';
import { uniqueId } from '../../model/schEdit';
import { COL, Fonts, Records, lengthKeys, orientOf, radius, type Props } from '../kicad/schematic';
import { uniqueIdFor } from '../kicad/board';
import { attrNum, kid, kidsOf, type XEl } from '../xml';
import { autoNet, overbar, partsOf, pinShown, rotOf, type EDevice, type EDeviceSet, type ELib, type EPart, type ERot, type EagleDoc } from './read';

type Pt = { x: number; y: number };
export interface EagleSchResult {
  sheets: { name: string; bytes: Uint8Array }[];
  library: Uint8Array;
  symbols: number;
  warnings: string[];
  stats: { sheets: number; parts: number; nets: number; symbols: number };
  /** The packages the parts use: footprint name → its library and package. */
  footprints: Map<string, { lib: ELib; pkg: string }>;
}

/** mm → AD's schematic unit (10 mil). */
const U = (mm: number) => mm / 0.254;
const norm = (a: number) => ((a % 360) + 360) % 360;
const quarter = (a: number) => Math.round(norm(a) / 90) % 4;
const COS = [1, 0, -1, 0], SIN = [0, 1, 0, -1];
const num = (e: XEl, a: string, d = 0) => attrNum(e, a, d);

/**
 * EAGLE's placement ("MR90": turned anticlockwise, then mirrored, x → −x), then moved (mm in, mm
 * out). An EAGLE rotation is M·R(angle) throughout: a smashed text of a part keeps it.
 */
export function placer(x: number, y: number, r: ERot) {
  const quarterOnly = r.angle % 90 === 0;
  const q = quarter(r.angle);
  const rad = (r.angle * Math.PI) / 180;
  const c = quarterOnly ? COS[q]! : Math.cos(rad), s = quarterOnly ? SIN[q]! : Math.sin(rad);
  const m = r.mirror ? -1 : 1;
  return {
    pt: (p: Pt): Pt => ({ x: x + m * (p.x * c - p.y * s), y: y + p.x * s + p.y * c }),
    /** A direction's angle (degrees) once placed. */
    dir: (deg: number) => (r.mirror ? 180 - deg - r.angle : r.angle + deg),
    /** A text's or a child's own rotation once placed (M·R(a) of the part after M·R(t) of its own). */
    frame: (t: ERot): ERot => ({ angle: norm(t.mirror ? t.angle - r.angle : r.angle + t.angle), mirror: r.mirror !== t.mirror, spin: t.spin || r.spin }),
    rot: r,
  };
}
type Placer = ReturnType<typeof placer>;
const IDENTITY = placer(0, 0, { angle: 0, mirror: false, spin: false });

/** EAGLE's align → (horizontal 0 left … 2 right, vertical 0 bottom … 2 top). */
function alignOf(a: string | undefined): [number, number] {
  const s = (a ?? 'bottom-left').toLowerCase();
  if (s === 'center') return [1, 1];
  const [v, h] = s.split('-');
  return [h === 'left' ? 0 : h === 'right' ? 2 : 1, v === 'bottom' ? 0 : v === 'top' ? 2 : 1];
}
/**
 * A text's AD orientation and justification. EAGLE's schematic text is never drawn mirrored: a
 * mirrored one (M·R(a)) reads at −a from its other end; turned past 90° (unless spun) it is turned
 * back to read upright, its anchor's sides swapped.
 */
export function textLook(t: ERot, align: string | undefined): { ORIENTATION: number; JUSTIFICATION: number } {
  let [h, v] = alignOf(align);
  let a = norm(t.angle);
  if (t.mirror) { a = norm(-a); h = 2 - h; }
  if (!t.spin && a > 90 && a <= 270) { a -= 180; h = 2 - h; v = 2 - v; }
  return { ORIENTATION: quarter(a), JUSTIFICATION: v * 3 + h };
}

/** A label's AD orientation: AD's net label reads from its hot spot, at 180° and 270° upright from its other end. */
export function labelOrient(t: ERot): number {
  let a = norm(t.angle), flip = false;
  if (t.mirror) { a = norm(-a); flip = !flip; }
  if (!t.spin && a > 90 && a <= 270) { a -= 180; flip = !flip; }
  return (quarter(a) + (flip ? 2 : 0)) % 4;
}

/** EAGLE's line width (mm) as AD's: smallest, small, medium, large. */
const lineWidth = (w: number) => (w < 0.2 ? 0 : w < 0.5 ? 1 : w < 1 ? 2 : 3);
const STYLE: Record<string, number> = { longdash: 1, shortdash: 1, dashdot: 3 };
const looks = (e: XEl, colour: number): Props => {
  const st = STYLE[e.attrs.style ?? ''] ?? 0;
  return { COLOR: colour, LINEWIDTH: lineWidth(num(e, 'width')), ...(st ? { LINESTYLE: Math.min(2, st), LINESTYLEEXT: st } : {}) };
};

/** The arc a wire's curve (degrees, anticlockwise from its start) bends it into, in AD's terms (centre, radius, from start to end anticlockwise). */
export function curveArc(a: Pt, b: Pt, curve: number): { c: Pt; r: number; start: number; end: number } | null {
  const th = (curve * Math.PI) / 180;
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  if (!d || Math.abs(Math.sin(th / 2)) < 1e-9) return null;
  const r = d / (2 * Math.abs(Math.sin(th / 2)));
  // The centre: off the chord's middle, to the left going anticlockwise
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const h = r * Math.cos(th / 2) * Math.sign(th);
  const ux = -(b.y - a.y) / d, uy = (b.x - a.x) / d;
  const c = { x: m.x + ux * h, y: m.y + uy * h };
  const ang = (p: Pt) => norm((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI);
  return th > 0 ? { c, r, start: ang(a), end: ang(b) } : { c, r, start: ang(b), end: ang(a) };
}
/** A curved wire as points along it (AD's wires are straight). */
function curvePoints(a: Pt, b: Pt, curve: number): Pt[] {
  const arc = curveArc(a, b, curve);
  if (!arc) return [a, b];
  const n = Math.max(2, Math.ceil(Math.abs(curve) / 15));
  const a0 = Math.atan2(a.y - arc.c.y, a.x - arc.c.x), th = (curve * Math.PI) / 180;
  const out: Pt[] = [a];
  for (let i = 1; i < n; i++) out.push({ x: arc.c.x + arc.r * Math.cos(a0 + (th * i) / n), y: arc.c.y + arc.r * Math.sin(a0 + (th * i) / n) });
  out.push(b);
  return out;
}

/* ── devices ── */

/** A device's name as EAGLE gives it: the set's name, its '*' the technology, its '?' the variant (else the variant after it). */
export function deviceName(ds: string, dev: string, tech = ''): string {
  let s = ds.includes('*') ? ds.replace('*', tech) : ds;
  s = s.includes('?') ? s.replace('?', dev) : s + dev;
  return s;
}
const PIN_LEN: Record<string, number> = { point: 0, short: 2.54, middle: 5.08, long: 7.62 };
/** EAGLE's pin direction as AD's electrical type. */
export const ELECTRICAL: Record<string, number> = { in: 0, io: 1, out: 2, oc: 3, pas: 4, hiz: 5, pwr: 7, sup: 7, nc: 4 };

export interface Resolved { lib: ELib; ds: EDeviceSet; dev: EDevice; key: string }
export function resolvePart(doc: EagleDoc, p: EPart): Resolved | undefined {
  const lib = doc.lib(p.lib, p.urn);
  const ds = lib?.devicesets.get(p.deviceset);
  const dev = ds?.devices.get(p.device);
  return lib && ds && dev ? { lib, ds, dev, key: `${lib.name}\u0000${lib.urn}\u0000${ds.name}\u0000${dev.name}` } : undefined;
}
/** Pads by gate and pin: "G$1\0A" → ["1", "3"]. */
const padsOf = (dev: EDevice) => new Map(dev.connects.map((c) => [`${c.gate}\u0000${c.pin}`, c.pads]));
const pinsOf = (sym: XEl | undefined) => kidsOf(sym, 'pin');
/** A supply symbol's device: no package, its pins all supply pins. */
export function isSupply(r: Resolved): boolean {
  if (r.dev.pkg) return false;
  const pins = r.ds.gates.flatMap((g) => pinsOf(r.lib.symbols.get(g.symbol)));
  return pins.length > 0 && pins.every((p) => (p.attrs.direction ?? 'io') === 'sup');
}
/** A device with nothing to connect and nothing to place: a frame, a logo, a note. */
const isDrawing = (r: Resolved) => !r.dev.pkg && r.ds.gates.every((g) => !pinsOf(r.lib.symbols.get(g.symbol)).length);

/* ── drawing a symbol ── */

interface DrawCtx {
  rr: Records;
  fonts: Fonts;
  /** In the library: font 1 for all (a SchLib keeps none of its own). */
  lib?: boolean;
  /** mm → AD units on the sheet. */
  P: (p: Pt) => Pt;
  warn: (w: string) => void;
  /** Whether a gate's pin is on no net (a part's on the sheet). */
  unconnected?: (gate: string, pin: string) => boolean;
}
const fontOf = (ctx: DrawCtx, e: XEl) => (ctx.lib ? 1 : ctx.fonts.id(num(e, 'size', 1.778), (e.attrs.font ?? '') !== 'vector' && num(e, 'ratio', 8) >= 15));

/** A text's lines as labels, the first at its anchor, the rest below it (EAGLE's line distance, 50 % of its size by default). */
function textRecords(ctx: DrawCtx, own: Props, text: string, at: Pt, t: ERot, e: XEl, colour: number): void {
  const lines = text.replace(/\r/g, '').split('\n');
  const look = textLook(t, e.attrs.align);
  const size = num(e, 'size', 1.778), pitch = size * (1 + num(e, 'distance', 50) / 100);
  // Lines go down the text's own way: its anchor the first line's when at the bottom, else as EAGLE sets them round it
  const [, v] = alignOf(e.attrs.align);
  const a = (((look.ORIENTATION * 90) - 90) * Math.PI) / 180;
  const down = { x: Math.round(Math.cos(a) * 1e6) / 1e6, y: Math.round(Math.sin(a) * 1e6) / 1e6 };
  const shift = v === 0 ? -(lines.length - 1) : v === 1 ? -(lines.length - 1) / 2 : 0;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const k = (i + shift) * pitch;
    ctx.rr.add({ RECORD: SR.LABEL, ...own, TEXT: line, FONTID: fontOf(ctx, e), COLOR: colour, ...look }, { LOCATION: ctx.P({ x: at.x + down.x * k, y: at.y + down.y * k }) });
  });
}

/**
 * A symbol's drawing (not its pins or placeholder texts) through `pl` (symbol → sheet, mm), into
 * records owned as `own`.
 */
function drawGraphics(ctx: DrawCtx, holder: XEl, pl: Placer, own: Props, resolve: (key: string) => string | undefined, skipText?: (key: string) => boolean): void {
  const { rr, P } = ctx;
  for (const e of holder.children) {
    const layer = num(e, 'layer');
    const colour = layer === 94 ? COL.body : layer === 91 || layer === 92 ? COL.wire : COL.graphic;
    switch (e.name) {
      case 'wire': {
        const a = pl.pt({ x: num(e, 'x1'), y: num(e, 'y1') }), b = pl.pt({ x: num(e, 'x2'), y: num(e, 'y2') });
        const curve = num(e, 'curve') * (pl.rot.mirror ? -1 : 1);
        if (curve) {
          const arc = curveArc(a, b, curve);
          if (arc) { rr.add({ RECORD: SR.ARC, ...own, ...looks(e, colour), ...radius('RADIUS', U(arc.r)), STARTANGLE: arc.start.toFixed(3), ENDANGLE: arc.end.toFixed(3) }, { LOCATION: P(arc.c) }); break; }
        }
        rr.add({ RECORD: SR.LINE, ...own, ...looks(e, colour) }, { LOCATION: P(a), CORNER: P(b) });
        break;
      }
      case 'circle': {
        const c = pl.pt({ x: num(e, 'x'), y: num(e, 'y') }), r = num(e, 'radius'), w = num(e, 'width');
        const solid = w === 0;
        rr.add({ RECORD: SR.ELLIPSE, ...own, COLOR: colour, LINEWIDTH: lineWidth(w), AREACOLOR: colour, ISSOLID: solid, TRANSPARENT: !solid || undefined,
          ...radius('RADIUS', U(r)), ...radius('SECONDARYRADIUS', U(r)) }, { LOCATION: P(c) });
        break;
      }
      case 'rectangle': {
        // Its own turn about its centre, then the placement
        const x1 = num(e, 'x1'), y1 = num(e, 'y1'), x2 = num(e, 'x2'), y2 = num(e, 'y2');
        const own2 = rotOf(e.attrs.rot);
        const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
        const inner = placer(cx, cy, own2);
        const pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([x, y]) => pl.pt(inner.pt({ x: x! - cx, y: y! - cy })));
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        if (own2.angle % 90 === 0 && pl.rot.angle % 90 === 0) rr.add({ RECORD: SR.RECTANGLE, ...own, COLOR: colour, LINEWIDTH: 0, AREACOLOR: colour, ISSOLID: true },
          { LOCATION: P({ x: Math.min(...xs), y: Math.min(...ys) }), CORNER: P({ x: Math.max(...xs), y: Math.max(...ys) }) });
        else rr.points({ RECORD: SR.POLYGON, ...own, COLOR: colour, LINEWIDTH: 0, AREACOLOR: colour, ISSOLID: true }, pts.map(P));
        break;
      }
      case 'polygon': {
        const vs = kidsOf(e, 'vertex');
        const pts: Pt[] = [];
        vs.forEach((v, i) => {
          const a = pl.pt({ x: num(v, 'x'), y: num(v, 'y') });
          const nx = vs[(i + 1) % vs.length]!;
          const b = pl.pt({ x: num(nx, 'x'), y: num(nx, 'y') });
          const curve = num(v, 'curve') * (pl.rot.mirror ? -1 : 1);
          if (curve) pts.push(...curvePoints(a, b, curve).slice(0, -1)); else pts.push(a);
        });
        if (pts.length >= 3) rr.points({ RECORD: SR.POLYGON, ...own, COLOR: colour, LINEWIDTH: lineWidth(num(e, 'width')), AREACOLOR: colour, ISSOLID: true }, pts.map(P));
        break;
      }
      case 'text': {
        let text = e.text ?? '';
        const key = text.startsWith('>') ? text.slice(1).trim().toUpperCase() : '';
        if (key) { if (skipText?.(key)) break; const v = resolve(key); if (v === undefined) break; text = v; }
        if (!text.trim()) break;
        textRecords(ctx, own, text, pl.pt({ x: num(e, 'x'), y: num(e, 'y') }), pl.frame(rotOf(e.attrs.rot)), e, layer === 94 ? COL.body : COL.text);
        break;
      }
      case 'frame': drawFrame(ctx, e, pl, own); break;
      case 'dimension': ctx.warn('Dimensions left out'); break;
      default:
    }
  }
}

/**
 * EAGLE's frame: its outline, and with columns or rows a border strip (3.81 mm inside each side it
 * has) divided evenly along the outline, numbered 1… from the left and lettered A… from the top.
 */
function drawFrame(ctx: DrawCtx, e: XEl, pl: Placer, own: Props): void {
  const { rr, P } = ctx;
  const x1 = Math.min(num(e, 'x1'), num(e, 'x2')), x2 = Math.max(num(e, 'x1'), num(e, 'x2'));
  const y1 = Math.min(num(e, 'y1'), num(e, 'y2')), y2 = Math.max(num(e, 'y1'), num(e, 'y2'));
  const cols = Math.max(0, num(e, 'columns')), rows = Math.max(0, num(e, 'rows'));
  const side = (k: string) => (e.attrs[`border-${k}`] ?? 'yes') !== 'no';
  const look: Props = { COLOR: COL.body, LINEWIDTH: 1 };
  const line = (a: Pt, b: Pt) => rr.add({ RECORD: SR.LINE, ...own, ...look }, { LOCATION: P(pl.pt(a)), CORNER: P(pl.pt(b)) });
  const box = (ax: number, ay: number, bx: number, by: number) => { line({ x: ax, y: ay }, { x: bx, y: ay }); line({ x: bx, y: ay }, { x: bx, y: by }); line({ x: bx, y: by }, { x: ax, y: by }); line({ x: ax, y: by }, { x: ax, y: ay }); };
  box(x1, y1, x2, y2);
  if (!cols && !rows) return;
  const b = 3.81;
  const ix1 = x1 + (side('left') ? b : 0), ix2 = x2 - (side('right') ? b : 0), iy1 = y1 + (side('bottom') ? b : 0), iy2 = y2 - (side('top') ? b : 0);
  box(ix1, iy1, ix2, iy2);
  const label = (text: string, at: Pt) => rr.add({ RECORD: SR.LABEL, ...own, TEXT: text, FONTID: ctx.lib ? 1 : ctx.fonts.id(2.54), COLOR: COL.body, ORIENTATION: 0, JUSTIFICATION: 4 }, { LOCATION: P(pl.pt(at)) });
  for (let i = 0; i < cols; i++) {
    const xa = x1 + ((x2 - x1) * i) / cols, xm = x1 + ((x2 - x1) * (i + 0.5)) / cols;
    if (side('top')) { if (i) line({ x: xa, y: iy2 }, { x: xa, y: y2 }); label(String(i + 1), { x: xm, y: y2 - b / 2 }); }
    if (side('bottom')) { if (i) line({ x: xa, y: y1 }, { x: xa, y: iy1 }); label(String(i + 1), { x: xm, y: y1 + b / 2 }); }
  }
  for (let j = 0; j < rows; j++) {
    const ya = y2 - ((y2 - y1) * j) / rows, ym = y2 - ((y2 - y1) * (j + 0.5)) / rows;
    const letter = String.fromCharCode(65 + (j % 26));
    if (side('left')) { if (j) line({ x: x1, y: ya }, { x: ix1, y: ya }); label(letter, { x: x1 + b / 2, y: ym }); }
    if (side('right')) { if (j) line({ x: ix2, y: ya }, { x: x2, y: ya }); label(letter, { x: x2 - b / 2, y: ym }); }
  }
}

interface PinOut { at: Pt; name: string; gate: string; pin: string; pads: string[]; direction: string; visible: string }
/**
 * A gate's pins into records: each at its body end, pointing to where it connects; a pin on several
 * pads one pin per pad stacked on it (the others' name and number hidden). Returns where each
 * connects (sheet, AD units).
 */
function drawPins(ctx: DrawCtx, sym: XEl, gate: string, pads: Map<string, string[]> | undefined, pl: Placer, own: Props): PinOut[] {
  const out: PinOut[] = [];
  for (const p of pinsOf(sym)) {
    const name = p.attrs.name ?? '';
    const len = PIN_LEN[p.attrs.length ?? 'long'] ?? 7.62;
    const hot = ctx.P(pl.pt({ x: num(p, 'x'), y: num(p, 'y') }));
    const d = quarter(pl.dir(rotOf(p.attrs.rot).angle));
    // AD's pin: at its body end, pointing out to its hot spot (the body is the way EAGLE's pin points)
    const body = { x: hot.x + COS[d]! * U(len), y: hot.y + SIN[d]! * U(len) };
    const orient = len > 0 ? orientOf(body, hot) : (d + 2) % 4;
    const visible = p.attrs.visible ?? 'both';
    const showName = visible === 'both' || visible === 'pin', showNum = visible === 'both' || visible === 'pad';
    const fn = p.attrs.function ?? 'none';
    const direction = p.attrs.direction ?? 'io';
    const list = pads ? pads.get(`${gate}\u0000${name}`) ?? [] : [];
    const designators = list.length ? list : [pinShown(name)];
    designators.forEach((des, i) => {
      ctx.rr.add({ RECORD: SR.PIN, ...own, ELECTRICAL: ELECTRICAL[direction] ?? 4,
        PINCONGLOMERATE: orient | (showName && !i ? 0x08 : 0) | (showNum && !i ? 0x10 : 0),
        ...lengthKeys(U(len)), NAME: overbar(pinShown(name)), DESIGNATOR: des, COLOR: COL.pin,
        ...(fn === 'dot' || fn === 'dotclk' ? { SYMBOL_OUTEREDGE: 1 } : {}), ...(fn === 'clk' || fn === 'dotclk' ? { SYMBOL_INNEREDGE: 3 } : {}) }, { LOCATION: body });
    });
    if (list.length > 1 && ctx.unconnected?.(gate, name)) ctx.warn('Pins on several pads and on no net: Konium Designer joins their pads as a net (EAGLE leaves them apart)');
    out.push({ at: hot, name, gate, pin: name, pads: list, direction, visible });
  }
  return out;
}

/* ── the library ── */

export interface LibEntry { libRef: string; r: Resolved; footprint: string }
/** Device symbols as a SchLib: each gate a part, its pins numbered by the device's pads. */
export function eagleSymbolLibrary(entries: LibEntry[], footprintLib = ''): { bytes: Uint8Array; count: number; warnings: string[] } {
  const warnings: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w)) warnings.push(w); };
  const symbols: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[] = [];
  for (const { libRef, r, footprint } of entries) {
    const rr = new Records(), fonts = new Fonts();
    const desc = stripHtml(r.ds.description);
    const gates = r.ds.gates;
    rr.add({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, COMPONENTDESCRIPTION: desc || undefined, PARTCOUNT: gates.length + 1, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1,
      LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*', AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: libRef, UNIQUEID: uniqueId() });
    const ctx: DrawCtx = { rr, fonts, lib: true, P: (p) => ({ x: U(p.x), y: U(p.y) }), warn };
    const pads = padsOf(r.dev);
    let nameAt: Pt | undefined, valueAt: Pt | undefined;
    gates.forEach((g, i) => {
      const sym = r.lib.symbols.get(g.symbol);
      if (!sym) { warn(`Symbol ${g.symbol} missing from library ${r.lib.name}`); return; }
      drawGraphics(ctx, sym, IDENTITY, { OWNERPARTID: i + 1 }, () => undefined);
      drawPins(ctx, sym, g.name, r.dev.pkg ? pads : undefined, IDENTITY, { OWNERPARTID: i + 1 });
      for (const t of kidsOf(sym, 'text')) {
        const k = (t.text ?? '').trim().toUpperCase();
        if (k === '>NAME' && !nameAt) nameAt = { x: U(num(t, 'x')), y: U(num(t, 'y')) };
        if (k === '>VALUE' && !valueAt) valueAt = { x: U(num(t, 'x')), y: U(num(t, 'y')) };
      }
    });
    const prefix = r.ds.prefix || 'U';
    rr.add({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, NAME: 'Designator', TEXT: `${prefix}?`, FONTID: 1, COLOR: COL.text, ISHIDDEN: nameAt ? undefined : true }, { LOCATION: nameAt ?? { x: 0, y: 0 } });
    rr.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: 'Comment', TEXT: '*', FONTID: 1, COLOR: COL.text, ISHIDDEN: valueAt ? undefined : true }, { LOCATION: valueAt ?? { x: 0, y: 0 } });
    if (footprint) {
      const list = rr.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERPARTID: -1 });
      const impl = rr.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: footprint, MODELTYPE: 'PCBLIB',
        DATAFILECOUNT: 1, MODELDATAFILEENTITY0: footprint, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: true, UNIQUEID: uniqueId() });
      rr.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl, OWNERPARTID: -1 });
      rr.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl, OWNERPARTID: -1 });
    }
    symbols.push({ libRef, description: desc, parts: gates.length, bags: rr.bags });
  }
  return { bytes: writeSchLib(symbols), count: symbols.length, warnings };
}

/** EAGLE's descriptions are rich text: their tags out, their line breaks kept as spaces. */
export function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** Footprint names for packages: the package's name, with its library's where two libraries' packages share it. */
export function footprintNames(libs: ELib[]): (lib: ELib, pkg: string) => string {
  const owners = new Map<string, Set<string>>();
  for (const l of libs) for (const p of l.packages.keys()) { const k = p.toUpperCase(); if (!owners.has(k)) owners.set(k, new Set()); owners.get(k)!.add(`${l.name}\u0000${l.urn}`); }
  return (lib, pkg) => ((owners.get(pkg.toUpperCase())?.size ?? 0) > 1 ? `${pkg}_${lib.name}` : pkg).replace(/[\\/:*?"<>|]/g, '_');
}

/* ── the schematic ── */

/** A sheet to convert: EAGLE's own, or a module's for one instance of it (its names made the instance's). */
interface SheetIn { el: XEl; file?: string; title?: string }
/** A module instance as drawn on its sheet: its frame (mm, centre and size, turned), its ports, the files of its sheets. */
interface ModuleDraw { name: string; module: string; x: number; y: number; dx: number; dy: number; rot: ERot; ports: { name: string; side: string; coord: number }[]; files: string[] }

const cloneEl = (e: XEl): XEl => ({ name: e.name, attrs: { ...e.attrs }, children: e.children.map(cloneEl), text: e.text });

/**
 * EAGLE 8's modules (hierarchy) made flat for AD: each module instance's sheets once per instance,
 * its parts named as EAGLE names them on the board (the instance's name, a colon, the part's — or
 * the part's number moved on by the instance's offset), its nets its own (automatic ones renumbered,
 * named ones after the instance), a net of a port's name the net the port is wired to outside, a
 * supply net global as EAGLE keeps it [est: EAGLE's naming].
 */
function expandModules(doc: EagleDoc, stem: string): { parts: Map<string, EPart>; sheets: SheetIn[]; draws: Map<XEl, ModuleDraw>; modules: number } {
  const sch = doc.schematic!;
  const parts = partsOf(sch);
  const sheets: SheetIn[] = kidsOf(kid(sch, 'sheets'), 'sheet').map((el) => ({ el }));
  const draws = new Map<XEl, ModuleDraw>();
  const modules = new Map(kidsOf(kid(sch, 'modules'), 'module').map((m) => [m.attrs.name ?? '', m]));
  if (!modules.size) return { parts, sheets, draws, modules: 0 };
  let auto = 0;
  for (const sh of sheets) for (const n of kidsOf(kid(sh.el, 'nets'), 'net')) { const m = /^N\$(\d+)$/i.exec(n.attrs.name ?? ''); if (m) auto = Math.max(auto, Number(m[1])); }
  const taken = new Set<string>();
  const fileFor = (base: string) => { const b = base.replace(/[\\/:*?"<>|]/g, '-'); let f = `${b}.SchDoc`; for (let k = 2; taken.has(f.toLowerCase()); k++) f = `${b}_${k}.SchDoc`; taken.add(f.toLowerCase()); return f; };
  const expand = (holderSheets: XEl[], prefix: string, depth: number) => {
    if (depth > 8) return;
    for (const sh of holderSheets) for (const mi of kidsOf(kid(sh, 'moduleinsts'), 'moduleinst')) {
      const mod = modules.get(mi.attrs.module ?? '');
      if (!mod) continue;
      const inst = mi.attrs.name ?? 'M';
      const offset = Number(mi.attrs.offset ?? 0) || 0;
      const supplies = new Set<string>();
      const own = partsOf(mod);
      const rename = new Map<string, string>();
      for (const [n, pt] of own) {
        const m = /^(.*?)(\d+)$/.exec(n);
        const nn = offset ? (m ? `${m[1]}${Number(m[2]) + offset}` : `${n}${offset}`) : `${inst}:${n}`;
        rename.set(n, nn);
        parts.set(nn, { ...pt, name: nn });
        const r = resolvePart(doc, pt);
        if (r && isSupply(r)) supplies.add(n);
      }
      // A port's net outside: the net on this sheet wired to the instance's port
      const outer = new Map<string, string>();
      for (const n of kidsOf(kid(sh, 'nets'), 'net')) for (const seg of kidsOf(n, 'segment')) for (const pr of kidsOf(seg, 'portref')) if (pr.attrs.moduleinst === inst) outer.set(pr.attrs.port ?? '', n.attrs.name ?? '');
      const netNames = new Map<string, string>();
      const netName = (n: string, supply: boolean) => {
        let v = netNames.get(n);
        if (v === undefined) {
          v = outer.get(n) ?? (supply ? n : autoNet(n) ? `N$${++auto}` : `${inst}:${n}`);
          netNames.set(n, v);
        }
        return v;
      };
      const modSheets = kidsOf(kid(mod, 'sheets'), 'sheet');
      const files: string[] = [];
      const clones: XEl[] = [];
      modSheets.forEach((ms, k) => {
        const c = cloneEl(ms);
        for (const i of kidsOf(kid(c, 'instances'), 'instance')) i.attrs.part = rename.get(i.attrs.part ?? '') ?? i.attrs.part ?? '';
        for (const n of kidsOf(kid(c, 'nets'), 'net')) {
          const supply = kidsOf(n, 'segment').some((seg) => kidsOf(seg, 'pinref').some((pr) => supplies.has(pr.attrs.part ?? '')));
          n.attrs.name = netName(n.attrs.name ?? '', supply);
          for (const seg of kidsOf(n, 'segment')) {
            for (const pr of kidsOf(seg, 'pinref')) pr.attrs.part = rename.get(pr.attrs.part ?? '') ?? pr.attrs.part ?? '';
            for (const pr of kidsOf(seg, 'portref')) pr.attrs.moduleinst = `${inst}:${pr.attrs.moduleinst ?? ''}`;
          }
        }
        for (const n of kidsOf(kid(c, 'moduleinsts'), 'moduleinst')) n.attrs.name = `${inst}:${n.attrs.name ?? ''}`;
        const file = fileFor(`${stem} ${prefix}${inst}${modSheets.length > 1 ? ` ${k + 1}` : ''}`);
        files.push(file);
        clones.push(c);
        sheets.push({ el: c, file, title: `${mod.attrs.name ?? ''} (${prefix}${inst})` });
      });
      draws.set(mi, { name: inst, module: mod.attrs.name ?? '', x: num(mi, 'x'), y: num(mi, 'y'), dx: num(mod, 'dx'), dy: num(mod, 'dy'), rot: rotOf(mi.attrs.rot),
        ports: kidsOf(kid(mod, 'ports'), 'port').map((p) => ({ name: p.attrs.name ?? '', side: (p.attrs.side ?? 'left').toLowerCase(), coord: num(p, 'coord') })), files });
      expand(clones, `${prefix}${inst}:`, depth + 1);
    }
  };
  expand(sheets.map((x) => x.el), '', 0);
  return { parts, sheets, draws, modules: modules.size };
}

/** EAGLE's own netlist: each net's pins by part and pad ("R1.2"), its sheets' segments joined by name. */
export function eagleSchNetlist(doc: EagleDoc): Map<string, Set<string>> {
  const { parts, sheets } = expandModules(doc, '');
  const out = new Map<string, Set<string>>();
  for (const { el: sheet } of sheets) for (const net of kidsOf(kid(sheet, 'nets'), 'net')) {
    const name = net.attrs.name ?? '';
    const set = out.get(name) ?? new Set<string>();
    for (const seg of kidsOf(net, 'segment')) for (const pr of kidsOf(seg, 'pinref')) {
      const p = parts.get(pr.attrs.part ?? '');
      const r = p ? resolvePart(doc, p) : undefined;
      if (!r || !r.dev.pkg) continue;
      for (const pad of padsOf(r.dev).get(`${pr.attrs.gate ?? ''}\u0000${pr.attrs.pin ?? ''}`) ?? []) set.add(`${p!.name}.${pad}`);
    }
    out.set(name, set);
  }
  return out;
}

export function convertEagleSch(doc: EagleDoc, stem: string, footprintLib = '', names?: (lib: ELib, pkg: string) => string): EagleSchResult {
  const sch = doc.schematic;
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (w: string) => { if (!warned.has(w)) { warned.add(w); warnings.push(w); } };
  if (!sch) return { sheets: [], library: eagleSymbolLibrary([]).bytes, symbols: 0, warnings: ['No schematic in it'], stats: { sheets: 0, parts: 0, nets: 0, symbols: 0 }, footprints: new Map() };
  const ex = expandModules(doc, stem);
  if (ex.modules) warnOnce('Modules (EAGLE 8\'s hierarchy): each instance\'s sheets drawn once for it, its parts named as on the board, its nets its own; the instance a sheet symbol listing them [est]');
  const parts = ex.parts;
  const sheets = ex.sheets.map((x) => x.el);
  const fpName = names ?? footprintNames(doc.libraries);

  // The devices placed, each a library symbol
  const libRefs = new Map<string, LibEntry>();
  const takenRefs = new Set<string>();
  const footprints = new Map<string, { lib: ELib; pkg: string }>();
  const entryOf = (r: Resolved): LibEntry => {
    let e = libRefs.get(r.key);
    if (!e) {
      const base = deviceName(r.ds.name, r.dev.name).replace(/[\\/:*?"<>|]/g, '_') || r.ds.name || 'Part';
      let libRef = base;
      for (let k = 2; takenRefs.has(libRef.toUpperCase()); k++) libRef = `${base}_${k}`;
      takenRefs.add(libRef.toUpperCase());
      const footprint = r.dev.pkg ? fpName(r.lib, r.dev.pkg) : '';
      if (footprint) footprints.set(footprint, { lib: r.lib, pkg: r.dev.pkg });
      e = { libRef, r, footprint };
      libRefs.set(r.key, e);
    }
    return e;
  };

  /* Each net's pieces design-wide, and which carry what names: a piece drawn apart needs its name on it */
  interface SegInfo { sheet: number; net: string; seg: XEl; supply: boolean; labels: number }
  const segs: SegInfo[] = [];
  const supplyPart = new Map<string, boolean>();
  const supplyOf = (partName: string) => {
    let v = supplyPart.get(partName);
    if (v === undefined) { const p = parts.get(partName); const r = p ? resolvePart(doc, p) : undefined; v = !!r && isSupply(r); supplyPart.set(partName, v); }
    return v;
  };
  sheets.forEach((sheet, si) => {
    for (const net of kidsOf(kid(sheet, 'nets'), 'net')) for (const seg of kidsOf(net, 'segment')) {
      segs.push({ sheet: si, net: net.attrs.name ?? '', seg, supply: kidsOf(seg, 'pinref').some((p) => supplyOf(p.attrs.part ?? '')), labels: kidsOf(seg, 'label').length });
    }
  });
  const byNet = new Map<string, SegInfo[]>();
  for (const s of segs) { const l = byNet.get(s.net) ?? []; l.push(s); byNet.set(s.net, l); }
  /** Whether a piece needs a label: its net in more than one piece (or named), the piece no supply symbol to name it. */
  const needsLabel = (s: SegInfo) => {
    const all = byNet.get(s.net)!;
    if (s.labels) return false;
    if (all.length === 1) return !autoNet(s.net) && !s.supply;
    if (!s.supply) return true;
    // A supply piece: one of them gets a label where the net's other pieces have labels and no supply symbol
    const mixed = all.some((x) => !x.supply);
    return mixed && all.find((x) => x.supply) === s;
  };

  const out: { name: string; bytes: Uint8Array }[] = [];
  const netNames = new Set<string>();
  const placedParts = new Set<string>();
  // EAGLE's implicit supply: a power pin no net names joins the net of its own name (placed, a label at it; in a gate never placed, a hidden pin)
  const pinrefd = new Set<string>();
  const placedGates = new Map<string, Set<string>>();
  for (const sheet of sheets) {
    for (const net of kidsOf(kid(sheet, 'nets'), 'net')) for (const seg of kidsOf(net, 'segment')) for (const pr of kidsOf(seg, 'pinref')) pinrefd.add(`${pr.attrs.part ?? ''}\u0000${pr.attrs.gate ?? ''}\u0000${pr.attrs.pin ?? ''}`);
    for (const inst of kidsOf(kid(sheet, 'instances'), 'instance')) { const k = inst.attrs.part ?? ''; if (!placedGates.has(k)) placedGates.set(k, new Set()); placedGates.get(k)!.add(inst.attrs.gate ?? ''); }
  }
  const hiddenDone = new Set<string>();
  sheets.forEach((sheet, si) => {
    const rr = new Records(), fonts = new Fonts();
    rr.bags.push(PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: 0 }));
    const sheetIndex = rr.bags.length;
    rr.bags.push(PropertyBag.from({ RECORD: SR.SHEET }));
    const top = (props: Props, coords?: Record<string, Pt>) => rr.add({ ...props, OWNERPARTID: -1 }, coords);
    const plain = kid(sheet, 'plain');
    const instances = kidsOf(kid(sheet, 'instances'), 'instance');

    /* Where everything is (mm): the sheet 0.5 inch round it, on EAGLE's 0.1 inch grid */
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const see = (x: number, y: number) => { if (!Number.isFinite(x) || !Number.isFinite(y)) return; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
    const seeAll = (e: XEl, pl: Placer = IDENTITY) => {
      for (const c of e.children) {
        if (c.name === 'wire' || c.name === 'rectangle' || c.name === 'frame') { const a = pl.pt({ x: num(c, 'x1'), y: num(c, 'y1') }), b = pl.pt({ x: num(c, 'x2'), y: num(c, 'y2') }); see(a.x, a.y); see(b.x, b.y); }
        else if (c.name === 'circle') { const p = pl.pt({ x: num(c, 'x'), y: num(c, 'y') }), r = num(c, 'radius'); see(p.x - r, p.y - r); see(p.x + r, p.y + r); }
        else if (c.name === 'text' || c.name === 'pin' || c.name === 'junction' || c.name === 'label' || c.name === 'attribute') { const p = pl.pt({ x: num(c, 'x'), y: num(c, 'y') }); see(p.x, p.y); }
        else if (c.name === 'polygon') for (const v of kidsOf(c, 'vertex')) { const p = pl.pt({ x: num(v, 'x'), y: num(v, 'y') }); see(p.x, p.y); }
        else if (c.name === 'segment') seeAll(c, pl);
      }
    };
    if (plain) seeAll(plain);
    for (const inst of instances) {
      const p = parts.get(inst.attrs.part ?? '');
      const r = p ? resolvePart(doc, p) : undefined;
      const g = r?.ds.gates.find((x) => x.name === inst.attrs.gate);
      const sym = g ? r!.lib.symbols.get(g.symbol) : undefined;
      const pl = placer(num(inst, 'x'), num(inst, 'y'), rotOf(inst.attrs.rot));
      see(num(inst, 'x'), num(inst, 'y'));
      if (sym) seeAll(sym, pl);
      seeAll(inst);
    }
    for (const n of [...kidsOf(kid(sheet, 'nets'), 'net'), ...kidsOf(kid(sheet, 'busses'), 'bus')]) seeAll(n);
    for (const mi of kidsOf(kid(sheet, 'moduleinsts'), 'moduleinst')) {
      const d = ex.draws.get(mi);
      if (!d) continue;
      const pl = placer(d.x, d.y, d.rot);
      for (const q of [{ x: -d.dx / 2, y: -d.dy / 2 }, { x: d.dx / 2, y: d.dy / 2 }]) { const t = pl.pt(q); see(t.x, t.y); }
    }
    if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = 254; y1 = 203.2; }
    const gx = Math.floor(x0 / 2.54) * 2.54, gy = Math.floor(y0 / 2.54) * 2.54;
    const M = 50;
    // A sheet with no frame of EAGLE's gets AD's border and title block: room under the drawing for the block
    const willFrame = kidsOf(plain, 'frame').length > 0 || instances.some((inst) => {
      const p = parts.get(inst.attrs.part ?? ''), r = p ? resolvePart(doc, p) : undefined;
      const g = r?.ds.gates.find((x) => x.name === inst.attrs.gate), sym = g ? r!.lib.symbols.get(g.symbol) : undefined;
      return !!r && isDrawing(r) && (kidsOf(sym, 'frame').length > 0 || /frame|ledger|title.?block/i.test(`${r.ds.name} ${g?.symbol ?? ''}`));
    });
    const TB = willFrame ? 0 : 90;
    const P = (q: Pt): Pt => ({ x: Math.round((U(q.x - gx) + M) * 1000) / 1000, y: Math.round((U(q.y - gy) + M + TB) * 1000) / 1000 });
    const ctx: DrawCtx = { rr, fonts, P, warn: warnOnce };
    let framed = false;
    const sheetValue = (k: string): string | undefined => ({
      SHEET: `${si + 1}/${sheets.length}`, SHEETS: String(sheets.length), SHEETNR: String(si + 1), DRAWING_NAME: stem,
      // The dates as AD's special strings (EAGLE's are the file's last save and the print's)
      LAST_DATE_TIME: "=CurrentDate+' '+CurrentTime", PLOT_DATE_TIME: "=CurrentDate+' '+CurrentTime", DATE: '=CurrentDate', SHEET_HEADLINE: (kid(sheet, 'description')?.text ?? '').trim(),
    } as Record<string, string>)[k];

    /* ── parts ── */
    const implicit: { name: string; at: Pt }[] = [];
    const pinAt = new Map<string, Pt>();   // "part\0gate\0pin" → where it connects (AD units)
    const supplyAt = new Map<string, { at: Pt; orient: number }>();
    for (const inst of instances) {
      const p = parts.get(inst.attrs.part ?? '');
      const r = p ? resolvePart(doc, p) : undefined;
      if (!p || !r) { warnOnce('Parts whose device is missing from the file\'s libraries left out'); continue; }
      const gi = r.ds.gates.findIndex((x) => x.name === inst.attrs.gate);
      const g = r.ds.gates[gi];
      const sym = g ? r.lib.symbols.get(g.symbol) : undefined;
      if (!g || !sym) { warnOnce('Gates whose symbol is missing left out'); continue; }
      const rot = rotOf(inst.attrs.rot);
      if (rot.angle % 90) warnOnce('Parts turned other than by quarter turns: drawn as turned, their pins to the nearest quarter');
      const pl = placer(num(inst, 'x'), num(inst, 'y'), rot);
      const tech = r.dev.technologies.get(p.technology) ?? r.dev.technologies.get('') ?? new Map<string, string>();
      const value = p.value ?? deviceName(r.ds.name, r.dev.name, p.technology);
      const multi = r.ds.gates.length > 1;
      const attr = (k: string): string | undefined => {
        const K = k.toUpperCase();
        if (K === 'NAME') return multi ? `${p.name}${g.name.startsWith('G$') ? '' : g.name}` : p.name;
        if (K === 'VALUE') return value;
        if (K === 'PART') return p.name;
        if (K === 'GATE') return g.name;
        for (const [a, v] of p.attrs) if (a.toUpperCase() === K) return v;
        for (const [a, v] of tech) if (a.toUpperCase() === K) return v;
        return sheetValue(K);
      };
      const smashed = new Map(kidsOf(inst, 'attribute').map((a) => [(a.attrs.name ?? '').toUpperCase(), a]));
      const smashedOn = (inst.attrs.smashed ?? 'no') === 'yes';
      // Placeholders the part shows itself (smashed) are drawn as its own fields
      const fieldKeys = new Set(['NAME', 'VALUE']);

      // A supply symbol: a power port at its pin, pointing the way its drawing lies
      if (isSupply(r)) {
        const pin = pinsOf(sym)[0]!;
        const hot = P(pl.pt({ x: num(pin, 'x'), y: num(pin, 'y') }));
        const orient = quarter(pl.dir(rotOf(pin.attrs.rot).angle));
        supplyAt.set(`${p.name}\u0000${g.name}\u0000${pin.attrs.name ?? ''}`, { at: hot, orient });
        pinAt.set(`${p.name}\u0000${g.name}\u0000${pin.attrs.name ?? ''}`, hot);
        continue;
      }
      // A frame, a logo: drawn as it is
      if (isDrawing(r)) {
        // A frame drawn (EAGLE's frame object, or a title block's device): AD's own border off
        if (kidsOf(sym, 'frame').length || /frame|ledger|title.?block/i.test(`${r.ds.name} ${g.symbol}`)) framed = true;
        drawGraphics(ctx, sym, pl, { OWNERPARTID: -1 }, (k) => (smashedOn && smashed.has(k) ? undefined : attr(k)), (k) => smashedOn && smashed.has(k));
        for (const [k, a] of smashed) {
          if ((a.attrs.display ?? 'value') === 'off') continue;
          const v = attr(k);
          if (v) textRecords(ctx, { OWNERPARTID: -1 }, v, { x: num(a, 'x'), y: num(a, 'y') }, rotOf(a.attrs.rot), a, COL.text);
        }
        continue;
      }
      const entry = entryOf(r);
      const ci = top({ RECORD: SR.COMPONENT, LIBREFERENCE: entry.libRef, PARTCOUNT: r.ds.gates.length + 1, DISPLAYMODECOUNT: 1, CURRENTPARTID: gi + 1, ORIENTATION: quarter(rot.mirror ? -rot.angle : rot.angle), ISMIRRORED: rot.mirror || undefined,
        AREACOLOR: COL.fill, COLOR: COL.body, DESIGNITEMID: entry.libRef, SOURCELIBRARYNAME: `${stem}.SchLib`, COMPONENTDESCRIPTION: stripHtml(r.ds.description) || undefined,
        UNIQUEID: uniqueIdFor(`eagle:${stem}:${p.name}`), ...(r.dev.pkg ? {} : { COMPONENTKIND: 2 }) }, { LOCATION: P(pl.pt({ x: 0, y: 0 })) });
      const own: Props = { OWNERINDEX: ci - 1, OWNERPARTID: gi + 1 };
      drawGraphics(ctx, sym, pl, own, (k) => (fieldKeys.has(k) || (smashedOn && smashed.has(k)) ? undefined : attr(k)), (k) => fieldKeys.has(k) || (smashedOn && smashed.has(k)));
      ctx.unconnected = (gate, pin) => !pinrefd.has(`${p.name}\u0000${gate}\u0000${pin}`);
      for (const q of drawPins(ctx, sym, g.name, r.dev.pkg ? padsOf(r.dev) : undefined, pl, own)) {
        const key = `${p.name}\u0000${g.name}\u0000${q.pin}`;
        pinAt.set(key, q.at);
        if (q.direction === 'pwr' && !pinrefd.has(key)) { implicit.push({ name: pinShown(q.pin), at: q.at }); warnOnce('Power pins on no net joined to the net of their name, as EAGLE joins them (a net label at each)'); }
      }
      // The device's other gates under it too, as AD keeps every part of a package in each of its parts (only the current one shown)
      ctx.unconnected = undefined;
      r.ds.gates.forEach((og, j) => {
        if (j === gi) return;
        const osym = r.lib.symbols.get(og.symbol);
        if (!osym) return;
        const oown: Props = { OWNERINDEX: ci - 1, OWNERPARTID: j + 1 };
        drawGraphics(ctx, osym, pl, oown, () => undefined, () => true);
        drawPins(ctx, osym, og.name, r.dev.pkg ? padsOf(r.dev) : undefined, pl, oown);
      });
      if (!hiddenDone.has(p.name) && r.dev.pkg) {
        hiddenDone.add(p.name);
        const pads = padsOf(r.dev);
        for (const og of r.ds.gates) {
          if (placedGates.get(p.name)?.has(og.name)) continue;
          for (const pin of pinsOf(r.lib.symbols.get(og.symbol))) {
            if ((pin.attrs.direction ?? 'io') !== 'pwr') continue;
            const nm = pinShown(pin.attrs.name ?? '');
            for (const des of pads.get(`${og.name}\u0000${pin.attrs.name ?? ''}`) ?? []) {
              rr.add({ RECORD: SR.PIN, OWNERINDEX: ci - 1, OWNERPARTID: 0, ELECTRICAL: 7, PINCONGLOMERATE: 0x04, PINLENGTH: 0, NAME: overbar(nm), DESIGNATOR: des, HIDDENNETNAME: nm, COLOR: COL.pin }, { LOCATION: P(pl.pt({ x: 0, y: 0 })) });
            }
            warnOnce('Power pins of gates not placed joined to the net of their name, as EAGLE joins them (hidden pins)');
          }
        }
      }
      // Its fields where it shows them: smashed, the part's own; else the symbol's placeholder
      const symText = (k: string) => kidsOf(sym, 'text').find((t) => (t.text ?? '').trim().toUpperCase() === `>${k}`);
      const field = (rec: number, name: string, text: string, k: string) => {
        const a = smashedOn ? smashed.get(k) : undefined;
        const t = a ?? symText(k);
        const shown = !!t && (a ? (a.attrs.display ?? 'value') !== 'off' : true);
        const look = t ? textLook(a ? rotOf(t.attrs.rot) : pl.frame(rotOf(t.attrs.rot)), t.attrs.align) : { ORIENTATION: 0, JUSTIFICATION: 0 };
        const at = t ? (a ? { x: num(t, 'x'), y: num(t, 'y') } : pl.pt({ x: num(t, 'x'), y: num(t, 'y') })) : pl.pt({ x: 0, y: 0 });
        rr.add({ RECORD: rec, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: name, TEXT: text, FONTID: t ? fonts.id(num(t, 'size', 1.778)) : 1, COLOR: COL.text, ...look, ISHIDDEN: shown ? undefined : true }, { LOCATION: P(at) });
      };
      field(SR.DESIGNATOR, 'Designator', p.name, 'NAME');
      field(SR.PARAMETER, 'Comment', value, 'VALUE');
      // The device's and part's attributes as parameters, shown where the part shows them
      const keys = new Map<string, string>();
      for (const [k, v] of tech) keys.set(k, v);
      for (const [k, v] of p.attrs) keys.set(k, v);
      for (const [k, v] of keys) {
        if (/^(NAME|VALUE|PART|GATE)$/i.test(k) || !v) continue;
        const a = smashedOn ? smashed.get(k.toUpperCase()) : undefined;
        const t = a ?? (symText(k.toUpperCase()));
        if (t && !a && (smashedOn && smashed.has(k.toUpperCase()))) continue;
        const shown = !!t && (a ? (a.attrs.display ?? 'value') !== 'off' : true);
        const at = t ? (a ? { x: num(t, 'x'), y: num(t, 'y') } : pl.pt({ x: num(t, 'x'), y: num(t, 'y') })) : pl.pt({ x: 0, y: 0 });
        const look = t ? textLook(a ? rotOf(t.attrs.rot) : pl.frame(rotOf(t.attrs.rot)), t.attrs.align) : { ORIENTATION: 0, JUSTIFICATION: 0 };
        rr.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci - 1, OWNERPARTID: -1, NAME: k, TEXT: v, FONTID: t ? fonts.id(num(t, 'size', 1.778)) : 1, COLOR: COL.text, ...look, ISHIDDEN: shown ? undefined : true }, { LOCATION: P(at) });
      }
      if (entry.footprint) {
        const list = rr.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci - 1, OWNERPARTID: -1 });
        const impl = rr.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list - 1, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: '', MODELNAME: entry.footprint, MODELTYPE: 'PCBLIB',
          DATAFILECOUNT: 1, MODELDATAFILEENTITY0: entry.footprint, MODELDATAFILEKIND0: 'PCBLib', MODELDATAFILE0: footprintLib, ISCURRENT: true, UNIQUEID: uniqueId() });
        rr.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
        rr.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl - 1, OWNERPARTID: -1 });
      }
      placedParts.add(p.name);
    }

    /* ── nets: wires, junctions, labels; supply symbols as power ports ── */
    const label = (name: string, at: Pt, orient: number, size?: number) => { top({ RECORD: SR.NET_LABEL, TEXT: name, FONTID: size ? fonts.id(size) : 1, COLOR: COL.wire, ORIENTATION: orient, UNIQUEID: uniqueId() }, { LOCATION: at }); };
    const drawSegment = (seg: XEl, name: string, bus: boolean, info?: SegInfo) => {
      const lines: Pt[][] = [];
      for (const w of kidsOf(seg, 'wire')) {
        const a = { x: num(w, 'x1'), y: num(w, 'y1') }, b = { x: num(w, 'x2'), y: num(w, 'y2') };
        const pts = (num(w, 'curve') ? curvePoints(a, b, num(w, 'curve')) : [a, b]).map(P);
        lines.push(pts);
        if (bus) rr.points({ RECORD: SR.BUS, OWNERPARTID: -1, LINEWIDTH: 2, COLOR: COL.bus }, pts);
        else rr.points({ RECORD: SR.WIRE, OWNERPARTID: -1, LINEWIDTH: 1, COLOR: COL.wire, UNIQUEID: uniqueId() }, pts);
      }
      for (const j of kidsOf(seg, 'junction')) top({ RECORD: SR.JUNCTION, COLOR: COL.wire }, { LOCATION: P({ x: num(j, 'x'), y: num(j, 'y') }) });
      const pins = kidsOf(seg, 'pinref').map((pr) => ({ key: `${pr.attrs.part ?? ''}\u0000${pr.attrs.gate ?? ''}\u0000${pr.attrs.pin ?? ''}` }));
      // Its supply symbols: power ports named by the net
      for (const { key } of pins) {
        const sp = supplyAt.get(key);
        if (!sp) continue;
        const nm = name;
        const ground = /gnd|ground|vss|earth/i.test(nm);
        const style = /earth|chassis|\bpe\b/i.test(nm) ? 6 : /agnd|signal/i.test(nm) ? 5 : ground ? 4 : 2;
        top({ RECORD: SR.POWER_PORT, STYLE: style, ORIENTATION: sp.orient, TEXT: nm, SHOWNETNAME: true, COLOR: COL.power, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: sp.at });
      }
      for (const l of kidsOf(seg, 'label')) {
        const at0 = P({ x: num(l, 'x'), y: num(l, 'y') });
        const at = lines.length ? nearestOn(at0, lines) : at0;
        label(name, at, labelOrient(rotOf(l.attrs.rot)), num(l, 'size', 1.778));
      }
      if (info && needsLabel(info)) {
        // Where the piece is: a supply symbol's pin, else its first wire's start, else a pin's end
        const sp = pins.map((q) => supplyAt.get(q.key)).find(Boolean);
        const at = (info.supply && sp ? sp.at : undefined) ?? lines[0]?.[0] ?? pins.map((q) => pinAt.get(q.key)).find(Boolean);
        if (at) label(name, at, sp && info.supply ? (sp.orient % 2 ? 0 : 1) : 0);
        else warnOnce('Net pieces with nothing drawn left unlabelled');
      }
      if (!autoNet(name)) netNames.add(name);
    };
    for (const net of kidsOf(kid(sheet, 'nets'), 'net')) {
      for (const seg of kidsOf(net, 'segment')) {
        const info = segs.find((s) => s.seg === seg);
        drawSegment(seg, net.attrs.name ?? '', false, info);
      }
    }
    for (const q of implicit) label(q.name, q.at, 0);
    for (const bus of kidsOf(kid(sheet, 'busses'), 'bus')) for (const seg of kidsOf(bus, 'segment')) drawSegment(seg, bus.attrs.name ?? '', true);
    // Module instances: a sheet symbol over the frame, listing the instance's sheets, its ports named on its edges
    for (const mi of kidsOf(kid(sheet, 'moduleinsts'), 'moduleinst')) {
      const d = ex.draws.get(mi);
      if (!d) { warnOnce('Module instances whose module is missing left out'); continue; }
      const pl = placer(d.x, d.y, d.rot);
      const c1 = P(pl.pt({ x: -d.dx / 2, y: -d.dy / 2 })), c2 = P(pl.pt({ x: d.dx / 2, y: d.dy / 2 }));
      const xa = Math.min(c1.x, c2.x), xb = Math.max(c1.x, c2.x), ya = Math.min(c1.y, c2.y), yb = Math.max(c1.y, c2.y);
      const sym = top({ RECORD: SR.SHEET_SYMBOL, XSIZE: Math.max(1, Math.round(xb - xa)), YSIZE: Math.max(1, Math.round(yb - ya)), LINEWIDTH: 1, COLOR: COL.sheet, AREACOLOR: COL.sheetFill, ISSOLID: true,
        UNIQUEID: uniqueIdFor(`eagle:${stem}:module:${si}:${mi.attrs.name ?? ''}`) }, { LOCATION: { x: xa, y: yb } });
      top({ RECORD: SR.SHEET_NAME, OWNERINDEX: sym - 1, TEXT: d.name, FONTID: 1, COLOR: COL.text }, { LOCATION: { x: xa, y: yb + 2 } });
      top({ RECORD: SR.FILE_NAME, OWNERINDEX: sym - 1, TEXT: d.files.join(';'), FONTID: 1, COLOR: COL.text }, { LOCATION: { x: xa, y: ya - 10 } });
      for (const pt of d.ports) {
        const q = pt.side === 'right' ? { x: d.dx / 2, y: pt.coord } : pt.side === 'top' ? { x: pt.coord, y: d.dy / 2 } : pt.side === 'bottom' ? { x: pt.coord, y: -d.dy / 2 } : { x: -d.dx / 2, y: pt.coord };
        const at = P(pl.pt(q));
        const right = Math.abs(at.x - xb) < 0.5, left = Math.abs(at.x - xa) < 0.5;
        top({ RECORD: SR.LABEL, TEXT: overbar(pt.name), FONTID: 1, COLOR: COL.sheet, ...(right ? { JUSTIFICATION: 5 } : left ? { JUSTIFICATION: 3 } : { ORIENTATION: 1, JUSTIFICATION: Math.abs(at.y - yb) < 0.5 ? 5 : 3 }) },
          { LOCATION: { x: at.x + (right ? -3 : left ? 3 : 0), y: at.y + (right || left ? 0 : Math.abs(at.y - yb) < 0.5 ? -3 : 3) } });
      }
    }

    /* ── the sheet's own drawing ── */
    if (plain) {
      if (kidsOf(plain, 'frame').length) framed = true;
      drawGraphics(ctx, plain, IDENTITY, { OWNERPARTID: -1 }, (k) => sheetValue(k));
    }

    /* ── the sheet record: as large as what's on it, AD's border and title block off where the sheet has EAGLE's frame ── */
    const W = Math.max(framed ? 0 : 450, Math.ceil((U(x1 - gx) + 2 * M) / 10) * 10), H = Math.ceil((U(y1 - gy) + 2 * M + TB) / 10) * 10;
    rr.bags[sheetIndex] = PropertyBag.from({ RECORD: SR.SHEET, ...fonts.keys(), USEMBCS: true, ISBOC: true, SHEETSTYLE: 0, USECUSTOMSHEET: true,
      CUSTOMX: W, CUSTOMY: H, CUSTOMXZONES: Math.max(4, Math.round(W / 250)), CUSTOMYZONES: Math.max(4, Math.round(H / 250)), CUSTOMMARGINWIDTH: 20,
      BORDERON: !framed, TITLEBLOCKON: !framed, AREACOLOR: toBgr(0xffffff),
      SNAPGRIDON: true, SNAPGRIDSIZE: 5, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 2, SYSTEMFONT: 1, DOCUMENTBORDERSTYLE: 0 } as Record<string, string | number | boolean>);
    rr.bags[0]!.setRaw('WEIGHT', String(rr.bags.length - 1));
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'FileHeader', joinSchRecords(rr.bags.map((bag) => ({ kind: 0, data: bag.toBytes(), bag }))));
    cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
    const own = ex.sheets[si]!.file, tops = ex.sheets.filter((x) => !x.file).length;
    out.push({ name: own ?? (tops === 1 ? `${stem}.SchDoc` : `${stem}_${si + 1}.SchDoc`), bytes: writeCfb(root) });
  });
  if (!out.length) warnings.push('No sheets in it');
  const lib = eagleSymbolLibrary([...libRefs.values()], footprintLib);
  return { sheets: out, library: lib.bytes, symbols: lib.count, warnings: [...warnings, ...lib.warnings.filter((w) => !warned.has(w))], stats: { sheets: out.length, parts: placedParts.size, nets: netNames.size, symbols: lib.count }, footprints };
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
