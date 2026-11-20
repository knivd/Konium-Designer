/**
 * Layer Stack Manager › Impedance Calculation...: AD17's Impedance Formula Editor — the
 * Microstrip and Stripline tabs, each with its Calculated Impedance and Calculated Trace Width
 * formulas (Default puts AD17's back) — and below them the formulas worked out on this stack:
 * each signal layer's impedance for a width and width for an impedance. OK keeps the formulas in
 * the board (one undo step).
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { notify } from '../state';
import { openMenuAt } from '../MenuBar';
import { mil, mm, parseLength, trimNum } from '../../core/units';
import type { PcbEditor } from '../../editors/pcb/PcbEditor';
import type { StackLayer } from '../../model/pcbStack';
import { DEFAULT_FORMULAS, FORMULA_VARIABLES, boardFormulas, checkFormula, impedanceOf, setFormulas, stackGeometry, widthFor, type ImpedanceFormulas } from '../../model/impedance';

export function ImpedanceDialog({ ed, rows, metric }: { ed: PcbEditor; rows: StackLayer[]; metric: boolean }) {
  const bag = ed.doc.board.bag;
  const [tab, setTab] = useState<'microstrip' | 'stripline'>('microstrip');
  const [f, setF] = useState<ImpedanceFormulas>(() => boardFormulas(bag));
  const [ohms, setOhms] = useState('50');
  const unit = metric ? 'mm' : 'mil';
  const [width, setWidth] = useState(metric ? '0.2' : '8');
  const geo = stackGeometry(rows);
  const num = (v: number) => (Number.isFinite(v) ? trimNum((v / (metric ? mm(1) : mil(1))).toFixed(metric ? 4 : 3)) : '—');
  const w = parseLength(/^\s*[\d.]+\s*$/.test(width) ? `${width.trim()}${unit}` : width);
  const z = Number(ohms);
  const keys = tab === 'microstrip' ? (['microstripZ', 'microstripW'] as const) : (['striplineZ', 'striplineW'] as const);

  const ok = () => {
    const bad = (Object.keys(f) as (keyof ImpedanceFormulas)[]).map((k) => [k, checkFormula(f[k])] as const).find(([, e]) => e);
    if (bad) { notify(`That formula can't be worked out: ${bad[1]}`, 'error'); return; }
    if (bag && (Object.keys(f) as (keyof ImpedanceFormulas)[]).some((k) => f[k] !== boardFormulas(bag)[k])) {
      ed.undo.transact('Impedance formulas', (tx) => tx.add(setFormulas(bag, f, () => ed.doc.dirty.add('Board6'))));
    }
    closeDialog();
  };

  /** Helper: the variables and functions, put in the formula where its cursor is (AD's Query Helper, for these formulas). */
  const helper = (e: MouseEvent, k: keyof ImpedanceFormulas, title: string) => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const area = (e.currentTarget as HTMLElement).closest('.imp-box')?.querySelector('textarea') as HTMLTextAreaElement | null;
    const put = (text: string) => {
      const v = f[k], at = area ? area.selectionStart ?? v.length : v.length, end = area ? area.selectionEnd ?? at : at;
      setF({ ...f, [k]: v.slice(0, at) + text + v.slice(end) });
      requestAnimationFrame(() => { area?.focus(); area?.setSelectionRange(at + text.length, at + text.length); });
    };
    const fns = ['SQRT', 'EXP', 'LN', 'LOG', 'ABS', 'POWER', 'MIN', 'MAX', 'SIN', 'COS', 'TAN', 'ATAN'];
    openMenuAt({ key: '', label: `Helper: ${title}`, children: [
      { key: 'V', label: 'Variables', children: FORMULA_VARIABLES.map((v, i) => ({ key: String(i), label: v, action: () => put(v) })) },
      { key: 'F', label: 'Functions', children: fns.map((fn, i) => ({ key: String(i), label: `${fn}( )`, action: () => put(`${fn}(`) })) },
      { key: 'O', label: 'Operators', children: ['+', '-', '*', '/', '^', '(', ')'].map((o, i) => ({ key: String(i), label: o, action: () => put(o) })) },
    ] }, b.left, b.bottom + 1);
  };

  const box = (k: keyof ImpedanceFormulas, title: string, help: string) => {
    const err = checkFormula(f[k]);
    return (
      <fieldset class="imp-box">
        <legend>{title}</legend>
        <p class="small muted">{help}</p>
        <textarea rows={4} spellcheck={false} aria-label={title} value={f[k]} class={err ? 'bad' : ''}
          onInput={(e) => setF({ ...f, [k]: (e.target as HTMLTextAreaElement).value })} onKeyDown={(e) => e.stopPropagation()} />
        <div class="imp-buttons">
          {err ? <span class="imp-err" role="alert">{err}</span> : <span />}
          <button class="btn" title="Put a variable, function or operator in the formula" onMouseDown={(e) => { e.preventDefault(); helper(e, k, title); }}>Helper</button>
          <button class="btn" onClick={() => setF({ ...f, [k]: DEFAULT_FORMULAS[k] })}>Default</button>
        </div>
      </fieldset>
    );
  };

  return (
    <Dialog title="Impedance Formula Editor" width={760} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="impedance"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <nav class="out-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'microstrip'} class={tab === 'microstrip' ? 'on' : ''} onClick={() => setTab('microstrip')}>Microstrip</button>
        <button role="tab" aria-selected={tab === 'stripline'} class={tab === 'stripline' ? 'on' : ''} onClick={() => setTab('stripline')}>Stripline</button>
      </nav>
      <div class="out-page imp-page">
        <p class="small">{tab === 'microstrip' ? 'Tracks on an outer layer, a plane on one side.' : 'Tracks on an inner layer, a plane on both sides.'}</p>
        {box(keys[0], 'Calculated Impedance', 'The impedance (Ω) of a track TraceWidth wide.')}
        {box(keys[1], 'Calculated Trace Width', 'The width for an impedance of CharacteristicImpedance (Ω).')}
        <p class="small muted">Variables: {FORMULA_VARIABLES.join(', ')}. Functions: SQRT, EXP, LN, LOG, ABS, POWER, MIN, MAX, SIN, COS, TAN, ATAN.</p>
      </div>
      <fieldset class="imp-check">
        <legend>On This Stack</legend>
        <div class="imp-inputs">
          <label>Impedance (Ω)<input type="text" value={ohms} aria-label="Impedance" onInput={(e) => setOhms((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></label>
          <label>Track width ({unit})<input type="text" value={width} aria-label="Track width" onInput={(e) => setWidth((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} /></label>
        </div>
        <table class="wheel-table imp-table">
          <thead><tr><th>Layer</th><th>Line</th><th>To Plane ({unit})</th><th>Plane to Plane ({unit})</th><th>Copper ({unit})</th><th>Er</th><th>Width for {Number.isFinite(z) ? z : '?'} Ω ({unit})</th><th>Impedance at {width} {unit} (Ω)</th></tr></thead>
          <tbody>
            {geo.map((g) => (
              <tr key={g.layer}>
                <td>{g.name}</td><td>{g.kind === 'stripline' ? 'Stripline' : 'Microstrip'}</td>
                <td>{num(g.traceToPlane)}</td><td>{g.kind === 'stripline' ? num(g.planeToPlane) : ''}</td><td>{num(g.thickness)}</td><td>{trimNum(g.er.toFixed(2))}</td>
                <td>{z > 0 ? num(widthFor(f, g, z)) : '—'}</td>
                <td>{w && w > 0 ? (Number.isFinite(impedanceOf(f, g, w)) ? impedanceOf(f, g, w).toFixed(1) : '—') : '—'}</td>
              </tr>
            ))}
            {!geo.length && <tr><td colSpan={8} class="muted">The stack has no signal layer with a dielectric beside it.</td></tr>}
          </tbody>
        </table>
        <p class="small muted">As this dialog's formulas give them, for the stack as it stands in the Layer Stack Manager [est: lengths in metres in the formulas].</p>
      </fieldset>
    </Dialog>
  );
}
