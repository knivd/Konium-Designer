/**
 * EDIF text heights (26.191): a file of this test's own, as xDX Designer writes one. Its figure
 * groups say how high their texts are (textHeight), a text may say its own in its
 * figureGroupOverride, and the sheet made from it has each text in a font of that size.
 */
import { describe, expect, it } from 'vitest';
import { readEdif } from '../src/formats/edif/read';
import { importerFor } from '../src/formats/importers';
import { load } from '../src/formats/registry';
import type { SchDocument, SchObject } from '../src/model/sch';

const enc = new TextEncoder();
/** A display in a group, with its own height when one is given. */
const disp = (x: number, y: number, group = 'ATTRIBUTE', height = 0) => `(display (figureGroupOverride ${group} (visible (true))${height ? ` (textHeight ${height})` : ''}) (justify LOWERLEFT) (orientation R0) (origin (pt ${x} ${y})))`;
const TECH = (labels: number) => `(technology (numberDefinition (scale 1 (e 1 -8) (unit DISTANCE))) (figureGroup ATTRIBUTE (textHeight 254000)) (figureGroup LABEL (textHeight ${labels})) (figureGroup PIN))`;
const FILE = `(edif Heights
 (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
 (status (written (timestamp 2026 11 17 10 0 0) (program "xDX Designer Edif Exporter" (version "test"))))
 (library Parts (edifLevel 0) ${TECH(203200)}
  (cell RES_GEN (cellType GENERIC)
   (view RES (viewType SCHEMATIC)
    (interface
     (designator "R?")
     (port B1 (direction INOUT) (designator "1"))
     (port B2 (direction INOUT) (designator "2"))
     (symbol
      (boundingBox (rectangle (pt 0 -101600) (pt 762000 101600)))
      (figure BOX (rectangle (pt 127000 -101600) (pt 635000 101600)))
      (portImplementation (name B1 ${disp(25400, -76200, 'LABEL')}) (connectLocation (figure GRAPHICS (dot (pt 0 0)))) (figure PIN (path (pointList (pt 127000 0) (pt 0 0)))))
      (portImplementation (name B2 ${disp(660400, -76200, 'LABEL')}) (connectLocation (figure GRAPHICS (dot (pt 762000 0)))) (figure PIN (path (pointList (pt 635000 0) (pt 762000 0))))))))))
 (library Design (edifLevel 0) ${TECH(254000)}
  (cell TOP (cellType GENERIC)
   (view SCHEMATIC_VIEW (viewType SCHEMATIC)
    (interface)
    (contents
     (page SH1 (pageSize (rectangle (pt 0 0) (pt 12700000 10160000)))
      (instance I1
       (viewRef RES (cellRef RES_GEN (libraryRef Parts)))
       (transform (origin (pt 2540000 7620000)))
       (designator (stringDisplay "R1" ${disp(2667000, 8001000, 'ATTRIBUTE', 228600)}))
       (property Value (string (stringDisplay "10k" ${disp(2667000, 7747000)})) (owner "Test")))
      (net (name VIN ${disp(1270000, 7645400, 'LABEL', 152400)}) (joined (portRef B1 (instanceRef I1))) (figure NET (path (pointList (pt 1270000 7620000) (pt 2540000 7620000)))))
      (net (name OUT ${disp(3556000, 7645400, 'LABEL')}) (joined (portRef B2 (instanceRef I1))) (figure NET (path (pointList (pt 3302000 7620000) (pt 4572000 7620000)))))
      (commentGraphics (annotate (stringDisplay "First line
second line" ${disp(1270000, 5080000, 'ATTRIBUTE', 508000)})))))))
 (design Heights (cellRef TOP (libraryRef Design))))
`;

describe('EDIF text heights (26.191)', () => {
  it('reads each text\'s height in millimetres: its own, else its figure group\'s in its library', () => {
    const d = readEdif(FILE);
    const page = d.libraries.get('design')!.cells.get('top')!.views[0]!.pages[0]!;
    const inst = page.instances[0]!;
    expect(inst.designatorDisplays.map((x) => x.height)).toEqual([2.286]);
    expect(inst.props.get('Value')!.displays.map((x) => x.height)).toEqual([2.54]);
    expect(page.nets.map((n) => [n.name.text, n.name.displays[0]!.height])).toEqual([['VIN', 1.524], ['OUT', 2.54]]);
    // The symbol's pin names are in its own library's LABEL group: 2.032 mm there
    const sym = d.libraries.get('parts')!.cells.get('res_gen')!.views[0]!.symbol!;
    expect([...sym.pins.values()].map((p) => p.nameDisplays[0]!.height)).toEqual([2.032, 2.032]);
  });

  it('the sheet has each text in a font of its size (capitals 0.63 of the height; a point is 5 mil of them), pins in the size their names have', async () => {
    const im = importerFor('Heights.eds', enc.encode(FILE))!;
    const r = await im.run([{ path: 'Heights.eds', bytes: enc.encode(FILE) }]);
    const sheet = r.projects[0]!.documents.find((x) => /\.SchDoc$/i.test(x.name))!;
    const doc = load(sheet.bytes, sheet.name) as SchDocument;
    const size = (o: SchObject | undefined) => doc.sheet.fonts[((o as unknown as { font: number }).font || 1) - 1]?.size;
    const text = (t: string) => doc.objects.find((o) => 'text' in o && (o as unknown as { text: string }).text === t);
    // 2.286 mm: 11 points; 2.54 mm: 13; 1.524 mm: 8; 5.08 mm: 25
    expect([size(text('R1')), size(text('10k')), size(text('VIN')), size(text('OUT')), size(text('First line')), size(text('second line'))]).toEqual([11, 13, 8, 13, 25, 25]);
    // The system font, which pins are drawn in: 2.032 mm, 10 points
    expect(doc.sheet.fonts[0]!.size).toBe(10);
    // Lines of one text stand a line apart for their size (1.2 of the height: 6.1 mm, 24 of the sheet's 10 mil)
    const a = text('First line') as unknown as { at: { y: number } }, b = text('second line') as unknown as { at: { y: number } };
    expect((a.at.y - b.at.y) / 100_000).toBe(24);
  });

  it('a file that gives no heights is as before: 10 points throughout', async () => {
    const plain = FILE.replace(/ \(textHeight \d+\)/g, '');
    const r = await importerFor('Heights.eds', enc.encode(plain))!.run([{ path: 'Heights.eds', bytes: enc.encode(plain) }]);
    const sheet = r.projects[0]!.documents.find((x) => /\.SchDoc$/i.test(x.name))!;
    const doc = load(sheet.bytes, sheet.name) as SchDocument;
    expect(doc.sheet.fonts.map((f) => f.size)).toEqual([10]);
  });
});
