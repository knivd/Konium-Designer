/**
 * Signal Integrity (AD's panel): every net screened — its status against the tolerances and the
 * board's rules, the overshoot and undershoot of each edge and, by Menu › Show Columns, the top
 * and base values, flight times, slopes, length and impedance; the picked net's pins (driver,
 * receivers, their models) and the terminations to try with their values (suggested from the
 * line, or typed). Reflections... opens the picked nets' waveforms, Crosstalk... the noise an
 * aggressor (Set Aggressor, else the first picked) puts on its victims (Set Victim, else the nets
 * beside it). Right-click a net for the rest; double-click shows it on the board or schematic.
 */
import { useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { active, notify, tick, units } from '../state';
import { showDialog } from '../dialogs';
import { InfoDialog } from '../dialogs/Confirm';
import { SiModelsDialog, SiSetupDialog, SiTolerancesDialog } from '../dialogs/SignalIntegrity';
import { openMenuAt } from '../MenuBar';
import { PcbEditor, primKey } from '../../editors/pcb/PcbEditor';
import { NO_NET } from '../../model/pcb';
import { crossProbe } from '../project';
import { coupledNets } from '../../si/crosstalk';
import { siShow } from '../../si/rules';
import { TERMINATIONS, termValues, type TermKind, type TermValues } from '../../si/screen';
import { formatCoord } from '../../core/units';
import { readSiSetup, saveSiSetup } from '../siProject';
import { analyseDesign, crosstalk, forgetPrepared, netNetwork, reflections, siBusy, siMarks, siRun, siTarget, type SiRow } from '../siRun';
import { designFacts } from '../siProject';

type Col = { id: string; label: string; get: (r: SiRow) => string; num?: (r: SiRow) => number };
const v = (x: number | undefined) => siShow(x, 'V'), s = (x: number | undefined) => siShow(x, 's');
const COLUMNS: Col[] = [
  { id: 'fo', label: 'Falling Edge Overshoot', get: (r) => v(r.falling?.overshoot), num: (r) => r.falling?.overshoot ?? -1 },
  { id: 'fu', label: 'Falling Edge Undershoot', get: (r) => v(r.falling?.undershoot), num: (r) => r.falling?.undershoot ?? -1 },
  { id: 'ro', label: 'Rising Edge Overshoot', get: (r) => v(r.rising?.overshoot), num: (r) => r.rising?.overshoot ?? -1 },
  { id: 'ru', label: 'Rising Edge Undershoot', get: (r) => v(r.rising?.undershoot), num: (r) => r.rising?.undershoot ?? -1 },
  { id: 'base', label: 'Base Value', get: (r) => v(r.falling?.level), num: (r) => r.falling?.level ?? -1 },
  { id: 'top', label: 'Top Value', get: (r) => v(r.rising?.level), num: (r) => r.rising?.level ?? -1 },
  { id: 'ff', label: 'Falling Edge Flight Time', get: (r) => s(r.falling?.flight), num: (r) => r.falling?.flight ?? -1 },
  { id: 'rf', label: 'Rising Edge Flight Time', get: (r) => s(r.rising?.flight), num: (r) => r.rising?.flight ?? -1 },
  { id: 'fs', label: 'Falling Edge Slope', get: (r) => s(r.falling?.slope), num: (r) => r.falling?.slope ?? -1 },
  { id: 'rs', label: 'Rising Edge Slope', get: (r) => s(r.rising?.slope), num: (r) => r.rising?.slope ?? -1 },
  { id: 'len', label: 'Length', get: (r) => (r.length === undefined ? '—' : `${formatCoord(r.length, units.value, 1)}${r.estimated ? ' [est]' : ''}`), num: (r) => r.length ?? -1 },
  { id: 'z', label: 'Impedance', get: (r) => (r.zMin === undefined ? '—' : Math.abs(r.zMax! - r.zMin) < 0.5 ? `${r.zMin.toFixed(1)} Ω` : `${r.zMin.toFixed(1)}–${r.zMax!.toFixed(1)} Ω`), num: (r) => r.zMin ?? -1 },
  { id: 'drv', label: 'Driver', get: (r) => r.driver ?? '' },
];
const shown = signal(new Set(['fo', 'fu', 'ro', 'ru']));
const sortBy = signal<{ id: string; desc: boolean }>({ id: 'net', desc: false });
const picked = signal<Set<string>>(new Set());
const STATUS_RANK: Record<string, number> = { Failed: 0, 'Analysis errors': 1, Passed: 2, 'Not analysed': 3 };

export function SignalIntegrityPanel() {
  void tick.value;
  const t = siTarget();
  const run = siRun.value?.key === t?.key ? siRun.value : null;
  const busy = siBusy.value;
  const [anchor, setAnchor] = useState<string | null>(null);
  const cols = COLUMNS.filter((c) => shown.value.has(c.id));
  const rows = useMemo(() => {
    const list = [...(run?.rows ?? [])];
    const sb = sortBy.value;
    const col = COLUMNS.find((c) => c.id === sb.id);
    list.sort((a, b) => {
      const d = sb.id === 'status' ? (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || a.net.localeCompare(b.net, 'en', { numeric: true })
        : col?.num ? col.num(a) - col.num(b) : col ? col.get(a).localeCompare(col.get(b)) : a.net.localeCompare(b.net, 'en', { numeric: true });
      return sb.desc ? -d : d;
    });
    return list;
  }, [run, sortBy.value]);
  if (!t) return <section class="panel sipanel"><p class="panel-empty">Open a board, or a schematic of a project.</p></section>;
  const sel = picked.value;
  const first = rows.find((r) => sel.has(r.net)) ?? null;
  const marks = siMarks.value;
  const failed = run?.rows.filter((r) => r.status === 'Failed').length ?? 0;
  const analysed = run?.rows.filter((r) => r.status === 'Passed' || r.status === 'Failed').length ?? 0;

  const click = (ev: MouseEvent, r: SiRow) => {
    const next = new Set(ev.ctrlKey || ev.metaKey ? sel : []);
    if (ev.shiftKey && anchor) {
      const a = rows.findIndex((x) => x.net === anchor), b = rows.findIndex((x) => x.net === r.net);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(rows[i]!.net);
    } else if ((ev.ctrlKey || ev.metaKey) && sel.has(r.net)) next.delete(r.net);
    else next.add(r.net);
    if (!ev.shiftKey) setAnchor(r.net);
    picked.value = next;
  };
  const show = (r: SiRow) => {
    const ed = active.value?.editor;
    if (ed instanceof PcbEditor && r.netIndex !== undefined && r.netIndex !== NO_NET) {
      const doc = ed.doc;
      const keys = [...doc.prims.filter((p) => 'net' in p && p.net === r.netIndex).map(primKey), ...doc.polygons.filter((pg) => pg.net === r.netIndex).map((pg) => `poly:${pg.index}`)];
      ed.setMask(keys, false); ed.select(keys);
      if (keys.length) ed.zoomToBox(ed.boundsOf(keys), 2_000_000);
      ed.invalidateOverlay(); tick.value++;
      return;
    }
    const net = designFacts(t.project).compiled?.nets.find((n) => n.name === r.net);
    if (net?.refs.length) crossProbe(net.refs, t.project);
  };
  const mark = (names: string[], m: 'aggressor' | 'victim' | null) => {
    const next = new Map(marks);
    if (m === 'aggressor') for (const [k, x] of next) if (x === 'aggressor') next.delete(k);
    for (const n of names) { if (m) next.set(n, m); else next.delete(n); }
    siMarks.value = next;
  };
  const findCoupled = (r: SiRow) => {
    const ed = active.value?.editor;
    if (!(ed instanceof PcbEditor) || r.netIndex === undefined) { notify('Find Coupled Nets: open the board', 'error'); return; }
    const near = coupledNets(ed.doc, r.netIndex).map((c) => ed.doc.nets[c.net]?.name ?? '').filter(Boolean);
    picked.value = new Set([r.net, ...near]);
    notify(near.length ? `Coupled to ${r.net}: ${near.slice(0, 12).join(', ')}${near.length > 12 ? ' …' : ''}` : `No net runs beside ${r.net}`);
  };
  const doCrosstalk = () => {
    const agg = [...marks].find(([, m]) => m === 'aggressor')?.[0] ?? first?.net;
    if (!agg) { notify('Crosstalk: pick a net, or Set Aggressor on one', 'error'); return; }
    let victims = [...marks].filter(([, m]) => m === 'victim').map(([n]) => n);
    if (!victims.length) victims = [...sel].filter((n) => n !== agg);
    if (!victims.length) {
      const ed = active.value?.editor;
      const row = rows.find((x) => x.net === agg);
      if (ed instanceof PcbEditor && row?.netIndex !== undefined) victims = coupledNets(ed.doc, row.netIndex).slice(0, 4).map((c) => ed.doc.nets[c.net]?.name ?? '').filter(Boolean);
    }
    if (!victims.length) { notify(`Crosstalk: no net runs beside ${agg}`, 'error'); return; }
    crosstalk(agg, victims);
  };
  const details = (r: SiRow) => showDialog(InfoDialog, { title: `Net ${r.net}`, lines: [
    `Status: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`,
    ...(r.driver ? [`Driver: ${r.driver}; receivers: ${r.receivers?.join(', ') ?? ''}`] : []),
    ...(r.rising ? [`Rising edge: overshoot ${v(r.rising.overshoot)}, undershoot ${v(r.rising.undershoot)}, top value ${v(r.rising.level)}, flight time ${s(r.rising.flight)}, slope ${s(r.rising.slope)}`] : []),
    ...(r.falling ? [`Falling edge: overshoot ${v(r.falling.overshoot)}, undershoot ${v(r.falling.undershoot)}, base value ${v(r.falling.level)}, flight time ${s(r.falling.flight)}, slope ${s(r.falling.slope)}`] : []),
    ...(r.length !== undefined ? [`Length ${formatCoord(r.length, units.value, 1)}${r.estimated ? ' (partly estimated: pins the copper doesn\'t reach)' : ''}; impedance ${r.zMin?.toFixed(1)}–${r.zMax?.toFixed(1)} Ω`] : []),
    ...r.fails.map((f) => `Fails: ${f.text}`),
  ] });
  const rowMenu = (ev: MouseEvent, r: SiRow) => {
    ev.preventDefault();
    if (!sel.has(r.net)) picked.value = new Set([r.net]);
    const names = sel.has(r.net) ? [...sel] : [r.net];
    openMenuAt({ key: '', label: '', children: [
      { key: 'A', label: 'Set Aggressor', accelAt: 4, action: () => mark([r.net], 'aggressor') },
      { key: 'V', label: 'Set Victim', accelAt: 4, action: () => mark(names, 'victim') },
      { key: 'C', label: 'Clear Status', accelAt: 0, disabled: !names.some((n) => marks.has(n)), action: () => mark(names, null) },
      { key: 'F', label: 'Find Coupled Nets', accelAt: 0, separatorBefore: true, disabled: !run?.board, action: () => findCoupled(r) },
      { key: 'P', label: 'Cross Probe', accelAt: 6, action: () => show(r) },
      { key: 'O', label: 'Copy', accelAt: 1, action: () => void navigator.clipboard?.writeText(rows.filter((x) => names.includes(x.net)).map((x) => [x.net, x.status, ...cols.map((c) => c.get(x))].join('\t')).join('\n')) },
      { key: 'S', label: 'Show Columns', accelAt: 0, separatorBefore: true, children: COLUMNS.map((c, i) => ({ key: String.fromCharCode(65 + i), label: c.label, checked: shown.value.has(c.id), action: () => toggleCol(c.id) })) },
      { key: 'D', label: 'Details...', accelAt: 0, separatorBefore: true, action: () => details(r) },
    ] }, ev.clientX, ev.clientY);
  };
  const menu = (ev: MouseEvent) => {
    const b = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt({ key: '', label: '', children: [
      { key: 'S', label: 'Setup Options...', accelAt: 0, action: () => showDialog(SiSetupDialog, { onDone: reanalyse }) },
      { key: 'T', label: 'Set Tolerances...', accelAt: 4, action: () => showDialog(SiTolerancesDialog, { onDone: reanalyse }) },
      { key: 'M', label: 'Model Assignments...', accelAt: 0, action: () => showDialog(SiModelsDialog, { onDone: reanalyse }) },
      { key: 'C', label: 'Show Columns', accelAt: 5, separatorBefore: true, children: COLUMNS.map((c, i) => ({ key: String.fromCharCode(65 + i), label: c.label, checked: shown.value.has(c.id), action: () => toggleCol(c.id) })) },
      { key: 'R', label: 'Display Report', accelAt: 8, disabled: !run, action: report },
    ] }, b.left, b.top - 4);
  };
  const report = () => {
    if (!run) return;
    const lines = [`Signal Integrity — ${run.name}`, `${run.rows.length} nets: ${analysed} analysed (${failed} failed), ${run.rows.length - analysed} not analysed; ${(run.ms / 1000).toFixed(1)} s`, '',
      ['Net', 'Status', ...COLUMNS.map((c) => c.label)].join('\t'),
      ...rows.map((r) => [r.net, r.status + (r.reason ? ` (${r.reason})` : ''), ...COLUMNS.map((c) => c.get(r))].join('\t'))];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${run.name.replace(/\.[^.]+$/, '')}_SignalIntegrity.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const header = (id: string, label: string) => (
    <span role="columnheader" class="si-sort" onClick={() => { sortBy.value = { id, desc: sortBy.value.id === id ? !sortBy.value.desc : id !== 'net' && id !== 'status' }; }}>
      {label}{sortBy.value.id === id ? (sortBy.value.desc ? ' ▾' : ' ▴') : ''}
    </span>
  );
  const grid = `minmax(110px,1.4fr) 92px ${cols.map(() => 'minmax(96px,1fr)').join(' ')}`;
  return (
    <section class="panel sipanel" aria-label="Signal Integrity">
      <div class="panel-body si-body">
        <div class="si-main">
          <div class="pcbp-table si-nets" role="grid" aria-label="Nets" style={{ '--cols': grid } as Record<string, string>}>
            <div class="pcbp-row head">{header('net', 'Net')}{header('status', 'Status')}{cols.map((c) => header(c.id, c.label))}</div>
            <div class="pcbp-body">
              {!run && !busy && <p class="panel-empty">Reanalyse Design screens every net.</p>}
              {rows.map((r) => (
                <div key={r.net} role="row" class={`pcbp-row${sel.has(r.net) ? ' on' : ''} si-${r.status === 'Failed' ? 'fail' : r.status === 'Passed' ? 'pass' : 'na'}`}
                  onMouseDown={(ev) => click(ev as unknown as MouseEvent, r)} onDblClick={() => show(r)} onContextMenu={(ev) => rowMenu(ev as unknown as MouseEvent, r)}
                  title={r.reason ?? r.fails.map((f) => f.text).join('\n')}>
                  <span>{marks.get(r.net) === 'aggressor' ? '⚡ ' : marks.get(r.net) === 'victim' ? '◎ ' : ''}{r.net}</span>
                  <span>{r.status}</span>
                  {cols.map((c) => <span key={c.id} class={r.fails.some((f) => colOf(f.limit) === c.id) ? 'si-bad' : ''}>{c.get(r)}</span>)}
                </div>
              ))}
            </div>
          </div>
          <NetSide name={first?.net ?? null} row={first} />
        </div>
        <div class="si-bar">
          <button class="btn" onClick={menu}>Menu ▾</button>
          <button class="btn" disabled={!!busy} onClick={reanalyse}>Reanalyse Design</button>
          <button class="btn" onClick={() => showDialog(SiModelsDialog, { onDone: reanalyse })}>Model Assignments...</button>
          <span class="spacer" />
          <span class="muted si-state">{busy ? `Analysing ${busy.done} of ${busy.total} nets…` : run ? `${analysed} of ${run.rows.length} nets analysed, ${failed} failed (${(run.ms / 1000).toFixed(1)} s)` : ''}</span>
          <button class="btn" disabled={!sel.size} onClick={() => reflections([...sel])}>Reflections...</button>
          <button class="btn" disabled={!run?.board || (!sel.size && ![...marks.values()].includes('aggressor'))} onClick={doCrosstalk}>Crosstalk...</button>
        </div>
      </div>
    </section>
  );
}

const colOf = (limit: string) => ({ overshootFalling: 'fo', undershootFalling: 'fu', overshootRising: 'ro', undershootRising: 'ru', base: 'base', top: 'top', flightFalling: 'ff', flightRising: 'rf', slopeFalling: 'fs', slopeRising: 'rs', zMin: 'z', zMax: 'z' } as Record<string, string>)[limit];
function toggleCol(id: string) { const n = new Set(shown.value); if (n.has(id)) n.delete(id); else n.add(id); shown.value = n; }
function reanalyse() { forgetPrepared(); void analyseDesign(); }

/** The picked net: its pins, and the terminations to try. */
function NetSide({ name, row }: { name: string | null; row: SiRow | null }) {
  const t = siTarget();
  const nw = useMemo(() => (name ? netNetwork(name, t) : null), [name, t?.key, siRun.value]);
  const setup = readSiSetup(t?.project ?? null, t?.name ?? '');
  const network = nw && typeof nw !== 'string' ? nw : null;
  const setTerm = (kind: TermKind, patch: { on?: boolean; values?: TermValues }) => {
    const was = setup.terms.get(kind) ?? { on: false, values: {} };
    setup.terms.set(kind, { on: patch.on ?? was.on, values: patch.values ? { ...was.values, ...patch.values } : was.values });
    saveSiSetup(t?.project ?? null, setup, t?.name ?? '');
    forgetPrepared();
    tick.value++;
  };
  const pins = network ? [{ d: network.driver, dir: 'Out' }, ...network.receivers.map((r) => ({ d: r, dir: 'In' }))] : [];
  return (
    <>
      <div class="pcbp-table si-pins" role="grid" aria-label="Pins" style={{ '--cols': '64px 40px 62px minmax(80px,1fr)' } as Record<string, string>}>
        <div class="pcbp-row head"><span>Designator</span><span>Pin</span><span>Direction</span><span>Model</span></div>
        <div class="pcbp-body">
          {!name && <p class="panel-empty">Pick a net.</p>}
          {name && !network && <p class="panel-empty">{row?.reason ?? (typeof nw === 'string' ? nw : 'Not analysed')}</p>}
          {pins.map((p) => <div key={`${p.d.designator}-${p.d.pin}`} role="row" class="pcbp-row"><span>{p.d.designator}</span><span>{p.d.pin}</span><span>{p.dir}</span><span>{p.d.model.name}</span></div>)}
        </div>
      </div>
      <fieldset class="si-terms">
        <legend>Termination</legend>
        {TERMINATIONS.filter((x) => x.kind !== 'none').map((x) => {
          const st = setup.terms.get(x.kind) ?? { on: false, values: {} };
          const sug = network ? termValues(network, x.kind) : {};
          const field = (k: 'r' | 'r2' | 'c', label: string, unit: string) => (
            <label class="si-term-val">{label}
              <input type="text" aria-label={`${x.label} ${label}`} placeholder={sug[k] !== undefined ? siShow(sug[k], unit).replace(/ /, '') : ''} value={st.values[k] !== undefined ? siShow(st.values[k], unit).replace(/ /, '') : ''}
                onChange={(e) => { const raw = (e.target as HTMLInputElement).value.trim(); const n = raw ? Number.parseFloat(raw) * mult(raw) : NaN; setTerm(x.kind, { values: { [k]: raw && Number.isFinite(n) ? n : undefined } }); }} />
            </label>
          );
          return (
            <div key={x.kind} class="si-term">
              <label><input type="checkbox" checked={st.on} onChange={(e) => setTerm(x.kind, { on: (e.target as HTMLInputElement).checked })} />{x.label}</label>
              <span class="si-term-vals">
                {(x.kind === 'series' || x.kind === 'pullup' || x.kind === 'pulldown' || x.kind === 'rc') && field('r', 'R', 'Ω')}
                {x.kind === 'thevenin' && <>{field('r', 'R1', 'Ω')}{field('r2', 'R2', 'Ω')}</>}
                {(x.kind === 'cap' || x.kind === 'rc') && field('c', 'C', 'F')}
              </span>
            </div>
          );
        })}
        <p class="muted si-hint">Ticked terminations are drawn with the unterminated net in Reflections. Empty values take the suggested ones (grey).</p>
      </fieldset>
    </>
  );
}

/** A typed value's multiplier: 22, 22R, 4.7k, 10p, 1n. */
function mult(raw: string): number {
  const m = /[\d.]\s*(meg|[fpnuµmkKMG])/i.exec(raw);
  if (!m) return 1;
  const p = m[1]!;
  if (/^meg$/i.test(p)) return 1e6;
  return ({ f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9 } as Record<string, number>)[p] ?? 1;
}
