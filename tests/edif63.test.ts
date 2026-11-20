import { describe, expect, it } from 'vitest';
import { importEdif, takesEdif } from '../src/formats/edif/import';
import { parseEdif, readEdif } from '../src/formats/edif/read';
import { IMPORTERS, importerFor } from '../src/formats/importers';
import { load } from '../src/formats/registry';
import { compileProject } from '../src/model/compile';
import { readPrjPcb, iniGet } from '../src/formats/altium/prjpcb';
import { demoFiles } from '../src/formats/synthetic/demo';
import { edifNetlist } from '../src/formats/netlists';
import type { SchDocument } from '../src/model/sch';

const enc = new TextEncoder();
const sheetsOf = (p: { documents: { name: string; bytes: Uint8Array }[] }) => p.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: load(d.bytes, d.name) as SchDocument }));
const groups = (sheets: { name: string; doc: SchDocument }[], scope: 2 | 3 = 3) =>
  new Map(compileProject(sheets, { scope }).nets.filter((n) => n.pins.length).map((n) => [n.name, n.pins.map((q) => `${q.designator}-${q.pin}`).sort().join(' ')]));

/** A resistor symbol (pins 1 and 2 on the left and right of a box, the designator above), a ground symbol, a page drawing them. */
const SCH = `(edif TEST
 (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
 (status (written (timeStamp 2026 10 29 12 0 0) (program "Test Capture" (version "1.0"))))
 (library LIB (edifLevel 0)
  (technology (numberDefinition (scale 1 (e 254 -6) (unit DISTANCE))) (figureGroup BODY (pathWidth 0)) (figureGroup WIRE (pathWidth 0)))
  (cell RES (cellType GENERIC)
   (view SYM (viewType SCHEMATIC)
    (interface
     (port (rename P1 "A") (designator "1") (direction INOUT))
     (port (rename P2 "B") (designator "2") (direction INOUT))
     (symbol
      (portImplementation P1 (figure PIN (path (pointList (pt -30 0) (pt -10 0)))) (connectLocation (figure DOT (dot (pt -30 0)))))
      (portImplementation P2 (figure PIN (path (pointList (pt 30 0) (pt 10 0)))) (connectLocation (figure DOT (dot (pt 30 0)))))
      (figure BODY (rectangle (pt -10 -5) (pt 10 5)))
      (keywordDisplay designator (display BODY (justify LOWERLEFT) (origin (pt -10 8))))
      (propertyDisplay VALUE (display BODY (justify UPPERLEFT) (origin (pt -10 -8))))
      (boundingBox (rectangle (pt -30 -5) (pt 30 5)))))))
  (cell GND (cellType GENERIC)
   (view SYM (viewType SCHEMATIC)
    (interface (port G (direction INOUT))
     (symbol (portImplementation G (connectLocation (figure DOT (dot (pt 0 0))))) (figure BODY (path (pointList (pt -10 -10) (pt 10 -10))))))))
  (cell TOP (cellType GENERIC)
   (view SCH (viewType SCHEMATIC)
    (interface (port IN (direction INPUT)))
    (contents
     (page (rename PG1 "Page 1") (pageSize (rectangle (pt 0 0) (pt 1100 850)))
      (instance I1 (viewRef SYM (cellRef RES (libraryRef LIB))) (transform (orientation R0) (origin (pt 200 400))) (designator "R1") (property VALUE (string "10k")) (property PCB_FOOTPRINT (string "R0603")))
      (instance I2 (viewRef SYM (cellRef RES (libraryRef LIB))) (transform (orientation R90) (origin (pt 400 470))) (designator "R2") (property VALUE (string "4k7")))
      (instance I3 (viewRef SYM (cellRef RES (libraryRef LIB))) (transform (orientation MX) (origin (pt 600 400))) (designator "R3"))
      (instance I4 (viewRef SYM (cellRef RES (libraryRef LIB))) (transform (origin (pt 700 500))) (designator "R4"))
      (portImplementation IN (figure BODY (path (pointList (pt 100 400) (pt 140 400)))) (connectLocation (figure DOT (dot (pt 140 400)))))
      (net IN (joined (portRef IN) (portRef P1 (instanceRef I1))) (figure WIRE (path (pointList (pt 140 400) (pt 170 400)))))
      (net (rename N1 "MID") (joined (portRef P2 (instanceRef I1)) (portRef P1 (instanceRef I2)) (portRef P1 (instanceRef I3)))
       (figure WIRE (path (pointList (pt 230 400) (pt 400 400) (pt 400 440))) (path (pointList (pt 400 400) (pt 570 400)))))
      (net N00042 (joined (portRef P2 (instanceRef I2)) (portRef P1 (instanceRef I4)))
       (figure WIRE (path (pointList (pt 400 500) (pt 450 500)))))
      (net (name GND (display WIRE (origin (pt 650 405)))) (joined (portRef P2 (instanceRef I3)))
       (figure WIRE (path (pointList (pt 630 400) (pt 680 400))))
       (instance PG (viewRef SYM (cellRef GND (libraryRef LIB))) (transform (origin (pt 680 400)))))
      (commentGraphics (annotate (stringDisplay "Note: a %34%test%34%" (display BODY (justify LOWERLEFT) (origin (pt 100 100))))) (figure BODY (rectangle (pt 90 90) (pt 300 130))))))))
 )
 (design TEST (cellRef TOP (libraryRef LIB))))`;

describe('EDIF import (26.063)', () => {
  it('reads EDIF: keywords in any case, renames, %nn% characters, (e m x) numbers, the distance unit', () => {
    const root = parseEdif('(EDIF x (edifVersion 2 0 0) (Library L (technology (numberDefinition (scale 1 (E 1 -4) (unit DISTANCE))))))');
    expect(root.k).toBe('edif');
    const d = readEdif(SCH);
    expect(d.program).toBe('Test Capture');
    expect(d.libraries.get('lib')!.mmPerUnit).toBeCloseTo(0.254, 9);
    expect(readEdif('(edif x (library L (technology (numberDefinition (scale 1 (e 1 -4) (unit DISTANCE))))))').libraries.get('l')!.mmPerUnit).toBeCloseTo(0.1, 9);
    const res = d.libraries.get('lib')!.cells.get('res')!.views[0]!;
    expect(res.ports.map((p) => [p.name.id, p.name.text, p.designator])).toEqual([['P1', 'A', '1'], ['P2', 'B', '2']]);
    const page = d.libraries.get('lib')!.cells.get('top')!.views[0]!.pages[0]!;
    expect(page.name.text).toBe('Page 1');
    expect(page.comments.texts[0]!.text).toBe('Note: a "test"');
    expect(page.nets.map((n) => n.name.text)).toEqual(['IN', 'MID', 'N00042', 'GND']);
    expect(takesEdif('t.edf', SCH)).toBe(true);
    expect(importerFor('t.edf', enc.encode(SCH))!.id).toBe('edif');
    expect(IMPORTERS.map((i) => i.label)).toContain('EDIF Files');
  });

  it('a schematic: parts placed as turned and mirrored, pins on their nets, a pin no wire reaches labelled, the net names kept, ports and power symbols', async () => {
    const r = await importEdif([{ path: 'x/Test.edf', bytes: enc.encode(SCH) }]);
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    const p = r.projects[0]!;
    expect(p.documents.map((d) => d.name)).toEqual(['Test.SchDoc', 'Test.SchLib']);
    const sheets = sheetsOf(p);
    const sch = sheets[0]!.doc;
    const comp = (des: string) => sch.objects.find((o) => o.kind === 'component' && o.designator === des) as Extract<SchDocument['objects'][number], { kind: 'component' }>;
    expect(['R1', 'R2', 'R3'].map((d) => [comp(d).orient, comp(d).mirrored])).toEqual([[0, false], [1, false], [2, true]]);
    const nets = groups(sheets);
    expect(nets.get('MID')).toBe('R1-2 R2-1 R3-1');
    // N00042's wire stops short of R4: a label of it at R4's pin and on its wire join them
    expect(nets.get('N00042')).toBe('R2-2 R4-1');
    expect(nets.get('GND')).toBe('R3-2');
    expect(nets.get('IN')).toBe('R1-1');
    const o = sch.objects;
    expect(o.some((x) => x.kind === 'port' && x.name === 'IN')).toBe(true); // the page's port
    expect(o.some((x) => x.kind === 'power' && x.text === 'GND')).toBe(true); // the power symbol
    expect(o.some((x) => x.kind === 'text' && x.role === 'netlabel' && x.text === 'GND')).toBe(true); // where EDIF shows the name
    expect(o.some((x) => x.kind === 'text' && x.role === 'label' && x.text === 'Note: a "test"')).toBe(true);
    expect(sch.records.some((x) => x.bag?.get('MODELNAME') === 'R0603')).toBe(true);
    expect(iniGet(readPrjPcb(p.prj.bytes, p.prj.name), 'Design', 'HierarchyMode')).toBe('3');
  });

  it('a hierarchical block: a sheet symbol with its entries, the block\'s page a sheet of its own with its ports (AD\'s Hierarchical scope)', async () => {
    const H = `(edif H (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
 (library LIB (edifLevel 0) (technology (numberDefinition (scale 1 (e 254 -6) (unit DISTANCE))))
  ${SCH.slice(SCH.indexOf('(cell RES'), SCH.indexOf('(cell GND'))}
  (cell BLK (cellType GENERIC)
   (view SCH (viewType SCHEMATIC)
    (interface (port A (direction INPUT)) (port B (direction OUTPUT))
     (symbol (figure BODY (rectangle (pt 0 0) (pt 100 -60)))
      (portImplementation A (connectLocation (figure DOT (dot (pt 0 -20)))))
      (portImplementation B (connectLocation (figure DOT (dot (pt 100 -20)))))))
    (contents (page P1
     (instance R (viewRef SYM (cellRef RES (libraryRef LIB))) (transform (origin (pt 300 300))) (designator "R9"))
     (portImplementation A (figure BODY (path (pointList (pt 200 300) (pt 240 300)))) (connectLocation (figure DOT (dot (pt 240 300)))))
     (portImplementation B (figure BODY (path (pointList (pt 400 300) (pt 360 300)))) (connectLocation (figure DOT (dot (pt 360 300)))))
     (net A (joined (portRef A) (portRef P1 (instanceRef R))) (figure WIRE (path (pointList (pt 240 300) (pt 270 300)))))
     (net B (joined (portRef B) (portRef P2 (instanceRef R))) (figure WIRE (path (pointList (pt 330 300) (pt 360 300)))))))))
  (cell TOP (cellType GENERIC)
   (view SCH (viewType SCHEMATIC) (interface)
    (contents (page P1
     (instance J (viewRef SYM (cellRef RES (libraryRef LIB))) (transform (origin (pt 100 400))) (designator "R1"))
     (instance U (viewRef SCH (cellRef BLK (libraryRef LIB))) (transform (origin (pt 300 420))) (designator "BLOCK1"))
     (net X (joined (portRef P2 (instanceRef J)) (portRef A (instanceRef U))) (figure WIRE (path (pointList (pt 130 400) (pt 300 400))))))))))
 (design H (cellRef TOP (libraryRef LIB))))`;
    const r = await importEdif([{ path: 'H.edf', bytes: enc.encode(H) }]);
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    const p = r.projects[0]!;
    expect(p.documents.map((d) => d.name)).toEqual(['H.SchDoc', 'BLK.SchDoc', 'H.SchLib']);
    expect(iniGet(readPrjPcb(p.prj.bytes, p.prj.name), 'Design', 'HierarchyMode')).toBe('2');
    const sheets = sheetsOf(p);
    const top = sheets[0]!.doc.objects;
    expect(top.filter((o) => o.kind === 'sheetsymbol').length).toBe(1);
    expect(top.filter((o) => o.kind === 'sheetentry').map((o) => (o as { name: string }).name).sort()).toEqual(['A', 'B']);
    expect(sheets[1]!.doc.objects.filter((o) => o.kind === 'port').map((o) => (o as { name: string }).name).sort()).toEqual(['A', 'B']);
    // R1's pin 2 through the entry and the port to R9's pin 1
    const nets = groups(sheets, 2);
    expect([...nets.values()]).toContain('R1-2 R9-1');
  });

  it('Konium\'s own EDIF for PCB comes back as the same nets (a netlist: parts in rows, nets named at their pins)', async () => {
    const files = demoFiles();
    const sheets = files.filter((f) => /\.schdoc$/i.test(f.name)).map((f) => ({ name: f.name, doc: load(f.bytes, f.name) as SchDocument }));
    const c = compileProject(sheets, { scope: 3 });
    const text = edifNetlist(c, 'Demo', new Date(2026, 9, 29));
    const r = await importEdif([{ path: 'Demo.EDF', bytes: enc.encode(text) }]);
    expect(r.messages.filter((m) => m.level !== 'info').map((m) => m.message)).toEqual(['A netlist with no drawings: its parts drawn as boxes in rows, each pin\'s net named at it']);
    const back = groups(sheetsOf(r.projects[0]!));
    const want = new Map([...groups(sheets)].filter(([, g]) => g.split(' ').every((pin) => c.components.some((x) => x.kind !== 2 && pin.startsWith(`${x.designator}-`)))));
    for (const [name, g] of want) expect(back.get(name), name).toBe(g);
  });
});
