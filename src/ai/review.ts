/**
 * A footprint shown back to the model that made it: its land pattern in the package job's answer
 * shape (rows of like pads, single pads), drawn to scale with its pad names and main dimensions,
 * and its pads outlined in red over the datasheet's drawing where they were measured — so that the
 * model sees what it made beside what it read, and puts right what doesn't match (the review job).
 */
import type { LandAnswer, LandPad } from './jobs';
import { rowsOf, type Measured } from './snap';
import { PLAIN, dimText, drawPattern, rand, toSvg, type Dim, type Drawing, type Label } from './synth';

const f4 = (v: number) => +v.toFixed(4) || 0;
const num = (name: string) => /^(.*?)(\d+)$/.exec(name);

/** A land pattern in the package job's answer shape: its rows of like pads evenly spaced (named on, or listed), the rest single pads. */
export function answerOf(land: LandPad[]): LandAnswer {
  const out: LandAnswer = { rows: [], pads: [] };
  const inRow = new Set<number>();
  for (const row of rowsOf(land)) {
    const pads = row.map((j) => land[j]!);
    const a = pads[0]!, b = pads[1]!, dx = b.x - a.x, dy = b.y - a.y, pitch = Math.hypot(dx, dy);
    // Evenly spaced, round holes only (a slot has no place in a row)
    if (pads.some((p, k) => p.slot || !p.plated || Math.abs(Math.hypot(p.x - a.x, p.y - a.y) - k * pitch) > 0.002)) continue;
    const direction = Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'up' : 'down';
    // Named on from the first (1, 2, 3 or B12, B11, B10 …), else listed
    const m0 = num(a.name), step = m0 && num(b.name)?.[1] === m0[1] ? Number(num(b.name)![2]) - Number(m0[2]) : 0;
    const counted = !!m0 && Math.abs(step) === 1 && pads.every((p, k) => p.name === `${m0[1]}${Number(m0[2]) + k * step}`);
    out.rows.push({
      first: a.name, last: pads.at(-1)!.name, count: pads.length, pitch: f4(pitch), direction, x: f4(a.x), y: f4(a.y), w: a.w, h: a.h, shape: a.shape, hole: a.hole,
      names: counted ? null : pads.map((p) => p.name),
    });
    row.forEach((j) => inRow.add(j));
  }
  land.forEach((p, j) => { if (!inRow.has(j)) out.pads.push({ name: p.name, x: f4(p.x), y: f4(p.y), w: p.w, h: p.h, shape: p.shape, hole: p.hole, slot: p.slot, plated: p.plated }); });
  return out;
}

/** The footprint drawn to scale for the model: its pads (every one named), each row's pitch, the rows' distances, the holes. */
export function footprintDrawing(land: LandPad[]): Drawing {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of land) { x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const dims: Dim[] = [], labels: Label[] = [];
  const rows = rowsOf(land), inRow = new Set(rows.flat());
  const along = (row: number[]) => (Math.abs(land[row[1]!]!.x - land[row[0]!]!.x) >= Math.abs(land[row[1]!]!.y - land[row[0]!]!.y) ? 'x' : 'y');
  for (const row of rows) {
    const a = land[row[0]!]!, b = land[row[1]!]!;
    if (along(row) === 'x') {
      const top = a.y >= cy, e = top ? a.y + a.h / 2 : a.y - a.h / 2;
      dims.push({ t: 'lin', axis: 'x', a: a.x, b: b.x, ea: e, eb: e, side: top ? 'top' : 'bottom', what: 'pitch', pitch: true });
      for (const j of row) labels.push({ text: land[j]!.name, x: land[j]!.x, y: land[j]!.y, out: { x: 0, y: top ? 1 : -1 }, ext: land[j]!.h / 2, main: true });
    } else {
      const right = a.x >= cx, e = right ? a.x + a.w / 2 : a.x - a.w / 2;
      dims.push({ t: 'lin', axis: 'y', a: a.y, b: b.y, ea: e, eb: e, side: right ? 'right' : 'left', what: 'pitch', pitch: true });
      for (const j of row) labels.push({ text: land[j]!.name, x: land[j]!.x, y: land[j]!.y, out: { x: right ? 1 : -1, y: 0 }, ext: land[j]!.w / 2, main: true });
    }
  }
  // Neighbouring rows' distances, centre to centre
  for (const ax of ['x', 'y'] as const) {
    const list = rows.filter((r) => along(r) === ax).map((r) => land[r[0]!]!).sort((p, q) => (ax === 'x' ? p.y - q.y : p.x - q.x));
    for (let i = 1; i < list.length; i++) {
      const p = list[i - 1]!, q = list[i]!;
      if (ax === 'x') dims.push({ t: 'lin', axis: 'y', a: p.y, b: q.y, ea: p.x - p.w / 2, eb: q.x - q.w / 2, side: 'left', what: 'rows' });
      else dims.push({ t: 'lin', axis: 'x', a: p.x, b: q.x, ea: p.y - p.h / 2, eb: q.y - q.h / 2, side: 'bottom', what: 'rows' });
    }
  }
  land.forEach((p, j) => {
    if (inRow.has(j)) return;
    if (p.name) labels.push({ text: p.name, x: p.x, y: p.y, out: { x: 0, y: 0 }, ext: 0, main: true });
    if (p.hole) dims.push({ t: 'dia', x: p.x, y: p.y, d: p.hole, ...(p.slot ? { slot: p.slot } : {}), plated: p.plated, what: 'hole' });
  });
  for (const d of dims) d.text = dimText(d, PLAIN);
  return drawPattern({ outline: null, dims, labels }, land, PLAIN, rand(1), { width: [960, 960], height: [760, 760] });
}

/** The footprint's picture (PNG data URL): its drawing rendered in the browser. */
export async function footprintPicture(land: LandPad[]): Promise<string> {
  const d = footprintDrawing(land);
  return await canvasOf(d.width, d.height, async (ctx) => { ctx.drawImage(await image(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(toSvg(d))}`), 0, 0); });
}

/**
 * The datasheet's drawing (`base`, a picture of the region measured, of any size) with the pads
 * outlined in red where the measuring puts them, named in red: a JPEG data URL.
 */
export async function overlayPicture(base: string, land: LandPad[], m: Measured): Promise<string> {
  const img = await image(base);
  const k = img.naturalWidth / m.picture.width, s = m.scale * k;
  return await canvasOf(img.naturalWidth, img.naturalHeight, (ctx) => {
    ctx.drawImage(img, 0, 0);
    ctx.strokeStyle = '#e00000'; ctx.lineWidth = Math.max(1.5, img.naturalWidth / 900);
    ctx.fillStyle = '#e00000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const p of land) {
      const x = (m.origin.x + p.x * m.scale) * k, y = (m.origin.y - p.y * m.scale) * k, w = p.w * s, h = p.h * s;
      const r = p.shape === 'round' ? Math.min(w, h) / 2 : p.shape === 'roundrect' ? Math.min(w, h) / 4 : 0;
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, r); ctx.stroke();
      if (p.hole) { const hw = p.hole * s, hh = (p.slot || p.hole) * s, [a, b] = p.w >= p.h ? [hh, hw] : [hw, hh]; ctx.beginPath(); ctx.roundRect(x - a / 2, y - b / 2, a, b, Math.min(a, b) / 2); ctx.stroke(); }
      if (p.name) { ctx.font = `bold ${Math.max(10, Math.min(18, Math.min(w, h) * 0.6))}px Arial, sans-serif`; ctx.fillText(p.name, x, y); }
    }
  }, 'image/jpeg');
}

function image(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error('The picture couldn\'t be drawn')); i.src = url; });
}

async function canvasOf(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void | Promise<void>, type: 'image/png' | 'image/jpeg' = 'image/png'): Promise<string> {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  await paint(ctx);
  return type === 'image/jpeg' ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png');
}
