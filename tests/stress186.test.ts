/**
 * Live Simulation's stress flags and Solve for a value (26.186).
 */
import { describe, expect, it } from 'vitest';
import { RATINGS, RATING_PARAMS, Stress, ratingOf } from '../src/sim/liveStress';
import { solveValue } from '../src/sim/liveSolve';
import { simPartSymbols } from '../src/formats/synthetic/simLib';
import { KIT, kitFields } from '../src/app/liveKit';
import { spiceNumber } from '../src/sim/num';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';
import { LIVE_EXAMPLES, liveExampleBytes, liveExampleFile } from '../src/app/liveExamples';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { projectNetlist, type LiveMap } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { simModelOf, simParamHolder } from '../src/model/simModels';
import { bagOf } from '../src/model/sch';

describe('what a part is rated for (26.186)', () => {
  it('every rated part of the libraries carries its rating as a parameter, and the palette offers it as a field', () => {
    const symbols = new Map(simPartSymbols().map((s) => [s.libRef, s]));
    for (const [ref, r] of Object.entries(RATINGS)) {
      const s = symbols.get(ref)!;
      expect(s, ref).toBeDefined();
      const own = s.bags.find((b) => b.get('NAME') === RATING_PARAMS[r.kind]);
      expect(own?.get('TEXT'), ref).toBe(r.text);
      expect(own?.bool('ISHIDDEN'), ref).toBe(true);
      const kit = KIT.find((k) => k.libRef === ref);
      if (kit) expect(kitFields(ref)!.at(-1), ref).toMatchObject({ param: RATING_PARAMS[r.kind], label: 'Rated for', unit: r.kind === 'power' ? 'W' : r.kind === 'voltage' ? 'V' : 'A' });
    }
    // A quarter-watt resistor, a 50 V capacitor, a 30 mA LED, a half-watt transistor
    expect(RATINGS.RES).toEqual({ kind: 'power', text: '0.25' }); expect(RATINGS.CAP).toEqual({ kind: 'voltage', text: '50' });
    expect(RATINGS.LED_VF).toEqual({ kind: 'current', text: '30m' }); expect(RATINGS.NPN_BETA).toEqual({ kind: 'power', text: '0.5' });
  });

  it('a part\'s own rating is taken where it reads as a number, its kind\'s where it does not; a part of no rated kind is rated by a parameter of its own or not at all', () => {
    const none = () => '';
    expect(ratingOf('RES', none, spiceNumber)).toEqual({ kind: 'power', value: 0.25 });
    expect(ratingOf('res', (p) => (p === 'Power Rating' ? '2' : ''), spiceNumber)).toEqual({ kind: 'power', value: 2 });
    expect(ratingOf('RES', (p) => (p === 'Power Rating' ? 'plenty' : ''), spiceNumber)).toEqual({ kind: 'power', value: 0.25 });
    // (a resistor is rated for a power: a voltage rating written on one is not its rating)
    expect(ratingOf('RES', (p) => (p === 'Voltage Rating' ? '200' : ''), spiceNumber)).toEqual({ kind: 'power', value: 0.25 });
    expect(ratingOf('LED_VF', none, spiceNumber)).toEqual({ kind: 'current', value: 0.03 });
    expect(ratingOf('OPAMP', none, spiceNumber)).toBeNull();
    expect(ratingOf('MY_RESISTOR', (p) => (p === 'Voltage Rating' ? '63' : ''), spiceNumber)).toEqual({ kind: 'voltage', value: 63 });
  });

  it('a power is the mean lately: a steady overload is flagged within a second or two and let go when it ends; an instant\'s pulse is not', () => {
    // A resistor between node 0 (its voltage) and 0 V, the current into each pin kept at 1 and 2
    let v = 0, i = 0;
    const valueAt = (k: number) => (k === 0 ? v : k === 1 ? i : k === 2 ? -i : 0);
    const s = new Stress('R1', { kind: 'power', value: 0.25 }, [[0, 1], [-1, 2]]);
    let t = 0;
    const frames = (n: number, volts: number, ohms: number) => { for (let f = 0; f < n; f++) { for (let k = 0; k < 20; k++) { t += 1e-3; v = volts; i = volts / ohms; s.step(t, valueAt); } s.frame(1 / 60); } };
    frames(180, 5, 1000);     // 25 mW
    expect(s.over).toBe(false); expect(s.shown).toBeGreaterThan(0.023); expect(s.shown).toBeLessThanOrEqual(0.025);
    frames(120, 20, 1000);    // 0.4 W
    expect(s.over).toBe(true); expect(s.shown).toBeGreaterThan(0.33);
    // Back to under nine tenths of the rating: let go (not at once: it is the mean lately)
    frames(3, 5, 1000); expect(s.over).toBe(true);
    frames(90, 5, 1000); expect(s.over).toBe(false);
    // 144 W for two milliseconds in a quiet second, as a capacitor charging through it at real time: a third of a joule, and no flag
    const pulse = new Stress('R2', { kind: 'power', value: 0.25 }, [[0, 1], [-1, 2]]);
    t = 0; v = 0; i = 0;
    for (let f = 0; f < 60; f++) { for (let k = 0; k < 20; k++) { t += 1e-3; const on = f === 30 && k < 2; v = on ? 12 : 0; i = on ? 12 : 0; pulse.step(t, valueAt); } pulse.frame(1 / 60); expect(pulse.over, `frame ${f}`).toBe(false); }
    expect(pulse.shown).toBeGreaterThan(0.05);
  });

  it('a current is the mean lately too, whichever way it goes: a diode\'s spike as it turns off is not its rating passed', () => {
    let i = 0;
    const led = new Stress('LED1', { kind: 'current', value: 0.03 }, [[0, 1], [2, 3]]), valueAt = (k: number) => (k === 1 ? i : 0);
    let t = 0;
    for (let f = 0; f < 120; f++) { for (let k = 0; k < 100; k++) { t += 1e-5; i = k === 50 ? -0.1 : 8e-3; led.step(t, valueAt); } led.frame(1 / 60); expect(led.over).toBe(false); }
    expect(led.shown).toBeGreaterThan(7e-3); expect(led.shown).toBeLessThan(11e-3);
    for (let f = 0; f < 120; f++) { for (let k = 0; k < 100; k++) { t += 1e-5; i = -0.05; led.step(t, valueAt); } led.frame(1 / 60); }
    expect(led.over).toBe(true);
  });

  it('a voltage is the most reached lately', () => {
    let v = 0;
    const cap = new Stress('C1', { kind: 'voltage', value: 25 }, [[0, 1], [2, 3]]), valueAt = (k: number) => (k === 0 ? v : 0);
    let t = 0;
    const run = (n: number, wave: (t: number) => number) => { for (let f = 0; f < n; f++) { for (let k = 0; k < 50; k++) { t += 1e-4; v = wave(t); cap.step(t, valueAt); } cap.frame(1 / 60); } };
    run(30, (x) => 20 * Math.sin(2 * Math.PI * 50 * x));
    expect(cap.over).toBe(false); expect(cap.shown).toBeGreaterThan(19.5);
    run(30, (x) => -30 * Math.sin(2 * Math.PI * 50 * x));
    expect(cap.over).toBe(true); expect(cap.shown).toBeGreaterThan(29.5); expect(cap.shown).toBeLessThanOrEqual(30);
    run(240, () => 5);
    expect(cap.over).toBe(false);
    cap.clear(); expect(cap.shown).toBe(0);
  });

  it('none of the examples has a part over its rating as it starts', { timeout: 120000 }, () => {
    const over: string[] = [];
    for (const ex of LIVE_EXAMPLES) {
      const name = liveExampleFile(ex), doc = readSchDoc(liveExampleBytes(ex), name), sheets = [{ name, doc }], compiled = compileProject(sheets);
      const map: LiveMap = { nets: new Map(), pins: new Map() };
      const net = projectNetlist(compiled, sheets, defaultSettings(), () => null, 'Live Simulation', map);
      const sim = new Simulator(readNetlist(net.text));
      sim.liveStart(ex.zero ? { uic: true } : {});
      const text = (index: number, param: string) => { const h = simParamHolder(doc, index, param); return h === null ? '' : bagOf(doc, doc.objects[h]!)?.get('TEXT') ?? ''; };
      const rated: Stress[] = [];
      for (const o of doc.objects) {
        if (o.kind !== 'component' || !simModelOf(doc, o.index)) continue;
        const rating = ratingOf(o.libRef, (p) => text(o.index, p), spiceNumber);
        const pins = [...map.pins].filter(([k]) => k.startsWith(`${o.designator}|`)).map(([, p]): [number, number] => [sim.unknownAt(p.node) ?? -1, sim.unknownAt(`${p.meter}#branch`) ?? -1]);
        if (rating && pins.length >= 2) rated.push(new Stress(o.designator, rating, pins));
      }
      // Two seconds of watching at a pace that shows the circuit: forty periods of its fastest source, or a fifth of a second
      const fmax = net.sourceFrequencies.length ? Math.max(...net.sourceFrequencies) : 0, span = fmax ? 40 / fmax : 0.2;
      for (let f = 1; f <= 120; f++) { sim.liveAdvance(span * f / 120, fmax ? 1 / (40 * fmax) : span / 2400, Infinity, (t) => { for (const s of rated) s.step(t, (i) => sim.valueAt(i)); }); for (const s of rated) if (s.frame(1 / 60) && s.over) over.push(`${ex.id} ${s.designator}`); }
    }
    expect([...new Set(over)]).toEqual([]);
  });
});

describe('solve for a value (26.186)', () => {
  /** The lower resistor's voltage of a divider from 10 V with 1 k over it, as the solver's reading. */
  const divider = (r2: number) => { const sim = new Simulator(readNetlist(`divider\nV1 in 0 10\nR1 in out 1k\nR2 out 0 ${r2}\n.end`)); sim.liveStart({}); return sim.valueOf('out')!; };

  it('the lower resistor of a divider for 3.3 V out of 10 V: 492.5 ohms, to four figures', () => {
    const got = solveValue(divider, 3.3, 1000);
    expect(got).toMatchObject({ found: true, value: 492.5 });
    if (got.found) expect(got.reads).toBeCloseTo(3.3, 3);
    // From far off too (a megohm now), and what cannot be had is said with what can
    expect(solveValue(divider, 3.3, 1e6)).toMatchObject({ found: true, value: 492.5 });
    const none = solveValue(divider, 12, 1000);
    expect(none.found).toBe(false);
    if (!none.found) { expect(none.from).toBeCloseTo(0.1, 6); expect(none.to).toBeCloseTo(1e7, 0); expect(none.least).toBeLessThan(0.01); expect(none.most).toBeGreaterThan(9.99); expect(none.most).toBeLessThan(10); }
  });

  it('a value with a range is looked for across it; one that is nothing now, either side of nothing; of two answers the nearer is given', () => {
    // A potentiometer's position, 0 to 100: its wiper's share of 10 V
    expect(solveValue((pos) => 10 * pos / 100, 3.3, 50, [0, 100])).toMatchObject({ found: true, value: 33 });
    // An offset that is 0 V now, to be -2.5 V
    expect(solveValue((x) => 2 * x + 1, -4, 0)).toMatchObject({ found: true, value: -2.5 });
    // A reading that passes the target twice: the answer nearer to the value as it is
    const hump = (x: number) => -((Math.log10(x) - 3) ** 2);
    expect(solveValue(hump, -1, 5000)).toMatchObject({ found: true, value: 10000 });
    expect(solveValue(hump, -1, 200)).toMatchObject({ found: true, value: 100 });
    // A circuit with no solution anywhere
    const lost = solveValue(() => NaN, 1, 1000);
    expect(lost.found).toBe(false);
    if (!lost.found) expect(Number.isNaN(lost.least)).toBe(true);
  });
});
