/** 26.065's review: the simulator's reader, wave expressions, model text and the text editor's edits. */
import { describe, expect, it } from 'vitest';
import { readNetlist } from '../src/sim/netlist';
import { evalWave } from '../src/sim/waveExpr';
import { readSimText, writeSimText } from '../src/sim/simText';
import { indentEdit, lineSpan, replaceAll } from '../src/core/textOps';
import { Simulator, type Plot } from '../src/sim/engine';

const LIB = `* corners
.lib tt
.model nm nmos (vto=0.7)
.endl tt
.lib ff
.model nm nmos (vto=0.5)
.endl ff
.END
`;

describe('netlist: .lib sections and included files', () => {
  it('.lib file section takes that section only; another section of the same file is its own', () => {
    const inc = (n: string) => (n === 'cmos.lib' ? LIB : null);
    const c = readNetlist(`*\n.lib "cmos.lib" ff\nM1 d g 0 0 nm\nV1 d 0 1\nV2 g 0 1\n.op\n.end\n`, { include: inc });
    expect(c.errors).toEqual([]);
    expect(c.models.get('nm')?.params.vto).toBe(0.5);
    const two = readNetlist(`*\n.lib "cmos.lib" tt\n.lib "cmos.lib" xx\n.op\n.end\n`, { include: inc });
    expect(two.models.get('nm')?.params.vto).toBe(0.7);
    expect(two.errors.map((e) => e.message)).toEqual(['cmos.lib: no section xx']);
  });

  it('an included file\'s .END doesn\'t end the netlist', () => {
    const c = readNetlist(`*\n.include models.lib\nR1 a 0 1k\nV1 a 0 1\n.op\n.end\n`, { include: () => '.model dx d (is=1e-14)\n.END\n' });
    expect(c.elements.length).toBe(2);
    expect(c.analyses.map((a) => a.kind)).toEqual(['op']);
  });

  it('.tran starting at or past its stop: an error, not two million steps', () => {
    const c = readNetlist(`*\nR1 a 0 1k\nV1 a 0 1\n.tran 1u 1m 2m\n.end\n`);
    expect(c.analyses).toEqual([]);
    expect(c.errors[0]?.message).toMatch(/start time/);
  });

  it('a DC sweep that fails part-way leaves the source as it was for the next analysis', () => {
    const s = new Simulator(readNetlist(`*\nV1 a 0 1\nR1 a 0 1k\n.dc V1 0 2 1\n.op\n.end\n`));
    const proto = Object.getPrototypeOf(s) as { operatingPoint: (...a: unknown[]) => void };
    const real = proto.operatingPoint;
    let n = 0;
    (s as unknown as { operatingPoint: (...a: unknown[]) => void }).operatingPoint = function (this: unknown, ...a: unknown[]) { if (++n === 3) throw new Error('no convergence'); return real.apply(this, a); };
    const plots = s.run();
    const op = plots.find((p) => p.analysis === 'op')!;
    expect(op.vectors.find((v) => /^v?\(?a\)?$/i.test(v.name))!.re[0]).toBeCloseTo(1, 6);
  });
});

describe('wave expressions: nodes named as numbers', () => {
  it('a bare number is a constant; V(2) is node 2', () => {
    const p: Plot = { analysis: 'tran', title: 't', x: { name: 'time', unit: 's', values: [0, 1] }, vectors: [
      { name: '1', unit: 'V', re: Float64Array.from([3, 3]) }, { name: '2', unit: 'V', re: Float64Array.from([1.5, 1.5]) }] };
    expect(evalWave('V(1)*2', p).re[0]).toBeCloseTo(6);
    expect(evalWave('V(1)+2.5', p).re[0]).toBeCloseTo(5.5);
    expect(evalWave('V(1)-V(2)', p).re[0]).toBeCloseTo(1.5);
  });
});

describe('model text: its encoding kept', () => {
  it('a Windows-1252 model (©, µ) comes back byte for byte; a UTF-8 one keeps its byte-order mark', () => {
    const latin = Uint8Array.from([0x2a, 0x20, 0xa9, 0x20, 0x32, 0x30, 0xb5, 0x46, 0x0d, 0x0a, 0x2e, 0x45, 0x4e, 0x44, 0x0d, 0x0a]);
    const d = readSimText(latin, 'v.mdl');
    expect(d.text).toBe('* © 20µF\n.END\n');
    expect([...writeSimText(d)]).toEqual([...latin]);
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x2a, 0x0a]);
    expect([...writeSimText(readSimText(bom, 'b.mdl'))]).toEqual([...bom]);
  });
});

describe('text editor edits', () => {
  it('a caret at the very start of a text that opens with an empty line: its own line', () => {
    expect(lineSpan('\nabc', 0, 0)).toEqual([0, 0]);
    expect(indentEdit('\nabc', 1, 1, false, 2, false)?.text).toBe('  abc');
  });
  it('Replace All past 10,000 matches replaces every one', () => {
    const r = replaceAll('x '.repeat(12_000), 'x', 'y');
    expect(r.count).toBe(12_000);
    expect(r.text.includes('x')).toBe(false);
  });
});
