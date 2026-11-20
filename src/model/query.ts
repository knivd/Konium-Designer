/**
 * AD's query language, as rule scopes use it: membership (InNet, InNetClass, InComponent,
 * InComponentClass, InPadClass, InPolygon / InPoly, InNamedPolygon, InPolygonClass,
 * InDifferentialPair(Class), WithinRoom, TouchesRoom, InRegion, HasFootprint …), object kinds
 * (IsPad, IsVia, IsTrack, IsSMTPad, IsThruPad, IsPolygon, IsKeepOut …), layers (OnLayer — the
 * object's own layer, ExistsOnLayer — multi-layer objects too, OnTopLayer, OnSignal, OnPlane,
 * OnMultiLayer …) and properties compared with = <> < > <= >= and Like (Net, ObjectKind, Layer,
 * HoleDiameter, PadXSize, Width, AsMils(…), AsMM(…)), joined by And, Or, Not and parentheses.
 *
 * Evaluation has three outcomes: true, false and unknown (a function Konium can't evaluate, such
 * as InxSignalClass). And / Or / Not follow Kleene's logic, so a scope with an unknown part is
 * still decided when the rest decides it; the DRC holds back what an unknown scope might cover
 * rather than reporting it under a lower rule (AD would have applied the unknown one).
 */
import { layerName, L, type LayerId } from './layers';
import { NO_NET, copperNet, inPour, type PcbDocument, type PcbPrim } from './pcb';
import { netInPair, netInPairClass } from './diffPairs';
import { membersOf } from './pcbClasses';
import { roomsOf } from './rooms';
import { UNITS_PER_MIL, UNITS_PER_MM } from '../core/units';
import { pointInPoly, type Vec2 } from '../core/geom';

export class UnsupportedQuery extends Error {}

/** A length (internal units), told apart from a plain number (a bare number is in mils when compared with one). */
interface Len { len: number }
type Val = boolean | number | string | Len | null;
type Node =
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number; unit?: 'mil' | 'mm' | 'in' }
  | { t: 'const'; v: boolean }
  | { t: 'and' | 'or'; a: Node; b: Node }
  | { t: 'not'; a: Node }
  | { t: 'cmp'; op: string; a: Node; b: Node };

function tokenise(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === ',') { out.push(c); i++; continue; }
    if (c === '<' || c === '>' || c === '=') {
      const two = s.slice(i, i + 2);
      if (two === '<>' || two === '<=' || two === '>=') { out.push(two); i += 2; } else { out.push(c); i++; }
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1, v = '';
      // '' inside a string is a quote
      while (j < s.length) { if (s[j] === c) { if (s[j + 1] === c) { v += c; j += 2; continue; } break; } v += s[j++]; }
      out.push(`'${v}`); i = j + 1; continue;
    }
    if (/[0-9.]/.test(c) || (c === '-' && /[0-9.]/.test(s[i + 1] ?? ''))) {
      const m = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(mil|mm|in)?/i.exec(s.slice(i))!;
      out.push(`#${m[0]}`); i += m[0].length; continue;
    }
    let j = i;
    while (j < s.length && /[A-Za-z0-9_.$]/.test(s[j]!)) j++;
    if (j === i) throw new UnsupportedQuery(`unexpected '${c}' in query`);
    out.push(s.slice(i, j)); i = j;
  }
  return out;
}

const CMP = new Set(['=', '<>', '<', '>', '<=', '>=', 'like']);

export function parseQuery(src: string): Node {
  const toks = tokenise(src.trim() || 'All');
  let p = 0;
  const peek = () => toks[p];
  const low = () => peek()?.toLowerCase();
  const take = (v?: string) => { const t = toks[p++]; if (v && t?.toLowerCase() !== v) throw new UnsupportedQuery(`expected ${v}`); return t; };
  const value = (): Node => {
    const t = peek();
    if (t === undefined) throw new UnsupportedQuery('empty query');
    if (t === '(') { take(); const n = or(); take(')'); return n; }
    if (t.startsWith("'")) { take(); return { t: 'str', v: t.slice(1) }; }
    if (t.startsWith('#')) {
      take();
      const m = /^(-?[0-9.e+-]+?)(mil|mm|in)?$/i.exec(t.slice(1))!;
      return { t: 'num', v: Number(m[1]), ...(m[2] ? { unit: m[2].toLowerCase() as 'mil' } : {}) };
    }
    const l = t.toLowerCase();
    if (l === 'true') { take(); return { t: 'const', v: true }; }
    if (l === 'false') { take(); return { t: 'const', v: false }; }
    take();
    const args: Node[] = [];
    if (peek() === '(') {
      take();
      while (peek() !== ')') {
        if (peek() === undefined) throw new UnsupportedQuery('unclosed (');
        if (peek() === ',') { take(); continue; }
        args.push(or());
      }
      take(')');
    }
    return { t: 'call', name: t, args };
  };
  const cmp = (): Node => {
    const a = value();
    const op = low();
    if (op && CMP.has(op)) { take(); return { t: 'cmp', op, a, b: value() }; }
    return a;
  };
  const unary = (): Node => (low() === 'not' ? (take(), { t: 'not', a: unary() }) : cmp());
  const and = (): Node => { let n = unary(); while (low() === 'and') { take(); n = { t: 'and', a: n, b: unary() }; } return n; };
  const or = (): Node => { let n = and(); while (low() === 'or') { take(); n = { t: 'or', a: n, b: and() }; } return n; };
  const n = or();
  if (p !== toks.length) throw new UnsupportedQuery(`unexpected '${toks[p]}'`);
  return n;
}

/** `asComponent`: the scope is a component-level rule's (Height, Component Clearance …), asked of the component's primitives, so IsComponent holds. */
export interface QueryContext { doc: PcbDocument; polygonNames: Map<number, string>; asComponent?: boolean }

/** Polygons' names by index (InNamedPolygon and the like). */
export function queryContext(doc: PcbDocument, asComponent = false): QueryContext {
  return { doc, polygonNames: new Map(doc.polygons.map((p) => [p.index, p.name])), ...(asComponent ? { asComponent } : {}) };
}

const lname = (doc: PcbDocument, l: LayerId) => (doc.board.layerNames.get(l) ?? layerName(l));
/** A layer as a query names it: the board's name or AD's ('Top Layer', 'TopLayer', 'Keep-Out Layer', 'KeepOutLayer', 'Mid-Layer 1' …). */
function layerIs(doc: PcbDocument, l: LayerId, name: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');
  const want = norm(name);
  return [lname(doc, l), layerName(l)].some((n) => norm(n) === want);
}

function layerOf(p: PcbPrim): LayerId | undefined {
  return 'layer' in p ? p.layer : p.kind === 'via' ? L.MULTI : undefined;
}
const isCopperLayer = (l: LayerId) => (l >= L.TOP && l <= L.BOTTOM) || (l >= L.PLANE1 && l <= L.PLANE16);
const isPlaneLayer = (l: LayerId) => l >= L.PLANE1 && l <= L.PLANE16;

/** Whether a multi-layer object (a through pad, a via) is on a copper layer. */
function spans(doc: PcbDocument, p: PcbPrim, l: LayerId): boolean {
  if (!isCopperLayer(l)) return false;
  if (p.kind === 'via') {
    const st = doc.board.copperStack, a = st.indexOf(p.layerStart), b = st.indexOf(p.layerEnd), at = st.indexOf(l);
    if (at < 0) return isPlaneLayer(l);
    return a < 0 || b < 0 || (at >= Math.min(a, b) && at <= Math.max(a, b));
  }
  return true;
}

/** A wildcard pattern (* and ?) as AD's membership functions and Like take them, any case. */
function like(pattern: string, s: string): boolean {
  if (!/[*?]/.test(pattern)) return pattern.toLowerCase() === s.toLowerCase();
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return re.test(s);
}

const UNKNOWN = null;
const truth = (v: Val): boolean | null => (v === null ? null : typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : typeof v === 'string' ? v !== '' : v.len !== 0);

function boxOfPrim(p: PcbPrim): { minX: number; minY: number; maxX: number; maxY: number } | null {
  switch (p.kind) {
    case 'track': { const r = p.width / 2; return { minX: Math.min(p.a.x, p.b.x) - r, minY: Math.min(p.a.y, p.b.y) - r, maxX: Math.max(p.a.x, p.b.x) + r, maxY: Math.max(p.a.y, p.b.y) + r }; }
    case 'arc': { const r = p.r + p.width / 2; return { minX: p.c.x - r, minY: p.c.y - r, maxX: p.c.x + r, maxY: p.c.y + r }; }
    case 'via': { const r = p.diameter / 2; return { minX: p.at.x - r, minY: p.at.y - r, maxX: p.at.x + r, maxY: p.at.y + r }; }
    case 'pad': { const r = Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h) / 2; return { minX: p.at.x - r, minY: p.at.y - r, maxX: p.at.x + r, maxY: p.at.y + r }; }
    case 'fill': return { minX: Math.min(p.a.x, p.b.x), minY: Math.min(p.a.y, p.b.y), maxX: Math.max(p.a.x, p.b.x), maxY: Math.max(p.a.y, p.b.y) };
    case 'region': { const xs = p.outline.map((q) => q.x), ys = p.outline.map((q) => q.y); return xs.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } : null; }
    case 'text': return { minX: p.at.x, minY: p.at.y, maxX: p.at.x + p.height, maxY: p.at.y + p.height };
    default: return null;
  }
}
const corners = (b: { minX: number; minY: number; maxX: number; maxY: number }): Vec2[] => [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];

type Fn = (args: Node[], p: PcbPrim, ctx: QueryContext) => Val;

/** Membership in any of the classes of a kind named by `args` (their members as `nameOf` gives the object's). */
function inClass(kind: number, all: string, nameOf: (p: PcbPrim, ctx: QueryContext) => string | null): Fn {
  return (args, p, ctx) => {
    const own = nameOf(p, ctx);
    if (own === null) return false;
    return anyOf(args, p, ctx, (a) => {
      if (like(a, all)) return own !== '';
      const cls = ctx.doc.classes.filter((c) => c.kind === kind && like(a, c.name));
      return cls.some((c) => membersOf(ctx.doc, c).some((m) => m.toLowerCase() === own.toLowerCase()));
    });
  };
}
/** Any of the arguments (strings) passing. */
function anyOf(args: Node[], p: PcbPrim, ctx: QueryContext, test: (a: string) => boolean): Val {
  let unknown = false;
  for (const n of args) {
    const v = evalNode(n, p, ctx);
    if (v === null) { unknown = true; continue; }
    if (test(String(typeof v === 'object' ? v.len : v))) return true;
  }
  return unknown ? UNKNOWN : false;
}

const netName = (p: PcbPrim, ctx: QueryContext): string => { const n = copperNet(ctx.doc, p); return n !== NO_NET ? ctx.doc.nets[n]?.name ?? '' : ''; };
const compOf = (p: PcbPrim, ctx: QueryContext) => ('component' in p && p.component !== NO_NET ? ctx.doc.components[p.component] : undefined);
const inPoly = inPour;
const padName = (p: PcbPrim, ctx: QueryContext): string | null => { if (p.kind !== 'pad') return null; const c = compOf(p, ctx); return c ? `${c.designator}-${p.name}` : `Free-${p.name}`; };
const len = (v: number): Len => ({ len: v });
const layerFn = (test: (l: LayerId, p: PcbPrim, ctx: QueryContext) => boolean): Fn => (_a, p, ctx) => { const l = layerOf(p); return l !== undefined && test(l, p, ctx); };
const kindIs = (...k: PcbPrim['kind'][]): Fn => (_a, p) => k.includes(p.kind);
const unknown: Fn = () => UNKNOWN;

const roomCache = new WeakMap<object, ReturnType<typeof roomsOf>>();
function roomTest(mode: 'within' | 'touches'): Fn {
  return (args, p, ctx) => {
    const box = boxOfPrim(p);
    if (!box) return false;
    let rooms = roomCache.get(ctx.doc.rules);
    if (!rooms) { rooms = roomsOf(ctx.doc); roomCache.set(ctx.doc.rules, rooms); }
    return anyOf(args, p, ctx, (a) => rooms.some((r) => like(a, r.name) && (mode === 'within'
      ? corners(box).every((q) => pointInPoly(q, r.outline))
      : corners(box).some((q) => pointInPoly(q, r.outline)) || r.outline.some((q) => q.x >= box.minX && q.x <= box.maxX && q.y >= box.minY && q.y <= box.maxY))));
  };
}

const FNS: Record<string, Fn> = {
  all: () => true,
  /* membership */
  innet: (a, p, ctx) => anyOf(a, p, ctx, (x) => like(x, netName(p, ctx)) && netName(p, ctx) !== ''),
  inanynet: (_a, p, ctx) => netName(p, ctx) !== '',
  innetclass: inClass(0, 'All Nets', (p, ctx) => netName(p, ctx)),
  incomponent: (a, p, ctx) => { const c = compOf(p, ctx); return !!c && anyOf(a, p, ctx, (x) => like(x, c.designator)); },
  inanycomponent: (_a, p, ctx) => !!compOf(p, ctx),
  incomponentclass: inClass(1, 'All Components', (p, ctx) => compOf(p, ctx)?.designator ?? null),
  inpadclass: inClass(3, 'All Pads', padName),
  inpad: (a, p, ctx) => { const n = padName(p, ctx); return n !== null && anyOf(a, p, ctx, (x) => like(x, n)); },
  hasfootprint: (a, p, ctx) => { const c = compOf(p, ctx); return !!c && anyOf(a, p, ctx, (x) => like(x, c.pattern)); },
  hasfootprintpad: (a, p, ctx) => { const c = compOf(p, ctx); if (!c || p.kind !== 'pad' || a.length < 2) return false; const f = evalNode(a[0]!, p, ctx), n = evalNode(a[1]!, p, ctx); return f === null || n === null ? UNKNOWN : like(String(f), c.pattern) && like(String(n), p.name); },
  inpolygon: (a, p, ctx) => (!a.length ? inPoly(p) : inPoly(p) && anyOf(a, p, ctx, (x) => like(x, ctx.polygonNames.get((p as { polygon: number }).polygon) ?? ''))),
  inanypolygon: (_a, p) => inPoly(p),
  innamedpolygon: (a, p, ctx) => inPoly(p) && anyOf(a, p, ctx, (x) => like(x, ctx.polygonNames.get((p as { polygon: number }).polygon) ?? '')),
  inpolygonclass: inClass(7, 'All Polygons', (p, ctx) => (inPoly(p) ? ctx.polygonNames.get((p as { polygon: number }).polygon) ?? '' : null)),
  indifferentialpair: (a, p, ctx) => { const n = netName(p, ctx); return !!n && anyOf(a, p, ctx, (x) => netInPair(ctx.doc, n, x)); },
  indifferentialpairclass: (a, p, ctx) => { const n = netName(p, ctx); return !!n && anyOf(a, p, ctx, (x) => netInPairClass(ctx.doc, n, x)); },
  withinroom: roomTest('within'), inroom: roomTest('within'), touchesroom: roomTest('touches'),
  inregion: (a, p, ctx) => regionTest(a, p, ctx, false), inregionabsolute: (a, p, ctx) => regionTest(a, p, ctx, true),
  // xSignals, from-tos, unions and structures: not evaluated (the DRC holds back what they might cover)
  inxsignal: unknown, inxsignalclass: unknown, infromto: unknown, infromtoclass: unknown, inunion: unknown, instructureclass: unknown, inlayerclass: unknown,
  /* object kinds */
  ispad: kindIs('pad'), isvia: kindIs('via'), istrack: kindIs('track'), isarc: kindIs('arc'), isfill: kindIs('fill'), isregion: kindIs('region'), istext: kindIs('text'),
  ispolygon: (_a, p) => inPoly(p), ispoly: (_a, p) => inPoly(p), inpoly: (_a, p) => inPoly(p),
  isnamedpolygon: (a, p, ctx) => FNS.innamedpolygon!(a, p, ctx),
  iscomponent: (_a, _p, ctx) => !!ctx.asComponent, isdimension: () => false, iscoordinate: () => false, isroom: () => false,
  issmtpad: (_a, p) => p.kind === 'pad' && p.hole === 0, issmdpad: (_a, p) => p.kind === 'pad' && p.hole === 0,
  isthrupad: (_a, p) => p.kind === 'pad' && p.hole > 0, isthpad: (_a, p) => p.kind === 'pad' && p.hole > 0, isthruholepad: (_a, p) => p.kind === 'pad' && p.hole > 0,
  isplated: (_a, p) => (p.kind === 'pad' ? p.hole > 0 && p.plated : p.kind === 'via'),
  iskeepout: (_a, p) => 'keepout' in p && !!p.keepout,
  isboardcutout: (_a, p) => p.kind === 'region' && !!p.boardCutout,
  iscutout: (_a, p) => p.kind === 'region' && (!!p.boardCutout || p.regionKind === 1),
  ispolygoncutout: (_a, p) => p.kind === 'region' && p.regionKind === 1,
  isdesignator: (_a, p) => p.kind === 'text' && p.isDesignator, iscomment: (_a, p) => p.kind === 'text' && p.isComment,
  isvianotested: unknown, isstitchingvia: unknown, ismicrovia: (_a, p, ctx) => p.kind === 'via' && Math.abs(ctx.doc.board.copperStack.indexOf(p.layerEnd) - ctx.doc.board.copperStack.indexOf(p.layerStart)) === 1,
  /* layers: OnLayer is the object's own layer; ExistsOnLayer takes multi-layer objects on every copper layer they cross */
  onlayer: (a, p, ctx) => { const l = layerOf(p); return l !== undefined && anyOf(a, p, ctx, (x) => layerIs(ctx.doc, l, x)); },
  existsonlayer: (a, p, ctx) => { const l = layerOf(p); return l !== undefined && anyOf(a, p, ctx, (x) => layerIs(ctx.doc, l, x) || (l === L.MULTI && ctx.doc.board.copperStack.concat([L.TOP, L.BOTTOM]).some((c) => layerIs(ctx.doc, c, x) && spans(ctx.doc, p, c)))); },
  ontoplayer: layerFn((l) => l === L.TOP), ontop: layerFn((l) => l === L.TOP),
  onbottomlayer: layerFn((l) => l === L.BOTTOM), onbottom: layerFn((l) => l === L.BOTTOM),
  onmid: layerFn((l) => l > L.TOP && l < L.BOTTOM), onmidlayer: layerFn((l) => l > L.TOP && l < L.BOTTOM),
  onoutside: layerFn((l) => l === L.TOP || l === L.BOTTOM),
  onsignal: layerFn((l) => (l >= L.TOP && l <= L.BOTTOM) || l === L.MULTI), onsignallayer: layerFn((l) => (l >= L.TOP && l <= L.BOTTOM) || l === L.MULTI),
  onplane: layerFn(isPlaneLayer), oncopper: layerFn((l) => isCopperLayer(l) || l === L.MULTI),
  onmultilayer: layerFn((l) => l === L.MULTI), onmulti: layerFn((l) => l === L.MULTI),
  onsilkscreen: layerFn((l) => l === L.TOP_OVERLAY || l === L.BOTTOM_OVERLAY), onsolder: layerFn((l) => l === L.TOP_SOLDER || l === L.BOTTOM_SOLDER), onsoldermask: layerFn((l) => l === L.TOP_SOLDER || l === L.BOTTOM_SOLDER),
  onpaste: layerFn((l) => l === L.TOP_PASTE || l === L.BOTTOM_PASTE), onpastemask: layerFn((l) => l === L.TOP_PASTE || l === L.BOTTOM_PASTE),
  onkeepout: layerFn((l) => l === L.KEEPOUT), onmechanical: layerFn((l) => l >= L.MECH1 && l <= L.MECH16),
  /* properties */
  net: (_a, p, ctx) => netName(p, ctx), netname: (_a, p, ctx) => netName(p, ctx),
  objectkind: (_a, p) => ({ pad: 'Pad', via: 'Via', track: 'Track', arc: 'Arc', fill: 'Fill', region: 'Region', text: 'Text', body: 'ComponentBody' } as Record<string, string>)[p.kind] ?? p.kind,
  layer: (_a, p, ctx) => { const l = layerOf(p); return l === undefined ? '' : lname(ctx.doc, l); },
  name: (_a, p) => (p.kind === 'pad' ? p.name : ''),
  designator: (_a, p, ctx) => (p.kind === 'pad' ? p.name : compOf(p, ctx)?.designator ?? ''),
  componentdesignator: (_a, p, ctx) => compOf(p, ctx)?.designator ?? '',
  footprint: (_a, p, ctx) => compOf(p, ctx)?.pattern ?? '', pattern: (_a, p, ctx) => compOf(p, ctx)?.pattern ?? '',
  holediameter: (_a, p) => len(p.kind === 'pad' || p.kind === 'via' ? p.hole : 0), holesize: (_a, p) => len(p.kind === 'pad' || p.kind === 'via' ? p.hole : 0),
  padxsize: (_a, p) => len(p.kind === 'pad' ? p.top.w : 0), padysize: (_a, p) => len(p.kind === 'pad' ? p.top.h : 0),
  viadiameter: (_a, p) => len(p.kind === 'via' ? p.diameter : 0), diameter: (_a, p) => len(p.kind === 'via' ? p.diameter : 0),
  width: (_a, p) => len(p.kind === 'track' || p.kind === 'arc' ? p.width : 0), trackwidth: (_a, p) => len(p.kind === 'track' || p.kind === 'arc' ? p.width : 0),
  aspectratio: (_a, p) => (p.kind === 'via' && p.hole > 0 ? p.diameter / p.hole : 0),
  asmils: (a, p, ctx) => { const v = a[0] ? evalNode(a[0], p, ctx) : null; return v === null ? UNKNOWN : typeof v === 'object' ? v.len / UNITS_PER_MIL : Number(v); },
  asmm: (a, p, ctx) => { const v = a[0] ? evalNode(a[0], p, ctx) : null; return v === null ? UNKNOWN : typeof v === 'object' ? v.len / UNITS_PER_MM : Number(v); },
  // Package classes (fan-out rules): not evaluated
  isbga: unknown, islcc: unknown, issoic: unknown, isqfp: unknown, issmallsmt: unknown, isedgeconnector: unknown, compincount: unknown, comppincount: unknown,
};

function regionTest(a: Node[], p: PcbPrim, ctx: QueryContext, absolute: boolean): Val {
  const v = a.map((n) => evalNode(n, p, ctx));
  if (v.length < 4 || v.some((x) => x === null)) return UNKNOWN;
  const coord = (x: Val) => (typeof x === 'object' && x ? x.len : Number(x) * UNITS_PER_MIL);
  const o = absolute ? { x: 0, y: 0 } : ctx.doc.board.origin;
  const [x1, y1, x2, y2] = v.map(coord) as [number, number, number, number];
  const b = boxOfPrim(p);
  return !!b && b.minX >= Math.min(x1, x2) + o.x && b.maxX <= Math.max(x1, x2) + o.x && b.minY >= Math.min(y1, y2) + o.y && b.maxY <= Math.max(y1, y2) + o.y;
}

function compare(op: string, a: Val, b: Val): boolean | null {
  if (a === null || b === null) return UNKNOWN;
  if (op === 'like') return like(String(typeof b === 'object' ? b.len : b), String(typeof a === 'object' ? a.len : a));
  // Lengths against plain numbers: the number in mils
  const num = (x: Val, other: Val): number | null => (typeof x === 'object' && x ? x.len : typeof x === 'number' ? (typeof other === 'object' && other ? x * UNITS_PER_MIL : x) : typeof x === 'boolean' ? Number(x) : null);
  const na = num(a, b), nb = num(b, a);
  let c: number;
  if (na !== null && nb !== null) c = Math.abs(na - nb) < 1e-6 * Math.max(1, Math.abs(na), Math.abs(nb)) ? 0 : na - nb;
  else {
    const sa = String(typeof a === 'object' ? a.len : a).toLowerCase(), sb = String(typeof b === 'object' ? b.len : b).toLowerCase();
    // true / false against a string ('True')
    c = sa === sb ? 0 : sa < sb ? -1 : 1;
  }
  switch (op) { case '=': return c === 0; case '<>': return c !== 0; case '<': return c < 0; case '>': return c > 0; case '<=': return c <= 0; case '>=': return c >= 0; }
  return UNKNOWN;
}

function evalNode(n: Node, p: PcbPrim, ctx: QueryContext): Val {
  switch (n.t) {
    case 'const': return n.v;
    case 'str': return n.v;
    case 'num': return n.unit ? len(n.v * (n.unit === 'mm' ? UNITS_PER_MM : n.unit === 'in' ? UNITS_PER_MIL * 1000 : UNITS_PER_MIL)) : n.v;
    case 'and': { const a = truth(evalNode(n.a, p, ctx)); if (a === false) return false; const b = truth(evalNode(n.b, p, ctx)); return b === false ? false : a === null || b === null ? UNKNOWN : true; }
    case 'or': { const a = truth(evalNode(n.a, p, ctx)); if (a === true) return true; const b = truth(evalNode(n.b, p, ctx)); return b === true ? true : a === null || b === null ? UNKNOWN : false; }
    case 'not': { const a = truth(evalNode(n.a, p, ctx)); return a === null ? UNKNOWN : !a; }
    case 'cmp': return compare(n.op, evalNode(n.a, p, ctx), evalNode(n.b, p, ctx));
    case 'call': {
      const f = FNS[n.name.toLowerCase()];
      return f ? f(n.args, p, ctx) : UNKNOWN;
    }
  }
}

/** The functions in a scope Konium can't evaluate (empty when it evaluates all of it). */
export function unsupportedIn(src: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node): void => {
    switch (n.t) {
      case 'and': case 'or': case 'cmp': walk(n.a); walk(n.b); return;
      case 'not': walk(n.a); return;
      case 'call': { const f = FNS[n.name.toLowerCase()]; if (!f || f === unknown) out.add(n.name); n.args.forEach(walk); return; }
      default:
    }
  };
  walk(parseQuery(src));
  return [...out];
}

/** A scope as a three-valued test: true, false, or null where it rests on what Konium can't evaluate. */
export function scopeTest(src: string, ctx: QueryContext): (p: PcbPrim) => boolean | null {
  const ast = parseQuery(src);
  if (ast.t === 'call' && ast.name.toLowerCase() === 'all') return () => true;
  return (p) => truth(evalNode(ast, p, ctx));
}

/** A scope as a plain test; throws UnsupportedQuery when it uses what Konium can't evaluate. */
export function scopePredicate(src: string, ctx: QueryContext): (p: PcbPrim) => boolean {
  const bad = unsupportedIn(src);
  if (bad.length) throw new UnsupportedQuery(`query function ${bad[0]} is not supported yet`);
  const t = scopeTest(src, ctx);
  return (p) => t(p) === true;
}

/** Evaluate a scope on one object (true, false or null). */
export function evalQuery(src: string, p: PcbPrim, ctx: QueryContext): boolean | null {
  return scopeTest(src, ctx)(p);
}
