/**
 * Grids, guides and placed tables: Grid Manager (and its right-click and View › Grids entries),
 * Grid Properties, Guide Manager, Place › Work Guides (horizontal, vertical, ±45°, point), the
 * right-click Snap Grid sizes on a board, Place › Coordinate (and Explode Coordinate), Place ›
 * Drill Table, Place › Layer Stack Table.
 */
import type { Command, Scope } from '../core/commands';
import type { Tool, ToolOverlay, ToolPointer } from '../core/tools';
import type { Vec2 } from '../core/geom';
import { active, notify, units } from './state';
import { showDialog } from './dialogs';
import { GridManagerDialog, GridPropertiesDialog, GuideManagerDialog, saveGrids, saveGuides } from './dialogs/GridManager';
import { PromptDialog } from './dialogs/Confirm';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { PickTool } from '../editors/Editor';
import { encodeText, encodeTrack } from '../formats/altium/pcbdoc';
import { withRecordUnion } from '../formats/altium/unions';
import type { PcbRawRecord } from '../formats/altium/framing';
import { addPrimRecords, freshRecord, replaceRecords } from '../model/pcbEdit';
import { coordinateMarker, drillTable, layerStackTable, type Drawn } from '../model/boardTables';
import { snapToLocalGrid, type GuideKind } from '../model/gridGuides';
import { freshUnionName, metaWithout, nextUnion, setUnionMeta, unionEdits, unionMembers, unionOf } from '../model/unions';
import { L, layerColour, type LayerId } from '../model/layers';
import { formatCoord, mil, parseLength } from '../core/units';
import { bagDefaults } from '../model/bagDefaults';

const PCB: Scope[] = ['pcb'];
const BOTH: Scope[] = ['pcb', 'pcblib'];
const board = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };
const anyPcb = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };
const on = (fn: (e: PcbEditor) => void) => () => { const e = board(); if (e) fn(e); };

/** What a placed table or coordinate draws, as a union of tracks and texts on one layer. */
export function putDrawn(e: PcbEditor, d: Drawn, layer: LayerId, unionName: string, label: string, lineW = mil(10), textH = mil(60)): void {
  const doc = e.doc, u = nextUnion(doc), name = freshUnionName(doc, unionName);
  const recs: { storage: string; rec: PcbRawRecord }[] = [];
  const inU = (storage: string, r: PcbRawRecord) => withRecordUnion(storage, r, u) ?? r;
  for (const l of d.lines) recs.push({ storage: 'Tracks6', rec: inU('Tracks6', freshRecord(doc, 'Tracks6', (t) => encodeTrack({ layer, a: l.a, b: l.b, width: lineW }, t))) });
  for (const t of d.texts) recs.push({ storage: 'Texts6', rec: inU('Texts6', freshRecord(doc, 'Texts6', (tpl) => encodeText({ layer, at: t.at, height: textH, text: t.text, strokeWidth: Math.round(textH / 6) }, tpl))) });
  e.undo.transact(label, (tx) => {
    tx.add(addPrimRecords(doc, recs));
    tx.add(setUnionMeta(doc, [...(doc.unionNames ?? []), { index: u, name }], [...(doc.smartUnions ?? [])]));
  });
  e.invalidate();
}

/** A drawing that follows the cursor (top left at it); a click puts it down. */
class PlaceDrawnTool implements Tool {
  constructor(private ed: PcbEditor, readonly id: string, private label: string, private make: (at: Vec2) => Drawn, private place: (at: Vec2) => void, private layer: LayerId) {}
  private at: Vec2 | null = null;
  hint(): string { return `${this.label}: click where its top left corner goes`; }
  pointerMove(p: ToolPointer): void { this.at = p.world; }
  pointerDown(p: ToolPointer): void { if (p.button === 0) { this.place(p.world); this.ed.setTool(null); } }
  overlay(): ToolOverlay | null {
    if (!this.at) return null;
    const d = this.make(this.at), c = layerColour(this.layer);
    return { segments: d.lines.map((l) => ({ a: l.a, b: l.b, width: 0, color: c })), labels: d.texts.map((t) => ({ at: t.at, text: t.text, color: c, px: 11 })) };
  }
}

const GUIDES: [string, GuideKind, string][] = [
  ['ad:PCB:PlaceGuide_HorzLineGuide', 'h', 'Place Horizontal Guide'], ['ad:PCB:PlaceGuide_VertLineGuide', 'v', 'Place Vertical Guide'],
  ['ad:PCB:PlaceGuide_Plus45DegLineGuide', 'p45', 'Place +45 Degree Guide'], ['ad:PCB:PlaceGuide_Minus45DegLineGuide', 'm45', 'Place -45 Degree Guide'],
  ['ad:PCB:PlaceGuide_ManualHotSpot', 'point', 'Place Point Guide'],
];

/** A table's text height: Preferences › PCB Editor › Defaults › Drill Table / Layer Stack Table (60 mil unless changed). */
const tableText = (kind: 'Drill Table' | 'Layer Stack Table'): number => { const c = parseLength(bagDefaults(kind).TEXTHEIGHT); return c && c > 0 ? Math.round(c) : 600_000; };

export function pcbGridCommands(): Command[] {
  const manager = () => { const e = anyPcb(); if (e) showDialog(GridManagerDialog, { ed: e }); };
  return [
    { id: 'ad:PCB:RunGridManager', label: 'Grid Manager', scopes: BOTH, enabled: () => !!anyPcb(), run: manager },
    { id: 'ad:PCB:RunGridManagerPopup', label: 'Grid Manager', scopes: BOTH, enabled: () => !!anyPcb(), run: manager },
    { id: 'ad:PCB:PopupOptionsGrids', label: 'Grid Manager', scopes: BOTH, enabled: () => !!anyPcb(), run: manager },
    { id: 'ad:PCB:RunGridPropertiesEditor', label: 'Grid Properties', scopes: BOTH, enabled: () => !!anyPcb(), run: () => {
      const e = anyPcb();
      if (!e) return;
      // The grid under the cursor, else the global one
      const { grids } = e.gridsAndGuides();
      const i = grids.findIndex((g) => g.enabled && snapToLocalGrid([g], e.cursor));
      if (i < 0) { showDialog(GridPropertiesDialog, { ed: e, grid: null, onOk: () => {} }); return; }
      showDialog(GridPropertiesDialog, { ed: e, grid: grids[i]!, onOk: (g: typeof grids[number]) => saveGrids(e, grids.map((x, k) => (k === i ? g : x)), 'Grid properties') });
    } },
    { id: 'ad:PCB:RunGuideManager', label: 'Guide Manager', scopes: BOTH, enabled: () => !!anyPcb(), run: () => { const e = anyPcb(); if (e) showDialog(GuideManagerDialog, { ed: e }); } },
    ...GUIDES.map(([id, kind, label]): Command => ({ id, label, scopes: BOTH, enabled: () => !!anyPcb(), run: () => {
      const e = anyPcb();
      if (e) e.setTool(new PickTool(e, `${label}: click where it goes (right-click ends)`, (p) => {
        const at = e.snap(p.raw);
        saveGuides(e, [...e.gridsAndGuides().guides, { kind, at: { x: Math.round(at.x), y: Math.round(at.y) }, enabled: true }], label);
        return true;
      }, true));
    } })),
    // Place › Coordinate (and its explosion: the union broken)
    { id: 'ad:PCB:PlaceCoordinate', label: 'Coordinate', scopes: PCB, enabled: () => !!board(), run: on((e) => {
      e.setTool(new PickTool(e, 'Place Coordinate: click the point (right-click ends)', (p) => {
        const at = e.snapPointer(p.raw);
        // Preferences › Defaults › Coordinate: line width, text height, size, units
        const d = bagDefaults('Coordinate'), len = (v: string | undefined, def: number) => { const c = parseLength(v); return c && c > 0 ? Math.round(c) : def; };
        const u = d.UNITSTYLE === 'Mils' ? 'mil' : d.UNITSTYLE === 'Millimeters' ? 'mm' : units.value === 'mm' ? 'mm' : 'mil';
        const textH = len(d.TEXTHEIGHT, mil(40));
        putDrawn(e, coordinateMarker(e.doc, { x: Math.round(at.x), y: Math.round(at.y) }, u, textH, len(d.SIZE, mil(40))), e.currentLayer, 'Coordinates', 'Place coordinate', len(d.LINEWIDTH, mil(10)), textH);
        return true;
      }, true));
    }) },
    { id: 'ad:PCB:ExplodeCoordinateToFreePrimitives', label: 'Explode Coordinate to Free Primitives', scopes: PCB, enabled: () => !!board()?.doc.unionNames?.some((n) => n.name.startsWith('Coordinates')), run: on((e) => {
      e.setTool(new PickTool(e, 'Explode Coordinate: click a coordinate', (p) => {
        const doc = e.doc;
        const hit = e.hits(p.raw).map((h) => e.primByKey(h.key)).find((q) => q && unionOf(doc, q) > 0);
        const u = hit ? unionOf(doc, hit) : 0;
        if (!u || !(doc.unionNames ?? []).find((n) => n.index === u)?.name.startsWith('Coordinates')) return false;
        const m = unionMembers(doc, u), meta = metaWithout(doc, new Set([u]));
        e.undo.transact('Explode coordinate', (tx) => { tx.add(replaceRecords(doc, unionEdits(doc, m.prims, 0))); tx.add(setUnionMeta(doc, meta.names, meta.smart)); });
        e.invalidate();
        return true;
      }, true));
    }) },
    { id: 'ad:PCB:PlaceDrillTable', label: 'Drill Table', scopes: PCB, enabled: () => !!board()?.doc.prims.some((p) => (p.kind === 'pad' || p.kind === 'via') && p.hole > 0), run: on((e) => {
      const th = tableText('Drill Table');
      e.setTool(new PlaceDrawnTool(e, 'place-drill-table', 'Place Drill Table', (at) => drillTable(e.doc, at, th), (at) => {
        putDrawn(e, drillTable(e.doc, { x: Math.round(at.x), y: Math.round(at.y) }, th), L.DRILL_DRAWING, 'Drill Tables', 'Place drill table');
        notify('Drill table placed on the Drill Drawing layer');
      }, L.DRILL_DRAWING));
    }) },
    { id: 'ad:PCB:PlaceLayerStackTable', label: 'Layer Stack Table', scopes: PCB, enabled: () => !!board()?.doc.board.bag, run: on((e) => {
      const layer = e.currentLayer;
      const th = tableText('Layer Stack Table');
      e.setTool(new PlaceDrawnTool(e, 'place-stack-table', 'Place Layer Stack Table', (at) => layerStackTable(e.doc, at, th), (at) => {
        putDrawn(e, layerStackTable(e.doc, { x: Math.round(at.x), y: Math.round(at.y) }, th), layer, 'Layer Stack Tables', 'Place layer stack table');
      }, layer));
    }) },
  ];
}

/** Ask a snap grid size (Set Global Snap Grid…). */
export const askSnap = (e: PcbEditor) => showDialog(PromptDialog, { title: 'Snap Grid', fields: [{ label: `Snap grid (${units.value})`, value: formatCoord(e.gridSize(), units.value) }],
  onOk: ([v]: string[]) => { const t = (v ?? '').trim(); const c = parseLength(/^[0-9.]+$/.test(t) ? `${t}${units.value}` : t); if (c && c > 0) e.setGrid(c); } });
