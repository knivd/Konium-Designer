/**
 * Eigenvalues for the pole-zero analysis. A circuit's natural frequencies are the s where
 * G + sC is singular (G the conductances and the sources' and controlled sources' constraints, C
 * the capacitances and inductances). C is symmetric and usually singular — nodes with no
 * capacitance, and directions such as a coupling capacitor's common mode — so the unknowns are
 * first split into those C acts on and the rest (C's own eigenvectors, by Jacobi's method), the
 * rest eliminated (a Schur complement), and what remains is an ordinary eigenproblem with no
 * infinite eigenvalues: balanced, reduced to Hessenberg form and solved by Francis's double-shift
 * QR (EISPACK's balanc, elmhes and hqr).
 */

export interface Complex { re: number; im: number }

/** Eigenvalues of a real square matrix (rows); null when QR doesn't converge. */
export function eigenvalues(rows: number[][]): Complex[] | null {
  const n = rows.length;
  if (!n) return [];
  // 1-based working copy, as the algorithms are written
  const a: number[][] = [[]];
  for (let i = 0; i < n; i++) a.push([0, ...rows[i]!]);
  balance(a, n);
  hessenberg(a, n);
  for (let i = 3; i <= n; i++) for (let j = 1; j <= i - 2; j++) a[i]![j] = 0;
  return hqr(a, n);
}

function balance(a: number[][], n: number): void {
  const RADIX = 2, sqrdx = RADIX * RADIX;
  let done = false;
  for (let pass = 0; !done && pass < 100; pass++) {
    done = true;
    for (let i = 1; i <= n; i++) {
      let r = 0, c = 0;
      for (let j = 1; j <= n; j++) if (j !== i) { c += Math.abs(a[j]![i]!); r += Math.abs(a[i]![j]!); }
      if (c !== 0 && r !== 0) {
        let g = r / RADIX, f = 1;
        const s = c + r;
        while (c < g) { f *= RADIX; c *= sqrdx; }
        g = r * RADIX;
        while (c > g) { f /= RADIX; c /= sqrdx; }
        if ((c + r) / f < 0.95 * s) {
          done = false;
          g = 1 / f;
          for (let j = 1; j <= n; j++) a[i]![j]! *= g;
          for (let j = 1; j <= n; j++) a[j]![i]! *= f;
        }
      }
    }
  }
}

function hessenberg(a: number[][], n: number): void {
  for (let m = 2; m < n; m++) {
    let x = 0, i = m;
    for (let j = m; j <= n; j++) if (Math.abs(a[j]![m - 1]!) > Math.abs(x)) { x = a[j]![m - 1]!; i = j; }
    if (i !== m) {
      for (let j = m - 1; j <= n; j++) { const t = a[i]![j]!; a[i]![j] = a[m]![j]!; a[m]![j] = t; }
      for (let j = 1; j <= n; j++) { const t = a[j]![i]!; a[j]![i] = a[j]![m]!; a[j]![m] = t; }
    }
    if (x !== 0) {
      for (let r = m + 1; r <= n; r++) {
        let y = a[r]![m - 1]!;
        if (y !== 0) {
          y /= x;
          a[r]![m - 1] = y;
          for (let j = m; j <= n; j++) a[r]![j]! -= y * a[m]![j]!;
          for (let j = 1; j <= n; j++) a[j]![m]! += y * a[j]![r]!;
        }
      }
    }
  }
}

const sign = (a: number, b: number) => (b >= 0 ? Math.abs(a) : -Math.abs(a));

function hqr(a: number[][], n: number): Complex[] | null {
  const wr = new Array<number>(n + 1).fill(0), wi = new Array<number>(n + 1).fill(0);
  let anorm = 0;
  for (let i = 1; i <= n; i++) for (let j = Math.max(i - 1, 1); j <= n; j++) anorm += Math.abs(a[i]![j]!);
  let nn = n, t = 0;
  let p = 0, q = 0, r = 0, s = 0, w = 0, x = 0, y = 0, z = 0;
  while (nn >= 1) {
    let its = 0, l: number;
    do {
      for (l = nn; l >= 2; l--) {
        s = Math.abs(a[l - 1]![l - 1]!) + Math.abs(a[l]![l]!);
        if (s === 0) s = anorm;
        if (Math.abs(a[l]![l - 1]!) + s === s) { a[l]![l - 1] = 0; break; }
      }
      x = a[nn]![nn]!;
      if (l === nn) { wr[nn] = x + t; wi[nn--] = 0; }
      else {
        y = a[nn - 1]![nn - 1]!;
        w = a[nn]![nn - 1]! * a[nn - 1]![nn]!;
        if (l === nn - 1) {
          p = 0.5 * (y - x);
          q = p * p + w;
          z = Math.sqrt(Math.abs(q));
          x += t;
          if (q >= 0) {
            z = p + sign(z, p);
            wr[nn - 1] = wr[nn] = x + z;
            if (z) wr[nn] = x - w / z;
            wi[nn - 1] = wi[nn] = 0;
          } else {
            wr[nn - 1] = wr[nn] = x + p;
            wi[nn - 1] = -(wi[nn] = z);
          }
          nn -= 2;
        } else {
          if (its === 60) return null;
          if (its === 10 || its === 20 || its === 40) {
            t += x;
            for (let i = 1; i <= nn; i++) a[i]![i]! -= x;
            s = Math.abs(a[nn]![nn - 1]!) + Math.abs(a[nn - 1]![nn - 2]!);
            y = x = 0.75 * s;
            w = -0.4375 * s * s;
          }
          ++its;
          let m: number;
          for (m = nn - 2; m >= l; m--) {
            z = a[m]![m]!;
            r = x - z;
            s = y - z;
            p = (r * s - w) / a[m + 1]![m]! + a[m]![m + 1]!;
            q = a[m + 1]![m + 1]! - z - r - s;
            r = a[m + 2]![m + 1]!;
            s = Math.abs(p) + Math.abs(q) + Math.abs(r);
            p /= s; q /= s; r /= s;
            if (m === l) break;
            const u = Math.abs(a[m]![m - 1]!) * (Math.abs(q) + Math.abs(r));
            const v = Math.abs(p) * (Math.abs(a[m - 1]![m - 1]!) + Math.abs(z) + Math.abs(a[m + 1]![m + 1]!));
            if (u + v === v) break;
          }
          for (let i = m + 2; i <= nn; i++) { a[i]![i - 2] = 0; if (i !== m + 2) a[i]![i - 3] = 0; }
          for (let k = m; k <= nn - 1; k++) {
            if (k !== m) {
              p = a[k]![k - 1]!;
              q = a[k + 1]![k - 1]!;
              r = 0;
              if (k !== nn - 1) r = a[k + 2]![k - 1]!;
              if ((x = Math.abs(p) + Math.abs(q) + Math.abs(r)) !== 0) { p /= x; q /= x; r /= x; }
            }
            if ((s = sign(Math.sqrt(p * p + q * q + r * r), p)) !== 0) {
              if (k === m) { if (l !== m) a[k]![k - 1] = -a[k]![k - 1]!; } else a[k]![k - 1] = -s * x;
              p += s;
              x = p / s; y = q / s; z = r / s; q /= p; r /= p;
              for (let j = k; j <= nn; j++) {
                p = a[k]![j]! + q * a[k + 1]![j]!;
                if (k !== nn - 1) { p += r * a[k + 2]![j]!; a[k + 2]![j]! -= p * z; }
                a[k + 1]![j]! -= p * y;
                a[k]![j]! -= p * x;
              }
              const mmin = nn < k + 3 ? nn : k + 3;
              for (let i = l; i <= mmin; i++) {
                p = x * a[i]![k]! + y * a[i]![k + 1]!;
                if (k !== nn - 1) { p += z * a[i]![k + 2]!; a[i]![k + 2]! -= p * r; }
                a[i]![k + 1]! -= p * q;
                a[i]![k]! -= p;
              }
            }
          }
        }
      }
    } while (l < nn - 1);
  }
  const out: Complex[] = [];
  for (let i = 1; i <= n; i++) out.push({ re: wr[i]!, im: wi[i]! });
  return out;
}

/** A real symmetric matrix's eigenvalues and eigenvectors (columns of vectors), by cyclic Jacobi rotations. */
export function symmetricEigen(c: number[][]): { values: number[]; vectors: number[][] } {
  const n = c.length;
  const a = c.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0, diag = 0;
    for (let i = 0; i < n; i++) { diag += a[i]![i]! * a[i]![i]!; for (let j = i + 1; j < n; j++) off += a[i]![j]! * a[i]![j]!; }
    if (off <= 1e-30 * diag || off === 0) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      const apq = a[p]![q]!;
      if (apq === 0) continue;
      const app = a[p]![p]!, aqq = a[q]![q]!;
      if (Math.abs(apq) < 1e-300) { a[p]![q] = a[q]![p] = 0; continue; }
      const theta = (aqq - app) / (2 * apq);
      const t = sign(1, theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < n; k++) {
        const akp = a[k]![p]!, akq = a[k]![q]!;
        a[k]![p] = cs * akp - sn * akq; a[k]![q] = sn * akp + cs * akq;
      }
      for (let k = 0; k < n; k++) {
        const apk = a[p]![k]!, aqk = a[q]![k]!;
        a[p]![k] = cs * apk - sn * aqk; a[q]![k] = sn * apk + cs * aqk;
      }
      for (let k = 0; k < n; k++) {
        const vkp = v[k]![p]!, vkq = v[k]![q]!;
        v[k]![p] = cs * vkp - sn * vkq; v[k]![q] = sn * vkp + cs * vkq;
      }
    }
  }
  return { values: a.map((r, i) => r[i]!), vectors: v };
}

/** LU factors of a square matrix (partial pivoting); null when singular. */
function luFactor(a0: number[][]): { a: number[][]; perm: number[] } | null {
  const n = a0.length, a = a0.map((r) => [...r]), perm = a.map((_, i) => i);
  for (let k = 0; k < n; k++) {
    let p = k;
    for (let i = k + 1; i < n; i++) if (Math.abs(a[i]![k]!) > Math.abs(a[p]![k]!)) p = i;
    if (Math.abs(a[p]![k]!) < 1e-300) return null;
    if (p !== k) { [a[k], a[p]] = [a[p]!, a[k]!]; [perm[k], perm[p]] = [perm[p]!, perm[k]!]; }
    for (let i = k + 1; i < n; i++) {
      const f = (a[i]![k]! /= a[k]![k]!);
      if (f !== 0) for (let j = k + 1; j < n; j++) a[i]![j]! -= f * a[k]![j]!;
    }
  }
  return { a, perm };
}
function luSolve(f: { a: number[][]; perm: number[] }, b: number[]): number[] {
  const n = b.length, a = f.a, x = f.perm.map((i) => b[i]!);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) x[i]! -= a[i]![j]! * x[j]!;
  for (let i = n - 1; i >= 0; i--) { for (let j = i + 1; j < n; j++) x[i]! -= a[i]![j]! * x[j]!; x[i]! /= a[i]![i]!; }
  return x;
}

/** One-sided Jacobi (Hestenes) SVD: the right singular vectors (columns of v) and the singular values. */
function rightSingular(x: number[][]): { sigma: number[]; v: number[][] } {
  const n = x.length;
  const u = x.map((r) => [...r]);
  const v: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let rotated = false;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      let al = 0, be = 0, ga = 0;
      for (let i = 0; i < n; i++) { const a = u[i]![p]!, b = u[i]![q]!; al += a * a; be += b * b; ga += a * b; }
      if (ga === 0 || Math.abs(ga) <= 1e-15 * Math.sqrt(al * be)) continue;
      rotated = true;
      const zeta = (be - al) / (2 * ga);
      const t = sign(1, zeta) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
      const c = 1 / Math.sqrt(1 + t * t), sn = c * t;
      for (let i = 0; i < n; i++) {
        const a = u[i]![p]!, b = u[i]![q]!; u[i]![p] = c * a - sn * b; u[i]![q] = sn * a + c * b;
        const va = v[i]![p]!, vb = v[i]![q]!; v[i]![p] = c * va - sn * vb; v[i]![q] = sn * va + c * vb;
      }
    }
    if (!rotated) break;
  }
  return { sigma: Array.from({ length: n }, (_, j) => Math.sqrt(u.reduce((sum, r) => sum + r[j]! * r[j]!, 0))), v };
}

/**
 * The finite s at which G + sC is singular (C symmetric: capacitances and inductances).
 * With A = G + s₀C (s₀ a real shift where A is regular), the roots are s = s₀ − 1/ν for the non-zero
 * eigenvalues ν of A⁻¹C. Its zero eigenvalues (the infinite roots: unknowns without capacitance,
 * and constraints among the rest) are taken out exactly first — C's null space, then the null
 * space of what remains, until none is left — so they can't turn into spurious roots.
 */
export function pencilRoots(G: number[][], C: number[][], relTol = 1e-12): Complex[] {
  const n = G.length;
  const Cs = C.map((r, i) => r.map((v, j) => (v + C[j]![i]!) / 2));
  const dyn = Cs.map((r, i) => (r.some((v) => v !== 0) ? i : -1)).filter((i) => i >= 0);
  if (!dyn.length) return [];
  const { values, vectors } = symmetricEigen(dyn.map((i) => dyn.map((j) => Cs[i]![j]!)));
  const big = Math.max(...values.map(Math.abs));
  const keep = values.map((v, k) => (Math.abs(v) > relTol * big ? k : -1)).filter((k) => k >= 0);
  const r = keep.length;
  // C's range: T₁ (n × r), and C·T₁ = T₁·Λ
  const T1 = keep.map((k) => { const col = new Array<number>(n).fill(0); dyn.forEach((i, row) => { col[i] = vectors[row]![k]!; }); return col; });
  const lam = keep.map((k) => values[k]!);
  // The shift: the circuit's own scale (‖G‖ over ‖C‖), on the right half-plane, away from a stable circuit's poles
  const gScale = Math.sqrt(G.reduce((s2, row) => s2 + row.reduce((t, v) => t + v * v, 0), 0) / n) || 1;
  const cScale = lam.reduce((t, v) => t + Math.abs(v), 0) / r;
  let s0 = gScale / cScale;
  let f: ReturnType<typeof luFactor> = null;
  for (let tries = 0; tries < 8 && !f; tries++) {
    f = luFactor(G.map((row, i) => row.map((v, j) => v + s0 * Cs[i]![j]!)));
    if (!f) s0 *= 1.618;
  }
  if (!f) throw new Error('the matrices are singular at every shift tried');
  // X = T₁ᵀ A⁻¹ C T₁ (r × r)
  const W = T1.map((col, k) => luSolve(f!, col.map((v) => v * lam[k]!)));
  let X: number[][] = T1.map((ti) => W.map((wk) => ti.reduce((t, v, i) => t + v * wk[i]!, 0)));
  // Take out null spaces until X is regular
  for (let guard = 0; guard < r && X.length; guard++) {
    const { sigma, v } = rightSingular(X);
    const top = Math.max(...sigma);
    if (!(top > 0)) { X = []; break; }
    const live = sigma.map((sv, j) => (sv > 1e-11 * top ? j : -1)).filter((j) => j >= 0);
    if (live.length === X.length) break;
    const V1 = live.map((j) => v.map((row) => row[j]!));
    const XV = V1.map((col) => X.map((row) => row.reduce((t, x, i) => t + x * col[i]!, 0)));
    X = V1.map((a) => XV.map((xb) => a.reduce((t, x, i) => t + x * xb[i]!, 0)));
  }
  if (!X.length) return [];
  const ev = eigenvalues(X);
  if (!ev) throw new Error("the eigenvalues didn't converge");
  const top = Math.max(...ev.map((e) => Math.hypot(e.re, e.im)));
  // Roots at the origin come out as rounding (a double zero as ±1e-8): nine decades below the scale is zero
  const snap = (v: number) => (Math.abs(v) < 1e-9 * s0 ? 0 : v);
  return ev.filter((e) => Math.hypot(e.re, e.im) > 1e-13 * top).map((e) => {
    const d = e.re * e.re + e.im * e.im;
    return { re: snap(s0 - e.re / d), im: snap(e.im / d) };
  });
}
