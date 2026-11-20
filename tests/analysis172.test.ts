import { describe, expect, it } from 'vitest';
import { readPcbDoc, encodeFill, encodeRegion } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { addNet, addPads, addPrimRecords, addTracks, addVias } from '../src/model/pcbEdit';
import { mil, mm } from '../src/core/units';
import { L } from '../src/model/layers';
import { NO_NET, inPour, type PcbDocument } from '../src/model/pcb';
import { link, newLinks, solve, solver } from '../src/analysis/pcg';
import { copperSigma, gridFor, stackCopper } from '../src/analysis/copperNet';
import { analysePower, type PowerResult } from '../src/analysis/power';
import { DEFAULT_LIMITS, analyseRail, componentsOn, groundName, ipc2221, railNets, railReport, railSetups, type RailSetup } from '../src/analysis/rail';
import { areaPixels, probe, ramp, trackValues } from '../src/analysis/powerMap';
import { defaultForm, formRail, probeLines, scaleMax } from '../src/app/powerRun';

const O = mil(1000);
const P = (x: number, y: number) => ({ x: O + mm(x), y: O + mm(y) });

function board(): { doc: PcbDocument; net: number } {
  const doc = readPcbDoc(newPcbDocBytes('T.PcbDoc'), 'T.PcbDoc');
  addNet(doc, 'VCC').apply();
  return { doc, net: doc.nets.length - 1 };
}
const pad = (doc: PcbDocument, name: string) => doc.prims.findIndex((p) => p.kind === 'pad' && p.name === name);
/** One source pad at 5 V and one load of 1 A: the resistance between them, ohms. */
function between(doc: PcbDocument, net: number, cells?: number): { r: number; res: PowerResult } {
  const res = analysePower(doc, { net, sources: [{ pads: [pad(doc, 'S')], voltage: 5 }], loads: [{ name: 'L', pads: [pad(doc, 'L')], current: 1 }], cells })!;
  return { r: 5 - res.loads[0]!.voltage, res };
}
/** Ohms per square of 35 µm copper at 25 °C. */
const SQUARE = 1 / (copperSigma(25) * 35e-6);

describe('the network solver', () => {
  it('a chain of resistors divides the voltage, and an island with nothing held has no potential', () => {
    const l = newLinks(4);
    link(l, 0, 1, 1); link(l, 1, 2, 2); link(l, 2, 3, 1); link(l, 4, 5, 1);
    const held = new Float64Array(6).fill(NaN), flow = new Float64Array(6);
    held[0] = 10; held[3] = 0;
    const s = solve(6, l, held, flow);
    // 1 Ω, 0.5 Ω, 1 Ω in series: 4 A
    expect(s.x[1]).toBeCloseTo(6, 6);
    expect(s.x[2]).toBeCloseTo(4, 6);
    expect(Number.isNaN(s.x[4]!)).toBe(true);
    expect(s.residual).toBeLessThan(1e-8);
  });

  it('a current drawn from a node pulls it down by the resistance to the held one; steps add up to the same', () => {
    const l = newLinks();
    for (let i = 0; i < 50; i++) link(l, i, i + 1, 10);
    const held = new Float64Array(51).fill(NaN), flow = new Float64Array(51);
    held[0] = 1; flow[50] = -2;
    const s = solve(51, l, held, flow);
    expect(s.x[50]).toBeCloseTo(1 - 2 * 5, 6);
    const st = solver(51, l, held, flow);
    let rounds = 0;
    while (!st.step(3)) rounds++;
    expect(rounds).toBeGreaterThan(1);
    expect(st.result().x[25]).toBeCloseTo(s.x[25]!, 6);
  });
});

describe('a net\'s copper as a network (26.172)', () => {
  it('the stack of a new board: two copper layers with thickness and the board between them', () => {
    const { doc } = board(), st = stackCopper(doc);
    expect(st.length).toBe(2);
    expect(st[0]!.thickness).toBeGreaterThan(10e-6);
    expect(st[0]!.thickness).toBeLessThan(110e-6);
    expect(st[0]!.toNext).toBeGreaterThan(0.2e-3);
    expect(st[0]!.toNext).toBeLessThan(3.5e-3);
  });

  it('a strip of copper area: its length over its width, in squares', () => {
    const { doc, net } = board();
    addPrimRecords(doc, [{ storage: 'Fills6', rec: encodeFill({ layer: L.TOP, a: P(0, 0), b: P(20, 2), net }) }]).apply();
    addPads(doc, [{ name: 'S', layer: L.TOP, at: P(0.5, 1), w: mm(1), h: mm(2), shape: 'rect', net }, { name: 'L', layer: L.TOP, at: P(19.5, 1), w: mm(1), h: mm(2), shape: 'rect', net }]).apply();
    const t = stackCopper(doc)[0]!.thickness, sq = 1 / (copperSigma(25) * t);
    const { r, res } = between(doc, net);
    // 18 mm between the pads and a third of the load's own millimetre (its current is taken evenly over it), 2 mm wide
    expect(r / (sq * (18 + 1 / 3) / 2)).toBeGreaterThan(0.98);
    expect(r / (sq * (18 + 1 / 3) / 2)).toBeLessThan(1.02);
    // The copper's heat is the current times the drop
    expect(res.loss).toBeCloseTo(r * 1, 6);
    // 1 A through 2 mm of the layer's copper
    const mid = res.density[res.cn.grid.w * Math.floor(res.cn.grid.hgt / 2) + Math.floor(res.cn.grid.w / 2)]!;
    expect(mid / (1 / (2e-3 * t))).toBeGreaterThan(0.97);
    expect(mid / (1 / (2e-3 * t))).toBeLessThan(1.03);
    expect(res.sourceCurrent).toBe(1);
    expect(res.maxV).toBeCloseTo(5, 9);
  });

  it('a thin track is its exact length over its width, straight or at any angle', () => {
    const run = (bx: number, by: number) => {
      const { doc, net } = board();
      addTracks(doc, [{ layer: L.TOP, a: P(0, 0), b: P(bx, by), width: mm(0.2), net }]).apply();
      addPads(doc, [{ name: 'S', layer: L.TOP, at: P(0, 0), w: mm(1), h: mm(1), shape: 'round', net }, { name: 'L', layer: L.TOP, at: P(bx, by), w: mm(1), h: mm(1), shape: 'round', net }]).apply();
      const sq = 1 / (copperSigma(25) * stackCopper(doc)[0]!.thickness);
      return between(doc, net).r / sq;
    };
    // 20 mm less the two half pads: 19 mm of 0.2 mm track is 95 squares
    const straight = run(20, 0), slant = run(16, 12), odd = run(19.2, 5.6);
    expect(straight).toBeGreaterThan(95 * 0.985); expect(straight).toBeLessThan(95 * 1.02);
    expect(slant / straight).toBeGreaterThan(0.99); expect(slant / straight).toBeLessThan(1.01);
    expect(odd / straight).toBeGreaterThan(0.99); expect(odd / straight).toBeLessThan(1.01);
  });

  it('a via between two tracks adds its barrel: the wall\'s copper over the board\'s thickness', () => {
    const { doc, net } = board();
    addTracks(doc, [{ layer: L.TOP, a: P(0, 0), b: P(10, 0), width: mm(0.5), net }, { layer: L.BOTTOM, a: P(10, 0), b: P(20, 0), width: mm(0.5), net }]).apply();
    addVias(doc, [{ at: P(10, 0), diameter: mm(0.6), hole: mm(0.3), net }]).apply();
    addPads(doc, [{ name: 'S', layer: L.TOP, at: P(0, 0), w: mm(1), h: mm(1), shape: 'round', net }, { name: 'L', layer: L.BOTTOM, at: P(20, 0), w: mm(1), h: mm(1), shape: 'round', net }]).apply();
    const st = stackCopper(doc), sig = copperSigma(25);
    const barrel = st[0]!.toNext / (sig * Math.PI * (0.3e-3 + 25e-6) * 25e-6);
    const tracks = (9.5 - 0.3) / 0.5 / (sig * st[0]!.thickness) + (9.5 - 0.3) / 0.5 / (sig * st[1]!.thickness);
    const { r, res } = between(doc, net);
    expect(barrel).toBeGreaterThan(0.1e-3);
    expect(r).toBeGreaterThan((tracks + barrel) * 0.97);
    expect(r).toBeLessThan((tracks + barrel) * 1.06);
    expect(res.cn.barrels.length).toBe(1);
    expect(res.barrelCurrent[0]).toBeCloseTo(1, 4);
    // Thicker plating, less drop
    const thick = analysePower(doc, { net, sources: [{ pads: [pad(doc, 'S')], voltage: 5 }], loads: [{ name: 'L', pads: [pad(doc, 'L')], current: 1 }], plating: 50e-6 })!;
    expect(5 - thick.loads[0]!.voltage).toBeLessThan(r - barrel * 0.4);
  });

  it('a right-angled bend in a copper area counts as 0.56 of a square', () => {
    const { doc, net } = board();
    // Two arms 1 mm wide, 10 mm along their middles from the corner's middle
    addPrimRecords(doc, [{ storage: 'Regions6', rec: encodeRegion({ layer: L.TOP, net, outline: [P(0, 0), P(10.5, 0), P(10.5, 10.5), P(9.5, 10.5), P(9.5, 1), P(0, 1)] }) }]).apply();
    addPads(doc, [{ name: 'S', layer: L.TOP, at: P(0.25, 0.5), w: mm(0.5), h: mm(1), shape: 'rect', net }, { name: 'L', layer: L.TOP, at: P(10, 10.25), w: mm(1), h: mm(0.5), shape: 'rect', net }]).apply();
    const sq = 1 / (copperSigma(25) * stackCopper(doc)[0]!.thickness);
    // From the source pad's edge to the corner square 9 mm, the corner, then 9 mm to the load's edge and a third of its half millimetre
    const want = 9 + 0.56 + 9 + 0.5 / 3;
    const fine = between(doc, net).r / sq, coarse = between(doc, net, 6000).r / sq;
    expect(fine / want).toBeGreaterThan(0.98); expect(fine / want).toBeLessThan(1.02);
    // A grid three times coarser says nearly the same
    expect(coarse / fine).toBeGreaterThan(0.97); expect(coarse / fine).toBeLessThan(1.03);
  });

  it('tracks join where one ends on another, where they cross and where one stops at a pad\'s edge; copper apart is not joined', () => {
    const { doc, net } = board();
    addTracks(doc, [
      { layer: L.TOP, a: P(0, 0), b: P(20, 0), width: mm(0.3), net },
      // Ends on the middle of the first
      { layer: L.TOP, a: P(10, 0), b: P(10, 8), width: mm(0.3), net },
      // Crosses the second with no end there
      { layer: L.TOP, a: P(6, 4), b: P(14, 4), width: mm(0.3), net },
      // Stops at the edge of pad B, its end outside the pad
      { layer: L.TOP, a: P(14, 4), b: P(17.4, 4), width: mm(0.3), net },
      // Apart from all of it
      { layer: L.TOP, a: P(0, 12), b: P(5, 12), width: mm(0.3), net },
    ]).apply();
    addPads(doc, [
      { name: 'S', layer: L.TOP, at: P(0, 0), w: mm(1), h: mm(1), shape: 'round', net },
      { name: 'A', layer: L.TOP, at: P(10, 8), w: mm(1), h: mm(1), shape: 'round', net },
      { name: 'B', layer: L.TOP, at: P(18, 4), w: mm(1), h: mm(1), shape: 'rect', net },
      { name: 'C', layer: L.TOP, at: P(5, 12), w: mm(1), h: mm(1), shape: 'round', net },
    ]).apply();
    const res = analysePower(doc, { net, sources: [{ pads: [pad(doc, 'S')], voltage: 3.3 }], loads: ['A', 'B', 'C'].map((n) => ({ name: n, pads: [pad(doc, n)], current: 0.5 })) })!;
    const [a, b, c] = res.loads;
    expect(a!.connected).toBe(true); expect(b!.connected).toBe(true); expect(c!.connected).toBe(false);
    expect(Number.isNaN(c!.voltage)).toBe(true);
    expect(res.sourceCurrent).toBe(1);
    const sq = 1 / (copperSigma(25) * stackCopper(doc)[0]!.thickness), w = 0.3;
    // To A: 9.5 mm carrying 1 A, 4 mm carrying 1 A, 3.5 mm carrying 0.5 A
    expect((3.3 - a!.voltage) / (sq * (9.5 + 4 + 3.5 * 0.5) / w)).toBeGreaterThan(0.97);
    expect((3.3 - a!.voltage) / (sq * (9.5 + 4 + 3.5 * 0.5) / w)).toBeLessThan(1.03);
    // To B: the same 13.5 mm at 1 A, then 4 + 3.4 mm at 0.5 A
    expect((3.3 - b!.voltage) / (sq * (9.5 + 4 + 7.4 * 0.5) / w)).toBeGreaterThan(0.97);
    expect((3.3 - b!.voltage) / (sq * (9.5 + 4 + 7.4 * 0.5) / w)).toBeLessThan(1.04);
    // The copper's heat is what the loads lose
    expect(res.loss).toBeCloseTo(0.5 * (3.3 - a!.voltage) + 0.5 * (3.3 - b!.voltage), 6);
    // The hardest worked copper is the track carrying the whole ampere
    expect(res.peak!.density / (1 / (0.3e-3 * stackCopper(doc)[0]!.thickness))).toBeCloseTo(1, 2);
  });

  it('a track over a copper area adds nothing to it, and hot copper drops more', () => {
    const make = (withTrack: boolean) => {
      const { doc, net } = board();
      addPrimRecords(doc, [{ storage: 'Fills6', rec: encodeFill({ layer: L.TOP, a: P(0, 0), b: P(20, 2), net }) }]).apply();
      if (withTrack) addTracks(doc, [{ layer: L.TOP, a: P(0.5, 1), b: P(19.5, 1), width: mm(1), net }]).apply();
      addPads(doc, [{ name: 'S', layer: L.TOP, at: P(0.5, 1), w: mm(1), h: mm(2), shape: 'rect', net }, { name: 'L', layer: L.TOP, at: P(19.5, 1), w: mm(1), h: mm(2), shape: 'rect', net }]).apply();
      return { doc, net };
    };
    const plain = make(false), over = make(true);
    const r0 = between(plain.doc, plain.net).r, r1 = between(over.doc, over.net).r;
    expect(r1 / r0).toBeGreaterThan(0.995); expect(r1 / r0).toBeLessThan(1.005);
    const hot = analysePower(plain.doc, { net: plain.net, sources: [{ pads: [pad(plain.doc, 'S')], voltage: 5 }], loads: [{ name: 'L', pads: [pad(plain.doc, 'L')], current: 1 }], temperature: 105 })!;
    // 0.393 % a degree from 20 °C: 80 degrees hotter than 25
    expect((5 - hot.loads[0]!.voltage) / r0).toBeCloseTo((1 + 0.00393 * 85) / (1 + 0.00393 * 5), 3);
    expect(SQUARE).toBeGreaterThan(0.45e-3);
  });

  it('a return net: currents put in at the loads raise their ground above the source\'s', () => {
    const { doc, net } = board();
    addTracks(doc, [{ layer: L.TOP, a: P(0, 0), b: P(20, 0), width: mm(0.5), net }]).apply();
    addPads(doc, [{ name: 'S', layer: L.TOP, at: P(0, 0), w: mm(1), h: mm(1), shape: 'round', net }, { name: 'L', layer: L.TOP, at: P(20, 0), w: mm(1), h: mm(1), shape: 'round', net }]).apply();
    const res = analysePower(doc, { net, sources: [{ pads: [pad(doc, 'S')], voltage: 0 }], loads: [{ name: 'L', pads: [pad(doc, 'L')], current: -2 }] })!;
    const sq = 1 / (copperSigma(25) * stackCopper(doc)[0]!.thickness);
    expect(res.loads[0]!.voltage / (2 * sq * 19 / 0.5)).toBeGreaterThan(0.98);
    expect(res.loads[0]!.voltage / (2 * sq * 19 / 0.5)).toBeLessThan(1.02);
    expect(res.minV).toBe(0);
  });

  it('the demo board\'s ground: every pad of it joined, in a second or two', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const net = doc.nets.findIndex((n) => n.name === 'GND');
    expect(net).toBeGreaterThanOrEqual(0);
    const pads = doc.prims.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'pad' && p.net === net).map(({ i }) => i);
    expect(pads.length).toBeGreaterThan(3);
    expect(gridFor(doc, new Set([net]))).not.toBeNull();
    const t0 = performance.now();
    const res = analysePower(doc, { net, sources: [{ pads: [pads[0]!], voltage: 0 }], loads: pads.slice(1).map((i) => ({ name: String(i), pads: [i], current: -0.1 })) })!;
    const ms = performance.now() - t0;
    expect(res.missing).toEqual([]);
    expect(res.loads.filter((l) => !l.connected).map((l) => l.name)).toEqual([]);
    expect(res.residual).toBeLessThan(1e-7);
    expect(res.maxV).toBeGreaterThan(0);
    expect(res.maxV).toBeLessThan(0.05);
    expect(ms).toBeLessThan(8000);
  });
});

describe('pours, planes and what is not copper (26.172)', () => {
  const demo = () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'), net = doc.nets.findIndex((n) => n.name === 'GND');
    const pads = doc.prims.map((p, i) => ({ p, i })).filter(({ p }) => p.kind === 'pad' && p.net === net).map(({ i }) => i);
    const run = () => analysePower(doc, { net, sources: [{ pads: [pads[0]!], voltage: 0 }], loads: pads.slice(1).map((i) => ({ name: String(i), pads: [i], current: -0.1 })) })!;
    return { doc, net, run };
  };

  it('pour copper with no net of its own is its polygon\'s, as older boards keep it', () => {
    const { doc, run } = demo();
    const before = run();
    let stripped = 0;
    for (const p of doc.prims) if ('net' in p && inPour(p)) { p.net = NO_NET; stripped++; }
    expect(stripped).toBeGreaterThan(0);
    const after = run();
    expect(after.loads.every((l) => l.connected)).toBe(true);
    expect(after.cn.count).toBe(before.cn.count);
    expect(after.maxV).toBeCloseTo(before.maxV, 9);
  });

  it('a shelved polygon\'s copper is out of the design: the net is left with its tracks and pads', () => {
    const { doc, run } = demo();
    const whole = run();
    doc.polygons[0]!.bag.set('SHELVED', 'TRUE');
    const without = run();
    expect(without.cn.count).toBeLessThan(whole.cn.count / 2);
    // What the pour carried the tracks now carry alone, or nothing does
    expect(without.loads.some((l) => !l.connected) || without.maxV > whole.maxV * 1.2).toBe(true);
  });

  it('a plane of the net joins the holes that pass through it; without one they are apart', () => {
    const { doc, net } = board();
    doc.board.copperStack = [L.TOP, L.PLANE1, L.BOTTOM];
    addPads(doc, [{ name: 'S', layer: L.MULTI, at: P(10, 10), w: mm(1.6), h: mm(1.6), shape: 'round', hole: mm(0.8), net }, { name: 'L', layer: L.MULTI, at: P(40, 30), w: mm(1.6), h: mm(1.6), shape: 'round', hole: mm(0.8), net }]).apply();
    expect(between(doc, net).res.loads[0]!.connected).toBe(false);
    doc.board.bag!.set('PLANE1NETNAME', 'VCC');
    // (the plane's copper is worked out afresh for the changed board)
    const again = readPcbDoc(newPcbDocBytes('T.PcbDoc'), 'T.PcbDoc');
    addNet(again, 'VCC').apply();
    again.board.copperStack = [L.TOP, L.PLANE1, L.BOTTOM];
    again.board.bag!.set('PLANE1NETNAME', 'VCC');
    addPads(again, [{ name: 'S', layer: L.MULTI, at: P(10, 10), w: mm(1.6), h: mm(1.6), shape: 'round', hole: mm(0.8), net }, { name: 'L', layer: L.MULTI, at: P(40, 30), w: mm(1.6), h: mm(1.6), shape: 'round', hole: mm(0.8), net }]).apply();
    const { r, res } = between(again, net);
    expect(res.loads[0]!.connected).toBe(true);
    // Through two reliefs and a sheet of copper: a few milliohms, and the barrels carry the ampere
    expect(r).toBeGreaterThan(0.0005);
    expect(r).toBeLessThan(0.02);
    expect(Math.max(...res.barrelCurrent)).toBeCloseTo(1, 3);
    expect(res.cn.fine).toBeNull();
  });
});

describe('a supply rail and its limits (26.172)', () => {
  it('IPC-2221: what raises a conductor ten degrees, outside the board and inside it', () => {
    // A 10 mil track of 1 oz copper (1.378 mil): 13.78 square mils
    const a = 13.78 * 6.4516e-10;
    expect(ipc2221(a, 10, false)).toBeCloseTo(0.886, 2);
    expect(ipc2221(a, 10, true)).toBeCloseTo(0.443, 2);
    expect(ipc2221(a, 20, false) / ipc2221(a, 10, false)).toBeCloseTo(2 ** 0.44, 6);
    expect(ipc2221(a * 2, 10, false) / ipc2221(a, 10, false)).toBeCloseTo(2 ** 0.725, 6);
  });

  const demoRail = (current = 0.8): { doc: PcbDocument; rail: RailSetup } => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const net = (n: string) => doc.nets.findIndex((x) => x.name === n), comp = (d: string) => doc.components.findIndex((c) => c.designator === d);
    return { doc, rail: { supply: net('VIN'), ret: net('GND'), source: comp('J1'), voltage: 5, loads: [{ component: comp('U1'), current }, { component: comp('C1'), current: 0 }], temperature: 25, plating: 25, cells: 30_000, limits: { ...DEFAULT_LIMITS } } };
  };

  it('the nets and components offered: grounds known by name, the components on a net in order', () => {
    const { doc, rail } = demoRail();
    const nets = railNets(doc);
    expect(nets.map((n) => n.name)).toEqual(['GND', 'VIN', '+3V3']);
    expect(nets[0]!.components).toBe(4);
    expect(['GND', 'AGND', 'PGND', 'VSS', 'DGND', 'GND_ISO'].every(groundName)).toBe(true);
    expect(['VIN', '+3V3', 'SIGNAL', 'AGC'].some(groundName)).toBe(false);
    const on = componentsOn(doc, rail.supply);
    expect(on.map((c) => c.designator)).toEqual(['C1', 'J1', 'U1']);
    expect(on.find((c) => c.designator === 'U1')!.comment).toBe('LDO 3V3');
    expect(on.every((c) => c.pads.length === c.pins.length && c.pads.length >= 1)).toBe(true);
  });

  it('a rail is two sums: the supply\'s drop and the return\'s rise, taken together at each load', () => {
    const { doc, rail } = demoRail();
    const s = railSetups(doc, rail);
    // (a load that draws nothing is left out; the return's currents go the other way)
    expect(s.supply.loads.map((l) => [l.name, l.current])).toEqual([['U1', 0.8]]);
    expect(s.ret!.loads.map((l) => [l.name, l.current])).toEqual([['U1', -0.8]]);
    expect(s.ret!.sources[0]!.voltage).toBe(0);
    const r = analyseRail(doc, rail, (l) => (l === L.TOP ? 'Top Layer' : 'Bottom Layer'))!;
    const row = r.rows[0]!;
    expect(row.designator).toBe('U1');
    expect(row.state).toBe('ok');
    expect(row.supplyV).toBeLessThan(5); expect(row.supplyV).toBeGreaterThan(4.95);
    expect(row.returnV).toBeGreaterThan(0); expect(row.returnV).toBeLessThan(0.02);
    expect(row.voltage).toBeCloseTo(row.supplyV - row.returnV, 12);
    expect(row.drop).toBeCloseTo(5 - row.voltage, 12);
    expect(row.percent).toBeCloseTo((row.drop / 5) * 100, 9);
    expect(r.current).toBe(0.8);
    expect(r.loss).toBeCloseTo(r.supply.loss + r.ret!.loss, 12);
    // What the copper turns to heat is the current times what the load has lost (one load, one pad on each net)
    expect(r.loss / (0.8 * row.drop)).toBeGreaterThan(0.98);
    expect(r.loss / (0.8 * row.drop)).toBeLessThan(1.02);
    // Twice the current, twice the drop
    const twice = analyseRail(doc, demoRail(1.6).rail)!;
    expect(twice.rows[0]!.drop / row.drop).toBeCloseTo(2, 4);
  });

  it('out of limits: a load short of its voltage, a track and a via past their rise, an area past its density', () => {
    const { doc, rail } = demoRail(6);
    rail.limits = { drop: 1, rise: 10, density: 20 };
    const r = analyseRail(doc, rail, (l) => (l === L.TOP ? 'Top Layer' : 'Bottom Layer'))!;
    expect(r.rows[0]!.state).toBe('over');
    const kinds = new Set(r.issues.map((i) => i.kind));
    expect(kinds.has('drop')).toBe(true);
    expect(kinds.has('track')).toBe(true);
    expect(kinds.has('density')).toBe(true);
    const drop = r.issues.find((i) => i.kind === 'drop')!, track = r.issues.find((i) => i.kind === 'track')!;
    expect(drop.message).toMatch(/^U1: \d\.\d{3} V, \d+\.\d mV \(\d+\.\d %\) below the source; the limit is 1 %$/);
    expect(track.message).toMatch(/^VIN: a track on Top Layer carries 6\.00 A; \d+\.\d\d A raises it 10 °C$/);
    expect(track.box && track.prims?.length).toBeTruthy();
    expect(doc.prims[track.prims![0]!]!.kind).toBe('track');
    // Within generous limits, nothing to say
    const calm = demoRail(0.05);
    calm.rail.limits = { drop: 5, rise: 40, density: 500 };
    expect(analyseRail(calm.doc, calm.rail)!.issues).toEqual([]);
  });

  it('a load with no copper to the source is said to be not joined, and on which net', () => {
    const { doc, rail } = demoRail();
    const c2 = doc.components.findIndex((c) => c.designator === 'C2');
    // +3V3 is fed by U1; taken as the supply with J1 (not on it) as a load there is nothing to compare, so: VIN with C2 (not on VIN)
    rail.loads.push({ component: c2, current: 0.1 });
    const r = analyseRail(doc, rail)!;
    const row = r.rows.find((x) => x.designator === 'C2')!;
    expect(row.state).toBe('open'); expect(row.open).toBe('supply');
    expect(r.issues.some((i) => i.kind === 'open' && /^C2: no copper joins it to J1 on VIN$/.test(i.message))).toBe(true);
    expect(r.current).toBe(0.8);
  });

  it('a source with no pad on the return net: the supply is worked alone, and it is said', () => {
    const { doc, rail } = demoRail();
    // C2 is on +3V3 and GND, not on VIN: as the "source" of VIN it has no supply pad either; take +3V3 fed by U1 returning on VIN, which U1 is on, then on a net it is not
    const net = (n: string) => doc.nets.findIndex((x) => x.name === n), comp = (d: string) => doc.components.findIndex((c) => c.designator === d);
    const odd = { ...rail, supply: net('VIN'), ret: net('+3V3'), source: comp('J1'), loads: [{ component: comp('U1'), current: 0.5 }] };
    const r = analyseRail(doc, odd)!;
    expect(r.ret).toBeNull();
    expect(r.rows[0]!.state).toBe('ok'); expect(r.rows[0]!.returnV).toBe(0);
    expect(r.issues[0]!.message).toBe('J1 has no pad on +3V3: the return net is left out, and each load\'s voltage is the supply\'s alone');
  });

  it('the report: the set-up, each load, what is out of limits', () => {
    const { doc, rail } = demoRail();
    const text = railReport(doc, analyseRail(doc, rail)!, 'Demo.PcbDoc');
    expect(text.split('\n')[0]).toBe('Power Analysis: Demo.PcbDoc');
    expect(text).toMatch(/Supply net {6}VIN/);
    expect(text).toMatch(/Return net {6}GND/);
    expect(text).toMatch(/Source {10}J1 at 5 V/);
    expect(text).toMatch(/U1 {8}0\.8 A {6}4\.\d{4} V/);
    expect(text).toMatch(/IPC-2221/);
    expect(text).not.toMatch(/NaN|undefined/);
  });

  it('the picture: copper coloured from blue to red, clear off the copper; the place under the cursor read', () => {
    expect(ramp(0)).toEqual([29, 63, 191]);
    expect(ramp(1)).toEqual([224, 36, 27]);
    expect(ramp(7)).toEqual(ramp(1)); expect(ramp(NaN)).toEqual(ramp(0));
    const { doc, rail } = demoRail();
    const r = analyseRail(doc, rail)!;
    const max = scaleMax(r, 'drop', 'own');
    expect(max).toBeGreaterThan(0.005);
    expect(scaleMax(r, 'drop', 'limits')).toBeCloseTo(0.15, 9);
    expect(scaleMax(r, 'density', 'limits')).toBe(50e6);
    const px = areaPixels(r.ret!, 0, 'drop', max)!;
    expect(px.width).toBe(r.ret!.cn.grid.w * 3); expect(px.height).toBe(r.ret!.cn.grid.hgt * 3);
    let clear = 0, solid = 0;
    for (let i = 3; i < px.data.length; i += 4) { if (px.data[i] === 0) clear++; else if (px.data[i] === 255) solid++; }
    expect(clear).toBeGreaterThan(100); expect(solid).toBeGreaterThan(1000); expect(clear + solid).toBe(px.width * px.height);
    // The supply's long track on the top layer: its drop grows from one end to the other
    const k = r.supply.cn.tracks.findIndex((t) => Math.hypot(t.b.x - t.a.x, t.b.y - t.a.y) > mm(5));
    const v = trackValues(r.supply, k, 'drop')!, t = r.supply.cn.tracks[k]!;
    expect(Math.abs(v[1] - v[0])).toBeGreaterThan(0.001);
    expect(trackValues(r.supply, k, 'density')![0] / (0.8 / (t.width * 2.54e-9 * r.supply.cn.stack[0]!.thickness))).toBeCloseTo(1, 5);
    const mid = { x: (t.a.x + t.b.x) / 2, y: (t.a.y + t.b.y) / 2 };
    const at = probe(r.supply, mid, t.layer)!;
    expect(at.current).toBeCloseTo(0.8, 6);
    expect(at.voltage).toBeLessThan(5); expect(at.voltage).toBeGreaterThan(4.9);
    expect(probe(r.supply, { x: mid.x, y: mid.y + mm(30) }, t.layer)).toBeNull();
    const lines = probeLines(doc, r, mid, L.TOP);
    expect(lines.some((l) => /^VIN: 4\.\d{4} V, \d+\.\d\d mV from the source$/.test(l))).toBe(true);
    expect(lines.some((l) => /A\/mm², 800 mA in the track$/.test(l))).toBe(true);
  });

  it('the panel\'s form: a first guess for a board, and what is missing said before anything runs', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'), f = defaultForm(doc);
    expect([f.supply, f.ret, f.source]).toEqual(['VIN', 'GND', 'J1']);
    expect(formRail(doc, f)).toBe('Give the current of one load at least.');
    expect(formRail(doc, { ...f, supply: '' })).toBe('Pick the supply net.');
    expect(formRail(doc, { ...f, ret: 'VIN' })).toMatch(/^The return net is the supply net/);
    expect(formRail(doc, { ...f, source: 'R99' })).toBe('Pick the component that feeds the net.');
    expect(formRail(doc, { ...f, voltage: 'x', loads: { U1: '1' } })).toBe('Give the source\'s voltage.');
    const rail = formRail(doc, { ...f, voltage: '5', loads: { U1: '0,25', C1: '' }, detail: 'draft', drop: '2' }) as RailSetup;
    expect(typeof rail).toBe('object');
    expect(rail.loads).toEqual([{ component: doc.components.findIndex((c) => c.designator === 'U1'), current: 0.25 }]);
    expect([rail.voltage, rail.cells, rail.limits.drop, rail.limits.rise, rail.ret]).toEqual([5, 30_000, 2, 10, doc.nets.findIndex((n) => n.name === 'GND')]);
    expect(formRail(doc, { ...f, ret: '', loads: { U1: '1' } })).toMatchObject({ ret: null });
  });
});
