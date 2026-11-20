import { editRooms, roomOutline, withOutline as roomWithOutline } from '../../model/rooms';
import { mechPairs } from '../../model/pcbBoard';
import { barcodeShape } from '../../model/barcode';
import { dimensionEdges, dimensionGeometry, geometryStrokes, setDimension, transformDimension } from '../../model/dimensions';
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import { arcPoints, pointInPoly, type Vec2 } from '../../core/geom';
import { formatCoord } from '../../core/units';
import { moveComponent, repour, replaceRecords, setPolygon } from '../../model/pcbEdit';
import { connections } from '../../model/drc';
import { otherSide, placement, transformRecord, type PointMap, type XformOpts } from '../../formats/altium/pcbTransform';
import { writeVertices } from '../../formats/altium/pcbdoc';
import { TRACK, put } from '../../formats/altium/pcbLayouts';
import { strokeCapHeight, strokeText } from '../../formats/gerber/stroke';
import { NO_NET, type PcbDocument, type PcbPrim } from '../../model/pcb';
import { L, layerColour } from '../../model/layers';
import { hexToRgb, settings } from '../../core/settings';
import { avoidFraction, pushes } from '../../model/compPush';
import { primKey, type PcbEditor } from './PcbEditor';

export interface PcbMoveSet { components: number[]; polygons: number[]; prims: PcbPrim[]; /** Dimensions (Dimensions6 indices). */ dimensions?: number[]; /** Rooms (their rule indices). */ rooms?: number[] }

type Seg = NonNullable<ToolOverlay['segments']>[number];

/** Outline preview of a primitive under a point map (the move tools draw these while moving). */
export function previewPrim(p: PcbPrim, map: (v: Vec2) => Vec2, rot: number, segs: Seg[], circles: NonNullable<ToolOverlay['circles']>, mirror = false, flip = false): void {
  const col = (l: number) => layerColour(flip ? otherSide(l) : l);
  switch (p.kind) {
    case 'track': segs.push({ a: map(p.a), b: map(p.b), width: p.width, color: col(p.layer) }); break;
    case 'arc': {
      const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360;
      const pts = arcPoints(p.c, p.r, p.r, p.start, p.start + sweep, Math.max(6, Math.ceil(sweep / 12))).map(map);
      for (let i = 1; i < pts.length; i++) segs.push({ a: pts[i - 1]!, b: pts[i]!, width: p.width, color: col(p.layer) });
      break;
    }
    case 'via': circles.push({ c: map(p.at), r: p.diameter / 2, color: hexToRgb(settings.pcbViaColour) }, { c: map(p.at), r: p.hole / 2, color: hexToRgb(settings.pcbHoleColour) }); break;
    case 'pad': {
      const at = map(p.at), st = p.top, ang = (((mirror ? rot - p.rotation : p.rotation + rot) + (st.w >= st.h ? 0 : 90)) * Math.PI) / 180;
      const long = Math.max(st.w, st.h), short = Math.min(st.w, st.h), h = (long - short) / 2;
      const d = { x: Math.cos(ang) * h, y: Math.sin(ang) * h };
      segs.push({ a: { x: at.x - d.x, y: at.y - d.y }, b: { x: at.x + d.x, y: at.y + d.y }, width: short, color: p.layer === L.MULTI ? hexToRgb(settings.pcbViaColour) : col(p.layer) });
      if (p.hole) circles.push({ c: at, r: p.hole / 2, color: hexToRgb(settings.pcbHoleColour) });
      break;
    }
    case 'fill': {
      const cs = [p.a, { x: p.b.x, y: p.a.y }, p.b, { x: p.a.x, y: p.b.y }].map(map);
      for (let i = 0; i < 4; i++) segs.push({ a: cs[i]!, b: cs[(i + 1) % 4]!, width: 0, color: col(p.layer) });
      break;
    }
    case 'region': case 'body': {
      const cs = p.outline.map(map);
      for (let i = 0; i < cs.length; i++) segs.push({ a: cs[i]!, b: cs[(i + 1) % cs.length]!, width: 0, color: col(p.layer) });
      break;
    }
    case 'text': {
      if (p.hidden) break;
      if (p.barcode) {
        const box = barcodeShape(p.text, p.at, p.rotation, p.mirrored, p.height, p.barcode).box.map(map);
        for (let i = 0; i < 4; i++) segs.push({ a: box[i]!, b: box[(i + 1) % 4]!, width: 0, color: col(p.layer) });
        break;
      }
      for (const pl of strokeText(p.text, p.at, strokeCapHeight(p), p.rotation, p.mirrored)) {
        const q = pl.map(map);
        for (let i = 1; i < q.length; i++) segs.push({ a: q[i - 1]!, b: q[i]!, width: p.strokeWidth || p.height / 10, color: col(p.layer) });
      }
      break;
    }
  }
}

type Track = Extract<PcbPrim, { kind: 'track' }>;

/** Points that drag connected track ends along: track and arc ends, via and pad centres. */
function movingPoints(doc: PcbDocument, set: PcbMoveSet, dragComponents: boolean): Map<string, Vec2> {
  const out = new Map<string, Vec2>();
  const add = (v: Vec2) => out.set(`${v.x},${v.y}`, v);
  for (const p of set.prims) {
    if (p.kind === 'track') { add(p.a); add(p.b); }
    else if (p.kind === 'via' || p.kind === 'pad') add(p.at);
    else if (p.kind === 'arc') {
      for (const a of [p.start, p.end]) add({ x: Math.round(p.c.x + p.r * Math.cos((a * Math.PI) / 180)), y: Math.round(p.c.y + p.r * Math.sin((a * Math.PI) / 180)) });
    }
  }
  if (dragComponents) {
    const comps = new Set(set.components);
    for (const p of doc.prims) if (p.kind === 'pad' && comps.has(p.component)) add(p.at);
  }
  return out;
}

/** Free tracks (not moving themselves) with an end on a moving point. */
function attachedTracks(doc: PcbDocument, set: PcbMoveSet, pts: Map<string, Vec2>): { t: Track; ends: ('a' | 'b')[] }[] {
  if (!pts.size) return [];
  const moving = new Set(set.prims);
  const out: { t: Track; ends: ('a' | 'b')[] }[] = [];
  for (const p of doc.prims) {
    if (p.kind !== 'track' || moving.has(p) || p.component !== NO_NET || p.polygon !== NO_NET) continue;
    const ends = (['a', 'b'] as const).filter((e) => pts.has(`${p[e].x},${p[e].y}`));
    if (ends.length) out.push({ t: p, ends: [...ends] });
  }
  return out;
}

export type PcbMoveMode = 'move' | 'drag';

/**
 * Apply a move to the board as one undo step: free objects (and the ends of tracks attached to
 * them), whole components, polygon pours (repoured, as Preferences › Polygon Repour says).
 * In Drag mode the tracks on a component's pads follow it too (Preferences › PCB Editor ›
 * General › Comp Drag › Connected Tracks; None leaves them).
 */
export function commitMove(ed: PcbEditor, set: PcbMoveSet, map: PointMap, rot: number, mode: PcbMoveMode, label?: string, o: XformOpts = {}): void {
  const doc = ed.doc;
  const attached = attachedTracks(doc, set, movingPoints(doc, set, mode === 'drag' && settings.pcbCompDrag === 'tracks'));
  const edits: { storage: string; index: number; after: ReturnType<typeof transformRecord> }[] = [];
  // (flipped: objects on a component layer pair's mechanical layer go to its partner)
  const pairs = o.flip ? mechPairs(doc) : undefined;
  for (const p of set.prims) {
    const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
    if (rec) edits.push({ storage: p.src.storage, index: p.src.index, after: transformRecord(rec, map, rot, { ...o, storage: p.src.storage, pairs }) });
  }
  for (const { t, ends } of attached) {
    const rec = doc.streams.get(t.src.storage)!.records[t.src.index]!;
    const s = rec.subs[0]!.slice();
    for (const e of ends) {
      const q = map(t[e]);
      if (e === 'a') { put(s, TRACK.x1, Math.round(q.x)); put(s, TRACK.y1, Math.round(q.y)); } else { put(s, TRACK.x2, Math.round(q.x)); put(s, TRACK.y2, Math.round(q.y)); }
    }
    edits.push({ storage: t.src.storage, index: t.src.index, after: { tag: rec.tag, subs: [s, ...rec.subs.slice(1)] } });
  }
  const comps = [...set.components], polys = [...set.polygons], dims = [...(set.dimensions ?? [])], rooms = [...(set.rooms ?? [])];
  const n = comps.length + polys.length + set.prims.length + dims.length + rooms.length;
  const moved = new Set(polys);
  ed.undo.transact(label ?? `Move ${n} object${n === 1 ? '' : 's'}`, (tx) => {
    if (edits.length) tx.add(replaceRecords(doc, edits));
    if (rooms.length) tx.add(editRooms(doc, { set: new Map(rooms.map((i) => [i, roomWithOutline(doc.rules[i]!, roomOutline(doc.rules[i]!).map((v) => rnd(map(v))))])) }));
    for (const c of comps) {
      const at = doc.components[c]!.at, q = map(at);
      tx.add(moveComponent(doc, c, { x: Math.round(q.x - at.x), y: Math.round(q.y - at.y) }, rot, o));
    }
    for (const i of dims) {
      const d = doc.dimensions[i];
      if (d) tx.add(setDimension(doc, i, transformDimension(d, (v) => rnd(map(v)), rot, !!o.mirror).bag));
    }
    for (const i of polys) {
      const poly = doc.polygons[i]!;
      const bag = poly.bag.clone();
      writeVertices(bag, poly.vertices.map((v) => ({ p: rnd(map(v.p)), arc: v.arc ? { c: map(v.arc.c), r: v.arc.r,
        sa: o.mirror ? norm(rot + 180 - v.arc.ea) : norm(v.arc.sa + rot), ea: o.mirror ? norm(rot + 180 - v.arc.sa) : norm(v.arc.ea + rot) } : undefined })));
      tx.add(setPolygon(doc, i, bag));
      if (settings.pcbRepourAfterModification) tx.add(repour(doc, i));
    }
    if (settings.pcbRepourAfterModification && settings.pcbRepourDependent) {
      for (const i of dependentPolygons(doc, set, map)) if (!moved.has(i)) tx.add(repour(doc, i));
    }
  });
}

const rnd = (v: Vec2): Vec2 => ({ x: Math.round(v.x), y: Math.round(v.y) });
const norm = (a: number) => ((a % 360) + 360) % 360;

/** Pours whose outline holds something that moved (before or after). */
export function dependentPolygons(doc: PcbDocument, set: PcbMoveSet, map: PointMap): number[] {
  const pts: Vec2[] = [];
  const comps = new Set(set.components);
  for (const p of [...set.prims, ...doc.prims.filter((q) => 'component' in q && comps.has(q.component))]) {
    const v = 'at' in p ? p.at : 'a' in p ? p.a : 'c' in p ? p.c : p.outline[0];
    if (v) pts.push(v, map(v));
  }
  return doc.polygons.filter((pg) => pts.some((v) => pointInPoly(v, pg.outline))).map((pg) => pg.index);
}

/**
 * Moving on the board: whole components, polygon pours and free objects together. Ends of
 * tracks attached to moving tracks and vias follow (Altium's track drag keeps connections);
 * in Drag mode the tracks on a component's pads follow it too. The reference point lands on
 * the grid; Space / Shift+Space turn by the rotation step (Preferences › PCB Editor ›
 * General); X / Y mirror (components only after a warning, as they stay on their side) and
 * L flips to the other side of the board.
 */
export class PcbMoveTool implements Tool {
  readonly id = 'pcb-move';
  private pos: Vec2;
  private rot = 0;
  /** Reflected left–right before the rotation (X; Y is X turned 180°); flipped to the other side (L). */
  private mirror = false;
  private flip = false;
  private ref: Vec2;
  private picking: boolean;

  /** Started from the menu without a selection: after each placement it asks for the next object. */
  private repeat: boolean;

  constructor(private ed: PcbEditor, private set: PcbMoveSet, private grab: Vec2, private release = true, private mode: PcbMoveMode = 'move', pick = false,
    private only: 'any' | 'component' = 'any') {
    this.pos = grab;
    this.picking = pick;
    this.repeat = pick && !set.components.length && !set.polygons.length && !set.prims.length && !set.dimensions?.length;
    this.ref = this.refOf(set, grab);
    this.centre();
  }

  /**
   * Where what is picked up hangs from the cursor (Preferences › PCB Editor › General):
   * Smart Component Snap — a component picked up by one of its pads, from that pad's centre;
   * Snap To Center — a component from its reference point, so it turns about the cursor there;
   * Snap To Room Hot Spots — a room from its corner nearest the cursor.
   */
  private centre(): void {
    const c = this.set.components[0];
    if (c !== undefined && settings.pcbSmartComponentSnap) {
      const g = this.grab;
      const pad = this.ed.doc.prims.find((p) => p.kind === 'pad' && p.component === c
        && Math.hypot(p.at.x - g.x, p.at.y - g.y) <= Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h) / 2);
      if (pad && pad.kind === 'pad') { this.grab = pad.at; return; }
    }
    if (settings.pcbSnapToCenter && this.set.components.length) { this.grab = this.ref; return; }
    const rm = this.set.rooms?.[0];
    if (rm !== undefined && settings.pcbSnapRoomHotSpots && !this.set.components.length && !this.set.prims.length && this.ed.doc.rules[rm]) {
      const g = this.grab;
      let best: Vec2 | null = null, d = Infinity;
      for (const v of roomOutline(this.ed.doc.rules[rm]!)) { const k = Math.hypot(v.x - g.x, v.y - g.y); if (k < d) { d = k; best = v; } }
      if (best) this.grab = best;
    }
  }

  private refOf(set: PcbMoveSet, grab: Vec2): Vec2 {
    const c = set.components[0], pg = set.polygons[0], p = set.prims[0], dm = set.dimensions?.[0], rm = set.rooms?.[0];
    if (rm !== undefined && this.ed.doc.rules[rm]) return roomOutline(this.ed.doc.rules[rm]!)[0] ?? grab;
    return c !== undefined ? this.ed.doc.components[c]!.at
      : pg !== undefined ? this.ed.doc.polygons[pg]!.outline[0]!
      : dm !== undefined && !p ? this.ed.doc.dimensions[dm]?.refs[0] ?? grab
      : p ? ('at' in p ? p.at : 'a' in p ? p.a : 'c' in p ? p.c : p.outline[0] ?? grab) : grab;
  }

  private count(): number { return this.set.components.length + this.set.polygons.length + this.set.prims.length + (this.set.dimensions?.length ?? 0) + (this.set.rooms?.length ?? 0); }

  /** Take what moves (and the track ends it pulls) out of the scene; the overlay draws it. */
  private hide(): void {
    if (this.picking) return;
    const doc = this.ed.doc;
    const pts = movingPoints(doc, this.set, this.mode === 'drag' && settings.pcbCompDrag === 'tracks');
    const keys = new Set<string>([...this.set.prims.map(primKey), ...this.set.polygons.map((i) => `poly:${i}`), ...(this.set.dimensions ?? []).map((i) => `dim:${i}`), ...(this.set.rooms ?? []).map((i) => `room:${i}`)]);
    for (const { t } of attachedTracks(doc, this.set, pts)) keys.add(primKey(t));
    const comps = new Set(this.set.components);
    const points = new Set(pts.keys());
    for (const p of doc.prims) if (p.kind === 'pad' && comps.has(p.component)) points.add(`${p.at.x},${p.at.y}`);
    this.ed.setGhost({ keys, comps, points });
  }
  activate(): void { this.hide(); }
  deactivate(): void { this.ed.setGhost(null); }

  hint(): string {
    if (this.picking) return this.count()
      ? `${this.mode === 'drag' ? 'Drag' : 'Move'} Selection: click the reference point`
      : this.only === 'component' ? 'Move Component: click the component (right-click to finish)' : `${this.mode === 'drag' ? 'Drag' : 'Move'}: click the object (right-click to finish)`;
    const d = this.delta(), u = this.ed.units();
    return `${this.mode === 'drag' ? 'Dragging' : 'Moving'} ${this.count()} object${this.count() === 1 ? '' : 's'} by ${formatCoord(d.x, u)}, ${formatCoord(d.y, u)}${this.rot ? `, ${this.rot}°` : ''}`
      + `${this.flip ? ', flipped to the other side' : this.mirror ? ', mirrored' : ''}. `
      + `${this.release ? 'Release' : 'Click'} to place, Space / Shift+Space rotate, X / Y mirror, L flip side, right-click cancels`;
  }

  private delta(): Vec2 {
    const pivoted = placement(this.grab, this.rot, { x: 0, y: 0 }, this.mirror)(this.ref);
    const target = this.ed.snap({ x: pivoted.x + this.pos.x - this.grab.x, y: pivoted.y + this.pos.y - this.grab.y });
    return { x: target.x - pivoted.x, y: target.y - pivoted.y };
  }
  private map() { return placement(this.grab, this.rot, this.delta(), this.mirror); }

  pointerMove(p: ToolPointer): void { this.pos = p.raw; }
  pointerUp(p: ToolPointer): void { if (this.release && !this.picking) { this.pos = p.raw; this.place(); } }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (this.picking) {
      if (!this.count()) {
        let set: PcbMoveSet | null;
        if (this.only === 'component') {
          const c = this.ed.componentAt(p.raw);
          set = c === null ? null : { components: [c], polygons: [], prims: [] };
          if (c !== null) this.ed.selectComponent(c);
        } else set = this.ed.moveSetAt(p.raw);
        if (!set) return;
        this.set = set;
      }
      this.grab = p.world; this.pos = p.raw; this.ref = this.refOf(this.set, p.world); this.rot = 0;
      this.centre();
      this.picking = false;
      this.hide();
      return;
    }
    if (!this.release) { this.pos = p.raw; this.place(); }
  }

  key(combo: string): boolean {
    if (this.picking) return false;
    const step = settings.pcbRotationStep || 90;
    if (combo === 'Space') { this.rot = (this.rot + step) % 360; return true; }
    if (combo === 'Shift+Space') { this.rot = (this.rot + 360 - step) % 360; return true; }
    if (combo === 'Escape') { if (!this.cancel()) this.ed.setTool(null); return true; }
    if (combo === 'X' || combo === 'Y') {
      const go = () => { this.reflect(combo === 'Y'); this.ed.invalidateOverlay(); };
      if (this.set.components.length && !this.mirrorOk) {
        this.ed.confirm('Mirroring a component keeps it on the same side of the board, reversing its footprint. To place it on the other side, press L instead. Mirror anyway?',
          () => { this.mirrorOk = true; go(); });
      } else go();
      return true;
    }
    if (combo === 'L') { this.reflect(false); this.flip = !this.flip; return true; }
    return false;
  }
  private mirrorOk = false;
  /** Reflect what moves: R(r)·Mˣ after X is R(−r)·Mˣ⁺¹; Y is X then a half turn. */
  private reflect(vertical: boolean): void {
    this.mirror = !this.mirror;
    this.rot = ((vertical ? 180 - this.rot : -this.rot) % 360 + 360) % 360;
  }
  /** Right-click: drop what is being moved (back where it was); a repeating Move asks for the next object. */
  cancel(): boolean {
    if (this.picking || !this.repeat) return false;
    this.reset();
    return true;
  }
  /** Undo, redo or an edit from elsewhere: what was being moved is no longer those objects. */
  abort(): void { this.reset(); if (!this.repeat) this.ed.setTool(null); }
  private reset(): void {
    this.ed.setGhost(null);
    this.set = { components: [], polygons: [], prims: [] };
    this.picking = true;
    this.rot = 0; this.mirror = false; this.flip = false;
  }

  private place(): void {
    let d = this.delta();
    const rot = this.rot;
    this.ed.setGhost(null);
    const what = this.flip ? 'Flip' : this.mirror ? 'Mirror' : this.mode === 'drag' ? 'Drag' : 'Move';
    const comps = this.set.components, label = `${what} ${this.count()} object${this.count() === 1 ? '' : 's'}`;
    // Component pushing (Preferences › Interactive Routing › Dragging): stop short of other components, or push them aside
    const pushing = comps.length && !this.flip ? settings.pcbCompPushing : 'Ignore';
    if (pushing === 'Avoid' && (d.x || d.y)) {
      const full = d, g = this.ed.gridSize();
      const t = avoidFraction(this.ed.doc, comps, (f) => placement(this.grab, rot, { x: full.x * f, y: full.y * f }, this.mirror));
      if (t < 1) {
        d = { x: Math.trunc((full.x * t) / g) * g, y: Math.trunc((full.y * t) / g) * g };
        this.ed.status?.('Stopped short of another component (Preferences › Interactive Routing › Component pushing: Avoid)');
      }
    }
    const map = placement(this.grab, rot, d, this.mirror);
    if (d.x || d.y || rot || this.mirror || this.flip) {
      const pushed = pushing === 'Push' ? pushes(this.ed.doc, comps, map, d) : new Map<number, Vec2>();
      this.ed.undo.transact(pushed.size ? `${label}, pushing ${pushed.size} component${pushed.size === 1 ? '' : 's'}` : label, () => {
        commitMove(this.ed, this.set, map, rot, this.mode, label, { mirror: this.mirror, flip: this.flip });
        for (const [c, sh] of pushed) commitMove(this.ed, { components: [c], polygons: [], prims: [] }, (v) => ({ x: v.x + sh.x, y: v.y + sh.y }), 0, 'drag', 'Push component');
      });
    }
    if (this.repeat) this.reset(); else this.ed.setTool(null);
  }

  overlay(): ToolOverlay | null {
    if (this.picking) return null;
    const doc = this.ed.doc;
    const map = this.map();
    const segments: Seg[] = [];
    const circles: NonNullable<ToolOverlay['circles']> = [];
    const comps = new Set(this.set.components);
    for (const p of this.set.prims) previewPrim(p, map, this.rot, segments, circles, this.mirror, this.flip);
    for (const p of doc.prims) if ('component' in p && comps.has(p.component) && !(p.kind === 'text' && p.hidden)) previewPrim(p, map, this.rot, segments, circles, this.mirror, this.flip);
    for (const i of this.set.dimensions ?? []) {
      const d = doc.dimensions[i];
      if (!d) continue;
      const col = layerColour(d.layer);
      for (const st of geometryStrokes(dimensionGeometry(d, false, dimensionEdges(doc.prims)))) for (let k = 1; k < st.pts.length; k++) segments.push({ a: map(st.pts[k - 1]!), b: map(st.pts[k]!), width: st.w, color: col });
    }
    for (const i of this.set.rooms ?? []) {
      const r = doc.rules[i];
      if (!r) continue;
      const o = roomOutline(r).map(map);
      for (let k = 0; k < o.length; k++) segments.push({ a: o[k]!, b: o[(k + 1) % o.length]!, width: 0, color: 0xb48ce6 });
    }
    for (const i of this.set.polygons) {
      const o = doc.polygons[i]!.outline.map(map), col = layerColour(doc.polygons[i]!.layer);
      for (let k = 0; k < o.length; k++) segments.push({ a: o[k]!, b: o[(k + 1) % o.length]!, width: 0, color: col });
    }
    const pts = movingPoints(doc, this.set, this.mode === 'drag' && settings.pcbCompDrag === 'tracks');
    for (const { t, ends } of attachedTracks(doc, this.set, pts)) {
      segments.push({ a: ends.includes('a') ? map(t.a) : t.a, b: ends.includes('b') ? map(t.b) : t.b, width: t.width, color: layerColour(t.layer) });
    }
    if (settings.pcbShowConnections) {
      const padPts = new Map(pts);
      for (const p of doc.prims) if (p.kind === 'pad' && comps.has(p.component)) padPts.set(`${p.at.x},${p.at.y}`, p.at);
      const colour = hexToRgb(settings.pcbConnectionColour);
      for (const k of connections(doc)) {
        const a = padPts.has(`${k.a.x},${k.a.y}`), b = padPts.has(`${k.b.x},${k.b.y}`);
        if (a || b) segments.push({ a: a ? map(k.a) : k.a, b: b ? map(k.b) : k.b, width: 0, color: colour });
      }
    }
    return { segments, circles };
  }
}
