/**
 * A field solver for the cross-section of a transmission line: any of the usual arrangements of
 * a track (or a pair) over, in or between planes, with the copper's thickness and slope, a
 * solder mask, two dielectrics and side grounds, solved rather than fitted.
 *
 * The cross-section is laid under a grid that is fine about the conductors and grows away from
 * them. Laplace's equation for the potential, the conductors held at 1 V or 0 V, is a network
 * of conductances whose values are the permittivities (analysis/pcg.ts solves it); the charge on
 * a conductor is the flux leaving it, and that is its capacitance. The same again with every
 * dielectric taken as air gives the inductance. From the two: the impedance 1/(c·√(C·C0)), the
 * effective dielectric constant C/C0 and the delay; for a pair, the odd and the even mode.
 * Each is solved on two grids, one twice as fine, and the answers carried on to where the two
 * point (the corners of the conductors make the error fall in step with the grid).
 */

import { link, newLinks, solve } from './pcg';

const C0 = 299_792_458, EPS0 = 8.8541878128e-12;

export type LineKind = 'microstrip' | 'embedded' | 'stripline';

/** A cross-section: lengths in metres. */
export interface LineSetup {
  kind: LineKind;
  /** The track's width at its foot, and its copper's thickness. */
  width: number; thickness: number;
  /** A pair, edge to edge: the gap between the two. */
  pair?: number;
  /** Grounds beside it on its own layer: the gap to each. */
  coplanar?: number;
  /** The dielectric under the track down to the plane: its height and constant. */
  h1: number; er1: number;
  /** Embedded: the dielectric over the track (its height from the track's foot), air above. Stripline: the dielectric up to the upper plane. */
  h2?: number; er2?: number;
  /** Microstrip: a solder mask over the board and the track: its thickness and constant. */
  mask?: { thickness: number; er: number };
  /** How much narrower the track's top is than its foot (etching undercuts it): the two sides together. */
  etch?: number;
}

export interface LineResult {
  /** Single: the track's own. Pair: of one track with the other at 0 V. */
  z0: number; eff: number;
  /** Seconds a metre; farads and henries a metre. */
  delay: number; c: number; l: number;
  /** A pair: its odd and even modes, the differential and common impedances, and how strongly the two couple (0 to 1). */
  pair?: { odd: number; even: number; differential: number; common: number; effOdd: number; effEven: number; coupling: number };
  /** The grid's nodes on the finer of the two solutions. */
  nodes: number;
}

interface Mesh { xs: Float64Array; ys: Float64Array; /** By cell: its dielectric constant. */ er: Float32Array; /** By node: 0 free, 1 ground, 2 the track, 3 the pair's other track. */ role: Uint8Array }

/** Grid lines: every edge in `at`, steps of `fine` between the first and last of `core`, growing by a quarter each step outside it. */
function lines(at: number[], core: [number, number], fine: number, lo: number, hi: number): Float64Array {
  const out = new Set<number>(), add = (v: number) => out.add(Math.round(v * 1e12) / 1e12);
  const marks = [...new Set([lo, hi, ...at.filter((v) => v > lo && v < hi)])].sort((a, b) => a - b);
  for (let k = 0; k + 1 < marks.length; k++) {
    const a = marks[k]!, b = marks[k + 1]!;
    add(a);
    if (a >= core[0] - 1e-15 && b <= core[1] + 1e-15) { const n = Math.max(1, Math.round((b - a) / fine)); for (let i = 1; i < n; i++) add(a + ((b - a) * i) / n); continue; }
    // Away from the core: steps that grow by a quarter each, from the end nearer it
    const near = b <= core[0] + 1e-15 ? b : a, dir = b <= core[0] + 1e-15 ? -1 : 1, len = b - a;
    let s = fine, p = 0;
    while (p + s < len - s * 0.4) { p += s; add(near + dir * p); s *= 1.25; }
  }
  add(hi);
  return Float64Array.from([...out].sort((a, b) => a - b));
}

function mesh(s: LineSetup, n: number): Mesh {
  const t = Math.max(s.thickness, 1e-7), w = s.width, gap = s.pair ?? 0, side = s.coplanar ?? 0;
  const span = s.pair !== undefined ? 2 * w + gap : w, x0 = -span / 2, x1 = span / 2;
  const hTop = s.kind === 'microstrip' ? 0 : s.h2 ?? s.h1, reachY = Math.max(s.h1, hTop, w / 4), reachX = 12 * Math.max(s.h1, hTop) + 2 * w;
  const cw = side > 0 ? Math.max(4 * side, 4 * s.h1, 2 * w) : 0;
  const left = x0 - (side > 0 ? side + cw : 0) - reachX, right = -left;
  const yTrack = s.h1, yTop = s.kind === 'stripline' ? s.h1 + hTop : s.kind === 'embedded' ? Math.max(s.h1 + hTop, s.h1 + t) + 12 * reachY : s.h1 + t + 12 * reachY;
  const maskT = s.kind === 'microstrip' && s.mask && s.mask.thickness > 0 ? s.mask.thickness : 0;
  const fine = Math.min(s.h1, hTop || Infinity, w, gap || Infinity, side || Infinity) / n, fineY = Math.min(fine, t / 2);
  const xe = [x0, x1, 0];
  if (s.pair !== undefined) xe.push(x0 + w, x1 - w);
  if (side > 0) xe.push(x0 - side, x1 + side, x0 - side - cw, x1 + side + cw);
  if (maskT) for (const e of [...xe]) xe.push(e - maskT, e + maskT);
  const coreX: [number, number] = [x0 - (side || 0) - Math.min(2 * fine * n, reachX / 4), x1 + (side || 0) + Math.min(2 * fine * n, reachX / 4)];
  const xs = lines([...xe, coreX[0], coreX[1]], coreX, fine, left, right);
  const ye = [0, yTrack, yTrack + t];
  if (maskT) ye.push(yTrack + maskT, yTrack + t + maskT);
  if (s.kind !== 'microstrip') ye.push(s.h1 + hTop);
  const coreY: [number, number] = [Math.max(0, yTrack - Math.min(s.h1, 4 * t + fine * n)), Math.min(yTop, yTrack + t + Math.min(hTop || Infinity, 4 * t + fine * n))];
  const ys = lines([...ye, coreY[0], coreY[1]], coreY, fineY, 0, yTop);
  const nx = xs.length, ny = ys.length, er = new Float32Array((nx - 1) * (ny - 1)), role = new Uint8Array(nx * ny);
  // Each cell's dielectric, by its middle
  for (let j = 0; j + 1 < ny; j++) for (let i = 0; i + 1 < nx; i++) {
    const x = (xs[i]! + xs[i + 1]!) / 2, y = (ys[j]! + ys[j + 1]!) / 2;
    let e = 1;
    if (y < s.h1) e = s.er1;
    else if (s.kind !== 'microstrip' && y < s.h1 + hTop) e = s.er2 ?? s.er1;
    else if (maskT) {
      // The mask lies on the board, and over and beside each conductor on it
      const onCopper = (a: number, b: number) => x > a - maskT && x < b + maskT && y < yTrack + t + maskT;
      const tracks: [number, number][] = s.pair !== undefined ? [[x0, x0 + w], [x1 - w, x1]] : [[x0, x1]];
      if (side > 0) tracks.push([x0 - side - cw, x0 - side], [x1 + side, x1 + side + cw]);
      if (y < yTrack + maskT || tracks.some(([a, b]) => onCopper(a, b))) e = s.mask!.er;
    }
    er[j * (nx - 1) + i] = e;
  }
  // The conductors: the planes, the track (narrower towards its top), the side grounds
  const slope = Math.min(Math.max(s.etch ?? 0, 0), w * 0.9) / 2, tol = 1e-12;
  const inTrack = (x: number, y: number, a: number, b: number) => { if (y < yTrack - tol || y > yTrack + t + tol) return false; const in_ = (slope * (y - yTrack)) / t; return x >= a + in_ - tol && x <= b - in_ + tol; };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = xs[i]!, y = ys[j]!;
    let r = 0;
    if (j === 0 || (s.kind === 'stripline' && j === ny - 1)) r = 1;
    else if (s.pair !== undefined) { if (inTrack(x, y, x0, x0 + w)) r = 2; else if (inTrack(x, y, x1 - w, x1)) r = 3; }
    else if (inTrack(x, y, x0, x1)) r = 2;
    if (!r && side > 0 && y >= yTrack - tol && y <= yTrack + t + tol && ((x <= x0 - side + tol && x >= x0 - side - cw - tol) || (x >= x1 + side - tol && x <= x1 + side + cw + tol))) r = 1;
    role[j * nx + i] = r;
  }
  return { xs, ys, er, role };
}

/** The charges (farads a metre for a volt) on the track and on the pair's other track, with the track at 1 V and all else at 0 V; `air`: every dielectric taken as air. */
function charges(m: Mesh, air: boolean): { q2: number; q3: number; v: Float64Array } {
  const { xs, ys, er, role } = m, nx = xs.length, ny = ys.length, l = newLinks(2 * nx * ny), held = new Float64Array(nx * ny).fill(NaN), flow = new Float64Array(nx * ny);
  const e = (i: number, j: number) => (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1 ? 0 : air ? 1 : er[j * (nx - 1) + i]!);
  const dx = (i: number) => xs[i + 1]! - xs[i]!, dy = (j: number) => ys[j + 1]! - ys[j]!;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * nx + i;
    if (role[a]) held[a] = role[a] === 2 ? 1 : 0;
    // To the right: the two cells either side of the link, each by half its height over the step
    if (i + 1 < nx) link(l, a, a + 1, ((j > 0 ? e(i, j - 1) * dy(j - 1) : 0) + (j < ny - 1 ? e(i, j) * dy(j) : 0)) / (2 * dx(i)));
    if (j + 1 < ny) link(l, a, a + nx, ((i > 0 ? e(i - 1, j) * dx(i - 1) : 0) + (i < nx - 1 ? e(i, j) * dx(i) : 0)) / (2 * dy(j)));
  }
  const v = solve(nx * ny, l, held, flow, { tolerance: 1e-10 }).x;
  let q2 = 0, q3 = 0;
  for (let k = 0; k < l.count; k++) {
    const a = l.a[k]!, b = l.b[k]!, f = l.g[k]! * (v[a]! - v[b]!);
    if (role[a] === 2 && role[b] !== 2) q2 += f; else if (role[b] === 2 && role[a] !== 2) q2 -= f;
    if (role[a] === 3 && role[b] !== 3) q3 += f; else if (role[b] === 3 && role[a] !== 3) q3 -= f;
  }
  return { q2: q2 * EPS0, q3: q3 * EPS0, v };
}

/** The line's figures on a grid with `n` steps to its smallest dimension. */
function once(s: LineSetup, n: number): { c11: number; c12: number; a11: number; a12: number; nodes: number } {
  const m = mesh(s, n), d = charges(m, false), a = charges(m, true);
  return { c11: d.q2, c12: d.q3, a11: a.q2, a12: a.q3, nodes: m.xs.length * m.ys.length };
}

/** The line solved. `detail`: steps to the smallest dimension on the coarser of the two grids (8). */
export function solveLine(s: LineSetup, detail = 8): LineResult {
  const lo = once(s, detail), hi = once(s, detail * 2);
  // Carried on to where the two grids point
  const on = (k: 'c11' | 'c12' | 'a11' | 'a12') => 2 * hi[k] - lo[k];
  const c11 = on('c11'), c12 = on('c12'), a11 = on('a11'), a12 = on('a12');
  const z = (c: number, a: number) => 1 / (C0 * Math.sqrt(c * a));
  const out: LineResult = { z0: z(c11, a11), eff: c11 / a11, delay: Math.sqrt(c11 / a11) / C0, c: c11, l: 1 / (C0 * C0 * a11), nodes: hi.nodes };
  if (s.pair !== undefined) {
    // The other track's charge is the mutual capacitance, negative: odd adds it to each track's, even takes it away
    const co = c11 - c12, ce = c11 + c12, ao = a11 - a12, ae = a11 + a12, odd = z(co, ao), even = z(ce, ae);
    out.pair = { odd, even, differential: 2 * odd, common: even / 2, effOdd: co / ao, effEven: ce / ae, coupling: (even - odd) / (even + odd) };
  }
  return out;
}

/** The width that gives an impedance (the pair's differential one when it is a pair): by halving on a coarse grid, then set right on the finer one. */
export function widthFor(s: LineSetup, target: number, detail = 8): number {
  const of = (w: number, d: number) => { const r = solveLine({ ...s, width: w }, d); return s.pair !== undefined ? r.pair!.differential : r.z0; };
  let lo = s.h1 / 20, hi = s.h1 * 20;
  // (the impedance falls as the width grows)
  if (of(lo, 4) < target) return lo;
  if (of(hi, 4) > target) return hi;
  for (let k = 0; k < 9; k++) { const mid = Math.sqrt(lo * hi); if (of(mid, 4) > target) lo = mid; else hi = mid; }
  // One step along the curve as the finer grid sees it (impedance against the logarithm of width is near enough straight)
  const w0 = Math.sqrt(lo * hi), w1 = w0 * 1.04, z0 = of(w0, detail), z1 = of(w1, detail);
  return z0 === z1 ? w0 : Math.min(hi * 1.5, Math.max(lo / 1.5, w0 * Math.exp((Math.log(1.04) * (target - z0)) / (z1 - z0))));
}

/** The potential over the cross-section with the track at 1 V (the pair's first track; the second at 0 V), for a picture: the grid and each node's potential and role. */
export function fieldPicture(s: LineSetup, detail = 8): { xs: Float64Array; ys: Float64Array; v: Float64Array; role: Uint8Array; er: Float32Array } {
  const m = mesh(s, detail), d = charges(m, false);
  return { xs: m.xs, ys: m.ys, v: d.v, role: m.role, er: m.er };
}

// ── The closed forms the solver is checked against ──────────────────────────────────────

/** A microstrip of no thickness by Hammerstad and Jensen's formulas (1980): good to a fraction of a per cent. */
export function hammerstadJensen(w: number, h: number, er: number): { z0: number; eff: number } {
  const u = w / h, a = 1 + Math.log((u ** 4 + (u / 52) ** 2) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7, b = 0.564 * ((er - 0.9) / (er + 3)) ** 0.053;
  const eff = (er + 1) / 2 + ((er - 1) / 2) * (1 + 10 / u) ** (-a * b), f = 6 + (2 * Math.PI - 6) * Math.exp(-((30.666 / u) ** 0.7528));
  return { z0: ((376.730313668 / (2 * Math.PI)) * Math.log(f / u + Math.sqrt(1 + (2 / u) ** 2))) / Math.sqrt(eff), eff };
}

/** A stripline of no thickness midway between its planes, exactly (Cohn): b the planes' separation. */
export function striplineExact(w: number, b: number, er: number): number {
  const k = 1 / Math.cosh((Math.PI * w) / (2 * b)), kp = Math.tanh((Math.PI * w) / (2 * b));
  // The complete elliptic integral of the first kind, by the arithmetic-geometric mean
  const K = (m: number) => { let a = 1, g = Math.sqrt(1 - m * m); for (let i = 0; i < 40; i++) { const t = (a + g) / 2; g = Math.sqrt(a * g); a = t; } return Math.PI / (2 * a); };
  return ((376.730313668 / (4 * Math.sqrt(er))) * K(k)) / K(kp);
}
