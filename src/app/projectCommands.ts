/**
 * Project and schematic tool commands as Altium Designer 17's menus have them: Project ›
 * Project Options, Add Existing / Remove from Project, Project Documents, Analyze Document,
 * Halt Compilation, Save Project As; Tools › Number Schematic Sheets, Parameter Manager,
 * Footprint Manager, NoERC Manager, Cross Probe, Select PCB Components, Convert › Reset Unique IDs,
 * Round Coordinates; Reports › Single Pin Nets, Component Cross Reference; Edit › Change;
 * Window › Next / Previous Tab, Hide All, More Windows.
 */
import type { Command, Scope } from '../core/commands';
import { PickTool } from '../editors/Editor';
import { SchEditor } from '../editors/sch/SchEditor';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { addDocument, docBaseName, removeDocument } from '../formats/altium/prjpcb';
import type { PropertyBag } from '../formats/altium/props';
import type { SheetInput } from '../model/compile';
import { crossReferenceReport, roundBag, singlePinNetsReport } from '../model/schReports';
import { SR } from '../model/sch';
import { replaceBags, uniqueId } from '../model/schEdit';
import { openFiles, pickFile } from '../platform/fs';
import { readSchDoc } from '../formats/altium/schdoc';
import { cmdShowDifferences } from './differences';
import { symbolFromPorts, symbolsFromSheets } from '../model/makeLib';
import { partToPortsChanges, partToSheetSymbolChanges, pushPartToSheet } from '../model/convertPart';
import { addRecords } from '../model/schEdit';
import { writeSchLib } from '../formats/altium/schlib';
import { applyTemplateChanges, removeTemplateChanges, templateOf } from '../model/schTemplate';
import type { SchDocument } from '../model/sch';
import { addSheet, cmdClose, cmdSaveProject, cycleTab, editObject, openDocument, projectFolder } from './actions';
import { showDialog } from './dialogs';
import { ConfirmDialog } from './dialogs/Confirm';
import { ChooseSheetDialog, ReportDialog } from './dialogs/Hierarchy';
import { openSheet, sheetPorts } from './hierarchy';
import { FootprintManagerDialog, MoreWindowsDialog, NoErcManagerDialog, NumberSheetsDialog, ParameterManagerDialog, ProjectDocumentsDialog } from './dialogs/ProjectDialogs';
import { ProjectOptionsDialog } from './dialogs/ProjectOptions';
import { SmartPasteDialog } from './dialogs/SmartPaste';
import { SchPasteTool } from '../editors/sch/SchPasteTool';
import { PageSetupDialog, PrintPreviewDialog, SmartPdfDialog, openDocsOf } from './dialogs/Print';
import { printDocs } from './print';
import { editInPlace } from './inPlace';
import { AvailableLibrariesDialog } from './dialogs/AvailableLibraries';
import { focusLibrarySearch } from './panels/Libraries';
import { showPanel } from './dock/store';
import { clipboard } from '../editors/clipboard';
import { activeProject, cmdCompile, compileOptions, crossProbe, projectSheets, whenMounted } from './project';
import { active, activeId, docs, markProjectDirty, notify, projects, tick, type OpenDoc, type Project, currentProject, currentProjectId } from './state';
import { focusedDocument, focusedProject, hideDocs, visibleDocs } from './workspace';
import { newSheet } from './newSheet';

const SCH: Scope[] = ['sch'];
const sheet = () => { const e = active.value?.editor; return e instanceof SchEditor && !e.libraryMode ? e : null; };
const project = () => focusedProject();

/** The sheets a project tool works on: the project's, or the active free sheet. */
const sheetsFor = (p: Project | null): SheetInput[] => projectSheets(p);

/* ─── Project ────────────────────────────────────────────────────────────────────────── */

async function addExisting(p: Project | null): Promise<void> {
  if (!p) { notify('Open a project first', 'error'); return; }
  const files = await openFiles();
  let n = 0;
  // A file inside the project's folder is listed by its path from the project file
  const folder = p.dir ? await projectFolder(p).catch(() => null) : null;
  for (const f of files) {
    // A project goes into another only as a multi-board project's child (a .PrjPcb in a .PrjMbd)
    if (/\.libpkg$/i.test(f.name) || /\.prj[a-z]+$/i.test(f.name) && !(/\.prjpcb$/i.test(f.name) && /\.prjmbd$/i.test(p.name))) continue;
    const at = folder && f.handle ? await folder.resolve(f.handle).catch(() => null) : null;
    const path = at?.join('/') ?? f.name;
    if (!addDocument(p.prj, path)) { notify(`${f.name} is already in ${p.name}`); continue; }
    p.files.set(f.name.toLowerCase(), { ...f, path });
    n++;
  }
  if (!n) return;
  markProjectDirty(p);
  // A document already open as a free document joins the project
  for (const d of docs.value) if (!d.projectId && files.some((f) => f.name.toLowerCase() === d.name.toLowerCase())) d.projectId = p.id;
  docs.value = [...docs.value];
  notify(`Added ${n} document${n > 1 ? 's' : ''} to ${p.name}`);
}

function removeFromProject(od: OpenDoc | null, p: Project | null): void {
  if (!p) return;
  const name = od?.name;
  const path = name ? p.prj.documents.find((d) => docBaseName(d).toLowerCase() === name.toLowerCase()) : undefined;
  if (!path || !name) { notify('Choose a document of the project to remove', 'error'); return; }
  showDialog(ConfirmDialog, {
    title: 'Confirm', message: `Remove ${name} from ${p.name}?`, detail: 'The file itself is kept; an open document stays open as a free document.',
    onYes: () => {
      removeDocument(p.prj, path);
      p.files.delete(name.toLowerCase());
      for (const d of docs.value) if (d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase()) d.projectId = undefined;
      docs.value = [...docs.value];
      markProjectDirty(p);
      notify(`Removed ${name} from ${p.name}`);
    },
  });
}

function roundCoordinates(ed: SchEditor): void {
  const doc = ed.doc;
  const pick = ed.selection.size ? new Set([...ed.selection].map((k) => parseInt(k.slice(1), 10))) : null;
  const entries: { index: number; before: PropertyBag; after: PropertyBag }[] = [];
  for (const o of doc.objects) {
    if (pick && !pick.has(o.index) && !(o.owner >= 0 && pick.has(o.owner))) continue;
    const bag = doc.records[o.index + 1]?.bag;
    if (!bag || o.record === SR.SHEET) continue;
    const after = roundBag(bag);
    if (after) entries.push({ index: o.index, before: bag.clone(), after });
  }
  if (!entries.length) { notify('Every coordinate is already on the 10 mil grid'); return; }
  ed.undo.transact('Round coordinates', (tx) => tx.add(replaceBags(doc, entries)));
  ed.invalidate();
  notify(`Rounded the coordinates of ${entries.length} object${entries.length > 1 ? 's' : ''}`);
}

function resetUniqueIds(p: Project | null): void {
  const sheets = sheetsFor(p);
  if (!sheets.length) return;
  showDialog(ConfirmDialog, {
    title: 'Reset Component Unique IDs', message: `Give every part in ${p?.name ?? sheets[0]!.name} a new Unique ID?`,
    detail: 'Parts lose their link to PCB components until the PCB is updated (Design › Update PCB matches them by designator).',
    onYes: () => {
      let n = 0;
      for (const s of sheets) {
        const od = p ? docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === s.name.toLowerCase()) ?? openDocument(p.files.get(s.name.toLowerCase())!, p.id, false)
          : docs.value.find((d) => d.doc === s.doc);
        const ed = od?.editor;
        if (!(ed instanceof SchEditor)) continue;
        const entries = ed.doc.objects.filter((o) => o.kind === 'component').map((o) => {
          const before = ed.doc.records[o.index + 1]!.bag!;
          const after = before.clone();
          after.set('UNIQUEID', uniqueId());
          return { index: o.index, before: before.clone(), after };
        });
        if (!entries.length) continue;
        ed.undo.transact('Reset component unique IDs', (tx) => tx.add(replaceBags(ed.doc, entries)));
        n += entries.length;
      }
      notify(`New Unique IDs for ${n} part${n === 1 ? '' : 's'}`);
    },
  });
}

/* ─── Cross probing between schematic and PCB ────────────────────────────────────────── */

function boardOf(p: Project | null): OpenDoc | undefined {
  const pcb = docs.value.find((d) => d.editor instanceof PcbEditor && (p ? d.projectId === p.id : !d.projectId));
  if (pcb || !p) return pcb;
  const path = p.prj.documents.find((d) => /\.pcbdoc$/i.test(d));
  const f = path ? p.files.get(docBaseName(path).toLowerCase()) : undefined;
  return f ? openDocument(f, p.id, false) ?? undefined : undefined;
}

/** Select (and optionally jump to) the board's components for these designators. */
function selectOnBoard(designators: string[], p: Project | null, jump: boolean): boolean {
  const od = boardOf(p);
  const pe = od?.editor;
  if (!(pe instanceof PcbEditor)) { notify('No PCB in the project to cross probe to', 'error'); return false; }
  const want = new Set(designators.map((d) => d.toUpperCase()));
  const keys = pe.doc.components.filter((c) => want.has(c.designator.toUpperCase())).flatMap((c) => pe.componentKeys(c.index));
  if (!keys.length) { notify(`${designators.join(', ')} not found on ${od!.name}`, 'error'); return false; }
  pe.selection = new Set(keys);
  pe.invalidateOverlay();
  if (jump) { activeId.value = od!.id; setTimeout(() => pe.fitSelection(30_000_000), 30); }
  tick.value++;
  return true;
}

function designatorsOf(ed: SchEditor, keys: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    const o = ed.doc.objects[parseInt(k.slice(1), 10)];
    const c = o?.kind === 'component' ? o : o && o.owner >= 0 ? ed.doc.objects[o.owner] : undefined;
    if (c?.kind === 'component' && c.designator) out.add(c.designator);
  }
  return [...out];
}

/** The document a print command acts on: the active one, or the Projects panel's right-clicked one (opened if need be). */
function printable(focused = false, open = true): OpenDoc | null {
  if (focused) {
    const f = focusedDocument();
    if (f) {
      const od = docs.value.find((d) => d.name.toLowerCase() === f.name.toLowerCase() && (d.projectId ?? null) === (f.project?.id ?? null));
      if (od?.editor) return od;
      const pf = f.project?.files.get(f.name.toLowerCase());
      if (!open) return pf && /\.(schdoc|pcbdoc|schlib|pcblib)$/i.test(f.name) ? ({ name: f.name } as OpenDoc) : null;
      return pf ? openDocument(pf, f.project!.id, false) : null;
    }
  }
  const d = active.value;
  return d?.editor ? d : null;
}

/** The part a Convert command acts on: right-clicked (context), else the one selected. */
function partFor(e: SchEditor, ctx: boolean): number | null {
  const keys = ctx ? [e.hits(e.cursor)[0]?.key].filter((k): k is string => !!k) : [...e.selection];
  for (const k of keys) {
    const o = e.doc.objects[parseInt(k.slice(1), 10)];
    const c = o?.kind === 'component' ? o : o && o.owner >= 0 ? e.doc.objects[o.owner] : undefined;
    if (c?.kind === 'component') return c.index;
  }
  return null;
}

/** The parts a right-click acts on: the one under the cursor, with the selection when it is selected. */
function contextParts(e: SchEditor): string[] {
  const under = e.hits(e.cursor)[0]?.key;
  const under0 = under ? designatorsOf(e, [under]) : [];
  if (!under0.length) return [];
  return e.selection.has(under!) ? designatorsOf(e, e.selection) : under0;
}

/* ─── Commands ───────────────────────────────────────────────────────────────────────── */

export function projectCommands(): Command[] {
  const withProject = (fn: (p: Project) => void) => () => { const p = project(); if (p) fn(p); else notify('Open a project first', 'error'); };
  return [
    { id: 'ad:WorkspaceManager:ConfigureOptions', label: 'Project Options...', run: withProject((p) => showDialog(ProjectOptionsDialog, { project: p })), enabled: () => !!project() },
    { id: 'ad:WorkspaceManager:ConfigureOptionsFocused', label: 'Project Options...', run: withProject((p) => showDialog(ProjectOptionsDialog, { project: p })), enabled: () => !!project() },
    { id: 'ad:WorkspaceManager:AddToFocusedProject', label: 'Add Existing to Project...', run: () => addExisting(project()), enabled: () => !!project() },
    // Make Active Project: the focused project, which new documents go into
    // Show Differences: the comparator, each difference sent the way you choose
    { id: 'ad:WorkspaceManager:ShowDifferences', label: 'Show Differences...', run: () => cmdShowDifferences(project()), enabled: () => !!project() },
    { id: 'ad:WorkspaceManager:SetCurrentProject', label: 'Make Active Project', run: withProject((p) => { currentProjectId.value = p.id; }), enabled: () => !!project() },
    { id: 'ad:WorkspaceManager:SaveFocusedProjectAs', label: 'Save Project As...', run: withProject((p) => void cmdSaveProject(p, true)), enabled: () => !!project() },
    { id: 'ad:WorkspaceManager:RemoveFocusedDocument', label: 'Remove from Project...', run: () => {
      const f = focusedDocument();
      if (!f?.project) { removeFromProject(active.value, activeProject()); return; }
      removeFromProject(docs.value.find((d) => d.projectId === f.project!.id && d.name.toLowerCase() === f.name.toLowerCase()) ?? ({ name: f.name } as OpenDoc), f.project);
    }, enabled: () => !!focusedDocument()?.project || !!active.value?.projectId },
    { id: 'ad:WorkspaceManager:AddFreeDocumentToFocusedProject', label: 'Add Document to Project...', run: () => {
      const f = focusedDocument();
      const od = f ? docs.value.find((d) => !d.projectId && d.name.toLowerCase() === f.name.toLowerCase()) : undefined;
      const p = currentProject() ?? projects.value[0];
      if (!od || !p) { notify('Right-click a free document with a project open', 'error'); return; }
      addDocument(p.prj, od.name);
      p.files.set(od.name.toLowerCase(), { name: od.name, bytes: od.bytes });
      od.projectId = p.id;
      docs.value = [...docs.value];
      markProjectDirty(p);
      notify(`Added ${od.name} to ${p.name}`);
    }, enabled: () => { const f = focusedDocument(); return !!f && !f.project && projects.value.length > 0; } },
    { id: 'ad:WorkspaceManager:CompileFocusedDocument', label: 'Analyse Document', run: () => {
      const f = focusedDocument();
      const od = f ? docs.value.find((d) => d.name.toLowerCase() === f.name.toLowerCase() && (d.projectId ?? null) === (f.project?.id ?? null)) : active.value;
      if (od?.doc.kind === 'SchDoc') cmdCompile(f?.project ?? null, [{ name: od.name, doc: od.doc as never }]);
      else notify('Open the schematic to analyse it', 'error');
    }, enabled: () => /\.schdoc$/i.test(focusedDocument()?.name ?? active.value?.name ?? '') },
    { id: 'ad:WorkspaceManager:AddToProject', label: 'Add Existing to Project...', run: () => addExisting(project()), enabled: () => !!project() },
    { id: 'ad:WorkspaceManager:RemoveDocument', label: 'Remove from Project...', run: () => removeFromProject(active.value, activeProject()), enabled: () => !!active.value?.projectId },
    { id: 'ad:WorkspaceManager:OpenProjectDocuments', label: 'Project Documents...', run: withProject((p) => showDialog(ProjectDocumentsDialog, { project: p })), enabled: () => !!project() },
    { id: 'ad:WorkspaceManager:CloseAllDocumentsInProject', label: 'Close Project Documents', run: withProject((p) => {
      void (async () => { for (const d of docs.value.filter((x) => x.projectId === p.id)) if (!(await cmdClose(d))) break; })();
    }), enabled: () => !!project() && docs.value.some((d) => d.projectId === project()?.id) },
    { id: 'ad:WorkspaceManager:CompileAbortProject', label: 'Halt Compilation', run: () => notify('No compilation is running'), enabled: () => false },
    { id: 'ad:WorkspaceManager:CompileDocument', label: 'Analyse Document', caption: () => (active.value ? `Analyse Document ${active.value.name}` : undefined),
      run: () => { const e = sheet(); if (e) cmdCompile(activeProject(), [{ name: active.value!.name, doc: e.doc }]); }, enabled: () => !!sheet() },
    { id: 'ad:WorkspaceManager:SaveProjectAs', label: 'Save Project As...', run: withProject((p) => void cmdSaveProject(p, true)), enabled: () => !!project() },
    { id: 'wm.saveProjectFile', label: 'Save Project', run: withProject((p) => void cmdSaveProject(p)), enabled: () => !!project()?.dirty },

    // Tools
    { id: 'ad:Sch:ProjectSystemParametersManagement', label: 'Number Schematic Sheets...', scopes: SCH, run: withProject((p) => showDialog(NumberSheetsDialog, { project: p })), enabled: () => !!project() },
    { id: 'ad:WorkspaceManager:ParameterManagement', label: 'Parameter Manager...', run: () => {
      const p = project(), s = sheetsFor(p);
      if (!s.length) { notify('No schematics to edit', 'error'); return; }
      showDialog(ParameterManagerDialog, { project: p, sheets: s });
    }, enabled: () => !!project() || !!sheet() },
    { id: 'ad:WorkspaceManager:PCBLIBImplementationManagement', label: 'Footprint Manager...', run: () => {
      const p = project(), s = sheetsFor(p);
      if (!s.length) { notify('No schematics to edit', 'error'); return; }
      showDialog(FootprintManagerDialog, { project: p, sheets: s });
    }, enabled: () => !!project() || !!sheet() },
    { id: 'ad:WorkspaceManager:ConfigureNoERCManager', label: 'NoERC Manager...', run: () => showDialog(NoErcManagerDialog, { project: project(), sheets: sheetsFor(project()) }), enabled: () => !!project() || !!sheet() },
    { id: 'ad:PLResetAllUniqueIds', label: 'Reset Component Unique IDs...', run: () => resetUniqueIds(project()), enabled: () => !!project() || !!sheet() },
    { id: 'ad:Sch:RoundCoords', label: 'Round coordinates of objects...', scopes: SCH, run: () => { const e = sheet(); if (e) roundCoordinates(e); }, enabled: () => !!sheet() },
    { id: 'tools.crossProbe', label: 'Cross Probe', scopes: ['sch', 'pcb'], run: () => {
      const pe = active.value?.editor;
      if (pe instanceof PcbEditor) {
        // From the board: the part on its schematic sheet
        pe.setTool(new PickTool(pe, 'Cross Probe: click a component to find it on the schematic', (pt) => {
          const ci = pe.componentAt(pt.raw);
          const des = ci === null ? '' : pe.doc.components[ci]?.designator ?? '';
          if (!des) return false;
          const p = activeProject();
          for (const s of projectSheets(p)) {
            const o = s.doc.objects.find((x) => x.kind === 'component' && x.designator.toUpperCase() === des.toUpperCase());
            if (o) { crossProbe([{ sheet: s.name, index: o.index }], p); return true; }
          }
          notify(`${des} isn't on any schematic of the project`, 'error');
          return true;
        }));
        return;
      }
      const e = sheet();
      if (!e) return;
      e.setTool(new PickTool(e, 'Cross Probe: click a part to find it on the PCB', (pt) => {
        const k = e.hits(pt.raw)[0]?.key;
        const des = k ? designatorsOf(e, [k]) : [];
        if (!des.length) return false;
        selectOnBoard(des, activeProject(), true);
        return true;
      }));
    }, enabled: () => !!sheet() || active.value?.editor instanceof PcbEditor },
    { id: 'ad:SCH:CrossSelect', label: 'Select PCB Components', scopes: SCH, run: () => {
      const e = sheet();
      if (!e) return;
      const des = designatorsOf(e, e.selection);
      if (!des.length) { notify('Select parts first', 'error'); return; }
      if (selectOnBoard(des, activeProject(), false)) notify(`Selected ${des.length} component${des.length > 1 ? 's' : ''} on the PCB`);
    }, enabled: () => !!sheet()?.selection.size },
    { id: 'ad:SCH:CrossSelectWithContext', label: 'Select PCB Components', scopes: SCH, run: () => {
      const e = sheet();
      if (e) { const des = contextParts(e); if (des.length) selectOnBoard(des, activeProject(), false); }
    }, enabled: () => { const e = sheet(); return !!e && contextParts(e).length > 0; } },

    // Design › Make Schematic Library: every library reference in the project into <Project>.SchLib
    { id: 'ad:Sch:CreateLibraryFromProject', label: 'Make Schematic Library', scopes: SCH, run: () => {
      const p = activeProject(), s = sheetsFor(p);
      const syms = symbolsFromSheets(s);
      if (!syms.length) { notify('No parts to put in a library', 'error'); return; }
      const name = `${(p?.name ?? s[0]!.name).replace(/\.[^.]+$/, '')}.SchLib`;
      const bytes = writeSchLib(syms);
      if (p) {
        addDocument(p.prj, name);
        p.files.set(name.toLowerCase(), { name, bytes });
        markProjectDirty(p);
      }
      openDocument({ name, bytes }, p?.id);
      notify(`${name}: ${syms.length} component${syms.length > 1 ? 's' : ''}`);
    }, enabled: () => !!sheet() },
    // Design › Convert › Part To Ports / Part To Sheet Symbol (the selected part, or the one right-clicked)
    ...([['ad:Sch:ChangeComponentToPorts', 'Convert Part To Ports', partToPortsChanges], ['ad:Sch:ChangeComponentToSheetSymbol', 'Convert Part To Sheet Symbol', partToSheetSymbolChanges]] as const)
      .flatMap(([id, label, make]): Command[] => [false, true].map((ctx) => ({
        id: ctx ? `${id}WithContext` : id, label, scopes: SCH,
        enabled: () => { const e = sheet(); return !!e && partFor(e, ctx) !== null; },
        run: () => {
          const e = sheet();
          const ci = e ? partFor(e, ctx) : null;
          if (!e || ci === null) { notify('Select a part first', 'error'); return; }
          const ch = make(e.doc, ci);
          if (!ch.length) { notify('The part has no pins to convert', 'error'); return; }
          e.selection.clear();
          e.undo.transact(label, (tx) => { for (const c of ch) tx.add(c); });
          e.invalidate();
        },
      }))),
    // Design › Refactor › Push Part to Sheet
    ...(['ad:Sch:PushComponentToSheet', 'ad:Sch:PushComponentToSheetWithContext'] as const).map((id, ctx): Command => ({
      id, label: 'Push Part to Sheet', scopes: SCH, enabled: () => { const e = sheet(); return !!e && partFor(e, !!ctx) !== null; }, run: () => {
        const e = sheet();
        const ci = e ? partFor(e, !!ctx) : null;
        if (!e || ci === null) { notify('Select a part first', 'error'); return; }
        const comp = e.doc.objects[ci] as { designator?: string; libRef?: string };
        const p = activeProject();
        const taken = new Set([...docs.value.map((d) => d.name.toLowerCase()), ...(p ? [...p.files.keys()] : [])]);
        let name = `${(comp.designator || comp.libRef || 'Part').replace(/[\\/:*?"<>|]/g, '_')}.SchDoc`;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = name.replace(/(_\d+)?\.SchDoc$/i, `_${n}.SchDoc`);
        const r = pushPartToSheet(e.doc, ci, name);
        if (!r) return;
        const child = newSheet(name);
        addRecords(child, r.child).apply();
        e.selection.clear();
        e.undo.transact('Push part to sheet', (tx) => { for (const c of r.here) tx.add(c); });
        e.invalidate();
        addSheet(child, p, false);
        notify(`${comp.designator ?? 'The part'} moved to ${name}`);
      },
    })),
    // Design › Create Component From Sheet: a symbol with a pin per port, into a new library
    ...(['ad:Sch:CreateSchematicComponentFromSheet', 'ad:Sch:CreateSchematicComponentFromSheetWithContext'] as const).map((id): Command => ({
      id, label: 'Create Component From Sheet', scopes: SCH, enabled: () => !!sheet(), run: () => {
        const e = sheet(), od = active.value;
        if (!e || !od) return;
        const ports = sheetPorts(e.doc);
        if (!ports.length) { notify('The sheet has no ports to make pins from', 'error'); return; }
        const sym = symbolFromPorts(od.name, ports);
        const p = activeProject();
        const name = `${sym.libRef}.SchLib`;
        const bytes = writeSchLib([sym]);
        if (p) { addDocument(p.prj, name); p.files.set(name.toLowerCase(), { name, bytes }); markProjectDirty(p); }
        openDocument({ name, bytes }, p?.id);
        notify(`${sym.libRef}: ${ports.length} pin${ports.length > 1 ? 's' : ''}`);
      },
    })),
    // Design › Add/Remove Library, Tools › Find Component
    { id: 'ad:Sch:AddRemoveLibraryInSchEditor', label: 'Add/Remove Library...', run: () => showDialog(AvailableLibrariesDialog, {}) },
    { id: 'ad:Sch:FindLibraryComponent', label: 'Find Component...', run: () => { showPanel('libraries'); focusLibrarySearch(); } },
    // Design › Templates
    { id: 'ad:Sch:RemoveTemplate', label: 'Remove Current Template...', scopes: SCH, run: () => {
      const e = sheet();
      if (!e) return;
      const t = templateOf(e.doc);
      if (!t) { notify('This sheet has no template'); return; }
      showDialog(ConfirmDialog, { title: 'Remove Template', message: `Remove the template ${e.doc.records[t.index + 1]?.bag?.get('FILENAME') ?? ''} from ${active.value?.name}?`, onYes: () => {
        e.undo.transact('Remove template', (tx) => { for (const c of removeTemplateChanges(e.doc)) tx.add(c); });
        e.invalidate();
      } });
    }, enabled: () => !!sheet() && !!templateOf(sheet()!.doc) },
    ...(['ad:Sch:SetTemplateFromGeneral', 'ad:Sch:SetTemplateFromProject', 'ad:Sch:SetTemplateFromConfig', 'ad:Sch:UpdateCurrentTemplate'] as const).map((id): Command => ({
      id, label: id.endsWith('UpdateCurrentTemplate') ? 'Update Current Template...' : 'Choose a File...', scopes: SCH, enabled: () => !!sheet(), run: async () => {
        const e = sheet();
        if (!e) return;
        const f = await pickFile('.SchDot,.SchDoc');
        if (!f) return;
        let tpl: SchDocument;
        try { tpl = readSchDoc(f.bytes, f.name); } catch (err) { notify(`${f.name}: ${(err as Error).message}`, 'error'); return; }
        e.undo.transact(`Apply template ${f.name}`, (tx) => { for (const c of applyTemplateChanges(e.doc, tpl, f.name)) tx.add(c); });
        e.invalidate();
        notify(`Template ${f.name} applied`);
      },
    })),
    // Design › Refactor › Move Selected Subcircuit to Different Sheet: cut here, paste there
    ...(['ad:Sch:RefactorSubcircuit', 'ad:Sch:RefactorSubcircuitWithContext'] as const).map((id): Command => ({
      id, label: 'Move Selected Subcircuit to Different Sheet', scopes: SCH, enabled: () => !!sheet()?.selection.size, run: () => {
        const e = sheet(), od = active.value;
        if (!e || !od || !e.selection.size) return;
        const p = activeProject();
        const names = sheetsFor(p).map((s) => s.name).filter((n) => n.toLowerCase() !== od.name.toLowerCase());
        if (!names.length) { notify('The project has no other sheet to move to', 'error'); return; }
        showDialog(ChooseSheetDialog, { sheets: names, onOk: (name: string) => {
          if (!e.copy()) return;
          e.deleteSelection();
          e.invalidate();
          const to = openSheet(name, p, true);
          const te = to?.editor;
          // Placed once, designators kept (a move, not a copy)
          const clip = clipboard;
          if (te instanceof SchEditor && clip?.kind === 'sch') whenMounted(te, () => te.setTool(new SchPasteTool(te, clip, false, { id: 'move-subcircuit', what: 'the subcircuit', once: true })));
        } });
      },
    })),
    // Edit › Smart Paste
    { id: 'ad:Sch:PasteSpecial', label: 'Smart Paste...', scopes: SCH, run: () => {
      const e = sheet();
      if (!e) return;
      if (clipboard?.kind !== 'sch' || !clipboard.items.length) { notify('The clipboard holds no schematic objects', 'error'); return; }
      showDialog(SmartPasteDialog, { ed: e, clip: clipboard });
    }, enabled: () => !!sheet() && clipboard?.kind === 'sch' },
    { id: 'ad:Sch:ChangeObjectGraphicallyOrSetFocusZoomFocused', label: 'Edit In-Place', scopes: ['sch', 'schlib'], run: () => {
      const e = active.value?.editor instanceof SchEditor ? active.value.editor : null;
      if (!e) return;
      const under = e.hits(e.cursor)[0]?.key;
      const key = e.selection.size === 1 ? [...e.selection][0] : under;
      if (key && !e.selection.has(key)) e.select([key]);
      editInPlace(e, key);
    }, enabled: () => active.value?.editor instanceof SchEditor },
    // Edit › Change: click objects one after another to edit them
    { id: 'ad:Sch:ChangeObject', label: 'Change', scopes: SCH, run: () => {
      const e = sheet();
      if (!e) return;
      e.setTool(new PickTool(e, 'Change: click the object to edit; right-click to finish', (pt) => {
        const k = e.hits(pt.raw)[0]?.key;
        if (!k) return false;
        e.select([k]);
        editObject(e, k);
        return false;
      }, true));
    }, enabled: () => !!sheet() },

    // Reports
    { id: 'reports.singlePinNets', label: 'Report Single Pin Nets', run: () => {
      const p = activeProject() ?? project(), s = sheetsFor(p);
      if (!s.length) { notify('Nothing to report: open a schematic or a project with schematics', 'error'); return; }
      showDialog(ReportDialog, { title: 'Single Pin Nets', name: `${(p?.name ?? s[0]!.name).replace(/\.[^.]+$/, '')}.REP`, text: singlePinNetsReport(p?.name ?? s[0]!.name, s, compileOptions(p)), project: p });
    } },
    { id: 'reports.crossRef', label: 'Component Cross Reference', run: () => {
      const p = activeProject() ?? project(), s = sheetsFor(p);
      if (!s.length) { notify('Nothing to report: open a schematic or a project with schematics', 'error'); return; }
      showDialog(ReportDialog, { title: 'Component Cross Reference', name: `${(p?.name ?? s[0]!.name).replace(/\.[^.]+$/, '')}.CrossRef.txt`, text: crossReferenceReport(p?.name ?? s[0]!.name, s, compileOptions(p)), project: p });
    } },

    // File › Page Setup, Print Preview, Print, Smart PDF (the active document; the Projects panel's right-clicked one)
    { id: 'ad:WorkspaceManager:PageSetup', label: 'Page Setup...', run: () => { const d = printable(); if (d) showDialog(PageSetupDialog, { docs: [d] }); }, enabled: () => !!printable() },
    { id: 'ad:WorkspaceManager:PrintPreview', label: 'Print Preview...', run: () => { const d = printable(); if (d) showDialog(PrintPreviewDialog, { docs: [d] }); }, enabled: () => !!printable() },
    { id: 'ad:WorkspaceManager:Print', label: 'Print...', run: () => { const d = printable(); if (d) printDocs([d]); }, enabled: () => !!printable() },
    { id: 'ad:WorkspaceManager:PrintNoDialog', label: 'Print', run: () => { const d = printable(); if (d) printDocs([d]); }, enabled: () => !!printable() },
    { id: 'ad:WorkspaceManager:PageSetupFocused', label: 'Page Setup...', run: () => { const d = printable(true); if (d) showDialog(PageSetupDialog, { docs: [d] }); }, enabled: () => !!printable(true, false) },
    { id: 'ad:WorkspaceManager:PrintPreviewFocused', label: 'Print Preview...', run: () => { const d = printable(true); if (d) showDialog(PrintPreviewDialog, { docs: [d] }); }, enabled: () => !!printable(true, false) },
    { id: 'ad:WorkspaceManager:PrintFocused', label: 'Print...', run: () => { const d = printable(true); if (d) printDocs([d]); }, enabled: () => !!printable(true, false) },
    { id: 'ad:WorkspaceManager:ExportToPDF', label: 'Smart PDF...', run: () => showDialog(SmartPdfDialog, { current: printable(), project: openDocsOf(active.value?.projectId) }), enabled: () => !!printable() },
    // Window
    { id: 'ad:Client:RunDesignExplorerSysCommandNextTab', label: 'Next Tab', run: () => cycleTab(1), enabled: () => visibleDocs().length > 1 },
    { id: 'ad:Client:RunDesignExplorerSysCommandPreviousTab', label: 'Previous Tab', run: () => cycleTab(-1), enabled: () => visibleDocs().length > 1 },
    { id: 'ad:WorkspaceManager:HideAll', label: 'Hide All', run: () => hideDocs(visibleDocs()), enabled: () => visibleDocs().length > 0 },
    { id: 'ad:Client:ViewMoreWindows', label: 'More Windows...', run: () => showDialog(MoreWindowsDialog, {}), enabled: () => docs.value.length > 0 },
  ];
}

