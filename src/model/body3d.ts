/**
 * Placing a STEP model's body (Tools › 3D Body Placement): its snap points (MODEL.SNAPCOUNT and
 * MODEL.SNAPnX / Y / Z in the model's own axes [est: the keys past SNAPCOUNT]), its rotation as
 * MODEL.3D.ROTX / ROTY / ROTZ (about X, then Y, then Z), the lift MODEL.3D.DZ, its place
 * MODEL.2D.X / Y; after any of these the body's 2D outline (the model seen from above), standoff
 * and overall height are worked out again from the model, as AD does when a model is placed.
 */
import { formatAltiumLength, parseLength, UNITS_PER_MM } from '../core/units';
import type { Vec2 } from '../core/geom';
import type { Change } from '../core/undo';
import { PropertyBag } from '../formats/altium/props';
import { REGION } from '../formats/altium/pcbLayouts';
import { editRegionProps } from '../formats/altium/pcbTransform';
import type { StepModel, V3 } from '../formats/step/tessellate';
import { replaceRecords } from './pcbEdit';
import type { PcbBody, PcbDocument } from './pcb';

export type M3 = [V3, V3, V3]; // columns: images of x, y, z
const rad = (d: number) => (d * Math.PI) / 180, deg = (r: number) => (r * 180) / Math.PI;
const mulMV = (m: M3, v: V3): V3 => [m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2], m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2], m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2]];
const mulMM = (a: M3, b: M3): M3 => [mulMV(a, b[0]), mulMV(a, b[1]), mulMV(a, b[2])];

/** Rz(c)·Ry(b)·Rx(a): AD's turn about X, then Y, then Z (degrees). */
export function rotationOf(rx: number, ry: number, rz: number): M3 {
  const [a, b, c] = [rad(rx), rad(ry), rad(rz)];
  const X: M3 = [[1, 0, 0], [0, Math.cos(a), Math.sin(a)], [0, -Math.sin(a), Math.cos(a)]];
  const Y: M3 = [[Math.cos(b), 0, -Math.sin(b)], [0, 1, 0], [Math.sin(b), 0, Math.cos(b)]];
  const Z: M3 = [[Math.cos(c), Math.sin(c), 0], [-Math.sin(c), Math.cos(c), 0], [0, 0, 1]];
  return mulMM(Z, mulMM(Y, X));
}
/** The X, Y, Z angles (degrees, 0–360) of a rotation. */
export function anglesOf(m: M3): V3 {
  const r20 = m[0][2], r21 = m[1][2], r22 = m[2][2], r10 = m[0][1], r00 = m[0][0];
  const b = Math.asin(Math.max(-1, Math.min(1, -r20)));
  let a: number, c: number;
  if (Math.abs(Math.cos(b)) > 1e-9) { a = Math.atan2(r21, r22); c = Math.atan2(r10, r00); }
  else { a = Math.atan2(-m[2][1], m[1][1]); c = 0; } // gimbal lock: the X turn takes it all
  const n = (v: number) => { const d = Math.round(deg(v) * 1000) / 1000; return ((d % 360) + 360) % 360; };
  return [n(a), n(b), n(c)];
}
/** The rotation taking unit vector u onto unit vector v. */
export function rotationBetween(u: V3, v: V3): M3 {
  const c = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  if (c > 1 - 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let k: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  let s = Math.hypot(...k);
  if (s < 1e-12) { // opposite: half a turn about any axis square to u
    k = Math.abs(u[0]) < 0.9 ? [0, -u[2], u[1]] : [-u[2], 0, u[0]];
    s = Math.hypot(...k);
    k = [k[0] / s, k[1] / s, k[2] / s];
    return axisAngle(k, Math.PI);
  }
  k = [k[0] / s, k[1] / s, k[2] / s];
  return axisAngle(k, Math.atan2(s, c));
}
function axisAngle(k: V3, t: number): M3 {
  const c = Math.cos(t), s = Math.sin(t), C = 1 - c;
  const [x, y, z] = k;
  // Columns
  return [[c + x * x * C, y * x * C + z * s, z * x * C - y * s], [x * y * C - z * s, c + y * y * C, z * y * C + x * s], [x * z * C + y * s, y * z * C - x * s, c + z * z * C]];
}

/** A body's properties. */
export function bodyBag(doc: PcbDocument, b: PcbBody): PropertyBag | null {
  const s = doc.streams.get(b.src.storage)?.records[b.src.index]?.subs[0];
  if (!s) return null;
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  const len = dv.getUint32(REGION.propsAt, true) & 0x00ffffff;
  return PropertyBag.parse(s.subarray(REGION.propsAt + 4, REGION.propsAt + 4 + len));
}

const lenMm = (v: string | undefined) => (parseLength(v ?? '') ?? 0) / UNITS_PER_MM;
const fmtMm = (mm: number) => formatAltiumLength(Math.round(mm * UNITS_PER_MM));

/** Snap points in the model's own axes (millimetres). */
export function snapPoints(bag: PropertyBag): V3[] {
  const n = bag.int('MODEL.SNAPCOUNT', 0);
  return Array.from({ length: n }, (_, i) => [lenMm(bag.getRaw(`MODEL.SNAP${i}X`)), lenMm(bag.getRaw(`MODEL.SNAP${i}Y`)), lenMm(bag.getRaw(`MODEL.SNAP${i}Z`))] as V3);
}
export function setSnapPoints(bag: PropertyBag, pts: V3[]): void {
  const old = bag.int('MODEL.SNAPCOUNT', 0);
  for (let i = 0; i < old; i++) for (const a of 'XYZ') bag.delete(`MODEL.SNAP${i}${a}`);
  bag.set('MODEL.SNAPCOUNT', String(pts.length));
  pts.forEach((p, i) => { bag.set(`MODEL.SNAP${i}X`, fmtMm(p[0])); bag.set(`MODEL.SNAP${i}Y`, fmtMm(p[1])); bag.set(`MODEL.SNAP${i}Z`, fmtMm(p[2])); });
}

export interface Placement { rot: V3; dz: number; at: Vec2; bottom: boolean }
export const placementOf = (bag: PropertyBag): Placement => ({
  rot: [bag.float('MODEL.3D.ROTX'), bag.float('MODEL.3D.ROTY'), bag.float('MODEL.3D.ROTZ')],
  dz: lenMm(bag.getRaw('MODEL.3D.DZ')), bottom: bag.int('BODYPROJECTION') === 1,
  at: { x: parseLength(bag.getRaw('MODEL.2D.X') ?? '') ?? 0, y: parseLength(bag.getRaw('MODEL.2D.Y') ?? '') ?? 0 },
});

/**
 * A model point (mm, its own axes) on the board: x, y board units, z mm above the surface on the
 * body's side (as the 3D view places it: underneath, turned over about the board's X axis).
 */
export function placePoint(pl: Placement, p: V3): { x: number; y: number; z: number } {
  const q = mulMV(rotationOf(...pl.rot), p);
  const y = pl.bottom ? -q[1] : q[1];
  return { x: pl.at.x + q[0] * UNITS_PER_MM, y: pl.at.y + y * UNITS_PER_MM, z: q[2] + pl.dz };
}

/** The convex hull of points (board units), counter-clockwise. */
export function hull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Vec2[] = [], up: Vec2[] = [];
  for (const v of p) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, v) <= 0) lo.pop(); lo.push(v); }
  for (const v of [...p].reverse()) { while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, v) <= 0) up.pop(); up.push(v); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

/** The model's vertices placed: the outline seen from above and the height span (mm). */
export function footprintOf(pl: Placement, m: StepModel): { outline: Vec2[]; zMin: number; zMax: number } {
  const pts: Vec2[] = [];
  let zMin = Infinity, zMax = -Infinity;
  for (const s of m.meshes) for (let i = 0; i < s.pos.length; i += 3) {
    const q = placePoint(pl, [s.pos[i]!, s.pos[i + 1]!, s.pos[i + 2]!]);
    pts.push({ x: Math.round(q.x), y: Math.round(q.y) });
    zMin = Math.min(zMin, q.z); zMax = Math.max(zMax, q.z);
  }
  return { outline: hull(pts), zMin, zMax };
}

/** The body record with new properties and (optionally) a new outline. */
export function editBodyRecord(doc: PcbDocument, b: PcbBody, edit: (bag: PropertyBag) => void, outline?: Vec2[]): Change | null {
  const rec = doc.streams.get(b.src.storage)?.records[b.src.index];
  if (!rec) return null;
  const subs: Uint8Array[] = rec.subs.map((x) => x.slice());
  let s: Uint8Array = editRegionProps(subs[0]!, (bag) => { edit(bag); bag.set('MODEL.CHECKSUM', bag.get('MODEL.CHECKSUM') ?? '0'); });
  if (outline && outline.length >= 3) {
    const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    const at = REGION.propsAt + 4 + (dv.getUint32(REGION.propsAt, true) & 0x00ffffff);
    const out = new Uint8Array(at + 4 + outline.length * 16);
    out.set(s.subarray(0, at));
    const w = new DataView(out.buffer);
    w.setUint32(at, outline.length, true);
    outline.forEach((p, i) => { w.setFloat64(at + 4 + i * 16, p.x, true); w.setFloat64(at + 12 + i * 16, p.y, true); });
    s = out;
  }
  subs[0] = s;
  return replaceRecords(doc, [{ storage: b.src.storage, index: b.src.index, after: { tag: rec.tag, subs } }]);
}

/** New placement written, with the outline, standoff and overall height worked out from the model. */
export function placeBody(doc: PcbDocument, b: PcbBody, m: StepModel, pl: Placement, extra?: (bag: PropertyBag) => void): Change | null {
  const f = footprintOf(pl, m);
  return editBodyRecord(doc, b, (bag) => {
    bag.set('MODEL.3D.ROTX', pl.rot[0].toFixed(3)); bag.set('MODEL.3D.ROTY', pl.rot[1].toFixed(3)); bag.set('MODEL.3D.ROTZ', pl.rot[2].toFixed(3));
    bag.set('MODEL.3D.DZ', fmtMm(pl.dz));
    bag.set('MODEL.2D.X', formatAltiumLength(Math.round(pl.at.x))); bag.set('MODEL.2D.Y', formatAltiumLength(Math.round(pl.at.y)));
    bag.set('STANDOFFHEIGHT', fmtMm(Math.max(0, f.zMin))); bag.set('OVERALLHEIGHT', fmtMm(Math.max(0, f.zMax)));
    extra?.(bag);
  }, f.outline);
}

/** A rotation applied after the body's own (both in the board's frame before turning over). */
export function turned(pl: Placement, r: M3): Placement { return { ...pl, rot: anglesOf(mulMM(r, rotationOf(...pl.rot))) }; }
