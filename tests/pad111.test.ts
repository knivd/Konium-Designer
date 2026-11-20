import { afterEach, describe, expect, it } from 'vitest';
import padSrc from '../src/app/dialogs/PadDialog.tsx?raw';
import routingSrc from '../src/app/dialogs/RoutingDialog.tsx?raw';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { RouteTool } from '../src/editors/pcb/RouteTool';
import { settings } from '../src/core/settings';
import { padExtrasOf, setPadExtras } from '../src/formats/altium/primInfo';
import { padTemplateName, padTemplates, viaTemplateName } from '../src/model/padTemplates';
import { drawLayer, solderMask } from '../src/formats/gerber/gerber';
import { PAD, get, put } from '../src/formats/altium/pcbLayouts';
import { L } from '../src/model/layers';
import { mil, mm } from '../src/core/units';
import type { PcbPad } from '../src/model/pcb';

const saved = structuredClone({ ...settings });
afterEach(() => { Object.assign(settings, structuredClone(saved)); });
const board = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');

describe('Pad and Interactive Routing dialogs once greyed (26.111)', () => {
  it('no control in them is marked as not built', () => {
    for (const src of [padSrc, routingSrc]) expect(src).not.toMatch(/not in Konium yet|isn't read yet|aren't in Konium yet|Not read from the file yet|Konium routes one width/i);
  });

  it('pad templates: named as AD names them, the board\'s own on offer', () => {
    const doc = board();
    const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad');
    for (const p of pads) expect(padTemplateName(p)).toMatch(/^(c|s|r|o|x|rr)\d+(_\d+)?(h\d+)?$/);
    const thru = pads.find((p) => p.layer === L.MULTI && p.hole > 0);
    if (thru) expect(padTemplateName(thru)).toMatch(new RegExp(`h${Math.round(thru.hole / mm(0.01))}$`));
    expect(padTemplates(doc).size).toBeGreaterThan(0);
    expect(viaTemplateName(mil(50), mil(28))).toBe('v127h71');
  });

  it('the bottom solder mask expansion unlinked, and the opening from the hole\'s edge', () => {
    const doc = board();
    const p = doc.prims.find((q): q is PcbPad => q.kind === 'pad' && q.layer === L.MULTI && q.hole > 0)!;
    const rec = doc.streams.get(p.src.storage)!.records[p.src.index]!;
    put(rec.subs[4]!, PAD.solderMode, 2); put(rec.subs[4]!, PAD.solderManual, mil(4));
    expect(solderMask(doc, p, false)).toBe(mil(4));
    setPadExtras(rec, { bottom: '6mil', fromHoleEdge: true });
    expect(padExtrasOf(rec)).toEqual({ bottom: '6mil', fromHoleEdge: true });
    expect(solderMask(doc, p, true)).toBe(mil(4));
    expect(solderMask(doc, p, false)).toBe(mil(6));
    // On the top solder mask: the hole grown by 4 mil, not the pad
    const sizes: number[] = [];
    const sink = new Proxy({}, { get: (_t, k) => (k === 'pad' ? (at: { x: number; y: number }, st: { w: number }) => { if (at.x === p.at.x && at.y === p.at.y) sizes.push(st.w); } : () => {}) });
    drawLayer(sink as never, doc, L.TOP_SOLDER, { outlineOnMech1: false, notes: new Set() });
    expect(sizes).toContain(p.hole + 2 * mil(4));
    setPadExtras(rec, {});
    expect(padExtrasOf(rec)).toEqual({});
  });

  it('a pad\'s electrical type: Load as AD writes it', () => {
    const doc = board();
    const p = doc.prims.find((q): q is PcbPad => q.kind === 'pad')!;
    expect(get(doc.streams.get(p.src.storage)!.records[p.src.index]!.subs[4]!, PAD.electrical)).toBe(0);
  });

  it('Apply to all layers off: a layer keeps a width of its own', () => {
    const ed = new PcbEditor(board());
    const tool = new RouteTool(ed);
    settings.pcbTrackWidth = 10;
    tool.setUserWidth(mil(10));
    tool.setLayerWidth(L.BOTTOM, mil(20));
    ed.currentLayer = L.BOTTOM;
    (tool as unknown as { widthFromRule(): void }).widthFromRule();
    expect(ed.trackWidth).toBe(mil(20));
    ed.currentLayer = L.TOP;
    (tool as unknown as { widthFromRule(): void }).widthFromRule();
    expect(ed.trackWidth).toBe(mil(10));
    tool.setUserWidth(mil(12));
    expect(ed.layerWidths.size).toBe(0);
  });
});
