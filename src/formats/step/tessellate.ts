/**
 * STEP B-rep to triangles, for 3D bodies (Altium's embedded .step models).
 * Each face's boundary loops are sampled (edges once each, so neighbouring faces meet), taken
 * into the face surface's parameter space, triangulated there (earcut) and, on curved surfaces,
 * subdivided and evaluated back onto the surface with its normals. Surfaces: plane, cylinder,
 * cone, sphere, torus, B-spline (rational too), linear extrusion and revolution; anything else
 * is triangulated flat. Colours from STYLED_ITEMs (face over shell over solid). Assemblies:
 * SHAPE_REPRESENTATION_RELATIONSHIPs (with ITEM_DEFINED_TRANSFORMATION) and MAPPED_ITEMs.
 * Output in millimetres in the model's own coordinates.
 */
import earcut from 'earcut';
import { argsOf, bool, isRef, list, num, refOf, str, typeIs, type StepEntity, type StepFile, type StepVal } from './parse';

export type V3 = [number, number, number];
export type RGBA = [number, number, number, number];
export interface StepMesh { colour: RGBA; pos: Float32Array; nrm: Float32Array; idx: Uint32Array }
export interface StepModel { meshes: StepMesh[]; min: V3; max: V3; faces: number; failed: number }

const DEFAULT: RGBA = [0.75, 0.75, 0.75, 1];
/** Chord tolerance (mm) and the angle limits it is held within. */
const TOL = 0.02, MIN_STEP = 0.15, MAX_STEP = 0.4;
const angStep = (r: number) => (r <= TOL ? MAX_STEP : Math.min(MAX_STEP, Math.max(MIN_STEP, 2 * Math.acos(1 - TOL / r))));
const TAU = Math.PI * 2;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** An affine map: rotation columns x, y, z and translation o. */
export interface Xf { x: V3; y: V3; z: V3; o: V3 }
/** A solid of a model as its assembly places it (millimetres), and the representation it is an item of (-1: none). */
export interface StepSolid { solid: number; rep: number; xf: Xf; colour: RGBA | null }
export const IDENT: Xf = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], o: [0, 0, 0] };
export const apply = (m: Xf, p: V3): V3 => [m.o[0] + m.x[0] * p[0] + m.y[0] * p[1] + m.z[0] * p[2], m.o[1] + m.x[1] * p[0] + m.y[1] * p[1] + m.z[1] * p[2], m.o[2] + m.x[2] * p[0] + m.y[2] * p[1] + m.z[2] * p[2]];
export const applyDir = (m: Xf, p: V3): V3 => [m.x[0] * p[0] + m.y[0] * p[1] + m.z[0] * p[2], m.x[1] * p[0] + m.y[1] * p[1] + m.z[1] * p[2], m.x[2] * p[0] + m.y[2] * p[1] + m.z[2] * p[2]];
export const compose = (a: Xf, b: Xf): Xf => ({ x: applyDir(a, b.x), y: applyDir(a, b.y), z: applyDir(a, b.z), o: apply(a, b.o) });
/** Inverse of a rigid map (orthonormal columns). */
export const invert = (m: Xf): Xf => {
  const x: V3 = [m.x[0], m.y[0], m.z[0]], y: V3 = [m.x[1], m.y[1], m.z[1]], z: V3 = [m.x[2], m.y[2], m.z[2]];
  const r = { x, y, z, o: [0, 0, 0] as V3 };
  return { ...r, o: mul(applyDir(r, m.o), -1) };
};

/* ── NURBS ── */
interface Spline1 { p: number; U: number[]; ctrl: V3[]; w: number[] | null }
interface Spline2 { pu: number; pv: number; U: number[]; V: number[]; ctrl: V3[][]; w: number[][] | null }
function span(n: number, p: number, u: number, U: number[]): number {
  if (u >= U[n + 1]!) return n;
  if (u <= U[p]!) return p;
  let lo = p, hi = n + 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (u < U[m]!) hi = m; else lo = m; }
  return lo;
}
function basis(i: number, u: number, p: number, U: number[]): number[] {
  const N = [1], left = [0], right = [0];
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[i + 1 - j]!; right[j] = U[i + j]! - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1]! + left[j - r]!;
      const t = den === 0 ? 0 : N[r]! / den;
      N[r] = saved + right[r + 1]! * t;
      saved = left[j - r]! * t;
    }
    N[j] = saved;
  }
  return N;
}
function curveAt(c: Spline1, u: number): V3 {
  const n = c.ctrl.length - 1, s = span(n, c.p, u, c.U), N = basis(s, u, c.p, c.U);
  let x = 0, y = 0, z = 0, W = 0;
  for (let j = 0; j <= c.p; j++) {
    const k = s - c.p + j, P = c.ctrl[k]!, w = (c.w ? c.w[k]! : 1) * N[j]!;
    x += P[0] * w; y += P[1] * w; z += P[2] * w; W += w;
  }
  return W ? [x / W, y / W, z / W] : [x, y, z];
}
function surfAt(s: Spline2, u: number, v: number): V3 {
  const nu = s.ctrl.length - 1, nv = s.ctrl[0]!.length - 1;
  const su = span(nu, s.pu, u, s.U), sv = span(nv, s.pv, v, s.V);
  const Nu = basis(su, u, s.pu, s.U), Nv = basis(sv, v, s.pv, s.V);
  let x = 0, y = 0, z = 0, W = 0;
  for (let a = 0; a <= s.pu; a++) {
    const i = su - s.pu + a, row = s.ctrl[i]!, wr = s.w?.[i];
    for (let b = 0; b <= s.pv; b++) {
      const j = sv - s.pv + b, P = row[j]!, w = Nu[a]! * Nv[b]! * (wr ? wr[j]! : 1);
      x += P[0] * w; y += P[1] * w; z += P[2] * w; W += w;
    }
  }
  return W ? [x / W, y / W, z / W] : [x, y, z];
}
function expandKnots(mults: StepVal[], knots: StepVal[]): number[] {
  const U: number[] = [];
  knots.forEach((k, i) => { for (let m = num(mults[i], 1); m > 0; m--) U.push(num(k)); });
  return U;
}
/** Knots of the knot-less forms: clamped uniform (quasi-uniform, Bézier) or uniform. */
function implicitKnots(n: number, p: number, kind: string): number[] {
  if (kind === 'UNIFORM') return Array.from({ length: n + p + 2 }, (_, i) => i);
  if (kind === 'BEZIER') return [...Array(p + 1).fill(0), ...Array(p + 1).fill(1)];
  const U: number[] = [];
  for (let i = 0; i <= p; i++) U.push(0);
  for (let i = 1; i <= n - p; i++) U.push(i);
  for (let i = 0; i <= p; i++) U.push(n - p + 1);
  return U;
}

/** The parameter in [t0, t1] where d(at(t)) is least: samples, then golden-section between the best one's neighbours. */
function minimise(at: (t: number) => V3, d: (q: V3) => number, t0: number, t1: number, n: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i <= n; i++) { const v = d(at(t0 + ((t1 - t0) * i) / n)); if (v < bd) { bd = v; best = i; } }
  let lo = t0 + ((t1 - t0) * Math.max(0, best - 1)) / n, hi = t0 + ((t1 - t0) * Math.min(n, best + 1)) / n;
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618;
    if (d(at(m1)) < d(at(m2))) hi = m2; else lo = m1;
  }
  return (lo + hi) / 2;
}

/* ── the file ── */
export function tessellateStep(file: StepFile, onFace?: (id: number, surface: string, triangles: number) => void): StepModel {
  return new Tessellator(file, onFace).run();
}

interface Curve { at(t: number): V3; param(p: V3, near?: number): number; /** The parameter nearest by a measure of its own (e.g. across an extrusion). */ paramBy?(d: (q: V3) => number): number; period?: number; kind: string; r?: number; range?: [number, number]; /** Knot spans and control points of a spline. */ spans?: number; ctrl?: number }
interface Surface {
  kind: string;
  uv(p: V3, hint?: [number, number] | null): [number, number];
  at(u: number, v: number): V3;
  nrm(u: number, v: number): V3;
  /** How many steps a stretch of (du, dv) spans (≤ 1: short enough to be straight). */
  segs(du: number, dv: number): number;
  periodU?: number; periodV?: number;
  /** A point where u is undefined (a pole or apex). */
  singular?(u: number, v: number): boolean;
  /** A cone's apex: the v it is at. */
  apex?: number;
  planar?: boolean;
  /** A spline's whole parameter rectangle and the grid that draws it to the tolerance. */
  domain?: [number, number, number, number];
  grid?(): { us: number[]; vs: number[] };
}

export class Tessellator {
  private lengthScale = 1;
  private angleScale = 1;
  private pts = new Map<number, V3>();
  private frames = new Map<number, Xf>();
  private curves = new Map<number, Curve | null>();
  private surfaces = new Map<number, Surface | null>();
  private edges = new Map<number, V3[]>();
  private colours = new Map<number, RGBA>();
  private groups = new Map<string, { colour: RGBA; pos: number[]; nrm: number[]; idx: number[] }>();
  private min: V3 = [Infinity, Infinity, Infinity];
  private max: V3 = [-Infinity, -Infinity, -Infinity];
  private faces = 0;
  private failed = 0;
  constructor(private f: StepFile, private onFace?: (id: number, surface: string, triangles: number) => void) {}

  private e(id: number): StepEntity | undefined { return this.f.get(id); }

  /** Instead of drawing: each solid where the assembly places it (mm), the representation it is an item of, its colour. */
  private collect: StepSolid[] | null = null;
  solids(): StepSolid[] {
    this.collect = [];
    this.units();
    this.styles();
    this.assemble();
    const out = this.collect;
    this.collect = null;
    return out;
  }

  run(): StepModel {
    this.units();
    this.styles();
    this.assemble();
    const meshes: StepMesh[] = [];
    for (const g of this.groups.values()) {
      if (!g.idx.length) continue;
      meshes.push({ colour: g.colour, pos: new Float32Array(g.pos), nrm: new Float32Array(g.nrm), idx: new Uint32Array(g.idx) });
    }
    return { meshes, min: this.min, max: this.max, faces: this.faces, failed: this.failed };
  }

  /* ── units ── */
  private unitScale(id: number): { kind: 'length' | 'angle' | 'other'; k: number } {
    const e = this.e(id);
    if (!e) return { kind: 'other', k: 1 };
    const kind = typeIs(e, 'LENGTH_UNIT') ? 'length' : typeIs(e, 'PLANE_ANGLE_UNIT') ? 'angle' : 'other';
    const si = argsOf(e, 'SI_UNIT');
    if (si) {
      const pre = si[0] && typeof si[0] === 'object' && 'e' in si[0] ? si[0].e : '';
      const k = { MILLI: 1e-3, CENTI: 1e-2, DECI: 1e-1, MICRO: 1e-6, KILO: 1e3, NANO: 1e-9 }[pre] ?? 1;
      return { kind, k: kind === 'length' ? k * 1000 : k };
    }
    const cb = argsOf(e, 'CONVERSION_BASED_UNIT');
    if (cb) {
      const m = this.e(refOf(cb[1]));
      const ma = m?.args ?? [];
      const inner = this.unitScale(refOf(ma[1]));
      const v = num(ma[0]);
      const name = str(cb[0]).toUpperCase();
      if (v > 0) return { kind, k: v * inner.k };
      if (name === 'INCH') return { kind, k: 25.4 };
      if (name === 'DEGREE') return { kind, k: Math.PI / 180 };
      return { kind, k: 1 };
    }
    return { kind, k: 1 };
  }
  private units(): void {
    for (const e of this.f.values()) {
      const g = argsOf(e, 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
      if (!g) continue;
      this.defaultUnits = this.unitsIn(g);
      this.lengthScale = this.defaultUnits.length; this.angleScale = this.defaultUnits.angle;
      return;
    }
  }
  private defaultUnits = { length: 1, angle: 1 };
  private unitsIn(g: StepVal[]): { length: number; angle: number } {
    const u = { ...this.defaultUnits };
    for (const x of list(g[0])) {
      const s = this.unitScale(refOf(x));
      if (s.kind === 'length') u.length = s.k;
      if (s.kind === 'angle') u.angle = s.k;
    }
    return u;
  }
  /** A representation's units (its context's); an assembly and its parts may differ. */
  private repUnits(rep: number): { length: number; angle: number } {
    const e = this.e(rep);
    const a = e?.type ? e.args : (argsOf(e, 'REPRESENTATION') ?? argsOf(e, 'SHAPE_REPRESENTATION'));
    const g = argsOf(this.e(refOf(a?.[2])), 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
    return g ? this.unitsIn(g) : this.defaultUnits;
  }
  /** Read geometry in these units from here on (what was read in others is read again). */
  private useUnits(u: { length: number; angle: number }): void {
    if (u.length === this.lengthScale && u.angle === this.angleScale) return;
    this.lengthScale = u.length; this.angleScale = u.angle;
    this.pts.clear(); this.frames.clear(); this.curves.clear(); this.surfaces.clear(); this.edges.clear();
  }

  /* ── styles ── */
  private colourIn(id: number, depth = 0): RGBA | null {
    const e = this.e(id);
    if (!e || depth > 12) return null;
    if (e.type === 'COLOUR_RGB') return [num(e.args[1]), num(e.args[2]), num(e.args[3]), 1];
    if (e.type === 'DRAUGHTING_PRE_DEFINED_COLOUR') {
      const n = str(e.args[0]).toLowerCase();
      const c = ({ red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], yellow: [1, 1, 0], magenta: [1, 0, 1], cyan: [0, 1, 1], black: [0, 0, 0], white: [1, 1, 1] } as Record<string, [number, number, number]>)[n];
      return c ? [...c, 1] : null;
    }
    let alpha = 1;
    let found: RGBA | null = null;
    const visit = (v: StepVal) => {
      if (found) return;
      if (isRef(v)) {
        const t = this.e(v.r);
        if (t?.type === 'SURFACE_STYLE_TRANSPARENT') { alpha = 1 - num(t.args[0]); return; }
        found = this.colourIn(v.r, depth + 1);
      } else if (Array.isArray(v)) for (const x of v) visit(x);
    };
    // Rendering styles carry their transparency beside the colour
    if (e.type === 'SURFACE_STYLE_RENDERING_WITH_PROPERTIES') for (const p of list(e.args[2])) { const t = this.e(refOf(p)); if (t?.type === 'SURFACE_STYLE_TRANSPARENT') alpha = 1 - num(t.args[0]); }
    for (const a of e.args) visit(a);
    if (found) (found as RGBA)[3] = Math.min((found as RGBA)[3], alpha);
    return found;
  }
  private styles(): void {
    const over: [number, RGBA][] = [];
    for (const e of this.f.values()) {
      const t = e.type === 'STYLED_ITEM' || e.type === 'OVER_RIDING_STYLED_ITEM' ? e.args : argsOf(e, 'STYLED_ITEM');
      if (!t) continue;
      const item = refOf(t[2]);
      let c: RGBA | null = null;
      for (const s of list(t[1])) { c = this.colourIn(refOf(s)); if (c) break; }
      if (!c || item < 0) continue;
      if (e.type === 'OVER_RIDING_STYLED_ITEM') over.push([item, c]); else if (!this.colours.has(item)) this.colours.set(item, c);
    }
    for (const [i, c] of over) this.colours.set(i, c);
  }

  /* ── assembly ── */
  private repItems(id: number): StepVal[] {
    const e = this.e(id);
    if (!e) return [];
    const a = e.type ? e.args : (argsOf(e, 'REPRESENTATION') ?? argsOf(e, 'SHAPE_REPRESENTATION') ?? []);
    return list(a[1]);
  }
  private assemble(): void {
    // Identity links join representations into one; transformed links place one in another
    const parent = new Map<number, number>();
    const find = (a: number): number => { let r = a; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
    const join = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    const links: { id: number; a: number; b: number; i1: number; i2: number }[] = [];
    const reps = new Set<number>();
    const sdr: [number, number][] = [], cdsr: [number, number][] = [];
    for (const [id, e] of this.f) {
      const t = e.type;
      if (t === 'SHAPE_DEFINITION_REPRESENTATION') { sdr.push([refOf(e.args[0]), refOf(e.args[1])]); continue; }
      if (t === 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION') { cdsr.push([refOf(e.args[0]), refOf(e.args[1])]); continue; }
      if (t.endsWith('_REPRESENTATION') && (t.includes('SHAPE') || t.includes('BREP')) && !t.startsWith('PRODUCT')) reps.add(id);
      if (!t && (e.parts?.has('SHAPE_REPRESENTATION') || e.parts?.has('ADVANCED_BREP_SHAPE_REPRESENTATION'))) reps.add(id);
      const rr = t === 'SHAPE_REPRESENTATION_RELATIONSHIP' || t === 'REPRESENTATION_RELATIONSHIP' ? e.args : argsOf(e, 'REPRESENTATION_RELATIONSHIP');
      if (!rr) continue;
      const a = refOf(rr[2]), b = refOf(rr[3]);
      const w = argsOf(e, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
      if (w) {
        const idt = this.e(refOf(w[0]));
        if (idt?.type === 'ITEM_DEFINED_TRANSFORMATION') links.push({ id, a, b, i1: refOf(idt.args[2]), i2: refOf(idt.args[3]) });
      } else if (a >= 0 && b >= 0) join(a, b);
    }
    // Which end of a placing link is the part: the product structure says (the occurrence's
    // related product's shape); exporters differ on the order of rep_1 and rep_2
    const definitionOf = (pds: number) => refOf(this.e(pds)?.args[2]);
    const repsOf = new Map<number, Set<number>>();
    for (const [pds, rep] of sdr) { const pd = definitionOf(pds); if (!repsOf.has(pd)) repsOf.set(pd, new Set()); repsOf.get(pd)!.add(find(rep)); }
    const partEnd = new Map<number, 'a' | 'b'>();
    for (const [rel, pds] of cdsr) {
      const nauo = this.e(definitionOf(pds));
      const l = links.find((x) => x.id === rel);
      if (!nauo || !l) continue;
      const kids = repsOf.get(refOf(nauo.args[4]));
      if (kids?.has(find(l.b)) && !kids.has(find(l.a))) partEnd.set(rel, 'b');
      else if (kids?.has(find(l.a))) partEnd.set(rel, 'a');
    }
    const kids = new Map<number, { child: number; ci: number; cr: number; pi: number; pr: number }[]>();
    const isChild = new Set<number>();
    for (const l of links) {
      // Item 1 lies in rep_1, item 2 in rep_2: the part is taken from its item onto the assembly's
      const bIsPart = partEnd.get(l.id) === 'b';
      const child = find(bIsPart ? l.b : l.a), par = find(bIsPart ? l.a : l.b);
      if (child === par) continue;
      const k = bIsPart ? { child, ci: l.i2, cr: l.b, pi: l.i1, pr: l.a } : { child, ci: l.i1, cr: l.a, pi: l.i2, pr: l.b };
      kids.set(par, [...(kids.get(par) ?? []), k]);
      isChild.add(child);
    }
    const members = new Map<number, number[]>();
    for (const r of reps) { const g = find(r); members.set(g, [...(members.get(g) ?? []), r]); }
    // Representations that only describe a shape aspect's properties (Creo writes the part's solid
    // again for "solid data with which properties are associated"): the part is drawn where the
    // assembly places it, never again at the origin
    const productReps = new Set<number>(), aspectReps = new Set<number>();
    for (const [pds, rep] of sdr) (this.e(pds)?.type === 'PROPERTY_DEFINITION' ? aspectReps : productReps).add(rep);
    const aspectOnly = (g: number) => (members.get(g) ?? []).every((r) => aspectReps.has(r) && !productReps.has(r));
    const done = new Set<number>();
    // Each level in its own units: geometry read in them and scaled to millimetres
    const visit = (g: number, xf: Xf, depth: number) => {
      if (depth > 20) return;
      for (const r of members.get(g) ?? []) {
        this.useUnits(this.repUnits(r));
        for (const it of this.repItems(r)) this.item(refOf(it), xf, depth, done, r);
      }
      for (const k of kids.get(g) ?? []) {
        this.useUnits(this.repUnits(k.pr));
        const fp = this.frame(k.pi);
        this.useUnits(this.repUnits(k.cr));
        const fc = this.frame(k.ci);
        visit(k.child, compose(xf, compose(fp, invert(fc))), depth + 1);
      }
    };
    for (const g of members.keys()) if (!isChild.has(g) && !aspectOnly(g)) visit(g, IDENT, 0);
    // Solids no representation reached: drawn where they are
    this.useUnits(this.defaultUnits);
    for (const [id, e] of this.f) if ((e.type === 'MANIFOLD_SOLID_BREP' || e.type === 'BREP_WITH_VOIDS') && !done.has(id)) this.item(id, IDENT, 0, done, -1);
  }
  private item(id: number, xf: Xf, depth: number, done: Set<number>, rep: number): void {
    const e = this.e(id);
    if (!e) return;
    if (this.collect && (e.type === 'MANIFOLD_SOLID_BREP' || e.type === 'FACETED_BREP' || e.type === 'BREP_WITH_VOIDS' || e.type === 'SHELL_BASED_SURFACE_MODEL')) {
      done.add(id);
      this.collect.push({ solid: id, rep, xf, colour: this.colours.get(id) ?? null });
      return;
    }
    switch (e.type) {
      case 'MANIFOLD_SOLID_BREP': case 'FACETED_BREP':
        done.add(id);
        return this.shell(refOf(e.args[1]), xf, this.colours.get(id) ?? null);
      case 'BREP_WITH_VOIDS':
        done.add(id);
        this.shell(refOf(e.args[1]), xf, this.colours.get(id) ?? null);
        for (const v of list(e.args[2])) this.shell(refOf(v), xf, this.colours.get(id) ?? null);
        return;
      case 'SHELL_BASED_SURFACE_MODEL':
        done.add(id);
        for (const s of list(e.args[1])) this.shell(refOf(s), xf, this.colours.get(id) ?? null);
        return;
      case 'MAPPED_ITEM': {
        const map = this.e(refOf(e.args[1]));
        if (!map || depth > 20) return;
        const origin = this.frame(refOf(map.args[0])), target = this.frame(refOf(e.args[2]));
        const m = compose(xf, compose(target, invert(origin)));
        for (const it of this.repItems(refOf(map.args[1]))) this.item(refOf(it), m, depth + 1, done, refOf(map.args[1]));
        return;
      }
    }
  }
  private shell(id: number, xf: Xf, colour: RGBA | null): void {
    const e = this.e(id);
    if (!e) return;
    const c = this.colours.get(id) ?? colour;
    if (e.type === 'ORIENTED_CLOSED_SHELL' || e.type === 'ORIENTED_OPEN_SHELL') return this.shell(refOf(e.args[2]), xf, c);
    for (const f of list(e.args[1])) {
      try { this.face(refOf(f), xf, c); } catch { this.failed++; }
    }
  }

  /* ── geometry ── */
  private point(id: number): V3 {
    let p = this.pts.get(id);
    if (p) return p;
    const e = this.e(id);
    const c = list(e?.type === 'VERTEX_POINT' ? this.e(refOf(e.args[1]))?.args[1] : e?.args[1]);
    p = [num(c[0]) * this.lengthScale, num(c[1]) * this.lengthScale, num(c[2]) * this.lengthScale];
    this.pts.set(id, p);
    return p;
  }
  private dir(id: number): V3 {
    const e = this.e(id);
    const c = list(e?.args[1]);
    return norm([num(c[0]), num(c[1]), num(c[2])]);
  }
  frame(id: number): Xf {
    let f = this.frames.get(id);
    if (f) return f;
    const e = this.e(id);
    if (!e || (e.type !== 'AXIS2_PLACEMENT_3D' && e.type !== 'AXIS1_PLACEMENT')) return IDENT;
    const o = this.point(refOf(e.args[1]));
    const z = isRef(e.args[2]) ? this.dir(refOf(e.args[2])) : [0, 0, 1] as V3;
    let x = e.type === 'AXIS2_PLACEMENT_3D' && isRef(e.args[3]) ? this.dir(refOf(e.args[3])) : (Math.abs(z[0]) < 0.9 ? [1, 0, 0] as V3 : [0, 1, 0] as V3);
    x = norm(sub(x, mul(z, dot(x, z))));
    f = { o, x, y: cross(z, x), z };
    this.frames.set(id, f);
    return f;
  }

  private spline1(e: StepEntity): Spline1 | null {
    let a = argsOf(e, 'B_SPLINE_CURVE');
    let knots: number[] | null = null;
    const simple = e.type === 'B_SPLINE_CURVE_WITH_KNOTS' || e.type === 'QUASI_UNIFORM_CURVE' || e.type === 'UNIFORM_CURVE' || e.type === 'BEZIER_CURVE';
    if (simple) a = e.args.slice(1);
    if (!a) return null;
    const p = num(a[0]), ctrl = list(a[1]).map((r) => this.point(refOf(r)));
    if (e.type === 'B_SPLINE_CURVE_WITH_KNOTS') knots = expandKnots(list(e.args[6]), list(e.args[7]));
    else { const k = argsOf(e, 'B_SPLINE_CURVE_WITH_KNOTS'); if (k) knots = expandKnots(list(k[0]), list(k[1])); }
    if (!knots) knots = implicitKnots(ctrl.length - 1, p, typeIs(e, 'UNIFORM_CURVE') ? 'UNIFORM' : typeIs(e, 'BEZIER_CURVE') ? 'BEZIER' : 'QUASI');
    const r = argsOf(e, 'RATIONAL_B_SPLINE_CURVE');
    const w = r ? list(r[0]).map((x) => num(x, 1)) : null;
    if (ctrl.length < 2 || knots.length !== ctrl.length + p + 1) return null;
    return { p, U: knots, ctrl, w };
  }
  private curve(id: number): Curve | null {
    if (this.curves.has(id)) return this.curves.get(id)!;
    const c = this.makeCurve(id);
    this.curves.set(id, c);
    return c;
  }
  private makeCurve(id: number): Curve | null {
    const e = this.e(id);
    if (!e) return null;
    switch (e.type) {
      case 'SURFACE_CURVE': case 'SEAM_CURVE': case 'INTERSECTION_CURVE': return this.curve(refOf(e.args[1]));
      case 'LINE': {
        const p = this.point(refOf(e.args[1])), v = this.e(refOf(e.args[2]));
        const d = v ? this.dir(refOf(v.args[1])) : [1, 0, 0] as V3;
        return { kind: 'line', at: (t) => add(p, mul(d, t)), param: (q) => dot(sub(q, p), d) };
      }
      case 'CIRCLE': case 'ELLIPSE': {
        const f = this.frame(refOf(e.args[1]));
        const a = num(e.args[2]) * this.lengthScale, b = e.type === 'ELLIPSE' ? num(e.args[3]) * this.lengthScale : a;
        return {
          kind: 'circle', r: Math.max(a, b), period: TAU,
          at: (t) => add(f.o, add(mul(f.x, a * Math.cos(t)), mul(f.y, b * Math.sin(t)))),
          param: (q) => { const d = sub(q, f.o); return Math.atan2(dot(d, f.y) / b, dot(d, f.x) / a); },
          paramBy: (d) => minimise((t) => add(f.o, add(mul(f.x, a * Math.cos(t)), mul(f.y, b * Math.sin(t)))), d, -Math.PI, Math.PI, 72),
        };
      }
      case 'TRIMMED_CURVE': return this.curve(refOf(e.args[1]));
      default: {
        const s = this.spline1(e);
        if (!s) return null;
        const t0 = s.U[s.p]!, t1 = s.U[s.ctrl.length]!;
        // Samples for finding a point's parameter
        const n = Math.min(400, Math.max(16, (s.ctrl.length - s.p) * 12));
        const samples = Array.from({ length: n + 1 }, (_, i) => { const t = t0 + ((t1 - t0) * i) / n; return { t, p: curveAt(s, t) }; });
        const size = dist(samples[0]!.p, samples[n >> 1]!.p) || 1;
        const closed = dist(samples[0]!.p, samples[n]!.p) < Math.max(1e-6, size * 1e-6);
        // Never evaluated outside its domain: round again if closed, else held at its ends
        const inside = (t: number) => (closed ? t0 + ((((t - t0) % (t1 - t0)) + (t1 - t0)) % (t1 - t0)) : Math.min(t1, Math.max(t0, t)));
        return {
          kind: 'spline', range: [t0, t1], spans: Math.max(1, new Set(s.U.slice(s.p, s.ctrl.length + 1)).size - 1), ctrl: s.ctrl.length,
          at: (t) => curveAt(s, t <= t1 && t >= t0 ? t : inside(t)),
          param: (q) => {
            let best = 0, bd = Infinity;
            samples.forEach((x, i) => { const d = dist(x.p, q); if (d < bd) { bd = d; best = i; } });
            // Golden-section refine between the neighbours
            let lo = samples[Math.max(0, best - 1)]!.t, hi = samples[Math.min(n, best + 1)]!.t;
            for (let k = 0; k < 40; k++) {
              const m1 = lo + (hi - lo) * 0.382, m2 = lo + (hi - lo) * 0.618;
              if (dist(curveAt(s, m1), q) < dist(curveAt(s, m2), q)) hi = m2; else lo = m1;
            }
            return (lo + hi) / 2;
          },
          period: closed ? t1 - t0 : undefined,
          paramBy: (d) => minimise((t) => curveAt(s, t), d, t0, t1, n),
        };
      }
    }
  }

  /** An edge's points from its start vertex to its end vertex. */
  private edge(id: number): V3[] {
    const hit = this.edges.get(id);
    if (hit) return hit;
    const e = this.e(id)!;
    const p0 = this.point(refOf(e.args[1])), p1 = this.point(refOf(e.args[2]));
    const c = this.curve(refOf(e.args[3]));
    const same = e.args[4] === null || bool(e.args[4]);
    let pts: V3[] = [p0, p1];
    if (c && c.kind !== 'line') {
      const closed = dist(p0, p1) < 1e-7;
      let t0 = c.param(p0), t1 = c.param(p1);
      if (c.kind === 'circle') {
        if (same) { while (t1 <= t0 + 1e-9) t1 += TAU; if (closed) t1 = t0 + TAU; }
        else { while (t1 >= t0 - 1e-9) t1 -= TAU; if (closed) t1 = t0 - TAU; }
      } else if (closed && c.range) {
        [t0, t1] = same ? c.range : [c.range[1], c.range[0]];
      } else if (c.period && c.range) {
        // A closed spline: the way round that goes with the edge
        if (same && t1 < t0) t1 += c.period; else if (!same && t1 > t0) t1 -= c.period;
      }
      const wrap = (t: number) => (c.period && c.range && c.kind !== 'circle' ? c.range[0] + ((((t - c.range[0]) % c.period) + c.period) % c.period) : t);
      if (c.kind === 'circle') {
        const n = Math.max(1, Math.ceil(Math.abs(t1 - t0) / angStep(c.r!)));
        pts = [p0];
        for (let i = 1; i < n; i++) pts.push(c.at(t0 + ((t1 - t0) * i) / n));
        pts.push(p1);
      } else {
        // A spline: a step per knot span it covers, each halved while its middle strays from the chord
        // Twice as many steps as control points to start with (so a helix isn't stepped a whole
        // turn at a time and taken for straight), then each halved while it strays from its chord
        const n = Math.max(2, Math.ceil((Math.max(c.spans ?? 4, 2 * (c.ctrl ?? 4)) * Math.abs(t1 - t0)) / (c.range![1] - c.range![0] || 1)));
        const ts = Array.from({ length: n + 1 }, (_, i) => t0 + ((t1 - t0) * i) / n);
        const at = (t: number) => c.at(wrap(t));
        pts = [p0];
        const split = (a: number, pa: V3, b: number, pb: V3, depth: number) => {
          const m = (a + b) / 2, pm = at(m);
          const off = (f: number) => dist(at(a + (b - a) * f), add(mul(pa, 1 - f), mul(pb, f)));
          if (depth < 9 && (dist(pm, mul(add(pa, pb), 0.5)) > TOL || off(0.25) > TOL || off(0.75) > TOL)) { split(a, pa, m, pm, depth + 1); pts.push(pm); split(m, pm, b, pb, depth + 1); }
        };
        let prev = p0;
        for (let i = 1; i <= n; i++) {
          const pb = i === n ? p1 : at(ts[i]!);
          split(ts[i - 1]!, prev, ts[i]!, pb, 0);
          pts.push(pb);
          prev = pb;
        }
      }
    }
    this.edges.set(id, pts);
    return pts;
  }
  private loop(id: number): V3[] {
    const e = this.e(id);
    if (!e) return [];
    if (e.type === 'VERTEX_LOOP') return [this.point(refOf(e.args[1]))];
    if (e.type === 'POLY_LOOP') return list(e.args[1]).map((r) => this.point(refOf(r)));
    const out: V3[] = [];
    for (const oe of list(e.args[1])) {
      const o = this.e(refOf(oe));
      if (!o) continue;
      let pts = o.type === 'ORIENTED_EDGE' ? this.edge(refOf(o.args[3])) : this.edge(refOf(oe));
      if (o.type === 'ORIENTED_EDGE' && !bool(o.args[4])) pts = [...pts].reverse();
      for (let i = out.length ? 1 : 0; i < pts.length; i++) out.push(pts[i]!);
    }
    if (out.length > 1 && dist(out[0]!, out.at(-1)!) < 1e-7) out.pop();
    return out;
  }

  /* ── surfaces ── */
  private surface(id: number): Surface | null {
    if (this.surfaces.has(id)) return this.surfaces.get(id)!;
    let s: Surface | null = null;
    try { s = this.makeSurface(id); } catch { s = null; }
    this.surfaces.set(id, s);
    return s;
  }
  private makeSurface(id: number): Surface | null {
    const e = this.e(id);
    if (!e) return null;
    const L = this.lengthScale;
    switch (e.type) {
      case 'PLANE': {
        const f = this.frame(refOf(e.args[1]));
        return { kind: 'plane', planar: true, segs: () => 0,
          uv: (p) => { const d = sub(p, f.o); return [dot(d, f.x), dot(d, f.y)]; },
          at: (u, v) => add(f.o, add(mul(f.x, u), mul(f.y, v))), nrm: () => f.z };
      }
      case 'CYLINDRICAL_SURFACE': case 'CONICAL_SURFACE': {
        const f = this.frame(refOf(e.args[1]));
        const r = num(e.args[2]) * L, ta = e.type === 'CONICAL_SURFACE' ? Math.tan(num(e.args[3]) * this.angleScale) : 0;
        const R = (v: number) => r + v * ta;
        const ca = 1 / Math.sqrt(1 + ta * ta), sa = ta * ca;
        return { kind: 'cyl', periodU: TAU,
          segs: (du) => Math.abs(du) / MAX_STEP,
          uv: (p) => { const d = sub(p, f.o); return [Math.atan2(dot(d, f.y), dot(d, f.x)), dot(d, f.z)]; },
          at: (u, v) => add(f.o, add(add(mul(f.x, R(v) * Math.cos(u)), mul(f.y, R(v) * Math.sin(u))), mul(f.z, v))),
          nrm: (u) => add(mul(add(mul(f.x, Math.cos(u)), mul(f.y, Math.sin(u))), ca), mul(f.z, -sa)),
          singular: (_u, v) => Math.abs(R(v)) < 1e-4 * Math.max(1, r),
          ...(ta ? { apex: -r / ta } : {}),
        };
      }
      case 'SPHERICAL_SURFACE': {
        const f = this.frame(refOf(e.args[1])), r = num(e.args[2]) * L;
        const n = (u: number, v: number): V3 => add(mul(add(mul(f.x, Math.cos(u)), mul(f.y, Math.sin(u))), Math.cos(v)), mul(f.z, Math.sin(v)));
        return { kind: 'sphere', periodU: TAU,
          segs: (du, dv) => Math.max(Math.abs(du), Math.abs(dv)) / MAX_STEP,
          uv: (p) => { const d = sub(p, f.o); return [Math.atan2(dot(d, f.y), dot(d, f.x)), Math.asin(Math.max(-1, Math.min(1, dot(d, f.z) / r)))]; },
          at: (u, v) => add(f.o, mul(n(u, v), r)), nrm: n,
          singular: (_u, v) => Math.abs(Math.cos(v)) < 1e-4,
        };
      }
      case 'TOROIDAL_SURFACE': {
        const f = this.frame(refOf(e.args[1])), R = num(e.args[2]) * L, r = num(e.args[3]) * L;
        const n = (u: number, v: number): V3 => add(mul(add(mul(f.x, Math.cos(u)), mul(f.y, Math.sin(u))), Math.cos(v)), mul(f.z, Math.sin(v)));
        return { kind: 'torus', periodU: TAU, periodV: TAU,
          segs: (du, dv) => Math.max(Math.abs(du), Math.abs(dv)) / MAX_STEP,
          uv: (p) => { const d = sub(p, f.o), x = dot(d, f.x), y = dot(d, f.y); return [Math.atan2(y, x), Math.atan2(dot(d, f.z), Math.hypot(x, y) - R)]; },
          at: (u, v) => add(f.o, add(mul(add(mul(f.x, Math.cos(u)), mul(f.y, Math.sin(u))), R + r * Math.cos(v)), mul(f.z, r * Math.sin(v)))),
          nrm: n,
        };
      }
      case 'SURFACE_OF_LINEAR_EXTRUSION': {
        const c = this.curve(refOf(e.args[1])), vec = this.e(refOf(e.args[2]));
        if (!c || !vec) return null;
        const d = this.dir(refOf(vec.args[1]));
        // u along the curve, v along the extrusion
        // A point's place along the curve: where the curve passes under it, looking along the extrusion
        const across = (p: V3) => (q: V3) => { const w = sub(p, q); return len(sub(w, mul(d, dot(w, d)))); };
        return this.generic('extrusion', (u, v) => add(c.at(u), mul(d, v)), (p) => {
          const t = c.kind === 'line' ? c.param(sub(p, mul(d, dot(sub(p, c.at(0)), d)))) : c.paramBy ? c.paramBy(across(p)) : c.param(p);
          return [t, dot(sub(p, c.at(t)), d)];
        }, c.period, undefined, (du) => (c.kind === 'line' ? 0 : c.kind === 'circle' ? Math.abs(du) / MAX_STEP : (Math.abs(du) * (c.spans ?? 4)) / ((c.range?.[1] ?? 1) - (c.range?.[0] ?? 0) || 1)));
      }
      case 'SURFACE_OF_REVOLUTION': {
        const c = this.curve(refOf(e.args[1])), ax = this.e(refOf(e.args[2]));
        if (!c || !ax) return null;
        const o = this.point(refOf(ax.args[1])), z = isRef(ax.args[2]) ? this.dir(refOf(ax.args[2])) : [0, 0, 1] as V3;
        const rot = (p: V3, a: number): V3 => {
          const d = sub(p, o), along = mul(z, dot(d, z)), perp = sub(d, along);
          return add(o, add(along, add(mul(perp, Math.cos(a)), mul(cross(z, perp), Math.sin(a)))));
        };
        // u: angle round the axis from the curve; v: the curve's parameter
        let rmax = 0;
        if (c.range) for (let i = 0; i <= 8; i++) { const p = c.at(c.range[0] + ((c.range[1] - c.range[0]) * i) / 8), d = sub(p, o); rmax = Math.max(rmax, len(sub(d, mul(z, dot(d, z))))); }
        else rmax = c.r ?? 1;
        return this.generic('revolution', (u, v) => rot(c.at(v), u), (p) => {
          // Turn the point back onto the curve's half-plane
          const p0 = c.at(c.range ? c.range[0] : 0), d0 = sub(p0, o), r0 = sub(d0, mul(z, dot(d0, z)));
          const d = sub(p, o), r = sub(d, mul(z, dot(d, z)));
          const a = Math.atan2(dot(cross(r0, r), z), dot(r0, r));
          const t = c.param(rot(p, -a));
          return [a, t];
        }, TAU, c.period, (du, dv) => Math.max(Math.abs(du) / MAX_STEP, c.kind === 'line' ? 0 : c.range ? (Math.abs(dv) * (c.spans ?? 4)) / (c.range[1] - c.range[0] || 1) : Math.abs(dv) / MAX_STEP));
      }
      default: {
        const s = this.spline2(e);
        if (!s) return null;
        return this.splineSurface(s);
      }
    }
  }
  /** A surface given by a point function and its inverse; normals by differences. */
  private generic(kind: string, at: (u: number, v: number) => V3, uv: Surface['uv'], periodU: number | undefined, periodV: number | undefined, segs: Surface['segs']): Surface {
    const h = 1e-5;
    return { kind, at, uv, periodU, periodV, segs,
      nrm: (u, v) => {
        const a = at(u, v), su = sub(at(u + h, v), a), sv = sub(at(u, v + h), a);
        return norm(cross(su, sv));
      } };
  }
  private spline2(e: StepEntity): Spline2 | null {
    let a = argsOf(e, 'B_SPLINE_SURFACE');
    const simple = ['B_SPLINE_SURFACE_WITH_KNOTS', 'QUASI_UNIFORM_SURFACE', 'UNIFORM_SURFACE', 'BEZIER_SURFACE', 'B_SPLINE_SURFACE'].includes(e.type);
    if (simple) a = e.args.slice(1);
    if (!a) return null;
    const pu = num(a[0]), pv = num(a[1]);
    const ctrl = list(a[2]).map((row) => list(row).map((r) => this.point(refOf(r))));
    if (ctrl.length < 2 || ctrl[0]!.length < 2) return null;
    let U: number[] | null = null, V: number[] | null = null;
    if (e.type === 'B_SPLINE_SURFACE_WITH_KNOTS') { U = expandKnots(list(e.args[8]), list(e.args[10])); V = expandKnots(list(e.args[9]), list(e.args[11])); }
    else { const k = argsOf(e, 'B_SPLINE_SURFACE_WITH_KNOTS'); if (k) { U = expandKnots(list(k[0]), list(k[2])); V = expandKnots(list(k[1]), list(k[3])); } }
    const form = typeIs(e, 'UNIFORM_SURFACE') ? 'UNIFORM' : typeIs(e, 'BEZIER_SURFACE') ? 'BEZIER' : 'QUASI';
    U ??= implicitKnots(ctrl.length - 1, pu, form);
    V ??= implicitKnots(ctrl[0]!.length - 1, pv, form);
    const r = argsOf(e, 'RATIONAL_B_SPLINE_SURFACE');
    const w = r ? list(r[0]).map((row) => list(row).map((x) => num(x, 1))) : null;
    if (U.length !== ctrl.length + pu + 1 || V.length !== ctrl[0]!.length + pv + 1) return null;
    return { pu, pv, U, V, ctrl, w };
  }
  private splineSurface(s: Spline2): Surface {
    const u0 = s.U[s.pu]!, u1 = s.U[s.ctrl.length]!, v0 = s.V[s.pv]!, v1 = s.V[s.ctrl[0]!.length]!;
    const spansU = new Set(s.U.slice(s.pu, s.ctrl.length + 1)).size - 1, spansV = new Set(s.V.slice(s.pv, s.ctrl[0]!.length + 1)).size - 1;
    const at = (u: number, v: number) => surfAt(s, Math.min(u1, Math.max(u0, u)), Math.min(v1, Math.max(v0, v)));
    // Samples for a first guess at a point's parameters
    const gu = Math.min(160, Math.max(6, spansU * 4)), gv = Math.min(160, Math.max(6, spansV * 4));
    const grid: { u: number; v: number; p: V3 }[] = [];
    for (let i = 0; i <= gu; i++) for (let j = 0; j <= gv; j++) { const u = u0 + ((u1 - u0) * i) / gu, v = v0 + ((v1 - v0) * j) / gv; grid.push({ u, v, p: at(u, v) }); }
    const hu = (u1 - u0) * 1e-6, hv = (v1 - v0) * 1e-6;
    const newton = (p: V3, u: number, v: number): [number, number, number] => {
      for (let k = 0; k < 12; k++) {
        const S = at(u, v), Su = mul(sub(at(u + hu, v), S), 1 / hu), Sv = mul(sub(at(u, v + hv), S), 1 / hv);
        const r = sub(p, S);
        const a = dot(Su, Su), b = dot(Su, Sv), c = dot(Sv, Sv), d1 = dot(Su, r), d2 = dot(Sv, r);
        const det = a * c - b * b;
        if (Math.abs(det) < 1e-18) break;
        const du = (c * d1 - b * d2) / det, dv = (a * d2 - b * d1) / det;
        u = Math.min(u1, Math.max(u0, u + du)); v = Math.min(v1, Math.max(v0, v + dv));
        if (Math.abs(du) < (u1 - u0) * 1e-9 && Math.abs(dv) < (v1 - v0) * 1e-9) break;
      }
      return [u, v, dist(at(u, v), p)];
    };
    const segU = (u1 - u0) / Math.max(1, spansU), segV = (v1 - v0) / Math.max(1, spansV);
    // Steps along each direction: every knot span split as finely as its bend needs (a chord
    // strays as the square of its length, so √(stray / tolerance) pieces)
    const steps = (dir: 'u' | 'v'): number[] => {
      const K = dir === 'u' ? s.U.slice(s.pu, s.ctrl.length + 1) : s.V.slice(s.pv, s.ctrl[0]!.length + 1);
      const ks = [...new Set(K)].sort((a, b) => a - b);
      const [o0, o1] = dir === 'u' ? [v0, v1] : [u0, u1];
      const P = (t: number, o: number) => (dir === 'u' ? at(t, o) : at(o, t));
      const out = [ks[0]!];
      for (let i = 1; i < ks.length; i++) {
        const a = ks[i - 1]!, b = ks[i]!;
        let dev = 0;
        for (const f of [0, 0.25, 0.5, 0.75, 1]) {
          const o = o0 + (o1 - o0) * f, pa = P(a, o), pb = P(b, o);
          for (const g of [0.25, 0.5, 0.75]) dev = Math.max(dev, dist(P(a + (b - a) * g, o), add(mul(pa, 1 - g), mul(pb, g))));
        }
        const n = Math.min(24, Math.max(1, Math.ceil(Math.sqrt(dev / TOL))));
        for (let k = 1; k <= n; k++) out.push(a + ((b - a) * k) / n);
      }
      return out;
    };
    let gridCache: { us: number[]; vs: number[] } | null = null;
    return { kind: 'spline', domain: [u0, u1, v0, v1],
      grid: () => (gridCache ??= { us: steps('u'), vs: steps('v') }),
      segs: (du, dv) => Math.max(Math.abs(du) / segU, Math.abs(dv) / segV),
      at,
      // A side drawn together to a point (a revolved profile meeting its axis)
      singular: (u, v) => { const d = (u1 - u0) * 1e-3, a = at(u, v); return dist(a, at(u + d > u1 ? u - d : u + d, v)) < 1e-7; },
      uv: (p, hint) => {
        let r: [number, number, number] | null = hint ? newton(p, hint[0], hint[1]) : null;
        if (r && r[2] < 1e-4) return [r[0], r[1]];
        // From the nearest few samples (a helix's next turn can be nearer than its own), the best
        const near: { g: typeof grid[number]; d: number }[] = [];
        for (const g of grid) {
          const d = dist(g.p, p);
          if (near.length < 6 || d < near[near.length - 1]!.d) {
            near.push({ g, d });
            near.sort((a, b) => a.d - b.d);
            if (near.length > 6) near.pop();
          }
        }
        for (const { g } of near) {
          const t = newton(p, g.u, g.v);
          if (!r || t[2] < r[2]) r = t;
          if (r[2] < 1e-5) break;
        }
        return [r![0], r![1]];
      },
      nrm: (u, v) => {
        // One-sided differences away from the domain's edges
        const du = u + hu * 10 > u1 ? -hu * 10 : hu * 10, dv = v + hv * 10 > v1 ? -hv * 10 : hv * 10;
        const S = at(u, v);
        let n = cross(mul(sub(at(u + du, v), S), Math.sign(du)), mul(sub(at(u, v + dv), S), Math.sign(dv)));
        if (len(n) < 1e-20) {
          // A collapsed edge (a pole): look a little further in
          const S2 = at(u + du * 100, v + dv * 100);
          n = cross(mul(sub(at(u + du * 101, v + dv * 100), S2), Math.sign(du)), mul(sub(at(u + du * 100, v + dv * 101), S2), Math.sign(dv)));
        }
        return norm(n);
      },
    };
  }

  /* ── faces ── */
  private face(id: number, xf: Xf, colour: RGBA | null): void {
    const e = this.e(id);
    if (!e) return;
    if (e.type === 'ORIENTED_FACE') return this.face(refOf(e.args[2]), xf, this.colours.get(id) ?? colour);
    if (e.type !== 'ADVANCED_FACE' && e.type !== 'FACE_SURFACE' && e.type !== 'FACE') return;
    this.faces++;
    const c = this.colours.get(id) ?? colour ?? DEFAULT;
    const same = e.type === 'FACE' || e.args[3] === null || bool(e.args[3]);
    const bounds: { pts: V3[]; outer: boolean }[] = [];
    for (const b of list(e.args[1])) {
      const be = this.e(refOf(b));
      if (!be) continue;
      let pts = this.loop(refOf(be.args[1]));
      if (!bool(be.args[2]) && be.args[2] !== null) pts = [...pts].reverse();
      if (pts.length) bounds.push({ pts, outer: be.type === 'FACE_OUTER_BOUND' });
    }
    // Two edges between the same two vertices: nothing to draw
    if (!bounds.some((b) => b.pts.length >= 3)) return;
    const surf = e.type === 'FACE' ? null : this.surface(refOf(e.args[2]));
    const tri = (surf && this.inUv(bounds, surf, same)) ?? this.flat(bounds);
    if (!tri) { this.failed++; return; }
    this.onFace?.(id, surf?.kind ?? 'flat', tri.idx.length / 3);
    this.emit(tri, xf, c);
  }

  /** Triangles in the surface's parameter space, mapped back onto it. */
  private inUv(bounds: { pts: V3[]; outer: boolean }[], s: Surface, same: boolean): Tri | null {
    type P = { u: number; v: number; p: V3 | null; pole?: boolean };
    const loops: P[][] = [];
    for (const b of bounds) {
      if (b.pts.length < 2 && !(b.pts.length === 1 && s.singular)) continue;
      const out: P[] = [];
      let hint: [number, number] | null = null;
      for (const p of b.pts) {
        const [u, v] = s.uv(p, hint);
        hint = [u, v];
        out.push({ u, v, p, pole: s.singular?.(u, v) });
      }
      loops.push(out);
    }
    if (!loops.length) return null;
    const pu = s.periodU, pv = s.periodV;
    // Unwrap periodic parameters along each loop (u at a pole means nothing: skipped), then
    // note how many times it goes round
    const wraps: [number, number][] = [];
    for (const l of loops) {
      for (const [k, per] of [['u', pu], ['v', pv]] as const) {
        if (!per) continue;
        let a = NaN;
        for (const q of l) {
          if (k === 'u' && q.pole) continue;
          if (!Number.isNaN(a)) { let b = q[k]; while (b - a > per / 2) b -= per; while (a - b > per / 2) b += per; q[k] = b; }
          a = q[k];
        }
      }
      const real = l.filter((q) => !q.pole);
      const w = (k: 'u' | 'v', per?: number) => {
        if (!per || real.length < 2) return 0;
        const a = real.at(-1)![k], b = real[0]![k];
        let d = b - a;
        while (d > per / 2) d -= per;
        while (d < -per / 2) d += per;
        return Math.round((a + d - b) / per);
      };
      wraps.push([w('u', pu), w('v', pv)]);
    }
    // A loop through both poles (a meridian circle on a sphere turned on its side) jumps half a
    // turn at each: which way is ambiguous, so it is taken the way that leaves the face on the
    // loop's left (anticlockwise in (u, v) when the face faces the way the surface does)
    if (pu) {
      for (const [li, l] of loops.entries()) {
        const crossings = l.flatMap((q, i) => (q.pole && !l[(i + 1) % l.length]!.pole ? [i] : []));
        if (crossings.length !== 2 || wraps[li]![0] !== 0) continue;
        const real = l.filter((q) => !q.pole);
        const sign = Math.sign(areaUv(real)) * (same ? 1 : -1);
        const isOuter = bounds[li]?.outer ?? li === 0;
        if ((isOuter && sign < 0) || (!isOuter && sign > 0)) {
          const [c0, c1] = crossings as [number, number];
          const shift = (l[(c0 + 1) % l.length]!.u > (l.slice(0, c0 + 1).reverse().find((q) => !q.pole)?.u ?? 0) ? -1 : 1) * pu;
          for (let i = c0 + 1; i <= c1; i++) if (!l[i]!.pole) l[i]!.u += shift;
        }
      }
    }
    // Poles and apexes: u is undefined there, so take it from the neighbours either side
    for (let li = 0; li < loops.length; li++) {
      const l = loops[li]!;
      if (!l.some((q) => q.pole) || l.length < 3) continue;
      const out: P[] = [];
      const near = (i: number, step: number) => { for (let k = 1; k < l.length; k++) { const q = l[(i + step * k + l.length * k) % l.length]!; if (!q.pole) return q; } return l[i]!; };
      for (let i = 0; i < l.length; i++) {
        const q = l[i]!;
        if (!q.pole) { out.push(q); continue; }
        out.push({ u: near(i, -1).u, v: q.v, p: q.p }, { u: near(i, 1).u, v: q.v, p: q.p });
      }
      loops[li] = out;
    }
    // Loops that go round: a band between two, or a cap closed at the pole
    const round = loops.map((_, i) => wraps[i]![0] !== 0 || wraps[i]![1] !== 0);
    const nRound = round.filter(Boolean).length;
    let polys: P[][];
    if (nRound) {
      const k: 'u' | 'v' = wraps.find((w) => w[0] !== 0) ? 'u' : 'v';
      const ok: 'u' | 'v' = k === 'u' ? 'v' : 'u';
      const per = (k === 'u' ? pu : pv)!;
      const rl = loops.filter((_, i) => round[i]);
      const others = loops.filter((_, i) => !round[i]);
      // Each going-round loop as an open run from c0 to c0 ± period
      const c0 = rl[0]![0]![k];
      const open = (l: P[]): P[] => {
        // Start where it crosses c0 (mod period), then shift so it starts at c0
        let best = 0, bd = Infinity;
        l.forEach((q, i) => { const d = Math.abs(((((q[k] - c0) % per) + per * 1.5) % per) - per / 2); if (d < bd) { bd = d; best = i; } });
        const r = [...l.slice(best), ...l.slice(0, best)];
        for (let i = 1; i < r.length; i++) { const a = r[i - 1]![k]; let b = r[i]![k]; while (b - a > per / 2) b -= per; while (a - b > per / 2) b += per; r[i]![k] = b; }
        const shift = Math.round((r[0]![k] - c0) / per) * per;
        for (const q of r) q[k] -= shift;
        const last = r.at(-1)![k], dir = Math.sign(last - r[0]![k]) || 1;
        r.push({ ...r[0]!, [k]: r[0]![k] + dir * per } as P);
        return r;
      };
      const runs = rl.map(open);
      let poly: P[];
      if (runs.length >= 2) {
        const a = runs[0]!, b = runs[1]!;
        const up = (r: P[]) => r.at(-1)![k] > r[0]![k];
        const A = up(a) ? a : [...a].reverse();
        const B = up(b) ? [...b].reverse() : b;
        poly = [...A, ...B];
      } else {
        // A cap: close along the singular side (where the loop's face lies)
        const a = runs[0]!, inc = a.at(-1)![k] > a[0]![k];
        const left = inc === same; // material on the left of the boundary in (u, v)
        let edge: number;
        if (s.kind === 'sphere') edge = left ? Math.PI / 2 : -Math.PI / 2;
        else if (s.apex !== undefined) edge = s.apex; // a cone closes at its point
        else {
          // Any other surface: the far side of the face's other-parameter range
          const vs = a.map((q) => q[ok]);
          const span = Math.max(...vs) - Math.min(...vs) || 1;
          edge = left ? Math.max(...vs) + span : Math.min(...vs) - span;
          if (s.kind === 'cyl') return this.flat(bounds); // a cylinder can't close on itself
        }
        const lo = a[0]![k], hi = a.at(-1)![k];
        poly = [...a, { u: 0, v: 0, p: null, [k]: hi, [ok]: edge } as P, { u: 0, v: 0, p: null, [k]: lo, [ok]: edge } as P];
      }
      // Holes inside the band, moved into its range
      const lo = Math.min(...poly.map((q) => q[k]));
      for (const h of others) {
        const m = h.reduce((t, q) => t + q[k], 0) / h.length;
        const shift = Math.floor((m - lo) / per) * per;
        for (const q of h) q[k] -= shift;
      }
      polys = [poly, ...others];
    } else {
      // The outer bound first; holes moved into its periodic range
      let oi = bounds.findIndex((b) => b.outer);
      if (oi < 0 || oi >= loops.length) {
        const ar = loops.map((l) => Math.abs(areaUv(l)));
        oi = ar.indexOf(Math.max(...ar));
      }
      const outer = loops[oi]!;
      for (const [k, per] of [['u', pu], ['v', pv]] as const) {
        if (!per) continue;
        const lo = Math.min(...outer.map((q) => q[k]));
        for (const h of loops) {
          if (h === outer) continue;
          const m = h.reduce((t, q) => t + q[k], 0) / h.length;
          const shift = Math.floor((m - lo) / per) * per;
          for (const q of h) q[k] -= shift;
        }
      }
      polys = [outer, ...loops.filter((l) => l !== outer)];
    }
    const rings = polys.filter((l) => l.length >= 3);
    // A spline face that is its whole surface: drawn as the surface's own grid
    if (s.domain && s.grid && rings.length === 1) {
      const [u0, u1, v0, v1] = s.domain;
      if (Math.abs(areaUv(rings[0]!)) >= 0.999 * (u1 - u0) * (v1 - v0)) {
        const { us, vs } = s.grid();
        const pos: V3[] = [], nrm: V3[] = [], idx: number[] = [];
        const sense = same ? 1 : -1;
        for (const u of us) for (const v of vs) { pos.push(s.at(u, v)); nrm.push(mul(s.nrm(u, v), sense)); }
        const W = vs.length;
        for (let i = 0; i + 1 < us.length; i++) for (let j = 0; j + 1 < W; j++) {
          const a = i * W + j, b = (i + 1) * W + j;
          idx.push(a, b, b + 1, a, b + 1, a + 1);
        }
        return { pos, nrm, idx };
      }
    }
    // Triangulate in (u, v)
    const flat: number[] = [], holes: number[] = [], all: P[] = [];
    let scaleU = 1, scaleV = 1;
    for (const [i, l] of rings.entries()) {
      if (i) holes.push(all.length);
      for (const q of l) { flat.push(q.u, q.v); all.push(q); }
    }
    if (all.length < 3) return null;
    // A curved face gets points inside on a grid of the surface's steps (earcut takes them as
    // one-point holes), so its triangles start small instead of as slivers across the face
    if (!s.planar && rings.length) {
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const q of rings[0]!) { u0 = Math.min(u0, q.u); u1 = Math.max(u1, q.u); v0 = Math.min(v0, q.v); v1 = Math.max(v1, q.v); }
      // A spline's own grid (its spans as finely as they bend), else even steps of the surface
      let us: number[], vs: number[];
      if (s.grid) {
        const g = s.grid();
        us = g.us.filter((u) => u > u0 && u < u1); vs = g.vs.filter((v) => v > v0 && v < v1);
      } else {
        const nu = Math.min(48, Math.ceil(s.segs(u1 - u0, 0))), nv = Math.min(48, Math.ceil(s.segs(0, v1 - v0)));
        us = nu > 1 ? Array.from({ length: nu - 1 }, (_, i) => u0 + ((u1 - u0) * (i + 1)) / nu) : [];
        vs = nv > 1 ? Array.from({ length: nv - 1 }, (_, i) => v0 + ((v1 - v0) * (i + 1)) / nv) : [];
      }
      // Cells no more than four times longer one way than the other (in the model's millimetres),
      // so a straight direction gets rows too and no triangle is a sliver across a bend
      const lines = (xs: number[], a: number, b: number) => [a, ...xs, b];
      const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
      const len3 = (pts: V3[]) => pts.slice(1).reduce((t, p, i) => t + dist(p, pts[i]!), 0);
      const Lu = len3(lines(us, u0, u1).map((u) => s.at(u, vm))), Lv = len3(lines(vs, v0, v1).map((v) => s.at(um, v)));
      const hu = Lu / (us.length + 1), hv = Lv / (vs.length + 1);
      if (u1 > u0 && v1 > v0 && Lu > 0 && Lv > 0) { scaleU = Lu / (u1 - u0); scaleV = Lv / (v1 - v0); }
      const finer = (xs: number[], a: number, b: number, k: number) => {
        const all = lines(xs, a, b), out: number[] = [];
        for (let i = 1; i < all.length; i++) for (let j = i === 1 ? 1 : 0; j < k; j++) out.push(all[i - 1]! + ((all[i]! - all[i - 1]!) * (j + (i === 1 ? 0 : 0))) / k);
        return out.filter((x) => x > a && x < b);
      };
      if (hu > 4 * hv && hv > 0) us = finer(us, u0, u1, Math.min(48, Math.ceil(hu / (4 * hv))));
      else if (hv > 4 * hu && hu > 0) vs = finer(vs, v0, v1, Math.min(48, Math.ceil(hv / (4 * hu))));
      while (us.length * vs.length > 4000) { us = us.filter((_, i) => i % 2 === 0); vs = vs.filter((_, i) => i % 2 === 0); }
      if (us.length && vs.length) {
        const du = us.length > 1 ? (us.at(-1)! - us[0]!) / (us.length - 1) : u1 - u0, dv = vs.length > 1 ? (vs.at(-1)! - vs[0]!) / (vs.length - 1) : v1 - v0;
        const inside = (u: number, v: number, l: P[]) => {
          let c = false;
          for (let i = 0, j = l.length - 1; i < l.length; j = i++) {
            const a = l[i]!, b = l[j]!;
            if ((a.v > v) !== (b.v > v) && u < ((b.u - a.u) * (v - a.v)) / (b.v - a.v) + a.u) c = !c;
          }
          return c;
        };
        // Clear of the boundary by a third of a cell, measured in cells
        const clear = (u: number, v: number) => rings.every((l) => l.every((a, i) => {
          const b = l[(i + 1) % l.length]!;
          const ax = (a.u - u) / du, ay = (a.v - v) / dv, bx = (b.u - u) / du, by = (b.v - v) / dv;
          const ex = bx - ax, ey = by - ay, L = ex * ex + ey * ey;
          const t = L ? Math.max(0, Math.min(1, -(ax * ex + ay * ey) / L)) : 0;
          return Math.hypot(ax + ex * t, ay + ey * t) > 0.33;
        }));
        for (const u of us) for (const v of vs) {
          if (!inside(u, v, rings[0]!) || rings.slice(1).some((h) => inside(u, v, h)) || !clear(u, v)) continue;
          holes.push(all.length);
          flat.push(u, v);
          all.push({ u, v, p: null });
        }
      }
    }
    const idx = earcut(flat, holes.length ? holes : undefined);
    if (!idx.length) return null;
    // Earcut's triangles are made Delaunay (in the surface's own proportions), the boundary kept
    const ringEdges = new Set<number>();
    const N = all.length;
    if (!s.planar) {
      let k0 = 0;
      for (const r of rings) {
        for (let i = 0; i < r.length; i++) {
          const a = k0 + i, b = k0 + ((i + 1) % r.length);
          // Edges between sampled boundary points; one made up to close a cap at its pole may bend
          if (all[a]!.p && all[b]!.p) ringEdges.add(a < b ? a * N + b : b * N + a);
        }
        k0 += r.length;
      }
      flipDelaunay(idx, all.map((q) => [q.u * scaleU, q.v * scaleV]), ringEdges);
    }
    const pos: V3[] = [], nrm: V3[] = [], out: number[] = [];
    const sense = same ? 1 : -1;
    const pointAt = (q: P): V3 => q.p ?? s.at(q.u, q.v);
    const normalAt = (u: number, v: number): V3 => mul(s.nrm(u, v), sense);
    const base = all.map((q) => { pos.push(pointAt(q)); nrm.push(normalAt(q.u, q.v)); return pos.length - 1; });
    // Curved: halve the longest edge (in the surface's own measure) until every edge is short.
    // An edge's halving depends only on its ends, so neighbouring triangles meet.
    const uvs: [number, number][] = all.map((q) => [q.u, q.v]);
    const mids = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * 4194304 + b : b * 4194304 + a;
      let m = mids.get(key);
      if (m === undefined) {
        const u = (uvs[a]![0] + uvs[b]![0]) / 2, v = (uvs[a]![1] + uvs[b]![1]) / 2;
        pos.push(s.at(u, v)); nrm.push(normalAt(u, v)); uvs.push([u, v]);
        m = pos.length - 1;
        mids.set(key, m);
      }
      return m;
    };
    // An edge is split when it spans more than a step of the surface's own measure, or when the
    // surface at its middle strays from the chord by more than the tolerance
    const memo = new Map<number, number>();
    const long = (a: number, b: number): number => {
      // The boundary is sampled already (shared with the next face): never split, so faces meet
      if (s.planar || (a < N && b < N && ringEdges.has(a < b ? a * N + b : b * N + a))) return 0;
      const key = a < b ? a * 4194304 + b : b * 4194304 + a;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const ua = uvs[a]!, ub = uvs[b]!, pa = pos[a]!, pb = pos[b]!;
      // Analytic surfaces: no more than a step round; splines: only by how far they stray
      const g = s.grid ? 0 : s.segs(ub[0] - ua[0], ub[1] - ua[1]);
      let r = g > 1 ? g : 0;
      if (!r) {
        const m = mid(a, b), pm = pos[m]!;
        let dev = Math.hypot(pm[0] - (pa[0] + pb[0]) / 2, pm[1] - (pa[1] + pb[1]) / 2, pm[2] - (pa[2] + pb[2]) / 2);
        // A spline can cross its chord at the middle and still stray either side
        if (s.grid && dev <= TOL) for (const f of [0.25, 0.75]) {
          const q = s.at(ua[0] + (ub[0] - ua[0]) * f, ua[1] + (ub[1] - ua[1]) * f);
          dev = Math.max(dev, dist(q, add(mul(pa, 1 - f), mul(pb, f))));
        }
        r = dev > TOL ? 1 + dev : 0;
      }
      memo.set(key, r);
      return r;
    };
    const stack: [number, number, number, number][] = [];
    for (let t = 0; t < idx.length; t += 3) stack.push([base[idx[t]!]!, base[idx[t + 1]!]!, base[idx[t + 2]!]!, 0]);
    while (stack.length) {
      const [a, b, c, d] = stack.pop()!;
      const mab = long(a, b), mbc = long(b, c), mca = long(c, a);
      const m = Math.max(mab, mbc, mca);
      if (m <= 1 || d >= 12 || out.length > 300000) { out.push(a, b, c); continue; }
      if (m === mab) { const x = mid(a, b); stack.push([a, x, c, d + 1], [x, b, c, d + 1]); }
      else if (m === mbc) { const x = mid(b, c); stack.push([a, b, x, d + 1], [a, x, c, d + 1]); }
      else { const x = mid(c, a); stack.push([a, b, x, d + 1], [x, b, c, d + 1]); }
    }
    return { pos, nrm, idx: out };
  }

  /** Fallback: the boundary triangulated flat (projected on its best-fit plane). */
  private flat(bounds: { pts: V3[]; outer: boolean }[]): Tri | null {
    const all = bounds.filter((b) => b.pts.length >= 3);
    if (!all.length) return null;
    // Newell's normal of the largest loop
    let n: V3 = [0, 0, 0];
    const o = all[0]!.pts;
    for (let i = 0; i < o.length; i++) { const a = o[i]!, b = o[(i + 1) % o.length]!; n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]); }
    if (len(n) < 1e-12) return null;
    n = norm(n);
    const x = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), y = cross(n, x);
    const flat: number[] = [], holes: number[] = [], pos: V3[] = [];
    all.forEach((b, i) => { if (i) holes.push(pos.length); for (const p of b.pts) { flat.push(dot(p, x), dot(p, y)); pos.push(p); } });
    const idx = earcut(flat, holes.length ? holes : undefined);
    return idx.length ? { pos, nrm: pos.map(() => n), idx } : null;
  }

  private emit(t: Tri, xf: Xf, c: RGBA): void {
    const key = c.map((v) => v.toFixed(3)).join(',');
    let g = this.groups.get(key);
    if (!g) { g = { colour: c, pos: [], nrm: [], idx: [] }; this.groups.set(key, g); }
    const base = g.pos.length / 3;
    for (const p of t.pos) {
      const q = apply(xf, p);
      g.pos.push(q[0], q[1], q[2]);
      for (let k = 0; k < 3; k++) { if (q[k]! < this.min[k]!) this.min[k] = q[k]!; if (q[k]! > this.max[k]!) this.max[k] = q[k]!; }
    }
    for (const n of t.nrm) { const q = applyDir(xf, n); g.nrm.push(q[0], q[1], q[2]); }
    for (const i of t.idx) g.idx.push(base + i);
  }
}
interface Tri { pos: V3[]; nrm: V3[]; idx: number[] }

/**
 * Lawson's flips: an edge whose two triangles break the empty-circle rule is swapped for the
 * other diagonal, until none does; `fixed` edges (keys a·N+b, a<b) stay. Triangles in place.
 */
function flipDelaunay(tri: number[], p: number[][], fixed: Set<number>): void {
  const N = p.length;
  const orient = (a: number, b: number, c: number) => (p[b]![0] - p[a]![0]) * (p[c]![1] - p[a]![1]) - (p[b]![1] - p[a]![1]) * (p[c]![0] - p[a]![0]);
  for (let t = 0; t < tri.length; t += 3) if (orient(tri[t]!, tri[t + 1]!, tri[t + 2]!) < 0) { const x = tri[t + 1]!; tri[t + 1] = tri[t + 2]!; tri[t + 2] = x; }
  const key = (a: number, b: number) => (a < b ? a * N + b : b * N + a);
  const edges = new Map<number, number[]>();
  const add = (t: number) => { for (let k = 0; k < 3; k++) { const e = key(tri[t + k]!, tri[t + ((k + 1) % 3)]!); const l = edges.get(e); if (l) l.push(t); else edges.set(e, [t]); } };
  const drop = (t: number) => { for (let k = 0; k < 3; k++) { const e = key(tri[t + k]!, tri[t + ((k + 1) % 3)]!); const l = edges.get(e); if (l) { const i = l.indexOf(t); if (i >= 0) l.splice(i, 1); } } };
  for (let t = 0; t < tri.length; t += 3) add(t);
  const inCircle = (a: number, b: number, c: number, d: number) => {
    const ax = p[a]![0] - p[d]![0], ay = p[a]![1] - p[d]![1], bx = p[b]![0] - p[d]![0], by = p[b]![1] - p[d]![1], cx = p[c]![0] - p[d]![0], cy = p[c]![1] - p[d]![1];
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay) > 1e-12;
  };
  const queue = [...edges.keys()];
  let budget = Math.min(4_000_000, queue.length * Math.max(30, queue.length));
  while (queue.length && budget-- > 0) {
    const e = queue.pop()!;
    if (fixed.has(e)) continue;
    const l = edges.get(e);
    if (!l || l.length !== 2) continue;
    const [t1, t2] = l as [number, number];
    const a = Math.floor(e / N), b = e - a * N;
    const third = (t: number) => [tri[t]!, tri[t + 1]!, tri[t + 2]!].find((v) => v !== a && v !== b)!;
    const c = third(t1), d = third(t2);
    // t1 as (a, b, c) anticlockwise
    const [x, y] = orient(a, b, c) > 0 ? [a, b] : [b, a];
    if (!inCircle(x, y, c, d)) continue;
    // Only a convex quadrilateral can take the other diagonal
    if (orient(c, d, x) * orient(c, d, y) >= 0 || orient(x, y, c) * orient(x, y, d) >= 0) continue;
    drop(t1); drop(t2);
    tri[t1] = x; tri[t1 + 1] = d; tri[t1 + 2] = c;
    tri[t2] = d; tri[t2 + 1] = y; tri[t2 + 2] = c;
    for (const t of [t1, t2]) if (orient(tri[t]!, tri[t + 1]!, tri[t + 2]!) < 0) { const z = tri[t + 1]!; tri[t + 1] = tri[t + 2]!; tri[t + 2] = z; }
    add(t1); add(t2);
    queue.push(key(x, d), key(d, y), key(y, c), key(c, x));
  }
}
const areaUv = (l: { u: number; v: number }[]) => { let a = 0; for (let i = 0, j = l.length - 1; i < l.length; j = i++) a += l[j]!.u * l[i]!.v - l[i]!.u * l[j]!.v; return a / 2; };
