/**
 * Complex symmetric banded equations, solved by an LDLᵀ factoring kept within the band: the
 * admittance equations of a supply's planes at one frequency (analysis/pdn.ts). The matrix is
 * symmetric, not Hermitian: a network of admittances between nodes and to ground.
 */
export class CBand {
  /** Row i holds columns i − band … i (the lower band), real and imaginary. */
  private re: Float64Array; private im: Float64Array;
  private dRe: Float64Array; private dIm: Float64Array;
  private readonly w: number;
  constructor(readonly n: number, readonly band: number) {
    this.w = band + 1;
    this.re = new Float64Array(n * this.w); this.im = new Float64Array(n * this.w);
    this.dRe = new Float64Array(n); this.dIm = new Float64Array(n);
  }
  clear(): void { this.re.fill(0); this.im.fill(0); }
  /** Adds to the element (i, j) (and so to (j, i)); |i − j| must be within the band. */
  add(i: number, j: number, re: number, im: number): void {
    if (i < j) { const t = i; i = j; j = t; }
    const at = i * this.w + (j - i + this.band);
    this.re[at]! += re; this.im[at]! += im;
  }
  /** An admittance y between nodes a and b (b < 0: between a and ground). */
  admittance(a: number, b: number, re: number, im: number): void {
    this.add(a, a, re, im);
    if (b < 0) return;
    this.add(b, b, re, im); this.add(a, b, -re, -im);
  }
  /** Factors in place: after it, the band holds L (unit lower) and d the diagonal. False when a pivot is zero. */
  factor(): boolean {
    const { n, band, w, re, im, dRe, dIm } = this;
    // l(i, k)·d(k) kept for the row in hand, to save multiplying twice
    const tRe = new Float64Array(w), tIm = new Float64Array(w);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - band), row = i * w + band - i;
      for (let j = lo; j <= i; j++) {
        // a(i, j) − Σ l(i, k)·d(k)·l(j, k) over k from max(lo, j − band) to j − 1
        let sr = re[row + j]!, si = im[row + j]!;
        const rj = j * w + band - j;
        for (let k = Math.max(lo, j - band); k < j; k++) {
          const ar = tRe[k - lo]!, ai = tIm[k - lo]!, br = re[rj + k]!, bi = im[rj + k]!;
          sr -= ar * br - ai * bi; si -= ar * bi + ai * br;
        }
        if (j === i) { dRe[i] = sr; dIm[i] = si; if (sr === 0 && si === 0) return false; }
        else {
          // l(i, j) = s / d(j); and its product with d(j) is s itself
          tRe[j - lo] = sr; tIm[j - lo] = si;
          const dr = dRe[j]!, di = dIm[j]!, m = dr * dr + di * di;
          re[row + j] = (sr * dr + si * di) / m; im[row + j] = (si * dr - sr * di) / m;
        }
      }
    }
    return true;
  }
  /** Solves for a right-hand side, in place (after factor). */
  solve(bRe: Float64Array, bIm: Float64Array): void {
    const { n, band, w, re, im, dRe, dIm } = this;
    for (let i = 0; i < n; i++) {
      let sr = bRe[i]!, si = bIm[i]!;
      const row = i * w + band - i;
      for (let k = Math.max(0, i - band); k < i; k++) { const lr = re[row + k]!, li = im[row + k]!; sr -= lr * bRe[k]! - li * bIm[k]!; si -= lr * bIm[k]! + li * bRe[k]!; }
      bRe[i] = sr; bIm[i] = si;
    }
    for (let i = 0; i < n; i++) { const dr = dRe[i]!, di = dIm[i]!, m = dr * dr + di * di, sr = bRe[i]!, si = bIm[i]!; bRe[i] = (sr * dr + si * di) / m; bIm[i] = (si * dr - sr * di) / m; }
    for (let i = n - 1; i >= 0; i--) {
      const xr = bRe[i]!, xi = bIm[i]!, row = i * w + band - i;
      for (let k = Math.max(0, i - band); k < i; k++) { const lr = re[row + k]!, li = im[row + k]!; bRe[k]! -= lr * xr - li * xi; bIm[k]! -= lr * xi + li * xr; }
    }
  }
}
