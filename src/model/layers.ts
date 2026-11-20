import { hexToRgb, settings } from '../core/settings';

/**
 * PCB layer identity. Internal ids follow Altium's V6 numbering (1 = Top … 82), which is
 * what most binary primitives carry. Mechanical layers above 16 (V7+) map to 1000 + n.
 * V7/V8 32-bit ids are converted at load and converted back at save.
 */
export type LayerId = number;

export const L = {
  TOP: 1, MID1: 2, MID30: 31, BOTTOM: 32,
  TOP_OVERLAY: 33, BOTTOM_OVERLAY: 34,
  TOP_PASTE: 35, BOTTOM_PASTE: 36,
  TOP_SOLDER: 37, BOTTOM_SOLDER: 38,
  PLANE1: 39, PLANE16: 54,
  DRILL_GUIDE: 55, KEEPOUT: 56,
  MECH1: 57, MECH16: 72,
  DRILL_DRAWING: 73, MULTI: 74,
} as const;

export const isSignal = (l: LayerId): boolean => l >= L.TOP && l <= L.BOTTOM;
export const isPlane = (l: LayerId): boolean => l >= L.PLANE1 && l <= L.PLANE16;
export const isCopper = (l: LayerId): boolean => isSignal(l) || isPlane(l);
export const isMech = (l: LayerId): boolean => (l >= L.MECH1 && l <= L.MECH16) || l > 1000;
export const mechNumber = (l: LayerId): number => (l > 1000 ? l - 1000 : l - L.MECH1 + 1);
export const mechLayer = (n: number): LayerId => (n <= 16 ? L.MECH1 + n - 1 : 1000 + n);
/** View Configurations › Transparency: the kind of layer a slider sets. */
export function transparencyKey(l: LayerId): string {
  if (isSignal(l)) return 'signal';
  if (isPlane(l)) return 'plane';
  if (isMech(l)) return 'mech';
  if (l === L.TOP_OVERLAY || l === L.BOTTOM_OVERLAY) return 'overlay';
  if (l === L.TOP_PASTE || l === L.BOTTOM_PASTE) return 'paste';
  if (l === L.TOP_SOLDER || l === L.BOTTOM_SOLDER) return 'solder';
  return l === L.DRILL_GUIDE ? 'drillGuide' : l === L.KEEPOUT ? 'keepout' : l === L.DRILL_DRAWING ? 'drillDrawing' : 'multi';
}

export function layerName(l: LayerId): string {
  if (l === L.TOP) return 'Top Layer';
  if (l === L.BOTTOM) return 'Bottom Layer';
  if (l > L.TOP && l < L.BOTTOM) return `Mid-Layer ${l - 1}`;
  if (isPlane(l)) return `Internal Plane ${l - L.PLANE1 + 1}`;
  if (isMech(l)) return `Mechanical ${mechNumber(l)}`;
  return ({
    [L.TOP_OVERLAY]: 'Top Overlay', [L.BOTTOM_OVERLAY]: 'Bottom Overlay',
    [L.TOP_PASTE]: 'Top Paste', [L.BOTTOM_PASTE]: 'Bottom Paste',
    [L.TOP_SOLDER]: 'Top Solder', [L.BOTTOM_SOLDER]: 'Bottom Solder',
    [L.DRILL_GUIDE]: 'Drill Guide', [L.KEEPOUT]: 'Keep-Out Layer',
    [L.DRILL_DRAWING]: 'Drill Drawing', [L.MULTI]: 'Multi-Layer',
  } as Record<number, string>)[l] ?? `Layer ${l}`;
}

/** Order of the layer tabs under the PCB, as Altium lists them. */
export function tabOrder(l: LayerId): number {
  if (l === L.TOP) return 0;
  if (l > L.TOP && l < L.BOTTOM) return l;            // mid-layers in stack order
  if (isPlane(l)) return 40 + (l - L.PLANE1);
  if (l === L.BOTTOM) return 60;
  if (isMech(l)) return 100 + mechNumber(l);
  return 200 + ([L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP_PASTE, L.BOTTOM_PASTE, L.TOP_SOLDER, L.BOTTOM_SOLDER,
    L.DRILL_GUIDE, L.KEEPOUT, L.DRILL_DRAWING, L.MULTI] as number[]).indexOf(l);
}

export function shortLayerName(l: LayerId): string {
  if (l === L.TOP) return 'Top';
  if (l === L.BOTTOM) return 'Bottom';
  if (l > L.TOP && l < L.BOTTOM) return `Mid ${l - 1}`;
  if (isPlane(l)) return `Plane ${l - L.PLANE1 + 1}`;
  if (isMech(l)) return `Mech ${mechNumber(l)}`;
  return ({
    [L.TOP_OVERLAY]: 'Top silk', [L.BOTTOM_OVERLAY]: 'Bot silk', [L.TOP_PASTE]: 'Top paste', [L.BOTTOM_PASTE]: 'Bot paste',
    [L.TOP_SOLDER]: 'Top mask', [L.BOTTOM_SOLDER]: 'Bot mask', [L.DRILL_GUIDE]: 'Drill guide', [L.KEEPOUT]: 'Keep-out',
    [L.DRILL_DRAWING]: 'Drill drawing', [L.MULTI]: 'Multi',
  } as Record<number, string>)[l] ?? `L${l}`;
}

/** V7 32-bit id → internal id. Returns undefined for ids we don't model yet. */
export function fromV7(id: number): LayerId | undefined {
  if (id >= 0x01000000 && id < 0x01010000) {
    const n = id - 0x01000000;
    if (n === 1) return L.TOP;
    if (n === 0xffff) return L.BOTTOM;
    if (n >= 2 && n <= 31) return n; // mid layers
  }
  // Internal planes: 0x01010000 + n
  if (id > 0x01010000 && id <= 0x01010000 + 16) return L.PLANE1 + id - 0x01010001;
  if (id >= 0x01020000 && id < 0x01030000) return mechLayer(id - 0x01020000);
  if (id >= 0x01030000 && id < 0x01040000) {
    return ({ 6: L.TOP_OVERLAY, 7: L.BOTTOM_OVERLAY, 8: L.TOP_PASTE, 9: L.BOTTOM_PASTE, 10: L.TOP_SOLDER, 11: L.BOTTOM_SOLDER,
      12: L.DRILL_GUIDE, 13: L.KEEPOUT, 14: L.DRILL_DRAWING, 15: L.MULTI } as Record<number, LayerId>)[id - 0x01030000];
  }
  return undefined;
}

/** The single-byte V6 id for an internal layer, or 0 if it has none (mech > 16). */
export function toV6Byte(l: LayerId): number { return l > 0 && l <= 82 ? l : 0; }

/**
 * Default display colours — Konium's own palette. Copper follows the industry habit
 * (top warm, bottom cool) so boards read at a glance; everything else is our choice.
 */
const PALETTE: Record<number, number> = {
  [L.TOP]: 0xd9534a, [L.BOTTOM]: 0x4a7fd9,
  [L.TOP_OVERLAY]: 0xe8d77a, [L.BOTTOM_OVERLAY]: 0xb39d4f,
  [L.TOP_PASTE]: 0x8a8a8a, [L.BOTTOM_PASTE]: 0x6f6f6f,
  [L.TOP_SOLDER]: 0x9b5fa8, [L.BOTTOM_SOLDER]: 0x7a4f8f,
  [L.DRILL_GUIDE]: 0x8c3a2a, [L.KEEPOUT]: 0xe0479e,
  [L.DRILL_DRAWING]: 0xc1453a, [L.MULTI]: 0xb8b8b8,
};
const MIDS = [0xd9a14a, 0x4ad99a, 0xa14ad9, 0xd94aa1, 0x4ad9d9, 0x9ad94a];
const MECHS = [0xc87fd9, 0x7fd9c8, 0xd9c87f, 0x8fa0c8, 0xd98f8f, 0x8fd98f, 0xc8c8c8, 0xa07fd9];

/** Display colour: the user's override from Preferences, else the default palette. */
export function layerColour(l: LayerId): number {
  const o = settings.layerColours[String(l)];
  return o ? hexToRgb(o) : defaultLayerColour(l);
}

export function defaultLayerColour(l: LayerId): number {
  if (PALETTE[l] !== undefined) return PALETTE[l]!;
  if (l > L.TOP && l < L.BOTTOM) return MIDS[(l - 2) % MIDS.length]!;
  if (isPlane(l)) return MIDS[(l - L.PLANE1 + 3) % MIDS.length]!;
  if (isMech(l)) return MECHS[(mechNumber(l) - 1) % MECHS.length]!;
  return 0x999999;
}

/**
 * Preferences › PCB Editor › Display › Layer Drawing Order, as AD's: the kinds of layer, the first
 * drawn on top. The current layer draws in its own place (above the other signal layers, below the
 * overlays), the connection lines in theirs, the grid in its (under every layer, over the board).
 */
export const DRAW_ORDER = ['multi', 'topOverlay', 'bottomOverlay', 'connect', 'current', 'signal', 'topPaste', 'bottomPaste',
  'topSolder', 'bottomSolder', 'plane', 'drillGuide', 'keepout', 'mech', 'drillDrawing', 'grid'] as const;
export type DrawKind = typeof DRAW_ORDER[number];
export const DRAW_KIND_NAMES: Record<DrawKind, string> = {
  multi: 'Multi Layer', topOverlay: 'Top Overlay', bottomOverlay: 'Bottom Overlay', connect: 'Connect Layer', current: 'Current Layer',
  signal: 'Signal Layers', topPaste: 'Top Paste', bottomPaste: 'Bottom Paste', topSolder: 'Top Solder Mask', bottomSolder: 'Bottom Solder Mask',
  plane: 'Internal Plane Layers', drillGuide: 'Drill Guide', keepout: 'Keep Out Layer', mech: 'Mechanical Layers', drillDrawing: 'Drill Drawing',
  grid: 'Visible Grids',
};

/** An order as kept (the setting): unknown kinds dropped, a missing one put back after the kind AD has before it. */
export function drawOrder(saved: readonly string[] = settings.pcbLayerDrawOrder): DrawKind[] {
  const out = saved.filter((k, i): k is DrawKind => (DRAW_ORDER as readonly string[]).includes(k) && saved.indexOf(k) === i);
  DRAW_ORDER.forEach((k, i) => {
    if (out.includes(k)) return;
    const before = DRAW_ORDER.slice(0, i).reverse().find((p) => out.includes(p));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, k);
  });
  return out;
}

/** A layer's kind in the drawing order (seen from the bottom, View › Flip Board, a side's layers take the other side's place). */
export function drawKind(l: LayerId, flipped = false): DrawKind {
  const side = (top: DrawKind, bottom: DrawKind, isTop: boolean) => (isTop !== flipped ? top : bottom);
  if (isSignal(l)) return 'signal';
  if (isPlane(l)) return 'plane';
  if (isMech(l)) return 'mech';
  if (l === L.TOP_OVERLAY || l === L.BOTTOM_OVERLAY) return side('topOverlay', 'bottomOverlay', l === L.TOP_OVERLAY);
  if (l === L.TOP_PASTE || l === L.BOTTOM_PASTE) return side('topPaste', 'bottomPaste', l === L.TOP_PASTE);
  if (l === L.TOP_SOLDER || l === L.BOTTOM_SOLDER) return side('topSolder', 'bottomSolder', l === L.TOP_SOLDER);
  return l === L.DRILL_GUIDE ? 'drillGuide' : l === L.KEEPOUT ? 'keepout' : l === L.DRILL_DRAWING ? 'drillDrawing' : 'multi';
}

/** Where a kind draws: higher on top, 100 apart (a layer's place within its kind added: 0–99). */
export function kindZ(k: DrawKind, order: readonly DrawKind[] = drawOrder()): number {
  return (order.length - order.indexOf(k)) * 100;
}

/**
 * Where a layer draws (higher on top): its kind's place in the drawing order — the current layer
 * the current layer's (multi-layer objects keep theirs) — then, within its kind, the side nearer the
 * viewer on top (the top side, or the bottom one with the board flipped), mechanical layers by
 * number, the lowest on top [est].
 */
export function drawZ(l: LayerId, current: LayerId | null = null, flipped = false, order: readonly DrawKind[] = drawOrder()): number {
  const kind: DrawKind = l === current && l !== L.MULTI ? 'current' : drawKind(l, flipped);
  const near = (v: number) => (flipped ? 99 - v : v);
  const within = isSignal(l) ? near(l === L.TOP ? 90 : l === L.BOTTOM ? 10 : 60 - l) : isPlane(l) ? near(60 - (l - L.PLANE1)) : isMech(l) ? 99 - Math.min(mechNumber(l), 99) : 50;
  return kindZ(kind, order) + within;
}

/** Draw order bottom → top when viewed from the top side. */
export function stackOrder(l: LayerId): number {
  if (l === L.BOTTOM_OVERLAY) return 1;
  if (l === L.BOTTOM_PASTE) return 2;
  if (l === L.BOTTOM_SOLDER) return 3;
  if (l === L.BOTTOM) return 10;
  if (isPlane(l)) return 20 + (l - L.PLANE1);
  if (l > L.TOP && l < L.BOTTOM) return 60 - l;
  if (l === L.TOP) return 70;
  if (l === L.MULTI) return 75;
  if (l === L.TOP_SOLDER) return 80;
  if (l === L.TOP_PASTE) return 81;
  if (l === L.TOP_OVERLAY) return 85;
  if (isMech(l)) return 90 + Math.min(mechNumber(l), 9);
  return 100 + l;
}
