import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { checkCopper, runDrc, distance } from '../src/model/drc';
import { parseQuery, scopePredicate, UnsupportedQuery } from '../src/model/query';
import { ruleKind, ruleLength, splitRuleRecords, joinRuleRecords } from '../src/formats/altium/rules';
import { bytesEqual } from '../src/formats/bin';
import { cfbStream } from '../src/formats/cfb/cfb';
import { mil, mm } from '../src/core/units';
import { L, type LayerId } from '../src/model/layers';
import type { PcbTrack } from '../src/model/pcb';

const O = { x: mil(1000), y: mil(1000) };
const P = (x: number, y: number) => ({ x: O.x + mm(x), y: O.y + mm(y) });
const NET = { GND: 0, VIN: 1, V33: 2 };
const track = (a: [number, number], b: [number, number], width: number, net: number, layer: LayerId = L.TOP): PcbTrack => ({
  kind: 'track', src: { storage: 'Tracks6', index: -1 }, layer, a: P(...a), b: P(...b), width: mm(width), net, component: 0xffff, polygon: 0xffff, locked: false, keepout: false,
});

describe('Rules6', () => {
  it('reads the demo rules and re-frames them byte-identically', () => {
    const bytes = demoPcbDoc();
    const doc = readPcbDoc(bytes, 'Demo.PcbDoc');
    expect(doc.rulesInFile).toBe(true);
    expect(doc.rules.map(ruleKind)).toContain('Clearance');
    expect(doc.classes[0]).toMatchObject({ name: 'Power', kind: 0, members: ['VIN', '+3V3'] });
    const data = cfbStream(doc.cfb.root, 'Rules6/Data')!;
    expect(bytesEqual(joinRuleRecords(splitRuleRecords(data)), data)).toBe(true);
    expect(bytesEqual(writePcbDoc(doc), bytes)).toBe(true);
  });
  it('an edited rule survives save and reload', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const r = doc.rules.find((x) => ruleKind(x) === 'HoleToHoleClearance')!;
    r.bag.set('GAP', '15mil');
    doc.dirty.add('Rules6');
    const again = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    expect(ruleLength(again.rules.find((x) => ruleKind(x) === 'HoleToHoleClearance')!, 'GAP', '0')).toBe(mil(15));
  });
});

describe('queries', () => {
  it('parses and/or/not with functions', () => {
    expect(parseQuery("InNet('GND') or (IsPad and not OnLayer('Top Layer'))").t).toBe('or');
  });
  it('rejects functions it cannot evaluate instead of passing them', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    expect(() => scopePredicate("IsDiffPair('X')", { doc, polygonNames: new Map() })).toThrow(UnsupportedQuery);
    // A class the board doesn't have: as in AD, the scope takes nothing
    const missing = scopePredicate("InNetClass('Missing')", { doc, polygonNames: new Map() });
    expect(doc.prims.some(missing)).toBe(false);
  });
});

describe('DRC', () => {
  it('the demo board against its own rules: clean (26.151: its sample arc and region have no net, as artwork)', () => {
    const r = runDrc(readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'));
    expect(r.violations.map((v) => v.message)).toEqual([]);
  });
  it('finds clearance, short-circuit, width and un-routed nets', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    // A GND track 0.15 mm from the VIN track at y = 7.2 (0.6 wide): gap 0.15 - 0.2/2 = 0.05 mm ≈ 2 mil
    const near = track([14, 7.2 + 0.3 + 0.15 + 0.1], [18, 7.2 + 0.3 + 0.15 + 0.1], 0.2, NET.GND);
    // A GND track straight through the VIN track
    const cross = track([20, 6], [20, 8.5], 0.3, NET.GND);
    // A 6 mil track (rule minimum 10 mil), on no net, away from everything
    const thin = track([30, 1.5], [33, 1.5], 0.15, 0xffff, L.BOTTOM);
    const live = checkCopper(doc, [near, cross, thin]);
    expect(live.some((v) => v.kind === 'Clearance' && /Collision|mil </.test(v.message))).toBe(true);
    expect(live.some((v) => v.kind === 'ShortCircuit')).toBe(true);
    expect(live.some((v) => v.kind === 'Width')).toBe(true);
  });
  it('the Power class rule (12 mil) applies where the All rule (10 mil) would pass', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    // 11 mil from the VIN track edge
    const off = mm(0.3) + mil(11) + mm(0.1);
    const t = track([15, 0], [18, 0], 0.2, NET.GND);
    t.a.y = P(0, 7.2).y + off; t.b.y = t.a.y;
    const v = checkCopper(doc, [t]);
    expect(v.map((x) => x.rule)).toContain('Clearance_Power');
  });
  it('removing a track leaves an un-routed net', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    doc.prims = doc.prims.filter((p) => !(p.kind === 'track' && p.net === NET.V33 && p.width === mm(0.8) && p.a.x === P(24, 9.4).x));
    const r = runDrc(doc);
    expect(r.violations.some((x) => x.kind === 'UnRoutedNet' && /\+3V3/.test(x.message))).toBe(true);
  });
  it('distance treats pour holes as empty', () => {
    const poly = { t: 'poly' as const, pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], holes: [[{ x: 40, y: 40 }, { x: 60, y: 40 }, { x: 60, y: 60 }, { x: 40, y: 60 }]] };
    expect(distance({ t: 'circle', c: { x: 50, y: 50 }, r: 5 }, poly)).toBe(5);
    expect(distance({ t: 'circle', c: { x: 20, y: 20 }, r: 5 }, poly)).toBeLessThan(0);
  });
});

import { connections as connectionLines, copperShapes as shapesOf } from '../src/model/drc';
import { NO_NET as NONE } from '../src/model/pcb';

describe('pour copper without a net of its own', () => {
  it("takes its polygon's net, so what the pour joins counts as joined (AD17 boards keep pour regions at net 65535)", () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const before = connectionLines(doc).length;
    const pourRegions = doc.prims.filter((p) => p.kind === 'region' && p.polygon !== NONE);
    expect(pourRegions.length).toBeGreaterThan(0);
    // As the AD17 board read: the pour's regions carry no net
    doc.prims = doc.prims.map((p) => (p.kind === 'region' && p.polygon !== NONE ? { ...p, net: NONE } : p));
    expect(connectionLines(doc).length).toBe(before);
    const pour = doc.polygons[0]!;
    expect(shapesOf(doc).filter((s) => { const p = doc.prims[s.prim]!; return p.kind === 'region' && p.polygon === pour.index; }).every((s) => s.net === pour.net)).toBe(true);
  });
});
