/**
 * Tools › Annotation, as in Altium Designer 17: Annotate Schematics (dialog), Reset Schematic
 * Designators, Reset Duplicate Schematic Designators, Annotate Schematics Quietly and Force
 * Annotate All Schematics. The quiet commands use the Annotate dialog's last settings (order
 * of processing, sheets enabled); each sheet gets one undo step.
 */
import { planAnnotation, planReset, type AnnotateOrder, type AnnotateRow } from '../model/annotate';
import { setProps } from '../model/schEdit';
import type { SchDocument } from '../model/sch';
import type { SheetInput } from '../model/compile';
import { settings, updateSettings } from '../core/settings';
import { activeProject, projectSheets } from './project';
import { docs, notify, projects, tick, type Project } from './state';
import { openDocument } from './actions';
import { showDialog } from './dialogs';
import { ConfirmDialog } from './dialogs/Confirm';

/** Sheets switched off in the Annotate dialog, per project (or '' for a loose sheet). */
const disabled = new Map<string, Set<string>>();
const key = (p: Project | null) => p?.id ?? '';

export function annotateOrder(): AnnotateOrder { return settings.schAnnotateOrder; }
export function setAnnotateOrder(o: AnnotateOrder): void { updateSettings({ schAnnotateOrder: o }); }
export function sheetEnabled(p: Project | null, sheet: string): boolean { return !disabled.get(key(p))?.has(sheet.toLowerCase()); }
export function setSheetEnabled(p: Project | null, sheet: string, on: boolean): void {
  const k = key(p);
  if (!disabled.has(k)) disabled.set(k, new Set());
  if (on) disabled.get(k)!.delete(sheet.toLowerCase()); else disabled.get(k)!.add(sheet.toLowerCase());
}
/** The sheets the annotation commands work on: the project's, less those switched off. */
export function annotationSheets(p: Project | null = activeProject()): SheetInput[] {
  return projectSheets(p).filter((s) => sheetEnabled(p, s.name));
}

/** The open tab for a sheet, opening it in the background if it isn't open. */
export function sheetDoc(sheet: string, projectId: string | null) {
  let od = docs.value.find((d) => d.name.toLowerCase() === sheet.toLowerCase() && (d.projectId ?? null) === projectId);
  if (!od && projectId) {
    const p = projects.value.find((x) => x.id === projectId);
    const f = p?.files.get(sheet.toLowerCase());
    if (f) od = openDocument(f, projectId, false) ?? undefined;
  }
  return od;
}

/** Write the proposed designators, one undo step per sheet. Returns how many changed. */
export function applyDesignators(rows: AnnotateRow[], projectId: string | null, label: string): number {
  const bySheet = new Map<string, AnnotateRow[]>();
  for (const r of rows) {
    if (r.proposed === r.current || r.designatorIndex === null) continue;
    const list = bySheet.get(r.sheet) ?? [];
    list.push(r);
    bySheet.set(r.sheet, list);
  }
  let n = 0;
  for (const [sheet, list] of bySheet) {
    const od = sheetDoc(sheet, projectId);
    if (!od?.editor) { notify(`${sheet} could not be opened`, 'error'); continue; }
    const doc = od.doc as SchDocument;
    od.editor.undo.transact(label, (tx) => { for (const r of list) tx.add(setProps(doc, r.designatorIndex!, { TEXT: r.proposed })); });
    n += list.length;
  }
  tick.value++;
  return n;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Annotate Schematics Quietly: every unannotated part, with the dialog's last settings, no questions. */
export function cmdAnnotateQuietly(): void {
  const p = activeProject();
  const rows = planAnnotation(annotationSheets(p), annotateOrder());
  if (!rows.length) { notify('All parts are annotated'); return; }
  const n = applyDesignators(rows, p?.id ?? null, 'Annotate schematics quietly');
  notify(`Annotated ${plural(n, 'part')}`);
}

/** Reset Schematic Designators / Reset Duplicate Schematic Designators, after confirming. */
export function cmdResetDesignators(duplicatesOnly: boolean): void {
  const p = activeProject();
  const rows = planReset(annotationSheets(p), duplicatesOnly);
  if (!rows.length) { notify(duplicatesOnly ? 'No duplicate designators' : 'No designators to reset'); return; }
  showDialog(ConfirmDialog, {
    title: duplicatesOnly ? 'Reset Duplicate Designators' : 'Reset Designators',
    message: `${plural(rows.length, 'designator')} will be updated. Do you wish to proceed?`,
    detail: duplicatesOnly ? `Duplicates: ${[...new Set(rows.map((r) => r.current))].join(', ')}` : undefined,
    onYes: () => { const n = applyDesignators(rows, p?.id ?? null, duplicatesOnly ? 'Reset duplicate designators' : 'Reset designators'); notify(`Reset ${plural(n, 'designator')}`); },
  });
}

/** Force Annotate All Schematics: reset every designator, then annotate quietly. */
export function cmdForceAnnotate(): void {
  const p = activeProject();
  const rows = planAnnotation(annotationSheets(p), annotateOrder(), true);
  const changes = rows.filter((r) => r.proposed !== r.current);
  if (!changes.length) { notify('Every designator is already in annotation order'); return; }
  showDialog(ConfirmDialog, {
    title: 'Force Annotate All',
    message: `${plural(changes.length, 'designator')} will be updated. Do you wish to proceed?`,
    detail: 'Every part on the enabled sheets is re-annotated in the current order of processing.',
    onYes: () => { const n = applyDesignators(changes, p?.id ?? null, 'Force annotate all'); notify(`Annotated ${plural(n, 'part')}`); },
  });
}
