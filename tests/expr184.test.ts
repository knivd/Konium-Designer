/**
 * Expressions compiled (26.184). A behavioural source is asked for its value at every iteration of
 * every step, and again twice for each unknown it reads, for its slopes; with the names looked up
 * and the tree walked at each asking, the sources of a 555 took most of a live run's time. The
 * expression is now made into a function once. It has to give what evalExpr gives, to the last bit.
 */
import { describe, expect, it } from 'vitest';
import { compileExpr, evalExpr, exprProbes, parseExpr, type Expr } from '../src/sim/expr';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';
import { kitPartSymbols, kitSourceSymbols } from '../src/formats/synthetic/simKit';
import { alone } from './kitBench';

describe('expressions compiled once (26.184)', () => {
  /** Both ways of working an expression out, with its nodes and sources at made-up places in a vector of made-up values. */
  const both = (e: Expr, seed: number): [number, number] => {
    const pr = exprProbes(e), names = [...new Set([...pr.v.flatMap(([a, b]) => (b ? [a, b] : [a])), ...pr.i].map((n) => n.toLowerCase()))];
    let s = seed >>> 0;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    const x = Float64Array.from({ length: names.length + 1 }, () => (rnd() - 0.4) * 12);
    // (0 and gnd are 0 V; every other name has its place)
    const at = (n: string) => (/^(0|gnd)$/i.test(n) ? -1 : names.indexOf(n.toLowerCase()));
    const time = rnd() * 1e-2, temper = 27;
    const want = evalExpr(e, {
      vars: (n) => (/^time$/i.test(n) ? time : /^temper$/i.test(n) ? temper : undefined),
      v: (p, n) => (at(p) < 0 ? 0 : x[at(p)]!) - (n ? (at(n) < 0 ? 0 : x[at(n)]!) : 0),
      i: (n) => (at(n) < 0 ? 0 : x[at(n)]!),
    });
    return [compileExpr(e, { node: at, branch: at })({ x, time, temper }), want];
  };

  it('every expression of the kit\'s parts gives the same compiled as walked, at a hundred places each', () => {
    let count = 0;
    for (const sym of [...kitPartSymbols(), ...kitSourceSymbols()]) {
      const a = alone(sym);
      if (a.errors.length) continue;
      const c = readNetlist(a.text);
      for (const el of c.elements) {
        if (el.kind !== 'B' || !el.expr) continue;
        count++;
        for (let k = 1; k <= 100; k++) { const [got, want] = both(el.expr, k * 7919 + count); expect(Object.is(got, want), `${sym.libRef} ${el.name} at ${k}: ${got} against ${want}`).toBe(true); }
      }
    }
    // The 555 alone has three; the gates, flip-flops, counter, decoder, thyristors and the waveform sources theirs
    expect(count).toBeGreaterThan(50);
  });

  it('and so does each kind of thing an expression can hold', () => {
    const texts = [
      '1.5k', 'pi*2', 'e', 'nosuch', 'time*1k', 'temper-27', '-V(a)', '!V(a)', '!0',
      'V(a)+V(b)', 'V(a)-V(b)', 'V(a)*V(b)', 'V(a)/V(b)', 'V(a)%3', 'V(a)^2', 'V(a)**0.5', 'V(a,b)', 'V(a,0)', 'V(0,b)', 'V(0)', 'V(gnd,a)', 'I(vs)*10',
      'V(a)==V(a)', 'V(a)!=V(b)', 'V(a)<V(b)', 'V(a)>V(b)', 'V(a)<=V(b)', 'V(a)>=V(b)', 'V(a)>0 && V(b)>0', 'V(a)>0 || V(b)>0', 'V(a)>1 ? V(b) : V(c)',
      'sqrt(abs(V(a)))', 'exp(V(a)/10)', 'ln(abs(V(a))+1)', 'log10(abs(V(a))+1)', 'sin(V(a))+cos(V(b))+tan(V(c)/20)', 'atan2(V(a),V(b))', 'tanh(4*(V(a)-1))',
      'min(V(a),V(b))', 'max(V(a),V(b),V(c))', 'min(V(a),V(b),V(c),1)', 'pow(abs(V(a)),1.5)', 'pwr(V(a),2)', 'floor(V(a))+ceil(V(b))+int(V(c))+round(V(a))',
      'sgn(V(a))', 'sign(V(a),V(b))', 'sign(V(a))', 'u(V(a))', 'limit(V(a),-1,1)', 'if(V(a)>0,V(b),V(c))', 'db(V(a))', 'nofunction(V(a))',
      'noise(time*5k)', 'bit(V(a)*3,1)', 'mod(V(a)+20,7)', 'seg7(V(a)+6,3)', '0.5+0.25*(1+tanh(200*(V(a)-V(b))))-0.125*(1-tanh(200*(V(a)-V(b))))*(1+tanh(200*(V(c)-V(d))))',
    ];
    for (const t of texts) {
      const e = parseExpr(t);
      for (let k = 1; k <= 50; k++) { const [got, want] = both(e, k * 104729); expect(Object.is(got, want), `${t} at ${k}: ${got} against ${want}`).toBe(true); }
    }
  });

  it('a source\'s slopes are taken with the unknowns put back as they were', () => {
    const sim = new Simulator(readNetlist(['slopes', 'V1 a 0 DC 2', 'R1 a b 1k', 'R2 b 0 1k', 'B1 c 0 V={V(a)*V(b)+I(V1)*1k}', 'R3 c 0 1k', '.END'].join('\n')));
    sim.liveStart({});
    // 2 V, 1 V and -1 mA: 2 x 1 - 1 = 1 V, and the divider is as it was
    expect(sim.valueOf('c')).toBeCloseTo(1, 6); expect(sim.valueOf('a')).toBe(2); expect(sim.valueOf('b')).toBeCloseTo(1, 6);
  });
});
