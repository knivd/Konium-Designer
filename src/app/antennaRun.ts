/** Tools › Antenna Analysis, behind its panel: the set-up kept for each board, the run in slices so that the window stays alive, and the current laid over the board. */
import { signal } from '@preact/signals';
import type { PcbEditor } from '../editors/pcb/PcbEditor';
import type { Vec2 } from '../core/geom';
import type { LayerId } from '../model/layers';
import { NO_NET, copperNet, netName, type PcbDocument } from '../model/pcb';
import { METRE } from '../analysis/copperNet';
import { startAntenna, type AntennaJob, type AntennaResult, type AntennaSetup } from '../analysis/antenna';
import { gpuAdapter, startGpu, type GpuRun } from '../analysis/fdtdGpu';
import { Fdtd } from '../analysis/fdtd';
import { pulse } from '../analysis/farfield';
import { groundName } from '../analysis/rail';
import { ramp } from '../analysis/powerMap';
import { shownBy, takeOff } from './analysisShow';
import { notify, tick } from './state';
import { breathe } from '../core/breathe';

/** The panel's fields as typed, kept for each board by its name. */
export interface AntennaForm {
  /** The feed pad: its part's designator ('' for a free pad) and its name. */
  part: string; pad: string;
  ground: string;
  /** MHz, and the band looked at as a percentage of it. */
  f0: string; span: string;
  r0: string; tanD: string;
  detail: 'coarse' | 'normal' | 'fine';
  /** Take the steps on the graphics card where there is one. */
  gpu: boolean;
}

export const DETAIL: Record<AntennaForm['detail'], { cell: number; cells: number; label: string }> = {
  coarse: { cell: 0.8e-3, cells: 250_000, label: 'Coarse (0.8 mm)' },
  normal: { cell: 0.5e-3, cells: 600_000, label: 'Normal (0.5 mm)' },
  fine: { cell: 0.3e-3, cells: 1_400_000, label: 'Fine (0.3 mm)' },
};

const key = (name: string) => `konium.antenna:${name}`;
const num = (s: string | undefined, fallback: number) => { const v = parseFloat((s ?? '').replace(',', '.')); return Number.isFinite(v) ? v : fallback; };

/** The pads a feed can be: every pad with copper, by its part and name. */
export function feedPads(doc: PcbDocument): { prim: number; part: string; pad: string; net: string }[] {
  const out: { prim: number; part: string; pad: string; net: string }[] = [];
  doc.prims.forEach((p, i) => {
    if (p.kind !== 'pad') return;
    const net = copperNet(doc, p);
    out.push({ prim: i, part: p.component !== NO_NET ? (doc.components[p.component]?.designator ?? '') : '', pad: p.name, net: net === NO_NET ? 'No Net' : netName(doc, net) });
  });
  return out.sort((a, b) => a.part.localeCompare(b.part, undefined, { numeric: true }) || a.pad.localeCompare(b.pad, undefined, { numeric: true }));
}

export function readAntennaForm(doc: PcbDocument, name: string): AntennaForm {
  const ground = doc.nets.find((n) => groundName(n.name))?.name ?? '';
  // A first guess at the feed: a pad on a net named for an antenna
  const guess = feedPads(doc).find((p) => /ant|rf/i.test(p.net));
  const base: AntennaForm = { part: guess?.part ?? '', pad: guess?.pad ?? '', ground, f0: '2450', span: '60', r0: '50', tanD: '0.02', detail: 'coarse', gpu: true };
  try {
    const raw = globalThis.localStorage?.getItem(key(name));
    if (raw) { const o = JSON.parse(raw) as Partial<AntennaForm>; if (o && typeof o === 'object') return { ...base, ...o }; }
  } catch { /* nothing kept, or not to be read */ }
  return base;
}
export function saveAntennaForm(name: string, f: AntennaForm): void {
  try { globalThis.localStorage?.setItem(key(name), JSON.stringify(f)); } catch { /* no room: it is only a convenience */ }
}

/** The form as a set-up, or what is missing. */
export function formAntenna(doc: PcbDocument, f: AntennaForm): AntennaSetup | string {
  const feed = feedPads(doc).find((p) => p.part === f.part && p.pad === f.pad);
  if (!feed || !f.pad) return 'Pick the pad the antenna is fed at.';
  const ground = doc.nets.findIndex((n) => n.name === f.ground);
  if (ground < 0) return 'Pick the ground net.';
  const f0 = num(f.f0, NaN) * 1e6;
  if (!(f0 >= 50e6 && f0 <= 30e9)) return 'Give the frequency, 50 MHz to 30 GHz.';
  const span = Math.min(120, Math.max(10, num(f.span, 60))) / 100, d = DETAIL[f.detail] ?? DETAIL.normal;
  // The cells follow the wavelength: an antenna for a third of the frequency is three times the size
  const scale = Math.min(4, Math.max(1, 2.45e9 / f0));
  return { feed: feed.prim, ground, f0, span, r0: Math.max(1, num(f.r0, 50)), tanD: Math.max(0, num(f.tanD, 0.02)), cell: d.cell * Math.sqrt(scale), cells: d.cells };
}

/** `on`: what took the steps (the processor, or the graphics card by its name). */
export interface AntennaRun { ed: PcbEditor; result: AntennaResult; revision: number; ms: number; on: string }
/** Whether the browser has a graphics card to run on: null until asked. */
export const gpuThere = signal<boolean | null>(null);
/** `gpu=software` in the address lets a card drawn in software count (it is slower than the processor: for testing). */
const evenSoftware = (): boolean => typeof location !== 'undefined' && /[?&]gpu=software\b/.test(location.search);
export function askGpu(): void { if (gpuThere.value === null) void gpuAdapter(evenSoftware()).then((a) => { gpuThere.value = !!a; }); }

/**
 * The graphics card's steps against the processor's, on a dipole in open space: the same pulse into both, and how far the
 * port's voltage and a field beside the wire differ at the worst, as shares of their largest. Null with no card.
 */
export async function gpuSelfCheck(steps = 120): Promise<{ adapter: string; steps: number; port: number; field: number } | null> {
  const d = 7e-3, pad = 14, wire = 11, nxy = 1 + 2 * pad, nz = wire + 2 * pad, c = pad;
  const line = (n: number) => Float64Array.from({ length: n + 1 }, (_, i) => i * d);
  const make = () => new Fdtd({
    x: line(nxy), y: line(nxy), z: line(nz), pml: 6,
    pecZ: Array.from({ length: wire }, (_, m) => m).filter((m) => m !== 5).map((m) => c + (nxy + 1) * (c + (nxy + 1) * (pad + m))),
    ports: [{ axis: 2, i: c, j: c, k: pad + 5, n: 1, r: 50 }],
  });
  const a = make(), b = make(), src = pulse(2e9, 2e9), watch = Uint32Array.from([b.at(c + 3, c + 2, pad + 4), b.at(c - 4, c + 1, pad + 8), b.at(3, c, pad)]);
  const gpu = await startGpu(b, watch, true);
  if (!gpu) return null;
  try {
    let port = 0, top = 0, field = 0, ftop = 0;
    for (let n = 0; n < steps; n += 8) {
      const vs = Float32Array.from({ length: 8 }, (_, q) => src.at((n + q + 0.5) * a.dt)), got = await gpu.advance(vs);
      for (let q = 0; q < 8; q++) { a.advance([vs[q]!]); const v = a.portV(0); port = Math.max(port, Math.abs(v - got[q]!)); top = Math.max(top, Math.abs(v)); }
      // The watched nodes' fields, read back into b's arrays, against a's
      for (const id of watch) for (const [x, y] of [[a.ez, b.ez], [a.hx, b.hx], [a.hy, b.hy], [a.ex, b.ex]] as const) { field = Math.max(field, Math.abs(x[id]! - y[id]!) / (x === a.ez || x === a.ex ? 1 : 1 / 377)); ftop = Math.max(ftop, Math.abs(x[id]!) / (x === a.ez || x === a.ex ? 1 : 1 / 377)); }
    }
    return { adapter: gpu.adapter, steps, port: port / (top || 1), field: field / (ftop || 1) };
  } finally { gpu.destroy(); }
}
export const antennaRun = signal<AntennaRun | null>(null);
/** While it runs: how far it is and how much the port has rung down. */
export const antennaBusy = signal<{ step: number; limit: number; fall: number; note: string } | null>(null);
export const antennaShow = signal<{ on: boolean; moving: boolean }>({ on: true, moving: false });
let stop = false;
export function stopAntenna(): void { stop = true; }

export const currentAntenna = (ed: PcbEditor): AntennaRun | null => { const r = antennaRun.value; return r && r.ed === ed && r.revision === ed.undo.revision ? r : null; };

export async function runAntenna(ed: PcbEditor, f: AntennaForm): Promise<void> {
  if (antennaBusy.value) return;
  const setup = formAntenna(ed.doc, f);
  if (typeof setup === 'string') { notify(setup, 'error'); return; }
  stop = false;
  antennaBusy.value = { step: 0, limit: 1, fall: 1, note: 'Building the model…' };
  const pause = breathe;
  await pause();
  const t0 = performance.now();
  let gpu: GpuRun | null = null;
  try {
    const job: AntennaJob | string = startAntenna(ed.doc, setup);
    if (typeof job === 'string') { notify(`Antenna Analysis: ${job}`, 'error'); return; }
    if (f.gpu) {
      // The card, where there is one with room for the model; else the processor, as before
      try { gpu = await startGpu(job.sim, job.watched(), evenSoftware()); } catch { gpu = null; }
    }
    for (;;) {
      const done = gpu ? await job.advanceOn(gpu, 100) : job.advance(60);
      antennaBusy.value = { step: job.step, limit: job.limit, fall: job.fall, note: `${job.model.count.toLocaleString('en-GB')} cells` };
      if (done || stop) break;
      await pause();
    }
    if (stop && job.step < 50) return;
    antennaBusy.value = { step: job.step, limit: job.limit, fall: job.fall, note: 'Working out the far field…' };
    await pause();
    antennaRun.value = { ed, result: job.finish(), revision: ed.undo.revision, ms: performance.now() - t0, on: gpu ? `the graphics card (${gpu.adapter})` : 'the processor' };
    showAntenna();
  } catch (e) {
    notify(`Antenna Analysis: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    gpu?.destroy();
    antennaBusy.value = null;
    tick.value++;
  }
}

/** The current's size at a place on a layer: A/m for 1 W accepted, and how far under the largest (dB). */
export function currentAt(r: AntennaResult, at: Vec2, layer: LayerId): { a: number; db: number } | null {
  const sheet = r.current.find((c) => c.layer === layer), m = r.model;
  if (!sheet) return null;
  const u = (at.x - m.origin.x) * METRE, v = (at.y - m.origin.y) * METRE;
  if (u < m.x[0]! || u > m.x.at(-1)! || v < m.y[0]! || v > m.y.at(-1)!) return null;
  const find = (a: Float64Array, w: number) => { let lo = 0, hi = a.length - 1; while (hi - lo > 1) { const q = (lo + hi) >> 1; if (a[q]! <= w) lo = q; else hi = q; } return w - a[lo]! <= a[hi]! - w ? lo : hi; };
  const a = sheet.a[find(m.x, u) + m.x.length * find(m.y, v)]!, top = Math.max(...r.current.map((c) => c.max));
  return { a, db: a > 0 && top > 0 ? 20 * Math.log10(a / top) : -Infinity };
}

/** The picture of a layer's current, where the layer has copper: the largest red, 40 dB under it (or less) blue. */
export function currentPixels(r: AntennaResult, layer: LayerId, range = 40, phase?: number): { width: number; height: number; data: Uint8ClampedArray; a: Vec2; b: Vec2 } | null {
  const sheet = r.current.find((c) => c.layer === layer), m = r.model;
  if (!sheet) return null;
  const top = Math.max(...r.current.map((c) => c.max));
  if (!(top > 0)) return null;
  // Over the board, a pixel to the model's fine cell (fewer when the board is large)
  const x0 = 0, y0 = 0, W = m.board.w, H = m.board.h;
  const size = Math.max(m.cell, Math.sqrt((W * H) / 600_000));
  const width = Math.max(1, Math.ceil(W / size)), height = Math.max(1, Math.ceil(H / size));
  const data = new Uint8ClampedArray(width * height * 4);
  // The nearest plane to each column and row of pixels
  const index = (a: Float64Array, from: number, n: number) => { const o = new Int32Array(n); let q = 0; for (let p = 0; p < n; p++) { const w = from + (p + 0.5) * size; while (q + 1 < a.length && Math.abs(a[q + 1]! - w) <= Math.abs(a[q]! - w)) q++; o[p] = q; } return o; };
  const ix = index(m.x, x0, width), iy = index(m.y, y0, height), sx = m.x.length;
  // At a moment of the cycle (`phase`, radians) the current is what its two parts add up to then; without one, its size
  const co = phase === undefined ? 0 : Math.cos(phase), si = phase === undefined ? 0 : Math.sin(phase), k = sheet.k;
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    const q = ix[px]! + sx * iy[py]!;
    if (!(sheet.a[q]! > 0)) continue;
    const a = phase === undefined ? sheet.a[q]! : Math.hypot(k[4 * q]! * co - k[4 * q + 1]! * si, k[4 * q + 2]! * co - k[4 * q + 3]! * si);
    const db = Math.max(-range, a > 0 ? 20 * Math.log10(a / top) : -range);
    const [red, g, b] = ramp(1 + db / range), at = ((height - 1 - py) * width + px) * 4;
    data[at] = red; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
  }
  const toBoard = (u: number, v: number) => ({ x: m.origin.x + u / METRE, y: m.origin.y + v / METRE });
  return { width, height, data, a: toBoard(x0, y0), b: toBoard(x0 + width * size, y0 + height * size) };
}

/** How many moments of the cycle the moving picture has, and how long each is shown (ms). */
const FRAMES = 16, FRAME_MS = 90;
let timer: ReturnType<typeof setInterval> | undefined;

/** Lays the run's current over its board (or takes it off): its size, or with `moving` the current as it goes through its cycle. */
export function showAntenna(): void {
  const run = antennaRun.value;
  if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  if (!run) return;
  const ed = run.ed;
  if (!antennaShow.value.on || run.revision !== ed.undo.revision) { takeOff(ed, 'antenna'); return; }
  const made = new Map<string, { a: Vec2; b: Vec2; src: CanvasImageSource }[]>(), moving = antennaShow.value.moving;
  let frame = 0;
  shownBy.value = { ed, by: 'antenna' };
  const analysis: NonNullable<PcbEditor['analysis']> = {
    alpha: 0.85,
    images: (layer) => {
      if (run.revision !== ed.undo.revision || typeof document === 'undefined') return [];
      const key = `${layer}:${moving ? frame : 'size'}`;
      let ims = made.get(key);
      if (!ims) {
        ims = [];
        const px = currentPixels(run.result, layer, 40, moving ? (2 * Math.PI * frame) / FRAMES : undefined);
        if (px) {
          const canvas = document.createElement('canvas');
          canvas.width = px.width; canvas.height = px.height;
          canvas.getContext('2d')!.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
          ims.push({ a: px.a, b: px.b, src: canvas });
        }
        made.set(key, ims);
      }
      return ims;
    },
    probe: (at, layer) => {
      if (run.revision !== ed.undo.revision) return [];
      const c = currentAt(run.result, at, layer);
      return c && c.a > 0 ? [`${c.a >= 10 ? c.a.toFixed(0) : c.a.toFixed(1)} A/m for 1 W`, `${c.db.toFixed(1)} dB of the largest`] : [];
    },
  };
  ed.setAnalysis(analysis);
  if (!moving) return;
  // The next moment of the cycle, for as long as this picture is the one on the board
  timer = setInterval(() => {
    if (antennaRun.value !== run || shownBy.value?.ed !== ed || shownBy.value.by !== 'antenna' || run.revision !== ed.undo.revision) { clearInterval(timer); timer = undefined; return; }
    frame = (frame + 1) % FRAMES;
    ed.setAnalysis(analysis);
  }, FRAME_MS);
}

export function clearAntenna(): void {
  const run = antennaRun.value;
  if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  if (run) takeOff(run.ed, 'antenna');
  antennaRun.value = null;
}
