/**
 * Tools for rooms: clicking out a polygon (Place Polygonal Room; Backspace takes the last corner
 * back, right-click closes it) and dragging a room's corners (Edit Polygonal Room Vertices:
 * click a corner, move, click to drop; right-click finishes).
 */
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { editRooms, roomOutline, roomsOf, withOutline } from '../../model/rooms';
import type { PcbEditor } from './PcbEditor';

const ROOM = 0xb48ce6;
const rnd = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });

/** Corners clicked one after another; right-click (or Esc) with three or more runs `done`. */
export class PolyPointsTool implements Tool {
  private pts: Vec2[] = [];
  private cur: Vec2 | null = null;
  constructor(_ed: PcbEditor, readonly id: string, private label: string, private done: (pts: Vec2[]) => void) {}
  hint(): string { return this.pts.length ? `${this.label}: click the next corner, right-click to close (Backspace takes one back)` : `${this.label}: click the first corner`; }
  pointerMove(p: ToolPointer): void { this.cur = p.world; }
  pointerDown(p: ToolPointer): void { if (p.button === 0) this.pts.push(rnd(p.world)); }
  key(combo: string): boolean { if (combo === 'Backspace' && this.pts.length) { this.pts.pop(); return true; } return false; }
  cancel(): boolean {
    if (!this.pts.length) return false;
    const pts = this.pts;
    this.pts = [];
    if (pts.length >= 3) this.done(pts);
    return true;
  }
  overlay(): ToolOverlay | null {
    const pts = [...this.pts, ...(this.cur && this.pts.length ? [this.cur] : [])];
    if (pts.length < 2) return null;
    return { segments: pts.map((a, i) => ({ a, b: pts[(i + 1) % pts.length]!, width: 0, color: ROOM })).slice(0, pts.length >= 3 ? pts.length : 1) };
  }
}

/** Edit Polygonal Room Vertices: a corner follows the cursor between two clicks. */
export class RoomVertexTool implements Tool {
  readonly id = 'room-vertices';
  private grab: { rule: number; k: number } | null = null;
  private cur: Vec2 | null = null;
  constructor(private ed: PcbEditor, private only?: number) {}
  hint(): string { return this.grab ? 'Edit Polygonal Room Vertices: click where the corner goes' : 'Edit Polygonal Room Vertices: click a corner of a room (right-click finishes)'; }
  private tol(): number { return 8 / (this.ed.viewport?.cam.scale ?? 1e-4); }
  pointerMove(p: ToolPointer): void { this.cur = p.world; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.grab) {
      for (const r of roomsOf(this.ed.doc)) {
        if (this.only !== undefined && r.rule !== this.only) continue;
        const k = r.outline.findIndex((q) => Math.hypot(q.x - p.raw.x, q.y - p.raw.y) <= this.tol());
        if (k >= 0) { this.grab = { rule: r.rule, k }; return; }
      }
      return;
    }
    const { rule, k } = this.grab, ed = this.ed, r = ed.doc.rules[rule]!;
    this.grab = null;
    const o = roomOutline(r);
    o[k] = rnd(p.world);
    ed.undo.transact('Edit room vertices', (tx) => tx.add(editRooms(ed.doc, { set: new Map([[rule, withOutline(r, o)]]) })));
    ed.invalidate();
  }
  cancel(): boolean { if (this.grab) { this.grab = null; return true; } return false; }
  abort(): void { this.grab = null; }
  overlay(): ToolOverlay | null {
    const circles: NonNullable<ToolOverlay['circles']> = [];
    const segments: NonNullable<ToolOverlay['segments']> = [];
    const s = this.ed.viewport?.cam.scale ?? 1e-4;
    for (const r of roomsOf(this.ed.doc)) {
      if (this.only !== undefined && r.rule !== this.only) continue;
      const o = r.outline.map((q, i) => (this.grab && this.grab.rule === r.rule && this.grab.k === i && this.cur ? this.cur : q));
      for (const q of o) circles.push({ c: q, r: 4 / s, color: ROOM });
      if (this.grab?.rule === r.rule) for (let i = 0; i < o.length; i++) segments.push({ a: o[i]!, b: o[(i + 1) % o.length]!, width: 0, color: 0xffffff });
    }
    return { circles, segments };
  }
}
