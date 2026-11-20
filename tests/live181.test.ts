import { describe, expect, it } from 'vitest';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';
import { nextSourceBreak } from '../src/sim/devices';

const sim = (text: string) => new Simulator(readNetlist(`*\n${text}\n.END\n`));
/** A live run carried to `t` in slices as a display's frames are (each a hundredth of the way). */
function carry(s: Simulator, t: number, hmax: number): void {
  const t0 = s.liveTime, n = 100;
  for (let k = 1; k <= n; k++) s.liveAdvance(t0 + ((t - t0) * k) / n, hmax);
}
/** The same circuit's transient analysis, its last value of a signal. */
function batch(text: string, tstop: number, tstep: number, name: string): number {
  const s = sim(text);
  const p = s.tran({ kind: 'tran', tstep, tstop, tstart: 0, tmax: tstep, uic: false });
  const v = p.vectors.find((x) => x.name.toLowerCase() === name)!;
  return (v.re as number[]).at(-1)!;
}

describe('Live Simulation (R18): a transient with no end, a slice at a time', () => {
  it('an RC charges as it should from its initial conditions: 63.2 % in one time constant, 99.3 % in five', () => {
    const s = sim('V1 in 0 5\nR1 in out 1k\nC1 out 0 1u');
    s.liveStart({ uic: true });
    expect(s.valueOf('out')).toBe(0);
    carry(s, 1e-3, 2e-5);
    expect(s.liveTime).toBeGreaterThanOrEqual(1e-3);
    expect(s.valueOf('out')! / (5 * (1 - Math.exp(-s.liveTime / 1e-3)))).toBeCloseTo(1, 2);
    carry(s, 5e-3, 2e-5);
    expect(s.valueOf('out')! / (5 * (1 - Math.exp(-s.liveTime / 1e-3)))).toBeCloseTo(1, 2);
    // From the operating point instead: charged from the start, and it stays there
    const o = sim('V1 in 0 5\nR1 in out 1k\nC1 out 0 1u');
    o.liveStart();
    expect(o.valueOf('out')).toBeCloseTo(5, 6);
    carry(o, 1e-3, 2e-5);
    expect(o.valueOf('out')).toBeCloseTo(5, 6);
    // Ground is 0, an unknown name nothing, the source's current its branch
    expect([o.valueOf('0'), o.valueOf('gnd'), o.valueOf('nowhere')]).toEqual([0, 0, undefined]);
    expect(Math.abs(o.valueOf('V1#branch')!)).toBeLessThan(1e-9);
  });

  it('follows a sine with nothing to store charge (its step is the caller\'s) and lands on a pulse\'s corners', () => {
    const s = sim('V1 in 0 SIN(0 2 1k)\nR1 in out 1k\nR2 out 0 1k');
    s.liveStart();
    for (const t of [0.13e-3, 0.25e-3, 0.8e-3, 3.71e-3]) {
      carry(s, t, 1 / 40e3);
      expect(s.valueOf('out')).toBeCloseTo(Math.sin(2 * Math.PI * 1e3 * s.liveTime), 6);
    }
    // A 1 kHz pulse into an RC: where the transient analysis ends up after 10¼ periods, the live run does
    const text = 'V1 in 0 PULSE(0 5 0 1u 1u 0.5m 1m)\nR1 in out 1k\nC1 out 0 220n';
    const p = sim(text);
    p.liveStart();
    carry(p, 10.25e-3, 1e-5);
    const want = batch(text, 10.25e-3, 1e-5, 'out');
    expect(Math.abs(p.valueOf('out')! - want)).toBeLessThan(0.05);
    expect(p.valueOf('in')).toBeCloseTo(5, 6);
    // The corners a run steps onto: each period's four, however far on it is
    const src = readNetlist('*\nV1 a 0 PULSE(0 5 1m 1u 2u 0.5m 1m)\n.END\n').elements[0]!.src!;
    expect(nextSourceBreak(src, 0, 1e-9)).toBeCloseTo(1e-3, 12);
    expect(nextSourceBreak(src, 1e-3, 1e-9)).toBeCloseTo(1.001e-3, 12);
    expect(nextSourceBreak(src, 1.2e-3, 1e-9)).toBeCloseTo(1.501e-3, 12);
    expect(nextSourceBreak(src, 1.502e-3, 1e-9)).toBeCloseTo(1.503e-3, 12);
    expect(nextSourceBreak(src, 3600.0002, 1e-9)).toBeCloseTo(3600.000501, 8);   // an hour on: that period's fall
    expect(nextSourceBreak(readNetlist('*\nV1 a 0 5\n.END\n').elements[0]!.src!, 0, 1e-9)).toBe(Infinity);
  });

  it('agrees with the transient analysis on a rectifier (a diode into an RC) and on a transistor switch', () => {
    const rect = 'V1 in 0 SIN(0 5 1k)\nD1 in out DX\nR1 out 0 10k\nC1 out 0 1u\n.MODEL DX D(IS=2.52n RS=0.568 N=1.752 CJO=4p TT=20n)';
    const s = sim(rect);
    s.liveStart();
    carry(s, 5e-3, 1 / 40e3);
    const want = batch(rect, 5e-3, 1 / 40e3, 'out');
    expect(want).toBeGreaterThan(3.5);
    expect(Math.abs(s.valueOf('out')! - want)).toBeLessThan(0.03);
    const sw = 'VCC vcc 0 5\nV1 in 0 PULSE(0 3.3 0.1m 1u 1u 0.4m 1m)\nRB in b 10k\nRC vcc c 1k\nQ1 c b 0 QN\n.MODEL QN NPN(IS=6.734f BF=416 VAF=74 CJC=3.6p CJE=4.5p TF=300p)';
    const q = sim(sw);
    q.liveStart();
    carry(q, 0.3e-3, 1e-5);
    expect(q.valueOf('c')).toBeLessThan(0.3);   // on: the collector pulled down
    expect(Math.abs(q.valueOf('c')! - batch(sw, 0.3e-3, 1e-5, 'c'))).toBeLessThan(0.02);
    carry(q, 0.8e-3, 1e-5);
    expect(q.valueOf('c')).toBeGreaterThan(4.9);   // off again
  });

  it('a changed circuit carries on from where the run was: what it held by name, the new from zero', () => {
    const s = sim('V1 in 0 5\nR1 in out 1k\nC1 out 0 1u');
    s.liveStart({ uic: true });
    carry(s, 0.7e-3, 2e-5);
    const held = s.valueOf('out')!, at = s.liveTime;
    // A second resistor across the capacitor, and a new node with its own capacitor
    const n = sim('V1 in 0 5\nR1 in out 1k\nC1 out 0 1u\nR2 out 0 1k\nR3 out x 10k\nC2 x 0 10n');
    n.liveStart({ carry: s.unknownsNow(), time: at });
    expect(n.liveTime).toBe(at);
    expect(n.valueOf('out')).toBeCloseTo(held, 9);
    expect(n.valueOf('x')).toBe(0);
    n.liveAdvance(at + 1e-7, 1e-7);
    expect(Math.abs(n.valueOf('out')! - held)).toBeLessThan(0.01);   // no jump
    carry(n, at + 10e-3, 2e-5);
    expect(n.valueOf('out')).toBeCloseTo(2.5, 2);   // the divider's level now
    expect(n.valueOf('x')).toBeCloseTo(2.5, 2);
  });

  it('gives up its slice at the deadline, and says so when a circuit has no solution', () => {
    const s = sim('V1 in 0 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 1u');
    s.liveStart();
    const reached = s.liveAdvance(10, 1e-6, performance.now() - 1);
    expect(reached).toBeLessThan(1e-4);
    expect(() => sim('V1 a 0 5\nV2 a 0 3').liveStart()).toThrow(/singular|convergence/);
    expect(() => sim('R1 a 0 1k').liveAdvance(1, 1)).toThrow(/not been started/);
  });
});

import { SIM_DEMO, simDemoFiles } from '../src/formats/synthetic/simDemo';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { projectNetlist, type LiveMap } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { liveGeometry, runCurrents } from '../src/model/liveWires';

describe('Live Simulation (R18): the running circuit on its sheet', () => {
  const file = simDemoFiles().find((f) => f.name === SIM_DEMO.sheet)!;
  const sheets = [{ name: file.name, doc: readSchDoc(file.bytes, file.name) }];
  const compiled = compileProject(sheets);
  const map: LiveMap = { nets: new Map(), pins: new Map() };
  const net = projectNetlist(compiled, sheets, defaultSettings(), () => null, 'Live Simulation', map);
  const s = new Simulator(readNetlist(net.text));
  s.liveStart();
  for (let k = 1; k <= 60; k++) s.liveAdvance(k * 2e-5, 1 / 40e3);
  const pinI = (k: string) => s.valueOf(`${map.pins.get(k)!.meter}#branch`) ?? 0;
  const geo = liveGeometry(sheets[0]!.doc, compiled);
  const cur = runCurrents(geo, pinI);

  it('the netlist meters every pin: a 0 V source between the pin\'s net and a node of its own', () => {
    expect(net.messages.filter((m) => m.level === 'error')).toEqual([]);
    expect(net.text).toMatch(/\*Each pin through an ammeter of its own \(Live Simulation\):\nV__/);
    const pins = compiled.nets.flatMap((n) => n.pins.map((p) => `${p.designator}|${p.pin}`));
    expect(map.pins.size).toBe(pins.length);
    for (const k of pins) expect(s.valueOf(`${map.pins.get(k)!.meter}#branch`), k).toBeDefined();
    // Every net has a node; the supply's is at its voltage, the reference at 0
    expect(map.nets.size).toBe(compiled.nets.length);
    expect(map.nets.get('GND')).toBe('0');
    expect(s.valueOf(map.nets.get('VCC')!)).toBeCloseTo(12, 6);
    // The same sheet without meters is the netlist it always was
    expect(projectNetlist(compiled, sheets, defaultSettings()).text).not.toMatch(/V__/);
  });

  it('what goes into a part comes out of it: a resistor\'s two pins carry one current, a transistor\'s three sum to nothing', () => {
    for (const r of ['R1', 'R2', 'R3', 'R4', 'C1']) expect(pinI(`${r}|1`) + pinI(`${r}|2`), r).toBeCloseTo(0, 9);
    expect(pinI('Q1|1') + pinI('Q1|2') + pinI('Q1|3')).toBeCloseTo(0, 9);
    // The amplifier is biased: collector current of about a milliamp into the transistor, out at the emitter
    expect(pinI('Q1|1')).toBeGreaterThan(0.3e-3);
    expect(pinI('Q1|3')).toBeLessThan(-0.3e-3);
    // R3 takes it from the supply: into its supply end, out of its collector end
    expect(Math.abs(pinI('R3|1')) - Math.abs(pinI('Q1|1'))).toBeLessThan(1e-4);
  });

  it('every pin is a run, every wire is cut where things join it, and at each joint the currents balance', () => {
    const pinRuns = geo.runs.filter((r) => r.pin), wireRuns = geo.runs.filter((r) => !r.pin);
    expect(pinRuns.length).toBe(map.pins.size);
    expect(wireRuns.length).toBeGreaterThan(20);
    expect(new Set(geo.runs.map((r) => r.net)).size).toBe(compiled.nets.length);
    // Kirchhoff at every point where runs meet with no power port or label to take the rest
    const k = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    const outlets = new Set(sheets[0]!.doc.objects.filter((o) => o.kind === 'power' || (o.kind === 'text' && o.role === 'netlabel')).map((o) => k((o as { at: { x: number; y: number } }).at)));
    const into = new Map<string, number>();
    geo.runs.forEach((r, i) => {
      // A pin's run takes its current out of the point at its end; a wire's run takes current out of a and puts it into b
      into.set(k(r.a), (into.get(k(r.a)) ?? 0) - cur[i]!);
      if (!r.pin) into.set(k(r.b), (into.get(k(r.b)) ?? 0) + cur[i]!);
    });
    let checked = 0;
    for (const [pt, sum] of into) { if (outlets.has(pt)) continue; checked++; expect(Math.abs(sum), pt).toBeLessThan(1e-9); }
    expect(checked).toBeGreaterThan(15);
    // And the wires carry real current: the supply rail's the most
    expect(Math.max(...wireRuns.map((_, i) => Math.abs(cur[pinRuns.length + i]!)))).toBeGreaterThan(0.5e-3);
  });
});
