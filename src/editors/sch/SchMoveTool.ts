import type { Tool, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { formatCoord } from '../../core/units';
import type { PropertyBag } from '../../formats/altium/props';
import { rederive } from '../../model/sch';
import { addRecords, replaceBags, wireBag } from '../../model/schEdit';
import { identity, mapPoint, refPoint, transformBag, withChildren, type SchXform } from '../../model/schTransform';
import { connectionPoints, dragAttached, linkWires } from '../../model/schDrag';
import { settings } from '../../core/settings';
import type { SchEditor } from './SchEditor';

export type MoveMode = 'move' | 'drag';

/** Graphics with no reference point of their own (Center of Object holds these at their centre). */
const NO_REFERENCE = new Set(['rect', 'ellipse', 'polygon', 'polyline', 'arc', 'bezier', 'piechart', 'image', 'textframe', 'compilemask', 'blanket']);

/**
 * Moving objects on the sheet, as Altium does it:
 *  - press on an object and drag: Move (attached wires stay put) — Ctrl, or Preferences ›
 *    Always Drag, makes it Drag (attached wires stretch and stay connected); release places;
 *  - Move › Move / Drag (M, M / M, D): click an object, it follows the cursor, click places;
 *  - Move › Move Selection / Drag Selection (M, S): click a reference point, then place.
 * While moving: Space turns 90° counter-clockwise, Shift+Space clockwise, X flips left–right,
 * Y flips top–bottom; right-click or Esc puts everything back. The reference point (component
 * or text location, first wire vertex) lands on the grid. Objects move live, as in Altium.
 */
export class SchMoveTool implements Tool {
  readonly id = 'sch-move';
  private picking: boolean;
  private set: number[] = [];
  private orig = new Map<number, PropertyBag>();
  private x: SchXform = identity();
  private grab: Vec2 = { x: 0, y: 0 };
  private ref: Vec2 = { x: 0, y: 0 };
  private changed = new Set<number>();
  /** Wires the drag added at T-connections (appended records, replaced on every update). */
  private links: Vec2[][] = [];
  private appended = 0;

  constructor(private ed: SchEditor, private mode: MoveMode, indices: number[] | null, grab: Vec2 | null, private release = false) {
    this.picking = !indices || !grab;
    if (indices && grab) this.begin(indices, grab);
  }

  private begin(indices: number[], grab: Vec2): void {
    const doc = this.ed.doc;
    indices = this.ed.unlocked(indices);
    if (!indices.length) { this.picking = true; if (this.release) setTimeout(() => this.ed.setTool(null), 0); return; }
    this.set = withChildren(doc, indices);
    this.orig.clear();
    // Originals of everything that may change: the moving set and every wire / junction (for Drag)
    for (const o of doc.objects) {
      const bag = doc.records[o.index + 1]?.bag;
      if (bag && (this.set.includes(o.index) || o.kind === 'wire' || o.kind === 'bus' || o.kind === 'junction')) this.orig.set(o.index, bag.clone());
    }
    this.grab = grab;
    this.ref = refPoint(doc, indices[0]!) ?? grab;
    // Preferences › Graphical Editing › Object's Electrical Hot Spot / Center of Object: where the object is held
    if (!this.pickSelection) {
      const devices = new Set(this.set.filter((i) => { const k = doc.objects[i]?.kind; return k !== 'wire' && k !== 'bus'; }));
      const spots = devices.size ? [...connectionPoints(doc, devices).pts.values()] : [];
      if (settings.schGrabHotSpot && spots.length) {
        const near = spots.reduce((a, b) => (Math.hypot(b.x - grab.x, b.y - grab.y) < Math.hypot(a.x - grab.x, a.y - grab.y) ? b : a));
        this.ref = this.grab = near;
      } else if (settings.schGrabCentre && indices.every((i) => NO_REFERENCE.has(doc.objects[i]?.kind ?? ''))) {
        // Center of Object: shapes without a reference point (a rectangle …) are held at their centre
        const b = this.ed.boxOf(indices);
        if (Number.isFinite(b.minX)) this.grab = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      }
    }
    this.x = identity(this.grab);
    this.picking = false;
    this.ed.startFocus(this.set, 'Move');
  }

  hint(): string {
    if (this.picking) return this.mode === 'drag' ? 'Drag: click the object to drag (attached wires follow)' : 'Move: click the object to move';
    const u = 'mil' as const;
    const d = this.x.d;
    return `${this.mode === 'drag' ? 'Dragging' : 'Moving'} ${this.set.length} object${this.set.length === 1 ? '' : 's'} by ${formatCoord(d.x, u)}, ${formatCoord(d.y, u)}. `
      + `${this.release ? 'Release' : 'Click'} to place, Space / Shift+Space rotate, X / Y flip, right-click cancels`;
  }

  /** Lay the objects (and, when dragging, the wires they pull) out at the current transform. */
  private dropLinks(): void {
    const doc = this.ed.doc;
    if (this.appended) { doc.records.splice(doc.records.length - this.appended, this.appended); this.appended = 0; }
  }

  private update(): void {
    const doc = this.ed.doc;
    this.dropLinks();
    const moving = new Set(this.set);
    const next = new Map<number, PropertyBag>();
    for (const i of this.set) { const b = this.orig.get(i); if (b) next.set(i, transformBag(b, this.x)); }
    if (this.mode === 'drag') {
      // Connectivity from the original positions: put originals back first
      for (const [i, b] of this.orig) { const r = doc.records[i + 1]; if (r) r.bag = b.clone(); }
      rederive(doc);
      for (const [i, b] of dragAttached(doc, moving, this.x, (k) => this.orig.get(k), settings.schDragOrthogonal)) next.set(i, b);
      this.links = linkWires(doc, moving, this.x);
    }
    for (const i of this.changed) if (!next.has(i)) { const r = doc.records[i + 1], b = this.orig.get(i); if (r && b) r.bag = b.clone(); }
    for (const [i, b] of next) { const r = doc.records[i + 1]; if (r) r.bag = b; }
    this.changed = new Set(next.keys());
    for (const l of this.links) doc.records.push({ kind: 0, data: new Uint8Array(0), bag: wireBag(l) });
    this.appended = this.links.length;
    rederive(doc);
    this.ed.invalidate();
  }

  private follow(p: Vec2): void {
    const x0 = { ...this.x, d: { x: 0, y: 0 } };
    const r = mapPoint(x0, this.ref);
    const target = this.ed.snap({ x: r.x + p.x - this.grab.x, y: r.y + p.y - this.grab.y });
    const d = { x: target.x - r.x, y: target.y - r.y };
    if (d.x === this.x.d.x && d.y === this.x.d.y) return;
    this.x = { ...this.x, d };
    this.update();
  }

  pointerMove(p: ToolPointer): void { if (!this.picking) this.follow(p.raw); }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (this.picking) {
      if (this.ed.selection.size && this.mode && this.pickSelection) { this.begin(this.ed.selectedIndices(), p.world); return; }
      const hit = this.ed.hits(p.raw)[0];
      if (!hit) return;
      const idx = this.ed.indicesOfKey(hit.key);
      this.ed.select([hit.key]);
      this.begin(idx, p.world);
      return;
    }
    if (!this.release) { this.follow(p.raw); this.commit(); }
  }

  pointerUp(p: ToolPointer): void {
    if (!this.release || this.picking) return;
    this.follow(p.raw);
    this.commit();
  }

  /** Move › Move Selection: the first click picks the reference point instead of an object. */
  pickSelection = false;

  key(combo: string): boolean {
    if (this.picking) return false;
    switch (combo) {
      case 'Space': this.turn(1); return true;
      case 'Shift+Space': this.turn(3); return true;
      case 'X': this.flip('x'); return true;
      case 'Y': this.flip('y'); return true;
      case 'Escape': this.restore(); this.ed.setTool(null); return true;
    }
    return false;
  }

  /** Turn about the cursor: compose a quarter turn about the current grab point. */
  private turn(q: number): void {
    this.x = { ...this.x, quarter: (this.x.quarter + q) % 4 };
    this.update();
  }
  private flip(axis: 'x' | 'y'): void {
    // A flip after a turn is a flip across the other axis before it
    const across = this.x.quarter % 2 ? (axis === 'x' ? 'y' : 'x') : axis;
    this.x = across === 'x' ? { ...this.x, mirrorX: !this.x.mirrorX } : { ...this.x, mirrorY: !this.x.mirrorY };
    this.update();
  }

  /** Everything back where it was. */
  private putBack(): void {
    const doc = this.ed.doc;
    this.dropLinks();
    this.links = [];
    for (const i of this.changed) { const r = doc.records[i + 1], b = this.orig.get(i); if (r && b) r.bag = b.clone(); }
    this.changed.clear();
    rederive(doc);
    this.ed.invalidate();
  }
  private restore(): void { this.putBack(); this.ed.endFocus(); }

  /** Saved mid-move: the document as it was; the move carries on after unless the document changed meanwhile. */
  private held = -1;
  suspend(): void { if (this.picking) return; this.putBack(); this.held = this.ed.undo.revision; }
  resume(): void {
    if (this.held < 0) return;
    const same = this.held === this.ed.undo.revision;
    this.held = -1;
    if (same) this.update(); else this.abort();
  }
  /** Undo, redo or an edit from elsewhere mid-move: the objects held are no longer those indices. */
  abort(): void {
    if (this.picking) return;
    this.restore();
    this.picking = true;
    this.x = identity();
    if (this.release || this.pickSelection) this.ed.setTool(null);
  }

  private commit(): void {
    const doc = this.ed.doc;
    this.dropLinks();
    const links = this.links;
    this.links = [];
    const entries = [...this.changed].map((i) => ({ index: i, before: this.orig.get(i)!, after: doc.records[i + 1]!.bag!.clone() }));
    const n = this.set.length;
    this.changed.clear();
    if (entries.length || links.length) {
      this.ed.undo.transact(`${this.mode === 'drag' ? 'Drag' : 'Move'} ${n} object${n === 1 ? '' : 's'}`, (tx) => {
        if (entries.length) tx.add(replaceBags(doc, entries));
        if (links.length) tx.add(addRecords(doc, links.map((l) => wireBag(l))));
      });
    }
    this.picking = true;
    this.x = identity();
    this.ed.endFocus();
    if (this.release || this.pickSelection) this.ed.setTool(null);
  }

  cancel(): boolean {
    if (!this.picking) { this.restore(); this.picking = true; if (this.release || this.pickSelection) return false; return true; }
    return false;
  }

  deactivate(): void { if (!this.picking && this.changed.size) this.restore(); }
}
