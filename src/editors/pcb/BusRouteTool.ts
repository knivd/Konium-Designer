import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { formatCoord } from '../../core/units';
import { addTracks, addVias, type ViaFields } from '../../model/pcbEdit';
import type { TrackFields } from '../../formats/altium/pcbdoc';
import { L, isSignal, layerColour, type LayerId } from '../../model/layers';
import { NO_NET, netName, type PcbPad, type PcbPrim, type PcbTrack, type PcbVia } from '../../model/pcb';
import { checkCopper, clearanceGap, ruleFor, type DrcViolation } from '../../model/drc';
import { ruleLength } from '../../formats/altium/rules';
import { hexToRgb, settings, updateSettings } from '../../core/settings';
import { CORNER_MODES, baseMode, cornerLabel, cornerPath, type CornerMode } from '../corner';
import { RouteWorld, pull, walkaround, type Dirs, type RItem } from '../../model/router';
import { pairOfNet, pairRule } from '../../model/diffPairs';
import { laneOffsets, laneOrder, lanePath } from '../../model/busRoute';
import { DRC_GREEN, ROUTE_MODES } from './RouteTool';
import type { PcbEditor } from './PcbEditor';

type Mode = typeof settings.pcbRoutingMode;
const modeLabel = (m: Mode) => ROUTE_MODES.find(([k]) => k === m)?.[1] ?? m;
const round = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const d2 = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

const probe = (net: number, layer: LayerId, width: number, a: Vec2 = { x: 0, y: 0 }, b: Vec2 = a): PcbTrack => ({
  kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer, a, b, width, net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false,
});

/** A net the route carries: its width and where its track starts (a pad, a via, a track end). */
export interface BusLane { net: number; width: number; start: Vec2; startKey?: string }
/** A stretch on one layer: the centre line and where each lane joins it (pads, or the vias it came through). */
interface Run { layer: LayerId; centre: Vec2[]; starts: Vec2[]; order: number[] | null }
interface Snapshot { runs: Run[]; vias: ViaFields[]; layer: LayerId }

/**
 * Route › Interactive Differential Pair Routing and Route › Interactive Multi-Routing: several
 * nets routed as one. A differential pair starts from a pad (or via or track end) of either net
 * of a pair (Design › Classes, PCB panel › Differential Pairs Editor); its partner starts from
 * the nearest copper of the other net. The width and gap come from the Differential Pairs Routing
 * rule. Multi-Routing takes the pads (or track ends) selected first, each net at its Width rule
 * and the gap the Clearance rule asks between them.
 *
 * The centre line goes where the cursor goes, walked round obstacles as one wide track (the
 * conflict mode decides, Shift+R; Push and Hug walk round [est]); each net's track keeps its
 * offset, joining from its start and leaving for its end at 45°. Click commits, a click on a pad
 * of one of the nets ends the route there; * (pair only) places a pair of vias and changes
 * layer; Backspace takes back the last click, Space / Shift+Space corner direction / style,
 * Tab the routing properties, right-click or Esc finishes, a second time leaves the tool.
 */
export class BusRouteTool implements Tool {
  readonly id: string;
  private lanes: BusLane[] = [];
  private runs: Run[] = [];
  private vias: ViaFields[] = [];
  private steps: Snapshot[] = [];
  private hover: Vec2 | null = null;
  private look: Vec2[] = [];
  private blocked = false;
  private violations: DrcViolation[] = [];
  private corner: CornerMode = settings.pcbTrackCorner === 'any' ? '45' : baseMode(settings.pcbTrackCorner);
  private flip = false;
  private note = '';
  private endAt: Map<number, Vec2> | null = null;
  private startSkip = new Set<number>();
  private world: { key: string; w: RouteWorld } | null = null;
  /** User values from the Tab dialog (else the rules'). */
  userWidth: number | null = null;
  userGap: number | null = null;

  constructor(private ed: PcbEditor, readonly kind: 'pair' | 'multi') {
    this.id = kind === 'pair' ? 'route-diffpair' : 'route-multi';
  }

  get active(): boolean { return this.runs.length > 0; }
  get conflict(): Mode { return settings.pcbRoutingMode; }
  get nets(): number[] { return this.lanes.map((l) => l.net); }
  private get run(): Run { return this.runs.at(-1)!; }

  hint(): string {
    const ed = this.ed, l = ed.layerLabel(ed.currentLayer);
    const what = this.kind === 'pair' ? 'Interactive Differential Pair Routing' : 'Interactive Multi-Routing';
    if (!this.active) {
      return this.kind === 'pair' ? `${what} (${modeLabel(this.conflict)}): click a pad, via or track of a differential pair net on ${l}`
        : `${what} (${modeLabel(this.conflict)}): select the pads or track ends to route, then click one of them on ${l}`;
    }
    const u = ed.units(), names = this.lanes.map((x) => netName(ed.doc, x.net)).join(', ');
    return `${names} on ${l}, ${formatCoord(this.lanes[0]!.width, u)} wide, gap ${formatCoord(this.gap(), u)}, ${modeLabel(this.conflict)}, ${cornerLabel(this.corner, this.flip)}`
      + `${this.note ? ` — ${this.note}` : ''}. ${this.kind === 'pair' ? '* vias, ' : ''}Tab properties, Backspace undo, right-click finish`;
  }

  /* ── widths and gaps ── */
  private pairRuleNow() {
    const p = this.lanes[0] ? pairOfNet(this.ed.doc, this.lanes[0].net) : null;
    return pairRule(this.ed.doc, this.ed.currentLayer, p?.pair);
  }
  /** The gap between neighbouring lanes. */
  gap(): number {
    if (this.userGap !== null) return this.userGap;
    if (this.kind === 'pair') return this.pairRuleNow().gap;
    let g = 0;
    for (let i = 1; i < this.lanes.length; i++) g = Math.max(g, clearanceGap(this.ed.doc, probe(this.lanes[i - 1]!.net, this.ed.currentLayer, 0), probe(this.lanes[i]!.net, this.ed.currentLayer, 0)));
    return g || 100_000;
  }
  /** Each lane's width on the current layer. */
  private refreshWidths(): void {
    const ed = this.ed;
    for (const lane of this.lanes) {
      if (this.userWidth !== null) { lane.width = this.userWidth; continue; }
      if (this.kind === 'pair') { lane.width = this.pairRuleNow().width; continue; }
      const r = ruleFor(ed.doc, 'Width', probe(lane.net, ed.currentLayer, 0, lane.start));
      lane.width = r ? ruleLength(r, 'PREFEREDWIDTH', '10mil') : ed.trackWidth;
    }
  }
  private totalWidth(): number { return this.lanes.reduce((s, l) => s + l.width, 0) + this.gap() * (this.lanes.length - 1); }
  /** Each lane's offset, in lane order. */
  private offsets(order: number[]): number[] {
    const sorted = laneOffsets(order.map((i) => this.lanes[i]!.width), this.gap());
    const out = new Array<number>(this.lanes.length).fill(0);
    order.forEach((lane, k) => { out[lane] = sorted[k]!; });
    return out;
  }
  private dirs(): Dirs { return this.corner === '90' ? 4 : this.corner === 'any' ? 0 : 8; }

  /* ── starting ── */
  /** Copper of a net near a point: pads and vias by their centre, tracks by their nearest end. */
  private copperOf(net: number, near: Vec2, within: number): { at: Vec2; key: string } | null {
    let best: { at: Vec2; key: string; d: number } | null = null;
    const doc = this.ed.doc;
    doc.prims.forEach((p) => {
      if (!('net' in p) || p.net !== net) return;
      const cands: Vec2[] = p.kind === 'pad' || p.kind === 'via' ? [p.at] : p.kind === 'track' && (p.layer === this.ed.currentLayer) ? [p.a, p.b] : [];
      for (const c of cands) {
        const d = d2(c, near);
        if (d <= within && (!best || d < best.d)) best = { at: c, key: `${p.src.storage}:${p.src.index}`, d };
      }
    });
    return best;
  }
  private pickAt(raw: Vec2): { prim: PcbPrim; at: Vec2 } | null {
    for (const h of this.ed.hits(raw)) {
      if (h.layer === undefined || !(isSignal(h.layer) || h.layer === L.MULTI)) continue;
      const q = this.ed.primByKey(h.key);
      if (!q || !(q.kind === 'pad' || q.kind === 'via' || q.kind === 'track')) continue;
      if (q.kind === 'track') return { prim: q, at: d2(q.a, raw) < d2(q.b, raw) ? q.a : q.b };
      return { prim: q, at: q.at };
    }
    return null;
  }
  private begin(p: ToolPointer): boolean {
    const ed = this.ed, hit = this.pickAt(p.raw);
    if (this.kind === 'pair') {
      if (!hit || !('net' in hit.prim) || hit.prim.net === NO_NET) { this.note = 'click copper of a differential pair'; return false; }
      const pr = pairOfNet(ed.doc, hit.prim.net);
      if (!pr) { this.note = `${netName(ed.doc, hit.prim.net)} is not in a differential pair`; return false; }
      const other = this.copperOf(pr.partner, hit.at, 10_000_000);
      if (!other) { this.note = `no copper of ${netName(ed.doc, pr.partner)} nearby`; return false; }
      const mine: BusLane = { net: hit.prim.net, width: 0, start: hit.at }, theirs: BusLane = { net: pr.partner, width: 0, start: other.at };
      this.lanes = pr.positive ? [mine, theirs] : [theirs, mine];
    } else {
      const starts = this.selectedStarts();
      if (starts.length < 2) { this.note = 'select two or more pads or track ends first'; return false; }
      if (hit && !starts.some((s) => d2(s.start, hit.at) < 2)) { this.note = 'click one of the selected pads'; return false; }
      this.lanes = starts;
    }
    if (hit && 'layer' in hit.prim && isSignal(hit.prim.layer) && hit.prim.layer !== ed.currentLayer) ed.setCurrentLayer(hit.prim.layer);
    this.refreshWidths();
    const c0 = round({ x: this.lanes.reduce((s, l) => s + l.start.x, 0) / this.lanes.length, y: this.lanes.reduce((s, l) => s + l.start.y, 0) / this.lanes.length });
    this.runs = [{ layer: ed.currentLayer, centre: [c0], starts: this.lanes.map((l) => l.start), order: null }];
    this.vias = []; this.steps = []; this.world = null;
    // What the route starts among (neighbouring pins, its own pads' clearance) is not in its way while it leaves
    const w = this.worldNow(), r = this.totalWidth() / 2 + w.maxGap;
    this.startSkip = new Set(w.near(this.lanes[0]!.net, { minX: c0.x - r, minY: c0.y - r, maxX: c0.x + r, maxY: c0.y + r }).filter((it) => it.kind !== 'edge').map((it) => it.id));
    return true;
  }
  /** Multi-Routing: the selected pads and free track ends, one per net. */
  private selectedStarts(): BusLane[] {
    const ed = this.ed, out: BusLane[] = [];
    for (const k of ed.selection) {
      const p = ed.primByKey(k);
      if (!p || !('net' in p) || p.net === NO_NET || out.some((l) => l.net === p.net)) continue;
      if (p.kind === 'pad' || p.kind === 'via') out.push({ net: p.net, width: 0, start: p.at, startKey: k });
      else if (p.kind === 'track') out.push({ net: p.net, width: 0, start: p.b, startKey: k });
    }
    return out;
  }

  /* ── the obstacles ── */
  private worldNow(): RouteWorld {
    const ed = this.ed, key = `${ed.currentLayer}|${this.steps.length}`;
    if (this.world && this.world.key === key && this.world.w.doc === ed.doc) return this.world.w;
    const w = new RouteWorld(ed.doc, ed.currentLayer);
    this.world = { key, w };
    return w;
  }
  private skip = (it: RItem) => this.nets.includes(it.net) || (this.runs.length === 1 && this.startSkip.has(it.id));

  /* ── geometry ── */
  /** A run's tracks, one list per lane; with `look` the look-ahead centre points are added. */
  private runTracks(run: Run, look: Vec2[] = [], ends?: Map<number, Vec2>): TrackFields[][] {
    const centre = [...run.centre, ...look];
    const order = run.order ?? (centre.length >= 2 ? laneOrder(run.starts, centre[0]!, { x: centre[1]!.x - centre[0]!.x, y: centre[1]!.y - centre[0]!.y }) : this.lanes.map((_, i) => i));
    const offs = this.offsets(order);
    return this.lanes.map((lane, i) => {
      const pts = lanePath(run.starts[i]!, centre, offs[i]!, ends?.get(i));
      const out: TrackFields[] = [];
      for (let k = 1; k < pts.length; k++) if (pts[k - 1]!.x !== pts[k]!.x || pts[k - 1]!.y !== pts[k]!.y) out.push({ layer: run.layer, a: pts[k - 1]!, b: pts[k]!, width: lane.width, net: lane.net });
      return out;
    });
  }
  /** Where run `i`'s lanes end: the vias that take them on. */
  private viaEndsOf(i: number): Map<number, Vec2> {
    const next = this.runs[i + 1];
    return new Map(next ? next.starts.map((s, k) => [k, s] as const) : []);
  }

  private head(): Vec2 { return this.run.centre.at(-1)!; }

  private updateLook(): void {
    this.violations = []; this.blocked = false; this.endAt = null;
    if (!this.active || !this.hover) { this.look = []; return; }
    const head = this.head(), hover = this.hover;
    let pts = cornerPath(head, hover, this.corner, this.flip).map(round);
    if (this.conflict !== 'ignore') {
      const w = this.worldNow(), net = this.lanes[0]!.net, width = this.totalWidth();
      const all = [head, ...pts];
      if (!w.clear(net, width, all, { skip: this.skip })) {
        const f = this.conflict === 'stop' ? null : walkaround(w, net, width, head, hover, { dirs: this.dirs(), skip: this.skip });
        if (f) { pts = (settings.pcbGlossRouted === 'off' ? pull(w, net, width, f.pts, this.dirs(), { skip: this.skip }) : f.pts).slice(1).map(round); this.blocked = !f.reached; }
        else {
          // As far as it goes clear
          const keep: Vec2[] = [];
          for (const q of pts) { if (w.clear(net, width, [keep.at(-1) ?? head, q], { skip: this.skip })) keep.push(q); else break; }
          pts = keep; this.blocked = true;
        }
      }
    }
    this.look = pts;
    this.endAt = this.targetEnds(hover);
    const tracks = this.runTracks(this.run, this.look, this.endAt ?? undefined).flat().map((t) => probe(t.net ?? NO_NET, t.layer, t.width, t.a, t.b));
    this.violations = tracks.length ? checkCopper(this.ed.doc, tracks, { ignorePours: true, clearanceOnly: true }) : [];
  }
  /** With the cursor on a pad of one of the nets: each lane's end, its nearest pad of its net there. */
  private targetEnds(hover: Vec2): Map<number, Vec2> | null {
    const doc = this.ed.doc;
    const isStart = (p: Vec2) => this.runs[0]!.starts.some((s) => d2(s, p) < 2);
    const onPad = doc.prims.find((p): p is PcbPad | PcbVia => (p.kind === 'pad' || p.kind === 'via') && this.nets.includes(p.net) && d2(p.at, hover) < Math.max(p.kind === 'via' ? p.diameter : Math.max(p.top.w, p.top.h), 1) / 2 && !isStart(p.at));
    if (!onPad) return null;
    const out = new Map<number, Vec2>();
    const reach = this.totalWidth() * 6 + 2_000_000;
    this.lanes.forEach((lane, i) => {
      let best: Vec2 | null = null;
      for (const p of doc.prims) {
        if ((p.kind !== 'pad' && p.kind !== 'via') || p.net !== lane.net || isStart(p.at)) continue;
        if (d2(p.at, onPad.at) <= reach && (!best || d2(p.at, onPad.at) < d2(best, onPad.at))) best = p.at;
      }
      if (best) out.set(i, best);
    });
    return out.size ? out : null;
  }

  /* ── events ── */
  pointerMove(p: ToolPointer): void {
    this.note = this.note && !this.active ? this.note : '';
    this.hover = this.snap(p);
    this.updateLook();
  }
  /** The cursor snaps to pads of the route's nets. */
  private snap(p: ToolPointer): Vec2 {
    if (!this.active) return p.world;
    for (const h of this.ed.hits(p.raw)) {
      const q = this.ed.primByKey(h.key);
      if (q && (q.kind === 'pad' || q.kind === 'via') && this.nets.includes(q.net)) return q.at;
    }
    return p.world;
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.active) { if (this.begin(p)) { this.hover = this.head(); this.updateLook(); } return; }
    this.hover = this.snap(p);
    this.updateLook();
    if (!this.look.length) { this.note = this.blocked ? 'blocked by an obstacle' : ''; return; }
    const ends = this.endAt;
    this.steps.push(this.snapshot());
    const run = this.run;
    if (!run.order) run.order = laneOrder(run.starts, run.centre[0]!, { x: this.look[0]!.x - run.centre[0]!.x, y: this.look[0]!.y - run.centre[0]!.y });
    run.centre.push(...this.look);
    this.world = null;
    if (ends && !this.blocked) { this.endAt = ends; this.finish(); return; }
    this.updateLook();
  }

  private snapshot(): Snapshot {
    return { runs: this.runs.map((r) => ({ ...r, centre: [...r.centre], starts: [...r.starts], order: r.order ? [...r.order] : null })), vias: [...this.vias], layer: this.ed.currentLayer };
  }

  cancel(): boolean {
    if (this.active) { this.finish(); return true; }
    return false;
  }

  key(combo: string): boolean {
    switch (combo) {
      case 'Space': this.flip = !this.flip; this.updateLook(); return true;
      case 'Shift+Space': {
        const modes: CornerMode[] = CORNER_MODES.filter((m) => m !== 'any');
        this.corner = modes[(modes.indexOf(this.corner) + 1) % modes.length]!;
        this.updateLook();
        return true;
      }
      case 'Shift+R': {
        const on = ROUTE_MODES.filter(([m, , k]) => settings[k] && ['ignore', 'walkaround', 'stop', 'push', 'hug'].includes(m)).map(([m]) => m);
        const list = on.length ? on : ['walkaround' as Mode];
        updateSettings({ pcbRoutingMode: list[(list.indexOf(this.conflict) + 1) % list.length]! });
        this.note = modeLabel(settings.pcbRoutingMode);
        this.world = null;
        this.updateLook();
        return true;
      }
      case 'Backspace': this.back(); this.updateLook(); return true;
      case 'Escape': return this.cancel();
      case '*': case '+': case '-': case 'Shift+*': {
        if (this.kind !== 'pair' || !this.active) { if (!this.active) { if (combo === '-' || combo === 'Shift+*') this.ed.prevSignalLayer(); else this.ed.nextSignalLayer(); } return true; }
        this.viaPair(combo === '-' || combo === 'Shift+*' ? -1 : 1);
        this.updateLook();
        return true;
      }
    }
    return false;
  }

  private back(): void {
    const s = this.steps.pop();
    if (!s) { this.reset(); return; }
    this.runs = s.runs; this.vias = s.vias;
    if (s.layer !== this.ed.currentLayer) this.ed.setCurrentLayer(s.layer);
    this.refreshWidths();
    this.world = null;
  }

  /** The via each lane takes to the next layer, side by side across the route's end. */
  private viaPair(dir: 1 | -1): void {
    const run = this.run;
    if (run.centre.length < 2) { this.note = 'route a stretch before the vias'; return; }
    const ed = this.ed, head = this.head(), prev = run.centre.at(-2)!;
    const d = { x: (head.x - prev.x) / d2(head, prev), y: (head.y - prev.y) / d2(head, prev) }, n = { x: -d.y, y: d.x };
    const r = ruleFor(ed.doc, 'RoutingVias', { kind: 'via', src: { storage: 'Vias6', index: -1 }, at: head, diameter: 0, hole: 0, layerStart: L.TOP, layerEnd: L.BOTTOM, net: this.lanes[0]!.net, locked: false });
    const t = ed.viaTemplate;
    const dia = t.fromRule && r ? ruleLength(r, 'WIDTH', '50mil') : t.diameter, hole = t.fromRule && r ? ruleLength(r, 'HOLEWIDTH', '28mil') : t.hole;
    const order = run.order ?? this.lanes.map((_, i) => i);
    const offs = this.offsets(order);
    const pitch = this.lanes[0]!.width + this.gap();
    const scale = Math.max(1, (dia + this.gap()) / pitch);
    const stack = ed.doc.board.copperStack.filter(isSignal);
    const vias: ViaFields[] = this.lanes.map((lane, i) => ({ at: round({ x: head.x + n.x * offs[i]! * scale, y: head.y + n.y * offs[i]! * scale }), diameter: dia, hole, net: lane.net, layerStart: stack[0] ?? L.TOP, layerEnd: stack.at(-1) ?? L.BOTTOM }));
    if (this.conflict !== 'ignore') {
      const asVia = (v: ViaFields): PcbVia => ({ kind: 'via', src: { storage: 'Vias6', index: -1 }, at: v.at, diameter: v.diameter, hole: v.hole, layerStart: v.layerStart!, layerEnd: v.layerEnd!, net: v.net!, locked: false });
      if (checkCopper(ed.doc, vias.map(asVia), { ignorePours: true, clearanceOnly: true }).length) { this.note = 'no room for the vias here'; return; }
    }
    this.steps.push(this.snapshot());
    this.vias.push(...vias);
    if (dir > 0) ed.nextSignalLayer(); else ed.prevSignalLayer();
    this.refreshWidths();
    this.runs.push({ layer: ed.currentLayer, centre: [head], starts: vias.map((v) => v.at), order: [...order] });
    this.world = null;
    this.note = '';
  }

  private reset(): void {
    this.runs = []; this.vias = []; this.steps = []; this.look = []; this.endAt = null; this.violations = []; this.note = ''; this.world = null; this.lanes = [];
  }

  private finish(): void {
    const ed = this.ed;
    // A route ended on its targets keeps the leads to them; otherwise it stops where the last click put it
    const ends = this.endAt;
    this.look = [];
    const tracks: TrackFields[] = [];
    this.runs.forEach((r, i) => {
      const last = i === this.runs.length - 1;
      for (const lane of this.runTracks(r, [], last ? ends ?? undefined : this.viaEndsOf(i))) tracks.push(...lane);
    });
    const vias = this.vias;
    const label = this.kind === 'pair' ? 'Interactive Differential Pair Routing' : 'Interactive Multi-Routing';
    this.reset();
    if (!tracks.length && !vias.length) return;
    ed.undo.transact(label, (tx) => {
      if (tracks.length) tx.add(addTracks(ed.doc, tracks));
      if (vias.length) tx.add(addVias(ed.doc, vias));
    });
  }

  overlay(): ToolOverlay | null {
    if (!this.active) return null;
    const segments: NonNullable<ToolOverlay['segments']> = [];
    const circles: NonNullable<ToolOverlay['circles']> = [];
    const bad = this.violations.length > 0;
    this.runs.forEach((r, i) => {
      const last = i === this.runs.length - 1;
      const lanes = this.runTracks(r, last ? this.look : [], last ? this.endAt ?? undefined : this.viaEndsOf(i));
      for (const lane of lanes) for (const t of lane) segments.push({ a: t.a, b: t.b, width: t.width, color: last && bad ? DRC_GREEN : layerColour(t.layer) });
    });
    const viaC = hexToRgb(settings.pcbViaColour), holeC = hexToRgb(settings.pcbHoleColour);
    for (const v of this.vias) circles.push({ c: v.at, r: v.diameter / 2, color: viaC }, { c: v.at, r: v.hole / 2, color: holeC });
    for (const v of this.violations) circles.push({ c: v.at, r: Math.max(this.lanes[0]?.width ?? 0, 40_000), color: DRC_GREEN });
    if (!segments.length) for (const s of this.run.starts) circles.push({ c: s, r: (this.lanes[0]?.width ?? 100_000) / 2, color: layerColour(this.ed.currentLayer) });
    return { segments, circles };
  }

  deactivate(): void { if (this.active) this.finish(); }
  abort(): void { this.reset(); }
}
