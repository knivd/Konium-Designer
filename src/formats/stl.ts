/**
 * STL meshes (stereolithography: triangles, no units — millimetres taken, as most tools write
 * them): read binary or ASCII, written binary; and an STL as a STEP model (each triangle a
 * planar face of an AP214 faceted solid, as the board's own STEP export writes its solids), so
 * an STL can be a 3D body, or a part in the 3D model editor, wherever a STEP model can.
 */
import { real, stepStr, styled, stepText, Writer } from './step/write';
import type { RGBA } from './step/tessellate';

export interface StlMesh {
  name: string;
  /** Nine numbers a triangle: its three corners (mm), anticlockwise seen from outside. */
  tris: Float32Array;
}

const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return s; };
const binaryCount = (b: Uint8Array): number | null => {
  if (b.length < 84) return null;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
  return b.length === 84 + n * 50 ? n : null;
};

/** Whether bytes are an STL (by name, or a binary STL's exact size, or an ASCII one's words). */
export function isStl(bytes: Uint8Array, name: string): boolean {
  if (/\.stl$/i.test(name)) return true;
  if (binaryCount(bytes) !== null) return true;
  const head = latin1(bytes.subarray(0, 512));
  return /^\s*solid\b/.test(head) && /\bfacet\s+normal\b/.test(head);
}

export function readStl(bytes: Uint8Array, name: string): StlMesh {
  const stem = name.replace(/\.stl$/i, '');
  const n = binaryCount(bytes);
  if (n !== null) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tris = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) tris[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
    return { name: stem, tris: clean(tris) };
  }
  const text = latin1(bytes);
  if (!/^\s*solid\b/.test(text)) throw new Error(`${name} isn't an STL file`);
  const out: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (out.length % 9 || out.some((v) => !Number.isFinite(v))) throw new Error(`${name}: its triangles couldn't be read`);
  return { name: (/^\s*solid[ \t]+([^\r\n]*)/.exec(text)?.[1]?.trim() || stem), tris: clean(new Float32Array(out)) };
}

/** Triangles with no area (and any not finite) left out. */
function clean(t: Float32Array): Float32Array {
  const keep: number[] = [];
  for (let i = 0; i + 9 <= t.length; i += 9) {
    const ux = t[i + 3]! - t[i]!, uy = t[i + 4]! - t[i + 1]!, uz = t[i + 5]! - t[i + 2]!;
    const vx = t[i + 6]! - t[i]!, vy = t[i + 7]! - t[i + 1]!, vz = t[i + 8]! - t[i + 2]!;
    const a = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (a > 1e-12 && Number.isFinite(a)) keep.push(i);
  }
  if (keep.length * 9 === t.length) return t;
  const out = new Float32Array(keep.length * 9);
  keep.forEach((i, k) => out.set(t.subarray(i, i + 9), k * 9));
  return out;
}

/** Meshes (positions and triangle indices, mm) as a binary STL; its header names it. */
export function writeStl(name: string, meshes: { pos: ArrayLike<number>; idx: ArrayLike<number> }[]): Uint8Array {
  const count = meshes.reduce((s, m) => s + Math.floor(m.idx.length / 3), 0);
  const out = new Uint8Array(84 + count * 50);
  const dv = new DataView(out.buffer);
  // The header mustn't start with "solid" (readers would take the file for ASCII)
  const head = `Konium Designer STL: ${name}`.slice(0, 80);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i) & 0x7f;
  dv.setUint32(80, count, true);
  let o = 84;
  for (const m of meshes) {
    for (let t = 0; t + 3 <= m.idx.length; t += 3) {
      const v = [m.idx[t]!, m.idx[t + 1]!, m.idx[t + 2]!].map((i) => [m.pos[i * 3]!, m.pos[i * 3 + 1]!, m.pos[i * 3 + 2]!]);
      const [a, b, c] = v as [number[], number[], number[]];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
      for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, n[k]! / l, true);
      for (let k = 0; k < 9; k++) dv.setFloat32(o + 12 + k * 4, v[Math.floor(k / 3)]![k % 3]!, true);
      o += 50;
    }
  }
  return out;
}

/** An STL as a STEP file: one faceted solid (a planar face a triangle), in millimetres, in one colour. */
export function stlToStep(mesh: StlMesh, colour: RGBA = [0.6, 0.6, 0.62, 1], when?: Date): string {
  const w = new Writer();
  const name = mesh.name || 'Model';
  const app = w.add(`APPLICATION_CONTEXT('automotive design')`);
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${app})`);
  const prodCtx = w.add(`PRODUCT_CONTEXT('',#${app},'mechanical')`);
  const pdCtx = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${app},'design')`);
  const len = w.add(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const ang = w.add(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const sol = w.add(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#${len},'distance_accuracy_value','confusion accuracy')`);
  const ctx = w.add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${len},#${ang},#${sol}))REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY'))`);
  // Corners and directions written once each
  const pts = new Map<string, number>(), dirs = new Map<string, number>();
  const pt = (x: number, y: number, z: number) => { const k = `${real(x)},${real(y)},${real(z)}`; let id = pts.get(k); if (id === undefined) { id = w.add(`CARTESIAN_POINT('',(${k}))`); pts.set(k, id); } return id; };
  const dir = (x: number, y: number, z: number) => { const k = `${real(x)},${real(y)},${real(z)}`; let id = dirs.get(k); if (id === undefined) { id = w.add(`DIRECTION('',(${k}))`); dirs.set(k, id); } return id; };
  const faces: number[] = [];
  const t = mesh.tris;
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
  for (let i = 0; i + 9 <= t.length; i += 9) {
    const a = [r6(t[i]!), r6(t[i + 1]!), r6(t[i + 2]!)], b = [r6(t[i + 3]!), r6(t[i + 4]!), r6(t[i + 5]!)], c = [r6(t[i + 6]!), r6(t[i + 7]!), r6(t[i + 8]!)];
    const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
    let n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const l = Math.hypot(n[0]!, n[1]!, n[2]!);
    if (l < 1e-12) continue;
    n = n.map((x) => x / l);
    const ids = [pt(a[0]!, a[1]!, a[2]!), pt(b[0]!, b[1]!, b[2]!), pt(c[0]!, c[1]!, c[2]!)];
    if (new Set(ids).size < 3) continue;
    // The plane's X: along the first edge
    const ul = Math.hypot(u[0]!, u[1]!, u[2]!);
    const axis = w.add(`AXIS2_PLACEMENT_3D('',#${ids[0]},#${dir(n[0]!, n[1]!, n[2]!)},#${dir(u[0]! / ul, u[1]! / ul, u[2]! / ul)})`);
    const loop = w.add(`POLY_LOOP('',(${ids.map((x) => `#${x}`).join(',')}))`);
    faces.push(w.add(`FACE_SURFACE('',(#${w.add(`FACE_OUTER_BOUND('',#${loop},.T.)`)}),#${w.add(`PLANE('',#${axis})`)},.T.)`));
  }
  if (!faces.length) throw new Error(`${name}: no triangles in it`);
  const solid = w.add(`FACETED_BREP(${stepStr(name)},#${w.add(`CLOSED_SHELL('',(${faces.map((f) => `#${f}`).join(',')}))`)})`);
  const origin = w.add(`AXIS2_PLACEMENT_3D('',#${pt(0, 0, 0)},#${dir(0, 0, 1)},#${dir(1, 0, 0)})`);
  const rep = w.add(`FACETED_BREP_SHAPE_REPRESENTATION(${stepStr(name)},(#${origin},#${solid}),#${ctx})`);
  const prod = w.add(`PRODUCT(${stepStr(name)},${stepStr(name)},'',(#${prodCtx}))`);
  w.add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(#${prod}))`);
  const pd = w.add(`PRODUCT_DEFINITION('design','',#${w.add(`PRODUCT_DEFINITION_FORMATION('','',#${prod})`)},#${pdCtx})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(#${w.add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`)},#${rep})`);
  w.add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(#${styled(w, solid, colour)}),#${ctx})`);
  return stepText(name, w.lines, when);
}

/** STL bytes as STEP bytes (Latin-1, as STEP files are). */
export function stlBytesToStep(bytes: Uint8Array, name: string): { name: string; bytes: Uint8Array; triangles: number } {
  const mesh = readStl(bytes, name);
  const text = stlToStep(mesh);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return { name: `${name.replace(/\.stl$/i, '')}.step`, bytes: out, triangles: mesh.tris.length / 9 };
}
