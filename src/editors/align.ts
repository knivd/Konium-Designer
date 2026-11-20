import type { BBox, Vec2 } from '../core/geom';

/** Edit › Align: Left, Right, Top, Bottom, the centres, and Distribute (equal gaps). */
export type AlignKind = 'left' | 'right' | 'top' | 'bottom' | 'hCentre' | 'vCentre' | 'distributeH' | 'distributeV';

/** How far each box moves; the selection's outer edges are the references, as in Altium. */
export function alignDeltas(boxes: BBox[], kind: AlignKind): Vec2[] {
  if (!boxes.length) return [];
  const minX = Math.min(...boxes.map((b) => b.minX)), maxX = Math.max(...boxes.map((b) => b.maxX));
  const minY = Math.min(...boxes.map((b) => b.minY)), maxY = Math.max(...boxes.map((b) => b.maxY));
  const out = boxes.map(() => ({ x: 0, y: 0 }));
  const cx = (b: BBox) => (b.minX + b.maxX) / 2, cy = (b: BBox) => (b.minY + b.maxY) / 2;
  switch (kind) {
    case 'left': boxes.forEach((b, i) => { out[i]!.x = minX - b.minX; }); break;
    case 'right': boxes.forEach((b, i) => { out[i]!.x = maxX - b.maxX; }); break;
    case 'top': boxes.forEach((b, i) => { out[i]!.y = maxY - b.maxY; }); break;
    case 'bottom': boxes.forEach((b, i) => { out[i]!.y = minY - b.minY; }); break;
    case 'hCentre': { const c = (minX + maxX) / 2; boxes.forEach((b, i) => { out[i]!.x = c - cx(b); }); break; }
    case 'vCentre': { const c = (minY + maxY) / 2; boxes.forEach((b, i) => { out[i]!.y = c - cy(b); }); break; }
    case 'distributeH': case 'distributeV': {
      const h = kind === 'distributeH';
      const order = boxes.map((_, i) => i).sort((a, b) => (h ? cx(boxes[a]!) - cx(boxes[b]!) : cy(boxes[a]!) - cy(boxes[b]!)));
      if (order.length < 3) break;
      const size = (b: BBox) => (h ? b.maxX - b.minX : b.maxY - b.minY);
      const span = h ? maxX - minX : maxY - minY;
      const gap = (span - order.reduce((s, i) => s + size(boxes[i]!), 0)) / (order.length - 1);
      let at = h ? minX : minY;
      for (const i of order) {
        const b = boxes[i]!;
        if (h) out[i]!.x = at - b.minX; else out[i]!.y = at - b.minY;
        at += size(b) + gap;
      }
      break;
    }
  }
  return out.map((d) => ({ x: Math.round(d.x), y: Math.round(d.y) }));
}
