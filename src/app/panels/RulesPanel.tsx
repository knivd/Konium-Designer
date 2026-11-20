/**
 * PCB Rules And Violations (AD17's panel): the rule kinds with how many rules each, the rules of
 * the kind picked (enabled, name, priority, scope, attributes), and the violations the last
 * Design Rule Check and online DRC found. Picking a violation shows its objects on the board
 * (Normal, Mask or Dim; Select, Zoom); double-click a rule to edit the rules, a violation to see
 * it in full. Run DRC checks the whole board again.
 */
import { useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { active, notify, tick, units } from '../state';
import { showDialog } from '../dialogs';
import { RulesDialog, ruleAttributes } from '../dialogs/Rules';
import { InfoDialog } from '../dialogs/Confirm';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { CHECKED_KINDS, type DrcViolation } from '../../model/drc';
import { kindCategory, kindLabel, ruleEnabled, ruleKind, ruleName, rulePriority, ruleScope1, ruleScope2 } from '../../formats/altium/rules';
import { pcbObjects } from '../../model/pcbProps';

const highlight = signal<'normal' | 'mask' | 'dim'>('mask');
const opts = signal({ select: true, zoom: true });
const ALL = '<All Rules>';

export function RulesViolationsPanel() {
  void tick.value;
  const e = active.value?.editor instanceof PcbEditor ? active.value.editor : null;
  const [kind, setKind] = useState(ALL);
  const [rule, setRule] = useState<string | null>(null);
  const [vsel, setVsel] = useState<number | null>(null);
  if (!e) return <section class="panel rulespanel"><p class="panel-empty">Open a board.</p></section>;
  const doc = e.doc, u = units.value;
  const kinds = [...new Set(doc.rules.map(ruleKind))].sort((a, b) => kindLabel(a).localeCompare(kindLabel(b)));
  const rules = doc.rules.filter((r) => kind === ALL || ruleKind(r) === kind).sort((a, b) => ruleKind(a).localeCompare(ruleKind(b)) || rulePriority(a) - rulePriority(b));
  const violations = e.violations.filter((v) => (kind === ALL || v.kind === kind) && (!rule || v.rule === rule));
  const count = (k: string) => e.violations.filter((v) => v.kind === k).length;
  const showViolation = (v: DrcViolation) => {
    const keys = new Set(v.prims.map((i) => doc.prims[i]).filter(Boolean).map((p) => ('polygon' in p! && p!.polygon !== 0xffff ? `poly:${p!.polygon}` : `${p!.src.storage}:${p!.src.index}`)));
    const objs = pcbObjects(doc).filter((o) => o.keys.some((k) => keys.has(k)));
    const ks = objs.flatMap((o) => o.keys.filter((k) => keys.has(k)));
    if (highlight.value === 'normal') e.setMask(null); else e.setMask(ks, highlight.value === 'dim');
    if (opts.value.select) e.select(ks);
    if (opts.value.zoom && ks.length) e.zoomToBox(e.boundsOf(ks), 2_000_000);
    e.invalidateOverlay();
    tick.value++;
  };
  const run = () => {
    const r = e.runBatchDrc(new Set(CHECKED_KINDS));
    notify(`Design Rule Check: ${r.violations.length} violation${r.violations.length === 1 ? '' : 's'}`);
    setVsel(null);
    tick.value++;
  };
  const o = opts.value;
  return (
    <section class="panel rulespanel" aria-label="PCB Rules And Violations">
      <div class="panel-body pcbp-body-wrap">
        <div class="pcbp-opts">
          <button class="btn" onClick={() => { e.setMask(null); e.select([]); e.invalidateOverlay(); tick.value++; }}>Clear</button>
          <select aria-label="Highlight" value={highlight.value} onChange={(ev) => { highlight.value = (ev.target as HTMLSelectElement).value as 'normal' | 'mask' | 'dim'; }}>
            <option value="normal">Normal</option><option value="mask">Mask</option><option value="dim">Dim</option>
          </select>
          <label><input type="checkbox" checked={o.select} onChange={(ev) => { opts.value = { ...o, select: (ev.target as HTMLInputElement).checked }; }} />Select</label>
          <label><input type="checkbox" checked={o.zoom} onChange={(ev) => { opts.value = { ...o, zoom: (ev.target as HTMLInputElement).checked }; }} />Zoom</label>
        </div>
        <div class="pcbp-table" role="grid" aria-label="Rule Classes" style={{ '--cols': '1fr' } as Record<string, string>}>
          <div class="pcbp-row head"><span>Rule Classes</span></div>
          <div class="pcbp-body">
            {[ALL, ...kinds].map((k) => (
              <div key={k} role="row" class={`pcbp-row${kind === k ? ' on' : ''}`} onMouseDown={() => { setKind(k); setRule(null); setVsel(null); }}>
                <span>{k === ALL ? `All Rules (${doc.rules.length})` : `${kindLabel(k)} (${doc.rules.filter((r) => ruleKind(r) === k).length})`}{k !== ALL && count(k) ? <b class="err"> {count(k)}</b> : null}</span>
              </div>
            ))}
          </div>
        </div>
        <div class="pcbp-table" role="grid" aria-label="Rules" style={{ '--cols': '30px minmax(90px,1fr) 52px 110px minmax(80px,1fr) minmax(90px,1.2fr)' } as Record<string, string>}>
          <div class="pcbp-row head"><span>On</span><span>Name</span><span>Priority</span><span>Type</span><span>Scope</span><span>Attributes</span></div>
          <div class="pcbp-body">
            {rules.map((r) => (
              <div key={ruleName(r)} role="row" class={`pcbp-row${rule === ruleName(r) ? ' on' : ''}`} onMouseDown={() => { setRule(rule === ruleName(r) ? null : ruleName(r)); setVsel(null); }}
                onDblClick={() => showDialog(RulesDialog, { ed: e })} title={kindCategory(ruleKind(r))}>
                <span>{ruleEnabled(r) ? '✓' : ''}</span><span>{ruleName(r)}</span><span>{rulePriority(r)}</span><span>{kindLabel(ruleKind(r))}</span>
                <span>{ruleScope1(r)}{['Clearance', 'ShortCircuit'].includes(ruleKind(r)) ? `, ${ruleScope2(r)}` : ''}</span><span>{ruleAttributes(r, u)}</span>
              </div>
            ))}
          </div>
        </div>
        <div class="pcbp-table" role="grid" aria-label="Violations" style={{ '--cols': 'minmax(90px,0.6fr) minmax(160px,2fr)' } as Record<string, string>}>
          <div class="pcbp-row head"><span>Violations ({violations.length})</span><span>Description</span></div>
          <div class="pcbp-body">
            {violations.map((v, i) => (
              <div key={i} role="row" class={`pcbp-row${vsel === i ? ' on' : ''}`} onMouseDown={() => { setVsel(i); showViolation(v); }}
                onDblClick={() => showDialog(InfoDialog, { title: 'Violation Details', lines: [`${kindLabel(v.kind)}: ${v.rule}`, v.message] })}>
                <span class={v.error ? 'err' : ''}>{v.rule}</span><span title={v.message}>{v.message}</span>
              </div>
            ))}
            {!violations.length && <div class="pcbp-row"><span class="muted">No violations</span><span /></div>}
          </div>
        </div>
        <div class="pcbp-buttons"><button class="btn" onClick={run}>Run DRC</button><button class="btn" onClick={() => showDialog(RulesDialog, { ed: e })}>Rules...</button></div>
      </div>
    </section>
  );
}
