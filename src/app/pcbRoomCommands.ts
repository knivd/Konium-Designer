/**
 * Design › Rooms and what works on rooms: Place Rectangular / Polygonal Room, Move Room, Edit
 * Polygonal Room Vertices, Copy Room Formats, Arrange Rooms, Move Rooms To Grid, Wrap
 * (Rectangular, Orthogonal, Non-Orthogonal) Room Around Components, Create Room from selected
 * components or primitives, Slice Room (and Create Classes), Select Room Connections, Arrange
 * Within Room, Un-Route › Room.
 */
import type { Command, Scope } from '../core/commands';
import { active, notify, tick } from './state';
import { showDialog } from './dialogs';
import { ConfirmDialog } from './dialogs/Confirm';
import { RoomDialog } from './dialogs/RoomDialog';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { PcbMoveTool, commitMove } from '../editors/pcb/PcbMoveTool';
import { TwoPointTool } from '../editors/pcb/PcbEditTools';
import { PolyPointsTool, RoomVertexTool } from '../editors/pcb/RoomTools';
import { PickTool } from '../editors/Editor';
import { placement } from '../formats/altium/pcbTransform';
import { addTracks, addVias, removePrims } from '../model/pcbEdit';
import {
  componentExtent, componentsIn, editRooms, newRoom, roomOutline, roomsOf, routingIn, scopeFor, withOutline, wrapOutline, type Room,
} from '../model/rooms';
import { roomMembers } from '../model/roomScope';
import { slicePolygon } from '../model/polygonOps';
import { classBag, setClasses } from '../model/pcbClasses';
import { L } from '../model/layers';
import { NO_NET, type PcbPrim, type PcbTrack } from '../model/pcb';
import { mil } from '../core/units';
import type { BBox, Vec2 } from '../core/geom';
import { pointInPoly } from '../core/geom';

const PCB: Scope[] = ['pcb'];
const board = () => { const e = active.value?.editor; return e instanceof PcbEditor && !(e instanceof PcbLibEditor) ? e : null; };
const on = (fn: (e: PcbEditor) => void) => () => { const e = board(); if (e) fn(e); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const hasRooms = () => !!board() && roomsOf(board()!.doc).length > 0;
const GAP = mil(10);

/** The room under the cursor (its outline, name, or inside it), the selected one first. */
function roomAt(e: PcbEditor, raw: Vec2): Room | null {
  const rooms = roomsOf(e.doc);
  const hit = e.hits(raw).find((h) => h.key.startsWith('room:'));
  if (hit) return rooms.find((r) => r.rule === Number(hit.key.slice(5))) ?? null;
  const inside = rooms.filter((r) => pointInPoly(raw, r.outline));
  // The smallest room the point is in
  const area = (o: Vec2[]) => Math.abs(o.reduce((s, p, i) => { const q = o[(i + 1) % o.length]!; return s + p.x * q.y - q.x * p.y; }, 0));
  return inside.sort((a, b) => area(a.outline) - area(b.outline))[0] ?? null;
}
/** Pick a room, then do something with it (repeats until right-click when `repeat`). */
const pickRoom = (e: PcbEditor, label: string, fn: (r: Room) => void, repeat = false) =>
  e.setTool(new PickTool(e, `${label}: click a room`, (p) => { const r = roomAt(e, p.raw); if (!r) return false; fn(r); e.invalidate(); tick.value++; return true; }, repeat));

const move = (e: PcbEditor, c: number, d: Vec2, rot = 0, about?: Vec2) => {
  if (!d.x && !d.y && !rot) return;
  commitMove(e, { components: [c], polygons: [], prims: [] }, placement(about ?? e.doc.components[c]!.at, rot, { x: Math.round(d.x), y: Math.round(d.y) }), rot, 'move');
};

/** Rows of components inside a box from its top left [est: AD17's packing]. */
function packInto(e: PcbEditor, comps: number[], area: BBox): number {
  const boxes = comps.map((c) => ({ c, b: componentExtent(e.doc, c) })).filter((x): x is { c: number; b: BBox } => !!x.b)
    .sort((a, b) => (b.b.maxY - b.b.minY) - (a.b.maxY - a.b.minY));
  let x = area.minX + GAP, y = area.maxY - GAP, rowH = 0, n = 0;
  for (const { c, b } of boxes) {
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    if (x > area.minX + GAP && x + w > area.maxX - GAP) { x = area.minX + GAP; y -= rowH + GAP; rowH = 0; }
    move(e, c, { x: x - b.minX, y: y - h - b.minY });
    x += w + GAP; rowH = Math.max(rowH, h); n++;
  }
  return n;
}

const boxOf = (o: Vec2[]): BBox => ({ minX: Math.min(...o.map((p) => p.x)), minY: Math.min(...o.map((p) => p.y)), maxX: Math.max(...o.map((p) => p.x)), maxY: Math.max(...o.map((p) => p.y)) });

/** A room refitted round the components it holds. */
function wrap(e: PcbEditor, r: Room, kind: 'rect' | 'ortho' | 'nonortho'): void {
  const members = roomMembers(e.doc, r);
  const comps = members.length && !/^\s*all\s*$/i.test(r.scope) ? members : componentsIn(e.doc, r);
  const boxes = comps.map((c) => componentExtent(e.doc, c)).filter((b): b is BBox => !!b);
  if (!boxes.length) { notify(`${r.name} holds no components`, 'error'); return; }
  const o = wrapOutline(boxes, kind, GAP);
  e.undo.transact(`Wrap room ${r.name}`, (tx) => tx.add(editRooms(e.doc, { set: new Map([[r.rule, withOutline(e.doc.rules[r.rule]!, o)]]) })));
}

/** A room from the selected components. */
function fromComponents(e: PcbEditor, kind: 'rect' | 'ortho' | 'nonortho'): void {
  const comps = e.moveSet().components;
  if (!comps.length) { notify('Select the components first', 'error'); return; }
  const boxes = comps.map((c) => componentExtent(e.doc, c)).filter((b): b is BBox => !!b);
  const bottom = comps.every((c) => e.doc.components[c]!.layer === L.BOTTOM);
  const room = newRoom(e.doc.rules, { outline: wrapOutline(boxes, kind, GAP), scope: scopeFor(e.doc, comps), layer: bottom ? L.BOTTOM : L.TOP });
  e.undo.transact('Create room from components', (tx) => tx.add(editRooms(e.doc, { add: [room] })));
  e.select([`room:${e.doc.rules.length - 1}`]);
  notify(`Room ${room.bag.get('NAME')} made round ${plural(comps.length, 'component')}`);
}

/** Selected tracks and arcs that close a loop, as its corners in order. */
function loopOf(prims: PcbPrim[]): Vec2[] | null {
  const segs = prims.filter((p): p is PcbTrack => p.kind === 'track').map((t) => [t.a, t.b] as [Vec2, Vec2]);
  if (segs.length < 3) return null;
  const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
  const left = segs.slice(1), out: Vec2[] = [segs[0]![0], segs[0]![1]];
  while (left.length) {
    const end = out.at(-1)!;
    const k = left.findIndex(([a, b]) => same(a, end) || same(b, end));
    if (k < 0) return null;
    const [a, b] = left.splice(k, 1)[0]!;
    out.push(same(a, end) ? b : a);
  }
  if (!same(out[0]!, out.at(-1)!)) return null;
  return out.slice(0, -1);
}

/** Copy Room Formats: the destination's components take the source's placement (matched by footprint, in designator order [est]), optionally its routing and shape. */
function copyFormat(e: PcbEditor, src: Room, dst: Room, o: { placement: boolean; routing: boolean; shape: boolean }): number {
  const doc = e.doc;
  const natural = (a: number, b: number) => doc.components[a]!.designator.localeCompare(doc.components[b]!.designator, undefined, { numeric: true });
  const sComps = (roomMembers(doc, src).length ? roomMembers(doc, src) : componentsIn(doc, src)).sort(natural);
  const dComps = (roomMembers(doc, dst).length ? roomMembers(doc, dst) : componentsIn(doc, dst)).sort(natural);
  const sb = boxOf(src.outline), db = boxOf(dst.outline);
  const d = { x: db.minX - sb.minX, y: db.minY - sb.minY };
  const used = new Set<number>(), pairs: [number, number][] = [];
  for (const s of sComps) {
    const t = dComps.find((c) => !used.has(c) && doc.components[c]!.pattern === doc.components[s]!.pattern);
    if (t === undefined) continue;
    used.add(t); pairs.push([s, t]);
  }
  e.undo.transact('Copy room formats', (tx) => {
    if (o.shape) tx.add(editRooms(doc, { set: new Map([[dst.rule, withOutline(doc.rules[dst.rule]!, src.outline.map((p) => ({ x: p.x + d.x, y: p.y + d.y })))]]) }));
    if (o.placement) for (const [s, t] of pairs) {
      const S = doc.components[s]!, T = doc.components[t]!;
      const want = { x: S.at.x + d.x, y: S.at.y + d.y };
      move(e, t, { x: want.x - T.at.x, y: want.y - T.at.y }, ((S.rotation - T.rotation) % 360 + 360) % 360, T.at);
    }
    if (o.routing) {
      // Nets carried over by the pads of matched components (same pad names)
      const netMap = new Map<number, number>();
      for (const [s, t] of pairs) for (const p of doc.prims) {
        if (p.kind !== 'pad' || p.component !== s || p.net === NO_NET) continue;
        const q = doc.prims.find((x) => x.kind === 'pad' && x.component === t && x.name === p.name);
        if (q && q.kind === 'pad' && q.net !== NO_NET) netMap.set(p.net, q.net);
      }
      const copper = routingIn(doc, src).filter((p) => 'net' in p && netMap.has(p.net));
      const tracks = copper.filter((p): p is PcbTrack => p.kind === 'track').map((t) => ({ layer: t.layer, a: { x: t.a.x + d.x, y: t.a.y + d.y }, b: { x: t.b.x + d.x, y: t.b.y + d.y }, width: t.width, net: netMap.get(t.net)! }));
      const vias = copper.filter((p) => p.kind === 'via').map((v) => v.kind === 'via' ? { at: { x: v.at.x + d.x, y: v.at.y + d.y }, diameter: v.diameter, hole: v.hole, net: netMap.get(v.net)!, layerStart: v.layerStart, layerEnd: v.layerEnd } : null).filter((v): v is NonNullable<typeof v> => !!v);
      if (tracks.length) tx.add(addTracks(doc, tracks));
      if (vias.length) tx.add(addVias(doc, vias));
    }
  });
  return pairs.length;
}

export function pcbRoomCommands(): Command[] {
  const placeRect = on((e) => e.setTool(new TwoPointTool(e, 'place-room', ['Place Rectangular Room: click one corner', 'Place Rectangular Room: click the opposite corner'], (a, b) => {
    if (a.x === b.x || a.y === b.y) return;
    const o = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
    const r = newRoom(e.doc.rules, { outline: o, layer: e.currentLayer === L.BOTTOM ? L.BOTTOM : L.TOP });
    e.undo.transact('Place room', (tx) => tx.add(editRooms(e.doc, { add: [r] })));
    e.invalidate(); tick.value++;
  })));
  const placePoly = on((e) => e.setTool(new PolyPointsTool(e, 'place-room-poly', 'Place Polygonal Room', (pts) => {
    const r = newRoom(e.doc.rules, { outline: pts, layer: e.currentLayer === L.BOTTOM ? L.BOTTOM : L.TOP });
    e.undo.transact('Place room', (tx) => tx.add(editRooms(e.doc, { add: [r] })));
    e.invalidate(); tick.value++;
  })));
  const moveRoom = on((e) => {
    const sel = e.selectedRooms();
    const start = (rule: number, at: Vec2) => e.setTool(new PcbMoveTool(e, e.moveSet([`room:${rule}`]), at, false, 'move'));
    if (sel.length === 1) { start(sel[0]!, roomOutline(e.doc.rules[sel[0]!]!)[0]!); return; }
    e.setTool(new PickTool(e, 'Move Room: click a room', (p) => { const r = roomAt(e, p.raw); if (!r) return false; setTimeout(() => start(r.rule, p.world)); return true; }));
  });
  const editVerts = on((e) => { const sel = e.selectedRooms(); e.setTool(new RoomVertexTool(e, sel.length === 1 ? sel[0] : undefined)); });
  const wrapCmd = (kind: 'rect' | 'ortho' | 'nonortho') => on((e) => {
    const sel = e.selectedRooms();
    if (sel.length) { for (const r of roomsOf(e.doc).filter((x) => sel.includes(x.rule))) wrap(e, r, kind); e.invalidate(); return; }
    pickRoom(e, 'Wrap Room Around Components', (r) => wrap(e, r, kind), true);
  });
  const slice = (classes: boolean) => on((e) => e.setTool(new TwoPointTool(e, 'slice-room', ['Slice Room: click where the line starts', 'Slice Room: click where it ends'], (a, b) => {
    e.setTool(null);
    const r = roomsOf(e.doc).find((x) => slicePolygon({ outline: x.outline } as never, a, b).length > 1);
    if (!r) { notify('The line must cross a room from side to side', 'error'); return; }
    const pieces = slicePolygon({ outline: r.outline } as never, a, b);
    const doc = e.doc, base = doc.rules[r.rule]!;
    const made = pieces.slice(1).map((o, k) => { const n = withOutline(base, o); n.bag.set('NAME', `${r.name}_${k + 1}`); n.bag.set('UNIQUEID', `${base.bag.get('UNIQUEID') ?? 'ROOM'}${k + 1}`.slice(-8)); return n; });
    e.undo.transact(classes ? 'Slice room and create classes' : 'Slice room', (tx) => {
      const first = withOutline(base, pieces[0]!);
      if (classes) {
        // Each part's components become a class the part holds
        const parts = [first, ...made];
        const bags = [...doc.classes.map((c) => c.bag)];
        parts.forEach((part) => {
          const name = part.bag.get('NAME') ?? r.name;
          const comps = componentsIn(doc, { ...r, outline: roomOutline(part) }).map((c) => doc.components[c]!.designator);
          bags.push(classBag(name, 1, comps));
          part.bag.set('SCOPE1EXPRESSION', `InComponentClass('${name}')`);
        });
        tx.add(setClasses(doc, bags));
      }
      tx.add(editRooms(doc, { set: new Map([[r.rule, first]]), add: made }));
    });
    notify(`${r.name} sliced into ${pieces.length}`);
  })));
  const roomConnections = (only?: boolean) => on((e) => {
    const go = (r: Room) => { e.select(routingIn(e.doc, r).map((p) => `${p.src.storage}:${p.src.index}`)); e.invalidateOverlay(); };
    const sel = e.selectedRooms();
    if (sel.length && !only) { const keys: string[] = []; for (const r of roomsOf(e.doc).filter((x) => sel.includes(x.rule))) keys.push(...routingIn(e.doc, r).map((p) => `${p.src.storage}:${p.src.index}`)); e.select(keys); return; }
    pickRoom(e, 'Select Room Connections', go);
  });
  const unroute = on((e) => pickRoom(e, 'Un-Route Room', (r) => {
    const prims = routingIn(e.doc, r);
    if (!prims.length) { notify(`Nothing routed in ${r.name}`); return; }
    e.undo.transact(`Un-route room ${r.name}`, (tx) => tx.add(removePrims(e.doc, prims)));
    notify(`${plural(prims.length, 'object')} removed from ${r.name}`);
  }, true));
  return [
    { id: 'ad:PCB:PlaceRectangularRoom', label: 'Place Rectangular Room', scopes: PCB, enabled: () => !!board(), run: placeRect },
    { id: 'ad:PCB:PlacePolygonalRoom', label: 'Place Polygonal Room', scopes: PCB, enabled: () => !!board(), run: placePoly },
    { id: 'ad:PCB:MoveRoom', label: 'Move Room', scopes: PCB, enabled: hasRooms, run: moveRoom },
    { id: 'ad:PCB:MoveSingleRoom', label: 'Move Room', scopes: PCB, enabled: hasRooms, run: moveRoom },
    { id: 'ad:PCB:EditRoomVertices', label: 'Edit Polygonal Room Vertices', scopes: PCB, enabled: hasRooms, run: editVerts },
    { id: 'ad:PCB:EditSingleRoomVertices', label: 'Edit Polygonal Room Vertices', scopes: PCB, enabled: hasRooms, run: editVerts },
    { id: 'ad:PCB:ChannelFormatCopier', label: 'Copy Room Formats', scopes: PCB, enabled: () => !!board() && roomsOf(board()!.doc).length > 1, run: on((e) => {
      let src: Room | null = null;
      e.setTool(new PickTool(e, 'Copy Room Formats: click the source room, then the room to copy to', (p) => {
        const r = roomAt(e, p.raw);
        if (!r) return false;
        if (!src) { src = r; notify(`Source: ${r.name}; now click the room to copy to`); return false; }
        if (r.rule === src.rule) return false;
        const s = src, d = r;
        showDialog(ConfirmDialog, { title: 'Confirm Channel Format Copy', message: `Copy ${s.name}'s component placement, routing and room shape to ${d.name}?`,
          detail: 'Components are matched by footprint, in designator order [est]; routing goes over on the nets of the matched pads.', onYes: () => {
            const n = copyFormat(e, s, d, { placement: true, routing: true, shape: true });
            e.invalidate(); notify(`${plural(n, 'component')} placed as in ${s.name}`);
          } });
        return true;
      }));
    }) },
    { id: 'ad:PCB:ArrangeRooms', label: 'Arrange Rooms', scopes: PCB, enabled: hasRooms, run: on((e) => {
      // Rooms side by side to the right of the board, with what they hold [est]
      const o = e.doc.board.outline;
      const right = o.length ? Math.max(...o.map((p) => p.x)) + mil(200) : 0, top = o.length ? Math.max(...o.map((p) => p.y)) : 0;
      let x = right;
      e.undo.transact('Arrange rooms', () => {
        for (const r of roomsOf(e.doc)) {
          const b = boxOf(r.outline), d = { x: x - b.minX, y: top - b.maxY };
          commitMove(e, e.moveSet([`room:${r.rule}`]), placement({ x: 0, y: 0 }, 0, d), 0, 'move');
          x += b.maxX - b.minX + mil(100);
        }
      });
      e.invalidate();
    }) },
    { id: 'ad:PCB:MoveRoomsToGrid', label: 'Move Rooms To Grid', scopes: PCB, enabled: hasRooms, run: on((e) => {
      const g = e.gridSize(), snap = (v: number) => Math.round(v / g) * g;
      const set = new Map(roomsOf(e.doc).map((r) => [r.rule, withOutline(e.doc.rules[r.rule]!, r.outline.map((p) => ({ x: snap(p.x - e.doc.board.origin.x) + e.doc.board.origin.x, y: snap(p.y - e.doc.board.origin.y) + e.doc.board.origin.y })))]));
      e.undo.transact('Move rooms to grid', (tx) => tx.add(editRooms(e.doc, { set })));
      e.invalidate();
    }) },
    { id: 'ad:PCB:WrapRoomsAroundComponentsBoundingRect', label: 'Wrap Rectangular Room Around Components', scopes: PCB, enabled: hasRooms, run: wrapCmd('rect') },
    { id: 'ad:PCB:WrapRoomsAroundComponentsOrtho', label: 'Wrap Orthogonal Room Around Components', scopes: PCB, enabled: hasRooms, run: wrapCmd('ortho') },
    { id: 'ad:PCB:WrapRoomsAroundComponentsNonOrtho', label: 'Wrap Non-Orthogonal Room Around Components', scopes: PCB, enabled: hasRooms, run: wrapCmd('nonortho') },
    { id: 'ad:PCB:WrapSingleRoomAroundComponentsBoundingRect', label: 'Wrap Rectangular Room Around Components', scopes: PCB, enabled: hasRooms, run: wrapCmd('rect') },
    { id: 'ad:PCB:WrapSingleRoomAroundComponentsOrtho', label: 'Wrap Orthogonal Room Around Components', scopes: PCB, enabled: hasRooms, run: wrapCmd('ortho') },
    { id: 'ad:PCB:WrapSingleRoomAroundComponentsNonOrtho', label: 'Wrap Non-Orthogonal Room Around Components', scopes: PCB, enabled: hasRooms, run: wrapCmd('nonortho') },
    { id: 'ad:PCB:CreateRoomFromComponentsBoundingRect', label: 'Create Rectangle Room from selected components', scopes: PCB, enabled: () => !!board()?.moveSet().components.length, run: on((e) => fromComponents(e, 'rect')) },
    { id: 'ad:PCB:CreateRoomFromComponentsOrtho', label: 'Create Orthogonal Room from selected components', scopes: PCB, enabled: () => !!board()?.moveSet().components.length, run: on((e) => fromComponents(e, 'ortho')) },
    { id: 'ad:PCB:CreateRoomFromComponentsNonOrtho', label: 'Create Non-Orthogonal Room from selected components', scopes: PCB, enabled: () => !!board()?.moveSet().components.length, run: on((e) => fromComponents(e, 'nonortho')) },
    { id: 'ad:PCB:ConvertSelectedToRoom', label: 'Create Room from Selected Primitives', scopes: PCB, enabled: () => (board()?.selection.size ?? 0) >= 3, run: on((e) => {
      const loop = loopOf(e.moveSet().prims);
      if (!loop) { notify('Select tracks that close a loop', 'error'); return; }
      const r = newRoom(e.doc.rules, { outline: loop, layer: e.currentLayer === L.BOTTOM ? L.BOTTOM : L.TOP });
      e.undo.transact('Create room from primitives', (tx) => tx.add(editRooms(e.doc, { add: [r] })));
      e.invalidate();
    }) },
    { id: 'ad:PCB:CutRoom', label: 'Slice Room', scopes: PCB, enabled: hasRooms, run: slice(false) },
    { id: 'ad:PCB:CutSingleRoom', label: 'Slice Room', scopes: PCB, enabled: hasRooms, run: slice(false) },
    { id: 'ad:PCB:SmartCutSingleRoom', label: 'Slice and Create Classes', scopes: PCB, enabled: hasRooms, run: slice(true) },
    { id: 'ad:PCB:SelectRoomConnections', label: 'Room Connections', scopes: PCB, enabled: hasRooms, run: roomConnections() },
    { id: 'ad:PCB:SelectSingleRoomConnections', label: 'Select Room Connections', scopes: PCB, enabled: hasRooms, run: roomConnections(true) },
    { id: 'ad:PCB:ArrangeComponentsWithinRoom', label: 'Arrange Within Room', scopes: PCB, enabled: () => hasRooms() && !!board()?.moveSet().components.length, run: on((e) => {
      const comps = e.moveSet().components.filter((c) => !e.doc.components[c]!.bag.bool('LOCKED'));
      pickRoom(e, 'Arrange Within Room', (r) => {
        let n = 0;
        e.undo.transact('Arrange within room', () => { n = packInto(e, comps, boxOf(r.outline)); });
        notify(`${plural(n, 'component')} arranged in ${r.name}`);
      });
    }) },
    { id: 'ad:PCB:UnRouteRoom', label: 'Room', scopes: PCB, enabled: hasRooms, run: unroute },
    { id: 'ad:PCB:UnRouteSingleRoom', label: 'Unroute Room', scopes: PCB, enabled: hasRooms, run: unroute },
    { id: 'pcb.roomProperties', label: 'Room Properties...', scopes: PCB, enabled: () => (board()?.selectedRooms().length ?? 0) === 1, run: on((e) => showDialog(RoomDialog, { ed: e, rule: e.selectedRooms()[0]! })) },
  ];
}

export { roomAt };
