import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc, shapeBasedTwin } from '../src/formats/altium/pcbdoc';
import { joinBinaryRecords, joinTextRecords, countHeader } from '../src/formats/altium/framing';
import { PropertyBag } from '../src/formats/altium/props';
import { cfbPut, cfbStream } from '../src/formats/cfb/cfb';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { runDrc, widthLimits, outlineEdges } from '../src/model/drc';
import { AD_BATCH, drcSettings, setDrcSettings, waiverIndex } from '../src/model/drcOptions';
import { newRule, ruleKind, ruleName } from '../src/formats/altium/rules';
import { mil } from '../src/core/units';
import { L } from '../src/model/layers';
import type { PcbDocument } from '../src/model/pcb';

/** The demo board with every track too thin for its Width rule. */
function thinDemo(): PcbDocument {
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  for (const r of doc.rules) if (ruleKind(r) === 'Width') { r.bag.set('MINLIMIT', '200mil'); r.bag.set('MAXLIMIT', '300mil'); }
  return doc;
}
const reread = (doc: PcbDocument) => readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');

describe("the board's own Rules To Check (Design Rule Checker Options6)", () => {
  it("uses AD's defaults when the board has none", () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const s = drcSettings(doc);
    expect(s.stopAt).toBe(500);
    for (const k of ['Clearance', 'Width', 'ShortCircuit', 'UnRoutedNet', 'HoleSize', 'MinimumSolderMaskSliver', 'BoardOutlineClearance']) expect(s.batch.has(k)).toBe(true);
    expect(s.batch.has('ComponentClearance')).toBe(false);
    expect(s.online.has('ComponentClearance')).toBe(true);
  });
  it('checks only the rule kinds the board ticks for Batch, and saves the choice with the board', () => {
    const doc = thinDemo();
    expect(runDrc(doc).violations.some((v) => v.kind === 'Width')).toBe(true);
    setDrcSettings(doc, { batch: new Set(['Clearance', 'ShortCircuit']), stopAt: 250 }).apply();
    expect(runDrc(doc).violations.some((v) => v.kind === 'Width')).toBe(false);
    const again = reread(doc);
    const b = again.drcOptions!;
    expect(b.get('RULESETTOCHECK')).toBe('0,15');
    expect(b.get('MAXVIOLATIONCOUNT')).toBe('250');
    expect(drcSettings(again).batch).toEqual(new Set(['Clearance', 'ShortCircuit']));
  });
  it('keeps rule kind numbers it does not know (later AD rule kinds) when it saves the choice', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    doc.drcOptions = PropertyBag.from({ RECORD: 'DesignRuleCheckerOptions', RULESETTOCHECK: '0,2,67,68', ONLINERULESETTOCHECK: '0' });
    setDrcSettings(doc, { batch: new Set(['Clearance']) }).apply();
    expect(doc.drcOptions!.get('RULESETTOCHECK')).toBe('0,67,68');
    expect(AD_BATCH).toContain(53);
  });
  it('the Report Options are kept as AD keeps them (dead copper area in internal units squared)', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    expect(drcSettings(doc)).toMatchObject({ shorting: true, brokenPlanes: true, deadCopper: true, deadArea: 100, starved: true, starvedPct: 50 });
    setDrcSettings(doc, { deadArea: 250, starvedPct: 70, brokenPlanes: false }).apply();
    const b = reread(doc).drcOptions!;
    expect(b.get('DEADCOPPERMINAREA')).toBe('25000000000.000000');
    expect(b.get('MINSTARVEDCOPPERPERCENT')).toBe('70');
    expect(b.get('REPORTBROKENPLANES')).toBe('FALSE');
  });
  it('an undo puts the old settings back', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const c = setDrcSettings(doc, { batch: new Set(['Clearance']) });
    c.apply(); c.revert();
    expect(doc.drcOptions).toBeUndefined();
    expect(doc.dirty.has('Design Rule Checker Options6')).toBe(false);
  });
});

describe('waived violations (WaivedViolations)', () => {
  it('leaves out what was waived in AD: same rule, same objects', () => {
    const doc = thinDemo();
    const all = runDrc(doc).violations.filter((v) => v.kind === 'Width');
    expect(all.length).toBeGreaterThan(1);
    const v = all.find((x) => doc.prims[x.prims[0]!]!.src.index > 0)!, p = doc.prims[v.prims[0]!]!;
    const ruleIndex = doc.rules.findIndex((r) => ruleKind(r) === 'Width' && ruleName(r) === v.rule);
    const rec = PropertyBag.from({ RULEINDEX: ruleIndex, PRIM1KIND: 'Track', PRIM1INDEX: p.src.index, CREATEDAT: '2026-01-01T00:00:00.000Z', AUTHORTITLE: 'Test', SOURCE: 'Portal' });
    cfbPut(doc.cfb.root, 'WaivedViolations/Data', joinTextRecords([rec]));
    cfbPut(doc.cfb.root, 'WaivedViolations/Header', countHeader(1));
    doc.dirty.add('Rules6');
    const again = reread(doc);
    expect(again.waivers).toHaveLength(1);
    const r = runDrc(again);
    expect(r.violations.filter((x) => x.kind === 'Width')).toHaveLength(all.length - 1);
    expect(r.notes.some((n) => /1 waived violation/.test(n))).toBe(true);
    const isWaived = waiverIndex(again);
    expect(isWaived({ kind: 'Width', rule: v.rule, prims: v.prims })).toBe(true);
    expect(isWaived({ kind: 'Width', rule: v.rule, prims: all.find((x) => x !== v)!.prims })).toBe(false);

    // A track before it deleted: saved, the waiver follows its track to its new index
    const t6 = again.streams.get('Tracks6')!;
    const was = p.src.index;
    expect(was).toBeGreaterThan(0);
    t6.records = t6.records.filter((_, k) => k !== 0);
    again.dirty.add('Tracks6');
    const third = reread(again);
    expect(third.waivers![0]!.objects[0]!.index).toBe(was - 1);
    expect(runDrc(third).violations.filter((x) => x.kind === 'Width')).toHaveLength(all.length - 2);
  });
});

describe('region twins (Regions6 and ShapeBasedRegions6)', () => {
  /** The demo board as AD saves it: every Regions6 region again in ShapeBasedRegions6. */
  function twinned(): PcbDocument {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const own = doc.streams.get('Regions6')!.records, lone = doc.streams.get('ShapeBasedRegions6')!.records;
    const sbr = [...own.map(shapeBasedTwin), ...lone];
    cfbPut(doc.cfb.root, 'ShapeBasedRegions6/Data', joinBinaryRecords(sbr));
    cfbPut(doc.cfb.root, 'ShapeBasedRegions6/Header', countHeader(sbr.length));
    return readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
  }
  it('takes each region once', () => {
    const plain = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const doc = twinned();
    const regions = (d: PcbDocument) => d.prims.filter((p) => p.kind === 'region').length;
    expect(doc.regionTwins!.size).toBe(plain.streams.get('Regions6')!.records.length);
    expect(regions(doc)).toBe(regions(plain));
  });
  it("a region's second copy is not a record that couldn't be read (26.171: every such board warned of a short record); one that is, is named by its stream", () => {
    const doc = twinned();
    expect(doc.regionTwins!.size).toBeGreaterThan(0);
    expect(doc.diags.items.filter((d) => d.level !== 'info')).toEqual([]);
    // A track record cut short: kept, not drawn, and said
    const tracks = doc.streams.get('Tracks6')!.records;
    const cut = [...tracks.slice(0, 2), { tag: tracks[2]!.tag, subs: [tracks[2]!.subs[0]!.slice(0, 20)] }, ...tracks.slice(3)];
    cfbPut(doc.cfb.root, 'Tracks6/Data', joinBinaryRecords(cut));
    const again = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    expect(again.diags.items.filter((d) => d.level !== 'info').map((d) => d.message)).toEqual(['Tracks 1: records that could not be read, kept in the file as they are and not drawn']);
    expect(again.prims.filter((p) => p.kind === 'track').length).toBe(tracks.length - 1);
    expect(again.streams.get('Tracks6')!.records.length).toBe(tracks.length);
  });
  it('saves the twins again after an edit: an unchanged region keeps its own, a deleted one loses it', () => {
    const doc = twinned();
    const r6 = doc.streams.get('Regions6')!;
    const n = r6.records.length, lone = doc.streams.get('ShapeBasedRegions6')!.records.length - n;
    r6.records = r6.records.slice(1);
    doc.dirty.add('Regions6');
    const bytes = writePcbDoc(doc);
    const again = readPcbDoc(bytes, 'Demo.PcbDoc');
    expect(again.streams.get('ShapeBasedRegions6')!.records.length).toBe(n - 1 + lone);
    expect(again.regionTwins!.size).toBe(n - 1);
  });
  it('an unedited board is saved byte for byte', () => {
    const doc = twinned();
    const before = cfbStream(doc.cfb.root, 'ShapeBasedRegions6/Data')!;
    const again = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    expect(cfbStream(again.cfb.root, 'ShapeBasedRegions6/Data')).toEqual(before);
  });
});

describe('Width per layer', () => {
  it("MIDLAYERn keys go by AD's layer number (MIDLAYER3 is Mid-Layer 3 wherever it sits in the stack)", () => {
    const r = newRule('Width', 'W', 1);
    r.bag.set('MINLIMIT', '3mil'); r.bag.set('MAXLIMIT', '50mil');
    r.bag.set('MIDLAYER3_MINWIDTH', '10mil'); r.bag.set('TOPLAYER_MAXWIDTH', '8mil');
    expect(widthLimits(r, (L.MID1 + 2) as never)).toEqual({ min: mil(10), max: mil(50) });
    expect(widthLimits(r, L.MID1)).toEqual({ min: mil(3), max: mil(50) });
    expect(widthLimits(r, L.TOP)).toEqual({ min: mil(3), max: mil(8) });
  });
});

describe('board outline arcs', () => {
  it('are measured to 0.005 mil, not to coarse chords', () => {
    const c = { x: 0, y: 0 }, r = mil(2000);
    const edges = outlineEdges([{ p: { x: r, y: 0 }, arc: { c, r, sa: 0, ea: 90 } }, { p: { x: 0, y: r } }, { p: { x: 0, y: 0 } }]);
    let worst = 0;
    for (const [a, b] of edges) {
      if (Math.hypot(a.x, a.y) < r / 2 || Math.hypot(b.x, b.y) < r / 2) continue;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      worst = Math.max(worst, r - Math.hypot(m.x, m.y));
    }
    expect(worst).toBeLessThanOrEqual(50);
    expect(worst).toBeGreaterThan(0);
  });
});
