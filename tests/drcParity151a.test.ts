import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { newPcbDocBytes } from '../src/formats/altium/newBoard';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { PropertyBag } from '../src/formats/altium/props';
import { newRule, ruleKind } from '../src/formats/altium/rules';
import { drcRules, runDrc, type DrcViolation } from '../src/model/drc';
import { PcbEditor } from '../src/editors/pcb/PcbEditor';
import { mil, mm } from '../src/core/units';
import { L, type LayerId } from '../src/model/layers';
import { NO_NET, type PcbArc, type PcbDocument, type PcbPad, type PcbPrim, type PcbRegion, type PcbTrack, type PcbVia } from '../src/model/pcb';

/**
 * DRC parity with the desktop suite (26.151): Un-Routed Net, Net Antennae, Un-Connected Pin, the
 * rules the suite applies without one in the file (testpoint usage among them), Routing Via Style and
 * Board Outline Clearance, as the suite reports them; and a shelved pour's restore layer and net.
 * Small boards made here: a new board (6000 x 4000 mil from (1000, 1000) mil, origin 0), lengths in mil.
 */

const P = (x: number, y: number) => ({ x: mil(x), y: mil(y) });
const src = (storage: string) => ({ storage, index: -1 });
const stack = (w: number) => ({ w: mil(w), h: mil(w), shape: 'round' as const, cornerPct: 0 });
const pad = (name: string, at: [number, number], net: number, o: Partial<PcbPad> = {}): PcbPad => ({
  kind: 'pad', src: src('Pads6'), name, layer: L.TOP, at: P(...at), rotation: 0, top: stack(50), mid: stack(50), bot: stack(50), hole: 0, plated: false, net, component: NO_NET, locked: false, ...o,
});
const via = (at: [number, number], net: number, o: Partial<PcbVia> = {}): PcbVia => ({ kind: 'via', src: src('Vias6'), at: P(...at), diameter: mil(20), hole: mil(10), layerStart: L.TOP, layerEnd: L.BOTTOM, net, locked: false, ...o });
const track = (a: [number, number], b: [number, number], net: number, layer: LayerId = L.TOP, width = 10): PcbTrack => ({
  kind: 'track', src: src('Tracks6'), layer, a: P(...a), b: P(...b), width: mil(width), net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false,
});
const arc = (c: [number, number], r: number, start: number, end: number, net: number, layer: LayerId = L.TOP): PcbArc => ({
  kind: 'arc', src: src('Arcs6'), layer, c: P(...c), r: mil(r), start, end, width: mil(10), net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false,
});
const square = (x0: number, y0: number, x1: number, y1: number, net: number, layer: LayerId = L.TOP): PcbRegion => ({
  kind: 'region', src: src('Regions6'), layer, outline: [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], holes: [], regionKind: 0, boardCutout: false, net, polygon: NO_NET, component: NO_NET, locked: false, keepout: false,
});

/** A new board with nets SIG and GND and only the given rules (no implicit ones unless asked). */
function board(rules: [string, Record<string, string>?][] = []): PcbDocument {
  const doc = readPcbDoc(newPcbDocBytes('T.PcbDoc'), 'T.PcbDoc');
  doc.nets = ['SIG', 'GND', 'OTHER'].map((name, index) => ({ index, name, bag: PropertyBag.from({ NAME: name }) }));
  doc.rules = rules.map(([k, set]) => { const r = newRule(k, k, 1); for (const [key, v] of Object.entries(set ?? {})) r.bag.set(key, v); return r; });
  return doc;
}
const SIG = 0, GND = 1;
const add = (doc: PcbDocument, ...p: PcbPrim[]) => { doc.prims = [...doc.prims, ...p]; return doc.prims.length - p.length; };
const check = (doc: PcbDocument, ...k: string[]): DrcViolation[] => runDrc(doc, new Set(k)).violations;
const messages = (doc: PcbDocument, ...k: string[]) => check(doc, ...k).map((v) => v.message);

describe('Un-Routed Net: every piece of a net, joined as the suite joins them', () => {
  it('a copper island with no pad is a piece; across a gap the open track ends are named, not the pads', () => {
    const doc = board([['UnRoutedNet']]);
    add(doc, pad('1', [2000, 2000], SIG), track([2000, 2000], [2500, 2000], SIG), track([3000, 2000], [3200, 2000], SIG));
    expect(messages(doc, 'UnRoutedNet')).toEqual([
      'Un-Routed Net Constraint: Net SIG Between Track (3000mil,2000mil)(3200mil,2000mil) on Top Layer And Track (2000mil,2000mil)(2500mil,2000mil) on Top Layer',
    ]);
    // An arc touching nothing too (before, only pads made pieces: nothing was reported)
    add(doc, arc([2200, 2600], 50, 0, 180, SIG));
    expect(check(doc, 'UnRoutedNet')).toHaveLength(2);
  });

  it('a via or through-hole pad stands for its piece rather than a nearer SMD pad; a lone SMD pad is [Unplated]', () => {
    const doc = board([['UnRoutedNet']]);
    add(doc,
      pad('1', [2000, 3000], SIG), track([2000, 3000], [2100, 3000], SIG), via([2100, 3000], SIG),
      pad('2', [2000, 3200], SIG), track([2000, 3200], [2000, 3400], SIG), via([2000, 3400], SIG),
      pad('3', [2600, 3000], SIG));
    expect(messages(doc, 'UnRoutedNet').sort()).toEqual([
      'Un-Routed Net Constraint: Net SIG Between Pad Free-3(2600mil,3000mil) on Top Layer [Unplated] And Via (2100mil,3000mil) from Top Layer to Bottom Layer',
      'Un-Routed Net Constraint: Net SIG Between Via (2000mil,3400mil) from Top Layer to Bottom Layer And Via (2100mil,3000mil) from Top Layer to Bottom Layer',
    ]);
  });

  it('vias are joined by their distance along x and y, as the suite joins them', () => {
    // A and B 38.8 mil apart; C is nearer A straight across (133.9 mil) but nearer B along x and y (140 against 165.8)
    const doc = board([['UnRoutedNet']]);
    add(doc, via([2000, 2000], SIG), via([2037.143, 1988.691], SIG), via([2037.143, 2128.703], SIG));
    const v = check(doc, 'UnRoutedNet');
    expect(v.map((x) => [...x.prims].sort((a, b) => a - b))).toEqual([[0, 1], [1, 2]]);
  });

  it('a join to a free region names the other object alone; Sub-Net 1 is the piece with the pads', () => {
    const doc = board([['UnRoutedNet']]);
    add(doc, pad('1', [2000, 2000], SIG), square(2300, 1950, 2400, 2050, SIG));
    const [v] = check(doc, 'UnRoutedNet');
    expect(v!.message).toBe('Un-Routed Net Constraint: Pad Free-1(2000mil,2000mil) on Top Layer');
    expect(v!.details).toEqual(['Sub-Net 1: 1 pad (Free-1)', 'Sub-Net 2: no pads (Region (0 hole(s)) Top Layer)']);
  });
});

describe('Net Antennae: each open end, and a via touching one object at most', () => {
  it('a track or arc open at both ends twice, a full circle touching nothing twice, an arc from a via once; arcs, vias, then tracks', () => {
    const doc = board([['NetAntennae', { NETANTENNAETOLERANCE: '0mil' }]]);
    const t = add(doc, track([2000, 2000], [2100, 2000], SIG));
    const c = add(doc, arc([3000, 3000], 50, 0, 360, SIG));
    const v = add(doc, via([4000, 2000], SIG), arc([4050, 2000], 50, 180, 270, SIG));
    const out = check(doc, 'NetAntennae');
    expect(out.map((x) => x.prims[0])).toEqual([v + 1, c, c, v, t, t]);
    expect(out[0]!.message).toBe('Net Antennae: Arc (4050mil,2000mil) on Top Layer');
    expect(out[4]!.message).toBe('Net Antennae: Track (2000mil,2000mil)(2100mil,2000mil) on Top Layer');
  });

  it('a via in one pour is an antenna, through two it is not, nor through one and a plane of its net (26.153)', () => {
    const doc = board([['NetAntennae', { NETANTENNAETOLERANCE: '0mil' }]]);
    doc.board.copperStack = [L.TOP, L.PLANE1, L.BOTTOM];
    const one = add(doc, square(1900, 1900, 2100, 2100, GND, L.BOTTOM), via([2000, 2000], GND)) + 1;
    const two = add(doc, square(2900, 1900, 3100, 2100, GND, L.TOP), square(2900, 1900, 3100, 2100, GND, L.BOTTOM), via([3000, 2000], GND)) + 2;
    const stub = add(doc, via([4000, 2000], GND), track([4000, 2000], [4000, 2200], GND, L.BOTTOM));
    let flagged = check(doc, 'NetAntennae').map((x) => x.prims[0]);
    expect(flagged).toContain(one);
    expect(flagged).not.toContain(two);
    // A via with one track only, and that track's open far end
    expect(flagged.filter((i) => i === stub || i === stub + 1)).toEqual([stub, stub + 1]);
    // The plane GND: the vias are joined to it (the suite's report of a board whose planes it read)
    doc.board.bag!.set('PLANE1NETNAME', 'GND');
    flagged = check(doc, 'NetAntennae').map((x) => x.prims[0]);
    expect(flagged).not.toContain(one);
    expect(flagged.filter((i) => i === stub || i === stub + 1)).toEqual([stub + 1]);
  });
});

describe('Un-Connected Pin', () => {
  it('a free pad with no net is reported; a Multi-Layer one only on a board without internal planes', () => {
    const doc = board([['UnConnectedPin']]);
    const smd = add(doc, pad('D1', [2000, 2000], NO_NET));
    const th = add(doc, pad('H1', [3000, 2000], NO_NET, { layer: L.MULTI, hole: mil(30), plated: true }));
    expect(check(doc, 'UnConnectedPin').map((v) => v.prims[0])).toEqual([smd, th]);
    expect(check(doc, 'UnConnectedPin')[0]!.message).toBe('Un-Connected Pin Constraint: Pad Free-D1(2000mil,2000mil) on Top Layer');
    doc.board.copperStack = [L.TOP, L.PLANE1, L.BOTTOM];
    doc.prims = [...doc.prims];
    expect(check(doc, 'UnConnectedPin').map((v) => v.prims[0])).toEqual([smd]);
  });
});

describe('the rules the suite applies without one in the file', () => {
  it('Net Antennae, Modified Polygon, Routing Layers and the testpoint styles and usages, each only where the board has no rule of its kind', () => {
    const doc = board([['UnRoutedNet'], ['NetAntennae', { ENABLED: 'FALSE' }]]);
    const kinds = drcRules(doc).map(ruleKind);
    expect(kinds).toEqual(['UnRoutedNet', 'NetAntennae', 'UnpouredPolygon', 'RoutingLayers', 'FabricationTestpoint', 'FabricationTestPointUsage', 'AssemblyTestpoint', 'AssemblyTestPointUsage']);
    // The board's own (disabled) Net Antennae rule stands: nothing checked
    add(doc, track([2000, 2000], [2100, 2000], SIG));
    expect(check(doc, 'NetAntennae')).toEqual([]);
    // With no rule of the kind the suite's default applies
    doc.rules = doc.rules.filter((r) => ruleKind(r) !== 'NetAntennae');
    expect(check(doc, 'NetAntennae')).toHaveLength(2);
  });

  it('Testpoint Usage: "Net X - Missing required testpoint", the nets latest first', () => {
    const doc = board();
    add(doc, pad('1', [2000, 2000], SIG), pad('2', [2200, 2000], SIG), pad('3', [2000, 2400], GND), pad('4', [2200, 2400], GND));
    expect(messages(doc, 'FabricationTestPointUsage', 'AssemblyTestPointUsage')).toEqual([
      'Fabrication Testpoint Usage: Net GND - Missing required testpoint', 'Fabrication Testpoint Usage: Net SIG - Missing required testpoint',
      'Assembly Testpoint Usage: Net GND - Missing required testpoint', 'Assembly Testpoint Usage: Net SIG - Missing required testpoint',
    ]);
  });
});

describe('Routing Via Style and Board Outline Clearance as the suite measures and words them', () => {
  it('a via 0.0005 mil under the minimum diameter is reported, with its actual size and hole; the latest first', () => {
    const doc = board([['RoutingVias', { MINWIDTH: '0.45mm', WIDTH: '0.45mm', MAXWIDTH: '0.6mm', MINHOLEWIDTH: '0.2mm', HOLEWIDTH: '0.2mm', MAXHOLEWIDTH: '0.3mm' }]]);
    const exact = add(doc, via([2000, 2000], SIG, { diameter: mm(0.45), hole: mm(0.2) }));
    const under = add(doc, via([2500, 2000], SIG, { diameter: 177160, hole: mm(0.2) }), via([3000, 2000], SIG, { diameter: mil(12), hole: mil(8) }));
    const out = check(doc, 'RoutingVias');
    expect(out.map((v) => v.prims[0])).toEqual([under + 1, under]);
    expect(out.map((v) => v.prims[0])).not.toContain(exact);
    expect(out[1]!.message).toBe('Routing Via Style: Via (2500mil,2000mil) from Top Layer to Bottom Layer Actual Size : 17.716mil Actual Hole Size : 7.874mil');
  });

  it('copper near the edge with its distance, silkscreen on the edge as a collision, "And Board Edge"', () => {
    const doc = board([['BoardOutlineClearance', { GAP: '10mil' }]]);
    add(doc, track([1006, 2000], [1006, 2100], SIG, L.TOP, 6), track([1500, 975], [1500, 1040], NO_NET, L.TOP_OVERLAY, 6), track([3000, 3000], [3100, 3000], SIG));
    expect(messages(doc, 'BoardOutlineClearance')).toEqual([
      'Board Outline Clearance(Outline Edge): (Collision < 10mil) Between Track (1500mil,975mil)(1500mil,1040mil) on Top Overlay And Board Edge',
      'Board Outline Clearance(Outline Edge): (3mil < 10mil) Between Track (1006mil,2000mil)(1006mil,2100mil) on Top Layer And Board Edge',
    ]);
  });
});

describe('a shelved pour', () => {
  it('keeps the layer and net it is restored to, as AD writes a shelved pour; UNKNOWN once restored', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const ed = new PcbEditor(doc);
    const g = doc.polygons[0]!;
    ed.shelvePolygons([g.index], true);
    const bag = doc.polygons[g.index]!.bag;
    expect([bag.get('SHELVED'), bag.get('RESTORELAYER'), bag.get('RESTORENET')]).toEqual(['TRUE', bag.get('LAYER'), doc.nets[g.net]!.name]);
    ed.shelvePolygons([g.index], false);
    expect(doc.polygons[g.index]!.bag.get('RESTORELAYER')).toBe('UNKNOWN');
  });
});
