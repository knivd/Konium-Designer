/**
 * Visual compare: two versions of a schematic or a board side by side, kept at the same place
 * and zoom, what changed coloured in both (added green in the newer, removed red in the older,
 * changed amber in both) and listed below them; a row goes to it in both. Opened from version
 * control's Document History (Compare with Current) and the Storage Manager (Compare). It is a
 * way of looking at the newer one's tab: another tab shows that one as usual, and back on it
 * the compare is there again until closed.
 */
import { signal } from '@preact/signals';
import { formatCoord, formatSchLength, type Coord } from '../core/units';
import { pcbDiff, schDiff, type DiffKind, type VersionDiff } from '../model/versionDiff';
import type { PcbDocument } from '../model/pcb';
import type { SchDocument } from '../model/sch';
import { primKey } from '../editors/pcb/PcbEditor';
import { activeId, docs, notify, units, type OpenDoc } from './state';
import { sheetUnit } from './newSheet';

export interface CompareSide { od: OpenDoc; title: string }
export interface CompareState { older: CompareSide; newer: CompareSide; diffs: VersionDiff[]; at: number; together: boolean; temp: OpenDoc[] }
export const compareView = signal<CompareState | null>(null);

/** Added, removed, changed: green, red, amber. */
export const DIFF_COLOURS: Record<DiffKind, number> = { added: 0x2fa84f, removed: 0xe5484d, changed: 0xe0a100 };

/** What's compared: a version's file (opened out of sight, closed with the compare), or a document open now. */
export type CompareSource = { bytes: Uint8Array; title: string; tag: string } | { od: OpenDoc; title: string };

export const canCompare = (name: string): boolean => /\.(schdoc|pcbdoc)$/i.test(name);

/** The differences between the two sides as their documents are now. */
function differences(older: OpenDoc, newer: OpenDoc): VersionDiff[] {
  if (older.doc.kind === 'PcbDoc' && newer.doc.kind === 'PcbDoc') {
    const fmt = (c: Coord) => formatCoord(c, units.value);
    return pcbDiff(older.doc as PcbDocument, newer.doc as PcbDocument, { prim: primKey, poly: (i) => `poly:${i}` }, fmt);
  }
  if (older.doc.kind === 'SchDoc' && newer.doc.kind === 'SchDoc') {
    const u = sheetUnit(newer.doc as SchDocument);
    return schDiff(older.doc as SchDocument, newer.doc as SchDocument, (i) => `o${i}`, (c) => formatSchLength(c, u));
  }
  return [];
}

/** Each side's objects coloured by what happened to them. */
function mark(c: CompareState): void {
  const o = new Map<string, number>(), n = new Map<string, number>();
  for (const d of c.diffs) {
    for (const k of d.old) o.set(k, DIFF_COLOURS[d.kind]);
    for (const k of d.cur) n.set(k, DIFF_COLOURS[d.kind]);
  }
  c.older.od.editor?.setDiffMarks(o);
  c.newer.od.editor?.setDiffMarks(n);
}

export async function startCompare(name: string, older: CompareSource, newer: CompareSource): Promise<boolean> {
  if (!canCompare(name)) { notify('Compare shows schematics and boards: open the two versions of other documents side by side (Window › Tile)', 'error'); return false; }
  closeCompare();
  const { openDocument } = await import('./actions');
  const temp: OpenDoc[] = [];
  const side = (s: CompareSource): CompareSide | null => {
    if ('od' in s) return { od: s.od, title: s.title };
    const od = openDocument({ name: name.replace(/(\.[^.]+)$/, ` (${s.tag})$1`), bytes: s.bytes }, undefined, false);
    if (!od?.editor) { notify(`${name} as it was in ${s.tag} couldn't be read`, 'error'); return null; }
    od.hidden = true;
    od.forCompare = true;
    temp.push(od);
    return { od, title: s.title };
  };
  const a = side(older), b = a && side(newer);
  if (!a || !b) { for (const t of temp) await closeTemp(t); return false; }
  const c: CompareState = { older: a, newer: b, diffs: differences(a.od, b.od), at: -1, together: true, temp };
  compareView.value = c;
  mark(c);
  activeId.value = b.od.id;
  docs.value = [...docs.value];
  notify(c.diffs.length ? `${c.diffs.length} difference${c.diffs.length === 1 ? '' : 's'}` : 'No differences');
  return true;
}

/** The differences found again (after edits on the newer side). */
export function refreshCompare(): void {
  const c = compareView.value;
  if (!c) return;
  const next = { ...c, diffs: differences(c.older.od, c.newer.od), at: -1 };
  compareView.value = next;
  mark(next);
}

async function closeTemp(od: OpenDoc): Promise<void> {
  const { cmdClose } = await import('./actions');
  await cmdClose(od, false);
}

export function closeCompare(): void {
  const c = compareView.value;
  if (!c) return;
  compareView.value = null;
  c.older.od.editor?.setDiffMarks(null);
  c.newer.od.editor?.setDiffMarks(null);
  for (const t of c.temp) void closeTemp(t);
}

/** A difference gone to: selected in both, both views round it. */
export function showDiff(i: number): void {
  const c = compareView.value;
  const d = c?.diffs[i];
  if (!c || !d) return;
  compareView.value = { ...c, at: i };
  let box: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  for (const [s, keys] of [[c.older, d.old], [c.newer, d.cur]] as const) {
    const ed = s.od.editor;
    if (!ed) continue;
    ed.selection = new Set(keys);
    ed.invalidateOverlay();
    const b = keys.length ? ed.selectionBounds() : null;
    if (b && Number.isFinite(b.minX)) box = box ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) } : b;
  }
  if (!box) return;
  // Room round it: a quarter of its size, at least 100 mil
  const m = Math.max((box.maxX - box.minX) / 4, (box.maxY - box.minY) / 4, 1_000_000);
  const fit = { minX: box.minX - m, minY: box.minY - m, maxX: box.maxX + m, maxY: box.maxY + m };
  c.newer.od.editor?.viewport?.fitBox(fit);
  if (!c.together) c.older.od.editor?.viewport?.fitBox(fit);
}

/** The views kept at the same place and zoom (or let go). */
export function setTogether(on: boolean): void {
  const c = compareView.value;
  if (c) compareView.value = { ...c, together: on };
}
