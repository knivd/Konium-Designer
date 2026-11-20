/**
 * The CAM editor's processes (CAMtastic's Tools, Rout and Analysis menus) as shape work on a
 * document: copper poured round what's there, venting, teardrops, silk trimmed off the pads, pads
 * nothing connects to taken off, apertures spread or reduced, closed polylines made polygons,
 * boundaries cleaned, filled and outlined, the drill drawing, panels and film placement, SMT stencil
 * home plates and epoxy dots, and rout paths: round the board's border, tabs, arcs and circles fitted.
 */
import type { BBox, Vec2 } from '../../core/geom';
import type { DrillLayer, DrillRoute, GerberLayer, GerberObject } from '../gerber/gerberRead';
import { camExtent, type CamDocument, type CamLayer } from './camDoc';
import { customAperture, findOrAddAperture, liveObjects, moveXf, xfHit, xfObject, xfRoute } from './camModel';
import { chainPoints, chains, circle3, coverOf } from './camOps';
import { clipContours, offsetOutline } from '../../model/outlineOps';
import { boxOf, inside, piecesOf, platedLayers, type Piece } from './camAnalysis';
import { drawLegend, drawSymbol } from '../gerber/drillDrawing';
import type { PlotSink } from '../gerber/gerber';
import type { PcbDocument } from '../../model/pcb';

type Draw = Extract<GerberObject, { kind: 'draw' }>;
const area = (p: Vec2[]) => p.reduce((t, q, i) => t + (q.x * p[(i + 1) % p.length]!.y - p[(i + 1) % p.length]!.x * q.y), 0) / 2;

/* ─── The board's outline ──────────────────────────────────────────────────────────── */

/**
 * The board's outline: the largest closed polyline on a Border (or Mechanical / Keep Out) layer, else the
 * extent of everything [est: CAMtastic's border detection].
 */
export function boardOutline(d: CamDocument): Vec2[] {
  for (const type of ['Border', 'Keep Out', 'Mechanical']) {
    let best: Vec2[] | null = null;
    for (const l of d.layers.filter((x) => x.type === type && x.data.kind === 'gerber')) {
      const g = l.data as GerberLayer;
      const objs = liveObjects(l);
      for (const c of chains(objs)) {
        if (!c.closed) continue;
        const pts = chainPoints(g, c.items);
        if (!best || Math.abs(area(pts)) > Math.abs(area(best))) best = pts;
      }
      for (const { o } of objs) if (o.kind === 'region' && o.contours[0] && (!best || Math.abs(area(o.contours[0])) > Math.abs(area(best)))) best = o.contours[0];
    }
    if (best && best.length >= 3) return best;
  }
  const e = camExtent(d, false);
  return e ? [{ x: e.minX, y: e.minY }, { x: e.maxX, y: e.minY }, { x: e.maxX, y: e.maxY }, { x: e.minX, y: e.maxY }] : [];
}

/* ─── Copper pour, venting ─────────────────────────────────────────────────────────── */

/** Tools › Copper Pour: the area (the board less a margin) filled, everything on the layer kept `clearance` clear [est: CAMtastic's pour]. */
export function copperPour(d: CamDocument, l: CamLayer, clearance: number, margin: number, area0?: Vec2[]): GerberObject[] {
  const g = l.data as GerberLayer;
  const outline = area0 ?? boardOutline(d);
  if (outline.length < 3) return [];
  const within = margin ? offsetOutline(outline, -margin) : [outline];
  const keepOut: Vec2[][] = [];
  for (const { o } of liveObjects(l)) for (const c of coverOf(o, g)) keepOut.push(...offsetOutline(c, clearance));
  // Holes are kept clear too
  for (const dl of d.layers.filter((x) => x.data.kind === 'drill')) {
    const dd = dl.data as DrillLayer;
    for (const h of dd.hits) { const r = (dd.tools.get(h.tool) ?? 0) / 2 + clearance; keepOut.push(Array.from({ length: 24 }, (_, k) => ({ x: h.at.x + r * Math.cos((k * Math.PI) / 12), y: h.at.y + r * Math.sin((k * Math.PI) / 12) }))); }
  }
  const shapes = clipContours('difference', within, keepOut.length ? clipContours('union', keepOut) : []);
  // Outer contours with the holes inside them, as one region each
  return groupContours(shapes).map((contours) => ({ kind: 'region' as const, contours, dark: true }));
}

/** Contours (outers and holes, as Clipper gives them) grouped: each outer with the holes inside it. */
export function groupContours(shapes: Vec2[][]): Vec2[][][] {
  const depth = shapes.map((s, i) => shapes.filter((t, j) => j !== i && inside(s[0]!, t)).length);
  const outers = shapes.map((s, i) => [s, i] as const).filter(([, i]) => depth[i]! % 2 === 0);
  return outers.map(([o, oi]) => [o, ...shapes.filter((s, j) => depth[j] === depth[oi]! + 1 && inside(s[0]!, o))]);
}

/** Tools › Venting: a grid of dots (or squares) in the copper-free parts of a layer, clear of copper and the board's edge. */
export function venting(d: CamDocument, l: CamLayer, o: { pitch: number; size: number; square: boolean; clearance: number; margin: number }): GerberObject[] {
  const g = l.data as GerberLayer;
  const outline = boardOutline(d);
  if (outline.length < 3) return [];
  const within = o.margin ? offsetOutline(outline, -o.margin) : [outline];
  const pieces = piecesOf(l);
  const ap = findOrAddAperture(g, o.square ? 'R' : 'C', o.size);
  const b = boxOf(within.flat());
  const out: GerberObject[] = [];
  const r = o.size / 2 + o.clearance;
  const grid = new Map<string, Piece[]>();
  const cell = Math.max(o.pitch * 4, 1);
  for (const p of pieces) for (let x = Math.floor(p.box.minX / cell); x <= Math.floor(p.box.maxX / cell); x++) for (let y = Math.floor(p.box.minY / cell); y <= Math.floor(p.box.maxY / cell); y++) { const k = `${x},${y}`; grid.set(k, [...(grid.get(k) ?? []), p]); }
  for (let y = b.minY + o.pitch / 2; y <= b.maxY; y += o.pitch) {
    for (let x = b.minX + o.pitch / 2; x <= b.maxX; x += o.pitch) {
      const at = { x: Math.round(x), y: Math.round(y) };
      if (!within.some((w) => inside(at, w))) continue;
      const near = new Set<Piece>();
      for (let gx = Math.floor((at.x - r) / cell); gx <= Math.floor((at.x + r) / cell); gx++) for (let gy = Math.floor((at.y - r) / cell); gy <= Math.floor((at.y + r) / cell); gy++) for (const p of grid.get(`${gx},${gy}`) ?? []) near.add(p);
      let clash = false;
      for (const p of near) {
        if (p.box.minX - r > at.x || p.box.maxX + r < at.x || p.box.minY - r > at.y || p.box.maxY + r < at.y) continue;
        if (p.polys.some((q) => inside(at, q) || q.some((v, i) => { const w = q[(i + 1) % q.length]!; const dx = w.x - v.x, dy = w.y - v.y, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((at.x - v.x) * dx + (at.y - v.y) * dy) / l2)) : 0; return Math.hypot(at.x - v.x - t * dx, at.y - v.y - t * dy) < r; }))) { clash = true; break; }
      }
      if (!clash) out.push({ kind: 'flash', at, ap, dark: true });
    }
  }
  return out;
}

/* ─── Teardrops, pad removal, spread ───────────────────────────────────────────────── */

/** Tools › Teardrops: where a track ends on a round pad, a teardrop joining them (`ratio` of the pad's radius along the track). */
export function teardrops(l: CamLayer, ratio = 1.5): GerberObject[] {
  const g = l.data as GerberLayer;
  const objs = liveObjects(l);
  const pads = objs.filter(({ o }) => o.kind === 'flash' && o.dark && ['C', 'O', 'R'].includes(g.apertures.get((o as { ap: number }).ap)?.shape ?? '')) as { o: Extract<GerberObject, { kind: 'flash' }>; i: number }[];
  const out: GerberObject[] = [];
  for (const { o } of objs) {
    if (o.kind !== 'draw' || !o.dark) continue;
    const a = g.apertures.get(o.ap);
    if (!a || a.shape !== 'C') continue;
    const tw = a.w / 2;
    for (const end of ['a', 'b'] as const) {
      const p = o[end], other = end === 'a' ? o.b : o.a;
      const pad = pads.find(({ o: f }) => Math.hypot(f.at.x - p.x, f.at.y - p.y) < 1000);
      if (!pad) continue;
      const pa = g.apertures.get(pad.o.ap)!;
      const R = Math.min(pa.w, pa.h) / 2;
      if (R <= tw * 1.2) continue;
      const len = Math.hypot(other.x - p.x, other.y - p.y);
      const reach = Math.min(R * ratio, len);
      if (reach <= R * 0.5) continue;
      const u = { x: (other.x - p.x) / len, y: (other.y - p.y) / len }, n = { x: -u.y, y: u.x };
      const tip = { x: p.x + u.x * reach, y: p.y + u.y * reach };
      // From the track's edges at the tip to the pad's edge either side, a little round the pad
      const side = (s: number) => { const ang = Math.atan2(n.y * s, n.x * s) + (s > 0 ? -0.35 : 0.35); return { x: p.x + R * 0.98 * Math.cos(ang), y: p.y + R * 0.98 * Math.sin(ang) }; };
      out.push({ kind: 'region', contours: [[{ x: tip.x + n.x * tw, y: tip.y + n.y * tw }, side(1), p, side(-1), { x: tip.x - n.x * tw, y: tip.y - n.y * tw }]], dark: true });
    }
  }
  return out;
}

/** Tools › Pad Removal: pads on the layers given that sit on a hole and touch nothing else there (non-functional inner pads). */
export function nonFunctionalPads(d: CamDocument, layers: CamLayer[]): { layer: CamLayer; i: number }[] {
  const holes = platedLayers(d).flatMap((l) => (l.data as DrillLayer).hits.map((h) => h.at));
  const key = (p: Vec2) => `${Math.round(p.x / 5000)},${Math.round(p.y / 5000)}`;
  const holeSet = new Set(holes.map(key));
  const out: { layer: CamLayer; i: number }[] = [];
  for (const l of layers) {
    if (l.data.kind !== 'gerber' || l.data.negative) continue;
    const pieces = piecesOf(l);
    for (const p of pieces) {
      const o = (l.data as GerberLayer).objects[p.i]!;
      if (o.kind !== 'flash' || !holeSet.has(key(o.at))) continue;
      const touches = pieces.some((q) => q !== p && !(q.box.maxX < p.box.minX || p.box.maxX < q.box.minX || q.box.maxY < p.box.minY || p.box.maxY < q.box.minY) && q.polys.some((a) => p.polys.some((b) => a.some((v) => inside(v, b)) || b.some((v) => inside(v, a)))));
      if (!touches) out.push({ layer: l, i: p.i });
    }
  }
  return out;
}

/* ─── Silk ─────────────────────────────────────────────────────────────────────────── */

/** A line's parts outside the polygons (the parts inside cut away). */
export function clipLineOutside(a: Vec2, b: Vec2, polys: Vec2[][]): [Vec2, Vec2][] {
  const ts: number[] = [0, 1];
  for (const p of polys) for (let i = 0; i < p.length; i++) {
    const c = p[i]!, e = p[(i + 1) % p.length]!;
    const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: e.x - c.x, y: e.y - c.y };
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den, u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((x, y) => x - y);
  const out: [Vec2, Vec2][] = [];
  const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  for (let k = 1; k < ts.length; k++) {
    const t0 = ts[k - 1]!, t1 = ts[k]!;
    if (t1 - t0 < 1e-9) continue;
    const mid = at((t0 + t1) / 2);
    if (!polys.some((p) => inside(mid, p))) out.push([at(t0), at(t1)]);
  }
  return out;
}

/**
 * Tools › Trim Silkscreen: silk draws cut back where they cross the mask's openings (grown by the
 * clearance) on their side; arcs walked as draws where they're cut; flashes and polygons in an opening
 * taken off. Returns, by silk layer, the objects to erase and those to add.
 */
export function trimSilk(d: CamDocument, clearance: number): { layer: CamLayer; erase: number[]; add: GerberObject[] }[] {
  const out: { layer: CamLayer; erase: number[]; add: GerberObject[] }[] = [];
  for (const side of ['Top', 'Bottom'] as const) {
    const mask = d.layers.filter((l) => l.type === `${side} Mask` && l.data.kind === 'gerber');
    const cut = mask.flatMap((l) => piecesOf(l)).flatMap((p) => p.polys.flatMap((q) => (clearance ? offsetOutline(q, clearance) : [q])));
    if (!cut.length) continue;
    const boxes = cut.map((c) => boxOf(c));
    for (const s of d.layers.filter((l) => l.type === `${side} Silk` && l.data.kind === 'gerber')) {
      const g = s.data as GerberLayer;
      const erase: number[] = [], add: GerberObject[] = [];
      for (const { o, i } of liveObjects(s)) {
        const pts = o.kind === 'draw' ? [o.a, o.b] : o.kind === 'arc' ? chainPoints(g, [{ i, rev: false }]) : o.kind === 'flash' ? [o.at] : o.contours.flat();
        const b = boxOf(pts);
        const hit = cut.filter((_, k) => !(boxes[k]!.maxX < b.minX - 1e5 || boxes[k]!.minX > b.maxX + 1e5 || boxes[k]!.maxY < b.minY - 1e5 || boxes[k]!.minY > b.maxY + 1e5));
        if (!hit.length) continue;
        if (o.kind === 'draw' || o.kind === 'arc') {
          const pieces: [Vec2, Vec2][] = [];
          for (let k = 1; k < pts.length; k++) pieces.push(...clipLineOutside(pts[k - 1]!, pts[k]!, hit));
          const total = pts.reduce((t, p, k) => (k ? t + Math.hypot(p.x - pts[k - 1]!.x, p.y - pts[k - 1]!.y) : 0), 0);
          const kept = pieces.reduce((t, [p, q]) => t + Math.hypot(q.x - p.x, q.y - p.y), 0);
          if (Math.abs(kept - total) < 1) continue;
          erase.push(i);
          for (const [p, q] of pieces) add.push({ kind: 'draw', a: p, b: q, ap: o.ap, dark: o.dark, ...(o.grp ? { grp: o.grp } : {}) });
        } else if (pts.some((p) => hit.some((h) => inside(p, h)))) erase.push(i);
      }
      if (erase.length) out.push({ layer: s, erase, add });
    }
  }
  return out;
}

/* ─── Convert, boundaries ──────────────────────────────────────────────────────────── */

/**
 * Tools › Convert: closed polylines (draws and arcs meeting end to end) made polygons — solid with the
 * closed polylines inside them as voids (`voids`), cut-outs (clear polygons), or solid regions as they are.
 */
export function closedToRegions(g: GerberLayer, objs: { o: GerberObject; i: number }[], mode: 'solid-voids' | 'cutout' | 'solid'): { erase: number[]; add: GerberObject[] } {
  const loops = chains(objs).filter((c) => c.closed).map((c) => ({ c, pts: chainPoints(g, c.items).slice(0, -1) }));
  if (!loops.length) return { erase: [], add: [] };
  const erase = loops.flatMap(({ c }) => c.items.map((x) => x.i));
  const dark = objs.find((x) => x.i === loops[0]!.c.items[0]!.i)?.o.dark ?? true;
  if (mode !== 'solid-voids') return { erase, add: loops.map(({ pts }) => ({ kind: 'region' as const, contours: [pts], dark: mode === 'cutout' ? false : dark })) };
  const shapes = loops.map((x) => x.pts);
  return { erase, add: groupContours(shapes).map((contours) => ({ kind: 'region' as const, contours, dark })) };
}

/** Analysis › Clean Boundaries: draws of no length or repeated taken off; draws in a line along a polyline made one. */
export function cleanBoundaries(l: CamLayer): { erase: number[]; replace: Map<number, GerberObject> } {
  const objs = liveObjects(l);
  const erase = new Set<number>(), replace = new Map<number, GerberObject>();
  const seen = new Map<string, number>();
  for (const { o, i } of objs) {
    if (o.kind !== 'draw') continue;
    if (Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y) < 1 && o.grp) { erase.add(i); continue; }
    const k1 = `${o.ap}|${o.dark}|${Math.round(o.a.x)},${Math.round(o.a.y)}|${Math.round(o.b.x)},${Math.round(o.b.y)}`, k2 = `${o.ap}|${o.dark}|${Math.round(o.b.x)},${Math.round(o.b.y)}|${Math.round(o.a.x)},${Math.round(o.a.y)}`;
    if (seen.has(k1) || seen.has(k2)) { erase.add(i); continue; }
    seen.set(k1, i);
  }
  // Collinear neighbours in a chain merged
  for (const c of chains(objs.filter(({ i }) => !erase.has(i)))) {
    let run: { i: number; rev: boolean }[] = [];
    const flush = () => {
      if (run.length > 1) {
        const first = l.data.kind === 'gerber' ? l.data.objects[run[0]!.i] as Draw : null, last = l.data.kind === 'gerber' ? l.data.objects[run.at(-1)!.i] as Draw : null;
        if (first && last) {
          const a = run[0]!.rev ? first.b : first.a, b = run.at(-1)!.rev ? last.a : last.b;
          replace.set(run[0]!.i, { ...first, a, b });
          for (const x of run.slice(1)) erase.add(x.i);
        }
      }
      run = [];
    };
    for (const it of c.items) {
      const o = (l.data as GerberLayer).objects[it.i]!;
      if (o.kind !== 'draw') { flush(); continue; }
      if (!run.length) { run.push(it); continue; }
      const prev = (l.data as GerberLayer).objects[run.at(-1)!.i] as Draw;
      const pa = run.at(-1)!.rev ? prev.b : prev.a, pb = run.at(-1)!.rev ? prev.a : prev.b;
      const qa = it.rev ? o.b : o.a, qb = it.rev ? o.a : o.b;
      const cross = (pb.x - pa.x) * (qb.y - qa.y) - (pb.y - pa.y) * (qb.x - qa.x);
      const lp = Math.hypot(pb.x - pa.x, pb.y - pa.y), lq = Math.hypot(qb.x - qa.x, qb.y - qa.y);
      const dot = (pb.x - pa.x) * (qb.x - qa.x) + (pb.y - pa.y) * (qb.y - qa.y);
      if (prev.ap === o.ap && lp && lq && Math.abs(cross) / (lp * lq) < 1e-4 && dot > 0) run.push(it);
      else { flush(); run.push(it); }
    }
    flush();
  }
  return { erase: [...erase], replace };
}

/** Analysis › Fill Boundaries: a polygon (or closed polyline) painted with parallel draws of the aperture, and its outline. */
export function fillBoundary(contours: Vec2[][], ap: number, w: number, dark: boolean, angle = 0): GerberObject[] {
  const out: GerberObject[] = [];
  const rot = (p: Vec2, s: number) => { const a = (s * angle * Math.PI) / 180, c = Math.cos(a), si = Math.sin(a); return { x: p.x * c - p.y * si, y: p.x * si + p.y * c }; };
  const local = contours.map((c) => c.map((p) => rot(p, -1)));
  const b = boxOf(local.flat());
  const step = Math.max(w * 0.9, 1);
  for (let y = b.minY + w / 2; y <= b.maxY - w / 2 + 1; y += step) {
    const xs: number[] = [];
    for (const c of local) for (let i = 0; i < c.length; i++) {
      const p = c[i]!, q = c[(i + 1) % c.length]!;
      if ((p.y > y) !== (q.y > y)) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
    }
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = xs[k]! + w / 2, e = xs[k + 1]! - w / 2;
      if (e >= a) out.push({ kind: 'draw', a: rot({ x: a, y }, 1), b: rot({ x: e, y }, 1), ap, dark });
    }
  }
  for (const c of contours) for (let i = 0; i < c.length; i++) out.push({ kind: 'draw', a: c[i]!, b: c[(i + 1) % c.length]!, ap, dark });
  return out;
}

/** Analysis › Generate Outlines: what objects cover, as closed outlines (draws of the aperture given). */
export function outlinesOf(objs: GerberObject[], g: GerberLayer, ap: number): GerberObject[] {
  const shapes = clipContours('union', objs.filter((o) => o.dark).flatMap((o) => coverOf(o, g)));
  const out: GerberObject[] = [];
  for (const s of shapes) for (let i = 0; i < s.length; i++) out.push({ kind: 'draw', a: s[i]!, b: s[(i + 1) % s.length]!, ap, dark: true });
  return out;
}

/* ─── Fabrication drawing ──────────────────────────────────────────────────────────── */

/** Analysis › Create Fab Drawing (from Drill): a symbol at each hole, one per size and plating, and the drill table under the board. */
export function fabDrawing(d: CamDocument, g: GerberLayer, symbolSize: number, textHeight: number, metric: boolean): GerberObject[] {
  const out: GerberObject[] = [];
  const sink: PlotSink = {
    line: (a, b, w) => { out.push({ kind: 'draw', a, b, ap: findOrAddAperture(g, 'C', Math.max(w, 1)), dark: true }); },
    polyline: (pts, w) => { const ap = findOrAddAperture(g, 'C', Math.max(w, 1)); for (let k = 1; k < pts.length; k++) out.push({ kind: 'draw', a: pts[k - 1]!, b: pts[k]!, ap, dark: true }); if (pts.length === 1) out.push({ kind: 'draw', a: pts[0]!, b: pts[0]!, ap, dark: true }); },
    arc: () => {}, dot: (at, dia) => { out.push({ kind: 'flash', at, ap: findOrAddAperture(g, 'C', dia), dark: true }); }, pad: () => {}, regionHoles: () => {}, region: () => {},
  };
  const groups: { size: number; plated: boolean; holes: { at: Vec2; size: number; plated: boolean }[]; symbol: number }[] = [];
  const plated = new Set(platedLayers(d));
  for (const l of d.layers.filter((x) => x.data.kind === 'drill')) {
    const dd = l.data as DrillLayer, er = new Set(l.erased ?? []);
    dd.hits.forEach((h, i) => {
      if (er.has(i)) return;
      const size = dd.tools.get(h.tool) ?? 0, p = plated.has(l);
      let grp = groups.find((x) => Math.abs(x.size - size) < 100 && x.plated === p);
      if (!grp) { grp = { size, plated: p, holes: [], symbol: groups.length }; groups.push(grp); }
      grp.holes.push({ at: h.at, size, plated: p });
    });
  }
  groups.sort((a, b) => a.size - b.size || Number(b.plated) - Number(a.plated)).forEach((x, k) => { x.symbol = k; });
  const sym = { kind: 'graphic' as const, size: symbolSize };
  for (const grp of groups) for (const h of grp.holes) drawSymbol(sink, h.at, grp.symbol, sym, grp.size, metric);
  const e = camExtent(d, false);
  if (e && groups.length) drawLegend(sink, {} as PcbDocument, groups, sym, { x: e.minX, y: e.minY - textHeight * 3 }, textHeight, metric);
  return out;
}

/* ─── Panel and film ───────────────────────────────────────────────────────────────── */

/**
 * Tools › Panelize PCB: every layer stepped and repeated nx × ny, the board's size plus the gaps apart
 * (a %SR% block of each layer's objects; drill layers' hits and routs copied), and a frame round the
 * panel on the border layer when asked.
 */
export function panelise(d: CamDocument, nx: number, ny: number, gapX: number, gapY: number): { dx: number; dy: number } {
  const e = camExtent({ ...d, layers: d.layers.filter((l) => l.type === 'Border') }, false) ?? camExtent(d, false);
  if (!e) return { dx: 0, dy: 0 };
  const dx = e.maxX - e.minX + gapX, dy = e.maxY - e.minY + gapY;
  for (const l of d.layers) {
    if (l.data.kind === 'gerber') {
      const g = l.data;
      const id = Math.max(0, ...(g.steps ?? []).map((s) => s.id)) + 1;
      const er = new Set(l.erased ?? []);
      const base = g.objects.map((o, i) => [o, i] as const).filter(([o, i]) => !er.has(i) && !o.sr);
      if (!base.length) continue;
      g.steps = [...(g.steps ?? []), { id, nx, ny, dx, dy }];
      for (const [o, i] of base) g.objects[i] = { ...o, sr: id };
      for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) if (a || b) for (const [o] of base) g.objects.push({ ...xfObject(o, moveXf(a * dx, b * dy)), sr: id, srCopy: true });
    } else {
      const dd = l.data, er = new Set(l.erased ?? []);
      const hits = dd.hits.filter((_, i) => !er.has(i)), routes = [...dd.routes];
      for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) {
        if (!a && !b) continue;
        const t = moveXf(a * dx, b * dy);
        for (const h of hits) dd.hits.push({ ...xfHit(h, t), grp: undefined });
        for (const r of routes) dd.routes.push(xfRoute(r, t));
      }
    }
  }
  return { dx, dy };
}

/** Tools › Film Wizard: the film box of a film size, the image centred on it (`centre`) — the move to make. */
export function filmPlacement(d: CamDocument, w: number, h: number, centre: boolean): { box: BBox; move: Vec2 } {
  const e = camExtent(d, false) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const cx = (e.minX + e.maxX) / 2, cy = (e.minY + e.maxY) / 2;
  if (!centre) return { box: { minX: e.minX, minY: e.minY, maxX: e.minX + w, maxY: e.minY + h }, move: { x: 0, y: 0 } };
  // The film's lower-left at the origin, the image centred on it
  return { box: { minX: 0, minY: 0, maxX: w, maxY: h }, move: { x: Math.round(w / 2 - cx), y: Math.round(h / 2 - cy) } };
}

/* ─── SMT stencil ──────────────────────────────────────────────────────────────────── */

/**
 * Tools › SMT Stencil › Homebase Pad Conversion: a rectangular paste opening made a "home plate" — its inner
 * end (towards the part's centre) cut to a point, `cut` of its length [est: the shape]. Returns the flashes to replace.
 */
export function homebase(l: CamLayer, cut = 0.25, partOf?: (p: Vec2) => Vec2 | undefined): Map<number, GerberObject> {
  const g = l.data as GerberLayer;
  const out = new Map<number, GerberObject>();
  const objs = liveObjects(l).filter(({ o }) => o.kind === 'flash' && g.apertures.get((o as { ap: number }).ap)?.shape === 'R') as { o: Extract<GerberObject, { kind: 'flash' }>; i: number }[];
  // The centre each pad points towards: its part's, else the nearest other pad's
  for (const { o, i } of objs) {
    const a = g.apertures.get(o.ap)!;
    let target = partOf?.(o.at);
    if (!target) { let best = Infinity; for (const { o: q } of objs) { if (q === o) continue; const dd = Math.hypot(q.at.x - o.at.x, q.at.y - o.at.y); if (dd < best && dd < 5 * Math.max(a.w, a.h)) { best = dd; target = q.at; } } }
    if (!target) continue;
    const dir = { x: target.x - o.at.x, y: target.y - o.at.y };
    const along = Math.abs(dir.x) >= Math.abs(dir.y) ? 'x' : 'y';
    const s = Math.sign(along === 'x' ? dir.x : dir.y) || 1;
    const hw = a.w / 2, hh = a.h / 2;
    let poly: Vec2[];
    if (along === 'x') { const c = a.w * cut; poly = [{ x: -s * hw, y: -hh }, { x: s * (hw - c), y: -hh }, { x: s * hw, y: 0 }, { x: s * (hw - c), y: hh }, { x: -s * hw, y: hh }]; }
    else { const c = a.h * cut; poly = [{ x: -hw, y: -s * hh }, { x: -hw, y: s * (hh - c) }, { x: 0, y: s * hh }, { x: hw, y: s * (hh - c) }, { x: hw, y: -s * hh }]; }
    out.set(i, { ...o, ap: customAperture(g, [{ dark: true, poly }]) });
  }
  return out;
}

/**
 * Tools › SMT Stencil › Add Epoxy Bars: between the two pads of each two-pad part (pairs of like pads near
 * each other with nothing else between): where a bar goes and which way it runs [est: the pairing].
 */
export function epoxyBars(src: CamLayer, maxGap: number): { at: Vec2; along: 'x' | 'y' }[] {
  const g = src.data as GerberLayer;
  const pads = liveObjects(src).filter(({ o }) => o.kind === 'flash' && o.dark) as { o: Extract<GerberObject, { kind: 'flash' }>; i: number }[];
  const used = new Set<number>();
  const out: { at: Vec2; along: 'x' | 'y' }[] = [];
  for (const { o, i } of pads) {
    if (used.has(i)) continue;
    const a = g.apertures.get(o.ap);
    if (!a) continue;
    let best: { o: Extract<GerberObject, { kind: 'flash' }>; i: number } | null = null, bd = Infinity;
    for (const q of pads) {
      const qa = g.apertures.get(q.o.ap);
      // Like pads: the same size (their D-codes may differ)
      if (q.i === i || used.has(q.i) || !qa || Math.abs(qa.w - a.w) > 1000 || Math.abs(qa.h - a.h) > 1000) continue;
      const dd = Math.hypot(q.o.at.x - o.at.x, q.o.at.y - o.at.y);
      if (dd < bd && dd <= maxGap + Math.max(a.w, a.h)) { bd = dd; best = q; }
    }
    if (!best) continue;
    const mid = { x: (o.at.x + best.o.at.x) / 2, y: (o.at.y + best.o.at.y) / 2 };
    // Nothing else between them
    if (pads.some((q) => q.i !== i && q.i !== best!.i && Math.hypot(q.o.at.x - mid.x, q.o.at.y - mid.y) < bd / 2)) continue;
    used.add(i); used.add(best.i);
    out.push({ at: mid, along: Math.abs(best.o.at.x - o.at.x) >= Math.abs(best.o.at.y - o.at.y) ? 'y' : 'x' });
  }
  return out;
}

/* ─── Rout ─────────────────────────────────────────────────────────────────────────── */

/** A rout path round an outline, the tool's radius off it (outside, or inside a cut-out), climbing counter-clockwise [est]. */
export function routAround(outline: Vec2[], toolDia: number, outside: boolean, tool: number): DrillRoute | null {
  const ccw = area(outline) > 0 ? outline : [...outline].reverse();
  const off = offsetOutline(ccw, (outside ? 1 : -1) * (toolDia / 2))[0];
  if (!off || off.length < 3) return null;
  const path = area(off) > 0 ? off : [...off].reverse();
  return { tool, path: [...path, path[0]!] };
}

/** Rout › Add Tabs: a rout path broken at a point, a gap of `width` left uncut (the tab). */
export function addTab(r: DrillRoute, at: Vec2, width: number): DrillRoute[] | null {
  if (r.circle || r.path.length < 2) return null;
  // The segment nearest the point
  let best = -1, bd = Infinity, bt = 0;
  for (let k = 1; k < r.path.length; k++) {
    const a = r.path[k - 1]!, b = r.path[k]!, dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(at.x - a.x - t * dx, at.y - a.y - t * dy);
    if (d < bd) { bd = d; best = k; bt = t; }
  }
  const a = r.path[best - 1]!, b = r.path[best]!, len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!len || len < width) return null;
  const t0 = Math.max(0, bt - width / 2 / len), t1 = Math.min(1, bt + width / 2 / len);
  const p0 = { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 }, p1 = { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 };
  const keepArcs = (from: number, to: number, shift: number) => (r.arcs ?? []).filter((x) => x.i >= from && x.i < to).map((x) => ({ ...x, i: x.i - shift }));
  const first: DrillRoute = { ...r, path: [...r.path.slice(0, best), p0], arcs: keepArcs(0, best - 1, 0) };
  const second: DrillRoute = { ...r, path: [p1, ...r.path.slice(best)], arcs: keepArcs(best, r.path.length, best - 1) };
  // A closed path's two ends meet: one path from the tab round to the tab
  const closed = Math.hypot(r.path[0]!.x - r.path.at(-1)!.x, r.path[0]!.y - r.path.at(-1)!.y) < 1;
  if (closed) return [{ ...r, path: [...second.path, ...first.path.slice(1)], arcs: [...(second.arcs ?? []), ...(first.arcs ?? []).map((x) => ({ ...x, i: x.i + second.path.length - 1 }))] }];
  return [first, second].filter((x) => x.path.length > 1);
}

/** Rout › Convert Lines to Arc: runs of three or more segments on one circle (within tol) made one arc each. */
export function linesToArcs(r: DrillRoute, tol: number): DrillRoute {
  if (r.circle || r.path.length < 4) return r;
  const path = r.path;
  const out: Vec2[] = [path[0]!];
  const arcs: NonNullable<DrillRoute['arcs']> = [];
  let k = 0;
  const existing = new Map((r.arcs ?? []).map((a) => [a.i, a]));
  while (k < path.length - 1) {
    if (existing.has(k)) { arcs.push({ ...existing.get(k)!, i: out.length - 1 }); out.push(path[k + 1]!); k++; continue; }
    // Grow a run from k while the points stay on the circle of the first three
    let end = k + 1;
    if (k + 3 < path.length) {
      const c = circle3(path[k]!, path[k + 1]!, path[k + 2]!);
      if (c && c.r < 1e9) {
        let j = k + 2;
        while (j + 1 < path.length && !existing.has(j) && Math.abs(Math.hypot(path[j + 1]!.x - c.c.x, path[j + 1]!.y - c.c.y) - c.r) <= tol) j++;
        if (j - k >= 3) {
          const cross = (path[k + 1]!.x - path[k]!.x) * (path[k + 2]!.y - path[k]!.y) - (path[k + 1]!.y - path[k]!.y) * (path[k + 2]!.x - path[k]!.x);
          arcs.push({ i: out.length - 1, c: c.c, cw: cross < 0 });
          out.push(path[j]!);
          k = j;
          continue;
        }
      }
    }
    out.push(path[end]!);
    k = end;
    end = k;
  }
  return { ...r, path: out, ...(arcs.length ? { arcs } : {}) };
}

/** Rout › Convert Lines to Circle: a closed path whose points lie on one circle (within tol) made a G32 / G33 circle. */
export function linesToCircle(r: DrillRoute, tol: number): DrillRoute | null {
  if (r.circle || r.path.length < 4) return null;
  const c = circle3(r.path[0]!, r.path[Math.floor(r.path.length / 3)]!, r.path[Math.floor((2 * r.path.length) / 3)]!);
  if (!c || r.path.some((p) => Math.abs(Math.hypot(p.x - c.c.x, p.y - c.c.y) - c.r) > tol)) return null;
  const a = area(r.path);
  return { tool: r.tool, path: [{ x: c.c.x + c.r, y: c.c.y }], circle: { c: c.c, r: c.r, cw: a < 0 } };
}

