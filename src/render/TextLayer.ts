import type { Camera } from './Camera';
import type { ImageItem, Scene, TextItem } from './Scene';
import type { Vec2 } from '../core/geom';

/**
 * Text is drawn on a 2D canvas above the GL canvas. Good enough to read real documents;
 * PCB stroke fonts and exact TrueType metrics come later as a GPU glyph path.
 */
/** The SVG filter hard-edged text is drawn through: each pixel in or out (PCB › Display › Antialiased Text off). */
export const HARD_TEXT_FILTER = 'konium-hard-text';
function hardTextFilter(doc: Document): void {
  if (doc.getElementById(HARD_TEXT_FILTER)) return;
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
  svg.style.position = 'absolute';
  const NS = 'http://www.w3.org/2000/svg';
  const f = doc.createElementNS(NS, 'filter'), t = doc.createElementNS(NS, 'feComponentTransfer'), a = doc.createElementNS(NS, 'feFuncA');
  f.id = HARD_TEXT_FILTER;
  f.setAttribute('color-interpolation-filters', 'sRGB');
  a.setAttribute('type', 'discrete');
  a.setAttribute('tableValues', '0 1');
  t.append(a); f.append(t); svg.append(f);
  doc.body.append(svg);
}

export class TextLayer {
  private ctx: CanvasRenderingContext2D;
  /** Text drawn hard-edged, not smoothed. */
  hardText = false;
  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  drawScene(scene: Scene, cam: Camera, dpr: number, hidden?: (key: string) => boolean): void {
    const vis = cam.visible();
    const pad = (vis.maxX - vis.minX) * 0.1;
    for (const g of scene.ordered()) {
      if (!g.visible || hidden?.(g.key)) continue;
      for (const im of g.images) this.drawImage(im, scene, cam, dpr, g.alpha);
      for (const t of g.texts) {
        const wx = t.x + scene.origin.x, wy = t.y + scene.origin.y;
        // Out of view only when all of it is: a frame by its box, a text by as far as it can reach from
        // its anchor whichever way it runs (turned, aligned right, several lines)
        if (t.frame) {
          const f = t.frame, o = scene.origin;
          if (f.maxX + o.x < vis.minX || f.minX + o.x > vis.maxX || f.maxY + o.y < vis.minY || f.minY + o.y > vis.maxY) continue;
        } else {
          const r = t.size * (t.text.length + 2) + pad;
          if (wx + r < vis.minX || wx - r > vis.maxX || wy + r < vis.minY || wy - r > vis.maxY) continue;
        }
        this.drawText(t, { x: wx, y: wy }, cam, dpr, g.alpha);
      }
    }
  }

  private drawImage(im: ImageItem, scene: Scene, cam: Camera, dpr: number, alpha: number): void {
    const o = scene.origin;
    const a = cam.toScreen({ x: im.minX + o.x, y: im.maxY + o.y }), b = cam.toScreen({ x: im.maxX + o.x, y: im.minY + o.y });
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 1 || h < 1 || Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > this.canvas.width / dpr || Math.max(a.y, b.y) < 0 || Math.min(a.y, b.y) > this.canvas.height / dpr) return;
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingQuality = 'high';
    if (cam.flipX) { ctx.translate(Math.max(a.x, b.x), a.y); ctx.scale(-1, 1); ctx.drawImage(im.src, 0, 0, w, h); }
    else ctx.drawImage(im.src, Math.min(a.x, b.x), a.y, w, h);
    ctx.globalAlpha = 1;
  }

  /** The heads-up display: lines of text beside the cursor, kept inside the view, on a dark panel when asked. */
  hud(lines: string[], at: Vec2, dpr: number, background: boolean): void {
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '11px "IBM Plex Mono", Consolas, monospace';
    const lh = 14, pad = 5;
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    // A long line (a violation, in full) is folded at its words to fit the view, its further rows set in
    const room = Math.max(120, Math.min(560, W - 16) - pad * 2);
    const rows: { text: string; of: number }[] = [];
    lines.forEach((l, of) => {
      let row = '';
      for (const word of l.split(' ')) {
        const next = row ? `${row} ${word}` : word;
        if (row.trim() && ctx.measureText(next).width > room) { rows.push({ text: row, of }); row = `   ${word}`; } else row = next;
      }
      rows.push({ text: row, of });
    });
    const w = Math.max(...rows.map((r) => ctx.measureText(r.text).width)) + pad * 2, h = rows.length * lh + pad * 2 - 2;
    let x = at.x + 18, y = at.y + 18;
    if (x + w > W) x = at.x - 18 - w;
    if (y + h > H) y = at.y - 18 - h;
    // …and the box kept inside the view (to the cursor's left it ran off the edge, its beginning lost)
    x = Math.max(4, Math.min(x, W - w - 4)); y = Math.max(4, Math.min(y, H - h - 4));
    if (background) { ctx.fillStyle = 'rgba(20, 24, 22, 0.82)'; ctx.fillRect(x, y, w, h); ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    rows.forEach((r, i) => {
      if (!background) { ctx.fillStyle = 'rgba(0, 0, 0, 0.7)'; ctx.fillText(r.text, x + pad + 1, y + pad + i * lh + 1); }
      ctx.fillStyle = r.of < 2 && !/^(Violation: |and \d+ more)/.test(lines[r.of]!) ? '#e8e3a8' : '#ffffff';
      ctx.fillText(r.text, x + pad, y + pad + i * lh);
    });
  }

  /** Show Repaint Indicator: a square in the top-left corner, its colour changed at each redraw. */
  repaintMark(dpr: number, colour: string): void {
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = colour;
    ctx.fillRect(4, 4, 8, 8);
  }

  drawText(t: TextItem, at: Vec2, cam: Camera, dpr: number, alpha = 1): void {
    if (t.frame) { this.drawFrame(t, at, cam, dpr, alpha); return; }
    if (t.objSize !== undefined && t.objSize * cam.scale < (t.objMinPx ?? 0)) return;
    let px = t.size * cam.scale;
    if (t.maxPx && px > t.maxPx) px = t.maxPx;
    // Draft: too small to read, a box where it would be
    const draft = !!t.draftPx && (t.draftSize ?? t.size) * cam.scale < t.draftPx;
    if (draft ? px < 0.8 : px < (t.minPx ?? 3.5) || px > 4000) return;
    const s = cam.toScreen(at);
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(s.x, s.y);
    const flip = cam.flipX ? -1 : 1;
    if (t.readable) {
      // On-screen angle, kept within (−90°, 90°] so it never reads upside down or mirrored
      let a = ((t.rot * flip) % 360 + 360) % 360;
      if (a > 90 && a <= 270) a -= 180;
      ctx.rotate((-a * Math.PI) / 180);
    } else {
      ctx.rotate((-t.rot * Math.PI) / 180 * flip);
      if (!!t.mirrored !== cam.flipX) ctx.scale(-1, 1);
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = t.color;
    ctx.font = `${t.italic ? 'italic ' : ''}${t.bold ? '600 ' : '400 '}${px}px ${t.family ?? '"IBM Plex Sans Condensed", system-ui, sans-serif'}`;
    if (draft) {
      // The box the text fills: as wide as it runs, as high as its capitals, from its anchor
      const lines = t.text.split('\n'), w = Math.max(...lines.map((l) => ctx.measureText(l).width)), h = Math.max(1, (t.draftSize ?? t.size) * cam.scale) * lines.length;
      const x = t.h === 0 ? 0 : t.h === 1 ? -w / 2 : -w, y = t.v === 0 ? -h : t.v === 1 ? -h / 2 : 0;
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, Math.max(1, w), h);
      ctx.globalAlpha = 1;
      return;
    }
    if (this.hardText) { hardTextFilter(this.canvas.ownerDocument); ctx.filter = `url(#${HARD_TEXT_FILTER})`; }
    ctx.textBaseline = t.anchor === 'cell' ? (['bottom', 'middle', 'top'] as const)[t.v] : (['alphabetic', 'middle', 'top'] as const)[t.v];
    const lines = t.text.split('\n');
    lines.forEach((l, i) => {
      const y = (i - (t.v === 0 ? lines.length - 1 : 0)) * px * 1.15;
      if (t.overline && l.includes('\\')) this.drawOverlined(l, t.h, y, px);
      else { ctx.textAlign = (['left', 'center', 'right'] as const)[t.h]; ctx.fillText(l, 0, y); }
    });
    ctx.globalAlpha = 1;
    if (this.hardText) ctx.filter = 'none';
  }

  /**
   * Text frame: lines from the top inside the margin, aligned left / centre / right, word-wrapped
   * to the frame width when WORDWRAP is set and clipped to the frame when CLIPTORECT is set.
   */
  private drawFrame(t: TextItem, at: Vec2, cam: Camera, dpr: number, alpha: number): void {
    const f = t.frame!;
    const dx = at.x - t.x, dy = at.y - t.y; // scene origin
    const a = cam.toScreen({ x: f.minX + dx, y: f.maxY + dy }), b = cam.toScreen({ x: f.maxX + dx, y: f.minY + dy });
    const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y), width = Math.abs(a.x - b.x), height = Math.abs(a.y - b.y);
    const px = t.size * cam.scale;
    if (px < 3.5 || px > 4000 || width < 2 || height < 2) return;
    const m = Math.min(f.margin * cam.scale, width / 3, height / 3);
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = t.color;
    ctx.font = `${t.italic ? 'italic ' : ''}${t.bold ? '600 ' : '400 '}${px}px ${t.family ?? '"IBM Plex Sans Condensed", system-ui, sans-serif'}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = (['left', 'center', 'right'] as const)[t.h];
    if (f.clip) { ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip(); }
    const avail = Math.max(1, width - 2 * m);
    const lines = f.wrap ? wrapLines(ctx, t.text, avail) : t.text.split('\n');
    const x = t.h === 0 ? left + m : t.h === 1 ? left + width / 2 : left + width - m;
    let y = top + m;
    for (const line of lines) {
      if (f.clip && y > top + height) break;
      ctx.fillText(line, x, y);
      y += px * 1.15;
    }
    ctx.restore();
  }

  /** Altium overline syntax: "R\S\T\" draws RST with a bar over each marked character. */
  private drawOverlined(raw: string, h: 0 | 1 | 2, y: number, px: number): void {
    const ctx = this.ctx;
    const chars: { c: string; over: boolean }[] = [];
    for (const ch of raw) {
      if (ch === '\\') { if (chars.length) chars[chars.length - 1]!.over = true; continue; }
      chars.push({ c: ch, over: false });
    }
    const text = chars.map((c) => c.c).join('');
    const w = ctx.measureText(text).width;
    const x0 = h === 0 ? 0 : h === 1 ? -w / 2 : -w;
    ctx.textAlign = 'left';
    ctx.fillText(text, x0, y);
    const m = ctx.measureText('X');
    const top = y - m.actualBoundingBoxAscent - px * 0.08;
    // Runs of overlined characters; x0 is negative for centred and right-aligned text
    let x = x0, runStart: number | null = null;
    const flush = (end: number) => { if (runStart !== null) { ctx.fillRect(runStart, top, end - runStart, Math.max(1, px * 0.06)); runStart = null; } };
    for (const c of chars) {
      const cw = ctx.measureText(c.c).width;
      if (c.over && runStart === null) runStart = x;
      if (!c.over) flush(x);
      x += cw;
    }
    flush(x);
  }

  /** Cursor at the snapped point: a small cross, or full-window crosshair lines. */
  crosshair(s: Vec2, dpr: number, color: string, full = false, size = 10): void {
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const x = Math.round(s.x) + 0.5, y = Math.round(s.y) + 0.5;
    const w = this.canvas.width / dpr, h = this.canvas.height / dpr;
    if (full) { ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    else { ctx.moveTo(x - size, y); ctx.lineTo(x + size, y); ctx.moveTo(x, y - size); ctx.lineTo(x, y + size); }
    ctx.stroke();
  }

  rubberBand(a: Vec2, b: Vec2, dpr: number, color: string, shade?: string | null): void {
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (shade) { ctx.fillStyle = shade; ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); }
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.setLineDash([]);
  }
}

/** Break text into lines no wider than maxWidth (CSS px), at spaces where possible. */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const next = line + word;
      if (!line || ctx.measureText(next).width <= maxWidth) { line = next; continue; }
      out.push(line.trimEnd());
      line = word.trimStart();
      // A single word wider than the frame breaks between characters
      while (line && ctx.measureText(line).width > maxWidth) {
        let n = line.length - 1;
        while (n > 1 && ctx.measureText(line.slice(0, n)).width > maxWidth) n--;
        out.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
