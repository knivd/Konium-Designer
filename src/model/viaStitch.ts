/**
 * Tools › Via Stitching/Shielding. Add Stitching to Net: vias of a net on a grid over the board
 * (or a constrained area), only inside the net's poured copper when it has pours [est], each
 * clear of everything else. Add Shielding to Net: vias of a net either side of a net's tracks, a
 * gap from their edges, at a spacing. Removing a group [est]: the vias of the clicked via's net,
 * size and hole that sit on its grid (stitching) or along the shielded tracks (shielding).
 */
import type { BBox, Vec2 } from '../core/geom';
import { pointInPoly } from '../core/geom';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbVia } from './pcb';
import { ruleEnabled, ruleKind, ruleLength } from '../formats/altium/rules';
import { checkCopper } from './drc';
import { L, isSignal, type LayerId } from './layers';
import type { ViaFields } from './pcbEdit';

export interface StitchOptions { net: number; grid: number; diameter: number; hole: number; area?: BBox }
export interface ShieldOptions { net: number; shielded: number; spacing: number; gap: number; diameter: number; hole: number }

const viaProbe = (v: ViaFields): PcbVia => ({ kind: 'via', src: { storage: 'Vias6', index: -1 }, at: v.at, diameter: v.diameter, hole: v.hole, layerStart: v.layerStart ?? L.TOP, layerEnd: v.layerEnd ?? L.BOTTOM, net: v.net ?? NO_NET, locked: false });

/** Vias that don't clash with the board or with each other. */
function keepClear(doc: PcbDocument, cands: ViaFields[]): ViaFields[] {
  if (!cands.length) return [];
  // One check for all: each clash names the new via's index past the board's own
  const base = doc.prims.length;
  const bad = new Set<number>();
  for (const v of checkCopper(doc, cands.map(viaProbe), { ignorePours: true, clearanceOnly: true })) for (const i of v.prims) if (i >= base) bad.add(i - base);
  // Off pads and vias of any net (no via in a pad), holes apart by the Hole To Hole Clearance
  const h2h = doc.rules.filter((r) => ruleKind(r) === 'HoleToHoleClearance' && ruleEnabled(r)).map((r) => ruleLength(r, 'GAP', '10mil'));
  const holeGap = h2h.length ? Math.max(...h2h) : 100_000;
  const solid = doc.prims.filter((p): p is PcbPad | PcbVia => p.kind === 'pad' || p.kind === 'via');
  const reachOf = (p: PcbPad | PcbVia) => (p.kind === 'via' ? p.diameter / 2 : Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h) / 2);
  const clashes = (v: ViaFields) => solid.some((p) => {
    const d = Math.hypot(p.at.x - v.at.x, p.at.y - v.at.y);
    return d < reachOf(p) + v.diameter / 2 || (p.hole > 0 && d < p.hole / 2 + v.hole / 2 + holeGap);
  });
  // The vias are of one net, so they only need to keep apart by their size (and their holes)
  const out: ViaFields[] = [];
  cands.forEach((v, i) => {
    if (bad.has(i) || clashes(v)) return;
    if (out.some((o) => { const d = Math.hypot(o.at.x - v.at.x, o.at.y - v.at.y); return d < (o.diameter + v.diameter) / 2 || d < (o.hole + v.hole) / 2 + holeGap; })) return;
    out.push(v);
  });
  return out;
}

const span = (doc: PcbDocument) => doc.board.copperStack.filter(isSignal);

/** Add Stitching to Net: the vias to place. */
export function planStitching(doc: PcbDocument, o: StitchOptions): ViaFields[] {
  const outline = doc.board.outline;
  if (outline.length < 3 || o.grid <= 0) return [];
  const xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
  let box: BBox = { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  if (o.area) box = { minX: Math.max(box.minX, o.area.minX), minY: Math.max(box.minY, o.area.minY), maxX: Math.min(box.maxX, o.area.maxX), maxY: Math.min(box.maxY, o.area.maxY) };
  // The net's pours, as they are poured now
  const pours = doc.prims.filter((p): p is Extract<PcbPrim, { kind: 'region' }> => p.kind === 'region' && p.polygon !== NO_NET && p.net === o.net && p.outline.length >= 3);
  const inPour = (q: Vec2) => pours.some((r) => pointInPoly(q, r.outline) && !r.holes.some((h) => pointInPoly(q, h)));
  const cutouts = doc.prims.filter((p): p is Extract<PcbPrim, { kind: 'region' }> => p.kind === 'region' && p.boardCutout);
  const layers = span(doc);
  const cands: ViaFields[] = [];
  // On the grid from the board's origin
  const g = o.grid, ox = doc.board.origin.x, oy = doc.board.origin.y;
  for (let x = Math.ceil((box.minX - ox) / g) * g + ox; x <= box.maxX; x += g) {
    for (let y = Math.ceil((box.minY - oy) / g) * g + oy; y <= box.maxY; y += g) {
      const at = { x: Math.round(x), y: Math.round(y) };
      if (!pointInPoly(at, outline) || cutouts.some((c) => pointInPoly(at, c.outline))) continue;
      if (pours.length && !inPour(at)) continue;
      cands.push({ at, diameter: o.diameter, hole: o.hole, net: o.net, layerStart: layers[0] ?? L.TOP, layerEnd: layers.at(-1) ?? L.BOTTOM });
    }
  }
  // Clear of the board's edge too
  const edgeGap = o.diameter / 2;
  const inside = cands.filter((v) => outline.every((p, i) => { const q = outline[(i + 1) % outline.length]!; return segDist(v.at, p, q) >= edgeGap; }));
  return keepClear(doc, inside);
}

function segDist(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Add Shielding to Net: vias either side of the shielded net's tracks. */
export function planShielding(doc: PcbDocument, o: ShieldOptions): ViaFields[] {
  const layers = span(doc);
  const cands: ViaFields[] = [];
  for (const t of doc.prims) {
    if (t.kind !== 'track' || t.net !== o.shielded || t.polygon !== NO_NET || !isSignal(t.layer)) continue;
    const len = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y);
    if (len < 1) continue;
    const d = { x: (t.b.x - t.a.x) / len, y: (t.b.y - t.a.y) / len }, n = { x: -d.y, y: d.x };
    const off = t.width / 2 + o.gap + o.diameter / 2;
    const count = Math.max(1, Math.floor(len / o.spacing));
    const step = len / count;
    for (let k = 0; k <= count; k++) for (const s of [1, -1]) {
      const at = { x: Math.round(t.a.x + d.x * step * k + n.x * off * s), y: Math.round(t.a.y + d.y * step * k + n.y * off * s) };
      if (cands.some((c) => Math.hypot(c.at.x - at.x, c.at.y - at.y) < o.spacing / 2)) continue;
      cands.push({ at, diameter: o.diameter, hole: o.hole, net: o.net, layerStart: layers[0] ?? L.TOP, layerEnd: layers.at(-1) ?? L.BOTTOM });
    }
  }
  const outline = doc.board.outline;
  return keepClear(doc, outline.length >= 3 ? cands.filter((v) => pointInPoly(v.at, outline)) : cands);
}

/** The stitching group a via belongs to [est]: free vias of its net, size and hole on its grid. */
export function stitchGroup(doc: PcbDocument, via: PcbVia): PcbVia[] {
  const mates = doc.prims.filter((p): p is PcbVia => p.kind === 'via' && p.net === via.net && p.diameter === via.diameter && p.hole === via.hole);
  // The grid: the smallest step to a neighbour along x or y
  let g = Infinity;
  for (const m of mates) {
    const dx = Math.abs(m.at.x - via.at.x), dy = Math.abs(m.at.y - via.at.y);
    if (dy < 2 && dx > 2) g = Math.min(g, dx);
    if (dx < 2 && dy > 2) g = Math.min(g, dy);
  }
  if (!Number.isFinite(g)) return [via];
  const on = (v: number) => { const r = Math.abs(v) % g; return r < 2 || g - r < 2; };
  return mates.filter((m) => on(m.at.x - via.at.x) && on(m.at.y - via.at.y));
}

/** The shielding group a via belongs to [est]: vias of its net and size beside the same shielded net's tracks at the via's distance. */
export function shieldGroup(doc: PcbDocument, via: PcbVia): PcbVia[] {
  // The nearest track of another net is what it shields
  let best: { net: number; d: number; layer: LayerId } | null = null;
  for (const t of doc.prims) {
    if (t.kind !== 'track' || t.net === via.net || t.net === NO_NET) continue;
    const d = segDist(via.at, t.a, t.b) - t.width / 2;
    if (!best || d < best.d) best = { net: t.net, d, layer: t.layer };
  }
  if (!best) return [via];
  const shielded = best.net, dist = best.d;
  const tracks = doc.prims.filter((p): p is Extract<PcbPrim, { kind: 'track' }> => p.kind === 'track' && p.net === shielded);
  return doc.prims.filter((p): p is PcbVia => p.kind === 'via' && p.net === via.net && p.diameter === via.diameter && p.hole === via.hole
    && tracks.some((t) => Math.abs(segDist(p.at, t.a, t.b) - t.width / 2 - dist) < Math.max(20_000, via.diameter * 0.1)));
}
