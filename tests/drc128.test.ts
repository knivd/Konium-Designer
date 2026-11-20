import { describe, expect, it } from 'vitest';
import { encodePad, readPcbDoc, rebuildPrims } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { runDrc } from '../src/model/drc';
import { reportHtml } from '../src/app/dialogs/Drc';
import { newRule, ruleKind } from '../src/formats/altium/rules';
import { mil, mm } from '../src/core/units';
import { L, type LayerId } from '../src/model/layers';
import { NO_NET, inPour, type PcbDocument, type PcbPad, type PcbPrim, type PcbRegion, type PcbTrack } from '../src/model/pcb';

/**
 * A user's board from an older AD (13): false Keepout ↔ Region violations where the regions were
 * a polygon's poured copper; Silk To Solder Mask reported where the gap was far over the rule;
 * lengths in mils on a metric board. Small boards built here stand in for it.
 */

const O = { x: mil(1000), y: mil(1000) };
const P = (x: number, y: number) => ({ x: O.x + mm(x), y: O.y + mm(y) });
const src = (storage: string) => ({ storage, index: -1 });
const add = (doc: PcbDocument, ...p: PcbPrim[]) => { doc.prims = [...doc.prims, ...p]; return doc.prims.length - p.length; };
const rule = (doc: PcbDocument, kind: string, set: Record<string, string> = {}) => { const r = newRule(kind, kind, 1); for (const [k, v] of Object.entries(set)) r.bag.set(k, v); doc.rules = [...doc.rules.filter((x) => ruleKind(x) !== kind), r]; };
const run = (doc: PcbDocument, ...k: string[]) => runDrc(doc, new Set(k)).violations;
const track = (a: [number, number], b: [number, number], net: number, layer: LayerId = L.TOP, width = 0.25, o: Partial<PcbTrack> = {}): PcbTrack =>
  ({ kind: 'track', src: src('Tracks6'), layer, a: P(...a), b: P(...b), width: mm(width), net, component: NO_NET, polygon: NO_NET, locked: false, keepout: false, ...o });
const rect = (x0: number, y0: number, x1: number, y1: number, o: Partial<PcbRegion> = {}): PcbRegion =>
  ({ kind: 'region', src: src('Regions6'), layer: L.BOTTOM, outline: [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], holes: [], regionKind: 0, boardCutout: false, net: 0, polygon: NO_NET, component: NO_NET, locked: false, keepout: false, ...o });
const stack = (w: number, h = w) => ({ w: mm(w), h: mm(h), shape: 'rect' as const, cornerPct: 0 });
const pad = (at: [number, number], o: Partial<PcbPad> = {}): PcbPad =>
  ({ kind: 'pad', src: src('Pads6'), name: '1', layer: L.TOP, at: P(...at), rotation: 0, top: stack(1), mid: stack(1), bot: stack(1), hole: 0, plated: true, net: NO_NET, component: NO_NET, locked: false, ...o });

/** The demo board without its pour's copper (the pieces under test are added), a 10 mil clearance and a keep-out track at x = 38 mm (0.2 mm wide). */
function keepoutBoard(): { doc: PcbDocument; ko: number; poly: number } {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  doc.prims = doc.prims.filter((p) => !inPour(p));
  rule(doc, 'Clearance', { GAP: '10mil' });
  const ko = add(doc, track([38, 5], [38, 8], NO_NET, L.KEEPOUT, 0.2));
  return { doc, ko, poly: doc.polygons[0]!.index };
}
const between = (doc: PcbDocument, a: number, b: number) => run(doc, 'Clearance').filter((v) => v.prims.includes(a) && v.prims.includes(b));

describe('keep-outs and a polygon pour poured round them', () => {
  it("a pour's own region nearer to a keep-out than the clearance is no violation (AD pours round keep-outs)", () => {
    const { doc, ko, poly } = keepoutBoard();
    // 0.1 mm from the keep-out's edge, under the 10 mil rule
    const r = add(doc, rect(38.2, 5, 39.5, 8, { polygon: poly }));
    expect(between(doc, ko, r)).toEqual([]);
    // Only touching it isn't copper over it either
    const t = add(doc, rect(38.1, 5, 39.5, 8, { polygon: poly }));
    expect(between(doc, ko, t)).toEqual([]);
  });
  it("a hatched pour's tracks likewise", () => {
    const { doc, ko, poly } = keepoutBoard();
    const h = add(doc, track([38.2, 5], [38.2, 8], 0, L.BOTTOM, 0.1, { polygon: poly }));
    expect(between(doc, ko, h)).toEqual([]);
  });
  it('free copper that near is still a violation, named as a Region', () => {
    const { doc, ko } = keepoutBoard();
    const r = add(doc, rect(38.2, 5, 39.5, 8));
    const v = between(doc, ko, r);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/^Clearance Constraint: \(3\.937mil < 10mil\) Between Track .* on Keep-Out Layer And Region \(0 hole\(s\)\) Bottom Layer$/);
  });
  it("a pour's copper over a keep-out (not repoured since) is a collision, named as the polygon's region", () => {
    const { doc, ko, poly } = keepoutBoard();
    const r = add(doc, rect(37.9, 5, 39.5, 8, { polygon: poly }));
    const v = between(doc, ko, r);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/^Clearance Constraint: \(Collision < 10mil\) Between Track .* on Keep-Out Layer And Polygon Region \(0 hole\(s\)\) Bottom Layer$/);
    // A keep-out region overlapping a pour's region: a corner of one deep inside the other
    const { doc: d2, poly: g2 } = keepoutBoard();
    const k2 = add(d2, rect(30, 20, 31, 21, { layer: L.KEEPOUT, net: NO_NET }));
    const over = add(d2, rect(30.5, 20.5, 32, 22, { polygon: g2 }));
    const near = add(d2, rect(31.1, 20, 32, 21, { polygon: g2 }));
    expect(between(d2, k2, over)).toHaveLength(1);
    expect(between(d2, k2, near)).toEqual([]);
  });
  it('a polygon pour cutout flagged keep-out keeps nothing out but pours', () => {
    const { doc } = keepoutBoard();
    const cut = add(doc, rect(30, 20, 31, 21, { regionKind: 1, keepout: true, net: NO_NET }));
    const t = add(doc, track([31.05, 20], [31.05, 21], 1, L.BOTTOM, 0.05));
    expect(between(doc, cut, t)).toEqual([]);
    // A copper-kind keep-out region there is one
    const k = add(doc, rect(30, 22, 31, 23, { keepout: true, net: NO_NET }));
    const t2 = add(doc, track([31.05, 22], [31.05, 23], 1, L.BOTTOM, 0.05));
    expect(between(doc, k, t2)).toHaveLength(1);
  });
  it("a pour region's genuine clearance violation names it as the polygon's region; its arcs' approximation comes from the polygon when the region has none", () => {
    const { doc, poly } = keepoutBoard();
    // 0.3 mil under the 10 mil rule from a VIN track: within the pour's 0.5 mil arc approximation
    const r = add(doc, rect(30, 20, 32, 22, { polygon: poly }));
    const t = add(doc, track([32 + 0.254 - 0.3 * 0.0254 + 0.05, 20], [32 + 0.254 - 0.3 * 0.0254 + 0.05, 22], 1, L.BOTTOM, 0.1));
    expect(doc.polygons[0]!.bag.get('ARCRESOLUTION')).toBe('0.5mil');
    expect(between(doc, r, t)).toEqual([]);
    doc.polygons[0]!.bag.set('ARCRESOLUTION', '0mil');
    doc.prims = [...doc.prims];
    const v = between(doc, r, t);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/Between Polygon Region \(0 hole\(s\)\) Bottom Layer And Track|Between Track .* And Polygon Region \(0 hole\(s\)\) Bottom Layer/);
  });
});

/** The demo board with a 0.1 mm Silk To Solder Mask rule (AD's: pads against all silk) and AD's 4 mil mask expansion. */
function silkBoard(set: Record<string, string> = {}): PcbDocument {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  rule(doc, 'SilkToSolderMaskClearance', { SCOPE1EXPRESSION: 'IsPad', MINSILKSCREENTOMASKGAP: '3.937mil', CLEARANCETOEXPOSEDCOPPER: 'FALSE', ...set });
  rule(doc, 'SolderMaskExpansion', { EXPANSION: '4mil' });
  return doc;
}
const silkHits = (doc: PcbDocument, a: number, b: number) => run(doc, 'SilkToSolderMaskClearance').filter((v) => v.prims.includes(a) && v.prims.includes(b));

describe('Silk To Solder Mask Clearance', () => {
  it('measures to the opening: the pad grown by its expansion', () => {
    const doc = silkBoard();
    const p = add(doc, pad([36, 22]));
    // Silk 0.25 mm from the copper (0.148 mm from the opening): clear; 0.15 mm (0.048 mm from it): not
    const ok = add(doc, track([35, 21.5 - 0.25 - 0.075], [37, 21.5 - 0.25 - 0.075], NO_NET, L.TOP_OVERLAY, 0.15));
    const bad = add(doc, track([35, 22.5 + 0.15 + 0.075], [37, 22.5 + 0.15 + 0.075], NO_NET, L.TOP_OVERLAY, 0.15));
    expect(silkHits(doc, p, ok)).toEqual([]);
    expect(silkHits(doc, p, bad)).toHaveLength(1);
  });
  it("a pad on the bottom layer opens by its own shape (the top's, as it is drawn and plotted), not a stale bottom size", () => {
    const doc = silkBoard();
    // AD keeps a single-layer pad's size in the top's fields; the bottom's here are left from something else
    const p = add(doc, pad([36, 22], { layer: L.BOTTOM, bot: stack(3) }));
    const s = add(doc, track([35, 21.5 - 0.3 - 0.075], [37, 21.5 - 0.3 - 0.075], NO_NET, L.BOTTOM_OVERLAY, 0.15));
    expect(silkHits(doc, p, s)).toEqual([]);
  });
  it('a through pad with a Simple stack has the top\'s shape on the bottom too', () => {
    const doc = silkBoard();
    const p = add(doc, pad([36, 22], { layer: L.MULTI, hole: mm(0.5), stackMode: 0, top: stack(1.2), mid: stack(1.2), bot: stack(3) }));
    const s = add(doc, track([35, 21.4 - 0.3 - 0.075], [37, 21.4 - 0.3 - 0.075], NO_NET, L.BOTTOM_OVERLAY, 0.15));
    expect(silkHits(doc, p, s)).toEqual([]);
    // Top-Middle-Bottom: the bottom's own
    const doc2 = silkBoard();
    const p2 = add(doc2, pad([36, 22], { layer: L.MULTI, hole: mm(0.5), stackMode: 1, top: stack(1.2), mid: stack(1.2), bot: stack(3) }));
    const s2 = add(doc2, track([35, 21.4 - 0.3 - 0.075], [37, 21.4 - 0.3 - 0.075], NO_NET, L.BOTTOM_OVERLAY, 0.15));
    expect(silkHits(doc2, p2, s2)).toHaveLength(1);
  });
  it("a pad's own expansion (Pad dialog) is used over the rule's", () => {
    const doc = silkBoard();
    const pads = doc.streams.get('Pads6')!;
    pads.records = [...pads.records, encodePad({ name: '9', layer: L.TOP, at: P(36, 22), w: mm(1), h: mm(1), shape: 'rect', solderExpansion: 0 })];
    rebuildPrims(doc);
    const p = doc.prims.findIndex((q) => q.kind === 'pad' && q.name === '9');
    // 0.15 mm from the copper: clear of an opening the copper's own size
    const s = add(doc, track([35, 22.5 + 0.15 + 0.075], [37, 22.5 + 0.15 + 0.075], NO_NET, L.TOP_OVERLAY, 0.15));
    expect(silkHits(doc, p, s)).toEqual([]);
  });
  it('the rules as they are now: a changed Solder Mask Expansion rule is used at once', () => {
    const doc = silkBoard();
    const p = add(doc, pad([36, 22]));
    const s = add(doc, track([35, 22.5 + 0.15 + 0.075], [37, 22.5 + 0.15 + 0.075], NO_NET, L.TOP_OVERLAY, 0.15));
    expect(silkHits(doc, p, s)).toHaveLength(1);
    rule(doc, 'SolderMaskExpansion', { EXPANSION: '0mil' });
    expect(silkHits(doc, p, s)).toEqual([]);
  });
  it("Check Clearance To Exposed Copper: a pad's copper, not its opening; vias and what's drawn on the mask layers aren't exposed pad copper", () => {
    const doc = silkBoard({ CLEARANCETOEXPOSEDCOPPER: 'TRUE', SCOPE1EXPRESSION: 'All' });
    const p = add(doc, pad([36, 22]));
    const s = add(doc, track([35, 22.5 + 0.15 + 0.075], [37, 22.5 + 0.15 + 0.075], NO_NET, L.TOP_OVERLAY, 0.15));
    expect(silkHits(doc, p, s)).toEqual([]);
    const v = add(doc, { kind: 'via', src: src('Vias6'), at: P(36, 19), diameter: mm(0.6), hole: mm(0.3), layerStart: L.TOP, layerEnd: L.BOTTOM, net: NO_NET, locked: false });
    const m = add(doc, track([33, 19.5], [34, 19.5], NO_NET, L.TOP_SOLDER, 0.3));
    const sv = add(doc, track([33, 19.38], [37, 19.38], NO_NET, L.TOP_OVERLAY, 0.15));
    expect(run(doc, 'SilkToSolderMaskClearance').filter((x) => x.prims.includes(sv))).toEqual([]);
    // Against the openings they are
    rule(doc, 'SilkToSolderMaskClearance', { SCOPE1EXPRESSION: 'All', MINSILKSCREENTOMASKGAP: '3.937mil', CLEARANCETOEXPOSEDCOPPER: 'FALSE' });
    const hits = run(doc, 'SilkToSolderMaskClearance').filter((x) => x.prims.includes(sv)).map((x) => x.prims[0]);
    expect(hits).toEqual(expect.arrayContaining([v, m]));
  });
});

describe("DRC messages in the board's units", () => {
  /** Violations of many kinds on the demo board. */
  function messy(metric: boolean): PcbDocument {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    if (metric) doc.board.bag!.set('DISPLAYUNIT', '0');
    rule(doc, 'Clearance', { GAP: '0.254mm' });
    rule(doc, 'Width', { MINLIMIT: '0.3mm', MAXLIMIT: '1mm', PREFEREDWIDTH: '0.3mm' });
    rule(doc, 'HoleSize', { MINLIMIT: '0.5mm', MAXLIMIT: '2mm' });
    rule(doc, 'SilkToSolderMaskClearance', { SCOPE1EXPRESSION: 'IsPad', MINSILKSCREENTOMASKGAP: '0.1mm', CLEARANCETOEXPOSEDCOPPER: 'FALSE' });
    rule(doc, 'SolderMaskExpansion', { EXPANSION: '0.1mm' });
    rule(doc, 'MinimumAnnularRing', { MINIMUMRING: '0.2mm' });
    rule(doc, 'Height', { MINHEIGHT: '0mm', MAXHEIGHT: '0.1mm', PREFHEIGHT: '0.1mm' });
    add(doc, track([36, 10], [38, 10], 1), track([36, 10.4], [38, 10.4], 2, L.TOP, 0.1));
    add(doc, { kind: 'via', src: src('Vias6'), at: P(36, 3), diameter: mm(0.5), hole: mm(0.3), layerStart: L.TOP, layerEnd: L.BOTTOM, net: 0, locked: false });
    add(doc, pad([36, 22]), track([35, 22.6], [37, 22.6], NO_NET, L.TOP_OVERLAY, 0.15));
    return doc;
  }
  const KINDS = ['Clearance', 'Width', 'HoleSize', 'SilkToSolderMaskClearance', 'MinimumAnnularRing', 'Height'];
  it('mm on a metric board, in every rule kind', () => {
    const v = runDrc(messy(true), new Set(KINDS)).violations;
    expect(new Set(v.map((x) => x.kind))).toEqual(new Set(KINDS));
    for (const x of v) {
      expect(x.message).not.toMatch(/\dmil\b/);
      expect(x.message).toMatch(/\dmm\b/);
    }
    const c = v.find((x) => x.kind === 'Clearance' && /Track \(36mm,10\.4mm\)\(38mm,10\.4mm\) on Top Layer/.test(x.message))!;
    expect(c.message).toMatch(/^Clearance Constraint: \(0\.225mm < 0\.254mm\) Between Track/);
    expect(v.filter((x) => x.kind === 'Width').map((x) => x.message)).toContainEqual(expect.stringMatching(/^Width Constraint \(Min=0\.3mm\) \(Max=1mm\): Track \(36mm,10\.4mm\)\(38mm,10\.4mm\) on Top Layer Actual Width = 0\.1mm$/));
  });
  it('mils on an imperial board', () => {
    const v = runDrc(messy(false), new Set(KINDS)).violations;
    expect(v.length).toBeGreaterThan(0);
    for (const x of v) expect(x.message).not.toMatch(/\dmm\b/);
    expect(v.filter((x) => x.kind === 'Width').map((x) => x.message)).toContainEqual(expect.stringMatching(/^Width Constraint \(Min=11\.811mil\) \(Max=39\.37mil\): .* Actual Width = 3\.937mil$/));
  });
  it("the report's rule headings follow the messages' units", () => {
    const doc = messy(true);
    const r = runDrc(doc, new Set(KINDS));
    expect(r.units).toBe('mm');
    const html = reportHtml('Demo.PcbDoc', doc.rules, new Set(KINDS), r, 10);
    expect(html).toMatch(/Clearance Constraint \(Gap=0\.254mm\)/);
    expect(html).not.toMatch(/Gap=10mil/);
  });
});
