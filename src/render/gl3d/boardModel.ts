/**
 * 3D Layout Mode's model of a board: the board body (outline and cut-outs, extruded to the
 * layer stack's thickness), plated hole barrels and the components' 3D bodies (Altium's
 * ComponentBodies6: an outline extruded from its standoff to its overall height, on the side
 * the body projects to). Coordinates are millimetres from the board's centre, z up from the
 * bottom of the board. The board's two faces are textured with the copper, mask and silk
 * painted by boardTexture.ts.
 */
import { triangulate, triangulateWithHoles, type BBox, type Vec2 } from '../../core/geom';
import { UNITS_PER_MM, parseLength } from '../../core/units';
import { PropertyBag } from '../../formats/altium/props';
import { REGION } from '../../formats/altium/pcbLayouts';
import { bodyComponent } from '../../model/pcbEdit';
import { L } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';
import { stepBodyFrom, type StepBody } from './stepBodies';
import { boardRegions, foldOf, stackRange, stripCuts, type Fold } from '../../model/rigidFlex';
import { readStack } from '../../model/pcbStack';
import { pointInPoly } from '../../core/geom';
import { clipPieces } from '../../model/outlineOps';
import { wireLinkMeshes } from './wireMesh';

export type RGBA = [number, number, number, number];
export interface Mesh {
  pos: Float32Array; nrm: Float32Array; uv: Float32Array | null; idx: Uint32Array;
  colour: RGBA;
  /** Board faces sample the painted side. */
  texture?: 'top' | 'bottom' | 'single';
  /** Rigid-flex: the board region each vertex (or the whole mesh) belongs to, for folding. */
  region?: Int32Array | number;
}
export interface Body3D {
  component: number; outline: Vec2[]; z0: number; z1: number; colour: RGBA;
  /** An embedded STEP model shown in its place once read (the extrusion stands in till then). */
  step?: StepBody;
  /** Its record in ComponentBodies6. */
  record?: number;
}
export interface BoardModel {
  /** World point at the model's origin, and the board's extent in world units (the textures' area). */
  centre: Vec2; rect: BBox;
  /** Millimetres. */
  thickness: number;
  meshes: Mesh[];
  bodies: Body3D[];
  /** Wire links (Place › Wire Link): their wires and solder, shown with the bodies. */
  wires?: Mesh[];
  /** Rigid-flex: how the board folds about its bending lines (model space), when it has any. */
  fold?: Fold | null;
}

export const COLOURS = {
  core: [0.78, 0.72, 0.52, 1] as RGBA,
  barrel: [0.83, 0.66, 0.3, 1] as RGBA,
  body: [0.25, 0.25, 0.27, 1] as RGBA,
};

/** Board thickness from the layer stack: copper plus dielectrics (solder resist left out), 1.6 mm if the file has none. */
export function boardThickness(doc: PcbDocument): number {
  const b = doc.board.bag;
  if (!b) return 1.6;
  let t = 0, found = false;
  for (const k of b.keys()) {
    const m = /^V9_STACK_LAYER(\d+)_(COPTHICK|DIELHEIGHT)$/i.exec(k);
    if (!m) continue;
    if (m[2]!.toUpperCase() === 'DIELHEIGHT' && b.int(`V9_STACK_LAYER${m[1]}_DIELTYPE`) === 3) continue;
    const v = parseLength(b.getRaw(k));
    if (v !== undefined) { t += v; found = true; }
  }
  if (!found) {
    for (const k of b.keys()) {
      const m = /^LAYER(\d+)(COPTHICK|DIELHEIGHT)$/i.exec(k);
      if (!m || !doc.board.copperStack.length) continue;
      const v = parseLength(b.getRaw(k));
      if (v !== undefined && v > 0) { t += v; found = true; }
    }
  }
  const mm = t / UNITS_PER_MM;
  return found && mm > 0.1 && mm < 20 ? mm : 1.6;
}

/** Windows COLORREF (0x00BBGGRR) → linear-ish RGB. */
export function colorRef(v: number, a = 1): RGBA {
  return [(v & 0xff) / 255, ((v >> 8) & 0xff) / 255, ((v >> 16) & 0xff) / 255, a];
}

/** The ComponentBodies6 records as extrusions (heights in mm above or below the board). */
export function componentBodies(doc: PcbDocument, thickness: number): Body3D[] {
  const out: Body3D[] = [];
  for (const [record, rec] of (doc.streams.get('ComponentBodies6')?.records ?? []).entries()) {
    const s = rec.subs[0];
    if (!s || s.length < REGION.propsAt + 8) continue;
    try {
      const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
      const len = dv.getUint32(REGION.propsAt, true) & 0x00ffffff;
      const props = PropertyBag.parse(s.subarray(REGION.propsAt + 4, REGION.propsAt + 4 + len));
      let o = REGION.propsAt + 4 + len;
      const n = dv.getUint32(o, true); o += 4;
      const outline: Vec2[] = [];
      for (let i = 0; i < n && o + 16 <= s.length; i++, o += 16) outline.push({ x: dv.getFloat64(o, true), y: dv.getFloat64(o + 8, true) });
      if (outline.length > 2) { const a = outline[0]!, b = outline.at(-1)!; if (a.x === b.x && a.y === b.y) outline.pop(); }
      if (outline.length < 3) continue;
      const step = props.int('MODEL.MODELTYPE') === 1 ? stepBodyFrom(props, rec, outline) ?? undefined : undefined;
      // A STEP model's heights take in its leads through the board: its stand-in box starts at the surface
      let standoff = (parseLength(props.getRaw('STANDOFFHEIGHT')) ?? 0) / UNITS_PER_MM;
      if (step) standoff = Math.max(0, standoff);
      let overall = (parseLength(props.getRaw('OVERALLHEIGHT')) ?? 0) / UNITS_PER_MM;
      if (overall <= standoff) overall = standoff + 0.2;
      const bottom = props.int('BODYPROJECTION') === 1;
      const colour = props.has('BODYCOLOR3D') ? colorRef(props.int('BODYCOLOR3D'), Math.min(1, Math.max(0.1, props.float('BODYOPACITY3D') || 1))) : COLOURS.body;
      out.push({
        component: bodyComponent(rec) ?? 0xffff, outline, colour, step, record,
        z0: bottom ? -standoff : thickness + standoff, z1: bottom ? -overall : thickness + overall,
      });
    } catch { /* an unreadable body is left out */ }
  }
  return out;
}

class MeshBuilder {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; idx: number[] = []; reg: number[] = [];
  /** The region the next vertices belong to. */
  region = -1;
  constructor(private withUv = false) {}
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u = 0, v = 0): number {
    this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.reg.push(this.region);
    if (this.withUv) this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }
  quad(a: number, b: number, c: number, d: number): void { this.idx.push(a, b, c, a, c, d); }
  build(colour: RGBA, texture?: 'top' | 'bottom' | 'single'): Mesh {
    return { pos: new Float32Array(this.pos), nrm: new Float32Array(this.nrm), uv: this.withUv ? new Float32Array(this.uv) : null, idx: new Uint32Array(this.idx), colour, texture,
      region: this.reg.some((r) => r >= 0) ? new Int32Array(this.reg) : undefined };
  }
}

const area = (p: Vec2[]) => { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j]!.x * p[i]!.y - p[i]!.x * p[j]!.y; return a / 2; };

/** Walls of a closed loop from z0 to z1, normals facing out of the solid (holes face inwards). */
function walls(m: MeshBuilder, loop: Vec2[], z0: number, z1: number, hole = false): void {
  const ccw = area(loop) > 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    // Outward normal of a CCW loop is (dy, −dx); a hole's solid is outside it
    const s = (ccw ? 1 : -1) * (hole ? -1 : 1);
    const nx = (dy / l) * s, ny = (-dx / l) * s;
    const v0 = m.vertex(a.x, a.y, z0, nx, ny, 0), v1 = m.vertex(b.x, b.y, z0, nx, ny, 0);
    const v2 = m.vertex(b.x, b.y, z1, nx, ny, 0), v3 = m.vertex(a.x, a.y, z1, nx, ny, 0);
    m.quad(v0, v1, v2, v3);
  }
}

/** Triangles cut along a line (a point and its normal): each one crossing it split in two or three, winding kept. */
export function sliceTriangles(pts: Vec2[], idx: number[], cut: { o: [number, number]; n: [number, number] }): { pts: Vec2[]; idx: number[] } {
  const out = pts.slice(), tri: number[] = [];
  const d = (q: Vec2) => (q.x - cut.o[0]) * cut.n[0] + (q.y - cut.o[1]) * cut.n[1];
  const eps = 1e-7;
  const cache = new Map<string, number>();
  const at = (a: number, b: number) => {
    const k = a < b ? `${a}:${b}` : `${b}:${a}`;
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    const pa = out[a]!, pb = out[b]!, da = d(pa), db = d(pb), t = da / (da - db);
    out.push({ x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t });
    cache.set(k, out.length - 1);
    return out.length - 1;
  };
  for (let i = 0; i < idx.length; i += 3) {
    const v = [idx[i]!, idx[i + 1]!, idx[i + 2]!];
    const s = v.map((k) => { const x = d(out[k]!); return x > eps ? 1 : x < -eps ? -1 : 0; });
    if (!(s.includes(1) && s.includes(-1))) { tri.push(...v); continue; }
    // A corner on the line: two triangles
    const z = s.indexOf(0);
    if (z >= 0) {
      const a = v[z]!, b = v[(z + 1) % 3]!, c = v[(z + 2) % 3]!, m = at(b, c);
      tri.push(a, b, m, a, m, c);
      continue;
    }
    // One corner alone on its side: a triangle there, two on the other
    const lone = s.findIndex((x, k) => x !== s[(k + 1) % 3] && x !== s[(k + 2) % 3]);
    const a = v[lone]!, b = v[(lone + 1) % 3]!, c = v[(lone + 2) % 3]!;
    const p = at(a, b), q = at(a, c);
    tri.push(a, p, q, p, b, c, p, c, q);
  }
  return { pts: out, idx: tri };
}

/** A closed outline with a vertex wherever it crosses a line. */
export function cutLoop(loop: Vec2[], cut: { o: [number, number]; n: [number, number] }): Vec2[] {
  const d = (q: Vec2) => (q.x - cut.o[0]) * cut.n[0] + (q.y - cut.o[1]) * cut.n[1];
  const out: Vec2[] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!, da = d(a), db = d(b);
    out.push(a);
    if ((da > 1e-7 && db < -1e-7) || (da < -1e-7 && db > 1e-7)) { const t = da / (da - db); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  return out;
}

/** The 3D view configuration's say in the model: board thickness scaled in Z, cut-outs, the core's and the copper's colours. */
export interface ModelLook { zScale?: number; cutouts?: boolean; core?: RGBA; copper?: RGBA; faceAlpha?: number; /** Outlines the router cuts away (board units). */ routeCuts?: Vec2[][];
  /** Single layer mode on a layer inside the board: a plane for it at this part of the thickness (0 the bottom face, 1 the top). */ inner?: number;
  /** Component bodies left out (single layer mode). */ noBodies?: boolean }

export function buildBoardModel(doc: PcbDocument, look: ModelLook = {}): BoardModel {
  const t = boardThickness(doc) * Math.max(1, look.zScale ?? 1);
  let outline = doc.board.outline;
  if (outline.length < 3) {
    // No board shape: a margin around everything on the board
    let b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of doc.prims) {
      const v = 'at' in p ? p.at : 'a' in p ? p.a : 'c' in p ? p.c : p.outline[0];
      if (v) b = { minX: Math.min(b.minX, v.x), minY: Math.min(b.minY, v.y), maxX: Math.max(b.maxX, v.x), maxY: Math.max(b.maxY, v.y) };
    }
    if (!Number.isFinite(b.minX)) b = { minX: 0, minY: 0, maxX: 10 * UNITS_PER_MM, maxY: 10 * UNITS_PER_MM };
    const m = 2 * UNITS_PER_MM;
    outline = [{ x: b.minX - m, y: b.minY - m }, { x: b.maxX + m, y: b.minY - m }, { x: b.maxX + m, y: b.maxY + m }, { x: b.minX - m, y: b.maxY + m }];
  }
  const rect = { minX: Math.min(...outline.map((v) => v.x)), minY: Math.min(...outline.map((v) => v.y)), maxX: Math.max(...outline.map((v) => v.x)), maxY: Math.max(...outline.map((v) => v.y)) };
  const centre = { x: (rect.minX + rect.maxX) / 2, y: (rect.minY + rect.maxY) / 2 };
  const mm = (v: Vec2): Vec2 => ({ x: (v.x - centre.x) / UNITS_PER_MM, y: (v.y - centre.y) / UNITS_PER_MM });
  const w = rect.maxX - rect.minX || 1, h = rect.maxY - rect.minY || 1;
  const uvOf = (v: Vec2) => [(v.x - rect.minX) / w, (rect.maxY - v.y) / h] as const;

  const cutouts = look.cutouts === false ? [] : doc.prims.filter((p) => p.kind === 'region' && p.boardCutout).map((p) => (p.kind === 'region' ? p.outline : []))
    .filter((o) => o.length >= 3);

  // Regions (rigid-flex): each at its layer stack's place in the board's thickness, cut finely
  // across its bending lines' strips so the board can bend there
  const regs = doc.board.outline.length >= 3 ? boardRegions(doc) : [{ name: '', stackId: '', locked3d: true, bends: [], outline, index: 0 }];
  const rows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [];
  const zOf = (r: { stackId: string }): [number, number] => {
    if (!rows.length || regs.length < 2 && !r.stackId) return [0, t];
    const z = stackRange(rows, r.stackId);
    return z.total > 0 ? [(z.z0 / z.total) * t, (z.z1 / z.total) * t] : [0, t];
  };
  const fold = regs.some((r) => r.bends.length) ? foldOf(regs, mm, (r) => { const [a, b] = zOf(r); return (a + b) / 2; }, UNITS_PER_MM) : null;
  const uvMm = (q: Vec2) => uvOf({ x: q.x * UNITS_PER_MM + centre.x, y: q.y * UNITS_PER_MM + centre.y });
  const faces = [new MeshBuilder(true), new MeshBuilder(true)];
  const innerFace = look.inner !== undefined ? new MeshBuilder(true) : null;
  const edge = new MeshBuilder();
  // Route Tool Path: a rigid board milled along it, in as many pieces as that leaves
  const routed = look.routeCuts?.length && regs.length === 1 && !fold ? clipPieces('difference', [regs[0]!.outline], [...cutouts, ...look.routeCuts]) : null;
  const parts = routed ? routed.map((pc) => ({ ri: 0, r: regs[0]!, shape: pc.outline, holes: pc.holes }))
    : regs.map((r, ri) => ({ ri, r, shape: r.outline, holes: cutouts.filter((c) => pointInPoly(c[0]!, r.outline)) }));
  for (const { ri, r, shape, holes } of parts) {
    const [z0, z1] = zOf(r);
    faces.forEach((m) => { m.region = ri; }); edge.region = ri;
    if (innerFace) innerFace.region = ri;
    let { pts, idx } = triangulateWithHoles(shape, holes);
    let loop = shape.map(mm);
    const holeLoops = holes.map((c) => c.map(mm));
    let flat = pts.map(mm);
    // The strips of this region's bends
    const cuts = (fold?.bends ?? []).flatMap(stripCuts);
    for (const c of cuts) { ({ pts: flat, idx } = sliceTriangles(flat, idx, c)); loop = cutLoop(loop, c); }
    pts = flat;
    faces.forEach((m, k) => {
      const top = k === 0, z = top ? z1 : z0, base = m.pos.length / 3;
      for (const q of pts) { const [u, vv] = uvMm(q); m.vertex(q.x, q.y, z, 0, 0, top ? 1 : -1, u, vv); }
      // Earcut's winding is kept on top, reversed underneath, so both face out
      for (let i = 0; i < idx.length; i += 3) {
        if (top) m.idx.push(base + idx[i]!, base + idx[i + 1]!, base + idx[i + 2]!); else m.idx.push(base + idx[i]!, base + idx[i + 2]!, base + idx[i + 1]!);
      }
    });
    // A layer inside the board shown alone: its plane, seen from both sides
    if (innerFace) {
      const z = z0 + (z1 - z0) * Math.min(0.98, Math.max(0.02, look.inner!)), base = innerFace.pos.length / 3;
      for (const q of pts) { const [u, vv] = uvMm(q); innerFace.vertex(q.x, q.y, z, 0, 0, 1, u, vv); }
      for (let i = 0; i < idx.length; i += 3) innerFace.idx.push(base + idx[i]!, base + idx[i + 1]!, base + idx[i + 2]!);
    }
    // Edges of the region and its cut-outs, core colour
    walls(edge, loop, z0, z1);
    for (const c of holeLoops) walls(edge, cuts.reduce((l, cc) => cutLoop(l, cc), c), z0, z1, true);
  }
  const meshesOut = faces.map((m, k) => m.build([1, 1, 1, look.faceAlpha ?? 1], k === 0 ? 'top' : 'bottom'));
  if (innerFace) meshesOut.push(innerFace.build([1, 1, 1, 0.999], 'single'));

  // Plated barrels in pad and via holes
  const barrel = new MeshBuilder();
  for (const p of doc.prims) {
    const hole = p.kind === 'via' ? p.hole : p.kind === 'pad' && p.layer === L.MULTI && p.plated ? p.hole : 0;
    if (!hole || (p.kind !== 'via' && p.kind !== 'pad')) continue;
    const c = mm(p.at), r = hole / 2 / UNITS_PER_MM;
    const seg = r > 0.6 ? 20 : 10;
    const loop = Array.from({ length: seg }, (_, i) => ({ x: c.x + r * Math.cos((i / seg) * 2 * Math.PI), y: c.y + r * Math.sin((i / seg) * 2 * Math.PI) }));
    const ri = regs.length > 1 ? regs.findIndex((r) => pointInPoly(p.at, r.outline)) : 0;
    const at = regs[ri];
    barrel.region = ri;
    const [z0, z1] = at && regs.length > 1 ? zOf(at) : [0, t];
    walls(barrel, loop, z0, z1, true);
  }

  const bodies = look.noBodies ? [] : componentBodies(doc, t).map((b) => ({ ...b, outline: b.outline.map(mm) }));  // step keeps board coordinates
  return { centre, rect, thickness: t, meshes: [...meshesOut, edge.build(look.core ?? COLOURS.core), barrel.build(look.copper ?? COLOURS.barrel)], bodies, wires: wireLinkMeshes(doc, centre, t), fold };
}

/** A body as a closed extrusion. */
export function bodyMesh(b: Body3D): Mesh {
  const m = new MeshBuilder();
  const lo = Math.min(b.z0, b.z1), hi = Math.max(b.z0, b.z1);
  walls(m, b.outline, lo, hi);
  const tri = triangulate(b.outline);
  for (const [z, nz] of [[hi, 1], [lo, -1]] as const) {
    const base = m.pos.length / 3;
    for (const v of b.outline) m.vertex(v.x, v.y, z, 0, 0, nz);
    for (let i = 0; i < tri.length; i += 3) {
      if (nz > 0) m.idx.push(base + tri[i]!, base + tri[i + 1]!, base + tri[i + 2]!); else m.idx.push(base + tri[i]!, base + tri[i + 2]!, base + tri[i + 1]!);
    }
  }
  return m.build(b.colour);
}
