import { useEffect, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { ColourIcon } from '../icons';
import { notify, units } from '../state';
import {
  BINARY_KINDS, CATEGORIES, RULE_KINDS, RULE_TREE, cloneRule, defaultRules, kindCategory, kindLabel, newRule, nextRuleName,
  ruleEnabled, ruleKind, ruleName, rulePriority, ruleScope1, ruleScope2, type PcbRule,
} from '../../formats/altium/rules';
import { parseQuery, scopePredicate, UnsupportedQuery } from '../../model/query';
import { replaceRules } from '../../model/pcbEdit';
import { RuleWizardDialog } from './AutoTools';
import { CHECKED_KINDS } from '../../model/drc';
import { formatAltiumLength, formatCoord, parseLength, type DisplayUnit } from '../../core/units';
import { siNum, siShow, siText, stimulusOf, stimulusProps, type SiUnit, type Stimulus } from '../../si/rules';
import { isSignal, layerName } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';

/**
 * Design › Rules… — the PCB Rules and Constraints Editor. A tree of rule types by category with
 * the board's rules under each; selecting a type lists its rules, selecting a rule edits its
 * name, scopes (Where The First / Second Object Matches) and constraints. Edits are staged until
 * OK or Apply, which replace the board's rules in one undoable step and rewrite Rules6 on save.
 */

type Node = { t: 'root' } | { t: 'cat'; cat: string } | { t: 'kind'; kind: string } | { t: 'rule'; rule: PcbRule };

const COMMON = new Set(['SELECTION', 'LAYER', 'LOCKED', 'POLYGONOUTLINE', 'USERROUTED', 'KEEPOUT', 'UNIONINDEX', 'RULEKIND', 'NETSCOPE', 'LAYERKIND',
  'SCOPE1EXPRESSION', 'SCOPE2EXPRESSION', 'NAME', 'ENABLED', 'PRIORITY', 'COMMENT', 'UNIQUEID', 'DEFINEDBYLOGICALDOCUMENT']);

const lengthIn = (u: DisplayUnit) => (s: string | undefined) => {
  if (s == null) return '';
  const c = parseLength(s);
  return c === undefined ? s : formatCoord(c, u, u === 'mil' ? 3 : 4);
};
/** A typed length: a bare number is in the dialog's units. */
function parseInput(v: string, u: DisplayUnit): string | null {
  const t = v.trim();
  const c = parseLength(/^-?[0-9.]+$/.test(t) ? `${t}${u}` : t);
  return c === undefined ? null : formatAltiumLength(c);
}

function kindsByCategory(rules: PcbRule[]): Map<string, string[]> {
  const m = new Map<string, string[]>(CATEGORIES.map((c) => [c, []]));
  for (const t of RULE_TREE) m.get(t.category)!.push(t.kind);
  for (const r of rules) {
    const k = ruleKind(r), c = kindCategory(k);
    if (!m.has(c)) m.set(c, []);
    if (!m.get(c)!.includes(k)) m.get(c)!.push(k);
  }
  return m;
}

const byPriority = (a: PcbRule, b: PcbRule) => rulePriority(a) - rulePriority(b);
function renumber(rules: PcbRule[], kind: string): void {
  rules.filter((r) => ruleKind(r) === kind).sort(byPriority).forEach((r, i) => r.bag.set('PRIORITY', String(i + 1)));
}

export function ruleAttributes(r: PcbRule, u: DisplayUnit): string {
  const info = RULE_KINDS.find((k) => k.kind === ruleKind(r));
  const f = lengthIn(u);
  if (ruleKind(r) === 'ShortCircuit') return `Allowed = ${r.bag.bool('ALLOWED') ? 'Yes' : 'No'}`;
  if (ruleKind(r) === 'SignalStimulus') { const st = stimulusOf((k) => r.bag.get(k)); return `Stimulus Kind = ${st.kind}   Start Level = ${st.startHigh ? 'High Level' : 'Low Level'}   Start Time = ${siShow(st.start, 's')}   Stop Time = ${siShow(st.stop, 's')}   Period Time = ${siShow(st.period, 's')}`; }
  return (info?.fields ?? []).map((x) => `${x.label} = ${x.unit ? siShow(siNum(r.bag.get(x.key) ?? x.def), x.unit) : f(r.bag.get(x.key) ?? x.def)}`).join('   ');
}

export function RulesDialog({ ed }: { ed: PcbEditor }) {
  const doc = ed.doc;
  const u = units.value;
  const [draft] = useState<PcbRule[]>(() => doc.rules.map(cloneRule));
  const [, setRev] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [node, setNode] = useState<Node>(() => {
    const first = draft.filter((r) => ruleKind(r) === 'Clearance').sort(byPriority)[0];
    return first ? { t: 'rule', rule: first } : { t: 'root' };
  });
  const cats = kindsByCategory(draft);
  const [open, setOpen] = useState<Set<string>>(() => new Set(['root', ...[...cats].filter(([, ks]) => ks.some((k) => draft.some((r) => ruleKind(r) === k))).map(([c]) => c),
    ...new Set(draft.map(ruleKind))]));
  const [menu, setMenu] = useState<{ x: number; y: number; kind: string; rule?: PcbRule } | null>(null);
  const touch = () => { setRev((n) => n + 1); setDirty(true); };
  const toggle = (k: string) => { const n = new Set(open); if (n.has(k)) n.delete(k); else n.add(k); setOpen(n); };

  const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  const changed = () => draft.length !== doc.rules.length || draft.some((r, i) => !bytesEqual(r.bag.toBytes(), doc.rules[i]!.bag.toBytes()));
  const apply = () => {
    setDirty(false);
    if (!changed()) return;
    ed.undo.transact('Edit Design Rules', (tx) => tx.add(replaceRules(doc, draft.map(cloneRule))));
  };
  const add = (kind: string, from?: PcbRule) => {
    const r = from ? cloneRule(from) : newRule(kind, nextRuleName(draft, kind), 1);
    if (from) { r.bag.set('NAME', nextRuleName(draft, kind)); r.bag.set('UNIQUEID', newRule(kind, '', 1).bag.get('UNIQUEID')!); }
    for (const x of draft) if (ruleKind(x) === kind) x.bag.set('PRIORITY', String(rulePriority(x) + 1));
    r.bag.set('PRIORITY', '1');
    draft.push(r);
    setOpen(new Set([...open, kindCategory(kind), kind]));
    setNode({ t: 'rule', rule: r });
    touch();
  };
  const remove = (r: PcbRule) => {
    const i = draft.indexOf(r);
    if (i < 0) return;
    draft.splice(i, 1);
    renumber(draft, ruleKind(r));
    setNode({ t: 'kind', kind: ruleKind(r) });
    touch();
  };
  const createDefaults = () => {
    const have = new Set(draft.map(ruleKind));
    const fresh = defaultRules().filter((r) => !have.has(ruleKind(r)));
    draft.push(...fresh);
    notify(fresh.length ? `Added ${fresh.length} default rule${fresh.length > 1 ? 's' : ''}` : 'Every rule type already has a rule');
    if (fresh.length) touch();
  };
  const kindOfNode = node.t === 'kind' ? node.kind : node.t === 'rule' ? ruleKind(node.rule) : 'Clearance';

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  const listFor = (n: Node): PcbRule[] => {
    if (n.t === 'kind') return draft.filter((r) => ruleKind(r) === n.kind).sort(byPriority);
    if (n.t === 'cat') return draft.filter((r) => kindCategory(ruleKind(r)) === n.cat).sort((a, b) => ruleKind(a).localeCompare(ruleKind(b)) || byPriority(a, b));
    return [...draft].sort((a, b) => CATEGORIES.indexOf(kindCategory(ruleKind(a))) - CATEGORIES.indexOf(kindCategory(ruleKind(b))) || ruleKind(a).localeCompare(ruleKind(b)) || byPriority(a, b));
  };
  const same = (a: Node, b: Node) => a.t === b.t && (a.t === 'root' || (a.t === 'cat' && a.cat === (b as typeof a).cat) || (a.t === 'kind' && a.kind === (b as typeof a).kind) || (a.t === 'rule' && a.rule === (b as typeof a).rule));

  const ctx = (e: MouseEvent, kind: string, rule?: PcbRule) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, kind, rule }); };

  return (
    <Dialog title={`PCB Rules and Constraints Editor [${u}]`} width={1100} height={680} onClose={closeDialog} class="rules"
      onAccept={() => { apply(); }}
      footer={<>
        <button class="btn" onClick={() => showDialog(RuleWizardDialog, { ed, draft, onMade: (r: PcbRule) => { setOpen(new Set([...open, kindCategory(ruleKind(r)), ruleKind(r)])); setNode({ t: 'rule', rule: r }); touch(); } })}>Rule Wizard...</button>
        <button class="btn" onClick={() => showDialog(PrioritiesDialog, { rules: draft, kind: kindOfNode, onChange: touch })}>Priorities...</button>
        <button class="btn" onClick={createDefaults}>Create Default Rules</button>
        <span class="spacer" />
        <button class="btn default" onClick={() => { apply(); closeDialog(); }}>OK</button>
        <button class="btn" onClick={closeDialog}>Cancel</button>
        <button class="btn" onClick={apply} disabled={!dirty}>Apply</button>
      </>}>
      <div class="rules-layout">
        <nav class="rules-tree" tabIndex={0} aria-label="Design Rules"
          onKeyDown={(e) => { if (e.key === 'Delete' && node.t === 'rule') { e.preventDefault(); remove(node.rule); } }}>
          <TreeRow depth={0} open={open.has('root')} onTwisty={() => toggle('root')} on={node.t === 'root'} onClick={() => setNode({ t: 'root' })} icon="folderOpen" label="Design Rules" />
          {open.has('root') && [...cats].map(([cat, kinds]) => (
            <div key={cat}>
              <TreeRow depth={1} open={open.has(cat)} onTwisty={() => toggle(cat)} on={same(node, { t: 'cat', cat })} onClick={() => setNode({ t: 'cat', cat })} icon={open.has(cat) ? 'folderOpen' : 'folder'} label={cat} />
              {open.has(cat) && kinds.map((kind) => {
                const rs = draft.filter((r) => ruleKind(r) === kind).sort(byPriority);
                return (
                  <div key={kind}>
                    <TreeRow depth={2} open={open.has(kind)} leaf={!rs.length} onTwisty={() => toggle(kind)} on={same(node, { t: 'kind', kind })}
                      onClick={() => setNode({ t: 'kind', kind })} onContext={(e) => ctx(e, kind)} icon="rules" label={kindLabel(kind)} />
                    {open.has(kind) && rs.map((r, i) => (
                      <TreeRow key={i} depth={3} leaf on={node.t === 'rule' && node.rule === r} onClick={() => setNode({ t: 'rule', rule: r })}
                        onContext={(e) => ctx(e, kind, r)} icon="drc" label={ruleName(r)} dim={!ruleEnabled(r)} />
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>
        <div class="rules-pane">
          {node.t === 'rule'
            ? <RuleEditor key={draft.indexOf(node.rule)} rule={node.rule} doc={doc} units={u} onChange={touch} />
            : <RuleTable rules={listFor(node)} units={u} title={node.t === 'kind' ? kindLabel(node.kind) : node.t === 'cat' ? cat(node.cat) : 'Design Rules'}
                onOpen={(r) => setNode({ t: 'rule', rule: r })} onChange={touch} />}
        </div>
      </div>
      {menu && (
        <div class="ctx-menu" style={{ left: `${menu.x}px`, top: `${menu.y}px` }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => { setMenu(null); add(menu.kind); }}>New Rule...</button>
          <button disabled={!menu.rule} onClick={() => { setMenu(null); if (menu.rule) add(menu.kind, menu.rule); }}>Duplicate Rule</button>
          <button disabled={!menu.rule} onClick={() => { setMenu(null); if (menu.rule) remove(menu.rule); }}>Delete Rule...</button>
        </div>
      )}
    </Dialog>
  );
}
const cat = (c: string) => `${c} rules`;

function TreeRow({ depth, open, leaf, on, dim, icon, label, onClick, onTwisty, onContext }: {
  depth: number; open?: boolean; leaf?: boolean; on: boolean; dim?: boolean; icon: string; label: string;
  onClick: () => void; onTwisty?: () => void; onContext?: (e: MouseEvent) => void;
}) {
  return (
    <div class={`rules-row${on ? ' on' : ''}${dim ? ' dim' : ''}`} style={{ paddingLeft: `${4 + depth * 14}px` }} role="treeitem" aria-selected={on}
      onMouseDown={onClick} onDblClick={onTwisty} onContextMenu={onContext as unknown as (e: Event) => void}>
      <span class="tree-twisty" onMouseDown={(e) => { e.stopPropagation(); onTwisty?.(); }}>{leaf ? '' : open ? '▾' : '▸'}</span>
      <ColourIcon name={icon} />
      <span class="tree-name">{label}</span>
    </div>
  );
}

function RuleTable({ rules, units: u, title, onOpen, onChange }: { rules: PcbRule[]; units: DisplayUnit; title: string; onOpen: (r: PcbRule) => void; onChange: () => void }) {
  const [sel, setSel] = useState<number | null>(null);
  return (
    <div class="rules-table">
      <h3 class="rules-title">{title}</h3>
      <Grid
        cols={[
          { label: 'Name', width: 'minmax(120px, 1fr)', get: (r: PcbRule) => ruleName(r) },
          { label: 'Priority', width: '56px', align: 'right', get: (r) => rulePriority(r) },
          { label: 'Enabled', width: '58px', align: 'center', get: (r) => <input type="checkbox" checked={ruleEnabled(r)} onMouseDown={(e) => e.stopPropagation()}
            onChange={(e) => { r.bag.set('ENABLED', (e.target as HTMLInputElement).checked ? 'TRUE' : 'FALSE'); onChange(); }} /> },
          { label: 'Type', width: '150px', get: (r) => kindLabel(ruleKind(r)) },
          { label: 'Category', width: '100px', get: (r) => kindCategory(ruleKind(r)) },
          { label: 'Scope', width: 'minmax(120px, 1fr)', get: (r) => (BINARY_KINDS.has(ruleKind(r)) ? `${ruleScope1(r)} - ${ruleScope2(r)}` : ruleScope1(r)) },
          { label: 'Attributes', width: 'minmax(160px, 1.4fr)', get: (r) => ruleAttributes(r, u) },
        ]}
        rows={rules} sel={sel} onSel={setSel} onOpen={(i) => { const r = rules[i]; if (r) onOpen(r); }}
        empty="No rules. Right-click a rule type and choose New Rule." />
    </div>
  );
}

/* ─── One rule ───────────────────────────────────────────────────────────────────────── */

function RuleEditor({ rule, doc, units: u, onChange }: { rule: PcbRule; doc: PcbDocument; units: DisplayUnit; onChange: () => void }) {
  const kind = ruleKind(rule);
  const info = RULE_KINDS.find((k) => k.kind === kind);
  const set = (k: string, v: string) => { rule.bag.set(k, v); onChange(); };
  const f = lengthIn(u);
  const extra = rule.bag.keys().filter((k) => !COMMON.has(k) && !info?.fields.some((x) => x.key === k));
  return (
    <div class="rule-edit">
      <div class="rule-head">
        <label>Name<input type="text" value={ruleName(rule)} onChange={(e) => set('NAME', (e.target as HTMLInputElement).value.trim() || kind)} /></label>
        <label>Comment<input type="text" value={rule.bag.get('COMMENT') ?? ''} onChange={(e) => set('COMMENT', (e.target as HTMLInputElement).value)} /></label>
        <label>Unique ID<input type="text" value={rule.bag.get('UNIQUEID') ?? ''} readOnly /></label>
        <label class="rule-enabled"><input type="checkbox" checked={ruleEnabled(rule)} onChange={(e) => set('ENABLED', (e.target as HTMLInputElement).checked ? 'TRUE' : 'FALSE')} />Enabled</label>
      </div>
      <ScopeEditor title={BINARY_KINDS.has(kind) ? 'Where The First Object Matches' : 'Where The Object Matches'} value={ruleScope1(rule)} doc={doc} onChange={(v) => set('SCOPE1EXPRESSION', v)} />
      {BINARY_KINDS.has(kind) && <ScopeEditor title="Where The Second Object Matches" value={ruleScope2(rule)} doc={doc} onChange={(v) => set('SCOPE2EXPRESSION', v)} />}
      <fieldset class="rule-constraints">
        <legend>Constraints</legend>
        {kind === 'Clearance' && (
          <label class="rule-field">Connective Checking
            <select value={rule.bag.get('NETSCOPE') ?? 'DifferentNets'} onChange={(e) => set('NETSCOPE', (e.target as HTMLSelectElement).value)}>
              <option value="DifferentNets">Different Nets Only</option><option value="SameNet">Same Net Only</option><option value="AnyNet">Any Net</option>
            </select>
          </label>
        )}
        {kind === 'ShortCircuit' && (
          <label class="rule-field rule-check"><input type="checkbox" checked={rule.bag.bool('ALLOWED')} onChange={(e) => set('ALLOWED', (e.target as HTMLInputElement).checked ? 'TRUE' : 'FALSE')} />Allow Short Circuit</label>
        )}
        {kind === 'PolygonConnect' && (
          <label class="rule-field">Connect Style
            <select value={rule.bag.get('CONNECTSTYLE') ?? 'Relief'} onChange={(e) => set('CONNECTSTYLE', (e.target as HTMLSelectElement).value)}>
              <option value="Relief">Relief Connect</option><option value="Direct">Direct Connect</option><option value="NoConnect">No Connect</option>
            </select>
          </label>
        )}
        {kind === 'SignalStimulus' && <StimulusFields rule={rule} set={set} />}
        {info?.fields.map((x) => (x.unit
          ? <SiValueField key={x.key} label={x.label} value={rule.bag.get(x.key) ?? x.def} unit={x.unit} onCommit={(v) => set(x.key, v)} />
          : <LengthField key={x.key} label={x.label} value={f(rule.bag.get(x.key) ?? x.def)} units={u} onCommit={(v) => set(x.key, v)} />
        ))}
        {!info && kind !== 'SignalStimulus' && !CHECKED_KINDS.includes(kind) && <p class="muted">Konium Designer doesn't check {kindLabel(kind)} rules yet; the rule is kept and saved as it is. Its constraints:</p>}
        {extra.length > 0 && kind !== 'SignalStimulus' && (
          <details class="rule-extra" open={!info}>
            <summary>{info ? 'Other properties' : 'Properties'} ({extra.length})</summary>
            {extra.map((k) => (
              <label key={k} class="rule-field">{k}
                <input type="text" value={rule.bag.get(k) ?? ''} onChange={(e) => set(k, (e.target as HTMLInputElement).value)} />
              </label>
            ))}
          </details>
        )}
      </fieldset>
    </div>
  );
}

/** A Signal Integrity value (volts, ohms, seconds): typed as 1.2, 1.2n, 10k; kept as AD writes it. */
function SiValueField({ label, value, unit, onCommit }: { label: string; value: string; unit: SiUnit; onCommit: (v: string) => void }) {
  const shown = siText(siNum(value)).trim();
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(shown); setBad(false); }, [shown]);
  const commit = () => {
    if (text === shown) return;
    const v = siNum(text);
    if (!Number.isFinite(v)) { setBad(true); return; }
    setBad(false);
    onCommit(siText(v));
  };
  return (
    <label class={`rule-field${bad ? ' bad' : ''}`}>{label}
      <input type="text" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} title={bad ? `Not a value: type a number, e.g. 1.5 or 1.5n (${unit})` : undefined} />
    </label>
  );
}

/** Signal Stimulus: its kind, start level and times. */
function StimulusFields({ rule, set }: { rule: PcbRule; set: (k: string, v: string) => void }) {
  const st = stimulusOf((k) => rule.bag.get(k));
  const put = (patch: Partial<Stimulus>) => { const p = stimulusProps({ ...st, ...patch }); for (const [k, v] of Object.entries(p)) if (rule.bag.get(k) !== v) set(k, v); };
  return (
    <>
      <label class="rule-field">Stimulus Kind
        <select value={st.kind} onChange={(e) => put({ kind: (e.target as HTMLSelectElement).value as Stimulus['kind'] })}>
          {(['Constant Level', 'Single Pulse', 'Periodic Pulse'] as const).map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      <label class="rule-field">Start Level
        <select value={st.startHigh ? 'high' : 'low'} onChange={(e) => put({ startHigh: (e.target as HTMLSelectElement).value === 'high' })}>
          <option value="low">Low Level</option><option value="high">High Level</option>
        </select>
      </label>
      <SiValueField label="Start Time (s)" value={siText(st.start)} unit="s" onCommit={(v) => put({ start: siNum(v) })} />
      <SiValueField label="Stop Time (s)" value={siText(st.stop)} unit="s" onCommit={(v) => put({ stop: siNum(v) })} />
      <SiValueField label="Period Time (s)" value={siText(st.period)} unit="s" onCommit={(v) => put({ period: siNum(v) })} />
    </>
  );
}

function LengthField({ label, value, units: u, onCommit }: { label: string; value: string; units: DisplayUnit; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(value); setBad(false); }, [value]);
  const commit = () => {
    if (text === value) return;
    const v = parseInput(text, u);
    if (v === null) { setBad(true); return; }
    setBad(false);
    onCommit(v);
  };
  return (
    <label class={`rule-field${bad ? ' bad' : ''}`}>{label}
      <input type="text" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }} title={bad ? 'Not a length: type a number (in the dialog units) or e.g. 10mil, 0.25mm' : undefined} />
    </label>
  );
}

/* ─── Scope ──────────────────────────────────────────────────────────────────────────── */

type ScopeMode = 'all' | 'net' | 'netclass' | 'layer' | 'netlayer' | 'custom';
const MODE_LABEL: [ScopeMode, string][] = [['all', 'All'], ['net', 'Net'], ['netclass', 'Net Class'], ['layer', 'Layer'], ['netlayer', 'Net and Layer'], ['custom', 'Custom Query']];

function scopeMode(q: string): { mode: ScopeMode; a?: string; b?: string } {
  const s = q.trim();
  if (!s || /^all$/i.test(s)) return { mode: 'all' };
  let m = /^InNet\('([^']*)'\)$/i.exec(s);
  if (m) return { mode: 'net', a: m[1] };
  m = /^InNetClass\('([^']*)'\)$/i.exec(s);
  if (m) return { mode: 'netclass', a: m[1] };
  m = /^OnLayer\('([^']*)'\)$/i.exec(s);
  if (m) return { mode: 'layer', a: m[1] };
  m = /^InNet\('([^']*)'\)\s+and\s+OnLayer\('([^']*)'\)$/i.exec(s);
  if (m) return { mode: 'netlayer', a: m[1], b: m[2] };
  return { mode: 'custom' };
}

function ScopeEditor({ title, value, doc, onChange }: { title: string; value: string; doc: PcbDocument; onChange: (v: string) => void }) {
  const nets = doc.nets.map((n) => n.name).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const classes = ['All Nets', ...doc.classes.filter((c) => c.kind === 0).map((c) => c.name)];
  const layers = doc.board.copperStack.filter(isSignal).map((l) => doc.board.layerNames.get(l) ?? layerName(l));
  const parsed = scopeMode(value);
  const [custom, setCustom] = useState(parsed.mode === 'custom');
  const cur = custom ? { ...parsed, mode: 'custom' as ScopeMode } : parsed;
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const build = (mode: ScopeMode, a?: string, b?: string): string => {
    switch (mode) {
      case 'all': return 'All';
      case 'net': return `InNet('${a ?? nets[0] ?? ''}')`;
      case 'netclass': return `InNetClass('${a ?? classes[0]}')`;
      case 'layer': return `OnLayer('${a ?? layers[0] ?? 'Top Layer'}')`;
      case 'netlayer': return `InNet('${a ?? nets[0] ?? ''}') And OnLayer('${b ?? layers[0] ?? 'Top Layer'}')`;
      default: return value;
    }
  };
  const status = (() => {
    try { parseQuery(text); } catch (e) { return { ok: false, text: `Syntax error: ${(e as Error).message}` }; }
    try { scopePredicate(text, { doc, polygonNames: new Map() }); return { ok: true, text: 'Query is valid' }; } catch (e) {
      return { ok: false, text: e instanceof UnsupportedQuery ? `Kept, but the DRC can't check it: ${e.message}` : (e as Error).message };
    }
  })();
  const pick = (opts: string[], v: string | undefined, on: (x: string) => void) => (
    <select value={v} onChange={(e) => on((e.target as HTMLSelectElement).value)}>
      {v !== undefined && !opts.includes(v) && <option value={v}>{v}</option>}
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
  return (
    <fieldset class="rule-scope">
      <legend>{title}</legend>
      <div class="rule-scope-modes">
        {MODE_LABEL.map(([m, label]) => (
          <div key={m} class="rule-scope-mode">
            <label><input type="radio" checked={cur.mode === m} onChange={() => { setCustom(m === 'custom'); if (m !== 'custom') onChange(build(m)); }} />{label}</label>
            {cur.mode === m && m === 'net' && pick(nets, cur.a, (x) => onChange(build('net', x)))}
            {cur.mode === m && m === 'netclass' && pick(classes, cur.a, (x) => onChange(build('netclass', x)))}
            {cur.mode === m && m === 'layer' && pick(layers, cur.a, (x) => onChange(build('layer', x)))}
            {cur.mode === m && m === 'netlayer' && <>{pick(nets, cur.a, (x) => onChange(build('netlayer', x, cur.b)))}{pick(layers, cur.b, (x) => onChange(build('netlayer', cur.a, x)))}</>}
          </div>
        ))}
      </div>
      <label class="rule-query">Full Query
        <textarea rows={3} value={text} readOnly={cur.mode !== 'custom'} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onBlur={() => { if (text.trim() !== value) onChange(text.trim() || 'All'); }} />
      </label>
      <p class={`rule-query-status ${status.ok ? 'ok' : 'warn'}`}>{status.text}</p>
    </fieldset>
  );
}

/* ─── Priorities ─────────────────────────────────────────────────────────────────────── */

/** Priorities…: reorder the rules of one type (1 = highest, checked first). */
export function PrioritiesDialog({ rules, kind: initial, onChange }: { rules: PcbRule[]; kind: string; onChange: () => void }) {
  const kinds = [...new Set(rules.map(ruleKind))].sort((a, b) => kindLabel(a).localeCompare(kindLabel(b)));
  const [kind, setKind] = useState(kinds.includes(initial) ? initial : kinds[0] ?? initial);
  const [sel, setSel] = useState<number | null>(0);
  const [, setRev] = useState(0);
  const list = rules.filter((r) => ruleKind(r) === kind).sort(byPriority);
  const move = (d: -1 | 1) => {
    if (sel === null) return;
    const j = sel + d;
    if (j < 0 || j >= list.length) return;
    const a = list[sel]!, b = list[j]!;
    const pa = rulePriority(a);
    a.bag.set('PRIORITY', String(rulePriority(b)));
    b.bag.set('PRIORITY', String(pa));
    setSel(j); setRev((n) => n + 1); onChange();
  };
  return (
    <Dialog title="Edit Rule Priorities" width={640} height={420} onClose={closeDialog} class="priorities"
      footer={<>
        <button class="btn" onClick={() => move(-1)} disabled={!sel}>Increase Priority</button>
        <button class="btn" onClick={() => move(1)} disabled={sel === null || sel >= list.length - 1}>Decrease Priority</button>
        <span class="spacer" />
        <button class="btn default" onClick={closeDialog}>Close</button>
      </>}>
      <label class="rule-field">Rule Type
        <select value={kind} onChange={(e) => { setKind((e.target as HTMLSelectElement).value); setSel(0); }}>
          {kinds.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
        </select>
      </label>
      <Grid
        cols={[
          { label: 'Priority', width: '60px', align: 'right', get: (r: PcbRule) => rulePriority(r) },
          { label: 'Enabled', width: '60px', align: 'center', get: (r) => (ruleEnabled(r) ? '✓' : '') },
          { label: 'Name', width: 'minmax(120px, 1fr)', get: (r) => ruleName(r) },
          { label: 'Scope', width: 'minmax(160px, 1.5fr)', get: (r) => (BINARY_KINDS.has(kind) ? `${ruleScope1(r)} - ${ruleScope2(r)}` : ruleScope1(r)) },
        ]}
        rows={list} sel={sel} onSel={setSel} empty="No rules of this type." />
    </Dialog>
  );
}

