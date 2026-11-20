/**
 * Expressions in netlists: {R*2}, .param values, behavioural sources (V={V(a)*2}), AD's
 * output expressions. Numbers take SPICE's scale factors; + - * / ^ (and **), comparisons,
 * && ||, ?:, unary minus, and the functions SPICE simulators share. V(node), V(a,b), I(source)
 * and time come from the environment.
 */
import { spiceNumber } from './num';

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'call'; fn: string; args: Expr[] }
  | { k: 'un'; op: string; a: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'if'; c: Expr; a: Expr; b: Expr };

export interface ExprEnv {
  /** A parameter or variable (time, temper, a .param …); undefined when unknown. */
  vars?: (name: string) => number | undefined;
  /** V(a) or V(a,b). */
  v?: (a: string, b?: string) => number;
  /** I(source). */
  i?: (name: string) => number;
}

class P {
  i = 0;
  constructor(readonly s: string) {}
  ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++; }
  peek(t: string) { this.ws(); return this.s.startsWith(t, this.i); }
  eat(t: string) { if (this.peek(t)) { this.i += t.length; return true; } return false; }
  fail(msg: string): never { throw new Error(`${msg} at "${this.s.slice(this.i, this.i + 12)}" in ${this.s}`); }
}

function ternary(p: P): Expr {
  const c = or(p);
  if (p.eat('?')) { const a = ternary(p); if (!p.eat(':')) p.fail('expected :'); const b = ternary(p); return { k: 'if', c, a, b }; }
  return c;
}
function or(p: P): Expr { let a = and(p); while (p.eat('||')) a = { k: 'bin', op: '||', a, b: and(p) }; return a; }
function and(p: P): Expr { let a = cmp(p); while (p.eat('&&')) a = { k: 'bin', op: '&&', a, b: cmp(p) }; return a; }
function cmp(p: P): Expr {
  let a = add(p);
  for (;;) {
    const op = ['==', '!=', '<=', '>=', '<', '>'].find((o) => p.peek(o));
    if (!op) return a;
    p.eat(op);
    a = { k: 'bin', op, a, b: add(p) };
  }
}
function add(p: P): Expr {
  let a = mul(p);
  for (;;) {
    if (p.eat('+')) a = { k: 'bin', op: '+', a, b: mul(p) };
    else if (p.peek('-')) { p.eat('-'); a = { k: 'bin', op: '-', a, b: mul(p) }; }
    else return a;
  }
}
function mul(p: P): Expr {
  let a = unary(p);
  for (;;) {
    if (p.eat('*')) a = { k: 'bin', op: '*', a, b: unary(p) };
    else if (p.eat('/')) a = { k: 'bin', op: '/', a, b: unary(p) };
    else if (p.eat('%')) a = { k: 'bin', op: '%', a, b: unary(p) };
    else return a;
  }
}
function unary(p: P): Expr {
  if (p.eat('-')) return { k: 'un', op: '-', a: unary(p) };
  if (p.eat('+')) return unary(p);
  if (p.eat('!')) return { k: 'un', op: '!', a: unary(p) };
  return pow(p);
}
function pow(p: P): Expr {
  const a = atom(p);
  if (p.eat('^') || p.eat('**')) return { k: 'bin', op: '^', a, b: unary(p) };
  return a;
}
function atom(p: P): Expr {
  p.ws();
  if (p.eat('(')) { const e = ternary(p); if (!p.eat(')')) p.fail('expected )'); return e; }
  if (p.eat('{')) { const e = ternary(p); if (!p.eat('}')) p.fail('expected }'); return e; }
  const rest = p.s.slice(p.i);
  const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?((meg|mil|[tgkmuµμnpf])\d*)?[a-zΩ]*/i.exec(rest);
  if (num) { p.i += num[0].length; return { k: 'num', v: spiceNumber(num[0]) }; }
  const id = /^[a-z_$][\w$.#:\[\]]*/i.exec(rest);
  if (!id) p.fail('expected a value');
  p.i += id[0].length;
  const name = id[0];
  if (p.peek('(')) {
    p.eat('(');
    const args: Expr[] = [];
    // V(a,b) and I(V1) take node and source names, not expressions
    if (/^[vi]$/i.test(name)) {
      const close = p.s.indexOf(')', p.i);
      if (close < 0) p.fail('expected )');
      for (const a of p.s.slice(p.i, close).split(',')) args.push({ k: 'var', name: a.trim() });
      p.i = close + 1;
      return { k: 'call', fn: name.toLowerCase(), args };
    }
    if (!p.peek(')')) { do args.push(ternary(p)); while (p.eat(',')); }
    if (!p.eat(')')) p.fail('expected )');
    return { k: 'call', fn: name.toLowerCase(), args };
  }
  return { k: 'var', name };
}

export function parseExpr(text: string): Expr {
  const p = new P(text.trim().replace(/^\{([\s\S]*)\}$/, '$1'));
  const e = ternary(p);
  p.ws();
  if (p.i < p.s.length) p.fail('unexpected text');
  return e;
}

/** A number between -1 and 1 for each whole number, the same every time it is asked (a hash, not a random draw). */
function hash1(i: number): number {
  let h = Math.imul(i | 0, 374761393) + 668265263 | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 2147483647.5 - 1;
}
/** The segments (bit 0 is a, bit 6 is g) of a seven-segment digit for 0 to 15 (A, b, C, d, E, F above nine). */
const SEG7 = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71];

const FN: Record<string, (...a: number[]) => number> = {
  // Noise as a function of its argument: a value for each whole number and a smooth run between them, so that a source
  // of it is the same at the same time however the steps fall (noise(time * B) has its content below about B hertz)
  noise: (x) => { const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f); return hash1(i) * (1 - s) + hash1(i + 1) * s; },
  // Logic by numbers: bit n of a whole number; a over b's remainder; whether segment s (0 is a) of a seven-segment digit is lit
  bit: (x, n) => (Math.round(x) >> Math.round(n)) & 1, mod: (a, b) => a - b * Math.floor(a / b),
  seg7: (x, s) => (SEG7[Math.round(x) & 15]! >> Math.round(s)) & 1,
  sqrt: Math.sqrt, exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  abs: Math.abs, min: Math.min, max: Math.max, pow: Math.pow, pwr: (a, b) => Math.sign(a) * Math.abs(a) ** b, floor: Math.floor, ceil: Math.ceil,
  int: Math.trunc, round: Math.round, sgn: Math.sign, sign: (a, b) => Math.abs(a) * Math.sign(b ?? 1), u: (x) => (x > 0 ? 1 : 0),
  limit: (x, a, b) => Math.min(Math.max(x, Math.min(a, b)), Math.max(a, b)), if: (c, a, b) => (c ? a : b), db: (x) => 20 * Math.log10(Math.abs(x)),
};

/** The value of an expression (NaN for what can't be known). */
export function evalExpr(e: Expr, env: ExprEnv = {}): number {
  switch (e.k) {
    case 'num': return e.v;
    case 'var': {
      const v = env.vars?.(e.name);
      if (v !== undefined) return v;
      const l = e.name.toLowerCase();
      if (l === 'pi') return Math.PI;
      if (l === 'e') return Math.E;
      return NaN;
    }
    case 'un': { const a = evalExpr(e.a, env); return e.op === '-' ? -a : a ? 0 : 1; }
    case 'if': return evalExpr(e.c, env) ? evalExpr(e.a, env) : evalExpr(e.b, env);
    case 'bin': {
      const a = evalExpr(e.a, env), b = evalExpr(e.b, env);
      switch (e.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return a % b;
        case '^': return a ** b; case '==': return a === b ? 1 : 0; case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0; case '>': return a > b ? 1 : 0; case '<=': return a <= b ? 1 : 0; case '>=': return a >= b ? 1 : 0;
        case '&&': return a && b ? 1 : 0; case '||': return a || b ? 1 : 0;
      }
      return NaN;
    }
    case 'call': {
      if (e.fn === 'v') {
        const [a, b] = e.args.map((x) => (x.k === 'var' ? x.name : ''));
        return env.v ? env.v(a!, b) : NaN;
      }
      if (e.fn === 'i') return env.i ? env.i((e.args[0] as { name: string }).name) : NaN;
      const f = FN[e.fn];
      return f ? f(...e.args.map((a) => evalExpr(a, env))) : NaN;
    }
  }
}

/** Where a compiled expression reads from: the unknowns' vector, and the time and temperature (°C) of the moment. */
export interface ExprAt { x: ArrayLike<number>; time: number; temper: number }
/** What an expression's names stand for in the unknowns' vector: a node's voltage (-1: 0 V), a source's current (-1: none, read as 0). */
export interface ExprBind { node(name: string): number; branch(name: string): number }

/**
 * An expression made into a function of the unknowns, once, for a source that is asked for its value many times in
 * every step (and for it again with each unknown moved a little, for its slopes). It gives what evalExpr gives with an
 * environment that knows time, temper, V() and I() and nothing else: the names are looked up here, not at every asking.
 */
export function compileExpr(e: Expr, bind: ExprBind): (at: ExprAt) => number {
  switch (e.k) {
    case 'num': { const v = e.v; return () => v; }
    case 'var': {
      const l = e.name.toLowerCase();
      if (l === 'time') return (at) => at.time;
      if (l === 'temper') return (at) => at.temper;
      const v = l === 'pi' ? Math.PI : l === 'e' ? Math.E : NaN;
      return () => v;
    }
    case 'un': { const a = compileExpr(e.a, bind); return e.op === '-' ? (at) => -a(at) : (at) => (a(at) ? 0 : 1); }
    case 'if': { const c = compileExpr(e.c, bind), a = compileExpr(e.a, bind), b = compileExpr(e.b, bind); return (at) => (c(at) ? a(at) : b(at)); }
    case 'bin': {
      const a = compileExpr(e.a, bind), b = compileExpr(e.b, bind);
      switch (e.op) {
        case '+': return (at) => a(at) + b(at);
        case '-': return (at) => a(at) - b(at);
        case '*': return (at) => a(at) * b(at);
        case '/': return (at) => a(at) / b(at);
        case '%': return (at) => a(at) % b(at);
        case '^': return (at) => a(at) ** b(at);
        case '==': return (at) => (a(at) === b(at) ? 1 : 0);
        case '!=': return (at) => (a(at) !== b(at) ? 1 : 0);
        case '<': return (at) => (a(at) < b(at) ? 1 : 0);
        case '>': return (at) => (a(at) > b(at) ? 1 : 0);
        case '<=': return (at) => (a(at) <= b(at) ? 1 : 0);
        case '>=': return (at) => (a(at) >= b(at) ? 1 : 0);
        // (both sides are worked out, as evalExpr works them out)
        case '&&': return (at) => { const x = a(at), y = b(at); return x && y ? 1 : 0; };
        case '||': return (at) => { const x = a(at), y = b(at); return x || y ? 1 : 0; };
      }
      return () => NaN;
    }
    case 'call': {
      if (e.fn === 'v') {
        const [p, n] = e.args.map((x) => (x.k === 'var' ? x.name : ''));
        const i = bind.node(p!), j = n ? bind.node(n) : -1;
        if (i < 0 && j < 0) return () => 0;
        if (j < 0) return (at) => at.x[i]!;
        if (i < 0) return (at) => 0 - at.x[j]!;
        return (at) => at.x[i]! - at.x[j]!;
      }
      if (e.fn === 'i') { const k = bind.branch((e.args[0] as { name: string }).name); return k < 0 ? () => 0 : (at) => at.x[k]!; }
      const f = FN[e.fn];
      if (!f) return () => NaN;
      const args = e.args.map((a) => compileExpr(a, bind));
      if (args.length === 1) { const a = args[0]!; return (at) => f(a(at)); }
      if (args.length === 2) { const a = args[0]!, b = args[1]!; return (at) => f(a(at), b(at)); }
      if (args.length === 3) { const a = args[0]!, b = args[1]!, c = args[2]!; return (at) => f(a(at), b(at), c(at)); }
      return (at) => f(...args.map((a) => a(at)));
    }
  }
}

/** The V(...) and I(...) an expression reads: [kind, names]. */
export function exprProbes(e: Expr, out: { v: [string, string | undefined][]; i: string[] } = { v: [], i: [] }): { v: [string, string | undefined][]; i: string[] } {
  if (e.k === 'call') {
    if (e.fn === 'v') out.v.push([(e.args[0] as { name: string }).name, (e.args[1] as { name: string } | undefined)?.name]);
    else if (e.fn === 'i') out.i.push((e.args[0] as { name: string }).name);
    else e.args.forEach((a) => exprProbes(a, out));
  } else if (e.k === 'un') exprProbes(e.a, out);
  else if (e.k === 'bin') { exprProbes(e.a, out); exprProbes(e.b, out); }
  else if (e.k === 'if') { exprProbes(e.c, out); exprProbes(e.a, out); exprProbes(e.b, out); }
  return out;
}
