/**
 * The text a document view edits as text (the Mixed Sim netlist editor): Edit › Undo, Cut,
 * Copy, Paste and Select All, and the text editor's own Edit, Tools and Window commands, act on
 * it while its document is in front.
 */
import { active } from './state';

export type SplitMode = 'none' | 'horizontal' | 'vertical';
export interface TextTarget {
  undo(): void; redo(): void; cut(): void; copy(): void; paste(): void; selectAll(): void;
  find(): void; findNext(): void; gotoLine(): void;
  /** Edit › Replace, Find Next Selected, Clear (the selection), Clear Browser Marks (the find's highlights). */
  replace(): void; findNextSelected(): void; clear(): void; clearMarks(): void; hasMarks(): boolean;
  /** Tools › Indent / Unindent, Change Case, Show Code Templates. */
  indent(out: boolean): void; changeCase(what: 'selection' | 'word', how: 'upper' | 'lower' | 'capitalise'): void; templates(): void;
  /** Window › Split Vertically / Horizontally, Remove Split. */
  split(mode: SplitMode): void; splitMode(): SplitMode;
}

let target: TextTarget | null = null;
export const setTextTarget = (t: TextTarget | null): void => { target = t; };
/** The text in front, if the document in front is edited as text. */
export const textTarget = (): TextTarget | null => (active.value?.doc.kind === 'SimText' ? target : null);
