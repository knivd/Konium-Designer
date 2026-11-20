/**
 * Copper as a picture: the shapes of a copper layer's copper, and a grid of fine cells they are
 * filled into (1 where a cell's centre is in copper). The board analyses build their networks on
 * such pictures.
 */

import type { Vec2 } from '../core/geom';
import { copperNet, inPour, type PcbDocument } from '../model/pcb';
import { L, isSignal, type LayerId } from '../model/layers';
import { circle16, padOutline } from '../model/drcCopper';
import { padShapeOn } from '../model/padStack';
import { planeCopper } from '../model/planes';

/** A track's copper as a ring: the line with round ends. */
export function capsule(a: Vec2, b: Vec2, r: number): Vec2[] {
  const ang = Math.atan2(b.y - a.y, b.x - a.x), out: Vec2[] = [];
  for (let k = 0; k <= 6; k++) { const t = ang - Math.PI / 2 + (Math.PI * k) / 6; out.push({ x: b.x + r * Math.cos(t), y: b.y + r * Math.sin(t) }); }
  for (let k = 0; k <= 6; k++) { const t = ang + Math.PI / 2 + (Math.PI * k) / 6; out.push({ x: a.x + r * Math.cos(t), y: a.y + r * Math.sin(t) }); }
  return out;
}
/** An arc as short straight lengths. */
export function chords(p: { c: Vec2; r: number; start: number; end: number }): Vec2[] {
  const sweep = (((p.end - p.start) % 360) + 360) % 360 || 360, n = Math.max(2, Math.ceil(sweep / 6));
  return Array.from({ length: n + 1 }, (_, k) => { const a = ((p.start + (sweep * k) / n) * Math.PI) / 180; return { x: p.c.x + p.r * Math.cos(a), y: p.c.y + p.r * Math.sin(a) }; });
}

export const inPoly = (pts: Vec2[], x: number, y: number): boolean => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!, b = pts[j]!;
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
};

/** A grid of cells `size` across from (minX, minY), `w` by `h`, rows from the south: 1 where a filled shape covers the cell's centre. */
export class Raster {
  readonly cells: Uint8Array;
  private rows: number[][] = [];
  constructor(readonly minX: number, readonly minY: number, readonly size: number, readonly w: number, readonly h: number) { this.cells = new Uint8Array(w * h); }
  clear(): void { this.cells.fill(0); }
  /** Rings filled in by the even-odd rule: an outline with its holes, or one ring. */
  fill(rings: Vec2[][]): void {
    const { cells, w: W } = this;
    this.spans(rings, (r, from, to) => cells.fill(1, r * W + from, r * W + to + 1));
  }
  /** The runs of cells (a row, its first and last cell) whose centres the rings cover, by the even-odd rule. */
  spans(rings: Vec2[][], put: (row: number, from: number, to: number) => void): void {
    const { minX, minY, size: hs, w: W, h: H, rows } = this;
    let r0 = Infinity, r1 = -Infinity;
    for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j]!, b = ring[i]!;
      if (a.y === b.y) continue;
      const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
      const from = Math.max(0, Math.ceil((lo - minY) / hs - 0.5)), to = Math.min(H - 1, Math.ceil((hi - minY) / hs - 0.5) - 1);
      for (let r = from; r <= to; r++) {
        const y = minY + (r + 0.5) * hs;
        (rows[r] ??= []).push(a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y));
      }
      if (from <= to) { r0 = Math.min(r0, from); r1 = Math.max(r1, to); }
    }
    for (let r = r0; r <= r1; r++) {
      const xs = rows[r];
      if (!xs?.length) continue;
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const from = Math.max(0, Math.ceil((xs[k]! - minX) / hs - 0.5)), to = Math.min(W - 1, Math.ceil((xs[k + 1]! - minX) / hs - 0.5) - 1);
        if (from <= to) put(r, from, to);
      }
      xs.length = 0;
    }
  }
}

/**
 * The copper on a copper layer, piece by piece (each an outline with its holes): one net's, or
 * every net's. A signal layer's is its pads, via rings, fills, regions and pours (a pour's own
 * tracks and arcs with them; the routing's too when `tracks` is 'all'); a plane layer's is the
 * plane's copper with its clearances and reliefs. Keep-outs are not copper, and a shelved
 * polygon's copper is out of the design. Pour copper with no net of its own is its polygon's.
 */
export function layerCopper(doc: PcbDocument, layer: LayerId, o: { net?: number; tracks: 'pour' | 'all' }, put: (rings: Vec2[][]) => void): void {
  if (!isSignal(layer)) {
    for (const area of planeCopper(doc, layer)) if (o.net === undefined || area.net === o.net) for (const r of area.regions) put([r.outline, ...r.holes]);
    return;
  }
  const stack = doc.board.copperStack, li = stack.indexOf(layer);
  const shelved = new Set(doc.polygons.filter((g) => g.bag.bool('SHELVED')).map((g) => g.index));
  for (const p of doc.prims) {
    if (!('net' in p) || ('keepout' in p && p.keepout)) continue;
    if (o.net !== undefined && copperNet(doc, p) !== o.net) continue;
    if (shelved.size && inPour(p) && shelved.has((p as { polygon: number }).polygon)) continue;
    switch (p.kind) {
      case 'track': if (p.layer === layer && (o.tracks === 'all' || inPour(p))) put([capsule(p.a, p.b, p.width / 2)]); break;
      case 'arc': if (p.layer === layer && (o.tracks === 'all' || inPour(p))) { const pts = chords(p); for (let k = 0; k + 1 < pts.length; k++) put([capsule(pts[k]!, pts[k + 1]!, p.width / 2)]); } break;
      case 'via': {
        const a = stack.indexOf(p.layerStart), b = stack.indexOf(p.layerEnd), d = p.layerDiameters?.[layer - 1] ?? p.diameter;
        if ((a < 0 || b < 0 || (li >= Math.min(a, b) && li <= Math.max(a, b))) && d > p.hole) put([circle16(p.at, d / 2)]);
        break;
      }
      case 'pad': {
        if (p.layer !== layer && p.layer !== L.MULTI) break;
        const st = p.layer === L.MULTI ? padShapeOn(p, layer) : p.top, g = st && padOutline(p, st);
        if (g?.t === 'poly') put([g.pts]); else if (g?.t === 'circle') put([circle16(g.c, g.r, p.rotation)]);
        break;
      }
      case 'fill': {
        if (p.layer !== layer) break;
        const cx = (p.a.x + p.b.x) / 2, cy = (p.a.y + p.b.y) / 2, hw = Math.abs(p.b.x - p.a.x) / 2, hh = Math.abs(p.b.y - p.a.y) / 2, a = (p.rotation * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
        put([[[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: cx + x! * c - y! * sn, y: cy + x! * sn + y! * c }))]);
        break;
      }
      case 'region': if (p.layer === layer && !p.boardCutout && p.regionKind === 0 && p.outline.length >= 3) put([p.outline, ...p.holes]); break;
      default: break;
    }
  }
}
