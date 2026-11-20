/**
 * Live Simulation's examples of 26.186: the slow-blow fuse beside a quick one, the DIAC and TRIAC dimmer, the ring
 * counter's running light, the shift register, the multiplexer, the staircase and the two converters back to back.
 */
import { describe, expect, it } from 'vitest';
import { LIVE_EXAMPLES, liveExampleBytes, liveExampleFile } from '../src/app/liveExamples';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { projectNetlist, type LiveMap } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';

/** An example running; `edit` changes its netlist first (a switch closed, an input high, a value turned). */
function of(id: string, edit: (text: string) => string = (t) => t) {
  const ex = LIVE_EXAMPLES.find((e) => e.id === id)!;
  const name = liveExampleFile(ex), sheets = [{ name, doc: readSchDoc(liveExampleBytes(ex), name) }], compiled = compileProject(sheets);
  const map: LiveMap = { nets: new Map(), pins: new Map() };
  const net = projectNetlist(compiled, sheets, defaultSettings(), () => null, 'Live Simulation', map);
  const text = edit(net.text);
  const sim = new Simulator(readNetlist(text));
  sim.liveStart(ex.zero ? { uic: true } : {});
  const node = (pin: string) => map.pins.get(pin)!.node;
  const at = (pin: string) => sim.valueOf(node(pin.includes('|') ? pin : `${pin}|1`))!;
  /** On to `until` in steps of no more than `h`, `each` called after every one of `n` slices. */
  const go = (until: number, h: number, n = 1, each?: (t: number) => void) => { const t0 = sim.liveTime; for (let k = 1; k <= n; k++) { sim.liveAdvance(t0 + (until - t0) * k / n, h); each?.(sim.liveTime); } };
  return { text, net, sim, map, node, at, go };
}
const swapped = (text: string, from: RegExp, to: string): string => { expect(text).toMatch(from); return text.replace(from, to); };

describe('the examples of 26.186', () => {
  it('quick and slow-blow fuses: the capacitors\' inrush blows the quick one and only warms the slow one', () => {
    const open = of('inrush');
    expect(open.text).toMatch(/^RSW1 \S+ \S+ 1G$/m);
    expect(open.at('TP1')).toBeLessThan(0.01); expect(open.at('TP2')).toBeLessThan(0.01);
    const r = of('inrush', (t) => swapped(t, /^(RSW1 \S+ \S+) 1G$/m, '$1 1m'));
    // (started as the sheet is, with SW1 closed, the capacitors would be full: they are emptied to have the inrush)
    const cold = of('inrush', (t) => swapped(t, /^(RSW1 \S+ \S+) 1G$/m, '$1 1m').replace(/^(C[12] \S+ \S+ 2200u)$/gm, '$1 IC=0'));
    expect(r.sim.valueOf('xf1.22')).toBeLessThan(0.5);
    cold.sim.liveStart({ uic: true });
    let heat = 0;
    cold.go(0.1, 1e-4, 200, () => { heat = Math.max(heat, cold.sim.valueOf('xf2.30')!); });
    expect(cold.sim.valueOf('xf1.22')).toBeGreaterThan(0.5);   // the quick fuse has blown
    expect(cold.sim.valueOf('xf2.22')).toBeLessThan(0.5);      // the slow one has not: it warmed by a sixth
    expect(heat).toBeGreaterThan(0.1); expect(heat).toBeLessThan(0.3);
    expect(cold.at('TP2')).toBeGreaterThan(11.5);             // its lamp is lit
    expect(cold.at('TP1')).toBeLessThan(6);                   // the other's is going out as C1 empties into it
  });

  it('the dimmer: the TRIAC fires each half cycle once the capacitor has reached the DIAC\'s breakover voltage, sooner with less of RV1', { timeout: 60000 }, () => {
    const lamp = (pos: number) => {
      const r = of('dimmer', (t) => swapped(t, /POS=40/, `POS=${pos}`));
      r.go(0.02, 2e-5, 1);
      let sq = 0, top = 0, n = 0, fired = 0, was = false;
      r.go(0.06, 2e-5, 4000, () => {
        const v = r.at('TP1') - r.at('TP2'); sq += v * v; n++;
        top = Math.max(top, Math.abs(r.at('TP3')));
        const on = Math.abs(r.at('TP2')) < 3 && Math.abs(r.at('TP1')) > 30;
        if (on && !was) fired++;
        was = on;
      });
      return { rms: Math.sqrt(sq / n), top, fired };
    };
    const mid = lamp(40), bright = lamp(90), dim = lamp(10);
    expect(mid.fired).toBe(4); expect(bright.fired).toBe(4);
    // The capacitor gets as far as the breakover voltage and no further
    expect(mid.top).toBeGreaterThan(30); expect(mid.top).toBeLessThan(36);
    expect(bright.rms).toBeGreaterThan(215); expect(bright.rms).toBeLessThan(231);
    expect(mid.rms).toBeGreaterThan(dim.rms + 20); expect(bright.rms).toBeGreaterThan(mid.rms + 20);
  });

  it('the ring counter: one LED lit at a time, the next at each rise of the clock, round again after ten', () => {
    const r = of('chaser'), seen: number[] = [];
    for (let k = 0; k < 12; k++) {
      r.go(0.1 + 0.2 * k, 5e-3);
      const lit = Array.from({ length: 10 }, (_, i) => r.sim.valueOf(`${r.map.pins.get(`LED${i + 1}|A`)!.meter}#branch`)! > 3e-3);
      expect(lit.filter(Boolean).length, `step ${k}`).toBe(1);
      seen.push(lit.indexOf(true));
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2]);
  });

  it('the shift register: with D high the ones come in at Q0 and move along', () => {
    const r = of('shift', (t) => swapped(t, /^(XIN1 \S+ LOGIC_IN PARAMS:) RA=1G RB=1 /m, '$1 RA=1 RB=1G '));
    const bits = () => [4, 5, 6, 7].map((p) => (r.at(`U1|${p}`) > 2.5 ? 1 : 0)).join('');
    const seen: string[] = [];
    for (let k = 0; k < 5; k++) { r.go(0.5 + k, 2.5e-2); seen.push(bits()); }
    expect(seen).toEqual(['1000', '1100', '1110', '1111', '1111']);
    // At rest, D low: nothing in it
    expect(of('shift').at('U1|4')).toBeLessThan(0.1);
  });

  it('the multiplexer: the clock that S1 and S0 name comes out', () => {
    const rate = (s0: boolean, s1: boolean) => {
      const hi = (n: number) => (t: string) => swapped(t, new RegExp(`^(XIN${n} \\S+ LOGIC_IN PARAMS:) RA=1G RB=1 `, 'm'), '$1 RA=1 RB=1G ');
      const r = of('mux', (t) => { let x = t; if (s0) x = hi(1)(x); if (s1) x = hi(2)(x); return x; });
      let rises = 0, was = r.at('TP1') > 2.5;
      r.go(2, 5e-3, 800, () => { const now = r.at('TP1') > 2.5; if (now && !was) rises++; was = now; });
      return rises / 2;
    };
    expect([rate(false, false), rate(true, false), rate(false, true), rate(true, true)]).toEqual([1, 2, 4, 8]);
  });

  it('the staircase: sixteen steps of 5/16 V, one a millisecond; the converters back to back give the sine in sixteenths', () => {
    const st = of('staircase'), levels: number[] = [];
    for (let k = 0; k < 18; k++) { st.go(0.5e-3 + 1e-3 * k, 1e-5); const v = st.at('TP1') / (5 / 16); expect(Math.abs(v - Math.round(v)), `step ${k}`).toBeLessThan(0.1); levels.push(Math.round(v)); }   // (C1, emptying back through R1, lifts the first steps after 15 a little)
    expect(levels).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1, 2]);
    // (what R1 and C1 make of it stays within the stair)
    expect(st.at('TP2')).toBeGreaterThan(0); expect(st.at('TP2')).toBeLessThan(4.7);
    const cv = of('converters'), seen = new Set<number>();
    let worst = 0;
    cv.go(0.02, 2e-5, 2000, () => {
      const vin = cv.at('TP1'), out = cv.at('TP2'), step = out / (5 / 16);
      // Away from the instants a bit turns over, the output is a whole number of sixteenths, the one at or under the input
      if (Math.abs(step - Math.round(step)) < 0.02) { seen.add(Math.round(step)); if (Math.abs(vin / (5 / 16) - Math.round(vin / (5 / 16))) > 0.15) worst = Math.max(worst, Math.abs(Math.floor(vin / (5 / 16)) - step)); }
    });
    expect(worst).toBeLessThan(0.05);
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  });
});
