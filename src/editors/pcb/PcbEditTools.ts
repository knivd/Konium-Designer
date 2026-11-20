import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import type { PcbPrim, PcbTrack } from '../../model/pcb';
import { replaceRecords } from '../../model/pcbEdit';
import { trackWithEnds } from '../../model/pcbTrackEdit';
import { layerColour } from '../../model/layers';
import type { PcbEditor } from './PcbEditor';

/**
 * Two clicks on the board, a rubber line between them (Slice Tracks: the cutting line;
 * Measure Primitives: two objects). Repeats until right-click or Esc, as Altium's do.
 */
export class TwoPointTool implements Tool {
  private a: Vec2 | null = null;
  private cur: Vec2 | null = null;
  private first: PcbPrim | null = null;
  constructor(private ed: PcbEditor, readonly id: string, private prompts: [string, string],
    private done: (a: Vec2, b: Vec2, pa: PcbPrim | null, pb: PcbPrim | null) => void, private onObjects = false) {}
  hint(): string { return this.a ? this.prompts[1] : this.prompts[0]; }
  pointerMove(p: ToolPointer): void { this.cur = this.onObjects ? p.raw : p.world; }
  private primAt(raw: Vec2): PcbPrim | null {
    const hit = this.ed.hits(raw)[0];
    return hit ? this.ed.primByKey(hit.key) ?? null : null;
  }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const at = this.onObjects ? p.raw : p.world;
    if (this.onObjects) {
      const prim = this.primAt(p.raw);
      if (!prim) return;
      if (!this.a) { this.a = at; this.first = prim; return; }
      this.done(this.a, at, this.first, prim);
    } else {
      if (!this.a) { this.a = at; return; }
      this.done(this.a, at, null, null);
    }
    this.a = null; this.first = null;
    this.ed.invalidateOverlay();
  }
  cancel(): boolean { if (this.a) { this.a = null; this.first = null; return true; } return false; }
  abort(): void { this.a = null; this.first = null; }
  key(combo: string): boolean { if (combo === 'Escape') { if (!this.cancel()) this.ed.setTool(null); return true; } return false; }
  overlay(): ToolOverlay | null {
    if (!this.a || !this.cur) return null;
    return { segments: [{ a: this.a, b: this.cur, width: 0, color: 0xffffff }] };
  }
}

/**
 * Edit › Move › Drag Track End: click a track near the end to move, that end follows the
 * cursor, click puts it down (the other end stays); repeats until right-click or Esc.
 */
export class DragTrackEndTool implements Tool {
  readonly id = 'drag-track-end';
  private t: PcbTrack | null = null;
  private k: 0 | 1 = 0;
  private cur: Vec2 | null = null;
  constructor(private ed: PcbEditor) {}
  hint(): string { return this.t ? 'Drag Track End: click where the end goes (right-click puts it back)' : 'Drag Track End: click a track near the end to move'; }
  pointerMove(p: ToolPointer): void { this.cur = p.world; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const ed = this.ed;
    if (!this.t) {
      const t = ed.hits(p.raw).map((h) => ed.primByKey(h.key)).find((q): q is PcbTrack => q?.kind === 'track');
      if (!t) return;
      if (t.locked) { ed.status?.('The track is locked'); return; }
      this.t = t;
      this.k = Math.hypot(p.raw.x - t.a.x, p.raw.y - t.a.y) <= Math.hypot(p.raw.x - t.b.x, p.raw.y - t.b.y) ? 0 : 1;
      this.cur = p.world;
      return;
    }
    const t = this.t, at = p.world, rec = ed.doc.streams.get(t.src.storage)?.records[t.src.index];
    this.t = null;
    const other = this.k === 0 ? t.b : t.a;
    if (!rec || (at.x === other.x && at.y === other.y)) return;
    const after = this.k === 0 ? trackWithEnds(rec, at, t.b) : trackWithEnds(rec, t.a, at);
    ed.undo.transact('Drag track end', (tx) => tx.add(replaceRecords(ed.doc, [{ storage: t.src.storage, index: t.src.index, after }])));
    ed.invalidate();
  }
  cancel(): boolean { if (this.t) { this.t = null; return true; } return false; }
  abort(): void { this.t = null; }
  key(combo: string): boolean { if (combo === 'Escape') { if (!this.cancel()) this.ed.setTool(null); return true; } return false; }
  overlay(): ToolOverlay | null {
    if (!this.t || !this.cur) return null;
    const t = this.t;
    return { segments: [{ a: this.k === 0 ? this.cur : t.a, b: this.k === 0 ? t.b : this.cur, width: t.width, color: layerColour(t.layer) }] };
  }
}
