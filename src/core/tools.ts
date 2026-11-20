import type { Vec2 } from './geom';

export interface ToolPointer {
  /** World position after grid snap. */
  world: Vec2;
  /** World position before snap. */
  raw: Vec2;
  button: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

/** Transient geometry a tool wants drawn (rubber band, ghost). World units. */
export interface ToolOverlay {
  /** Hollow: drawn as an outline (the routing look-ahead segment). */
  segments?: { a: Vec2; b: Vec2; width: number; color: number; hollow?: boolean }[];
  circles?: { c: Vec2; r: number; color: number }[];
  /** Filled areas (with holes), drawn under the rest at `alpha` (the routing clearance boundaries). */
  polys?: { outline: Vec2[]; holes: Vec2[][]; color: number; alpha?: number }[];
  /** Screen-sized labels (measurements), `px` high, centred on `at`. */
  labels?: { at: Vec2; text: string; color: number; px?: number }[];
}

/**
 * Interactive tool state machine. Altium conventions every tool should follow:
 *  left click = commit point, right click / Esc = step back then exit,
 *  Space = rotate / corner direction, Shift+Space = cycle corner mode,
 *  Tab = edit properties of the object being placed, Backspace = remove last point.
 */
export interface Tool {
  readonly id: string;
  readonly cursor?: string;
  hint(): string;
  activate?(): void;
  deactivate?(): void;
  pointerDown?(p: ToolPointer): void;
  pointerMove?(p: ToolPointer): void;
  /** Left button released; `moved` when the press became a drag. */
  pointerUp?(p: ToolPointer, moved: boolean): void;
  /** Right click. Return true if handled (stepped back); false means "exit tool". */
  cancel?(): boolean;
  key?(combo: string): boolean;
  overlay?(): ToolOverlay | null;
  /**
   * Tools that show the object being placed as real records take them out while something
   * else touches the document (undo, redo, save) and put them back after.
   */
  suspend?(): void;
  resume?(): void;
  /**
   * The document was changed by something other than the tool (undo, redo, a command): an
   * operation in progress that holds the document's objects (by index or as read) is dropped.
   */
  abort?(): void;
}
