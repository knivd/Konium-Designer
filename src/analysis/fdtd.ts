/**
 * Maxwell's equations stepped in time on a Yee grid (FDTD): the reference the antenna analysis is
 * checked against, and what runs where there is no WebGPU.
 *
 * The grid is rectilinear with its own spacing along each axis (fine about the copper, coarse in the
 * air). E lies on the cells' edges, H on their faces, half a step apart in time. A cell has a
 * permittivity and a conductivity; an edge takes those of the four cells round it, by their share of
 * its cross-section. A perfect conductor is a set of edges whose E stays zero. The outer wall is a
 * conductor; with `pml` cells of absorber (CPML, Roden and Gedney's convolutional form, stretched in
 * the complex frequency plane so that it also takes in the fields that do not travel) inside it, the
 * space behaves as open.
 *
 * A port is a straight run of edges that is a resistor in series with a source: its conductivity
 * makes the resistance, the source is an impressed field. Its voltage and current are read each step.
 *
 * [checked] against a cavity's resonances, a dipole's impedance and pattern and a patch's resonance
 * (tests/antenna178.test.ts). Units: metres, seconds, volts, amperes.
 */
export const C0 = 299792458, MU0 = 4e-7 * Math.PI, EPS0 = 1 / (MU0 * C0 * C0), ETA0 = MU0 * C0;

export interface PortSetup {
  /** The run's direction (0 x, 1 y, 2 z), its first edge's node, how many edges, and its resistance in ohms. */
  axis: 0 | 1 | 2; i: number; j: number; k: number; n: number; r: number;
}

export interface FdtdSetup {
  /** The grid's planes along each axis (metres, ascending): nx + 1, ny + 1 and nz + 1 of them. */
  x: Float64Array; y: Float64Array; z: Float64Array;
  /** Each cell's relative permittivity and conductivity in S/m (i fastest, then j, then k); air where absent. */
  eps?: Float32Array; sigma?: Float32Array;
  /** Perfectly conducting edges: indices into the Ex, Ey and Ez arrays (see `Fdtd.at`). */
  pecX?: ArrayLike<number>; pecY?: ArrayLike<number>; pecZ?: ArrayLike<number>;
  /** Cells of absorber inside each wall (0: the walls reflect). The cells there are taken to be of one size. */
  pml?: number;
  ports?: PortSetup[];
  /** The time step as a share of the largest stable one (default 0.99). */
  courant?: number;
}

interface Port { axis: 0 | 1 | 2; edges: Int32Array; len: Float64Array; drive: Float32Array; length: number; r: number }

/** The three slabs of absorber along one axis: which planes they hold and where their memory is. */
interface Slab { lo: number; hi: number; off: number }

export class Fdtd {
  readonly nx: number; readonly ny: number; readonly nz: number;
  readonly sx: number; readonly sy: number; readonly sz: number;
  readonly dt: number;
  readonly ex: Float32Array; readonly ey: Float32Array; readonly ez: Float32Array;
  readonly hx: Float32Array; readonly hy: Float32Array; readonly hz: Float32Array;
  /** E's coefficients on each edge: what is kept of the old value, and what the curl of H adds. */
  readonly cax: Float32Array; readonly cbx: Float32Array; readonly cay: Float32Array; readonly cby: Float32Array; readonly caz: Float32Array; readonly cbz: Float32Array;
  /** One over the cells' sizes (for H) and over the distances between cell centres (for E). */
  readonly idx: Float32Array; readonly idy: Float32Array; readonly idz: Float32Array;
  readonly idxd: Float32Array; readonly idyd: Float32Array; readonly idzd: Float32Array;
  readonly pml: number;
  /** The absorber's memory terms (b, c) at the planes of E and of H along each axis. */
  readonly be: Float32Array[]; readonly ce: Float32Array[]; readonly bh: Float32Array[]; readonly ch: Float32Array[];
  private psiE: Float32Array[] = []; private psiH: Float32Array[] = [];
  readonly ports: Port[] = [];
  /** Steps taken. E is at step × dt, H half a step later. */
  step = 0;

  constructor(readonly setup: FdtdSetup) {
    const { x, y, z } = setup;
    const nx = this.nx = x.length - 1, ny = this.ny = y.length - 1, nz = this.nz = z.length - 1;
    const sx = this.sx = nx + 1, sy = this.sy = ny + 1, sz = this.sz = nz + 1, N = sx * sy * sz;
    const d = (a: Float64Array) => Float64Array.from({ length: a.length - 1 }, (_, i) => a[i + 1]! - a[i]!);
    const dx = d(x), dy = d(y), dz = d(z);
    const min = (a: Float64Array) => a.reduce((m, v) => Math.min(m, v), Infinity);
    this.dt = (setup.courant ?? 0.99) / (C0 * Math.sqrt(1 / min(dx) ** 2 + 1 / min(dy) ** 2 + 1 / min(dz) ** 2));
    const dt = this.dt;
    const inv = (a: Float64Array) => Float32Array.from(a, (v) => 1 / v);
    // Between cell centres; the walls' planes are never used (E along a wall stays zero)
    const dual = (a: Float64Array) => Float32Array.from({ length: a.length + 1 }, (_, i) => (i === 0 || i === a.length ? 0 : 2 / (a[i - 1]! + a[i]!)));
    this.idx = inv(dx); this.idy = inv(dy); this.idz = inv(dz);
    this.idxd = dual(dx); this.idyd = dual(dy); this.idzd = dual(dz);
    const f = () => new Float32Array(N);
    this.ex = f(); this.ey = f(); this.ez = f(); this.hx = f(); this.hy = f(); this.hz = f();
    this.cax = f(); this.cbx = f(); this.cay = f(); this.cby = f(); this.caz = f(); this.cbz = f();

    // Each edge's permittivity and conductivity: the four cells round it, by their share of its cross-section
    const eps = setup.eps, sig = setup.sigma;
    const cell = (i: number, j: number, k: number) => i + nx * (j + ny * k);
    const edge = (ca: Float32Array, cb: Float32Array, id: number, cells: [number, number][]) => {
      let w = 0, e = 0, s = 0;
      for (const [c, a] of cells) { w += a; e += a * (eps ? eps[c]! : 1); s += a * (sig ? sig[c]! : 0); }
      e = (e / w) * EPS0; s /= w;
      const q = (s * dt) / (2 * e);
      ca[id] = (1 - q) / (1 + q); cb[id] = dt / e / (1 + q);
    };
    const air = dt / EPS0;
    if (!eps && !sig) {
      // Nothing but air: the same on every edge the walls leave free
      for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
        const id = i + sx * (j + sy * k);
        if (i < nx && j > 0 && j < ny && k > 0 && k < nz) { this.cax[id] = 1; this.cbx[id] = air; }
        if (j < ny && i > 0 && i < nx && k > 0 && k < nz) { this.cay[id] = 1; this.cby[id] = air; }
        if (k < nz && i > 0 && i < nx && j > 0 && j < ny) { this.caz[id] = 1; this.cbz[id] = air; }
      }
    } else {
      for (let k = 0; k < sz; k++) for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) {
        const id = i + sx * (j + sy * k);
        if (i < nx && j > 0 && j < ny && k > 0 && k < nz)
          edge(this.cax, this.cbx, id, [[cell(i, j - 1, k - 1), dy[j - 1]! * dz[k - 1]!], [cell(i, j, k - 1), dy[j]! * dz[k - 1]!], [cell(i, j - 1, k), dy[j - 1]! * dz[k]!], [cell(i, j, k), dy[j]! * dz[k]!]]);
        if (j < ny && i > 0 && i < nx && k > 0 && k < nz)
          edge(this.cay, this.cby, id, [[cell(i - 1, j, k - 1), dx[i - 1]! * dz[k - 1]!], [cell(i, j, k - 1), dx[i]! * dz[k - 1]!], [cell(i - 1, j, k), dx[i - 1]! * dz[k]!], [cell(i, j, k), dx[i]! * dz[k]!]]);
        if (k < nz && i > 0 && i < nx && j > 0 && j < ny)
          edge(this.caz, this.cbz, id, [[cell(i - 1, j - 1, k), dx[i - 1]! * dy[j - 1]!], [cell(i, j - 1, k), dx[i]! * dy[j - 1]!], [cell(i - 1, j, k), dx[i - 1]! * dy[j]!], [cell(i, j, k), dx[i]! * dy[j]!]]);
      }
    }

    // Ports: a resistor of conductivity length / (R × cross-section) with a source in series
    for (const p of setup.ports ?? []) {
      const step = p.axis === 0 ? 1 : p.axis === 1 ? sx : sx * sy;
      const ca = [this.cax, this.cay, this.caz][p.axis]!, cb = [this.cbx, this.cby, this.cbz][p.axis]!;
      const along = [dx, dy, dz][p.axis]!, first = [p.i, p.j, p.k][p.axis]!;
      const len = Float64Array.from({ length: p.n }, (_, m) => along[first + m]!);
      const length = len.reduce((a, b) => a + b, 0);
      const area = p.axis === 0 ? 1 / (this.idyd[p.j]! * this.idzd[p.k]!) : p.axis === 1 ? 1 / (this.idxd[p.i]! * this.idzd[p.k]!) : 1 / (this.idxd[p.i]! * this.idyd[p.j]!);
      const sigma = length / (p.r * area);
      const edges = new Int32Array(p.n), drive = new Float32Array(p.n);
      for (let m = 0; m < p.n; m++) {
        const id = this.at(p.i, p.j, p.k) + m * step;
        // The edge's permittivity and loss back from its coefficients; the port's conductivity is added to what the cells have
        const e = cb[id]! > 0 ? (dt / cb[id]!) * ((1 + ca[id]!) / 2) : EPS0;
        const q = (cb[id]! > 0 ? (1 - ca[id]!) / (1 + ca[id]!) : 0) + (sigma * dt) / (2 * e);
        ca[id] = (1 - q) / (1 + q); cb[id] = dt / e / (1 + q);
        edges[m] = id; drive[m] = (cb[id]! * sigma) / length;
      }
      this.ports.push({ axis: p.axis, edges, len, drive, length, r: p.r });
    }

    // Perfect conductors last: nothing moves the field on their edges
    for (const [list, ca, cb] of [[setup.pecX, this.cax, this.cbx], [setup.pecY, this.cay, this.cby], [setup.pecZ, this.caz, this.cbz]] as const) {
      if (list) for (let n = 0; n < list.length; n++) { ca[list[n]!] = 0; cb[list[n]!] = 0; }
    }

    // The absorber: conductivity rising as the cube of the depth, the shift falling to nothing at the wall
    const P = this.pml = Math.max(0, Math.min(setup.pml ?? 0, Math.floor(Math.min(nx, ny, nz) / 2) - 1));
    this.be = []; this.ce = []; this.bh = []; this.ch = [];
    for (const a of [x, y, z]) {
      const n = a.length - 1;
      const be = new Float32Array(n + 1).fill(1), ce = new Float32Array(n + 1), bh = new Float32Array(n).fill(1), ch = new Float32Array(n);
      if (P > 0) {
        const lo = a[P]!, hi = a[n - P]!, dLo = lo - a[0]!, dHi = a[n]! - hi;
        const coef = (u: number): [number, number] => {
          const depth = u < lo ? (lo - u) / dLo : u > hi ? (u - hi) / dHi : 0;
          if (depth <= 0) return [1, 0];
          const cellSize = (u < lo ? dLo : dHi) / P;
          const sigma = ((0.8 * 4) / (ETA0 * cellSize)) * depth ** 3, alpha = 0.05 * (1 - depth);
          const b = Math.exp((-(sigma + alpha) * dt) / EPS0);
          return [b, (sigma / (sigma + alpha)) * (b - 1)];
        };
        for (let i = 0; i <= n; i++) [be[i], ce[i]] = coef(a[i]!);
        for (let i = 0; i < n; i++) [bh[i], ch[i]] = coef((a[i]! + a[i + 1]!) / 2);
      }
      this.be.push(be); this.ce.push(ce); this.bh.push(bh); this.ch.push(ch);
    }
    if (P > 0) {
      // Two memory terms for each axis and field: kept only in that axis's two slabs
      const size = [2 * P * sy * sz, sx * 2 * P * sz, sx * sy * 2 * P];
      for (let a = 0; a < 3; a++) { this.psiE.push(new Float32Array(size[a]!), new Float32Array(size[a]!)); this.psiH.push(new Float32Array(size[a]!), new Float32Array(size[a]!)); }
    }
  }

  /** The index of node (i, j, k) in the field arrays. */
  at(i: number, j: number, k: number): number { return i + this.sx * (j + this.sy * k); }

  /** A port's voltage (its far end above its near end) now. */
  portV(p: number): number {
    const port = this.ports[p]!, e = [this.ex, this.ey, this.ez][port.axis]!;
    let v = 0;
    for (let m = 0; m < port.edges.length; m++) v -= e[port.edges[m]!]! * port.len[m]!;
    return v;
  }
  /** The current the port's source sends out of its far end, for a source voltage `vs` now. */
  portI(p: number, vs: number): number { return (vs - this.portV(p)) / this.ports[p]!.r; }

  /** One step: H from E, then E from H with each port's source voltage (at the half step) driving it. */
  advance(vs: ArrayLike<number> = []): void {
    this.stepH();
    this.stepE(vs);
    this.step++;
  }

  private slabs(n: number, forE: boolean): Slab[] {
    const P = this.pml;
    // H's planes 0 … P − 1 and n − P … n − 1; E's 1 … P and n − P … n − 1
    return forE ? [{ lo: 1, hi: P + 1, off: -1 }, { lo: n - P, hi: n, off: P - (n - P) }] : [{ lo: 0, hi: P, off: 0 }, { lo: n - P, hi: n, off: P - (n - P) }];
  }

  private stepH(): void {
    const { nx, ny, nz, sx, sy, ex, ey, ez, hx, hy, hz, idx, idy, idz } = this;
    const sxy = sx * sy, c = this.dt / MU0;
    for (let k = 0; k < nz; k++) {
      const dzk = idz[k]!;
      for (let j = 0; j < ny; j++) {
        const dyj = idy[j]!, row = sx * (j + sy * k);
        for (let i = 0; i < nx; i++) {
          const id = row + i, dxi = idx[i]!;
          const exv = ex[id]!, eyv = ey[id]!, ezv = ez[id]!;
          hx[id] -= c * ((ez[id + sx]! - ezv) * dyj - (ey[id + sxy]! - eyv) * dzk);
          hy[id] -= c * ((ex[id + sxy]! - exv) * dzk - (ez[id + 1]! - ezv) * dxi);
          hz[id] -= c * ((ey[id + 1]! - eyv) * dxi - (ex[id + sx]! - exv) * dyj);
        }
      }
    }
    if (!this.pml) return;
    const P2 = 2 * this.pml;
    // Along x: Hy takes in dEz/dx, Hz dEy/dx
    {
      const b = this.bh[0]!, ch = this.ch[0]!, p0 = this.psiH[0]!, p1 = this.psiH[1]!;
      for (const s of this.slabs(nx, false)) for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = s.lo; i < s.hi; i++) {
        const id = i + sx * (j + sy * k), m = i + s.off + P2 * (j + sy * k), bi = b[i]!, ci = ch[i]! * idx[i]!;
        const a0 = p0[m] = bi * p0[m]! + ci * (ez[id + 1]! - ez[id]!);
        const a1 = p1[m] = bi * p1[m]! + ci * (ey[id + 1]! - ey[id]!);
        hy[id] += c * a0; hz[id] -= c * a1;
      }
    }
    // Along y: Hx takes in dEz/dy, Hz dEx/dy
    {
      const b = this.bh[1]!, ch = this.ch[1]!, p0 = this.psiH[2]!, p1 = this.psiH[3]!;
      for (const s of this.slabs(ny, false)) for (let k = 0; k < nz; k++) for (let j = s.lo; j < s.hi; j++) {
        const bj = b[j]!, cj = ch[j]! * idy[j]!;
        for (let i = 0; i < nx; i++) {
          const id = i + sx * (j + sy * k), m = i + sx * (j + s.off + P2 * k);
          const a0 = p0[m] = bj * p0[m]! + cj * (ez[id + sx]! - ez[id]!);
          const a1 = p1[m] = bj * p1[m]! + cj * (ex[id + sx]! - ex[id]!);
          hx[id] -= c * a0; hz[id] += c * a1;
        }
      }
    }
    // Along z: Hx takes in dEy/dz, Hy dEx/dz
    {
      const b = this.bh[2]!, ch = this.ch[2]!, p0 = this.psiH[4]!, p1 = this.psiH[5]!;
      for (const s of this.slabs(nz, false)) for (let k = s.lo; k < s.hi; k++) {
        const bk = b[k]!, ck = ch[k]! * idz[k]!;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
          const id = i + sx * (j + sy * k), m = i + sx * (j + sy * (k + s.off));
          const a0 = p0[m] = bk * p0[m]! + ck * (ey[id + sxy]! - ey[id]!);
          const a1 = p1[m] = bk * p1[m]! + ck * (ex[id + sxy]! - ex[id]!);
          hx[id] += c * a0; hy[id] -= c * a1;
        }
      }
    }
  }

  private stepE(vs: ArrayLike<number>): void {
    const { nx, ny, nz, sx, sy, ex, ey, ez, hx, hy, hz, idxd, idyd, idzd, cax, cbx, cay, cby, caz, cbz } = this;
    const sxy = sx * sy;
    for (let k = 1; k < nz; k++) {
      const dzk = idzd[k]!;
      for (let j = 1; j < ny; j++) {
        const dyj = idyd[j]!, row = sx * (j + sy * k);
        for (let i = 0; i < nx; i++) {
          const id = row + i;
          ex[id] = cax[id]! * ex[id]! + cbx[id]! * ((hz[id]! - hz[id - sx]!) * dyj - (hy[id]! - hy[id - sxy]!) * dzk);
        }
      }
    }
    for (let k = 1; k < nz; k++) {
      const dzk = idzd[k]!;
      for (let j = 0; j < ny; j++) {
        const row = sx * (j + sy * k);
        for (let i = 1; i < nx; i++) {
          const id = row + i;
          ey[id] = cay[id]! * ey[id]! + cby[id]! * ((hx[id]! - hx[id - sxy]!) * dzk - (hz[id]! - hz[id - 1]!) * idxd[i]!);
        }
      }
    }
    for (let k = 0; k < nz; k++) {
      for (let j = 1; j < ny; j++) {
        const dyj = idyd[j]!, row = sx * (j + sy * k);
        for (let i = 1; i < nx; i++) {
          const id = row + i;
          ez[id] = caz[id]! * ez[id]! + cbz[id]! * ((hy[id]! - hy[id - 1]!) * idxd[i]! - (hx[id]! - hx[id - sx]!) * dyj);
        }
      }
    }
    if (this.pml) {
      const P2 = 2 * this.pml;
      // Along x: Ey takes in dHz/dx, Ez dHy/dx
      {
        const b = this.be[0]!, ce = this.ce[0]!, p0 = this.psiE[0]!, p1 = this.psiE[1]!;
        for (const s of this.slabs(nx, true)) for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = s.lo; i < s.hi; i++) {
          const id = i + sx * (j + sy * k), m = i + s.off + P2 * (j + sy * k), bi = b[i]!, ci = ce[i]! * idxd[i]!;
          const a0 = p0[m] = bi * p0[m]! + ci * (hz[id]! - hz[id - 1]!);
          const a1 = p1[m] = bi * p1[m]! + ci * (hy[id]! - hy[id - 1]!);
          ey[id] -= cby[id]! * a0; ez[id] += cbz[id]! * a1;
        }
      }
      // Along y: Ex takes in dHz/dy, Ez dHx/dy
      {
        const b = this.be[1]!, ce = this.ce[1]!, p0 = this.psiE[2]!, p1 = this.psiE[3]!;
        for (const s of this.slabs(ny, true)) for (let k = 0; k < nz; k++) for (let j = s.lo; j < s.hi; j++) {
          const bj = b[j]!, cj = ce[j]! * idyd[j]!;
          for (let i = 0; i < nx; i++) {
            const id = i + sx * (j + sy * k), m = i + sx * (j + s.off + P2 * k);
            const a0 = p0[m] = bj * p0[m]! + cj * (hz[id]! - hz[id - sx]!);
            const a1 = p1[m] = bj * p1[m]! + cj * (hx[id]! - hx[id - sx]!);
            ex[id] += cbx[id]! * a0; ez[id] -= cbz[id]! * a1;
          }
        }
      }
      // Along z: Ex takes in dHy/dz, Ey dHx/dz
      {
        const b = this.be[2]!, ce = this.ce[2]!, p0 = this.psiE[4]!, p1 = this.psiE[5]!;
        for (const s of this.slabs(nz, true)) for (let k = s.lo; k < s.hi; k++) {
          const bk = b[k]!, ck = ce[k]! * idzd[k]!;
          for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const id = i + sx * (j + sy * k), m = i + sx * (j + sy * (k + s.off));
            const a0 = p0[m] = bk * p0[m]! + ck * (hy[id]! - hy[id - sxy]!);
            const a1 = p1[m] = bk * p1[m]! + ck * (hx[id]! - hx[id - sxy]!);
            ex[id] -= cbx[id]! * a0; ey[id] += cby[id]! * a1;
          }
        }
      }
    }
    // The ports' sources
    for (let p = 0; p < this.ports.length; p++) {
      const port = this.ports[p]!, e = [ex, ey, ez][port.axis]!, v = vs[p] ?? 0;
      if (v !== 0) for (let m = 0; m < port.edges.length; m++) e[port.edges[m]!] -= port.drive[m]! * v;
    }
  }
}
