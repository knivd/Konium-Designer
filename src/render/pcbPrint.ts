/**
 * A PCB print job drawn as SVG pages, one per printout: each layer drawn the way the Gerber
 * output draws it (formats/gerber drawLayer: pads and vias by stack, mask and paste openings,
 * drill symbols, the drill table, dimensions), in the layer's colour, grey or black, the first
 * listed layer on top; holes left white when the printout shows them; special strings
 * (.Printout_Name, .Layer_Name, .PCB_File_Name, .Print_Date, .Print_Time) converted. Every page
 * of a job covers the same area so the pages line up (AD's Design Extent).
 */
import type { BBox, Vec2 } from '../core/geom';
import { arcPoints } from '../core/geom';
import { drawLayer, padOutline, specialStrings, type PlotSink } from '../formats/gerber/gerber';
import { strokeText } from '../formats/gerber/stroke';
import { L, layerColour, type LayerId } from '../model/layers';
import type { PadStackLayer, PcbDocument, PcbPrim } from '../model/pcb';
import type { PrintJob, Printout } from '../model/printouts';

export type PrintColours = 'colour' | 'grey' | 'mono';
export interface PrintPage { name: string; svg: string; box: BBox }

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
function paint(layer: LayerId | 'hole', mode: PrintColours): string {
  if (layer === 'hole') return '#ffffff';
  if (mode === 'mono') return '#000000';
  const c = layerColour(layer);
  if (mode === 'colour') return hex(c);
  const g = Math.round((0.3 * ((c >> 16) & 255) + 0.59 * ((c >> 8) & 255) + 0.11 * (c & 255)) * 0.7);
  return hex((g << 16) | (g << 8) | g);
}

const K = 10_000; // board units per SVG unit (mils)
const f = (v: number) => +(v / K).toFixed(3);

/** Draws into SVG elements (mils, y up turned to SVG's y down), mirrored about x = axis when asked. */
class SvgSink implements PlotSink {
  out: string[] = [];
  box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  constructor(private colour: string, private axis: number | null) {}
  private X = (x: number) => (this.axis === null ? x : 2 * this.axis - x);
  private grow(p: Vec2, r = 0): void { const b = this.box; b.minX = Math.min(b.minX, p.x - r); b.minY = Math.min(b.minY, p.y - r); b.maxX = Math.max(b.maxX, p.x + r); b.maxY = Math.max(b.maxY, p.y + r); }
  private pt = (p: Vec2) => `${f(this.X(p.x))},${f(-p.y)}`;
  line(a: Vec2, b: Vec2, width: number): void {
    this.grow(a, width / 2); this.grow(b, width / 2);
    this.out.push(`<line x1="${f(this.X(a.x))}" y1="${f(-a.y)}" x2="${f(this.X(b.x))}" y2="${f(-b.y)}" stroke="${this.colour}" stroke-width="${f(Math.max(width, 1000))}" stroke-linecap="round"/>`);
  }
  polyline(pts: Vec2[], width: number): void {
    if (pts.length < 2) return;
    for (const p of pts) this.grow(p, width / 2);
    this.out.push(`<polyline points="${pts.map(this.pt).join(' ')}" fill="none" stroke="${this.colour}" stroke-width="${f(Math.max(width, 1000))}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  arc(c: Vec2, r: number, start: number, end: number, width: number): void {
    const sweep = ((end - start) % 360 + 360) % 360 || 360;
    if (sweep >= 359.999) {
      this.grow(c, r + width / 2);
      this.out.push(`<circle cx="${f(this.X(c.x))}" cy="${f(-c.y)}" r="${f(r)}" fill="none" stroke="${this.colour}" stroke-width="${f(Math.max(width, 1000))}"/>`);
      return;
    }
    this.polyline(arcPoints(c, r, r, start, start + sweep, Math.max(8, Math.ceil(sweep / 6))), width);
  }
  dot(at: Vec2, dia: number): void {
    this.grow(at, dia / 2);
    this.out.push(`<circle cx="${f(this.X(at.x))}" cy="${f(-at.y)}" r="${f(dia / 2)}" fill="${this.colour}"/>`);
  }
  pad(at: Vec2, st: PadStackLayer, rotation: number, grow = 0): void {
    const w = st.w + 2 * grow, h = st.h + 2 * grow;
    if (w <= 0 || h <= 0) return;
    if (st.shape === 'round' && w === h) { this.dot(at, w); return; }
    if (st.shape === 'round') {
      const long = Math.max(w, h), short = Math.min(w, h), ang = ((rotation + (w >= h ? 0 : 90)) * Math.PI) / 180;
      const d = { x: (Math.cos(ang) * (long - short)) / 2, y: (Math.sin(ang) * (long - short)) / 2 };
      this.line({ x: at.x - d.x, y: at.y - d.y }, { x: at.x + d.x, y: at.y + d.y }, short);
      return;
    }
    this.region([padOutline(at, { ...st, w, h }, rotation, grow)]);
  }
  regionHoles(outline: Vec2[], holes: Vec2[][]): void { this.region([outline, ...holes]); }
  region(contours: Vec2[][], clear = false): void {
    const d = contours.filter((c) => c.length > 2).map((c) => { for (const p of c) this.grow(p); return `M${c.map(this.pt).join('L')}Z`; }).join('');
    // Cleared: the paper shows through
    if (d) this.out.push(`<path d="${d}" fill="${clear ? '#ffffff' : this.colour}" fill-rule="evenodd"/>`);
  }
}

/** Is the primitive's component among the sides the printout includes? */
function sideFilter(doc: PcbDocument, po: Printout): (p: PcbPrim) => boolean {
  const multi = new Set<number>();
  for (const p of doc.prims) if (p.kind === 'pad' && p.layer === L.MULTI) multi.add(p.component);
  return (p) => {
    if (!('component' in p)) return true;
    const c = doc.components[p.component];
    if (!c) return true;
    if (multi.has(c.index)) return po.multi;
    return c.layer === L.BOTTOM ? po.bottom : po.top;
  };
}

/** One printout's layers drawn, mirrored about `axis` when it says so. */
function drawPrintout(doc: PcbDocument, job: PrintJob, po: Printout, mode: PrintColours, axis: number, now: Date): { body: string; box: BBox } {
  const keep = sideFilter(doc, po);
  const notes = new Set<string>();
  const parts: string[] = [];
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const merge = (b: BBox) => { box.minX = Math.min(box.minX, b.minX); box.minY = Math.min(box.minY, b.minY); box.maxX = Math.max(box.maxX, b.maxX); box.maxY = Math.max(box.maxY, b.maxY); };
  for (const layer of [...po.layers].reverse()) {
    const sink = new SvgSink(paint(layer, mode), po.mirror ? axis : null);
    const special = specialStrings(doc, layer, po.name, now);
    drawLayer(sink, doc, layer, { outlineOnMech1: layer === L.MECH1, notes, keep, drill: job.symbols, special });
    if (sink.out.length) { parts.push(`<g>${sink.out.join('')}</g>`); if (Number.isFinite(sink.box.minX)) merge(sink.box); }
  }
  // Holes white on top, pad numbers and nets over the pads
  const top = new SvgSink(paint('hole', mode), po.mirror ? axis : null);
  if (po.holes) for (const p of doc.prims) if ((p.kind === 'pad' || p.kind === 'via') && p.hole > 0 && keep(p)) top.dot(p.at, p.hole);
  if (po.padNumbers || po.padNets) {
    const ink = new SvgSink(mode === 'mono' ? '#000000' : '#202020', po.mirror ? axis : null);
    for (const p of doc.prims) {
      if (p.kind !== 'pad' || !keep(p)) continue;
      const label = [po.padNumbers ? p.name : '', po.padNets && p.net !== 0xffff ? doc.nets[p.net]?.name ?? '' : ''].filter(Boolean).join(' ');
      if (!label) continue;
      const h = Math.min(p.top.w, p.top.h) * 0.35, w = label.length * h * 0.75;
      for (const pl of strokeText(label, { x: p.at.x - w / 2, y: p.at.y - h / 2 }, h, 0, po.mirror)) ink.polyline(pl, h / 8);
    }
    top.out.push(...ink.out);
  }
  if (top.out.length) parts.push(`<g>${top.out.join('')}</g>`);
  return { body: parts.join(''), box };
}

/** The job's pages, all over the same area (the design extent with a margin, or the sheet). */
export function printJobPages(doc: PcbDocument, job: PrintJob, mode: PrintColours = 'colour', now = new Date()): PrintPage[] {
  // First pass for the area, unmirrored
  let area = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const po of job.printouts) {
    const { box } = drawPrintout(doc, job, { ...po, mirror: false }, mode, 0, now);
    area = { minX: Math.min(area.minX, box.minX), minY: Math.min(area.minY, box.minY), maxX: Math.max(area.maxX, box.maxX), maxY: Math.max(area.maxY, box.maxY) };
  }
  for (const v of doc.board.outline) area = { minX: Math.min(area.minX, v.x), minY: Math.min(area.minY, v.y), maxX: Math.max(area.maxX, v.x), maxY: Math.max(area.maxY, v.y) };
  const b = doc.board.bag;
  if (job.area === 'sheet' && b) {
    const p = (k: string, d: number) => { const v = b.getRaw(k); const n = v ? parseFloat(v) : NaN; return Number.isFinite(n) ? n * K : d; };
    area = { minX: p('SHEETX', 0), minY: p('SHEETY', 0), maxX: p('SHEETX', 0) + p('SHEETWIDTH', 1e8), maxY: p('SHEETY', 0) + p('SHEETHEIGHT', 8e7) };
  }
  if (!Number.isFinite(area.minX)) area = { minX: 0, minY: 0, maxX: 1e7, maxY: 1e7 };
  const m = Math.max(area.maxX - area.minX, area.maxY - area.minY) * 0.02;
  area = { minX: area.minX - m, minY: area.minY - m, maxX: area.maxX + m, maxY: area.maxY + m };
  const axis = (area.minX + area.maxX) / 2;
  return job.printouts.map((po) => {
    const { body } = drawPrintout(doc, job, po, mode, axis, now);
    const w = area.maxX - area.minX, h = area.maxY - area.minY;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(area.minX)} ${f(-area.maxY)} ${f(w)} ${f(h)}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"><rect x="${f(area.minX)}" y="${f(-area.maxY)}" width="${f(w)}" height="${f(h)}" fill="#ffffff"/>${body}</svg>`;
    return { name: po.name, svg, box: area };
  });
}
