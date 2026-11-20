/**
 * A routing plan carried out (26.193). The plan (the Smart Router's: src/ai/jobs.ts, ROUTING) says
 * how a placed board's nets are to be routed; here it becomes the board's own classes and rules,
 * and the autorouter routes by it:
 *  - Each class of the plan is a net class; its width a Width rule and its clearance a Clearance
 *    rule scoped to that class, above the rules the board had (which stay as they are); the via a
 *    Routing Via Style rule; each pair a differential pair with a Differential Pairs Routing rule
 *    of its class's width and its gap (and, where that gap is under the board's clearance, a
 *    Clearance rule for the pair's own two nets); each pour a polygon over the board,
 *    0.3 mm inside its outline [the tool's choice]. Rules the plan made carry its comment: applied
 *    again they are brought up to date, and those of a plan before that the new one has no use
 *    for go, with the classes only they used.
 *  - Routing: each surface-mount pad of a poured net that is on another layer, or of a net a plane
 *    layer carries, gets a via into its pour or plane; the autorouter then takes the connections left, class by class in the plan's order,
 *    each kept to its class's layers and vias, a differential pair as one where it can be
 *    (pairRoute.ts). A route is taken only if it keeps its clearances
 *    as drawn: a track wider than a pad it ends on is necked down there; what still could not get
 *    through at its class's width is tried once more at the narrowest its rule allows, and said;
 *    the pours are poured again round it all, and what that parts is routed. The routes of the
 *    classes that are to be free-flowing are then reshaped (reflow.ts).
 *  - What came of it is measured: the connections left, by class; the vias; the track's length;
 *    what the design rule check finds in the copper, hole and pair rules that it did not find
 *    before the run. As text too, for the model's second round.
 * The model gives no coordinates; every track is the autorouter's, checked by the rules.
 */
import type { Change } from '../core/undo';
import type { Vec2 } from '../core/geom';
import { formatAltiumLength, parseLength } from '../core/units';
import type { RouteClass, RoutePair, RoutePour, RoutingPlan } from '../ai/jobs';
import { PropertyBag } from '../formats/altium/props';
import { cloneRule, kindLabel, newRule, ruleKind, ruleLength, ruleName, rulePriority, type PcbRule } from '../formats/altium/rules';
import { newPolygonProps } from '../formats/altium/polygonProps';
import { layerToName, writeVertices } from '../formats/altium/pcbdoc';
import { L, isCopper, isSignal, layerName, type LayerId } from './layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim } from './pcb';
import { connections, ruleFor, runDrc, scoped, type Connection } from './drc';
import { autoroute, fanout, netRouting, probeTrack, smdPads, type FanoutResult, type RouteJob } from './autoroute';
import { addArcs, addPolygon, addTracks, addVias, removePrims, replaceRules, repour } from './pcbEdit';
import { reflow, trackKey, tracksByKey } from './reflow';
import { classBag, setClasses, withMembers } from './pcbClasses';
import { diffPairBag, diffPairsOf, pairRule, setDiffPairs } from './diffPairs';
import { insetOutline } from './pour';
import { boardFrame, isRectangle, toUnits } from './layoutPlan';

const MM = toUnits(1);
/** The comment of the rules a plan made (Design › Rules shows it): how they are found again. */
export const PLAN_COMMENT = 'Smart Router plan';
const VIA_RULE = 'RoutingVias_SmartRouter';
/** How far inside the board's edge a plan's pour is drawn [the tool's choice]. */
const POUR_INSET = toUnits(0.3);
/** How much under its gap a pair's own clearance is set (0.01 mm). */
const PAIR_SLACK = Math.round(0.01 * MM);
const lower = (s: string) => s.toLowerCase();
const slug = (name: string) => name.trim().replace(/[^\p{L}\p{N}+.-]+/gu, '_').replace(/^_+|_+$/g, '') || 'Class';
export const planRuleName = (kind: 'Width' | 'Clearance', cls: string) => `${kind}_${slug(cls)}`;
const mine = (r: PcbRule) => r.bag.get('COMMENT') === PLAN_COMMENT;
const sameLength = (a: string | undefined, b: string) => Math.abs((parseLength(a) ?? -1e12) - (parseLength(b) ?? 1e12)) < 2;
const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a.map(lower), ...b.map(lower)]).size === a.length;

/** A copper layer by its name as the board has it (or as it is named when the board gives none). */
export function layerByName(doc: PcbDocument, name: string): LayerId | undefined {
  const want = lower(name).replace(/\s+/g, ' ').trim();
  return doc.board.copperStack.filter(isCopper).find((l) => lower(doc.board.layerNames.get(l) ?? layerName(l)) === want || lower(layerName(l)) === want);
}
const netIndex = (doc: PcbDocument, name: string) => doc.nets.findIndex((n) => lower(n.name) === lower(name));

/** The board's rules as they stand for a net of no class, leaving out what a plan put there: what the plan's values are held against. */
export interface BaseRules { width: number; min: number; max: number; gap: number; via: { diameter: number; hole: number } }
export function baseRules(doc: PcbDocument): BaseRules {
  const probe = probeTrack(NO_NET);
  const first = (kind: string, prim: PcbPrim) => scoped(doc, kind, []).find((r) => !mine(r.rule) && r.s1(prim) === true)?.rule;
  const w = first('Width', probe), c = first('Clearance', probe);
  const viaProbe: PcbPrim = { kind: 'via', src: { storage: 'Vias6', index: -1 }, at: { x: 0, y: 0 }, diameter: 0, hole: 0, layerStart: L.TOP, layerEnd: L.BOTTOM, net: NO_NET, locked: false } as PcbPrim;
  const v = first('RoutingVias', viaProbe);
  const len = (r: PcbRule | undefined, key: string, def: string) => (r ? ruleLength(r, key, def) : parseLength(def)!);
  return { width: len(w, 'PREFEREDWIDTH', '10mil'), min: len(w, 'MINLIMIT', '10mil'), max: len(w, 'MAXLIMIT', '10mil'), gap: len(c, 'GAP', '10mil'),
    via: { diameter: len(v, 'WIDTH', '50mil'), hole: len(v, 'HOLEWIDTH', '28mil') } };
}

/* ─── The plan as the board's classes, rules, pairs and pours ────────────────────────── */

interface PlanState {
  rules: PcbRule[]; rulesChanged: boolean;
  bags: PropertyBag[]; classesChanged: boolean;
  pairs: PropertyBag[]; pairsChanged: boolean;
  /** Pours of the plan the board has (their indices), and those to add. */
  pours: number[]; newPours: { net: number; layer: LayerId }[];
  /** What of the plan can't be put on this board, in words. */
  skipped: string[];
}

function planState(doc: PcbDocument, plan: RoutingPlan): PlanState {
  const base = baseRules(doc);
  const skipped: string[] = [];
  const units = (v: number) => Math.round(v * MM);
  // Rules: what the plan wants, by name
  const want = new Map<string, { kind: string; name: string; scope: string; set: Record<string, string>; props?: Record<string, string> }>();
  for (const c of [...plan.classes].sort((a, b) => a.order - b.order)) {
    if (c.width > 0) {
      const w = units(c.width), name = planRuleName('Width', c.name);
      want.set(lower(name), { kind: 'Width', name, scope: `InNetClass('${c.name}')`, set: { MINLIMIT: formatAltiumLength(Math.min(w, base.min)), PREFEREDWIDTH: formatAltiumLength(w), MAXLIMIT: formatAltiumLength(Math.max(w, base.max)) } });
    }
    if (c.clearance > 0) {
      const name = planRuleName('Clearance', c.name);
      want.set(lower(name), { kind: 'Clearance', name, scope: `InNetClass('${c.name}')`, set: { GAP: formatAltiumLength(units(c.clearance)) } });
    }
  }
  if (plan.via) {
    const d = formatAltiumLength(units(plan.via.diameter)), h = formatAltiumLength(units(plan.via.hole));
    want.set(lower(VIA_RULE), { kind: 'RoutingVias', name: VIA_RULE, scope: 'All', set: { MINWIDTH: d, WIDTH: d, MAXWIDTH: d, MINHOLEWIDTH: h, HOLEWIDTH: h, MAXHOLEWIDTH: h } });
  }
  // Pairs: those the board doesn't have yet (by their nets, either way round), each under the name the board knows it by
  const have = diffPairsOf(doc);
  const pairs = [...(doc.diffPairs ?? [])];
  let pairsChanged = false;
  const names = new Set(have.map((d) => lower(d.name)));
  const signal = doc.board.copperStack.filter(isSignal);
  for (const p of plan.pairs) {
    const there = have.find((d) => (lower(d.pos) === lower(p.p) && lower(d.neg) === lower(p.n)) || (lower(d.pos) === lower(p.n) && lower(d.neg) === lower(p.p)));
    let name = there?.name ?? p.name;
    if (!there) {
      for (let k = 2; names.has(lower(name)); k++) name = `${p.name}${k}`;
      names.add(lower(name));
      pairs.push(diffPairBag(name, p.p, p.n)); pairsChanged = true;
    }
    // Its Differential Pairs Routing rule: the width of its nets' class (the board's where the class gives none), the gap asked for (10 mil where none is)
    const cls = plan.classes.find((c) => c.nets.some((n) => lower(n) === lower(p.p)));
    const w = formatAltiumLength(cls?.width ? units(cls.width) : base.width), g = formatAltiumLength(p.gap > 0 ? units(p.gap) : 100_000);
    const set: Record<string, string> = { MINLIMIT: g, MAXLIMIT: g, MOSTFREQGAP: g };
    for (const l of signal) {
      const n = l === L.TOP ? 'TOPLAYER' : l === L.BOTTOM ? 'BOTTOMLAYER' : `MIDLAYER${layerToName(l).replace(/^MID/, '')}`;
      Object.assign(set, { [`${n}_MINWIDTH`]: w, [`${n}_MAXWIDTH`]: w, [`${n}_PREFWIDTH`]: w, [`${n}_MINGAP`]: g, [`${n}_MAXGAP`]: g, [`${n}_PREFGAP`]: g });
    }
    const rule = `DiffPairsRouting_${slug(name)}`;
    want.set(lower(rule), { kind: 'DiffPairsRouting', name: rule, scope: `InDifferentialPair('${name}')`, set, props: { NETSCOPE: 'AnyNet', MAXUNCOUPLEDLENGTH: '500mil' } });
    // A gap that is not well over the board's clearance: the pair's own two nets may come as near each other as their gap, less
    // a hundredth of a millimetre so that tracks laid at exactly the gap keep the rule (and nothing else may come so near)
    const gapUnits = p.gap > 0 ? units(p.gap) : 100_000;
    if (gapUnits < base.gap + PAIR_SLACK + 1) {
      const within = `ClearanceInPair_${slug(name)}`;
      want.set(lower(within), { kind: 'Clearance', name: within, scope: `InDifferentialPair('${name}')`, set: { GAP: formatAltiumLength(gapUnits - PAIR_SLACK) }, props: { SCOPE2EXPRESSION: `InDifferentialPair('${name}')` } });
    }
  }
  let rulesChanged = false;
  // Those of a plan before that this one has no use for go
  const dropped: PcbRule[] = [];
  let rules = doc.rules.filter((r) => { if (mine(r) && !want.has(lower(ruleName(r)))) { dropped.push(r); return false; } return true; });
  if (dropped.length) rulesChanged = true;
  const fresh: PcbRule[] = [];
  for (const [key, w] of want) {
    const i = rules.findIndex((r) => ruleKind(r) === w.kind && lower(ruleName(r)) === key);
    if (i < 0) {
      const r = newRule(w.kind, w.name, 1);
      r.bag.set('SCOPE1EXPRESSION', w.scope); r.bag.set('COMMENT', PLAN_COMMENT);
      for (const [k, v] of Object.entries({ ...w.props, ...w.set })) r.bag.set(k, v);
      fresh.push(r);
      continue;
    }
    const r = rules[i]!;
    if (mine(r) && (r.bag.get('SCOPE1EXPRESSION') ?? 'All') === w.scope && Object.entries(w.set).every(([k, v]) => sameLength(r.bag.get(k), v))) continue;
    const n = cloneRule(r);
    n.bag.set('SCOPE1EXPRESSION', w.scope); n.bag.set('COMMENT', PLAN_COMMENT);
    for (const [k, v] of Object.entries(w.set)) n.bag.set(k, v);
    rules[i] = n; rulesChanged = true;
  }
  if (fresh.length) {
    // New ones above the rest of their kind (a lower priority number wins), in the plan's order
    for (const kind of ['Width', 'Clearance', 'RoutingVias', 'DiffPairsRouting']) {
      const news = fresh.filter((r) => ruleKind(r) === kind);
      if (!news.length) continue;
      rules = rules.map((r) => { if (ruleKind(r) !== kind) return r; const n = cloneRule(r); n.bag.set('PRIORITY', String(rulePriority(r) + news.length)); return n; });
      news.forEach((r, k) => r.bag.set('PRIORITY', String(k + 1)));
    }
    rules = [...rules, ...fresh]; rulesChanged = true;
  }

  // Classes: the plan's, as net classes; one of a plan before that nothing uses any more goes
  const planNames = new Set(plan.classes.map((c) => lower(c.name)));
  const gone = new Set<string>();
  for (const r of dropped) {
    const m = /^InNetClass\('(.+)'\)$/.exec(r.bag.get('SCOPE1EXPRESSION') ?? '');
    if (!m || planNames.has(lower(m[1]!))) continue;
    const quoted = `'${lower(m[1]!)}'`;
    if (!rules.some((x) => lower(x.bag.get('SCOPE1EXPRESSION') ?? '').includes(quoted) || lower(x.bag.get('SCOPE2EXPRESSION') ?? '').includes(quoted))) gone.add(lower(m[1]!));
  }
  let classesChanged = false;
  const bags: PropertyBag[] = [];
  const done = new Set<string>();
  for (const c of doc.classes) {
    const isNet = c.kind === 0 && !c.superClass;
    if (isNet && gone.has(lower(c.name))) { classesChanged = true; continue; }
    const p = isNet && !done.has(lower(c.name)) ? plan.classes.find((x) => lower(x.name) === lower(c.name)) : undefined;
    if (!p) { bags.push(c.bag); continue; }
    done.add(lower(p.name));
    if (sameSet(c.members, p.nets)) bags.push(c.bag); else { bags.push(withMembers(c.bag, p.nets)); classesChanged = true; }
  }
  for (const c of plan.classes) if (!done.has(lower(c.name))) { bags.push(classBag(c.name, 0, c.nets)); classesChanged = true; }

  // Pours: one of that net on that layer already there is the plan's; otherwise one is added
  const pours: number[] = [], newPours: { net: number; layer: LayerId }[] = [];
  for (const p of plan.pours) {
    const net = netIndex(doc, p.net), layer = layerByName(doc, p.layer);
    if (net < 0 || layer === undefined) continue;
    if (!isSignal(layer)) { skipped.push(`${p.layer} is a plane layer: ${p.net} is not poured on it`); continue; }
    const had = doc.polygons.find((g) => g.layer === layer && g.net === net && !g.bag.bool('SHELVED') && (!g.type || /^polygon$/i.test(g.type)));
    if (had) { pours.push(had.index); continue; }
    const other = doc.polygons.find((g) => g.layer === layer && g.net !== net && g.net !== NO_NET && (!g.type || /^polygon$/i.test(g.type)));
    if (other) skipped.push(`${p.layer} has a pour of ${doc.nets[other.net]?.name ?? 'another net'} already: the plan's pour of ${p.net} is added over it, and takes what that one leaves`);
    newPours.push({ net, layer });
  }
  return { rules, rulesChanged, bags, classesChanged, pairs, pairsChanged, pours, newPours, skipped };
}

/** The outline of a plan's pour: the board's, a little inside its edge. */
function pourOutline(doc: PcbDocument): Vec2[] {
  const o = doc.board.outline, f = boardFrame(doc);
  if (!f) return [];
  if (isRectangle(o, f)) {
    const b = { minX: f.minX + POUR_INSET, minY: f.minY + POUR_INSET, maxX: f.maxX - POUR_INSET, maxY: f.maxY - POUR_INSET };
    return [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
  }
  return insetOutline(o, POUR_INSET);
}

export interface PlanApplied { classes: number; rules: number; pairs: number; pours: number; changed: boolean; skipped: string[] }

/**
 * Put the plan on the board: its classes, rules, pairs and pours, each change handed to `add`
 * (which makes it: a pour is poured once its polygon is there). Nothing is handed over for what
 * the board already has as the plan says.
 */
export function applyRoutingPlan(doc: PcbDocument, plan: RoutingPlan, add: (c: Change) => void): PlanApplied {
  const s = planState(doc, plan);
  // The rules go in as a new list even when only the classes change: their scopes are read afresh
  if (s.rulesChanged || s.classesChanged) add(replaceRules(doc, s.rulesChanged ? s.rules : [...doc.rules]));
  if (s.classesChanged) add(setClasses(doc, s.bags));
  if (s.pairsChanged) add(setDiffPairs(doc, s.pairs));
  const outline = s.newPours.length ? pourOutline(doc) : [];
  let poured = 0;
  if (outline.length >= 3) for (const p of s.newPours) {
    const i = doc.polygons.length;
    const name = `${doc.nets[p.net]?.name ?? 'NoNet'}_L${p.layer === 32 ? 2 : p.layer}_P${String(i).padStart(3, '0')}`;
    const bag = newPolygonProps(layerToName(p.layer), p.net, name, i);
    writeVertices(bag, outline.map((q) => ({ p: q })));
    add(addPolygon(doc, bag));
    add(repour(doc, i));
    poured++;
  }
  return { classes: plan.classes.length, rules: s.rules.filter(mine).length, pairs: plan.pairs.length, pours: s.pours.length + poured,
    changed: s.rulesChanged || s.classesChanged || s.pairsChanged || poured > 0, skipped: s.skipped };
}

/* ─── The plan as it stands on the board ─────────────────────────────────────────────── */

export interface ClassOnBoard {
  cls: RouteClass;
  nets: number[];
  layers: LayerId[];
  /** In document units; 0: as the board's rules have it. */
  width: number; clearance: number;
  /** Narrower, or closer, than the board's own rules (for a net of no class): the designer's fabricator decides. */
  narrow: boolean; tight: boolean;
  /** Its connections still to route, and their length as the crow flies (mm). */
  left: number; length: number;
}
export interface RoutingOnBoard {
  classes: ClassOnBoard[];
  pours: { pour: RoutePour; net: number; layer: LayerId; index: number }[];
  pairs: { pair: RoutePair; there: boolean }[];
  base: BaseRules;
  /** The board has the plan's classes, rules, pairs and pours as the plan says. */
  applied: boolean;
  /** All the board's connections still to route, and those of nets in no class. */
  left: number; unclassed: number;
  skipped: string[];
}

export function routingOnBoard(doc: PcbDocument, plan: RoutingPlan): RoutingOnBoard {
  const base = baseRules(doc), s = planState(doc, plan);
  const byNet = new Map<number, { n: number; len: number }>();
  const conns = connections(doc);
  for (const c of conns) { const e = byNet.get(c.net) ?? { n: 0, len: 0 }; e.n++; e.len += Math.hypot(c.a.x - c.b.x, c.a.y - c.b.y); byNet.set(c.net, e); }
  const classed = new Set<number>();
  const classes = plan.classes.map((cls): ClassOnBoard => {
    const nets = cls.nets.map((n) => netIndex(doc, n)).filter((i) => i >= 0);
    for (const n of nets) classed.add(n);
    const width = Math.round(cls.width * MM), clearance = Math.round(cls.clearance * MM);
    return { cls, nets, layers: cls.layers.map((l) => layerByName(doc, l)).filter((l): l is LayerId => l !== undefined && isSignal(l)), width, clearance,
      // By more than a twentieth: 0.25 mm asked where the rule says 10 mil (0.254 mm) is the same to any fabricator
      narrow: width > 0 && width < base.min * 0.95, tight: clearance > 0 && clearance < base.gap * 0.95,
      left: nets.reduce((a, n) => a + (byNet.get(n)?.n ?? 0), 0), length: nets.reduce((a, n) => a + (byNet.get(n)?.len ?? 0), 0) / MM };
  });
  const pours = plan.pours.flatMap((pour) => {
    const net = netIndex(doc, pour.net), layer = layerByName(doc, pour.layer);
    if (net < 0 || layer === undefined || !isSignal(layer)) return [];
    return [{ pour, net, layer, index: doc.polygons.find((g) => g.layer === layer && g.net === net && !g.bag.bool('SHELVED') && (!g.type || /^polygon$/i.test(g.type)))?.index ?? -1 }];
  });
  const have = diffPairsOf(doc);
  const pairs = plan.pairs.map((pair) => ({ pair, there: have.some((d) => (lower(d.pos) === lower(pair.p) && lower(d.neg) === lower(pair.n)) || (lower(d.pos) === lower(pair.n) && lower(d.neg) === lower(pair.p))) }));
  return { classes, pours, pairs, base, applied: !s.rulesChanged && !s.classesChanged && !s.pairsChanged && !s.newPours.length,
    left: conns.length, unclassed: conns.filter((c) => !classed.has(c.net)).length, skipped: s.skipped };
}

/* ─── Routing by the plan ────────────────────────────────────────────────────────────── */

/** The nets the stack's plane layers carry (each layer's own net; the parts of a split plane are the designer's). */
export function planeNets(doc: PcbDocument): { net: number; layer: LayerId }[] {
  const out: { net: number; layer: LayerId }[] = [];
  for (const l of doc.board.copperStack) {
    if (!isCopper(l) || isSignal(l)) continue;
    const name = doc.board.bag?.get(`PLANE${l - L.PLANE1 + 1}NETNAME`);
    const net = name ? netIndex(doc, name) : -1;
    if (net >= 0) out.push({ net, layer: l });
  }
  return out;
}

/**
 * Surface-mount pads of the plan's poured nets that are not on their pour's layer, and of the
 * nets the stack's planes carry, with nothing on them yet: each gets a via into its pour or plane.
 */
export function planFanout(doc: PcbDocument, on: RoutingOnBoard): FanoutResult {
  const layersOf = new Map<number, Set<LayerId>>();
  for (const p of [...on.pours, ...planeNets(doc)]) layersOf.set(p.net, (layersOf.get(p.net) ?? new Set()).add(p.layer));
  return fanout(doc, smdPads(doc, (p: PcbPad) => { const ls = layersOf.get(p.net); return !!ls && !ls.has(p.layer); }));
}

/** Makes a change on the board (in the editor: one step of the run's undo); false when the board changed under the run, which then ends. */
export type Commit = (fn: (add: (c: Change) => void) => void) => boolean;

export interface RouteRun {
  /** The connections there were before the run, and those left after it. */
  before: number; left: number;
  /** Pads given a via into their pour or plane, and those with no room for one. */
  fanned: number; fanFailed: number;
  /** Connections the autorouter routed; of those, the ones necked down at a pad narrower than their track, and the nets routed narrower than their class's width all the way. */
  routed: number; necked: number; narrowed: string[];
  /** Differential pairs laid side by side at their gap, of those the board has with connections to make. */
  coupled: number; pairs: number;
  /** Tracks and vias added; the routes then made free-flowing, and the arcs that gave them. */
  tracks: number; vias: number; flowed: number; arcs: number;
  /** Track length added, mm. */
  length: number;
  ms: number; stopped: boolean;
  applied: PlanApplied;
  /** What the design rule check found in the copper, hole and pair rules before the run, by rule kind. */
  drcBefore: Record<string, number>;
}

/**
 * Route the board by the plan. The plan is put on the board first (unless it is there); then the
 * fanout into the pours, the autorouter's rounds and the pours' repouring, each made through
 * `commit` as it is ready (what comes after reads the board with it in place).
 */
export async function routeByPlan(doc: PcbDocument, plan: RoutingPlan, o: {
  commit: Commit; job?: RouteJob; progress?: (text: string) => void;
  /** The designer's Routing Style preference is free-flowing: how the classes that say nothing of their style are routed. */
  flowing?: boolean;
}): Promise<RouteRun | null> {
  const t0 = Date.now();
  const before = connections(doc).length;
  const drcBefore = copperViolations(doc);
  let applied: PlanApplied = { classes: 0, rules: 0, pairs: 0, pours: 0, changed: false, skipped: [] };
  if (!o.commit((add) => { applied = applyRoutingPlan(doc, plan, add); })) return null;
  const on = routingOnBoard(doc, plan);
  const run: RouteRun = { before, left: before, fanned: 0, fanFailed: 0, routed: 0, necked: 0, narrowed: [], coupled: 0, pairs: 0, tracks: 0, vias: 0, flowed: 0, arcs: 0, length: 0, ms: 0, stopped: false, applied, drcBefore };
  const repourAll = (add: (c: Change) => void) => { for (const g of doc.polygons) if (!g.bag.bool('SHELVED') && (!g.type || /^polygon$/i.test(g.type))) add(repour(doc, g.index)); };
  const lengthOf = (ts: { a: Vec2; b: Vec2 }[]) => ts.reduce((a, t) => a + Math.hypot(t.a.x - t.b.x, t.a.y - t.b.y), 0) / MM;
  // The tracks routed for classes that are to be free-flowing: reshaped once everything is routed
  const flowKeys = new Set<string>();
  const flowOf = (net: number) => { const k = classOf.get(net); return k?.cls.style ? k.cls.style === 'flowing' : !!o.flowing; };

  // Into the pours and planes
  o.progress?.('Vias into the pours');
  const fan = planFanout(doc, on);
  run.fanned = fan.done; run.fanFailed = fan.failed.length;
  if (fan.done) {
    if (!o.commit((add) => { add(addTracks(doc, fan.tracks)); add(addVias(doc, fan.vias)); repourAll(add); })) return null;
    run.tracks += fan.tracks.length; run.vias += fan.vias.length; run.length += lengthOf(fan.tracks);
  }

  // The connections, class by class
  const classOf = new Map<number, ClassOnBoard>();
  for (const c of on.classes) for (const n of c.nets) classOf.set(n, c);
  const pairOrder = new Map<number, number>();
  plan.pairs.forEach((p, k) => { for (const n of [p.p, p.n]) { const i = netIndex(doc, n); if (i >= 0) pairOrder.set(i, k); } });
  // A class's pairs first, their two nets one after the other; nets of no class last
  const rank = (c: Connection) => (classOf.get(c.net)?.cls.order ?? 1e6) * 1000 + (pairOrder.get(c.net) ?? 999);
  const narrowOf = (net: number) => { const w = netRouting(doc, net).width, r = ruleFor(doc, 'Width', probeTrack(net)); const min = r ? ruleLength(r, 'MINLIMIT', '10mil') : w; return min < w - 1 ? min : 0; };
  // The board's differential pairs, each with the gap its rule gives it: laid side by side where they can be
  const pairs = diffPairsOf(doc).map((d) => ({ p: netIndex(doc, d.pos), n: netIndex(doc, d.neg), gap: pairRule(doc, L.TOP, d).gap })).filter((x) => x.p >= 0 && x.n >= 0);
  { const open = new Set(connections(doc).map((c) => c.net)); run.pairs = pairs.filter((x) => open.has(x.p) && open.has(x.n)).length; }
  // The first round at the planned widths. Then what is left: a net that had a connection fail goes at the narrowest its rule
  // allows (where that is narrower); what the pours' repouring parted is routed. A round that routes nothing ends it.
  const failedNets = new Set<number>(), narrowed = new Set<string>();
  for (let round = 0; round < 3; round++) {
    const conns = connections(doc);
    if (!conns.length) break;
    const of = conns.length;
    const narrow = (net: number) => (round > 0 && failedNets.has(net) ? narrowOf(net) : 0);
    const r = await autoroute(doc, conns, {
      job: o.job, rank, verify: true, pairs,
      how: (c) => { const k = classOf.get(c.net), w = narrow(c.net); return k || w ? { layers: k?.layers, vias: k?.cls.vias, ...(w ? { width: w } : {}) } : undefined; },
      progress: (i) => o.progress?.(`${round ? 'Again' : 'Routing'}: ${i} of ${of}`),
    });
    if (o.job?.cancelled) run.stopped = true;
    if (r.tracks.length || r.vias.length) {
      for (const t of r.tracks) if (t.net !== undefined && narrow(t.net)) narrowed.add(doc.nets[t.net]?.name ?? '');
      if (!o.commit((add) => { if (r.tracks.length) add(addTracks(doc, r.tracks)); if (r.vias.length) add(addVias(doc, r.vias)); repourAll(add); })) return null;
      run.routed += r.routed; run.necked += r.necked; run.coupled += r.coupled; run.tracks += r.tracks.length; run.vias += r.vias.length; run.length += lengthOf(r.tracks);
      for (const t of r.tracks) if (t.net !== undefined && flowOf(t.net)) flowKeys.add(trackKey(t));
    }
    for (const c of r.failed) failedNets.add(c.net);
    if (run.stopped || (round > 0 && !r.routed)) break;
  }
  // Free-flowing: the routes of the classes that ask for it (or of all, by the designer's preference), now that every route is there
  if (flowKeys.size) {
    o.progress?.('Making routes free-flowing');
    const f = await reflow(doc, tracksByKey(doc, flowKeys), { job: o.job, progress: (i, n) => o.progress?.(`Free-flowing: ${i} of ${n}`) });
    if (o.job?.cancelled) run.stopped = true;
    if (f.reshaped) {
      if (!o.commit((add) => { add(removePrims(doc, f.remove)); if (f.tracks.length) add(addTracks(doc, f.tracks)); if (f.arcs.length) add(addArcs(doc, f.arcs)); repourAll(add); })) return null;
      run.flowed = f.reshaped; run.arcs = f.arcs.length; run.tracks += f.tracks.length - f.remove.length; run.length += (f.after - f.before) / MM;
    }
  }
  run.narrowed = [...narrowed].filter(Boolean).sort();
  run.left = connections(doc).length;
  run.ms = Date.now() - t0;
  return run;
}

/* ─── What came of it ────────────────────────────────────────────────────────────────── */

/** A connection's ends by their pads ("U2-17 to C4-1"), for the lists of what is left. */
function endsOf(doc: PcbDocument, c: Connection): string {
  const pad = (at: Vec2) => {
    const p = doc.prims.find((q): q is PcbPad => q.kind === 'pad' && q.net === c.net && Math.abs(q.at.x - at.x) < 2 && Math.abs(q.at.y - at.y) < 2);
    return p ? `${p.component !== NO_NET ? doc.components[p.component]?.designator ?? '?' : 'pad'}-${p.name}` : '?';
  };
  return `${pad(c.a)} to ${pad(c.b)}`;
}

/** The rules a routing run answers for: copper against copper, the board's edge, track widths, holes, and the pairs' widths, gaps and coupling. */
export const COPPER_KINDS = ['Clearance', 'ShortCircuit', 'Width', 'HoleSize', 'HoleToHoleClearance', 'MinimumAnnularRing', 'BoardOutlineClearance', 'DiffPairsRouting'];
/** What the design rule check finds in those rules, by kind. */
export function copperViolations(doc: PcbDocument): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const v of runDrc(doc, new Set(COPPER_KINDS)).violations) kinds[v.kind] = (kinds[v.kind] ?? 0) + 1;
  return kinds;
}

export interface RouteOutcome {
  /** What the design rule check finds in the copper, hole and pair rules that it did not find before the run, by rule kind. */
  drc: { kind: string; n: number }[];
  violations: number;
  /** Violations of those rules that were there before the run and still are. */
  standing: number;
  /** The connections left, by class name ('' for nets of no class), each with its net and ends. */
  left: { cls: string; list: string[] }[];
}

/** The board measured after a run: what is left, and what the design rule check finds that it did not find before. */
export function routeOutcome(doc: PcbDocument, plan: RoutingPlan, before: Record<string, number> = {}): RouteOutcome {
  const now = copperViolations(doc);
  const kinds = new Map<string, number>();
  let standing = 0;
  for (const [kind, n] of Object.entries(now)) { const was = before[kind] ?? 0; if (n > was) kinds.set(kind, n - was); standing += Math.min(n, was); }
  const cls = new Map<number, string>();
  for (const c of plan.classes) for (const n of c.nets) { const i = netIndex(doc, n); if (i >= 0) cls.set(i, c.name); }
  const by = new Map<string, string[]>();
  for (const c of connections(doc)) {
    const k = cls.get(c.net) ?? '';
    by.set(k, [...(by.get(k) ?? []), `${doc.nets[c.net]?.name ?? 'No Net'} (${endsOf(doc, c)}, ${Math.round((Math.hypot(c.a.x - c.b.x, c.a.y - c.b.y) / MM) * 10) / 10} mm)`]);
  }
  const drc = [...kinds].map(([kind, n]) => ({ kind, n })).sort((a, b) => b.n - a.n);
  return { drc, violations: drc.reduce((a, d) => a + d.n, 0), standing, left: [...by].map(([c, list]) => ({ cls: c, list })) };
}

export const mmText = (units: number) => `${Math.round((units / MM) * 1000) / 1000} mm`;

/** The plan as text: for the clipboard, and for a second round (what the model is shown of the plan made before). */
export function routingText(plan: RoutingPlan): string {
  const lines: string[] = [];
  if (plan.summary) lines.push(plan.summary, '');
  lines.push('Classes, in the order they are routed:');
  for (const c of [...plan.classes].sort((a, b) => a.order - b.order)) {
    lines.push(`${c.order}. ${c.name} (${[c.width ? `${c.width} mm wide` : 'the board\'s width', c.clearance ? `${c.clearance} mm clear` : '', c.layers.length ? `on ${c.layers.join(', ')}` : 'any layer', `vias: ${c.vias}`, c.style === 'flowing' ? 'free-flowing' : c.style === 'corners' ? 'with corners' : ''].filter(Boolean).join('; ')}): ${c.nets.join(', ')}${c.why ? `. ${c.why}` : ''}`);
  }
  if (plan.via) lines.push('', `Via: ${plan.via.diameter} mm across with a ${plan.via.hole} mm hole${plan.via.why ? `. ${plan.via.why}` : ''}`);
  if (plan.pours.length) lines.push('', 'Pours:', ...plan.pours.map((p) => `- ${p.net} over ${p.layer}${p.why ? `. ${p.why}` : ''}`));
  if (plan.pairs.length) lines.push('', 'Differential pairs:', ...plan.pairs.map((p) => `- ${p.name}: ${p.p} and ${p.n}${p.gap ? `, ${p.gap} mm apart` : ''}${p.why ? `. ${p.why}` : ''}`));
  if (plan.notes.length) lines.push('', 'Notes:', ...plan.notes.map((n) => `- ${n}`));
  return lines.join('\n');
}

/** What the router made of the plan, as text: for the model on a second round (and the clipboard). */
export function routeResultText(doc: PcbDocument, plan: RoutingPlan, run: RouteRun, out: RouteOutcome = routeOutcome(doc, plan, run.drcBefore)): string {
  const lines: string[] = [];
  lines.push(`${run.before} connection${run.before === 1 ? '' : 's'} to make before the run; ${run.left ? `${run.left} left` : 'none left'}.${run.stopped ? ' The run was stopped before its end.' : ''}`);
  if (run.fanned || run.fanFailed) lines.push(`Pads given a via into their pour or plane: ${run.fanned}${run.fanFailed ? `; ${run.fanFailed} had no room for one` : ''}.`);
  lines.push(`Routed by the autorouter: ${run.routed} connection${run.routed === 1 ? '' : 's'}; ${run.vias} via${run.vias === 1 ? '' : 's'} and ${Math.round(run.length * 10) / 10} mm of track added.`);
  if (run.pairs) lines.push(`Differential pairs laid side by side at their gap: ${run.coupled} of ${run.pairs}.`);
  if (run.flowed) lines.push(`Made free-flowing: ${run.flowed} route${run.flowed === 1 ? '' : 's'}, with ${run.arcs} arc${run.arcs === 1 ? '' : 's'}.`);
  if (run.necked) lines.push(`${run.necked} connection${run.necked === 1 ? ' is' : 's are'} necked down at a pad narrower than the track.`);
  if (run.narrowed.length) lines.push(`Routed narrower than their class's width, at the narrowest their rule allows, where the planned width could not get through: ${run.narrowed.join(', ')}.`);
  if (out.left.length) {
    lines.push('Left unrouted:');
    for (const l of out.left) {
      const c = plan.classes.find((x) => x.name === l.cls);
      lines.push(`- ${l.cls ? `${l.cls}${c?.width ? ` (${c.width} mm)` : ''}` : 'Nets of no class'}: ${l.list.slice(0, 40).join('; ')}${l.list.length > 40 ? `; and ${l.list.length - 40} more` : ''}`);
    }
  }
  lines.push(out.violations ? `The design rule check finds ${out.violations} violation${out.violations === 1 ? '' : 's'} of the copper, hole and pair rules that ${out.violations === 1 ? 'was' : 'were'} not there before the run: ${out.drc.map((d) => `${kindLabel(d.kind)} ${d.n}`).join(', ')}.`
    : 'The design rule check finds no violation of the copper, hole and pair rules that was not there before the run.');
  if (out.drc.some((d) => d.kind === 'DiffPairsRouting')) lines.push('A pair that could not be laid side by side (its ends not on one layer, no room for both, or the two would have to cross) was routed one net at a time: its rule reports what is uncoupled.');
  for (const s of run.applied.skipped) lines.push(`Not as planned: ${s}.`);
  return lines.join('\n');
}
