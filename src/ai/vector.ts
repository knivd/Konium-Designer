/**
 * A drawing's own geometry: the straight pieces of every path a PDF page draws (curves flattened),
 * in the pixels of a picture of it (the same transform pdf.js renders with), so that what was found
 * in the picture can be measured exactly. Datasheet land patterns are nearly always vector drawings:
 * a pad's outline is drawn on its edge, so its edges come from the lines, not from the ink (whose
 * stroke adds its own width).
 */

export interface Seg { a: { x: number; y: number }; b: { x: number; y: number } }

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mat = [number, number, number, number, number, number];
const mul = (t: Mat, m: number[]): Mat => [
  t[0] * m[0]! + t[2] * m[1]!, t[1] * m[0]! + t[3] * m[1]!,
  t[0] * m[2]! + t[2] * m[3]!, t[1] * m[2]! + t[3] * m[3]!,
  t[0] * m[4]! + t[2] * m[5]! + t[4], t[1] * m[4]! + t[3] * m[5]! + t[5],
];

/**
 * The segments a page's operator list draws, through `start` (the viewport's transform: page
 * space to picture pixels), kept when they touch the picture (`w` × `h`). `OPS` is pdf.js's.
 */
export function pathSegments(fnArray: number[], argsArray: any[][], OPS: Record<string, number>, start: number[], w: number, h: number): Seg[] {
  const out: Seg[] = [];
  let t: Mat = [start[0]!, start[1]!, start[2]!, start[3]!, start[4]!, start[5]!];
  const stack: Mat[] = [];
  const P = (x: number, y: number) => ({ x: t[0] * x + t[2] * y + t[4], y: t[1] * x + t[3] * y + t[5] });
  const inside = (p: { x: number; y: number }) => p.x >= -2 && p.y >= -2 && p.x <= w + 2 && p.y <= h + 2;
  const add = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    if ((a.x !== b.x || a.y !== b.y) && (inside(a) || inside(b)) && out.length < 400_000) out.push({ a, b });
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(t);
    else if (fn === OPS.restore) t = stack.pop() ?? t;
    else if (fn === OPS.transform) t = mul(t, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(t); const m = args?.[0]; if (m && m.length === 6) t = mul(t, Array.from(m as number[])); }
    else if (fn === OPS.paintFormXObjectEnd) t = stack.pop() ?? t;
    else if (fn === OPS.constructPath) {
      const raw = args?.[1]?.[0] ?? args?.[1];
      if (!raw || typeof raw.length !== 'number') continue;
      const d = raw as ArrayLike<number>;
      let cur = { x: 0, y: 0 }, first = cur;
      for (let k = 0; k < d.length;) {
        const op = d[k++];
        if (op === 0) { cur = P(d[k]!, d[k + 1]!); first = cur; k += 2; }
        else if (op === 1) { const p = P(d[k]!, d[k + 1]!); add(cur, p); cur = p; k += 2; }
        else if (op === 2 || op === 3) {
          // A Bézier curve, as eight straight pieces
          const n = op === 2 ? 6 : 4, c = Array.from({ length: n / 2 }, (_, j) => P(d[k + 2 * j]!, d[k + 2 * j + 1]!));
          k += n;
          const p0 = cur;
          for (let s = 1; s <= 8; s++) {
            const u = s / 8, v = 1 - u;
            const p = op === 2
              ? { x: v * v * v * p0.x + 3 * v * v * u * c[0]!.x + 3 * v * u * u * c[1]!.x + u * u * u * c[2]!.x, y: v * v * v * p0.y + 3 * v * v * u * c[0]!.y + 3 * v * u * u * c[1]!.y + u * u * u * c[2]!.y }
              : { x: v * v * p0.x + 2 * v * u * c[0]!.x + u * u * c[1]!.x, y: v * v * p0.y + 2 * v * u * c[0]!.y + u * u * c[1]!.y };
            add(cur, p); cur = p;
          }
        } else if (op === 4) { add(cur, first); cur = first; }
        else break;
      }
    }
  }
  return out;
}
