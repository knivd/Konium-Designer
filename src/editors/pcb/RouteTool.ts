import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import { distToSegment, type Vec2 } from '../../core/geom';
import { formatCoord } from '../../core/units';
import { addPrimRecords, addTracks, addVias, removePrims, replaceRecords, type ViaFields } from '../../model/pcbEdit';
import { styleCorners } from '../../model/hugStyle';
import { flowSegments } from '../../model/reflow';
import { featureOn } from '../../core/release';
import { encodeArc } from '../../formats/altium/pcbdoc';
import { TRACK, VIA, put } from '../../formats/altium/pcbLayouts';
import { carryPrimInfo } from '../../formats/altium/primInfo';
import type { PcbRawRecord } from '../../formats/altium/framing';
import type { TrackFields } from '../../formats/altium/pcbdoc';
import { L, isSignal, layerColour, type LayerId } from '../../model/layers';
import { NO_NET, netName, type PcbPrim, type PcbTrack, type PcbVia } from '../../model/pcb';
import { checkCopper, connections, copperIslands, ruleFor, type DrcViolation } from '../../model/drc';
import { ruleLength } from '../../formats/altium/rules';
import { hexToRgb, settings, updateSettings, type Settings } from '../../core/settings';
import { PCB_CORNER_MODES, arcKey, arcRadius, arcSegments, baseMode, cornerLabel, cornerPath, isArcMode, type CornerMode } from '../corner';
import {
  RouteWorld, clearanceBoundaries, clonePending, multiLayerRoute, noPending, pull, shove, simplify, tighten, walkaround,
  type Dirs, type Pending, type PushedVia, type RItem, type Shoved, type VTrack,
} from '../../model/router';
import { antennasLeft, loopToRemove } from '../../model/routeLoops';
import { primKey, type PcbEditor } from './PcbEditor';

export const DRC_GREEN = 0x00ff00;

type Mode = Settings['pcbRoutingMode'];
/** AD17's conflict modes, in Shift+R order. */
export const ROUTE_MODES: [Mode, string, keyof Settings][] = [
  ['ignore', 'Ignore Obstacles', 'pcbModeIgnore'], ['push', 'Push Obstacles', 'pcbModePush'], ['walkaround', 'Walkaround Obstacles', 'pcbModeWalkaround'],
  ['stop', 'Stop At First Obstacle', 'pcbModeStop'], ['hug', 'Hug And Push Obstacles', 'pcbModeHug'], ['autoroute', 'AutoRoute On Current Layer', 'pcbModeAutoroute'],
  ['autorouteMulti', 'AutoRoute On Multiple Layers', 'pcbModeAutorouteMulti'],
];
const modeLabel = (m: Mode) => ROUTE_MODES.find(([k]) => k === m)?.[1] ?? m;
export type WidthMode = 'min' | 'pref' | 'max' | 'user';
export type ViaMode = 'min' | 'pref' | 'max' | 'user';
const WIDTH_LABEL: Record<WidthMode, string> = { min: 'Rule Minimum', pref: 'Rule Preferred', max: 'Rule Maximum', user: 'User Choice' };
const GLOSS: Settings['pcbGlossRouted'][] = ['off', 'weak', 'strong'];

type Step = { kind: 'segs'; count: number; head: Vec2; pending: Pending; layer?: LayerId; vias?: number } | { kind: 'via'; head: Vec2; layer: LayerId; pending: Pending };

const asTrack = (t: TrackFields): PcbTrack => ({
  kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer: t.layer, a: t.a, b: t.b, width: t.width,
  net: t.net ?? NO_NET, component: NO_NET, polygon: NO_NET, locked: false, keepout: false,
});
const asVia = (v: ViaFields): PcbVia => ({
  kind: 'via', src: { storage: 'Vias6', index: -1 }, at: v.at, diameter: v.diameter, hole: v.hole,
  layerStart: v.layerStart ?? L.TOP, layerEnd: v.layerEnd ?? L.BOTTOM, net: v.net ?? NO_NET, locked: false,
});
const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => round({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** The look-ahead: its segments (on more than one layer when AutoRoute On Multiple Layers changes layer), the vias between them. */
interface Look { segs: TrackFields[]; blocked: boolean; violations: DrcViolation[]; shoved: Shoved[]; vias?: Vec2[]; pushedVias?: PushedVia[] }
const EMPTY: Look = { segs: [], blocked: false, violations: [], shoved: [] };

/**
 * Route › Interactive Routing (P, T / Ctrl+W). Click a pad, via or track to start: the route
 * takes that net, the width from the net's Width rule and vias from Routing Via Style. How it
 * meets what is in its way is the Routing Conflict Resolution mode (Shift+R cycles the modes
 * ticked in Preferences):
 * - Ignore Obstacles: where the cursor is; violations are marked;
 * - Walkaround Obstacles: round them, hugging at clearance (AutoRoute On Current Layer looks over
 *   the whole board);
 * - Push Obstacles: free tracks of other nets move aside; it stops at fixed objects;
 * - Hug And Push Obstacles: round fixed objects, pushing free tracks;
 * - Stop At First Obstacle: as far as it goes clear.
 * Pushed tracks move for good when the route is finished (one undo step with it). Clicking a pad
 * of the net finishes (Automatically Terminate Routing); a route that joins two places the net
 * already joins takes the old way out (Automatically Remove Loops).
 *
 * Keys as Altium: * or + / - add a via and change to the next / previous signal layer, 2 adds
 * a via without changing layer, L (at a through-hole start) changes layer without one, 1 toggles
 * look-ahead, 3 / 4 cycle the width and via size sources, Shift+R the conflict mode,
 * Ctrl+Shift+G the gloss effort, Ctrl+W the clearance boundaries, Space / Shift+Space corner
 * direction / style, Ctrl+click completes the connection, Backspace removes the last segment,
 * right-click or Esc finishes the route, a second time leaves the tool.
 */
export class RouteTool implements Tool {
  readonly id = 'route';
  private head: Vec2 | null = null;
  private segs: TrackFields[] = [];
  private vias: ViaFields[] = [];
  private steps: Step[] = [];
  private start: Vec2 | null = null;
  private net = NO_NET;
  private startKey: string | null = null;
  private hover: Vec2 | null = null;
  private hoverTarget = false;
  private corner: CornerMode = settings.pcbTrackCorner;
  private flip = false;
  private look: Look = EMPTY;
  private widthMode: WidthMode = settings.pcbTrackWidthMode;
  private viaMode: ViaMode = settings.pcbViaSizeMode;
  private lookAhead = true;
  private note = '';
  /** Board tracks pushed so far and the tracks that took their place (applied when the route finishes). */
  private pending: Pending = noPending();
  private world: { key: string; w: RouteWorld } | null = null;
  private ghostKey = '';
  /** Pads of the net the route's copper doesn't reach yet: the connection line runs to the nearest. */
  private targets: Vec2[] = [];

  constructor(private ed: PcbEditor) {}

  get active(): boolean { return this.head !== null; }
  get netLabel(): string { return this.net === NO_NET ? 'No Net' : netName(this.ed.doc, this.net); }
  get conflict(): Mode { return settings.pcbRoutingMode; }

  hint(): string {
    const ed = this.ed, l = ed.layerLabel(ed.currentLayer), w = formatCoord(ed.trackWidth, ed.units());
    if (!this.head) return `Interactive Routing (${modeLabel(this.conflict)}): click a pad, via or track to start on ${l}`;
    return `${this.netLabel} on ${l}, ${w} (${WIDTH_LABEL[this.widthMode]}), ${modeLabel(this.conflict)}, ${cornerLabel(this.corner, this.flip)}${isArcMode(this.corner) ? ` (radius ${formatCoord(arcRadius(ed.trackWidth), ed.units())}: , . smaller, larger)` : ''}${this.note ? ` — ${this.note}` : ''}. `
      + `* via, 1 look-ahead ${this.lookAhead ? 'on' : 'off'}, 3 width, 4 via size (${WIDTH_LABEL[this.viaMode]}), Shift+R mode, Ctrl+Shift+G gloss (${settings.pcbGlossRouted}), Ctrl+click complete, Backspace undo, right-click finish`;
  }

  /* ── rules ── */
  private widthFromRule(): void {
    if (this.widthMode === 'user') { this.ed.trackWidth = this.ed.layerWidths.get(this.ed.currentLayer) ?? Math.round(settings.pcbTrackWidth * 10_000); return; }
    const r = ruleFor(this.ed.doc, 'Width', asTrack({ layer: this.ed.currentLayer, a: this.head ?? { x: 0, y: 0 }, b: this.head ?? { x: 0, y: 0 }, width: 0, net: this.net }));
    if (!r) return;
    const key = this.widthMode === 'min' ? 'MINLIMIT' : this.widthMode === 'max' ? 'MAXLIMIT' : 'PREFEREDWIDTH';
    this.ed.trackWidth = ruleLength(r, key, '10mil');
  }
  private viaFromRule(at: Vec2): ViaFields {
    const r = ruleFor(this.ed.doc, 'RoutingVias', asVia({ at, diameter: 0, hole: 0, net: this.net }));
    const stack = this.ed.doc.board.copperStack.filter(isSignal);
    const t = this.ed.viaTemplate;
    const pre = this.viaMode === 'min' ? 'MIN' : this.viaMode === 'max' ? 'MAX' : '';
    const user = this.viaMode === 'user' || !t.fromRule;
    return {
      at, net: this.net === NO_NET ? undefined : this.net,
      diameter: user ? t.diameter : r ? ruleLength(r, `${pre}WIDTH`, '50mil') : 500_000,
      hole: user ? t.hole : r ? ruleLength(r, `${pre}HOLEWIDTH`, '28mil') : 280_000,
      layerStart: stack[0] ?? L.TOP, layerEnd: stack.at(-1) ?? L.BOTTOM,
    };
  }

  /* ── for the Interactive Routing dialog (Tab) ── */
  get trackWidthMode(): WidthMode { return this.widthMode; }
  get viaSizeMode(): ViaMode { return this.viaMode; }
  setTrackWidthMode(m: WidthMode): void { this.widthMode = m; this.widthFromRule(); this.world = null; if (this.head) this.updateLook(); }
  setViaSizeMode(m: ViaMode): void { this.viaMode = m; }
  /** The via the next one will be: its size from the rule or the user's. */
  nextVia(): { diameter: number; hole: number } { const v = this.viaFromRule(this.head ?? this.ed.cursor); return { diameter: v.diameter, hole: v.hole }; }
  /** The Width rule that applies where the route is (its name and limits). */
  widthRule(): { name: string; min: number; pref: number; max: number } | null {
    const at = this.head ?? this.ed.cursor;
    const r = ruleFor(this.ed.doc, 'Width', asTrack({ layer: this.ed.currentLayer, a: at, b: at, width: 0, net: this.net }));
    return r ? { name: r.bag.get('NAME') ?? 'Width', min: ruleLength(r, 'MINLIMIT', '10mil'), pref: ruleLength(r, 'PREFEREDWIDTH', '10mil'), max: ruleLength(r, 'MAXLIMIT', '10mil') } : null;
  }
  /** The Routing Via Style rule that applies (its name and limits). */
  viaRule(): { name: string; minHole: number; maxHole: number; minDia: number; maxDia: number } | null {
    const r = ruleFor(this.ed.doc, 'RoutingVias', asVia({ at: this.head ?? this.ed.cursor, diameter: 0, hole: 0, net: this.net }));
    return r ? { name: r.bag.get('NAME') ?? 'RoutingVias', minHole: ruleLength(r, 'MINHOLEWIDTH', '28mil'), maxHole: ruleLength(r, 'MAXHOLEWIDTH', '28mil'),
      minDia: ruleLength(r, 'MINWIDTH', '50mil'), maxDia: ruleLength(r, 'MAXWIDTH', '50mil') } : null;
  }
  /** A width typed or picked (Tab, Shift+W): the user's choice from now on. */
  setUserWidth(w: number): void { updateSettings({ pcbTrackWidth: w / 10_000 }); this.ed.layerWidths.clear(); this.widthMode = 'user'; this.ed.trackWidth = w; this.world = null; if (this.head) this.updateLook(); }
  /** A user width for one layer only (Apply to all layers off). */
  setLayerWidth(layer: LayerId, w: number): void { this.ed.layerWidths.set(layer, w); this.widthMode = 'user'; this.widthFromRule(); this.world = null; if (this.head) this.updateLook(); }

  /* ── the obstacles ── */
  private routeNet(): number { return this.net; }
  /** The obstacles on the current layer, with what this route has pushed and placed so far. */
  private worldNow(): RouteWorld {
    const ed = this.ed, key = `${ed.currentLayer}|${this.steps.length}|${this.segs.length}|${this.vias.length}`;
    if (this.world && this.world.key === key && this.world.w.doc === ed.doc && (this.world as { prims?: unknown }).prims === ed.doc.prims) return this.world.w;
    const fixed = {
      tracks: this.segs.map((t): VTrack => ({ layer: t.layer, a: t.a, b: t.b, width: t.width, net: t.net ?? NO_NET })),
      vias: this.vias.map((v) => ({ at: v.at, diameter: v.diameter, hole: v.hole, net: v.net ?? NO_NET })),
    };
    const w = new RouteWorld(ed.doc, ed.currentLayer, this.pending, fixed);
    this.world = { key, w };
    (this.world as { prims?: unknown }).prims = ed.doc.prims;
    return w;
  }
  private dirs(): Dirs { const m = baseMode(this.corner); return m === '90' ? 4 : m === 'any' ? 0 : 8; }
  private worlds = new Map<string, RouteWorld>();
  /** Every signal layer's obstacles (AutoRoute On Multiple Layers). */
  private allWorlds(): RouteWorld[] {
    const ed = this.ed, key = `${this.steps.length}|${this.segs.length}|${this.vias.length}`;
    const fixed = {
      tracks: this.segs.map((t): VTrack => ({ layer: t.layer, a: t.a, b: t.b, width: t.width, net: t.net ?? NO_NET })),
      vias: this.vias.map((v) => ({ at: v.at, diameter: v.diameter, hole: v.hole, net: v.net ?? NO_NET })),
    };
    return ed.doc.board.copperStack.filter(isSignal).map((l) => {
      const k = `${l}|${key}`;
      let w = this.worlds.get(k);
      if (!w || w.doc !== ed.doc) { w = l === ed.currentLayer ? this.worldNow() : new RouteWorld(ed.doc, l, this.pending, fixed); this.worlds.set(k, w); }
      return w;
    });
  }
  /** Layers an SMD pad under the cursor lets the route end on (undefined: any). */
  private hoverLayers: LayerId[] | undefined;

  /* ── picking ── */
  /** Copper under the cursor; pads and vias first, as their centres are where routes start and end. */
  private copperAt(raw: Vec2): { prim: PcbPrim; key: string }[] {
    const out: { prim: PcbPrim; key: string }[] = [];
    for (const h of this.ed.hits(raw)) {
      if (h.layer === undefined || !(isSignal(h.layer) || h.layer === L.MULTI)) continue;
      const prim = this.ed.primByKey(h.key);
      if (prim && (prim.kind === 'pad' || prim.kind === 'via' || prim.kind === 'track' || prim.kind === 'arc') && !out.some((o) => o.key === h.key)) out.push({ prim, key: h.key });
    }
    const rank = (p: PcbPrim) => (p.kind === 'pad' || p.kind === 'via' ? 0 : 1);
    return out.sort((a, b) => rank(a.prim) - rank(b.prim));
  }

  /** Same-net pads and vias pull the cursor to their centre (with no net: pads and vias with none). */
  private snapTarget(p: ToolPointer): Vec2 {
    this.hoverTarget = false;
    this.hoverLayers = undefined;
    const hit = this.copperAt(p.raw).find((h) => (h.prim.kind === 'pad' || h.prim.kind === 'via') && h.prim.net === this.net);
    if (!hit || (hit.prim.kind !== 'pad' && hit.prim.kind !== 'via')) return p.world;
    this.hoverTarget = hit.key !== this.startKey || this.segs.length > 0;
    this.hoverLayers = hit.prim.kind === 'pad' && hit.prim.layer !== L.MULTI ? [hit.prim.layer] : undefined;
    return hit.prim.at;
  }

  private begin(p: ToolPointer): void {
    const hit = this.copperAt(p.raw)[0];
    let at = p.world;
    this.net = NO_NET;
    this.startKey = null;
    if (hit) {
      const q = hit.prim;
      this.startKey = hit.key;
      if ('net' in q) this.net = q.net;
      if (q.kind === 'pad' || q.kind === 'via') at = q.at;
      else if (q.kind === 'track') {
        const ends = [q.a, q.b].map((e) => ({ e, d: Math.hypot(e.x - p.raw.x, e.y - p.raw.y) })).sort((x, y) => x.d - y.d);
        at = ends[0]!.d <= q.width ? ends[0]!.e : p.world;
        if (distToSegment(at, q.a, q.b) > q.width / 2) at = ends[0]!.e;
      }
      // An SMD pad, or a track, on another signal layer moves routing to that layer
      const layer = 'layer' in q ? q.layer : undefined;
      if (layer !== undefined && isSignal(layer) && layer !== this.ed.currentLayer) this.ed.setCurrentLayer(layer);
    }
    this.head = round(at);
    this.start = this.head;
    this.widthFromRule();
    // Pickup Track Width From Existing Routes
    if (hit?.prim.kind === 'track' && settings.pcbPickupWidth) this.ed.trackWidth = hit.prim.width;
    // Where the net still has to go: its pads on other islands than the copper routed from
    this.targets = [];
    if (hit && this.net !== NO_NET) {
      const doc = this.ed.doc, island = copperIslands(doc), from = doc.prims.indexOf(hit.prim);
      const mine = from >= 0 ? island(from) : -1;
      doc.prims.forEach((p, i) => { if (p.kind === 'pad' && p.net === this.net && island(i) !== mine) this.targets.push(p.at); });
    }
    this.pending = noPending();
    this.world = null;
    this.hover = this.head;
  }

  /* ── look-ahead ── */
  private trackFields(pts: Vec2[]): TrackFields[] {
    const out: TrackFields[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      if (a.x !== b.x || a.y !== b.y) out.push({ layer: this.ed.currentLayer, a, b, width: this.ed.trackWidth, net: this.net === NO_NET ? undefined : this.net });
    }
    return out;
  }
  private conflicts(segs: TrackFields[]): DrcViolation[] {
    if (!segs.length) return [];
    return checkCopper(this.ed.doc, segs.map(asTrack), { ignorePours: true, clearanceOnly: true });
  }

  /** The longest clean start of a path (bisection on its length). */
  private prefixClear(pts: Vec2[], clear: (pts: Vec2[]) => boolean): Vec2[] {
    const lens = pts.slice(1).map((b, i) => Math.hypot(b.x - pts[i]!.x, b.y - pts[i]!.y));
    const total = lens.reduce((a, b) => a + b, 0);
    const prefix = (t: number): Vec2[] => {
      let left = t * total;
      const out = [pts[0]!];
      for (let i = 0; i < lens.length; i++) {
        if (left >= lens[i]!) { out.push(pts[i + 1]!); left -= lens[i]!; continue; }
        if (left > 0) out.push(lerp(pts[i]!, pts[i + 1]!, left / lens[i]!));
        break;
      }
      return out;
    };
    let lo = 0, hi = 1;
    for (let k = 0; k < 16 && (hi - lo) * total > 1000; k++) {
      const mid = (lo + hi) / 2;
      if (clear(prefix(mid))) lo = mid; else hi = mid;
    }
    return prefix(lo);
  }

  /** Walk round what is in the way (`skip` leaves out what may be pushed instead). */
  private walk(w: RouteWorld, from: Vec2, to: Vec2, skip?: (it: RItem) => boolean, whole = false): { pts: Vec2[]; reached: boolean } | null {
    const net = this.routeNet(), width = this.ed.trackWidth, dirs = this.dirs();
    const b = this.ed.doc.board.outline;
    const window = whole && b?.length ? { minX: Math.min(...b.map((p) => p.x)), minY: Math.min(...b.map((p) => p.y)), maxX: Math.max(...b.map((p) => p.x)), maxY: Math.max(...b.map((p) => p.y)) } : undefined;
    const f = walkaround(w, net, width, from, to, { dirs, skip, window, cells: whole ? 250_000 : undefined });
    if (!f) return null;
    let pts = f.pts;
    if (settings.pcbGlossRouted === 'off') pts = pull(w, net, width, pts, dirs, { skip });
    return { pts, reached: f.reached };
  }

  /** AutoRoute On Multiple Layers from `from` to `to`: segments on each layer, the vias between. */
  private multi(from: Vec2, to: Vec2): Look | null {
    const worlds = this.allWorlds();
    const start = worlds.findIndex((w) => w.layer === this.ed.currentLayer);
    if (start < 0) return null;
    const via = this.viaFromRule(from);
    const ends = this.hoverLayers?.map((l) => worlds.findIndex((w) => w.layer === l)).filter((i) => i >= 0);
    const m = multiLayerRoute(worlds, start, this.routeNet(), this.ed.trackWidth, via, from, to, { dirs: this.dirs(), endLayers: ends });
    if (!m) return null;
    const net = this.net === NO_NET ? undefined : this.net;
    const segs: TrackFields[] = m.runs.flatMap((r) => r.pts.slice(1).map((b, i) => ({ layer: r.layer, a: r.pts[i]!, b, width: this.ed.trackWidth, net })));
    // A layer change through a via of the net already there adds none
    const there = this.ed.doc.prims.filter((p) => p.kind === 'via' && p.net === this.routeNet()) as { at: Vec2; diameter: number }[];
    return { ...EMPTY, segs, blocked: !m.reached, vias: m.vias.filter((v) => !there.some((x) => Math.hypot(x.at.x - v.x, x.at.y - v.y) < x.diameter / 2)) };
  }

  /**
   * Follow Mouse Trail (Preferences › PCB Editor › Interactive Routing): where the cursor has been since the last click,
   * thinned, and the place it was kept from. The route then goes the way the cursor went (round the side of an obstacle
   * the cursor went round) and not the shortest way to where it is now.
   */
  private trail: Vec2[] = [];
  private trailFrom: Vec2 | null = null;
  private trailTo(p: Vec2): void {
    if (this.trailFrom !== this.head) { this.trailFrom = this.head; this.trail = []; }
    if (!this.head || !settings.pcbFollowMouseTrail) return;
    const step = 6 / (this.ed.viewport?.cam.scale ?? 1e-4), last = this.trail.at(-1) ?? this.head;
    if (Math.hypot(p.x - last.x, p.y - last.y) < step) return;
    this.trail.push(round(p));
    // (a long wander keeps every other point: its shape, at half the detail)
    if (this.trail.length > 800) this.trail = this.trail.filter((_, i) => i % 2 === 1);
  }
  /** The trail's turning points between the head and the cursor: the points that stand furthest off the straight way (Douglas and Peucker's thinning), where a track end may stand. */
  private waypoints(w: RouteWorld, head: Vec2, hover: Vec2): Vec2[] {
    const pts = [head, ...this.trail, hover], net = this.routeNet(), width = this.ed.trackWidth;
    const tol = Math.max(4 * width, 24 / (this.ed.viewport?.cam.scale ?? 1e-4));
    const keep = new Set<number>();
    const split = (a: number, b: number): void => {
      let far = -1, most = tol;
      for (let i = a + 1; i < b; i++) { const d = distToSegment(pts[i]!, pts[a]!, pts[b]!); if (d > most) { most = d; far = i; } }
      if (far < 0) return;
      keep.add(far); split(a, far); split(far, b);
    };
    split(0, pts.length - 1);
    return [...keep].sort((a, b) => a - b).map((i) => pts[i]!)
      .filter((p) => Math.hypot(p.x - head.x, p.y - head.y) > tol / 2 && Math.hypot(p.x - hover.x, p.y - hover.y) > tol / 2 && w.clear(net, width, [p, p]));
  }
  /** The way from the head to the cursor through the trail's turning points, each stretch straight where that is clear and round what is in the way where it is not. Null: the trail turns nowhere (the usual way serves). */
  private alongTrail(w: RouteWorld, head: Vec2, hover: Vec2, whole: boolean): { pts: Vec2[]; reached: boolean } | null {
    const way = this.waypoints(w, head, hover);
    if (!way.length) return null;
    const net = this.routeNet(), width = this.ed.trackWidth, pts: Vec2[] = [head];
    let at = head, reached = true;
    for (const [k, p] of [...way, hover].entries()) {
      const last = k === way.length, direct = [at, ...cornerPath(at, p, this.corner, this.flip).map(round)];
      if (w.clear(net, width, direct)) { pts.push(...direct.slice(1)); at = p; continue; }
      const f = this.walk(w, at, p, undefined, whole);
      // (a turning point that cannot be got to is passed over; the cursor's own place is got as near to as can be)
      if (!f || (!f.reached && !last)) { if (last) reached = false; continue; }
      pts.push(...f.pts.slice(1)); at = f.pts.at(-1)!;
      if (!f.reached) reached = false;
    }
    return pts.length > 1 ? { pts: simplify(pts), reached } : null;
  }

  /** Movable copper the route may push (free tracks of other nets). */
  private pushers(w: RouteWorld, segs: TrackFields[]): RItem[] {
    return segs.map((t) => w.virtual({ layer: t.layer, a: t.a, b: t.b, width: t.width, net: t.net ?? NO_NET }));
  }

  private updateLook(): void {
    if (!this.head || !this.hover) { this.look = EMPTY; this.syncGhost(); return; }
    const head = this.head, hover = this.hover, mode = this.conflict;
    const direct = [head, ...cornerPath(head, hover, this.corner, this.flip).map(round)];
    const full = this.trackFields(direct);
    if (mode === 'ignore') { this.look = { ...EMPTY, segs: full, violations: this.conflicts(full) }; this.syncGhost(); return; }
    const w = this.worldNow(), net = this.routeNet(), width = this.ed.trackWidth;
    const clearAll = (pts: Vec2[]) => w.clear(net, width, pts);
    const fixedOnly = (it: RItem) => it.movable;
    const stop = (): Look => {
      if (clearAll(direct)) return { ...EMPTY, segs: full };
      return { ...EMPTY, segs: this.trackFields(this.prefixClear(direct, clearAll)), blocked: true };
    };
    let look: Look;
    switch (mode) {
      case 'stop': look = stop(); break;
      case 'autorouteMulti': {
        if (clearAll(direct)) { look = { ...EMPTY, segs: full }; break; }
        const m = this.multi(head, hover);
        look = m ?? stop();
        break;
      }
      case 'walkaround': case 'autoroute': {
        // Follow Mouse Trail: the way the cursor went, where it turned aside from the straight way
        const t = settings.pcbFollowMouseTrail ? this.alongTrail(w, head, hover, mode === 'autoroute') : null;
        if (t) { look = { ...EMPTY, segs: this.trackFields(t.pts), blocked: !t.reached }; break; }
        if (clearAll(direct)) { look = { ...EMPTY, segs: full }; break; }
        const f = this.walk(w, head, hover, undefined, mode === 'autoroute');
        look = f ? { ...EMPTY, segs: this.trackFields(f.pts), blocked: !f.reached } : stop();
        break;
      }
      case 'push': case 'hug': {
        // The route's own way: straight on (Push stops at fixed objects), or round fixed objects (Hug)
        let pts = direct, blocked = false;
        if (!w.clear(net, width, direct, { skip: fixedOnly })) {
          if (mode === 'hug') {
            const f = this.walk(w, head, hover, fixedOnly);
            if (f) { pts = f.pts; blocked = !f.reached; }
            else { pts = this.prefixClear(direct, (p) => w.clear(net, width, p, { skip: fixedOnly })); blocked = true; }
          } else { pts = this.prefixClear(direct, (p) => w.clear(net, width, p, { skip: fixedOnly })); blocked = true; }
        }
        const segs = this.trackFields(pts);
        if (clearAll(pts)) { look = { ...EMPTY, segs, blocked }; break; }
        const r = shove(w, this.pushers(w, segs), { dirs: this.dirs() === 0 ? 8 : this.dirs(), vias: settings.pcbAllowViaPushing });
        if (r.ok) { look = { ...EMPTY, segs, blocked, shoved: r.shoved, pushedVias: r.vias }; break; }
        // Nothing would move: Hug walks round everything, Push stops where it can't push
        if (mode === 'hug') {
          const f = this.walk(w, head, hover);
          look = f ? { ...EMPTY, segs: this.trackFields(f.pts), blocked: !f.reached } : stop();
        } else look = stop();
        if (r.why) this.note = r.why;
        break;
      }
      default: look = stop();
    }
    this.look = look;
    this.syncGhost();
  }

  /** Board tracks moved by the route (or by its preview) are hidden; their new places are drawn by the tool. */
  private syncGhost(): void {
    const keys = new Set<string>();
    const prims = this.ed.doc.prims;
    for (const i of this.pending.removed) { const p = prims[i]; if (p) keys.add(primKey(p)); }
    for (const s of this.look.shoved) for (const it of s.line.items) if (it.prim >= 0) { const p = prims[it.prim]; if (p) keys.add(primKey(p)); }
    // Pushed vias and the tracks they drag: drawn by the tool at their new places
    const moved = [...this.pending.vias.keys(), ...this.pending.ends.keys(), ...(this.look.pushedVias ?? []).flatMap((v) => [v.prim, ...v.dragged.map((d) => d.prim)])];
    for (const i of moved) { const p = prims[i]; if (p) keys.add(primKey(p)); }
    const sig = [...keys].sort().join('|');
    if (sig === this.ghostKey) return;
    this.ghostKey = sig;
    this.ed.setGhost(keys.size ? { keys, comps: new Set(), points: new Set() } : null);
  }

  /** The pushes of a committed stretch become pending: the board tracks go, their new places come. */
  private takePushes(shoved: Shoved[], vias: PushedVia[] = []): void {
    if (!shoved.length && !vias.length) return;
    const p = clonePending(this.pending);
    // Pushed vias go to their new places, the tracks ending on them (any layer) with them
    for (const v of vias) {
      p.vias.set(v.prim, v.to);
      for (const d of v.dragged) p.ends.set(d.prim, { a: d.a, b: d.b });
    }
    const dropV = new Set<number>();
    for (const s of shoved) {
      for (const it of s.line.items) { if (it.prim >= 0) p.removed.add(it.prim); else if (it.vid !== undefined) dropV.add(it.vid); }
    }
    p.tracks = p.tracks.filter((_, i) => !dropV.has(i));
    for (const s of shoved) for (let i = 1; i < s.pts.length; i++) p.tracks.push({ layer: this.ed.currentLayer, a: s.pts[i - 1]!, b: s.pts[i]!, width: s.line.width, net: s.line.net });
    this.pending = p;
  }

  /* ── events ── */
  pointerMove(p: ToolPointer): void {
    this.note = '';
    this.trailTo(p.raw);
    this.hover = this.head ? this.snapTarget(p) : p.world;
    this.updateLook();
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.head) { this.begin(p); this.updateLook(); return; }
    if (p.ctrl) { this.complete(); return; }
    this.hover = this.snapTarget(p);
    const reachedTarget = this.hoverTarget;
    this.updateLook();
    // Look-ahead: the segment nearest the cursor stays on it, unless the route ends here
    const ends = reachedTarget && !this.look.blocked && settings.pcbAutoTerminate;
    const keepLast = this.lookAhead && this.look.segs.length > 1 && !ends;
    const add = keepLast ? this.look.segs.slice(0, -1) : this.look.segs;
    if (!add.length) { this.note = this.look.blocked ? 'blocked by an obstacle' : ''; return; }
    // AutoRoute On Multiple Layers: the committed stretch's vias come with it, routing goes on on its last layer
    if (this.look.vias?.length) {
      const layer0 = this.ed.currentLayer;
      const lastLayer = (keepLast ? this.look.segs.at(-1)! : add.at(-1)!).layer;
      // A via wherever the layer changes up to (and at the start of) the kept look-ahead segment
      const all = this.look.segs, used: Vec2[] = [];
      for (let i = 1; i < all.length && i <= add.length; i++) if (all[i]!.layer !== all[i - 1]!.layer) used.push(all[i]!.a);
      this.steps.push({ kind: 'segs', count: add.length, head: this.head, pending: clonePending(this.pending), layer: layer0, vias: used.length });
      this.segs.push(...add);
      for (const v of used) this.vias.push(this.viaFromRule(v));
      this.head = add.at(-1)!.b;
      if (lastLayer !== layer0) this.ed.setCurrentLayer(lastLayer);
      this.world = null;
      this.note = this.look.blocked ? 'stopped short' : '';
      if (ends) { this.finish(); return; }
      this.updateLook();
      return;
    }
    // What the committed stretch pushes (the look-ahead segment's pushes are worked out again later)
    let shoved = this.look.shoved, pushedVias = this.look.pushedVias ?? [];
    if ((shoved.length || pushedVias.length) && keepLast) {
      const w = this.worldNow();
      const r = shove(w, this.pushers(w, add), { dirs: this.dirs() === 0 ? 8 : this.dirs(), vias: settings.pcbAllowViaPushing });
      shoved = r.ok ? r.shoved : [];
      pushedVias = r.ok ? r.vias : [];
    }
    this.steps.push({ kind: 'segs', count: add.length, head: this.head, pending: clonePending(this.pending) });
    this.takePushes(shoved, pushedVias);
    this.segs.push(...add);
    this.head = add.at(-1)!.b;
    this.note = this.look.blocked ? 'stopped at an obstacle' : '';
    if (ends) { this.finish(); return; }
    this.updateLook();
  }

  /** Ctrl+click: the rest of the connection, round what is in the way, then finish. */
  private complete(): void {
    if (!this.head || this.net === NO_NET) return;
    const head = this.head;
    // The far end of the connection line from where the route is: the nearest pad of the net not yet joined
    const lines = connections(this.ed.doc).filter((c) => c.net === this.net);
    const start = this.start ?? head;
    const touching = lines.filter((c) => [c.a, c.b].some((e) => Math.hypot(e.x - start.x, e.y - start.y) < 2));
    const pick = (cs: typeof lines) => cs.map((c) => (Math.hypot(c.a.x - start.x, c.a.y - start.y) < 2 ? c.b : c.a))
      .sort((a, b) => Math.hypot(a.x - head.x, a.y - head.y) - Math.hypot(b.x - head.x, b.y - head.y))[0];
    const target = pick(touching) ?? pick(lines.map((c) => ({ ...c, a: c.a, b: c.b })));
    if (!target) { this.note = 'nothing left to connect'; return; }
    const w = this.worldNow();
    const f = this.walk(w, head, target, undefined, true);
    if (!f || !f.reached) { this.note = 'no way through to the target'; return; }
    const add = this.trackFields(f.pts);
    this.steps.push({ kind: 'segs', count: add.length, head, pending: clonePending(this.pending) });
    this.segs.push(...add);
    this.head = target;
    this.finish();
  }

  cancel(): boolean {
    if (this.head) { this.finish(); return true; }
    return false;
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Space': this.flip = !this.flip; this.updateLook(); return true;
      case 'Shift+Space': {
        // AD's five (45°, 45° with arc, 90°, 90° with arc, any angle); Restrict To 90/45 leaves any angle out
        const modes = settings.pcbRestrict9045 ? PCB_CORNER_MODES.filter((m) => m !== 'any') : PCB_CORNER_MODES;
        this.corner = modes[(modes.indexOf(this.corner) + 1) % modes.length]!;
        this.updateLook();
        return true;
      }
      case ',': case '.': case '<': case '>':
        // The arc corner modes: the arcs smaller or larger
        if (!isArcMode(this.corner) || !arcKey(combo, this.ed.trackWidth)) return false;
        this.updateLook();
        return true;
      case 'Shift+R': {
        const on = ROUTE_MODES.filter(([, , k]) => settings[k]).map(([m]) => m);
        const list = on.length ? on : ['walkaround' as Mode];
        updateSettings({ pcbRoutingMode: list[(list.indexOf(this.conflict) + 1) % list.length]! });
        this.note = modeLabel(settings.pcbRoutingMode);
        this.updateLook();
        return true;
      }
      case 'Ctrl+Shift+G': updateSettings({ pcbGlossRouted: GLOSS[(GLOSS.indexOf(settings.pcbGlossRouted) + 1) % GLOSS.length]! }); this.note = `gloss ${settings.pcbGlossRouted}`; this.updateLook(); return true;
      case 'Ctrl+W': updateSettings({ pcbClearanceBoundaries: !settings.pcbClearanceBoundaries }); return true;
      case '3': {
        const order: WidthMode[] = ['min', 'pref', 'max'];
        this.widthMode = order[(order.indexOf(this.widthMode) + 1) % order.length]!;
        this.widthFromRule();
        this.world = null;
        this.updateLook();
        return true;
      }
      case '4': {
        const order: ViaMode[] = ['min', 'pref', 'max', 'user'];
        this.viaMode = order[(order.indexOf(this.viaMode) + 1) % order.length]!;
        return true;
      }
      case '1': this.lookAhead = !this.lookAhead; return true;
      case '2': if (!this.head) return false; this.addVia(false); this.updateLook(); return true;
      case 'L': {
        // From a through-hole pad or via, before the first segment: the next signal layer, no via
        if (!this.head) return false;
        const start = this.startKey ? this.ed.primByKey(this.startKey) : undefined;
        if (this.segs.length || !start || !(start.kind === 'via' || (start.kind === 'pad' && start.layer === L.MULTI))) return true;
        this.ed.nextSignalLayer(); this.widthFromRule(); this.updateLook();
        return true;
      }
      case 'Backspace': this.back(); this.updateLook(); return true;
      case 'Escape': return this.cancel();
      case '*': case '+': this.viaAndNextLayer(); this.updateLook(); return true;
      case '-': case 'Shift+*': this.viaAndNextLayer(-1); this.updateLook(); return true;
    }
    return false;
  }

  private back(): void {
    const s = this.steps.pop();
    if (!s) { this.reset(); return; }
    if (s.kind === 'segs') {
      this.segs.splice(this.segs.length - s.count, s.count);
      if (s.vias) this.vias.splice(this.vias.length - s.vias, s.vias);
      if (s.layer !== undefined && s.layer !== this.ed.currentLayer) this.ed.setCurrentLayer(s.layer);
    } else { this.vias.pop(); this.ed.setCurrentLayer(s.layer); }
    this.head = s.head;
    this.pending = s.pending;
    this.world = null;
  }

  private viaAndNextLayer(dir: 1 | -1 = 1): void {
    if (!this.head) { if (dir > 0) this.ed.nextSignalLayer(); else this.ed.prevSignalLayer(); return; }
    if (this.addVia(true, dir)) this.widthFromRule();
  }

  /** A via at the head of the route; with a layer change, routing continues on the next (or previous) signal layer. */
  private addVia(change: boolean, dir: 1 | -1 = 1): boolean {
    if (!this.head) return false;
    const via = this.viaFromRule(this.head);
    if (this.conflict !== 'ignore' && checkCopper(this.ed.doc, [asVia(via)], { ignorePours: true, clearanceOnly: true }).length) {
      this.note = 'no room for a via here';
      return false;
    }
    this.steps.push({ kind: 'via', head: this.head, layer: this.ed.currentLayer, pending: clonePending(this.pending) });
    this.vias.push(via);
    if (change) { if (dir > 0) this.ed.nextSignalLayer(); else this.ed.prevSignalLayer(); }
    this.note = '';
    this.world = null;
    return true;
  }

  private reset(): void {
    this.head = null; this.segs = []; this.vias = []; this.steps = []; this.startKey = null; this.note = ''; this.start = null; this.targets = [];
    this.pending = noPending(); this.world = null;
    this.look = EMPTY;
    this.syncGhost();
  }

  /** Strong gloss: the whole route pulled tight once more, layer by layer between vias. */
  private glossAll(segs: TrackFields[]): TrackFields[] {
    if (settings.pcbGlossRouted !== 'strong' || this.dirs() === 0 || !segs.length) return segs;
    const out: TrackFields[] = [];
    let run: TrackFields[] = [];
    const flush = () => {
      if (!run.length) return;
      const layer = run[0]!.layer, width = run[0]!.width, net = run[0]!.net ?? NO_NET;
      const pts = [run[0]!.a, ...run.map((t) => t.b)];
      const w = new RouteWorld(this.ed.doc, layer, this.pending, { vias: this.vias.map((v) => ({ at: v.at, diameter: v.diameter, hole: v.hole, net: v.net ?? NO_NET })) });
      let g = pull(w, net, width, pts, this.dirs());
      g = tighten(w, net, width, g);
      g = simplify(g);
      const ok = w.clear(net, width, g) && g[0]!.x === pts[0]!.x && g[0]!.y === pts[0]!.y;
      const use = ok ? g : pts;
      for (let i = 1; i < use.length; i++) out.push({ ...run[0]!, a: use[i - 1]!, b: use[i]! });
      run = [];
    };
    for (const t of segs) {
      const last = run.at(-1);
      if (last && (last.layer !== t.layer || last.width !== t.width || last.b.x !== t.a.x || last.b.y !== t.a.y)) flush();
      run.push(t);
    }
    flush();
    return out;
  }

  private finish(): void {
    const ed = this.ed;
    const segs = this.glossAll(this.segs), vias = this.vias, pending = this.pending, start = this.start, end = this.head, net = this.net;
    this.reset();
    if (ed.currentLayer > 82) return; // extended mech layers need V7 encoding
    if (!segs.length && !vias.length) return;
    const pushedAway = [...pending.removed].map((i) => ed.doc.prims[i]!).filter(Boolean);
    // Pushed vias and the tracks they dragged: their records moved in place (sizes, layers and masks kept)
    const movedRecs = [
      ...[...pending.vias].map(([i, at]) => ({ p: ed.doc.prims[i], fn: (s: Uint8Array) => { put(s, VIA.x, Math.round(at.x)); put(s, VIA.y, Math.round(at.y)); } })),
      ...[...pending.ends].map(([i, e]) => ({ p: ed.doc.prims[i], fn: (s: Uint8Array) => { put(s, TRACK.x1, Math.round(e.a.x)); put(s, TRACK.y1, Math.round(e.a.y)); put(s, TRACK.x2, Math.round(e.b.x)); put(s, TRACK.y2, Math.round(e.b.y)); } })),
    ].filter((m) => m.p && !pending.removed.has(ed.doc.prims.indexOf(m.p))).map(({ p, fn }) => {
      const rec = ed.doc.streams.get(p!.src.storage)!.records[p!.src.index]!;
      const subs = rec.subs.map((x) => x.slice());
      fn(subs[0]!);
      const after: PcbRawRecord = { tag: rec.tag, subs };
      carryPrimInfo(rec, after);
      return { storage: p!.src.storage, index: p!.src.index, after };
    });
    // Hugging Style: the corners as Preferences asks (arcs round what the route hugs)
    // (an arc corner mode: each corner an arc of the radius asked for, smaller where that isn't clear)
    const arcMode = isArcMode(this.corner) ? { radius: arcRadius(ed.trackWidth) } : undefined;
    // Routing Style, Free-Flowing (26.194): the route as laid is pulled tight at any angle and its bends made arcs instead
    const worldOf = (l: LayerId) => new RouteWorld(ed.doc, l, pending, { vias: vias.map((v) => ({ at: v.at, diameter: v.diameter, hole: v.hole, net: v.net ?? NO_NET })) });
    const styled = !arcMode && settings.pcbRouteStyle === 'flowing' && featureOn('aiLayout') ? flowSegments(segs, worldOf) : styleCorners(segs, arcMode ? 'arcs' : settings.pcbHugStyle, worldOf, arcMode);
    ed.undo.transact('Interactive Routing', (tx) => {
      if (movedRecs.length) tx.add(replaceRecords(ed.doc, movedRecs));
      if (pushedAway.length) tx.add(removePrims(ed.doc, pushedAway));
      const moved: TrackFields[] = pending.tracks.map((t) => ({ layer: t.layer, a: t.a, b: t.b, width: t.width, net: t.net === NO_NET ? undefined : t.net }));
      if (segs.length || moved.length) tx.add(addTracks(ed.doc, [...moved, ...styled.tracks]));
      if (styled.arcs.length) tx.add(addPrimRecords(ed.doc, styled.arcs.map((a) => ({ storage: 'Arcs6', rec: encodeArc(a, ed.doc.streams.get('Arcs6')?.records[0]) }))));
      if (vias.length) tx.add(addVias(ed.doc, vias));
      // Automatically Remove Loops: the old way between the route's ends goes
      if (settings.pcbRemoveLoops && start && end && segs.length) {
        const loop = loopToRemove(ed.doc, net, segs, start, end);
        if (loop) {
          tx.add(removePrims(ed.doc, loop.remove));
          if (loop.add.length) tx.add(addTracks(ed.doc, loop.add));
          // Remove Net Antennas: what the old way's removal left dead-ended goes too
          if (settings.pcbRemoveNetAntennas) {
            const stubs = antennasLeft(ed.doc, net, loop.remove, [...styled.tracks, ...loop.add]);
            if (stubs.length) tx.add(removePrims(ed.doc, stubs));
          }
        }
      }
    });
  }

  overlay(): ToolOverlay | null {
    if (!this.head) return null;
    const segments: NonNullable<ToolOverlay['segments']> = [];
    const circles: NonNullable<ToolOverlay['circles']> = [];
    const polys: NonNullable<ToolOverlay['polys']> = [];
    // Clearance boundaries round the cursor (or the whole route's reach)
    if (settings.pcbClearanceBoundaries && this.conflict !== 'ignore' && this.hover) {
      const w = this.worldNow(), r = settings.pcbReduceClearanceArea ? 2_500_000 : 10_000_000;
      const c = this.hover;
      for (const b of clearanceBoundaries(w, this.routeNet(), this.ed.trackWidth, { minX: c.x - r, minY: c.y - r, maxX: c.x + r, maxY: c.y + r })) polys.push({ ...b, color: 0x808080, alpha: 0.28 });
    }
    // Pushed copper: what the route has moved, and what the look-ahead moves
    const movedNow = new Set<number>();
    for (const s of this.look.shoved) for (const it of s.line.items) if (it.vid !== undefined) movedNow.add(it.vid);
    this.pending.tracks.forEach((t, i) => { if (!movedNow.has(i)) segments.push({ a: t.a, b: t.b, width: t.width, color: layerColour(t.layer) }); });
    for (const s of this.look.shoved) for (let i = 1; i < s.pts.length; i++) segments.push({ a: s.pts[i - 1]!, b: s.pts[i]!, width: s.line.width, color: layerColour(this.ed.currentLayer) });
    // Pushed vias and what they drag: the look-ahead's places over the session's
    const lookVias = new Map((this.look.pushedVias ?? []).map((v) => [v.prim, v]));
    const lookEnds = new Map((this.look.pushedVias ?? []).flatMap((v) => v.dragged.map((d) => [d.prim, d] as const)));
    const prims = this.ed.doc.prims;
    for (const [i, e] of new Map([...this.pending.ends, ...lookEnds])) { const t = prims[i]; if (t?.kind === 'track') segments.push({ a: e.a, b: e.b, width: t.width, color: layerColour(t.layer) }); }
    for (const [i, at] of new Map([...this.pending.vias, ...[...lookVias].map(([k, v]) => [k, v.to] as const)])) {
      const v = prims[i];
      if (v?.kind === 'via') circles.push({ c: at, r: v.diameter / 2, color: hexToRgb(settings.pcbViaColour) }, { c: at, r: v.hole / 2, color: hexToRgb(settings.pcbHoleColour) });
    }
    if (isArcMode(this.corner)) {
      // The arc corner modes: the route drawn with its arcs, as it will be placed
      const styled = styleCorners([...this.segs, ...this.look.segs], 'arcs', (l) => (l === this.ed.currentLayer ? this.worldNow() : null), { radius: arcRadius(this.ed.trackWidth) });
      const colour = (l: number) => (this.look.violations.length ? DRC_GREEN : layerColour(l));
      for (const t of styled.tracks) segments.push({ a: t.a, b: t.b, width: t.width, color: colour(t.layer) });
      for (const a of styled.arcs) segments.push(...arcSegments(a.c, a.r, a.start, a.end).map(([p, q]) => ({ a: p, b: q, width: a.width, color: colour(a.layer) })));
    } else {
      for (const s of this.segs) segments.push({ a: s.a, b: s.b, width: s.width, color: layerColour(s.layer) });
      this.look.segs.forEach((s, i) => segments.push({ a: s.a, b: s.b, width: s.width, color: this.look.violations.length ? DRC_GREEN : layerColour(s.layer),
        hollow: this.lookAhead && i === this.look.segs.length - 1 && this.look.segs.length > 1 }));
    }
    const viaC = hexToRgb(settings.pcbViaColour);
    for (const v of this.vias) circles.push({ c: v.at, r: v.diameter / 2, color: viaC }, { c: v.at, r: v.hole / 2, color: hexToRgb(settings.pcbHoleColour) });
    for (const at of this.look.vias ?? []) { const v = this.viaFromRule(at); circles.push({ c: at, r: v.diameter / 2, color: viaC }, { c: at, r: v.hole / 2, color: hexToRgb(settings.pcbHoleColour) }); }
    for (const v of this.look.violations) circles.push({ c: v.at, r: Math.max(this.ed.trackWidth / 2, 40_000), color: DRC_GREEN });
    // The connection still to make: from the end of the route to the nearest pad it has to reach
    const end = this.look.segs.at(-1)?.b ?? this.head;
    const to = this.targets.reduce<Vec2 | null>((b, t) => (!b || Math.hypot(t.x - end.x, t.y - end.y) < Math.hypot(b.x - end.x, b.y - end.y) ? t : b), null);
    if (to && (to.x !== end.x || to.y !== end.y)) segments.push({ a: end, b: to, width: 0, color: hexToRgb(settings.pcbConnectionColour) });
    if (!segments.length && !circles.length) circles.push({ c: this.head, r: this.ed.trackWidth / 2, color: layerColour(this.ed.currentLayer) });
    return { segments, circles, polys };
  }

  deactivate(): void { if (this.head) this.finish(); }
  /** Undo, redo or an edit from elsewhere: the route in progress (and what it was routed against) goes. */
  abort(): void { this.reset(); this.worlds.clear(); }
}
