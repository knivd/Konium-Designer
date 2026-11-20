/**
 * What Altium does to the sheet after a wire (or bus) goes down, as Preferences › Schematic ›
 * General asks:
 * - Break Wires At Autojunctions: a wire ended part-way along another splits that one there;
 * - Optimize Wires & Buses: a wire ended on the end of another, in line and with nothing else
 *   there, joins it into one wire;
 * - Place Sheet Entries automatically: a wire ended on a sheet symbol's edge gets an entry;
 * - Convert Cross-Junctions: a junction the new wire makes into a crossing becomes two T's;
 * and, for parts, Components Cut Wires: a part dropped with two pins on one wire segment
 * removes the wire between them.
 * Each step is applied through `add` (an undo transaction's), so the next sees its result.
 */
import type { Change } from '../core/undo';
import type { Vec2 } from '../core/geom';
import { DIR_VECTORS, isShown, type SchDocument, type SchObject } from './sch';
import { addRecords, breakWire, removeObjects, replaceBags } from './schEdit';
import { setWirePts } from './schDrag';
import { hotSpots } from './schConnect';
import { edgeSlot, entryPoint } from './schHierarchy';
import { nextName, sheetEntryBag } from './schPlace';
import { crossJunctionChanges } from './crossJunctions';

type Line = SchObject & { kind: 'wire' | 'bus' };
const same = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
const inside = (p: Vec2, a: Vec2, b: Vec2): boolean => {
  if (same(p, a) || same(p, b)) return false;
  if (p.x < Math.min(a.x, b.x) || p.x > Math.max(a.x, b.x) || p.y < Math.min(a.y, b.y) || p.y > Math.max(a.y, b.y)) return false;
  return (b.x - a.x) * (p.y - a.y) === (b.y - a.y) * (p.x - a.x);
};
const lines = (doc: SchDocument, kind: 'wire' | 'bus') => doc.objects.filter((o): o is Line => o.kind === kind && isShown(doc, o) && o.pts.length >= 2);
const byUid = (doc: SchDocument, uid: string) => doc.objects.find((o) => doc.records[o.index + 1]?.bag?.get('UNIQUEID') === uid);

export interface WireOpts { breakAtJunctions: boolean; optimize: boolean; autoEntries: boolean; convertCross: boolean; step: number; grid: number }

/** After the line with this UNIQUEID went down. */
export function afterWire(doc: SchDocument, uid: string, o: WireOpts, add: (c: Change) => void): void {
  const self = () => byUid(doc, uid) as Line | undefined;
  const w0 = self();
  if (!w0 || (w0.kind !== 'wire' && w0.kind !== 'bus')) return;
  const kind = w0.kind;
  const ends = () => { const w = self()!; return [w.pts[0]!, w.pts.at(-1)!]; };

  // Split the lines this one ends on part-way
  if (o.breakAtJunctions) {
    for (const e of ends()) {
      for (const l of lines(doc, kind)) {
        if (l.index === self()!.index) continue;
        const seg = l.pts.findIndex((q, i) => i > 0 && inside(e, l.pts[i - 1]!, q));
        if (seg > 0) { const c = breakWire(doc, l.index, seg - 1, e, e); if (c) add(c); break; }
      }
    }
  }

  // Join end-on, in line, where nothing else meets
  if (o.optimize) {
    for (let pass = 0; pass < 2; pass++) {
      const w = self()!;
      const e = pass === 0 ? w.pts.at(-1)! : w.pts[0]!;
      const others = lines(doc, kind).filter((l) => l.index !== w.index && l.pts.some((q, i) => (i === 0 || i === l.pts.length - 1) && same(q, e)));
      const through = lines(doc, kind).some((l) => l.index !== w.index && l.pts.some((q, i) => i > 0 && inside(e, l.pts[i - 1]!, q)));
      const devices = hotSpots(doc).filter((p) => same(p, e)).length + doc.objects.filter((j) => j.kind === 'junction' && same(j.at, e)).length;
      if (others.length !== 1 || through || devices) continue;
      const other = others[0]!;
      const theirs = same(other.pts.at(-1)!, e) ? other.pts : [...other.pts].reverse();     // ends at e
      const mine = pass === 0 ? [...w.pts].reverse() : w.pts;                                 // starts at e
      const a = theirs.at(-2)!, b = mine[1]!;
      if ((e.x - a.x) * (b.y - e.y) !== (e.y - a.y) * (b.x - e.x)) continue;                   // not in line
      const merged = [...theirs.slice(0, -1), ...mine.slice(1)];
      const before = doc.records[w.index + 1]!.bag!;
      const after = before.clone();
      setWirePts(after, merged);
      add(replaceBags(doc, [{ index: w.index, before: before.clone(), after }]));
      add(removeObjects(doc, [other.index]));
    }
  }

  // An entry where the wire ends on a sheet symbol's edge
  if (o.autoEntries && kind === 'wire') {
    for (const e of ends()) {
      for (const s of doc.objects) {
        if (s.kind !== 'sheetsymbol' || !isShown(doc, s)) continue;
        const onEdge = ((e.x === s.at.x || e.x === s.at.x + s.w) && e.y <= s.at.y && e.y >= s.at.y - s.h)
          || ((e.y === s.at.y || e.y === s.at.y - s.h) && e.x >= s.at.x && e.x <= s.at.x + s.w);
        if (!onEdge) continue;
        if (doc.objects.some((x) => x.kind === 'sheetentry' && x.owner === s.index && (() => { const p = entryPoint(doc, x); return !!p && same(p, e); })())) continue;
        const slot = edgeSlot(s as never, e, o.grid);
        const taken = new Set(doc.objects.filter((x) => x.kind === 'sheetentry' && x.owner === s.index).map((x) => (x as { name: string }).name));
        let name = 'Entry1';
        while (taken.has(name)) name = nextName(name);
        const b = sheetEntryBag(name, slot.side, slot.distance);
        b.set('OWNERINDEX', String(s.index));
        add(addRecords(doc, [b]));
        break;
      }
    }
  }

  // A junction this wire turned into a crossing: two T's
  if (o.convertCross && kind === 'wire') {
    const { changes } = crossJunctionChanges(doc, o.step, ends());
    for (const c of changes) add(c);
  }
}

/** Components Cut Wires: each part dropped with two pin ends on one wire segment opens the wire between them. */
export function partsCutWires(doc: SchDocument, parts: number[], add: (c: Change) => void): void {
  for (const ci of parts) {
    const pins = doc.objects.filter((p): p is SchObject & { kind: 'pin' } => p.kind === 'pin' && p.owner === ci && isShown(doc, p))
      .map((p) => { const d = DIR_VECTORS[p.orient & 3]!; return { x: p.at.x + d.x * p.length, y: p.at.y + d.y * p.length }; });
    for (const w of lines(doc, 'wire')) {
      let done = false;
      for (let k = 1; k < w.pts.length && !done; k++) {
        const a = w.pts[k - 1]!, b = w.pts[k]!;
        const on = pins.filter((p) => inside(p, a, b));
        if (on.length < 2) continue;
        // The two pin ends nearest the segment's start and end
        on.sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
        const c = breakWire(doc, w.index, k - 1, on[0]!, on.at(-1)!);
        if (c) { add(c); done = true; }
      }
      if (done) break;
    }
  }
}
