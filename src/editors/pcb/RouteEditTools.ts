/**
 * Small interactive tools of 26.038: Edit › Move › Re-Route (a track bent through a new point),
 * Move / Resize Tracks (the selected tracks moved across themselves, neighbours sliding),
 * the swapping tools (a pad, then the pad to swap with), and Modify Polygon Border (a new stretch
 * of a pour's border from one point on it to another).
 */
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { cornerPath } from '../corner';
import { addTracks, removePrims, replaceRecords, setPolygon, repour } from '../../model/pcbEdit';
import { moveTracks } from '../../model/trackOps';
import { modifyBorder, onOutline, withOutline } from '../../model/polygonOps';
import { layerColour } from '../../model/layers';
import { TRACK, get } from '../../formats/altium/pcbLayouts';
import { NO_NET, type PcbPad, type PcbTrack } from '../../model/pcb';
import type { PcbEditor } from './PcbEditor';

const rnd = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const freeTrack = (t: unknown): t is PcbTrack => !!t && (t as PcbTrack).kind === 'track' && (t as PcbTrack).component === NO_NET && (t as PcbTrack).polygon === NO_NET && !(t as PcbTrack).locked;

/** Re-Route: click a track, move, click: it runs from its start through the point to its end (45° corners). */
export class ReRouteTool implements Tool {
  readonly id = 'reroute';
  private t: PcbTrack | null = null;
  private at: Vec2 | null = null;
  private flip = false;
  constructor(private ed: PcbEditor) {}
  hint(): string { return this.t ? 'Re-Route: click where the track is to run through (Space flips the corners), right-click cancels' : 'Re-Route: click a track'; }
  private path(): Vec2[] {
    if (!this.t || !this.at) return [];
    const p = rnd(this.at);
    return [this.t.a, ...cornerPath(this.t.a, p, '45', this.flip), ...cornerPath(p, this.t.b, '45', !this.flip)].filter((q, i, a) => i === 0 || q.x !== a[i - 1]!.x || q.y !== a[i - 1]!.y);
  }
  pointerMove(p: ToolPointer): void { this.at = p.world; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.t) {
      const hit = this.ed.hits(p.raw).map((h) => this.ed.primByKey(h.key)).find(freeTrack);
      if (hit) { this.t = hit; this.at = p.world; }
      return;
    }
    const pts = this.path(), t = this.t, ed = this.ed;
    this.t = null;
    if (pts.length < 3) return;
    ed.undo.transact('Re-Route', (tx) => {
      tx.add(removePrims(ed.doc, [t]));
      tx.add(addTracks(ed.doc, pts.slice(1).map((b, i) => ({ layer: t.layer, a: pts[i]!, b, width: t.width, net: t.net === NO_NET ? undefined : t.net }))));
    });
  }
  key(combo: string): boolean { if (combo === 'Space' && this.t) { this.flip = !this.flip; return true; } return false; }
  cancel(): boolean { if (this.t) { this.t = null; return true; } return false; }
  abort(): void { this.t = null; }
  overlay(): ToolOverlay | null {
    if (!this.t) return null;
    const pts = this.path(), c = layerColour(this.t.layer);
    return { segments: [{ a: this.t.a, b: this.t.b, width: this.t.width, color: 0x808080, hollow: true }, ...pts.slice(1).map((b, i) => ({ a: pts[i]!, b, width: this.t!.width, color: c }))] };
  }
}

/** Move / Resize Tracks: the selected tracks follow the cursor across the clicked one; neighbours keep their directions. */
export class MoveTracksTool implements Tool {
  readonly id = 'move-tracks';
  private grab: { t: PcbTrack; at: Vec2 } | null = null;
  private d: Vec2 = { x: 0, y: 0 };
  constructor(private ed: PcbEditor, private tracks: PcbTrack[]) {}
  hint(): string { return this.grab ? 'Move / Resize Tracks: click to place, right-click cancels' : `Move / Resize Tracks: click one of the ${this.tracks.length} selected tracks`; }
  private delta(p: Vec2): Vec2 {
    const t = this.grab!.t, l = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y) || 1, nx = -(t.b.y - t.a.y) / l, ny = (t.b.x - t.a.x) / l;
    const k = (p.x - this.grab!.at.x) * nx + (p.y - this.grab!.at.y) * ny;
    return { x: Math.round(nx * k), y: Math.round(ny * k) };
  }
  pointerMove(p: ToolPointer): void { if (this.grab) this.d = this.delta(p.world); }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.grab) {
      const hit = this.ed.hits(p.raw).map((h) => this.ed.primByKey(h.key)).find((x): x is PcbTrack => !!x && this.tracks.includes(x as PcbTrack));
      if (hit) { this.grab = { t: hit, at: p.world }; this.d = { x: 0, y: 0 }; }
      return;
    }
    const d = this.delta(p.world), ed = this.ed;
    this.grab = null;
    if (!d.x && !d.y) return;
    const r = moveTracks(ed.doc, this.tracks, d);
    ed.undo.transact('Move / Resize Tracks', (tx) => {
      tx.add(replaceRecords(ed.doc, r.edits));
      if (r.added.length) tx.add(addTracks(ed.doc, r.added.map((t) => ({ ...t, net: t.net === NO_NET ? undefined : t.net }))));
    });
    ed.setTool(null);
  }
  cancel(): boolean { if (this.grab) { this.grab = null; return true; } return false; }
  abort(): void { this.grab = null; }
  overlay(): ToolOverlay | null {
    if (!this.grab) return null;
    const r = moveTracks(this.ed.doc, this.tracks, this.d);
    const segments: NonNullable<ToolOverlay['segments']> = [];
    for (const e of r.edits) {
      const t = this.ed.doc.prims.find((p) => p.src.storage === e.storage && p.src.index === e.index) as PcbTrack | undefined;
      if (!t) continue;
      const s = e.after.subs[0]!;
      const a = { x: get(s, TRACK.x1)!, y: get(s, TRACK.y1)! }, b = { x: get(s, TRACK.x2)!, y: get(s, TRACK.y2)! };
      segments.push({ a, b, width: t.width, color: layerColour(t.layer) });
    }
    for (const t of r.added) segments.push({ a: t.a, b: t.b, width: t.width, color: layerColour(t.layer) });
    return { segments };
  }
}

/** Two pads in turn (the swapping tools): the first is remembered, the second runs `done`. */
export class TwoPadTool implements Tool {
  private first: PcbPad | null = null;
  constructor(private ed: PcbEditor, readonly id: string, private label: string, private done: (a: PcbPad, b: PcbPad) => string | null) {}
  hint(): string { return this.first ? `${this.label}: click the pad to swap with ${this.first.name}` : `${this.label}: click the first pad`; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const pad = this.ed.hits(p.raw).map((h) => this.ed.primByKey(h.key)).find((x): x is PcbPad => x?.kind === 'pad');
    if (!pad) return;
    if (!this.first) { this.first = pad; return; }
    const why = this.done(this.first, pad);
    if (why) { this.ed.status?.(why); return; }
    this.first = null;
  }
  cancel(): boolean { if (this.first) { this.first = null; return true; } return false; }
  abort(): void { this.first = null; }
  overlay(): ToolOverlay | null {
    return this.first ? { circles: [{ c: this.first.at, r: Math.max(this.first.top.w, this.first.top.h) / 2, color: 0xffffff }] } : null;
  }
}

/** Modify Polygon Border: click on a pour's border, click the new corners, click on the border again. */
export class ModifyBorderTool implements Tool {
  readonly id = 'modify-border';
  private poly: number | null = null;
  private from: { edge: number; at: Vec2 } | null = null;
  private pts: Vec2[] = [];
  private cur: Vec2 | null = null;
  constructor(private ed: PcbEditor) {}
  hint(): string {
    if (this.poly === null) return 'Modify Polygon Border: click on the border of a pour where the new stretch starts';
    return 'Modify Polygon Border: click the new corners, then click on the border where it ends (right-click cancels)';
  }
  private tol(): number { return 8 / (this.ed.viewport?.cam.scale ?? 1e-4); }
  pointerMove(p: ToolPointer): void { this.cur = p.world; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const doc = this.ed.doc;
    if (this.poly === null) {
      for (const poly of doc.polygons) {
        const on = onOutline(poly.outline, p.raw, this.tol());
        if (on) { this.poly = poly.index; this.from = on; this.pts = []; return; }
      }
      return;
    }
    const poly = doc.polygons[this.poly]!;
    const on = onOutline(poly.outline, p.raw, this.tol());
    if (!on) { this.pts.push(rnd(p.world)); return; }
    const outline = modifyBorder(poly.outline, this.from!, on, this.pts);
    const i = this.poly, ed = this.ed;
    this.poly = null; this.from = null; this.pts = [];
    if (outline.length < 3) return;
    ed.undo.transact(`Modify border of ${poly.name}`, (tx) => { tx.add(setPolygon(ed.doc, i, withOutline(poly.bag, outline))); tx.add(repour(ed.doc, i)); });
  }
  cancel(): boolean { if (this.poly !== null) { this.poly = null; this.pts = []; return true; } return false; }
  abort(): void { this.poly = null; this.pts = []; this.from = null; }
  overlay(): ToolOverlay | null {
    if (this.poly === null || !this.from) return null;
    const pts = [this.from.at, ...this.pts, ...(this.cur ? [this.cur] : [])];
    return { segments: pts.slice(1).map((b, i) => ({ a: pts[i]!, b, width: 0, color: 0xffffff })) };
  }
}
