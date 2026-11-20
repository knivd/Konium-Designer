import { describe, expect, it } from 'vitest';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoSchDoc } from '../src/formats/synthetic/demo';
import { symbolsSchDoc } from '../src/formats/synthetic/gallery';
import { autoJunctions, orphanJunctions } from '../src/model/schConnect';
import { addRecords, removeObjects, wireBag } from '../src/model/schEdit';
import { writeSchDoc } from '../src/formats/altium/schdoc';
import { bytesEqual } from '../src/formats/bin';
import { powerGlyph } from '../src/editors/sch/powerPort';
import { pinGlyph, portOutline } from '../src/editors/sch/symbols';
import { mil } from '../src/core/units';

const at = (x: number, y: number) => ({ x: mil(x), y: mil(y) });

describe('power ports', () => {
  it('bar is ±50 mil at the end of a 100 mil stem', () => {
    const g = powerGlyph(2);
    expect(g.lines).toEqual([[[0, 0], [100, 0]], [[100, -50], [100, 50]]]);
  });
  it('power ground has four shrinking bars', () => {
    const bars = powerGlyph(4).lines.slice(1).map((l) => l[1]![1]);
    expect(bars).toEqual([100, 70, 40, 10]);
  });
});

describe('pins', () => {
  it('a dot shortens the pin line; one hollow arrow: the outside symbol flow, else the electrical type', () => {
    const dot = pinGlyph({ inner: 0, innerEdge: 0, outerEdge: 1, outer: 0 }, 4, true);
    expect(dot.lineFrom).toBe(60);
    expect(dot.parts.some((p) => p.fills?.length)).toBe(false);
    const input = pinGlyph({ inner: 0, innerEdge: 0, outerEdge: 0, outer: 0 }, 0, true);
    expect(input.parts).toHaveLength(1);
    expect(input.parts[0]!.lines[0]![0]).toEqual([0, 0]);          // the tip at the body: pointing in
    expect(input.lineFrom).toBe(60);                                 // the pin line stops at the arrow
    expect(pinGlyph({ inner: 0, innerEdge: 0, outerEdge: 0, outer: 0 }, 0, false).parts).toHaveLength(0);
    // An input pin with an outward flow symbol: one arrow, the symbol's
    const sym = pinGlyph({ inner: 0, innerEdge: 0, outerEdge: 0, outer: 33 }, 0, true);
    expect(sym.parts).toHaveLength(1);
    expect(sym.parts[0]!.lines[0]![0]).toEqual([60, 0]);
    // Dot plus inward arrow (RESET): the arrow outside the dot
    const reset = pinGlyph({ inner: 0, innerEdge: 0, outerEdge: 1, outer: 2 }, 0, true);
    expect(reset.parts[1]!.lines[0]![0]).toEqual([60, 0]);
    expect(reset.lineFrom).toBe(120);
    // Bidirectional: two arrows back to back
    expect(pinGlyph({ inner: 0, innerEdge: 0, outerEdge: 0, outer: 34 }, 1, true).parts[0]!.lines).toHaveLength(2);
  });
  it('clock sits inside the body', () => {
    const g = pinGlyph({ inner: 0, innerEdge: 3, outerEdge: 0, outer: 0 }, 4, false);
    expect(Math.min(...g.parts[0]!.lines[0]!.map((p) => p[0]))).toBe(-50);
  });
});

describe('ports', () => {
  it('left & right style points both ends half the height deep', () => {
    expect(portOutline(3, 600, 100)).toEqual([[0, 0], [50, -50], [550, -50], [600, 0], [550, 50], [50, 50]]);
    expect(portOutline(0, 600, 100)).toHaveLength(4);
  });
});

describe('automatic junctions', () => {
  it('demo sheet: T-junctions get dots, plain wire–pin joints do not', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const pts = autoJunctions(doc).map((j) => `${j.at.x / mil(10)},${j.at.y / mil(10)}`);
    // The demo already stores manual junctions at the T's on the VIN and 3V3 rails
    expect(pts).toEqual([]);
  });
  it('gallery: the T gets one, the crossing gets none', () => {
    const doc = readSchDoc(symbolsSchDoc(), 'Symbols.SchDoc');
    const pts = autoJunctions(doc).map((j) => `${j.at.x / mil(10)},${j.at.y / mil(10)}`);
    expect(pts).toContain('810,150');
    expect(pts).not.toContain('810,125');
  });
  it('ignores wires that only meet end to end', () => {
    const doc = readSchDoc(symbolsSchDoc(), 'Symbols.SchDoc');
    expect(autoJunctions(doc).every((j) => j.at.x !== at(720, 0).x)).toBe(true);
  });
});

describe('record count header', () => {
  it('WEIGHT follows added and removed records; undo restores the original bytes', () => {
    const bytes = demoSchDoc();
    const doc = readSchDoc(bytes, 'Demo.SchDoc');
    const before = doc.records[0]!.bag!.int('WEIGHT');
    expect(before).toBe(doc.records.length - 1);
    const add = addRecords(doc, [wireBag([at(0, 0), at(100, 0)])]);
    add.apply();
    expect(doc.records[0]!.bag!.int('WEIGHT')).toBe(before + 1);
    add.revert();
    expect(bytesEqual(writeSchDoc(doc), bytes)).toBe(true);
    const rm = removeObjects(doc, [doc.objects.findIndex((o) => o.kind === 'wire')]);
    rm.apply();
    expect(doc.records[0]!.bag!.int('WEIGHT')).toBe(doc.records.length - 1);
    rm.revert();
    expect(bytesEqual(writeSchDoc(doc), bytes)).toBe(true);
  });
});

describe('orphan junctions', () => {
  it('deleting the stub of a T takes its junction; the rail keeps the others', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    // The C1 stub wire (250,370)-(250,360) does not touch a junction; the VIN rail does (two junctions at y=430)
    const rail = doc.objects.find((o) => o.kind === 'wire' && o.pts[0]!.y === mil(4300) && o.pts[0]!.x === mil(1600));
    expect(rail).toBeTruthy();
    const orphans = orphanJunctions(doc, new Set([rail!.index]));
    // The junction at (250,430) sits on the rail and C1's pin only once the rail is gone: removed
    expect(orphans.length).toBe(1);
  });
});

describe('text frames', () => {
  it('reads wrap, clip, margin and alignment; absent booleans are off', () => {
    const doc = readSchDoc(symbolsSchDoc(), 'Symbols.SchDoc');
    const tf = doc.objects.find((o) => o.kind === 'textframe');
    expect(tf && tf.kind === 'textframe' && [tf.wrap, tf.clip, tf.margin, tf.align]).toEqual([true, true, mil(50), 1]);
  });
});
