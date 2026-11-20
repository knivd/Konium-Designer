import type { BBox, Vec2 } from '../core/geom';

/**
 * World is Y-up (as Altium stores it); screen is Y-down. All screen values are in CSS px;
 * the renderer multiplies by devicePixelRatio itself.
 */
export class Camera {
  cx = 0;
  cy = 0;
  scale = 1e-4;     // CSS px per world unit
  width = 1;        // CSS px
  height = 1;
  flipX = false;    // view from bottom

  static readonly MIN_SCALE = 1e-8;
  static readonly MAX_SCALE = 1;

  toScreen(p: Vec2): Vec2 {
    const sx = (p.x - this.cx) * this.scale;
    return { x: this.width / 2 + (this.flipX ? -sx : sx), y: this.height / 2 - (p.y - this.cy) * this.scale };
  }

  toWorld(s: Vec2): Vec2 {
    const dx = (s.x - this.width / 2) / this.scale;
    return { x: this.cx + (this.flipX ? -dx : dx), y: this.cy - (s.y - this.height / 2) / this.scale };
  }

  /** Zoom by factor keeping the world point under screen point s fixed. */
  zoomAt(s: Vec2, factor: number): void {
    const before = this.toWorld(s);
    this.scale = Math.min(Camera.MAX_SCALE, Math.max(Camera.MIN_SCALE, this.scale * factor));
    const after = this.toWorld(s);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
  }

  panScreen(dx: number, dy: number): void {
    this.cx -= (this.flipX ? -dx : dx) / this.scale;
    this.cy += dy / this.scale;
  }

  centreOn(p: Vec2): void { this.cx = p.x; this.cy = p.y; }

  fit(b: BBox, margin = 0.08): void {
    if (!(b.minX <= b.maxX && b.minY <= b.maxY)) return;
    const w = Math.max(b.maxX - b.minX, 1), h = Math.max(b.maxY - b.minY, 1);
    this.scale = Math.min(this.width / (w * (1 + 2 * margin)), this.height / (h * (1 + 2 * margin)));
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
  }

  visible(): BBox {
    const a = this.toWorld({ x: 0, y: 0 }), b = this.toWorld({ x: this.width, y: this.height });
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  }
}
