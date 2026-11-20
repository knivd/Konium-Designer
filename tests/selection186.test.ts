/**
 * Live Simulation of a selection (26.186): what is selected goes to a sheet of its own, with rails for the supplies its
 * power ports name and its grounds under other names as GND.
 */
import { describe, expect, it } from 'vitest';
import { isGroundAlias, selectionSketch, sketchNote, supplyVolts } from '../src/app/liveSelection';
import { LIVE_EXAMPLES, liveExampleBytes, liveExampleFile } from '../src/app/liveExamples';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { addRecords, removeObjects, wireBag } from '../src/model/schEdit';
import { powerBag } from '../src/model/schPlace';
import { docParam, docParamChange } from '../src/model/schParams';
import { LIVE_SAVED } from '../src/app/liveSaved';
import { compileProject } from '../src/model/compile';
import { projectNetlist, type LiveMap } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';

describe('a supply net\'s voltage by its name (26.186)', () => {
  it('reads the common ways of writing one', () => {
    const want: [string, number | null][] = [['+5V', 5], ['5V', 5], ['3V3', 3.3], ['+3V3', 3.3], ['+3.3V', 3.3], ['1V8', 1.8], ['+12V', 12], ['-12V', -12], ['N12V', -12], ['P5V', 5], ['P3V3', 3.3],
      ['VDD_3V3', 3.3], ['+5V_USB', 5], ['3V3_AUX', 3.3], ['VCC5V', 5], ['VNEG_5V', -5], ['24V', 24], ['+0V9', 0.9],
      ['VCC', null], ['VDD', null], ['VBAT', null], ['VIN', null], ['GND', null], ['V5', null], ['NET5', null], ['5VA1', null]];
    for (const [name, v] of want) expect(supplyVolts(name), name).toBe(v);
  });
  it('knows a ground under another name from GND itself and from a supply', () => {
    for (const n of ['AGND', 'DGND', 'PGND', 'SGND', 'GNDA', 'GND_ISO', 'GND1', 'VSS', 'VSSA', '0V', 'EARTH']) expect(isGroundAlias(n), n).toBe(true);
    for (const n of ['GND', 'gnd', '+5V', 'VCC', 'GNDLESS_NET', 'SIGNAL']) expect(isGroundAlias(n), n).toBe(false);
  });
});

describe('a selection as a sketch (26.186)', () => {
  /** The divider example with its source taken off and power ports in its place: a real design's corner. */
  const design = () => {
    const ex = LIVE_EXAMPLES.find((e) => e.id === 'divider')!, doc = readSchDoc(liveExampleBytes(ex), liveExampleFile(ex));
    const v1 = doc.objects.find((o) => o.kind === 'component' && o.designator === 'V1')!;
    removeObjects(doc, [v1.index, ...doc.objects.filter((o) => o.kind === 'power').map((o) => o.index)]).apply();
    // Where the source's pins were: +5V on top, AGND below; and a VCC port joined to nothing of the divider
    const U = 100_000;
    const top = powerBag(2, '+5V', { x: 160 * U, y: 420 * U }), low = powerBag(4, 'AGND', { x: 160 * U, y: 380 * U }), vcc = powerBag(2, 'VCC', { x: 600 * U, y: 500 * U });
    addRecords(doc, [top, low, vcc, wireBag([{ x: 600 * U, y: 500 * U }, { x: 600 * U, y: 480 * U }])]).apply();
    docParamChange(doc, LIVE_SAVED, 'v=1;keep=R9>1')!.apply();
    return doc;
  };
  const everything = (doc: ReturnType<typeof design>) => doc.objects.filter((o) => o.owner < 0 && o.record !== 31).map((o) => o.index);

  it('takes what is selected, gives +5V a 5 V rail and has AGND as GND; the sketch runs and the divider halves 5 V', () => {
    const doc = design(), sk = selectionSketch(doc, everything(doc), 'Board selection.SchDoc');
    expect(sk.parts).toBe(doc.objects.filter((o) => o.kind === 'component').length);
    expect(sk.rails).toEqual(['+5V']); expect(sk.grounds).toEqual(['AGND']); expect(sk.unknown).toEqual(['VCC']); expect(sk.reference).toBe(true);
    expect(sketchNote(sk)).toBe(`${sk.parts} parts taken to a sketch of their own; +5V is a supply by its name; AGND is GND here; VCC says no voltage: place a source on it.`);
    // The design is as it was, and the sketch does not keep the design's monitors
    expect(doc.objects.some((o) => o.kind === 'component' && o.libRef === 'RAIL_DC')).toBe(false);
    expect(docParam(doc, LIVE_SAVED)?.value).toBe('v=1;keep=R9>1');
    expect(docParam(sk.doc, LIVE_SAVED)).toBeUndefined();
    // It is a file like any other, and runs
    const back = readSchDoc(writeSchDoc(sk.doc), 'Board selection.SchDoc'), sheets = [{ name: back.name, doc: back }];
    const rail = back.objects.find((o) => o.kind === 'component' && o.libRef === 'RAIL_DC')!;
    expect(rail.kind === 'component' && rail.designator).toBe('V1');
    const map: LiveMap = { nets: new Map(), pins: new Map() };
    const net = projectNetlist(compileProject(sheets), sheets, defaultSettings(), () => null, 'Live Simulation', map);
    expect(net.messages.filter((m) => m.level === 'error')).toEqual([]);
    expect(net.text).toMatch(/^V1 \S+ 0 DC 5$/m);
    const sim = new Simulator(readNetlist(net.text));
    sim.liveStart({});
    expect(sim.valueOf(map.pins.get('V1|1')!.node)).toBeCloseTo(5, 6);
    expect(sim.valueOf(map.pins.get('TP1|1')!.node)).toBeCloseTo(2.5, 3);
    // AGND is GND in the sketch, and 0 V
    expect(back.objects.some((o) => o.kind === 'power' && o.text === 'AGND')).toBe(false);
    expect(map.nets.get('GND')).toBe('0');
  });

  it('takes only what is selected: one resistor alone is one part, with nothing to give it', () => {
    const doc = design(), r1 = doc.objects.find((o) => o.kind === 'component' && o.designator === 'R1')!;
    const sk = selectionSketch(doc, [r1.index], 'One.SchDoc');
    expect(sk.parts).toBe(1); expect(sk.rails).toEqual([]); expect(sk.grounds).toEqual([]); expect(sk.unknown).toEqual([]); expect(sk.reference).toBe(false);
    expect(sk.doc.objects.filter((o) => o.kind === 'wire' || o.kind === 'power')).toEqual([]);
    expect(sketchNote(sk)).toBe('1 part taken to a sketch of its own; there is no GND: place one where 0 V is to be.');
  });
});
