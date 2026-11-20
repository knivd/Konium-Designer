/**
 * Internal planes' copper, as AD makes it from a plane layer (a negative image): the board's
 * shape pulled back from its edge by the layer's Pullback (and from cut-outs), split by the
 * split planes on it and the lines drawn on it, each part its net (the layer's, or the split
 * plane's); holes of other nets cleared by the Power Plane Clearance rule, those of the net
 * joined by the Power Plane Connect Style rule — a relief (an air gap round the hole, beyond the
 * expansion, crossed by the conductors at 45°), direct, or no connect (cleared). Clearances are
 * taken from the hole's edge [checked: AD17's isolated plane copper among close vias, its areas
 * and extents within 4% of these]. Outputs that plot planes as positive copper (Gerber, IPC-2581,
 * ODB++, KiCad's zones) draw this.
 */
import * as ClipperNS from 'clipper-lib';
import type { Vec2 } from '../core/geom';
import { mil, parseLength } from '../core/units';
import { L, type LayerId } from './layers';
import { NO_NET, type PcbDocument, type PcbPrim } from './pcb';
import { readStack } from './pcbStack';
import { ruleFor } from './drc';
import { connectLength, connectValue, ruleLength, type PcbRule } from '../formats/altium/rules';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;
type Path = ClipperNS.IntPoint[];
type Paths = Path[];
const TOL = 2_500;
// About the board's centre (OX, OY): Clipper's JavaScript port turns to slow BigInteger maths past ±47,453,132 units
let OX = 0, OY = 0;
const toPath = (pts: Vec2[]): Path => pts.map((p) => ({ X: Math.round(p.x - OX), Y: Math.round(p.y - OY) }));
const fromPath = (p: Path): Vec2[] => p.map((q) => ({ x: q.X + OX, y: q.Y + OY }));

function offset(paths: Paths, d: number, closed = true, join: ClipperNS.JoinType = C.JoinType.jtRound): Paths {
  const co = new C.ClipperOffset(2, TOL);
  co.AddPaths(paths, join, closed ? C.EndType.etClosedPolygon : C.EndType.etOpenRound);
  const out: Paths = [];
  co.Execute(out, d);
  return out;
}
function op(a: Paths, b: Paths, type: ClipperNS.ClipType): Paths {
  const c = new C.Clipper();
  c.AddPaths(a, C.PolyType.ptSubject, true);
  c.AddPaths(b, C.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(type, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return out;
}
function circle(c: Vec2, r: number): Path {
  const n = Math.max(12, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - TOL / Math.max(r, 1)))));
  const R = r / Math.cos(Math.PI / n);
  return Array.from({ length: n }, (_, k) => ({ X: Math.round(c.x - OX + R * Math.cos((2 * Math.PI * k) / n)), Y: Math.round(c.y - OY + R * Math.sin((2 * Math.PI * k) / n)) }));
}

/**
 * A relief's air gap round a round hole: the ring between r1 and r2 less the conductors (strips
 * of half-width hw along each direction, degrees), as the ring's sectors.
 */
export function ringSectors(c: Vec2, r1: number, r2: number, dirs: number[], hw: number): Paths {
  const out: Paths = [];
  const sorted = [...dirs].map((d) => ((d % 360) + 360) % 360).sort((a, b) => a - b);
  const at = (rad: number, a: number) => ({ X: Math.round(c.x - OX + rad * Math.cos(a)), Y: Math.round(c.y - OY + rad * Math.sin(a)) });
  for (let i = 0; i < sorted.length; i++) {
    const a0 = (sorted[i]! * Math.PI) / 180, a1 = ((sorted[(i + 1) % sorted.length]! + (i + 1 === sorted.length ? 360 : 0)) * Math.PI) / 180;
    // Each edge is the conductor's straight side: its angle at a radius is asin(hw / radius) off the spoke
    const o1 = Math.asin(Math.min(1, hw / r1)), o2 = Math.asin(Math.min(1, hw / r2));
    const s1 = a0 + o1, e1 = a1 - o1, s2 = a0 + o2, e2 = a1 - o2;
    if (e2 <= s2 || e1 <= s1) continue;
    const steps = (from: number, to: number, rad: number) => Math.max(2, Math.ceil(Math.abs(to - from) / Math.acos(Math.max(-1, 1 - TOL / Math.max(rad, 1)))));
    const pts: Path = [];
    const n2 = steps(s2, e2, r2), R2 = r2 / Math.cos((e2 - s2) / n2 / 2);
    pts.push(at(r2, s2));
    for (let k = 0; k < n2; k++) pts.push(at(R2, s2 + ((e2 - s2) * (k + 0.5)) / n2));
    pts.push(at(r2, e2));
    const n1 = steps(s1, e1, r1);
    for (let k = 0; k <= n1; k++) pts.push(at(r1, e1 - ((e1 - s1) * k) / n1));
    out.push(pts);
  }
  if (!dirs.length) out.push(circle(c, r2), circle(c, r1).reverse());
  return out;
}

type Hole = Extract<PcbPrim, { kind: 'pad' | 'via' }>;
/**
 * A plane relief's conductors cross the air gap at 45° to the board's axes (the suite's Power
 * Plane Connect Style has no angle) [checked: AD17's isolated plane copper among close vias
 * matches only that], turned with a pad [est]; a RELIEFANGLE of 90 crosses them on the axes.
 */
export function reliefAngle(rule: PcbRule | undefined, h: Hole): number {
  return /90/.test((rule && connectValue(rule, 'RELIEFANGLE', h)) ?? '') ? 0 : 45;
}
/** The directions (degrees) of a relief's conductors: four, or two (RELIEFENTRIES 2). */
export function reliefDirs(rule: PcbRule | undefined, h: Hole): number[] {
  const n = Number.parseInt((rule && connectValue(rule, 'RELIEFENTRIES', h)) ?? '4', 10) || 4;
  const base = reliefAngle(rule, h) + (h.kind === 'pad' ? h.rotation : 0);
  return [0, 1, 2, 3].filter((k) => !(n === 2 && k % 2)).map((k) => base + k * 90);
}

/**
 * How much of each of a relief's conductors is part of a piece of plane copper: the conductor's
 * copper across the air gap (between radii r1 and r2, half-width hw) inside the piece's outline
 * (null: all of it is) and outside its holes, as a share from 0 to 1 per direction. Worked about
 * the hole's centre c, with only the outline and holes near it.
 */
export function conductorShares(c: Vec2, r1: number, r2: number, hw: number, dirs: number[], outline: Vec2[] | null, holes: Vec2[][]): number[] {
  const local = (pts: Vec2[]): Path => pts.map((p) => ({ X: Math.round(p.x - c.x), Y: Math.round(p.y - c.y) }));
  const clip = holes.map(local);
  const out = local(outline ?? []);
  return dirs.map((deg) => {
    const d = (deg * Math.PI) / 180, a1 = Math.asin(Math.min(1, hw / r1)), a2 = Math.asin(Math.min(1, hw / r2));
    const steps = (a: number, rad: number) => Math.max(2, Math.ceil((2 * a) / Math.acos(Math.max(-1, 1 - TOL / Math.max(rad, 1)))));
    const band: Path = [];
    const n1 = steps(a1, r1), n2 = steps(a2, r2);
    for (let k = 0; k <= n1; k++) { const t = d - a1 + (2 * a1 * k) / n1; band.push({ X: Math.round(r1 * Math.cos(t)), Y: Math.round(r1 * Math.sin(t)) }); }
    for (let k = 0; k <= n2; k++) { const t = d + a2 - (2 * a2 * k) / n2; band.push({ X: Math.round(r2 * Math.cos(t)), Y: Math.round(r2 * Math.sin(t)) }); }
    const whole = Math.abs(C.Clipper.Area(band));
    if (!whole) return 0;
    if (C.Clipper.Area(band) < 0) band.reverse();
    let kept: Paths = [band];
    if (outline) kept = op(kept, [out], C.ClipType.ctIntersection);
    if (clip.length && kept.length) kept = op(kept, clip, C.ClipType.ctDifference);
    return Math.min(1, kept.reduce((s, p) => s + C.Clipper.Area(p), 0) / whole);
  });
}

export interface PlaneArea { net: number; regions: { outline: Vec2[]; holes: Vec2[][] }[] }

const cache = new WeakMap<PcbPrim[], Map<LayerId, PlaneArea[]>>();
/** Each hole's plane rules, looked up once for all planes and areas (rules don't name layers here). */
const ruleCache = new WeakMap<PcbPrim[], Map<PcbPrim, { clear?: ReturnType<typeof ruleFor>; connect?: ReturnType<typeof ruleFor> }>>();

/** The plane layer's copper: one area per net (the layer's, and each split plane's). */
/** A plane layer's split planes, smallest first: a split nested in another is its own. */
export function splitPlanes(doc: PcbDocument, layer: LayerId): PcbDocument['polygons'] {
  const area = (pts: Vec2[]) => { let a = 0; for (let k = 0; k < pts.length; k++) { const p = pts[k]!, q = pts[(k + 1) % pts.length]!; a += p.x * q.y - q.x * p.y; } return Math.abs(a) / 2; };
  return doc.polygons.filter((p) => p.layer === layer && /split/i.test(p.type) && p.outline.length >= 3).map((p) => [p, area(p.outline)] as const).sort((a, b) => a[1] - b[1]).map(([p]) => p);
}

export function planeCopper(doc: PcbDocument, layer: LayerId): PlaneArea[] {
  let m = cache.get(doc.prims);
  if (!m) { m = new Map(); cache.set(doc.prims, m); }
  const hit = m.get(layer);
  if (hit) return hit;
  const was = [OX, OY] as const;
  const xs = doc.board.outline.map((p) => p.x), ys = doc.board.outline.map((p) => p.y);
  if (xs.length) { OX = Math.round((Math.min(...xs) + Math.max(...xs)) / 2); OY = Math.round((Math.min(...ys) + Math.max(...ys)) / 2); }
  let out: PlaneArea[];
  try { out = compute(doc, layer); } finally { [OX, OY] = was; }
  m.set(layer, out);
  return out;
}

function compute(doc: PcbDocument, layer: LayerId): PlaneArea[] {
  if (layer < L.PLANE1 || layer > L.PLANE16 || doc.board.outline.length < 3 || !doc.board.copperStack.includes(layer)) return [];
  const row = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack).find((r) => r.layer === layer) : undefined;
  const pullback = row?.pullback ?? mil(20);
  let base = offset([toPath(doc.board.outline)], -pullback, true, C.JoinType.jtMiter);
  const cuts: Paths = [], voids: Paths = [];
  for (const p of doc.prims) {
    if (p.kind === 'region' && p.boardCutout && p.outline.length >= 3) cuts.push(...offset([toPath(p.outline)], pullback, true, C.JoinType.jtMiter));
    // Lines and shapes drawn on a plane layer are clear of copper (split lines, voids)
    if (!('layer' in p) || p.layer !== layer) continue;
    if (p.kind === 'track') voids.push(...offset([toPath([p.a, p.b])], p.width / 2, false));
    else if (p.kind === 'arc') {
      const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360, n = Math.max(4, Math.ceil(sweep / 5));
      const list = Array.from({ length: n + 1 }, (_, i) => { const d = ((p.start + (sweep * i) / n) * Math.PI) / 180; return { x: p.c.x + p.r * Math.cos(d), y: p.c.y + p.r * Math.sin(d) }; });
      voids.push(...offset([toPath(list)], p.width / 2, false));
    } else if (p.kind === 'region' && p.outline.length >= 3 && !p.boardCutout) voids.push(toPath(p.outline));
    else if (p.kind === 'fill') voids.push(toPath([p.a, { x: p.b.x, y: p.a.y }, p.b, { x: p.a.x, y: p.b.y }]));
  }
  if (cuts.length) base = op(base, cuts, C.ClipType.ctDifference);
  if (voids.length) base = op(base, voids, C.ClipType.ctDifference);
  const mainName = doc.board.bag?.get(`PLANE${layer - L.PLANE1 + 1}NETNAME`) ?? '';
  const mainNet = mainName ? doc.nets.findIndex((n) => n.name === mainName) : -1;
  // A split inside another takes its own area first (the innermost split's net wins, as in AD)
  const splits = splitPlanes(doc, layer);
  const areas: { net: number; paths: Paths }[] = [];
  let rest = base;
  for (const s of splits) {
    const own = op(rest, [toPath(s.outline)], C.ClipType.ctIntersection);
    rest = op(rest, [toPath(s.outline)], C.ClipType.ctDifference);
    areas.push({ net: s.net, paths: own });
  }
  areas.unshift({ net: mainNet >= 0 ? mainNet : NO_NET, paths: rest });

  // The holes through the layer
  const stack = doc.board.copperStack, at = stack.indexOf(layer);
  const holes = doc.prims.filter((p): p is Extract<PcbPrim, { kind: 'pad' | 'via' }> => {
    if (p.kind === 'pad') return p.layer === L.MULTI && p.hole > 0;
    if (p.kind !== 'via') return false;
    const a = stack.indexOf(p.layerStart), b = stack.indexOf(p.layerEnd);
    return a < 0 || b < 0 || (at >= Math.min(a, b) && at <= Math.max(a, b));
  });
  const len = (v: string) => parseLength(v)!;
  let rc = ruleCache.get(doc.prims);
  if (!rc) { rc = new Map(); ruleCache.set(doc.prims, rc); }
  const rulesOf = (h: PcbPrim) => {
    let e = rc!.get(h);
    if (!e) { e = { clear: ruleFor(doc, 'PlaneClearance', h), connect: ruleFor(doc, 'PlaneConnect', h) }; rc!.set(h, e); }
    return e;
  };
  const box = (ps: Paths) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ps) for (const q of p) { if (q.X < x0) x0 = q.X; if (q.X > x1) x1 = q.X; if (q.Y < y0) y0 = q.Y; if (q.Y > y1) y1 = q.Y; }
    return { x0, y0, x1, y1 };
  };
  return areas.map(({ net, paths }) => {
    if (!paths.length) return { net, regions: [] };
    const clear: Paths = [], gaps: Paths = [], spokes: Paths = [], reliefs: Paths = [];
    // Only the holes that reach this area (a split plane's few, not the board's all)
    // In the board's coordinates (the paths are about OX, OY): holes are where the board has them
    const pb = box(paths), ab = { x0: pb.x0 + OX, y0: pb.y0 + OY, x1: pb.x1 + OX, y1: pb.y1 + OY };
    for (const h of holes) {
      const r = h.hole / 2;
      const reach = r + (h.kind === 'pad' && h.slot ? h.slot.length / 2 : 0) + mil(200);
      if (h.at.x + reach < ab.x0 || h.at.x - reach > ab.x1 || h.at.y + reach < ab.y0 || h.at.y - reach > ab.y1) continue;
      const shape = (grow: number): Paths => {
        if (h.kind === 'pad' && h.slot && h.slot.length > h.hole) {
          const a = ((h.rotation + h.slot.rotation) * Math.PI) / 180, d = (h.slot.length - h.hole) / 2;
          return offset([toPath([{ x: h.at.x - Math.cos(a) * d, y: h.at.y - Math.sin(a) * d }, { x: h.at.x + Math.cos(a) * d, y: h.at.y + Math.sin(a) * d }])], r + grow, false);
        }
        return [circle(h.at, r + grow)];
      };
      const same = net !== NO_NET && h.net === net && (h.kind === 'via' || h.plated);
      const hr = rulesOf(h);
      if (!same) {
        const cr = hr.clear;
        clear.push(...shape(cr ? ruleLength(cr, 'CLEARANCE', '20mil') : len('20mil')));
        continue;
      }
      const rule = hr.connect;
      const style = ((rule && connectValue(rule, 'PLANECONNECTSTYLE', h)) ?? 'Relief').toLowerCase();
      if (style === 'direct') continue;
      if (style.startsWith('no')) { const cr = hr.clear; clear.push(...shape(cr ? ruleLength(cr, 'CLEARANCE', '20mil') : len('20mil'))); continue; }
      const exp = rule ? connectLength(rule, 'RELIEFEXPANSION', '20mil', h) : len('20mil');
      const gap = rule ? connectLength(rule, 'RELIEFAIRGAP', '10mil', h) : len('10mil');
      const cw = rule ? connectLength(rule, 'RELIEFCONDUCTORWIDTH', '10mil', h) : len('10mil');
      const n = Number.parseInt((rule && connectValue(rule, 'RELIEFENTRIES', h)) ?? '4', 10) || 4;
      const angle = reliefAngle(rule, h);
      // The hole's own copper (to the gap) stays: the ring beyond it goes, but for the conductors.
      // A round hole's ring is cut into its sectors directly (no boolean work); a slot's by clipping
      if (!(h.kind === 'pad' && h.slot && h.slot.length > h.hole)) {
        const r1 = r + exp, r2 = r + exp + gap;
        const dirs = reliefDirs(rule, h);
        if (cw / 2 >= r1) continue; // the conductors cover the ring: a direct connection
        reliefs.push(...ringSectors(h.at, r1, r2, dirs, cw / 2));
        continue;
      }
      gaps.push(...op(shape(exp + gap), shape(exp), C.ClipType.ctDifference));
      const ext = r + exp + gap + mil(1) + (h.kind === 'pad' && h.slot ? h.slot.length / 2 : 0);
      for (let k = 0; k < 4; k++) {
        if (n === 2 && k % 2) continue;
        const a = ((angle + (h.kind === 'pad' ? h.rotation : 0) + k * 90) * Math.PI) / 180;
        spokes.push(...offset([toPath([h.at, { x: h.at.x + Math.cos(a) * ext, y: h.at.y + Math.sin(a) * ext }])], cw / 2, false));
      }
    }
    // The area less its clearances and relief gaps, straight into regions with their holes
    if (gaps.length) reliefs.push(...op(gaps, spokes, C.ClipType.ctDifference));
    const c = new C.Clipper();
    c.AddPaths(paths, C.PolyType.ptSubject, true);
    if (clear.length) c.AddPaths(clear, C.PolyType.ptClip, true);
    if (reliefs.length) c.AddPaths(reliefs, C.PolyType.ptClip, true);
    const tree = new C.PolyTree();
    c.Execute(C.ClipType.ctDifference, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    const regions: PlaneArea['regions'] = [];
    const walk = (node: ClipperNS.PolyNode) => {
      for (const ch of node.Childs()) {
        if (ch.IsHole()) continue;
        const outline = fromPath(ch.Contour());
        const hs = ch.Childs().filter((x) => x.IsHole()).map((x) => fromPath(x.Contour()));
        if (outline.length >= 3) regions.push({ outline, holes: hs });
        for (const hole of ch.Childs()) walk(hole);
      }
    };
    walk(tree);
    return { net, regions };
  });
}
