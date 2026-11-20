/**
 * An antenna drawn in a board's copper, worked out from the copper itself: the board becomes a
 * model for the FDTD (fdtd.ts), is driven at its feed with a pulse, and what the port and the
 * fields round the board do in time gives the antenna's impedance and match across the band, how
 * much of the power it radiates, and where.
 *
 * The model: every copper layer a sheet of perfect conductor on its own plane (all the copper of
 * all the nets, for the ground the antenna works against is as much the antenna as its trace: a
 * cell of the grid is copper when its middle is, so that the copper keeps its size on the average),
 * vias and plated holes as wires between the planes, the laminate between as a dielectric with
 * its loss inside the board's outline, air round it, an absorber beyond. The grid is fine over the
 * antenna's own copper and grows away from it. The port is a 50 Ω source between the feed pad and
 * the ground: down through the laminate where ground copper lies under (or over) the pad, across
 * the gap to the nearest ground copper on the pad's layer where it does not.
 *
 * Not in the model, and said in the panel and the guide: the parts (a matching network's parts are
 * gaps; feed the antenna after them), the copper's own loss (estimated afterwards from the current
 * on it), the copper's thickness, solder mask, an enclosure, a hand. Tracks at an angle are stepped
 * along the grid, which makes them a little long. [est] how near the resonance comes: a few per
 * cent; the grid's fineness is the main thing.
 */
import type { Vec2 } from '../core/geom';
import type { LayerId } from '../model/layers';
import { L, isSignal } from '../model/layers';
import { NO_NET, copperNet, type PcbDocument, type PcbPad } from '../model/pcb';
import { readStack } from '../model/pcbStack';
import { METRE, stackCopper } from './copperNet';
import { Raster, chords, layerCopper } from './raster';
import { C0, EPS0, Fdtd, type PortSetup } from './fdtd';
import { HuygensBox, pulse, spectrum, type Pattern } from './farfield';
import type { GpuRun } from './fdtdGpu';

export interface AntennaSetup {
  /** The feed pad (its index in the board's primitives) and the net the port returns to. */
  feed: number; ground: number;
  /** The frequency the antenna is for, Hz, and the band looked at round it as a share of it (0.6: from 0.7 to 1.3 of it). */
  f0: number; span?: number;
  /** The source's resistance, ohms (50). */
  r0?: number;
  /** The laminate's loss tangent (0.02, FR-4) and, where the layer stack names none, its dielectric constant (4.4). */
  tanD?: number; er?: number;
  /** The grid's cell over the antenna, metres (0.4 mm), and the most cells the model may have (it is coarsened to fit). */
  cell?: number; cells?: number;
  /** How far the record's end must have fallen below its peak before the run stops (0.01), and the longest it may run, in periods of f0 (120). */
  decay?: number; periods?: number;
}

export interface AntennaModel {
  setup: Required<Omit<AntennaSetup, 'cells'>> & { cells: number };
  /** The grid's planes, metres from the model's corner; `origin` is that corner on the board (board units). */
  x: Float64Array; y: Float64Array; z: Float64Array; origin: Vec2;
  /** The copper layers and the z plane each lies on, top first. */
  layers: { layer: LayerId; k: number }[];
  pml: number;
  eps: Float32Array; sigma: Float32Array; pecX: Int32Array; pecY: Int32Array; pecZ: Int32Array;
  port: PortSetup & { kind: 'through' | 'gap'; to?: LayerId; at: Vec2 };
  /** The cell over the antenna as built (coarser than asked when the model had to shrink), the antenna's copper's box on the board, and the board's size in metres. */
  cell: number; fine: { minX: number; minY: number; maxX: number; maxY: number }; board: { w: number; h: number };
  count: number;
  notes: string[];
}

const SPAN = 0.6, PML = 8;

/** Planes along one axis: `mid` as given, then cells growing by no more than 1.3 each out to `lo` and `hi`, none larger than `cap` allows there. */
function axisLines(lo: number, hi: number, mid: number[], cap: (u: number) => number): number[] {
  const grow = (from: number, to: number, first: number): number[] => {
    const xs: number[] = [], dir = to > from ? 1 : -1;
    let u = from, s = first;
    for (;;) {
      const rem = (to - u) * dir;
      if (rem < 1e-12) break;
      s = Math.min(s * 1.3, cap(u + (dir * s) / 2));
      if (rem < s * 1.5) {
        // The last of it: one cell, or two when it is long; a sliver is given to the cell before
        if (rem < s * 0.5) { if (xs.length) xs[xs.length - 1] = to; }
        else if (rem > s) { xs.push(u + (dir * rem) / 2, to); }
        else xs.push(to);
        break;
      }
      u += dir * s; xs.push(u);
    }
    return xs;
  };
  const a = mid[0]!, b = mid.at(-1)!;
  const below = grow(a, lo, mid.length > 1 ? mid[1]! - a : cap(a)).reverse(), above = grow(b, hi, mid.length > 1 ? b - mid.at(-2)! : cap(b));
  return [...below, ...mid, ...above];
}

/** The index of the plane nearest `u`. */
function nearest(a: Float64Array, u: number): number {
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m]! <= u) lo = m; else hi = m; }
  return u - a[lo]! <= a[hi]! - u ? lo : hi;
}

/** The dielectric between each copper layer and the next: its height in metres and the constant that gives the same capacitance. */
function gaps(doc: PcbDocument, erDefault: number): { h: number; er: number }[] {
  const copper = stackCopper(doc), rows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [];
  const out: { h: number; er: number }[] = [];
  for (let li = 0; li + 1 < copper.length; li++) {
    const from = rows.findIndex((r) => (r.kind === 'signal' || r.kind === 'plane') && r.layer === copper[li]!.layer);
    let h = 0, hOverE = 0;
    if (from >= 0) for (let q = from + 1; q < rows.length; q++) {
      const r = rows[q]!;
      if (r.kind === 'signal' || r.kind === 'plane') break;
      if (r.kind === 'dielectric' && r.height > 0) { h += r.height; hOverE += r.height / (r.dielConst > 1 ? r.dielConst : erDefault); }
    }
    // The laminate's own height where the stack gives it (the copper is a sheet with no thickness here), else the layers' spacing
    out.push({ h: Math.max(h > 0 ? h * METRE : copper[li]!.toNext, 20e-6), er: h > 0 ? h / hOverE : erDefault });
  }
  return out;
}

export function buildAntenna(doc: PcbDocument, s0: AntennaSetup): AntennaModel | string {
  const s = { span: SPAN, r0: 50, tanD: 0.02, er: 4.4, cell: 0.4e-3, decay: 0.01, periods: 120, ...s0, cells: s0.cells ?? 1_200_000 };
  const feed = doc.prims[s.feed];
  if (!feed || feed.kind !== 'pad') return 'Choose the pad the antenna is fed at';
  if (!(s.f0 > 1e6)) return 'Give the frequency the antenna is for';
  const stack = stackCopper(doc);
  if (!stack.length) return 'The board has no copper layers';
  const feedLayer = feed.layer === L.MULTI ? stack[0]!.layer : feed.layer, feedNet = copperNet(doc, feed);
  if (feedNet === s.ground && feedNet !== NO_NET) return 'The feed pad is on the ground net: choose the pad on the antenna\'s side of the feed';

  // The board's box and the antenna's own copper's, in board units
  const outline = doc.board.outline && doc.board.outline.length >= 3 ? doc.board.outline : null;
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, fine = { ...box };
  const grow = (b: typeof box, p: Vec2) => { b.minX = Math.min(b.minX, p.x); b.minY = Math.min(b.minY, p.y); b.maxX = Math.max(b.maxX, p.x); b.maxY = Math.max(b.maxY, p.y); };
  if (outline) for (const p of outline) grow(box, p);
  for (const { layer } of stack) {
    if (!outline) layerCopper(doc, layer, { tracks: 'all' }, (rings) => { for (const p of rings[0]!) grow(box, p); });
    // The antenna's copper: the feed's net's, or with no net the copper that pad's own layer has with none
    if (isSignal(layer)) layerCopper(doc, layer, { net: feedNet, tracks: 'all' }, (rings) => { for (const p of rings[0]!) grow(fine, p); });
  }
  grow(fine, feed.at);
  if (!(box.maxX > box.minX)) return 'The board has no outline and no copper';
  const m = 1 / METRE, lam0 = C0 / s.f0, fMax = s.f0 * (1 + s.span / 2), erTop = gaps(doc, s.er)[0]?.er ?? s.er;
  // The antenna need not be on the feed's net (an inverted F is ground's): the fine cells also take in the copper within a
  // sixth of a wavelength of the feed. And a net that is most of the board is not an antenna: they stop half a wavelength away.
  const near = Math.min(Math.max(lam0 / 6, 10e-3), 40e-3) * m;
  grow(fine, { x: feed.at.x - near, y: feed.at.y - near }); grow(fine, { x: feed.at.x + near, y: feed.at.y + near });
  const reach = Math.min(lam0 / 2, 60e-3) * m;
  fine.minX = Math.max(fine.minX, feed.at.x - reach, box.minX); fine.maxX = Math.min(fine.maxX, feed.at.x + reach, box.maxX);
  fine.minY = Math.max(fine.minY, feed.at.y - reach, box.minY); fine.maxY = Math.min(fine.maxY, feed.at.y + reach, box.maxY);

  const margin = Math.min(Math.max(lam0 / 4, 15e-3), 80e-3);
  // Six cells of air at the least between the board and the absorber: the box the far field is taken from stands in them
  const hAir = Math.min(C0 / fMax / 15, margin / 6), hBoard = Math.min(hAir, C0 / fMax / 15 / Math.sqrt(erTop));
  const g = gaps(doc, s.er), thickness = g.reduce((a, q) => a + q.h, 0);
  const notes: string[] = [];
  let cell = s.cell, x!: Float64Array, y!: Float64Array, z!: Float64Array, layerK: number[] = [];
  for (let attempt = 0; ; attempt++) {
    const pad = 2 * cell, W = (box.maxX - box.minX) * METRE, H = (box.maxY - box.minY) * METRE;
    const span = (lo: number, hi: number, size: number) => { const a = Math.max(0, lo - pad), b = Math.min(size, hi + pad), n = Math.max(1, Math.round((b - a) / cell)); return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n); };
    const lines = (size: number, mid: number[]) => {
      const xs = axisLines(-margin, size + margin, mid, (u) => (u > 0 && u < size ? hBoard : hAir));
      // The absorber's cells: the size of the last cell before them
      const a = xs[1]! - xs[0]!, b = xs.at(-1)! - xs.at(-2)!;
      return Float64Array.from([...Array.from({ length: PML }, (_, i) => xs[0]! - (PML - i) * a), ...xs, ...Array.from({ length: PML }, (_, i) => xs.at(-1)! + (i + 1) * b)]);
    };
    x = lines(W, span((fine.minX - box.minX) * METRE, (fine.maxX - box.minX) * METRE, W));
    y = lines(H, span((fine.minY - box.minY) * METRE, (fine.maxY - box.minY) * METRE, H));
    // z: the copper planes from the bottom (0) up, each gap in cells no thicker than the fine cell (and no more than six)
    const zs: number[] = [0];
    layerK = [0];
    for (let q = g.length - 1; q >= 0; q--) {
      // …and two at the least where it is half a cell thick or more: the field at a patch's edge wants more than one
      const n = Math.min(6, Math.max(g[q]!.h >= cell / 2 ? 2 : 1, Math.ceil(g[q]!.h / cell - 0.25))), base = zs.at(-1)!;
      for (let i = 1; i <= n; i++) zs.push(base + (g[q]!.h * i) / n);
      layerK.push(zs.length - 1);
    }
    const zl = axisLines(-margin, thickness + margin, zs.length > 1 ? zs : [0, cell], () => hAir);
    const shift = zl.indexOf(zs[0]!);
    const a = zl[1]! - zl[0]!, b = zl.at(-1)! - zl.at(-2)!;
    z = Float64Array.from([...Array.from({ length: PML }, (_, i) => zl[0]! - (PML - i) * a), ...zl, ...Array.from({ length: PML }, (_, i) => zl.at(-1)! + (i + 1) * b)]);
    layerK = layerK.map((k) => k + shift + PML);
    const count = x.length * y.length * z.length;
    if (count <= s.cells || attempt > 12) break;
    cell *= 1.2;
  }
  if (cell > s.cell * 1.01) notes.push(`The grid's cell over the antenna is ${(cell * 1e3).toFixed(2)} mm, not the ${(s.cell * 1e3).toFixed(2)} mm asked for: the model had to fit in ${s.cells.toLocaleString('en-GB')} cells`);
  const nx = x.length - 1, ny = y.length - 1, nz = z.length - 1, sx = nx + 1, sy = ny + 1;
  const at = (i: number, j: number, k: number) => i + sx * (j + sy * k);
  // Top layer first, as the stack has them: the bottom is the first plane built
  const layers = stack.map((c, li) => ({ layer: c.layer, k: layerK[stack.length - 1 - li]! }));
  if (stack.length === 1) layers[0]!.k = layerK[0]!;

  // The laminate: the cells between the bottom and the top plane whose middle is inside the outline
  const eps = new Float32Array(nx * ny * nz).fill(1), sigma = new Float32Array(nx * ny * nz);
  const r = Math.max(cell / 2, Math.sqrt(((box.maxX - box.minX) * METRE * (box.maxY - box.minY) * METRE) / 4e6));
  const RW = Math.ceil(((box.maxX - box.minX) * METRE) / r) + 2, RH = Math.ceil(((box.maxY - box.minY) * METRE) / r) + 2;
  const raster = () => new Raster(box.minX - r * m, box.minY - r * m, r * m, RW, RH);
  const inBoard = raster();
  if (outline) inBoard.fill([outline]); else inBoard.cells.fill(1);
  /** Whether a raster has the point (metres from the model's corner). */
  const has = (ra: Raster, u: number, v: number) => { const cx = Math.floor(u / r) + 1, cy = Math.floor(v / r) + 1; return cx >= 0 && cy >= 0 && cx < RW && cy < RH && ra.cells[cy * RW + cx] === 1; };
  if (stack.length > 1) {
    const kLo = layerK[0]!, kHi = layerK.at(-1)!;
    for (let k = kLo; k < kHi; k++) {
      // Which gap this cell is in (from the bottom up)
      let q = g.length - 1;
      for (let li = 1; li < layerK.length; li++) if (k >= layerK[li]!) q = g.length - 1 - li;
      const er = g[Math.max(0, q)]!.er, sg = 2 * Math.PI * s.f0 * EPS0 * er * s.tanD;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!has(inBoard, (x[i]! + x[i + 1]!) / 2, (y[j]! + y[j + 1]!) / 2)) continue;
        eps[i + nx * (j + ny * k)] = er; sigma[i + nx * (j + ny * k)] = sg;
      }
    }
  }

  // The copper: whole cells of the grid (below), and a track narrower than the cells as a wire along the grid
  const px = new Set<number>(), py = new Set<number>(), pz = new Set<number>();
  const groundOf = new Map<LayerId, Raster>();
  /** Whether the copper along a line is in one piece (it may stop short of either end, but not stop and start again). */
  const oneRun = (ra: Raster, x0: number, y0: number, x1: number, y1: number) => {
    const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (r / 2)));
    let runs = 0, was = false;
    for (let q = 0; q <= n; q++) { const on = has(ra, x0 + ((x1 - x0) * q) / n, y0 + ((y1 - y0) * q) / n); if (on && !was) runs++; was = on; }
    return runs === 1;
  };
  const wire = (a: Vec2, b: Vec2, k: number) => {
    let i = nearest(x, (a.x - box.minX) * METRE), j = nearest(y, (a.y - box.minY) * METRE);
    const i1 = nearest(x, (b.x - box.minX) * METRE), j1 = nearest(y, (b.y - box.minY) * METRE);
    const ax = (a.x - box.minX) * METRE, ay = (a.y - box.minY) * METRE, dx = (b.x - a.x) * METRE, dy = (b.y - a.y) * METRE, len = Math.hypot(dx, dy) || 1;
    const off = (u: number, v: number) => Math.abs((u - ax) * dy - (v - ay) * dx) / len;
    while (i !== i1 || j !== j1) {
      const si = Math.sign(i1 - i), sj = Math.sign(j1 - j);
      // The step that stays nearer the track's own line
      const goX = si !== 0 && (sj === 0 || off(x[i + si]!, y[j]!) <= off(x[i]!, y[j + sj]!));
      if (goX) { px.add(at(Math.min(i, i + si), j, k)); i += si; } else { py.add(at(i, Math.min(j, j + sj), k)); j += sj; }
    }
  };
  for (const { layer, k } of layers) {
    const all = raster(), gnd = raster();
    layerCopper(doc, layer, { tracks: 'all' }, (rings) => all.fill(rings));
    layerCopper(doc, layer, { net: s.ground, tracks: 'all' }, (rings) => gnd.fill(rings));
    groundOf.set(layer, gnd);
    // A cell of the grid is copper when copper covers its middle half each way, and its four edges are then conductor. A
    // plate's edge then stands a quarter of a cell inside where it is drawn, on the average, which is what the grid wants: the
    // field at the edge of a conductor made of whole cells behaves as if the conductor reached a quarter of a cell further.
    // A cell that a gap runs through stays open (the copper along both lines through its middle must be in one piece), so
    // that two pieces of copper are not joined by it.
    for (let j = 1; j + 1 < ny; j++) for (let i = 1; i + 1 < nx; i++) {
      const cx = (x[i]! + x[i + 1]!) / 2, cy = (y[j]! + y[j + 1]!) / 2, qx = (x[i + 1]! - x[i]!) / 4, qy = (y[j + 1]! - y[j]!) / 4;
      if (!has(all, cx, cy) || !has(all, cx - qx, cy) || !has(all, cx + qx, cy) || !has(all, cx, cy - qy) || !has(all, cx, cy + qy)) continue;
      if (!oneRun(all, x[i]!, cy, x[i + 1]!, cy) || !oneRun(all, cx, y[j]!, cx, y[j + 1]!)) continue;
      px.add(at(i, j, k)); px.add(at(i, j + 1, k)); py.add(at(i, j, k)); py.add(at(i + 1, j, k));
    }
    if (!isSignal(layer)) continue;
    // Copper narrower than a cell and a half is a wire along its middle: tracks and arcs, and long pads and fills
    const local = (at_: Vec2) => {
      const i = nearest(x, (at_.x - box.minX) * METRE), j = nearest(y, (at_.y - box.minY) * METRE);
      return Math.max(x[Math.min(nx, i + 1)]! - x[Math.max(0, i - 1)]!, y[Math.min(ny, j + 1)]! - y[Math.max(0, j - 1)]!) / 2;
    };
    const bar = (c: Vec2, w: number, h: number, rotation: number) => {
      const long = Math.max(w, h), thin = Math.min(w, h);
      if (thin * METRE >= 1.5 * local(c)) return;
      const a = ((rotation + (h > w ? 90 : 0)) * Math.PI) / 180, half = (long - thin) / 2;
      wire({ x: c.x - half * Math.cos(a), y: c.y - half * Math.sin(a) }, { x: c.x + half * Math.cos(a), y: c.y + half * Math.sin(a) }, k);
    };
    for (const p of doc.prims) {
      if ('keepout' in p && p.keepout) continue;
      if (p.kind === 'track' && p.layer === layer) { if (p.width * METRE < 1.5 * local(p.a)) wire(p.a, p.b, k); }
      else if (p.kind === 'arc' && p.layer === layer) { const pts = chords(p); if (p.width * METRE < 1.5 * local(pts[0]!)) for (let q = 0; q + 1 < pts.length; q++) wire(pts[q]!, pts[q + 1]!, k); }
      else if (p.kind === 'pad' && (p.layer === layer || p.layer === L.MULTI)) bar(p.at, p.top.w, p.top.h, p.rotation);
      else if (p.kind === 'fill' && p.layer === layer) bar({ x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, Math.abs(p.b.x - p.a.x), Math.abs(p.b.y - p.a.y), p.rotation);
    }
  }
  // Vias and plated holes: wires from plane to plane
  const kOf = (layer: LayerId) => layers.find((q) => q.layer === layer)?.k;
  for (const p of doc.prims) {
    let k0: number, k1: number, c: Vec2;
    if (p.kind === 'via') { k0 = kOf(p.layerStart) ?? layers[0]!.k; k1 = kOf(p.layerEnd) ?? layers.at(-1)!.k; c = p.at; }
    else if (p.kind === 'pad' && p.layer === L.MULTI && p.hole > 0 && (p as PcbPad).plated !== false) { k0 = layers[0]!.k; k1 = layers.at(-1)!.k; c = p.at; }
    else continue;
    if (k0 === k1) continue;
    const i = nearest(x, (c.x - box.minX) * METRE), j = nearest(y, (c.y - box.minY) * METRE);
    if (i < 1 || j < 1 || i >= nx || j >= ny) continue;
    for (let k = Math.min(k0, k1); k < Math.max(k0, k1); k++) pz.add(at(i, j, k));
  }

  // The port
  const fk = kOf(feedLayer);
  if (fk === undefined) return 'The feed pad is not on a copper layer';
  const fi = nearest(x, (feed.at.x - box.minX) * METRE), fj = nearest(y, (feed.at.y - box.minY) * METRE);
  /** Whether the model has copper at a node of a plane (a conducting edge ends there), and whether a net's copper is at or beside a node. */
  const cu = (i: number, j: number, k: number) => px.has(at(i, j, k)) || px.has(at(i - 1, j, k)) || py.has(at(i, j, k)) || py.has(at(i, j - 1, k));
  const by = (ra: Raster, i: number, j: number) => {
    const u = x[i]!, v = y[j]!, a = (x[i]! - x[i - 1]!) / 2, b = (x[i + 1]! - x[i]!) / 2, c = (y[j]! - y[j - 1]!) / 2, d = (y[j + 1]! - y[j]!) / 2;
    return has(ra, u, v) || has(ra, u - a, v - c) || has(ra, u + b, v - c) || has(ra, u - a, v + d) || has(ra, u + b, v + d);
  };
  let port: AntennaModel['port'] | null = null;
  // Down (or up) through the laminate to ground copper on another layer, the nearest first
  for (const q of [...layers].sort((a, b) => Math.abs(a.k - fk) - Math.abs(b.k - fk))) {
    if (q.k === fk || !cu(fi, fj, q.k) || !by(groundOf.get(q.layer)!, fi, fj)) continue;
    const k0 = Math.min(q.k, fk), n = Math.abs(q.k - fk);
    port = { axis: 2, i: fi, j: fj, k: k0, n, r: s.r0, kind: 'through', to: q.layer, at: feed.at };
    break;
  }
  if (!port) {
    // Across the gap to the nearest ground copper on the pad's own layer, along the grid: out of the feed's own copper, over
    // nodes with no copper, to the first node of the ground's
    const gnd = groundOf.get(feedLayer)!, reachM = Math.max(6e-3, 12 * cell);
    let best: { axis: 0 | 1; i: number; j: number; n: number; d: number } | null = null;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      let i = fi, j = fj, last = { i, j };
      for (;;) {
        i += di; j += dj;
        if (i < 2 || j < 2 || i >= nx - 1 || j >= ny - 1 || Math.hypot(x[i]! - x[fi]!, y[j]! - y[fj]!) > reachM) break;
        if (!cu(i, j, fk)) continue;
        const ground = by(gnd, i, j);
        // Still the copper the route left from: joined to the last node by a conducting edge
        const joined = (di !== 0 ? px : py).has(at(Math.min(i, i - di), Math.min(j, j - dj), fk)) && i - di === last.i && j - dj === last.j;
        if (joined && !ground) { last = { i, j }; continue; }
        if (ground && !joined) {
          const n = Math.abs(i - last.i) + Math.abs(j - last.j), gap = Math.hypot(x[i]! - x[last.i]!, y[j]! - y[last.j]!);
          if (!best || gap < best.d) best = { axis: di !== 0 ? 0 : 1, i: Math.min(i, last.i), j: Math.min(j, last.j), n, d: gap };
        }
        break;
      }
    }
    if (best) port = { axis: best.axis, i: best.i, j: best.j, k: fk, n: best.n, r: s.r0, kind: 'gap', at: feed.at };
  }
  if (!port) return `No copper of ${doc.nets[s.ground]?.name ?? 'the ground net'} lies under the feed pad or within ${Math.round(Math.max(6, 12 * cell * 1e3))} mm of it on its layer: the port has nothing to return to`;
  // The port's own edges are the source, not copper
  const step = port.axis === 0 ? 1 : port.axis === 1 ? sx : sx * sy, set = [px, py, pz][port.axis]!;
  for (let q = 0; q < port.n; q++) set.delete(at(port.i, port.j, port.k) + q * step);

  return {
    setup: s, x, y, z, origin: { x: box.minX, y: box.minY }, layers, pml: PML, eps, sigma,
    pecX: Int32Array.from(px), pecY: Int32Array.from(py), pecZ: Int32Array.from(pz), port, cell,
    fine, board: { w: (box.maxX - box.minX) * METRE, h: (box.maxY - box.minY) * METRE }, count: x.length * y.length * z.length, notes,
  };
}

/* ── The run ── */

export interface Match { /** The part next to the antenna and the one towards the source: where each goes and what it is. */ parts: { where: 'series' | 'shunt'; kind: 'L' | 'C'; value: number }[] }

/** The two-part networks that bring `z` (ohms, at `f`) to `r0`: the part at the antenna first. */
export function matches(z: [number, number], f: number, r0 = 50): Match[] {
  const [R, X] = z, w = 2 * Math.PI * f, out: Match[] = [];
  if (!(R > 0)) return out;
  const series = (x: number) => ({ where: 'series' as const, kind: x >= 0 ? ('L' as const) : ('C' as const), value: x >= 0 ? x / w : -1 / (w * x) });
  const shunt = (b: number) => ({ where: 'shunt' as const, kind: b >= 0 ? ('C' as const) : ('L' as const), value: b >= 0 ? b / w : -1 / (w * b) });
  if (Math.abs(R - r0) < 1e-9 * r0 && Math.abs(X) < 1e-9 * r0) return out;
  if (R > r0 || R * R + X * X > R * r0) {
    // A part across the antenna, then one in series towards the source
    const root = Math.sqrt(R / r0) * Math.sqrt(Math.max(0, R * R + X * X - r0 * R));
    for (const sg of [1, -1]) {
      const b = (X + sg * root) / (R * R + X * X);
      if (Math.abs(b) < 1e-15) continue;
      const x = 1 / b + (X * r0) / R - r0 / (b * R);
      out.push({ parts: [shunt(b), series(x)] });
    }
  }
  if (R < r0) {
    // A part in series with the antenna, then one across towards the source
    const root = Math.sqrt(R * (r0 - R));
    for (const sg of [1, -1]) {
      const x = sg * root - X, b = (sg * Math.sqrt((r0 - R) / R)) / r0;
      out.push({ parts: [series(x), shunt(b)] });
    }
  }
  return out.filter((q) => q.parts.every((p) => Number.isFinite(p.value) && p.value > 0));
}

export interface AntennaResult {
  model: AntennaModel;
  /** Across the band: the frequencies, the antenna's impedance (ohms) and its reflection against the source's resistance (dB, 0 down). */
  f: Float64Array; zRe: Float64Array; zIm: Float64Array; s11: Float64Array;
  /** At the frequency it is for. */
  at: { f: number; z: [number, number]; s11: number; vswr: number; mismatch: number };
  /** Where it matches best in the band, and the band round that over which S11 is under -10 dB (null when it never is). */
  best: { f: number; s11: number }; band: [number, number] | null;
  /** At f0: of the power the antenna accepts, the share it radiates with the laminate's loss alone, the copper's loss as a share (estimated), and with both. */
  efficiency: number; copperLoss: number; efficiencyAll: number;
  pattern: Pattern;
  /** Peak directivity, gain (with the losses) and realised gain (with the mismatch too), dBi. */
  directivity: number; gain: number; realised: number;
  /** The surface current on each copper layer at f0, A/m for 1 W accepted, at the grid's nodes (sx × sy): its size, and its
   *  two components as they are at the start of a cycle and a quarter of a cycle on (x, y: real, imaginary; four to a node). */
  current: { layer: LayerId; a: Float32Array; max: number; k: Float32Array }[];
  match: Match[];
  /** Steps run, the time simulated (s), how far the port's voltage had fallen at the end, and whether it had fallen far enough. */
  steps: number; time: number; decay: number; settled: boolean;
}

export interface AntennaJob {
  model: AntennaModel; sim: Fdtd;
  /** Steps taken and the most there may be; how far the record has fallen below its peak (1 until the pulse is over). */
  step: number; limit: number; fall: number;
  /** Runs for about `ms`; true when the run is over. */
  advance(ms: number): boolean;
  /** The nodes whose fields the sums are made from: the far field's box and the planes either side of each copper layer. */
  watched(): Uint32Array;
  /** The same with the steps taken on the graphics card. */
  advanceOn(gpu: GpuRun, ms: number): Promise<boolean>;
  finish(): AntennaResult;
}

export function startAntenna(doc: PcbDocument, setup: AntennaSetup): AntennaJob | string {
  const model = buildAntenna(doc, setup);
  return typeof model === 'string' ? model : jobFor(model);
}

export function jobFor(model: AntennaModel): AntennaJob {
  const s = model.setup;
  const sim = new Fdtd({ x: model.x, y: model.y, z: model.z, eps: model.eps, sigma: model.sigma, pecX: model.pecX, pecY: model.pecY, pecZ: model.pecZ, pml: model.pml, ports: [model.port] });
  const src = pulse(s.f0, s.span * s.f0 * 1.2), dt = sim.dt;
  const every = Math.max(1, Math.floor(1 / (s.f0 * 24 * dt)));
  const P = model.pml + 2;
  const box = new HuygensBox(sim, [P, P, P], [sim.nx - P, sim.ny - P, sim.nz - P], [s.f0], every);
  const v: number[] = [], cur: number[] = [];
  // The current on each copper plane: H just above less H just below, summed at f0
  const sheets = model.layers.map((q) => ({ ...q, kx: new Float64Array(2 * sim.sx * sim.sy), ky: new Float64Array(2 * sim.sx * sim.sy) }));
  const limit = Math.ceil(Math.max(src.length * 1.5, s.periods / s.f0) / dt), window = Math.max(8, Math.ceil(1.5 / (s.f0 * (1 - s.span / 2)) / dt));
  let peak = 0;
  /** The current sheets' sums, on the steps the box samples on. */
  const sampleSheets = () => {
    const om = 2 * Math.PI * s.f0, t = (sim.step - 0.5) * dt, cr = Math.cos(om * t) * every * dt, ci = -Math.sin(om * t) * every * dt, sxy = sim.sx * sim.sy;
    for (const sh of sheets) {
      const up = sh.k * sxy, dn = (sh.k - 1) * sxy;
      for (let q = 0; q < sxy; q++) {
        const kx = -(sim.hy[up + q]! - sim.hy[dn + q]!), ky = sim.hx[up + q]! - sim.hx[dn + q]!;
        sh.kx[2 * q] += kx * cr; sh.kx[2 * q + 1] += kx * ci; sh.ky[2 * q] += ky * cr; sh.ky[2 * q + 1] += ky * ci;
      }
    }
  };
  /** Over when the pulse is done and the port has been quiet for a period and a half of the band's lowest frequency. */
  const quiet = () => {
    if (job.step * dt <= src.length) return false;
    let late = 0;
    for (let q = Math.max(0, v.length - window); q < v.length; q++) late = Math.max(late, Math.abs(v[q]!));
    job.fall = peak > 0 ? late / peak : 0;
    return job.fall < s.decay;
  };
  const job: AntennaJob = {
    model, sim, step: 0, limit, fall: 1,
    advance(ms) {
      const until = Date.now() + ms;
      while (job.step < limit) {
        const n = job.step;
        sim.advance([src.at((n + 0.5) * dt)]);
        box.sample();
        const pv = sim.portV(0);
        v.push(pv); cur.push(sim.portI(0, src.at((n + 1) * dt)));
        peak = Math.max(peak, Math.abs(pv));
        if (sim.step % every === 0) sampleSheets();
        job.step++;
        if ((n + 1) % 16 === 0 && quiet()) return true;
        if ((job.step & 15) === 0 && Date.now() >= until) return false;
      }
      return true;
    },
    watched() {
      const seen = new Set<number>(), st = [1, sim.sx, sim.sx * sim.sy];
      for (const f of box.faces) {
        for (let c = box.lo[f.c]; c <= box.hi[f.c]; c++) for (let b = box.lo[f.b]; b <= box.hi[f.b]; b++) {
          const id = f.plane * st[f.a]! + b * st[f.b]! + c * st[f.c]!;
          seen.add(id); seen.add(id - st[f.a]!);
        }
      }
      const sxy = sim.sx * sim.sy;
      for (const sh of sheets) for (let q = 0; q < sxy; q++) { seen.add(sh.k * sxy + q); seen.add((sh.k - 1) * sxy + q); }
      return Uint32Array.from(seen);
    },
    async advanceOn(gpu, ms) {
      const until = Date.now() + ms;
      while (job.step < limit) {
        // Up to the next step the sums are made on
        const K = Math.min(every - (job.step % every), gpu.batch, limit - job.step);
        const vs = Float32Array.from({ length: K }, (_, q) => src.at((job.step + q + 0.5) * dt));
        const pv = await gpu.advance(vs);
        for (let q = 0; q < K; q++) {
          v.push(pv[q]!); cur.push((src.at((job.step + q + 1) * dt) - pv[q]!) / s.r0);
          peak = Math.max(peak, Math.abs(pv[q]!));
        }
        job.step += K; sim.step = job.step;
        if (sim.step % every === 0) { box.sample(); sampleSheets(); }
        if (quiet()) return true;
        if (Date.now() >= until) return false;
      }
      return true;
    },
    finish() {
      const N = 201, lo = s.f0 * (1 - s.span / 2), hi = s.f0 * (1 + s.span / 2);
      const f = Float64Array.from({ length: N }, (_, q) => lo + ((hi - lo) * q) / (N - 1)), zRe = new Float64Array(N), zIm = new Float64Array(N), s11 = new Float64Array(N);
      const zAt = (fq: number): [number, number] => {
        const [vr, vi] = spectrum(v, dt, fq, dt), [ir, ii] = spectrum(cur, dt, fq, dt), mm = ir * ir + ii * ii || 1e-300;
        return [(vr * ir + vi * ii) / mm, (vi * ir - vr * ii) / mm];
      };
      const refl = (zz: [number, number]) => { const a = zz[0] - s.r0, b = zz[1], c = zz[0] + s.r0; return Math.hypot(a, b) / Math.hypot(c, b); };
      let bi = 0;
      for (let q = 0; q < N; q++) {
        const zz = zAt(f[q]!);
        zRe[q] = zz[0]; zIm[q] = zz[1]; s11[q] = 20 * Math.log10(Math.max(refl(zz), 1e-6));
        if (s11[q]! < s11[bi]!) bi = q;
      }
      let band: [number, number] | null = null;
      if (s11[bi]! < -10) {
        let a = bi, b = bi;
        while (a > 0 && s11[a - 1]! < -10) a--;
        while (b < N - 1 && s11[b + 1]! < -10) b++;
        // The crossings, between the points either side
        const cross = (in_: number, out: number) => (out < 0 || out >= N ? f[in_]! : f[in_]! + ((f[out]! - f[in_]!) * (-10 - s11[in_]!)) / (s11[out]! - s11[in_]!));
        band = [cross(a, a - 1), cross(b, b + 1)];
      }
      const z0 = zAt(s.f0), g0 = refl(z0);
      const [vr, vi] = spectrum(v, dt, s.f0, dt), [ir, ii] = spectrum(cur, dt, s.f0, dt);
      const accepted = 0.5 * (vr * ir + vi * ii), radiated = box.power(0);
      const pattern = box.pattern(0, 5);
      // The copper's loss from the current on it: half the surface resistance times the current squared, over the copper [est]
      const rs = Math.sqrt(Math.PI * s.f0 * 4e-7 * Math.PI / 5.8e7), sxy = sim.sx * sim.sy;
      let copper = 0;
      const norm = accepted > 0 ? 1 / Math.sqrt(accepted) : 0;
      const current = sheets.map((sh) => {
        const a = new Float32Array(sxy), kk = new Float32Array(4 * sxy);
        let max = 0;
        // Where the plane has copper: the nodes its conducting edges end on (the field's step across the plane means a current only there)
        const on = new Uint8Array(sxy);
        for (const e of model.pecX) if (Math.floor(e / sxy) === sh.k) { on[e % sxy] = 1; on[(e % sxy) + 1] = 1; }
        for (const e of model.pecY) if (Math.floor(e / sxy) === sh.k) { on[e % sxy] = 1; on[(e % sxy) + sim.sx] = 1; }
        for (let j = 1; j < sim.ny; j++) for (let i = 1; i < sim.nx; i++) {
          const q = i + sim.sx * j;
          if (!on[q]) continue;
          // Kx lies on the edge to the right of the node, Ky on the one above: the node's is the mean of the two either side
          const kxr = (sh.kx[2 * q]! + sh.kx[2 * (q - 1)]!) / 2, kxi = (sh.kx[2 * q + 1]! + sh.kx[2 * (q - 1) + 1]!) / 2;
          const kyr = (sh.ky[2 * q]! + sh.ky[2 * (q - sim.sx)]!) / 2, kyi = (sh.ky[2 * q + 1]! + sh.ky[2 * (q - sim.sx) + 1]!) / 2;
          const m2 = kxr * kxr + kxi * kxi + kyr * kyr + kyi * kyi;
          const area = ((model.x[i + 1]! - model.x[i - 1]!) / 2) * ((model.y[j + 1]! - model.y[j - 1]!) / 2);
          copper += 0.5 * rs * m2 * area;
          a[q] = Math.sqrt(m2) * norm; if (a[q]! > max) max = a[q]!;
          kk[4 * q] = kxr * norm; kk[4 * q + 1] = kxi * norm; kk[4 * q + 2] = kyr * norm; kk[4 * q + 3] = kyi * norm;
        }
        return { layer: sh.layer, a, max, k: kk };
      });
      // No antenna radiates more than it accepts: off its resonance, where little is accepted, the two sums' errors can say so
      const efficiency = accepted > 0 ? Math.min(1, Math.max(0, radiated / accepted)) : 0, copperLoss = accepted > 0 ? copper / accepted : 0;
      const efficiencyAll = efficiency / (1 + copperLoss), mismatch = 1 - g0 * g0;
      const dBi = (q: number) => 10 * Math.log10(Math.max(q, 1e-12));
      return {
        model, f, zRe, zIm, s11,
        at: { f: s.f0, z: z0, s11: 20 * Math.log10(Math.max(g0, 1e-6)), vswr: g0 < 1 ? (1 + g0) / (1 - g0) : Infinity, mismatch },
        best: { f: f[bi]!, s11: s11[bi]! }, band,
        efficiency, copperLoss, efficiencyAll, pattern,
        directivity: dBi(pattern.peak), gain: dBi(pattern.peak * efficiencyAll), realised: dBi(pattern.peak * efficiencyAll * mismatch),
        current, match: matches(z0, s.f0, s.r0),
        steps: job.step, time: job.step * dt, decay: job.fall, settled: job.fall < s.decay,
      };
    },
  };
  return job;
}

/** Runs a model to its end in one go (tests, scripts). */
export function analyseAntenna(doc: PcbDocument, setup: AntennaSetup): AntennaResult | string {
  const job = startAntenna(doc, setup);
  if (typeof job === 'string') return job;
  while (!job.advance(1000)) { /* on */ }
  return job.finish();
}
