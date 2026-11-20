/**
 * A power analysis as a picture and as a read-out: each place on the net's copper coloured by how
 * far its voltage is from the source's, or by how hard the copper is worked there.
 */

import type { Vec2 } from '../core/geom';
import type { PowerResult } from './power';

export type MapKind = 'drop' | 'density';

const STOPS: [number, number, number][] = [[29, 63, 191], [25, 181, 201], [60, 194, 74], [242, 210, 27], [224, 36, 27]];
/** 0 to 1 as a colour: blue, cyan, green, yellow, red. */
export function ramp(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (STOPS.length - 1), i = Math.min(STOPS.length - 2, Math.floor(x)), f = x - i;
  const a = STOPS[i]!, b = STOPS[i + 1]!;
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}
/** The same colours as a CSS gradient, for the key. */
export const RAMP_CSS = `linear-gradient(to right, ${STOPS.map((s) => `rgb(${s[0]},${s[1]},${s[2]})`).join(', ')})`;

/** The source's voltage in a sum (what the drop is measured from). */
export const reference = (res: PowerResult): number => res.setup.sources[0]?.voltage ?? 0;

/**
 * A layer's copper areas as pixels (RGBA, the top row first), a pixel to each fine cell: coloured
 * from 0 to `max`, clear where there is no copper. Null when the layer has none or no picture was kept.
 */
export function areaPixels(res: PowerResult, li: number, kind: MapKind, max: number): { width: number; height: number; data: Uint8ClampedArray; any: boolean } | null {
  const cn = res.cn, mask = cn.fine?.[li], { w: W, hgt: H } = cn.grid;
  if (!mask) return null;
  const W3 = W * 3, H3 = H * 3, data = new Uint8ClampedArray(W3 * H3 * 4), ref = reference(res), base = li * W * H, scale = max > 0 ? 1 / max : 0;
  // Each cell's colour once
  const rgb = new Uint8Array(W * H * 3), has = new Uint8Array(W * H);
  let any = false;
  for (let c = 0; c < W * H; c++) {
    const n = cn.cellNode[base + c]!;
    if (n < 0) continue;
    const v = kind === 'drop' ? Math.abs(res.v[n]! - ref) : res.density[base + c]!;
    if (!Number.isFinite(v)) { rgb[c * 3] = rgb[c * 3 + 1] = rgb[c * 3 + 2] = 110; has[c] = 1; continue; }
    const [r, g, b] = ramp(v * scale);
    rgb[c * 3] = r; rgb[c * 3 + 1] = g; rgb[c * 3 + 2] = b; has[c] = 1; any = true;
  }
  for (let fy = 0; fy < H3; fy++) {
    const row = (H3 - 1 - fy) * W3 * 4, cy = (fy / 3) | 0;
    for (let fx = 0; fx < W3; fx++) {
      if (!mask[fy * W3 + fx]) continue;
      const c = cy * W + ((fx / 3) | 0);
      if (!has[c]) continue;
      const at = row + fx * 4;
      data[at] = rgb[c * 3]!; data[at + 1] = rgb[c * 3 + 1]!; data[at + 2] = rgb[c * 3 + 2]!; data[at + 3] = 255;
    }
  }
  return { width: W3, height: H3, data, any };
}

/** A length of track's values at its two ends (the same for density), or null when it is not joined to the source. */
export function trackValues(res: PowerResult, k: number, kind: MapKind): [number, number] | null {
  const tp = res.cn.tracks[k]!;
  if (kind === 'density') return [res.trackDensity[k]!, res.trackDensity[k]!];
  const ref = reference(res), a = res.v[res.cn.links.a[tp.link]!]!, b = res.v[res.cn.links.b[tp.link]!]!;
  return Number.isFinite(a) && Number.isFinite(b) ? [Math.abs(a - ref), Math.abs(b - ref)] : null;
}

export interface Probe { voltage: number; density: number; /** A track's current there, amperes. */ current?: number }

/** What the analysis says of a place on a layer: a track there first, else the copper area; null off the net's copper. */
export function probe(res: PowerResult, at: Vec2, li: number): Probe | null {
  const cn = res.cn;
  let best: Probe | null = null, bd = Infinity;
  cn.tracks.forEach((tp, k) => {
    if (tp.layer !== li) return;
    const dx = tp.b.x - tp.a.x, dy = tp.b.y - tp.a.y, len2 = dx * dx + dy * dy, t = len2 > 0 ? Math.min(1, Math.max(0, ((at.x - tp.a.x) * dx + (at.y - tp.a.y) * dy) / len2)) : 0;
    const d = Math.hypot(tp.a.x + dx * t - at.x, tp.a.y + dy * t - at.y);
    if (d > tp.width / 2 || d >= bd) return;
    const a = res.v[cn.links.a[tp.link]!]!, b = res.v[cn.links.b[tp.link]!]!;
    bd = d; best = { voltage: a + (b - a) * t, density: res.trackDensity[k]!, current: Math.abs(res.current[tp.link]!) };
  });
  if (best) return best;
  const { w: W, hgt: H, h, minX, minY } = cn.grid, cx = Math.floor((at.x - minX) / h), cy = Math.floor((at.y - minY) / h);
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return null;
  const mask = cn.fine?.[li];
  if (mask && !mask[Math.floor((at.y - minY) / (h / 3)) * W * 3 + Math.floor((at.x - minX) / (h / 3))]) return null;
  const n = cn.cellNode[li * W * H + cy * W + cx]!;
  return n < 0 ? null : { voltage: res.v[n]!, density: res.density[li * W * H + cy * W + cx]! };
}
