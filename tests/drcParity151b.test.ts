import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { runDrc } from '../src/model/drc';
import { trackPieces } from '../src/model/drcCopper';
import { newRule, ruleKind } from '../src/formats/altium/rules';
import { mil } from '../src/core/units';
import { L, type LayerId } from '../src/model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbTrack, type PcbVia } from '../src/model/pcb';

/**
 * Acute Angle, SMD Neck-Down, SMD To Corner and Vias Under SMD as the desktop suite checks them:
 * merged copper's sharp inward corners, one neck-down and one via per pad, corners measured along
 * the track from the pad's edge, and a pour net's tracks cut at their junctions. Small boards in mil.
 */

const GND = 0, VIN = 1;
const src = (storage: string) => ({ storage, index: -1 });
/** The demo board emptied (its GND keeps its pour, so GND's tracks are cut at junctions), no rules but those added. */
function board(): PcbDocument {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  doc.prims = [];
  doc.rules = [];
  doc.board.bag?.set('DISPLAYUNIT', '1');
  return doc;
}
const at = (doc: PcbDocument, x: number, y: number) => ({ x: doc.board.origin.x + mil(x), y: doc.board.origin.y + mil(y) });
const add = (doc: PcbDocument, ...p: PcbPrim[]) => { doc.prims = [...doc.prims, ...p]; return doc.prims.length - p.length; };
const rule = (doc: PcbDocument, kind: string, set: Record<string, string> = {}) => { const r = newRule(kind, kind, 1); for (const [k, v] of Object.entries(set)) r.bag.set(k, v); doc.rules = [...doc.rules.filter((x) => ruleKind(x) !== kind), r]; };
const run = (doc: PcbDocument, kind: string, subject?: Set<number>) => runDrc(doc, new Set([kind]), subject).violations.filter((v) => v.kind === kind);
const track = (doc: PcbDocument, a: [number, number], b: [number, number], net: number, width = 10, layer: LayerId = L.TOP): PcbTrack =>
  ({ kind: 'track', src: src('Tracks6'), layer, a: at(doc, ...a), b: at(doc, ...b), width: mil(width), net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false });
const shape = (w: number, h: number, round = false) => ({ w: mil(w), h: mil(h), shape: round ? 'round' as const : 'rect' as const, cornerPct: 0 });
/** An SMD pad on the top layer, w × h mil. */
const smd = (doc: PcbDocument, xy: [number, number], net: number, w = 40, h = 20, name = '1', round = false): PcbPad =>
  ({ kind: 'pad', src: src('Pads6'), name, layer: L.TOP, at: at(doc, ...xy), rotation: 0, top: shape(w, h, round), mid: shape(w, h, round), bot: shape(w, h, round), hole: 0, plated: true, net, component: NO_NET, locked: false });
const via = (doc: PcbDocument, xy: [number, number], net: number, d = 18, hole = 8): PcbVia =>
  ({ kind: 'via', src: src('Vias6'), at: at(doc, ...xy), diameter: mil(d), hole: mil(hole), layerStart: L.TOP, layerEnd: L.BOTTOM, net, locked: false });

describe('Vias Under SMD', () => {
  it('a via whose copper overlaps the pad counts though its centre is off the pad; one clear of it does not', () => {
    const doc = board();
    rule(doc, 'ViasUnderSMD', { ALLOWED: 'FALSE' });
    const p = add(doc, smd(doc, [100, 100], GND));
    // Centre 4 mil past the pad's right edge (x 120), the via 18 mil across: its copper is over the pad
    const v = add(doc, via(doc, [124, 100], GND));
    add(doc, smd(doc, [100, 200], GND, 40, 20, '2'), via(doc, [130, 200], GND));
    const out = run(doc, 'ViasUnderSMD');
    expect(out.map((x) => x.prims)).toEqual([[p, v]]);
    expect(out[0]!.message).toBe('Vias Under SMD Constraint: Between Pad Free-1(100mil,100mil) on Top Layer And Via (124mil,100mil) from Top Layer to Bottom Layer');
  });
  it('once for a pad, naming the first of the vias under it', () => {
    const doc = board();
    rule(doc, 'ViasUnderSMD', { ALLOWED: 'FALSE' });
    const p = add(doc, smd(doc, [100, 100], GND, 120, 120));
    const first = add(doc, via(doc, [70, 70], GND));
    for (const x of [70, 100, 130]) for (const y of [70, 100, 130]) if (x !== 70 || y !== 70) add(doc, via(doc, [x, y], GND));
    expect(run(doc, 'ViasUnderSMD').map((x) => x.prims)).toEqual([[p, first]]);
  });
});

describe('SMD To Corner', () => {
  const corner = (beyond: number, net = VIN) => {
    const doc = board();
    rule(doc, 'SMDToCorner', { DISTANCE: '5mil' });
    const p = add(doc, smd(doc, [100, 100], net));
    // From the pad's centre out of its right edge (x 120), turning 45° `beyond` mil past it
    const t = add(doc, track(doc, [100, 100], [120 + beyond, 100], net, 8));
    add(doc, track(doc, [120 + beyond, 100], [140 + beyond, 120], net, 8));
    return { doc, p, t };
  };
  it('the corner measured along the track from the pad\'s edge, in the suite\'s words', () => {
    const { doc, p, t } = corner(3);
    const out = run(doc, 'SMDToCorner');
    expect(out.map((x) => x.prims)).toEqual([[p, t]]);
    expect(out[0]!.message).toBe('SMD To Corner Constraint: (3mil < 5mil) Between Pad Free-1(100mil,100mil) on Top Layer And Track (100mil,100mil)(123mil,100mil) on Top Layer Actual Distance = 3mil');
  });
  it('a corner within 1 mil of the distance is let be, as the suite does', () => {
    expect(run(corner(3.9).doc, 'SMDToCorner')).toHaveLength(1);
    expect(run(corner(4.2).doc, 'SMDToCorner')).toEqual([]);
  });
  it('a corner on the pad\'s edge is a collision, once, named by the first track to it', () => {
    const doc = board();
    rule(doc, 'SMDToCorner', { DISTANCE: '5mil' });
    add(doc, smd(doc, [100, 100], VIN));
    const t = add(doc, track(doc, [100, 100], [110, 110], VIN, 8));
    add(doc, track(doc, [110, 110], [160, 110], VIN, 8), track(doc, [96, 104], [110, 110], VIN, 8));
    const out = run(doc, 'SMDToCorner');
    expect(out.map((x) => x.prims[1])).toEqual([t]);
    expect(out[0]!.message).toMatch(/^SMD To Corner Constraint: \(Collision < 5mil\) Between Pad .* Actual Distance = 0mil$/);
  });
  it('a route that stops just past the pad is a corner too', () => {
    const doc = board();
    rule(doc, 'SMDToCorner', { DISTANCE: '5mil' });
    add(doc, smd(doc, [100, 100], VIN));
    add(doc, track(doc, [100, 100], [122, 100], VIN, 8));
    expect(run(doc, 'SMDToCorner').map((x) => x.message)).toEqual([expect.stringMatching(/\(2mil < 5mil\).*Actual Distance = 2mil$/)]);
  });
  it('a round pad measured from the 16-sided polygon round it', () => {
    const doc = board();
    rule(doc, 'SMDToCorner', { DISTANCE: '5mil' });
    // 15.748 mil across: the polygon's corner straight up is 8.028 mil from the centre
    add(doc, smd(doc, [100, 100], VIN, 15.748, 15.748, '1', true));
    add(doc, track(doc, [100, 100], [100, 109.68], VIN, 6), track(doc, [100, 109.68], [120, 129.68], VIN, 6));
    expect(run(doc, 'SMDToCorner').map((x) => x.message)).toEqual([expect.stringMatching(/\(1\.652mil < 5mil\).*Actual Distance = 1\.652mil$/)]);
  });
  it('a pour net\'s track is cut where another ends on it: that junction is the corner, the piece named', () => {
    const tee = (net: number) => {
      const doc = board();
      rule(doc, 'SMDToCorner', { DISTANCE: '5mil' });
      add(doc, smd(doc, [100, 100], net));
      add(doc, track(doc, [100, 100], [160, 100], net, 8), track(doc, [123, 100], [123, 140], net, 8));
      return run(doc, 'SMDToCorner').map((x) => x.message);
    };
    expect(tee(GND)).toEqual([expect.stringMatching(/\(3mil < 5mil\) Between Pad Free-1\(100mil,100mil\) on Top Layer And Track \(100mil,100mil\)\(123mil,100mil\) on Top Layer Actual Distance = 3mil$/)]);
    // Another net's track runs on whole: no corner by the pad
    expect(tee(VIN)).toEqual([]);
  });
});

describe('SMD Neck-Down', () => {
  it('once for a pad, the widest of its tracks against the pad\'s narrower side, in the suite\'s words', () => {
    const doc = board();
    rule(doc, 'SMDNeckDown', { PERCENT: '50' });
    const p = add(doc, smd(doc, [100, 100], VIN));
    add(doc, track(doc, [100, 100], [160, 100], VIN, 12));
    const wide = add(doc, track(doc, [100, 100], [100, 160], VIN, 16));
    add(doc, track(doc, [100, 100], [40, 100], VIN, 6));
    const out = run(doc, 'SMDNeckDown');
    expect(out.map((x) => x.prims)).toEqual([[p, wide]]);
    expect(out[0]!.message).toBe('SMD Neck-Down Constraint: Between Pad Free-1(100mil,100mil) on Top Layer And Track (100mil,100mil)(100mil,160mil) on Top Layer Relative Track Width: 80.00%');
  });
  it('tracks no wider than the percentage are none', () => {
    const doc = board();
    rule(doc, 'SMDNeckDown', { PERCENT: '50' });
    add(doc, smd(doc, [100, 100], VIN), track(doc, [100, 100], [160, 100], VIN, 10));
    expect(run(doc, 'SMDNeckDown')).toEqual([]);
  });
});

describe('Acute Angle: the merged copper\'s sharp inward corners', () => {
  const acute = (doc: PcbDocument, set: Record<string, string> = {}) => { rule(doc, 'AcuteAngle', { MINIMUM: '90', ...set }); return run(doc, 'AcuteAngle'); };
  it('a track leaving a pad at 45° makes a 45° corner on the side it leans to, in the suite\'s words', () => {
    const doc = board();
    const p = add(doc, smd(doc, [100, 100], VIN));
    const t = add(doc, track(doc, [100, 100], [160, 160], VIN, 8));
    const out = acute(doc);
    expect(out).toHaveLength(1);
    expect([...out[0]!.prims].sort((a, b) => a - b)).toEqual([p, t]);
    expect(out[0]!.message).toMatch(/^Acute Angle Constraint: \(45\.000 < 90\.000\) Between (Pad Free-1\(100mil,100mil\) on Top Layer And Track \(100mil,100mil\)\(160mil,160mil\) on Top Layer|Track \(100mil,100mil\)\(160mil,160mil\) on Top Layer And Pad Free-1\(100mil,100mil\) on Top Layer) \(Angle = 45\.000\)$/);
  });
  it('a notch with a side under 1 mil is let be', () => {
    // Leaving the pad's top edge (y 110) at 45° near its corner (x 120): the 8 mil track's edge
    // meets the pad's edge 3 mil, then 0.5 mil, short of the corner
    const notch = (cx: number) => { const doc = board(); add(doc, smd(doc, [100, 100], VIN), track(doc, [cx, 100], [cx + 60, 160], VIN, 8)); return acute(doc); };
    expect(notch(101.343)).toHaveLength(1);
    expect(notch(103.843)).toEqual([]);
  });
  it('one leaving it square makes none', () => {
    const doc = board();
    add(doc, smd(doc, [100, 100], VIN), track(doc, [100, 100], [100, 160], VIN, 8));
    expect(acute(doc)).toEqual([]);
  });
  it('two tracks meeting at their ends at 30°', () => {
    const doc = board();
    const a = add(doc, track(doc, [100, 100], [100, 140], VIN, 6));
    const b = add(doc, track(doc, [100, 140], [100 + 40 * Math.sin(Math.PI / 6), 140 - 40 * Math.cos(Math.PI / 6)], VIN, 6));
    const out = acute(doc);
    expect(out.map((x) => [...x.prims].sort((p, q) => p - q))).toEqual([[a, b]]);
    expect(out[0]!.message).toMatch(/\(30\.000 < 90\.000\).*\(Angle = 30\.000\)$/);
  });
  it('teardrops merged into their track make no corner where they meet it', () => {
    const doc = board();
    add(doc, smd(doc, [100, 100], VIN, 30, 30), track(doc, [100, 100], [100, 200], VIN, 8));
    // From the pad's edge either side back onto the track, as Tools › Teardrops makes them
    add(doc, track(doc, [96, 100], [100, 130], VIN, 8), track(doc, [104, 100], [100, 130], VIN, 8));
    expect(acute(doc)).toEqual([]);
  });
  it('Check Tracks Only leaves a pad\'s corner be', () => {
    const doc = board();
    add(doc, smd(doc, [100, 100], VIN), track(doc, [100, 100], [160, 160], VIN, 8));
    expect(acute(doc, { CHECKTRACKSONLY: 'TRUE' })).toEqual([]);
  });
  it('online, for the object changed, as the batch check finds it', () => {
    const doc = board();
    add(doc, smd(doc, [100, 100], VIN), smd(doc, [400, 100], VIN, 40, 20, '2'));
    const t = add(doc, track(doc, [100, 100], [160, 160], VIN, 8));
    add(doc, track(doc, [400, 100], [460, 160], VIN, 8));
    const all = acute(doc);
    expect(all).toHaveLength(2);
    const mine = run(doc, 'AcuteAngle', new Set([t]));
    expect(mine.map((x) => x.message)).toEqual(all.filter((x) => x.prims.includes(t)).map((x) => x.message));
  });
});

describe('a pour net\'s tracks cut at their junctions', () => {
  it('where another ends on one, where two cross, at the foot of the perpendicular from a via\'s centre; other nets\' kept whole', () => {
    const doc = board();
    const main = add(doc, track(doc, [0, 0], [100, 0], GND));
    add(doc, track(doc, [30, 0], [30, 40], GND), track(doc, [60, -20], [60, 20], GND), via(doc, [80, 3], GND));
    const other = add(doc, track(doc, [0, 50], [100, 50], VIN), track(doc, [30, 50], [30, 90], VIN));
    const o = doc.board.origin;
    const cuts = trackPieces(doc).filter((q) => q.i === main).map((q) => Math.round((q.b.x - o.x) / mil(1)));
    expect(cuts).toEqual([30, 60, 80, 100]);
    expect(trackPieces(doc).filter((q) => q.i === other)).toHaveLength(1);
  });
});

/** The comparison tool (tests/tools, outside the type check: it runs under Node), loaded by name. */
interface Tool {
  objectsOf(text: string): unknown[];
  parseReport(text: string): unknown;
  compare(a: unknown, b: unknown): { matched: number }[];
}
const TOOL = './tools/drcCompare';
const tool = async () => (await import(/* @vite-ignore */ TOOL)) as Tool;

describe('the comparison of reports', () => {
  it('pairs SMD Neck-Down by the pad (the suite names one of its tracks by its own order)', async () => {
    const { parseReport, compare } = await tool();
    const suite = parseReport('Processing Rule : SMD Neck-Down Constraint (Percent=50%) (All)\n   Violation between SMD Neck-Down Constraint: Between Pad C1-2(10mil,10mil) on Top Layer And Track (10mil,10mil)(20mil,20mil) on Top Layer Relative Track Width: 54.55%\nRule Violations :1\n');
    const mine = parseReport('Processing Rule : SMD Neck-Down Constraint (Percent=50%) (All)\n   Violation between SMD Neck-Down Constraint: Between Pad C1-2(10mil,10mil) on Top Layer And Track (8mil,12mil)(20mil,20mil) on Top Layer Relative Track Width: 90.00%\nRule Violations :1\n');
    expect(compare(suite, mine)[0]!.matched).toBe(1);
  });
  it('reads a region\'s own corner with its layer alone, told apart by the angle', async () => {
    const { objectsOf, parseReport, compare } = await tool();
    expect(objectsOf('Acute Angle Constraint: (78.750 < 90.000) Polygon Region (12 hole(s)) Top Layer (Angle = 78.750)')).toEqual([{ kind: 'Polygon Region', name: '12', at: [], tol: 0, layer: 'Top Layer' }]);
    const r = (a: string) => parseReport(`Processing Rule : Acute Angle Constraint (Minimum=90.000) (All)\n   Violation between Acute Angle Constraint: (${a} < 90.000) Polygon Region (12 hole(s)) Top Layer (Angle = ${a})\nRule Violations :1\n`);
    expect(compare(r('78.750'), r('78.750'))[0]!.matched).toBe(1);
    expect(compare(r('78.750'), r('80.999'))[0]!.matched).toBe(0);
  });
});
