import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { RouteTool } from '../src/editors/pcb/RouteTool';
import { RouteWorld, noPending } from '../src/model/router';
import { NO_NET, type PcbTrack } from '../src/model/pcb';
import { addPads } from '../src/model/pcbEdit';
import { L } from '../src/model/layers';
import { mil } from '../src/core/units';
import { settings, updateSettings } from '../src/core/settings';
import type { ToolPointer } from '../src/core/tools';

const at = (x: number, y: number): ToolPointer => ({ world: { x: mil(x), y: mil(y) }, raw: { x: mil(x), y: mil(y) }, button: 0, shift: false, ctrl: false, alt: false });

describe('a route with no net (26.177)', () => {
  it('copper with no net is not in its way (its own stretch, a track or a pad with no net); a net\'s copper is, and it in a net\'s', () => {
    const doc = readPcbDoc(newPcbDocBytes('PCB1.PcbDoc'), 'PCB1.PcbDoc');
    const own = { layer: L.TOP, a: { x: mil(2000), y: mil(2000) }, b: { x: mil(2500), y: mil(2000) }, width: mil(10), net: NO_NET };
    const track = (net: number): PcbTrack => ({ kind: 'track', src: { storage: 'Tracks6', index: 0 }, layer: L.TOP, a: { x: mil(2300), y: mil(2400) }, b: { x: mil(2700), y: mil(2400) }, width: mil(10), net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false }) as PcbTrack;
    const on = [{ x: mil(2500), y: mil(2000) }, { x: mil(2500), y: mil(2400) }];
    // The route's own first stretch: it goes on from its end (it stopped there in every mode but Ignore Obstacles)
    const w = new RouteWorld(doc, L.TOP, noPending(), { tracks: [own] });
    expect(w.clear(NO_NET, mil(10), on)).toBe(true);
    // A net's route is stopped by copper with no net, as by any copper not its own
    expect(w.clear(0, mil(10), on)).toBe(false);
    // A track with no net on the board: the route may end on it; a track of a net stops it at the clearance
    const none = readPcbDoc(newPcbDocBytes('PCB1.PcbDoc'), 'PCB1.PcbDoc');
    none.prims.push(track(NO_NET));
    expect(new RouteWorld(none, L.TOP, noPending(), { tracks: [own] }).clear(NO_NET, mil(10), on)).toBe(true);
    const net = readPcbDoc(newPcbDocBytes('PCB1.PcbDoc'), 'PCB1.PcbDoc');
    net.nets.push({ name: 'A' } as (typeof net.nets)[number]);
    net.prims.push(track(net.nets.length - 1));
    const w3 = new RouteWorld(net, L.TOP, noPending(), { tracks: [own] });
    expect(w3.clear(NO_NET, mil(10), on)).toBe(false);
    expect(w3.clear(NO_NET, mil(10), [on[0]!, { x: mil(2500), y: mil(2300) }])).toBe(true);
    // The board's edge stops it like any route
    expect(w.clear(NO_NET, mil(10), [on[0]!, { x: mil(2500), y: mil(900) }])).toBe(false);
  });

  it('a board with no netlist: a route from a pad to a pad starts and ends at their centres and is one joined run', () => {
    const doc = readPcbDoc(newPcbDocBytes('PCB1.PcbDoc'), 'PCB1.PcbDoc');
    const A = { x: mil(2000), y: mil(2000) }, B = { x: mil(2900), y: mil(2500) }, C = { x: mil(2450), y: mil(2000) };
    // Three pads with no net; the third stands on the straight way from the first: among copper with no net nothing is gone round
    addPads(doc, [A, B, C].map((at, i) => ({ name: String(i + 1), layer: L.TOP, at, w: mil(60), h: mil(60), shape: 'round' as const }))).apply();
    const ed = new PcbEditor(doc);
    ed.scene();
    const was = settings.pcbRoutingMode;
    updateSettings({ pcbRoutingMode: 'hug' });
    const tool = new RouteTool(ed);
    ed.setTool(tool);
    const P = (v: { x: number; y: number }, dx = 0, dy = 0): ToolPointer => ({ world: { x: v.x + dx, y: v.y + dy }, raw: { x: v.x + dx, y: v.y + dy }, button: 0, shift: false, ctrl: false, alt: false });
    // A press a little off the first pad's centre starts at the centre; one a little off the second's ends the route on its centre
    tool.pointerMove(P(A, mil(3), mil(2))); tool.pointerDown(P(A, mil(3), mil(2)));
    tool.pointerMove(P(B, mil(-4), mil(3))); tool.pointerDown(P(B, mil(-4), mil(3)));
    expect((tool as unknown as { look: { blocked?: boolean } }).look.blocked ?? false).toBe(false);
    tool.cancel();
    const tracks = ed.doc.prims.filter((p): p is PcbTrack => p.kind === 'track');
    expect(tracks.length).toBe(2);
    expect(tracks[0]!.a).toEqual(A);
    expect(tracks.at(-1)!.b).toEqual(B);
    expect(tracks[1]!.a).toEqual(tracks[0]!.b);
    expect(tracks.every((t) => t.net === NO_NET)).toBe(true);
    updateSettings({ pcbRoutingMode: was });
  });

  for (const mode of ['hug', 'push', 'walkaround', 'stop'] as const) {
    it(`Place › Interactive Routing on an empty board (${mode}): each click fixes the stretch behind the look-ahead, and the route goes on`, () => {
      const doc = readPcbDoc(newPcbDocBytes('PCB1.PcbDoc'), 'PCB1.PcbDoc');
      const ed = new PcbEditor(doc);
      ed.scene();
      const was = settings.pcbRoutingMode;
      updateSettings({ pcbRoutingMode: mode });
      const tool = new RouteTool(ed);
      ed.setTool(tool);
      const pts: [number, number][] = [[2000, 2000], [2500, 2000], [2500, 2400], [3100, 2400], [3100, 2100]];
      const laid: number[] = [];
      for (const [x, y] of pts) {
        tool.pointerMove(at(x, y)); tool.pointerDown(at(x, y));
        laid.push((tool as unknown as { segs: unknown[] }).segs.length);
        expect((tool as unknown as { look: { blocked?: boolean } }).look.blocked ?? false).toBe(false);
      }
      // The first click starts; each one after it fixes one more straight stretch
      expect(laid).toEqual([0, 1, 2, 3, 4]);
      tool.cancel();
      const tracks = doc.prims.filter((p): p is PcbTrack => p.kind === 'track');
      expect(tracks.length).toBe(4);
      expect(tracks.every((t) => t.net === NO_NET)).toBe(true);
      // Joined end to end, from the first click to the last
      for (let i = 1; i < tracks.length; i++) expect(tracks[i]!.a).toEqual(tracks[i - 1]!.b);
      expect(tracks[0]!.a).toEqual({ x: mil(2000), y: mil(2000) });
      expect(tracks.at(-1)!.b).toEqual({ x: mil(3100), y: mil(2100) });
      updateSettings({ pcbRoutingMode: was });
    });
  }
});
