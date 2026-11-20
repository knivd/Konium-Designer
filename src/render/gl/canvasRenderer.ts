/**
 * The editors' drawing where the browser has no WebGL 2 (it is off, or the graphics driver is on
 * the browser's block list, as on many Windows 7 computers): the same scene drawn with the 2D
 * canvas — round-capped segments, arcs, rounded and turned rectangles, triangles, the grid,
 * selection tints, Altium's darkening Transparent fills — slower on big boards, but the same picture.
 */
import { INSTANCE_FLOATS, type DrawGroup, type Scene } from '../Scene';
import type { Camera } from '../Camera';
import type { GridSpec, Tint } from './Renderer';

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser can draw neither with WebGL 2 nor with a 2D canvas');
    this.ctx = ctx;
  }

  dispose(): void { /* nothing held */ }

  draw(scene: Scene, cam: Camera, dpr: number, opts: { grid?: GridSpec | null; gridAbove?: string; tints?: Map<string, Tint>; overlay?: Scene } = {}): void {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = hex(scene.background);
    ctx.fillRect(0, 0, W, H);
    let gridDrawn = !opts.grid;
    if (!gridDrawn && opts.gridAbove === undefined) { this.drawGrid(opts.grid!, cam, scene, dpr); gridDrawn = true; }
    for (const g of scene.ordered()) {
      if (!gridDrawn && opts.gridAbove !== undefined && g.key !== opts.gridAbove && g.z > (scene.groups.get(opts.gridAbove)?.z ?? -Infinity)) { this.drawGrid(opts.grid!, cam, scene, dpr); gridDrawn = true; }
      if (g.visible) this.drawGroup(g, cam, scene, dpr, opts.tints?.get(g.key));
    }
    if (!gridDrawn) this.drawGrid(opts.grid!, cam, scene, dpr);
    if (opts.overlay) for (const g of opts.overlay.ordered()) if (g.visible) this.drawGroup(g, cam, opts.overlay, dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** Scene-relative world units → device pixels (Y up, the view mirrored when seen from below). */
  private view(cam: Camera, scene: Scene, dpr: number): number {
    const s = cam.scale * dpr, f = cam.flipX ? -1 : 1, W = this.canvas.width, H = this.canvas.height;
    this.ctx.setTransform(f * s, 0, 0, -s, W / 2 - f * s * (cam.cx - scene.origin.x), H / 2 + s * (cam.cy - scene.origin.y));
    return s;
  }

  private drawGroup(g: DrawGroup, cam: Camera, scene: Scene, dpr: number, tint?: Tint): void {
    if (!g.prims.count && !g.tris.count) return;
    const ctx = this.ctx;
    const s = this.view(cam, scene, dpr);
    const colour = (v: number, darken: boolean): string => {
      let r = v & 255, gg = (v >>> 8) & 255, b = (v >>> 16) & 255;
      let a = ((v >>> 24) & 255) / 255 * g.alpha;
      if (tint) { const k = tint.amount; r += (((tint.rgb >> 16) & 255) - r) * k; gg += (((tint.rgb >> 8) & 255) - gg) * k; b += ((tint.rgb & 255) - b) * k; }
      // A darkening fill: white faded towards its colour, the darker of it and what is beneath kept
      if (darken) { r = 255 + (r - 255) * a; gg = 255 + (gg - 255) * a; b = 255 + (b - 255) * a; a = 1; }
      return `rgba(${Math.round(r)},${Math.round(gg)},${Math.round(b)},${Math.round(a * 1000) / 1000})`;
    };
    // Polygon fills: one path a colour (no seams between a fill's triangles)
    if (g.tris.count) {
      const pos = g.tris.pos, col = g.tris.col;
      let cur = -1;
      for (let i = 0; i + 2 < col.length; i += 3) {
        if (col[i] !== cur) { if (cur !== -1) ctx.fill(); cur = col[i]!; ctx.fillStyle = colour(cur, false); ctx.beginPath(); }
        ctx.moveTo(pos[2 * i]!, pos[2 * i + 1]!); ctx.lineTo(pos[2 * i + 2]!, pos[2 * i + 3]!); ctx.lineTo(pos[2 * i + 4]!, pos[2 * i + 5]!); ctx.closePath();
      }
      if (cur !== -1) ctx.fill();
    }
    if (!g.prims.count) return;
    const f = g.prims.f32, u = g.prims.u32, runs = g.prims.runs;
    const spans = runs.length ? [{ start: 0, min: false }, ...runs] : [{ start: 0, min: false }];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    spans.forEach((sp, k) => {
      const end = spans[k + 1]?.start ?? g.prims.count;
      ctx.globalCompositeOperation = sp.min ? 'darken' : 'source-over';
      // Runs of one colour and look drawn as one path
      let key = '', mode = 0;
      const flush = () => { if (mode === 1) ctx.stroke(); else if (mode === 2) ctx.fill(); mode = 0; key = ''; };
      for (let i = sp.start; i < end; i++) {
        const o = i * INSTANCE_FLOATS;
        const kind = Math.round(f[o + 8]!), c = colour(u[o + 9]!, sp.min);
        if (kind === 0) {
          const x0 = f[o]!, y0 = f[o + 1]!, x1 = f[o + 2]!, y1 = f[o + 3]!;
          const r = Math.max(f[o + 4]!, f[o + 7]! / s);
          if (x0 === x1 && y0 === y1) {
            const kk = `f${c}`;
            if (kk !== key) { flush(); key = kk; mode = 2; ctx.fillStyle = c; ctx.beginPath(); }
            ctx.moveTo(x0 + r, y0); ctx.arc(x0, y0, r, 0, Math.PI * 2);
          } else {
            const kk = `s${c}|${r}`;
            if (kk !== key) { flush(); key = kk; mode = 1; ctx.strokeStyle = c; ctx.lineWidth = 2 * r; ctx.beginPath(); }
            ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
          }
        } else if (kind === 1) {
          const cx = f[o]!, cy = f[o + 1]!, R = f[o + 2]!, r = Math.max(f[o + 4]!, f[o + 7]! / s), a0 = f[o + 5]!, sw = f[o + 6]!;
          const kk = `s${c}|${r}`;
          if (kk !== key) { flush(); key = kk; mode = 1; ctx.strokeStyle = c; ctx.lineWidth = 2 * r; ctx.beginPath(); }
          ctx.moveTo(cx + R * Math.cos(a0), cy + R * Math.sin(a0));
          ctx.arc(cx, cy, R, a0, a0 + Math.min(sw, Math.PI * 2 - 1e-6));
          if (sw >= Math.PI * 2 - 1e-4) ctx.closePath();
        } else if (kind === 3) {
          const kk = `f${c}`;
          if (kk !== key) { flush(); key = kk; mode = 2; ctx.fillStyle = c; ctx.beginPath(); }
          ctx.moveTo(f[o]!, f[o + 1]!); ctx.lineTo(f[o + 2]!, f[o + 3]!); ctx.lineTo(f[o + 4]!, f[o + 5]!); ctx.closePath();
        } else {
          // A rectangle about its centre, turned, its corners rounded
          const cx = f[o]!, cy = f[o + 1]!, hx = f[o + 2]!, hy = f[o + 3]!, rot = f[o + 5]!, cr = Math.max(0, Math.min(f[o + 7]!, hx, hy));
          const kk = `f${c}`;
          if (kk !== key) { flush(); key = kk; mode = 2; ctx.fillStyle = c; ctx.beginPath(); }
          const cs = Math.cos(rot), sn = Math.sin(rot);
          const P = (x: number, y: number): [number, number] => [cx + x * cs - y * sn, cy + x * sn + y * cs];
          if (cr <= 0) {
            const a = P(-hx, -hy), b = P(hx, -hy), d = P(hx, hy), e = P(-hx, hy);
            ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(d[0], d[1]); ctx.lineTo(e[0], e[1]); ctx.closePath();
          } else {
            const ix = hx - cr, iy = hy - cr;
            const corners: [number, number, number][] = [[ix, -iy, -Math.PI / 2], [ix, iy, 0], [-ix, iy, Math.PI / 2], [-ix, -iy, Math.PI]];
            const st = P(-ix, -hy);
            ctx.moveTo(st[0], st[1]);
            for (const [x, y, a] of corners) {
              const cc = P(x, y);
              ctx.arc(cc[0], cc[1], cr, a + rot, a + rot + Math.PI / 2);
            }
            ctx.closePath();
          }
        }
      }
      flush();
    });
    ctx.globalCompositeOperation = 'source-over';
  }

  /** The grid: lines or dots every step, fading out when too dense, every tenth the major colour. */
  private drawGrid(spec: GridSpec, cam: Camera, scene: Scene, dpr: number): void {
    const px = spec.size * cam.scale * dpr;
    const ctx = this.ctx;
    const vis = cam.visible();
    const fade = smooth(5, 14, px);
    const rgba = (c: [number, number, number, number], a: number) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
    const W = this.canvas.width, H = this.canvas.height, f = cam.flipX ? -1 : 1, s = cam.scale * dpr;
    const X = (x: number) => W / 2 + f * (x - cam.cx) * s, Y = (y: number) => H / 2 - (y - cam.cy) * s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const pass = (step: number, colour: string) => {
      // On the scene's own origin, as the GPU's grid is
      const ox = scene.origin.x, oy = scene.origin.y;
      const x0 = ox + Math.floor((vis.minX - ox) / step) * step, y0 = oy + Math.floor((vis.minY - oy) / step) * step;
      const nx = Math.ceil((vis.maxX - x0) / step) + 1, ny = Math.ceil((vis.maxY - y0) / step) + 1;
      if (nx * (spec.dots ? ny : 1) > 200_000) return;
      ctx.fillStyle = colour; ctx.strokeStyle = colour;
      if (spec.dots) {
        // The GPU's dot is a disc about 2 device pixels across, so a 2-pixel square
        const d = Math.max(1, Math.round(2 * dpr));
        ctx.beginPath();
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) ctx.rect(Math.round(X(x0 + i * step)) - d / 2, Math.round(Y(y0 + j * step)) - d / 2, d, d);
        ctx.fill();
      } else {
        ctx.lineWidth = Math.max(1, dpr * 0.75);
        ctx.beginPath();
        for (let i = 0; i < nx; i++) { const x = Math.round(X(x0 + i * step)) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
        for (let j = 0; j < ny; j++) { const y = Math.round(Y(y0 + j * step)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
        ctx.stroke();
      }
    };
    // As on the GPU: no grid at all (not even the major one) once the minor steps are under 5 pixels
    if (px < 5) return;
    pass(spec.size, rgba(spec.color, spec.color[3] * fade));
    pass(spec.size * 10, rgba(spec.major, spec.major[3]));
  }
}

const hex = (rgb: number) => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
