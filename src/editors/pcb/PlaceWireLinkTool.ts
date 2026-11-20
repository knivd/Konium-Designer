import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { UNITS_PER_MM } from '../../core/units';
import { notify } from '../../app/state';
import { L } from '../../model/layers';
import { netName } from '../../model/pcb';
import { NO_WIRE_LAYER, copperAt, placeWireLink, wireEnd, wireLinkLayer, wireLinkLength, wireLinkPad, wireLinkWidth, wireStart, type CopperHit } from '../../model/wireLink';
import { CORNER_MODES, cornerLabel, cornerPath, type CornerMode } from '../corner';
import type { PcbEditor } from './PcbEditor';

/** The wire's insulation while it is placed (as the 3D view draws it). */
const INSULATION = 0x8e1f1a;
/** A pad's copper while the wire is placed, and the running length beside the cursor. */
const PAD_COLOUR = 0xc0c0c0;
const LABEL = 0xffc8b4;

/**
 * Place › Wire Link (P, I): an insulated wire between two pieces of one net's copper on an outer
 * layer (model/wireLink). Click copper of a net (a track, arc, pad, via or area) on the top or
 * bottom layer to start, click for each bend (Ctrl+click bends over copper), then click copper of
 * the same net on the same side to finish: one undo step, Place Wire Link. Backspace takes the
 * last point back, Shift+Space cycles the corner mode (90°, 45°, any angle), Space flips the
 * corner, right-click or Esc drops the link under way (then ends the tool).
 */
export class PlaceWireLinkTool implements Tool {
  readonly id = 'place-wire-link';
  private start: CopperHit | null = null;
  private pts: Vec2[] = [];
  private hover: Vec2 | null = null;
  private mode: CornerMode = 'any';
  private flip = false;

  constructor(private ed: PcbEditor) {}

  private label(l: number): string { return this.ed.layerLabel(l); }
  private mm(v: number): string { return `${(Math.round((v / UNITS_PER_MM) * 10) / 10).toFixed(1)} mm`; }
  /** What is drawn so far, with the leg to the cursor. */
  private path(to: Vec2 | null = this.hover): Vec2[] {
    if (!this.pts.length) return [];
    const all = to ? [...this.pts, ...cornerPath(this.pts.at(-1)!, to, this.mode, this.flip)] : this.pts.slice();
    return all.filter((q, k) => k === 0 || q.x !== all[k - 1]!.x || q.y !== all[k - 1]!.y);
  }

  hint(): string {
    const s = this.start;
    if (!s) return 'Wire link: click copper of a net on the top or bottom layer to start';
    const net = netName(this.ed.doc, s.net);
    return `Wire link on ${this.label(s.layer)} (${net}), ${this.mm(wireLinkLength(this.path()))}: click for a bend (Ctrl+click over copper), click copper of ${net} to finish; `
      + `Backspace takes the last point back, Shift+Space corner mode (${cornerLabel(this.mode, this.flip)}), right-click cancels`;
  }

  private hits(p: ToolPointer): CopperHit[] {
    const tol = 3 / (this.ed.viewport?.cam.scale ?? 1);
    const raw = copperAt(this.ed.doc, p.raw, tol);
    return raw.length ? raw : copperAt(this.ed.doc, p.world, tol);
  }

  pointerMove(p: ToolPointer): void { this.hover = p.world; }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const doc = this.ed.doc;
    if (!this.start) {
      const r = wireStart(this.hits(p), this.ed.currentLayer === L.BOTTOM ? L.BOTTOM : L.TOP);
      if ('error' in r) { notify(r.error, 'error'); return; }
      if (!wireLinkLayer(doc)) { notify(NO_WIRE_LAYER, 'error'); return; }
      this.start = r.hit;
      this.pts = [r.hit.at];
      this.hover = r.hit.at;
      return;
    }
    if (!p.ctrl) {
      const r = wireEnd(doc, this.start, this.hits(p));
      if (r && 'error' in r) { notify(r.error, 'error'); return; }
      if (r) { this.finish(r.end.at); return; }
    }
    // A bend
    const last = this.pts.at(-1)!;
    for (const q of cornerPath(last, p.world, this.mode, this.flip)) if (q.x !== this.pts.at(-1)!.x || q.y !== this.pts.at(-1)!.y) this.pts.push(q);
  }

  private finish(end: Vec2): void {
    const s = this.start!;
    const path = this.path(end);
    if (wireLinkLength(path, 0) < 1) { notify('A wire link ends away from where it starts', 'error'); return; }
    try {
      let placed = '';
      this.ed.undo.transact('Place Wire Link', (tx) => {
        const w = placeWireLink(this.ed.doc, { path, layer: s.layer, net: s.net });
        tx.add(w.change);
        placed = `${w.designator}: ${this.mm(w.length)} of wire on ${netName(this.ed.doc, s.net)}`;
      });
      if (placed) notify(placed);
    } catch (e) { notify((e as Error).message, 'error'); }
    this.reset();
  }

  private reset(): void { this.start = null; this.pts = []; }

  key(combo: string): boolean {
    switch (combo) {
      case 'Space': this.flip = !this.flip; return true;
      case 'Shift+Space': this.mode = CORNER_MODES[(CORNER_MODES.indexOf(this.mode) + 1) % CORNER_MODES.length]!; return true;
      case 'Backspace':
        if (this.pts.length > 1) this.pts.pop(); else this.reset();
        return true;
      case 'Escape': return this.cancel();
    }
    return false;
  }

  /** Right-click or Esc: the link under way goes; with none, the tool ends. */
  cancel(): boolean {
    if (!this.start) return false;
    this.reset();
    return true;
  }

  overlay(): ToolOverlay | null {
    if (!this.start) return null;
    const pts = this.path(), width = wireLinkWidth(), r = wireLinkPad() / 2;
    const segments = pts.slice(1).map((b, k) => ({ a: pts[k]!, b, width, color: INSULATION }));
    const circles = [{ c: pts[0]!, r, color: PAD_COLOUR }];
    const at = pts.at(-1)!;
    return { segments, circles, labels: [{ at: { x: at.x, y: at.y + 3 * width }, text: this.mm(wireLinkLength(pts)), color: LABEL }] };
  }

  deactivate(): void { this.reset(); }
  abort(): void { this.reset(); }
}
