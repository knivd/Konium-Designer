/**
 * Simulation models on parts, as AD keeps them: an IMPLEMENTATION record with MODELTYPE=SIM
 * (its MODELNAME, and a model file — .mdl or .ckt — by MODELDATAFILEKIND0 /
 * MODELDATAFILEENTITY0) whose parameters sit under its IMPL_PARAMS record: Kind, SubKind,
 * Spice Prefix, Netlist (the netlist template), Port Map, Excluded Parts and the model's own
 * values (Initial Voltage …); the map definers tie the part's pins to the model's.
 *
 * Netlist templates: @DESIGNATOR, %1 %2 … (the nets on the model's pins), @NAME or @"NAME
 * WITH SPACES" (a parameter's value, the model's first, then the part's), &NAME (the same, empty
 * when missing), ?NAME¦text¦ or ?"NAME"text (text only when the parameter has a value; AD stores
 * the bar as ¦, a plain | is read too), ~NAME¦text¦ (only when it has none) [est], #¦text¦ (only
 * when a ?NAME after it gives something, as PARAMS: before a subcircuit's values) [est], and
 * @MODEL / &MODEL (the model's name).
 */
import { PropertyBag as PB, type PropertyBag } from '../formats/altium/props';
import { uniqueId as newUid } from './schEdit';
import { SR, bagOf, ownedBy, type SchDocument, type SchObject } from './sch';

export interface SimModel {
  name: string;
  kind: string;
  subKind: string;
  prefix: string;
  netlist: string;
  /** Model pin → part pin designator (identity when the library gives no map). */
  portMap: Map<string, string>;
  /** The model file: MDL (.model) or CKT (.subckt), by name ('' when the model is its template alone). */
  fileKind: string;
  fileName: string;
  /** Parameters (upper-case names) with their values. */
  params: Map<string, string>;
  excludedParts: string;
  description?: string;
  /** The model's parameter names as written (in order). */
  names?: string[];
}

/** The current SIM model of a part (its component record at ci), or null. */
export function simModelOf(doc: SchDocument, ci: number): SimModel | null {
  const owned = ownedBy(doc);
  const lists = (owned.get(ci) ?? []).filter((o) => o.record === SR.IMPLEMENTATION_LIST);
  const impls = lists.flatMap((l) => (owned.get(l.index) ?? []).filter((o) => o.record === SR.IMPLEMENTATION));
  const sims = impls.filter((o) => (bagOf(doc, o)?.get('MODELTYPE') ?? '').toUpperCase() === 'SIM');
  const pick = sims.find((o) => bagOf(doc, o)?.bool('ISCURRENT')) ?? sims[0];
  return pick ? simModelAt(doc, pick.index) : null;
}

/** The SIM model of an implementation record. */
export function simModelAt(doc: SchDocument, implIndex: number): SimModel | null {
  const owned = ownedBy(doc);
  const pick = doc.objects[implIndex];
  if (!pick) return null;
  const b = bagOf(doc, pick)!;
  const params = new Map<string, string>();
  const order: string[] = [];
  const portMap = new Map<string, string>();
  for (const kid of owned.get(pick.index) ?? []) {
    if (kid.record === SR.IMPL_PARAMS) {
      for (const p of owned.get(kid.index) ?? []) {
        const pb = bagOf(doc, p);
        if (p.record === SR.PARAMETER && pb?.get('NAME')) { params.set(pb.get('NAME')!.toUpperCase(), pb.get('TEXT') ?? ''); order.push(pb.get('NAME')!); }
      }
    } else if (kid.record === SR.MAP_DEFINER_LIST) {
      for (const md of owned.get(kid.index) ?? []) {
        const mb = bagOf(doc, md);
        const from = mb?.get('DESINTF');
        if (md.record === SR.MAP_DEFINER && from !== undefined) portMap.set(mb!.get('DESIMP0') ?? from, from);
      }
    }
  }
  const take = (k: string) => { const v = params.get(k) ?? ''; params.delete(k); return v; };
  return {
    name: b.get('MODELNAME') ?? '', kind: take('KIND'), subKind: take('SUBKIND'), prefix: take('SPICE PREFIX'), netlist: take('NETLIST'),
    portMap, fileKind: (b.get('MODELDATAFILEKIND0') ?? '').toUpperCase(), fileName: b.get('MODELDATAFILEENTITY0') ?? '',
    params, excludedParts: take('EXCLUDED PARTS'), description: b.get('DESCRIPTION') ?? '',
    names: order.filter((n) => !['KIND', 'SUBKIND', 'SPICE PREFIX', 'NETLIST', 'EXCLUDED PARTS'].includes(n.toUpperCase())),
  };
}

/**
 * The record that holds a SIM model parameter's value on a part (its component record at ci): the
 * model's own parameter, or, where the model leaves it to the part ('*' or nothing), the part's
 * parameter of that name. Null: neither has it.
 */
export function simParamHolder(doc: SchDocument, ci: number, name: string): number | null {
  const owned = ownedBy(doc), want = name.toUpperCase();
  const named = (list: readonly SchObject[]) => list.find((o) => o.record === SR.PARAMETER && (doc.records[o.index + 1]?.bag?.get('NAME') ?? '').toUpperCase() === want);
  const lists = (owned.get(ci) ?? []).filter((o) => o.record === SR.IMPLEMENTATION_LIST);
  const impls = lists.flatMap((l) => (owned.get(l.index) ?? []).filter((o) => o.record === SR.IMPLEMENTATION));
  const sims = impls.filter((o) => (bagOf(doc, o)?.get('MODELTYPE') ?? '').toUpperCase() === 'SIM');
  const pick = sims.find((o) => bagOf(doc, o)?.bool('ISCURRENT')) ?? sims[0];
  if (!pick) return null;
  const own = (owned.get(pick.index) ?? []).filter((o) => o.record === SR.IMPL_PARAMS).map((k) => named(owned.get(k.index) ?? [])).find((o) => o);
  const text = own ? bagOf(doc, own)?.get('TEXT') ?? '' : '';
  if (own && text !== '' && text !== '*') return own.index;
  const parts = named(owned.get(ci) ?? []);
  return parts ? parts.index : own ? own.index : null;
}

/** A SIM model as the records AD keeps it in (under an implementation list at listIndex; new records from object index base). */
export function simModelBags(listIndex: number, base: number, m: { name: string; description: string; kind: string; subKind: string; prefix: string; netlist: string; current: boolean;
  file?: { entity: string; kind: string }; params: [string, string][]; portMap: [string, string][] }): PropertyBag[] {
  const bags: PropertyBag[] = [];
  const impl = base;
  bags.push(PB.from({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: listIndex, USECOMPONENTLIBRARY: true, DESCRIPTION: m.description, MODELNAME: m.name, MODELTYPE: 'SIM',
    ...(m.file?.entity ? { DATAFILECOUNT: 1, MODELDATAFILEENTITY0: m.file.entity, MODELDATAFILEKIND0: m.file.kind } : {}), ...(m.current ? { ISCURRENT: true } : {}), UNIQUEID: newUid() }));
  const maps = base + bags.length;
  bags.push(PB.from({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl }));
  for (const [modelPin, partPin] of m.portMap) bags.push(PB.from({ RECORD: SR.MAP_DEFINER, OWNERINDEX: maps, DESINTF: partPin, DESIMPCOUNT: 1, DESIMP0: modelPin }));
  const plist = base + bags.length;
  bags.push(PB.from({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl }));
  const all: [string, string][] = [['Kind', m.kind], ['SubKind', m.subKind], ['Spice Prefix', m.prefix], ...(m.netlist ? [['Netlist', m.netlist] as [string, string]] : []), ...m.params];
  for (const [name, text] of all) bags.push(PB.from({ RECORD: SR.PARAMETER, OWNERINDEX: plist, OWNERPARTID: -1, NAME: name, TEXT: text, ISHIDDEN: true }));
  return bags;
}

/** AD's netlist templates for its general models, by sub-kind (used when a model gives none) [est]. */
export const DEFAULT_TEMPLATES: Record<string, string> = {
  resistor: '@DESIGNATOR %1 %2 @VALUE',
  'resistor(semiconductor)': '@DESIGNATOR %1 %2 &MODEL &VALUE ?LENGTH¦L=@LENGTH¦ ?WIDTH¦W=@WIDTH¦ ?TEMPERATURE¦TEMP=@TEMPERATURE¦',
  'resistor(variable)': '@DESIGNATOR %1 %2 @VALUE',
  capacitor: '@DESIGNATOR %1 %2 @VALUE ?"INITIAL VOLTAGE"¦IC=@"INITIAL VOLTAGE"¦',
  'capacitor(semiconductor)': '@DESIGNATOR %1 %2 &MODEL &VALUE ?LENGTH¦L=@LENGTH¦ ?WIDTH¦W=@WIDTH¦ ?"INITIAL VOLTAGE"¦IC=@"INITIAL VOLTAGE"¦',
  inductor: '@DESIGNATOR %1 %2 @VALUE ?"INITIAL CURRENT"¦IC=@"INITIAL CURRENT"¦',
  diode: '@DESIGNATOR %1 %2 @MODEL ?AREA¦@AREA¦ ?OFF¦OFF¦ ?"INITIAL VOLTAGE"¦IC=@"INITIAL VOLTAGE"¦ ?TEMPERATURE¦TEMP=@TEMPERATURE¦',
  bjt: '@DESIGNATOR %1 %2 %3 @MODEL ?AREA¦@AREA¦ ?OFF¦OFF¦ ?"INITIAL B-E VOLTAGE"¦IC=@"INITIAL B-E VOLTAGE", @"INITIAL C-E VOLTAGE"¦ ?TEMPERATURE¦TEMP=@TEMPERATURE¦',
  mosfet: '@DESIGNATOR %1 %2 %3 %3 @MODEL ?LENGTH¦L=@LENGTH¦ ?WIDTH¦W=@WIDTH¦ ?"DRAIN AREA"¦AD=@"DRAIN AREA"¦ ?"SOURCE AREA"¦AS=@"SOURCE AREA"¦ ?OFF¦OFF¦',
  jfet: '@DESIGNATOR %1 %2 %3 @MODEL ?AREA¦@AREA¦ ?OFF¦OFF¦',
  'spice subcircuit': '@DESIGNATOR %1 %2 %3 %4 %5 %6 %7 %8 @MODEL',
  'dc source': '@DESIGNATOR %1 %2 DC @VALUE ?"AC MAGNITUDE"¦AC @"AC MAGNITUDE" &"AC PHASE"¦',
  sinusoidal: '@DESIGNATOR %1 %2 DC @"DC MAGNITUDE" SIN(@OFFSET @AMPLITUDE @FREQUENCY @DELAY @"DAMPING FACTOR" @PHASE) ?"AC MAGNITUDE"¦AC @"AC MAGNITUDE" &"AC PHASE"¦',
  pulse: '@DESIGNATOR %1 %2 DC @"DC MAGNITUDE" PULSE(@"INITIAL VALUE" @"PULSED VALUE" @"TIME DELAY" @"RISE TIME" @"FALL TIME" @"PULSE WIDTH" @PERIOD) ?"AC MAGNITUDE"¦AC @"AC MAGNITUDE" &"AC PHASE"¦',
  'piecewise linear': '@DESIGNATOR %1 %2 DC @"DC MAGNITUDE" PWL(@"TIME / VALUE PAIRS") ?"AC MAGNITUDE"¦AC @"AC MAGNITUDE" &"AC PHASE"¦',
  exponential: '@DESIGNATOR %1 %2 DC @"DC MAGNITUDE" EXP(@"INITIAL VALUE" @"PULSED VALUE" @"RISE DELAY TIME" @"RISE TIME CONSTANT" @"FALL DELAY TIME" @"FALL TIME CONSTANT") ?"AC MAGNITUDE"¦AC @"AC MAGNITUDE" &"AC PHASE"¦',
  'single-frequency fm': '@DESIGNATOR %1 %2 DC @"DC MAGNITUDE" SFFM(@OFFSET @AMPLITUDE @"CARRIER FREQUENCY" @"MODULATION INDEX" @"SIGNAL FREQUENCY") ?"AC MAGNITUDE"¦AC @"AC MAGNITUDE" &"AC PHASE"¦',
  'set initial condition': '.IC V(%1)=@"INITIAL VOLTAGE"',
  'initial node voltage guess': '.NODESET V(%1)=@"INITIAL VOLTAGE"',
  'voltage-controlled': '@DESIGNATOR %1 %2 %3 %4 @GAIN',
  'current-controlled': '@DESIGNATOR %1 %2 @"CONTROLLING SOURCE" @GAIN',
  equation: '@DESIGNATOR %1 %2 V=@EQUATION',
  'voltage controlled switch': '@DESIGNATOR %1 %2 %3 %4 @MODEL ?"INITIAL STATE"¦@"INITIAL STATE"¦',
  'current controlled switch': '@DESIGNATOR %1 %2 @"CONTROLLING SOURCE" @MODEL ?"INITIAL STATE"¦@"INITIAL STATE"¦',
};

/** The SPICE letter a model's kind stands for, when it gives no prefix. */
export function defaultPrefix(m: SimModel): string {
  const k = `${m.kind} ${m.subKind}`.toLowerCase();
  if (/resistor/.test(k)) return 'R';
  if (/capacitor/.test(k)) return 'C';
  if (/coupled/.test(k)) return 'K';
  if (/inductor/.test(k)) return 'L';
  if (/diode/.test(k)) return 'D';
  if (/bjt/.test(k)) return 'Q';
  if (/mosfet/.test(k)) return 'M';
  if (/jfet/.test(k)) return 'J';
  if (/voltage controlled switch/.test(k)) return 'S';
  if (/current controlled switch/.test(k)) return 'W';
  if (/current source/.test(k)) return /voltage-controlled/.test(k) ? 'G' : /current-controlled/.test(k) ? 'F' : /equation/.test(k) ? 'B' : 'I';
  if (/voltage source/.test(k)) return /voltage-controlled/.test(k) ? 'E' : /current-controlled/.test(k) ? 'H' : /equation/.test(k) ? 'B' : 'V';
  if (/subcircuit/.test(k)) return 'X';
  return '';
}

export interface TemplateContext {
  designator: string;
  model: string;
  /** The net on a model pin (1-based), or undefined when the pin isn't there. */
  net(pin: number): string | undefined;
  /** A parameter's value (the model's, then the part's), or undefined. */
  param(name: string): string | undefined;
}

/**
 * A netlist template expanded: what it gives, and what was missing (a required parameter or
 * pin). Values are passed as written (SPICE reads 10k, 4.7u …).
 */
export function expandTemplate(tpl: string, ctx: TemplateContext): { line: string; missing: string[] } {
  const missing: string[] = [];
  const BAR = /[|¦]/;
  let out = '';
  let i = 0;
  // A name: "QUOTED NAME" or a run of letters, digits and _
  const name = (): string => {
    if (tpl[i] === '"') { const j = tpl.indexOf('"', i + 1); const n = tpl.slice(i + 1, j < 0 ? tpl.length : j); i = j < 0 ? tpl.length : j + 1; return n; }
    const m = /^[A-Za-z_][\w]*/.exec(tpl.slice(i));
    if (!m) return '';
    i += m[0].length;
    return m[0];
  };
  /** The text a ? ~ or # applies to: ¦…¦ (or |…|), else up to the next space (a quoted @"…" taken whole). */
  const body = (): string => {
    if (BAR.test(tpl[i] ?? '')) { const close = tpl[i]!; const j = tpl.indexOf(close, i + 1); const t = tpl.slice(i + 1, j < 0 ? tpl.length : j); i = j < 0 ? tpl.length : j + 1; return t; }
    let j = i;
    while (j < tpl.length && tpl[j] !== ' ') { if (tpl[j] === '"') { const k = tpl.indexOf('"', j + 1); j = k < 0 ? tpl.length : k + 1; } else j++; }
    const t = tpl.slice(i, j); i = j;
    return t;
  };
  const has = (n: string) => { const v = ctx.param(n.toUpperCase()); return v !== undefined && v !== '' && v !== '*'; };
  const value = (n: string, required: boolean): string => {
    const u = n.toUpperCase();
    if (u === 'DESIGNATOR') return ctx.designator;
    if (u === 'MODEL' && (ctx.param('MODEL') ?? '') === '') return ctx.model;
    const v = ctx.param(u);
    if (v === undefined || v === '' || v === '*') { if (required) missing.push(n); return ''; }
    return v;
  };
  while (i < tpl.length) {
    const ch = tpl[i]!;
    if (ch === '@' || ch === '&') { i++; out += value(name(), ch === '@'); continue; }
    if (ch === '%') {
      const m = /^%(\d+)/.exec(tpl.slice(i));
      if (!m) { out += ch; i++; continue; }
      i += m[0].length;
      const net = ctx.net(Number(m[1]));
      if (net === undefined) missing.push(`pin ${m[1]}`);
      out += net ?? '';
      continue;
    }
    if (ch === '?' || ch === '~') {
      i++;
      const n = name();
      const text = body();
      if (has(n) === (ch === '?')) out += expandTemplate(text, ctx).line;
      continue;
    }
    if (ch === '#' && BAR.test(tpl[i + 1] ?? '')) {
      i++;
      const text = body();
      // Shown when any ?NAME further on has a value
      const later = [...tpl.slice(i).matchAll(/\?("([^"]*)"|[A-Za-z_]\w*)/g)].map((m) => m[2] ?? m[1]!);
      if (later.some(has)) out += expandTemplate(text, ctx).line;
      continue;
    }
    out += ch;
    i++;
  }
  return { line: out.replace(/\s+/g, ' ').trim(), missing };
}

/**
 * A part's records about to be placed (partRecords' items: 0 the component, owners by index)
 * with a SIM model value set: the model's own parameter, or — where the model takes it from the
 * part ("*") — the part's parameter of that name. False when the model has no such parameter.
 */
export function setSimParam(items: { bag: PropertyBag; owner: number }[], name: string, value: string): boolean {
  const rec = (i: number) => items[i]!.bag.int('RECORD', -1);
  const impls = items.map((_, i) => i).filter((i) => rec(i) === SR.IMPLEMENTATION && (items[i]!.bag.get('MODELTYPE') ?? '').toUpperCase() === 'SIM');
  const impl = impls.find((i) => items[i]!.bag.bool('ISCURRENT')) ?? impls[0];
  if (impl === undefined) return false;
  const lists = items.map((_, i) => i).filter((i) => rec(i) === SR.IMPL_PARAMS && items[i]!.owner === impl);
  const p = items.findIndex((it) => rec(items.indexOf(it)) === SR.PARAMETER && lists.includes(it.owner) && (it.bag.get('NAME') ?? '').toLowerCase() === name.toLowerCase());
  if (p < 0) return false;
  if ((items[p]!.bag.get('TEXT') ?? '') !== '*') { items[p]!.bag.set('TEXT', value); return true; }
  const own = items.find((it) => it.owner === 0 && it.bag.int('RECORD', -1) === SR.PARAMETER && (it.bag.get('NAME') ?? '').toLowerCase() === name.toLowerCase());
  if (own) own.bag.set('TEXT', value);
  return !!own;
}
