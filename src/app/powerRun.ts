/**
 * Tools › Power Analysis, behind its panel: the set-up kept for each board, the analysis run
 * without freezing the window, and its picture laid over the board.
 */
import { signal } from '@preact/signals';
import type { Vec2 } from '../core/geom';
import type { PcbEditor } from '../editors/pcb/PcbEditor';
import type { LayerId } from '../model/layers';
import type { PcbDocument } from '../model/pcb';
import type { PowerResult } from '../analysis/power';
import { areaPixels, probe, ramp, reference, trackValues, type MapKind } from '../analysis/powerMap';
import { DEFAULT_LIMITS, componentsOn, groundName, railNets, startRail, type RailResult, type RailSetup } from '../analysis/rail';
import { notify, tick } from './state';
import { shownBy, takeOff } from './analysisShow';
import { breathe } from '../core/breathe';

/** The panel's fields as typed, kept for each board by its name (nets and components by name, so they outlast edits). */
export interface PowerForm {
  supply: string; ret: string; source: string; voltage: string;
  /** Each load's current as typed, by designator. */
  loads: Record<string, string>;
  temperature: string; plating: string; detail: 'draft' | 'normal' | 'fine';
  drop: string; rise: string; density: string;
}
export const DETAIL: Record<PowerForm['detail'], { cells: number; label: string }> = {
  draft: { cells: 30_000, label: 'Draft' }, normal: { cells: 120_000, label: 'Normal' }, fine: { cells: 400_000, label: 'Fine' },
};

const key = (name: string) => `konium.power:${name}`;
const num = (s: string, fallback: number) => { const v = parseFloat(s.replace(',', '.')); return Number.isFinite(v) ? v : fallback; };

/** A first set-up for a board: its most connected net that is not a ground as the supply, a ground as the return. */
export function defaultForm(doc: PcbDocument): PowerForm {
  const nets = railNets(doc), ground = nets.find((n) => groundName(n.name)), supply = nets.find((n) => !groundName(n.name));
  const comps = supply ? componentsOn(doc, supply.net) : [];
  // A connector or a regulator is the likeliest source: the first J, P or CN, else the first component
  const source = comps.find((c) => /^(J|P|CN|X)\d/i.test(c.designator)) ?? comps[0];
  return { supply: supply?.name ?? '', ret: ground?.name ?? '', source: source?.designator ?? '', voltage: '3.3', loads: {}, temperature: '25', plating: '25', detail: 'normal',
    drop: String(DEFAULT_LIMITS.drop), rise: String(DEFAULT_LIMITS.rise), density: String(DEFAULT_LIMITS.density) };
}
export function readForm(doc: PcbDocument, name: string): PowerForm {
  const base = defaultForm(doc);
  try {
    const raw = globalThis.localStorage?.getItem(key(name));
    if (raw) { const o = JSON.parse(raw) as Partial<PowerForm>; if (o && typeof o === 'object') return { ...base, ...o, loads: { ...(o.loads ?? {}) } }; }
  } catch { /* nothing kept, or not to be read */ }
  return base;
}
export function saveForm(name: string, f: PowerForm): void {
  try { globalThis.localStorage?.setItem(key(name), JSON.stringify(f)); } catch { /* no room: it is only a convenience */ }
}

/** The form as the analysis's set-up, or what is missing from it. */
export function formRail(doc: PcbDocument, f: PowerForm): RailSetup | string {
  const netOf = (name: string) => doc.nets.findIndex((n) => n.name === name);
  const supply = netOf(f.supply);
  if (supply < 0) return 'Pick the supply net.';
  const ret = f.ret ? netOf(f.ret) : -1;
  if (ret === supply) return 'The return net is the supply net: pick another, or none.';
  const comps = componentsOn(doc, supply), source = comps.find((c) => c.designator === f.source);
  if (!source) return 'Pick the component that feeds the net.';
  const voltage = num(f.voltage, NaN);
  if (!Number.isFinite(voltage) || voltage === 0) return 'Give the source\'s voltage.';
  const loads = comps.filter((c) => c.component !== source.component).map((c) => ({ component: c.component, current: num(f.loads[c.designator] ?? '', 0) })).filter((l) => l.current > 0);
  if (!loads.length) return 'Give the current of one load at least.';
  return {
    supply, ret: ret >= 0 ? ret : null, source: source.component, voltage, loads,
    temperature: num(f.temperature, 25), plating: Math.max(1, num(f.plating, 25)), cells: DETAIL[f.detail]?.cells ?? DETAIL.normal.cells,
    limits: { drop: Math.max(0, num(f.drop, DEFAULT_LIMITS.drop)), rise: Math.max(1, num(f.rise, DEFAULT_LIMITS.rise)), density: Math.max(1, num(f.density, DEFAULT_LIMITS.density)) },
  };
}

export interface PowerRun { ed: PcbEditor; result: RailResult; revision: number; ms: number }
export const powerRun = signal<PowerRun | null>(null);
export const powerBusy = signal<string | null>(null);
/** What the board shows of the analysis, and whether its colours run over the result's own range or up to the limits. */
export const powerShow = signal<{ kind: MapKind | 'off'; scale: 'own' | 'limits' }>({ kind: 'drop', scale: 'own' });

const pause = breathe;

/** The run that belongs to a board as it now stands (null: none, or the board has changed since). */
export function currentRun(ed: PcbEditor | null): PowerRun | null {
  const r = powerRun.value;
  return r && ed && r.ed === ed && r.revision === ed.undo.revision ? r : null;
}

/** The top of the colour scale: volts for the drop, A/m² for the density. */
export function scaleMax(r: RailResult, kind: MapKind, scale: 'own' | 'limits'): number {
  if (kind === 'drop') {
    if (scale === 'limits') return (Math.abs(r.rail.voltage) * r.rail.limits.drop) / 100;
    const span = (p: PowerResult | null) => (p && Number.isFinite(p.minV) ? Math.max(Math.abs(p.minV - reference(p)), Math.abs(p.maxV - reference(p))) : 0);
    return Math.max(span(r.supply), span(r.ret), 1e-9);
  }
  return scale === 'limits' ? r.rail.limits.density * 1e6 : Math.max(r.peakDensity, 1);
}

const css = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** One net's copper on a layer as a picture: the areas a pixel to each fine cell, the tracks drawn over them. */
function picture(res: PowerResult, li: number, kind: MapKind, max: number): { a: Vec2; b: Vec2; src: CanvasImageSource } | null {
  if (typeof document === 'undefined') return null;
  const px = areaPixels(res, li, kind, max), { minX, minY, h, w, hgt } = res.cn.grid, tracks = res.cn.tracks;
  if (!px || (!px.any && !tracks.some((t) => t.layer === li))) return null;
  // Small boards drawn larger, so that a thin track is more than a pixel wide
  const up = Math.max(1, Math.min(4, Math.floor(2600 / Math.max(px.width, px.height))));
  const small = document.createElement('canvas');
  small.width = px.width; small.height = px.height;
  small.getContext('2d')!.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
  const canvas = document.createElement('canvas');
  canvas.width = px.width * up; canvas.height = px.height * up;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, canvas.width, canvas.height);
  const sc = (3 / h) * up, X = (x: number) => (x - minX) * sc, Y = (y: number) => canvas.height - (y - minY) * sc;
  ctx.lineCap = 'round';
  tracks.forEach((tp, k) => {
    if (tp.layer !== li) return;
    const v = trackValues(res, k, kind);
    if (!v) ctx.strokeStyle = 'rgb(110,110,110)';
    else if (Math.abs(v[0] - v[1]) > max / 200) { const g = ctx.createLinearGradient(X(tp.a.x), Y(tp.a.y), X(tp.b.x), Y(tp.b.y)); g.addColorStop(0, css(ramp(v[0] / max))); g.addColorStop(1, css(ramp(v[1] / max))); ctx.strokeStyle = g; }
    else ctx.strokeStyle = css(ramp(v[0] / max));
    ctx.lineWidth = Math.max(1, tp.width * sc);
    ctx.beginPath(); ctx.moveTo(X(tp.a.x), Y(tp.a.y)); ctx.lineTo(X(tp.b.x), Y(tp.b.y)); ctx.stroke();
  });
  return { a: { x: minX, y: minY }, b: { x: minX + w * h, y: minY + hgt * h }, src: canvas };
}

/** What the analysis says of a place, as the heads-up display's lines. */
export function probeLines(doc: PcbDocument, r: RailResult, at: Vec2, layer: LayerId): string[] {
  const out: string[] = [];
  for (const res of [r.supply, r.ret]) {
    if (!res) continue;
    const li = res.cn.grid.layers.indexOf(layer), p = li < 0 ? null : probe(res, at, li);
    if (!p) continue;
    const name = doc.nets[res.cn.net]?.name ?? '';
    if (!Number.isFinite(p.voltage)) { out.push(`${name}: not joined to the source`); continue; }
    const d = Math.abs(p.voltage - reference(res)) * 1000;
    out.push(`${name}: ${p.voltage.toFixed(4)} V, ${d.toFixed(2)} mV from the source`);
    out.push(`${(p.density / 1e6).toFixed(1)} A/mm²${p.current !== undefined ? `, ${p.current >= 1 ? `${p.current.toFixed(2)} A` : `${(p.current * 1000).toFixed(0)} mA`} in the track` : ''}`);
  }
  return out;
}

/** Lays the run's picture over its board, as `powerShow` says (or takes it off). */
export function showOnBoard(): void {
  const run = powerRun.value;
  if (!run) return;
  const show = powerShow.value, ed = run.ed;
  if (show.kind === 'off' || run.revision !== ed.undo.revision) { takeOff(ed, 'power'); return; }
  shownBy.value = { ed, by: 'power' };
  const kind = show.kind, max = scaleMax(run.result, kind, show.scale), made = new Map<LayerId, { a: Vec2; b: Vec2; src: CanvasImageSource }[]>();
  ed.setAnalysis({
    images: (layer) => {
      // The board edited since: the picture is of copper that may not be there
      if (run.revision !== ed.undo.revision) return [];
      let ims = made.get(layer);
      if (!ims) {
        ims = [];
        for (const res of [run.result.supply, run.result.ret]) { const li = res ? res.cn.grid.layers.indexOf(layer) : -1; const im = res && li >= 0 ? picture(res, li, kind, max) : null; if (im) ims.push(im); }
        // (two layers' pictures kept: each is as large as the grid is fine)
        if (made.size >= 2) made.delete(made.keys().next().value!);
        made.set(layer, ims);
      }
      return ims;
    },
    probe: (at, layer) => (run.revision !== ed.undo.revision ? [] : probeLines(ed.doc, run.result, at, layer)),
  });
}

/** Runs the analysis of a rail on a board, a few steps at a time so the window stays alive. */
export async function runPower(ed: PcbEditor, rail: RailSetup): Promise<void> {
  if (powerBusy.value) return;
  powerBusy.value = 'Reading the copper…';
  await pause();
  const t0 = performance.now();
  try {
    const run = startRail(ed.doc, rail);
    if (!run) { notify('The supply net has no copper on the board.', 'error'); return; }
    for (const job of run.jobs) {
      const name = ed.doc.nets[job.cn.net]?.name ?? '';
      powerBusy.value = `Solving ${name}: ${job.cn.count.toLocaleString('en')} nodes…`;
      await pause();
      let last = performance.now();
      while (!job.solver.step(1)) {
        if (performance.now() - last < 80) continue;
        powerBusy.value = `Solving ${name}: ${job.cn.count.toLocaleString('en')} nodes, step ${job.solver.iterations}…`;
        await pause();
        last = performance.now();
      }
    }
    if (powerRun.value) takeOff(powerRun.value.ed, 'power');
    powerRun.value = { ed, result: run.finish((l) => ed.layerLabel(l)), revision: ed.undo.revision, ms: performance.now() - t0 };
    showOnBoard();
  } catch (e) {
    notify(`Power Analysis: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    powerBusy.value = null;
    tick.value++;
  }
}

/** Takes the analysis off its board and forgets it. */
export function clearPower(): void {
  if (powerRun.value) takeOff(powerRun.value.ed, 'power');
  powerRun.value = null;
}
