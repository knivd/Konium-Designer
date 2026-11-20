/**
 * Design › Redefine Board Shape, Edit Board Shape, Move Board Shape and Define Board Cutout:
 * the board's outline drawn, reshaped by its vertex handles or moved with the cursor.
 */
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { formatCoord } from '../../core/units';
import { flattenVertices } from '../../formats/altium/pcbdoc';
import { movedShape, setBoardShape } from '../../model/pcbBoard';
import { hexToRgb, settings } from '../../core/settings';
import { CORNER_MODES, baseMode, cornerLabel, cornerPath, type CornerMode } from '../corner';
import { EDGE_GRIP, moveVertex, tidyVertices } from './PcbGripTool';
import type { PolyVertex } from '../../model/pcb';
import type { PcbEditor } from './PcbEditor';

const OUTLINE = 0xf0e060;

/**
 * Click the vertices of a closed outline (Shift+Space corner mode, Space flips it, Backspace
 * takes the last back); right-click or Enter closes it. Esc drops it.
 */
export class OutlineTool implements Tool {
  readonly id: string;
  private pts: Vec2[] = [];
  private hover: Vec2 | null = null;
  private mode: CornerMode = baseMode(settings.pcbTrackCorner);
  private flip = false;

  constructor(private ed: PcbEditor, private what: string, private onClose: (vs: PolyVertex[]) => void, private repeat = false, id = 'outline') {
    this.id = id;
  }

  hint(): string {
    const o = this.ed.origin(), u = this.ed.units();
    if (!this.pts.length) return `${this.what}: click the first vertex (right-click to finish)`;
    const h = this.hover ?? this.pts.at(-1)!;
    return `${this.what}: ${this.pts.length} vertices (${cornerLabel(this.mode, this.flip)}), cursor ${formatCoord(h.x - o.x, u)}, ${formatCoord(h.y - o.y, u)}. Click to add, right-click to close, Backspace removes the last`;
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.pts.length) { this.pts = [p.world]; return; }
    for (const q of cornerPath(this.pts.at(-1)!, p.world, this.mode, this.flip)) { const l = this.pts.at(-1)!; if (q.x !== l.x || q.y !== l.y) this.pts.push(q); }
    // Clicking the first vertex again closes the outline
    const f = this.pts[0]!, l = this.pts.at(-1)!;
    if (this.pts.length > 3 && f.x === l.x && f.y === l.y) { this.pts.pop(); this.close(); }
  }
  pointerMove(p: ToolPointer): void { this.hover = p.world; }

  cancel(): boolean {
    if (!this.pts.length) return false;
    this.close();
    return true;
  }

  private close(): void {
    const verts = tidyVertices(this.pts.map((p) => ({ p })));
    this.pts = [];
    if (verts.length >= 3) this.onClose(verts);
    if (!this.repeat) this.ed.setTool(null);
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Space': this.flip = !this.flip; return true;
      case 'Shift+Space': this.mode = CORNER_MODES[(CORNER_MODES.indexOf(this.mode) + 1) % CORNER_MODES.length]!; return true;
      case 'Backspace': this.pts.pop(); return true;
      case 'Enter': if (this.pts.length) { this.close(); return true; } return false;
      case 'Escape': if (this.pts.length) { this.pts = []; return true; } this.ed.setTool(null); return true;
    }
    return false;
  }

  overlay(): ToolOverlay | null {
    const pts = this.pts.slice();
    if (this.hover && pts.length) for (const q of cornerPath(pts.at(-1)!, this.hover, this.mode, this.flip)) { const l = pts.at(-1)!; if (q.x !== l.x || q.y !== l.y) pts.push(q); }
    if (pts.length < 2) return null;
    const segments: NonNullable<ToolOverlay['segments']> = [];
    for (let i = 1; i < pts.length; i++) segments.push({ a: pts[i - 1]!, b: pts[i]!, width: 0, color: OUTLINE });
    if (pts.length > 2) segments.push({ a: pts.at(-1)!, b: pts[0]!, width: 0, color: 0x807030 });
    return { segments };
  }
}

/** The board shape's outline and its handles, as an overlay. */
function shapeOverlay(ed: PcbEditor, verts: PolyVertex[], handles: boolean): ToolOverlay {
  const o = flattenVertices(verts);
  const segments: NonNullable<ToolOverlay['segments']> = [];
  for (let i = 0; i < o.length; i++) segments.push({ a: o[i]!, b: o[(i + 1) % o.length]!, width: 0, color: OUTLINE });
  if (!handles) return { segments };
  const px = 1 / (ed.viewport?.cam.scale ?? 1), c = hexToRgb(settings.selectionColour);
  const circles: NonNullable<ToolOverlay['circles']> = [];
  verts.forEach((v, i) => {
    circles.push({ c: v.p, r: 5 * px, color: c }, { c: v.p, r: 3 * px, color: 0xffffff });
    const n = verts[(i + 1) % verts.length]!;
    if (!v.arc) circles.push({ c: { x: (v.p.x + n.p.x) / 2, y: (v.p.y + n.p.y) / 2 }, r: 3.5 * px, color: c });
  });
  return { segments, circles };
}

/**
 * Edit Board Shape: drag a vertex handle to move it, an edge's middle handle to add a vertex
 * there; dropping a vertex on its neighbour removes it. Right-click or Esc finishes.
 */
export class EditBoardShapeTool implements Tool {
  readonly id = 'board-edit';
  private drag: { k: number; at: Vec2 } | null = null;

  constructor(private ed: PcbEditor) {}

  private get verts(): PolyVertex[] { return this.ed.doc.board.vertices; }

  hint(): string {
    if (this.drag) { const o = this.ed.origin(), u = this.ed.units(); return `Edit Board Shape: ${this.drag.k >= EDGE_GRIP ? 'adding a vertex' : 'moving a vertex'} to ${formatCoord(this.drag.at.x - o.x, u)}, ${formatCoord(this.drag.at.y - o.y, u)}`; }
    return 'Edit Board Shape: drag a vertex, or the middle of an edge to add one; right-click to finish';
  }

  private gripAt(p: Vec2): number | null {
    const tol = 7 / (this.ed.viewport?.cam.scale ?? 1);
    const vs = this.verts;
    let best: number | null = null, bd = Infinity;
    vs.forEach((v, i) => {
      const d = Math.hypot(v.p.x - p.x, v.p.y - p.y);
      if (d < tol && d < bd) { best = i; bd = d; }
      const n = vs[(i + 1) % vs.length]!;
      if (v.arc) return;
      const m = { x: (v.p.x + n.p.x) / 2, y: (v.p.y + n.p.y) / 2 }, dm = Math.hypot(m.x - p.x, m.y - p.y);
      if (dm < tol && dm < bd) { best = EDGE_GRIP + i; bd = dm; }
    });
    return best;
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const k = this.gripAt(p.raw);
    if (k !== null) this.drag = { k, at: p.world };
  }
  pointerMove(p: ToolPointer): void { if (this.drag) this.drag.at = p.world; }
  pointerUp(p: ToolPointer): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const vs = tidyVertices(moveVertex(this.verts, d.k, p.world));
    if (vs.length >= 3) this.ed.undo.transact('Edit board shape', (tx) => tx.add(setBoardShape(this.ed.doc, vs)));
    this.ed.invalidate();
  }
  cancel(): boolean { if (this.drag) { this.drag = null; return true; } return false; }
  abort(): void { this.drag = null; }
  key(combo: string): boolean {
    if (combo === 'Escape') { if (this.drag) this.drag = null; else this.ed.setTool(null); return true; }
    return false;
  }
  overlay(): ToolOverlay | null {
    const vs = this.drag ? moveVertex(this.verts, this.drag.k, this.drag.at) : this.verts;
    return vs.length >= 3 ? shapeOverlay(this.ed, vs, true) : null;
  }
}

/** Move Board Shape: the outline follows the cursor from where it was picked up; click to put it down. */
export class MoveBoardShapeTool implements Tool {
  readonly id = 'board-move';
  private from: Vec2 | null = null;
  private at: Vec2 | null = null;

  constructor(private ed: PcbEditor) {}

  hint(): string { return this.from ? 'Move Board Shape: click to place it' : 'Move Board Shape: click the reference point'; }
  pointerMove(p: ToolPointer): void { this.at = p.world; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.from) { this.from = p.world; this.at = p.world; return; }
    const d = { x: p.world.x - this.from.x, y: p.world.y - this.from.y };
    if (d.x || d.y) this.ed.undo.transact('Move board shape', (tx) => tx.add(setBoardShape(this.ed.doc, movedShape(this.ed.doc.board.vertices, d))));
    this.ed.setTool(null);
    this.ed.invalidate();
  }
  key(combo: string): boolean { if (combo === 'Escape') { this.ed.setTool(null); return true; } return false; }
  overlay(): ToolOverlay | null {
    if (!this.from || !this.at) return null;
    return shapeOverlay(this.ed, movedShape(this.ed.doc.board.vertices, { x: this.at.x - this.from.x, y: this.at.y - this.from.y }), false);
  }
}
