import { emptyBox, extend, type BBox, type Vec2 } from '../core/geom';
import { fromSymbol, isSymbolFamily } from './symbolFont';

/**
 * Renderer-agnostic display list. Editors build a Scene from the model; the GL renderer
 * draws it. Positions are stored relative to `origin` so float32 keeps full precision
 * on large boards.
 */

export const enum Kind { Capsule = 0, Arc = 1, Rect = 2, Tri = 3 }

/** Instance layout (floats): x0 y0 x1 y1 hw a b c kind | rgba8 → 40-byte stride. */
export const INSTANCE_FLOATS = 10;

export class PrimBatch {
  buf = new ArrayBuffer(4096 * 40);
  f32 = new Float32Array(this.buf);
  u32 = new Uint32Array(this.buf);
  count = 0;
  version = 0;
  /**
   * Where the blending changes, by instance: `min` runs darken what is beneath (per channel,
   * the darker wins), as Altium draws a schematic shape's Transparent fill. Empty: all normal.
   */
  runs: { start: number; min: boolean }[] = [];
  /** Instances pushed now go into a darkening run. */
  darken = false;

  private grow(): void {
    const nb = new ArrayBuffer(this.buf.byteLength * 2);
    new Uint8Array(nb).set(new Uint8Array(this.buf));
    this.buf = nb; this.f32 = new Float32Array(nb); this.u32 = new Uint32Array(nb);
  }

  push(kind: Kind, x0: number, y0: number, x1: number, y1: number, hw: number, a: number, b: number, c: number, rgba: number): void {
    if ((this.count + 1) * INSTANCE_FLOATS > this.f32.length) this.grow();
    if ((this.runs.at(-1)?.min ?? false) !== this.darken) this.runs.push({ start: this.count, min: this.darken });
    const o = this.count * INSTANCE_FLOATS;
    const f = this.f32;
    f[o] = x0; f[o + 1] = y0; f[o + 2] = x1; f[o + 3] = y1; f[o + 4] = hw; f[o + 5] = a; f[o + 6] = b; f[o + 7] = c; f[o + 8] = kind;
    this.u32[o + 9] = rgba;
    this.count++;
    this.version++;
  }
}

export class TriBatch {
  pos: number[] = [];
  col: number[] = [];
  version = 0;
  push(pts: Vec2[], idx: number[], rgba: number): void {
    for (const i of idx) { this.pos.push(pts[i]!.x, pts[i]!.y); this.col.push(rgba); }
    this.version++;
  }
  get count(): number { return this.col.length; }
}

export interface TextItem {
  x: number; y: number;      // relative to scene origin
  size: number;              // em height, world units
  rot: number;               // degrees CCW
  text: string;
  color: string;
  h: 0 | 1 | 2;              // left, centre, right
  v: 0 | 1 | 2;              // bottom, middle, top
  mirrored?: boolean;
  bold?: boolean;
  italic?: boolean;
  family?: string;
  /** Drawn only between these sizes on screen (pixels; clamped to the most), and only on an object at least objMinPx across (objSize, world units). */
  minPx?: number;
  maxPx?: number;
  objSize?: number;
  objMinPx?: number;
  /** Smaller than draftPx on screen (draftSize world units high): a box where the text would be, not the text (PCB › Display › Draft Thresholds). */
  draftPx?: number;
  draftSize?: number;
  /** 'cell': v=bottom/top refer to the font's cell (Windows GDI, as Altium schematics). Default baseline. */
  anchor?: 'baseline' | 'cell';
  /** Render Altium overlines: a character followed by '\' gets a bar over it. */
  overline?: boolean;
  /** Labels (net names on pads): never mirrored, turned to read left-to-right or bottom-to-top, whatever the view. */
  readable?: boolean;
  /** Text frame: lay the text out inside this box (scene-relative, world units) from its top. */
  frame?: { minX: number; minY: number; maxX: number; maxY: number; margin: number; wrap: boolean; clip: boolean };
}

/** A picture (schematic images): scene-relative box, world units; drawn on the text layer. */
export interface ImageItem { minX: number; minY: number; maxX: number; maxY: number; src: CanvasImageSource }

export interface DrawGroup {
  key: string;
  z: number;
  visible: boolean;
  alpha: number;
  tris: TriBatch;
  prims: PrimBatch;
  texts: TextItem[];
  images: ImageItem[];
  /** Drawn through a pattern (a net's colour override, violations, locked objects): see Pattern. */
  pattern?: Pattern;
}

/**
 * A pattern a group is drawn through, anchored to the board: `id` the pattern near (cells
 * `cell` world units across), and once a cell is under 3 pixels on screen, `out` instead (cells
 * grown by powers of two to stay visible). Ids: 0 nothing, 1 checkerboard, 2 stripes, 3 large
 * checkerboard, 4 diagonal hatching, 5 cross-hatching, 6 sparse hatching (locked objects), 99 solid.
 */
export interface Pattern { id: number; cell: number; out: number }
export const PAT = { none: 0, checker: 1, stripe: 2, largeChecker: 3, hatch: 4, crossHatch: 5, locked: 6, solid: 99 } as const;

/** 0xRRGGBB + alpha → little-endian RGBA8 as stored in the instance buffer. */
export function rgba(rgb: number, a = 1): number {
  return (((Math.round(a * 255) & 0xff) << 24) | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff)) >>> 0;
}
export const css = (rgb: number, a = 1): string =>
  a >= 1 ? `#${rgb.toString(16).padStart(6, '0')}` : `rgba(${rgb >> 16},${(rgb >> 8) & 255},${rgb & 255},${a})`;

export class Scene {
  readonly groups = new Map<string, DrawGroup>();
  bounds: BBox = emptyBox();
  background = 0x000000;
  /** A gradient down the workspace, from `background` at the top to this at the bottom. */
  backgroundEnd?: number;
  /**
   * Draw strictly in the order things are added (schematics: record order is z-order, so a
   * part's filled body never hides a polygon drawn after it). Otherwise polygon fills go under
   * everything else in their group (boards: pours and regions beneath tracks).
   */
  inOrder = false;
  constructor(readonly origin: Vec2) {}

  group(key: string, z = 0): DrawGroup {
    let g = this.groups.get(key);
    if (!g) {
      g = { key, z, visible: true, alpha: 1, tris: new TriBatch(), prims: new PrimBatch(), texts: [], images: [] };
      this.groups.set(key, g);
    }
    return g;
  }

  ordered(): DrawGroup[] { return [...this.groups.values()].sort((a, b) => a.z - b.z); }

  private rel(p: Vec2): Vec2 { return { x: p.x - this.origin.x, y: p.y - this.origin.y }; }
  private grow(p: Vec2, r: number): void { extend(this.bounds, p.x, p.y, r); }

  /** Round-capped segment. minPx keeps hairlines visible at any zoom. */
  segment(g: DrawGroup, a: Vec2, b: Vec2, width: number, rgbaV: number, minPx = 0.6): void {
    const ra = this.rel(a), rb = this.rel(b);
    g.prims.push(Kind.Capsule, ra.x, ra.y, rb.x, rb.y, width / 2, 0, 0, minPx, rgbaV);
    this.grow(a, width / 2); this.grow(b, width / 2);
  }

  polyline(g: DrawGroup, pts: Vec2[], width: number, rgbaV: number, closed = false, minPx = 0.6): void {
    for (let i = 1; i < pts.length; i++) this.segment(g, pts[i - 1]!, pts[i]!, width, rgbaV, minPx);
    if (closed && pts.length > 2) this.segment(g, pts.at(-1)!, pts[0]!, width, rgbaV, minPx);
  }

  circle(g: DrawGroup, c: Vec2, r: number, rgbaV: number): void {
    const rc = this.rel(c);
    g.prims.push(Kind.Capsule, rc.x, rc.y, rc.x, rc.y, r, 0, 0, 0.5, rgbaV);
    this.grow(c, r);
  }

  /** CCW arc from startDeg to endDeg (sweep ≤ 360). */
  arc(g: DrawGroup, c: Vec2, r: number, startDeg: number, endDeg: number, width: number, rgbaV: number, minPx = 0.6): void {
    const rc = this.rel(c);
    let sweep = endDeg - startDeg;
    sweep = ((sweep % 360) + 360) % 360;
    if (sweep === 0) sweep = 360;
    g.prims.push(Kind.Arc, rc.x, rc.y, r, 0, width / 2, (startDeg * Math.PI) / 180, (sweep * Math.PI) / 180, minPx, rgbaV);
    this.grow(c, r + width / 2);
  }

  /** Filled (optionally rounded, rotated) rectangle around a centre. */
  rect(g: DrawGroup, c: Vec2, w: number, h: number, rotDeg: number, cornerR: number, rgbaV: number): void {
    const rc = this.rel(c);
    g.prims.push(Kind.Rect, rc.x, rc.y, w / 2, h / 2, 0, (rotDeg * Math.PI) / 180, 0, Math.min(cornerR, w / 2, h / 2), rgbaV);
    const r = Math.hypot(w, h) / 2;
    this.grow(c, r);
  }

  rectFromCorners(g: DrawGroup, a: Vec2, b: Vec2, rgbaV: number, cornerR = 0): void {
    this.rect(g, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, Math.abs(b.x - a.x), Math.abs(b.y - a.y), 0, cornerR, rgbaV);
  }

  /** Filled polygon (simple). idx from triangulate(). */
  polygon(g: DrawGroup, pts: Vec2[], idx: number[], rgbaV: number): void {
    if (this.inOrder) {
      const r = pts.map((p) => this.rel(p));
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const a = r[idx[i]!]!, b = r[idx[i + 1]!]!, c = r[idx[i + 2]!]!;
        g.prims.push(Kind.Tri, a.x, a.y, b.x, b.y, c.x, c.y, 0, 0, rgbaV);
      }
    } else g.tris.push(pts.map((p) => this.rel(p)), idx, rgbaV);
    for (const p of pts) this.grow(p, 0);
  }

  /** Fills drawn inside `fn` darken what is beneath instead of covering it (Altium's Transparent). */
  darken(g: DrawGroup, fn: () => void): void {
    const was = g.prims.darken;
    g.prims.darken = true;
    try { fn(); } finally { g.prims.darken = was; }
  }

  image(g: DrawGroup, a: Vec2, b: Vec2, src: CanvasImageSource): void {
    const ra = this.rel(a), rb = this.rel(b);
    g.images.push({ minX: Math.min(ra.x, rb.x), minY: Math.min(ra.y, rb.y), maxX: Math.max(ra.x, rb.x), maxY: Math.max(ra.y, rb.y), src });
    this.grow(a, 0); this.grow(b, 0);
  }

  text(g: DrawGroup, at: Vec2, t: Omit<TextItem, 'x' | 'y'>): void {
    // Symbol-font text: the Greek and math characters Windows shows for its letters (Ω for W)
    if (isSymbolFamily(t.family)) t = { ...t, text: fromSymbol(t.text), family: '"Times New Roman", serif' };
    const r = this.rel(at);
    const o = this.origin;
    const frame = t.frame && { ...t.frame, minX: t.frame.minX - o.x, maxX: t.frame.maxX - o.x, minY: t.frame.minY - o.y, maxY: t.frame.maxY - o.y };
    g.texts.push({ ...t, frame, x: r.x, y: r.y });
    this.grow(at, t.size * Math.max(1, t.text.length * 0.6));
  }
}
