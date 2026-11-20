/**
 * Board Options › Route Tool Path: the mechanical layer whose lines are the router's path (the
 * board milled along them). Konium keeps it in Board6 as KONIUMROUTETOOLLAYER (the layer's
 * number; absent, Do not use) [est: AD17's own key isn't known]. 3D Layout Mode cuts the board
 * along it when Physical Materials › Show Route Tool Path is on.
 */
import type { Vec2 } from '../core/geom';
import { isMech, type LayerId } from './layers';
import type { PcbDocument } from './pcb';
import { strokeOutlines } from './outlineOps';

export function routeToolLayer(doc: PcbDocument): LayerId | null {
  const n = Number(doc.board.bag?.get('KONIUMROUTETOOLLAYER') ?? 0);
  return n > 0 && isMech(n as LayerId) ? (n as LayerId) : null;
}

/** The route tool path's tracks and arcs as the outlines the router cuts (their width the tool's). */
export function routeCuts(doc: PcbDocument, layer = routeToolLayer(doc)): Vec2[][] {
  if (layer === null) return [];
  const lines: { pts: Vec2[]; width: number }[] = [];
  for (const p of doc.prims) {
    if (p.kind === 'track' && p.layer === layer) lines.push({ pts: [p.a, p.b], width: p.width });
    else if (p.kind === 'arc' && p.layer === layer) {
      const sweep = (((p.end - p.start) % 360) + 360) % 360 || 360, n = Math.max(4, Math.ceil(sweep / 6));
      lines.push({ width: p.width, pts: Array.from({ length: n + 1 }, (_, i) => { const a = ((p.start + (sweep * i) / n) * Math.PI) / 180; return { x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) }; }) });
    }
  }
  return strokeOutlines(lines);
}
