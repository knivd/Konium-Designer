/**
 * Tools › Thermal Analysis, behind its panel: the set-up kept for each board, the analysis run
 * without freezing the window, its picture laid over the board. With the copper's own heat
 * ticked, the supply set up in Power Analysis is worked with it, turn about: its loss heats the
 * board, the board's temperature raises the copper's resistance, until the two agree.
 */
import { signal } from '@preact/signals';
import type { Vec2 } from '../core/geom';
import type { PcbEditor } from '../editors/pcb/PcbEditor';
import type { LayerId } from '../model/layers';
import type { PcbDocument } from '../model/pcb';
import { buildThermal, steadySteps, temperatureAt, warmUpSteps, type ThermalResult, type ThermalSetup, type WarmUp } from '../analysis/thermal';
import { DEFAULT_THERMAL_LIMITS, span, thermalPixels, type ThermalLimits } from '../analysis/thermalMap';

export { span };
import { startRail, type RailResult, type RailSetup } from '../analysis/rail';
import { formRail, powerRun, readForm as readPowerForm } from './powerRun';
import { shownBy, takeOff } from './analysisShow';
import { notify, tick } from './state';
import { breathe } from '../core/breathe';

/** The panel's fields as typed, kept for each board by its name (parts by designator). */
export interface ThermalForm {
  ambient: string; air: 'flat' | 'upright' | 'given'; hTop: string; hBottom: string;
  /** Each part's dissipation (W) and junction-to-board resistance (K/W) as typed, by designator. */
  powers: Record<string, string>; thetas: Record<string, string>;
  /** The copper's own heat from the supply set up in Power Analysis, its resistance at the temperature found. */
  copper: boolean;
  board: string; junction: string; kIn: string; kZ: string; detail: 'draft' | 'normal' | 'fine';
}
export const THERMAL_DETAIL: Record<ThermalForm['detail'], { cells: number; label: string }> = {
  draft: { cells: 10_000, label: 'Draft' }, normal: { cells: 40_000, label: 'Normal' }, fine: { cells: 160_000, label: 'Fine' },
};

const key = (name: string) => `konium.thermal:${name}`;
const num = (s: string | undefined, fallback: number) => { const v = parseFloat((s ?? '').replace(',', '.')); return Number.isFinite(v) ? v : fallback; };

export const defaultThermalForm = (): ThermalForm => ({ ambient: '25', air: 'flat', hTop: '10', hBottom: '10', powers: {}, thetas: {}, copper: false,
  board: String(DEFAULT_THERMAL_LIMITS.board), junction: String(DEFAULT_THERMAL_LIMITS.junction), kIn: '0.8', kZ: '0.3', detail: 'normal' });

export function readThermalForm(name: string): ThermalForm {
  const base = defaultThermalForm();
  try {
    const raw = globalThis.localStorage?.getItem(key(name));
    if (raw) { const o = JSON.parse(raw) as Partial<ThermalForm>; if (o && typeof o === 'object') return { ...base, ...o, powers: { ...(o.powers ?? {}) }, thetas: { ...(o.thetas ?? {}) } }; }
  } catch { /* nothing kept, or not to be read */ }
  return base;
}
export function saveThermalForm(name: string, f: ThermalForm): void {
  try { globalThis.localStorage?.setItem(key(name), JSON.stringify(f)); } catch { /* no room: it is only a convenience */ }
}

export const thermalLimits = (f: ThermalForm): ThermalLimits => ({ board: num(f.board, DEFAULT_THERMAL_LIMITS.board), junction: num(f.junction, DEFAULT_THERMAL_LIMITS.junction) });

/** The form as the analysis's set-up, or what is missing from it. */
export function formThermal(doc: PcbDocument, f: ThermalForm): ThermalSetup | string {
  const sources: ThermalSetup['sources'] = [];
  doc.components.forEach((c, component) => {
    const power = num(f.powers[c.designator], 0);
    if (power > 0) { const theta = num(f.thetas[c.designator], 0); sources.push({ component, power, ...(theta > 0 ? { theta } : {}) }); }
  });
  if (!sources.length && !f.copper) return 'Give the dissipation of one part at least, or tick the copper\'s own heat.';
  let air: ThermalSetup['air'] = f.air === 'given' ? { top: num(f.hTop, NaN), bottom: num(f.hBottom, NaN) } : f.air;
  if (typeof air === 'object' && !(air.top > 0 && air.bottom >= 0)) return 'Give the coefficient of each face: the top\'s above 0.';
  if (typeof air === 'object') air = { top: air.top, bottom: Math.max(air.bottom, 1e-6) };
  const kIn = num(f.kIn, 0.8), kZ = num(f.kZ, 0.3);
  if (!(kIn > 0 && kZ > 0)) return 'Give the laminate\'s conductivity along the board and through it.';
  return { ambient: num(f.ambient, 25), air, sources, kInPlane: kIn, kThrough: kZ, cells: THERMAL_DETAIL[f.detail]?.cells ?? THERMAL_DETAIL.normal.cells };
}

export interface ThermalRun { ed: PcbEditor; result: ThermalResult; rail: RailResult | null; limits: ThermalLimits; revision: number; ms: number; /** Times the supply and the board were worked turn about. */ turns: number; /** How it warms up, once asked for. */ warm?: WarmUp }
export const thermalRun = signal<ThermalRun | null>(null);
export const thermalBusy = signal<string | null>(null);
export const thermalShow = signal<{ on: boolean; scale: 'own' | 'limits' }>({ on: true, scale: 'own' });

const pause = breathe;

/** The run that belongs to a board as it now stands (null: none, or the board has changed since). */
export function currentThermal(ed: PcbEditor | null): ThermalRun | null {
  const r = thermalRun.value;
  return r && ed && r.ed === ed && r.revision === ed.undo.revision ? r : null;
}

/** The two ends of the colour scale, °C. */
export function thermalScale(run: Pick<ThermalRun, 'result' | 'limits'>, scale: 'own' | 'limits'): [number, number] {
  const lo = run.result.setup.ambient;
  return [lo, scale === 'limits' ? Math.max(run.limits.board, lo + 1) : Math.max(run.result.max, lo + 0.1)];
}

export function thermalProbe(r: ThermalResult, at: Vec2, layer: LayerId): string[] {
  const t = temperatureAt(r, r.model.grid.layers.indexOf(layer), at.x, at.y);
  return Number.isNaN(t) ? [] : [`${t.toFixed(1)} °C, ${(t - r.setup.ambient).toFixed(1)} above the air`];
}

/** Lays the run's picture over its board (or takes it off). */
export function showThermal(): void {
  const run = thermalRun.value;
  if (!run) return;
  const ed = run.ed;
  if (!thermalShow.value.on || run.revision !== ed.undo.revision) { takeOff(ed, 'thermal'); return; }
  const [lo, hi] = thermalScale(run, thermalShow.value.scale), made = new Map<LayerId, { a: Vec2; b: Vec2; src: CanvasImageSource }[]>(), g = run.result.model.grid;
  shownBy.value = { ed, by: 'thermal' };
  ed.setAnalysis({
    alpha: 0.82,
    images: (layer) => {
      if (run.revision !== ed.undo.revision || typeof document === 'undefined') return [];
      let ims = made.get(layer);
      if (!ims) {
        ims = [];
        const px = thermalPixels(run.result, g.layers.indexOf(layer), lo, hi);
        if (px) {
          const canvas = document.createElement('canvas');
          canvas.width = px.width; canvas.height = px.height;
          canvas.getContext('2d')!.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
          ims.push({ a: { x: g.minX, y: g.minY }, b: { x: g.minX + g.w * g.h, y: g.minY + g.hgt * g.h }, src: canvas });
        }
        made.set(layer, ims);
      }
      return ims;
    },
    probe: (at, layer) => (run.revision !== ed.undo.revision ? [] : thermalProbe(run.result, at, layer)),
  });
}

/** A rail worked a few steps at a time. */
async function workRail(ed: PcbEditor, rail: RailSetup, field: Parameters<typeof startRail>[2], say: (s: string) => void): Promise<RailResult | null> {
  const run = startRail(ed.doc, rail, field);
  if (!run) return null;
  for (const job of run.jobs) {
    let last = performance.now();
    while (!job.solver.step(1)) {
      if (performance.now() - last < 80) continue;
      say(`${ed.doc.nets[job.cn.net]?.name ?? ''}, step ${job.solver.iterations}`);
      await pause();
      last = performance.now();
    }
  }
  return run.finish((l) => ed.layerLabel(l));
}

/** Runs the thermal analysis of a board; with `copper`, the supply of its Power Analysis set-up turn about with it. */
export async function runThermal(ed: PcbEditor, name: string, f: ThermalForm): Promise<void> {
  if (thermalBusy.value) return;
  const setup = formThermal(ed.doc, f);
  if (typeof setup === 'string') { notify(setup, 'error'); return; }
  thermalBusy.value = 'Reading the board…';
  await pause();
  const t0 = performance.now();
  try {
    const doc = ed.doc, model = buildThermal(doc, setup);
    if (!model) { notify('The board has no outline and no copper to take a shape from.', 'error'); return; }
    let railSetup: RailSetup | null = null;
    if (f.copper) {
      const r = formRail(doc, readPowerForm(doc, name));
      if (typeof r === 'string') { notify(`The copper's own heat needs a supply set up in Power Analysis. ${r}`, 'error'); return; }
      railSetup = r;
    }
    let rail: RailResult | null = null, result: ThermalResult | null = null, turns = 0, last = NaN;
    for (;;) {
      turns++;
      if (railSetup) {
        const prev = result;
        thermalBusy.value = `The supply's copper, turn ${turns}…`;
        await pause();
        rail = await workRail(ed, railSetup, prev ? (li, x, y) => temperatureAt(prev, li, x, y) : undefined, (s) => { thermalBusy.value = `The supply's copper, turn ${turns}: ${s}…`; });
        if (!rail) { notify('The supply net has no copper on the board.', 'error'); return; }
      }
      const steps = steadySteps(doc, { ...setup, copper: rail ? [rail.supply, ...(rail.ret ? [rail.ret] : [])] : undefined }, model);
      let lastSaid = performance.now();
      for (;;) {
        const s = steps.next();
        if (s.done) { result = s.value; break; }
        if (performance.now() - lastSaid < 80) continue;
        thermalBusy.value = `The board's temperature: ${s.value}…`;
        await pause();
        lastSaid = performance.now();
      }
      if (!result) return;
      // Turn about until the hottest place moves by under a fifth of a degree (four turns at most)
      if (!railSetup || turns >= 4 || Math.abs(result.max - last) < 0.2) break;
      last = result.max;
    }
    if (thermalRun.value) takeOff(thermalRun.value.ed, 'thermal');
    const revision = ed.undo.revision, ms = performance.now() - t0;
    thermalRun.value = { ed, result, rail, limits: thermalLimits(f), revision, ms, turns };
    // The supply's figures with its copper warm are Power Analysis's latest too
    if (rail) powerRun.value = { ed, result: rail, revision, ms };
    showThermal();
  } catch (e) {
    notify(`Thermal Analysis: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    thermalBusy.value = null;
    tick.value++;
  }
}

/** How the analysed board warms up from cold: worked for the run in hand, and kept with it. */
export async function runWarmUp(): Promise<void> {
  const run = thermalRun.value;
  if (!run || thermalBusy.value || run.revision !== run.ed.undo.revision) return;
  thermalBusy.value = 'Warming up…';
  await pause();
  try {
    const steps = warmUpSteps(run.ed.doc, run.result);
    let last = performance.now();
    for (;;) {
      const s = steps.next();
      if (s.done) { if (thermalRun.value === run) thermalRun.value = { ...run, warm: s.value }; break; }
      if (performance.now() - last < 80) continue;
      thermalBusy.value = `Warming up: ${s.value}…`;
      await pause();
      last = performance.now();
    }
  } catch (e) {
    notify(`Thermal Analysis: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    thermalBusy.value = null;
    tick.value++;
  }
}

/** Takes the analysis off its board and forgets it. */
export function clearThermal(): void {
  if (thermalRun.value) takeOff(thermalRun.value.ed, 'thermal');
  thermalRun.value = null;
}
