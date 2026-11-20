/**
 * SimView's formatting dialogs, as AD17's SimView menus have them [est: their layout]:
 * Wave › Wave Options (the wave's colour, line width and style, its data points), Plot › Format
 * Y Axis (the axis's label, a logarithmic scale, a fixed range), Plot › Plot Options (the plot's
 * title and grid), Tools › Document Options (SimView's colours) and Tools › Brightness (the
 * waves lightened or darkened).
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import type { AxisOpts, PlotOpts, SimDataDocument, SimLook, WaveRef } from '../../sim/simData';
import { WAVE_COLOURS, chartWaves, shade, touch } from '../simView';
import { engineering, spiceNumber } from '../../sim/num';

const footer = (ok: () => void) => <><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>;
const WIDTHS: [string, number | undefined][] = [['Smallest', undefined], ['Small', 2], ['Medium', 3], ['Large', 4]];

/** Wave › Wave Options: colour, line width and style, data points. */
export function WaveOptionsDialog({ d, k, plot, wave }: { d: SimDataDocument; k: number; plot: number; wave: number }) {
  const c = d.charts[k]!;
  const w = c.plots[plot]![wave]!;
  const auto = chartWaves(c).find((x) => x.plot === plot && x.wave === wave)?.colour ?? WAVE_COLOURS[0]!;
  const [v, setV] = useState<WaveRef>({ ...w });
  const set = (p: Partial<WaveRef>) => setV({ ...v, ...p });
  const ok = () => {
    const next: WaveRef = { expr: w.expr, ...(v.colour ? { colour: v.colour } : {}), ...(v.axis ? { axis: v.axis } : {}), ...(v.width ? { width: v.width } : {}),
      ...(v.style && v.style !== 'solid' ? { style: v.style } : {}), ...(v.points ? { points: true } : {}) };
    c.plots[plot]![wave] = next;
    closeDialog();
    touch(d);
  };
  return (
    <Dialog title={`Wave Options - ${w.expr}`} width={360} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="prompt sv-options" footer={footer(ok)}>
      <div class="prompt-body">
        <label>Colour
          <span class="svo-colour"><input type="color" aria-label="Colour" value={v.colour ?? auto} onInput={(e) => set({ colour: (e.target as HTMLInputElement).value })} />
            <button class="btn" onClick={() => set({ colour: undefined })} disabled={!v.colour}>Automatic</button></span>
        </label>
        <label>Line Width<select aria-label="Line Width" value={String(v.width ?? '')} onChange={(e) => { const x = Number((e.target as HTMLSelectElement).value); set({ width: x || undefined }); }}>
          {WIDTHS.map(([l, x]) => <option key={l} value={String(x ?? '')}>{l}</option>)}
        </select></label>
        <label>Line Style<select aria-label="Line Style" value={v.style ?? 'solid'} onChange={(e) => set({ style: (e.target as HTMLSelectElement).value as WaveRef['style'] })}>
          <option value="solid">Solid</option><option value="dash">Dashed</option><option value="dot">Dotted</option>
        </select></label>
        <label>Show Data Points<input type="checkbox" aria-label="Show Data Points" checked={!!v.points} onChange={(e) => set({ points: (e.target as HTMLInputElement).checked })} /></label>
      </div>
    </Dialog>
  );
}

const numText = (x: number | undefined) => (x === undefined ? '' : engineering(x));

/** Plot › Format Y Axis: the axis a wave is drawn against — label, logarithmic, range (blank: fitted). */
export function AxisDialog({ d, k, plot, axis }: { d: SimDataDocument; k: number; plot: number; axis: number }) {
  const c = d.charts[k]!;
  const opts = c.plotOpts?.[plot]?.axes?.[axis] ?? {};
  const [label, setLabel] = useState(opts.label ?? '');
  const [log, setLog] = useState(!!opts.log);
  const [min, setMin] = useState(numText(opts.min));
  const [max, setMax] = useState(numText(opts.max));
  const [err, setErr] = useState('');
  const ok = () => {
    const a = min.trim() ? spiceNumber(min) : undefined, b = max.trim() ? spiceNumber(max) : undefined;
    if ((a !== undefined && !Number.isFinite(a)) || (b !== undefined && !Number.isFinite(b))) { setErr('Minimum and Maximum: numbers (2m, 1.5k), or blank to fit the waves'); return; }
    if (a !== undefined && b !== undefined && !(b > a)) { setErr('Maximum must be above Minimum'); return; }
    if (log && a !== undefined && !(a > 0)) { setErr('A logarithmic axis starts above zero'); return; }
    const next: AxisOpts = { ...(label.trim() ? { label: label.trim() } : {}), ...(log ? { log: true } : {}), ...(a !== undefined ? { min: a } : {}), ...(b !== undefined ? { max: b } : {}) };
    setAxis(d, k, plot, axis, next);
    closeDialog();
    touch(d);
  };
  return (
    <Dialog title={`Format Y Axis - Plot ${plot + 1}, axis ${axis + 1}`} width={360} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="prompt sv-options" footer={footer(ok)}>
      <div class="prompt-body">
        <label>Label<input type="text" aria-label="Label" value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} /></label>
        <label>Logarithmic<input type="checkbox" aria-label="Logarithmic" checked={log} onChange={(e) => setLog((e.target as HTMLInputElement).checked)} /></label>
        <label>Minimum<input type="text" aria-label="Minimum" placeholder="Fitted" value={min} onInput={(e) => { setMin((e.target as HTMLInputElement).value); setErr(''); }} /></label>
        <label>Maximum<input type="text" aria-label="Maximum" placeholder="Fitted" value={max} onInput={(e) => { setMax((e.target as HTMLInputElement).value); setErr(''); }} /></label>
        {err && <p class="warn small" role="alert">{err}</p>}
      </div>
    </Dialog>
  );
}

/** A plot's options, made when first set. */
export function plotOptsOf(d: SimDataDocument, k: number, plot: number): PlotOpts {
  const c = d.charts[k]!;
  c.plotOpts ??= [];
  while (c.plotOpts.length < c.plots.length) c.plotOpts.push(null);
  return (c.plotOpts[plot] ??= {});
}
export function setAxis(d: SimDataDocument, k: number, plot: number, axis: number, a: AxisOpts): void {
  const o = plotOptsOf(d, k, plot);
  o.axes ??= [];
  while (o.axes.length <= axis) o.axes.push({});
  o.axes[axis] = a;
}

/** Plot › Plot Options: the plot's title and grid. */
export function PlotOptionsDialog({ d, k, plot }: { d: SimDataDocument; k: number; plot: number }) {
  const o = d.charts[k]!.plotOpts?.[plot] ?? {};
  const [title, setTitle] = useState(o.title ?? '');
  const [grid, setGrid] = useState(o.grid !== false);
  const ok = () => {
    const p = plotOptsOf(d, k, plot);
    if (title.trim()) p.title = title.trim(); else delete p.title;
    if (grid) delete p.grid; else p.grid = false;
    closeDialog();
    touch(d);
  };
  return (
    <Dialog title={`Plot Options - Plot ${plot + 1}`} width={340} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="prompt sv-options" footer={footer(ok)}>
      <div class="prompt-body">
        <label>Plot Title<input type="text" aria-label="Plot Title" value={title} onInput={(e) => setTitle((e.target as HTMLInputElement).value)} /></label>
        <label>Show Grid<input type="checkbox" aria-label="Show Grid" checked={grid} onChange={(e) => setGrid((e.target as HTMLInputElement).checked)} /></label>
      </div>
    </Dialog>
  );
}

const LOOK: [keyof SimLook, string, string][] = [['background', 'Background', '#f0f0f0'], ['area', 'Plot Area', '#ffffff'], ['grid', 'Grid', '#d4d4d4'], ['text', 'Text', '#404040']];

/** Tools › Document Options: SimView's colours (Default: the theme's) and the waves' brightness. */
export function DocumentOptionsDialog({ d, brightnessOnly }: { d: SimDataDocument; brightnessOnly?: boolean }) {
  const [look, setLook] = useState<SimLook>({ ...(d.look ?? {}) });
  const ok = () => {
    const next: SimLook = Object.fromEntries(Object.entries(look).filter(([, v]) => v !== undefined && v !== '' && v !== 0)) as SimLook;
    if (Object.keys(next).length) d.look = next; else delete d.look;
    closeDialog();
    touch(d);
  };
  const b = look.brightness ?? 0;
  return (
    <Dialog title={brightnessOnly ? 'Brightness' : 'Document Options'} width={380} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="prompt sv-options" footer={footer(ok)}>
      <div class="prompt-body">
        {!brightnessOnly && LOOK.map(([key, label, dflt]) => (
          <label key={key}>{label}
            <span class="svo-colour"><input type="color" aria-label={label} value={(look[key] as string | undefined) ?? dflt} onInput={(e) => setLook({ ...look, [key]: (e.target as HTMLInputElement).value })} />
              <button class="btn" onClick={() => setLook({ ...look, [key]: undefined })} disabled={!look[key]}>Default</button></span>
          </label>
        ))}
        <label>Wave Brightness
          <span class="svo-colour"><input type="range" min={-80} max={80} step={5} aria-label="Wave Brightness" value={b} onInput={(e) => setLook({ ...look, brightness: Number((e.target as HTMLInputElement).value) })} />
            <span class="svo-swatches">{WAVE_COLOURS.slice(0, 6).map((h) => <i key={h} style={{ background: shade(h, b) }} />)}</span></span>
        </label>
      </div>
    </Dialog>
  );
}
