import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { PropertyBag } from '../src/formats/altium/props';
import { ruleHeading, ruleKind } from '../src/formats/altium/rules';
import { addStackLayer, readStack, setStack } from '../src/model/pcbStack';
import { conductorShares, planeCopper } from '../src/model/planes';
import { lengthIn, runDrc } from '../src/model/drc';
import { setDrcSettings } from '../src/model/drcOptions';
import { pointInPoly } from '../src/core/geom';
import { mil } from '../src/core/units';
import { L, type LayerId } from '../src/model/layers';
import type { PcbDocument, PcbPrim } from '../src/model/pcb';

/**
 * 26.155: internal planes' checks as the desktop suite makes them, and plane copper with every hole
 * in it: relief conductors at 45°, isolated plane copper under Un-Routed Net, starved thermals
 * under Power Plane Connect.
 */

const GND = 0, P3V3 = 1, SIG = 2;
const PLANE = L.PLANE1 as LayerId;
const src = (storage: string) => ({ storage, index: -1 });
/** A new board (6000 × 4000 mil at (1000, 1000) mil, its origin at 0) on 6 layers: GND and +3V3 planes. */
function board(): PcbDocument {
  const doc = readPcbDoc(newPcbDocBytes('Planes.PcbDoc'), 'Planes.PcbDoc');
  let rows = readStack(doc.board.bag!, doc.board.copperStack);
  const step = (layer: number, plane: boolean) => { const r = addStackLayer(rows, layer, plane)!; rows = r.rows; return r.index; };
  step(step(step(step(rows.findIndex((x) => x.layer === L.TOP), true), false), false), true);
  setStack(doc, rows).apply();
  doc.board.bag!.set('PLANE1NETNAME', 'GND');
  doc.board.bag!.set('PLANE2NETNAME', '+3V3');
  for (const n of ['GND', '+3V3', 'SIG']) doc.nets.push({ index: doc.nets.length, name: n, bag: PropertyBag.from({ NAME: n }) });
  return doc;
}
/** A 0.2 mm via with a 0.45 mm pad, through the board, at (x, y) mil. */
const via = (x: number, y: number, net: number): PcbPrim => ({ kind: 'via', src: src('Vias6'), at: { x: mil(x), y: mil(y) }, diameter: mil(17.7165), hole: mil(7.874), layerStart: L.TOP, layerEnd: L.BOTTOM, net, locked: false });
const add = (doc: PcbDocument, ...p: PcbPrim[]) => { doc.prims = [...doc.prims, ...p]; };
/** Whether the plane has copper at (x, y) mil. */
const copperAt = (doc: PcbDocument, x: number, y: number, layer = PLANE) => {
  const q = { x: mil(x), y: mil(y) };
  return planeCopper(doc, layer).some((a) => a.regions.some((r) => pointInPoly(q, r.outline) && !r.holes.some((h) => pointInPoly(q, h))));
};
/** A 3 × 3 grid of GND vias at 1 mm (39.37 mil) about (x, y) mil. */
const grid = (x: number, y: number, net = GND) => [-1, 0, 1].flatMap((i) => [-1, 0, 1].map((j) => via(x + i * 39.37, y + j * 39.37, net)));
const messages = (doc: PcbDocument, ...k: string[]) => runDrc(doc, new Set(k)).violations.map((v) => v.message);

describe('plane copper (26.155)', () => {
  it('every hole is cleared or relieved wherever it is on the board (a board away from 0 lost those past its middle)', () => {
    const doc = board();
    add(doc, via(1500, 1500, SIG), via(6500, 4500, SIG), via(6500, 1500, GND), via(4000, 4800, P3V3));
    // Each other net's via is in a hole of the GND plane; the GND via's own copper (to its air gap) stays
    for (const [x, y] of [[1500, 1500], [6500, 4500], [4000, 4800]] as const) expect(copperAt(doc, x, y)).toBe(false);
    expect(copperAt(doc, 6500, 1500)).toBe(true);
    // Its air gap is cut across the axes; its conductors cross at 45°
    const r = 3.937 + 20 + 5;
    expect(copperAt(doc, 6500 + r, 1500)).toBe(false);
    expect(copperAt(doc, 6500, 1500 - r)).toBe(false);
    expect(copperAt(doc, 6500 + r * Math.SQRT1_2, 1500 + r * Math.SQRT1_2)).toBe(true);
    expect(copperAt(doc, 6500 - r * Math.SQRT1_2, 1500 - r * Math.SQRT1_2)).toBe(true);
  });

  it('a relief\'s conductors\' share of a piece: whole, none, or the part a hole leaves', () => {
    const c = { x: 0, y: 0 }, r1 = mil(23.937), r2 = mil(33.937), hw = mil(5);
    expect(conductorShares(c, r1, r2, hw, [0, 90], null, []).map((x) => x.toFixed(3))).toEqual(['1.000', '1.000']);
    // A hole over the half of the ring at x > 28.937 mil: the 0° conductor half gone, the 90° whole
    const half = [{ x: mil(28.937), y: -mil(40) }, { x: mil(60), y: -mil(40) }, { x: mil(60), y: mil(40) }, { x: mil(28.937), y: mil(40) }];
    const s = conductorShares(c, r1, r2, hw, [0, 90], null, [half]);
    expect(s[0]).toBeGreaterThan(0.45); expect(s[0]).toBeLessThan(0.55);
    expect(s[1]).toBeCloseTo(1, 3);
    // An outline that leaves out everything past x = 0: none of the 0° conductor, all of the 90°
    const left = [{ x: -mil(100), y: -mil(100) }, { x: 0, y: -mil(100) }, { x: 0, y: mil(100) }, { x: -mil(100), y: mil(100) }];
    const t = conductorShares(c, r1, r2, hw, [0, 180], left, []);
    expect(t[0]).toBe(0); expect(t[1]).toBeCloseTo(1, 3);
  });
});

describe('isolated plane copper and starved thermals as the suite reports them (26.155)', () => {
  it('a 3 × 3 grid of vias at 1 mm: the copper the reliefs cut off under Un-Routed Net, the reliefs short of the plane under Power Plane Connect', () => {
    const doc = board();
    add(doc, ...grid(4000, 3000));
    setDrcSettings(doc, { deadArea: 50 }).apply();
    const iso = messages(doc, 'UnRoutedNet').filter((m) => m.startsWith('Isolated copper'));
    // Four pieces between the middle via and the sides' (about 148 sq mil), four between each four vias (100), the middle via's own
    const areaOf = (m: string) => Number(/Copper area is : ([\d.]+) sq\. mils/.exec(m)![1]);
    expect(iso).toHaveLength(9);
    expect(iso.every((m) => m.startsWith('Isolated copper: Split Plane  (GND) on '))).toBe(true);
    const dead = iso.filter((m) => m.includes('Dead copper detected.')).map(areaOf);
    expect(dead.filter((a) => a > 140 && a < 155)).toHaveLength(4);
    expect(dead.filter((a) => a > 95 && a < 105)).toHaveLength(4);
    const own = iso.filter((m) => m.includes('Copper island connected to pads/vias detected.')).map(areaOf);
    expect(own).toHaveLength(1);
    expect(own[0]).toBeGreaterThan(115); expect(own[0]).toBeLessThan(130);
    // Largest first
    expect(iso.map(areaOf)).toEqual([...iso.map(areaOf)].sort((a, b) => b - a));
    // The middle via joins none of the plane; each side's two of four; the corners three of four (not starved)
    const starved = runDrc(doc, new Set(['PlaneConnect'])).violations.filter((v) => v.kind === 'StarvedThermal');
    const at = (v: { message: string }) => /Via \(([\d.]+)mil,([\d.]+)mil\)/.exec(v.message)!.slice(1).map(Number);
    expect(starved.map((v) => v.message.replace(/Via \([^)]*\)/, 'Via'))).toEqual([
      ...Array(5).fill(0).map((_, k) => k === 2 ? 'Starved Thermal on GND: Via from Top Layer to Bottom Layer. Blocked 4 out of 4 entries.' : 'Starved Thermal on GND: Via from Top Layer to Bottom Layer. Blocked 2 out of 4 entries.'),
    ]);
    expect(starved.map(at).map(([x, y]) => `${Math.round(x! - 4000)},${Math.round(y! - 3000)}`).sort()).toEqual(['-39,0', '0,-39', '0,0', '0,39', '39,0']);
    expect(starved.every((v) => v.error && v.rule === 'PlaneConnect')).toBe(true);
  });

  it('the report options decide: broken planes, dead copper larger than, starved thermals; a plane with none of its net\'s holes says nothing', () => {
    const doc = board();
    add(doc, ...grid(4000, 3000));
    // Dead copper of 100 sq mil or less isn't reported (the four between each four vias)
    expect(messages(doc, 'UnRoutedNet').filter((m) => m.startsWith('Isolated copper'))).toHaveLength(5);
    setDrcSettings(doc, { deadCopper: false }).apply();
    expect(messages(doc, 'UnRoutedNet').filter((m) => m.startsWith('Isolated copper'))).toHaveLength(1);
    setDrcSettings(doc, { brokenPlanes: false }).apply();
    expect(messages(doc, 'UnRoutedNet').filter((m) => m.startsWith('Isolated copper'))).toHaveLength(0);
    // Without Un-Routed Net checked, none either
    setDrcSettings(doc, { deadCopper: true, brokenPlanes: true }).apply();
    expect(messages(doc, 'Clearance').filter((m) => m.startsWith('Isolated copper'))).toHaveLength(0);
    // Starved thermals whether or not Power Plane Connect is asked for, as the suite lists them; not with the option off
    expect(messages(doc, 'Clearance').filter((m) => m.startsWith('Starved Thermal'))).toHaveLength(5);
    setDrcSettings(doc, { starved: false }).apply();
    expect(messages(doc, 'Clearance', 'PlaneConnect').filter((m) => m.startsWith('Starved Thermal'))).toHaveLength(0);
    // The same grid of +3V3 vias reaches the GND plane through none of them: on the +3V3 plane its copper is cut off as before, the GND plane says nothing
    const other = board();
    add(other, ...grid(4000, 3000, P3V3));
    setDrcSettings(other, { deadArea: 50 }).apply();
    const iso = messages(other, 'UnRoutedNet').filter((m) => m.startsWith('Isolated copper'));
    expect(iso).toHaveLength(9);
    expect(iso.every((m) => m.includes('(+3V3) on '))).toBe(true);
  });

  it('a via whose relief other nets\' clearances cut off: an island with the via, blocked all round', () => {
    const doc = board();
    // A +3V3 via amid SIG vias at 1 mm: their clearances meet round it
    add(doc, ...grid(4000, 3000, SIG).map((v, k) => (k === 4 ? via(4000, 3000, P3V3) : v)));
    const iso = messages(doc, 'UnRoutedNet').filter((m) => m.startsWith('Isolated copper'));
    expect(iso).toHaveLength(1);
    expect(iso[0]).toMatch(/^Isolated copper: Split Plane {2}\(\+3V3\) on .+\. Copper island connected to pads\/vias detected\. Copper area is : [\d.]+ sq\. mils$/);
    expect(messages(doc, 'PlaneConnect').filter((m) => m.startsWith('Starved Thermal'))).toEqual(['Starved Thermal on +3V3: Via (4000mil,3000mil) from Top Layer to Bottom Layer. Blocked 4 out of 4 entries.']);
  });

  it('the Power Plane Connect rule\'s heading as the suite writes it', () => {
    const doc = board();
    const r = doc.rules.find((x) => ruleKind(x) === 'PlaneConnect')!;
    expect(ruleHeading(r, (c) => lengthIn('mil', c))).toBe('Power Plane Connect Rule(Relief Connect )(Expansion=20mil) (Conductor Width=10mil) (Air Gap=10mil) (Entries=4) (All)');
  });
});
