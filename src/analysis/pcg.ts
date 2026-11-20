/**
 * A network of conductances solved for its node potentials: the one calculation under the board
 * analyses (a supply's voltage drop: electrical conductances and currents; the board's
 * temperature: thermal conductances and heat). Kirchhoff's law at every free node, some nodes held
 * at given potentials, flows put in at others.
 *
 * Solved by conjugate gradients. On its own that takes as many steps as the network is nodes
 * across, so each step is helped by a rough solution on a ladder of coarser networks (nodes
 * gathered in fours by their strongest links, and those again, down to a few hundred solved
 * outright): a multigrid cycle, after which a few dozen steps do for any size.
 */

/** Conductances between pairs of nodes (a pair may come more than once: they add). */
export interface Links { a: Int32Array; b: Int32Array; g: Float64Array; count: number }

export function newLinks(room = 1024): Links {
  return { a: new Int32Array(room), b: new Int32Array(room), g: new Float64Array(room), count: 0 };
}
export function link(l: Links, a: number, b: number, g: number): void {
  if (a === b || !(g > 0)) return;
  if (l.count === l.a.length) {
    const n = l.count * 2, a2 = new Int32Array(n), b2 = new Int32Array(n), g2 = new Float64Array(n);
    a2.set(l.a); b2.set(l.b); g2.set(l.g);
    l.a = a2; l.b = b2; l.g = g2;
  }
  l.a[l.count] = a; l.b[l.count] = b; l.g[l.count] = g; l.count++;
}

/** The groups of nodes joined to one another (each node's group, numbered from 0). */
export function groups(n: number, l: Links): { of: Int32Array; count: number } {
  const up = new Int32Array(n);
  for (let i = 0; i < n; i++) up[i] = i;
  const find = (i: number) => { while (up[i] !== i) { up[i] = up[up[i]!]!; i = up[i]!; } return i; };
  for (let k = 0; k < l.count; k++) { const a = find(l.a[k]!), b = find(l.b[k]!); if (a !== b) up[a] = b; }
  const of = new Int32Array(n).fill(-1), id = new Map<number, number>();
  for (let i = 0; i < n; i++) { const r = find(i); let g = id.get(r); if (g === undefined) { g = id.size; id.set(r, g); } of[i] = g; }
  return { of, count: id.size };
}

export interface Solved {
  /** Each node's potential (NaN: not joined to any held node, so it has none). */
  x: Float64Array;
  iterations: number;
  /** What is left of the imbalance, against the flows put in (0: exact). */
  residual: number;
}

export interface SolveOptions {
  tolerance?: number; maxIterations?: number; start?: Float64Array;
  /** Without the coarser networks (each step scaled by the node's own conductance only): for comparison. */
  plain?: boolean;
  /** A conductance from each node to a potential of zero (a board's faces losing heat to the air, taken as zero). */
  shunt?: Float64Array;
}
/** A solution under way: `step` does some iterations (true when there is no more to do), `result` is where it stands. */
export interface Solver { step(iterations: number): boolean; result(): Solved; readonly iterations: number; readonly residual: number; readonly levels: number }

/** A network's equations: row i is diag[i]·x[i] − Σ val[k]·x[col[k]] = b[i]. */
interface Level {
  n: number; ptr: Int32Array; col: Int32Array; val: Float64Array; diag: Float64Array;
  /** Each node's node on the next, coarser level. */
  agg: Int32Array | null;
  x: Float64Array; b: Float64Array; r: Float64Array;
  /** The coarsest level's equations factored (lower triangle by rows), to solve it outright. */
  chol: Float64Array | null;
}

/** Nodes paired off, each with the free neighbour it is most strongly joined to. */
function pairs(n: number, ptr: Int32Array, col: Int32Array, val: Float64Array): { agg: Int32Array; count: number } {
  const agg = new Int32Array(n).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (agg[i]! >= 0) continue;
    let best = -1, bv = 0;
    for (let k = ptr[i]!, e = ptr[i + 1]!; k < e; k++) { const j = col[k]!; if (agg[j]! < 0 && j !== i && val[k]! > bv) { bv = val[k]!; best = j; } }
    agg[i] = count;
    if (best >= 0) agg[best] = count;
    count++;
  }
  return { agg, count };
}

/** The network of the groups: what joins two groups is all that joins their nodes. */
function gathered(n: number, ptr: Int32Array, col: Int32Array, val: Float64Array, diag: Float64Array, agg: Int32Array, nc: number) {
  // The nodes of each group, in order
  const start = new Int32Array(nc + 1);
  for (let i = 0; i < n; i++) start[agg[i]! + 1]!++;
  for (let c = 0; c < nc; c++) start[c + 1]! += start[c]!;
  const members = new Int32Array(n), at = start.slice(0, nc);
  for (let i = 0; i < n; i++) members[at[agg[i]!]!++] = i;
  const cptr = new Int32Array(nc + 1), cdiag = new Float64Array(nc), mark = new Int32Array(nc).fill(-1);
  let ccol = new Int32Array(Math.max(16, ptr[n]! >> 1)), cval = new Float64Array(ccol.length), nz = 0;
  for (let c = 0; c < nc; c++) {
    const rowStart = nz;
    let d = 0;
    for (let m = start[c]!; m < start[c + 1]!; m++) {
      const i = members[m]!;
      d += diag[i]!;
      for (let k = ptr[i]!, e = ptr[i + 1]!; k < e; k++) {
        const cj = agg[col[k]!]!;
        if (cj === c) { d -= val[k]!; continue; }
        const seen = mark[cj]!;
        if (seen >= rowStart) { cval[seen]! += val[k]!; continue; }
        if (nz === ccol.length) { const c2 = new Int32Array(nz * 2), v2 = new Float64Array(nz * 2); c2.set(ccol); v2.set(cval); ccol = c2; cval = v2; }
        mark[cj] = nz; ccol[nz] = cj; cval[nz++] = val[k]!;
      }
    }
    cdiag[c] = d; cptr[c + 1] = nz;
  }
  return { ptr: cptr, col: ccol.subarray(0, nz), val: cval.subarray(0, nz), diag: cdiag };
}

const level = (n: number, ptr: Int32Array, col: Int32Array, val: Float64Array, diag: Float64Array): Level =>
  ({ n, ptr, col, val, diag, agg: null, x: new Float64Array(n), b: new Float64Array(n), r: new Float64Array(n), chol: null });

/** The ladder of coarser networks under a network. */
function ladder(top: Level): Level[] {
  const levels = [top];
  for (;;) {
    const f = levels[levels.length - 1]!;
    if (f.n <= 400 || levels.length > 40) break;
    // In fours: paired, and the pairs paired
    const p1 = pairs(f.n, f.ptr, f.col, f.val), m = gathered(f.n, f.ptr, f.col, f.val, f.diag, p1.agg, p1.count);
    const p2 = pairs(p1.count, m.ptr, m.col, m.val), c = gathered(p1.count, m.ptr, m.col, m.val, m.diag, p2.agg, p2.count);
    if (p2.count > f.n * 0.7) break;
    const agg = new Int32Array(f.n);
    for (let i = 0; i < f.n; i++) agg[i] = p2.agg[p1.agg[i]!]!;
    f.agg = agg;
    levels.push(level(p2.count, c.ptr, c.col, c.val, c.diag));
  }
  // The last solved outright when it is small enough to
  const last = levels[levels.length - 1]!, n = last.n;
  if (n <= 1200) {
    const a = new Float64Array(n * n);
    for (let i = 0; i < n; i++) { a[i * n + i] = last.diag[i]!; for (let k = last.ptr[i]!; k < last.ptr[i + 1]!; k++) a[i * n + last.col[k]!]! -= last.val[k]!; }
    let ok = true;
    for (let i = 0; i < n && ok; i++) for (let j = 0; j <= i; j++) {
      let s = a[i * n + j]!;
      for (let k = 0; k < j; k++) s -= a[i * n + k]! * a[j * n + k]!;
      if (i === j) { if (!(s > 0)) { ok = false; break; } a[i * n + i] = Math.sqrt(s); } else a[i * n + j] = s / a[j * n + j]!;
    }
    if (ok) last.chol = a;
  }
  return levels;
}

/** One sweep through the nodes, each set to what its neighbours ask of it. */
function sweep(l: Level, back: boolean): void {
  const { n, ptr, col, val, diag, x, b } = l;
  if (back) for (let i = n - 1; i >= 0; i--) { let s = b[i]!; for (let k = ptr[i]!, e = ptr[i + 1]!; k < e; k++) s += val[k]! * x[col[k]!]!; x[i] = s / diag[i]!; }
  else for (let i = 0; i < n; i++) { let s = b[i]!; for (let k = ptr[i]!, e = ptr[i + 1]!; k < e; k++) s += val[k]! * x[col[k]!]!; x[i] = s / diag[i]!; }
}

/** A rough solution of level `at` (its b to its x), by way of the coarser ones. */
function cycle(levels: Level[], at: number, fresh: boolean): void {
  const l = levels[at]!, { n, ptr, col, val, diag, x, b, r } = l;
  if (fresh) x.fill(0);
  if (!l.agg) {
    if (l.chol) {
      const a = l.chol;
      for (let i = 0; i < n; i++) { let s = b[i]!; for (let k = 0; k < i; k++) s -= a[i * n + k]! * x[k]!; x[i] = s / a[i * n + i]!; }
      for (let i = n - 1; i >= 0; i--) { let s = x[i]!; for (let k = i + 1; k < n; k++) s -= a[k * n + i]! * x[k]!; x[i] = s / a[i * n + i]!; }
    } else for (let k = 0; k < 8; k++) { sweep(l, false); sweep(l, true); }
    return;
  }
  sweep(l, false);
  const c = levels[at + 1]!, agg = l.agg;
  c.b.fill(0);
  for (let i = 0; i < n; i++) {
    let s = b[i]! - diag[i]! * x[i]!;
    for (let k = ptr[i]!, e = ptr[i + 1]!; k < e; k++) s += val[k]! * x[col[k]!]!;
    r[i] = s; c.b[agg[i]!]! += s;
  }
  // Twice round the coarser level: the gathering is crude, and the second round makes up for it
  cycle(levels, at + 1, true);
  cycle(levels, at + 1, false);
  const cx = c.x;
  for (let i = 0; i < n; i++) x[i]! += cx[agg[i]!]!;
  sweep(l, true);
}

/**
 * The potentials. `held`: a potential for each node held at one (NaN: free). `flow`: what is put
 * into each node (taken out: negative). Nodes not joined to a held node are left out (NaN), and
 * `start` may give a first guess for the free ones. A `shunt` joins nodes to zero as well.
 */
export function solver(n: number, l: Links, held: Float64Array, flow: Float64Array, o: SolveOptions = {}): Solver {
  const tol = o.tolerance ?? 1e-9;
  // Free nodes that can reach a held one, numbered on their own
  const grp = groups(n, l), fed = new Uint8Array(grp.count);
  const shunt = o.shunt;
  for (let i = 0; i < n; i++) if (!Number.isNaN(held[i]!) || (shunt && shunt[i]! > 0)) fed[grp.of[i]!] = 1;
  const x = new Float64Array(n), index = new Int32Array(n).fill(-1);
  let nf = 0;
  for (let i = 0; i < n; i++) {
    if (!fed[grp.of[i]!]) { x[i] = NaN; continue; }
    if (Number.isNaN(held[i]!)) index[i] = nf++; else x[i] = held[i]!;
  }
  const node = new Int32Array(nf);
  for (let i = 0; i < n; i++) if (index[i]! >= 0) node[index[i]!] = i;
  // Their equations: links to one another in rows, links to held nodes on the right-hand side
  const ptr = new Int32Array(nf + 1), diag = new Float64Array(nf), b = new Float64Array(nf);
  for (let f = 0; f < nf; f++) { b[f] = flow[node[f]!]!; if (shunt) diag[f] = Math.max(0, shunt[node[f]!]!); }
  for (let k = 0; k < l.count; k++) {
    const a = index[l.a[k]!]!, c = index[l.b[k]!]!, g = l.g[k]!;
    if (a >= 0) { diag[a]! += g; if (c >= 0) ptr[a + 1]!++; else b[a]! += g * x[l.b[k]!]!; }
    if (c >= 0) { diag[c]! += g; if (a >= 0) ptr[c + 1]!++; else b[c]! += g * x[l.a[k]!]!; }
  }
  for (let f = 0; f < nf; f++) ptr[f + 1]! += ptr[f]!;
  const col = new Int32Array(ptr[nf]!), val = new Float64Array(ptr[nf]!), at = ptr.slice(0, nf);
  for (let k = 0; k < l.count; k++) {
    const a = index[l.a[k]!]!, c = index[l.b[k]!]!;
    if (a < 0 || c < 0) continue;
    const g = l.g[k]!;
    col[at[a]!] = c; val[at[a]!++] = g; col[at[c]!] = a; val[at[c]!++] = g;
  }
  const maxIt = o.maxIterations ?? (o.plain ? Math.max(2000, 12 * Math.ceil(Math.sqrt(nf)) + 2000) : 400);
  const top = level(nf, ptr, col, val, diag), levels = o.plain || nf < 600 ? [top] : ladder(top);
  const xf = new Float64Array(nf), r = new Float64Array(nf), z = new Float64Array(nf), p = new Float64Array(nf), q = new Float64Array(nf);
  if (o.start) for (let f = 0; f < nf; f++) { const s = o.start[node[f]!]; if (s !== undefined && Number.isFinite(s)) xf[f] = s; }
  const apply = (v: Float64Array, y: Float64Array) => {
    for (let i = 0; i < nf; i++) { let s = diag[i]! * v[i]!; for (let k = ptr[i]!, e = ptr[i + 1]!; k < e; k++) s -= val[k]! * v[col[k]!]!; y[i] = s; }
  };
  /** z: r made into a correction. */
  const improve = () => {
    if (levels.length === 1) { for (let i = 0; i < nf; i++) z[i] = r[i]! / diag[i]!; return; }
    top.b.set(r);
    cycle(levels, 0, true);
    z.set(top.x);
  };
  apply(xf, q);
  let ask = 0, rr = 0;
  for (let i = 0; i < nf; i++) { r[i] = b[i]! - q[i]!; ask += b[i]! * b[i]!; rr += r[i]! * r[i]!; }
  // The size the imbalance is measured against: what the held nodes and the flows ask of the free ones
  const ref = Math.max(Math.sqrt(ask), 1e-300);
  let it = 0, res = Math.sqrt(rr) / ref, done = !(res > tol), rz = 0;
  if (!done) { improve(); for (let i = 0; i < nf; i++) { p[i] = z[i]!; rz += r[i]! * z[i]!; } }
  const step = (count: number): boolean => {
    for (let c = 0; c < count && !done; c++) {
      apply(p, q);
      let pq = 0;
      for (let i = 0; i < nf; i++) pq += p[i]! * q[i]!;
      if (!(pq > 0)) { done = true; break; }
      const alpha = rz / pq;
      rr = 0;
      for (let i = 0; i < nf; i++) { xf[i]! += alpha * p[i]!; const v = (r[i]! -= alpha * q[i]!); rr += v * v; }
      it++;
      res = Math.sqrt(rr) / ref;
      if (!(res > tol) || it >= maxIt) { done = true; break; }
      improve();
      let rz2 = 0;
      for (let i = 0; i < nf; i++) rz2 += r[i]! * z[i]!;
      const beta = rz2 / rz;
      rz = rz2;
      for (let i = 0; i < nf; i++) p[i] = z[i]! + beta * p[i]!;
    }
    return done;
  };
  const result = (): Solved => { for (let f = 0; f < nf; f++) x[node[f]!] = xf[f]!; return { x, iterations: it, residual: res }; };
  return { step, result, get iterations() { return it; }, get residual() { return res; }, levels: levels.length };
}

/** The potentials, worked through in one go. */
export function solve(n: number, l: Links, held: Float64Array, flow: Float64Array, o: SolveOptions = {}): Solved {
  const s = solver(n, l, held, flow, o);
  while (!s.step(200)) { /* until it settles */ }
  return s.result();
}
