/** 26.069: CAMtastic's File menu — IPC-D-356, DXF, HPGL, bitmaps, ODB++, aperture libraries, centroids, Export to PCB, macros, reading defaults. */
import { beforeEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { defaultDrillSetup, drillFiles } from '../src/formats/gerber/drill';
import { camLayerFrom, newCamDocument, type CamDocument } from '../src/formats/cam/camDoc';
import { readDrill, type DrillLayer, type GerberLayer } from '../src/formats/gerber/gerberRead';
import { extractNets, compareNets } from '../src/formats/cam/camAnalysis';
import { apertureLibrary, bmp, centroidsCsv, rasterise, readApertureLibrary, readDxf, readHpgl, readIpc356, readOdb, writeCamOdb, writeDxf, writeIpc350, writeIpc356 } from '../src/formats/cam/camIO';
import { camToPcb } from '../src/formats/cam/camToPcb';
import { liveObjects } from '../src/formats/cam/camModel';
import { CamEditor } from '../src/editors/cam/CamEditor';
import { commands } from '../src/core/commands';
import '../src/app/commands';
import { activeId, docs, type OpenDoc } from '../src/app/state';
import { closeDialog, dialogStack } from '../src/app/dialogs';
import { camScript, runScript } from '../src/app/camFileCommands';
import { mil } from '../src/core/units';
import { L } from '../src/model/layers';

const pcb = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const files = [...gerberFiles(pcb, defaultGerberSetup(pcb)).files.filter((f) => /\.(GTL|GBL|GTO|GTS|GTP|GM1)$/.test(f.name)), drillFiles(pcb, defaultDrillSetup())[0]!];
let d: CamDocument;
beforeEach(() => { d = newCamDocument('T.Cam', files.map((f) => camLayerFrom(f.name, f.text)!)); });
const gl = (l: { data: unknown }) => l.data as GerberLayer;

describe('netlists', () => {
  it('IPC-D-356 written from the extracted nets reads back as the same nets; Compare finds nothing wrong', () => {
    d.nets = extractNets(d);
    const text = writeIpc356(d);
    expect(text).toMatch(/^C {2}IPC-D-356A/);
    expect(text).toMatch(/\r\n3[12]7NET\d/);
    expect(text).toMatch(/\r\n317NET\d+ .*D\d{4}P/);
    expect(text).toMatch(/389BOARD_EDGE/);
    const ref = readIpc356(text);
    // Nets with a test point (copper with a hole or a pad on an outer layer) come back
    expect(ref.length).toBeGreaterThan(0);
    expect(ref.length).toBeLessThanOrEqual(d.nets.length);
    d.refNets = ref;
    const c = compareNets(d);
    expect([c.opens, c.shorts, c.missing]).toEqual([[], [], []]);
    expect(writeIpc350(d)).toMatch(/IPC-D-350[\s\S]*LAYER 01/);
  });

  it('reads an IPC-D-356 file\'s aliases and units', () => {
    const t = 'P  UNITS CUST 1\r\nP  NNAME1  A_VERY_LONG_NET_NAME_INDEED\r\n327NNAME1           U1    -1         A01X+001000Y+002000X0100Y0100R000 S1\r\n317GND              J1    -2   D0800PA00X+010000Y+000000X1000Y1000R000 S3\r\n999\r\n';
    const nets = readIpc356(t);
    expect(nets.map((n) => n.name)).toEqual(['A_VERY_LONG_NET_NAME_INDEED', 'GND']);
    expect(nets[0]!.points[0]).toMatchObject({ ref: 'U1', pin: '1', side: 'top' });
    expect(Math.round(nets[0]!.points[0]!.at.x)).toBe(Math.round(393700.787));
  });
});

describe('drawings', () => {
  it('DXF written and read back: a layer each, lines, arcs, circles, polylines', () => {
    const text = writeDxf(d);
    expect(text).toMatch(/AC1009/);
    const layers = readDxf(text, { unit: 'mm', width: mil(4) });
    expect(layers.map((l) => l.name)).toContain('DEMO_GTL.DXF');
    const top = layers.find((l) => l.name === 'DEMO_GTL.DXF')!;
    expect(gl(top).objects.length).toBeGreaterThan(10);
  });

  it('DXF: bulges, blocks inserted, text, $INSUNITS', () => {
    const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC', '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'PADB', '10', '0', '20', '0', '0', 'CIRCLE', '8', '0', '10', '0', '20', '0', '40', '0.05', '0', 'ENDBLK', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '8', 'OUTLINE', '90', '2', '70', '0', '10', '0', '20', '0', '42', '1', '10', '1', '20', '0',
      '0', 'INSERT', '8', 'PADS', '2', 'PADB', '10', '2', '20', '2',
      '0', 'TEXT', '8', 'NOTES', '10', '0', '20', '1', '40', '0.1', '1', 'HI',
      '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const layers = readDxf(dxf, { unit: 'mm', width: mil(4) });
    const outline = layers.find((l) => l.name === 'OUTLINE.DXF')!;
    const arc = gl(outline).objects[0]!;
    expect(arc.kind).toBe('arc');
    expect(arc.kind === 'arc' && [Math.round(arc.c.x), Math.round(arc.c.y)]).toEqual([mil(500), 0]);
    const pad = gl(layers.find((l) => l.name === 'PADS.DXF')!).objects[0]!;
    expect(pad.kind === 'arc' && [Math.round(pad.c.x), Math.round(pad.c.y)]).toEqual([mil(2000), mil(2000)]);
    expect(gl(layers.find((l) => l.name === 'NOTES.DXF')!).objects.length).toBeGreaterThan(3);
  });

  it('HPGL: pen moves, circles, arcs', () => {
    const l = readHpgl('IN;SP1;PU0,0;PD400,0,400,400;PU;PA800,800;CI100;PD;AA800,400,90;', 'P.PLT');
    const objs = gl(l).objects;
    expect(objs.filter((o) => o.kind === 'draw').length).toBe(2);
    expect(objs.filter((o) => o.kind === 'arc').length).toBe(2);
    const first = objs[0]!;
    expect(first.kind === 'draw' && Math.round(first.b.x)).toBe(Math.round(393700.787 * 10));
  });

  it('a bitmap of the films', () => {
    const r = rasterise(d, 200)!;
    expect(r.w).toBeGreaterThan(100);
    const b = bmp(r.w, r.h, r.rgb, 200);
    expect([b[0], b[1]]).toEqual([0x42, 0x4d]);
    expect(new DataView(b.buffer).getInt32(18, true)).toBe(r.w);
    // Some copper red on the black field
    let red = 0;
    for (let i = 0; i < r.rgb.length; i += 3) if (r.rgb[i]! > 200 && r.rgb[i + 1]! < 50) red++;
    expect(red).toBeGreaterThan(100);
  });
});

describe('ODB++ and the rest', () => {
  it('ODB++ written and read back: the layers, their types and objects', async () => {
    const job = await writeCamOdb(d);
    expect(job.name).toBe('t.tgz');
    const back = await readOdb(job.bytes);
    expect(back.layers.map((l) => l.type).sort()).toEqual(d.layers.map((l) => l.type).sort());
    const top = back.layers.find((l) => l.type === 'Top')!;
    expect(liveObjects(top).length).toBe(liveObjects(d.layers.find((l) => l.type === 'Top')!).length);
    const drill = back.layers.find((l) => l.data.kind === 'drill')!;
    expect((drill.data as DrillLayer).hits.length).toBe((d.layers.find((l) => l.data.kind === 'drill')!.data as DrillLayer).hits.length);
  });

  it('aperture library written and read; centroids', () => {
    const top = d.layers.find((l) => l.type === 'Top')!;
    const lib = apertureLibrary(top);
    const fresh = camLayerFrom('X.GBR', '%FSLAX46Y46*%%MOMM*%%ADD10C,0.25*%D10*X0Y0D03*M02*')!;
    const added = readApertureLibrary(lib, gl(fresh));
    expect(added.length).toBe(gl(top).apertures.size);
    expect(gl(fresh).apertures.size).toBe(gl(top).apertures.size + 1);
    d.parts = [{ ref: 'U1', at: { x: mil(1000), y: mil(500) }, rot: 90, side: 'top', pads: {}, value: '10k, 1%' }];
    expect(centroidsCsv(d, 'mil')).toBe('Designator,Mid X (mil),Mid Y (mil),Rotation,Layer,Value,Footprint\r\nU1,1000.00,500.00,90,TopLayer,"10k, 1%",\r\n');
  });

  it('Export to PCB: a board of tracks, pads on the holes, regions, the nets', () => {
    d.nets = extractNets(d);
    const r = camToPcb(d);
    const b = readPcbDoc(r.bytes, r.name);
    const tracks = b.prims.filter((p) => p.kind === 'track');
    const pads = b.prims.filter((p) => p.kind === 'pad');
    expect(tracks.some((t) => t.layer === L.TOP)).toBe(true);
    expect(tracks.some((t) => t.layer === L.TOP_OVERLAY)).toBe(true);
    expect(pads.some((p) => p.kind === 'pad' && p.hole > 0)).toBe(true);
    expect(b.nets.length).toBe(d.nets.length);
    expect(b.board.outline.length).toBeGreaterThanOrEqual(4);
  });

  it('files that don\'t say are read as Setup says', () => {
    const headerless = 'T01C0.8\nX010000Y020000\nM30\n';
    const mm = readDrill(headerless, { units: 'mm', int: 3, dec: 3, omit: 'L' });
    expect(Math.round(mm.hits[0]!.at.x)).toBe(Math.round(393700.787 * 10));
    const inch = readDrill(headerless);
    expect(Math.round(inch.hits[0]!.at.x)).toBe(10_000_000);
  });
});

describe('macros', () => {
  it('recorded as commands, clicks and answers; played back', async () => {
    const ed = new CamEditor(d);
    docs.value = [{ id: 'cam1', name: d.name, doc: d, editor: ed } as unknown as OpenDoc];
    activeId.value = 'cam1';
    while (dialogStack.value.length) closeDialog();
    const top = d.layers.find((l) => l.type === 'Top Silk')!;
    d.current = d.layers.indexOf(top);
    ed.setGrid(mil(10));
    commands.run('ad:CAMTASTIC:MacroRecord', 'cam');
    commands.run('ad:CAMTASTIC:DrawLine', 'cam');
    const click = (x: number, y: number, button = 0) => { const p = { world: ed.snap({ x, y }), raw: { x, y }, button, shift: false, ctrl: false, alt: false }; if (button === 2) ed.rightClick(p); else { ed.pointerMove(p); ed.pointerDown(p); } };
    click(0, 0); click(mil(100), 0); click(0, 0, 2);
    commands.run('ad:CAMTASTIC:MacroStopRecording', 'cam');
    const s = camScript();
    expect(s).toEqual(['run ad:CAMTASTIC:DrawLine', 'click 0 0', `click ${mil(100)} 0`, 'rclick']);
    const n = gl(top).objects.length;
    await runScript(ed, s.map((l) => l.replace(/^click (\d+) 0$/, (m, x) => (x === '0' ? m : `click ${Number(x) + mil(100)} 0`))), async () => {});
    expect(gl(top).objects.length).toBe(n + 1);
    expect(gl(top).objects.at(-1)!.kind === 'draw' && gl(top).objects.at(-1)!.kind).toBe('draw');
  });
});
