import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { runDrc } from '../src/model/drc';
import { reportHtml } from '../src/app/dialogs/Drc';
import { PropertyBag } from '../src/formats/altium/props';
import { FAB_PROFILES, checkAgainstProfile, compareProfile, rulesWithProfile } from '../src/model/fabProfiles';
import { newRule, ruleKind, ruleLength } from '../src/formats/altium/rules';
import { mil, mm } from '../src/core/units';
import { L, type LayerId } from '../src/model/layers';
import { NO_NET, type PcbDocument, type PcbPad, type PcbPrim, type PcbText, type PcbTrack } from '../src/model/pcb';

const O = { x: mil(1000), y: mil(1000) };
const P = (x: number, y: number) => ({ x: O.x + mm(x), y: O.y + mm(y) });
const src = (storage: string) => ({ storage, index: -1 });
const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const add = (doc: PcbDocument, ...p: PcbPrim[]) => { doc.prims = [...doc.prims, ...p]; return doc.prims.length - p.length; };
const rule = (doc: PcbDocument, kind: string, set: Record<string, string> = {}) => { const r = newRule(kind, kind, 1); for (const [k, v] of Object.entries(set)) r.bag.set(k, v); doc.rules = [...doc.rules.filter((x) => ruleKind(x) !== kind), r]; };
const kinds = (doc: PcbDocument, ...k: string[]) => runDrc(doc, new Set(k)).violations;
const track = (a: [number, number], b: [number, number], net: number, layer: LayerId = L.TOP, width = 0.25): PcbTrack => ({ kind: 'track', src: src('Tracks6'), layer, a: P(...a), b: P(...b), width: mm(width), net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false });
const stack = (w: number) => ({ w: mm(w), h: mm(w), shape: 'round' as const, cornerPct: 0 });
const pad = (at: [number, number], net: number, o: Partial<PcbPad> = {}): PcbPad => ({ kind: 'pad', src: src('Pads6'), name: '1', layer: L.TOP, at: P(...at), rotation: 0, top: stack(1), mid: stack(1), bot: stack(1), hole: 0, plated: true, net, component: 0, locked: false, ...o });
const text = (s: string, at: [number, number], layer: LayerId = L.TOP_OVERLAY): PcbText => ({ kind: 'text', src: src('Texts6'), layer, at: P(...at), height: mm(1), rotation: 0, mirrored: false, strokeWidth: mm(0.15), text: s, component: NO_NET, isComment: false, isDesignator: false, fontType: 0, fontName: 'Arial', bold: false, italic: false, hidden: false } as PcbText);

describe('the rule kinds past copper clearance', () => {
  it('Net Antennae: a track end that meets nothing of its net', () => {
    const doc = demo();
    rule(doc, 'NetAntennae', { NETANTENNAETOLERANCE: '0mil' });
    expect(kinds(doc, 'NetAntennae')).toEqual([]);
    const i = add(doc, track([36, 20], [38, 20], 0));
    const v = kinds(doc, 'NetAntennae');
    // 26.151: once per open end, as the suite reports them
    expect(v).toHaveLength(2);
    expect(v.find((x) => x.prims[0] === i)!.message).toMatch(/^Net Antennae: Track/);
    // A track end on another track of its net is joined
    add(doc, track([38, 20], [38, 22], 0), track([36, 20], [36, 22], 0));
    expect(kinds(doc, 'NetAntennae').some((x) => x.prims[0] === i)).toBe(false);
  });
  it('Minimum Solder Mask Sliver: openings closer than the width, but not touching', () => {
    const doc = demo();
    rule(doc, 'MinimumSolderMaskSliver', { MINSOLDERMASKWIDTH: '10mil' });
    rule(doc, 'SolderMaskExpansion', { EXPANSION: '0mil' });
    const a = add(doc, pad([36, 22], NO_NET), pad([37.2, 22], NO_NET));
    const v = kinds(doc, 'MinimumSolderMaskSliver');
    expect(v.some((x) => x.prims.includes(a) && x.prims.includes(a + 1))).toBe(true);
    // Overlapping openings merge: no sliver
    const doc2 = demo();
    rule(doc2, 'MinimumSolderMaskSliver', { MINSOLDERMASKWIDTH: '10mil' });
    rule(doc2, 'SolderMaskExpansion', { EXPANSION: '0mil' });
    const b = add(doc2, pad([36, 22], NO_NET), pad([36.8, 22], NO_NET));
    expect(kinds(doc2, 'MinimumSolderMaskSliver').some((x) => x.prims.includes(b))).toBe(false);
  });
  it('Silk To Solder Mask and Silk To Silk: text by its strokes', () => {
    const doc = demo();
    rule(doc, 'SilkToSolderMaskClearance', { SCOPE1EXPRESSION: 'IsPad', MINSILKSCREENTOMASKGAP: '4mil', CLEARANCETOEXPOSEDCOPPER: 'TRUE' });
    rule(doc, 'SilkToSilkClearance', { SILKTOSILKCLEARANCE: '4mil' });
    const p = add(doc, pad([36, 22], 0));
    const t = add(doc, text('R1', [35.8, 21.8]));
    expect(kinds(doc, 'SilkToSolderMaskClearance').some((x) => x.prims.includes(p) && x.prims.includes(t))).toBe(true);
    const k = add(doc, { ...track([35.5, 22.3], [38, 22.3], NO_NET, L.TOP_OVERLAY, 0.15) });
    expect(kinds(doc, 'SilkToSilkClearance').some((x) => x.prims.includes(t) && x.prims.includes(k))).toBe(true);
  });
  it('Un-Connected Pin: a component pad with no net and nothing routed to it', () => {
    const doc = demo();
    rule(doc, 'UnConnectedPin');
    const i = add(doc, pad([36, 2], NO_NET));
    expect(kinds(doc, 'UnConnectedPin').map((x) => x.prims[0])).toEqual([i]);
  });
  it('Modified Polygon: a shelved pour unless the rule allows it', () => {
    const doc = demo();
    rule(doc, 'UnpouredPolygon');
    doc.polygons[0]!.bag.set('SHELVED', 'TRUE');
    expect(kinds(doc, 'UnpouredPolygon')[0]!.message).toMatch(/is shelved/);
    rule(doc, 'UnpouredPolygon', { ALLOWSHELVED: 'TRUE' });
    expect(kinds(doc, 'UnpouredPolygon')).toEqual([]);
  });
  it('Height: a component taller than the rule allows', () => {
    const doc = demo();
    rule(doc, 'Height', { MINHEIGHT: '0mil', MAXHEIGHT: '100mil', PREFHEIGHT: '50mil' });
    for (const c of doc.components) c.bag.set('HEIGHT', '50mil');
    doc.prims = doc.prims.filter((p) => p.kind !== 'body');
    expect(kinds(doc, 'Height')).toEqual([]);
    doc.components[0]!.bag.set('HEIGHT', '200mil');
    expect(kinds(doc, 'Height')).toHaveLength(1);
  });
  it('Layer Pairs: a via whose span is no drill pair', () => {
    const doc = demo();
    rule(doc, 'LayerPairs', { ENFORCE: 'TRUE' });
    add(doc, { kind: 'via', src: src('Vias6'), at: P(36, 3), diameter: mm(0.6), hole: mm(0.3), layerStart: L.TOP, layerEnd: L.MID1, net: 0, locked: false });
    expect(kinds(doc, 'LayerPairs')).toHaveLength(1);
  });
});

describe('the Report Options and the rule kinds past them', () => {
  it("Dead Copper: a pour's island cut off from its net, as a warning; off when the board says so", () => {
    const doc = demo();
    expect(kinds(doc, 'UnRoutedNet').filter((v) => v.kind === 'DeadCopper')).toEqual([]);
    // A piece of the GND pour on its own, away from everything
    const poly = doc.prims.find((p) => p.kind === 'region' && p.layer === L.BOTTOM && p.polygon !== NO_NET) as Extract<PcbPrim, { kind: 'region' }>;
    const i = add(doc, { ...poly, outline: [P(41, 30), P(44, 30), P(44, 33), P(41, 33)], holes: [] });
    const v = kinds(doc, 'UnRoutedNet').filter((x) => x.kind === 'DeadCopper');
    expect(v.map((x) => x.prims[0])).toEqual([i]);
    expect(v[0]!.error).toBe(false);
    // A free track joined to nothing isn't (Net Antennae's)
    add(doc, track([30, 2], [33, 2], 0));
    expect(kinds(doc, 'UnRoutedNet').filter((x) => x.kind === 'DeadCopper')).toHaveLength(1);
    // Smaller than the area given, or the option off: not reported
    doc.drcOptions = PropertyBag.from({ RECORD: 'DesignRuleCheckerOptions', DEADCOPPERMINAREA: '1e14' });
    expect(kinds(doc, 'UnRoutedNet').filter((x) => x.kind === 'DeadCopper')).toEqual([]);
    doc.drcOptions = PropertyBag.from({ RECORD: 'DesignRuleCheckerOptions', REPORTDEADCOPPER: 'FALSE' });
    expect(kinds(doc, 'UnRoutedNet').filter((x) => x.kind === 'DeadCopper')).toEqual([]);
    // Only with Un-Routed Net checked
    doc.drcOptions = undefined;
    expect(kinds(doc, 'Clearance').filter((x) => x.kind === 'DeadCopper')).toEqual([]);
  });
  it('the report lists warnings and waived violations apart from the rule violations', () => {
    const doc = demo();
    const r = runDrc(doc, new Set(['UnRoutedNet']));
    const w = { rule: 0, objects: [], comment: 'Meant so', author: 'Tester', created: '2026-10-01T00:00:00Z' };
    const warning = { kind: 'DeadCopper', rule: 'Report Dead Copper', error: false, prims: [], at: { x: 0, y: 0 }, message: 'Dead Copper here' };
    const html = reportHtml('Demo.PcbDoc', doc.rules, new Set(['UnRoutedNet']), { ...r, violations: [...r.violations, warning], waived: [{ v: { ...warning, message: 'Waived one' }, w }] }, 10);
    expect(html).toMatch(/<td>Warnings:<\/td><td>1<\/td>/);
    expect(html).toMatch(/Dead Copper here/);
    expect(html).toMatch(/Waived Violations[\s\S]*Waived one<\/td><td>Meant so<\/td><td>Tester<\/td><td>2026-10-01/);
  });
  it('Maximum Via Count: more vias than the limit', () => {
    const doc = demo();
    rule(doc, 'MaximumViaCount', { LIMIT: '3' });
    expect(kinds(doc, 'MaximumViaCount')).toEqual([]);
    add(doc, { kind: 'via', src: src('Vias6'), at: P(36, 3), diameter: mm(0.6), hole: mm(0.3), layerStart: L.TOP, layerEnd: L.BOTTOM, net: 0, locked: false });
    expect(kinds(doc, 'MaximumViaCount')[0]!.message).toMatch(/Via Count = 4\) \(Maximum = 3\)/);
  });
  it('Permitted Layers: a component on a side the rule leaves out', () => {
    const doc = demo();
    rule(doc, 'PermittedLayers', { 'TOP LAYER_V5': 'TRUE', 'BOTTOM LAYER_V5': 'FALSE' });
    expect(kinds(doc, 'PermittedLayers')).toEqual([]);
    doc.components[1]!.layer = L.BOTTOM;
    expect(kinds(doc, 'PermittedLayers').map((v) => v.message)).toEqual([expect.stringMatching(/Component C1 .* on Bottom Layer/)]);
  });
  it('Max Via Stub Length: the barrel past the last layer a via joins, unless back drilled from that side', () => {
    const doc = demo();
    const v = add(doc, { kind: 'via', src: src('Vias6'), at: P(36, 3), diameter: mm(0.6), hole: mm(0.3), layerStart: L.TOP, layerEnd: L.BOTTOM, net: 1, locked: false },
      track([36, 3], [38, 3], 1));
    rule(doc, 'BackDrilling', { MAXSTUBLENGTH: '10mil', USETOPBACKDRILL: 'FALSE', USEBOTTOMBACKDRILL: 'FALSE' });
    expect(kinds(doc, 'BackDrilling').map((x) => x.prims[0])).toContain(v);
    rule(doc, 'BackDrilling', { MAXSTUBLENGTH: '10mil', USETOPBACKDRILL: 'FALSE', USEBOTTOMBACKDRILL: 'TRUE' });
    expect(kinds(doc, 'BackDrilling').map((x) => x.prims[0])).not.toContain(v);
  });
  it('Creepage: copper of two nets nearer than the distance across the surface, measured round cutouts, slots and unplated holes', () => {
    const doc = demo();
    rule(doc, 'Creepage', { DISTANCE: '40mil', IGNOREINTERNALLAYERS: 'TRUE', APPLYTOPOLYGONPOUR: 'FALSE' });
    const base = kinds(doc, 'Creepage').length;
    const a = add(doc, track([36, 10], [38, 10], 1), track([36, 10.9], [38, 10.9], 2));
    const pair = () => kinds(doc, 'Creepage').filter((x) => x.prims.includes(a) && x.prims.includes(a + 1));
    expect(pair()).toHaveLength(1);
    // A small unplated hole between them: the copper beside it is still that near
    add(doc, pad([37, 10.45], NO_NET, { layer: L.MULTI, hole: mm(0.5), plated: false, component: NO_NET, top: stack(0.5), mid: stack(0.5), bot: stack(0.5) }));
    expect(pair()).toHaveLength(1);
    // A cutout between them, longer than they are: the way round is 2.25 mm, over the distance
    const cut = (x0: number, x1: number): PcbPrim => ({ kind: 'region', src: src('Regions6'), layer: L.MULTI, outline: [P(x0, 10.35), P(x1, 10.35), P(x1, 10.55), P(x0, 10.55)], holes: [], regionKind: 0, boardCutout: true, net: NO_NET, polygon: NO_NET, component: NO_NET, locked: false, keepout: false });
    add(doc, cut(35, 39));
    expect(kinds(doc, 'Creepage')).toHaveLength(base);
    // Two pads either side of a slot: round its ends (about 1.15 mm), within a 2 mm rule, over 40 mil
    const doc2 = demo();
    rule(doc2, 'Creepage', { DISTANCE: '40mil', IGNOREINTERNALLAYERS: 'TRUE', APPLYTOPOLYGONPOUR: 'FALSE' });
    const base2 = kinds(doc2, 'Creepage').length;
    const b = add(doc2, pad([36, 22], 1, { component: NO_NET }), pad([37.6, 22], 2, { component: NO_NET }),
      pad([36.8, 22], NO_NET, { layer: L.MULTI, hole: mm(0.3), plated: true, slot: { length: mm(1.4), rotation: 90 }, component: NO_NET, top: stack(0.3), mid: stack(0.3), bot: stack(0.3) }));
    expect(kinds(doc2, 'Creepage')).toHaveLength(base2);
    rule(doc2, 'Creepage', { DISTANCE: '2mm', IGNOREINTERNALLAYERS: 'TRUE', APPLYTOPOLYGONPOUR: 'FALSE' });
    const v = kinds(doc2, 'Creepage').filter((x) => x.prims.includes(b) && x.prims.includes(b + 1));
    expect(v).toHaveLength(1);
    const d = Number(/\(([\d.]+)mil </.exec(v[0]!.message)![1]) * 0.0254;
    expect(d).toBeGreaterThan(1.1);
    expect(d).toBeLessThan(1.2);
  });
  it('Return Path: a track the next layer has no copper under, GAP past its edges', () => {
    const doc = demo();
    rule(doc, 'ReturnPath', { GAP: '5mil', SCOPE1EXPRESSION: "InNet('VIN')" });
    // The demo's GND pour on the bottom is under it: without it, nothing is
    const i = add(doc, track([36, 10], [38, 10], 1));
    expect(kinds(doc, 'ReturnPath').map((x) => x.prims[0])).not.toContain(i);
    doc.prims = doc.prims.map((p) => (p.kind === 'region' && p.layer === L.BOTTOM ? { ...p, layer: L.MID1 } : p));
    expect(kinds(doc, 'ReturnPath').map((x) => x.prims[0])).toContain(i);
    add(doc, { kind: 'fill', src: src('Fills6'), layer: L.BOTTOM, a: P(35, 9), b: P(39, 11), rotation: 0, net: 0, component: NO_NET, locked: false, keepout: false });
    expect(kinds(doc, 'ReturnPath').map((x) => x.prims[0])).not.toContain(i);
  });
  it('Testpoint Usage: a net with no testpoint where one is required; none where they are prohibited', () => {
    const doc = demo();
    rule(doc, 'FabricationTestPointUsage', { VALID: '0', ALLOWMULTIPLE: 'FALSE' });
    expect(kinds(doc, 'FabricationTestPointUsage').map((v) => v.message)).toContain('Fabrication Testpoint Usage: Net GND - Missing required testpoint');
    rule(doc, 'FabricationTestPointUsage', { VALID: '2' });
    expect(kinds(doc, 'FabricationTestPointUsage')).toEqual([]);
  });
  it("copper text clears other nets' copper by its strokes", () => {
    const doc = demo();
    const t = add(doc, text('XY', [36, 6], L.TOP));
    expect(kinds(doc, 'Clearance').some((v) => v.prims.includes(t))).toBe(false);
    const k = add(doc, track([35.5, 6.3], [39, 6.3], 0));
    expect(kinds(doc, 'Clearance').some((v) => v.prims.includes(t) && v.prims.includes(k))).toBe(true);
  });
});

describe('fab-house profiles', () => {
  const jlc = FAB_PROFILES.find((p) => p.id === 'jlcpcb-2')!;
  it('every profile names its page and keeps its limits positive', () => {
    expect(FAB_PROFILES.length).toBeGreaterThanOrEqual(8);
    for (const p of FAB_PROFILES) {
      expect(p.source).toMatch(/^https:\/\//);
      for (const v of [p.track, p.space, p.drill, p.ring, p.holeToHole, p.edge]) expect(v).toBeGreaterThan(0);
    }
  });
  it("lists the board's rules that allow less than the house makes, and raises only the general ones", () => {
    const doc = demo();
    const w = doc.rules.find((r) => ruleKind(r) === 'Width')!;
    w.bag.set('MINLIMIT', '2mil');
    const rows = compareProfile(doc, jlc);
    expect(rows.find((r) => r.limit.kind === 'Width')!.rules.some((x) => x.below)).toBe(true);
    const { rules, changed } = rulesWithProfile(doc, jlc);
    expect(changed.some((c) => /Track width/.test(c))).toBe(true);
    expect(ruleLength(rules.find((r) => ruleKind(r) === 'Width' && r.bag.get('SCOPE1EXPRESSION') === 'All')!, 'MINLIMIT', '0mil')).toBe(jlc.track);
    // The board's own rules are left as they were until applied
    expect(ruleLength(w, 'MINLIMIT', '0mil')).toBe(mil(2));
  });
  it("checks the board's copper against the house, not against the board's rules", () => {
    const doc = demo();
    expect(checkAgainstProfile(doc, jlc).violations.filter((v) => v.kind === 'Width')).toEqual([]);
    add(doc, track([30, 1.5], [33, 1.5], NO_NET, L.BOTTOM, 0.05));
    expect(checkAgainstProfile(doc, jlc).violations.some((v) => v.kind === 'Width')).toBe(true);
  });
});
