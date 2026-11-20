/**
 * Tools › Component Placement › Reposition Selected Components (and Cross Select Mode's
 * reposition): the components, one after another, hang from the cursor by their reference
 * point; Space turns by the rotation step, a click puts each down, right-click or Esc stops.
 */
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { settings } from '../../core/settings';
import { placement } from '../../formats/altium/pcbTransform';
import { componentExtent } from '../../model/rooms';
import { layerColour } from '../../model/layers';
import { commitMove } from './PcbMoveTool';
import type { PcbEditor } from './PcbEditor';

export class RepositionTool implements Tool {
  readonly id = 'reposition';
  private at: Vec2 | null = null;
  private rot = 0;
  constructor(private ed: PcbEditor, private queue: number[]) {}
  private get current(): number | undefined { return this.queue[0]; }
  hint(): string {
    const c = this.current;
    return c === undefined ? 'Reposition: done' : `Reposition ${this.ed.doc.components[c]?.designator} (${this.queue.length} to go): click to place, Space turns, right-click stops`;
  }
  pointerMove(p: ToolPointer): void { this.at = this.ed.snap(p.raw); }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const c = this.current;
    if (c === undefined) return;
    const comp = this.ed.doc.components[c]!, to = this.ed.snap(p.raw);
    commitMove(this.ed, { components: [c], polygons: [], prims: [] }, placement(comp.at, this.rot, { x: to.x - comp.at.x, y: to.y - comp.at.y }), this.rot, 'move', `Reposition ${comp.designator}`);
    this.queue.shift();
    this.rot = 0;
    if (!this.queue.length) this.ed.setTool(null);
  }
  key(combo: string): boolean {
    if (combo === 'Space') { this.rot = (this.rot + (settings.pcbRotationStep || 90)) % 360; return true; }
    if (combo === 'Shift+Space') { this.rot = (this.rot - (settings.pcbRotationStep || 90) + 360) % 360; return true; }
    return false;
  }
  cancel(): boolean { this.queue = []; this.ed.setTool(null); return true; }
  abort(): void { this.cancel(); }
  overlay(): ToolOverlay | null {
    const c = this.current;
    if (c === undefined || !this.at) return null;
    const comp = this.ed.doc.components[c]!, b = componentExtent(this.ed.doc, c);
    if (!b) return null;
    const map = placement(comp.at, this.rot, { x: this.at.x - comp.at.x, y: this.at.y - comp.at.y });
    const pts = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }].map(map);
    const col = layerColour(comp.layer);
    return { segments: pts.map((a, i) => ({ a, b: pts[(i + 1) % 4]!, width: 0, color: col })), labels: [{ at: map({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }), text: comp.designator, color: 0xffffff, px: 12 }] };
  }
}
