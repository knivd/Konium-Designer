/**
 * Layer sets (Board6 LAYERSETnNAME / LAYERS / ACTIVELAYER.7 / ISCURRENT / ISLOCKED / FLIPBOARD):
 * named groups of layers the layer tabs can be narrowed to (the LS button, Design › Manage Layer
 * Sets). AD17's five built-in sets are locked; the board's own can be added, edited, deleted.
 */
import type { PropertyBag } from '../formats/altium/props';
import { layerFromName } from '../formats/altium/pcbdoc';
import { L, mechLayer, type LayerId } from './layers';

export interface LayerSet { name: string; layers: LayerId[]; active: LayerId | undefined; current: boolean; locked: boolean; flip: boolean }

const FIXED: Record<string, LayerId> = {
  TopLayer: L.TOP, BottomLayer: L.BOTTOM, TopOverlay: L.TOP_OVERLAY, BottomOverlay: L.BOTTOM_OVERLAY, TopPaste: L.TOP_PASTE, BottomPaste: L.BOTTOM_PASTE,
  TopSolder: L.TOP_SOLDER, BottomSolder: L.BOTTOM_SOLDER, DrillGuide: L.DRILL_GUIDE, KeepOutLayer: L.KEEPOUT, DrillDrawing: L.DRILL_DRAWING, MultiLayer: L.MULTI,
};
/** A layer set's member name ("MidLayer2", "InternalPlane1", "Mechanical13") as a layer. */
export function setLayerOf(name: string): LayerId | undefined {
  const n = name.trim();
  if (FIXED[n] !== undefined) return FIXED[n];
  let m = /^MidLayer(\d+)$/i.exec(n);
  if (m) return L.MID1 + Number(m[1]) - 1;
  m = /^InternalPlane(\d+)$/i.exec(n);
  if (m) return L.PLANE1 + Number(m[1]) - 1;
  m = /^Mechanical(\d+)$/i.exec(n);
  if (m) return mechLayer(Number(m[1]));
  return undefined;
}
/** A layer as a layer set names it. */
export function setNameOf(l: LayerId): string {
  for (const [k, v] of Object.entries(FIXED)) if (v === l) return k;
  if (l >= L.MID1 && l <= L.MID30) return `MidLayer${l - L.MID1 + 1}`;
  if (l >= L.PLANE1 && l <= L.PLANE16) return `InternalPlane${l - L.PLANE1 + 1}`;
  return `Mechanical${l > 1000 ? l - 1000 : l - L.MECH1 + 1}`;
}
/** ACTIVELAYER.7's names (TOP, MID1, PLANE1, MECHANICAL1, MULTILAYER …). */
function activeName(l: LayerId | undefined): string {
  if (l === undefined) return 'UNKNOWN';
  const fixed: Partial<Record<number, string>> = { [L.TOP]: 'TOP', [L.BOTTOM]: 'BOTTOM', [L.TOP_OVERLAY]: 'TOPOVERLAY', [L.BOTTOM_OVERLAY]: 'BOTTOMOVERLAY', [L.TOP_PASTE]: 'TOPPASTE',
    [L.BOTTOM_PASTE]: 'BOTTOMPASTE', [L.TOP_SOLDER]: 'TOPSOLDER', [L.BOTTOM_SOLDER]: 'BOTTOMSOLDER', [L.DRILL_GUIDE]: 'DRILLGUIDE', [L.KEEPOUT]: 'KEEPOUT', [L.DRILL_DRAWING]: 'DRILLDRAWING', [L.MULTI]: 'MULTILAYER' };
  if (fixed[l]) return fixed[l]!;
  if (l >= L.MID1 && l <= L.MID30) return `MID${l - L.MID1 + 1}`;
  if (l >= L.PLANE1 && l <= L.PLANE16) return `PLANE${l - L.PLANE1 + 1}`;
  return `MECHANICAL${l > 1000 ? l - 1000 : l - L.MECH1 + 1}`;
}

export function readLayerSets(b: PropertyBag | undefined): LayerSet[] {
  if (!b) return [];
  const out: LayerSet[] = [];
  for (let i = 1; i <= b.int('LAYERSETSCOUNT'); i++) {
    const raw = (b.get(`LAYERSET${i}LAYERS`) ?? '').trim();
    out.push({
      name: (b.get(`LAYERSET${i}NAME`) ?? `Set ${i}`).trim(),
      layers: raw.split(',').map(setLayerOf).filter((l): l is LayerId => l !== undefined),
      active: layerFromName(b.get(`LAYERSET${i}ACTIVELAYER.7`) ?? ''),
      current: b.bool(`LAYERSET${i}ISCURRENT`), locked: b.bool(`LAYERSET${i}ISLOCKED`), flip: b.bool(`LAYERSET${i}FLIPBOARD`),
    });
  }
  return out;
}

/** The sets written back: every LAYERSETn key replaced, the count with them. */
export function writeLayerSets(b: PropertyBag, sets: LayerSet[]): void {
  b.replaceGroup((k) => /^LAYERSET\d+/.test(k) || k === 'LAYERSETSCOUNT', [
    ['LAYERSETSCOUNT', String(sets.length)],
    ...sets.flatMap((s, i): [string, string][] => [
      [`LAYERSET${i + 1}NAME`, s.name], [`LAYERSET${i + 1}LAYERS`, s.layers.map(setNameOf).join(',')], [`LAYERSET${i + 1}ACTIVELAYER.7`, activeName(s.active)],
      [`LAYERSET${i + 1}ISCURRENT`, s.current ? 'TRUE' : 'FALSE'], [`LAYERSET${i + 1}ISLOCKED`, s.locked ? 'TRUE' : 'FALSE'], [`LAYERSET${i + 1}FLIPBOARD`, s.flip ? 'TRUE' : 'FALSE'],
    ]),
  ]);
}

/** A set's name as shown (the & marks its accelerator). */
export const setLabel = (s: LayerSet) => s.name.replace(/&(.)/g, '$1');

/* ─── Drill pairs (Board6 LAYERPAIRnLOW / HIGH / DRILLGUIDE / DRILLDRAWING / SUBSTACK_0) ─── */

export interface DrillPair { low: LayerId; high: LayerId; guide: boolean; drawing: boolean; substack?: string }

export function readDrillPairs(b: PropertyBag | undefined): DrillPair[] {
  const out: DrillPair[] = [];
  for (let i = 0; b?.has(`LAYERPAIR${i}LOW`); i++) {
    const low = layerFromName(b.get(`LAYERPAIR${i}LOW`) ?? ''), high = layerFromName(b.get(`LAYERPAIR${i}HIGH`) ?? '');
    if (low === undefined || high === undefined) continue;
    out.push({ low, high, guide: b.bool(`LAYERPAIR${i}DRILLGUIDE`), drawing: b.bool(`LAYERPAIR${i}DRILLDRAWING`), substack: b.get(`LAYERPAIR${i}SUBSTACK_0`) });
  }
  return out;
}
export function writeDrillPairs(b: PropertyBag, pairs: DrillPair[]): void {
  const stack = pairs.find((p) => p.substack)?.substack;
  b.replaceGroup((k) => /^LAYERPAIR\d+/.test(k), pairs.flatMap((p, i): [string, string][] => [
    [`LAYERPAIR${i}LOW`, activeName(p.low)], [`LAYERPAIR${i}HIGH`, activeName(p.high)],
    [`LAYERPAIR${i}DRILLGUIDE`, p.guide ? 'TRUE' : 'FALSE'], [`LAYERPAIR${i}DRILLDRAWING`, p.drawing ? 'TRUE' : 'FALSE'],
    ...(p.substack ?? stack ? [[`LAYERPAIR${i}SUBSTACK_0`, (p.substack ?? stack)!] as [string, string]] : []),
  ]));
}
