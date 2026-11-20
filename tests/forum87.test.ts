import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { RouteTool } from '../src/editors/pcb/RouteTool';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { DEFAULTS, fromStored, settings, updateSettings } from '../src/core/settings';
import { mil } from '../src/core/units';
import { L } from '../src/model/layers';
import type { PcbTrack } from '../src/model/pcb';

describe('forum (26.087): tracks at any angle in Interactive Routing', () => {
  it('Restrict To 90/45 is off as in AD, and earlier builds\' default is taken off too (a choice made since stays)', () => {
    expect(DEFAULTS.pcbRestrict9045).toBe(false);
    expect(fromStored({ pcbRestrict9045: true, settingsRev: 4 }).pcbRestrict9045).toBe(false);
    expect(fromStored({ pcbRestrict9045: true, settingsRev: 5 }).pcbRestrict9045).toBe(true);
  });
  it('Shift+Space reaches any angle while routing, and the track goes straight to the cursor in each conflict mode', () => {
    const was = { mode: settings.pcbRoutingMode, r: settings.pcbRestrict9045 };
    for (const mode of ['hug', 'walkaround', 'push', 'ignore'] as const) {
      updateSettings({ pcbRoutingMode: mode, pcbRestrict9045: false });
      const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
      const ed = new PcbEditor(doc);
      ed.scene();
      const pad = doc.prims.find((p) => p.kind === 'pad' && p.net !== 0xffff && p.layer === L.TOP)! as { at: { x: number; y: number } };
      const tool = new RouteTool(ed);
      ed.setTool(tool);
      while ((tool as unknown as { corner: string }).corner !== 'any') tool.key('Shift+Space');
      const go = (dx: number, dy: number) => ({ world: { x: pad.at.x + mil(dx), y: pad.at.y + mil(dy) }, raw: { x: pad.at.x + mil(dx), y: pad.at.y + mil(dy) }, button: 0, shift: false, ctrl: false, alt: false });
      const before = doc.prims.filter((p) => p.kind === 'track').length;
      tool.pointerMove(go(0, 0)); tool.pointerDown(go(0, 0));
      tool.pointerMove(go(-170, 60)); tool.pointerDown(go(-170, 60));
      tool.cancel();
      const added = doc.prims.filter((p): p is PcbTrack => p.kind === 'track').slice(before);
      const angles = added.map((t) => Math.round((Math.atan2(t.b.y - t.a.y, t.b.x - t.a.x) * 180) / Math.PI));
      expect([mode, added.length >= 1, angles.some((a) => a % 45 !== 0)]).toEqual([mode, true, true]);
    }
    updateSettings({ pcbRoutingMode: was.mode, pcbRestrict9045: was.r });
  });
});
