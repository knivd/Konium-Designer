/**
 * Differential pairs (DifferentialPairs6: NAME, POSITIVENETNAME, NEGATIVENETNAME, as AD17 writes
 * them) and what the board does with them: the PCB panel's Differential Pairs Editor (Add,
 * Delete, Edit, Create From Nets), the Differential Pair Rule Wizard, routing them as a pair,
 * the queries InDifferentialPair / InDifferentialPairClass.
 */
import type { Change } from '../core/undo';
import { PropertyBag } from '../formats/altium/props';
import { newUniqueId } from '../formats/altium/board6';
import { NO_NET, type PcbDocument } from './pcb';
import { membersOf } from './pcbClasses';
import { cloneRule, newRule, nextRuleName, ruleEnabled, ruleKind, rulePriority, ruleLength, type PcbRule } from '../formats/altium/rules';
import { formatAltiumLength } from '../core/units';
import { layerToName } from '../formats/altium/pcbdoc';
import { L, isSignal, type LayerId } from './layers';

export interface DiffPair { name: string; pos: string; neg: string; bag: PropertyBag }

export const diffPairsOf = (doc: PcbDocument): DiffPair[] =>
  (doc.diffPairs ?? []).map((b) => ({ name: b.get('NAME') ?? '', pos: b.get('POSITIVENETNAME') ?? '', neg: b.get('NEGATIVENETNAME') ?? '', bag: b }));

/** A new pair as AD17 writes one. */
export function diffPairBag(name: string, pos: string, neg: string): PropertyBag {
  return PropertyBag.fromEntries([
    ['SELECTION', 'FALSE'], ['LAYER', 'TOP'], ['LOCKED', 'FALSE'], ['POLYGONOUTLINE', 'FALSE'], ['USERROUTED', 'TRUE'], ['KEEPOUT', 'FALSE'], ['UNIONINDEX', '0'],
    ['POSITIVENETNAME', pos], ['NEGATIVENETNAME', neg], ['NAME', name], ['GATHERCONTROL', 'FALSE'], ['UNIQUEID', newUniqueId()],
  ]);
}

/** Replace the board's pairs (one undo step). */
export function setDiffPairs(doc: PcbDocument, bags: PropertyBag[]): Change {
  const before = doc.diffPairs ?? [];
  const after = bags.map((b) => b.clone());
  const was = doc.dirty.has('DifferentialPairs6');
  return {
    apply() { doc.diffPairs = after; doc.dirty.add('DifferentialPairs6'); },
    revert() { doc.diffPairs = before; if (!was) doc.dirty.delete('DifferentialPairs6'); },
  };
}

/** The pair a net is in, and which side. */
export function pairOfNet(doc: PcbDocument, net: number): { pair: DiffPair; positive: boolean; partner: number } | null {
  if (net === NO_NET) return null;
  const name = doc.nets[net]?.name.toLowerCase();
  if (!name) return null;
  for (const pair of diffPairsOf(doc)) {
    const pos = pair.pos.toLowerCase() === name, neg = pair.neg.toLowerCase() === name;
    if (!pos && !neg) continue;
    const other = (pos ? pair.neg : pair.pos).toLowerCase();
    const partner = doc.nets.findIndex((n) => n.name.toLowerCase() === other);
    if (partner < 0) continue;
    return { pair, positive: pos, partner };
  }
  return null;
}

/** Create From Nets: pairs whose names differ only by these suffixes (USB_D_P / USB_D_N → USB_D). */
export function pairsFromNets(doc: PcbDocument, posSuffix: string, negSuffix: string, among?: Set<string>): { name: string; pos: string; neg: string }[] {
  const nets = doc.nets.map((n) => n.name).filter((n) => !among || among.has(n.toLowerCase()));
  const have = new Set(diffPairsOf(doc).flatMap((p) => [p.pos.toLowerCase(), p.neg.toLowerCase()]));
  const out: { name: string; pos: string; neg: string }[] = [];
  const ends = (s: string, suf: string) => suf && s.toLowerCase().endsWith(suf.toLowerCase());
  for (const pos of nets) {
    if (!ends(pos, posSuffix) || have.has(pos.toLowerCase())) continue;
    const stem = pos.slice(0, pos.length - posSuffix.length);
    const neg = nets.find((n) => n.toLowerCase() === `${stem}${negSuffix}`.toLowerCase());
    if (!neg || have.has(neg.toLowerCase())) continue;
    out.push({ name: stem.replace(/[_-]$/, '') || stem, pos, neg });
  }
  return out;
}

/** Is the net in a pair of this differential pair class (or this pair)? */
export function netInPairClass(doc: PcbDocument, netName: string, cls: string): boolean {
  const c = doc.classes.find((k) => k.kind === 6 && k.name.toLowerCase() === cls.toLowerCase());
  if (!c) return false;
  const pairs = new Set(membersOf(doc, c).map((m) => m.toLowerCase()));
  const n = netName.toLowerCase();
  return diffPairsOf(doc).some((p) => (c.superClass || pairs.has(p.name.toLowerCase())) && (p.pos.toLowerCase() === n || p.neg.toLowerCase() === n));
}
export function netInPair(doc: PcbDocument, netName: string, pair: string): boolean {
  const n = netName.toLowerCase();
  return diffPairsOf(doc).some((p) => p.name.toLowerCase() === pair.toLowerCase() && (p.pos.toLowerCase() === n || p.neg.toLowerCase() === n));
}

/** The Differential Pairs Routing rule for a pair on a layer: widths and gaps (AD17's per-layer keys, else the rule's). */
export function pairRule(doc: PcbDocument, layer: LayerId, pair?: DiffPair): { width: number; gap: number; minGap: number; maxGap: number; maxUncoupled: number } {
  const rules = doc.rules.filter((r) => ruleKind(r) === 'DiffPairsRouting' && ruleEnabled(r)).sort((a, b) => rulePriority(a) - rulePriority(b));
  // The first rule whose scope names the pair or its class, else the first for All
  const scoped = (r: PcbRule) => {
    const s = (r.bag.get('SCOPE1EXPRESSION') ?? 'All').trim();
    if (/^all$/i.test(s)) return true;
    if (!pair) return false;
    const m = /InDifferentialPair(Class)?\('([^']*)'\)/i.exec(s);
    if (!m) return false;
    return m[1] ? doc.classes.some((c) => c.kind === 6 && c.name === m[2] && (c.superClass || c.members.includes(pair.name))) : m[2]!.toLowerCase() === pair.name.toLowerCase();
  };
  const r = rules.find((x) => scoped(x) && !/^all$/i.test(x.bag.get('SCOPE1EXPRESSION') ?? 'All')) ?? rules.find(scoped);
  const name = layerToName(layer).replace(/^MID(\d+)$/, 'MIDLAYER$1').replace(/^TOP$/, 'TOPLAYER').replace(/^BOTTOM$/, 'BOTTOMLAYER');
  if (!r) return { width: 100_000, gap: 100_000, minGap: 100_000, maxGap: 100_000, maxUncoupled: 5_000_000 };
  const gap = r.bag.has(`${name}_PREFGAP`) ? ruleLength(r, `${name}_PREFGAP`, '10mil') : ruleLength(r, 'MOSTFREQGAP', '10mil');
  return {
    width: r.bag.has(`${name}_PREFWIDTH`) ? ruleLength(r, `${name}_PREFWIDTH`, '10mil') : ruleLength(r, 'TOPLAYER_PREFWIDTH', '10mil'),
    gap, minGap: r.bag.has(`${name}_MINGAP`) ? ruleLength(r, `${name}_MINGAP`, '10mil') : ruleLength(r, 'MINLIMIT', '10mil'),
    maxGap: r.bag.has(`${name}_MAXGAP`) ? ruleLength(r, `${name}_MAXGAP`, '10mil') : ruleLength(r, 'MAXLIMIT', '10mil'),
    maxUncoupled: ruleLength(r, 'MAXUNCOUPLEDLENGTH', '500mil'),
  };
}

export interface PairWizardValues { cls: string; prefix: string; minW: number; prefW: number; maxW: number; minG: number; prefG: number; maxG: number; uncoupled: number; tol: number }

/**
 * The Differential Pair Rule Wizard's rules for a pair class: Differential Pairs Routing (the
 * widths and gaps on every signal layer, the uncoupled length) and Matched Lengths (tolerance,
 * the pairs' nets matched), both scoped InDifferentialPairClass and put first in their kind.
 */
export function pairWizardRules(doc: PcbDocument, v: PairWizardValues): { rules: PcbRule[]; made: string[] } {
  const rules = doc.rules.map(cloneRule);
  const scope = `InDifferentialPairClass('${v.cls}')`;
  const first = (kind: string) => { for (const r of rules) if (ruleKind(r) === kind) r.bag.set('PRIORITY', String(rulePriority(r) + 1)); };
  const F = formatAltiumLength;
  first('DiffPairsRouting');
  const dp = newRule('DiffPairsRouting', nextRuleName(rules, `${v.prefix}_DiffPairsRouting`), 1);
  dp.bag.set('NETSCOPE', 'AnyNet'); dp.bag.set('SCOPE1EXPRESSION', scope);
  dp.bag.set('MINLIMIT', F(v.minG)); dp.bag.set('MAXLIMIT', F(v.maxG)); dp.bag.set('MOSTFREQGAP', F(v.prefG));
  for (const l of doc.board.copperStack.filter(isSignal)) {
    const n = l === L.TOP ? 'TOPLAYER' : l === L.BOTTOM ? 'BOTTOMLAYER' : `MIDLAYER${layerToName(l).replace(/^MID/, '')}`;
    dp.bag.set(`${n}_MINWIDTH`, F(v.minW)); dp.bag.set(`${n}_MAXWIDTH`, F(v.maxW)); dp.bag.set(`${n}_PREFWIDTH`, F(v.prefW));
    dp.bag.set(`${n}_MINGAP`, F(v.minG)); dp.bag.set(`${n}_MAXGAP`, F(v.maxG)); dp.bag.set(`${n}_PREFGAP`, F(v.prefG));
  }
  dp.bag.set('MAXUNCOUPLEDLENGTH', F(v.uncoupled));
  rules.push(dp);
  first('MatchedLengths');
  const ml = newRule('MatchedLengths', nextRuleName(rules, `${v.prefix}_MatchedLengths`), 1);
  ml.bag.set('SCOPE1EXPRESSION', scope); ml.bag.set('TOLERANCE', F(v.tol)); ml.bag.set('CHECKNETSINDIFFPAIR', 'TRUE');
  rules.push(ml);
  return { rules, made: [dp.bag.get('NAME') ?? '', ml.bag.get('NAME') ?? ''] };
}
