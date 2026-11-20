/**
 * Linear solves for the circuit matrix, real (DC, transient) or complex (AC, noise), factored once
 * and then solved for as many right-hand sides as asked (and for the transposed system, which the
 * noise analysis's adjoint needs). Small circuits: Gaussian elimination with partial pivoting on
 * the dense matrix. Larger ones: a sparse LU in the manner of SPICE's Sparse package — the pivots
 * chosen by Markowitz's criterion (fewest fill-ins) with threshold pivoting, the order and the
 * fill-in found once and reused while the values change, and found again only when the matrix
 * gains an entry or a pivot grows too small for its column.
 *
 * The matrix is the row-major n×n array the devices stamp into, with the positions they have ever
 * stamped (the pattern) listed beside it.
 */

/** A matrix as the devices stamp it: values (imaginary parts for AC), and the positions used. */
export interface Stamped {
  n: number;
  re: Float64Array;
  im: Float64Array | null;
  /** Flat positions (row·n + column) ever stamped, in the order first stamped. */
  pat: number[];
  /** Bumped when the pattern gains a position. */
  patVersion: number;
}

/** Circuits with fewer unknowns are factored dense (the sparse bookkeeping doesn't pay). */
export const SPARSE_FROM = { n: 40 };
/** Threshold pivoting: a pivot at least this part of the largest in its column (SPICE's PIVREL). */
export const PIVOTING = { rel: 1e-3 };

export class SingularMatrix extends Error {}

interface Order {
  version: number;
  /** Step k's pivot: row pr[k], column pc[k]; colStep[c] the step of column c. */
  pr: Int32Array; pc: Int32Array; colStep: Int32Array;
  /** Each step's row of the original matrix gathered: flat positions and their steps. */
  aPtr: Int32Array; aFlat: Int32Array; aStep: Int32Array;
  /** L (unit diagonal, by rows: the earlier steps a row is eliminated by), U (by rows, right of the diagonal). */
  lPtr: Int32Array; lIdx: Int32Array; lRe: Float64Array; lIm: Float64Array | null;
  uPtr: Int32Array; uIdx: Int32Array; uRe: Float64Array; uIm: Float64Array | null;
  dRe: Float64Array; dIm: Float64Array | null;
}

export class Solver {
  /** The pivot ratio (Advanced Options' PIVREL). */
  constructor(readonly pivrel = PIVOTING.rel) {}
  private n = 0;
  private complex = false;
  /** Dense: the factors in place, and the row each step's pivot came from. */
  private lr = new Float64Array(0);
  private li = new Float64Array(0);
  private perm = new Int32Array(0);
  private order: Order | null = null;
  private wr = new Float64Array(0);
  private wi = new Float64Array(0);
  /** How often the sparse order was found (for tests and Advanced Options' statistics). */
  orderings = 0;
  sparse = false;

  /** Factor the stamped matrix; false when it is singular. */
  factor(m: Stamped): boolean {
    const n = m.n;
    this.complex = !!m.im;
    if (n !== this.n) { this.n = n; this.order = null; this.wr = new Float64Array(n); this.wi = new Float64Array(n); }
    this.sparse = n >= SPARSE_FROM.n;
    if (!this.sparse) return this.denseFactor(m);
    if (this.order && this.order.version === m.patVersion && this.numeric(m, this.order)) return true;
    const o = this.findOrder(m);
    if (!o) return false;
    this.order = o;
    this.orderings++;
    return this.numeric(m, o, true);
  }

  /** Solve A x = b with the factors (b becomes x). */
  solve(br: Float64Array, bi?: Float64Array): void {
    if (this.sparse) this.sparseSolve(br, bi ?? null, false);
    else this.denseSolve(br, bi ?? null, false);
  }
  /** Solve Aᵀ x = b (not conjugated) with the same factors. */
  solveTransposed(br: Float64Array, bi?: Float64Array): void {
    if (this.sparse) this.sparseSolve(br, bi ?? null, true);
    else this.denseSolve(br, bi ?? null, true);
  }

  /* ─── Dense ─── */

  private denseFactor(m: Stamped): boolean {
    const n = m.n, cx = this.complex;
    if (this.lr.length !== n * n) { this.lr = new Float64Array(n * n); this.li = new Float64Array(cx ? n * n : 0); this.perm = new Int32Array(n); }
    if (cx && this.li.length !== n * n) this.li = new Float64Array(n * n);
    const a = this.lr, ai = this.li;
    a.set(m.re);
    if (cx) ai.set(m.im!);
    const perm = this.perm;
    for (let k = 0; k < n; k++) {
      let p = k, best = cx ? Math.hypot(a[k * n + k]!, ai[k * n + k]!) : Math.abs(a[k * n + k]!);
      for (let i = k + 1; i < n; i++) { const v = cx ? Math.hypot(a[i * n + k]!, ai[i * n + k]!) : Math.abs(a[i * n + k]!); if (v > best) { best = v; p = i; } }
      if (best < 1e-300) return false;
      perm[k] = p;
      if (p !== k) {
        const rk = k * n, rp = p * n;
        for (let j = 0; j < n; j++) {
          let t = a[rk + j]!; a[rk + j] = a[rp + j]!; a[rp + j] = t;
          if (cx) { t = ai[rk + j]!; ai[rk + j] = ai[rp + j]!; ai[rp + j] = t; }
        }
      }
      const rk = k * n, pr = a[rk + k]!, pi = cx ? ai[rk + k]! : 0, pd = pr * pr + pi * pi;
      for (let i = k + 1; i < n; i++) {
        const ri = i * n, xr = a[ri + k]!, xi = cx ? ai[ri + k]! : 0;
        if (xr === 0 && xi === 0) continue;
        const fr = cx ? (xr * pr + xi * pi) / pd : xr / pr, fi = cx ? (xi * pr - xr * pi) / pd : 0;
        a[ri + k] = fr;
        if (cx) ai[ri + k] = fi;
        for (let j = k + 1; j < n; j++) {
          const vr = a[rk + j]!, vi = cx ? ai[rk + j]! : 0;
          if (vr === 0 && vi === 0) continue;
          a[ri + j] -= fr * vr - fi * vi;
          if (cx) ai[ri + j] -= fr * vi + fi * vr;
        }
      }
    }
    return true;
  }

  private denseSolve(br: Float64Array, bi: Float64Array | null, transposed: boolean): void {
    const n = this.n, a = this.lr, ai = this.li, cx = this.complex && !!bi, perm = this.perm;
    if (!transposed) {
      for (let k = 0; k < n; k++) {
        const p = perm[k]!;
        if (p !== k) { let t = br[k]!; br[k] = br[p]!; br[p] = t; if (cx) { t = bi![k]!; bi![k] = bi![p]!; bi![p] = t; } }
      }
      for (let i = 0; i < n; i++) {
        const ri = i * n;
        let sr = br[i]!, si = cx ? bi![i]! : 0;
        for (let j = 0; j < i; j++) {
          const lr = a[ri + j]!, li = cx ? ai[ri + j]! : 0;
          if (lr === 0 && li === 0) continue;
          const yr = br[j]!, yi = cx ? bi![j]! : 0;
          sr -= lr * yr - li * yi; si -= lr * yi + li * yr;
        }
        br[i] = sr; if (cx) bi![i] = si;
      }
      for (let i = n - 1; i >= 0; i--) {
        const ri = i * n;
        let sr = br[i]!, si = cx ? bi![i]! : 0;
        for (let j = i + 1; j < n; j++) {
          const ur = a[ri + j]!, ui = cx ? ai[ri + j]! : 0;
          if (ur === 0 && ui === 0) continue;
          const yr = br[j]!, yi = cx ? bi![j]! : 0;
          sr -= ur * yr - ui * yi; si -= ur * yi + ui * yr;
        }
        const dr = a[ri + i]!, di = cx ? ai[ri + i]! : 0;
        if (cx) { const dd = dr * dr + di * di; br[i] = (sr * dr + si * di) / dd; bi![i] = (si * dr - sr * di) / dd; } else br[i] = sr / dr;
      }
      return;
    }
    // (P A = L U)ᵀ: Uᵀ Lᵀ P x = b — forward through Uᵀ, back through Lᵀ, then undo the swaps
    for (let i = 0; i < n; i++) {
      let sr = br[i]!, si = cx ? bi![i]! : 0;
      for (let j = 0; j < i; j++) {
        const ur = a[j * n + i]!, ui = cx ? ai[j * n + i]! : 0;
        if (ur === 0 && ui === 0) continue;
        const yr = br[j]!, yi = cx ? bi![j]! : 0;
        sr -= ur * yr - ui * yi; si -= ur * yi + ui * yr;
      }
      const dr = a[i * n + i]!, di = cx ? ai[i * n + i]! : 0;
      if (cx) { const dd = dr * dr + di * di; br[i] = (sr * dr + si * di) / dd; bi![i] = (si * dr - sr * di) / dd; } else br[i] = sr / dr;
    }
    for (let i = n - 1; i >= 0; i--) {
      let sr = br[i]!, si = cx ? bi![i]! : 0;
      for (let j = i + 1; j < n; j++) {
        const lr = a[j * n + i]!, li = cx ? ai[j * n + i]! : 0;
        if (lr === 0 && li === 0) continue;
        const yr = br[j]!, yi = cx ? bi![j]! : 0;
        sr -= lr * yr - li * yi; si -= lr * yi + li * yr;
      }
      br[i] = sr; if (cx) bi![i] = si;
    }
    for (let k = n - 1; k >= 0; k--) {
      const p = perm[k]!;
      if (p !== k) { let t = br[k]!; br[k] = br[p]!; br[p] = t; if (cx) { t = bi![k]!; bi![k] = bi![p]!; bi![p] = t; } }
    }
  }

  /* ─── Sparse ─── */

  /** Markowitz ordering with threshold pivoting on the present values; null when singular. */
  private findOrder(m: Stamped): Order | null {
    const n = m.n, cx = this.complex, re = m.re, im = m.im;
    // Rows as maps column → value; columns as the rows they hold
    const rr: Map<number, number>[] = Array.from({ length: n }, () => new Map());
    const ri: Map<number, number>[] | null = cx ? Array.from({ length: n }, () => new Map()) : null;
    const cols: Set<number>[] = Array.from({ length: n }, () => new Set());
    for (const f of m.pat) {
      const r = (f / n) | 0, c = f - r * n;
      rr[r]!.set(c, re[f]!);
      if (ri) ri[r]!.set(c, im![f]!);
      cols[c]!.add(r);
    }
    const mag = (r: number, c: number) => { const a = rr[r]!.get(c) ?? 0; return ri ? Math.hypot(a, ri[r]!.get(c) ?? 0) : Math.abs(a); };
    const rowDone = new Uint8Array(n), colDone = new Uint8Array(n);
    const pr = new Int32Array(n), pc = new Int32Array(n);
    const lOf: number[][] = Array.from({ length: n }, () => []);
    const uOf: number[][] = new Array(n);
    const colMaxCache = new Float64Array(n);
    const colMaxStep = new Int32Array(n).fill(-1);
    const colMax = (c: number, k: number) => {
      if (colMaxStep[c] === k) return colMaxCache[c]!;
      let best = 0;
      for (const r of cols[c]!) { const v = mag(r, c); if (v > best) best = v; }
      colMaxCache[c] = best; colMaxStep[c] = k;
      return best;
    };
    for (let k = 0; k < n; k++) {
      let br = -1, bc = -1, bestMark = Infinity, bestRatio = 0;
      const consider = (r: number, c: number) => {
        const v = mag(r, c);
        if (!(v > 1e-300)) return;
        const cm = colMax(c, k);
        if (v < this.pivrel * cm) return;
        const mark = (rr[r]!.size - 1) * (cols[c]!.size - 1);
        const ratio = v / cm;
        if (mark < bestMark || (mark === bestMark && ratio > bestRatio)) { bestMark = mark; bestRatio = ratio; br = r; bc = c; }
      };
      // Singleton columns first (a voltage source's branch), then the diagonal, then anywhere
      for (let c = 0; c < n && bestMark > 0; c++) {
        if (colDone[c] || cols[c]!.size !== 1) continue;
        const r = cols[c]!.values().next().value as number;
        consider(r, c);
      }
      if (bestMark > 0) for (let r = 0; r < n; r++) if (!rowDone[r] && !colDone[r] && rr[r]!.has(r)) consider(r, r);
      if (br < 0) for (let r = 0; r < n; r++) { if (rowDone[r]) continue; for (const c of rr[r]!.keys()) consider(r, c); }
      if (br < 0) return null;
      pr[k] = br; pc[k] = bc;
      // Eliminate the pivot's column from the rows below it
      const prow = rr[br]!, prowI = ri?.[br];
      const p = prow.get(bc)!, pi = prowI?.get(bc) ?? 0, pd = p * p + pi * pi;
      for (const r2 of [...cols[bc]!]) {
        if (r2 === br) continue;
        const x = rr[r2]!.get(bc)!, xi = ri?.[r2]!.get(bc) ?? 0;
        const fr = cx ? (x * p + xi * pi) / pd : x / p, fi = cx ? (xi * p - x * pi) / pd : 0;
        lOf[r2]!.push(k);
        rr[r2]!.delete(bc); ri?.[r2]!.delete(bc);
        for (const [j, v] of prow) {
          if (j === bc) continue;
          const vi = prowI?.get(j) ?? 0;
          const row = rr[r2]!;
          if (!row.has(j)) { row.set(j, 0); ri?.[r2]!.set(j, 0); cols[j]!.add(r2); }
          row.set(j, row.get(j)! - (fr * v - fi * vi));
          if (ri) ri[r2]!.set(j, ri[r2]!.get(j)! - (fr * vi + fi * v));
        }
      }
      uOf[k] = [...prow.keys()].filter((j) => j !== bc);
      for (const j of prow.keys()) cols[j]!.delete(br);
      cols[bc]!.clear();
      rowDone[br] = 1; colDone[bc] = 1;
    }
    const colStep = new Int32Array(n);
    for (let k = 0; k < n; k++) colStep[pc[k]!] = k;
    // Static structure: each step's original row, L and U patterns (CSR)
    const rowsPat: number[][] = Array.from({ length: n }, () => []);
    for (const f of m.pat) rowsPat[(f / n) | 0]!.push(f);
    let na = 0, nl = 0, nu = 0;
    for (let k = 0; k < n; k++) { na += rowsPat[pr[k]!]!.length; nl += lOf[pr[k]!]!.length; nu += uOf[k]!.length; }
    const aPtr = new Int32Array(n + 1), aFlat = new Int32Array(na), aStep = new Int32Array(na);
    const lPtr = new Int32Array(n + 1), lIdx = new Int32Array(nl);
    const uPtr = new Int32Array(n + 1), uIdx = new Int32Array(nu);
    let qa = 0, ql = 0, qu = 0;
    for (let k = 0; k < n; k++) {
      const r = pr[k]!;
      for (const f of rowsPat[r]!) { aFlat[qa] = f; aStep[qa++] = colStep[f - r * n]!; }
      aPtr[k + 1] = qa;
      for (const s of lOf[r]!) lIdx[ql++] = s;
      lPtr[k + 1] = ql;
      const us = uOf[k]!.map((c) => colStep[c]!).sort((x, y) => x - y);
      for (const s of us) uIdx[qu++] = s;
      uPtr[k + 1] = qu;
    }
    return {
      version: m.patVersion, pr, pc, colStep, aPtr, aFlat, aStep,
      lPtr, lIdx, lRe: new Float64Array(nl), lIm: cx ? new Float64Array(nl) : null,
      uPtr, uIdx, uRe: new Float64Array(nu), uIm: cx ? new Float64Array(nu) : null,
      dRe: new Float64Array(n), dIm: cx ? new Float64Array(n) : null,
    };
  }

  /** Factor the values in a known order (row by row); false when a pivot has grown too small. */
  private numeric(m: Stamped, o: Order, fresh = false): boolean {
    const n = m.n, re = m.re, im = m.im, cx = this.complex;
    if (cx && !o.lIm) return false;
    const wr = this.wr, wi = this.wi;
    const growth = 1 / Math.max(1e-12, this.pivrel * 1e-3);
    for (let i = 0; i < n; i++) {
      for (let q = o.aPtr[i]!; q < o.aPtr[i + 1]!; q++) { const s = o.aStep[q]!, f = o.aFlat[q]!; wr[s] = re[f]!; if (cx) wi[s] = im![f]!; }
      for (let q = o.lPtr[i]!; q < o.lPtr[i + 1]!; q++) {
        const k = o.lIdx[q]!;
        const xr = wr[k]!, xi = cx ? wi[k]! : 0;
        wr[k] = 0; if (cx) wi[k] = 0;
        let lr: number, li = 0;
        if (cx) { const dr = o.dRe[k]!, di = o.dIm![k]!, dd = dr * dr + di * di; lr = (xr * dr + xi * di) / dd; li = (xi * dr - xr * di) / dd; } else lr = xr / o.dRe[k]!;
        o.lRe[q] = lr; if (cx) o.lIm![q] = li;
        if (!fresh && (cx ? Math.hypot(lr, li) : Math.abs(lr)) > growth) { this.clearRow(o, i); return false; }
        if (lr === 0 && li === 0) continue;
        for (let t = o.uPtr[k]!; t < o.uPtr[k + 1]!; t++) {
          const j = o.uIdx[t]!, ur = o.uRe[t]!;
          if (cx) { const ui = o.uIm![t]!; wr[j] -= lr * ur - li * ui; wi[j] -= lr * ui + li * ur; } else wr[j] -= lr * ur;
        }
      }
      const dr = wr[i]!, di = cx ? wi[i]! : 0;
      wr[i] = 0; if (cx) wi[i] = 0;
      o.dRe[i] = dr; if (cx) o.dIm![i] = di;
      for (let t = o.uPtr[i]!; t < o.uPtr[i + 1]!; t++) { const j = o.uIdx[t]!; o.uRe[t] = wr[j]!; wr[j] = 0; if (cx) { o.uIm![t] = wi[j]!; wi[j] = 0; } }
      const dm = cx ? Math.hypot(dr, di) : Math.abs(dr);
      if (!(dm > 1e-300)) { this.clearRow(o, i + 1); return false; }
    }
    return true;
  }
  /** After an abandoned factorisation: the work vector clear again. */
  private clearRow(_o: Order, _from: number): void { this.wr.fill(0); this.wi.fill(0); }

  private sparseSolve(br: Float64Array, bi: Float64Array | null, transposed: boolean): void {
    const o = this.order!, n = this.n, cx = this.complex && !!bi;
    const yr = this.wr, yi = this.wi;
    if (!transposed) {
      for (let i = 0; i < n; i++) { yr[i] = br[o.pr[i]!]!; if (cx) yi[i] = bi![o.pr[i]!]!; }
      for (let i = 0; i < n; i++) {
        let sr = yr[i]!, si = cx ? yi[i]! : 0;
        for (let q = o.lPtr[i]!; q < o.lPtr[i + 1]!; q++) {
          const k = o.lIdx[q]!, lr = o.lRe[q]!;
          if (cx) { const li = o.lIm![q]!; sr -= lr * yr[k]! - li * yi[k]!; si -= lr * yi[k]! + li * yr[k]!; } else sr -= lr * yr[k]!;
        }
        yr[i] = sr; if (cx) yi[i] = si;
      }
      for (let i = n - 1; i >= 0; i--) {
        let sr = yr[i]!, si = cx ? yi[i]! : 0;
        for (let t = o.uPtr[i]!; t < o.uPtr[i + 1]!; t++) {
          const j = o.uIdx[t]!, ur = o.uRe[t]!;
          if (cx) { const ui = o.uIm![t]!; sr -= ur * yr[j]! - ui * yi[j]!; si -= ur * yi[j]! + ui * yr[j]!; } else sr -= ur * yr[j]!;
        }
        if (cx) { const dr = o.dRe[i]!, di = o.dIm![i]!, dd = dr * dr + di * di; yr[i] = (sr * dr + si * di) / dd; yi[i] = (si * dr - sr * di) / dd; } else yr[i] = sr / o.dRe[i]!;
      }
      for (let i = 0; i < n; i++) { br[o.pc[i]!] = yr[i]!; if (cx) bi![o.pc[i]!] = yi[i]!; yr[i] = 0; yi[i] = 0; }
      return;
    }
    // A′ = P A Q = L U, so Aᵀ x = b is Uᵀ Lᵀ (P x) = Qᵀ b
    for (let s = 0; s < n; s++) { yr[s] = br[o.pc[s]!]!; if (cx) yi[s] = bi![o.pc[s]!]!; }
    for (let i = 0; i < n; i++) {
      let sr = yr[i]!, si = cx ? yi[i]! : 0;
      if (cx) { const dr = o.dRe[i]!, di = o.dIm![i]!, dd = dr * dr + di * di; const a = (sr * dr + si * di) / dd; si = (si * dr - sr * di) / dd; sr = a; } else sr /= o.dRe[i]!;
      yr[i] = sr; if (cx) yi[i] = si;
      for (let t = o.uPtr[i]!; t < o.uPtr[i + 1]!; t++) {
        const j = o.uIdx[t]!, ur = o.uRe[t]!;
        if (cx) { const ui = o.uIm![t]!; yr[j] -= ur * sr - ui * si; yi[j] -= ur * si + ui * sr; } else yr[j] -= ur * sr;
      }
    }
    for (let i = n - 1; i >= 0; i--) {
      const sr = yr[i]!, si = cx ? yi[i]! : 0;
      for (let q = o.lPtr[i]!; q < o.lPtr[i + 1]!; q++) {
        const k = o.lIdx[q]!, lr = o.lRe[q]!;
        if (cx) { const li = o.lIm![q]!; yr[k] -= lr * sr - li * si; yi[k] -= lr * si + li * sr; } else yr[k] -= lr * sr;
      }
    }
    for (let i = 0; i < n; i++) { br[o.pr[i]!] = yr[i]!; if (cx) bi![o.pr[i]!] = yi[i]!; yr[i] = 0; yi[i] = 0; }
  }
}

/** Solve A x = b once (dense or sparse as the size says); false when singular. For tests and one-off solves. */
export function solveOnce(m: Stamped, br: Float64Array, bi?: Float64Array): boolean {
  const s = new Solver();
  if (!s.factor(m)) return false;
  s.solve(br, bi);
  return true;
}

/** A stamped matrix from a dense one (every non-zero its pattern). */
export function stampedOf(n: number, re: Float64Array, im: Float64Array | null = null): Stamped {
  const pat: number[] = [];
  for (let f = 0; f < n * n; f++) if (re[f] !== 0 || (im && im[f] !== 0)) pat.push(f);
  return { n, re, im, pat, patVersion: 1 };
}
