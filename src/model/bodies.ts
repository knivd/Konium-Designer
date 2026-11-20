/**
 * 3D bodies of footprints and components: Place › 3D Body (extruded, cylinder, sphere), and the
 * Component Body Manager's shapes — per layer the bounding rectangle of its primitives and the
 * closed outlines they draw, then the bounding rectangle on all layers.
 */
import { arcPoints, type Vec2 } from '../core/geom';
import { formatAltiumLength, mm } from '../core/units';
import { encodeBody, layerToName } from '../formats/altium/pcbdoc';
import { editRegionProps } from '../formats/altium/pcbTransform';
import type { PcbRawRecord } from '../formats/altium/framing';
import type { Change } from '../core/undo';
import { L, layerName, tabOrder, type LayerId } from './layers';
import { replaceRecords } from './pcbEdit';
import type { PcbBody, PcbDocument, PcbPrim } from './pcb';

export type BodyType = 'extruded' | 'cylinder' | 'sphere' | 'generic';
export interface BodySpec {
  type: BodyType; identifier: string; layer: LayerId; bottom: boolean;
  /** Extruded: from standoff to overall above the board. Cylinder: `height` tall, `radius` round. Sphere: `radius`. Generic: standoff raises the model (Dz). */
  overall: number; standoff: number; radius: number; height: number;
  /** #RRGGBB */ colour: string; opacity: number;
  /** Generic: the STEP model, embedded or linked, and its turn about X, Y and Z (degrees). */
  model?: import('./genericBody').GenericModel; rot?: [number, number, number];
}

export const defaultBody = (overall = mm(1)): BodySpec => ({
  type: 'extruded', identifier: '', layer: L.MECH1, bottom: false, overall, standoff: 0, radius: mm(1), height: overall, colour: '#808080', opacity: 1,
});

const colorRef = (hex: string): number => { const n = parseInt(hex.replace('#', ''), 16) || 0; return ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16); };
export const hexOfColorRef = (c: number): string => `#${[c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff].map((x) => x.toString(16).padStart(2, '0')).join('')}`;

/** A circle as a body outline (cylinders and spheres are drawn round in 2D). */
export const circleOutline = (c: Vec2, r: number): Vec2[] => arcPoints(c, r, r, 0, 360, 36).slice(0, -1).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));

/**
 * The ComponentBodies6 record for a body over `outline` (cylinder and sphere: the outline is
 * their circle). Cylinders keep MODEL.CYLINDER.RADIUS / HEIGHT (as AD writes them); spheres
 * MODEL.SPHERE.RADIUS [est].
 */
export function bodyRecord(spec: BodySpec, outline: Vec2[], component = 0xffff): PcbRawRecord {
  const len = (v: number) => formatAltiumLength(Math.round(v));
  const base = { component, outline, layer: spec.layer, bottom: spec.bottom, colour: colorRef(spec.colour), opacity: spec.opacity, identifier: spec.identifier };
  switch (spec.type) {
    case 'cylinder':
      return encodeBody({ ...base, standoff: spec.standoff, overall: spec.standoff + spec.height, modelType: 2,
        extra: { 'MODEL.CYLINDER.RADIUS': len(spec.radius), 'MODEL.CYLINDER.HEIGHT': len(spec.height) } });
    case 'sphere':
      return encodeBody({ ...base, standoff: spec.standoff, overall: spec.standoff + 2 * spec.radius, modelType: 3,
        extra: { 'MODEL.SPHERE.RADIUS': len(spec.radius) } });
    default:
      return encodeBody({ ...base, standoff: spec.standoff, overall: spec.overall });
  }
}

/** A body's settings, to edit or to place another like it. */
export function specOf(b: PcbBody): BodySpec {
  const type: BodyType = b.modelType === 2 ? 'cylinder' : b.modelType === 3 ? 'sphere' : 'extruded';
  let r = 0;
  if (type !== 'extruded' && b.outline.length) {
    const cx = b.outline.reduce((a, p) => a + p.x, 0) / b.outline.length, cy = b.outline.reduce((a, p) => a + p.y, 0) / b.outline.length;
    r = Math.max(...b.outline.map((p) => Math.hypot(p.x - cx, p.y - cy)));
  }
  return { type, identifier: b.identifier, layer: b.layer, bottom: b.bottom, overall: b.overall, standoff: b.standoff,
    radius: Math.round(r), height: b.overall - b.standoff, colour: hexOfColorRef(b.colour), opacity: b.opacity };
}

/** Andrew's monotone chain: the convex hull, anticlockwise. */
export function convexHull(pts: Vec2[]): Vec2[] {
  const p = [...new Map(pts.map((v) => [`${v.x},${v.y}`, v])).values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [], upper: Vec2[] = [];
  for (const v of p) { while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, v) <= 0) lower.pop(); lower.push(v); }
  for (const v of [...p].reverse()) { while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, v) <= 0) upper.pop(); upper.push(v); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Points a primitive covers (for hulls and rectangles): track ends and arcs out by half their width, pad and fill corners. */
function extent(p: PcbPrim): Vec2[] {
  const sq = (c: Vec2, r: number) => [{ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y - r }, { x: c.x + r, y: c.y + r }, { x: c.x - r, y: c.y + r }];
  switch (p.kind) {
    case 'track': return [...sq(p.a, p.width / 2), ...sq(p.b, p.width / 2)];
    case 'arc': {
      const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360;
      return arcPoints(p.c, p.r, p.r, p.start, p.start + sweep, Math.max(4, Math.ceil(sweep / 10))).flatMap((v) => sq(v, p.width / 2));
    }
    case 'pad': {
      const w = Math.max(p.top.w, p.bot.w) / 2, h = Math.max(p.top.h, p.bot.h) / 2, a = (p.rotation * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => ({ x: p.at.x + x! * c - y! * s, y: p.at.y + x! * s + y! * c }));
    }
    case 'via': return sq(p.at, p.diameter / 2);
    case 'fill': return [p.a, { x: p.b.x, y: p.a.y }, p.b, { x: p.a.x, y: p.b.y }];
    case 'region': return p.outline;
    default: return [];
  }
}

const rect = (pts: Vec2[]): Vec2[] | null => {
  if (!pts.length) return null;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.round(Math.min(...xs)), x1 = Math.round(Math.max(...xs)), y0 = Math.round(Math.min(...ys)), y1 = Math.round(Math.max(...ys));
  return x1 > x0 && y1 > y0 ? [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] : null;
};

/** A layer as the Component Body Manager names it in a description: "TopLayer", "Mechanical13", "TopOverlay". */
export const layerWord = (l: LayerId): string => layerName(l).replace(/[\s-]/g, '');

/** The area inside an outline (internal units squared). */
export function polygonArea(outline: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < outline.length; i++) { const p = outline[i]!, q = outline[(i + 1) % outline.length]!; a += p.x * q.y - q.x * p.y; }
  return Math.abs(a) / 2;
}

/** The same shape whatever vertex it starts at or the way round it goes. */
export const outlineKey = (outline: Vec2[]): string =>
  outline.map((p) => `${Math.round(p.x / 500)},${Math.round(p.y / 500)}`).sort().join(' ');

/**
 * The closed outlines the tracks and arcs on one layer draw, end joined to end (each corner shared
 * by exactly two of them), full circles, and regions — as polygons [est: how AD finds its shapes].
 */
export function closedOutlines(prims: readonly PcbPrim[]): Vec2[][] {
  const out: Vec2[][] = [];
  type Edge = { a: Vec2; b: Vec2; pts: Vec2[] };
  const edges: Edge[] = [];
  for (const p of prims) {
    if (p.kind === 'track' && (p.a.x !== p.b.x || p.a.y !== p.b.y)) edges.push({ a: p.a, b: p.b, pts: [p.a, p.b] });
    else if (p.kind === 'arc') {
      const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360;
      const pts = arcPoints(p.c, p.r, p.r, p.start, p.start + sweep, Math.max(4, Math.ceil(sweep / 10)));
      if (sweep >= 359.99) out.push(pts.slice(0, -1).map((v) => ({ x: Math.round(v.x), y: Math.round(v.y) })));
      else edges.push({ a: pts[0]!, b: pts.at(-1)!, pts });
    } else if (p.kind === 'region' && p.outline.length >= 3) out.push(p.outline);
  }
  const key = (v: Vec2) => `${Math.round(v.x / 500)},${Math.round(v.y / 500)}`;
  const at = new Map<string, number[]>();
  edges.forEach((e, i) => { for (const k of [key(e.a), key(e.b)]) { const l = at.get(k) ?? []; l.push(i); at.set(k, l); } });
  const used = new Set<number>();
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    // Walk from edge i's end; a loop closes back at its start with every corner of degree two
    const loop: Vec2[] = [...edges[i]!.pts.slice(0, -1)];
    const start = key(edges[i]!.a);
    let cur = edges[i]!.b, prev = i, ok = true;
    const seen = [i];
    while (key(cur) !== start) {
      const here = at.get(key(cur)) ?? [];
      if (here.length !== 2) { ok = false; break; }
      const next = here[0] === prev ? here[1]! : here[0]!;
      if (seen.includes(next)) { ok = false; break; }
      const e = edges[next]!;
      const fwd = key(e.a) === key(cur);
      const pts = fwd ? e.pts : [...e.pts].reverse();
      loop.push(...pts.slice(0, -1));
      cur = fwd ? e.b : e.a; prev = next; seen.push(next);
    }
    if ((at.get(start) ?? []).length !== 2) ok = false;
    for (const e of seen) used.add(e);
    if (ok && seen.length >= 2 && loop.length >= 3) out.push(loop.map((v) => ({ x: Math.round(v.x), y: Math.round(v.y) })));
  }
  return out;
}

export interface BodyCandidate { key: string; description: string; outline: Vec2[]; layer: LayerId | null; kind: 'rect' | 'poly' }

/**
 * The shapes the Component Body Manager offers for a footprint, as AD17 lists them: layer by layer
 * (in the order of the layer tabs) a "Shape created from bounding rectangle on <layer>", then a
 * "Polygonal shape created from primitives on <layer>" for each closed outline drawn there; last
 * the bounding rectangle on All Layers. Text and bodies take no part.
 */
export function bodyCandidates(prims: readonly PcbPrim[]): BodyCandidate[] {
  const use = prims.filter((p) => p.kind !== 'text' && p.kind !== 'body' && 'layer' in p);
  const layers = [...new Set(use.map((p) => (p as { layer: LayerId }).layer))].sort((a, b) => tabOrder(a) - tabOrder(b));
  const out: BodyCandidate[] = [];
  for (const l of layers) {
    const on = use.filter((p) => (p as { layer: LayerId }).layer === l);
    const r = rect(on.flatMap(extent));
    if (r) out.push({ key: `rect:${l}`, description: `Shape created from bounding rectangle on ${layerWord(l)}`, outline: r, layer: l, kind: 'rect' });
    closedOutlines(on).forEach((o, i) => out.push({ key: `poly:${l}:${i}`, description: `Polygonal shape created from primitives on ${layerWord(l)}`, outline: o, layer: l, kind: 'poly' }));
  }
  const all = rect(use.flatMap(extent));
  if (all) out.push({ key: 'rect:all', description: 'Shape created from bounding rectangle on All Layers', outline: all, layer: null, kind: 'rect' });
  return out;
}

/** An existing body as the manager lists it. */
export const bodyDescription = (b: PcbBody): string => `Component Body on ${layerWord(b.layer)}`;

/** A body's 3D settings changed in place (standoff, overall height, projection, registration layer, colour, opacity). */
export interface BodyPatch { standoff?: number; overall?: number; bottom?: boolean; layer?: LayerId; colour?: string; opacity?: number }
export function editBody(doc: PcbDocument, b: PcbBody, patch: BodyPatch): Change | null {
  const rec = doc.streams.get(b.src.storage)?.records[b.src.index];
  if (!rec) return null;
  const subs: Uint8Array[] = rec.subs.map((x) => x.slice());
  const len = (v: number) => formatAltiumLength(Math.round(v));
  if (patch.layer !== undefined) subs[0]![0] = patch.layer <= 82 ? patch.layer : 0;
  subs[0] = editRegionProps(subs[0]!, (bag) => {
    if (patch.layer !== undefined) bag.set('V7_LAYER', layerToName(patch.layer));
    if (patch.standoff !== undefined) { bag.set('STANDOFFHEIGHT', len(patch.standoff)); if (b.modelType === 0) bag.set('MODEL.EXTRUDED.MINZ', len(patch.standoff)); }
    if (patch.overall !== undefined) { bag.set('OVERALLHEIGHT', len(patch.overall)); if (b.modelType === 0) bag.set('MODEL.EXTRUDED.MAXZ', len(patch.overall)); }
    if (patch.bottom !== undefined) bag.set('BODYPROJECTION', patch.bottom ? '1' : '0');
    if (patch.colour !== undefined) bag.set('BODYCOLOR3D', String(colorRef(patch.colour)));
    if (patch.opacity !== undefined) bag.set('BODYOPACITY3D', patch.opacity.toFixed(3));
  });
  return replaceRecords(doc, [{ storage: b.src.storage, index: b.src.index, after: { tag: rec.tag, subs } }]);
}

/**
 * A cross-hatch over a closed outline (how Altium draws a 3D body in 2D): lines at +45° and
 * −45°, `spacing` apart, clipped to the outline.
 */
export function crossHatch(outline: Vec2[], spacing: number): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  if (outline.length < 3 || spacing <= 0) return out;
  for (const deg of [45, -45]) {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    // Into a frame where the hatch runs along x, scan, and back
    const rot = outline.map((p) => ({ x: p.x * c + p.y * sn, y: -p.x * sn + p.y * c }));
    const ys = rot.map((p) => p.y), y0 = Math.min(...ys), y1 = Math.max(...ys);
    for (let y = Math.ceil(y0 / spacing) * spacing; y <= y1; y += spacing) {
      const xs: number[] = [];
      for (let i = 0; i < rot.length; i++) {
        const a = rot[i]!, b = rot[(i + 1) % rot.length]!;
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        if (xs[k + 1]! - xs[k]! < spacing / 100) continue; // a corner just touched
        const back = (x: number): Vec2 => ({ x: x * c - y * sn, y: x * sn + y * c });
        out.push([back(xs[k]!), back(xs[k + 1]!)]);
      }
    }
  }
  return out;
}
