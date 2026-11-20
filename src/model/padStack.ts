/**
 * A pad's or via's copper on each layer, as AD makes it: a Simple stack is the top's shape
 * everywhere, Top-Middle-Bottom the middle's on every inner layer, Full Stack each inner layer's
 * own; a via may have its own diameter per layer. Where Remove Unused Pad Shapes took an inner
 * layer's shape off, there is no copper there, only the hole.
 */
import { L, type LayerId } from './layers';
import type { PadStackLayer, PcbPad, PcbVia } from './pcb';

/** Whether the shape was removed on an inner layer. */
export const removedOn = (p: { removed?: number }, l: LayerId): boolean =>
  !!p.removed && l !== L.TOP && l !== L.BOTTOM && l >= L.TOP && l <= L.BOTTOM && (p.removed >>> (l - 1)) % 2 === 1;

/** A through pad's shape on a copper layer, removed or not. */
export function padLayer(p: PcbPad, l: LayerId): PadStackLayer {
  if (l === L.TOP || !p.stackMode) return p.top;
  if (l === L.BOTTOM) return p.bot;
  return p.inner?.[l - L.MID1] ?? p.mid;
}

/** A through pad's copper on a layer: null where its shape was removed. */
export function padShapeOn(p: PcbPad, l: LayerId): PadStackLayer | null {
  return removedOn(p, l) ? null : padLayer(p, l);
}

/** A via's diameter on a layer it spans: null where its shape was removed (or is no bigger than the hole). */
export function viaDiameterOn(v: PcbVia, l: LayerId): number | null {
  if (removedOn(v, l)) return null;
  const d = v.layerDiameters?.[l - 1];
  if (v.layerDiameters && d !== undefined) return d > v.hole ? d : null;
  return v.diameter;
}
