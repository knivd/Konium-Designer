/**
 * A region with holes as pieces with none. A Gerber region can't have holes of its own: drawn as
 * clear (LPC) contours they would also erase whatever was plotted before them there (another
 * pour's island inside the hole). So each piece with a hole is cut across it, through its middle,
 * until no hole is left enclosed; the pieces abut along the cuts.
 */
import * as ClipperNS from 'clipper-lib';
import type { Vec2 } from '../../core/geom';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;
type Path = ClipperNS.IntPoint[];

export function holeFree(outline: Vec2[], holes: Vec2[][]): Vec2[][] {
  const real = holes.filter((h) => h.length >= 3);
  if (!real.length) return [outline];
  // About the outline's centre: Clipper's JavaScript port turns to (slow) BigInteger maths past ±47,453,132 units
  const xs = outline.map((p) => p.x), ys0 = outline.map((p) => p.y);
  const ox = Math.round((Math.min(...xs) + Math.max(...xs)) / 2), oy = Math.round((Math.min(...ys0) + Math.max(...ys0)) / 2);
  const toPath = (pts: Vec2[]): Path => pts.map((p) => ({ X: Math.round(p.x - ox), Y: Math.round(p.y - oy) }));
  const fromPath = (p: Path): Vec2[] => p.map((q) => ({ x: q.X + ox, y: q.Y + oy }));
  const out: Vec2[][] = [];
  const todo: { outer: Path; holes: Path[] }[] = [{ outer: toPath(outline), holes: real.map(toPath) }];
  for (let guard = 0; todo.length && guard < 100_000; guard++) {
    const t = todo.pop()!;
    // A hole too thin to cut through is left as copper
    const ys = (h: Path) => h.reduce((m, q) => [Math.min(m[0]!, q.Y), Math.max(m[1]!, q.Y)], [Infinity, -Infinity]);
    // Cut through the middle of the hole whose middle is the median of the holes' (each cut halves
    // the work left, rather than paring one piece off a big pour per hole)
    const mids = t.holes.map(ys).filter(([a, b]) => b! - a! >= 2).map(([a, b]) => Math.floor((a! + b!) / 2)).sort((p, q) => p - q);
    if (!mids.length) { out.push(fromPath(t.outer)); continue; }
    const y = mids[mids.length >> 1]!;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const q of t.outer) { minX = Math.min(minX, q.X); maxX = Math.max(maxX, q.X); minY = Math.min(minY, q.Y); maxY = Math.max(maxY, q.Y); }
    for (const [y0, y1] of [[minY - 1, y], [y, maxY + 1]] as const) {
      const c = new C.Clipper();
      c.AddPaths([t.outer, ...t.holes], C.PolyType.ptSubject, true);
      c.AddPath([{ X: minX - 1, Y: y0 }, { X: maxX + 1, Y: y0 }, { X: maxX + 1, Y: y1 }, { X: minX - 1, Y: y1 }], C.PolyType.ptClip, true);
      const tree = new C.PolyTree();
      c.Execute(C.ClipType.ctIntersection, tree, C.PolyFillType.pftEvenOdd, C.PolyFillType.pftNonZero);
      // Every outer contour (islands inside holes included) with the holes directly in it
      const walk = (n: ClipperNS.PolyNode) => {
        for (const k of n.Childs()) {
          if (!k.IsHole()) todo.push({ outer: k.Contour(), holes: k.Childs().map((x) => x.Contour()) });
          walk(k);
        }
      };
      walk(tree);
    }
  }
  return out;
}
