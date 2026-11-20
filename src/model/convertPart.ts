/**
 * Design › Convert › Convert Part To Ports / Convert Part To Sheet Symbol: a part replaced by
 * a port at each pin's end (named after the pin, its I/O type from the pin's), or by a sheet
 * symbol over its body with a sheet entry where each pin meets it — the designator becomes the
 * symbol's, the library reference its file name. One undo step each.
 */
import type { Change } from '../core/undo';
import type { Vec2 } from '../core/geom';
import { SCH_UNIT } from '../core/units';
import { DIR_VECTORS, SR, isShown, type SchDocument, type SchObject, ownedBy } from './sch';
import { addRecords, removeObjects } from './schEdit';
import { portBag, sheetEntryBag, sheetSymbolItems } from './schPlace';

type Pin = SchObject & { kind: 'pin' };

function pinsOf(doc: SchDocument, ci: number): Pin[] {
  return doc.objects.filter((o): o is Pin => o.kind === 'pin' && o.owner === ci && isShown(doc, o));
}
const pinName = (p: Pin) => (p.name || p.designator).trim();
/** Pin ELECTRICAL → port / sheet entry IOTYPE (0 Unspecified, 1 Output, 2 Input, 3 Bidirectional). */
const ioOf = (electrical: number) => (electrical === 0 ? 2 : electrical === 2 ? 1 : electrical === 1 ? 3 : 0);

export function partToPortsChanges(doc: SchDocument, ci: number): Change[] {
  const pins = pinsOf(doc, ci);
  if (!pins.length) return [];
  const bags = pins.map((p) => {
    const d = DIR_VECTORS[p.orient & 3]!;
    const end = { x: p.at.x + d.x * p.length, y: p.at.y + d.y * p.length };
    const name = pinName(p);
    const w = Math.max(5, Math.ceil((name.length * 7 + 30) / 10)) * 10 * SCH_UNIT;
    const vertical = d.y !== 0;
    // The port's near end on the pin's end, running away from the part
    const at: Vec2 = vertical ? { x: end.x, y: d.y > 0 ? end.y : end.y - w } : { x: d.x > 0 ? end.x : end.x - w, y: end.y };
    const b = portBag(name, at, w, vertical ? 7 : 3, ioOf(p.electrical));
    return b;
  });
  return [addRecords(doc, bags), removeObjects(doc, [ci])];
}

export function partToSheetSymbolChanges(doc: SchDocument, ci: number, fileName?: string): Change[] {
  const comp = doc.objects[ci];
  if (comp?.kind !== 'component') return [];
  const pins = pinsOf(doc, ci);
  // The body: the part's shown graphics, else the pins' inner ends
  const pts: Vec2[] = [];
  for (const o of doc.objects) {
    if (o.owner !== ci || !isShown(doc, o)) continue;
    if (o.kind === 'rect') pts.push(o.a, o.b);
    else if (o.kind === 'polygon' || o.kind === 'polyline') pts.push(...o.pts);
    else if (o.kind === 'ellipse') pts.push({ x: o.c.x - o.rx, y: o.c.y - o.ry }, { x: o.c.x + o.rx, y: o.c.y + o.ry });
  }
  for (const p of pins) pts.push(p.at);
  if (!pts.length) pts.push(comp.at, { x: comp.at.x + 100 * SCH_UNIT, y: comp.at.y - 100 * SCH_UNIT });
  const grid = 10 * SCH_UNIT;
  const left = Math.floor(Math.min(...pts.map((p) => p.x)) / grid) * grid, right = Math.ceil(Math.max(...pts.map((p) => p.x)) / grid) * grid;
  const bottom = Math.floor(Math.min(...pts.map((p) => p.y)) / grid) * grid, top = Math.ceil(Math.max(...pts.map((p) => p.y)) / grid) * grid;
  const w = Math.max(right - left, 50 * SCH_UNIT), h = Math.max(top - bottom, 50 * SCH_UNIT);
  const items = sheetSymbolItems({ x: left, y: top }, { x: left + w, y: top - h }, comp.designator || 'U_Sheet', fileName ?? `${comp.libRef || 'Sheet'}.SchDoc`);
  for (const p of pins) {
    // Pin pointing left sits on the left edge (side 0), right → 1, up → top (2), down → bottom (3)
    const side = [1, 2, 0, 3][p.orient & 3]!;
    const dist = side <= 1 ? top - p.at.y : p.at.x - left;
    items.push({ bag: sheetEntryBag(pinName(p), side, Math.max(0, dist), ioOf(p.electrical)), owner: 0 });
  }
  const base = doc.records.length - 1;
  const bags = items.map((it) => { const b = it.bag.clone(); if (it.owner >= 0) b.set('OWNERINDEX', String(base + it.owner)); return b; });
  return [addRecords(doc, bags), removeObjects(doc, [ci])];
}

export const isPart = (o: SchObject | undefined): o is SchObject & { kind: 'component' } => o?.kind === 'component';
export { SR };

/**
 * Design › Refactor › Push Part to Sheet: the part moves to a new child sheet, with a port on
 * each of its pins there; here a sheet symbol for that sheet takes its place, an entry per pin.
 * Returns the changes for this sheet and the records for the new one (part first, owners kept).
 */
export function pushPartToSheet(doc: SchDocument, ci: number, childName: string): { here: Change[]; child: import('../formats/altium/props').PropertyBag[] } | null {
  const comp = doc.objects[ci];
  if (comp?.kind !== 'component') return null;
  const pins = pinsOf(doc, ci);
  const idx: number[] = [];
  const kids = ownedBy(doc);
  const visit = (i: number) => { if (idx.includes(i)) return; idx.push(i); for (const o of kids.get(i) ?? []) visit(o.index); };
  visit(ci);
  idx.sort((a, b) => a - b);
  // The part's records as they are, owners renumbered from 1 (object 0 of the new sheet is its sheet record)
  const pos = new Map(idx.map((i, k) => [i, k + 1]));
  const child = idx.map((i) => {
    const b = doc.records[i + 1]!.bag!.clone();
    const o = doc.objects[i]!;
    if (o.owner >= 0 && pos.has(o.owner)) b.set('OWNERINDEX', String(pos.get(o.owner)));
    return b;
  });
  for (const p of pins) {
    const d = DIR_VECTORS[p.orient & 3]!;
    const end = { x: p.at.x + d.x * p.length, y: p.at.y + d.y * p.length };
    const name = pinName(p);
    const w = Math.max(5, Math.ceil((name.length * 7 + 30) / 10)) * 10 * SCH_UNIT;
    const vertical = d.y !== 0;
    const at: Vec2 = vertical ? { x: end.x, y: d.y > 0 ? end.y : end.y - w } : { x: d.x > 0 ? end.x : end.x - w, y: end.y };
    child.push(portBag(name, at, w, vertical ? 7 : 3, ioOf(p.electrical)));
  }
  return { here: partToSheetSymbolChanges(doc, ci, childName), child };
}
