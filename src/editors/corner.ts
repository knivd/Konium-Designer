import type { Vec2 } from '../core/geom';

/**
 * Corner modes for wires, lines and tracks. Shift+Space cycles the mode, Space flips which leg
 * comes first — the same muscle memory as Altium's placement modes. Schematic wires and shapes
 * have 90°, 45° and any angle; tracks and lines AD's five: 45°, 45° with arc, 90°, 90° with arc and
 * any angle, the arc modes rounding each corner with an arc that , and . shrink and grow (Shift
 * faster).
 */
export type CornerMode = '90' | '45' | 'any' | '45arc' | '90arc';
export const CORNER_MODES: CornerMode[] = ['90', '45', 'any'];
export const PCB_CORNER_MODES: CornerMode[] = ['45', '45arc', '90', '90arc', 'any'];

export const isArcMode = (m: CornerMode) => m === '45arc' || m === '90arc';
/** The mode an arc mode rounds (its corners before the arcs). */
export const baseMode = (m: CornerMode): '90' | '45' | 'any' => (m === '45arc' ? '45' : m === '90arc' ? '90' : m);

/** Points from s to c (exclusive of s), inserting at most one corner. */
export function cornerPath(s: Vec2, c: Vec2, mode: CornerMode, flip: boolean): Vec2[] {
  const m = baseMode(mode);
  const dx = c.x - s.x, dy = c.y - s.y;
  if (m === 'any' || dx === 0 || dy === 0) return [c];
  if (m === '90') return [flip ? { x: s.x, y: c.y } : { x: c.x, y: s.y }, c];
  const adx = Math.abs(dx), ady = Math.abs(dy), sx = Math.sign(dx), sy = Math.sign(dy);
  const d = Math.min(adx, ady);
  if (adx === ady) return [c];
  // flip=false: straight leg first, then 45°; flip=true: 45° first, then straight
  const k = flip
    ? { x: s.x + sx * d, y: s.y + sy * d }
    : adx > ady ? { x: s.x + sx * (adx - d), y: s.y } : { x: s.x, y: s.y + sy * (ady - d) };
  return [k, c];
}

export const cornerLabel = (m: CornerMode, flip: boolean): string =>
  m === 'any' ? 'any angle' : `${baseMode(m)}°${isArcMode(m) ? ' with arc' : ''} ${flip ? 'end' : 'start'}`;

/**
 * The arc radius of the arc corner modes, kept between tools and placements as AD keeps it: 0 until
 * first changed (then four track widths [est]).
 */
export const cornerArc = { r: 0 };
export const arcRadius = (width: number) => cornerArc.r || 4 * Math.max(width, 2540);

/** , and . shrink and grow the arc by a tenth, < and > (Shift) by a third; null for other keys. */
export function arcKey(combo: string, width: number): boolean {
  const f = combo === ',' ? 1 / 1.1 : combo === '.' ? 1.1 : combo === '<' ? 1 / 1.35 : combo === '>' ? 1.35 : 0;
  if (!f) return false;
  cornerArc.r = Math.max(Math.max(width, 2540) / 2, Math.min(100_000_000, Math.round(arcRadius(width) * f)));
  return true;
}

/** An arc (anticlockwise from start to end, degrees) as short straight pieces, for drawing it while it is placed. */
export function arcSegments(c: Vec2, r: number, start: number, end: number): [Vec2, Vec2][] {
  const sweep = ((end - start) % 360 + 360) % 360 || 360;
  const n = Math.max(4, Math.ceil(sweep / 6));
  const at = (k: number) => { const t = ((start + (sweep * k) / n) * Math.PI) / 180; return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }; };
  return Array.from({ length: n }, (_, k) => [at(k), at(k + 1)] as [Vec2, Vec2]);
}
