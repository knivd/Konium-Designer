/**
 * Polygon pads (Tools › Convert › Create Pad from Selected Primitives): a pad of any shape, such
 * as a notched pad or a ring round a microphone's sound port. It is a pad (the anchor: its
 * designator, net, hole and place) and regions marked as its shape: copper on its layer (both
 * outer layers for a through-hole pad) and the solder mask and paste openings, each region's
 * KONIUMPADSHAPE property naming the pad. Konium Designer treats them as one: they select and
 * move together, and the regions take the pad's net (saving writes it into them). Altium
 * Designer opens them as the pad and regions its users have long drawn by hand for such pads,
 * so the copper, mask and paste come out right there too.
 *
 * A region belongs to the pad of its part whose centre lies in it (by name when several do, or
 * none), so renaming or re-netting the pad keeps it.
 */
import { arcPoints, distToSegment, pointInPoly, type Vec2 } from '../core/geom';
import { isSignal, L, type LayerId } from './layers';
import { NO_NET, type PcbArc, type PcbFill, type PcbPad, type PcbPrim, type PcbRegion, type PcbTrack } from './pcb';
import { clipPieces, offsetOutline, outlineArea } from './outlineOps';

/** The region property naming the pad a region is the shape of. */
export const PAD_SHAPE_KEY = 'KONIUMPADSHAPE';

export interface Shape { outline: Vec2[]; holes: Vec2[][] }

const keyOf = (p: PcbPrim) => `${p.src.storage}:${p.src.index}`;
const inside = (p: Vec2, s: Shape) => pointInPoly(p, s.outline) && !s.holes.some((h) => pointInPoly(p, h));

/**
 * Each marked region linked to its pad (after decoding): the region's `shapeOf` and the pad's
 * `shapeKeys`, and the region's net set to the pad's.
 */
export function linkPadShapes(prims: PcbPrim[]): void {
  const shapes = prims.filter((p): p is PcbRegion => p.kind === 'region' && p.padShape !== undefined);
  if (!shapes.length) return;
  const pads = prims.filter((p): p is PcbPad => p.kind === 'pad');
  for (const r of shapes) {
    const mine = pads.filter((p) => p.component === r.component);
    const within = mine.filter((p) => inside(p.at, r));
    const pool = within.length ? within : mine.filter((p) => p.name === r.padShape);
    if (!pool.length) continue;
    const named = pool.filter((p) => p.name === r.padShape);
    const from = named.length ? named : pool;
    const c = centre(r.outline);
    const pad = from.reduce((a, b) => (Math.hypot(b.at.x - c.x, b.at.y - c.y) < Math.hypot(a.at.x - c.x, a.at.y - c.y) ? b : a));
    r.shapeOf = keyOf(pad);
    (pad.shapeKeys ??= []).push(keyOf(r));
    r.net = pad.net;
  }
}

/** A pad's whole: its key and its shape's (or the pad's, a region's shape is part of). */
export function padShapeGroup(prims: PcbPrim[], p: PcbPrim): string[] {
  if (p.kind === 'pad' && p.shapeKeys?.length) return [keyOf(p), ...p.shapeKeys];
  if (p.kind === 'region' && p.shapeOf) {
    const pad = prims.find((q) => q.kind === 'pad' && keyOf(q) === p.shapeOf) as PcbPad | undefined;
    return pad ? [keyOf(pad), ...(pad.shapeKeys ?? [])] : [keyOf(p)];
  }
  return [keyOf(p)];
}

/** Pads with a shape of their own in these primitives. */
export const isPolygonPad = (p: PcbPrim): boolean => p.kind === 'pad' && !!p.shapeKeys?.length;

/* ─── Making one ──────────────────────────────────────────────────────────────────────── */

function centre(pts: Vec2[]): Vec2 {
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!, k = p.x * q.y - q.x * p.y;
    a += k; x += (p.x + q.x) * k; y += (p.y + q.y) * k;
  }
  if (Math.abs(a) < 1e-9) return pts.reduce((s, p) => ({ x: s.x + p.x / pts.length, y: s.y + p.y / pts.length }), { x: 0, y: 0 });
  return { x: x / (3 * a), y: y / (3 * a) };
}
const signedArea = (pts: Vec2[]) => pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]!; return s + p.x * q.y - q.x * p.y; }, 0) / 2;
const oriented = (pts: Vec2[], ccw: boolean) => ((signedArea(pts) > 0) === ccw ? pts : [...pts].reverse());
/** A shape as paths that join right under non-zero filling (outline anticlockwise, holes clockwise). */
const pathsOf = (s: Shape) => [oriented(s.outline, true), ...s.holes.map((h) => oriented(h, false))];

const fullCircle = (a: PcbArc) => (((a.end - a.start) % 360) + 360) % 360 === 0;
/** A track's or arc's points from one end to the other (an arc's by its chords). */
function stroke(p: PcbTrack | PcbArc): Vec2[] {
  if (p.kind === 'track') return [p.a, p.b];
  const sweep = ((((p.end - p.start) % 360) + 360) % 360) || 360;
  return arcPoints(p.c, p.r, p.r, p.start, p.start + sweep, Math.max(8, Math.ceil(sweep / 5))).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
}

/** Tracks and arcs as the closed outlines they make (a whole circle is one by itself). */
export function loopsOf(prims: (PcbTrack | PcbArc)[]): Vec2[][] | string {
  const loops: Vec2[][] = [];
  const edges: Vec2[][] = [];
  for (const p of prims) {
    if (p.kind === 'arc' && fullCircle(p)) { const pts = stroke(p); pts.pop(); loops.push(pts); }
    else edges.push(stroke(p));
  }
  const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) <= 100;
  const used = new Set<number>();
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const loop = [...edges[i]!];
    const start = loop[0]!;
    for (let guard = 0; guard <= edges.length; guard++) {
      const end = loop.at(-1)!;
      if (loop.length > 2 && near(end, start)) break;
      const j = edges.findIndex((e, k) => !used.has(k) && (near(e[0]!, end) || near(e.at(-1)!, end)));
      if (j < 0) return 'The selected tracks and arcs don’t close: draw the shape’s outline all round (two circles make a ring)';
      used.add(j);
      const e = near(edges[j]![0]!, end) ? edges[j]! : [...edges[j]!].reverse();
      loop.push(...e.slice(1));
    }
    if (near(loop.at(-1)!, start)) loop.pop();
    if (loop.length < 3) return 'The selected tracks and arcs don’t make a shape';
    loops.push(loop);
  }
  return loops;
}

/** Outlines one inside another taken as holes, and islands in holes as copper again. */
function evenOdd(loops: Vec2[][]): Shape[] {
  const depth = loops.map((l, i) => loops.filter((o, j) => j !== i && pointInPoly(l[0]!, o)).length);
  let pieces: Shape[] = [];
  const levels = [...new Set(depth)].sort((a, b) => a - b);
  for (const d of levels) {
    const these = loops.filter((_, i) => depth[i] === d).map((l) => oriented(l, true));
    const have = pieces.flatMap(pathsOf);
    pieces = d % 2 === 0 ? clipPieces('union', [...have, ...these]) : clipPieces('difference', have, these);
  }
  return pieces;
}

const fillCorners = (f: PcbFill): Vec2[] => {
  const c = { x: (f.a.x + f.b.x) / 2, y: (f.a.y + f.b.y) / 2 }, hw = Math.abs(f.b.x - f.a.x) / 2, hh = Math.abs(f.b.y - f.a.y) / 2;
  const t = (f.rotation * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: Math.round(c.x + x! * cos - y! * sin), y: Math.round(c.y + x! * sin + y! * cos) }));
};

/** The one shape selected tracks and arcs (outlines), regions and fills (areas) make. */
export function shapeOf(prims: PcbPrim[]): Shape | string {
  const lines = prims.filter((p): p is PcbTrack | PcbArc => p.kind === 'track' || p.kind === 'arc');
  const areas: Shape[] = [];
  if (lines.length) {
    const loops = loopsOf(lines);
    if (typeof loops === 'string') return loops;
    areas.push(...evenOdd(loops));
  }
  for (const p of prims) {
    if (p.kind === 'region') areas.push({ outline: p.outline, holes: p.holes });
    else if (p.kind === 'fill') areas.push({ outline: fillCorners(p), holes: [] });
  }
  if (!areas.length) return 'Select the shape: its outline (tracks and arcs), or regions and fills';
  const pieces = clipPieces('union', areas.flatMap(pathsOf));
  if (!pieces.length) return 'The selection has no area';
  if (pieces.length > 1) return `The selection makes ${pieces.length} separate shapes: a pad is one piece`;
  return pieces[0]!;
}

/** How far a point is from the shape's edges. */
function clearance(p: Vec2, s: Shape): number {
  let d = Infinity;
  for (const ring of [s.outline, ...s.holes]) for (let i = 0; i < ring.length; i++) d = Math.min(d, distToSegment(p, ring[i]!, ring[(i + 1) % ring.length]!));
  return d;
}

/**
 * Where the anchor pad goes and how big it is: the point in the copper farthest from its edges
 * (the shape's centre when that is nearly as good), a round pad 80% as wide as the room there.
 */
export function anchorFor(s: Shape): { at: Vec2; size: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of s.outline) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  let best = { at: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, d: -1 };
  let step = Math.max(maxX - minX, maxY - minY) / 48;
  let cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, span = Math.max(maxX - minX, maxY - minY) / 2;
  for (let round = 0; round < 4 && step > 1; round++) {
    for (let x = cx - span; x <= cx + span; x += step) {
      for (let y = cy - span; y <= cy + span; y += step) {
        const p = { x, y };
        if (!inside(p, s)) continue;
        const d = clearance(p, s);
        if (d > best.d) best = { at: p, d };
      }
    }
    if (best.d < 0) break;
    cx = best.at.x; cy = best.at.y; span = step * 2; step /= 6;
  }
  const c = centre(s.outline);
  if (inside(c, s)) { const d = clearance(c, s); if (d >= best.d * 0.6) best = { at: c, d }; }
  const at = { x: Math.round(best.at.x), y: Math.round(best.at.y) };
  return { at, size: Math.max(2, Math.round(Math.max(0, best.d) * 1.6)) };
}

/** A shape grown (or shrunk) by `by`: the outline out, the holes in (one piece, or none left). */
export function grownShape(s: Shape, by: number): Shape | null {
  if (!by) return s;
  const outer = offsetOutline(oriented(s.outline, true), by);
  const holes = s.holes.flatMap((h) => offsetOutline(oriented(h, true), -by));
  const pieces = clipPieces('difference', outer.map((o) => oriented(o, true)), holes.map((h) => oriented(h, true)));
  if (!pieces.length) return null;
  return pieces.reduce((a, b) => (outlineArea(b.outline) > outlineArea(a.outline) ? b : a));
}

/** The next free designator among these pads: one past the highest number (1 when none). */
export function nextPadName(pads: PcbPad[]): string {
  const nums = pads.map((p) => /^(\d+)$/.exec(p.name.trim())?.[1]).filter((n): n is string => !!n).map(Number);
  return String(nums.length ? Math.max(...nums) + 1 : 1);
}

/** What a selection becomes: the shape, its layer(s), the anchor (a selected pad, or a new one) and what goes. */
export interface PadPlan {
  shape: Shape;
  /** The copper layers the shape is on: the pad's own, or the top and bottom for a through-hole pad. */
  copper: LayerId[];
  /** The selected pad that becomes the anchor, if one was. */
  anchor: PcbPad | null;
  /** A new anchor pad: where, how wide, its layer, designator, net and part. */
  fresh: { at: Vec2; size: number; layer: LayerId; name: string; net: number; component: number } | null;
  /** The selected objects the shape was made from (replaced by the pad). */
  sources: PcbPrim[];
}

/**
 * A selection made into a pad's plan: tracks and arcs as closed outlines, regions and fills as
 * areas, on one layer (copper; else the `current` layer, or the Top Layer); at most one pad, kept
 * as the anchor. `allPads` gives the next designator.
 */
export function planPad(selected: PcbPrim[], allPads: PcbPad[], current: LayerId): PadPlan | string {
  const pads = selected.filter((p): p is PcbPad => p.kind === 'pad');
  if (pads.length > 1) return 'Select one pad at most: it keeps its designator and net, and takes the shape';
  const sources = selected.filter((p) => (p.kind === 'track' || p.kind === 'arc' || p.kind === 'region' || p.kind === 'fill') && !('polygon' in p && p.polygon !== NO_NET) && !(p.kind === 'region' && p.padShape !== undefined));
  const other = selected.filter((p) => p.kind !== 'pad' && !sources.includes(p) && !(p.kind === 'region' && p.padShape !== undefined));
  if (other.length) return `Only the shape (tracks, arcs, regions, fills) and a pad can be made into a pad: ${other.length} other object${other.length === 1 ? '' : 's'} selected`;
  if (!sources.length) return 'Select the shape: its outline (tracks and arcs), or regions and fills';
  const layers = [...new Set(sources.map((p) => (p as { layer: LayerId }).layer))];
  if (layers.length > 1) return 'The shape’s objects are on different layers: draw it on one';
  const anchor = pads[0] ?? null;
  const drawn = layers[0]!;
  let layer: LayerId;
  if (anchor && anchor.hole > 0) layer = L.MULTI;
  else if (anchor) layer = anchor.layer;
  else layer = drawn === L.TOP || drawn === L.BOTTOM ? drawn : current === L.TOP || current === L.BOTTOM ? current : L.TOP;
  if (anchor && anchor.hole === 0 && isSignal(drawn) && drawn !== anchor.layer) return `The shape is on another layer than pad ${anchor.name}`;
  if (layer !== L.TOP && layer !== L.BOTTOM && layer !== L.MULTI) return 'A pad’s shape goes on the Top or Bottom Layer (or both, for a pad with a hole)';
  const shape = shapeOf(sources);
  if (typeof shape === 'string') return shape;
  if (outlineArea(shape.outline) <= 0) return 'The shape has no area';
  const copper = layer === L.MULTI ? [L.TOP, L.BOTTOM] : [layer];
  if (anchor) return { shape, copper, anchor, fresh: null, sources };
  const comps = [...new Set(sources.map((p) => ('component' in p ? p.component : NO_NET)))];
  const nets = [...new Set(sources.map((p) => ('net' in p ? p.net : NO_NET)))];
  const component = comps.length === 1 ? comps[0]! : NO_NET;
  const { at, size } = anchorFor(shape);
  const mates = allPads.filter((p) => p.component === component);
  return { shape, copper, anchor: null, fresh: { at, size, layer, name: nextPadName(mates), net: nets.length === 1 ? nets[0]! : NO_NET, component }, sources };
}

/** The regions a pad's shape is: copper on each layer, mask openings (none where tented), paste on an SMD pad's side. */
export function shapeRegions(plan: PadPlan, mask: (top: boolean) => number | null, paste: number): { layer: LayerId; shape: Shape }[] {
  const out: { layer: LayerId; shape: Shape }[] = [];
  for (const l of plan.copper) out.push({ layer: l, shape: plan.shape });
  for (const l of plan.copper) {
    const m = mask(l === L.TOP);
    const g = m === null ? null : grownShape(plan.shape, m);
    if (g) out.push({ layer: l === L.TOP ? L.TOP_SOLDER : L.BOTTOM_SOLDER, shape: g });
  }
  const smd = plan.copper.length === 1;
  if (smd) {
    const g = grownShape(plan.shape, paste);
    if (g) out.push({ layer: plan.copper[0] === L.TOP ? L.TOP_PASTE : L.BOTTOM_PASTE, shape: g });
  }
  return out;
}
