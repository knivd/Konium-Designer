/**
 * What EasyEDA's documents share: Standard's `~`-separated shape records (LIB sub-shapes after
 * `#@$`, schematic pins and flags in `^^` segments), backtick key/value lists, the SVG paths its
 * arcs, regions, pours and graphics keep their geometry in, HTML-entity text; Pro's line records.
 * EasyEDA Standard's unit is 10 mil (Y down, as SVG has it).
 */
import { charOf } from '../codePoint';
import type { Vec2 } from '../../core/geom';

export const num = (s: string | number | undefined | null, def = 0): number => {
  if (typeof s === 'number') return Number.isFinite(s) ? s : def;
  const v = s === undefined || s === null || s === '' ? NaN : Number(s);
  return Number.isFinite(v) ? v : def;
};
/** A record's fields (missing ones read as ''). */
export const fields = (rec: string): string[] => rec.split('~');
export const at = (f: string[], i: number): string => f[i] ?? '';

/** "key`value`key`value`" → a map. */
export function backtick(s: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = s.split('`');
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) out.set(parts[i]!, parts[i + 1] ?? '');
  return out;
}
export const toBacktick = (m: Iterable<[string, string]>): string => [...m].map(([k, v]) => `${k}\`${v.replace(/`/g, "'")}\``).join('');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
/** A text value: HTML entities decoded, "\n" a newline. */
export function textValue(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? charOf(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
/** Text as EasyEDA keeps it in a field: no '~' or '#@$' or '^^', entities for what would break it. */
export const fieldText = (s: string): string => s.replace(/&/g, '&amp;').replace(/~/g, '&#126;').replace(/\^/g, '&#94;').replace(/#@\$/g, '&#35;@$').replace(/\r?\n/g, '\\n').replace(/`/g, "'");

/* ── SVG paths ── */

export type PathSeg =
  | { kind: 'L'; a: Vec2; b: Vec2 }
  | { kind: 'A'; a: Vec2; b: Vec2; rx: number; ry: number; rot: number; large: boolean; sweep: boolean }
  | { kind: 'C'; a: Vec2; c1: Vec2; c2: Vec2; b: Vec2 };
export interface SubPath { start: Vec2; segs: PathSeg[]; closed: boolean }

/** An SVG path's subpaths (absolute; M L H V A C Q Z and their relative forms; numbers glued or comma-separated). */
export function parsePath(d: string): SubPath[] {
  const toks = d.match(/[MmLlHhVvAaCcQqSsTtZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: SubPath[] = [];
  let i = 0, cmd = '', cur: Vec2 = { x: 0, y: 0 }, sub: SubPath | null = null, lastC2: Vec2 | null = null;
  const n = () => Number(toks[i++]);
  const isNum = () => i < toks.length && /^[-+.\d]/.test(toks[i]!);
  const start = (p: Vec2) => { sub = { start: p, segs: [], closed: false }; out.push(sub); cur = p; };
  const seg = (s: PathSeg) => { if (!sub) start(s.a); sub!.segs.push(s); cur = s.b; };
  while (i < toks.length) {
    if (!isNum()) cmd = toks[i++]!;
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase() && cmd !== 'z';
    const C = cmd.toUpperCase();
    const pt = () => { const x = n(), y = n(); return rel ? { x: cur.x + x, y: cur.y + y } : { x, y }; };
    switch (C) {
      case 'M': { const p = pt(); start(p); cmd = rel ? 'l' : 'L'; lastC2 = null; break; }
      case 'L': { const p = pt(); seg({ kind: 'L', a: cur, b: p }); lastC2 = null; break; }
      case 'H': { const x = n(); seg({ kind: 'L', a: cur, b: { x: rel ? cur.x + x : x, y: cur.y } }); lastC2 = null; break; }
      case 'V': { const y = n(); seg({ kind: 'L', a: cur, b: { x: cur.x, y: rel ? cur.y + y : y } }); lastC2 = null; break; }
      case 'A': {
        const rx = n(), ry = n(), rot = n(), large = n() !== 0, sweep = n() !== 0, p = pt();
        seg({ kind: 'A', a: cur, b: p, rx: Math.abs(rx), ry: Math.abs(ry), rot, large, sweep }); lastC2 = null; break;
      }
      case 'C': { const c1 = pt(), c2 = pt(), p = pt(); seg({ kind: 'C', a: cur, c1, c2, b: p }); lastC2 = c2; break; }
      case 'S': { const c1 = lastC2 ? { x: 2 * cur.x - lastC2.x, y: 2 * cur.y - lastC2.y } : cur; const c2 = pt(), p = pt(); seg({ kind: 'C', a: cur, c1, c2, b: p }); lastC2 = c2; break; }
      case 'Q': { const q = pt(), p = pt(); const a = cur; seg({ kind: 'C', a, c1: { x: a.x + (2 / 3) * (q.x - a.x), y: a.y + (2 / 3) * (q.y - a.y) }, c2: { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) }, b: p }); lastC2 = null; break; }
      case 'T': { const p = pt(); seg({ kind: 'L', a: cur, b: p }); lastC2 = null; break; }
      case 'Z': {
        if (sub) { const s: SubPath = sub; if (Math.hypot(cur.x - s.start.x, cur.y - s.start.y) > 1e-9) seg({ kind: 'L', a: cur, b: s.start }); s.closed = true; cur = s.start; }
        sub = null; lastC2 = null; break;
      }
      default: i++;
    }
    if (C === 'Z' && isNum()) cmd = 'L';
  }
  return out;
}

/** An SVG arc's centre, radius and angles (in its own frame, Y down): SVG 1.1 F.6.5 with rx = ry. */
export function arcCentre(s: Extract<PathSeg, { kind: 'A' }>): { c: Vec2; r: number; a0: number; sweepDeg: number } {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, d = Math.hypot(dx, dy);
  let r = Math.max(s.rx, d / 2);
  const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
  const m = { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
  const nrm = d > 0 ? { x: -dy / d, y: dx / d } : { x: 0, y: 0 };
  const sign = s.large !== s.sweep ? 1 : -1;
  const c = { x: m.x + nrm.x * h * sign, y: m.y + nrm.y * h * sign };
  if (d === 0) r = s.rx;
  const ang = (p: Vec2) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
  const a0 = ang(s.a), a1 = ang(s.b);
  // sweep=1: increasing angle in the Y-down frame (clockwise on screen)
  let sw = s.sweep ? a1 - a0 : a0 - a1;
  sw = ((sw % 360) + 360) % 360;
  if (d === 0) sw = 360;
  return { c, r, a0, sweepDeg: s.sweep ? sw : -sw };
}

/** A subpath as points (arcs and curves stepped). */
export function flattenSub(sp: SubPath, step = 10): Vec2[] {
  const pts: Vec2[] = [sp.start];
  for (const s of sp.segs) {
    if (s.kind === 'L') pts.push(s.b);
    else if (s.kind === 'A') {
      const a = arcCentre(s);
      const k = Math.max(2, Math.ceil(Math.abs(a.sweepDeg) / step));
      for (let i = 1; i <= k; i++) { const t = ((a.a0 + (a.sweepDeg * i) / k) * Math.PI) / 180; pts.push(i === k ? s.b : { x: a.c.x + a.r * Math.cos(t), y: a.c.y + a.r * Math.sin(t) }); }
    } else {
      for (let i = 1; i <= 12; i++) {
        const t = i / 12, u = 1 - t;
        pts.push({ x: u * u * u * s.a.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.b.x, y: u * u * u * s.a.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.b.y });
      }
    }
  }
  if (pts.length > 2 && Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y) < 1e-6) pts.pop();
  return pts;
}

/** Points "x y x y …" (spaces or commas). */
export function pointList(s: string): Vec2[] {
  const v = (s.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
  const out: Vec2[] = [];
  for (let i = 0; i + 1 < v.length; i += 2) out.push({ x: v[i]!, y: v[i + 1]! });
  return out;
}

/** A number as EasyEDA writes it: at most four decimals, no trailing zeros. */
export const fmt = (v: number): string => { const r = Math.round(v * 10000) / 10000; return Object.is(r, -0) ? '0' : String(r); };

/** EasyEDA's object ids: gge and a number. */
export class Ids {
  private n = 1;
  constructor(private prefix = 'gge') {}
  next(): string { return `${this.prefix}${this.n++}`; }
}
