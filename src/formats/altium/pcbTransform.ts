/**
 * Moving, rotating, mirroring and flipping primitive records in place (component placement,
 * Move Component, X / Y / L while moving). Only position, angle and layer fields change;
 * every other byte stays as written.
 */
import { PCB_TAG, type PcbRawRecord } from './framing';
import { ARC, FILL, PAD, REGION, TEXT, TRACK, VIA, get, put, type Field } from './pcbLayouts';
import { PropertyBag } from './props';
import { formatAltiumLength, parseLength } from '../../core/units';
import { L, mechLayer, mechNumber, type LayerId } from '../../model/layers';
import type { Vec2 } from '../../core/geom';

export type PointMap = (p: Vec2) => Vec2;

/**
 * What else a transform does besides moving points: `mirror` — the point map reflects
 * (x → −x before the rotation), so angles reflect too; `flip` — objects change side (Top ↔
 * Bottom layers, as L does). `storage` tells Regions6 from ShapeBasedRegions6 vertices.
 */
export interface XformOpts { mirror?: boolean; flip?: boolean; storage?: string; /** The board's component layer pairs: flipped, objects on one go to the other. */ pairs?: [LayerId, LayerId][] }

/** A mechanical layer's partner in a component layer pair, or none. */
function partner(l: LayerId, pairs?: [LayerId, LayerId][]): LayerId | null {
  for (const [a, b] of pairs ?? []) { if (l === a) return b; if (l === b) return a; }
  return null;
}
/** Flipped: a primitive on a paired mechanical layer onto its partner (the byte, and the V7 id where it has one: Mechanical 17–32). */
function swapMech(s: Uint8Array, f6: Field, f7: Field | null, pairs?: [LayerId, LayerId][]): void {
  if (!pairs?.length) return;
  const v7 = f7 && s.length >= f7.off + 4 ? get(s, f7) : undefined;
  const b = get(s, f6);
  const cur = v7 !== undefined && v7 > 0x01020000 && v7 <= 0x01020020 ? mechLayer(v7 - 0x01020000) : b !== undefined && b >= L.MECH1 && b <= L.MECH16 ? b : null;
  const to = cur === null ? null : partner(cur, pairs);
  if (to === null) return;
  put(s, f6, mechNumber(to) <= 16 ? to : L.MECH16);
  if (v7) put(s, f7!, 0x01020000 + mechNumber(to));
}

const norm = (a: number) => ((a % 360) + 360) % 360;

/** The layer on the other side of the board (Top ↔ Bottom, overlay, paste and mask pairs). */
export function otherSide(l: LayerId): LayerId {
  const pairs: [LayerId, LayerId][] = [[L.TOP, L.BOTTOM], [L.TOP_OVERLAY, L.BOTTOM_OVERLAY], [L.TOP_PASTE, L.BOTTOM_PASTE], [L.TOP_SOLDER, L.BOTTOM_SOLDER]];
  for (const [a, b] of pairs) { if (l === a) return b; if (l === b) return a; }
  return l;
}

function movePt(s: Uint8Array, fx: Field, fy: Field, map: PointMap): void {
  const x = get(s, fx), y = get(s, fy);
  if (x === undefined || y === undefined) return;
  const q = map({ x, y });
  put(s, fx, Math.round(q.x)); put(s, fy, Math.round(q.y));
}
/** A direction angle: reflected (180 − a) when mirrored, then turned. */
function turn(s: Uint8Array, f: Field, rot: number, mirror = false): void {
  const a = get(s, f);
  if (a === undefined) return;
  if (mirror) put(s, f, norm(rot + 180 - a));
  else if (rot) put(s, f, norm(a + rot));
}
/** A centrally symmetric shape's rotation (pads, fills): reflected as −r. */
function turnSym(s: Uint8Array, f: Field, rot: number, mirror = false): void {
  const a = get(s, f);
  if (a === undefined) return;
  if (mirror) put(s, f, norm(rot - a));
  else if (rot) put(s, f, norm(a + rot));
}
function swapLayer(s: Uint8Array, f: Field): void {
  const l = get(s, f);
  if (l !== undefined) put(s, f, otherSide(l));
}

/** Region and component-body vertices: f64 pairs after the property block (then holes). */
function mapVertices(s: Uint8Array, map: PointMap, shapeBased: boolean): void {
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  let o = REGION.propsAt;
  const propLen = dv.getUint32(o, true) & 0x00ffffff;
  o += 4 + propLen;
  const count = dv.getUint32(o, true); o += 4;
  if (shapeBased) {
    // (u8 round, i32 x, i32 y, i32 cx, i32 cy, i32 r, f64 a1, f64 a2) × (count + 1); arcs are left unturned
    for (let i = 0; i <= count && o + 37 <= s.length; i++, o += 37) {
      const p = map({ x: dv.getInt32(o + 1, true), y: dv.getInt32(o + 5, true) });
      dv.setInt32(o + 1, Math.round(p.x), true); dv.setInt32(o + 5, Math.round(p.y), true);
      const c = map({ x: dv.getInt32(o + 9, true), y: dv.getInt32(o + 13, true) });
      dv.setInt32(o + 9, Math.round(c.x), true); dv.setInt32(o + 13, Math.round(c.y), true);
    }
    return;
  }
  const run = (n: number) => {
    for (let i = 0; i < n && o + 16 <= s.length; i++, o += 16) {
      const q = map({ x: dv.getFloat64(o, true), y: dv.getFloat64(o + 8, true) });
      dv.setFloat64(o, q.x, true); dv.setFloat64(o + 8, q.y, true);
    }
  };
  run(count);
  const holes = get(s, REGION.holeCount) ?? 0;
  for (let h = 0; h < holes && o + 4 <= s.length; h++) { const m = dv.getUint32(o, true); o += 4; run(m); }
}

/** Rewrite the property block of a region-like subrecord (its length changes, the rest is kept). */
export function editRegionProps(s: Uint8Array, edit: (b: PropertyBag) => void): Uint8Array {
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const raw = dv.getUint32(REGION.propsAt, true);
  const len = raw & 0x00ffffff, flags = raw & 0xff000000;
  const start = REGION.propsAt + 4;
  const bag = PropertyBag.parse(s.slice(start, start + len));
  edit(bag);
  if (!bag.modified) return s;
  const props = bag.toBytes();
  const out = new Uint8Array(s.length - len + props.length);
  out.set(s.subarray(0, REGION.propsAt));
  new DataView(out.buffer).setUint32(REGION.propsAt, (flags | props.length) >>> 0, true);
  out.set(props, start);
  out.set(s.subarray(start + len), start + props.length);
  return out;
}

const V7_NAMES: Record<number, string> = { [L.TOP]: 'TOP', [L.BOTTOM]: 'BOTTOM', [L.TOP_OVERLAY]: 'TOPOVERLAY', [L.BOTTOM_OVERLAY]: 'BOTTOMOVERLAY',
  [L.TOP_PASTE]: 'TOPPASTE', [L.BOTTOM_PASTE]: 'BOTTOMPASTE', [L.TOP_SOLDER]: 'TOPSOLDER', [L.BOTTOM_SOLDER]: 'BOTTOMSOLDER' };
const V7_IDS = Object.fromEntries(Object.entries(V7_NAMES).map(([k, v]) => [v, Number(k)])) as Record<string, number>;

/** A copy of the record with its points mapped and its angles (and, flipped, its layers) changed. */
export function transformRecord(rec: PcbRawRecord, map: PointMap, rot = 0, o: XformOpts = {}): PcbRawRecord {
  const subs: Uint8Array[] = rec.subs.map((x) => x.slice());
  let s: Uint8Array = subs[0]!;
  const m = !!o.mirror;
  switch (rec.tag) {
    case PCB_TAG.TRACK:
      movePt(s, TRACK.x1, TRACK.y1, map); movePt(s, TRACK.x2, TRACK.y2, map);
      if (o.flip) {
        swapLayer(s, TRACK.layer);
        const v7 = get(s, TRACK.layerV7), l = get(s, TRACK.layer);
        if (v7 && l !== undefined) put(s, TRACK.layerV7, v7FromV6(l, v7));
      }
      break;
    case PCB_TAG.ARC: {
      movePt(s, ARC.cx, ARC.cy, map);
      if (m) {
        const a = get(s, ARC.start), b = get(s, ARC.end);
        if (a !== undefined && b !== undefined) { put(s, ARC.start, norm(rot + 180 - b)); put(s, ARC.end, norm(rot + 180 - a)); }
      } else { turn(s, ARC.start, rot); turn(s, ARC.end, rot); }
      if (o.flip) { swapLayer(s, ARC.layer); syncV7(s, ARC.layer, ARC.layerV7); }
      break;
    }
    case PCB_TAG.VIA: movePt(s, VIA.x, VIA.y, map); break;
    case PCB_TAG.FILL: {
      // Corners are the unrotated rectangle; the rotation turns it about its centre
      const x1 = get(s, FILL.x1)!, y1 = get(s, FILL.y1)!, x2 = get(s, FILL.x2)!, y2 = get(s, FILL.y2)!;
      const c = map({ x: (x1 + x2) / 2, y: (y1 + y2) / 2 });
      const hw = (x2 - x1) / 2, hh = (y2 - y1) / 2;
      put(s, FILL.x1, Math.round(c.x - hw)); put(s, FILL.y1, Math.round(c.y - hh)); put(s, FILL.x2, Math.round(c.x + hw)); put(s, FILL.y2, Math.round(c.y + hh));
      turnSym(s, FILL.rotation, rot, m);
      if (o.flip) { swapLayer(s, FILL.layer); syncV7(s, FILL.layer, FILL.layerV7); }
      break;
    }
    case PCB_TAG.TEXT:
      movePt(s, TEXT.x, TEXT.y, map);
      // Reflected text reads backwards: the mirrored flag toggles and the angle reflects as −r
      if (m) { const mir = get(s, TEXT.mirrored); if (mir !== undefined) put(s, TEXT.mirrored, mir ? 0 : 1); }
      turnSym(s, TEXT.rotation, rot, m);
      if (o.flip) {
        swapLayer(s, TEXT.layer);
        // AD17's longer texts carry the layer again (V7): it goes with the byte
        if (s.length >= TEXT.barcodeLen) { const v7 = get(s, TEXT.layerV7), l = get(s, TEXT.layer); if (v7 && l !== undefined) put(s, TEXT.layerV7, v7FromV6(l, v7)); }
      }
      break;
    case PCB_TAG.REGION:
    case PCB_TAG.MODEL: {
      mapVertices(s, map, o.storage === 'ShapeBasedRegions6');
      if (rec.tag === PCB_TAG.MODEL) s = editBody(s, map, rot, o);
      else if (o.flip) {
        swapLayer(s, REGION.layer);
        s = editRegionProps(s, (b) => { const n = b.get('V7_LAYER')?.toUpperCase(); const l = n !== undefined ? V7_IDS[n] : undefined; if (l !== undefined) b.set('V7_LAYER', V7_NAMES[otherSide(l)]!); });
      }
      subs[0] = s;
      break;
    }
    case PCB_TAG.PAD: {
      const p = subs[4];
      if (!p) break;
      movePt(p, PAD.x, PAD.y, map);
      turnSym(p, PAD.rotation, rot, m);
      if (o.flip) {
        swapLayer(p, PAD.layer);
        syncV7(p, PAD.layer, PAD.layerV7);
        // A through-hole pad's top and bottom stack swap over
        const tx = get(p, PAD.topX), ty = get(p, PAD.topY), ts = get(p, PAD.topShape);
        const bx = get(p, PAD.botX), by = get(p, PAD.botY), bs = get(p, PAD.botShape);
        if (tx !== undefined && bx !== undefined) {
          put(p, PAD.topX, bx); put(p, PAD.topY, by!); put(p, PAD.topShape, bs!);
          put(p, PAD.botX, tx); put(p, PAD.botY, ty!); put(p, PAD.botShape, ts!);
        }
      }
      break;
    }
  }
  // Paired mechanical layers swap too (the fixed pairs are done above)
  if (o.flip && o.pairs?.length) {
    const t = subs[0]!;
    if (rec.tag === PCB_TAG.TRACK) swapMech(t, TRACK.layer, TRACK.layerV7, o.pairs);
    else if (rec.tag === PCB_TAG.ARC) swapMech(t, ARC.layer, ARC.layerV7, o.pairs);
    else if (rec.tag === PCB_TAG.FILL) swapMech(t, FILL.layer, FILL.layerV7, o.pairs);
    else if (rec.tag === PCB_TAG.TEXT) swapMech(t, TEXT.layer, t.length >= TEXT.barcodeLen ? TEXT.layerV7 : null, o.pairs);
    else if (rec.tag === PCB_TAG.REGION || rec.tag === PCB_TAG.MODEL) {
      // (a 3D body too: its layer and V7_LAYER as a region's)
      const b = get(t, REGION.layer);
      if (b !== undefined && b >= L.MECH1 && b <= L.MECH16) {
        // (Mechanical 17–32: the byte says 16, the properties' V7_LAYER which)
        let to: LayerId | null = null;
        const next = editRegionProps(t, (pb) => {
          const m = /^MECHANICAL(\d+)$/i.exec(pb.get('V7_LAYER') ?? '');
          to = partner(m ? mechLayer(Number(m[1])) : b, o.pairs);
          if (to !== null && m) pb.set('V7_LAYER', `MECHANICAL${mechNumber(to)}`);
        });
        if (to !== null) { put(next, REGION.layer, mechNumber(to) <= 16 ? to : L.MECH16); subs[0] = next; }
      }
    }
  }
  return { ...rec, subs };
}

/** After a flip: the V7 layer (which AD17 reads first) follows the byte, where the record has one. */
function syncV7(s: Uint8Array, v6: Field, v7f: Field): void {
  const v7 = get(s, v7f), l = get(s, v6);
  if (v7 && l !== undefined) put(s, v7f, v7FromV6(l, v7));
}

function v7FromV6(l: number, old: number): number {
  if (l === L.TOP) return 0x01000001;
  if (l === L.BOTTOM) return 0x0100ffff;
  const v8: Record<number, number> = { [L.TOP_OVERLAY]: 6, [L.BOTTOM_OVERLAY]: 7, [L.TOP_PASTE]: 8, [L.BOTTOM_PASTE]: 9, [L.TOP_SOLDER]: 10, [L.BOTTOM_SOLDER]: 11 };
  return v8[l] !== undefined ? 0x01030000 + v8[l]! : old;
}

/** Component body (3D model): its outline moved, its 2D placement and side updated. */
function editBody(s: Uint8Array, map: PointMap, rot: number, o: XformOpts): Uint8Array {
  return editRegionProps(s, (b) => {
    const x = parseLength(b.getRaw('MODEL.2D.X')), y = parseLength(b.getRaw('MODEL.2D.Y'));
    if (x !== undefined && y !== undefined) {
      const q = map({ x, y });
      b.set('MODEL.2D.X', formatAltiumLength(Math.round(q.x)));
      b.set('MODEL.2D.Y', formatAltiumLength(Math.round(q.y)));
    }
    // The model turns about the board's Z by ROTZ (outermost of Z·Y·X). Underneath, the body is
    // turned over about X, so a turn of the board turns it the other way; turning a part over
    // to the other side (half a turn about Y) is half a turn more about Z with the side swapped.
    // AD leaves MODEL.2D.ROTATION at 0 and ROTX/ROTY as they were.
    let rz = b.float('MODEL.3D.ROTZ'), bottom = b.int('BODYPROJECTION') === 1;
    if (o.flip) { rz += 180; bottom = !bottom; b.set('BODYPROJECTION', bottom ? '1' : '0'); }
    else if (o.mirror) rz = 180 - rz; // a reflection: the nearest the angles can say
    if (rot) rz += bottom ? -rot : rot;
    if (o.flip || o.mirror || rot) b.set('MODEL.3D.ROTZ', norm(rz).toFixed(3));
  });
}

/**
 * Rotate about c by deg (counter-clockwise, Altium's sense), then move by d. Mirrored, the point
 * is first reflected across the vertical line through c (Altium's X while moving).
 */
export function placement(c: Vec2, deg: number, d: Vec2, mirror = false): PointMap {
  const r = (deg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const snapTrig = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v);
  const C = snapTrig(cos), S = snapTrig(sin);
  const k = mirror ? -1 : 1;
  return (p) => {
    const x = (p.x - c.x) * k, y = p.y - c.y;
    return { x: c.x + x * C - y * S + d.x, y: c.y + x * S + y * C + d.y };
  };
}

/** Altium's float text, e.g. " 9.00000000000000E+0001". */
export function altiumFloat(v: number): string {
  const [m, e] = Math.abs(v).toExponential(14).split('e') as [string, string];
  const exp = Number(e);
  return `${v < 0 ? '-' : ' '}${m}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(4, '0')}`;
}
