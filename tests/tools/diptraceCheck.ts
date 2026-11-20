/**
 * DipTrace boards read, measured (R12): a DipTrace XML board (.dipxml) read by Konium Designer's
 * importer and compared with what DipTrace made of it, where those files lie beside it: the top
 * copper's flashes (a Gerber, its pads), the plated holes (an Excellon drill file) and the pick and
 * place file (CSV: designator, middle X and Y, layer, rotation). DipTrace's outputs lie at an offset
 * of their own: the median offset is taken out first. Distances in millimetres.
 *
 *   npx vite-node tests/tools/diptraceCheck.ts <board.dipxml> [--gerber top.GTL] [--drill file.DRL] [--cpl file.csv]
 */
import { readFileSync } from 'node:fs';
import { readDipTrace } from '../../src/formats/diptrace/read';
import { convertDipTracePcb } from '../../src/formats/diptrace/pcb';
import { readPcbDoc } from '../../src/formats/altium/pcbdoc';
import { UNITS_PER_MM } from '../../src/core/units';
import { L } from '../../src/model/layers';
import type { PcbPad } from '../../src/model/pcb';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) { console.error('usage: diptraceCheck.ts <board.dipxml> [--gerber f] [--drill f] [--cpl f]'); process.exit(2); }

const r = convertDipTracePcb(readDipTrace(readFileSync(file)), 'Board');
const doc = readPcbDoc(r.bytes, 'Board.PcbDoc');
const ox = doc.board.origin.x, oy = doc.board.origin.y;
const mmOf = (v: { x: number; y: number }) => ({ x: (v.x - ox) / UNITS_PER_MM, y: (v.y - oy) / UNITS_PER_MM });
const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad');
console.log(`${file}: ${r.stats.components} components, ${r.stats.pads} pads, ${r.stats.vias} vias, ${r.stats.tracks} tracks, ${r.stats.nets} nets; warnings: ${r.warnings.join(' | ') || 'none'}`);

type Pt = { x: number; y: number };
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
function compare(label: string, ours: Pt[], theirs: Pt[]): void {
  if (!ours.length || !theirs.length) { console.log(`${label}: nothing to compare (${ours.length} ours, ${theirs.length} theirs)`); return; }
  // The offset: the one that brings most of ours onto theirs (each of a few of ours to each of theirs tried)
  let dx = 0, dy = 0, most = -1;
  for (const p of ours.slice(0, 6)) for (const q of theirs) {
    const cx = q.x - p.x, cy = q.y - p.y;
    const n = ours.filter((o) => theirs.some((t) => Math.hypot(t.x - o.x - cx, t.y - o.y - cy) < 0.02)).length;
    if (n > most) { most = n; dx = cx; dy = cy; }
  }
  const errs = ours.map((p) => Math.min(...theirs.map((q) => Math.hypot(q.x - p.x - dx, q.y - p.y - dy))));
  const bad = errs.filter((e) => e > 0.01).length;
  console.log(`${label}: ${ours.length} ours, ${theirs.length} theirs; offset ${dx.toFixed(3)}, ${dy.toFixed(3)}; worst ${Math.max(...errs).toFixed(4)}; over 0.01 mm: ${bad}`);
}

const gerber = opt('--gerber');
if (gerber) {
  const t = readFileSync(gerber, 'utf8');
  const fs = /%FSLAX(\d)(\d)Y\d\d\*%/.exec(t);
  const dec = fs ? Number(fs[2]) : 5;
  const scale = /%MOIN\*%/.test(t) ? 25.4 : 1;
  let x = 0, y = 0;
  const flashes: Pt[] = [];
  for (const m of t.matchAll(/(?:X(-?\d+))?(?:Y(-?\d+))?D0?([123])\*/g)) {
    if (m[1]) x = (Number(m[1]) / 10 ** dec) * scale;
    if (m[2]) y = (Number(m[2]) / 10 ** dec) * scale;
    if (m[3] === '3') flashes.push({ x, y });
  }
  const top = pads.filter((p) => p.layer === L.TOP || p.layer === L.MULTI).map((p) => mmOf(p.at));
  const viaPts = doc.prims.filter((p) => p.kind === 'via').map((v) => mmOf((v as { at: Pt }).at));
  compare('Top copper flashes (pads and vias)', [...top, ...viaPts], flashes);
}
const drill = opt('--drill');
if (drill) {
  const t = readFileSync(drill, 'utf8');
  const metric = /METRIC/.test(t);
  const fmt = /METRIC,0*(\d+)\.(\d+)|INCH,0*(\d+)\.(\d+)/.exec(t);
  const dec = fmt ? (fmt[2] ?? fmt[4] ?? '00').length : 2;
  const holes: Pt[] = [];
  for (const m of t.matchAll(/^X([+-]?\d+)Y([+-]?\d+)/gm)) holes.push({ x: (Number(m[1]) / 10 ** dec) * (metric ? 1 : 25.4), y: (Number(m[2]) / 10 ** dec) * (metric ? 1 : 25.4) });
  const ours = [...pads.filter((p) => (p.hole ?? 0) > 0).map((p) => mmOf(p.at)), ...doc.prims.filter((p) => p.kind === 'via').map((v) => mmOf((v as { at: Pt }).at))];
  compare('Holes', ours, holes);
}
const cpl = opt('--cpl');
if (cpl) {
  const rows = readFileSync(cpl, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
  const theirs = new Map(rows.map((c) => [c[0]!, { x: Number(c[1]), y: Number(c[2]), side: c[3]!, rot: Number(c[4]) }]));
  const dxs: number[] = [], dys: number[] = [];
  const ours = doc.components.map((c) => ({ des: c.designator, ...mmOf(c.at), rot: c.rotation, side: c.layer === L.BOTTOM ? 'Bottom' : 'Top' }));
  for (const o of ours) { const t = theirs.get(o.des); if (t) { dxs.push(t.x - o.x); dys.push(t.y - o.y); } }
  const dx = median(dxs), dy = median(dys);
  let worst = 0, rotBad = 0, sideBad = 0, n = 0;
  for (const o of ours) {
    const t = theirs.get(o.des);
    if (!t) continue;
    n++;
    worst = Math.max(worst, Math.hypot(t.x - o.x - dx, t.y - o.y - dy));
    if (Math.abs(((t.rot - (o.side === 'Bottom' ? (o.rot + 180) % 360 : o.rot)) % 360 + 360) % 360) > 0.01) rotBad++;
    if (t.side !== o.side) sideBad++;
  }
  console.log(`Placement: ${n} of ${ours.length} matched; offset ${dx.toFixed(3)}, ${dy.toFixed(3)}; worst ${worst.toFixed(4)}; rotations off ${rotBad}; sides off ${sideBad}`);
}
