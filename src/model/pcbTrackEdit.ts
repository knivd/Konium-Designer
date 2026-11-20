/**
 * Editing free primitives on a board or footprint: keepout flags (Place › Keepout, Convert
 * Selected Keepouts ↔ Primitives), Edit › Break Track and Slice Tracks, Reports › Measure
 * Primitives, Create Region from Selected Primitives, and Paste Array.
 */
import type { Vec2 } from '../core/geom';
import { arcPoints, distToSegment } from '../core/geom';
import type { PcbRawRecord } from '../formats/altium/framing';
import { PCB_TAG } from '../formats/altium/framing';
import { TRACK, get, put } from '../formats/altium/pcbLayouts';
import { editRegionProps, placement, transformRecord } from '../formats/altium/pcbTransform';
import { encodeRegion, layerToName, putLayer } from '../formats/altium/pcbdoc';
import { copperShapes, distance } from './drc';
import { shapeFromLoop } from './pcbBoard';
import { L } from './layers';
import type { PcbArc, PcbDocument, PcbPrim, PcbTrack } from './pcb';
import type { PcbClip } from '../editors/clipboard';

/** Keepout is the record's second flag byte = 2 (tracks, arcs, fills, regions, texts alike). */
export function withKeepout(rec: PcbRawRecord, on: boolean): PcbRawRecord {
  const s = rec.subs[0]!.slice();
  s[2] = on ? 2 : 0;
  return { tag: rec.tag, subs: [s, ...rec.subs.slice(1)] };
}
export const KEEPOUT_KINDS = new Set(['track', 'arc', 'fill', 'region']);

/** A copy of a track record with one end moved. */
export function trackWithEnds(rec: PcbRawRecord, a: Vec2, b: Vec2): PcbRawRecord {
  const s = rec.subs[0]!.slice();
  put(s, TRACK.x1, Math.round(a.x)); put(s, TRACK.y1, Math.round(a.y)); put(s, TRACK.x2, Math.round(b.x)); put(s, TRACK.y2, Math.round(b.y));
  return { tag: rec.tag, subs: [s, ...rec.subs.slice(1)] };
}

/** The point on a track nearest p (on the grid line through it), or null when p is off the track. */
export function pointOnTrack(t: PcbTrack, p: Vec2, tol: number): Vec2 | null {
  if (distToSegment(p, t.a, t.b) > Math.max(tol, t.width / 2)) return null;
  const dx = t.b.x - t.a.x, dy = t.b.y - t.a.y, len2 = dx * dx + dy * dy;
  if (!len2) return null;
  const u = Math.max(0, Math.min(1, ((p.x - t.a.x) * dx + (p.y - t.a.y) * dy) / len2));
  return { x: Math.round(t.a.x + u * dx), y: Math.round(t.a.y + u * dy) };
}

/** Break Track: the track becomes two that meet at `at` (null when `at` is an end). */
export function breakTrack(rec: PcbRawRecord, t: PcbTrack, at: Vec2): [PcbRawRecord, PcbRawRecord] | null {
  const same = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
  if (same(at, t.a) || same(at, t.b)) return null;
  return [trackWithEnds(rec, t.a, at), trackWithEnds(rec, at, t.b)];
}

/** Where segment p-q crosses segment a-b, strictly inside both (null if they don't). */
export function crossing(p: Vec2, q: Vec2, a: Vec2, b: Vec2): Vec2 | null {
  const r = { x: q.x - p.x, y: q.y - p.y }, s = { x: b.x - a.x, y: b.y - a.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const w = { x: a.x - p.x, y: a.y - p.y };
  const t = (w.x * s.y - w.y * s.x) / den, u = (w.x * r.y - w.y * r.x) / den;
  if (t <= 0 || t >= 1 || u <= 1e-9 || u >= 1 - 1e-9) return null;
  return { x: Math.round(p.x + t * r.x), y: Math.round(p.y + t * r.y) };
}

/** Slice Tracks: every free track the line p-q crosses is cut there into two [est: no gap left]. */
export function sliceTracks(doc: PcbDocument, p: Vec2, q: Vec2): { edits: { storage: string; index: number; after: PcbRawRecord }[]; added: PcbRawRecord[] } {
  const edits: { storage: string; index: number; after: PcbRawRecord }[] = [], added: PcbRawRecord[] = [];
  for (const t of doc.prims) {
    if (t.kind !== 'track' || t.component !== 0xffff) continue;
    const x = crossing(p, q, t.a, t.b);
    if (!x) continue;
    const rec = doc.streams.get(t.src.storage)?.records[t.src.index];
    const halves = rec && breakTrack(rec, t, x);
    if (!halves) continue;
    edits.push({ storage: t.src.storage, index: t.src.index, after: halves[0] });
    added.push(halves[1]);
  }
  return { edits, added };
}

/** Measure Primitives: edge to edge distance between two primitives (0 when they touch or overlap), whatever their layers. */
export function measurePrims(doc: PcbDocument, a: PcbPrim, b: PcbPrim): number | null {
  const flat = (p: PcbPrim): PcbPrim => ('layer' in p && p.kind !== 'pad' ? { ...p, layer: L.TOP, keepout: false, ...(p.kind === 'region' ? { regionKind: 0, boardCutout: false } : {}) } as PcbPrim : p);
  const ga = copperShapes(doc, [flat(a)]).map((s) => s.g), gb = copperShapes(doc, [flat(b)]).map((s) => s.g);
  if (!ga.length || !gb.length) return null;
  let d = Infinity;
  for (const x of ga) for (const y of gb) d = Math.min(d, distance(x, y));
  return Math.max(0, d);
}

/** Create Region from Selected Primitives: tracks and arcs in a closed loop → a solid region on their layer. */
export function regionFromLoop(prims: (PcbTrack | PcbArc)[]): PcbRawRecord | string {
  const v = shapeFromLoop(prims);
  if (typeof v === 'string') return v;
  const outline: Vec2[] = [];
  v.forEach((x) => {
    if (!x.arc) { outline.push(x.p); return; }
    const sweep = ((x.arc.ea - x.arc.sa) % 360 + 360) % 360;
    const pts = arcPoints(x.arc.c, x.arc.r, x.arc.r, x.arc.sa, x.arc.sa + sweep, Math.max(4, Math.ceil(sweep / 6)));
    // The arc runs from this vertex: keep its direction
    const near = (q: Vec2) => Math.hypot(q.x - x.p.x, q.y - x.p.y);
    outline.push(...(near(pts[0]!) <= near(pts.at(-1)!) ? pts : [...pts].reverse()).slice(0, -1).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })));
  });
  return encodeRegion({ layer: prims[0]!.layer, outline });
}

/** A pad's designator (the record's first subrecord, a Pascal string). */
export function padName(rec: PcbRawRecord): string {
  const s = rec.subs[0]!;
  let n = '';
  for (let i = 1; i <= Math.min(s[0] ?? 0, s.length - 1); i++) n += String.fromCharCode(s[i]!);
  return n;
}
export function withPadName(rec: PcbRawRecord, name: string): PcbRawRecord {
  const b = new Uint8Array(Math.min(name.length, 255) + 1);
  b[0] = b.length - 1;
  for (let i = 1; i < b.length; i++) b[i] = name.charCodeAt(i - 1) & 0xff;
  return { tag: rec.tag, subs: [b, ...rec.subs.slice(1)] };
}
/** 1 → 2, A9 → A10; names without a number stay. */
export function stepPadName(name: string, by: number): string {
  const m = /^(.*?)(\d+)(\D*)$/.exec(name);
  return m ? `${m[1]}${Math.max(0, Number(m[2]) + by)}${m[3]}` : name;
}

/**
 * Edit › Paste Array: `count` copies of the clipboard's free objects, each `d` on from the
 * last (linear), or turned `angle`° more about `centre` (circular, items turned to match when
 * `rotateItems`); pad designators step by `increment`. One clip, pasted once.
 */
export function arrayClip(clip: PcbClip, o: { count: number; increment: number; d?: Vec2; centre?: Vec2; angle?: number; rotateItems?: boolean }): PcbClip {
  const records: PcbClip['records'] = [];
  for (let k = 0; k < Math.max(1, Math.floor(o.count)); k++) {
    let map, rot = 0;
    if (o.centre && o.angle !== undefined) {
      const a = o.angle * k, c = o.centre;
      const rad = (a * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
      const at = (v: Vec2) => ({ x: c.x + (v.x - c.x) * cos - (v.y - c.y) * sin, y: c.y + (v.x - c.x) * sin + (v.y - c.y) * cos });
      if (o.rotateItems) { map = placement(c, a, { x: 0, y: 0 }); rot = a; }
      else { const ref = clip.ref, to = at(ref); map = placement(ref, 0, { x: to.x - ref.x, y: to.y - ref.y }); }
    } else map = placement(clip.ref, 0, { x: (o.d?.x ?? 0) * k, y: (o.d?.y ?? 0) * k });
    for (const r of clip.records) {
      let rec = k ? transformRecord(r.rec, map, rot, { storage: r.storage }) : r.rec;
      if (k && o.increment && r.rec.tag === PCB_TAG.PAD) rec = withPadName(rec, stepPadName(padName(r.rec), k * o.increment));
      records.push({ storage: r.storage, rec });
    }
  }
  return { ...clip, records };
}

/** For the tests: the track endpoints a record holds. */
export const trackEnds = (rec: PcbRawRecord): [Vec2, Vec2] => {
  const s = rec.subs[0]!;
  return [{ x: get(s, TRACK.x1) ?? 0, y: get(s, TRACK.y1) ?? 0 }, { x: get(s, TRACK.x2) ?? 0, y: get(s, TRACK.y2) ?? 0 }];
};

/** Paste Special › Paste on current layer: free tracks, arcs, fills, texts and regions move to `layer` (pads and vias keep theirs). */
export function onLayer(rec: PcbRawRecord, layer: number): PcbRawRecord {
  if (![PCB_TAG.TRACK, PCB_TAG.ARC, PCB_TAG.FILL, PCB_TAG.TEXT, PCB_TAG.REGION].includes(rec.tag as never) || layer > 82) return rec;
  let s: Uint8Array = rec.subs[0]!.slice();
  // The V7 layer a track, arc, fill or text (32-bit id) or region (V7_LAYER) may also carry wins over the byte
  putLayer(rec.tag, s, layer);
  if (rec.tag === PCB_TAG.REGION) s = editRegionProps(s, (b) => { if (b.has('V7_LAYER')) b.set('V7_LAYER', layerToName(layer)); });
  return { tag: rec.tag, subs: [s, ...rec.subs.slice(1)] };
}
