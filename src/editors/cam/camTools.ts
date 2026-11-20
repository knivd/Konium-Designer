/**
 * The CAM editor's interactive tools: points clicked one after another with a live preview
 * (placing lines, arcs, circles, polygons, dimensions, drills …), objects picked (break, text,
 * trace, vertices …), the selection moved, copied, pasted or stamped, and the dynamic pan and zoom.
 * Each follows AD's conventions: left click commits a point, right click or Esc steps back
 * (then ends), Backspace takes the last point away; placing tools repeat until ended.
 */
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import type { GerberLayer, GerberObject } from '../../formats/gerber/gerberRead';
import type { HitItem } from '../Editor';
import { arcPath, flashShapes, type CamEditor } from './CamEditor';

export const PREVIEW = 0xffff00;

/** An object's centre lines (the outline of a flash or region) for a preview. */
export function previewSegments(o: GerberObject, g: GerberLayer | undefined, colour = PREVIEW): NonNullable<ToolOverlay['segments']> {
  const out: NonNullable<ToolOverlay['segments']> = [];
  const ring = (pts: Vec2[], closed: boolean) => { for (let i = 1; i < pts.length; i++) out.push({ a: pts[i - 1]!, b: pts[i]!, width: 0, color: colour }); if (closed && pts.length > 2) out.push({ a: pts.at(-1)!, b: pts[0]!, width: 0, color: colour }); };
  const ap = o.kind === 'region' ? undefined : g?.apertures.get(o.ap);
  const w = ap ? Math.min(ap.w, ap.h) || ap.w : 0;
  if (o.kind === 'draw') out.push({ a: o.a, b: o.b, width: w, color: colour });
  else if (o.kind === 'arc') { const p = arcPath(o.a, o.b, o.c, o.cw); for (let i = 1; i < p.length; i++) out.push({ a: p[i - 1]!, b: p[i]!, width: w, color: colour }); }
  else if (o.kind === 'flash') { if (ap) for (const s of flashShapes(ap, o.at, o.rot, o.mirror, o.scale)) ring(s.poly, true); else ring([o.at, o.at], false); }
  else for (const c of o.contours) ring(c, true);
  return out;
}

/** A polyline of points as preview segments. */
export function previewPath(pts: Vec2[], width = 0, colour = PREVIEW, closed = false): NonNullable<ToolOverlay['segments']> {
  const out: NonNullable<ToolOverlay['segments']> = [];
  for (let i = 1; i < pts.length; i++) out.push({ a: pts[i - 1]!, b: pts[i]!, width, color: colour });
  if (closed && pts.length > 2) out.push({ a: pts.at(-1)!, b: pts[0]!, width, color: colour });
  return out;
}

export interface PointsSpec {
  id: string;
  /** What the status bar says for the point to click next (n points clicked so far). */
  hint: (n: number) => string;
  /** Points to collect: a number, or 'many' (right-click finishes once `min` are in). */
  count: number | 'many';
  min?: number;
  /** The preview for the points so far and where the cursor is. */
  preview?: (pts: Vec2[], cursor: Vec2) => ToolOverlay | null;
  /** The points are in: make the object(s). Return false to keep collecting (the points so far kept). */
  done: (pts: Vec2[]) => void | false;
  /** Keep placing after one is done (AD's placing tools do). */
  repeat?: boolean;
  /** Keys while placing (Tab for properties, Space to turn …). */
  key?: (combo: string, pts: Vec2[]) => boolean;
  /** Use the unsnapped position (picking a point on an object). */
  raw?: boolean;
}

/** Points clicked one after another with a preview; the spec makes something of them. */
export class PointsTool implements Tool {
  readonly id: string;
  private pts: Vec2[] = [];
  private at: Vec2 | null = null;
  constructor(private ed: CamEditor, private spec: PointsSpec) { this.id = spec.id; }
  hint(): string { return this.spec.hint(this.pts.length); }
  pointerMove(p: ToolPointer): void { this.at = this.spec.raw ? p.raw : p.world; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const at = this.spec.raw ? p.raw : p.world;
    // A click on the point just clicked (a double click) finishes a many-point object
    if (this.spec.count === 'many' && this.pts.length && Math.hypot(at.x - this.pts.at(-1)!.x, at.y - this.pts.at(-1)!.y) < 1) { this.finish(); return; }
    this.pts.push(at);
    this.at = at;
    if (this.spec.count !== 'many' && this.pts.length >= this.spec.count) this.finish();
  }
  private finish(): void {
    const pts = this.pts;
    if (this.spec.count === 'many' && pts.length < (this.spec.min ?? 2)) return;
    const r = this.spec.done(pts);
    if (r === false) return;
    this.pts = [];
    if (!this.spec.repeat) this.ed.setTool(null);
  }
  cancel(): boolean {
    if (this.spec.count === 'many' && this.pts.length >= (this.spec.min ?? 2)) { this.finish(); return true; }
    if (this.pts.length) { this.pts = []; return true; }
    return false;
  }
  key(combo: string): boolean {
    if (combo === 'Backspace' && this.pts.length) { this.pts.pop(); return true; }
    if (combo === 'Enter' && this.spec.count === 'many' && this.pts.length >= (this.spec.min ?? 2)) { this.finish(); return true; }
    return this.spec.key?.(combo, this.pts) ?? false;
  }
  overlay(): ToolOverlay | null {
    if (!this.at) return null;
    return this.spec.preview?.(this.pts, this.at) ?? null;
  }
}

/** Click an object (or a point on one): the callback gets the topmost hit and the point; repeats until ended. */
export class PickTool implements Tool {
  readonly id: string;
  constructor(private ed: CamEditor, id: string, private hintText: string, private picked: (hit: HitItem | undefined, at: Vec2, raw: Vec2, p: ToolPointer) => void | 'end', private filter?: (hit: HitItem) => boolean) { this.id = id; }
  hint(): string { return this.hintText; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const hit = this.ed.hits(p.raw).find((h) => !this.filter || this.filter(h));
    if (this.picked(hit, p.world, p.raw, p) === 'end') this.ed.setTool(null);
  }
  cancel(): boolean { return false; }
}

/** View › Dynamic: drag to pan (pan) or, up and down, to zoom (zoom) [est: CAMtastic's dynamic modes]. */
export class DynamicViewTool implements Tool {
  readonly id: string;
  private from: { x: number; y: number } | null = null;
  constructor(private ed: CamEditor, private mode: 'pan' | 'zoom') { this.id = `cam-dynamic-${mode}`; }
  hint(): string { return this.mode === 'pan' ? 'Dynamic Pan: drag to move the view (right-click to finish)' : 'Dynamic Zoom: drag up to zoom in, down to zoom out (right-click to finish)'; }
  pointerDown(p: ToolPointer): void { if (p.button === 0) { const v = this.ed.viewport; if (v) this.from = v.cam.toScreen(p.raw); } }
  pointerMove(p: ToolPointer): void {
    const v = this.ed.viewport;
    if (!this.from || !v) return;
    const s = v.cam.toScreen(p.raw);
    if (this.mode === 'pan') { v.cam.panScreen(s.x - this.from.x, s.y - this.from.y); this.from = v.cam.toScreen(p.raw); }
    else { const k = Math.pow(1.01, this.from.y - s.y); v.cam.zoomAt({ x: v.cam.width / 2, y: v.cam.height / 2 }, k); this.from = s; }
    v.requestRender();
  }
  pointerUp(): void { this.from = null; }
  cancel(): boolean { return false; }
}
