import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { settings, DEFAULTS } from '../src/core/settings';
import { PAGES } from '../src/app/settingsSchema';
import { DEFAULT_SHORTCUTS } from '../src/app/commands';
import type { PcbPad } from '../src/model/pcb';

const saved = { ...settings };
afterEach(() => { Object.assign(settings, saved); });
const board = () => { const ed = new PcbEditor(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc')); ed.scene(); return ed; };
const at = (x: number, y: number, shift = false) => ({ world: { x, y }, raw: { x, y }, button: 0, shift, ctrl: false, alt: false });

describe('Board Insight in 26.103: live highlighting and the heads-up display', () => {
  it('each setting is on its page with AD\'s default; Shift+H and Insert bound on the board', () => {
    const fields = PAGES.flatMap((p) => p.sections.flatMap((s) => s.fields)).filter((f) => f.key).map((f) => f.key as string);
    for (const k of ['pcbLive', 'pcbLiveShift', 'pcbLiveUp', 'pcbLiveDown', 'pcbLiveStrength', 'pcbHud', 'pcbHudBackground', 'pcbHudInsertResets', 'pcbHudClickResets', 'pcbHudHoverDelay',
      'pcbHudCursor', 'pcbHudDelta', 'pcbHudLayer', 'pcbHudGrid', 'pcbHudSummary', 'pcbHudShortcuts', 'pcbHudViolations', 'pcbHudNet', 'pcbHudComponent', 'pcbHudPrimitive']) expect(fields, k).toContain(k);
    expect(DEFAULTS).toMatchObject({ pcbLive: true, pcbLiveShift: false, pcbLiveUp: 250, pcbLiveDown: 1000, pcbLiveStrength: 60, pcbHud: false, pcbHudHoverDelay: 1000, pcbHudCursor: true, pcbHudSummary: false });
    expect(DEFAULT_SHORTCUTS).toEqual(expect.arrayContaining([{ combo: 'Shift+H', command: 'pcb.headsUp', scopes: ['pcb', 'pcblib'] }, { combo: 'Insert', command: 'pcb.headsUpReset', scopes: ['pcb', 'pcblib'] }]));
  });

  it('the net under the cursor lights up (only with Shift, if so set), as strongly as set', () => {
    const ed = board();
    const pad = ed.doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.net !== 0xffff)!;
    ed.pointerMove(at(pad.at.x, pad.at.y));
    expect(ed.liveHighlightNet).toBe(pad.net);
    const live = (ed as unknown as { liveHighlight(): { outlines: { net?: number }[]; outlineAlpha: number; alpha: number } | null }).liveHighlight()!;
    expect(live.outlines.every((i) => i.net === pad.net)).toBe(true);
    expect(live.outlineAlpha).toBeCloseTo(0.6);
    expect(live.alpha).toBeCloseTo(0.3);
    ed.pointerMove(at(-1e9, -1e9));
    expect(ed.liveHighlightNet).toBeNull();
    settings.pcbLiveShift = true;
    ed.pointerMove(at(pad.at.x, pad.at.y));
    expect(ed.liveHighlightNet).toBeNull();
    ed.pointerMove(at(pad.at.x, pad.at.y, true));
    expect(ed.liveHighlightNet).toBe(pad.net);
  });

  it('the heads-up display: the cursor, the delta from the last click, layer and grid; the net and the object under it when asked', () => {
    const ed = board();
    expect(ed.hud()).toBeNull();
    settings.pcbHud = true;
    const pad = ed.doc.prims.find((p): p is PcbPad => p.kind === 'pad' && p.net !== 0xffff)!;
    ed.pointerDown(at(pad.at.x, pad.at.y));
    ed.pointerMove(at(pad.at.x, pad.at.y));
    let h = ed.hud()!;
    expect(h.background).toBe(true);
    expect(h.lines[0]).toMatch(/^x: .* {2}y: /);
    expect(h.lines[1]).toBe('dx: 0mil  dy: 0mil');
    expect(h.lines[3]).toMatch(/^Snap: /);
    Object.assign(settings, { pcbHudNet: true, pcbHudPrimitive: true, pcbHudSummary: true });
    h = ed.hud()!;
    expect(h.lines.some((l) => /^Net /.test(l))).toBe(true);
    expect(h.lines.some((l) => /^Pad /.test(l))).toBe(true);
    expect(h.lines.some((l) => /^\d+ objects?: /.test(l))).toBe(true);
  });
});
