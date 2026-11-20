/**
 * File › Fabrication Outputs › Gerber Files: RS-274X, one file per layer with Altium's
 * extensions (.GTL, .GBL, .GTO, .GTS, .GTP, .GKO, .GM1 …), embedded apertures, coordinates
 * relative to the board origin by default, plus the .EXTREP extension report and a .REP
 * summary, as Altium writes them.
 *
 * What is plotted: tracks, arcs, fills, regions (pours with their holes), pads by stack layer,
 * vias on every copper layer they span, stroke text (TrueType text falls back to the stroke
 * font); solder mask and paste openings from pads and vias, expanded by the board's Solder
 * Mask / Paste Mask Expansion rules.
 */
import { locale } from '../../core/locale';
import { padLayer, padShapeOn, viaDiameterOn } from '../../model/padStack';
import { barcodeShape } from '../../model/barcode';
import type { Vec2 } from '../../core/geom';
import { arcPoints, pointInPoly, rotate } from '../../core/geom';
import { L, isPlane, isSignal, layerColour, layerName, type LayerId } from '../../model/layers';
import { planeCopper } from '../../model/planes';
import { NO_NET, copperNet, type PadStackLayer, type PcbDocument, type PcbPad, type PcbPrim } from '../../model/pcb';
import { ruleFor } from '../../model/drc';
import { ruleLength } from '../altium/rules';
import { FLAG, PAD, VIA, get } from '../altium/pcbLayouts';
import { strokeCapHeight, strokeText, strokeTextWidth } from './stroke';
import { holeFree } from './holeFree';
import { parseLength } from '../../core/units';
import { dimensionEdges, dimensionGeometry, geometryStrokes, type DimEdge, type PcbDimension } from '../../model/dimensions';
import { defaultDrillSymbols, drawDrillGuide, drawDrillSymbols, type DrillSymbols } from './drillDrawing';
import { coverlayAreas, coverlayLayers, underCoverlay, type CoverlayLayer } from '../../model/coverlay';
import { padExtrasOf } from '../altium/primInfo';

export type Units = 'in' | 'mm';

export interface GerberSetup {
  units: Units;
  /** Integer and decimal digits: 2:3, 2:4, 2:5 (inches) or 4:2, 4:3, 4:4 (mm). */
  intDigits: number;
  decDigits: number;
  /** Zeros left out of coordinates ('none' keeps both). */
  zeros: 'leading' | 'trailing' | 'none';
  /** Coordinates from the board's relative origin (Altium's default) or the absolute origin. */
  relative: boolean;
  layers: { layer: LayerId; plot: boolean; mirror: boolean }[];
  /** Add the board shape to Mechanical 1 (.GM1), where the outline usually lives. */
  outlineOnMech1: boolean;
  /** Include unconnected mid-layer pads: off (AD's default), a through pad or via on an inner signal layer is plotted there only where copper of its net meets it. */
  unconnectedMidPads?: boolean;
  /**
   * Embedded apertures (RS274X): on (AD's default). Off: RS-274-D files, no format or aperture
   * definitions in them, the D-codes shared by every file of the run and listed in <board>.APR
   * [est: the list's form].
   */
  embedded?: boolean;
  /** Drill Drawing tab: Plot all used drill pairs for the drill drawing (.GD1) and drill guide (.GG1), mirrored or not, and the symbols. */
  drillDrawing: boolean;
  drillGuide: boolean;
  mirrorDrillDrawing: boolean;
  mirrorDrillGuide: boolean;
  drill: DrillSymbols;
}

/** An output file: text, or bytes (a spreadsheet) when given. */
export interface OutputFile { name: string; text: string; bytes?: Uint8Array }

const UNITS_PER_INCH = 10_000_000;
const toUnit = (c: number, u: Units) => (u === 'in' ? c / UNITS_PER_INCH : (c * 25.4) / UNITS_PER_INCH);

/** Altium's Gerber extension for each layer. */
export function gerberExtension(l: LayerId): string {
  if (l === L.TOP) return 'GTL';
  if (l === L.BOTTOM) return 'GBL';
  if (l > L.TOP && l < L.BOTTOM) return `G${l - 1}`;
  if (l >= L.PLANE1 && l <= L.PLANE16) return `GP${l - L.PLANE1 + 1}`;
  if (l >= L.MECH1 && l <= L.MECH16) return `GM${l - L.MECH1 + 1}`;
  switch (l) {
    case L.TOP_OVERLAY: return 'GTO';
    case L.BOTTOM_OVERLAY: return 'GBO';
    case L.TOP_PASTE: return 'GTP';
    case L.BOTTOM_PASTE: return 'GBP';
    case L.TOP_SOLDER: return 'GTS';
    case L.BOTTOM_SOLDER: return 'GBS';
    case L.KEEPOUT: return 'GKO';
    case L.DRILL_GUIDE: return 'GG1';
    case L.DRILL_DRAWING: return 'GD1';
    default: return `G${l}`;
  }
}

const isCopper = (l: LayerId) => l >= L.TOP && l <= L.BOTTOM;
const MASKS: LayerId[] = [L.TOP_SOLDER, L.BOTTOM_SOLDER];
const PASTES: LayerId[] = [L.TOP_PASTE, L.BOTTOM_PASTE];

/** Layers worth offering in the Layers tab: copper stack, overlays, masks, pastes, keep-out, used mechanicals. */
export function plottableLayers(doc: PcbDocument): LayerId[] {
  const used = new Set<LayerId>();
  for (const p of doc.prims) if ('layer' in p && p.kind !== 'body') used.add(p.layer); // 3D bodies don't plot
  const out: LayerId[] = [...doc.board.copperStack, L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP_PASTE, L.BOTTOM_PASTE, L.TOP_SOLDER, L.BOTTOM_SOLDER, L.KEEPOUT];
  for (let m = L.MECH1; m <= L.MECH16; m++) if (used.has(m) || (m === L.MECH1)) out.push(m);
  return out;
}

export function defaultGerberSetup(doc: PcbDocument): GerberSetup {
  const used = new Set<LayerId>();
  for (const p of doc.prims) if ('layer' in p && p.kind !== 'body') used.add(p.layer); // 3D bodies don't plot
  return {
    units: 'in', intDigits: 2, decDigits: 5, zeros: 'leading', relative: true, outlineOnMech1: true, unconnectedMidPads: false,
    drillDrawing: false, drillGuide: false, mirrorDrillDrawing: false, mirrorDrillGuide: false, drill: defaultDrillSymbols(),
    layers: plottableLayers(doc).map((layer) => ({ layer, mirror: false,
      plot: isCopper(layer) || isPlane(layer) || MASKS.includes(layer) || PASTES.includes(layer) || used.has(layer) || layer === L.MECH1 })),
  };
}

/* ─── Plot builder ───────────────────────────────────────────────────────────────────── */

/**
 * What a layer is drawn onto: a Gerber plot, or a print (outputs/printouts.ts). Lengths in board
 * units; arcs counter-clockwise in degrees.
 */
export interface PlotSink {
  line(a: Vec2, b: Vec2, width: number): void;
  polyline(pts: Vec2[], width: number): void;
  arc(c: Vec2, r: number, start: number, end: number, width: number): void;
  dot(at: Vec2, dia: number): void;
  pad(at: Vec2, st: PadStackLayer, rotation: number, grow?: number): void;
  /** A filled outline with holes left open. */
  regionHoles(outline: Vec2[], holes: Vec2[][]): void;
  /** `clear`: cut out of what is drawn before it (a barcode's words in its inverted box). */
  region(contours: Vec2[][], clear?: boolean): void;
  /** What the next objects are (Gerber X2 attributes, IPC-2581 and ODB++ nets); sinks that don't care leave it out. */
  begin?(m: PlotMeta | null): void;
}

/** Gerber X2's view of an object: its aperture function and the net, pin and component it belongs to. */
export interface PlotMeta { fn?: string; net?: string; pin?: [refdes: string, pin: string]; comp?: string; prim?: PcbPrim }

/** The X2 attributes of a primitive drawn on a layer. */
export function metaFor(doc: PcbDocument, p: PcbPrim, layer: LayerId): PlotMeta {
  const copper = isCopper(layer) || layer === L.MULTI, opening = MASKS.includes(layer) || PASTES.includes(layer);
  const net = 'net' in p && p.net !== NO_NET ? doc.nets[p.net]?.name : undefined;
  const comp = 'component' in p && p.component !== NO_NET ? doc.components[p.component]?.designator : undefined;
  switch (p.kind) {
    case 'pad': {
      if (!copper && !opening) return { prim: p };
      const fn = p.layer === L.MULTI ? 'ComponentPad' : 'SMDPad,CuDef';
      return { fn, net: copper ? net ?? 'N/C' : undefined, pin: comp && copper ? [comp, p.name] : undefined, comp: copper ? comp : undefined, prim: p };
    }
    case 'via': return copper || opening ? { fn: 'ViaPad', net: copper ? net ?? '' : undefined, prim: p } : { prim: p };
    case 'track': case 'arc': case 'region': case 'fill':
      return copper ? { fn: 'Conductor', net: net ?? '', comp, prim: p } : { prim: p };
    case 'text': return copper ? { fn: 'NonConductor', prim: p } : { prim: p };
    default: return { prim: p };
  }
}

/** An X2 attribute value: , * % and \ escaped as \uXXXX. */
export const x2Value = (v: string) => v.replace(/[,*%\\]/g, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);

/** RS-274-D: the D-codes every file of a run shares. */
export interface ApertureList { codes: Map<string, number>; defs: { d: number; def: string }[] }

export class Plot implements PlotSink {
  private apertures = new Map<string, number>();
  private defs: string[] = [];
  private macros = new Set<string>();
  private body: string[] = [];
  private current = -1;
  private at: Vec2 | null = null;
  /** Gerber X2: the aperture function of what is drawn next, and its object attributes as written. */
  private fn: string | undefined;
  private obj = '';
  constructor(private s: GerberSetup, private origin: Vec2, private mirror: boolean, private x2 = false, private shared?: ApertureList) {}

  begin(m: PlotMeta | null): void {
    if (!this.x2) return;
    this.fn = m?.fn;
    const lines: string[] = [];
    if (m?.net !== undefined) lines.push(`%TO.N,${x2Value(m.net)}*%`);
    if (m?.pin) lines.push(`%TO.P,${x2Value(m.pin[0])},${x2Value(m.pin[1])}*%`);
    if (m?.comp) lines.push(`%TO.C,${x2Value(m.comp)}*%`);
    const o = lines.join('\n');
    if (o !== this.obj) { if (this.obj) this.body.push('%TD*%'); if (o) this.body.push(o); this.obj = o; }
  }

  private num(c: number): string {
    const v = Math.round(toUnit(c, this.s.units) * 10 ** this.s.decDigits);
    if (this.s.zeros === 'leading') return String(v);
    if (this.s.zeros === 'none') return (v < 0 ? '-' : '') + String(Math.abs(v)).padStart(this.s.intDigits + this.s.decDigits, '0');
    const neg = v < 0, digits = String(Math.abs(v)).padStart(this.s.intDigits + this.s.decDigits, '0').replace(/0+$/, '') || '0';
    return (neg ? '-' : '') + digits;
  }
  private xy(p: Vec2): string {
    const x = (p.x - this.origin.x) * (this.mirror ? -1 : 1), y = p.y - this.origin.y;
    return `X${this.num(x)}Y${this.num(y)}`;
  }
  private size = (c: number) => toUnit(c, this.s.units).toFixed(this.s.units === 'in' ? 5 : 4);

  private use(key0: string, def: string): void {
    // RS-274-D: the run's D-codes, defined in its aperture list
    if (this.shared) {
      let d = this.shared.codes.get(key0);
      if (d === undefined) { d = 10 + this.shared.defs.length; this.shared.codes.set(key0, d); this.shared.defs.push({ d, def }); }
      if (d !== this.current) { this.body.push(`D${d}*`); this.current = d; }
      return;
    }
    // X2: an aperture per function (its attribute is set where it is defined)
    const key = this.x2 ? `${this.fn ?? ''}|${key0}` : key0;
    let d = this.apertures.get(key);
    if (d === undefined) {
      d = 10 + this.apertures.size; this.apertures.set(key, d);
      if (this.x2 && this.fn) this.defs.push(`%TA.AperFunction,${this.fn}*%`, `%ADD${d}${def}*%`, '%TD.AperFunction*%');
      else this.defs.push(`%ADD${d}${def}*%`);
    }
    if (d !== this.current) { this.body.push(`D${d}*`); this.current = d; }
  }
  circle(dia: number): void { const w = this.size(Math.max(dia, 1)); this.use(`C${w}`, `C,${w}`); }

  line(a: Vec2, b: Vec2, width: number): void {
    this.circle(width);
    if (!this.at || this.at.x !== a.x || this.at.y !== a.y) this.body.push(`${this.xy(a)}D02*`);
    this.body.push(`${this.xy(b)}D01*`);
    this.at = b;
  }
  polyline(pts: Vec2[], width: number): void { for (let i = 1; i < pts.length; i++) this.line(pts[i - 1]!, pts[i]!, width); }

  /** Counter-clockwise arc (degrees), drawn with G75 circular interpolation. */
  arc(c: Vec2, r: number, start: number, end: number, width: number): void {
    this.circle(width);
    const sweep = ((end - start) % 360 + 360) % 360 || 360;
    const pt = (deg: number) => ({ x: c.x + r * Math.cos((deg * Math.PI) / 180), y: c.y + r * Math.sin((deg * Math.PI) / 180) });
    const a = pt(start), b = pt(start + sweep);
    const ra = { x: Math.round(a.x), y: Math.round(a.y) }, rb = { x: Math.round(b.x), y: Math.round(b.y) };
    if (!this.at || this.at.x !== ra.x || this.at.y !== ra.y) this.body.push(`${this.xy(ra)}D02*`);
    const i = (c.x - ra.x) * (this.mirror ? -1 : 1), j = c.y - ra.y;
    this.body.push(`${this.mirror ? 'G02' : 'G03'}${this.xy(rb)}I${this.num(i)}J${this.num(j)}D01*`, 'G01*');
    this.at = rb;
  }

  flash(at: Vec2, key: string, def: string): void { this.use(key, def); this.body.push(`${this.xy(at)}D03*`); this.at = null; }
  dot(at: Vec2, dia: number): void { this.circle(dia); this.body.push(`${this.xy(at)}D03*`); this.at = null; }

  region(contours: Vec2[][], clear = false): void {
    if (clear) this.body.push('%LPC*%');
    // X2: a region takes the aperture attributes set when it is drawn
    const fn = this.x2 && this.fn && !clear ? this.fn : undefined;
    if (fn) this.body.push(`%TA.AperFunction,${fn}*%`);
    this.body.push('G36*');
    for (const c of contours) {
      if (c.length < 3) continue;
      this.body.push(`${this.xy(c[0]!)}D02*`);
      for (let k = 1; k < c.length; k++) this.body.push(`${this.xy(c[k]!)}D01*`);
      this.body.push(`${this.xy(c[0]!)}D01*`);
    }
    this.body.push('G37*');
    if (fn) this.body.push('%TD.AperFunction*%');
    if (clear) this.body.push('%LPD*%');
    this.at = null;
  }

  /** Pad shapes: R / O / C / P apertures when axis-aligned, outlines otherwise. */
  pad(at: Vec2, st: PadStackLayer, rotation: number, grow = 0): void {
    const w = st.w + 2 * grow, h = st.h + 2 * grow;
    if (w <= 0 || h <= 0) return;
    const rot = ((rotation % 360) + 360) % 360;
    const quarter = Math.abs(rot % 90) < 1e-6;
    const swap = quarter && Math.round(rot / 90) % 2 === 1;
    const [W, H] = swap ? [h, w] : [w, h];
    if (st.shape === 'round') {
      if (w === h) { this.dot(at, w); return; }
      if (quarter) { this.flash(at, `O${this.size(W)}x${this.size(H)}`, `O,${this.size(W)}X${this.size(H)}`); return; }
      const long = Math.max(w, h), short = Math.min(w, h), ang = ((rot + (w >= h ? 0 : 90)) * Math.PI) / 180;
      const d = { x: (Math.cos(ang) * (long - short)) / 2, y: (Math.sin(ang) * (long - short)) / 2 };
      this.line({ x: at.x - d.x, y: at.y - d.y }, { x: at.x + d.x, y: at.y + d.y }, short);
      return;
    }
    if (st.shape === 'rect' && quarter) { this.flash(at, `R${this.size(W)}x${this.size(H)}`, `R,${this.size(W)}X${this.size(H)}`); return; }
    if (st.shape === 'octagon' && w === h) {
      const dia = w / Math.cos(Math.PI / 8);
      this.flash(at, `P${this.size(dia)}r${(22.5 + rot) % 360}`, `P,${this.size(dia)}X8X${((22.5 + rot) % 360).toFixed(1)}`);
      return;
    }
    this.region([padOutline(at, { ...st, w, h }, rot, grow)]);
  }

  /** Cut into pieces with no holes: clear contours would erase what was drawn before (see holeFree). */
  regionHoles(outline: Vec2[], holes: Vec2[][]): void {
    for (const piece of holeFree(outline, holes)) this.region([piece]);
  }

  text(): string { return this.body.join('\n'); }

  finish(header: string[]): string {
    if (this.obj) { this.body.push('%TD*%'); this.obj = ''; }
    if (this.shared) return [...header, 'G01*', 'G75*', ...this.body, 'M02*', ''].join('\n');
    const fs = `%FS${this.s.zeros === 'trailing' ? 'T' : 'L'}AX${this.s.intDigits}${this.s.decDigits}Y${this.s.intDigits}${this.s.decDigits}*%`;
    return [...header, fs, this.s.units === 'in' ? '%MOIN*%' : '%MOMM*%', 'G01*', 'G75*',
      ...this.macros, ...this.defs, ...this.body, 'M02*', ''].join('\n');
  }
}

/** Outline of a pad (rect, rounded rect, octagon, obround) as a polygon. */
export function padOutline(at: Vec2, st: PadStackLayer, rot: number, grow = 0): Vec2[] {
  const hw = st.w / 2, hh = st.h / 2;
  let pts: Vec2[];
  if (st.shape === 'octagon') {
    const c = Math.min(hw, hh) * (1 - 1 / (1 + Math.SQRT2)) * 1.0;
    pts = [[-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c], [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c]].map(([x, y]) => ({ x: x!, y: y! }));
  } else if (st.shape === 'roundrect' || st.shape === 'round') {
    const r = st.shape === 'round' ? Math.min(hw, hh) : Math.min(hw, hh) * (st.cornerPct / 100) + grow;
    const rr = Math.min(r, hw, hh);
    const corner = (cx: number, cy: number, a0: number) => arcPoints({ x: cx, y: cy }, rr, rr, a0, a0 + 90, 8);
    pts = [...corner(hw - rr, -hh + rr, 270), ...corner(hw - rr, hh - rr, 0), ...corner(-hw + rr, hh - rr, 90), ...corner(-hw + rr, -hh + rr, 180)];
  } else {
    pts = [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }];
  }
  return pts.map((p) => rotate({ x: at.x + p.x, y: at.y + p.y }, rot, at));
}

/* ─── Layer content ──────────────────────────────────────────────────────────────────── */

export function stackFor(p: PcbPad, layer: LayerId, doc: PcbDocument): PadStackLayer | null {
  if (p.layer === L.MULTI) {
    if (!isCopper(layer)) return null;
    void doc;
    // Each inner layer's own shape; none where Remove Unused Pad Shapes took it off
    return padShapeOn(p, layer);
  }
  return p.layer === layer ? p.top : null;
}

export function viaSpans(doc: PcbDocument, v: Extract<PcbPrim, { kind: 'via' }>, layer: LayerId): boolean {
  const stack = doc.board.copperStack;
  const a = stack.indexOf(v.layerStart), b = stack.indexOf(v.layerEnd), i = stack.indexOf(layer);
  if (i < 0) return false;
  const lo = a < 0 ? 0 : Math.min(a, b < 0 ? stack.length - 1 : b), hi = b < 0 ? stack.length - 1 : Math.max(a < 0 ? 0 : a, b);
  return i >= lo && i <= hi;
}

/** Which primitives a drawing takes (a print leaves out components of a side it doesn't include). */
export type PrimFilter = (p: PcbPrim) => boolean;

/** A dimension's lines, arcs and value text, plotted as strokes. */
export function drawDimension(plot: PlotSink, d: PcbDimension, edge?: DimEdge): void {
  const g = dimensionGeometry(d, false, edge);
  for (const a of g.arcs) plot.arc(a.c, a.r, a.start, a.end, a.w);
  for (const s of geometryStrokes(g)) plot.polyline(s.pts, s.w);
}

/** Special strings an output converts (.Legend is the drill table, drawn by the drill drawing). */
export type SpecialText = (text: string) => string;

const two = (n: number) => String(n).padStart(2, '0');
/**
 * Special strings as outputs convert them: the whole text (.Layer_Name) or quoted inside one
 * ('.Layer_Name'); .Printout_Name when printing.
 */
export function specialStrings(doc: PcbDocument, layer: LayerId, printout?: string, now = new Date()): SpecialText {
  const value = (k: string): string | null => {
    switch (k.toLowerCase()) {
      case 'printout_name': return printout ?? null;
      case 'layer_name': return doc.board.layerNames.get(layer) ?? layerName(layer);
      case 'pcb_file_name': return doc.name;
      case 'pcb_file_name_no_path': return doc.name;
      case 'print_date': return `${two(now.getDate())}/${two(now.getMonth() + 1)}/${now.getFullYear()}`;
      case 'print_time': return `${two(now.getHours())}:${two(now.getMinutes())}`;
      default: return null;
    }
  };
  return (t) => t.replace(/^\.(\w+)$/, (all, k: string) => value(k) ?? all).replace(/'\.(\w+)'/g, (all, k: string) => value(k) ?? all);
}

/** Objects drawn on the layer itself (tracks, arcs, fills, regions, text, dimensions). */
function plotOwn(plot: PlotSink, doc: PcbDocument, layer: LayerId, notes: Set<string>, keep: PrimFilter, o: DrawOptions): void {
  // Regions first (with holes: as pieces without), then everything else on top
  for (const p of doc.prims) {
    if (p.kind !== 'region' || p.layer !== layer || p.keepout || p.boardCutout || p.regionKind !== 0 || p.outline.length < 3 || !keep(p)) continue;
    plot.begin?.(metaFor(doc, p, layer));
    plot.regionHoles(p.outline, p.holes);
  }
  for (const p of doc.prims) {
    if (!('layer' in p) || p.layer !== layer || !keep(p)) continue;
    if ('keepout' in p && p.keepout && layer !== L.KEEPOUT) continue;
    if (p.kind === 'track' || p.kind === 'arc' || p.kind === 'fill' || p.kind === 'text') plot.begin?.(metaFor(doc, p, layer));
    switch (p.kind) {
      case 'track': plot.line(p.a, p.b, p.width); break;
      case 'arc': plot.arc(p.c, p.r, p.start, p.end, p.width); break;
      case 'fill': {
        const c = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
        plot.region([padOutline(c, { w: Math.abs(p.b.x - p.a.x), h: Math.abs(p.b.y - p.a.y), shape: 'rect', cornerPct: 0 }, p.rotation)]);
        break;
      }
      case 'text': {
        if (p.hidden || !p.text) break;
        if (o.drill && layer === L.DRILL_DRAWING && /^\.legend$/i.test(p.text.trim())) break; // the drill table stands there
        const text = o.special ? o.special(p.text) : p.text;
        if (!text) break;
        if (p.barcode) {
          // A barcode: its bars as regions (inverted: the box less the bars); the words in the stroke font
          const bc = barcodeShape(text, p.at, p.rotation, p.mirrored, p.height, p.barcode);
          for (const r of bc.rects) plot.region([r]);
          const lab = bc.label;
          if (lab) for (const ch of lab.chars) {
            // Each character centred in its share: back half its width along the text's direction
            const half = strokeTextWidth(ch.text, lab.height) / 2, a = (p.rotation * Math.PI) / 180, m = p.mirrored ? -1 : 1;
            const from = { x: ch.at.x - half * m * Math.cos(a), y: ch.at.y - half * m * Math.sin(a) };
            const sw = Math.max(lab.height / 10, 1);
            for (const pl of strokeText(ch.text, from, lab.height, p.rotation, p.mirrored)) {
              if (!lab.knockout) { plot.polyline(pl, sw); continue; }
              // Inverted: each stroke cleared out of the box
              for (let i = 1; i < pl.length; i++) {
                const a = pl[i - 1]!, b2 = pl[i]!, l = Math.hypot(b2.x - a.x, b2.y - a.y) || 1, nx = (-(b2.y - a.y) / l) * sw / 2, ny = ((b2.x - a.x) / l) * sw / 2;
                const ex = ((b2.x - a.x) / l) * sw / 2, ey = ((b2.y - a.y) / l) * sw / 2;
                plot.region([[{ x: a.x - ex + nx, y: a.y - ey + ny }, { x: b2.x + ex + nx, y: b2.y + ey + ny }, { x: b2.x + ex - nx, y: b2.y + ey - ny }, { x: a.x - ex - nx, y: a.y - ey - ny }]], true);
              }
            }
          }
          break;
        }
        if (p.fontType === 1) notes.add(`TrueType text plotted with the stroke font (${layerName(layer)})`);
        const ch = strokeCapHeight(p);
        const w = p.fontType === 1 ? Math.max(ch / 10, 1) : p.strokeWidth || p.height / 10;
        for (const pl of strokeText(text, p.at, ch, p.rotation, p.mirrored)) plot.polyline(pl, w);
        break;
      }
    }
  }
  plot.begin?.(null);
  for (const d of doc.dimensions ?? []) if (d.layer === layer) drawDimension(plot, d, dimensionEdges(doc.prims));
}

function expansion(doc: PcbDocument, kind: string, p: PcbPrim, fallback: string): number {
  const r = ruleFor(doc, kind, p);
  return r ? ruleLength(r, 'EXPANSION', fallback) : parseLength(fallback)!;
}

/**
 * A pad's or via's solder mask opening on one side, as the expansion to add: none (null) when it
 * is forced tented there; its own expansion when specified (Pad / Via dialog), else the rule's.
 */
export function solderMask(doc: PcbDocument, p: PcbPad | Extract<PcbPrim, { kind: 'via' }>, top: boolean): number | null {
  const s = doc.streams.get(p.src.storage)?.records[p.src.index]?.subs[p.kind === 'pad' ? 4 : 0];
  if (s) {
    if ((get(s, PAD.flags1) ?? 0) & (top ? FLAG.tentTop : FLAG.tentBottom)) return null;
    if (p.kind === 'pad' && s.length > PAD.solderMode.off && get(s, PAD.solderMode) === 2) {
      // The bottom its own when the dialog unlinked it (Konium's pad extras)
      const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
      const bottom = !top && rec ? padExtrasOf(rec).bottom : undefined;
      return bottom !== undefined ? Math.round(parseLength(bottom) ?? get(s, PAD.solderManual) ?? 0) : get(s, PAD.solderManual) ?? 0;
    }
    if (p.kind === 'via' && s.length > VIA.maskMode.off && get(s, VIA.maskMode) === 2) {
      // The bottom its own when not linked to the top [est: link byte]
      return !top && s.length >= VIA.maskBottom.off + 4 && !get(s, VIA.maskLinked) ? get(s, VIA.maskBottom) ?? 0 : get(s, VIA.maskTop) ?? 0;
    }
  }
  return expansion(doc, 'SolderMaskExpansion', p, '4mil');
}

/** A pad's paste opening: its own expansion when specified, else the rule's. */
export function pasteMask(doc: PcbDocument, p: PcbPad): number {
  const s = doc.streams.get(p.src.storage)?.records[p.src.index]?.subs[4];
  if (s && s.length > PAD.pasteMode.off && get(s, PAD.pasteMode) === 2) return get(s, PAD.pasteManual) ?? 0;
  return expansion(doc, 'PasteMaskExpansion', p, '0mil');
}

export interface DrawOptions {
  /** Add the board shape to Mechanical 1, where the outline usually lives. */
  outlineOnMech1: boolean;
  notes: Set<string>;
  keep?: PrimFilter;
  /** Drill drawing: the symbol kind and size, and the legend (drillDrawing.ts). */
  drill?: DrillSymbols;
  /** Special strings converted (.Layer_Name, .Printout_Name …). */
  special?: SpecialText;
  /** Gerber Setup › Include unconnected mid-layer pads (absent: included, as before 26.110). */
  midPads?: boolean;
}

/** Whether copper of the pad's or via's net meets it on this layer: a track or arc ending on it, a fill or region under it. */
function connectedOn(doc: PcbDocument, p: { at: Vec2; net: number }, reach: number, layer: LayerId): boolean {
  if (p.net === NO_NET) return false;
  const near = (q: Vec2) => Math.hypot(q.x - p.at.x, q.y - p.at.y) <= reach;
  for (const q of doc.prims) {
    if (!('layer' in q) || q.layer !== layer || !('net' in q) || copperNet(doc, q) !== p.net) continue;
    if (q.kind === 'track' && (near(q.a) || near(q.b))) return true;
    if (q.kind === 'arc') { const e = [q.start, q.end].map((a) => ({ x: q.c.x + q.r * Math.cos((a * Math.PI) / 180), y: q.c.y + q.r * Math.sin((a * Math.PI) / 180) })); if (e.some(near)) return true; }
    if (q.kind === 'region' && q.outline.length > 2 && pointInPoly(p.at, q.outline)) return true;
    if (q.kind === 'fill' && p.at.x >= Math.min(q.a.x, q.b.x) && p.at.x <= Math.max(q.a.x, q.b.x) && p.at.y >= Math.min(q.a.y, q.b.y) && p.at.y <= Math.max(q.a.y, q.b.y)) return true;
  }
  return false;
}

/** One layer's content onto a sink: what the layer holds, pads and vias by stack, mask and paste openings, drill symbols and guides. */
export function drawLayer(plot: PlotSink, doc: PcbDocument, layer: LayerId, o: DrawOptions): void {
  const keep = o.keep ?? (() => true);
  if (isPlane(layer)) {
    // An internal plane as its copper (positive): what's drawn on the layer is clear of it
    for (const a of planeCopper(doc, layer)) {
      plot.begin?.({ fn: 'Conductor', net: a.net === NO_NET ? '' : doc.nets[a.net]?.name ?? '' });
      for (const r of a.regions) plot.regionHoles(r.outline, r.holes);
    }
    plot.begin?.(null);
    return;
  }
  plotOwn(plot, doc, layer, o.notes, keep, o);
  const top = layer === L.TOP_SOLDER || layer === L.TOP_PASTE;
  const side = top ? doc.board.copperStack[0]! : doc.board.copperStack.at(-1)!;
  if (isCopper(layer)) {
    // Include unconnected mid-layer pads off: an inner signal layer's through pads and vias only where they connect
    const stack = doc.board.copperStack, inner = o.midPads === false && isSignal(layer) && layer !== stack[0] && layer !== stack.at(-1);
    for (const p of doc.prims) {
      if (!keep(p)) continue;
      if (inner && (p.kind === 'via' || (p.kind === 'pad' && p.layer === L.MULTI)) && !connectedOn(doc, p, p.kind === 'via' ? p.diameter / 2 : Math.max(p.top.w, p.top.h) / 2, layer)) continue;
      if (p.kind === 'pad') { const st = stackFor(p, layer, doc); if (st) { plot.begin?.(metaFor(doc, p, layer)); plot.pad(p.at, st, p.rotation); } }
      else if (p.kind === 'via' && viaSpans(doc, p, layer)) { const d = viaDiameterOn(p, layer); if (d) { plot.begin?.(metaFor(doc, p, layer)); plot.dot(p.at, d); } }
    }
  } else if (MASKS.includes(layer)) {
    for (const p of doc.prims) {
      if (!keep(p)) continue;
      if (p.kind === 'pad') {
        // A through pad's own shape on that side (by its stack: a Simple one the top's on both)
        const st = p.layer === L.MULTI ? padLayer(p, top ? L.TOP : L.BOTTOM) : p.layer === side ? p.top : null;
        const e = st ? solderMask(doc, p, top) : null;
        if (!st || e === null) continue;
        plot.begin?.(metaFor(doc, p, layer));
        // Solder Mask From The Hole Edge: the opening the hole's shape grown by the expansion
        const rec = p.layer === L.MULTI && p.hole > 0 ? doc.streams.get(p.src.storage)?.records[p.src.index] : undefined;
        if (rec && padExtrasOf(rec).fromHoleEdge) {
          const len = p.slot && p.slot.length > p.hole ? p.slot.length : p.hole;
          plot.pad(p.at, { w: len + 2 * e, h: p.hole + 2 * e, shape: 'round', cornerPct: 0 }, p.rotation + (p.slot?.rotation ?? 0));
          continue;
        }
        plot.pad(p.at, st, p.rotation, Math.max(e, -Math.min(st.w, st.h) / 2));
      } else if (p.kind === 'via' && viaSpans(doc, p, side)) {
        const e = solderMask(doc, p, top);
        if (e === null) continue;
        plot.begin?.(metaFor(doc, p, layer));
        const vr = doc.streams.get(p.src.storage)?.records[p.src.index];
        plot.dot(p.at, (vr && padExtrasOf(vr).fromHoleEdge ? p.hole : p.diameter) + 2 * e);
      }
    }
  } else if (PASTES.includes(layer)) {
    for (const p of doc.prims) {
      if (p.kind !== 'pad' || p.hole > 0 || p.layer !== side || !keep(p)) continue;
      // A paste expansion that takes the pad's narrower side away: no paste (an edge connector's, a fiducial's)
      const e = pasteMask(doc, p);
      if (e <= -Math.min(p.top.w, p.top.h) / 2) continue;
      plot.begin?.(metaFor(doc, p, layer));
      plot.pad(p.at, p.top, p.rotation, e);
    }
  } else if (layer === L.MULTI) {
    // Multi-layer: through-hole pads and vias as their top shapes
    for (const p of doc.prims) {
      if (!keep(p)) continue;
      if (p.kind === 'pad' && p.layer === L.MULTI) plot.pad(p.at, p.top, p.rotation);
      else if (p.kind === 'via') plot.dot(p.at, p.diameter);
    }
  } else if (layer === L.DRILL_DRAWING && o.drill) {
    drawDrillSymbols(plot, doc, o.drill);
  } else if (layer === L.DRILL_GUIDE && o.drill) {
    drawDrillGuide(plot, doc);
  }
  plot.begin?.(null);
  if (layer === L.MECH1 && o.outlineOnMech1 && doc.board.outline.length > 2) {
    plot.begin?.({ fn: 'Profile' });
    plot.polyline([...doc.board.outline, doc.board.outline[0]!], 39_370); // 0.1 mm
    plot.begin?.(null);
  }
}

export function plotLayer(doc: PcbDocument, layer: LayerId, s: GerberSetup, mirror: boolean, notes: Set<string>, shared?: ApertureList): string {
  const origin = s.relative ? doc.board.origin : { x: 0, y: 0 };
  const plot = new Plot(s, origin, mirror, false, shared);
  drawLayer(plot, doc, layer, { outlineOnMech1: s.outlineOnMech1, notes, drill: s.drill, special: specialStrings(doc, layer), midPads: !!s.unconnectedMidPads });
  const c = layerColour(layer);
  const bgr = ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff);
  const order = isCopper(layer) || isPlane(layer) ? doc.board.copperStack.indexOf(layer) + 1 : 0;
  return plot.finish([
    'G04*',
    ...(order ? [`G04 Layer_Physical_Order=${order}*`] : []),
    `G04 Layer_Color=${bgr}*`,
    `G04 ${layerName(layer)} of ${doc.name}, written by Konium Designer*`,
  ]);
}

/**
 * A coverlay layer as its own Gerber file (as AD writes coverlay apart from the solder mask): its
 * edges and cutouts as closed 1 mil polylines (the edge their centre line), the openings for the
 * pads and vias under it flashed as the solder mask's are [est: the file's extension and header].
 */
export function plotCoverlay(doc: PcbDocument, c: CoverlayLayer, s: GerberSetup, mirror: boolean, shared?: ApertureList): string {
  const origin = s.relative ? doc.board.origin : { x: 0, y: 0 };
  const plot = new Plot(s, origin, mirror, false, shared);
  drawCoverlay(plot, doc, c);
  return plot.finish(['G04*', `G04 ${c.row.name} (coverlay, ${c.side}) of ${doc.name}, written by Konium Designer*`]);
}
/** A coverlay's edges and openings onto a sink (Gerber, Gerber X2). */
export function drawCoverlay(plot: PlotSink, doc: PcbDocument, c: CoverlayLayer): void {
  const areas = coverlayAreas(doc, c);
  const top = c.side === 'top';
  const side = top ? doc.board.copperStack[0]! : doc.board.copperStack.at(-1)!;
  plot.begin?.({ fn: 'Profile' });
  for (const a of areas) for (const o of [...a.outlines, ...a.cutouts]) plot.polyline([...o, o[0]!], 10_000);
  plot.begin?.(null);
  for (const p of doc.prims) {
    if ((p.kind !== 'pad' && p.kind !== 'via') || !underCoverlay(areas, p.at)) continue;
    if (p.kind === 'pad') {
      const st = p.layer === L.MULTI ? padLayer(p, top ? L.TOP : L.BOTTOM) : p.layer === side ? p.top : null;
      const e = st ? solderMask(doc, p, top) : null;
      if (!st || e === null) continue;
      plot.pad(p.at, st, p.rotation, Math.max(e, -Math.min(st.w, st.h) / 2));
    } else if (viaSpans(doc, p, side)) {
      const e = solderMask(doc, p, top);
      if (e !== null) plot.dot(p.at, p.diameter + 2 * e);
    }
  }
}

/** Rule kinds a Gerber run exports to .RUL and the value each writes (mils, two places). */
const RUL_KINDS: Record<string, [string, string]> = {
  ShortCircuit: ['Allowed', 'ALLOWED'], Clearance: ['Minimum', 'GAP'], Width: ['Minimum', 'MINLIMIT'],
  SolderMaskExpansion: ['Minimum', 'EXPANSION'], MinimumAnnularRing: ['Minimum', 'MINIMUMRING'],
};
/**
 * The .RUL rules export AD writes with the Gerber files: the enabled short-circuit, clearance,
 * width, solder mask expansion and minimum annular ring rules in the board's order, each
 * "Scope=Board" whatever its scope (AD17-era exports read beside their boards).
 */
export function rulesExport(doc: PcbDocument, path = doc.name): string {
  const lines = [`DRC Rules Export File for PCB: ${path}`];
  for (const r of doc.rules) {
    const kind = r.bag.get('RULEKIND') ?? '', k = RUL_KINDS[kind];
    if (!k || !r.bag.bool('ENABLED', true)) continue;
    const v = k[0] === 'Allowed' ? (r.bag.bool(k[1]) ? '1' : '0') : ((parseLength(r.bag.get(k[1]) ?? '0mil') ?? 0) / 1e4).toFixed(2);
    lines.push(`RuleKind=${kind}|RuleName=${r.bag.get('NAME') ?? kind}|Scope=Board|${k[0]}=${v}`);
  }
  return lines.join('\r\n') + '\r\n';
}

/** All chosen layers, plus the .RUL rules export, the .EXTREP extension report and a .REP summary (AD's order). */
export function gerberFiles(doc: PcbDocument, s: GerberSetup, path?: string): { files: OutputFile[]; notes: string[]; apertures?: ApertureList } {
  const base = doc.name.replace(/\.pcbdoc$/i, '');
  const notes = new Set<string>();
  const shared: ApertureList | undefined = s.embedded === false ? { codes: new Map(), defs: [] } : undefined;
  const files: OutputFile[] = [];
  const ext: string[] = [];
  for (const l of s.layers) {
    if (!l.plot) continue;
    const e = gerberExtension(l.layer);
    files.push({ name: `${base}.${e}`, text: plotLayer(doc, l.layer, s, l.mirror, notes, shared) });
    ext.push(`.${e.padEnd(8)}${doc.board.layerNames.get(l.layer) ?? layerName(l.layer)}${l.mirror ? ' (mirrored)' : ''}`);
  }
  // Coverlay (rigid-flex): each coverlay layer its own file, with its side's solder mask [est: GCL1, GCL2 … in stack order]
  for (const c of coverlayLayers(doc)) {
    const mask = s.layers.find((l) => l.layer === (c.side === 'top' ? L.TOP_SOLDER : L.BOTTOM_SOLDER));
    if (!mask?.plot) continue;
    const e = `GCL${c.n}`;
    files.push({ name: `${base}.${e}`, text: plotCoverlay(doc, c, s, mask.mirror, shared) });
    ext.push(`.${e.padEnd(8)}${c.row.name} (coverlay)${mask.mirror ? ' (mirrored)' : ''}`);
  }
  // Drill Drawing tab: one drawing and one guide for the board's drill pair (Top to Bottom)
  const pair = `${layerName(doc.board.copperStack[0]!)} - ${layerName(doc.board.copperStack.at(-1)!)}`;
  for (const [on, layer, ext2, mirror, what] of [[s.drillDrawing, L.DRILL_DRAWING, 'GD1', s.mirrorDrillDrawing, 'Drill Drawing'], [s.drillGuide, L.DRILL_GUIDE, 'GG1', s.mirrorDrillGuide, 'Drill Guide']] as [boolean, LayerId, string, boolean, string][]) {
    if (!on) continue;
    files.push({ name: `${base}.${ext2}`, text: plotLayer(doc, layer, s, mirror, notes, shared) });
    ext.push(`.${ext2.padEnd(8)}${what} (${pair})${mirror ? ' (mirrored)' : ''}`);
  }
  if (shared) {
    files.push({ name: `${base}.APR`, text: apertureListText(doc, s, shared) });
    if (files.some((f) => f.text.includes('%LPC*%'))) notes.add('Inverted barcode text keeps RS-274X\'s clear polarity (%LPC*%) in the RS-274-D files');
  }
  files.push({ name: `${base}.RUL`, text: rulesExport(doc, path) });
  files.push({ name: `${base}.EXTREP`, text: ['', 'Layer Extension Report', '', ...ext, '', ''].join('\r\n') });
  files.push({ name: `${base}.REP`, text: [
    `Gerber files for ${doc.name}`, `Written by Konium Designer on ${new Date().toLocaleString(locale())}`, '',
    `Units: ${s.units === 'in' ? 'Inches' : 'Millimetres'}  Format: ${s.intDigits}:${s.decDigits}  ${s.zeros === 'none' ? 'Leading and trailing zeros kept' : `${s.zeros === 'leading' ? 'Leading' : 'Trailing'} zeros suppressed`}`,
    `Origin: ${s.relative ? 'relative origin of the board' : 'absolute origin'}`,
    `Apertures: ${shared ? `RS-274-D, ${shared.defs.length} listed in ${base}.APR` : 'embedded (RS-274X)'}`, '', 'Files:', ...files.filter((f) => !/\.(EXTREP|REP|RUL|APR)$/.test(f.name)).map((f) => `  ${f.name}`),
    ...(notes.size ? ['', 'Notes:', ...[...notes].map((n) => `  ${n}`)] : []), '',
  ].join('\r\n') });
  return { files, notes: [...notes], ...(shared ? { apertures: shared } : {}) };
}

const SHAPES: Record<string, string> = { C: 'Round', R: 'Rectangle', O: 'Obround', P: 'Polygon' };
/** An aperture's shape, sizes, sides and rotation from its definition (C,0.01000 / R,0.06000X0.05000 / P,0.05411X8X22.5). */
export function apertureRow(def: string): { shape: string; x: string; y: string; sides: string; rotation: string } {
  const [t = '', args = ''] = def.split(',');
  const a = args.split('X');
  if (t === 'P') return { shape: SHAPES.P!, x: a[0] ?? '', y: a[0] ?? '', sides: a[1] ?? '', rotation: a[2] ?? '' };
  return { shape: SHAPES[t] ?? t, x: a[0] ?? '', y: a[1] ?? a[0] ?? '', sides: '', rotation: '' };
}
/** <board>.APR: the run's units, format and D-codes [est: AD's aperture list has its own form]. */
export function apertureListText(doc: PcbDocument, s: GerberSetup, list: ApertureList): string {
  const zeros = s.zeros === 'none' ? 'None suppressed' : s.zeros === 'leading' ? 'Leading suppressed' : 'Trailing suppressed';
  return [
    `Aperture list for ${doc.name} (RS-274-D), written by Konium Designer`,
    `Units: ${s.units === 'in' ? 'Inches' : 'Millimetres'}  Format: ${s.intDigits}:${s.decDigits}  Zeros: ${zeros}  Coordinates: Absolute`, '',
    'D-Code  Shape       X Size      Y Size      Sides  Rotation',
    ...list.defs.map(({ d, def }) => { const r = apertureRow(def); return `D${String(d).padEnd(6)}${r.shape.padEnd(12)}${r.x.padEnd(12)}${r.y.padEnd(12)}${r.sides.padEnd(7)}${r.rotation}`.trimEnd(); }),
    '',
  ].join('\r\n');
}
/** An aperture list read back as the RS-274X header an RS-274-D file needs (to view it). */
export function apertureListHeader(text: string): string[] | null {
  const head = /Units:\s*(Inches|Millimetres)\s+Format:\s*(\d):(\d)\s+Zeros:\s*(None|Leading|Trailing)/.exec(text);
  if (!head) return null;
  const out = [`%FS${head[4] === 'Trailing' ? 'T' : 'L'}AX${head[2]}${head[3]}Y${head[2]}${head[3]}*%`, head[1] === 'Inches' ? '%MOIN*%' : '%MOMM*%'];
  const back: Record<string, string> = { Round: 'C', Rectangle: 'R', Obround: 'O', Polygon: 'P' };
  for (const l of text.split(/\r?\n/)) {
    const m = /^D(\d+)\s+(Round|Rectangle|Obround|Polygon)\s+([\d.]+)\s+([\d.]+)(?:\s+(\d+)\s+([-\d.]+))?/.exec(l);
    if (!m) continue;
    const t = back[m[2]!]!;
    out.push(`%ADD${m[1]}${t},${t === 'C' ? m[3] : t === 'P' ? `${m[3]}X${m[5]}X${m[6]}` : `${m[3]}X${m[4]}`}*%`);
  }
  return out;
}

export const _test = { padOutline };
