import { describe, expect, it } from 'vitest';
import { demoFiles } from '../src/formats/synthetic/demo';
import { load, save } from '../src/formats/registry';
import { compileProject } from '../src/model/compile';
import type { SchDocument } from '../src/model/sch';
import type { PcbDocument, PcbPrim } from '../src/model/pcb';
import { readSchDoc, writeSchAscii } from '../src/formats/altium/schdoc';
import { isPcbAscii, readPcbAscii, writePcbAscii } from '../src/formats/altium/pcbAscii';
import { cfbStream } from '../src/formats/cfb/cfb';
import { splitBinaryRecords } from '../src/formats/altium/framing';
import { readPrjPcb, iniGet } from '../src/formats/altium/prjpcb';
import { exportCadence, prjPcbStructure } from '../src/formats/cadenceExport';
import { EXPORTERS } from '../src/formats/exporters';
import { L } from '../src/model/layers';
import { binToBytes, bytesToBin } from '../src/formats/text';

function demo() {
  const files = demoFiles();
  const docs = files.filter((f) => /\.(schdoc|pcbdoc)$/i.test(f.name)).map((f) => load(f.bytes, f.name));
  const prj = files.find((f) => /\.prjpcb$/i.test(f.name))!;
  return {
    sheets: docs.filter((d): d is SchDocument => d.kind === 'SchDoc').map((d) => ({ name: d.name, doc: d })),
    board: docs.find((d): d is PcbDocument => d.kind === 'PcbDoc')!,
    mode: Number(iniGet(readPrjPcb(prj.bytes, prj.name), 'Design', 'HierarchyMode') ?? 0),
  };
}
const netlist = (c: ReturnType<typeof compileProject>) => new Set(c.nets.map((n) => `${n.name}: ${n.pins.map((p) => `${p.designator}.${p.pin}`).sort().join(' ')}`));
/** A primitive's drawn fields (not where it is stored). */
const fields = (p: PcbPrim) => {
  const { src, ...r } = p as PcbPrim & { outline?: unknown; fontName?: string; bold?: boolean };
  void src;
  const o = r as Record<string, unknown>;
  if (o.kind === 'text' && o.fontType === 0) { o.fontName = ''; o.bold = false; o.italic = false; }
  if (o.kind === 'pad') for (const l of ['top', 'mid', 'bot']) { const x = o[l] as { shape: string; cornerPct: number }; if (x.shape !== 'roundrect') o[l] = { ...x, cornerPct: 0 }; }
  return JSON.stringify(o, (_, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
};

/** AD's ASCII PCB records as an AD-saved file has them (trimmed): a board, a net, a component, a track, a pad, the board's region. */
const NATIVE = [
  '|RECORD=Board|SELECTION=FALSE|LAYER=UNKNOWN|LOCKED=FALSE|KIND=Protel_Advanced_PCB|VERSION=5.01|ORIGINX=1000mil|ORIGINY=1000mil|KIND0=0|VX0=1000mil|VY0=1000mil|CX0=0mil|CY0=0mil|SA0= 0.00000000000000E+0000|EA0= 0.00000000000000E+0000|R0=0mil|KIND1=0|VX1=2000mil|VY1=1000mil|CX1=0mil|CY1=0mil|SA1= 0.00000000000000E+0000|EA1= 0.00000000000000E+0000|R1=0mil\r|RECORD=Board|KIND2=0|VX2=2000mil|VY2=2000mil|CX2=0mil|CY2=0mil|SA2= 0.00000000000000E+0000|EA2= 0.00000000000000E+0000|R2=0mil|KIND3=0|VX3=1000mil|VY3=2000mil|CX3=0mil|CY3=0mil|SA3= 0.00000000000000E+0000|EA3= 0.00000000000000E+0000|R3=0mil',
  '|RECORD=Net|ID=0|INDEXFORSAVE=0|SELECTION=FALSE|LAYER=TOP|LOCKED=FALSE|NAME=GND|VISIBLE=TRUE',
  '|RECORD=Component|ID=0|INDEXFORSAVE=0|SELECTION=FALSE|LAYER=TOP|LOCKED=FALSE|X=1500mil|Y=1500mil|PATTERN=R0603|NAMEON=TRUE|COMMENTON=FALSE|ROTATION= 0.00000000000000E+0000|SOURCEDESIGNATOR=R1',
  '|RECORD=Track|NET=0|INDEXFORSAVE=0|SELECTION=FALSE|LAYER=TOP|LOCKED=FALSE|POLYGONOUTLINE=FALSE|USERROUTED=TRUE|UNIONINDEX=0|X1=1200mil|Y1=1500mil|X2=1470mil|Y2=1500mil|WIDTH=11.811mil|SUBPOLYINDEX=0',
  '|RECORD=Pad|NET=0|COMPONENT=0|INDEXFORSAVE=0|SELECTION=FALSE|LAYER=TOP|LOCKED=FALSE|SOLDERMASKEXPANSIONMODE=Rule|PASTEMASKEXPANSIONMODE=Rule|NAME=1|X=1470mil|Y=1500mil|XSIZE=31.4961mil|YSIZE=39.3701mil|SHAPE=RECTANGLE|HOLESIZE=0mil|ROTATION= 0.00000000000000E+0000|PLATED=TRUE',
  'RECORD=Region|INDEXFORSAVE=0|V7_LAYER=MULTILAYER|NAME=Layer Stack Region 1|LAYER=KEEPOUT|KEEPOUT=TRUE|ISBOARDCUTOUT=TRUE|KIND=0|ISSHAPEBASED=FALSE|OBJECTKIND=BoardRegion|KIND0=0|VX0=1000mil|VY0=1000mil|CX0=0mil|CY0=0mil|SA0=0|EA0=0|R0=0mil|KIND1=0|VX1=2000mil|VY1=1000mil|CX1=0mil|CY1=0mil|SA1=0|EA1=0|R1=0mil|KIND2=0|VX2=2000mil|VY2=2000mil|CX2=0mil|CY2=0mil|SA2=0|EA2=0|R2=0mil|HOLECOUNT=0',
].join('\r\n') + '\r\n';

describe('AD ASCII PCB files (26.055)', () => {
  it('reads AD\'s ASCII PCB records: board continued after a bare CR, nets, components, tracks, pads; a board region stays the board\'s', () => {
    const bytes = binToBytes(NATIVE);
    expect(isPcbAscii(bytes)).toBe(true);
    const doc = load(bytes, 'Native.PcbDoc') as PcbDocument;
    expect(doc.kind).toBe('PcbDoc');
    expect(doc.ascii).toBe(true);
    expect(doc.board.outline.length).toBe(4);
    expect(doc.nets.map((n) => n.name)).toEqual(['GND']);
    expect(doc.components.map((c) => c.designator)).toEqual(['R1']);
    const track = doc.prims.find((p) => p.kind === 'track')!;
    expect(track).toMatchObject({ layer: L.TOP, net: 0, a: { x: 12_000_000, y: 15_000_000 }, b: { x: 14_700_000, y: 15_000_000 }, width: 118_110 });
    const pad = doc.prims.find((p) => p.kind === 'pad')!;
    expect(pad).toMatchObject({ name: '1', layer: L.TOP, net: 0, component: 0, top: { w: 314_961, h: 393_701, shape: 'rect' } });
    // The board region is no copper and no cut-out: it goes with the board's layer stacks
    expect(doc.prims.filter((p) => p.kind === 'region')).toEqual([]);
    expect(splitBinaryRecords(cfbStream(doc.cfb.root, 'BoardRegions/Data')!).length).toBe(1);
  });

  it('writes a board as ASCII and reads it back the same: every primitive, net, component, rule and class; saved as ASCII again', () => {
    const { board } = demo();
    const w = writePcbAscii(board);
    const text = bytesToBin(w.bytes);
    expect(text.startsWith('|RECORD=Board|')).toBe(true);
    expect(text).toMatch(/\r\n\|RECORD=Net\|ID=0\|INDEXFORSAVE=0\|/);
    expect(text).toMatch(/\|RECORD=Track\|NET=\d+\|INDEXFORSAVE=\d+\|SELECTION=FALSE\|LAYER=\w+\|/);
    const back = readPcbAscii(w.bytes, 'Demo.PcbDoc');
    expect(back.prims.map(fields)).toEqual(board.prims.map(fields));
    expect(back.nets.map((n) => n.name)).toEqual(board.nets.map((n) => n.name));
    expect(back.components.map((c) => [c.designator, c.pattern, c.at, c.rotation, c.layer])).toEqual(board.components.map((c) => [c.designator, c.pattern, c.at, c.rotation, c.layer]));
    expect(back.rules.map((r) => r.bag.get('NAME'))).toEqual(board.rules.map((r) => r.bag.get('NAME')));
    expect(back.classes.map((c) => c.name)).toEqual(board.classes.map((c) => c.name));
    expect(back.polygons.length).toBe(board.polygons.length);
    expect(back.dimensions.length).toBe(board.dimensions.length);
    expect(back.board.copperStack).toEqual(board.board.copperStack);
    // A board read from ASCII is saved in ASCII
    const again = save(back);
    expect(isPcbAscii(again)).toBe(true);
    expect((load(again, 'Demo.PcbDoc') as PcbDocument).prims.map(fields)).toEqual(board.prims.map(fields));
  });

  it('writes schematics as ASCII: AD\'s header, the same objects and nets', () => {
    const { sheets, mode } = demo();
    const back = sheets.map((s) => {
      const r = writeSchAscii(s.doc);
      expect(bytesToBin(r.bytes.subarray(0, 70))).toMatch(/^\|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5\.0\|/);
      const doc = readSchDoc(r.bytes, s.name);
      expect(doc.asciiEol).toBe('\r\n');
      expect(doc.objects.length).toBe(s.doc.objects.length);
      return { name: s.name, doc };
    });
    expect(netlist(compileProject(back, { scope: mode }))).toEqual(netlist(compileProject(sheets, { scope: mode })));
  });

  it('Export Wizard › OrCAD and Allegro: the project, its structure file, ASCII schematics and board', () => {
    expect(EXPORTERS.some((e) => e.id === 'cadence')).toBe(true);
    const { sheets, board, mode } = demo();
    const r = exportCadence({ name: 'Demo', sheets, board, schLibs: [], pcbLibs: [], hierarchyMode: mode, variables: [{ name: 'Rev', value: 'B' }] });
    const paths = r.files.map((f) => f.path);
    expect(paths.slice(0, 2)).toEqual(['Demo/Demo.PrjPcb', 'Demo/Demo.PrjPcbStructure']);
    for (const s of sheets) expect(paths).toContain(`Demo/${s.name}`);
    expect(paths).toContain('Demo/Demo.PcbDoc');
    const prj = readPrjPcb(r.files[0]!.bytes, 'Demo.PrjPcb');
    expect(prj.documents.map((d) => d.toLowerCase()).sort()).toEqual([...sheets.map((s) => s.name), 'Demo.PcbDoc'].map((d) => d.toLowerCase()).sort());
    expect(iniGet(prj, 'Design', 'HierarchyMode')).toBe(String(mode));
    for (const f of r.files.filter((x) => /\.schdoc$/i.test(x.path))) expect(bytesToBin(f.bytes.subarray(0, 8))).toBe('|HEADER=');
    expect(isPcbAscii(r.files.find((f) => /\.pcbdoc$/i.test(f.path))!.bytes)).toBe(true);
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    // The sheet tree: the demo's Symbols sheet stands for Child
    const lines = bytesToBin(prjPcbStructure(sheets)).split('\r\n').filter(Boolean);
    expect(lines.filter((l) => l.startsWith('Record=TopLevelDocument|'))).not.toEqual([]);
    expect(lines.some((l) => /^Record=SheetSymbol\|SourceDocument=Symbols\.SchDoc\|.*\|FileName=Child\.SchDoc\|SheetNumber=\d+\|/.test(l))).toBe(true);
  });
});
