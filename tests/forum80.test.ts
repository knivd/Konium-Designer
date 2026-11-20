import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { DRAW_ORDER, L, drawOrder, drawZ, mechLayer } from '../src/model/layers';
import { DEFAULTS, settings, updateSettings } from '../src/core/settings';

/* ─── Layer Drawing Order (forum: mechanical layers drawn over the silkscreen) ───────── */

describe('layers drawn in AD\'s Layer Drawing Order (26.080)', () => {
  afterEach(() => { updateSettings({ pcbLayerDrawOrder: [...DEFAULTS.pcbLayerDrawOrder] }); });
  const above = (a: number, b: number, current: number | null = null, flipped = false) => drawZ(a, current, flipped) > drawZ(b, current, flipped);
  it('AD\'s default: multi-layer, the overlays, the current layer, the signal layers, paste, mask, planes, drill guide, keep-out, mechanical, drill drawing', () => {
    expect(drawOrder()).toEqual([...DRAW_ORDER]);
    // The silkscreen over the mechanical layers
    expect(above(L.TOP_OVERLAY, mechLayer(1))).toBe(true);
    expect(above(L.BOTTOM_OVERLAY, mechLayer(13))).toBe(true);
    const down = [L.MULTI, L.TOP_OVERLAY, L.BOTTOM_OVERLAY, L.TOP, L.BOTTOM, L.TOP_PASTE, L.BOTTOM_PASTE, L.TOP_SOLDER, L.BOTTOM_SOLDER, L.PLANE1, L.DRILL_GUIDE, L.KEEPOUT, mechLayer(1), mechLayer(13), L.DRILL_DRAWING];
    for (let i = 1; i < down.length; i++) expect(above(down[i - 1]!, down[i]!), `${down[i - 1]} over ${down[i]}`).toBe(true);
    // The current layer over the other signal layers, under the overlays; a mechanical layer current comes up too
    expect(above(L.BOTTOM, L.TOP, L.BOTTOM)).toBe(true);
    expect(above(L.BOTTOM_OVERLAY, L.BOTTOM, L.BOTTOM)).toBe(true);
    expect(above(mechLayer(1), L.TOP, mechLayer(1))).toBe(true);
    expect(above(L.MULTI, L.TOP, L.MULTI)).toBe(true);
    // Seen from the bottom (View › Flip Board): the bottom side's layers over the top's
    expect(above(L.BOTTOM_OVERLAY, L.TOP_OVERLAY, null, true)).toBe(true);
    expect(above(L.BOTTOM, L.TOP, null, true)).toBe(true);
    expect(above(L.TOP, L.BOTTOM)).toBe(true);
  });
  it('an order of one\'s own: kept as set, kinds it doesn\'t know dropped and missing ones put back', () => {
    expect(drawOrder(['mech', 'multi', 'nonsense', 'mech'])).toEqual(['mech', 'drillDrawing', 'grid', 'multi', ...DRAW_ORDER.slice(1, 13)]);
    updateSettings({ pcbLayerDrawOrder: ['mech', ...DRAW_ORDER.filter((k) => k !== 'mech')] });
    expect(above(mechLayer(1), L.TOP_OVERLAY)).toBe(true);
    expect(above(mechLayer(1), L.MULTI)).toBe(true);
  });
  it('the board drawn so: each layer\'s group where the order puts it, the connections and the grid in their places', () => {
    const ed = new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'));
    ed.setCurrentLayer(L.TOP);
    const s = ed.scene(), z = (k: string) => s.groups.get(k)?.z ?? NaN;
    expect(z(`L${L.TOP_OVERLAY}`)).toBeGreaterThan(z(`L${mechLayer(1)}`));
    expect(z(`L${L.MULTI}`)).toBeGreaterThan(z(`L${L.TOP_OVERLAY}`));
    expect(z('vias')).toBeGreaterThan(z(`L${L.TOP_OVERLAY}`));
    expect(z('connections')).toBeGreaterThan(z(`L${L.TOP}`));
    expect(z('connections')).toBeLessThan(z(`L${L.BOTTOM_OVERLAY}`));
    // The grid over the board, under every layer
    expect(ed.gridAbove).toBe('gridmark');
    expect(z('gridmark')).toBeGreaterThan(z('board'));
    for (const [k, g] of s.groups) if (/^L\d+$/.test(k)) expect(g.z, k).toBeGreaterThan(z('gridmark'));
    expect(settings.pcbLayerDrawOrder).toEqual([...DRAW_ORDER]);
  });
});
