/**
 * AD boards as PADS Layout ASCII (PowerPCB V9.5, BASIC units: 38100 a mil, so AD's coordinates
 * keep their precision). What goes where:
 *
 *  - Layers: the copper stack in order (internal planes as CAM planes with their nets, split
 *    planes as mixed planes with their areas poured), PADS's own numbers for the solder masks,
 *    pastes, silkscreens, the drill drawing and the assembly drawings (mechanical 13 and 14),
 *    the other mechanical layers on PADS's free layers with their names; the stack-up's
 *    thicknesses and dielectric constants.
 *  - Components are parts on decals made from their footprints as placed (one decal for each
 *    different footprint): pads by their stacks (round, square, oval and rectangular fingers,
 *    rounded and chamfered corners, top/inner/bottom sizes, drills, slots, plating, specified mask
 *    and paste expansions), graphics, copper, text; their designators and comments as the parts'
 *    Ref.Des. and Part Type labels, the comments as the parts' Value. Free pads are parts of their
 *    own (FREEPAD).
 *  - Routes: every net's copper (tracks, arcs, vias) as PADS keeps it, pin to pin: each pad joined
 *    to the nearest pad before it on its copper (a junction's shared stretch written for each pin
 *    that passes it, as PADS does); copper joined to no pad is net copper among the line items,
 *    vias on no pad's copper are visited by unrouted hops; unrouted pads by unrouted
 *    connections.
 *  - Polygon pours: their outlines with their cut-outs, their copper (outlined a little inside,
 *    as PADS outlines poured copper with a line), voids.
 *  - The board outline (cut-outs more loops), free copper, keep-outs, drafting and text; the
 *    design rules' clearance and widths.
 */
import * as ClipperNS from 'clipper-lib';
import type { Vec2 } from '../../core/geom';
import { arcPoints, pointInPoly } from '../../core/geom';
import { mil } from '../../core/units';
import { L, isCopper, isMech, isPlane, layerName, type LayerId } from '../../model/layers';
import { NO_NET, type PcbArc, type PcbComponent, type PcbDocument, type PcbPad, type PcbPrim, type PcbRegion, type PcbText, type PcbTrack, type PcbVia, type PolyVertex, type PadStackLayer } from '../../model/pcb';
import { readStack } from '../../model/pcbStack';
import { planeCopper } from '../../model/planes';
import { dimensionEdges, dimensionGeometry } from '../../model/dimensions';
import { padOutline } from '../gerber/gerber';
import { PAD, get } from '../altium/pcbLayouts';
import { ruleEnabled, ruleKind, ruleLength, ruleScope1, ruleScope2 } from '../altium/rules';
import { binToBytes, toCp1252Lossy } from '../text';
import { PADS_TEXT_SCALE, type PadsFormat } from './layout';
import { keptPadsSource } from './kept';
import { padsSplice } from './splice';
import { UNIT_FACTOR, padsText, type PadsUnits } from './ascii';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;

/**
 * The file's units: per Konium unit (1/10000 mil) and the decimals PADS is given. BASIC (38,100 a
 * mil, whole numbers) unless the board was read from a PADS file in mils, inches or millimetres:
 * then those, as PADS wrote it.
 */
const UNIT_OUT: Record<PadsUnits, { per: number; dec: number; code: string }> = { BASIC: { per: 3.81, dec: 0, code: '0' }, MILS: { per: 1, dec: 4, code: '0' }, INCHES: { per: 1, dec: 7, code: '2' }, METRIC: { per: 2.54, dec: 6, code: '1' } };
let PER = 3.81, DEC = 0;
/** What the file's version writes (a board spliced into an older file's lines: written as that version writes them); V9.5's otherwise. */
const V95: PadsFormat = { font: true, lineStyle: true, corner: true, lineFlags: true };
let FMT = V95;
const B = (v: number) => (DEC ? Math.round(v * PER) / 10 ** DEC : Math.round(v * PER));
/** A sum of lengths in the file's units, to its decimals. */
const R = (v: number) => (DEC ? Math.round(v * 10 ** DEC) / 10 ** DEC : v);
const norm = (a: number) => ((a % 360) + 360) % 360;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (a: number) => norm(a).toFixed(3);

export interface PadsLayoutExport { text: string; bytes: Uint8Array; warnings: string[]; /** Written as PADS wrote it (a board read from PADS, unchanged or changed only in places: `spliced`). */ kept?: boolean; spliced?: { moved: number; rerouted: number; objects?: number } }

/** A name PADS takes: no spaces or dots (dots part a pin from its part), at most `max` characters. */
const padsName = (s: string, max = 40) => (s.trim().replace(/[\s.]+/g, '_').replace(/[^\x21-\x7e]/g, '_') || '_').slice(0, max);
/** A decal's or part type's name as a PADS file had it (dots kept). */
const padsLibName = (s: string, max = 40) => (s.trim().replace(/\s+/g, '_').replace(/[^\x21-\x7e]/g, '_') || '_').slice(0, max);
const netNameOf = (s: string) => (s.trim().replace(/\s+/g, '_').replace(/[^\x21-\x7e]/g, '_') || '_').slice(0, 47);

const FLIP: Record<number, LayerId> = { [L.TOP]: L.BOTTOM, [L.BOTTOM]: L.TOP, [L.TOP_OVERLAY]: L.BOTTOM_OVERLAY, [L.BOTTOM_OVERLAY]: L.TOP_OVERLAY, [L.TOP_SOLDER]: L.BOTTOM_SOLDER,
  [L.BOTTOM_SOLDER]: L.TOP_SOLDER, [L.TOP_PASTE]: L.BOTTOM_PASTE, [L.BOTTOM_PASTE]: L.TOP_PASTE, [L.MECH1 + 12]: L.MECH1 + 13, [L.MECH1 + 13]: L.MECH1 + 12 };

/** PADS's own layers (its 30-layer numbering). */
const FIXED: Record<number, [number, string, string]> = {
  [L.TOP_SOLDER]: [21, 'Solder Mask Top', 'SOLDER_MASK'], [L.BOTTOM_PASTE]: [22, 'Paste Mask Bottom', 'PASTE_MASK'], [L.TOP_PASTE]: [23, 'Paste Mask Top', 'PASTE_MASK'],
  [L.DRILL_DRAWING]: [24, 'Drill Drawing', 'DRILL'], [L.TOP_OVERLAY]: [26, 'Silkscreen Top', 'SILK_SCREEN'], [L.MECH1 + 12]: [27, 'Assembly Drawing Top', 'ASSEMBLY'],
  [L.BOTTOM_SOLDER]: [28, 'Solder Mask Bottom', 'SOLDER_MASK'], [L.BOTTOM_OVERLAY]: [29, 'Silkscreen Bottom', 'SILK_SCREEN'], [L.MECH1 + 13]: [30, 'Assembly Drawing Bottom', 'ASSEMBLY'],
};

/** A corner of a piece: an arc from it when `arc` is set (its centre, radius, start angle and sweep in degrees, anticlockwise positive). */
interface CornerOut { x: number; y: number; arc?: { cx: number; cy: number; r: number; a0: number; sweep: number } }
const cornerLine = (c: CornerOut) => (c.arc
  ? `${c.x} ${c.y} ${Math.round(norm(c.arc.a0) * 10)} ${Math.round(c.arc.sweep * 10)} ${R(c.arc.cx - c.arc.r)} ${R(c.arc.cy - c.arc.r)} ${R(c.arc.cx + c.arc.r)} ${R(c.arc.cy + c.arc.r)}`
  : `${c.x} ${c.y}`);

/** Counted messages. */
class Tally { m = new Map<string, number>(); add(s: string) { this.m.set(s, (this.m.get(s) ?? 0) + 1); } list() { return [...this.m].map(([s, n]) => (n > 1 ? `${s} (${n})` : s)); } }

/** The frame a component's decal is drawn in: unturned, a bottom one turned back over onto the top. */
interface Frame { bottom: boolean; pt: (p: Vec2) => { x: number; y: number }; ang: (a: number) => number; lay: (l: LayerId) => LayerId; mir: (m: boolean) => boolean }
function decalFrame(c: { at: Vec2; rotation: number; bottom: boolean }): Frame {
  const r = rad(-c.rotation), cs = Math.cos(r), sn = Math.sin(r);
  return {
    bottom: c.bottom,
    pt: (p) => { const dx = p.x - c.at.x, dy = p.y - c.at.y; const x = dx * cs - dy * sn, y = dx * sn + dy * cs; return { x: B(x), y: B(c.bottom ? -y : y) }; },
    ang: (a) => norm(c.bottom ? c.rotation - a : a - c.rotation),
    lay: (l) => (c.bottom ? FLIP[l] ?? l : l),
    mir: (m) => (c.bottom ? !m : m),
  };
}

const arcEnd = (a: { c: Vec2; r: number }, d: number): Vec2 => ({ x: a.c.x + a.r * Math.cos(rad(d)), y: a.c.y + a.r * Math.sin(rad(d)) });
const sweepOf = (a: PcbArc) => { const s = norm(a.end - a.start); return s < 1e-9 ? 360 : s; };

/** What a board written from Konium's is made of (for splice.ts): the free texts', line items' and pours' lines with the primitives or pour they were written from. */
export interface PadsTrace {
  texts: { prim: PcbPrim; lines: string[] }[];
  items: { prims: PcbPrim[]; lines: string[] }[];
  pours: { polygon: number; lines: string[] }[];
  /** Copper with a net written as line items, not in its net's routes (a line item of the file's). */
  notRouted?: (p: PcbPrim) => boolean;
}

export function exportPadsLayout(doc: PcbDocument, name: string, opts: { org?: Vec2; raw?: boolean; trace?: PadsTrace; like?: { head: string; fmt: PadsFormat } } = {}): PadsLayoutExport {
  if (!opts.raw) {
    // A board read from PADS and still what the import made of it: the file PADS wrote (kept.ts)
    const kept = keptPadsSource(doc);
    if (kept) return { text: padsText(kept), bytes: kept, warnings: [], kept: true };
    // Changed only by parts moved and nets rerouted: the file, but for those (splice.ts)
    const sp = padsSplice(doc, (org, trace, like) => exportPadsLayout(doc, name, { org, raw: true, trace, like }).bytes);
    if (sp) return { text: padsText(sp.bytes), bytes: sp.bytes, warnings: [], kept: true, spliced: { moved: sp.moved, rerouted: sp.rerouted, ...(sp.objects ? { objects: sp.objects } : {}) } };
  }
  const tally = new Tally();
  const warnings: string[] = [];
  // A board read from PADS keeps the file's frame: its parts and copper where PADS had them, the origin where it was
  const base = (doc.board.bag?.get('PADSBASE') ?? '').split(' ');
  const padsUnits = base.length >= 3 && base[0]! in UNIT_FACTOR ? UNIT_FACTOR[base[0] as PadsUnits] : 0;
  const org = opts.org ?? (padsUnits && Number.isFinite(Number(base[1])) && Number.isFinite(Number(base[2]))
    ? { x: Math.round(mil(1000) - Number(base[1]) * padsUnits), y: Math.round(mil(1000) - Number(base[2]) * padsUnits) }
    : doc.board.origin);
  const units: PadsUnits = padsUnits ? base[0] as PadsUnits : 'BASIC';
  ({ per: PER, dec: DEC } = UNIT_OUT[units]);
  FMT = opts.like?.fmt ?? V95;
  /** A line item's header: NAME TYPE XLOC YLOC PIECES [FLAGS] [TEXT [SIGSTR]]. */
  const itemHead = (nm: string, type: string, pieces: number, ntext = 0, net?: string) => `${nm} ${type} 0 0 ${pieces}${FMT.lineFlags ? ' 0' : ''}${ntext || net ? ` ${ntext}` : ''}${net ? ` ${net}` : ''}`;
  const font = (ls: string[]) => (FMT.font ? ls : ls.filter((l) => !/^Regular </.test(l)));
  const X = (p: Vec2) => ({ x: B(p.x - org.x), y: B(p.y - org.y) });
  const boardFrame: Frame = { bottom: false, pt: X, ang: (a) => norm(a), lay: (l) => l, mir: (m) => m };

  /* ── layers ── */
  let copper = doc.board.copperStack.slice();
  if (copper.length > 20) { warnings.push(`${copper.length} copper layers: PADS's 30-layer numbering takes 20; the inner layers after the 19th are left out`); copper = [...copper.slice(0, 19), copper[copper.length - 1]!]; }
  const N = copper.length;
  const level = new Map<LayerId, number>();
  copper.forEach((l, i) => level.set(l, i + 1));
  const names = new Map<number, [string, string]>();
  const takenLv = new Set<number>(copper.map((_, i) => i + 1));
  // A board read from PADS: its layers on the numbers they had (PADSLEVELS: Konium's layer, PADS's number and type)
  for (const e of (doc.board.bag?.get('PADSLEVELS') ?? '').split(',').filter(Boolean)) {
    const [l, n, type] = e.split(':'), id = Number(l) as LayerId, lv = Number(n);
    if (!Number.isFinite(id) || !(lv > N) || takenLv.has(lv) || level.has(id)) continue;
    level.set(id, lv); takenLv.add(lv);
    names.set(lv, [FIXED[id]?.[1] && !isMech(id) ? FIXED[id]![1] : doc.board.layerNames.get(id) ?? FIXED[id]?.[1] ?? layerName(id), type || FIXED[id]?.[2] || 'UNASSIGNED']);
  }
  for (const [l, [n, nm, type]] of Object.entries(FIXED)) { if (level.has(Number(l)) || takenLv.has(n)) continue; level.set(Number(l), n); names.set(n, [nm, type]); takenLv.add(n); }
  const free = [...Array.from({ length: 20 - N }, (_, i) => N + 1 + i), 25, ...Array.from({ length: 220 }, (_, i) => 31 + i)].filter((n) => !takenLv.has(n));
  const used = new Set<LayerId>();
  for (const p of doc.prims) if ('layer' in p) used.add(p.layer);
  for (const d of doc.dimensions) used.add(d.layer);
  for (const l of [...used].sort((a, b) => a - b)) {
    if (level.has(l) || isCopper(l) || l === L.MULTI || l === L.KEEPOUT) continue;
    if (!isMech(l) && l !== L.DRILL_GUIDE && !FIXED[l]) continue;
    const n = free.shift();
    if (n === undefined) { tally.add('More mechanical layers than PADS has free layers: the rest left out'); continue; }
    level.set(l, n);
    names.set(n, [doc.board.layerNames.get(l) ?? layerName(l), 'UNASSIGNED']);
  }
  const levelOf = (l: LayerId): number | null => level.get(l) ?? null;
  const labelSize = `${B(mil(40))} ${B(mil(4))}`;

  /* ── nets, parts, pins ── */
  const netNames = new Map<number, string>();
  const taken = new Set<string>();
  doc.nets.forEach((n, i) => { let s = netNameOf(n.name); for (let k = 2; taken.has(s); k++) s = `${netNameOf(n.name).slice(0, 44)}_${k}`; taken.add(s); netNames.set(i, s); });
  const netOf = (n: number) => (n === NO_NET || n < 0 ? undefined : netNames.get(n));

  const byComp = new Map<number, PcbPrim[]>();
  const freePrims: PcbPrim[] = [];
  for (const p of doc.prims) {
    const c = 'component' in p ? p.component : NO_NET;
    if (c !== NO_NET && c >= 0 && doc.components[c]) { const l = byComp.get(c); if (l) l.push(p); else byComp.set(c, [p]); }
    else freePrims.push(p);
  }

  /** A pin: its part's reference and its own name. */
  const pinOf = new Map<PcbPad, string>();
  const refs = new Set<string>();
  const uniqueRef = (s: string) => { let r = padsName(s || 'U'); for (let k = 2; refs.has(r); k++) r = `${padsName(s || 'U', 36)}_${k}`; refs.add(r); return r; };

  /* ── decals ── */
  interface Decal { name: string; key: string; lines: string[] }
  const decals = new Map<string, Decal>();
  const decalNames = new Set<string>();
  interface Part { ref: string; decal: string; type: string; comment: string; at: Vec2; ori: number; bottom: boolean; glued: boolean; labels: string[]; pins: string[]; /** A board read from PADS: the part's part type there. */ libRef?: string }
  /** Names as the PADS file the board was read from had them. */
  const libName = (s: string, max = 40) => (padsUnits ? padsLibName(s, max) : padsName(s, max));
  const parts: Part[] = [];

  /** A pad stack's row: LEVEL SIZE SHAPE and the shape's values. */
  const row = (lv: number, st: PadStackLayer | null, a: number): string => {
    if (!st || st.w <= 0 || st.h <= 0) return `${lv} 0 R`;
    const w = st.w, h = st.h, mn = Math.min(w, h), mx = Math.max(w, h);
    const ori = norm(a + (h > w + 1 ? 90 : 0));
    if (st.shape === 'round') return Math.abs(w - h) < 1 ? `${lv} ${B(w)} R` : `${lv} ${B(mn)} OF ${deg(ori)} ${B(mx)} 0`;
    const corner = st.shape === 'roundrect' ? B((mn / 2) * Math.min(1, (st.cornerPct || 0) / 100)) : st.shape === 'octagon' ? -B(mn * (1 - 1 / (1 + Math.SQRT2))) : 0;
    if (Math.abs(w - h) < 1 && Math.abs(norm(a) % 90) < 1e-6) return `${lv} ${B(w)} S ${corner}`;
    return `${lv} ${B(mn)} RF ${deg(ori)} ${B(mx)} 0 ${corner}`;
  };
  const grown = (st: PadStackLayer, e: number): PadStackLayer => ({ ...st, w: Math.max(1, st.w + 2 * e), h: Math.max(1, st.h + 2 * e) });
  const masks = (p: PcbPad): { solder?: number; paste?: number } => {
    const s = doc.streams.get(p.src.storage)?.records[p.src.index]?.subs[4];
    if (!s) return {};
    return { solder: s.length > PAD.solderMode.off && get(s, PAD.solderMode) === 2 ? get(s, PAD.solderManual) : undefined, paste: s.length > PAD.pasteMode.off && get(s, PAD.pasteMode) === 2 ? get(s, PAD.pasteManual) : undefined };
  };
  /** A pad's stack in a decal (the component's side on top). */
  const stack = (p: PcbPad, f: Frame): string[] => {
    const a = f.ang(p.rotation);
    const m = masks(p);
    const out: string[] = [];
    if (p.hole <= 0) {
      // A pad on an inner layer: its copper level only (a bottom part's levels the other way up)
      const inner = copper.indexOf(p.layer);
      if (inner > 0 && inner < N - 1) {
        out.push('-2 0 R', '-1 0 R', '0 0 R', row(f.bottom ? N - inner : inner + 1, p.top, a));
        return out;
      }
      const onTop = f.lay(p.layer) === L.TOP;
      out.push(onTop ? row(-2, p.top, a) : `-2 0 R`, `-1 0 R`, onTop ? `0 0 R` : row(0, p.top, a));
      if (m.solder !== undefined) out.push(row(onTop ? 21 : 28, grown(p.top, m.solder), a));
      if (m.paste !== undefined) out.push(row(onTop ? 23 : 22, grown(p.top, m.paste), a));
      return out;
    }
    const [mount, far] = f.bottom ? [p.bot, p.top] : [p.top, p.bot];
    const slot = p.slot && p.slot.length > p.hole ? ` ${deg(f.ang(p.rotation + p.slot.rotation))} ${B(p.slot.length)} 0` : '';
    out.push(`${row(-2, mount, a)} ${B(p.hole)} ${p.plated ? 'P' : 'N'}${slot}`, row(-1, p.mid, a), row(0, far, a));
    if (m.solder !== undefined) out.push(row(21, grown(mount, m.solder), a), row(28, grown(far, m.solder), a));
    return out;
  };
  const textHeight = (h: number) => B(h / PADS_TEXT_SCALE);
  /** A text's line `i`: its start, a line pitch further down the text. */
  const lineAt = (t: PcbText, i: number): Vec2 => ({ x: t.at.x + Math.sin(rad(t.rotation)) * i * t.height * 1.6, y: t.at.y - Math.cos(rad(t.rotation)) * i * t.height * 1.6 });
  /** A text's entry: [VISIBLE] X Y ORI LEVEL HEIGHT WIDTH M|N LEFT DOWN, its font, its string. */
  const textEntry = (t: PcbText, f: Frame, lv: number, s: string, visible?: boolean, ndim = false): string[] => {
    const at = f.pt(t.at);
    // A bottom part's label reads the other way round (PADS turns it with the part, then mirrors it)
    const ori = f.bottom ? norm(f.ang(t.rotation) - 180) : f.ang(t.rotation);
    if (t.fontType === 1) tally.add('TrueType text written in PADS\'s stroke font');
    const head = `${visible === undefined ? '' : visible ? 'VALUE ' : 'NONE '}${at.x} ${at.y} ${deg(ori)} ${lv} ${textHeight(t.height)} ${B(Math.max(t.strokeWidth, mil(1)))} ${f.mir(t.mirrored) ? 'M' : 'N'} LEFT DOWN${ndim ? ' 0' : ''}`;
    return font([head, 'Regular <Romansim Stroke Font>', s]);
  };
  /** A track's or an arc's piece corners. */
  const lineCorners = (p: PcbTrack | PcbArc, f: Frame): CornerOut[] => {
    if (p.kind === 'track') return [f.pt(p.a), f.pt(p.b)];
    const sw = sweepOf(p), s = arcEnd(p, p.start), e = arcEnd(p, p.start + sw);
    const a = f.pt(s), b = f.pt(e), c = f.pt(p.c);
    const a0 = (Math.atan2(a.y - c.y, a.x - c.x) * 180) / Math.PI;
    return [{ ...a, arc: { cx: c.x, cy: c.y, r: B(p.r), a0, sweep: f.bottom ? -sw : sw } }, b];
  };
  /** A closed outline's corners (the first again at the end). */
  const ringCorners = (pts: Vec2[], f: Frame): CornerOut[] => { const c = pts.map(f.pt); if (c.length) c.push(c[0]!); return c; };
  /** An outline with arcs (AD's vertices) as corners. */
  const vertexCorners = (vs: PolyVertex[], f: Frame): CornerOut[] => {
    const out: CornerOut[] = vs.map((v) => {
      const p = f.pt(v.p);
      if (!v.arc) return p;
      const atStart = Math.hypot(v.p.x - arcEnd(v.arc, v.arc.sa).x, v.p.y - arcEnd(v.arc, v.arc.sa).y) <= Math.max(v.arc.r * 0.01, 100);
      const sw = norm(v.arc.ea - v.arc.sa) || 360;
      const c = f.pt(v.arc.c);
      const a0 = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
      return { ...p, arc: { cx: c.x, cy: c.y, r: B(v.arc.r), a0, sweep: (atStart ? sw : -sw) * (f.bottom ? -1 : 1) } };
    });
    if (out.length) out.push({ x: out[0]!.x, y: out[0]!.y });
    return out;
  };
  const fillCorners = (p: Extract<PcbPrim, { kind: 'fill' }>): Vec2[] => {
    const c = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, hw = Math.abs(p.b.x - p.a.x) / 2, hh = Math.abs(p.b.y - p.a.y) / 2;
    const r = rad(p.rotation), cs = Math.cos(r), sn = Math.sin(r);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: c.x + x! * cs - y! * sn, y: c.y + x! * sn + y! * cs }));
  };
  const piece = (type: string, corners: CornerOut[], width: number, lv: number, extra = ''): string[] => [`${type} ${corners.length} ${B(width)}${FMT.lineStyle ? ' 0' : ''} ${lv}${extra ? ` ${extra}` : ''}`, ...corners.map(cornerLine)];
  /** A circle piece: two ends of a diameter. */
  const circle = (type: string, c: Vec2, r: number, width: number, lv: number, f: Frame, extra = ''): string[] => { const p = f.pt(c), rr = B(r); return [`${type} 2 ${B(width)}${FMT.lineStyle ? ' 0' : ''} ${lv}${extra ? ` ${extra}` : ''}`, `${R(p.x - rr)} ${p.y}`, `${R(p.x + rr)} ${p.y}`]; };

  /** The pieces of a drawing (graphics, copper, cut-outs) in a frame; `copperType` true for a decal's copper (COP…), the line items' are drawn alike. */
  const drawingPieces = (p: PcbPrim, f: Frame, pin?: number): string[][] => {
    const l = 'layer' in p ? f.lay(p.layer) : null;
    if (l === null) return [];
    const lv = levelOf(l);
    if (lv === null) return [];
    const cu = isCopper(l);
    // A decal's copper on a pin's net: that pin's (PINNUM, from 0)
    const pn = cu && pin !== undefined ? String(pin) : '';
    switch (p.kind) {
      case 'track': return [piece(cu ? 'COPOPN' : 'OPEN', lineCorners(p, f), p.width, lv, pn)];
      case 'arc':
        if (sweepOf(p) < 360) return [piece(cu ? 'COPOPN' : 'OPEN', lineCorners(p, f), p.width, lv, pn)];
        // A copper ring: two half circles (PADS's copper circle is a filled one)
        if (cu) return [piece('COPOPN', [...lineCorners({ ...p, start: p.start, end: p.start + 180 }, f).slice(0, 1), ...lineCorners({ ...p, start: p.start + 180, end: p.start + 360 }, f)], p.width, lv, pn)];
        return [circle('CIRCLE', p.c, p.r, p.width, lv, f)];
      case 'fill': return [piece('COPCLS', ringCorners(fillCorners(p), f), 0, lv, pn)];
      case 'region': {
        if (p.outline.length < 3) return [];
        return [piece(p.regionKind === 1 ? 'COPCUT' : 'COPCLS', ringCorners(p.outline, f), 0, lv, p.regionKind === 1 ? '' : pn), ...p.holes.filter((h) => h.length >= 3).map((h) => piece('COPCUT', ringCorners(h, f), 0, lv))];
      }
      case 'pad': return [piece('COPCLS', ringCorners(padOutline(p.at, p.top, p.rotation), f), 0, lv)];
      default: return [];
    }
  };

  // Free pads on copper are parts of their own (FREEPAD); the others drawings
  const freePads = freePrims.filter((p): p is PcbPad => p.kind === 'pad' && (p.layer === L.MULTI || isCopper(p.layer)));
  const comps: { c: PcbComponent | null; prims: PcbPrim[] }[] = [
    ...doc.components.map((c, ci) => ({ c, prims: byComp.get(ci) ?? [] })),
    ...freePads.map((p) => ({ c: null, prims: [p] })),
  ];
  let freeN = 0;
  for (const { c, prims } of comps) {
    const isFree = !c;
    const at = c ? c.at : (prims[0] as PcbPad).at;
    const rotation = c ? c.rotation : 0;
    const bottom = c ? c.layer === L.BOTTOM : false;
    const f = decalFrame({ at, rotation, bottom });
    const ref = uniqueRef(c ? c.designator : `FP${++freeN}`);
    const pieces: string[][] = [], texts: string[][] = [], terms: string[] = [], stacks: string[] = [];
    const pins: string[] = [];
    let des: PcbText | undefined, com: PcbText | undefined;
    const pinTaken = new Set<string>();
    const copperPads = prims.filter((p): p is PcbPad => p.kind === 'pad' && (p.layer === L.MULTI || isCopper(p.layer)));
    for (const p of prims) {
      if (p.kind === 'pad') {
        const onCu = p.layer === L.MULTI || isCopper(p.layer);
        if (!onCu) { pieces.push(...drawingPieces(p, f)); continue; }
        let pin = padsName(p.name || String(terms.length + 1), 20);
        for (let k = 2; pinTaken.has(pin); k++) pin = `${padsName(p.name || String(terms.length + 1), 16)}_${k}`;
        pinTaken.add(pin);
        pinOf.set(p, `${ref}.${pin}`);
        pins.push(pin);
        const q = f.pt(p.at);
        terms.push(`T${q.x} ${q.y} ${q.x} ${q.y} ${terms.length + 1}`);
        const rows = stack(p, f);
        stacks.push(`PAD ${terms.length} ${rows.length}`, ...rows);
      } else if (p.kind === 'text') {
        if (p.isDesignator) { des ??= p; continue; }
        if (p.isComment) { com ??= p; continue; }
        if (p.fontType === 2) { tally.add('Barcode text left out'); continue; }
        const lv = levelOf(f.lay(p.layer));
        if (lv === null) continue;
        p.text.split(/\r?\n/).forEach((line, i) => { if (line) texts.push(textEntry({ ...p, at: lineAt(p, i) }, f, lv, line)); });
      } else if (p.kind === 'via') { tally.add('Vias in footprints left out (PADS\'s decals have none)'); }
      else if (p.kind === 'body') { /* 3D bodies: none in PADS */ }
      else if ('keepout' in p && p.keepout) {
        const kl = f.lay(p.layer), lv = kl === L.KEEPOUT ? 0 : levelOf(kl);
        if (lv === null) continue;
        if (p.kind === 'region' && p.outline.length >= 3) pieces.push(piece('KPTCLS', ringCorners(p.outline, f), 0, lv, 'TVC'));
        else if (p.kind === 'fill') pieces.push(piece('KPTCLS', ringCorners(fillCorners(p), f), 0, lv, 'TVC'));
        else tally.add('Keep-out lines in footprints left out (PADS\'s keep-outs are areas)');
      } else if (p.kind === 'region' && p.boardCutout) tally.add('Board cut-outs in footprints left out');
      else if ('layer' in p && p.layer === L.KEEPOUT) {
        if (p.kind === 'region' && p.outline.length >= 3) pieces.push(piece('KPTCLS', ringCorners(p.outline, f), 0, 0, 'TVC'));
        else tally.add('Keep-out lines in footprints left out (PADS\'s keep-outs are areas)');
      } else {
        const net = 'net' in p ? p.net : NO_NET;
        const pin = net !== NO_NET ? copperPads.findIndex((q) => q.net === net) : -1;
        pieces.push(...drawingPieces(p, f, pin >= 0 ? pin : undefined));
      }
    }
    // The decal's own labels: Ref.Des. and Part Type at its origin
    const decalLabels = [[`VALUE 0 0 0.000 ${levelOf(L.TOP_OVERLAY) ?? 26} ${labelSize} N LEFT DOWN`, 'Regular <Romansim Stroke Font>', 'Ref.Des.'], [`VALUE 0 0 0.000 ${levelOf(L.MECH1 + 12) ?? 27} ${labelSize} N LEFT UP`, 'Regular <Romansim Stroke Font>', 'Part Type']].map(font);
    const body = [...pieces.flat(), ...texts.flat(), ...decalLabels.flat(), ...terms, ...stacks];
    const counts = `${pieces.length} ${terms.length} ${terms.length} ${texts.length} ${decalLabels.length}`;
    // The same footprint placed again (its coordinates a few BASIC units off by AD's rounding): the same decal
    const key = `${counts}\n${body.join('\n').replace(/-?\d{3,}/g, (v) => String(Math.round(Number(v) / 100)))}`;
    const base = libName(isFree ? 'FREEPAD' : c!.pattern || `DECAL_${ref}`);
    let decal = decals.get(key);
    if (!decal) {
      let nm = base;
      for (let k = 2; decalNames.has(nm); k++) nm = `${base.slice(0, 36)}_${k}`;
      decalNames.add(nm);
      decal = { name: nm, key, lines: [`${nm} ${units === 'METRIC' ? 'M' : 'I'} 0 0 ${counts}`, ...body] };
      decals.set(key, decal);
    }
    // The part's labels: its designator and comment where they are
    const labels: string[] = [];
    const label = (t: PcbText | undefined, visible: boolean, what: string) => {
      if (!t) { labels.push(...font([`${visible ? 'VALUE' : 'NONE'} 0 0 0.000 ${bottom ? levelOf(L.BOTTOM_OVERLAY) ?? 29 : levelOf(L.TOP_OVERLAY) ?? 26} ${labelSize} N LEFT DOWN`, 'Regular <Romansim Stroke Font>', what])); return; }
      const lv = levelOf(f.lay(t.layer)) ?? levelOf(L.TOP_OVERLAY) ?? 26;
      labels.push(...textEntry(t, f, lv, what, visible));
    };
    label(des, c ? c.nameOn : false, 'Ref.Des.');
    label(com, c ? c.commentOn : false, 'Part Type');
    const comment = c ? (com?.text ?? c.bag.get('COMMENT') ?? c.bag.get('SOURCELIBREFERENCE') ?? '') : '';
    parts.push({ ref, decal: decal.name, type: '', comment, at, ori: bottom ? norm(180 - rotation) : norm(rotation), bottom, glued: c ? c.bag.bool('LOCKED') : false, labels, pins, libRef: padsUnits && c ? c.bag.get('SOURCELIBREFERENCE') || undefined : undefined });
  }
  if (freeN) tally.add('Free pads written as parts of their own (FREEPAD)');

  /* ── part types: one for each comment and decal ── */
  const types = new Map<string, { name: string; decal: string; pins: string[] }>();
  const typeNames = new Set<string>();
  for (const p of parts) {
    const key = `${p.libRef ?? p.comment}\n${p.decal}\n${p.pins.join(' ')}`;
    let t = types.get(key);
    if (!t) {
      const want = p.libRef || p.comment || p.decal;
      let nm = libName(want);
      if (typeNames.has(nm)) nm = libName(`${want}_${p.decal}`);
      for (let k = 2; typeNames.has(nm); k++) nm = `${libName(want, 36)}_${k}`;
      typeNames.add(nm);
      t = { name: nm, decal: p.decal, pins: p.pins };
      types.set(key, t);
    }
    p.type = t.name;
  }

  /* ── vias ── */
  const viaDefs = new Map<string, { name: string; lines: string[] }>();
  const viaName = (v: PcbVia): string => {
    const s0 = Math.max(1, (copper.indexOf(v.layerStart) + 1) || 1), s1 = (copper.indexOf(v.layerEnd) + 1) || N;
    const [a, b] = [Math.min(s0, s1), Math.max(s0, s1)];
    const through = a === 1 && b === N;
    const key = `${B(v.diameter)}:${B(v.hole)}:${through ? '' : `${a}-${b}`}`;
    let d = viaDefs.get(key);
    if (!d) {
      const nm = viaDefs.size === 0 && through ? 'STANDARDVIA' : `VIA${viaDefs.size + 1}_${Math.round(v.diameter / 1e4)}_${Math.round(v.hole / 1e4)}`;
      const rows = [`-2 ${B(v.diameter)} R`, `-1 ${B(v.diameter)} R`, `0 ${B(v.diameter)} R`];
      d = { name: nm, lines: [`${nm} ${B(v.hole)} ${rows.length}${through ? '' : ` ${a} ${b}`}`, ...rows] };
      viaDefs.set(key, d);
    }
    return d.name;
  };

  /* ── routes ── */
  interface RNode { at: Vec2; pin?: string; via?: PcbVia; viaName?: string; edges: number[] }
  interface REdge { a: number; b: number; pa: Vec2; pb: Vec2; layer: LayerId; width: number; arc?: { c: Vec2; r: number; ccwFromA: boolean }; prim: PcbTrack | PcbArc; used: boolean }
  const routeLines: string[] = [];
  const copperLines: string[][] = [];
  /** Each line item's primitives (the trace's). */
  const itemPrims = new Map<string[], PcbPrim[]>();
  const item = (to: string[][], lines: string[], prims: PcbPrim[]) => { to.push(lines); itemPrims.set(lines, prims); };
  let lineN = 0;
  const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) <= 50 && Math.abs(a.y - b.y) <= 50;
  const padsByNet = new Map<number, PcbPad[]>(), viasByNet = new Map<number, PcbVia[]>(), linesByNet = new Map<number, (PcbTrack | PcbArc)[]>();
  const push = <T>(m: Map<number, T[]>, k: number, v: T) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const p of doc.prims) {
    if (p.kind === 'pad' && pinOf.has(p) && p.net !== NO_NET) push(padsByNet, p.net, p);
    else if (p.kind === 'via') { if (p.net !== NO_NET) push(viasByNet, p.net, p); else tally.add('Vias on no net left out (PADS\'s vias are in nets\' routes)'); }
    else if ((p.kind === 'track' || p.kind === 'arc') && isCopper(p.layer) && !isPlane(p.layer) && !p.keepout && (p.polygon === NO_NET || p.polygon < 0) && (p.component === NO_NET || p.component < 0)) {
      if (p.net !== NO_NET && !opts.trace?.notRouted?.(p)) push(linesByNet, p.net, p);
    }
  }
  const padLayers = (p: PcbPad, l: LayerId) => p.layer === L.MULTI || p.layer === l;
  const padStackOn = (p: PcbPad, l: LayerId) => (l === L.TOP ? p.top : l === L.BOTTOM ? p.bot : p.mid);
  const viaOn = (v: PcbVia, l: LayerId) => { const i = copper.indexOf(l), a = copper.indexOf(v.layerStart), b = copper.indexOf(v.layerEnd); return i >= Math.min(a, b) && i <= Math.max(a, b); };
  const corner = (p: Vec2, layer: number, width: number, extra = '') => { const q = X(p); return `${q.x} ${q.y} ${layer} ${B(width)} 0${extra ? ` ${extra}` : ''}`; };
  const levelOfCu = (l: LayerId) => copper.indexOf(l) + 1;

  const allNets = new Set<number>([...padsByNet.keys(), ...viasByNet.keys(), ...linesByNet.keys()]);
  for (const net of [...allNets].sort((a, b) => a - b)) {
    const nm = netOf(net);
    if (!nm) continue;
    const pads = padsByNet.get(net) ?? [], vias = viasByNet.get(net) ?? [], lines = linesByNet.get(net) ?? [];
    const nodes: RNode[] = [];
    const edges: REdge[] = [];
    pads.forEach((p) => nodes.push({ at: p.at, pin: pinOf.get(p), edges: [] }));
    vias.forEach((v) => nodes.push({ at: v.at, via: v, viaName: viaName(v), edges: [] }));
    const junction = new Map<string, number>();
    const nodeAt = (e: Vec2, layer: LayerId): number => {
      let best = -1, bestD = Infinity;
      pads.forEach((p, i) => {
        if (!padLayers(p, layer)) return;
        const d = Math.hypot(e.x - p.at.x, e.y - p.at.y);
        if (d < bestD && (d <= 50 || pointInPoly(e, padOutline(p.at, padStackOn(p, layer), p.rotation)))) { best = i; bestD = d; }
      });
      if (best >= 0) return best;
      vias.forEach((v, i) => { const d = Math.hypot(e.x - v.at.x, e.y - v.at.y); if (viaOn(v, layer) && d <= v.diameter / 2 && d < bestD) { best = pads.length + i; bestD = d; } });
      if (best >= 0) return best;
      const key = `${layer}:${Math.round(e.x / 100)}:${Math.round(e.y / 100)}`;
      let j = junction.get(key);
      if (j === undefined) { j = nodes.length; nodes.push({ at: e, edges: [] }); junction.set(key, j); }
      return j;
    };
    for (const p of lines) {
      const [pa, pb] = p.kind === 'track' ? [p.a, p.b] : [arcEnd(p, p.start), arcEnd(p, p.start + sweepOf(p))];
      if (p.kind === 'arc' && sweepOf(p) >= 360) { item(copperLines, [itemHead(`ARC${++lineN}`, 'COPPER', 1, 0, nm), ...circle('COPCIR', p.c, p.r, p.width, levelOfCu(p.layer), boardFrame)], [p]); continue; }
      const a = nodeAt(pa, p.layer), b = nodeAt(pb, p.layer);
      const e: REdge = { a, b, pa, pb, layer: p.layer, width: p.width, prim: p, used: false, ...(p.kind === 'arc' ? { arc: { c: p.c, r: p.r, ccwFromA: true } } : {}) };
      nodes[a]!.edges.push(edges.length); nodes[b]!.edges.push(edges.length);
      edges.push(e);
    }
    // A track ending on another's side (no corner there): the other split there
    for (const [, j] of junction) {
      const n = nodes[j]!;
      if (n.edges.length !== 1) continue;
      const layer = edges[n.edges[0]!]!.layer;
      for (let k = 0; k < edges.length; k++) {
        const e = edges[k]!;
        if (e.arc || e.layer !== layer || e.a === j || e.b === j) continue;
        const dx = e.pb.x - e.pa.x, dy = e.pb.y - e.pa.y, l2 = dx * dx + dy * dy;
        if (!l2) continue;
        const t = ((n.at.x - e.pa.x) * dx + (n.at.y - e.pa.y) * dy) / l2;
        if (t <= 0.001 || t >= 0.999) continue;
        const q = { x: e.pa.x + t * dx, y: e.pa.y + t * dy };
        if (Math.hypot(q.x - n.at.x, q.y - n.at.y) > Math.max(e.width, edges[n.edges[0]!]!.width) / 2) continue;
        // e becomes a → j, a new edge j → b
        const tail: REdge = { a: j, b: e.b, pa: n.at, pb: e.pb, layer, width: e.width, prim: e.prim, used: false };
        nodes[e.b]!.edges = nodes[e.b]!.edges.map((x) => (x === k ? edges.length : x));
        e.b = j; e.pb = n.at;
        n.edges.push(k, edges.length);
        edges.push(tail);
        break;
      }
    }
    const other = (e: REdge, n: number) => (e.a === n ? e.b : e.a);
    const endAt = (e: REdge, n: number) => (e.a === n ? e.pa : e.pb);
    /** A path's corners, from its first node to its last (a pin): each corner's layer the next stretch's, the last 65. */
    const pathLines = (ns: number[], es: number[], tail?: number): string[] => {
      interface Move { to: Vec2; layer: LayerId; width: number; arc?: { c: Vec2; ccw: boolean }; via?: string }
      const moves: Move[] = [];
      let pos = nodes[ns[0]!]!.at;
      es.forEach((ei, i) => {
        const e = edges[ei]!, u = ns[i]!, v = ns[i + 1]!;
        const s = endAt(e, u), t = endAt(e, v);
        if (!same(pos, s)) moves.push({ to: s, layer: e.layer, width: e.width });
        moves.push({ to: t, layer: e.layer, width: e.width, ...(e.arc ? { arc: { c: e.arc.c, ccw: e.a === u } } : {}) });
        pos = t;
        const vn = nodes[v]!;
        if (i < es.length - 1 && (vn.via || vn.pin) && !same(pos, vn.at)) { moves.push({ to: vn.at, layer: e.layer, width: e.width }); pos = vn.at; }
        if (i < es.length - 1 && vn.via) moves[moves.length - 1]!.via = vn.viaName;
      });
      const last = nodes[ns[ns.length - 1]!]!;
      if (!same(pos, last.at)) moves.push({ to: last.at, layer: moves[moves.length - 1]!.layer, width: moves[moves.length - 1]!.width });
      if (last.via) moves[moves.length - 1]!.via = last.viaName;
      const first = nodes[ns[0]!]!;
      const out: string[] = [corner(first.at, levelOfCu(moves[0]!.layer), moves[0]!.width, first.via ? first.viaName : '')];
      moves.forEach((m, i) => {
        if (m.arc) out.push(corner(m.arc.c, levelOfCu(m.layer), m.width, m.arc.ccw ? 'CCW' : 'CW'));
        const nx = moves[i + 1];
        // The end: a pin (65), or a via left by an unrouted hop to a pin
        out.push(corner(m.to, nx ? levelOfCu(nx.layer) : tail !== undefined ? 0 : 65, nx ? nx.width : m.width, m.via ?? ''));
      });
      if (tail !== undefined) out.push(corner(nodes[tail]!.at, 65, moves[moves.length - 1]!.width));
      return out;
    };
    // Islands: each pin joined to the nearest pin before it (breadth first from the island's first pin)
    const seen = new Int32Array(nodes.length).fill(-1);
    const islands: number[][] = [];
    for (let s = 0; s < nodes.length; s++) {
      if (seen[s] !== -1) continue;
      const order = [s];
      seen[s] = islands.length;
      for (let k = 0; k < order.length; k++) for (const ei of nodes[order[k]!]!.edges) { const o = other(edges[ei]!, order[k]!); if (seen[o] === -1) { seen[o] = islands.length; order.push(o); } }
      islands.push(order);
    }
    const conns: string[][] = [];
    const padIslands: { pins: number[]; island: number }[] = [];
    const hopVias: number[] = [];
    /** The net's pin nearest a place, of another island than `not`'s where there is one (and not `except`). */
    const nearestPin = (at: Vec2, not: number, except = -1): number => {
      let best = -1, bestD = Infinity, own = -1, ownD = Infinity;
      for (let p = 0; p < pads.length; p++) {
        if (p === except || !nodes[p]!.pin) continue;
        const d = Math.hypot(nodes[p]!.at.x - at.x, nodes[p]!.at.y - at.y);
        if (seen[p] !== not) { if (d < bestD) { bestD = d; best = p; } } else if (d < ownD) { ownD = d; own = p; }
      }
      return best >= 0 ? best : own;
    };
    /** Islands an unrouted hop already joins (PADS's partial routes): not joined again below. */
    const hopJoins: [number, number][] = [];
    /** A walk along copper not taken yet, from `s`: its nodes and edges. */
    const walk = (s: number): { ns: number[]; es: number[] } => {
      const ns = [s], es: number[] = [];
      for (let at = s; ;) {
        const ei = nodes[at]!.edges.find((k) => !edges[k]!.used);
        if (ei === undefined) break;
        edges[ei]!.used = true;
        at = other(edges[ei]!, at);
        es.push(ei); ns.push(at);
      }
      return { ns, es };
    };
    for (const [ii, island] of islands.entries()) {
      const pinNodes = island.filter((n) => nodes[n]!.pin);
      if (!pinNodes.length) {
        for (const n of island) for (const ei of nodes[n]!.edges) edges[ei]!.used = false;
        // Copper of the net that reaches no pin (a route cut in two): each stretch a partial route, an unrouted hop from the nearest pin to it and from it to the next nearest
        if (pads.length >= 2) {
          const ends = () => island.filter((n) => nodes[n]!.edges.some((k) => !edges[k]!.used)).sort((a, b) => nodes[a]!.edges.filter((k) => !edges[k]!.used).length - nodes[b]!.edges.filter((k) => !edges[k]!.used).length);
          for (let start = ends()[0]; start !== undefined; start = ends()[0]) {
            const { ns, es } = walk(start);
            if (!es.length) break;
            const a = nearestPin(nodes[ns[0]!]!.at, -1), b = nearestPin(nodes[ns[ns.length - 1]!]!.at, -1, a);
            if (a < 0 || b < 0) break;
            const w = edges[es[0]!]!.width;
            conns.push([`${nodes[a]!.pin} ${nodes[b]!.pin}`, corner(nodes[a]!.at, 0, w), ...pathLines(ns, es, b)]);
            hopJoins.push([seen[a]!, seen[b]!]);
          }
        }
        hopVias.push(...island.filter((n) => nodes[n]!.via && nodes[n]!.edges.every((k) => !edges[k]!.used)));
        continue;
      }
      padIslands.push({ pins: pinNodes, island: ii });
      const root = pinNodes[0]!;
      const parent = new Map<number, { n: number; e: number }>();
      const order = [root];
      const visited = new Set([root]);
      for (let k = 0; k < order.length; k++) {
        const u = order[k]!;
        for (const ei of nodes[u]!.edges) { const o = other(edges[ei]!, u); if (!visited.has(o)) { visited.add(o); parent.set(o, { n: u, e: ei }); order.push(o); } }
      }
      const covered = new Set<number>();
      /** The way up the tree from `n` to the first pin above it. */
      const upToPin = (n: number) => {
        const ns = [n], es: number[] = [];
        let cur = n;
        while (cur !== root) {
          const up = parent.get(cur)!;
          es.push(up.e); ns.push(up.n); cur = up.n;
          if (nodes[cur]!.pin) break;
        }
        for (const ei of es) edges[ei]!.used = true;
        for (const x of ns) covered.add(x);
        return { ns: ns.reverse(), es: es.reverse() };
      };
      for (const pn of order) {
        if (pn === root || !nodes[pn]!.pin) continue;
        const { ns, es } = upToPin(pn);
        conns.push([`${nodes[ns[0]!]!.pin} ${nodes[ns[ns.length - 1]!]!.pin}`, ...pathLines(ns, es)]);
      }
      // Vias at the ends of stubs (to planes and pours): reached from the pin above them, then an unrouted hop to the nearest other pin (as PADS keeps plane connections)
      for (const vn of order) {
        if (!nodes[vn]!.via || covered.has(vn)) continue;
        const { ns, es } = upToPin(vn);
        const from = ns[0]!;
        let to = from, best = Infinity;
        for (const p of nodes.keys()) {
          if (!nodes[p]!.pin || p === from) continue;
          const d = Math.hypot(nodes[p]!.at.x - nodes[vn]!.at.x, nodes[p]!.at.y - nodes[vn]!.at.y);
          if (d < best) { best = d; to = p; }
        }
        conns.push([`${nodes[from]!.pin} ${nodes[to]!.pin}`, ...pathLines(ns, es, to)]);
      }
      // Copper that ends short of a pin (a stub where a track was taken away): from the pin above it to its end, then an unrouted hop to the nearest pin (of another island where there is one)
      for (const tip of order) {
        if (covered.has(tip) || nodes[tip]!.pin || nodes[tip]!.edges.length !== 1) continue;
        const { ns, es } = upToPin(tip);
        if (!nodes[ns[0]!]!.pin) continue;
        const to = nearestPin(nodes[tip]!.at, ii, ns[0]!);
        if (to < 0) continue;
        conns.push([`${nodes[ns[0]!]!.pin} ${nodes[to]!.pin}`, ...pathLines(ns, es, to)]);
        hopJoins.push([ii, seen[to]!]);
      }
      // Copper closing a loop (a second way between two places already joined): a route from the pin above one end, along it, to the pin above the other
      for (const u of order) {
        for (;;) {
          if (!nodes[u]!.edges.some((k) => !edges[k]!.used)) break;
          const chain = walk(u);
          const v = chain.ns[chain.ns.length - 1]!;
          const a = upToPin(u), b = upToPin(v);
          const p1 = a.ns[0]!, p2 = b.ns[0]!;
          if (!nodes[p1]!.pin || !nodes[p2]!.pin || p1 === p2) { for (const e of chain.es) edges[e]!.used = false; break; }
          conns.push([`${nodes[p1]!.pin} ${nodes[p2]!.pin}`, ...pathLines([...a.ns, ...chain.ns.slice(1), ...b.ns.slice(0, -1).reverse()], [...a.es, ...chain.es, ...b.es.slice().reverse()])]);
        }
      }
    }
    // Copper on no pin-to-pin path: the net's copper among the line items
    // (a stretch with both ends in one pad or via: inside its copper, as the routes' own way into it)
    for (const e of edges) if (!e.used && e.a === e.b && (nodes[e.a]!.pin || nodes[e.a]!.via)) e.used = true;
    const left = edges.filter((e) => !e.used);
    if (left.length) item(copperLines, [itemHead(`CU${++lineN}`, 'COPPER', left.length, 0, nm), ...left.flatMap((e) => piece('COPOPN', lineCorners(e.prim.kind === 'track' ? { ...e.prim, a: e.pa, b: e.pb } : e.prim, boardFrame), e.width, levelOfCu(e.layer)))], left.map((e) => e.prim));
    // Islands joined by unrouted connections (nearest pins first), but those a partial route's hop joins already
    const defaultWidth = mil(10);
    if (padIslands.length > 1) {
      const up = padIslands.map((_, i) => i);
      const find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i]!)));
      const ofIsland = new Map(padIslands.map((p, i) => [p.island, i]));
      for (const [x, y] of hopJoins) { const a = ofIsland.get(x), b = ofIsland.get(y); if (a !== undefined && b !== undefined) up[find(a)] = find(b); }
      const inTree = padIslands.map((_, i) => i).filter((i) => find(i) === find(0));
      const rest = padIslands.map((_, i) => i).filter((i) => find(i) !== find(0));
      while (rest.length) {
        let best: { r: number; a: number; b: number; d: number } | null = null;
        for (const ri of rest) for (const ti of inTree) for (const a of padIslands[ti]!.pins) for (const b of padIslands[ri]!.pins) {
          const d = Math.hypot(nodes[a]!.at.x - nodes[b]!.at.x, nodes[a]!.at.y - nodes[b]!.at.y);
          if (!best || d < best.d) best = { r: ri, a, b, d };
        }
        conns.push([`${nodes[best!.a]!.pin} ${nodes[best!.b]!.pin}`, corner(nodes[best!.a]!.at, 0, defaultWidth), corner(nodes[best!.b]!.at, 65, defaultWidth)]);
        // (with the islands joined to it already)
        const joined = rest.filter((i) => find(i) === find(best!.r));
        for (const j of joined) { inTree.push(j); rest.splice(rest.indexOf(j), 1); }
      }
    }
    // Vias on no pin's copper: visited by unrouted hops between two of the net's pins
    if (hopVias.length) {
      const pinsAll = padIslands.flatMap((x) => x.pins);
      if (pinsAll.length >= 2) {
        const a = pinsAll[0]!, b = pinsAll[1]!;
        const out = [`${nodes[a]!.pin} ${nodes[b]!.pin}`, corner(nodes[a]!.at, 0, defaultWidth)];
        let pos = nodes[a]!.at;
        const todo = hopVias.slice();
        while (todo.length) {
          let k = 0;
          todo.forEach((n, i) => { if (Math.hypot(nodes[n]!.at.x - pos.x, nodes[n]!.at.y - pos.y) < Math.hypot(nodes[todo[k]!]!.at.x - pos.x, nodes[todo[k]!]!.at.y - pos.y)) k = i; });
          const n = todo.splice(k, 1)[0]!;
          out.push(corner(nodes[n]!.at, 0, defaultWidth, nodes[n]!.viaName));
          pos = nodes[n]!.at;
        }
        out.push(corner(nodes[b]!.at, 65, defaultWidth));
        conns.push(out);
      } else tally.add('Vias of nets with fewer than two pins left out (PADS keeps vias in routes between pins)');
    }
    if (conns.length) { routeLines.push(`*SIGNAL* ${nm} 0 -2`); for (const c of conns) for (const l of c) routeLines.push(l); }
    // A net of one pin: the pin alone [est: KiCad's reader and Konium's take it]
    else if (pads.length === 1) routeLines.push(`*SIGNAL* ${nm} 0 -2`, `${pinOf.get(pads[0]!)}`);
  }

  /* ── pours ── */
  const pourLines: string[] = [];
  const W = mil(1);
  const path = (pts: Vec2[]) => pts.map((p) => ({ X: Math.round(p.x), Y: Math.round(p.y) }));
  const offset = (paths: ClipperNS.IntPoint[][], d: number, open = false) => { const co = new C.ClipperOffset(2, 250); co.AddPaths(paths, C.JoinType.jtRound, open ? C.EndType.etOpenRound : C.EndType.etClosedPolygon); const out: ClipperNS.IntPoint[][] = []; co.Execute(out, d); return out; };
  /** Copper as PADS's poured outlines (each shrunk by half the outline's width) and voids (grown by as much). */
  const pourCopper = (paths: ClipperNS.IntPoint[][]): { outer: Vec2[]; voids: Vec2[][] }[] => {
    const cl = new C.Clipper();
    cl.AddPaths(paths, C.PolyType.ptSubject, true);
    const tree = new C.PolyTree();
    cl.Execute(C.ClipType.ctUnion, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    const out: { outer: Vec2[]; voids: Vec2[][] }[] = [];
    const walk = (node: ClipperNS.PolyNode) => {
      for (const o of node.Childs()) {
        for (const shrunk of offset([o.Contour()], -W / 2)) {
          // Slivers a thin neck leaves when shrunk: left out
          if (Math.abs(C.Clipper.Area(shrunk)) < 4 * mil(1) * mil(1)) continue;
          const voids = o.Childs().flatMap((h) => offset([h.Contour()], W / 2)).filter((v) => v.length >= 3).map((v) => v.map((q) => ({ x: q.X, y: q.Y })));
          out.push({ outer: shrunk.map((q) => ({ x: q.X, y: q.Y })), voids });
        }
        for (const h of o.Childs()) walk(h);
      }
    };
    walk(tree);
    return out;
  };
  let pourN = 0;
  const pourRecords = (owner: string, net: string, lv: number, outline: CornerOut[], cutouts: string[][], copperOf: { outer: Vec2[]; voids: Vec2[][] }[], priority: number) => {
    const poly = (type: string, cs: CornerOut[]) => {
      const lines: string[] = [];
      cs.forEach((c) => { lines.push(`${c.x} ${c.y}`); if (c.arc) lines.push(`${c.arc.cx} ${c.arc.cy} ${Math.round(norm(c.arc.a0) * 10)} ${Math.round(c.arc.sweep * 10)}`); });
      return [`${type} ${cs.length} ${cs.filter((c) => c.arc).length} ${B(W)} ${lv}`, ...lines];
    };
    const add = (l: string[]) => { for (const x of l) pourLines.push(x); };
    add([`${owner} POUROUT 0 0 ${1 + cutouts.length} 0 ${owner} ${net}${priority ? ` ${B(mil(10))} 0 ${priority}` : ''}`]);
    add(poly('POLY', outline));
    for (const c of cutouts) add(c);
    copperOf.forEach((cp) => {
      const hat = `HAT${++pourN}`;
      add([`${hat} HATOUT 0 0 1 8 ${owner}`]);
      add(poly('POLY', ringCorners(cp.outer, boardFrame)));
      cp.voids.forEach((v) => { add([`VOID${++pourN} VOIDOUT 0 0 1 128 ${hat}`]); add(poly('POLY', ringCorners(v, boardFrame))); });
    });
  };
  const cutoutsOn = (layer: LayerId) => doc.prims.filter((p): p is PcbRegion => p.kind === 'region' && p.regionKind === 1 && p.layer === layer && p.outline.length >= 3);
  const polyPrims = new Map<number, PcbPrim[]>();
  for (const p of doc.prims) if ((p.kind === 'region' || p.kind === 'track' || p.kind === 'arc') && p.polygon !== NO_NET && p.polygon >= 0) push(polyPrims, p.polygon, p);
  doc.polygons.forEach((pg, i) => {
    if (!isCopper(pg.layer) || isPlane(pg.layer) || pg.vertices.length < 2) return;
    const lv = levelOfCu(pg.layer);
    if (lv <= 0) return;
    const owner = `POR${i + 1}`;
    const net = netOf(pg.net) ?? '';
    const paths: ClipperNS.IntPoint[][] = [];
    for (const p of polyPrims.get(i) ?? []) {
      if (p.kind === 'region') {
        const cl = new C.Clipper();
        cl.AddPaths([path(p.outline)], C.PolyType.ptSubject, true);
        if (p.holes.length) cl.AddPaths(p.holes.map(path), C.PolyType.ptClip, true);
        const out: ClipperNS.IntPoint[][] = [];
        cl.Execute(C.ClipType.ctDifference, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
        paths.push(...out);
      } else if (p.kind === 'track') paths.push(...offset([path([p.a, p.b])], p.width / 2, true));
      else if (p.kind === 'arc') paths.push(...offset([path(arcPoints(p.c, p.r, p.r, p.start, p.start + sweepOf(p)))], p.width / 2, true));
    }
    if (pg.hatch && !/solid/i.test(pg.hatch) && !paths.length) tally.add('Hatched pours written unpoured (PADS floods them)');
    const ob = pg.outline;
    const near = (r: PcbRegion) => r.outline.some((q) => q.x >= Math.min(...ob.map((o) => o.x)) && q.x <= Math.max(...ob.map((o) => o.x)) && q.y >= Math.min(...ob.map((o) => o.y)) && q.y <= Math.max(...ob.map((o) => o.y)));
    const cuts = cutoutsOn(pg.layer).filter(near).map((r) => { const cs = ringCorners(r.outline, boardFrame); return [`POCUT ${cs.length} 0 ${B(W)} ${lv}`, ...cs.map((c) => `${c.x} ${c.y}`)]; });
    const from = pourLines.length;
    pourRecords(owner, net, lv, vertexCorners(pg.vertices, boardFrame), cuts, pourCopper(paths), Number(pg.bag.get('POURINDEX') ?? 0) || 0);
    opts.trace?.pours.push({ polygon: i, lines: pourLines.slice(from) });
  });

  /* ── planes: a plane's net, or a split plane's areas as poured plane areas ── */
  const planeNet = new Map<LayerId, string>();
  const mixed = new Set<LayerId>();
  for (const l of copper) {
    if (!isPlane(l)) continue;
    const net = doc.board.bag?.get(`PLANE${l - L.PLANE1 + 1}NETNAME`) ?? '';
    const splits = doc.polygons.filter((p) => p.layer === l && /split/i.test(p.type));
    if (!splits.length) { const i = doc.nets.findIndex((n) => n.name === net); planeNet.set(l, i >= 0 ? netOf(i)! : netNameOf(net)); continue; }
    mixed.add(l);
    const lv = levelOfCu(l);
    // Each split's area (its outline) poured with the plane's copper inside it; the rest the plane net's, inside the board
    const areas: { outline: CornerOut[]; net: string; within: (p: Vec2) => boolean; paths: ClipperNS.IntPoint[][] }[] = splits.map((sp) => ({
      outline: vertexCorners(sp.vertices, boardFrame), net: netOf(sp.net) ?? '', within: (q: Vec2) => pointInPoly(q, sp.outline), paths: [] }));
    const rest = { outline: vertexCorners(doc.board.vertices, boardFrame), net: (() => { const i = doc.nets.findIndex((n) => n.name === net); return i >= 0 ? netOf(i)! : netNameOf(net); })(), within: () => true, paths: [] as ClipperNS.IntPoint[][] };
    for (const a of planeCopper(doc, l)) {
      for (const r of a.regions) {
        const cl = new C.Clipper();
        cl.AddPaths([path(r.outline)], C.PolyType.ptSubject, true);
        if (r.holes.length) cl.AddPaths(r.holes.map(path), C.PolyType.ptClip, true);
        const paths: ClipperNS.IntPoint[][] = [];
        cl.Execute(C.ClipType.ctDifference, paths, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
        const nm = netOf(a.net) ?? '';
        const at = r.outline[0]!;
        let area = areas.find((x) => x.net === nm && x.within(at)) ?? areas.find((x) => x.net === nm) ?? (nm === rest.net ? rest : undefined);
        if (!area) { area = { outline: ringCorners(r.outline, boardFrame), net: nm, within: (q: Vec2) => pointInPoly(q, r.outline), paths: [] }; areas.push(area); }
        area.paths.push(...paths);
      }
    }
    for (const a of [...areas, rest]) {
      const cu = pourCopper(a.paths);
      if (cu.length) pourRecords(`PLN${++pourN}`, a.net, lv, a.outline, [], cu, 0);
    }
    tally.add('Split planes written as mixed planes with their areas poured');
  }

  /* ── free items: the board, copper, keep-outs, drafting, text ── */
  const lineItems: string[][] = [...copperLines];
  const boardPieces: string[][] = [];
  if (doc.board.vertices.length >= 2) boardPieces.push(piece('CLOSED', vertexCorners(doc.board.vertices, boardFrame), mil(1), 0));
  const textLines: string[] = [];
  for (const p of freePrims) {
    if ((p.kind === 'pad' && freePads.includes(p)) || p.kind === 'via' || p.kind === 'body') continue;
    if (p.kind === 'region' && p.boardCutout) { if (p.outline.length >= 3) boardPieces.push(piece('CLOSED', ringCorners(p.outline, boardFrame), mil(1), 0)); continue; }
    if (p.kind === 'region' && p.regionKind === 1) continue; // polygon cut-outs: with their pours
    if ((p.kind === 'region' || p.kind === 'track' || p.kind === 'arc') && p.polygon !== NO_NET && p.polygon >= 0) continue; // pour copper
    if (p.kind === 'text') {
      if (p.fontType === 2) { tally.add('Barcode text left out'); continue; }
      const l = p.layer === L.KEEPOUT ? null : levelOf(p.layer);
      if (l === null) continue;
      const from = textLines.length;
      p.text.split(/\r?\n/).forEach((line, i) => { if (line) textLines.push(...textEntry({ ...p, at: lineAt(p, i) }, boardFrame, l, line, undefined, true)); });
      opts.trace?.texts.push({ prim: p, lines: textLines.slice(from) });
      continue;
    }
    const keep = ('keepout' in p && p.keepout) || ('layer' in p && p.layer === L.KEEPOUT);
    if (keep) {
      const lv = p.layer === L.KEEPOUT ? 0 : levelOf(p.layer);
      if (lv === null) continue;
      if (p.kind === 'region' && p.outline.length >= 3) item(lineItems, [itemHead(`KO${++lineN}`, 'KEEPOUT', 1), ...piece('KPTCLS', ringCorners(p.outline, boardFrame), 0, lv, 'TVC')], [p]);
      else if (p.kind === 'fill') item(lineItems, [itemHead(`KO${++lineN}`, 'KEEPOUT', 1), ...piece('KPTCLS', ringCorners(fillCorners(p), boardFrame), 0, lv, 'TVC')], [p]);
      else if (p.kind === 'arc' && sweepOf(p) >= 360) item(lineItems, [itemHead(`KO${++lineN}`, 'KEEPOUT', 1), ...circle('KPTCIR', p.c, p.r, 0, lv, boardFrame)], [p]);
      else if (p.layer === L.KEEPOUT) tally.add('Keep-out lines left out (PADS\'s keep-outs are areas)');
      continue;
    }
    if (!('layer' in p)) continue;
    const onCu = isCopper(p.layer);
    if (onCu && (p.kind === 'track' || p.kind === 'arc') && p.net !== NO_NET && !opts.trace?.notRouted?.(p)) continue; // routed
    const ps = drawingPieces(p, boardFrame);
    if (!ps.length) { if (isPlane(p.layer)) tally.add('Lines on internal planes left out'); continue; }
    const net = onCu && 'net' in p ? netOf(p.net) : undefined;
    // Filled shapes are copper items whatever their layer (as PADS keeps a filled silkscreen shape)
    const filled = onCu || ps.some((x) => /^COP/.test(x[0]!));
    item(lineItems, [itemHead(`${filled ? 'CU' : 'DRW'}${++lineN}`, filled ? 'COPPER' : 'LINES', ps.length, 0, net), ...ps.flat()], [p]);
  }
  if (opts.trace) for (const l of lineItems) opts.trace.items.push({ prims: itemPrims.get(l) ?? [], lines: l });
  if (boardPieces.length) lineItems.unshift([itemHead('BOARD', 'BOARD', boardPieces.length), ...boardPieces.flat()]);
  // Dimensions: their lines, arcs and value as drafting
  const edgeOf = dimensionEdges(doc.prims);
  doc.dimensions.forEach((d) => {
    const lv = levelOf(d.layer);
    if (lv === null) return;
    const g = dimensionGeometry(d, false, edgeOf);
    const ps = [...g.lines.map((l) => piece('OPEN', [X(l.a), X(l.b)], l.w, lv)),
      ...g.arcs.map((a) => (norm(a.end - a.start) || 360) >= 360 ? circle('CIRCLE', a.c, a.r, a.w, lv, boardFrame) : piece('OPEN', lineCorners({ kind: 'arc', c: a.c, r: a.r, start: a.start, end: a.end, width: a.w } as PcbArc, boardFrame), a.w, lv))];
    const ts = g.texts.map((t) => textEntry({ kind: 'text', at: t.at, height: t.height, rotation: t.rotation, mirrored: t.mirrored, strokeWidth: t.w, fontType: 0 } as PcbText, boardFrame, lv, t.text));
    lineItems.push([itemHead(`DIM${++lineN}`, 'LINES', ps.length, ts.length), ...ps.flat(), ...ts.flat()]);
  });

  /* ── rules ── */
  const general = (kind: string) => doc.rules.filter((r) => ruleKind(r) === kind && ruleEnabled(r) && /^\s*All\s*$/i.test(ruleScope1(r)) && /^\s*All\s*$/i.test(ruleScope2(r)))[0];
  const clr = general('Clearance'), wid = general('Width'), hh = general('HoleToHoleClearance'), edge = general('BoardOutlineClearance');
  const gap = B(clr ? ruleLength(clr, 'GAP', '10mil') : mil(10));
  const [wMin, wRec, wMax] = wid ? [B(ruleLength(wid, 'MINLIMIT', '10mil')), B(ruleLength(wid, 'PREFEREDWIDTH', '10mil')), B(ruleLength(wid, 'MAXLIMIT', '10mil'))] : [B(mil(8)), B(mil(10)), B(mil(100))];
  const outlineGap = edge ? B(ruleLength(edge, 'GAP', '10mil')) : gap;

  /* ── stack-up ── */
  const stackRows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [];
  const layerData: string[] = ['LAYER DATA', '{', 'LAYER 0', '{', 'LAYER_THICKNESS 0', 'DIELECTRIC 3.300000', '}'];
  for (let n = 1; n <= 30; n++) {
    const cuLayer = copper[n - 1];
    const lines: string[] = [];
    if (cuLayer !== undefined) {
      const i = stackRows.findIndex((r) => r.layer === cuLayer);
      const row = stackRows[i];
      const diel = stackRows.slice(i + 1).find((r) => r.kind === 'dielectric');
      const plane = isPlane(cuLayer);
      lines.push(`LAYER_NAME ${(doc.board.layerNames.get(cuLayer) ?? row?.name ?? layerName(cuLayer)).replace(/[{}]/g, '')}`, 'LAYER_TYPE ROUTING', `PLANE ${plane ? (mixed.has(cuLayer) ? 'MIXED' : 'CAM') : 'NONE'}`);
      if (n === 1 || n === N) lines.push('COMPONENT Y');
      if (plane && planeNet.get(cuLayer)) lines.push(`NET ${planeNet.get(cuLayer)}`);
      lines.push(`LAYER_THICKNESS ${diel && n < N ? B(diel.height) : 0}`, `COPPER_THICKNESS ${row ? B(row.copper) : B(mil(1.4))}`, `DIELECTRIC ${(diel?.dielConst || 4.2).toFixed(6)}`);
    } else {
      const nm = names.get(n);
      lines.push(`LAYER_NAME ${nm?.[0] ?? `Layer_${n}`}`, `LAYER_TYPE ${nm?.[1] ?? 'UNASSIGNED'}`, 'PLANE NONE');
    }
    layerData.push(`LAYER ${n}`, '{', ...lines, '}');
  }
  layerData.push('}');

  /* ── the file ── */
  const out: string[] = [];
  const w = (...l: (string | string[])[]) => { for (const x of l) if (typeof x === 'string') out.push(x); else for (const y of x) out.push(y); };
  const via0 = [...viaDefs.values()][0]?.name ?? 'STANDARDVIA';
  const pcbHead: [string, string][] = [
    ['UNITS', UNIT_OUT[units].code], ['USERGRID', `${B(mil(1))} ${B(mil(1))}`], ['MAXIMUMLAYER', String(N)], ['WORKLEVEL', '1'], ['DISPLAYLEVEL', '1'], ['LAYERPAIR', `1 ${N}`], ['VIAMODE', 'A'],
    ['LINEWIDTH', String(wRec)], ['TEXTSIZE', `${B(mil(100))} ${B(mil(10))}`], ['JOBTIME', '0'], ['DOTGRID', `${B(mil(1))} ${B(mil(1))}`], ['SCALE', '1.000'], ['ORIGIN', `${X(doc.board.origin).x} ${X(doc.board.origin).y}`], ['WINDOWCENTER', '0 0'],
    ['BACKUPTIME', '20'], ['REAL WIDTH', '1500'], ['ALLSIGONOFF', '1'], ['REFNAMESIZE', `${B(mil(100))} ${B(mil(10))}`], ['HIGHLIGHT', '0'], ['JOBNAME', `${padsName(name)}.pcb`],
    ['HATCHGRID', String(B(mil(10)))], ['THERLINEWID', String(B(mil(10)))], ['PADFILLWID', String(B(mil(10)))], ['THERSMDWID', String(B(mil(10)))], ['MINHATAREA', '0'], ['HATCHMODE', '0'], ['HATCHDISP', '1'],
    ['DRLOVERSIZE', '0'], ['VIAPSHVIA', via0],
  ];
  w(...(opts.like ? [opts.like.head, `*REMARK* PIECETYPE CORNERS WIDTHHGHT${FMT.lineStyle ? ' LINESTYLE' : ''} LEVEL [RESTRICTIONS]`] : [`!PADS-POWERPCB-V9.5-${units}! DESIGN DATABASE ASCII FILE 1.0`]), '*PCB*        GENERAL PARAMETERS OF THE PCB DESIGN', '', ...pcbHead.map(([k, v]) => `${k.padEnd(12)} ${v}`), '');
  w('*TEXT*       FREE TEXT', '', textLines, '');
  w('*LINES*      LINES ITEMS', '');
  for (const l of lineItems) w(l, '');
  w('*VIA*        ITEMS', '');
  for (const v of viaDefs.values()) w(v.lines, '');
  w('*PARTDECAL*  ITEMS', '');
  for (const d of decals.values()) w(d.lines, '');
  w('*PARTTYPE*   ITEMS', '');
  for (const t of types.values()) {
    w(`${t.name} ${t.decal} UND 0 0 ${t.pins.length} 0 Y`);
    for (let i = 0; i < t.pins.length; i += 10) w(t.pins.slice(i, i + 10).join(' '));
    w('');
  }
  w('*PART*       ITEMS', '');
  for (const p of parts) {
    const q = X(p.at);
    w(`${p.ref} ${p.type} ${q.x} ${q.y} ${deg(p.ori)} ${p.glued ? 'G' : 'U'} ${p.bottom ? 'M' : 'N'} 0 -1 0 -1 ${p.labels.length / 3}`, p.labels);
  }
  w('', '*ROUTE*', '', routeLines, '');
  w('*POUR*       POUR ITEMS', '', pourLines, '');
  w('*MISC*      MISCELLANEOUS PARAMETERS', '');
  w('ATTRIBUTES DICTIONARY', '{', 'ATTRIBUTE Value', '{', 'TYPE FREETEXT N', 'INHERITANCE PART PARTTYPE', 'ECO_REGISTRATION Y', 'READONLY N', 'SYSTEM Y', 'HIDDEN N', '}', '}');
  w('RULES_SECTION PARENT', '{', 'NET_CLASS DATA', 'GROUP DATA', 'ASSOCIATED_NET DATA', 'DESIGN RULES', '{', 'RULE_SET (1)', '{', 'FOR :', '{', 'DEFAULT :', '}', 'AGAINST :', '{', 'DEFAULT :', '}', 'LAYER 0', 'CLEARANCE_RULE :', '{');
  for (const k of ['TRACK_TO_TRACK', 'VIA_TO_TRACK', 'VIA_TO_VIA', 'PAD_TO_TRACK', 'PAD_TO_VIA', 'PAD_TO_PAD', 'SMD_TO_TRACK', 'SMD_TO_VIA', 'SMD_TO_PAD', 'SMD_TO_SMD', 'COPPER_TO_TRACK', 'COPPER_TO_VIA', 'COPPER_TO_PAD', 'COPPER_TO_SMD', 'COPPER_TO_COPPER', 'TEXT_TO_TRACK', 'TEXT_TO_VIA', 'TEXT_TO_PAD', 'TEXT_TO_SMD']) w(`${k} ${gap}`);
  for (const k of ['OUTLINE_TO_TRACK', 'OUTLINE_TO_VIA', 'OUTLINE_TO_PAD', 'OUTLINE_TO_SMD', 'OUTLINE_TO_COPPER']) w(`${k} ${outlineGap}`);
  w(`MIN_TRACK_WIDTH ${wMin}`, `REC_TRACK_WIDTH ${wRec}`, `MAX_TRACK_WIDTH ${wMax}`, `DRILL_TO_DRILL ${hh ? B(ruleLength(hh, 'GAP', '10mil')) : gap}`, '}', '}', '}', '}');
  w(layerData);
  w('ATTRIBUTE VALUES', '{');
  for (const p of parts) if (p.comment) w(`PART ${p.ref}`, '{', `Value ${p.comment.replace(/\r?\n/g, ' ')}`, '}');
  w('}', '', '*END*     OF ASCII OUTPUT FILE', '');
  warnings.push(...tally.list());
  const text = out.join('\r\n');
  return { text, bytes: binToBytes(toCp1252Lossy(text)), warnings };
}
