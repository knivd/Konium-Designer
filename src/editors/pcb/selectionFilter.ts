/**
 * The Selection Filter (26.189): the kinds of object a click or an area selection takes on a
 * board, as the desktop software's Properties panel has it with nothing selected. Every kind is
 * on to begin with; a kind turned off is passed over by a click (what lies under it is taken
 * instead), is left out of a selection box, and is not listed in the popup of overlapping
 * objects. It is for the session, and the same for every board open.
 *
 * A component's pad is its component while Components is on (the popup offers both); with
 * Components off and Pads on, the pad itself.
 */
import { signal } from '@preact/signals';

export const SELECTION_KINDS = ['Components', '3D Bodies', 'Keepouts', 'Tracks', 'Arcs', 'Pads', 'Vias', 'Regions', 'Polygons', 'Fills', 'Texts', 'Rooms', 'Other'] as const;
export type SelectionKind = typeof SELECTION_KINDS[number];

/** The kinds turned off. */
export const selectionOff = signal<ReadonlySet<SelectionKind>>(new Set());
export const selects = (k: SelectionKind): boolean => !selectionOff.value.has(k);
export function setSelects(k: SelectionKind, on: boolean): void {
  const s = new Set(selectionOff.value);
  if (on) s.delete(k); else s.add(k);
  selectionOff.value = s;
}
/** All - On: every kind on; with every kind on already, every kind off (as the desktop software's button turns). */
export function selectAllKinds(on = true): void { selectionOff.value = on ? new Set() : new Set(SELECTION_KINDS); }
