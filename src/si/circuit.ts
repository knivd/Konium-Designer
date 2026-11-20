/**
 * Signal Integrity's circuit and its transient solution: resistors, capacitors, drivers (a source
 * behind a resistance), lossless transmission lines (Bergeron's method of characteristics: each
 * end a conductance 1/Z0 and a current from the other end's state one delay ago) and nonlinear
 * devices given as current against voltage (clamp diodes, IBIS tables), solved by nodal analysis
 * at each time step (trapezoidal capacitors, Newton for the nonlinear ones). Node 0 is ground.
 */

export type Wave = (t: number) => number;

export interface Circuit {
  /** Nodes 1 … n (0 is ground), and their names. */
  names: string[];
  res: { a: number; b: number; r: number }[];
  caps: { a: number; b: number; c: number }[];
  /** A source v(t) behind r (or r(t): a driver pulling up, then down), from node a to ground (a driver; a resistor to a supply rail). */
  srcs: { a: number; r: number; v: Wave; rt?: Wave }[];
  tls: { a: number; b: number; z: number; td: number }[];
  /** A current out of node a to ground, against (v_a − ref): a table of [volts, amps], rising in volts. */
  nl: { a: number; ref: number; table: [number, number][] }[];
}

export const newCircuit = (): Circuit => ({ names: [''], res: [], caps: [], srcs: [], tls: [], nl: [] });
export const addNode = (c: Circuit, name: string): number => { c.names.push(name); return c.names.length - 1; };

/** A table's current and slope at v (linear between points, the end slopes beyond). */
export function tableAt(t: [number, number][], v: number): [number, number] {
  if (t.length === 1) return [t[0]![1], 0];
  let k = 0;
  while (k < t.length - 2 && v > t[k + 1]![0]) k++;
  const [v0, i0] = t[k]!, [v1, i1] = t[k + 1]!;
  const g = (i1 - i0) / (v1 - v0 || 1e-12);
  return [i0 + g * (v - v0), g];
}

/** Dense solve with partial pivoting (the matrix is small: pins and branch points). */
function solve(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const m = a.slice(), x = b.slice();
  for (let col = 0; col < n; col++) {
    let p = col, best = Math.abs(m[col * n + col]!);
    for (let r = col + 1; r < n; r++) { const v = Math.abs(m[r * n + col]!); if (v > best) { best = v; p = r; } }
    if (best < 1e-30) { m[col * n + col] = 1e-12; continue; }
    if (p !== col) {
      for (let k = 0; k < n; k++) { const t = m[col * n + k]!; m[col * n + k] = m[p * n + k]!; m[p * n + k] = t; }
      const t = x[col]!; x[col] = x[p]!; x[p] = t;
    }
    const d = m[col * n + col]!;
    for (let r = col + 1; r < n; r++) {
      const f = m[r * n + col]! / d;
      if (!f) continue;
      for (let k = col; k < n; k++) m[r * n + k]! -= f * m[col * n + k]!;
      x[r]! -= f * x[col]!;
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]!;
    for (let k = r + 1; k < n; k++) s -= m[r * n + k]! * x[k]!;
    x[r] = s / m[r * n + r]!;
  }
  return x;
}

export interface Transient { t: Float64Array; v: Float64Array[] }

/**
 * The circuit's response from 0 to tEnd in steps of dt (every line's delay at least dt), starting
 * from its DC state with the sources at their t = 0 values; the probed nodes' voltages, at most
 * `points` of them each.
 */
export function transient(c: Circuit, o: { dt: number; tEnd: number; probe: number[]; points?: number }): Transient {
  const n = c.names.length - 1;
  const dt = o.dt, steps = Math.max(1, Math.ceil(o.tEnd / dt));
  const idx = (node: number) => node - 1;
  const stampG = (A: Float64Array, a: number, b: number, g: number) => {
    if (a) A[idx(a) * n + idx(a)]! += g;
    if (b) A[idx(b) * n + idx(b)]! += g;
    if (a && b) { A[idx(a) * n + idx(b)]! -= g; A[idx(b) * n + idx(a)]! -= g; }
  };
  const inject = (rhs: Float64Array, a: number, i: number) => { if (a) rhs[idx(a)]! += i; };
  const volt = (v: Float64Array, a: number) => (a ? v[idx(a)]! : 0);
  // The linear part that never changes: resistors, sources' resistances, lines' 1/Z0, capacitors' 2C/dt
  const rOf = (t: number) => c.srcs.map((s) => (s.rt ? s.rt(t) : s.r));
  const base = (dc: boolean, rs: number[]) => {
    const A = new Float64Array(n * n);
    for (const r of c.res) stampG(A, r.a, r.b, 1 / r.r);
    c.srcs.forEach((s, k) => stampG(A, s.a, 0, 1 / rs[k]!));
    for (const t of c.tls) {
      if (dc) stampG(A, t.a, t.b, 1e6);
      else { stampG(A, t.a, 0, 1 / t.z); stampG(A, t.b, 0, 1 / t.z); }
    }
    if (!dc) for (const k of c.caps) stampG(A, k.a, k.b, (2 * k.c) / dt);
    // A node with nothing else (a lone pin): a tiny leak keeps it defined
    for (let i = 0; i < n; i++) A[i * n + i]! += 1e-12;
    return A;
  };
  const newton = (A0: Float64Array, rhs0: Float64Array, guess: Float64Array): Float64Array => {
    if (!c.nl.length) return solve(A0, rhs0, n);
    let v = guess;
    for (let it = 0; it < 40; it++) {
      const A = A0.slice(), rhs = rhs0.slice();
      for (const d of c.nl) {
        const va = volt(v, d.a) - d.ref;
        const [i, g] = tableAt(d.table, va);
        // Linearised about this guess: I ≈ g v_a + (i − g (va + ref)), the constant part moved to the right
        stampG(A, d.a, 0, g);
        inject(rhs, d.a, -(i - g * (va + d.ref)));
      }
      const nv = solve(A, rhs, n);
      let diff = 0;
      for (let k = 0; k < n; k++) diff = Math.max(diff, Math.abs(nv[k]! - v[k]!));
      // Damped: no more than a volt a step
      if (diff > 1) for (let k = 0; k < n; k++) nv[k] = v[k]! + Math.max(-1, Math.min(1, nv[k]! - v[k]!));
      v = nv;
      if (diff < 1e-7) break;
    }
    return v;
  };
  // DC: lines are wires, capacitors open, sources at t = 0
  let rs = rOf(0);
  const Adc = base(true, rs);
  const rdc = new Float64Array(n);
  c.srcs.forEach((s, k) => inject(rdc, s.a, s.v(0) / rs[k]!));
  let v = newton(Adc, rdc, new Float64Array(n));
  // History of each line's ends (voltage and current into the line)
  const hist = c.tls.map((t) => {
    const iab = (volt(v, t.a) - volt(v, t.b)) * 1e6;
    return { va: new Float64Array(steps + 1).fill(volt(v, t.a)), ia: new Float64Array(steps + 1).fill(iab), vb: new Float64Array(steps + 1).fill(volt(v, t.b)), ib: new Float64Array(steps + 1).fill(-iab), v0a: volt(v, t.a), v0b: volt(v, t.b), i0: iab };
  });
  const capI = c.caps.map(() => 0);
  const capV = c.caps.map((k) => volt(v, k.a) - volt(v, k.b));
  let A = base(false, rs);
  const varies = c.srcs.some((s) => s.rt);
  const every = Math.max(1, Math.floor(steps / (o.points ?? 2000)));
  const outT: number[] = [0];
  const outV = o.probe.map((p) => [volt(v, p)]);
  const at = (arr: Float64Array, init: number, time: number) => {
    const k = time / dt;
    if (k <= 0) return init;
    const k0 = Math.floor(k), f = k - k0;
    return f ? arr[k0]! * (1 - f) + arr[Math.min(k0 + 1, arr.length - 1)]! * f : arr[k0]!;
  };
  for (let s = 1; s <= steps; s++) {
    const t = s * dt;
    if (varies) {
      // A driver switching between pulling up and down: the matrix once more when it does
      const now = rOf(t);
      if (now.some((r, k) => r !== rs[k])) { rs = now; A = base(false, rs); }
    }
    const rhs = new Float64Array(n);
    c.srcs.forEach((src, k) => inject(rhs, src.a, src.v(t) / rs[k]!));
    const J: [number, number][] = c.tls.map((tl, k) => {
      const h = hist[k]!, back = t - tl.td;
      const ja = at(h.vb, h.v0b, back) / tl.z + at(h.ib, -h.i0, back);
      const jb = at(h.va, h.v0a, back) / tl.z + at(h.ia, h.i0, back);
      inject(rhs, tl.a, ja); inject(rhs, tl.b, jb);
      return [ja, jb];
    });
    c.caps.forEach((k, j) => { const g = (2 * k.c) / dt, ieq = g * capV[j]! + capI[j]!; inject(rhs, k.a, ieq); inject(rhs, k.b, -ieq); });
    v = newton(A, rhs, v);
    c.tls.forEach((tl, k) => {
      const h = hist[k]!, va = volt(v, tl.a), vb = volt(v, tl.b);
      h.va[s] = va; h.vb[s] = vb; h.ia[s] = va / tl.z - J[k]![0]; h.ib[s] = vb / tl.z - J[k]![1];
    });
    c.caps.forEach((k, j) => { const g = (2 * k.c) / dt, vn = volt(v, k.a) - volt(v, k.b); capI[j] = g * (vn - capV[j]!) - capI[j]!; capV[j] = vn; });
    if (s % every === 0 || s === steps) { outT.push(t); o.probe.forEach((p, i) => outV[i]!.push(volt(v, p))); }
  }
  return { t: Float64Array.from(outT), v: outV.map((a) => Float64Array.from(a)) };
}
