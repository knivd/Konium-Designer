/**
 * Edit › Smart Paste (Shift+Ctrl+V): the clipboard's objects pasted as themselves or converted
 * (net labels ↔ ports ↔ text strings), optionally as an array — so many columns and rows at
 * these spacings, names and designators stepping on as Altium's Text Increment says
 * (Horizontal First numbers along a row then on to the next; Vertical First down a column).
 */
import type { Vec2 } from '../core/geom';
import { SCH_UNIT } from '../core/units';
import type { PropertyBag } from '../formats/altium/props';
import type { SchClip } from '../editors/clipboard';
import { SR, schCoord } from './sch';
import { labelBag, netLabelBag, portBag } from './schPlace';
import { identity, transformBag } from './schTransform';

export type PasteAs = 'themselves' | 'netlabels' | 'ports' | 'text';
export interface ArrayOpts {
  on: boolean;
  cols: number; colSpacing: number;   // spacing in internal units
  rows: number; rowSpacing: number;
  direction: 'none' | 'horizontal' | 'vertical';
  primary: number; secondary: number;
}
/** Altium's defaults: one column, eight rows 100 mil apart going down, numbers stepping by 1. */
export const DEFAULT_ARRAY: ArrayOpts = { on: false, cols: 1, colSpacing: 0, rows: 8, rowSpacing: -10 * SCH_UNIT, direction: 'horizontal', primary: 1, secondary: 1 };

/** What a record is called in the Smart Paste object list. */
export function pasteKind(bag: PropertyBag): string {
  switch (bag.int('RECORD', -1)) {
    case SR.NET_LABEL: return 'Net Labels';
    case SR.PORT: return 'Ports';
    case SR.LABEL: return 'Text Strings';
    case SR.POWER_PORT: return bag.bool('ISCROSSSHEETCONNECTOR') ? 'Off Sheet Connectors' : 'Power Ports';
    case SR.WIRE: return 'Wires';
    case SR.BUS: return 'Buses';
    case SR.JUNCTION: return 'Junctions';
    case SR.COMPONENT: return 'Parts';
    case SR.SHEET_SYMBOL: return 'Sheet Symbols';
    case SR.TEXT_FRAME: return 'Text Frames';
    case SR.NO_ERC: return 'No ERCs';
    case SR.BUS_ENTRY: return 'Bus Entries';
    default: return 'Graphics';
  }
}
/** Kinds that carry a name and can become another named kind. */
export const CONVERTIBLE = new Set(['Net Labels', 'Ports', 'Text Strings']);

/** Step the number at the end of a name: D0 + 3 → D3, NetLabel09 + 1 → NetLabel10. No number: unchanged. */
export function stepName(s: string, by: number): string {
  if (!by) return s;
  const m = /^(.*?)(\d+)(\D*)$/.exec(s);
  if (!m) return s;
  const n = Math.max(0, Number(m[2]) + by);
  return `${m[1]}${String(n).padStart(m[2]!.length, '0')}${m[3]}`;
}

const NAMED: Record<number, string> = { [SR.NET_LABEL]: 'TEXT', [SR.LABEL]: 'TEXT', [SR.PORT]: 'NAME', [SR.SHEET_ENTRY]: 'NAME', [SR.DESIGNATOR]: 'TEXT', [SR.PIN]: 'DESIGNATOR' };

/** The clip's items converted as asked (kinds not in the map are pasted as themselves; kinds mapped to null are left out). */
export function convertClip(clip: SchClip, as: Map<string, PasteAs | null>): SchClip {
  const keep: SchClip['items'] = [];
  const map = new Map<number, number>();
  clip.items.forEach((it, i) => {
    const owner = it.owner >= 0 ? clip.items[it.owner] : undefined;
    const kind = pasteKind(owner?.bag ?? it.bag);
    const to = as.has(kind) ? as.get(kind) : 'themselves';
    if (to === null) return;
    if (it.owner >= 0 && !map.has(it.owner)) return;
    map.set(i, keep.length);
    if (to === 'themselves' || !CONVERTIBLE.has(kind) || it.owner >= 0) { keep.push({ bag: it.bag, owner: it.owner >= 0 ? map.get(it.owner)! : -1 }); return; }
    const name = it.bag.get(it.bag.int('RECORD') === SR.PORT ? 'NAME' : 'TEXT') ?? '';
    const at: Vec2 = { x: schCoord(it.bag, 'LOCATION.X'), y: schCoord(it.bag, 'LOCATION.Y') };
    const bag = to === 'netlabels' ? netLabelBag(name, at) : to === 'ports' ? portBag(name, at, Math.max(5, name.length + 2) * 10 * SCH_UNIT, 3, 0) : labelBag(name, at);
    keep.push({ bag, owner: -1 });
  });
  return { kind: 'sch', ref: clip.ref, items: keep };
}

/** The clip repeated as an array, names stepping on per copy. */
export function arrayClip(clip: SchClip, o: ArrayOpts): SchClip {
  if (!o.on || o.cols * o.rows <= 1) return clip;
  const items: SchClip['items'] = [];
  const cols = Math.max(1, Math.floor(o.cols)), rows = Math.max(1, Math.floor(o.rows));
  // The step for each copy: along the primary direction by Primary, on to the next line by Secondary
  const step = (c: number, r: number): number => {
    if (o.direction === 'none') return 0;
    const [along, line, per] = o.direction === 'horizontal' ? [c, r, cols] : [r, c, rows];
    return line * ((per - 1) * o.primary + o.secondary) + along * o.primary;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const base = items.length;
      const x = identity(clip.ref);
      x.d = { x: c * o.colSpacing, y: r * o.rowSpacing };
      const by = step(c, r);
      for (const it of clip.items) {
        const b = c || r ? transformBag(it.bag, x) : it.bag.clone();
        const key = NAMED[b.int('RECORD', -1)];
        if (key && by && b.has(key)) b.set(key, stepName(b.get(key) ?? '', by));
        items.push({ bag: b, owner: it.owner >= 0 ? base + it.owner : -1 });
      }
    }
  }
  return { kind: 'sch', ref: clip.ref, items };
}

/**
 * Edit › Paste Array (the library editor's): `count` copies, each `d` on from the last; names
 * step by `primary` (a pin's designator, a label's text) and a pin's name by `secondary`.
 */
export function lineClip(clip: SchClip, count: number, d: { x: number; y: number }, primary: number, secondary: number): SchClip {
  const n = Math.max(1, Math.floor(count));
  const items: SchClip['items'] = [];
  for (let k = 0; k < n; k++) {
    const base = items.length;
    const x = identity(clip.ref);
    x.d = { x: k * d.x, y: k * d.y };
    for (const it of clip.items) {
      const b = k ? transformBag(it.bag, x) : it.bag.clone();
      const rec = b.int('RECORD', -1), key = NAMED[rec];
      if (k && key && b.has(key)) b.set(key, stepName(b.get(key) ?? '', k * primary));
      if (k && rec === SR.PIN && b.has('NAME') && secondary) b.set('NAME', stepName(b.get('NAME') ?? '', k * secondary));
      items.push({ bag: b, owner: it.owner >= 0 ? base + it.owner : -1 });
    }
  }
  return { kind: 'sch', ref: clip.ref, items };
}
