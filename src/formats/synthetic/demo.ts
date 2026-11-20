/**
 * Demo project written entirely by Konium's own encoders: a 3V3 regulator schematic
 * and a matching two-layer board. It exercises the read path end to end, but it is not
 * evidence of Altium compatibility — only real files are.
 */
import { altiumFloat } from '../altium/pcbTransform';
import { newPolygonProps } from '../altium/polygonProps';
import { defaultStack, newBoardRecord } from '../altium/board6';
import { addDimension, newDimension } from '../../model/dimensions';
import { newOutJob, newOutput, setOutJobOutputs, setOutputConfig, writeOutJob } from '../altium/outjob';
import { drillToConfig, gerberToConfig, pnpToConfig, printJobToConfig } from '../altium/outjobConfig';
import { defaultGerberSetup } from '../gerber/gerber';
import { defaultDrillSetup } from '../gerber/drill';
import { defaultPnpSetup } from '../gerber/pnp';
import { defaultJob } from '../../model/printouts';
import { BinWriter } from '../bin';
import { cfbPut, newEntry, writeCfb } from '../cfb/cfb';
import { countHeader, joinBinaryRecords, joinTextRecords, type PcbRawRecord } from '../altium/framing';
import { PropertyBag } from '../altium/props';
import { encodeArc, encodeFill, encodePad, encodeRegion, encodeBody, encodeText, encodeTrack, encodeVia, readPcbDoc, writePcbDoc, writeVertices } from '../altium/pcbdoc';
import { addPolygon, repour } from '../../model/pcbEdit';
import { writePcbLib, type FootprintDef } from '../altium/pcblib';
import { binToBytes } from '../text';
import { SR } from '../../model/sch';
import { toBgr } from '../../model/common';
import { L } from '../../model/layers';
import { formatAltiumLength, mil, mm } from '../../core/units';
import type { Vec2 } from '../../core/geom';
import { uniqueId } from '../../model/schEdit';
import { C, SchBuilder } from './schBuilder';
import { defaultRules, joinRuleRecords, newRule } from '../altium/rules';
import { childSchDoc, symbolsSchDoc } from './gallery';
import { demoSchLib } from './demoLib';
import { newDbLib, setDbFile, writeDbLib } from '../altium/dblib';
import { newTable } from '../altium/dbFile';
import { xlsx } from '../xlsx';

/* ═══ Schematic ═══════════════════════════════════════════════════════════════════════ */

function component(b: SchBuilder, o: {
  ref: string; lib: string; comment: string; at: [number, number]; body?: [number, number, number, number];
  lines?: [number, number, number, number][]; footprint?: string; description?: string;
  pins: { n: string; name: string; at: [number, number]; orient: number; len: number; el?: number; showName?: boolean }[];
  refAt: [number, number]; commentAt: [number, number];
}): void {
  const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: o.lib, PARTCOUNT: 2, DISPLAYMODECOUNT: 1, CURRENTPARTID: 1,
    OWNERPARTID: -1, AREACOLOR: C.fill, COLOR: C.body, DESIGNITEMID: o.lib, UNIQUEID: uniqueId() }, { LOCATION: { x: o.at[0], y: o.at[1] } });
  const own = { OWNERINDEX: ci, OWNERPARTID: 1 };
  if (o.body) {
    const [x0, y0, x1, y1] = o.body;
    b.add({ RECORD: SR.RECTANGLE, ...own, LINEWIDTH: 1, COLOR: C.body, AREACOLOR: C.fill, ISSOLID: true },
      { LOCATION: { x: x0, y: y0 }, CORNER: { x: x1, y: y1 } });
  }
  for (const [x0, y0, x1, y1] of o.lines ?? []) {
    b.add({ RECORD: SR.LINE, ...own, LINEWIDTH: 2, COLOR: C.body }, { LOCATION: { x: x0, y: y0 }, CORNER: { x: x1, y: y1 } });
  }
  for (const p of o.pins) {
    b.add({ RECORD: SR.PIN, ...own, ELECTRICAL: p.el ?? 4, PINCONGLOMERATE: p.orient | ((p.showName ?? true) ? 0x08 : 0) | 0x10,
      PINLENGTH: p.len, NAME: p.name, DESIGNATOR: p.n, COLOR: C.pin }, { LOCATION: { x: p.at[0], y: p.at[1] } });
  }
  b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: o.ref, FONTID: 1, COLOR: C.text },
    { LOCATION: { x: o.refAt[0], y: o.refAt[1] } });
  b.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Comment', TEXT: o.comment, FONTID: 1, COLOR: C.text },
    { LOCATION: { x: o.commentAt[0], y: o.commentAt[1] } });
  if (o.footprint) {
    // Footprint model link, as Altium writes it: implementation list → implementation → map/param lists
    const list = b.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci, OWNERPARTID: -1 });
    const impl = b.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: o.description ?? '',
      MODELNAME: o.footprint, MODELTYPE: 'PCBLIB', DATAFILECOUNT: 1, MODELDATAFILEENTITY0: o.footprint, MODELDATAFILEKIND0: 'PCBLib', ISCURRENT: true, UNIQUEID: uniqueId() });
    b.add({ RECORD: 46, OWNERINDEX: impl, OWNERPARTID: -1 });
    b.add({ RECORD: 48, OWNERINDEX: impl, OWNERPARTID: -1 });
  }
}

export function demoSchDoc(): Uint8Array {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 2, SIZE1: 10, FONTNAME1: 'Arial', SIZE2: 16, FONTNAME2: 'Arial', BOLD2: true,
    SHEETSTYLE: 0, BORDERON: true, TITLEBLOCKON: true, AREACOLOR: toBgr(0xffffff), SNAPGRIDON: true, SNAPGRIDSIZE: 10,
    VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10 });

  component(b, { ref: 'J1', lib: 'Header 2', comment: 'Power in', at: [100, 380], body: [100, 380, 140, 440], footprint: 'HDR1X2', description: 'Header, 2-Pin',
    pins: [{ n: '1', name: 'VIN', at: [140, 430], orient: 0, len: 20, el: 7 }, { n: '2', name: 'GND', at: [140, 390], orient: 0, len: 20, el: 7 }],
    refAt: [100, 450], commentAt: [100, 365] });
  component(b, { ref: 'C1', lib: 'Cap', comment: '10µF', at: [250, 400], lines: [[235, 405, 265, 405], [235, 395, 265, 395]], footprint: '0805', description: 'Chip capacitor, 0805',
    pins: [{ n: '1', name: '1', at: [250, 405], orient: 1, len: 25, showName: false }, { n: '2', name: '2', at: [250, 395], orient: 3, len: 25, showName: false }],
    refAt: [272, 405], commentAt: [272, 390] });
  component(b, { ref: 'U1', lib: 'LDO SOT-223', comment: 'LDO 3V3', at: [420, 380], body: [420, 380, 520, 450], footprint: 'SOT-223', description: 'SOT-223, 4 leads',
    pins: [
      { n: '3', name: 'VIN', at: [420, 430], orient: 2, len: 20, el: 0 },
      { n: '2', name: 'VOUT', at: [520, 430], orient: 0, len: 20, el: 2 },
      { n: '1', name: 'GND', at: [470, 380], orient: 3, len: 20, el: 7 },
      { n: '4', name: 'TAB', at: [520, 410], orient: 0, len: 20, el: 4 },
    ], refAt: [420, 460], commentAt: [470, 460] });
  component(b, { ref: 'C2', lib: 'Cap', comment: '22µF', at: [620, 400], lines: [[605, 405, 635, 405], [605, 395, 635, 395]], footprint: '0805', description: 'Chip capacitor, 0805',
    pins: [{ n: '1', name: '1', at: [620, 405], orient: 1, len: 25, showName: false }, { n: '2', name: '2', at: [620, 395], orient: 3, len: 25, showName: false }],
    refAt: [642, 405], commentAt: [642, 390] });

  // Power-good LED: on the schematic, not yet on the board — Design › Update PCB Document adds it
  component(b, { ref: 'R1', lib: 'Res', comment: '1k', at: [752, 380], body: [752, 380, 768, 410], footprint: '0805', description: 'Chip resistor, 0805',
    pins: [{ n: '1', name: '1', at: [760, 410], orient: 1, len: 20, showName: false }, { n: '2', name: '2', at: [760, 380], orient: 3, len: 20, showName: false }],
    refAt: [775, 400], commentAt: [775, 385] });
  component(b, { ref: 'D1', lib: 'LED', comment: 'Green', at: [750, 320], footprint: 'LED0805', description: 'Chip LED, 0805',
    lines: [[750, 340, 770, 340], [750, 340, 760, 322], [770, 340, 760, 322], [750, 320, 770, 320], [773, 334, 781, 342], [776, 328, 784, 336]],
    pins: [{ n: 'A', name: 'A', at: [760, 340], orient: 1, len: 10, showName: false }, { n: 'K', name: 'K', at: [760, 320], orient: 3, len: 10, showName: false }],
    refAt: [790, 335], commentAt: [790, 320] });
  b.wire([540, 410], [540, 430]);   // U1 tab to VOUT
  b.wire([700, 430], [760, 430]);
  b.wire([760, 360], [760, 350]);
  b.wire([760, 310], [760, 300]);
  for (const x of [540, 700]) b.add({ RECORD: SR.JUNCTION, OWNERPARTID: -1, COLOR: C.wire }, { LOCATION: { x, y: 430 } });
  b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: 4, ORIENTATION: 3, TEXT: 'GND', SHOWNETNAME: true, COLOR: C.wire }, { LOCATION: { x: 760, y: 300 } });

  b.wire([160, 430], [400, 430]);
  b.wire([540, 430], [700, 430]);
  b.wire([160, 390], [160, 360]);
  b.wire([250, 370], [250, 360]);
  b.wire([620, 370], [620, 360]);
  for (const x of [250, 620]) b.add({ RECORD: SR.JUNCTION, OWNERPARTID: -1, COLOR: C.wire }, { LOCATION: { x, y: 430 } });
  for (const x of [160, 250, 470, 620]) {
    b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: 4, ORIENTATION: 3, TEXT: 'GND', SHOWNETNAME: true, COLOR: C.wire },
      { LOCATION: { x, y: 360 } });
  }
  b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: 2, ORIENTATION: 1, TEXT: '+3V3', SHOWNETNAME: true, COLOR: C.wire }, { LOCATION: { x: 700, y: 430 } });
  b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'VIN', COLOR: C.wire, FONTID: 1 }, { LOCATION: { x: 300, y: 430 } });
  b.wire([540, 470], [640, 470]);
  b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'R\\S\\T\\', COLOR: C.wire, FONTID: 1 }, { LOCATION: { x: 560, y: 470 } });
  b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'LEFT', ORIENTATION: 2, COLOR: C.wire, FONTID: 1 }, { LOCATION: { x: 540, y: 470 } });
  b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: 'Konium Designer demo — 3V3 regulator', FONTID: 2, COLOR: C.text }, { LOCATION: { x: 100, y: 650 } });
  b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: 'Synthetic file written by Konium Designer', FONTID: 1, COLOR: toBgr(0x6a6f76) },
    { LOCATION: { x: 100, y: 620 } });

  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  return writeCfb(root);
}

/* ═══ PCB ═════════════════════════════════════════════════════════════════════════════ */

const O = { x: mil(1000), y: mil(1000) };
const P = (x: number, y: number): Vec2 => ({ x: O.x + mm(x), y: O.y + mm(y) });
const NET = { GND: 0, VIN: 1, V33: 2 };
const CMP = { J1: 0, C1: 1, U1: 2, C2: 3 };

export function demoPcbDoc(): Uint8Array {
  const len = (v: number) => formatAltiumLength(v);
  // Board6 as AD17 writes it for a new two-layer board (AD17 crashed on a thinner one)
  // (a 1.6 mm board: AD17's stack with a 1.53 mm FR-4 core)
  const stack = defaultStack().map((r) => (r.kind === 'dielectric' ? { ...r, height: mm(1.53) } : r));
  const board = newBoardRecord({ fileName: 'Demo.PcbDoc', origin: O, outline: [P(0, 0), P(40, 0), P(40, 25), P(0, 25)].map((p) => ({ p })),
    sheet: { x: 0, y: 0, width: mil(10000), height: mil(8000) }, stack, mechanical: [1, 13] }); // (the 3D bodies are on Mechanical 13)

  const nets = ['GND', 'VIN', '+3V3'].map((n) => PropertyBag.from({ NAME: n, VISIBLE: 'TRUE' }));
  const comps = [
    { ref: 'J1', pat: 'HDR1X2', at: P(5, 12.5) }, { ref: 'C1', pat: '0805', at: P(14, 15) },
    { ref: 'U1', pat: 'SOT-223', at: P(24, 12.5) }, { ref: 'C2', pat: '0805', at: P(33, 15) },
  ].map((c) => PropertyBag.from({ LAYER: 'TOP', PATTERN: c.pat, SOURCEDESIGNATOR: c.ref, X: len(c.at.x), Y: len(c.at.y), ROTATION: altiumFloat(0), NAMEON: 'TRUE', COMMENTON: 'FALSE' }));

  const pads: PcbRawRecord[] = [
    encodePad({ name: '1', layer: L.MULTI, at: P(5, 13.77), w: mm(1.7), h: mm(1.7), shape: 'rect', hole: mm(1), net: NET.VIN, component: CMP.J1 }),
    encodePad({ name: '2', layer: L.MULTI, at: P(5, 11.23), w: mm(1.7), h: mm(1.7), shape: 'round', hole: mm(1), net: NET.GND, component: CMP.J1 }),
    encodePad({ name: '1', layer: L.TOP, at: P(13.05, 15), w: mm(1), h: mm(1.25), shape: 'rect', net: NET.VIN, component: CMP.C1 }),
    encodePad({ name: '2', layer: L.TOP, at: P(14.95, 15), w: mm(1), h: mm(1.25), shape: 'rect', net: NET.GND, component: CMP.C1 }),
    encodePad({ name: '1', layer: L.TOP, at: P(21.7, 9.4), w: mm(1), h: mm(2), shape: 'rect', net: NET.GND, component: CMP.U1 }),
    encodePad({ name: '2', layer: L.TOP, at: P(24, 9.4), w: mm(1), h: mm(2), shape: 'rect', net: NET.V33, component: CMP.U1 }),
    encodePad({ name: '3', layer: L.TOP, at: P(26.3, 9.4), w: mm(1), h: mm(2), shape: 'rect', net: NET.VIN, component: CMP.U1 }),
    encodePad({ name: '4', layer: L.TOP, at: P(24, 15.6), w: mm(3.3), h: mm(2), shape: 'rect', net: NET.V33, component: CMP.U1 }),
    encodePad({ name: '1', layer: L.TOP, at: P(32.05, 15), w: mm(1), h: mm(1.25), shape: 'rect', net: NET.V33, component: CMP.C2 }),
    encodePad({ name: '2', layer: L.TOP, at: P(33.95, 15), w: mm(1), h: mm(1.25), shape: 'rect', net: NET.GND, component: CMP.C2 }),
  ];

  const tracks: PcbRawRecord[] = [];
  const route = (layer: number, w: number, net: number, ...pts: [number, number][]) => {
    for (let i = 1; i < pts.length; i++) tracks.push(encodeTrack({ layer, a: P(...pts[i - 1]!), b: P(...pts[i]!), width: mm(w), net }));
  };
  route(L.TOP, 0.6, NET.VIN, [5, 13.77], [6.23, 15], [13.05, 15]);
  route(L.TOP, 0.6, NET.VIN, [13.05, 15], [13.05, 7.2], [26.3, 7.2], [26.3, 9.4]);
  route(L.TOP, 0.8, NET.V33, [24, 15.6], [24, 18.6], [32.05, 18.6], [32.05, 15]);
  route(L.TOP, 0.5, NET.GND, [14.95, 15], [16.6, 15]);
  route(L.TOP, 0.5, NET.GND, [21.7, 9.4], [21.7, 11.5]);
  route(L.TOP, 0.8, NET.V33, [24, 9.4], [24, 15.6]);
  route(L.TOP, 0.5, NET.GND, [33.95, 15], [35.6, 15]);
  route(L.BOTTOM, 0.8, NET.GND, [5, 11.23], [5, 3.5], [35.6, 3.5], [35.6, 15]);
  route(L.BOTTOM, 0.8, NET.GND, [16.6, 15], [16.6, 3.5]);
  route(L.BOTTOM, 0.8, NET.GND, [21.7, 11.5], [21.7, 3.5]);
  // Silkscreen outlines (owned by components)
  const silk = (cmp: number, x0: number, y0: number, x1: number, y1: number) => {
    const c: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    for (let i = 1; i < c.length; i++) tracks.push(encodeTrack({ layer: L.TOP_OVERLAY, a: P(...c[i - 1]!), b: P(...c[i]!), width: mm(0.15), component: cmp }));
  };
  silk(CMP.J1, 3.6, 9.8, 6.4, 15.2);
  silk(CMP.C1, 12.1, 14.1, 15.9, 15.9);
  silk(CMP.U1, 20.6, 10.9, 27.4, 17.0);
  silk(CMP.C2, 31.1, 14.1, 34.9, 15.9);

  const vias = [[16.6, 15], [21.7, 11.5], [35.6, 15]].map(([x, y]) => encodeVia({ at: P(x!, y!), diameter: mm(0.8), hole: mm(0.4), net: NET.GND }));
  const fills = [encodeFill({ layer: L.TOP, a: P(22, 14.4), b: P(26, 17.2), net: NET.V33 })];
  const arcs = [
    encodeArc({ layer: L.TOP_OVERLAY, c: P(2.8, 13.77), r: mm(0.3), start: 0, end: 360, width: mm(0.15), component: CMP.J1 }),
    // Copper with no net (artwork): on a net, joined to nothing, it would fail Un-Routed Net and Net Antennae
    encodeArc({ layer: L.TOP, c: P(30, 7), r: mm(2.2), start: 200, end: 340, width: mm(0.4) }),
  ];
  const texts = [
    encodeText({ layer: L.TOP_OVERLAY, at: P(3.6, 15.8), height: mm(1), text: 'J1', component: CMP.J1, isDesignator: true }),
    encodeText({ layer: L.TOP_OVERLAY, at: P(12.1, 16.4), height: mm(1), text: 'C1', component: CMP.C1, isDesignator: true }),
    encodeText({ layer: L.TOP_OVERLAY, at: P(20.6, 17.5), height: mm(1), text: 'U1', component: CMP.U1, isDesignator: true }),
    encodeText({ layer: L.TOP_OVERLAY, at: P(31.1, 16.4), height: mm(1), text: 'C2', component: CMP.C2, isDesignator: true }),
    encodeText({ layer: L.TOP_OVERLAY, at: P(20.6, 8), height: mm(1), text: 'LDO 3V3', component: CMP.U1, isComment: true }), // hidden: COMMENTON=FALSE
    encodeText({ layer: L.TOP_OVERLAY, at: P(2, 22), height: mm(1.4), text: 'Konium demo board v0.1' }),
    encodeText({ layer: L.BOTTOM_OVERLAY, at: P(38, 22), height: mm(1.2), text: 'Bottom side', mirrored: true }),
    // The drill table's place on the Drill Drawing layer, below the board
    encodeText({ layer: L.DRILL_DRAWING, at: P(0, -5), height: mm(1.2), text: '.Legend' }),
  ];

  // The GND pour on the bottom layer is a polygon (Polygons6) poured by the engine below
  const regions: PcbRawRecord[] = [];
  // A shaped copper region with a rounded end (ShapeBasedRegions6)
  const sb = [P(22.5, 21.25), P(27.5, 21.25), P(27.5, 23.75), P(22.5, 23.75)];
  const shaped = [encodeRegion({ layer: L.TOP, shapeBased: true, outline: sb,
    arcs: new Map([[1, { c: P(27.5, 22.5), r: mm(1.25), a1: 270, a2: 90 }]]) })];

  const root = newEntry('Root Entry', 'root');
  // FileHeader and FileHeaderSix exactly as AD17 writes them (AD17 refuses a board without:
  // "File type not recognised"): u32 19 then "PCB 5.0 Bi" in UTF-16; u32 + Pascal "PCB 6.0 Binary File", f64 5.01
  const wide = 'PCB 5.0 Bi';
  const fh = new BinWriter(32).u32(19);
  for (const ch of wide) fh.u8(ch.charCodeAt(0)).u8(0);
  cfbPut(root, 'FileHeader', fh.finish());
  const six = binToBytes('PCB 6.0 Binary File');
  cfbPut(root, 'FileHeaderSix', new BinWriter(32).u32(six.length).u8(six.length).bytes(six).f64(5.01).finish());
  const putText = (s: string, bags: PropertyBag[]) => { cfbPut(root, `${s}/Header`, countHeader(bags.length)); cfbPut(root, `${s}/Data`, joinTextRecords(bags)); };
  const putBin = (s: string, recs: PcbRawRecord[]) => { cfbPut(root, `${s}/Header`, countHeader(recs.length)); cfbPut(root, `${s}/Data`, joinBinaryRecords(recs)); };
  putText('Board6', [board]);
  putText('Nets6', nets);
  putText('Components6', comps);
  putBin('Pads6', pads);
  putBin('Tracks6', tracks);
  putBin('Vias6', vias);
  putBin('Fills6', fills);
  putBin('Arcs6', arcs);
  putBin('Texts6', texts);
  putBin('Regions6', regions);
  putBin('ShapeBasedRegions6', shaped);
  // 3D bodies (extruded, as Altium's Place › 3D Body makes them): what 3D Layout Mode shows
  const box = (cx: number, cy: number, w: number, h: number) => [P(cx - w / 2, cy - h / 2), P(cx + w / 2, cy - h / 2), P(cx + w / 2, cy + h / 2), P(cx - w / 2, cy + h / 2)];
  const rgb = (r: number, g: number, b: number) => r | (g << 8) | (b << 16);
  const body = (component: number, outline: Vec2[], z0: number, z1: number, colour: number) =>
    encodeBody({ component, outline, standoff: mm(z0), overall: mm(z1), colour, layer: L.MECH1 + 12 });
  const black = rgb(38, 38, 40), tin = rgb(200, 200, 196), ceramic = rgb(186, 152, 104), gold = rgb(214, 172, 74);
  const bodies: PcbRawRecord[] = [
    body(CMP.J1, box(5, 12.5, 2.54, 5.08), 0, 2.5, black),
    body(CMP.J1, box(5, 13.77, 0.64, 0.64), 2.5, 8.5, gold), body(CMP.J1, box(5, 11.23, 0.64, 0.64), 2.5, 8.5, gold),
    ...[[CMP.C1, 14], [CMP.C2, 33]].flatMap(([c, x]) => [
      body(c!, box(x!, 15, 1.4, 1.25), 0, 1.15, ceramic),
      body(c!, box(x! - 0.85, 15, 0.3, 1.27), 0, 1.2, tin), body(c!, box(x! + 0.85, 15, 0.3, 1.27), 0, 1.2, tin),
    ]),
    body(CMP.U1, box(24, 12.5, 6.5, 3.5), 0.1, 1.7, black),
    ...[21.7, 24, 26.3].map((x) => body(CMP.U1, box(x, 9.9, 0.7, 1.7), 0, 0.35, tin)),
    body(CMP.U1, box(24, 15.1, 3, 1.4), 0, 0.35, tin),
  ];
  putBin('ComponentBodies6', bodies);
  // The other streams an AD17 board has, empty as on a new AD17 board
  for (const st of ['Connections6', 'Coordinates6', 'DifferentialPairs6', 'Dimensions6', 'EmbeddedBoards6', 'EmbeddedFonts6', 'Embeddeds6', 'FromTos6',
    'Models', 'ModelsNoEmbed', 'PadViaLibraryLinks', 'PinPairsSection', 'PrimitiveParameters', 'ShapeBasedComponentBodies6', 'SmartUnions', 'Textures',
    'WaivedViolations', 'WideStrings6', 'ExtendedPrimitiveInformation', 'UniqueIDPrimitiveInformation']) putBin(st, []);
  // Design rules: Altium's defaults, routing widths opened up to 10–40 mil, and a 12 mil
  // clearance for the Power net class (exercises scope queries)
  const rules = defaultRules();
  const width = rules.find((r) => r.bag.get('RULEKIND') === 'Width')!;
  width.bag.set('MINLIMIT', '10mil'); width.bag.set('PREFEREDWIDTH', '20mil'); width.bag.set('MAXLIMIT', '40mil');
  const power = newRule('Clearance', 'Clearance_Power', 1);
  power.bag.set('SCOPE1EXPRESSION', "InNetClass('Power')"); power.bag.set('GAP', '12mil');
  rules.find((r) => r.bag.get('RULEKIND') === 'Clearance')!.bag.set('PRIORITY', '2');
  // The footprints' silk sits 7.9 mil off their pads
  rules.find((r) => r.bag.get('RULEKIND') === 'SilkToSolderMaskClearance')!.bag.set('MINSILKSCREENTOMASKGAP', '5mil');
  rules.push(power);
  cfbPut(root, 'Rules6/Header', countHeader(rules.length));
  cfbPut(root, 'Rules6/Data', joinRuleRecords(rules));
  putText('Classes6', [PropertyBag.from({ NAME: 'Power', KIND: 0, SUPERCLASS: 'FALSE', M0: 'VIN', M1: '+3V3', UNIQUEID: 'DSGNPOWR' })]);
  // GND pour on the bottom layer: a Polygons6 definition, poured by Konium's engine
  const doc = readPcbDoc(writeCfb(root), 'Demo.PcbDoc');
  const pour = newPolygonProps('BOTTOM', NET.GND, 'GND_L2_P000', 0);
  writeVertices(pour, [P(1, 1), P(39, 1), P(39, 20.5), P(1, 20.5)].map((p) => ({ p })));
  addPolygon(doc, pour).apply();
  repour(doc, 0).apply();
  // The board's width and height dimensioned on Mechanical 1, as Place › Dimension › Linear makes them
  addDimension(doc, newDimension({ kind: 1, layer: L.MECH1, refs: [P(0, 0), P(40, 0)], at: P(0, -2.6), angle: 0, metric: true }, 0)).apply();
  addDimension(doc, newDimension({ kind: 1, layer: L.MECH1, refs: [P(40, 0), P(40, 25)], at: P(42.6, 0), angle: 90, metric: true }, 1)).apply();
  doc.dirty.add('Texts6'); // (so the texts get their WideStrings6 entries, as AD17 writes them)
  return writePcbDoc(doc);
}

/* ═══ Footprint library ═══════════════════════════════════════════════════════════════ */

/** The demo's footprints, origin at the footprint centre (as the board places them). */
export function demoFootprints(): FootprintDef[] {
  const Q = (x: number, y: number): Vec2 => ({ x: mm(x), y: mm(y) });
  const box = (x0: number, y0: number, x1: number, y1: number): PcbRawRecord[] => {
    const c: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
    return c.slice(1).map((p, i) => encodeTrack({ layer: L.TOP_OVERLAY, a: Q(...c[i]!), b: Q(...p), width: mm(0.15) }));
  };
  const chip = (name: string, a: string, b: string): PcbRawRecord[] => [
    encodePad({ name: a, layer: L.TOP, at: Q(-0.95, 0), w: mm(1), h: mm(1.25), shape: 'rect' }),
    encodePad({ name: b, layer: L.TOP, at: Q(0.95, 0), w: mm(1), h: mm(1.25), shape: 'rect' }),
    ...box(-1.9, -0.9, 1.9, 0.9),
    ...(name === 'LED0805' ? [encodeTrack({ layer: L.TOP_OVERLAY, a: Q(2.2, -0.9), b: Q(2.2, 0.9), width: mm(0.25) })] : []),
  ];
  return [
    { name: 'HDR1X2', description: 'Header, 2-Pin, 2.54 mm', height: '330mil', records: [
      encodePad({ name: '1', layer: L.MULTI, at: Q(0, 1.27), w: mm(1.7), h: mm(1.7), shape: 'rect', hole: mm(1) }),
      encodePad({ name: '2', layer: L.MULTI, at: Q(0, -1.27), w: mm(1.7), h: mm(1.7), shape: 'round', hole: mm(1) }),
      ...box(-1.4, -2.7, 1.4, 2.7),
      encodeArc({ layer: L.TOP_OVERLAY, c: Q(-2.2, 1.27), r: mm(0.3), start: 0, end: 360, width: mm(0.15) }),
    ] },
    { name: '0805', description: 'Chip, 0805 (2012 metric)', height: '40mil', records: chip('0805', '1', '2') },
    { name: 'LED0805', description: 'Chip LED, 0805; bar marks the cathode', height: '40mil', records: chip('LED0805', 'A', 'K') },
    { name: 'SOT-223', description: 'SOT-223, 3 leads and tab', height: '70mil', records: [
      encodePad({ name: '1', layer: L.TOP, at: Q(-2.3, -3.1), w: mm(1), h: mm(2), shape: 'rect' }),
      encodePad({ name: '2', layer: L.TOP, at: Q(0, -3.1), w: mm(1), h: mm(2), shape: 'rect' }),
      encodePad({ name: '3', layer: L.TOP, at: Q(2.3, -3.1), w: mm(1), h: mm(2), shape: 'rect' }),
      encodePad({ name: '4', layer: L.TOP, at: Q(0, 3.1), w: mm(3.3), h: mm(2), shape: 'rect' }),
      ...box(-3.4, -1.6, 3.4, 4.5),
    ] },
  ];
}

export const demoPcbLib = (): Uint8Array => writePcbLib(demoFootprints(), 'Demo.PcbLib');

export function demoPrjPcb(): Uint8Array {
  return binToBytes([
    '[Design]', 'Version=1.0', 'HierarchyMode=0', 'ChannelRoomNamingStyle=0', '',
    '[Document1]', 'DocumentPath=Demo.SchDoc', 'AnnotationEnabled=1', '',
    '[Document2]', 'DocumentPath=Demo.PcbDoc', 'AnnotationEnabled=1', '',
    '[Document3]', 'DocumentPath=Symbols.SchDoc', 'AnnotationEnabled=1', '',
    '[Document4]', 'DocumentPath=Demo.PcbLib', 'AnnotationEnabled=1', '',
    '[Document5]', 'DocumentPath=Demo.SchLib', 'AnnotationEnabled=1', '',
    '[Document6]', 'DocumentPath=Child.SchDoc', 'AnnotationEnabled=1', '',
    '[Document7]', 'DocumentPath=Demo.OutJob', 'AnnotationEnabled=1', '',
    '[Document8]', 'DocumentPath=Demo.DbLib', 'AnnotationEnabled=1', '',
  ].join('\r\n'));
}

/**
 * Demo.OutJob: Gerber, NC Drill, pick and place and BOM into the Folder Structure, assembly and
 * drill drawings into the PDF, each configured as an AD17 Output Job keeps it.
 */
export function demoOutJob(): Uint8Array {
  const board = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const job = newOutJob('Demo.OutJob');
  const out = (type: string, name: string, cat: string, doc: string, print: boolean, recs: (Record<string, string> | string)[], names?: string[]) => {
    const o = newOutput(type, name, cat, doc, print);
    setOutputConfig(o, recs, names);
    return o;
  };
  const stack = board.board.copperStack;
  const outs = [
    out('Gerber', 'Gerber Files', 'Fabrication', 'Demo.PcbDoc', false, gerberToConfig({ ...defaultGerberSetup(board), drillDrawing: true })),
    out('NC Drill', 'NC Drill Files', 'Fabrication', 'Demo.PcbDoc', false, drillToConfig(defaultDrillSetup())),
    out('Pick Place', 'Generates pick and place files', 'Assembly', 'Demo.PcbDoc', false, pnpToConfig(defaultPnpSetup())),
    out('BOM_PartType', 'Bill of Materials', 'Report', '', false, ['CaptionAsName', 'OpenExported=False|AddToProject=False|ForceFit=False|NotFitted=False|Database=False|IncludePCBData=False|ShowExportOptions=True|TemplateFilename=|BatchMode=5',
      'Comment=True|Footprint=True', 'Designator=Up|Comment=Up|Footprint=Up', 'Comment=100|Description=100|Designator=100|Footprint=100|LibRef=100|Quantity=100'],
      ['ColumnNameFormat', 'General', 'GroupOrder', 'SortOrder', 'VisibleOrder']),
    out('Assembly', 'Assembly Drawings', 'Assembly', 'Demo.PcbDoc', true, printJobToConfig(defaultJob(board, 'assembly'), [stack[0]!, stack.at(-1)!])),
    out('Drill', 'Drill Drawing/Guides', 'Fabrication', 'Demo.PcbDoc', true, printJobToConfig(defaultJob(board, 'drill'), [stack[0]!, stack.at(-1)!])),
  ];
  // Containers: 2 PDF, 3 Folder Structure
  outs.forEach((o, i) => { if (i < 4) o.media.set(3, i + 1); else o.media.set(2, i - 3); });
  setOutJobOutputs(job, outs);
  return writeOutJob(job);
}

/** Demo Parts.xlsx: the database of Demo.DbLib — one record a part, its symbol and footprint in the demo's libraries. */
const DEMO_PARTS: string[][] = [
  ['Part Number', 'Description', 'Comment', 'Value', 'Manufacturer', 'Manufacturer Part Number', 'Library Ref', 'Library Path', 'Footprint Ref', 'Footprint Path'],
  ['RES-0805-1K', 'Resistor, 1 kΩ, 1 %, 0805', '1k', '1k', 'Generic', 'R0805-1K-1%', 'Res', 'Demo.SchLib', '0805', 'Demo.PcbLib'],
  ['RES-0805-10K', 'Resistor, 10 kΩ, 1 %, 0805', '10k', '10k', 'Generic', 'R0805-10K-1%', 'Res', 'Demo.SchLib', '0805', 'Demo.PcbLib'],
  ['CAP-0805-100N', 'Capacitor, 100 nF, 50 V, X7R, 0805', '100nF', '100nF', 'Generic', 'C0805-100N-50V', 'Cap', 'Demo.SchLib', '0805', 'Demo.PcbLib'],
  ['CAP-0805-10U', 'Capacitor, 10 µF, 16 V, X5R, 0805', '10uF', '10uF', 'Generic', 'C0805-10U-16V', 'Cap', 'Demo.SchLib', '0805', 'Demo.PcbLib'],
  ['LED-0805-GRN', 'LED, green, 0805', 'Green', 'Green', 'Generic', 'LED0805-G', 'LED', 'Demo.SchLib', 'LED0805', 'Demo.PcbLib'],
  ['LDO-3V3-SOT223', 'Low-dropout regulator, 3.3 V, 1 A, SOT-223', 'LDO 3V3', '3V3', 'Generic', 'LDO-3V3-1A', 'LDO SOT-223', 'Demo.SchLib', 'SOT-223', 'Demo.PcbLib'],
];
export const demoPartsXlsx = (): Uint8Array => xlsx('Parts', DEMO_PARTS[0]!, DEMO_PARTS.slice(1), new Date(Date.UTC(2026, 0, 1)));

/** Demo.DbLib: a database library on Demo Parts.xlsx — the key Part Number, Value shown when placed. */
export function demoDbLib(): Uint8Array {
  const d = newDbLib('Demo.DbLib');
  setDbFile(d.links, 'Demo Parts.xlsx');
  const t = newTable('Parts$', DEMO_PARTS[0]!);
  t.maps.find((m) => m.field === 'Value')!.visible = true;
  d.tables.push(t);
  return writeDbLib(d);
}

export function demoFiles(): { name: string; bytes: Uint8Array }[] {
  return [
    { name: 'Demo.PrjPcb', bytes: demoPrjPcb() },
    { name: 'Demo.SchDoc', bytes: demoSchDoc() },
    { name: 'Demo.PcbDoc', bytes: demoPcbDoc() },
    { name: 'Symbols.SchDoc', bytes: symbolsSchDoc() },
    { name: 'Child.SchDoc', bytes: childSchDoc() },
    { name: 'Demo.PcbLib', bytes: demoPcbLib() },
    { name: 'Demo.SchLib', bytes: demoSchLib() },
    { name: 'Demo.OutJob', bytes: demoOutJob() },
    { name: 'Demo.DbLib', bytes: demoDbLib() },
    { name: 'Demo Parts.xlsx', bytes: demoPartsXlsx() },
  ];
}
