/**
 * PCB rules carried on a schematic (Place › Directives › PCB Layout): a "Rule" parameter whose
 * value is the rule as properties, '=' written {} and '|' written [] (so it fits a property
 * record), e.g. RULEKIND{}MaxMinImpedance[]MINIMUM{}49.00[]MAXIMUM{}51.00. The sheet shows the
 * rule's summary — "Impedance Constraint [Min = 49.00   Max = 51.00   ]" — as AD17 does: its
 * DESCRIPTION when the record has one, else made from the rule.
 */
import { PropertyBag } from '../formats/altium/props';
import { binToBytes } from '../formats/text';
import { RULE_KINDS, kindLabel } from '../formats/altium/rules';

/** The rule a Rule parameter's value holds. */
export function ruleFromParameter(text: string): PropertyBag {
  const props = text.replace(/\{\}/g, '=').replace(/\[\]/g, '|');
  return PropertyBag.parse(binToBytes(`|${props}`));
}

/** What a rule's summary lists, per kind: [key, label]. */
const SUMMARY: Record<string, [string, string][]> = {
  MaxMinImpedance: [['MINIMUM', 'Min'], ['MAXIMUM', 'Max']],
  Width: [['PREFEREDWIDTH', 'Pref Width'], ['MINLIMIT', 'Min Width'], ['MAXLIMIT', 'Max Width']],
  Clearance: [['GAP', 'Gap']],
  DiffPairsRouting: [['MINLIMIT', 'Min Width'], ['MAXLIMIT', 'Max Width'], ['MINGAP', 'Min Gap'], ['MAXGAP', 'Max Gap']],
  RoutingVias: [['WIDTH', 'Pref Size'], ['HOLEWIDTH', 'Pref Hole Size']],
  Length: [['MINLIMIT', 'Min'], ['MAXLIMIT', 'Max']],
  MatchedLengths: [['TOLERANCE', 'Tolerance']],
};

/** "Impedance Constraint [Min = 49.00   Max = 51.00   ]"; an undefined rule says so. */
export function ruleSummary(text: string): string {
  const r = ruleFromParameter(text);
  const kind = r.get('RULEKIND');
  if (!kind) return 'Undefined';
  const label = kind === 'MaxMinImpedance' ? 'Impedance' : kindLabel(kind);
  const fields = SUMMARY[kind] ?? RULE_KINDS.find((k) => k.kind === kind)?.fields.map((f): [string, string] => [f.key, f.label]) ?? [];
  const parts = fields.filter(([k]) => r.has(k)).map(([k, l]) => `${l} = ${r.get(k)}   `).join('');
  return `${label} Constraint [${parts}]`;
}

/** What a parameter shows on the sheet when it is a directive's rule (null: show it as usual). */
export function ruleParameterText(name: string | undefined, text: string, description: string | undefined): string | null {
  if ((name ?? '').toLowerCase() !== 'rule' && !/RULEKIND\{\}/i.test(text)) return null;
  return description || ruleSummary(text);
}

/** A rule as a Rule parameter's value: its properties with '=' written {} and '|' written [] (Add as Rule...). */
export function ruleParameterValue(props: Record<string, string>): string {
  return Object.entries(props).filter(([, v]) => v !== '').map(([k, v]) => `${k}{}${v}`).join('[]');
}

/** Whether a parameter holds a design rule (its value has a RULEKIND; an undefined Rule parameter doesn't). */
export const isRuleParameter = (_name: string | undefined, text: string): boolean => /RULEKIND\{\}/i.test(text);

/**
 * The design rules a compiled project carries to its board (AD: rules from parameters): a
 * Parameter Set's Rule parameters for the net it sits on, scoped InNet('…'); a component's for
 * it, scoped InComponent('…'). Rules with no kind (an undefined PCB Layout directive) are left out.
 */
export function carriedRules(project: { nets: { name: string; rules?: string[] }[]; components: { designator: string; rules?: string[] }[] }): { scope: string; where: string; bag: PropertyBag }[] {
  const out: { scope: string; where: string; bag: PropertyBag }[] = [];
  const take = (texts: string[] | undefined, scope: string, where: string) => {
    for (const t of texts ?? []) { const bag = ruleFromParameter(t); if (bag.get('RULEKIND')) out.push({ scope, where, bag }); }
  };
  for (const n of project.nets) take(n.rules, `InNet('${n.name}')`, `Net ${n.name}`);
  for (const c of project.components) take(c.rules, `InComponent('${c.designator}')`, `Component ${c.designator}`);
  return out;
}
