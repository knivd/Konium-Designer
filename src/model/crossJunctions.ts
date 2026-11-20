/**
 * Tools › Convert › Convert Cross Junctions: a junction where wires meet from all four sides
 * becomes two T-junctions a grid step apart — the wire coming up from below jogs right by a
 * step and meets the horizontal wire there, so the drawing can't be misread as a crossing.
 * Connectivity is unchanged. Arms shorter than a step are left alone.
 */
import type { Change } from '../core/undo';
import type { Vec2 } from '../core/geom';
import type { PropertyBag } from '../formats/altium/props';
import { isShown, setSchCoord, type SchDocument, type SchObject } from './sch';
import { addRecords, removeObjects } from './schEdit';
import { junctionBagAt } from './schPlace';

type Wire = SchObject & { kind: 'wire' };
const same = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
const inside = (p: Vec2, a: Vec2, b: Vec2) => (a.x === b.x && p.x === a.x && p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y))
  || (a.y === b.y && p.y === a.y && p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x));

function withPoints(src: PropertyBag, pts: Vec2[]): PropertyBag {
  const b = src.clone();
  for (const k of b.keys()) if (/^[XY]\d+(_FRAC)?$/.test(k)) b.delete(k);
  b.set('LOCATIONCOUNT', String(pts.length));
  pts.forEach((p, i) => { setSchCoord(b, `X${i + 1}`, p.x); setSchCoord(b, `Y${i + 1}`, p.y); });
  return b;
}

/** `at`: only these points (junction object or not), as after placing a wire; else every junction. */
export function crossJunctionChanges(doc: SchDocument, step: number, at?: Vec2[]): { changes: Change[]; count: number } {
  const wires = doc.objects.filter((o): o is Wire => o.kind === 'wire' && isShown(doc, o) && o.pts.length >= 2);
  const add: PropertyBag[] = [];
  const remove = new Set<number>();
  let count = 0;
  const points = at ? at.filter((p, i) => at.findIndex((q) => same(p, q)) === i)
    : doc.objects.flatMap((j) => (j.kind === 'junction' && isShown(doc, j) ? [j.at] : []));
  for (const J of points) {
    // The arms at J: [wire, direction]
    const dirs = new Set<string>();
    let down: { w: Wire; seg: number; through: boolean } | null = null;
    let rightLen = 0;
    for (const w of wires) {
      for (let i = 1; i < w.pts.length; i++) {
        const a = w.pts[i - 1]!, b = w.pts[i]!;
        const arms: Vec2[] = same(a, J) ? [b] : same(b, J) ? [a] : inside(J, a, b) ? [a, b] : [];
        for (const o of arms) {
          const d = o.x > J.x ? 'r' : o.x < J.x ? 'l' : o.y > J.y ? 'u' : 'd';
          dirs.add(d);
          if (d === 'd' && J.y - o.y > step) down = { w, seg: i, through: arms.length === 2 };
          if (d === 'r') rightLen = Math.max(rightLen, o.x - J.x);
        }
      }
    }
    if (dirs.size !== 4 || !down || rightLen <= step || remove.has(down.w.index)) continue;
    const { w, seg } = down;
    const bag = doc.records[w.index + 1]!.bag!;
    const jog = (rest: Vec2[]) => [{ x: J.x + step, y: J.y }, { x: J.x + step, y: J.y - step }, { x: J.x, y: J.y - step }, ...rest];
    const a = w.pts[seg - 1]!;
    if (down.through) {
      // Split the wire at J; the part below jogs
      const head = [...w.pts.slice(0, seg), J], tail = [J, ...w.pts.slice(seg)];
      const upper = a.y > J.y ? head : tail, lower = a.y > J.y ? tail : head;
      const lowerFromJ = same(lower[0]!, J) ? lower.slice(1) : lower.slice(0, -1).reverse();
      add.push(withPoints(bag, upper), withPoints(bag, jog(lowerFromJ)));
    } else {
      const k = w.pts.findIndex((p) => same(p, J));
      if (k === 0 || k === w.pts.length - 1) {
        // The wire ends at J going down
        const fromJ = k === 0 ? w.pts.slice(1) : w.pts.slice(0, -1).reverse();
        add.push(withPoints(bag, jog(fromJ)));
      } else {
        // J is a corner of the wire: split there; the side going down jogs, the other stays
        const before = w.pts.slice(0, k + 1), after = w.pts.slice(k);
        const arm = same(w.pts[seg - 1]!, J) ? seg : seg - 1;
        const downSide = arm > k ? after : before, keep = arm > k ? before : after;
        const fromJ = downSide === after ? after.slice(1) : before.slice(0, -1).reverse();
        add.push(withPoints(bag, keep), withPoints(bag, jog(fromJ)));
      }
    }
    add.push(junctionBagAt({ x: J.x + step, y: J.y }));
    remove.add(w.index);
    count++;
  }
  if (!count) return { changes: [], count: 0 };
  return { changes: [addRecords(doc, add), removeObjects(doc, [...remove])], count };
}
