/**
 * Place › Wire Link (26.148): an insulated wire soldered between two pieces of one net's copper on
 * an outer layer, where no track can get from one to the other (one- and two-layer boards). It is
 * a Jumper component (COMPONENTKIND 6, as the file format has them): two round SMD pads of the net
 * sharing Jumper ID 1, so the connectivity joins them (drc.ts joinThroughJumpers: the connection
 * line goes, Un-Routed Net is met), the BOM lists it and both PcbDoc formats keep it. Its path is
 * tracks on a mechanical layer named "Wire Links" (never copper: no copper rule sees it), the 3D
 * view draws it as a wire 1 mm above the board, and the editor no jumper arc for it.
 */
import type { Change } from '../core/undo';
import type { Vec2 } from '../core/geom';
import { UNITS_PER_MM, formatAltiumLength, mil, mm, parseLength } from '../core/units';
import { settings } from '../core/settings';
import { PropertyBag } from '../formats/altium/props';
import type { PcbRawRecord } from '../formats/altium/framing';
import { encodePad, encodeText, encodeTrack } from '../formats/altium/pcbdoc';
import { L, isMech, mechLayer, type LayerId } from './layers';
import { NO_NET, netName, type PcbArc, type PcbDocument, type PcbPad, type PcbPrim, type PcbTrack } from './pcb';
import { addObjects, freshRecord } from './pcbEdit';
import { mechEnabled, setLayerNames, setMechEnabled } from './pcbBoard';
import { bagDefaults } from './bagDefaults';
import { boardIndex, distance, type Geom } from './drc';

/** Its footprint name (Components6 PATTERN): how a wire link is known among the Jumper components. */
export const WIRE_LINK_PATTERN = 'WIRE-LINK';
/** The mechanical layer its path goes on, by name. */
export const WIRE_LINK_LAYER = 'Wire Links';
export const WIRE_LINK_COMMENT = 'Wire link';
/** The wire's centre above the board surface on its side. */
export const WIRE_LINK_HEIGHT = mm(1);
/** Its pads' Jumper ID. */
export const WIRE_LINK_JUMPER = 1;
/** Preferences › PCB Editor › Interactive Routing › Wire Links: the pads' size and the wire's diameter (1 mm and 0.6 mm unless set). */
export const wireLinkPad = (): number => mm(settings.pcbWireLinkPad > 0 ? settings.pcbWireLinkPad : 1);
export const wireLinkWidth = (): number => mm(settings.pcbWireLinkWidth > 0 ? settings.pcbWireLinkWidth : 0.6);

/* ─── What is on the board ───────────────────────────────────────────────────────────── */

/** A component placed as a wire link (Jumper, footprint WIRE-LINK): the board's own, not a schematic part's. */
export const isWireLinkComponent = (c: { pattern: string; bag: PropertyBag }): boolean => c.bag.int('COMPONENTKIND') === 6 && c.pattern.toUpperCase() === WIRE_LINK_PATTERN;

/** A wire link as the board has it. */
export interface WireLink {
  comp: number;
  /** The copper layer of its pads (Top or Bottom). */
  side: LayerId;
  /** Its pads (primitive indices), pad 1 first, and their centres. */
  pads: number[];
  ends: Vec2[];
  /** Its path: the pieces of its tracks (and arcs, as chords) on the mechanical layer. */
  segs: [Vec2, Vec2][];
  /** The wire's diameter (its tracks' width). */
  width: number;
  net: number;
  /** The mechanical layer its path is drawn on. */
  layer: LayerId;
}

const arcPts = (a: PcbArc): Vec2[] => {
  const sweep = ((a.end - a.start) % 360 + 360) % 360 || 360, n = Math.max(2, Math.ceil(sweep / 10));
  return Array.from({ length: n + 1 }, (_, k) => { const t = ((a.start + (sweep * k) / n) * Math.PI) / 180; return { x: a.c.x + a.r * Math.cos(t), y: a.c.y + a.r * Math.sin(t) }; });
};

const linkCache = new WeakMap<readonly PcbPrim[], WireLink[]>();
/**
 * The board's wire links: wire link components (a Jumper part's own mechanical outlines aren't a
 * wire) with a path (tracks or arcs on a mechanical layer).
 */
export function wireLinks(doc: PcbDocument): WireLink[] {
  const hit = linkCache.get(doc.prims);
  if (hit) return hit;
  const by = new Map<number, { pads: { i: number; p: PcbPad }[]; segs: [Vec2, Vec2][]; width: number; layer: LayerId }>();
  const of = (c: number) => { let e = by.get(c); if (!e) by.set(c, (e = { pads: [], segs: [], width: 0, layer: L.MECH1 })); return e; };
  const wired = new Set(doc.components.filter(isWireLinkComponent).map((c) => c.index));
  doc.prims.forEach((p, i) => {
    if (!('component' in p) || !wired.has(p.component)) return;
    if (p.kind === 'pad') of(p.component).pads.push({ i, p });
    else if ((p.kind === 'track' || p.kind === 'arc') && isMech(p.layer)) {
      const e = of(p.component);
      if (p.kind === 'track') e.segs.push([p.a, p.b]);
      else { const pts = arcPts(p); for (let k = 1; k < pts.length; k++) e.segs.push([pts[k - 1]!, pts[k]!]); }
      e.width = Math.max(e.width, (p as PcbTrack | PcbArc).width);
      e.layer = p.layer;
    }
  });
  const out: WireLink[] = [];
  for (const [comp, e] of by) {
    if (!e.segs.length) continue;
    const pads = e.pads.sort((a, b) => a.p.name.localeCompare(b.p.name, undefined, { numeric: true }));
    out.push({ comp, side: pads[0]?.p.layer === L.BOTTOM ? L.BOTTOM : L.TOP, pads: pads.map((x) => x.i), ends: pads.map((x) => x.p.at), segs: e.segs, width: e.width || wireLinkWidth(), net: pads[0]?.p.net ?? NO_NET, layer: e.layer });
  }
  linkCache.set(doc.prims, out);
  return out;
}

/** The wire links' pads (primitive indices): the SMD pad rules (neck-down, entry, corner, vias under) leave them be. */
export function wireLinkPads(doc: PcbDocument): Set<number> {
  return new Set(wireLinks(doc).flatMap((w) => w.pads));
}

/** A wire's length: along its path, and down to the board at both ends. */
export function wireLinkLength(path: readonly Vec2[], height = WIRE_LINK_HEIGHT): number {
  let d = 0;
  for (let k = 1; k < path.length; k++) d += Math.hypot(path[k]!.x - path[k - 1]!.x, path[k]!.y - path[k - 1]!.y);
  return d + 2 * height;
}
/** Its Description: "Insulated wire, 23.4 mm" (to 0.1 mm). */
export const wireLinkDescription = (length: number): string => `Insulated wire, ${(Math.round((length / UNITS_PER_MM) * 10) / 10).toFixed(1)} mm`;

/** The next free designator: W1, W2, … */
export function nextWireDesignator(doc: PcbDocument): string {
  const used = new Set(doc.components.map((c) => c.designator.toUpperCase()));
  for (let n = 1; ; n++) if (!used.has(`W${n}`)) return `W${n}`;
}

/**
 * The mechanical layer wire links go on: the one named Wire Links, else the first of Mechanical 1
 * to 16 the board doesn't use (nothing on it, its own name unchanged, not enabled; failing that,
 * one enabled with nothing on it); null when every one is in use. `fresh`: it needs naming.
 */
export function wireLinkLayer(doc: PcbDocument): { layer: LayerId; fresh: boolean } | null {
  for (let n = 1; n <= 32; n++) if (doc.board.layerNames.get(mechLayer(n))?.trim().toLowerCase() === WIRE_LINK_LAYER.toLowerCase()) return { layer: mechLayer(n), fresh: false };
  const busy = new Set<LayerId>();
  for (const p of doc.prims) if ('layer' in p) busy.add(p.layer);
  for (const d of doc.dimensions ?? []) busy.add(d.layer);
  const enabled = mechEnabled(doc) ?? new Set<LayerId>();
  const free = (n: number) => { const l = mechLayer(n), nm = doc.board.layerNames.get(l); return !busy.has(l) && (!nm || nm.trim() === `Mechanical ${n}`); };
  for (let n = 1; n <= 16; n++) if (free(n) && !enabled.has(mechLayer(n))) return { layer: mechLayer(n), fresh: true };
  for (let n = 1; n <= 16; n++) if (free(n)) return { layer: mechLayer(n), fresh: true };
  return null;
}
export const NO_WIRE_LAYER = 'No mechanical layer is free for wire links: name one Wire Links, or clear one of Mechanical 1 to 16';

/* ─── Copper under the cursor ────────────────────────────────────────────────────────── */

/** Copper a wire link can end on: where it snaps to, its layer and net, the primitive and its kind. */
export interface CopperHit { at: Vec2; layer: LayerId; net: number; prim: number; kind: PcbPrim['kind'] }

const RANK: Record<string, number> = { pad: 0, via: 1, track: 2, arc: 2, fill: 3, region: 4 };
function snapOnto(q: PcbPrim, p: Vec2): Vec2 {
  if (q.kind === 'pad' || q.kind === 'via') return q.at;
  if (q.kind === 'track') {
    const dx = q.b.x - q.a.x, dy = q.b.y - q.a.y, l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - q.a.x) * dx + (p.y - q.a.y) * dy) / l2)) : 0;
    return { x: Math.round(q.a.x + t * dx), y: Math.round(q.a.y + t * dy) };
  }
  if (q.kind === 'arc') {
    const sweep = ((q.end - q.start) % 360 + 360) % 360 || 360;
    let a = (Math.atan2(p.y - q.c.y, p.x - q.c.x) * 180) / Math.PI;
    const off = ((a - q.start) % 360 + 360) % 360;
    if (off > sweep) a = off - sweep < 360 - off ? q.start + sweep : q.start;
    const t = (a * Math.PI) / 180;
    return { x: Math.round(q.c.x + q.r * Math.cos(t)), y: Math.round(q.c.y + q.r * Math.sin(t)) };
  }
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * The copper at a point on the outer layers (within `tol`), one per layer: a pad first, then a via,
 * a track or arc, a fill, a region (a pour's too). Snapped to a pad's or via's centre, a track's or
 * arc's centre line, or left where it is on an area.
 */
export function copperAt(doc: PcbDocument, p: Vec2, tol = 0): CopperHit[] {
  const pt: Geom = { t: 'circle', c: p, r: 0 };
  const best = new Map<LayerId, { h: CopperHit; rank: number; d: number }>();
  for (const s of boardIndex(doc).search({ minX: p.x - tol, minY: p.y - tol, maxX: p.x + tol, maxY: p.y + tol })) {
    if (s.role || (s.layer !== L.TOP && s.layer !== L.BOTTOM) || s.ot === 'Text') continue;
    const d = Math.max(0, distance(pt, s.g, tol + 1));
    if (d > tol) continue;
    const q = doc.prims[s.prim]!;
    const rank = RANK[q.kind] ?? 9, cur = best.get(s.layer);
    if (cur && (cur.rank < rank || (cur.rank === rank && cur.d <= d))) continue;
    best.set(s.layer, { h: { at: snapOnto(q, p), layer: s.layer, net: s.net, prim: s.prim, kind: q.kind }, rank, d });
  }
  return [...best.values()].map((b) => b.h);
}

/** Where a wire link starts on what was clicked (copper of a net, on the preferred side where it is on both), or why it can't. */
export function wireStart(hits: CopperHit[], prefer: LayerId): { hit: CopperHit } | { error: string } {
  const on = hits.filter((h) => h.net !== NO_NET);
  if (!hits.length) return { error: 'A wire link starts on copper of a net (a track, pad, via or area) on the top or bottom layer' };
  if (!on.length) return { error: 'This copper has no net: a wire link starts on copper of a net' };
  return { hit: on.find((h) => h.layer === prefer) ?? on.find((h) => h.layer === L.TOP) ?? on[0]! };
}

/** A pad, via, track or arc: what a wire is soldered to (an area of another net is only passed over). */
const isTarget = (h: CopperHit) => (RANK[h.kind] ?? 9) <= 2;

/**
 * What a click with a wire link under way is: its end (copper of its net on its side), a refusal
 * (a pad, via, track or arc of another net on its side, or of its net on the other side), or a
 * bend (null: nothing there, or an area it passes over: another net's pour, the other side's).
 */
export function wireEnd(doc: PcbDocument, start: CopperHit, hits: CopperHit[]): { end: CopperHit } | { error: string } | null {
  const label = (l: LayerId) => doc.board.layerNames.get(l) ?? (l === L.BOTTOM ? 'Bottom Layer' : 'Top Layer');
  const same = hits.find((h) => h.layer === start.layer);
  if (same && same.net === start.net) return { end: same };
  if (same && isTarget(same)) return { error: `A wire link joins copper of one net: this is ${netName(doc, same.net)}, the start is ${netName(doc, start.net)}` };
  const other = hits.find((h) => h.layer !== start.layer && h.net === start.net && isTarget(h));
  if (other) return { error: `A wire link ends on the side of the board it starts on: this copper is on ${label(other.layer)}, the start on ${label(start.layer)}` };
  return null;
}

/* ─── Placing one ────────────────────────────────────────────────────────────────────── */

export interface WireLinkSpec {
  /** From the start (on copper) through the bends to the end (on copper), board units. */
  path: Vec2[];
  /** Top or Bottom. */
  layer: LayerId;
  net: number;
  /** The wire's diameter and the pads' size (the preferences' when absent). */
  width?: number;
  pad?: number;
}

/** Changes made one after the other on apply (each sees the ones before), undone in reverse. */
function inTurn(make: (() => Change)[]): Change {
  let made: Change[] | null = null;
  return {
    apply() {
      if (made) { for (const c of made) c.apply(); return; }
      made = [];
      for (const m of make) { const c = m(); c.apply(); made.push(c); }
    },
    revert() { for (const c of [...(made ?? [])].reverse()) c.revert(); },
  };
}

/**
 * The wire link as one change: a free component W<n> (no library) of kind Jumper, footprint
 * WIRE-LINK, Comment "Wire link", Description "Insulated wire, <length> mm", on the side of its
 * ends; its two round SMD pads (1 at the start, 2 at the end) of the net with Jumper ID 1; its
 * path as tracks on the Wire Links mechanical layer (named and enabled the first time); its
 * designator there too, mid-way along the wire, and its comment hidden. Throws when no
 * mechanical layer is free.
 */
export function placeWireLink(doc: PcbDocument, spec: WireLinkSpec): { change: Change; designator: string; length: number } {
  const path = spec.path.filter((q, k) => k === 0 || q.x !== spec.path[k - 1]!.x || q.y !== spec.path[k - 1]!.y);
  if (path.length < 2) throw new Error('A wire link needs a start and an end apart');
  const ml = wireLinkLayer(doc);
  if (!ml) throw new Error(NO_WIRE_LAYER);
  const bottom = spec.layer === L.BOTTOM, side = bottom ? L.BOTTOM : L.TOP;
  const width = spec.width ?? wireLinkWidth(), pad = spec.pad ?? wireLinkPad();
  const designator = nextWireDesignator(doc), length = wireLinkLength(path), description = wireLinkDescription(length);
  const at = path[0]!, end = path.at(-1)!;
  const len = formatAltiumLength;
  const bag = PropertyBag.from({
    SELECTION: 'FALSE', LAYER: bottom ? 'BOTTOM' : 'TOP', LOCKED: 'FALSE', POLYGONOUTLINE: 'FALSE', USERROUTED: 'TRUE', KEEPOUT: 'FALSE', UNIONINDEX: '0', PRIMITIVELOCK: 'TRUE',
    X: len(at.x), Y: len(at.y), PATTERN: WIRE_LINK_PATTERN, NAMEON: 'TRUE', COMMENTON: 'FALSE', GROUPNUM: '0', COUNT: '0',
    ROTATION: ' 0.00000000000000E+0000', HEIGHT: len(WIRE_LINK_HEIGHT + Math.round(width / 2)), NAMEAUTOPOSITION: '0', COMMENTAUTOPOSITION: '0',
    SOURCEDESIGNATOR: designator, SOURCEUNIQUEID: '', SOURCEHIERARCHICALPATH: '', SOURCEFOOTPRINTLIBRARY: '', SOURCECOMPONENTLIBRARY: '', SOURCELIBREFERENCE: '',
    SOURCEDESCRIPTION: description, FOOTPRINTDESCRIPTION: description, COMMENT: WIRE_LINK_COMMENT, COMPONENTKIND: '6', CHANNELOFFSET: '-1',
  });
  const records: { storage: string; rec: PcbRawRecord }[] = [];
  for (const [name, p] of [['1', at], ['2', end]] as const) records.push({ storage: 'Pads6', rec: encodePad({ name, layer: side, at: p, w: pad, h: pad, shape: 'round', net: spec.net, component: 0, jumper: WIRE_LINK_JUMPER }) });
  for (let k = 1; k < path.length; k++) records.push({ storage: 'Tracks6', rec: freshRecord(doc, 'Tracks6', (tpl) => encodeTrack({ layer: ml.layer, a: path[k - 1]!, b: path[k]!, width, component: 0 }, tpl)) });
  // The designator mid-way along the wire, just clear of it; the comment with it, hidden
  const cd = bagDefaults('Component'), sz = (v: string | undefined, d: number) => { const c = parseLength(v); return c && c > 0 ? Math.round(c) : d; };
  const mid = midway(path), h = sz(cd.DESIGNATORHEIGHT, mil(60)), w = sz(cd.DESIGNATORWIDTH, mil(10));
  const tAt = { x: mid.x + width, y: mid.y + width };
  records.push({ storage: 'Texts6', rec: encodeText({ layer: ml.layer, at: tAt, height: h, strokeWidth: w, text: designator, component: 0, isDesignator: true, mirrored: bottom }) });
  records.push({ storage: 'Texts6', rec: encodeText({ layer: ml.layer, at: tAt, height: sz(cd.COMMENTHEIGHT, mil(60)), strokeWidth: sz(cd.COMMENTWIDTH, mil(10)), text: WIRE_LINK_COMMENT, component: 0, isComment: true, mirrored: bottom }) });
  const steps: (() => Change)[] = [];
  if (doc.board.bag) {
    if (ml.fresh) steps.push(() => setLayerNames(doc, new Map([[ml.layer, WIRE_LINK_LAYER]])));
    const en = mechEnabled(doc);
    if (!en?.has(ml.layer)) {
      // A board that says nothing of them goes by the layers in use: those stay on beside it
      const on = new Map<LayerId, boolean>([[ml.layer, true]]);
      if (!en) for (const p of doc.prims) if ('layer' in p && isMech(p.layer)) on.set(p.layer, true);
      steps.push(() => setMechEnabled(doc, on));
    }
  }
  steps.push(() => addObjects(doc, { records: [], components: [{ bag, records }], polygons: [] }));
  return { change: inTurn(steps), designator, length };
}

/** The point half-way along a path. */
function midway(path: Vec2[]): Vec2 {
  let left = wireLinkLength(path, 0) / 2;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1]!, b = path[k]!, d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d >= left && d > 0) return { x: Math.round(a.x + ((b.x - a.x) * left) / d), y: Math.round(a.y + ((b.y - a.y) * left) / d) };
    left -= d;
  }
  return path.at(-1)!;
}
