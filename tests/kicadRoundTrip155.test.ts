import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { kicadPinNetName } from '../src/formats/kicad/netName';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { parseSexpr, kids, num, str, type SList } from '../src/formats/kicad/sexpr';
import { PCB, PRO, SCH } from './fixtures/kicadMini';

/**
 * R9, the KiCad round trip: a KiCad project in through the importer and out through the exporter
 * comes back with KiCad's own net names, though the board took the names its schematics compile to.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();

async function roundTrip() {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB) }]);
  const p = r.projects[0]!;
  const sch = p.documents.find((d) => d.name === 'mini.SchDoc')!;
  // Saved and opened again on the way, as a project would be
  const board = readPcbDoc(writePcbDoc(readPcbDoc(p.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc');
  return { board, out: exportKicad({ name: 'mini', sheets: [{ name: 'mini.SchDoc', doc: readSchDoc(sch.bytes, 'mini.SchDoc') }], board, hierarchyMode: 2 }) };
}
const td_ = (o: { files: { path: string; bytes: Uint8Array }[] }) => td.decode(o.files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes);
const boardNets = (text: string) => kids(parseSexpr(text), 'net').map((n) => str(n, 1)).filter((n) => n);

describe('KiCad round trip: net names (R9)', () => {
  it('the board keeps the compiled names in Konium, and KiCad\'s on the way back', async () => {
    const { board, out } = await roundTrip();
    expect(board.nets.map((n) => n.name)).toEqual(['MID', 'GND']);
    const pcb = td.decode(out.files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes);
    expect(boardNets(pcb)).toEqual(['/MID', 'GND']);
  });

  it('a net renamed in Konium goes out by its new name', async () => {
    const { board } = await roundTrip();
    board.nets[0]!.name = 'MIDDLE';
    const sch = readSchDoc((await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }])).projects[0]!.documents.find((d) => d.name === 'mini.SchDoc')!.bytes, 'mini.SchDoc');
    const out = exportKicad({ name: 'mini', sheets: [{ name: 'mini.SchDoc', doc: sch }], board, hierarchyMode: 2 });
    expect(boardNets(td.decode(out.files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes))).toEqual(['MIDDLE', 'GND']);
  });

  it('symbols and footprints keep their libraries\' names (R9)', async () => {
    const { out } = await roundTrip();
    const sch = parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('mini.kicad_sch'))!.bytes));
    const placed = kids(sch, 'symbol');
    expect(placed.map((x) => str(kids(x, 'lib_id')[0]!, 0))).toEqual(['Device:R', 'Device:R', 'power:GND']);
    expect(placed.slice(0, 2).map((x) => str(kids(x, 'property').find((p) => str(p, 0) === 'Footprint')!, 1))).toEqual(['Resistor_SMD:R_0603', 'Resistor_SMD:R_0603']);
    // The schematic's own copy of the symbol by that name
    expect(kids(kids(sch, 'lib_symbols')[0]!, 'symbol').map((x) => str(x, 0)).sort()).toEqual(['Device:R', 'power:GND']);
    const pcb = parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes));
    expect(kids(pcb, 'footprint').map((f) => str(f, 0)).slice(0, 2)).toEqual(['Resistor_SMD:R_0603', 'Resistor_SMD:R_0603']);
  });

  it('a global label goes back as a global label, its shape and angle kept', async () => {
    const sch = SCH.replace(/\)\s*$/, ' (global_label "SIG" (shape input) (at 150 100 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "bbbbbbbb-0000-0000-0000-000000000001")))');
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(sch) }]);
    const doc = readSchDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.SchDoc')!.bytes, 'mini.SchDoc');
    const out = exportKicad({ name: 'mini', sheets: [{ name: 'mini.SchDoc', doc }], hierarchyMode: 2 });
    const t = parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('mini.kicad_sch'))!.bytes));
    const g = kids(t, 'global_label');
    expect(g.map((x) => [str(x, 0), str(kids(x, 'shape')[0]!, 0), num(kids(x, 'at')[0]!, 0), num(kids(x, 'at')[0]!, 2)])).toEqual([['SIG', 'input', 150, 180]]);
  });

  it('a sheet used twice goes back as one file, each use\'s designator in its symbols\' instances', async () => {
    const U = (n: number) => `cccccccc-0000-0000-0000-00000000000${n}`;
    const font = '(effects (font (size 1.27 1.27)))';
    const sheet = (n: number, name: string, page: number) => `(sheet (at ${50 + n * 30} 50) (size 20 10) (uuid "${U(n)}")
      (property "Sheetname" "${name}" (at ${50 + n * 30} 49 0) ${font}) (property "Sheetfile" "ch.kicad_sch" (at ${50 + n * 30} 61 0) ${font})
      (instances (project "multi" (path "/${U(0)}" (page "${page}")))))`;
    const root = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "${U(0)}") (paper "A4") (lib_symbols) ${sheet(1, 'A', 2)} ${sheet(2, 'B', 3)} (sheet_instances (path "/" (page "1"))))`;
    const pin = (n: string, y: number, a: number) => `(pin passive line (at 0 ${y} ${a}) (length 1.27) (name "~" ${font}) (number "${n}" ${font}))`;
    const child = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "${U(3)}") (paper "A4")
      (lib_symbols (symbol "Device:R" (in_bom yes) (on_board yes) (property "Reference" "R" (at 0 0 0) ${font}) (property "Value" "R" (at 0 0 0) ${font})
        (symbol "R_0_1" (rectangle (start -1 -2.5) (end 1 2.5) (stroke (width 0.25) (type default)) (fill (type none)))) (symbol "R_1_1" ${pin('1', 3.81, 270)} ${pin('2', -3.81, 90)})))
      (symbol (lib_id "Device:R") (at 100 100 0) (unit 1) (in_bom yes) (on_board yes) (uuid "${U(4)}")
        (property "Reference" "R1" (at 102 100 0) ${font}) (property "Value" "10k" (at 104 100 0) ${font}) (property "Footprint" "Resistor_SMD:R_0603" (at 100 100 0) (effects (font (size 1.27 1.27)) hide))
        (instances (project "multi" (path "/${U(0)}/${U(1)}" (reference "R1") (unit 1)) (path "/${U(0)}/${U(2)}" (reference "R2") (unit 1))))))`;
    const r = await importKicad([{ path: 'multi/multi.kicad_pro', bytes: enc('{}') }, { path: 'multi/multi.kicad_sch', bytes: enc(root) }, { path: 'multi/ch.kicad_sch', bytes: enc(child) }]);
    const docs = r.projects[0]!.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
    // In Konium: a sheet per use, each with its own designator
    expect(docs.map((d) => d.name).sort()).toEqual(['ch.SchDoc', 'ch_2.SchDoc', 'multi.SchDoc']);
    const out = exportKicad({ name: 'multi', sheets: docs, hierarchyMode: 2 });
    const files = out.files.filter((f) => f.path.endsWith('.kicad_sch'));
    expect(files.map((f) => f.path.replace(/^.*\//, '')).sort()).toEqual(['ch.kicad_sch', 'multi.kicad_sch']);
    const ch = parseSexpr(td.decode(files.find((f) => f.path.endsWith('ch.kicad_sch'))!.bytes));
    const sym = kids(ch, 'symbol')[0]!;
    expect(kids(kids(kids(sym, 'instances')[0]!, 'project')[0]!, 'path').map((p) => str(kids(p, 'reference')[0]!, 0)).sort()).toEqual(['R1', 'R2']);
    const top = parseSexpr(td.decode(files.find((f) => f.path.endsWith('multi.kicad_sch'))!.bytes));
    expect(kids(top, 'sheet').map((x) => str(kids(x, 'property').find((p) => str(p, 0) === 'Sheetfile')!, 1))).toEqual(['ch.kicad_sch', 'ch.kicad_sch']);
  });

  it('a teardrop goes back as KiCad\'s teardrop zone: its outline, type, priority and fill', async () => {
    const td = ` (zone (net 1) (net_name "/MID") (layer "F.Cu") (uuid "dddddddd-0000-0000-0000-000000000001") (name "$teardrop_padvia$") (hatch full 0.1) (priority 30001)
      (attr (teardrop (type padvia))) (connect_pads yes (clearance 0)) (min_thickness 0.0254) (filled_areas_thickness no) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))
      (polygon (pts (xy 120.8 79.8) (xy 121.6 79.9) (xy 121.6 80.1) (xy 120.8 80.2)))
      (filled_polygon (layer "F.Cu") (pts (xy 120.81 79.81) (xy 121.59 79.91) (xy 121.59 80.09) (xy 120.81 80.19))))`;
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB.replace(/\)\s*$/, `${td})`)) }]);
    const p = r.projects[0]!;
    const board = readPcbDoc(p.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc');
    expect(board.prims.filter((x) => x.kind === 'region' && x.kicadTeardrop).length).toBe(1);
    const out = exportKicad({ name: 'mini', sheets: [], board });
    const pcb = parseSexpr(td_(out));
    const z = kids(pcb, 'zone').filter((x) => kids(x, 'attr').length);
    expect(z.map((x) => [str(kids(x, 'name')[0]!, 0), num(kids(x, 'priority')[0]!, 0), kids(kids(x, 'polygon')[0]!, 'pts')[0]!.items.length, kids(x, 'filled_polygon').length])).toEqual([['$teardrop_padvia$', 30001, 4, 1]]);
  });

  it('a board from KiCad keeps its layers: its Edge.Cuts drawing back on Edge.Cuts, once', async () => {
    const { out } = await roundTrip();
    const pcb = parseSexpr(td_(out));
    const gr = pcb.items.filter((x): x is SList => typeof x === 'object' && /^gr_/.test(x.k));
    const layers = gr.map((g) => str(kids(g, 'layer')[0]!, 0));
    // The fixture's rectangle and circle, as KiCad had them (kept whole: kept.ts), where they were; nothing of it on a user layer
    expect(gr.filter((g) => str(kids(g, 'layer')[0]!, 0) === 'Edge.Cuts').map((g) => g.k)).toEqual(['gr_rect', 'gr_circle']);
    const rect = gr.find((g) => g.k === 'gr_rect')!, circle = gr.find((g) => g.k === 'gr_circle')!;
    const pt = (g: SList, k: string) => [num(kids(g, k)[0]!, 0), num(kids(g, k)[0]!, 1)];
    const [sx, sy] = pt(rect, 'start'), [ex, ey] = pt(rect, 'end'), [cx, cy] = pt(circle, 'center');
    // 40 by 25 mm, the circle 32 and 18 mm in from its corner, as in the fixture
    expect([ex! - sx!, ey! - sy!, cx! - sx!, cy! - sy!].map((v) => Math.round(v * 1000) / 1000)).toEqual([40, 25, 32, 18]);
    expect(layers.filter((l) => /^User\./.test(l!))).toEqual([]);
  });

  it('KiCad\'s names for nets a pin names', () => {
    expect(kicadPinNetName('R1', '~', '2', false)).toBe('Net-(R1-Pad2)');
    expect(kicadPinNetName('R1', '2', '2', false)).toBe('Net-(R1-Pad2)');
    expect(kicadPinNetName('R1', '', '2', false)).toBe('Net-(R1-Pad2)');
    expect(kicadPinNetName('U1', 'SDA', '5', false)).toBe('Net-(U1-SDA)');
    expect(kicadPinNetName('U1', 'GND', '7', true)).toBe('Net-(U1-GND-Pad7)');
    expect(kicadPinNetName('U1', 'A/B', '3', false)).toBe('Net-(U1-A{slash}B)');
  });
});
