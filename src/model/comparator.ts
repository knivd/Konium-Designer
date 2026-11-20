/**
 * Project › Show Differences and Design › Update Schematics: AD's comparator between the
 * compiled schematics and the board. Every difference has the side(s) it can be resolved
 * towards: the board takes everything (Update PCB); the schematics take what AD lets the board
 * send back — designators, comments and footprints [est: no pin or part swaps yet].
 * Components pair by unique ID, then by designator (as Update PCB pairs them).
 */
import type { Change } from '../core/undo';
import { natural, type CompiledProject, type ObjRef } from './compile';
import { NO_NET, type PcbDocument } from './pcb';
import { SR, bagOf, type SchDocument } from './sch';
import { addRecords, setProps } from './schEdit';
import { footprintModelBag } from './libModels';
import { PropertyBag } from '../formats/altium/props';
import { boardParts, matchComponents, planPcbUpdate, type FootprintFinder, type PcbEcoItem } from './pcbEco';

/** A change the schematics take, on every part of the package. */
export type SchEcoItem =
  | { kind: 'schDesignator'; group: 'Change Component Designators'; action: 'Modify'; object: string; refs: ObjRef[]; from: string; to: string }
  | { kind: 'schComment'; group: 'Change Component Comments'; action: 'Modify'; object: string; refs: ObjRef[]; designator: string; from: string; to: string }
  | { kind: 'schFootprint'; group: 'Change Component Footprints'; action: 'Modify'; object: string; refs: ObjRef[]; designator: string; from: string; to: string };

export interface Difference {
  /** AD's comparison kind, as the Differences dialog groups them. */
  group: string;
  /** What each side has ('' where it has nothing). */
  sch: string;
  pcb: string;
  /** Resolved towards the board (Update PCB). */
  toPcb?: PcbEcoItem;
  /** Resolved towards the schematics (Update Schematics). */
  toSch?: SchEcoItem;
}

/** AD's comparison kinds [est: the names as the Differences dialog shows them]. */
const GROUPS = ['Extra Components', 'Different Designators', 'Different Footprints', 'Different Comments', 'Extra Nets', 'Extra Pins in Nets'];

/** Every difference between the compiled project and the board, grouped in AD's order. */
export function compareProject(project: CompiledProject, doc: PcbDocument, find: FootprintFinder): Difference[] {
  const out: Difference[] = [];
  const parts = new Map(boardParts(project).map((c) => [c.designator, c]));
  const matched = matchComponents(project, doc);
  const schOf = new Map([...matched].map(([des, i]) => [i, parts.get(des)!]));
  for (const it of planPcbUpdate(project, doc, find)) {
    switch (it.kind) {
      case 'addComponent': out.push({ group: 'Extra Components', sch: it.object, pcb: '', toPcb: it }); break;
      case 'removeComponent': out.push({ group: 'Extra Components', sch: '', pcb: it.object, toPcb: it }); break;
      case 'addNet': out.push({ group: 'Extra Nets', sch: it.net, pcb: '', toPcb: it }); break;
      case 'addPin': out.push({ group: 'Extra Pins in Nets', sch: `${it.designator}-${it.pad} in ${it.net}`, pcb: '', toPcb: it }); break;
      case 'removePin': out.push({ group: 'Extra Pins in Nets', sch: '', pcb: `${it.designator}-${it.pad} in ${it.net}`, toPcb: it }); break;
      case 'changeDesignator': {
        const c = schOf.get(it.index)!;
        out.push({ group: 'Different Designators', sch: it.to, pcb: it.from, toPcb: it,
          toSch: { kind: 'schDesignator', group: 'Change Component Designators', action: 'Modify', object: `${it.to} -> ${it.from}`, refs: c.refs, from: it.to, to: it.from } });
        break;
      }
      case 'changeFootprint': {
        const c = schOf.get(it.index)!;
        out.push({ group: 'Different Footprints', sch: `${c.designator}: ${it.to}`, pcb: `${it.designator}: ${it.from}`, toPcb: it,
          toSch: { kind: 'schFootprint', group: 'Change Component Footprints', action: 'Modify', object: `${c.designator}: ${it.to} -> ${it.from}`, refs: c.refs, designator: c.designator, from: it.to, to: it.from } });
        break;
      }
      case 'changeComment': {
        const c = schOf.get(it.index)!;
        out.push({ group: 'Different Comments', sch: `${c.designator}: ${it.to}`, pcb: `${it.designator}: ${it.from}`, toPcb: it,
          toSch: { kind: 'schComment', group: 'Change Component Comments', action: 'Modify', object: `${c.designator}: ${it.to} -> ${it.from}`, refs: c.refs, designator: c.designator, from: it.to, to: it.from } });
        break;
      }
    }
  }
  // Nets only the board has (with pads on them): the board keeps them until they're removed there [est]
  const schNets = new Set(project.nets.map((n) => n.name));
  const padNets = new Set(doc.prims.filter((p) => p.kind === 'pad' && p.net !== NO_NET).map((p) => (p.kind === 'pad' ? p.net : -1)));
  for (const n of doc.nets) if (n.name && !schNets.has(n.name) && padNets.has(n.index)) out.push({ group: 'Extra Nets', sch: '', pcb: n.name });
  return out.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || natural(a.sch || a.pcb, b.sch || b.pcb));
}

/** Design › Update Schematics: what the board sends back. */
export const planSchUpdate = (project: CompiledProject, doc: PcbDocument, find: FootprintFinder): SchEcoItem[] =>
  compareProject(project, doc, find).flatMap((d) => (d.toSch ? [d.toSch] : []));

/* ─── Applying to a sheet ─────────────────────────────────────────────────────────── */

const kids = (doc: SchDocument, owner: number) => doc.objects.filter((o) => o.owner === owner);
const paramOf = (doc: SchDocument, owner: number, name: string) =>
  kids(doc, owner).find((o) => o.record === SR.PARAMETER && bagOf(doc, o)?.get('NAME')?.toLowerCase() === name.toLowerCase());

/** Whether an item can be made on this sheet now; null when it can. */
export function validateSchItem(doc: SchDocument, it: SchEcoItem, indices: number[]): string | null {
  for (const i of indices) {
    const o = doc.objects[i];
    if (o?.kind !== 'component') return `Unknown Component ${'designator' in it ? it.designator : it.from}`;
    if (it.kind === 'schComment' && !paramOf(doc, i, 'Comment')) return `${it.designator} has no Comment parameter`;
  }
  return null;
}

/**
 * The edits for one item on one sheet, made one after another inside a transaction (`add`
 * applies each, so the next is built on the sheet as it then is).
 */
export function applySchItem(doc: SchDocument, it: SchEcoItem, indices: number[], add: (c: Change) => void): void {
  for (const i of indices) {
    if (it.kind === 'schDesignator') {
      const t = kids(doc, i).find((o) => o.kind === 'text' && o.role === 'designator');
      if (t) add(setProps(doc, t.index, { TEXT: it.to }));
    } else if (it.kind === 'schComment') {
      const cm = paramOf(doc, i, 'Comment');
      if (!cm) continue;
      const text = bagOf(doc, cm)?.get('TEXT') ?? '';
      // =Value: the parameter it shows takes the new words [est: as AD resolves an indirect comment]
      const target = text.startsWith('=') ? paramOf(doc, i, text.slice(1)) ?? cm : cm;
      add(setProps(doc, target.index, { TEXT: it.to }));
    } else {
      applyFootprint(doc, i, it.to, add);
    }
  }
}

/** The part's footprint becomes `name`: that model made current, or a new one (PCB Library Any) when it has none of that name. */
function applyFootprint(doc: SchDocument, comp: number, name: string, add: (c: Change) => void): void {
  const lists = kids(doc, comp).filter((o) => o.record === SR.IMPLEMENTATION_LIST);
  const models = lists.flatMap((l) => kids(doc, l.index)).filter((o) => o.record === SR.IMPLEMENTATION && bagOf(doc, o)?.get('MODELTYPE')?.toUpperCase() === 'PCBLIB');
  const want = models.find((o) => (bagOf(doc, o)?.get('MODELNAME') ?? '').toLowerCase() === name.toLowerCase());
  for (const m of models) if (m !== want && bagOf(doc, m)?.bool('ISCURRENT')) add(setProps(doc, m.index, { ISCURRENT: null }));
  if (want) { if (!bagOf(doc, want)?.bool('ISCURRENT')) add(setProps(doc, want.index, { ISCURRENT: 'T' })); return; }
  const bags: PropertyBag[] = [];
  const base = doc.records.length - 1;
  let list = lists[0]?.index;
  if (list === undefined) { bags.push(PropertyBag.from({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: comp })); list = base; }
  const impl = base + bags.length;
  bags.push(footprintModelBag(list, { name, current: true }));
  bags.push(PropertyBag.from({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl }), PropertyBag.from({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl }));
  add(addRecords(doc, bags));
}

/** The parts of an item on each sheet: sheet name → component object indices. */
export function refsBySheet(it: SchEcoItem): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const r of it.refs) m.set(r.sheet, [...(m.get(r.sheet) ?? []), r.index]);
  return m;
}

/**
 * Choose Documents To Compare › Advanced Mode, one schematic against the board: the differences
 * about that sheet's parts and nets (the board's extra parts belong to no sheet and are left out).
 */
export function sheetDifferences(diffs: Difference[], project: CompiledProject, sheet: string): Difference[] {
  const on = (s: string) => s.toLowerCase() === sheet.toLowerCase();
  const parts = new Set(project.components.filter((c) => on(c.sheet) || c.refs.some((r) => on(r.sheet))).map((c) => c.designator));
  const nets = new Set(project.nets.filter((n) => n.sheets.some(on)).map((n) => n.name));
  return diffs.filter((d) => {
    const it = d.toPcb, back = d.toSch;
    if (back) return parts.has(back.kind === 'schDesignator' ? back.from : back.designator);
    if (!it) return false;
    switch (it.kind) {
      case 'addComponent': return parts.has(it.comp.designator);
      case 'changeDesignator': return parts.has(it.to);
      case 'changeFootprint': case 'changeComment': return parts.has(it.designator);
      case 'addNet': return nets.has(it.net);
      case 'addPin': case 'removePin': return parts.has(it.designator) || nets.has(it.net);
      default: return false;
    }
  });
}
