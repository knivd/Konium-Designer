/**
 * Edit › Origin, Edit › Jump and Design › Board Shape: setting the relative origin, jumping to
 * a location, component, net, pad, string, error marker or location mark, and drawing,
 * editing, moving and deriving the board's shape (and its cut-outs).
 */
import { BendingLineTool, DeleteSplitLineTool, SliceRegionTool, SplitLineTool, addCoverlayShape } from '../editors/pcb/RigidFlexTools';
import { addRegion, boardRegions, isAdvanced, setRigidFlex, splitLines, withRegion } from '../model/rigidFlex';
import { coverlayLayers, customCoverlayShapes, regionHasCoverlay } from '../model/coverlay';
import type { Command, Scope } from '../core/commands';
import { emptyBox, extend, type Vec2 } from '../core/geom';
import { parseLength } from '../core/units';
import { active, notify, units } from './state';
import { showDialog } from './dialogs';
import { PromptDialog } from './dialogs/Confirm';
import { BoardPrimsDialog } from './dialogs/BoardPrims';
import { PickTool } from '../editors/Editor';
import type { Editor } from '../editors/Editor';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { SchEditor } from '../editors/sch/SchEditor';
import { EditBoardShapeTool, MoveBoardShapeTool, OutlineTool } from '../editors/pcb/BoardShapeTools';
import { setBoardShape, setOrigin, shapeFromLoop, shapePrimitives } from '../model/pcbBoard';
import { addPrimRecords, freshRecord } from '../model/pcbEdit';
import { encodeArc, encodeRegion, encodeTrack } from '../formats/altium/pcbdoc';
import { L } from '../model/layers';
import { BomDialog } from './dialogs/Bom';
import { deliverOutputs } from './dialogs/Outputs';
import { bomItems, pcbBomItems, simpleBom, wireLinkBomItems } from '../model/bom';
import { boardOf } from './reqFacts';
import { compileProject } from '../model/compile';
import { currentVariant } from './variantState';
import { readVariants, variantComponents } from '../model/variants';
import { activeProject, compileOptions, projectSheets } from './project';
import type { Project } from './state';
import type { PcbArc, PcbTrack } from '../model/pcb';

const ed = () => active.value?.editor ?? null;
const pcb = () => { const e = ed(); return e instanceof PcbEditor ? e : null; };
const board = () => { const e = pcb(); return e && !(e instanceof PcbLibEditor) ? e : null; };
/** The board region selected in Board Planning Mode. */
const selectedRegion = () => {
  const e = board();
  if (!e?.planning) return null;
  const k = [...e.selection].find((x) => x.startsWith('region:'));
  const index = k ? Number(k.slice(7)) : -1;
  const region = boardRegions(e.doc)[index];
  return region ? { ed: e, index, region } : null;
};
const docEd = () => { const e = ed(); return e instanceof PcbEditor || e instanceof SchEditor ? e : null; };
const PCB: Scope[] = ['pcb'];
const DOCS: Scope[] = ['sch', 'pcb'];

/** A length typed in a box: a bare number is in the current units. */
const typed = (s: string): number | undefined => parseLength(/^\s*-?[\d.]+\s*$/.test(s) ? `${s.trim()}${units.value}` : s);

/** Jump: the cursor goes there and the view centres on it. */
const jumpTo = (e: Editor, p: Vec2) => { e.pushView(); e.viewport?.cursorTo(p, true); };

/** Location marks 1–10, per document: Set Location Marks stores the cursor, Jump › Location Marks returns to it. */
const marks = new WeakMap<Editor, Map<number, Vec2>>();
export function locationMarks(e: Editor): Map<number, Vec2> {
  let m = marks.get(e);
  if (!m) { m = new Map(); marks.set(e, m); }
  return m;
}
export const setLocationMark = (e: Editor, n: number) => { locationMarks(e).set(n, e.snap(e.cursor)); notify(`Location mark ${n} set`); };
export const jumpLocationMark = (e: Editor, n: number) => { const p = locationMarks(e).get(n); if (p) jumpTo(e, p); };

/** The parts for a BOM: the compiled project's (or sheet's), else the board's own components. */
function bomSource(): { name: string; project: Project | null; items: Record<string, string>[] } | null {
  const p = activeProject();
  const sheets = projectSheets(p);
  if (sheets.length) {
    // The current variant's not-fitted parts stay out of the BOM
    const vname = p ? currentVariant(p.id) : '';
    const v = vname && p ? readVariants(p.prj).find((x) => x.name === vname) : undefined;
    const comps = variantComponents(compileProject(sheets, compileOptions(p)).components, v);
    // With the board's wire links, which no sheet has
    const b = p ? boardOf(p) : null;
    return { name: p?.name ?? sheets[0]!.name, project: p, items: [...bomItems(comps), ...(b ? wireLinkBomItems(b.doc) : [])] };
  }
  const e = board();
  return e ? { name: e.doc.name, project: p, items: pcbBomItems(e.doc) } : null;
}

export function editCommands(): Command[] {
  let errorAt = -1;
  return [
    /* ── Edit › Origin ── */
    { id: 'pcb.setOrigin', label: 'Set', scopes: PCB, run: () => {
      const e = board();
      if (!e) return;
      e.setTool(new PickTool(e, 'Set Origin: click where the relative origin goes', (p) => {
        e.undo.transact('Set origin', (tx) => tx.add(setOrigin(e.doc, p.world)));
        e.invalidate();
        return true;
      }));
    }, enabled: () => !!board()?.doc.board.bag },
    { id: 'pcb.resetOrigin', label: 'Reset', scopes: PCB, run: () => {
      const e = board();
      if (e) { e.undo.transact('Reset origin', (tx) => tx.add(setOrigin(e.doc, { x: 0, y: 0 }))); e.invalidate(); }
    }, enabled: () => { const o = board()?.doc.board.origin; return !!o && (o.x !== 0 || o.y !== 0); } },

    /* ── Edit › Jump ── */
    { id: 'jump.location', label: 'New Location...', scopes: DOCS, run: () => {
      const e = docEd();
      if (!e) return;
      const o = e.origin();
      showDialog(PromptDialog, { title: 'Jump To Location', fields: [{ label: `X Location (${units.value})`, value: '0' }, { label: `Y Location (${units.value})`, value: '0' }],
        onOk: ([x, y]: string[]) => { const X = typed(x ?? ''), Y = typed(y ?? ''); if (X !== undefined && Y !== undefined) jumpTo(e, { x: o.x + X, y: o.y + Y }); else notify('Type a location such as 1000 or 25.4mm', 'error'); } });
    }, enabled: () => !!docEd() },
    { id: 'jump.component', label: 'Component...', scopes: DOCS, run: () => {
      const e = docEd();
      if (!e) return;
      showDialog(PromptDialog, { title: 'Component Designator', fields: [{ label: 'Designator' }], onOk: ([d]: string[]) => {
        const want = (d ?? '').trim().toUpperCase();
        let at: Vec2 | undefined;
        if (e instanceof PcbEditor) at = e.doc.components.find((c) => c.designator.toUpperCase() === want)?.at;
        else if (e instanceof SchEditor) { const c = e.doc.objects.find((o) => o.kind === 'component' && o.designator.toUpperCase() === want); if (c?.kind === 'component') at = c.at; }
        if (at) jumpTo(e, at); else notify(`No component ${d}`, 'error');
      } });
    }, enabled: () => !!docEd() },
    { id: 'ad:PCB:JumpNet', label: 'Net...', scopes: PCB, run: () => {
      const e = board();
      if (!e) return;
      showDialog(PromptDialog, { title: 'Net Name', fields: [{ label: 'Net' }], onOk: ([n]: string[]) => {
        const net = e.doc.nets.find((x) => x.name.toUpperCase() === (n ?? '').trim().toUpperCase());
        if (!net) { notify(`No net ${n}`, 'error'); return; }
        e.highlightNet = net.index;
        const pts = e.doc.prims.filter((p) => 'net' in p && p.net === net.index).map((p) => ('at' in p ? p.at : 'a' in p ? p.a : 'c' in p ? p.c : p.outline[0]!));
        if (pts.length) { e.pushView(); const box = emptyBox(); for (const p of pts) extend(box, p.x, p.y); e.viewport?.fitBox(box); }
        e.invalidateOverlay();
      } });
    }, enabled: () => !!board() },
    { id: 'ad:PCB:JumpPad', label: 'Pad...', scopes: PCB, run: () => {
      const e = board();
      if (!e) return;
      showDialog(PromptDialog, { title: 'Pad Designator', fields: [{ label: 'Pad (e.g. U1-3)' }], onOk: ([v]: string[]) => {
        const m = /^\s*(.+?)[-.](\S+)\s*$/.exec(v ?? '');
        const c = m && e.doc.components.find((x) => x.designator.toUpperCase() === m[1]!.toUpperCase());
        const pad = c && e.doc.prims.find((p) => p.kind === 'pad' && p.component === c.index && p.name.toUpperCase() === m![2]!.toUpperCase());
        if (pad && pad.kind === 'pad') jumpTo(e, pad.at); else notify(`No pad ${v}`, 'error');
      } });
    }, enabled: () => !!board() },
    { id: 'ad:PCB:JumpString', label: 'String...', scopes: PCB, run: () => {
      const e = pcb();
      if (!e) return;
      showDialog(PromptDialog, { title: 'String', fields: [{ label: 'Text' }], onOk: ([v]: string[]) => {
        const want = (v ?? '').trim().toUpperCase();
        const t = e.doc.prims.find((p) => p.kind === 'text' && !p.hidden && p.text.toUpperCase().includes(want));
        if (t && t.kind === 'text') jumpTo(e, t.at); else notify(`No string ${v}`, 'error');
      } });
    }, enabled: () => !!pcb() },
    { id: 'jump.errorMarker', label: 'Error Marker', scopes: PCB, run: () => {
      const e = board();
      if (!e?.violations.length) return;
      errorAt = (errorAt + 1) % e.violations.length;
      e.showViolation(e.violations[errorAt]!);
    }, enabled: () => !!board()?.violations.length },

    /* ── Reports › Bill of Materials, Simple BOM ── */
    { id: 'reports.bom', label: 'Bill of Materials', run: () => {
      const src = bomSource();
      if (!src) { notify('Open a project, a schematic or a board first', 'error'); return; }
      if (!src.items.length) { notify(`${src.name} has no parts for a Bill of Materials`, 'error'); return; }
      showDialog(BomDialog, src);
    }, enabled: () => !!docEd() || !!activeProject() },
    { id: 'reports.simpleBom', label: 'Simple BOM', run: () => {
      const src = bomSource();
      if (!src?.items.length) { notify('No parts for a Simple BOM', 'error'); return; }
      const base = src.name.replace(/\.(prjpcb|schdoc|pcbdoc)$/i, '');
      const { bom, csv } = simpleBom(src.name, src.items);
      void deliverOutputs(src.project, src.name, 'Simple BOM', [{ name: `${base}.BOM`, text: bom }, { name: `${base}.CSV`, text: csv }]);
    }, enabled: () => !!docEd() || !!activeProject() },

    /* ── Design › Board Shape ── */
    { id: 'ad:PCB:RedefineBoardShape', label: 'Redefine Board Shape', scopes: PCB, run: () => {
      const e = board();
      if (e) e.setTool(new OutlineTool(e, 'Redefine Board Shape', (vs) => { e.undo.transact('Redefine board shape', (tx) => tx.add(setBoardShape(e.doc, vs))); e.invalidate(); }, false, 'board-redefine'));
    }, enabled: () => !!board()?.doc.board.bag },
    { id: 'ad:PCB:MoveBoardVertices', label: 'Edit Board Shape', scopes: PCB, run: () => { const e = board(); if (e) e.setTool(new EditBoardShapeTool(e)); },
      enabled: () => (board()?.doc.board.vertices.length ?? 0) >= 3 },
    { id: 'ad:PCB:MoveBoardShape', label: 'Move Board Shape', scopes: PCB, run: () => { const e = board(); if (e) e.setTool(new MoveBoardShapeTool(e)); },
      enabled: () => (board()?.doc.board.vertices.length ?? 0) >= 3 },
    { id: 'ad:PCB:RedefineBoardShapeFromSelection', label: 'Define from selected objects', scopes: PCB, run: () => {
      const e = board();
      if (!e) return;
      const prims = [...e.selection].map((k) => e.primByKey(k)).filter((p): p is PcbTrack | PcbArc => p?.kind === 'track' || p?.kind === 'arc');
      const r = shapeFromLoop(prims);
      if (typeof r === 'string') { notify(r, 'error'); return; }
      e.undo.transact('Define board shape from selection', (tx) => tx.add(setBoardShape(e.doc, r)));
      e.invalidate();
      notify(`Board shape defined from ${prims.length} objects`);
    }, enabled: () => !!board()?.selection.size },
    { id: 'ad:PCB:CreatePrimsFromBoardShape', label: 'Create Primitives From Board Shape', scopes: PCB, run: () => {
      const e = board();
      if (!e) return;
      showDialog(BoardPrimsDialog, { ed: e, units: units.value, onOk: (layer: number, width: number) => {
        const doc = e.doc;
        const recs = shapePrimitives(doc.board.vertices).map((p) => (p.kind === 'track'
          ? { storage: 'Tracks6', rec: freshRecord(doc, 'Tracks6', (t) => encodeTrack({ layer, a: p.a, b: p.b, width }, t)) }
          : { storage: 'Arcs6', rec: freshRecord(doc, 'Arcs6', (t) => encodeArc({ layer, c: p.c, r: p.r, start: p.start, end: p.end, width }, t)) }));
        e.undo.transact('Create primitives from board shape', (tx) => tx.add(addPrimRecords(doc, recs)));
        e.invalidate();
        notify(`${recs.length} primitives on ${e.layerLabel(layer)}`);
      } });
    }, enabled: () => (board()?.doc.board.vertices.length ?? 0) >= 3 },
    /* ── Design › split and bending lines (Board Planning Mode) ── */
    { id: 'ad:PCB:PlaceSplitLine', label: 'Define Split Line', scopes: PCB, run: () => { const e = board(); if (e) e.setTool(new SplitLineTool(e)); },
      enabled: () => { const e = board(); return !!e && e.doc.board.outline.length >= 3 && !isAdvanced(e.doc); } },
    { id: 'ad:PCB:DeleteSplitLine', label: 'Delete Split Line', scopes: PCB, run: () => { const e = board(); if (e) e.setTool(new DeleteSplitLineTool(e)); },
      enabled: () => { const e = board(); return !!e && splitLines(e.doc).length > 0 && !isAdvanced(e.doc); } },
    /* ── Advanced Rigid-Flex: regions placed and sliced ── */
    { id: 'ad:PCB:PlaceBoardRegion', label: 'Board Region', scopes: PCB, run: () => {
      const e = board();
      if (!e) return;
      if (!e.planning) e.setPlanning(true);
      e.setTool(new OutlineTool(e, 'Place Board Region', (vs) => {
        const outline = vs.map((v) => v.p);
        e.undo.transact('Place board region', (tx) => tx.add(setRigidFlex(e.doc, addRegion(e.doc, outline))));
        e.invalidate();
      }, true, 'board-region'));
    }, enabled: () => { const e = board(); return !!e && isAdvanced(e.doc); } },
    { id: 'ad:PCB:SliceBoardRegion', label: 'Slice Board Region', scopes: PCB, run: () => { const e = board(); if (e) e.setTool(new SliceRegionTool(e)); },
      enabled: () => { const e = board(); return !!e && isAdvanced(e.doc); } },
    /* ── Coverlay: polygons and cutouts on a flex region's coverlay; Coverlay Actions ── */
    ...([['ad:PCB:PlaceCoverlayPolygon', 'Place Coverlay Polygon', false], ['ad:PCB:PlaceCoverlayCutout', 'Place Coverlay Cutout', true]] as const).map(([id, label, cutout]): Command => ({
      id, label, scopes: PCB, enabled: () => { const e = board(); return !!e && coverlayLayers(e.doc).length > 0; },
      run: () => {
        const e = board();
        if (!e) return;
        if (!e.planning) e.setPlanning(true);
        e.setTool(new OutlineTool(e, label, (vs) => { const err = addCoverlayShape(e, vs.map((v) => v.p), cutout); if (err) notify(err, 'error'); }, true, cutout ? 'coverlay-cutout' : 'coverlay-polygon'));
      },
    })),
    ...([['ad:PCB:AddCoverlay', 'Add Coverlay', true], ['ad:PCB:RemoveCoverlay', 'Remove Coverlay', false]] as const).map(([id, label, on]): Command => ({
      id, label, scopes: PCB,
      enabled: () => { const r = selectedRegion(); return !!r && (on ? !r.region.customCoverlay && coverlayLayers(r.ed.doc).some((c) => regionHasCoverlay(r.ed.doc, r.region, c)) : !!r.region.customCoverlay); },
      run: () => {
        const r = selectedRegion();
        if (!r) return;
        const f = withRegion(r.ed.doc, r.index, on ? { customCoverlay: true, coverlays: customCoverlayShapes(r.ed.doc, r.region) } : { customCoverlay: false, coverlays: [] });
        r.ed.undo.transact(label, (tx) => tx.add(setRigidFlex(r.ed.doc, f)));
        r.ed.invalidate();
      },
    })),
    { id: 'ad:PCB:PlaceBendingLine', label: 'Define Bending Line', scopes: PCB, run: () => { const e = board(); if (e) e.setTool(new BendingLineTool(e)); },
      enabled: () => (board()?.doc.board.outline.length ?? 0) >= 3 },
    { id: 'ad:PCB:PlaceBoardCutout', label: 'Define Board Cutout', scopes: PCB, run: () => {
      const e = board();
      if (!e) return;
      e.setTool(new OutlineTool(e, 'Define Board Cutout', (vs) => {
        const rec = encodeRegion({ layer: L.MULTI, outline: vs.map((v) => v.p), boardCutout: true });
        e.undo.transact('Define board cutout', (tx) => tx.add(addPrimRecords(e.doc, [{ storage: 'Regions6', rec }])));
        e.invalidate();
      }, true, 'board-cutout'));
    }, enabled: () => !!board() },
  ];
}
