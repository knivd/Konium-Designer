/**
 * Add Wave To Plot / Edit Waveform (SimView › Wave › Add Wave..., Edit Wave...) as AD17 lays it
 * out: the run's Waveforms (shown all, or voltages, currents or powers), the Functions, the
 * Expression they build (OUT-IN, DB(OUT), V(OUT)/V(IN), RMS(R1[i]) …) and the wave's Colour.
 * OK adds it to the selected plot (or a new one) or changes the wave edited.
 */
import { useRef, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { SimDataDocument } from '../../sim/simData';
import { evalWave } from '../../sim/waveExpr';
import { WAVE_COLOURS, chartOf, chartWaves, touch, viewOf, type WaveAt } from '../simView';

const FUNCTIONS: [label: string, insert: string][] = [
  ['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['^', '^'], ['( )', '('],
  ['ABS', 'ABS('], ['SQRT', 'SQRT('], ['EXP', 'EXP('], ['LN', 'LN('], ['LOG10', 'LOG10('], ['SIN', 'SIN('], ['COS', 'COS('], ['TAN', 'TAN('],
  ['ATAN', 'ATAN('], ['SINH', 'SINH('], ['COSH', 'COSH('], ['TANH', 'TANH('], ['AVG', 'AVG('], ['RMS', 'RMS('],
  ['DB', 'DB('], ['MAG', 'MAG('], ['PHASE', 'PHASE('], ['REAL', 'REAL('], ['IMAG', 'IMAG('],
];
const KINDS = ['All', 'Voltage', 'Current', 'Power'] as const;

export function AddWaveDialog({ d, k, edit, newPlot }: { d: SimDataDocument; k: number; edit?: WaveAt; newPlot?: boolean }) {
  const cp = chartOf(d, k)!;
  const { c, p } = cp;
  const editing = edit ? c.plots[edit.plot]?.[edit.wave] : undefined;
  const [expr, setExpr] = useState(editing?.expr ?? '');
  const [colour, setColour] = useState(editing?.colour ?? '');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('All');
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const names = p.vectors.filter((v) => kind === 'All' || (kind === 'Voltage' ? v.unit === 'V' : kind === 'Current' ? v.unit === 'A' : v.unit === 'W')).map((v) => v.name);
  const insert = (t: string) => {
    const el = field.current;
    const at = el?.selectionStart ?? expr.length, end = el?.selectionEnd ?? expr.length;
    const next = expr.slice(0, at) + t + expr.slice(end);
    setExpr(next);
    setError('');
    setTimeout(() => { el?.focus(); el?.setSelectionRange(at + t.length, at + t.length); }, 0);
  };
  const ok = () => {
    const e = expr.trim();
    if (!e) { setError('Type an expression, or pick a waveform'); return false; }
    try { evalWave(e, p); } catch (err) { setError((err as Error).message); return false; }
    const ref = { expr: e, ...(colour ? { colour } : {}) };
    const view = viewOf(d);
    if (editing && edit) c.plots[edit.plot]![edit.wave] = ref;
    else {
      const sel = view.selected.get(k);
      if (!newPlot && sel && c.plots[sel.plot]) { c.plots[sel.plot]!.push(ref); view.selected.set(k, { plot: sel.plot, wave: c.plots[sel.plot]!.length - 1 }); }
      else { c.plots.push([ref]); view.selected.set(k, { plot: c.plots.length - 1, wave: 0 }); }
    }
    closeDialog();
    touch(d);
    return false;
  };
  const autoColour = WAVE_COLOURS[(editing ? chartWaves(c).findIndex((w) => w.plot === edit!.plot && w.wave === edit!.wave) : chartWaves(c).length) % WAVE_COLOURS.length]!;
  return (
    <Dialog title={editing ? 'Edit Waveform' : 'Add Wave To Plot'} width={620} height={520} class="addwave" onClose={closeDialog} onAccept={ok}
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>{editing ? 'OK' : 'Create'}</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="aw-lists">
        <div class="aw-list">
          <label>Waveforms <select aria-label="Show" value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value as (typeof KINDS)[number])}>{KINDS.map((x) => <option key={x}>{x}</option>)}</select></label>
          <select multiple size={12} aria-label="Waveforms" onDblClick={(e) => { const v = (e.target as HTMLOptionElement).value; if (v) insert(v); }}
            onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v && !expr.trim()) { setExpr(v); setError(''); } }}>
            {names.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div class="aw-list">
          <span>Functions</span>
          <select multiple size={12} aria-label="Functions" onDblClick={(e) => { const i = Number((e.target as HTMLOptionElement).value); if (FUNCTIONS[i]) insert(FUNCTIONS[i]![1]); }}>
            {FUNCTIONS.map(([l], i) => <option key={l} value={i}>{l}</option>)}
          </select>
        </div>
      </div>
      <p class="muted small">Double-click a waveform or a function to put it in the expression.{p.complex ? ' On an AC chart the arithmetic is complex; DB, MAG and PHASE take a complex wave to a real one.' : ''}</p>
      <label class="aw-expr">Expression <input ref={field} type="text" value={expr} spellcheck={false} autoFocus aria-label="Expression"
        onInput={(e) => { setExpr((e.target as HTMLInputElement).value); setError(''); }} /></label>
      {error && <p class="warn small" role="alert">{error}</p>}
      <label class="aw-colour">Colour <select value={colour} aria-label="Colour" onChange={(e) => setColour((e.target as HTMLSelectElement).value)} style={{ color: colour || autoColour }}>
        <option value="" style={{ color: autoColour }}>Automatic</option>
        {WAVE_COLOURS.map((h) => <option key={h} value={h} style={{ color: h }}>{h}</option>)}
      </select></label>
    </Dialog>
  );
}
