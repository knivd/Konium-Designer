/**
 * A net's copper as a network of conductances, for the board analyses (analysis/pcg.ts solves it).
 *
 * The board is laid under a square grid, the same on every copper layer. On each layer:
 * - Copper areas (pours and their relief spokes, regions, fills, pads, via rings, plane copper)
 *   are drawn at three times the grid's fineness; a cell's copper is one node, or one node for
 *   each separate piece of it (a gap narrower than a cell still parts what it parts), and nodes
 *   of neighbouring cells are joined by as much copper as crosses the side between them.
 * - Tracks and arcs are lengths of their own exact resistance (length over width and thickness),
 *   joined where one ends on or crosses another and where they run onto a copper area. A grid
 *   would get a thin track's width wrong by a cell, and a diagonal one's length by its staircase.
 *   Over a copper area the area carries the current, and no length of track is counted there.
 * - A via's or a plated hole's barrel joins its layers, each length of it between two layers a
 *   conductance of its wall.
 */

import RBush from 'rbush';
import type { Vec2 } from '../core/geom';
import { UNITS_PER_MM, mil } from '../core/units';
import { copperNet, inPour, type PcbDocument, type PcbPad, type PcbPrim, type PcbVia } from '../model/pcb';
import { L, isSignal, type LayerId } from '../model/layers';
import { circle16, padOutline } from '../model/drcCopper';
import { padShapeOn } from '../model/padStack';
import { planeCopper } from '../model/planes';
import { Raster, chords, inPoly, layerCopper } from './raster';
import { readStack } from '../model/pcbStack';
import { link, newLinks, type Links } from './pcg';

/** Metres in one board unit. */
export const METRE = 1e-3 / UNITS_PER_MM;
/** Copper at 20 °C, and how its resistance rises with each degree (annealed copper, IACS). */
export const COPPER_SIGMA_20 = 5.8e7, COPPER_ALPHA = 0.00393;
/** Copper's conductivity (S/m) at a temperature. */
export const copperSigma = (celsius: number): number => COPPER_SIGMA_20 / (1 + COPPER_ALPHA * (celsius - 20));

export interface Grid { minX: number; minY: number; h: number; w: number; hgt: number; layers: LayerId[] }

/** A copper layer of the stack: its copper's thickness, and how far its middle is from the next layer's (metres). */
export interface StackCopper { layer: LayerId; thickness: number; toNext: number }

/** The board's copper layers top to bottom, with what the Layer Stack Manager says of them (1 oz copper and a 1.6 mm board where it says nothing). */
export function stackCopper(doc: PcbDocument): StackCopper[] {
  const rows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [];
  const layers = doc.board.copperStack, n = layers.length;
  const out: StackCopper[] = layers.map((layer) => ({ layer, thickness: 35e-6, toNext: n > 1 ? 1.5e-3 / (n - 1) : 0 }));
  let li = -1, between = 0, any = false;
  for (const r of rows) {
    if (r.kind === 'signal' || r.kind === 'plane') {
      const at = layers.indexOf(r.layer!);
      if (at < 0) continue;
      if (r.copper > 0) out[at]!.thickness = r.copper * METRE;
      if (li >= 0 && any) out[li]!.toNext = between + (out[li]!.thickness + out[at]!.thickness) / 2;
      li = at; between = 0; any = false;
    } else if (r.kind === 'dielectric' && li >= 0 && r.height > 0) { between += r.height * METRE; any = true; }
  }
  return out;
}

/** What a link is: copper area across a cell's side (east-west, north-south), a length of track, a length of barrel, or a joint. */
export const AREA_X = 0, AREA_Y = 1, TRACK = 2, BARREL = 3, CONTACT = 4;

/** A length of track (or of an arc) between two nodes: for its current and for drawing it. */
export interface TrackPiece { link: number; prim: number; layer: number; a: Vec2; b: Vec2; width: number }
/** A via or plated hole: its node on each layer it spans (from `first`), and the links between them. */
export interface Barrel { prim: number; at: Vec2; hole: number; first: number; nodes: number[]; links: number[] }

export interface CopperNet {
  grid: Grid; net: number; stack: StackCopper[];
  /** Nodes. */
  count: number;
  /** Each node's layer (index in grid.layers) and place. */
  nodeLayer: Uint8Array; nodeX: Float32Array; nodeY: Float32Array;
  /** By layer and cell: the node of the cell's (largest piece of) copper area, −1 none; and how much of the cell is copper, in ninths. */
  cellNode: Int32Array; cover: Uint8Array;
  links: Links;
  /** Each link's kind (AREA_X…). */
  kind: Uint8Array;
  /** Sheet conductance of each layer (siemens per square). */
  sheet: number[];
  tracks: TrackPiece[];
  barrels: Barrel[];
  /** The nodes under each pad asked for (by its index in doc.prims), each with its share of the pad. */
  pads: Map<number, { node: number; share: number }[]>;
  /** Each layer's copper areas at three times the grid's fineness (1: copper, rows from the south), when asked for: to draw them by. */
  fine: Uint8Array[] | null;
}

/** The grid for some nets' copper: its box, and cells sized for about `cells` of them a layer (never finer than 2 mil, nor coarser than 12: a relief's spoke must not fall between the cells). */
export function gridFor(doc: PcbDocument, nets: Set<number>, cells = 120_000): Grid | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const see = (p: Vec2, r = 0) => { minX = Math.min(minX, p.x - r); minY = Math.min(minY, p.y - r); maxX = Math.max(maxX, p.x + r); maxY = Math.max(maxY, p.y + r); };
  for (const p of doc.prims) {
    if (!('net' in p) || !nets.has(copperNet(doc, p))) continue;
    if (p.kind === 'track') { see(p.a, p.width / 2); see(p.b, p.width / 2); }
    else if (p.kind === 'arc') see(p.c, p.r + p.width / 2);
    else if (p.kind === 'via') see(p.at, p.diameter / 2);
    else if (p.kind === 'pad') see(p.at, Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h) / 2);
    else if (p.kind === 'fill') { see(p.a); see(p.b); }
    else if (p.kind === 'region') for (const q of p.outline) see(q);
  }
  // A plane of the net reaches to the board's edge
  if (doc.board.copperStack.some((l) => !isSignal(l) && planeCopper(doc, l).some((a) => nets.has(a.net)))) for (const q of doc.board.outline) see(q);
  if (!(maxX > minX) || !(maxY > minY)) return null;
  const h = Math.min(mil(12), Math.max(mil(2), Math.sqrt(((maxX - minX) * (maxY - minY)) / cells)));
  minX -= 2 * h; minY -= 2 * h;
  return { minX, minY, h, w: Math.ceil((maxX + 2 * h - minX) / h), hgt: Math.ceil((maxY + 2 * h - minY) / h), layers: [...doc.board.copperStack] };
}

export interface CopperOptions {
  /** Copper's conductivity, S/m. */
  sigma: number;
  /** The plating on a hole's wall, metres. */
  plating: number;
  /** Pads whose nodes are wanted (sources and loads), by index in doc.prims. */
  pads?: number[];
  /** Keep the fine picture of the copper areas (for drawing a map). */
  picture?: boolean;
}

interface Tap { t: number; pt: number; run: number }
interface Seg { id: number; prim: number; a: Vec2; b: Vec2; len: number; width: number; pa: number; pb: number; taps: Tap[]; runs: [number, number][]; minX: number; minY: number; maxX: number; maxY: number }

/** A net's copper on a grid, as nodes and the conductances between them. */
export function buildCopperNet(doc: PcbDocument, net: number, grid: Grid, o: CopperOptions): CopperNet {
  const { w: W, hgt: H, h, minX, minY } = grid, S = 3, W3 = W * S, H3 = H * S, hs = h / S, nL = grid.layers.length;
  const stack = stackCopper(doc), sheet = stack.map((s) => o.sigma * s.thickness);
  const links = newLinks(1 << 16);
  let kinds = new Uint8Array(1 << 16);
  const add = (a: number, b: number, g: number, kind: number): number => {
    if (a === b || !(g > 0)) return -1;
    if (links.count === kinds.length) { const k2 = new Uint8Array(kinds.length * 2); k2.set(kinds); kinds = k2; }
    kinds[links.count] = kind;
    link(links, a, b, g);
    return links.count - 1;
  };
  let count = 0, room = 1 << 16;
  let nodeLayer = new Uint8Array(room), nodeX = new Float32Array(room), nodeY = new Float32Array(room);
  const newNode = (li: number, x: number, y: number): number => {
    if (count === room) {
      room *= 2;
      const l2 = new Uint8Array(room), x2 = new Float32Array(room), y2 = new Float32Array(room);
      l2.set(nodeLayer); x2.set(nodeX); y2.set(nodeY); nodeLayer = l2; nodeX = x2; nodeY = y2;
    }
    nodeLayer[count] = li; nodeX[count] = x; nodeY[count] = y;
    return count++;
  };
  const cellNode = new Int32Array(nL * W * H).fill(-1), cover = new Uint8Array(nL * W * H);
  const ras = new Raster(minX, minY, hs, W3, H3), sub = ras.cells, subNode = new Int32Array(W3 * H3);
  const tracks: TrackPiece[] = [], barrels: Barrel[] = [], pads = new Map<number, { node: number; share: number }[]>();
  const want = new Set(o.pads ?? []), fine: Uint8Array[] | null = o.picture ? [] : null;
  /** The net's copper: pour copper may carry no net of its own, and is its polygon's. */
  const own: { p: PcbPrim; i: number }[] = [];
  // (a shelved polygon's copper is out of the design until it is restored)
  const shelved = new Set(doc.polygons.filter((g) => g.bag.bool('SHELVED')).map((g) => g.index));
  doc.prims.forEach((p, i) => {
    if (!('net' in p) || copperNet(doc, p) !== net || ('keepout' in p && p.keepout)) return;
    if (shelved.size && inPour(p) && shelved.has((p as { polygon: number }).polygon)) return;
    own.push({ p, i });
  });
  const sx = (x: number) => Math.floor((x - minX) / hs), sy = (y: number) => Math.floor((y - minY) / hs);
  const inside = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < W3 && cy < H3;
  const areaAt = (x: number, y: number): number => { const cx = sx(x), cy = sy(y); return inside(cx, cy) ? subNode[cy * W3 + cx]! : -1; };
  const holes: { p: PcbVia | PcbPad; i: number }[] = [];
  doc.prims.forEach((p, i) => { if (((p.kind === 'via') || (p.kind === 'pad' && p.layer === L.MULTI && p.plated && p.hole > 0)) && p.net === net) holes.push({ p, i }); });
  const barrelNodes = new Map<number, number[]>();
  const spanOf = (p: PcbPrim): [number, number] => {
    if (p.kind !== 'via') return [0, nL - 1];
    const a = grid.layers.indexOf(p.layerStart), b = grid.layers.indexOf(p.layerEnd);
    return a < 0 || b < 0 ? [0, nL - 1] : [Math.min(a, b), Math.max(a, b)];
  };

  for (let li = 0; li < nL; li++) {
    const layer = grid.layers[li]!, base = li * W * H, gs = sheet[li]!, thick = stack[li]!.thickness;
    ras.clear(); subNode.fill(-1);
    // 1. The copper areas (a pour's own tracks and arcs with them; the routing's are lengths, below)
    layerCopper(doc, layer, { net, tracks: 'pour' }, (rings) => ras.fill(rings));
    fine?.push(sub.slice());
    // 2. Each cell's copper: one node, or one for each separate piece of it
    const piece = new Int8Array(9), todo: number[] = [];
    for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
      let n = 0;
      for (let k = 0; k < 9; k++) n += sub[(cy * S + ((k / 3) | 0)) * W3 + cx * S + (k % 3)]!;
      if (!n) continue;
      cover[base + cy * W + cx] = n;
      const x = minX + (cx + 0.5) * h, y = minY + (cy + 0.5) * h;
      if (n === 9) {
        const id = newNode(li, x, y);
        cellNode[base + cy * W + cx] = id;
        for (let k = 0; k < 9; k++) subNode[(cy * S + ((k / 3) | 0)) * W3 + cx * S + (k % 3)] = id;
        continue;
      }
      piece.fill(-1);
      let best = -1, bestSize = 0;
      for (let k = 0; k < 9; k++) {
        if (piece[k] !== -1 || !sub[(cy * S + ((k / 3) | 0)) * W3 + cx * S + (k % 3)]) continue;
        const id = newNode(li, x, y);
        let size = 0;
        todo.push(k); piece[k] = 0;
        while (todo.length) {
          const q = todo.pop()!, qx = q % 3, qy = (q / 3) | 0;
          subNode[(cy * S + qy) * W3 + cx * S + qx] = id; size++;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = qx + dx, ny = qy + dy, nk = ny * 3 + nx;
            if (nx < 0 || ny < 0 || nx > 2 || ny > 2 || piece[nk] !== -1 || !sub[(cy * S + ny) * W3 + cx * S + nx]) continue;
            piece[nk] = 0; todo.push(nk);
          }
        }
        if (size > bestSize) { bestSize = size; best = id; }
      }
      cellNode[base + cy * W + cx] = best;
    }
    // 3. Neighbouring cells joined by the copper that crosses their shared side (a third of a square for each fine cell of it)
    for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
      if (!cover[base + cy * W + cx]) continue;
      const full = cover[base + cy * W + cx] === 9;
      if (cx + 1 < W && cover[base + cy * W + cx + 1]) {
        if (full && cover[base + cy * W + cx + 1] === 9) add(cellNode[base + cy * W + cx]!, cellNode[base + cy * W + cx + 1]!, gs, AREA_X);
        else for (let k = 0; k < S; k++) { const a = subNode[(cy * S + k) * W3 + cx * S + 2]!, b = subNode[(cy * S + k) * W3 + cx * S + 3]!; if (a >= 0 && b >= 0) add(a, b, gs / S, AREA_X); }
      }
      if (cy + 1 < H && cover[base + (cy + 1) * W + cx]) {
        if (full && cover[base + (cy + 1) * W + cx] === 9) add(cellNode[base + cy * W + cx]!, cellNode[base + (cy + 1) * W + cx]!, gs, AREA_Y);
        else for (let k = 0; k < S; k++) { const a = subNode[(cy * S + 2) * W3 + cx * S + k]!, b = subNode[(cy * S + 3) * W3 + cx * S + k]!; if (a >= 0 && b >= 0) add(a, b, gs / S, AREA_Y); }
      }
    }
    // Places that are to become one node: a track's ends and the places along it where something joins it. Some lie on a copper area (its node theirs).
    const up: number[] = [], bound: number[] = [];
    const point = (area: number) => { up.push(up.length); bound.push(area); return up.length - 1; };
    const find = (i: number) => { while (up[i] !== i) { up[i] = up[up[i]!]!; i = up[i]!; } return i; };
    const union = (p: number, q: number) => {
      const a = find(p), b = find(q);
      if (a === b) return;
      if (bound[a]! >= 0 && bound[b]! >= 0 && bound[a] !== bound[b]) add(bound[a]!, bound[b]!, gs * 4, CONTACT);
      if (bound[a]! < 0) up[a] = b; else up[b] = a;
    };
    // 4. Vias and plated holes: the barrel's node on this layer is the copper at the hole, or one of its own joined to the copper that reaches the hole's edge
    const fixed: { pt: number; x: number; y: number; r: number }[] = [];
    for (const { p, i } of holes) {
      const [from, to] = spanOf(p);
      if (li < from || li > to) continue;
      let node = areaAt(p.at.x, p.at.y);
      if (node < 0) {
        node = newNode(li, p.at.x, p.at.y);
        const cx = sx(p.at.x), cy = sy(p.at.y), reach = p.hole / 2 + hs, rr = Math.ceil(reach / hs), met = new Set<number>();
        for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
          const x = cx + dx, y = cy + dy;
          if (!inside(x, y) || Math.hypot(dx, dy) * hs > reach) continue;
          const n = subNode[y * W3 + x]!;
          if (n >= 0 && !met.has(n)) { met.add(n); add(node, n, gs * 4, CONTACT); }
        }
        fixed.push({ pt: point(node), x: p.at.x, y: p.at.y, r: p.hole / 2 });
      }
      (barrelNodes.get(i) ?? barrelNodes.set(i, []).get(i)!).push(node);
    }
    // 5. The tracks and arcs on this layer
    const segs: Seg[] = [];
    const seg = (prim: number, a: Vec2, b: Vec2, width: number) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y), r = width / 2;
      if (len >= 1) segs.push({ id: segs.length, prim, a, b, len, width, pa: -1, pb: -1, taps: [], runs: [], minX: Math.min(a.x, b.x) - r, minY: Math.min(a.y, b.y) - r, maxX: Math.max(a.x, b.x) + r, maxY: Math.max(a.y, b.y) + r });
    };
    if (isSignal(layer)) for (const { p, i } of own) {
      if ((p.kind !== 'track' && p.kind !== 'arc') || p.layer !== layer) continue;
      if (p.kind === 'track') { seg(i, p.a, p.b, p.width); continue; }
      const pts = chords(p);
      for (let k = 0; k + 1 < pts.length; k++) seg(i, pts[k]!, pts[k + 1]!, p.width);
    }
    const runAt = (s: Seg, t: number): number => { for (let r = 0; r < s.runs.length; r++) if (t >= s.runs[r]![0] - 1 && t <= s.runs[r]![1] + 1) return r; return -1; };
    // Where a track meets a copper area it meets it across its whole width: its node there is joined to every piece of the area under that round of copper
    const fans: { pt: number; x: number; y: number; r: number }[] = [];
    const fan = (x: number, y: number, r: number): number => { const pt = point(-1); fans.push({ pt, x, y, r }); return pt; };
    const endPoint = (q: Vec2, w: number): number => { const n = areaAt(q.x, q.y); return n >= 0 ? point(n) : fan(q.x, q.y, w / 2); };
    for (const s of segs) {
      s.pa = endPoint(s.a, s.width); s.pb = endPoint(s.b, s.width);
      const place = (t: number): Vec2 => ({ x: s.a.x + ((s.b.x - s.a.x) * t) / s.len, y: s.a.y + ((s.b.y - s.a.y) * t) / s.len });
      // The stretches of it that lie on copper areas: joined to the area where it comes on and where it goes off
      const steps = Math.max(1, Math.ceil(s.len / hs));
      let open = false, startT = 0, lastN = -1, lastT = 0, lcx = 0, lcy = 0;
      const close = () => {
        if (!open) return;
        const run = s.runs.length;
        s.runs.push([startT, lastT]);
        // (a stretch that begins or ends with the track has its end there already)
        if (startT > 0) { const q = place(startT); s.taps.push({ t: startT, pt: fan(q.x, q.y, s.width / 2), run }); }
        if (lastT < s.len) { const q = place(lastT); s.taps.push({ t: lastT, pt: fan(q.x, q.y, s.width / 2), run }); }
        open = false;
      };
      for (let k = 0; k <= steps; k++) {
        const t = (s.len * k) / steps, x = s.a.x + ((s.b.x - s.a.x) * k) / steps, y = s.a.y + ((s.b.y - s.a.y) * k) / steps, cx = sx(x), cy = sy(y);
        const n = inside(cx, cy) ? subNode[cy * W3 + cx]! : -1;
        if (n < 0) { close(); continue; }
        if (!open) { open = true; startT = t; }
        // A step cornerwise from one piece of copper to another: the picture does not join those
        else if (n !== lastN && cx !== lcx && cy !== lcy) add(lastN, n, gs / S, CONTACT);
        lastN = n; lastT = t; lcx = cx; lcy = cy;
      }
      close();
      s.taps.push({ t: 0, pt: s.pa, run: runAt(s, 0) }, { t: s.len, pt: s.pb, run: runAt(s, s.len) });
    }
    const tree = new RBush<Seg>();
    tree.load(segs);
    /** Something joins a track at a place along it: at its end if that is where, or a new place on it. */
    const tap = (s: Seg, t: number, pt: number) => {
      const endTol = Math.max(s.width / 2, 2);
      if (t <= endTol) union(pt, s.pa); else if (t >= s.len - endTol) union(pt, s.pb);
      else s.taps.push({ t, pt, run: runAt(s, t) });
    };
    /** A round of copper (a track's end, a hole) joined to every track it overlaps. */
    const near = (x: number, y: number, r: number, pt: number, self: Seg | null) => {
      for (const s of tree.search({ minX: x - r, minY: y - r, maxX: x + r, maxY: y + r })) {
        if (s === self) continue;
        const ux = (s.b.x - s.a.x) / s.len, uy = (s.b.y - s.a.y) / s.len, t = Math.max(0, Math.min(s.len, (x - s.a.x) * ux + (y - s.a.y) * uy));
        if (Math.hypot(s.a.x + ux * t - x, s.a.y + uy * t - y) <= r + s.width / 2 - 2) tap(s, t, pt);
      }
    };
    for (const s of segs) { near(s.a.x, s.a.y, s.width / 2, s.pa, s); near(s.b.x, s.b.y, s.width / 2, s.pb, s); }
    for (const f of fixed) near(f.x, f.y, f.r, f.pt, null);
    // Tracks that cross with no end at the crossing
    for (const s of segs) for (const q of tree.search(s)) {
      if (q.id <= s.id) continue;
      const d1x = s.b.x - s.a.x, d1y = s.b.y - s.a.y, d2x = q.b.x - q.a.x, d2y = q.b.y - q.a.y, den = d1x * d2y - d1y * d2x;
      if (Math.abs(den) < 1e-6 * s.len * q.len) continue;
      const ex = q.a.x - s.a.x, ey = q.a.y - s.a.y, u = (ex * d2y - ey * d2x) / den, v = (ex * d1y - ey * d1x) / den;
      if (u <= 0 || u >= 1 || v <= 0 || v >= 1) continue;
      const pt = point(areaAt(s.a.x + d1x * u, s.a.y + d1y * u));
      tap(s, u * s.len, pt); tap(q, v * q.len, pt);
    }
    // Each length between two joined places: its own conductance
    const nodeOf = new Map<number, number>();
    const nodeFor = (pt: number, at: Vec2): number => {
      const r = find(pt);
      if (bound[r]! >= 0) return bound[r]!;
      let n = nodeOf.get(r);
      if (n === undefined) { n = newNode(li, at.x, at.y); nodeOf.set(r, n); }
      return n;
    };
    for (const s of segs) {
      s.taps.sort((p, q) => p.t - q.t);
      const along = (t: number): Vec2 => ({ x: s.a.x + ((s.b.x - s.a.x) * t) / s.len, y: s.a.y + ((s.b.y - s.a.y) * t) / s.len });
      const gm = o.sigma * thick * s.width * METRE;
      let last = s.taps[0]!, lastAt = along(last.t), ln = nodeFor(last.pt, lastAt);
      for (let k = 1; k < s.taps.length; k++) {
        const tp = s.taps[k]!, at = along(tp.t), n = nodeFor(tp.pt, at);
        if (n !== ln && !(tp.run >= 0 && tp.run === last.run)) {
          const id = add(ln, n, gm / (Math.max(tp.t - last.t, s.width * 0.05) * METRE), TRACK);
          if (id >= 0) tracks.push({ link: id, prim: s.prim, layer: li, a: lastAt, b: at, width: s.width });
        }
        last = tp; lastAt = at; ln = n;
      }
    }
    for (const f of fans) {
      const cx = sx(f.x), cy = sy(f.y), reach = f.r + hs / 2, rr = Math.ceil(reach / hs), met = new Map<number, number>();
      let total = 0;
      for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
        const X = cx + dx, Y = cy + dy;
        if (!inside(X, Y)) continue;
        const m = subNode[Y * W3 + X]!;
        if (m < 0 || Math.hypot(minX + (X + 0.5) * hs - f.x, minY + (Y + 0.5) * hs - f.y) > reach) continue;
        met.set(m, (met.get(m) ?? 0) + 1); total++;
      }
      if (!total) continue;
      const node = nodeFor(f.pt, { x: f.x, y: f.y });
      for (const [m, c] of met) add(node, m, (gs * 8 * c) / total, CONTACT);
    }
    // 6. The pads asked for: the nodes under each, by how much of the pad lies on them
    for (const i of want) {
      const p = doc.prims[i];
      if (p?.kind !== 'pad' || pads.has(i)) continue;
      const st = p.layer === L.MULTI ? padShapeOn(p, layer) : p.layer === layer ? p.top : null;
      if (!st) continue;
      const g = padOutline(p, st), ring = g?.t === 'poly' ? g.pts : g?.t === 'circle' ? circle16(g.c, g.r) : null;
      const found = new Map<number, number>();
      if (ring) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const q of ring) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
        for (let cy = Math.max(0, sy(y0)); cy <= Math.min(H3 - 1, sy(y1)); cy++) for (let cx = Math.max(0, sx(x0)); cx <= Math.min(W3 - 1, sx(x1)); cx++) {
          const n = subNode[cy * W3 + cx]!;
          if (n >= 0 && inPoly(ring, minX + (cx + 0.5) * hs, minY + (cy + 0.5) * hs)) found.set(n, (found.get(n) ?? 0) + 1);
        }
      }
      if (!found.size) { const n = areaAt(p.at.x, p.at.y); if (n >= 0) found.set(n, 1); }
      if (!found.size) continue;
      let total = 0;
      for (const v of found.values()) total += v;
      pads.set(i, [...found].map(([node, v]) => ({ node, share: v / total })));
    }
  }
  // The barrels between the layers
  for (const { p, i } of holes) {
    const nodes = barrelNodes.get(i) ?? [], [from] = spanOf(p), wall = Math.PI * (p.hole * METRE + o.plating) * o.plating;
    const b: Barrel = { prim: i, at: p.at, hole: p.hole, first: from, nodes, links: [] };
    for (let k = 0; k + 1 < nodes.length; k++) {
      const len = stack[from + k]!.toNext;
      const id = add(nodes[k]!, nodes[k + 1]!, len > 0 ? (o.sigma * wall) / len : sheet[from + k]! * 100, BARREL);
      if (id >= 0) b.links.push(id);
    }
    barrels.push(b);
    // A through-hole pad with no copper of its own found: its barrel is where it is fed
    if (want.has(i) && !pads.has(i) && nodes.length) pads.set(i, [{ node: nodes[0]!, share: 1 }]);
  }
  return { grid, net, stack, count, nodeLayer: nodeLayer.subarray(0, count), nodeX: nodeX.subarray(0, count), nodeY: nodeY.subarray(0, count), cellNode, cover, links, kind: kinds.subarray(0, links.count), sheet, tracks, barrels, pads, fine };
}
