/**
 * Sim Data (SimView's panel) as AD17 has it: Source Data — the signals of the chart in front
 * (double-click puts one on the selected plot); Measurement Cursors — cursors A and B on their
 * waves: their X and Y, B − A, and the Minimum, Maximum, Average, RMS and Frequency of the wave
 * between them; Waveform Measurements — the selected wave's Rise Time, Fall Time, Minimum,
 * Maximum, Base and Top.
 */
import { useState } from 'preact/hooks';
import { tick } from '../state';
import { activeSimData, chartOf, eng, shownValues, simViewTick, touch, viewOf, waveData, waveUnit, type AcShow } from '../simView';
import { cursorStats, waveMeasures, yAt } from '../../sim/measure';

export function SimDataPanel() {
  void tick.value;
  void simViewTick.value;
  const [filter, setFilter] = useState('');
  const d = activeSimData();
  const cp = d ? chartOf(d, d.active) : null;
  if (!d || !cp) return <p class="panel-empty">Open simulation results (a .sdf) to see their data here.</p>;
  const { c, p } = cp;
  const view = viewOf(d);
  const how: AcShow = view.ac.get(d.active) ?? 'Magnitude';
  const sel = view.selected.get(d.active) ?? null;
  const cur = view.cursors.get(d.active) ?? {};
  const xs = p.x?.values ?? [];
  const xu = p.x?.unit ?? '';
  const ys = (plot: number, wave: number) => { const w = c.plots[plot]?.[wave]; const v = w ? waveData(p, w.expr) : null; return !w || !v || v instanceof Error ? null : { expr: w.expr, y: shownValues(v, how), unit: waveUnit(p, w.expr, v, how) }; };
  const add = (name: string) => {
    if (sel && c.plots[sel.plot]) c.plots[sel.plot]!.push({ expr: name }); else c.plots.push([{ expr: name }]);
    touch(d);
  };
  const wa = cur.a ? ys(cur.a.plot, cur.a.wave) : null, wb = cur.b ? ys(cur.b.plot, cur.b.wave) : null;
  // Statistics between the cursors on cursor A's wave (or B's, with one cursor)
  const on = wa ?? wb;
  const stats = on && p.x ? cursorStats(xs, on.y, cur.a?.x ?? cur.b!.x, cur.b?.x ?? cur.a!.x) : null;
  // Each cursor's reading on its own wave (B − A only in one unit)
  const ya = cur.a && wa && p.x ? yAt(xs, wa.y, cur.a.x) : NaN, yb = cur.b && wb && p.x ? yAt(xs, wb.y, cur.b.x) : NaN;
  const oneUnit = !!wa && !!wb && wa.unit === wb.unit;
  const ws = sel ? ys(sel.plot, sel.wave) : null;
  const meas = ws && p.x ? waveMeasures(xs, ws.y) : null;
  const signals = p.vectors.filter((v) => !filter || v.name.toLowerCase().includes(filter.toLowerCase()));
  const row = (label: string, value: string, unitClass = '') => <tr key={label}><td>{label}</td><td class={`num ${unitClass}`}>{value}</td></tr>;
  return (
    <div class="panel-body simdata">
      <section aria-label="Source Data">
        <h4>Source Data <span class="muted small">{p.title}</span></h4>
        <input type="search" placeholder="Filter signals" value={filter} aria-label="Filter signals" onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <ul class="sd-signals" role="listbox" aria-label="Signals">
          {signals.map((v) => <li key={v.name} role="option" title="Double-click: on the selected plot" onDblClick={() => add(v.name)}>{v.name}<span class="muted small">{v.unit}</span></li>)}
        </ul>
      </section>
      <section aria-label="Measurement Cursors">
        <h4>Measurement Cursors</h4>
        {!cur.a && !cur.b ? <p class="muted small">Wave › Cursor A and Cursor B put the cursors on the selected wave; drag them along it.</p> : (
          <table class="sd-table">
            <tbody>
              {row('Wave Name', on?.expr ?? '')}
              {cur.a && wa && row('A', `${eng(cur.a.x, xu)}  ${eng(ya, wa.unit)}`)}
              {cur.b && wb && row('B', `${eng(cur.b.x, xu)}  ${eng(yb, wb.unit)}`)}
              {cur.a && cur.b && stats && row('B − A', `${eng(stats.dx, xu)}${oneUnit ? `  ${eng(yb - ya, wa!.unit)}` : ''}`)}
              {stats && cur.a && cur.b && <>
                {row('Minimum A..B', eng(stats.min, on!.unit))}
                {row('Maximum A..B', eng(stats.max, on!.unit))}
                {row('Average A..B', eng(stats.avg, on!.unit))}
                {row('RMS A..B', eng(stats.rms, on!.unit))}
                {row('Frequency A..B', eng(stats.freq, xu === 's' ? 'Hz' : ''))}
              </>}
            </tbody>
          </table>
        )}
      </section>
      <section aria-label="Waveform Measurements">
        <h4>Waveform Measurements</h4>
        {!meas || !ws ? <p class="muted small">Click a wave's name to measure it.</p> : (
          <table class="sd-table">
            <tbody>
              {row('Wave Name', ws.expr)}
              {row('Rise Time', eng(meas.rise, xu))}
              {row('Fall Time', eng(meas.fall, xu))}
              {row('Minimum', eng(meas.min, ws.unit))}
              {row('Maximum', eng(meas.max, ws.unit))}
              {row('Base', eng(meas.base, ws.unit))}
              {row('Top', eng(meas.top, ws.unit))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
