/**
 * Editing handles of a selected schematic object, as Altium shows them: wire and line vertices,
 * rectangle / text frame corners, the sheet symbol's resize corner. Dragging one reshapes the
 * object; its other coordinates stay put.
 */
import type { Vec2 } from '../core/geom';
import { SCH_UNIT } from '../core/units';
import type { PropertyBag } from '../formats/altium/props';
import { SR, setSchCoord, type SchObject } from './sch';

export function gripsOf(o: SchObject): Vec2[] {
  switch (o.kind) {
    case 'wire': case 'bus': case 'polyline': case 'polygon': case 'bezier': case 'blanket': return o.pts;
    case 'busentry': return [o.a, o.b];
    case 'rect': case 'textframe': case 'image': case 'compilemask': {
      const x0 = Math.min(o.a.x, o.b.x), x1 = Math.max(o.a.x, o.b.x), y0 = Math.min(o.a.y, o.b.y), y1 = Math.max(o.a.y, o.b.y);
      return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    }
    case 'sheetsymbol': case 'harness': return [{ x: o.at.x + o.w, y: o.at.y - o.h }];
    case 'signalharness': return o.pts;
    default: return [];
  }
}

/** The bag with grip k moved to p (a new bag). */
export function moveGrip(src: PropertyBag, o: SchObject, k: number, p: Vec2): PropertyBag {
  const bag = src.clone();
  const rec = bag.int('RECORD');
  switch (o.kind) {
    case 'wire': case 'bus': case 'polyline': case 'polygon': case 'bezier': case 'blanket':
      if (rec === SR.LINE) { const key = k === 0 ? 'LOCATION' : 'CORNER'; setSchCoord(bag, `${key}.X`, p.x); setSchCoord(bag, `${key}.Y`, p.y); }
      else { setSchCoord(bag, `X${k + 1}`, p.x); setSchCoord(bag, `Y${k + 1}`, p.y); }
      if (rec === SR.BLANKET) {
        // A blanket's LOCATION / CORNER bound its polygon
        const pts = o.pts.map((q, i) => (i === k ? p : q));
        setSchCoord(bag, 'LOCATION.X', Math.min(...pts.map((q) => q.x))); setSchCoord(bag, 'LOCATION.Y', Math.min(...pts.map((q) => q.y)));
        setSchCoord(bag, 'CORNER.X', Math.max(...pts.map((q) => q.x))); setSchCoord(bag, 'CORNER.Y', Math.max(...pts.map((q) => q.y)));
      }
      break;
    case 'busentry': { const key = k === 0 ? 'LOCATION' : 'CORNER'; setSchCoord(bag, `${key}.X`, p.x); setSchCoord(bag, `${key}.Y`, p.y); break; }
    case 'rect': case 'textframe': case 'image': case 'compilemask': {
      const g = gripsOf(o);
      const opp = g[(k + 2) % 4]!;
      setSchCoord(bag, 'LOCATION.X', Math.min(p.x, opp.x)); setSchCoord(bag, 'LOCATION.Y', Math.min(p.y, opp.y));
      setSchCoord(bag, 'CORNER.X', Math.max(p.x, opp.x)); setSchCoord(bag, 'CORNER.Y', Math.max(p.y, opp.y));
      break;
    }
    case 'signalharness': setSchCoord(bag, `X${k + 1}`, p.x); setSchCoord(bag, `Y${k + 1}`, p.y); break;
    case 'sheetsymbol': case 'harness': {
      const w = Math.max(SCH_UNIT * 10, p.x - o.at.x), h = Math.max(SCH_UNIT * 10, o.at.y - p.y);
      setSchCoord(bag, 'XSIZE', w); setSchCoord(bag, 'YSIZE', h);
      break;
    }
  }
  return bag;
}
