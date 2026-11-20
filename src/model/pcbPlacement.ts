/**
 * Component placement on a board: text autoposition round a part (Altium's codes 1–9) and
 * positional re-annotation. Pure: the caller gives each part's extent.
 */
import { mil, mm } from '../core/units';
import type { BBox, Vec2 } from '../core/geom';
import type { PcbDocument, PcbText } from './pcb';

const GAP = mil(10);
export type ReannotateOrder = 'xy' | 'x-y' | 'yx' | '-yx' | 'position';

/** Where a text's box lies about its insertion point (Altium's: the bottom-left of the unturned text). */
function textBox(t: PcbText): BBox {
  const tw = t.height * 0.62 * Math.max(1, t.text.length), r = (t.rotation * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const pts = [[0, 0], [tw, 0], [tw, t.height], [0, t.height]].map(([x, y]) => { const xx = t.mirrored ? -x! : x!; return { x: xx * c - y! * s, y: xx * s + y! * c }; });
  return { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) };
}

/** Where a text goes for an autoposition code round a box (1–9: top / centre / bottom of left / centre / right). */
export function autoposition(code: number, box: BBox, t: PcbText): Vec2 | null {
  if (code < 1 || code > 9) return null;
  const tb = textBox(t), w = tb.maxX - tb.minX, h = tb.maxY - tb.minY;
  const col = Math.floor((code - 1) / 3), row = (code - 1) % 3; // col 0 left, 1 centre, 2 right; row 0 top, 1 centre, 2 bottom
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  let minX: number, minY: number;
  if (row === 1) {
    // Beside the part (or on it, centred)
    minY = cy - h / 2;
    minX = col === 0 ? box.minX - GAP - w : col === 2 ? box.maxX + GAP : cx - w / 2;
  } else {
    minY = row === 0 ? box.maxY + GAP : box.minY - GAP - h;
    minX = col === 0 ? box.minX : col === 2 ? box.maxX - w : cx - w / 2;
  }
  return { x: Math.round(minX - tb.minX), y: Math.round(minY - tb.minY) };
}

/** The renames positional re-annotation gives: per prefix, numbered from 1 in the chosen order of the parts' centres. */
export function reannotation(doc: PcbDocument, order: ReannotateOrder, boxOf: (c: number) => BBox): { from: string; to: string; index: number }[] {
  const parts = doc.components.map((comp, i) => {
    const b = boxOf(i);
    const at = b.minX <= b.maxX ? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 } : comp.at;
    const m = /^(.*?)(\d+)?$/.exec(comp.designator)!;
    return { i, designator: comp.designator, prefix: m[1] || comp.designator, at };
  }).filter((p) => p.designator);
  const tol = mil(5);
  const cmp = (a: number, b: number) => (Math.abs(a - b) <= tol ? 0 : a - b);
  const key = (p: { at: Vec2 }, q: { at: Vec2 }) => {
    switch (order) {
      case 'xy': return cmp(p.at.x, q.at.x) || cmp(p.at.y, q.at.y);
      case 'x-y': return cmp(p.at.x, q.at.x) || cmp(q.at.y, p.at.y);
      case 'yx': return cmp(p.at.y, q.at.y) || cmp(p.at.x, q.at.x);
      default: return cmp(q.at.y, p.at.y) || cmp(p.at.x, q.at.x);
    }
  };
  // 5 Name from Position: the prefix and where the component is from the absolute origin (its reference point),
  // in whole mils or millimetres as the board measures [est: AD's format]; a letter after a name already given
  if (order === 'position') {
    const metric = doc.board.bag?.int('DISPLAYUNIT') === 0, unit = metric ? mm(1) : mil(1);
    const seen = new Map<string, number>();
    return parts.map((p) => {
      const at = doc.components[p.i]!.at;
      let to = `${p.prefix}${Math.round(at.x / unit)}_${Math.round(at.y / unit)}`;
      const k = seen.get(to) ?? 0;
      seen.set(to, k + 1);
      if (k) to += String.fromCharCode(64 + k);
      return { from: p.designator, to, index: p.i };
    }).sort((a, b) => a.from.localeCompare(b.from, undefined, { numeric: true }));
  }
  const groups = new Map<string, typeof parts>();
  for (const p of parts) { const g = groups.get(p.prefix) ?? []; g.push(p); groups.set(p.prefix, g); }
  const out: { from: string; to: string; index: number }[] = [];
  for (const [prefix, g] of groups) [...g].sort(key).forEach((p, k) => out.push({ from: p.designator, to: `${prefix}${k + 1}`, index: p.i }));
  return out.sort((a, b) => a.from.localeCompare(b.from, undefined, { numeric: true }));
}

