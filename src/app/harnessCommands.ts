/**
 * Place › Harness: Harness Connector (two corners), Harness Entry (along the connector's entry
 * side, names step on), Signal Harness (a click per vertex), Predefined Harness Connector (a
 * type already in the project, with its entries), Place Harness Connector For Type (the type
 * of the right-clicked port, sheet entry, harness or entry); Project › Harness Definition
 * Problem Finder; Reports › Harness Wire List (a harness wiring diagram's wires, lengths from the
 * project's layout drawing).
 */
import type { Command } from '../core/commands';
import type { PropertyBag } from '../formats/altium/props';
import { SchEditor } from '../editors/sch/SchEditor';
import { SchShapeTool } from '../editors/sch/SchShapeTool';
import { SchPasteTool } from '../editors/sch/SchPasteTool';
import { SheetEntryTool } from '../editors/sch/SheetEntryTool';
import { harnessConnectorItems, harnessDefinitions, harnessEntryBag, harnessSlot, harnessType, isHarness, signalHarnessBag } from '../model/schHarness';
import { showDialog } from './dialogs';
import { SchObjectDialog } from './dialogs/SchObjectProps';
import { HarnessDefinitionsDialog, PickHarnessTypeDialog } from './dialogs/Harness';
import { activeProject, projectSheets } from './project';
import { active, docs, notify, projects, type OpenDoc } from './state';
import type { SchDocument } from '../model/sch';
import { harnessKind, wireList } from '../model/harness';
import { readSchDoc } from '../formats/altium/schdoc';
import { HarnessWireListDialog } from './dialogs/HarnessWireList';
import { autoNext } from './increment';
import { settings } from '../core/settings';
import { capture, onSchDefaults, schKind, setSchDefault, withDefault } from '../model/schDefaults';
import { defaulted } from './placeCommands';

const sheet = () => { const e = active.value?.editor; return e instanceof SchEditor && !e.libraryMode ? e : null; };

let entryTemplate: PropertyBag | null = null;
// Preferences › Default Primitives › Edit Values or Reset: the next entry starts from the default again
onSchDefaults((name) => { if (!name || name === 'Harness Entry') entryTemplate = null; });

/** The active harness document (wiring diagram or layout drawing). */
function harnessDoc(): OpenDoc | null {
  const od = active.value;
  return od?.doc.kind === 'SchDoc' && harnessKind(od.doc as SchDocument) ? od : null;
}
/** A harness project's other drawing of the given kind: open, else read from the project's files. */
function partner(od: OpenDoc, kind: 'wiring' | 'layout'): SchDocument | null {
  const self = od.doc as SchDocument;
  if (harnessKind(self) === kind) return self;
  const open = docs.value.find((d) => d.doc.kind === 'SchDoc' && (d.projectId ?? null) === (od.projectId ?? null) && harnessKind(d.doc as SchDocument) === kind);
  if (open) return open.doc as SchDocument;
  const p = od.projectId ? projects.value.find((x) => x.id === od.projectId) : undefined;
  const ext = kind === 'wiring' ? '.wirdoc' : '.ldrdoc';
  const f = p ? [...p.files.values()].find((x) => x.name.toLowerCase().endsWith(ext)) : undefined;
  try { return f ? readSchDoc(f.bytes, f.name) : null; } catch { return null; }
}
function placeHarnessEntry(e: SchEditor): void {
  const t = () => (entryTemplate ??= withDefault(e.doc, harnessEntryBag('Entry1', 0, 0)));
  e.setTool(new SheetEntryTool(e, {
    template: t, what: 'Place Harness Entry', owner: isHarness, slot: harnessSlot,
    placed: () => { const b = t().clone(); b.set('NAME', autoNext(b.get('NAME') ?? '')); entryTemplate = b; },
    edit: () => showDialog(SchObjectDialog, { ed: e, template: { bag: t(), onOk: (b: PropertyBag) => {
      entryTemplate = b;
      const k = schKind('Harness Entry')!;
      if (!settings.schDefaultsPermanent) setSchDefault(k.name, capture(e.doc, k, [b]), true);
    } } }),
  }));
}

/** A connector of this type with the entries the project's connectors of the type have, at the cursor. */
function placeForType(e: SchEditor, type: string): void {
  const defs = harnessDefinitions(projectSheets(activeProject()).length ? projectSheets(activeProject()) : [{ name: active.value!.name, doc: e.doc }]).get(type);
  const entries = defs?.[0]?.entries ?? [];
  const items = harnessConnectorItems({ x: 0, y: 0 }, { x: 60 * 100_000, y: -(entries.length + 1) * 10 * 100_000 }, type, entries);
  e.setTool(new SchPasteTool(e, { kind: 'sch', ref: { x: 0, y: 0 }, items }, false, { id: 'place-harness-for-type', what: `harness connector ${type}` }));
}

/** The harness type of what was right-clicked: a port / sheet entry's Harness Type, a connector's, an entry's connector's. */
function contextType(e: SchEditor): string {
  const k = e.hits(e.cursor)[0]?.key;
  const o = k ? e.doc.objects[parseInt(k.slice(1), 10)] : undefined;
  if (!o) return '';
  if (o.kind === 'port' || o.kind === 'sheetentry') return e.doc.records[o.index + 1]?.bag?.get('HARNESSTYPE') ?? '';
  if (isHarness(o)) return harnessType(e.doc, o.index);
  if ((o.kind === 'harnessentry' || (o.kind === 'text' && o.role === 'harnesstype')) && isHarness(e.doc.objects[o.owner])) return harnessType(e.doc, o.owner);
  return '';
}

export function harnessCommands(): Command[] {
  const has = () => !!sheet();
  return [
    { id: 'ad:Sch:PlaceHarnessConnector', label: 'Harness Connector', scopes: ['sch'], enabled: has, run: () => {
      const e = sheet();
      if (!e) return;
      e.setTool(new SchShapeTool(e, defaulted(e, {
        id: 'ad:Sch:PlaceHarnessConnector', what: 'harness connector', clicks: 2,
        prompt: (n) => (n ? 'click the opposite corner' : 'click the first corner'),
        build: (pts, base) => harnessConnectorItems(pts[0]!, pts.at(-1) ?? pts[0]!).map((it) => { const b = it.bag.clone(); if (it.owner >= 0) b.set('OWNERINDEX', String(base + it.owner)); return b; }),
      })));
    } },
    { id: 'ad:Sch:PlaceHarnessEntry', label: 'Harness Entry', scopes: ['sch'], enabled: has, run: () => { const e = sheet(); if (e) placeHarnessEntry(e); } },
    { id: 'ad:Sch:PlaceSignalHarness', label: 'Signal Harness', scopes: ['sch'], enabled: has, run: () => {
      const e = sheet();
      if (!e) return;
      e.setTool(new SchShapeTool(e, defaulted(e, { id: 'ad:Sch:PlaceSignalHarness', what: 'signal harness', clicks: 0, min: 2, corners: true, build: (pts) => (pts.length >= 2 ? [signalHarnessBag(pts)] : []) })));
    } },
    { id: 'ad:Sch:PlacePredefinedHarnessConnector', label: 'Predefined Harness Connector', scopes: ['sch'], enabled: has, run: () => {
      const e = sheet();
      if (!e) return;
      const types = [...harnessDefinitions(projectSheets(activeProject())).keys()].filter((t) => t !== '(no type)');
      if (!types.length) { notify('No harness types in the project yet: place a Harness Connector and name its type', 'error'); return; }
      showDialog(PickHarnessTypeDialog, { types, onOk: (t: string) => placeForType(e, t) });
    } },
    ...(['ForPort', 'ForSheetEntry', 'ForHarness', 'ForHarnessEntry'] as const).map((k): Command => ({
      id: `ad:Sch:PlacePredefinedHarnessConnector${k}WithContext`, label: 'Place Harness Connector For Type', scopes: ['sch'],
      enabled: () => { const e = sheet(); return !!e && !!contextType(e); },
      run: () => { const e = sheet(); const t = e ? contextType(e) : ''; if (e && t) placeForType(e, t); },
    })),
    { id: 'ad:WorkspaceManager:HarnessDefinitionResolver', label: 'Harness Definition Problem Finder...', run: () => {
      const p = activeProject();
      const sheets = projectSheets(p);
      showDialog(HarnessDefinitionsDialog, { defs: harnessDefinitions(sheets), project: p });
    }, enabled: () => !!sheet() || !!activeProject() },
    { id: 'reports.harnessWires', label: 'Harness Wire List', run: () => {
      const od = harnessDoc();
      if (!od) { notify('Open a harness wiring diagram (.WirDoc) or layout drawing (.LdrDoc) first', 'error'); return; }
      const wiring = partner(od, 'wiring');
      if (!wiring) { notify('The project has no harness wiring diagram (.WirDoc)', 'error'); return; }
      const layout = partner(od, 'layout');
      const p = od.projectId ? projects.value.find((x) => x.id === od.projectId) ?? null : null;
      showDialog(HarnessWireListDialog, { name: wiring.name, layout: layout?.name ?? '', rows: wireList(wiring, layout), project: p });
    }, enabled: () => !!harnessDoc() },
  ];
}
