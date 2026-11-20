import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { formatCoord, mil } from '../../core/units';
import { addPads, addPrimRecords, placedRecord } from '../../model/pcbEdit';
import { hasDefault } from '../../model/pcbDefaults';
import { encodePad } from '../../formats/altium/pcbdoc';
import { L, layerColour, type LayerId } from '../../model/layers';
import { hexToRgb, settings } from '../../core/settings';
import type { PcbEditor } from './PcbEditor';

export type PadShapeName = 'round' | 'rect' | 'octagon';

/** The pad Place › Pad puts down next; Tab edits it in Properties, as Altium's pad defaults. */
export interface PadTemplate { designator: string; layer: LayerId; shape: PadShapeName; w: number; h: number; hole: number; rotation: number }

export const defaultPad = (): PadTemplate => ({ designator: '1', layer: L.MULTI, shape: 'round', w: mil(60), h: mil(60), hole: mil(30), rotation: 0 });

/** Altium increments designators: 1 → 2, A1 → A2, A → B. */
export function nextDesignator(d: string): string {
  const m = /^(.*?)(\d+)$/.exec(d);
  if (m) return `${m[1]}${Number(m[2]) + 1}`;
  if (/^[A-Y]$/i.test(d)) return String.fromCharCode(d.charCodeAt(0) + 1);
  return d;
}

/**
 * Place › Pad (P, P). The pad follows the cursor; click places it and the designator steps on;
 * Space turns it 90°; right-click or Esc ends. Size, shape, hole and layer come from the
 * Properties panel (Tab), where they stay for the next pad.
 */
export class PlacePadTool implements Tool {
  readonly id = 'place-pad';
  private at: Vec2 | null = null;

  constructor(private ed: PcbEditor) {
    const used = ed.doc.prims.filter((p) => p.kind === 'pad').map((p) => (p as { name: string }).name);
    const t = ed.padTemplate;
    while (used.includes(t.designator)) t.designator = nextDesignator(t.designator);
  }

  hint(): string {
    const t = this.ed.padTemplate, u = this.ed.units();
    return `Pad ${t.designator}: ${t.shape} ${formatCoord(t.w, u)} × ${formatCoord(t.h, u)}${t.hole ? `, hole ${formatCoord(t.hole, u)}` : ''}, ${this.ed.layerLabel(t.layer)}. Click to place, Space to rotate, Tab for properties, right-click to finish`;
  }

  pointerMove(p: ToolPointer): void { this.at = p.world; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const t = this.ed.padTemplate;
    const layer = t.hole > 0 ? L.MULTI : t.layer === L.MULTI ? L.TOP : t.layer;
    const f = { name: t.designator, layer, at: p.world, w: t.w, h: t.h, shape: t.shape, hole: t.hole, rotation: t.rotation };
    // From the pad default (Tab, Preferences › Defaults): its masks, stack and the rest come along
    this.ed.undo.transact(`Place pad ${t.designator}`, (tx) => tx.add(hasDefault('Pads6')
      ? addPrimRecords(this.ed.doc, [{ storage: 'Pads6', rec: placedRecord(this.ed.doc, 'Pads6', (tp) => encodePad(f, tp)) }])
      : addPads(this.ed.doc, [f])));
    t.designator = nextDesignator(t.designator);
  }
  key(combo: string): boolean {
    if (combo === 'Space') { const t = this.ed.padTemplate; t.rotation = (t.rotation + 90) % 360; return true; }
    return false;
  }
  cancel(): boolean { return false; }

  overlay(): ToolOverlay | null {
    if (!this.at) return null;
    const t = this.ed.padTemplate;
    const ang = ((t.rotation + (t.w >= t.h ? 0 : 90)) * Math.PI) / 180;
    const long = Math.max(t.w, t.h), short = Math.min(t.w, t.h), h = t.shape === 'round' ? (long - short) / 2 : (long - short) / 2;
    const d = { x: Math.cos(ang) * h, y: Math.sin(ang) * h };
    const colour = t.hole ? hexToRgb(settings.pcbViaColour) : layerColour(t.layer === L.MULTI ? L.TOP : t.layer);
    const segs = [{ a: { x: this.at.x - d.x, y: this.at.y - d.y }, b: { x: this.at.x + d.x, y: this.at.y + d.y }, width: short, color: colour }];
    return { segments: segs, circles: t.hole ? [{ c: this.at, r: t.hole / 2, color: hexToRgb(settings.pcbHoleColour) }] : [] };
  }
}
