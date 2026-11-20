import { pushAll } from '../core/lists';
import type { Change } from '../core/undo';
import type { Vec2 } from '../core/geom';
import { PropertyBag } from '../formats/altium/props';
import type { SchRawRecord } from '../formats/altium/framing';
import { ADDITIONAL_RECORDS, SR, rederive, setSchCoord, type SchDocument, ownedBy } from './sch';

/**
 * Schematic edits operate on property bags (the file's source of truth) and re-derive the
 * typed objects. Untouched records keep their original bytes.
 */

const textRec = (bag: PropertyBag): SchRawRecord => ({ kind: 0, data: bag.toBytes(), bag, ...(ADDITIONAL_RECORDS.has(bag.int('RECORD', -1)) ? { additional: true } : {}) });

export function uniqueId(): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = '';
  for (let i = 0; i < 8; i++) s += A[Math.floor(Math.random() * 26)];
  return s;
}

export function wireBag(pts: Vec2[], opts: { bus?: boolean; color?: number; width?: number } = {}): PropertyBag {
  const bag = PropertyBag.from({
    RECORD: opts.bus ? SR.BUS : SR.WIRE,
    OWNERPARTID: -1,
    LINEWIDTH: opts.width ?? (opts.bus ? 2 : 1),
    COLOR: opts.color ?? 8388608,
    LOCATIONCOUNT: pts.length,
  });
  pts.forEach((p, i) => { setSchCoord(bag, `X${i + 1}`, p.x); setSchCoord(bag, `Y${i + 1}`, p.y); });
  bag.setRaw('UNIQUEID', uniqueId());
  return bag;
}

export function junctionBag(at: Vec2): PropertyBag {
  const bag = PropertyBag.from({ RECORD: SR.JUNCTION, OWNERPARTID: -1, COLOR: 8388608 });
  setSchCoord(bag, 'LOCATION.X', at.x);
  setSchCoord(bag, 'LOCATION.Y', at.y);
  return bag;
}

/**
 * The header's WEIGHT is the number of records after it. Keep it true when records come and
 * go; undo restores the original text so an unmodified file still saves byte-identical.
 */
function weightKeeper(doc: SchDocument) {
  const head = doc.records[0]?.bag;
  const raw = head?.getRaw('WEIGHT'), modified = head?.modified ?? false;
  return {
    // FileHeader's WEIGHT counts its own records (harnesses are in the Additional stream)
    sync() { if (head && raw !== undefined) head.setRaw('WEIGHT', String(doc.records.reduce((n, r, i) => n + (i > 0 && !r.additional ? 1 : 0), 0))); },
    restore() { if (head && raw !== undefined) { head.setRaw('WEIGHT', raw); head.modified = modified; } },
  };
}

/** Append records (top-level, no owner). */
export function addRecords(doc: SchDocument, bags: PropertyBag[]): Change {
  if (doc.adopt) for (const b of bags) doc.adopt(b);
  const recs = bags.map(textRec);
  const w = weightKeeper(doc);
  return {
    apply() { pushAll(doc.records, recs); w.sync(); rederive(doc); },
    revert() { doc.records.splice(doc.records.length - recs.length, recs.length); w.restore(); rederive(doc); },
  };
}

/** Change properties on one record. A null value removes the key (Altium omits false booleans). */
export function setProps(doc: SchDocument, objectIndex: number, props: Record<string, string | null>): Change {
  const rec = doc.records[objectIndex + 1];
  if (!rec?.bag) throw new Error('not a property record');
  const before = rec.bag.clone();
  const after = rec.bag.clone();
  for (const [k, v] of Object.entries(props)) { if (v === null) after.delete(k); else after.set(k, v); }
  // The record is looked up when applied: other steps may have replaced the record objects since
  const put = (b: PropertyBag) => { const r = doc.records[objectIndex + 1]; if (r) r.bag = b.clone(); rederive(doc); };
  return { apply() { put(after); }, revert() { put(before); } };
}

/**
 * Remove objects (and, for components, everything they own). OWNERINDEX on every later
 * record is renumbered so ownership stays intact.
 */
export function removeObjects(doc: SchDocument, objectIndices: number[]): Change {
  const kill = new Set<number>();
  const visit = (i: number): void => {
    if (kill.has(i)) return;
    kill.add(i);
    for (const o of ownedBy(doc).get(i) ?? []) visit(o.index);
  };
  objectIndices.forEach(visit);

  let snapshot: SchRawRecord[] = [];
  const w = weightKeeper(doc);

  return {
    apply() {
      snapshot = doc.records.slice();
      // new index for each surviving object
      const remap = new Map<number, number>();
      let n = 0;
      for (let i = 0; i < doc.objects.length; i++) if (!kill.has(i)) remap.set(i, n++);
      const kept: SchRawRecord[] = [doc.records[0]!];
      for (let i = 0; i < doc.objects.length; i++) {
        if (kill.has(i)) continue;
        kept.push(renumbered(doc.records[i + 1]!, remap));
      }
      doc.records = kept;
      w.sync();
      rederive(doc);
    },
    revert() {
      // The records as they were (renumbered ones were copies: the originals are untouched)
      doc.records = snapshot;
      w.restore();
      rederive(doc);
    },
  };
}

/** A record whose OWNERINDEX moves: a copy with the new index (the original stays as it was, for undo). */
function renumbered(rec: SchRawRecord, remap: Map<number, number>): SchRawRecord {
  const bag = rec.bag;
  if (!bag?.has('OWNERINDEX')) return rec;
  const old = bag.int('OWNERINDEX'), nu = remap.get(old);
  if (nu === undefined || nu === old) return rec;
  const b = bag.clone();
  b.setRaw('OWNERINDEX', String(nu));
  return { ...rec, bag: b };
}

/** Replace record bags (moves, rotations, vertex edits): one undoable step. */
export function replaceBags(doc: SchDocument, entries: { index: number; before: PropertyBag; after: PropertyBag }[]): Change {
  return {
    apply() { for (const e of entries) { const r = doc.records[e.index + 1]; if (r) r.bag = e.after.clone(); } rederive(doc); },
    revert() { for (const e of entries) { const r = doc.records[e.index + 1]; if (r) r.bag = e.before.clone(); } rederive(doc); },
  };
}

/** An object and everything it owns, as one block of indices in file order. */
export function blockOf(doc: SchDocument, i: number): number[] {
  const out = new Set<number>([i]);
  for (let grew = true; grew;) {
    grew = false;
    for (const o of doc.objects) if (o.owner >= 0 && out.has(o.owner) && !out.has(o.index)) { out.add(o.index); grew = true; }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Edit › Move › Bring To Front / Send To Back (… Of): the objects (with what they own) move in
 * the file's order — later records draw on top. 'front' / 'back', or just in front of or
 * behind another object. OWNERINDEX follows every record that moves.
 */
export function reorderObjects(doc: SchDocument, indices: number[], to: 'front' | 'back' | { before: number } | { after: number }): Change {
  const moving = new Set(indices.flatMap((i) => blockOf(doc, i)));
  const block = [...moving].sort((a, b) => a - b);
  const rest = doc.objects.map((o) => o.index).filter((i) => !moving.has(i));
  let at: number;
  if (to === 'front') at = rest.length;
  else if (to === 'back') { const k = rest.findIndex((i) => doc.objects[i]!.kind !== 'meta' && doc.objects[i]!.owner < 0); at = k < 0 ? rest.length : k; }
  else if ('before' in to) { const k = rest.indexOf(to.before); at = k < 0 ? 0 : k; }
  else { const tail = blockOf(doc, to.after).filter((i) => !moving.has(i)); const k = rest.indexOf(tail.at(-1) ?? to.after); at = k < 0 ? rest.length : k + 1; }
  const order = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  let snapshot: SchRawRecord[] = [];
  return {
    apply() {
      snapshot = doc.records.slice();
      const remap = new Map(order.map((old, nu) => [old, nu]));
      doc.records = [doc.records[0]!, ...order.map((i) => renumbered(doc.records[i + 1]!, remap))];
      rederive(doc);
    },
    revert() {
      doc.records = snapshot;
      rederive(doc);
    },
  };
}

/**
 * Edit › Break Wire: the part of a wire between `from` and `to` (both on segment `seg`, from
 * nearer its start) goes; what's left either side stays as one or two wires.
 */
export function breakWire(doc: SchDocument, index: number, seg: number, from: Vec2, to: Vec2): Change | null {
  const o = doc.objects[index];
  const rec = doc.records[index + 1];
  if (!o || (o.kind !== 'wire' && o.kind !== 'bus') || !rec?.bag) return null;
  const pts = o.pts;
  const same = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
  const head = [...pts.slice(0, seg + 1), from].filter((p, i, a) => i === 0 || !same(p, a[i - 1]!));
  const tail = [to, ...pts.slice(seg + 1)].filter((p, i, a) => i === 0 || !same(p, a[i - 1]!));
  const pieces = [head, tail].filter((p) => p.length >= 2);
  const before = rec.bag.clone();
  const put = (b: PropertyBag, p: Vec2[]) => {
    for (let i = 1; i <= b.int('LOCATIONCOUNT'); i++) { b.delete(`X${i}`); b.delete(`Y${i}`); b.delete(`X${i}_FRAC`); b.delete(`Y${i}_FRAC`); }
    b.setRaw('LOCATIONCOUNT', String(p.length));
    p.forEach((q, i) => { setSchCoord(b, `X${i + 1}`, q.x); setSchCoord(b, `Y${i + 1}`, q.y); });
  };
  if (!pieces.length) return removeObjects(doc, [index]);
  const first = before.clone();
  put(first, pieces[0]!);
  const second = pieces[1] ? (() => { const b = before.clone(); put(b, pieces[1]!); if (b.has('UNIQUEID')) b.setRaw('UNIQUEID', uniqueId()); return b; })() : null;
  const replace = replaceBags(doc, [{ index, before, after: first }]);
  const add = second ? addRecords(doc, [second]) : null;
  return {
    apply() { replace.apply(); add?.apply(); },
    revert() { add?.revert(); replace.revert(); },
  };
}
