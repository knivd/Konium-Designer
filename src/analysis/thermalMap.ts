/**
 * A thermal analysis as a picture, as what is out of limits, and as a report.
 */

import type { BBox } from '../core/geom';
import type { LayerId } from '../model/layers';
import type { PcbDocument } from '../model/pcb';
import { ramp } from './powerMap';
import type { ThermalResult, WarmUp } from './thermal';

/** A layer's temperatures as pixels (RGBA, the top row first), a pixel to each cell: blue at `lo` to red at `hi`, clear off the board. */
export function thermalPixels(r: ThermalResult, li: number, lo: number, hi: number): { width: number; height: number; data: Uint8ClampedArray } | null {
  const { w: W, hgt: H, layers } = r.model.grid;
  if (li < 0 || li >= layers.length) return null;
  const data = new Uint8ClampedArray(W * H * 4), span = hi > lo ? 1 / (hi - lo) : 0;
  for (let cy = 0; cy < H; cy++) for (let cx = 0; cx < W; cx++) {
    const t = r.t[li * W * H + cy * W + cx]!;
    if (Number.isNaN(t)) continue;
    const [red, g, b] = ramp((t - lo) * span), at = ((H - 1 - cy) * W + cx) * 4;
    data[at] = red; data[at + 1] = g; data[at + 2] = b; data[at + 3] = 255;
  }
  return { width: W, height: H, data };
}

export interface ThermalLimits { /** The hottest the board may be, °C. */ board: number; /** The hottest a junction may be, °C. */ junction: number }
export const DEFAULT_THERMAL_LIMITS: ThermalLimits = { board: 100, junction: 125 };

export interface ThermalIssue { kind: 'board' | 'junction' | 'nowhere'; message: string; box?: BBox; layer?: LayerId; prims?: number[] }

/** What a thermal analysis has to say against the limits. */
export function thermalIssues(doc: PcbDocument, r: ThermalResult, limits: ThermalLimits, layerName: (l: LayerId) => string = (l) => `layer ${l}`): ThermalIssue[] {
  const out: ThermalIssue[] = [], pads = (c: number) => { const o: number[] = []; doc.prims.forEach((p, i) => { if (p.kind === 'pad' && p.component === c) o.push(i); }); return o; };
  if (r.max > limits.board) {
    const layer = r.model.grid.layers[r.maxAt.layer]!, d = Math.max(r.model.grid.h * 6, 800000);
    out.push({ kind: 'board', message: `The board reaches ${r.max.toFixed(1)} °C on ${layerName(layer)}; the limit is ${limits.board} °C`, layer, box: { minX: r.maxAt.at.x - d, minY: r.maxAt.at.y - d, maxX: r.maxAt.at.x + d, maxY: r.maxAt.at.y + d } });
  }
  for (const p of r.parts) if (p.junction !== undefined && p.junction > limits.junction) out.push({ kind: 'junction', message: `${p.designator}: its junction reaches ${p.junction.toFixed(1)} °C (the board under it ${p.board.toFixed(1)} °C); the limit is ${limits.junction} °C`, prims: pads(p.component) });
  for (const s of r.setup.sources) if (s.power > 0 && !r.parts.some((p) => p.component === s.component)) out.push({ kind: 'nowhere', message: `${doc.components[s.component]?.designator ?? 'A part'} is not on the board: its heat is left out` });
  return out;
}

/** A length of time in words: seconds, or minutes and seconds. */
export function span(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'longer than was worked';
  const s = Math.round(seconds);
  return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** The analysis as a text report (with how it warms up, when that was worked). */
export function thermalReport(doc: PcbDocument, r: ThermalResult, title: string, limits: ThermalLimits, layerName: (l: LayerId) => string = (l) => `layer ${l}`, warm?: WarmUp): string {
  const out: string[] = [], pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length)), air = r.setup.air;
  out.push(`Thermal Analysis: ${title}`, '');
  out.push(`Air             ${r.setup.ambient} °C, ${air === 'flat' ? 'still, the board lying flat' : air === 'upright' ? 'still, the board upright' : 'coefficients given'}`);
  out.push(`Top face        ${r.top.h.toFixed(1)} W/m²·K${typeof air === 'object' ? '' : ` (convection ${r.top.convection.toFixed(1)}, radiation ${r.top.radiation.toFixed(1)})`}, ${r.top.loss.toFixed(3)} W leaves, mean ${r.top.mean.toFixed(1)} °C`);
  out.push(`Bottom face     ${r.bottom.h.toFixed(1)} W/m²·K${typeof air === 'object' ? '' : ` (convection ${r.bottom.convection.toFixed(1)}, radiation ${r.bottom.radiation.toFixed(1)})`}, ${r.bottom.loss.toFixed(3)} W leaves, mean ${r.bottom.mean.toFixed(1)} °C`);
  out.push(`Heat            ${r.power.toFixed(3)} W from the parts${r.copperPower > 0 ? `, ${r.copperPower.toFixed(3)} W from the copper` : ''}`);
  out.push(`Hottest place   ${r.max.toFixed(1)} °C on ${layerName(r.model.grid.layers[r.maxAt.layer]!)}, ${(r.max - r.setup.ambient).toFixed(1)} above the air`);
  out.push(`Laminate        ${r.setup.kInPlane ?? 0.8} W/m·K along the board, ${r.setup.kThrough ?? 0.3} through it`);
  out.push(`Limits          board ${limits.board} °C, junctions ${limits.junction} °C`, '');
  out.push(`${pad('Part', 10)}${pad('Power', 10)}${pad('Board', 11)}${pad('Hottest', 11)}Junction`);
  for (const p of r.parts) out.push(`${pad(p.designator, 10)}${pad(`${p.power} W`, 10)}${pad(`${p.board.toFixed(1)} °C`, 11)}${pad(`${p.boardMax.toFixed(1)} °C`, 11)}${p.junction !== undefined ? `${p.junction.toFixed(1)} °C` : ''}`);
  out.push('', 'The warmest parts, by the board at their pads:');
  for (const c of r.components.slice(0, 20)) out.push(`  ${pad(c.designator, 10)}${c.t.toFixed(1)} °C`);
  const issues = thermalIssues(doc, r, limits, layerName);
  out.push('', issues.length ? `${issues.length} to look at:` : 'Nothing out of limits.');
  for (const i of issues) out.push(`  ${i.message}`);
  if (warm) {
    out.push('', `Warm-up: the hottest place is half way in ${span(warm.half)} and nine tenths of the way in ${span(warm.most)}; the board as one lump has a time constant of ${span(warm.lump)}.`);
    out.push(`${pad('Time', 12)}Hottest place`);
    for (let k = 0; k < warm.times.length; k += Math.max(1, Math.floor(warm.times.length / 12))) out.push(`${pad(span(warm.times[k]!), 12)}${warm.max[k]!.toFixed(1)} °C`);
  }
  out.push('', `${r.model.count} nodes on a ${(r.model.grid.h / 10000).toFixed(0)} mil grid; the sum done ${r.rounds} time${r.rounds === 1 ? '' : 's'}, ${r.steps} steps in all`);
  return out.join('\n');
}
