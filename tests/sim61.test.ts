import { afterEach, describe, expect, it } from 'vitest';
import { readNetlist } from '../src/sim/netlist';
import { Simulator, integratePower, type Plot } from '../src/sim/engine';
import { SPARSE_FROM, Solver, stampedOf } from '../src/sim/lu';
import { eigenvalues, pencilRoots } from '../src/sim/eig';
import { runAll } from '../src/sim/sweep';
import { analysisCards, defaultSettings, parseSettingsItem, settingsItem, sweepRunCount, sweepables } from '../src/sim/settings';
import { readSimData, writeSimData, type SimDataDocument } from '../src/sim/simData';
import { builtinModel } from '../src/sim/library';

const sim = (text: string) => { const s = new Simulator(readNetlist(text)); const plots = s.run(); return { plots, msgs: s.messages, s }; };
const at = (p: Plot, n: string) => p.vectors.find((v) => v.name === n)!.re[0]!;
const kT = 1.380649e-23 * (27 + 273.15);
const keep = SPARSE_FROM.n;
afterEach(() => { SPARSE_FROM.n = keep; });

describe('Sparse LU', () => {
  it('solves as the dense one does, transposed too, and keeps its order while the values change', () => {
    let seed = 3;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const n = 150, re = new Float64Array(n * n), im = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      if (i % 5 !== 2) re[i * n + i] = 2 + rnd();
      else { re[i * n + ((i + 1) % n)] = 1; re[((i + 1) % n) * n + i] = 1; }
      for (let q = 0; q < 3; q++) { const j = Math.floor(rnd() * n); re[i * n + j] += rnd() - 0.5; im[i * n + j] += rnd() - 0.5; }
    }
    const b = Float64Array.from({ length: n }, () => rnd()), bi = Float64Array.from({ length: n }, () => rnd());
    const solve = (from: number, t: boolean) => {
      SPARSE_FROM.n = from;
      const s = new Solver();
      expect(s.factor(stampedOf(n, re, im))).toBe(true);
      const x = b.slice(), xi = bi.slice();
      if (t) s.solveTransposed(x, xi); else s.solve(x, xi);
      return [s, x, xi] as const;
    };
    for (const t of [false, true]) {
      const [, dx, dxi] = solve(1e9, t), [sp, sx, sxi] = solve(0, t);
      expect(sp.sparse).toBe(true);
      for (let i = 0; i < n; i++) { expect(sx[i]).toBeCloseTo(dx[i]!, 9); expect(sxi[i]).toBeCloseTo(dxi[i]!, 9); }
    }
    // New values, same pattern: no new ordering
    SPARSE_FROM.n = 0;
    const s = new Solver();
    const m = stampedOf(n, re, im);
    s.factor(m);
    s.factor({ ...m, re: re.map((v) => v * 1.05) });
    expect(s.orderings).toBe(1);
  });

  it('a circuit of a few hundred nodes simulates the same sparse or dense', () => {
    const lines = ['* ladder', 'V1 n0 0 SIN(0 1 1k) AC 1'];
    for (let i = 0; i < 120; i++) lines.push(`R${i} n${i} n${i + 1} 100`, `C${i} n${i + 1} 0 1n`, `D${i} n${i + 1} 0 DX`);
    lines.push('.model DX D(IS=1e-14 CJO=1p)', '.TRAN 20u 1m', '.AC DEC 5 100 1meg', '.END');
    const text = lines.join('\n');
    SPARSE_FROM.n = 1e9;
    const dense = sim(text);
    SPARSE_FROM.n = 0;
    const sparse = sim(text);
    expect(sparse.s.solver.sparse).toBe(true);
    const v = (r: typeof dense, k: number, name: string) => r.plots[k]!.vectors.find((x) => x.name === name)!.re;
    const a = v(dense, 0, 'n60'), b = v(sparse, 0, 'n60');
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i += 17) expect(b[i]).toBeCloseTo(a[i]!, 9);
    const ac = v(dense, 1, 'n120'), acs = v(sparse, 1, 'n120');
    for (let i = 0; i < ac.length; i++) expect(acs[i]).toBeCloseTo(ac[i]!, 9);
  });
});

describe('Noise analysis', () => {
  it('a divider\'s thermal noise, each resistor\'s share, the input-referred noise and the total', () => {
    const r = sim('*\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nR2 out 0 1k\n.NOISE V(out) V1 DEC 10 10 100k 1\n.END');
    const [spec, tot] = r.plots as [Plot, Plot];
    const on = Math.sqrt(4 * kT * 500);
    expect(spec.vectors.map((v) => [v.name, v.unit])).toEqual([['onoise_spectrum', 'V/√Hz'], ['inoise_spectrum', 'V/√Hz'], ['onoise_R1', 'V/√Hz'], ['onoise_R2', 'V/√Hz']]);
    expect(spec.vectors[0]!.re[7]! / on).toBeCloseTo(1, 4);
    expect(spec.vectors[1]!.re[7]! / (2 * on)).toBeCloseTo(1, 4);
    expect(spec.vectors[2]!.re[7]! / Math.sqrt(4 * kT * 250)).toBeCloseTo(1, 4);
    expect(at(tot, 'onoise_total') / Math.sqrt(4 * kT * 500 * (100e3 - 10))).toBeCloseTo(1, 4);
  });
  it('an RC low pass integrates to kT/C', () => {
    const r = sim('*\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 1n\n.NOISE V(out) V1 DEC 50 1 100G\n.END');
    expect(at(r.plots[1]!, 'onoise_total') / Math.sqrt(kT / 1e-9)).toBeCloseTo(1, 3);
  });
  it('a transistor\'s shot and flicker noise; sparse and dense agree', () => {
    const amp = `*\nV1 in 0 DC 0 AC 1\nVCC vcc 0 12\nC1 in b 10u\nR1 vcc b 100k\nR2 b 0 22k\nRC vcc c 4.7k\nRE e 0 1k\nCE e 0 100u\nQ1 c b e QN\nC2 c out 10u\nRL out 0 100k\n.model QN NPN(IS=6.734f BF=416.4 VAF=74.03 RB=10 CJE=4.493p CJC=3.638p TF=301.2p KF=1e-15)\n.NOISE V(out) V1 DEC 10 10 1meg 1\n.END`;
    const d = sim(amp);
    SPARSE_FROM.n = 0;
    const s = sim(amp);
    const q1 = d.plots[0]!.vectors.find((v) => v.name === 'onoise_Q1')!.re;
    expect(q1[0]! / q1[20]!).toBeGreaterThan(1.5); // 1/f at 10 Hz
    expect(at(s.plots[1]!, 'onoise_total')).toBeCloseTo(at(d.plots[1]!, 'onoise_total'), 12);
  });
  it('integrates power laws exactly over few points', () => {
    const f = [1, 10, 100], s = f.map((x) => 1 / Math.sqrt(x));
    expect(integratePower(f, s)).toBeCloseTo(Math.log(100), 9);
  });
});

describe('Pole-zero analysis', () => {
  const table = (text: string) => { const r = sim(text); expect(r.msgs).toEqual([]); return r.plots[0]!.table!.rows.map((row) => [row[0], Number(row[1]), Number(row[2])]); };
  it('RC low pass, series RLC, high pass (a zero at the origin)', () => {
    expect(table('*\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.PZ in 0 out 0 VOL PZ\n.END')).toEqual([['Pole 1', -1000, 0]]);
    const rlc = table('*\nV1 in 0 AC 1\nR1 in a 100\nL1 a out 1m\nC1 out 0 1u\nR2 out 0 10k\n.PZ in 0 out 0 VOL PZ\n.END');
    // s² + (R1/L + 1/(R2·C))s + (1 + R1/R2)/(LC)
    const b = 100 / 1e-3 + 1 / (10e3 * 1e-6), c = 1.01 / (1e-3 * 1e-6), dsc = Math.sqrt(b * b - 4 * c);
    expect(rlc.map((x) => x[1] as number).map((v) => Math.round(v))).toEqual([Math.round((-b + dsc) / 2), Math.round((-b - dsc) / 2)]);
    expect(table('*\nV1 in 0 AC 1\nC1 in out 1u\nR1 out 0 1k\n.PZ in 0 out 0 VOL PZ\n.END')).toEqual([['Pole 1', -1000, 0], ['Zero 1', 0, 0]]);
  });
  it('complex poles of an underdamped RLC; eigenvalues and the pencil', () => {
    const z = pencilRoots([[1 / 100, 1], [1, 0]], [[1e-6, 0], [0, -1e-3]]);
    expect(z.map((x) => [Math.round(x.re), Math.round(Math.abs(x.im))])).toEqual([[-5000, 31225], [-5000, 31225]]);
    expect(eigenvalues([[0, -1], [1, 0]])!.map((e) => e.im).sort()).toEqual([-1, 1]);
  });
  it('a common-emitter stage: its coupling, bypass and Miller poles, and its zeros', () => {
    const rows = table(`*\nV1 in 0 DC 0 AC 1\nVCC vcc 0 12\nC1 in b 10u\nR1 vcc b 100k\nR2 b 0 22k\nRC vcc c 4.7k\nRE e 0 1k\nCE e 0 100u\nQ1 c b e QN\nC2 c out 10u\nRL out 0 100k\n.model QN NPN(IS=6.734f BF=416.4 VAF=74.03 RB=10 CJE=4.493p CJC=3.638p TF=301.2p)\n.PZ in 0 out 0 VOL PZ\n.END`);
    const zeros = rows.filter((r) => /Zero/.test(r[0] as string)).map((r) => r[1] as number);
    expect(zeros.filter((v) => v === 0)).toHaveLength(2); // the two coupling capacitors
    expect(zeros.some((v) => Math.abs(v + 10) < 0.01)).toBe(true); // RE·CE
    expect(zeros.some((v) => v > 1e10)).toBe(true); // gm/Cμ, right half-plane
    expect(rows.filter((r) => /Pole/.test(r[0] as string)).every((r) => (r[1] as number) < 0)).toBe(true);
  });
});

describe('Sweeps and Monte Carlo', () => {
  const base = '*\nV1 in 0 DC 1 AC 1\nR1 in out 1k\nR2 out 0 1k\nC1 out 0 100n\n.OP\n.AC DEC 5 10 100k\n';
  it('.STEP of a part: each run under its suffix, the AC corner moving', () => {
    const r = runAll(readNetlist(`${base}.STEP R1 1k 3k 1k\n.END`));
    const op = r.plots.find((p) => p.analysis === 'op')!;
    expect(op.runs!.map((x) => x.label)).toEqual(['R1=1k', 'R1=2k', 'R1=3k']);
    expect(['out_p1', 'out_p2', 'out_p3'].map((n) => Math.round(at(op, n) * 1000))).toEqual([500, 333, 250]);
    expect(r.plots.find((p) => p.analysis === 'ac')!.vectors.filter((v) => v.name.startsWith('out_')).length).toBe(3);
  });
  it('.STEP TEMP, a model parameter (the part\'s own copy), nested, relative; .TEMP with several values', () => {
    const diode = '*\nV1 a 0 5\nR1 a k 1k\nD1 k 0 DX\nD2 k2 0 DX\nR2 a k2 1k\n.model DX D(IS=1e-14)\n.OP\n';
    const t = runAll(readNetlist(`${diode}.STEP TEMP 0 100 50\n.END`)).plots[0]!;
    const vk = ['k_t1', 'k_t2', 'k_t3'].map((n) => at(t, n));
    expect(vk[0]! > vk[1]! && vk[1]! > vk[2]!).toBe(true); // a diode's drop falls as it warms
    const m = runAll(readNetlist(`${diode}.STEP D1[IS] LIST 1e-14 1e-12\n.STEP R1 0 1k 1k REL\n.END`)).plots[0]!;
    expect(m.runs!.map((x) => x.label)).toEqual(['D1[IS]=10f, R1+0', 'D1[IS]=1p, R1+0', 'D1[IS]=10f, R1+1k', 'D1[IS]=1p, R1+1k']);
    expect(at(m, 'k_p2')).toBeLessThan(at(m, 'k_p1') - 0.1);
    expect(at(m, 'k2_p2')).toBeCloseTo(at(m, 'k2_p1'), 9); // D2 keeps its model
    expect(at(m, 'k_p3')).toBeLessThan(at(m, 'k_p1')); // R1 2k: less current
    expect(runAll(readNetlist(`${diode}.TEMP 0 50\n.END`)).plots[0]!.runs!.map((x) => x.label)).toEqual(['TEMP=0°C', 'TEMP=50°C']);
  });
  it('.MC: the same seed gives the same runs, within the tolerances; tables get a Run column', () => {
    const text = `${base}.TF V(out) V1\n.MC 6 SEED=7 DIST=UNIFORM RES=10% CAP=10% R2=1%\n.END`;
    const a = runAll(readNetlist(text)), b = runAll(readNetlist(text));
    const op = a.plots.find((p) => p.analysis === 'op')!;
    const outs = [1, 2, 3, 4, 5, 6].map((i) => at(op, `out_mc${i}`));
    expect(outs).toEqual([1, 2, 3, 4, 5, 6].map((i) => at(b.plots.find((p) => p.analysis === 'op')!, `out_mc${i}`)));
    expect(new Set(outs.map((v) => v.toFixed(6))).size).toBe(6);
    for (const v of outs) { expect(v).toBeGreaterThan(1 / (1 + 1.1 / 0.99)); expect(v).toBeLessThan(1 / (1 + 0.9 / 1.01)); }
    const tf = a.plots.find((p) => p.analysis === 'tf')!;
    expect(tf.table!.columns[0]).toBe('Run');
    expect(tf.table!.rows[0]![0]).toBe('Monte Carlo run 1');
  });
  it('a transient run on another time grid is put on the first run\'s', () => {
    const r = runAll(readNetlist('*\nV1 in 0 PULSE(0 1 0 1u 1u 0.5m 1m)\nR1 in out 1k\nC1 out 0 100n\n.TRAN 10u 2m\n.STEP C1 LIST 100n 33n\n.END'));
    const p = r.plots[0]!;
    expect(p.vectors.find((v) => v.name === 'out_p2')!.re.length).toBe(p.x!.values.length);
  });
});

describe('Analyses Setup: the new pages into the netlist', () => {
  it('Noise, Pole-Zero, the sweeps and Monte Carlo round-trip and write their cards', () => {
    const s = defaultSettings();
    Object.assign(s.noise, { on: true, source: 'V1', output: 'OUT', summary: '1' });
    Object.assign(s.pz, { on: true, input: 'IN', output: 'OUT', transfer: 'V(output)/I(input)', type: 'Poles Only' });
    Object.assign(s.temp, { on: true });
    Object.assign(s.param, { on: true, variable: 'R1', type: 'Relative Values', secondary: true, variable2: 'Q1[BF]', start2: '100', stop2: '300', step2: '100' });
    Object.assign(s.mc, { on: true, specific: 'R1=1%, C2=5%' });
    s.options.ACCT = '1';
    expect(parseSettingsItem(settingsItem(s))).toEqual(s);
    const { lines, errors } = analysisCards(s, { sourceFrequencies: [], signals: ['IN', 'OUT'] });
    expect(errors).toEqual([]);
    expect(lines).toEqual([
      '.OPTIONS ACCT=1',
      '.NOISE V(OUT) V1 DEC 100 1.000 1.000meg 1',
      '.PZ IN 0 OUT 0 CUR POL',
      '.STEP TEMP 0.000 100.0 10.00',
      '.STEP R1 1.000k 10.00k 1.000k REL',
      '.STEP Q1[BF] 100 300 100',
      '.MC 5 SEED=-1 DIST=UNIFORM RES=10% CAP=10% IND=10% TRAN=10% DCSRC=10% R1=1% C2=5%',
      '.OP',
    ]);
    expect(sweepRunCount(s)).toBe(11 * 10 * 3 * 5);
    const c = readNetlist(`*\nR1 a 0 1k\n${lines.slice(1).join('\n')}\n.END`);
    expect([c.steps.length, c.mc!.runs, c.mc!.res, c.mc!.specific.get('r1'), c.analyses.map((a) => a.kind)]).toEqual([3, 5, 0.1, 0.01, ['noise', 'pz', 'op']]);
    expect(sweepables('*\nR1 a b 1k\nQ1 c b e QN\nV1 a 0 1\n')).toEqual(['R1', 'Q1[BF]', 'Q1[IS]', 'Q1[VAF]', 'Q1[RB]', 'V1']);
  });
  it('Advanced Options the engine honours: RAMPTIME, DEFL/DEFW, ITL5, ACCT', () => {
    const r = sim(`*\nV1 a 0 1\nR1 a 0 1k\nM1 a a 0 0 NM\n.model NM NMOS(KP=20u VTO=0.5)\n.OPTIONS RAMPTIME=1m DEFW=10u DEFL=1u ACCT=1\n.TRAN 10u 2m\n.END`);
    const v = r.plots[0]!.vectors.find((x) => x.name === 'a')!.re, t = r.plots[0]!.x!.values;
    const k = t.findIndex((x) => x >= 0.5e-3);
    expect(v[k]).toBeCloseTo(t[k]! / 1e-3, 6);
    expect(v.at(-1)).toBeCloseTo(1, 6);
    expect(r.msgs.some((m) => /^ACCT: \d+ unknowns/.test(m.text))).toBe(true);
    const it5 = sim('*\nV1 a 0 SIN(0 1 1k)\nR1 a b 1k\nC1 b 0 1u\n.OPTIONS ITL5=20\n.TRAN 1u 5m\n.END');
    expect(it5.msgs.some((m) => /ITL5/.test(m.text))).toBe(true);
    expect(builtinModel('2N3904')).toBeTruthy();
  });
});

describe('SimView: the results file keeps the new settings', () => {
  it('swept runs, Y axes, plot and wave options, Document Options', () => {
    const p: Plot = { analysis: 'ac', title: 'AC Analysis', x: { name: 'frequency', unit: 'Hz', values: [1, 10] }, complex: true,
      vectors: [{ name: 'out_p1', unit: 'V', re: [1, 0.5], im: [0, 0] }], runs: [{ suffix: '_p1', label: 'R1=1k' }] };
    const n: Plot = { analysis: 'noise', title: 'Integrated Noise', vectors: [{ name: 'onoise_total', unit: 'V', re: [1e-6] }] };
    const d: SimDataDocument = { kind: 'SimData', name: 'R.sdf', title: 'R', date: 'd', plots: [p, n], messages: [], active: 0, dirty: false,
      charts: [{ title: 'AC', source: 0, plots: [[{ expr: 'out_p1', axis: 1, width: 3, style: 'dash', points: true }]], plotOpts: [{ title: 'Gain', grid: false, axes: [{}, { label: 'V', log: true, min: 0.1 }] }] }],
      look: { area: '#000000', brightness: 20 } };
    const back = readSimData(writeSimData(d), 'R.sdf');
    expect([back.charts, back.look, back.plots[0]!.runs, back.plots[1]!.x, back.plots[1]!.vectors[0]!.re[0]]).toEqual([d.charts, d.look, p.runs, undefined, 1e-6]);
  });
});
