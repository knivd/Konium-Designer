/**
 * Place › Dimension: the clicks AD asks for, the dimension drawn as it will be on the current
 * layer, repeated until right-click or Esc.
 * - Linear, Dimension, Linear Diameter: the first point, the second, then where the line runs
 *   (Space turns it between horizontal and vertical).
 * - Angular: two points on each arm (AD's four clicks, on the edges to measure), then the arc's
 *   radius and side.
 * - Radial, Radial Diameter: an arc, circle or round pad (or the centre then a point on the
 *   circle), then where the leader ends.
 * - Leader: the arrow's point and the bends; right-click ends.
 * - Datum, Baseline: the points (the first is the datum); right-click, then where the values sit.
 * - Center: an arc, circle or round pad (or a point).
 */
import type { Vec2 } from '../../core/geom';
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { PcbEditor } from './PcbEditor';
import { addDimension, armsCross, dimKindName, dimensionEdges, dimensionGeometry, geometryStrokes, newDimension, refObject, type RefObject } from '../../model/dimensions';
import { layerColour } from '../../model/layers';
import { mil } from '../../core/units';

export class PlaceDimensionTool implements Tool {
  readonly id: string;
  private pts: Vec2[] = [];
  /** The object under each point picked (what AD keeps as the reference). */
  private objs: (RefObject | null)[] = [];
  private cur: Vec2 | null = null;
  private angle = 0;
  /** Radial / center: the circle picked (centre, radius). */
  private circle: { c: Vec2; r: number } | null = null;
  /** Datum / baseline: the points are in, now place the values. */
  private placing = false;
  constructor(private ed: PcbEditor, private kind: number) { this.id = `place-dimension-${kind}`; }

  private get name(): string { return dimKindName(this.kind); }
  hint(): string {
    const n = this.pts.length, k = this.kind;
    const what = `Place ${this.name} Dimension: `;
    if (k === 1 || k === 8 || k === 9) return what + ['click the first point', 'click the second point', 'click where the dimension line runs (Space turns it)'][Math.min(n, 2)]!;
    if (k === 2) return what + (n >= 4 && !this.vertex() ? 'the arms are parallel — Backspace and pick again'
      : ['click a point on the first edge', 'click a second point on the first edge', 'click a point on the second edge', 'click a second point on the second edge', 'click to set the radius and side'][Math.min(n, 4)]!);
    if (k === 3 || k === 10) return what + (this.circle ? 'click where the leader ends' : n ? 'click a point on the circle' : 'click an arc, a circle or a round pad, or the centre');
    if (k === 4) return what + (n ? 'click the next point (right-click ends)' : "click the arrow's point");
    if (k === 5 || k === 6) return what + (this.placing ? 'click where the values sit' : n ? 'click the next point (right-click when done)' : 'click the datum point');
    return what + 'click an arc, a circle or a round pad, or the centre';
  }

  private metric(): boolean { return this.ed.doc.board.bag?.int('DISPLAYUNIT', 1) === 0; }

  /** An arc, circle or round pad / via under the cursor: its centre and radius. */
  private circleAt(raw: Vec2): { c: Vec2; r: number } | null {
    for (const h of this.ed.hits(raw)) {
      const p = this.ed.primByKey(h.key);
      if (p?.kind === 'arc') return { c: p.c, r: p.r };
      if (p?.kind === 'via') return { c: p.at, r: p.diameter / 2 };
      if (p?.kind === 'pad' && p.top.shape === 'round' && p.top.w === p.top.h) return { c: p.at, r: p.top.w / 2 };
    }
    return null;
  }

  /** Angular: where the two arms (two points each) cross. */
  private vertex(): Vec2 | null {
    const [a, b, c, d] = this.pts;
    if (!a || !b || !c || !d) return null;
    const v = armsCross(a, { x: b.x - a.x, y: b.y - a.y }, c, { x: d.x - c.x, y: d.y - c.y });
    return v && Math.hypot(b.x - a.x, b.y - a.y) > 0 && Math.hypot(d.x - c.x, d.y - c.y) > 0 ? { x: Math.round(v.x), y: Math.round(v.y) } : null;
  }

  /** The object the click is on, kept with the point. */
  private objectAt(raw: Vec2, at: Vec2): RefObject | null {
    for (const h of this.ed.hits(raw)) {
      const p = this.ed.primByKey(h.key);
      const r = p ? refObject(p, at) : null;
      if (r) return r;
    }
    return null;
  }

  /** The dimension the clicks so far (and the cursor) make, or null. */
  private build(cur: Vec2 | null): Parameters<typeof newDimension>[0] | null {
    const k = this.kind, p = this.pts, layer = this.ed.currentLayer, metric = this.metric();
    const at = cur ?? p.at(-1);
    if (!at) return null;
    if (k === 1 || k === 8 || k === 9) {
      if (p.length < 2) return p.length === 1 && cur ? { kind: k, layer, refs: [p[0]!, cur], at: cur, angle: this.angle, metric, objects: this.objs } : null;
      return { kind: k, layer, refs: [p[0]!, p[1]!], at, angle: this.angle, metric, objects: this.objs };
    }
    if (k === 2) {
      const v = this.vertex();
      if (p.length < 4 || !v) return null;
      return { kind: k, layer, refs: p.slice(0, 4), at: v, angle: 0, metric, pick: at, objects: this.objs.slice(0, 4) };
    }
    if (k === 3 || k === 10) {
      const c = this.circle;
      if (!c) return null;
      const d = Math.hypot(at.x - c.c.x, at.y - c.c.y) || 1;
      const tip = { x: Math.round(c.c.x + ((at.x - c.c.x) / d) * c.r), y: Math.round(c.c.y + ((at.y - c.c.y) / d) * c.r) };
      return { kind: k, layer, refs: [c.c, at], at: tip, angle: 0, metric };
    }
    if (k === 4) {
      const refs = cur ? [...p, cur] : p;
      return refs.length >= 2 ? { kind: k, layer, refs, at: refs[0]!, angle: 0, metric, text: 'String' } : null;
    }
    if (k === 5 || k === 6) {
      if (!p.length || (!this.placing && !cur)) return null;
      return { kind: k, layer, refs: p, at, angle: this.angle, metric, objects: this.objs };
    }
    if (k === 7) {
      const c = this.circle ?? (cur ? { c: cur, r: mil(50) } : null);
      return c ? { kind: k, layer, refs: [], at: c.c, angle: 0, metric, height: Math.round(c.r * 2.4) } : null;
    }
    return null;
  }

  private commit(o: Parameters<typeof newDimension>[0]): void {
    const doc = this.ed.doc;
    const d = newDimension(o, doc.dimensions.length, dimensionEdges(doc.prims), true);
    this.ed.undo.transact(`Place ${this.name} Dimension`, (tx) => tx.add(addDimension(doc, d)));
    this.ed.invalidate();
    this.pts = []; this.objs = []; this.circle = null; this.placing = false;
  }

  pointerMove(p: ToolPointer): void { this.cur = p.world; this.ed.invalidateOverlay(); }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const at = p.world, k = this.kind;
    const pick = () => { this.pts.push(at); this.objs.push(this.objectAt(p.raw, at)); };
    if (k === 1 || k === 8 || k === 9) {
      if (this.pts.length < 2) { pick(); return; }
      this.commit(this.build(at)!); return;
    }
    if (k === 2) {
      if (this.pts.length < 4) { pick(); return; }
      const o = this.build(at);
      if (o) this.commit(o);
      return;
    }
    if (k === 3 || k === 10) {
      if (!this.circle) {
        const c = this.pts.length ? null : this.circleAt(p.raw);
        if (c) { this.circle = c; return; }
        if (!this.pts.length) { this.pts.push(at); return; }
        const r = Math.hypot(at.x - this.pts[0]!.x, at.y - this.pts[0]!.y);
        if (r > 0) this.circle = { c: this.pts[0]!, r };
        return;
      }
      this.commit(this.build(at)!); return;
    }
    if (k === 4) { this.pts.push(at); return; }
    if (k === 5 || k === 6) {
      if (this.placing) { this.commit(this.build(at)!); return; }
      pick(); return;
    }
    if (k === 7) {
      const c = this.circleAt(p.raw);
      if (c) this.circle = c;
      const o = this.build(at);
      if (o) this.commit(o);
    }
  }

  /** Undo, redo or an edit from elsewhere: the objects picked so far are dropped. */
  abort(): void { this.pts = []; this.objs = []; this.circle = null; this.placing = false; }
  /** Right-click: finish a leader or the datum / baseline points; otherwise step back, then leave. */
  cancel(): boolean {
    const k = this.kind;
    if (k === 4 && this.pts.length >= 2) { this.commit(this.build(null)!); return true; }
    if ((k === 5 || k === 6) && this.pts.length >= (k === 6 ? 2 : 1) && !this.placing) { this.placing = true; return true; }
    if (this.pts.length || this.circle || this.placing) { this.pts = []; this.objs = []; this.circle = null; this.placing = false; this.ed.invalidateOverlay(); return true; }
    return false;
  }
  key(combo: string): boolean {
    if (combo === 'Space') { this.angle = (this.angle + 90) % 180; this.ed.invalidateOverlay(); return true; }
    if (combo === 'Backspace') { this.pts.pop(); this.objs.pop(); this.ed.invalidateOverlay(); return true; }
    if (combo === 'Escape') { if (!this.cancel()) this.ed.setTool(null); return true; }
    return false;
  }
  overlay(): ToolOverlay | null {
    const o = this.build(this.cur);
    const col = layerColour(this.ed.currentLayer);
    const segments: NonNullable<ToolOverlay['segments']> = [];
    if (o) {
      const edge = dimensionEdges(this.ed.doc.prims);
      const geo = dimensionGeometry(newDimension(o, 0, edge, true), true, edge);
      for (const st of geometryStrokes(geo)) for (let i = 1; i < st.pts.length; i++) segments.push({ a: st.pts[i - 1]!, b: st.pts[i]!, width: st.w, color: col });
      for (const a of geo.arcs) {
        const n = 24, sweep = ((a.end - a.start) % 360 + 360) % 360 || 360;
        for (let i = 0; i < n; i++) {
          const t0 = ((a.start + (sweep * i) / n) * Math.PI) / 180, t1 = ((a.start + (sweep * (i + 1)) / n) * Math.PI) / 180;
          segments.push({ a: { x: a.c.x + a.r * Math.cos(t0), y: a.c.y + a.r * Math.sin(t0) }, b: { x: a.c.x + a.r * Math.cos(t1), y: a.c.y + a.r * Math.sin(t1) }, width: a.w, color: col });
        }
      }
    } else if (this.pts.length && this.cur) {
      // Angular: the first arm once picked, then the rubber band to the cursor
      if (this.kind === 2 && this.pts.length >= 2) segments.push({ a: this.pts[0]!, b: this.pts[1]!, width: 0, color: 0xffffff });
      segments.push({ a: this.pts.at(-1)!, b: this.cur, width: 0, color: 0xffffff });
    }
    const circles = this.circle ? [{ c: this.circle.c, r: this.circle.r, color: 0xffffff }] : [];
    return { segments, circles };
  }
}
