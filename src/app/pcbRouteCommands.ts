/**
 * 26.038's routing and copper commands: Interactive Differential Pair Routing, Multi-Routing,
 * Length Tuning (single and pair), Equalise Net Lengths, Gloss / Retrace Selected, Convert
 * Selected Tracks to Chamfered Path, Clean All / Single Nets, Re-Route, Move / Resize Tracks,
 * Toggle Routing Modes, Teardrops, Via Stitching and Shielding (and their removal), Shove and
 * Set Shove Depth, the polygon actions (Slice, Combine, Subtract, Modify Border, Resize, Bring To
 * Front / Send To Back, Repour Modified / Violating), jumpers shown and hidden, and pin, part
 * and differential-pair swapping.
 */
import type { Command, Scope } from '../core/commands';
import { active, docs, notify, projects } from './state';
import { showDialog } from './dialogs';
import { ConfirmDialog, InfoDialog } from './dialogs/Confirm';
import {
  NumberDialog, PinSwapConfigDialog, ShieldingDialog, StitchingDialog,
} from './dialogs/RouteTools';
import { TeardropsDialog, type TeardropChoice } from './dialogs/TeardropsDialog';
import { ReportDialog } from './dialogs/Hierarchy';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { BusRouteTool } from '../editors/pcb/BusRouteTool';
import { LengthTuneTool } from '../editors/pcb/LengthTuneTool';
import { ModifyBorderTool, MoveTracksTool, ReRouteTool, TwoPadTool } from '../editors/pcb/RouteEditTools';
import { TwoPointTool } from '../editors/pcb/PcbEditTools';
import { PickTool } from '../editors/Editor';
import { commitMove } from '../editors/pcb/PcbMoveTool';
import { placement } from '../formats/altium/pcbTransform';
import { ROUTE_MODES } from '../editors/pcb/RouteTool';
import { settings, updateSettings } from '../core/settings';
import { formatCoord, mil } from '../core/units';
import { count } from '../core/words';
import { layerName } from '../model/layers';
import { encodeRegion } from '../formats/altium/pcbdoc';
import { setPolygonName } from '../formats/altium/polygonProps';
import { autoPolygonName } from './dialogs/Polygon';
import {
  addPolygon, addPrimRecords, addVias, removePolygons, removePrims, repour, replaceRecords, setComponentProps, setNetProps, setPolygon,
} from '../model/pcbEdit';
import { chamferedPaths, cleanNets, gloss, replaceTracks, retrace, strayCopper } from '../model/trackOps';
import { equaliseNetLengths } from '../model/tuneEdit';
import { findTeardrops } from '../model/teardrops';
import { planTeardropRegions, teardropRegions, teardropsAt, type TeardropKind } from '../model/teardropRegions';
import { planShielding, planStitching, shieldGroup, stitchGroup } from '../model/viaStitch';
import { combinePolygons, pourOrder, resizePolygon, slicePolygon, subtractPolygons, withOutline } from '../model/polygonOps';
import { canSwapPins, optimisePins, pairSwap, partSwap, setPadNets } from '../model/pinSwap';
import { computePour } from '../model/pour';
import { runDrc } from '../model/drc';
import { NO_NET, netName, type PcbDocument, type PcbPad, type PcbPrim, type PcbTrack, type PcbVia } from '../model/pcb';
import type { BBox, Vec2 } from '../core/geom';
import type { Change } from '../core/undo';

const PCB: Scope[] = ['pcb'];
const BOTH: Scope[] = ['pcb', 'pcblib'];
const board = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };
const anyBoard = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };
const on = (fn: (e: PcbEditor) => void) => () => { const e = board(); if (e) fn(e); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const selectedPrims = (e: PcbEditor): PcbPrim[] => [...new Set([...e.selection].map((k) => e.primByKey(k)).filter((p): p is PcbPrim => !!p))];
const selectedTracks = (e: PcbEditor) => selectedPrims(e).filter((p): p is PcbTrack => p.kind === 'track');
/** The object under the right-click, or the cursor. */
const objectAt = (e: PcbEditor, raw: Vec2) => e.hits(raw).map((h) => e.primByKey(h.key)).find((p): p is PcbPrim => !!p);

/* ── Shove ── */

let shoveDepth = 5;

/** Tools › Component Placement › Shove: the components overlapping one (with the Component Clearance gap) move out of its way, and so on to the Shove Depth. */
function shoveFrom(e: PcbEditor, c0: number): number {
  e.scene();
  const doc = e.doc;
  const box = (c: number): BBox => e.boundsOf(e.componentKeys(c).filter((k) => e.primByKey(k)?.kind !== 'text'));
  const gap = mil(10);
  const boxes = new Map(doc.components.map((_, i) => [i, box(i)]));
  const side = (c: number) => doc.components[c]!.layer;
  const moved = new Map<number, Vec2>();
  let wave = [c0];
  const fixed = new Set([c0]);
  for (let depth = 0; depth < shoveDepth && wave.length; depth++) {
    const next: number[] = [];
    for (const c of wave) {
      const b = boxes.get(c)!;
      if (!(b.minX <= b.maxX)) continue;
      for (const [o, ob] of boxes) {
        if (fixed.has(o) || side(o) !== side(c) || !(ob.minX <= ob.maxX) || doc.components[o]!.bag.bool('LOCKED')) continue;
        const ox = Math.min(b.maxX + gap - ob.minX, ob.maxX + gap - b.minX), oy = Math.min(b.maxY + gap - ob.minY, ob.maxY + gap - b.minY);
        if (ox <= 0 || oy <= 0) continue;
        // Out the shorter way, away from the pusher's centre
        const cx = (b.minX + b.maxX) / 2 - (ob.minX + ob.maxX) / 2, cy = (b.minY + b.maxY) / 2 - (ob.minY + ob.maxY) / 2;
        const d = ox <= oy ? { x: cx > 0 ? -(ob.maxX + gap - b.minX) : b.maxX + gap - ob.minX, y: 0 } : { x: 0, y: cy > 0 ? -(ob.maxY + gap - b.minY) : b.maxY + gap - ob.minY };
        const m = moved.get(o) ?? { x: 0, y: 0 };
        moved.set(o, { x: m.x + d.x, y: m.y + d.y });
        boxes.set(o, { minX: ob.minX + d.x, maxX: ob.maxX + d.x, minY: ob.minY + d.y, maxY: ob.maxY + d.y });
        fixed.add(o);
        next.push(o);
      }
    }
    wave = next;
  }
  if (!moved.size) return 0;
  e.undo.transact('Shove', () => {
    for (const [c, d] of moved) commitMove(e, { components: [c], polygons: [], prims: [] }, placement({ x: 0, y: 0 }, 0, { x: Math.round(d.x), y: Math.round(d.y) }), 0, 'move');
  });
  e.invalidate();
  return moved.size;
}

/* ── Teardrops ── */

/** What a teardrop's kind is called in the report. */
const TEARDROP_NAMES: Record<TeardropKind, string> = { via: 'Via', pad: 'Through-hole pad', smd: 'SMD pad', tracks: 'Tracks', tJunction: 'T-junction' };

function teardrops(e: PcbEditor, c: TeardropChoice): void {
  const doc = e.doc, sel = new Set(selectedPrims(e));
  if (!c.add) {
    // The teardrops (regions marked as such), and those of earlier builds: short tracks and arcs, found by their shape
    const regions = c.selectedOnly ? teardropsAt(doc, sel) : teardropRegions(doc);
    const old = findTeardrops(doc).filter((p) => !c.selectedOnly || sel.has(p) || [...sel].some((s) => (s.kind === 'pad' || s.kind === 'via') && 'net' in s && s.net === p.net));
    const drops: PcbPrim[] = [...regions, ...old];
    if (!drops.length) { notify(c.selectedOnly ? 'The selected objects have no teardrops' : 'No teardrops to remove'); return; }
    e.undo.transact('Remove teardrops', (tx) => tx.add(removePrims(doc, drops)));
    notify(old.length ? `${count(regions.length, 'teardrop')} and ${count(old.length, 'teardrop track')} removed` : `${count(regions.length, 'teardrop')} removed`);
    return;
  }
  const plan = planTeardropRegions(doc, c.settings, c.selectedOnly ? sel : undefined);
  if (plan.made.length) {
    e.undo.transact('Teardrops', (tx) => tx.add(addPrimRecords(doc, plan.made.map((t) => ({ storage: 'Regions6', rec: encodeRegion({ layer: t.layer, outline: t.outline, net: t.net === NO_NET ? undefined : t.net, teardrop: true }) })))));
  }
  if (c.settings.report) {
    const u = e.units(), o = e.origin(), f = (v: number) => formatCoord(v, u), xy = (p: Vec2) => `${f(p.x - o.x).padStart(12)} ${f(p.y - o.y).padStart(12)}`;
    const od = docs.value.find((d) => d.editor === e);
    const project = od?.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null;
    const WHY = { clearance: 'too close to other copper', room: 'no room on the track' };
    const text = [
      `Teardrops: ${od?.name ?? 'board'}`, '',
      `Made: ${plan.made.length}${plan.smaller ? ` (${plan.smaller} smaller than the size set)` : ''}`,
      `Not made: ${plan.failed.length}`, '',
      ...(plan.made.length ? ['Made', `${'Kind'.padEnd(18)}${'Layer'.padEnd(18)}${'Net'.padEnd(22)}${'X'.padStart(12)} ${'Y'.padStart(12)}`,
        ...plan.made.map((t) => `${TEARDROP_NAMES[t.kind].padEnd(18)}${layerName(t.layer).padEnd(18)}${(t.net === NO_NET ? 'No Net' : netName(doc, t.net)).padEnd(22)}${xy(t.at)}`), ''] : []),
      ...(plan.failed.length ? ['Not made', `${'Kind'.padEnd(18)}${'X'.padStart(12)} ${'Y'.padStart(12)}   Why`,
        ...plan.failed.map((t) => `${TEARDROP_NAMES[t.kind].padEnd(18)}${xy(t.at)}   ${WHY[t.why]}`)] : []),
    ].join('\r\n');
    showDialog(ReportDialog, { title: 'Teardrops', name: 'Teardrops.txt', text, project });
    return;
  }
  if (!plan.made.length) { notify(plan.failed.length ? `No teardrops made: ${count(plan.failed.length, 'joint')} had no room for one` : 'No joints to make teardrops at'); return; }
  const made = count(plan.made.length, 'teardrop');
  notify(plan.smaller && plan.failed.length ? `${made} made, ${plan.smaller} of them smaller than the size set; ${count(plan.failed.length, 'joint')} had no room for one`
    : plan.smaller ? `${made} made, ${plan.smaller} of them smaller than the size set`
      : plan.failed.length ? `${made} made; ${count(plan.failed.length, 'joint')} had no room for one` : `${made} made`);
}

/* ── Polygons ── */

/** Replace a pour by pieces: the first keeps its definition, the others become new pours alike; all repoured. */
function replaceByPieces(e: PcbEditor, index: number, pieces: Vec2[][], label: string, extra?: (tx: { add(c: Change): void }) => void): void {
  const doc = e.doc, poly = doc.polygons[index]!;
  e.undo.transact(label, (tx) => {
    extra?.(tx);
    tx.add(setPolygon(doc, index, withOutline(poly.bag, pieces[0]!)));
    tx.add(repour(doc, index));
    for (const p of pieces.slice(1)) {
      const b = withOutline(poly.bag, p);
      const n = doc.polygons.length;
      setPolygonName(b, autoPolygonName(doc, poly.layer, poly.net, n));
      b.set('POURINDEX', String(n));
      b.delete?.('UNIQUEID');
      tx.add(addPolygon(doc, b));
      tx.add(repour(doc, n));
    }
  });
}

/** The pour picked at a point: by its outline or its copper. */
function polygonAt(e: PcbEditor, raw: Vec2): number | null {
  for (const h of e.hits(raw)) { if (h.key.startsWith('poly:')) return Number(h.key.slice(5)); const p = e.primByKey(h.key); if (p && 'polygon' in p && p.polygon !== NO_NET) return p.polygon; }
  return null;
}

const regionArea = (pts: Vec2[]) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]!; return s + p.x * q.y - q.x * p.y; }, 0) / 2);
/** A pour's copper as it is, against what a repour would give (count and area). */
function pourChanged(doc: PcbDocument, i: number): boolean {
  const poly = doc.polygons[i]!;
  const now = doc.prims.filter((p) => 'polygon' in p && p.polygon === i);
  const r = computePour(doc, poly);
  const areaNow = now.reduce((s, p) => s + (p.kind === 'region' ? regionArea(p.outline) - p.holes.reduce((h, x) => h + regionArea(x), 0) : 0), 0);
  const areaNew = r.regions.reduce((s, x) => s + regionArea(x.outline) - x.holes.reduce((h, y) => h + regionArea(y), 0), 0);
  const regionsNow = now.filter((p) => p.kind === 'region').length;
  return regionsNow !== r.regions.length || Math.abs(areaNow - areaNew) > Math.max(1e8, areaNew * 1e-4) || now.filter((p) => p.kind === 'track').length !== r.tracks.length;
}

/* ── Jumpers ── */

function setJumpers(e: PcbEditor, visible: boolean, which: { comps?: number[]; nets?: number[] }): void {
  const doc = e.doc, v = visible ? 'TRUE' : 'FALSE';
  const comps = (which.comps ?? []).filter((c) => doc.components[c]?.bag.get('JUMPERSVISIBLE') !== v);
  const nets = (which.nets ?? []).filter((n) => doc.nets[n]?.bag.get('JUMPERSVISIBLE') !== v);
  if (!comps.length && !nets.length) return;
  e.undo.transact(`${visible ? 'Show' : 'Hide'} jumpers`, (tx) => {
    for (const c of comps) tx.add(setComponentProps(doc, c, { JUMPERSVISIBLE: v }));
    if (nets.length) tx.add(setNetProps(doc, nets.map((index) => ({ index, props: { JUMPERSVISIBLE: v } }))));
  });
  e.invalidate();
}
const jumperComps = (doc: PcbDocument) => doc.components.map((c, i) => (c.bag.int('COMPONENTKIND') === 6 ? i : -1)).filter((i) => i >= 0);

/* ── Swapping ── */

function swapNets(e: PcbEditor, moves: { pad: PcbPad; net: number }[], label: string): void {
  const edits = setPadNets(e.doc, moves);
  if (!edits.length) return;
  e.undo.transact(label, (tx) => tx.add(replaceRecords(e.doc, edits)));
  e.invalidate();
  notify(`${label}: ${plural(moves.length, 'pad')} changed net (routing on them is as it was)`);
}

export function pcbRouteCommands(): Command[] {
  const hasTracks = () => !!board() && selectedTracks(board()!).length > 0;
  const routeTool = (kind: 'pair' | 'multi') => on((e) => e.setTool(new BusRouteTool(e, kind)));
  const tune = (pair: boolean) => on((e) => e.setTool(new LengthTuneTool(e, pair)));
  const showHide = (visible: boolean, scope: 'all' | 'net' | 'component') => on((e) => {
    if (scope === 'all') { setJumpers(e, visible, { comps: jumperComps(e.doc), nets: e.doc.nets.map((n) => n.index) }); return; }
    e.setTool(new PickTool(e, `${visible ? 'Show' : 'Hide'} ${scope === 'net' ? 'Net' : 'Component'} Jumpers: click ${scope === 'net' ? 'an object of the net' : 'a component'}`, (p) => {
      if (scope === 'component') { const c = e.componentAt(p.raw); if (c === null) return false; setJumpers(e, visible, { comps: [c] }); return true; }
      const o = objectAt(e, p.raw);
      if (!o || !('net' in o) || o.net === NO_NET) return false;
      setJumpers(e, visible, { nets: [o.net] });
      return true;
    }));
  });
  const sliceCmd = (id: string) => ({ id, label: 'Slice Polygon Pour', scopes: PCB, enabled: () => !!board()?.doc.polygons.length, run: on((e) => {
    e.setTool(new TwoPointTool(e, 'slice-polygon', ['Slice Polygon Pour: click where the slice line starts', 'Slice Polygon Pour: click where it ends'], (a, b) => {
      e.setTool(null);
      const hits = e.doc.polygons.map((p) => ({ p, pieces: slicePolygon(p, a, b) })).filter((x) => x.pieces.length > 1);
      if (!hits.length) { notify('The line must cross a pour from edge to edge', 'error'); return; }
      e.undo.transact('Slice polygon pour', () => { for (const h of hits) replaceByPieces(e, h.p.index, h.pieces, 'Slice polygon pour'); });
      notify(`${plural(hits.length, 'pour')} sliced`);
    }));
  }) });
  const swapTool = (id: string, label: string, plan: (e: PcbEditor, a: PcbPad, b: PcbPad) => { moves: { pad: PcbPad; net: number }[]; why?: string | null }) =>
    ({ id, label, scopes: PCB, enabled: () => !!board()?.doc.components.length, run: on((e) => e.setTool(new TwoPadTool(e, id, label, (a, b) => {
      const r = plan(e, a, b);
      if (r.why || !r.moves.length) return r.why ?? 'nothing to swap';
      swapNets(e, r.moves, label);
      return null;
    }))) });
  const configSwap = on((e) => showDialog(PinSwapConfigDialog, { ed: e }));

  return [
    /* ── routing ── */
    { id: 'route.diffPair', label: 'Interactive Differential Pair Routing', scopes: PCB, enabled: () => !!board(), run: routeTool('pair') },
    { id: 'route.multi', label: 'Interactive Multi-Routing', scopes: PCB, enabled: () => !!board(), run: on((e) => {
      const n = selectedPrims(e).filter((p) => (p.kind === 'pad' || p.kind === 'track' || p.kind === 'via') && 'net' in p && p.net !== NO_NET).length;
      if (n < 2) { notify('Select the pads or track ends to route first (two or more)', 'error'); return; }
      e.setTool(new BusRouteTool(e, 'multi'));
    }) },
    { id: 'route.length', label: 'Interactive Length Tuning', scopes: PCB, enabled: () => !!board(), run: tune(false) },
    { id: 'ad:PCB:InteractiveDiffPairLengthTuning', label: 'Interactive Diff Pair Length Tuning', scopes: PCB, enabled: () => !!board()?.doc.diffPairs?.length, run: tune(true) },
    { id: 'ad:PCB:EqualizeNetLengths', label: 'Equalise Net Lengths', scopes: PCB, enabled: () => !!board(), run: on((e) => {
      let report: ReturnType<typeof equaliseNetLengths> | null = null;
      e.undo.transact('Equalise net lengths', (tx) => { report = equaliseNetLengths(e.doc, (c) => tx.add(c)); });
      const r = report as ReturnType<typeof equaliseNetLengths> | null;
      if (!r || !r.nets.length) { notify('No Matched Lengths rule has nets to lengthen'); return; }
      const u = e.units(), f = (c: number) => formatCoord(c, u);
      const od = docs.value.find((d) => d.editor === e);
      const project = od?.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null;
      const text = [`Equalise Net Lengths: ${plural(r.nets.length, 'net')} lengthened${r.short ? `, ${r.short} still short of the target` : ''}`, '',
        ...r.nets.map((n) => `${n.name.padEnd(24)} ${f(n.before).padStart(14)} -> ${f(n.after).padStart(14)}   target ${f(n.target)}`)].join('\r\n');
      showDialog(ReportDialog, { title: 'Equalise Net Lengths', name: 'Equalise Net Lengths.txt', text, project });
    }) },
    { id: 'ad:PCB:Gloss', label: 'Gloss Selected', scopes: BOTH, enabled: hasTracks, run: on((e) => {
      const r = gloss(e.doc, selectedTracks(e));
      if (!r.changed) { notify('Nothing to gloss: the selected routes are as tight as they go'); return; }
      e.undo.transact('Gloss selected', (tx) => replaceTracks(e.doc, r.remove, r.add, [], (c) => tx.add(c)));
      notify(`${plural(r.changed, 'route')} glossed`);
    }) },
    { id: 'ad:PCB:Retrace', label: 'Retrace Selected', scopes: BOTH, enabled: () => !!board() && selectedPrims(board()!).some((p) => p.kind === 'track' || p.kind === 'via'), run: on((e) => {
      const r = retrace(e.doc, selectedPrims(e));
      if (!r.edits.length) { notify(r.skipped ? `No room to retrace (${r.skipped} would break clearance)` : 'The selected routes already follow the rules'); return; }
      e.undo.transact('Retrace selected', (tx) => tx.add(replaceRecords(e.doc, r.edits)));
      notify(`${plural(r.edits.length, 'object')} retraced${r.skipped ? `, ${r.skipped} left: no room` : ''}`);
    }) },
    { id: 'ad:PCB:MakeMicrostripe', label: 'Convert Selected Tracks to Chamfered Path', scopes: PCB, enabled: hasTracks, run: on((e) => {
      showDialog(NumberDialog, { title: 'Chamfered Path', label: 'Chamfer (of the width)', value: 50, unit: '%', onOk: (pct: number) => {
        const r = chamferedPaths(e.doc, selectedTracks(e), Math.max(0, pct) / 100);
        if (!r.regions.length) return;
        e.undo.transact('Convert to chamfered path', (tx) => replaceTracks(e.doc, r.remove, [], r.regions, (c) => tx.add(c)));
        notify(`${plural(r.regions.length, 'chamfered path')} made`);
      } });
    }) },
    { id: 'ad:PCB:CleanUpNets', label: 'Clean All Nets...', scopes: PCB, enabled: () => !!board(), run: on((e) => {
      const n = strayCopper(e.doc).length;
      if (!n) { showDialog(InfoDialog, { title: 'Clean All Nets', lines: ['All copper with a net is joined to a pad of its net.'] }); return; }
      showDialog(ConfirmDialog, { title: 'Clean All Nets', message: `${plural(n, 'object')} with a net reach no pad of it. Take them off their nets?`, onYes: () => {
        e.undo.transact('Clean all nets', (tx) => tx.add(replaceRecords(e.doc, cleanNets(e.doc))));
        e.invalidate();
      } });
    }) },
    { id: 'ad:PCB:CleanUpSingleNets', label: 'Clean Single Nets...', scopes: PCB, enabled: () => !!board(), run: on((e) => {
      e.setTool(new PickTool(e, 'Clean Single Net: click an object of the net', (p) => {
        const o = objectAt(e, p.raw);
        if (!o || !('net' in o) || o.net === NO_NET) return false;
        const edits = cleanNets(e.doc, new Set([o.net]));
        if (!edits.length) { notify(`Everything on ${e.doc.nets[o.net]?.name} reaches its pads`); return true; }
        e.undo.transact('Clean single net', (tx) => tx.add(replaceRecords(e.doc, edits)));
        notify(`${plural(edits.length, 'object')} taken off ${e.doc.nets[o.net]?.name}`);
        return true;
      }, true));
    }) },
    { id: 'ad:PCB:MoveReRoute', label: 'Re-Route', scopes: PCB, enabled: () => !!board(), run: on((e) => e.setTool(new ReRouteTool(e))) },
    { id: 'ad:PCB:GroupResizeTracks', label: 'Move / Resize Tracks', scopes: PCB, enabled: hasTracks, run: on((e) => e.setTool(new MoveTracksTool(e, selectedTracks(e).filter((t) => t.component === NO_NET && t.polygon === NO_NET && !t.locked)))) },
    { id: 'ad:PCB:ToggleRoutingModes', label: 'Toggle Routing Modes', scopes: PCB, enabled: () => !!board(), run: () => {
      const enabled = ROUTE_MODES.filter(([, , k]) => settings[k]).map(([m]) => m);
      const list = enabled.length ? enabled : ROUTE_MODES.map(([m]) => m);
      const next = list[(list.indexOf(settings.pcbRoutingMode) + 1) % list.length]!;
      updateSettings({ pcbRoutingMode: next });
      notify(`Routing: ${ROUTE_MODES.find(([m]) => m === next)?.[1]}`);
    } },
    { id: 'ad:PCB:TearDrops', label: 'Teardrops...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(TeardropsDialog, { selected: selectedPrims(e).length, onOk: (c: TeardropChoice) => teardrops(e, c) })) },

    /* ── stitching and shielding ── */
    { id: 'ad:PCB:ViaStitchingFlood', label: 'Add Stitching to Net...', scopes: PCB, enabled: () => !!board()?.doc.board.outline.length, run: on((e) => showDialog(StitchingDialog, { ed: e, onOk: (o: Parameters<typeof planStitching>[1]) => {
      const vias = planStitching(e.doc, o);
      if (!vias.length) { notify('No room for stitching vias', 'error'); return; }
      e.undo.transact('Add stitching to net', (tx) => { tx.add(addVias(e.doc, vias)); for (const p of e.doc.polygons) tx.add(repour(e.doc, p.index)); });
      notify(`${plural(vias.length, 'stitching via')} added`);
    } })) },
    { id: 'ad:PCB:ViaShielding', label: 'Add Shielding to Net...', scopes: PCB, enabled: () => !!board(), run: on((e) => {
      const t = selectedTracks(e)[0];
      showDialog(ShieldingDialog, { ed: e, shielded: t?.net ?? NO_NET, onOk: (o: Parameters<typeof planShielding>[1]) => {
        const vias = planShielding(e.doc, o);
        if (!vias.length) { notify('No room for shielding vias', 'error'); return; }
        e.undo.transact('Add shielding to net', (tx) => { tx.add(addVias(e.doc, vias)); for (const p of e.doc.polygons) tx.add(repour(e.doc, p.index)); });
        notify(`${plural(vias.length, 'shielding via')} added`);
      } });
    }) },
    ...([['ad:PCB:ViaStitchingRemove', 'Remove Via Stitching Group', stitchGroup], ['ad:PCB:ViaShieldingRemove', 'Remove Via Shielding Group', shieldGroup]] as const).map(([id, label, group]): Command => ({
      id, label, scopes: PCB, enabled: () => !!board()?.doc.prims.some((p) => p.kind === 'via'), run: on((e) => e.setTool(new PickTool(e, `${label}: click a via of the group`, (p) => {
        const v = e.hits(p.raw).map((h) => e.primByKey(h.key)).find((x): x is PcbVia => x?.kind === 'via');
        if (!v) return false;
        const vias = group(e.doc, v);
        e.undo.transact(label, (tx) => tx.add(removePrims(e.doc, vias)));
        notify(`${plural(vias.length, 'via')} removed`);
        return true;
      }))),
    })),

    /* ── shove ── */
    { id: 'ad:PCB:ShoveComponents', label: 'Shove', scopes: PCB, enabled: () => !!board()?.doc.components.length, run: on((e) => e.setTool(new PickTool(e, `Shove (depth ${shoveDepth}): click a component`, (p) => {
      const c = e.componentAt(p.raw);
      if (c === null) return false;
      const n = shoveFrom(e, c);
      notify(n ? `${plural(n, 'component')} shoved` : 'Nothing overlaps it');
      return false;
    }, true))) },
    { id: 'ad:PCB:SetShoveDepth', label: 'Set Shove Depth...', scopes: PCB, enabled: () => !!board(), run: () => showDialog(NumberDialog, { title: 'Shove Depth', label: 'Shove Depth', value: shoveDepth, onOk: (v: number) => { shoveDepth = Math.max(1, Math.min(1000, Math.round(v))); } }) },

    /* ── polygons ── */
    sliceCmd('ad:PCB:CutPolygonPlane'),
    sliceCmd('ad:PCB:CutSinglePolygonPlane'),
    { id: 'ad:PCB:CombinePolygons', label: 'Combine Selected Polygons', scopes: PCB, enabled: () => (board()?.selectedPolygons().length ?? 0) > 1, run: on((e) => {
      const sel = e.selectedPolygons().map((i) => e.doc.polygons[i]!);
      if (new Set(sel.map((p) => p.layer)).size > 1) { notify('The pours must be on one layer', 'error'); return; }
      const pieces = combinePolygons(sel);
      if (pieces.length !== 1) { notify('The pours must overlap or touch', 'error'); return; }
      const keep = sel[0]!.index, drop = sel.slice(1).map((p) => p.index);
      e.undo.transact('Combine polygons', (tx) => {
        tx.add(setPolygon(e.doc, keep, withOutline(sel[0]!.bag, pieces[0]!)));
        tx.add(removePolygons(e.doc, drop));
        // Pours after a removed one move down the list
        tx.add(repour(e.doc, keep - drop.filter((d) => d < keep).length));
      });
      e.select([]);
    }) },
    { id: 'ad:PCB:SubtractPolygons', label: 'Subtract Polygons From Selected', scopes: PCB, enabled: () => !!board()?.selectedPolygons().length, run: on((e) => {
      const sel = new Set(e.selectedPolygons());
      let n = 0;
      e.undo.transact('Subtract polygons', () => {
        for (const i of [...sel].sort((a, b) => b - a)) {
          const p = e.doc.polygons[i]!;
          const others = e.doc.polygons.filter((o) => !sel.has(o.index) && o.layer === p.layer);
          const pieces = subtractPolygons(p, others);
          if (!pieces.length || (pieces.length === 1 && Math.abs(regionArea(pieces[0]!) - regionArea(p.outline)) < 1e6)) continue;
          replaceByPieces(e, i, pieces, 'Subtract polygons');
          n++;
        }
      });
      notify(n ? `${plural(n, 'pour')} cut back` : 'No other pour overlaps the selected ones');
    }) },
    { id: 'ad:PCB:ModifyPolygonBorder', label: 'Modify Polygon Border', scopes: PCB, enabled: () => !!board()?.doc.polygons.length, run: on((e) => e.setTool(new ModifyBorderTool(e))) },
    { id: 'ad:PCB:PolygonEditSize', label: 'Resize Polygon', scopes: PCB, enabled: () => !!board()?.doc.polygons.length, run: on((e) => {
      const go = (i: number) => showDialog(NumberDialog, { title: 'Resize Polygon', label: 'Expansion', value: mil(10), length: true, ed: e, onOk: (by: number) => {
        const pieces = resizePolygon(e.doc.polygons[i]!, by);
        if (!pieces.length) { notify('Nothing would be left of the pour', 'error'); return; }
        replaceByPieces(e, i, pieces, 'Resize polygon');
      } });
      const sel = e.selectedPolygons();
      if (sel.length === 1) { go(sel[0]!); return; }
      e.setTool(new PickTool(e, 'Resize Polygon: click a pour', (p) => { const i = polygonAt(e, p.raw); if (i === null) return false; go(i); return true; }));
    }) },
    ...([['ad:PCB:BringPolygonsToFront', 'Bring to front', true], ['ad:PCB:SendPolygonsToBack', 'Send to back', false]] as const).map(([id, label, front]): Command => ({
      id, label, scopes: PCB, enabled: () => !!board()?.selectedPolygons().length, run: on((e) => {
        const order = pourOrder(e.doc, new Set(e.selectedPolygons()), front);
        e.undo.transact(label, (tx) => {
          for (const [i, k] of order) {
            if (e.doc.polygons[i]!.bag.int('POURINDEX', -1) === k) continue;
            const b = e.doc.polygons[i]!.bag.clone(); b.set('POURINDEX', String(k));
            tx.add(setPolygon(e.doc, i, b));
          }
          // Repoured in the new order
          for (const i of [...order].sort((a, b) => a[1] - b[1]).map(([i]) => i)) tx.add(repour(e.doc, i));
        });
      }),
    })),
    { id: 'ad:PCB:RepourModified', label: 'Repour Modified', scopes: PCB, enabled: () => !!board()?.doc.polygons.length, run: on((e) => {
      const which = e.doc.polygons.filter((p) => !p.bag.bool('SHELVED') && pourChanged(e.doc, p.index)).map((p) => p.index);
      if (!which.length) { notify('Every pour is up to date'); return; }
      e.repourPolygons(which);
      notify(`${plural(which.length, 'pour')} repoured`);
    }) },
    { id: 'ad:PCB:RepourViolatingPolygons', label: 'Repour Violating Polygons', scopes: PCB, enabled: () => !!board()?.doc.polygons.length, run: on((e) => {
      const r = runDrc(e.doc, new Set(['Clearance', 'ShortCircuit']));
      const which = new Set<number>();
      for (const v of r.violations) for (const i of v.prims) { const p = e.doc.prims[i]; if (p && 'polygon' in p && p.polygon !== NO_NET) which.add(p.polygon); }
      if (!which.size) { notify('No pour breaks a rule'); return; }
      e.repourPolygons([...which]);
      notify(`${plural(which.size, 'pour')} repoured`);
    }) },

    /* ── jumpers ── */
    { id: 'ad:PCB:ShowAllJumpers', label: 'Show All Jumpers', scopes: PCB, enabled: () => !!board(), run: showHide(true, 'all') },
    { id: 'ad:PCB:HideAllJumpers', label: 'Hide All Jumpers', scopes: PCB, enabled: () => !!board(), run: showHide(false, 'all') },
    { id: 'ad:PCB:ShowNetJumpers', label: 'Show Net Jumpers', scopes: PCB, enabled: () => !!board(), run: showHide(true, 'net') },
    { id: 'ad:PCB:HideNetJumpers', label: 'Hide Net Jumpers', scopes: PCB, enabled: () => !!board(), run: showHide(false, 'net') },
    { id: 'ad:PCB:ShowComponentJumpers', label: 'Show Component Jumpers', scopes: PCB, enabled: () => !!board(), run: showHide(true, 'component') },
    { id: 'ad:PCB:HideComponentJumpers', label: 'Hide Component Jumpers', scopes: PCB, enabled: () => !!board(), run: showHide(false, 'component') },
    { id: 'ad:PCB:PopupShowJumpersAll', label: 'All', scopes: PCB, enabled: () => !!board(), run: showHide(true, 'all') },
    { id: 'ad:PCB:PopupHideJumpersAll', label: 'All', scopes: PCB, enabled: () => !!board(), run: showHide(false, 'all') },
    { id: 'ad:PCB:PopupShowJumpersNet', label: 'Net', scopes: PCB, enabled: () => !!board(), run: showHide(true, 'net') },
    { id: 'ad:PCB:PopupHideJumpersNet', label: 'Net', scopes: PCB, enabled: () => !!board(), run: showHide(false, 'net') },
    { id: 'ad:PCB:PopupShowJumpersOnComponent', label: 'On Component', scopes: PCB, enabled: () => !!board(), run: showHide(true, 'component') },
    { id: 'ad:PCB:PopupHideJumpersOnComponent', label: 'On Component', scopes: PCB, enabled: () => !!board(), run: showHide(false, 'component') },

    /* ── swapping ── */
    { id: 'ad:PCB:ConfigurePinSwap', label: 'Configure...', scopes: PCB, enabled: () => !!board()?.doc.components.length, run: configSwap },
    { id: 'ad:PCB:ConfigurePinSwapWithContext', label: 'Configure Pin/Part Swapping...', scopes: PCB, enabled: () => !!board()?.doc.components.length, run: configSwap },
    swapTool('ad:PCB:RunManualPinSwap', 'Interactive Pin/Net Swapping', (e, a, b) => { const why = canSwapPins(e.doc, a, b); return why ? { moves: [], why } : { moves: [{ pad: a, net: b.net }, { pad: b, net: a.net }] }; }),
    swapTool('ad:PCB:RunManualPartSwap', 'Interactive Part Swapping', (e, a, b) => partSwap(e.doc, a, b)),
    swapTool('ad:PCB:RunManualDifferentialPairSwap', 'Interactive Differential-Pair Swapping', (e, a, b) => pairSwap(e.doc, a, b)),
    { id: 'ad:PCB:RunAutoPinSwap', label: 'Automatic Net/Pin Optimiser...', scopes: PCB, enabled: () => !!board()?.doc.components.length, run: on((e) => {
      showDialog(ConfirmDialog, { title: 'Automatic Net/Pin Optimiser', message: 'Swap pads within their pin swap groups to shorten the connections?', detail: 'Only components with pin swapping on (Tools › Pin/Part Swapping › Configure) take part.', onYes: () => {
        const r = optimisePins(e.doc);
        if (!r.moves.length) { notify('No swap shortens the connections'); return; }
        swapNets(e, r.moves, 'Automatic Net/Pin Optimiser');
      } });
    }) },
  ];
}

export { anyBoard };
