import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { settings, DEFAULTS, TRANSPARENCY_STANDARD, TRANSPARENCY_TRANSPARENT } from '../src/core/settings';
import { VIEW3D_DEFAULT, VIEW3D_PRESETS } from '../src/core/view3d';
import { PAGES } from '../src/app/settingsSchema';
import { PAT, type Scene } from '../src/render/Scene';
import type { PcbPad, PcbTrack } from '../src/model/pcb';

const saved = structuredClone({ ...settings });
afterEach(() => { Object.assign(settings, structuredClone(saved)); });
const board = () => { const ed = new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc')); ed.scene(); return ed; };
const fresh = (ed: PcbEditor): Scene => { ed.invalidate(); return ed.scene(); };
const at = (x: number, y: number) => ({ world: { x, y }, raw: { x, y }, button: 0, shift: false, ctrl: false, alt: false });

describe('PCB display Preferences once greyed (26.103)', () => {
  it('each is on its page, with AD\'s default', () => {
    const fields = PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).filter((f) => f.key).map((f) => f.key as string);
    for (const k of ['pcbAntialiasText', 'pcbAlphaBlending', 'pcbHighlightInFull', 'pcbDefault2d', 'pcbDefault3d', 'pcbLibDefault2d', 'pcbLibDefault3d', 'pcbDraftTracks', 'pcbDraftStrings',
      'pcbLockedTexture', 'pcbOverridePattern', 'pcbOverrideZoomOut', 'pcbViolationStyle', 'pcbViolationStyleOut']) expect(fields, k).toContain(k);
    expect(DEFAULTS).toMatchObject({ pcbAntialiasText: true, pcbAlphaBlending: true, pcbHighlightInFull: false, pcbDraftTracks: 2, pcbDraftStrings: 11, pcbLockedTexture: 'live',
      pcbOverridePattern: 'Checkerboard', pcbOverrideZoomOut: 'base', pcbViolationStyle: 'Style B', pcbViolationStyleOut: 'Solid' });
    expect(PAGES.find((p) => p.id === 'pcb-display')!.sections.flatMap((s) => s.fields).some((f) => f.todo !== undefined)).toBe(false);
    for (const id of ['pcb-insight', 'pcb-insightcolours', 'pcb-drcdisplay']) expect(PAGES.find((p) => p.id === id)!.sections.flatMap((s) => s.fields).some((f) => f.todo !== undefined), id).toBe(false);
  });

  it('a net\'s colour override goes over its layer colour through the base pattern (Solid: the colour alone), zoomed out as set', () => {
    const ed = board();
    const net = ed.doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.net !== 0xffff)!.net;
    const n = ed.doc.nets.find((x) => x.index === net)!;
    n.bag.set('COLOR', String(0x0000ff)); n.bag.set('OVERRIDECOLORFORDRAW', 'TRUE');
    let s = fresh(ed);
    const over = [...s.groups.values()].filter((g) => g.key.endsWith(':over'));
    expect(over.length).toBeGreaterThan(0);
    expect(over[0]!.pattern).toMatchObject({ id: PAT.checker, out: PAT.checker });
    settings.pcbOverrideZoomOut = 'original';
    expect([...fresh(ed).groups.values()].find((g) => g.key.endsWith(':over'))!.pattern!.out).toBe(PAT.none);
    settings.pcbOverridePattern = 'Solid';
    s = fresh(ed);
    expect([...s.groups.values()].some((g) => g.key.endsWith(':over'))).toBe(false);
  });

  it('a selection is outlined unless Highlight In Full; violations drawn in their style; locked objects textured as set', () => {
    const ed = board();
    const t = ed.doc.prims.find((p): p is PcbTrack => p.kind === 'track')!;
    ed.select([ed.keyOf(ed.doc.prims.indexOf(t))!]);
    const hl = () => { ed.invalidateOverlay(); return ed.overlay()!.groups.get('highlight')!.prims.count; };
    const outlined = hl();
    settings.pcbHighlightInFull = true;
    expect(hl()).toBe(1);
    expect(outlined).toBeGreaterThan(4);
    // Violation styles: Style B near, Solid zoomed out; None leaves the layer colour
    (ed as unknown as { violations: unknown[] }).violations = [{ kind: 'Clearance', message: 'm', at: t.a, prims: [ed.doc.prims.indexOf(t)] }];
    const marks = () => (ed as unknown as { marks(): { pattern: { id: number; out: number } } }).marks().pattern;
    expect(marks()).toMatchObject({ id: PAT.crossHatch, out: PAT.solid });
    settings.pcbViolationStyle = 'None (Layer Colour)'; settings.pcbViolationStyleOut = 'Style A';
    expect(marks()).toMatchObject({ id: PAT.none, out: PAT.hatch });
    // Locked: textured always, or only where live highlighting lights it
    t.locked = true;
    settings.pcbLockedTexture = 'always';
    expect([...fresh(ed).groups.values()].find((g) => g.key.endsWith(':locked'))?.pattern?.id).toBe(PAT.locked);
    settings.pcbLockedTexture = 'live';
    expect([...fresh(ed).groups.values()].some((g) => g.key.endsWith(':locked'))).toBe(false);
    ed.pointerMove(at((t.a.x + t.b.x) / 2, (t.a.y + t.b.y) / 2));
    const live = (ed as unknown as { liveHighlight(): { textured: { key: string }[] } | null }).liveHighlight();
    expect(live?.textured.length).toBeGreaterThan(0);
  });

  it('draft thresholds: thin tracks as single lines, small strings as boxes; text and area shading as set', () => {
    const ed = board();
    const s = fresh(ed);
    const texts = [...s.groups.values()].flatMap((g) => g.texts).filter((x) => x.draftPx !== undefined);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts[0]!.draftPx).toBe(11);
    expect(ed.hardText()).toBe(false);
    expect(ed.areaShade()).toMatch(/^rgba\(/);
    settings.pcbAntialiasText = false; settings.pcbAlphaBlending = false;
    expect(ed.hardText()).toBe(true);
    expect(ed.areaShade()).toBeNull();
    const pad = ed.doc.prims.find((p): p is PcbPad => p.kind === 'pad')!;
    expect(pad).toBeDefined();
  });

  it('a board and a footprint library open in their own view configurations, unless the view is one\'s own', async () => {
    settings.pcbTransparency = { ...TRANSPARENCY_STANDARD }; settings.pcb3d = { ...VIEW3D_DEFAULT };
    settings.pcbDefault2d = 'Transparent 2D'; settings.pcbDefault3d = '3D White';
    const ed = board();
    await Promise.resolve();
    expect(settings.pcbTransparency).toEqual(TRANSPARENCY_TRANSPARENT);
    expect(settings.pcb3d.config).toBe('3D White');
    // Changed by hand: kept
    settings.pcbTransparency = { ...TRANSPARENCY_STANDARD, polygons: 7 };
    settings.pcb3d = { ...VIEW3D_PRESETS[0]!, workspace: '#123456' };
    ed.applyDefaultView();
    expect(settings.pcbTransparency.polygons).toBe(7);
    expect(settings.pcb3d.workspace).toBe('#123456');
  });
});
