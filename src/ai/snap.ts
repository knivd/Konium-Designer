/**
 * Pads measured from the drawing: the AI reads a land pattern's structure well (which pads,
 * their names, rows, pitch, sizes) but works positions out of chained dimensions poorly (rows
 * a fraction of a millimetre off, a stagger missed). The drawing itself has them exactly: the
 * pads drawn in a picture of the land pattern (outlined or hatched), found as solid shapes,
 * measured at the scale the pitch gives (the spacing of a row of like pads), and each pad read
 * by the AI moved onto the shape it stands for — a row as a whole (each row placed on its own,
 * so a stagger between rows comes out), a single pad on the nearest like shape. Pads with no
 * shape near enough keep the AI's place, moved with the rest.
 */
import type { LandPad, PackageRead } from './jobs';
import type { Seg } from './vector';

/** A greyscale picture: 0 black … 255 white, row by row. */
export interface Grey { width: number; height: number; data: Uint8Array }
/** A solid shape found in the picture: its box in pixels (x1, y1 exclusive). */
export interface Shape { x0: number; y0: number; x1: number; y1: number; area: number }

const cx = (b: Shape) => (b.x0 + b.x1) / 2, cy = (b: Shape) => (b.y0 + b.y1) / 2;
const bw = (b: Shape) => b.x1 - b.x0, bh = (b: Shape) => b.y1 - b.y0;

/** Erode (min) or dilate (max) a mask by a square of side 2r + 1, as two passes. */
function morph(m: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const pass = (src: Uint8Array, horiz: boolean) => {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = grow ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = horiz ? x + k : x, yy = horiz ? y : y + k;
        const s = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx]!;
        if (grow ? s : !s) { v = grow ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
    return out;
  };
  return pass(pass(m, true), false);
}

/** Connected regions (4-neighbour) of the cells where `on` holds, with their boxes. */
function regions(w: number, h: number, on: (i: number) => boolean): { label: Int32Array; boxes: Shape[] } {
  const label = new Int32Array(w * h).fill(-1);
  const boxes: Shape[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (label[s] !== -1 || !on(s)) continue;
    const id = boxes.length;
    const b: Shape = { x0: w, y0: h, x1: 0, y1: 0, area: 0 };
    label[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i - x) / w;
      b.area++; b.x0 = Math.min(b.x0, x); b.y0 = Math.min(b.y0, y); b.x1 = Math.max(b.x1, x + 1); b.y1 = Math.max(b.y1, y + 1);
      const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      for (const j of next) if (j >= 0 && label[j] === -1 && on(j)) { label[j] = id; stack.push(j); }
    }
    boxes.push(b);
  }
  return { label, boxes };
}

/**
 * The solid shapes of a drawing: ink (darker than mid grey), enclosed spaces filled (a pad's
 * outline and its hatching become one solid) when small, or when big and empty, round or square
 * (a big pad outlined: not a space closed by dimension lines, nor an outline with pads inside), then
 * thin lines (dimension and extension lines, hatching outside pads) taken away.
 */
export function shapes(img: Grey, line = 2): Shape[] {
  const { width: w, height: h, data } = img;
  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) ink[i] = data[i]! < 160 ? 1 : 0;
  // Spaces enclosed by ink: filled when small, or big but empty (no ink of its own inside) and nearly filling its box
  const space = regions(w, h, (i) => !ink[i]);
  const maxSide = 0.2 * Math.max(w, h);
  const inner = (b: Shape) => b.x0 > 0 && b.y0 > 0 && b.x1 < w && b.y1 < h;
  const big = space.boxes.map((b) => inner(b) && (bw(b) >= maxSide || bh(b) >= maxSide) && bw(b) < 0.6 * w && bh(b) < 0.6 * h && b.area >= 0.75 * bw(b) * bh(b));
  if (big.some(Boolean)) {
    // Ink standing apart inside a big space leaves it unfilled: a solid (a pad within an outline, a letter) or one closing a
    // space of its own (a pad outlined); not lines crossing it (centre lines)
    const blobs = regions(w, h, (i) => !!ink[i]).boxes;
    /** Of 32 places along each side of space k, how many have ink more than 6 px deep beyond its edge. */
    const thickEdge = (k: number, b: Shape) => {
      let n = 0;
      const deep = (i: number, step: number, ok: (j: number) => boolean) => { let d = 0; for (let j = i + step; ok(j) && ink[j] && d <= 6; j += step) d++; return d > 6; };
      for (let q = 0; q < 32; q++) {
        const y = Math.floor(b.y0 + ((q + 0.5) * bh(b)) / 32), x = Math.floor(b.x0 + ((q + 0.5) * bw(b)) / 32);
        let i = y * w + b.x0; while (i < y * w + b.x1 && space.label[i] !== k) i++;
        if (i < y * w + b.x1 && deep(i, -1, (j) => j >= y * w)) n++;
        i = y * w + b.x1 - 1; while (i >= y * w + b.x0 && space.label[i] !== k) i--;
        if (i >= y * w + b.x0 && deep(i, 1, (j) => j < (y + 1) * w)) n++;
        i = b.y0 * w + x; while (i < b.y1 * w && space.label[i] !== k) i += w;
        if (i < b.y1 * w && deep(i, -w, (j) => j >= 0)) n++;
        i = (b.y1 - 1) * w + x; while (i >= b.y0 * w && space.label[i] !== k) i -= w;
        if (i >= b.y0 * w && deep(i, w, (j) => j < w * h)) n++;
      }
      return n;
    };
    const inside = (o: Shape, b: Shape) => o.x0 > b.x0 && o.y0 > b.y0 && o.x1 < b.x1 && o.y1 < b.y1;
    space.boxes.forEach((b, k) => {
      if (!big[k]) return;
      const own = space.boxes.filter((sp, j) => j !== k && inside(sp, b));
      if (blobs.some((o) => bw(o) > 3 && bh(o) > 3 && inside(o, b) && (o.area >= 0.4 * bw(o) * bh(o) || own.some((sp) => inside(sp, o) && sp.area >= 0.3 * bw(o) * bh(o))))) big[k] = false;
      // Closed by a thin line all round (a pad's outline), not by solids crossing it (a body's outline over its pads)
      else if (thickEdge(k, b) > 5) big[k] = false;
    });
  }
  // A space between hatching lines across a big pad: a long thin strip, slanting (little of its box)
  const strip = (b: Shape) => b.area < 0.35 * bw(b) * bh(b) && b.area / Math.hypot(bw(b), bh(b)) < 12;
  const fill = space.boxes.map((b, k) => big[k] || (inner(b) && ((bw(b) < maxSide && bh(b) < maxSide) || strip(b))));
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = ink[i] || (space.label[i]! >= 0 && fill[space.label[i]!]) ? 1 : 0;
  const opened = morph(morph(solid, w, h, line, false), w, h, line, true);
  return regions(w, h, (i) => !!opened[i]).boxes.filter((b) => bw(b) >= 2 * line + 2 && bh(b) >= 2 * line + 2);
}

/** Groups of the read's pads in a line: like pads (same size and hole) at one y (or one x), two or more, along the line. */
export function rowsOf(land: LandPad[]): number[][] {
  const used = new Set<number>(), rows: number[][] = [];
  const like = (a: LandPad, b: LandPad) => Math.abs(a.w - b.w) < 1e-3 && Math.abs(a.h - b.h) < 1e-3 && a.hole === b.hole && !!a.name && !!b.name;
  for (const axis of ['y', 'x'] as const) {
    const along = axis === 'y' ? 'x' : 'y';
    for (let i = 0; i < land.length; i++) {
      if (used.has(i)) continue;
      const row = land.map((_, j) => j).filter((j) => !used.has(j) && like(land[j]!, land[i]!) && Math.abs(land[j]![axis] - land[i]![axis]) < 1e-3);
      if (row.length < 3) continue;
      row.sort((a, b) => land[a]![along] - land[b]![along]);
      row.forEach((j) => used.add(j));
      rows.push(row);
    }
  }
  return rows;
}

/** The centre spacings of like shapes side by side (a row's pitch, in pixels), commonest first, with how many vote for each (three or more). */
export function pitchPx(list: Shape[]): { px: number; votes: number }[] {
  const votes = new Map<number, number>();
  for (const a of list) {
    let best = Infinity;
    for (const b of list) {
      if (a === b || Math.abs(bw(a) - bw(b)) > 0.2 * bw(a) + 1 || Math.abs(bh(a) - bh(b)) > 0.2 * bh(a) + 1) continue;
      const dx = Math.abs(cx(a) - cx(b)), dy = Math.abs(cy(a) - cy(b));
      if (dy < 0.25 * bh(a)) best = Math.min(best, dx);
      else if (dx < 0.25 * bw(a)) best = Math.min(best, dy);
    }
    if (best < Infinity && best > 0) { const k = Math.round(best); votes.set(k, (votes.get(k) ?? 0) + 1); }
  }
  // Votes a pixel either side count too (a spacing measured 20.6 or 21.2)
  return [...votes.keys()].map((k) => ({ px: k, votes: (votes.get(k - 1) ?? 0) + votes.get(k)! + (votes.get(k + 1) ?? 0) })).filter((c) => c.votes >= 3).sort((a, b) => b.votes - a.votes);
}

export interface Measured {
  read: PackageRead; moved: number; total: number; scale: number;
  /** Measured from the drawing's own lines (exact), not only its ink. */
  vector: boolean;
  /** Where the drawing isn't to scale (pads drawn another size than their dimensions say). */
  notes: string[];
  /** Where the read's (0, 0) is in the picture measured (pixels; y down), and the picture's size: for drawing the pads over it. */
  origin: { x: number; y: number }; picture: { width: number; height: number };
}

/**
 * Shapes' boxes on the drawing's own lines: a pad's outline is drawn on its edges, so its box is
 * where its outermost straight lines run (the ink adds half a stroke each side); a round pad's, where
 * its curve's points reach. Shapes no line explains keep their ink box.
 */
export function onLines(found: Shape[], segs: Seg[]): { shapes: Shape[]; refined: number } {
  let refined = 0;
  // Segments by the shapes they touch (a grid of 64 px cells)
  const cell = 64, grid = new Map<string, Seg[]>();
  for (const sg of segs) {
    const x0 = Math.floor(Math.min(sg.a.x, sg.b.x) / cell), x1 = Math.floor(Math.max(sg.a.x, sg.b.x) / cell);
    const y0 = Math.floor(Math.min(sg.a.y, sg.b.y) / cell), y1 = Math.floor(Math.max(sg.a.y, sg.b.y) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue;
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) { const k = `${i},${j}`; const l = grid.get(k); if (l) l.push(sg); else grid.set(k, [sg]); }
  }
  const out = found.map((b) => {
    const seen = new Set<Seg>();
    for (let i = Math.floor((b.x0 - 2) / cell); i <= Math.floor((b.x1 + 2) / cell); i++) for (let j = Math.floor((b.y0 - 2) / cell); j <= Math.floor((b.y1 + 2) / cell); j++) for (const sg of grid.get(`${i},${j}`) ?? []) seen.add(sg);
    const w = b.x1 - b.x0, h = b.y1 - b.y0, m = 2;
    // Straight edges: horizontal lines across most of the box near its top and bottom, vertical near its sides
    let top = Infinity, bot = -Infinity, left = Infinity, right = -Infinity;
    const lo = (u: number, v: number) => Math.min(u, v), hi = (u: number, v: number) => Math.max(u, v);
    for (const sg of seen) {
      const dx = Math.abs(sg.a.x - sg.b.x), dy = Math.abs(sg.a.y - sg.b.y);
      if (dy < 0.6 && dx > 0.5 * w * 0.5) {
        const y = (sg.a.y + sg.b.y) / 2, cover = hi(0, lo(hi(sg.a.x, sg.b.x), b.x1) - hi(lo(sg.a.x, sg.b.x), b.x0));
        if (cover < 0.3 * w) continue;
        if (y >= b.y0 - m && y <= b.y0 + 0.3 * h) top = Math.min(top, y);
        if (y <= b.y1 + m && y >= b.y1 - 0.3 * h) bot = Math.max(bot, y);
      } else if (dx < 0.6 && dy > 0.5 * h * 0.5) {
        const x = (sg.a.x + sg.b.x) / 2, cover = hi(0, lo(hi(sg.a.y, sg.b.y), b.y1) - hi(lo(sg.a.y, sg.b.y), b.y0));
        if (cover < 0.3 * h) continue;
        if (x >= b.x0 - m && x <= b.x0 + 0.3 * w) left = Math.min(left, x);
        if (x <= b.x1 + m && x >= b.x1 - 0.3 * w) right = Math.max(right, x);
      }
    }
    if (top < bot && left < right) { refined++; return { ...b, x0: left, x1: right, y0: top, y1: bot }; }
    // Round ends (a circle, a slot's or an oval's): the extremes of the lines wholly inside the box (its outline's pieces, hatching
    // ending on it; not a line drawn up to it from outside), across the middle (a leader's arrow at 45° doesn't count), for the
    // sides no straight edge gave
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = 0;
    const within = (p: { x: number; y: number }) => p.x >= b.x0 - m && p.x <= b.x1 + m && p.y >= b.y0 - m && p.y <= b.y1 + m;
    const mx = (left < right ? (left + right) / 2 : (b.x0 + b.x1) / 2), my = (top < bot ? (top + bot) / 2 : (b.y0 + b.y1) / 2);
    for (const sg of seen) {
      if (!within(sg.a) || !within(sg.b)) continue;
      for (const p of [sg.a, sg.b]) {
        if (Math.abs(p.y - my) < 0.3 * h) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); }
        if (Math.abs(p.x - mx) < 0.3 * w) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
        n++;
      }
    }
    const xs = left < right ? [left, right] : n >= 8 && x1 - x0 > 0.6 * w ? [x0, x1] : null;
    const ys = top < bot ? [top, bot] : n >= 8 && y1 - y0 > 0.6 * h ? [y0, y1] : null;
    if (xs && ys) { refined++; return { ...b, x0: xs[0]!, x1: xs[1]!, y0: ys[0]!, y1: ys[1]! }; }
    return b;
  });
  return { shapes: out, refined };
}

/**
 * The read's land pattern measured from a picture of it: null when the picture gives no scale
 * (no row of like pads at the read's pitch, or their size far from the read's).
 */
export function measureLand(read: PackageRead, img: Grey, opts: { segs?: Seg[]; found?: Shape[]; scale?: number } = {}): Measured | null {
  const land = read.land;
  const rows = rowsOf(land);
  if (!land.length || !rows.length) return null;
  let found = opts.found, vector = false;
  if (!found) {
    found = shapes(img);
    // The drawing's own lines, when there are some: exact edges
    if (opts.segs?.length) { const r = onLines(found, opts.segs); found = r.shapes; vector = r.refined > 0; }
  } else vector = !!opts.segs?.length;
  // The scale: the shapes like the first row's pads, at the read's pitch between their centres
  const pitchMm = (() => { const r = rows[0]!, a = land[r[0]!]!, b = land[r[1]!]!; return Math.hypot(b.x - a.x, b.y - a.y); })();
  const pad0 = land[rows[0]![0]!]!;
  if (!(pitchMm > 0)) return null;
  const likeAt = (sc: number) => found.filter((b) => Math.abs(bw(b) / sc - pad0.w) < pad0.w / 3 && Math.abs(bh(b) / sc - pad0.h) < pad0.h / 3).length;
  if (opts.scale) return placeAt(read, img, found, opts.scale, rows, vector)?.m ?? null;
  // Of the spacings like shapes repeat at (pads', and letters' of text too) whose shapes are the row's pads' size at that scale and
  // the pattern fits the picture, the one that places most of the read's pads; as many, one its placed row bears out (its shapes'
  // spacing gives the same scale), then the larger (letters are smaller than pads)
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of land) { x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); }
  const room = 1.5 * Math.hypot(img.width, img.height), extent = Math.hypot(x1 - x0, y1 - y0);
  let best: (Placed & { s: number; sure: boolean }) | null = null;
  const cands = pitchPx(found).slice(0, 16).map((c) => c.px / pitchMm).filter((sc) => extent * sc <= room && likeAt(sc) >= 3).slice(0, 6);
  for (const sc of cands) {
    let a = placeAt(read, img, found, sc, rows, vector), at = sc;
    // The scale again, from the longest row placed (its shapes' spacing against the read's pitch): once
    if (a && a.fit > 0 && Math.abs(a.fit - sc) / sc < 0.12 && Math.abs(a.fit - sc) / sc > 0.001) {
      const again = placeAt(read, img, found, a.fit, rows, vector);
      if (again && again.score >= a.score) { a = again; at = a.fit; }
    }
    const sure = !!a && a.fit > 0 && Math.abs(a.fit - at) / at < 0.03;
    if (a && (!best || a.score > best.score || (a.score === best.score && (sure > best.sure || (sure === best.sure && at > best.s))))) best = { ...a, s: at, sure };
  }
  return best?.m ?? null;
}

interface Placed { m: Measured; score: number; fit: number }

/** The read's pads placed on the shapes at a scale: what it comes to, how many pads found a shape, and the scale its longest row gives. */
function placeAt(read: PackageRead, img: Grey, found: Shape[], s: number, rows: number[][], vector: boolean): Placed | null {
  const land = read.land;
  const pitchMm = (() => { const r = rows[0]!, a = land[r[0]!]!, b = land[r[1]!]!; return Math.hypot(b.x - a.x, b.y - a.y); })();
  const px = s * pitchMm;
  const toPx = (p: { x: number; y: number }, t: { x: number; y: number }) => ({ x: p.x * s + t.x, y: -p.y * s + t.y });
  // The shape nearest a point that could be this pad (its size within a third, or 0.08 mm), within tol pixels
  const near = (p: { x: number; y: number }, pad: LandPad, tol: number, taken?: Set<number>) => {
    let best = -1, d = Infinity;
    found.forEach((b, k) => {
      if (taken?.has(k) || Math.abs(bw(b) / s - pad.w) > Math.max(0.35 * pad.w, 0.08) || Math.abs(bh(b) / s - pad.h) > Math.max(0.35 * pad.h, 0.08)) return;
      const e = Math.hypot(cx(b) - p.x, cy(b) - p.y);
      if (e < d && e <= tol) { d = e; best = k; }
    });
    return best;
  };
  const out = land.map((p) => ({ ...p }));
  const placed = new Set<number>();
  const tolRow = 0.3 * px;
  // Each row's ways onto the drawing: the shifts that put at least half its pads on like shapes, best first
  type Way = { t: { x: number; y: number }; hits: Map<number, number>; across: number };
  const alongOf = (row: number[]) => (Math.abs(land[row[1]!]!.x - land[row[0]!]!.x) >= Math.abs(land[row[1]!]!.y - land[row[0]!]!.y) ? 'x' : 'y');
  const ways: Way[][] = rows.map((row) => {
    const seen = new Map<string, Way>();
    const along = alongOf(row);
    for (let k = 0; k < found.length; k++) {
      for (const j0 of row) {
        if (near({ x: cx(found[k]!), y: cy(found[k]!) }, land[j0]!, 1) !== k) continue;
        const t = { x: cx(found[k]!) - land[j0]!.x * s, y: cy(found[k]!) + land[j0]!.y * s };
        const hits = new Map<number, number>();
        for (const j of row) { const m = near(toPx(land[j]!, t), land[j]!, tolRow); if (m >= 0 && ![...hits.values()].includes(m)) hits.set(j, m); }
        if (hits.size < Math.max(2, Math.ceil(row.length / 2))) continue;
        // Which pad on which shape (the same shapes a pitch along are another way)
        const key = [...hits].map(([j, m]) => `${j}:${m}`).sort().join(',');
        const across = median([...hits.values()].map((m) => (along === 'x' ? -cy(found[m]!) : cx(found[m]!)) / s));
        if (!seen.has(key) || seen.get(key)!.hits.size < hits.size) seen.set(key, { t, hits, across });
      }
    }
    // The best few on each line of shapes across the drawing (a long row of like shapes elsewhere mustn't crowd out the row's own)
    const bands = new Map<number, Way[]>();
    for (const w of [...seen.values()].sort((x, y) => y.hits.size - x.hits.size)) {
      const k = Math.round((w.across * s) / (0.5 * px)), l = bands.get(k);
      if (!l) bands.set(k, [w]); else if (l.length < 3) l.push(w);
    }
    return [...bands.values()].slice(0, Math.max(8, rows.length + 2)).flat();
  });
  // The shift the rows agree on: the rows placed one way only (more pads than any other way) say it; else the one most of the ways
  // have (a ball grid's rows all have it). Among ways placing as many pads (a row's end pads lost in other lines: a pitch along
  // places as many), the nearer it first
  const sure = ways.map((l) => [...l].sort((x, y) => y.hits.size - x.hits.size)).filter((l) => l[0] && (!l[1] || l[0].hits.size > l[1].hits.size)).map((l) => l[0]!.t);
  let T = { x: median(sure.map((t) => t.x)), y: median(sure.map((t) => t.y)) };
  if (!sure.length) {
    const votes = new Map<string, { t: { x: number; y: number }; n: number }>();
    for (const w of ways.flat()) {
      const k = `${Math.round(w.t.x / (0.5 * px))},${Math.round(w.t.y / (0.5 * px))}`, v = votes.get(k);
      if (v) v.n += w.hits.size; else votes.set(k, { t: w.t, n: w.hits.size });
    }
    T = [...votes.values()].reduce<{ t: { x: number; y: number }; n: number } | null>((m, v) => (!m || v.n > m.n ? v : m), null)?.t ?? { x: 0, y: 0 };
  }
  for (const list of ways) list.sort((x, y) => y.hits.size - x.hits.size || Math.hypot(x.t.x - T.x, x.t.y - T.y) - Math.hypot(y.t.x - T.x, y.t.y - T.y));
  // The most the rows from r on can place (a branch that can't beat the best so far isn't followed)
  const rest = rows.map((_, r) => ways.slice(r).reduce((a, l) => a + (l[0]?.hits.size ?? 0), 0));
  // The rows' ways together: no shape twice, and rows in the order the read has them across the drawing; most pads placed
  let best: (Way | null)[] = rows.map(() => null), bestScore = 0;
  const pick: (Way | null)[] = [];
  const acrossRead = (r: number) => { const p = land[rows[r]![0]!]!; return alongOf(rows[r]!) === 'x' ? p.y : p.x; };
  let steps = 0;
  const walk = (r: number, used: Set<number>, score: number) => {
    if (r === rows.length) { if (score > bestScore) { bestScore = score; best = [...pick]; } return; }
    // Many rows (a ball grid): the best ways first, as far as time allows
    if (score + rest[r]! <= bestScore || ++steps > 200_000) return;
    for (const w of [...ways[r]!, null]) {
      if (w) {
        if ([...w.hits.values()].some((m) => used.has(m))) continue;
        const clash = pick.some((o, q) => o && alongOf(rows[q]!) === alongOf(rows[r]!) && Math.abs(acrossRead(q) - acrossRead(r)) > 0.05
          && Math.sign(acrossRead(q) - acrossRead(r)) !== Math.sign(o.across - w.across));
        if (clash) continue;
      }
      pick.push(w);
      walk(r + 1, w ? new Set([...used, ...w.hits.values()]) : used, score + (w?.hits.size ?? 0));
      pick.pop();
    }
  };
  walk(0, new Set(), 0);
  // The scale its longest row placed gives (its shapes' spacing against the read's pitch)
  let fit = 0;
  const lr = best.reduce((k, w, i) => (w && (k < 0 || w.hits.size > best[k]!.hits.size) ? i : k), -1);
  if (lr >= 0 && best[lr]!.hits.size >= 3) {
    const along = alongOf(rows[lr]!), j0 = rows[lr]![0]!;
    const pts = [...best[lr]!.hits].map(([j, m]) => [along === 'x' ? land[j]!.x - land[j0]!.x : land[j]!.y - land[j0]!.y, along === 'x' ? cx(found[m]!) : -cy(found[m]!)] as const);
    const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0), sxy = pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
    fit = sxx > 0 ? Math.abs(sxy / sxx) : 0;
  }
  const shifts: { x: number; y: number }[] = [];
  const taken = new Set<number>();
  const notes: string[] = [];
  let score = 0;
  rows.forEach((row, r) => {
    const w = best[r];
    if (!w) return;
    const along = alongOf(row), pads = row.map((j) => land[j]!);
    // The read's sizes (from the dimensions) unless the drawing's differ by more than 40 % (a drawn outline adds its own width)
    const sh = [...w.hits.values()].map((m) => found[m]!);
    const mw = median(sh.map((b) => bw(b) / s)), mh = median(sh.map((b) => bh(b) / s));
    const pw = Math.abs(mw - pads[0]!.w) <= 0.4 * pads[0]!.w ? pads[0]!.w : round(mw, 0.01), ph = Math.abs(mh - pads[0]!.h) <= 0.4 * pads[0]!.h ? pads[0]!.h : round(mh, 0.01);
    // Measured on the lines, a size off its dimension by more than 4 %: the drawing isn't to scale there (the place is the drawing's)
    if (vector && (Math.abs(mw - pw) > 0.04 * pw + 0.005 || Math.abs(mh - ph) > 0.04 * ph + 0.005)) {
      notes.push(`${pads[0]!.name}…${pads.at(-1)!.name} drawn ${round(mw, 0.01)} × ${round(mh, 0.01)} mm, dimensioned ${pw} × ${ph}: the drawing isn't to scale there — check the row's place against its dimensions`);
    }
    // The row's line where its shapes are, its pads stepping by the read's pitch from where the shapes start them
    const offs = (j: number) => (along === 'x' ? land[j]!.x - land[row[0]!]!.x : land[j]!.y - land[row[0]!]!.y);
    const start = median([...w.hits].map(([j, m]) => (along === 'x' ? cx(found[m]!) : -cy(found[m]!)) / s - offs(j)));
    for (const j of row) {
      const p = out[j]!;
      if (along === 'x') { p.x = start + offs(j); p.y = w.across; } else { p.y = start + offs(j); p.x = w.across; }
      p.w = pw; p.h = ph;
      placed.add(j);
    }
    w.hits.forEach((m) => taken.add(m));
    score += w.hits.size;
    shifts.push(w.t);
  });
  if (!placed.size) return null;
  // The rest: single pads on the nearest like shape where the rows' shift puts them
  const t = { x: median(shifts.map((v) => v.x)), y: median(shifts.map((v) => v.y)) };
  land.forEach((p, j) => {
    if (placed.has(j)) return;
    const at = toPx(p, t);
    const m = near(at, p, Math.max(0.6 * px, 0.6 * Math.max(p.w, p.h) * s), taken);
    const q = out[j]!;
    if (m >= 0) {
      const b = found[m]!;
      q.x = cx(b) / s; q.y = -cy(b) / s;
      const w = bw(b) / s, h = bh(b) / s;
      if (Math.abs(w - p.w) > 0.4 * p.w) q.w = round(w, 0.01);
      if (Math.abs(h - p.h) > 0.4 * p.h) q.h = round(h, 0.01);
      taken.add(m); placed.add(j); score++;
    } else { q.x = at.x / s; q.y = -at.y / s; }
  });
  // All in the drawing's frame (unplaced pads where the rows' shift puts them), then centred on the pads' middle
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of out) { x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); }
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  for (const p of out) { p.x = round(p.x - mx, 0.005); p.y = round(p.y - my, 0.005); }
  const o = read.outline;
  return { score, fit, m: {
    read: { ...read, land: out, notes: [read.notes, ...notes].filter(Boolean).join('\n'), outline: o ? { ...o, x: round((o.x * s + t.x) / s - mx, 0.005), y: round(-(-o.y * s + t.y) / s - my, 0.005) } : null },
    moved: placed.size, total: land.length, scale: s, vector, notes,
    origin: { x: mx * s, y: -my * s }, picture: { width: img.width, height: img.height },
  } };
}

function median(v: number[]): number { const a = [...v].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2; }
function round(v: number, step: number): number { return +(Math.round(v / step) * step).toFixed(4); }
