/**
 * Lifelike 3D bodies for generated footprints (26.187). The IPC footprint wizard and the
 * component builder gave every package one box of its height. A package is now made of the
 * pieces it is seen to have: a moulded body that stands off the board and narrows a little
 * towards its top, a dot at pin 1, and its terminals by their kind: gull-wing leads (a foot on
 * the land, a riser, a shoulder into the body), J-leads tucked under, a chip's metal ends, a
 * no-lead package's lands flush with its sides, a ball grid's balls under a substrate and its
 * moulded cap, a MELF's round body, a power package's tab, a through-hole part's pins.
 *
 * Each piece is an extruded outline between two heights with a colour: a 3D body as the desktop
 * software keeps one, so the model is in the footprint, is drawn by both, and needs no model
 * file. Millimetres, the footprint's own coordinates, z up from the board.
 *
 * `packagePieces` goes by the family where the wizard knows it, and otherwise by what the pads
 * themselves say: where each lies against the body's outline.
 */
import type { Vec2 } from '../core/geom';
import type { IpcFamily, IpcFootprint, IpcPad, Range } from './ipcFootprint';

export interface BodyPiece {
  what: 'body' | 'lead' | 'ball' | 'mark' | 'pin';
  outline: Vec2[];
  /** From and to, above the board (below it where negative: a pin through its hole). */
  from: number; to: number;
  /** As a COLORREF (blue in the high byte). */
  colour: number;
}

const rgb = (r: number, g: number, b: number): number => (b << 16) | (g << 8) | r;
export const PIECE_COLOURS = {
  mould: rgb(38, 38, 40), mouldTop: rgb(46, 46, 48), metal: rgb(200, 200, 204), mark: rgb(170, 170, 170),
  resistor: rgb(28, 28, 30), ceramic: rgb(181, 150, 110), ferrite: rgb(70, 70, 74), tantalum: rgb(214, 160, 40), stripe: rgb(120, 70, 20),
  glass: rgb(70, 45, 38), film: rgb(110, 160, 165), substrate: rgb(30, 72, 44),
};
const mid = (v: Range | undefined): number => (v ? (v.min + v.max) / 2 : 0);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const box = (x0: number, y0: number, x1: number, y1: number): Vec2[] => { const a = Math.min(x0, x1), b = Math.max(x0, x1), c = Math.min(y0, y1), d = Math.max(y0, y1); return [{ x: a, y: c }, { x: b, y: c }, { x: b, y: d }, { x: a, y: d }]; };
const disc = (cx: number, cy: number, r: number, n = 16): Vec2[] => Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos((2 * Math.PI * k) / n), y: cy + r * Math.sin((2 * Math.PI * k) / n) }));
const round3 = (p: BodyPiece): BodyPiece => ({ ...p, outline: p.outline.map((v) => ({ x: Math.round(v.x * 1000) / 1000, y: Math.round(v.y * 1000) / 1000 })), from: Math.round(p.from * 1000) / 1000, to: Math.round(p.to * 1000) / 1000 });

/** Which side of the body a pad is a terminal on: 'l', 'r', 't', 'b'; '' for one under the body or over it. */
function sideOf(p: IpcPad, bx: number, by: number, hw: number, hh: number): '' | 'l' | 'r' | 't' | 'b' {
  const dx = Math.abs(p.x - bx) + p.w / 2 - hw, dy = Math.abs(p.y - by) + p.h / 2 - hh;   // how far the pad reaches past the body's edge, each way
  if (dx <= 0.02 && dy <= 0.02) return '';
  // (a corner pad goes with the side it reaches further past, and with its long way where that is a tie)
  if (dx > dy + 1e-6 || (Math.abs(dx - dy) <= 1e-6 && p.w >= p.h)) return p.x < bx ? 'l' : 'r';
  return p.y < by ? 'b' : 't';
}
/** A box given along a side's outward way (u, from the body's centre) and across it (v): turned to x and y for that side. */
function sided(side: 'l' | 'r' | 't' | 'b', bx: number, by: number, u0: number, u1: number, v0: number, v1: number): Vec2[] {
  switch (side) {
    case 'r': return box(bx + u0, v0, bx + u1, v1);
    case 'l': return box(bx - u0, v0, bx - u1, v1);
    case 't': return box(v0, by + u0, v1, by + u1);
    default: return box(v0, by - u0, v1, by - u1);
  }
}

export interface PieceOptions { family?: IpcFamily; prefix?: string; span?: Range; span2?: Range; term?: Range; leadW?: Range; ball?: number; tabW?: number; tabL?: number; pins?: number }

/**
 * The moulded body: two slabs, the upper drawn in a little, from `standoff` to the package's height; and its pin 1 dot.
 * `marked`: something is drawn on its top (the dot, a band, a stripe), which then is the highest thing and the body a
 * hundredth of a millimetre under it: the package is no taller for its mark.
 */
function mould(fp: IpcFootprint, standoff: number, colour = PIECE_COLOURS.mould, dot = true, marked = dot): BodyPiece[] {
  const { w, h } = fp.body, bx = fp.body.x ?? 0, by = fp.body.y ?? 0, H = fp.height, top = marked ? H - 0.01 : H;
  const lip = clamp(0.05 * Math.min(w, h), 0.03, 0.15), waist = standoff + (H - standoff) * 0.55;
  const out: BodyPiece[] = [
    { what: 'body', outline: box(bx - w / 2, by - h / 2, bx + w / 2, by + h / 2), from: standoff, to: waist, colour },
    { what: 'body', outline: box(bx - w / 2 + lip, by - h / 2 + lip, bx + w / 2 - lip, by + h / 2 - lip), from: waist, to: top, colour: colour === PIECE_COLOURS.mould ? PIECE_COLOURS.mouldTop : colour },
  ];
  const one = fp.pads.find((p) => p.name === '1' || /^A1$/i.test(p.name));
  if (dot && one) {
    const r = clamp(0.07 * Math.min(w, h), 0.1, 0.4), inset = lip + r * 1.8;
    const sx = one.x < bx - 1e-6 ? -1 : one.x > bx + 1e-6 ? 1 : -1, sy = one.y < by - 1e-6 ? -1 : 1;
    out.push({ what: 'mark', outline: disc(bx + sx * (w / 2 - inset), by + sy * (h / 2 - inset), r), from: H - 0.01, to: H, colour: PIECE_COLOURS.mark });
  }
  return out;
}

/** A gull-wing lead on a side: its foot on the land, its riser, and its shoulder into the body. `tip`: how far out from the body's centre its end is. */
function gull(side: 'l' | 'r' | 't' | 'b', bx: number, by: number, edge: number, tip: number, across: number, width: number, foot: number, H: number, simple: boolean): BodyPiece[] {
  const t = clamp(0.12 * H, 0.08, 0.25), zs = clamp(0.5 * H, t + 0.05, Math.max(t + 0.05, H - 0.1)), v0 = across - width / 2, v1 = across + width / 2;
  const heel = Math.max(edge + t, tip - foot), colour = PIECE_COLOURS.metal;
  const piece = (u0: number, u1: number, from: number, to: number): BodyPiece => ({ what: 'lead', outline: sided(side, bx, by, u0, u1, v0, v1), from, to, colour });
  // A lead with no room for a riser clear of the body is a terminal flat on its land
  if (tip - edge < 2.5 * t) return [piece(edge - 0.02, tip, 0, t)];
  if (simple) return [piece(heel, tip, 0, t), piece(edge - 0.02, heel, 0, zs)];
  return [piece(heel, tip, 0, t), piece(heel - t, heel, 0, zs), piece(edge - 0.02, heel - t, zs - t, zs)];
}

/**
 * The pieces of a package: by its family where one is given, otherwise by its pads against its body.
 * The footprint's body box, height and pads are what the wizard worked out; `o` adds what the pads do not say
 * (how far the leads reach, how long their feet are, a ball's size).
 */
export function packagePieces(fp: IpcFootprint, o: PieceOptions = {}): BodyPiece[] {
  const H = fp.height, { w, h } = fp.body, bx = fp.body.x ?? 0, by = fp.body.y ?? 0, hw = w / 2, hh = h / 2;
  if (!(H > 0) || !(w > 0) || !(h > 0)) return [];
  const out: BodyPiece[] = [], C = PIECE_COLOURS, fam = o.family;
  const smd = fp.pads.filter((p) => !(p.hole && p.hole > 0)), holes = fp.pads.filter((p) => p.hole && p.hole > 0);

  // A chip: two metal ends, the body between them
  if (fam === 'CHIP' || (!fam && smd.length === 2 && !holes.length && smd.every((p) => sideOf(p, bx, by, hw, hh) !== '' && Math.abs(p.x - bx) - p.w / 2 < hw && Math.abs(p.y - by) < 1e-6) && H <= Math.max(w, h))) {
    const t = clamp(mid(o.term) || 0.2 * w, 0.1, 0.35 * w);
    const colour = /^CAP/i.test(o.prefix ?? '') ? C.ceramic : /^IND|^FB/i.test(o.prefix ?? '') ? C.ferrite : /^RES/i.test(o.prefix ?? '') ? C.resistor : /^(C|L)\d/i.test(fp.name) ? C.ceramic : C.resistor;
    out.push({ what: 'lead', outline: box(bx - hw, by - hh, bx - hw + t, by + hh), from: 0, to: H, colour: C.metal }, { what: 'lead', outline: box(bx + hw - t, by - hh, bx + hw, by + hh), from: 0, to: H, colour: C.metal });
    out.push({ what: 'body', outline: box(bx - hw + t, by - hh + 0.02, bx + hw - t, by + hh - 0.02), from: 0.01, to: H - 0.01, colour });
    return out.map(round3);
  }
  // A MELF: a round body lying along its pads, as slabs; its ends in metal
  if (fam === 'MELF') {
    const t = clamp(mid(o.term) || 0.15 * w, 0.1, 0.3 * w), r = Math.min(hh, H / 2), n = 6;
    const colour = /^DIO/i.test(o.prefix ?? '') ? C.glass : C.film;
    for (let k = 0; k < n; k++) {
      const z0 = (2 * r * k) / n, z1 = (2 * r * (k + 1)) / n, zm = (z0 + z1) / 2 - r, half = Math.sqrt(Math.max(0, r * r - zm * zm));
      out.push({ what: 'lead', outline: box(bx - hw, by - half, bx - hw + t, by + half), from: z0, to: z1, colour: C.metal }, { what: 'lead', outline: box(bx + hw - t, by - half, bx + hw, by + half), from: z0, to: z1, colour: C.metal });
      // (a diode's band round it at pin 1, its cathode: the body is in two parts either side of it)
      const band = /^DIO/i.test(o.prefix ?? '') ? [bx - hw + t + 0.06 * w, bx - hw + t + 0.16 * w] as const : null;
      if (band) {
        out.push({ what: 'body', outline: box(bx - hw + t, by - half * 0.96, band[0], by + half * 0.96), from: z0, to: z1, colour });
        out.push({ what: 'mark', outline: box(band[0], by - half * 0.97, band[1], by + half * 0.97), from: z0, to: z1, colour: C.mark });
        out.push({ what: 'body', outline: box(band[1], by - half * 0.96, bx + hw - t, by + half * 0.96), from: z0, to: z1, colour });
      } else out.push({ what: 'body', outline: box(bx - hw + t, by - half * 0.96, bx + hw - t, by + half * 0.96), from: z0, to: z1, colour });
    }
    return out.map(round3);
  }
  // A moulded two-terminal part (a tantalum capacitor, a diode): its body, a terminal folded under each end, a stripe at pin 1
  if (fam === 'MOLDED') {
    const t = clamp(mid(o.term) || 0.2 * w, 0.2, 0.35 * w), lw = clamp(mid(o.leadW) || 0.8 * h, 0.3, h), cap = /^CAP/i.test(o.prefix ?? '');
    out.push(...mould(fp, 0.05, cap ? C.tantalum : C.mould, false, true));
    for (const s of [-1, 1]) {
      out.push({ what: 'lead', outline: box(bx + s * hw, by - lw / 2, bx + s * (hw - t), by + lw / 2), from: 0, to: 0.05, colour: C.metal });
      out.push({ what: 'lead', outline: box(bx + s * (hw + 0.03), by - lw / 2, bx + s * (hw - 0.05), by + lw / 2), from: 0, to: 0.5 * H, colour: C.metal });
    }
    out.push({ what: 'mark', outline: box(bx - hw + 0.12 * w, by - hh + 0.1, bx - hw + 0.22 * w, by + hh - 0.1), from: H - 0.01, to: H, colour: cap ? C.stripe : C.mark });
    return out.map(round3);
  }
  // A ball grid: the balls that show (the two outer rings), a substrate over them, a moulded cap on it
  if (fam === 'BGA' || (!fam && !holes.length && smd.length >= 9 && smd.every((p) => p.shape === 'round' && sideOf(p, bx, by, hw, hh) === ''))) {
    const d = o.ball || Math.min(...smd.map((p) => Math.min(p.w, p.h))) / 0.8, zb = Math.min(0.75 * d, 0.4 * H);
    const xs = [...new Set(smd.map((p) => p.x))].sort((a, b) => a - b), ys = [...new Set(smd.map((p) => p.y))].sort((a, b) => a - b);
    const outer = (v: number, list: number[]) => { const i = list.indexOf(v); return i < 2 || i >= list.length - 2; };
    for (const p of smd) if (outer(p.x, xs) || outer(p.y, ys)) out.push({ what: 'ball', outline: disc(p.x, p.y, d / 2, 12), from: 0, to: zb, colour: C.metal });
    const sub = Math.min(zb + Math.max(0.2, 0.25 * (H - zb)), H);
    out.push({ what: 'body', outline: box(bx - hw, by - hh, bx + hw, by + hh), from: zb - 0.01, to: sub, colour: C.substrate });
    if (H - sub > 0.05) {
      const lip = clamp(0.06 * Math.min(w, h), 0.2, 1);
      out.push({ what: 'body', outline: box(bx - hw + lip, by - hh + lip, bx + hw - lip, by + hh - lip), from: sub, to: H - 0.01, colour: C.mould });
      const one = smd.find((p) => /^A1$/i.test(p.name)) ?? smd[0]!;
      const r = clamp(0.05 * Math.min(w, h), 0.15, 0.5), sx = one.x <= bx ? -1 : 1, sy = one.y >= by ? 1 : -1;
      out.push({ what: 'mark', outline: disc(bx + sx * (hw - lip - 2 * r), by + sy * (hh - lip - 2 * r), r), from: H - 0.01, to: H, colour: C.mark });
    }
    return out.map(round3);
  }

  // The rest have a moulded body and terminals round it, each by where its pad lies
  const noLead = fam === 'QFN' || fam === 'SON', jLead = fam === 'PLCC' || fam === 'SOJ';
  const sides = fp.pads.map((p) => (p.hole && p.hole > 0 ? '' : sideOf(p, bx, by, hw, hh)));
  const gullish = !noLead && !jLead && sides.some((s) => s !== '');
  const standoff = noLead ? 0.02 : jLead ? clamp(0.15 * H, 0.2, 0.7) : gullish ? clamp(0.08 * H, 0.05, 0.15) : holes.length ? clamp(0.1 * H, 0.2, 0.5) : 0;
  out.push(...mould(fp, standoff, PIECE_COLOURS.mould, fam !== 'SOD', true));
  const many = (o.pins ?? fp.pads.length) > 100;
  const sod = fam === 'SOD';
  fp.pads.forEach((p, i) => {
    if (p.hole && p.hole > 0) {
      // A pin through its hole: square, three fifths of the drill, from under the board to the body
      const a = Math.max(0.2, p.hole * 0.6) / 2;
      out.push({ what: 'pin', outline: box(p.x - a, p.y - a, p.x + a, p.y + a), from: -3.1, to: Math.max(standoff, 0.1), colour: C.metal });
      return;
    }
    const side = sides[i]!;
    if (side === '') {
      // Under the body: a land (a thermal pad, a tab's inner part): a foil's thickness of metal, seen only from below
      if (noLead || fam === 'DPAK' || fam === 'SOT223') out.push({ what: 'lead', outline: box(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2), from: 0, to: Math.max(0.02, standoff), colour: C.metal });
      return;
    }
    const horizontal = side === 'l' || side === 'r';
    const edge = horizontal ? hw : hh, centre = horizontal ? p.x - bx : p.y - by, len = horizontal ? p.w : p.h, wide = horizontal ? p.h : p.w, across = horizontal ? p.y : p.x;
    const padOut = Math.abs(centre) + len / 2, padIn = Math.abs(centre) - len / 2;
    // The tab of a power package: a slab of metal from under the body out over its land
    const tab = (fam === 'DPAK' || fam === 'SOT223') && wide >= 1.8 * Math.min(...smd.map((q) => Math.min(q.w, q.h)));
    if (tab && fam === 'DPAK') { out.push({ what: 'lead', outline: sided(side, bx, by, Math.min(edge - 0.5, padIn), padOut - 0.3, across - (o.tabW || wide * 0.9) / 2, across + (o.tabW || wide * 0.9) / 2), from: 0, to: clamp(0.25 * H, 0.3, 0.6), colour: C.metal }); return; }
    const span = horizontal ? mid(o.span) : mid(o.span2) || mid(o.span);
    const width = tab ? (o.tabW || wide * 0.9) : clamp(mid(o.leadW) || wide * 0.7, 0.1, wide);
    if (noLead) {
      // Flush with the body's side, as deep as the land goes under it
      out.push({ what: 'lead', outline: sided(side, bx, by, Math.min(padIn, edge - 0.15), edge + 0.01, across - width / 2, across + width / 2), from: 0, to: clamp(0.25 * H, 0.1, 0.25), colour: C.metal });
      return;
    }
    if (jLead) {
      const t = clamp(0.06 * H, 0.1, 0.25), foot = clamp(mid(o.term) || 0.6 * len, 0.3, len);
      out.push({ what: 'lead', outline: sided(side, bx, by, edge - foot, edge + t, across - width / 2, across + width / 2), from: 0, to: t, colour: C.metal });
      out.push({ what: 'lead', outline: sided(side, bx, by, edge - 0.02, edge + t, across - width / 2, across + width / 2), from: 0, to: clamp(0.55 * H, standoff + 0.2, H - 0.2), colour: C.metal });
      return;
    }
    // A gull-wing lead: its end where the span says, or a toe's fillet short of the land's end
    const tip = span > 2 * edge ? span / 2 : padOut - Math.min(0.35, 0.25 * len);
    const foot = clamp(mid(o.term) || 0.6 * len, 0.15, Math.max(0.15, tip - edge));
    out.push(...gull(side, bx, by, edge, Math.max(tip, edge + 0.05), across, width, foot, fam === 'DPAK' ? H * 0.8 : H, many));
  });
  // (a diode's band across the body at pin 1, its cathode)
  if (sod) { const one = fp.pads[0]; if (one) { const s = one.x < bx ? -1 : 1; out.push({ what: 'mark', outline: box(bx + s * (hw - 0.12 * w), by - hh + 0.08, bx + s * (hw - 0.3 * w), by + hh - 0.08), from: H - 0.01, to: H, colour: C.mark }); } }
  return out.map(round3);
}
