import { pushAll } from '../core/lists';
import { withRecordUnion } from '../formats/altium/unions';
import { carryPrimInfo } from '../formats/altium/primInfo';
import { primDefault } from './pcbDefaults';
/** The same primitive, rewritten: it keeps its mask expansions and unique ID. */
const kept = (from: PcbRawRecord, to: PcbRawRecord): PcbRawRecord => { carryPrimInfo(from, to); return to; };
import type { Change } from '../core/undo';
import { componentFromBag, encodeArc, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, polygonFromBag, rebuildPrims, type PadFields, type TrackFields } from '../formats/altium/pcbdoc';
import { PCB_TAG } from '../formats/altium/framing';
import { ARC, FILL, PAD, REGION, TEXT, TRACK, VIA, get, put, type Field } from '../formats/altium/pcbLayouts';
import { PropertyBag } from '../formats/altium/props';
import { computePour } from './pour';
import { altiumFloat, placement, transformRecord } from '../formats/altium/pcbTransform';
import { mechPairs } from './pcbBoard';
import { formatAltiumLength } from '../core/units';
import { hexToRgb, settings } from '../core/settings';
import type { PcbRawRecord } from '../formats/altium/framing';
import type { PcbRule } from '../formats/altium/rules';
import { L, type LayerId } from './layers';
import type { PcbDocument, PcbPrim } from './pcb';
import type { Vec2 } from '../core/geom';

/**
 * PCB edits mutate raw records in their storage (the save-time source of truth), mark the
 * storage dirty and re-derive primitives. Untouched storages are written back verbatim.
 */

/**
 * A storage's records. Changes look their arrays up when they apply or revert, never keep them:
 * a change that replaces an array (a delete, a repour) makes another one on redo.
 */
function stream(doc: PcbDocument, storage: string): PcbRawRecord[] {
  let s = doc.streams.get(storage);
  if (!s) { s = { storage, records: [] }; doc.streams.set(storage, s); }
  return s.records;
}

export function addTracks(doc: PcbDocument, tracks: TrackFields[], keepout = false): Change {
  // As free tracks: the file's first as the template, unlocked, in no union or pour; keepout as asked
  const added = tracks.map((t) => { const r = freshRecord(doc, 'Tracks6', (tpl) => encodeTrack(t, tpl)); if (keepout) put(r.subs[0]!, TRACK.flags2, 2); return r; });
  const wasDirty = doc.dirty.has('Tracks6');
  return {
    apply() { pushAll(stream(doc, 'Tracks6'), added); doc.dirty.add('Tracks6'); rebuildPrims(doc); },
    revert() { const recs = stream(doc, 'Tracks6'); recs.splice(recs.length - added.length, added.length); if (!wasDirty) doc.dirty.delete('Tracks6'); rebuildPrims(doc); },
  };
}

export function addPads(doc: PcbDocument, pads: PadFields[], template?: PcbRawRecord): Change {
  const added = pads.map((p) => { const r = encodePad(p, template); if (template) carryPrimInfo(template, r); return r; });
  const wasDirty = doc.dirty.has('Pads6');
  return {
    apply() { pushAll(stream(doc, 'Pads6'), added); doc.dirty.add('Pads6'); rebuildPrims(doc); },
    revert() { const recs = stream(doc, 'Pads6'); recs.splice(recs.length - added.length, added.length); if (!wasDirty) doc.dirty.delete('Pads6'); rebuildPrims(doc); },
  };
}

export interface ViaFields { at: Vec2; diameter: number; hole: number; net?: number; layerStart?: LayerId; layerEnd?: LayerId }

export function addVias(doc: PcbDocument, vias: ViaFields[]): Change {
  const template = stream(doc, 'Vias6')[0];
  const added = vias.map((v) => encodeVia(v, template));
  const wasDirty = doc.dirty.has('Vias6');
  return {
    apply() { pushAll(stream(doc, 'Vias6'), added); doc.dirty.add('Vias6'); rebuildPrims(doc); },
    revert() { const recs = stream(doc, 'Vias6'); recs.splice(recs.length - added.length, added.length); if (!wasDirty) doc.dirty.delete('Vias6'); rebuildPrims(doc); },
  };
}

/** Replace the board's design rules (Design › Rules… OK / Apply). Rules6 is rewritten on save. */
export function replaceRules(doc: PcbDocument, rules: PcbRule[]): Change {
  const before = doc.rules, inFile = doc.rulesInFile, wasDirty = doc.dirty.has('Rules6');
  return {
    apply() { doc.rules = rules; doc.rulesInFile = true; doc.dirty.add('Rules6'); },
    revert() { doc.rules = before; doc.rulesInFile = inFile; if (!wasDirty) doc.dirty.delete('Rules6'); },
  };
}

/**
 * Move a component by d and turn it by rot degrees about its reference point: every
 * primitive it owns (pads, silkscreen, designator and comment …), its 3D bodies and its
 * Components6 X, Y, ROTATION. Mirrored (X / Y while moving) it is reflected on the same side;
 * flipped (L) it is reflected onto the other side of the board.
 *
 * Altium stores a bottom-side part as its footprint reflected top-to-bottom, then turned by
 * ROTATION; a left–right reflection after turning by r is that form turned by 180 − r.
 */
export function moveComponent(doc: PcbDocument, index: number, d: Vec2, rot: number, o: { mirror?: boolean; flip?: boolean } = {}): Change {
  const m = componentMove(doc, index, d, rot, o);
  return { apply() { m.apply(); rebuildPrims(doc); }, revert() { m.revert(); rebuildPrims(doc); } };
}

/** Many components moved, each its own way, as one change (the board's primitives made up again once, not once for each). */
export function moveComponentsEach(doc: PcbDocument, moves: { index: number; d: Vec2; rot: number; mirror?: boolean; flip?: boolean }[]): Change {
  const each = moves.map((m) => componentMove(doc, m.index, m.d, m.rot, { mirror: m.mirror, flip: m.flip }));
  return {
    apply() { for (const m of each) m.apply(); rebuildPrims(doc); },
    revert() { for (const m of [...each].reverse()) m.revert(); rebuildPrims(doc); },
  };
}

/** One component's move, without making the board's primitives up again. */
function componentMove(doc: PcbDocument, index: number, d: Vec2, rot: number, o: { mirror?: boolean; flip?: boolean } = {}): { apply(): void; revert(): void } {
  const comp = doc.components[index];
  if (!comp) throw new Error(`no component ${index}`);
  const map = placement(comp.at, rot, d, o.mirror);
  // (flipped: objects on a component layer pair's mechanical layer go to its partner)
  const pairs = o.flip ? mechPairs(doc) : undefined;
  const edits: { st: string; i: number; before: PcbRawRecord; after: PcbRawRecord }[] = [];
  const storages = new Set<string>(['Components6']);
  for (const p of doc.prims) {
    if (!('component' in p) || p.component !== index || p.kind === 'body') continue; // bodies follow below, by record
    const recs = doc.streams.get(p.src.storage)?.records;
    const before = recs?.[p.src.index];
    if (!recs || !before) continue;
    edits.push({ st: p.src.storage, i: p.src.index, before, after: kept(before, transformRecord(before, map, rot, { ...o, storage: p.src.storage, pairs })) });
    storages.add(p.src.storage);
  }
  const bodies = doc.streams.get('ComponentBodies6')?.records;
  bodies?.forEach((before, i) => {
    if (bodyComponent(before) !== index) return;
    edits.push({ st: 'ComponentBodies6', i, before, after: kept(before, transformRecord(before, map, rot, { ...o, pairs })) });
    storages.add('ComponentBodies6');
  });
  const was = new Set([...storages].filter((st) => doc.dirty.has(st)));
  const bag = comp.bag, oldBag = bag.clone();
  const newBag = bag.clone();
  newBag.set('X', formatAltiumLength(comp.at.x + d.x));
  newBag.set('Y', formatAltiumLength(comp.at.y + d.y));
  const r = o.mirror ? 180 + rot - comp.rotation : comp.rotation + rot;
  newBag.set('ROTATION', altiumFloat(((r % 360) + 360) % 360));
  if (o.flip) newBag.set('LAYER', comp.layer === L.BOTTOM ? 'TOP' : 'BOTTOM');
  const setBag = (b: typeof bag) => { doc.components[index] = componentFromBag(b, index); };
  return {
    apply() { for (const e of edits) stream(doc, e.st)[e.i] = e.after; setBag(newBag.clone()); for (const st of storages) doc.dirty.add(st); },
    revert() { for (const e of edits) stream(doc, e.st)[e.i] = e.before; setBag(oldBag.clone()); for (const st of storages) if (!was.has(st)) doc.dirty.delete(st); },
  };
}

/** The component a ComponentBodies6 record belongs to (u16 at offset 7, as other primitives). */
export function bodyComponent(rec: PcbRawRecord): number | undefined {
  const s = rec.subs[0];
  return s && s.length >= 9 ? s[7]! | (s[8]! << 8) : undefined;
}

/**
 * Remove primitives. Components and polygons own primitives by the owner's index, not the
 * primitive's, so nothing else needs renumbering. Copper poured by a polygon is left where it is:
 * it goes with its pour (removePolygons, explodePolygons) or at the next repour.
 */
export function removePrims(doc: PcbDocument, prims: PcbPrim[]): Change {
  const byStorage = new Map<string, Set<number>>();
  for (const p of prims) {
    if ('polygon' in p && p.polygon !== 0xffff) continue;
    let s = byStorage.get(p.src.storage);
    if (!s) byStorage.set(p.src.storage, (s = new Set()));
    s.add(p.src.index);
  }
  const snapshots = new Map<string, PcbRawRecord[]>();
  const wasDirty = new Set(doc.dirty);
  return {
    apply() {
      for (const [storage, idx] of byStorage) {
        const s = doc.streams.get(storage);
        if (!s) continue;
        snapshots.set(storage, s.records);
        s.records = s.records.filter((_, i) => !idx.has(i));
        doc.dirty.add(storage);
      }
      rebuildPrims(doc);
    },
    revert() {
      for (const [storage, recs] of snapshots) {
        doc.streams.get(storage)!.records = recs;
        if (!wasDirty.has(storage)) doc.dirty.delete(storage);
      }
      rebuildPrims(doc);
    },
  };
}

/* ─── Ownership: components and polygons own primitives by index ─────────────────────── */

type OwnField = 'component' | 'polygon';
const OWN: Record<number, { sub: number; component?: Field; polygon?: Field }> = {
  [PCB_TAG.TRACK]: { sub: 0, component: TRACK.component, polygon: TRACK.polygon },
  [PCB_TAG.ARC]: { sub: 0, component: ARC.component, polygon: ARC.polygon },
  [PCB_TAG.FILL]: { sub: 0, component: FILL.component },
  [PCB_TAG.TEXT]: { sub: 0, component: TEXT.component },
  [PCB_TAG.REGION]: { sub: 0, component: REGION.component, polygon: REGION.polygon },
  [PCB_TAG.PAD]: { sub: 4, component: PAD.component },
  // A footprint's own vias (thermal vias under a part) go where their part goes
  [PCB_TAG.VIA]: { sub: 0, component: VIA.component },
  [PCB_TAG.MODEL]: { sub: 0, component: { off: 7, t: 'u16' } },
};

export function ownerOf(rec: PcbRawRecord, field: OwnField): number {
  const o = OWN[rec.tag];
  const f = o?.[field];
  const s = o ? rec.subs[o.sub] : undefined;
  return f && s ? get(s, f) ?? 0xffff : 0xffff;
}

/**
 * Remove owners (components or polygons) by index, with every record they own, and renumber
 * the owner index in all other records so nothing points at the wrong owner afterwards.
 */
function removeOwners(doc: PcbDocument, field: OwnField, indices: number[], text: { storage: string; list: () => unknown[]; rebuild: () => void },
  /** Explode: what an owned record becomes (null drops it); deleting drops them all. */
  free?: (rec: PcbRawRecord, storage: string, index: number) => PcbRawRecord | null): Change {
  const kill = new Set(indices);
  const shift = (i: number) => { let n = 0; for (const k of kill) if (k < i) n++; return i - n; };
  let snap: Map<string, PcbRawRecord[]> = new Map();
  let listSnap: unknown[] = [];
  const wasDirty = new Set(doc.dirty);
  return {
    apply() {
      snap = new Map();
      // An index past the list's end is no owner's: 0xFFFF (none), and 0xFFFE, the mark the board's own
      // plane-edge tracks and arcs carry in the polygon field. Such a record is left exactly as it is.
      const owners = text.list().length;
      for (const [storage, s] of doc.streams) {
        let touched = false;
        const out: PcbRawRecord[] = [];
        for (const [i, rec] of s.records.entries()) {
          const o = ownerOf(rec, field);
          if (o >= owners) { out.push(rec); continue; }
          if (kill.has(o)) { touched = true; const f = free?.(rec, storage, i); if (f) out.push(kept(rec, f)); continue; }
          const n = shift(o);
          if (n !== o) {
            const sub = OWN[rec.tag]!.sub;
            const subs = rec.subs.map((x, k) => (k === sub ? x.slice() : x));
            put(subs[sub]!, OWN[rec.tag]![field]!, n);
            out.push(kept(rec, { tag: rec.tag, subs }));
            touched = true;
          } else out.push(rec);
        }
        if (touched) { snap.set(storage, s.records); s.records = out; doc.dirty.add(storage); }
      }
      const list = text.list();
      listSnap = list.slice();
      for (const i of [...kill].sort((a, b) => b - a)) list.splice(i, 1);
      text.rebuild();
      doc.dirty.add(text.storage);
      rebuildPrims(doc);
    },
    revert() {
      for (const [storage, recs] of snap) doc.streams.get(storage)!.records = recs;
      const list = text.list();
      list.splice(0, list.length, ...listSnap);
      text.rebuild();
      for (const d of [...doc.dirty]) if (!wasDirty.has(d)) doc.dirty.delete(d);
      rebuildPrims(doc);
    },
  };
}

/** Delete components: their Components6 records, owned primitives and 3D bodies. */
export function removeComponents(doc: PcbDocument, indices: number[]): Change {
  return removeOwners(doc, 'component', indices, {
    storage: 'Components6', list: () => doc.components,
    rebuild: () => { doc.components.forEach((c, i) => { doc.components[i] = componentFromBag(c.bag, i); }); },
  });
}

/**
 * Tools › Convert › Explode Component to Free Primitives: what the components own becomes free
 * (3D bodies too); their designator and comment become free strings (hidden ones go).
 */
export function explodeComponents(doc: PcbDocument, indices: number[]): Change {
  const shown = new Map<string, PcbRawRecord | null>();
  for (const p of doc.prims) {
    if (p.kind !== 'text' || !(p.isDesignator || p.isComment) || !indices.includes(p.component)) continue;
    const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
    if (!rec) continue;
    shown.set(`${p.src.storage}:${p.src.index}`, p.hidden ? null : encodeText({ layer: p.layer, at: p.at, height: p.height, text: p.text, rotation: p.rotation, strokeWidth: p.strokeWidth, mirrored: p.mirrored, component: 0xffff }, rec, true));
  }
  // By where they are (the records themselves may be made anew by an earlier step redone)
  return removeOwners(doc, 'component', indices, {
    storage: 'Components6', list: () => doc.components,
    rebuild: () => { doc.components.forEach((c, i) => { doc.components[i] = componentFromBag(c.bag, i); }); },
  }, (rec, storage, i) => { const k = `${storage}:${i}`; return shown.has(k) ? shown.get(k)! : retarget(rec, { component: 0xffff }); });
}

/** Explode Polygon to Free Primitives: the pour's copper stays as free regions and tracks, the pour goes. */
export function explodePolygons(doc: PcbDocument, indices: number[]): Change {
  return removeOwners(doc, 'polygon', indices, {
    storage: 'Polygons6', list: () => doc.polygons,
    rebuild: () => { doc.polygons.forEach((p, i) => { doc.polygons[i] = polygonFromBag(p.bag, i); }); },
  }, (rec) => retarget(rec, { polygon: 0xffff }));
}

/** Delete polygon pours: their Polygons6 records and poured copper. */
export function removePolygons(doc: PcbDocument, indices: number[]): Change {
  return removeOwners(doc, 'polygon', indices, {
    storage: 'Polygons6', list: () => doc.polygons,
    rebuild: () => { doc.polygons.forEach((p, i) => { doc.polygons[i] = polygonFromBag(p.bag, i); }); },
  });
}

/* ─── Polygon pours ──────────────────────────────────────────────────────────────────── */

/** Add a polygon definition (its copper comes from repour()). */
export function addPolygon(doc: PcbDocument, bag: PropertyBag): Change {
  const was = doc.dirty.has('Polygons6');
  return {
    apply() { doc.polygons.push(polygonFromBag(bag, doc.polygons.length)); doc.dirty.add('Polygons6'); },
    revert() { doc.polygons.pop(); if (!was) doc.dirty.delete('Polygons6'); },
  };
}

/** Replace a polygon's definition (outline, net, layer, fill settings). */
export function setPolygon(doc: PcbDocument, index: number, bag: PropertyBag): Change {
  const before = doc.polygons[index]!.bag;
  const was = doc.dirty.has('Polygons6');
  return {
    apply() { doc.polygons[index] = polygonFromBag(bag, index); doc.dirty.add('Polygons6'); },
    revert() { doc.polygons[index] = polygonFromBag(before, index); if (!was) doc.dirty.delete('Polygons6'); },
  };
}

/** Repour: replace the polygon's copper with freshly computed copper. */
export function repour(doc: PcbDocument, index: number): Change {
  const poly = doc.polygons[index];
  if (!poly) throw new Error(`no polygon ${index}`);
  const result = computePour(doc, poly);
  const regions = result.regions.map((r) => encodeRegion({ layer: poly.layer, net: poly.net === 0xffff ? undefined : poly.net, polygon: index, outline: r.outline, holes: r.holes }));
  const tracks = result.tracks.map((t) => encodeTrack({ layer: poly.layer, a: t.a, b: t.b, width: t.width, net: poly.net === 0xffff ? undefined : poly.net, polygon: index }));
  let snap = new Map<string, PcbRawRecord[]>();
  const wasDirty = new Set(doc.dirty);
  return {
    apply() {
      snap = new Map();
      for (const st of ['Regions6', 'ShapeBasedRegions6', 'Tracks6', 'Arcs6']) {
        const s = doc.streams.get(st);
        if (!s) continue;
        const keep = s.records.filter((r) => ownerOf(r, 'polygon') !== index);
        if (keep.length !== s.records.length) { snap.set(st, s.records); s.records = keep; doc.dirty.add(st); }
      }
      if (regions.length) { const r = stream(doc, 'Regions6'); if (!snap.has('Regions6')) snap.set('Regions6', r.slice()); pushAll(r, regions); doc.dirty.add('Regions6'); }
      if (tracks.length) { const r = stream(doc, 'Tracks6'); if (!snap.has('Tracks6')) snap.set('Tracks6', r.slice()); pushAll(r, tracks); doc.dirty.add('Tracks6'); }
      rebuildPrims(doc);
    },
    revert() {
      for (const [st, recs] of snap) doc.streams.get(st)!.records = recs;
      for (const d of [...doc.dirty]) if (!wasDirty.has(d)) doc.dirty.delete(d);
      rebuildPrims(doc);
    },
  };
}

/** Replace records in place (moves, property edits): one undo step. */
export function replaceRecords(doc: PcbDocument, edits: { storage: string; index: number; after: PcbRawRecord }[], extra?: Change): Change {
  const befores = edits.map((e) => doc.streams.get(e.storage)!.records[e.index]!);
  const wasDirty = new Set(doc.dirty);
  return {
    apply() { edits.forEach((e, k) => { carryPrimInfo(befores[k]!, e.after); doc.streams.get(e.storage)!.records[e.index] = e.after; doc.dirty.add(e.storage); }); extra?.apply(); rebuildPrims(doc); },
    revert() { extra?.revert(); edits.forEach((e, k) => { doc.streams.get(e.storage)!.records[e.index] = befores[k]!; }); for (const d of [...doc.dirty]) if (!wasDirty.has(d)) doc.dirty.delete(d); rebuildPrims(doc); },
  };
}

/** Change Components6 properties of one component (Locked, Show Designator / Comment …). */
export function setComponentProps(doc: PcbDocument, index: number, props: Record<string, string>): Change {
  const before = doc.components[index]!.bag;
  const after = before.clone();
  for (const [k, v] of Object.entries(props)) after.set(k, v);
  const was = doc.dirty.has('Components6');
  return {
    apply() { doc.components[index] = componentFromBag(after.clone(), index); doc.dirty.add('Components6'); rebuildPrims(doc); },
    revert() { doc.components[index] = componentFromBag(before, index); if (!was) doc.dirty.delete('Components6'); rebuildPrims(doc); },
  };
}

/* ─── Paste ───────────────────────────────────────────────────────────────────────────── */

const NET_FIELD: Record<number, { sub: number; f: Field }> = {
  [PCB_TAG.TRACK]: { sub: 0, f: TRACK.net }, [PCB_TAG.ARC]: { sub: 0, f: ARC.net }, [PCB_TAG.VIA]: { sub: 0, f: VIA.net },
  [PCB_TAG.FILL]: { sub: 0, f: FILL.net }, [PCB_TAG.REGION]: { sub: 0, f: REGION.net }, [PCB_TAG.PAD]: { sub: 4, f: PAD.net },
};

/**
 * Design › Netlist › Clear All Nets: the board's nets go (Nets6 empty) and every object, pours
 * included, is left on No Net; the pours themselves stay.
 */
export function clearAllNets(doc: PcbDocument): Change {
  const wasDirty = new Set(doc.dirty);
  let nets = doc.nets, snap = new Map<string, PcbRawRecord[]>(), bags: PropertyBag[] = [];
  return {
    apply() {
      nets = doc.nets; snap = new Map(); bags = doc.polygons.map((p) => p.bag);
      for (const [storage, s] of doc.streams) {
        if (!s.records.some((r) => NET_FIELD[r.tag])) continue;
        snap.set(storage, s.records);
        s.records = s.records.map((r) => (NET_FIELD[r.tag] ? kept(r, retarget(r, { net: () => 0xffff })) : r));
        doc.dirty.add(storage);
      }
      doc.nets = [];
      doc.dirty.add('Nets6');
      doc.polygons.forEach((p, i) => { const b = p.bag.clone(); b.set('NET', '65535'); doc.polygons[i] = polygonFromBag(b, i); });
      if (doc.polygons.length) doc.dirty.add('Polygons6');
      rebuildPrims(doc);
    },
    revert() {
      for (const [storage, recs] of snap) doc.streams.get(storage)!.records = recs;
      doc.nets = nets;
      doc.polygons.forEach((_, i) => { doc.polygons[i] = polygonFromBag(bags[i]!, i); });
      for (const d of [...doc.dirty]) if (!wasDirty.has(d)) doc.dirty.delete(d);
      rebuildPrims(doc);
    },
  };
}

/** A net's keys set (COLOR, OVERRIDECOLORFORDRAW …), one undo step. */
export function setNetProps(doc: PcbDocument, items: { index: number; props: Record<string, string> }[]): Change {
  const before = items.map(({ index }) => doc.nets[index]!.bag);
  const after = items.map(({ index, props }) => { const b = doc.nets[index]!.bag.clone(); for (const [k, v] of Object.entries(props)) b.set(k, v); return b; });
  const was = doc.dirty.has('Nets6');
  return {
    apply() { items.forEach(({ index }, i) => { doc.nets[index] = { ...doc.nets[index]!, bag: after[i]! }; }); doc.dirty.add('Nets6'); },
    revert() { items.forEach(({ index }, i) => { doc.nets[index] = { ...doc.nets[index]!, bag: before[i]! }; }); if (!was) doc.dirty.delete('Nets6'); },
  };
}

/** A new net's Nets6 record, in View Options › Default Colour for New Nets (AD keeps it as COLOR, a COLORREF). */
export function newNetBag(name: string): PropertyBag {
  const rgb = hexToRgb(settings.pcbNewNetColour);
  const colorref = ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
  return PropertyBag.from({ SELECTION: 'FALSE', LAYER: 'TOP', LOCKED: 'FALSE', POLYGONOUTLINE: 'FALSE', USERROUTED: 'TRUE', KEEPOUT: 'FALSE',
    UNIONINDEX: '0', PRIMITIVELOCK: 'TRUE', NAME: name, VISIBLE: 'TRUE', COLOR: String(colorref), OVERRIDECOLORFORDRAW: 'FALSE' });
}

/** Netlist Manager › Edit: a net's new name. */
/** A new net at the end of Nets6 (as Design › Netlist › Edit Nets › Add, or an ECO's Add Net). */
export function addNet(doc: PcbDocument, name: string): Change {
  const bag = newNetBag(name);
  const was = doc.dirty.has('Nets6');
  return {
    apply() { doc.nets.push({ index: doc.nets.length, name, bag }); doc.dirty.add('Nets6'); },
    revert() { doc.nets.pop(); if (!was) doc.dirty.delete('Nets6'); },
  };
}

export function renameNet(doc: PcbDocument, index: number, name: string): Change {
  const net = doc.nets[index]!, before = net.bag, oldName = net.name, after = net.bag.clone();
  after.set('NAME', name);
  const was = doc.dirty.has('Nets6');
  return {
    apply() { doc.nets[index] = { index, name, bag: after }; doc.dirty.add('Nets6'); },
    revert() { doc.nets[index] = { index, name: oldName, bag: before }; if (!was) doc.dirty.delete('Nets6'); },
  };
}

/**
 * Netlist Manager › Delete: the net goes; what was on it is left on No Net and every later net
 * index (objects and pours) moves down one.
 */
export function removeNet(doc: PcbDocument, index: number): Change {
  const wasDirty = new Set(doc.dirty);
  let nets = doc.nets, snap = new Map<string, PcbRawRecord[]>(), bags: PropertyBag[] = [];
  const map = (n: number) => (n === index ? 0xffff : n !== 0xffff && n > index ? n - 1 : n);
  return {
    apply() {
      nets = doc.nets; snap = new Map(); bags = doc.polygons.map((p) => p.bag);
      for (const [storage, s] of doc.streams) {
        if (!s.records.some((r) => NET_FIELD[r.tag])) continue;
        snap.set(storage, s.records);
        s.records = s.records.map((r) => (NET_FIELD[r.tag] ? kept(r, retarget(r, { net: map })) : r));
        doc.dirty.add(storage);
      }
      doc.nets = nets.filter((_, i) => i !== index).map((n, i) => ({ ...n, index: i }));
      doc.dirty.add('Nets6');
      doc.polygons.forEach((p, i) => { const n = map(p.net); if (n !== p.net) { const b = p.bag.clone(); b.set('NET', String(n)); doc.polygons[i] = polygonFromBag(b, i); doc.dirty.add('Polygons6'); } });
      rebuildPrims(doc);
    },
    revert() {
      for (const [storage, recs] of snap) doc.streams.get(storage)!.records = recs;
      doc.nets = nets;
      doc.polygons.forEach((_, i) => { doc.polygons[i] = polygonFromBag(bags[i]!, i); });
      for (const d of [...doc.dirty]) if (!wasDirty.has(d)) doc.dirty.delete(d);
      rebuildPrims(doc);
    },
  };
}

/** A copy of a record with its net and owner fields set (net mapping for pastes, new owners). */
export function retarget(rec: PcbRawRecord, opts: { net?: (n: number) => number; component?: number; polygon?: number }): PcbRawRecord {
  const subs = rec.subs.map((x) => x.slice());
  const nf = NET_FIELD[rec.tag];
  if (opts.net && nf && subs[nf.sub]) { const n = get(subs[nf.sub]!, nf.f); if (n !== undefined) put(subs[nf.sub]!, nf.f, opts.net(n)); }
  const o = OWN[rec.tag];
  if (o && subs[o.sub]) {
    if (opts.component !== undefined && o.component) put(subs[o.sub]!, o.component, opts.component);
    if (opts.polygon !== undefined && o.polygon) put(subs[o.sub]!, o.polygon, opts.polygon);
  }
  return { ...rec, subs };
}

/**
 * Add objects in one step (Paste): free records, components with what they own, polygon
 * definitions (their copper comes from repour()). Records keep their storage.
 */
export function addObjects(doc: PcbDocument, add: {
  records: { storage: string; rec: PcbRawRecord }[];
  components: { bag: PropertyBag; records: { storage: string; rec: PcbRawRecord }[] }[];
  polygons: PropertyBag[];
}): Change {
  const wasDirty = new Set(doc.dirty);
  let counts = new Map<string, number>();
  let nComp = 0, nPoly = 0;
  return {
    apply() {
      counts = new Map();
      const push = (storage: string, rec: PcbRawRecord) => { stream(doc, storage).push(rec); counts.set(storage, (counts.get(storage) ?? 0) + 1); doc.dirty.add(storage); };
      for (const r of add.records) push(r.storage, r.rec);
      nComp = add.components.length;
      for (const c of add.components) {
        const idx = doc.components.length;
        doc.components.push(componentFromBag(c.bag.clone(), idx));
        for (const r of c.records) push(r.storage, retarget(r.rec, { component: idx }));
      }
      if (nComp) doc.dirty.add('Components6');
      nPoly = add.polygons.length;
      for (const b of add.polygons) { const i = doc.polygons.length; const bb = b.clone(); bb.set('POURINDEX', String(i)); doc.polygons.push(polygonFromBag(bb, i)); }
      if (nPoly) doc.dirty.add('Polygons6');
      rebuildPrims(doc);
    },
    revert() {
      for (const [storage, n] of counts) { const r = doc.streams.get(storage)!.records; r.splice(r.length - n, n); }
      doc.components.splice(doc.components.length - nComp, nComp);
      doc.polygons.splice(doc.polygons.length - nPoly, nPoly);
      for (const d of [...doc.dirty]) if (!wasDirty.has(d)) doc.dirty.delete(d);
      rebuildPrims(doc);
    },
  };
}

/**
 * A free primitive as Place › Via, String, Fill, Arc or Solid Region makes it: the file's own
 * first record of that kind as the template (so unknown bytes match its Altium version), reset
 * to unlocked, not keepout, in no polygon.
 */
export function freshRecord(doc: PcbDocument, storage: string, encode: (template?: PcbRawRecord) => PcbRawRecord): PcbRawRecord {
  const template = doc.streams.get(storage)?.records[0];
  const rec0 = encode(template);
  if (!template) return rec0;
  // Not in the template's union
  const rec = withRecordUnion(storage, rec0, 0) ?? rec0;
  const s = rec.subs[storage === 'Pads6' ? 4 : 0]!;
  const flags: Record<string, { f1: Field; f2: Field; poly?: Field; sub?: Field }> = {
    Arcs6: { f1: ARC.flags1, f2: ARC.flags2, poly: ARC.polygon, sub: ARC.subpoly },
    Tracks6: { f1: TRACK.flags1, f2: TRACK.flags2, poly: TRACK.polygon, sub: TRACK.subpoly },
    Fills6: { f1: FILL.flags1, f2: FILL.flags2 },
    Vias6: { f1: VIA.flags1, f2: VIA.flags2 },
  };
  const f = flags[storage];
  if (f) {
    put(s, f.f1, 0x04); put(s, f.f2, 0);
    if (f.poly) put(s, f.poly, 0xffff);
    if (f.sub && s.length >= f.sub.off + 2) put(s, f.sub, 0xffff);
  }
  return rec;
}

/**
 * A record for an object placed with Place › …: from the kind's default (Tab while placing,
 * Preferences › Defaults) when there is one, its mask expansions included; else as freshRecord.
 */
export function placedRecord(doc: PcbDocument, storage: string, encode: (template?: PcbRawRecord) => PcbRawRecord): PcbRawRecord {
  const def = primDefault(storage);
  if (!def) return freshRecord(doc, storage, encode);
  const rec = encode(def);
  carryPrimInfo(def, rec);
  return rec;
}

/** Add free arcs (a route's curved stretches), as tracks are added. */
export function addArcs(doc: PcbDocument, arcs: { layer: LayerId; c: Vec2; r: number; start: number; end: number; width: number; net?: number }[]): Change {
  const template = doc.streams.get('Arcs6')?.records[0];
  return addPrimRecords(doc, arcs.map((a) => ({ storage: 'Arcs6', rec: encodeArc(a, template) })));
}

/** Add free primitives (one undo step). */
export function addPrimRecords(doc: PcbDocument, records: { storage: string; rec: PcbRawRecord }[]): Change {
  return addObjects(doc, { records, components: [], polygons: [] });
}
