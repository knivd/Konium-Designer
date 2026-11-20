import type { Tool, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import type { PropertyBag } from '../../formats/altium/props';
import { rederive } from '../../model/sch';
import { addRecords } from '../../model/schEdit';
import { settings } from '../../core/settings';
import { CORNER_MODES, cornerLabel, cornerPath, type CornerMode } from '../corner';
import type { SchEditor } from './SchEditor';

/**
 * Objects placed by clicking their defining points, as Altium does: a port (start, then
 * width), text frames and rectangles (two corners), ellipses (centre, X radius, Y radius),
 * arcs (centre, radius, start, end), lines and polygons (a click per vertex, right-click to
 * finish). The object being drawn is a real record, so it looks exactly as it will.
 */
export interface ShapeSpec {
  id: string;
  /** "port", "rectangle" … for the hint and the undo step. */
  what: string;
  /** Clicks that complete the object; 0 = as many as wanted, finished by right-click. */
  clicks: number;
  /** Fewest points for a free-form object to be kept (line 2, polygon 3). */
  min?: number;
  /** Prompt for the next click (index of the click). */
  prompt?: (n: number) => string;
  /**
   * The records for these points (the last one is the cursor while drawing). Empty = nothing to
   * show. `base` is the object index the first record will have (children own by it).
   */
  build(pts: Vec2[], base: number): PropertyBag[];
  /** Before the first click: what follows the cursor (a port with its default width …). */
  ghost?(at: Vec2, base: number): PropertyBag[];
  /** After each object: step names on (Port1 → Port2). */
  placed?(): void;
  /** Free-form objects follow the wire corner modes (Space, Shift+Space). */
  corners?: boolean;
  /** Tab: the object's properties before it is placed. */
  edit?(): void;
}

export class SchShapeTool implements Tool {
  readonly id: string;
  private pts: Vec2[] = [];
  private cur: Vec2 | null = null;
  private appended = 0;
  private mode: CornerMode = settings.schWireCorner;
  private flip = false;

  constructor(private ed: SchEditor, private spec: ShapeSpec) {
    this.id = spec.id;
    this.cur = ed.snap(ed.cursor);
    this.show();
  }

  hint(): string {
    const s = this.spec, n = this.pts.length;
    const step = s.prompt?.(n) ?? (n ? 'click for the next point' : 'click to start');
    const finish = s.clicks ? '' : ', right-click to finish';
    const corner = s.corners && n ? ` (${cornerLabel(this.mode, this.flip)}; Shift+Space changes)` : '';
    return `Place ${s.what}${corner}: ${step}${finish}. Esc cancels`;
  }

  private points(): Vec2[] {
    if (!this.cur) return this.pts;
    if (this.spec.corners && this.pts.length) return [...this.pts, ...cornerPath(this.pts.at(-1)!, this.cur, this.mode, this.flip)];
    return [...this.pts, this.cur];
  }

  private drop(): void {
    const doc = this.ed.doc;
    if (this.appended) { doc.records.splice(doc.records.length - this.appended, this.appended); this.appended = 0; }
  }

  private show(): void {
    this.drop();
    const base = this.ed.doc.records.length - 1;
    const bags = this.pts.length ? this.spec.build(this.points(), base) : this.cur && this.spec.ghost ? this.spec.ghost(this.cur, base) : [];
    for (const bag of bags) this.ed.doc.records.push({ kind: 0, data: new Uint8Array(0), bag });
    this.appended = bags.length;
    rederive(this.ed.doc);
    this.ed.invalidate();
  }

  pointerMove(p: ToolPointer): void { this.cur = p.world; this.show(); }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    this.cur = p.world;
    const s = this.spec;
    if (s.corners && this.pts.length) this.pts.push(...cornerPath(this.pts.at(-1)!, p.world, this.mode, this.flip));
    else this.pts.push(p.world);
    this.pts = dedupe(this.pts);
    if (s.clicks && this.pts.length >= s.clicks) this.commit(this.pts);
    else this.show();
  }

  private commit(pts: Vec2[]): void {
    this.drop();
    const bags = this.spec.build(pts, this.ed.doc.records.length - 1);
    this.pts = [];
    if (bags.length) {
      this.ed.undo.transact(`Place ${this.spec.what}`, (tx) => tx.add(addRecords(this.ed.doc, bags)));
      this.spec.placed?.();
    }
    this.show();
  }

  /** Right-click: finish a free-form object, else drop the one in progress, else leave. */
  cancel(): boolean {
    const s = this.spec;
    if (!s.clicks && this.pts.length >= (s.min ?? 2)) { this.commit(this.pts); return true; }
    if (this.pts.length) { this.pts = []; this.show(); return true; }
    this.drop(); rederive(this.ed.doc); this.ed.invalidate();
    return false;
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Backspace': if (this.pts.length) { this.pts.pop(); this.show(); } return true;
      case 'Escape': if (this.pts.length) { this.pts = []; this.show(); return true; } this.cancel(); this.ed.setTool(null); return true;
      case 'Enter': return this.cancel();
      case 'Tab': if (this.spec.edit) { this.spec.edit(); this.show(); return true; } return false;
      case 'Space': if (this.spec.corners) { this.flip = !this.flip; this.show(); return true; } return false;
      case 'Shift+Space': if (this.spec.corners) { this.mode = CORNER_MODES[(CORNER_MODES.indexOf(this.mode) + 1) % CORNER_MODES.length]!; this.show(); return true; } return false;
    }
    return false;
  }

  deactivate(): void { this.drop(); rederive(this.ed.doc); this.ed.invalidate(); }
  suspend(): void { this.drop(); rederive(this.ed.doc); }
  resume(): void { this.show(); }
}

function dedupe(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) { const l = out.at(-1); if (!l || l.x !== p.x || l.y !== p.y) out.push(p); }
  return out;
}
