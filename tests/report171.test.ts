import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { settings } from '../src/core/settings';
import { L } from '../src/model/layers';
import type { PcbTrack } from '../src/model/pcb';
import type { ToolPointer } from '../src/core/tools';
import type { DrawGroup, TextItem } from '../src/render/Scene';

/**
 * 26.171, from the same report as the tracks that wouldn't drag (tests/pcbdrag.test.ts): what a
 * violation marker means, said where the cursor rests on it; net names on tracks readable on a
 * layer given a light colour.
 */

const saved = { ...settings, layerColours: { ...settings.layerColours } };
afterEach(() => { Object.assign(settings, saved, { layerColours: { ...saved.layerColours } }); });
const board = () => new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'));
const at = (x: number, y: number): ToolPointer => ({ world: { x, y }, raw: { x, y }, button: 0, shift: false, ctrl: false, alt: false });
const labels = (ed: PcbEditor): TextItem[] => ((ed.scene() as unknown as { groups: Map<string, DrawGroup> }).groups.get('netlabels')?.texts ?? []);
const rest = () => new Promise((r) => setTimeout(r, 15));

describe('what a violation is, where the cursor rests on it (26.171)', () => {
  it('with the heads-up display off (as it starts): nothing while the cursor moves, the violation in words once it rests on a marked object or a marker', async () => {
    settings.pcbHudHoverDelay = 0;
    expect(settings.pcbHud).toBe(false);
    const ed = board();
    const t = ed.doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.layer === L.TOP)!;
    const i = ed.doc.prims.indexOf(t), mid = { x: (t.a.x + t.b.x) / 2, y: (t.a.y + t.b.y) / 2 }, far = { x: t.a.x + 50_000_000, y: t.a.y + 50_000_000 };
    // No violations: the cursor rests and nothing is said
    ed.pointerMove(at(mid.x, mid.y));
    await rest();
    expect(ed.hud()).toBeNull();
    const msg = 'Clearance Constraint: (4mil < 10mil) Between Track on Top Layer And Pad C1-1';
    (ed as unknown as { violations: { prims: number[]; at: { x: number; y: number }; message: string; kind: string }[] }).violations = [
      { prims: [i], at: far, message: msg, kind: 'Clearance' },
      ...[1, 2, 3].map((n) => ({ prims: [i], at: far, message: `Width Constraint ${n}`, kind: 'Width' })),
    ];
    // On the marked track: nothing yet, then (the cursor at rest) what it is; three and how to see the rest
    ed.pointerMove(at(mid.x, mid.y));
    expect(ed.hud()).toBeNull();
    await rest();
    expect(ed.hud()).toEqual({ background: true, lines: [`Violation: ${msg}`, 'Violation: Width Constraint 1', 'Violation: Width Constraint 2', 'and 1 more (right-click › Violations, or the PCB Rules And Violations panel)'] });
    // The cursor moves on: gone
    ed.pointerMove(at(mid.x + 1000, mid.y));
    expect(ed.hud()).toBeNull();
    // On the marker itself, away from the object
    ed.pointerMove(at(far.x + 20_000, far.y));
    await rest();
    expect(ed.hud()?.lines[0]).toBe(`Violation: ${msg}`);
    // Somewhere else: nothing
    ed.pointerMove(at(far.x + 9_000_000, far.y));
    await rest();
    expect(ed.hud()).toBeNull();
  });
});

describe('net names on tracks in a colour that stands out (26.171)', () => {
  const trackNames = (ed: PcbEditor) => labels(ed).filter((x) => x.objSize === undefined && /^(GND|VIN|\+3V3)$/.test(x.text));

  it("light on the layers' own colours as before; dark on a layer made a light colour (a pure green is light to the eye, a pure red or blue is not)", () => {
    settings.pcbTrackNetNames = 'single';
    const before = trackNames(board());
    expect(before.length).toBeGreaterThan(3);
    const light = new Set(before.map((x) => x.color));
    expect(light.size).toBe(1);
    for (const [colour, dark] of [['#00ff00', true], ['#ffff00', true], ['#ff00ff', true], ['#ff0000', false], ['#0000ff', false], ['#4a7fd9', false]] as const) {
      settings.layerColours = { [String(L.TOP)]: colour, [String(L.BOTTOM)]: colour };
      const now = new Set(trackNames(board()).map((x) => x.color));
      expect(now.size, colour).toBe(1);
      expect([...now][0] !== [...light][0], colour).toBe(dark);
    }
    // Smart Display Colour off: light whatever the layer
    Object.assign(settings, { pcbNetSmartColour: false, layerColours: { [String(L.TOP)]: '#00ff00', [String(L.BOTTOM)]: '#00ff00' } });
    expect(new Set(trackNames(board()).map((x) => x.color))).toEqual(light);
  });
});
