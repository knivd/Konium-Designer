import type { Tool, ToolPointer } from '../../core/tools';
import type { PropertyBag } from '../../formats/altium/props';
import { rederive, type SchObject } from '../../model/sch';
import type { Vec2 } from '../../core/geom';
import { addRecords } from '../../model/schEdit';
import { edgeSlot, entryDistanceProps, isSymbol } from '../../model/schHierarchy';
import type { SchEditor } from './SchEditor';

/**
 * Place › Add Sheet Entry, as Altium does it: click a sheet symbol, then the entry slides
 * along the inside of its nearest edge with the cursor; each click drops one (names step on:
 * Entry1, Entry2 …). Right-click lets go of the symbol to choose another; a second right-click
 * leaves the tool. Tab edits the entry before it goes down.
 */
export interface SheetEntrySpec {
  /** The entry as it will be placed (name, I/O type, colours); side and distance follow the cursor. */
  template(): PropertyBag;
  placed(b: PropertyBag): void;
  edit(): void;
  /** What the entry goes on (default: a sheet symbol) and where along it the cursor puts it. */
  owner?: (o: SchObject | undefined) => boolean;
  slot?: (o: SchObject, p: Vec2, grid: number) => { side: number; distance: number };
  /** "Add Sheet Entry", "Place Harness Entry" — for the hint and the undo step. */
  what?: string;
}

export class SheetEntryTool implements Tool {
  readonly id = 'place-sheet-entry';
  private sym: number | null = null;
  private slot: { side: number; distance: number } | null = null;
  private appended = false;

  constructor(private ed: SchEditor, private spec: SheetEntrySpec) {}

  private isOwner(o: SchObject | undefined): boolean { return this.spec.owner ? this.spec.owner(o) : isSymbol(o); }

  hint(): string {
    const what = this.spec.what ?? 'Add Sheet Entry', on = this.spec.owner ? 'harness connector' : 'sheet symbol';
    return this.sym === null
      ? `${what}: click the ${on} to add it to. Esc cancels`
      : `${what}: click to place it on the edge (Tab for properties); right-click to choose another ${on}`;
  }

  private entry(): PropertyBag {
    const b = this.spec.template().clone();
    const s = this.slot!;
    if (s.side) b.set('SIDE', String(s.side)); else b.delete('SIDE');
    for (const [k, v] of Object.entries(entryDistanceProps(s.distance))) { if (v === null) b.delete(k); else b.setRaw(k, v); }
    b.setRaw('OWNERINDEX', String(this.sym));
    return b;
  }

  private drop(): void {
    if (!this.appended) return;
    this.ed.doc.records.pop();
    this.appended = false;
  }

  private show(): void {
    this.drop();
    if (this.sym !== null && this.slot) {
      this.ed.doc.records.push({ kind: 0, data: new Uint8Array(0), bag: this.entry() });
      this.appended = true;
    }
    rederive(this.ed.doc);
    this.ed.invalidate();
  }

  private follow(p: ToolPointer): void {
    const s = this.sym === null ? undefined : this.ed.doc.objects[this.sym];
    if (!s || !this.isOwner(s)) { this.sym = null; this.slot = null; return; }
    this.slot = this.spec.slot ? this.spec.slot(s, p.world, this.ed.gridSize()) : edgeSlot(s as never, p.world, this.ed.gridSize());
  }

  pointerMove(p: ToolPointer): void {
    if (this.sym === null) return;
    this.follow(p);
    this.show();
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (this.sym === null) {
      for (const h of this.ed.hits(p.raw)) {
        const o = this.ed.doc.objects[parseInt(h.key.slice(1), 10)];
        const s = this.isOwner(o) ? o : o && o.owner >= 0 ? this.ed.doc.objects[o.owner] : undefined;
        if (s && this.isOwner(s)) { this.sym = s.index; break; }
      }
      if (this.sym === null) return;
      this.follow(p);
      this.show();
      return;
    }
    this.follow(p);
    if (this.sym === null || !this.slot) return;
    this.drop();
    const b = this.entry();
    this.ed.undo.transact(this.spec.what ? this.spec.what.replace(/^Place /, 'Place ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : 'Place sheet entry', (tx) => tx.add(addRecords(this.ed.doc, [b])));
    this.spec.placed(b);
    this.show();
  }

  cancel(): boolean {
    if (this.sym !== null) { this.drop(); this.sym = null; this.slot = null; rederive(this.ed.doc); this.ed.invalidate(); return true; }
    this.drop(); rederive(this.ed.doc); this.ed.invalidate();
    return false;
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Tab': this.spec.edit(); this.show(); return true;
      case 'Escape': if (!this.cancel()) this.ed.setTool(null); return true;
    }
    return false;
  }

  deactivate(): void { this.drop(); rederive(this.ed.doc); this.ed.invalidate(); }
  suspend(): void { this.drop(); rederive(this.ed.doc); }
  resume(): void { this.show(); }
  /** Undo, redo or an edit from elsewhere: the symbol held may be another object now; it is let go. */
  abort(): void { this.drop(); this.sym = null; this.slot = null; rederive(this.ed.doc); this.ed.invalidate(); }
}
