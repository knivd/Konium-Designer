/**
 * The board's faces as 3D Layout Mode shows them: solder mask over the laminate, copper under
 * the mask lighter, pads exposed in their finish, silkscreen on top and the holes cut through,
 * in the 3D view configuration's colours (core/view3d.ts). Painted with Canvas 2D in board
 * units (Y up), one canvas per side.
 */
import { settings } from '../../core/settings';
import { barcodeShape } from '../../model/barcode';
import { strokeCapHeight, strokeText } from '../../formats/gerber/stroke';
import { L, isCopper, isPlane, type LayerId } from '../../model/layers';
import { slotEnds, type PadStackLayer, type PcbDocument, type PcbPrim } from '../../model/pcb';
import type { BBox, Vec2 } from '../../core/geom';
import { VIEW3D_DEFAULT, sideLook, type SideLook } from '../../core/view3d';
import { readStack } from '../../model/pcbStack';
import { boardRegions, inStack, isAdvanced, readSubstacks } from '../../model/rigidFlex';
import { clipContours, sharedArea } from '../../model/outlineOps';
import { coverlayAreas, coverlayLayers } from '../../model/coverlay';

/** A rigid-flex region whose layer stack leaves this side's solder mask out shows its polyimide and the copper through it [est: AD17's colours]. */
const POLYIMIDE = { laminate: '#b8761e', copper: '#d9a24c' };
/** Coverlay over it: the polyimide film, a shade darker [est]. */
const COVERLAY = { laminate: '#a8650f', copper: '#c98f3a' };

/** The regions on stacks without this side's mask (and whether they keep its overlay). */
export function bareRegions(doc: PcbDocument, side: 'top' | 'bottom'): { outline: Vec2[]; silk: boolean; index: number; shape?: Vec2[][] }[] {
  if (!doc.flex || !doc.board.bag) return [];
  const subs = readSubstacks(doc.board.bag);
  if (subs.length < 2) return [];
  const rows = readStack(doc.board.bag, doc.board.copperStack);
  const mask = rows.find((r) => r.layer === (side === 'top' ? L.TOP_SOLDER : L.BOTTOM_SOLDER));
  const over = rows.find((r) => r.layer === (side === 'top' ? L.TOP_OVERLAY : L.BOTTOM_OVERLAY));
  if (!mask) return [];
  const regs = boardRegions(doc);
  // Advanced Rigid-Flex: where regions overlap, the one of higher priority (the later of equals) shows [est]
  const over_ = (i: number) => regs.filter((x, j) => j !== i && ((x.priority ?? 0) > (regs[i]!.priority ?? 0) || ((x.priority ?? 0) === (regs[i]!.priority ?? 0) && j > i)));
  const shapeOf = (i: number): Vec2[][] | undefined => {
    if (!isAdvanced(doc)) return undefined;
    const above = over_(i).filter((x) => sharedArea(x.outline, regs[i]!.outline) > 0).map((x) => x.outline);
    return above.length ? clipContours('difference', [regs[i]!.outline], above) : undefined;
  };
  return regs.filter((r) => r.stackId && !inStack(mask, r.stackId)).map((r) => ({ outline: r.outline, silk: !!over && inStack(over, r.stackId), index: r.index, shape: shapeOf(r.index) }));
}

/** As 3D Dk Green paints it (the default configuration). */
export const SURFACE: SideLook = sideLook(VIEW3D_DEFAULT, 'top');

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

const DEG = Math.PI / 180;

function padPath(ctx: Ctx, at: Vec2, st: PadStackLayer, rot: number): void {
  const hw = st.w / 2, hh = st.h / 2;
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(rot * DEG);
  ctx.beginPath();
  if (st.shape === 'round') {
    const r = Math.min(hw, hh);
    if (hw === hh) ctx.arc(0, 0, r, 0, 2 * Math.PI);
    else ctx.roundRect(-hw, -hh, st.w, st.h, r);
  } else if (st.shape === 'roundrect') {
    ctx.roundRect(-hw, -hh, st.w, st.h, Math.min(hw, hh) * (st.cornerPct / 100));
  } else if (st.shape === 'octagon') {
    const c = Math.min(hw, hh) * 0.4142;
    const pts = [[-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c], [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c]];
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x!, y!) : ctx.moveTo(x!, y!)));
    ctx.closePath();
  } else ctx.rect(-hw, -hh, st.w, st.h);
  ctx.restore();
}

function polyPath(ctx: Ctx, loops: Vec2[][]): void {
  ctx.beginPath();
  for (const l of loops) { l.forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y))); ctx.closePath(); }
}

/**
 * A font of `size` board units. Canvas fonts are set at a fixed pixel size and the drawing scaled
 * to it: board units are tiny (10 000 to the mil), and a font hundreds of thousands of pixels high
 * draws nothing.
 */
const FONT_PX = 100;
function fontAt(ctx: Ctx, size: number, css: (px: number) => string): void {
  const s = size / FONT_PX;
  ctx.scale(s, s);
  ctx.font = css(FONT_PX);
}

/** One primitive in the current fill / stroke style (copper or silk). */
function drawPrim(ctx: Ctx, p: PcbPrim, bg = '#000'): void {
  switch (p.kind) {
    case 'track':
      ctx.lineWidth = p.width; ctx.beginPath(); ctx.moveTo(p.a.x, p.a.y); ctx.lineTo(p.b.x, p.b.y); ctx.stroke(); break;
    case 'arc': {
      const sweep = ((p.end - p.start) % 360 + 360) % 360 || 360;
      ctx.lineWidth = p.width; ctx.beginPath(); ctx.arc(p.c.x, p.c.y, p.r, p.start * DEG, (p.start + sweep) * DEG); ctx.stroke(); break;
    }
    case 'fill': {
      const c = { x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 }, w = Math.abs(p.b.x - p.a.x), h = Math.abs(p.b.y - p.a.y);
      ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(p.rotation * DEG); ctx.fillRect(-w / 2, -h / 2, w, h); ctx.restore(); break;
    }
    case 'region':
      if (p.regionKind !== 0 || p.boardCutout || p.outline.length < 3) break;
      polyPath(ctx, [p.outline, ...p.holes]); ctx.fill('evenodd'); break;
    case 'text': {
      if (p.hidden || !p.text) break;
      if (p.barcode) {
        const bc = barcodeShape(p.text, p.at, p.rotation, p.mirrored, p.height, p.barcode);
        for (const r of bc.rects) { polyPath(ctx, [r]); ctx.fill(); }
        const lab = bc.label;
        if (lab) for (const ch of lab.chars) {
          ctx.save();
          if (lab.knockout) ctx.fillStyle = bg;
          ctx.translate(ch.at.x, ch.at.y); ctx.rotate(p.rotation * DEG); ctx.scale(p.mirrored ? -1 : 1, -1);
          fontAt(ctx, lab.em, (px) => `400 ${px}px "${p.barcode!.font}", "${settings.pcbSubstituteFont}", sans-serif`);
          ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
          ctx.fillText(ch.text, 0, 0); ctx.restore();
        }
        break;
      }
      if (p.fontType === 1) {
        // TrueType: sized as the 2D view sizes it (Altium's height to the font's capital height)
        ctx.save();
        ctx.translate(p.at.x, p.at.y);
        ctx.rotate(p.rotation * DEG);
        ctx.scale(p.mirrored ? -1 : 1, -1);
        fontAt(ctx, strokeCapHeight(p) / 0.716, (px) => `${p.italic ? 'italic ' : ''}${p.bold ? '700 ' : '400 '}${px}px "${p.fontName || settings.pcbSubstituteFont}", "${settings.pcbSubstituteFont}", sans-serif`);
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(p.text, 0, 0);
        ctx.restore();
      } else {
        ctx.lineWidth = p.strokeWidth || p.height / 10;
        for (const pl of strokeText(p.text, p.at, p.height, p.rotation, p.mirrored)) {
          ctx.beginPath(); pl.forEach((v, i) => (i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y))); ctx.stroke();
        }
      }
      break;
    }
    case 'via':
      ctx.beginPath(); ctx.arc(p.at.x, p.at.y, p.diameter / 2, 0, 2 * Math.PI); ctx.fill(); break;
    case 'pad': break;
  }
}

/**
 * Paint one side in `look`'s colours. `rect` is the board's extent; the canvas covers it at `pxPerUnit`.
 * Returns the canvas (transparent off the board and in the holes; where only laminate and mask
 * are, as see-through as `baseAlpha`).
 */
export function paintSide(doc: PcbDocument, side: 'top' | 'bottom', outline: Vec2[], rect: BBox, maxPx = 3072, look: SideLook = SURFACE, baseAlpha = 1): AnyCanvas {
  const w = rect.maxX - rect.minX || 1, h = rect.maxY - rect.minY || 1;
  const k = Math.min(maxPx / w, maxPx / h);
  const cw = Math.max(16, Math.ceil(w * k)), ch = Math.max(16, Math.ceil(h * k));
  const canvas = makeCanvas(cw, ch);
  const ctx = canvas.getContext('2d') as Ctx | null;
  if (!ctx) return canvas;
  ctx.setTransform(k, 0, 0, -k, -rect.minX * k, rect.maxY * k);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const copper: LayerId = side === 'top' ? L.TOP : L.BOTTOM;
  const silk: LayerId = side === 'top' ? L.TOP_OVERLAY : L.BOTTOM_OVERLAY;

  // Mask over laminate, clipped to the board shape; then the regions without mask on this side, over it
  const layers = (laminate: string, copperColour: string, withSilk: boolean) => {
    ctx.globalAlpha = baseAlpha;
    ctx.fillStyle = laminate;
    ctx.fillRect(rect.minX, rect.minY, w, h);
    ctx.globalAlpha = 1;

    // Copper under the mask
    ctx.fillStyle = ctx.strokeStyle = copperColour;
    for (const p of doc.prims) if ((p.kind !== 'text' && 'layer' in p && p.layer === copper) || p.kind === 'via') drawPrim(ctx, p);

    // Pads are opened in the mask: their finish shows
    ctx.fillStyle = look.finish;
    for (const p of doc.prims) {
      if (p.kind !== 'pad') continue;
      if (p.layer !== L.MULTI && p.layer !== copper) continue;
      const st = p.layer === L.MULTI ? (side === 'top' ? p.top : p.bot) : p.top;
      if (st.w > 0 && st.h > 0) { padPath(ctx, p.at, st, p.rotation); ctx.fill(); }
    }
    // Copper text on the side (logos, labels) shows as copper too
    ctx.fillStyle = ctx.strokeStyle = copperColour;
    for (const p of doc.prims) if (p.kind === 'text' && p.layer === copper) drawPrim(ctx, p, laminate);

    // Silkscreen, at its opacity
    if (withSilk && look.silk && look.silkAlpha > 0) {
      ctx.globalAlpha = look.silkAlpha;
      ctx.fillStyle = ctx.strokeStyle = look.silk;
      for (const p of doc.prims) if ('layer' in p && p.layer === silk) drawPrim(ctx, p, laminate);
      ctx.globalAlpha = 1;
    }
  };
  ctx.save();
  polyPath(ctx, [outline]);
  ctx.clip();
  layers(look.laminate, look.copper, true);
  // A flex region with a coverlay on this side: its copper bare (in its finish) where the coverlay doesn't reach, under the polyimide where it does
  const covers = coverlayLayers(doc).filter((c) => c.side === side).flatMap((c) => coverlayAreas(doc, c));
  for (const r of bareRegions(doc, side)) {
    ctx.save();
    polyPath(ctx, r.shape ?? [r.outline]);
    ctx.clip('evenodd');
    const mine = covers.filter((a) => a.region === r.index);
    if (!mine.length) layers(POLYIMIDE.laminate, POLYIMIDE.copper, r.silk);
    else {
      layers(POLYIMIDE.laminate, look.finish, r.silk);
      for (const a of mine) for (const o of a.outlines) {
        ctx.save();
        polyPath(ctx, [o, ...a.cutouts]);
        ctx.clip('evenodd');
        layers(COVERLAY.laminate, COVERLAY.copper, r.silk);
        ctx.restore();
      }
    }
    ctx.restore();
  }
  ctx.restore();

  // Holes and cut-outs through the board
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
  for (const p of doc.prims) {
    const slot = p.kind === 'pad' ? slotEnds(p) : null;
    if (slot) { ctx.beginPath(); ctx.moveTo(slot[0].x, slot[0].y); ctx.lineTo(slot[1].x, slot[1].y); ctx.lineWidth = (p as { hole: number }).hole; ctx.lineCap = 'round'; ctx.stroke(); }
    else if ((p.kind === 'via' || p.kind === 'pad') && p.hole > 0) { ctx.beginPath(); ctx.arc(p.at.x, p.at.y, p.hole / 2, 0, 2 * Math.PI); ctx.fill(); }
    else if (look.cutouts && p.kind === 'region' && p.boardCutout && p.outline.length >= 3) { polyPath(ctx, [p.outline]); ctx.fill(); }
  }
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}

/**
 * Single layer mode in the 3D view (Shift+S, as the desktop software has it there too): the board
 * as a ghost of its laminate, and one layer's objects alone in the layer's colour. `layer` null
 * paints the ghost only (the face the layer is not on). Copper layers take the vias and the pads
 * that reach them; a plane layer is copper all over, less its holes.
 */
export function paintSingle(doc: PcbDocument, layer: LayerId | null, outline: Vec2[], rect: BBox, maxPx: number, colour: string, laminate: string, ghost = 0.14, cutouts = true): AnyCanvas {
  const w = rect.maxX - rect.minX || 1, h = rect.maxY - rect.minY || 1;
  const k = Math.min(maxPx / w, maxPx / h);
  const canvas = makeCanvas(Math.max(16, Math.ceil(w * k)), Math.max(16, Math.ceil(h * k)));
  const ctx = canvas.getContext('2d') as Ctx | null;
  if (!ctx) return canvas;
  ctx.setTransform(k, 0, 0, -k, -rect.minX * k, rect.maxY * k);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.save();
  polyPath(ctx, [outline]);
  ctx.clip();
  ctx.globalAlpha = ghost;
  ctx.fillStyle = laminate;
  ctx.fillRect(rect.minX, rect.minY, w, h);
  ctx.globalAlpha = 1;
  if (layer !== null) {
    ctx.fillStyle = ctx.strokeStyle = colour;
    const copper = isCopper(layer);
    if (isPlane(layer)) { ctx.globalAlpha = 0.85; ctx.fillRect(rect.minX, rect.minY, w, h); ctx.globalAlpha = 1; }
    for (const p of doc.prims) {
      if (p.kind === 'via') { if (copper) drawPrim(ctx, p); continue; }
      if (p.kind === 'pad') {
        if (p.layer !== layer && !(copper && p.layer === L.MULTI)) continue;
        const st = p.layer !== L.MULTI || layer === L.TOP ? p.top : layer === L.BOTTOM ? p.bot : p.mid;
        const shape = st.w > 0 && st.h > 0 ? st : p.top;
        if (shape.w > 0 && shape.h > 0) { padPath(ctx, p.at, shape, p.rotation); ctx.fill(); }
        continue;
      }
      if ('layer' in p && p.layer === layer) drawPrim(ctx, p, laminate);
    }
  }
  ctx.restore();
  // Holes and cut-outs through the board
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000'; ctx.strokeStyle = '#000';
  for (const p of doc.prims) {
    const slot = p.kind === 'pad' ? slotEnds(p) : null;
    if (slot) { ctx.beginPath(); ctx.moveTo(slot[0].x, slot[0].y); ctx.lineTo(slot[1].x, slot[1].y); ctx.lineWidth = (p as { hole: number }).hole; ctx.lineCap = 'round'; ctx.stroke(); }
    else if ((p.kind === 'via' || p.kind === 'pad') && p.hole > 0) { ctx.beginPath(); ctx.arc(p.at.x, p.at.y, p.hole / 2, 0, 2 * Math.PI); ctx.fill(); }
    else if (cutouts && p.kind === 'region' && p.boardCutout && p.outline.length >= 3) { polyPath(ctx, [p.outline]); ctx.fill(); }
  }
  ctx.globalCompositeOperation = 'source-over';
  return canvas;
}

/** Which face a layer is seen on in single layer mode: its own for the outer layers and what lies on them, neither for a layer inside the board. */
export function singleFace(doc: PcbDocument, layer: LayerId): 'top' | 'bottom' | 'inner' {
  if (layer === L.BOTTOM || layer === L.BOTTOM_OVERLAY || layer === L.BOTTOM_SOLDER || layer === L.BOTTOM_PASTE) return 'bottom';
  if (isCopper(layer) && layer !== L.TOP && doc.board.copperStack.includes(layer)) return 'inner';
  return 'top';
}
