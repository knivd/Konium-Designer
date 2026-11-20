import { describe, expect, it } from 'vitest';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { SR } from '../src/model/sch';
import { compileProject } from '../src/model/compile';
import { defaultErc, ercKind, readErc, writeErc } from '../src/model/erc';
import { addDocument, iniGet, newPrjPcb, projectParameters, readPrjPcb, removeDocument, setProjectParameters, writePrjPcb } from '../src/formats/altium/prjpcb';

type Part = (des: string, x: number, y: number, opts?: { electrical?: [number, number] }) => void;
function sheet(build: (b: SchBuilder, part: Part) => void) {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0 });
  const part: Part = (des, x, y, opts = {}) => {
    const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: 'Res', PARTCOUNT: 2, CURRENTPARTID: 1, OWNERPARTID: -1, DISPLAYMODECOUNT: 1 }, { LOCATION: { x, y } });
    const [e1, e2] = opts.electrical ?? [4, 4];
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 2 | 0x18, PINLENGTH: 10, NAME: '1', DESIGNATOR: '1', ELECTRICAL: e1 }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 0 | 0x18, PINLENGTH: 10, NAME: '2', DESIGNATOR: '2', ELECTRICAL: e2 }, { LOCATION: { x: x + 40, y } });
    b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: des }, { LOCATION: { x, y: y + 10 } });
  };
  build(b, part);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return readSchDoc(writeCfb(root), 'Test.SchDoc');
}
const run = (doc: ReturnType<typeof sheet>, erc = defaultErc()) => compileProject([{ name: 'Test.SchDoc', doc }], { erc });

describe('ERC', () => {
  it('Connection Matrix: two outputs on a net is an error, output to input is fine', () => {
    const doc = sheet((b, part) => {
      part('U1', 100, 100, { electrical: [2, 2] }); part('U2', 300, 100, { electrical: [2, 0] });
      b.wire([150, 100], [290, 100]);
    });
    const m = run(doc).messages.find((x) => x.kind === 'Matrix');
    expect(m?.message).toBe('Net NetU1_2 contains multiple Output Pins (Pin U1-2,Pin U2-1)');
    expect(m?.level).toBe('error');
    const ok = sheet((b, part) => { part('U1', 100, 100, { electrical: [4, 2] }); part('U2', 300, 100, { electrical: [0, 4] }); b.wire([150, 100], [290, 100]); });
    expect(run(ok).messages.filter((x) => x.kind === 'Matrix' && /contains/.test(x.message))).toEqual([]);
  });

  it('Connection Matrix: a port meets what is on its own sheet only', () => {
    const port = (b: SchBuilder, x: number, io: number) => b.add({ RECORD: SR.PORT, NAME: 'X', IOTYPE: io, STYLE: 3, WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x, y: 100 } });
    // An output pin out through an Output port, in through an Input port to an input pin: fine
    const a = sheet((b, part) => { part('U1', 100, 100, { electrical: [4, 2] }); b.wire([150, 100], [200, 100]); port(b, 200, 1); });
    const bb = sheet((b, part) => { port(b, 100, 2); b.wire([150, 100], [290, 100]); part('U2', 300, 100, { electrical: [0, 4] }); });
    const c = compileProject([{ name: 'A.SchDoc', doc: a }, { name: 'B.SchDoc', doc: bb }], { scope: 1 });
    expect(c.nets.find((n) => n.pins.length === 2)?.pins.map((p) => p.designator).sort()).toEqual(['U1', 'U2']);
    expect(c.messages.filter((m) => m.kind === 'Matrix' && /contains/.test(m.message))).toEqual([]);
    // An output pin driving an Input port on its own sheet: an error
    const own = sheet((b, part) => { part('U1', 100, 100, { electrical: [4, 2] }); b.wire([150, 100], [200, 100]); port(b, 200, 2); });
    expect(run(own).messages.find((m) => m.kind === 'Matrix' && /contains/.test(m.message))?.message).toBe('Net NetU1_2 contains Output Pin and Input Port objects (Pin U1-2,Port X)');
  });

  it('Error Reporting levels: No Report drops, Fatal Error marks', () => {
    const doc = sheet((b, part) => { part('R1', 100, 100); b.wire([150, 100], [250, 100]); b.wire([300, 300], [400, 300]); });
    // A wire with a pin on it is not unconnected; one joining nothing is
    expect(run(doc).messages.filter((m) => m.kind === 'UnconnectedWire').map((m) => m.message)).toEqual(['Unconnected line (300,300) To (400,300)']);
    const erc = defaultErc();
    erc.levels.set(ercKind('UnconnectedWire').n, 0);
    expect(run(doc, erc).messages.some((m) => m.kind === 'UnconnectedWire')).toBe(false);
    erc.levels.set(ercKind('UnconnectedWire').n, 3);
    const fatal = run(doc, erc).messages[0]!;
    expect([fatal.kind, fatal.fatal, fatal.level]).toEqual(['UnconnectedWire', true, 'error']);
  });

  it('No ERC: all, or only the violations it names', () => {
    const dangling = (extra: Record<string, string | number | boolean>) => sheet((b, part) => {
      part('R1', 100, 100); b.wire([300, 300], [400, 300]);
      b.add({ RECORD: SR.NO_ERC, OWNERPARTID: -1, ISACTIVE: true, SYMBOL: 'Thin Cross', ...extra }, { LOCATION: { x: 400, y: 300 } });
    });
    expect(run(dangling({ SUPPRESSALL: true })).messages.some((m) => m.kind === 'UnconnectedWire')).toBe(false);
    expect(run(dangling({ SUPPRESSALL: 'F', ERRORKINDSETTOSUPPRESS: '"Unconnected wires"' })).messages.some((m) => m.kind === 'UnconnectedWire')).toBe(false);
    expect(run(dangling({ SUPPRESSALL: 'F', ERRORKINDSETTOSUPPRESS: '"Off grid object"' })).messages.some((m) => m.kind === 'UnconnectedWire')).toBe(true);
  });

  it('a compile mask leaves out what it covers', () => {
    const doc = sheet((b, part) => {
      part('R1', 100, 100); part('R1', 300, 100);
      b.add({ RECORD: SR.COMPILE_MASK, OWNERPARTID: -1, COLOR: 128, AREACOLOR: 16448250 }, { LOCATION: { x: 280, y: 80 }, CORNER: { x: 400, y: 150 } });
    });
    expect(run(doc).messages.some((m) => m.kind === 'DuplicateComponentDesignator')).toBe(false);
    expect(run(doc).components.map((c) => c.designator)).toEqual(['R1']);
  });

  it('off grid, duplicate ports and unused sub-parts', () => {
    const doc = sheet((b) => {
      b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'A', WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 100, y: 100 } });
      b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'A', WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 100, y: 200 } });
      b.add({ RECORD: SR.JUNCTION, OWNERPARTID: -1 }, { LOCATION: { x: 300.5, y: 300 } });
    });
    const kinds = run(doc).messages.map((m) => m.kind);
    expect(kinds).toContain('DuplicatePortsInDocument');
    expect(kinds).toContain('OffGridObject');
  });

  it('PrjPcb: Error Reporting and the matrix round-trip; documents and parameters edit in place', () => {
    const p = newPrjPcb('Board.PrjPcb');
    const s = defaultErc();
    s.levels.set(ercKind('OffGridObject').n, 2);
    s.matrix[2]![2] = 3;
    writeErc(p, s);
    expect(iniGet(p, 'Electrical Rules Check', 'Type1')).toBe('2');
    const back = readErc(readPrjPcb(writePrjPcb(p), 'Board.PrjPcb'));
    expect(back.levels.get(1)).toBe(2);
    expect(back.matrix[2]![2]).toBe(3);
    expect(addDocument(p, 'Sheets/Power.SchDoc')).toBe(true);
    expect(addDocument(p, 'Main.SchDoc')).toBe(true);
    expect(p.documents).toEqual(['Sheets/Power.SchDoc', 'Main.SchDoc']);
    expect(iniGet(p, 'Document1', 'DocumentPath')).toBe('Sheets\\Power.SchDoc');
    removeDocument(p, 'Sheets/Power.SchDoc');
    expect(p.documents).toEqual(['Main.SchDoc']);
    expect(iniGet(p, 'Document1', 'DocumentPath')).toBe('Main.SchDoc');
    setProjectParameters(p, [{ name: 'Revision', value: 'B' }, { name: 'Author', value: 'K' }]);
    expect(projectParameters(p)).toEqual([{ name: 'Revision', value: 'B' }, { name: 'Author', value: 'K' }]);
    expect(p.parameters.get('REVISION')).toBe('B');
  });
});
