/**
 * Automation and placement of 26.039: Route › Auto Route (All, Net, Net Class, Connection, Area,
 * Room, Component, Component Class, on / between the selected components; Setup, Stop, Reset,
 * Pause), Route › Fanout (All, Power Plane Nets, Signal Nets, Net, Connection, Component,
 * Selected Components, Pad, Room), Tools › Component Placement › Auto Placer (and Stop), Place
 * From File, Reposition Selected Components, Design › Board Shape › Auto-Position Sheet, Cross
 * Select Mode's reposition, Tools › Outline Selected Objects, Remove Unused Pad Shapes, net
 * Properties, Create Netlist From Connected Copper, Design › Rule Wizard, Testpoint Manager,
 * Add/Remove Library on a board.
 */
import type { Command, Scope } from '../core/commands';
import { reportOut } from './pcbReports';
import { active, docs, notify, replaceMessages, tick } from './state';
import { showDialog } from './dialogs';
import { ChooseListDialog } from './dialogs/ChooseList';
import { ConfirmDialog, PromptDialog } from './dialogs/Confirm';
import { AutoPlaceDialog, FanoutOptionsDialog, RouteSetupDialog, RuleWizardDialog, TestpointManagerDialog, type FanoutChoice, type RouteSetup } from './dialogs/AutoTools';
import { AvailableLibrariesDialog } from './dialogs/AvailableLibraries';
import { FabProfileDialog } from './dialogs/FabProfile';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { TwoPointTool } from '../editors/pcb/PcbEditTools';
import { RepositionTool } from '../editors/pcb/RepositionTool';
import { commitMove } from '../editors/pcb/PcbMoveTool';
import { PickTool } from '../editors/Editor';
import { placement } from '../formats/altium/pcbTransform';
import { PAD, VIA, get, put } from '../formats/altium/pcbLayouts';
import { addArcs, addNet, addTracks, addVias, removePrims, repour, replaceRecords, retarget, renameNet } from '../model/pcbEdit';
import { reflow, trackKey, tracksByKey } from '../model/reflow';
import { setBoardProps } from '../model/pcbBoard';
import { autoroute, fanout, outerRows, poursAround, smdPads, type RouteJob } from '../model/autoroute';
import { optimisePins, setPadNets } from '../model/pinSwap';
import { featureOn } from '../core/release';
import type { RouteGuide } from '../model/router';
import { RouteGuideTool } from '../editors/pcb/RouteGuideTool';
import { guideLanes, guideWidth, laneLayout } from '../model/routeGuide';
import { autoPlace } from '../model/autoPlace';
import { roomsOf, componentExtent, type Room } from '../model/rooms';
import { roomMembers } from '../model/roomScope';
import { roomAt } from './pcbRoomCommands';
import { membersOf } from '../model/pcbClasses';
import { clearanceGap, connectedCopper, connections, type Connection } from '../model/drc';
import { L, isSignal, type LayerId } from '../model/layers';
import { equaliseNetLengths } from '../model/tuneEdit';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbTrack } from '../model/pcb';
import { settings, updateSettings } from '../core/settings';
import { formatAltiumLength, mil } from '../core/units';
import { pickFileHandle } from '../platform/fs';
import { importSessionInto } from './specctraSession';
import { readPnp } from '../formats/gerber/pnp';
import { distToSegment, pointInPoly, type Vec2 } from '../core/geom';
import * as ClipperNS from 'clipper-lib';

type CL = typeof ClipperNS;
const C: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;
const PCB: Scope[] = ['pcb'];
const board = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };
const on = (fn: (e: PcbEditor) => void) => () => { const e = board(); if (e) fn(e); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const docName = (e: PcbEditor) => docs.value.find((d) => d.editor === e)?.name ?? e.doc.name;

/* ── Auto Route ── */

/** The Routing Style preference says free-flowing (and its release has come). */
export const routeFlowing = () => featureOn('aiLayout') && settings.pcbRouteStyle === 'flowing';

let setup: RouteSetup = { strategy: 'Default 2 Layer Board', lockPreRoutes: true, ripUpViolations: false };
let job: (RouteJob & { what: string }) | null = null;

/**
 * While the autorouter or placer runs (it yields to keep the window responsive) the board takes
 * no edits; an undo or redo meanwhile makes its result stale, and it is dropped.
 */
async function holding<T>(e: PcbEditor, what: string, run: () => Promise<T>): Promise<T | null> {
  const guard = e.undo.guard;
  e.undo.guard = () => `${what} is running (stop it first)`;
  const rev = e.undo.revision;
  try {
    const r = await run();
    if (e.undo.revision !== rev) { notify(`${what}: the board changed meanwhile, so the result was dropped`, 'error'); return null; }
    return r;
  } finally { e.undo.guard = guard; }
}

async function runAutoroute(e: PcbEditor, conns: Connection[], what: string): Promise<void> {
  if (job) { notify('The autorouter is already running (Route › Auto Route › Stop)', 'error'); return; }
  if (!conns.length) { notify('Nothing to route there'); return; }
  job = { cancelled: false, paused: false, what };
  const name = docName(e);
  replaceMessages('Auto Route', [{ doc: name, level: 'info', message: `Routing Started (${what}, ${plural(conns.length, 'connection')}, ${setup.strategy})` }]);
  notify(`Auto Route ${what}: ${plural(conns.length, 'connection')}…`);
  try {
    const j = job, at = e.undo.checkpoint();
    const r = await holding(e, 'Auto Route', () => autoroute(e.doc, conns, { dirs: setup.strategy === 'General Orthogonal' ? 4 : 8, job: j, progress: (i, n) => { if (i % 5 === 0) e.status?.(`Auto Route: ${i} of ${n}`); } }));
    if (!r) return;
    if (r.tracks.length || r.vias.length) {
      e.undo.transact(`Auto Route ${what}`, (tx) => {
        if (r.tracks.length) tx.add(addTracks(e.doc, r.tracks));
        if (r.vias.length) tx.add(addVias(e.doc, r.vias));
        if (settings.pcbRepourAfterModification) for (const i of poursAround(e.doc, r)) tx.add(repour(e.doc, i));
      });
    }
    // Preferences › PCB Editor › Interactive Routing › Routing Style, Free-Flowing: what was routed is reshaped now that it is all there
    // (the orthogonal strategy keeps its corners); the routing and the reshaping are one step to undo
    let flowed = 0;
    if (routeFlowing() && setup.strategy !== 'General Orthogonal' && r.tracks.length && !j.cancelled) {
      const keys = new Set(r.tracks.map(trackKey));
      const f = await holding(e, 'Auto Route', () => reflow(e.doc, tracksByKey(e.doc, keys), { job: j, progress: (i, n) => { if (i % 5 === 0) e.status?.(`Auto Route: free-flowing, ${i} of ${n}`); } }));
      if (f?.reshaped) {
        e.undo.transact(`Auto Route ${what}`, (tx) => {
          tx.add(removePrims(e.doc, f.remove));
          if (f.tracks.length) tx.add(addTracks(e.doc, f.tracks));
          if (f.arcs.length) tx.add(addArcs(e.doc, f.arcs));
          if (settings.pcbRepourAfterModification) for (const i of poursAround(e.doc, { tracks: [...r.tracks, ...f.tracks], vias: [], arcs: f.arcs })) tx.add(repour(e.doc, i));
        });
        e.undo.mergeSince(at, `Auto Route ${what}`);
        flowed = f.reshaped;
      }
    }
    const secs = Math.max(1, Math.round(r.ms / 1000));
    const rows: { doc: string; level: 'info' | 'warn'; message: string }[] = [
      ...(r.ripped ? [{ doc: name, level: 'info' as const, message: `Rip-up and retry: ${plural(r.ripped, 'route')} ripped up and routed again over ${r.passes} pass${r.passes === 1 ? '' : 'es'}` }] : []),
      ...(flowed ? [{ doc: name, level: 'info' as const, message: `${plural(flowed, 'route')} made free-flowing (Preferences › PCB Editor › Interactive Routing › Routing Style)` }] : []),
      { doc: name, level: 'info', message: `Routing finished with ${plural(r.routed, 'connection')} routed. ${job.cancelled ? 'Stopped. ' : ''}Failed to complete ${plural(r.failed.length, 'connection')} in ${plural(secs, 'second')}` }];
    for (const c of r.failed) rows.push({ doc: name, level: 'warn', message: `Not routed: ${e.doc.nets[c.net]?.name ?? 'No Net'} from (${Math.round((c.a.x - e.doc.board.origin.x) / 1e4)}mil, ${Math.round((c.a.y - e.doc.board.origin.y) / 1e4)}mil)` });
    replaceMessages('Auto Route', rows);
    notify(`Auto Route: ${plural(r.routed, 'connection')} routed${r.failed.length ? `, ${r.failed.length} left` : ''}`);
  } finally { job = null; e.invalidate(); tick.value++; }
}

/* ── Make Free-Flowing ── */

/**
 * Route › Make Free-Flowing (26.194): the routes the selected tracks belong to, or every route
 * with nothing selected, pulled tight at any angle with their bends made arcs (model/reflow).
 */
async function runReflow(e: PcbEditor): Promise<void> {
  if (job) { notify('The autorouter is already running (Route › Auto Route › Stop)', 'error'); return; }
  const picked = new Set<number>();
  e.doc.prims.forEach((p, i) => { if (p.kind === 'track' && e.selection.has(e.keyOf(i) ?? '')) picked.add(i); });
  if (e.selection.size && !picked.size) { notify('Select tracks of the routes to reshape, or nothing to reshape every route', 'error'); return; }
  job = { cancelled: false, paused: false, what: 'Make Free-Flowing' };
  notify(picked.size ? 'Making the selected routes free-flowing…' : 'Making every route free-flowing…');
  try {
    const j = job;
    const f = await holding(e, 'Make Free-Flowing', () => reflow(e.doc, picked.size ? picked : undefined, { job: j, progress: (i, n) => { if (i % 5 === 0) e.status?.(`Make Free-Flowing: ${i} of ${n}`); } }));
    if (!f) return;
    if (!f.reshaped) { notify(f.kept ? 'These routes are as direct as their clearances allow: nothing to reshape' : 'No routes to reshape there'); return; }
    e.undo.transact('Make routes free-flowing', (tx) => {
      tx.add(removePrims(e.doc, f.remove));
      if (f.tracks.length) tx.add(addTracks(e.doc, f.tracks));
      if (f.arcs.length) tx.add(addArcs(e.doc, f.arcs));
      if (settings.pcbRepourAfterModification) for (const i of poursAround(e.doc, { tracks: f.tracks, vias: [], arcs: f.arcs })) tx.add(repour(e.doc, i));
    });
    e.selection = new Set();
    const shorter = (f.before - f.after) / 393700.787;
    notify(`${plural(f.reshaped, 'route')} made free-flowing${f.stopped ? ' (stopped)' : ''}: ${plural(f.arcs.length, 'arc')}, ${shorter >= 0.05 ? `${shorter.toFixed(1)} mm shorter in all` : 'the same length'}`);
  } finally { job = null; e.invalidate(); tick.value++; }
}

/* ── ActiveRoute ── */

/** The layers ActiveRoute routes on: those ticked in its panel that the board has, else every signal layer. */
export function activeRouteLayers(doc: PcbDocument): LayerId[] {
  const sig = doc.board.copperStack.filter(isSignal);
  const on = sig.filter((l) => settings.activeRouteLayers.includes(l));
  return on.length ? on : sig;
}

/** The connections ActiveRoute takes: those of the selected components and pads, and of the nets of selected routing. */
export function activeRouteConnections(e: PcbEditor): Connection[] {
  const sel = e.moveSet();
  const pts = [...padsOfComponents(e.doc, new Set(sel.components)), ...sel.prims.filter((p): p is PcbPad => p.kind === 'pad')].map((p) => p.at);
  const nets = new Set(sel.prims.filter((p) => p.kind !== 'pad' && 'net' in p && p.net !== NO_NET).map((p) => (p as { net: number }).net));
  return connections(e.doc).filter((c) => nets.has(c.net) || pts.some((q) => near(q, c.a) || near(q, c.b)));
}

/** The components ActiveRoute's selection touches (its pin swapping swaps within them). */
function activeRouteComponents(e: PcbEditor): Set<number> {
  const sel = e.moveSet();
  return new Set([...sel.components, ...sel.prims.filter((p): p is PcbPad => p.kind === 'pad').map((p) => p.component)].filter((c) => c !== NO_NET));
}

/**
 * Route › ActiveRoute (Shift+A): the selected connections routed on the layers ticked in the PCB
 * ActiveRoute panel, each on one of them (as AD's, ActiveRoute places no vias), at their nets'
 * Width rules — along a route guide when one was drawn (the panel's Route Guide): within it (a
 * hard edge; the routes come off their pads to it), side by side in the order they meet its start,
 * alternate ones on alternate layers. With Pin Swap Routing on, the selected components' pins are
 * first swapped within their swap groups where that shortens the connections (an undo step of its
 * own); with Meander on (and no guide: AD ignores it with one), the routed nets of each Matched
 * Lengths rule are then tuned up to its longest net, all in one undoable step [est: AD routes the
 * selection as one bus; Konium routes connection by connection, lane by lane].
 */
export async function activeRoute(e: PcbEditor, guide?: RouteGuide): Promise<void> {
  if (job) { notify('The autorouter is already running (Route › Auto Route › Stop)', 'error'); return; }
  let conns = activeRouteConnections(e);
  if (!conns.length) { notify(e.selection.size ? 'ActiveRoute: nothing to route, the selection has no unrouted connections' : 'ActiveRoute: select the components, pads or routing whose connections it should route', 'error'); return; }
  if (settings.activeRoutePinSwap && featureOn('routeGuide')) {
    const s = optimisePins(e.doc, 4, activeRouteComponents(e));
    const edits = s.moves.length ? setPadNets(e.doc, s.moves) : [];
    if (edits.length) {
      e.undo.transact('ActiveRoute Pin Swapping', (tx) => tx.add(replaceRecords(e.doc, edits)));
      conns = activeRouteConnections(e);
      notify(`ActiveRoute: ${plural(s.moves.length, 'pad')} swapped within their swap groups (Design › Update Schematics takes the change to the schematic)`);
    }
  }
  const layers = activeRouteLayers(e.doc), name = docName(e);
  job = { cancelled: false, paused: false, what: 'ActiveRoute' };
  const ln = (l: LayerId) => e.doc.board.layerNames.get(l) ?? String(l);
  replaceMessages('ActiveRoute', [{ doc: name, level: 'info', message: `ActiveRoute: ${plural(conns.length, 'connection')} on ${layers.map(ln).join(', ')}` }]);
  try {
    const j = job;
    const lanes = guide ? guideLanes(e.doc, conns, guide, layers) : null;
    const r = await holding(e, 'ActiveRoute', () => autoroute(e.doc, conns, { job: j, layers, noVias: true, ...(lanes ?? {}), progress: (i, n) => e.status?.(`ActiveRoute: ${i} of ${n}`) }));
    if (!r) return;
    let tuned: ReturnType<typeof equaliseNetLengths> | null = null;
    if (r.tracks.length || r.vias.length) {
      e.undo.transact('ActiveRoute', (tx) => {
        if (r.tracks.length) tx.add(addTracks(e.doc, r.tracks));
        if (r.vias.length) tx.add(addVias(e.doc, r.vias));
        if (settings.activeRouteMeander && !guide) tuned = equaliseNetLengths(e.doc, (c) => tx.add(c), undefined, new Set(r.tracks.map((t) => t.net!).filter((n) => n !== undefined)));
        if (settings.pcbRepourAfterModification) for (const i of poursAround(e.doc, r)) tx.add(repour(e.doc, i));
      });
    }
    const t = tuned as ReturnType<typeof equaliseNetLengths> | null;
    const rows: { doc: string; level: 'info' | 'warn'; message: string }[] = [
      { doc: name, level: 'info', message: `ActiveRoute finished: ${plural(r.routed, 'connection')} routed, ${plural(r.failed.length, 'connection')} not completed` },
      ...(t ? t.nets.map((n) => ({ doc: name, level: (n.target - n.after > 1 ? 'warn' : 'info') as 'info' | 'warn', message: `Meander: ${n.name} ${formatAltiumLength(Math.round(n.before))} → ${formatAltiumLength(Math.round(n.after))} (target ${formatAltiumLength(Math.round(n.target))})` })) : []),
      ...r.failed.map((c) => ({ doc: name, level: 'warn' as const, message: `Not routed: ${e.doc.nets[c.net]?.name ?? 'No Net'} from (${Math.round((c.a.x - e.doc.board.origin.x) / 1e4)}mil, ${Math.round((c.a.y - e.doc.board.origin.y) / 1e4)}mil)` })),
    ];
    replaceMessages('ActiveRoute', rows);
    notify(`ActiveRoute: ${plural(r.routed, 'connection')} routed${r.failed.length ? `, ${r.failed.length} left` : ''}`);
  } finally { job = null; e.invalidate(); tick.value++; }
}

const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) < 2;
const padsOfComponents = (doc: PcbDocument, comps: Set<number>) => doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && comps.has(p.component));
/** Connections with one end (any) or both ends (all) on these points. */
function connsTouching(doc: PcbDocument, pts: Vec2[], both: boolean): Connection[] {
  const at = (q: Vec2) => pts.some((p) => near(p, q));
  return connections(doc).filter((c) => (both ? at(c.a) && at(c.b) : at(c.a) || at(c.b)));
}
const netOfClick = (e: PcbEditor, raw: Vec2): number => { for (const h of e.hits(raw)) { const p = e.primByKey(h.key); if (p && 'net' in p && p.net !== NO_NET) return p.net; } return NO_NET; };
function connectionAt(e: PcbEditor, raw: Vec2): Connection | null {
  const tol = 8 / (e.viewport?.cam.scale ?? 1e-4);
  let best: { c: Connection; d: number } | null = null;
  for (const c of connections(e.doc)) { const d = distToSegment(raw, c.a, c.b); if (d <= tol && (!best || d < best.d)) best = { c, d }; }
  return best?.c ?? null;
}
const classPick = (e: PcbEditor, kind: number, title: string, then: (name: string) => void) => {
  const names = e.doc.classes.filter((c) => c.kind === kind).map((c) => c.name);
  if (!names.length) { notify('The board has no such classes', 'error'); return; }
  showDialog(ChooseListDialog, { title, header: 'Class', items: names, onOk: (i: number) => then(names[i]!) });
};

/* ── Fanout ── */

function runFanout(e: PcbEditor, pads: PcbPad[], label: string, c?: FanoutChoice): void {
  const r = fanout(e.doc, c?.outerRows ? outerRows(pads) : pads, { withoutNets: c?.withoutNets, escape: c?.escape });
  if (!r.done) { notify(r.failed.length ? `No room to fan out ${plural(r.failed.length, 'pad')}` : 'Nothing to fan out'); return; }
  e.undo.transact(label, (tx) => {
    tx.add(addTracks(e.doc, r.tracks));
    tx.add(addVias(e.doc, r.vias));
    if (settings.pcbRepourAfterModification) for (const i of poursAround(e.doc, r)) tx.add(repour(e.doc, i));
  });
  notify(`${plural(r.done, 'pad')} fanned out${c?.escape ? `, ${r.escaped} with an escape route` : ''}${r.failed.length ? `, ${r.failed.length} with no room` : ''}`);
  e.invalidate();
  // A BGA's fanout: the BGA Escape Route report (Preferences › PCB Editor › Reports) [est: BGAs by their footprint's name]
  const bgas = [...new Set(pads.map((p) => p.component))].map((c) => e.doc.components[c]).filter((c) => !!c && /bga/i.test(c.pattern));
  if (bgas.length) {
    const failed = new Set(r.failed);
    const lines = bgas.map((c) => { const mine = pads.filter((p) => p.component === c!.index); const no = mine.filter((p) => failed.has(p)).length; return `${c!.designator} (${c!.pattern}): ${mine.length - no} of ${mine.length} pads escaped${no ? `, ${no} with no room` : ''}`; });
    reportOut('bgaEscape', 'BGA Escape Route', [`${label}: ${plural(r.done, 'pad')} fanned out${r.failed.length ? `, ${r.failed.length} with no room` : ''}`, '', ...lines].join('\n'), e);
  }
}
/** Nets that a plane carries (PLANEnNETNAME, and split planes' regions). */
function planeNets(doc: PcbDocument): Set<number> {
  const out = new Set<number>();
  const b = doc.board.bag;
  for (let i = 1; i <= 16; i++) { const n = b?.get(`PLANE${i}NETNAME`); const k = n ? doc.nets.findIndex((x) => x.name === n) : -1; if (k >= 0) out.add(k); }
  for (const p of doc.prims) if (p.kind === 'region' && p.layer >= L.PLANE1 && p.layer <= L.PLANE16 && p.net !== NO_NET) out.add(p.net);
  return out;
}

/* ── Outline, unused pad shapes, netlist from copper ── */

/** Tracks round each selected object at its clearance, on the current layer, in its net [est]. */
function outlineSelected(e: PcbEditor): number {
  const doc = e.doc, out: { layer: number; a: Vec2; b: Vec2; width: number; net?: number }[] = [];
  const w = e.trackWidth;
  for (const p of e.moveSet().prims) {
    const pts: Vec2[] = p.kind === 'pad' ? (() => { const s = p.top; const hw = s.w / 2, hh = s.h / 2, r = (p.rotation * Math.PI) / 180; return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({ x: p.at.x + x! * Math.cos(r) - y! * Math.sin(r), y: p.at.y + x! * Math.sin(r) + y! * Math.cos(r) })); })()
      : p.kind === 'via' ? Array.from({ length: 16 }, (_, k) => ({ x: p.at.x + (p.diameter / 2) * Math.cos((k / 16) * 2 * Math.PI), y: p.at.y + (p.diameter / 2) * Math.sin((k / 16) * 2 * Math.PI) }))
        : p.kind === 'track' ? [p.a, p.b] : p.kind === 'region' ? p.outline : p.kind === 'fill' ? [p.a, { x: p.b.x, y: p.a.y }, p.b, { x: p.a.x, y: p.b.y }] : [];
    if (pts.length < 2) continue;
    const gap = clearanceGap(doc, p, { kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer: e.currentLayer, a: p.kind === 'track' ? p.a : pts[0]!, b: pts[0]!, width: w, net: NO_NET, component: NO_NET, polygon: NO_NET, locked: false, keepout: false } as PcbTrack) || mil(10);
    const co = new C.ClipperOffset(2, 250);
    const path = pts.map((q) => ({ X: Math.round(q.x), Y: Math.round(q.y) }));
    const r0 = p.kind === 'track' ? p.width / 2 : 0;
    co.AddPath(path, C.JoinType.jtRound, p.kind === 'track' ? C.EndType.etOpenRound : C.EndType.etClosedPolygon);
    const res: ClipperNS.IntPoint[][] = [];
    co.Execute(res, r0 + gap + w / 2);
    const net = 'net' in p && p.net !== NO_NET ? p.net : undefined;
    for (const ring of res) for (let i = 0; i < ring.length; i++) { const a = ring[i]!, b = ring[(i + 1) % ring.length]!; out.push({ layer: e.currentLayer, a: { x: a.X, y: a.Y }, b: { x: b.X, y: b.Y }, width: w, net }); }
  }
  if (out.length) e.undo.transact('Outline selected objects', (tx) => tx.add(addTracks(doc, out)));
  return out.length;
}

/** Through-hole pads and vias with an inner signal layer where nothing of their net joins them [est]. */
function unusedInnerShapes(doc: PcbDocument): { prim: PcbPrim; layers: number[] }[] {
  const inner = doc.board.copperStack.filter((l) => isSignal(l) && l !== L.TOP && l !== L.BOTTOM);
  if (!inner.length) return [];
  const out: { prim: PcbPrim; layers: number[] }[] = [];
  for (const p of doc.prims) {
    if (!((p.kind === 'via' && p.hole > 0) || (p.kind === 'pad' && p.layer === L.MULTI && p.hole > 0))) continue;
    const used = new Set<number>();
    for (const q of doc.prims) if ((q.kind === 'track' || q.kind === 'arc' || q.kind === 'region') && 'net' in q && q.net === p.net && inner.includes(q.layer)) {
      const hit = q.kind === 'track' ? (near(q.a, p.at) || near(q.b, p.at) || distToSegment(p.at, q.a, q.b) < q.width / 2) : q.kind === 'region' ? pointInPoly(p.at, q.outline) : Math.abs(Math.hypot(p.at.x - q.c.x, p.at.y - q.c.y) - q.r) < q.width / 2;
      if (hit) used.add(q.layer);
    }
    const unused = inner.filter((l) => !used.has(l));
    if (unused.length) out.push({ prim: p, layers: unused });
  }
  return out;
}

/** Pads with no net joined by copper get a net of their own (NetU1_2 for U1's pad 2 first in the island). */
function netlistFromCopper(e: PcbEditor): number {
  const doc = e.doc;
  const seen = new Set<number>(), groups: number[][] = [];
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad' || p.net !== NO_NET || seen.has(i)) return;
    const island = [...connectedCopper(doc, i)];
    for (const k of island) seen.add(k);
    const pads = island.filter((k) => doc.prims[k]?.kind === 'pad' && (doc.prims[k] as PcbPad).net === NO_NET);
    if (pads.length >= 2) groups.push(island);
  });
  if (!groups.length) return 0;
  e.undo.transact('Create netlist from connected copper', (tx) => {
    for (const island of groups) {
      const first = island.map((k) => doc.prims[k]!).find((q): q is PcbPad => q.kind === 'pad')!;
      const des = first.component !== NO_NET ? doc.components[first.component]?.designator ?? '' : '';
      let name = `Net${des}_${first.name}`, n = 1;
      while (doc.nets.some((x) => x.name === name)) name = `Net${des}_${first.name}_${n++}`;
      // A new net at the end of Nets6, its copper put on it
      const index = doc.nets.length;
      tx.add(addNet(doc, name));
      const edits = island.map((k) => doc.prims[k]!).filter((q) => 'net' in q && q.net === NO_NET).flatMap((q) => { const r = doc.streams.get(q.src.storage)?.records[q.src.index]; return r ? [{ storage: q.src.storage, index: q.src.index, after: retarget(r, { net: () => index }) }] : []; });
      if (edits.length) tx.add(replaceRecords(doc, edits));
    }
  });
  return groups.length;
}

export function pcbAutoCommands(): Command[] {
  const route = (what: string, pick: (e: PcbEditor, done: (c: Connection[]) => void) => void) => on((e) => pick(e, (c) => void runAutoroute(e, c, what)));
  const pickRoute = (what: string, prompt: string, conns: (e: PcbEditor, raw: Vec2) => Connection[] | null) => route(what, (e, done) => e.setTool(new PickTool(e, `Auto Route ${what}: ${prompt}`, (p) => { const c = conns(e, p.raw); if (!c) return false; done(c); return true; })));
  const fan = (label: string, pads: (e: PcbEditor) => PcbPad[] | null) => on((e) => { const ps = pads(e); if (ps) runFanout(e, ps, label); });
  const pickFan = (label: string, prompt: string, pads: (e: PcbEditor, raw: Vec2) => PcbPad[] | null) => on((e) => e.setTool(new PickTool(e, `${label}: ${prompt}`, (p) => { const ps = pads(e, p.raw); if (!ps) return false; runFanout(e, ps, label); return true; }, true)));
  const compAt = (e: PcbEditor, raw: Vec2) => e.componentAt(raw);
  const selComps = (e: PcbEditor) => new Set(e.moveSet().components);
  const hasConns = () => !!board() && connections(board()!.doc).length > 0;
  const roomPads = (e: PcbEditor, r: Room) => { const m = new Set(roomMembers(e.doc, r)); const comps = m.size ? m : new Set(e.doc.components.map((_, i) => i).filter((c) => { const b = componentExtent(e.doc, c); return !!b && pointInPoly({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, r.outline); })); return padsOfComponents(e.doc, comps); };
  return [
    { id: 'route.makeFlowing', label: 'Make Free-Flowing', scopes: PCB, enabled: () => !!board(), run: on((e) => void runReflow(e)) },
    /* Auto Route */
    { id: 'ad:PCB:AutorouteAll', label: 'All...', scopes: PCB, enabled: hasConns, run: on((e) => showDialog(RouteSetupDialog, { ed: e, setup, routeAll: true, onOk: (s: RouteSetup) => { setup = s; void runAutoroute(e, connections(e.doc), 'All'); } })) },
    { id: 'route.specctraImport', label: 'Import Specctra Session...', scopes: PCB, enabled: () => !!board(), run: on(async (e) => {
      const f = await pickFileHandle(['.ses'], 'Specctra session files', 'konium-ses');
      if (f) importSessionInto(e, f.name, f.bytes);
    }) },
    { id: 'ad:PCB:AutorouteSetup', label: 'Setup...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(RouteSetupDialog, { ed: e, setup, onOk: (s: RouteSetup) => { setup = s; } })) },
    { id: 'ad:PCB:AutorouteNet', label: 'Net', scopes: PCB, enabled: hasConns, run: pickRoute('Net', 'click a pad or track of the net', (e, raw) => { const n = netOfClick(e, raw); return n === NO_NET ? null : connections(e.doc).filter((c) => c.net === n); }) },
    { id: 'ad:PCB:AutorouteNetClass', label: 'Net Class...', scopes: PCB, enabled: hasConns, run: on((e) => classPick(e, 0, 'Choose Net Classes to Route', (name) => {
      const c = e.doc.classes.find((k) => k.kind === 0 && k.name === name)!;
      const nets = new Set(membersOf(e.doc, c).map((m) => e.doc.nets.findIndex((n) => n.name === m)));
      void runAutoroute(e, connections(e.doc).filter((k) => nets.has(k.net)), `Net Class ${name}`);
    })) },
    { id: 'ad:PCB:AutorouteConnection', label: 'Connection', scopes: PCB, enabled: hasConns, run: pickRoute('Connection', 'click a connection line', (e, raw) => { const c = connectionAt(e, raw); return c ? [c] : null; }) },
    { id: 'ad:PCB:AutorouteArea', label: 'Area', scopes: PCB, enabled: hasConns, run: on((e) => e.setTool(new TwoPointTool(e, 'autoroute-area', ['Auto Route Area: click one corner', 'Auto Route Area: click the opposite corner'], (a, b) => {
      e.setTool(null);
      const inside = (q: Vec2) => q.x >= Math.min(a.x, b.x) && q.x <= Math.max(a.x, b.x) && q.y >= Math.min(a.y, b.y) && q.y <= Math.max(a.y, b.y);
      void runAutoroute(e, connections(e.doc).filter((c) => inside(c.a) && inside(c.b)), 'Area');
    }))) },
    ...(['ad:PCB:AutorouteRoom', 'ad:PCB:AutorouteSingleRoom'] as const).map((id): Command => ({ id, label: id.endsWith('SingleRoom') ? 'Autoroute Room' : 'Room', scopes: PCB, enabled: () => hasConns() && !!board() && roomsOf(board()!.doc).length > 0,
      run: pickRoute('Room', 'click a room', (e, raw) => { const r = roomAt(e, raw); return r ? connsTouching(e.doc, roomPads(e, r).map((p) => p.at), true) : null; }) })),
    ...(['ad:PCB:AutorouteComponent', 'ad:PCB:AutorouteSingleComponent'] as const).map((id): Command => ({ id, label: id.endsWith('SingleComponent') ? 'Autoroute Component' : 'Component', scopes: PCB, enabled: hasConns,
      run: pickRoute('Component', 'click a component', (e, raw) => { const c = compAt(e, raw); return c === null ? null : connsTouching(e.doc, padsOfComponents(e.doc, new Set([c])).map((p) => p.at), false); }) })),
    { id: 'ad:PCB:AutorouteComponentClass', label: 'Component Class...', scopes: PCB, enabled: hasConns, run: on((e) => classPick(e, 1, 'Choose Component Classes to Route', (name) => {
      const k = e.doc.classes.find((x) => x.kind === 1 && x.name === name)!;
      const des = new Set(membersOf(e.doc, k));
      const comps = new Set(e.doc.components.map((c, i) => (des.has(c.designator) ? i : -1)).filter((i) => i >= 0));
      void runAutoroute(e, connsTouching(e.doc, padsOfComponents(e.doc, comps).map((p) => p.at), false), `Component Class ${name}`);
    })) },
    { id: 'ad:PCB:AutorouteSelectedComponent', label: 'Connections On Selected Components', scopes: PCB, enabled: () => hasConns() && !!board()?.moveSet().components.length,
      run: on((e) => void runAutoroute(e, connsTouching(e.doc, padsOfComponents(e.doc, selComps(e)).map((p) => p.at), false), 'Selected Components')) },
    { id: 'ad:PCB:AutorouteBetweenSelectedComponent', label: 'Connections Between Selected Components', scopes: PCB, enabled: () => hasConns() && (board()?.moveSet().components.length ?? 0) > 1,
      run: on((e) => void runAutoroute(e, connsTouching(e.doc, padsOfComponents(e.doc, selComps(e)).map((p) => p.at), true), 'Between Selected Components')) },
    { id: 'ad:PCB:AutorouteStop', label: 'Stop', scopes: PCB, enabled: () => !!job, run: () => { if (job) { job.cancelled = true; notify('Auto Route stopping'); } } },
    { id: 'ad:PCB:AutoroutePause', label: 'Pause', scopes: PCB, enabled: () => !!job, checked: () => !!job?.paused, run: () => { if (job) { job.paused = !job.paused; notify(job.paused ? 'Auto Route paused' : 'Auto Route resumed'); } } },
    { id: 'ad:PCB:AutorouteReset', label: 'Reset', scopes: PCB, enabled: () => !job, run: () => { setup = { strategy: 'Default 2 Layer Board', lockPreRoutes: true, ripUpViolations: false }; replaceMessages('Auto Route', []); notify('Auto Route reset'); } },

    /* ActiveRoute */
    { id: 'route.active', label: 'ActiveRoute', scopes: PCB, enabled: () => !!board() && !job, run: on((e) => void activeRoute(e)) },
    { id: 'route.activeGuide', label: 'ActiveRoute Route Guide', scopes: PCB, enabled: () => !!board() && !job, run: on((e) => {
      const conns = activeRouteConnections(e);
      if (!conns.length) { notify('Route Guide: select the components, pads or routing whose connections ActiveRoute should route first', 'error'); return; }
      const layers = activeRouteLayers(e.doc), lay = laneLayout(e.doc, conns, layers);
      const w = settings.activeRouteGuideWidth > 0 ? settings.activeRouteGuideWidth : guideWidth(e.doc, conns, layers);
      const need = { count: conns.length, pitch: lay.pitch, layers: lay.layers };
      e.setTool(new RouteGuideTool(e, w, (pts, width) => void activeRoute(e, { pts, width }), need));
    }) },
    /* PCB ActiveRoute › Tune Selected: the selected nets tuned to their Matched Lengths rules */
    { id: 'route.activeTune', label: 'Tune Selected', scopes: PCB, enabled: () => !!board() && !job, run: on((e) => {
      const nets = new Set(activeRouteConnections(e).map((c) => c.net));
      for (const p of e.moveSet().prims) if ('net' in p && p.net !== NO_NET) nets.add((p as { net: number }).net);
      if (!nets.size) { notify('Tune Selected: select the nets\' routing, pads or components first', 'error'); return; }
      let t: ReturnType<typeof equaliseNetLengths> | null = null;
      e.undo.transact('Tune Selected', (tx) => { t = equaliseNetLengths(e.doc, (c) => tx.add(c), undefined, nets); });
      const r = t as ReturnType<typeof equaliseNetLengths> | null;
      if (!r?.nets.length) notify('Tune Selected: none of the selected nets is in a Matched Lengths rule with another', 'error');
      else notify(`Tune Selected: ${plural(r.nets.length, 'net')} tuned to their Matched Lengths rules`);
      e.invalidate(); tick.value++;
    }) },
    /* Design › Fab-House Profile */
    { id: 'design.fabProfile', label: 'Fab-House Profile...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(FabProfileDialog, { ed: e })) },

    /* Fanout */
    { id: 'ad:PCB:FanoutAll', label: 'All...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(FanoutOptionsDialog, { title: 'Fanout Options', onOk: (c: FanoutChoice) => runFanout(e, smdPads(e.doc, () => true, c.withoutNets), 'Fanout all', c) })) },
    { id: 'ad:PCB:FanoutPowerPlaneNets', label: 'Power Plane Nets...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(FanoutOptionsDialog, { title: 'Fanout Options', onOk: (c: FanoutChoice) => { const pn = planeNets(e.doc); runFanout(e, smdPads(e.doc, (p) => pn.has(p.net)), 'Fanout power plane nets', c); } })) },
    { id: 'ad:PCB:FanoutSignalNets', label: 'Signal Nets...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(FanoutOptionsDialog, { title: 'Fanout Options', onOk: (c: FanoutChoice) => { const pn = planeNets(e.doc); runFanout(e, smdPads(e.doc, (p) => !pn.has(p.net), c.withoutNets), 'Fanout signal nets', c); } })) },
    { id: 'ad:PCB:FanoutNet', label: 'Net', scopes: PCB, enabled: () => !!board(), run: pickFan('Fanout Net', 'click a pad of the net', (e, raw) => { const n = netOfClick(e, raw); return n === NO_NET ? null : smdPads(e.doc, (p) => p.net === n); }) },
    { id: 'ad:PCB:FanoutConnection', label: 'Connection', scopes: PCB, enabled: hasConns, run: pickFan('Fanout Connection', 'click a connection line', (e, raw) => { const c = connectionAt(e, raw); return c ? smdPads(e.doc, (p) => near(p.at, c.a) || near(p.at, c.b)) : null; }) },
    ...(['ad:PCB:FanoutComponent', 'ad:PCB:FanoutSingleComponent'] as const).map((id): Command => ({ id, label: id.endsWith('SingleComponent') ? 'Fanout Component' : 'Component', scopes: PCB, enabled: () => !!board(),
      run: pickFan('Fanout Component', 'click a component', (e, raw) => { const c = compAt(e, raw); return c === null ? null : smdPads(e.doc, (p) => p.component === c); }) })),
    { id: 'ad:PCB:FanoutSelected', label: 'Selected Components', scopes: PCB, enabled: () => !!board()?.moveSet().components.length, run: fan('Fanout selected components', (e) => { const s = selComps(e); return smdPads(e.doc, (p) => s.has(p.component)); }) },
    { id: 'ad:PCB:FanoutPad', label: 'Pad', scopes: PCB, enabled: () => !!board(), run: pickFan('Fanout Pad', 'click a pad', (e, raw) => { const h = e.hits(raw).map((x) => e.primByKey(x.key)).find((q): q is PcbPad => q?.kind === 'pad'); return h ? [h] : null; }) },
    { id: 'ad:PCB:FanoutRoom', label: 'Room', scopes: PCB, enabled: () => !!board() && roomsOf(board()!.doc).length > 0, run: pickFan('Fanout Room', 'click a room', (e, raw) => { const r = roomAt(e, raw); return r ? roomPads(e, r).filter((p) => p.layer !== L.MULTI) : null; }) },

    /* Placement */
    { id: 'ad:AutoPlacer:RunAutoPlacer', label: 'Auto Placer...', scopes: PCB, enabled: () => !!board()?.doc.components.length && !job, run: on((e) => {
      const sel = e.moveSet().components;
      const comps = (sel.length ? sel : e.doc.components.map((_, i) => i)).filter((c) => !e.doc.components[c]!.bag.bool('LOCKED'));
      showDialog(AutoPlaceDialog, { ed: e, count: comps.length, onOk: async (c: { rotate: boolean; grid: number; gap: number }) => {
        job = { cancelled: false, paused: false, what: 'Auto Placer' };
        try {
          const j = job;
          const moves = await holding(e, 'The Auto Placer', () => autoPlace(e.doc, comps, { grid: c.grid, gap: c.gap, rotate: c.rotate, job: j, progress: (i, n) => e.status?.(`Auto Placer: ${i} of ${n}`), members: (r) => roomMembers(e.doc, r) }));
          if (!moves) return;
          if (!moves.length) { notify('The Auto Placer found no room on the board', 'error'); return; }
          e.undo.transact('Auto Placer', () => { for (const m of moves) { const at = e.doc.components[m.component]!.at; commitMove(e, { components: [m.component], polygons: [], prims: [] }, placement(at, m.rot, { x: m.to.x - at.x, y: m.to.y - at.y }), m.rot, 'move'); } });
          notify(`Auto Placer: ${plural(moves.length, 'component')} placed${job.cancelled ? ' (stopped)' : ''}`);
        } finally { job = null; e.invalidate(); }
      } });
    }) },
    { id: 'ad:AutoPlacer:StopAutoPlacer', label: 'Stop Auto Placer', scopes: PCB, enabled: () => job?.what === 'Auto Placer', run: () => { if (job) job.cancelled = true; } },
    { id: 'ad:PCB:PlaceComponentsFromFile', label: 'Place From File...', scopes: PCB, enabled: () => !!board()?.doc.components.length, run: on(async (e) => {
      const f = await pickFileHandle(['.csv', '.txt'], 'Pick and place files', 'konium-pnp');
      if (!f) return;
      const pos = readPnp(new TextDecoder().decode(f.bytes));
      if (!pos.size) { notify('No designators and positions found in that file', 'error'); return; }
      const o = e.doc.board.origin;
      let n = 0;
      e.undo.transact('Place from file', () => {
        e.doc.components.forEach((c, i) => {
          const p = pos.get(c.designator);
          if (!p || c.bag.bool('LOCKED')) return;
          const rot = p.rot !== undefined ? (((p.rot - c.rotation) % 360) + 360) % 360 : 0;
          const flip = p.bottom !== undefined && p.bottom !== (c.layer === L.BOTTOM);
          let to = { x: o.x + p.x, y: o.y + p.y };
          if (p.centre) {
            // Center-X/Y is the middle of the pads: where the reference point goes follows from the turned pads
            const pads = padsOfComponents(e.doc, new Set([i]));
            if (pads.length) {
              const map = placement(c.at, rot, { x: 0, y: 0 });
              const q = pads.map((x) => map(x.at)), xs = q.map((v) => v.x), ys = q.map((v) => v.y);
              to = { x: to.x - ((Math.min(...xs) + Math.max(...xs)) / 2 - c.at.x), y: to.y - ((Math.min(...ys) + Math.max(...ys)) / 2 - c.at.y) };
            }
          }
          commitMove(e, { components: [i], polygons: [], prims: [] }, placement(c.at, rot, { x: to.x - c.at.x, y: to.y - c.at.y }), rot, 'move', undefined, { flip });
          n++;
        });
      });
      notify(`${plural(n, 'component')} placed from ${f.name}`);
      e.invalidate();
    }) },
    { id: 'ad:PCB:RepositionSelectedComponents', label: 'Reposition Selected Components', scopes: PCB, enabled: () => !!board()?.moveSet().components.length, run: on((e) => {
      const comps = e.moveSet().components.filter((c) => !e.doc.components[c]!.bag.bool('LOCKED'));
      if (comps.length) e.setTool(new RepositionTool(e, comps));
    }) },
    { id: 'ad:PCB:ToggleFastCrossSelectRepositionInPCB', label: 'Cross Select Mode Reposition Selected Component In Pcb', scopes: PCB, checked: () => settings.pcbCrossSelectReposition, run: () => {
      updateSettings({ pcbCrossSelectReposition: !settings.pcbCrossSelectReposition });
      notify(`Cross select: reposition in the PCB ${settings.pcbCrossSelectReposition ? 'on' : 'off'}`);
    } },
    { id: 'ad:PCB:AutoMoveSheet', label: 'Auto-Position Sheet', scopes: PCB, enabled: () => !!board()?.doc.board.outline.length, run: on((e) => {
      const o = e.doc.board.outline, xs = o.map((p) => p.x), ys = o.map((p) => p.y), m = mil(500);
      const x = Math.min(...xs) - m, y = Math.min(...ys) - m, w = Math.max(...xs) - Math.min(...xs) + 2 * m, h = Math.max(...ys) - Math.min(...ys) + 2 * m;
      e.undo.transact('Auto-position sheet', (tx) => tx.add(setBoardProps(e.doc, { SHEETX: formatAltiumLength(x), SHEETY: formatAltiumLength(y), SHEETWIDTH: formatAltiumLength(w), SHEETHEIGHT: formatAltiumLength(h), SHOWSHEET: 'TRUE' })));
      e.invalidate();
    }) },

    /* Board tools */
    { id: 'ad:PCB:OutlineSelectedObjects', label: 'Outline Selected Objects', scopes: PCB, enabled: () => !!board()?.selection.size, run: on((e) => { const n = outlineSelected(e); notify(n ? `${plural(n, 'track')} outline the selection` : 'Nothing to outline'); }) },
    { id: 'ad:PCB:RemoveUnusedPads', label: 'Remove Unused Pad Shapes...', scopes: PCB, enabled: () => !!board(), run: on((e) => {
      const list = unusedInnerShapes(e.doc);
      if (!list.length) { notify('Every inner-layer pad shape is in use (or the board has no inner layers)'); return; }
      showDialog(ConfirmDialog, { title: 'Remove Unused Pad Shapes', message: `${plural(list.length, 'pad or via', )} have inner-layer shapes nothing joins. Shrink those shapes to the hole?`, detail: 'Their stacks become Top-Middle-Bottom (vias Full Stack) [est].', onYes: () => {
        const doc = e.doc;
        const edits = list.flatMap(({ prim: p, layers }) => {
          const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
          if (!rec) return [];
          const subs = rec.subs.map((x) => x.slice());
          if (p.kind === 'via') {
            const s = subs[0]!;
            if (s.length < VIA.layerDiameters + 32 * 4) return [];
            put(s, VIA.mode, 2);
            for (const l of layers) put(s, { off: VIA.layerDiameters + (l - 1) * 4, t: 'i32' }, p.hole);
          } else if (p.kind === 'pad') {
            const s = subs[4]!;
            put(s, PAD.midX, p.hole); put(s, PAD.midY, p.hole); put(s, PAD.padMode, Math.max(1, get(s, PAD.padMode) ?? 0));
          }
          return [{ storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs } }];
        });
        e.undo.transact('Remove unused pad shapes', (tx) => tx.add(replaceRecords(doc, edits)));
        notify(`${plural(edits.length, 'pad and via', )} trimmed`);
      } });
    }) },
    { id: 'ad:PCB:ChangeSingleNet', label: 'Properties...', scopes: PCB, enabled: () => !!board(), run: on((e) => {
      const edit = (n: number) => {
        const net = e.doc.nets[n]!;
        showDialog(PromptDialog, { title: 'Edit Net', fields: [{ label: 'Net Name', value: net.name }], onOk: ([v]: string[]) => {
          const name = (v ?? '').trim();
          if (!name || name === net.name) return;
          if (e.doc.nets.some((x) => x.name === name)) { notify(`There is already a net ${name}`, 'error'); return; }
          e.undo.transact(`Rename net ${net.name}`, (tx) => tx.add(renameNet(e.doc, net.index, name)));
          e.invalidate(); tick.value++;
        } });
      };
      const sel = [...e.selection].map((k) => e.primByKey(k)).find((p) => p && 'net' in p && p.net !== NO_NET) as { net: number } | undefined;
      if (sel) edit(sel.net);
      else e.setTool(new PickTool(e, 'Net Properties: click an object of the net', (p) => { const n = netOfClick(e, p.raw); if (n === NO_NET) return false; setTimeout(() => edit(n)); return true; }));
    }) },
    { id: 'ad:PCB:CreateNetlistFromConnectedCopper', label: 'Create Netlist From Connected Copper...', scopes: PCB, enabled: () => !!board(), run: on((e) => {
      showDialog(ConfirmDialog, { title: 'Create Netlist From Connected Copper', message: 'Give pads with no net that copper joins a net of their own?', onYes: () => {
        const n = netlistFromCopper(e);
        notify(n ? `${plural(n, 'net')} made from connected copper` : 'No unconnected pads are joined by copper');
        e.invalidate(); tick.value++;
      } });
    }) },
    { id: 'ad:PCB:RunRuleWizard', label: 'Rule Wizard...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(RuleWizardDialog, { ed: e })) },
    { id: 'ad:PCB:TestpointManager', label: 'Testpoint Manager...', scopes: PCB, enabled: () => !!board(), run: on((e) => showDialog(TestpointManagerDialog, { ed: e })) },
    { id: 'ad:PCB:AddRemoveLibrary', label: 'Add/Remove Library...', scopes: PCB, run: () => showDialog(AvailableLibrariesDialog, {}) },
  ];
}
