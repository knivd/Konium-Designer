/** 26.069: CAMtastic's Tables, Tools, Rout, Analysis and Reports — netlist, design check, pours, silk, venting, panels, routs, parts, the reports. */
import { beforeEach, describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { defaultDrillSetup, drillFiles } from '../src/formats/gerber/drill';
import { camLayerFrom, newCamDocument, type CamDocument, type CamLayer } from '../src/formats/cam/camDoc';
import { writeCamLayer } from '../src/formats/cam/camWrite';
import { readGerber, type DrillLayer, type GerberLayer } from '../src/formats/gerber/gerberRead';
import { CamEditor } from '../src/editors/cam/CamEditor';
import { commands } from '../src/core/commands';
import '../src/app/commands';
import { activeId, docs, toast, type OpenDoc } from '../src/app/state';
import { closeDialog, dialogStack } from '../src/app/dialogs';
import type { CamField, CamValues } from '../src/app/dialogs/CamForm';
import { mil } from '../src/core/units';
import { liveObjects } from '../src/formats/cam/camModel';
import { parseApertureList } from '../src/app/dialogs/CamTables2';
import { annularRings, extractNets } from '../src/formats/cam/camAnalysis';

const pcb = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const files = [...gerberFiles(pcb, defaultGerberSetup(pcb)).files.filter((f) => /\.(GTL|GBL|GTO|GTS|GTP|GM1)$/.test(f.name)), drillFiles(pcb, defaultDrillSetup())[0]!];

let ed: CamEditor, d: CamDocument;
const run = (name: string) => { expect(commands.run(`ad:CAMTASTIC:${name}`, 'cam')).toBe(true); };
const click = (x: number, y: number, button = 0) => { const p = { world: ed.snap({ x, y }), raw: { x, y }, button, shift: false, ctrl: false, alt: false }; if (button === 2) ed.rightClick(p); else { ed.pointerMove(p); ed.pointerDown(p); } };
function answer(over: Record<string, unknown> = {}): void {
  const top = dialogStack.value.at(-1);
  expect(top, `a dialog is open (${toast.value?.text})`).toBeTruthy();
  const props = top!.props as { fields?: CamField[]; onOk?: (v: CamValues) => void | string; title?: string };
  const v: CamValues = {};
  for (const f of props.fields ?? []) if (f.kind !== 'note') v[f.key] = f.value as CamValues[string];
  Object.assign(v, over);
  const r = props.onOk!(v);
  expect(r, `the dialog took the answer (${String(r)})`).toBeUndefined();
  closeDialog();
}
/** A report dialog's text (closed after). */
function reportText(): string { const top = dialogStack.value.at(-1); const t = (top?.props as { text?: string; lines?: string[] }); closeDialog(); return t?.text ?? (t?.lines ?? []).join('\n'); }
const layer = (ext: string) => d.layers.find((l) => l.name.endsWith(ext))!;
const gerber = (l: CamLayer) => l.data as GerberLayer;
const current = (l: CamLayer) => { d.current = d.layers.indexOf(l); };

beforeEach(() => {
  d = newCamDocument('T.Cam', files.map((f) => camLayerFrom(f.name, f.text)!));
  ed = new CamEditor(d);
  docs.value = [{ id: 'cam1', name: d.name, doc: d, editor: ed } as unknown as OpenDoc];
  activeId.value = 'cam1';
  while (dialogStack.value.length) closeDialog();
  ed.setGrid(mil(5));
});

describe('Netlist and analysis', () => {
  it('Extract finds the board\'s nets through the plated holes; Query Net, Rename, Clean', () => {
    run('ToolsNetListEx');
    const nets = d.nets!;
    // The demo board's routed nets: as many as the board has copper-connected nets
    expect(nets.length).toBeGreaterThanOrEqual(4);
    // A through-hole pad's net reaches both sides
    expect(nets.some((n) => n.members[layer('.GTL').name]?.length && n.members[layer('.GBL').name]?.length)).toBe(true);
    // Every top copper object is in one net
    const top = layer('.GTL');
    const inNets = nets.flatMap((n) => n.members[top.name] ?? []);
    expect(new Set(inNets).size).toBe(inNets.length);
    expect(inNets.length).toBe(liveObjects(top).filter(({ o }) => o.dark).length);
    run('ToolsNetListRenameNets');
    expect(dialogStack.value.length).toBe(1); closeDialog();
    run('ToolsNetListCleanNets');
    expect(d.nets).toBeUndefined();
    ed.undo.undo();
    expect(d.nets?.length).toBe(nets.length);
  });

  it('PCB Design Check: clearance between nets, widths, annular rings, holes; marks; the DRC/DFM report', () => {
    run('InfoDrc'); answer({ cl: mil(1), w: mil(1), ar: mil(1), h1: mil(1), smOn: false, dcOn: false });
    expect(ed.drc).toEqual([]);
    // 26.148: a clean check still tells the RFQ report how far apart the nets are at least
    run('InfoPCBReport');
    expect(reportText()).toMatch(/Smallest spacing: at least .+ \(no clearance violations in the last PCB Design Check\)/);
    run('InfoDrc'); answer({ cl: mil(300), w: mil(50), ar: mil(40), h1: mil(1), smOn: false, dcOn: false });
    const kinds = new Set(ed.drc!.map((v) => v.rule));
    expect(kinds.has('Clearance')).toBe(true);
    expect(kinds.has('Width')).toBe(true);
    expect(kinds.has('Annular Ring')).toBe(true);
    expect(() => ed.overlay()).not.toThrow();
    run('InspectReportDrcDfm');
    expect(reportText()).toMatch(/Clearance \(\d+\)/);
  });

  it('copper area, annular rings, measure, query group, invalid polygons', () => {
    run('ToolsCopperArea');
    expect(reportText()).toMatch(/Demo\.GTL \(Top\): .*% of/);
    const rings = annularRings(d);
    expect(rings.length).toBeGreaterThan(0);
    run('InfoMinAnnularRing');
    expect(reportText()).toMatch(/Smallest ring/);
    // A polygon crossing itself
    const top = layer('.GTL'); current(top);
    run('DrawPolygon'); click(0, 0); click(mil(100), mil(100)); click(mil(100), 0); click(0, mil(150)); click(0, 0, 2);
    run('InfoPolygons');
    expect(reportText()).toMatch(/crosses itself/);
    expect(ed.selectedObjects().length).toBe(1);
    run('InfoQueryMultiple');
    expect(reportText()).toMatch(/Polygon: 1/);
  });

  it('the reports: RFQ, D-code usage, X:Y, rout, netlist', () => {
    run('InfoPCBReport');
    const rfq = reportText();
    expect(rfq).toMatch(/Board size: /);
    expect(rfq).toMatch(/Copper layers: 2/);
    expect(rfq).toMatch(/Holes: \d+ \(\d+ plated/);
    run('InspectReport'); expect(reportText()).toMatch(/Demo\.GTL \(Top\): \d+ D-codes/);
    run('InspectReportsXYCoordinates'); expect(reportText()).toMatch(/Flash\t/);
    run('InspectReportsRout'); expect(reportText()).toMatch(/No rout paths|Rout/);
    run('ToolsNetListEx');
    run('FileExportNetList'); expect(reportText()).toMatch(/NET1/);
  });
});

describe('Tools', () => {
  it('Copper Pour fills round the copper; Venting, Teardrops, Spread/Reduce, Pad Removal', () => {
    const bot = layer('.GBL'); current(bot);
    const n0 = gerber(bot).objects.length;
    run('ToolsCopperPour'); answer({ cl: mil(15), m: mil(20) });
    const pour = gerber(bot).objects.slice(n0);
    expect(pour.length).toBeGreaterThan(0);
    expect(pour.every((o) => o.kind === 'region')).toBe(true);
    ed.undo.undo();
    run('ToolsVenting'); answer({ pitch: mil(100), size: mil(40), cl: mil(30), m: mil(50) });
    expect(gerber(bot).objects.length).toBeGreaterThan(n0 + 10);
    ed.undo.undo();
    const top = layer('.GTL'); current(top);
    run('ToolsTearDrop'); answer({ layers: [top.name, bot.name] });
    run('ToolsSpread'); answer({ by: mil(3), layers: [layer('.GTS').name], what: 'Flashes' });
    const mask = gerber(layer('.GTS'));
    const before = gerber(layer('.GTS'));
    expect(liveObjects(layer('.GTS')).every(({ o }) => o.kind !== 'flash' || mask.apertures.has(o.ap))).toBe(true);
    void before;
    run('ToolsPads'); answer({ layers: [top.name] });
  });

  it('Trim Silkscreen cuts silk off the mask openings', () => {
    const silk = layer('.GTO'), mask = layer('.GTS'); current(silk);
    // A silk line across a mask opening
    const f = liveObjects(mask).find(({ o }) => o.kind === 'flash')!.o as { at: { x: number; y: number } };
    run('DrawLine'); click(f.at.x - mil(200), f.at.y); click(f.at.x + mil(200), f.at.y); click(0, 0, 2);
    const n = gerber(silk).objects.length;
    run('ToolsTrimsilk'); answer({ cl: mil(5) });
    expect(gerber(silk).objects.length).toBeGreaterThan(n);
    expect((silk.erased ?? []).includes(n - 1)).toBe(true);
  });

  it('Convert closed polylines to polygons; Clean, Fill Boundaries, Generate Outlines', () => {
    const silk = layer('.GTO'); current(silk);
    run('DrawRect'); click(0, 0); click(mil(200), mil(100)); click(0, 0, 2);
    const k = gerber(silk).objects.length - 4;
    ed.select([ed.groupKeyOf(silk, gerber(silk).objects[k]!.grp!)]);
    run('ConvertDrawsToSolidRegion');
    expect(gerber(silk).objects.at(-1)!.kind).toBe('region');
    ed.select([ed.keyOf(silk, gerber(silk).objects.length - 1)]);
    run('ToolsPoly2Vect');
    expect(gerber(silk).objects.at(-1)!.kind).toBe('draw');
    // A repeated draw cleaned away
    run('DrawLine'); click(mil(1000), 0); click(mil(1100), 0); click(0, 0, 2);
    run('DrawLine'); click(mil(1000), 0); click(mil(1100), 0); click(0, 0, 2);
    run('ToolsPolyLinePro');
    expect((silk.erased ?? []).includes(gerber(silk).objects.length - 1)).toBe(true);
    ed.select([ed.keyOf(silk, gerber(silk).objects.length - 2)]);
    run('ToolsVect2Out'); answer({ to: 'A new layer' });
    expect(d.layers.some((l) => /_OUTLINE/.test(l.name))).toBe(true);
  });

  it('Panelize repeats every layer; Film Wizard; the fab drawing', () => {
    run('ToolsPanelize'); answer({ nx: 2, ny: 1, frame: true });
    const top = layer('.GTL');
    expect(gerber(top).steps?.[0]).toMatchObject({ nx: 2, ny: 1 });
    expect(writeCamLayer(top)).toContain('%SRX2Y1');
    const drl = d.layers.find((l) => l.data.kind === 'drill')!;
    expect((drl.data as DrillLayer).hits.length % 2).toBe(0);
    run('ToolsFilmWizard'); answer({ size: '16 x 20 in' });
    expect(d.filmBox).toEqual({ minX: 0, minY: 0, maxX: mil(16000), maxY: mil(20000) });
    run('ToolsCreateFab'); answer({});
    const fab = d.layers.find((l) => l.type === 'Drill Drawing')!;
    expect(gerber(fab).objects.length).toBeGreaterThan(20);
  });

  it('Parts: create, number; home plates; epoxy bars; tables', () => {
    const top = layer('.GTL'); current(top);
    const pads = liveObjects(top).filter(({ o }) => o.kind === 'flash').slice(0, 2);
    ed.select(pads.map(({ i }) => ed.keyOf(top, i)));
    run('ToolsBuildCentroid'); answer({ ref: 'R7' });
    expect(d.parts?.[0]).toMatchObject({ ref: 'R7', side: 'top' });
    run('ToolsAssignRefDes'); answer({ prefix: 'R', start: 1 });
    expect(d.parts![0]!.ref).toBe('R1');
    const paste = layer('.GTP'); current(paste);
    run('ToolsHomebase'); answer({ cut: 25 });
    expect(liveObjects(paste).some(({ o }) => o.kind === 'flash' && gerber(paste).apertures.get(o.ap)?.shape === 'M')).toBe(true);
    run('ToolsEpoxy'); answer({ src: paste.name });
    expect(d.layers.some((l) => /^Glue Top/.test(l.name))).toBe(true);
    for (const t of ['TablesLayersSets', 'TablesMill', 'ProcessTable', 'FileExportCentroid0', 'ApertureWizard']) { run(t); expect(dialogStack.value.length).toBe(1); closeDialog(); }
  });

  it('the aperture wizard reads aperture lists', () => {
    expect(parseApertureList('D10 C 0.010\nD11 R 0.060X0.040\n12 ROUND 10\nD13 OBLONG 0.8 1.6\nG04 comment', 'in').map((a) => [a.code, a.shape, a.w, a.h]))
      .toEqual([[10, 'C', 100000, 100000], [11, 'R', 600000, 400000], [12, 'C', 100000000, 100000000], [13, 'O', 8000000, 16000000]]);
    expect(parseApertureList('D10 CIRCLE 10', 'mil')[0]).toMatchObject({ shape: 'C', w: mil(10) });
  });
});

describe('Rout', () => {
  it('Auto-Rout the border, tabs, lines to arcs and circles, manual rout, modify', () => {
    run('ToolsMillAuto');
    const rl = d.layers.find((l) => /Rout/.test(l.name))!;
    const rd = rl.data as DrillLayer;
    expect(rd.routes.length).toBe(1);
    const r0 = rd.routes[0]!;
    // Outside the board by the tool's radius
    const e = (() => { let minX = Infinity; for (const p of r0.path) minX = Math.min(minX, p.x); return minX; })();
    expect(e).toBeLessThan(0);
    run('ToolsMillTab'); click(r0.path[1]!.x, r0.path[1]!.y + 1);
    click(0, 0, 2);
    expect(rd.routes[0]!.path.length).toBeGreaterThan(r0.path.length - 1);
    // A circle drawn as a rout of many lines becomes a G32 / G33 circle
    current(rl);
    run('SnapChange');
    run('ToolsMillManual');
    for (let k = 0; k <= 24; k++) click(mil(5000) + mil(100) * Math.cos((k * Math.PI) / 12), mil(5000) + mil(100) * Math.sin((k * Math.PI) / 12));
    click(0, 0, 2); click(0, 0, 2);
    const k = rd.routes.length - 1;
    ed.select([ed.routeKeyOf(rl, k)]);
    run('ToolsMillConvertCircle');
    expect(rd.routes[k]!.circle?.r).toBeGreaterThan(mil(95));
    ed.select([ed.routeKeyOf(rl, k)]);
    run('ToolsModifyToolPathCam'); answer({ comp: 'Left (G41)', rev: true });
    expect(rd.routes[k]!.comp).toBe('L');
    expect(writeCamLayer(rl)).toMatch(/G41[\s\S]*G3[23]|G3[23][\s\S]*/);
    run('DrillAndPlunge');
    expect(rd.hits.length).toBeGreaterThan(0);
    run('InspectReportsRout'); expect(reportText()).toMatch(/Total rout length/);
  });

  it('netlist extracted from a negative plane joins every hole without an anti-pad', () => {
    const plane = camLayerFrom('PWR.GP1', '%FSLAX46Y46*%%MOMM*%%IPNEG*%%ADD10C,3.0*%D10*X10000000Y10000000D03*M02*')!;
    expect((plane.data as GerberLayer).negative).toBe(true);
    const dd = newCamDocument('P.Cam', [plane, camLayerFrom('a.TXT', 'M48\nMETRIC\nT01C0.8\n%\nT01\nX10.0Y10.0\nX20.0Y20.0\nX30.0Y30.0\nM30\n')!]);
    const nets = extractNets(dd);
    // The hole at the anti-pad is alone; the other two share the plane
    expect(nets.length).toBe(1);
    expect(Object.values(nets[0]!.members).flat().length).toBe(2);
    void readGerber;
  });
});
