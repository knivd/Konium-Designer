/**
 * The CAM editor's commands (AD17's CAMtastic menus): File › New › CAM Document; File › Import ›
 * Quick Load, Gerber and Drill; File › Export › Gerber and Save Drill; View › Layers (All On, All
 * Off, Isolate, Turn the current layer on or off, Sort); Tables › Layers and Apertures; Analysis
 * › Query and Measure; Reports (Drill, Apertures, Status). Gerber and drill files opened or
 * dropped on the window, and those File › Fabrication Outputs writes, open as a CAM document.
 */
import type { Command, Scope } from '../core/commands';
import { CamEditor } from '../editors/cam/CamEditor';
import { camLayerFrom, newCamDocument, sortLayers, writeCam, type CamDocument, type CamLayer } from '../formats/cam/camDoc';
import { writeCamLayer } from '../formats/cam/camWrite';
import { sniffCamFile } from '../formats/gerber/gerberRead';
import { apertureListHeader, type OutputFile } from '../formats/gerber/gerber';
import { activeId, notify, tick, units, type OpenDoc } from './state';
import { activeCam, camChanged } from './camCommon';
import { camPrefs, readDefaults } from './camPrefs';
import { addNewDocument, freshName, openDocument } from './actions';
import { activeProject } from './project';
import { showDialog } from './dialogs';
import { InfoDialog } from './dialogs/Confirm';
import { CamAperturesDialog, CamLayerTableDialog, CamReportDialog, apertureReport, drillReport, statusReport } from './dialogs/CamTables';
import { pickImportFiles, type PickedFile } from '../platform/fs';
import { showPanel } from './dock/store';
import type { Tool, ToolPointer } from '../core/tools';

const CAM: Scope[] = ['cam'];
export { activeCam, camChanged };
export function setLayers(ed: CamEditor, on: (l: CamLayer, i: number) => boolean): void { ed.doc.layers.forEach((l, i) => { l.visible = on(l, i); }); camChanged(ed); }

/** Extensions CAM files come with (the file selector's filter; their content decides). */
export const CAM_EXTS = ['.gbr', '.ger', '.pho', '.art', '.gtl', '.gbl', '.gto', '.gbo', '.gts', '.gbs', '.gtp', '.gbp', '.gko', '.gm1', '.gm2', '.gm13', '.gd1', '.gg1', '.gpt', '.gpb',
  '.g1', '.g2', '.g3', '.g4', '.gp1', '.gp2', '.drl', '.xln', '.txt', '.nc', '.drd', '.tap'];

const text = (f: { bytes?: Uint8Array; text?: string }) => f.text ?? new TextDecoder().decode(f.bytes ?? new Uint8Array());

/** Files that read as Gerber or Excellon. */
export const isCamFile = (f: PickedFile): boolean => !/\.(schdoc|pcbdoc|schlib|pcblib|prjpcb|intlib|sdf|nsx)$/i.test(f.name) && sniffCamFile(new TextDecoder().decode(f.bytes.subarray(0, 4000))) !== null;

/** Layers from files (those that aren't Gerber or Excellon left out, and said so). */
function layersFrom(files: { name: string; bytes?: Uint8Array; text?: string }[]): CamLayer[] {
  const out: CamLayer[] = [], skipped: string[] = [];
  const def = readDefaults();
  for (const f of files) { const l = camLayerFrom(f.name.split(/[\\/]/).pop()!, text(f), def); if (l) out.push(l); else skipped.push(f.name); }
  if (skipped.length) notify(`Not Gerber or NC drill: ${skipped.join(', ')}`, 'error');
  return out;
}

/** A new CAM document of these files (CAM1.Cam …), in front. */
export function openCamFiles(files: { name: string; bytes?: Uint8Array; text?: string }[], inProject = false): OpenDoc | null {
  const layers = layersFrom(files);
  if (!layers.length) return null;
  const name = freshName('CAM', 'Cam');
  const doc = newCamDocument(name, layers);
  const od = inProject ? addNewDocument(name, new TextEncoder().encode(writeCam(doc)), activeProject()) : openDocument({ name, bytes: new TextEncoder().encode(writeCam(doc)) });
  if (od) { od.doc = doc; (od.editor as CamEditor).doc = doc; doc.dirty = true; activeId.value = od.id; tick.value++; showPanel('cam'); setTimeout(() => od.editor?.viewport?.fit?.(), 50); }
  return od;
}

/** After File › Fabrication Outputs: the files written, opened as AD opens them, in a CAM document. */
export function openGeneratedInCam(files: OutputFile[]): void {
  // RS-274-D: each file viewed with the run's aperture list (<board>.APR) put in front of it
  const apr = files.find((f) => /\.APR$/i.test(f.name));
  const head = apr ? apertureListHeader(text(apr)) : null;
  const all = files.filter((f) => f !== apr).map((f) => (head && /^G04/.test(text(f)) && !text(f).includes('%ADD') ? { ...f, text: [...head, text(f)].join('\n') } : f));
  const cam = all.filter((f) => sniffCamFile(text(f).slice(0, 4000)));
  if (cam.length) openCamFiles(cam);
}

/** Layers added to the CAM document in front (or a new one). */
function addLayers(ed: CamEditor | null, files: PickedFile[]): void {
  if (!ed) { openCamFiles(files); return; }
  const layers = layersFrom(files);
  if (!layers.length) return;
  ed.doc.layers = camPrefs().sortOnLoad ? sortLayers([...ed.doc.layers, ...layers]) : [...ed.doc.layers, ...layers];
  camChanged(ed);
  ed.viewport?.fit?.();
  notify(`${layers.length} layer${layers.length === 1 ? '' : 's'} loaded`);
}

async function importInto(kind: 'any' | 'gerber' | 'drill'): Promise<void> {
  const ed = activeCam();
  const exts = kind === 'drill' ? ['.drl', '.txt', '.xln', '.nc', '.drd', '.tap'] : kind === 'gerber' ? CAM_EXTS.filter((e) => !['.drl', '.txt', '.xln', '.nc', '.drd', '.tap'].includes(e)) : CAM_EXTS;
  const files = await pickImportFiles(exts as `.${string}`[], kind === 'drill' ? 'NC drill files' : kind === 'gerber' ? 'Gerber files' : 'Gerber and NC drill files');
  if (files.length) addLayers(ed, files);
}

/** File › Export › Gerber / Save Drill: the shown layers of that kind, written as files. */
async function exportLayers(ed: CamEditor, kind: 'gerber' | 'drill'): Promise<void> {
  const files: OutputFile[] = ed.doc.layers.filter((l) => l.visible && l.data.kind === kind).map((l) => ({ name: l.name, text: writeCamLayer(l) }));
  if (!files.length) { notify(`No ${kind === 'gerber' ? 'Gerber' : 'drill'} layer is shown`); return; }
  const { deliverOutputs } = await import('./dialogs/Outputs');
  await deliverOutputs(activeProject(), ed.doc.name.replace(/\.cam$/i, ''), kind === 'gerber' ? 'Gerber Files' : 'NC Drill Files', files);
}

/** Analysis › Query: click an object, see what it is (repeats until right-click or Esc). */
class QueryTool implements Tool {
  readonly id = 'cam-query';
  constructor(private ed: CamEditor) {}
  hint(): string { return 'Query: click an object to see its layer, D-code, aperture and coordinates (right-click to finish)'; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const hit = this.ed.hits(p.raw)[0];
    if (!hit) { notify('Nothing there'); return; }
    this.ed.selection = new Set([hit.key]);
    this.ed.invalidate();
    const rows = this.ed.properties()[0]?.rows ?? [];
    showDialog(InfoDialog, { title: 'Query', lines: rows.map((r) => `${r.label}: ${r.value}`) });
  }
  pointerMove(): void {}
  /** Right-click or Esc: done. */
  cancel(): boolean { return false; }
}

export function camCommands(): Command[] {
  const on = () => !!activeCam();
  const withCam = (f: (ed: CamEditor) => void) => () => { const e = activeCam(); if (e) f(e); };
  return [
    { id: 'file.newCam', label: 'CAM Document', run: () => { const name = freshName('CAM', 'Cam'); const od = addNewDocument(name, new TextEncoder().encode(writeCam(newCamDocument(name))), activeProject()); if (od) showPanel('cam'); } },
    { id: 'cam.quickLoad', label: 'Quick Load...', run: () => void importInto('any') },
    { id: 'cam.importGerber', label: 'Gerber...', scopes: CAM, run: () => void importInto('gerber') },
    { id: 'cam.importDrill', label: 'Drill...', scopes: CAM, run: () => void importInto('drill') },
    { id: 'cam.exportGerber', label: 'Gerber...', scopes: CAM, enabled: on, run: withCam((e) => void exportLayers(e, 'gerber')) },
    { id: 'cam.exportDrill', label: 'Drill...', scopes: CAM, enabled: on, run: withCam((e) => void exportLayers(e, 'drill')) },
    { id: 'cam.layersAllOn', label: 'All On', scopes: CAM, enabled: on, run: withCam((e) => setLayers(e, () => true)) },
    { id: 'cam.layersAllOff', label: 'All Off', scopes: CAM, enabled: on, run: withCam((e) => setLayers(e, () => false)) },
    { id: 'cam.layersIsolate', label: 'Isolate', scopes: CAM, enabled: () => !!activeCam()?.doc.layers.length, run: withCam((e) => setLayers(e, (_, i) => i === e.doc.current)) },
    { id: 'cam.layerToggle', label: 'Turn Current Layer On/Off', scopes: CAM, enabled: () => !!activeCam()?.doc.layers.length, run: withCam((e) => { const l = e.doc.layers[e.doc.current]; if (l) { l.visible = !l.visible; camChanged(e); } }) },
    { id: 'cam.layersSort', label: 'Sort Layers', scopes: CAM, enabled: on, run: withCam((e) => { e.doc.layers = sortLayers(e.doc.layers); camChanged(e); }) },
    { id: 'cam.layerTable', label: 'Layers...', scopes: CAM, enabled: on, run: withCam((e) => showDialog(CamLayerTableDialog, { ed: e })) },
    { id: 'cam.apertures', label: 'Apertures...', scopes: CAM, enabled: on, run: withCam((e) => showDialog(CamAperturesDialog, { ed: e, units: units.value })) },
    { id: 'cam.query', label: 'Query', scopes: CAM, enabled: on, run: withCam((e) => e.setTool(new QueryTool(e))) },
    { id: 'cam.reportDrill', label: 'Drill', scopes: CAM, enabled: on, run: withCam((e) => showDialog(CamReportDialog, { title: 'Drill Report', text: drillReport(e, units.value) })) },
    { id: 'cam.reportApertures', label: 'Apertures', scopes: CAM, enabled: on, run: withCam((e) => showDialog(CamReportDialog, { title: 'Aperture Report', text: apertureReport(e, units.value) })) },
    { id: 'cam.reportStatus', label: 'Status', scopes: CAM, enabled: on, run: withCam((e) => showDialog(CamReportDialog, { title: 'Status', text: statusReport(e, units.value) })) },
  ];
}

export type { CamDocument };
