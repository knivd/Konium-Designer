import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import { distToSegment, type Vec2 } from '../../core/geom';
import { formatCoord } from '../../core/units';
import { layerColour, type LayerId } from '../../model/layers';
import { NO_NET, netName, type PcbTrack } from '../../model/pcb';
import { settings, updateSettings } from '../../core/settings';
import { RouteWorld, noPending } from '../../model/router';
import { pairOfNet } from '../../model/diffPairs';
import { accordion, netLength, offsetPieces, partnerTrack, piecesPoints, type TunePattern } from '../../model/lengthTune';
import { tuneChanges, tunePattern, tuneTarget, type Lane } from '../../model/tuneEdit';
import type { PcbEditor } from './PcbEditor';

const mil = (n: number) => Math.round(n * 10_000);
const DRC_GREEN = 0x00ff00;

/**
 * Route › Interactive Length Tuning (and Interactive Diff Pair Length Tuning): click a track of
 * the net, move along it and accordions grow between the click and the cursor, on the cursor's
 * side, until the net reaches its target (Tab: Manual, From Net, or From Rules — the longest net
 * of its Matched Lengths rule, capped by its Length rule). A second click places them. A pair
 * is tuned together: both tracks keep their gap through the bumps.
 *
 * Keys as Altium [est]: 1 / 2 decrease / increase the miter, 3 / 4 the space, , / . the
 * amplitude, Tab the properties, right-click or Esc stops, a second time leaves the tool.
 */
export class LengthTuneTool implements Tool {
  readonly id: string;
  private lanes: PcbTrack[] = [];
  private u0 = 0;
  private hover: Vec2 | null = null;
  private result: { lanes: Lane[]; added: number; bumps: number } | null = null;
  private note = '';

  constructor(private ed: PcbEditor, readonly pair: boolean) {
    this.id = pair ? 'tune-pair' : 'tune';
  }

  get active(): boolean { return this.lanes.length > 0; }
  /** The net being tuned (for the Tab dialog's From Rules target). */
  get net(): number { return this.lanes[0]?.net ?? NO_NET; }
  private get track(): PcbTrack { return this.lanes[0]!; }

  /** Current length of the net (pair: the longer net), with the bumps when placed. */
  private lengths(): { now: number; target: number | null; why: string } {
    const doc = this.ed.doc;
    const nets = [...new Set(this.lanes.map((t) => t.net))];
    const now = Math.max(...nets.map((n) => netLength(doc, n)));
    const t = tuneTarget(doc, this.track.net);
    return { now, target: t?.target ?? null, why: t?.why ?? '' };
  }

  hint(): string {
    const ed = this.ed, u = ed.units();
    const what = this.pair ? 'Interactive Diff Pair Length Tuning' : 'Interactive Length Tuning';
    if (!this.active) return `${what}: click a track of the ${this.pair ? 'pair' : 'net'} to tune${this.note ? ` — ${this.note}` : ''}`;
    const { now, target, why } = this.lengths();
    const after = now + (this.result?.added ?? 0);
    const names = [...new Set(this.lanes.map((t) => netName(ed.doc, t.net)))].join(' / ');
    const pat = tunePattern();
    return `${names}: ${formatCoord(after, u)}${target ? ` of ${formatCoord(target, u)} (${Math.round((after / target) * 100)}%, ${why})` : ''}; `
      + `${pat.style === 'mitered' ? 'Mitered Lines' : pat.style === 'arcs' ? 'Mitered Arcs' : 'Rounded'}, amplitude ${formatCoord(pat.amplitude, u)}, space ${formatCoord(pat.space, u)}, miter ${pat.miter}%. `
      + `1/2 miter, 3/4 space, ,/. amplitude, Tab properties, click places${this.note ? ` — ${this.note}` : ''}`;
  }

  private pick(raw: Vec2): PcbTrack | null {
    for (const h of this.ed.hits(raw)) {
      const p = this.ed.primByKey(h.key);
      if (p?.kind === 'track' && p.net !== NO_NET && p.polygon === NO_NET && !p.keepout) return p;
    }
    return null;
  }
  private along(t: PcbTrack, p: Vec2): number {
    const l = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y) || 1;
    return Math.max(0, Math.min(l, ((p.x - t.a.x) * (t.b.x - t.a.x) + (p.y - t.a.y) * (t.b.y - t.a.y)) / l));
  }
  private side(t: PcbTrack, p: Vec2): 1 | -1 {
    return (t.b.x - t.a.x) * (p.y - t.a.y) - (t.b.y - t.a.y) * (p.x - t.a.x) >= 0 ? 1 : -1;
  }

  private begin(p: ToolPointer): void {
    const t = this.pick(p.raw);
    this.note = '';
    if (!t) { this.note = 'no track there'; return; }
    if (this.pair) {
      const pr = pairOfNet(this.ed.doc, t.net);
      if (!pr) { this.note = `${netName(this.ed.doc, t.net)} is not in a differential pair`; return; }
      const other = partnerTrack(this.ed.doc, t, pr.partner, t.width * 6 + mil(40));
      if (!other) { this.note = `no track of ${netName(this.ed.doc, pr.partner)} beside it`; return; }
      this.lanes = [t, other];
    } else this.lanes = [t];
    if (t.layer !== this.ed.currentLayer) this.ed.setCurrentLayer(t.layer);
    this.u0 = this.along(t, p.world);
  }

  private compute(): void {
    this.result = null;
    if (!this.active || !this.hover) return;
    const doc = this.ed.doc, t = this.track, pat = tunePattern();
    const { now, target } = this.lengths();
    const need = target === null ? Infinity : target - now;
    if (need <= 0) { this.note = 'already at its target'; return; }
    const u1 = this.along(t, this.hover), side = this.side(t, this.hover);
    const removed = new Set(this.lanes.map((x) => doc.prims.indexOf(x)).filter((i) => i >= 0));
    const world = new RouteWorld(doc, t.layer as LayerId, { ...noPending(), removed });
    if (!this.pair) {
      const r = accordion(t.a, t.b, this.u0, u1, side, need, pat, pat.space + t.width, Math.max(t.width, mil(2)), (pts) => world.clear(t.net, t.width, pts));
      this.result = { lanes: [{ track: t, pieces: r.pieces }], added: r.added, bumps: r.bumps };
      return;
    }
    // A pair: one accordion on the line between the tracks, each track beside it
    const o = this.lanes[1]!;
    const l = Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y) || 1, nx = -(t.b.y - t.a.y) / l, ny = (t.b.x - t.a.x) / l;
    const mid = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 };
    const lat = (mid.x - t.a.x) * nx + (mid.y - t.a.y) * ny;
    const A = { x: Math.round(t.a.x + nx * lat / 2), y: Math.round(t.a.y + ny * lat / 2) }, B = { x: Math.round(t.b.x + nx * lat / 2), y: Math.round(t.b.y + ny * lat / 2) };
    // Along the stretch both tracks share
    const ua = this.along(t, o.a), ub = this.along(t, o.b), lo = Math.min(ua, ub), hi = Math.max(ua, ub);
    const margin = Math.abs(lat) + t.width;
    const clamp = (u: number) => Math.max(lo + margin, Math.min(hi - margin, u));
    const half = Math.abs(lat) / 2, pitch = pat.space + Math.abs(lat) + t.width;
    const pat2: TunePattern = pat.style === 'mitered' ? pat : { ...pat, miter: Math.max(pat.miter, Math.ceil(((half + t.width / 2 + mil(1)) * 2 * 100) / pitch)) };
    const r = accordion(A, B, clamp(this.u0), clamp(u1), side, need, pat2, pitch, Math.max(margin, mil(4)), (_pts, pieces) =>
      [[t, -lat / 2], [o, lat / 2]].every(([tr, d]) => world.clear((tr as PcbTrack).net, (tr as PcbTrack).width, piecesPoints(offsetPieces(pieces, d as number)))));
    const lanes: Lane[] = [[t, -lat / 2] as const, [o, lat / 2] as const].map(([tr, d]) => {
      const ps = offsetPieces(r.pieces, d);
      // Each track keeps its own ends
      const first = ps[0], last = ps.at(-1);
      const near = (q: Vec2) => (Math.hypot(q.x - tr.a.x, q.y - tr.a.y) < Math.hypot(q.x - tr.b.x, q.y - tr.b.y) ? tr.a : tr.b);
      if (first?.t === 'line') ps[0] = { ...first, a: near(first.a) };
      if (last?.t === 'line') ps[ps.length - 1] = { ...last, b: near(last.b) };
      return { track: tr, pieces: ps };
    });
    this.result = { lanes, added: r.added, bumps: r.bumps };
  }

  pointerMove(p: ToolPointer): void {
    this.hover = p.world;
    if (this.active) { this.note = ''; this.compute(); }
  }

  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    if (!this.active) { this.begin(p); this.hover = p.world; this.compute(); return; }
    this.hover = p.world;
    this.compute();
    const r = this.result;
    if (!r || !r.bumps) { this.note = 'no room for a bump here'; return; }
    const ed = this.ed;
    ed.undo.transact(this.pair ? 'Interactive Diff Pair Length Tuning' : 'Interactive Length Tuning', (tx) => tuneChanges(ed.doc, r.lanes, (c) => tx.add(c)));
    this.lanes = []; this.result = null;
  }

  cancel(): boolean {
    if (this.active) { this.lanes = []; this.result = null; return true; }
    return false;
  }

  key(combo: string): boolean {
    const s = settings;
    const set = (patch: Partial<typeof settings>) => { updateSettings(patch); this.compute(); return true; };
    switch (combo) {
      case '1': return set({ pcbTuneMiter: Math.max(0, s.pcbTuneMiter - 10) });
      case '2': return set({ pcbTuneMiter: Math.min(100, s.pcbTuneMiter + 10) });
      case '3': return set({ pcbTuneSpace: Math.max(1, s.pcbTuneSpace - s.pcbTuneSpaceInc) });
      case '4': return set({ pcbTuneSpace: s.pcbTuneSpace + s.pcbTuneSpaceInc });
      case ',': return set({ pcbTuneAmplitude: Math.max(1, s.pcbTuneAmplitude - s.pcbTuneAmplitudeInc) });
      case '.': return set({ pcbTuneAmplitude: s.pcbTuneAmplitude + s.pcbTuneAmplitudeInc });
      case 'Escape': return this.cancel();
    }
    return false;
  }

  /** The Tab dialog changed the settings. */
  refresh(): void { this.compute(); }

  overlay(): ToolOverlay | null {
    if (!this.active) {
      const t = this.hover ? this.pick(this.hover) : null;
      return t ? { segments: [{ a: t.a, b: t.b, width: t.width, color: 0xffffff, hollow: true }] } : null;
    }
    const segments: NonNullable<ToolOverlay['segments']> = [];
    const labels: NonNullable<ToolOverlay['labels']> = [];
    const colour = layerColour(this.track.layer);
    for (const lane of this.result?.lanes ?? this.lanes.map((t) => ({ track: t, pieces: [{ t: 'line' as const, a: t.a, b: t.b }] }))) {
      const pts = piecesPoints(lane.pieces);
      for (let i = 1; i < pts.length; i++) segments.push({ a: pts[i - 1]!, b: pts[i]!, width: lane.track.width, color: colour });
    }
    for (const t of this.lanes) segments.push({ a: t.a, b: t.b, width: t.width, color: 0x808080, hollow: true });
    const { now, target } = this.lengths();
    if (this.hover && target) {
      const after = now + (this.result?.added ?? 0), pct = Math.round((after / target) * 100);
      labels.push({ at: { x: this.hover.x, y: this.hover.y + mil(30) }, text: `${formatCoord(after, this.ed.units())} / ${formatCoord(target, this.ed.units())} ${pct}%`, color: pct >= 100 ? DRC_GREEN : 0xffff00, px: 13 });
    }
    return { segments, labels };
  }

  deactivate(): void { this.lanes = []; this.result = null; }
  abort(): void { this.lanes = []; this.result = null; }
}

/** Whether a point is on a track (for the tools' picking). */
export const onTrack = (t: PcbTrack, p: Vec2) => distToSegment(p, t.a, t.b) <= t.width / 2;
