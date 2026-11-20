import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { settings, DEFAULTS } from '../src/core/settings';
import { PAGES } from '../src/app/settingsSchema';
import { L } from '../src/model/layers';
import type { DrawGroup, TextItem } from '../src/render/Scene';

const saved = { ...settings };
afterEach(() => { Object.assign(settings, saved); });
const board = () => new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'));
const labels = (ed: PcbEditor): TextItem[] => ((ed.scene() as unknown as { groups: Map<string, DrawGroup> }).groups.get('netlabels')?.texts ?? []);

describe('PCB display Preferences wired in 26.102', () => {
  it('each is on its page with AD\'s default', () => {
    const fields = PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).filter((f) => f.key).map((f) => f.key as string);
    for (const k of ['pcbNetSmartColour', 'pcbNetFont', 'pcbNetStyle', 'pcbNetMinPx', 'pcbNetMaxPx', 'pcbNetMinObjectPx', 'pcbSingleMono', 'pcbMaskTransparent', 'pcbHighlightAllPrims',
      'pcbMaskWhileEditing', 'pcbHighlightWhileEditing', 'pcbViolationOverlay', 'pcbViolationDetails', 'pcbRepaintIndicator']) expect(fields, k).toContain(k);
    expect(DEFAULTS).toMatchObject({ pcbNetSmartColour: true, pcbNetFont: 'Arial', pcbNetStyle: 'Bold', pcbNetMinPx: 8, pcbNetMaxPx: 14, pcbNetMinObjectPx: 3, pcbSingleMono: false,
      pcbMaskTransparent: true, pcbHighlightAllPrims: true, pcbViolationOverlay: true, pcbViolationDetails: true, pcbRepaintIndicator: false });
  });

  it('pad names in the chosen font and style, between the sizes on screen, none on pads too small', () => {
    Object.assign(settings, { pcbShowPadNets: true, pcbShowPadNumbers: true, pcbNetFont: 'Verdana', pcbNetStyle: 'Bold Italic', pcbNetMinPx: 9, pcbNetMaxPx: 20, pcbNetMinObjectPx: 4 });
    const t = labels(board());
    expect(t.length).toBeGreaterThan(4);
    const pad = t.find((x) => x.objSize !== undefined)!;
    expect(pad).toMatchObject({ bold: true, italic: true, minPx: 9, maxPx: 20, objMinPx: 4 });
    expect(pad.family).toMatch(/^"Verdana"/);
    expect(pad.objSize).toBeGreaterThan(0);
  });

  it('violations: the overlay and the crosses each with their switch; Monochrome joins Shift+S', () => {
    const ed = board();
    (ed as unknown as { violations: { prims: number[]; at: { x: number; y: number }; message: string }[] }).violations = [{ prims: [0], at: { x: 0, y: 0 }, message: 'x' }];
    const marks = () => (ed as unknown as { marks(): { items: Set<string>; points: unknown[] } }).marks();
    expect([marks().items.size, marks().points.length]).toEqual([1, 1]);
    Object.assign(settings, { pcbViolationOverlay: false, pcbViolationDetails: false });
    expect([marks().items.size, marks().points.length]).toEqual([0, 0]);
    settings.pcbSingleMono = true;
    ed.cycleSingleLayer(); ed.cycleSingleLayer(); ed.cycleSingleLayer();
    expect(ed.singleLayer).toBe('mono');
    expect(ed.tints()?.get(`L${L.BOTTOM}`)).toEqual({ rgb: 0x6c6c6c, amount: 1 });
  });
});
