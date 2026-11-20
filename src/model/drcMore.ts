import RBush from 'rbush';
import {
  HELD, T, and3, boardArea, boardIndex, boardLength, contact, drcRules, pairRule, copperIslands, representatives, describe, distance, edges, memo, padGeom, rectPoly, scoped, unaryRule, widthLimits,
  type DrcViolation, type Geom, type Held, type Pick, type Scoped, type Shape,
} from './drc';
import { NO_NET, inPour, slotEnds, type PcbDocument, type PcbPad, type PcbPrim, type PcbText } from './pcb';
import { L, layerName, type LayerId } from './layers';
import { connectLength, connectValue, ruleDescription as ruleDescriptionOf, ruleLength, ruleName, type PcbRule } from '../formats/altium/rules';
import { UNITS_PER_MIL, UNITS_PER_MM, mil, parseLength, trimNum } from '../core/units';
import { arcChords, arcPoints, pointInPoly, type BBox, type Vec2 } from '../core/geom';
import { solderMask } from '../formats/gerber/gerber';
import { padExtrasOf } from '../formats/altium/primInfo';
import { padLayer } from './padStack';
import { readDrillPairs } from './layerSets';
import { drcSettings } from './drcOptions';
import { strokeCapHeight, strokeText } from '../formats/gerber/stroke';
import { gridCovers, gridStrokeText } from '../formats/gerber/strokeGrid';
import { TEXT, get as getField } from '../formats/altium/pcbLayouts';
import { barcodeShape } from './barcode';
import { readStack } from './pcbStack';
import { conductorShares, planeCopper, reliefDirs, splitPlanes } from './planes';
import { drcUnits, ruleFor } from './drc';
import { featureOn } from '../core/release';
import { SI_CHECKED, ruleLimits, stimulusOf, siNum, type SiLimit, type SiLimits, type Stimulus } from '../si/rules';
import { boardNetwork } from '../si/topology';
import { screenNet, siProvided } from '../si/analyse';
import { wireLinkPads } from './wireLink';
import { acuteCorners, boxOfSeg, copperParts, depthIn, describePiece, padOutline, signalLayers, trackPieces, type CopperPart, type TrackPiece } from './drcCopper';

/**
 * The rule kinds past copper clearance, as AD's batch DRC checks them (AD's Design Rule Types
 * pages; what they leave open is marked [est]): polygons, component height, unconnected pins,
 * net antennae, acute angles, lengths, SMD entry, routing vias and layers, differential pair
 * widths, solder mask slivers, silk to mask, silk to silk and silk to board region, component
 * clearance, and the Report Options' drilled SMT pads and multilayer pads with no hole.
 */
export const MORE_KINDS = [
  'UnpouredPolygon', 'Height', 'UnConnectedPin', 'NetAntennae', 'AcuteAngle', 'Length', 'MatchedLengths', 'SMDNeckDown', 'SMDToCorner',
  'ViasUnderSMD', 'RoutingVias', 'RoutingLayers', 'DiffPairsRouting', 'MinimumSolderMaskSliver', 'SilkToSolderMaskClearance',
  'SilkToSilkClearance', 'SilkToBoardRegionClearance', 'ComponentClearance', 'LayerPairs', 'SMDEntry', 'SMDToPlane', 'StubLength', 'DaisyChainStubLength',
  'ParallelSegment', 'MaximumViaCount', 'PermittedLayers', 'BackDrilling', 'Creepage', 'ReturnPath',
  'FabricationTestpoint', 'AssemblyTestpoint', 'FabricationTestPointUsage', 'AssemblyTestPointUsage',
  // Starved thermals on the planes (with Report Starved Thermals, in reportOptions)
  'PlaneConnect',
];

interface Ctx { doc: PcbDocument; notes: string[]; held: Held; out: DrcViolation[]; subject?: Set<number> }

const isSignal = (l: LayerId) => l >= L.TOP && l <= L.BOTTOM;
const ln = (doc: PcbDocument, l: LayerId) => doc.board.layerNames.get(l) ?? layerName(l);
const deg = (r: number) => (r * 180) / Math.PI;

export function runMore(doc: PcbDocument, kinds: Set<string>, notes: string[], held: Held, out: DrcViolation[], subject?: Set<number>): void {
  const c: Ctx = { doc, notes, held, out, subject };
  const has = (k: string) => kinds.has(k) && drcRules(doc).some((r) => r.bag.get('RULEKIND') === k && r.bag.bool('ENABLED', true));
  const whole = !subject;
  if (whole && has('UnpouredPolygon')) modifiedPolygons(c);
  if (whole && has('Height')) height(c);
  if (whole && has('UnConnectedPin')) unconnectedPins(c);
  if (has('NetAntennae')) netAntennae(c);
  if (has('AcuteAngle')) acuteAngles(c);
  if (whole && has('Length')) lengths(c);
  if (whole && has('MatchedLengths')) matchedLengths(c);
  if (has('SMDNeckDown') || has('SMDToCorner')) smdNeck(c, has('SMDNeckDown'), has('SMDToCorner'));
  if (has('SMDEntry')) smdEntry(c);
  if (whole && has('SMDToPlane')) smdToPlane(c);
  if (whole && (has('StubLength') || has('DaisyChainStubLength'))) stubLengths(c);
  if (has('ParallelSegment')) parallelSegments(c);
  if (has('ViasUnderSMD')) viasUnderSmd(c);
  if (has('RoutingVias')) routingVias(c);
  if (has('RoutingLayers')) routingLayers(c);
  if (has('DiffPairsRouting')) { diffPairWidths(c); if (whole) uncoupledLengths(c); }
  if (has('MinimumSolderMaskSliver')) maskSlivers(c);
  if (has('SilkToSolderMaskClearance')) silkToMask(c);
  if (has('SilkToSilkClearance')) silkToSilk(c);
  if (whole && has('SilkToBoardRegionClearance')) silkToBoard(c);
  if (whole && has('ComponentClearance')) componentClearance(c);
  if (has('LayerPairs')) layerPairs(c);
  if (whole && has('MaximumViaCount')) maxViaCount(c);
  if (whole && has('PermittedLayers')) permittedLayers(c);
  if (whole && has('BackDrilling')) backDrilling(c);
  if (has('Creepage')) creepage(c);
  if (has('ReturnPath')) returnPath(c);
  for (const k of ['Fabrication', 'Assembly'] as const) {
    if (has(`${k}Testpoint`)) testpointStyle(c, k);
    if (whole && has(`${k}TestPointUsage`)) testpointUsage(c, k);
  }
  // Signal Integrity's rules: checked once the feature is released
  const si = featureOn('si') ? SI_CHECKED.filter(has) : [];
  if (whole && si.length) signalIntegrity(c, new Set(si));
}

/* ─── Signal Integrity ──────────────────────────────────────────────────────────────── */

export interface SiBoardRules {
  /** A net's limits from the rules that take it, and each limit's rule (by name). */
  limits(net: number): { limits: SiLimits; rules: Partial<Record<SiLimit, PcbRule>> };
  /** The stimulus for a net (its Signal Stimulus rule, else the default). */
  stimulus(net: number): Stimulus | null;
  /** Supply nets and their voltages (upper-case names), by the Supply Nets rules. */
  supplies: Map<string, number>;
}

/** The board's Signal Integrity rules, asked per net (the highest-priority rule of each kind that takes one of its objects). */
export function siBoardRules(doc: PcbDocument, notes: string[] = []): SiBoardRules {
  const nets = primsByNet(doc);
  const objs = (net: number) => representatives(doc, nets.get(net) ?? []).map((i) => doc.prims[i]!);
  const lists = new Map<string, Scoped[]>();
  const list = (kind: string) => { let l = lists.get(kind); if (!l) { l = memo(scoped(doc, kind, notes)); lists.set(kind, l); } return l; };
  const supplies = new Map<string, number>();
  if (doc.rules.some((r) => r.bag.get('RULEKIND') === 'SupplyNets')) {
    for (const [net] of nets) {
      const r = netRule(list('SupplyNets'), objs(net));
      if (r && r !== HELD) { const v = siNum(r.rule.bag.get('VOLTAGE')); if (Number.isFinite(v)) supplies.set((doc.nets[net]?.name ?? '').toUpperCase(), v); }
    }
  }
  return {
    limits(net) {
      const limits: SiLimits = {}, rules: Partial<Record<SiLimit, PcbRule>> = {};
      for (const kind of SI_CHECKED) {
        if (!doc.rules.some((r) => r.bag.get('RULEKIND') === kind)) continue;
        const r = netRule(list(kind), objs(net));
        if (!r || r === HELD) continue;
        const l = ruleLimits(kind, (k) => r.rule.bag.get(k));
        for (const k of Object.keys(l) as SiLimit[]) { limits[k] = l[k]; rules[k] = r.rule; }
      }
      return { limits, rules };
    },
    stimulus(net) {
      if (!doc.rules.some((r) => r.bag.get('RULEKIND') === 'SignalStimulus')) return null;
      const r = netRule(list('SignalStimulus'), objs(net));
      return r && r !== HELD ? stimulusOf((k) => r.rule.bag.get(k)) : null;
    },
    supplies,
  };
}

/**
 * Signal Integrity rules: each net a rule takes screened (its rising and falling edges simulated,
 * unterminated, with the project's models) and held to the rule [est: AD's screening is its own
 * simulator's; the figures here are Konium's].
 */
function signalIntegrity(c: Ctx, kinds: Set<string>): void {
  const { doc } = c;
  const si = siBoardRules(doc, c.notes);
  const { ctx: base } = siProvided(doc);
  const ctx = { ...base, setup: { ...base.setup, supplies: new Map([...base.setup.supplies, ...si.supplies]) } };
  let screened = 0, skipped = 0;
  for (const [net, idx] of primsByNet(doc)) {
    const { limits, rules: by } = si.limits(net);
    const want = (Object.keys(limits) as SiLimit[]).filter((k) => by[k] && kinds.has(by[k]!.bag.get('RULEKIND') ?? ''));
    if (!want.length) continue;
    const name = doc.nets[net]?.name ?? String(net);
    const res = screenNet(name, boardNetwork(doc, net, ctx), Object.fromEntries(want.map((k) => [k, limits[k]])));
    if (res.status === 'Not analysed' || res.status === 'Analysis errors') { skipped++; continue; }
    screened++;
    for (const f of res.fails) {
      const rule = by[f.limit]!;
      push(c, { kind: f.kind, rule: ruleName(rule), prims: idx.slice(0, 1), at: firstAt(doc, idx), message: `${ruleDescriptionOf(rule, (v) => boardLength(doc, v))}: Net ${name} ${f.text}` });
    }
  }
  c.notes.push(`Signal Integrity: ${screened} net${screened === 1 ? '' : 's'} screened (both edges, no termination; Tools › Signal Integrity for the details)${skipped ? `, ${skipped} taken by its rules not analysed (no driver or receiver, a supply)` : ''} [est: the figures are Konium Designer's own simulation]`);
}

/* ─── helpers ───────────────────────────────────────────────────────────────────────── */

const rules = (c: Ctx, kind: string, asComponent = false) => memo(scoped(c.doc, kind, c.notes, asComponent));
const inSubject = (c: Ctx, i: number) => !c.subject || c.subject.has(i);
const len = (r: PcbRule, k: string, def: string) => ruleLength(r, k, def);
/** A rule key holding a length in internal units with no unit (SMD To Corner's DISTANCE, …). */
const rawLen = (r: PcbRule, k: string, def: number) => { const v = r.bag.get(k); if (v === undefined) return def; return /[a-z]/i.test(v) ? parseLength(v) ?? def : Number(v) || 0; };

function push(c: Ctx, v: Omit<DrcViolation, 'error'>): void { c.out.push({ ...v, error: true }); }

/** Primitives by component. */
function byComponent(doc: PcbDocument): Map<number, number[]> {
  const m = new Map<number, number[]>();
  doc.prims.forEach((p, i) => { if ('component' in p && p.component !== NO_NET) { const a = m.get(p.component); if (a) a.push(i); else m.set(p.component, [i]); } });
  return m;
}
/** A component-level rule for a component: the first whose scope takes one of its primitives; HELD when one above can't be decided. */
function componentRule(list: Scoped[], prims: PcbPrim[]): Pick {
  for (const r of list) {
    const v = prims.map((p) => r.s1(p));
    if (v.includes(true)) return r;
    if (v.includes(null)) return HELD;
  }
  return undefined;
}
/** A net-level rule for a net: the first whose scope takes one of the net's primitives. */
function netRule(list: Scoped[], prims: PcbPrim[]): Pick { return componentRule(list, prims); }

function primsByNet(doc: PcbDocument): Map<number, number[]> {
  const m = new Map<number, number[]>();
  doc.prims.forEach((p, i) => { if ('net' in p && p.net !== NO_NET && !inPour(p)) { const a = m.get(p.net); if (a) a.push(i); else m.set(p.net, [i]); } });
  return m;
}

const arcLen = (p: { r: number; start: number; end: number }) => p.r * ((((p.end - p.start) % 360 + 360) % 360 || 360) * Math.PI) / 180;
const arcEnd = (p: { c: Vec2; r: number }, a: number): Vec2 => ({ x: p.c.x + p.r * Math.cos((a * Math.PI) / 180), y: p.c.y + p.r * Math.sin((a * Math.PI) / 180) });

/* ─── Modified Polygon (Un-Poured Polygon) ───────────────────────────────────────────── */

/**
 * A polygon that is shelved, or modified and not repoured (Polygons6 COPPERINVALIDATE [est]),
 * unless the rule allows it (ALLOWSHELVED / ALLOWMODIFIED [est], or the old ALLOWUNPOURED).
 */
function modifiedPolygons(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'UnpouredPolygon');
  const first = new Map<number, number>();
  doc.prims.forEach((p, i) => { if (inPour(p)) { const g = (p as { polygon: number }).polygon; if (!first.has(g)) first.set(g, i); } });
  for (const g of doc.polygons) {
    if (/split/i.test(g.type)) continue;
    const shelved = g.bag.bool('SHELVED'), modified = g.bag.bool('COPPERINVALIDATE');
    if (!shelved && !modified) continue;
    const pi = first.get(g.index);
    const r = list.find((x) => /^\s*all\s*$/i.test(x.rule.bag.get('SCOPE1EXPRESSION') ?? 'All') || (pi !== undefined && x.s1(doc.prims[pi]!) === true));
    if (!r) continue;
    const old = r.rule.bag.bool('ALLOWUNPOURED');
    const allowShelved = r.rule.bag.bool('ALLOWSHELVED') || old, allowModified = r.rule.bag.bool('ALLOWMODIFIED');
    if ((shelved && allowShelved) || (!shelved && (!modified || allowModified))) continue;
    const at = g.outline.length ? g.outline.reduce((a, q) => ({ x: a.x + q.x / g.outline.length, y: a.y + q.y / g.outline.length }), { x: 0, y: 0 }) : doc.board.origin;
    push(c, { kind: 'UnpouredPolygon', rule: ruleName(r.rule), prims: pi !== undefined ? [pi] : [], at,
      message: `Modified Polygon (Allow modified: ${allowModified ? 'Yes' : 'No'}), (Allow shelved: ${allowShelved ? 'Yes' : 'No'}): Polygon ${g.name || `#${g.index}`} on ${ln(doc, g.layer)} ${shelved ? 'is shelved' : 'has been modified and not repoured'}` });
  }
}

/* ─── Height ─────────────────────────────────────────────────────────────────────────── */

/** A component's height: its 3D bodies' overall height when it has any, else its Height property. */
export function componentHeight(doc: PcbDocument, comp: number, prims: number[]): number {
  let h = -Infinity;
  for (const i of prims) { const p = doc.prims[i]!; if (p.kind === 'body') h = Math.max(h, p.overall); }
  return Number.isFinite(h) ? h : parseLength(doc.components[comp]?.bag.getRaw('HEIGHT') ?? '0mil') ?? 0;
}

function height(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'Height', true);
  for (const [comp, idx] of byComponent(doc)) {
    const r = componentRule(list, representatives(doc, idx).map((i) => doc.prims[i]!));
    if (r === HELD) { c.held.n++; continue; }
    if (!r) continue;
    const h = componentHeight(doc, comp, idx);
    const min = len(r.rule, 'MINHEIGHT', '0mil'), max = len(r.rule, 'MAXHEIGHT', '1000mil'), pref = len(r.rule, 'PREFHEIGHT', '500mil');
    if (h >= min - T && h <= max + T) continue;
    const k = doc.components[comp]!;
    push(c, { kind: 'Height', rule: ruleName(r.rule), prims: idx.slice(0, 1), at: k.at,
      message: `Height Constraint (Min=${boardLength(doc, min)}) (Max=${boardLength(doc, max)}) (Prefered=${boardLength(doc, pref)}): Component ${k.designator} (${k.pattern}) Actual Height = ${boardLength(doc, h)}` });
  }
}

/* ─── Un-Connected Pin ───────────────────────────────────────────────────────────────── */

/**
 * A pad with no net and nothing routed to it, a free pad too (the suite reports one). On a board
 * with internal planes a Multi-Layer pad isn't reported [est: the suite's report of such a board
 * leaves out every Multi-Layer pad with no net, a connector's spare pins and free pads alike].
 */
function unconnectedPins(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'UnConnectedPin');
  const tree = boardIndex(doc);
  const planes = doc.board.copperStack.some((l) => l >= L.PLANE1 && l <= L.PLANE16);
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad' || p.net !== NO_NET || (planes && p.layer === L.MULTI)) return;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; return; }
    if (!r) return;
    const own = tree.all().length ? copperOf(tree, i) : [];
    const touched = own.some((s) => tree.search(s).some((o) => o.prim !== i && o.layer === s.layer && !o.role && (doc.prims[o.prim]!.kind === 'track' || doc.prims[o.prim]!.kind === 'arc') && distance(s.g, o.g, 2 * T) <= T));
    if (touched) return;
    push(c, { kind: 'UnConnectedPin', rule: ruleName(r.rule), prims: [i], at: p.at, message: `Un-Connected Pin Constraint: ${describe(doc, i)}` });
  });
}

const shapesOf = new WeakMap<RBush<Shape>, Map<number, Shape[]>>();
function copperOf(tree: RBush<Shape>, i: number): Shape[] {
  let m = shapesOf.get(tree);
  if (!m) { m = new Map(); for (const s of tree.all()) { const a = m.get(s.prim); if (a) a.push(s); else m.set(s.prim, [s]); } shapesOf.set(tree, m); }
  return m.get(i) ?? [];
}

/* ─── Net Antennae ───────────────────────────────────────────────────────────────────── */

/** Same-net copper of another object touching a disc on a layer. */
function touches(tree: RBush<Shape>, self: number, layer: LayerId, net: number, at: Vec2, r: number): boolean {
  const g: Geom = { t: 'circle', c: at, r };
  return tree.search({ minX: at.x - r - T, minY: at.y - r - T, maxX: at.x + r + T, maxY: at.y + r + T })
    .some((o) => o.prim !== self && o.layer === layer && o.net === net && o.role !== 'hole' && o.role !== 'keepout' && distance(g, o.g, 2 * T) <= T);
}

/** The plane layers a via or through-hole pad meets on its own net (the layer's net, or the split plane it stands in). */
export function planeNetsAt(doc: PcbDocument): (p: { at: Vec2; net: number }, layer: LayerId) => boolean {
  const cache = new Map<LayerId, { main: number; splits: { net: number; outline: Vec2[] }[] }>();
  return (p, layer) => {
    let e = cache.get(layer);
    if (!e) {
      const name = doc.board.bag?.get(`PLANE${layer - L.PLANE1 + 1}NETNAME`);
      e = { main: name ? doc.nets.findIndex((n) => n.name === name) : -1, splits: splitPlanes(doc, layer).map((g) => ({ net: g.net, outline: g.outline })) };
      cache.set(layer, e);
    }
    const sp = e.splits.find((s) => pointInPoly(p.at, s.outline));
    return (sp ? sp.net : e.main) === p.net && p.net !== NO_NET;
  };
}

/** How many other objects of a via's net its copper touches, on any of its layers (pour copper counts; planes are counted by the caller). */
function viaContacts(tree: RBush<Shape>, i: number, net: number, upTo: number): number {
  const seen = new Set<number>();
  for (const s of copperOf(tree, i)) {
    if (s.role) continue;
    for (const o of tree.search({ minX: s.minX - T, minY: s.minY - T, maxX: s.maxX + T, maxY: s.maxY + T })) {
      if (o.prim === i || seen.has(o.prim) || o.layer !== s.layer || o.net !== net || o.role || distance(s.g, o.g, 2 * T) > T) continue;
      seen.add(o.prim);
      if (seen.size >= upTo) return seen.size;
    }
  }
  return seen.size;
}

/**
 * As the suite reports them (its reports of boards with stubs, open arcs and stitching vias): each
 * end of a track or arc that meets nothing of its net (beyond the tolerance), once per open end (a
 * track or arc with both ends open twice, a full circle touching nothing too); and a via that touches
 * one object of its net at most (a pour counts, and an internal plane of its net it passes through:
 * a stitching via in one pour is an antenna, one through two pours, or a pour and its net's plane,
 * isn't). Arcs first, then vias, then tracks layer by layer, the latest placed first in each, as the
 * suite lists them.
 */
function netAntennae(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'NetAntennae');
  const tree = boardIndex(doc);
  const found: { order: number; v: Omit<DrcViolation, 'error'> }[] = [];
  const stackAt = new Map(doc.board.copperStack.map((l, k) => [l, k]));
  const planeNet = planeNetsAt(doc);
  const planes = doc.board.copperStack.filter((l) => l >= L.PLANE1 && l <= L.PLANE16);
  const viaOnPlane = (v: Extract<PcbPrim, { kind: 'via' }>) => {
    const a = stackAt.get(v.layerStart) ?? 0, b = stackAt.get(v.layerEnd) ?? 99;
    return planes.some((l) => { const k = stackAt.get(l)!; return k >= Math.min(a, b) && k <= Math.max(a, b) && planeNet(v, l); });
  };
  doc.prims.forEach((p, i) => {
    if (!inSubject(c, i)) return;
    if (p.kind !== 'track' && p.kind !== 'arc' && p.kind !== 'via') return;
    if (p.net === NO_NET || ('polygon' in p && inPour(p)) || ((p.kind === 'track' || p.kind === 'arc') && (p.keepout || !isSignal(p.layer)))) return;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; return; }
    if (!r) return;
    const tol = len(r.rule, 'NETANTENNAETOLERANCE', '0mil');
    const add = (at: Vec2) => {
      const group = p.kind === 'arc' ? 0 : p.kind === 'via' ? 1 : 2 + (stackAt.get(p.layer) ?? 99);
      found.push({ order: group * 1e9 - i, v: { kind: 'NetAntennae', rule: ruleName(r.rule), prims: [i], at, message: `Net Antennae: ${describe(doc, i)}` } });
    };
    if (p.kind === 'via') {
      if (viaContacts(tree, i, p.net, 2) + (viaOnPlane(p) ? 1 : 0) <= 1) add(p.at);
      return;
    }
    const full = p.kind === 'arc' && ((p.end - p.start) % 360 + 360) % 360 === 0;
    const ends: Vec2[] = p.kind === 'track' ? [p.a, p.b] : full ? [arcEnd(p, p.start), arcEnd(p, p.start)] : [arcEnd(p, p.start), arcEnd(p, p.end)];
    for (const e of ends) if (!touches(tree, i, p.layer, p.net, e, p.width / 2 + tol)) add(e);
  });
  for (const f of found.sort((a, b) => a.order - b.order)) push(c, f.v);
}

/* ─── Acute Angle ────────────────────────────────────────────────────────────────────── */

/**
 * Acute Angle, as the suite checks it [est, from its reports]: each net's copper on a layer is
 * merged (its tracks as the SMD rules cut them, arcs, pads, vias, fills and regions, round shapes
 * as 16-sided polygons) and every corner of the merged outline where the bare board between the
 * two edges is narrower than the minimum is reported, between the objects whose edges meet there
 * (a region's own corner by the region alone). So a track leaving a pad at 45° is a 45° corner on
 * the side it leans to, while a teardrop merged into its track makes none; bare board enclosed by
 * copper is not looked at. Check Tracks Only: only corners between tracks and arcs.
 */
function acuteAngles(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'AcuteAngle');
  const minOf = (r: Scoped) => Number((r.rule.bag.get('MINIMUM') ?? '90').trim()) || 90;
  const below = Math.max(0, ...list.map(minOf));
  if (!below) return;
  // Online, the nets of the objects changed only, round them
  const nets = c.subject ? new Set([...c.subject].map((i) => { const p = doc.prims[i]; return p && 'net' in p ? p.net : NO_NET; })) : undefined;
  let window: BBox | undefined;
  if (c.subject) {
    const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const take = (v: Vec2, r: number) => { b.minX = Math.min(b.minX, v.x - r); b.minY = Math.min(b.minY, v.y - r); b.maxX = Math.max(b.maxX, v.x + r); b.maxY = Math.max(b.maxY, v.y + r); };
    for (const i of c.subject) {
      const p = doc.prims[i];
      if (!p) continue;
      if (p.kind === 'track') { take(p.a, p.width); take(p.b, p.width); }
      else if (p.kind === 'arc') take(p.c, p.r + p.width);
      else if (p.kind === 'pad') take(p.at, Math.max(p.top.w, p.top.h, p.mid.w, p.mid.h, p.bot.w, p.bot.h));
      else if (p.kind === 'via') take(p.at, p.diameter);
      else if (p.kind === 'fill') { take(p.a, 0); take(p.b, 0); }
      else if (p.kind === 'region') for (const v of p.outline) take(v, 0);
    }
    if (!Number.isFinite(b.minX)) return;
    const m = mil(50);
    window = { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
  }
  const pieces = trackPieces(doc);
  const name = (part: CopperPart) => (part.piece ? describePiece(doc, part.piece) : describe(doc, part.prim));
  for (const layer of signalLayers(doc)) {
    for (const [net, parts] of copperParts(doc, layer, pieces, nets)) {
      for (const k of acuteCorners(parts, layer, net, below, window)) {
        const [a, b] = k.parts, pa = doc.prims[a.prim]!, pb = doc.prims[b.prim]!;
        if (c.subject && !c.subject.has(a.prim) && !c.subject.has(b.prim)) continue;
        const r = a === b ? unaryRule(list, pa) : pickPair(list, pa, pb);
        if (r === HELD) { c.held.n++; continue; }
        if (!r) continue;
        const min = minOf(r);
        if (k.angle >= min - 1e-9) continue;
        if (r.rule.bag.bool('CHECKTRACKSONLY') && [pa, pb].some((p) => p.kind !== 'track' && p.kind !== 'arc')) continue;
        const ang = k.angle.toFixed(3);
        push(c, { kind: 'AcuteAngle', rule: ruleName(r.rule), prims: a === b ? [a.prim] : [a.prim, b.prim], at: k.at,
          message: `Acute Angle Constraint: (${ang} < ${min.toFixed(3)}) ${a === b ? name(a) : `Between ${name(a)} And ${name(b)}`} (Angle = ${ang})` });
      }
    }
  }
}

/** A unary rule both objects fall under (the first that takes either). */
function pickPair(list: Scoped[], a: PcbPrim, b: PcbPrim): Pick {
  for (const r of list) {
    const x = r.s1(a), y = r.s1(b);
    if (x === true || y === true) return r;
    if (x === null || y === null) return HELD;
  }
  return undefined;
}

/* ─── Length and Matched Lengths ─────────────────────────────────────────────────────── */

/** A net's routed length: its tracks and arcs on signal layers (pour copper aside). */
export function netLengths(doc: PcbDocument): Map<number, number> {
  const m = new Map<number, number>();
  for (const p of doc.prims) {
    if ((p.kind !== 'track' && p.kind !== 'arc') || p.net === NO_NET || inPour(p) || !isSignal(p.layer) || p.keepout) continue;
    m.set(p.net, (m.get(p.net) ?? 0) + (p.kind === 'track' ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : arcLen(p)));
  }
  return m;
}

function lengths(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'Length');
  const nets = primsByNet(doc), L0 = netLengths(doc);
  let delay = 0, D0: Map<number, number> | undefined;
  for (const [net, idx] of nets) {
    const r = netRule(list, representatives(doc, idx).map((i) => doc.prims[i]!));
    if (r === HELD) { c.held.n++; continue; }
    if (!r) continue;
    if (r.rule.bag.bool('USEDELAYUNITS')) {
      const v = (D0 ??= netDelays(doc)).get(net) ?? 0, min = Number(r.rule.bag.get('MINDELAY') ?? '0') || 0, max = Number(r.rule.bag.get('MAXDELAY') ?? '1e9') || 1e9;
      delay++;
      if (v >= min - 0.01 && v <= max + 0.01) continue;
      push(c, { kind: 'Length', rule: ruleName(r.rule), prims: idx.slice(0, 1), at: firstAt(doc, idx),
        message: `Length Constraint (Min=${min}ps) (Max=${max}ps): Net ${doc.nets[net]?.name ?? net} Signal Delay = ${v.toFixed(3)}ps` });
      continue;
    }
    const v = L0.get(net) ?? 0, min = len(r.rule, 'MINLIMIT', '0mil'), max = len(r.rule, 'MAXLIMIT', '100000mil');
    if (v >= min - T && v <= max + T) continue;
    push(c, { kind: 'Length', rule: ruleName(r.rule), prims: idx.slice(0, 1), at: firstAt(doc, idx),
      message: `Length Constraint (Min=${boardLength(doc, min)}) (Max=${boardLength(doc, max)}): Net ${doc.nets[net]?.name ?? net} Signal Length = ${boardLength(doc, v)}` });
  }
  if (delay) c.notes.push(`Length rules in delay units measured with delays from the layer stack's dielectrics (${delay} net${delay === 1 ? '' : 's'}) [est: a field solver may give slightly different figures]`);
}

function firstAt(doc: PcbDocument, idx: number[]): Vec2 {
  const p = doc.prims[idx[0]!]!;
  return p.kind === 'track' ? p.a : 'at' in p ? p.at : 'c' in p ? p.c : doc.board.origin;
}

/**
 * Matched Lengths: every rule applies (AD ignores priority here). The nets in scope match the
 * longest within the tolerance (Check Others); a pair's two nets each other (Within Pair); pairs
 * match the longest pair, a pair's length its longer net (Pair vs Pair [est]).
 */
function matchedLengths(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'MatchedLengths');
  const nets = primsByNet(doc), L0 = netLengths(doc);
  const pairs = (doc.diffPairs ?? []).map((b) => {
    const pos = doc.nets.findIndex((n) => n.name === b.get('POSITIVENETNAME')), neg = doc.nets.findIndex((n) => n.name === b.get('NEGATIVENETNAME'));
    return { name: b.get('NAME') ?? '', pos, neg };
  }).filter((x) => x.pos >= 0 && x.neg >= 0);
  const inPair = new Set(pairs.flatMap((x) => [x.pos, x.neg]));
  let D0: Map<number, number> | undefined;
  for (const r of list) {
    // In delay units: delays from the stack and the tolerance in ps; else lengths
    const byDelay = r.rule.bag.bool('USEDELAYUNITS');
    const D = byDelay ? (D0 ??= netDelays(doc)) : null;
    const lenOf = (n: number) => (D ? D.get(n) ?? 0 : L0.get(n) ?? 0);
    const tol = byDelay ? Number(r.rule.bag.get('DELAYTOLERANCE') ?? '0') || 0 : len(r.rule, 'TOLERANCE', '1000mil');
    const fmt = (v: number) => (byDelay ? `${v.toFixed(3)}ps` : boardLength(doc, v));
    const slack = byDelay ? 0.01 : T;
    const takes = (n: number) => { const idx = nets.get(n); if (!idx) return false; const v = representatives(doc, idx).map((i) => r.s1(doc.prims[i]!)); if (v.includes(true)) return true; if (v.includes(null)) c.held.n++; return false; };
    const report = (n: number, target: number, other: string, longer: number) => push(c, { kind: 'MatchedLengths', rule: ruleName(r.rule), prims: [...(nets.get(n) ?? []).slice(0, 1), ...(nets.get(longer) ?? []).slice(0, 1)], at: firstAt(doc, nets.get(n) ?? []),
      message: `Matched Lengths Constraint (Tolerance=${fmt(tol)}): Net ${doc.nets[n]?.name ?? n} ${byDelay ? 'Delay' : 'Length'} = ${fmt(lenOf(n))}, ${fmt(target - lenOf(n))} shorter than ${other} (${fmt(target)})` });
    if (r.rule.bag.bool('CHECKOTHERS', true)) {
      const group = [...nets.keys()].filter((n) => !inPair.has(n) && takes(n));
      const longest = group.reduce((m, n) => (lenOf(n) > lenOf(m) ? n : m), group[0] ?? -1);
      if (group.length > 1) for (const n of group) if (lenOf(longest) - lenOf(n) > tol + slack) report(n, lenOf(longest), `Net ${doc.nets[longest]?.name}`, longest);
    }
    const ps = pairs.filter((x) => takes(x.pos) || takes(x.neg));
    if (r.rule.bag.bool('CHECKNETSINDIFFPAIR')) for (const x of ps) {
      const [s, l] = lenOf(x.pos) <= lenOf(x.neg) ? [x.pos, x.neg] : [x.neg, x.pos];
      if (lenOf(l) - lenOf(s) > tol + slack) report(s, lenOf(l), `Net ${doc.nets[l]?.name} of pair ${x.name}`, l);
    }
    if (r.rule.bag.bool('CHECKDIFFPAIRVSDIFFPAIR') && ps.length > 1) {
      const pl = (x: (typeof ps)[number]) => Math.max(lenOf(x.pos), lenOf(x.neg));
      const top = ps.reduce((m, x) => (pl(x) > pl(m) ? x : m), ps[0]!);
      for (const x of ps) if (pl(top) - pl(x) > tol + slack) report(lenOf(x.pos) >= lenOf(x.neg) ? x.pos : x.neg, pl(top), `pair ${top.name}`, lenOf(top.pos) >= lenOf(top.neg) ? top.pos : top.neg);
    }
  }
}

/* ─── SMD Neck-Down, SMD To Corner, Vias Under SMD ──────────────────────────────────── */

/** A part's SMD pads (a wire link's are where a wire is soldered to copper, not a part's: these rules leave them be). */
const smdPads = (doc: PcbDocument) => {
  const wired = wireLinkPads(doc);
  return doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: PcbPad; i: number } => x.p.kind === 'pad' && x.p.hole === 0 && (x.p.layer === L.TOP || x.p.layer === L.BOTTOM) && !wired.has(x.i));
};
const padShape = (p: PcbPad) => padGeom(p, padFace(p, p.layer === L.BOTTOM ? 'bottom' : 'top'));

type PieceBox = BBox & { q: TrackPiece };
const strictlyIn = (g: Geom, v: Vec2) => depthIn(g, v) > 2;

/**
 * SMD Neck-Down, as the suite checks it [est, from its reports]: once for each SMD pad, the widest
 * track (piece) of its net whose copper overlaps it, against the pad's narrower side.
 * SMD To Corner: each piece leaving the pad (one end inside it) whose outer end is a corner (the
 * route turns or branches there, or stops) is measured along itself from the pad's edge to that
 * end; the suite flags a corner nearer than the distance less 1 mil [est: none of its reports
 * flags one at 4.1 mil or more under a 5 mil rule, while it flags 3.9 mil], and says Collision
 * for a corner on the pad's edge.
 */
function smdNeck(c: Ctx, neck: boolean, corner: boolean): void {
  const { doc } = c;
  const necks = neck ? rules(c, 'SMDNeckDown') : [], corners = corner ? rules(c, 'SMDToCorner') : [];
  const pieces = trackPieces(doc);
  const idx = new RBush<PieceBox>(), ends = new RBush<BBox & { q: TrackPiece; v: Vec2 }>();
  idx.load(pieces.map((q) => ({ ...boxOfSeg(q.a, q.b, (doc.prims[q.i] as { width: number }).width / 2), q })));
  ends.load(pieces.flatMap((q) => [q.a, q.b].map((v) => ({ ...boxOfSeg(v, v), q, v }))));
  const trackOf = (q: TrackPiece) => doc.prims[q.i] as Extract<PcbPrim, { kind: 'track' }>;
  for (const { p, i } of smdPads(doc)) {
    const st = padFace(p, p.layer === L.BOTTOM ? 'bottom' : 'top');
    const g = padShape(p);
    if (!g) continue;
    const r0 = Math.max(st.w, st.h);
    const mine = idx.search({ minX: p.at.x - r0, minY: p.at.y - r0, maxX: p.at.x + r0, maxY: p.at.y + r0 }).map((x) => x.q)
      .filter((q) => { const t = trackOf(q); return t.layer === p.layer && t.net === p.net; }).sort((x, y) => x.i - y.i);
    if (!mine.length || (!inSubject(c, i) && !mine.some((q) => inSubject(c, q.i)))) continue;
    if (neck) {
      const r = unaryRule(necks, p);
      if (r === HELD) c.held.n++;
      else if (r) {
        const pct = Number(r.rule.bag.get('PERCENT') ?? '50') || 50;
        const side = Math.min(st.w, st.h);
        // The widest overlapping its copper; of equals, the first track's piece nearest the pad's centre
        const d0 = (q: TrackPiece) => distance({ t: 'circle', c: p.at, r: 0 }, { t: 'seg', a: q.a, b: q.b, r: 0 });
        const over = mine.filter((q) => distance({ t: 'seg', a: q.a, b: q.b, r: trackOf(q).width / 2 }, g) < 0)
          .sort((x, y) => trackOf(y).width - trackOf(x).width || x.i - y.i || d0(x) - d0(y));
        const q = over[0];
        const ratio = q ? (trackOf(q).width / side) * 100 : 0;
        if (q && ratio > pct + 1e-6) push(c, { kind: 'SMDNeckDown', rule: ruleName(r.rule), prims: [i, q.i], at: p.at,
          message: `SMD Neck-Down Constraint: Between ${describe(doc, i)} And ${describePiece(doc, q)} Relative Track Width: ${ratio.toFixed(2)}%` });
      }
    }
    if (corner) {
      const r = unaryRule(corners, p);
      if (r === HELD) { c.held.n++; continue; }
      if (!r) continue;
      const dist = rawLen(r.rule, 'DISTANCE', 0), limit = dist - mil(1);
      const out = padOutline(p, st);
      if (limit <= 0 || !out) continue;
      const seen = new Set<string>();
      for (const q of mine) {
        const ia = strictlyIn(out, q.a), ib = strictlyIn(out, q.b);
        if (ia === ib) continue;
        const [inn, end] = ia ? [q.a, q.b] : [q.b, q.a];
        // A corner: the route stops, branches or turns at the outer end
        const at = ends.search(boxOfSeg(end, end, T)).filter((e) => e.q !== q && Math.hypot(e.v.x - end.x, e.v.y - end.y) <= T && trackOf(e.q).layer === p.layer && trackOf(e.q).net === p.net);
        if (at.length === 1) {
          const o = at[0]!.q, far = o.a === at[0]!.v ? o.b : o.a;
          const ux = end.x - inn.x, uy = end.y - inn.y, vx = far.x - end.x, vy = far.y - end.y;
          if (Math.abs(ux * vy - uy * vx) <= 1e-6 * Math.hypot(ux, uy) * Math.hypot(vx, vy) && ux * vx + uy * vy > 0) continue;
        }
        // Along the piece from the pad's edge to the corner
        let lo = 0, hi = 1;
        for (let k = 0; k < 48; k++) { const m = (lo + hi) / 2; if (strictlyIn(out, { x: inn.x + (end.x - inn.x) * m, y: inn.y + (end.y - inn.y) * m })) lo = m; else hi = m; }
        const d = Math.hypot(end.x - inn.x, end.y - inn.y) * (1 - lo);
        if (d >= limit) continue;
        // A corner on the pad's edge is one collision, named by the first track to it
        const actual = d < T ? 0 : d, key = `${Math.round(end.x / T)},${Math.round(end.y / T)}`;
        if (!actual && seen.has(key)) continue;
        seen.add(key);
        push(c, { kind: 'SMDToCorner', rule: ruleName(r.rule), prims: [i, q.i], at: end,
          message: `SMD To Corner Constraint: (${actual ? boardLength(doc, actual) : 'Collision'} < ${boardLength(doc, dist)}) Between ${describe(doc, i)} And ${describePiece(doc, q)} Actual Distance = ${boardLength(doc, actual)}` });
      }
    }
  }
}

/**
 * Vias Under SMD (Allowed off), as the suite checks it [est, from its reports]: once for each SMD
 * pad, the first via (in the board's order) reaching the pad's layer whose copper there overlaps
 * the pad's.
 */
function viasUnderSmd(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'ViasUnderSMD');
  const stack = doc.board.copperStack;
  const vias = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: Extract<PcbPrim, { kind: 'via' }>; i: number } => x.p.kind === 'via');
  const idx = new RBush<BBox & { i: number; r: number }>();
  idx.load(vias.map(({ p, i }) => { const r = Math.max(p.diameter, ...(p.layerDiameters ?? [])) / 2; return { i, r, ...boxOfSeg(p.at, p.at, r) }; }));
  for (const { p, i } of smdPads(doc)) {
    const g = padShape(p);
    if (!g) continue;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; continue; }
    if (!r || r.rule.bag.bool('ALLOWED')) continue;
    const w = Math.max(p.top.w, p.top.h, p.bot.w, p.bot.h);
    const at = stack.indexOf(p.layer);
    const hit = idx.search({ minX: p.at.x - w, minY: p.at.y - w, maxX: p.at.x + w, maxY: p.at.y + w }).sort((x, y) => x.i - y.i).find((v) => {
      const via = doc.prims[v.i] as Extract<PcbPrim, { kind: 'via' }>;
      const s = stack.indexOf(via.layerStart), e = stack.indexOf(via.layerEnd);
      if (s >= 0 && e >= 0 && at >= 0 && (at < Math.min(s, e) || at > Math.max(s, e))) return false;
      const d = via.layerDiameters?.[p.layer - 1] ?? via.diameter;
      return distance({ t: 'circle', c: via.at, r: Math.max(d, via.hole) / 2 }, g) < 0;
    });
    if (!hit || (!inSubject(c, i) && !inSubject(c, hit.i))) continue;
    const via = doc.prims[hit.i] as Extract<PcbPrim, { kind: 'via' }>;
    push(c, { kind: 'ViasUnderSMD', rule: ruleName(r.rule), prims: [i, hit.i], at: via.at, message: `Vias Under SMD Constraint: Between ${describe(doc, i)} And ${describe(doc, hit.i)}` });
  }
}

/* ─── Routing Via Style, Routing Layers, Differential Pairs Routing ─────────────────── */

/**
 * Routing Via Style: a via's diameter and hole within the rule's limits, as the suite measures them:
 * to the file's unit (0.0001 mil), with no further allowance (its report flags a via 0.0005 mil
 * under the minimum: "Actual Size : 17.716mil"), the latest placed first.
 */
function routingVias(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'RoutingVias');
  const found: number[] = [];
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'via' || !inSubject(c, i)) return;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; return; }
    if (!r) return;
    const minD = len(r.rule, 'MINWIDTH', '50mil'), maxD = len(r.rule, 'MAXWIDTH', '50mil'), minH = len(r.rule, 'MINHOLEWIDTH', '28mil'), maxH = len(r.rule, 'MAXHOLEWIDTH', '28mil');
    if (p.diameter < minD - 1 || p.diameter > maxD + 1 || p.hole < minH - 1 || p.hole > maxH + 1) found.push(i);
  });
  for (const i of found.reverse()) {
    const p = doc.prims[i] as Extract<PcbPrim, { kind: 'via' }>;
    const r = unaryRule(list, p) as Scoped;
    push(c, { kind: 'RoutingVias', rule: ruleName(r.rule), prims: [i], at: p.at, message: `Routing Via Style: ${describe(doc, i)} Actual Size : ${boardLength(doc, p.diameter)} Actual Hole Size : ${boardLength(doc, p.hole)}` });
  }
}

/** The rule's key for a layer ("TOP LAYER_V5", "MID LAYER 3_V5", "BOTTOM LAYER_V5"). */
const routingKey = (l: LayerId) => (l === L.TOP ? 'TOP LAYER_V5' : l === L.BOTTOM ? 'BOTTOM LAYER_V5' : `MID LAYER ${l - L.TOP}_V5`);
function routingLayers(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'RoutingLayers');
  doc.prims.forEach((p, i) => {
    if ((p.kind !== 'track' && p.kind !== 'arc') || !inSubject(c, i) || p.net === NO_NET || inPour(p) || p.keepout || p.layer < L.TOP || p.layer > L.BOTTOM) return;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; return; }
    if (!r) return;
    const v = r.rule.bag.get(routingKey(p.layer));
    if (v === undefined || v.toUpperCase() !== 'FALSE') return;
    push(c, { kind: 'RoutingLayers', rule: ruleName(r.rule), prims: [i], at: p.kind === 'track' ? p.a : p.c, message: `Routing Layers Constraint: ${describe(doc, i)} on a layer not allowed for routing` });
  });
}

/** Differential Pairs Routing: the pair's tracks within the rule's widths on their layer (the gap is the Clearance rule's, as in AD). */
function diffPairWidths(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'DiffPairsRouting');
  const inPair = new Set<number>();
  for (const b of doc.diffPairs ?? []) for (const k of ['POSITIVENETNAME', 'NEGATIVENETNAME']) { const n = doc.nets.findIndex((x) => x.name === b.get(k)); if (n >= 0) inPair.add(n); }
  if (!inPair.size) return;
  doc.prims.forEach((p, i) => {
    if ((p.kind !== 'track' && p.kind !== 'arc') || !inSubject(c, i) || !inPair.has(p.net) || inPour(p) || !isSignal(p.layer)) return;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; return; }
    if (!r) return;
    const { min, max } = widthLimits(r.rule, p.layer);
    if (p.width >= min - T && p.width <= max + T) return;
    push(c, { kind: 'DiffPairsRouting', rule: ruleName(r.rule), prims: [i], at: p.kind === 'track' ? p.a : p.c,
      message: `Differential Pairs Routing Constraint (Min Width=${boardLength(doc, min)}) (Max Width=${boardLength(doc, max)}): ${describe(doc, i)} Actual Width = ${boardLength(doc, p.width)}` });
  });
}

/* ─── Solder mask and silkscreen ─────────────────────────────────────────────────────── */

interface Opening { i: number; side: 'top' | 'bottom'; g: Geom; box: BBox; copper: Geom | null }

function grow(g: Geom, by: number): Geom | null {
  if (g.t === 'circle') return g.r + by > 0 ? { ...g, r: g.r + by } : null;
  if (g.t === 'seg') return g.r + by > 0 ? { ...g, r: g.r + by } : null;
  if (by === 0) return g;
  // A polygon grown as its box (pads are convex; enough for mask openings [est])
  const b = boxOfPts(g.pts);
  const w = b.maxX - b.minX + 2 * by, h = b.maxY - b.minY + 2 * by;
  if (w <= 0 || h <= 0) return null;
  // Keep the shape's own orientation: offset each corner along its bisector
  if (g.pts.length >= 3) return { t: 'poly', pts: offsetConvex(g.pts, by), holes: [] };
  return { t: 'poly', pts: rectPoly({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, w, h, 0), holes: [] };
}
function boxOfPts(pts: Vec2[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}
/** A convex polygon's outline moved out by d (corners sharp). */
function offsetConvex(pts: Vec2[], d: number): Vec2[] {
  const n = pts.length;
  let area = 0;
  for (let k = 0; k < n; k++) { const a = pts[k]!, b = pts[(k + 1) % n]!; area += a.x * b.y - b.x * a.y; }
  const s = area > 0 ? 1 : -1;
  const lines = pts.map((a, k) => {
    const b = pts[(k + 1) % n]!, dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    const nx = (s * dy) / l, ny = (-s * dx) / l;
    return { a: { x: a.x + nx * d, y: a.y + ny * d }, dx, dy };
  });
  return lines.map((l1, k) => {
    const l0 = lines[(k + n - 1) % n]!;
    const den = l0.dx * l1.dy - l0.dy * l1.dx;
    if (Math.abs(den) < 1e-9) return l1.a;
    const t = ((l1.a.x - l0.a.x) * l1.dy - (l1.a.y - l0.a.y) * l1.dx) / den;
    return { x: l0.a.x + l0.dx * t, y: l0.a.y + l0.dy * t };
  });
}
function geomBox(g: Geom): BBox {
  if (g.t === 'circle') return { minX: g.c.x - g.r, minY: g.c.y - g.r, maxX: g.c.x + g.r, maxY: g.c.y + g.r };
  if (g.t === 'seg') return { minX: Math.min(g.a.x, g.b.x) - g.r, minY: Math.min(g.a.y, g.b.y) - g.r, maxX: Math.max(g.a.x, g.b.x) + g.r, maxY: Math.max(g.a.y, g.b.y) + g.r };
  return boxOfPts(g.pts);
}

/** The pad's copper on its top or bottom face: a single-layer pad's own shape (the top's, as it is drawn and plotted), a through pad's by its stack (a Simple one the top's on both). */
export const padFace = (p: PcbPad, side: 'top' | 'bottom') => (p.layer === L.MULTI ? padLayer(p, side === 'top' ? L.TOP : L.BOTTOM) : p.top);

const openingCache = new WeakMap<readonly PcbPrim[], WeakMap<readonly PcbRule[], Opening[]>>();
/**
 * Solder mask openings, as the Gerber's solder mask has them: pads and vias grown by their mask
 * expansion (their own, else the Solder Mask Expansion rule's; none where tented), from the hole's
 * edge where a pad or via says so, and objects drawn on the solder mask layers themselves.
 * `copper`: a pad's copper the opening exposes (all of it, or the opening where that is smaller).
 */
export function maskOpenings(doc: PcbDocument): Opening[] {
  // Once per state of the board and of its rules (the expansions are the rules')
  let byRules = openingCache.get(doc.prims);
  const hit = byRules?.get(doc.rules);
  if (hit) return hit;
  const out: Opening[] = [];
  const add = (i: number, side: 'top' | 'bottom', g: Geom | null, copper: Geom | null) => { if (g) out.push({ i, side, g, box: geomBox(g), copper }); };
  const fromHoleEdge = (p: PcbPad | Extract<PcbPrim, { kind: 'via' }>) => { const rec = p.hole > 0 ? doc.streams.get(p.src.storage)?.records[p.src.index] : undefined; return !!rec && !!padExtrasOf(rec).fromHoleEdge; };
  doc.prims.forEach((p, i) => {
    if (p.kind === 'pad') {
      for (const side of ['top', 'bottom'] as const) {
        const onSide = p.layer === L.MULTI || (side === 'top' ? p.layer === L.TOP : p.layer === L.BOTTOM);
        if (!onSide) continue;
        const e = solderMask(doc, p, side === 'top');
        if (e === null) continue;
        const st = padFace(p, side), cu = padGeom(p, st);
        if (!cu) continue;
        if (p.layer === L.MULTI && fromHoleEdge(p)) {
          // Solder Mask From The Hole Edge: the hole (a slot's capsule) grown by the expansion
          const ends = slotEnds(p), r = p.hole / 2 + e;
          const g: Geom | null = r <= 0 ? null : ends ? { t: 'seg', a: ends[0], b: ends[1], r } : { t: 'circle', c: p.at, r };
          add(i, side, g, g && 2 * r < Math.min(st.w, st.h) ? g : cu);
          continue;
        }
        // A negative expansion no more than closes the opening (as the Gerber plots it)
        const g = grow(cu, Math.max(e, -Math.min(st.w, st.h) / 2));
        add(i, side, g, e < 0 ? g : cu);
      }
    } else if (p.kind === 'via') {
      for (const side of ['top', 'bottom'] as const) {
        if (side === 'top' ? p.layerStart !== L.TOP && p.layerEnd !== L.TOP : p.layerStart !== L.BOTTOM && p.layerEnd !== L.BOTTOM) continue;
        const e = solderMask(doc, p, side === 'top');
        if (e === null) continue;
        const cu: Geom = { t: 'circle', c: p.at, r: p.diameter / 2 };
        add(i, side, fromHoleEdge(p) ? grow({ t: 'circle', c: p.at, r: p.hole / 2 }, e) : grow(cu, e), null);
      }
    } else if (p.layer === L.TOP_SOLDER || p.layer === L.BOTTOM_SOLDER) {
      const side = p.layer === L.TOP_SOLDER ? 'top' : 'bottom';
      const g = layerGeom(p, doc);
      if (g) for (const x of g) add(i, side, x, null);
    }
  });
  if (!byRules) { byRules = new WeakMap(); openingCache.set(doc.prims, byRules); }
  byRules.set(doc.rules, out);
  return out;
}

/**
 * A primitive's outline as shapes (tracks, arcs, fills, regions; text by its strokes). A track's
 * or arc's half width in whole units [est: AD's reports, 8.662 mil where half an odd width gives
 * 8.66145]; an arc in chords within 0.0005 mil of it.
 */
function layerGeom(p: PcbPrim, doc?: PcbDocument): Geom[] | null {
  switch (p.kind) {
    case 'track': return [{ t: 'seg', a: p.a, b: p.b, r: Math.floor(p.width / 2) }];
    case 'arc': {
      const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360;
      const pts = arcPoints(p.c, p.r, p.r, p.start, p.start + sweep, arcChords(p.r, sweep, 5));
      return pts.slice(1).map((b, k) => ({ t: 'seg' as const, a: pts[k]!, b, r: Math.floor(p.width / 2) }));
    }
    case 'fill': return [{ t: 'poly', pts: rectPoly({ x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, Math.abs(p.b.x - p.a.x), Math.abs(p.b.y - p.a.y), p.rotation), holes: [] }];
    case 'region': return p.outline.length >= 3 ? [{ t: 'poly', pts: p.outline, holes: p.holes }] : null;
    case 'text': return textStrokes(p, doc);
    default: return null;
  }
}

/** Whether a stroke text is in AD's Default stroke font (its record's font 1; 2 and 3 are Sans Serif and Serif), as a text without its record is taken to be. */
function defaultStrokeFont(p: PcbText, doc?: PcbDocument): boolean {
  if (p.fontType !== 0) return false;
  const sub = doc?.streams.get(p.src.storage)?.records[p.src.index]?.subs[0];
  const font = sub ? getField(sub, TEXT.font) : undefined;
  return font === undefined || font <= 1;
}
/** A stroke text drawn in the grid font AD's DRC measures (gridStrokeText): one in the Default font whose characters all have a glyph there. */
const inGridFont = (p: PcbText, doc?: PcbDocument) => defaultStrokeFont(p, doc) && gridCovers(p.text);

/**
 * How far a text's strokes (textStrokes) may lie off AD's own: none for the Default stroke font's
 * grid glyphs and for a barcode's box; else Konium's stroke font, a tenth of the height (a
 * TrueType text drawn in it, a fifth) [est].
 */
export function textSlack(p: PcbText, doc?: PcbDocument): number {
  if (p.fontType === 2 || inGridFont(p, doc)) return 0;
  return strokeCapHeight(p) / (p.fontType === 1 ? 5 : 10);
}

/**
 * A text as AD's DRC measures it: its strokes at their width, the Default stroke font's in its
 * grid glyphs (strokeGrid.ts), others in Konium's stroke font (TrueType text too [est], within
 * textSlack); a barcode by its box; a hidden designator or comment isn't there.
 */
export function textStrokes(p: PcbText, doc?: PcbDocument): Geom[] | null {
  if (p.hidden || !p.text.trim()) return null;
  if (p.fontType === 2 && p.barcode) return [{ t: 'poly', pts: barcodeShape(p.text, p.at, p.rotation, p.mirrored, p.height, p.barcode).box, holes: [] }];
  const ch = strokeCapHeight(p);
  const w = p.fontType === 1 ? Math.max(ch / 10, 1) : p.strokeWidth || p.height / 10;
  const out: Geom[] = [];
  const grid = inGridFont(p, doc) ? gridStrokeText(p.text, p.at, p.height, p.rotation, p.mirrored) : null;
  for (const pl of grid ?? strokeText(p.text, p.at, ch, p.rotation, p.mirrored)) {
    if (pl.length === 1) out.push({ t: 'circle', c: pl[0]!, r: w / 2 });
    for (let k = 1; k < pl.length; k++) out.push({ t: 'seg', a: pl[k - 1]!, b: pl[k]!, r: w / 2 });
  }
  return out.length ? out : null;
}

/** A text's box on its layer: the strokes' extent with the stroke width. */
export function textBox(p: PcbText): Geom | null {
  if (p.hidden || !p.text.trim()) return null;
  const ch = strokeCapHeight(p);
  const w = p.fontType === 1 ? Math.max(ch / 10, 1) : p.strokeWidth || p.height / 10;
  const lines = strokeText(p.text, p.at, ch, p.rotation, p.mirrored);
  const pts = lines.flat();
  if (!pts.length) return null;
  const b = boxOfPts(pts);
  return { t: 'poly', pts: [{ x: b.minX - w / 2, y: b.minY - w / 2 }, { x: b.maxX + w / 2, y: b.minY - w / 2 }, { x: b.maxX + w / 2, y: b.maxY + w / 2 }, { x: b.minX - w / 2, y: b.maxY + w / 2 }], holes: [] };
}

/**
 * Minimum Solder Mask Sliver: two objects' openings on one side closer than the width (touching
 * ones merge), unless where the sliver lies is opened by a third: a via's opening over two pads'
 * ends, an exposed pad's over the inner ends of the pads round it [est: AD's reports, which check
 * the sliver at one spot, sliverSpot]. A pair with slivers on both sides is one violation naming
 * both, as AD reports it.
 */
function maskSlivers(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'MinimumSolderMaskSliver');
  const all = maskOpenings(doc);
  const max = Math.max(0, ...list.map((r) => len(r.rule, 'MINSOLDERMASKWIDTH', '10mil')));
  if (max <= 0) return;
  const idx = new RBush<BBox & { o: Opening }>();
  idx.load(all.map((o) => ({ ...o.box, o })));
  const opened = (at: Vec2, side: string, a: number, b: number) =>
    idx.search({ minX: at.x, minY: at.y, maxX: at.x, maxY: at.y }).some(({ o }) => o.side === side && o.i !== a && o.i !== b && inside(o.g, at));
  type Side = 'top' | 'bottom';
  interface Pair { lo: number; hi: number; rule: PcbRule; w: number; d: Partial<Record<Side, number>>; g?: [Geom, Geom] }
  const pairs = new Map<string, Pair | null>();
  for (const a of all) {
    if (!inSubject(c, a.i)) continue;
    for (const { o: b } of idx.search({ minX: a.box.minX - max, minY: a.box.minY - max, maxX: a.box.maxX + max, maxY: a.box.maxY + max })) {
      if (b.i === a.i || b.side !== a.side) continue;
      const key = `${Math.min(a.i, b.i)}:${Math.max(a.i, b.i)}`;
      let p = pairs.get(key);
      if (p === null) continue;
      if (!p) {
        const r = pairRuleUnary(list, doc.prims[a.i]!, doc.prims[b.i]!);
        if (r === HELD) c.held.n++;
        if (!r || r === HELD) { pairs.set(key, null); continue; }
        p = { lo: Math.min(a.i, b.i), hi: Math.max(a.i, b.i), rule: r.rule, w: len(r.rule, 'MINSOLDERMASKWIDTH', '10mil'), d: {} };
        pairs.set(key, p);
      }
      const d = distance(a.g, b.g, p.w + T);
      if (d <= T || d >= p.w - T || d >= (p.d[a.side] ?? Infinity)) continue;
      if (opened(sliverSpot(a.g, b.g), a.side, a.i, b.i)) continue;
      p.d[a.side] = d; p.g = [a.g, b.g];
    }
  }
  for (const p of pairs.values()) {
    if (!p) continue;
    const sides = (['top', 'bottom'] as const).filter((s) => p.d[s] !== undefined);
    if (!sides.length) continue;
    const d = Math.min(...sides.map((s) => p.d[s]!));
    const each = sides.map((s) => `[${s === 'top' ? 'Top' : 'Bottom'} Solder] Mask Sliver [${boardLength(doc, p.d[s]!)}]`).join(' / ');
    push(c, { kind: 'MinimumSolderMaskSliver', rule: ruleName(p.rule), prims: [p.lo, p.hi], at: midOf(p.g![0], p.g![1]),
      message: `Minimum Solder Mask Sliver Constraint: (${boardLength(doc, d)} < ${boardLength(doc, p.w)}) Between ${describe(doc, p.lo)} And ${describe(doc, p.hi)} ${each}` });
  }
}
/** A shape as its skeleton (a circle's centre, a track's ends, a polygon's corners) and how far its edge lies off it. */
function skeleton(g: Geom): { pts: Vec2[]; closed: boolean; r: number } {
  if (g.t === 'circle') return { pts: [g.c], closed: false, r: g.r };
  if (g.t === 'seg') return { pts: [g.a, g.b], closed: false, r: g.r };
  return { pts: g.pts, closed: true, r: 0 };
}
function nearestOnSeg(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}
/**
 * Where AD's sliver check looks at the sliver between two openings [est: its reports]: the middle
 * of their closest approach, and of equally close ones (two parallel edges) the one furthest left,
 * then lowest.
 */
function sliverSpot(a: Geom, b: Geom): Vec2 {
  const A = skeleton(a), B = skeleton(b);
  const sides = (s: ReturnType<typeof skeleton>): [Vec2, Vec2][] => {
    const n = s.pts.length;
    if (n === 1) return [[s.pts[0]!, s.pts[0]!]];
    return s.pts.slice(0, s.closed ? n : n - 1).map((p, k) => [p, s.pts[(k + 1) % n]!]);
  };
  const pairs: { p: Vec2; q: Vec2; d: number }[] = [];
  for (const p of A.pts) for (const [u, v] of sides(B)) { const q = nearestOnSeg(p, u, v); pairs.push({ p, q, d: Math.hypot(q.x - p.x, q.y - p.y) }); }
  for (const q of B.pts) for (const [u, v] of sides(A)) { const p = nearestOnSeg(q, u, v); pairs.push({ p, q, d: Math.hypot(q.x - p.x, q.y - p.y) }); }
  const least = Math.min(...pairs.map((x) => x.d));
  let best: Vec2 | undefined;
  for (const { p, q, d } of pairs) {
    if (d > least + 1) continue;
    // Halfway across the gap between the edges, from A's skeleton
    const t = d > 0 ? (A.r + (d - A.r - B.r) / 2) / d : 0;
    const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
    if (!best || m.x < best.x - 1 || (m.x <= best.x + 1 && m.y < best.y)) best = m;
  }
  return best!;
}
/** Whether a point lies inside a shape. */
function inside(g: Geom, p: Vec2): boolean {
  if (g.t === 'circle') return Math.hypot(p.x - g.c.x, p.y - g.c.y) < g.r;
  if (g.t === 'seg') { const q = nearestOnSeg(p, g.a, g.b); return Math.hypot(p.x - q.x, p.y - q.y) < g.r; }
  return pointInPoly(p, g.pts) && !g.holes.some((h) => pointInPoly(p, h));
}
function pairRuleUnary(list: Scoped[], a: PcbPrim, b: PcbPrim): Pick {
  for (const r of list) {
    const m = and3(r.s1(a), r.s2(b)), n = and3(r.s1(b), r.s2(a));
    if (m === true || n === true) return r;
    if (m === null || n === null) return HELD;
  }
  return undefined;
}
function midOf(a: Geom, b: Geom): Vec2 {
  const ba = geomBox(a), bb = geomBox(b);
  return { x: ((ba.minX + ba.maxX) / 2 + (bb.minX + bb.maxX) / 2) / 2, y: ((ba.minY + ba.maxY) / 2 + (bb.minY + bb.maxY) / 2) / 2 };
}

/** `tol`: how far the shape may be off AD's own (a text's textSlack: none in the Default stroke font's glyphs); `arc`: an arc's own (its shapes are chords). */
interface Silk { i: number; side: 'top' | 'bottom'; g: Geom[]; box: BBox; text: boolean; component: number; tol: number; arc?: { c: Vec2; r: number; start: number; sweep: number; half: number } }
const silkCache = new WeakMap<readonly PcbPrim[], Silk[]>();
/** Silkscreen objects on the overlays (hidden designators and comments aside). */
function silks(doc: PcbDocument): Silk[] {
  const hit = silkCache.get(doc.prims);
  if (hit) return hit;
  const out: Silk[] = [];
  doc.prims.forEach((p, i) => {
    if (p.kind === 'body' || p.kind === 'via' || p.kind === 'pad') return;
    if (p.layer !== L.TOP_OVERLAY && p.layer !== L.BOTTOM_OVERLAY) return;
    const g = layerGeom(p, doc);
    if (!g?.length) return;
    const box = g.map(geomBox).reduce((a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) }));
    const arc = p.kind === 'arc' ? { c: p.c, r: p.r, start: p.start, sweep: ((p.end - p.start) % 360 + 360) % 360 || 360, half: Math.floor(p.width / 2) } : undefined;
    out.push({ i, side: p.layer === L.TOP_OVERLAY ? 'top' : 'bottom', g, box, text: p.kind === 'text', component: 'component' in p ? p.component : NO_NET, tol: p.kind === 'text' ? textSlack(p, doc) : 0, arc });
  });
  silkCache.set(doc.prims, out);
  return out;
}
const minDist = (a: Geom[], b: Geom[], cap: number) => { let d = cap; for (const x of a) for (const y of b) { d = Math.min(d, distance(x, y, d)); if (d <= 0) return d; } return d; };
/** How far silkscreen is from shapes; an arc's own distance, not its chords' (they lie inside it): the angle searched round the nearest chord. */
function silkDist(s: Silk, other: Geom[], cap: number): number {
  const d = minDist(s.g, other, cap), a = s.arc;
  if (!a || d >= cap || d <= 0) return d;
  const disc = (deg: number): Geom => ({ t: 'circle', c: { x: a.c.x + a.r * Math.cos((deg * Math.PI) / 180), y: a.c.y + a.r * Math.sin((deg * Math.PI) / 180) }, r: a.half });
  const f = (deg: number) => minDist([disc(deg)], other, Infinity);
  let k = 0, least = Infinity;
  s.g.forEach((g, j) => { const e = minDist([g], other, cap); if (e < least) { least = e; k = j; } });
  // A chord either side of it (a whole circle's round its seam)
  const step = a.sweep / s.g.length, whole = a.sweep >= 360;
  let lo = a.start + (k - 1) * step, hi = a.start + (k + 2) * step;
  if (!whole) { lo = Math.max(a.start, lo); hi = Math.min(a.start + a.sweep, hi); }
  const ends = Math.min(f(lo), f(hi));
  for (let n = 0; n < 48; n++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (f(m1) <= f(m2)) hi = m2; else lo = m1; }
  return Math.min(ends, f((lo + hi) / 2));
}

/**
 * Silk To Solder Mask Clearance: silkscreen against the solder mask openings on its side (pads and
 * vias with their mask expansion, what's drawn on the mask layer), or — Check Clearance To Exposed
 * Copper, AD's default — against the pads' copper those openings bare.
 */
function silkToMask(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'SilkToSolderMaskClearance');
  const max = Math.max(0, ...list.map((r) => len(r.rule, 'MINSILKSCREENTOMASKGAP', '10mil')));
  if (max <= 0) return;
  const openings = maskOpenings(doc);
  const idx = new RBush<BBox & { o: Opening }>();
  idx.load(openings.map((o) => ({ ...o.box, o })));
  for (const s of silks(doc)) {
    for (const { o } of idx.search({ minX: s.box.minX - max, minY: s.box.minY - max, maxX: s.box.maxX + max, maxY: s.box.maxY + max })) {
      if (o.side !== s.side || (!inSubject(c, s.i) && !inSubject(c, o.i))) continue;
      const r = pairRuleUnary(list, doc.prims[o.i]!, doc.prims[s.i]!);
      if (r === HELD) { c.held.n++; continue; }
      if (!r) continue;
      const gap = len(r.rule, 'MINSILKSCREENTOMASKGAP', '10mil');
      // Check Clearance To Exposed Copper: pads' copper bared by their openings only (not a via's, nor what's drawn on the mask layers)
      const exposed = r.rule.bag.bool('CLEARANCETOEXPOSEDCOPPER');
      if (exposed && !o.copper) continue;
      const target = exposed ? o.copper! : o.g;
      const d = silkDist(s, [target], gap + s.tol + T);
      if (d + s.tol >= gap - T) continue;
      // Worded as AD's report words it: the silkscreen object first
      const layer = s.side === 'top' ? 'Top' : 'Bottom', near = d <= T ? 0 : d;
      push(c, { kind: 'SilkToSolderMaskClearance', rule: ruleName(r.rule), prims: [o.i, s.i], at: midOf(s.g[0]!, target),
        message: `Silk To Solder Mask Clearance Constraint: (${near ? boardLength(doc, near) : 'Collision'} < ${boardLength(doc, gap)}) Between ${describe(doc, s.i)} And ${describe(doc, o.i)} [${layer} Overlay] to [${layer} Solder] clearance [${boardLength(doc, near)}]` });
    }
  }
}

/** Silk To Silk Clearance: silkscreen text against any other silkscreen object on its side. */
function silkToSilk(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'SilkToSilkClearance');
  const max = Math.max(0, ...list.map((r) => len(r.rule, 'SILKTOSILKCLEARANCE', '10mil')));
  if (max <= 0) return;
  const all = silks(doc);
  const idx = new RBush<BBox & { s: Silk }>();
  idx.load(all.map((s) => ({ ...s.box, s })));
  const seen = new Set<string>();
  for (const a of all) {
    if (!a.text) continue;
    for (const { s: b } of idx.search({ minX: a.box.minX - max, minY: a.box.minY - max, maxX: a.box.maxX + max, maxY: a.box.maxY + max })) {
      if (b.i === a.i || b.side !== a.side || (!inSubject(c, a.i) && !inSubject(c, b.i))) continue;
      const key = `${Math.min(a.i, b.i)}:${Math.max(a.i, b.i)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = pairRuleUnary(list, doc.prims[a.i]!, doc.prims[b.i]!);
      if (r === HELD) { c.held.n++; continue; }
      if (!r) continue;
      const gap = len(r.rule, 'SILKTOSILKCLEARANCE', '10mil');
      const d = silkDist(b, a.g, gap + a.tol + b.tol + T);
      if (d + a.tol + b.tol >= gap - T) continue;
      // Worded as AD's report words it: the text first (of two texts, the earlier in the file)
      const [x, y] = b.text && b.i < a.i ? [b, a] : [a, b], near = d <= T ? 0 : d;
      push(c, { kind: 'SilkToSilkClearance', rule: ruleName(r.rule), prims: [a.i, b.i], at: midOf(a.g[0]!, b.g[0]!),
        message: `Silk To Silk Clearance Constraint: (${near ? boardLength(doc, near) : 'Collision'} < ${boardLength(doc, gap)}) Between ${describe(doc, x.i)} And ${describe(doc, y.i)} Silk Text to Silk Clearance [${boardLength(doc, near)}]` });
    }
  }
}

/** Silk To Board Region Clearance: silkscreen outside the board shape or over a cutout. */
function silkToBoard(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'SilkToBoardRegionClearance');
  const outline = doc.board.outline;
  if (outline.length < 3) return;
  const cutouts = doc.prims.flatMap((q) => (q.kind === 'region' && q.boardCutout && q.outline.length >= 3 ? [q.outline] : []));
  const sides = edges({ pts: outline, holes: cutouts }).map(([a, b]) => ({ t: 'seg' as const, a, b, r: 0 }));
  for (const s of silks(doc)) {
    const p = doc.prims[s.i]!;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; continue; }
    if (!r) continue;
    const gap = len(r.rule, 'GAP', '0mil');
    const pts = s.g.flatMap((g) => (g.t === 'circle' ? [g.c] : g.t === 'seg' ? [g.a, g.b] : g.pts));
    const out = pts.some((q) => !pointInPoly(q, outline) || cutouts.some((h) => pointInPoly(q, h)));
    const near = gap > 0 && minDist(s.g, sides, gap + s.tol + T) + s.tol < gap - T;
    const cross = !out && minDist(s.g, sides, T) + s.tol <= 0;
    if (!out && !near && !cross) continue;
    push(c, { kind: 'SilkToBoardRegionClearance', rule: ruleName(r.rule), prims: [s.i], at: pts[0]!,
      message: `Silk To Board Region Clearance (Out of Silk Screen Region): ${describe(doc, s.i)}` });
  }
}

/* ─── Component Clearance ────────────────────────────────────────────────────────────── */

/**
 * Component Clearance between components' 3D bodies: their outlines closer than the horizontal
 * gap where their heights overlap (or come within the vertical gap). Components without a 3D
 * body aren't checked [est: AD's "Do not check components without 3D body"]; a negative gap
 * turns the check off; a part wholly under another's STEP model (a shield can) is passed over.
 */
function componentClearance(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'ComponentClearance', true);
  interface Box extends BBox { comp: number; g: Geom; z0: number; z1: number; bottom: boolean; step: boolean; pts: Vec2[] }
  const bodies: Box[] = [];
  const by = byComponent(doc);
  for (const [comp, idx] of by) for (const i of idx) {
    const p = doc.prims[i]!;
    if (p.kind !== 'body' || p.outline.length < 3) continue;
    bodies.push({ comp, g: { t: 'poly', pts: p.outline, holes: [] }, z0: p.standoff, z1: p.overall, bottom: p.bottom, step: p.modelType === 1, pts: p.outline, ...boxOfPts(p.outline) });
  }
  if (!bodies.length) return;
  const max = Math.max(0, ...list.map((r) => len(r.rule, 'GAP', '10mil')));
  const idx = new RBush<Box>(); idx.load(bodies);
  const seen = new Set<string>();
  for (const a of bodies) for (const b of idx.search({ minX: a.minX - max, minY: a.minY - max, maxX: a.maxX + max, maxY: a.maxY + max })) {
    if (b.comp <= a.comp || a.bottom !== b.bottom) continue;
    const key = `${a.comp}:${b.comp}`;
    if (seen.has(key)) continue;
    const pa = representatives(doc, by.get(a.comp)!).map((i) => doc.prims[i]!), pb = representatives(doc, by.get(b.comp)!).map((i) => doc.prims[i]!);
    let r: Pick;
    for (const x of list) {
      const m = (s: (p: PcbPrim) => boolean | null, ps: PcbPrim[]) => { const v = ps.map(s); return v.includes(true) ? true : v.includes(null) ? null : false; };
      const t = and3(m(x.s1, pa), m(x.s2, pb)), u = and3(m(x.s1, pb), m(x.s2, pa));
      if (t === true || u === true) { r = x; break; }
      if (t === null || u === null) { r = HELD; break; }
    }
    if (r === HELD) { c.held.n++; continue; }
    if (!r) continue;
    const gap = len(r.rule, 'GAP', '10mil'), vgap = len(r.rule, 'VERTICALGAP', '10mil');
    if (gap < 0) continue;
    // A part wholly under another's STEP model is inside a shield can or a housing: the model is
    // hollow there, which its outline doesn't show [est: AD measures the model's own shape]
    const inside = (o: Box, i: Box) => o.step && i.pts.every((q) => pointInPoly(q, o.pts));
    if (inside(a, b) || inside(b, a)) continue;
    const zApart = Math.max(a.z0 - b.z1, b.z0 - a.z1);
    if (zApart >= vgap - T) continue;
    const d = distance(a.g, b.g, gap + T);
    if (d >= gap - T) continue;
    seen.add(key);
    const ca = doc.components[a.comp]!, cb = doc.components[b.comp]!;
    push(c, { kind: 'ComponentClearance', rule: ruleName(r.rule), prims: [by.get(a.comp)![0]!, by.get(b.comp)![0]!], at: ca.at,
      message: `Component Clearance Constraint ( Horizontal Gap = ${boardLength(doc, gap)}, Vertical Gap = ${boardLength(doc, vgap)} ) Between Component ${ca.designator}-${ca.pattern} And Component ${cb.designator}-${cb.pattern}${d <= T ? '' : ` (${boardLength(doc, d)})`}` });
  }
}

/* ─── Report Options: drilled SMT pads, multilayer pads with no hole ────────────────── */

/**
 * The Design Rule Checker's Report Options past the pads: Verify Shorting Copper (a net tie's own
 * copper joins its nets), Report Broken Planes (a net's plane copper on a layer in pieces that each
 * carry its connections), Report Dead Copper larger than (pieces of a plane or a pour cut off from
 * their net), Report Starved Thermals
 * (relief connections with less than the given share of their conductors left). Broken planes
 * and dead copper only with Un-Routed Net checked, as in AD. A pour's dead copper and a net tie's
 * are warnings; a plane's isolated copper is an Un-Routed Net violation and a starved thermal a
 * Power Plane Connect one, as AD17 lists them.
 */
export function reportOptions(doc: PcbDocument, kinds: Set<string>, out: DrcViolation[]): void {
  const o = drcSettings(doc);
  const warn: Warn = (kind, rule, prims, at, message) => out.push({ kind, rule, error: false, prims, at, message });
  const routed = kinds.has('UnRoutedNet');
  const dead = routed && o.deadCopper ? o.deadArea * 1e8 : null;
  if (o.shorting) shortingCopper(doc, warn);
  if (dead !== null) deadCopper(doc, dead, warn);
  // Starved thermals whether or not Power Plane Connect is among the rules to check [checked: AD17 listed them with it left out]
  planeReports(doc, { broken: routed && o.brokenPlanes, dead, starved: o.starved ? o.starvedPct : null }, out);
}
type Warn = (kind: string, rule: string, prims: number[], at: Vec2, message: string) => void;

/** A net tie's pads of different nets should be joined by the tie's own copper. */
function shortingCopper(doc: PcbDocument, warn: Warn): void {
  const by = byComponent(doc);
  const tree = boardIndex(doc);
  for (const [comp, idx] of by) {
    const k = doc.components[comp]?.bag.int('COMPONENTKIND') ?? 0;
    if (k !== 3 && k !== 4) continue;
    const pads = idx.filter((i) => doc.prims[i]!.kind === 'pad' && (doc.prims[i] as PcbPad).net !== NO_NET);
    if (new Set(pads.map((i) => (doc.prims[i] as PcbPad).net)).size < 2) continue;
    // The tie's own copper, joined where it touches on a layer
    const own = new Set(idx);
    const parent = new Map<number, number>();
    const find = (x: number): number => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!; return x; };
    for (const i of idx) for (const sh of copperOf(tree, i)) for (const o of tree.search(sh)) {
      if (o.prim === i || !own.has(o.prim) || o.layer !== sh.layer || o.role || sh.role) continue;
      if (distance(sh.g, o.g, 2 * T) <= T) { const a = find(i), z = find(o.prim); if (a !== z) parent.set(a, z); }
    }
    if (new Set(pads.map(find)).size <= 1) continue;
    const c = doc.components[comp]!;
    warn('ShortingCopper', 'Verify Shorting Copper', pads.slice(0, 2), c.at, `Net Tie ${c.designator}: its shorting copper doesn't join its nets (${[...new Set(pads.map((i) => doc.nets[(doc.prims[i] as PcbPad).net]?.name))].join(', ')})`);
  }
}

function polyArea(pts: Vec2[]): number { let a = 0; for (let k = 0; k < pts.length; k++) { const p = pts[k]!, q = pts[(k + 1) % pts.length]!; a += p.x * q.y - q.x * p.y; } return Math.abs(a) / 2; }

/** Copper area of a primitive's copper on one layer (round ends counted once). */
function copperArea(p: PcbPrim): number {
  switch (p.kind) {
    case 'track': return Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) * p.width + (Math.PI * p.width * p.width) / 4;
    case 'arc': return arcLen(p) * p.width;
    case 'fill': return Math.abs(p.b.x - p.a.x) * Math.abs(p.b.y - p.a.y);
    case 'region': return polyArea(p.outline) - p.holes.reduce((s, h) => s + polyArea(h), 0);
    default: return 0;
  }
}
const at0 = (p: PcbPrim): Vec2 => ('a' in p ? p.a : 'c' in p ? p.c : 'at' in p ? p.at : 'outline' in p && p.outline.length ? p.outline[0]! : { x: 0, y: 0 });

/**
 * Dead copper on the signal layers: a pour's islands joined to none of its net's pads, larger than
 * the area (internal units squared: 1e10 is 100 sq mil). AD's dead copper is copper cut off from
 * its parent (a pour, a plane); free tracks and fills joined to nothing are the Net Antennae and
 * Un-Routed Net rules' business. Objects on no net, which AD also reports by its advanced setting
 * PCB.Rules.DeadCopperNoNet, aren't [est].
 */
function deadCopper(doc: PcbDocument, minArea: number, warn: Warn): void {
  const find = copperIslands(doc);
  const islands = new Map<number, { prims: number[]; joined: boolean; area: number }>();
  doc.prims.forEach((p, i) => {
    if (!('net' in p) || p.net === NO_NET) return;
    if (p.kind !== 'pad' && p.kind !== 'via' && (p.keepout || !isSignal(p.layer))) return;
    if (p.kind === 'region' && (p.boardCutout || p.regionKind !== 0)) return;
    const k = find(i);
    const e = islands.get(k) ?? { prims: [], joined: false, area: 0 };
    // Anything but a pour's own copper joins it to its net (a pad, a track, a via)
    if (inPour(p)) { e.prims.push(i); e.area += copperArea(p); } else e.joined = true;
    islands.set(k, e);
  });
  for (const e of islands.values()) {
    if (e.joined || !e.prims.length || e.area <= minArea) continue;
    const i = e.prims[0]!, p = doc.prims[i]!;
    warn('DeadCopper', 'Report Dead Copper', [i], at0(p),
      `Dead Copper (Area = ${boardArea(doc, e.area)}): ${describe(doc, i)}${e.prims.length > 1 ? ` and ${e.prims.length - 1} more` : ''} of a pour, cut off from its net`);
  }
}

type Piece = { outline: Vec2[]; holes: Vec2[][]; area: number; box: BBox; holeTree: RBush<BBox & { h: Vec2[] }> };
const bboxOf = (pts: Vec2[]): BBox => { let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; for (const q of pts) { if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; } return { minX, minY, maxX, maxY }; };

/**
 * Plane layers, as AD17 reports them [checked: a 6-layer board with crowded vias on two planes]:
 * - Isolated copper, under the Un-Routed Net rule (with Un-Routed Net checked): each piece of a
 *   net's plane copper but the largest, "Copper island connected to pads/vias" when a hole of the
 *   net is in it (Report Broken Planes), "Dead copper" when none is and it is larger than the area
 *   (Report Dead Copper). Its area is the copper's own, the holes of the net in it not taken off. A
 *   plane none of whose net's holes reach it isn't reported (an unused +3V3 plane: nothing).
 * - Starved thermals, under the Power Plane Connect rule (with Report Starved Thermals on): a
 *   relief whose conductors' copper across the air gap is less than the share given part of the
 *   largest piece. "Blocked N out of M entries" when at least half its conductors join
 *   none of it, else "Only X% copper is connected to the hole" [est: AD17 worded one so with three
 *   of four conductors joined].
 */
function planeReports(doc: PcbDocument, o: { broken: boolean; dead: number | null; starved: number | null }, out: DrcViolation[]): void {
  const stack = doc.board.copperStack;
  const u = drcUnits(doc), per = u === 'mm' ? UNITS_PER_MM : UNITS_PER_MIL;
  const sq = (a: number) => `${trimNum((a / (per * per)).toFixed(3))} sq. ${u === 'mm' ? 'mm' : 'mils'}`;
  for (const l of stack.filter((x) => x >= L.PLANE1 && x <= L.PLANE16)) {
    const areas = planeCopper(doc, l).filter((a) => a.net !== NO_NET && a.regions.length);
    if (!areas.length) continue;
    const at = stack.indexOf(l);
    const holes = new Map<number, number[]>();
    doc.prims.forEach((h, i) => {
      if (h.kind === 'pad') { if (h.layer !== L.MULTI || h.hole <= 0 || !h.plated) return; }
      else if (h.kind === 'via') { const a = stack.indexOf(h.layerStart), b = stack.indexOf(h.layerEnd); if (a >= 0 && b >= 0 && (at < Math.min(a, b) || at > Math.max(a, b))) return; }
      else return;
      if (h.net === NO_NET) return;
      const list = holes.get(h.net); if (list) list.push(i); else holes.set(h.net, [i]);
    });
    const isolated: { area: number; v: DrcViolation }[] = [];
    for (const area of areas) {
      const pieces: Piece[] = area.regions.map((r) => {
        const holeTree = new RBush<BBox & { h: Vec2[] }>();
        holeTree.load(r.holes.map((h) => ({ ...bboxOf(h), h })));
        return { ...r, area: polyArea(r.outline) - r.holes.reduce((s, h) => s + polyArea(h), 0), box: bboxOf(r.outline), holeTree };
      });
      const tree = new RBush<BBox & { k: number }>();
      tree.load(pieces.map((p, k) => ({ ...p.box, k })));
      const pieceAt = (q: Vec2): number => {
        for (const c of tree.search({ minX: q.x, minY: q.y, maxX: q.x, maxY: q.y })) {
          const p = pieces[c.k]!;
          if (!pointInPoly(q, p.outline)) continue;
          if (p.holeTree.search({ minX: q.x, minY: q.y, maxX: q.x, maxY: q.y }).some((x) => pointInPoly(q, x.h))) continue;
          return c.k;
        }
        return -1;
      };
      // The plane proper: its largest piece; its outline's edges, to tell a hole near them
      const main = pieces.reduce((best, p, k) => (p.area > pieces[best]!.area ? k : best), 0);
      const mp = pieces[main]!;
      const edgeTree = new RBush<BBox>();
      edgeTree.load(mp.outline.map((p, k) => { const q = mp.outline[(k + 1) % mp.outline.length]!; return { minX: Math.min(p.x, q.x), minY: Math.min(p.y, q.y), maxX: Math.max(p.x, q.x), maxY: Math.max(p.y, q.y) }; }));
      const name = doc.nets[area.net]?.name ?? String(area.net);
      const reached = new Map<number, number[]>();
      for (const i of holes.get(area.net) ?? []) {
        const h = doc.prims[i] as Extract<PcbPrim, { kind: 'pad' | 'via' }>;
        const k = pieceAt(h.at);
        if (k < 0) continue;
        const list = reached.get(k); if (list) list.push(i); else reached.set(k, [i]);
        if (o.starved === null || (h.kind === 'pad' && h.slot && h.slot.length > h.hole)) continue;
        const rule = ruleFor(doc, 'PlaneConnect', h);
        const style = ((rule && connectValue(rule, 'PLANECONNECTSTYLE', h)) ?? 'Relief').toLowerCase();
        if (style !== 'relief') continue;
        const exp = rule ? connectLength(rule, 'RELIEFEXPANSION', '20mil', h) : mil(20), gap = rule ? connectLength(rule, 'RELIEFAIRGAP', '10mil', h) : mil(10);
        const cw = rule ? connectLength(rule, 'RELIEFCONDUCTORWIDTH', '10mil', h) : mil(10);
        const r1 = h.hole / 2 + exp, r2 = r1 + gap;
        if (cw / 2 >= r1) continue;
        const win = { minX: h.at.x - r2, minY: h.at.y - r2, maxX: h.at.x + r2, maxY: h.at.y + r2 };
        const edgy = edgeTree.collides(win);
        const dirs = reliefDirs(rule, h);
        // Away from the outline the hole is inside it (in the plane proper) or not (on a piece apart)
        const shares = !edgy && k !== main && !pointInPoly(h.at, mp.outline) ? dirs.map(() => 0)
          : conductorShares(h.at, r1, r2, cw / 2, dirs, edgy ? mp.outline : null, mp.holeTree.search(win).map((x) => x.h));
        const pct = (shares.reduce((s, x) => s + x, 0) / shares.length) * 100;
        if (!(pct < o.starved)) continue;
        const blocked = shares.filter((x) => x < 0.01).length;
        out.push({ kind: 'StarvedThermal', rule: rule ? ruleName(rule) : 'PlaneConnect', error: true, prims: [i], at: h.at,
          message: `Starved Thermal on ${name}: ${describe(doc, i)}. ${blocked * 2 >= shares.length ? `Blocked ${blocked} out of ${shares.length} entries.` : `Only ${Math.round(pct)}% copper is connected to the hole.`}` });
      }
      // A plane none of whose net's holes reach it at all isn't isolated copper to the suite
      if (!reached.size || (!o.broken && o.dead === null)) continue;
      const routed = ruleFor(doc, 'UnRoutedNet', doc.prims[[...reached.values()][0]![0]!]!);
      if (!routed) continue;
      pieces.forEach((p, k) => {
        if (k === main) return;
        const hs = reached.get(k) ?? [];
        if (hs.length ? !o.broken : o.dead === null || p.area <= o.dead) return;
        const b = p.box;
        isolated.push({ area: p.area, v: { kind: hs.length ? 'BrokenPlane' : 'DeadCopper', rule: ruleName(routed), error: true, prims: hs.slice(0, 1), at: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
          message: `Isolated copper: Split Plane  (${name}) on ${ln(doc, l)}. ${hs.length ? 'Copper island connected to pads/vias detected.' : 'Dead copper detected.'} Copper area is : ${sq(p.area)}` } });
      });
    }
    // The layer's pieces, the largest first
    out.push(...isolated.sort((a, b) => b.area - a.area).map((x) => x.v));
  }
}

export function padReports(doc: PcbDocument, out: DrcViolation[], subject?: Set<number>): void {
  const { drilledSmt: drilled, zeroHole: zero } = drcSettings(doc);
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad' || (subject && !subject.has(i))) return;
    if (drilled && p.hole > 0 && p.layer !== L.MULTI) out.push({ kind: 'DrilledSMTPad', rule: 'Report Drilled SMT Pads', error: false, prims: [i], at: p.at, message: `Drilled SMT Pad: ${describe(doc, i)} Hole Size = ${boardLength(doc, p.hole)}` });
    if (zero && p.hole === 0 && p.layer === L.MULTI) out.push({ kind: 'MultiLayerPadNoHole', rule: 'Report Multilayer Pads with 0 size Hole', error: false, prims: [i], at: p.at, message: `Multilayer Pad with 0 size Hole: ${describe(doc, i)}` });
  });
}

/* ─── Layer Pairs ────────────────────────────────────────────────────────────────────── */

/** Layer Pairs (Enforce): a via's span is one of the board's drill pairs (Top to Bottom when it sets none). */
function layerPairs(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'LayerPairs');
  const pairs = readDrillPairs(doc.board.bag);
  const ok = new Set((pairs.length ? pairs : [{ low: L.TOP, high: L.BOTTOM }]).flatMap((p) => [`${p.low}:${p.high}`, `${p.high}:${p.low}`]));
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'via' || !inSubject(c, i) || ok.has(`${p.layerStart}:${p.layerEnd}`)) return;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; return; }
    if (!r || !r.rule.bag.bool('ENFORCE', true)) return;
    push(c, { kind: 'LayerPairs', rule: ruleName(r.rule), prims: [i], at: p.at, message: `Layer Pairs Constraint: ${describe(doc, i)} doesn't match a drill pair` });
  });
}

/* ─── A net's routing as a graph: pads, vias and track ends joined by tracks and arcs ─── */

interface GNode { at: Vec2; prim: number; kind: 'pad' | 'via' | 'end' }
interface GEdge { to: number; len: number; prim: number }
interface NetGraph { nodes: GNode[]; adj: GEdge[][] }

/**
 * The routed copper of a net (pour copper aside): a node per pad and via (a track end on one, on
 * its layers, is it), per track end elsewhere, and where a track ends on another one's middle;
 * edges are the tracks and arcs between them with their lengths (from a pad or via's centre).
 */
function netGraph(doc: PcbDocument, idx: number[]): NetGraph {
  const nodes: GNode[] = [], adj: GEdge[][] = [];
  const holders: { i: number; layers: (l: LayerId) => boolean; g: (l: LayerId) => Geom | null }[] = [];
  const stack = doc.board.copperStack;
  for (const i of idx) {
    const p = doc.prims[i]!;
    if (p.kind === 'pad') holders.push({ i, layers: (l) => p.layer === L.MULTI ? isSignal(l) : p.layer === l, g: (l) => padGeom(p, p.layer === L.MULTI ? padLayer(p, l) : p.top) });
    else if (p.kind === 'via') {
      const a = stack.indexOf(p.layerStart), b = stack.indexOf(p.layerEnd);
      holders.push({ i, layers: (l) => { const k = stack.indexOf(l); return k >= Math.min(a, b) && k <= Math.max(a, b); }, g: () => ({ t: 'circle', c: p.at, r: p.diameter / 2 }) });
    }
  }
  const holderNode = new Map<number, number>();
  const node = (n: GNode) => { nodes.push(n); adj.push([]); return nodes.length - 1; };
  for (const h of holders) { const p = doc.prims[h.i]! as { at: Vec2 }; holderNode.set(h.i, node({ at: p.at, prim: h.i, kind: doc.prims[h.i]!.kind === 'pad' ? 'pad' : 'via' })); }
  const ends = new Map<string, number>();
  const at = (q: Vec2, layer: LayerId): number => {
    for (const h of holders) {
      if (!h.layers(layer)) continue;
      const g = h.g(layer);
      if (g && distance({ t: 'circle', c: q, r: 0 }, g) <= T) return holderNode.get(h.i)!;
    }
    const k = `${layer}:${Math.round(q.x / 200)}:${Math.round(q.y / 200)}`;
    let n = ends.get(k);
    if (n === undefined) { n = node({ at: q, prim: -1, kind: 'end' }); ends.set(k, n); }
    return n;
  };
  // Tracks split where another track of the net ends on them
  const segs = idx.map((i) => doc.prims[i]!).filter((p): p is Extract<PcbPrim, { kind: 'track' }> => p.kind === 'track' && !inPour(p) && isSignal(p.layer));
  const cuts = new Map<PcbPrim, number[]>();
  for (const a of segs) for (const e of [a.a, a.b]) for (const b of segs) {
    if (b === a || b.layer !== a.layer) continue;
    const dx = b.b.x - b.a.x, dy = b.b.y - b.a.y, l2 = dx * dx + dy * dy;
    if (!l2) continue;
    const t = ((e.x - b.a.x) * dx + (e.y - b.a.y) * dy) / l2;
    if (t <= 0.001 || t >= 0.999) continue;
    if (Math.hypot(b.a.x + t * dx - e.x, b.a.y + t * dy - e.y) <= Math.max(T, b.width / 2)) (cuts.get(b) ?? cuts.set(b, []).get(b)!).push(t);
  }
  const link = (a: number, b: number, len: number, prim: number) => { if (a === b) return; adj[a]!.push({ to: b, len, prim }); adj[b]!.push({ to: a, len, prim }); };
  for (const i of idx) {
    const p = doc.prims[i]!;
    if (p.kind === 'track' && !inPour(p) && isSignal(p.layer)) {
      const ts = [0, ...(cuts.get(p) ?? []).sort((x, y) => x - y), 1];
      for (let k = 1; k < ts.length; k++) {
        const P = (t: number) => ({ x: p.a.x + (p.b.x - p.a.x) * t, y: p.a.y + (p.b.y - p.a.y) * t });
        const u = at(P(ts[k - 1]!), p.layer), v = at(P(ts[k]!), p.layer);
        link(u, v, Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) * (ts[k]! - ts[k - 1]!), i);
      }
    } else if (p.kind === 'arc' && !inPour(p) && isSignal(p.layer) && ((p.end - p.start) % 360 + 360) % 360 !== 0) {
      link(at(arcEnd(p, p.start), p.layer), at(arcEnd(p, p.end), p.layer), arcLen(p), i);
    }
  }
  return { nodes, adj };
}

/** The nets each rule of a net-level kind takes (by the net's primitives), the first rule that takes it. */
function netsByRule(c: Ctx, kind: string): Map<number, Scoped> {
  const list = rules(c, kind), out = new Map<number, Scoped>();
  for (const [net, idx] of primsByNet(c.doc)) {
    const r = netRule(list, representatives(c.doc, idx).map((i) => c.doc.prims[i]!));
    if (r === HELD) { c.held.n++; continue; }
    if (r) out.set(net, r);
  }
  return out;
}

/* ─── Daisy Chain Stub Length ────────────────────────────────────────────────────────── */

/**
 * On nets whose Routing Topology is a daisy chain, a pad reached by a branch off the chain: the
 * branch from the pad to where it leaves the chain no longer than the limit [est: the branch
 * measured along its tracks from the pad's centre].
 */
function stubLengths(c: Ctx): void {
  const { doc } = c;
  const kind = doc.rules.some((r) => r.bag.get('RULEKIND') === 'StubLength') ? 'StubLength' : 'DaisyChainStubLength';
  const stub = netsByRule(c, kind), topo = netsByRule(c, 'RoutingTopology');
  const nets = primsByNet(doc);
  for (const [net, r] of stub) {
    if (!/daisy/i.test(topo.get(net)?.rule.bag.get('TOPOLOGY') ?? '')) continue;
    const limit = len(r.rule, 'LIMIT', '1000mil');
    const g = netGraph(doc, nets.get(net)!);
    g.nodes.forEach((n, k) => {
      if (n.kind !== 'pad' || g.adj[k]!.length !== 1) return;
      // Along the branch to where three or more ways meet
      let at = k, from = -1, run = 0;
      for (let guard = 0; guard < 10_000; guard++) {
        const e = g.adj[at]!.find((x) => x.to !== from);
        if (!e) return;
        run += e.len; from = at; at = e.to;
        // Another pad on the way: this is the chain, not a branch
        if (g.nodes[at]!.kind === 'pad') return;
        const deg = g.adj[at]!.length;
        if (deg >= 3) break;
        if (deg <= 1) return;
      }
      if (run <= limit + T) return;
      push(c, { kind: 'StubLength', rule: ruleName(r.rule), prims: [n.prim], at: n.at,
        message: `Daisy Chain Stub Length Constraint (Max=${boardLength(doc, limit)}): ${describe(doc, n.prim)} Stub Length = ${boardLength(doc, run)}` });
    });
  }
}

/* ─── SMD To Plane ───────────────────────────────────────────────────────────────────── */

/** SMD To Plane: the route from an SMD pad's centre to the via or pad that meets its net's plane no longer than the distance. */
function smdToPlane(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'SMDToPlane');
  const onPlane = planeNetsAt(doc);
  const planes = doc.board.copperStack.filter((l) => l >= L.PLANE1 && l <= L.PLANE16);
  if (!planes.length) return;
  const nets = primsByNet(doc);
  const stack = doc.board.copperStack;
  const reaches = (p: PcbPrim) => {
    if (p.kind === 'via') { const a = stack.indexOf(p.layerStart), b = stack.indexOf(p.layerEnd); return planes.some((l) => { const k = stack.indexOf(l); return k > Math.min(a, b) && k < Math.max(a, b) && onPlane(p, l); }); }
    return p.kind === 'pad' && p.layer === L.MULTI && p.hole > 0 && planes.some((l) => onPlane(p, l));
  };
  const graphs = new Map<number, NetGraph>();
  for (const { p, i } of smdPads(doc)) {
    if (p.net === NO_NET) continue;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; continue; }
    if (!r) continue;
    const dist = rawLen(r.rule, 'DISTANCE', 0);
    let g = graphs.get(p.net);
    if (!g) { g = netGraph(doc, nets.get(p.net) ?? []); graphs.set(p.net, g); }
    const start = g.nodes.findIndex((n) => n.prim === i);
    if (start < 0) continue;
    // Shortest route along the net's tracks to a plane connection
    const best = new Map<number, number>([[start, 0]]), todo = [start];
    let found = Infinity;
    while (todo.length) {
      todo.sort((a, b) => best.get(b)! - best.get(a)!);
      const at = todo.pop()!, d = best.get(at)!;
      if (d >= found) break;
      const n = g.nodes[at]!;
      if (at !== start && n.prim >= 0 && reaches(doc.prims[n.prim]!)) { found = d; break; }
      for (const e of g.adj[at]!) { const nd = d + e.len; if (nd < (best.get(e.to) ?? Infinity)) { best.set(e.to, nd); todo.push(e.to); } }
    }
    if (!Number.isFinite(found) || found <= dist + T) continue;
    push(c, { kind: 'SMDToPlane', rule: ruleName(r.rule), prims: [i], at: p.at,
      message: `SMD To Plane Constraint: (${boardLength(doc, found)} > ${boardLength(doc, dist)}) ${describe(doc, i)} to its plane connection` });
  }
}

/* ─── SMD Entry ──────────────────────────────────────────────────────────────────────── */

/**
 * SMD Entry: a track leaves a single-layer SMD pad through an end (its shorter edges, always
 * allowed), a side (only with Side, and only when the side is more than twice the end) or a
 * corner (only with Corner); without Any Angle it leaves square to the edge.
 */
function smdEntry(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'SMDEntry');
  for (const { p, i } of smdPads(doc)) {
    const st = padFace(p, p.layer === L.BOTTOM ? 'bottom' : 'top');
    if (st.shape === 'round' && Math.abs(st.w - st.h) < 1) continue;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; continue; }
    if (!r) continue;
    const side = r.rule.bag.bool('SIDE'), corner = r.rule.bag.bool('CORNER'), any = r.rule.bag.bool('ANYANGLE');
    const a = (-p.rotation * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const local = (q: Vec2) => ({ x: (q.x - p.at.x) * ca - (q.y - p.at.y) * sa, y: (q.x - p.at.x) * sa + (q.y - p.at.y) * ca });
    const hw = st.w / 2, hh = st.h / 2, long = Math.max(st.w, st.h), short = Math.min(st.w, st.h);
    doc.prims.forEach((t, ti) => {
      if (t.kind !== 'track' || t.layer !== p.layer || t.net !== p.net || (!inSubject(c, i) && !inSubject(c, ti))) return;
      const A = local(t.a), B = local(t.b);
      const inside = (q: Vec2) => Math.abs(q.x) <= hw + T && Math.abs(q.y) <= hh + T;
      if (inside(A) === inside(B)) return;
      const [I, O] = inside(A) ? [A, B] : [B, A];
      // Where it crosses the pad's edge
      let tx = Infinity;
      const dx = O.x - I.x, dy = O.y - I.y;
      for (const [d, lo, hi] of [[dx, -hw - I.x, hw - I.x], [dy, -hh - I.y, hh - I.y]] as const) {
        if (d > 0) tx = Math.min(tx, hi / d); else if (d < 0) tx = Math.min(tx, lo / d);
      }
      const X = { x: I.x + dx * tx, y: I.y + dy * tx };
      const nearCorner = Math.abs(Math.abs(X.x) - hw) <= t.width / 2 + T && Math.abs(Math.abs(X.y) - hh) <= t.width / 2 + T;
      const onX = Math.abs(Math.abs(X.x) - hw) <= T;
      // The edge it leaves by: an end is a shorter edge
      const throughEnd = st.w >= st.h ? onX : !onX;
      const where = nearCorner ? 'corner' : throughEnd ? 'end' : 'side';
      const ang = deg(Math.atan2(Math.abs(onX ? dy : dx), Math.abs(onX ? dx : dy)));
      const bad = (where === 'corner' && !corner) || (where === 'side' && !side && long > 2 * short + T) || (where !== 'corner' && !any && ang > 1);
      if (!bad) return;
      push(c, { kind: 'SMDEntry', rule: ruleName(r.rule), prims: [i, ti], at: t.a,
        message: `SMD Entry Constraint: ${describe(doc, ti)} enters ${describe(doc, i)} by ${where === 'corner' ? 'a corner' : where === 'side' ? 'a side' : 'an end'}${where !== 'corner' && !any && ang > 1 ? ` at ${ang.toFixed(1)}° off square` : ''}` });
    });
  }
}

/* ─── Parallel Segment ───────────────────────────────────────────────────────────────── */

/**
 * Parallel Segment: tracks of two nets running parallel within the gap (edge to edge) on one
 * layer (or adjacent layers [est: LAYERKIND AdjacentLayers]) for longer than the limit, added up
 * per pair of nets; a differential pair's own two nets aren't measured.
 */
function parallelSegments(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'ParallelSegment');
  const maxGap = Math.max(0, ...list.map((r) => len(r.rule, 'GAP', '10mil')));
  const tracks = doc.prims.map((p, i) => ({ p, i })).filter((x): x is { p: Extract<PcbPrim, { kind: 'track' }>; i: number } => x.p.kind === 'track' && x.p.net !== NO_NET && !inPour(x.p) && isSignal(x.p.layer));
  const idx = new RBush<BBox & { k: number }>();
  idx.load(tracks.map(({ p }, k) => ({ k, minX: Math.min(p.a.x, p.b.x) - p.width - maxGap, minY: Math.min(p.a.y, p.b.y) - p.width - maxGap, maxX: Math.max(p.a.x, p.b.x) + p.width + maxGap, maxY: Math.max(p.a.y, p.b.y) + p.width + maxGap })));
  const pairOf = new Map<number, string>();
  for (const b of doc.diffPairs ?? []) for (const k of ['POSITIVENETNAME', 'NEGATIVENETNAME']) { const n = doc.nets.findIndex((x) => x.name === b.get(k)); if (n >= 0) pairOf.set(n, b.get('NAME') ?? ''); }
  const stack = doc.board.copperStack.filter(isSignal);
  const sum = new Map<string, { r: Scoped; a: number; b: number; len: number; prims: [number, number] }>();
  for (const [k, { p: A, i: ia }] of tracks.entries()) {
    for (const { k: j } of idx.search(idx.all().length ? { minX: Math.min(A.a.x, A.b.x), minY: Math.min(A.a.y, A.b.y), maxX: Math.max(A.a.x, A.b.x), maxY: Math.max(A.a.y, A.b.y) } : { minX: 0, minY: 0, maxX: 0, maxY: 0 })) {
      if (j <= k) continue;
      const { p: B, i: ib } = tracks[j]!;
      if (B.net === A.net || (pairOf.has(A.net) && pairOf.get(A.net) === pairOf.get(B.net))) continue;
      if (!inSubject(c, ia) && !inSubject(c, ib)) continue;
      let r: Pick;
      for (const x of list) { const m = and3(x.s1(A), x.s2(B)), n = and3(x.s1(B), x.s2(A)); if (m === true || n === true) { r = x; break; } if (m === null || n === null) { r = HELD; break; } }
      if (r === HELD) { c.held.n++; continue; }
      if (!r) continue;
      const adjacent = /adjacent/i.test(r.rule.bag.get('LAYERKIND') ?? '');
      if (adjacent ? Math.abs(stack.indexOf(A.layer) - stack.indexOf(B.layer)) !== 1 : A.layer !== B.layer) continue;
      // Parallel within a degree; the run where both lie side by side
      const ux = A.b.x - A.a.x, uy = A.b.y - A.a.y, la = Math.hypot(ux, uy), vx = B.b.x - B.a.x, vy = B.b.y - B.a.y, lb = Math.hypot(vx, vy);
      if (!la || !lb || Math.abs(ux * vy - uy * vx) / (la * lb) > Math.sin(Math.PI / 180)) continue;
      const dx = ux / la, dy = uy / la;
      const sep = Math.abs((B.a.x - A.a.x) * -dy + (B.a.y - A.a.y) * dx) - (A.width + B.width) / 2;
      const gap = len(r.rule, 'GAP', '10mil');
      if (sep > gap + T) continue;
      const t0 = (B.a.x - A.a.x) * dx + (B.a.y - A.a.y) * dy, t1 = (B.b.x - A.a.x) * dx + (B.b.y - A.a.y) * dy;
      const run = Math.min(la, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1));
      if (run <= 0) continue;
      const key = `${Math.min(A.net, B.net)}:${Math.max(A.net, B.net)}:${ruleName(r.rule)}`;
      const e = sum.get(key) ?? { r, a: Math.min(A.net, B.net), b: Math.max(A.net, B.net), len: 0, prims: [ia, ib] as [number, number] };
      e.len += run;
      sum.set(key, e);
    }
  }
  for (const e of sum.values()) {
    const limit = len(e.r.rule, 'LIMIT', '10000mil');
    if (e.len <= limit + T) continue;
    const at = (doc.prims[e.prims[0]] as { a: Vec2 }).a;
    push(c, { kind: 'ParallelSegment', rule: ruleName(e.r.rule), prims: e.prims, at,
      message: `Parallel Segment Constraint (Gap=${boardLength(doc, len(e.r.rule, 'GAP', '10mil'))}) (Limit=${boardLength(doc, limit)}): Between Net ${doc.nets[e.a]?.name} And Net ${doc.nets[e.b]?.name} Parallel Length = ${boardLength(doc, e.len)}` });
  }
}

/* ─── Propagation delay ──────────────────────────────────────────────────────────────── */

/** Light in vacuum: ps per internal unit (1/10 000 mil). */
const PS_PER_UNIT = 0.0254 / 1e4 / 1000 / 299_792_458 * 1e12;

/**
 * A track's delay per unit of length on a layer, from the stack: an outer layer a microstrip
 * over its dielectric (Hammerstad's effective Dk for the track's width), an inner one a
 * stripline in the mean Dk of the dielectrics either side [est: AD's own solver may differ].
 */
export function delayPerUnit(doc: PcbDocument): (layer: LayerId, width: number) => number {
  const rows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [];
  const cache = new Map<string, number>();
  return (layer, width) => {
    const k = `${layer}:${width}`;
    let v = cache.get(k);
    if (v !== undefined) return v;
    const at = rows.findIndex((r) => r.layer === layer);
    const diel = (from: number, step: number) => { for (let j = from + step; j >= 0 && j < rows.length; j += step) { const r = rows[j]!; if (r.kind === 'dielectric' || r.kind === 'coverlay') return r; if (r.kind === 'signal' || r.kind === 'plane') return null; } return null; };
    const up = at >= 0 ? diel(at, -1) : null, down = at >= 0 ? diel(at, 1) : null;
    let eff: number;
    if (up && down) eff = (up.dielConst + down.dielConst) / 2;
    else {
      const d = up ?? down;
      const er = d?.dielConst || 4.2, h = d?.height || 100_000, w = Math.max(width, 1);
      eff = (er + 1) / 2 + ((er - 1) / 2) * (1 / Math.sqrt(1 + (12 * h) / w) + (w < h ? 0.04 * (1 - w / h) ** 2 : 0));
    }
    v = PS_PER_UNIT * Math.sqrt(Math.max(1, eff));
    cache.set(k, v);
    return v;
  };
}

/** Each net's delay along its tracks and arcs, in ps. */
export function netDelays(doc: PcbDocument): Map<number, number> {
  const per = delayPerUnit(doc), m = new Map<number, number>();
  for (const p of doc.prims) {
    if ((p.kind !== 'track' && p.kind !== 'arc') || p.net === NO_NET || inPour(p) || !isSignal(p.layer) || p.keepout) continue;
    const l = p.kind === 'track' ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : arcLen(p);
    m.set(p.net, (m.get(p.net) ?? 0) + l * per(p.layer, p.width));
  }
  return m;
}

/* ─── Differential pairs: uncoupled length ───────────────────────────────────────────── */

/** A pair's gap limit on a layer: its own (TOPLAYER_MAXGAP, MIDLAYERn_MAXGAP …) else the rule's MAXLIMIT. */
function maxGap(r: PcbRule, layer: LayerId): number {
  const prefix = layer === L.TOP ? 'TOPLAYER' : layer === L.BOTTOM ? 'BOTTOMLAYER' : `MIDLAYER${layer - L.TOP}`;
  return r.bag.has(`${prefix}_MAXGAP`) ? len(r, `${prefix}_MAXGAP`, '10mil') : len(r, 'MAXLIMIT', '10mil');
}

/**
 * Differential Pairs Routing's Max Uncoupled Length: the length of either net of a pair that
 * doesn't run beside the other within the rule's largest gap (edge to edge; arcs beside arcs
 * about one centre), the larger of the two, against the limit.
 */
export function uncoupledLengths(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'DiffPairsRouting');
  const nets = primsByNet(doc);
  for (const b of doc.diffPairs ?? []) {
    const P = doc.nets.findIndex((n) => n.name === b.get('POSITIVENETNAME')), N = doc.nets.findIndex((n) => n.name === b.get('NEGATIVENETNAME'));
    if (P < 0 || N < 0) continue;
    const ip = nets.get(P) ?? [], inn = nets.get(N) ?? [];
    if (!ip.length || !inn.length) continue;
    const r = netRule(list, representatives(doc, ip).map((i) => doc.prims[i]!));
    if (r === HELD) { c.held.n++; continue; }
    if (!r || !r.rule.bag.has('MAXUNCOUPLEDLENGTH')) continue;
    const limit = len(r.rule, 'MAXUNCOUPLEDLENGTH', '500mil');
    const wires = (idx: number[]) => idx.map((i) => doc.prims[i]!).filter((p) => (p.kind === 'track' || p.kind === 'arc') && !inPour(p) && isSignal(p.layer)) as (Extract<PcbPrim, { kind: 'track' }> | Extract<PcbPrim, { kind: 'arc' }>)[];
    const wp = wires(ip), wn = wires(inn);
    const uncoupled = (mine: typeof wp, other: typeof wp) => {
      let total = 0;
      for (const a of mine) {
        const gap = maxGap(r.rule, a.layer);
        if (a.kind === 'arc') {
          const len0 = arcLen(a);
          const beside = other.some((o) => o.kind === 'arc' && o.layer === a.layer && Math.hypot(o.c.x - a.c.x, o.c.y - a.c.y) <= T * 10 && Math.abs(o.r - a.r) - (o.width + a.width) / 2 <= gap + T);
          if (!beside) total += len0;
          continue;
        }
        const ux = a.b.x - a.a.x, uy = a.b.y - a.a.y, la = Math.hypot(ux, uy);
        if (!la) continue;
        const dx = ux / la, dy = uy / la;
        // The stretches of this track with the other net's track beside it
        const spans: [number, number][] = [];
        for (const o of other) {
          if (o.kind !== 'track' || o.layer !== a.layer) continue;
          const vx = o.b.x - o.a.x, vy = o.b.y - o.a.y, lb = Math.hypot(vx, vy);
          if (!lb || Math.abs(ux * vy - uy * vx) / (la * lb) > Math.sin((2 * Math.PI) / 180)) continue;
          const sep = Math.abs((o.a.x - a.a.x) * -dy + (o.a.y - a.a.y) * dx) - (a.width + o.width) / 2;
          if (sep > gap + T || sep < -T) continue;
          const t0 = (o.a.x - a.a.x) * dx + (o.a.y - a.a.y) * dy, t1 = (o.b.x - a.a.x) * dx + (o.b.y - a.a.y) * dy;
          const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(la, Math.max(t0, t1));
          if (hi > lo) spans.push([lo, hi]);
        }
        spans.sort((x, y) => x[0] - y[0]);
        let covered = 0, end = 0;
        for (const [lo, hi] of spans) { if (hi <= end) continue; covered += hi - Math.max(lo, end); end = hi; }
        total += la - covered;
      }
      return total;
    };
    const u = Math.max(uncoupled(wp, wn), uncoupled(wn, wp));
    if (u <= limit + T) continue;
    push(c, { kind: 'DiffPairsRouting', rule: ruleName(r.rule), prims: [ip[0]!, inn[0]!], at: firstAt(doc, ip),
      message: `Differential Pairs Routing: Between Net ${doc.nets[P]?.name} And Net ${doc.nets[N]?.name} [Uncoupled Length = ${boardLength(doc, u)}], [Maximum Uncoupled Length = ${boardLength(doc, limit)}]` });
  }
}

/* ─── Maximum Via Count, Permitted Layers ─────────────────────────────────────────────── */

/** Maximum Via Count: the vias each rule takes, against its limit (LIMIT; VIACOUNT, MAXVIACOUNT as other readers have it [est]). */
function maxViaCount(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'MaximumViaCount');
  const count = new Map<Scoped, number[]>();
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'via') return;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; return; }
    if (!r) return;
    const a = count.get(r); if (a) a.push(i); else count.set(r, [i]);
  });
  for (const [r, vias] of count) {
    const b = r.rule.bag;
    const limit = Number(b.get('LIMIT') ?? b.get('VIACOUNT') ?? b.get('MAXVIACOUNT') ?? 1000);
    if (!(vias.length > limit)) continue;
    push(c, { kind: 'MaximumViaCount', rule: ruleName(r.rule), prims: vias.slice(limit, limit + 1), at: (doc.prims[vias[limit]!] as { at: Vec2 }).at,
      message: `Maximum Via Count Constraint: (Via Count = ${vias.length}) (Maximum = ${limit})` });
  }
}

/** Permitted Layers: a component on a side the rule doesn't allow (TOP LAYER_V5, BOTTOM LAYER_V5). */
function permittedLayers(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'PermittedLayers', true);
  for (const [comp, idx] of byComponent(doc)) {
    const k = doc.components[comp];
    if (!k) continue;
    const r = componentRule(list, idx.map((i) => doc.prims[i]!));
    if (r === HELD) { c.held.n++; continue; }
    if (!r) continue;
    const bottom = k.layer === L.BOTTOM;
    const key = bottom ? 'BOTTOM LAYER_V5' : 'TOP LAYER_V5';
    if (r.rule.bag.bool(key, true)) continue;
    push(c, { kind: 'PermittedLayers', rule: ruleName(r.rule), prims: idx.slice(0, 1), at: k.at, message: `Permitted Layers Constraint: Component ${k.designator} (${k.pattern}) on ${ln(doc, k.layer)}` });
  }
}

/* ─── Max Via Stub Length (Back Drilling) ────────────────────────────────────────────── */

/** Each copper layer's depth (the middle of its copper) from the top of the board, by the layer stack. */
function layerDepths(doc: PcbDocument): Map<LayerId, number> {
  const rows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [];
  const out = new Map<LayerId, number>();
  let z = 0;
  for (const r of rows) {
    if (r.kind === 'signal' || r.kind === 'plane') { if (r.layer !== null) out.set(r.layer, z + r.copper / 2); z += r.copper; }
    else if (r.kind === 'dielectric' || r.kind === 'coverlay') z += r.height;
  }
  // No stack read: copper layers evenly through a 62 mil board [est]
  if (!out.size) doc.board.copperStack.forEach((l, k, a) => out.set(l, (mil(62) * k) / Math.max(1, a.length - 1)));
  return out;
}

/**
 * Max Via Stub Length (Back Drilling): a via's unused barrel past the last layer it connects on,
 * longer than the rule's maximum, where the rule doesn't back drill it from that side
 * (USETOPBACKDRILL, USEBOTTOMBACKDRILL). Connected on a layer: copper of its net touching it there,
 * or its plane [est].
 */
function backDrilling(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'BackDrilling');
  const tree = boardIndex(doc);
  const depth = layerDepths(doc);
  const stack = doc.board.copperStack;
  const onPlane = planeNetsAt(doc);
  doc.prims.forEach((v, i) => {
    if (v.kind !== 'via' || v.net === NO_NET) return;
    const r = unaryRule(list, v);
    if (r === HELD) { c.held.n++; return; }
    if (!r) return;
    const a = stack.indexOf(v.layerStart), b = stack.indexOf(v.layerEnd);
    if (a < 0 || b < 0) return;
    const [top, bot] = [Math.min(a, b), Math.max(a, b)];
    const used = new Set<number>();
    for (const sh of copperOf(tree, i)) {
      if (sh.role) continue;
      for (const o of tree.search(sh)) {
        if (o.prim === i || o.layer !== sh.layer || o.role || o.net !== v.net) continue;
        if (distance(sh.g, o.g, 2 * T) <= T) { used.add(stack.indexOf(sh.layer)); break; }
      }
    }
    for (let k = top; k <= bot; k++) { const l = stack[k]!; if (l >= L.PLANE1 && l <= L.PLANE16 && onPlane(v, l)) used.add(k); }
    if (!used.size) return;
    const first = Math.min(...used), last = Math.max(...used);
    const z = (k: number) => depth.get(stack[k]!) ?? 0;
    const max = len(r.rule, 'MAXSTUBLENGTH', '15mil');
    const stubs: string[] = [];
    if (!r.rule.bag.bool('USETOPBACKDRILL') && z(first) - z(top) > max + T) stubs.push(`${boardLength(doc, z(first) - z(top))} above ${ln(doc, stack[first]!)}`);
    if (!r.rule.bag.bool('USEBOTTOMBACKDRILL') && z(bot) - z(last) > max + T) stubs.push(`${boardLength(doc, z(bot) - z(last))} below ${ln(doc, stack[last]!)}`);
    if (stubs.length) push(c, { kind: 'BackDrilling', rule: ruleName(r.rule), prims: [i], at: v.at, message: `Max Via Stub Length Constraint: ${describe(doc, i)}: stub ${stubs.join(' and ')} (Max = ${boardLength(doc, max)})` });
  });
}

/* ─── Creepage Distance ──────────────────────────────────────────────────────────────── */

/**
 * A barrier to a surface path: its shape (core), and a polygon round it whose corners a path may
 * go by (a hair larger; round ones circumscribed).
 */
interface Barrier { poly: Vec2[]; core: Vec2[] }
function barrierOf(p: PcbPrim): Barrier | null {
  const grow = (pts: Vec2[], by: number) => {
    const c = pts.reduce((a, q) => ({ x: a.x + q.x / pts.length, y: a.y + q.y / pts.length }), { x: 0, y: 0 });
    return pts.map((q) => { const d = Math.hypot(q.x - c.x, q.y - c.y) || 1; return { x: q.x + ((q.x - c.x) / d) * by, y: q.y + ((q.y - c.y) / d) * by }; });
  };
  if (p.kind === 'region' && p.boardCutout && p.outline.length >= 3) return { poly: grow(p.outline, 40), core: p.outline };
  if (p.kind === 'pad' && p.hole > 0 && (!p.plated || p.slot)) {
    const ends = slotEnds(p) ?? [p.at, p.at];
    const a = Math.atan2(ends[1].y - ends[0].y, ends[1].x - ends[0].x);
    // A slot: its two ends' half circles; a round hole: a sixteen-sided circle round it
    const capsule = (r: number) => {
      const out: Vec2[] = [];
      for (const [c, from] of [[ends[1], a - Math.PI / 2], [ends[0], a + Math.PI / 2]] as const) for (let k = 0; k <= 8; k++) { const t = from + (k * Math.PI) / 8; out.push({ x: c.x + Math.cos(t) * r, y: c.y + Math.sin(t) * r }); }
      return out;
    };
    return { poly: capsule(p.hole / 2 / Math.cos(Math.PI / 16) + 40), core: capsule(p.hole / 2 * 0.98) };
  }
  return null;
}

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
/** Whether p→q stays out of every barrier (touching a corner is allowed). */
function clearOf(p: Vec2, q: Vec2, bars: Barrier[]): boolean {
  for (const { core: poly } of bars) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      const d1 = cross(a, b, p), d2 = cross(a, b, q), d3 = cross(p, q, a), d4 = cross(p, q, b);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return false;
    }
    for (const t of [0.25, 0.5, 0.75]) if (pointInPoly({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }, poly)) return false;
  }
  return true;
}
/** The point of a shape's edge nearest p (a round shape's, at its radius). */
function edgeNear(g: Geom, p: Vec2): Vec2 {
  const out = (c: Vec2, r: number) => { const d = Math.hypot(p.x - c.x, p.y - c.y); return d <= r || !d ? p : { x: c.x + ((p.x - c.x) / d) * r, y: c.y + ((p.y - c.y) / d) * r }; };
  if (g.t === 'circle') return out(g.c, g.r);
  if (g.t === 'seg') {
    const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - g.a.x) * dx + (p.y - g.a.y) * dy) / L2)) : 0;
    return out({ x: g.a.x + dx * t, y: g.a.y + dy * t }, g.r);
  }
  if (pointInPoly(p, g.pts)) return p;
  let best = g.pts[0]!, bd = Infinity;
  for (const [a, b] of edges(g)) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    const q = { x: a.x + dx * t, y: a.y + dy * t }, d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}
/** Points along a shape, to look for a clear straight way from. */
function samplesOf(g: Geom): Vec2[] {
  if (g.t === 'circle') return [g.c];
  if (g.t === 'seg') return Array.from({ length: 13 }, (_, i) => ({ x: g.a.x + ((g.b.x - g.a.x) * i) / 12, y: g.a.y + ((g.b.y - g.a.y) * i) / 12 }));
  const out: Vec2[] = [];
  for (const [a, b] of edges(g).slice(0, 400)) out.push(a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return out;
}

/**
 * The shortest way across the board's surface between two copper shapes that keeps out of the
 * barriers (cutouts, slots, unplated holes): straight where some straight way between them is
 * clear, else round the barriers' corners (the shortest path over their corners, Dijkstra).
 */
export function creepPath(ga: Geom, gb: Geom, polys: Barrier[]): number {
  let best = Infinity;
  for (const [x, y] of [[ga, gb], [gb, ga]] as const) for (const s of samplesOf(x)) {
    const t = edgeNear(y, s), s2 = edgeNear(x, t);
    const d = Math.hypot(t.x - s2.x, t.y - s2.y);
    if (d < best && clearOf(s2, t, polys)) best = d;
  }
  if (Number.isFinite(best)) return best;
  // Round the corners: from shape a to a corner, corner to corner, a corner to shape b
  const nodes = polys.flatMap((b) => b.poly);
  const dist = new Float64Array(nodes.length).fill(Infinity), done = new Uint8Array(nodes.length);
  nodes.forEach((v, i) => { const e = edgeNear(ga, v); if (clearOf(e, v, polys)) dist[i] = Math.hypot(v.x - e.x, v.y - e.y); });
  for (;;) {
    let k = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i]! < (k < 0 ? Infinity : dist[k]!)) k = i;
    if (k < 0 || !Number.isFinite(dist[k]!)) break;
    done[k] = 1;
    const v = nodes[k]!;
    const e = edgeNear(gb, v);
    if (clearOf(v, e, polys)) best = Math.min(best, dist[k]! + Math.hypot(e.x - v.x, e.y - v.y));
    if (dist[k]! >= best) break;
    for (let i = 0; i < nodes.length; i++) {
      if (done[i]) continue;
      const w = nodes[i]!, d = dist[k]! + Math.hypot(w.x - v.x, w.y - v.y);
      if (d < dist[i]! && clearOf(v, w, polys)) dist[i] = d;
    }
  }
  return best;
}

/**
 * Creepage Distance: copper of two nets closer across the board's surface than the distance
 * (DISTANCE), on the outer layers (all with IGNOREINTERNALLAYERS off), pours only with
 * APPLYTOPOLYGONPOUR. A path that would cross a cutout, a slot or an unplated hole goes round it:
 * the distance is the shortest way that keeps out of them.
 */
function creepage(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'Creepage');
  if (!list.length) return;
  const tree = boardIndex(doc);
  const reach = Math.max(...list.map((r) => rawLen(r.rule, 'DISTANCE', mil(10))));
  const outer = new Set([doc.board.copperStack[0], doc.board.copperStack.at(-1)]);
  const internal = list.some((r) => !r.rule.bag.bool('IGNOREINTERNALLAYERS', true));
  // What a surface path can't cross: cutouts, slots and unplated holes
  const barriers = new RBush<BBox & { bar: Barrier }>();
  barriers.load(doc.prims.flatMap((p): (BBox & { bar: Barrier })[] => {
    const bar = barrierOf(p);
    if (!bar) return [];
    const xs = bar.poly.map((q) => q.x), ys = bar.poly.map((q) => q.y);
    return [{ minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys), bar }];
  }));
  const seen = new Set<string>();
  for (const a of tree.all()) {
    if (a.role || a.net === NO_NET || !inSubject(c, a.prim)) continue;
    if (!outer.has(a.layer) && !internal) continue;
    const pa = doc.prims[a.prim]!;
    for (const b of tree.search({ minX: a.minX - reach, minY: a.minY - reach, maxX: a.maxX + reach, maxY: a.maxY + reach })) {
      if (b.prim === a.prim || b.layer !== a.layer || b.role || b.net === NO_NET || b.net === a.net) continue;
      const key = a.prim < b.prim ? `${a.prim}:${b.prim}` : `${b.prim}:${a.prim}`;
      if (seen.has(key)) continue;
      const pb = doc.prims[b.prim]!;
      const r = pairRule(list, pa, pb);
      if (r === HELD) { c.held.n++; seen.add(key); continue; }
      if (!r) continue;
      if (!outer.has(a.layer) && r.rule.bag.bool('IGNOREINTERNALLAYERS', true)) continue;
      if ((inPour(pa) || inPour(pb)) && !r.rule.bag.bool('APPLYTOPOLYGONPOUR')) continue;
      const gap = rawLen(r.rule, 'DISTANCE', mil(10));
      const d0 = distance(a.g, b.g, gap + a.tol + b.tol) + a.tol + b.tol;
      if (d0 >= gap - T) continue;
      seen.add(key);
      // Barriers near the pair: the way round them
      const near = barriers.search({ minX: Math.min(a.minX, b.minX) - gap, minY: Math.min(a.minY, b.minY) - gap, maxX: Math.max(a.maxX, b.maxX) + gap, maxY: Math.max(a.maxY, b.maxY) + gap }).map((x) => x.bar);
      const d = near.length && d0 > T ? creepPath(a.g, b.g, near) + a.tol + b.tol : d0;
      if (d >= gap - T) continue;
      const at = contact(a.g, b.g);
      push(c, { kind: 'Creepage', rule: ruleName(r.rule), prims: [a.prim, b.prim], at, message: `Creepage Distance Constraint: (${d <= T ? 'Collision' : boardLength(doc, d)} < ${boardLength(doc, gap)}) Between ${describe(doc, a.prim)} And ${describe(doc, b.prim)}` });
    }
  }
}

/* ─── Return Path ────────────────────────────────────────────────────────────────────── */

/**
 * Return Path: a signal's tracks over reference copper the whole way, at least GAP past each edge.
 * The reference is the copper layer next to the track's (either side; an outer layer has one):
 * a plane's copper less its clearances (with EXCLUDEPADORVIASVOIDS the clearances of pads and
 * vias don't count), or pours, fills and regions on a signal layer [est: AD takes it from the
 * impedance profile]. Checked along each track every few mils.
 */
function returnPath(c: Ctx): void {
  const { doc } = c;
  const list = rules(c, 'ReturnPath');
  const stack = doc.board.copperStack;
  const tree = boardIndex(doc);
  const planeHit = new Map<string, (q: Vec2) => boolean>();
  const covered = (l: LayerId, ignoreVoids: boolean): ((q: Vec2) => boolean) => {
    const key = `${l}:${ignoreVoids}`;
    let f = planeHit.get(key);
    if (f) return f;
    if (l >= L.PLANE1 && l <= L.PLANE16) {
      const pieces = planeCopper(doc, l).flatMap((a) => a.regions);
      const t = new RBush<BBox & { k: number }>();
      t.load(pieces.map((p, k) => ({ ...bboxOf(p.outline), k })));
      f = (q) => t.search({ minX: q.x, minY: q.y, maxX: q.x, maxY: q.y }).some((x) => { const p = pieces[x.k]!; return pointInPoly(q, p.outline) && (ignoreVoids || !p.holes.some((h) => pointInPoly(q, h))); });
    } else {
      f = (q) => tree.search({ minX: q.x, minY: q.y, maxX: q.x, maxY: q.y }).some((s) => s.layer === l && !s.role && (doc.prims[s.prim]!.kind === 'region' || doc.prims[s.prim]!.kind === 'fill' || inPour(doc.prims[s.prim]!)) && distance(s.g, { t: 'circle', c: q, r: 0 } as Geom) <= 0);
    }
    planeHit.set(key, f);
    return f;
  };
  doc.prims.forEach((p, i) => {
    if ((p.kind !== 'track' && p.kind !== 'arc') || !inSubject(c, i) || p.net === NO_NET || inPour(p) || p.keepout || !isSignal(p.layer)) return;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; return; }
    if (!r) return;
    const k = stack.indexOf(p.layer);
    if (k < 0) return;
    const refs = [stack[k - 1], stack[k + 1]].filter((x): x is LayerId => x !== undefined);
    if (!refs.length) return;
    const gap = len(r.rule, 'GAP', '5mil'), voids = r.rule.bag.bool('EXCLUDEPADORVIASVOIDS');
    const off = p.width / 2 + gap;
    // Points along the track, each with the two points off its edges
    const pts: { q: Vec2; n: Vec2 }[] = [];
    if (p.kind === 'track') {
      const dx = p.b.x - p.a.x, dy = p.b.y - p.a.y, L0 = Math.hypot(dx, dy) || 1, n = Math.max(1, Math.ceil(L0 / mil(5)));
      for (let s = 0; s <= n; s++) pts.push({ q: { x: p.a.x + (dx * s) / n, y: p.a.y + (dy * s) / n }, n: { x: -dy / L0, y: dx / L0 } });
    } else {
      const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360, n = Math.max(2, Math.ceil(((sweep * Math.PI) / 180) * p.r / mil(5)));
      for (let s = 0; s <= n; s++) { const t = ((p.start + (sweep * s) / n) * Math.PI) / 180; pts.push({ q: { x: p.c.x + p.r * Math.cos(t), y: p.c.y + p.r * Math.sin(t) }, n: { x: Math.cos(t), y: Math.sin(t) } }); }
    }
    const ok = (l: LayerId) => {
      const f = covered(l, voids);
      let bad = 0;
      for (const { q, n } of pts) if (!f(q) || !f({ x: q.x + n.x * off, y: q.y + n.y * off }) || !f({ x: q.x - n.x * off, y: q.y - n.y * off })) bad++;
      return bad;
    };
    const worst = refs.map((l) => [l, ok(l)] as const).sort((x, y) => x[1] - y[1])[0]!;
    if (!worst[1]) return;
    push(c, { kind: 'ReturnPath', rule: ruleName(r.rule), prims: [i], at: 'a' in p ? p.a : p.c,
      message: `Return Path Constraint: ${describe(doc, i)}: ${ln(doc, worst[0])} doesn't run under it ${boardLength(doc, gap)} past its edges for ${boardLength(doc, Math.min(1, worst[1] / pts.length) * (p.kind === 'track' ? Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) : arcLen(p)))}` });
  });
}

/* ─── Testpoints ─────────────────────────────────────────────────────────────────────── */

/**
 * A pad's or via's testpoint marks: Fabrication (Pads6 / Vias6 flags byte 1 bit 0x80 top, byte 2
 * bit 0x01 bottom, as KiCad reads them), Assembly (Pads6 subrecord 5 bytes 118 / 119, Vias6 bytes
 * 207 / 208 of a record of 246 bytes or more, bit 0x01 [est]).
 */
export function testpointMarks(doc: PcbDocument, p: PcbPrim, k: 'Fabrication' | 'Assembly'): { top: boolean; bottom: boolean } {
  if (p.kind !== 'pad' && p.kind !== 'via') return { top: false, bottom: false };
  const s = doc.streams.get(p.src.storage)?.records[p.src.index]?.subs[p.kind === 'pad' ? 4 : 0];
  if (!s) return { top: false, bottom: false };
  if (k === 'Fabrication') return { top: s.length > 2 && (s[1]! & 0x80) !== 0, bottom: s.length > 2 && (s[2]! & 0x01) !== 0 };
  if (p.kind === 'pad') return { top: s.length > 119 && (s[118]! & 1) !== 0, bottom: s.length > 119 && (s[119]! & 1) !== 0 };
  return { top: s.length >= 246 && (s[207]! & 1) !== 0, bottom: s.length >= 246 && (s[208]! & 1) !== 0 };
}

/** Testpoint Style: each testpoint's size, hole, side, grid and place under a component against the rule. */
function testpointStyle(c: Ctx, k: 'Fabrication' | 'Assembly'): void {
  const { doc } = c;
  const kind = `${k}Testpoint`;
  const list = rules(c, kind);
  let under: RBush<BBox & { comp: number }> | null = null;
  const underComponent = (q: Vec2, own: number) => {
    if (!under) {
      under = new RBush();
      under.load(doc.prims.flatMap((p) => (p.kind === 'body' && p.outline.length >= 3 ? [{ ...bboxOf(p.outline), comp: p.component, outline: p.outline }] : [])) as (BBox & { comp: number })[]);
    }
    return under.search({ minX: q.x, minY: q.y, maxX: q.x, maxY: q.y }).some((x) => x.comp !== own && pointInPoly(q, (x as unknown as { outline: Vec2[] }).outline));
  };
  doc.prims.forEach((p, i) => {
    if ((p.kind !== 'pad' && p.kind !== 'via') || !inSubject(c, i)) return;
    const m = testpointMarks(doc, p, k);
    if (!m.top && !m.bottom) return;
    const r = unaryRule(list, p);
    if (r === HELD) { c.held.n++; return; }
    if (!r) return;
    const b = r.rule.bag;
    const size = p.kind === 'via' ? p.diameter : Math.min((m.top || p.layer !== L.MULTI ? p.top : p.bot).w, (m.top || p.layer !== L.MULTI ? p.top : p.bot).h);
    const bad: string[] = [];
    const minS = len(r.rule, 'MINSIZE', '40mil'), maxS = len(r.rule, 'MAXSIZE', '100mil'), minH = len(r.rule, 'MINHOLESIZE', '0mil'), maxH = len(r.rule, 'MAXHOLESIZE', '40mil');
    if (size < minS - T || size > maxS + T) bad.push(`Size = ${boardLength(doc, size)} (Min=${boardLength(doc, minS)}) (Max=${boardLength(doc, maxS)})`);
    if (p.hole > 0 && (p.hole < minH - T || p.hole > maxH + T)) bad.push(`Hole Size = ${boardLength(doc, p.hole)} (Min=${boardLength(doc, minH)}) (Max=${boardLength(doc, maxH)})`);
    if (m.top && !b.bool('ALLOWSIDETOP', true)) bad.push('on the top side');
    if (m.bottom && !b.bool('ALLOWSIDEBOTTOM', true)) bad.push('on the bottom side');
    if (b.bool('USEGRID')) {
      const g = len(r.rule, 'TESTPOINTGRID', '1mil'), tol = len(r.rule, 'GRIDTOLERANCE', '0.01mil');
      const off = (v: number) => { const x = ((v % g) + g) % g; return Math.min(x, g - x); };
      if (g > T && (off(p.at.x - doc.board.origin.x) > tol + 0.5 || off(p.at.y - doc.board.origin.y) > tol + 0.5)) bad.push(`off the ${boardLength(doc, g)} grid`);
    }
    if (!b.bool('TESTPOINTUNDERCOMPONENT', true) && underComponent(p.at, 'component' in p ? p.component : NO_NET)) bad.push('under a component');
    if (bad.length) push(c, { kind, rule: ruleName(r.rule), prims: [i], at: p.at, message: `${k} Testpoint Style Constraint: ${describe(doc, i)} ${bad.join(', ')}` });
  });
}

/** Testpoint Usage: VALID 0 a testpoint required on each net (of two pads or more), 1 none allowed, 2 either; ALLOWMULTIPLE more than one. */
function testpointUsage(c: Ctx, k: 'Fabrication' | 'Assembly'): void {
  const { doc } = c;
  const kind = `${k}TestPointUsage`;
  const list = rules(c, kind);
  const tps = new Map<number, number[]>(), pads = new Map<number, number>();
  doc.prims.forEach((p, i) => {
    if ((p.kind !== 'pad' && p.kind !== 'via') || p.net === NO_NET) return;
    if (p.kind === 'pad') pads.set(p.net, (pads.get(p.net) ?? 0) + 1);
    const m = testpointMarks(doc, p, k);
    if (m.top || m.bottom) { const a = tps.get(p.net); if (a) a.push(i); else tps.set(p.net, [i]); }
  });
  // The nets latest first, as the suite lists them; its wording "<Kind> Testpoint Usage: Net X - Missing required testpoint"
  // (the other two are [est] in the same form)
  const byNet = [...primsByNet(doc)].sort((a, b) => b[0] - a[0]);
  for (const [net, idx] of byNet) {
    const r = netRule(list, idx.map((i) => doc.prims[i]!));
    if (r === HELD) { c.held.n++; continue; }
    if (!r) continue;
    const valid = r.rule.bag.int('VALID', 0), have = tps.get(net) ?? [];
    const name = doc.nets[net]?.name ?? String(net);
    const at = (doc.prims[have[0] ?? idx[0]!] as { at?: Vec2; a?: Vec2 }).at ?? (doc.prims[idx[0]!] as { a?: Vec2 }).a ?? doc.board.origin;
    if (valid === 0 && !have.length && (pads.get(net) ?? 0) >= 2) push(c, { kind, rule: ruleName(r.rule), prims: idx.slice(0, 1), at, message: `${k} Testpoint Usage: Net ${name} - Missing required testpoint` });
    else if (valid === 1 && have.length) push(c, { kind, rule: ruleName(r.rule), prims: have.slice(0, 1), at, message: `${k} Testpoint Usage: Net ${name} - ${have.length} testpoint${have.length === 1 ? '' : 's'} where none is allowed` });
    else if (valid !== 1 && have.length > 1 && !r.rule.bag.bool('ALLOWMULTIPLE')) push(c, { kind, rule: ruleName(r.rule), prims: have.slice(1, 2), at, message: `${k} Testpoint Usage: Net ${name} - ${have.length} testpoints where one is allowed` });
  }
}
