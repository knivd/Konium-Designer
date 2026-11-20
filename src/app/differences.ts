/**
 * Schematics and board both ways, as AD17 keeps them together: Design › Update Schematics in
 * <project> (from the board: designators, comments and footprints go back to the sheets) and
 * Project › Show Differences (every difference, each sent towards the side you choose), both
 * through one Engineering Change Order. Update PCB (eco.ts) is the other direction.
 */
import { SchEditor } from '../editors/sch/SchEditor';
import { docBaseName } from '../formats/altium/prjpcb';
import type { CompiledProject } from '../model/compile';
import type { PcbDocument } from '../model/pcb';
import { itemChange, validateItem, type FootprintFinder, type PcbEcoItem } from '../model/pcbEco';
import { applySchItem, compareProject, planSchUpdate, refsBySheet, sheetDifferences, validateSchItem, type Difference, type SchEcoItem } from '../model/comparator';
import type { Editor } from '../editors/Editor';
import { showDialog } from './dialogs';
import { EcoDialog, type EcoChange } from './dialogs/Eco';
import { ChooseCompareDialog, DifferencesDialog } from './dialogs/Differences';
import { footprintFinder } from './eco';
import { openSheet } from './hierarchy';
import { openDocument } from './actions';
import { activeProject, cmdCompile, projectSheets } from './project';
import { docs, notify, tick, type OpenDoc, type Project } from './state';

export interface SyncContext { p: Project; board: OpenDoc; doc: PcbDocument; find: FootprintFinder; project: CompiledProject }

/** The project's PCB documents, by name. */
export const projectBoards = (p: Project): string[] => p.prj.documents.map(docBaseName).filter((n) => /\.pcbdoc$/i.test(n));

/** Compile the project and open (without a tab change) the board to compare with. */
export function syncContext(p: Project | null, boardName?: string): SyncContext | null {
  if (!p) { notify('This works on a PCB project: open the .PrjPcb', 'error'); return null; }
  const name = boardName ?? projectBoards(p)[0];
  if (!name) { notify(`${p.name} has no PCB document`, 'error'); return null; }
  let board = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
  if (!board) {
    const f = p.files.get(name.toLowerCase());
    if (!f) { notify(`${name} isn't in the project folder`, 'error'); return null; }
    board = openDocument(f, p.id, false) ?? undefined;
  }
  if (!board?.editor || board.doc.kind !== 'PcbDoc') { notify(`${name} couldn't be opened`, 'error'); return null; }
  const res = cmdCompile(p);
  if (!res) return null;
  return { p, board, doc: board.doc as PcbDocument, find: footprintFinder(p), project: res.result };
}

/** The sheet as it is now (an open tab's, else read from the project). */
const liveSheet = (p: Project, name: string) => projectSheets(p).find((s) => s.name.toLowerCase() === name.toLowerCase())?.doc;

/**
 * One ECO from chosen changes, either way: the board's in one undo step on the board, each
 * sheet's in one undo step on that sheet.
 */
export function syncEco(ctx: SyncContext, chosen: { toPcb?: PcbEcoItem; toSch?: SchEcoItem }[]): { changes: EcoChange[]; transact: (run: () => void) => void } {
  const { p, board, doc, find } = ctx;
  const pcbItems = chosen.flatMap((c) => (c.toPcb ? [c.toPcb] : []));
  const schItems = chosen.flatMap((c) => (c.toSch ? [c.toSch] : []));
  const boardEd = board.editor!;
  const changes: EcoChange[] = [
    ...schItems.map((it): EcoChange => {
      const sheets = refsBySheet(it);
      return {
        group: it.group, action: it.action, object: it.object, doc: [...sheets.keys()].join(', '), enabled: true,
        validate: () => {
          for (const [name, idx] of sheets) {
            const s = liveSheet(p, name);
            if (!s) return `${name} isn't loaded`;
            const why = validateSchItem(s, it, idx);
            if (why) return why;
          }
          return null;
        },
        execute: () => {
          for (const [name, idx] of sheets) {
            const ed = openSheet(name, p, false)?.editor;
            if (!(ed instanceof SchEditor)) throw new Error(`${name} isn't loaded`);
            ed.undo.transact('Update Schematics', (tx) => applySchItem(ed.doc, it, idx, (c) => tx.add(c)));
            ed.invalidate();
          }
        },
      };
    }),
    ...pcbItems.map((it): EcoChange => ({
      group: it.group, action: it.action, object: it.object, doc: board.name, enabled: true,
      validate: () => validateItem(doc, it, pcbItems, find),
      execute: () => boardEd.undo.transact('Engineering Change Order', (tx) => tx.add(itemChange(doc, it, find))),
    })),
  ];
  // Every affected editor holds one transaction open while the order runs, so each gets one undo step
  const transact = (run: () => void) => {
    const eds: Editor[] = [];
    if (pcbItems.length) eds.push(boardEd);
    for (const name of new Set(schItems.flatMap((it) => [...refsBySheet(it).keys()]))) {
      const ed = openSheet(name, p, false)?.editor;
      if (ed && !eds.includes(ed)) eds.push(ed);
    }
    const nest = (i: number): void => { if (i >= eds.length) run(); else eds[i]!.undo.transact('Engineering Change Order', () => nest(i + 1)); };
    nest(0);
    for (const e of eds) e.invalidate();
    tick.value++;
  };
  return { changes, transact };
}

/** Design › Update Schematics in <project> (from the board). */
export function cmdUpdateSchematics(): void {
  const ctx = syncContext(activeProject());
  if (!ctx) return;
  const all = compareProject(ctx.project, ctx.doc, ctx.find);
  const items = planSchUpdate(ctx.project, ctx.doc, ctx.find);
  const boardOnly = all.filter((d) => !d.toSch).length;
  if (!items.length) {
    notify(boardOnly ? `The schematics agree with the board; ${boardOnly} difference${boardOnly > 1 ? 's' : ''} only the board can take (Project › Show Differences)` : 'The schematics and the board agree');
    return;
  }
  const { changes, transact } = syncEco(ctx, items.map((toSch) => ({ toSch })));
  showDialog(EcoDialog, { title: 'Engineering Change Order', changes, transact });
}

/** Project › Show Differences: choose the board, then the Differences dialog. */
export function cmdShowDifferences(p: Project | null): void {
  if (!p) { notify('Show Differences works on a PCB project', 'error'); return; }
  const boards = projectBoards(p);
  if (!boards.length) { notify(`${p.name} has no PCB document`, 'error'); return; }
  showDialog(ChooseCompareDialog, {
    project: p, boards, sheets: projectSheets(p).map((s) => s.name),
    onOk: (name: string, sheet?: string) => {
      const ctx = syncContext(p, name);
      if (!ctx) return;
      const all: Difference[] = compareProject(ctx.project, ctx.doc, ctx.find);
      const diffs = sheet ? sheetDifferences(all, ctx.project, sheet) : all;
      if (!diffs.length) { notify(`No differences between ${sheet ?? p.name} and ${name}`); return; }
      showDialog(DifferencesDialog, { ctx, diffs });
    },
  });
}
