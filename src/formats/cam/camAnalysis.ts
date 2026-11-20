/**
 * The CAM editor's analysis (CAMtastic's Tools › Netlist, Analysis and Reports): the copper each
 * object covers, nets extracted from the copper layers and the plated holes joining them (a negative
 * plane layer is one piece of copper its clearances are cut from), a design check of the films —
 * clearance between nets, track width, annular ring, hole sizes, drill to copper, silk over pads —
 * copper area, invalid polygons, and the reports: RFQ, D-code usage, X:Y coordinates, rout paths.
 */
import type { BBox, Vec2 } from '../../core/geom';
import type { DrillLayer, GerberLayer, GerberObject } from '../gerber/gerberRead';
import { camExtent, type CamDocument, type CamLayer } from './camDoc';
import { liveObjects, type CamNet } from './camModel';
import { coverOf } from './camOps';
import { clipContours } from '../../model/outlineOps';

export const COPPER_TYPES = new Set(['Top', 'Bottom', 'Internal', 'Plane']);
export const copperLayers = (d: CamDocument): CamLayer[] => d.layers.filter((l) => l.data.kind === 'gerber' && COPPER_TYPES.has(l.type));
/** Drill layers whose holes are plated (a file that says non-plated, or is named so, isn't). */
export const platedLayers = (d: CamDocument): CamLayer[] => d.layers.filter((l) => l.data.kind === 'drill' && l.data.plated !== false && !/npth|non.?plated/i.test(l.name));

/* ─── Geometry ─────────────────────────────────────────────────────────────────────── */

export function boxOf(pts: Vec2[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; }
  return { minX, minY, maxX, maxY };
}
export function inside(p: Vec2, poly: Vec2[]): boolean {
  let k = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i]!, b = poly[j]!; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) k = !k; }
  return k;
}
const segSeg = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): number => {
  const cross = (o: Vec2, p: Vec2, q: Vec2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 && d2 && d3 && d4) return 0;
  const ps = (p: Vec2, s: Vec2, e: Vec2) => { const dx = e.x - s.x, dy = e.y - s.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / l2)) : 0; return Math.hypot(p.x - s.x - t * dx, p.y - s.y - t * dy); };
  return Math.min(ps(a, c, d), ps(b, c, d), ps(c, a, b), ps(d, a, b));
};
/** The distance between two outlines (0 when they overlap) and the point nearest between them. */
export function polyDist(a: Vec2[], b: Vec2[]): { d: number; at: Vec2 } {
  if (inside(a[0]!, b)) return { d: 0, at: a[0]! };
  if (inside(b[0]!, a)) return { d: 0, at: b[0]! };
  let best = Infinity, at = a[0]!;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!, q = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const r = b[j]!, s = b[(j + 1) % b.length]!;
      const d = segSeg(p, q, r, s);
      if (d < best) { best = d; at = { x: (p.x + q.x + r.x + s.x) / 4, y: (p.y + q.y + r.y + s.y) / 4 }; if (!d) return { d: 0, at }; }
    }
  }
  return { d: best, at };
}

/** One piece of copper (or film): its outlines and box, and what it is. */
export interface Piece { layer: CamLayer; i: number; polys: Vec2[][]; box: BBox }
export function piecesOf(l: CamLayer, darkOnly = true): Piece[] {
  if (l.data.kind !== 'gerber') return [];
  const g = l.data;
  const out: Piece[] = [];
  for (const { o, i } of liveObjects(l)) {
    if (darkOnly && !o.dark) continue;
    const polys = coverOf(o, g).filter((p) => p.length >= 3);
    if (polys.length) out.push({ layer: l, i, polys, box: boxOf(polys.flat()) });
  }
  return out;
}

/** Pairs of pieces whose boxes come within `gap` of each other (bucketed). */
export function nearPairs(pieces: Piece[], gap: number, visit: (a: Piece, b: Piece) => void): void {
  if (!pieces.length) return;
  const sizes = pieces.map((p) => Math.max(p.box.maxX - p.box.minX, p.box.maxY - p.box.minY)).sort((x, y) => x - y);
  const cell = Math.max(sizes[Math.floor(sizes.length / 2)]! * 2, gap * 2, 1000);
  const grid = new Map<string, number[]>();
  pieces.forEach((p, k) => {
    for (let x = Math.floor((p.box.minX - gap) / cell); x <= Math.floor((p.box.maxX + gap) / cell); x++)
      for (let y = Math.floor((p.box.minY - gap) / cell); y <= Math.floor((p.box.maxY + gap) / cell); y++) { const key = `${x},${y}`; const b = grid.get(key); if (b) b.push(k); else grid.set(key, [k]); }
  });
  const seen = new Set<number>();
  const n = pieces.length;
  for (const list of grid.values()) {
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      const i = list[a]!, j = list[b]!, key = i < j ? i * n + j : j * n + i;
      if (seen.has(key)) continue;
      seen.add(key);
      const A = pieces[i]!, B = pieces[j]!;
      if (A.box.maxX + gap < B.box.minX || B.box.maxX + gap < A.box.minX || A.box.maxY + gap < B.box.minY || B.box.maxY + gap < A.box.minY) continue;
      visit(A, B);
    }
  }
}
export function piecesDist(a: Piece, b: Piece): { d: number; at: Vec2 } {
  let best = { d: Infinity, at: a.polys[0]![0]! };
  for (const p of a.polys) for (const q of b.polys) { const r = polyDist(p, q); if (r.d < best.d) best = r; if (!best.d) return best; }
  return best;
}

/* ─── Netlist ──────────────────────────────────────────────────────────────────────── */

/** Is a negative layer's clearance at a hole a thermal (copper still reaches the hole) rather than an anti-pad? */
function thermalAt(g: GerberLayer, o: GerberObject): boolean {
  if (o.kind !== 'flash') return false;
  const a = g.apertures.get(o.ap);
  return a?.shape === 'M' && (a.shapes?.filter((s) => !s.dark).length ?? 0) >= 2;
}

/**
 * Tools › Netlist › Extract: copper that touches on a layer is one net; plated holes join the copper of
 * every layer they pass through; a negative plane is one piece, joined to each hole its clearance leaves
 * connected (no clearance there, or a thermal) [est: CAMtastic's plane handling]. Named NET1, NET2 … by
 * position, or after the imported netlist's nets when it has a point in them.
 */
export function extractNets(d: CamDocument): CamNet[] {
  const layers = copperLayers(d);
  type Node = { layer: CamLayer; i: number } | { plane: CamLayer } | { hole: CamLayer; i: number };
  const nodes: Node[] = [];
  const parent: number[] = [];
  const add = (n: Node) => { nodes.push(n); parent.push(parent.length); return parent.length - 1; };
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[x] = y; };
  const pieceNode = new Map<Piece, number>();
  const byLayer = new Map<CamLayer, Piece[]>();
  const planeNode = new Map<CamLayer, number>();
  for (const l of layers) {
    const g = l.data as GerberLayer;
    if (g.negative) { planeNode.set(l, add({ plane: l })); byLayer.set(l, piecesOf(l)); continue; }
    const pieces = piecesOf(l);
    byLayer.set(l, pieces);
    for (const p of pieces) pieceNode.set(p, add({ layer: l, i: p.i }));
    nearPairs(pieces, 0, (a, b) => { if (piecesDist(a, b).d <= 1) join(pieceNode.get(a)!, pieceNode.get(b)!); });
  }
  for (const dl of platedLayers(d)) {
    const dd = dl.data as DrillLayer, er = new Set(dl.erased ?? []);
    dd.hits.forEach((h, i) => {
      if (er.has(i)) return;
      const hn = add({ hole: dl, i });
      for (const l of layers) {
        const pieces = byLayer.get(l)!;
        const under = pieces.filter((p) => p.box.minX <= h.at.x && p.box.maxX >= h.at.x && p.box.minY <= h.at.y && p.box.maxY >= h.at.y && p.polys.some((q) => inside(h.at, q)));
        const plane = planeNode.get(l);
        if (plane !== undefined) {
          const g = l.data as GerberLayer;
          if (!under.length || under.some((p) => thermalAt(g, g.objects[p.i]!))) join(hn, plane);
        } else for (const p of under) join(hn, pieceNode.get(p)!);
      }
    });
  }
  // Components with copper in them
  const groups = new Map<number, number[]>();
  nodes.forEach((_, k) => { const r = find(k); const g = groups.get(r); if (g) g.push(k); else groups.set(r, [k]); });
  const nets: { members: Record<string, number[]>; at: Vec2 }[] = [];
  for (const ks of groups.values()) {
    const members: Record<string, number[]> = {};
    let at: Vec2 | null = null;
    for (const k of ks) {
      const n = nodes[k]!;
      if ('plane' in n) { const pl = n.plane; (members[pl.name] ??= []); at ??= { x: 0, y: 0 }; continue; }
      const l = 'hole' in n ? n.hole : n.layer;
      (members[l.name] ??= []).push(n.i);
      if (!at && 'hole' in n) at = (n.hole.data as DrillLayer).hits[n.i]!.at;
      else if (!at && 'layer' in n) { const o = (n.layer.data as GerberLayer).objects[n.i]!; at = o.kind === 'draw' ? o.a : o.kind === 'arc' ? o.a : o.kind === 'flash' ? o.at : o.contours[0]![0]!; }
    }
    const copper = Object.keys(members).some((name) => layers.some((l) => l.name === name));
    if (copper) nets.push({ members, at: at ?? { x: 0, y: 0 } });
  }
  nets.sort((a, b) => b.at.y - a.at.y || a.at.x - b.at.x);
  // Named after the imported netlist where one of its points is in the net's copper
  const names = new Map<number, string>();
  if (d.refNets?.length) {
    const pieceOf = new Map<string, Piece>();
    for (const [l, ps] of byLayer) for (const p of ps) pieceOf.set(`${l.name}:${p.i}`, p);
    nets.forEach((n, k) => {
      for (const ref of d.refNets!) {
        if (ref.points.some((pt) => Object.entries(n.members).some(([ln, idx]) => idx.some((i) => { const p = pieceOf.get(`${ln}:${i}`); return !!p && p.polys.some((q) => inside(pt.at, q)); })))) { names.set(k, ref.name); break; }
      }
    });
  }
  const used = new Set<string>();
  return nets.map((n, k) => {
    let name = names.get(k) ?? `NET${k + 1}`;
    while (used.has(name)) name = `${name}_${k + 1}`;
    used.add(name);
    return { name, members: n.members };
  });
}

/** The net of a layer's object (by the extracted netlist). */
export function netOf(d: CamDocument, layer: CamLayer, i: number): CamNet | undefined {
  return d.nets?.find((n) => n.members[layer.name]?.includes(i));
}

/** Tools › Netlist › Compare: the extracted nets against the imported netlist — opens (a net's points in several nets) and shorts (one net holding several). */
export function compareNets(d: CamDocument): { opens: string[]; shorts: string[]; missing: string[] } {
  const nets = d.nets ?? [], refs = d.refNets ?? [];
  const pieces = new Map<string, Piece>();
  const sideOf = new Map<string, string>();
  for (const l of copperLayers(d)) { sideOf.set(l.name, l.type); for (const p of piecesOf(l)) pieces.set(`${l.name}:${p.i}`, p); }
  const holeNet = new Map<string, string>();
  const key = (p: Vec2) => `${Math.round(p.x / 5000)},${Math.round(p.y / 5000)}`;
  for (const n of nets) for (const [ln, idx] of Object.entries(n.members)) { const l = d.layers.find((x) => x.name === ln); if (l?.data.kind === 'drill') for (const i of idx) holeNet.set(key(l.data.hits[i]!.at), n.name); }
  // A test point is on its side's copper (a hole's on the net of the hole)
  const netAt = (pt: { at: Vec2; side: 'top' | 'bottom' | 'both' }): string | undefined => {
    if (pt.side === 'both') { const h = holeNet.get(key(pt.at)); if (h) return h; }
    const want = pt.side === 'top' ? 'Top' : pt.side === 'bottom' ? 'Bottom' : null;
    return nets.find((n) => Object.entries(n.members).some(([ln, idx]) => (!want || sideOf.get(ln) === want) && idx.some((i) => { const p = pieces.get(`${ln}:${i}`); return !!p && p.box.minX <= pt.at.x && p.box.maxX >= pt.at.x && p.box.minY <= pt.at.y && p.box.maxY >= pt.at.y && p.polys.some((q) => inside(pt.at, q)); })))?.name;
  };
  const opens: string[] = [], missing: string[] = [];
  const holders = new Map<string, Set<string>>();
  for (const r of refs) {
    const found = new Set<string>();
    for (const pt of r.points) { const n = netAt(pt); if (n) { found.add(n); const h = holders.get(n) ?? new Set<string>(); h.add(r.name); holders.set(n, h); } }
    if (!found.size) missing.push(r.name);
    else if (found.size > 1) opens.push(`${r.name}: split across ${[...found].join(', ')}`);
  }
  const shorts = [...holders].filter(([, h]) => h.size > 1).map(([n, h]) => `${n}: joins ${[...h].join(', ')}`);
  return { opens, shorts, missing };
}

/* ─── Design check ─────────────────────────────────────────────────────────────────── */

export interface CamDrcRules {
  clearance: number; minWidth: number; annularRing: number; minHole: number; maxHole: number; drillToCopper: number; silkToMask: number;
  checks: { clearance: boolean; width: boolean; annular: boolean; holes: boolean; drillToCopper: boolean; silk: boolean };
}
export const defaultCamDrcRules = (): CamDrcRules => ({
  clearance: 100_000, minWidth: 60_000, annularRing: 50_000, minHole: 80_000, maxHole: 2_500_000, drillToCopper: 100_000, silkToMask: 30_000,
  checks: { clearance: true, width: true, annular: true, holes: true, drillToCopper: true, silk: true },
});
export interface CamViolation { rule: string; layer: string; at: Vec2; value: number; limit: number; objects: { layer: string; i: number }[] }

/** The pads (flashes) on copper at a hole, and the annular ring each leaves (half the smaller pad size less the hole's radius). */
export function annularRings(d: CamDocument): { at: Vec2; ring: number; layer: string; hole: number; holeLayer: string; i: number; pad: number }[] {
  const out: { at: Vec2; ring: number; layer: string; hole: number; holeLayer: string; i: number; pad: number }[] = [];
  const pads = copperLayers(d).filter((l) => !(l.data as GerberLayer).negative).map((l) => {
    const g = l.data as GerberLayer;
    const grid = new Map<string, { o: Extract<GerberObject, { kind: 'flash' }>; i: number }[]>();
    for (const { o, i } of liveObjects(l)) if (o.kind === 'flash' && o.dark) { const k = `${Math.round(o.at.x / 5000)},${Math.round(o.at.y / 5000)}`; grid.set(k, [...(grid.get(k) ?? []), { o, i }]); }
    return { l, g, grid };
  });
  for (const dl of platedLayers(d)) {
    const dd = dl.data as DrillLayer, er = new Set(dl.erased ?? []);
    dd.hits.forEach((h, hi) => {
      if (er.has(hi) || h.slot || h.circle) return;
      const hole = dd.tools.get(h.tool) ?? 0;
      for (const { l, g, grid } of pads) {
        const k = `${Math.round(h.at.x / 5000)},${Math.round(h.at.y / 5000)}`;
        const f = grid.get(k)?.find(({ o }) => Math.hypot(o.at.x - h.at.x, o.at.y - h.at.y) < 5000);
        if (!f) continue;
        const a = g.apertures.get(f.o.ap);
        if (!a) continue;
        const pad = Math.min(a.w, a.h);
        out.push({ at: h.at, ring: (pad - hole) / 2, layer: l.name, hole, holeLayer: dl.name, i: hi, pad });
      }
    });
  }
  return out;
}

/** Analysis › PCB Design Check: the films checked against the rules. */
export function camDrc(d: CamDocument, rules: CamDrcRules): CamViolation[] {
  const out: CamViolation[] = [];
  const c = rules.checks;
  if (c.clearance) {
    if (!d.nets) d.nets = extractNets(d);
    const netIndex = new Map<string, number>();
    d.nets.forEach((n, k) => { for (const [ln, idx] of Object.entries(n.members)) for (const i of idx) netIndex.set(`${ln}:${i}`, k); });
    for (const l of copperLayers(d)) {
      if ((l.data as GerberLayer).negative) continue;
      nearPairs(piecesOf(l), rules.clearance, (a, b) => {
        const na = netIndex.get(`${l.name}:${a.i}`), nb = netIndex.get(`${l.name}:${b.i}`);
        if (na === nb) return;
        const r = piecesDist(a, b);
        if (r.d < rules.clearance) out.push({ rule: r.d === 0 ? 'Short' : 'Clearance', layer: l.name, at: r.at, value: r.d, limit: rules.clearance, objects: [{ layer: l.name, i: a.i }, { layer: l.name, i: b.i }] });
      });
    }
  }
  if (c.width) for (const l of copperLayers(d)) {
    const g = l.data as GerberLayer;
    for (const { o, i } of liveObjects(l)) {
      if ((o.kind !== 'draw' && o.kind !== 'arc') || !o.dark) continue;
      const a = g.apertures.get(o.ap);
      const w = a ? Math.min(a.w, a.h) || a.w : 0;
      if (w > 0 && w < rules.minWidth) out.push({ rule: 'Width', layer: l.name, at: { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 }, value: w, limit: rules.minWidth, objects: [{ layer: l.name, i }] });
    }
  }
  if (c.annular) for (const r of annularRings(d)) if (r.ring < rules.annularRing) out.push({ rule: 'Annular Ring', layer: r.layer, at: r.at, value: r.ring, limit: rules.annularRing, objects: [{ layer: r.holeLayer, i: r.i }] });
  if (c.holes) for (const dl of d.layers.filter((l) => l.data.kind === 'drill')) {
    const dd = dl.data as DrillLayer, er = new Set(dl.erased ?? []);
    dd.hits.forEach((h, i) => {
      if (er.has(i)) return;
      const s = dd.tools.get(h.tool) ?? 0;
      if (s < rules.minHole || s > rules.maxHole) out.push({ rule: 'Hole Size', layer: dl.name, at: h.at, value: s, limit: s < rules.minHole ? rules.minHole : rules.maxHole, objects: [{ layer: dl.name, i }] });
    });
  }
  if (c.drillToCopper) {
    // Non-plated holes too near copper
    const npth = d.layers.filter((l) => l.data.kind === 'drill' && !platedLayers(d).includes(l));
    for (const l of copperLayers(d)) {
      if ((l.data as GerberLayer).negative) continue;
      const pieces = piecesOf(l);
      for (const dl of npth) {
        const dd = dl.data as DrillLayer, er = new Set(dl.erased ?? []);
        dd.hits.forEach((h, i) => {
          if (er.has(i)) return;
          const r = (dd.tools.get(h.tool) ?? 0) / 2;
          const ring = Array.from({ length: 24 }, (_, k) => ({ x: h.at.x + r * Math.cos((k * Math.PI) / 12), y: h.at.y + r * Math.sin((k * Math.PI) / 12) }));
          const hp: Piece = { layer: dl, i, polys: [ring], box: boxOf(ring) };
          for (const p of pieces) {
            if (p.box.maxX + rules.drillToCopper < hp.box.minX || hp.box.maxX + rules.drillToCopper < p.box.minX || p.box.maxY + rules.drillToCopper < hp.box.minY || hp.box.maxY + rules.drillToCopper < p.box.minY) continue;
            const dist = piecesDist(hp, p);
            if (dist.d < rules.drillToCopper) out.push({ rule: 'Drill to Copper', layer: l.name, at: h.at, value: dist.d, limit: rules.drillToCopper, objects: [{ layer: dl.name, i }, { layer: l.name, i: p.i }] });
          }
        });
      }
    }
  }
  if (c.silk) {
    // Silk over the mask's openings (the pads left bare) on the same side
    for (const side of ['Top', 'Bottom'] as const) {
      const silk = d.layers.filter((l) => l.type === `${side} Silk` && l.data.kind === 'gerber');
      const mask = d.layers.filter((l) => l.type === `${side} Mask` && l.data.kind === 'gerber');
      if (!silk.length || !mask.length) continue;
      const openings = mask.flatMap((l) => piecesOf(l));
      for (const s of silk) {
        const pieces = piecesOf(s);
        nearPairs([...pieces, ...openings], rules.silkToMask, (a, b) => {
          if ((a.layer === s) === (b.layer === s)) return;
          const [si, mo] = a.layer === s ? [a, b] : [b, a];
          const r = piecesDist(si, mo);
          if (r.d < rules.silkToMask) out.push({ rule: 'Silk to Mask', layer: s.name, at: r.at, value: r.d, limit: rules.silkToMask, objects: [{ layer: s.name, i: si.i }] });
        });
      }
    }
  }
  return out;
}

/* ─── Copper area, polygons ────────────────────────────────────────────────────────── */

/** Tools › Calc. Copper Area: the copper a layer leaves (dark less clear, a negative layer the other way round), and the board's area. */
export function copperArea(d: CamDocument, l: CamLayer): { copper: number; board: number } {
  const g = l.data as GerberLayer;
  const ext = camExtent({ ...d, layers: d.layers.filter((x) => x.type === 'Border') }, false) ?? camExtent(d, false);
  const board = ext ? (ext.maxX - ext.minX) * (ext.maxY - ext.minY) : 0;
  const dark: Vec2[][] = [], clear: Vec2[][] = [];
  for (const { o } of liveObjects(l)) (o.dark ? dark : clear).push(...coverOf(o, g));
  let area = 0;
  // Dark and clear in order matters little for an area: dark less clear
  const shapes = clipContours('difference', clipContours('union', dark), clear);
  for (const s of shapes) area += signedArea(s);
  area = Math.abs(area);
  return { copper: g.negative ? Math.max(0, board - area) : area, board };
}
const signedArea = (p: Vec2[]) => p.reduce((t, q, i) => t + (q.x * p[(i + 1) % p.length]!.y - p[(i + 1) % p.length]!.x * q.y), 0) / 2;

/** Analysis › Invalid Polygon Search: regions too small to be shapes, with no area, or crossing themselves. */
export function invalidPolygons(d: CamDocument): { layer: CamLayer; i: number; why: string }[] {
  const out: { layer: CamLayer; i: number; why: string }[] = [];
  for (const l of d.layers) {
    for (const { o, i } of liveObjects(l)) {
      if (o.kind !== 'region') continue;
      for (const c of o.contours) {
        if (c.length < 3) { out.push({ layer: l, i, why: 'fewer than three vertices' }); break; }
        if (Math.abs(signedArea(c)) < 1) { out.push({ layer: l, i, why: 'no area' }); break; }
        if (selfCrossing(c)) { out.push({ layer: l, i, why: 'crosses itself' }); break; }
      }
    }
  }
  return out;
}
function selfCrossing(c: Vec2[]): boolean {
  const n = c.length;
  if (n > 400) return false;
  const cross = (o: Vec2, p: Vec2, q: Vec2) => (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const a = c[i]!, b = c[(i + 1) % n]!, p = c[j]!, q = c[(j + 1) % n]!;
    const d1 = cross(p, q, a), d2 = cross(p, q, b), d3 = cross(a, b, p), d4 = cross(a, b, q);
    if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  }
  return false;
}

/* ─── Reports ──────────────────────────────────────────────────────────────────────── */

export type Fmt = (c: number) => string;

/** Reports › PCB RFQ Report: what a fabricator quotes on. */
export function rfqReport(d: CamDocument, f: Fmt, rules?: CamViolation[], checked?: number | null): string {
  const ext = camExtent({ ...d, layers: d.layers.filter((x) => x.type === 'Border' || x.type === 'Mechanical') }, false) ?? camExtent(d, false);
  const copper = copperLayers(d);
  const drills = d.layers.filter((l) => l.data.kind === 'drill');
  const hits = drills.flatMap((l) => { const dd = l.data as DrillLayer, er = new Set(l.erased ?? []); return dd.hits.filter((_, i) => !er.has(i)).map((h) => ({ size: dd.tools.get(h.tool) ?? 0, slot: !!h.slot, plated: platedLayers(d).includes(l) })); });
  let minTrack = Infinity;
  for (const l of copper) { const g = l.data as GerberLayer; for (const { o } of liveObjects(l)) if ((o.kind === 'draw' || o.kind === 'arc') && o.dark) { const a = g.apertures.get(o.ap); if (a) minTrack = Math.min(minTrack, Math.min(a.w, a.h) || a.w); } }
  const minSpace = rules?.filter((v) => v.rule === 'Clearance').reduce((m, v) => Math.min(m, v.value), Infinity);
  const sizes = [...new Set(hits.map((h) => h.size))].sort((a, b) => a - b);
  const rings = annularRings(d);
  const lines = [
    'PCB RFQ Report',
    `Document: ${d.name}`,
    '',
    `Board size: ${ext ? `${f(ext.maxX - ext.minX)} x ${f(ext.maxY - ext.minY)}` : 'unknown'}`,
    `Copper layers: ${copper.length} (${copper.map((l) => `${l.name} ${l.type}`).join(', ') || 'none'})`,
    `Other layers: ${d.layers.filter((l) => !copper.includes(l)).map((l) => `${l.name} ${l.type}`).join(', ') || 'none'}`,
    `Smallest track: ${Number.isFinite(minTrack) ? f(minTrack) : 'none'}`,
    `Smallest spacing: ${minSpace !== undefined && Number.isFinite(minSpace) ? f(minSpace) : rules && checked ? `at least ${f(checked)} (no clearance violations in the last PCB Design Check)` : 'not checked (Analysis › PCB Design Check)'}`,
    `Smallest annular ring: ${rings.length ? f(Math.min(...rings.map((r) => r.ring))) : 'none'}`,
    `Holes: ${hits.length} (${hits.filter((h) => h.plated).length} plated, ${hits.filter((h) => !h.plated).length} non-plated, ${hits.filter((h) => h.slot).length} slots)`,
    `Hole sizes: ${sizes.length} (${sizes.length ? `${f(sizes[0]!)} to ${f(sizes.at(-1)!)}` : 'none'})`,
    `Rout paths: ${drills.reduce((n, l) => n + (l.data as DrillLayer).routes.length, 0)}`,
    `Parts: ${d.parts?.length ?? 0}`,
    `Nets: ${d.nets?.length ?? 'not extracted (Tools › Netlist › Extract)'}`,
  ];
  for (const l of copper) { const a = copperArea(d, l); if (a.board) lines.push(`Copper on ${l.name}: ${((100 * a.copper) / a.board).toFixed(1)}%`); }
  return lines.join('\n');
}

/** Reports › Dcode/Layer Usage: each layer's D-codes and how often it uses them. */
export function dcodeUsage(d: CamDocument, text: (a: import('../gerber/gerberRead').Aperture) => string): string {
  const out = ['Dcode/Layer Usage', ''];
  for (const l of d.layers) {
    if (l.data.kind !== 'gerber') continue;
    const g = l.data;
    const n = new Map<number, number>();
    for (const { o } of liveObjects(l)) if (o.kind !== 'region') n.set(o.ap, (n.get(o.ap) ?? 0) + 1);
    out.push(`${l.name} (${l.type}): ${g.apertures.size} D-codes, ${liveObjects(l).length} objects`);
    for (const code of [...g.apertures.keys()].sort((a, b) => a - b)) out.push(`  D${code}  ${String(n.get(code) ?? 0).padStart(6)}  ${text(g.apertures.get(code)!)}`);
  }
  return out.join('\n');
}

/** Reports › X:Y Coordinates: every flash and hole with its position. */
export function xyReport(d: CamDocument, f: Fmt): string {
  const out = ['X:Y Coordinates', '', 'Layer\tObject\tX\tY\tD-Code / Tool'];
  const o0 = d.origin ?? { x: 0, y: 0 };
  for (const l of d.layers) {
    if (l.data.kind === 'gerber') { for (const { o } of liveObjects(l)) if (o.kind === 'flash') out.push(`${l.name}\tFlash\t${f(o.at.x - o0.x)}\t${f(o.at.y - o0.y)}\tD${o.ap}`); }
    else { const dd = l.data, er = new Set(l.erased ?? []); dd.hits.forEach((h, i) => { if (!er.has(i)) out.push(`${l.name}\t${h.slot ? 'Slot' : 'Hole'}\t${f(h.at.x - o0.x)}\t${f(h.at.y - o0.y)}\tT${String(h.tool).padStart(2, '0')}`); }); }
  }
  return out.join('\n');
}

/** Reports › Rout/Mill: each rout path's tool, start and length. */
export function routReport(d: CamDocument, f: Fmt, points: (r: DrillLayer['routes'][number]) => Vec2[]): string {
  const out = ['Rout/Mill', ''];
  for (const l of d.layers) {
    if (l.data.kind !== 'drill' || !l.data.routes.length) continue;
    const dd = l.data;
    out.push(`${l.name}: ${dd.routes.length} rout path${dd.routes.length === 1 ? '' : 's'}`);
    let total = 0;
    dd.routes.forEach((r, k) => {
      const p = points(r);
      const len = p.reduce((t, q, i) => (i ? t + Math.hypot(q.x - p[i - 1]!.x, q.y - p[i - 1]!.y) : 0), 0);
      total += len;
      out.push(`  ${k + 1}. T${String(r.tool).padStart(2, '0')} (${f(dd.tools.get(r.tool) ?? 0)})${r.circle ? ` circle r ${f(r.circle.r)}` : ''} from ${f(p[0]!.x)}, ${f(p[0]!.y)}  length ${f(len)}${r.comp ? `  compensation ${r.comp === 'L' ? 'left' : 'right'}` : ''}`);
    });
    out.push(`  Total rout length ${f(total)}`);
  }
  if (out.length === 2) out.push('No rout paths.');
  return out.join('\n');
}

/** Reports › DRC/DFM: the last design check's violations. */
export function drcReport(v: CamViolation[], f: Fmt): string {
  const out = ['DRC/DFM', '', `${v.length} violation${v.length === 1 ? '' : 's'}`];
  const by = new Map<string, CamViolation[]>();
  for (const x of v) by.set(x.rule, [...(by.get(x.rule) ?? []), x]);
  for (const [rule, list] of by) {
    out.push('', `${rule} (${list.length})`);
    for (const x of list.slice(0, 500)) out.push(`  ${x.layer}  at ${f(x.at.x)}, ${f(x.at.y)}  ${f(x.value)} (limit ${f(x.limit)})`);
    if (list.length > 500) out.push(`  … and ${list.length - 500} more`);
  }
  return out.join('\n');
}

/** Reports › Netlist: the extracted nets and what's in them. */
export function netlistReport(d: CamDocument): string {
  const nets = d.nets ?? [];
  const out = ['Netlist', '', `${nets.length} net${nets.length === 1 ? '' : 's'}`];
  for (const n of nets) out.push(`${n.name}: ${Object.entries(n.members).map(([l, idx]) => `${l} (${idx.length})`).join(', ')}`);
  return out.join('\n');
}

