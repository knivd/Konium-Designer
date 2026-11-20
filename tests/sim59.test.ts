import { describe, expect, it } from 'vitest';
import { readNetlist } from '../src/sim/netlist';
import { Simulator, acFrequencies, type Plot } from '../src/sim/engine';
import { spiceNumber, engineering } from '../src/sim/num';
import { evalExpr, parseExpr } from '../src/sim/expr';

const run = (text: string) => {
  const c = readNetlist(text);
  const s = new Simulator(c);
  const plots = s.run();
  return { c, s, plots, msgs: s.messages };
};
const vec = (p: Plot, name: string) => { const v = p.vectors.find((x) => x.name.toLowerCase() === name.toLowerCase()); if (!v) throw new Error(`${name} not in ${p.vectors.map((x) => x.name).join(',')}`); return v; };
const at = (p: Plot, name: string, x: number) => {
  const xs = p.x!.values, v = vec(p, name).re;
  for (let i = 1; i < xs.length; i++) if (xs[i]! >= x) { const f = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!); return v[i - 1]! + f * (v[i]! - v[i - 1]!); }
  return v[v.length - 1]!;
};
const mag = (p: Plot, name: string, i: number) => { const v = vec(p, name); return Math.hypot(v.re[i]!, v.im![i]!); };

describe('numbers and expressions', () => {
  it('SPICE scale factors, 4k7, units after the number', () => {
    const want = [1000, 4700, 10e-6, 1e6, 2200, 1e-3, 3e-3, 5 * 25.4e-6];
    ['1k', '4k7', '10uF', '1MEG', '2.2kΩ', '1e-3', '3m', '5mil'].forEach((t, i) => expect(spiceNumber(t) / want[i]!).toBeCloseTo(1, 12));
    expect(spiceNumber('x')).toBeNaN();
    expect([engineering(5e-3), engineering(20e-6), engineering(1e6), engineering(100), engineering(1000)]).toEqual(['5.000m', '20.00u', '1.000meg', '100.0', '1.000k']);
    expect(evalExpr(parseExpr('{2*R + 1k}'), { vars: (n) => (n === 'R' ? 100 : undefined) })).toBe(1200);
    expect(evalExpr(parseExpr('V(a,b)*2 + I(V1)'), { v: (a, b) => (a === 'a' && b === 'b' ? 1.5 : 0), i: () => 0.25 })).toBe(3.25);
    expect(evalExpr(parseExpr('x > 1 ? sqrt(16) : -2^2'), { vars: () => 2 })).toBe(4);
  });
});

describe('the SPICE engine', () => {
  it('operating point: a divider, a current source, controlled sources', () => {
    const { plots } = run(`divider
V1 in 0 10
R1 in mid 1k
R2 mid 0 1k
I1 0 x 1m
R3 x 0 2k
E1 e 0 mid 0 3
G1 0 g mid 0 1m
R4 g 0 1k
.op
.end`);
    const op = plots[0]!;
    expect(vec(op, 'mid').re[0]).toBeCloseTo(5, 6);
    expect(vec(op, 'x').re[0]).toBeCloseTo(2, 6);
    expect(vec(op, 'e').re[0]).toBeCloseTo(15, 6);
    expect(vec(op, 'g').re[0]).toBeCloseTo(5, 6);
    expect(vec(op, 'V1#branch').re[0]).toBeCloseTo(-5e-3, 9);
  });
  it('transient: RC charging and RL current follow their exponentials', () => {
    const { plots } = run(`rc
V1 in 0 PULSE(0 1 0 1n 1n 1 2)
R1 in out 1k
C1 out 0 1u
V2 a 0 PULSE(0 1 0 1n 1n 1 2)
R2 a b 100
L1 b 0 10m
.tran 10u 5m
.end`);
    const tr = plots[0]!;
    for (const t of [0.5e-3, 1e-3, 3e-3]) {
      expect(at(tr, 'out', t)).toBeCloseTo(1 - Math.exp(-t / 1e-3), 3);
      expect(at(tr, 'L1#branch', t)).toBeCloseTo((1 / 100) * (1 - Math.exp(-t * 100 / 10e-3)), 5);
    }
  });
  it('AC: an RLC resonance at 1/(2π√LC) with the gain Q', () => {
    const { plots } = run(`rlc
V1 in 0 AC 1
R1 in a 10
L1 a b 1m
C1 b 0 1u
.ac dec 200 100 100k
.end`);
    const ac = plots[0]!;
    const f = ac.x!.values;
    let best = 0;
    for (let i = 0; i < f.length; i++) if (mag(ac, 'b', i) > mag(ac, 'b', best)) best = i;
    // Across the capacitor the peak is a little below f0: f0·√(1 − 1/2Q²), of Q/√(1 − 1/4Q²)
    const f0 = 1 / (2 * Math.PI * Math.sqrt(1e-3 * 1e-6)), Q = Math.sqrt(1e-3 / 1e-6) / 10;
    expect(f[best]! / (f0 * Math.sqrt(1 - 1 / (2 * Q * Q)))).toBeCloseTo(1, 2);
    expect(mag(ac, 'b', best) / (Q / Math.sqrt(1 - 1 / (4 * Q * Q)))).toBeCloseTo(1, 3);
    expect(acFrequencies('dec', 10, 1, 100).length).toBe(21);
  });
  it('a diode: forward voltage as its equation gives, a zener in breakdown', () => {
    const { plots } = run(`diode
V1 in 0 5
R1 in a 1k
D1 a 0 DMOD
V2 z 0 12
R2 z k 1k
D2 0 k DZ
.model DMOD D(IS=2.52n RS=0.568 N=1.752)
.model DZ D(IS=1e-14 BV=5.1 IBV=1m)
.op
.end`);
    const op = plots[0]!;
    const vd = vec(op, 'a').re[0]!;
    // Id = (5 − Vd)/1k must satisfy the diode equation (Vd incl. RS·Id)
    const id = (5 - vd) / 1000;
    const vt = 0.025865;
    const vj = vd - 0.568 * id;
    expect(id / (2.52e-9 * (Math.exp(vj / (1.752 * vt)) - 1))).toBeCloseTo(1, 3);
    expect(vd).toBeGreaterThan(0.6); expect(vd).toBeLessThan(0.75);
    // The zener holds about BV
    expect(vec(op, 'k').re[0]).toBeGreaterThan(5.0);
    expect(vec(op, 'k').re[0]).toBeLessThan(5.25);
  });
  it('a BJT amplifier biases where its equations say; a MOSFET in saturation carries β/2·Vgst²', () => {
    const { plots } = run(`amp
VCC vcc 0 12
RB vcc b 1meg
RC vcc c 2k
Q1 c b 0 QN
VDD d 0 5
VGS g 0 3
M1 d g 0 0 NM W=20u L=2u
.model QN NPN(IS=1e-15 BF=100)
.model NM NMOS(VTO=1 KP=20u)
.op
.end`);
    const op = plots[0]!;
    const vbe = vec(op, 'b').re[0]!, ib = (12 - vbe) / 1e6, ic = (12 - vec(op, 'c').re[0]!) / 2000;
    expect(ic / ib).toBeCloseTo(100, 1);
    expect(vbe).toBeCloseTo(0.025865 * Math.log(ic / 1e-15), 2);
    expect(-vec(op, 'VDD#branch').re[0]!).toBeCloseTo(0.5 * 20e-6 * 10 * 4, 7);
  });
  it('DC sweep (nested), transfer function, behavioural source, subcircuit with parameters, coupled inductors', () => {
    const { plots, msgs } = run(`mixed
V1 in 0 1
X1 in out half R=2k
B1 dbl 0 V={2*V(out)}
.subckt half a b R=1k
R1 a b {R}
R2 b 0 {R}
.ends
VA p0 0 AC 1
RA p0 p 1m
L1 p 0 1m
L2 s 0 4m
K1 L1 L2 1
RS s 0 1meg
.dc V1 0 2 0.5
.tf V(out) V1
.ac lin 1 1k 1k
.end`);
    expect(msgs.filter((m) => m.level === 'error')).toEqual([]);
    const dc = plots[0]!;
    expect(dc.x!.values).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(vec(dc, 'out').re[4]).toBeCloseTo(1, 6);
    expect(vec(dc, 'dbl').re[4]).toBeCloseTo(2, 6);
    const tf = plots[1]!;
    expect(vec(tf, 'transfer_function').re[0]).toBeCloseTo(0.5, 6);
    expect(vec(tf, 'V1#input_impedance').re[0]).toBeCloseTo(4000, 2);
    expect(vec(tf, 'output_impedance_at_V(out)').re[0]).toBeCloseTo(1000, 2);
    // A 1:2 transformer (L2 = 4·L1, k = 1)
    expect(mag(plots[2]!, 's', 0) / mag(plots[2]!, 'p', 0)).toBeCloseTo(2, 3);
  });
  it('a sine through a transient, and its Fourier analysis', () => {
    const { plots } = run(`sine
V1 in 0 SIN(0 1 1k)
R1 in 0 1k
.tran 10u 3m
.four 1k V(in)
.end`);
    const tr = plots[0]!;
    expect(at(tr, 'in', 0.25e-3)).toBeCloseTo(1, 2);
    const four = plots[1]!;
    expect(Number(four.table!.rows[1]![3])).toBeCloseTo(1, 2);
    expect(parseFloat(four.table!.rows.at(-1)![3]!)).toBeLessThan(1);
  });
});
