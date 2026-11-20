/**
 * Symbols.SchDoc: one of every schematic symbol Konium draws, laid out on an A4 sheet.
 * Open it in Altium and in Konium side by side to compare shapes, sizes and text
 * placement. Coordinates below are in DXP units (10 mil). Colours are Altium's defaults.
 */
import { cfbPut, newEntry, writeCfb } from '../cfb/cfb';
import { binToBytes } from '../text';
import { SR } from '../../model/sch';
import { toBgr } from '../../model/common';
import { uniqueId } from '../../model/schEdit';
import { SchBuilder } from './schBuilder';

const K = {
  wire: toBgr(0x000080), line: toBgr(0x800000), fill: toBgr(0xffffb0), pin: toBgr(0x000000), text: toBgr(0x000080),
  port: toBgr(0x800000), portFill: toBgr(0xffff80), sheetFill: toBgr(0x80ff80), noerc: toBgr(0xff0000),
};
const POWER_NAMES = ['Circle', 'Arrow', 'Bar', 'Wave', 'Power GND', 'Signal GND', 'Earth', 'GOST Arrow', 'GOST PGND', 'GOST Earth', 'GOST Bar'];

interface PinSpec { y?: number; x?: number; name: string; el?: number; inner?: number; innerEdge?: number; outerEdge?: number; outer?: number }

export function symbolsSchDoc(): Uint8Array {
  const b = new SchBuilder();
  b.wireColour = K.wire;
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 3, SIZE1: 10, FONTNAME1: 'Times New Roman', SIZE2: 10, FONTNAME2: 'Arial', BOLD2: true,
    SIZE3: 8, FONTNAME3: 'Arial', SYSTEMFONT: 1, SHEETSTYLE: 0, BORDERON: true, TITLEBLOCKON: false, AREACOLOR: toBgr(0xffffff),
    SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10 });

  const heading = (x: number, y: number, text: string) =>
    b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: text, FONTID: 2, COLOR: K.text }, { LOCATION: { x, y } });
  // JUSTIFICATION: 0 BL 1 BC 2 BR 3 CL 4 CC 5 CR 6 TL 7 TC 8 TR
  const caption = (x: number, y: number, text: string, justification = 0) =>
    b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: text, FONTID: 3, JUSTIFICATION: justification, COLOR: toBgr(0x606060) }, { LOCATION: { x, y } });
  const power = (x: number, y: number, style: number, orientation: number, text: string, extra: Record<string, string | number | boolean> = {}) =>
    b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: style, ORIENTATION: orientation, TEXT: text, SHOWNETNAME: true, COLOR: K.wire,
      UNIQUEID: uniqueId(), ...extra }, { LOCATION: { x, y } });

  /* Power ports pointing up and down, every STYLE */
  heading(40, 715, 'Power ports: STYLE 0–10, ORIENTATION 1 (up) and 3 (down)');
  for (let i = 0; i <= 10; i++) {
    const x = 60 + i * 95;
    power(x, 640, i, 1, POWER_NAMES[i]!);
    b.wire([x, 620], [x, 640]);
    caption(x, 617, `STYLE ${i}`, 7);
    power(x, 555, i, 3, 'GND');
    b.wire([x, 555], [x, 575]);
    caption(x, 578, `STYLE ${i}`, 1);
  }

  /* Left/right orientations and off-sheet connectors */
  heading(40, 485, 'ORIENTATION 0 (right) and 2 (left); off-sheet connectors');
  const lr: [number, number, string, boolean][] = [[2, 0, 'VCC', false], [2, 2, 'VCC', false], [4, 0, 'GND', false], [4, 2, 'GND', false],
    [1, 0, 'VREF', false], [0, 2, 'VBAT', false], [0, 0, 'NET', true], [0, 2, 'NET', true]];
  lr.forEach(([style, o, text, cross], k) => {
    const x = 90 + k * 130, y = 455;
    if (o === 0) { b.wire([x - 30, y], [x, y]); power(x, y, style, 0, text, cross ? { ISCROSSSHEETCONNECTOR: true } : {}); }
    else { b.wire([x, y], [x + 30, y]); power(x, y, style, 2, text, cross ? { ISCROSSSHEETCONNECTOR: true } : {}); }
  });

  /* Components with pin decorations */
  const comp = (ref: string, comment: string, body: [number, number, number, number], left: PinSpec[], right: PinSpec[], top: PinSpec[] = [], bottom: PinSpec[] = []) => {
    const [x0, y0, x1, y1] = body;
    // Graphical (COMPONENTKIND 2): drawn and compiled for display only, never sent to the PCB
    const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: comment, PARTCOUNT: 2, DISPLAYMODECOUNT: 1, CURRENTPARTID: 1, OWNERPARTID: -1,
      AREACOLOR: K.fill, COLOR: K.line, DESIGNITEMID: comment, UNIQUEID: uniqueId(), COMPONENTKIND: 2 }, { LOCATION: { x: x0, y: y0 } });
    const own = { OWNERINDEX: ci, OWNERPARTID: 1 };
    b.add({ RECORD: SR.RECTANGLE, ...own, LINEWIDTH: 1, COLOR: K.line, AREACOLOR: K.fill, ISSOLID: true }, { LOCATION: { x: x0, y: y0 }, CORNER: { x: x1, y: y1 } });
    let n = 1;
    const pin = (p: PinSpec, orient: number, at: { x: number; y: number }) => b.add({
      RECORD: SR.PIN, ...own, ELECTRICAL: p.el ?? 4, PINCONGLOMERATE: orient | 0x08 | 0x10, PINLENGTH: 30, NAME: p.name, DESIGNATOR: String(n++),
      SYMBOL_INNER: p.inner ?? 0, SYMBOL_INNEREDGE: p.innerEdge ?? 0, SYMBOL_OUTEREDGE: p.outerEdge ?? 0, SYMBOL_OUTER: p.outer ?? 0, COLOR: K.pin,
    }, { LOCATION: at });
    for (const p of left) pin(p, 2, { x: x0, y: p.y! });
    for (const p of right) pin(p, 0, { x: x1, y: p.y! });
    for (const p of top) pin(p, 1, { x: p.x!, y: y1 });
    for (const p of bottom) pin(p, 3, { x: p.x!, y: y0 });
    b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: ref, FONTID: 1, COLOR: K.text }, { LOCATION: { x: x0, y: y1 + 5 } });
    b.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Comment', TEXT: comment, FONTID: 1, COLOR: K.text }, { LOCATION: { x: x0 + 40, y: y1 + 5 } });
  };
  const ys = (i: number) => 390 - i * 20;
  comp('U101', 'Pin types', [120, 240, 300, 400],
    ['IN', 'IO', 'OUT', 'OC', 'PAS', 'HIZ', 'OE', 'PWR'].map((name, i) => ({ y: ys(i), name, el: i })),
    [
      { y: ys(0), name: 'DOT', outerEdge: 1 }, { y: ys(1), name: 'CLK', innerEdge: 3 }, { y: ys(2), name: 'LOWIN', outerEdge: 4 },
      { y: ys(3), name: 'LOWOUT', outerEdge: 17 }, { y: ys(4), name: 'N\\C\\L\\K\\', outerEdge: 1, innerEdge: 3 }, { y: ys(5), name: 'SCHMITT', inner: 13 },
      { y: ys(6), name: 'OC', inner: 9 }, { y: ys(7), name: 'HIZ', inner: 10 },
    ]);
  caption(120, 225, 'Left: ELECTRICAL 0–7 (Pin Direction). Right: edge symbols.');
  comp('U102', 'Pin symbols', [520, 240, 700, 400],
    [[8, 'POST'], [11, 'HC'], [12, 'PULSE'], [22, 'OCPU'], [23, 'OE'], [24, 'OEPU'], [30, 'SHL'], [32, 'OPEN']].map(([s, name], i) => ({ y: ys(i), name: name as string, inner: s as number })),
    [
      { y: ys(0), name: 'RL', outer: 2 }, { y: ys(1), name: 'LR', outer: 33 }, { y: ys(2), name: 'BIDI', outer: 34 }, { y: ys(3), name: 'NOLOG', outer: 6 },
      { y: ys(4), name: 'ANA', outer: 5 }, { y: ys(5), name: 'DIG', outer: 25 }, { y: ys(6), name: 'IN', el: 0, outerEdge: 1 }, { y: ys(7), name: 'OUT', el: 2, outerEdge: 17 },
    ],
    [{ x: 560, name: 'T1', el: 0 }, { x: 610, name: 'T2', el: 2 }, { x: 660, name: 'T3', el: 1 }],
    [{ x: 560, name: 'B1', outerEdge: 1 }, { x: 610, name: 'B2', innerEdge: 3 }, { x: 660, name: 'B3' }]);
  caption(760, 300, 'U102 left: inside symbols');
  caption(760, 285, 'U102 right: outside symbols');
  caption(760, 270, 'U102 top/bottom: vertical pins');

  /* Ports */
  heading(40, 185, 'Ports: STYLE / IOTYPE / ALIGNMENT');
  for (let s = 0; s < 4; s++) {
    b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: `S${s} IO${s}`, STYLE: s, IOTYPE: s, WIDTH: 60, HEIGHT: 10, ALIGNMENT: 0,
      COLOR: K.port, AREACOLOR: K.portFill, TEXTCOLOR: K.port, UNIQUEID: uniqueId() }, { LOCATION: { x: 50 + s * 80, y: 150 } });
  }
  ['Centre', 'Right', 'Left'].forEach((name, a) => {
    b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: name, STYLE: 3, IOTYPE: 3, WIDTH: 70, HEIGHT: 10, ALIGNMENT: a,
      COLOR: K.port, AREACOLOR: K.portFill, TEXTCOLOR: K.port, UNIQUEID: uniqueId() }, { LOCATION: { x: 50 + a * 90, y: 110 } });
  });
  for (let s = 4; s < 8; s++) {
    b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: `S${s}`, STYLE: s, IOTYPE: 0, WIDTH: 50, HEIGHT: 10, ALIGNMENT: 0,
      COLOR: K.port, AREACOLOR: K.portFill, TEXTCOLOR: K.port, UNIQUEID: uniqueId() }, { LOCATION: { x: 340 + (s - 4) * 30, y: 40 } });
  }
  caption(50, 88, 'Row 1: STYLE = IOTYPE = 0–3 · Row 2: ALIGNMENT 0–2');
  caption(385, 93, 'STYLE 4–7', 1);

  /* Sheet symbol with entries */
  const sym = b.add({ RECORD: SR.SHEET_SYMBOL, OWNERPARTID: -1, XSIZE: 180, YSIZE: 130, LINEWIDTH: 1, COLOR: K.line, AREACOLOR: K.sheetFill,
    ISSOLID: true, UNIQUEID: uniqueId() }, { LOCATION: { x: 480, y: 190 } });
  b.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: sym, OWNERPARTID: -1, TEXT: 'Child', FONTID: 1, COLOR: K.text }, { LOCATION: { x: 480, y: 192 } });
  b.add({ RECORD: SR.FILE_NAME, OWNERINDEX: sym, OWNERPARTID: -1, TEXT: 'Child.SchDoc', FONTID: 1, COLOR: K.text }, { LOCATION: { x: 480, y: 50 } });
  ['None', 'Out', 'In', 'Bidi'].forEach((name, io) => {
    for (const side of [0, 1]) {
      b.add({ RECORD: SR.SHEET_ENTRY, OWNERINDEX: sym, OWNERPARTID: -1, SIDE: side, DISTANCEFROMTOP: 2 + io * 3, NAME: `${name}${side ? 'R' : 'L'}`,
        IOTYPE: io, COLOR: K.port, AREACOLOR: K.portFill, TEXTCOLOR: K.port, TEXTFONTID: 1 });
    }
  });

  /* Junctions and No ERC */
  heading(720, 185, 'Junctions and No ERC');
  b.wire([720, 150], [900, 150]);
  b.wire([810, 150], [810, 100]);
  b.wire([740, 125], [880, 125]);
  caption(905, 147, 'T: automatic junction; crossing: none');
  b.wire([720, 70], [1000, 70]);
  for (let s = 0; s < 4; s++) {
    b.add({ RECORD: SR.JUNCTION, OWNERPARTID: -1, COLOR: K.wire, SIZE: s }, { LOCATION: { x: 750 + s * 70, y: 70 } });
    caption(750 + s * 70, 60, `SIZE ${s}`, 7);
  }
  b.add({ RECORD: SR.NO_ERC, OWNERPARTID: -1, COLOR: K.noerc, ISACTIVE: true, SUPPRESSALL: true }, { LOCATION: { x: 1060, y: 150 } });
  caption(1060, 135, 'No ERC', 7);

  /* Text frame: word wrap + clip, 50 mil margin */
  b.add({ RECORD: SR.TEXT_FRAME, OWNERPARTID: -1, TEXT: 'Text frame with Word Wrap and Clip to Area. Long lines wrap inside the 50 mil margin;~1second paragraph after a line break, and anything that runs past the bottom edge is clipped away.',
    FONTID: 1, COLOR: K.line, TEXTCOLOR: toBgr(0x000000), AREACOLOR: toBgr(0xffffff), ISSOLID: true, SHOWBORDER: true, WORDWRAP: true, CLIPTORECT: true, TEXTMARGIN: 5, ALIGNMENT: 1 },
    { LOCATION: { x: 975, y: 330 }, CORNER: { x: 1120, y: 420 } });

  b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: 'Symbols.SchDoc — written by Konium Designer for side-by-side comparison',
    FONTID: 3, COLOR: toBgr(0x6a6f76) }, { LOCATION: { x: 40, y: 25 } });

  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  return writeCfb(root);
}

/**
 * Child.SchDoc: the sheet the Symbols.SchDoc sheet symbol stands for — a port for each of its
 * entries (same names and I/O types), so Up/Down Hierarchy and the compiler have both ends.
 */
export function childSchDoc(): Uint8Array {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Times New Roman', SYSTEMFONT: 1, SHEETSTYLE: 0, BORDERON: true, TITLEBLOCKON: false,
    AREACOLOR: toBgr(0xffffff), SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 4 });
  ['None', 'Out', 'In', 'Bidi'].forEach((name, io) => {
    ['L', 'R'].forEach((side, k) => {
      b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: `${name}${side}`, STYLE: 3, IOTYPE: io, WIDTH: 60, HEIGHT: 10, ALIGNMENT: 0,
        COLOR: K.port, AREACOLOR: K.portFill, TEXTCOLOR: K.port, FONTID: 1, UNIQUEID: uniqueId() }, { LOCATION: { x: 100 + k * 300, y: 650 - io * 40 } });
    });
  });
  b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: 'Child.SchDoc — the child sheet of the Symbols.SchDoc sheet symbol: a port for each sheet entry (Tools › Up/Down Hierarchy)',
    FONTID: 1, COLOR: toBgr(0x6a6f76) }, { LOCATION: { x: 100, y: 420 } });
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return writeCfb(root);
}
