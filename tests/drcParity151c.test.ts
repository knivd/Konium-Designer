import { describe, expect, it } from 'vitest';
import { encodeText, readPcbDoc, rebuildPrims } from '../src/formats/altium/pcbdoc';
import { TEXT, put } from '../src/formats/altium/pcbLayouts';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { gridCovers, gridStrokeText } from '../src/formats/gerber/strokeGrid';
import { runDrc } from '../src/model/drc';
import { newRule, ruleKind } from '../src/formats/altium/rules';
import { mil, mm } from '../src/core/units';
import { L, type LayerId } from '../src/model/layers';
import { NO_NET, type PcbArc, type PcbDocument, type PcbPad, type PcbPrim, type PcbText, type PcbTrack, type PcbVia } from '../src/model/pcb';

/**
 * Silk To Solder Mask, Silk To Silk and Minimum Solder Mask Sliver as AD's DRC reports them: text
 * measured in AD's Default stroke font (a grid font, strokeGrid.ts) with no slack, arcs measured
 * as arcs, a sliver checked where AD checks it and reported once for both sides. Small boards
 * built here, away from the demo board's own objects.
 */

const O = { x: mil(5000), y: mil(5000) };
const P = (x: number, y: number) => ({ x: O.x + mil(x), y: O.y + mil(y) });
const src = (storage: string) => ({ storage, index: -1 });
const add = (doc: PcbDocument, ...p: PcbPrim[]) => { doc.prims = [...doc.prims, ...p]; return doc.prims.length - p.length; };
const rule = (doc: PcbDocument, kind: string, set: Record<string, string> = {}) => { const r = newRule(kind, kind, 1); for (const [k, v] of Object.entries(set)) r.bag.set(k, v); doc.rules = [...doc.rules.filter((x) => ruleKind(x) !== kind), r]; };
const run = (doc: PcbDocument, kind: string, ...of: number[]) => runDrc(doc, new Set([kind])).violations.filter((v) => of.every((i) => v.prims.includes(i)));
const rect = (w: number, h: number) => ({ w: mil(w), h: mil(h), shape: 'rect' as const, cornerPct: 0 });
const pad = (at: [number, number], w: number, h: number, o: Partial<PcbPad> = {}): PcbPad =>
  ({ kind: 'pad', src: src('Pads6'), name: '1', layer: L.TOP, at: P(...at), rotation: 0, top: rect(w, h), mid: rect(w, h), bot: rect(w, h), hole: 0, plated: true, net: NO_NET, component: NO_NET, locked: false, ...o });
const via = (at: [number, number], d: number): PcbVia => ({ kind: 'via', src: src('Vias6'), at: P(...at), diameter: mil(d), hole: mil(d / 2), layerStart: L.TOP, layerEnd: L.BOTTOM, net: NO_NET, locked: false });
const track = (a: [number, number], b: [number, number], width: number, layer: LayerId = L.TOP_OVERLAY): PcbTrack =>
  ({ kind: 'track', src: src('Tracks6'), layer, a: P(...a), b: P(...b), width, net: NO_NET, component: NO_NET, polygon: NO_NET, locked: false, keepout: false });
/** Stroke text as the showcase's designators: 0.7 mm high, 0.098 mm strokes. */
const text = (s: string, at: [number, number], o: Partial<PcbText> = {}): PcbText =>
  ({ kind: 'text', src: src('Texts6'), layer: L.TOP_OVERLAY, at: P(...at), height: mm(0.7), rotation: 0, mirrored: false, strokeWidth: mm(0.098), text: s, component: NO_NET, isComment: false, isDesignator: true, fontType: 0, fontName: '', bold: false, italic: false, hidden: false, ...o });

function board(): PcbDocument {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  rule(doc, 'SolderMaskExpansion', { EXPANSION: '4mil' });
  rule(doc, 'SilkToSolderMaskClearance', { SCOPE1EXPRESSION: 'IsPad', MINSILKSCREENTOMASKGAP: '10mil', CLEARANCETOEXPOSEDCOPPER: 'TRUE' });
  rule(doc, 'SilkToSilkClearance', { SILKTOSILKCLEARANCE: '10mil' });
  rule(doc, 'MinimumSolderMaskSliver', { MINSOLDERMASKWIDTH: '1.968mil' });
  return doc;
}

describe("AD's Default stroke font as its DRC measures it", () => {
  const SCALE = 0.999686;
  const extent = (lines: { x: number; y: number }[][]) => {
    const pts = lines.flat();
    return { minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) };
  };
  it('capitals and digits on a grid two thirds of the height wide, from the baseline to the cap height', () => {
    for (const ch of ['E', 'O', '0', '8', 'M']) {
      const e = extent(gridStrokeText(ch, { x: 0, y: 0 }, 6000)!);
      expect(e.minX).toBeCloseTo(0, 6);
      expect(e.maxX).toBeCloseTo(4000 * SCALE, 6);
      expect(e.minY).toBeCloseTo(0, 6);
      expect(e.maxY).toBeCloseTo(6000 * SCALE, 6);
    }
    // 'I' and '1' two units wide; the pen moves on six units after a capital, five after them
    expect(extent(gridStrokeText('I', { x: 0, y: 0 }, 6000)!).maxX).toBeCloseTo(2000 * SCALE, 6);
    expect(extent(gridStrokeText('1E', { x: 0, y: 0 }, 6000)!).maxX).toBeCloseTo(9000 * SCALE, 6);
    expect(extent(gridStrokeText('EE', { x: 0, y: 0 }, 6000)!).maxX).toBeCloseTo(10000 * SCALE, 6);
  });
  it('mirrored to the left of its position; null when a character has no glyph', () => {
    const e = extent(gridStrokeText('E', { x: 0, y: 0 }, 6000, 0, true)!);
    expect(e.minX).toBeCloseTo(-4000 * SCALE, 6);
    expect(e.maxX).toBeCloseTo(0, 6);
    expect(gridCovers('R30')).toBe(true);
    expect(gridCovers('r30')).toBe(false);
    expect(gridStrokeText('r30', { x: 0, y: 0 }, 6000)).toBeNull();
  });
});

describe('Silk To Solder Mask', () => {
  /** A designator whose strokes' bottom edge is 9.882 mil above a pad's copper. */
  function under(s: string, o: Partial<PcbText> = {}) {
    const doc = board();
    const p = add(doc, pad([0, 0], 60, 20));
    const t = add(doc, text(s, [-20, 10 + 9.882 + 3.858 / 2], { strokeWidth: mil(3.858), ...o }));
    return { doc, p, t };
  }
  it("a designator in the Default stroke font is measured exactly: 9.882 mil from a pad's copper is reported, worded as AD words it", () => {
    const { doc, p, t } = under('R30');
    const v = run(doc, 'SilkToSolderMaskClearance', p, t);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/^Silk To Solder Mask Clearance Constraint: \(9\.882mil < 10mil\) Between Text "R30" \(.*\) on Top Overlay And Pad Free-1\(.*\) on Top Layer \[Top Overlay\] to \[Top Solder\] clearance \[9\.882mil\]$/);
  });
  it("text in Konium's stroke font (a character the grid font hasn't), or in the Sans Serif stroke font, keeps its slack", () => {
    const a = under('r30');
    expect(run(a.doc, 'SilkToSolderMaskClearance', a.p, a.t)).toEqual([]);
    // The same text with its record saying Sans Serif (font 2), and as the Default font (1)
    for (const font of [2, 1]) {
      const doc = board();
      const texts = doc.streams.get('Texts6')!;
      const rec = encodeText({ layer: L.TOP_OVERLAY, at: P(-20, 10 + 9.882 + 3.858 / 2), height: mm(0.7), strokeWidth: mil(3.858), text: 'R30' });
      put(rec.subs[0]!, TEXT.font, font);
      texts.records = [...texts.records, rec];
      rebuildPrims(doc);
      const t = doc.prims.findIndex((q) => q.kind === 'text' && q.text === 'R30');
      expect(t).toBeGreaterThanOrEqual(0);
      const p = add(doc, pad([0, 0], 60, 20));
      expect(run(doc, 'SilkToSolderMaskClearance', p, t)).toHaveLength(font === 1 ? 1 : 0);
    }
  });
  it('an arc is measured as an arc, not by its chords', () => {
    const doc = board();
    // A 300 mil circle 6 mil wide whose chords miss its rightmost point; a pad 5.5 mil right of its edge
    const arc: PcbArc = { kind: 'arc', src: src('Arcs6'), layer: L.TOP_OVERLAY, c: P(0, 0), r: mil(300), start: 0.25, end: 360.25, width: mil(6), net: NO_NET, component: NO_NET, polygon: NO_NET, locked: false, keepout: false };
    const a = add(doc, arc);
    const p = add(doc, pad([300 + 3 + 5.5 + 10, 0], 20, 20));
    const v = run(doc, 'SilkToSolderMaskClearance', a, p);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/\(5\.5mil < 10mil\) Between Arc .* clearance \[5\.5mil\]$/);
  });
  it("a track's half width in whole units: an odd width's edge half a unit in", () => {
    const doc = board();
    const p = add(doc, pad([0, 0], 60, 20));
    // 5.9055 mil wide, its centre 8.66145 mil plus half its width above the pad's copper
    const y = P(0, 0).y + mil(10) + 86614.5 + 29527.5;
    const t = add(doc, { ...track([-30, 0], [30, 0], 59055), a: { x: P(-30, 0).x, y }, b: { x: P(30, 0).x, y } });
    const v = run(doc, 'SilkToSolderMaskClearance', p, t);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/^Silk To Solder Mask Clearance Constraint: \(8\.662mil < 10mil\) Between Track/);
  });
});

describe('Silk To Silk', () => {
  /** Single letters as the showcase's lettering: 1.4 mm high, 0.196 mm strokes, 1.26 mm apart. */
  const letter = (s: string, x: number, o: Partial<PcbText> = {}) => text(s, [x, 0], { height: mm(1.4), strokeWidth: mm(0.196), isDesignator: false, ...o });
  it("letters measured by the grid font's glyphs: a K's arm tip off an O's cut corner, an I's bars against a U", () => {
    const doc = board();
    const k = add(doc, letter('K', 0));
    const o = add(doc, letter('O', 1.26 / 0.0254));
    const v = run(doc, 'SilkToSilkClearance', k, o);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/^Silk To Silk Clearance Constraint: \(8\.09\dmil < 10mil\) Between Text "K" \(.*\) on Top Overlay And Text "O" \(.*\) on Top Overlay Silk Text to Silk Clearance \[8\.09\dmil\]$/);
    // An N's straight side: the common gap
    const doc2 = board();
    const n = add(doc2, letter('N', 0));
    const o2 = add(doc2, letter('O', 1.26 / 0.0254));
    expect(run(doc2, 'SilkToSilkClearance', n, o2)[0]!.message).toMatch(/\(5\.15\dmil < 10mil\)/);
    // An I's bars reach a third of the height: 0.42 heights on, a U collides with them
    const doc3 = board();
    const i = add(doc3, letter('I', 0));
    const u = add(doc3, letter('U', (0.42 * 1.4) / 0.0254));
    expect(run(doc3, 'SilkToSilkClearance', i, u)[0]!.message).toMatch(/\(Collision < 10mil\) .* Silk Text to Silk Clearance \[0mil\]$/);
  });
  it('the text named first, of two texts the earlier in the file', () => {
    const doc = board();
    const l = add(doc, track([-20, 27.559 + 3.858 / 2 + 5 + 3], [60, 27.559 + 3.858 / 2 + 5 + 3], mil(6)));
    const t = add(doc, text('C4', [0, 0]));
    expect(run(doc, 'SilkToSilkClearance', t, l)[0]!.message).toMatch(/Between Text "C4" .* And Track /);
    const doc2 = board();
    const b = add(doc2, text('B', [40, 0]));
    const a = add(doc2, text('A', [20, 0]));
    expect(b).toBeLessThan(a);
    expect(run(doc2, 'SilkToSilkClearance', a, b)[0]!.message).toMatch(/Between Text "B" .* And Text "A" /);
  });
});

describe('Minimum Solder Mask Sliver', () => {
  it('a pair with slivers on both sides is one violation naming both', () => {
    const doc = board();
    // 18 mil vias, their 26 mil openings 1 mil apart on the top and on the bottom
    const a = add(doc, via([0, 0], 18));
    const b = add(doc, via([27, 0], 18));
    const v = run(doc, 'MinimumSolderMaskSliver', a, b);
    expect(v).toHaveLength(1);
    expect(v[0]!.message).toMatch(/^Minimum Solder Mask Sliver Constraint: \(1mil < 1\.968mil\) Between Via .* And Via .* \[Top Solder\] Mask Sliver \[1mil\] \/ \[Bottom Solder\] Mask Sliver \[1mil\]$/);
  });
  /** Two pads one above the other, their openings 1.5 mil apart, and a big pad whose opening laps over their left or right ends. */
  function row(bigAt: number) {
    const doc = board();
    const a = add(doc, pad([0, 0], 30, 10));
    const b = add(doc, pad([0, -19.5], 30, 10));
    add(doc, pad([bigAt, -9.75], 40, 60));
    return { doc, a, b };
  }
  it("is checked at its leftmost (then lowest) spot: an exposed pad's opening over the pads' right ends leaves the sliver, over their left ends opens it", () => {
    // Openings 38 mil wide: the big one's (48 mil) edge 2 mil over the pads' right ends
    const right = row(19 + 24 - 2);
    expect(run(right.doc, 'MinimumSolderMaskSliver', right.a, right.b)).toHaveLength(1);
    const left = row(-(19 + 24 - 2));
    expect(run(left.doc, 'MinimumSolderMaskSliver', left.a, left.b)).toEqual([]);
  });
  it("a via whose opening covers where two pads' sliver is checked opens it; the next pad's sliver, out of its reach, stands", () => {
    const doc = board();
    const a = add(doc, pad([0, 0], 30, 10));
    const b = add(doc, pad([0, -19.5], 30, 10));
    add(doc, via([-19, -9.75], 18));
    expect(run(doc, 'MinimumSolderMaskSliver', a, b)).toEqual([]);
    const c = add(doc, pad([0, -39], 30, 10));
    expect(run(doc, 'MinimumSolderMaskSliver', b, c)).toHaveLength(1);
  });
});
