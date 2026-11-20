/**
 * Follow Mouse Trail (26.185: Preferences › PCB Editor › Interactive Routing; it was greyed, "Not
 * available yet"). In Walkaround Obstacles the route takes the way the cursor went since the last
 * click: round the side of an obstacle the cursor went round, not the shorter way to where it is.
 */
import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { RouteTool } from '../src/editors/pcb/RouteTool';
import { NO_NET, type PcbTrack } from '../src/model/pcb';
import { addNet } from '../src/model/pcbEdit';
import { L } from '../src/model/layers';
import { mil } from '../src/core/units';
import { settings, updateSettings } from '../src/core/settings';
import type { ToolPointer } from '../src/core/tools';
import type { TrackFields } from '../src/formats/altium/pcbdoc';

const at = (x: number, y: number): ToolPointer => ({ world: { x: mil(x), y: mil(y) }, raw: { x: mil(x), y: mil(y) }, button: 0, shift: false, ctrl: false, alt: false });

describe('Follow Mouse Trail (26.185)', () => {
  /** A board with a wall of another net's copper across the straight way from (2000, 2000) to (3000, 2000): from y 1900 to y 2150, so that the way under it is the shorter. */
  const board = () => {
    const doc = readPcbDoc(newPcbDocBytes('PCB1.PcbDoc'), 'PCB1.PcbDoc');
    addNet(doc, 'A').apply(); addNet(doc, 'B').apply();
    const wall: PcbTrack = { kind: 'track', src: { storage: 'Tracks6', index: 0 }, layer: L.TOP, a: { x: mil(2500), y: mil(1900) }, b: { x: mil(2500), y: mil(2150) }, width: mil(20), net: doc.nets.length - 1, component: NO_NET, polygon: NO_NET, locked: false, keepout: false } as PcbTrack;
    doc.prims.push(wall);
    const ed = new PcbEditor(doc);
    ed.scene(); ed.currentLayer = L.TOP;
    return ed;
  };
  /** The look-ahead's segments after the cursor has gone from the start along `path`. */
  const look = (path: [number, number][]): TrackFields[] => {
    const ed = board(), tool = new RouteTool(ed);
    ed.setTool(tool);
    tool.pointerMove(at(2000, 2000)); tool.pointerDown(at(2000, 2000));
    for (const [x, y] of path) tool.pointerMove(at(x, y));
    const segs = (tool as unknown as { look: { segs: TrackFields[]; blocked: boolean } }).look;
    tool.cancel();
    expect(segs.blocked).toBe(false);
    return segs.segs;
  };
  const top = (s: TrackFields[]) => Math.max(...s.flatMap((t) => [t.a.y, t.b.y])) / mil(1), foot = (s: TrackFields[]) => Math.min(...s.flatMap((t) => [t.a.y, t.b.y])) / mil(1);
  /** Over the wall's top and down to the far side, and under its foot likewise, a point every 25 mil. */
  const arc = (peak: number): [number, number][] => Array.from({ length: 41 }, (_, i) => [2000 + i * 25, 2000 + (peak - 2000) * Math.sin((Math.PI * i) / 40)] as [number, number]);
  const straight: [number, number][] = Array.from({ length: 41 }, (_, i) => [2000 + i * 25, 2000] as [number, number]);

  it('off, the route goes round the wall the shorter way wherever the cursor has been; on, the way the cursor went', () => {
    const was = { mode: settings.pcbRoutingMode, trail: settings.pcbFollowMouseTrail, gloss: settings.pcbGlossRouted };
    try {
      updateSettings({ pcbRoutingMode: 'walkaround', pcbFollowMouseTrail: false });
      // The wall's foot is 100 mil under the straight way and its top 150 mil over: round the foot is shorter
      const off = look(arc(2400)), offStraight = look(straight);
      expect(foot(off)).toBeLessThan(1900); expect(top(off)).toBeLessThan(2100);
      expect(look(arc(1700)).map((t) => [t.a, t.b])).toEqual(off.map((t) => [t.a, t.b]));
      updateSettings({ pcbFollowMouseTrail: true });
      // The cursor over the top: the route goes over the top, and ends where the cursor is
      const over = look(arc(2400));
      expect(top(over)).toBeGreaterThan(2150); expect(foot(over)).toBeGreaterThanOrEqual(2000);
      expect(over.at(-1)!.b).toEqual({ x: mil(3000), y: mil(2000) }); expect(over[0]!.a).toEqual({ x: mil(2000), y: mil(2000) });
      // …and it is a route: each segment starts where the last ended, clear of the wall
      for (let i = 1; i < over.length; i++) expect(over[i]!.a).toEqual(over[i - 1]!.b);
      // The cursor under the foot: under the foot
      const under = look(arc(1700));
      expect(foot(under)).toBeLessThan(1900); expect(top(under)).toBeLessThanOrEqual(2000);
      // A cursor that went straight (through the wall) turns nowhere: the usual way, as with the option off
      expect(look(straight).map((t) => [t.a, t.b])).toEqual(offStraight.map((t) => [t.a, t.b]));
      expect(foot(look(straight))).toBeLessThan(1900);
      // Small wobbles of the hand about the straight way are not turns
      const wobble: [number, number][] = straight.map(([x, y], i) => [x, y + (i % 2 ? 4 : -4)] as [number, number]);
      wobble[wobble.length - 1] = [3000, 2000];
      expect(look(wobble).map((t) => [t.a, t.b])).toEqual(look(straight).map((t) => [t.a, t.b]));
    } finally {
      updateSettings({ pcbRoutingMode: was.mode, pcbFollowMouseTrail: was.trail, pcbGlossRouted: was.gloss });
    }
  });

  it('the trail is kept from the last click only', () => {
    const was = { mode: settings.pcbRoutingMode, trail: settings.pcbFollowMouseTrail };
    try {
      updateSettings({ pcbRoutingMode: 'walkaround', pcbFollowMouseTrail: true });
      const ed = board(), tool = new RouteTool(ed);
      ed.setTool(tool);
      tool.pointerMove(at(2000, 2000)); tool.pointerDown(at(2000, 2000));
      for (const [x, y] of arc(2400).slice(0, 12)) tool.pointerMove(at(x, y));
      const t = tool as unknown as { trail: unknown[]; head: unknown; trailFrom: unknown };
      expect(t.trail.length).toBeGreaterThan(3);
      const last = arc(2400)[11]!;
      tool.pointerDown(at(last[0], last[1]));
      tool.pointerMove(at(last[0] + 1, last[1]));
      expect(t.trail.length).toBeLessThanOrEqual(1); expect(t.trailFrom).toBe(t.head);
      tool.cancel();
    } finally {
      updateSettings({ pcbRoutingMode: was.mode, pcbFollowMouseTrail: was.trail });
    }
  });
});
