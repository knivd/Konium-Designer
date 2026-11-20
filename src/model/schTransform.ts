/**
 * Moving, rotating and mirroring schematic records in place: what Altium does to a record when
 * you drag, Space-rotate or X/Y-flip it. Coordinates are written back with their _FRAC parts;
 * keys a record doesn't have are left alone, so untouched records keep their bytes.
 */
import type { Vec2 } from '../core/geom';
import { PropertyBag } from '../formats/altium/props';
import { SR, schCoord, setSchCoord, type SchDocument, ownedBy } from './sch';
import { SCH_UNIT } from '../core/units';

export interface SchXform {
  /** Rotate about here (and mirror across it) before moving. */
  pivot: Vec2;
  /** Quarter turns counter-clockwise: 0–3. */
  quarter: number;
  mirrorX: boolean;
  mirrorY: boolean;
  d: Vec2;
}

export const identity = (pivot: Vec2 = { x: 0, y: 0 }): SchXform => ({ pivot, quarter: 0, mirrorX: false, mirrorY: false, d: { x: 0, y: 0 } });

export function mapPoint(x: SchXform, p: Vec2): Vec2 {
  let dx = p.x - x.pivot.x, dy = p.y - x.pivot.y;
  if (x.mirrorX) dx = -dx;
  if (x.mirrorY) dy = -dy;
  for (let i = 0; i < ((x.quarter % 4) + 4) % 4; i++) [dx, dy] = [-dy, dx];
  return { x: x.pivot.x + dx + x.d.x, y: x.pivot.y + dy + x.d.y };
}

/** A direction (0 right, 1 up, 2 left, 3 down) after the transform. */
export function mapDir(x: SchXform, dir: number): number {
  let d = dir & 3;
  if (x.mirrorX && (d === 0 || d === 2)) d ^= 2;
  if (x.mirrorY && (d === 1 || d === 3)) d ^= 2;
  return (d + x.quarter) & 3;
}

/** An angle in degrees after the transform. */
function mapAngle(x: SchXform, a: number): number {
  let r = a;
  if (x.mirrorX) r = 180 - r;
  if (x.mirrorY) r = -r;
  return (((r + x.quarter * 90) % 360) + 360) % 360;
}

const fmtAngle = (a: number) => String(+a.toFixed(3));
const flipsOrder = (x: SchXform) => x.mirrorX !== x.mirrorY;

function point(bag: PropertyBag, xk: string, yk: string, x: SchXform): void {
  if (!bag.has(xk) && !bag.has(yk) && !bag.has(`${xk}_FRAC`) && !bag.has(`${yk}_FRAC`)) {
    // An absent coordinate is 0: only write it if it changes
    const q = mapPoint(x, { x: 0, y: 0 });
    if (q.x) setSchCoord(bag, xk, q.x);
    if (q.y) setSchCoord(bag, yk, q.y);
    return;
  }
  const q = mapPoint(x, { x: schCoord(bag, xk), y: schCoord(bag, yk) });
  setSchCoord(bag, xk, q.x);
  setSchCoord(bag, yk, q.y);
}

/** Corners of a box that can't turn (sheet symbol, text frame, image): move it by its centre. */
function boxByCentre(x: SchXform, w: number, h: number, a: Vec2): Vec2 {
  const c = mapPoint(x, { x: a.x + w / 2, y: a.y + h / 2 });
  return { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2) };
}

const PORT_ARROWS: Record<number, number[]> = { 0: [], 1: [2], 2: [0], 3: [0, 2], 4: [], 5: [1], 6: [3], 7: [1, 3] };

/** The bag after the transform (a new bag; the input is not changed). */
export function transformBag(src: PropertyBag, x: SchXform): PropertyBag {
  const bag = src.clone();
  const rec = bag.int('RECORD', -1);
  const turn = (key: string) => {
    if (!x.quarter && !x.mirrorX && !x.mirrorY) return;
    const o = bag.int(key);
    const n = mapDir(x, o);
    if (n !== o || bag.has(key)) { if (n) bag.set(key, String(n)); else bag.delete(key); }
  };
  switch (rec) {
    case SR.WIRE: case SR.BUS: case SR.POLYLINE: case SR.POLYGON: case SR.BEZIER: case SR.SIGNAL_HARNESS: {
      const n = bag.int('LOCATIONCOUNT');
      for (let i = 1; i <= n; i++) point(bag, `X${i}`, `Y${i}`, x);
      break;
    }
    case SR.LINE: case SR.BUS_ENTRY:
      point(bag, 'LOCATION.X', 'LOCATION.Y', x); point(bag, 'CORNER.X', 'CORNER.Y', x);
      break;
    case SR.RECTANGLE: case SR.ROUND_RECTANGLE: case SR.COMPILE_MASK: {
      const a = mapPoint(x, { x: schCoord(bag, 'LOCATION.X'), y: schCoord(bag, 'LOCATION.Y') });
      const b = mapPoint(x, { x: schCoord(bag, 'CORNER.X'), y: schCoord(bag, 'CORNER.Y') });
      setSchCoord(bag, 'LOCATION.X', Math.min(a.x, b.x)); setSchCoord(bag, 'LOCATION.Y', Math.min(a.y, b.y));
      setSchCoord(bag, 'CORNER.X', Math.max(a.x, b.x)); setSchCoord(bag, 'CORNER.Y', Math.max(a.y, b.y));
      if (rec === SR.ROUND_RECTANGLE && x.quarter % 2) {
        const rx = bag.getRaw('CORNERXRADIUS'), ry = bag.getRaw('CORNERYRADIUS');
        if (ry !== undefined) bag.setRaw('CORNERXRADIUS', ry); else bag.delete('CORNERXRADIUS');
        if (rx !== undefined) bag.setRaw('CORNERYRADIUS', rx); else bag.delete('CORNERYRADIUS');
      }
      break;
    }
    case SR.TEXT_FRAME: case SR.NOTE: case SR.IMAGE: {
      const a = { x: schCoord(bag, 'LOCATION.X'), y: schCoord(bag, 'LOCATION.Y') }, b = { x: schCoord(bag, 'CORNER.X'), y: schCoord(bag, 'CORNER.Y') };
      const lo = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      const n = boxByCentre(x, w, h, lo);
      setSchCoord(bag, 'LOCATION.X', n.x); setSchCoord(bag, 'LOCATION.Y', n.y);
      setSchCoord(bag, 'CORNER.X', n.x + w); setSchCoord(bag, 'CORNER.Y', n.y + h);
      break;
    }
    case SR.SHEET_SYMBOL: {
      // LOCATION is the top-left corner; the box hangs down from it
      const w = schCoord(bag, 'XSIZE'), h = schCoord(bag, 'YSIZE');
      const top = { x: schCoord(bag, 'LOCATION.X'), y: schCoord(bag, 'LOCATION.Y') };
      const n = boxByCentre(x, w, h, { x: top.x, y: top.y - h });
      setSchCoord(bag, 'LOCATION.X', n.x); setSchCoord(bag, 'LOCATION.Y', n.y + h);
      break;
    }
    case SR.ELLIPSE:
      point(bag, 'LOCATION.X', 'LOCATION.Y', x);
      if (x.quarter % 2) {
        const r = bag.getRaw('RADIUS'), r2 = bag.getRaw('SECONDARYRADIUS'), rf = bag.getRaw('RADIUS_FRAC'), r2f = bag.getRaw('SECONDARYRADIUS_FRAC');
        if (r2 !== undefined) { bag.setRaw('RADIUS', r2); if (r2f) bag.setRaw('RADIUS_FRAC', r2f); else bag.delete('RADIUS_FRAC'); }
        if (r !== undefined) { bag.setRaw('SECONDARYRADIUS', r); if (rf) bag.setRaw('SECONDARYRADIUS_FRAC', rf); else bag.delete('SECONDARYRADIUS_FRAC'); }
      }
      break;
    case SR.BLANKET: {
      const n = bag.int('LOCATIONCOUNT');
      for (let i = 1; i <= n; i++) point(bag, `X${i}`, `Y${i}`, x);
      const a = mapPoint(x, { x: schCoord(bag, 'LOCATION.X'), y: schCoord(bag, 'LOCATION.Y') });
      const b = mapPoint(x, { x: schCoord(bag, 'CORNER.X'), y: schCoord(bag, 'CORNER.Y') });
      setSchCoord(bag, 'LOCATION.X', Math.min(a.x, b.x)); setSchCoord(bag, 'LOCATION.Y', Math.min(a.y, b.y));
      setSchCoord(bag, 'CORNER.X', Math.max(a.x, b.x)); setSchCoord(bag, 'CORNER.Y', Math.max(a.y, b.y));
      break;
    }
    case SR.ARC: case SR.ELLIPTICAL_ARC: case SR.PIECHART: {
      point(bag, 'LOCATION.X', 'LOCATION.Y', x);
      const s = bag.float('STARTANGLE', 0), e = bag.float('ENDANGLE', 360);
      let ns = mapAngle(x, s), ne = mapAngle(x, e);
      if (flipsOrder(x)) [ns, ne] = [ne, ns];
      if (Math.abs(e - s) >= 360) { ns = 0; ne = 360; }
      bag.set('STARTANGLE', fmtAngle(ns)); bag.set('ENDANGLE', fmtAngle(ne));
      if (rec === SR.ELLIPTICAL_ARC && x.quarter % 2) {
        const r = bag.getRaw('RADIUS'), r2 = bag.getRaw('SECONDARYRADIUS');
        if (r2 !== undefined) bag.setRaw('RADIUS', r2);
        if (r !== undefined) bag.setRaw('SECONDARYRADIUS', r);
      }
      break;
    }
    case SR.PIN: {
      point(bag, 'LOCATION.X', 'LOCATION.Y', x);
      const pc = bag.int('PINCONGLOMERATE');
      const n = (pc & ~3) | mapDir(x, pc & 3);
      if (n !== pc) bag.set('PINCONGLOMERATE', String(n));
      break;
    }
    case SR.PORT: {
      // Ends of the port, transformed; LOCATION is the left (horizontal) or bottom (vertical) end
      const at = { x: schCoord(bag, 'LOCATION.X'), y: schCoord(bag, 'LOCATION.Y') };
      const style = bag.int('STYLE'), vertical = style >= 4, w = bag.int('WIDTH', 50) * SCH_UNIT;
      const far = vertical ? { x: at.x, y: at.y + w } : { x: at.x + w, y: at.y };
      const a = mapPoint(x, at), b = mapPoint(x, far);
      const nowVertical = a.x === b.x;
      const loc = nowVertical ? (a.y < b.y ? a : b) : (a.x < b.x ? a : b);
      setSchCoord(bag, 'LOCATION.X', loc.x); setSchCoord(bag, 'LOCATION.Y', loc.y);
      const arrows = (PORT_ARROWS[style] ?? []).map((d) => mapDir(x, d)).sort();
      const key = arrows.join(',');
      const ns = nowVertical
        ? (key === '' ? 4 : key === '1' ? 5 : key === '3' ? 6 : 7)
        : (key === '' ? 0 : key === '2' ? 1 : key === '0' ? 2 : 3);
      if (ns !== style) { if (ns) bag.set('STYLE', String(ns)); else bag.delete('STYLE'); }
      break;
    }
    case SR.POWER_PORT: case SR.LABEL: case SR.NET_LABEL: case SR.DESIGNATOR: case SR.PARAMETER:
    case SR.SHEET_NAME: case SR.FILE_NAME: case SR.PARAMETER_SET:
      point(bag, 'LOCATION.X', 'LOCATION.Y', x);
      turn('ORIENTATION');
      break;
    case SR.IEEE_SYMBOL: {
      // Turned like a part: ORIENTATION and ISMIRRORED describe R(o)·Mx^m
      point(bag, 'LOCATION.X', 'LOCATION.Y', x);
      let o = bag.int('ORIENTATION'), flips = 0;
      if (x.mirrorX) { o = -o; flips++; }
      if (x.mirrorY) { o = 2 - o; flips++; }
      o = (((o + x.quarter) % 4) + 4) % 4;
      if (flips % 2) { if (bag.bool('ISMIRRORED')) bag.delete('ISMIRRORED'); else bag.set('ISMIRRORED', 'T'); }
      if (o) bag.set('ORIENTATION', String(o)); else if (bag.has('ORIENTATION')) bag.delete('ORIENTATION');
      break;
    }
    case SR.COMPONENT: {
      point(bag, 'LOCATION.X', 'LOCATION.Y', x);
      // ORIENTATION and ISMIRRORED describe R(o)·Mx^m; mirroring X gives R(-o)·Mx^(m+1), mirroring Y R(2-o)·Mx^(m+1)
      let o = bag.int('ORIENTATION');
      let flips = 0;
      if (x.mirrorX) { o = -o; flips++; }
      if (x.mirrorY) { o = 2 - o; flips++; }
      o = (((o + x.quarter) % 4) + 4) % 4;
      if (flips % 2) { if (bag.bool('ISMIRRORED')) bag.delete('ISMIRRORED'); else bag.set('ISMIRRORED', 'T'); }
      if (o) bag.set('ORIENTATION', String(o)); else bag.delete('ORIENTATION');
      break;
    }
    case SR.NO_ERC:
      point(bag, 'LOCATION.X', 'LOCATION.Y', x);
      turn('ORIENTATION');
      break;
    case SR.JUNCTION: case SR.HARNESS_CONNECTOR:
      point(bag, 'LOCATION.X', 'LOCATION.Y', x);
      break;
    default:
      if (bag.has('LOCATION.X') || bag.has('LOCATION.Y')) point(bag, 'LOCATION.X', 'LOCATION.Y', x);
      break;
  }
  return bag;
}

/** Object indices plus everything they own (a component's pins, graphics and parameters). */
export function withChildren(doc: SchDocument, indices: Iterable<number>): number[] {
  const out = new Set<number>();
  const owned = ownedBy(doc);
  const visit = (i: number) => { if (out.has(i)) return; out.add(i); for (const o of owned.get(i) ?? []) visit(o.index); };
  for (const i of indices) visit(i);
  return [...out].sort((a, b) => a - b);
}

/** Where the reference point of an object is (component / port / text location, first wire vertex …). */
export function refPoint(doc: SchDocument, i: number): Vec2 | null {
  const o = doc.objects[i];
  if (!o) return null;
  if ('at' in o) return o.at;
  if ('pts' in o && o.pts.length) return o.pts[0]!;
  if ('a' in o) return o.a;
  if ('c' in o) return o.c;
  return null;
}
