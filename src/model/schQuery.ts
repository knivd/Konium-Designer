/**
 * Altium's query language, schematic side (SCH Filter, Find Similar's Create Expression):
 * comparisons on any Inspector property by its name without spaces (ObjectKind = 'Part',
 * Text Like 'VCC*', X1 > 2000mil, Locked = True), the IsPart / IsWire … keywords for every object
 * kind, All, InComponent('U1'), HasParameter('Value', '10k'), HasModel('PCBLIB', '0805'),
 * combined with And / Or / Not, && / || / !, and parentheses. Strings compare without regard to
 * case; Like takes * and ? wildcards; lengths compare as lengths whatever their units.
 */
import { parseLength } from '../core/units';
import { SR, bagOf, type SchDocument, type SchObject } from './sch';
import { objectKind, schProps, type SchCtx, type SchProp } from './schProps';

export class QueryError extends Error {}

export type QueryNode = Node;
type Node =
  | { t: 'or' | 'and'; a: Node; b: Node }
  | { t: 'not'; a: Node }
  | { t: 'cmp'; op: string; a: Node; b: Node }
  | { t: 'str'; v: string }
  | { t: 'num'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'id'; name: string }
  | { t: 'call'; name: string; args: Node[] };

interface Tok { k: 'str' | 'num' | 'id' | 'op' | 'p'; v: string; at: number }

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1, v = '';
      while (j < src.length && src[j] !== c) v += src[j++];
      if (j >= src.length) throw new QueryError(`Unterminated string at ${i + 1}`);
      out.push({ k: 'str', v, at: i }); i = j + 1; continue;
    }
    const two = src.slice(i, i + 2);
    if (['<>', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ k: 'op', v: two, at: i }); i += 2; continue; }
    if ('=<>!'.includes(c)) { out.push({ k: 'op', v: c, at: i }); i++; continue; }
    if ('(),'.includes(c)) { out.push({ k: 'p', v: c, at: i }); i++; continue; }
    const num = /^-?(\d+\.?\d*|\.\d+)(mil|mm|in)?/i.exec(src.slice(i));
    if (num && (c === '-' || /\d|\./.test(c))) { out.push({ k: 'num', v: num[0], at: i }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (id) { out.push({ k: 'id', v: id[0], at: i }); i += id[0].length; continue; }
    throw new QueryError(`Unexpected '${c}' at ${i + 1}`);
  }
  return out;
}

export function parseSchQuery(src: string): Node {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const isWord = (w: string) => peek()?.k === 'id' && peek()!.v.toLowerCase() === w;
  const expect = (v: string) => { const t = toks[i]; if (!t || t.v !== v) throw new QueryError(`Expected '${v}'${t ? ` at ${t.at + 1}` : ' at the end'}`); i++; };
  const or = (): Node => { let a = and(); while (isWord('or') || peek()?.v === '||') { i++; a = { t: 'or', a, b: and() }; } return a; };
  const and = (): Node => { let a = not(); while (isWord('and') || peek()?.v === '&&') { i++; a = { t: 'and', a, b: not() }; } return a; };
  const not = (): Node => { if (isWord('not') || peek()?.v === '!') { i++; return { t: 'not', a: not() }; } return cmp(); };
  const cmp = (): Node => {
    const a = term();
    const t = peek();
    if (t?.k === 'op' && !['&&', '||', '!'].includes(t.v)) { i++; return { t: 'cmp', op: t.v === '!=' ? '<>' : t.v, a, b: term() }; }
    if (isWord('like')) { i++; return { t: 'cmp', op: 'like', a, b: term() }; }
    return a;
  };
  const term = (): Node => {
    const t = toks[i++];
    if (!t) throw new QueryError('Unexpected end of query');
    if (t.k === 'p' && t.v === '(') { const e = or(); expect(')'); return e; }
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'id') {
      const w = t.v.toLowerCase();
      if (w === 'true' || w === 'false') return { t: 'bool', v: w === 'true' };
      if (peek()?.v === '(') {
        i++;
        const args: Node[] = [];
        if (peek()?.v !== ')') { args.push(or()); while (peek()?.v === ',') { i++; args.push(or()); } }
        expect(')');
        return { t: 'call', name: t.v, args };
      }
      return { t: 'id', name: t.v };
    }
    throw new QueryError(`Unexpected '${t.v}' at ${t.at + 1}`);
  };
  if (!toks.length) return { t: 'bool', v: true };
  const n = or();
  if (i < toks.length) throw new QueryError(`Unexpected '${toks[i]!.v}' at ${toks[i]!.at + 1}`);
  return n;
}

/* ─── Evaluation ────────────────────────────────────────────────────────────────────── */

/** British and American spellings are the same word to a query (Colour = Color, Centre = Center). */
export const fold = (s: string) => s.toLowerCase().replace(/colour/g, 'color').replace(/centre/g, 'center').replace(/grey/g, 'gray').replace(/analogue/g, 'analog');
export const squash = (s: string) => fold(s.replace(/[\s/()-]+/g, ''));
/** Altium keywords that aren't simply the Inspector name without spaces. */
const ALIASES: Record<string, string[]> = {
  designator: ['componentdesignator', 'pindesignator'], partcomment: ['partcomment'], comment: ['partcomment'],
  libreference: ['symbolreference'], libraryreference: ['symbolreference'], footprint: ['currentfootprint'],
  parametername: ['name'], parametervalue: ['value', 'text'], pinname: ['name'], netlabeltext: ['text'], net: ['text'],
  objectkind: ['objectkind'], electrical: ['electricaltype'], ishidden: ['hide'],
};
const KINDS = ['Part', 'Pin', 'Wire', 'Bus', 'Bus Entry', 'Net Label', 'Power Object', 'Off Sheet Connector', 'Port', 'Junction', 'No ERC', 'Text Frame', 'Note',
  'Line', 'Polyline', 'Polygon', 'Rectangle', 'Round Rectangle', 'Ellipse', 'Arc', 'Elliptical Arc', 'Bezier', 'Image', 'Sheet Symbol', 'Sheet Entry', 'Parameter',
  'Designator', 'Text String', 'Sheet Symbol Designator', 'Sheet Symbol File Name', 'IEEE Symbol', 'Pie Chart', 'Compile Mask', 'Parameter Set'];
const IS: Record<string, string> = Object.fromEntries(KINDS.map((k) => [`is${squash(k)}`, k]));
IS.isannotation = 'Text String';
IS.islabel = 'Text String';
IS.ispowerport = 'Power Object';

export const QUERY_KEYWORDS = ['All', ...KINDS.map((k) => `Is${k.replace(/\s+/g, '')}`), "InComponent('U1')", "HasParameter('Value', '10k')", "HasModel('PCBLIB', '0805')"];

/** A value in a query: text with its kind (a 'coord' compares as a length; a bare number then is in `unit`). */
export type Val = { s: string; type?: string; unit?: string } | boolean | undefined;

export function wild(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

export interface QueryTarget { x: SchCtx; props?: SchProp[] }

function lookup(tg: QueryTarget, name: string): Val {
  const o = tg.x.doc.objects[tg.x.index]!;
  tg.props ??= schProps(tg.x.doc, o, tg.x.libraryMode);
  const want = [squash(name), ...(ALIASES[squash(name)] ?? [])];
  for (const w of want) {
    const p = tg.props.find((q) => squash(q.name) === w);
    if (p) { const v = p.get(tg.x); return p.type === 'bool' ? v === 'true' : { s: v, type: p.type }; }
  }
  return undefined;
}

function partOf(doc: SchDocument, o: SchObject): SchObject | undefined {
  if (o.kind === 'component') return o;
  const ow = o.owner >= 0 ? doc.objects[o.owner] : undefined;
  return ow?.kind === 'component' ? ow : undefined;
}

function call(tg: QueryTarget, name: string, args: Val[]): boolean {
  const doc = tg.x.doc, o = doc.objects[tg.x.index]!;
  const w = squash(name);
  const str = (v: Val) => (typeof v === 'object' ? v.s : typeof v === 'boolean' ? String(v) : '');
  if (w === 'all') return true;
  if (IS[w]) return objectKind(doc, o) === IS[w];
  if (w === 'incomponent') {
    const p = partOf(doc, o);
    return !!p && p.kind === 'component' && wild(str(args[0])).test(p.designator);
  }
  if (w === 'hasparameter') {
    if (o.kind !== 'component') return false;
    return doc.objects.some((c) => c.owner === o.index && c.record === SR.PARAMETER && wild(str(args[0])).test(bagOf(doc, c)?.get('NAME') ?? '')
      && (args.length < 2 || wild(str(args[1])).test(bagOf(doc, c)?.get('TEXT') ?? '')));
  }
  if (w === 'hasmodel') {
    if (o.kind !== 'component') return false;
    const lists = new Set(doc.objects.filter((c) => c.owner === o.index && c.record === SR.IMPLEMENTATION_LIST).map((c) => c.index));
    return doc.objects.some((c) => c.record === SR.IMPLEMENTATION && lists.has(c.owner) && wild(str(args[0])).test(bagOf(doc, c)?.get('MODELTYPE') ?? '')
      && (args.length < 2 || wild(str(args[1])).test(bagOf(doc, c)?.get('MODELNAME') ?? '')));
  }
  throw new QueryError(`Unknown keyword ${name}`);
}

/** What a query asks of the objects it runs over: property values by name, keyword functions. */
export interface QueryHost { lookup(name: string): Val; call(name: string, args: Val[]): boolean; isKeyword(squashed: string): boolean }

function value(n: Node, h: QueryHost): Val {
  switch (n.t) {
    case 'str': return { s: n.v };
    case 'num': return { s: n.v, type: 'num' };
    case 'bool': return n.v;
    case 'id': {
      const w = squash(n.name);
      if (h.isKeyword(w)) return h.call(n.name, []);
      return h.lookup(n.name);
    }
    case 'call': return h.call(n.name, n.args.map((a) => value(a, h)));
    default: return testQuery(n, h);
  }
}

function compare(op: string, a: Val, b: Val): boolean {
  if (a === undefined || b === undefined) return false;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const x = typeof a === 'boolean' ? a : /^(true|t|1)$/i.test(a.s), y = typeof b === 'boolean' ? b : /^(true|t|1)$/i.test(b.s);
    return op === '=' ? x === y : op === '<>' ? x !== y : false;
  }
  if (op === 'like') return wild(b.s).test(a.s);
  // Lengths and numbers compare as numbers
  const lengthy = a.type === 'coord' || b.type === 'coord';
  const unit = a.unit ?? b.unit ?? 'mil';
  const bare = (t: string) => /^-?(\d+\.?\d*|\.\d+)$/.test(t.trim());
  const num = (v: { s: string; type?: string }) => (lengthy ? parseLength(v.s) ?? (bare(v.s) ? parseLength(`${v.s.trim()}${unit}`) : undefined) : bare(v.s) ? Number(v.s) : undefined);
  const x = num(a), y = num(b);
  if (x !== undefined && y !== undefined) {
    const tol = lengthy ? 1 : 1e-9;
    switch (op) {
      case '=': return Math.abs(x - y) <= tol;
      case '<>': return Math.abs(x - y) > tol;
      case '<': return x < y - tol;
      case '>': return x > y + tol;
      case '<=': return x <= y + tol;
      case '>=': return x >= y - tol;
    }
  }
  const p = fold(a.s), q = fold(b.s);
  switch (op) {
    case '=': return p === q;
    case '<>': return p !== q;
    case '<': return p < q;
    case '>': return p > q;
    case '<=': return p <= q;
    case '>=': return p >= q;
  }
  return false;
}

/** Does the object the host stands for pass this (parsed) query? */
export function testQuery(n: Node, h: QueryHost): boolean {
  switch (n.t) {
    case 'or': return testQuery(n.a, h) || testQuery(n.b, h);
    case 'and': return testQuery(n.a, h) && testQuery(n.b, h);
    case 'not': return !testQuery(n.a, h);
    case 'cmp': return compare(n.op, value(n.a, h), value(n.b, h));
    default: { const v = value(n, h); return v === true || (typeof v === 'object' && /^(true|t)$/i.test(v.s)); }
  }
}

const schHost = (tg: QueryTarget): QueryHost => ({ lookup: (name) => lookup(tg, name), call: (name, args) => call(tg, name, args), isKeyword: (w) => w === 'all' || !!IS[w] });

/** The objects of a document that pass a query (indices); throws QueryError for a bad query. */
export function runSchQuery(src: string, doc: SchDocument, ctx: Omit<SchCtx, 'index' | 'doc'>): number[] {
  const n = parseSchQuery(src);
  const out: number[] = [];
  for (const o of doc.objects) {
    if (o.kind === 'meta' || o.record === SR.SHEET) continue;
    if (testQuery(n, schHost({ x: { ...ctx, doc, index: o.index } }))) out.push(o.index);
  }
  return out;
}

/** A query matching one object's chosen properties (Find Similar › Create Expression). */
export function expressionFor(pairs: { name: string; value: string; same: boolean }[]): string {
  const q = (v: string) => `'${v.replace(/'/g, '')}'`;
  return pairs.map((p) => {
    const key = p.name.replace(/\s+/g, '');
    if (p.value === 'true' || p.value === 'false') return `(${key} ${p.same ? '=' : '<>'} ${p.value === 'true' ? 'True' : 'False'})`;
    return `(${key} ${p.same ? '=' : '<>'} ${q(p.value)})`;
  }).join(' && ') || 'All';
}
