import { describe, expect, it } from 'vitest';
import { parseSexpr, kids, str, val } from '../src/formats/kicad/sexpr';
import { arc3, convertBoard, convertFootprintLibrary, netNamesFrom, plainText, ring } from '../src/formats/kicad/board';
import { convertSchematics } from '../src/formats/kicad/schematic';
import { importKicad, kicadContents, projectSettings } from '../src/formats/kicad/project';
import { decodePrim, readPcbDoc } from '../src/formats/altium/pcbdoc';
import { storageFor } from '../src/formats/altium/pcblib';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { readPrjPcb, iniGet } from '../src/formats/altium/prjpcb';
import { openPcbLib } from '../src/model/pcbLib';
import { compileProject } from '../src/model/compile';
import { planPcbUpdate } from '../src/model/pcbEco';
import { connections } from '../src/model/drc';
import { L } from '../src/model/layers';
import { mm } from '../src/core/units';
import { buildMenus } from '../src/app/menus';

import { PCB, PRO, SCH } from './fixtures/kicadMini';

const enc = (s: string) => new TextEncoder().encode(s);

describe('KiCad import: reading', () => {
  it('s-expressions: lists, numbers, quoted strings with escapes, skipped keywords', () => {
    const t = parseSexpr('(a (b 1 -2.5e1 "x \\"y\\" (z)") (uuid "q") (c d))', new Set(['uuid']));
    expect(t.k).toBe('a');
    expect(kids(t, 'b')[0]!.items).toEqual([1, -25, 'x "y" (z)']);
    expect(kids(t, 'uuid')).toHaveLength(0);
    expect(val(t, 'c')).toBe('d');
  });
  it('arcs through three points, outlines with arcs, text markup', () => {
    const a = arc3({ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 })!;
    expect(a.c).toEqual({ x: 0, y: 0 });
    expect(a.r).toBe(10);
    expect([a.start, a.end]).toEqual([0, 180]);
    const r = ring(parseSexpr('(polygon (pts (xy 0 0) (arc (start 1 0) (mid 1.7071 0.7071) (end 2 1.7)) (xy 2 3)))'), (p) => ({ x: Math.round(p.x * 1000), y: Math.round(-p.y * 1000) }));
    expect(r.map((v) => !!v.arc)).toEqual([false, true, false, false]);
    expect(plainText('I^{2}C ~{RST} V_{CC}')).toBe('I2C RST VCC');
  });
  it('project settings: net classes by name and pattern, text variables', () => {
    const s = projectSettings(PRO);
    expect(s.rules.clearance).toBe(0.2);
    expect(s.rules.classes?.find((c) => c.name === 'Power')?.patterns).toEqual(['GN?']);
    expect(s.variables).toEqual([{ name: 'REV', value: 'B' }]);
  });
  it('lists projects, top sheets (not the sheets they include) and loose libraries', () => {
    const c = kicadContents([
      { path: 'a/a.kicad_pro' }, { path: 'a/a.kicad_sch' }, { path: 'a/lib/x.kicad_sym' },
      { path: 'b/top.kicad_sch', bytes: enc('(kicad_sch (sheet (property "Sheetfile" "sub/child.kicad_sch")))') }, { path: 'b/sub/child.kicad_sch', bytes: enc('(kicad_sch)') },
      { path: 'libs/y.kicad_sym' }, { path: 'libs/F.pretty/R.kicad_mod' },
    ]);
    expect(c.projects).toEqual(['a/a.kicad_pro']);
    expect(c.schematics).toEqual(['b/top.kicad_sch']);
    expect(c.symbolLibs).toEqual(['libs/y.kicad_sym']);
    expect(c.footprintLibs).toEqual(['libs/F.pretty']);
  });
});

describe('KiCad import: the board', () => {
  const r = convertBoard(PCB, { name: 'mini.PcbDoc', rules: projectSettings(PRO).rules });
  const doc = readPcbDoc(r.bytes, 'mini.PcbDoc');
  it('components, pads (rounded, slotted, unplated), tracks, arcs, vias and the inner layer', () => {
    expect(doc.components.map((c) => c.designator)).toEqual(['R1', 'R2', 'H1']);
    const pads = doc.prims.filter((p) => p.kind === 'pad');
    expect(pads).toHaveLength(5);
    expect(doc.board.copperStack).toEqual([L.TOP, L.MID1, L.BOTTOM]);
    expect(doc.prims.some((p) => p.kind === 'track' && p.layer === L.MID1)).toBe(true);
    expect(doc.prims.filter((p) => p.kind === 'via')).toHaveLength(1);
    expect(doc.prims.some((p) => p.kind === 'arc' && p.layer === L.TOP && p.net === -1 + 0x10000)).toBe(true);
    // KiCad's lone-pin net is no net
    expect(doc.nets.map((n) => n.name)).toEqual(['/MID', 'GND']);
    // Bottom footprint: on the bottom at KiCad's angle (both mirror the library top to bottom)
    expect(doc.components[1]!.bag.get('LAYER')).toBe('BOTTOM');
    expect(Number(doc.components[1]!.bag.get('ROTATION'))).toBeCloseTo(0);
    // Board only, out of the BOM: Graphical
    expect(doc.components[2]!.bag.int('COMPONENTKIND')).toBe(2);
  });
  it('the board shape from Edge.Cuts, a circle a cut-out; the pour, its cut-out and KiCad fill; the keep-out', () => {
    expect(doc.board.vertices).toHaveLength(4);
    const w = Math.max(...doc.board.vertices.map((v) => v.p.x)) - Math.min(...doc.board.vertices.map((v) => v.p.x));
    expect(w).toBeCloseTo(mm(40), -2);
    expect(doc.prims.filter((p) => p.kind === 'region' && p.boardCutout)).toHaveLength(1);
    expect(doc.polygons).toHaveLength(1);
    expect(doc.prims.filter((p) => p.kind === 'region' && p.regionKind === 1)).toHaveLength(1);
    expect(doc.prims.filter((p) => p.kind === 'region' && 'polygon' in p && p.polygon === 0)).toHaveLength(1);
    expect(doc.prims.filter((p) => p.kind === 'region' && p.keepout)).toHaveLength(2);
    expect(connections(doc)).toHaveLength(0);
  });
  it('a two-line text is two texts; the linked 3D model is listed by its STEP name', () => {
    expect(doc.prims.filter((p) => p.kind === 'text' && (p.text === 'MINI' || p.text === 'BOARD'))).toHaveLength(2);
    expect(r.footprints.get('Resistor_SMD')?.map((f) => f.name)).toEqual(['R_0603']);
    expect(doc.prims.filter((p) => p.kind === 'body')).toHaveLength(2);
  });
  it('rules and net classes from the project', () => {
    const gap = doc.rules.find((x) => x.bag.get('RULEKIND') === 'Clearance' && x.bag.get('NAME') === 'Clearance');
    expect(gap?.bag.get('GAP')).toBe('0.2mm');
    expect(doc.classes.find((c) => c.name === 'Power')?.members).toEqual(['GND']);
    expect(doc.rules.some((x) => x.bag.get('NAME') === 'Width_Power' && x.bag.get('SCOPE1EXPRESSION') === "InNetClass('Power')")).toBe(true);
  });
  it('a bottom footprint goes into the library flipped back to the top', () => {
    const bottomOnly = PCB.replace(/\(footprint "Resistor_SMD:R_0603" \(layer "F\.Cu"\)[\s\S]*?\n \(footprint "Resistor_SMD/, '(footprint "Resistor_SMD');
    const f = convertBoard(bottomOnly, { name: 'b.PcbDoc' }).footprints.get('Resistor_SMD')![0]!;
    const lib = openPcbLib(convertFootprintLibrary([], 'x').bytes, 'x.PcbLib');
    expect(lib.footprints).toHaveLength(0);
    // Its silk line (above the pads) is back on the Top Overlay, above them; its pads on the Top Layer
    const prims = f.records.map((x, i) => decodePrim(storageFor(x.tag), x, i, new Map())!);
    const silk = prims.find((x) => x.kind === 'track' && x.layer === L.TOP_OVERLAY);
    expect(silk && silk.kind === 'track' && silk.a.y).toBeGreaterThan(0);
    expect(prims.filter((x) => x.kind === 'pad').map((x) => x.layer)).toEqual([L.TOP, L.TOP]);
  });
});

describe('KiCad import: a project', () => {
  it('schematic, board, libraries and project; nets named as compiled, so Update PCB has nothing to do', async () => {
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB) }]);
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    const p = r.projects[0]!;
    expect(p.documents.map((d) => d.name).sort()).toEqual(['Device.SchLib', 'MountingHole.PcbLib', 'Resistor_SMD.PcbLib', 'mini.PcbDoc', 'mini.SchDoc']);
    const prj = readPrjPcb(p.prj.bytes, p.prj.name);
    expect(prj.documents.length).toBe(5);
    expect(iniGet(prj, 'Design', 'HierarchyMode')).toBe('2');
    const sch = readSchDoc(p.documents.find((d) => d.name === 'mini.SchDoc')!.bytes, 'mini.SchDoc');
    const compiled = compileProject([{ name: 'mini.SchDoc', doc: sch }], { scope: 2 });
    expect(compiled.nets.map((n) => n.name).sort()).toEqual(['GND', 'MID']);
    const pcb = readPcbDoc(p.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc');
    expect(pcb.nets.map((n) => n.name)).toEqual(['MID', 'GND']);
    expect(planPcbUpdate(compiled, pcb, () => undefined).map((x) => `${x.group}: ${x.object}`)).toEqual([]);
    // The schematic's parts and the board's components share their unique IDs
    const uid = (s: string | undefined) => (s ?? '').replace(/^\\/, '');
    expect(compiled.components.map((c) => c.uniqueId).sort()).toEqual(pcb.components.slice(0, 2).map((c) => uid(c.bag.get('SOURCEUNIQUEID'))).sort());
  });
  it('net names follow the most pins: one name per net', () => {
    const tree = parseSexpr(PCB);
    const m = netNamesFrom(tree, [{ name: 'MID', pins: [{ designator: 'R1', pin: '2' }, { designator: 'R2', pin: '1' }] }, { name: 'GND', pins: [{ designator: 'R2', pin: '2' }] }]);
    expect([...m]).toEqual([['/MID', 'MID']]);
    expect(str(kids(tree, 'net')[1], 1)).toBe('/MID');
  });
  it('File menus list Import Wizard after Smart PDF', () => {
    const file = buildMenus().find((m) => m.scopes[0] === 'sch' && m.label === 'File')!;
    const labels = file.children!.map((c) => c.label);
    expect(labels.indexOf('Import Wizard')).toBe(labels.indexOf('Smart PDF...') + 1);
  });
});

describe('KiCad import: schematics', () => {
  it('a sheet: components with their footprints, the power port, the label', () => {
    const [s] = convertSchematics(new Map([['mini.kicad_sch', SCH]]), 'mini.kicad_sch', 'mini');
    const doc = readSchDoc(s!.bytes, s!.name);
    const bags = doc.records.map((x) => x.bag).filter((b): b is NonNullable<typeof b> => !!b);
    expect(bags.filter((b) => b.get('RECORD') === '1')).toHaveLength(2);
    expect(bags.some((b) => b.get('RECORD') === '17' && b.get('TEXT') === 'GND')).toBe(true);
    expect(bags.some((b) => b.get('RECORD') === '25' && b.get('TEXT') === 'MID')).toBe(true);
    expect(bags.filter((b) => b.get('MODELDATAFILE0') === 'Resistor_SMD.PcbLib')).toHaveLength(2);
  });
});
