/**
 * Analyses Setup (Design › Simulate › Mixed Sim) as AD17 lays it out: Analyses/Options on the
 * left, each analysis with its Enabled box; on the right the page of the one selected. General
 * Setup: Collect Data For, Sheets to Netlist, SimView Setup, the Available and Active Signals
 * (> >> < <<) and the Active Analyses. Each analysis: its Parameter / Value list (Set Defaults).
 * Noise, Pole-Zero, the Temperature and Parameter Sweeps and Monte Carlo (every analysis run again
 * for each temperature, value or run). Advanced Options: SPICE's options, the integration method
 * and the Spice Reference Net Name. OK keeps the setup in the project and runs the simulation.
 */
import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import {
  COLLECT_OPTIONS, MC_DISTRIBUTIONS, OPTION_DEFAULTS, PARAM_SWEEP_TYPES, PZ_TRANSFER, PZ_TYPES, SHEETS_OPTIONS, SIMVIEW_OPTIONS, SWEEP_TYPES, acTotalPoints, defaultSettings,
  sweepPoints, sweepRunCount, transientWindow, type SimSettings,
} from '../../sim/settings';
import { engineering, spiceNumber } from '../../sim/num';

type Page = 'general' | 'op' | 'tran' | 'dc' | 'ac' | 'noise' | 'pz' | 'tf' | 'temp' | 'param' | 'mc' | 'advanced';
const PAGES: { id: Page; label: string; enabled?: (s: SimSettings) => boolean; toggle?: (s: SimSettings, on: boolean) => void }[] = [
  { id: 'general', label: 'General Setup' },
  { id: 'op', label: 'Operating Point Analysis', enabled: (s) => s.op, toggle: (s, on) => { s.op = on; } },
  { id: 'tran', label: 'Transient Analysis', enabled: (s) => s.tran.on, toggle: (s, on) => { s.tran.on = on; } },
  { id: 'dc', label: 'DC Sweep Analysis', enabled: (s) => s.dc.on, toggle: (s, on) => { s.dc.on = on; } },
  { id: 'ac', label: 'AC Small Signal Analysis', enabled: (s) => s.ac.on, toggle: (s, on) => { s.ac.on = on; } },
  { id: 'noise', label: 'Noise Analysis', enabled: (s) => s.noise.on, toggle: (s, on) => { s.noise.on = on; } },
  { id: 'pz', label: 'Pole-Zero Analysis', enabled: (s) => s.pz.on, toggle: (s, on) => { s.pz.on = on; } },
  { id: 'tf', label: 'Transfer Function Analysis', enabled: (s) => s.tf.on, toggle: (s, on) => { s.tf.on = on; } },
  { id: 'temp', label: 'Temperature Sweep', enabled: (s) => s.temp.on, toggle: (s, on) => { s.temp.on = on; } },
  { id: 'param', label: 'Parameter Sweep', enabled: (s) => s.param.on, toggle: (s, on) => { s.param.on = on; } },
  { id: 'mc', label: 'Monte Carlo Analysis', enabled: (s) => s.mc.on, toggle: (s, on) => { s.mc.on = on; } },
  { id: 'advanced', label: 'Advanced Options' },
];

const clone = (s: SimSettings): SimSettings => JSON.parse(JSON.stringify(s)) as SimSettings;

/** One Parameter / Value row: a number (shown as AD shows it), a percentage, a choice, a name to type or pick, or a tick. */
function Row({ label, value, onChange, choices, suggest, check, disabled, hint, int, pct, free }: {
  label: string; value?: string; onChange?: (v: string) => void; choices?: readonly string[]; suggest?: readonly string[]; check?: boolean; disabled?: boolean; hint?: string; int?: boolean;
  pct?: boolean; free?: boolean;
}) {
  const numberOk = (v: string) => (pct ? /^\s*\d*\.?\d+\s*%?\s*$/.test(v) : Number.isFinite(spiceNumber(v)));
  const bad = value !== undefined && !choices && !suggest && !free && check === undefined && value.trim() !== '' && !numberOk(value);
  if (suggest) {
    const id = `as-list-${label.replace(/\W+/g, '-')}`;
    return (
      <tr class={disabled ? 'off' : ''}>
        <td>{label}</td>
        <td><input type="text" aria-label={label} list={id} value={value} disabled={disabled} title={hint} spellcheck={false} onInput={(e) => onChange?.((e.target as HTMLInputElement).value)} />
          <datalist id={id}>{suggest.map((c) => <option key={c} value={c} />)}</datalist></td>
      </tr>
    );
  }
  return (
    <tr class={disabled ? 'off' : ''}>
      <td>{label}</td>
      <td>
        {check !== undefined ? <input type="checkbox" aria-label={label} checked={check} disabled={disabled} onChange={(e) => onChange?.((e.target as HTMLInputElement).checked ? '1' : '')} />
          : choices ? <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange?.((e.target as HTMLSelectElement).value)}>{choices.map((c) => <option key={c} value={c}>{c || '(none)'}</option>)}</select>
          : <input type="text" aria-label={label} class={bad ? 'bad' : ''} value={value} disabled={disabled} title={hint} onInput={(e) => onChange?.((e.target as HTMLInputElement).value)}
              onBlur={(e) => { const v = (e.target as HTMLInputElement).value; const n = spiceNumber(v); if (!int && !pct && !free && Number.isFinite(n) && /^[-+.\d]/.test(v.trim())) onChange?.(engineering(n)); }} />}
      </td>
    </tr>
  );
}

export function AnalysesSetupDialog({ settings, signals, sources, parts = [], onOk, sourceFrequencies = [] }: {
  settings: SimSettings; signals: string[]; sources: string[]; sourceFrequencies?: number[];
  /** What Parameter Sweep can vary (R1, C1, Q1[BF] …). */
  parts?: string[];
  onOk: (s: SimSettings) => void;
}) {
  const [s, setS] = useState(() => clone(settings));
  const [page, setPage] = useState<Page>('general');
  const [availSel, setAvailSel] = useState<string[]>([]);
  const [activeSel, setActiveSel] = useState<string[]>([]);
  const up = (f: (x: SimSettings) => void) => setS((old) => { const n = clone(old); f(n); return n; });
  const active = s.activeSignals.filter((x) => signals.some((y) => y.toLowerCase() === x.toLowerCase()));
  const available = signals.filter((x) => !active.some((y) => y.toLowerCase() === x.toLowerCase()));
  const nodesOnly = signals.filter((x) => !/[[#]/.test(x));
  const ok = () => { closeDialog(); onOk(s); };
  const setDefaults = () => {
    const d = defaultSettings();
    up((x) => {
      if (page === 'tran') x.tran = { ...d.tran, on: x.tran.on };
      else if (page === 'dc') x.dc = { ...d.dc, on: x.dc.on, source: sources[0] ?? '', source2: sources[1] ?? '' };
      else if (page === 'ac') x.ac = { ...d.ac, on: x.ac.on };
      else if (page === 'tf') x.tf = { ...d.tf, on: x.tf.on, source: sources[0] ?? '' };
      else if (page === 'noise') x.noise = { ...d.noise, on: x.noise.on, source: sources[0] ?? '', output: nodesOnly[nodesOnly.length - 1] ?? '' };
      else if (page === 'pz') x.pz = { ...d.pz, on: x.pz.on, input: nodesOnly[0] ?? '', output: nodesOnly[nodesOnly.length - 1] ?? '' };
      else if (page === 'temp') x.temp = { ...d.temp, on: x.temp.on };
      else if (page === 'param') x.param = { ...d.param, on: x.param.on, variable: parts[0] ?? '' };
      else if (page === 'mc') x.mc = { ...d.mc, on: x.mc.on };
      else if (page === 'advanced') { x.options = d.options; x.reference = d.reference; x.method = d.method; }
    });
  };
  const win = useMemo(() => transientWindow(s, sourceFrequencies), [s, sourceFrequencies]);
  const meta = PAGES.find((p) => p.id === page)!;

  const body = (() => {
    switch (page) {
      case 'general': return (
        <div class="as-general">
          <div class="as-combos">
            <label>Collect Data For<select value={s.collect} onChange={(e) => up((x) => { x.collect = (e.target as HTMLSelectElement).value as SimSettings['collect']; })}>{COLLECT_OPTIONS.map((o) => <option key={o}>{o}</option>)}</select></label>
            <label>Sheets to Netlist<select value={s.sheets} onChange={(e) => up((x) => { x.sheets = (e.target as HTMLSelectElement).value as SimSettings['sheets']; })}>{SHEETS_OPTIONS.map((o) => <option key={o}>{o}</option>)}</select></label>
            <label>SimView Setup<select value={s.simview} onChange={(e) => up((x) => { x.simview = (e.target as HTMLSelectElement).value as SimSettings['simview']; })}>{SIMVIEW_OPTIONS.map((o) => <option key={o}>{o}</option>)}</select></label>
          </div>
          <div class="as-signals">
            <div class="as-list"><span>Available Signals</span>
              <select multiple aria-label="Available Signals" onChange={(e) => setAvailSel([...(e.target as HTMLSelectElement).selectedOptions].map((o) => o.value))}
                onDblClick={() => up((x) => { x.activeSignals = [...active, ...availSel]; })}>
                {available.map((n) => <option key={n} value={n} selected={availSel.includes(n)}>{n}</option>)}
              </select>
            </div>
            <div class="as-moves">
              <button class="btn" title="Add the selected signals" disabled={!availSel.length} onClick={() => { up((x) => { x.activeSignals = [...active, ...availSel]; }); setAvailSel([]); }}>&gt;</button>
              <button class="btn" title="Add every signal" disabled={!available.length} onClick={() => up((x) => { x.activeSignals = [...active, ...available]; })}>&gt;&gt;</button>
              <button class="btn" title="Remove the selected signals" disabled={!activeSel.length} onClick={() => { up((x) => { x.activeSignals = active.filter((n) => !activeSel.includes(n)); }); setActiveSel([]); }}>&lt;</button>
              <button class="btn" title="Remove every signal" disabled={!active.length} onClick={() => up((x) => { x.activeSignals = []; })}>&lt;&lt;</button>
            </div>
            <div class="as-list"><span>Active Signals</span>
              <select multiple aria-label="Active Signals" onChange={(e) => setActiveSel([...(e.target as HTMLSelectElement).selectedOptions].map((o) => o.value))}
                onDblClick={() => up((x) => { x.activeSignals = active.filter((n) => !activeSel.includes(n)); })}>
                {active.map((n) => <option key={n} value={n} selected={activeSel.includes(n)}>{n}</option>)}
              </select>
            </div>
            <div class="as-list as-analyses"><span>Active Analyses</span>
              <ul aria-label="Active Analyses">{PAGES.filter((p) => p.enabled?.(s)).map((p) => <li key={p.id}>{p.label}</li>)}</ul>
            </div>
          </div>
          {!signals.length && <p class="muted small">The signals are listed once the project's schematics compile.</p>}
        </div>
      );
      case 'op': return <p class="as-note">The operating point: every node voltage and supply current with the sources at their DC values and capacitors open. It has no parameters.</p>;
      case 'tran': {
        const t = s.tran, d = t.useDefaults;
        const set = (k: keyof SimSettings['tran']) => (v: string) => up((x) => { (x.tran as Record<string, unknown>)[k] = typeof x.tran[k] === 'boolean' ? !!v : v; });
        return (
          <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
            <Row label="Transient Start Time" value={d ? engineering(win.start) : t.start} disabled={d} onChange={set('start')} />
            <Row label="Transient Stop Time" value={d ? engineering(win.stop) : t.stop} disabled={d} onChange={set('stop')} />
            <Row label="Transient Step Time" value={d ? engineering(win.step) : t.step} disabled={d} onChange={set('step')} />
            <Row label="Transient Max Step Time" value={d ? engineering(win.maxStep) : t.maxStep} disabled={d} onChange={set('maxStep')} />
            <Row label="Use Initial Conditions" check={t.uic} onChange={set('uic')} />
            <Row label="Use Transient Defaults" check={t.useDefaults} onChange={set('useDefaults')} />
            <Row int label="Default Cycles Displayed" value={t.cycles} disabled={!d} onChange={set('cycles')} />
            <Row int label="Default Points Per Cycle" value={t.points} disabled={!d} onChange={set('points')} />
            <Row label="Enable Fourier" check={t.fourier} onChange={set('fourier')} />
            <Row label="Fourier Fundamental Frequency" value={t.fourierFreq} disabled={!t.fourier} onChange={set('fourierFreq')} />
            <Row int label="Fourier Number of Harmonics" value={t.harmonics} disabled={!t.fourier} onChange={set('harmonics')} />
          </tbody></table>
        );
      }
      case 'dc': {
        const c = s.dc;
        const set = (k: keyof SimSettings['dc']) => (v: string) => up((x) => { (x.dc as Record<string, unknown>)[k] = typeof x.dc[k] === 'boolean' ? !!v : v; });
        const list = ['', ...sources];
        return (
          <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
            <Row label="Primary Source" value={c.source} choices={list} onChange={set('source')} />
            <Row label="Primary Start" value={c.start} onChange={set('start')} />
            <Row label="Primary Stop" value={c.stop} onChange={set('stop')} />
            <Row label="Primary Step" value={c.step} onChange={set('step')} />
            <Row label="Enable Secondary" check={c.secondary} onChange={set('secondary')} />
            <Row label="Secondary Name" value={c.source2} choices={list} disabled={!c.secondary} onChange={set('source2')} />
            <Row label="Secondary Start" value={c.start2} disabled={!c.secondary} onChange={set('start2')} />
            <Row label="Secondary Stop" value={c.stop2} disabled={!c.secondary} onChange={set('stop2')} />
            <Row label="Secondary Step" value={c.step2} disabled={!c.secondary} onChange={set('step2')} />
          </tbody></table>
        );
      }
      case 'ac': {
        const a = s.ac;
        const set = (k: keyof SimSettings['ac']) => (v: string) => up((x) => { (x.ac as Record<string, unknown>)[k] = v; });
        return (
          <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
            <Row label="Start Frequency" value={a.start} onChange={set('start')} />
            <Row label="Stop Frequency" value={a.stop} onChange={set('stop')} />
            <Row label="Sweep Type" value={a.sweep} choices={SWEEP_TYPES} onChange={set('sweep')} />
            <Row int label="Test Points" value={a.points} onChange={set('points')} />
            <tr class="off"><td>Total Test Points</td><td>{acTotalPoints(s)}</td></tr>
          </tbody></table>
        );
      }
      case 'tf': {
        const set = (k: keyof SimSettings['tf']) => (v: string) => up((x) => { (x.tf as Record<string, unknown>)[k] = v; });
        return (
          <>
            <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
              <Row label="Source Name" value={s.tf.source} choices={['', ...sources]} onChange={set('source')} />
              <Row label="Reference Node" value={s.tf.reference} choices={['0', ...nodesOnly]} onChange={set('reference')} />
            </tbody></table>
            <p class="as-note small">The small-signal gain from the source to each active signal's node, with the source's input resistance and the output resistance there.</p>
          </>
        );
      }
      case 'noise': {
        const z = s.noise;
        const set = (k: keyof SimSettings['noise']) => (v: string) => up((x) => { (x.noise as Record<string, unknown>)[k] = v; });
        return (
          <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
            <Row label="Noise Source" value={z.source} choices={['', ...sources]} onChange={set('source')} />
            <Row label="Start Frequency" value={z.start} onChange={set('start')} />
            <Row label="Stop Frequency" value={z.stop} onChange={set('stop')} />
            <Row label="Sweep Type" value={z.sweep} choices={SWEEP_TYPES} onChange={set('sweep')} />
            <Row int label="Test Points" value={z.points} onChange={set('points')} />
            <Row int label="Points Per Summary" value={z.summary} hint="0: the input and output noise; 1: each part's share of the output noise too" onChange={set('summary')} />
            <Row label="Output Node" value={z.output} choices={['', ...nodesOnly]} onChange={set('output')} />
            <Row label="Reference Node" value={z.reference} choices={['0', ...nodesOnly]} onChange={set('reference')} />
            <tr class="off"><td>Total Test Points</td><td>{sweepPoints(z)}</td></tr>
          </tbody></table>
        );
      }
      case 'pz': {
        const z = s.pz;
        const set = (k: keyof SimSettings['pz']) => (v: string) => up((x) => { (x.pz as Record<string, unknown>)[k] = v; });
        return (
          <>
            <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
              <Row label="Input Node" value={z.input} choices={['', ...nodesOnly]} onChange={set('input')} />
              <Row label="Input Reference Node" value={z.inputRef} choices={['0', ...nodesOnly]} onChange={set('inputRef')} />
              <Row label="Output Node" value={z.output} choices={['', ...nodesOnly]} onChange={set('output')} />
              <Row label="Output Reference Node" value={z.outputRef} choices={['0', ...nodesOnly]} onChange={set('outputRef')} />
              <Row label="Transfer Function Type" value={z.transfer} choices={PZ_TRANSFER} onChange={set('transfer')} />
              <Row label="Analysis Type" value={z.type} choices={PZ_TYPES} onChange={set('type')} />
            </tbody></table>
            <p class="as-note small">The poles and zeros of the small-signal transfer function at the operating point, in rad/s. A voltage source across the input nodes is taken out: the test input takes its place.</p>
          </>
        );
      }
      case 'temp': {
        const set = (k: keyof SimSettings['temp']) => (v: string) => up((x) => { (x.temp as Record<string, unknown>)[k] = v; });
        return (
          <>
            <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
              <Row label="Start Temperature" value={s.temp.start} onChange={set('start')} />
              <Row label="Stop Temperature" value={s.temp.stop} onChange={set('stop')} />
              <Row label="Step Temperature" value={s.temp.step} onChange={set('step')} />
            </tbody></table>
            <p class="as-note small">Every analysis enabled is run at each temperature (°C); SimView draws a signal's runs together.</p>
          </>
        );
      }
      case 'param': {
        const q = s.param;
        const set = (k: keyof SimSettings['param']) => (v: string) => up((x) => { (x.param as Record<string, unknown>)[k] = typeof x.param[k] === 'boolean' ? !!v : v; });
        return (
          <>
            <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
              <Row label="Primary Sweep Variable" value={q.variable} suggest={parts} hint="A part (R1: its value) or a model parameter (Q1[BF])" onChange={set('variable')} />
              <Row label="Primary Start Value" value={q.start} onChange={set('start')} />
              <Row label="Primary Stop Value" value={q.stop} onChange={set('stop')} />
              <Row label="Primary Step Value" value={q.step} onChange={set('step')} />
              <Row label="Primary Sweep Type" value={q.type} choices={PARAM_SWEEP_TYPES} onChange={set('type')} />
              <Row label="Enable Secondary" check={q.secondary} onChange={set('secondary')} />
              <Row label="Secondary Sweep Variable" value={q.variable2} suggest={parts} disabled={!q.secondary} onChange={set('variable2')} />
              <Row label="Secondary Start Value" value={q.start2} disabled={!q.secondary} onChange={set('start2')} />
              <Row label="Secondary Stop Value" value={q.stop2} disabled={!q.secondary} onChange={set('stop2')} />
              <Row label="Secondary Step Value" value={q.step2} disabled={!q.secondary} onChange={set('step2')} />
              <Row label="Secondary Sweep Type" value={q.type2} choices={PARAM_SWEEP_TYPES} disabled={!q.secondary} onChange={set('type2')} />
            </tbody></table>
            <p class="as-note small">Relative Values are added to the part's own value [est]. Runs, with the other sweeps: {sweepRunCount(s)}.</p>
          </>
        );
      }
      case 'mc': {
        const m = s.mc;
        const set = (k: keyof SimSettings['mc']) => (v: string) => up((x) => { (x.mc as Record<string, unknown>)[k] = v; });
        return (
          <>
            <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
              <Row int label="Seed" value={m.seed} hint="-1: a different seed each time" onChange={set('seed')} />
              <Row label="Distribution" value={m.distribution} choices={MC_DISTRIBUTIONS} onChange={set('distribution')} />
              <Row int label="Number of Runs" value={m.runs} onChange={set('runs')} />
              <Row pct label="Default Resistor Tolerance" value={m.res} onChange={set('res')} />
              <Row pct label="Default Capacitor Tolerance" value={m.cap} onChange={set('cap')} />
              <Row pct label="Default Inductor Tolerance" value={m.ind} onChange={set('ind')} />
              <Row pct label="Default Transistor Tolerance" value={m.tran} hint="Varies BF, KP or BETA" onChange={set('tran')} />
              <Row pct label="Default DC Source Tolerance" value={m.dcsrc} onChange={set('dcsrc')} />
              <Row free label="Specific Tolerances" value={m.specific} hint="Parts with their own tolerance: R1=1%, C3=20%" onChange={set('specific')} />
            </tbody></table>
            <p class="as-note small">Each run varies every part within its tolerance (Gaussian: the tolerance is 3σ; Worst Case: at either end). Runs, with the other sweeps: {sweepRunCount(s)}.</p>
          </>
        );
      }
      case 'advanced': return (
        <table class="as-params"><thead><tr><th>Parameter</th><th>Value</th></tr></thead><tbody>
          {OPTION_DEFAULTS.map(([k, , what]) => <Row key={k} int={/^ITL/.test(k)} label={k} hint={what} value={s.options[k] ?? ''} onChange={(v) => up((x) => { x.options[k] = v; })} />)}
          <Row label="Integration Method" value={s.method} choices={['Trapezoidal', 'Gear']} onChange={(v) => up((x) => { x.method = v as SimSettings['method']; })} />
          <tr><td>Spice Reference Net Name</td><td><input type="text" aria-label="Spice Reference Net Name" value={s.reference} onInput={(e) => up((x) => { x.reference = (e.target as HTMLInputElement).value; })} /></td></tr>
        </tbody></table>
      );
    }
  })();

  return (
    <Dialog title="Analyses Setup" width={860} height={560} class="analyses-setup" onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="as-layout">
        <div class="as-tree" role="listbox" aria-label="Analyses/Options">
          <div class="as-tree-head"><span>Analyses/Options</span><span>Enabled</span></div>
          {PAGES.map((p) => (
            <div key={p.id} role="option" aria-selected={p.id === page} class={`as-item${p.id === page ? ' on' : ''}`} onClick={() => setPage(p.id)}>
              <span>{p.label}</span>
              {p.id !== 'general' && p.id !== 'advanced' && (
                <input type="checkbox" aria-label={`${p.label} enabled`} checked={!!p.enabled?.(s)}
                  onClick={(e) => e.stopPropagation()} onChange={(e) => { const on = (e.target as HTMLInputElement).checked; up((x) => p.toggle?.(x, on)); }} />
              )}
            </div>
          ))}
        </div>
        <div class="as-page">
          <div class="as-page-head">{page === 'general' ? 'Analyses Setup' : `${meta.label} Setup`}</div>
          <div class="as-page-body">{body}</div>
          {page !== 'general' && page !== 'op' && <div class="as-page-foot"><button class="btn" onClick={setDefaults}>Set Defaults</button></div>}
        </div>
      </div>
    </Dialog>
  );
}
