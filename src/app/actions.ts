import { load, save, canSave } from '../formats/registry';
import { selectionPopup } from './SelectionPopup';
import { boardOpened, embedUsedFonts } from './boardOpened';
import { rememberedDocs } from './sessionMemory';
import { withTemplate } from './dataManagement';
import { writeSchAscii, writeSchDoc } from '../formats/altium/schdoc';
import { readPrjPcb, writePrjPcb, docBaseName, addDocument, newPrjPcb, newLibPkg, renameDocument, PROJECT_FILE as ANY_PROJECT } from '../formats/altium/prjpcb';
import { FEATURES, featureOn, type Feature } from '../core/release';
import { readDsnWrk, resolvePath } from '../model/designWorkspace';
import { dbSource } from '../formats/altium/dblib';
import { bytesToBin } from '../formats/text';
import { newPcbDocBytes } from '../formats/altium/newBoard';
import { SchLibEditor } from '../editors/sch/SchLibEditor';
import { SchEditor } from '../editors/sch/SchEditor';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { BendingLineDialog, BoardRegionDialog } from './dialogs/RigidFlex';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { CamEditor } from '../editors/cam/CamEditor';
import { camPrefs } from './camPrefs';
import { isCamFile, openCamFiles } from './camCommands';
import { markPcbLibSaved, newPcbLib, writePcbLibDoc } from '../model/pcbLib';
import { newSchLib, writeSchLibDoc } from '../model/schLib';
import type { Editor } from '../editors/Editor';
import { demoFiles } from '../formats/synthetic/demo';
import { SIM_DEMO, simDemoFiles } from '../formats/synthetic/simDemo';
import { unzipEntries } from '../formats/xlsxRead';
import { importerFor, type Importer } from '../formats/importers';
import { olderFile } from '../formats/protel/older';
import { importAndOpen } from './importFiles';
import { ImportWizardDialog } from './dialogs/ImportWizard';
import { importSessionInto } from './specctraSession';
import {
  collectFromDirectory, ensurePermission, fileFromHandle, hasFile, hasFolderAccess, hasFsAccess, openFiles, pickFolderFallback, pickProjectFile,
  requestProjectFolder, saveFile, saveFileAs, writeHandle, writeInto, downloadInstead, writeFallbacks, WriteFallbackError, type PickedFile,
} from '../platform/fs';
import { knownFolderOf, listRecent, rememberProject, type RecentProject, listRecentDocuments, rememberDocument, type RecentDocument } from '../platform/recent';
import { findLinkedModel } from '../platform/modelFolders';
import { sheetViolations } from './compiled';
import { activeId, currentProjectId, docs, isDocDirty, log, markProjectDirty, notify, projectAccess, projects, recentDocuments, recentProjects, tick, units, workspace, cursorTick, type OpenDoc, type Project } from './state';
import { contextMenu, router } from './commands';
import { dropCopiesOf, keepPrevious, refOf } from './backup';
import { showPanel } from './dock/store';
import { settings, settingsChanged } from '../core/settings';
import { RoomDialog } from './dialogs/RoomDialog';
import { showDialog } from './dialogs';
import { ConfirmDialog, InfoDialog, SaveChangesDialog } from './dialogs/Confirm';
import { noteSave } from './diagnostics';
import { SaveAsDialog } from './dialogs/SaveAs';
import { PolygonDialog } from './dialogs/Polygon';
import { SchObjectDialog } from './dialogs/SchObjectProps';
import { DirectiveDialog } from './dialogs/Directive';
import { SchComponentDialog, editPlacingPart } from './dialogs/SchComponent';
import { SR, type SchDocument } from '../model/sch';
import type { PropertyBag } from '../formats/altium/props';
import { editInPlace } from './inPlace';
import { DimensionDialog } from './dialogs/Dimension';
import { PcbComponentDialog } from './dialogs/PcbComponentDialog';
import { PadDialog } from './dialogs/PadDialog';
import { primDialog } from './dialogs/PrimDialogs';
import { isDeviceSheet } from './deviceSheets';
import { newSheet } from './newSheet';

/**
 * Double-click (or right-click › Properties): the object's properties dialog, as Altium's —
 * a part opens "Properties for Schematic Component", anything else its own dialog; a pour opens
 * the Polygon Pour dialog. Other board objects show in the PCB Inspector for now.
 */
export function editObject(e: Editor, key: string): void {
  if (e instanceof PcbEditor && key.startsWith('poly:')) {
    const i = Number(key.slice(5)), poly = e.doc.polygons[i];
    if (!poly) return;
    e.select([key]);
    showDialog(PolygonDialog, { doc: e.doc, units: units.value, bag: poly.bag, title: `Polygon Pour [${poly.name}]`, onOk: (b: PropertyBag) => e.updatePolygon(i, b) });
    return;
  }
  // Board Planning Mode: a region, a bending line (a split line has no properties)
  if (e instanceof PcbEditor && key.startsWith('region:')) {
    e.select([key]);
    showDialog(BoardRegionDialog, { ed: e, index: Number(key.slice(7)) });
    return;
  }
  if (e instanceof PcbEditor && key.startsWith('bend:')) {
    const [r, j] = key.slice(5).split(':').map(Number);
    e.select([key]);
    showDialog(BendingLineDialog, { ed: e, region: r!, index: j! });
    return;
  }
  if (e instanceof PcbEditor && key.startsWith('split:')) { e.select([key]); return; }
  if (e instanceof PcbEditor && key.startsWith('room:')) {
    const i = Number(key.slice(5));
    if (!e.doc.rules[i]) return;
    e.select([key]);
    showDialog(RoomDialog, { ed: e, rule: i });
    return;
  }
  if (e instanceof PcbEditor && key.startsWith('dim:')) {
    const i = Number(key.slice(4));
    if (!e.doc.dimensions[i]) return;
    e.select([key]);
    showDialog(DimensionDialog, { ed: e, index: i });
    return;
  }
  if (e instanceof SchEditor) {
    const i = parseInt(key.slice(1), 10), o = e.doc.objects[i];
    if (!o) return;
    if (!e.selection.has(key)) e.select([key]);
    const docName = docs.value.find((d) => d.editor === e)?.name ?? e.doc.name;
    // Preferences › Double Click Runs Inspector
    if (settings.schDoubleClickInspector && !e.libraryMode) { showPanel('inspector'); return; }
    if (o.kind === 'component') showDialog(SchComponentDialog, { ed: e, index: i, docName });
    else if (o.kind === 'directive') showDialog(DirectiveDialog, { ed: e, index: i });
    else showDialog(SchObjectDialog, { ed: e, index: i });
    return;
  }
  // A board object: AD17's dialog for it. A component's primitives open the Component dialog
  // while it locks them (Lock Primitives, the default); its designator and comment their own
  if (e instanceof PcbEditor) {
    // Preferences › PCB Editor › Double Click Runs Inspector
    if (settings.pcbDoubleClickInspector) { if (!e.selection.has(key)) e.select(e.keysFor(key)); showPanel('inspector'); return; }
    const p = e.primByKey(key);
    const comp = p && 'component' in p && p.component !== 0xffff ? e.doc.components[p.component] : undefined;
    const ownText = p?.kind === 'text' && (p.isDesignator || p.isComment);
    // (a pad chosen on its own, from the popup of overlapping objects or with Components off in the Selection Filter, opens as a pad)
    const alone = !!comp && p?.kind === 'pad' && e.selection.has(key) && !e.componentKeys(comp.index).every((k) => e.selection.has(k));
    if (comp && !ownText && !alone && (comp.bag.has('PRIMITIVELOCK') ? comp.bag.bool('PRIMITIVELOCK') : true)) {
      e.select(e.keysFor(key));
      showDialog(PcbComponentDialog, { ed: e, index: comp.index });
      return;
    }
    const dialog = p?.kind === 'pad' ? PadDialog : p ? primDialog(p) : null;
    if (p && dialog) { e.select([key]); showDialog(dialog as never, { ed: e, prim: p }); return; }
  }
  if (!e.selection.has(key)) e.select(e instanceof PcbEditor ? e.keysFor(key) : [key]);
  showPanel('inspector');
}

/** Right-click › Properties (and Enter on a selection): the first selected object's properties. */
export function openSelectionProperties(): void {
  const e = docs.value.find((d) => d.id === activeId.value)?.editor;
  const key = e ? [...e.selection][0] : undefined;
  if (e && key) editObject(e, key);
}

let seq = 0;
export const nextId = (p: string) => `${p}${++seq}`;

function makeEditor(od: OpenDoc): Editor | null {
  const d = od.doc;
  let ed: Editor | null = null;
  if (d.kind === 'SchDoc') ed = new SchEditor(d);
  else if (d.kind === 'PcbDoc') { const pe = new PcbEditor(d); pe.units = () => units.value; ed = pe; }
  else if (d.kind === 'PcbLib') { const le = new PcbLibEditor(d); le.units = () => units.value; ed = le; }
  else if (d.kind === 'CamDoc') {
    const ce = new CamEditor(d);
    ce.units = () => units.value;
    // File › Setup › General: how the editor draws at first
    const p = camPrefs();
    Object.assign(ce.view, { fill: p.fill, translucent: p.translucent, origin: p.showOrigin });
    ed = ce;
  }
  // Linked STEP models: looked for in the project's folder, then Preferences › PCB Editor › Models
  if (ed instanceof PcbEditor) ed.findModel = (path) => findLinkedModel(path, projects.value.find((p) => p.id === od.projectId)?.dir);
  else if (d.kind === 'SchLib') ed = new SchLibEditor(d);
  if (ed) {
    ed.changed.on(() => { tick.value++; });
    // The cursor moving only redraws what shows it (the status bar), not the whole window
    ed.moved.on(() => { cursorTick.value++; });
    const e = ed;
    // Altium's right-click menu: the object menu over an object, the free-space menu elsewhere
    e.contextMenu = (p) => { router.cancelChain(); router.openChain(contextMenu(e.scope, e.hits(p.raw).length > 0), e.scope); };
    e.editObject = (key) => editObject(e, key);
    // Tab while placing: the object's properties dialog (a part's comes with Place › Part's own dialog)
    if (e instanceof SchEditor) e.placeProps = (bag, apply, hide) => { if (bag.int('RECORD', -1) !== SR.COMPONENT) showDialog(SchObjectDialog, { ed: e, template: { bag, onOk: apply }, hide }); };
    if (e instanceof SchEditor) e.placePartProps = (items, apply) => editPlacingPart(e, items, apply);
    if (e instanceof SchEditor) {
      // Ctrl+double-click a sheet symbol, sheet entry or port: down or up the hierarchy (lazily, the module needs this one)
      e.ctrlDoubleClick = (p) => {
        void import('./hierarchy').then((h) => { if (!h.hierarchyJump(e, p.raw)) { const hit = e.hits(p.raw)[0]; if (hit) e.editObject?.(hit.key, p); } });
        return true;
      };
      e.inPlaceEdit = (key) => { editInPlace(e, key); };
      e.notice = (m) => notify(m);
      e.violations = () => sheetViolations(e.doc.name, e.undo.editedAt);
      // Preferences › Undo/Redo; Device Sheets › Make Device Sheets Read-Only
      const undoPrefs = () => { e.undo.limit = settings.schUndoStack; e.undo.groupWindow = settings.schGroupUndo ? 600 : 0; };
      undoPrefs();
      od.dispose = settingsChanged.on(undoPrefs);
      e.undo.guard = () => (settings.schDeviceReadOnly && isDeviceSheet(od.name) ? `${od.name} is a device sheet (read-only: Preferences › Schematic › Device Sheets)` : null);
      e.undo.onRefused = (why) => notify(why, 'error');
    }
    // Special strings: =DocumentName, =DocumentFullPathAndName, =ProjectName and the project's parameters
    if (e instanceof SchEditor) e.specials = () => {
      const p = od.projectId ? projects.value.find((x) => x.id === od.projectId) : undefined;
      const rel = (od.path ?? od.name).replace(/\//g, '\\');
      return { docName: od.name, path: p?.folder ? `${p.folder}\\${rel}` : rel, projectName: p?.name, projectParams: p?.prj.parameters };
    };
    if (e instanceof PcbEditor) {
      e.status = (m) => notify(m);
      // Display popup selection dialog: the overlapping objects to choose from, at the click
      e.choose = (items, at) => { selectionPopup.value = { items, x: at.x, y: at.y }; };
      // Preferences › PCB Editor › General › Undo/Redo
      const undoPrefs = () => { e.undo.limit = settings.pcbUndoStack; };
      undoPrefs();
      const off = settingsChanged.on(undoPrefs), was = od.dispose;
      od.dispose = () => { off(); was?.(); };
    }
    e.confirm = (message, onYes) => showDialog(ConfirmDialog, { message, onYes });
  }
  return ed;
}


const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean => !!a && a.length === b.length && a.every((v, i) => v === b[i]);

/** Load one document into a tab (or focus it if already open). */
export function openDocument(f: PickedFile, projectId?: string, focus = true): OpenDoc | null {
  const existing = docs.value.find((d) => d.name.toLowerCase() === f.name.toLowerCase() && d.projectId === projectId);
  if (existing) { if (focus) activeId.value = existing.id; return existing; }
  try {
    const doc = load(f.bytes, f.name);
    if (doc.kind === 'PrjPcb') return null;
    // An STL opens as a new STEP model (never saved over the STL)
    const stl = doc.kind === 'StepDoc' && /\.stl$/i.test(f.name);
    const od: OpenDoc = { id: nextId('d'), name: stl ? doc.name : f.name, doc, editor: null, handle: stl ? undefined : f.handle, projectId, path: stl ? undefined : f.path, bytes: f.bytes };
    od.editor = makeEditor(od);
    docs.value = [...docs.value, od];
    if (focus) activeId.value = od.id;
    // A board's embedded fonts; the File Format Change Report for one from another version of the format
    if (doc.kind === 'PcbDoc') boardOpened(od.name, doc);
    // Opened from disk on its own: File › Recent Documents and the Home page keep it
    if (focus && od.handle && !projectId) void rememberDocument(od.handle).then(refreshRecent);
    // The library panel comes up once a double-click in the Projects tree has finished there
    if ((doc.kind === 'PcbLib' || doc.kind === 'SchLib') && focus) setTimeout(() => { if (activeId.value === od.id) showPanel('library'); }, 350);
    if ('diags' in doc) log(f.name, doc.diags.items);
    if (doc.kind === 'Inspect') log(f.name, [{ level: 'info', message: `${doc.detected} opened for inspection only — editing comes later` }]);
    return od;
  } catch (e) {
    log(f.name, [{ level: 'error', message: (e as Error).message }]);
    notify(`Couldn't open ${f.name}: ${(e as Error).message}`, 'error');
    return null;
  }
}

/**
 * Open a batch: projects (.PrjPcb, .LibPkg) become tree entries; other files open as tabs —
 * unless `projectsOnly` (a project chosen from a folder: the folder's other files stay closed).
 * A workspace file on its own asks for its folder, where its projects are.
 */
const KICAD_SIDE = /^(sym-lib-table|fp-lib-table|fp-info-cache)$|\.(kicad_prl|kicad_dru|kicad_wks|lck)$/i;
const CADENCE_SIDE = /\.(dra|pad|psm|fsm|bsm|osm|ssm|mdd|jrl|log|opj|obk|dbk)$/i;
const EAGLE_SIDE = /\.([sbl]#\d+|epf|dru|cam|ulp|scr|erc|drc|bak)$/i;
/** What the desktop software writes beside a project for its own use (its structure, previews): not documents. Picked with their project they are left closed. */
const ALTIUM_SIDE = /\.(prjpcbstructure|schdocpreview|pcbdocpreview|schlibpreview|pcblibpreview)$/i;

/**
 * Picked files with their ZIP archives opened up: an archive is what a project is sent as, so each is taken as the
 * files in it (their paths kept, so that a project finds its documents). An archive that is another tool's project
 * (the importers know theirs) is left whole, and so is one inside an archive (a project's History).
 */
export async function unpacked(files: PickedFile[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const f of files) {
    const zip = /\.zip$/i.test(f.name) && f.bytes.length > 22 && f.bytes[0] === 0x50 && f.bytes[1] === 0x4b && !importerFor(f.name, f.bytes);
    if (!zip) { out.push(f); continue; }
    try {
      const entries = unzipEntries(f.bytes).filter((e) => !e.name.endsWith('/') && !/\.zip$/i.test(e.name) && !/(^|\/)(__MACOSX|History|__Previews)\//i.test(e.name)).slice(0, 2000);
      if (!entries.length) { notify(`${f.name} has no files in it to open`, 'error'); continue; }
      for (const e of entries) out.push({ name: e.name.split('/').pop()!, bytes: await e.data(), path: `${f.name}/${e.name}` });
    } catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); }
  }
  return out;
}
/** A project kind of a feature not released yet (multi-board, harness). */
const plannedProject = (name: string): Feature | null => (/\.prjmbd$/i.test(name) && !featureOn('multiboard') ? 'multiboard' : /\.prjhar$/i.test(name) && !featureOn('harness') ? 'harness' : null);
/** Project files Konium opens (those of features not released yet aside). */
const PROJECT_FILE = { test: (name: string) => ANY_PROJECT.test(name) && !plannedProject(name) };

export function openBatch(files: PickedFile[], folder?: string, dir?: FileSystemDirectoryHandle, projectsOnly = false): void {
  // Projects of features not released yet: said so, and left closed
  const later = files.filter((f) => plannedProject(f.name));
  if (later.length) {
    notify(`${[...new Set(later.map((f) => FEATURES[plannedProject(f.name)!].name))].join(' and ')} ${later.length === 1 ? 'is a planned feature' : 'are planned features'}: ${later.map((f) => f.name).join(', ')} not opened`);
    files = files.filter((f) => !later.includes(f));
  }
  // An autorouter's Specctra session: onto the board in front (Route › Auto Route › Import Specctra Session...)
  const sessions = files.filter((f) => /\.ses$/i.test(f.name));
  if (sessions.length) {
    const ed = docs.value.find((d) => d.id === activeId.value)?.editor;
    if (ed instanceof PcbEditor && !(ed instanceof PcbLibEditor)) for (const f of sessions) importSessionInto(ed, f.name, f.bytes);
    else notify('A Specctra session goes onto its board: bring the board to the front, then open the .ses again', 'error');
    files = files.filter((f) => !sessions.includes(f));
  }
  // A Specctra design (Konium's own, for an autorouter): what comes back is its session
  const designs = files.filter((f) => /\.dsn$/i.test(f.name) && /^\s*\(\s*pcb\b/i.test(new TextDecoder().decode(f.bytes.subarray(0, 200))));
  if (designs.length) {
    notify(`${designs.map((f) => f.name).join(', ')}: a Specctra design, for an autorouter. Its routes come back with the router's session (.ses): Route › Auto Route › Import Specctra Session...`);
    files = files.filter((f) => !designs.includes(f));
  }
  // Boards, schematics and design databases of the 1990s in formats not read here: each said for what it is, with the way in
  const olds = files.flatMap((f) => { const o = olderFile(f.name, f.bytes); return o ? [{ f, o }] : []; });
  if (olds.length) {
    for (const { f, o } of olds) notify(`${f.name}: a ${o.what}, which is not read here. ${o.way}.`, 'error', 9000);
    files = files.filter((f) => !olds.some((x) => x.f === f));
  }
  // Other tools' files are imported (as File › Import Wizard does), the rest opened
  const byImporter = new Map<Importer, PickedFile[]>();
  for (const f of files) { const im = importerFor(f.name, f.bytes); if (im) byImporter.set(im, [...(byImporter.get(im) ?? []), f]); }
  for (const [im, list] of byImporter) {
    // A KiCad project file alone (browsers hand over only what was picked): the wizard, to add its folder
    const lone = im.list(list.map((f) => ({ path: f.path ?? f.name, bytes: f.bytes }))).some((i) => i.note);
    if (lone) showDialog(ImportWizardDialog, { files: list, type: im.id });
    else void importAndOpen(im, list).catch((e: Error) => notify(`Import failed: ${e.message}`, 'error'));
  }
  if (byImporter.size) { const taken = new Set([...byImporter.values()].flat()); files = files.filter((f) => !taken.has(f)); }
  // The imported tools' own side files in a dropped folder (library tables, local settings, Allegro's symbols and journals, EAGLE's backups and rules): not documents
  const ids = new Set([...byImporter.keys()].map((i) => i.id));
  if (ids.has('kicad')) files = files.filter((f) => !KICAD_SIDE.test(f.name));
  if (ids.has('orcad') || ids.has('allegro')) files = files.filter((f) => !CADENCE_SIDE.test(f.name));
  if (ids.has('eagle')) files = files.filter((f) => !EAGLE_SIDE.test(f.name));
  // Gerber and NC drill files: a CAM document of them (as AD opens fabrication files in CAMtastic), in front once the rest are open
  const cams = projectsOnly ? [] : files.filter((f) => !PROJECT_FILE.test(f.name) && isCamFile(f));
  if (cams.length) files = files.filter((f) => !cams.includes(f));
  // Beside a project, what the desktop software keeps there for itself is not opened (a newer version's .PrjPcbStructure
  // came up in front as a document that could only be inspected, with the project's own documents behind it)
  if (files.some((f) => PROJECT_FILE.test(f.name))) files = files.filter((f) => !ALTIUM_SIDE.test(f.name));
  // A multi-board project last, so it is the one in front with its schematic
  const prjs = files.filter((f) => PROJECT_FILE.test(f.name)).sort((a, b) => Number(/\.prjmbd$/i.test(a.name)) - Number(/\.prjmbd$/i.test(b.name)));
  const byPath = new Map(files.filter((f) => f.path).map((f) => [f.path!.toLowerCase(), f]));
  const byName = new Map<string, PickedFile>();
  for (const f of files) if (!f.path || !byName.has(f.name.toLowerCase())) byName.set(f.name.toLowerCase(), f);
  const claimed = new Set<PickedFile>();
  for (const pf of prjs) {
    try {
      const prj = readPrjPcb(pf.bytes, pf.name);
      const p: Project = { id: nextId('p'), name: pf.name, prj, handle: pf.handle, files: new Map(), folder, dir, path: pf.path };
      // A document is the file at its path from the project file (files picked one by one: by name)
      const at = (pf.path ?? '').split('/').slice(0, -1).join('/');
      for (const path of prj.documents) {
        const k = docBaseName(path).toLowerCase();
        const full = pf.path !== undefined ? resolvePath(at, path) : null;
        const f = full !== null ? byPath.get(full.toLowerCase()) ?? (byPath.size ? undefined : byName.get(k)) : byName.get(k);
        if (f) { p.files.set(k, f); claimed.add(f); }
      }
      // The databases its links and database libraries name: kept with the project (read from there), not opened
      for (const f of [...p.files.values()]) {
        if (!/\.(dblink|(svn)?dblib)$/i.test(f.name)) continue;
        try {
          const d = load(f.bytes, f.name);
          const src = d.kind === 'DbLink' ? d.source : d.kind === 'DbLib' ? dbSource(d.links).file : '';
          if (!src) continue;
          const full = f.path !== undefined ? resolvePath(f.path.split('/').slice(0, -1).join('/'), src) : null;
          const db = (full !== null ? byPath.get(full.toLowerCase()) : undefined) ?? byName.get(docBaseName(src).toLowerCase());
          if (db) { p.files.set(db.name.toLowerCase(), db); claimed.add(db); }
        } catch { /* not readable: left as it is */ }
      }
      projects.value = [...projects.value, p];
      currentProjectId.value = p.id;
      const missing = prj.documents.filter((d) => !p.files.has(docBaseName(d).toLowerCase()));
      if (missing.length) {
        log(pf.name, [{ level: 'warn', message: `${missing.length} project document${missing.length > 1 ? 's' : ''} not loaded: ${missing.slice(0, 4).map(docBaseName).join(', ')}` }]);
        // Only the project file arrived (Open…, drop, OS launch): offer to load the rest from its folder
        if (missing.length === prj.documents.length && !projectAccess.value) projectAccess.value = { name: pf.name, handle: pf.handle, file: pf, missing: missing.length };
      }
      // Open documents per Preferences › Files (default: first schematic and the board)
      const avail = prj.documents.map((d) => p.files.get(docBaseName(d).toLowerCase())).filter((f): f is PickedFile => !!f);
      const editable = avail.filter((f) => /\.(schdoc|pcbdoc|mbsdoc|wirdoc|ldrdoc)$/i.test(f.name));
      // System › View › Restore open documents: those it had open when it was last closed
      const before = settings.restoreOpenDocs ? rememberedDocs(p) : [];
      const restored = before.map((n) => avail.find((f) => f.name.toLowerCase() === n)).filter((f): f is PickedFile => !!f);
      const toOpen = restored.length ? restored
        : settings.openProjectDocs === 'none' ? []
        // Every document of the project (a multi-board project's child projects open as projects of their own)
        : settings.openProjectDocs === 'all' ? avail.filter((f) => !PROJECT_FILE.test(f.name))
        : [editable.find((f) => /\.(schdoc|mbsdoc|wirdoc)$/i.test(f.name)), editable.find((f) => /\.pcbdoc$/i.test(f.name))].filter((f): f is PickedFile => !!f);
      for (const f of toOpen) openDocument(f, p.id, false);
      const focus = docs.value.find((d) => d.projectId === p.id);
      if (focus) activeId.value = focus.id;
    } catch (e) {
      log(pf.name, [{ level: 'error', message: (e as Error).message }]);
    }
  }
  for (const f of files) {
    if (PROJECT_FILE.test(f.name) || claimed.has(f)) continue;
    if (/\.dsnwrk$/i.test(f.name)) {
      if (prjs.length) workspace.value = { name: f.name, handle: f.handle };
      else if (!projectAccess.value) projectAccess.value = { name: f.name, handle: f.handle, file: f, missing: readDsnWrk(bytesToBin(f.bytes)).length };
      continue;
    }
    if (projectsOnly) continue;
    // Another file with the name of a document that is open (two revisions' Board.PcbDoc): the open one is not this file,
    // and bringing it forward without a word would pass it off as the one asked for
    const open = docs.value.find((d) => !d.projectId && d.name.toLowerCase() === f.name.toLowerCase());
    if (open && f.bytes.length && !sameBytes(open.bytes, f.bytes)) {
      activeId.value = open.id;
      notify(`${f.name} was not opened: another document of that name is open, and that is the one shown. Close it first to open this file.`, 'error');
      continue;
    }
    openDocument(f);
  }
  if (cams.length) openCamFiles(cams);
}

export function openProjectDocument(p: Project, path: string): void {
  // A multi-board project's child project: that project, brought forward
  if (PROJECT_FILE.test(path)) {
    const child = projects.value.find((x) => x.name.toLowerCase() === docBaseName(path).toLowerCase());
    if (!child) { notify(`${docBaseName(path)} isn't open — open the folder that holds it and the multi-board project`, 'error'); return; }
    currentProjectId.value = child.id;
    const d = docs.value.find((x) => x.projectId === child.id && !x.hidden);
    if (d) activeId.value = d.id;
    return;
  }
  const f = p.files.get(docBaseName(path).toLowerCase());
  if (!f) { notify(`${docBaseName(path)} wasn't included — open the project folder instead`, 'error'); return; }
  openDocument(f, p.id);
}

/** Files already open in a tab (the same file, by its handle) are brought forward instead of opened twice. */
async function notOpenYet(files: PickedFile[]): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const f of files) {
    let hit: OpenDoc | undefined;
    if (f.handle) for (const d of docs.value) if (d.handle && (await d.handle.isSameEntry(f.handle).catch(() => false))) { hit = d; break; }
    if (hit) activeId.value = hit.id; else out.push(f);
  }
  return out;
}

export async function cmdOpen(): Promise<void> { openBatch(await notOpenYet(await unpacked(await openFiles()))); }

/**
 * File › Open Project. Pick the .PrjPcb; the browser then needs one confirmation of the
 * project's folder (it starts there) before the documents can be read.
 */
export async function cmdOpenProject(): Promise<void> {
  if (!hasFsAccess()) {
    notify('Choose the project folder: this browser can only read a project through its folder');
    const files = await pickFolderFallback();
    if (files.length) openBatch(files);
    return;
  }
  const picked = await pickProjectFile();
  if (!picked) return;
  await loadProjectFolder({ name: picked.file.name, handle: picked.handle, file: picked.file, missing: 0 }, true);
}

/**
 * Ask for the folder of a picked/dropped project file and open it. Falls back to the dialog. A
 * project in a folder Konium already knows (Recent projects) opens from there without asking.
 */
export async function loadProjectFolder(p: { name: string; handle?: FileSystemFileHandle; file: PickedFile; missing: number }, immediate = false): Promise<void> {
  if (p.handle) {
    const known = await knownFolderOf(p.handle);
    try {
      if (known && (await ensurePermission(known.dir)) && (await openProjectFolder(known.dir, p.name, known.path))) { projectAccess.value = null; return; }
    } catch { /* the browser wants a fresh click: ask for the folder as before */ }
  }
  let dir: FileSystemDirectoryHandle | null;
  try {
    dir = await requestProjectFolder(p.handle);
  } catch {
    // The browser wants a fresh click before another picker; explain and offer a button
    if (immediate) { projectAccess.value = p; return; }
    throw new Error('the browser blocked the folder picker');
  }
  if (!dir) { projectAccess.value = p; return; }
  // The very file that was picked, by its place in the folder
  const at = p.handle ? await dir.resolve(p.handle).catch(() => null) : undefined;
  const ok = at !== null && (await openProjectFolder(dir, p.name, at?.join('/')));
  projectAccess.value = ok ? null : { ...p, error: `${p.name} isn't in “${dir.name}”. Choose the folder that contains it.` };
}

/**
 * The projects a workspace file lists, found among a folder's files (paths relative to the
 * workspace file's own folder); the ones that aren't there are reported.
 */
function workspaceProjects(w: PickedFile, files: PickedFile[]): PickedFile[] {
  const at = (w.path ?? w.name).split('/').slice(0, -1).join('/');
  const out: PickedFile[] = [], missing: string[] = [];
  for (const rel of readDsnWrk(bytesToBin(w.bytes))) {
    const path = resolvePath(at, rel)?.toLowerCase();
    const f = path === undefined ? undefined : files.find((x) => (x.path ?? x.name).toLowerCase() === path && PROJECT_FILE.test(x.name));
    if (f) { if (!out.includes(f)) out.push(f); } else missing.push(rel);
  }
  if (missing.length) log(w.name, [{ level: 'warn', message: `${missing.length} project${missing.length > 1 ? 's' : ''} of the workspace not found in the folder: ${missing.slice(0, 4).join(', ')}` }]);
  workspace.value = { name: w.name, handle: w.handle };
  return out;
}

/** Open a project (or every project, or a workspace's) found in a folder. */
export async function openProjectFolder(dir: FileSystemDirectoryHandle, prjName?: string, prjPath?: string): Promise<boolean> {
  const files = await collectFromDirectory(dir);
  const prjs = files.filter((f) => PROJECT_FILE.test(f.name));
  const depth = (f: PickedFile) => (f.path ?? '').split('/').length;
  const wrks = files.filter((f) => /\.dsnwrk$/i.test(f.name)).sort((a, b) => depth(a) - depth(b));
  const exact = prjPath ? files.filter((f) => (f.path ?? f.name).toLowerCase() === prjPath.toLowerCase()) : [];
  const named = prjName ? files.filter((f) => f.name.toLowerCase() === prjName.toLowerCase()).sort((a, b) => depth(a) - depth(b)).slice(0, 1) : [];
  const wrk = [...exact, ...named].find((f) => /\.dsnwrk$/i.test(f.name)) ?? (!prjName && !prjPath && wrks.length === 1 ? wrks[0] : undefined);
  const picked = wrk ? workspaceProjects(wrk, files) : exact.length ? exact : prjName ? named : prjs;
  // A multi-board project brings its child projects (its documents that are projects)
  const chosen = [...picked];
  for (const mb of picked.filter((f) => /\.prjmbd$/i.test(f.name))) {
    const at = (mb.path ?? mb.name).split('/').slice(0, -1).join('/');
    for (const rel of readPrjPcb(mb.bytes, mb.name).documents.filter((d) => PROJECT_FILE.test(d))) {
      const full = resolvePath(at, rel)?.toLowerCase();
      const f = files.find((x) => (x.path ?? x.name).toLowerCase() === full) ?? files.find((x) => x.name.toLowerCase() === docBaseName(rel).toLowerCase() && PROJECT_FILE.test(x.name));
      if (f && !chosen.includes(f)) chosen.push(f);
    }
  }
  if (prjName && !chosen.length && !wrk) return false;
  if (!chosen.length) { if (!wrk) openBatch(files); return true; }
  // The same project already open (same folder and file) is brought forward, not opened twice;
  // a copy opened as a lone file (no folder) gives way to this one
  const fresh: PickedFile[] = [];
  for (const c of chosen) {
    const ex = projects.value.find((p) => p.name.toLowerCase() === c.name.toLowerCase());
    if (ex?.dir && (ex.path ?? ex.name).toLowerCase() === (c.path ?? c.name).toLowerCase() && (await ex.dir.isSameEntry(dir).catch(() => false))) {
      currentProjectId.value = ex.id;
      const d = docs.value.find((x) => x.projectId === ex.id && !x.hidden);
      if (d) activeId.value = d.id;
      continue;
    }
    if (ex && !ex.dir && !ex.dirty && !docs.value.some((x) => x.projectId === ex.id)) projects.value = projects.value.filter((p) => p !== ex);
    fresh.push(c);
  }
  if (!fresh.length) return true;
  openBatch([...fresh, ...files.filter((f) => !PROJECT_FILE.test(f.name) && !/\.dsnwrk$/i.test(f.name))], dir.name, dir, true);
  for (const c of fresh) await rememberProject(dir, c.path ?? c.name);
  await refreshRecent();
  return true;
}

export async function reopenRecent(r: RecentProject): Promise<void> {
  try {
    if (!(await ensurePermission(r.dir))) { notify(`Access to “${r.folder}” wasn't granted`, 'error'); return; }
    if (!(await openProjectFolder(r.dir, r.name, r.prjPath))) notify(`${r.name} is no longer in “${r.folder}”`, 'error');
  } catch (e) {
    notify(`Couldn't reopen ${r.name}: ${(e as Error).message}`, 'error');
  }
}

export async function refreshRecent(): Promise<void> {
  recentProjects.value = await listRecent();
  recentDocuments.value = await listRecentDocuments();
}

/** File › Recent Documents, the Home page: reopen a document from its kept handle. */
export async function reopenRecentDocument(r: RecentDocument): Promise<void> {
  try {
    if (!(await ensurePermission(r.handle))) { notify(`Access to “${r.name}” wasn't granted`, 'error'); return; }
    openBatch(await notOpenYet([await fileFromHandle(r.handle)]));
  } catch (e) {
    notify(`Couldn't reopen ${r.name}: ${(e as Error).message}`, 'error');
  }
}

/** Dropped items: a folder opens its project(s); a lone .PrjPcb asks for its folder. */
export async function openDropped(handles: FileSystemHandle[], fallback: () => Promise<PickedFile[]>): Promise<void> {
  const dirs = handles.filter((h): h is FileSystemDirectoryHandle => h.kind === 'directory');
  for (const d of dirs) await openProjectFolder(d);
  const files = handles.filter((h): h is FileSystemFileHandle => h.kind === 'file');
  if (dirs.length && !files.length) return;
  const picked = await unpacked(files.length ? await Promise.all(files.map(fileFromHandle)) : await fallback());
  openBatch(await notOpenYet(picked));
}
export function cmdOpenDemo(): void {
  const existing = projects.value.find((p) => p.name === 'Demo.PrjPcb');
  if (existing) { const d = docs.value.find((x) => x.projectId === existing.id); if (d) { activeId.value = d.id; return; } }
  openBatch(demoFiles());
}

/** The simulation demo: a common-emitter amplifier ready for Design › Simulate › Mixed Sim. */
export function cmdOpenSimDemo(): void {
  const existing = projects.value.find((p) => p.name === SIM_DEMO.project);
  const sheet = () => docs.value.find((x) => x.name === SIM_DEMO.sheet && x.projectId === projects.value.find((p) => p.name === SIM_DEMO.project)?.id);
  if (existing) { const d = sheet(); if (d) { activeId.value = d.id; return; } }
  openBatch(simDemoFiles());
  const d = sheet();
  if (d) activeId.value = d.id;
}

/** A document's bytes in the format Save As chose: a schematic or a board in AD's ASCII format, or binary. */
function saveAs(od: OpenDoc): Uint8Array {
  const d = od.doc;
  if (od.format === 'ascii' && d.kind === 'SchDoc' && d.asciiEol === null) return writeSchAscii(d).bytes;
  if (od.format && d.kind === 'PcbDoc') d.ascii = od.format === 'ascii';
  return save(d);
}

/** File › Save As: a schematic's or a board's type first (binary or ASCII), then where. */
export function cmdSaveAsTyped(od: OpenDoc | null): void {
  if (!od) return;
  if (od.doc.kind !== 'SchDoc' && od.doc.kind !== 'PcbDoc') { void cmdSave(od, true); return; }
  showDialog(SaveAsDialog, { od, onSave: (format) => { void cmdSave(od, true, format); } });
}

/**
 * Save a document (Save As: under a name chosen, and for a schematic or a board in the type
 * chosen). True when it was written. The type chosen becomes the document's only when the file
 * was written: a Save As that is cancelled or fails leaves the document as it was, so the next
 * plain Save writes its own file in its own format.
 */
export async function cmdSave(od: OpenDoc | null, as = false, format?: OpenDoc['format']): Promise<boolean> {
  if (!od || !format) return saveNow(od, as);
  const was = od.format, ascii = od.doc.kind === 'PcbDoc' ? od.doc.ascii : undefined;
  const back = () => { od.format = was; if (od.doc.kind === 'PcbDoc') od.doc.ascii = ascii as typeof od.doc.ascii; };
  od.format = format;
  let ok = false;
  try { ok = await saveNow(od, as); } finally { if (!ok) back(); }
  return ok;
}

async function saveNow(od: OpenDoc | null, as: boolean): Promise<boolean> {
  if (!od) return false;
  if (!canSave(od.doc)) { notify(`Saving ${od.name} isn't supported yet`, 'error'); return false; }
  try {
    // Preferences › PCB Editor › True Type Fonts › Embed: the fonts its strings use go in the board first
    if (od.doc.kind === 'PcbDoc' && !od.doc.ascii && settings.pcbEmbedFonts) {
      const r = await embedUsedFonts(od.doc);
      if (r.added.length) notify(`Embedded in ${od.name}: ${r.added.join(', ')}`);
      if (r.missing.length) notify(`Not embedded (${r.missing.join(', ')}): allow Konium Designer to read this computer's fonts in Preferences › PCB Editor › True Type Fonts`, 'error');
    }
    const bytes = od.editor ? od.editor.withToolSuspended(() => saveAs(od)) : saveAs(od);
    // What is written is the document as it is now: edits made while the file is written stay unsaved
    const at = od.editor?.undo.checkpoint();
    const p = od.projectId ? projects.value.find((x) => x.id === od.projectId) : undefined;
    // Its entry in the project file: by path from the project folder
    const prjPath = p?.prj.documents.find((d) => docBaseName(d).toLowerCase() === od.name.toLowerCase());
    let h: FileSystemFileHandle | undefined | null;
    // Local History: the file this save replaces is kept first
    if (!as && (od.handle || (p?.dir && od.path))) await keepPrevious(refOf(od), od.bytes);
    const fellBack = writeFallbacks();
    if (!as && od.handle) h = await saveFile(od.name, bytes, od.handle);
    else if (p?.dir && (await ensurePermission(p.dir))) {
      // A project's document: into the project's folder (beside the .PrjPcb), as AD's Save As starts there
      const folder = await projectFolder(p);
      // (a folder that can't be written: the document is downloaded and stays unsaved)
      h = !as && !(await hasFile(folder, od.name)) ? await writeInto(folder, od.name, bytes).catch((e) => { throw downloadInstead(od.name, bytes, e, false, true); }) : await saveFileAs(od.name, bytes, folder);
      if (h) {
        const rel = (await folder.resolve(h).catch(() => null))?.join('/');
        if (h.name !== od.name || (rel && prjPath && rel.toLowerCase() !== prjPath.toLowerCase())) {
          if (prjPath) renameDocument(p.prj, prjPath, rel ?? h.name); else addDocument(p.prj, rel ?? h.name);
          p.files.delete(od.name.toLowerCase()); markProjectDirty(p); od.name = h.name;
        }
        od.path = (await p.dir.resolve(h).catch(() => null))?.join('/') ?? h.name;
        if (!rel) notify(`${od.name} was saved outside the project's folder`, 'error');
      }
    } else h = await saveFileAs(od.name, bytes);
    if (h === null) return false;
    if (h) {
      od.handle = h;
      if (h.name && h.name !== od.name) od.name = h.name;
      if (!p) void rememberDocument(h).then(refreshRecent);
    }
    // The project's copy of the file follows (compile of closed sheets, reopening, packaging)
    if (p) p.files.set(od.name.toLowerCase(), { name: od.name, bytes, handle: h ?? od.handle, path: od.path });
    if (od.doc.kind === 'PcbLib') markPcbLibSaved(od.doc, bytes);
    if (at !== undefined) od.editor!.undo.markSavedAt(at); else od.editor?.undo.markSaved();
    if (od.doc.kind === 'OutJob') { od.doc.dirty = false; od.doc.original = bytes; tick.value++; }
    if (od.doc.kind === 'BomDoc' || od.doc.kind === 'DbLink' || od.doc.kind === 'DbLib' || od.doc.kind === 'SimText' || od.doc.kind === 'SimData' || od.doc.kind === 'CamDoc' || od.doc.kind === 'Draftsman' || od.doc.kind === 'MbsDoc' || od.doc.kind === 'MbaDoc' || od.doc.kind === 'Diagram' || od.doc.kind === 'Enclosure' || od.doc.kind === 'ReqDoc') { od.doc.dirty = false; tick.value++; }
    // A 3D model saved: what's on disk is now the file as it stands
    if (od.doc.kind === 'StepDoc') { od.doc.dirty = false; od.doc.original = bytes; tick.value++; }
    // Saved: its auto-saved copies go
    dropCopiesOf(od);
    docs.value = [...docs.value];
    // (downloaded because its place couldn't be written: the dialog has said so)
    const downloaded = writeFallbacks() !== fellBack;
    noteSave(od.name, bytes.length, downloaded ? 'downloaded: the place chosen could not be written' : h ? 'written to its file' : 'downloaded');
    if (!downloaded) notify(`Saved ${od.name}`);
    // Under version control: its status again
    if (p) void import('./vcs').then((v) => v.touched(p));
    return true;
  } catch (e) {
    // (a save that could only be downloaded: its dialog has said so)
    if (e instanceof WriteFallbackError) return false;
    notify(saveError(od.name, e), 'error');
    // A save that failed is said in a window, not only in the status line's note that goes after a moment
    const name = (e as DOMException)?.name;
    if (name !== 'SecurityError' && name !== 'NotAllowedError') showDialog(InfoDialog, { title: 'Not Saved', lines: [`${od.name} was not saved.`, `The reason given: “${(e as Error)?.message || String(e)}”`, 'The document is still open here with its changes: try File › Save As to another place.'] });
    return false;
  }
}

/** A failed save's message: a second file selector in one click is refused by the browser. */
function saveError(name: string, e: unknown): string {
  return (e as DOMException)?.name === 'SecurityError' || (e as DOMException)?.name === 'NotAllowedError'
    ? `${name} wasn't saved: the browser allows one file selector per click — save it on its own (File › Save)`
    : `Save failed: ${(e as Error).message}`;
}

/** File › Save Copy As: the document as it is now, under another name; the tab keeps its file. */
export async function cmdSaveCopyAs(od: OpenDoc | null): Promise<void> {
  if (!od) return;
  if (!canSave(od.doc)) { notify(`Saving ${od.name} isn't supported yet`, 'error'); return; }
  try {
    const dot = od.name.lastIndexOf('.');
    const name = dot > 0 ? `${od.name.slice(0, dot)} - Copy${od.name.slice(dot)}` : `${od.name} - Copy`;
    const h = await saveFileAs(name, od.editor ? od.editor.withToolSuspended(() => save(od.doc)) : save(od.doc));
    if (h) notify(`Saved a copy as ${name}`);
  } catch (e) {
    notify(`Save failed: ${(e as Error).message}`, 'error');
  }
}

/** Save All: projects without a folder first (one folder pick, their documents then go there), then the documents, then the projects. */
export async function cmdSaveAll(): Promise<boolean> {
  let ok = true;
  for (const p of projects.value) if (!p.dir && !p.handle && hasFolderAccess() && docs.value.some((d) => d.projectId === p.id && isDocDirty(d))) ok = (await cmdSaveProject(p)) && ok;
  for (const d of [...docs.value]) if (isDocDirty(d)) ok = (await cmdSave(d)) && ok;
  for (const p of projects.value) if (p.dirty) ok = (await cmdSaveProject(p)) && ok;
  return ok;
}

/** Save the .PrjPcb (Save Project, Save Project As). Its lines are written as read, edits in place. */
export async function cmdSaveProject(p: Project | null, as = false, name = p?.name): Promise<boolean> {
  if (!p || !name) return false;
  try {
    const bytes = writePrjPcb(p.prj);
    let h: FileSystemFileHandle | undefined | null;
    if (!p.dir && !p.handle && hasFolderAccess()) {
      // A project made without a folder: choose one, and its documents follow it there
      const dir = await requestProjectFolder();
      if (!dir) return false;
      h = await writeInto(dir, name, bytes);
      p.dir = dir; p.path = name; p.folder = dir.name;
      await rememberProject(dir, name);
      void refreshRecent();
    } else if (!as && p.dir && p.path && (await ensurePermission(p.dir))) {
      // Back into the project folder
      let dir = p.dir;
      const parts = p.path.split('/');
      for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
      const fh = await dir.getFileHandle(parts.at(-1)!, { create: true });
      await keepPrevious({ name: parts.at(-1)!, project: p, path: p.path, handle: fh }, undefined);
      await writeHandle(fh, bytes);
      h = fh;
    } else h = as || !p.handle ? await saveFileAs(name, bytes, p.dir ? await projectFolder(p).catch(() => p.dir) : undefined) : await saveFile(name, bytes, p.handle);
    if (!h && (as || !p.handle)) return false;
    if (h) p.handle = h;
    if (as && h) {
      // Saved elsewhere: the project is that file now (its place in the folder, or no folder)
      const at = p.dir ? await p.dir.resolve(h).catch(() => null) : null;
      if (at) p.path = at.join('/'); else { p.dir = undefined; p.path = undefined; p.folder = undefined; }
    }
    if (as && h?.name && h.name !== p.name) { p.name = h.name; p.prj.name = h.name; }
    p.dirty = false;
    projects.value = [...projects.value];
    notify(`Saved ${p.name}`);
    void import('./vcs').then((v) => v.touched(p));
    return true;
  } catch (e) {
    notify(saveError(name, e), 'error');
    return false;
  }
}

/** The folder that holds a project's .PrjPcb (its documents' paths start there). */
export async function projectFolder(p: Project): Promise<FileSystemDirectoryHandle> {
  let dir = p.dir!;
  for (const seg of (p.path ?? '').split('/').slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
  return dir;
}

/** A name for a new document no open document or project has: Sheet1.SchDoc, PCB1.PcbDoc … */
export function freshName(stem: string, ext: string): string {
  const taken = new Set([...docs.value.map((d) => d.name.toLowerCase()),
    ...projects.value.flatMap((x) => [...x.files.keys(), ...x.prj.documents.map((d) => docBaseName(d).toLowerCase())])]);
  let n = 1;
  while (taken.has(`${stem}${n}.${ext}`.toLowerCase())) n++;
  return `${stem}${n}.${ext}`;
}

/** A new document into a project (unsaved, as AD adds it) or as a free document, opened in a tab. */
export function addNewDocument(name: string, bytes: Uint8Array, p: Project | null): OpenDoc | null {
  if (p) {
    if (!p.prj.documents.some((d) => docBaseName(d).toLowerCase() === name.toLowerCase())) addDocument(p.prj, name);
    p.files.set(name.toLowerCase(), { name, bytes });
    markProjectDirty(p);
  }
  const od = openDocument({ name, bytes }, p?.id);
  // Never saved: Save asks where (or writes it beside the project), and closing asks first
  od?.editor?.undo.markUnsaved();
  return od;
}

/** File › New › Schematic: Sheet1.SchDoc, Sheet2.SchDoc … like Altium, into the focused project. */
export function cmdNewDocument(kind: 'SchDoc', p: Project | null = null): void {
  // Data Management › Templates › Use templates for new documents: from the template chosen
  addSheet(withTemplate(newSheet(freshName('Sheet', 'SchDoc'))), p)?.editor?.undo.markUnsaved();
  void kind;
}

/** File › New › PCB: PCB1.PcbDoc, a blank board as AD17 makes one, into the focused project. */
export function cmdNewPcb(p: Project | null = null): void {
  const name = freshName('PCB', 'PcbDoc');
  addNewDocument(name, newPcbDocBytes(name), p);
}

/**
 * File › New › Project: AD17 creates the project and saves it at once, in a folder of its own
 * name when Create Project Folder is on. Without a folder (browsers that can't write into one)
 * the project stays in Konium until it's saved.
 */
export async function createProject(o: { name: string; dir?: FileSystemDirectoryHandle | null; createFolder: boolean; kind?: 'PrjPcb' | 'LibPkg' | 'PrjMbd' }): Promise<Project> {
  const file = `${o.name}.${o.kind ?? 'PrjPcb'}`;
  const prj = o.kind === 'LibPkg' ? newLibPkg(file) : newPrjPcb(file);
  let dir = o.dir ?? undefined, handle: FileSystemFileHandle | undefined;
  if (dir) {
    if (!(await ensurePermission(dir))) throw new Error(`access to “${dir.name}” wasn't granted`);
    if (o.createFolder) dir = await dir.getDirectoryHandle(o.name, { create: true });
    if (await hasFile(dir, file)) throw new Error(`${file} already exists in “${dir.name}”`);
    handle = await writeInto(dir, file, writePrjPcb(prj));
  }
  const p: Project = { id: nextId('p'), name: file, prj, handle, files: new Map(), folder: dir?.name, dir, path: dir ? file : undefined, dirty: !dir };
  projects.value = [...projects.value, p];
  currentProjectId.value = p.id;
  if (dir) { await rememberProject(dir, file); await refreshRecent(); }
  showPanel('projects');
  notify(dir ? `Created ${file} in “${dir.name}”` : `Created ${file}: save it to keep it`);
  return p;
}

/** A new schematic into a project (or as a free document) and open in a tab. */
export function addSheet(doc: SchDocument, p: Project | null, focus = true): OpenDoc | null {
  const name = doc.name;
  const bytes = writeSchDoc(doc);
  if (p) {
    if (!p.prj.documents.some((d) => docBaseName(d).toLowerCase() === name.toLowerCase())) addDocument(p.prj, name);
    p.files.set(name.toLowerCase(), { name, bytes });
    markProjectDirty(p);
  }
  return openDocument({ name, bytes }, p?.id, focus);
}

/** File › New › Library › Schematic Library: SchLib1.SchLib with Component_1, into the focused project. */
export function cmdNewSchLib(p: Project | null = null): void {
  const name = freshName('SchLib', 'SchLib');
  addNewDocument(name, writeSchLibDoc(newSchLib(name)), p);
}

/** File › New › Library › PCB Library: PcbLib1.PcbLib with PCBCOMPONENT_1, into the focused project. */
export function cmdNewPcbLib(p: Project | null = null): void {
  const name = freshName('PcbLib', 'PcbLib');
  addNewDocument(name, writePcbLibDoc(newPcbLib(name)), p);
}

/** Save changes to X? Yes / No / Cancel. */
export const askSave = (name: string): Promise<'yes' | 'no' | 'cancel'> => new Promise((answer) => showDialog(SaveChangesDialog, { name, onAnswer: answer }));

/** Close a tab; one with unsaved changes asks first (Yes saves, No discards, Cancel keeps it). True when it closed. */
export async function cmdClose(od: OpenDoc | null, ask = true): Promise<boolean> {
  if (!od || !docs.value.includes(od)) return !!od;
  if (ask && settings.confirmClose && isDocDirty(od)) {
    const a = await askSave(od.name);
    if (a === 'cancel' || (a === 'yes' && !(await cmdSave(od)))) return false;
  }
  // A side of a compare closed: the compare ends (its earlier version closes with it)
  if (!od.forCompare) void import('./compare').then((c) => { const v = c.compareView.value; if (v && (v.newer.od === od || v.older.od === od)) c.closeCompare(); });
  od.editor?.unmount();
  od.dispose?.();
  // Closed (saved, or its changes let go): its auto-saved copies go
  dropCopiesOf(od);
  const list = docs.value.filter((d) => d.id !== od.id);
  docs.value = list;
  if (activeId.value === od.id) activeId.value = list.filter((d) => !d.hidden).at(-1)?.id ?? null;
  return true;
}

export function cycleTab(dir: 1 | -1): void {
  const list = docs.value.filter((d) => !d.hidden);
  if (!list.length) return;
  const i = list.findIndex((d) => d.id === activeId.value);
  activeId.value = list[(i + dir + list.length) % list.length]!.id;
}
