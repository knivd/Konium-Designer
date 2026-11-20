import { describe, expect, it } from 'vitest';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { readPcbDoc, writePcbDoc, encodeArc, encodeFill, encodeRegion, encodeText, encodeVia } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc, demoSchDoc } from '../src/formats/synthetic/demo';
import { addRecords } from '../src/model/schEdit';
import { addPrimRecords, freshRecord } from '../src/model/pcbEdit';
import {
  arcBag, bezierBag, busEntryBag, ellipseBag, junctionBagAt, labelBag, netLabelBag, nextName, noErcBag, offSheetBag, polygonBag, polylineBag,
  portBag, powerBag, rectBag, textFrameBag,
} from '../src/model/schPlace';
import { mil } from '../src/core/units';
import { L } from '../src/model/layers';

const P = (x: number, y: number) => ({ x: mil(x), y: mil(y) });

describe('placing schematic objects', () => {
  it('every new object saves and reads back as Altium records', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const before = doc.objects.length;
    addRecords(doc, [
      netLabelBag('DATA0', P(1000, 1000)), powerBag(4, 'GND', P(1100, 1000)), powerBag(2, '+5', P(1200, 1000)),
      portBag('Port1', P(1300, 1000), mil(600), 3, 2), offSheetBag('CLK', P(1400, 1000)), noErcBag(P(1500, 1000)),
      labelBag('Note', P(1600, 1000)), junctionBagAt(P(1700, 1000)), busEntryBag(P(1800, 1000)),
      textFrameBag(P(100, 100), P(400, 300), 'Frame~1text'), rectBag(P(500, 100), P(700, 300)), rectBag(P(800, 100), P(1000, 300), true),
      polylineBag([P(0, 0), P(100, 0), P(100, 100)]), polygonBag([P(0, 0), P(100, 0), P(50, 80)]), ellipseBag(P(1200, 200), mil(100), mil(50)),
      arcBag(P(1400, 200), mil(80), 0, 90), arcBag(P(1600, 200), mil(80)), bezierBag([P(0, 0), P(50, 100), P(100, 100), P(150, 0)]),
    ]).apply();
    const again = readSchDoc(writeSchDoc(doc), 'Demo.SchDoc');
    const added = again.objects.slice(before);
    expect(added.map((o) => o.kind)).toEqual(['text', 'power', 'power', 'port', 'power', 'noerc', 'text', 'junction', 'busentry', 'textframe', 'rect', 'rect',
      'polyline', 'polygon', 'ellipse', 'arc', 'arc', 'bezier']);
    const label = added[0] as { kind: 'text'; role: string; text: string; at: { x: number } };
    expect([label.role, label.text, label.at.x]).toEqual(['netlabel', 'DATA0', mil(1000)]);
    const gnd = added[1] as { kind: 'power'; style: number; orient: number; text: string };
    expect([gnd.style, gnd.orient, gnd.text]).toEqual([4, 3, 'GND']);
    const port = added[3] as { kind: 'port'; width: number; name: string; io: number };
    expect([port.width, port.name, port.io]).toEqual([mil(600), 'Port1', 2]);
    expect((added[4] as { crossSheet: boolean }).crossSheet).toBe(true);
    expect((added[9] as { text: string }).text).toBe('Frame\ntext');
    const arc = added[15] as { start: number; end: number; rx: number };
    expect([arc.start, arc.end, arc.rx]).toEqual([0, 90, mil(80)]);
  });

  it('auto-increments names as Altium does', () => {
    expect(['NetLabel1', 'D09', 'A', 'Port'].map((s) => nextName(s))).toEqual(['NetLabel2', 'D10', 'B', 'Port']);
    expect(nextName('D09', 2)).toBe('D11');
    expect(nextName('D01', 1, true)).toBe('D2');
    expect(nextName('R10', -1)).toBe('R09');
  });
});

describe('placing PCB objects', () => {
  it('via, string, fill, arc and region save and read back', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const count = (k: string) => doc.prims.filter((p) => p.kind === k).length;
    const before = { via: count('via'), text: count('text'), fill: count('fill'), arc: count('arc'), region: count('region') };
    const o = doc.board.origin;
    const at = (x: number, y: number) => ({ x: o.x + mil(x), y: o.y + mil(y) });
    addPrimRecords(doc, [
      { storage: 'Vias6', rec: freshRecord(doc, 'Vias6', (t) => encodeVia({ at: at(100, 100), diameter: mil(40), hole: mil(20) }, t)) },
      { storage: 'Texts6', rec: freshRecord(doc, 'Texts6', (t) => encodeText({ layer: L.TOP_OVERLAY, at: at(200, 100), height: mil(60), strokeWidth: mil(10), text: 'String' }, t)) },
      { storage: 'Fills6', rec: freshRecord(doc, 'Fills6', (t) => encodeFill({ layer: L.TOP, a: at(300, 100), b: at(350, 150) }, t)) },
      { storage: 'Arcs6', rec: freshRecord(doc, 'Arcs6', (t) => encodeArc({ layer: L.TOP, c: at(400, 100), r: mil(50), start: 0, end: 90, width: mil(10) }, t)) },
      { storage: 'Regions6', rec: encodeRegion({ layer: L.TOP, outline: [at(500, 100), at(600, 100), at(550, 180)] }) },
    ]).apply();
    const again = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    const c2 = (k: string) => again.prims.filter((p) => p.kind === k).length;
    expect({ via: c2('via'), text: c2('text'), fill: c2('fill'), arc: c2('arc'), region: c2('region') })
      .toEqual({ via: before.via + 1, text: before.text + 1, fill: before.fill + 1, arc: before.arc + 1, region: before.region + 1 });
    const s = again.prims.find((p) => p.kind === 'text' && p.text === 'String');
    expect(s && s.kind === 'text' && [s.height, s.layer, s.component]).toEqual([mil(60), L.TOP_OVERLAY, 0xffff]);
    const a = again.prims.find((p) => p.kind === 'arc' && p.r === mil(50));
    expect(a && a.kind === 'arc' && [a.start, a.end, a.polygon, a.locked]).toEqual([0, 90, 0xffff, false]);
  });
});

import { readSchLib, writeSchLib, decodeBinaryPin, encodeBinaryPin } from '../src/formats/altium/schlib';
import { demoSchLib } from '../src/formats/synthetic/demoLib';
import { partRecords, symbolFootprint } from '../src/model/schPlace';
import { compileProject } from '../src/model/compile';
import { identity, transformBag } from '../src/model/schTransform';
import { PropertyBag } from '../src/formats/altium/props';

describe('schematic libraries', () => {
  it('binary library pins round-trip', () => {
    const b = PropertyBag.from({ RECORD: 2, OWNERPARTID: 2, ELECTRICAL: 7, PINCONGLOMERATE: 0x19, PINLENGTH: 20, NAME: 'V+', DESIGNATOR: '8', COLOR: 0, DESCRIPTION: 'Supply' });
    b.set('LOCATION.X', '20'); b.set('LOCATION.Y', '-20');
    const d = decodeBinaryPin(encodeBinaryPin(b))!;
    expect(['OWNERPARTID', 'ELECTRICAL', 'PINCONGLOMERATE', 'PINLENGTH', 'NAME', 'DESIGNATOR', 'LOCATION.X', 'LOCATION.Y', 'DESCRIPTION'].map((k) => d.get(k)))
      .toEqual(['2', '7', '25', '20', 'V+', '8', '20', '-20', 'Supply']);
  });

  it('reads the demo library: symbols in order, pins, parts and footprints', () => {
    const lib = readSchLib(demoSchLib(), 'Demo.SchLib');
    expect(lib.symbols.map((s) => s.libRef)).toEqual(['Res', 'Cap', 'LED', 'Header 2', 'LDO SOT-223', 'LM358']);
    const ldo = lib.symbols[4]!;
    expect(ldo.bags.filter((b) => b.int('RECORD') === 2).map((b) => `${b.get('DESIGNATOR')}:${b.get('NAME')}`)).toEqual(['3:VIN', '2:VOUT', '1:GND', '4:TAB']);
    expect(symbolFootprint(ldo.bags)).toBe('SOT-223');
    expect(lib.symbols[5]!.parts).toBe(2);
    // and writes back what it read
    const again = readSchLib(writeSchLib(lib.symbols), 'x.SchLib');
    expect(again.symbols.map((s) => s.bags.length)).toEqual(lib.symbols.map((s) => s.bags.length));
  });

  it('a placed part compiles with its pins, designator and footprint', () => {
    const lib = readSchLib(demoSchLib(), 'Demo.SchLib');
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const items = partRecords(lib.symbols[4]!, 'Demo.SchLib');
    const base = doc.records.length - 1;
    const x = { ...identity(), d: P(2000, 2000) };
    const bags = items.map((it) => { const b = transformBag(it.bag, x); if (it.owner >= 0) b.setRaw('OWNERINDEX', String(base + it.owner)); return b; });
    bags.find((b) => b.int('RECORD') === 34)!.set('TEXT', 'U9');
    addRecords(doc, bags).apply();
    const r = compileProject([{ name: 'Demo.SchDoc', doc }]);
    const u9 = r.components.find((c) => c.designator === 'U9');
    expect(u9 && [u9.libRef, u9.footprint, u9.comment]).toEqual(['LDO SOT-223', 'SOT-223', 'LDO 3V3']);
    const pins = doc.objects.filter((o) => o.kind === 'pin' && o.owner === base);
    expect(pins.length).toBe(4);
  });
});
