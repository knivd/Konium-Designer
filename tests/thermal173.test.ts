import { describe, expect, it } from 'vitest';
import { readPcbDoc, encodeFill } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { addPrimRecords, addVias } from '../src/model/pcbEdit';
import { mil, mm } from '../src/core/units';
import { L } from '../src/model/layers';
import type { PcbDocument } from '../src/model/pcb';
import { solve } from '../src/analysis/pcg';
import { K_COPPER, analyseThermal, buildThermal, copperHeat, nodeAt, partNodes, stillAir, temperatureAt, warmUp, type ThermalSetup } from '../src/analysis/thermal';
import { DEFAULT_LIMITS, analyseRail, type RailSetup } from '../src/analysis/rail';
import { span, thermalIssues, thermalPixels, thermalReport } from '../src/analysis/thermalMap';
import { defaultThermalForm, formThermal, thermalLimits, thermalProbe, thermalScale } from '../src/app/thermalRun';

const O = mil(1000);
const P = (x: number, y: number) => ({ x: O + mm(x), y: O + mm(y) });
/** A bare two-layer board of a given size (mm), its corner at the origin used here. */
function board(w: number, h: number): PcbDocument {
  const doc = readPcbDoc(newPcbDocBytes('T.PcbDoc'), 'T.PcbDoc');
  doc.board.outline = [P(0, 0), P(w, 0), P(w, h), P(0, h)];
  return doc;
}
const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const comp = (doc: PcbDocument, d: string) => doc.components.findIndex((c) => c.designator === d);

describe('the board as a thermal network (26.173)', () => {
  it('heat spread evenly leaves by the two faces: the mean rise is the heat over the faces\' coefficients', () => {
    const doc = board(60, 40), m = buildThermal(doc, { cells: 6000 })!;
    expect(m.boardArea).toBeCloseTo(0.06 * 0.04, 7);
    expect(m.flatLength).toBeCloseTo((4 * 0.0024) / 0.2, 6);
    expect(m.uprightLength).toBeCloseTo(0.06, 6);
    expect(m.count).toBe(m.top.length * 2);
    // 100 W/m² into the top face, 12 and 8 W/m²·K from the faces
    const flow = new Float64Array(m.count), shunt = new Float64Array(m.count), held = new Float64Array(m.count).fill(NaN);
    for (const i of m.top) { flow[i] = 100 * m.area; shunt[i] = 12 * m.area; }
    for (const i of m.bottom) shunt[i] = 8 * m.area;
    const x = solve(m.count, m.links, held, flow, { shunt }).x;
    let top = 0, bot = 0;
    for (const i of m.top) top += x[i]!;
    for (const i of m.bottom) bot += x[i]!;
    top /= m.top.length; bot /= m.bottom.length;
    // What leaves is what comes in
    expect(12 * top + 8 * bot).toBeCloseTo(100, 4);
    // The top is the warmer by what the laminate between them holds back
    const through = 8 * bot, d = m.stack[0]!.toNext;
    expect(top - bot).toBeCloseTo((through * d) / 0.3, 3);
  });

  it('a strip heated at one end cools along its length as a fin does', () => {
    const doc = board(100, 10);
    // Copper over the whole top layer
    addPrimRecords(doc, [{ storage: 'Fills6', rec: encodeFill({ layer: L.TOP, a: P(0, 0), b: P(100, 10) }) }]).apply();
    const m = buildThermal(doc, { cells: 4000 })!, h = 10;
    const flow = new Float64Array(m.count), shunt = new Float64Array(m.count), held = new Float64Array(m.count).fill(NaN);
    for (const i of [...m.top, ...m.bottom]) shunt[i] = h * m.area;
    for (let cy = 0; cy < m.grid.hgt; cy++) { const i = m.nodeOf[cy * m.grid.w]!; if (i >= 0) flow[i] = 0.05; }
    const x = solve(m.count, m.links, held, flow, { shunt }).x;
    const at = (mmAlong: number) => { const i = nodeAt(m, 0, P(mmAlong, 5).x, P(mmAlong, 5).y); return x[i]!; };
    // m² = what the faces take over what the board carries along: the copper and the laminate
    const carry = K_COPPER * m.stack[0]!.thickness + 0.8 * m.stack[0]!.toNext, k = Math.sqrt((2 * h) / carry), len = 0.1;
    const fin = (a: number, b: number) => Math.cosh(k * (len - a)) / Math.cosh(k * (len - b));
    expect(at(30) / at(10) / fin(0.03, 0.01)).toBeGreaterThan(0.95);
    expect(at(30) / at(10) / fin(0.03, 0.01)).toBeLessThan(1.05);
    expect(at(70) / at(20) / fin(0.07, 0.02)).toBeGreaterThan(0.93);
    expect(at(70) / at(20) / fin(0.07, 0.02)).toBeLessThan(1.07);
    // Without the copper the heat stays where it is put
    const bare = buildThermal(board(100, 10), { cells: 4000 })!, xb = solve(bare.count, bare.links, held, flow, { shunt }).x;
    expect(xb[nodeAt(bare, 0, P(30, 5).x, P(30, 5).y)]! / xb[nodeAt(bare, 0, P(10, 5).x, P(10, 5).y)]!).toBeLessThan(at(30) / at(10) / 3);
  });

  it('vias carry heat through the board: with them the two faces are nearer one another under a hot place', () => {
    const run = (vias: boolean) => {
      const doc = board(40, 40);
      if (vias) addVias(doc, Array.from({ length: 25 }, (_, k) => ({ at: P(18.25 + (k % 5), 18.25 + Math.floor(k / 5)), diameter: mm(0.6), hole: mm(0.3) }))).apply();
      const m = buildThermal(doc, { cells: 6400 })!;
      const flow = new Float64Array(m.count), shunt = new Float64Array(m.count), held = new Float64Array(m.count).fill(NaN);
      for (const i of [...m.top, ...m.bottom]) shunt[i] = 10 * m.area;
      const hot = nodeAt(m, 0, P(20.25, 20.25).x, P(20.25, 20.25).y);
      flow[hot] = 0.5;
      const x = solve(m.count, m.links, held, flow, { shunt }).x;
      return { top: x[hot]!, bottom: x[nodeAt(m, 1, P(20.25, 20.25).x, P(20.25, 20.25).y)]! };
    };
    const bare = run(false), stitched = run(true);
    expect(bare.top - bare.bottom).toBeGreaterThan((stitched.top - stitched.bottom) * 2);
    expect(stitched.top).toBeLessThan(bare.top);
    expect(stitched.bottom).toBeGreaterThan(bare.bottom);
  });

  it('still air: the simplified relation for convection, and radiation between the face and the room', () => {
    const a = stillAir(1.32, 30, 0.1, 0.9, 25);
    expect(a.convection).toBeCloseTo(5.4936, 3);
    expect(a.radiation).toBeCloseTo(6.2831, 3);
    expect(a.h).toBeCloseTo(a.convection + a.radiation, 12);
    // A face down sheds less than a face up, an upright one a little more
    expect(stillAir(0.59, 30, 0.1, 0.9, 25).convection / a.convection).toBeCloseTo(0.59 / 1.32, 9);
    expect(stillAir(1.42, 30, 0.1, 0.9, 25).convection).toBeGreaterThan(a.convection);
    // Sixteen times the rise, twice the convection
    expect(stillAir(1.32, 16, 0.1, 0, 25).h / stillAir(1.32, 1, 0.1, 0, 25).h).toBeCloseTo(2, 9);
  });
});

describe('the demo board warm (26.173)', () => {
  const setup = (doc: PcbDocument, power: number, air: ThermalSetup['air'] = 'flat'): ThermalSetup => ({ ambient: 25, air, sources: [{ component: comp(doc, 'U1'), power, theta: 15 }], cells: 6000 });

  it('a part\'s heat goes in at its pads, and all of it leaves by the faces', () => {
    const doc = demo(), r = analyseThermal(doc, setup(doc, 1))!;
    expect(r.power).toBe(1);
    expect((r.top.loss + r.bottom.loss) / r.power).toBeCloseTo(1, 5);
    // Flat in still air the top sheds more than the bottom
    expect(r.top.convection).toBeGreaterThan(r.bottom.convection * 1.5);
    expect(r.top.radiation).toBeGreaterThan(4); expect(r.top.radiation).toBeLessThan(9);
    expect(r.rounds).toBeGreaterThan(1); expect(r.rounds).toBeLessThan(12);
    // The hottest place is under U1, on the top layer
    const u1 = doc.components[comp(doc, 'U1')]!;
    expect(r.maxAt.layer).toBe(0);
    expect(Math.hypot(r.maxAt.at.x - u1.at.x, r.maxAt.at.y - u1.at.y)).toBeLessThan(mm(6));
    expect(r.max).toBeGreaterThan(40); expect(r.max).toBeLessThan(140);
    const part = r.parts[0]!;
    expect(part.designator).toBe('U1');
    expect(part.board).toBeGreaterThan(r.mean); expect(part.boardMax).toBeGreaterThanOrEqual(part.board);
    expect(part.junction).toBeCloseTo(part.board + 15, 9);
    // Every component is given the board's temperature at its pads, the hottest first
    expect(r.components[0]!.designator).toBe('U1');
    expect(r.components.map((c) => c.designator).sort()).toEqual(['C1', 'C2', 'J1', 'U1']);
    expect(r.components.every((c) => c.t >= 25 && c.t <= r.max)).toBe(true);
    expect(temperatureAt(r, 0, u1.at.x, u1.at.y)).toBeGreaterThan(r.mean);
    expect(Number.isNaN(temperatureAt(r, 0, u1.at.x + mm(500), u1.at.y))).toBe(true);
  });

  it('twice the heat is less than twice the rise in still air, and exactly twice with coefficients given', () => {
    const doc = demo();
    const one = analyseThermal(doc, setup(doc, 0.5))!, two = analyseThermal(doc, setup(doc, 1))!;
    const ratio = (two.max - 25) / (one.max - 25);
    expect(ratio).toBeGreaterThan(1.6); expect(ratio).toBeLessThan(1.98);
    const g1 = analyseThermal(doc, setup(doc, 0.5, { top: 10, bottom: 10 }))!, g2 = analyseThermal(doc, setup(doc, 1, { top: 10, bottom: 10 }))!;
    expect((g2.max - 25) / (g1.max - 25)).toBeCloseTo(2, 5);
    expect(g1.rounds).toBe(1);
    expect(g1.top.h).toBe(10);
    // Moving air cools: three times the coefficient, well under the rise
    const fan = analyseThermal(doc, setup(doc, 1, { top: 30, bottom: 30 }))!;
    expect(fan.max - 25).toBeLessThan((g2.max - 25) * 0.8);
    // Upright, both faces shed alike
    const up = analyseThermal(doc, setup(doc, 1, 'upright'))!;
    expect(up.top.convection / up.bottom.convection).toBeGreaterThan(0.9);
    expect(up.top.convection / up.bottom.convection).toBeLessThan(1.15);
  });

  it('the copper\'s own loss is heat where it arises, and warm copper drops more', () => {
    const doc = demo(), net = (n: string) => doc.nets.findIndex((x) => x.name === n);
    const rail: RailSetup = { supply: net('VIN'), ret: net('GND'), source: comp(doc, 'J1'), voltage: 5, loads: [{ component: comp(doc, 'U1'), current: 3 }], temperature: 25, plating: 25, cells: 30_000, limits: { ...DEFAULT_LIMITS } };
    const cold = analyseRail(doc, rail)!;
    const m = buildThermal(doc, { cells: 6000 })!, flow = new Float64Array(m.count);
    const put = copperHeat(m, cold.supply, flow) + copperHeat(m, cold.ret!, flow);
    expect(put / cold.loss).toBeCloseTo(1, 6);
    let sum = 0;
    for (const w of flow) sum += w;
    expect(sum).toBeCloseTo(put, 9);
    const r = analyseThermal(doc, { ambient: 25, air: 'flat', sources: [], copper: [cold.supply, cold.ret!], cells: 6000 }, m)!;
    expect(r.power).toBe(0);
    expect(r.copperPower / cold.loss).toBeCloseTo(1, 6);
    expect(r.max).toBeGreaterThan(25.5);
    // The copper at the temperatures found: more drop than cold, and the same as the plain figure when the board is one temperature
    const warm = analyseRail(doc, rail, undefined, (li, x, y) => temperatureAt(r, li, x, y))!;
    expect(warm.rows[0]!.drop).toBeGreaterThan(cold.rows[0]!.drop);
    const hot = analyseRail(doc, { ...rail, temperature: 85 })!, field = analyseRail(doc, rail, undefined, () => 85)!;
    expect(field.rows[0]!.drop).toBeCloseTo(hot.rows[0]!.drop, 9);
    expect(field.peakDensity / hot.peakDensity).toBeCloseTo(1, 4);
  });

  it('a part with no pads is heated where it stands; one off the board not at all', () => {
    const doc = demo(), m = buildThermal(doc, { cells: 3000 })!;
    const at = partNodes(doc, m, comp(doc, 'U1'));
    expect(at.length).toBeGreaterThan(1);
    expect(at.reduce((s, a) => s + a.share, 0)).toBeCloseTo(1, 9);
    expect(partNodes(doc, m, 999)).toEqual([]);
  });
});

describe('warming up (26.173)', () => {
  it('a board heated evenly rises as one lump: 63 % of the way after its time constant', () => {
    const doc = demo();
    // Every part heated a little, coefficients given: near enough even for the lump to hold on the mean
    const steady = analyseThermal(doc, { ambient: 20, air: { top: 10, bottom: 10 }, sources: [{ component: comp(doc, 'U1'), power: 0.5 }], cells: 3000 })!;
    const w = warmUp(doc, steady);
    // The demo board: 40 by 25 mm, its laminate and copper a few joules a degree, its faces 0.02 W a degree
    expect(w.lump).toBeGreaterThan(20); expect(w.lump).toBeLessThan(400);
    expect(w.times[0]).toBe(0); expect(w.max[0]).toBe(20);
    for (let k = 1; k < w.times.length; k++) { expect(w.times[k]!).toBeGreaterThan(w.times[k - 1]!); expect(w.max[k]!).toBeGreaterThanOrEqual(w.max[k - 1]! - 1e-9); }
    // It ends at the settled figure
    expect(w.max[w.max.length - 1]! - 20).toBeGreaterThan((steady.max - 20) * 0.985);
    expect(w.max[w.max.length - 1]!).toBeLessThanOrEqual(steady.max + 1e-6);
    // The hot place itself warms sooner than the lump (it is fed from close by), the board as a whole by the lump
    expect(w.half).toBeGreaterThan(0); expect(w.half).toBeLessThan(w.lump);
    expect(w.most).toBeGreaterThan(w.half); expect(w.most).toBeLessThan(w.lump * 4);
    expect(w.parts[0]!.designator).toBe('U1');
    expect(w.parts[0]!.t.length).toBe(w.times.length);
  });

  it('the lump itself: one cell deep in a uniform board follows 1 − e^(−t/τ) within a few per cent', () => {
    const doc = board(30, 30), m = buildThermal(doc, { cells: 900 })!;
    // Heat every cell alike through a made-up settled analysis
    const steadyFlow = new Float64Array(m.count), shunt = new Float64Array(m.count), held = new Float64Array(m.count).fill(NaN);
    for (const i of m.top) { steadyFlow[i] = 200 * m.area; shunt[i] = 10 * m.area; }
    for (const i of m.bottom) shunt[i]! += 10 * m.area;
    const xs = solve(m.count, m.links, held, steadyFlow, { shunt }).x;
    let cap = 0;
    for (const c of m.capacity) cap += c;
    const tau = cap / (20 * m.boardArea);
    // Implicit steps as the analysis takes them
    let x: Float64Array = new Float64Array(m.count), t = 0, dt = tau / 200;
    const sh = new Float64Array(m.count), rhs = new Float64Array(m.count), probe = m.top[Math.floor(m.top.length / 2)]!;
    let worst = 0;
    for (let k = 0; k < 40; k++) {
      for (let i = 0; i < m.count; i++) { const c = m.capacity[i]! / dt; sh[i] = shunt[i]! + c; rhs[i] = steadyFlow[i]! + c * x[i]!; }
      x = solve(m.count, m.links, held, rhs, { shunt: sh, start: x }).x;
      t += dt; dt *= 1.2;
      const want = xs[probe]! * (1 - Math.exp(-t / tau));
      if (t > tau / 10) worst = Math.max(worst, Math.abs(x[probe]! - want) / xs[probe]!);
    }
    expect(worst).toBeLessThan(0.04);
    expect(x[probe]! / xs[probe]!).toBeGreaterThan(0.99);
  });
});

describe('the Thermal Analysis panel\'s part (26.173)', () => {
  it('the form: what is missing said before anything runs; parts by designator', () => {
    const doc = demo(), f = defaultThermalForm();
    expect(formThermal(doc, f)).toBe('Give the dissipation of one part at least, or tick the copper\'s own heat.');
    expect(formThermal(doc, { ...f, powers: { U1: '0,5' }, air: 'given', hTop: '0' })).toBe('Give the coefficient of each face: the top\'s above 0.');
    expect(formThermal(doc, { ...f, powers: { U1: '1' }, kZ: '0' })).toMatch(/^Give the laminate/);
    const s = formThermal(doc, { ...f, powers: { U1: '0,5', R99: '2' }, thetas: { U1: '15', C1: '3' }, ambient: '40', air: 'given', hTop: '25', hBottom: '12', detail: 'draft' }) as ThermalSetup;
    expect(s.sources).toEqual([{ component: comp(doc, 'U1'), power: 0.5, theta: 15 }]);
    expect([s.ambient, s.air, s.cells, s.kInPlane, s.kThrough]).toEqual([40, { top: 25, bottom: 12 }, 10_000, 0.8, 0.3]);
    expect(formThermal(doc, { ...f, copper: true })).toMatchObject({ sources: [], air: 'flat' });
    expect(thermalLimits({ ...f, board: '85', junction: 'x' })).toEqual({ board: 85, junction: 125 });
  });

  it('the picture, the cursor\'s reading, what is over the limits, the report', () => {
    const doc = demo(), r = analyseThermal(doc, { ambient: 25, air: 'flat', sources: [{ component: comp(doc, 'U1'), power: 1, theta: 40 }], cells: 3000 })!;
    const px = thermalPixels(r, 0, 25, r.max)!;
    expect([px.width, px.height]).toEqual([r.model.grid.w, r.model.grid.hgt]);
    let solid = 0, red = 0;
    for (let i = 0; i < px.data.length; i += 4) { if (px.data[i + 3] === 255) solid++; if (px.data[i] === 224 && px.data[i + 1] === 36) red++; }
    expect(solid).toBe(r.model.top.length);
    expect(red).toBeGreaterThanOrEqual(1);
    expect(thermalPixels(r, 7, 25, 100)).toBeNull();
    const u1 = doc.components[comp(doc, 'U1')]!;
    expect(thermalProbe(r, u1.at, L.TOP)[0]).toMatch(/^\d+\.\d °C, \d+\.\d above the air$/);
    expect(thermalProbe(r, { x: u1.at.x + mm(900), y: u1.at.y }, L.TOP)).toEqual([]);
    expect(thermalScale({ result: r, limits: { board: 100, junction: 125 } }, 'limits')).toEqual([25, 100]);
    expect(thermalScale({ result: r, limits: { board: 100, junction: 125 } }, 'own')).toEqual([25, r.max]);
    const tight = thermalIssues(doc, r, { board: 40, junction: 60 }, () => 'Top Layer');
    expect(tight.map((i) => i.kind)).toEqual(['board', 'junction']);
    expect(tight[0]!.message).toMatch(/^The board reaches \d+\.\d °C on Top Layer; the limit is 40 °C$/);
    expect(tight[1]!.message).toMatch(/^U1: its junction reaches \d+\.\d °C \(the board under it \d+\.\d °C\); the limit is 60 °C$/);
    expect(tight[1]!.prims!.length).toBeGreaterThan(1);
    expect(thermalIssues(doc, r, { board: 500, junction: 500 })).toEqual([]);
    const text = thermalReport(doc, r, 'Demo.PcbDoc', { board: 100, junction: 125 }, () => 'Top Layer', warmUp(doc, r));
    expect(text.split('\n')[0]).toBe('Thermal Analysis: Demo.PcbDoc');
    expect(text).toMatch(/Air {13}25 °C, still, the board lying flat/);
    expect(text).toMatch(/U1 {8}1 W {7}\d+\.\d °C/);
    expect(text).toMatch(/Warm-up: the hottest place is half way in \d+ s/);
    expect(text).not.toMatch(/NaN|undefined/);
    expect([span(12.4), span(90), span(200), span(NaN)]).toEqual(['12 s', '1 min 30 s', '3 min 20 s', 'longer than was worked']);
  });
});
