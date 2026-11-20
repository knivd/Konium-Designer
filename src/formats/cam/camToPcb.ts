/**
 * File › Export › Export to PCB (CAMtastic): a CAM document turned back into a board — the board shape
 * from the border's outline, copper draws as tracks and arcs, flashes as pads (a pad on a plated hole
 * through-hole, flashed on both outer layers; a small one a via [est: 1 mm and under]; others surface
 * pads on their side), polygons as solid regions, silk as overlay tracks, mask and paste openings
 * that no pad explains as regions on their layers, holes with no pad as unplated pads, mechanical
 * layers as mechanical layers; the extracted nets given to their copper.
 */
import type { Vec2 } from '../../core/geom';
import { mil, mm } from '../../core/units';
import { L, mechLayer, type LayerId } from '../../model/layers';
import type { PcbRawRecord } from '../altium/framing';
import { applyStackLayers, assemblePcbDoc } from '../altium/assemble';
import { newBoardRecord } from '../altium/board6';
import { encodeArc, encodePad, encodeRegion, encodeTrack, encodeVia, writePcbDoc } from '../altium/pcbdoc';
import type { DrillLayer, GerberLayer, GerberObject } from '../gerber/gerberRead';
import type { CamDocument, CamLayer } from './camDoc';
import { liveObjects } from './camModel';
import { coverOf } from './camOps';
import { boardOutline } from './camProcess';
import { copperLayers, platedLayers } from './camAnalysis';

export interface CamToPcbResult { bytes: Uint8Array; name: string; stats: { tracks: number; arcs: number; pads: number; vias: number; regions: number; nets: number }; warnings: string[] }

export function camToPcb(d: CamDocument): CamToPcbResult {
  const warnings: string[] = [];
  const copper = copperLayers(d);
  const top = copper.find((l) => l.type === 'Top'), bottom = copper.find((l) => l.type === 'Bottom');
  const inner = copper.filter((l) => l.type === 'Internal' || l.type === 'Plane');
  const layerId = new Map<CamLayer, LayerId>();
  if (top) layerId.set(top, L.TOP);
  if (bottom) layerId.set(bottom, L.BOTTOM);
  inner.forEach((l, k) => layerId.set(l, (L.MID1 + k) as LayerId));
  let mech = 1;
  for (const l of d.layers) {
    if (layerId.has(l) || l.data.kind !== 'gerber') continue;
    const id: LayerId | null = l.type === 'Top Silk' ? L.TOP_OVERLAY : l.type === 'Bottom Silk' ? L.BOTTOM_OVERLAY : l.type === 'Top Mask' ? L.TOP_SOLDER : l.type === 'Bottom Mask' ? L.BOTTOM_SOLDER
      : l.type === 'Top Paste' ? L.TOP_PASTE : l.type === 'Bottom Paste' ? L.BOTTOM_PASTE : l.type === 'Keep Out' ? L.KEEPOUT : l.type === 'Drill Drawing' ? L.DRILL_DRAWING : l.type === 'Drill Guide' ? L.DRILL_GUIDE
        : mech <= 16 ? mechLayer(mech++) : null;
    if (id !== null) layerId.set(l, id);
  }
  // Nets
  const netNames = (d.nets ?? []).map((n) => n.name);
  const netOf = new Map<string, number>();
  (d.nets ?? []).forEach((n, k) => { for (const [ln, idx] of Object.entries(n.members)) for (const i of idx) netOf.set(`${ln}:${i}`, k); });
  const net = (l: CamLayer, i: number) => netOf.get(`${l.name}:${i}`);
  const tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], pads: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], regions: PcbRawRecord[] = [];
  const key = (p: Vec2) => `${Math.round(p.x / 5000)},${Math.round(p.y / 5000)}`;
  // Holes
  const plated = new Set(platedLayers(d));
  const holes = d.layers.filter((l) => l.data.kind === 'drill').flatMap((l) => { const dd = l.data as DrillLayer, er = new Set(l.erased ?? []); return dd.hits.map((h, i) => ({ h, i, l, dia: dd.tools.get(h.tool) ?? 0, plated: plated.has(l) })).filter((x) => !er.has(x.i)); });
  const holeAt = new Map(holes.filter((x) => !x.h.slot && !x.h.circle).map((x) => [key(x.h.at), x]));
  const used = new Set<string>();
  // Pads flashed on the outer copper
  const flashes = (l: CamLayer | undefined) => (l ? liveObjects(l).filter(({ o }) => o.kind === 'flash' && o.dark).map(({ o, i }) => ({ o: o as Extract<GerberObject, { kind: 'flash' }>, i, l })) : []);
  const fT = flashes(top), fB = flashes(bottom);
  const onB = new Map(fB.map((x) => [key(x.o.at), x]));
  const padShape = (g: GerberLayer, f: Extract<GerberObject, { kind: 'flash' }>): { w: number; h: number; shape: 'round' | 'rect' | 'octagon' | 'roundrect' } => {
    const a = g.apertures.get(f.ap);
    if (!a) return { w: mil(50), h: mil(50), shape: 'round' };
    if (a.shape === 'C') return { w: a.w, h: a.w, shape: 'round' };
    if (a.shape === 'R') return { w: a.w, h: a.h, shape: 'rect' };
    if (a.shape === 'O') return { w: a.w, h: a.h, shape: 'round' };
    if (a.shape === 'P' && (a.vertices ?? 0) === 8) return { w: a.w, h: a.w, shape: 'octagon' };
    warnings.push(`D${a.code} (${a.shape === 'M' ? `macro ${a.macro}` : a.shape}) became a pad of its extent`);
    return { w: a.w, h: a.h, shape: 'rect' };
  };
  let padNo = 1, viaCount = 0;
  const outerPads: { l: CamLayer; i: number }[] = [];
  for (const t of fT) {
    const hole = holeAt.get(key(t.o.at));
    const b = onB.get(key(t.o.at));
    const s = padShape(t.l.data as GerberLayer, t.o);
    const n = net(t.l, t.i) ?? (b ? net(b.l, b.i) : undefined);
    if (hole) {
      used.add(key(t.o.at));
      outerPads.push({ l: t.l, i: t.i }); if (b) outerPads.push({ l: b.l, i: b.i });
      if (hole.dia <= mm(0.5) && Math.max(s.w, s.h) <= mm(1) && s.shape === 'round') { vias.push(encodeVia({ at: t.o.at, diameter: s.w, hole: hole.dia, ...(n !== undefined ? { net: n } : {}) })); viaCount++; continue; }
      pads.push(encodePad({ name: String(padNo++), layer: L.MULTI, at: t.o.at, ...s, hole: hole.dia, rotation: t.o.rot ?? 0, ...(n !== undefined ? { net: n } : {}), plated: hole.plated }));
    } else {
      outerPads.push({ l: t.l, i: t.i });
      pads.push(encodePad({ name: String(padNo++), layer: L.TOP, at: t.o.at, ...s, rotation: t.o.rot ?? 0, ...(n !== undefined ? { net: n } : {}) }));
    }
  }
  for (const b of fB) {
    if (used.has(key(b.o.at))) continue;
    const hole = holeAt.get(key(b.o.at));
    const s = padShape(b.l.data as GerberLayer, b.o), n = net(b.l, b.i);
    outerPads.push({ l: b.l, i: b.i });
    if (hole) { used.add(key(b.o.at)); pads.push(encodePad({ name: String(padNo++), layer: L.MULTI, at: b.o.at, ...s, hole: hole.dia, rotation: b.o.rot ?? 0, ...(n !== undefined ? { net: n } : {}), plated: hole.plated })); }
    else pads.push(encodePad({ name: String(padNo++), layer: L.BOTTOM, at: b.o.at, ...s, rotation: b.o.rot ?? 0, ...(n !== undefined ? { net: n } : {}) }));
  }
  // Holes no pad sits on: unplated pads of the hole's size
  for (const x of holes) {
    if (x.h.slot || x.h.circle || used.has(key(x.h.at))) continue;
    pads.push(encodePad({ name: '', layer: L.MULTI, at: x.h.at, w: x.dia, h: x.dia, shape: 'round', hole: x.dia, plated: false }));
  }
  const padDone = new Set(outerPads.map((p) => `${p.l.name}:${p.i}`));
  // Everything else, layer by layer
  const padsAt = new Set([...fT, ...fB].map((f) => key(f.o.at)));
  for (const [l, id] of layerId) {
    if (l.data.kind !== 'gerber') continue;
    const g = l.data;
    const isMask = id === L.TOP_SOLDER || id === L.BOTTOM_SOLDER || id === L.TOP_PASTE || id === L.BOTTOM_PASTE;
    if (g.negative) { warnings.push(`${l.name} is a negative plane: its clearances weren't made into plane connections`); continue; }
    for (const { o, i } of liveObjects(l)) {
      if (padDone.has(`${l.name}:${i}`)) continue;
      if (!o.dark) { warnings.push(`${l.name}: clear objects left out`); continue; }
      const n = net(l, i);
      const nn = n !== undefined ? { net: n } : {};
      if (o.kind === 'draw') { const a = g.apertures.get(o.ap); tracks.push(encodeTrack({ layer: id, a: o.a, b: o.b, width: a ? Math.min(a.w, a.h) || a.w : mil(10), ...nn })); }
      else if (o.kind === 'arc') {
        const a = g.apertures.get(o.ap), r = Math.hypot(o.a.x - o.c.x, o.a.y - o.c.y);
        let s = (Math.atan2(o.a.y - o.c.y, o.a.x - o.c.x) * 180) / Math.PI, e = (Math.atan2(o.b.y - o.c.y, o.b.x - o.c.x) * 180) / Math.PI;
        if (o.cw) [s, e] = [e, s];
        const full = Math.hypot(o.a.x - o.b.x, o.a.y - o.b.y) < 1;
        const norm = (v: number) => ((v % 360) + 360) % 360;
        arcs.push(encodeArc({ layer: id, c: o.c, r, start: full ? 0 : norm(s), end: full ? 360 : norm(e), width: a ? Math.min(a.w, a.h) || a.w : mil(10), ...nn }));
      } else if (o.kind === 'region') regions.push(encodeRegion({ layer: id, outline: o.contours[0]!, holes: o.contours.slice(1), ...nn }));
      else {
        // A flash off the outer copper: a mask or paste opening a pad explains is left to the pad's rules
        if (isMask && padsAt.has(key(o.at))) continue;
        for (const c of coverOf(o, g)) regions.push(encodeRegion({ layer: id, outline: c, ...nn }));
      }
    }
  }
  // The board
  const outline = boardOutline(d);
  const xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
  const minX = Math.min(...xs, 0), minY = Math.min(...ys, 0);
  const name = `${d.name.replace(/\.cam$/i, '')}.PcbDoc`;
  const board = newBoardRecord({ fileName: name, origin: { x: minX, y: minY }, outline: outline.map((p) => ({ p })),
    sheet: { x: minX - mil(1000), y: minY - mil(1000), width: Math.max(...xs) - minX + mil(2000), height: Math.max(...ys) - minY + mil(2000) }, mechanical: Array.from({ length: Math.max(1, mech - 1) }, (_, k) => k + 1) });
  const pcb = assemblePcbDoc({ board, nets: netNames, comps: [], pads, tracks, vias, arcs, regions }, name);
  if (inner.length) applyStackLayers(pcb, [top, ...inner, bottom].filter((x): x is CamLayer => !!x).map((l) => ({ name: l.name, plane: l.type === 'Plane' })), []);
  return { bytes: writePcbDoc(pcb), name, stats: { tracks: tracks.length, arcs: arcs.length, pads: pads.length, vias: viaCount, regions: regions.length, nets: netNames.length }, warnings: [...new Set(warnings)] };
}
