import { afterEach, describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { bytesEqual } from '../src/formats/bin';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { PcbDragTool } from '../src/editors/pcb/PcbDragTool';
import { PcbGripTool } from '../src/editors/pcb/PcbGripTool';
import { RouteWorld } from '../src/model/router';
import { addTracks } from '../src/model/pcbEdit';
import type { TrackFields } from '../src/formats/altium/pcbdoc';
import { mil, mm } from '../src/core/units';
import { updateSettings } from '../src/core/settings';
import { L } from '../src/model/layers';
import type { PcbTrack, PcbVia } from '../src/model/pcb';
import type { ToolPointer } from '../src/core/tools';

const O = mil(1000);
const P = (x: number, y: number) => ({ x: O + mm(x), y: O + mm(y) });
const at = (x: number, y: number): ToolPointer => ({ world: P(x, y), raw: P(x, y), button: 0, shift: false, ctrl: false, alt: false });
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < mil(0.5) && Math.abs(a.y - b.y) < mil(0.5);

function setup() {
  const bytes = demoPcbDoc();
  const ed = new PcbEditor(readPcbDoc(bytes, 'Demo.PcbDoc'));
  ed.scene();
  return { bytes, ed };
}
const track = (ed: PcbEditor, i: number) => ed.doc.prims.find((p): p is PcbTrack => p.kind === 'track' && p.src.index === i)!;
const via = (ed: PcbEditor, i: number) => ed.doc.prims.find((p): p is PcbVia => p.kind === 'via' && p.src.index === i)!;
const drag = (ed: PcbEditor, prim: PcbTrack | PcbVia, from: [number, number], to: [number, number]) => {
  ed.setTool(new PcbDragTool(ed, prim, P(...from)));
  ed.pointerMove(at(...to));
  ed.pointerUp(at(...to), true);
};

afterEach(() => updateSettings({ pcbDragObstacles: 'avoidSnap', pcbPreserveAngle: true, pcbDragUnselected: 'drag', pcbDragSelected: 'drag' }));

describe('dragging tracks and vias', () => {
  it('a press-drag on a track slides it; its neighbours stretch to keep their directions; one undo', () => {
    updateSettings({ pcbDragObstacles: 'ignore' });
    const { ed, bytes } = setup();
    // +3V3: 24,15.6 → 24,18.6 → 32.05,18.6 → 32.05,15; the middle one down by two grid steps
    const y = track(ed, 6).a.y, to = y + 2 * ed.gridSize(), Y = (x: number) => ({ x: P(x, 0).x, y: to });
    ed.pointerDown(at(28, 18.6));
    ed.pointerMove({ ...at(28, 18.6), world: Y(28), raw: Y(28) });
    expect(ed.tool).toBeInstanceOf(PcbDragTool);
    ed.pointerUp({ ...at(28, 18.6), world: Y(28), raw: Y(28) }, true);
    expect(near(track(ed, 6).a, Y(24)) && near(track(ed, 6).b, Y(32.05))).toBe(true);
    expect(near(track(ed, 5).b, Y(24)) && near(track(ed, 5).a, P(24, 15.6))).toBe(true);
    expect(near(track(ed, 7).a, Y(32.05)) && near(track(ed, 7).b, P(32.05, 15))).toBe(true);
    expect(ed.undo.undoLabel).toBe('Drag Track');
    ed.undo.undo();
    expect(bytesEqual(writePcbDoc(ed.doc), bytes)).toBe(true);
  });

  it('Preserve Angle: an end on a 45° neighbour slides along it; an end on a pad gets a new segment back to it', () => {
    updateSettings({ pcbDragObstacles: 'ignore' });
    const { ed } = setup();
    const n0 = ed.doc.prims.length;
    // VIN: 5,13.77 → 6.23,15 (45°) → 13.05,15 (C1 pad 1); the second up by half a millimetre
    drag(ed, track(ed, 1), [9, 15], [9, 14.5]);
    const t1 = track(ed, 1);
    expect(near(t1.a, P(5.73, 14.5))).toBe(true);
    expect(near(t1.b, P(13.05, 14.5))).toBe(true);
    expect(near(track(ed, 0).b, t1.a)).toBe(true);
    // The pad end: a new segment from the pad to the moved end
    expect(ed.doc.prims.length).toBe(n0 + 1);
    const added = ed.doc.prims.find((p): p is PcbTrack => p.kind === 'track' && near(p.a, P(13.05, 15)) && near(p.b, P(13.05, 14.5)));
    expect(added?.net).toBe(t1.net);
  });

  it("neighbours don't fold back: the drag stops before a neighbour would shrink to nothing", () => {
    updateSettings({ pcbDragObstacles: 'ignore' });
    const { ed } = setup();
    // VIN 13.05,7.2 → 26.3,7.2, with 26.3,7.2 → 26.3,9.4 to the pad: down 5 mm is too far
    drag(ed, track(ed, 3), [20, 7.2], [20, 12.2]);
    const t4 = track(ed, 4);
    expect(t4.a.y).toBeLessThan(t4.b.y);
    expect(t4.b.y).toBe(P(26.3, 9.4).y);
  });

  it('Avoid Obstacles: stops clear of another net; Ignore Obstacles goes through it', () => {
    updateSettings({ pcbDragObstacles: 'avoid' });
    const { ed } = setup();
    // VIN 13.05,7.2 → 26.3,7.2 down towards U1's GND and +3V3 pads at y 9.4
    drag(ed, track(ed, 3), [20, 7.2], [20, 9]);
    const t3 = track(ed, 3);
    expect(t3.a.y).toBeGreaterThan(P(0, 7.2).y);
    expect(t3.a.y).toBeLessThan(P(0, 9).y);
    const w = new RouteWorld(ed.doc, L.TOP);
    expect(w.segHit(t3.net, t3.width, t3.a, t3.b, { skip: (it) => it.net === t3.net })).toBeNull();
    // Ignore: to where the mouse is
    ed.undo.undo();
    updateSettings({ pcbDragObstacles: 'ignore' });
    drag(ed, track(ed, 3), [20, 7.2], [20, 8.6]);
    expect(Math.abs(track(ed, 3).a.y - P(0, 8.6).y)).toBeLessThan(mil(0.5));
  });

  it('Avoid Obstacles (Snap Grid): moved by whole grid steps', () => {
    const { ed } = setup();
    const y0 = track(ed, 6).a.y, g = ed.gridSize();
    drag(ed, track(ed, 6), [28, 18.6], [28, 19.63]);
    const dy = track(ed, 6).a.y - y0;
    expect(dy).not.toBe(0);
    expect(Math.abs(dy / g - Math.round(dy / g))).toBeLessThan(1e-6);
  });

  it('a via moves and the tracks ending on it on both layers follow', () => {
    updateSettings({ pcbDragObstacles: 'ignore' });
    const { ed } = setup();
    drag(ed, via(ed, 2), [35.6, 15], [36.6, 16]);
    expect(near(via(ed, 2).at, P(36.6, 16))).toBe(true);
    expect(near(track(ed, 11).b, P(36.6, 16))).toBe(true);
    expect(near(track(ed, 14).b, P(36.6, 16))).toBe(true);
    expect(ed.undo.undoLabel).toBe('Drag Via');
  });

  it('Move instead of Drag: a press-drag moves the via alone', () => {
    updateSettings({ pcbDragUnselected: 'move' });
    const { ed } = setup();
    ed.pointerDown(at(35.6, 15));
    ed.pointerMove(at(36.6, 16));
    expect(ed.tool).not.toBeInstanceOf(PcbDragTool);
  });
});

/**
 * 26.171, from a report: tracks that wouldn't move at all. A straight run laid in pieces (a
 * neighbour in line has no corner to slide); copper routed at exactly its clearance from another
 * net, or already nearer (the default, Avoid Obstacles, held it where it was).
 */
describe('dragging tracks that would not move (26.171)', () => {
  const W = mm(0.3);
  /** The demo board with tracks of its own on the bottom layer, clear of everything else. */
  function board(tracks: (ed: PcbEditor) => TrackFields[]) {
    const ed = setup().ed;
    ed.undo.transact('Place', (tx) => tx.add(addTracks(ed.doc, tracks(ed))));
    return ed;
  }
  const net = (ed: PcbEditor, name: string) => ed.doc.nets.findIndex((n) => n.name === name);
  const bottom = (ed: PcbEditor) => ed.doc.prims.filter((p): p is PcbTrack => p.kind === 'track' && p.layer === L.BOTTOM);
  /** The track between two places (either way round). */
  const between = (ed: PcbEditor, a: [number, number], b: [number, number]) => bottom(ed).find((t) => (near(t.a, P(...a)) && near(t.b, P(...b))) || (near(t.a, P(...b)) && near(t.b, P(...a))));
  const run = (y: number, xs: number[], n: number): TrackFields[] => xs.slice(1).map((x, i) => ({ layer: L.BOTTOM, a: P(xs[i]!, y), b: P(x, y), width: W, net: n }));
  const hintOf = (ed: PcbEditor, prim: PcbTrack, from: [number, number], to: [number, number]) => {
    ed.setTool(new PcbDragTool(ed, prim, P(...from)));
    ed.pointerMove(at(...to));
    const h = ed.tool.hint();
    ed.pointerUp(at(...to), true);
    return h;
  };

  it('a piece of a straight run steps out of it: a new 45° segment at each end, cut from the pieces in line with it', () => {
    updateSettings({ pcbDragObstacles: 'ignore' });
    const ed = board((e) => run(22, [6, 12, 18, 24], net(e, 'VIN')));
    const n0 = ed.doc.prims.length, bytes = writePcbDoc(ed.doc);
    // (ten steps of the 5 mil grid: 1.27 mm)
    drag(ed, between(ed, [12, 22], [18, 22])!, [15, 22], [15, 20.73]);
    // The piece itself, 1.27 mm across and as long as it was
    expect(between(ed, [12, 20.73], [18, 20.73])).toBeTruthy();
    // Its neighbours as much shorter, each joined to it by a diagonal
    for (const [a, b] of [[[6, 22], [10.73, 22]], [[10.73, 22], [12, 20.73]], [[18, 20.73], [19.27, 22]], [[19.27, 22], [24, 22]]] as [number, number][][]) expect(between(ed, a as [number, number], b as [number, number]), `${a} to ${b}`).toBeTruthy();
    expect(ed.doc.prims.length).toBe(n0 + 2);
    expect(bottom(ed).filter((t) => t.net === net(ed, 'VIN') && Math.abs(t.a.y - t.b.y) > 5 && Math.abs(Math.abs(t.a.x - t.b.x) - Math.abs(t.a.y - t.b.y)) < 5)).toHaveLength(2);
    expect(ed.undo.undoLabel).toBe('Drag Track');
    ed.undo.undo();
    expect(bytesEqual(writePcbDoc(ed.doc), bytes)).toBe(true);
  });

  it('…the other way, a diagonal run, and a run not quite straight (a neighbour a fraction of a degree off is in line, not a corner far away)', () => {
    updateSettings({ pcbDragObstacles: 'ignore' });
    const ed = board((e) => [
      ...run(22, [6, 12, 18, 24], net(e, 'VIN')),
      // A diagonal run in three pieces
      ...[[26, 18, 28, 20], [28, 20, 30, 22], [30, 22, 32, 24]].map(([x1, y1, x2, y2]) => ({ layer: L.BOTTOM, a: P(x1!, y1!), b: P(x2!, y2!), width: W, net: net(e, '+3V3') })),
    ]);
    drag(ed, between(ed, [12, 22], [18, 22])!, [15, 22], [15, 23.27]);
    expect(between(ed, [12, 23.27], [18, 23.27])).toBeTruthy();
    expect(between(ed, [10.73, 22], [12, 23.27]) && between(ed, [18, 23.27], [19.27, 22])).toBeTruthy();
    // The diagonal's middle piece, across itself by 1.27 mm each way: its steps run straight across and straight up
    drag(ed, between(ed, [28, 20], [30, 22])!, [29, 21], [30.27, 19.73]);
    expect(between(ed, [29.27, 18.73], [31.27, 20.73])).toBeTruthy();
    expect(between(ed, [26.73, 18.73], [29.27, 18.73])).toBeTruthy();
    expect(between(ed, [31.27, 20.73], [31.27, 23.27])).toBeTruthy();
    expect(between(ed, [26, 18], [26.73, 18.73]) && between(ed, [31.27, 23.27], [32, 24])).toBeTruthy();

    // Not quite straight: the piece to the right a thousandth of a millimetre off the line over six millimetres
    const off = board((e) => [...run(22, [6, 12, 18], net(e, 'VIN')), { layer: L.BOTTOM, a: P(18, 22), b: P(24, 22.001), width: W, net: net(e, 'VIN') }]);
    drag(off, between(off, [12, 22], [18, 22])!, [15, 22], [15, 20.73]);
    expect(between(off, [12, 20.73], [18, 20.73])).toBeTruthy();
    for (const t of bottom(off).filter((x) => x.a.y > P(0, 19).y)) for (const q of [t.a, t.b]) expect(q.x >= P(5.9, 0).x && q.x <= P(24.1, 0).x && q.y >= P(0, 20.6).y && q.y <= P(0, 22.1).y, `${q.x},${q.y}`).toBe(true);
  });

  it('a neighbour shorter than the step gives what it has, the dragged piece the rest; a neighbour lying back along the piece is not slid on', () => {
    updateSettings({ pcbDragObstacles: 'ignore' });
    const ed = board((e) => run(22, [6, 12, 18, 18.4, 24], net(e, 'VIN')));
    drag(ed, between(ed, [12, 22], [18, 22])!, [15, 22], [15, 20.73]);
    const piece = bottom(ed).find((t) => near({ x: 0, y: t.a.y }, { x: 0, y: P(0, 20.73).y }) && near({ x: 0, y: t.b.y }, { x: 0, y: P(0, 20.73).y }))!;
    const [l, r] = piece.a.x < piece.b.x ? [piece.a, piece.b] : [piece.b, piece.a];
    expect(near(l, P(12, 20.73))).toBe(true);
    // The short piece (0.4 mm) is all but used up; the step still rises as far as it runs
    const step = bottom(ed).find((t) => (near(t.a, r) || near(t.b, r)) && t !== piece)!;
    const foot = near(step.a, r) ? step.b : step.a;
    expect(Math.abs(foot.y - P(0, 22).y)).toBeLessThan(mil(0.5));
    expect(Math.abs((foot.x - r.x) - (P(0, 22).y - P(0, 20.73).y))).toBeLessThan(mil(0.5));
    expect(foot.x).toBeLessThan(P(18.4, 0).x);
    expect(r.x).toBeLessThan(P(18, 0).x);

    // A hairpin: the next piece comes back along this one. Its end is held (a new segment back to it), nothing is slid
    const back = board((e) => [...run(22, [6, 12, 18], net(e, 'VIN')), { layer: L.BOTTOM, a: P(18, 22), b: P(15, 22), width: W, net: net(e, 'VIN') }]);
    const n0 = back.doc.prims.length;
    drag(back, between(back, [12, 22], [18, 22])!, [14, 22], [14, 20.73]);
    expect(between(back, [18, 22], [15, 22])).toBeTruthy();
    expect(between(back, [18, 22], [18, 20.73])).toBeTruthy();
    expect(back.doc.prims.length).toBe(n0 + 2);
  });

  it('without Preserve Angle the pieces in line simply follow, as any neighbour does', () => {
    updateSettings({ pcbDragObstacles: 'ignore', pcbPreserveAngle: false });
    const ed = board((e) => run(22, [6, 12, 18, 24], net(e, 'VIN')));
    const n0 = ed.doc.prims.length;
    drag(ed, between(ed, [12, 22], [18, 22])!, [15, 22], [15, 20.73]);
    expect(between(ed, [6, 22], [12, 20.73]) && between(ed, [12, 20.73], [18, 20.73]) && between(ed, [18, 20.73], [24, 22])).toBeTruthy();
    expect(ed.doc.prims.length).toBe(n0);
  });

  it('Avoid Obstacles: tracks routed at exactly their clearance from another net move (they were held where they lay), and still come no nearer', () => {
    const ed = board((e) => {
      const gap = new RouteWorld(e.doc, L.BOTTOM).maxGap, x = P(6, 0).x - W - gap;
      return [
        { layer: L.BOTTOM, a: P(6, 20), b: P(6, 22), width: W, net: net(e, 'VIN') }, { layer: L.BOTTOM, a: P(6, 22), b: P(14, 22), width: W, net: net(e, 'VIN') }, { layer: L.BOTTOM, a: P(14, 22), b: P(14, 20), width: W, net: net(e, 'VIN') },
        // Another net beside the left one, at exactly the clearance
        { layer: L.BOTTOM, a: { x, y: P(0, 19).y }, b: { x, y: P(0, 23.5).y }, width: W, net: net(e, '+3V3') },
      ];
    });
    // As the router sees it, the left one is already too near (it keeps a hair more than the gap)
    expect(new RouteWorld(ed.doc, L.BOTTOM).segHit(net(ed, 'VIN'), W, P(6, 20), P(6, 22))).not.toBeNull();
    // The piece between the two: up a millimetre, its neighbours following along their own lines
    const h = hintOf(ed, between(ed, [6, 22], [14, 22])!, [10, 22], [10, 21]);
    expect(h).toBe('Drag Track (Avoid Obstacles (Snap Grid), Preserve Angle): release to drop, Esc to cancel');
    const t = bottom(ed).find((q) => Math.abs(q.a.y - q.b.y) < 5 && q.net === net(ed, 'VIN'))!;
    expect(Math.abs(t.a.y - P(0, 21).y)).toBeLessThan(ed.gridSize());
    // The left one itself towards the other net: not a step nearer, and the status bar says what is in the way
    const left = bottom(ed).find((q) => q.net === net(ed, 'VIN') && Math.abs(q.a.x - q.b.x) < 5 && Math.abs(q.a.x - P(6, 0).x) < 5)!;
    const h2 = hintOf(ed, left, [6, 21], [5, 21]);
    expect(h2).toBe('Drag Track (Avoid Obstacles (Snap Grid), Preserve Angle), stopped at a track of +3V3: release to drop, Esc to cancel');
    expect(Math.abs(bottom(ed).find((q) => q.src.index === left.src.index)!.a.x - P(6, 0).x)).toBeLessThan(5);
    // …and away from it: as far as asked
    drag(ed, bottom(ed).find((q) => q.src.index === left.src.index)!, [6, 21], [7, 21]);
    expect(Math.abs(bottom(ed).find((q) => q.src.index === left.src.index)!.a.x - P(7, 0).x)).toBeLessThan(ed.gridSize());
  });

  it("Avoid Obstacles: a track that lies across another net's copper (a violation already there) can be dragged along it and off it, not further on", () => {
    const ed = board((e) => [
      { layer: L.BOTTOM, a: P(6, 21), b: P(6, 22), width: W, net: net(e, 'VIN') }, { layer: L.BOTTOM, a: P(6, 22), b: P(14, 22), width: W, net: net(e, 'VIN') }, { layer: L.BOTTOM, a: P(14, 22), b: P(14, 21), width: W, net: net(e, 'VIN') },
      // Wide copper of another net under its middle (y 19.5 to 23.5)
      { layer: L.BOTTOM, a: P(7, 21.5), b: P(13, 21.5), width: mm(4), net: net(e, '+3V3') },
    ]);
    const mid = () => bottom(ed).find((q) => q.net === net(ed, 'VIN') && Math.abs(q.a.y - q.b.y) < 5)!;
    // Away from the middle of that copper: it goes
    drag(ed, mid(), [10, 22], [10, 23]);
    expect(Math.abs(mid().a.y - P(0, 23).y)).toBeLessThan(ed.gridSize());
    // Back over it, further on than it lay to begin with: no further than it is now
    const y = mid().a.y;
    const h = hintOf(ed, mid(), [10, 23], [10, 21.6]);
    expect(h).toContain('stopped at a track of +3V3');
    expect(mid().a.y).toBe(y);
    // Ignore Obstacles: wherever the mouse is
    updateSettings({ pcbDragObstacles: 'ignore' });
    drag(ed, mid(), [10, 23], [10, 21.6]);
    expect(Math.abs(mid().a.y - P(0, 21.6).y)).toBeLessThan(ed.gridSize());
  });

  it("a selected track's end handle on a joint moves the joint: the tracks that meet there stretch to it (the one end alone broke the track in two)", () => {
    const ed = board((e) => [
      { layer: L.BOTTOM, a: P(8, 20), b: P(8, 21), width: W, net: net(e, 'VIN') }, { layer: L.BOTTOM, a: P(8, 21), b: P(6, 23), width: W, net: net(e, 'VIN') }, { layer: L.BOTTOM, a: P(6, 23), b: P(6, 24), width: W, net: net(e, 'VIN') },
    ]);
    const bytes = writePcbDoc(ed.doc);
    const diag = between(ed, [8, 21], [6, 23])!;
    ed.select([`${diag.src.storage}:${diag.src.index}`]);
    const grip = ed.grips().find((g) => near(g.at, P(8, 21)))!;
    expect(ed.grips()).toHaveLength(2);
    const to = ed.snap(P(9, 22));
    ed.pointerDown({ ...at(8, 21), world: grip.at, raw: grip.at });
    expect(ed.tool).toBeInstanceOf(PcbGripTool);
    ed.pointerMove({ ...at(9, 22), world: to, raw: to });
    expect(ed.tool.hint()).toMatch(/^Moving the joint of 2 tracks to /);
    ed.pointerUp({ ...at(9, 22), world: to, raw: to }, true);
    const ends = (t: PcbTrack) => [t.a, t.b];
    const vin = bottom(ed).filter((t) => t.net === net(ed, 'VIN') && t.a.y > P(0, 19).y);
    // The diagonal and the piece above it both end at the new place; the piece below is as it was
    expect(vin.filter((t) => ends(t).some((q) => q.x === to.x && q.y === to.y))).toHaveLength(2);
    expect(vin.some((t) => ends(t).some((q) => near(q, P(8, 21))))).toBe(false);
    expect(vin.some((t) => ends(t).some((q) => near(q, P(8, 20))) && ends(t).some((q) => q.x === to.x && q.y === to.y))).toBe(true);
    expect(between(ed, [6, 23], [6, 24])).toBeTruthy();
    expect(ed.undo.undoLabel).toBe('Move track end');
    ed.undo.undo();
    expect(bytesEqual(writePcbDoc(ed.doc), bytes)).toBe(true);
  });

  it('…a via on the joint goes with it, and what ends on the via on its other layer; an end on a pad leaves the pad alone', () => {
    const { ed } = setup();
    // The via at 35.6,15 with tracks 11 and 14 on it (two layers)
    const t11 = track(ed, 11), on = near(t11.a, P(35.6, 15)) ? 'a' : 'b';
    ed.select([`${t11.src.storage}:${t11.src.index}`]);
    const to = ed.snap(P(36.6, 16));
    ed.pointerDown({ ...at(35.6, 15), world: t11[on], raw: t11[on] });
    expect(ed.tool).toBeInstanceOf(PcbGripTool);
    expect(ed.tool.hint()).toMatch(/^Moving the via and the tracks that end on it to /);
    ed.pointerMove({ ...at(36.6, 16), world: to, raw: to });
    ed.pointerUp({ ...at(36.6, 16), world: to, raw: to }, true);
    expect(via(ed, 2).at).toEqual(to);
    expect(track(ed, 11)[on]).toEqual(to);
    expect([track(ed, 14).a, track(ed, 14).b]).toContainEqual(to);
    ed.undo.undo();

    // VIN's track 1 ends on C1's pad at 13.05,15: its end comes off the pad, and nothing else moves
    const before = ed.doc.prims.filter((p): p is PcbTrack => p.kind === 'track').map((t) => [t.src.index, t.a.x, t.a.y, t.b.x, t.b.y].join());
    const t1 = track(ed, 1);
    ed.select([`${t1.src.storage}:${t1.src.index}`]);
    const off = ed.snap(P(13.05, 16));
    ed.pointerDown({ ...at(13.05, 15), world: t1.b, raw: t1.b });
    expect(ed.tool.hint()).toMatch(/^Moving the track end to /);
    ed.pointerMove({ ...at(13.05, 16), world: off, raw: off });
    ed.pointerUp({ ...at(13.05, 16), world: off, raw: off }, true);
    const after = ed.doc.prims.filter((p): p is PcbTrack => p.kind === 'track').map((t) => [t.src.index, t.a.x, t.a.y, t.b.x, t.b.y].join());
    expect(after.filter((x, i) => x !== before[i])).toEqual([[1, track(ed, 1).a.x, track(ed, 1).a.y, off.x, off.y].join()]);
  });

  it('the status bar says when the tracks either side let it go no further', () => {
    updateSettings({ pcbDragObstacles: 'ignore' });
    const ed = setup().ed;
    ed.setTool(new PcbDragTool(ed, track(ed, 3), P(20, 7.2)));
    ed.pointerMove(at(20, 12.2));
    expect(ed.tool.hint()).toBe('Drag Track (Ignore Obstacles, Preserve Angle), as far as the tracks either side of it allow: release to drop, Esc to cancel');
    ed.pointerUp(at(20, 12.2), true);
  });
});
