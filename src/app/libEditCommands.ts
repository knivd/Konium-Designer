/**
 * Library editing tools of 26.021: PCB library — Edit › Set Reference (Pin 1, Center,
 * Location), the right-click Snap Grid X / Y lists and Set Global Snap Grid, Prev Component;
 * schematic library — Tools › Model Manager, Parameter Manager, Configure Pin Swapping,
 * Edit › Paste Array; both — Tools › Library Splitter Wizard.
 */
import type { Command, Scope } from '../core/commands';
import { active, notify, tick, units } from './state';
import { showDialog } from './dialogs';
import { PromptDialog } from './dialogs/Confirm';
import { ModelManagerDialog } from './dialogs/ModelManager';
import { ComponentWizardDialog } from './dialogs/ComponentWizard';
import { ParameterManagerDialog } from './dialogs/ProjectDialogs';
import { PinSwapDialog } from './dialogs/PinSwap';
import { SchLibEditor } from '../editors/sch/SchLibEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PickTool } from '../editors/Editor';
import { SchPasteTool } from '../editors/sch/SchPasteTool';
import { clipboard } from '../editors/clipboard';
import { lineClip } from '../model/smartPaste';
import { splitPcbLib, splitSchLib, type SplitFile } from '../model/libSplit';
import { zip } from '../formats/zip';
import { saveFileAs } from '../platform/fs';
import { formatCoord, mil, mm, parseLength, SCH_UNIT } from '../core/units';

const SCHLIB: Scope[] = ['schlib'];
const PCBLIB: Scope[] = ['pcblib'];
const slib = () => { const e = active.value?.editor; return e instanceof SchLibEditor ? e : null; };
const plib = () => { const e = active.value?.editor; return e instanceof PcbLibEditor ? e : null; };
const anyPcb = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };

/** The right-click Snap Grid lists (X and Y: Konium's grid is square, so either sets both). */
const SNAP: [string, number][] = [['1Mil', mil(1)], ['5Mil', mil(5)], ['10Mil', mil(10)], ['20Mil', mil(20)], ['25Mil', mil(25)], ['50Mil', mil(50)], ['100Mil', mil(100)],
  ['025mm', mm(0.025)], ['100mm', mm(0.1)], ['250mm', mm(0.25)], ['500mm', mm(0.5)], ['1000mm', mm(1)], ['2500mm', mm(2.5)]];

/** Ask for a length in the current unit (a bare number is in it). */
function askLength(title: string, label: string, value: number, then: (v: number) => void): void {
  const u = units.value;
  showDialog(PromptDialog, { title, fields: [{ label: `${label} (${u})`, value: formatCoord(value, u).replace(/[a-z]+$/, '') }], onOk: ([v]: string[]) => {
    const n = parseLength(/^\s*-?[\d.]+\s*$/.test(v ?? '') ? `${(v ?? '').trim()}${u}` : v ?? '');
    if (n === undefined) { notify(`"${v}" isn't a length`, 'error'); return; }
    then(Math.round(n));
  } });
}

/** Write split libraries to a folder the user picks (or, without folder access, one .zip). */
async function deliverSplit(lib: string, files: SplitFile[]): Promise<void> {
  const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
  try {
    if (picker) {
      const dir = await picker({ id: 'konium-split', mode: 'readwrite' });
      for (const f of files) {
        const w = await (await dir.getFileHandle(f.name, { create: true })).createWritable();
        await w.write(f.bytes as Uint8Array<ArrayBuffer>);
        await w.close();
      }
      notify(`Library Splitter: ${files.length} libraries written to ${dir.name}`);
    } else {
      const stem = lib.replace(/\.[^.]+$/, '');
      await saveFileAs(`${stem} split.zip`, zip(files.map((f) => ({ name: `${stem}/${f.name}`, bytes: f.bytes }))));
      notify(`Library Splitter: ${files.length} libraries in ${stem} split.zip`);
    }
  } catch (e) {
    if ((e as DOMException).name !== 'AbortError') notify(`Library Splitter: ${(e as Error).message}`, 'error');
  }
}

export function libEditCommands(): Command[] {
  const hasP = () => !!plib(), hasS = () => !!slib();
  const setRef = (label: string, at: () => { x: number; y: number } | null, none: string) => () => {
    const e = plib();
    if (!e) return;
    const p = at();
    if (!p) { notify(none, 'error'); return; }
    if (!e.setReference(p)) notify(`The reference is already at the ${label}`);
  };
  return [
    { id: 'ad:CompMake:RunWizard', label: 'Component Wizard...', scopes: PCBLIB, enabled: hasP, run: () => { const e = plib(); if (e) showDialog(ComponentWizardDialog, { ed: e }); } },
    // Edit › Set Reference
    { id: 'ad:PCB:SetComponentReferencePin1', label: 'Pin 1', scopes: PCBLIB, enabled: hasP, run: setRef('pin 1', () => plib()?.pin1() ?? null, 'The footprint has no pads') },
    { id: 'ad:PCB:SetComponentReferenceCenter', label: 'Centre', scopes: PCBLIB, enabled: hasP, run: setRef('centre', () => plib()?.centre() ?? null, 'The footprint is empty') },
    { id: 'ad:PCB:SetComponentReferenceLocation', label: 'Location', scopes: PCBLIB, enabled: hasP, run: () => {
      const e = plib();
      if (e) e.setTool(new PickTool(e, 'Set Reference: click the new reference point', (p) => { e.setReference(e.snap(p.raw)); return true; }));
    } },
    { id: 'ad:PCB:PopupRightMouseLibPrevComponent', label: 'Prev Component', scopes: PCBLIB, run: () => { const l = plib(); if (l) l.showFootprint(Math.max(l.current - 1, 0)); }, enabled: () => (plib()?.current ?? 0) > 0 },
    // Right-click › Snap Grid
    ...SNAP.flatMap(([k, size]) => (['X', 'Y'] as const).map((axis): Command => ({
      id: `ad:PCB:PopupSnapGrid${axis}${k}`, label: k.endsWith('Mil') ? `${k.slice(0, -3)} Mil` : `${(Number(k.slice(0, -2)) / 1000).toFixed(3)} mm`, scopes: ['pcb', 'pcblib'],
      run: () => anyPcb()?.setGrid(size), enabled: () => !!anyPcb(), checked: () => anyPcb()?.gridSize() === size,
    }))),
    ...['ad:PCB:PopupSnapGridOther', 'ad:PCB:PopupSnapGridXOther', 'ad:PCB:PopupSnapGridYOther'].map((id): Command => ({
      id, label: id.endsWith('Other') && id.includes('Grid') && !/[XY]Other$/.test(id) ? 'Set Global Snap Grid...' : 'Set Snap Grid...', scopes: ['pcb', 'pcblib'], enabled: () => !!anyPcb(),
      run: () => { const e = anyPcb(); if (e) askLength('Snap Grid', 'Snap grid', e.gridSize(), (v) => { if (v > 0) { e.setGrid(v); notify(`Snap grid ${formatCoord(v, units.value)}`); } }); },
    })),
    // Schematic library tools
    { id: 'ad:Sch:ModelManager', label: 'Model Manager...', scopes: SCHLIB, enabled: hasS, run: () => { const e = slib(); if (e) showDialog(ModelManagerDialog, { ed: e }); } },
    { id: 'ad:SchLib:ParameterManagement', label: 'Parameter Manager...', scopes: SCHLIB, enabled: hasS, run: () => {
      const e = slib();
      if (!e) return;
      const syms = e.lib.symbols;
      showDialog(ParameterManagerDialog, {
        project: null, library: e.lib.name, sheets: syms.map((s, i) => ({ name: String(i), doc: e.peek(s) })),
        edit: (sheet: string, label: string, build: Parameters<typeof e.editSymbols>[1][number]['build']) => {
          const sym = syms[Number(sheet)];
          return !!sym && e.editSymbols(label, [{ sym, build }]) > 0;
        },
      });
    } },
    { id: 'ad:SchLib:ConfigurePinSwap', label: 'Configure Pin Swapping...', scopes: SCHLIB, enabled: hasS, run: () => { const e = slib(); if (e) showDialog(PinSwapDialog, { ed: e, pinKey: 'SWAPIDGROUP' as const }); } },
    { id: 'ad:Sch:SetupArrayPlacement', label: 'Paste Array...', scopes: SCHLIB, enabled: () => !!slib() && clipboard?.kind === 'sch', run: () => {
      const e = slib(), clip = clipboard;
      if (!e || clip?.kind !== 'sch' || !clip.items.length) { notify('Copy something first: Paste Array places copies of the clipboard', 'error'); return; }
      const u = units.value;
      showDialog(PromptDialog, {
        title: 'Setup Paste Array',
        fields: [{ label: 'Item Count', value: '8' }, { label: 'Primary Increment', value: '1' }, { label: 'Secondary Increment', value: '1' },
          { label: `Horizontal Spacing (${u})`, value: '0' }, { label: `Vertical Spacing (${u})`, value: formatCoord(-10 * SCH_UNIT, u).replace(/[a-z]+$/, '') }],
        onOk: ([n, p, s, dx, dy]: string[]) => {
          const len = (v: string | undefined) => parseLength(/^\s*-?[\d.]+\s*$/.test(v ?? '') ? `${(v ?? '').trim()}${u}` : v ?? '') ?? 0;
          const arr = lineClip(clip, Number(n) || 1, { x: Math.round(len(dx)), y: Math.round(len(dy)) }, Number(p) || 0, Number(s) || 0);
          e.setTool(new SchPasteTool(e, arr, false, { id: 'paste-array', what: `${Number(n) || 1} copies`, once: true }));
        },
      });
    } },
    // Tools › Library Splitter Wizard
    { id: 'ad:WorkspaceManager:SplitLibrary', label: 'Library Splitter Wizard...', scopes: [...SCHLIB, ...PCBLIB], enabled: () => !!slib() || !!plib(), run: () => {
      const s = slib(), p = plib();
      const files = s ? splitSchLib(s.lib) : p ? splitPcbLib(p.lib) : [];
      if (!files.length) return;
      void deliverSplit((s?.lib.name ?? p?.lib.name)!, files).then(() => { tick.value++; });
    } },
  ];
}
