/**
 * Coverlay on a rigid-flex board's flex regions: the Layer Stack Manager's Coverlay layers (in the
 * flex stacks only), each covering the face its copper is on. A flex region on a stack with a
 * coverlay is covered by it — the region grown by the layer's Coverlay Expansion, within the board
 * shape [est: the expansion reaching past the region's edges] — unless it has Custom Coverlays: then
 * by the coverlay polygons drawn for it on that layer, less their cutouts (Design › Place Coverlay
 * Polygon / Place Coverlay Cutout). Openings for pads and vias are made as the solder mask's are
 * (the Solder Mask Expansion rule, or the pad's own expansion).
 */
import type { Vec2 } from '../core/geom';
import { pointInPoly } from '../core/geom';
import { coverlaySide, readStack, type StackLayer } from './pcbStack';
import { boardRegions, inStack, substacks, type BoardRegion, type CoverlayShape } from './rigidFlex';
import { clipOutlines, offsetOutline } from './outlineOps';
import type { PcbDocument } from './pcb';

export interface CoverlayLayer { row: StackLayer; side: 'top' | 'bottom'; /** Its place among the board's coverlay layers (1 …). */ n: number }
export interface CoverlayArea { region: number; outlines: Vec2[][]; cutouts: Vec2[][] }

/** The board's coverlay layers, top to bottom. */
export function coverlayLayers(doc: PcbDocument): CoverlayLayer[] {
  if (!doc.board.bag) return [];
  const rows = readStack(doc.board.bag, doc.board.copperStack);
  let n = 0;
  return rows.flatMap((row, i) => (row.kind === 'coverlay' ? [{ row, side: coverlaySide(rows, i), n: ++n }] : []));
}

/** Whether a region's stack is flex and has this coverlay. */
export function regionHasCoverlay(doc: PcbDocument, r: BoardRegion, c: CoverlayLayer): boolean {
  const st = substacks(doc).find((x) => x.id === r.stackId);
  return !!st?.isFlex && inStack(c.row, r.stackId);
}

/** The coverlay automatic for a region: the region grown by the layer's expansion, within the board shape. */
export function autoCoverlay(doc: PcbDocument, r: BoardRegion, c: CoverlayLayer): Vec2[][] {
  const grown = offsetOutline(r.outline, c.row.coverlay);
  return doc.board.outline.length >= 3 ? clipOutlines('intersect', grown, [doc.board.outline]) : grown;
}

/** What a coverlay layer covers on each flex region that has it. */
export function coverlayAreas(doc: PcbDocument, c: CoverlayLayer): CoverlayArea[] {
  const out: CoverlayArea[] = [];
  boardRegions(doc).forEach((r, region) => {
    if (!regionHasCoverlay(doc, r, c)) return;
    if (r.customCoverlay) {
      const mine = (r.coverlays ?? []).filter((s) => s.layer === c.row.v7);
      out.push({ region, outlines: mine.filter((s) => !s.cutout).map((s) => s.outline), cutouts: mine.filter((s) => s.cutout).map((s) => s.outline) });
    } else out.push({ region, outlines: autoCoverlay(doc, r, c), cutouts: [] });
  });
  return out;
}

/** Whether a point lies under the coverlay (in an area, not in a cutout). */
export const underCoverlay = (areas: CoverlayArea[], p: Vec2): boolean =>
  areas.some((a) => a.outlines.some((o) => pointInPoly(p, o)) && !a.cutouts.some((o) => pointInPoly(p, o)));

/**
 * Custom Coverlays on (Board Region dialog; Advanced: Coverlay Actions › Add Coverlay): the region's
 * coverlay shapes, starting as the automatic coverlay on each of its stack's coverlay layers.
 * Off (Remove Coverlay): back to the automatic coverlay, the shapes drawn going with it.
 */
export function customCoverlayShapes(doc: PcbDocument, r: BoardRegion): CoverlayShape[] {
  return coverlayLayers(doc).filter((c) => regionHasCoverlay(doc, r, c)).flatMap((c) => autoCoverlay(doc, r, c).map((outline) => ({ layer: c.row.v7, outline, cutout: false })));
}
