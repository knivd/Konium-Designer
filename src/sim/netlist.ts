/**
 * SPICE netlists — AD's own (.nsx), and the model (.mdl) and subcircuit (.ckt) files its
 * libraries name — read into a flat circuit: elements R C L K V I E F G H D Q M J S W B and
 * subcircuit instances X expanded (their nodes and models scoped as SPICE does), .model,
 * .subckt / .ends, .param, .options, .ic, .nodeset, .temp, .include, and the analyses .op,
 * .tran, .ac, .dc, .tf, .noise, .pz. Values take scale factors, {expressions} and parameters.
 */
import { evalExpr, parseExpr, type Expr } from './expr';
import { spiceNumber } from './num';

export type SourceFn = { kind: 'SIN' | 'PULSE' | 'PWL' | 'EXP' | 'SFFM' | 'AM'; args: number[] };
export interface SourceSpec { dc: number; dcGiven: boolean; acMag: number; acPhase: number; fn?: SourceFn }

export type ElKind = 'R' | 'C' | 'L' | 'K' | 'V' | 'I' | 'E' | 'F' | 'G' | 'H' | 'D' | 'Q' | 'M' | 'J' | 'S' | 'W' | 'B';
export interface Element {
  /** Its name as the netlist gives it (a subcircuit's: the instance path first, X1.R1). */
  name: string;
  kind: ElKind;
  nodes: string[];
  /** R, C, L: the value; E, G, F, H: the gain; K: the coupling. */
  value?: number;
  model?: string;
  /** name=value pairs (lower-case names): L, W, IC, AREA, M, TC1 … */
  params: Record<string, number>;
  /** OFF, ON, and the like. */
  flags: string[];
  /** F, H, W: the controlling voltage source; K: the inductors. */
  ctrl?: string[];
  src?: SourceSpec;
  /** B: the expression and whether it gives a voltage or a current. */
  expr?: Expr;
  exprKind?: 'V' | 'I';
  /** E and G with VALUE={…} work as a B source. */
  line: number;
}

export interface ModelCard { name: string; type: string; params: Record<string, number> }

export type Analysis =
  | { kind: 'op' }
  | { kind: 'tran'; tstep: number; tstop: number; tstart: number; tmax: number; uic: boolean }
  | { kind: 'ac'; sweep: 'dec' | 'oct' | 'lin'; points: number; fstart: number; fstop: number }
  | { kind: 'dc'; sweeps: { src: string; start: number; stop: number; step: number }[] }
  | { kind: 'tf'; out: [string, string]; outCurrent?: string; src: string }
  | { kind: 'noise'; out: [string, string]; src: string; sweep: 'dec' | 'oct' | 'lin'; points: number; fstart: number; fstop: number; pts: number }
  | { kind: 'pz'; in: [string, string]; out: [string, string]; transfer: 'vol' | 'cur'; what: 'pz' | 'pol' | 'zer' }
  | { kind: 'four'; freq: number; outs: string[]; harmonics: number };

export interface Circuit {
  title: string;
  elements: Element[];
  models: Map<string, ModelCard>;
  options: Record<string, number | string | boolean>;
  ic: Map<string, number>;
  nodeset: Map<string, number>;
  analyses: Analysis[];
  temps: number[];
  /** Lines it couldn't take, with why. */
  errors: { line: number; message: string }[];
  /** .save / probes: what to keep. */
  saves: string[];
  /** .STEP: every analysis again for each value of TEMP, a part's value or a model parameter (Q1[BF]) [est: Konium's card]. */
  steps: StepCard[];
  /** .MC: Monte Carlo runs with parts' values varied within their tolerances [est: Konium's card]. */
  mc?: McCard;
}

export interface StepCard { target: string; values: number[]; relative: boolean }
export interface McCard {
  runs: number; seed: number; dist: 'uniform' | 'gauss' | 'wcase';
  /** Tolerances as fractions: resistors, capacitors, inductors, transistors, DC sources; and by part. */
  res: number; cap: number; ind: number; tran: number; dcsrc: number; specific: Map<string, number>;
}

/** A tolerance as written: 10%, 0.1. */
export function tolerance(t: string | undefined): number {
  if (!t) return NaN;
  const m = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*%$/i.exec(t.trim());
  return m ? Number(m[1]) / 100 : Number(t);
}

interface Line { n: number; text: string; file: string }
interface Subckt { name: string; ports: string[]; params: Record<string, string>; body: Line[]; models: Map<string, ModelCard>; subs: Map<string, Subckt> }

/** The lines of a netlist: '+' continuations joined, comments (*, ; and $) and blank lines dropped. */
function lines(text: string, file: string, title: boolean): { title: string; out: Line[] } {
  const raw = text.replace(/\r/g, '').split('\n');
  const out: Line[] = [];
  let first = '';
  raw.forEach((r, i) => {
    if (title && i === 0) { first = r.trim(); return; }
    let t = r.replace(/\t/g, ' ');
    if (/^\s*\*/.test(t)) return;
    t = t.replace(/(^|\s)(;|\$\s).*$/, '').replace(/\s;.*$/, '');
    if (!t.trim()) return;
    if (/^\s*\+/.test(t) && out.length) { out.at(-1)!.text += ` ${t.replace(/^\s*\+/, '')}`; return; }
    out.push({ n: i + 1, text: t.trim(), file });
  });
  return { title: first, out };
}

/** Tokens: words, {expressions}, "strings", and ( ) = , apart. */
export function tokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '{') { let d = 0, j = i; for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) break; } out.push(s.slice(i, j + 1)); i = j + 1; continue; }
    if (c === '"' || c === "'") { const j = s.indexOf(c, i + 1); out.push(s.slice(i, j < 0 ? s.length : j + 1)); i = j < 0 ? s.length : j + 1; continue; }
    if ('()=,'.includes(c)) { out.push(c); i++; continue; }
    let j = i;
    while (j < s.length && !/[\s()=,{]/.test(s[j]!)) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

type Scope = (name: string) => number | undefined;

/** A value token: a number, {expression} or a parameter's name. */
function value(tok: string | undefined, scope: Scope): number {
  if (tok === undefined) return NaN;
  const n = spiceNumber(tok);
  if (!Number.isNaN(n) && /^[+-]?(\d|\.\d)/.test(tok)) return n;
  try { return evalExpr(parseExpr(tok), { vars: scope }); } catch { return NaN; }
}

/** key=value pairs among tokens (and the bare words left). */
function pairs(toks: string[], scope: Scope): { kv: Record<string, number>; raw: Record<string, string>; bare: string[] } {
  const kv: Record<string, number> = {}, raw: Record<string, string> = {};
  const bare: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t === '(' || t === ')' || t === ',') continue;
    if (toks[i + 1] === '=') {
      // a value may be a parenthesised list (IC=1,2): its first number
      let v = toks[i + 2];
      if (v === '(') v = toks[i + 3];
      kv[t.toLowerCase()] = value(v, scope);
      raw[t.toLowerCase()] = v ?? '';
      i += 2;
      continue;
    }
    bare.push(t);
  }
  return { kv, raw, bare };
}

const SOURCE_FNS = new Set(['SIN', 'PULSE', 'PWL', 'EXP', 'SFFM', 'AM']);

function source(toks: string[], scope: Scope): SourceSpec {
  const s: SourceSpec = { dc: 0, dcGiven: false, acMag: 0, acPhase: 0 };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!, u = t.toUpperCase();
    if (u === 'DC') { s.dc = value(toks[++i], scope); s.dcGiven = true; continue; }
    if (u === 'AC') {
      s.acMag = 1;
      const m = value(toks[i + 1], scope);
      if (!Number.isNaN(m)) { s.acMag = m; i++; const ph = value(toks[i + 1], scope); if (!Number.isNaN(ph)) { s.acPhase = ph; i++; } }
      continue;
    }
    if (SOURCE_FNS.has(u)) {
      const args: number[] = [];
      let j = i + 1;
      const paren = toks[j] === '(';
      if (paren) j++;
      for (; j < toks.length; j++) {
        const a = toks[j]!;
        if (a === ')') { if (paren) { j++; break; } continue; }
        if (a === ',') continue;
        const v = value(a, scope);
        if (Number.isNaN(v)) break;
        args.push(v);
      }
      s.fn = { kind: u as SourceFn['kind'], args };
      i = j - 1;
      continue;
    }
    const v = value(t, scope);
    if (!Number.isNaN(v) && !s.dcGiven) { s.dc = v; s.dcGiven = true; }
  }
  return s;
}

const MODEL_TYPES = /^(d|npn|pnp|nmos|pmos|njf|pjf|sw|csw|r|res|c|cap|l|ind|vdmos|nmf|pmf)$/i;

function modelCard(toks: string[], scope: Scope, prefix: string): ModelCard {
  const name = toks[1] ?? '';
  let type = (toks[2] ?? '').toUpperCase();
  const { kv } = pairs(toks.slice(3), scope);
  if (type === 'VDMOS') type = kv.pchan ? 'PMOS' : 'NMOS';
  if (type === 'RES') type = 'R';
  if (type === 'CAP') type = 'C';
  if (type === 'IND') type = 'L';
  return { name: `${prefix}${name}`.toLowerCase(), type, params: kv };
}

/** Text of an included file, by the name the netlist gives (null: not found). */
export type Includer = (name: string) => string | null;

export interface ReadOptions { title?: boolean; include?: Includer; file?: string }

/** A netlist read and flattened. */
export function readNetlist(text: string, opts: ReadOptions = {}): Circuit {
  const c: Circuit = { title: '', elements: [], models: new Map(), options: {}, ic: new Map(), nodeset: new Map(), analyses: [], temps: [], errors: [], saves: [], steps: [] };
  const { title, out } = lines(text, opts.file ?? '', opts.title ?? true);
  c.title = title;
  const params = new Map<string, number>();
  const globals = new Set(['0', 'gnd']);
  // .include: the files' lines in their place (once each; .lib file section: that section, once)
  const seen = new Set<string>();
  const expand = (ls: Line[], included: boolean): Line[] => ls.flatMap((l) => {
    // In an included file: its .end doesn't end the netlist; a library's own section markers (.lib name, .endl) go
    if (included && /^\.(end|endl)\b/i.test(l.text)) return [];
    const m = /^\.(include|inc|lib)\s+("([^"]+)"|'([^']+)'|(\S+))(\s+(\S+))?/i.exec(l.text);
    if (!m) return [l];
    const lib = /^lib$/i.test(m[1]!);
    if (included && lib && !m[7]) return [];
    const name = m[3] ?? m[4] ?? m[5]!;
    const key = `${name.toLowerCase()}${lib && m[7] ? `\u0000${m[7].toLowerCase()}` : ''}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const t = opts.include?.(name) ?? null;
    if (t === null) { c.errors.push({ line: l.n, message: `${name}: included file not found` }); return []; }
    let body = lines(t, name, false).out;
    // .lib file section: only that section
    if (lib && m[7]) {
      const sec = m[7].toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const from = body.findIndex((x) => new RegExp(`^\\.lib\\s+${sec}\\s*$`, 'i').test(x.text));
      const to = body.findIndex((x, k) => k > from && /^\.endl\b/i.test(x.text));
      if (from < 0) { c.errors.push({ line: l.n, message: `${name}: no section ${m[7]}` }); return []; }
      body = body.slice(from + 1, to < 0 ? undefined : to);
    }
    return expand(body, true);
  });
  const all = expand(out, false);
  // Subcircuit definitions (nested ones inside theirs), the rest top-level
  const top: Line[] = [];
  const subs = new Map<string, Subckt>();
  const stack: Subckt[] = [];
  for (const l of all) {
    const t = l.text, u = t.toUpperCase();
    if (u.startsWith('.SUBCKT')) {
      const toks = tokens(t);
      const pi = toks.findIndex((x) => /^params:$/i.test(x));
      const ports: string[] = [];
      const ps: Record<string, string> = {};
      let k = 2;
      for (; k < toks.length; k++) {
        if (k === pi) continue;
        if (toks[k + 1] === '=') { ps[toks[k]!.toLowerCase()] = toks[k + 2] ?? ''; k += 2; continue; }
        if (pi >= 0 && k > pi) continue;
        ports.push(toks[k]!);
      }
      const s: Subckt = { name: (toks[1] ?? '').toLowerCase(), ports, params: ps, body: [], models: new Map(), subs: new Map() };
      (stack.at(-1)?.subs ?? subs).set(s.name, s);
      stack.push(s);
      continue;
    }
    if (u.startsWith('.ENDS')) { stack.pop(); continue; }
    if (stack.length) stack.at(-1)!.body.push(l); else top.push(l);
    if (/^\.end\b/i.test(t) && !stack.length) break;
  }
  const scopeOf = (local: Map<string, number>): Scope => (n) => local.get(n.toLowerCase()) ?? params.get(n.toLowerCase());
  // .param, .global first (they may come after their use)
  for (const l of top) {
    const u = l.text.toUpperCase();
    if (u.startsWith('.PARAM')) { const { kv } = pairs(tokens(l.text).slice(1), scopeOf(new Map())); for (const [k, v] of Object.entries(kv)) params.set(k, v); }
    if (u.startsWith('.GLOBAL')) for (const g of tokens(l.text).slice(1)) globals.add(g.toLowerCase());
  }
  for (const l of top) if (/^\.model\b/i.test(l.text)) { const m = modelCard(tokens(l.text), scopeOf(new Map()), ''); c.models.set(m.name, m); }

  // Elements, with subcircuits expanded: nodes and names scoped by the instance path
  const element = (l: Line, path: string, nodeMap: (n: string) => string, modelName: (n: string) => string, scope: Scope, localSubs: Map<string, Subckt>[], depth: number): void => {
    const toks = tokens(l.text);
    const name = toks[0]!;
    const k = name[0]!.toUpperCase();
    const full = path ? `${path}.${name}` : name;
    const fail = (message: string) => c.errors.push({ line: l.n, message: `${full}: ${message}` });
    const nodesN = (n: number) => toks.slice(1, 1 + n).map(nodeMap);
    const el = (kind: ElKind, nodes: string[], extra: Partial<Element>): void => { c.elements.push({ name: full, kind, nodes, params: {}, flags: [], line: l.n, ...extra }); };
    switch (k) {
      case 'R': case 'C': case 'L': {
        const nodes = nodesN(2);
        const rest = toks.slice(3);
        const { kv, bare } = pairs(rest, scope);
        let v = NaN, model: string | undefined;
        const flags: string[] = [];
        for (const b of bare) {
          const x = value(b, scope);
          if (!Number.isNaN(x) && Number.isNaN(v)) v = x;
          else if (/^[a-z_]/i.test(b) && model === undefined && c.models.has(modelName(b).toLowerCase())) model = modelName(b);
          else if (/^[a-z]/i.test(b)) flags.push(b.toUpperCase());
        }
        if (Number.isNaN(v) && kv[k.toLowerCase()] !== undefined) v = kv[k.toLowerCase()]!;
        if (Number.isNaN(v) && !model) { fail('no value'); return; }
        el(k as ElKind, nodes, { value: v, params: kv, model, flags });
        return;
      }
      case 'K': {
        const v = value(toks[3], scope);
        el('K', [], { ctrl: [path ? `${path}.${toks[1]}` : toks[1]!, path ? `${path}.${toks[2]}` : toks[2]!], value: v });
        return;
      }
      case 'V': case 'I': {
        const nodes = nodesN(2);
        el(k as ElKind, nodes, { src: source(toks.slice(3), scope) });
        return;
      }
      case 'E': case 'G': {
        const nodes = nodesN(2);
        const vi = toks.findIndex((x) => /^value$/i.test(x));
        if (vi >= 0) {
          const ex = toks[vi + 2] ?? '';
          try { el('B', nodes, { expr: scopedExpr(parseExpr(ex), path, nodeMap, scope), exprKind: k === 'E' ? 'V' : 'I' }); } catch (e) { fail((e as Error).message); }
          return;
        }
        if (/^poly$/i.test(toks[3] ?? '')) { fail('POLY sources are not supported'); return; }
        el(k as ElKind, [...nodes, ...toks.slice(3, 5).map(nodeMap)], { value: value(toks[5], scope) });
        return;
      }
      case 'F': case 'H': {
        const nodes = nodesN(2);
        el(k as ElKind, nodes, { ctrl: [path ? `${path}.${toks[3]}` : toks[3]!], value: value(toks[4], scope) });
        return;
      }
      case 'B': {
        const nodes = nodesN(2);
        const m = /^\S+\s+\S+\s+\S+\s+([vi])\s*=\s*([\s\S]+)$/i.exec(l.text);
        if (!m) { fail('expected V= or I='); return; }
        try { el('B', nodes, { expr: scopedExpr(parseExpr(m[2]!), path, nodeMap, scope), exprKind: m[1]!.toUpperCase() as 'V' | 'I' }); } catch (e) { fail((e as Error).message); }
        return;
      }
      case 'D': {
        const nodes = nodesN(2);
        const { kv, bare } = pairs(toks.slice(4), scope);
        const area = bare.map((b) => value(b, scope)).find((x) => !Number.isNaN(x));
        el('D', nodes, { model: modelName(toks[3] ?? ''), params: { ...kv, ...(area !== undefined ? { area } : {}) }, flags: bare.filter((b) => /^(off)$/i.test(b)).map((b) => b.toUpperCase()) });
        return;
      }
      case 'Q': {
        // A fourth node when the token after three nodes isn't a model the netlist knows
        const known = (n: string | undefined) => !!n && c.models.has(modelName(n).toLowerCase());
        const four = !known(toks[4]) && known(toks[5]);
        const n = four ? 4 : 3;
        const { kv, bare } = pairs(toks.slice(2 + n), scope);
        const area = bare.map((b) => value(b, scope)).find((x) => !Number.isNaN(x));
        el('Q', nodesN(n), { model: modelName(toks[1 + n] ?? ''), params: { ...kv, ...(area !== undefined ? { area } : {}) }, flags: bare.filter((b) => /^off$/i.test(b)).map((b) => b.toUpperCase()) });
        return;
      }
      case 'M': {
        const { kv, bare } = pairs(toks.slice(6), scope);
        el('M', nodesN(4), { model: modelName(toks[5] ?? ''), params: kv, flags: bare.filter((b) => /^off$/i.test(b)).map((b) => b.toUpperCase()) });
        return;
      }
      case 'J': {
        const { kv, bare } = pairs(toks.slice(5), scope);
        const area = bare.map((b) => value(b, scope)).find((x) => !Number.isNaN(x));
        el('J', nodesN(3), { model: modelName(toks[4] ?? ''), params: { ...kv, ...(area !== undefined ? { area } : {}) } });
        return;
      }
      case 'S': {
        el('S', nodesN(4), { model: modelName(toks[5] ?? ''), flags: toks.slice(6).filter((b) => /^(on|off)$/i.test(b)).map((b) => b.toUpperCase()) });
        return;
      }
      case 'W': {
        el('W', nodesN(2), { ctrl: [path ? `${path}.${toks[3]}` : toks[3]!], model: modelName(toks[4] ?? ''), flags: toks.slice(5).filter((b) => /^(on|off)$/i.test(b)).map((b) => b.toUpperCase()) });
        return;
      }
      case 'X': {
        if (depth > 40) { fail('subcircuits nested too deep'); return; }
        // The subcircuit's name: the last word that isn't a parameter
        const pi = toks.findIndex((x, i) => i > 0 && (toks[i + 1] === '=' || /^params:$/i.test(x)));
        const head = (pi < 0 ? toks : toks.slice(0, pi)).filter((x) => x !== '(' && x !== ')' && x !== ',');
        const subName = head.at(-1)!.toLowerCase();
        const sub = [...localSubs.map((m) => m.get(subName)), subs.get(subName)].find(Boolean);
        if (!sub) { fail(`subcircuit ${head.at(-1)} not found`); return; }
        const actual = head.slice(1, -1).map(nodeMap);
        if (actual.length !== sub.ports.length) { fail(`${actual.length} nodes for ${sub.ports.length} ports of ${sub.name}`); return; }
        const { kv } = pairs(pi < 0 ? [] : toks.slice(pi).filter((x) => !/^params:$/i.test(x)), scope);
        // The subcircuit's parameters: its defaults, the instance's values
        const local = new Map<string, number>();
        for (const [pk, pv] of Object.entries(sub.params)) local.set(pk, value(pv, scope));
        for (const [pk, pv] of Object.entries(kv)) local.set(pk, pv);
        const inner = scopeOf(local);
        const sScope: Scope = (n) => inner(n) ?? scope(n);
        const portOf = new Map(sub.ports.map((p, i) => [p.toLowerCase(), actual[i]!]));
        const inst = full;
        const innerNode = (n: string) => { const l = n.toLowerCase(); return portOf.get(l) ?? (globals.has(l) ? (l === 'gnd' ? '0' : n) : `${inst}.${n}`); };
        // Its own models (scoped to it), then its elements
        const mine = new Map<string, ModelCard>();
        for (const b of sub.body) if (/^\.model\b/i.test(b.text)) { const m = modelCard(tokens(b.text), sScope, `${inst}.`); mine.set(m.name, m); c.models.set(m.name, m); }
        const innerModel = (n: string) => (mine.has(`${inst}.${n}`.toLowerCase()) ? `${inst}.${n}` : modelName(n));
        for (const b of sub.body) {
          if (b.text.startsWith('.')) { if (/^\.param\b/i.test(b.text)) { const { kv: pk } = pairs(tokens(b.text).slice(1), sScope); for (const [x, y] of Object.entries(pk)) local.set(x, y); } continue; }
          element(b, inst, innerNode, innerModel, sScope, [sub.subs, ...localSubs], depth + 1);
        }
        return;
      }
      default: fail(`element type ${k} is not supported`);
    }
  };
  const topNode = (n: string) => (n.toLowerCase() === 'gnd' ? '0' : n);
  for (const l of top) {
    const t = l.text;
    if (t.startsWith('.')) { dotCard(c, l, scopeOf(new Map())); continue; }
    element(l, '', topNode, (n) => n, scopeOf(new Map()), [], 0);
  }
  return c;
}

/** An expression's V(node) names put into the instance's scope. */
function scopedExpr(e: Expr, path: string, nodeMap: (n: string) => string, scope: Scope): Expr {
  const walk = (x: Expr): Expr => {
    switch (x.k) {
      case 'call':
        if (x.fn === 'v') return { ...x, args: x.args.map((a) => (a.k === 'var' ? { k: 'var', name: nodeMap(a.name) } : a)) };
        if (x.fn === 'i') return { ...x, args: x.args.map((a) => (a.k === 'var' ? { k: 'var', name: path ? `${path}.${a.name}` : a.name } : a)) };
        return { ...x, args: x.args.map(walk) };
      case 'var': { const v = scope(x.name); return v !== undefined ? { k: 'num', v } : x; }
      case 'un': return { ...x, a: walk(x.a) };
      case 'bin': return { ...x, a: walk(x.a), b: walk(x.b) };
      case 'if': return { ...x, c: walk(x.c), a: walk(x.a), b: walk(x.b) };
      default: return x;
    }
  };
  return walk(e);
}

const vNode = (toks: string[], i: number): { a: string; b: string; next: number } => {
  // V(a) or V(a,b) as tokens: V ( a , b )
  if (/^v$/i.test(toks[i] ?? '') && toks[i + 1] === '(') {
    const a = toks[i + 2]!;
    if (toks[i + 3] === ',') return { a, b: toks[i + 4]!, next: i + 6 };
    return { a, b: '0', next: i + 4 };
  }
  return { a: toks[i] ?? '', b: '0', next: i + 1 };
};

function dotCard(c: Circuit, l: Line, scope: Scope): void {
  const toks = tokens(l.text);
  const card = toks[0]!.toLowerCase();
  const num = (i: number) => value(toks[i], scope);
  switch (card) {
    case '.model': case '.param': case '.global': case '.end': case '.ends': case '.endl': break;
    case '.options': case '.option': case '.opt': {
      const { kv, raw, bare } = pairs(toks.slice(1), scope);
      for (const [k, v] of Object.entries(kv)) c.options[k] = Number.isNaN(v) ? raw[k]! : v;
      for (const b of bare) c.options[b.toLowerCase()] = true;
      break;
    }
    case '.ic': case '.nodeset': {
      const into = card === '.ic' ? c.ic : c.nodeset;
      for (let i = 1; i < toks.length;) {
        const { a, next } = vNode(toks, i);
        if (toks[next] !== '=') { i = next; continue; }
        into.set(a, value(toks[next + 1], scope));
        i = next + 2;
      }
      break;
    }
    case '.temp': for (const t of toks.slice(1)) { const v = value(t, scope); if (!Number.isNaN(v)) c.temps.push(v); } break;
    case '.step': {
      // .STEP [PARAM] target start stop step [REL] — or .STEP target LIST v1 v2 …
      let i = 1;
      if (/^param$/i.test(toks[i] ?? '')) i++;
      const target = toks[i++] ?? '';
      const rest = toks.slice(i);
      const relative = rest.some((x) => /^rel(ative)?$/i.test(x));
      const list = /^list$/i.test(rest[0] ?? '');
      const nums = rest.filter((x) => !/^(rel|relative|list|lin)$/i.test(x)).map((x) => value(x, scope));
      let values: number[] = [];
      if (list) values = nums;
      else {
        const [a = NaN, b = NaN, st = NaN] = nums;
        if ([a, b, st].every(Number.isFinite) && st !== 0) {
          const k = Math.floor((b - a) / st + 1e-9);
          if (k >= 0 && k < 1000) for (let j = 0; j <= k; j++) values.push(a + j * st);
        }
      }
      if (!target || !values.length || values.some((v) => !Number.isFinite(v))) { c.errors.push({ line: l.n, message: '.step: target start stop step (or LIST values), at most 1000 values' }); break; }
      c.steps.push({ target, values, relative });
      break;
    }
    case '.mc': {
      const runs = Math.round(num(1));
      if (!(runs >= 1 && runs <= 1000)) { c.errors.push({ line: l.n, message: '.mc: the number of runs (1 to 1000)' }); break; }
      const { raw } = pairs(toks.slice(2), scope);
      const known = new Set(['seed', 'dist', 'res', 'cap', 'ind', 'tran', 'dcsrc']);
      const tol = (k: string) => { const v = tolerance(raw[k]); return Number.isFinite(v) ? Math.abs(v) : 0; };
      const dist = (raw.dist ?? 'uniform').toLowerCase();
      c.mc = {
        runs, seed: Number.isFinite(Number(raw.seed)) ? Number(raw.seed) : -1, dist: dist.startsWith('gauss') ? 'gauss' : dist.startsWith('w') ? 'wcase' : 'uniform',
        res: tol('res'), cap: tol('cap'), ind: tol('ind'), tran: tol('tran'), dcsrc: tol('dcsrc'),
        specific: new Map(Object.keys(raw).filter((k) => !known.has(k)).map((k) => [k, Math.abs(tolerance(raw[k]))] as [string, number]).filter(([, v]) => Number.isFinite(v))),
      };
      break;
    }
    case '.op': c.analyses.push({ kind: 'op' }); break;
    case '.tran': {
      const nums = toks.slice(1).filter((x) => !/^uic$/i.test(x)).map((x) => value(x, scope));
      const [tstep = NaN, tstop = NaN, tstart = 0, tmax = NaN] = nums;
      if (!(tstop > 0)) { c.errors.push({ line: l.n, message: '.tran: no stop time' }); break; }
      if ((tstart || 0) >= tstop) { c.errors.push({ line: l.n, message: '.tran: the start time is at or past the stop time' }); break; }
      c.analyses.push({ kind: 'tran', tstep: tstep > 0 ? tstep : tstop / 50, tstop, tstart: tstart || 0, tmax: tmax > 0 ? tmax : Math.min(tstep > 0 ? tstep : Infinity, (tstop - (tstart || 0)) / 50), uic: toks.some((x) => /^uic$/i.test(x)) });
      break;
    }
    case '.ac': {
      const sweep = (toks[1] ?? 'dec').toLowerCase() as 'dec' | 'oct' | 'lin';
      c.analyses.push({ kind: 'ac', sweep: ['dec', 'oct', 'lin'].includes(sweep) ? sweep : 'dec', points: num(2), fstart: num(3), fstop: num(4) });
      break;
    }
    case '.dc': {
      const sweeps: { src: string; start: number; stop: number; step: number }[] = [];
      for (let i = 1; i + 3 < toks.length + 1 && toks[i]; i += 4) sweeps.push({ src: toks[i]!, start: num(i + 1), stop: num(i + 2), step: num(i + 3) });
      c.analyses.push({ kind: 'dc', sweeps });
      break;
    }
    case '.tf': {
      const o = vNode(toks, 1);
      const isV = /^v$/i.test(toks[1] ?? '');
      c.analyses.push({ kind: 'tf', out: [o.a, o.b], ...(isV ? {} : { outCurrent: toks[3] }), src: toks[isV ? o.next : 4] ?? '' });
      break;
    }
    case '.noise': {
      const o = vNode(toks, 1);
      const i = o.next;
      c.analyses.push({ kind: 'noise', out: [o.a, o.b], src: toks[i] ?? '', sweep: (toks[i + 1] ?? 'dec').toLowerCase() as 'dec', points: num(i + 2), fstart: num(i + 3), fstop: num(i + 4), pts: num(i + 5) || 0 });
      break;
    }
    case '.pz': {
      const [a, b, x, y] = toks.slice(1, 5);
      c.analyses.push({ kind: 'pz', in: [a ?? '', b ?? '0'], out: [x ?? '', y ?? '0'], transfer: /^cur$/i.test(toks[5] ?? '') ? 'cur' : 'vol', what: ((toks[6] ?? 'pz').toLowerCase() as 'pz') });
      break;
    }
    case '.four': {
      const outs: string[] = [];
      for (let i = 2; i < toks.length;) { const o = vNode(toks, i); outs.push(o.a); i = o.next; }
      c.analyses.push({ kind: 'four', freq: num(1), outs, harmonics: 10 });
      break;
    }
    case '.save': case '.probe': case '.print': case '.plot': {
      for (let i = 1; i < toks.length;) { const o = vNode(toks, i); if (/^(all|tran|ac|dc|op)$/i.test(o.a)) { i = o.next; continue; } c.saves.push(o.a); i = o.next; }
      break;
    }
    default:
      if (!/^\.(width|control|endc|print|plot|title|lib)$/i.test(card)) c.errors.push({ line: l.n, message: `${card}: not supported, left out` });
  }
}

export { MODEL_TYPES };
