/**
 * The CAM editor (AD's CAMtastic): a CAM document's layers drawn as a photoplotter would — draws
 * with their apertures' shapes, flashes, regions, clear polarity cut out of what came before it,
 * drill hits, slots, canned circles and routed paths — in the layers' colours over a black field,
 * each layer over the ones before it in the stack. Objects (and groups: placed text, polylines,
 * dimensions) are picked, queried in Properties and edited (the CAM commands); View › Views and
 * Display Symbols change how they're drawn.
 */
import { Editor, type HitItem, type PropSection } from '../Editor';
import type { Scope } from '../../core/commands';
import type { Tool, ToolPointer } from '../../core/tools';
import { triangulateWithHoles, type BBox, type Vec2 } from '../../core/geom';
import { rgba, type DrawGroup, type Scene } from '../../render/Scene';
import { hex4, type GridSpec } from '../../render/gl/Renderer';
import { hexToRgb, settings } from '../../core/settings';
import { formatCoord, mil, type DisplayUnit } from '../../core/units';
import { camExtent, objectBox, type CamDocument, type CamLayer } from '../../formats/cam/camDoc';
import type { Aperture, DrillLayer, DrillRoute, GerberObject } from '../../formats/gerber/gerberRead';
import { captureEdit, groupMembers, hitBox, objectOrder, shapesOf } from '../../formats/cam/camModel';
import { defaultCamDrcRules, type CamDrcRules, type CamViolation } from '../../formats/cam/camAnalysis';

export const CAM_GRIDS = [mil(1), mil(5), mil(10), mil(20), mil(25), mil(50), mil(100), mil(200), mil(500)];
const BACK = 0x000000;

const hexNum = (h: string) => parseInt(h.replace('#', ''), 16) || 0;
/** Convex hull (a rectangular aperture swept along a draw). */
export function hull(pts: Vec2[]): Vec2[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [], upper: Vec2[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
const fill = (s: Scene, g: DrawGroup, poly: Vec2[], c: number) => { if (poly.length < 3) return; const t = triangulateWithHoles(poly, []); s.polygon(g, t.pts, t.idx, c); };
export function inPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export const segDist = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
};
const deg = (r: number) => (r * 180) / Math.PI;
/** An arc's radius and start and end angles, counter-clockwise (a clockwise arc is drawn from its end). */
export function arcAngles(o: { a: Vec2; b: Vec2; c: Vec2; cw: boolean }): [number, number, number] {
  const r = Math.hypot(o.a.x - o.c.x, o.a.y - o.c.y);
  let s = deg(Math.atan2(o.a.y - o.c.y, o.a.x - o.c.x)), e = deg(Math.atan2(o.b.y - o.c.y, o.b.x - o.c.x));
  if (o.cw) [s, e] = [e, s];
  if (Math.hypot(o.a.x - o.b.x, o.a.y - o.b.y) < 1) e = s + 360;
  return [r, s, e];
}
/** Points along an arc from a to b about c. */
export function arcPath(a: Vec2, b: Vec2, c: Vec2, cw: boolean, step = Math.PI / 32): Vec2[] {
  const r = Math.hypot(a.x - c.x, a.y - c.y);
  let s = Math.atan2(a.y - c.y, a.x - c.x), e = Math.atan2(b.y - c.y, b.x - c.x);
  if (cw) { while (e >= s) e -= 2 * Math.PI; } else { while (e <= s) e += 2 * Math.PI; }
  if (Math.hypot(a.x - b.x, a.y - b.y) < 1) e = s + (cw ? -2 : 2) * Math.PI;
  const n = Math.max(2, Math.ceil(Math.abs(e - s) / step));
  return Array.from({ length: n + 1 }, (_, k) => { const t = s + ((e - s) * k) / n; return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }; });
}
/** A routed path as points (its arcs walked). */
export function routePoints(r: DrillRoute): Vec2[] {
  if (r.circle) return arcPath({ x: r.circle.c.x + r.circle.r, y: r.circle.c.y }, { x: r.circle.c.x + r.circle.r, y: r.circle.c.y }, r.circle.c, r.circle.cw);
  const arcs = new Map((r.arcs ?? []).map((a) => [a.i, a]));
  const out: Vec2[] = [r.path[0]!];
  for (let i = 1; i < r.path.length; i++) {
    const arc = arcs.get(i - 1);
    if (arc) out.push(...arcPath(r.path[i - 1]!, r.path[i]!, arc.c, arc.cw).slice(1));
    else out.push(r.path[i]!);
  }
  return out;
}

/** A flashed aperture's outline(s) at a point: dark ones and the clear ones within it. */
export function flashShapes(ap: Aperture, at: Vec2, rot = 0, mirror?: string, scale = 1): { dark: boolean; poly: Vec2[] }[] {
  const tf = (p: Vec2): Vec2 => {
    let x = p.x * scale, y = p.y * scale;
    if (mirror?.includes('X')) x = -x;
    if (mirror?.includes('Y')) y = -y;
    if (rot) { const a = (rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); [x, y] = [x * c - y * s, x * s + y * c]; }
    return { x: at.x + x, y: at.y + y };
  };
  return shapesOf(ap).map((s) => ({ dark: s.dark, poly: s.poly.map(tf) }));
}

/** An object's outline as filled shapes (what it covers): a draw as its swept aperture, an arc as a band. */
export function objectShapes(o: GerberObject, ap: Aperture | undefined): { dark: boolean; poly: Vec2[] }[] {
  if (o.kind === 'region') return o.contours.map((c) => ({ dark: true, poly: c }));
  if (!ap) return [];
  if (o.kind === 'flash') return flashShapes(ap, o.at, o.rot, o.mirror, o.scale);
  const w = Math.max(1, Math.min(ap.w, ap.h) || ap.w);
  if (o.kind === 'draw') {
    if (ap.shape === 'R') {
      const hw = ap.w / 2, hh = ap.h / 2;
      return [{ dark: true, poly: hull([o.a, o.b].flatMap((q) => [{ x: q.x - hw, y: q.y - hh }, { x: q.x + hw, y: q.y - hh }, { x: q.x + hw, y: q.y + hh }, { x: q.x - hw, y: q.y + hh }])) }];
    }
    const r = w / 2, dx = o.b.x - o.a.x, dy = o.b.y - o.a.y, len = Math.hypot(dx, dy);
    if (len < 1) return [{ dark: true, poly: Array.from({ length: 24 }, (_, i) => ({ x: o.a.x + r * Math.cos((i * Math.PI) / 12), y: o.a.y + r * Math.sin((i * Math.PI) / 12) })) }];
    const a0 = Math.atan2(dy, dx), pts: Vec2[] = [];
    for (let i = 0; i <= 12; i++) { const t = a0 - Math.PI / 2 - (i * Math.PI) / 12; pts.push({ x: o.a.x + r * Math.cos(t), y: o.a.y + r * Math.sin(t) }); }
    for (let i = 0; i <= 12; i++) { const t = a0 + Math.PI / 2 - (i * Math.PI) / 12; pts.push({ x: o.b.x + r * Math.cos(t), y: o.b.y + r * Math.sin(t) }); }
    return [{ dark: true, poly: pts }];
  }
  const mid = arcPath(o.a, o.b, o.c, o.cw);
  const R = Math.hypot(o.a.x - o.c.x, o.a.y - o.c.y), r = w / 2;
  const out = mid.map((p) => { const k = (R + r) / (R || 1); return { x: o.c.x + (p.x - o.c.x) * k, y: o.c.y + (p.y - o.c.y) * k }; });
  const inn = mid.map((p) => { const k = Math.max(0, R - r) / (R || 1); return { x: o.c.x + (p.x - o.c.x) * k, y: o.c.y + (p.y - o.c.y) * k }; }).reverse();
  return [{ dark: true, poly: [...out, ...inn] }];
}

/** How the CAM editor draws (View › Views, Display Symbols); kept with the editor, not the document. */
export interface CamView {
  /** View › Views › Fill: objects filled (off: outlines and centre lines). */
  fill: boolean;
  translucent: boolean;
  /** View › Views › Difference: the two top shown layers in contrasting colours over each other. */
  difference: boolean;
  extents: boolean;
  origin: boolean;
  /** View › Views › Highlight Dcode: objects of this D-code drawn in the highlight colour. */
  highlight: number | null;
  filmBox: boolean;
  /** Display Symbols. */
  drillSymbols: boolean; arrows: boolean; centreline: boolean; plunge: boolean; retract: boolean;
  /** Drawn negative (View › Views › Negative), by layer. */
  negative: Set<CamLayer>;
}

/** Each layer's own number for selection keys, so they survive the layers being reordered, added or removed. */
const layerIds = new WeakMap<CamLayer, number>();
let nextLayerId = 1;
export const camLayerId = (l: CamLayer): number => { let id = layerIds.get(l); if (id === undefined) { id = nextLayerId++; layerIds.set(l, id); } return id; };

/** A drill symbol's strokes for tool n (View › Display Symbols › Drill), r its size [est: CAMtastic's set]. */
function drillSymbol(n: number, c: Vec2, r: number): Vec2[][] {
  const k = n % 8, P = (x: number, y: number) => ({ x: c.x + x * r, y: c.y + y * r });
  switch (k) {
    case 0: return [[P(-1, -1), P(1, 1)], [P(-1, 1), P(1, -1)]];
    case 1: return [[P(-1, 0), P(1, 0)], [P(0, -1), P(0, 1)]];
    case 2: return [[P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), P(-1, -1)]];
    case 3: return [[P(0, 1), P(0.87, -0.5), P(-0.87, -0.5), P(0, 1)]];
    case 4: return [[P(0, 1), P(1, 0), P(0, -1), P(-1, 0), P(0, 1)]];
    case 5: return [[P(-1, -1), P(1, -1), P(1, 1), P(-1, 1), P(-1, -1)], [P(-1, -1), P(1, 1)], [P(-1, 1), P(1, -1)]];
    case 6: return [[P(0, 1), P(1, 0), P(0, -1), P(-1, 0), P(0, 1)], [P(-1, 0), P(1, 0)], [P(0, -1), P(0, 1)]];
    default: return [[P(-1, 0), P(1, 0)], [P(0, -1), P(0, 1)], [P(-1, -1), P(1, 1)], [P(-1, 1), P(1, -1)]];
  }
}

export type PickedObject = { layer: CamLayer; li: number; i: number };
export type PickedRoute = { layer: CamLayer; li: number; k: number };

export class CamEditor extends Editor {
  readonly scope: Scope = 'cam';
  units: () => DisplayUnit = () => 'mil';
  /** The D-code new draws and flashes use, by layer (Tables › Apertures, or Tab while placing). */
  currentAp = new Map<CamLayer, number>();
  /** The drill tool new hits use, by layer. */
  currentTool = new Map<CamLayer, number>();
  view: CamView = { fill: true, translucent: false, difference: false, extents: false, origin: false, highlight: null, filmBox: false,
    drillSymbols: false, arrows: false, centreline: false, plunge: false, retract: false, negative: new Set() };
  /** View › Sort/Optimise: how drills are ordered when written (Automatic sorts them by nearest neighbour). */
  sortMode: 'auto' | 'user' | 'none' = 'none';
  /** Edit › Selection › Previous: the selection before the last one. */
  previousSelection: string[] = [];
  /** Tools › Netlist › Query Net / Measure: the net to show highlighted. */
  shownNet: string | null = null;
  /** NC Editor (View › NC Editor): only drill and rout layers are picked [est]. */
  ncMode = false;
  /** Snap Change: off, points go where the cursor is, not to the grid. */
  snapOn = true;
  /** Analysis › PCB Design Check: its rules and the last run's violations (shown marked until the next run or Clear). */
  drcRules: CamDrcRules = defaultCamDrcRules();
  drc: CamViolation[] | null = null;
  /** The clearance the last PCB Design Check checked nets against (null: not checked). */
  drcClearance: number | null = null;
  /** Rout › Rout Pads Options: what Create Rout Path(s), Auto-Rout and Mill Boundary use [est: CAMtastic's options]. */
  routOptions = { tool: 787_402 /* 2 mm */, outside: true, tabWidth: 1_181_102 /* 3 mm */, compensation: 'none' as 'none' | 'L' | 'R' };

  constructor(public doc: CamDocument) {
    const sel = new CamSelectTool();
    super(sel);
    sel.editor = this;
    this.gridIndex = CAM_GRIDS.indexOf(mil(5));
  }
  override get cursorColour(): string { return settings.selectionColour; }
  title(): string { return this.doc.name; }
  origin(): Vec2 { return this.doc.origin ?? { x: 0, y: 0 }; }
  gridSizes(): number[] { return CAM_GRIDS; }
  grid(): GridSpec {
    const c = hexToRgb('#808080');
    return { size: this.gridSize(), dots: true, color: hex4(c, 0.35), major: hex4(c, 0.55) };
  }
  override fitBounds(): BBox { return camExtent(this.doc) ?? camExtent(this.doc, false) ?? { minX: -mil(500), minY: -mil(500), maxX: mil(500), maxY: mil(500) }; }

  override snap(p: Vec2): Vec2 { return this.snapOn ? super.snap(p) : p; }

  /** Told of the clicks a tool takes (a macro being recorded): where, and which button. */
  onToolClick: ((at: Vec2, button: number) => void) | null = null;
  override pointerDown(p: ToolPointer): void {
    if (this.tool !== this.selectTool && p.button === 0) this.onToolClick?.(p.raw, 0);
    super.pointerDown(p);
  }
  override rightClick(p: ToolPointer): void {
    if (this.tool !== this.selectTool) this.onToolClick?.(p.raw, 2);
    super.rightClick(p);
  }

  /** The design check's violations: their objects drawn in the marker colour, a cross at each. */
  protected override marks(): { items: Set<string>; points: Vec2[]; colour: number } | null {
    if (!this.drc?.length) return null;
    const byName = new Map(this.doc.layers.map((l) => [l.name, l]));
    const items = new Set<string>();
    for (const v of this.drc) for (const o of v.objects) { const l = byName.get(o.layer); if (l) items.add(this.keyOf(l, o.i)); }
    return { items, points: this.drc.map((v) => v.at), colour: 0x00ff00 };
  }

  /** The current layer (where placing goes). */
  get layer(): CamLayer | undefined { return this.doc.layers[this.doc.current]; }

  /** A layer's objects as hit items and drawing: polarity runs stacked, clear ones in the field's colour. */
  protected build(scene: Scene, emit: (item: HitItem) => void): void {
    scene.background = BACK;
    const sel = rgba(hexNum(settings.selectionColour));
    const selected: HitItem[] = [];
    const v = this.view;
    const shown = this.doc.layers.map((l, li) => [l, li] as const).filter(([l]) => l.visible);
    const diff = v.difference ? shown.slice(-2).map(([l]) => l) : [];
    const net = this.shownNet ? this.doc.nets?.find((n) => n.name === this.shownNet) : undefined;
    this.doc.layers.forEach((l, li) => {
      if (!l.visible) return;
      if (v.difference && diff.length === 2 && !diff.includes(l)) return;
      const alpha = v.translucent || (v.difference && diff.length === 2) ? 0.55 : 1;
      const base = v.difference && diff.length === 2 ? (diff[0] === l ? 0xff3030 : 0x30ff30) : hexNum(l.colour);
      const colour = rgba(base, alpha), back = rgba(BACK, alpha);
      const erased = new Set(l.erased ?? []);
      const lid = camLayerId(l);
      const pickable = !this.ncMode || l.data.kind === 'drill' || l.type === 'Border';
      const netSet = new Set(net?.members[l.name] ?? []);
      const keep = (it: HitItem) => { if (pickable) emit(it); if (this.selection.has(it.key) || (it.group && this.selection.has(it.group))) selected.push(it); };
      if (l.data.kind === 'drill') {
        const d = l.data;
        const g = scene.group(`cam-${li}-0`, li * 1000);
        d.hits.forEach((h, i) => {
          if (erased.has(i)) return;
          const r = (d.tools.get(h.tool) ?? mil(10)) / 2;
          const draw = (s: Scene, gg: DrawGroup, c: number) => {
            if (v.drillSymbols && !h.slot && !h.circle) { for (const st of drillSymbol(h.tool, h.at, Math.max(r, mil(10)))) s.polyline(gg, st, 0, c); return; }
            if (h.slot) s.segment(gg, h.at, h.slot, 2 * r, c);
            else if (h.circle) s.arc(gg, h.at, h.circle / 2, 0, 360, 2 * r, c);
            else if (v.fill) s.circle(gg, h.at, r, c);
            else s.arc(gg, h.at, r, 0, 360, 0, c);
          };
          draw(scene, g, netSet.has(i) ? rgba(0xffffff, 1) : colour);
          const box = hitBox(d, h);
          keep({ key: `${lid}:${i}`, ...(h.grp ? { group: `${lid}:g${h.grp}` } : {}), bbox: box, layer: li, order: 0, draw,
            test: (p, tol) => (h.slot ? segDist(p, h.at, h.slot) : h.circle ? Math.abs(Math.hypot(p.x - h.at.x, p.y - h.at.y) - h.circle / 2) : Math.hypot(p.x - h.at.x, p.y - h.at.y)) <= r + tol });
        });
        d.routes.forEach((rt, k) => {
          const pts = routePoints(rt);
          const w = d.tools.get(rt.tool) ?? mil(10);
          const draw = (s: Scene, gg: DrawGroup, c: number) => {
            s.polyline(gg, pts, v.fill && !v.centreline ? w : 0, c);
            if (v.centreline && v.fill) s.polyline(gg, pts, 0, rgba(0xffffff, 0.8));
            const px = w;
            if (v.plunge) s.arc(gg, pts[0]!, px * 0.8, 0, 360, 0, rgba(0x00ff00, 1));
            if (v.retract) { const e = pts.at(-1)!; s.polyline(gg, [{ x: e.x - px, y: e.y - px }, { x: e.x + px, y: e.y - px }, { x: e.x + px, y: e.y + px }, { x: e.x - px, y: e.y + px }], 0, rgba(0xff0000, 1), true); }
            if (v.arrows) for (let i = 1; i < pts.length; i += Math.max(1, Math.floor(pts.length / 12))) arrow(s, gg, pts[i - 1]!, pts[i]!, Math.max(px, mil(20)), rgba(0xffffff, 0.9));
          };
          draw(scene, g, colour);
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
          keep({ key: `${lid}:r${k}`, bbox: { minX: minX - w / 2, minY: minY - w / 2, maxX: maxX + w / 2, maxY: maxY + w / 2 }, layer: li, order: 1, draw,
            test: (p, tol) => pts.some((q, i) => i > 0 && segDist(p, pts[i - 1]!, q) <= w / 2 + tol) });
        });
        return;
      }
      const gl = l.data;
      const negative = gl.negative !== v.negative.has(l);
      let run = 0, dark = true;
      let g = scene.group(`cam-${li}-0`, li * 1000);
      if (negative) { const b = camExtent({ ...this.doc, layers: [l] }); if (b) scene.rectFromCorners(g, { x: b.minX, y: b.minY }, { x: b.maxX, y: b.maxY }, colour); }
      const subs = l.composite;
      for (const i of objectOrder(l)) {
        if (erased.has(i)) continue;
        const o = gl.objects[i]!;
        const odark = subs?.length ? (subs[o.sub ?? 0]?.dark ?? true) === o.dark : o.dark;
        if (odark !== dark) { dark = odark; run++; g = scene.group(`cam-${li}-${run}`, li * 1000 + run); }
        const on = (dark !== negative) ? colour : back;
        const hl = (v.highlight !== null && o.kind !== 'region' && o.ap === v.highlight) || netSet.has(i);
        const ap = o.kind === 'region' ? undefined : gl.apertures.get(o.ap);
        const w = ap ? Math.min(ap.w, ap.h) || ap.w : 0;
        let draw: (s: Scene, gg: DrawGroup, c: number) => void;
        let test: (p: Vec2, tol: number) => boolean;
        if (o.kind === 'draw') {
          if (!v.fill) draw = (s, gg, c) => s.segment(gg, o.a, o.b, 0, c);
          else if (ap?.shape === 'R') {
            const shape = objectShapes(o, ap)[0]!.poly;
            draw = (s, gg, c) => fill(s, gg, shape, c);
          } else draw = (s, gg, c) => s.segment(gg, o.a, o.b, Math.max(w, 1), c);
          test = (p, tol) => segDist(p, o.a, o.b) <= w / 2 + tol;
        } else if (o.kind === 'arc') {
          const [r, a0, a1] = arcAngles(o);
          draw = (s, gg, c) => s.arc(gg, o.c, r, a0, a1, v.fill ? Math.max(w, 1) : 0, c);
          test = (p, tol) => {
            if (Math.abs(Math.hypot(p.x - o.c.x, p.y - o.c.y) - r) > w / 2 + tol) return false;
            let a = deg(Math.atan2(p.y - o.c.y, p.x - o.c.x)) - a0;
            while (a < 0) a += 360;
            let sw = a1 - a0;
            while (sw <= 0) sw += 360;
            return a <= sw;
          };
        } else if (o.kind === 'flash') {
          const shapes = ap ? flashShapes(ap, o.at, o.rot, o.mirror, o.scale) : [];
          draw = v.fill ? (s, gg, c) => { for (const sh of shapes) fill(s, gg, sh.poly, sh.dark ? c : c === on ? (on === colour ? back : colour) : c); }
            : (s, gg, c) => { for (const sh of shapes) s.polyline(gg, sh.poly, 0, c, true); };
          test = (p, tol) => (ap ? Math.abs(p.x - o.at.x) <= Math.max(ap.w, ap.h) / 2 + tol && Math.abs(p.y - o.at.y) <= Math.max(ap.w, ap.h) / 2 + tol : false);
        } else {
          draw = v.fill ? (s, gg, c) => { for (const cc of o.contours) fill(s, gg, cc, c); } : (s, gg, c) => { for (const cc of o.contours) s.polyline(gg, cc, 0, c, true); };
          test = (p) => o.contours.some((cc) => inPoly(p, cc));
        }
        draw(scene, g, hl ? rgba(0xffffff, 1) : on);
        keep({ key: `${lid}:${i}`, ...(o.grp ? { group: `${lid}:g${o.grp}` } : {}), bbox: objectBox(o, (c) => Math.max(gl.apertures.get(c)?.w ?? 0, gl.apertures.get(c)?.h ?? 0)), layer: li, order: 0, draw, test });
      }
    });
    const marks = scene.group('cam-marks', 9e8);
    const px = 1 / (this.viewport?.cam.scale ?? 1);
    if (v.extents) { const b = camExtent(this.doc); if (b) scene.polyline(marks, [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], 0, rgba(0x00ffff, 1), true); }
    if (v.filmBox && this.doc.filmBox) { const b = this.doc.filmBox; scene.polyline(marks, [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }], 0, rgba(0xffffff, 1), true); }
    if (v.origin) { const o = this.origin(), d = 12 * px; scene.segment(marks, { x: o.x - d, y: o.y }, { x: o.x + d, y: o.y }, 0, rgba(0xffffff, 1)); scene.segment(marks, { x: o.x, y: o.y - d }, { x: o.x, y: o.y + d }, 0, rgba(0xffffff, 1)); scene.arc(marks, o, d / 2, 0, 360, 0, rgba(0xffffff, 1)); }
    if (selected.length) { const g = scene.group('cam-selected', 1e9); for (const it of selected) it.draw(scene, g, sel); }
  }

  /* ── Selection ── */

  /** Keys as layer, kind and index: objects / hits, groups (g), routes (r); null for a layer gone. */
  parseKey(k: string, ids?: Map<number, number>): { layer: CamLayer; li: number; kind: 'o' | 'g' | 'r'; n: number } | null {
    const m = /^(\d+):([gr]?)(\d+)$/.exec(k);
    if (!m) return null;
    const id = Number(m[1]);
    const li = ids ? (ids.get(id) ?? -1) : this.doc.layers.findIndex((l) => camLayerId(l) === id);
    if (li < 0) return null;
    return { layer: this.doc.layers[li]!, li, kind: (m[2] || 'o') as 'o' | 'g' | 'r', n: Number(m[3]) };
  }

  /** The selected objects (groups as their members): their layer (where it is in the stack now) and index; ones gone left out. */
  selectedObjects(keys: Iterable<string> = this.selection): PickedObject[] {
    const out: PickedObject[] = [];
    const seen = new Set<string>();
    const erasedOf = new Map<CamLayer, Set<number>>();
    const ids = new Map(this.doc.layers.map((l, li) => [camLayerId(l), li]));
    for (const k of keys) {
      const p = this.parseKey(k, ids);
      if (!p || p.kind === 'r') continue;
      const n = p.layer.data.kind === 'drill' ? p.layer.data.hits.length : p.layer.data.objects.length;
      let er = erasedOf.get(p.layer);
      if (!er) { er = new Set(p.layer.erased ?? []); erasedOf.set(p.layer, er); }
      const idx = p.kind === 'g' ? groupMembers(p.layer, p.n) : p.n >= 0 && p.n < n && !er.has(p.n) ? [p.n] : [];
      for (const i of idx) { const key = `${p.li}:${i}`; if (!seen.has(key)) { seen.add(key); out.push({ layer: p.layer, li: p.li, i }); } }
    }
    return out;
  }
  selectedRoutes(keys: Iterable<string> = this.selection): PickedRoute[] {
    const out: PickedRoute[] = [];
    for (const k of keys) { const p = this.parseKey(k); if (p?.kind === 'r' && p.layer.data.kind === 'drill' && p.n < p.layer.data.routes.length) out.push({ layer: p.layer, li: p.li, k: p.n }); }
    return out;
  }
  /** Selected groups: their layer and id. */
  selectedGroups(): { layer: CamLayer; grp: number }[] {
    const out: { layer: CamLayer; grp: number }[] = [];
    for (const k of this.selection) { const p = this.parseKey(k); if (p?.kind === 'g' && p.layer.groups?.has(p.n)) out.push({ layer: p.layer, grp: p.n }); }
    return out;
  }

  /** The selection key of a layer's object (for scripts and tests). */
  keyOf(layer: CamLayer, i: number): string { return `${camLayerId(layer)}:${i}`; }
  groupKeyOf(layer: CamLayer, grp: number): string { return `${camLayerId(layer)}:g${grp}`; }
  routeKeyOf(layer: CamLayer, k: number): string { return `${camLayerId(layer)}:r${k}`; }

  /** A pick of a group's member picks the group. */
  override normaliseSelection(keys: string[]): string[] {
    this.scene();
    const byKey = new Map(this.items.map((it) => [it.key, it]));
    return [...new Set(keys.map((k) => byKey.get(k)?.group ?? k))];
  }
  override select(keys: Iterable<string>, add = false): void {
    const before = [...this.selection];
    super.select(keys, add);
    if (before.join() !== [...this.selection].join()) this.previousSelection = before;
  }
  override allKeys(): string[] { return this.normaliseSelection(super.allKeys()); }

  /* ── Properties ── */

  properties(): PropSection[] {
    const u = this.units(), o0 = this.origin(), f = (c: number) => formatCoord(c, u, u === 'mil' ? 3 : 4);
    const pt = (p: Vec2) => `${f(p.x - o0.x)}, ${f(p.y - o0.y)}`;
    const routes = this.selectedRoutes();
    const groups = this.selectedGroups();
    const sel = this.selectedObjects();
    if (!sel.length && !routes.length) return [];
    if (groups.length === 1 && this.selection.size === 1) {
      const { layer, grp } = groups[0]!;
      const gr = layer.groups!.get(grp)!;
      const rows: PropSection['rows'] = [{ label: 'Layer', value: `${layer.name} (${layer.type})` }];
      if (gr.kind === 'text' || gr.kind === 'drilltext') rows.push({ label: 'Object', value: gr.kind === 'text' ? 'Text' : 'Drilled text' }, { label: 'Text', value: gr.text }, { label: 'Position', value: pt(gr.at) }, { label: 'Height', value: f(gr.height) },
        ...(gr.kind === 'text' ? [{ label: 'Rotation', value: `${gr.rot}°` }, { label: 'Mirrored', value: gr.mirror ? 'Yes' : 'No' }] : []));
      else if (gr.kind === 'dimension') rows.push({ label: 'Object', value: `Dimension (${gr.dim})` }, { label: 'Value', value: gr.text });
      else rows.push({ label: 'Object', value: gr.closed ? 'Closed polyline' : 'Polyline' });
      rows.push({ label: 'Objects', value: String(groupMembers(layer, grp).length) });
      return [{ title: 'Object', rows }];
    }
    if (sel.length + routes.length > 1) {
      return [{ title: 'Selection', rows: [{ label: 'Objects', value: String(sel.length + routes.length) }, { label: 'Layers', value: [...new Set([...sel, ...routes].map((s) => s.layer.name))].join(', ') }] }];
    }
    if (routes.length) {
      const { layer, k } = routes[0]!;
      const d = layer.data as DrillLayer, r = d.routes[k]!;
      const pts = routePoints(r);
      const len = pts.reduce((t, p, i) => (i ? t + Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) : 0), 0);
      return [{ title: 'Object', rows: [{ label: 'Layer', value: `${layer.name} (${layer.type})` }, { label: 'Object', value: r.circle ? `Routed circle (${r.circle.cw ? 'G32' : 'G33'})` : 'Rout path' },
        { label: 'Tool', value: `T${String(r.tool).padStart(2, '0')}` }, { label: 'Diameter', value: f(d.tools.get(r.tool) ?? 0) }, { label: 'Start', value: pt(pts[0]!) }, { label: 'Length', value: f(len) },
        ...(r.comp ? [{ label: 'Compensation', value: r.comp === 'L' ? 'Left (G41)' : 'Right (G42)' }] : [])] }];
    }
    const { layer, i } = sel[0]!;
    const rows: PropSection['rows'] = [{ label: 'Layer', value: `${layer.name} (${layer.type})` }];
    if (layer.data.kind === 'drill') {
      const h = layer.data.hits[i]!;
      rows.push({ label: 'Object', value: h.slot ? 'Slot' : h.circle ? 'Drill circle (G84)' : 'Drill hit' }, { label: 'Tool', value: `T${String(h.tool).padStart(2, '0')}` }, { label: 'Diameter', value: f(layer.data.tools.get(h.tool) ?? 0) }, { label: 'Position', value: pt(h.at) });
      if (h.slot) rows.push({ label: 'To', value: pt(h.slot) });
      if (h.circle) rows.push({ label: 'Circle diameter', value: f(h.circle) });
    } else {
      const o = layer.data.objects[i]!;
      const ap = o.kind === 'region' ? undefined : layer.data.apertures.get(o.ap);
      rows.push({ label: 'Object', value: { draw: 'Line', arc: 'Arc', flash: 'Flash', region: 'Polygon' }[o.kind] }, { label: 'Polarity', value: o.dark ? 'Dark' : 'Clear' });
      if (ap) rows.push({ label: 'D-Code', value: `D${ap.code}` }, { label: 'Aperture', value: apertureText(ap, f) });
      if (o.kind === 'draw') rows.push({ label: 'Start', value: pt(o.a) }, { label: 'End', value: pt(o.b) }, { label: 'Length', value: f(Math.hypot(o.b.x - o.a.x, o.b.y - o.a.y)) });
      else if (o.kind === 'arc') rows.push({ label: 'Start', value: pt(o.a) }, { label: 'End', value: pt(o.b) }, { label: 'Centre', value: pt(o.c) }, { label: 'Radius', value: f(Math.hypot(o.a.x - o.c.x, o.a.y - o.c.y)) }, { label: 'Direction', value: o.cw ? 'Clockwise' : 'Counter-clockwise' });
      else if (o.kind === 'flash') rows.push({ label: 'Position', value: pt(o.at) }, ...(o.rot ? [{ label: 'Rotation', value: `${o.rot}°` }] : []), ...(o.mirror ? [{ label: 'Mirror', value: o.mirror }] : []));
      else rows.push({ label: 'Contours', value: String(o.contours.length) }, { label: 'Vertices', value: String(o.contours.reduce((n, c) => n + c.length, 0)) });
      if (o.sr) rows.push({ label: 'Step/Repeat', value: `Block ${o.sr}${o.srCopy ? ' (repeat)' : ''}` });
      if (layer.composite?.length) rows.push({ label: 'Sub-layer', value: layer.composite[o.sub ?? 0]?.name ?? '' });
    }
    return [{ title: 'Object', rows }];
  }

  documentProperties(): PropSection[] {
    const u = this.units(), f = (c: number) => formatCoord(c, u, u === 'mil' ? 1 : 3);
    const b = camExtent(this.doc, false);
    return [{ title: 'CAM Document', rows: [
      { label: 'Layers', value: String(this.doc.layers.length) },
      { label: 'Shown', value: String(this.doc.layers.filter((l) => l.visible).length) },
      ...(b ? [{ label: 'Extents', value: `${f(b.maxX - b.minX)} × ${f(b.maxY - b.minY)}` }] : []),
      { label: 'Objects', value: String(this.doc.layers.reduce((n, l) => n + (l.data.kind === 'gerber' ? l.data.objects.length : l.data.hits.length) - (l.erased?.length ?? 0), 0)) },
      ...(this.doc.origin ? [{ label: 'Origin', value: `${f(this.doc.origin.x)}, ${f(this.doc.origin.y)}` }] : []),
      ...(this.doc.parts?.length ? [{ label: 'Parts', value: String(this.doc.parts.length) }] : []),
      ...(this.doc.nets?.length ? [{ label: 'Nets', value: String(this.doc.nets.length) }] : []),
    ] }];
  }

  /* ── Editing ── */

  /** One undo step: `fn` changes the layers named (and the document's own state); the step keeps each as it was before and after. */
  edit(label: string, layers: CamLayer[] | 'all', fn: () => void): void {
    const done = captureEdit(this.doc, layers);
    let ran = false;
    this.undo.transact(label, (tx) => {
      fn();
      ran = true;
      const ch = done();
      // The change is applied already: add it as a step that redoes and undoes
      tx.add({ apply: () => { if (ran) { ran = false; return; } ch.apply(); this.afterChange(); }, revert: () => { ch.revert(); this.afterChange(); } });
    });
    this.afterChange();
  }
  private afterChange(): void { this.doc.dirty = true; this.invalidate(); }

  /** Edit › Clear (Erase): the selected objects taken out (one undo); routes removed. */
  deleteSelection(): void {
    const sel = this.selectedObjects(), routes = this.selectedRoutes();
    if (!sel.length && !routes.length) return;
    const layers = [...new Set([...sel.map((s) => s.layer), ...routes.map((r) => r.layer)])];
    this.edit('Erase', layers, () => {
      for (const l of layers) {
        const add = sel.filter((s) => s.layer === l).map((s) => s.i);
        if (add.length) l.erased = [...new Set([...(l.erased ?? []), ...add])].sort((a, b) => a - b);
        const gone = new Set(routes.filter((r) => r.layer === l).map((r) => r.k));
        if (gone.size && l.data.kind === 'drill') l.data.routes = l.data.routes.filter((_, k) => !gone.has(k));
      }
    });
    this.selection.clear();
    this.invalidateOverlay();
  }

  /** Changed from outside (the CAMtastic panel, the Layers Table): redrawn. */
  touch(): void { this.doc.dirty = true; this.invalidate(); }
}

function arrow(s: Scene, g: DrawGroup, a: Vec2, b: Vec2, size: number, c: number): void {
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, t = Math.atan2(b.y - a.y, b.x - a.x);
  if (Math.hypot(b.x - a.x, b.y - a.y) < size) return;
  const p = (ang: number) => ({ x: m.x - size * Math.cos(t + ang), y: m.y - size * Math.sin(t + ang) });
  s.polyline(g, [p(0.45), m, p(-0.45)], 0, c);
}

/** Click picks the topmost object (a group's member picks the group); Shift adds or takes away; drag on empty space boxes. */
export class CamSelectTool implements Tool {
  readonly id = 'select';
  editor!: CamEditor;
  hint(): string { return 'Click to select, drag across empty space for an area, Shift+click to add'; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const hit = this.editor.hits(p.raw)[0];
    if (!hit) { if (!p.shift) this.editor.clearSelection(); return; }
    this.editor.select([hit.group ?? hit.key], p.shift);
  }
}

/** An aperture as text: C 0.236mm, R 1.6 × 1.2mm, macro THERMAL80 … */
export function apertureText(ap: Aperture, f: (c: number) => string): string {
  if (ap.shape === 'C') return `Round ${f(ap.w)}${ap.hole ? `, hole ${f(ap.hole)}` : ''}`;
  if (ap.shape === 'R') return `Rectangular ${f(ap.w)} × ${f(ap.h)}`;
  if (ap.shape === 'O') return `Obround ${f(ap.w)} × ${f(ap.h)}`;
  if (ap.shape === 'P') return `Polygon ${ap.vertices}-sided ${f(ap.w)}`;
  return `Macro ${ap.macro} (${f(ap.w)} × ${f(ap.h)})`;
}
