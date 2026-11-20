/**
 * SimView: a simulation's results, a chart per tab along the bottom (Operating Point, Transient
 * Analysis, AC Analysis, DC Sweep, Transfer Function, Fourier Analysis, and the charts made from
 * them: FFTs, duplicates, imports), as AD17's SimView lays them out. A chart's plots are stacked,
 * the X axis shared; each plot draws its waves (signals, or expressions of them) over its own Y
 * axis. The waves are listed beside the chart in their colours, with their values under the
 * cursor: a click selects one (Wave › Cursor A / B, the cursor moves, Edit Wave, Remove Wave act
 * on it), × takes it off, Add Wave puts another on the selected plot. Cursors A and B are dragged
 * along their wave; the Sim Data panel measures between them. The wheel zooms about the cursor,
 * dragging pans, a double-click fits (View › Fit Document); an AC chart shows magnitude,
 * magnitude in dB or phase over a logarithmic frequency axis. A plot can have more Y axes (Plot ›
 * Add Y Axis: the selected wave gets one of its own, on the right), each formatted (label, log
 * scale, fixed range); Plot Options give a title and the grid, Wave Options the line, Document
 * Options the colours. Swept runs (temperature, parameter, Monte Carlo) show which run a wave is.
 * Operating point, transfer function, pole-zero and Fourier results are tables.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { activeId, docKeys, tick, type OpenDoc } from './state';
import type { Plot } from '../sim/engine';
import type { ChartView, SimDataDocument } from '../sim/simData';
import {
  AC_SHOW, axesOfPlot, axisOfWave, chartOf, chartWaves, eng, shade, fullRange, isLogX, logTicks, niceTicks, plotBoxes, rangeOf, setRange, shownValues, simViewTick, touch, valueAt, viewOf, waveData, waveUnit, zoomAt,
  type AcShow, type Cursor,
} from './simView';
import { showDialog } from './dialogs';
import { AddWaveDialog } from './dialogs/AddWave';

const M = { l: 70, r: 34, t: 10, b: 30 };
const GAP = 10;
/** Room for each Y axis beyond a plot's first (drawn on the right). */
const AXIS_W = 58;
/** A plot no lower than this: more plots than fit scroll (Scroll View › Vertical …). */
const MIN_PLOT = 64;
/** Each plot's height for n plots in a box this high (MIN_PLOT at least), and the plots' whole height. */
function plotHeights(n: number, boxH: number): { sh: number; total: number } {
  const sh = Math.max(MIN_PLOT, (boxH - M.t - M.b - GAP * (n - 1)) / n);
  return { sh, total: M.t + M.b + n * sh + GAP * (n - 1) };
}

function OpTable({ p }: { p: Plot }) {
  return (
    <div class="sv-table-wrap">
      <table class="sv-table" aria-label={p.title}>
        <thead><tr><th>Signal</th><th class="num">Value</th></tr></thead>
        <tbody>{p.vectors.map((v) => <tr key={v.name}><td>{v.name}</td><td class="num">{eng(v.re[0] ?? NaN, v.unit)}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function TextTable({ p }: { p: Plot }) {
  const t = p.table!;
  return (
    <div class="sv-table-wrap">
      <table class="sv-table" aria-label={p.title}>
        <thead><tr>{t.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>{t.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} class={j > 0 ? 'num' : ''}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** A wave as an SVG path, at most two points per pixel column (each column's lowest and highest). */
function wavePath(xs: ArrayLike<number>, ys: ArrayLike<number>, px: (x: number) => number, py: (y: number) => number, x0: number, x1: number, from = 0, to = xs.length): string {
  let d = '';
  let col = NaN, lo = 0, hi = 0, first = 0, last = 0, started = false;
  const flush = () => {
    if (Number.isNaN(col)) return;
    const a = py(first), b = py(lo), c = py(hi), e = py(last);
    d += `${started ? 'L' : 'M'}${col.toFixed(1)},${a.toFixed(1)}`;
    started = true;
    if (b !== a) d += `L${col.toFixed(1)},${b.toFixed(1)}`;
    if (c !== b) d += `L${col.toFixed(1)},${c.toFixed(1)}`;
    if (e !== c) d += `L${col.toFixed(1)},${e.toFixed(1)}`;
  };
  // The points in view, and one either side so the line runs to the edges
  let i0 = from, i1 = to - 1;
  while (i0 < i1 && xs[i0 + 1]! < x0) i0++;
  while (i1 > i0 && xs[i1 - 1]! > x1) i1--;
  for (let i = i0; i <= i1; i++) {
    const y = ys[i]!;
    if (!Number.isFinite(y)) continue;
    const c = Math.round(px(xs[i]!));
    if (c !== col) { flush(); col = c; lo = hi = first = last = y; } else { if (y < lo) lo = y; if (y > hi) hi = y; last = y; }
  }
  flush();
  return d;
}

/** One Y axis of a plot: its range (fitted to its waves in view, or as Format Y Axis fixes it), ticks and scale. */
export interface AxisView { y0: number; y1: number; log: boolean; ticks: number[]; minor: number[]; py: (y: number) => number; unit: string; colour: string; label?: string }
interface Strip { top: number; h: number; axes: AxisView[]; grid: boolean; title?: string }

/** Each plot's place and its axes' ranges. */
function layout(top: number, height: number, c: ChartView, waves: { plot: number; wave: number; colour: string }[], values: ArrayLike<number>[], units: string[], xs: ArrayLike<number>, x0: number, x1: number): Strip[] {
  const n = Math.max(1, c.plots.length);
  const SH = Math.max(MIN_PLOT, (height - GAP * (n - 1)) / n);
  return Array.from({ length: n }, (_, i) => {
    const t = top + i * (SH + GAP);
    const opts = c.plotOpts?.[i] ?? {};
    const nAxes = axesOfPlot(c, i);
    const axes = Array.from({ length: nAxes }, (_, j): AxisView => {
      const ao = opts.axes?.[j] ?? {};
      const mine = waves.map((w, k) => [w, k] as const).filter(([w]) => w.plot === i && axisOfWave(c, i, w.wave) === j);
      const log = !!ao.log;
      let y0 = Infinity, y1 = -Infinity;
      for (const [, k] of mine) {
        const ys = values[k]!;
        for (let q = 0; q < xs.length; q++) { if (xs[q]! < x0 || xs[q]! > x1) continue; const y = ys[q]!; if (Number.isFinite(y) && (!log || y > 0)) { if (y < y0) y0 = y; if (y > y1) y1 = y; } }
      }
      if (!Number.isFinite(y0)) { y0 = log ? 0.1 : -1; y1 = log ? 10 : 1; }
      if (log) {
        if (y1 / y0 < 1.0001) { y0 /= 2; y1 *= 2; }
        y0 /= 1.15; y1 *= 1.15;
      } else {
        // A flat wave (to within rounding): about its level
        if (y1 - y0 < Math.max(1e-12, 1e-9 * Math.max(Math.abs(y0), Math.abs(y1)))) { const cc = (y0 + y1) / 2, m = Math.abs(cc) * 0.1 || 1; y0 = cc - m; y1 = cc + m; }
        const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
      }
      if (ao.min !== undefined && Number.isFinite(ao.min) && (!log || ao.min > 0)) y0 = ao.min;
      if (ao.max !== undefined && Number.isFinite(ao.max) && ao.max > y0) y1 = ao.max;
      if (!(y1 > y0)) y1 = y0 + 1;
      const lt = log ? logTicks(y0, y1) : null;
      const ly0 = Math.log(y0), ly1 = Math.log(y1);
      const py = log ? (y: number) => t + SH - ((Math.log(y) - ly0) / (ly1 - ly0)) * SH : (y: number) => t + SH - ((y - y0) / (y1 - y0)) * SH;
      return {
        y0, y1, log, py, label: ao.label, unit: mine[0] ? units[mine[0][1]]! : '', colour: nAxes > 1 && mine[0] ? mine[0][0].colour : '',
        ticks: lt ? lt.major : niceTicks(y0, y1, Math.max(2, Math.round(SH / 38))), minor: lt ? lt.minor : [],
      };
    });
    return { top: t, h: SH, axes, grid: opts.grid !== false, title: opts.title };
  });
}

const DASH = { solid: undefined, dash: '6 3', dot: '1.5 3' } as const;

/** The wave's points in view as small circles (Wave Options › Show Data Points), when there aren't too many. */
function pointsPath(xs: ArrayLike<number>, ys: ArrayLike<number>, px: (x: number) => number, py: (y: number) => number, x0: number, x1: number): string {
  let d = '', n = 0;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i]! < x0 || xs[i]! > x1 || !Number.isFinite(ys[i]!)) continue;
    if (++n > 1500) return '';
    const x = px(xs[i]!), y = py(ys[i]!);
    d += `M${(x - 2).toFixed(1)},${y.toFixed(1)}a2,2 0 1,0 4,0a2,2 0 1,0 -4,0`;
  }
  return d;
}

function Chart({ d, k }: { d: SimDataDocument; k: number }) {
  void simViewTick.value;
  const { c, p } = chartOf(d, k)!;
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 300 });
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{ x: number; r: [number, number]; cursor?: 'a' | 'b' } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(200, el.clientWidth), h: Math.max(140, el.clientHeight) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const view = viewOf(d);
  const how: AcShow = view.ac.get(k) ?? 'Magnitude';
  const log = isLogX(p);
  const [x0, x1] = rangeOf(d, k);
  const xs = p.x!.values;
  const waves = chartWaves(c);
  const data = waves.map((w) => waveData(p, w.expr));
  const values = data.map((w) => (w instanceof Error ? new Float64Array(0) : shownValues(w, how)));
  const sel = view.selected.get(k) ?? null;
  const cur = view.cursors.get(k) ?? {};
  const units = waves.map((w, j) => waveUnit(p, w.expr, data[j]!, how));
  const extraAxes = Math.max(0, ...c.plots.map((_, i) => axesOfPlot(c, i) - 1));
  const MR = M.r + extraAxes * AXIS_W;
  const W = size.w - M.l - MR;
  const bright = d.look?.brightness ?? 0;
  const lx = (x: number) => (log ? Math.log(x) : x), X0 = lx(x0), X1 = lx(x1);
  const px = (x: number) => M.l + ((lx(x) - X0) / (X1 - X0 || 1)) * W;
  const xAt = (cx: number) => { const t = X0 + ((cx - M.l) / W) * (X1 - X0); return log ? Math.exp(t) : t; };
  const heights = plotHeights(Math.max(1, c.plots.length), size.h);
  const svgH = Math.max(size.h, Math.ceil(heights.total));
  const strips = layout(M.t, svgH - M.t - M.b, c, waves, values, units, xs, x0, x1);
  useLayoutEffect(() => { if (box.current) plotBoxes.set(d, { el: box.current, step: heights.sh + GAP }); });
  const filtered = !!sel && !!view.filtered.get(k);
  const dim = (plot: number, wave: number) => filtered && !(sel!.plot === plot && sel!.wave === wave);
  /** The scale a wave is drawn on. */
  const axisOf = (plot: number, wave: number) => strips[plot]?.axes[axisOfWave(c, plot, wave)] ?? strips[plot]!.axes[0]!;
  const bottom = strips.at(-1)!.top + strips.at(-1)!.h;
  const xt = log ? logTicks(x0, x1) : { major: niceTicks(x0, x1, Math.max(3, Math.round(W / 90))), minor: [] as number[] };
  const xUnit = p.x!.unit;
  // DC sweeps nest: each curve of the outer sweep drawn on its own
  const segs = p.segments?.length ? p.segments.map((s, i) => [s.start, p.segments![i + 1]?.start ?? xs.length] as [number, number]) : [[0, xs.length] as [number, number]];
  const waveOf = (at: { plot: number; wave: number }) => waves.findIndex((w) => w.plot === at.plot && w.wave === at.wave);
  const cursorY = (cu: Cursor) => { const j = waveOf(cu); return j < 0 ? NaN : valueAt(xs, values[j]!, cu.x, log); };
  const runOf = (expr: string) => p.runs?.find((r) => expr.endsWith(r.suffix))?.label;

  const select = (at: { plot: number; wave: number } | null) => { view.selected.set(k, at); simViewTick.value++; };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const dy = e.deltaY || e.deltaX;
    if (!dy) return;
    const r = box.current!.getBoundingClientRect();
    zoomAt(d, k, dy < 0 ? 0.8 : 1.25, xAt(e.clientX - r.left));
  };
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const r = box.current!.getBoundingClientRect(), cx = e.clientX - r.left, cy = e.clientY - r.top + box.current!.scrollTop;
    if (cx > box.current!.clientWidth) return; // the scroll bar
    const near = (['a', 'b'] as const).find((n) => cur[n] && Math.abs(px(cur[n]!.x) - cx) <= 4);
    drag.current = { x: e.clientX, r: [x0, x1], cursor: near };
    // A click in a plot selects it (its first wave, unless one of its waves is selected)
    const plot = strips.findIndex((s) => cy >= s.top && cy <= s.top + s.h);
    if (plot >= 0 && !near && sel?.plot !== plot && c.plots[plot]?.length) select({ plot, wave: 0 });
    if (plot >= 0 && view.filtered.get(k)) { view.filtered.set(k, false); simViewTick.value++; }
  };
  /** A wave picked by its name: selected, the chart's other waves dimmed (Wave › Clear Filter, Esc, undoes it). */
  const pick = (at: { plot: number; wave: number }) => { view.filtered.set(k, true); select(at); };
  const onMove = (e: MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    const cx = e.clientX - r.left;
    setHover(cx >= M.l && cx <= M.l + W ? xAt(cx) : null);
    const g = drag.current;
    if (!g || !(e.buttons & 1)) { drag.current = null; return; }
    if (g.cursor) {
      const at = cur[g.cursor]!;
      const [a, b] = fullRange(p);
      view.cursors.set(k, { ...cur, [g.cursor]: { ...at, x: Math.min(b, Math.max(a, xAt(cx))) } });
      simViewTick.value++;
      return;
    }
    const dx = ((e.clientX - g.x) / W) * (lx(g.r[1]) - lx(g.r[0]));
    setRange(d, k, log ? [g.r[0] / Math.exp(dx), g.r[1] / Math.exp(dx)] : [g.r[0] - dx, g.r[1] - dx]);
  };
  const removeWave = (plot: number, wave: number) => {
    c.plots[plot]!.splice(wave, 1);
    if (!c.plots[plot]!.length && c.plots.length > 1) { c.plots.splice(plot, 1); c.plotOpts?.splice(plot, 1); }
    for (const n of ['a', 'b'] as const) if (cur[n] && (cur[n]!.plot === plot && cur[n]!.wave === wave)) delete cur[n];
    view.cursors.set(k, { ...cur });
    select(null);
    touch(d);
  };
  const addWave = (expr: string) => {
    if (sel && c.plots[sel.plot]) c.plots[sel.plot]!.push({ expr }); else c.plots.push([{ expr }]);
    touch(d);
  };
  const shownNames = new Set(waves.map((w) => w.expr));
  const others = p.vectors.filter((v) => !shownNames.has(v.name));
  return (
    <div class="sv-chart">
      <div class="sv-waves" aria-label="Waves">
        <div class="sv-waves-head">{c.title}</div>
        {p.complex && (
          <select class="sv-acshow" aria-label="Show" value={how} onChange={(e) => { view.ac.set(k, (e.target as HTMLSelectElement).value as AcShow); simViewTick.value++; }}>
            {AC_SHOW.map((a) => <option key={a}>{a}</option>)}
          </select>
        )}
        {c.plots.map((pl, i) => (
          <ul key={i} class="sv-plotwaves" aria-label={`Plot ${i + 1}`}>
            {pl.map((w, j) => {
              const n = waveOf({ plot: i, wave: j }), at = waves[n]!, err = data[n] instanceof Error ? (data[n] as Error).message : '';
              const on = sel?.plot === i && sel.wave === j;
              const unit = units[n]!;
              const marks = (['a', 'b'] as const).filter((m) => cur[m]?.plot === i && cur[m]?.wave === j);
              const run = runOf(w.expr), ax = axisOfWave(c, i, j);
              return (
                <li key={j} class={`${on ? 'on' : ''}${dim(i, j) ? ' dim' : ''}`} style={{ color: shade(at.colour, bright) }} title={err || `${w.expr}${run ? ` — ${run}` : ''}${ax ? ` (Y axis ${ax + 1})` : ''}`}
                  onClick={() => pick({ plot: i, wave: j })} onDblClick={() => showDialog(AddWaveDialog, { d, k, edit: { plot: i, wave: j } })}>
                  <span class="sv-wave-name">{w.expr}{marks.length ? <sup>{marks.join('')}</sup> : null}{err ? ' (?)' : ''}{run ? <span class="sv-wave-run">{run}</span> : null}</span>
                  <span class="sv-wave-val">{hover !== null && !err ? eng(valueAt(xs, values[n]!, hover, log), unit) : ''}</span>
                  <button class="sv-x" title={`Remove ${w.expr}`} aria-label={`Remove ${w.expr}`} onClick={(e) => { e.stopPropagation(); removeWave(i, j); }}>×</button>
                </li>
              );
            })}
          </ul>
        ))}
        {others.length > 0 && (
          <select class="sv-add" aria-label="Add Wave" value="" onChange={(e) => { const n = (e.target as HTMLSelectElement).value; if (n) addWave(n); }}>
            <option value="">Add Wave…</option>
            {others.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        )}
        {hover !== null && <div class="sv-at muted small">{p.x!.name} = {eng(hover, xUnit)}</div>}
      </div>
      <div class="sv-plot" ref={box} onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseLeave={() => { setHover(null); drag.current = null; }}
        onMouseUp={() => { drag.current = null; }} onDblClick={() => setRange(d, k, null)} role="img" aria-label={`${c.title}: ${waves.map((w) => w.expr).join(', ')}`}>
        <svg width={size.w} height={svgH}>
          {strips.map((st, i) => {
            const own = waves.map((w, j) => [w, j] as const).filter(([w]) => w.plot === i);
            const a0 = st.axes[0]!;
            const isSel = sel?.plot === i;
            return (
              <g key={i}>
                <rect class={`sv-bg${isSel ? ' sel' : ''}`} x={M.l} y={st.top} width={W} height={st.h} />
                {st.grid && xt.minor.map((t) => <line key={`m${t}`} class="sv-grid minor" x1={px(t)} x2={px(t)} y1={st.top} y2={st.top + st.h} />)}
                {st.grid && xt.major.map((t) => <line key={`x${t}`} class="sv-grid" x1={px(t)} x2={px(t)} y1={st.top} y2={st.top + st.h} />)}
                {st.grid && a0.minor.map((t) => <line key={`ym${t}`} class="sv-grid minor" x1={M.l} x2={M.l + W} y1={a0.py(t)} y2={a0.py(t)} />)}
                {st.grid && a0.ticks.map((t) => <line key={`y${t}`} class="sv-grid" x1={M.l} x2={M.l + W} y1={a0.py(t)} y2={a0.py(t)} />)}
                <clipPath id={`sv-clip-${k}-${i}`}><rect x={M.l} y={st.top} width={W} height={st.h} /></clipPath>
                <g clip-path={`url(#sv-clip-${k}-${i})`}>
                  {own.map(([w, j]) => {
                    const ax = axisOf(i, w.wave), ref = c.plots[i]![w.wave]!;
                    const colour = shade(w.colour, bright), selW = sel && sel.plot === w.plot && sel.wave === w.wave;
                    const style = { ...(ref.width ? { strokeWidth: `${selW ? ref.width + 1 : ref.width}px` } : {}), ...(ref.style && ref.style !== 'solid' ? { strokeDasharray: DASH[ref.style] } : {}) };
                    return (
                      <g key={j} class={dim(i, w.wave) ? 'sv-dim' : undefined}>
                        {segs.map(([a, b], q) => <path key={`${j}-${q}`} class={`sv-wave${selW ? ' sel' : ''}`} d={wavePath(xs, values[j]!, px, ax.py, x0, x1, a, b)} stroke={colour} style={style} />)}
                        {ref.points && <path class="sv-points" d={pointsPath(xs, values[j]!, px, ax.py, x0, x1)} stroke={colour} />}
                      </g>
                    );
                  })}
                  {hover !== null && <line class="sv-cursor" x1={px(hover)} x2={px(hover)} y1={st.top} y2={st.top + st.h} />}
                  {(['a', 'b'] as const).map((n) => {
                    const cu = cur[n];
                    if (!cu) return null;
                    const y = cu.plot === i ? cursorY(cu) : NaN;
                    const ay = cu.plot === i ? axisOf(i, cu.wave) : a0;
                    return (
                      <g key={n} class="sv-mcursor">
                        <line x1={px(cu.x)} x2={px(cu.x)} y1={st.top} y2={st.top + st.h} />
                        {Number.isFinite(y) && <circle cx={px(cu.x)} cy={ay.py(y)} r={3.5} />}
                        {cu.plot === i && <text x={px(cu.x) + 4} y={st.top + st.h - 6}>{n}</text>}
                      </g>
                    );
                  })}
                </g>
                <rect class="sv-frame" x={M.l} y={st.top} width={W} height={st.h} />
                {own.map(([w], q) => <text key={q} class={`sv-name${dim(i, w.wave) ? ' sv-dim' : ''}`} x={M.l + 6} y={st.top + 13 + q * 13} fill={shade(w.colour, bright)}
                  onMouseDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick({ plot: i, wave: w.wave }); } }}>{w.expr}</text>)}
                {st.title && <text class="sv-ptitle" x={M.l + W - 6} y={st.top + 13} text-anchor="end">{st.title}</text>}
                {a0.ticks.map((t) => <text key={`yl${t}`} class="sv-label" x={M.l - 6} y={a0.py(t) + 4} text-anchor="end" style={a0.colour ? { fill: shade(a0.colour, bright) } : undefined}>{eng(t, a0.unit, 4)}</text>)}
                {a0.label && <text class="sv-label sv-axis-title" transform={`translate(${12} ${st.top + st.h / 2}) rotate(-90)`} text-anchor="middle">{a0.label}</text>}
                {st.axes.slice(1).map((ax, q) => {
                  const xa = M.l + W + 6 + q * AXIS_W;
                  const fill = ax.colour ? { fill: shade(ax.colour, bright) } : undefined;
                  return (
                    <g key={`ax${q}`} class="sv-axis2">
                      <line class="sv-frame" x1={xa} x2={xa} y1={st.top} y2={st.top + st.h} style={ax.colour ? { stroke: shade(ax.colour, bright) } : undefined} />
                      {ax.ticks.map((t) => <g key={t}><line class="sv-frame" x1={xa} x2={xa + 4} y1={ax.py(t)} y2={ax.py(t)} /><text class="sv-label" x={xa + 6} y={ax.py(t) + 4} style={fill}>{eng(t, ax.unit, 3)}</text></g>)}
                      {ax.label && <text class="sv-label sv-axis-title" transform={`translate(${xa + AXIS_W - 8} ${st.top + st.h / 2}) rotate(-90)`} text-anchor="middle" style={fill}>{ax.label}</text>}
                    </g>
                  );
                })}
              </g>
            );
          })}
          {xt.major.map((t) => <text key={`xl${t}`} class="sv-label" x={px(t)} y={bottom + 16} text-anchor="middle">{eng(t, xUnit, 4)}</text>)}
          {!waves.length && <text class="sv-label" x={M.l + W / 2} y={M.t + strips[0]!.h / 2} text-anchor="middle">Add Wave… shows a signal here</text>}
        </svg>
      </div>
    </div>
  );
}

/** Document Options' colours as the variables SimView's styles read. */
const lookStyle = (d: SimDataDocument): Record<string, string> => {
  const l = d.look ?? {};
  return Object.fromEntries(([['--sv-back', l.background], ['--sv-area', l.area], ['--sv-grid', l.grid], ['--sv-text', l.text]] as const).filter(([, v]) => !!v)) as Record<string, string>;
};

export function SimDataView({ od }: { od: OpenDoc }) {
  void tick.value;
  void simViewTick.value;
  const d = od.doc as SimDataDocument;
  const k = Math.min(d.active, Math.max(0, d.charts.length - 1));
  const setActive = (i: number) => { d.active = i; tick.value++; };
  useEffect(() => {
    docKeys.set(od.id, (key) => {
      if (activeId.value !== od.id) return false;
      if (key === 'Home') { setRange(d, d.active, null); return true; }
      return false;
    });
    return () => docKeys.delete(od.id);
  }, [od.id, d]);
  const cp = chartOf(d, k);
  if (!cp) return <div class="simview empty"><p class="muted">No results: the simulation ran no analysis.</p></div>;
  const p = cp.p;
  return (
    <div class="simview" aria-label={`${od.name}: simulation results`} style={lookStyle(d)}>
      <div class="sv-main">
        {p.analysis === 'op' ? <OpTable p={p} /> : p.table ? <TextTable p={p} /> : p.x ? <Chart key={`${od.id}-${k}`} d={d} k={k} /> : <OpTable p={p} />}
      </div>
      <div class="sv-tabs" role="tablist" aria-label="Charts">
        {d.charts.map((x, i) => (
          <button key={i} role="tab" aria-selected={i === k} class={`sv-tab${i === k ? ' on' : ''}`} onClick={() => setActive(i)}>{x.title}</button>
        ))}
      </div>
    </div>
  );
}
