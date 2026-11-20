/**
 * The CAM editor's File menu and macros (CAMtastic): Setup (General, Import/Export), Import (ODB++,
 * Netlist, Mill/Rout, DXF/DWG, HPGL, an aperture file in the wizard's formats, a custom aperture
 * library), Export (ODB++, Netlist (IPC-D-356), IPC-D-350, Mill/Rout, DXF, Part Centroids, Aperture
 * Library, Bitmap, Export to PCB), Print and Print Preview; Macro › Start / Stop Recording, Run Script
 * and Edit Script — a script being the commands run, the clicks the tools took and the CAM dialogs'
 * answers, played back in order.
 */
import type { Command, Scope } from '../core/commands';
import { commands } from '../core/commands';
import type { Vec2 } from '../core/geom';
import type { CamEditor } from '../editors/cam/CamEditor';
import { sortLayers, type CamLayer } from '../formats/cam/camDoc';
import { apertureLibrary, bmp, centroidsCsv, millLayer, rasterise, readApertureLibrary, readDxf, readHpgl, readIpc356, readOdb, writeCamOdb, writeDxf, writeIpc350, writeIpc356 } from '../formats/cam/camIO';
import { camToPcb } from '../formats/cam/camToPcb';
import { camLayerFrom } from '../formats/cam/camDoc';
import { writeCamLayer } from '../formats/cam/camWrite';
import type { GerberLayer } from '../formats/gerber/gerberRead';
import { pickImportFiles, saveFileAs } from '../platform/fs';
import { activeCam, ask, camChanged, camEdited, freshLayerName, gerberLayer } from './camCommon';
import { camPrefs, readDefaults, setCamPrefs } from './camPrefs';
import { closeDialog, dialogStack, showDialog } from './dialogs';
import { CamApertureWizardDialog } from './dialogs/CamTables2';
import { camFormObservers, type CamValues } from './dialogs/CamForm';
import { PrintPreviewDialog } from './dialogs/Print';
import { printDocs } from './print';
import { activeId, docs, notify, units } from './state';
import { openDocument } from './actions';

const CAM: Scope[] = ['cam'];
const id = (n: string) => `ad:CAMTASTIC:${n}`;
const dec = new TextDecoder(), enc = new TextEncoder();
const base = (ed: CamEditor) => ed.doc.name.replace(/\.cam$/i, '');

/** Layers added to the document as one undo step (sorted into the stack when Setup says so). */
function addLayers(ed: CamEditor, label: string, layers: CamLayer[]): void {
  if (!layers.length) return;
  for (const l of layers) l.name = freshLayerName(ed.doc, l.name);
  ed.edit(label, 'all', () => {
    ed.doc.layers = camPrefs().sortOnLoad ? sortLayers([...ed.doc.layers, ...layers]) : [...ed.doc.layers, ...layers];
    ed.doc.current = ed.doc.layers.indexOf(layers[0]!);
  });
  camEdited();
  ed.fit();
  notify(`${layers.length} layer${layers.length === 1 ? '' : 's'} added: ${layers.map((l) => l.name).join(', ')}`);
}

async function save(name: string, bytes: Uint8Array | string): Promise<void> {
  const b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
  const h = await saveFileAs(name, b);
  if (h !== null) notify(`${name} written`);
}

/* ─── Macros ───────────────────────────────────────────────────────────────────────── */

const SCRIPT_KEY = 'konium.camScript';
let script: string[] = (() => { try { return JSON.parse(globalThis.localStorage?.getItem(SCRIPT_KEY) ?? '[]') as string[]; } catch { return []; } })();
let recording: { ed: CamEditor; lines: string[]; off: () => void } | null = null;
const keepScript = (lines: string[]) => { script = lines; try { globalThis.localStorage?.setItem(SCRIPT_KEY, JSON.stringify(lines)); } catch { /* kept for this session */ } };
const MACRO_IDS = new Set(['MacroRecord', 'MacroStopRecording', 'MacroRun', 'MacroEdit'].map(id));

/** The script being recorded or the last one. */
export const camScript = (): string[] => [...(recording?.lines ?? script)];

function startRecording(ed: CamEditor): void {
  const lines: string[] = [];
  const onCmd = (c: Command, scope: Scope) => { if (scope === 'cam' && !MACRO_IDS.has(c.id)) lines.push(`run ${c.id}`); };
  const onAnswer = (title: string, v: CamValues) => lines.push(`answer ${JSON.stringify({ title, v })}`);
  ed.onToolClick = (at: Vec2, button: number) => lines.push(button === 2 ? 'rclick' : `click ${Math.round(at.x)} ${Math.round(at.y)}`);
  commands.observers.add(onCmd);
  camFormObservers.add(onAnswer);
  recording = { ed, lines, off: () => { commands.observers.delete(onCmd); camFormObservers.delete(onAnswer); ed.onToolClick = null; } };
  notify('Recording: the commands, clicks and answers from now on (Macro › Stop Recording ends it)');
}

function stopRecording(): void {
  if (!recording) { notify('Not recording'); return; }
  recording.off();
  keepScript(recording.lines);
  notify(`Script recorded: ${recording.lines.length} step${recording.lines.length === 1 ? '' : 's'}`);
  recording = null;
}

/** A script played back: commands run, clicks given to the tool, dialogs answered as recorded. */
export async function runScript(ed: CamEditor, lines: string[], wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))): Promise<number> {
  let done = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [word, ...rest] = line.split(' ');
    const arg = rest.join(' ');
    if (word === 'run') { if (!commands.run(arg, 'cam')) throw new Error(`Step ${done + 1}: ${arg} can't run here`); }
    else if (word === 'click' || word === 'rclick') {
      const [x, y] = arg.split(' ').map(Number);
      const at = { x: x ?? 0, y: y ?? 0 };
      const p = { world: ed.snap(at), raw: at, button: word === 'rclick' ? 2 : 0, shift: false, ctrl: false, alt: false };
      if (word === 'rclick') ed.rightClick(p); else { ed.pointerMove(p); ed.pointerDown(p); }
    } else if (word === 'answer') {
      const { title, v } = JSON.parse(arg) as { title: string; v: CamValues };
      const top = dialogStack.value.at(-1);
      const props = top?.props as { title?: string; onOk?: (v: CamValues) => void | string } | undefined;
      if (!props?.onOk || props.title !== title) throw new Error(`Step ${done + 1}: no "${title}" dialog to answer`);
      const r = props.onOk(v);
      if (typeof r === 'string') throw new Error(`Step ${done + 1}: ${title}: ${r}`);
      closeDialog();
    } else if (word === 'key') ed.toolKey(arg);
    else throw new Error(`Step ${done + 1}: "${word}" isn't a script step (run, click, rclick, answer, key)`);
    done++;
    await wait(0);
  }
  return done;
}

/* ─── Commands ─────────────────────────────────────────────────────────────────────── */

export function camFileCommands(): Command[] {
  const on = () => !!activeCam();
  const withCam = (f: (ed: CamEditor) => void | Promise<void>) => () => { const e = activeCam(); if (e) return f(e); };
  const cmd = (name: string, label: string, run: (ed: CamEditor) => void | Promise<void>): Command => ({ id: id(name), label, scopes: CAM, enabled: on, run: withCam(run) });
  return [
    // Setup
    cmd('PreferencesGeneral', 'General', (ed) => {
      const p = camPrefs();
      ask('Setup — General', [
        { key: 'sort', label: 'Sort layers into the stack when loading', kind: 'bool', value: p.sortOnLoad },
        { key: 'fill', label: 'Draw objects filled', kind: 'bool', value: p.fill },
        { key: 'tr', label: 'Translucent layers', kind: 'bool', value: p.translucent },
        { key: 'origin', label: 'Show the origin', kind: 'bool', value: p.showOrigin },
      ], (v) => {
        setCamPrefs({ sortOnLoad: !!v.sort, fill: !!v.fill, translucent: !!v.tr, showOrigin: !!v.origin });
        Object.assign(ed.view, { fill: !!v.fill, translucent: !!v.tr, origin: !!v.origin });
        camChanged(ed);
      });
    }),
    cmd('PreferencesImport', 'Import/Export', () => {
      const p = camPrefs();
      const fmt = (i: number, d: number) => `${i}:${d}`;
      ask('Setup — Import/Export', [
        { kind: 'note', text: 'How files read when they don\'t say (RS-274-D Gerber, Excellon without a header, DXF without units).' },
        { key: 'gu', label: 'Gerber units', kind: 'select', value: p.gerberUnits === 'mm' ? 'Millimetres' : 'Inches', options: ['Inches', 'Millimetres'] },
        { key: 'gf', label: 'Gerber format', kind: 'select', value: fmt(p.gerberInt, p.gerberDec), options: ['2:3', '2:4', '2:5', '2:6', '3:3', '4:2', '4:3', '4:4'] },
        { key: 'gz', label: 'Gerber zeros', kind: 'select', value: p.gerberZeros === 'L' ? 'Leading left out' : 'Trailing left out', options: ['Leading left out', 'Trailing left out'] },
        { key: 'du', label: 'Drill units', kind: 'select', value: p.drillUnits === 'mm' ? 'Millimetres' : 'Inches', options: ['Inches', 'Millimetres'] },
        { key: 'df', label: 'Drill format', kind: 'select', value: fmt(p.drillInt, p.drillDec), options: ['2:3', '2:4', '2:5', '3:3', '3:4', '4:2', '4:3'] },
        { key: 'dz', label: 'Drill zeros', kind: 'select', value: p.drillZeros === 'L' ? 'Leading left out' : 'Trailing left out', options: ['Leading left out', 'Trailing left out'] },
        { key: 'xu', label: 'DXF units', kind: 'select', value: p.dxfUnits, options: ['mm', 'in', 'mil'] },
        { key: 'xw', label: 'DXF line width', kind: 'length', value: p.dxfWidth, min: 1 },
      ], (v) => {
        const [gi, gd] = String(v.gf).split(':').map(Number), [di, dd] = String(v.df).split(':').map(Number);
        setCamPrefs({ gerberUnits: v.gu === 'Millimetres' ? 'mm' : 'in', gerberInt: gi!, gerberDec: gd!, gerberZeros: v.gz === 'Leading left out' ? 'L' : 'T',
          drillUnits: v.du === 'Millimetres' ? 'mm' : 'in', drillInt: di!, drillDec: dd!, drillZeros: v.dz === 'Leading left out' ? 'L' : 'T', dxfUnits: v.xu as 'mm' | 'in' | 'mil', dxfWidth: v.xw as number });
      }, { width: 460 });
    }),
    // Import
    cmd('FileImportODB', 'ODB++...', async (ed) => {
      const files = await pickImportFiles(['.tgz', '.tar', '.gz'], 'ODB++ jobs');
      for (const f of files) {
        try { const r = await readOdb(f.bytes); addLayers(ed, 'Import ODB++', r.layers); if (r.warnings.length) notify(r.warnings.slice(0, 3).join('; '), 'error'); }
        catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); }
      }
    }),
    cmd('FileImportNetList', 'Netlist...', async (ed) => {
      const files = await pickImportFiles(['.ipc', '.356', '.net', '.txt', '.tst'], 'IPC-D-356 netlists');
      if (!files.length) return;
      const nets = readIpc356(dec.decode(files[0]!.bytes));
      if (!nets.length) { notify(`${files[0]!.name} has no IPC-D-356 nets`, 'error'); return; }
      ed.edit('Import Netlist', [], () => { ed.doc.refNets = nets; });
      camEdited();
      notify(`${nets.length} nets read from ${files[0]!.name} (Tools › Netlist › Compare checks the copper against them)`);
    }),
    cmd('MillFileImport', 'Mill/Rout...', async (ed) => {
      const files = await pickImportFiles(['.rou', '.rte', '.rout', '.mil', '.drl', '.txt', '.nc', '.tap'], 'Mill and rout files');
      const def = readDefaults();
      addLayers(ed, 'Import Mill/Rout', files.map((f) => millLayer(f.name, dec.decode(f.bytes), (n, t) => camLayerFrom(n, t, def))).filter((l): l is CamLayer => !!l));
    }),
    cmd('DxfDwgFileImport', 'DXF/DWG...', async (ed) => {
      const files = await pickImportFiles(['.dxf', '.dwg'], 'DXF drawings');
      const dwg = files.filter((f) => /\.dwg$/i.test(f.name));
      if (dwg.length) notify(`${dwg.map((f) => f.name).join(', ')}: DWG is AutoCAD's closed format and can't be read here — save it as DXF`, 'error');
      const dxf = files.filter((f) => !/\.dwg$/i.test(f.name));
      if (!dxf.length) return;
      const p = camPrefs();
      ask('Import DXF', [
        { key: 'u', label: 'Units, when the drawing doesn\'t say', kind: 'select', value: p.dxfUnits, options: ['mm', 'in', 'mil'] },
        { key: 'w', label: 'Width of lines with none', kind: 'length', value: p.dxfWidth, min: 1 },
        { key: 'one', label: 'All DXF layers on one CAM layer', kind: 'bool', value: false },
      ], (v) => {
        const layers = dxf.flatMap((f) => readDxf(dec.decode(f.bytes), { unit: v.u as 'mm' | 'in' | 'mil', width: v.w as number, ...(v.one ? { oneLayer: f.name } : {}) }));
        if (!layers.length) return 'Nothing in the drawing could be read';
        addLayers(ed, 'Import DXF', layers);
      });
    }),
    cmd('HpglFileImport', 'HPGL/HPGL2...', async (ed) => {
      const files = await pickImportFiles(['.plt', '.hpgl', '.hpg', '.hgl', '.hp', '.prn'], 'HPGL plots');
      addLayers(ed, 'Import HPGL', files.map((f) => readHpgl(dec.decode(f.bytes), f.name)).filter((l) => (l.data as GerberLayer).objects.length));
    }),
    cmd('ApertureFileOpen', 'Aperture File (using Wizard formats)...', async (ed) => {
      const files = await pickImportFiles(['.txt', '.apr', '.ape', '.lst', '.rep', '.whl', '.app'], 'Aperture lists');
      if (files.length) showDialog(CamApertureWizardDialog, { ed, units: units.value, text: dec.decode(files[0]!.bytes) });
    }),
    cmd('OpenFileLibrary', 'Custom Aperture Library File (*.LIB)...', async (ed) => {
      const t = gerberLayer(ed);
      if (!t) return;
      const files = await pickImportFiles(['.lib', '.gbr', '.txt'], 'Aperture libraries');
      if (!files.length) return;
      let added: number[] = [];
      ed.edit('Aperture Library', [t.l], () => { added = readApertureLibrary(dec.decode(files[0]!.bytes), t.g); });
      camEdited();
      notify(added.length ? `${added.length} aperture${added.length === 1 ? '' : 's'} added to ${t.l.name}: ${added.map((c) => `D${c}`).join(', ')}` : 'No apertures in the library', added.length ? 'ok' : 'error');
    }),
    // Export
    cmd('FileExportODB', 'ODB++...', async (ed) => { const r = await writeCamOdb(ed.doc); await save(r.name, r.bytes); }),
    cmd('FileExportIPCD356', 'Netlist...', async (ed) => {
      if (!ed.doc.nets?.length) { notify('Extract the netlist first (Tools › Netlist › Extract)'); return; }
      await save(`${base(ed)}.ipc`, writeIpc356(ed.doc));
    }),
    cmd('FileExportIPCD350', 'IPC-D-350...', async (ed) => {
      if (!ed.doc.nets?.length) { notify('Extract the netlist first (Tools › Netlist › Extract)'); return; }
      await save(`${base(ed)}.350`, writeIpc350(ed.doc));
    }),
    cmd('MillExport', 'Mill/Rout...', async (ed) => {
      const routs = ed.doc.layers.filter((l) => l.data.kind === 'drill' && l.data.routes.length && l.visible);
      if (!routs.length) { notify('No shown layer has rout paths'); return; }
      const { deliverOutputs } = await import('./dialogs/Outputs');
      await deliverOutputs(null, base(ed), 'Mill/Rout Files', routs.map((l) => ({ name: /\.\w+$/.test(l.name) ? l.name.replace(/\.\w+$/, '.RTE') : `${l.name}.RTE`, text: writeCamLayer({ ...l, edited: true }) })));
    }),
    cmd('FileSaveDXF', 'DXF...', async (ed) => save(`${base(ed)}.dxf`, writeDxf(ed.doc))),
    cmd('FileExportCentroid', 'Part Centroids...', async (ed) => {
      if (!ed.doc.parts?.length) { notify('No parts: Tools › Parts › Create & Group Parts makes them'); return; }
      await save(`Pick Place for ${base(ed)}.csv`, centroidsCsv(ed.doc, units.value));
    }),
    cmd('InspectReportsLibrary', 'Aperture Library', async (ed) => {
      const t = gerberLayer(ed);
      if (t) await save(`${t.l.name.replace(/\.[^.]+$/, '')}.LIB`, apertureLibrary(t.l));
    }),
    cmd('FileSaveBitmap', 'Bitmap (*.BMP)...', (ed) => ask('Save Bitmap', [
      { kind: 'note', text: 'The shown layers as a Windows bitmap, the field black.' },
      { key: 'dpi', label: 'Resolution (dots an inch)', kind: 'number', value: 600, min: 25, max: 4800 },
    ], (v) => {
      const r = rasterise(ed.doc, v.dpi as number);
      if (!r) return 'Too big at that resolution (or nothing shown): try fewer dots an inch';
      void save(`${base(ed)}.bmp`, bmp(r.w, r.h, r.rgb, v.dpi as number));
    })),
    cmd('ExportToPCB', 'Export to PCB', (ed) => {
      if (!ed.doc.layers.some((l) => l.data.kind === 'gerber')) { notify('No Gerber layers to make a board of', 'error'); return; }
      const r = camToPcb(ed.doc);
      const od = openDocument({ name: r.name, bytes: r.bytes });
      if (od) { activeId.value = od.id; docs.value = [...docs.value]; }
      notify(`${r.name}: ${r.stats.tracks} tracks, ${r.stats.arcs} arcs, ${r.stats.pads} pads, ${r.stats.vias} vias, ${r.stats.regions} regions${r.stats.nets ? `, ${r.stats.nets} nets` : ''}${r.warnings.length ? ` (${r.warnings[0]})` : ''}`);
    }),
    // Print
    cmd('FilePrint', 'Print...', () => { const od = docs.value.find((d) => d.id === activeId.value); if (od) printDocs([od]); }),
    cmd('FilePrintPreview', 'Print Preview', () => { const od = docs.value.find((d) => d.id === activeId.value); if (od) showDialog(PrintPreviewDialog, { docs: [od] }); }),
    // Macros
    { id: id('MacroRecord'), label: 'Start Recording...', scopes: CAM, enabled: () => on() && !recording, run: withCam((ed) => startRecording(ed)) },
    { id: id('MacroStopRecording'), label: 'Stop Recording...', scopes: CAM, enabled: () => !!recording, run: () => stopRecording() },
    cmd('MacroRun', 'Run Script', async (ed) => {
      if (recording) { notify('Stop recording first'); return; }
      if (!script.length) { notify('No script: Macro › Start Recording makes one, Edit Script writes one'); return; }
      try { const n = await runScript(ed, script); notify(`Script run: ${n} step${n === 1 ? '' : 's'}`); }
      catch (e) { notify((e as Error).message, 'error'); }
    }),
    cmd('MacroEdit', 'Edit Script...', () => ask('Edit Script', [
      { kind: 'note', text: 'One step a line: run <command id>, click <x> <y> (board units), rclick, key <key>, answer <dialog and values>.' },
      { key: 's', label: 'Script', kind: 'text', value: camScript().join('\n'), multiline: true },
    ], (v) => { keepScript(String(v.s).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())); }, { width: 640 })),
  ];
}

