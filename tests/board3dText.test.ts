import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { paintSide } from '../src/render/gl3d/boardTexture';
import { L } from '../src/model/layers';
import type { PcbText } from '../src/model/pcb';

/** A canvas that records what is drawn: each fillText with its font and the scale it was drawn at. */
function recorder() {
  const texts: { text: string; font: string; px: number; scale: number }[] = [];
  const stack: number[][] = [];
  let m = [1, 0, 0, 1, 0, 0];
  const ctx: Record<string, unknown> = {
    font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1, globalCompositeOperation: 'source-over', lineCap: 'butt', lineJoin: 'miter', textAlign: 'start', textBaseline: 'alphabetic',
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => { m = [a, b, c, d, e, f]; },
    save: () => stack.push([...m]), restore: () => { m = stack.pop() ?? m; },
    translate: (x: number, y: number) => { m = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]! + m[0]! * x + m[2]! * y, m[5]! + m[1]! * x + m[3]! * y]; },
    rotate: (a: number) => { const c = Math.cos(a), s = Math.sin(a); m = [m[0]! * c + m[2]! * s, m[1]! * c + m[3]! * s, -m[0]! * s + m[2]! * c, -m[1]! * s + m[3]! * c, m[4]!, m[5]!]; },
    scale: (x: number, y: number) => { m = [m[0]! * x, m[1]! * x, m[2]! * y, m[3]! * y, m[4]!, m[5]!]; },
    fillText: (text: string) => {
      const px = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font as string)?.[1]);
      texts.push({ text, font: ctx.font as string, px, scale: Math.hypot(m[0]!, m[1]!) });
    },
  };
  for (const k of ['beginPath', 'moveTo', 'lineTo', 'arc', 'rect', 'roundRect', 'closePath', 'fill', 'stroke', 'fillRect', 'clip']) ctx[k] = () => {};
  return { ctx, texts };
}

const g = globalThis as { OffscreenCanvas?: unknown };
const had = g.OffscreenCanvas;
afterEach(() => { g.OffscreenCanvas = had; });

describe('3D Layout Mode: silkscreen text', () => {
  it('TrueType overlay text is drawn at a font size a canvas can draw, the height on the board as the 2D view gives it', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const base = doc.prims.find((p): p is PcbText => p.kind === 'text')!;
    // 60 mil Arial on the top overlay (board units: 10 000 to the mil)
    doc.prims.push({ ...base, layer: L.TOP_OVERLAY, text: 'Rev B overlay', fontType: 1, fontName: 'Arial', height: 600000, hidden: false, barcode: undefined });
    const rec = recorder();
    g.OffscreenCanvas = class { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h; } getContext() { return rec.ctx; } };
    const outline = doc.board.outline;
    const xs = outline.map((v) => v.x), ys = outline.map((v) => v.y);
    paintSide(doc, 'top', outline, { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) });
    const t = rec.texts.find((x) => x.text === 'Rev B overlay')!;
    expect(t.px).toBeLessThanOrEqual(200);
    expect(t.font).toContain('"Arial"');
    // The font's size on the board: 60 mil × 0.63 / 0.716 (the 2D view's Arial capital height), in canvas pixels at the board's scale
    const k = 3072 / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    expect((t.px * t.scale) / k).toBeCloseTo((600000 * 0.63) / 0.716, -2);
  });
});
