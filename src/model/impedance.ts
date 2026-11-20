/**
 * Layer Stack Manager › Impedance Calculation: AD17's Impedance Formula Editor. Its formulas
 * (Board6 SURFACEMICROSTRIP_I / _W for outer layers, SYMMETRICSTRIPLINE_I / _W for inner ones)
 * work out a track's characteristic impedance from its width, or the width for an impedance,
 * from the stack: TraceToPlaneDistance (the dielectric to the nearest copper layer),
 * PlaneToPlaneDistance (between the copper layers either side, striplines), TraceHeight (the
 * copper's thickness), Er (the dielectric constant) [est: lengths in metres, the unit the
 * microstrip's 0.00002 makes sense in].
 */
import type { PropertyBag } from '../formats/altium/props';
import type { Change } from '../core/undo';
import type { StackLayer } from './pcbStack';
import { UNITS_PER_MM } from '../core/units';

export interface ImpedanceFormulas { microstripZ: string; microstripW: string; striplineZ: string; striplineW: string }

/** AD17's formulas, as every board it writes carries them. */
export const DEFAULT_FORMULAS: ImpedanceFormulas = {
  microstripZ: '(60/SQRT(Er*(1-EXP(-1.55*(0.00002+TraceToPlaneDistance)/TraceToPlaneDistance))))*LN(5.98*TraceToPlaneDistance/(0.8*TraceWidth+TraceHeight))',
  microstripW: '((5.98*TraceToPlaneDistance)/EXP(CharacteristicImpedance/(60/SQRT(Er*(1-EXP(-1.55*(0.00002+TraceToPlaneDistance)/TraceToPlaneDistance)))))-TraceHeight)/0.8',
  striplineZ: '(80/SQRT(Er))*LN((1.9*(2*TraceToPlaneDistance+TraceHeight)/(0.8*TraceWidth+TraceHeight)))*(1-(TraceToPlaneDistance/(4*(PlaneToPlaneDistance-TraceHeight-TraceToPlaneDistance))))',
  striplineW: '((1.9*(2*TraceToPlaneDistance+TraceHeight))/(EXP((CharacteristicImpedance/(80/SQRT(Er)))/(1-(TraceToPlaneDistance/(4*(PlaneToPlaneDistance-TraceHeight-TraceToPlaneDistance))))))-TraceHeight)/0.8',
};
export const FORMULA_KEYS: Record<keyof ImpedanceFormulas, string> = {
  microstripZ: 'SURFACEMICROSTRIP_I', microstripW: 'SURFACEMICROSTRIP_W', striplineZ: 'SYMMETRICSTRIPLINE_I', striplineW: 'SYMMETRICSTRIPLINE_W',
};
export const FORMULA_VARIABLES = ['TraceToPlaneDistance', 'PlaneToPlaneDistance', 'TraceWidth', 'TraceHeight', 'Er', 'CharacteristicImpedance'];

export function boardFormulas(b: PropertyBag | null | undefined): ImpedanceFormulas {
  const out = { ...DEFAULT_FORMULAS };
  for (const k of Object.keys(FORMULA_KEYS) as (keyof ImpedanceFormulas)[]) { const v = b?.get(FORMULA_KEYS[k])?.trim(); if (v) out[k] = v; }
  return out;
}

/** The formulas into the board's Board6 record: one undoable change. */
export function setFormulas(b: PropertyBag, f: ImpedanceFormulas, touched: () => void): Change {
  const before = Object.fromEntries(Object.values(FORMULA_KEYS).map((k) => [k, b.has(k) ? b.getRaw(k) : undefined]));
  const put = (vals: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vals)) { if (v === undefined) b.delete(k); else b.set(k, v); }
    touched();
  };
  const after = Object.fromEntries((Object.keys(FORMULA_KEYS) as (keyof ImpedanceFormulas)[]).map((k) => [FORMULA_KEYS[k], f[k]]));
  return { apply: () => put(after), revert: () => put(before) };
}

/* ── the formulas' language: numbers, variables, + − × ÷ ^, brackets, SQRT EXP LN LOG ABS SIN COS TAN ATAN POWER MIN MAX ── */

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };
function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z_0-9]*)|(\*\*|[-+*/^(),]))/y;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < s.length) {
    re.lastIndex = at;
    m = re.exec(s);
    if (!m || m[0].length === 0) { if (/^\s*$/.test(s.slice(at))) break; throw new Error(`can't read "${s.slice(at, at + 12)}"`); }
    at = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'id', v: m[2] });
    else out.push({ t: 'op', v: m[3] === '**' ? '^' : m[3]! });
  }
  return out;
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  SQRT: Math.sqrt, EXP: Math.exp, LN: Math.log, LOG: Math.log10, ABS: Math.abs, SIN: Math.sin, COS: Math.cos, TAN: Math.tan, ATAN: Math.atan,
  POWER: Math.pow, POW: Math.pow, MIN: Math.min, MAX: Math.max, SQR: (x) => x * x,
};

/** A formula's value with these variables (names as in the formula, any case). Throws when it can't be read. */
export function evalFormula(expr: string, vars: Record<string, number>): number {
  const ts = tokens(expr);
  const v = Object.fromEntries(Object.entries(vars).map(([k, x]) => [k.toUpperCase(), x]));
  let i = 0;
  const peek = () => ts[i];
  const take = (op?: string) => { const t = ts[i]; if (!t || (op && !(t.t === 'op' && t.v === op))) throw new Error(op ? `"${op}" expected` : 'the formula ends too soon'); i++; return t; };
  const isOp = (o: string) => { const t = peek(); return !!t && t.t === 'op' && t.v === o; };
  const primary = (): number => {
    const t = take();
    if (t.t === 'num') return t.v;
    if (t.t === 'op' && t.v === '(') { const x = sum(); take(')'); return x; }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) { const x = power(); return t.v === '-' ? -x : x; }
    if (t.t === 'id') {
      const name = t.v.toUpperCase();
      if (isOp('(')) {
        take('(');
        const args: number[] = [];
        if (!isOp(')')) { args.push(sum()); while (isOp(',')) { take(','); args.push(sum()); } }
        take(')');
        const fn = FUNCS[name];
        if (!fn) throw new Error(`no function ${t.v}`);
        return fn(...args);
      }
      if (name === 'PI') return Math.PI;
      if (!(name in v)) throw new Error(`no value for ${t.v}`);
      return v[name]!;
    }
    throw new Error(`"${t.v}" unexpected`);
  };
  const power = (): number => { const b = primary(); if (isOp('^')) { take('^'); return Math.pow(b, power()); } return b; };
  const product = (): number => {
    let x = power();
    while (isOp('*') || isOp('/')) { const o = take().v; const y = power(); x = o === '*' ? x * y : x / y; }
    return x;
  };
  const sum = (): number => {
    let x = product();
    while (isOp('+') || isOp('-')) { const o = take().v; const y = product(); x = o === '+' ? x + y : x - y; }
    return x;
  };
  const out = sum();
  if (i < ts.length) throw new Error(`"${(ts[i] as { v: unknown }).v}" unexpected`);
  return out;
}

/** Whether a formula reads (and which names it uses that aren't variables). */
export function checkFormula(expr: string): string | null {
  try {
    evalFormula(expr, Object.fromEntries(FORMULA_VARIABLES.map((n) => [n, 1e-4])));
    return null;
  } catch (e) { return (e as Error).message; }
}

/* ── the stack's geometry for each signal layer ── */

export interface LayerGeometry {
  layer: number; name: string;
  /** Outer layers: microstrip; inner: stripline. */
  kind: 'microstrip' | 'stripline';
  /** Board units. */
  traceToPlane: number; planeToPlane: number; thickness: number;
  er: number;
}

/**
 * Each signal layer's geometry from the stack (top to bottom): the dielectric to the nearest
 * copper layer (a reference plane, as the formulas take it), for an inner layer also the
 * distance between the copper layers either side; the dielectric's constant (the thinner side's).
 */
export function stackGeometry(rows: StackLayer[]): LayerGeometry[] {
  const copper = rows.map((r, i) => ({ r, i })).filter((x) => x.r.kind === 'signal' || x.r.kind === 'plane');
  const out: LayerGeometry[] = [];
  copper.forEach(({ r, i }, k) => {
    if (r.kind !== 'signal' || r.layer === null) return;
    const side = (dir: -1 | 1) => {
      const next = copper[k + dir];
      if (!next) return null;
      let gap = 0, er = 0, w = 0;
      for (let j = i + dir; j !== next.i; j += dir) {
        const d = rows[j]!;
        if (d.kind === 'dielectric') { gap += d.height; er += d.dielConst * d.height; w += d.height; }
      }
      return { gap, er: w > 0 ? er / w : 4.2, next: next.r };
    };
    const up = side(-1), down = side(1);
    const sides = [up, down].filter((x): x is NonNullable<typeof x> => !!x);
    if (!sides.length) return;
    const near = sides.reduce((a, b) => (b.gap < a.gap ? b : a));
    const inner = !!up && !!down;
    out.push({
      layer: r.layer, name: r.name, kind: inner ? 'stripline' : 'microstrip',
      traceToPlane: near.gap, planeToPlane: inner ? up!.gap + down!.gap + r.copper : 0, thickness: r.copper, er: near.er,
    });
  });
  return out;
}

const M = (units: number) => units / UNITS_PER_MM / 1000;
const vars = (g: LayerGeometry) => ({ TraceToPlaneDistance: M(g.traceToPlane), PlaneToPlaneDistance: M(g.planeToPlane), TraceHeight: M(g.thickness), Er: g.er });

/** A track's impedance (Ω) on a layer from its width (board units); NaN when the formula can't say. */
export function impedanceOf(f: ImpedanceFormulas, g: LayerGeometry, width: number): number {
  try { return evalFormula(g.kind === 'stripline' ? f.striplineZ : f.microstripZ, { ...vars(g), TraceWidth: M(width) }); } catch { return NaN; }
}
/** The width (board units) for an impedance (Ω) on a layer; NaN when the formula can't say. */
export function widthFor(f: ImpedanceFormulas, g: LayerGeometry, ohms: number): number {
  try { return evalFormula(g.kind === 'stripline' ? f.striplineW : f.microstripW, { ...vars(g), CharacteristicImpedance: ohms }) * 1000 * UNITS_PER_MM; } catch { return NaN; }
}
