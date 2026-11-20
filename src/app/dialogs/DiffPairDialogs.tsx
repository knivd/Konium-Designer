/**
 * The Differential Pairs Editor's dialogs: a pair (name, positive and negative net), Create
 * Differential Pairs From Nets (a net class, the suffixes, the pairs found ticked), and the
 * Differential Pair Rule Wizard [est: one page where AD17 has several] — the routing rule (widths,
 * gaps, uncoupled length) and the matched length rule for a pair class, made at once.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify, tick } from '../state';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { diffPairBag, diffPairsOf, pairWizardRules, pairsFromNets, setDiffPairs } from '../../model/diffPairs';
import { membersOf, setClasses, classBag } from '../../model/pcbClasses';
import { replaceRules } from '../../model/pcbEdit';
import { formatCoord, parseLength } from '../../core/units';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function DiffPairDialog({ ed, index }: { ed: PcbEditor; index: number | null }) {
  const pairs = diffPairsOf(ed.doc);
  const cur = index !== null ? pairs[index] : undefined;
  const nets = [...ed.doc.nets].map((n) => n.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const [name, setName] = useState(cur?.name ?? '');
  const [pos, setPos] = useState(cur?.pos ?? nets[0] ?? '');
  const [neg, setNeg] = useState(cur?.neg ?? nets[1] ?? '');
  const ok = () => {
    const n = name.trim() || pos.replace(/[_-]?(P|\+)$/i, '');
    if (!n || !pos || !neg || pos === neg) { notify('A pair needs a name and two different nets', 'error'); return; }
    if (pairs.some((p, i) => i !== index && p.name.toLowerCase() === n.toLowerCase())) { notify(`There is already a pair ${n}`, 'error'); return; }
    if (pairs.some((p, i) => i !== index && [p.pos, p.neg].some((x) => x === pos || x === neg))) { notify('A net can be in one pair only', 'error'); return; }
    const bags = (ed.doc.diffPairs ?? []).map((b, i) => {
      if (i !== index) return b;
      const nb = b.clone(); nb.set('NAME', n); nb.set('POSITIVENETNAME', pos); nb.set('NEGATIVENETNAME', neg); return nb;
    });
    if (index === null) bags.push(diffPairBag(n, pos, neg));
    ed.undo.transact(index === null ? `Add differential pair ${n}` : `Edit differential pair ${n}`, (tx) => tx.add(setDiffPairs(ed.doc, bags)));
    tick.value++;
    closeDialog();
  };
  const pick = (label: string, v: string, set: (s: string) => void) => (
    <label class="dlg-field"><span>{label}</span><select aria-label={label} value={v} onChange={(e) => set((e.target as HTMLSelectElement).value)}>
      {nets.map((n) => <option key={n}>{n}</option>)}</select></label>
  );
  return (
    <Dialog title="Differential Pair" width={380} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="dlg-field"><span>Name</span><input type="text" aria-label="Name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></label>
      {pick('Positive Net', pos, setPos)}
      {pick('Negative Net', neg, setNeg)}
    </Dialog>
  );
}

export function CreatePairsFromNetsDialog({ ed }: { ed: PcbEditor }) {
  const classes = ['All Nets', ...ed.doc.classes.filter((c) => c.kind === 0 && !c.superClass).map((c) => c.name)];
  const [cls, setCls] = useState('All Nets');
  const [posSuf, setPos] = useState('_P');
  const [negSuf, setNeg] = useState('_N');
  const [pairClass, setPairClass] = useState('');
  const among = cls === 'All Nets' ? undefined : new Set(membersOf(ed.doc, ed.doc.classes.find((c) => c.kind === 0 && c.name === cls)!).map((m) => m.toLowerCase()));
  const found = pairsFromNets(ed.doc, posSuf, negSuf, among);
  const [off, setOff] = useState<Set<string>>(new Set());
  const ok = () => {
    const make = found.filter((p) => !off.has(p.name));
    if (!make.length) { closeDialog(); return; }
    ed.undo.transact(`Create ${plural(make.length, 'differential pair')}`, (tx) => {
      tx.add(setDiffPairs(ed.doc, [...(ed.doc.diffPairs ?? []), ...make.map((p) => diffPairBag(p.name, p.pos, p.neg))]));
      const pc = pairClass.trim();
      if (pc) {
        const at = ed.doc.classes.findIndex((c) => c.kind === 6 && c.name.toLowerCase() === pc.toLowerCase());
        const bags = ed.doc.classes.map((c) => c.bag);
        if (at >= 0) { const c = ed.doc.classes[at]!; const nb = c.bag.clone(); let i = c.members.length; for (const p of make) nb.set(`M${i++}`, p.name); bags[at] = nb; }
        else bags.push(classBag(pc, 6, make.map((p) => p.name)));
        tx.add(setClasses(ed.doc, bags));
      }
    });
    tick.value++;
    notify(`${plural(make.length, 'differential pair')} created`);
    closeDialog();
  };
  return (
    <Dialog title="Create Differential Pairs From Nets" width={640} height={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="dpcreate"
      footer={<><span class="muted small">{found.length - off.size} to create</span><span class="spacer" /><button class="btn default" onClick={ok}>Execute</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="dp-opts">
        <label class="dlg-field"><span>Net Class</span><select aria-label="Net Class" value={cls} onChange={(e) => setCls((e.target as HTMLSelectElement).value)}>{classes.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label class="dlg-field"><span>Positive Net Identifier</span><input type="text" aria-label="Positive Net Identifier" value={posSuf} onInput={(e) => setPos((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></label>
        <label class="dlg-field"><span>Negative Net Identifier</span><input type="text" aria-label="Negative Net Identifier" value={negSuf} onInput={(e) => setNeg((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></label>
        <label class="dlg-field"><span>Assign To Class</span><input type="text" aria-label="Assign To Class" placeholder="(none)" value={pairClass} onInput={(e) => setPairClass((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></label>
      </div>
      <div class="grid" style={{ '--cols': '40px 1fr 1fr 1fr' } as Record<string, string>}>
        <div class="grid-row grid-head"><span>Create</span><span>Name</span><span>Positive Net</span><span>Negative Net</span></div>
        <div class="grid-body">
          {found.map((p) => (
            <div key={p.name} class="grid-row">
              <span><input type="checkbox" aria-label={`Create ${p.name}`} checked={!off.has(p.name)} onChange={(e) => { const n = new Set(off); if ((e.target as HTMLInputElement).checked) n.delete(p.name); else n.add(p.name); setOff(n); }} /></span>
              <span>{p.name}</span><span>{p.pos}</span><span>{p.neg}</span>
            </div>
          ))}
          {!found.length && <div class="grid-row muted"><span /><span>No nets pair up with these identifiers</span><span /><span /></div>}
        </div>
      </div>
    </Dialog>
  );
}

/** The Differential Pair Rule Wizard: a routing rule and a matched lengths rule for a pair class. */
export function DiffPairRuleWizardDialog({ ed }: { ed: PcbEditor }) {
  const u = ed.units();
  const classes = ed.doc.classes.filter((c) => c.kind === 6).map((c) => c.name);
  const [cls, setCls] = useState(classes[0] ?? 'All Differential Pairs');
  const [prefix, setPrefix] = useState('DiffPair');
  const [vals, setVals] = useState({ minW: 100_000, prefW: 100_000, maxW: 100_000, minG: 100_000, prefG: 100_000, maxG: 100_000, uncoupled: 5_000_000, tol: 200_000 });
  const f = (c: number) => formatCoord(c, u, u === 'mil' ? 3 : 4);
  const field = (label: string, k: keyof typeof vals) => (
    <label class="dlg-field"><span>{label}</span><input type="text" aria-label={label} defaultValue={f(vals[k])} onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => { const t = (e.target as HTMLInputElement).value.trim(); const c = parseLength(/^[0-9.]+$/.test(t) ? `${t}${u}` : t); if (c !== undefined && c >= 0) setVals({ ...vals, [k]: c }); }} /></label>
  );
  const ok = () => {
    const { rules, made } = pairWizardRules(ed.doc, { cls, prefix, ...vals });
    ed.undo.transact('Differential Pair Rule Wizard', (tx) => tx.add(replaceRules(ed.doc, rules)));
    tick.value++;
    notify(`Rules ${made.join(' and ')} made for ${cls}`);
    closeDialog();
  };
  return (
    <Dialog title="Differential Pair Rule Wizard" width={460} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>Finish</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="dlg-field"><span>Rule Name Prefix</span><input type="text" aria-label="Rule Name Prefix" value={prefix} onInput={(e) => setPrefix((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></label>
      <label class="dlg-field"><span>Differential Pair Class</span><select aria-label="Differential Pair Class" value={cls} onChange={(e) => setCls((e.target as HTMLSelectElement).value)}>
        {[...new Set([cls, ...classes])].map((c) => <option key={c}>{c}</option>)}</select></label>
      <fieldset class="pd-group"><legend>Routing</legend>
        {field('Min Width', 'minW')}{field('Preferred Width', 'prefW')}{field('Max Width', 'maxW')}
        {field('Min Gap', 'minG')}{field('Preferred Gap', 'prefG')}{field('Max Gap', 'maxG')}{field('Max Uncoupled Length', 'uncoupled')}
      </fieldset>
      <fieldset class="pd-group"><legend>Matched Lengths</legend>{field('Tolerance', 'tol')}</fieldset>
    </Dialog>
  );
}
