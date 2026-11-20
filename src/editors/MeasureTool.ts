import type { Tool, ToolOverlay, ToolPointer } from '../core/tools';
import type { Vec2 } from '../core/geom';
import type { DisplayUnit } from '../core/units';
import { formatCoord } from '../core/units';
import { hexToRgb, settings } from '../core/settings';
import type { Editor } from './Editor';

/** "1234.567mil (31.357mm)": the measurement in both unit systems, the view's first. */
export function bothUnits(d: number, first: DisplayUnit, fmt: (d: number, u: DisplayUnit) => string = formatCoord): string {
  const other: DisplayUnit = first === 'mm' ? 'mil' : 'mm';
  return `${fmt(d, first)} (${fmt(d, other)})`;
}

/**
 * Reports › Measure Distance (Ctrl+M): click two points; the ruler follows the cursor, then
 * the distance, X and Y distances are reported, as Altium's Information box does. It repeats
 * until right-click or Esc.
 */
export class MeasureTool implements Tool {
  readonly id = 'measure';
  private a: Vec2 | null = null;
  private b: Vec2 | null = null;

  constructor(private ed: Editor, private units: () => DisplayUnit, private report: (title: string, lines: string[]) => void,
    private fmt: (d: number, u: DisplayUnit) => string = formatCoord,
    /** The ruler's colours: its line, and the ticks at its ends (a board's First and Second Dimension Line); the selection colour when absent. */
    private colours?: () => { first: number; second: number }) {}

  hint(): string {
    if (!this.a) return 'Measure Distance: click the first point (right-click to finish)';
    const d = this.lengths();
    return `Measure Distance: ${bothUnits(d.d, this.units(), this.fmt)}; click the second point`;
  }

  private lengths(): { d: number; dx: number; dy: number } {
    const a = this.a!, b = this.b ?? a;
    const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
    return { d: Math.hypot(dx, dy), dx, dy };
  }

  pointerMove(p: ToolPointer): void { if (this.a) this.b = p.world; }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.a) { this.a = p.world; this.b = p.world; return; }
    this.b = p.world;
    const { d, dx, dy } = this.lengths(), u = this.units();
    this.report('Information', [
      `Distance = ${bothUnits(d, u, this.fmt)}`,
      `X Distance = ${bothUnits(dx, u, this.fmt)}`,
      `Y Distance = ${bothUnits(dy, u, this.fmt)}`,
    ]);
    this.a = null; this.b = null;
  }

  cancel(): boolean {
    if (this.a) { this.a = null; this.b = null; return true; }
    return false;
  }

  key(combo: string): boolean {
    if (combo === 'Escape') { if (!this.cancel()) this.ed.setTool(null); return true; }
    return false;
  }

  overlay(): ToolOverlay | null {
    if (!this.a || !this.b) return null;
    const own = this.colours?.(), c = own?.first ?? hexToRgb(settings.selectionColour), c2 = own?.second ?? c;
    const px = 1 / (this.ed.viewport?.cam.scale ?? 1);
    const a = this.a, b = this.b;
    const tick = 6 * px, len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const n = { x: (-(b.y - a.y) / len) * tick, y: ((b.x - a.x) / len) * tick };
    const mid = { x: (a.x + b.x) / 2 + n.x * 2.2, y: (a.y + b.y) / 2 + n.y * 2.2 };
    return {
      segments: [
        { a, b, width: 0, color: c },
        { a: { x: a.x - n.x, y: a.y - n.y }, b: { x: a.x + n.x, y: a.y + n.y }, width: 0, color: c2 },
        { a: { x: b.x - n.x, y: b.y - n.y }, b: { x: b.x + n.x, y: b.y + n.y }, width: 0, color: c2 },
      ],
      labels: [{ at: mid, text: this.fmt(len, this.units()), color: c, px: 12 }],
    };
  }
}
