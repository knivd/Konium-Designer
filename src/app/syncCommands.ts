/**
 * Keeping schematic and board together, as AD17's Project menu does: Back Annotate Schematics
 * (designators changed on the board come back to the sheets, through an ECO), Component Links
 * (pair parts with board components by unique ID; pair the rest by designator), Board Level
 * Annotate and Annotate Compiled Sheets (no multi-channel rooms: the logical names are the
 * physical ones), Default Prints, and Cross Select Mode (selecting parts on a sheet selects
 * them on the board, and the other way round).
 */
import { effect } from '@preact/signals';
import type { Command } from '../core/commands';
import { settings, updateSettings } from '../core/settings';
import { SchEditor } from '../editors/sch/SchEditor';
import { RepositionTool } from '../editors/pcb/RepositionTool';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { docBaseName } from '../formats/altium/prjpcb';
import type { PcbDocument } from '../model/pcb';
import { setComponentProps } from '../model/pcbEdit';
import { SR } from '../model/sch';
import { setProps } from '../model/schEdit';
import { showDialog } from './dialogs';
import { EcoDialog, type EcoChange } from './dialogs/Eco';
import { ComponentLinksDialog, DefaultPrintsDialog, PhysicalAnnotateDialog } from './dialogs/Sync';
import { NumberSheetsDialog } from './dialogs/ProjectDialogs';
import { openSheet } from './hierarchy';
import { openDocument } from './actions';
import { activeProject, projectSheets, whenMounted } from './project';
import { compileProject } from '../model/compile';
import { symbolsFromSheets } from '../model/makeLib';
import { footprintsFromBoard } from '../model/pcbLib';
import { writeSchLib } from '../formats/altium/schlib';
import { writePcbLib, type FootprintDef } from '../formats/altium/pcblib';
import { packIntLib } from '../formats/altium/intlib';
import { projectFootprints } from './eco';
import { deliverOutputs } from './dialogs/Outputs';
import { active, docs, notify, tick, tileMode, type OpenDoc, type Project } from './state';

const uidOf = (s: string | undefined) => (s ?? '').split('\\').filter(Boolean).at(-1) ?? '';

/** The project's board, opened (without a tab change) if need be. */
export function projectBoard(p: Project): OpenDoc | null {
  const name = p.prj.documents.map(docBaseName).find((n) => /\.pcbdoc$/i.test(n));
  if (!name) return null;
  const od = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
  if (od) return od;
  const f = p.files.get(name.toLowerCase());
  return f ? openDocument(f, p.id, false) : null;
}

/** Every placed part of the project: sheet, object index, designator, unique ID. */
export function schParts(p: Project): { sheet: string; index: number; designator: string; uid: string; comment: string }[] {
  const out: { sheet: string; index: number; designator: string; uid: string; comment: string }[] = [];
  for (const s of projectSheets(p)) {
    for (const o of s.doc.objects) {
      if (o.kind !== 'component') continue;
      const b = s.doc.records[o.index + 1]?.bag;
      const cm = s.doc.objects.find((c) => c.owner === o.index && c.record === SR.PARAMETER && s.doc.records[c.index + 1]?.bag?.get('NAME')?.toLowerCase() === 'comment');
      out.push({ sheet: s.name, index: o.index, designator: o.designator, uid: b?.get('UNIQUEID') ?? '', comment: cm?.kind === 'text' ? cm.text : '' });
    }
  }
  return out;
}

/* ─── Back Annotate Schematics ───────────────────────────────────────────────────────── */

function backAnnotate(): void {
  const p = activeProject();
  if (!p) { notify('Back annotation works on a PCB project', 'error'); return; }
  const board = projectBoard(p);
  if (board?.doc.kind !== 'PcbDoc') { notify(`${p.name} has no PCB document`, 'error'); return; }
  const doc = board.doc as PcbDocument;
  const parts = schParts(p);
  const changes: EcoChange[] = [];
  for (const c of doc.components) {
    const uid = uidOf(c.bag.get('SOURCEUNIQUEID'));
    const s = uid ? parts.find((x) => x.uid === uid) : undefined;
    if (!s || s.designator === c.designator || !c.designator) continue;
    // Every part of the package carries the old designator
    const same = parts.filter((x) => x.designator === s.designator && x.sheet === s.sheet);
    changes.push({
      group: 'Annotate Component', action: 'Modify', object: `${s.designator} -> ${c.designator}`, doc: s.sheet, enabled: true,
      validate: () => null,
      execute: () => {
        const ed = openSheet(s.sheet, p, false)?.editor;
        if (!(ed instanceof SchEditor)) throw new Error(`${s.sheet} isn't loaded`);
        ed.undo.transact('Back annotate', (tx) => {
          for (const x of same) {
            const t = ed.doc.objects.find((o) => o.owner === x.index && o.kind === 'text' && o.role === 'designator');
            if (t) tx.add(setProps(ed.doc, t.index, { TEXT: c.designator }));
          }
        });
        ed.invalidate();
      },
    });
  }
  if (!changes.length) { notify('The sheets already have the board\'s designators'); return; }
  showDialog(EcoDialog, { title: 'Engineering Change Order', changes, transact: (run: () => void) => { run(); tick.value++; } });
}

/* ─── Component Links ────────────────────────────────────────────────────────────────── */

/** Project › Component Links: the project's parts paired with its board's components (the focused project from the Projects panel). */
export function componentLinks(p: Project | null = activeProject()): void {
  if (!p) { notify('Component Links works on a PCB project', 'error'); return; }
  const board = projectBoard(p);
  if (!(board?.editor instanceof PcbEditor) || board.doc.kind !== 'PcbDoc') { notify(`${p.name} has no PCB document`, 'error'); return; }
  const pe = board.editor;
  const doc = board.doc as PcbDocument;
  showDialog(ComponentLinksDialog, {
    sch: schParts(p), pcb: doc.components.map((c) => ({ index: c.index, designator: c.designator, uid: uidOf(c.bag.get('SOURCEUNIQUEID')), pattern: c.pattern })),
    onOk: (links: { pcb: number; uid: string; designator: string }[]) => {
      const ch = links.filter((l) => uidOf(doc.components[l.pcb]?.bag.get('SOURCEUNIQUEID')) !== l.uid);
      if (!ch.length) return;
      pe.undo.transact('Component links', (tx) => {
        for (const l of ch) tx.add(setComponentProps(doc, l.pcb, l.uid ? { SOURCEUNIQUEID: `\\${l.uid}`, SOURCEDESIGNATOR: l.designator } : { SOURCEUNIQUEID: '' }));
      });
      pe.invalidate();
      notify(`${ch.length} component link${ch.length > 1 ? 's' : ''} updated on ${board.name}`);
    },
  });
}

/* ─── Cross Select Mode ──────────────────────────────────────────────────────────────── */

let lastSig = '';
function designatorsSelected(): { from: 'sch' | 'pcb'; des: Set<string>; projectId?: string } | null {
  const d = active.value, e = d?.editor;
  if (e instanceof SchEditor && !e.libraryMode) {
    const des = new Set<string>();
    for (const k of e.selection) { const o = e.doc.objects[parseInt(k.slice(1), 10)]; const c = o?.kind === 'component' ? o : o ? e.doc.objects[o.owner] : undefined; if (c?.kind === 'component' && c.designator) des.add(c.designator); }
    return { from: 'sch', des, projectId: d!.projectId };
  }
  if (e instanceof PcbEditor) {
    const des = new Set<string>();
    for (const k of e.selection) { const pr = e.primByKey(k); const ci = pr && 'component' in pr ? (pr as { component: number }).component : -1; const c = ci >= 0 ? e.doc.components[ci] : undefined; if (c) des.add(c.designator); }
    return { from: 'pcb', des, projectId: d!.projectId };
  }
  return null;
}
function crossSelect(): void {
  if (!settings.crossSelect) return;
  const s = designatorsSelected();
  if (!s) return;
  const sig = `${s.from}|${[...s.des].sort().join(',')}`;
  if (sig === lastSig) return;
  lastSig = sig;
  for (const d of docs.value) {
    if (d === active.value || d.projectId !== s.projectId) continue;
    const e = d.editor;
    if (s.from === 'sch' && e instanceof PcbEditor) {
      const comps = e.doc.components.filter((c) => s.des.has(c.designator));
      e.selection = new Set(comps.flatMap((c) => e.componentKeys(c.index)));
      e.invalidateOverlay();
      crossBehaviour(e, [...e.selection]);
      // Cross Select Mode › Reposition Selected Component In PCB: they hang from the cursor when the board is next shown
      if (settings.pcbCrossSelectReposition) { const q = comps.filter((c) => !c.bag.bool('LOCKED')).map((c) => c.index); if (q.length) reposition.set(e, q); else reposition.delete(e); }
    } else if (s.from === 'pcb' && e instanceof SchEditor && !e.libraryMode) {
      e.selection = new Set(e.doc.objects.filter((o) => o.kind === 'component' && s.des.has(o.designator)).map((o) => `o${o.index}`));
      e.invalidateOverlay();
      crossBehaviour(e, [...e.selection]);
    }
  }
}
/**
 * System › Navigation › Cross Select Mode › Selection Behaviour: what was selected to match is
 * only selected, or also zoomed to (at once where that document is in view: another window, a
 * split pane; else when it is next shown), or the rest masked.
 */
const zoomOnShow = new WeakSet<SchEditor | PcbEditor>();
function crossBehaviour(e: SchEditor | PcbEditor, keys: string[]): void {
  const b = settings.crossSelectBehaviour;
  // Zoom: at once where the document is in view (in a window of its own, or a split pane); else when it is next shown
  if (b === 'Zoom') {
    if (keys.length && e.viewport?.laidOut) { zoomOnShow.delete(e); e.jumpToSelection(e instanceof PcbEditor ? 3_000_000 : 30_000_000); }
    else if (keys.length) zoomOnShow.add(e); else zoomOnShow.delete(e);
  }
  if (b === 'Mask') {
    if (e instanceof PcbEditor) e.setMask(keys.length ? keys : null);
    else e.setMask(keys.length ? keys.map((k) => parseInt(k.slice(1), 10)) : null);
  }
}
effect(() => {
  const e = active.value?.editor;
  if (!(e instanceof SchEditor || e instanceof PcbEditor) || !zoomOnShow.has(e)) return;
  zoomOnShow.delete(e);
  whenMounted(e, () => e.jumpToSelection(e instanceof PcbEditor ? 3_000_000 : 30_000_000));
});
effect(() => { void tick.value; if (settings.crossSelect) queueMicrotask(crossSelect); });
const reposition = new WeakMap<PcbEditor, number[]>();
effect(() => {
  const e = active.value?.editor;
  if (!(e instanceof PcbEditor)) return;
  const q = reposition.get(e);
  if (!q) return;
  reposition.delete(e);
  queueMicrotask(() => e.setTool(new RepositionTool(e, q)));
});

/* ─── Make Integrated Library ────────────────────────────────────────────────────────── */

/**
 * Design › Make Integrated Library: the project's symbols (one per library reference) and the
 * footprints its parts use (from the project's PCB libraries, else from the board) packed into
 * <Project>.IntLib, written to the project outputs.
 */
async function makeIntLib(): Promise<void> {
  const p = activeProject();
  const sheets = projectSheets(p);
  if (!sheets.length) { notify('No schematics to make a library from', 'error'); return; }
  const syms = symbolsFromSheets(sheets);
  const used = new Set(compileProject(sheets).components.map((c) => c.footprint.toLowerCase()).filter(Boolean));
  const defs: FootprintDef[] = [];
  const seen = new Set<string>();
  for (const f of projectFootprints(p)) {
    const k = f.footprint.name.toLowerCase();
    if (!used.has(k) || seen.has(k)) continue;
    seen.add(k);
    defs.push({ name: f.footprint.name, description: f.footprint.description, height: f.footprint.height, records: f.footprint.records });
  }
  const board = p ? projectBoard(p) : null;
  if (board?.doc.kind === 'PcbDoc') for (const d of footprintsFromBoard(board.doc as PcbDocument)) if (used.has(d.name.toLowerCase()) && !seen.has(d.name.toLowerCase())) { seen.add(d.name.toLowerCase()); defs.push(d); }
  const libs: { kind: 'SchLib' | 'PcbLib'; bytes: Uint8Array }[] = [{ kind: 'SchLib', bytes: writeSchLib(syms) }];
  if (defs.length) libs.push({ kind: 'PcbLib', bytes: writePcbLib(defs) });
  const base = (p?.name ?? sheets[0]!.name).replace(/\.[^.]+$/, '');
  const bytes = await packIntLib(libs);
  await deliverOutputs(p, base, 'Integrated Library', [{ name: `${base}.IntLib`, text: '', bytes }]);
  notify(`${base}.IntLib: ${syms.length} component${syms.length === 1 ? '' : 's'}, ${defs.length} footprint${defs.length === 1 ? '' : 's'}`);
}

/* ─── Commands ───────────────────────────────────────────────────────────────────────── */

export function syncCommands(): Command[] {
  const hasProject = () => !!activeProject();
  return [
    { id: 'ad:IntegratedLibrary:CreateLibraryFromProject', label: 'Make Integrated Library', run: () => { void makeIntLib(); }, enabled: () => { const p = activeProject(); return p ? p.prj.documents.some((d) => /\.schdoc$/i.test(d)) : active.value?.doc.kind === 'SchDoc'; } },
    { id: 'ad:WorkspaceManager:ConfigureBackAnnotate', label: 'Back Annotate Schematics...', run: backAnnotate, enabled: hasProject },
    { id: 'ad:WorkspaceManager:ComponentLinking', label: 'Component Links...', run: () => componentLinks(), enabled: hasProject },
    { id: 'ad:WorkspaceManager:ConfigureAnnotatePhysical', label: 'Board Level Annotate...', run: () => {
      const p = activeProject();
      if (p) showDialog(PhysicalAnnotateDialog, { parts: schParts(p) });
    }, enabled: hasProject },
    { id: 'ad:WorkspaceManager:ConfigureSheetNumber', label: 'Annotate Compiled Sheets...', run: () => {
      const p = activeProject();
      if (p) showDialog(NumberSheetsDialog, { project: p });
    }, enabled: hasProject },
    { id: 'ad:WorkspaceManager:DefaultPrints', label: 'Default Prints...', run: () => {
      const p = activeProject();
      const list = p ? p.prj.documents.filter((x) => /\.(schdoc|pcbdoc)$/i.test(x)).map(docBaseName) : active.value ? [active.value.name] : [];
      if (!list.length) { notify('Nothing to print', 'error'); return; }
      showDialog(DefaultPrintsDialog, { project: p, names: list });
    }, enabled: () => hasProject() || !!active.value?.editor },
    // Window › Tile
    ...([['ad:Client:TileAllOpenDocuments', 'Tile', 'grid'], ['ad:Client:TileAllOpenDocumentsHorizontally', 'Tile Horizontally', 'h'], ['ad:Client:TileAllOpenDocumentsVertically', 'Tile Vertically', 'v'],
      ['window.tileAll', 'Tile All', 'grid'], ['window.splitVertical', 'Split Vertical', 'v'], ['window.splitHorizontal', 'Split Horizontal', 'h']] as const).map(([id, label, mode]): Command => ({
      id, label, run: () => { tileMode.value = mode; tick.value++; }, enabled: () => docs.value.filter((d) => d.editor && !d.hidden).length > 1,
    })),
    { id: 'window.mergeAll', label: 'Merge All', run: () => { tileMode.value = null; tick.value++; }, enabled: () => !!tileMode.value },
    { id: 'ad:SCH:ToggleFastCrossSelect', label: 'Cross Select Mode', run: () => {
      updateSettings({ crossSelect: !settings.crossSelect });
      lastSig = '';
      notify(settings.crossSelect ? 'Cross Select Mode on' : 'Cross Select Mode off');
      crossSelect();
    }, checked: () => settings.crossSelect },
  ];
}
