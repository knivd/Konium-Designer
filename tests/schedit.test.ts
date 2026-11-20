import { describe, expect, it } from 'vitest';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { blockOf, breakWire, reorderObjects } from '../src/model/schEdit';
import { wireConnection, electricalSpots } from '../src/model/schConnect';
import { mil } from '../src/core/units';

const demo = () => readSchDoc(demoSchDoc(), 'Demo.SchDoc');
const owners = (d: ReturnType<typeof demo>) => d.objects.filter((o) => o.owner >= 0).map((o) => `${d.objects[o.owner]!.kind}:${o.kind}`).sort();

describe('schematic edits', () => {
  it('Bring To Front moves a part with what it owns; ownership follows; undo restores the bytes', () => {
    const d = demo();
    const before = writeSchDoc(d);
    const u1 = d.objects.find((o) => o.kind === 'component' && o.designator === 'U1')!;
    const kids = d.objects.filter((o) => o.owner === u1.index).length;
    const size = blockOf(d, u1.index).length;
    const own0 = owners(d);
    const ch = reorderObjects(d, [u1.index], 'front');
    ch.apply();
    const moved = d.objects.find((o) => o.kind === 'component' && o.designator === 'U1')!;
    expect(moved.index).toBe(d.objects.length - size);
    expect(d.objects.filter((o) => o.owner === moved.index).length).toBe(kids);
    expect(owners(d)).toEqual(own0);
    ch.revert();
    expect(writeSchDoc(d)).toEqual(before);
    // Send To Back: before the first drawn object (the sheet record stays first)
    const back = reorderObjects(d, [u1.index], 'back');
    back.apply();
    expect(d.objects[0]!.kind).toBe('meta');
    expect(d.objects.find((o) => o.kind === 'component' && o.designator === 'U1')!.index).toBeLessThan(u1.index);
    expect(owners(d)).toEqual(own0);
  });

  it('Break Wire cuts a gap out of a segment: two wires, one at an end', () => {
    const d = demo();
    const w = d.objects.find((o) => o.kind === 'wire' && o.pts.length === 2 && o.pts[0]!.y === o.pts[1]!.y && Math.abs(o.pts[1]!.x - o.pts[0]!.x) >= mil(1000))!;
    if (w.kind !== 'wire') throw new Error('no wire');
    const [a, b] = [w.pts[0]!, w.pts[1]!];
    const dir = Math.sign(b.x - a.x);
    const n = d.objects.filter((o) => o.kind === 'wire').length;
    const ch = breakWire(d, w.index, 0, { x: a.x + dir * mil(300), y: a.y }, { x: a.x + dir * mil(500), y: a.y })!;
    ch.apply();
    const wires = d.objects.filter((o) => o.kind === 'wire');
    expect(wires.length).toBe(n + 1);
    expect((d.objects[w.index] as typeof w).pts).toEqual([a, { x: a.x + dir * mil(300), y: a.y }]);
    expect((wires.at(-1) as typeof w).pts).toEqual([{ x: a.x + dir * mil(500), y: a.y }, b]);
    ch.revert();
    expect(d.objects.filter((o) => o.kind === 'wire').length).toBe(n);
    // Cutting from the start leaves one wire
    const one = breakWire(d, w.index, 0, a, { x: a.x + dir * mil(200), y: a.y })!;
    one.apply();
    expect(d.objects.filter((o) => o.kind === 'wire').length).toBe(n);
  });

  it('Select Connection follows wires joined end-to-wire, with what sits on them; hot spots include wire ends', () => {
    const d = demo();
    const w = d.objects.find((o) => o.kind === 'wire')!;
    const list = wireConnection(d, w.index);
    expect(list).toContain(w.index);
    // Everything found is a wire, bus, junction, label, power port, port or entry
    expect(list.every((i) => ['wire', 'junction', 'text', 'power', 'port', 'sheetentry'].includes(d.objects[i]!.kind))).toBe(true);
    const spots = electricalSpots(d);
    if (w.kind !== 'wire') throw new Error('no wire');
    expect(spots).toContainEqual(w.pts[0]);
  });
});
