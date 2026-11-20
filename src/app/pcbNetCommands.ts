/**
 * Board commands of 26.022 that work by net, connection and component: Route › Un-Route (All,
 * Net, Connection, Component), View › Connections (Show / Hide Net, Component Nets, All, and
 * the right-click versions), Edit › Select › Physical Connection (single layer too), Component
 * Connections and Nets, Tools › Convert › Explode Component / Polygon to Free Primitives,
 * Convert Free Pads ↔ Vias, Create (Board) Cutout / Polygon from Selected Primitives, Add
 * Selected Primitives to Component, Toggle Primitive Lock, Jump › selection, Measure Selected
 * Objects, Move Component Origin To Grid, Paste On Current Layer, Design › Netlist › Clear All
 * Nets, Edit › Select › Off Grid Pads, Reports › Board Information and Netlist Status.
 */
import { locale } from '../core/locale';
import { reportOut } from './pcbReports';
import { commands, type Command, type Scope } from '../core/commands';
import { BoardOptionsDialog } from './dialogs/BoardOptions';
import { active, notify, replaceMessages, units } from './state';
import { showDialog } from './dialogs';
import { ConfirmDialog } from './dialogs/Confirm';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { PcbPasteTool } from '../editors/pcb/PcbPasteTool';
import { PickTool } from '../editors/Editor';
import { clipboard } from '../editors/clipboard';
import { addPolygon, addPrimRecords, clearAllNets, explodeComponents, repour, explodePolygons, removePrims, replaceRecords, retarget } from '../model/pcbEdit';
import { allRouting, componentNets, componentRouting, netRouting, physicalConnection } from '../model/pcbNets';
import { onLayer, regionFromLoop } from '../model/pcbTrackEdit';
import { encodePad, encodeRegion, encodeVia, writeVertices } from '../formats/altium/pcbdoc';
import { shapeFromLoop } from '../model/pcbBoard';
import { newPolygonBag } from './dialogs/Polygon';
import { REGION } from '../formats/altium/pcbLayouts';
import { PCB_TAG, type PcbRawRecord } from '../formats/altium/framing';
import { formatCoord, mil } from '../core/units';
import { L, layerName } from '../model/layers';
import { NO_NET, netName, type PcbArc, type PcbPad, type PcbPrim, type PcbTrack, type PcbVia } from '../model/pcb';
import type { Vec2 } from '../core/geom';

const PCB: Scope[] = ['pcb'];
const BOTH: Scope[] = ['pcb', 'pcblib'];
const board = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };
const anyPcb = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };
const on = (get: () => PcbEditor | null, fn: (e: PcbEditor) => void) => () => { const e = get(); if (e) fn(e); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The primitive at a click (topmost), with its index in doc.prims. */
function primAt(e: PcbEditor, raw: Vec2): { p: PcbPrim; i: number } | null {
  for (const h of e.hits(raw)) { const p = e.primByKey(h.key); if (p) return { p, i: e.doc.prims.indexOf(p) }; }
  return null;
}
/** The net of what was clicked (a pour's outline too). */
function netAt(e: PcbEditor, raw: Vec2): number | null {
  for (const h of e.hits(raw)) {
    if (h.key.startsWith('poly:')) { const pg = e.doc.polygons[Number(h.key.slice(5))]; if (pg && pg.net !== NO_NET) return pg.net; continue; }
    const p = e.primByKey(h.key);
    if (p && 'net' in p && p.net !== NO_NET) return p.net;
  }
  return null;
}
/** The component a right-click (or the selection) is on. */
function contextComponent(e: PcbEditor): number | null {
  const k = e.contextKey ?? [...e.selection][0];
  const p = k ? e.primByKey(k) : undefined;
  return p && 'component' in p && p.component !== NO_NET && e.doc.components[p.component] ? p.component : null;
}
function contextNet(e: PcbEditor): number | null {
  const k = e.contextKey ?? [...e.selection][0];
  if (k?.startsWith('poly:')) { const pg = e.doc.polygons[Number(k.slice(5))]; return pg && pg.net !== NO_NET ? pg.net : null; }
  const p = k ? e.primByKey(k) : undefined;
  return p && 'net' in p && p.net !== NO_NET ? p.net : null;
}
const selectedComponents = (e: PcbEditor) => e.moveSet().components;
const selectedPrims = (e: PcbEditor) => [...e.selection].map((k) => e.primByKey(k)).filter((p): p is PcbPrim => !!p);

function unroute(e: PcbEditor, prims: PcbPrim[], what: string): void {
  if (!prims.length) { e.status?.(`Nothing routed on ${what}`); return; }
  const locked = prims.filter((p) => 'locked' in p && p.locked);
  const go = prims.filter((p) => !('locked' in p && p.locked));
  if (!go.length) { notify(`The routing on ${what} is locked`, 'error'); return; }
  e.selection.clear();
  e.undo.transact(`Un-Route ${what}`, (tx) => tx.add(removePrims(e.doc, go)));
  e.invalidate();
  e.status?.(`Un-routed ${what}: ${plural(go.length, 'object')}${locked.length ? `, ${locked.length} locked left` : ''}`);
}

/** A click tool that repeats until right-click: Un-Route Net, Show Net … */
const pick = (e: PcbEditor, prompt: string, fn: (raw: Vec2) => void) => e.setTool(new PickTool(e, prompt, (p) => { fn(p.raw); e.invalidate(); return false; }, true));

/** Locked: bit 2 of the first flag byte (pads: in their fifth subrecord). */
const flagsSub = (rec: PcbRawRecord) => (rec.tag === PCB_TAG.PAD ? 4 : 0);
function withLock(rec: PcbRawRecord, locked: boolean): PcbRawRecord {
  const k = flagsSub(rec);
  const subs = rec.subs.map((x, i) => (i === k ? x.slice() : x));
  const s = subs[k]!;
  if (s.length > 1) s[1] = locked ? (s[1]! | 0x04) : (s[1]! & ~0x04);
  return { tag: rec.tag, subs };
}

export function pcbNetCommands(): Command[] {
  const conns = (fn: (e: PcbEditor, nets: number[]) => void) => (nets: (e: PcbEditor) => number[]) => on(board, (e) => { fn(e, nets(e)); e.invalidate(); });
  const show = conns((e, nets) => { for (const n of nets) e.hiddenConnections.delete(n); });
  const hide = conns((e, nets) => { for (const n of nets) e.hiddenConnections.add(n); });
  const pickNets = (verb: 'Show' | 'Hide', comp: boolean) => on(board, (e) => pick(e, `${verb} ${comp ? 'Component Nets: click a component' : 'Net: click an object on the net'} (right-click ends)`, (raw) => {
    const nets = comp ? (() => { const c = e.componentAt(raw); return c === null ? [] : [...componentNets(e.doc, c)]; })() : (() => { const n = netAt(e, raw); return n === null ? [] : [n]; })();
    for (const n of nets) { if (verb === 'Show') e.hiddenConnections.delete(n); else e.hiddenConnections.add(n); }
  }));
  const allNets = (e: PcbEditor) => e.doc.nets.map((n) => n.index);
  const ctxComponentNets = (e: PcbEditor) => { const c = contextComponent(e); return c === null ? [] : [...componentNets(e.doc, c)]; };
  const ctxNet = (e: PcbEditor) => { const n = contextNet(e); return n === null ? [] : [n]; };
  const selectPrims = (e: PcbEditor, prims: PcbPrim[], add = false) => { if (!add) e.selection.clear(); for (const p of prims) e.selection.add(`${p.src.storage}:${p.src.index}`); e.invalidateOverlay(); e.status?.(`${plural(prims.length, 'object')} selected`); };

  return [
    // Route › Un-Route
    { id: 'ad:PCB:UnRouteAll', label: 'All', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => unroute(e, allRouting(e.doc), 'all nets')) },
    { id: 'ad:PCB:UnRouteNet', label: 'Net', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => pick(e, 'Un-Route Net: click an object on the net (right-click ends)', (raw) => {
      const n = netAt(e, raw); if (n !== null) unroute(e, netRouting(e.doc, n), netName(e.doc, n));
    })) },
    { id: 'ad:PCB:UnRouteConnection', label: 'Connection', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => pick(e, 'Un-Route Connection: click a track or via (right-click ends)', (raw) => {
      const h = primAt(e, raw); if (h && (h.p.kind === 'track' || h.p.kind === 'arc' || h.p.kind === 'via')) unroute(e, physicalConnection(e.doc, h.i), 'the connection');
    })) },
    { id: 'ad:PCB:UnRouteComponent', label: 'Component', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => pick(e, 'Un-Route Component: click a component (right-click ends)', (raw) => {
      const c = e.componentAt(raw); if (c !== null) unroute(e, componentRouting(e.doc, c), e.doc.components[c]!.designator);
    })) },
    { id: 'ad:PCB:UnRouteSingleComponent', label: 'Unroute Component', scopes: PCB, enabled: () => { const e = board(); return !!e && contextComponent(e) !== null; },
      run: on(board, (e) => { const c = contextComponent(e); if (c !== null) unroute(e, componentRouting(e.doc, c), e.doc.components[c]!.designator); }) },
    // View › Connections, and the right-click Connections menu
    { id: 'ad:PCB:ShowNet', label: 'Show Net', scopes: PCB, enabled: () => !!board(), run: pickNets('Show', false) },
    { id: 'ad:PCB:HideNet', label: 'Hide Net', scopes: PCB, enabled: () => !!board(), run: pickNets('Hide', false) },
    { id: 'ad:PCB:ShowComponentNets', label: 'Show Component Nets', scopes: PCB, enabled: () => !!board(), run: pickNets('Show', true) },
    { id: 'ad:PCB:HideComponentNets', label: 'Hide Component Nets', scopes: PCB, enabled: () => !!board(), run: pickNets('Hide', true) },
    { id: 'ad:PCB:PopupShowConnectionsAll', label: 'All', scopes: PCB, enabled: () => !!board(), run: show(allNets) },
    { id: 'ad:PCB:PopupHideConnectionsAll', label: 'All', scopes: PCB, enabled: () => !!board(), run: hide(allNets) },
    { id: 'ad:PCB:PopupShowConnectionsNet', label: 'Net', scopes: PCB, enabled: () => !!board(), run: pickNets('Show', false) },
    { id: 'ad:PCB:PopupHideConnectionsNet', label: 'Net', scopes: PCB, enabled: () => !!board(), run: pickNets('Hide', false) },
    { id: 'ad:PCB:PopupShowConnectionsOnComponent', label: 'On Component', scopes: PCB, enabled: () => !!board(), run: pickNets('Show', true) },
    { id: 'ad:PCB:PopupHideConnectionsOnComponent', label: 'On Component', scopes: PCB, enabled: () => !!board(), run: pickNets('Hide', true) },
    { id: 'ad:PCB:PopupShowConnectionsOnSingleComponent', label: 'Show Nets', scopes: PCB, enabled: () => !!board(), run: show(ctxComponentNets) },
    { id: 'ad:PCB:PopupHideConnectionsOnSingleComponent', label: 'Hide Nets', scopes: PCB, enabled: () => !!board(), run: hide(ctxComponentNets) },
    { id: 'ad:PCB:PopupShowConnectionsOnSingleNet', label: 'Show Nets', scopes: PCB, enabled: () => !!board(), run: show(ctxNet) },
    { id: 'ad:PCB:PopupHideConnectionsOnSingleNet', label: 'Hide Nets', scopes: PCB, enabled: () => !!board(), run: hide(ctxNet) },
    // Edit › Select
    { id: 'ad:PCB:SelectPhysicalConnection', label: 'Physical Connection', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => pick(e, 'Physical Connection: click a track or via (right-click ends)', (raw) => {
      const h = primAt(e, raw); if (h && (h.p.kind === 'track' || h.p.kind === 'arc' || h.p.kind === 'via')) selectPrims(e, physicalConnection(e.doc, h.i), true);
    })) },
    { id: 'ad:PCB:SelectPhysicalConnectionOnLayer', label: 'Physical Connection Single Layer', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => pick(e, 'Physical Connection Single Layer: click a track (right-click ends)', (raw) => {
      const h = primAt(e, raw); if (h && (h.p.kind === 'track' || h.p.kind === 'arc')) selectPrims(e, physicalConnection(e.doc, h.i, h.p.layer), true);
    })) },
    { id: 'ad:PCB:SelectComponentConnections', label: 'Component Connections', scopes: PCB, enabled: () => !!board()?.selection.size, run: on(board, (e) => selectPrims(e, selectedComponents(e).flatMap((c) => componentRouting(e.doc, c)), true)) },
    { id: 'ad:PCB:SelectSingleComponentConnections', label: 'Select Component Connections', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => { const c = contextComponent(e); if (c !== null) selectPrims(e, componentRouting(e.doc, c), true); }) },
    { id: 'ad:PCB:SelectComponentNets', label: 'Component Nets', scopes: PCB, enabled: () => !!board()?.selection.size, run: on(board, (e) => {
      const nets = new Set(selectedComponents(e).flatMap((c) => [...componentNets(e.doc, c)]));
      selectPrims(e, [...nets].flatMap((n) => netRouting(e.doc, n)), true);
    }) },
    { id: 'ad:PCB:SelectSingleComponentNets', label: 'Select Component Nets', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => {
      const c = contextComponent(e); if (c !== null) selectPrims(e, [...componentNets(e.doc, c)].flatMap((n) => netRouting(e.doc, n)), true);
    }) },
    { id: 'select.offGridPads', label: 'Off Grid Pads', scopes: BOTH, enabled: () => !!anyPcb(), run: on(anyPcb, (e) => {
      const g = e.gridSize(), o = e.origin();
      const off = (v: number, c: number) => Math.abs(((v - c) % g + g) % g) > 0;
      selectPrims(e, e.doc.prims.filter((p) => p.kind === 'pad' && (off(p.at.x, o.x) || off(p.at.y, o.y))));
    }) },
    // Tools › Convert
    ...[['ad:PCB:ExplodeComponentToFreePrimitives', 'Explode Component to Free Primitives'], ['ad:PCB:ExplodeSingleComponentToFreePrimitives', 'Explode To Free Primitives']].map(([id, label]): Command => ({
      id: id!, label: label!, scopes: PCB, enabled: () => { const e = board(); return !!e && (selectedComponents(e).length > 0 || contextComponent(e) !== null); },
      run: on(board, (e) => {
        const comps = id!.includes('Single') ? [contextComponent(e)].filter((c): c is number => c !== null) : selectedComponents(e);
        if (!comps.length) { notify('Select the components to explode', 'error'); return; }
        e.selection.clear();
        e.undo.transact(`Explode ${plural(comps.length, 'component')}`, (tx) => tx.add(explodeComponents(e.doc, comps)));
        e.invalidate();
      }),
    })),
    ...[['ad:PCB:ExplodePolygonToFreePrimitives', 'Explode Polygon to Free Primitives'], ['ad:PCB:ExplodeSinglePolygonToFreePrimitives', 'Explode Polygon to Free Primitives']].map(([id, label]): Command => ({
      id: id!, label: label!, scopes: PCB, enabled: () => !!board(),
      run: on(board, (e) => {
        const keys = id!.includes('Single') && e.contextKey ? [e.contextKey] : [...e.selection];
        const polys = [...new Set(keys.filter((k) => k.startsWith('poly:')).map((k) => Number(k.slice(5))))];
        if (!polys.length) { notify('Select the polygon pours to explode', 'error'); return; }
        e.selection.clear();
        e.undo.transact(`Explode ${plural(polys.length, 'polygon')}`, (tx) => tx.add(explodePolygons(e.doc, polys)));
        e.invalidate();
      }),
    })),
    { id: 'ad:PCB:ConvertSelectedFreePadsToVias', label: 'Convert Selected Free Pads to Vias', scopes: PCB, enabled: () => !!board()?.selection.size, run: on(board, (e) => {
      const pads = selectedPrims(e).filter((p): p is PcbPad => p.kind === 'pad' && p.component === NO_NET && p.layer === L.MULTI && p.hole > 0);
      if (!pads.length) { notify('Select free multi-layer pads with holes', 'error'); return; }
      const vias = pads.map((p) => ({ storage: 'Vias6', rec: encodeVia({ at: p.at, diameter: Math.max(p.top.w, p.top.h), hole: p.hole, net: p.net }) }));
      e.selection.clear();
      e.undo.transact(`Convert ${plural(pads.length, 'pad')} to vias`, (tx) => { tx.add(removePrims(e.doc, pads)); tx.add(addPrimRecords(e.doc, vias)); });
      e.invalidate();
    }) },
    { id: 'ad:PCB:ConvertSelectedViasToFreePads', label: 'Convert Selected Vias to Free Pads', scopes: PCB, enabled: () => !!board()?.selection.size, run: on(board, (e) => {
      const vias = selectedPrims(e).filter((p): p is PcbVia => p.kind === 'via');
      if (!vias.length) { notify('Select vias', 'error'); return; }
      const pads = vias.map((v) => ({ storage: 'Pads6', rec: encodePad({ name: '0', layer: L.MULTI, at: v.at, w: v.diameter, h: v.diameter, shape: 'round', hole: v.hole, net: v.net }) }));
      e.selection.clear();
      e.undo.transact(`Convert ${plural(vias.length, 'via')} to pads`, (tx) => { tx.add(removePrims(e.doc, vias)); tx.add(addPrimRecords(e.doc, pads)); });
      e.invalidate();
    }) },
    ...([['ad:PCB:ConvertSelectedToCutout', 'Create Cutout from Selected Primitives', 1], ['ad:PCB:ConvertSelectedToBoardCutout', 'Create Board Cutout from Selected Primitives', 'board']] as const).map(([id, label, kind]): Command => ({
      id, label, scopes: PCB, enabled: () => !!board()?.selection.size, run: on(board, (e) => {
        const loop = selectedPrims(e).filter((p): p is PcbTrack | PcbArc => p.kind === 'track' || p.kind === 'arc');
        const r = regionFromLoop(loop);
        if (typeof r === 'string') { notify(r, 'error'); return; }
        const outline = decodeOutline(r);
        const rec = kind === 'board' ? encodeRegion({ layer: L.MULTI, outline, boardCutout: true }) : encodeRegion({ layer: loop[0]!.layer, outline, kind: 1 });
        e.undo.transact(label.replace('from Selected Primitives', ''), (tx) => tx.add(addPrimRecords(e.doc, [{ storage: 'Regions6', rec }])));
        e.invalidate();
      }),
    })),
    { id: 'ad:PCB:ConvertSelectedToPolygon', label: 'Create Polygon from Selected Primitives', scopes: PCB, enabled: () => !!board()?.selection.size, run: on(board, (e) => {
      const loop = selectedPrims(e).filter((p): p is PcbTrack | PcbArc => p.kind === 'track' || p.kind === 'arc');
      const v = shapeFromLoop(loop);
      if (typeof v === 'string') { notify(v, 'error'); return; }
      const bag = newPolygonBag(e.doc, loop[0]!.layer, NO_NET);
      writeVertices(bag, v);
      const i = e.doc.polygons.length;
      e.undo.transact('Create polygon from selected primitives', (tx) => { tx.add(addPolygon(e.doc, bag)); tx.add(repour(e.doc, i)); });
      e.invalidate();
    }) },
    { id: 'ad:PCB:AddSelectedPrimitivesToComponent', label: 'Add Selected Primitives to Component', scopes: PCB, enabled: () => !!board()?.selection.size, run: on(board, (e) => {
      const free = selectedPrims(e).filter((p) => 'component' in p && p.component === NO_NET && !('polygon' in p && p.polygon !== NO_NET));
      if (!free.length) { notify('Select free primitives to add', 'error'); return; }
      pick(e, 'Add Selected Primitives to Component: click the component', (raw) => {
        const c = e.componentAt(raw);
        if (c === null) return;
        const edits = free.map((p) => ({ storage: p.src.storage, index: p.src.index, after: retarget(e.doc.streams.get(p.src.storage)!.records[p.src.index]!, { component: c }) }));
        e.undo.transact(`Add ${plural(edits.length, 'primitive')} to ${e.doc.components[c]!.designator}`, (tx) => tx.add(replaceRecords(e.doc, edits)));
        e.setTool(null);
      });
    }) },
    { id: 'ad:PCB:TogglePrimitiveLock', label: 'Toggle Primitive Lock', scopes: BOTH, enabled: () => !!anyPcb()?.selection.size, run: on(anyPcb, (e) => {
      const ps = selectedPrims(e).filter((p) => 'locked' in p);
      if (!ps.length) return;
      const lock = !ps.every((p) => (p as { locked: boolean }).locked);
      const edits = ps.map((p) => ({ storage: p.src.storage, index: p.src.index, after: withLock(e.doc.streams.get(p.src.storage)!.records[p.src.index]!, lock) }));
      e.undo.transact(lock ? 'Lock primitives' : 'Unlock primitives', (tx) => tx.add(replaceRecords(e.doc, edits)));
      e.invalidate();
      notify(`${plural(edits.length, 'primitive')} ${lock ? 'locked' : 'unlocked'}`);
    }) },
    // Edit › Jump › selection: the view centres on each selected object in turn
    ...(['First', 'Last', 'Next', 'Previous'] as const).map((w): Command => ({
      id: `ad:PCB:Jump${w}Selection`, label: `Jump ${w}`, scopes: BOTH, enabled: () => !!anyPcb()?.selection.size, run: on(anyPcb, (e) => {
        const keys = [...e.selection].sort();
        if (!keys.length) return;
        const i = w === 'First' ? 0 : w === 'Last' ? keys.length - 1 : (keys.indexOf(jumpAt.get(e) ?? '') + (w === 'Next' ? 1 : -1) + keys.length) % keys.length;
        jumpAt.set(e, keys[i]!);
        const b = e.boundsOf([keys[i]!]);
        e.zoomToBox(b, mil(400));
      }),
    })),
    { id: 'ad:PCB:MeasureSelectedObjects', label: 'Measure Selected Objects', scopes: BOTH, enabled: () => !!anyPcb()?.selection.size, run: on(anyPcb, (e) => {
      const ps = selectedPrims(e).filter((p): p is PcbTrack | PcbArc => p.kind === 'track' || p.kind === 'arc');
      if (!ps.length) { notify('Select tracks and arcs to measure', 'error'); return; }
      const len = ps.reduce((a, p) => a + (p.kind === 'track' ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : (p.r * Math.PI * ((((p.end - p.start) % 360) + 360) % 360 || 360)) / 180), 0);
      const msg = `Total Routed Length Of Selected Objects = ${formatCoord(Math.round(len), units.value)} (${plural(ps.length, 'object')})`;
      notify(msg);
      replaceMessages('Measure Selected Objects', [{ doc: e.title(), level: 'info', message: msg }]);
    }) },
    // (each component moved goes in the report made when the command ends: Preferences › PCB Editor › Reports)
    { id: 'ad:PCB:MoveComponentOriginToGrid', label: 'Move Component Origin To Grid', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => {
      const lines: string[] = [];
      const u = units.value, f = (v: number) => formatCoord(v, u);
      const tool = new PickTool(e, 'Move Component Origin To Grid: click a component (right-click ends)', (p) => {
        const c = e.componentAt(p.raw); if (c === null) return false;
        const comp = e.doc.components[c]!, was = { ...comp.at }, o = e.origin();
        const keep = e.selection; e.selection = new Set(e.componentKeys(c)); e.alignToGrid(); e.selection = keep;
        const now = e.doc.components[c]!.at;
        if (now.x !== was.x || now.y !== was.y) lines.push(`${comp.designator}: (${f(was.x - o.x)}, ${f(was.y - o.y)}) to (${f(now.x - o.x)}, ${f(now.y - o.y)})`);
        e.invalidate();
        return false;
      }, true);
      (tool as unknown as { deactivate(): void }).deactivate = () => {
        if (lines.length) reportOut('originToGrid', 'Move Component Origin To Grid', [`Components moved to the grid (${lines.length}):`, '', ...lines].join('\n'), e);
      };
      e.setTool(tool);
    }) },
    { id: 'ad:PCB:PasteOnCurrentLayer', label: 'Paste On Current Layer', scopes: BOTH, enabled: () => !!anyPcb() && clipboard?.kind === 'pcb', run: on(anyPcb, (e) => {
      if (clipboard?.kind !== 'pcb') return;
      e.setTool(new PcbPasteTool(e, { ...clipboard, records: clipboard.records.map((r) => ({ storage: r.storage, rec: onLayer(r.rec, e.currentLayer) })) }));
    }) },
    // Design › Netlist › Clear All Nets: every object on No Net
    { id: 'ad:PCB:ClearAllNets', label: 'Clear All Nets...', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => {
      const n = e.doc.nets.length;
      if (!n) { notify('The board has no nets'); return; }
      showDialog(ConfirmDialog, { title: 'Confirm', message: `Clear all ${n} nets? Every object, pours included, is left on No Net.`, onYes: () => {
        e.selection.clear();
        e.highlightNet = null;
        e.undo.transact('Clear all nets', (tx) => tx.add(clearAllNets(e.doc)));
        e.invalidate();
        notify(`${plural(n, 'net')} cleared`);
      } });
    }) },
    // Design › Board Options (and the right-click Options › Board Options; in a library, its Library Options)
    ...['ad:PCB:DesignOptions', 'ad:PCB:PopupOptionsBoardOptions'].map((id): Command => ({
      id, label: 'Board Options...', scopes: id === 'ad:PCB:DesignOptions' ? PCB : BOTH, enabled: () => !!anyPcb(),
      run: on(anyPcb, (e) => { if (e instanceof PcbLibEditor) commands.get('ad:PCB:LibraryOptions')?.run(); else showDialog(BoardOptionsDialog, { ed: e }); }),
    })),
    // Reports
    { id: 'ad:PCB:ReportBoardInformation', label: 'Board Information...', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => reportOut('boardInfo', 'Board Information', boardInformation(e), e)) },
    { id: 'reports.netlistStatus', label: 'Netlist Status', scopes: PCB, enabled: () => !!board(), run: on(board, (e) => reportOut('netStatus', 'Netlist Status', netlistStatus(e), e)) },
  ];
}

const jumpAt = new WeakMap<PcbEditor, string>();

/** A region record's outline (for re-encoding a loop as a cutout). */
function decodeOutline(rec: PcbRawRecord): Vec2[] {
  const s = rec.subs[0]!, dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  let o = REGION.propsAt; o += 4 + (dv.getUint32(o, true) & 0x00ffffff);
  const n = dv.getUint32(o, true); o += 4;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++, o += 16) out.push({ x: Math.round(dv.getFloat64(o, true)), y: Math.round(dv.getFloat64(o + 8, true)) });
  return out;
}

/** Reports › Board Information: size, primitive counts, components, nets [est: Altium's report reads differently]. */
function boardInformation(e: PcbEditor): string {
  const d = e.doc, u = units.value, f = (v: number) => formatCoord(Math.round(v), u);
  const o = d.board.outline;
  const xs = o.map((p) => p.x), ys = o.map((p) => p.y);
  const count = (k: PcbPrim['kind']) => d.prims.filter((p) => p.kind === k).length;
  const pads = d.prims.filter((p): p is PcbPad => p.kind === 'pad');
  const lines = [
    `Board Information Report for ${d.name}`, `Date : ${new Date().toLocaleDateString(locale())}`, '',
    'General', `  Board size              ${o.length ? `${f(Math.max(...xs) - Math.min(...xs))} x ${f(Math.max(...ys) - Math.min(...ys))}` : 'no board shape'}`,
    `  Components              ${d.components.length} (${d.components.filter((c) => c.layer === L.TOP).length} top, ${d.components.filter((c) => c.layer === L.BOTTOM).length} bottom)`,
    `  Nets                    ${d.nets.length}`, `  Polygons                ${d.polygons.length}`, '',
    'Primitives',
    `  Arcs                    ${count('arc')}`, `  Fills                   ${count('fill')}`, `  Pads                    ${pads.length}`,
    `  Strings                 ${count('text')}`, `  Tracks                  ${count('track')}`, `  Vias                    ${count('via')}`,
    `  Regions                 ${count('region')}`, `  3D Bodies               ${count('body')}`, '',
    'Pads',
    `  With holes              ${pads.filter((p) => p.hole > 0).length}`, `  Surface mount           ${pads.filter((p) => !p.hole).length}`, '',
    'Layers in use', ...[...new Set(d.prims.flatMap((p) => ('layer' in p ? [p.layer] : [])))].sort((a, b) => a - b).map((l) => `  ${d.board.layerNames.get(l) ?? layerName(l)}`),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** Reports › Netlist Status: each net, its nodes (pads) and routed length. */
function netlistStatus(e: PcbEditor): string {
  const d = e.doc, u = units.value;
  const rows = d.nets.map((n) => {
    const nodes = d.prims.filter((p) => p.kind === 'pad' && p.net === n.index).length;
    const len = d.prims.reduce((a, p) => a + (p.kind === 'track' && p.net === n.index && p.polygon === NO_NET ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y)
      : p.kind === 'arc' && p.net === n.index && p.polygon === NO_NET ? (p.r * Math.PI * ((((p.end - p.start) % 360) + 360) % 360 || 360)) / 180 : 0), 0);
    return { name: n.name, nodes, len };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const w = Math.max(12, ...rows.map((r) => r.name.length + 2));
  return [`Nets report for ${d.name}`, `On ${new Date().toLocaleDateString(locale())}`, '', `${'Net'.padEnd(w)}${'Nodes'.padStart(6)}  Signal Length`,
    ...rows.map((r) => `${r.name.padEnd(w)}${String(r.nodes).padStart(6)}  ${formatCoord(Math.round(r.len), u)}`), '', `${rows.length} nets`, ''].join('\r\n');
}

