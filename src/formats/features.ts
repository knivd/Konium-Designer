/**
 * A layer's content as features, each with what it belongs to (net, pin, component, aperture
 * function): drawLayer onto this sink is what IPC-2581 and ODB++ export from, so they show
 * exactly what the Gerber files plot.
 */
import type { Vec2 } from '../core/geom';
import type { LayerId } from '../model/layers';
import type { PadStackLayer, PcbDocument } from '../model/pcb';
import { drawLayer, specialStrings, type PlotMeta, type PlotSink } from './gerber/gerber';

export type Feature =
  | { t: 'line'; a: Vec2; b: Vec2; w: number }
  | { t: 'arc'; c: Vec2; r: number; start: number; end: number; w: number }
  | { t: 'pad'; at: Vec2; st: PadStackLayer; rot: number; grow: number }
  | { t: 'dot'; at: Vec2; d: number }
  | { t: 'surface'; outline: Vec2[]; holes: Vec2[][] };
export interface Tagged { f: Feature; m: PlotMeta | null }

export class FeatureSink implements PlotSink {
  items: Tagged[] = [];
  private m: PlotMeta | null = null;
  begin(m: PlotMeta | null): void { this.m = m; }
  private push(f: Feature): void { this.items.push({ f, m: this.m }); }
  line(a: Vec2, b: Vec2, w: number): void { this.push({ t: 'line', a, b, w }); }
  polyline(pts: Vec2[], w: number): void { for (let i = 1; i < pts.length; i++) this.line(pts[i - 1]!, pts[i]!, w); }
  arc(c: Vec2, r: number, start: number, end: number, w: number): void { this.push({ t: 'arc', c, r, start, end, w }); }
  dot(at: Vec2, d: number): void { this.push({ t: 'dot', at, d }); }
  pad(at: Vec2, st: PadStackLayer, rot: number, grow = 0): void { this.push({ t: 'pad', at, st, rot, grow }); }
  regionHoles(outline: Vec2[], holes: Vec2[][]): void { if (outline.length >= 3) this.push({ t: 'surface', outline, holes }); }
  /** A cleared region (a barcode's words in its inverted box) isn't copper or ink: left out [est]. */
  region(contours: Vec2[][], clear = false): void { if (clear) return; for (const c of contours) if (c.length >= 3) this.push({ t: 'surface', outline: c, holes: [] }); }
}

/** One layer's features, as its Gerber file would draw them. */
export function layerFeatures(doc: PcbDocument, layer: LayerId, notes = new Set<string>()): Tagged[] {
  const s = new FeatureSink();
  drawLayer(s, doc, layer, { outlineOnMech1: false, notes, special: specialStrings(doc, layer) });
  return s.items;
}

/** Closed polygon area sign: > 0 counter-clockwise. */
export function signedArea(p: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const u = p[i]!, v = p[(i + 1) % p.length]!; a += u.x * v.y - v.x * u.y; }
  return a / 2;
}
