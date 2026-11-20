import type { Tool, ToolOverlay, ToolPointer } from '../../core/tools';
import type { Vec2 } from '../../core/geom';
import { UNITS_PER_MM, formatCoord, mil, parseLength } from '../../core/units';
import { encodeArc, encodeFill, encodeRegion, encodeText, encodeTrack, encodeVia } from '../../formats/altium/pcbdoc';
import type { PcbRawRecord } from '../../formats/altium/framing';
import { ruleLength } from '../../formats/altium/rules';
import { addPrimRecords, placedRecord } from '../../model/pcbEdit';
import { hasDefault, primDefault } from '../../model/pcbDefaults';
import { changedBagDefaults } from '../../model/bagDefaults';
import { readRegionParts, writeRegionParts } from '../../formats/altium/regionRecord';
import { carryPrimInfo } from '../../formats/altium/primInfo';
import { ARC, REGION, get, put } from '../../formats/altium/pcbLayouts';
import { withKeepout } from '../../model/pcbTrackEdit';
import { bodyRecord, circleOutline, type BodySpec } from '../../model/bodies';
import { genericBodyRecord, modelEntry } from '../../model/genericBody';
import type { Change } from '../../core/undo';
import type { CfbEntry } from '../../formats/cfb/cfb';
import { NO_NET, type PcbPrim, type PcbVia } from '../../model/pcb';
import { L, isSignal, type LayerId } from '../../model/layers';
import { ruleFor } from '../../model/drc';
import { settings } from '../../core/settings';
import { previewPrim } from './PcbMoveTool';
import type { PcbEditor } from './PcbEditor';

/** What Place › Via and Place › String put down next; Tab edits it in Properties, as Altium's defaults. */
export interface ViaTemplate { diameter: number; hole: number; fromRule: boolean }
export interface StringTemplate { text: string; height: number; width: number; rotation: number }
export const defaultString = (): StringTemplate => ({ text: 'String', height: mil(60), width: mil(10), rotation: 0 });

type Rec = { storage: string; rec: PcbRawRecord };
const asVia = (at: Vec2, net: number): PcbVia => ({ kind: 'via', src: { storage: 'Vias6', index: -1 }, at, diameter: 0, hole: 0, layerStart: L.TOP, layerEnd: L.BOTTOM, net, locked: false });
const deg = (v: Vec2, c: Vec2) => ((Math.atan2(v.y - c.y, v.x - c.x) * 180) / Math.PI + 360) % 360;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const bottomSide = (l: LayerId) => l === L.BOTTOM || l === L.BOTTOM_OVERLAY || l === L.BOTTOM_SOLDER || l === L.BOTTOM_PASTE;

/** The net of the copper under a point on the current layer (or a multi-layer pad / via). */
function netAt(ed: PcbEditor, at: Vec2, layer?: LayerId): number {
  for (const h of ed.hits(at)) {
    if (h.net === undefined || h.net === NO_NET) continue;
    if (layer !== undefined && h.layer !== undefined && h.layer !== layer && h.layer !== L.MULTI && !(layer === L.MULTI && isSignal(h.layer))) continue;
    return h.net;
  }
  return NO_NET;
}

/* ─── Click-to-place objects: Via, String ────────────────────────────────────────────── */

interface StampSpec {
  id: string;
  what: string;
  preview(at: Vec2): PcbPrim[];
  records(at: Vec2): Rec[];
  hint(): string;
  /** Space turns it (strings). */
  rotate?(step: number): void;
  /** Placed once, then the tool ends (a paste). */
  once?: boolean;
}

class PcbStampTool implements Tool {
  readonly id: string;
  private at: Vec2;
  constructor(private ed: PcbEditor, private spec: StampSpec) { this.id = spec.id; this.at = ed.snap(ed.cursor); }
  hint(): string { return this.spec.hint(); }
  pointerMove(p: ToolPointer): void { this.at = p.world; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    this.at = p.world;
    const recs = this.spec.records(p.world);
    this.ed.undo.transact(`Place ${this.spec.what}`, (tx) => tx.add(addPrimRecords(this.ed.doc, recs)));
    if (this.spec.once) this.ed.setTool(null);
  }
  key(combo: string): boolean {
    const step = settings.pcbRotationStep || 90;
    if (this.spec.rotate && combo === 'Space') { this.spec.rotate(step); return true; }
    if (this.spec.rotate && combo === 'Shift+Space') { this.spec.rotate(-step); return true; }
    return false;
  }
  cancel(): boolean { return false; }
  overlay(): ToolOverlay | null {
    const segments: NonNullable<ToolOverlay['segments']> = [], circles: NonNullable<ToolOverlay['circles']> = [];
    for (const p of this.spec.preview(this.at)) previewPrim(p, (v) => v, 0, segments, circles);
    return { segments, circles };
  }
}

/** Via size: the Routing Via Style rule for where it lands, unless changed with Tab. */
export function viaSize(ed: PcbEditor, at: Vec2, net: number): { diameter: number; hole: number } {
  const t = ed.viaTemplate;
  if (!t.fromRule) return t;
  const r = ruleFor(ed.doc, 'RoutingVias', asVia(at, net));
  return r ? { diameter: ruleLength(r, 'WIDTH', '50mil'), hole: ruleLength(r, 'HOLEWIDTH', '28mil') } : { diameter: t.diameter, hole: t.hole };
}

/** Place › Via (P, V): click places a through via, on the net of the copper it lands on. */
export function placeViaTool(ed: PcbEditor): Tool {
  const stack = () => ed.doc.board.copperStack.filter(isSignal);
  return new PcbStampTool(ed, {
    id: 'place-via', what: 'via',
    hint: () => { const u = ed.units(), s = viaSize(ed, ed.cursor, NO_NET); return `Via ${formatCoord(s.diameter, u)} / ${formatCoord(s.hole, u)} hole: click to place, Tab for properties, right-click to finish`; },
    preview: (at) => { const s = viaSize(ed, at, netAt(ed, at, L.MULTI)); return [{ kind: 'via', at, ...s } as PcbPrim]; },
    records: (at) => {
      const net = netAt(ed, at, L.MULTI), s = viaSize(ed, at, net), st = stack();
      return [{ storage: 'Vias6', rec: placedRecord(ed.doc, 'Vias6', (t) => encodeVia({ at, ...s, net: net === NO_NET ? undefined : net, layerStart: st[0] ?? L.TOP, layerEnd: st.at(-1) ?? L.BOTTOM }, t)) }];
    },
  });
}

/** Place › String (P, S): text on the current layer (mirrored on the bottom side); Space turns it. */
export function placeStringTool(ed: PcbEditor): Tool {
  const t = ed.stringTemplate;
  return new PcbStampTool(ed, {
    id: 'place-string', what: 'string',
    hint: () => `String "${t.text}" on ${ed.layerLabel(ed.currentLayer)}: click to place, Space to rotate, Tab for properties, right-click to finish`,
    rotate: (step) => { t.rotation = (t.rotation + step + 360) % 360; },
    preview: (at) => [{ kind: 'text', at, layer: ed.currentLayer, text: t.text, height: t.height, strokeWidth: t.width, rotation: t.rotation, mirrored: bottomSide(ed.currentLayer), hidden: false } as unknown as PcbPrim],
    records: (at) => [{ storage: 'Texts6', rec: placedRecord(ed.doc, 'Texts6', (tp) => encodeText({ layer: ed.currentLayer, at, height: t.height, strokeWidth: t.width, text: t.text, rotation: t.rotation, mirrored: bottomSide(ed.currentLayer) }, tp, hasDefault('Texts6'))) }],
  });
}

/**
 * Paste of a drawing copied in another application (Preferences › PCB Editor › General › Paste
 * from other applications: Metafile): its lines as tracks on the current layer, 1 mil wide
 * [est: the width a pasted metafile's lines take], following the cursor by the drawing's middle.
 */
export function placeDrawingTool(ed: PcbEditor, strokes: Vec2[][], width = mil(1)): Tool {
  const INCH = mil(1000);
  const segs = strokes.flatMap((l) => l.slice(1).map((b, i) => ({ a: { x: l[i]!.x * INCH, y: l[i]!.y * INCH }, b: { x: b.x * INCH, y: b.y * INCH } })))
    .filter((s) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) > 100);
  const at = (o: Vec2, v: Vec2) => ({ x: Math.round(o.x + v.x), y: Math.round(o.y + v.y) });
  return new PcbStampTool(ed, {
    id: 'paste-drawing', what: `drawing (${segs.length} lines)`, once: true,
    hint: () => `Paste: a drawing of ${segs.length} lines on ${ed.layerLabel(ed.currentLayer)}: click to place, right-click cancels`,
    preview: (o) => segs.map((s) => ({ kind: 'track', layer: ed.currentLayer, a: at(o, s.a), b: at(o, s.b), width } as unknown as PcbPrim)),
    records: (o) => segs.map((s) => ({ storage: 'Tracks6', rec: placedRecord(ed.doc, 'Tracks6', (t) => encodeTrack({ layer: ed.currentLayer, a: at(o, s.a), b: at(o, s.b), width }, t)) })),
  });
}

/* ─── Objects drawn by clicking points: Fill, Arcs, Solid Region ─────────────────────── */

interface ShapeSpec {
  id: string;
  what: string;
  /** Clicks that complete it; 0 = a click per vertex, right-click finishes. */
  clicks: number;
  prompt(n: number): string;
  /** Preview prims and final records for these points (the last is the cursor while drawing). */
  build(pts: Vec2[]): { prims: PcbPrim[]; records: Rec[]; changes?: Change[] } | null;
  /** The layer it goes on, when not the current one (a 3D body's mechanical layer). */
  layer?: LayerId;
  /** After each one is placed (Place › 3D Body asks for the next body's settings). */
  after?: () => void;
}

class PcbShapeTool implements Tool {
  readonly id: string;
  private pts: Vec2[] = [];
  private cur: Vec2;
  /** Place › Keepout: the same shape, flagged keepout (it keeps routing and pours off its layer). */
  constructor(private ed: PcbEditor, private spec: ShapeSpec, keepout = false) {
    this.id = keepout ? spec.id.replace(/^place-/, 'place-keepout-') : spec.id;
    if (keepout) {
      const build = spec.build;
      this.spec = { ...spec, what: `keepout ${spec.what}`, build: (pts) => { const b = build(pts); return b && { prims: b.prims, records: b.records.map((r) => ({ storage: r.storage, rec: withKeepout(r.rec, true) })) }; } };
    }
    this.cur = ed.snap(ed.cursor);
  }
  hint(): string { return `Place ${this.spec.what} on ${this.ed.layerLabel(this.spec.layer ?? this.ed.currentLayer)}: ${this.spec.prompt(this.pts.length)}${this.spec.clicks ? '' : ', right-click to finish'}. Esc cancels`; }
  pointerMove(p: ToolPointer): void { this.cur = p.world; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const last = this.pts.at(-1);
    if (!last || last.x !== p.world.x || last.y !== p.world.y) this.pts.push(p.world);
    if (this.spec.clicks && this.pts.length >= this.spec.clicks) this.commit(this.pts);
  }
  private commit(pts: Vec2[]): void {
    const b = this.spec.build(pts);
    this.pts = [];
    if (!b?.records.length) return;
    this.ed.undo.transact(`Place ${this.spec.what}`, (tx) => { for (const c of b.changes ?? []) tx.add(c); tx.add(addPrimRecords(this.ed.doc, b.records)); });
    this.spec.after?.();
  }
  cancel(): boolean {
    if (!this.spec.clicks && this.pts.length >= 3) { this.commit(this.pts); return true; }
    if (this.pts.length) { this.pts = []; return true; }
    return false;
  }
  key(combo: string): boolean {
    if (combo === 'Backspace') { this.pts.pop(); return true; }
    if (combo === 'Escape') { if (this.pts.length) { this.pts = []; return true; } this.ed.setTool(null); return true; }
    if (combo === 'Enter') return this.cancel();
    return false;
  }
  overlay(): ToolOverlay | null {
    const segments: NonNullable<ToolOverlay['segments']> = [], circles: NonNullable<ToolOverlay['circles']> = [];
    const b = this.pts.length ? this.spec.build([...this.pts, this.cur]) : null;
    for (const p of b?.prims ?? []) previewPrim(p, (v) => v, 0, segments, circles);
    if (!this.spec.clicks && this.pts.length) for (let i = 1; i < this.pts.length; i++) segments.push({ a: this.pts[i - 1]!, b: this.pts[i]!, width: 0, color: 0xffffff });
    return { segments, circles };
  }
}

function arcOf(ed: PcbEditor, c: Vec2, r: number, start: number, end: number, keepout = false): { prims: PcbPrim[]; records: Rec[] } | null {
  if (r < 1) return null;
  // Width from the arc default (Tab, Preferences › Defaults), else the routing width; a keepout's from Preferences › Defaults › Keepout Arc where that gives one
  const def = hasDefault('Arcs6') ? primDefault('Arcs6') : undefined, own = keepout ? parseLength(changedBagDefaults('Keepout Arc').LINEWIDTH ?? '') : undefined;
  const layer = ed.currentLayer, width = (own && own > 0 ? Math.round(own) : 0) || (def && get(def.subs[0]!, ARC.width)) || ed.trackWidth;
  const s = +start.toFixed(3), e = +end.toFixed(3);
  return {
    prims: [{ kind: 'arc', c, r, start: s, end: e, width, layer } as PcbPrim],
    records: [{ storage: 'Arcs6', rec: placedRecord(ed.doc, 'Arcs6', (t) => encodeArc({ layer, c: { x: Math.round(c.x), y: Math.round(c.y) }, r: Math.round(r), start: s, end: e, width }, t)) }],
  };
}

/** Place › Fill (P, F): two corners. */
export const placeFillTool = (ed: PcbEditor, keepout = false): Tool => new PcbShapeTool(ed, {
  id: 'place-fill', what: 'fill', clicks: 2,
  prompt: (n) => (n ? 'click the opposite corner' : 'click the first corner'),
  build: (pts) => {
    const [a0, b0] = [pts[0]!, pts.at(-1)!];
    const a = { x: Math.min(a0.x, b0.x), y: Math.min(a0.y, b0.y) }, b = { x: Math.max(a0.x, b0.x), y: Math.max(a0.y, b0.y) };
    if (a.x === b.x || a.y === b.y) return null;
    const layer = ed.currentLayer;
    return { prims: [{ kind: 'fill', a, b, layer, rotation: 0 } as PcbPrim], records: [{ storage: 'Fills6', rec: placedRecord(ed.doc, 'Fills6', (t) => encodeFill({ layer, a, b }, t)) }] };
  },
}, keepout);

/** Place › Arc (Center) (P, A): centre, radius, start, end. */
export const placeArcCentreTool = (ed: PcbEditor, keepout = false): Tool => new PcbShapeTool(ed, {
  id: 'place-arc-centre', what: 'arc', clicks: 4,
  prompt: (n) => ['click the centre', 'click to set the radius', 'click the start of the arc', 'click the end of the arc'][n]!,
  build: (pts) => {
    const c = pts[0]!, r = pts[1] ? dist(pts[1], c) : 0;
    if (pts.length <= 2) return arcOf(ed, c, r, 0, 360, keepout);
    const start = deg(pts[2]!, c);
    return arcOf(ed, c, r, start, pts[3] ? deg(pts[3], c) : (start + 90) % 360, keepout);
  },
}, keepout);

/** Place › Arc (Edge) (P, E): a quarter circle between two points. */
export const placeArcEdgeTool = (ed: PcbEditor, keepout = false): Tool => new PcbShapeTool(ed, {
  id: 'place-arc-edge', what: 'arc', clicks: 2,
  prompt: (n) => (n ? 'click the end of the arc' : 'click the start of the arc'),
  build: (pts) => {
    const s = pts[0]!, e = pts.at(-1)!;
    const dx = e.x - s.x, dy = e.y - s.y;
    const c = { x: (s.x + e.x) / 2 - dy / 2, y: (s.y + e.y) / 2 + dx / 2 };
    return arcOf(ed, c, dist(s, c), deg(s, c), deg(e, c), keepout);
  },
}, keepout);

/** Place › Arc (Any Angle) (P, N): start point, centre, end. */
export const placeArcAnyTool = (ed: PcbEditor, keepout = false): Tool => new PcbShapeTool(ed, {
  id: 'place-arc-any', what: 'arc', clicks: 3,
  prompt: (n) => ['click the start of the arc', 'click the centre', 'click the end of the arc'][n]!,
  build: (pts) => {
    if (pts.length < 2) return null;
    const s = pts[0]!, c = pts[1]!, r = dist(s, c);
    const start = deg(s, c);
    return arcOf(ed, c, r, start, pts[2] ? deg(pts[2], c) : (start + 90) % 360, keepout);
  },
}, keepout);

/** Place › Full Circle (P, U): centre, radius. */
export const placeCircleTool = (ed: PcbEditor, keepout = false): Tool => new PcbShapeTool(ed, {
  id: 'place-circle', what: 'full circle', clicks: 2,
  prompt: (n) => (n ? 'click to set the radius' : 'click the centre'),
  build: (pts) => arcOf(ed, pts[0]!, pts[1] ? dist(pts[1], pts[0]!) : 0, 0, 360, keepout),
}, keepout);

/** Place › Solid Region (P, R): a click per vertex on the current layer. */
export const placeRegionTool = (ed: PcbEditor, keepout = false): Tool => new PcbShapeTool(ed, {
  id: 'place-region', what: 'solid region', clicks: 0,
  prompt: (n) => (n ? 'click the next vertex' : 'click the first vertex'),
  build: (pts) => {
    if (pts.length < 3) return { prims: [], records: [] };
    const layer = ed.currentLayer;
    const outline = pts.map((p) => ({ x: p.x, y: p.y }));
    return { prims: [{ kind: 'region', outline, holes: [], layer } as unknown as PcbPrim], records: [{ storage: 'Regions6', rec: regionFromDefault(encodeRegion({ layer, outline })) }] };
  },
}, keepout);

/** A new region takes the region default's kind, lock and mask expansions (Tab, Preferences › Defaults). */
function regionFromDefault(rec: PcbRawRecord): PcbRawRecord {
  const def = hasDefault('Regions6') ? primDefault('Regions6') : undefined;
  if (!def) return rec;
  const d = readRegionParts('Regions6', def.subs[0]!), p = readRegionParts('Regions6', rec.subs[0]!);
  for (const k of ['KIND', 'ISBOARDCUTOUT']) { const v = d.props.get(k); if (v !== undefined) p.props.set(k, v); }
  put(p.head, REGION.flags1, get(def.subs[0]!, REGION.flags1) ?? 0x0c);
  const out = { tag: rec.tag, subs: [writeRegionParts(p)] };
  carryPrimInfo(def, out);
  return out;
}

/**
 * Place › 3D Body: an extruded body's outline a click per vertex (right-click finishes), a
 * cylinder or sphere by its centre; on the body's mechanical layer, owned by no component.
 */
export const placeBodyTool = (ed: PcbEditor, spec: BodySpec, after?: () => void): Tool => new PcbShapeTool(ed, {
  id: 'place-body', what: '3D body', clicks: spec.type === 'extruded' ? 0 : 1, layer: spec.layer, after,
  prompt: (n) => (spec.type !== 'extruded' ? 'click its centre' : n ? 'click the next vertex' : 'click the first vertex'),
  build: (pts) => {
    const outline = spec.type === 'extruded' ? pts.map((p) => ({ x: p.x, y: p.y })) : circleOutline(pts.at(-1)!, spec.radius);
    if (outline.length < 3) return { prims: [], records: [] };
    return { prims: [{ kind: 'region', outline, holes: [], layer: spec.layer } as unknown as PcbPrim], records: [{ storage: 'ComponentBodies6', rec: bodyRecord(spec, outline) }] };
  },
});

/**
 * Place › 3D Body › Generic: the STEP model's outline on the cursor, placed with a click (its
 * origin there); the model goes into the file (embedded or listed as linked) with the first one.
 */
export const placeGenericBodyTool = (ed: PcbEditor, spec: BodySpec, fp: { outline: Vec2[]; minZ: number; maxZ: number }, store: { root: CfbEntry; prefix: string },
  compressed: Uint8Array | undefined, after?: () => void): Tool => new PcbShapeTool(ed, {
  id: 'place-body', what: '3D body', clicks: 1, layer: spec.layer, after,
  prompt: () => `click where ${spec.model!.name}'s origin goes`,
  build: (pts) => {
    const at = { x: pts.at(-1)!.x, y: pts.at(-1)!.y };
    const entry = modelEntry(store.root, store.prefix, spec.model!, spec.rot ?? [0, 0, 0], spec.standoff, compressed);
    const rec = genericBodyRecord(spec, spec.model!, at, fp, entry.id);
    const outline = fp.outline.map((v) => ({ x: Math.round(at.x + v.x * UNITS_PER_MM), y: Math.round(at.y + (spec.bottom ? -v.y : v.y) * UNITS_PER_MM) }));
    return { prims: [{ kind: 'region', outline, holes: [], layer: spec.layer } as unknown as PcbPrim], records: [{ storage: 'ComponentBodies6', rec }], changes: entry.change ? [entry.change] : [] };
  },
});

/** Place › Polygon Pour Cutout: a region of kind 1 on the current layer — pours leave it empty. */
export const placeCutoutTool = (ed: PcbEditor): Tool => new PcbShapeTool(ed, {
  id: 'place-cutout', what: 'polygon pour cutout', clicks: 0,
  prompt: (n) => (n ? 'click the next vertex' : 'click the first vertex'),
  build: (pts) => {
    if (pts.length < 3) return { prims: [], records: [] };
    const layer = ed.currentLayer, outline = pts.map((p) => ({ x: p.x, y: p.y }));
    return { prims: [{ kind: 'region', outline, holes: [], layer } as unknown as PcbPrim], records: [{ storage: 'Regions6', rec: encodeRegion({ layer, outline, kind: 1 }) }] };
  },
});
