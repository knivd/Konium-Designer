import type { Tool, ToolPointer } from '../../core/tools';
import type { PropertyBag } from '../../formats/altium/props';
import type { Vec2 } from '../../core/geom';
import { rederive } from '../../model/sch';
import { replaceBags } from '../../model/schEdit';
import { moveGrip } from '../../model/schGrips';
import type { SchEditor } from './SchEditor';

/** Dragging a vertex or corner handle of the selected object; release keeps it, Esc puts it back. */
export class SchGripTool implements Tool {
  readonly id = 'sch-grip';
  private orig: PropertyBag;

  constructor(private ed: SchEditor, private index: number, private k: number) {
    this.orig = ed.doc.records[index + 1]!.bag!.clone();
    ed.startFocus([index], 'Edit');
  }

  hint(): string { return 'Drag the handle; release to keep, Esc to put it back'; }

  private last: Vec2 | null = null;
  pointerMove(p: ToolPointer): void { this.last = p.world; this.drag(p.world); }

  private drag(at: Vec2): void {
    const doc = this.ed.doc;
    const o0 = doc.objects[this.index];
    if (!o0) return;
    // Grips are computed from the original shape so the dragged one is always grip k
    const r = doc.records[this.index + 1]!;
    r.bag = this.orig.clone();
    rederive(doc);
    r.bag = moveGrip(this.orig, doc.objects[this.index]!, this.k, at);
    rederive(doc);
    this.ed.invalidate();
  }

  pointerUp(): void {
    const doc = this.ed.doc;
    const after = doc.records[this.index + 1]!.bag!.clone();
    doc.records[this.index + 1]!.bag = this.orig.clone();
    rederive(doc);
    if (after.toBytes().join() !== this.orig.toBytes().join()) {
      this.ed.undo.transact('Move vertex', (tx) => tx.add(replaceBags(doc, [{ index: this.index, before: this.orig, after }])));
    }
    this.ed.endFocus();
    this.ed.setTool(null);
  }

  /** Saved mid-drag: the shape as it was, then the drag again; anything else changing the document ends it. */
  private held = -1;
  suspend(): void {
    const r = this.ed.doc.records[this.index + 1];
    if (r) { r.bag = this.orig.clone(); rederive(this.ed.doc); }
    this.held = this.ed.undo.revision;
  }
  resume(): void {
    const same = this.held === this.ed.undo.revision;
    this.held = -1;
    if (!same) this.abort(); else if (this.last) this.drag(this.last);
  }
  abort(): void { this.ed.endFocus(); this.ed.setTool(null); }

  key(combo: string): boolean { if (combo === 'Escape') { this.cancel(); this.ed.setTool(null); return true; } return false; }
  cancel(): boolean {
    const doc = this.ed.doc;
    doc.records[this.index + 1]!.bag = this.orig.clone();
    rederive(doc);
    this.ed.endFocus();
    this.ed.invalidate();
    return false;
  }
}
