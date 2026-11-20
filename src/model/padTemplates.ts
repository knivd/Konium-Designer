/**
 * The Pad dialog's Pad Template: a pad stack named as AD's Pad Via Library names them [est: the
 * IPC-7351 style, sizes in hundredths of a millimetre] — c circle, s square, r rectangle, o
 * oblong (a round pad longer one way), x octagon, rr rounded rectangle; the size (X_Y when not
 * square), then h and the hole of a through pad. The templates on offer are the board's own pads.
 */
import { mm } from '../core/units';
import { L } from './layers';
import type { PcbDocument, PcbPad } from './pcb';

export function padTemplateName(p: PcbPad): string {
  const u = (v: number) => Math.round(v / mm(0.01));
  const t = p.top, sq = t.w === t.h;
  const prefix = t.shape === 'round' ? (sq ? 'c' : 'o') : t.shape === 'rect' ? (sq ? 's' : 'r') : t.shape === 'octagon' ? 'x' : 'rr';
  return `${prefix}${sq ? u(t.w) : `${u(t.w)}_${u(t.h)}`}${p.layer === L.MULTI && p.hole > 0 ? `h${u(p.hole)}` : ''}`;
}

/** The board's pad stacks by template name (the first pad of each). */
export function padTemplates(doc: PcbDocument): Map<string, PcbPad> {
  const m = new Map<string, PcbPad>();
  for (const p of doc.prims) if (p.kind === 'pad') { const n = padTemplateName(p); if (!m.has(n)) m.set(n, p); }
  return new Map([...m].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })));
}

/** Via templates the same way: v, the diameter, h and the hole. */
export function viaTemplateName(diameter: number, hole: number): string {
  const u = (v: number) => Math.round(v / mm(0.01));
  return `v${u(diameter)}h${u(hole)}`;
}
