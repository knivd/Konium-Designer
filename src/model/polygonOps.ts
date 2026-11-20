/**
 * Polygon pour edits (Place › Polygon Pour and the right-click Polygon Actions): Slice Polygon
 * Pour (a line across a pour makes it two or more), Combine Selected Polygons, Subtract Polygons
 * From Selected [est: the other pours on the layer that overlap are taken out of each selected
 * one], Modify Polygon Border (a new stretch of border between two points on it), Resize Polygon
 * (the outline grown or shrunk), Bring To Front / Send To Back (pour order).
 */
import * as ClipperNS from 'clipper-lib';
import type { Vec2 } from '../core/geom';
import type { PcbDocument, PcbPolygon, PolyVertex } from './pcb';
import { writeVertices } from '../formats/altium/pcbdoc';
import type { PropertyBag } from '../formats/altium/props';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;
type Path = ClipperNS.IntPoint[];
const toPath = (pts: Vec2[]): Path => pts.map((p) => ({ X: Math.round(p.x), Y: Math.round(p.y) }));
const fromPath = (p: Path): Vec2[] => p.map((q) => ({ x: q.X, y: q.Y }));
const area = (pts: Vec2[]) => Math.abs(C.Clipper.Area(toPath(pts)));

function run(type: ClipperNS.ClipType, subject: Path[], clip: Path[]): Vec2[][] {
  const c = new C.Clipper();
  c.AddPaths(subject, C.PolyType.ptSubject, true);
  c.AddPaths(clip, C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(type, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  // Outer contours only: a pour's outline has no holes (cut-outs are their own objects)
  const out: Vec2[][] = [];
  for (const ch of tree.Childs()) if (!ch.IsHole()) out.push(C.Clipper.CleanPolygon(ch.Contour(), 2).length >= 3 ? fromPath(C.Clipper.CleanPolygon(ch.Contour(), 2)) : fromPath(ch.Contour()));
  return out.filter((o) => o.length >= 3).sort((a, b) => area(b) - area(a));
}

/** A pour's bag with a new outline (straight edges). */
export function withOutline(bag: PropertyBag, outline: Vec2[]): PropertyBag {
  const b = bag.clone();
  const verts: PolyVertex[] = outline.map((p) => ({ p: { x: Math.round(p.x), y: Math.round(p.y) } }));
  writeVertices(b, verts);
  return b;
}

/** Slice Polygon Pour: the pieces either side of the line (one when it doesn't cross the pour). */
export function slicePolygon(poly: PcbPolygon, a: Vec2, b: Vec2): Vec2[][] {
  const l = Math.hypot(b.x - a.x, b.y - a.y);
  if (l < 1) return [poly.outline];
  const ux = (b.x - a.x) / l, uy = (b.y - a.y) / l, nx = -uy, ny = ux, w = 1;
  const strip = [{ x: a.x + nx * w, y: a.y + ny * w }, { x: b.x + nx * w, y: b.y + ny * w }, { x: b.x - nx * w, y: b.y - ny * w }, { x: a.x - nx * w, y: a.y - ny * w }];
  return run(C.ClipType.ctDifference, [toPath(poly.outline)], [toPath(strip)]);
}

/** Combine Selected Polygons: their outlines as one (several when they don't touch). */
export function combinePolygons(polys: PcbPolygon[]): Vec2[][] {
  return run(C.ClipType.ctUnion, polys.map((p) => toPath(p.outline)), []);
}

/** Subtract Polygons From Selected: what is left of a pour once the others are taken out. */
export function subtractPolygons(from: PcbPolygon, others: PcbPolygon[]): Vec2[][] {
  return run(C.ClipType.ctDifference, [toPath(from.outline)], others.map((p) => toPath(p.outline)));
}

/** Resize Polygon: the outline grown (or shrunk, negative) by `by`, corners kept sharp. */
export function resizePolygon(poly: PcbPolygon, by: number): Vec2[][] {
  const co = new C.ClipperOffset(4, 250);
  co.AddPath(toPath(poly.outline), C.JoinType.jtMiter, C.EndType.etClosedPolygon);
  const out: Path[] = [];
  co.Execute(out, by);
  return out.map(fromPath).filter((o) => o.length >= 3).sort((a, b) => area(b) - area(a));
}

/** Where on the outline a point lies: the edge it is on and how far along. */
export function onOutline(outline: Vec2[], p: Vec2, tol: number): { edge: number; at: Vec2 } | null {
  let best: { edge: number; at: Vec2; d: number } | null = null;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!, b = outline[(i + 1) % outline.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const q = { x: Math.round(a.x + t * dx), y: Math.round(a.y + t * dy) };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d <= tol && (!best || d < best.d)) best = { edge: i, at: q, d };
  }
  return best ? { edge: best.edge, at: best.at } : null;
}

/**
 * Modify Polygon Border: a new stretch from one point on the border, through `via`, to another;
 * of the two ways round, the one that leaves the larger pour is kept [est].
 */
export function modifyBorder(outline: Vec2[], from: { edge: number; at: Vec2 }, to: { edge: number; at: Vec2 }, via: Vec2[]): Vec2[] {
  const n = outline.length;
  // The outline from `to` round to `from` (forward), then the new stretch back to `to`
  const walk = (s: { edge: number; at: Vec2 }, e: { edge: number; at: Vec2 }): Vec2[] => {
    const out: Vec2[] = [s.at];
    if (s.edge === e.edge) {
      const a = outline[s.edge]!;
      // Both on one edge: forward only if e is further along than s
      if (Math.hypot(e.at.x - a.x, e.at.y - a.y) >= Math.hypot(s.at.x - a.x, s.at.y - a.y)) { out.push(e.at); return out; }
    }
    for (let k = 1; k <= n; k++) {
      const i = (s.edge + k) % n;
      out.push(outline[i]!);
      if (i === e.edge) break;
    }
    out.push(e.at);
    return out;
  };
  const a = [...walk(to, from), ...via];            // keep to → from, the new stretch from → to
  const b = [...walk(from, to), ...[...via].reverse()]; // keep from → to, the new stretch to → from
  return area(a) >= area(b) ? a : b;
}

/** Pour order with the given pours first (Bring To Front) or last (Send To Back): POURINDEX of every pour. */
export function pourOrder(doc: PcbDocument, picked: Set<number>, front: boolean): Map<number, number> {
  const order = [...doc.polygons].sort((a, b) => a.bag.int('POURINDEX', a.index) - b.bag.int('POURINDEX', b.index)).map((p) => p.index);
  const mine = order.filter((i) => picked.has(i)), rest = order.filter((i) => !picked.has(i));
  const next = front ? [...mine, ...rest] : [...rest, ...mine];
  return new Map(next.map((i, k) => [i, k]));
}
