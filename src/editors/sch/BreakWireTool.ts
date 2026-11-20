import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import { distToSegment, type Vec2 } from '../../core/geom';
import { isShown } from '../../model/sch';
import { breakWire } from '../../model/schEdit';
import { hexToRgb, settings, updateSettings } from '../../core/settings';
import { mil } from '../../core/units';
import type { SchEditor } from './SchEditor';

/**
 * Edit › Break Wire: a cutter box rides along the wire under the cursor; click cuts that much
 * out of it, leaving two wires (or one, at an end). The cutting length is Altium's: the whole
 * segment, a multiple of the snap grid, or a fixed length — Space steps through them. Right-click
 * or Esc ends.
 */
export type CutMode = 'segment' | 'grid' | 'fixed';
const LABEL: Record<CutMode, string> = { segment: 'Snap To Segment', grid: 'Snap Grid Size Multiple', fixed: 'Fixed Length' };

export class BreakWireTool implements Tool {
  readonly id = 'break-wire';
  private cur: ToolPointer | null = null;
  private cut: { index: number; seg: number; from: Vec2; to: Vec2 } | null = null;

  constructor(private ed: SchEditor) {}

  hint(): string {
    const m = settings.schBreakCut;
    const len = m === 'grid' ? ` × ${settings.schBreakMultiple}` : m === 'fixed' ? ` ${settings.schBreakFixed}mil` : '';
    return `Break Wire (${LABEL[m]}${len}; Space changes): click a wire to cut it; right-click to finish`;
  }

  private find(p: ToolPointer): BreakWireTool['cut'] {
    const doc = this.ed.doc, tol = 6 / (this.ed.viewport?.cam.scale ?? 1);
    let best: { index: number; seg: number; d: number } | null = null;
    for (const o of doc.objects) {
      if ((o.kind !== 'wire' && o.kind !== 'bus') || !isShown(doc, o) || !this.ed.unmasked(o.index)) continue;
      for (let i = 1; i < o.pts.length; i++) {
        const d = distToSegment(p.raw, o.pts[i - 1]!, o.pts[i]!);
        if (d <= tol + o.width / 2 && (!best || d < best.d)) best = { index: o.index, seg: i - 1, d };
      }
    }
    if (!best) return null;
    const o = doc.objects[best.index] as { pts: Vec2[] };
    const a = o.pts[best.seg]!, b = o.pts[best.seg + 1]!;
    if (settings.schBreakCut === 'segment') return { index: best.index, seg: best.seg, from: a, to: b };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) return null;
    const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    // Centre on the (snapped) cursor, projected onto the segment
    const c = Math.min(len, Math.max(0, (p.world.x - a.x) * u.x + (p.world.y - a.y) * u.y));
    const L = settings.schBreakCut === 'grid' ? this.ed.gridSize() * Math.max(1, settings.schBreakMultiple) : mil(Math.max(1, settings.schBreakFixed));
    const t0 = Math.max(0, c - L / 2), t1 = Math.min(len, c + L / 2);
    const at = (t: number): Vec2 => ({ x: Math.round(a.x + u.x * t), y: Math.round(a.y + u.y * t) });
    return { index: best.index, seg: best.seg, from: at(t0), to: at(t1) };
  }

  pointerMove(p: ToolPointer): void { this.cur = p; this.cut = this.find(p); }
  abort(): void { this.cut = null; }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const c = this.find(p);
    if (!c) return;
    const ch = breakWire(this.ed.doc, c.index, c.seg, c.from, c.to);
    if (ch) this.ed.undo.transact('Break wire', (tx) => tx.add(ch));
    this.cut = null;
  }

  key(combo: string): boolean {
    if (combo !== 'Space') return false;
    const order: CutMode[] = ['segment', 'grid', 'fixed'];
    updateSettings({ schBreakCut: order[(order.indexOf(settings.schBreakCut) + 1) % order.length]! });
    this.cut = this.cur ? this.find(this.cur) : null;
    return true;
  }

  overlay(): ToolOverlay | null {
    const c = this.cut, box = settings.schBreakCutterBox, marks = settings.schBreakMarkers;
    const col = hexToRgb(settings.selectionColour), red = 0xff0000;
    const px = 1 / (this.ed.viewport?.cam.scale ?? 1);
    if (!c) {
      // Preferences › Break Wire › Show Cutter Box: Always — a box at the cursor even off a wire
      if (box !== 'always' || !this.cur) return null;
      const p = this.cur.world, L = settings.schBreakCut === 'fixed' ? mil(settings.schBreakFixed) : this.ed.gridSize() * Math.max(1, settings.schBreakMultiple);
      return { segments: [{ a: { x: p.x - L / 2, y: p.y }, b: { x: p.x + L / 2, y: p.y }, width: 16 * px, color: col, hollow: true }] };
    }
    const dx = c.to.x - c.from.x, dy = c.to.y - c.from.y, len = Math.hypot(dx, dy) || 1;
    const n = { x: (-dy / len) * 8 * px, y: (dx / len) * 8 * px };
    const tick = (p: Vec2) => ({ a: { x: p.x - n.x, y: p.y - n.y }, b: { x: p.x + n.x, y: p.y + n.y }, width: 2 * px, color: red });
    // The cutter box and its extremity markers, as Preferences › Break Wire says
    const segments = [];
    if (box !== 'never') segments.push({ a: c.from, b: c.to, width: 16 * px, color: col, hollow: true });
    if (marks !== 'never') segments.push(tick(c.from), tick(c.to));
    return segments.length ? { segments } : null;
  }
}
