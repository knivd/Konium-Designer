/**
 * Crosstalk: where an aggressor net's tracks run beside a victim's on the same layer (parallel,
 * overlapping, close) and the noise it puts on the victim — backward (near-end) and forward
 * (far-end) crosstalk from the coupled length, the separation against the height over the plane
 * (the mutual inductance and capacitance ratios as 1 / (1 + (D/H)²), the capacitive one less on
 * outer layers) and the aggressor's own waveform, the victim held quiet [est: weak coupling, the
 * victim's ends taken as matched — a screening figure, not a field solution].
 */
import { UNITS_PER_MM } from '../core/units';
import type { PcbDocument } from '../model/pcb';
import { NO_NET, inPour } from '../model/pcb';
import { isCopper } from '../model/layers';
import { layersOf, lineOf } from './topology';

export interface Coupling {
  victim: number; layer: number;
  /** Coupled length and centre-to-centre separation (board units), height over the plane (board units). */
  length: number; d: number; h: number;
  /** Backward and forward coefficients, and the coupled section's delay (s). */
  kb: number; kf: number; td: number;
}

const metres = (u: number) => u / UNITS_PER_MM / 1000;

/** The aggressor's sections beside other nets (or only the victims given). */
export function couplings(doc: PcbDocument, aggressor: number, victims?: number[]): Coupling[] {
  const l = layersOf(doc);
  const tracks = doc.prims.filter((p) => p.kind === 'track' && isCopper(p.layer) && !p.keepout && !inPour(p) && p.net !== NO_NET) as Extract<PcbDocument['prims'][number], { kind: 'track' }>[];
  const mine = tracks.filter((t) => t.net === aggressor);
  const want = victims ? new Set(victims) : null;
  const out: Coupling[] = [];
  for (const a of mine) {
    const dx = a.b.x - a.a.x, dy = a.b.y - a.a.y, la = Math.hypot(dx, dy);
    if (la < 1) continue;
    const ux = dx / la, uy = dy / la;
    const g = l.geo.get(a.layer);
    const h = g?.traceToPlane || 100_000;
    const reach = Math.max(3 * h, 100_000) + a.width;
    for (const v of tracks) {
      if (v.net === aggressor || v.layer !== a.layer || (want && !want.has(v.net))) continue;
      const vx = v.b.x - v.a.x, vy = v.b.y - v.a.y, lv = Math.hypot(vx, vy);
      if (lv < 1) continue;
      // Parallel within 3°
      if (Math.abs((ux * vy - uy * vx) / lv) > 0.0523) continue;
      // Separation (centre to centre) and the run they share along the aggressor
      const d = Math.abs((v.a.x - a.a.x) * -uy + (v.a.y - a.a.y) * ux);
      if (d - (a.width + v.width) / 2 > reach || d < (a.width + v.width) / 2) continue;
      const t1 = (v.a.x - a.a.x) * ux + (v.a.y - a.a.y) * uy, t2 = (v.b.x - a.a.x) * ux + (v.b.y - a.a.y) * uy;
      const len = Math.min(la, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
      if (len <= 1000) continue;
      const kL = 1 / (1 + (d / h) ** 2), kC = kL * (g?.kind === 'stripline' ? 1 : 0.75);
      const { perM } = lineOf(l, a.layer, a.width, 50);
      out.push({ victim: v.net, layer: a.layer, length: len, d, h, kb: (kL + kC) / 4, kf: (kC - kL) / 2, td: metres(len) * perM });
    }
  }
  return out;
}

/** The nets beside a net, the most coupled first: total coupled length, the strongest backward coefficient. */
export function coupledNets(doc: PcbDocument, net: number): { net: number; length: number; kb: number }[] {
  const by = new Map<number, { net: number; length: number; kb: number }>();
  for (const c of couplings(doc, net)) {
    const x = by.get(c.victim) ?? { net: c.victim, length: 0, kb: 0 };
    x.length += c.length; x.kb = Math.max(x.kb, c.kb);
    by.set(c.victim, x);
  }
  return [...by.values()].sort((a, b) => b.kb * b.length - a.kb * a.length);
}

/**
 * The noise on a victim from the aggressor's waveform (t, v on any grid): near end
 * Σ Kb (V(t) − V(t − 2Td)), far end Σ Kf Td dV/dt (t − Td).
 */
export function crosstalkWaves(t: Float64Array, v: Float64Array, sections: Coupling[]): { near: Float64Array; far: Float64Array } {
  const n = t.length;
  const near = new Float64Array(n), far = new Float64Array(n);
  const at = (time: number) => {
    if (time <= t[0]!) return v[0]!;
    if (time >= t[n - 1]!) return v[n - 1]!;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m]! <= time) lo = m; else hi = m; }
    const f = (time - t[lo]!) / (t[hi]! - t[lo]! || 1);
    return v[lo]! + (v[hi]! - v[lo]!) * f;
  };
  for (const s of sections) {
    const h = Math.max(s.td / 4, 1e-12);
    for (let i = 0; i < n; i++) {
      near[i]! += s.kb * (v[i]! - at(t[i]! - 2 * s.td));
      const tt = t[i]! - s.td;
      far[i]! += s.kf * s.td * (at(tt + h) - at(tt - h)) / (2 * h);
    }
  }
  return { near, far };
}
