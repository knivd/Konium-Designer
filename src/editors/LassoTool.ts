import type { Tool, ToolOverlay, ToolPointer } from '../core/tools';
import { pointInPoly, type Vec2 } from '../core/geom';
import { hexToRgb, settings } from '../core/settings';
import type { Editor } from './Editor';

/**
 * Edit › Select › Lasso Select (and DeSelect › Lasso Deselect): click to start, move round
 * the objects — the lasso follows the cursor — and click again to close it. Objects wholly
 * inside join the selection (or leave it); Shift adds to what was selected.
 */
export class LassoTool implements Tool {
  readonly id = 'lasso';
  private pts: Vec2[] = [];
  private cur: Vec2 | null = null;

  constructor(private ed: Editor, private deselect = false) {}

  hint(): string {
    const what = this.deselect ? 'Lasso Deselect' : 'Lasso Select';
    return this.pts.length ? `${what}: move round the objects, click to close the lasso` : `${what}: click to start the lasso`;
  }

  pointerMove(p: ToolPointer): void {
    this.cur = p.raw;
    const last = this.pts.at(-1);
    const px = this.ed.viewport?.cam.scale ?? 1;
    if (last && Math.hypot(p.raw.x - last.x, p.raw.y - last.y) * px > 3) this.pts.push(p.raw);
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.pts.length) { this.pts = [p.raw]; return; }
    this.pts.push(p.raw);
    this.finish(p.shift);
  }

  private finish(add: boolean): void {
    const poly = this.pts;
    this.pts = [];
    if (poly.length >= 3) {
      // Every item an object draws must be inside (as a window selection)
      const byKey = new Map<string, boolean>(), pickable = new Set<string>();
      for (const it of this.ed.allItems()) {
        // As a window selection: only what can be picked (a hidden layer's objects can't)
        if (this.ed.canPick(it)) pickable.add(it.key);
        const b = it.bbox;
        const inside = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }].every((c) => pointInPoly(c, poly));
        byKey.set(it.key, (byKey.get(it.key) ?? true) && inside);
      }
      const keys = this.ed.normaliseSelection([...byKey].filter(([k, v]) => v && pickable.has(k)).map(([k]) => k), false);
      if (this.deselect) for (const k of keys) this.ed.selection.delete(k);
      else { if (!add) this.ed.selection.clear(); for (const k of keys) this.ed.selection.add(k); }
    }
    this.ed.setTool(null);
  }

  cancel(): boolean { if (this.pts.length) { this.pts = []; return true; } return false; }

  overlay(): ToolOverlay | null {
    if (!this.pts.length) return null;
    const c = hexToRgb(settings.selectionColour);
    const pts = this.cur ? [...this.pts, this.cur] : this.pts;
    const segments = pts.slice(1).map((b, i) => ({ a: pts[i]!, b, width: 0, color: c }));
    segments.push({ a: pts.at(-1)!, b: pts[0]!, width: 0, color: c });
    return { segments };
  }
}
