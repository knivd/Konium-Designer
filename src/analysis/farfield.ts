/**
 * What an antenna radiates, from the fields on a box drawn round it (the near-to-far-field
 * transform), and the pulse that drives it.
 *
 * As the simulation runs, the tangential E and H on the box's six faces are summed against
 * e^(-j2πft) at each wanted frequency: their spectra there. By the equivalence principle those
 * fields are sheets of electric and magnetic current (J = n × H, M = -n × E) that radiate, in the
 * empty space outside, exactly what the antenna does. Far away, each direction's field is the sum
 * of the sheets' currents with the phase of their place; the power through the box is the
 * antenna's radiated power.
 *
 * Each sample is used where the grid has it: E on the face, H half a cell to either side of it
 * (brought onto the face by weighing the two) and half a time step later (allowed for in the
 * phase). [checked] a short dipole's and a half-wave dipole's directivity (tests/antenna178.test.ts).
 */
import { ETA0, C0, type Fdtd } from './fdtd';

/** A pulse of a carrier under a Gaussian: flat to about -20 dB over `fc` ± `bw` / 2, nothing at DC. */
export function pulse(fc: number, bw: number): { at(t: number): number; length: number } {
  const tau = 0.966 / bw, t0 = 4.5 * tau;
  return { at: (t) => Math.exp(-(((t - t0) / tau) ** 2)) * Math.sin(2 * Math.PI * fc * (t - t0)), length: 2 * t0 };
}

/** A record's spectrum at one frequency: the sum that stands for Fourier's integral (samples `dt` apart from `t0`). */
export function spectrum(v: ArrayLike<number>, dt: number, f: number, t0 = 0): [number, number] {
  let re = 0, im = 0;
  const w = 2 * Math.PI * f * dt, a0 = 2 * Math.PI * f * t0;
  for (let n = 0; n < v.length; n++) { const a = a0 + n * w; re += v[n]! * Math.cos(a); im -= v[n]! * Math.sin(a); }
  return [re * dt, im * dt];
}

/** One face of the box: its normal's axis and sense, its plane, and the spectra on its two sets of points. */
interface Face {
  a: 0 | 1 | 2; b: 0 | 1 | 2; c: 0 | 1 | 2; sign: 1 | -1; plane: number;
  /** Points at (b + ½, c): E_b and H_c. Points at (b, c + ½): E_c and H_b. Complex, per frequency. */
  eb: Float64Array[]; hc: Float64Array[]; ec: Float64Array[]; hb: Float64Array[];
}

export interface Pattern {
  /** Polar angles from +z and azimuths from +x, radians. */
  theta: Float64Array; phi: Float64Array;
  /** Radiation intensity in each direction, W/sr (theta outer, phi inner), and its two polarisations' shares. */
  u: Float64Array; uTheta: Float64Array; uPhi: Float64Array;
  /** The intensity summed over the sphere, W: the radiated power as the far field has it. */
  power: number;
  /** The largest directivity and where. */
  peak: number; peakTheta: number; peakPhi: number;
}

export class HuygensBox {
  readonly faces: Face[] = [];
  private samples = 0;
  /** `lo` and `hi` are the box's node planes along x, y and z; `every` how many steps apart the fields are sampled. */
  constructor(readonly sim: Fdtd, readonly lo: [number, number, number], readonly hi: [number, number, number], readonly freqs: number[], readonly every = 1) {
    for (const a of [0, 1, 2] as const) {
      const b = ((a + 1) % 3) as 0 | 1 | 2, c = ((a + 2) % 3) as 0 | 1 | 2;
      const nb = hi[b] - lo[b], nc = hi[c] - lo[c];
      for (const sign of [-1, 1] as const) {
        const mk = (n: number) => freqs.map(() => new Float64Array(2 * n));
        this.faces.push({ a, b, c, sign, plane: sign < 0 ? lo[a] : hi[a], eb: mk(nb * (nc + 1)), hc: mk(nb * (nc + 1)), ec: mk((nb + 1) * nc), hb: mk((nb + 1) * nc) });
      }
    }
  }

  /** Call after every step of the simulation: on the steps it samples, the faces' fields are added to their spectra. */
  sample(): void {
    const sim = this.sim;
    if (sim.step % this.every) return;
    this.samples++;
    const E = [sim.ex, sim.ey, sim.ez], H = [sim.hx, sim.hy, sim.hz], st = [1, sim.sx, sim.sx * sim.sy];
    const coords = [sim.setup.x, sim.setup.y, sim.setup.z];
    const tE = sim.step * sim.dt, tH = (sim.step - 0.5) * sim.dt, w = this.every * sim.dt;
    for (let q = 0; q < this.freqs.length; q++) {
      const om = 2 * Math.PI * this.freqs[q]!;
      const ceR = Math.cos(om * tE) * w, ceI = -Math.sin(om * tE) * w, chR = Math.cos(om * tH) * w, chI = -Math.sin(om * tH) * w;
      for (const f of this.faces) {
        const { a, b, c } = f, I = f.plane, xa = coords[a]!;
        // H stands half a cell to either side of the face: weighed by the other side's half cell
        const dm = xa[I]! - xa[I - 1]!, dp = xa[I + 1]! - xa[I]!, wm = dp / (dm + dp), wp = dm / (dm + dp);
        const sa = st[a]!, sb = st[b]!, sc = st[c]!, base = I * sa;
        const nb = this.hi[b] - this.lo[b], nc = this.hi[c] - this.lo[c], b0 = this.lo[b], c0 = this.lo[c];
        const Eb = E[b]!, Ec = E[c]!, Hb = H[b]!, Hc = H[c]!;
        const eb = f.eb[q]!, hc = f.hc[q]!, ec = f.ec[q]!, hb = f.hb[q]!;
        for (let ic = 0; ic <= nc; ic++) for (let ib = 0; ib < nb; ib++) {
          const id = base + (b0 + ib) * sb + (c0 + ic) * sc, m = 2 * (ib + nb * ic);
          const e = Eb[id]!, h = wm * Hc[id - sa]! + wp * Hc[id]!;
          eb[m] += e * ceR; eb[m + 1] += e * ceI; hc[m] += h * chR; hc[m + 1] += h * chI;
        }
        for (let ic = 0; ic < nc; ic++) for (let ib = 0; ib <= nb; ib++) {
          const id = base + (b0 + ib) * sb + (c0 + ic) * sc, m = 2 * (ib + (nb + 1) * ic);
          const e = Ec[id]!, h = wm * Hb[id - sa]! + wp * Hb[id]!;
          ec[m] += e * ceR; ec[m + 1] += e * ceI; hb[m] += h * chR; hb[m + 1] += h * chI;
        }
      }
    }
  }

  /** The widths that go with a row of points: whole cells between the box's planes, or half cells either side of a plane (cut at the box). */
  private widths(axis: 0 | 1 | 2): { half: Float64Array; node: Float64Array; halfAt: Float64Array; nodeAt: Float64Array } {
    const x = [this.sim.setup.x, this.sim.setup.y, this.sim.setup.z][axis]!, lo = this.lo[axis], n = this.hi[axis] - lo;
    const half = new Float64Array(n), halfAt = new Float64Array(n), node = new Float64Array(n + 1), nodeAt = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { half[i] = x[lo + i + 1]! - x[lo + i]!; halfAt[i] = (x[lo + i + 1]! + x[lo + i]!) / 2; }
    for (let i = 0; i <= n; i++) { node[i] = ((i > 0 ? half[i - 1]! : 0) + (i < n ? half[i]! : 0)) / 2; nodeAt[i] = x[lo + i]!; }
    return { half, node, halfAt, nodeAt };
  }

  /** The power leaving the box at frequency `q` (W, for the spectrum the drive had): the real part of E × H* through its faces. */
  power(q: number): number {
    let p = 0;
    for (const f of this.faces) {
      const wb = this.widths(f.b), wc = this.widths(f.c), nb = wb.half.length, nc = wc.half.length;
      const eb = f.eb[q]!, hc = f.hc[q]!, ec = f.ec[q]!, hb = f.hb[q]!;
      let s = 0;
      for (let ic = 0; ic <= nc; ic++) for (let ib = 0; ib < nb; ib++) { const m = 2 * (ib + nb * ic); s += (eb[m]! * hc[m]! + eb[m + 1]! * hc[m + 1]!) * wb.half[ib]! * wc.node[ic]!; }
      for (let ic = 0; ic < nc; ic++) for (let ib = 0; ib <= nb; ib++) { const m = 2 * (ib + (nb + 1) * ic); s -= (ec[m]! * hb[m]! + ec[m + 1]! * hb[m + 1]!) * wb.node[ib]! * wc.half[ic]!; }
      p += 0.5 * f.sign * s;
    }
    return p;
  }

  /** The far field at frequency `q` over a grid of directions `step` degrees apart. */
  pattern(q: number, step = 5): Pattern {
    const nt = Math.round(180 / step) + 1, np = Math.round(360 / step);
    const theta = Float64Array.from({ length: nt }, (_, i) => (i * Math.PI) / (nt - 1)), phi = Float64Array.from({ length: np }, (_, i) => (i * 2 * Math.PI) / np);
    const u = new Float64Array(nt * np), uTheta = new Float64Array(nt * np), uPhi = new Float64Array(nt * np);
    const k = (2 * Math.PI * this.freqs[q]!) / C0;
    const coords = [this.sim.setup.x, this.sim.setup.y, this.sim.setup.z];
    const prep = this.faces.map((f) => ({ f, wb: this.widths(f.b), wc: this.widths(f.c), at: coords[f.a]![f.plane]! }));
    // A row of points' phases along one axis for a direction's cosine
    const phases = (at: Float64Array, cosine: number) => { const o = new Float64Array(2 * at.length); for (let i = 0; i < at.length; i++) { const a = k * at[i]! * cosine; o[2 * i] = Math.cos(a); o[2 * i + 1] = Math.sin(a); } return o; };
    for (let it = 0; it < nt; it++) for (let ip = 0; ip < np; ip++) {
      const th = theta[it]!, ph = phi[ip]!, st = Math.sin(th), ct = Math.cos(th), sp = Math.sin(ph), cp = Math.cos(ph);
      const dir = [st * cp, st * sp, ct];
      // The currents' sums: N from J, L from M (three components each, complex)
      const N = new Float64Array(6), L = new Float64Array(6);
      for (const { f, wb, wc, at } of prep) {
        const { b, c, sign } = f, nb = wb.half.length, nc = wc.half.length;
        const pa = k * at * dir[f.a]!, paR = Math.cos(pa), paI = Math.sin(pa);
        const pbH = phases(wb.halfAt, dir[b]!), pbN = phases(wb.nodeAt, dir[b]!), pcH = phases(wc.halfAt, dir[c]!), pcN = phases(wc.nodeAt, dir[c]!);
        const eb = f.eb[q]!, hc = f.hc[q]!, ec = f.ec[q]!, hb = f.hb[q]!;
        // Points (b + ½, c): J_b = -sign H_c, M_c = -sign E_b
        let jbR = 0, jbI = 0, mcR = 0, mcI = 0;
        for (let ic = 0; ic <= nc; ic++) {
          const cR = pcN[2 * ic]!, cI = pcN[2 * ic + 1]!, wcn = wc.node[ic]!;
          for (let ib = 0; ib < nb; ib++) {
            const m = 2 * (ib + nb * ic), bR = pbH[2 * ib]!, bI = pbH[2 * ib + 1]!, area = wb.half[ib]! * wcn;
            const pR = (bR * cR - bI * cI) * area, pI = (bR * cI + bI * cR) * area;
            jbR += hc[m]! * pR - hc[m + 1]! * pI; jbI += hc[m]! * pI + hc[m + 1]! * pR;
            mcR += eb[m]! * pR - eb[m + 1]! * pI; mcI += eb[m]! * pI + eb[m + 1]! * pR;
          }
        }
        // Points (b, c + ½): J_c = sign H_b, M_b = sign E_c
        let jcR = 0, jcI = 0, mbR = 0, mbI = 0;
        for (let ic = 0; ic < nc; ic++) {
          const cR = pcH[2 * ic]!, cI = pcH[2 * ic + 1]!, wch = wc.half[ic]!;
          for (let ib = 0; ib <= nb; ib++) {
            const m = 2 * (ib + (nb + 1) * ic), bR = pbN[2 * ib]!, bI = pbN[2 * ib + 1]!, area = wb.node[ib]! * wch;
            const pR = (bR * cR - bI * cI) * area, pI = (bR * cI + bI * cR) * area;
            jcR += hb[m]! * pR - hb[m + 1]! * pI; jcI += hb[m]! * pI + hb[m + 1]! * pR;
            mbR += ec[m]! * pR - ec[m + 1]! * pI; mbI += ec[m]! * pI + ec[m + 1]! * pR;
          }
        }
        // The face's own phase, and its sense
        const add = (to: Float64Array, axis: number, re: number, im: number, s: number) => { to[2 * axis] += s * (re * paR - im * paI); to[2 * axis + 1] += s * (re * paI + im * paR); };
        add(N, b, jbR, jbI, -sign); add(N, c, jcR, jcI, sign);
        add(L, c, mcR, mcI, -sign); add(L, b, mbR, mbI, sign);
      }
      const comp = (V: Float64Array, part: 0 | 1) => {
        const x = V[part]!, y = V[2 + part]!, z = V[4 + part]!;
        return [x * ct * cp + y * ct * sp - z * st, -x * sp + y * cp];
      };
      const [ntR, npR] = comp(N, 0), [ntI, npI] = comp(N, 1), [ltR, lpR] = comp(L, 0), [ltI, lpI] = comp(L, 1);
      const scale = (k * k) / (32 * Math.PI * Math.PI * ETA0);
      const tR = lpR! + ETA0 * ntR!, tI = lpI! + ETA0 * ntI!, pR = ltR! - ETA0 * npR!, pI = ltI! - ETA0 * npI!;
      const i = it * np + ip;
      uTheta[i] = scale * (tR * tR + tI * tI); uPhi[i] = scale * (pR * pR + pI * pI); u[i] = uTheta[i]! + uPhi[i]!;
    }
    // Over the sphere: each row of directions has a band of it
    let power = 0, top = 0, ti = 0;
    for (let it = 0; it < nt; it++) {
      const a = Math.max(0, theta[it]! - Math.PI / (2 * (nt - 1))), b = Math.min(Math.PI, theta[it]! + Math.PI / (2 * (nt - 1)));
      const band = ((Math.cos(a) - Math.cos(b)) * 2 * Math.PI) / np;
      for (let ip = 0; ip < np; ip++) { const v = u[it * np + ip]!; power += v * band; if (v > top) { top = v; ti = it * np + ip; } }
    }
    return { theta, phi, u, uTheta, uPhi, power, peak: (4 * Math.PI * top) / power, peakTheta: theta[Math.floor(ti / np)]!, peakPhi: phi[ti % np]! };
  }
}
