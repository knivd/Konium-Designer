/**
 * The library editors' Reports and transfer tools, as Altium Designer 17 has them:
 * schematic library — Reports › Component, Library List, Library Report, Component Rule Check;
 * Tools › Copy Component, Move Component, Remove Duplicates. PCB library — the same reports,
 * Copy / Paste Component, Place Component, Update PCB With Current / All Footprints and
 * Library Options.
 */
import { locale } from '../core/locale';
import type { Command, Scope } from '../core/commands';
import type { LibSymbol } from '../formats/altium/schlib';
import type { Footprint } from '../formats/altium/pcblib';
import type { PcbRawRecord } from '../formats/altium/framing';
import { SchLibEditor } from '../editors/sch/SchLibEditor';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { currentSymbols } from '../model/schLib';
import { footprintRecords } from '../model/pcbLib';
import { swapFootprint } from '../model/pcbEco';
import { layerName } from '../model/layers';
import { libraryList, schComponentReport } from '../model/libCheck';
import { formatCoord } from '../core/units';
import { active, activeId, docs, notify, projects, replaceMessages, tick, units, type OpenDoc, type Project } from './state';
import { openDocument } from './actions';
import { whenMounted } from './project';
import { placeComponent } from './placeCommands';
import { showDialog } from './dialogs';
import { ConfirmDialog } from './dialogs/Confirm';
import { ReportDialog } from './dialogs/Hierarchy';
import { DestinationLibraryDialog, PcbLibReportDialog, PcbRuleCheckDialog, SchLibReportDialog, SchRuleCheckDialog } from './dialogs/LibTools';
import { PcbLibOptionsDialog } from './dialogs/LibOptions';

const SCHLIB: Scope[] = ['schlib'];
const PCBLIB: Scope[] = ['pcblib'];
const slib = () => { const e = active.value?.editor; return e instanceof SchLibEditor ? e : null; };
const plib = () => { const e = active.value?.editor; return e instanceof PcbLibEditor ? e : null; };
const odOf = (e: unknown): OpenDoc | null => docs.value.find((d) => d.editor === e) ?? null;
const projectOf = (od: OpenDoc | null): Project | null => (od?.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null);
const stem = (n: string) => n.replace(/\.[^.]+$/, '');
const report = (title: string, name: string, text: string, e: unknown) => showDialog(ReportDialog, { title, name, text, project: projectOf(odOf(e)) });

/* ─── Schematic library: copy and move between libraries ──────────────────────────── */

/** Other schematic libraries in reach: open ones and the project's. */
function otherSchLibs(e: SchLibEditor): string[] {
  const self = odOf(e);
  const names = new Set<string>();
  for (const d of docs.value) if (d.doc.kind === 'SchLib' && d !== self) names.add(d.name);
  const p = projectOf(self);
  if (p) for (const f of p.files.values()) if (/\.schlib$/i.test(f.name) && f.name.toLowerCase() !== self?.name.toLowerCase()) names.add(f.name);
  return [...names];
}
function openSchLib(name: string, from: SchLibEditor): SchLibEditor | null {
  const self = odOf(from);
  const open = docs.value.find((d) => d.name.toLowerCase() === name.toLowerCase() && d.doc.kind === 'SchLib');
  if (open?.editor instanceof SchLibEditor) return open.editor;
  const p = projectOf(self);
  const f = p?.files.get(name.toLowerCase());
  const od = f && p ? openDocument(f, p.id, false) : null;
  return od?.editor instanceof SchLibEditor ? od.editor : null;
}
function transfer(e: SchLibEditor, move: boolean): void {
  const sym = currentSymbols(e.lib)[e.current];
  const orig = e.symbol;
  if (!sym || !orig) return;
  if (move && e.lib.symbols.length < 2) { notify('A library keeps at least one component: copy it instead', 'error'); return; }
  showDialog(DestinationLibraryDialog, {
    title: move ? 'Move Component' : 'Copy Component', libraries: otherSchLibs(e),
    onOk: (name: string) => {
      const t = openSchLib(name, e);
      if (!t) { notify(`${name} couldn't be opened`, 'error'); return; }
      const [added] = t.insertSymbols([sym], `${move ? 'Move' : 'Copy'} ${sym.libRef} from ${e.lib.name}`);
      if (move) e.removeSymbols([orig], `Move ${sym.libRef} to ${name}`);
      tick.value++;
      notify(`${sym.libRef} ${move ? 'moved' : 'copied'} to ${name}${added && added.libRef !== sym.libRef ? ` as ${added.libRef}` : ''}`);
    },
  });
}
function removeDuplicates(e: SchLibEditor): void {
  const seen = new Set<string>();
  const dups: LibSymbol[] = [];
  for (const s of e.lib.symbols) { const k = s.libRef.toLowerCase(); if (seen.has(k)) dups.push(s); else seen.add(k); }
  if (!dups.length) { notify('No duplicate component names'); return; }
  showDialog(ConfirmDialog, {
    title: 'Remove Duplicates', message: `Remove ${dups.length} duplicate component${dups.length === 1 ? '' : 's'} (the first of each name stays)?`,
    detail: [...new Set(dups.map((s) => s.libRef))].join(', '),
    onYes: () => { e.removeSymbols(dups, `Remove ${dups.length} duplicate component${dups.length === 1 ? '' : 's'}`); tick.value++; },
  });
}

/* ─── PCB library ───────────────────────────────────────────────────────────────────── */

/** The footprint shown, as the board side sees a library footprint. */
function shownFootprint(e: PcbLibEditor): Footprint {
  const x = e.entry;
  return { name: x.name, storage: x.storage ?? '', description: x.description, height: x.height, records: footprintRecords(x.doc), prims: x.doc.prims };
}

function pcbComponentReport(e: PcbLibEditor): string {
  const f = e.entry, u = units.value, prims = f.doc.prims;
  const pts = prims.flatMap((p) => ('at' in p ? [p.at] : 'a' in p ? [p.a, p.b] : 'c' in p ? [p.c] : 'outline' in p ? p.outline : []));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const dim = pts.length ? `${formatCoord(Math.max(...xs) - Math.min(...xs), u)} x ${formatCoord(Math.max(...ys) - Math.min(...ys), u)}` : '0 x 0';
  const layers = [...new Set(prims.map((p) => ('layer' in p ? p.layer : -1)).filter((l) => l >= 0))];
  const kinds = ['pad', 'track', 'fill', 'arc', 'text', 'region'] as const;
  const col = (s: string, n: number) => (s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length));
  const when = new Date();
  const lines = [`Component : ${f.name}`, `Date      : ${when.toLocaleDateString(locale())}`, `Time      : ${when.toLocaleTimeString(locale())}`, '',
    `Dimension : ${dim}`, `Layer(s)  : ${layers.map((l) => layerName(l)).join(', ')}`, '', `${col('Layer', 22)}${kinds.map((k) => col(`${k[0]!.toUpperCase()}${k.slice(1)}s`, 9)).join('')}`];
  for (const l of layers) lines.push(`${col(layerName(l), 22)}${kinds.map((k) => col(String(prims.filter((p) => p.kind === k && 'layer' in p && p.layer === l).length), 9)).join('')}`);
  lines.push(`${col('Total', 22)}${kinds.map((k) => col(String(prims.filter((p) => p.kind === k).length), 9)).join('')}`);
  return `${lines.join('\r\n')}\r\n`;
}

let clip: { name: string; description: string; height: string; records: PcbRawRecord[] } | null = null;

/** Update PCB With Current / All Footprints: open boards' components using these footprints take them as they are now. */
function updatePcbs(e: PcbLibEditor, all: boolean): void {
  const fps = all ? e.lib.footprints.map((_, i) => i) : [e.current];
  const library = e.lib.name;
  let parts = 0, boards = 0;
  const msgs: { doc: string; level: 'info'; message: string }[] = [];
  for (const d of docs.value) {
    const ed = d.editor;
    if (!(ed instanceof PcbEditor) || ed instanceof PcbLibEditor) continue;
    const swaps: { index: number; f: Footprint }[] = [];
    for (const i of fps) {
      const x = e.lib.footprints[i]!;
      const f: Footprint = { name: x.name, storage: x.storage ?? '', description: x.description, height: x.height, records: footprintRecords(x.doc), prims: x.doc.prims };
      for (const c of ed.doc.components) if (c.pattern.toLowerCase() === x.name.toLowerCase()) swaps.push({ index: c.index, f });
    }
    if (!swaps.length) continue;
    ed.undo.transact(`Update ${swaps.length} footprint${swaps.length === 1 ? '' : 's'} from ${library}`, (tx) => { for (const s of swaps) tx.add(swapFootprint(ed.doc, s.index, { library, footprint: s.f })); });
    ed.invalidate();
    parts += swaps.length; boards++;
    for (const s of swaps) msgs.push({ doc: d.name, level: 'info', message: `Updated ${ed.doc.components[s.index]?.designator ?? '?'} with ${s.f.name}` });
  }
  replaceMessages('Update PCB With Footprints', [...msgs, { doc: library, level: 'info', message: `${parts} component${parts === 1 ? '' : 's'} updated on ${boards} open board${boards === 1 ? '' : 's'}` }]);
  notify(parts ? `${parts} component${parts === 1 ? '' : 's'} updated on ${boards} board${boards === 1 ? '' : 's'}` : 'No open board uses this footprint', parts ? 'ok' : 'error');
}

/** Place Component: the footprint shown onto the project's board (or any open board), on the cursor. */
function placeOnBoard(e: PcbLibEditor): void {
  const self = odOf(e);
  const boards = docs.value.filter((d) => d.editor instanceof PcbEditor && !(d.editor instanceof PcbLibEditor));
  const target = boards.find((d) => self && d.projectId === self.projectId) ?? boards[0];
  if (!target?.editor) { notify('Open a board to place the component on', 'error'); return; }
  const f = shownFootprint(e);
  activeId.value = target.id;
  whenMounted(target.editor, () => placeComponent({ library: e.lib.name, footprint: f }, 'Designator1', 'Comment'));
}

export function libToolCommands(): Command[] {
  const s = (id: string, label: string, run: (e: SchLibEditor) => void, enabled: () => boolean = () => !!slib()): Command => ({ id, label, scopes: SCHLIB, run: () => { const e = slib(); if (e) run(e); }, enabled });
  const p = (id: string, label: string, run: (e: PcbLibEditor) => void, enabled: () => boolean = () => !!plib()): Command => ({ id, label, scopes: PCBLIB, run: () => { const e = plib(); if (e) run(e); }, enabled });
  const fps = (e: PcbLibEditor) => () => e.lib.footprints.map((f) => ({ name: f.name, description: f.description, height: f.height, prims: f.doc.prims }));
  return [
    s('ad:Sch:ReportComponent', 'Component', (e) => { const sym = currentSymbols(e.lib)[e.current]; if (sym) report('Component Report', `${stem(e.lib.name)}.cmp`, schComponentReport(sym), e); }),
    s('ad:Sch:ReportComponentLibrary', 'Library List', (e) => report('Library List', `${stem(e.lib.name)}.rep`, libraryList(e.lib.name, currentSymbols(e.lib).map((x) => ({ name: x.libRef, description: x.description }))), e)),
    s('ad:Sch:GenerateLibraryReport', 'Library Report...', (e) => showDialog(SchLibReportDialog, { libName: e.lib.name, symbols: () => currentSymbols(e.lib), project: projectOf(odOf(e)) })),
    s('ad:Sch:ComponentRuleCheck', 'Component Rule Check...', (e) => showDialog(SchRuleCheckDialog, { libName: e.lib.name, symbols: () => currentSymbols(e.lib), project: projectOf(odOf(e)) })),
    s('ad:Sch:CopyComponentToLibrary', 'Copy Component...', (e) => transfer(e, false)),
    s('ad:Sch:MoveComponentToLibrary', 'Move Component...', (e) => transfer(e, true), () => (slib()?.lib.symbols.length ?? 0) > 1),
    s('ad:Sch:RemoveDuplicateComponentNames', 'Remove Duplicates...', removeDuplicates),
    p('ad:PCB:ReportComponent', 'Component', (e) => report('Component Report', `${stem(e.lib.name)}.CMP`, pcbComponentReport(e), e)),
    p('ad:PCB:ReportLibrary', 'Library List', (e) => report('Library List', `${stem(e.lib.name)}.REP`, libraryList(e.lib.name, e.lib.footprints.map((f) => ({ name: f.name, description: f.description }))), e)),
    p('ad:PCB:GenerateLibraryReport', 'Library Report...', (e) => showDialog(PcbLibReportDialog, { libName: e.lib.name, footprints: fps(e), project: projectOf(odOf(e)) })),
    p('ad:PCB:ComponentRuleCheck', 'Component Rule Check...', (e) => showDialog(PcbRuleCheckDialog, { libName: e.lib.name, footprints: fps(e),
      current: () => ({ name: e.entry.name, prims: e.entry.doc.prims }), project: projectOf(odOf(e)) })),
    p('ad:PCB:CopyComponent', 'Copy Component', (e) => { const x = e.entry; clip = { name: x.name, description: x.description, height: x.height, records: footprintRecords(x.doc) }; notify(`Copied footprint ${x.name}`); }),
    p('ad:PCB:PasteComponent', 'Paste Component', (e) => { if (clip) e.insertFootprint(clip.name, clip.description, clip.height, clip.records); }, () => !!plib() && !!clip),
    p('ad:PCB:PlaceComponentFromLibraryEditor', 'Place Component...', placeOnBoard),
    p('ad:PCB:UpdateFootprintsFromLibrary', 'Update PCB With Current Footprint', (e) => updatePcbs(e, false)),
    p('ad:PCB:UpdateAllFootprintsFromLibrary', 'Update PCB With All Footprints', (e) => updatePcbs(e, true)),
    p('ad:PCB:LibraryOptions', 'Library Options...', (e) => showDialog(PcbLibOptionsDialog, { ed: e })),
    p('ad:PCB:PopupOptionsLibraryOptions', 'Library Options...', (e) => showDialog(PcbLibOptionsDialog, { ed: e })),
  ];
}
