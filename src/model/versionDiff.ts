/**
 * Two versions of a schematic or a board compared object by object (version control's History ›
 * Compare with Current, the Storage Manager's Compare): what was added, what was removed and what
 * changed, each with the keys its editor draws it under (in the older version and in the newer),
 * so the compare view can colour it in both and go to it.
 *
 * Objects are matched by what they are, not by where they sit in the file: identical objects
 * (whatever their record numbers) are unchanged; parts by designator; what is left by kind and
 * nearness (a track widened, a label moved a little), else added or removed. A board's poured
 * copper is left out (it follows its polygon, compared as a definition).
 */
import type { Vec2 } from '../core/geom';
import type { Coord } from '../core/units';
import { layerName } from './layers';
import { NO_NET, type PcbDocument, type PcbPrim } from './pcb';
import type { SchDocument, SchObject } from './sch';

export type DiffKind = 'added' | 'removed' | 'changed';
export interface VersionDiff {
  kind: DiffKind;
  /** What it is, in words (U1, Via, Net label VCC …). */
  what: string;
  /** What happened to it (moved 50mil, 10mil → 12mil wide …); empty when added or removed. */
  detail: string;
  /** Its editor keys in the older version, and in the newer. */
  old: string[];
  cur: string[];
}

/** Keys as the editors give them (passed in: the model doesn't know the editors). */
export interface PcbKeys { prim(p: PcbPrim): string; poly(index: number): string }

/** A value as text with its object keys in order (the same object read two ways compares equal). */
export function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `[${Array.from(v as ArrayLike<unknown>).map(stable).join(',')}]`;
  if (v instanceof Map) return stable(Object.fromEntries([...v].map(([k, x]) => [String(k), x])));
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
}

/** What is left of each list once equal ones (by signature) are paired off. */
function pairUp<T>(a: T[], b: T[], sig: (x: T) => string): { left: T[]; right: T[] } {
  const count = (l: T[]) => { const m = new Map<string, number>(); for (const x of l) { const s = sig(x); m.set(s, (m.get(s) ?? 0) + 1); } return m; };
  const ca = count(a), cb = count(b);
  const rest = (l: T[], other: Map<string, number>) => {
    const seen = new Map<string, number>();
    return l.filter((x) => { const s = sig(x), n = (seen.get(s) ?? 0) + 1; seen.set(s, n); return n > Math.min(other.get(s) ?? 0, (l === a ? ca : cb).get(s) ?? 0); });
  };
  return { left: rest(a, cb), right: rest(b, ca) };
}

/** Leftovers paired by kind and nearness (within `near`); the rest added or removed. */
function nearest<T>(old: T[], cur: T[], kind: (x: T) => string, at: (x: T) => Vec2 | null, near: Coord): { pairs: [T, T][]; gone: T[]; came: T[] } {
  const pairs: [T, T][] = [], left = [...cur];
  const gone: T[] = [];
  for (const o of old) {
    const p = at(o);
    let best = -1, bd = Infinity;
    left.forEach((c, i) => {
      if (kind(c) !== kind(o)) return;
      const q = at(c);
      const d = p && q ? Math.hypot(p.x - q.x, p.y - q.y) : Infinity;
      if (d <= near && d < bd) { bd = d; best = i; }
    });
    if (best >= 0) pairs.push([o, left.splice(best, 1)[0]!]); else gone.push(o);
  }
  return { pairs, gone, came: left };
}

const moved = (a: Vec2, b: Vec2, fmt: (c: Coord) => string) => (a.x !== b.x || a.y !== b.y ? `moved ${fmt(Math.hypot(b.x - a.x, b.y - a.y))}` : '');
const was = (label: string, a: unknown, b: unknown) => (a !== b ? `${label} ${String(a ?? '')} → ${String(b ?? '')}`.replace(/  +/g, ' ') : '');
const join = (xs: string[]) => xs.filter(Boolean).join(', ');

/* ─── Boards ──────────────────────────────────────────────────────────────────────────── */

const PRIM_WORDS: Record<PcbPrim['kind'], string> = { track: 'Track', arc: 'Arc', via: 'Via', pad: 'Pad', fill: 'Fill', text: 'Text', region: 'Region', body: '3D body' };

function primAt(p: PcbPrim): Vec2 | null {
  if (p.kind === 'track' || p.kind === 'fill') return { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 };
  if (p.kind === 'arc') return p.c;
  if (p.kind === 'via' || p.kind === 'pad' || p.kind === 'text') return p.at;
  const o = p.outline;
  if (!o.length) return null;
  return { x: o.reduce((s, v) => s + v.x, 0) / o.length, y: o.reduce((s, v) => s + v.y, 0) / o.length };
}

export function pcbDiff(a: PcbDocument, b: PcbDocument, keys: PcbKeys, fmt: (c: Coord) => string): VersionDiff[] {
  const out: VersionDiff[] = [];
  const netOf = (d: PcbDocument, n: number) => (n === NO_NET ? '' : d.nets[n]?.name ?? `#${n}`);
  const layerOf = (d: PcbDocument, l: number) => d.board.layerNames.get(l) ?? layerName(l);
  const compOf = (d: PcbDocument, c: number) => (c === NO_NET ? null : d.components[c] ?? null);
  /** A primitive as it is, apart from where it sits in the file: its net, part and layer by name. */
  const sig = (d: PcbDocument, p: PcbPrim) => {
    const { src: _s, ...rest } = p as PcbPrim & { net?: number; component?: number; polygon?: number };
    return stable({ ...rest, net: 'net' in p ? netOf(d, p.net) : undefined, component: 'component' in p ? compOf(d, p.component)?.designator ?? '' : undefined, polygon: undefined });
  };
  const words = (d: PcbDocument, p: PcbPrim) => {
    const net = 'net' in p ? netOf(d, p.net) : '';
    const where = p.kind === 'via' ? `${layerOf(d, p.layerStart)} to ${layerOf(d, p.layerEnd)}` : 'layer' in p ? layerOf(d, p.layer) : '';
    const text = p.kind === 'text' ? ` "${p.text.slice(0, 24)}"` : p.kind === 'pad' ? ` ${p.name}` : '';
    // Where it is, from the board's origin (as the status bar gives it)
    const o = d.board.origin, xy = (v: Vec2) => `(${fmt(v.x - o.x)}, ${fmt(v.y - o.y)})`;
    const at = p.kind === 'track' ? ` ${xy(p.a)} to ${xy(p.b)}` : p.kind === 'arc' ? ` round ${xy(p.c)}` : p.kind === 'fill' ? ` ${xy(p.a)} to ${xy(p.b)}` : 'at' in p ? ` ${xy(p.at)}` : '';
    return `${PRIM_WORDS[p.kind]}${text}${at}${where ? ` on ${where}` : ''}${net ? `, ${net}` : ''}`;
  };
  const primChange = (pa: PcbPrim, pb: PcbPrim): string => {
    const d: string[] = [];
    const at0 = primAt(pa), at1 = primAt(pb);
    if (at0 && at1) d.push(moved(at0, at1, fmt));
    if ('width' in pa && 'width' in pb && pa.width !== pb.width) d.push(`${fmt(pa.width)} → ${fmt(pb.width)} wide`);
    if (pa.kind === 'via' && pb.kind === 'via' && (pa.diameter !== pb.diameter || pa.hole !== pb.hole)) d.push(`${fmt(pa.diameter)}/${fmt(pa.hole)} → ${fmt(pb.diameter)}/${fmt(pb.hole)}`);
    if ('layer' in pa && 'layer' in pb && pa.layer !== pb.layer) d.push(was('layer', layerOf(a, pa.layer), layerOf(b, pb.layer)));
    if ('net' in pa && 'net' in pb) d.push(was('net', netOf(a, pa.net) || 'none', netOf(b, pb.net) || 'none'));
    if (pa.kind === 'text' && pb.kind === 'text') d.push(pa.text !== pb.text ? `"${pa.text.slice(0, 24)}" → "${pb.text.slice(0, 24)}"` : '');
    return join(d) || 'changed';
  };

  // Parts, by designator
  const parts = (d: PcbDocument) => {
    const m = new Map<string, { c: PcbDocument['components'][number]; prims: PcbPrim[] }[]>();
    const own = new Map<number, PcbPrim[]>();
    for (const p of d.prims) if ('component' in p && compOf(d, p.component)) (own.get(p.component) ?? own.set(p.component, []).get(p.component)!).push(p);
    for (const c of d.components) { const l = m.get(c.designator) ?? []; l.push({ c, prims: own.get(c.index) ?? [] }); m.set(c.designator, l); }
    return m;
  };
  const pa = parts(a), pb = parts(b);
  const commentOf = (prims: PcbPrim[]) => (prims.find((p) => p.kind === 'text' && p.isComment) as { text?: string } | undefined)?.text;
  const partSig = (d: PcbDocument, x: { c: PcbDocument['components'][number]; prims: PcbPrim[] }) =>
    stable({ pattern: x.c.pattern, at: x.c.at, rot: x.c.rotation, layer: x.c.layer, prims: x.prims.map((p) => sig(d, p)).sort() });
  for (const [des, list] of pa) {
    const other = pb.get(des) ?? [];
    list.forEach((x, i) => {
      const y = other[i];
      const oldKeys = x.prims.map(keys.prim);
      if (!y) { out.push({ kind: 'removed', what: des || x.c.pattern, detail: '', old: oldKeys, cur: [] }); return; }
      if (partSig(a, x) === partSig(b, y)) return;
      const d = [moved(x.c.at, y.c.at, fmt), x.c.rotation !== y.c.rotation ? `rotated ${x.c.rotation}° → ${y.c.rotation}°` : '',
        x.c.layer !== y.c.layer ? `flipped to ${layerOf(b, y.c.layer)}` : '', was('footprint', x.c.pattern, y.c.pattern), was('comment', commentOf(x.prims), commentOf(y.prims))];
      out.push({ kind: 'changed', what: des, detail: join(d) || 'its pads or text changed', old: oldKeys, cur: y.prims.map(keys.prim) });
    });
    for (const y of other.slice(list.length)) out.push({ kind: 'added', what: des || y.c.pattern, detail: '', old: [], cur: y.prims.map(keys.prim) });
  }
  for (const [des, list] of pb) if (!pa.has(des)) for (const y of list) out.push({ kind: 'added', what: des || y.c.pattern, detail: '', old: [], cur: y.prims.map(keys.prim) });

  // Free primitives (not in a part, not poured copper)
  const free = (d: PcbDocument) => d.prims.filter((p) => !('component' in p && compOf(d, p.component)) && !('polygon' in p && p.polygon !== NO_NET));
  const fa = free(a), fb = free(b);
  const sa = new Map(fa.map((p) => [p, sig(a, p)])), sb = new Map(fb.map((p) => [p, sig(b, p)]));
  const left = pairUp(fa.map((p) => ({ p, d: a })), fb.map((p) => ({ p, d: b })), (x) => (x.d === a ? sa : sb).get(x.p)!);
  const near = nearest(left.left.map((x) => x.p), left.right.map((x) => x.p), (p) => p.kind, primAt, NEAR_PCB);
  for (const [x, y] of near.pairs) out.push({ kind: 'changed', what: words(b, y), detail: primChange(x, y), old: [keys.prim(x)], cur: [keys.prim(y)] });
  for (const x of near.gone) out.push({ kind: 'removed', what: words(a, x), detail: '', old: [keys.prim(x)], cur: [] });
  for (const y of near.came) out.push({ kind: 'added', what: words(b, y), detail: '', old: [], cur: [keys.prim(y)] });

  // Polygons, by name (else in order)
  const polySig = (d: PcbDocument, p: PcbDocument['polygons'][number]) => stable({ layer: p.layer, net: netOf(d, p.net), v: p.vertices, hatch: p.hatch, type: p.type });
  const byName = (d: PcbDocument) => new Map(d.polygons.map((p, i) => [p.name || `#${i}`, p]));
  const qa = byName(a), qb = byName(b);
  for (const [n, p] of qa) {
    const q = qb.get(n);
    const what = `Polygon ${p.name || ''} on ${layerOf(a, p.layer)}`.replace(/ +/g, ' ');
    if (!q) out.push({ kind: 'removed', what, detail: '', old: [keys.poly(p.index)], cur: [] });
    else if (polySig(a, p) !== polySig(b, q)) out.push({ kind: 'changed', what, detail: join([was('net', netOf(a, p.net), netOf(b, q.net)), was('layer', layerOf(a, p.layer), layerOf(b, q.layer)), stable(p.vertices) !== stable(q.vertices) ? 'outline changed' : '', was('hatch', p.hatch, q.hatch)]) || 'changed', old: [keys.poly(p.index)], cur: [keys.poly(q.index)] });
  }
  for (const [n, q] of qb) if (!qa.has(n)) out.push({ kind: 'added', what: `Polygon ${q.name || ''} on ${layerOf(b, q.layer)}`.replace(/ +/g, ' '), detail: '', old: [], cur: [keys.poly(q.index)] });

  if (stable(a.board.vertices) !== stable(b.board.vertices)) out.push({ kind: 'changed', what: 'Board shape', detail: 'outline changed', old: [], cur: [] });
  // Design rules by name, as their settings (their unique ids aside)
  const rules = (d: PcbDocument) => new Map(d.rules.map((r) => {
    const o = r.bag.toObject();
    const name = o.NAME ?? o.Name ?? '';
    for (const k of Object.keys(o)) if (/^uniqueid$/i.test(k)) delete o[k];
    return [name, stable(o)] as const;
  }));
  const ra = rules(a), rb = rules(b);
  const ruleNames = [...new Set([...ra.keys(), ...rb.keys()])].filter((n) => ra.get(n) !== rb.get(n));
  if (ruleNames.length) {
    const say = (l: string[]) => `${l.slice(0, 4).join(', ')}${l.length > 4 ? ` and ${l.length - 4} more` : ''}`;
    const came = ruleNames.filter((n) => !ra.has(n)), gone = ruleNames.filter((n) => !rb.has(n)), chg = ruleNames.filter((n) => ra.has(n) && rb.has(n));
    out.push({ kind: 'changed', what: 'Design rules', detail: join([chg.length ? `changed: ${say(chg)}` : '', came.length ? `added: ${say(came)}` : '', gone.length ? `removed: ${say(gone)}` : '']), old: [], cur: [] });
  }
  return order(out);
}
/** How near a changed object stays to count as the same one: 100 mil on a board, 200 mil on a sheet. */
const NEAR_PCB: Coord = 1_000_000, NEAR_SCH: Coord = 2_000_000;

/* ─── Schematics ──────────────────────────────────────────────────────────────────────── */

const SCH_WORDS: Partial<Record<SchObject['kind'], string>> = {
  wire: 'Wire', bus: 'Bus', polyline: 'Line', bezier: 'Bezier', polygon: 'Polygon', rect: 'Rectangle', ellipse: 'Ellipse', arc: 'Arc', text: 'Text', pin: 'Pin', junction: 'Junction',
  splice: 'Splice', power: 'Power port', port: 'Port', noerc: 'No ERC', busentry: 'Bus entry', sheetsymbol: 'Sheet symbol', textframe: 'Text frame', image: 'Picture', ieee: 'IEEE symbol',
  directive: 'Directive', piechart: 'Pie chart', compilemask: 'Compile mask', blanket: 'Blanket', harness: 'Harness connector', signalharness: 'Signal harness', component: 'Part',
};

function schAt(o: SchObject): Vec2 | null {
  if ('at' in o) return o.at;
  if ('pts' in o) return o.pts[0] ?? null;
  if ('a' in o) return o.a;
  if ('c' in o) return o.c;
  return null;
}

export function schDiff(a: SchDocument, b: SchDocument, key: (index: number) => string, fmt: (c: Coord) => string): VersionDiff[] {
  const out: VersionDiff[] = [];
  /** Each top object with everything under it (a part's pins, graphics and texts; a sheet symbol's entries). */
  const units = (d: SchDocument) => {
    const top = (o: SchObject): SchObject => { let x = o, n = 0; while (x.owner >= 0 && d.objects[x.owner] && n++ < 20) x = d.objects[x.owner]!; return x; };
    const m = new Map<number, SchObject[]>();
    for (const o of d.objects) { if (o.kind === 'meta') continue; const t = top(o); (m.get(t.index) ?? m.set(t.index, []).get(t.index)!).push(o); }
    return [...m].map(([i, all]) => ({ o: d.objects[i]!, all }));
  };
  const own = (o: SchObject) => { const { index: _i, owner: _o, ...rest } = o; return stable(rest); };
  const sig = (u: { o: SchObject; all: SchObject[] }) => `${own(u.o)}|${u.all.filter((x) => x !== u.o).map(own).sort().join('|')}`;
  const ua = units(a).filter((u) => u.o.kind !== 'meta'), ub = units(b).filter((u) => u.o.kind !== 'meta');
  const keysOf = (u: { all: SchObject[] }) => u.all.map((x) => key(x.index));
  const texts = (u: { o: SchObject; all: SchObject[] }, role: string) => u.all.filter((x) => x.kind === 'text' && x.role === role) as (SchObject & { kind: 'text' })[];
  const desOf = (u: { o: SchObject; all: SchObject[] }) => (u.o.kind === 'component' ? texts(u, 'designator')[0]?.text || u.o.designator || '' : '');
  const xy = (v: Vec2) => `(${fmt(v.x)}, ${fmt(v.y)})`;
  const name = (u: { o: SchObject; all: SchObject[] }) => `${title(u)}${where(u.o)}`;
  /** Where it is on the sheet: a line from its first point to its last, else its place. */
  const where = (o: SchObject) => {
    if (o.kind === 'component') return '';
    if ('pts' in o && o.pts.length > 1) return ` ${xy(o.pts[0]!)} to ${xy(o.pts.at(-1)!)}`;
    const p = schAt(o);
    return p ? ` at ${xy(p)}` : '';
  };
  const title = (u: { o: SchObject; all: SchObject[] }) => {
    const o = u.o, w = SCH_WORDS[o.kind] ?? o.kind;
    if (o.kind === 'component') return desOf(u) || o.libRef;
    if (o.kind === 'text') return `${o.role === 'netlabel' ? 'Net label' : w} ${o.text.slice(0, 24)}`;
    if (o.kind === 'power' || o.kind === 'port' || o.kind === 'splice' || o.kind === 'directive') return `${w} ${'text' in o ? o.text : o.name}`;
    if (o.kind === 'sheetsymbol') return `${w} ${texts(u, 'sheetname')[0]?.text ?? ''}`.trim();
    return w;
  };
  // Parts by designator; the rest by what they are
  const parts = (l: typeof ua) => { const m = new Map<string, typeof ua>(); for (const u of l) if (u.o.kind === 'component') { const d = desOf(u); m.set(d, [...(m.get(d) ?? []), u]); } return m; };
  const pa = parts(ua), pb = parts(ub);
  /** A part's shown parameter values that changed: one for one as "was → is", else how many. */
  const paramChange = (x: (typeof ua)[number], y: (typeof ua)[number]) => {
    const vx = texts(x, 'parameter').map((t) => t.text), vy = texts(y, 'parameter').map((t) => t.text);
    const gone = vx.filter((v) => !vy.includes(v)), came = vy.filter((v) => !vx.includes(v));
    if (!gone.length && !came.length) return '';
    return gone.length === 1 && came.length === 1 ? `${gone[0]} \u2192 ${came[0]}` : 'parameters changed';
  };
  for (const [des, list] of pa) {
    const other = pb.get(des) ?? [];
    list.forEach((x, i) => {
      const y = other[i];
      if (!y) { out.push({ kind: 'removed', what: name(x), detail: '', old: keysOf(x), cur: [] }); return; }
      if (sig(x) === sig(y)) return;
      const ox = x.o as SchObject & { kind: 'component' }, oy = y.o as SchObject & { kind: 'component' };
      const d = [moved(ox.at, oy.at, fmt), ox.orient !== oy.orient ? `rotated ${ox.orient * 90}° → ${oy.orient * 90}°` : '', ox.mirrored !== oy.mirrored ? (oy.mirrored ? 'mirrored' : 'not mirrored') : '',
        was('symbol', ox.libRef, oy.libRef), paramChange(x, y)];
      out.push({ kind: 'changed', what: des || ox.libRef, detail: join(d) || 'its pins or graphics changed', old: keysOf(x), cur: keysOf(y) });
    });
    for (const y of other.slice(list.length)) out.push({ kind: 'added', what: name(y), detail: '', old: [], cur: keysOf(y) });
  }
  for (const [, list] of pb) for (const y of list) if (!pa.has(desOf(y))) out.push({ kind: 'added', what: name(y), detail: '', old: [], cur: keysOf(y) });

  const rest = (l: typeof ua) => l.filter((u) => u.o.kind !== 'component');
  const left = pairUp([...rest(ua).map((u) => ({ u, s: sig(u) }))], [...rest(ub).map((u) => ({ u, s: sig(u) }))], (x) => x.s);
  const near = nearest(left.left.map((x) => x.u), left.right.map((x) => x.u), (u) => `${u.o.kind}${u.o.kind === 'text' ? u.o.role : ''}`, (u) => schAt(u.o), NEAR_SCH);
  for (const [x, y] of near.pairs) {
    const ox = x.o, oy = y.o;
    const d: string[] = [];
    const p0 = schAt(ox), p1 = schAt(oy);
    if (p0 && p1) d.push(moved(p0, p1, fmt));
    if ('pts' in ox && 'pts' in oy && stable(ox.pts) !== stable(oy.pts) && !d[0]) d.push('reshaped');
    if ('text' in ox && 'text' in oy) d.push(was('text', ox.text, oy.text));
    if ('name' in ox && 'name' in oy) d.push(was('name', ox.name, oy.name));
    out.push({ kind: 'changed', what: name(y), detail: join(d) || 'changed', old: keysOf(x), cur: keysOf(y) });
  }
  for (const x of near.gone) out.push({ kind: 'removed', what: name(x), detail: '', old: keysOf(x), cur: [] });
  for (const y of near.came) out.push({ kind: 'added', what: name(y), detail: '', old: [], cur: keysOf(y) });
  return order(out);
}

/** Changed first, then added, then removed; each by name (designators in number order). */
function order(l: VersionDiff[]): VersionDiff[] {
  const rank: Record<DiffKind, number> = { changed: 0, added: 1, removed: 2 };
  return l.sort((x, y) => rank[x.kind] - rank[y.kind] || x.what.localeCompare(y.what, undefined, { numeric: true }));
}
