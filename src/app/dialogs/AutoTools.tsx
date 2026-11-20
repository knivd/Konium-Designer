/**
 * Dialogs of 26.039's automation [est: laid out from AD17's]: Routing Strategies (Route ›
 * Auto Route › Setup and All), Fanout Options, Auto Place, the New Rule Wizard (Design › Rule
 * Wizard) and the Testpoint Manager.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, tick } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { Check, LenInput, Row } from './pcbFields';
import { RULE_KINDS, kindLabel, newRule, nextRuleName, rulePriority, ruleKind, cloneRule, type PcbRule } from '../../formats/altium/rules';
import { replaceRecords, replaceRules } from '../../model/pcbEdit';
import { FLAG, PAD, VIA, get, put } from '../../formats/altium/pcbLayouts';
import { NO_NET, type PcbPad, type PcbVia } from '../../model/pcb';
import { L } from '../../model/layers';

const footer = (ok: () => void, label = 'OK') => <><span class="spacer" /><button class="btn default" onClick={ok}>{label}</button><button class="btn" onClick={closeDialog}>Cancel</button></>;

export const STRATEGIES = ['Default 2 Layer Board', 'Default Multi Layer Board', 'General Orthogonal', 'Via Miser', 'Cleanup'] as const;
export interface RouteSetup { strategy: (typeof STRATEGIES)[number]; lockPreRoutes: boolean; ripUpViolations: boolean }

/** Routing Strategies: the rules report, the strategy, Route All. */
export function RouteSetupDialog({ ed, setup, onOk, routeAll }: { ed: PcbEditor; setup: RouteSetup; onOk: (s: RouteSetup) => void; routeAll?: boolean }) {
  const [s, setS] = useState<RouteSetup>({ ...setup });
  const rules = ed.doc.rules.filter((r) => /^(Width|RoutingVias|Clearance|RoutingLayers|RoutingCorners|RoutingTopology|DiffPairsRouting)$/.test(ruleKind(r)));
  const ok = () => { closeDialog(); onOk(s); };
  return (
    <Dialog title="Routing Strategies" width={600} height={480} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok, routeAll ? 'Route All' : 'OK')}>
      <fieldset class="pd-group"><legend>Routing Setup Report</legend>
        <div class="grid" style={{ '--cols': '1fr 1fr 1fr' } as Record<string, string>}>
          <div class="grid-row grid-head"><span>Rule</span><span>Kind</span><span>Scope</span></div>
          <div class="grid-body" style={{ maxHeight: '150px' }}>
            {rules.map((r, i) => <div key={i} class="grid-row"><span>{r.bag.get('NAME')}</span><span>{kindLabel(ruleKind(r))}</span><span>{r.bag.get('SCOPE1EXPRESSION')}</span></div>)}
          </div>
        </div>
      </fieldset>
      <fieldset class="pd-group"><legend>Routing Strategy</legend>
        <Row label="Available Routing Strategies"><select aria-label="Routing Strategy" value={s.strategy} onChange={(e) => setS({ ...s, strategy: (e.target as HTMLSelectElement).value as RouteSetup['strategy'] })}>
          {STRATEGIES.map((k) => <option key={k}>{k}</option>)}</select></Row>
        <Check label="Lock All Pre-routes" checked={s.lockPreRoutes} onChange={(v) => setS({ ...s, lockPreRoutes: v })} />
        <Check label="Rip-up Violations After Routing" checked={s.ripUpViolations} onChange={(v) => setS({ ...s, ripUpViolations: v })} />
        <p class="muted small">Existing copper is always kept; connections that can't be completed are listed in Messages [est].</p>
      </fieldset>
    </Dialog>
  );
}

export interface FanoutChoice { withoutNets: boolean; outerRows: boolean; escape: boolean }
export function FanoutOptionsDialog({ title, onOk }: { title: string; onOk: (c: FanoutChoice) => void }) {
  const [c, setC] = useState<FanoutChoice>({ withoutNets: false, outerRows: false, escape: false });
  const ok = () => { closeDialog(); onOk(c); };
  return (
    <Dialog title={title} width={380} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <Check label="Fanout Pads Without Nets" checked={c.withoutNets} onChange={(v) => setC({ ...c, withoutNets: v })} />
      <Check label="Fanout Outer 2 Rows of Pads" checked={c.outerRows} onChange={(v) => setC({ ...c, outerRows: v })} />
      <Check label="Include escape routes after fanout completion" checked={c.escape} onChange={(v) => setC({ ...c, escape: v })} title="Each fanout's via routed out from under its component on another layer" />
    </Dialog>
  );
}

export interface AutoPlaceChoice { quick: boolean; rotate: boolean; grid: number; gap: number }
export function AutoPlaceDialog({ ed, count, onOk }: { ed: PcbEditor; count: number; onOk: (c: AutoPlaceChoice) => void }) {
  const [c, setC] = useState<AutoPlaceChoice>({ quick: true, rotate: true, grid: ed.gridSize() < 100_000 ? 250_000 : ed.gridSize(), gap: 100_000 });
  const ok = () => { closeDialog(); onOk(c); };
  return (
    <Dialog title="Auto Place" width={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok)}>
      <p>Places {count} component{count === 1 ? '' : 's'} (the selection, else every unlocked one) where their connections are shortest, inside the board or their rooms.</p>
      <Check label="Quick Component Placement" checked={c.quick} onChange={(v) => setC({ ...c, quick: v })} />
      <Check label="Rotate Components" checked={c.rotate} onChange={(v) => setC({ ...c, rotate: v })} />
      <Row label="Grid Size"><LenInput ed={ed} label="Grid Size" value={c.grid} min={1} onChange={(v) => setC({ ...c, grid: v })} /></Row>
      <Row label="Component Gap"><LenInput ed={ed} label="Component Gap" value={c.gap} min={0} onChange={(v) => setC({ ...c, gap: v })} /></Row>
    </Dialog>
  );
}

const SCOPES = ['Whole Board', '1 Net', 'Net Class', 'Layer', 'Component', 'Component Class', 'Custom Query'] as const;
/** Design › Rule Wizard: the kind, a name, where it applies, its priority; the rule made in one step. */
export function RuleWizardDialog({ ed, draft, onMade }: { ed: PcbEditor; draft?: PcbRule[]; onMade?: (r: PcbRule) => void }) {
  const doc = ed.doc;
  const kinds = RULE_KINDS.filter((k) => k.kind !== 'RoomDefinition');
  const [kind, setKind] = useState('Clearance');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('Whole Board');
  const [value, setValue] = useState('');
  const [first, setFirst] = useState(true);
  const options = scope === '1 Net' ? doc.nets.map((n) => n.name) : scope === 'Net Class' ? doc.classes.filter((c) => c.kind === 0).map((c) => c.name)
    : scope === 'Component' ? doc.components.map((c) => c.designator) : scope === 'Component Class' ? doc.classes.filter((c) => c.kind === 1).map((c) => c.name)
      : scope === 'Layer' ? doc.board.copperStack.map((l) => ed.layerLabel(l)) : [];
  const expr = () => {
    const v = (value || options[0] || '').replace(/'/g, '');
    switch (scope) {
      case '1 Net': return `InNet('${v}')`;
      case 'Net Class': return `InNetClass('${v}')`;
      case 'Layer': return `OnLayer('${v}')`;
      case 'Component': return `InComponent('${v}')`;
      case 'Component Class': return `InComponentClass('${v}')`;
      case 'Custom Query': return value.trim() || 'All';
      default: return 'All';
    }
  };
  const ok = () => {
    const rules = draft ?? doc.rules.map(cloneRule);
    if (first) for (const r of rules) if (ruleKind(r) === kind) r.bag.set('PRIORITY', String(rulePriority(r) + 1));
    const prio = first ? 1 : rules.filter((r) => ruleKind(r) === kind).length + 1;
    const r = newRule(kind, name.trim() || nextRuleName(rules, kind), prio);
    r.bag.set('SCOPE1EXPRESSION', expr());
    rules.push(r);
    // From Design › Rules: into its list, kept or dropped with the rest
    if (draft) { closeDialog(); onMade?.(r); return; }
    ed.undo.transact(`New rule ${r.bag.get('NAME')}`, (tx) => tx.add(replaceRules(doc, rules)));
    tick.value++;
    notify(`Rule ${r.bag.get('NAME')} made (${kindLabel(kind)}, ${expr()}); edit its values in Design › Rules`);
    closeDialog();
  };
  return (
    <Dialog title="New Rule Wizard" width={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} footer={footer(ok, 'Finish')}>
      <Row label="Rule Type"><select aria-label="Rule Type" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value)}>
        {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.category} › {k.label}</option>)}</select></Row>
      <Row label="Name"><input type="text" aria-label="Rule Name" placeholder={nextRuleName(doc.rules, kind)} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></Row>
      <fieldset class="pd-group"><legend>Rule Scope</legend>
        {SCOPES.map((k) => <label key={k} class="pd-radio"><input type="radio" name="rw-scope" checked={scope === k} onChange={() => { setScope(k); setValue(''); }} /> {k}</label>)}
        {options.length > 0 && <Row label="Which"><select aria-label="Scope Value" value={value || options[0]} onChange={(e) => setValue((e.target as HTMLSelectElement).value)}>{options.map((o) => <option key={o}>{o}</option>)}</select></Row>}
        {scope === 'Custom Query' && <Row label="Query"><input type="text" aria-label="Custom Query" value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></Row>}
        <p class="muted small">Scope: {expr()}</p>
      </fieldset>
      <Check label="Highest priority of its kind" checked={first} onChange={setFirst} />
    </Dialog>
  );
}

/** Tools › Testpoint Manager: fabrication testpoints (top and bottom) per net; assign one per net or clear them all [est]. */
export function TestpointManagerDialog({ ed }: { ed: PcbEditor }) {
  const doc = ed.doc;
  const flags = (p: PcbPad | PcbVia) => {
    const rec = doc.streams.get(p.src.storage)!.records[p.src.index]!;
    const s = rec.subs[p.kind === 'pad' ? 4 : 0]!;
    const f1 = get(s, p.kind === 'pad' ? PAD.flags1 : VIA.flags1) ?? 0, f2 = get(s, p.kind === 'pad' ? PAD.flags2 : VIA.flags2) ?? 0;
    return { top: (f1 & FLAG.fabTop) !== 0, bottom: (f2 & FLAG.fabBottom) !== 0 };
  };
  const cands = doc.prims.filter((p): p is PcbPad | PcbVia => (p.kind === 'pad' || p.kind === 'via') && p.net !== NO_NET);
  const nets = doc.nets.map((n) => {
    const own = cands.filter((p) => p.net === n.index);
    const tp = own.filter((p) => { const f = flags(p); return f.top || f.bottom; });
    return { n, count: tp.length, objects: own };
  }).filter((x) => x.objects.length);
  const setFlags = (items: { p: PcbPad | PcbVia; top: boolean; bottom: boolean }[], label: string) => {
    const edits = items.map(({ p, top, bottom }) => {
      const rec = doc.streams.get(p.src.storage)!.records[p.src.index]!;
      const subs = rec.subs.map((x) => x.slice());
      const k = p.kind === 'pad' ? 4 : 0, s = subs[k]!;
      const F1 = p.kind === 'pad' ? PAD.flags1 : VIA.flags1, F2 = p.kind === 'pad' ? PAD.flags2 : VIA.flags2;
      put(s, F1, ((get(s, F1) ?? 0) & ~FLAG.fabTop) | (top ? FLAG.fabTop : 0));
      put(s, F2, ((get(s, F2) ?? 0) & ~FLAG.fabBottom) | (bottom ? FLAG.fabBottom : 0));
      return { storage: p.src.storage, index: p.src.index, after: { tag: rec.tag, subs } };
    });
    if (!edits.length) return;
    ed.undo.transact(label, (tx) => tx.add(replaceRecords(doc, edits)));
    tick.value++;
  };
  const assign = () => {
    // One per net without one: a via or through-hole pad, tested from the bottom
    const items = nets.filter((x) => !x.count).flatMap((x) => { const p = x.objects.find((q) => q.kind === 'via' || (q.kind === 'pad' && q.layer === L.MULTI)) ?? x.objects[0]; return p ? [{ p, top: false, bottom: true }] : []; });
    setFlags(items, 'Assign testpoints'); notify(`${items.length} testpoint${items.length === 1 ? '' : 's'} assigned`);
  };
  const clear = () => { const items = cands.filter((p) => { const f = flags(p); return f.top || f.bottom; }).map((p) => ({ p, top: false, bottom: false })); setFlags(items, 'Clear testpoints'); notify(`${items.length} testpoint${items.length === 1 ? '' : 's'} cleared`); };
  return (
    <Dialog title="Testpoint Manager" width={560} height={460} onClose={closeDialog} onAccept={() => { closeDialog(); return false; }}
      footer={<><button class="btn" onClick={assign}>Assign All</button><button class="btn" onClick={clear}>Clear All</button><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="grid" style={{ '--cols': '1fr 90px 90px' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Net</span><span>Testpoints</span><span>Status</span></div>
        <div class="grid-body">
          {nets.map(({ n, count }) => <div key={n.index} class="grid-row"><span>{n.name}</span><span>{count}</span><span>{count ? 'Tested' : 'Untested'}</span></div>)}
        </div>
      </div>
    </Dialog>
  );
}
