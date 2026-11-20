import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { notify, replaceMessages } from '../state';
import { showPanel } from '../dock/store';
import { settings, updateSettings } from '../../core/settings';
import { formatAltiumLength } from '../../core/units';
import { replaceRules } from '../../model/pcbEdit';
import { FAB_PROFILES, checkAgainstProfile, compareProfile, rulesWithProfile, type LimitRow } from '../../model/fabProfiles';
import { ruleName } from '../../formats/altium/rules';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';

/**
 * Design › Fab-House Profile…: a board house's standard capabilities against the board's rules
 * (rules that allow less than the house can make in red); Check Board runs a Design Rule Check
 * with the house's limits in place of the board's rules; Apply puts its limits into the general
 * rules (one undoable step).
 */
export function FabProfileDialog({ ed }: { ed: PcbEditor }) {
  const [id, setId] = useState(() => FAB_PROFILES.find((p) => p.id === settings.fabProfile)?.id ?? FAB_PROFILES[0]?.id ?? '');
  const [, redraw] = useState(0);
  const p = FAB_PROFILES.find((x) => x.id === id);
  if (!p) return null;
  const rows = compareProfile(ed.doc, p);
  const units = (v: number) => (ed.units() === 'mm' ? `${(v / 10000 * 0.0254).toFixed(3)}mm` : formatAltiumLength(v));
  const pick = (v: string) => { setId(v); updateSettings({ fabProfile: v }); };

  const check = () => {
    const r = checkAgainstProfile(ed.doc, p);
    const name = ed.doc.name;
    replaceMessages('Fab-House Check', [
      ...r.violations.map((v) => ({ doc: name, level: 'error' as const, cls: `[${p.name}]`, message: v.message, locate: () => ed.showViolation(v) })),
      { doc: name, level: 'info' as const, message: `${p.name} (${p.service}): ${r.violations.length} place${r.violations.length === 1 ? '' : 's'} the house can't make as drawn` },
    ]);
    showPanel('messages');
    notify(r.violations.length ? `${r.violations.length} place${r.violations.length === 1 ? '' : 's'} beyond ${p.name}'s standard service` : `Within ${p.name}'s standard service`);
  };
  const apply = () => {
    const { rules, changed } = rulesWithProfile(ed.doc, p);
    if (!changed.length) { notify('The general rules already keep within the house'); return; }
    ed.undo.transact(`Fab-House Profile ${p.name}`, (tx) => tx.add(replaceRules(ed.doc, rules)));
    replaceMessages('Fab-House Check', changed.map((m) => ({ doc: ed.doc.name, level: 'info' as const, message: `${p.name}: ${m}` })));
    notify(`${changed.length} rule${changed.length === 1 ? '' : 's'} set to ${p.name}`);
    redraw((n) => n + 1);
  };

  const ruleCell = (r: LimitRow) => r.rules.length
    ? <span>{r.rules.map((x, i) => <span key={i} class={x.below ? 'fab-below' : ''}>{i ? ', ' : ''}{ruleName(x.rule)} {units(x.value)}</span>)}</span>
    : <span class="muted">none</span>;
  return (
    <Dialog title="Fab-House Profile" width={720} height={520} onClose={closeDialog} class="fab-profile"
      footer={<>
        <button class="btn" onClick={check}>Check Board</button>
        <button class="btn" onClick={apply}>Apply to General Rules</button>
        <span class="spacer" />
        <button class="btn default" onClick={closeDialog}>Close</button>
      </>}>
      <div class="fab-head">
        <label>House <select value={id} onChange={(e) => pick((e.target as HTMLSelectElement).value)}>
          {FAB_PROFILES.map((x) => <option key={x.id} value={x.id}>{x.name} — {x.service}</option>)}
        </select></label>
        <p class="small muted">From <a href={p.source} target="_blank" rel="noopener">{p.source.replace(/^https?:\/\//, '')}</a>, read {p.read}.{p.notes ? ` ${p.notes}` : ''}</p>
      </div>
      <Grid cols={[
        { label: 'Constraint', width: '170px', get: (r: LimitRow) => r.limit.label },
        { label: p.name, width: '110px', align: 'right', get: (r: LimitRow) => units(r.fab) },
        { label: "The board's rules (in red: less than the house makes)", width: 'minmax(200px, 1fr)', get: ruleCell },
      ]} rows={rows} />
      <p class="small muted">Silkscreen lines {units(p.silkWidth)} wide{p.silkText ? `, text ${units(p.silkText)} high` : ''} at least. {p.maxDrill ? `Largest hole ${units(p.maxDrill)}.` : 'No largest hole (big ones are milled).'}</p>
    </Dialog>
  );
}
