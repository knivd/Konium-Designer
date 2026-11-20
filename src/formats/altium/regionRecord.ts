/**
 * A Regions6 / ShapeBasedRegions6 subrecord taken apart and put back byte for byte: the fixed
 * header, the property block (its length's high byte kept), the vertices as stored (f64 pairs,
 * or AD's shape vertices with their arcs and the closing vertex), the holes, anything after.
 */
import { BinReader, BinWriter } from '../bin';
import { PropertyBag } from './props';
import { REGION } from './pcbLayouts';
import type { Vec2 } from '../../core/geom';

export interface RegionVertex {
  x: number; y: number;
  /** A rounded vertex: the arc to the next. */
  arc?: { cx: number; cy: number; r: number; a1: number; a2: number };
  /** A shape vertex that is not rounded still stores arc fields (often not zero): kept as they are. */
  rest?: { cx: number; cy: number; r: number; a1: number; a2: number };
}
export interface RegionParts {
  shapeBased: boolean; head: Uint8Array; props: PropertyBag; propHigh: number;
  /** The outline as stored; a shape-based region's closing vertex is not in it (it is written back as the first). */
  verts: RegionVertex[]; holes: Vec2[][]; tail: Uint8Array;
  /** A shape-based region's closing vertex as stored (its arc fields need not be the first's). */
  closing?: RegionVertex;
}

export function readRegionParts(storage: string, s: Uint8Array): RegionParts {
  const shapeBased = storage === 'ShapeBasedRegions6';
  const r = new BinReader(s, REGION.propsAt);
  const raw = r.u32();
  const props = PropertyBag.parse(r.bytes(raw & 0x00ffffff));
  const count = r.u32();
  const verts: RegionVertex[] = [];
  for (let i = 0; i < count + (shapeBased ? 1 : 0); i++) {
    if (shapeBased) {
      const round = r.u8() !== 0;
      const x = r.i32(), y = r.i32(), cx = r.i32(), cy = r.i32(), rad = r.i32(), a1 = r.f64(), a2 = r.f64();
      verts.push(round ? { x, y, arc: { cx, cy, r: rad, a1, a2 } } : { x, y, rest: { cx, cy, r: rad, a1, a2 } });
    } else verts.push({ x: r.f64(), y: r.f64() });
  }
  const closing = shapeBased ? verts.pop() : undefined;
  const holes: Vec2[][] = [];
  const nh = s[REGION.holeCount.off]! | (s[REGION.holeCount.off + 1]! << 8);
  for (let h = 0; h < nh; h++) {
    const m = r.u32();
    const hole: Vec2[] = [];
    for (let i = 0; i < m; i++) hole.push({ x: r.f64(), y: r.f64() });
    holes.push(hole);
  }
  return { shapeBased, head: s.slice(0, REGION.propsAt), props, propHigh: raw & 0xff000000, verts, holes, tail: s.slice(r.pos), closing };
}

export function writeRegionParts(p: RegionParts): Uint8Array {
  const w = new BinWriter(256 + p.verts.length * 40);
  const head = p.head.slice();
  head[REGION.holeCount.off] = p.holes.length & 0xff; head[REGION.holeCount.off + 1] = (p.holes.length >> 8) & 0xff;
  w.bytes(head);
  const props = p.props.toBytes();
  w.u32((props.length | p.propHigh) >>> 0).bytes(props);
  w.u32(p.verts.length);
  // The closing vertex where the first now is, the rest of it as stored
  const verts = p.shapeBased ? [...p.verts, p.closing ? { ...p.closing, x: p.verts[0]!.x, y: p.verts[0]!.y } : p.verts[0]!] : p.verts;
  for (const v of verts) {
    if (p.shapeBased) { const a = v.arc ?? v.rest; w.u8(v.arc ? 1 : 0).i32(Math.round(v.x)).i32(Math.round(v.y)).i32(a?.cx ?? 0).i32(a?.cy ?? 0).i32(a?.r ?? 0).f64(a?.a1 ?? 0).f64(a?.a2 ?? 0); }
    else w.f64(v.x).f64(v.y);
  }
  for (const h of p.holes) { w.u32(h.length); for (const q of h) w.f64(q.x).f64(q.y); }
  w.bytes(p.tail);
  return w.finish();
}
