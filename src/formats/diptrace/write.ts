/**
 * A project as DipTrace's XML files (DipTrace opens them with File › Import › DipTrace XML in
 * Schematic Capture and PCB Layout): the schematic (.dchxml), the board (.dipxml) and a component library
 * (.elixml) of the components they use with their patterns. A board or schematic read from DipTrace
 * and still as the import made it is the file DipTrace wrote, byte for byte (kept.ts).
 *
 *  - Schematic: each sheet (each channel of a multi-channel sheet) a sheet; the design cache a
 *    component for each library reference and pin layout, its parts its sections, each pin bound to
 *    the pad of its designator in the footprint's pattern; parts placed, turned and flipped as AD
 *    places them, with their designators, comments and parameters; every net by the name the
 *    project compiles it to, its pins (DipTrace's nets are design-wide), its wires; power ports and
 *    ports as net ports named by their net, net labels as net-name labels; drawings and text.
 *  - Board: the copper layers (signal and plane), the board outline and cut-outs, the stack-up, the
 *    footprints as patterns (pad styles: round, oval, rectangle, rounded rectangle, octagon,
 *    slotted holes, mask and paste states), components (bottom ones flipped), the nets' copper as
 *    traces from pad to pad with their vias, vias on no track static vias, polygon pours as copper
 *    pours, copper regions, keep-outs, cut-outs, text and the documentation layers as DipTrace's
 *    (silk, assembly, courtyard, outline, dimension; the rest as non-signal layers of their names),
 *    net classes and the design rules. Arcs of traces and the outline are written as short
 *    straight segments; shapes keep theirs.
 */
import type { Vec2 } from '../../core/geom';
import { UNITS_PER_MM } from '../../core/units';
import { compileProject, type CompiledNet } from '../../model/compile';
import { DIR_VECTORS, deriveObject, isShown, ownedBy, bagOf, type SchDocument, type SchObject } from '../../model/sch';
import { symbolOf } from '../../model/makeLib';
import { L as LY, isCopper, isMech, isPlane, layerName, type LayerId } from '../../model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PolyVertex } from '../../model/pcb';
import { footprintDoc, footprintsFromBoard } from '../../model/pcbLib';
import { readStack } from '../../model/pcbStack';
import { boardSettings } from '../kicad/exportPcb';
import type { ExportProject, ExportResult } from '../exporters';
import type { ImportMessage } from '../importers';
import { keptDch, keptDip } from './kept';

type Attrs = Record<string, string | number | boolean | undefined | null>;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v: number) => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? '0' : String(r); };
/** An element: its attributes (none left out but undefined and null; booleans Y/N), its children or text. */
function x(name: string, attrs: Attrs = {}, kids?: string[] | string): string {
  const a = Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${esc(typeof v === 'number' ? num(v) : v === true ? 'Y' : v === false ? 'N' : String(v))}"`).join('');
  if (kids === undefined || (Array.isArray(kids) && !kids.length)) return `<${name}${a} />`;
  if (typeof kids === 'string') return `<${name}${a}>${esc(kids)}</${name}>`;
  return `<${name}${a}>\n${kids.join('\n')}\n</${name}>`;
}
const t = (name: string, text: string) => (text ? `<${name}>${esc(text)}</${name}>` : `<${name} />`);
const VERSION = '4.3.0.3';
/** AD's units as millimetres. */
const MM = (c: number) => c / UNITS_PER_MM;
const norm = (a: number) => ((a % 360) + 360) % 360;
const rad = (deg: number) => Math.round(((norm(deg) * Math.PI) / 180) * 1e6) / 1e6;
const arcPoint = (c: Vec2, r: number, a: number): Vec2 => ({ x: c.x + r * Math.cos((a * Math.PI) / 180), y: c.y + r * Math.sin((a * Math.PI) / 180) });
const pts = (list: Vec2[], k: (q: Vec2) => Vec2) => x('Points', {}, list.map((q) => { const p = k(q); return x('Point', { X: num(p.x), Y: num(p.y) }); }));
/** DipTrace's font size (points) for a text height (mm): the import's measure turned round. */
const fontPt = (mm: number) => Math.max(1, Math.round((mm / 0.3) * 10) / 10);
const enc = new TextEncoder();

export function exportDipTrace(p: ExportProject): ExportResult {
  const name = p.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Project';
  const files: ExportResult['files'] = [];
  const messages: ImportMessage[] = [];
  const warned = new Set<string>();
  const warn = (w: string) => { if (!warned.has(w)) { warned.add(w); messages.push({ level: 'warn', source: name, message: w }); } };

  /* The patterns: the board's footprints as placed, else the project's PCB libraries' */
  const pats = new Patterns(p.board, warn);
  if (p.board) for (const fp of footprintsFromBoard(p.board)) pats.add(fp.name, footprintDoc(fp.name, fp.records).prims);
  for (const pl of p.pcbLibs) for (const f of pl.footprints) if (f.loaded !== false) pats.add(f.name, f.doc.prims);

  // The kept files, where the documents are still what the import made of them
  const keptBoard = p.board ? keptDip(p.board) : null;
  const keptSch = p.sheets.length ? keptDch(p.sheets.map((s) => s.doc)) : null;
  const sch = p.sheets.length ? writeSchematic(p, pats, warn) : null;
  if (keptSch) files.push({ path: `${name}/${keptSch.file}`, bytes: keptSch.bytes });
  else if (sch) files.push({ path: `${name}/${name}.dchxml`, bytes: enc.encode(sch.xml) });
  if (keptBoard) files.push({ path: `${name}/${keptBoard.file}`, bytes: keptBoard.bytes });
  else if (p.board) files.push({ path: `${name}/${name}.dipxml`, bytes: enc.encode(writeBoard(p.board, pats, warn, sch?.updateIds)) });
  if (sch && sch.components) files.push({ path: `${name}/${name}.elixml`, bytes: enc.encode(sch.library) });
  if (!p.sheets.length && !p.board) messages.push({ level: 'error', source: name, message: 'Nothing to export: no schematics or board' });
  else {
    messages.unshift({ level: 'info', source: name, message: `${sch ? `${sch.stats.sheets} sheet${sch.stats.sheets === 1 ? '' : 's'}, ${sch.stats.parts} parts, ${sch.stats.nets} nets` : 'no schematic'}${p.board ? `; the board: ${p.board.board.copperStack.length} copper layers, ${p.board.components.length} components` : ''}; ${pats.list.length} patterns${sch ? `, ${sch.components} components` : ''}` });
    if (keptSch || keptBoard) messages.push({ level: 'info', source: name, message: `${[keptSch && 'The schematic', keptBoard && 'the board'].filter(Boolean).join(' and ')} unchanged since DipTrace's file was read: written as DipTrace wrote ${keptSch && keptBoard ? 'them' : 'it'}` });
    messages.push({ level: 'info', source: name, message: 'DipTrace opens the .dchxml in Schematic Capture and the .dipxml in PCB Layout (File › Import › DipTrace XML), the .elixml in its Component Editor (Library › Import › DipXML)' });
  }
  return { files, messages };
}

/* ── patterns ── */

interface PatPad { id: number; name: string; style: string }
interface Pattern { style: string; name: string; xml: string; pads: PatPad[]; padsByName: Map<string, PatPad[]>; mounting: string }

/** The board's AD layer as a DipTrace layer token (null: none) and its non-signal layers. */
class LayerTokens {
  nonSignal = new Map<LayerId, number>();
  constructor(private readonly names: Map<LayerId, string>) {}
  token(l: LayerId, pattern: boolean): { Layer: string; LayId?: number } | null {
    switch (l) {
      case LY.TOP_OVERLAY: return { Layer: 'Top Silk' };
      case LY.BOTTOM_OVERLAY: return { Layer: 'Bottom Silk' };
      case LY.TOP_SOLDER: return { Layer: 'Top Mask' };
      case LY.BOTTOM_SOLDER: return { Layer: 'Bottom Mask' };
      case LY.TOP_PASTE: return { Layer: 'Top Paste' };
      case LY.BOTTOM_PASTE: return { Layer: 'Bottom Paste' };
      case LY.KEEPOUT: return { Layer: pattern ? 'Top Keepout' : 'Route Keepout' };
      default:
    }
    if (!isMech(l)) return null;
    const n = (this.names.get(l) ?? layerName(l)).toLowerCase();
    const side = /bottom|\bbot\b/.test(n) ? 'Bottom' : 'Top';
    if (/courtyard/.test(n)) return { Layer: `${side} Courtyard` };
    if (/assembly|\bassy\b|\bfab\b/.test(n)) return { Layer: `${side} Assy` };
    if (/outline|body/.test(n)) return { Layer: `${side} Outline` };
    if (/dimension/.test(n)) return { Layer: `${side} Dimension` };
    let id = this.nonSignal.get(l);
    if (id === undefined) { id = this.nonSignal.size; this.nonSignal.set(l, id); }
    return { Layer: 'Non-Signal', LayId: id };
  }
  xml(): string { return x('NonSignals', {}, [...this.nonSignal].map(([l, id]) => x('NonSignal', { Id: id, Side: 'None', Color: 8421504 }, [t('Name', this.names.get(l) ?? layerName(l))]))); }
}

class Patterns {
  list: Pattern[] = [];
  byName = new Map<string, Pattern>();
  styles = new Map<string, { key: string; xml: string }>();
  tokens: LayerTokens;
  constructor(board: PcbDocument | undefined, private readonly warn: (w: string) => void) { this.tokens = new LayerTokens(board?.board.layerNames ?? new Map()); }

  /** A pad's style: made the first time its kind, sizes, shape and hole are met. */
  padStyle(p: PcbPad): string {
    const tp = p.top;
    const through = p.hole > 0 && p.layer === LY.MULTI;
    const slot = p.slot && p.slot.length > p.hole + 1 ? p.slot : undefined;
    const shape = tp.shape === 'rect' ? 'Rectangle' : tp.shape === 'roundrect' ? 'Rectangle' : tp.shape === 'octagon' ? 'Polygon' : Math.abs(tp.w - tp.h) > 1 ? 'Obround' : 'Ellipse';
    const corner = tp.shape === 'roundrect' ? Math.round((tp.cornerPct / 2) * 100) / 100 : tp.shape === 'rect' ? 0 : undefined;
    // Its slot along the pad's x (DipTrace's obround hole: its width, then its height)
    const along = slot ? Math.round(norm(slot.rotation)) % 180 === 0 : true;
    const hole = through ? (slot ? { HoleType: 'Obround', Hole: num(MM(along ? slot.length : p.hole)), HoleH: num(MM(along ? p.hole : slot.length)) } : { HoleType: 'Round', Hole: num(MM(p.hole)) }) : {};
    if (slot && Math.round(norm(slot.rotation)) % 90) this.warn('Slots at an angle to their pads written along the pad');
    const key = JSON.stringify([through, hole, shape, tp.w, tp.h, corner]);
    let st = this.styles.get(key);
    if (!st) {
      const nm = `PadT${this.styles.size}`;
      const poly = shape === 'Polygon' ? [x('Points', {}, Array.from({ length: 8 }, (_, i) => {
        // AD's octagon: its corners cut at a quarter of the shorter side
        const c = Math.min(tp.w, tp.h) / 4, hw = tp.w / 2, hh = tp.h / 2;
        const v = [[hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c], [-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c]][i]!;
        return x('Point', { X: num(MM(v[0]!)), Y: num(MM(v[1]!)) });
      }))] : undefined;
      st = { key: nm, xml: x('PadStyle', { Name: nm, Type: through ? 'Through' : 'Surface', ...hole },
        [x('MainStack', { Shape: shape, Width: num(MM(tp.w)), Height: num(MM(tp.h)), ...(through ? { XOff: 0, YOff: 0 } : {}), Corner: corner !== undefined ? num(corner) : undefined }, poly)]) };
      this.styles.set(key, st);
      if (p.mid && (p.mid.w !== tp.w || p.bot.w !== tp.w || p.mid.h !== tp.h || p.bot.h !== tp.h)) this.warn('Pads with other sizes on other layers written at their top layer\'s');
    }
    return st.key;
  }

  /** A footprint (its primitives in its own frame) as a pattern. */
  add(fpName: string, prims: PcbPrim[]): void {
    const key = fpName.toUpperCase();
    if (this.byName.has(key)) return;
    const style = `PatType${this.list.length}`;
    const pads: PatPad[] = [], padsByName = new Map<string, PatPad[]>();
    const padXml: string[] = [], holes: string[] = [], shapes: string[] = [];
    let smd = 0, th = 0;
    for (const q of prims) {
      if (q.kind === 'pad') {
        if (q.hole > 0 && !q.plated && q.layer === LY.MULTI) { holes.push(x('Hole', { Id: holes.length, Locked: false, X: num(MM(q.at.x)), Y: num(MM(q.at.y)), Diam: num(MM(Math.max(q.hole, q.top.w))), HoleDiam: num(MM(q.hole)) })); continue; }
        if (q.layer !== LY.MULTI && q.layer !== LY.TOP && q.layer !== LY.BOTTOM) { this.warn('Pads on inner layers left out of the patterns'); continue; }
        const st = this.padStyle(q);
        const pad: PatPad = { id: pads.length + 1, name: q.name, style: st };
        pads.push(pad);
        const k = q.name.trim().toUpperCase();
        padsByName.set(k, [...(padsByName.get(k) ?? []), pad]);
        if (q.layer === LY.MULTI) th++; else smd++;
        padXml.push(x('Pad', { Id: pad.id, Style: st, X: num(MM(q.at.x)), Y: num(MM(q.at.y)), Angle: rad(q.rotation), Locked: false, Side: q.layer === LY.BOTTOM ? 'Bottom' : 'Top' }, [t('Number', q.name)]));
        continue;
      }
      if (q.kind === 'text' && (q.isDesignator || q.isComment)) continue;
      if (q.kind === 'body') continue;
      if (q.kind === 'region' && q.padShape) continue;
      shapes.push(...shapeXml(q, this.tokens, true, (v) => ({ x: MM(v.x), y: MM(v.y) }), shapes.length, this.warn));
    }
    const all = prims.flatMap((q) => (q.kind === 'pad' ? [{ x: q.at.x - q.top.w / 2, y: q.at.y - q.top.h / 2 }, { x: q.at.x + q.top.w / 2, y: q.at.y + q.top.h / 2 }] : q.kind === 'track' ? [q.a, q.b] : []));
    const xs = all.map((q) => MM(q.x)), ys = all.map((q) => MM(q.y));
    const w = xs.length ? Math.max(...xs) - Math.min(...xs) : 1, h = ys.length ? Math.max(...ys) - Math.min(...ys) : 1;
    const mounting = th && !smd ? 'Through' : smd && !th ? 'SMD' : th ? 'Through' : 'None';
    const xml = x('Pattern', { PatternStyle: style, Id: this.list.length, RefDes: '', Mounting: mounting, Width: num(w), Height: num(h), Orientation: 0, LockTypeChange: false, Type: 'Free', Float1: 0, Float2: 0, Float3: 0, Int1: 0, Int2: 0 }, [
      t('Name', fpName), x('Origin', { X: 0, Y: 0, Cross: true, Circle: true, Common: 'Hide', Courtyard: 'Show' }),
      ...(pads.length ? [x('DefPad', { Style: pads[0]!.style })] : []),
      x('Pads', {}, padXml), x('Shapes', {}, shapes), ...(holes.length ? [x('Holes', {}, holes)] : []),
    ]);
    const pat: Pattern = { style, name: fpName, xml, pads, padsByName, mounting };
    this.list.push(pat);
    this.byName.set(key, pat);
  }

  library(units = 'mm'): string {
    return x('Library', { Type: 'DipTrace-PatternLibrary', Units: units }, [x('PadStyles', {}, [...this.styles.values()].map((s) => s.xml)), x('Patterns', {}, this.list.map((q) => q.xml))]);
  }
}

/** A primitive (a pattern's in its own frame, or the board's) as DipTrace shapes. */
function shapeXml(q: PcbPrim, tokens: LayerTokens, pattern: boolean, k: (v: Vec2) => Vec2, id0: number, warn: (w: string) => void, copper?: (l: LayerId) => number | undefined, netId?: number): string[] {
  const layerOf = (l: LayerId, keepout = false): { Layer: string; LayId?: number } | null => {
    if (keepout && isCopper(l)) return pattern ? (l === LY.BOTTOM ? { Layer: 'Bottom Keepout' } : { Layer: 'Top Keepout' }) : { Layer: 'Route Keepout' };
    if (isCopper(l)) { if (pattern) return l === LY.TOP ? { Layer: 'Top' } : l === LY.BOTTOM ? { Layer: 'Bottom' } : null; const c = copper?.(l); return c === undefined ? null : { Layer: 'Signal/Plane', LayId: c }; }
    return tokens.token(l, pattern);
  };
  const T = pattern ? { Line: 'Line', Arc: 'Arc', FillRect: 'FillRect', Polygon: 'Polygon', Text: 'Text' } : { Line: 'Line', Arc: 'Arc', FillRect: 'FillRect', Polygon: 'Polygon', Text: 'Text' };
  const base = (id: number, ly: { Layer: string; LayId?: number }, type: string, extra: Attrs = {}) => ({ Id: id, Type: type, ...(pattern ? { Locked: false } : {}), Layer: ly.Layer, ...(ly.LayId !== undefined ? { LayId: ly.LayId } : {}), AllLayers: false, ...(netId !== undefined && netId >= 0 ? { NetId: netId } : {}), ...extra });
  switch (q.kind) {
    case 'track': {
      const ly = layerOf(q.layer, q.keepout);
      if (!ly) { warn(`Drawings on ${layerName(q.layer)} left out`); return []; }
      return [x('Shape', base(id0, ly, T.Line, { LineWidth: num(MM(q.width)) }), [pts([q.a, q.b], k)])];
    }
    case 'arc': {
      const ly = layerOf(q.layer, q.keepout);
      if (!ly) { warn(`Drawings on ${layerName(q.layer)} left out`); return []; }
      const sweep = norm(q.end - q.start) || 360;
      // A whole circle: two halves
      const halves = sweep >= 359.999 ? [[q.start, q.start + 180], [q.start + 180, q.start + 360]] : [[q.start, q.start + sweep]];
      return halves.map(([a, b], i) => x('Shape', base(id0 + i, ly, T.Arc, { LineWidth: num(MM(q.width)) }), [pts([arcPoint(q.c, q.r, a!), arcPoint(q.c, q.r, (a! + b!) / 2), arcPoint(q.c, q.r, b!)], k)]));
    }
    case 'fill': {
      const ly = layerOf(q.layer, q.keepout);
      if (!ly) return [];
      const cx = (q.a.x + q.b.x) / 2, cy = (q.a.y + q.b.y) / 2, hw = Math.abs(q.b.x - q.a.x) / 2, hh = Math.abs(q.b.y - q.a.y) / 2;
      if (norm(q.rotation) % 180 === 0) return [x('Shape', base(id0, ly, T.FillRect, { LineWidth: 0 }), [pts([{ x: cx - hw, y: cy - hh }, { x: cx + hw, y: cy + hh }], k)])];
      const a = (q.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => ({ x: cx + dx! * c - dy! * s, y: cy + dx! * s + dy! * c }));
      return [x('Shape', base(id0, ly, T.Polygon, { LineWidth: 0 }), [pts(corners, k)])];
    }
    case 'region': {
      if (q.outline.length < 3 || q.regionKind === 1) return [];
      if (q.holes.length) warn('Regions with holes written without their holes');
      const ly = q.boardCutout ? { Layer: 'Board Cutout' } : layerOf(q.layer, q.keepout || q.layer === LY.KEEPOUT);
      if (!ly) return [];
      return [x('Shape', base(id0, ly, T.Polygon, { LineWidth: 0 }), [pts(q.outline, k)])];
    }
    case 'text': {
      const ly = layerOf(q.layer);
      if (!ly || !q.text.trim()) return [];
      const size = fontPt(MM(q.height));
      return [x('Shape', base(id0, ly, T.Text, { Angle: rad(q.rotation), HorzAlign: 'Left', VertAlign: 'Bottom', TextAlign: 'Left', FontVector: true, FontMono: false, FontSize: Math.round(size), FontSizeFloat: num(size), FontWidth: -2, FontScale: 1, LineSpacing: 1.2 }),
        [pts([q.at], k), t('FontName', 'Tahoma'), x('TextLines', {}, q.text.replace(/\r/g, '').split('\n').map((l) => t('TextLine', l)))])];
    }
    default: return [];
  }
}

/* ── the board ── */

function writeBoard(doc: PcbDocument, pats: Patterns, warn: (w: string) => void, updateIds?: Map<string, number>): string {
  const st = boardSettings(doc);
  const o = doc.board.origin;
  const k = (v: Vec2): Vec2 => ({ x: MM(v.x - o.x), y: MM(v.y - o.y) });
  const stack = doc.board.copperStack.length >= 2 ? doc.board.copperStack : [LY.TOP, LY.BOTTOM];
  const layId = new Map<LayerId, number>(stack.map((l, i) => [l, i]));
  const copper = (l: LayerId) => layId.get(l);
  const tokens = pats.tokens;
  const netName = new Map(doc.nets.map((n) => [n.index, n.name]));

  /* Layers and stack-up */
  const planeNet = (l: LayerId) => { const nm = doc.board.bag?.get(`PLANE${l - LY.PLANE1 + 1}NETNAME`); return nm ? doc.nets.find((n) => n.name === nm)?.index : undefined; };
  const lays = stack.map((l, i) => x('Lay', { Id: i, Type: isPlane(l) ? 'Plane' : 'Signal', PlanePad: 'By Pads', ...(isPlane(l) && planeNet(l) !== undefined ? { NetId: planeNet(l) } : {}), PlaneRing: 0.2, Color: [255, 16711680, 32768, 8388736, 32896, 128][i % 6] },
    [t('Name', l === LY.TOP ? 'Top' : l === LY.BOTTOM ? 'Bottom' : doc.board.layerNames.get(l) ?? layerName(l))]));
  const rows = readStack(doc.board.bag!, stack);
  const items: string[] = [];
  let ci = 0;
  for (const r of rows) {
    if (r.kind === 'signal' || r.kind === 'plane') items.push(x('LayerStackItem', { Lay: ci++ }, [x('Material', { Type: r.kind === 'plane' ? 'Plane' : 'Conductor', VariableThickness: false, Thickness: num(MM(r.copper || 350)), Constant: 0, TraceWidth: 0 }, [t('Name', 'Copper')])]));
    else if (r.kind === 'dielectric' && ci > 0 && ci < stack.length) items.push(x('LayerStackItem', { Lay: -1 }, [x('Material', { Type: 'Dielectric', VariableThickness: false, Thickness: num(MM(r.height || 2540)), Constant: num(r.dielConst || 4.2), TraceWidth: 0 }, [t('Name', r.dielMaterial || 'Core')])]));
  }

  /* Via styles: each size, hole and span */
  const viaStyles: { key: string; xml: string }[] = [];
  const viaStyle = (d: number, h: number, a: LayerId, b: LayerId): number => {
    const through = a === stack[0] && b === stack.at(-1);
    const key = `${d}:${h}:${through ? '' : `${a}-${b}`}`;
    let i = viaStyles.findIndex((v) => v.key === key);
    if (i < 0) { i = viaStyles.length; viaStyles.push({ key, xml: x('ViaStyle', { Id: i, Size: num(MM(d)), HoleSize: num(MM(h)), ...(through ? {} : { Lay1: copper(a) ?? 0, Lay2: copper(b) ?? stack.length - 1 }) }, [t('Name', i ? `Via${i}` : 'Default')]) }); }
    return i;
  };
  viaStyle(Math.round(st.viaDiameter * UNITS_PER_MM), Math.round(st.viaDrill * UNITS_PER_MM), stack[0]!, stack.at(-1)!);

  /* Components and their pads */
  const comps: string[] = [];
  const compId = new Map<number, number>();
  const padRef = new Map<PcbPad, { comp: number; pad: number }>();
  for (const c of doc.components) {
    const pat = pats.byName.get(c.pattern.toUpperCase());
    if (!pat) { warn('Components of no footprint left out'); continue; }
    const id = comps.length;
    compId.set(c.index, id);
    const mine = doc.prims.filter((q): q is PcbPad => q.kind === 'pad' && q.component === c.index && !(q.hole > 0 && !q.plated && q.layer === LY.MULTI));
    const seen = new Map<string, number>();
    const padXml: string[] = [];
    for (const q of mine) {
      const kname = q.name.trim().toUpperCase();
      const n = seen.get(kname) ?? 0;
      seen.set(kname, n + 1);
      const pp = pat.padsByName.get(kname)?.[n];
      if (!pp) continue;
      padRef.set(q, { comp: id, pad: pp.id });
      padXml.push(x('Pad', { Id: pp.id, NetId: q.net !== NO_NET ? q.net : -1, InternalConnection: -1 }));
    }
    const bottom = c.layer === LY.BOTTOM;
    const at = k(c.at);
    const texts = doc.prims.filter((q): q is PcbPrim & { kind: 'text' } => q.kind === 'text' && q.component === c.index && (q.isDesignator || q.isComment));
    const des = texts.find((q) => q.isDesignator), com = texts.find((q) => q.isComment);
    const mark = (q: (PcbPrim & { kind: 'text' }) | undefined, on: boolean) => {
      if (!q) return [x('Silk', { Show: on ? 'Show' : 'Hide', Align: 'Auto', Horz: 'Center', Vert: 'Center', X: 0, Y: 0, Angle: 0 }), x('Assy', { Show: 'Hide', Align: 'Auto', Horz: 'Center', Vert: 'Center', X: 0, Y: 0, Angle: 0 })];
      const d = k(q.at);
      return [x('Silk', { Show: on && !q.hidden ? 'Show' : 'Hide', Align: 'Position', Horz: q.mirrored ? 'Right' : 'Left', Vert: 'Bottom', X: num(d.x - at.x), Y: num(d.y - at.y), Angle: rad(q.rotation) }),
        x('Assy', { Show: 'Hide', Align: 'Auto', Horz: 'Center', Vert: 'Center', X: 0, Y: 0, Angle: 0 })];
    };
    const size = fontPt(MM((des ?? com)?.height ?? 600000 / 10));
    const comment = com?.text ?? '';
    comps.push(x('Component', { Id: id, UpdateId: updateIds?.get(c.designator.toUpperCase()) ?? -1, PatternStyle: pat.style, X: num(at.x), Y: num(at.y), Angle: rad(bottom ? c.rotation - 180 : c.rotation), Side: bottom ? 'Bottom' : 'Top',
      MarkingFontSize: Math.round(size), MarkingFontSizeFloat: num(size), CustomMarkingFont: true, GridAlign: 'Origin', Locked: c.bag.get('LOCKED') === 'TRUE' ? true : undefined }, [
      t('RefDes', c.designator), t('Name', c.bag.get('SOURCELIBREFERENCE') ?? ''), t('Value', comment),
      x('RefDesMarking', {}, mark(des, c.nameOn)), x('ValueMarking', {}, mark(com, c.commentOn)),
      x('Pads', {}, padXml),
    ]));
  }

  /* Free pads: components of patterns of their own */
  let freeK = 0;
  for (const q of doc.prims) {
    if (q.kind !== 'pad' || (q.component !== undefined && q.component >= 0 && q.component !== NO_NET)) continue;
    const nm = `FreePad${++freeK}`;
    pats.add(nm, [{ ...q, at: { x: 0, y: 0 }, rotation: 0 } as PcbPad]);
    const pat = pats.byName.get(nm.toUpperCase())!;
    const id = comps.length;
    const hole = q.hole > 0 && !q.plated;
    const at = k(q.at);
    comps.push(x('Component', { Id: id, UpdateId: -1, Type: hole ? 'MtHole' : 'Pad', PatternStyle: pat.style, X: num(at.x), Y: num(at.y), Angle: rad(q.rotation), Side: 'Top' }, [
      t('RefDes', hole ? `H${freeK}` : `FP${freeK}`), t('Name', nm), t('Value', ''), x('Pads', {}, hole ? [] : [x('Pad', { Id: 1, NetId: q.net !== NO_NET ? q.net : -1, InternalConnection: -1 })])]));
    if (!hole) padRef.set(q, { comp: id, pad: 1 });
  }

  /* The nets' copper as traces: from pad to pad (or to wherever a stretch ends), through its vias */
  const TOL = Math.round(UNITS_PER_MM * 0.005);
  const keyOf = (q: Vec2) => `${Math.round(q.x / TOL)},${Math.round(q.y / TOL)}`;
  const tracesOf = new Map<number, string[]>();
  const padsOfNet = new Map<number, string[]>();
  const vias = doc.prims.filter((q): q is PcbPrim & { kind: 'via' } => q.kind === 'via');
  const viaUsed = new Set<object>();
  for (const q of doc.prims) if (q.kind === 'pad' && q.net !== NO_NET && padRef.has(q)) { const r = padRef.get(q)!; padsOfNet.set(q.net, [...(padsOfNet.get(q.net) ?? []), x('Item', { Comp: r.comp, Pad: r.pad })]); }
  let arcsFlat = false;
  for (const n of doc.nets) {
    type Seg = { a: Vec2; b: Vec2; pts: Vec2[]; layer: LayerId; width: number; used?: boolean };
    const segs: Seg[] = [];
    for (const q of doc.prims) {
      if ((q.kind !== 'track' && q.kind !== 'arc') || q.net !== n.index || q.keepout || (q.component !== undefined && q.component >= 0 && q.component !== NO_NET) || !isCopper(q.layer)) continue;
      if (q.polygon !== NO_NET && q.polygon >= 0 && q.polygon < doc.polygons.length) continue;
      if (copper(q.layer) === undefined) continue;
      if (q.kind === 'track') segs.push({ a: q.a, b: q.b, pts: [q.a, q.b], layer: q.layer, width: q.width });
      else {
        const sweep = norm(q.end - q.start) || 360;
        const steps = Math.max(2, Math.ceil(sweep / 10));
        const list = Array.from({ length: steps + 1 }, (_, i) => arcPoint(q.c, q.r, q.start + (sweep * i) / steps));
        segs.push({ a: list[0]!, b: list.at(-1)!, pts: list, layer: q.layer, width: q.width });
        arcsFlat = true;
      }
    }
    if (!segs.length) continue;
    const myVias = vias.filter((v) => v.net === n.index);
    const viaAt = new Map(myVias.map((v) => [keyOf(v.at), v]));
    const pads = doc.prims.filter((q): q is PcbPad => q.kind === 'pad' && q.net === n.index && padRef.has(q));
    // A pad a stretch ends on: the end within the pad's own shape (its box, turned with it)
    const padAt = (q: Vec2, layer: LayerId) => pads.find((p) => {
      if (p.layer !== LY.MULTI && p.layer !== layer) return false;
      const a = (-p.rotation * Math.PI) / 180, dx = q.x - p.at.x, dy = q.y - p.at.y;
      const u = dx * Math.cos(a) - dy * Math.sin(a), v = dx * Math.sin(a) + dy * Math.cos(a);
      return Math.abs(u) <= p.top.w / 2 + 1 && Math.abs(v) <= p.top.h / 2 + 1;
    });
    // Ends: how many stretches meet at each place
    const deg = new Map<string, number>();
    for (const s of segs) for (const e of [s.a, s.b]) deg.set(keyOf(e), (deg.get(keyOf(e)) ?? 0) + 1);
    const stop = (q: Vec2, layer: LayerId) => { const d = deg.get(keyOf(q)) ?? 0; const v = viaAt.get(keyOf(q)); return d !== 2 || !!padAt(q, layer) || (!!v && d !== 2); };
    const traces: string[] = [];
    const pointOf = new Map<string, { trace: number; point: number }>();
    const walk = (start: Seg, from: Vec2) => {
      const chain: { q: Vec2; layer: LayerId; width: number; via?: number }[] = [{ q: from, layer: start.layer, width: 0 }];
      let s: Seg | undefined = start, at = from;
      while (s) {
        s.used = true;
        const fwd = keyOf(s.a) === keyOf(at);
        const path = fwd ? s.pts : [...s.pts].reverse();
        for (const q of path.slice(1)) chain.push({ q, layer: s.layer, width: s.width });
        at = path.at(-1)!;
        if (stop(at, s.layer)) break;
        const here = keyOf(at);
        const next = segs.find((z) => !z.used && (keyOf(z.a) === here || keyOf(z.b) === here));
        { const v = viaAt.get(here); if (v && !viaUsed.has(v)) { chain.at(-1)!.via = viaStyle(v.diameter, v.hole, v.layerStart, v.layerEnd); viaUsed.add(v); } }
        s = next;
      }
      // Its ends: a pad, a via, another trace, or free
      const end = (q: Vec2, layer: LayerId, idx: number) => {
        const pad = padAt(q, layer);
        if (pad) return { kind: 'Pad', obj: padRef.get(pad)!.comp, sub: padRef.get(pad)!.pad, point: -1, at: pad.at };
        const v = viaAt.get(keyOf(q));
        if (v && !viaUsed.has(v)) { chain[idx]!.via = viaStyle(v.diameter, v.hole, v.layerStart, v.layerEnd); viaUsed.add(v); }
        const other = pointOf.get(keyOf(q));
        if (other) return { kind: 'Trace', obj: other.trace, sub: -1, point: other.point, at: q };
        return { kind: 'Free', obj: -1, sub: -1, point: -1, at: q };
      };
      let e1 = end(chain[0]!.q, chain[0]!.layer, 0), e2 = end(chain.at(-1)!.q, chain.at(-1)!.layer, chain.length - 1);
      // DipTrace reads a via at a trace's first point as none: such a trace runs the other way, or that via is left to another
      if (chain[0]!.via !== undefined) {
        if (chain.at(-1)!.via === undefined) {
          const n0 = chain.length;
          const rev = chain.map((_, j) => ({ q: chain[n0 - 1 - j]!.q, via: chain[n0 - 1 - j]!.via, layer: j ? chain[n0 - j]!.layer : chain[n0 - 1]!.layer, width: j ? chain[n0 - j]!.width : 0 }));
          chain.splice(0, n0, ...rev);
          [e1, e2] = [e2, e1];
        } else {
          const v = viaAt.get(keyOf(chain[0]!.q));
          if (v) viaUsed.delete(v);
          chain[0]!.via = undefined;
        }
      }
      const id = traces.length;
      chain.forEach((c, i) => { const kq = keyOf(c.q); if (!pointOf.has(kq)) pointOf.set(kq, { trace: id, point: i }); });
      traces.push(x('Trace', { Id: id, Connected1: e1.kind, Object1: e1.obj, SubObject1: e1.sub, Point1: e1.point, Connected2: e2.kind, Object2: e2.obj, SubObject2: e2.sub, Point2: e2.point, PairSeparateTrace: -1 }, [
        x('Points', {}, chain.map((c, i) => { const p = k(c.q); return x('Point', { Id: i, X: num(p.x), Y: num(p.y), Lay: copper(c.layer) ?? 0, Width: num(MM(i ? c.width : 0)), ShieldGroup: -1, ...(c.via !== undefined ? { ViaStyle: c.via } : {}), PairPoint: 0, PairSubPoint: 0 }); })),
      ]));
    };
    // From each end that stops a stretch (pads, branches, ends), then what's left (loops)
    for (const s of segs) if (!s.used) { if (stop(s.a, s.layer)) walk(s, s.a); else if (stop(s.b, s.layer)) walk(s, s.b); }
    for (const s of segs) if (!s.used) walk(s, s.a);
    tracesOf.set(n.index, traces);
  }
  if (arcsFlat) warn('Arcs of the nets\' copper written as short straight segments');
  // Vias on no trace: static vias
  for (const v of vias) {
    if (viaUsed.has(v)) continue;
    const at = k(v.at);
    comps.push(x('Component', { Id: comps.length, UpdateId: -1, Type: 'Via', ViaStyle: viaStyle(v.diameter, v.hole, v.layerStart, v.layerEnd), X: num(at.x), Y: num(at.y) }, [
      t('RefDes', `V${comps.length}`), t('Name', 'Via'), t('Value', ''), x('Pads', {}, [x('Pad', { Id: 1, NetId: v.net !== NO_NET ? v.net : -1 })])]));
  }

  /* Net classes */
  const classOf = new Map<string, number>();
  st.classes.forEach((c, i) => { for (const m of c.nets) if (!classOf.has(m.toUpperCase())) classOf.set(m.toUpperCase(), i + 1); });
  const classXml = [{ name: 'Default', width: st.trackWidth, clearance: st.clearance }, ...st.classes.map((c) => ({ name: c.name, width: c.trackWidth ?? st.trackWidth, clearance: c.clearance ?? st.clearance }))].map((c, i) =>
    x('NetClass', { Id: i, UpdateId: -1, Type: 'Normal', AllLayers: true, CheckLength: false, AllVias: true, PerformDRC: true, Phase: 0, Phase_ErrorLength: 0, LengthDelta: 0, MaxUncoupledLength: 0, Tolerance: 0 }, [
      t('Name', c.name), x('LayProperties', {}, [x('LayProperty', { Width: num(c.width), MinWidth: num(Math.min(st.minTrack, c.width)), MaxWidth: num(Math.max(5, c.width)), Clearance: num(c.clearance) }, [x('ClearanceDetails')])]),
      x('Autorouting', { RoutePriority: false, PriorityValue: 1, RouteMaxVias: false, MaxViasValue: 10000, RouteMaxIncorrectWay: false, MaxIncorrectWayValue: 30000, RouteAllLayers: true })]));
  const nets = doc.nets.map((n) => x('Net', { Id: n.index, HiddenId: n.index, NetClass: classOf.get(n.name.toUpperCase()) ?? 0 }, [t('Name', netName.get(n.index) ?? n.name), x('Pads', {}, padsOfNet.get(n.index) ?? []), ...(tracesOf.get(n.index)?.length ? [x('Traces', {}, tracesOf.get(n.index)!)] : [])]));

  /* Copper pours */
  const pours: string[] = [];
  const HATCH: Record<string, string> = { solid: 'Solid', horizontal: 'Horizontal Lines', vertical: 'Vertical Lines', '45degree': 'Cross 45', '90degree': 'Cross 90' };
  for (const poly of doc.polygons) {
    if (!/^polygon$/i.test(poly.type || 'Polygon')) continue;
    const l = copper(poly.layer);
    if (l === undefined || poly.outline.length < 3) continue;
    const width = MM(parseLen(poly.bag.get('TRACKWIDTH') ?? '8mil')), grid = MM(parseLen(poly.bag.get('GRIDSIZE') ?? '20mil'));
    const type = HATCH[(poly.hatch || 'Solid').toLowerCase()] ?? 'Solid';
    pours.push(x('CopperPour', { Id: pours.length, NetId: poly.net !== NO_NET && poly.net >= 0 ? poly.net : -1, Lay: l, Priority: Number(poly.bag.get('POURINDEX') ?? '0') || 0, Poured: true, Type: type, Clearance: num(st.clearance), UseNetClearance: false, BoardClearance: num(st.copperEdge || st.clearance),
      LineWidth: num(width), LineSpacing: num(Math.max(0.05, grid - width)), MinimumArea: 0, Spoke: '4 spoke', SpokeWidth: num(Math.max(width, 0.25)), ViaDirect: true, SMD_Separate: false, SMD_Spoke: '4 spoke', SMD_SpokeWidth: num(Math.max(width, 0.25)),
      RatlineMode: 'Automaticaly', SnapToBoard: false, IslandRegion: poly.bag.get('REMOVEDEAD') !== 'FALSE', IslandInternal: false, IslandConnection: false, RegionsDone: false }, [pts(poly.outline, k)]));
  }

  /* Free shapes: copper regions, keep-outs, cut-outs, drawings, text */
  const shapes: string[] = [];
  for (const q of doc.prims) {
    if ('component' in q && q.component !== undefined && q.component >= 0 && q.component !== NO_NET) continue;
    if ((q.kind === 'track' || q.kind === 'arc') && isCopper(q.layer) && !q.keepout && q.net !== NO_NET) continue;
    if ((q.kind === 'track' || q.kind === 'arc' || q.kind === 'region') && q.polygon !== NO_NET && q.polygon >= 0 && q.polygon < doc.polygons.length) continue;
    if (q.kind === 'pad' || q.kind === 'via' || q.kind === 'body') continue;
    const net = (q.kind === 'region' || q.kind === 'fill' || q.kind === 'track' || q.kind === 'arc') && isCopper(q.layer) && q.net !== NO_NET ? q.net : undefined;
    shapes.push(...shapeXml(q, tokens, false, k, shapes.length, warn, copper, net));
  }

  /* The board outline (its arcs as short straight segments) */
  const verts: PolyVertex[] = doc.board.vertices.length ? doc.board.vertices : doc.board.outline.map((q) => ({ p: q }));
  const outline: Vec2[] = [];
  verts.forEach((v) => {
    outline.push(v.p);
    if (!v.arc) return;
    const { c, r, sa, ea } = v.arc;
    const fwd = Math.hypot(arcPoint(c, r, sa).x - v.p.x, arcPoint(c, r, sa).y - v.p.y) <= Math.hypot(arcPoint(c, r, ea).x - v.p.x, arcPoint(c, r, ea).y - v.p.y);
    const span = norm(ea - sa) || 360, steps = Math.max(2, Math.ceil(span / 6));
    for (let i = 1; i < steps; i++) outline.push(arcPoint(c, r, fwd ? sa + (span * i) / steps : ea - (span * i) / steps));
    warn('The board outline\'s arcs written as short straight segments');
  });

  const mask = maskOf(doc), paste = pasteOf(doc);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    x('Source', { Type: 'DipTrace-PCB', Version: VERSION, Units: 'mm' }, [
      x('Library', { Type: 'DipTrace-ComponentLibrary', Units: 'mm' }, [pats.library(), x('Components')]),
      x('Board', {}, [
        x('BoardOutline', {}, [x('Points', {}, outline.map((q) => { const p = k(q); return x('Point', { X: num(p.x), Y: num(p.y), Arc: false }); }))]),
        x('Settings', {}, [x('Routing', {}, [t('TraceWidth', num(st.trackWidth)), t('TraceClearance', num(st.clearance)), t('BoardClearance', num(st.copperEdge || 0.25)), t('ViaSize', num(st.viaDiameter)), t('ViaHole', num(st.viaDrill))]),
          t('SolderMaskSwell', num(mask)), t('PasteMaskShrink', num(Math.max(0, -paste)))]),
        x('CopperLayers', {}, lays),
        ...(tokens.nonSignal.size ? [tokens.xml()] : []),
        t('LayerStackName', 'Custom'), x('LayerStackItems', {}, items),
        x('ViaStyles', {}, viaStyles.map((v) => v.xml)),
        x('NetClasses', {}, classXml),
        x('Components', {}, comps),
        x('Nets', {}, nets),
        x('CopperPours', {}, pours),
        x('Shapes', {}, shapes),
      ]),
    ]),
  ].join('\n') + '\n';
}

function maskOf(doc: PcbDocument): number { const r = doc.rules.find((q) => q.bag.get('RULEKIND') === 'SolderMaskExpansion'); return r ? MM(parseLen(r.bag.get('EXPANSION') ?? '4mil')) : 0.1016; }
function pasteOf(doc: PcbDocument): number { const r = doc.rules.find((q) => q.bag.get('RULEKIND') === 'PasteMaskExpansion'); return r ? MM(parseLen(r.bag.get('EXPANSION') ?? '0mil')) : 0; }
function parseLen(s: string): number { const m = /^\s*(-?[0-9.]+)\s*(mil|mm)?/i.exec(s); if (!m) return 0; const v = Number(m[1]); return (m[2] ?? 'mil').toLowerCase() === 'mm' ? v * UNITS_PER_MM : v * 10000; }

/* ── the schematic ── */

interface SchWritten { xml: string; library: string; components: number; updateIds: Map<string, number>; stats: { sheets: number; parts: number; nets: number } }

const ELECTRIC = ['Input', 'Bidirectional', 'Output', 'Open Low', 'Passive', '3 State', 'Open High', 'Power'];

function writeSchematic(p: ExportProject, pats: Patterns, warn: (w: string) => void): SchWritten {
  const sheets = p.sheets;
  const c = compileProject(sheets, { scope: p.hierarchyMode, channelFormat: p.channelFormat, channelSeparator: p.channelSeparator, checkBounds: false });
  const key2 = (inst: string | undefined, r: { sheet: string; index: number }) => `${inst ?? r.sheet}|${r.sheet}:${r.index}`;
  const pagesOf = new Map<string, string[]>();
  const sawInst = (sheet: string, inst: string | undefined) => { const l = pagesOf.get(sheet) ?? []; const kk = inst ?? sheet; if (!l.includes(kk)) l.push(kk); pagesOf.set(sheet, l); };
  const netAt = new Map<string, CompiledNet>();
  for (const n of c.nets) {
    for (const ir of n.instRefs ?? n.refs.map((ref) => ({ ref, inst: ref.sheet }))) { sawInst(ir.ref.sheet, ir.inst); const kk = key2(ir.inst, ir.ref); if (!netAt.has(kk)) netAt.set(kk, n); }
    for (const pin of n.pins) { sawInst(pin.ref.sheet, pin.inst); const kk = key2(pin.inst, pin.ref); if (!netAt.has(kk)) netAt.set(kk, n); }
  }
  const compAt = new Map<string, (typeof c.components)[number]>();
  for (const comp of c.components) comp.refs.forEach((r, i) => { const inst = comp.refInsts?.[i] || comp.inst; sawInst(r.sheet, inst); const kk = key2(inst, r); if (!compAt.has(kk)) compAt.set(kk, comp); });
  const pages: { s: (typeof sheets)[number]; inst: string }[] = [];
  for (const s of sheets) {
    const list = pagesOf.get(s.name) ?? [s.name];
    for (const inst of list) pages.push({ s, inst });
    if (list.length > 1) warn(`${s.name}: in the design ${list.length} times (multi-channel), written as ${list.length} sheets with each channel's designators and nets`);
  }
  const netIds = new Map<CompiledNet, number>(c.nets.map((n, i) => [n, i]));
  const netPins = new Map<number, string[]>();
  const netWires = new Map<number, string[]>();
  const sheetsXml: string[] = [], partsXml: string[] = [], shapesXml: string[] = [];
  const updateIds = new Map<string, number>();
  const mmK = (q: Vec2): Vec2 => ({ x: MM(q.x), y: MM(q.y) });

  /* Components: one for each library reference and pin layout */
  const compBySig = new Map<string, { style: string; xml: string; pins: Map<number, { designator: string; idx: number }[]> }>();
  const portComps = new Map<string, string>();
  const libComps: string[] = [];
  const componentOf = (doc: SchDocument, o: SchObject & { kind: 'component' }, footprint: string) => {
    const made = symbolOf(doc, o.index);
    const objs = made.bags.map((b, i) => (i > 0 ? deriveObject(b, i) : null)).filter((q): q is SchObject => !!q);
    const sections = Math.max(1, o.partCount - 1);
    const pinsAll = objs.filter((q): q is SchObject & { kind: 'pin' } => q.kind === 'pin' && q.ownerDisplayMode === 0);
    const sig = `${o.libRef}\u0000${footprint}\u0000${pinsAll.map((q) => `${q.designator}@${q.ownerPartId}:${q.at.x},${q.at.y},${q.orient},${q.length}`).sort().join('|')}`;
    let e = compBySig.get(sig);
    if (e) return e;
    const style = `CompType${libComps.length}`;
    const pat = footprint ? pats.byName.get(footprint.toUpperCase()) : undefined;
    if (footprint && !pat) warn(`Footprints not on the board nor in the project's PCB libraries: components with them have no pattern (${footprint})`);
    const pinsBySection = new Map<number, { designator: string; idx: number }[]>();
    const prefix = (o.designator.replace(/[\d?].*$/, '') || 'U').toUpperCase();
    const secXml: string[] = [];
    for (let sct = 1; sct <= sections; sct++) {
      const mine = objs.filter((q) => (q.ownerPartId <= 0 || q.ownerPartId === sct) && q.ownerDisplayMode === 0);
      const pins = mine.filter((q): q is SchObject & { kind: 'pin' } => q.kind === 'pin');
      if (mine.some((q) => q.kind === 'pin' && q.hidden)) warn('Hidden pins written as pins (DipTrace keeps them on their nets)');
      pinsBySection.set(sct, pins.map((q, i) => ({ designator: q.designator, idx: i })));
      const xs: number[] = [], ys: number[] = [];
      const shapes: string[] = [];
      for (const q of mine) {
        if (q.kind === 'pin' || q.kind === 'text') continue;
        shapes.push(...symShapes(q, mmK, shapes.length));
      }
      for (const q of mine) if ('at' in q && q.at) { xs.push(MM(q.at.x)); ys.push(MM(q.at.y)); }
      const w = xs.length ? Math.max(...xs) - Math.min(...xs) : 2.54, h = ys.length ? Math.max(...ys) - Math.min(...ys) : 2.54;
      const pinXml = pins.map((q, i) => {
        const pad = pat?.padsByName.get(q.designator.trim().toUpperCase())?.[0];
        if (pat && !pad) warn('Pins with no pad of their designator in the pattern left unbound');
        return x('Pin', { Id: i, X: num(MM(q.at.x)), Y: num(MM(q.at.y)), Locked: false, Type: q.symbols.outerEdge === 1 ? 'Dot' : q.symbols.innerEdge === 3 ? 'Clock' : 'Default', ElectricType: ELECTRIC[q.electrical] ?? 'Passive',
          Orientation: norm(180 - (q.orient & 3) * 90), PadId: pad ? pad.id - 1 : -1, Length: num(MM(q.length)), ShowName: q.showName, NumXShift: 0, NumYShift: 0, NameXShift: 0, NameYShift: 0, SignalDelay: 0, NumOrientation: 0, NameOrientation: 0 },
        [t('Name', q.name), t('PadNumber', q.designator), x('NameFont', { Size: 5, FontSizeFloat: 5, Width: -2, Scale: 1, FontMono: false })]);
      });
      secXml.push(x('Part', { Id: sct - 1, ...(sct === 1 ? { RefDes: prefix } : {}), PartType: 'Normal', ShowNumbers: pins.some((q) => !q.showDesignator) ? 'Hide' : undefined, Type: 'Free', Int1: 0, Int2: 0, Width: num(Math.max(w, 1)), Height: num(Math.max(h, 1)), LockTypeChange: false }, [
        ...(sct === 1 && pat ? [x('Pattern', { Style: pat.style })] : []),
        ...(sct === 1 ? [t('Name', o.libRef)] : []), t('PartName', `Part ${sct}`), t('Value', ''), x('Origin', { X: 0, Y: 0 }),
        ...(sct === 1 && made.description ? [t('Datasheet', '')] : []),
        x('Pins', {}, pinXml), x('Shapes', {}, shapes),
      ]));
    }
    e = { style, xml: x('Component', { ComponentStyle: style, Id: libComps.length }, secXml), pins: pinsBySection };
    compBySig.set(sig, e);
    libComps.push(e.xml);
    return e;
  };
  /** A net port component (a power port's or a port's look): a pin at its origin, its body the way it points. */
  const portComp = (kind: 'power' | 'ground' | 'port'): string => {
    let style = portComps.get(kind);
    if (style) return style;
    style = `CompType${libComps.length}`;
    const body = kind === 'ground' ? [[-1.27, -1.27, 1.27, -1.27], [-0.76, -1.78, 0.76, -1.78], [-0.25, -2.29, 0.25, -2.29], [0, 0, 0, -1.27]] : kind === 'power' ? [[-1.27, 1.27, 1.27, 1.27], [0, 0, 0, 1.27]] : [[0, 0, 1.27, 1.27], [1.27, 1.27, 5.08, 1.27], [5.08, 1.27, 5.08, -1.27], [5.08, -1.27, 1.27, -1.27], [1.27, -1.27, 0, 0]];
    libComps.push(x('Component', { ComponentStyle: style, Id: libComps.length }, [x('Part', { Id: 0, RefDes: 'PS', PartType: 'Net Port', ShowNumbers: 'Hide', Type: 'Free', Int1: 0, Int2: 0, Width: 2.54, Height: 2.54, LockTypeChange: true }, [
      t('Name', kind === 'ground' ? 'GND' : kind === 'power' ? 'VCC' : 'Port'), t('PartName', 'Part 1'), t('Value', ''), x('Origin', { X: 0, Y: 0 }),
      x('Pins', {}, [x('Pin', { Id: 0, X: 0, Y: 0, Locked: false, Type: 'Default', ElectricType: 'Passive', Orientation: kind === 'port' ? 180 : kind === 'ground' ? 90 : 270, PadId: -1, Length: 0, ShowName: false, NumXShift: 0, NumYShift: 0, NameXShift: 0, NameYShift: 0, SignalDelay: 0, NumOrientation: 0, NameOrientation: 0 }, [t('Name', '1'), t('PadNumber', '1'), x('NameFont', { Size: 5, FontSizeFloat: 5, Width: -2, Scale: 1, FontMono: false })])]),
      x('Shapes', {}, body.map((b, i) => x('Shape', { Id: i, Type: 'Line', LineWidth: 0.254 }, [x('Points', {}, [x('Point', { X: b[0], Y: b[1] }), x('Point', { X: b[2], Y: b[3] })])]))),
    ])]));
    portComps.set(kind, style);
    return style;
  };

  let partN = 0, upd = 100;
  const placed = new Set<string>();
  pages.forEach(({ s, inst }, si) => {
    const doc = s.doc, objs = doc.objects;
    const owned = ownedBy(doc);
    const ref = (o: SchObject) => key2(inst, { sheet: s.name, index: o.index });
    // The sheet's middle at DipTrace's origin [est: as DipTrace's own files lie]
    const W2 = MM(doc.sheet.width) / 2, H2 = MM(doc.sheet.height) / 2;
    const S = (q: Vec2): Vec2 => ({ x: MM(q.x) - W2, y: MM(q.y) - H2 });
    sheetsXml.push(x('Sheet', {}, [t('Id', String(si)), t('Name', pages.length > 1 && (pagesOf.get(s.name)?.length ?? 1) > 1 ? `${s.name.replace(/\.SchDoc$/i, '')} ${inst}` : s.name.replace(/\.SchDoc$/i, '')), t('Type', 'Normal'),
      t('XPos', num(-W2)), t('YPos', num(-H2)), t('Scale', '1'), t('SheetWidth', num(MM(doc.sheet.width))), t('SheetHeight', num(MM(doc.sheet.height))),
      t('LeftMargin', '5'), t('TopMargin', '5'), t('RightMargin', '5'), t('BottomMargin', '5')]));
    const hotOf = new Map<number, Vec2>();
    const wireEnds: { at: Vec2; part: number; pin: number }[] = [];
    /* Parts */
    for (const o of objs) {
      if (o.kind !== 'component' || !isShown(doc, o)) continue;
      const comp = compAt.get(ref(o));
      const des = comp?.designator || o.designator || 'U?';
      const footprint = comp?.kind === 2 ? '' : comp?.footprint ?? '';
      const e = componentOf(doc, o, footprint);
      const sct = Math.max(1, Math.min(o.partId, Math.max(1, o.partCount - 1)));
      if (!updateIds.has(des.toUpperCase())) updateIds.set(des.toUpperCase(), upd++);
      const kids = owned.get(o.index) ?? [];
      const pins = kids.filter((q): q is SchObject & { kind: 'pin' } => q.kind === 'pin' && (q.ownerPartId <= 0 || q.ownerPartId === sct));
      const list = e.pins.get(sct) ?? [];
      const partId = partN++;
      const pinXml = list.map((pp) => {
        const q = pins.find((z) => z.designator === pp.designator);
        const n = q ? netAt.get(ref(q)) : undefined;
        if (q) { const d = DIR_VECTORS[q.orient & 3]!; const hot = { x: q.at.x + d.x * q.length, y: q.at.y + d.y * q.length }; hotOf.set(q.index, hot); wireEnds.push({ at: hot, part: partId, pin: pp.idx }); }
        if (n) netPins.set(netIds.get(n)!, [...(netPins.get(netIds.get(n)!) ?? []), x('Item', { Part: partId, Pin: pp.idx })]);
        return x('Pin', { NetId: n ? netIds.get(n)! : -1 });
      });
      const text = (role: 'designator' | 'comment') => kids.find((q): q is SchObject & { kind: 'text' } => q.kind === 'text' && (role === 'designator' ? q.role === 'designator' : q.role === 'parameter' && /^comment$/i.test(bagOf(doc, q)?.get('NAME') ?? '')));
      const mark = (q: (SchObject & { kind: 'text' }) | undefined) => q
        ? { Show: q.hidden ? 'Hide' : 'Show', Align: 'Position', Horz: ['Left', 'Center', 'Right'][q.justify % 3], Vert: ['Bottom', 'Center', 'Top'][Math.floor(q.justify / 3) % 3], X: num(MM(q.at.x - o.at.x)), Y: num(MM(q.at.y - o.at.y)), Angle: rad((q.orient & 3) * 90) }
        : { Show: 'Hide', Align: 'Auto', Horz: 'Center', Vert: 'Center', X: 0, Y: 0, Angle: 0 };
      const at = S(o.at);
      partsXml.push(x('Part', { Id: partId, UpdateId: updateIds.get(des.toUpperCase()), ComponentStyle: e.style, ComponentPart: sct - 1, AllowParts: o.partCount > 2, PartNumber: sct - 1, Sheet: si, X: num(at.x), Y: num(at.y),
        Angle: (o.orient & 3) ? rad((o.orient & 3) * 90) : undefined, HorzFlip: o.mirrored ? true : undefined, MarkingFontSize: 6, MarkingFontSizeFloat: 6 }, [
        t('RefDes', des), t('PartRefDes', String(sct)), t('PartName', `Part ${sct}`), t('Value', comp?.comment ?? ''), t('Name', o.libRef), t('BaseName', o.libRef), t('Manufacturer', comp?.params?.Manufacturer ?? ''), t('Datasheet', ''),
        x('RefDesMarking', mark(text('designator'))), x('ValueMarking', mark(text('comment'))),
        x('Pins', {}, pinXml),
      ]));
      placed.add(des);
    }

    /* Power ports and ports: net ports of their nets */
    for (const o of objs) {
      if (!isShown(doc, o) || (o.kind !== 'power' && o.kind !== 'port')) continue;
      const n = netAt.get(ref(o));
      const kind = o.kind === 'port' ? 'port' : [4, 5, 6].includes(o.style) ? 'ground' : 'power';
      const style = portComp(kind);
      const partId = partN++;
      const at = S(o.at);
      // Turned the way AD's port points (the import's net ports point their bodies away from the pin)
      const angle = o.kind === 'power' ? ((o.orient & 3) - (kind === 'ground' ? 3 : 1)) * 90 : o.style >= 4 ? 90 : 0;
      wireEnds.push({ at: o.at, part: partId, pin: 0 });
      if (n) netPins.set(netIds.get(n)!, [...(netPins.get(netIds.get(n)!) ?? []), x('Item', { Part: partId, Pin: 0 })]);
      const nm = n?.name ?? (o.kind === 'power' ? o.text : o.name);
      partsXml.push(x('Part', { Id: partId, UpdateId: -1, ComponentStyle: style, ComponentPart: 0, AllowParts: false, PartNumber: 0, Sheet: si, X: num(at.x), Y: num(at.y), Angle: norm(angle) ? rad(angle) : undefined, MarkingFontSize: 6, MarkingFontSizeFloat: 6, ShowNumbers: 'Hide' }, [
        t('RefDes', `PS${partId}`), t('PartRefDes', '1'), t('PartName', 'Part 1'), t('Value', nm), t('Name', nm), t('BaseName', nm), t('Manufacturer', ''), t('Datasheet', ''),
        x('RefDesMarking', { Show: 'Hide', Align: 'Auto', Horz: 'Center', Vert: 'Center', X: 0, Y: 0, Angle: 0 }), x('NameMarking', { Show: 'Show', Align: 'Auto', Horz: 'Center', Vert: 'Center', X: 0, Y: 0, Angle: 0 }),
        x('Pins', {}, [x('Pin', { NetId: n ? netIds.get(n)! : -1 })]),
      ]));
    }

    /* Wires; net labels as net-name labels */
    for (const o of objs) {
      if (!isShown(doc, o)) continue;
      if (o.kind === 'wire') {
        const n = netAt.get(ref(o));
        if (!n) continue;
        const id = netIds.get(n)!;
        const list = netWires.get(id) ?? [];
        const endOf = (q: Vec2) => wireEnds.find((w) => Math.hypot(w.at.x - q.x, w.at.y - q.y) < 1000);
        const a = endOf(o.pts[0]!), b = endOf(o.pts.at(-1)!);
        list.push(x('Wire', { Id: list.length, Sheet: si, Connected1: a ? 'Pin' : 'Free', Bus1: -1, Object1: a?.part ?? -1, SubObject1: a?.pin ?? -1, Connected2: b ? 'Pin' : 'Free', Bus2: -1, Object2: b?.part ?? -1, SubObject2: b?.pin ?? -1, HiddenPower: false, CanUnhide: false },
          [x('Points', {}, o.pts.map((q, i) => x('Point', { X: num(S(q).x), Y: num(S(q).y), Dir: i ? (Math.abs(q.y - o.pts[i - 1]!.y) < 1 ? 0 : 1) : -1 })))]));
        netWires.set(id, list);
        continue;
      }
      if (o.kind === 'text' && o.role === 'netlabel') {
        const n = netAt.get(ref(o));
        shapesXml.push(x('Shape', { Id: shapesXml.length, Type: 'Text', Sheet: si, Angle: rad((o.orient & 3) * 90), HorzAlign: 'Left', VertAlign: 'Bottom', TextAlign: 'Left', FontVector: true, FontMono: false, FontSize: 6, FontSizeFloat: 6, FontWidth: -2, FontScale: 1, LineSpacing: 1.2, NetId: n ? netIds.get(n)! : -1 },
          [x('Points', {}, [x('Point', { X: num(S(o.at).x), Y: num(S(o.at).y) })]), t('FontName', 'Tahoma'), x('TextLines', {}, [t('TextLine', n?.name ?? o.text)])]));
        continue;
      }
      if (o.owner >= 0 && (objs[o.owner]?.kind === 'component' || objs[o.owner]?.kind === 'sheetsymbol')) continue;
      if (o.kind === 'text' && o.role === 'label' && o.owner < 0) {
        shapesXml.push(x('Shape', { Id: shapesXml.length, Type: 'Text', Sheet: si, Angle: rad((o.orient & 3) * 90), HorzAlign: ['Left', 'Center', 'Right'][o.justify % 3], VertAlign: ['Bottom', 'Center', 'Top'][Math.floor(o.justify / 3) % 3], TextAlign: 'Left', FontVector: true, FontMono: false, FontSize: 8, FontSizeFloat: 8, FontWidth: -2, FontScale: 1, LineSpacing: 1.2 },
          [x('Points', {}, [x('Point', { X: num(S(o.at).x), Y: num(S(o.at).y) })]), t('FontName', 'Tahoma'), x('TextLines', {}, o.text.split(/\r?\n/).map((l) => t('TextLine', l)))]));
        continue;
      }
      if (['polyline', 'polygon', 'rect', 'ellipse', 'arc', 'busentry'].includes(o.kind)) for (const sh of symShapes(o, S, shapesXml.length)) shapesXml.push(sh.replace('<Shape ', `<Shape Sheet="${si}" `));
      else if (o.kind === 'sheetsymbol') { for (const sh of symShapes({ ...o, kind: 'rect', a: o.at, b: { x: o.at.x + o.w, y: o.at.y - o.h } } as unknown as SchObject, S, shapesXml.length)) shapesXml.push(sh.replace('<Shape ', `<Shape Sheet="${si}" `)); warn('Sheet symbols drawn (the nets join by their names: DipTrace\'s nets are design-wide)'); }
      else if (o.kind === 'image') warn('Images left out');
      else if (o.kind === 'harness' || o.kind === 'harnessentry' || o.kind === 'signalharness') warn('Harnesses left out (their nets are kept)');
      else if (o.kind === 'bus') warn('Buses left out (their nets are kept)');
    }
  });

  const nets = c.nets.map((n, i) => x('Net', { Id: i, NetClass: 0, HiddenId: i }, [t('Name', n.name), x('Pins', {}, netPins.get(i) ?? []), ...(netWires.get(i)?.length ? [x('Wires', {}, netWires.get(i)!)] : [])]));
  const library = (root: boolean) => x('Library', { Type: 'DipTrace-ComponentLibrary', ...(root ? { Version: VERSION } : {}), Units: 'mm' }, [pats.library(), x('Components', {}, libComps)]);
  const xml = ['<?xml version="1.0" encoding="utf-8"?>', x('Source', { Type: 'DipTrace-Schematic', Version: VERSION, Units: 'mm' }, [
    library(false),
    x('Schematic', {}, [
      x('SheetSettings', {}, [t('DisplayTitles', 'Y'), t('DisplaySheet', 'Y'), t('ActiveSheet', '0'), x('Sheets', {}, sheetsXml)]),
      x('NetClasses', {}, [x('NetClass', { Id: 0, UpdateId: 0, Type: 'Normal' }, [t('Name', 'Default')])]),
      x('Components', {}, partsXml),
      x('Nets', {}, nets),
      x('Shapes', {}, shapesXml),
    ]),
  ])].join('\n') + '\n';
  return { xml, library: `<?xml version="1.0" encoding="utf-8"?>\n${library(true)}\n`, components: compBySig.size, updateIds, stats: { sheets: pages.length, parts: placed.size, nets: c.nets.length } };
}

/** A symbol's (or a sheet's) drawing as DipTrace shapes, points by `k` (AD → mm). */
function symShapes(o: SchObject, k: (q: Vec2) => Vec2, id0: number): string[] {
  const lw = (w: number) => num(Math.max(0.1, MM(w) || 0.254));
  const line = (list: Vec2[], w: number, type = 'Polyline') => x('Shape', { Id: id0, Type: list.length === 2 && type === 'Polyline' ? 'Line' : type, LineWidth: lw(w) }, [pts(list, k)]);
  switch (o.kind) {
    case 'polyline': return o.pts.length >= 2 ? [line(o.pts, o.width)] : [];
    case 'busentry': return [line([o.a, o.b], o.width)];
    case 'polygon': return o.pts.length >= 3 ? [line(o.solid && !o.transparent ? o.pts : [...o.pts, o.pts[0]!], o.width, o.solid && !o.transparent ? 'Polygon' : 'Polyline')] : [];
    case 'rect': return [x('Shape', { Id: id0, Type: o.solid && !o.transparent && o.fill === o.color ? 'FillRect' : 'Rectangle', LineWidth: lw(o.width) }, [pts([o.a, o.b], k)])];
    case 'ellipse': return [line(Array.from({ length: 49 }, (_, i) => ({ x: o.c.x + o.rx * Math.cos((i * Math.PI) / 24), y: o.c.y + o.ry * Math.sin((i * Math.PI) / 24) })), o.width)];
    case 'arc': {
      const sweep = norm(o.end - o.start) || 360;
      if (Math.abs(o.rx - o.ry) < 2 && sweep < 359.99) return [x('Shape', { Id: id0, Type: 'Arc', LineWidth: lw(o.width) }, [pts([arcPoint(o.c, o.rx, o.start), arcPoint(o.c, o.rx, o.start + sweep / 2), arcPoint(o.c, o.rx, o.start + sweep)], k)])];
      return [line(Array.from({ length: 33 }, (_, i) => ({ x: o.c.x + o.rx * Math.cos(((o.start + (sweep * i) / 32) * Math.PI) / 180), y: o.c.y + o.ry * Math.sin(((o.start + (sweep * i) / 32) * Math.PI) / 180) })), o.width)];
    }
    default: return [];
  }
}
