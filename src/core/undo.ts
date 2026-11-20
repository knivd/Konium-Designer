import { Emitter } from './events';

/** A reversible change. apply() is called once when added, then by redo. */
export interface Change {
  apply(): void;
  revert(): void;
}

interface Transaction { label: string; changes: Change[]; at?: number }
const UNSAVED: Transaction = { label: '', changes: [] };

/**
 * Transactional undo. Editors group changes: one user action = one transaction.
 *   undo.transact('Place wire', tx => { tx.add(change1); tx.add(change2); });
 */
export class UndoStack {
  private done: Transaction[] = [];
  private undone: Transaction[] = [];
  private savedAt: Transaction | null = null;
  readonly changed = new Emitter<void>();

  private open: Transaction | null = null;
  /** Steps kept (0: no limit): the oldest go first (Preferences › Undo/Redo › Stack Size). */
  limit = 0;
  /** Group Undo: a step with the label of the one just before, within this many ms, joins it. */
  groupWindow = 0;
  /** Refuse edits (a read-only document): the reason, or null to allow. */
  guard: (() => string | null) | null = null;
  /** Told when an edit was refused. */
  onRefused: ((why: string) => void) | null = null;
  /** When the document last changed (an edit, undo or redo): marks made by a compile before then are stale. */
  editedAt = 0;
  /** Counts the document's changes (an edit, undo or redo). */
  revision = 0;
  /** Runs around every top-level edit, undo and redo (the editor puts its tool aside). */
  around: (<T>(fn: () => T) => T) | null = null;

  /** One user action = one step. A transaction started inside another joins it (batch edits). */
  transact(label: string, fn: (tx: { add(c: Change): void }) => void): void {
    if (this.open) {
      const outer = this.open;
      fn({ add: (c) => { c.apply(); outer.changes.push(c); } });
      return;
    }
    const why = this.guard?.();
    if (why) { this.onRefused?.(why); return; }
    if (this.around) { this.around(() => this.run(label, fn)); return; }
    this.run(label, fn);
  }

  private run(label: string, fn: (tx: { add(c: Change): void }) => void): void {
    const t: Transaction = { label, changes: [], at: Date.now() };
    this.open = t;
    try {
      fn({ add: (c) => { c.apply(); t.changes.push(c); } });
    } catch (e) {
      for (let i = t.changes.length - 1; i >= 0; i--) t.changes[i]!.revert();
      throw e;
    } finally {
      this.open = null;
    }
    if (!t.changes.length) return;
    const last = this.done.at(-1);
    if (this.groupWindow > 0 && last && last.label === t.label && !this.undone.length && last !== this.savedAt && (t.at! - (last.at ?? 0)) <= this.groupWindow) {
      last.changes.push(...t.changes);
      last.at = t.at;
    } else {
      this.done.push(t);
      if (this.limit > 0 && this.done.length > this.limit) this.done.splice(0, this.done.length - this.limit);
    }
    this.undone = [];
    this.editedAt = Date.now();
    this.revision++;
    this.changed.emit();
  }

  undo(): string | null { return this.around && this.canUndo ? this.around(() => this.step(this.done, this.undone, true)) : this.step(this.done, this.undone, true); }
  redo(): string | null { return this.around && this.canRedo ? this.around(() => this.step(this.undone, this.done, false)) : this.step(this.undone, this.done, false); }

  private step(from: Transaction[], to: Transaction[], back: boolean): string | null {
    const t = from.pop();
    if (!t) return null;
    if (back) for (let i = t.changes.length - 1; i >= 0; i--) t.changes[i]!.revert();
    else for (const c of t.changes) c.apply();
    to.push(t);
    this.editedAt = Date.now();
    this.revision++;
    this.changed.emit();
    return t.label;
  }

  get canUndo(): boolean { return this.done.length > 0; }
  get canRedo(): boolean { return this.undone.length > 0; }
  get undoLabel(): string | undefined { return this.done.at(-1)?.label; }
  get redoLabel(): string | undefined { return this.undone.at(-1)?.label; }

  /**
   * The steps made since a checkpoint become one, under this label (a run made of several edits,
   * each made as it was ready, is one step to take back). Nothing changes when the checkpoint is
   * no longer in the stack, or steps were undone since.
   */
  mergeSince(at: unknown, label: string): void {
    const i = at === null ? -1 : this.done.indexOf(at as Transaction);
    if ((at !== null && i < 0) || this.undone.length || this.open) return;
    const steps = this.done.splice(i + 1);
    if (!steps.length) return;
    const merged: Transaction = { label, changes: steps.flatMap((s) => s.changes), at: steps.at(-1)!.at };
    if (this.savedAt && steps.at(-1) === this.savedAt) this.savedAt = merged;
    this.done.push(merged);
    this.changed.emit();
  }

  markSaved(): void { this.savedAt = this.done.at(-1) ?? null; this.changed.emit(); }
  /** The step the document is at now (for marking saved later what was written now). */
  checkpoint(): unknown { return this.done.at(-1) ?? null; }
  markSavedAt(at: unknown): void { this.savedAt = at as Transaction | null; this.changed.emit(); }
  /** Modified without an undo step (renamed, made from another document): Save is due. */
  markUnsaved(): void { this.savedAt = UNSAVED; this.changed.emit(); }
  get dirty(): boolean { return (this.done.at(-1) ?? null) !== this.savedAt; }
}
