import { describe, expect, it } from 'vitest';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { PropertyBag } from '../src/formats/altium/props';
import { SR, setSchCoord } from '../src/model/sch';
import { SCH_UNIT } from '../src/core/units';
import { compileProject, busMembers } from '../src/model/compile';
import { IMPORTERS, importerFor } from '../src/formats/importers';
import { listCadence, takesBrd, takesOrcad } from '../src/formats/cadenceImport';
import { isAllegroBrd, versionOf, V } from '../src/formats/allegro/brdRead';

type B = SchBuilder;
function sheet(name: string, build: (b: B, part: (des: string, x: number, y: number) => void) => void) {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0 });
  // A resistor: pin 1 ends at x-10, pin 2 at x+50
  const part = (des: string, x: number, y: number) => {
    const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: 'Res', PARTCOUNT: 2, CURRENTPARTID: 1, OWNERPARTID: -1, DISPLAYMODECOUNT: 1 }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 2 | 0x18, PINLENGTH: 10, NAME: '1', DESIGNATOR: '1', ELECTRICAL: 4 }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: 1, PINCONGLOMERATE: 0 | 0x18, PINLENGTH: 10, NAME: '2', DESIGNATOR: '2', ELECTRICAL: 4 }, { LOCATION: { x: x + 40, y } });
    b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: des }, { LOCATION: { x, y: y + 10 } });
  };
  build(b, part);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return { name, doc: readSchDoc(writeCfb(root), name) };
}
function bus(b: B, ...pts: [number, number][]) {
  const bag = PropertyBag.from({ RECORD: SR.BUS, OWNERPARTID: -1, LINEWIDTH: 2, COLOR: 0x800000, LOCATIONCOUNT: pts.length });
  pts.forEach(([x, y], i) => { setSchCoord(bag, `X${i + 1}`, x * SCH_UNIT); setSchCoord(bag, `Y${i + 1}`, y * SCH_UNIT); });
  b.bags.push(bag);
  b.bags[0]!.setRaw('WEIGHT', String(b.bags.length - 1));
}
const label = (b: B, text: string, x: number, y: number) => b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: text, FONTID: 1 }, { LOCATION: { x, y } });
const pinsOf = (r: ReturnType<typeof compileProject>, des: string, pin: string) => r.nets.find((n) => n.pins.some((p) => p.designator === des && p.pin === pin))?.pins.map((p) => `${p.designator}-${p.pin}`).sort();

describe('bus connections across the hierarchy (26.053)', () => {
  // Parent: a sheet symbol whose entry D[0..1] (at 300, 490) meets a bus labelled X[0..1]; R1 and R2 on X0 and X1
  const parent = sheet('Top.SchDoc', (b, part) => {
    const s = b.add({ RECORD: SR.SHEET_SYMBOL, OWNERPARTID: -1, XSIZE: 200, YSIZE: 100, COLOR: 128, AREACOLOR: 8454016, ISSOLID: true }, { LOCATION: { x: 300, y: 500 } });
    b.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: 'U_Child' }, { LOCATION: { x: 300, y: 502 } });
    b.add({ RECORD: SR.FILE_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: 'Child.SchDoc' }, { LOCATION: { x: 300, y: 390 } });
    b.add({ RECORD: SR.SHEET_ENTRY, OWNERINDEX: s, OWNERPARTID: -1, DISTANCEFROMTOP: 1, NAME: 'D[0..1]', IOTYPE: 2 });
    bus(b, [300, 490], [200, 490]);
    label(b, 'X[0..1]', 230, 490);
    part('R1', 100, 300); b.wire([150, 300], [180, 300]); label(b, 'X0', 160, 300);
    part('R2', 100, 200); b.wire([150, 200], [180, 200]); label(b, 'X1', 160, 200);
  });
  // Child: the bus port D[0..1]; R3 on D0, R4 on D1
  const child = sheet('Child.SchDoc', (b, part) => {
    b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'D[0..1]', STYLE: 3, IOTYPE: 2, WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 600, y: 600 } });
    bus(b, [650, 600], [700, 600]); // the port's bus (no label: the port names its members)
    part('R3', 400, 300); b.wire([390, 300], [360, 300]); label(b, 'D0', 365, 300);
    part('R4', 400, 200); b.wire([390, 200], [360, 200]); label(b, 'D1', 365, 200);
  });

  it('a bus entry meets the bus drawn to it member by member, in order (not by name)', () => {
    const r = compileProject([parent, child], { scope: 2 });
    expect(pinsOf(r, 'R1', '2')).toEqual(['R1-2', 'R3-1']);
    expect(pinsOf(r, 'R2', '2')).toEqual(['R2-2', 'R4-1']);
  });

  it('a bus off-sheet connector joins the bus members of the sheets it links', () => {
    const half = (name: string, a: string, c: string) => sheet(name, (b, part) => {
      bus(b, [300, 400], [300, 100]);
      b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, ISCROSSSHEETCONNECTOR: true, TEXT: 'Y[0..1]', ORIENTATION: 1, SHOWNETNAME: true }, { LOCATION: { x: 300, y: 400 } });
      part(a, 100, 300); b.wire([150, 300], [200, 300]); label(b, 'Y0', 160, 300);
      part(c, 100, 200); b.wire([150, 200], [200, 200]); label(b, 'Y1', 160, 200);
    });
    const r = compileProject([half('A.SchDoc', 'R1', 'R2'), half('B.SchDoc', 'R3', 'R4')], { scope: 2 });
    expect(pinsOf(r, 'R1', '2')).toEqual(['R1-2', 'R3-2']);
    expect(pinsOf(r, 'R2', '2')).toEqual(['R2-2', 'R4-2']);
  });

  it('a bus port on no bus joins no labels; a bus entry on a bus is not unconnected', () => {
    const lone = sheet('Child.SchDoc', (b, part) => {
      b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'D[0..1]', STYLE: 3, IOTYPE: 2, WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 600, y: 600 } });
      part('R3', 400, 300); b.wire([390, 300], [360, 300]); label(b, 'D0', 365, 300);
      part('R4', 400, 200); b.wire([390, 200], [360, 200]); label(b, 'D1', 365, 200);
    });
    const r = compileProject([parent, lone], { scope: 2 });
    expect(pinsOf(r, 'R1', '2')).toEqual(['R1-2']);
    expect(r.messages.some((m) => /Unconnected .*Sheet Entry D\[0\.\.1\]/.test(m.message))).toBe(false);
  });

  it('a port and a net label of one name on one sheet stay apart (as in AD)', () => {
    const top = sheet('Solo.SchDoc', (b, part) => {
      b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'SIG', STYLE: 3, IOTYPE: 2, WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 50, y: 300 } });
      part('R1', 110, 300); b.wire([100, 300], [100, 300]);
      part('R2', 100, 100); b.wire([150, 100], [200, 100]); label(b, 'SIG', 160, 100);
    });
    const r = compileProject([top], { scope: 2 });
    expect(pinsOf(r, 'R2', '2')).toEqual(['R2-2']);
    expect(busMembers('A[3..1]')).toEqual(['A3', 'A2', 'A1']);
  });
});

describe('OrCAD and Allegro import (26.053)', () => {
  const allegroHead = (magic: number) => { const b = new Uint8Array(0x1300); new DataView(b.buffer).setUint32(0, magic, true); return b; };
  it('takes Capture designs and libraries and Allegro boards by name and first bytes', () => {
    expect(takesOrcad('a.DSN', '��\u0011')).toBe(true);
    expect(takesOrcad('route.dsn', '(pcb route.dsn')).toBe(false); // Specctra
    expect(takesOrcad('lib.olb', '�')).toBe(true);
    const brd = allegroHead(0x00140902);
    expect(takesBrd('b.brd', new TextDecoder().decode(brd.subarray(0, 4096)))).toBe(true);
    expect(takesBrd('b.brd', '<?xml version="1.0"?><eagle')).toBe(false); // EAGLE
    expect(isAllegroBrd(brd)).toBe(true);
    expect(versionOf(0x00140902)).toBe(V.V174);
    expect(versionOf(0x00160100)).toBe(V.V190);
    expect(importerFor('b.brd', brd)?.id).toBe('orcad');
    expect(IMPORTERS.map((i) => i.label)).toEqual(expect.arrayContaining(['OrCAD Designs and Libraries Files', 'Allegro Design Files']));
  });
  it('a design and a board of one name are one project; the only design takes the only board', () => {
    // Listed with no notes (a note sends a drop to the wizard)
    expect(listCadence([{ path: 'x/Board.DSN' }, { path: 'x/board.brd' }, { path: 'x/parts.olb' }])).toEqual([
      { path: 'x/Board.DSN', kind: 'Schematic' }, { path: 'x/board.brd', kind: 'PCB' }, { path: 'x/parts.olb', kind: 'Schematic library' }]);
    expect(listCadence([{ path: 'sch/Design.DSN' }, { path: 'pcb/Layout_rev3.brd' }]).map((i) => i.path)).toEqual(['sch/Design.DSN', 'pcb/Layout_rev3.brd']);
    expect(listCadence([{ path: 'A.DSN' }, { path: 'B.DSN' }, { path: 'C.brd' }]).map((i) => i.kind)).toEqual(['Schematic', 'Schematic', 'PCB']);
  });
});
