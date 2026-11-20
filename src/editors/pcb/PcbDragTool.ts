/**
 * Dragging a track segment or a via with the mouse, as AD17 does (Preferences › PCB Editor ›
 * Interactive Routing › Dragging; Unselected / Selected via/track: Drag):
 * - A track segment slides across itself. With Preserve Angle When Dragging the segments either
 *   side keep their directions (their shared corners slide along them); an end held by a pad, a
 *   via, a branch or nothing gets a new segment back to where it was; a neighbour in line with
 *   the segment (a straight run laid in pieces) has no corner to slide, so the segment steps out
 *   of the run through a new 45° segment cut from that neighbour. Without Preserve Angle the
 *   neighbours' ends simply follow.
 * - A via moves; the tracks ending on it follow.
 * - When dragging: Ignore Obstacles goes where the mouse is; Avoid Obstacles stops where the
 *   moved copper would come nearer another net than its gap; Avoid Obstacles (Snap Grid) also
 *   keeps it on the snap grid. What the copper already lies at exactly its gap from, or nearer
 *   (tracks routed at the clearance, a violation already there), doesn't hold it where it is: it
 *   may go anywhere that brings it no nearer.
 * Locked tracks and tracks of components or pours aren't dragged. One undo step.
 */
import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import { pointInPoly, type Vec2 } from '../../core/geom';
import { addTracks, repour, replaceRecords } from '../../model/pcbEdit';
import type { TrackFields } from '../../formats/altium/pcbdoc';
import { transformRecord } from '../../formats/altium/pcbTransform';
import { TRACK, put } from '../../formats/altium/pcbLayouts';
import { isSignal, layerColour, type LayerId } from '../../model/layers';
import { NO_NET, type PcbPrim, type PcbTrack, type PcbVia } from '../../model/pcb';
import { RouteWorld, type RItem } from '../../model/router';
import { hexToRgb, settings } from '../../core/settings';
import { primKey, type PcbEditor } from './PcbEditor';

const same = (a: Vec2, b: Vec2) => Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;
const rnd = (p: Vec2): Vec2 => ({ x: Math.round(p.x), y: Math.round(p.y) });
const unit = (a: Vec2, b: Vec2): Vec2 => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
function meet(p: Vec2, u: Vec2, q: Vec2, v: Vec2): Vec2 | null {
  const den = u.x * v.y - u.y * v.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((q.x - p.x) * v.y - (q.y - p.y) * v.x) / den;
  return { x: p.x + u.x * t, y: p.y + u.y * t };
}

/** Free tracks: not locked, not part of a component or a pour. */
const free = (p: PcbPrim): p is PcbTrack => p.kind === 'track' && !p.locked && p.component === NO_NET && p.polygon === NO_NET && !p.keepout;

/** One end of the dragged segment: a neighbour that slides with it (or, in line with it, gives up a 45° step), or held where it is. */
interface Joint { at: Vec2; nb?: PcbTrack; far?: Vec2; dir?: Vec2; inline?: boolean }

/** A neighbour this near the segment's own direction is in line with it (the sine of the angle between them: about a degree). */
const INLINE = 0.02;
/** The least left of a neighbour (0.1 mil). */
const KEEP = 1000;
/** Copper may come this much nearer what it already lay too near (the rounding of its new ends). */
const NEARER = 3;

/** What the drag would leave: the tracks changed (by record), the segments added, the via's new place. */
interface Plan { tracks: { t: PcbTrack; a: Vec2; b: Vec2 }[]; added: TrackFields[]; via?: Vec2 }

export class PcbDragTool implements Tool {
  readonly id = 'pcb-drag';
  private plan: Plan | null = null;
  private note = '';
  private joints: [Joint, Joint] | null = null;
  private attached: { t: PcbTrack; ends: ('a' | 'b')[] }[] = [];
  private worlds = new Map<LayerId, RouteWorld>();
  /**
   * By layer: how near the dragged copper lies, before the drag, to what it is too near (or at
   * exactly its gap from). For each piece of it, and (`null`) for the nearest of them all, which
   * is what a new segment between them is held to.
   */
  private rest = new Map<LayerId, Map<PcbPrim | null, Map<RItem, number>>>();
  /** What the last plan that wasn't clear came too near. */
  private inTheWay: RItem | null = null;

  constructor(private ed: PcbEditor, private prim: PcbTrack | PcbVia, private grab: Vec2) {
    const doc = ed.doc;
    if (prim.kind === 'track') {
      const holds = (at: Vec2) => doc.prims.some((p) => p !== prim && 'net' in p && p.net === prim.net && (
        ((p.kind === 'pad' || p.kind === 'via') && same(p.at, at)) || p.kind === 'arc'
        && [p.start, p.end].some((a) => same({ x: p.c.x + p.r * Math.cos((a * Math.PI) / 180), y: p.c.y + p.r * Math.sin((a * Math.PI) / 180) }, at))));
      const joint = (at: Vec2): Joint => {
        const nbs = doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p !== prim && p.layer === prim.layer && p.net === prim.net && (same(p.a, at) || same(p.b, at)));
        if (nbs.length !== 1 || holds(at) || !free(nbs[0]!)) return { at };
        const nb = nbs[0]!, far = same(nb.a, at) ? nb.b : nb.a;
        if (same(far, at)) return { at };
        const dir = unit(far, at);
        // In line with the segment: going on from its end, or (lying back along it) not a neighbour to slide on at all
        if (Math.abs(u.x * dir.y - u.y * dir.x) < INLINE) return dot(dir, into) > 0 ? { at, nb, far, dir, inline: true } : { at };
        return { at, nb, far, dir };
      };
      const u = unit(prim.a, prim.b);
      let into = u;
      const ja = joint(prim.a);
      into = { x: -u.x, y: -u.y };
      this.joints = [ja, joint(prim.b)];
    } else {
      for (const p of doc.prims) {
        if (!free(p) || p.net !== prim.net) continue;
        const ends = (['a', 'b'] as const).filter((e) => same(p[e], prim.at));
        if (ends.length) this.attached.push({ t: p, ends: [...ends] });
      }
    }
    ed.setGhost({ keys: new Set(this.involved().map(primKey)), comps: new Set(), points: new Set() });
  }

  private involved(): PcbPrim[] {
    if (this.prim.kind === 'via') return [this.prim, ...this.attached.map((x) => x.t)];
    return [this.prim, ...(this.joints ?? []).flatMap((j) => (j.nb ? [j.nb] : []))];
  }
  private world(layer: LayerId): RouteWorld {
    let w = this.worlds.get(layer);
    if (!w) { w = new RouteWorld(this.ed.doc, layer); this.worlds.set(layer, w); }
    return w;
  }
  private get mode() { return settings.pcbDragObstacles; }

  hint(): string {
    const what = this.prim.kind === 'via' ? 'Drag Via' : 'Drag Track';
    const how = this.mode === 'ignore' ? 'Ignore Obstacles' : this.mode === 'avoid' ? 'Avoid Obstacles' : 'Avoid Obstacles (Snap Grid)';
    return `${what} (${how}${settings.pcbPreserveAngle && this.prim.kind === 'track' ? ', Preserve Angle' : ''})${this.note ? `, ${this.note}` : ''}: release to drop, Esc to cancel`;
  }

  /* ── a track segment ── */
  private trackPlan(delta: number): Plan | null {
    const t = this.prim as PcbTrack, [ja, jb] = this.joints!;
    const u = unit(t.a, t.b), n = { x: -u.y, y: u.x };
    const shifted = (p: Vec2): Vec2 => ({ x: p.x + n.x * delta, y: p.y + n.y * delta });
    /** `into`: along the segment from this end towards its middle. `step`: where a neighbour in line now ends (the 45° segment's other end). */
    const end = (j: Joint, into: Vec2): { at: Vec2; slide: boolean; step?: Vec2 } | null => {
      if (!settings.pcbPreserveAngle) return { at: shifted(j.at), slide: !!j.nb };
      if (!j.nb) return { at: shifted(j.at), slide: false };
      if (j.inline) {
        // As far across as along: taken from the neighbour while it has it to give, then from the segment itself
        const s = Math.abs(delta), have = Math.hypot(j.far!.x - j.at.x, j.far!.y - j.at.y);
        const cut = Math.min(s, Math.max(0, have - KEEP)), own = s - cut, p = shifted(j.at);
        return { at: { x: p.x + into.x * own, y: p.y + into.y * own }, slide: false, step: { x: j.at.x - into.x * cut, y: j.at.y - into.y * cut } };
      }
      const m = meet(j.far!, j.dir!, shifted(j.at), u);
      if (!m || dot({ x: m.x - j.far!.x, y: m.y - j.far!.y }, j.dir!) < KEEP) return null;
      return { at: m, slide: true };
    };
    const ea = end(ja, u), eb = end(jb, { x: -u.x, y: -u.y });
    if (!ea || !eb) return null;
    const a = rnd(ea.at), b = rnd(eb.at);
    if (dot({ x: b.x - a.x, y: b.y - a.y }, u) <= 0) return null;
    const plan: Plan = { tracks: [{ t, a, b }], added: [] };
    const net = t.net === NO_NET ? undefined : t.net;
    for (const [j, e, at] of [[ja, ea, a], [jb, eb, b]] as const) {
      if (e.step && j.nb) {
        const q = rnd(e.step);
        if (!same(q, j.at)) plan.tracks.push({ t: j.nb, a: same(j.nb.a, j.at) ? q : j.nb.a, b: same(j.nb.b, j.at) ? q : j.nb.b });
        if (!same(q, at)) plan.added.push({ layer: t.layer, a: q, b: at, width: t.width, net });
      } else if (e.slide && j.nb) plan.tracks.push({ t: j.nb, a: same(j.nb.a, j.at) ? at : j.nb.a, b: same(j.nb.b, j.at) ? at : j.nb.b });
      else if (!same(at, j.at)) plan.added.push({ layer: t.layer, a: j.at, b: at, width: t.width, net });
    }
    return plan;
  }

  /* ── a via ── */
  private viaPlan(to: Vec2): Plan {
    const at = rnd(to);
    return { tracks: this.attached.map(({ t, ends }) => ({ t, a: ends.includes('a') ? at : t.a, b: ends.includes('b') ? at : t.b })), added: [], via: at };
  }

  private look(): { skip: (it: { prim: number }) => boolean } {
    const skip = new Set(this.involved().map((p) => this.ed.doc.prims.indexOf(p)));
    return { skip: (it) => skip.has(it.prim) };
  }
  /** The layers a via's copper is on. */
  private span(v: PcbVia): LayerId[] {
    const stack = this.ed.doc.board.copperStack.filter(isSignal);
    const s0 = stack.indexOf(v.layerStart), s1 = stack.indexOf(v.layerEnd);
    return s0 < 0 || s1 < 0 ? stack : stack.slice(Math.min(s0, s1), Math.max(s0, s1) + 1);
  }
  /** On a layer: what a piece of the dragged copper (`null`: any of it) lies too near where it is before the drag, or at exactly its gap from, and how near. */
  private restOn(layer: LayerId, piece: PcbPrim | null): Map<RItem, number> | undefined {
    let r = this.rest.get(layer);
    if (!r) {
      r = new Map([[null, new Map()]]);
      this.rest.set(layer, r);
      const w = this.world(layer), look = this.look(), all = r.get(null)!;
      const note = (p: PcbPrim, hits: { it: RItem; d: number }[]) => {
        const own = new Map<RItem, number>();
        for (const { it, d } of hits) { own.set(it, Math.min(d, own.get(it) ?? Infinity)); all.set(it, Math.min(d, all.get(it) ?? Infinity)); }
        r!.set(p, own);
      };
      for (const p of this.involved()) {
        if (p.kind === 'track' && p.layer === layer) note(p, w.segNear(p.net, p.width, p.a, p.b, look));
        else if (p.kind === 'via' && this.span(p).includes(layer)) note(p, w.segNear(p.net, p.diameter, p.at, p.at, look));
      }
    }
    return r.get(piece);
  }
  /**
   * A piece of the plan clear on its layer: nearer than its gap to nothing, but for what it already
   * lay as near to (`piece`: the track or via it is; none for a new segment).
   */
  private pieceClear(layer: LayerId, net: number, width: number, a: Vec2, b: Vec2, look: ReturnType<PcbDragTool['look']>, piece: PcbPrim | null = null): boolean {
    const was = this.restOn(layer, piece);
    for (const { it, d } of this.world(layer).segNear(net, width, a, b, look)) {
      const before = was?.get(it);
      if (before === undefined || d < before - NEARER) { this.inTheWay = it; return false; }
    }
    return true;
  }
  /** What stopped the drag, in words (for the status bar: which object, of which net). */
  private obstacle(): string {
    const it = this.inTheWay;
    if (!it) return 'an obstacle';
    if (it.kind === 'edge') return "the board's edge";
    if (it.kind === 'keepout') return 'a keep-out';
    if (it.kind === 'barrier') return 'an obstacle';
    const net = this.ed.doc.nets[it.net]?.name;
    return `${it.kind === 'route' ? 'a track' : it.kind === 'arc' ? 'an arc' : `a ${it.kind}`} ${net ? `of ${net}` : 'with no net'}`;
  }

  /** The plan clear of other nets at their gaps (the dragged copper itself left out). */
  private clear(plan: Plan): boolean {
    const look = this.look();
    for (const { t, a, b } of plan.tracks) if (!this.pieceClear(t.layer, t.net, t.width, a, b, look, t)) return false;
    for (const f of plan.added) if (!this.pieceClear(f.layer, f.net ?? NO_NET, f.width, f.a, f.b, look)) return false;
    if (plan.via && this.prim.kind === 'via') {
      const v = this.prim;
      for (const l of this.span(v)) if (!this.pieceClear(l, v.net, v.diameter, plan.via, plan.via, look, v)) return false;
    }
    return true;
  }

  pointerMove(p: ToolPointer): void {
    const mode = this.mode, snap = mode !== 'avoid';
    const pt = snap ? p.world : p.raw;
    this.note = '';
    if (this.prim.kind === 'track') {
      const t = this.prim, u = unit(t.a, t.b), n = { x: -u.y, y: u.x };
      let want = dot({ x: pt.x - this.grab.x, y: pt.y - this.grab.y }, n);
      // On the snap grid: across an orthogonal segment by whole grid steps, across a diagonal by steps of a half-diagonal
      const g = this.ed.gridSize();
      const step = Math.abs(n.x) > 1e-6 && Math.abs(n.y) > 1e-6 ? g * Math.SQRT1_2 : g;
      if (snap && step > 0) want = Math.round(want / step) * step;
      // As far as the neighbours allow (they mustn't fold back)
      let d = want;
      if (!this.trackPlan(d)) {
        let lo = 0, hi = 1;
        for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (this.trackPlan(want * m)) lo = m; else hi = m; }
        d = want * lo;
        this.note = 'as far as the tracks either side of it allow';
      }
      if (mode !== 'ignore') {
        const ok = (x: number) => { const pl = this.trackPlan(x); return !!pl && this.clear(pl); };
        if (!ok(d)) {
          let lo = 0, hi = 1;
          for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (ok(d * m)) lo = m; else hi = m; }
          d *= lo;
          if (snap && step > 0) d = Math.trunc(d / step) * step;
          this.note = `stopped at ${this.obstacle()}`;
        }
      }
      this.plan = this.trackPlan(d);
    } else {
      const v = this.prim, to = { x: v.at.x + (pt.x - this.grab.x), y: v.at.y + (pt.y - this.grab.y) };
      let plan = this.viaPlan(to);
      if (mode !== 'ignore' && !this.clear(plan)) {
        const at = (k: number) => ({ x: v.at.x + (to.x - v.at.x) * k, y: v.at.y + (to.y - v.at.y) * k });
        let lo = 0, hi = 1;
        for (let k = 0; k < 30; k++) { const m = (lo + hi) / 2; if (this.clear(this.viaPlan(at(m)))) lo = m; else hi = m; }
        plan = this.viaPlan(at(lo));
        if (snap) {
          const g = this.ed.gridSize(), q = { x: Math.round(plan.via!.x / g) * g, y: Math.round(plan.via!.y / g) * g };
          const sp = this.viaPlan(q);
          const by = this.obstacle();
          if (g > 0 && this.clear(sp)) plan = sp;
          this.note = `stopped at ${by}`;
        } else this.note = `stopped at ${this.obstacle()}`;
      }
      this.plan = plan;
    }
    this.ed.invalidateOverlay();
  }

  pointerUp(_p: ToolPointer, _moved: boolean): void { this.commit(); }
  pointerDown(p: ToolPointer): void { if (p.button === 0) this.commit(); }

  private commit(): void {
    const ed = this.ed, doc = ed.doc, plan = this.plan;
    this.end();
    if (!plan) return;
    const changed = plan.tracks.filter(({ t, a, b }) => !same(t.a, a) || !same(t.b, b));
    const viaMoved = plan.via && this.prim.kind === 'via' && !same(plan.via, this.prim.at);
    if (!changed.length && !plan.added.length && !viaMoved) return;
    const edits: Parameters<typeof replaceRecords>[1] = [];
    for (const { t, a, b } of changed) {
      const rec = doc.streams.get(t.src.storage)?.records[t.src.index];
      if (!rec) continue;
      const s = rec.subs[0]!.slice();
      put(s, TRACK.x1, a.x); put(s, TRACK.y1, a.y); put(s, TRACK.x2, b.x); put(s, TRACK.y2, b.y);
      edits.push({ storage: t.src.storage, index: t.src.index, after: { tag: rec.tag, subs: [s, ...rec.subs.slice(1)] } });
    }
    if (viaMoved && this.prim.kind === 'via') {
      const v = this.prim, rec = doc.streams.get(v.src.storage)?.records[v.src.index], d = { x: plan.via!.x - v.at.x, y: plan.via!.y - v.at.y };
      if (rec) edits.push({ storage: v.src.storage, index: v.src.index, after: transformRecord(rec, (q) => ({ x: q.x + d.x, y: q.y + d.y }), 0, { storage: v.src.storage }) });
    }
    // Pours round what moved, as a move repours them
    const pts = [...plan.tracks.flatMap(({ t, a, b }) => [t.a, t.b, a, b]), ...(plan.via ? [plan.via, (this.prim as PcbVia).at] : [])];
    const pours = settings.pcbRepourAfterModification && settings.pcbRepourDependent ? doc.polygons.filter((pg) => pts.some((q) => pointInPoly(q, pg.outline))).map((pg) => pg.index) : [];
    ed.undo.transact(this.prim.kind === 'via' ? 'Drag Via' : 'Drag Track', (tx) => {
      if (edits.length) tx.add(replaceRecords(doc, edits));
      if (plan.added.length) tx.add(addTracks(doc, plan.added));
      for (const i of pours) tx.add(repour(doc, i));
    });
    ed.invalidate();
  }

  private end(): void {
    this.ed.setGhost(null);
    this.ed.setTool(null);
  }

  cancel(): boolean { this.plan = null; this.end(); return true; }
  abort(): void { this.cancel(); }
  key(combo: string): boolean { if (combo === 'Escape') return this.cancel(); return false; }

  overlay(): ToolOverlay | null {
    const segments: NonNullable<ToolOverlay['segments']> = [];
    const circles: NonNullable<ToolOverlay['circles']> = [];
    const plan = this.plan ?? (this.prim.kind === 'track' ? this.trackPlan(0) : this.viaPlan(this.prim.at));
    if (!plan) return null;
    for (const { t, a, b } of plan.tracks) segments.push({ a, b, width: t.width, color: layerColour(t.layer) });
    for (const f of plan.added) segments.push({ a: f.a, b: f.b, width: f.width, color: layerColour(f.layer) });
    if (this.prim.kind === 'via') {
      const at = plan.via ?? this.prim.at;
      circles.push({ c: at, r: this.prim.diameter / 2, color: hexToRgb(settings.pcbViaColour) }, { c: at, r: this.prim.hole / 2, color: hexToRgb(settings.pcbHoleColour) });
    }
    return { segments, circles };
  }
}

/** Whether a press-and-drag on this primitive drags it (AD17: Unselected / Selected via/track: Drag). */
export function drags(p: PcbPrim | undefined, wasSelected: boolean): p is PcbTrack | PcbVia {
  if (!p || (p.kind !== 'track' && p.kind !== 'via')) return false;
  if (p.locked || (p.kind === 'track' && (p.component !== NO_NET || p.polygon !== NO_NET || p.keepout))) return false;
  return (wasSelected ? settings.pcbDragSelected : settings.pcbDragUnselected) === 'drag';
}
