/**
 * The board itself: its shape (Board6 KINDn / VXn … vertices, arcs kept) and its relative
 * origin (ORIGINX / ORIGINY). Edits rewrite the Board6 record, which is saved when changed.
 */
import type { Change } from '../core/undo';
import { flattenVertices, writeVertices } from '../formats/altium/pcbdoc';
import { formatAltiumLength } from '../core/units';
import type { Vec2 } from '../core/geom';
import type { PcbArc, PcbDocument, PcbTrack, PolyVertex } from './pcb';
import { L, fromV7, isMech, mechLayer, mechNumber, type LayerId } from './layers';

function boardChange(doc: PcbDocument, edit: (b: NonNullable<PcbDocument['board']['bag']>) => void, after: (d: PcbDocument) => void): Change {
  const bag = doc.board.bag;
  if (!bag) throw new Error('The board has no Board6 record');
  const before = bag.clone(), next = bag.clone();
  edit(next);
  const was = doc.dirty.has('Board6');
  const prev = { origin: doc.board.origin, vertices: doc.board.vertices, outline: doc.board.outline };
  // The layer names as shown go back too (setLayerNames changes them in place)
  const names = new Map(doc.board.layerNames);
  return {
    apply() { doc.board.bag = next.clone(); after(doc); doc.dirty.add('Board6'); },
    revert() {
      doc.board.bag = before.clone(); Object.assign(doc.board, prev);
      doc.board.layerNames.clear(); for (const [l, n] of names) doc.board.layerNames.set(l, n);
      if (!was) doc.dirty.delete('Board6');
    },
  };
}

/** Edit › Origin › Set / Reset: the relative origin coordinates are measured from. */
export function setOrigin(doc: PcbDocument, p: Vec2): Change {
  const at = { x: Math.round(p.x), y: Math.round(p.y) };
  return boardChange(doc, (b) => { b.set('ORIGINX', formatAltiumLength(at.x)); b.set('ORIGINY', formatAltiumLength(at.y)); }, (d) => { d.board.origin = at; });
}

/** Design › Board Shape: a new shape (no closing copy; arcs as on polygon outlines). */
export function setBoardShape(doc: PcbDocument, vertices: PolyVertex[]): Change {
  if (vertices.length < 3) throw new Error('A board shape needs at least three vertices');
  const verts = vertices.map((v) => ({ p: { x: Math.round(v.p.x), y: Math.round(v.p.y) }, arc: v.arc }));
  // The board's regions follow the new shape (saved with it)
  const was = doc.dirty.has('BoardRegions');
  const c = boardChange(doc, (b) => writeVertices(b, verts), (d) => { d.board.vertices = verts; d.board.outline = flattenVertices(verts); d.dirty.add('BoardRegions'); });
  return { apply: () => c.apply(), revert: () => { c.revert(); if (!was) doc.dirty.delete('BoardRegions'); } };
}

/**
 * Enabled mechanical layers (Board Layers And Colors › Enable). The Board6 record keeps them as
 * LAYER57MECHENABLED … LAYER72MECHENABLED (mechanical 1–16) and, from V8 on, also in the
 * LAYER_V8_i / V9_CACHE_LAYERi entries by 32-bit layer id (0x01020000 + n), which carry 17–32.
 * Null when the record says nothing (Konium then goes by the layers in use).
 */
export function mechEnabled(doc: PcbDocument): Set<LayerId> | null {
  const b = doc.board.bag;
  if (!b) return null;
  const on = new Set<LayerId>();
  let any = false;
  for (let l = L.MECH1; l <= L.MECH16; l++) {
    const v = b.get(`LAYER${l}MECHENABLED`);
    if (v === undefined) continue;
    any = true;
    if (v.toUpperCase() === 'TRUE') on.add(l);
  }
  for (const [, id, v] of mechEntries(b)) {
    any = true;
    const l = mechLayer(id - 0x01020000);
    if (v.toUpperCase() === 'TRUE') on.add(l); else if (l > 1000) on.delete(l);
  }
  return any ? on : null;
}

/** [entry prefix, 32-bit layer id, MECHENABLED] for the V8 / V9 layer entries of mechanical layers. */
function mechEntries(b: NonNullable<PcbDocument['board']['bag']>): [string, number, string][] {
  const out: [string, number, string][] = [];
  for (const k of b.keys()) {
    // (V9 cache keys carry an underscore before the property: V9_CACHE_LAYER69_MECHENABLED; legacy LAYERV7_i hold mechanical 17–32)
    const m = /^(LAYER_V8_\d+|V9_CACHE_LAYER\d+_|LAYERV7_\d+)MECHENABLED$/.exec(k);
    if (!m) continue;
    const id = Number(b.get(`${m[1]}LAYERID`));
    if (id > 0x01020000 && id <= 0x01020000 + 32) out.push([m[1]!, id, b.get(k)!]);
  }
  return out;
}

/** Turn mechanical layers on or off in the Board6 record (all the places it keeps them). */
export function setMechEnabled(doc: PcbDocument, layers: Map<LayerId, boolean>): Change {
  return boardChange(doc, (b) => {
    const entries = mechEntries(b);
    for (const [l, on] of layers) {
      const n = mechNumber(l), v = on ? 'TRUE' : 'FALSE';
      if (n <= 16) b.set(`LAYER${L.MECH1 + n - 1}MECHENABLED`, v);
      for (const [pre, id] of entries) if (id === 0x01020000 + n) b.set(`${pre}MECHENABLED`, v);
    }
  }, () => {});
}

/**
 * Rename layers (mechanical layers in View Configurations): LAYERnNAME for the legacy ids
 * (mechanical 1–16), and the LAYERV7_i / LAYER_V8_i / V9_CACHE_LAYERi entries holding that layer.
 */
export function setLayerNames(doc: PcbDocument, names: Map<LayerId, string>): Change {
  return boardChange(doc, (b) => {
    for (const [l, name] of names) {
      if (l <= 82) b.set(`LAYER${l}NAME`, name);
      for (let i = 0; b.has(`LAYERV7_${i}NAME`); i++) if (fromV7(b.int(`LAYERV7_${i}LAYERID`)) === l) b.set(`LAYERV7_${i}NAME`, name);
      if (isMech(l)) for (const [pre, id] of mechEntries(b)) if (id === 0x01020000 + mechNumber(l) && b.has(`${pre}NAME`)) b.set(`${pre}NAME`, name);
    }
  }, (d) => { for (const [l, name] of names) d.board.layerNames.set(l, name); });
}

/** Board6 edited by hand (drill pairs, layer sets): one undo step. */
export function editBoard(doc: PcbDocument, edit: (b: NonNullable<PcbDocument['board']['bag']>) => void): Change {
  return boardChange(doc, edit, () => {});
}

/** Design › Board Options: Board6 properties set as given (DISPLAYUNIT, ELECTRICALGRID…, SHEET…). */
export function setBoardProps(doc: PcbDocument, kv: Record<string, string>): Change {
  return boardChange(doc, (b) => { for (const [k, v] of Object.entries(kv)) b.set(k, v); }, () => {});
}

/** Move the whole shape (Design › Board Shape › Move Board Shape). */
export function movedShape(vertices: PolyVertex[], d: Vec2): PolyVertex[] {
  return vertices.map((v) => ({ p: { x: v.p.x + d.x, y: v.p.y + d.y }, arc: v.arc && { ...v.arc, c: { x: v.arc.c.x + d.x, y: v.arc.c.y + d.y } } }));
}

const key = (p: Vec2) => `${Math.round(p.x / 1000)},${Math.round(p.y / 1000)}`;
const arcEnd = (a: PcbArc, ang: number): Vec2 => ({ x: a.c.x + a.r * Math.cos((ang * Math.PI) / 180), y: a.c.y + a.r * Math.sin((ang * Math.PI) / 180) });

/**
 * Design › Board Shape › Define from selected objects: tracks and arcs that join end to end
 * into one closed loop (ends within 0.1 mil). Returns the vertices, or why it can't.
 */
export function shapeFromLoop(prims: (PcbTrack | PcbArc)[]): PolyVertex[] | string {
  if (prims.length < 2) return 'Select the tracks and arcs that make a closed outline';
  type Edge = { a: Vec2; b: Vec2; arc?: PcbArc };
  const edges: Edge[] = prims.map((p) => (p.kind === 'track' ? { a: p.a, b: p.b } : { a: arcEnd(p, p.start), b: arcEnd(p, p.end), arc: p }));
  const full = edges.find((e) => e.arc && ((e.arc.end - e.arc.start) % 360 + 360) % 360 === 0);
  if (full) return 'A full circle can’t be part of a board outline';
  const used = new Set<number>();
  const out: PolyVertex[] = [];
  let cur = edges[0]!, from = cur.a;
  used.add(0);
  const startKey = key(from);
  for (;;) {
    const forward = key(cur.a) === key(from);
    const to = forward ? cur.b : cur.a;
    out.push({ p: from, arc: cur.arc ? { c: cur.arc.c, r: cur.arc.r, sa: cur.arc.start, ea: cur.arc.end } : undefined });
    if (key(to) === startKey) break;
    const next = edges.findIndex((e, i) => !used.has(i) && (key(e.a) === key(to) || key(e.b) === key(to)));
    if (next < 0) return 'The selected objects don’t form a closed outline';
    used.add(next);
    cur = edges[next]!; from = to;
  }
  if (used.size !== edges.length) return 'Some selected objects aren’t part of the outline';
  return out;
}

/** Design › Board Shape › Create Primitives From Board Shape: the outline as tracks and arcs. */
export function shapePrimitives(vertices: PolyVertex[]): ({ kind: 'track'; a: Vec2; b: Vec2 } | { kind: 'arc'; c: Vec2; r: number; start: number; end: number })[] {
  return vertices.map((v, i) => {
    const next = vertices[(i + 1) % vertices.length]!.p;
    return v.arc ? { kind: 'arc' as const, c: v.arc.c, r: v.arc.r, start: v.arc.sa, end: v.arc.ea } : { kind: 'track' as const, a: v.p, b: next };
  });
}

/* ─── Mechanical layer types and component layer pairs ──────────────────────────────────── */

/**
 * A mechanical layer's type (Board6 MECHKIND, as the desktop software's View Configuration sets
 * it): the key it writes and its name. The keys seen in the suite's own boards [checked]; Coating,
 * Glue Points and Gold Plating are spelt as the others are [est].
 */
export const MECH_KINDS: [string, string][] = [
  ['', 'Generic'],
  ['AssemblyTop', 'Assembly Top'], ['AssemblyBottom', 'Assembly Bottom'], ['AssemblyNotes', 'Assembly Notes'],
  ['Board', 'Board'], ['BoardShape', 'Board Shape'],
  ['CoatingTop', 'Coating Top'], ['CoatingBottom', 'Coating Bottom'],
  ['ComponentCenterTop', 'Component Centre Top'], ['ComponentCenterBottom', 'Component Centre Bottom'],
  ['ComponentOutlineTop', 'Component Outline Top'], ['ComponentOutlineBottom', 'Component Outline Bottom'],
  ['CourtyardTop', 'Courtyard Top'], ['CourtyardBottom', 'Courtyard Bottom'],
  ['DesignatorTop', 'Designator Top'], ['DesignatorBottom', 'Designator Bottom'],
  ['Dimensions', 'Dimensions'], ['DimensionsTop', 'Dimensions Top'], ['DimensionsBottom', 'Dimensions Bottom'],
  ['FabNotes', 'Fab Notes'],
  ['GluePointsTop', 'Glue Points Top'], ['GluePointsBottom', 'Glue Points Bottom'],
  ['GoldPlatingTop', 'Gold Plating Top'], ['GoldPlatingBottom', 'Gold Plating Bottom'],
  ['RouteToolPath', 'Route Tool Path'], ['Sheet', 'Sheet'],
  ['TentingTop', 'Tenting Top'], ['TentingBottom', 'Tenting Bottom'], ['Filling', 'Filling'], ['Capping', 'Capping'],
  ['ValueTop', 'Value Top'], ['ValueBottom', 'Value Bottom'], ['VCut', 'V-Cut'],
  ['3DBodyTop', '3D Body Top'], ['3DBodyBottom', '3D Body Bottom'],
];
/** A component layer pair's type: its name, and the types its top and bottom layers take. */
export const PAIR_KINDS: [string, string, string][] = [
  ['Assembly', 'AssemblyTop', 'AssemblyBottom'], ['Coating', 'CoatingTop', 'CoatingBottom'], ['Component Centre', 'ComponentCenterTop', 'ComponentCenterBottom'],
  ['Component Outline', 'ComponentOutlineTop', 'ComponentOutlineBottom'], ['Courtyard', 'CourtyardTop', 'CourtyardBottom'], ['Designator', 'DesignatorTop', 'DesignatorBottom'],
  ['Dimensions', 'DimensionsTop', 'DimensionsBottom'], ['Glue Points', 'GluePointsTop', 'GluePointsBottom'], ['Gold Plating', 'GoldPlatingTop', 'GoldPlatingBottom'],
  ['Tenting', 'TentingTop', 'TentingBottom'], ['Value', 'ValueTop', 'ValueBottom'], ['3D Body', '3DBodyTop', '3DBodyBottom'],
];
const MECH_ID = (l: LayerId) => 0x01020000 + mechNumber(l);
/** The Board6 entries (legacy LAYERn, LAYERV7_i, LAYER_V8_i, V9_CACHE_LAYERi_) that hold a mechanical layer: their key prefixes. */
function mechPrefixes(b: NonNullable<PcbDocument['board']['bag']>, l: LayerId): string[] {
  const out: string[] = [];
  if (l <= L.MECH16) out.push(`LAYER${l}`);
  for (const k of b.keys()) {
    const m = /^(LAYER_V8_\d+|V9_CACHE_LAYER\d+_|LAYERV7_\d+)LAYERID$/.exec(k);
    if (m && Number(b.get(k)) === MECH_ID(l)) out.push(m[1]!);
  }
  return out;
}
/** Each mechanical layer's type, by layer (none: Generic). */
export function mechKinds(doc: PcbDocument): Map<LayerId, string> {
  const out = new Map<LayerId, string>();
  const b = doc.board.bag;
  if (!b) return out;
  for (let n = 1; n <= 32; n++) {
    const l = mechLayer(n);
    for (const pre of mechPrefixes(b, l)) { const v = b.get(`${pre}MECHKIND`); if (v) { out.set(l, v); break; } }
  }
  return out;
}
/** The component layer pairs (Board6 MECHPAIRiL1 / L2: MECHANICALn): a part flipped to the other side moves its objects on one to the other. */
export function mechPairs(doc: PcbDocument): [LayerId, LayerId][] {
  const b = doc.board.bag, out: [LayerId, LayerId][] = [];
  if (!b) return out;
  const layerOf = (v: string | undefined) => { const m = /^MECHANICAL(\d+)$/i.exec(v ?? ''); return m ? mechLayer(Number(m[1])) : null; };
  for (let i = 0; b.has(`MECHPAIR${i}L1`); i++) {
    const a = layerOf(b.get(`MECHPAIR${i}L1`)), c = layerOf(b.get(`MECHPAIR${i}L2`));
    if (a !== null && c !== null && a !== c) out.push([a, c]);
  }
  return out;
}
/** Set the mechanical layers' types and the component layer pairs (one step to undo). */
export function setMechLayout(doc: PcbDocument, kinds: Map<LayerId, string>, pairs: [LayerId, LayerId][]): Change {
  return boardChange(doc, (b) => writeMechLayout(b, kinds, pairs), () => {});
}
/** Write mechanical layers' types and the component layer pairs into a Board6 record. */
export function writeMechLayout(b: NonNullable<PcbDocument['board']['bag']>, kinds: Map<LayerId, string>, pairs: [LayerId, LayerId][]): void {
  for (const [l, kind] of kinds) {
    for (const pre of mechPrefixes(b, l)) { if (kind) b.set(`${pre}MECHKIND`, kind); else b.delete(`${pre}MECHKIND`); }
  }
  b.replaceGroup((k) => /^MECHPAIR\d+L[12]$/.test(k), pairs.flatMap(([a, c], i): [string, string][] => [[`MECHPAIR${i}L1`, `MECHANICAL${mechNumber(a)}`], [`MECHPAIR${i}L2`, `MECHANICAL${mechNumber(c)}`]]));
}
/** Mechanical layer types by a board's bag (no document yet: an import's new board). */
export function mechKindsOf(b: NonNullable<PcbDocument['board']['bag']>): Map<LayerId, string> {
  return mechKinds({ board: { bag: b } } as unknown as PcbDocument);
}
