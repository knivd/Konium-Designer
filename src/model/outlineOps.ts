/**
 * Plain outlines (point lists) combined, intersected, subtracted and grown — for rigid-flex
 * regions (Advanced mode's overlaps) and coverlay shapes. Kept apart from the pour edits so the
 * board model can use them without the file reader.
 */
import * as ClipperNS from 'clipper-lib';
import type { Vec2 } from '../core/geom';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;
type Path = ClipperNS.IntPoint[];
// Worked about the outlines' centre (OX, OY): Clipper's JavaScript port turns to slow BigInteger maths past ±47,453,132 units
let OX = 0, OY = 0;
const toPath = (pts: Vec2[]): Path => pts.map((p) => ({ X: Math.round(p.x - OX), Y: Math.round(p.y - OY) }));
const fromPath = (p: Path): Vec2[] => p.map((q) => ({ x: q.X + OX, y: q.Y + OY }));
function about<T>(outlines: Vec2[][], fn: () => T): T {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of outlines) for (const p of o) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  const was = [OX, OY] as const;
  if (minX <= maxX) { OX = Math.round((minX + maxX) / 2); OY = Math.round((minY + maxY) / 2); }
  try { return fn(); } finally { [OX, OY] = was; }
}
export const outlineArea = (pts: Vec2[]): number => about([pts], () => Math.abs(C.Clipper.Area(toPath(pts))));

/** Outlines combined, intersected or subtracted: outer contours, largest first (holes dropped). */
export function clipOutlines(kind: 'union' | 'intersect' | 'difference', subject: Vec2[][], clip: Vec2[][] = []): Vec2[][] {
  return about([...subject, ...clip], () => clipAbout(kind, subject, clip));
}
function clipAbout(kind: 'union' | 'intersect' | 'difference', subject: Vec2[][], clip: Vec2[][]): Vec2[][] {
  const t = kind === 'union' ? C.ClipType.ctUnion : kind === 'intersect' ? C.ClipType.ctIntersection : C.ClipType.ctDifference;
  const c = new C.Clipper();
  c.AddPaths(subject.map(toPath), C.PolyType.ptSubject, true);
  c.AddPaths(clip.map(toPath), C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(t, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  const out: Vec2[][] = [];
  for (const ch of tree.Childs()) if (!ch.IsHole()) out.push(fromPath(ch.Contour()));
  return out.filter((o) => o.length >= 3).sort((a, b) => outlineArea(b) - outlineArea(a));
}
/** As clipOutlines, but every contour of the result, holes and islands in them included (to be filled even-odd). */
export function clipContours(kind: 'union' | 'intersect' | 'difference', subject: Vec2[][], clip: Vec2[][] = []): Vec2[][] {
  return about([...subject, ...clip], () => {
    const c = new C.Clipper();
    c.AddPaths(subject.map(toPath), C.PolyType.ptSubject, true);
    c.AddPaths(clip.map(toPath), C.PolyType.ptClip, true);
    const tree = new C.PolyTree();
    c.Execute(kind === 'union' ? C.ClipType.ctUnion : kind === 'intersect' ? C.ClipType.ctIntersection : C.ClipType.ctDifference, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    const out: Vec2[][] = [];
    const walk = (n: ClipperNS.PolyNode) => { for (const ch of n.Childs()) { out.push(fromPath(ch.Contour())); walk(ch); } };
    walk(tree);
    return out.filter((o) => o.length >= 3);
  });
}
/** An outline grown (negative: shrunk) by `by`, corners kept sharp. */
export function offsetOutline(outline: Vec2[], by: number): Vec2[][] {
  if (!by) return [outline];
  return about([outline], () => offsetAbout(outline, by));
}
function offsetAbout(outline: Vec2[], by: number): Vec2[][] {
  const co = new C.ClipperOffset(4, 250);
  co.AddPath(toPath(outline), C.JoinType.jtMiter, C.EndType.etClosedPolygon);
  const out: Path[] = [];
  co.Execute(out, by);
  return out.map(fromPath).filter((o) => o.length >= 3).sort((a, b) => outlineArea(b) - outlineArea(a));
}
/** The area two outlines share. */
export const sharedArea = (a: Vec2[], b: Vec2[]): number => clipOutlines('intersect', [a], [b]).reduce((t, o) => t + outlineArea(o), 0);

/** Outlines combined, intersected or subtracted: each outer contour with the holes in it (islands in holes are pieces of their own). */
export function clipPieces(kind: 'union' | 'intersect' | 'difference', subject: Vec2[][], clip: Vec2[][] = []): { outline: Vec2[]; holes: Vec2[][] }[] {
  return about([...subject, ...clip], () => {
    const c = new C.Clipper();
    c.AddPaths(subject.map(toPath), C.PolyType.ptSubject, true);
    c.AddPaths(clip.map(toPath), C.PolyType.ptClip, true);
    const tree = new C.PolyTree();
    c.Execute(kind === 'union' ? C.ClipType.ctUnion : kind === 'intersect' ? C.ClipType.ctIntersection : C.ClipType.ctDifference, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    const out: { outline: Vec2[]; holes: Vec2[][] }[] = [];
    const walk = (n: ClipperNS.PolyNode) => {
      for (const outer of n.Childs()) {
        if (outer.IsHole()) continue;
        const holes: Vec2[][] = [];
        for (const h of outer.Childs()) { holes.push(fromPath(h.Contour())); walk(h); }
        out.push({ outline: fromPath(outer.Contour()), holes: holes.filter((x) => x.length >= 3) });
      }
    };
    walk(tree);
    return out.filter((p) => p.outline.length >= 3);
  });
}
/** Lines of a width (round ends) as the outlines they cover, joined. */
export function strokeOutlines(lines: { pts: Vec2[]; width: number }[]): Vec2[][] {
  if (!lines.length) return [];
  return about(lines.map((l) => l.pts), () => {
    const paths: Path[] = [];
    for (const l of lines) {
      const co = new C.ClipperOffset(2, 250);
      co.AddPath(toPath(l.pts), C.JoinType.jtRound, C.EndType.etOpenRound);
      const o: Path[] = [];
      co.Execute(o, Math.max(1, l.width / 2));
      paths.push(...o);
    }
    const c = new C.Clipper();
    c.AddPaths(paths, C.PolyType.ptSubject, true);
    const out: Path[] = [];
    c.Execute(C.ClipType.ctUnion, out, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    return out.map(fromPath).filter((o) => o.length >= 3);
  });
}
