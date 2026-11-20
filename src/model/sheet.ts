/**
 * The board's sheet: Board Options › Sheet Position and Display Sheet (Board6 SHEETX, SHEETY,
 * SHEETWIDTH, SHEETHEIGHT, SHOWSHEET, LOCKSHEET), and the mechanical layers linked to it
 * (View Configurations › Linked To Sheet). Objects on a linked layer are shown only with the
 * sheet and, while Lock sheet primitives is on, can't be picked. Konium keeps the linked layers
 * in Board6 as KONIUMSHEETLINKED (the layers' numbers) [est: AD17's own key isn't known]; with
 * Auto-size to linked layers (KONIUMSHEETAUTOSIZE) the sheet is the extent of what lies on them.
 */
import type { BBox } from '../core/geom';
import { mil, parseLength } from '../core/units';
import type { Change } from '../core/undo';
import { isMech, type LayerId } from './layers';
import type { PcbDocument, PcbPrim } from './pcb';
import { editBoard } from './pcbBoard';

export interface Sheet { rect: BBox; show: boolean; lock: boolean; linked: Set<LayerId>; /** Auto-size to linked layers (KONIUMSHEETAUTOSIZE [est]): the sheet round what lies on them. */ auto: boolean }

const cache = new WeakMap<object, { prims: unknown; sheet: Sheet }>();
let bare: Sheet | null = null;

/** The sheet as the board keeps it (AD's defaults where it says nothing: 10000 × 8000 mil at 1000, 1000). */
export function sheetOf(doc: PcbDocument): Sheet {
  const b = doc.board.bag;
  if (b) { const hit = cache.get(b); if (hit && (!hit.sheet.auto || hit.prims === doc.prims)) return hit.sheet; } else if (bare) return bare;
  const len = (k: string, d: number) => { const v = parseLength(b?.getRaw(k)); return v === undefined ? d : Math.round(v); };
  const x = len('SHEETX', mil(1000)), y = len('SHEETY', mil(1000));
  const s: Sheet = {
    rect: { minX: x, minY: y, maxX: x + len('SHEETWIDTH', mil(10000)), maxY: y + len('SHEETHEIGHT', mil(8000)) },
    show: b?.bool('SHOWSHEET') ?? false, lock: b?.bool('LOCKSHEET') ?? false,
    linked: new Set((b?.get('KONIUMSHEETLINKED') ?? '').split(',').map(Number).filter((n) => n > 0 && isMech(n)) as LayerId[]),
    auto: b?.bool('KONIUMSHEETAUTOSIZE') ?? false,
  };
  if (s.auto) { const e = linkedExtent(doc, s.linked); if (e) s.rect = e; }
  if (b) cache.set(b, { prims: doc.prims, sheet: s }); else bare = s;
  return s;
}

/** View Configurations › Linked To Sheet: the mechanical layers linked from now on. */
export function setSheetLinked(doc: PcbDocument, layers: Set<LayerId>): Change {
  const list = [...layers].filter(isMech).sort((a, c) => a - c).join(',');
  return editBoard(doc, (b) => { if (list) b.set('KONIUMSHEETLINKED', list); else b.delete('KONIUMSHEETLINKED'); });
}

/** The extent of what lies on the linked layers (Auto-size to linked layers fits the sheet round it), or null. */
export function linkedExtent(doc: PcbDocument, layers = sheetOf(doc).linked): BBox | null {
  if (!layers.size) return null;
  return extentOf(doc, (p) => 'layer' in p && layers.has(p.layer));
}
/** The extent of the objects `on` takes (null when none). */
export function extentOf(doc: PcbDocument, on: (p: PcbPrim) => boolean): BBox | null {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const add = (x: number, y: number, r = 0) => { b.minX = Math.min(b.minX, x - r); b.minY = Math.min(b.minY, y - r); b.maxX = Math.max(b.maxX, x + r); b.maxY = Math.max(b.maxY, y + r); };
  for (const p of doc.prims) {
    if (!on(p)) continue;
    switch (p.kind) {
      case 'track': add(p.a.x, p.a.y, p.width / 2); add(p.b.x, p.b.y, p.width / 2); break;
      case 'arc': add(p.c.x, p.c.y, p.r + p.width / 2); break;
      case 'fill': add(p.a.x, p.a.y); add(p.b.x, p.b.y); break;
      case 'pad': add(p.at.x, p.at.y, Math.max(p.top.w, p.top.h) / 2); break;
      case 'via': add(p.at.x, p.at.y, p.diameter / 2); break;
      case 'text': add(p.at.x, p.at.y); add(p.at.x + p.height * 0.62 * p.text.length, p.at.y + p.height); break;
      case 'region': case 'body': for (const v of p.outline) add(v.x, v.y); break;
    }
  }
  return b.minX <= b.maxX ? b : null;
}
