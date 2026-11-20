/**
 * Fab-house profiles: what a board house can make on its standard service (its own published
 * capabilities; each profile names its page and when it was read). A profile is used two ways:
 * the board's copper is checked against it (a Design Rule Check with the profile's limits in
 * place of the board's rules), and its limits are put into the board's general rules where those
 * allow less than the house can make (rules for particular objects are listed, not changed).
 */
import { cloneRule, newRule, nextRuleName, ruleEnabled, ruleKind, ruleLength, ruleName, rulePriority, ruleScope1, ruleScope2, type PcbRule } from '../formats/altium/rules';
import { formatAltiumLength, type Coord } from '../core/units';
import { runDrc, type DrcReport } from './drc';
import type { PcbDocument } from './pcb';

const mil = (n: number) => Math.round(n * 10_000);
const mm = (n: number) => Math.round((n / 0.0254) * 10_000);

export interface FabProfile {
  id: string;
  name: string;
  /** The service and layer counts it covers. */
  service: string;
  /** The house's capabilities page, and when it was read. */
  source: string;
  read: string;
  track: Coord;
  space: Coord;
  /** Smallest drill, and largest. */
  drill: Coord;
  maxDrill: Coord;
  /** Smallest annular ring (via). */
  ring: Coord;
  holeToHole: Coord;
  /** Copper to the routed board edge. */
  edge: Coord;
  /** Smallest solder mask dam (sliver) between openings; 0: not published. */
  maskSliver: Coord;
  /** Silkscreen to exposed pads; 0: not published. */
  silkToPad: Coord;
  /** Silkscreen line width and text height (for the report only). */
  silkWidth: Coord;
  silkText: Coord;
  notes?: string;
}

const READ = '30 Oct 2026';
const JLC = 'https://jlcpcb.com/capabilities/pcb-capabilities', WAY = 'https://www.pcbway.com/capabilities.html';
const OSH = 'https://docs.oshpark.com/services/', EC = 'https://www.eurocircuits.com/pcb-design-guidelines/classification/';
const AIS = 'https://community.aisler.net/';

/** Each house's standard service as its own pages give it (maxDrill 0: no largest, bigger holes are milled). */
export const FAB_PROFILES: FabProfile[] = [
  { id: 'jlcpcb-2', name: 'JLCPCB', service: '2 layers, 1 oz', source: JLC, read: READ, track: mm(0.10), space: mm(0.10), drill: mm(0.15), maxDrill: mm(6.3),
    ring: mm(0.05), holeToHole: mm(0.20), edge: mm(0.20), maskSliver: mm(0.10), silkToPad: mm(0.15), silkWidth: mm(0.15), silkText: mm(1.0),
    notes: 'Annular ring is the via minimum (pad at least hole + 0.10 mm); plated holes want 0.18 mm. Pad to pad of other nets 0.15 mm, pad holes 0.45 mm apart; 0.3 mm holes carry no surcharge.' },
  { id: 'jlcpcb-4', name: 'JLCPCB', service: '4 and 6 layers, 1 oz outer', source: JLC, read: READ, track: mm(0.09), space: mm(0.09), drill: mm(0.15), maxDrill: mm(6.3),
    ring: mm(0.05), holeToHole: mm(0.20), edge: mm(0.20), maskSliver: mm(0.10), silkToPad: mm(0.15), silkWidth: mm(0.15), silkText: mm(1.0),
    notes: 'Annular ring is the via minimum; plated holes want 0.15 mm. Inner layers: via hole to copper 0.20 mm, plated hole to copper 0.30 mm.' },
  { id: 'pcbway', name: 'PCBWay', service: '2 to 6 layers, 1 oz, no surcharge', source: WAY, read: READ, track: mil(5), space: mil(6), drill: mm(0.20), maxDrill: mm(6.0),
    ring: mil(5), holeToHole: mil(11), edge: mm(0.25), maskSliver: mil(4), silkToPad: 0, silkWidth: mm(0.15), silkText: mm(0.8),
    notes: 'From the Advanced table (its Standard table says 4/4 mil). Component holes want a 10 mil ring and 16 mil between them.' },
  { id: 'oshpark-2', name: 'OSH Park', service: '2 layers', source: `${OSH}two-layer/`, read: READ, track: mil(6), space: mil(6), drill: mil(10), maxDrill: 0,
    ring: mil(5), holeToHole: mil(5), edge: mil(15), maskSliver: mil(4), silkToPad: 0, silkWidth: mil(5), silkText: 0, notes: '1.6 mm, 1 oz; holes over 250 mil are milled.' },
  { id: 'oshpark-4', name: 'OSH Park', service: '4 layers', source: `${OSH}four-layer/`, read: READ, track: mil(5), space: mil(5), drill: mil(10), maxDrill: 0,
    ring: mil(4), holeToHole: mil(5), edge: mil(15), maskSliver: mil(4), silkToPad: 0, silkWidth: mil(5), silkText: 0, notes: 'Plated holes 10 mil from inner copper.' },
  { id: 'oshpark-6', name: 'OSH Park', service: '6 layers', source: `${OSH}six-layer/`, read: READ, track: mil(5), space: mil(5), drill: mil(8), maxDrill: 0,
    ring: mil(4), holeToHole: mil(5), edge: mil(15), maskSliver: mil(4), silkToPad: 0, silkWidth: mil(5), silkText: 0, notes: 'Plated holes 10 mil from inner copper.' },
  { id: 'eurocircuits-proto', name: 'Eurocircuits', service: 'PCB proto (class 6, drill class C)', source: EC, read: READ, track: mm(0.15), space: mm(0.15), drill: mm(0.25), maxDrill: 0,
    ring: mm(0.175), holeToHole: mm(0.15), edge: mm(0.25), maskSliver: mm(0.075), silkToPad: mm(0.10), silkWidth: mm(0.10), silkText: mm(1.0),
    notes: 'Ring from the finished hole (pad at least hole + 0.35 mm). Plated holes of different nets 0.35 mm apart; inner copper 0.40 mm from the edge; white mask wants a 0.13 mm web.' },
  { id: 'eurocircuits-standard', name: 'Eurocircuits', service: 'STANDARD pool (class 8, drill class C)', source: EC, read: READ, track: mm(0.10), space: mm(0.10), drill: mm(0.25), maxDrill: 0,
    ring: mm(0.15), holeToHole: mm(0.15), edge: mm(0.25), maskSliver: mm(0.075), silkToPad: mm(0.10), silkWidth: mm(0.10), silkText: mm(1.0),
    notes: 'Ring from the finished hole (pad at least hole + 0.30 mm outside, + 0.35 mm inside). Plated holes of different nets 0.35 mm apart.' },
  { id: 'aisler-hasl', name: 'Aisler', service: '2 layers, HASL', source: AIS, read: READ, track: mm(0.20), space: mm(0.15), drill: mm(0.30), maxDrill: mm(5.6),
    ring: mm(0.20), holeToHole: mm(0.30), edge: mm(0.30), maskSliver: mm(0.10), silkToPad: mm(0.125), silkWidth: mm(0.15), silkText: mm(0.8),
    notes: 'Plated holes over 0.45 mm want a 0.30 mm ring.' },
  { id: 'aisler-enig', name: 'Aisler', service: '2 and 4 layers, ENIG', source: AIS, read: READ, track: mm(0.125), space: mm(0.125), drill: mm(0.25), maxDrill: mm(5.6),
    ring: mm(0.10), holeToHole: mm(0.30), edge: mm(0.30), maskSliver: mm(0.10), silkToPad: mm(0.125), silkWidth: mm(0.15), silkText: mm(0.8),
    notes: 'Plated holes over 0.45 mm want a 0.30 mm ring.' },
];

/** The constraints a profile sets, as rule kinds and their keys. */
interface Limit { kind: string; label: string; key: string; value: (p: FabProfile) => Coord; /** The rule's own value (its strictest where it has several). */ of: (r: PcbRule) => Coord }

const minWidth = (r: PcbRule) => {
  let v = ruleLength(r, 'MINLIMIT', '10mil');
  for (const k of r.bag.keys()) if (/^(TOPLAYER|BOTTOMLAYER|MIDLAYER\d+)_MINWIDTH$/i.test(k)) v = Math.min(v, ruleLength(r, k, '10mil'));
  return v;
};
/** A Clearance rule's least gap between copper (its object table's hole entries aside). */
const minClearance = (r: PcbRule) => {
  let v = r.bag.has('GENERICCLEARANCE') ? ruleLength(r, 'GENERICCLEARANCE', '10mil') : ruleLength(r, 'GAP', '10mil');
  for (const e of (r.bag.get('OBJECTCLEARANCES') ?? '').split(';')) {
    const m = /^ClearanceObj_(\w+)-ClearanceObj_(\w+):(-?\d+)$/.exec(e.trim());
    if (m && m[1] !== 'Hole' && m[2] !== 'Hole') v = Math.min(v, Number(m[3]));
  }
  return v;
};

export const LIMITS: Limit[] = [
  { kind: 'Width', label: 'Track width', key: 'MINLIMIT', value: (p) => p.track, of: minWidth },
  { kind: 'Clearance', label: 'Copper clearance', key: 'GAP', value: (p) => p.space, of: minClearance },
  { kind: 'HoleSize', label: 'Smallest hole', key: 'MINLIMIT', value: (p) => p.drill, of: (r) => ruleLength(r, 'MINLIMIT', '1mil') },
  { kind: 'MinimumAnnularRing', label: 'Annular ring', key: 'MINIMUMRING', value: (p) => p.ring, of: (r) => ruleLength(r, 'MINIMUMRING', '10mil') },
  { kind: 'HoleToHoleClearance', label: 'Hole to hole', key: 'GAP', value: (p) => p.holeToHole, of: (r) => ruleLength(r, 'GAP', '10mil') },
  { kind: 'BoardOutlineClearance', label: 'Copper to board edge', key: 'GAP', value: (p) => p.edge, of: (r) => (r.bag.has('GENERICCLEARANCE') ? ruleLength(r, 'GENERICCLEARANCE', '0mil') : ruleLength(r, 'GAP', '0mil')) },
  { kind: 'MinimumSolderMaskSliver', label: 'Solder mask sliver', key: 'MINSOLDERMASKWIDTH', value: (p) => p.maskSliver, of: (r) => ruleLength(r, 'MINSOLDERMASKWIDTH', '10mil') },
  { kind: 'SilkToSolderMaskClearance', label: 'Silk to pads', key: 'MINSILKSCREENTOMASKGAP', value: (p) => p.silkToPad, of: (r) => ruleLength(r, 'MINSILKSCREENTOMASKGAP', '10mil') },
];

export interface LimitRow {
  limit: Limit;
  fab: Coord;
  /** The board's enabled rules of the kind, each with its value, and whether it allows less than the house makes. */
  rules: { rule: PcbRule; value: Coord; below: boolean; general: boolean }[];
}

const isGeneral = (r: PcbRule) => /^\s*all\s*$/i.test(ruleScope1(r)) && /^\s*all\s*$/i.test(ruleScope2(r));

/** The board's rules against a profile, limit by limit (those the profile doesn't publish left out). */
export function compareProfile(doc: PcbDocument, p: FabProfile): LimitRow[] {
  return LIMITS.filter((l) => l.value(p) > 0).map((limit) => {
    const fab = limit.value(p);
    const rules = doc.rules.filter((r) => ruleKind(r) === limit.kind && ruleEnabled(r)).sort((a, b) => rulePriority(a) - rulePriority(b))
      .map((rule) => { const value = limit.of(rule); return { rule, value, below: value < fab - 100, general: isGeneral(rule) }; });
    return { limit, fab, rules };
  });
}

/**
 * The board's rules with the profile's limits in its general rules: a general (All, All) rule
 * that allows less than the house makes is raised to it, a missing one is added below the
 * others; rules for particular objects stay as they are (compareProfile lists them).
 */
export function rulesWithProfile(doc: PcbDocument, p: FabProfile): { rules: PcbRule[]; changed: string[] } {
  const rules = doc.rules.map(cloneRule);
  const changed: string[] = [];
  for (const row of compareProfile({ ...doc, rules }, p)) {
    const { limit, fab } = row;
    const general = row.rules.filter((x) => x.general);
    if (!general.length) {
      const r = newRule(limit.kind, nextRuleName(rules, `Fab_${limit.kind}`), Math.max(0, ...rules.filter((x) => ruleKind(x) === limit.kind).map(rulePriority)) + 1);
      setLimit(r, limit, fab);
      rules.push(r);
      changed.push(`${limit.label}: rule ${ruleName(r)} added at ${formatAltiumLength(fab)}`);
      continue;
    }
    for (const g of general) {
      if (!g.below) continue;
      setLimit(g.rule, limit, fab);
      changed.push(`${limit.label}: ${ruleName(g.rule)} ${formatAltiumLength(g.value)} → ${formatAltiumLength(fab)}`);
    }
  }
  return { rules, changed };
}

function setLimit(r: PcbRule, limit: Limit, v: Coord): void {
  const t = formatAltiumLength(v);
  if (limit.kind === 'Width') {
    r.bag.set('MINLIMIT', t);
    for (const k of r.bag.keys()) if (/_MINWIDTH$/i.test(k) && ruleLength(r, k, '0mil') < v) r.bag.set(k, t);
    if (ruleLength(r, 'MAXLIMIT', '10mil') < v) r.bag.set('MAXLIMIT', t);
    if (ruleLength(r, 'PREFEREDWIDTH', '10mil') < v) r.bag.set('PREFEREDWIDTH', t);
    return;
  }
  if (limit.kind === 'Clearance' || limit.kind === 'BoardOutlineClearance') {
    r.bag.set('GAP', t);
    if (r.bag.has('GENERICCLEARANCE')) r.bag.set('GENERICCLEARANCE', t);
    const objs = r.bag.get('OBJECTCLEARANCES');
    if (objs) r.bag.set('OBJECTCLEARANCES', objs.split(';').map((e) => {
      const m = /^(ClearanceObj_(\w+)-ClearanceObj_(\w+)):(-?\d+)$/.exec(e.trim());
      return m && m[2] !== 'Hole' && m[3] !== 'Hole' && Number(m[4]) < v ? `${m[1]}:${v}` : e;
    }).join(';'));
    return;
  }
  r.bag.set(limit.key, t);
  if (limit.kind === 'HoleSize' && ruleLength(r, 'MAXLIMIT', '100mil') < v) r.bag.set('MAXLIMIT', t);
}

/** The profile's limits as a rule set of their own (All, All), for checking the board against the house. */
export function profileRuleSet(p: FabProfile): PcbRule[] {
  const out: PcbRule[] = [];
  for (const limit of LIMITS) {
    const v = limit.value(p);
    if (v <= 0) continue;
    const r = newRule(limit.kind, `${p.name} ${limit.label}`, 1);
    setLimit(r, limit, v);
    if (limit.kind === 'Width') r.bag.set('MAXLIMIT', '10000mil');
    if (limit.kind === 'HoleSize') r.bag.set('MAXLIMIT', p.maxDrill ? formatAltiumLength(p.maxDrill) : '10000mil');
    if (limit.kind === 'SilkToSolderMaskClearance') { r.bag.set('SCOPE1EXPRESSION', 'IsPad'); r.bag.set('CLEARANCETOEXPOSEDCOPPER', 'TRUE'); }
    out.push(r);
  }
  // Shorts are faults at any house
  out.push(newRule('ShortCircuit', `${p.name} Short-Circuit`, 1));
  return out;
}

/** The board's copper and holes checked against what the house can make (the board's own rules aside). */
export function checkAgainstProfile(doc: PcbDocument, p: FabProfile): DrcReport {
  const rules = profileRuleSet(p);
  const view: PcbDocument = { ...doc, rules, waivers: [] };
  return runDrc(view, new Set(rules.map(ruleKind)));
}

