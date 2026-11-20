/**
 * SimView's wave expressions (Wave › Add Wave): the run's signals combined point by point —
 * OUT-IN, V(OUT)/V(IN), DB(OUT), PHASE(OUT), R1[i]*R1[i]*1k … — in complex arithmetic for an
 * AC chart. Signal names are taken as they are (3V3-dig, Q1[ic], V1#branch), longest first.
 * The functions: ABS, SQRT, EXP, LN, LOG, LOG10, SIN, COS, TAN, ASIN, ACOS, ATAN, SINH, COSH,
 * TANH, DB, MAG, PHASE (PH), REAL (RE), IMAG (IM), and running AVG and RMS over the X axis.
 */
import { parseExpr, type Expr } from './expr';
import type { Plot, Vector } from './engine';

export interface WaveValues { re: Float64Array; im: Float64Array | null }

const PH = (i: number) => `__s${i}__`;

/** The expression with the signals' names put by placeholders, and the signals it uses. */
function prepare(text: string, names: string[]): { text: string; used: Map<string, string> } {
  const used = new Map<string, string>();
  const sorted = [...names].sort((a, b) => b.length - a.length);
  let out = text;
  sorted.forEach((n, i) => {
    const esc = n.replace(/[.*+?^${}()|[\]\\#]/g, '\\$&');
    // A node named as a number (SPICE's 1, 2 …) only as V(1): bare, 1 is the constant
    const re = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(n)
      ? new RegExp(`((?:^|[^\\w#.$])[vi]\\(\\s*)${esc}(?=\\s*\\))`, 'gi')
      : new RegExp(`(^|[^\\w#\\[\\].$])${esc}(?![\\w#\\[])`, 'gi');
    if (re.test(out)) { out = out.replace(re, (_m, pre: string) => `${pre}${PH(i)}`); used.set(PH(i), n); }
  });
  return { text: out, used };
}

export function waveSignals(text: string, names: string[]): string[] { return [...prepare(text, names).used.values()]; }

/** The expression's values at each of the plot's points; throws on what it can't read. */
export function evalWave(text: string, p: Plot): WaveValues {
  const names = p.vectors.map((v) => v.name);
  const { text: t, used } = prepare(text, names);
  const e = parseExpr(t);
  const n = p.x?.values.length ?? p.vectors[0]?.re.length ?? 0;
  const byName = new Map(p.vectors.map((v) => [v.name.toLowerCase(), v]));
  const xs = p.x?.values ?? [];
  const sig = (name: string): Vector => {
    const real = used.get(name) ?? name;
    const v = byName.get(real.toLowerCase());
    if (!v) throw new Error(`no signal ${real}`);
    return v;
  };
  const full = (v: Vector): WaveValues => ({ re: Float64Array.from(v.re), im: v.im ? Float64Array.from(v.im) : null });
  const konst = (re: number, im = 0): WaveValues => ({ re: new Float64Array(n).fill(re), im: im ? new Float64Array(n).fill(im) : null });
  const map = (a: WaveValues, f: (re: number, im: number) => [number, number]): WaveValues => {
    const re = new Float64Array(n), im = new Float64Array(n);
    let cx = false;
    for (let i = 0; i < n; i++) { const [r, j] = f(a.re[i]!, a.im?.[i] ?? 0); re[i] = r; im[i] = j; if (j) cx = true; }
    return { re, im: cx ? im : null };
  };
  const zip = (a: WaveValues, b: WaveValues, f: (ar: number, ai: number, br: number, bi: number) => [number, number]): WaveValues => {
    const re = new Float64Array(n), im = new Float64Array(n);
    let cx = false;
    for (let i = 0; i < n; i++) { const [r, j] = f(a.re[i]!, a.im?.[i] ?? 0, b.re[i]!, b.im?.[i] ?? 0); re[i] = r; im[i] = j; if (j) cx = true; }
    return { re, im: cx ? im : null };
  };
  const real1 = (f: (x: number) => number) => (a: WaveValues) => map(a, (r) => [f(r), 0]);
  const running = (a: WaveValues, rms: boolean): WaveValues => {
    const out = new Float64Array(n);
    let area = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) { const y0 = a.re[i - 1]!, y1 = a.re[i]!; area += ((rms ? y0 * y0 + y1 * y1 : y0 + y1) / 2) * (xs[i]! - xs[i - 1]!); }
      const span = i > 0 ? xs[i]! - xs[0]! : 0;
      out[i] = span > 0 ? (rms ? Math.sqrt(area / span) : area / span) : rms ? Math.abs(a.re[0]!) : a.re[0]!;
    }
    return { re: out, im: null };
  };
  const FN: Record<string, (a: WaveValues) => WaveValues> = {
    abs: (a) => map(a, (r, j) => [Math.hypot(r, j), 0]), mag: (a) => map(a, (r, j) => [Math.hypot(r, j), 0]),
    db: (a) => map(a, (r, j) => [20 * Math.log10(Math.hypot(r, j) || 1e-300), 0]),
    phase: (a) => map(a, (r, j) => [(Math.atan2(j, r) * 180) / Math.PI, 0]), ph: (a) => map(a, (r, j) => [(Math.atan2(j, r) * 180) / Math.PI, 0]),
    real: (a) => map(a, (r) => [r, 0]), re: (a) => map(a, (r) => [r, 0]), imag: (a) => map(a, (_r, j) => [j, 0]), im: (a) => map(a, (_r, j) => [j, 0]),
    sqrt: (a) => map(a, (r, j) => { if (!j && r >= 0) return [Math.sqrt(r), 0]; const m = Math.sqrt(Math.hypot(r, j)), t = Math.atan2(j, r) / 2; return [m * Math.cos(t), m * Math.sin(t)]; }),
    exp: (a) => map(a, (r, j) => { const m = Math.exp(r); return [m * Math.cos(j), m * Math.sin(j)]; }),
    ln: (a) => map(a, (r, j) => [Math.log(Math.hypot(r, j)), j ? Math.atan2(j, r) : 0]), log: (a) => map(a, (r, j) => [Math.log(Math.hypot(r, j)), j ? Math.atan2(j, r) : 0]),
    log10: (a) => map(a, (r, j) => [Math.log10(Math.hypot(r, j)), j ? Math.atan2(j, r) / Math.LN10 : 0]),
    sin: real1(Math.sin), cos: real1(Math.cos), tan: real1(Math.tan), asin: real1(Math.asin), acos: real1(Math.acos), atan: real1(Math.atan),
    sinh: real1(Math.sinh), cosh: real1(Math.cosh), tanh: real1(Math.tanh),
    avg: (a) => running(a, false), rms: (a) => running(a, true),
  };
  const ev = (x: Expr): WaveValues => {
    switch (x.k) {
      case 'num': return konst(x.v);
      case 'var': {
        if (used.has(x.name) || byName.has(x.name.toLowerCase())) return full(sig(x.name));
        const l = x.name.toLowerCase();
        if (l === 'pi') return konst(Math.PI);
        if (l === 'j') return konst(0, 1);
        if (['time', 'frequency', 'freq', p.x?.name.toLowerCase()].includes(l) && p.x) return { re: Float64Array.from(xs), im: null };
        throw new Error(`no signal ${x.name}`);
      }
      case 'un': { const a = ev(x.a); return x.op === '-' ? map(a, (r, j) => [-r, -j]) : map(a, (r) => [r ? 0 : 1, 0]); }
      case 'if': throw new Error('?: is not a wave function');
      case 'call': {
        if (x.fn === 'v') {
          const [a, b] = x.args.map((y) => (y.k === 'var' ? y.name : ''));
          const va = a === '0' ? konst(0) : full(sig(a!));
          return b && b !== '0' ? zip(va, full(sig(b)), (ar, ai, br, bi) => [ar - br, ai - bi]) : va;
        }
        if (x.fn === 'i') {
          const s = x.args[0]?.k === 'var' ? x.args[0].name : '';
          const v = byName.get(`${(used.get(s) ?? s).toLowerCase()}#branch`) ?? byName.get(`${(used.get(s) ?? s).toLowerCase()}[i]`);
          if (!v) throw new Error(`no current I(${used.get(s) ?? s})`);
          return full(v);
        }
        const f = FN[x.fn];
        if (!f || x.args.length !== 1) throw new Error(`no function ${x.fn.toUpperCase()}`);
        return f(ev(x.args[0]!));
      }
      case 'bin': {
        const a = ev(x.a), b = ev(x.b);
        switch (x.op) {
          case '+': return zip(a, b, (ar, ai, br, bi) => [ar + br, ai + bi]);
          case '-': return zip(a, b, (ar, ai, br, bi) => [ar - br, ai - bi]);
          case '*': return zip(a, b, (ar, ai, br, bi) => [ar * br - ai * bi, ar * bi + ai * br]);
          case '/': return zip(a, b, (ar, ai, br, bi) => { const d = br * br + bi * bi; return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d]; });
          case '^': return zip(a, b, (ar, ai, br, bi) => {
            if (!ai && !bi && (ar >= 0 || Number.isInteger(br))) return [ar ** br, 0];
            const lr = Math.log(Math.hypot(ar, ai)), th = Math.atan2(ai, ar);
            const mr = Math.exp(br * lr - bi * th), ang = bi * lr + br * th;
            return [mr * Math.cos(ang), mr * Math.sin(ang)];
          });
          default: throw new Error(`${x.op} is not a wave operator`);
        }
      }
    }
  };
  const out = ev(e);
  if (out.re.length !== n) return konst(out.re[0] ?? NaN);
  return out;
}
