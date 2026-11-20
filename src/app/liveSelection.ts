/**
 * Live Simulation of a selection (26.186): a part of a real design taken to the bench. What is
 * selected on the sheet in front (parts, wires, junctions, net labels, power ports) is copied to
 * a schematic of its own, where it runs as a sketch: sources and test points from the palette go
 * beside it, values are turned, and the design itself is not touched.
 *
 * The copy is given what a part of a design lacks on its own. A supply net that says its voltage
 * in its name (+5V, 3V3, -12V, P1V8, VDD_3V3) gets a DC rail of that voltage; a ground under
 * another name (AGND, DGND, PGND, VSS, 0V) is GND in the sketch, the net voltages are measured from
 * (two names on one net would leave it under the other).
 * A supply whose name says no voltage (VCC, VBAT) is left for a source to be placed on, and said.
 */
import type { Vec2 } from '../core/geom';
import { readSchDoc, writeSchDoc } from '../formats/altium/schdoc';
import { SIM_SOURCES_LIB, simSourceSymbols } from '../formats/synthetic/simLib';
import { SR, type SchDocument } from '../model/sch';
import { addRecords, removeObjects, setProps, wireBag } from '../model/schEdit';
import { partRecords, powerBag } from '../model/schPlace';
import { transformBag, identity, withChildren } from '../model/schTransform';
import { setSimParam } from '../model/simModels';
import { docParam } from '../model/schParams';
import { LIVE_SAVED } from './liveSaved';

/** The voltage a supply net's name says (+5V, 3V3, -12V, N12V, P1V8, VDD_3V3, +3.3V_AUX): null where it says none. */
export function supplyVolts(name: string): number | null {
  const m = /(^|[^0-9.])([+-]?)(\d+(?:\.\d+)?)V(\d*)(?![A-Z0-9])/i.exec(name.replace(/_/g, ' '));
  if (!m) return null;
  const whole = Number(m[3]), v = m[4] ? Number(`${m[3]}.${m[4]}`) : whole;
  if (!Number.isFinite(v) || (m[4] && m[3]!.includes('.'))) return null;
  // (a minus before the number, or N straight before it as in N12V, or NEG in the name)
  const before = name.slice(0, m.index + m[1]!.length);
  const negative = m[2] === '-' || /(^|[^A-Z])N$/i.test(before) || /NEG/i.test(name);
  return negative ? -v : v;
}
/** A ground under a name of its own: GND in the sketch. */
export const isGroundAlias = (name: string): boolean => !/^GND$/i.test(name) && /^([ADPS]?GND[A-Z0-9]?|GND[_ ]?[A-Z0-9]+|VSS[A-Z]?|0V|EARTH|GROUND)$/i.test(name.trim());

export interface SelectionSketch {
  doc: SchDocument;
  /** The parts taken. */
  parts: number;
  /** The supplies given a rail by their names, each as "+5V"; the grounds that are GND in the sketch; the supplies whose names say no voltage. */
  rails: string[]; grounds: string[]; unknown: string[];
  /** Whether the sketch has a GND to measure from. */
  reference: boolean;
}

/**
 * The selection of `doc` (object indices) as a sheet of its own, `name`: the sheet's own settings and fonts, the objects
 * selected with what they own, and the rails and ground links their power ports ask for, to the left of them.
 */
export function selectionSketch(doc: SchDocument, indices: readonly number[], name: string): SelectionSketch {
  const keep = new Set(withChildren(doc, indices.filter((i) => { const o = doc.objects[i]; return !!o && !(o.owner >= 0 && doc.objects[o.owner]?.kind === 'component'); })));
  for (const o of doc.objects) if (o.record === SR.SHEET) keep.add(o.index);
  // A copy of the whole sheet, and everything else taken off it
  const copy = readSchDoc(writeSchDoc(doc), name);
  removeObjects(copy, copy.objects.filter((o) => !keep.has(o.index) && !(o.owner >= 0 && keep.has(o.owner))).map((o) => o.index)).apply();
  // (what the design's sheet keeps of its own Live Simulation is of places the sketch may not have)
  const watched = docParam(copy, LIVE_SAVED);
  if (watched) removeObjects(copy, [watched.index]).apply();
  const parts = copy.objects.filter((o) => o.kind === 'component').length;
  // A ground under another name is GND here
  const grounds: string[] = [];
  for (const o of copy.objects.slice()) if (o.kind === 'power' && !o.crossSheet && isGroundAlias(o.text)) { if (!grounds.includes(o.text)) grounds.push(o.text); setProps(copy, o.index, { TEXT: 'GND' }).apply(); }
  grounds.sort();
  // Its power ports by name, and where the selection is
  const names = new Map<string, string>();
  let minX = Infinity, maxY = -Infinity, minY = Infinity;
  for (const o of copy.objects) {
    if (o.kind === 'power' && !o.crossSheet && o.text) names.set(o.text.toUpperCase(), o.text);
    const at = 'at' in o ? (o.at as Vec2 | undefined) : undefined;
    if (at && o.record !== SR.SHEET && o.owner < 0) { if (at.x < minX) minX = at.x; if (at.y > maxY) maxY = at.y; if (at.y < minY) minY = at.y; }
  }
  if (!Number.isFinite(minX)) { minX = 20_000_000; maxY = 40_000_000; minY = 20_000_000; }
  const rails: string[] = [], unknown: string[] = [], bags: ReturnType<typeof wireBag>[] = [];
  const MIL = 10_000, x = Math.round((minX - 600 * MIL) / (100 * MIL)) * 100 * MIL;
  let y = Math.round(maxY / (100 * MIL)) * 100 * MIL, sources = Math.max(0, ...copy.objects.map((o) => (o.kind === 'component' ? Number(/^V(\d+)$/i.exec(o.designator)?.[1] ?? 0) : 0)));
  const symbol = simSourceSymbols().find((s) => s.libRef === 'RAIL_DC');
  for (const text of [...names.values()].sort()) {
    if (/^GND$/i.test(text)) continue;
    const volts = supplyVolts(text);
    if (volts === null || !symbol) { unknown.push(text); continue; }
    // A DC rail, a wire down from its pin, and the supply's port at the wire's end
    const items = partRecords({ libRef: 'RAIL_DC', bags: symbol.bags }, SIM_SOURCES_LIB.replace('.SchLib', '.IntLib'), 1);
    setSimParam(items, 'Value', String(volts));
    const base = copy.records.length - 1 + bags.length, des = `V${++sources}`;
    for (const it of items) {
      const b = transformBag(it.bag, { ...identity(), d: { x, y } });
      if (it.owner >= 0) b.setRaw('OWNERINDEX', String(base + it.owner));
      if (b.int('RECORD', -1) === SR.DESIGNATOR) b.set('TEXT', des);
      bags.push(b);
    }
    const end = { x, y: y - 100 * MIL }, port = powerBag(2, text, { x, y: y - 200 * MIL });
    port.set('ORIENTATION', '3');
    bags.push(wireBag([end, { x, y: y - 200 * MIL }]), port);
    rails.push(text); y -= 700 * MIL;
  }
  if (bags.length) addRecords(copy, bags).apply();
  return { doc: copy, parts, rails, grounds, unknown, reference: names.has('GND') };
}

/** What the sketch was given and what it still wants, as a line to tell the user. */
export function sketchNote(s: SelectionSketch): string {
  const list = (a: string[]) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  const said: string[] = [`${s.parts} part${s.parts === 1 ? ' taken to a sketch of its own' : 's taken to a sketch of their own'}`];
  if (s.rails.length) said.push(`${list(s.rails)} ${s.rails.length === 1 ? 'is a supply' : 'are supplies'} by ${s.rails.length === 1 ? 'its name' : 'their names'}`);
  if (s.grounds.length) said.push(`${list(s.grounds)} ${s.grounds.length === 1 ? 'is' : 'are'} GND here`);
  if (s.unknown.length) said.push(`${list(s.unknown)} ${s.unknown.length === 1 ? 'says' : 'say'} no voltage: place a source on ${s.unknown.length === 1 ? 'it' : 'each'}`);
  if (!s.reference) said.push('there is no GND: place one where 0 V is to be');
  return `${said.join('; ')}.`;
}
