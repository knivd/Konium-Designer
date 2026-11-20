/**
 * Polygon pour engine (Tools › Polygon Pours › Repour): the copper of a polygon is its outline,
 * clipped to the board shape, minus every object of another net grown by the Clearance rule,
 * with same-net pads and vias connected by the Polygon Connect Style rule (relief spokes across
 * an air gap, direct, or no connect), islands that reach nothing of the net removed (Remove Dead
 * Copper), necks narrower than a width (Remove Necks) and, optionally, islands below an area. Solid pours become regions with holes; hatched
 * ones tracks on the grid plus an outline, as Altium builds them.
 */
import { barcodeShape } from './barcode';
import { islandAreaOf, pourOverOf } from '../formats/altium/polygonProps';
import * as ClipperNS from 'clipper-lib';
import type { Vec2 } from '../core/geom';
import { L, type LayerId } from './layers';
import { NO_NET, type PcbDocument, type PcbPolygon, type PcbPrim } from './pcb';
import { boardIndex, clearanceGap, ruleFor, type Shape } from './drc';
import { parseLength } from '../core/units';
import { connectLength, connectValue, ruleLength } from '../formats/altium/rules';
import { strokeCapHeight, strokeText } from '../formats/gerber/stroke';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;
type Path = ClipperNS.IntPoint[];
type Paths = Path[];

const ARC_TOL = 2_500; // 0.25 mil
const bboxOf = (o: Vec2[]) => { let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const p of o) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; } return { minX, minY, maxX, maxY }; };
const overlaps = (a: ReturnType<typeof bboxOf>, b: ReturnType<typeof bboxOf>) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
/**
 * Clipper's JavaScript port works in plain doubles only while coordinates stay within ±47,453,132
 * units (4.7 inches) of the origin, and in BigInteger maths past it — many times slower. Boards sit
 * far from AD's origin, so each pour is worked out about its own centre (OX, OY), moved back after.
 */
let OX = 0, OY = 0;
const toPath = (pts: Vec2[]): Path => pts.map((p) => ({ X: Math.round(p.x - OX), Y: Math.round(p.y - OY) }));
const fromPath = (p: Path): Vec2[] => p.map((q) => ({ x: q.X + OX, y: q.Y + OY }));

function grow(paths: Paths, delta: number, closed: boolean): Paths {
  const co = new C.ClipperOffset(2, ARC_TOL);
  co.AddPaths(paths, C.JoinType.jtRound, closed ? C.EndType.etClosedPolygon : C.EndType.etOpenRound);
  const out: Paths = [];
  co.Execute(out, delta);
  return out;
}

/** Grown (or shrunk) with corners kept sharp, as an opening wants. */
function sharpGrow(paths: Paths, delta: number): Paths {
  const co = new C.ClipperOffset(2, ARC_TOL);
  co.AddPaths(paths, C.JoinType.jtMiter, C.EndType.etClosedPolygon);
  const out: Paths = [];
  co.Execute(out, delta);
  return out;
}

function clip(subject: Paths, clipPaths: Paths, type: ClipperNS.ClipType): Paths {
  const c = new C.Clipper();
  c.AddPaths(subject, C.PolyType.ptSubject, true);
  c.AddPaths(clipPaths, C.PolyType.ptClip, true);
  const out: Paths = [];
  c.Execute(type, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return out;
}
const union = (a: Paths, b: Paths = []) => clip(a, b, C.ClipType.ctUnion);

/**
 * A closed outline moved in by so much, its corners kept sharp: the largest piece when that
 * parts it, the outline as it was when nothing is left (a pour drawn inside a board's edge).
 */
export function insetOutline(outline: Vec2[], by: number): Vec2[] {
  if (outline.length < 3 || !(by > 0)) return outline;
  const was = [OX, OY];
  const xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
  OX = Math.round((Math.min(...xs) + Math.max(...xs)) / 2); OY = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
  try {
    const path = toPath(outline);
    const out = sharpGrow([C.Clipper.Orientation(path) ? path : path.slice().reverse()], -by);
    let best: Path | null = null, area = 0;
    for (const q of out) { const a = Math.abs(C.Clipper.Area(q)); if (a > area) { best = q; area = a; } }
    return best && best.length >= 3 ? fromPath(best) : outline;
  } finally { [OX, OY] = was as [number, number]; }
}

/** A regular polygon whose edges lie outside the circle by at most the arc tolerance. */
function circleAround(c: Vec2, r: number): Path {
  if (r <= 0) return [];
  const n = Math.max(8, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - ARC_TOL / r))));
  const R = (r + 1) / Math.cos(Math.PI / n); // + 1: the vertices are rounded to whole units
  return Array.from({ length: n }, (_, k) => ({ X: Math.round(c.x - OX + R * Math.cos((2 * Math.PI * k) / n)), Y: Math.round(c.y - OY + R * Math.sin((2 * Math.PI * k) / n)) }));
}

/** A shape (from the DRC model) grown by `d`, as Clipper paths. Arcs are approximated by chords
 *  whose ends lie on the arc, so the growth adds the arc tolerance to keep the full clearance. */
function shapePaths(s: Shape, d0: number): Paths {
  const g = s.g;
  const d = d0 > 0 ? d0 + ARC_TOL * 1.2 : d0;
  // A circle as a polygon round it (Clipper's offset of a single point closes with one longer chord)
  if (g.t === 'circle') return [circleAround(g.c, g.r + d0)];
  if (g.t === 'seg') return grow([toPath([g.a, g.b])], g.r + d, false);
  const outer = d > 0 ? grow([toPath(g.pts)], d, true) : [toPath(g.pts)];
  if (!g.holes.length) return outer;
  // A region's holes are open: what the pour fills inside one keeps the clearance from its edge
  const ccw = (p: Path) => (C.Clipper.Orientation(p) ? p : p.slice().reverse());
  const holes = g.holes.flatMap((h) => (d > 0 ? grow([ccw(toPath(h))], -d, true) : [toPath(h)]));
  return clip(outer, holes, C.ClipType.ctDifference);
}

export interface PourResult {
  regions: { outline: Vec2[]; holes: Vec2[][] }[];
  tracks: { a: Vec2; b: Vec2; width: number }[];
  /** Islands left out as dead copper or below the area threshold. */
  removed: number;
}

const len = (v: string | undefined, def: string) => parseLength(v) ?? parseLength(def)!;

/** A stand-in primitive for the pour itself, for rule scopes (InPolygon, InNet, OnLayer …). */
export function pourPrim(poly: PcbPolygon): PcbPrim {
  return { kind: 'region', src: { storage: 'Regions6', index: -1 }, layer: poly.layer, net: poly.net, polygon: poly.index, component: NO_NET,
    outline: poly.outline, holes: [], regionKind: 0, boardCutout: false, keepout: false, locked: false } as unknown as PcbPrim;
}

export function computePour(doc: PcbDocument, poly: PcbPolygon): PourResult {
  if (poly.outline.length < 3) return pourAbout(doc, poly);
  const was = [OX, OY];
  const xs = poly.outline.map((p) => p.x), ys = poly.outline.map((p) => p.y);
  OX = Math.round((Math.min(...xs) + Math.max(...xs)) / 2); OY = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);
  try { return pourAbout(doc, poly); } finally { [OX, OY] = was as [number, number]; }
}

function pourAbout(doc: PcbDocument, poly: PcbPolygon): PourResult {
  const b = poly.bag;
  // A shelved pour keeps its outline and nothing else (Tools › Polygon Pours › Shelve)
  if (b.bool('SHELVED')) return { regions: [], tracks: [], removed: 0 };
  const layer: LayerId = poly.layer;
  const net = poly.net;
  const self = pourPrim(poly);
  // Region: the outline, inside the board shape
  let region: Paths = [toPath(poly.outline)];
  if (doc.board.outline.length >= 3) {
    const bo = ruleFor(doc, 'BoardOutlineClearance', self);
    const inset = bo ? ruleLength(bo, 'GAP', '0mil') : 0;
    const board = inset > 0 ? grow([toPath(doc.board.outline)], -inset, true) : [toPath(doc.board.outline)];
    region = clip(region, board, C.ClipType.ctIntersection);
  }
  // (board cutouts away from the pour left out: they'd change nothing)
  const pb = bboxOf(poly.outline);
  for (const p of doc.prims) if (p.kind === 'region' && p.boardCutout && overlaps(bboxOf(p.outline), pb)) region = clip(region, [toPath(p.outline)], C.ClipType.ctDifference);

  const tree = boardIndex(doc);
  const box = poly.outline.reduce((a, p) => ({ minX: Math.min(a.minX, p.x), minY: Math.min(a.minY, p.y), maxX: Math.max(a.maxX, p.x), maxY: Math.max(a.maxY, p.y) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  const margin = 2_000_000; // 200 mil: beyond any sensible clearance
  const near = tree.search({ minX: box.minX - margin, minY: box.minY - margin, maxX: box.maxX + margin, maxY: box.maxY + margin }).filter((s) => s.layer === layer);
  // POUROVER: SameNet = over all same-net objects (default); SameNetPolygon = only over same-net
  // pours, so same-net tracks keep clearance; None = over nothing
  const pourOverSameNet = pourOverOf(b) === 'SameNet';

  const obstacles: Paths = [];
  const obstacle = (sh: Shape, d0: number) => { obstacles.push(...shapePaths(sh, d0)); };
  const gaps: Paths = [];
  const spokes: Paths = [];
  const anchors: Vec2[] = [];
  const doneRelief = new Set<number>();
  for (const s of near) {
    const p = doc.prims[s.prim]!;
    if ('polygon' in p && p.polygon === poly.index) continue;
    const same = net !== NO_NET && s.net === net;
    if (!same) {
      obstacle(s, clearanceGap(doc, self, p) || len('10mil', '10mil'));
      continue;
    }
    // Same net: pads and vias connect by the Polygon Connect Style; other copper is poured over
    if (p.kind === 'pad' || p.kind === 'via') {
      const r = ruleFor(doc, 'PolygonConnect', p);
      const style = ((r && connectValue(r, 'CONNECTSTYLE', p)) ?? 'Relief').toLowerCase();
      anchors.push(p.at);
      if (style === 'direct' || doneRelief.has(s.prim)) continue;
      doneRelief.add(s.prim);
      if (style === 'noconnect') { obstacle(s, clearanceGap(doc, self, p) || len('10mil', '10mil')); continue; }
      const gap = r ? connectLength(r, 'AIRGAPWIDTH', '10mil', p) : len('10mil', '10mil');
      const cw = r ? connectLength(r, 'RELIEFCONDUCTORWIDTH', '10mil', p) : len('10mil', '10mil');
      const n = Number.parseInt((r && connectValue(r, 'RELIEFENTRIES', p)) ?? '4', 10) || 4;
      // AD's key is POLYGONRELIEFANGLE ("45 Angle")
      const angle = ((r && (connectValue(r, 'POLYGONRELIEFANGLE', p) ?? connectValue(r, 'RELIEFANGLE', p))) ?? '90').includes('45') ? 45 : 0;
      gaps.push(...shapePaths(s, gap));
      const ext = (s.g.t === 'circle' ? s.g.r : Math.max(s.maxX - s.minX, s.maxY - s.minY) / 2) + gap + cw;
      const rot = (p.kind === 'pad' ? p.rotation : 0) + angle;
      for (let k = 0; k < 4; k++) {
        if (n === 2 && k % 2) continue;
        const a = ((rot + k * 90) * Math.PI) / 180;
        const end = { x: p.at.x + Math.cos(a) * ext, y: p.at.y + Math.sin(a) * ext };
        spokes.push(...grow([toPath([p.at, end])], cw / 2, false).map((q) => q));
      }
    } else {
      if (!pourOverSameNet) obstacle(s, clearanceGap(doc, self, p) || len('10mil', '10mil'));
      if (p.kind === 'track') anchors.push(p.a, p.b);
      else if (p.kind === 'arc') anchors.push(p.c);
    }
  }
  // Polygon Pour Cutouts (regions of kind 1) on this layer: no copper inside, no clearance added
  for (const p of doc.prims) if (p.kind === 'region' && p.regionKind === 1 && p.layer === layer && p.outline.length >= 3) obstacles.push(...grow([toPath(p.outline)], 0, true));
  // Keep-outs on this layer or the Keep-Out layer
  for (const p of doc.prims) {
    const kl = 'layer' in p ? p.layer : 0;
    if (!(('keepout' in p && p.keepout && kl === layer) || kl === L.KEEPOUT)) continue;
    if (p.kind === 'track') obstacles.push(...grow([toPath([p.a, p.b])], p.width / 2 + clearanceGap(doc, self, p), false));
    else if (p.kind === 'arc') {
      // A keep-out arc: its centre line in short steps, grown by half its width and the clearance
      let sweep = (((p.end - p.start) % 360) + 360) % 360;
      if (sweep === 0) sweep = 360;
      const n = Math.max(8, Math.ceil(sweep / 5));
      const pts = Array.from({ length: n + 1 }, (_, k) => { const a = ((p.start + (sweep * k) / n) * Math.PI) / 180; return { x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) }; });
      obstacles.push(...grow([toPath(pts)], p.width / 2 + clearanceGap(doc, self, p), false));
    } else if (p.kind === 'region' || p.kind === 'fill') {
      const pts = p.kind === 'region' ? p.outline : [p.a, { x: p.b.x, y: p.a.y }, p.b, { x: p.a.x, y: p.b.y }];
      obstacles.push(...grow([toPath(pts)], clearanceGap(doc, self, p), true));
    }
  }
  // Text on this layer of another net (or no net) is an obstacle too
  for (const p of doc.prims) {
    if (p.kind !== 'text' || p.layer !== layer || p.hidden) continue;
    // A barcode keeps the pour off its whole box
    if (p.barcode) { obstacles.push(...grow([toPath(barcodeShape(p.text, p.at, p.rotation, p.mirrored, p.height, p.barcode).box)], clearanceGap(doc, self, p), true)); continue; }
    const strokes = strokeText(p.text, p.at, strokeCapHeight(p), p.rotation, p.mirrored).map(toPath);
    if (strokes.length) obstacles.push(...grow(strokes, (p.fontType === 1 ? strokeCapHeight(p) / 10 : p.strokeWidth || p.height / 10) / 2 + clearanceGap(doc, self, p), false));
  }

  const blocked = union(obstacles);
  const open = clip(region, blocked, C.ClipType.ctDifference);
  let copper = clip(open, union(gaps), C.ClipType.ctDifference);
  // Remove Necks When Copper Width Less Than: copper narrower than the threshold goes (shrunk by half of it, grown back)
  if (b.bool('REMOVENECKS')) {
    const wr = b.bool('NECKWIDTHFROMRULE') ? ruleFor(doc, 'Width', self) : undefined;
    const neck = wr ? ruleLength(wr, 'MINLIMIT', '5mil') : len(b.get('NECKWIDTHTHRESHOLD'), '5mil');
    if (neck > 0) copper = sharpGrow(sharpGrow(copper, -neck / 2), neck / 2);
  }
  if (spokes.length) copper = union(copper, clip(union(spokes), open, C.ClipType.ctIntersection));

  // Islands: keep those that touch the net (Remove Dead Copper) and are big enough
  const t = new C.Clipper();
  t.AddPaths(copper, C.PolyType.ptSubject, true);
  const poly2 = new C.PolyTree();
  t.Execute(C.ClipType.ctUnion, poly2, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  const removeDead = b.has('REMOVEDEAD') ? b.bool('REMOVEDEAD') : true;
  const byArea = b.bool('REMOVEISLANDSBYAREA');
  const minArea = byArea ? islandAreaOf(b) * 1e8 /* mil² → units² */ : 0;
  const out: PourResult = { regions: [], tracks: [], removed: 0 };
  const islands: { outer: Path; holes: Paths }[] = [];
  const walk = (node: ClipperNS.PolyNode) => {
    for (const ch of node.Childs()) {
      if (!ch.IsHole()) { islands.push({ outer: ch.Contour(), holes: ch.Childs().map((h) => h.Contour()) }); for (const h of ch.Childs()) walk(h); }
    }
  };
  walk(poly2);
  for (const isl of islands) {
    const inside = (v: Vec2) => { const q = { X: Math.round(v.x - OX), Y: Math.round(v.y - OY) }; return C.Clipper.PointInPolygon(q, isl.outer) !== 0 && !isl.holes.some((h) => C.Clipper.PointInPolygon(q, h) === 1); };
    const area = Math.abs(C.Clipper.Area(isl.outer)) - isl.holes.reduce((a, h) => a + Math.abs(C.Clipper.Area(h)), 0);
    if ((removeDead && net !== NO_NET && !anchors.some(inside)) || (minArea && area < minArea)) { out.removed++; continue; }
    out.regions.push({ outline: fromPath(isl.outer), holes: isl.holes.map(fromPath) });
  }

  const hatch = (poly.hatch || 'Solid').toLowerCase();
  if (hatch !== 'solid') {
    const w = len(b.get('TRACKWIDTH'), '8mil'), grid = Math.max(len(b.get('GRIDSIZE'), '20mil'), w);
    const area: Paths = out.regions.flatMap((r) => [toPath(r.outline), ...r.holes.map(toPath)]);
    const inset = grow(area, -w / 2, true);
    // Outline tracks round every contour
    for (const c of inset) { const pts = fromPath(c); for (let i = 0; i < pts.length; i++) out.tracks.push({ a: pts[i]!, b: pts[(i + 1) % pts.length]!, width: w }); }
    if (hatch !== 'none') {
      const bb = box;
      const lines: Paths = [];
      const dirs = hatch.startsWith('45') ? [45, 135] : hatch.startsWith('90') ? [0, 90] : hatch.startsWith('hor') ? [0] : [90];
      const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2, R = Math.hypot(bb.maxX - bb.minX, bb.maxY - bb.minY) / 2 + grid;
      for (const d of dirs) {
        const a = (d * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a), nx = -uy, ny = ux;
        for (let k = -Math.ceil(R / grid); k <= Math.ceil(R / grid); k++) {
          const o = k * grid;
          lines.push(toPath([{ x: cx + nx * o - ux * R, y: cy + ny * o - uy * R }, { x: cx + nx * o + ux * R, y: cy + ny * o + uy * R }]));
        }
      }
      const c = new C.Clipper();
      c.AddPaths(lines, C.PolyType.ptSubject, false);
      c.AddPaths(inset, C.PolyType.ptClip, true);
      const tr = new C.PolyTree();
      c.Execute(C.ClipType.ctIntersection, tr, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
      for (const pth of C.Clipper.OpenPathsFromPolyTree(tr)) { const pts = fromPath(pth); for (let i = 1; i < pts.length; i++) out.tracks.push({ a: pts[i - 1]!, b: pts[i]!, width: w }); }
    }
    out.regions = [];
  }
  return out;
}
