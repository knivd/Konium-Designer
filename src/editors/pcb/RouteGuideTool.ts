/**
 * ActiveRoute's route guide: a path drawn across the board, vertex by vertex (Shift+Space the
 * corner mode, Space flips it, Backspace takes the last back), as wide as the connections need —
 * Up and Down widen and narrow it, from that width to ten times it, as AD's do; it shows whether
 * the connections fit (red when they don't). Right-click or Enter finishes it and ActiveRoute
 * routes the selected connections along it [est: AD keeps the guide on the board until
 * ActiveRoute runs]. Esc drops it.
 */
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { formatCoord } from '../../core/units';
import { CORNER_MODES, baseMode, cornerLabel, cornerPath, type CornerMode } from '../corner';
import { settings } from '../../core/settings';
import type { PcbEditor } from './PcbEditor';

const GUIDE = 0x6fa8dc, TIGHT = 0xd9534f;

export class RouteGuideTool implements Tool {
  readonly id = 'route-guide';
  private pts: Vec2[] = [];
  private hover: Vec2 | null = null;
  private mode: CornerMode = baseMode(settings.pcbTrackCorner);
  private flip = false;

  private k = 1;
  /** need: how many connections, the space each takes across, on how many layers. */
  constructor(private ed: PcbEditor, private base: number, private done: (pts: Vec2[], width: number) => void, private need?: { count: number; pitch: number; layers: number }) {}
  private get width(): number { return Math.round(this.base * this.k); }
  /** How many of the connections fit across it. */
  private fits(): number { return this.need ? Math.min(this.need.count, Math.floor((this.width / this.need.pitch) * this.need.layers)) : 0; }

  hint(): string {
    const u = this.ed.units(), o = this.ed.origin();
    const w = `${formatCoord(this.width, u)}${this.need ? `, ${this.fits()} of ${this.need.count} connections fit` : ''}`;
    if (!this.pts.length) return `Route Guide (${w} wide): click where the guide starts, near the connections' pads`;
    const h = this.hover ?? this.pts.at(-1)!;
    return `Route Guide (${w} wide, ${cornerLabel(this.mode, this.flip)}): ${this.pts.length} vertices, cursor ${formatCoord(h.x - o.x, u)}, ${formatCoord(h.y - o.y, u)}. Click to add, right-click or Enter to route along it, Backspace removes the last, Esc drops it`;
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.pts.length) { this.pts = [p.world]; return; }
    for (const q of cornerPath(this.pts.at(-1)!, p.world, this.mode, this.flip)) { const l = this.pts.at(-1)!; if (q.x !== l.x || q.y !== l.y) this.pts.push(q); }
  }
  pointerMove(p: ToolPointer): void { this.hover = p.world; }

  /** Right-click: the guide finished with a leg to the cursor's last place, as drawn there. */
  cancel(): boolean {
    if (!this.pts.length) return false;
    if (this.hover) for (const q of cornerPath(this.pts.at(-1)!, this.hover, this.mode, this.flip)) { const l = this.pts.at(-1)!; if (q.x !== l.x || q.y !== l.y) this.pts.push(q); }
    if (this.pts.length < 2) { this.pts = []; return true; }
    this.finish();
    return true;
  }

  private finish(): void {
    const pts = this.pts;
    this.pts = [];
    this.ed.setTool(null);
    if (pts.length >= 2) this.done(pts, this.width);
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Space': this.flip = !this.flip; return true;
      case 'ArrowUp': this.k = Math.min(10, this.k * 1.25); return true;
      case 'ArrowDown': this.k = Math.max(1, this.k / 1.25); return true;
      case 'Shift+Space': this.mode = CORNER_MODES[(CORNER_MODES.indexOf(this.mode) + 1) % CORNER_MODES.length]!; return true;
      case 'Backspace': this.pts.pop(); return true;
      case 'Enter': if (this.pts.length >= 2) { this.finish(); return true; } return false;
      case 'Escape': this.pts = []; this.ed.setTool(null); return true;
    }
    return false;
  }

  overlay(): ToolOverlay | null {
    const pts = this.pts.slice();
    if (this.hover && pts.length) for (const q of cornerPath(pts.at(-1)!, this.hover, this.mode, this.flip)) { const l = pts.at(-1)!; if (q.x !== l.x || q.y !== l.y) pts.push(q); }
    if (pts.length < 2) return null;
    const segments: NonNullable<ToolOverlay['segments']> = [];
    const c = this.need && this.fits() < this.need.count ? TIGHT : GUIDE;
    for (let i = 1; i < pts.length; i++) segments.push({ a: pts[i - 1]!, b: pts[i]!, width: this.width, color: c, hollow: true }, { a: pts[i - 1]!, b: pts[i]!, width: 0, color: c });
    return { segments };
  }
}
