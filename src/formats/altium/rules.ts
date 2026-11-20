/**
 * PCB design rules (Rules6) and object classes (Classes6).
 *
 * Rules6/Data: per record a 2-byte prefix, the rule kind's number (Clearance 0, Width 2 …, as
 * RULE_KIND_IDS), then u32 length and a |KEY=VALUE| property block (KiCad's importer skips the
 * two bytes; AD17 goes by them). RULEKIND names the rule type; constraint values
 * are lengths like "10mil". Classes6/Data: plain u32-length property records; KIND 0 is a net
 * class whose members are M0, M1, ….
 * Unmodified records keep their bytes; the stream is rebuilt only when a rule changes.
 */
import { BinReader, BinWriter } from '../bin';
import { PropertyBag } from './props';
import { formatAltiumLength, mil, parseLength, type Coord } from '../../core/units';
import { DEFAULT_STIMULUS, SI_RULES, siNum, siText, stimulusOf, stimulusProps, type SiUnit } from '../../si/rules';

export interface PcbRule {
  prefix: Uint8Array;
  bag: PropertyBag;
}

/** A Classes6 record: its bag is what is written back (members M0…Mn). */
export interface PcbClass { name: string; kind: number; members: string[]; superClass: boolean; bag: PropertyBag }

export function splitRuleRecords(stream: Uint8Array): PcbRule[] {
  const r = new BinReader(stream);
  const out: PcbRule[] = [];
  while (r.remaining >= 6) {
    const prefix = r.bytes(2).slice();
    const n = r.u32() & 0x00ffffff;
    out.push({ prefix, bag: PropertyBag.parse(r.bytes(Math.min(n, r.remaining))) });
  }
  return out;
}

/**
 * The number before each Rules6 record, by RULEKIND: the ones seen in AD17–AD20 boards, the rest
 * [est: by the order of AD's rule kinds].
 */
export const RULE_KIND_IDS: Record<string, number> = {
  Clearance: 0, ParallelSegment: 1, Width: 2, Length: 3, MatchedLengths: 4, StubLength: 5, DaisyChainStubLength: 5, PlaneConnect: 6, RoutingTopology: 7,
  RoutingPriority: 8, RoutingLayers: 9, RoutingCorners: 10, RoutingVias: 11, PlaneClearance: 12, SolderMaskExpansion: 13, PasteMaskExpansion: 14,
  ShortCircuit: 15, UnRoutedNet: 16, ViasUnderSMD: 17, MaximumViaCount: 18, MinimumAnnularRing: 19, PolygonConnect: 20, AcuteAngle: 21,
  RoomDefinition: 22, SMDToCorner: 23, ComponentClearance: 24, ComponentRotations: 25, PermittedLayers: 26, NetsToIgnore: 27,
  HoleSize: 42, FabricationTestpoint: 43, FabricationTestPointUsage: 44, LayerPairs: 48, FanoutControl: 49, Height: 50, DiffPairsRouting: 51,
  HoleToHoleClearance: 52, MinimumSolderMaskSliver: 53, SilkToSolderMaskClearance: 54, SilkToSilkClearance: 55, NetAntennae: 56,
  AssemblyTestpoint: 57, AssemblyTestPointUsage: 58, SilkToBoardRegionClearance: 59, UnpouredPolygon: 62,
  // Seen in AD boards and in their Rules To Check lists
  OvershootFalling: 29, OvershootRising: 30, MaxMinImpedance: 33, SupplyNets: 41,
  // The rest of Signal Integrity's, between those seen [est: by AD's order of them]
  SignalStimulus: 28, UndershootFalling: 31, UndershootRising: 32, SignalTopValue: 34, SignalBaseValue: 35, FlightTimeRising: 36, FlightTimeFalling: 37,
  MaxSlopeRising: 39, MaxSlopeFalling: 40, Testpoint: 43, TestPointUsage: 44, UnConnectedPin: 45, SMDToPlane: 46,
  SMDNeckDown: 47, SMDEntry: 60, BoardOutlineClearance: 63, BackDrilling: 64, Creepage: 65, ReturnPath: 66, ComponentOrientations: 25,
};
/**
 * A record's number: the one it came with from the file (the table is partly estimated), unless
 * it is the 2 earlier Konium versions gave every rule they made; a new rule takes the table's.
 */
const kindPrefix = (kind: string | undefined, had: Uint8Array): Uint8Array => {
  const id = kind !== undefined ? RULE_KIND_IDS[kind] : undefined;
  if (id === undefined) return had;
  const was = had.length >= 2 ? had[0]! | (had[1]! << 8) : -1;
  if (was >= 0 && (was !== 2 || kind === 'Width')) return had;
  return new Uint8Array([id & 0xff, id >> 8]);
};

export function joinRuleRecords(rules: PcbRule[]): Uint8Array {
  const w = new BinWriter(32 * 1024);
  for (const rule of rules) { const d = rule.bag.toBytes(); w.bytes(kindPrefix(rule.bag.get('RULEKIND'), rule.prefix)); w.u32(d.length); w.bytes(d); }
  return w.finish();
}

export function readClasses(bags: PropertyBag[]): PcbClass[] {
  return bags.map((b) => {
    const members: string[] = [];
    for (let i = 0; b.has(`M${i}`); i++) members.push(b.get(`M${i}`)!);
    return { name: b.get('NAME') ?? '', kind: b.int('KIND'), members, superClass: b.bool('SUPERCLASS'), bag: b };
  });
}

/* ─── Typed access ───────────────────────────────────────────────────────────────────── */

export const ruleKind = (r: PcbRule) => r.bag.get('RULEKIND') ?? '';
export const ruleName = (r: PcbRule) => r.bag.get('NAME') ?? ruleKind(r);
export const rulePriority = (r: PcbRule) => r.bag.int('PRIORITY', 1);
export const ruleEnabled = (r: PcbRule) => (r.bag.has('ENABLED') ? r.bag.bool('ENABLED') : true);
export const ruleScope1 = (r: PcbRule) => r.bag.get('SCOPE1EXPRESSION') ?? 'All';
export const ruleScope2 = (r: PcbRule) => r.bag.get('SCOPE2EXPRESSION') ?? 'All';
export function ruleLength(r: PcbRule, key: string, fallback: string): Coord {
  return parseLength(r.bag.get(key)) ?? parseLength(fallback)!;
}

/**
 * A connect style rule's setting for one pad or via: AD 10 and later keep them per object kind when the
 * rule's Advanced mode is on — PlaneConnect as PAD.x and VIA.x, PolygonConnect as THPAD.x, SMDPAD.x and
 * VIA.x — else unprefixed.
 */
export function connectValue(r: PcbRule, key: string, prim?: { kind: string; hole?: number }): string | undefined {
  const kind = r.bag.get('RULEKIND');
  const prefix = !prim ? (kind === 'PolygonConnect' ? 'THPAD' : 'PAD') : prim.kind === 'via' ? 'VIA' : kind === 'PolygonConnect' ? (prim.hole ? 'THPAD' : 'SMDPAD') : 'PAD';
  return r.bag.get(`${prefix}.${key}`) ?? r.bag.get(key);
}
export function connectLength(r: PcbRule, key: string, fallback: string, prim?: { kind: string; hole?: number }): Coord {
  return parseLength(connectValue(r, key, prim)) ?? parseLength(fallback)!;
}

/** Rule kinds Konium checks, with the constraint keys the editor shows. */
export interface RuleKindInfo { kind: string; category: string; label: string; fields: { key: string; label: string; def: string; unit?: SiUnit }[] }

export const RULE_KINDS: RuleKindInfo[] = [
  { kind: 'Clearance', category: 'Electrical', label: 'Clearance', fields: [{ key: 'GAP', label: 'Minimum Clearance', def: '10mil' }] },
  { kind: 'ShortCircuit', category: 'Electrical', label: 'Short-Circuit', fields: [] },
  { kind: 'UnRoutedNet', category: 'Electrical', label: 'Un-Routed Net', fields: [] },
  { kind: 'Width', category: 'Routing', label: 'Width', fields: [{ key: 'MINLIMIT', label: 'Min Width', def: '10mil' }, { key: 'PREFEREDWIDTH', label: 'Preferred Width', def: '10mil' }, { key: 'MAXLIMIT', label: 'Max Width', def: '10mil' }] },
  { kind: 'RoutingVias', category: 'Routing', label: 'Routing Via Style', fields: [{ key: 'MINWIDTH', label: 'Via Diameter Min', def: '50mil' }, { key: 'WIDTH', label: 'Via Diameter Preferred', def: '50mil' }, { key: 'MAXWIDTH', label: 'Via Diameter Max', def: '50mil' }, { key: 'MINHOLEWIDTH', label: 'Via Hole Size Min', def: '28mil' }, { key: 'HOLEWIDTH', label: 'Via Hole Size Preferred', def: '28mil' }, { key: 'MAXHOLEWIDTH', label: 'Via Hole Size Max', def: '28mil' }] },
  { kind: 'SolderMaskExpansion', category: 'Mask', label: 'Solder Mask Expansion', fields: [{ key: 'EXPANSION', label: 'Expansion', def: '4mil' }] },
  { kind: 'PasteMaskExpansion', category: 'Mask', label: 'Paste Mask Expansion', fields: [{ key: 'EXPANSION', label: 'Expansion', def: '0mil' }] },
  { kind: 'PlaneClearance', category: 'Plane', label: 'Power Plane Clearance', fields: [{ key: 'CLEARANCE', label: 'Clearance', def: '20mil' }] },
  { kind: 'PolygonConnect', category: 'Plane', label: 'Polygon Connect Style', fields: [{ key: 'RELIEFCONDUCTORWIDTH', label: 'Conductor Width', def: '10mil' }, { key: 'AIRGAPWIDTH', label: 'Air-Gap Width', def: '10mil' }] },
  { kind: 'MinimumAnnularRing', category: 'Manufacturing', label: 'Minimum Annular Ring', fields: [{ key: 'MINIMUMRING', label: 'Minimum Annular Ring', def: '10mil' }] },
  { kind: 'HoleSize', category: 'Manufacturing', label: 'Hole Size', fields: [{ key: 'MINLIMIT', label: 'Minimum', def: '1mil' }, { key: 'MAXLIMIT', label: 'Maximum', def: '100mil' }] },
  { kind: 'HoleToHoleClearance', category: 'Manufacturing', label: 'Hole To Hole Clearance', fields: [{ key: 'GAP', label: 'Hole To Hole Clearance', def: '10mil' }] },
  { kind: 'MinimumSolderMaskSliver', category: 'Manufacturing', label: 'Minimum Solder Mask Sliver', fields: [{ key: 'MINSOLDERMASKWIDTH', label: 'Minimum Solder Mask Sliver', def: '10mil' }] },
  { kind: 'SilkToSolderMaskClearance', category: 'Manufacturing', label: 'Silk To Solder Mask Clearance', fields: [{ key: 'MINSILKSCREENTOMASKGAP', label: 'Clearance', def: '10mil' }] },
  { kind: 'SilkToSilkClearance', category: 'Manufacturing', label: 'Silk To Silk Clearance', fields: [{ key: 'SILKTOSILKCLEARANCE', label: 'Silk Text to Any Silk Object', def: '10mil' }] },
  { kind: 'BoardOutlineClearance', category: 'Manufacturing', label: 'Board Outline Clearance', fields: [{ key: 'GAP', label: 'Clearance', def: '0mil' }] },
  { kind: 'Height', category: 'Placement', label: 'Height', fields: [{ key: 'MINHEIGHT', label: 'Minimum', def: '0mil' }, { key: 'PREFHEIGHT', label: 'Preferred', def: '500mil' }, { key: 'MAXHEIGHT', label: 'Maximum', def: '1000mil' }] },
  { kind: 'Creepage', category: 'Electrical', label: 'Creepage Distance', fields: [{ key: 'DISTANCE', label: 'Creepage Distance', def: '10mil' }] },
  { kind: 'ReturnPath', category: 'High Speed', label: 'Return Path', fields: [{ key: 'GAP', label: 'Minimum Gap To Return Path', def: '5mil' }] },
  { kind: 'BackDrilling', category: 'High Speed', label: 'Max Via Stub Length (Back Drilling)', fields: [{ key: 'MAXSTUBLENGTH', label: 'Max Stub Length', def: '15mil' }, { key: 'HOLEOVERSIZE', label: 'Back Drill Oversize', def: '4mil' }] },
  ...(['FabricationTestpoint', 'AssemblyTestpoint'] as const).map((kind) => ({ kind, category: 'Testpoint', label: kind === 'AssemblyTestpoint' ? 'Assembly Testpoint Style' : 'Fabrication Testpoint Style', fields: [
    { key: 'MINSIZE', label: 'Size Min', def: '40mil' }, { key: 'PREFEREDSIZE', label: 'Size Preferred', def: '60mil' }, { key: 'MAXSIZE', label: 'Size Max', def: '100mil' },
    { key: 'MINHOLESIZE', label: 'Hole Size Min', def: '0mil' }, { key: 'PREFEREDHOLESIZE', label: 'Hole Size Preferred', def: '32mil' }, { key: 'MAXHOLESIZE', label: 'Hole Size Max', def: '40mil' },
    { key: 'TESTPOINTGRID', label: 'Grid', def: '1mil' }, { key: 'GRIDTOLERANCE', label: 'Grid Tolerance', def: '0.01mil' }] })),
  ...SI_RULES.filter((r) => r.kind !== 'SignalStimulus').map((r) => ({ kind: r.kind, category: 'Signal Integrity', label: r.label, fields: r.fields.map(({ key, label, def, unit }) => ({ key, label, def, unit })) })),
];

export const CATEGORIES = ['Electrical', 'Routing', 'SMT', 'Mask', 'Plane', 'Testpoint', 'Manufacturing', 'High Speed', 'Placement', 'Signal Integrity'];

/** Every rule type of Altium's Design Rules tree, in tree order: [RULEKIND, label, category]. */
const TREE: [string, string, string][] = [
  ['Clearance', 'Clearance', 'Electrical'], ['ShortCircuit', 'Short-Circuit', 'Electrical'], ['UnRoutedNet', 'Un-Routed Net', 'Electrical'],
  ['UnConnectedPin', 'Un-Connected Pin', 'Electrical'], ['ModifiedPolygon', 'Modified Polygon', 'Electrical'], ['Creepage', 'Creepage Distance', 'Electrical'],
  ['Width', 'Width', 'Routing'], ['RoutingTopology', 'Routing Topology', 'Routing'], ['RoutingPriority', 'Routing Priority', 'Routing'],
  ['RoutingLayers', 'Routing Layers', 'Routing'], ['RoutingCorners', 'Routing Corners', 'Routing'], ['RoutingVias', 'Routing Via Style', 'Routing'],
  ['FanoutControl', 'Fanout Control', 'Routing'], ['DiffPairsRouting', 'Differential Pairs Routing', 'Routing'],
  ['SMDToCorner', 'SMD To Corner', 'SMT'], ['SMDToPlane', 'SMD To Plane', 'SMT'], ['SMDNeckDown', 'SMD Neck-Down', 'SMT'], ['SMDEntry', 'SMD Entry', 'SMT'],
  ['SolderMaskExpansion', 'Solder Mask Expansion', 'Mask'], ['PasteMaskExpansion', 'Paste Mask Expansion', 'Mask'],
  ['PlaneConnect', 'Power Plane Connect Style', 'Plane'], ['PlaneClearance', 'Power Plane Clearance', 'Plane'], ['PolygonConnect', 'Polygon Connect Style', 'Plane'],
  ['FabricationTestpoint', 'Fabrication Testpoint Style', 'Testpoint'], ['FabricationTestPointUsage', 'Fabrication Testpoint Usage', 'Testpoint'],
  ['AssemblyTestpoint', 'Assembly Testpoint Style', 'Testpoint'], ['AssemblyTestPointUsage', 'Assembly Testpoint Usage', 'Testpoint'],
  ['MinimumAnnularRing', 'Minimum Annular Ring', 'Manufacturing'], ['AcuteAngle', 'Acute Angle', 'Manufacturing'], ['HoleSize', 'Hole Size', 'Manufacturing'],
  ['LayerPairs', 'Layer Pairs', 'Manufacturing'], ['HoleToHoleClearance', 'Hole To Hole Clearance', 'Manufacturing'],
  ['MinimumSolderMaskSliver', 'Minimum Solder Mask Sliver', 'Manufacturing'], ['SilkToSolderMaskClearance', 'Silk To Solder Mask Clearance', 'Manufacturing'],
  ['SilkToSilkClearance', 'Silk To Silk Clearance', 'Manufacturing'], ['NetAntennae', 'Net Antennae', 'Manufacturing'], ['BoardOutlineClearance', 'Board Outline Clearance', 'Manufacturing'],
  ['ParallelSegment', 'Parallel Segment', 'High Speed'], ['Length', 'Length', 'High Speed'], ['MatchedLengths', 'Matched Lengths', 'High Speed'],
  ['StubLength', 'Daisy Chain Stub Length', 'High Speed'], ['ViasUnderSMD', 'Vias Under SMD', 'High Speed'], ['MaximumViaCount', 'Maximum Via Count', 'High Speed'],
  ['BackDrilling', 'Max Via Stub Length (Back Drilling)', 'High Speed'], ['ReturnPath', 'Return Path', 'High Speed'],
  ['RoomDefinition', 'Room Definition', 'Placement'], ['ComponentClearance', 'Component Clearance', 'Placement'], ['ComponentOrientations', 'Component Orientations', 'Placement'],
  ['PermittedLayers', 'Permitted Layers', 'Placement'], ['NetsToIgnore', 'Nets to Ignore', 'Placement'], ['Height', 'Height', 'Placement'],
  ...SI_RULES.map((r) => [r.kind, r.label, 'Signal Integrity'] as [string, string, string]),
];
export const RULE_TREE = TREE.map(([kind, label, category]) => ({ kind, label, category }));

export function kindLabel(kind: string): string {
  return RULE_TREE.find((t) => t.kind === kind)?.label ?? RULE_KINDS.find((k) => k.kind === kind)?.label ?? kind.replace(/([a-z])([A-Z])/g, '$1 $2');
}
export function kindCategory(kind: string): string {
  return RULE_TREE.find((t) => t.kind === kind)?.category ?? (/shoot|impedance|slope|flight|supply|stimulus|signal/i.test(kind) ? 'Signal Integrity' : 'Electrical');
}
/** Rules that compare two objects ("Where The First / Second Object Matches"). */
export const BINARY_KINDS = new Set(['Clearance', 'ShortCircuit', 'HoleToHoleClearance', 'MinimumSolderMaskSliver', 'SilkToSolderMaskClearance',
  'SilkToSilkClearance', 'ComponentClearance', 'ParallelSegment', 'Creepage']);

/** Altium-style length: 7.874mil, 10mil. */
export const mils = (c: Coord) => `${(c / 10_000).toFixed(3).replace(/\.?0+$/, '')}mil`;

/**
 * The rule as Altium prints it in the DRC report, e.g. "Clearance Constraint (Gap=10mil) (All),(All)";
 * `len` writes its lengths (the board's units: model/drc's lengthIn), mils when not given.
 */
export function ruleDescription(r: PcbRule, len: (c: Coord) => string = mils): string {
  const k = ruleKind(r), s1 = ruleScope1(r), s2 = ruleScope2(r);
  const L = (key: string, def: string) => len(ruleLength(r, key, def));
  switch (k) {
    case 'Clearance': return `Clearance Constraint (Gap=${L('GAP', '10mil')}) (${s1}),(${s2})`;
    case 'ShortCircuit': return `Short-Circuit Constraint (Allowed=${r.bag.bool('ALLOWED') ? 'Yes' : 'No'}) (${s1}),(${s2})`;
    case 'UnRoutedNet': return `Un-Routed Net Constraint ( (${s1}) )`;
    case 'Width': return `Width Constraint (Min=${L('MINLIMIT', '10mil')}) (Max=${L('MAXLIMIT', '10mil')}) (Preferred=${L('PREFEREDWIDTH', '10mil')}) (${s1})`;
    case 'HoleSize': return `Hole Size Constraint (Min=${L('MINLIMIT', '1mil')}) (Max=${L('MAXLIMIT', '100mil')}) (${s1})`;
    case 'HoleToHoleClearance': return `Hole To Hole Clearance (Gap=${L('GAP', '10mil')}) (${s1}),(${s2})`;
    case 'MinimumAnnularRing': return `Minimum Annular Ring (Minimum=${L('MINIMUMRING', '10mil')}) (${s1})`;
    case 'BoardOutlineClearance': return `Board Outline Clearance (Gap=${L('GAP', '0mil')}) (${s1})`;
    case 'SignalStimulus': { const st = stimulusOf((k) => r.bag.get(k)); return `Signal Stimulus (Kind=${st.kind}) (Start Level=${st.startHigh ? 'High' : 'Low'}) (Start=${siText(st.start).trim()}s) (Stop=${siText(st.stop).trim()}s) (Period=${siText(st.period).trim()}s) (${s1})`; }
    default: {
      // Signal Integrity's: its label and its limits [est: AD's wording]
      const si = SI_RULES.find((x) => x.kind === k);
      if (si) return `${si.label} Constraint ${si.fields.map((f) => `(${f.label.replace(/ \(.*\)$/, '').replace('Minimum', 'Min').replace('Maximum', 'Max')}=${siText(siNum(r.bag.get(f.key) ?? f.def)).trim()}${f.unit === 'Ω' ? 'Ω' : f.unit})`).join(' ')} (${s1})`;
      return BINARY_KINDS.has(k) ? `${kindLabel(k)} (${s1}),(${s2})` : `${kindLabel(k)} (${s1})`;
    }
  }
}

export const cloneRule = (r: PcbRule): PcbRule => ({ prefix: r.prefix.slice(), bag: r.bag.clone() });

/** Altium's naming for a new rule: Clearance_1, Clearance_2 … */
export function nextRuleName(rules: PcbRule[], kind: string): string {
  const names = new Set(rules.map((r) => ruleName(r).toLowerCase()));
  for (let i = 1; ; i++) if (!names.has(`${kind}_${i}`.toLowerCase())) return `${kind}_${i}`;
}

let uid = 0;
const uniqueId = () => `DSGN${(Date.now().toString(36) + (++uid).toString(36)).toUpperCase().slice(-8)}`;

/** A rule record with Altium's common keys and the kind's default constraints. */
export function newRule(kind: string, name: string, priority: number): PcbRule {
  const info = RULE_KINDS.find((k) => k.kind === kind);
  const props: Record<string, string> = {
    SELECTION: 'FALSE', LAYER: 'UNKNOWN', LOCKED: 'FALSE', POLYGONOUTLINE: 'FALSE', USERROUTED: 'TRUE', KEEPOUT: 'FALSE', UNIONINDEX: '0',
    RULEKIND: kind, NETSCOPE: 'DifferentNets', LAYERKIND: 'SameLayer', SCOPE1EXPRESSION: 'All', SCOPE2EXPRESSION: 'All',
    NAME: name, ENABLED: 'TRUE', PRIORITY: String(priority), COMMENT: '', UNIQUEID: uniqueId(), DEFINEDBYLOGICALDOCUMENT: 'FALSE',
  };
  for (const f of info?.fields ?? []) props[f.key] = f.def;
  if (kind === 'ShortCircuit') props.ALLOWED = 'FALSE';
  if (kind === 'PolygonConnect') { props.CONNECTSTYLE = 'Relief'; props.RELIEFENTRIES = '4'; }
  if (kind === 'SilkToSolderMaskClearance') props.CLEARANCETOEXPOSEDCOPPER = 'TRUE';
  // AD's defaults [est where marked in their checks]
  if (kind === 'MaximumViaCount') props.LIMIT = '1000';
  if (kind === 'PermittedLayers') { props['TOP LAYER_V5'] = 'TRUE'; props['BOTTOM LAYER_V5'] = 'TRUE'; }
  if (kind === 'FabricationTestpoint' || kind === 'AssemblyTestpoint') Object.assign(props, { TESTPOINTUNDERCOMPONENT: 'TRUE', ALLOWSIDETOP: 'TRUE', ALLOWSIDEBOTTOM: 'TRUE', USEGRID: 'TRUE', ...(kind === 'FabricationTestpoint' ? { SIDE: '3' } : {}) });
  if (kind === 'FabricationTestPointUsage' || kind === 'AssemblyTestPointUsage') Object.assign(props, { VALID: '0', ALLOWMULTIPLE: 'FALSE' });
  if (kind === 'BackDrilling') Object.assign(props, { USETOPBACKDRILL: 'FALSE', USEBOTTOMBACKDRILL: 'TRUE' });
  if (kind === 'Creepage') Object.assign(props, { IGNOREINTERNALLAYERS: 'TRUE', APPLYTOPOLYGONPOUR: 'FALSE' });
  if (kind === 'SignalStimulus') Object.assign(props, stimulusProps(DEFAULT_STIMULUS));
  return { prefix: kindPrefix(kind, new Uint8Array([2, 0])), bag: PropertyBag.from(props) };
}

/** Altium's default rule set for a new PCB (used when a board has no Rules6). */
export function defaultRules(): PcbRule[] {
  const list: [string, string][] = [
    ['Clearance', 'Clearance'], ['ShortCircuit', 'ShortCircuit'], ['UnRoutedNet', 'UnRoutedNet'], ['Width', 'Width'],
    ['RoutingVias', 'RoutingVias'], ['SolderMaskExpansion', 'SolderMaskExpansion'], ['PasteMaskExpansion', 'PasteMaskExpansion'],
    ['PlaneClearance', 'PlaneClearance'], ['PolygonConnect', 'PolygonConnect'], ['HoleSize', 'HoleSize'],
    ['HoleToHoleClearance', 'HoleToHoleClearance'], ['MinimumSolderMaskSliver', 'MinimumSolderMaskSliver'],
    ['SilkToSolderMaskClearance', 'SilkToSolderMaskClearance'], ['SilkToSilkClearance', 'SilkToSilkClearance'], ['Height', 'Height'],
  ];
  const out = list.map(([k, n]) => newRule(k, n, 1));
  // As AD's: silk is kept off pads only
  for (const r of out) if (ruleKind(r) === 'SilkToSolderMaskClearance') r.bag.set('SCOPE1EXPRESSION', 'IsPad');
  return out;
}

export const lengthText = (c: Coord) => formatAltiumLength(c);
export { mil };

/** A length rule key kept in internal units with no unit (SMD To Corner's DISTANCE), or with one. */
const rawLength = (r: PcbRule, key: string, def: number): number => { const v = r.bag.get(key); if (v === undefined) return def; return /[a-z]/i.test(v) ? ruleLength(r, key, '0mil') : Number(v) || 0; };

/** The rule as the desktop suite's DRC report heads it (ruleDescription, with the constraints of the kinds it leaves bare). */
export function ruleHeading(r: PcbRule, len: (c: Coord) => string): string {
  const k = ruleKind(r), s1 = ruleScope1(r), s2 = ruleScope2(r);
  const l = (key: string, def: string) => len(ruleLength(r, key, def));
  const yn = (key: string) => (r.bag.bool(key) ? 'Yes' : 'No');
  switch (k) {
    case 'NetAntennae': return `Net Antennae (Tolerance=${l('NETANTENNAETOLERANCE', '0mil')}) (${s1})`;
    case 'MinimumSolderMaskSliver': return `Minimum Solder Mask Sliver (Gap=${l('MINSOLDERMASKWIDTH', '10mil')}) (${s1}),(${s2})`;
    case 'SilkToSolderMaskClearance': return `Silk To Solder Mask (Clearance=${l('MINSILKSCREENTOMASKGAP', '10mil')}) (${s1}),(${s2})`;
    case 'SilkToSilkClearance': return `Silk to Silk (Clearance=${l('SILKTOSILKCLEARANCE', '10mil')}) (${s1}),(${s2})`;
    case 'SilkToBoardRegionClearance': return `Silk To Board Region Clearance (Gap=${l('GAP', '0mil')}) (${s1})`;
    case 'Height': return `Height Constraint (Min=${l('MINHEIGHT', '0mil')}) (Max=${l('MAXHEIGHT', '1000mil')}) (Prefered=${l('PREFHEIGHT', '500mil')}) (${s1})`;
    case 'ComponentClearance': return `Component Clearance Constraint ( Horizontal Gap = ${l('GAP', '10mil')}, Vertical Gap = ${l('VERTICALGAP', '10mil')} ) (${s1}),(${s2})`;
    case 'AcuteAngle': return `Acute Angle Constraint (Minimum=${(Number(r.bag.get('MINIMUM') ?? 90) || 90).toFixed(3)}) (${s1})`;
    case 'SMDToCorner': return `SMD To Corner Constraint (Distance=${len(rawLength(r, 'DISTANCE', 0))}) (${s1})`;
    case 'SMDNeckDown': return `SMD Neck-Down Constraint (Percent=${r.bag.get('PERCENT') ?? '50'}%) (${s1})`;
    case 'ViasUnderSMD': return `Vias Under SMD Constraint (Allowed=${yn('ALLOWED')}) (${s1})`;
    case 'UnConnectedPin': return `Un-Connected Pin Constraint (${s1})`;
    case 'RoutingVias': return `Routing Via (MinHoleWidth=${l('MINHOLEWIDTH', '28mil')}) (MaxHoleWidth=${l('MAXHOLEWIDTH', '28mil')}) (PreferredHoleWidth=${l('HOLEWIDTH', '28mil')}) (MinWidth=${l('MINWIDTH', '50mil')}) (MaxWidth=${l('MAXWIDTH', '50mil')}) (PreferedWidth=${l('WIDTH', '50mil')}) (${s1})`;
    case 'LayerPairs': return `Layer Pairs (Allowed Layer Pairs Only=${r.bag.bool('ENFORCE', true) ? 'Yes' : 'No'}) (${s1})`;
    case 'UnpouredPolygon': return `Modified Polygon (Allow modified: ${yn('ALLOWMODIFIED')}), (Allow shelved: ${yn('ALLOWSHELVED') === 'Yes' || r.bag.bool('ALLOWUNPOURED') ? 'Yes' : 'No'})`;
    case 'RoutingLayers': return `Routing Layers(${s1})`;
    // [checked: AD17's relief heading; the direct and no connect wordings are est]
    case 'PlaneConnect': {
      const style = r.bag.get('PLANECONNECTSTYLE') ?? 'Relief';
      return `Power Plane Connect Rule(${/^direct/i.test(style) ? 'Direct Connect' : /^no/i.test(style) ? 'No Connect' : 'Relief Connect'} )(Expansion=${l('RELIEFEXPANSION', '20mil')}) (Conductor Width=${l('RELIEFCONDUCTORWIDTH', '10mil')}) (Air Gap=${l('RELIEFAIRGAP', '10mil')}) (Entries=${r.bag.get('RELIEFENTRIES') ?? '4'}) (${s1})`;
    }
    case 'FabricationTestpoint': case 'AssemblyTestpoint': return `${k === 'AssemblyTestpoint' ? 'Assembly' : 'Fabrication'} Testpoint Style (Under Component=${yn('TESTPOINTUNDERCOMPONENT')}) (${s1})`;
    case 'FabricationTestPointUsage': case 'AssemblyTestPointUsage': return `${k === 'AssemblyTestPointUsage' ? 'Assembly' : 'Fabrication'} Testpoint Usage (Valid =${['One Required', 'Prohibited', 'Don\'t Care'][r.bag.int('VALID', 0)] ?? 'One Required'}, Allow multiple per net=${yn('ALLOWMULTIPLE')}) (${s1})`;
    default: return ruleDescription(r, len);
  }
}
