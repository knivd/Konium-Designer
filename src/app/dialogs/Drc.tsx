import { locale } from '../../core/locale';
import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { ColourIcon } from '../icons';
import { notify, replaceMessages } from '../state';
import { showPanel } from '../dock/store';
import { settings, updateSettings } from '../../core/settings';
import { CHECKED_KINDS, drcRules, lengthIn, runDrc, type DrcReport, type DrcViolation } from '../../model/drc';
import { drcSettings, setDrcSettings, type DrcSettings } from '../../model/drcOptions';
import { CATEGORIES, RULE_TREE, kindCategory, kindLabel, ruleEnabled, ruleHeading, ruleKind, ruleName, type PcbRule } from '../../formats/altium/rules';
import { saveFileAs } from '../../platform/fs';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import { NO_SCRIPT } from '../../core/reportHtml';

/**
 * Tools › Design Rule Check… — the Design Rule Checker: Report Options, then Rules To Check
 * with Online and Batch columns per rule type. Run Design Rule Check posts every violation to
 * Messages (double-click goes to it), marks the objects in green and writes the Design Rule
 * Verification Report.
 */

export const violationClass = (kind: string) => `[${kindLabel(kind)} Constraint Violation]`;

export function DrcDialog({ ed, onRun }: { ed: PcbEditor; onRun?: (r: DrcReport) => void }) {
  const doc = ed.doc;
  const [page, setPage] = useState<string>('report');
  // Rules To Check and the stop count are the board's own, as in AD (saved with it)
  const [online, setOnline] = useState(() => drcSettings(doc).online);
  const [batch, setBatch] = useState(() => drcSettings(doc).batch);
  const [report, setReport] = useState(settings.drcReportFile);
  const [markers, setMarkers] = useState(true);
  const [stop, setStop] = useState(() => drcSettings(doc).stopAt);
  const [stopOn, setStopOn] = useState(true);
  const [opts, setOpts] = useState(() => drcSettings(doc));
  const store = (s: Partial<DrcSettings>, label: string) => ed.undo.transact(label, (tx) => tx.add(setDrcSettings(doc, s)));

  const kinds = [...new Set([...RULE_TREE.map((t) => t.kind), ...doc.rules.map(ruleKind)])];
  const rowsFor = (cat?: string) => kinds.filter((k) => !cat || kindCategory(k) === cat).map((kind) => ({ kind, count: doc.rules.filter((r) => ruleKind(r) === kind && ruleEnabled(r)).length }));
  const flip = (set: Set<string>, k: string, save: (s: Set<string>) => void) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); save(n); };
  const saveOnline = (s: Set<string>) => { setOnline(s); store({ online: s }, 'Rules To Check'); ed.onlineDrc(); };
  const saveBatch = (s: Set<string>) => { setBatch(s); store({ batch: s }, 'Rules To Check'); };

  const run = () => {
    const chosen = batch;
    const t0 = Date.now();
    // The board's markers, Messages and the report all stop at the same violation
    const limit = stopOn ? stop : Infinity;
    const r = markers ? ed.runBatchDrc(chosen, limit) : runDrc(doc, chosen);
    if (r.violations.length > limit) r.violations = r.violations.slice(0, limit);
    postMessages(ed, r);
    if (report) openReport(ed, r, chosen, Date.now() - t0);
    notify(r.violations.length ? `${r.violations.length} rule violation${r.violations.length > 1 ? 's' : ''}` : 'No rule violations');
    onRun?.(r);
    closeDialog();
  };

  const RulesTable = ({ cat }: { cat?: string }) => (
    <Grid
      cols={[
        { label: 'Rule', width: 'minmax(180px, 1.4fr)', get: (x: { kind: string; count: number }) => <span class={CHECKED_KINDS.includes(x.kind) ? '' : 'muted'}>{kindLabel(x.kind)}{x.count ? '' : ' (no rules)'}</span> },
        { label: 'Category', width: '120px', get: (x) => kindCategory(x.kind) },
        { label: 'Online', width: '60px', align: 'center', get: (x) => <input type="checkbox" title={CHECKED_KINDS.includes(x.kind) ? undefined : 'Not checked by Konium Designer yet (kept in the rules, for other tools)'}
          checked={online.has(x.kind)} onChange={() => flip(online, x.kind, saveOnline)} /> },
        { label: 'Batch', width: '60px', align: 'center', get: (x) => <input type="checkbox" title={CHECKED_KINDS.includes(x.kind) ? undefined : 'Not checked by Konium Designer yet (kept in the rules, for other tools)'}
          checked={batch.has(x.kind)} onChange={() => flip(batch, x.kind, saveBatch)} /> },
      ]}
      rows={rowsFor(cat)} />
  );

  return (
    <Dialog title={`Design Rule Checker [${ed.units()}]`} width={900} height={560} onClose={closeDialog} class="drc"
      footer={<>
        <button class="btn default" onClick={run}>Run Design Rule Check...</button>
        <span class="spacer" />
        <button class="btn" onClick={closeDialog}>Close</button>
      </>}>
      <div class="rules-layout">
        <nav class="rules-tree" aria-label="DRC options">
          <Row on={page === 'report'} depth={0} icon="file" label="Report Options" onClick={() => setPage('report')} />
          <Row on={page === 'rules'} depth={0} icon="folderOpen" label="Rules To Check" onClick={() => setPage('rules')} />
          {CATEGORIES.map((c) => <Row key={c} on={page === c} depth={1} icon="rules" label={c} onClick={() => setPage(c)} />)}
        </nav>
        <div class="rules-pane">
          {page === 'report' ? (
            <fieldset class="drc-options">
              <legend>DRC Report Options</legend>
              <label><input type="checkbox" checked={report} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setReport(v); updateSettings({ drcReportFile: v }); }} />Create Report File</label>
              <label><input type="checkbox" checked={markers} onChange={(e) => setMarkers((e.target as HTMLInputElement).checked)} />Create Violations</label>
              <label title="An un-routed net's sub-nets listed in the report"><input type="checkbox" checked={opts.subNet} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setOpts({ ...opts, subNet: v }); store({ subNet: v }, 'Report Options'); }} />Sub-Net Details</label>
              <label><input type="checkbox" checked={opts.shorting} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setOpts({ ...opts, shorting: v }); store({ shorting: v }, 'Report Options'); }} />Verify Shorting Copper</label>
              <label><input type="checkbox" checked={opts.drilledSmt} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setOpts({ ...opts, drilledSmt: v }); store({ drilledSmt: v }, 'Report Options'); }} />Report Drilled SMT Pads</label>
              <label><input type="checkbox" checked={opts.zeroHole} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setOpts({ ...opts, zeroHole: v }); store({ zeroHole: v }, 'Report Options'); }} />Report Multilayer Pads with 0 size Hole</label>
              <label><input type="checkbox" checked={opts.brokenPlanes} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setOpts({ ...opts, brokenPlanes: v }); store({ brokenPlanes: v }, 'Report Options'); }} />Report Broken Planes</label>
              <label><input type="checkbox" checked={opts.deadCopper} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setOpts({ ...opts, deadCopper: v }); store({ deadCopper: v }, 'Report Options'); }} />Report Dead Copper larger than
                <input type="number" min={0} value={opts.deadArea} style={{ width: '70px' }} onChange={(e) => { const n = Math.max(0, +(e.target as HTMLInputElement).value || 0); setOpts({ ...opts, deadArea: n }); store({ deadArea: n }, 'Report Options'); }} />
                sq. mils</label>
              <label><input type="checkbox" checked={opts.starved} onChange={(e) => { const v = (e.target as HTMLInputElement).checked; setOpts({ ...opts, starved: v }); store({ starved: v }, 'Report Options'); }} />Report Starved Thermals with less than
                <input type="number" min={0} max={100} value={opts.starvedPct} style={{ width: '70px' }} onChange={(e) => { const n = Math.min(100, Math.max(0, Math.round(+(e.target as HTMLInputElement).value || 0))); setOpts({ ...opts, starvedPct: n }); store({ starvedPct: n }, 'Report Options'); }} />
                % copper</label>
              <p class="muted small">Broken planes and dead copper are checked with the Un-Routed Net rule ticked for Batch; these reports are warnings.</p>
              <label><input type="checkbox" checked={stopOn} onChange={(e) => setStopOn((e.target as HTMLInputElement).checked)} />Stop when
                <input type="number" min={1} value={stop} style={{ width: '70px' }} onChange={(e) => { const n = Math.max(1, Math.round(+(e.target as HTMLInputElement).value || 500)); setStop(n); store({ stopAt: n }, 'Stop When'); }} />
                violations found</label>
              <p class="muted small">Online DRC also needs Preferences › PCB Editor › General › Online DRC ({settings.pcbOnlineDrc ? 'on' : 'off'}).</p>
            </fieldset>
          ) : <RulesTable cat={page === 'rules' ? undefined : page} />}
        </div>
      </div>
    </Dialog>
  );
}

function Row({ on, depth, icon, label, onClick }: { on: boolean; depth: number; icon: string; label: string; onClick: () => void }) {
  return (
    <div class={`rules-row${on ? ' on' : ''}`} style={{ paddingLeft: `${4 + depth * 14}px` }} onMouseDown={onClick} role="treeitem" aria-selected={on}>
      <ColourIcon name={icon} /><span class="tree-name">{label}</span>
    </div>
  );
}

/* ─── Results ────────────────────────────────────────────────────────────────────────── */

function postMessages(ed: PcbEditor, r: DrcReport): void {
  const name = ed.doc.name;
  replaceMessages('Advanced PCB', [
    ...r.violations.map((v) => ({ doc: name, level: v.error ? 'error' as const : 'warn' as const, cls: violationClass(v.kind), message: v.message, locate: () => ed.showViolation(v) })),
    ...r.notes.map((n) => ({ doc: name, level: 'info' as const, message: `Not checked: ${n}` })),
    { doc: name, level: 'info' as const, message: `Design Rule Check: ${r.violations.length} violation${r.violations.length === 1 ? '' : 's'} (${r.stats.ms} ms)` },
  ]);
  showPanel('messages');
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The Design Rule Verification Report, laid out as Altium's HTML report. */
export function reportHtml(name: string, rules: PcbRule[], kinds: Set<string>, r: DrcReport, ms: number, when = new Date(), subNets = true): string {
  // In the suite's order: by the rule tree's kinds (Modified Polygon is UnpouredPolygon in the file), then as the board lists them
  const tree = new Map(RULE_TREE.map((x, i) => [x.kind, i]));
  const at = (x: PcbRule) => tree.get(ruleKind(x) === 'UnpouredPolygon' ? 'ModifiedPolygon' : ruleKind(x)) ?? 999;
  // A rule that wasn't asked for but holds violations is listed in its place too (Power Plane Connect: the starved thermals, as the suite lists them)
  const holding = new Set(r.violations.filter((v) => v.error).map((v) => v.rule));
  const checked = rules.filter((x) => ruleEnabled(x) && (kinds.has(ruleKind(x)) || holding.has(ruleName(x)))).sort((a, b) => at(a) - at(b));
  const names = new Set(checked.map(ruleName));
  // The Report Options' findings (a pour's dead copper, drilled SMT pads, …) are warnings, as in AD; a plane's are its rules' violations
  const warnings = r.violations.filter((v) => !v.error && !names.has(v.rule));
  const errors = r.violations.filter((v) => !warnings.includes(v));
  const group = (vs: DrcViolation[], init: [string, DrcViolation[]][] = []) => {
    const m = new Map<string, DrcViolation[]>(init);
    for (const v of vs) { if (!m.has(v.rule)) m.set(v.rule, []); m.get(v.rule)!.push(v); }
    return m;
  };
  const byRule = group(errors, checked.map((x) => [ruleName(x), []]));
  const byWarning = group(warnings);
  // The rules' constraints in the units the violations give (the board's)
  const desc = (n: string) => { const x = checked.find((y) => ruleName(y) === n); return x ? ruleHeading(x, (c) => lengthIn(r.units ?? 'mil', c)) : n; };
  const time = (d: Date) => d.toLocaleTimeString(locale());
  const hms = new Date(ms).toISOString().slice(11, 19);
  const rows = (m: Map<string, DrcViolation[]>) => [...m].map(([n, vs]) => `<tr><td><a href="#${encodeURIComponent(n)}">${esc(desc(n))}</a></td><td class="n">${vs.length}</td></tr>`).join('');
  const detail = (m: Map<string, DrcViolation[]>) => [...m].filter(([, vs]) => vs.length).map(([n, vs]) =>
    `<table id="${encodeURIComponent(n)}"><tr><th>${esc(desc(n))}</th></tr>${vs.map((v) => `<tr><td>${esc(v.message)}${subNets && v.details ? v.details.map((d) => `<br><small>${esc(d)}</small>`).join('') : ''}</td></tr>`).join('')}</table>`).join('');
  const waived = r.waived ?? [];
  const waivedHtml = waived.length ? `<h2>Waived Violations</h2><table><tr><th>Violation</th><th>Comment</th><th>Waived by</th><th>Date</th></tr>${waived.map(({ v, w }) =>
    `<tr><td>${esc(v.message)}</td><td>${esc(w.comment)}</td><td>${esc(w.author)}</td><td>${esc(w.created.slice(0, 10))}</td></tr>`).join('')}</table>` : '';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">${NO_SCRIPT}<title>Design Rule Verification Report</title><style>
body{font:13px Arial,sans-serif;color:#000;background:#fff;margin:16px}h1{font-size:20px;color:#1a4b8c}
table{border-collapse:collapse;margin:10px 0;min-width:520px}td,th{border:1px solid #c8c8c8;padding:3px 8px;text-align:left}th{background:#e8edf3}
.n{text-align:right;width:60px}.hdr td{border:0;padding:1px 8px 1px 0}a{color:#1a4b8c}tr.total td{font-weight:bold}
</style></head><body>
<h1>Design Rule Verification Report</h1>
<table class="hdr"><tr><td>Date:</td><td>${when.toLocaleDateString(locale())}</td></tr><tr><td>Time:</td><td>${time(when)}</td></tr>
<tr><td>Elapsed Time:</td><td>${hms}</td></tr><tr><td>Filename:</td><td>${esc(name)}</td></tr>
<tr><td>Warnings:</td><td>${warnings.length}</td></tr><tr><td>Rule Violations:</td><td>${errors.length}</td></tr>${waived.length ? `<tr><td>Waived Violations:</td><td>${waived.length}</td></tr>` : ''}</table>
<h2>Summary</h2>
<table><tr><th>Warnings</th><th class="n">Count</th></tr>${rows(byWarning)}<tr class="total"><td>Total</td><td class="n">${warnings.length}</td></tr></table>
<table><tr><th>Rule Violations</th><th class="n">Count</th></tr>${rows(byRule)}<tr class="total"><td>Total</td><td class="n">${errors.length}</td></tr></table>
${detail(byWarning)}
${detail(byRule)}
${waivedHtml}
${r.notes.length ? `<h2>Not checked by Konium Designer</h2><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
</body></html>`;
}

function openReport(ed: PcbEditor, r: DrcReport, kinds: Set<string>, ms: number): void {
  const base = ed.doc.name.replace(/\.pcbdoc$/i, '');
  const html = reportHtml(ed.doc.name, drcRules(ed.doc), kinds, r, ms, new Date(), drcSettings(ed.doc).subNet);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if (!w) void saveFileAs(`Design Rule Check - ${base}.html`, new TextEncoder().encode(html));
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
