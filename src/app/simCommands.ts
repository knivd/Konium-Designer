/**
 * Mixed Sim's commands: Design › Simulate › Mixed Sim (Analyses Setup, then the run); a
 * netlist's Simulate › Run Simulation and Analyses Setup; SimView's Abort Simulation, View
 * (Fit Document, Zoom In and Out), the chart tabs (+ and −), scrolling and Copy to Clipboard as
 * Text; the Simulation Sources toolbar's twelve sources; File › New › Mixed-Signal Simulation
 * (AdvancedSim Model, Netlist, Sub-Circuit); the netlist editor's Find, Find Next, Goto Line.
 */
import type { Command } from '../core/commands';
import type { AccelNode } from '../core/keymap';
import { registerMenuProvider } from './menus';
import { active, activeId, docs, markProjectDirty, notify, prefsPage, projects, showPrefs, type Project } from './state';
import { settings, updateSettings } from '../core/settings';
import { readVsSettings } from '../core/textOps';
import { activeProject } from './project';
import { readSimSettings, settingsItem, sweepables, writeSimSettings, type SimSettings } from '../sim/settings';
import { abortSimulation, projectSimInput, simRunning, simulateNetlistDoc, simulateProject } from './simRun';
import { showDialog } from './dialogs';
import { AnalysesSetupDialog } from './dialogs/AnalysesSetup';
import { activeSimData, axesOfPlot, axisOfWave, chartCsv, chartOf, chartText, chartWaves, panBy, panTo, plotFromCsv, rangeOf, scrollPlots, setRange, shiftCharts, simViewTick, touch, viewOf, waveClip, waveData, zoomAt, type VScroll, type WaveAt } from './simView';
import { AddWaveDialog } from './dialogs/AddWave';
import { AxisDialog, DocumentOptionsDialog, PlotOptionsDialog, WaveOptionsDialog, setAxis } from './dialogs/SimViewOptions';
import { ChooseListDialog } from './dialogs/ChooseList';
import { PromptDialog } from './dialogs/Confirm';
import { moveCursor, fftPlot, type CursorMove } from '../sim/measure';
import { defaultChart, type SimDataDocument } from '../sim/simData';
import { pickFileHandle, pickTextFile, saveFileAs } from '../platform/fs';
import { showPanel } from './dock/store';
import { textTarget } from './textTarget';
import { addNewDocument, cmdNewDocument, freshName, openBatch } from './actions';
import { LIVE_EXAMPLES, liveExampleBytes, liveExampleFile } from './liveExamples';
import { LiveExamplesDialog } from './dialogs/LiveExamples';
import { newSimText, writeSimText } from '../sim/simText';
import { placePart } from './placeCommands';
import { partRecords } from '../model/schPlace';
import { setSimParam } from '../model/simModels';
import { SIM_SOURCES_LIB, simSourceSymbols } from '../formats/synthetic/simLib';
import { againLive, contextDrop, contextKept, contextReads, contextTake, holdLive, live, liveSheet, liveSymbols, resetScopes, setLiveSpeed, startLive, stepLiveSpeed, stopLive } from './liveSim';
import { featureOn } from '../core/release';
import { selectionSketch, sketchNote } from './liveSelection';
import { writeSchDoc } from '../formats/altium/schdoc';
import { SchEditor } from '../editors/sch/SchEditor';

const sch = () => (active.value?.editor instanceof SchEditor && !active.value.editor.libraryMode ? active.value.editor : null);
const SCH = ['sch' as const];
const SIMVIEW = ['simview' as const];
const SIMTEXT = ['simtext' as const];

/** Analyses Setup for a project; OK keeps it in the project, then (when asked) runs. */
export function analysesSetup(p: Project | null, run: boolean): void {
  const s = readSimSettings(p?.prj);
  const input = projectSimInput(p, s);
  const signals = input?.netlist.signals ?? [];
  const sources = (input?.netlist.text ?? '').split('\n').map((l) => l.trim().split(/\s+/)[0] ?? '').filter((n) => /^[VI]/i.test(n));
  showDialog(AnalysesSetupDialog, {
    settings: s, signals, sources, parts: sweepables(input?.netlist.text ?? ''), sourceFrequencies: input?.netlist.sourceFrequencies ?? [],
    onOk: (next: SimSettings) => {
      if (p && settingsItem(next) !== settingsItem(readSimSettings(p.prj))) { writeSimSettings(p.prj, next); markProjectDirty(p); }
      if (run) void simulateProject(p, next);
    },
  });
}

/** The project a netlist document belongs to. */
const projectOfActive = (): Project | null => { const d = active.value; return d?.projectId ? projects.value.find((x) => x.id === d.projectId) ?? null : null; };

/* ─── Simulation Sources toolbar: AD's twelve presets ─── */
const SOURCES: [id: string, label: string, libRef: string, designator: string, params: [string, string][]][] = [
  ['p5', '+5 Volts DC', 'VSRC', '5Vpos', [['Value', '+5']]],
  ['n5', '-5 Volts DC', 'VSRC', '5Vneg', [['Value', '-5']]],
  ['p12', '+12 Volts DC', 'VSRC', '12Vpos', [['Value', '+12']]],
  ['n12', '-12 Volts DC', 'VSRC', '12Vneg', [['Value', '-12']]],
  ...([['sin1k', '1kHz', '1KHz'], ['sin10k', '10kHz', '10KHz'], ['sin100k', '100kHz', '100KHz'], ['sin1M', '1MHz', '1MHz']] as const).map(([id, label, f]) =>
    [id, `${label} Sine Wave`, 'VSIN', f, [['DC Magnitude', '0'], ['AC Magnitude', '1'], ['AC Phase', '0'], ['Offset', '0'], ['Amplitude', '1'], ['Frequency', f], ['Delay', '0'], ['Damping Factor', '0'], ['Phase', '0']]] as [string, string, string, string, [string, string][]]),
  ...([['pulse1k', '1kHz', '1KHz', '1u', '0.5ms', '1ms'], ['pulse10k', '10kHz', '10KHz', '100n', '50us', '100us'], ['pulse100k', '100kHz', '100KHz', '10n', '5us', '10us'], ['pulse1M', '1MHz', '1MHz', '1n', '0.5us', '1us']] as const).map(([id, label, des, edge, width, period]) =>
    [id, `${label} Pulse`, 'VPULSE', des, [['DC Magnitude', '0'], ['AC Magnitude', '1'], ['AC Phase', '0'], ['Initial Value', '0'], ['Pulsed Value', '1'], ['Time Delay', '0'], ['Rise Time', edge], ['Fall Time', edge], ['Pulse Width', width], ['Period', period], ['Phase Delay', '0']]] as [string, string, string, string, [string, string][]]),
];

function placeSource(libRef: string, designator: string, params: [string, string][]): void {
  if (!sch()) return;
  const sym = simSourceSymbols().find((x) => x.libRef === libRef)!;
  const lib = SIM_SOURCES_LIB.replace(/\.SchLib$/, '.IntLib');
  const items = partRecords({ libRef, bags: sym.bags }, lib, 1);
  for (const [k, v] of params) setSimParam(items, k, v);
  const des = items.find((it) => it.bag.int('RECORD', -1) === 34);
  des?.bag.set('TEXT', designator);
  placePart({ items, symbol: { libRef, description: sym.description, parts: 1, storage: '', bags: sym.bags }, library: lib });
}

const viewDo = (f: (d: SimDataDocument) => void) => () => { const d = activeSimData(); if (d) f(d); };
const hasChart = () => { const d = activeSimData(); return !!d && !!chartOf(d, d.active)?.p.x; };
const selectedWave = (): { d: SimDataDocument; k: number; at: WaveAt } | null => {
  const d = activeSimData();
  if (!d) return null;
  const at = viewOf(d).selected.get(d.active);
  return at && chartOf(d, d.active)?.c.plots[at.plot]?.[at.wave] ? { d, k: d.active, at } : null;
};
const hasWave = () => !!selectedWave();

/** Tools › Import Editor Settings from › Visual Studio: a .vssettings file's text editor font and colours, as Preferences › Text Editors. */
async function importVsSettings(): Promise<void> {
  const f = await pickTextFile('.vssettings,.xml');
  if (!f) return;
  try {
    const l = readVsSettings(f.text);
    updateSettings({
      ...(l.font ? { textFont: l.font } : {}), ...(l.size ? { textFontSize: Math.min(32, Math.max(8, l.size)) } : {}),
      textColours: 'custom', textBack: l.back ?? settings.textBack, textPlain: l.plain ?? settings.textPlain, textComment: l.comment ?? settings.textComment,
      textCard: l.card ?? settings.textCard, textDevice: l.device ?? settings.textDevice,
    });
    notify(`Text editor settings from ${f.name}${l.font ? `: ${l.font}${l.size ? ` ${l.size}px` : ''}` : ''}`);
  } catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); }
}

/** Wave › Remove Wave, Edit › Delete: the selected wave out of its plot (an emptied plot with it). */
function removeSelectedWave(): void {
  const s = selectedWave();
  if (!s) return;
  const c = chartOf(s.d, s.k)!.c;
  c.plots[s.at.plot]!.splice(s.at.wave, 1);
  if (!c.plots[s.at.plot]!.length && c.plots.length > 1) { c.plots.splice(s.at.plot, 1); c.plotOpts?.splice(s.at.plot, 1); }
  viewOf(s.d).selected.set(s.k, null); viewOf(s.d).cursors.set(s.k, {}); viewOf(s.d).filtered.set(s.k, false);
  touch(s.d);
}
/** The wave cut can go on this chart: its signals are this analysis's. */
const canPaste = (): boolean => { const d = activeSimData(), w = waveClip.value; const p = d && chartOf(d, d.active)?.p; return !!w && !!p?.x && !(waveData(p, w.expr) instanceof Error); };
/** Edit › Paste: the wave cut into the selected plot (the last one when none is); Insert: into a new plot below it. */
function pasteWave(own: boolean): void {
  const d = activeSimData(), w = waveClip.value;
  if (!d || !w) return;
  const c = chartOf(d, d.active)!.c;
  const at = viewOf(d).selected.get(d.active);
  const plot = at && c.plots[at.plot] ? at.plot : c.plots.length - 1;
  if (own || plot < 0) {
    const i = plot + 1;
    c.plots.splice(i, 0, [{ ...w }]);
    if (c.plotOpts) c.plotOpts.splice(i, 0, null);
    viewOf(d).selected.set(d.active, { plot: i, wave: 0 });
  } else {
    c.plots[plot]!.push({ ...w });
    viewOf(d).selected.set(d.active, { plot, wave: c.plots[plot]!.length - 1 });
  }
  touch(d);
}

/** Wave › Cursor A / B: on the selected wave (where it sits in view), or off again. */
function toggleCursor(n: 'a' | 'b'): void {
  const s = selectedWave();
  if (!s) { notify('Select a wave first (click its name)'); return; }
  const v = viewOf(s.d), cur = { ...(v.cursors.get(s.k) ?? {}) };
  if (cur[n] && cur[n]!.plot === s.at.plot && cur[n]!.wave === s.at.wave) delete cur[n];
  else { const [x0, x1] = rangeOf(s.d, s.k); cur[n] = { ...s.at, x: x0 + (x1 - x0) * (n === 'a' ? 0.33 : 0.66) }; }
  v.cursors.set(s.k, cur);
  simViewTick.value++;
}
/** Wave › Select Minimum / Maximum Point, Next Peak / Trough: cursor A (put on the selected wave when it isn't) moves. */
function cursorTo(how: CursorMove): void {
  const s = selectedWave();
  if (!s) { notify('Select a wave first (click its name)'); return; }
  const { p, c } = chartOf(s.d, s.k)!;
  const w = waveData(p, c.plots[s.at.plot]![s.at.wave]!.expr);
  if (w instanceof Error) return;
  const v = viewOf(s.d), cur = { ...(v.cursors.get(s.k) ?? {}) };
  const from = cur.a && cur.a.plot === s.at.plot && cur.a.wave === s.at.wave ? cur.a.x : rangeOf(s.d, s.k)[0];
  const how2 = viewOf(s.d).ac.get(s.k) ?? 'Magnitude';
  const ys = w.im ? Array.from(w.re, (re, i) => (how2 === 'Phase (°)' ? Math.atan2(w.im![i]!, re) : Math.hypot(re, w.im![i]!))) : w.re;
  const x = moveCursor(p.x!.values, ys, from, how);
  cur.a = { ...s.at, x };
  v.cursors.set(s.k, cur);
  // Keep the cursor in view
  const [x0, x1] = rangeOf(s.d, s.k);
  if (x < x0 || x > x1) { const w2 = x1 - x0; setRange(s.d, s.k, [x - w2 / 2, x + w2 / 2]); }
  simViewTick.value++;
}

/** A new chart on one of the run's analyses (its data), with these waves. */
function addChart(d: SimDataDocument, source: number, title: string, waves: string[]): void {
  d.charts.push({ ...defaultChart(d.plots[source]!, source, waves), title });
  d.active = d.charts.length - 1;
  touch(d);
}
const stem = (d: SimDataDocument) => d.name.replace(/\.[^.]+$/, '');
async function exportCsv(d: SimDataDocument, what: 'Chart' | 'Plot' | 'Waveform'): Promise<void> {
  const k = d.active, sel = viewOf(d).selected.get(k);
  if (what !== 'Chart' && !sel) { notify('Select a wave first (click its name)'); return; }
  const only = what === 'Chart' ? undefined : what === 'Plot' ? [{ plot: sel!.plot, wave: -1 }] : [sel!];
  const c = chartOf(d, k)!.c;
  const name = `${stem(d)} ${what === 'Waveform' ? c.plots[sel!.plot]![sel!.wave]!.expr.replace(/[\\/:*?"<>|]/g, '_') : c.title}.csv`;
  await saveFileAs(name, new TextEncoder().encode(chartCsv(d, k, only)));
}
/** Tools › Copy to Clipboard: the chart in front as a picture. */
async function copyImage(): Promise<void> {
  const svg = document.querySelector<SVGSVGElement>('.sv-plot svg');
  if (!svg) return;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const cs = getComputedStyle(document.documentElement);
  // The page's colours written in, so the picture looks as the chart does
  const css = `.sv-bg{fill:${cs.getPropertyValue('--field')}}.sv-frame{fill:none;stroke:${cs.getPropertyValue('--line-strong')}}.sv-grid{stroke:${cs.getPropertyValue('--line')}}.sv-grid.minor{stroke-dasharray:2 3}.sv-wave{fill:none;stroke-width:1.4}.sv-label{fill:${cs.getPropertyValue('--text-dim')};font:10.5px Arial}.sv-name{font:bold 11px Arial}.sv-cursor{display:none}.sv-mcursor line{stroke:#555;stroke-dasharray:4 2}.sv-mcursor circle{fill:none;stroke:#555}.sv-mcursor text{font:bold 11px Arial;fill:#555}`;
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = css;
  clone.prepend(style);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const w = svg.width.baseVal.value, h = svg.height.baseVal.value;
  const img = new Image();
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((ok, bad) => { img.onload = () => ok(); img.onerror = () => bad(new Error('the picture could not be drawn')); img.src = url; });
    const cv = document.createElement('canvas');
    cv.width = w * 2; cv.height = h * 2;
    const g = cv.getContext('2d')!;
    g.fillStyle = cs.getPropertyValue('--panel') || '#fff'; g.fillRect(0, 0, cv.width, cv.height);
    g.scale(2, 2); g.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((ok) => cv.toBlob(ok, 'image/png'));
    if (!blob) throw new Error('the picture could not be made');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    notify('Chart copied as a picture');
  } catch (e) { notify(`Couldn't copy the chart: ${(e as Error).message}`, 'error'); } finally { URL.revokeObjectURL(url); }
}

function newSimFile(stem: string, ext: string): void {
  const name = freshName(stem, ext);
  const od = addNewDocument(name, writeSimText(newSimText(name)), activeProject());
  if (od?.doc.kind === 'SimText') od.doc.dirty = true;
}

export function simCommands(): Command[] {
  return [
    { id: 'sim.mixedSim', label: 'Mixed Sim', scopes: SCH, run: () => analysesSetup(activeProject(), true), enabled: () => !!sch() && !simRunning.value },
    { id: 'sim.run', label: 'Run Simulation', scopes: SIMTEXT, run: () => void simulateNetlistDoc(), enabled: () => active.value?.doc.kind === 'SimText' && !simRunning.value },
    { id: 'sim.analysesSetup', label: 'Analyses Setup...', scopes: SIMTEXT, run: () => {
      const p = projectOfActive();
      if (!p) { notify('A netlist on its own runs the analyses its own lines ask for (.TRAN, .AC, .DC, .OP)'); return; }
      analysesSetup(p, false);
    } },
    { id: 'sim.abort', label: 'Abort Simulation', run: abortSimulation, enabled: () => simRunning.value },
    // Konium's: the sheet in front run as a circuit while it is drawn (its panel has the rest)
    { id: 'live.panel', label: 'Live Simulation', scopes: SCH, run: () => { if (!live.value) { showPanel('liveScope'); startLive(); } showPanel('liveSim'); }, enabled: () => !!sch() },
    { id: 'live.scope', label: 'Live Scope', scopes: SCH, run: () => showPanel('liveScope'), enabled: () => !!sch() },
    { id: 'live.examples', label: 'Live Simulation Examples...', run: () => showDialog(LiveExamplesDialog, { onOk: openLiveExample }) },
    // From anywhere (the menu bar's button): the running sheet brought in front, else the schematic in front run, else a new circuit
    { id: 'live.open', label: 'Live Simulation', run: openLive },
    { id: 'live.new', label: 'New Live Simulation Circuit', run: newLiveCircuit },
    { id: 'live.selection', label: 'Run the Selection as a Sketch', scopes: SCH, run: runSelection, enabled: () => { const ed = sch(); return !!ed && ed.selectedIndices().some((i) => ed.doc.objects[i]?.kind === 'component'); } },
    // The right-click menu of a running sheet: what was right-clicked (a wire, a pin, a two-pin part) watched
    { id: 'live.monitorWithContext', label: 'Monitor Here', scopes: SCH, run: () => { contextTake('monitor'); }, enabled: contextReads },
    { id: 'live.scopeWithContext', label: 'Add to the Scope', scopes: SCH, run: () => { if (contextTake('scope')) showPanel('liveScope'); }, enabled: contextReads },
    { id: 'live.newScopeWithContext', label: 'View in a New Scope', scopes: SCH, run: () => { if (contextTake('new')) showPanel('liveScope'); }, enabled: contextReads },
    { id: 'live.unmonitorWithContext', label: 'Stop Monitoring Here', scopes: SCH, run: contextDrop, enabled: contextKept },
    { id: 'live.start', label: 'Start Live Simulation', scopes: SCH, run: () => startLive(), enabled: () => !!sch() && !live.value },
    { id: 'live.stop', label: 'Stop Live Simulation', run: stopLive, enabled: () => !!live.value },
    { id: 'live.hold', label: 'Hold or Go On (Live Simulation)', run: () => holdLive(), enabled: () => !!live.value },
    { id: 'live.again', label: 'From the Start (Live Simulation)', run: againLive, enabled: () => !!live.value },
    { id: 'live.faster', label: 'Faster (Live Simulation)', run: () => stepLiveSpeed(1), enabled: () => !!live.value },
    { id: 'live.slower', label: 'Slower (Live Simulation)', run: () => stepLiveSpeed(-1), enabled: () => !!live.value },
    // SimView: View
    { id: 'simview.fit', label: 'Fit Document', scopes: SIMVIEW, run: viewDo((d) => setRange(d, d.active, null)), enabled: hasChart },
    { id: 'simview.zoomIn', label: 'Zoom In', scopes: SIMVIEW, run: viewDo((d) => zoomAt(d, d.active, 0.5)), enabled: hasChart },
    { id: 'simview.zoomOut', label: 'Zoom Out', scopes: SIMVIEW, run: viewDo((d) => zoomAt(d, d.active, 2)), enabled: hasChart },
    { id: 'simview.nextChart', label: 'Next', scopes: SIMVIEW, run: viewDo((d) => { if (d.charts.length) { d.active = (d.active + 1) % d.charts.length; simViewTick.value++; } }) },
    { id: 'simview.prevChart', label: 'Previous', scopes: SIMVIEW, run: viewDo((d) => { if (d.charts.length) { d.active = (d.active - 1 + d.charts.length) % d.charts.length; simViewTick.value++; } }) },
    { id: 'simview.panLeft', label: 'Horizontal Line Up', scopes: SIMVIEW, run: viewDo((d) => panBy(d, d.active, -0.1)), enabled: hasChart },
    { id: 'simview.panRight', label: 'Horizontal Line Down', scopes: SIMVIEW, run: viewDo((d) => panBy(d, d.active, 0.1)), enabled: hasChart },
    { id: 'simview.pageLeft', label: 'Horizontal Page Up', scopes: SIMVIEW, run: viewDo((d) => panBy(d, d.active, -1)), enabled: hasChart },
    { id: 'simview.pageRight', label: 'Horizontal Page Down', scopes: SIMVIEW, run: viewDo((d) => panBy(d, d.active, 1)), enabled: hasChart },
    { id: 'simview.panStart', label: 'Horizontal Top', scopes: SIMVIEW, run: viewDo((d) => panTo(d, d.active, false)), enabled: hasChart },
    { id: 'simview.panEnd', label: 'Horizontal Bottom', scopes: SIMVIEW, run: viewDo((d) => panTo(d, d.active, true)), enabled: hasChart },
    // Tools
    { id: 'simview.copyText', label: 'Copy to Clipboard as Text', scopes: SIMVIEW, run: viewDo((d) => { void navigator.clipboard?.writeText(chartText(d, d.active)).then(() => notify(`Copied ${d.charts[d.active]!.title} as text`), () => notify('The browser refused the clipboard', 'error')); }) },
    { id: 'simview.copyImage', label: 'Copy to Clipboard', scopes: SIMVIEW, run: () => void copyImage(), enabled: hasChart },
    { id: 'simview.store', label: 'Store Waveform...', scopes: SIMVIEW, enabled: hasWave, run: () => {
      const s = selectedWave()!;
      const { c, p } = chartOf(s.d, s.k)!;
      const w = c.plots[s.at.plot]![s.at.wave]!, v = waveData(p, w.expr);
      if (v instanceof Error) return;
      const n = (s.d.stored ?? []).filter((x) => x.name.startsWith(w.expr)).length + 1;
      showDialog(PromptDialog, { title: 'Store Waveform', fields: [{ label: 'Name', value: `${w.expr} (stored ${n})` }], onOk: ([name]: string[]) => {
        const nm = name?.trim();
        if (!nm) return;
        s.d.stored = [...(s.d.stored ?? []).filter((x) => x.name !== nm), { name: nm, analysis: p.analysis, x: Array.from(p.x!.values), re: Array.from(v.re), ...(v.im ? { im: Array.from(v.im) } : {}), unit: p.vectors.find((x) => x.name === w.expr)?.unit ?? '' }];
        touch(s.d);
        notify(`Stored ${nm}`);
      } });
    } },
    { id: 'simview.recall', label: 'Recall Waveform...', scopes: SIMVIEW, enabled: () => { const d = activeSimData(); const p = d && chartOf(d, d.active)?.p; return !!p?.x && !!d!.stored?.some((x) => x.analysis === p.analysis); }, run: viewDo((d) => {
      const { c, p } = chartOf(d, d.active)!;
      const list = (d.stored ?? []).filter((x) => x.analysis === p.analysis);
      showDialog(ChooseListDialog, { title: 'Recall Waveform', header: 'Stored waveform', items: list.map((x) => x.name), onOk: (i: number) => {
        const st = list[i]!;
        // Onto this chart's points (straight between the stored ones), as a signal of its own
        if (!p.vectors.some((v) => v.name === st.name)) {
          const at = (xs: number[], ys: number[], x: number) => { let j = 0; while (j < xs.length - 2 && xs[j + 1]! < x) j++; const f = (x - xs[j]!) / ((xs[j + 1] ?? xs[j]!) - xs[j]! || 1); return ys[j]! + f * ((ys[j + 1] ?? ys[j]!) - ys[j]!); };
          p.vectors.push({ name: st.name, unit: st.unit, re: Float64Array.from(p.x!.values, (x) => at(st.x, st.re, x)), ...(st.im ? { im: Float64Array.from(p.x!.values, (x) => at(st.x, st.im!, x)) } : {}) });
        }
        const sel = viewOf(d).selected.get(d.active);
        if (sel && c.plots[sel.plot]) c.plots[sel.plot]!.push({ expr: st.name }); else c.plots.push([{ expr: st.name }]);
        touch(d);
      } });
    }) },
    // Chart
    { id: 'simview.newChart', label: 'New Chart...', scopes: SIMVIEW, run: viewDo((d) => {
      const charts = d.plots.map((p, i) => [p, i] as const).filter(([p]) => !!p.x);
      if (!charts.length) return;
      showDialog(ChooseListDialog, { title: 'New Chart', header: 'Source data', items: charts.map(([p]) => p.title), onOk: (i: number) => { const [p, src] = charts[i]!; addChart(d, src, p.title, []); } });
    }) },
    { id: 'simview.deleteChart', label: 'Delete Chart', scopes: SIMVIEW, enabled: () => (activeSimData()?.charts.length ?? 0) > 1, run: viewDo((d) => { d.charts.splice(d.active, 1); shiftCharts(d, d.active, -1); d.active = Math.max(0, d.active - 1); touch(d); }) },
    { id: 'simview.duplicateChart', label: 'Duplicate Chart', scopes: SIMVIEW, enabled: hasChart, run: viewDo((d) => {
      const c = d.charts[d.active]!;
      d.charts.splice(d.active + 1, 0, { title: `${c.title} (copy)`, source: c.source, plots: c.plots.map((pl) => pl.map((w) => ({ ...w }))) });
      shiftCharts(d, d.active + 1, 1);
      // (the copy shows the same span and AC display)
      const v = viewOf(d), r = v.ranges.get(d.active), ac = v.ac.get(d.active);
      if (r) v.ranges.set(d.active + 1, [...r]);
      if (ac) v.ac.set(d.active + 1, ac);
      d.active++; touch(d);
    }) },
    { id: 'simview.sourceData', label: 'Source Data...', scopes: SIMVIEW, run: () => showPanel('simdata') },
    { id: 'simview.fft', label: 'Create FFT Chart', scopes: SIMVIEW, enabled: () => { const d = activeSimData(); return !!d && chartOf(d, d.active)?.p.analysis === 'tran' && chartWaves(chartOf(d, d.active)!.c).length > 0; }, run: viewDo((d) => {
      const { c, p } = chartOf(d, d.active)!;
      // The waves shown (signals and expressions alike), over the range in view
      const vals = chartWaves(c).map((w) => [w.expr, waveData(p, w.expr)] as const).filter(([, v]) => !(v instanceof Error));
      const src = { ...p, vectors: vals.map(([n, v]) => ({ name: n, unit: p.vectors.find((x) => x.name === n)?.unit ?? '', re: (v as { re: Float64Array }).re })) };
      const f = fftPlot(src, vals.map(([n]) => n), rangeOf(d, d.active));
      d.plots.push(f);
      addChart(d, d.plots.length - 1, f.title, vals.map(([n]) => n));
    }) },
    { id: 'simview.chartOptions', label: 'Chart Options...', scopes: SIMVIEW, enabled: () => !!activeSimData()?.charts.length, run: viewDo((d) => {
      const c = d.charts[d.active]!;
      showDialog(PromptDialog, { title: 'Chart Options', fields: [{ label: 'Chart Title', value: c.title }], onOk: ([t]: string[]) => { if (t?.trim()) { c.title = t.trim(); touch(d); } } });
    }) },
    // Plot
    { id: 'simview.newPlot', label: 'New Plot...', scopes: SIMVIEW, enabled: hasChart, run: viewDo((d) => showDialog(AddWaveDialog, { d, k: d.active, newPlot: true })) },
    { id: 'simview.deletePlot', label: 'Delete Plot', scopes: SIMVIEW, enabled: hasWave, run: () => {
      const s = selectedWave()!;
      const c = chartOf(s.d, s.k)!.c;
      c.plots.splice(s.at.plot, 1); c.plotOpts?.splice(s.at.plot, 1);
      viewOf(s.d).selected.set(s.k, null); viewOf(s.d).cursors.set(s.k, {});
      touch(s.d);
    } },
    // Wave
    { id: 'simview.addWave', label: 'Add Wave...', scopes: SIMVIEW, enabled: hasChart, run: viewDo((d) => showDialog(AddWaveDialog, { d, k: d.active })) },
    { id: 'simview.editWave', label: 'Edit Wave...', scopes: SIMVIEW, enabled: hasWave, run: () => { const s = selectedWave()!; showDialog(AddWaveDialog, { d: s.d, k: s.k, edit: s.at }); } },
    { id: 'simview.waveOptions', label: 'Wave Options...', scopes: SIMVIEW, enabled: hasWave, run: () => { const s = selectedWave()!; showDialog(WaveOptionsDialog, { d: s.d, k: s.k, plot: s.at.plot, wave: s.at.wave }); } },
    // Plot › Add / Remove / Format Y Axis: the selected wave on an axis of its own (on the right), back on the plot's, the axis formatted
    { id: 'simview.addYAxis', label: 'Add Y Axis', scopes: SIMVIEW, enabled: hasWave, run: () => {
      const s = selectedWave()!;
      const c = chartOf(s.d, s.k)!.c;
      const n = axesOfPlot(c, s.at.plot);
      c.plots[s.at.plot]![s.at.wave]!.axis = n;
      setAxis(s.d, s.k, s.at.plot, n, {});
      touch(s.d);
    } },
    { id: 'simview.removeYAxis', label: 'Remove Y Axis', scopes: SIMVIEW, enabled: () => { const s = selectedWave(); return !!s && axisOfWave(chartOf(s.d, s.k)!.c, s.at.plot, s.at.wave) > 0; }, run: () => {
      const s = selectedWave()!;
      const c = chartOf(s.d, s.k)!.c;
      const a = axisOfWave(c, s.at.plot, s.at.wave);
      for (const w of c.plots[s.at.plot]!) { const x = w.axis ?? 0; if (x === a) delete w.axis; else if (x > a) w.axis = x - 1; }
      c.plotOpts?.[s.at.plot]?.axes?.splice(a, 1);
      touch(s.d);
    } },
    { id: 'simview.yAxisSettings', label: 'Format Y Axis...', scopes: SIMVIEW, enabled: hasWave, run: () => {
      const s = selectedWave()!;
      showDialog(AxisDialog, { d: s.d, k: s.k, plot: s.at.plot, axis: axisOfWave(chartOf(s.d, s.k)!.c, s.at.plot, s.at.wave) });
    } },
    { id: 'simview.plotOptions', label: 'Plot Options...', scopes: SIMVIEW, enabled: hasWave, run: () => { const s = selectedWave()!; showDialog(PlotOptionsDialog, { d: s.d, k: s.k, plot: s.at.plot }); } },
    { id: 'simview.documentOptions', label: 'Document Options...', scopes: SIMVIEW, enabled: () => !!activeSimData(), run: viewDo((d) => showDialog(DocumentOptionsDialog, { d })) },
    { id: 'simview.brightness', label: 'Brightness...', scopes: SIMVIEW, enabled: () => !!activeSimData(), run: viewDo((d) => showDialog(DocumentOptionsDialog, { d, brightnessOnly: true })) },
    { id: 'simview.removeWave', label: 'Remove Wave', scopes: SIMVIEW, enabled: hasWave, run: removeSelectedWave },
    // Edit › Cut, Paste, Insert, Delete: the selected wave through SimView's own clipboard [est: Insert puts it in a plot of its own]
    { id: 'ad:SimView:Cut', label: 'Cut', scopes: SIMVIEW, enabled: hasWave, run: () => { const s = selectedWave()!; waveClip.value = { ...chartOf(s.d, s.k)!.c.plots[s.at.plot]![s.at.wave]! }; removeSelectedWave(); } },
    { id: 'ad:SimView:Paste', label: 'Paste', scopes: SIMVIEW, enabled: canPaste, run: () => pasteWave(false) },
    { id: 'ad:SimView:InsertCell', label: 'Insert', scopes: SIMVIEW, enabled: canPaste, run: () => pasteWave(true) },
    { id: 'ad:SimView:Delete', label: 'Delete', scopes: SIMVIEW, enabled: hasWave, run: removeSelectedWave },
    { id: 'ad:SimView:ClearFilter', label: 'Clear Filter', scopes: SIMVIEW, enabled: () => { const d = activeSimData(); return !!d && !!viewOf(d).filtered.get(d.active); },
      run: viewDo((d) => { viewOf(d).filtered.set(d.active, false); simViewTick.value++; }) },
    // Scroll View › Vertical: the plots, when there are more than fit
    ...([['Top', 'top'], ['Bottom', 'bottom'], ['Lineup', 'lineUp'], ['LineDown', 'lineDown'], ['Pageup', 'pageUp'], ['PageDown', 'pageDown']] as const).map(([id, how]): Command =>
      ({ id: `ad:SimView:ScrollVertical${id}`, label: `Vertical ${id.replace(/([a-z])([A-Z])/, '$1 $2').replace('Lineup', 'Line Up').replace('Pageup', 'Page Up')}`, scopes: SIMVIEW, enabled: hasChart, run: viewDo((d) => { scrollPlots(d, how as VScroll); }) })),
    { id: 'simview.cursorA', label: 'Cursor A', scopes: SIMVIEW, enabled: hasWave, run: () => toggleCursor('a'), checked: () => { const s = selectedWave(); const a = s && viewOf(s.d).cursors.get(s.k)?.a; return !!a && a.plot === s!.at.plot && a.wave === s!.at.wave; } },
    { id: 'simview.cursorB', label: 'Cursor B', scopes: SIMVIEW, enabled: hasWave, run: () => toggleCursor('b'), checked: () => { const s = selectedWave(); const b = s && viewOf(s.d).cursors.get(s.k)?.b; return !!b && b.plot === s!.at.plot && b.wave === s!.at.wave; } },
    ...([['Min', 'min', 'Select Minimum Point'], ['Max', 'max', 'Select Maximum Point'], ['PeakRight', 'peakRight', 'Select Next Peak: Right'], ['PeakLeft', 'peakLeft', 'Select Next Peak: Left'],
      ['TroughRight', 'troughRight', 'Select Next Trough: Right'], ['TroughLeft', 'troughLeft', 'Select Next Trough: Left']] as const).map(([id, how, label]): Command =>
      ({ id: `simview.cursor${id}`, label, scopes: SIMVIEW, enabled: hasWave, run: () => cursorTo(how) })),
    // File
    { id: 'simview.exportChart', label: 'Chart', scopes: SIMVIEW, enabled: () => !!activeSimData()?.charts.length, run: viewDo((d) => void exportCsv(d, 'Chart')) },
    { id: 'simview.exportPlot', label: 'Plot', scopes: SIMVIEW, enabled: hasWave, run: viewDo((d) => void exportCsv(d, 'Plot')) },
    { id: 'simview.exportWave', label: 'Waveform', scopes: SIMVIEW, enabled: hasWave, run: viewDo((d) => void exportCsv(d, 'Waveform')) },
    { id: 'simview.import', label: 'Import...', scopes: SIMVIEW, run: viewDo((d) => void (async () => {
      const f = await pickFileHandle(['.csv', '.txt'], 'Waveforms (CSV)', 'konium-waves');
      if (!f) return;
      try {
        const p = plotFromCsv(new TextDecoder().decode(f.bytes), f.name.replace(/\.[^.]+$/, ''));
        if (!p.vectors.length || !p.x!.values.length) throw new Error('no columns of numbers');
        d.plots.push(p);
        addChart(d, d.plots.length - 1, p.title, p.vectors.map((v) => v.name));
      } catch (e) { notify(`Couldn't import ${f.name}: ${(e as Error).message}`, 'error'); }
    })()) },
    // The Simulation Sources toolbar
    ...SOURCES.map(([id, label, libRef, des, params]): Command => ({ id: `sim.source.${id}`, label, scopes: SCH, run: () => placeSource(libRef, des, params), enabled: () => !!sch() })),
    // File › New › Mixed-Signal Simulation [est: the new files' names]
    { id: 'file.newSimModel', label: 'AdvancedSim Model', run: () => newSimFile('Model', 'mdl') },
    { id: 'file.newSimNetlist', label: 'AdvancedSim Netlist', run: () => newSimFile('Netlist', 'nsx') },
    { id: 'file.newSimSubcircuit', label: 'AdvancedSim Sub-Circuit', run: () => newSimFile('Subcircuit', 'ckt') },
    // The netlist editor
    { id: 'text.find', label: 'Find...', scopes: SIMTEXT, run: () => textTarget()?.find(), enabled: () => !!textTarget() },
    { id: 'text.findNext', label: 'Find Next', scopes: SIMTEXT, run: () => textTarget()?.findNext(), enabled: () => !!textTarget() },
    { id: 'text.gotoLine', label: 'Goto Line Number...', scopes: SIMTEXT, run: () => textTarget()?.gotoLine(), enabled: () => !!textTarget() },
    // The text editor's Edit, Tools and Window menus
    { id: 'ad:TextEdit:FindAndReplace', label: 'Replace...', scopes: SIMTEXT, run: () => textTarget()?.replace(), enabled: () => !!textTarget() },
    { id: 'ad:TextEdit:FindNextSelected', label: 'Find Next Selected', scopes: SIMTEXT, run: () => textTarget()?.findNextSelected(), enabled: () => !!textTarget() },
    { id: 'ad:TextEdit:Clear', label: 'Clear', scopes: SIMTEXT, run: () => textTarget()?.clear(), enabled: () => !!textTarget() },
    { id: 'ad:TextEdit:ClearBrowserMarks', label: 'Clear Browser Marks', scopes: SIMTEXT, run: () => textTarget()?.clearMarks(), enabled: () => !!textTarget()?.hasMarks() },
    { id: 'ad:TextEdit:IndentTextBlock', label: 'Indent', scopes: SIMTEXT, run: () => textTarget()?.indent(false), enabled: () => !!textTarget() },
    { id: 'ad:TextEdit:UnindentTextBlock', label: 'Unindent', scopes: SIMTEXT, run: () => textTarget()?.indent(true), enabled: () => !!textTarget() },
    ...([['Selected', 'selection'], ['Word', 'word']] as const).flatMap(([w, what]) => ([['UpperCase', 'upper'], ['LowerCase', 'lower'], ['Capitalize', 'capitalise']] as const).map(([c, how]): Command =>
      ({ id: `ad:TextEdit:Set${w}To${c}`, label: `${what === 'word' ? 'Word' : 'Selection'} To ${c === 'Capitalize' ? 'Capitalised' : c === 'UpperCase' ? 'Upper Case' : 'Lower Case'}`, scopes: SIMTEXT,
        run: () => textTarget()?.changeCase(what, how), enabled: () => !!textTarget() }))),
    { id: 'ad:TextEdit:ShowCodeTemplates', label: 'Show Code Templates', scopes: SIMTEXT, run: () => textTarget()?.templates(), enabled: () => !!textTarget() },
    ...([['None', 'none'], ['AtWindow', 'window'], ['AtMargin', 'margin']] as const).map(([id, w]): Command =>
      ({ id: `ad:TextEdit:WordWrap${id}`, label: id.replace('At', 'At '), scopes: SIMTEXT, run: () => updateSettings({ textWordWrap: w }), checked: () => settings.textWordWrap === w })),
    { id: 'ad:TextEdit:SplitEditorVertically', label: 'Split Vertically', scopes: SIMTEXT, run: () => textTarget()?.split('vertical'), enabled: () => !!textTarget(), checked: () => textTarget()?.splitMode() === 'vertical' },
    { id: 'ad:TextEdit:SplitEditorHorizontally', label: 'Split Horizontally', scopes: SIMTEXT, run: () => textTarget()?.split('horizontal'), enabled: () => !!textTarget(), checked: () => textTarget()?.splitMode() === 'horizontal' },
    { id: 'ad:TextEdit:CombineEditors', label: 'Remove Split', scopes: SIMTEXT, run: () => textTarget()?.split('none'), enabled: () => !!textTarget() && textTarget()!.splitMode() !== 'none' },
    { id: 'ad:TextEdit:SetupPreferences', label: 'Editor Preferences...', scopes: SIMTEXT, run: () => { prefsPage.value = 'text-general'; showPrefs.value = true; } },
    { id: 'ad:TextEdit:ImportEditorSettingsFromVisualStudio', label: 'Visual Studio...', scopes: SIMTEXT, run: () => void importVsSettings() },
  ];
}

/** An example opened as a schematic of its own (or brought in front if it is open) and run, its test points on the scopes. */
export function openLiveExample(id: string): void {
  const ex = LIVE_EXAMPLES.find((e) => e.id === id);
  if (!ex) return;
  const name = liveExampleFile(ex), find = () => docs.value.find((d) => d.name === name && !d.projectId);
  if (!find()) openBatch([{ name, bytes: liveExampleBytes(ex, liveSymbols.value) }]);
  const d = find();
  if (!d) return;
  activeId.value = d.id;
  stopLive();
  resetScopes();
  // Once the sheet is in its window: the panels, the run, and the circuit filling the view
  requestAnimationFrame(() => {
    if (active.value?.id !== d.id) return;
    showPanel('liveScope');
    startLive(!!ex.zero);
    if (ex.speed) setLiveSpeed(ex.speed);
    showPanel('liveSim');
    requestAnimationFrame(() => active.value?.id === d.id && active.value.editor?.fitObjects());
  });
}

/**
 * What is selected on the sheet in front taken to a schematic of its own and run there (see liveSelection): a part of a
 * design on the bench, with rails for the supplies its power ports name.
 */
function runSelection(): void {
  const ed = active.value?.editor;
  if (!(ed instanceof SchEditor) || ed.libraryMode) return;
  const picked = ed.selectedIndices();
  if (!picked.some((i) => ed.doc.objects[i]?.kind === 'component')) { notify('Select the part of the circuit to run first: its parts, wires and power ports', 'error'); return; }
  const base = ed.doc.name.replace(/\.schdoc$/i, '');
  let name = `${base} selection.SchDoc`;
  for (let n = 2; docs.value.some((d) => d.name.toLowerCase() === name.toLowerCase()); n++) name = `${base} selection ${n}.SchDoc`;
  const sketch = selectionSketch(ed.doc, picked, name);
  openBatch([{ name, bytes: writeSchDoc(sketch.doc) }]);
  const d = docs.value.find((x) => x.name === name && !x.projectId);
  if (!d) return;
  activeId.value = d.id;
  stopLive();
  requestAnimationFrame(() => {
    if (active.value?.id !== d.id) return;
    showPanel('liveScope');
    startLive();
    showPanel('liveSim');
    notify(sketchNote(sketch), 'ok', 9000);
    requestAnimationFrame(() => active.value?.id === d.id && active.value.editor?.fitObjects());
  });
}

/** A blank sheet of its own for a sketch (in no project), running, with the palette beside it. Nothing that is open is touched. */
export function newLiveCircuit(): void {
  cmdNewDocument('SchDoc', null);
  const d = active.value;
  if (!d || !sch()) return;
  stopLive();
  resetScopes();
  requestAnimationFrame(() => {
    if (active.value?.id !== d.id) return;
    showPanel('liveScope');
    startLive();
    showPanel('liveSim');
  });
}
/** Live Simulation from anywhere: the sheet that runs brought in front; else the schematic in front run as it is; else a new circuit. */
export function openLive(): void {
  const running = liveSheet(), at = running && docs.value.find((d) => d.editor === running);
  if (at) { activeId.value = at.id; requestAnimationFrame(() => showPanel('liveSim')); return; }
  if (!sch()) { newLiveCircuit(); return; }
  showPanel('liveScope');
  startLive();
  showPanel('liveSim');
}

/** Design › Simulate: the project's simulators (Mixed Sim, Live Simulation and its examples). */
registerMenuProvider('@simulators', (): AccelNode[] => [{ key: 'M', label: 'Mixed Sim', command: 'sim.mixedSim' }, ...(featureOn('live') ? [{ key: 'L', label: 'Live Simulation', command: 'live.panel' }, { key: 'N', label: 'New Live Simulation Circuit', command: 'live.new' }, { key: 'E', label: 'Live Simulation Examples...', command: 'live.examples' }, { key: 'S', label: 'Run the Selection as a Sketch', command: 'live.selection' }] : [])]);

/** Open documents a run made (for tests). */
export const simDocs = () => docs.value.filter((d) => d.doc.kind === 'SimData' || d.doc.kind === 'SimText');
