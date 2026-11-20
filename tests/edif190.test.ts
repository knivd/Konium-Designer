/**
 * EDIF as xDX Designer writes it (26.190): a file of this test's own in that dialect. A divider of
 * three resistors between VIN and ground: the designators and pin numbers are in the cell's
 * viewMap, texts say whether they are shown, the ground is drawn in two pieces that each end in a
 * ground symbol placed in a port of the page, and the file is called .eds.
 */
import { describe, expect, it } from 'vitest';
import { listEdif, takesEdif } from '../src/formats/edif/import';
import { readEdif } from '../src/formats/edif/read';
import { importerFor } from '../src/formats/importers';
import { load } from '../src/formats/registry';
import type { SchDocument, SchObject } from '../src/model/sch';

const enc = new TextEncoder();
const disp = (v: boolean, x: number, y: number, just = 'LOWERLEFT', group = 'ATTRIBUTE') => `(display (figureGroupOverride ${group} (visible (${v ? 'true' : 'false'}))) (justify ${just}) (orientation R0) (origin (pt ${x} ${y})))`;
/** A resistor placed at x, y (its pins at x and x + 762000): its texts where the page has them. */
const res = (id: string, x: number, y: number, value: string) => `
      (instance (rename &0441${id} "$1${id}")
       (viewRef RES (cellRef (name RES_GEN ${disp(false, x + 939800, y - 965200)}) (libraryRef Parts)))
       (transform (origin (pt ${x} ${y})))
       (portInstance B1 (designator (stringDisplay "" ${disp(false, x, y)})))
       (portInstance B2 (designator (stringDisplay "" ${disp(false, x + 762000, y)})))
       (designator (stringDisplay "R?" ${disp(true, x + 127000, y + 381000)}))
       (property (rename Part_Name "Part Name") (string (stringDisplay "RES_GEN" ${disp(false, x + 939800, y - 584200)})) (owner "Test"))
       (property Value (string (stringDisplay "${value} " ${disp(true, x + 127000, y + 127000)})) (owner "Test")))`;
const ground = (id: string, x: number, y: number) => `
      (portImplementation (name GND ${disp(false, x, y - 381000, 'UPPERLEFT', 'LABEL')})
       (connectLocation (figure GRAPHICS (dot (pt ${x} ${y}))))
       (instance (rename &0441${id} "$1${id}") (viewRef gnd (cellRef gnd (libraryRef Globals))) (transform (origin (pt ${x} ${y})))
        (property (rename Global_Signal_Name "Global Signal Name") (string (stringDisplay "GND" ${disp(false, x, y - 381000)})) (owner "Test"))))`;
const wire = (...pts: [number, number][]) => `(figure NET (path (pointList ${pts.map(([x, y]) => `(pt ${x} ${y})`).join(' ')})))`;
const back = (id: string, des: string, b1: string, b2: string) => `
     (instanceBackAnnotate (instanceRef &0441${id} (viewRef SCHEMATIC_VIEW)) (designator "${des}") (property (rename Part_Name "Part Name") (string " ") (owner "Test")))
     (portBackAnnotate (portRef B1 (instanceRef &0441${id} (viewRef SCHEMATIC_VIEW))) (designator "${b1}"))
     (portBackAnnotate (portRef B2 (instanceRef &0441${id} (viewRef SCHEMATIC_VIEW))) (designator "${b2}"))`;
const UNIT = '(technology (numberDefinition (scale 1 (e 1 -8) (unit DISTANCE))))';
const XDX = `  (edif Divider
 (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
 (status (written (timestamp 2026 11 17 10 0 0) (program "xDX Designer Edif Exporter" (version "test"))))
 (library Parts (edifLevel 0) ${UNIT}
  (cell RES_GEN (cellType GENERIC)
   (view RES (viewType SCHEMATIC)
    (interface
     (designator "R?")
     (port B1 (direction INOUT) (designator "1") (property (rename Pin_Type "Pin Type") (string "ANALOG") (owner "Test")))
     (port B2 (direction INOUT) (designator "2") (property (rename Pin_Type "Pin Type") (string "ANALOG") (owner "Test")))
     (symbol
      (boundingBox (rectangle (pt 0 -101600) (pt 762000 101600)))
      (figure BOX (rectangle (pt 127000 -101600) (pt 635000 101600)))
      (keywordDisplay cell ${disp(false, 939800, -965200)})
      (keywordDisplay designator ${disp(true, 127000, 381000)})
      (propertyDisplay Value ${disp(true, 127000, 127000)})
      (portImplementation (name B1 ${disp(false, 25400, -76200, 'UPPERLEFT', 'LABEL')}) (connectLocation (figure GRAPHICS (dot (pt 0 0)))) (figure PIN (path (pointList (pt 127000 0) (pt 0 0)))))
      (portImplementation (name B2 ${disp(false, 660400, -76200, 'UPPERLEFT', 'LABEL')}) (connectLocation (figure GRAPHICS (dot (pt 762000 0)))) (figure PIN (path (pointList (pt 635000 0) (pt 762000 0))))))))))
 (library Globals (edifLevel 0) ${UNIT}
  (cell gnd (cellType GENERIC)
   (view gnd (viewType GRAPHIC) (interface)
    (property (rename Global_Signal_Name "Global Signal Name") (string "GND") (owner "Test"))
    (contents
     (boundingBox (rectangle (pt -127000 -254000) (pt 127000 0)))
     (figure LINE (path (pointList (pt 127000 -254000) (pt -127000 -254000))))
     (figure PIN (path (pointList (pt 0 -254000) (pt 0 0))))))))
 (library Design (edifLevel 0) ${UNIT}
  (cell TOP (cellType GENERIC)
   (view SCHEMATIC_VIEW (viewType SCHEMATIC)
    (interface (port (rename GND054AGND "GND,AGND") (property SIGNAL (string "GND,AGND") (owner "Test"))))
    (contents
     (offPageConnector (rename GND054AGND_off "GND,AGND_(offpage::0)"))
     (page SH1 (pageSize (rectangle (pt 0 0) (pt 12700000 10160000)))${res('I1', 2540000, 7620000, '10k')}${res('I2', 5080000, 7620000, '4k7')}${res('I3', 3810000, 6350000, '1k')}${ground('I8', 6350000, 7620000)}${ground('I9', 5080000, 6350000)}
      (net (rename GND054AGND "GND,AGND") (joined (globalPortRef GND054AGND)))
      (net (name VIN ${disp(false, 1270000, 7645400, 'LOWERLEFT', 'LABEL')}) (joined (portRef B1 (instanceRef &0441I1))) ${wire([1270000, 7620000], [2540000, 7620000])})
      (net OUT (joined (portRef B2 (instanceRef &0441I1)) (portRef B1 (instanceRef &0441I2)) (portRef B1 (instanceRef &0441I3)))
       (net (rename &0441N5 (stringDisplay "$1N5" ${disp(true, 5080000, 7645400, 'LOWERRIGHT', 'LABEL')})) (joined (portRef B2 (instanceRef &0441I1)) (portRef B1 (instanceRef &0441I2)) (portRef B1 (instanceRef &0441I3)))
        ${wire([3302000, 7620000], [5080000, 7620000])} ${wire([3556000, 7620000], [3556000, 6350000], [3810000, 6350000])}))
      (net GND (joined (portRef B2 (instanceRef &0441I2)) (portRef B2 (instanceRef &0441I3)) (portRef GND054AGND_off))
       (net (rename &0441N10 (stringDisplay "$1N10" ${disp(false, 5842000, 7645400, 'LOWERLEFT', 'LABEL')})) (joined (portRef B2 (instanceRef &0441I2)) (portRef GND054AGND_off)) ${wire([5842000, 7620000], [6350000, 7620000])})
       (net (rename &0441N11 (stringDisplay "$1N11" ${disp(false, 4572000, 6375400, 'LOWERLEFT', 'LABEL')})) (joined (portRef B2 (instanceRef &0441I3)) (portRef GND054AGND_off)) ${wire([4572000, 6350000], [5080000, 6350000])})))))
   (viewMap${back('I1', 'R1', '1', '2')}${back('I2', 'R2', '2', '1')}${back('I3', 'R3', '1', '2')})))
 (design Divider (cellRef TOP (libraryRef Design))))
`;
/** 25400 of the file's units (hundredths of a micron) are a tenth of an inch: the document's units of a point of the file. */
const at = (x: number, y: number) => ({ x: (x / 25400) * 100_000, y: (y / 25400) * 100_000 });

describe('EDIF as xDX Designer writes it (26.190)', () => {
  it('is taken by its content whatever it is called: .eds as well', () => {
    const bytes = enc.encode(XDX);
    expect(takesEdif('Divider.eds', XDX.slice(0, 200))).toBe(true);
    expect(takesEdif('Divider.anything', XDX.slice(0, 200))).toBe(true);
    expect(takesEdif('Divider.eds', 'PCB FILE 6 VERSION 2.80')).toBe(false);
    expect(importerFor('Divider.eds', bytes)!.id).toBe('edif');
    expect(importerFor('Divider.eds', bytes)!.exts).toContain('.eds');
    expect(listEdif([{ path: 'Divider.eds', bytes }]).map((i) => i.path)).toEqual(['Divider.eds']);
    expect(listEdif([{ path: 'Divider.eds' }]).map((i) => i.path)).toEqual(['Divider.eds']);
  });

  it('is read: what is shown, the pieces of a net as one net, symbols in the page\'s ports, a GRAPHIC view\'s drawing, the viewMap', () => {
    const d = readEdif(XDX);
    const page = d.libraries.get('design')!.cells.get('top')!.views[0]!.pages[0]!;
    // The designators and pin numbers the design was given, over the symbols' own
    expect(page.instances.map((i) => [i.designator, i.pinNumbers.get('b1'), i.pinNumbers.get('b2'), i.pinShown.get('b1')])).toEqual([['R1', '1', '2', false], ['R2', '2', '1', false], ['R3', '1', '2', false]]);
    // (a back-annotated blank is no value)
    expect(page.instances[0]!.props.get('Part Name')!.value).toBe('');
    expect(page.instances[0]!.designatorDisplays.map((x) => x.visible)).toEqual([true]);
    expect(page.instances[0]!.cellDisplays.map((x) => x.visible)).toEqual([false]);
    expect(page.instances[0]!.props.get('Value')!.displays.map((x) => x.visible)).toEqual([true]);
    // Nets: the pieces are their net's, with their wires and the places they show its name
    expect(page.nets.map((n) => [n.name.text, n.figures.length, n.joined.length])).toEqual([['GND,AGND', 0, 0], ['VIN', 1, 1], ['OUT', 2, 3], ['GND', 2, 3]]);
    expect(page.nets[2]!.name.displays.map((x) => [x.visible, x.justify])).toEqual([[true, 'LOWERRIGHT']]);
    expect(page.nets[1]!.name.displays.map((x) => x.visible)).toEqual([false]);
    // The ground symbols: in the page's ports; their cell's drawing is its symbol
    expect(page.ports.map((p) => [p.name, p.symbols.map((s) => s.cell), p.connect])).toEqual([['GND', ['gnd'], { x: 6350000, y: 7620000 }], ['GND', ['gnd'], { x: 5080000, y: 6350000 }]]);
    const gnd = d.libraries.get('globals')!.cells.get('gnd')!.views[0]!;
    expect([gnd.type, gnd.pages.length, gnd.symbol!.figures.length]).toEqual(['GRAPHIC', 0, 2]);
    expect(d.libraries.get('design')!.cells.get('top')!.views[0]!.offPage.get('gnd054agnd_off')).toBe('GND,AGND_(offpage::0)');
  });

  it('becomes the sheet as it was drawn: designators and values where the page has them, hidden texts hidden, grounds as power ports of one net, names where they are shown', async () => {
    const im = importerFor('Divider.eds', enc.encode(XDX))!;
    const r = await im.run([{ path: 'Divider.eds', bytes: enc.encode(XDX) }]);
    // Nothing to warn of: every pin is on the net EDIF joins it to, by the drawing alone
    expect(r.messages.filter((m) => m.level !== 'info')).toEqual([]);
    expect(r.messages[0]!.message).toBe('From xDX Designer Edif Exporter: 1 sheet, 3 parts, 3 nets; 2 symbols');
    // (two symbols: R2's pins are numbered the other way round, so it has a symbol of its own)
    const p = r.projects[0]!;
    expect(p.documents.map((x) => x.name)).toEqual(['Divider.SchDoc', 'Divider.SchLib']);
    const doc = load(p.documents[0]!.bytes, 'Divider.SchDoc') as SchDocument;
    const kids = (c: SchObject) => doc.objects.filter((o) => o.owner === c.index);
    const comps = doc.objects.filter((o): o is Extract<SchObject, { kind: 'component' }> => o.kind === 'component');
    expect(comps.map((c) => c.designator)).toEqual(['R1', 'R2', 'R3']);
    const r1 = comps[0]!, r2 = comps[1]!;
    const texts = (c: SchObject) => kids(c).filter((o): o is Extract<SchObject, { kind: 'text' }> => o.kind === 'text').map((o) => [o.role, o.text, !!o.hidden, o.at.x, o.at.y]);
    // The instance's own texts are where the page has them (not carried off by the part's place a second time)
    expect(texts(r1)).toEqual([
      ['designator', 'R1', false, at(2667000, 8001000).x, at(2667000, 8001000).y],
      ['parameter', '10k', false, at(2667000, 7747000).x, at(2667000, 7747000).y],
    ]);
    expect(texts(r2).map((t) => [t[0], t[1], t[2]])).toEqual([['designator', 'R2', false], ['parameter', '4k7', false]]);
    // Pins: passive by their Pin Type, neither name nor number shown, numbered as the design numbers them
    const pins = (c: SchObject) => kids(c).filter((o): o is Extract<SchObject, { kind: 'pin' }> => o.kind === 'pin').map((o) => [o.name, o.designator, o.electrical, o.showName, o.showDesignator]);
    expect(pins(r1)).toEqual([['B1', '1', 4, false, false], ['B2', '2', 4, false, false]]);
    expect(pins(r2)).toEqual([['B1', '2', 4, false, false], ['B2', '1', 4, false, false]]);
    // The ground: two power ports of the global's first name, drawn as bars, pointing down, where the symbols connect
    const power = doc.objects.filter((o): o is Extract<SchObject, { kind: 'power' }> => o.kind === 'power');
    expect(power.map((o) => [o.text, o.style, o.showText, o.at.x, o.at.y])).toEqual([['GND', 2, false, at(6350000, 7620000).x, at(6350000, 7620000).y], ['GND', 2, false, at(5080000, 6350000).x, at(5080000, 6350000).y]]);
    expect(new Set(power.map((o) => o.orient)).size).toBe(1);
    // Net labels: OUT where it is shown, ending there (justified right); VIN, hidden in the file, kept once in the middle of its wire (on the
    // grid); none of the tool's own names
    const labels = doc.objects.filter((o): o is Extract<SchObject, { kind: 'text' }> => o.kind === 'text' && o.role === 'netlabel').map((o) => [o.text, o.at.x, o.at.y, o.justify % 3]);
    expect(labels).toEqual([['VIN', at(2032000, 7620000).x, at(2032000, 7620000).y, 0], ['OUT', at(5080000, 7620000).x, at(5080000, 7620000).y, 2]]);
    expect(doc.objects.some((o) => o.kind === 'port')).toBe(false);
  });
});
