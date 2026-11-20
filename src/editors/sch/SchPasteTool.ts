import type { Tool, ToolPointer } from '../../core/tools';
import type { PropertyBag } from '../../formats/altium/props';
import { rederive, schPoint, SR } from '../../model/sch';
import type { Vec2 } from '../../core/geom';
import { addRecords, uniqueId } from '../../model/schEdit';
import { identity, transformBag, type SchXform } from '../../model/schTransform';
import type { SchClip } from '../clipboard';
import type { SchEditor } from './SchEditor';
import { resetPastedDesignators } from '../../model/annotate';
import { settings } from '../../core/settings';
import { partsCutWires } from '../../model/wireTidy';

/**
 * Edit › Paste (Ctrl+V) and Rubber Stamp (Ctrl+R): the copied objects follow the cursor by the
 * reference point they were copied with; click places them (one undo step); Space / Shift+Space
 * turn, X / Y flip; right-click or Esc ends. Rubber stamp keeps pasting until then.
 * Components get new unique IDs; ownership is rebuilt for where the records land.
 */
/** A placement tool built on paste: one new object that follows the cursor (Place › Net Label …). */
export interface SchPlaceOpts {
  id: string;
  /** For the hint and the undo step: "net label". */
  what: string;
  /** The object to place after this one (Altium's auto-increment: NetLabel1 → NetLabel2). */
  next?: (bag: PropertyBag) => PropertyBag;
  /** Same, for objects of several records (a part: next part of the package, or the next designator). */
  nextItems?: (items: SchClip['items']) => SchClip['items'];
  /** Remember the object as it was last placed (and changed with Tab) for the next time. */
  remember?: (bag: PropertyBag) => void;
  /** Tab changed the object: it is its kind's default from now on (Preferences › Default Primitives), unless Permanent is on. */
  edited?: (bag: PropertyBag) => void;
  /** Place it once, then select it and leave the tool (Create Sheet Symbol From Sheet). */
  once?: boolean;
  /**
   * After each placement the cursor steps this many grids (a pin: one down, a pin on the top or bottom one right)
   * unless a pin is already there; the next click or Enter places there until the mouse moves.
   */
  step?: (landed: PropertyBag) => Vec2 | null;
}

export class SchPasteTool implements Tool {
  readonly id: string;
  private x: SchXform;
  private appended = 0;

  /**
   * held: Shift+drag's copies, on the cursor while the button is down; release places them (one
   * undo step), named as stepCopies made them (no designator reset).
   */
  constructor(private ed: SchEditor, private clip: SchClip, private stamp = false, private opts?: SchPlaceOpts, private held = false) {
    this.id = opts?.id ?? (held ? 'sch-copy-drag' : 'sch-paste');
    this.x = identity(clip.ref);
    this.x.d = { x: ed.snap(ed.cursor).x - clip.ref.x, y: ed.snap(ed.cursor).y - clip.ref.y };
    this.show();
  }

  hint(): string {
    if (this.held) return `Copying ${this.clip.items.filter((it) => it.owner < 0).length} object${this.clip.items.filter((it) => it.owner < 0).length === 1 ? '' : 's'}: release to place, Space rotates, X / Y flip, Esc cancels`;
    if (this.opts) return `Place ${this.opts.what}: click to place, Space rotates, X / Y flip, Tab for properties, right-click ends`;
    return `Paste ${this.clip.items.length} object${this.clip.items.length === 1 ? '' : 's'}: click to place${this.stamp ? ' (again and again)' : ''}, Space rotates, X / Y flip, right-click ends`;
  }

  /** The bags as they would land now, OWNERINDEX pointing at their new owners. */
  private bags(fresh: boolean): PropertyBag[] {
    const base = this.ed.doc.records.length - 1 - this.appended; // object index of the first pasted record
    const bags = this.clip.items.map((it) => {
      const b = transformBag(it.bag, this.x);
      if (it.owner >= 0) b.setRaw('OWNERINDEX', String(base + it.owner));
      if (fresh && b.has('UNIQUEID')) b.setRaw('UNIQUEID', uniqueId());
      return b;
    });
    // Reset Parts Designators On Paste is for pasting; a part being placed keeps the designator it was given
    if (settings.schResetDesignatorsOnPaste && !this.opts && !this.held) resetPastedDesignators(this.clip.items, bags);
    return bags;
  }

  private drop(): void {
    const doc = this.ed.doc;
    if (this.appended) { doc.records.splice(doc.records.length - this.appended, this.appended); this.appended = 0; }
  }

  private show(): void {
    const doc = this.ed.doc;
    this.drop();
    const bags = this.bags(false);
    for (const bag of bags) doc.records.push({ kind: 0, data: new Uint8Array(0), bag });
    this.appended = bags.length;
    rederive(doc);
    // AutoFocus On Place: what the object being placed would join
    if (this.opts) { const first = doc.objects.length - bags.length; this.ed.startFocus(bags.map((_, k) => first + k), 'Place'); }
    this.ed.invalidate();
  }

  pointerMove(p: ToolPointer): void {
    const t = p.world;
    const d = { x: t.x - this.clip.ref.x, y: t.y - this.clip.ref.y };
    if (d.x === this.x.d.x && d.y === this.x.d.y) return;
    this.x = { ...this.x, pivot: this.clip.ref, d };
    this.show();
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0 || this.held) return;
    this.place(p);
  }
  /** Shift+drag: the copies land where the button is let go. */
  pointerUp(p: ToolPointer): void { if (this.held && p.button === 0) this.place(p); }

  private place(p: ToolPointer): void {
    this.pointerMove(p);
    this.drop();
    const doc = this.ed.doc;
    const first = doc.records.length - 1;
    const bags = this.bags(true);
    const o = this.opts;
    const parts = bags.map((b, k) => (b.int('RECORD', -1) === 1 && this.clip.items[k]!.owner < 0 ? first + k : -1)).filter((k) => k >= 0);
    this.ed.undo.transact(o ? `Place ${o.what}` : `${this.held ? 'Copy' : 'Paste'} ${bags.length} object${bags.length === 1 ? '' : 's'}`, (tx) => {
      tx.add(addRecords(doc, bags));
      if (settings.schComponentsCutWires && parts.length) partsCutWires(doc, parts, (c) => tx.add(c));
    });
    if (o && !o.once) {
      // Placing: nothing gets selected; the next object steps on and the orientation stays
      const placed = this.clip.items[0]!.bag;
      const next = o.next ? o.next(placed) : placed;
      this.clip = { ...this.clip, items: [{ ...this.clip.items[0]!, bag: next }, ...this.clip.items.slice(1)] };
      if (o.nextItems) this.clip = { ...this.clip, items: o.nextItems(this.clip.items) };
      o.remember?.(transformBag(next, { ...this.x, d: { x: 0, y: 0 } }));
      this.show();
      const dir = o.step?.(bags[0]!);
      if (dir) this.stepCursor(dir, bags[0]!);
      return;
    }
    const tops = this.clip.items.map((it, k) => (it.owner < 0 ? `o${first + k}` : null)).filter((k): k is string => !!k);
    this.ed.select(tops);
    if (this.stamp && !o) this.show(); else this.ed.setTool(null);
  }

  /** The crosshair (and the object with it) a grid step on, where nothing of the same kind sits yet [est]. */
  private stepCursor(dir: Vec2, landed: PropertyBag): void {
    const g = this.ed.gridSize(), vp = this.ed.viewport;
    if (!vp || !g) return;
    const cursor = { x: this.clip.ref.x + this.x.d.x, y: this.clip.ref.y + this.x.d.y };
    const at = { x: cursor.x + dir.x * g, y: cursor.y + dir.y * g };
    const loc = schPoint(landed, 'LOCATION.X', 'LOCATION.Y');
    const there = { x: loc.x + at.x - cursor.x, y: loc.y + at.y - cursor.y };
    const rec = landed.int('RECORD', -1);
    const taken = this.ed.doc.objects.some((o, k) => k < this.ed.doc.objects.length - this.appended && o.record === rec && rec === SR.PIN && o.kind === 'pin'
      && Math.abs(o.at.x - there.x) < 1 && Math.abs(o.at.y - there.y) < 1);
    if (!taken) vp.cursorTo(at);
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Space': this.x = { ...this.x, quarter: (this.x.quarter + 1) % 4 }; this.show(); return true;
      case 'Shift+Space': this.x = { ...this.x, quarter: (this.x.quarter + 3) % 4 }; this.show(); return true;
      case 'X': this.x = this.x.quarter % 2 ? { ...this.x, mirrorY: !this.x.mirrorY } : { ...this.x, mirrorX: !this.x.mirrorX }; this.show(); return true;
      case 'Y': this.x = this.x.quarter % 2 ? { ...this.x, mirrorX: !this.x.mirrorX } : { ...this.x, mirrorY: !this.x.mirrorY }; this.show(); return true;
      case 'Escape': this.cancel(); this.ed.setTool(null); return true;
      case 'Tab': {
        const o = this.opts, edit = this.ed.placeProps;
        if (!o) return false;
        // A part: its Component Properties, designator, comment and parameters included
        if (this.clip.items.length > 1 && this.clip.items[0]!.bag.int('RECORD', -1) === 1 && this.ed.placePartProps) {
          this.ed.placePartProps(this.clip.items, (items) => { this.clip = { ...this.clip, items }; this.show(); });
          return true;
        }
        if (!edit) return false;
        edit(this.clip.items[0]!.bag, (b) => {
          this.clip = { ...this.clip, items: [{ ...this.clip.items[0]!, bag: b }, ...this.clip.items.slice(1)] };
          o.remember?.(b);
          o.edited?.(b);
          this.show();
        });
        return true;
      }
    }
    return false;
  }

  cancel(): boolean { this.drop(); rederive(this.ed.doc); this.ed.endFocus(); this.ed.invalidate(); return false; }
  suspend(): void { this.drop(); rederive(this.ed.doc); }
  resume(): void { this.show(); }
  deactivate(): void { if (this.appended) this.cancel(); this.ed.endFocus(); }
}
