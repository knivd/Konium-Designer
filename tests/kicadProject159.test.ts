import { describe, expect, it } from 'vitest';
import { importKicad, keptProjectFiles } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { iniGet, projectParameters, readPrjPcb } from '../src/formats/altium/prjpcb';
import { parseSexpr, kid, kids, str } from '../src/formats/kicad/sexpr';
import { PCB, ROOT, SCH } from './fixtures/kicadMini';

/**
 * R9, a project's settings both ways: KiCad's .kicad_pro kept whole (ERC, schematic and board
 * defaults Konium makes nothing of), Konium's where they changed (a net class's clearance, its other
 * settings KiCad's); the custom rules and local settings as they were. KiCad's uuids kept: the
 * board's objects', a footprint's pads' and fields'; the schematics' (a file's, a symbol's and its
 * pins', a wire's, a label's). The schematics' library symbols and power symbols as KiCad had them.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
const PRO = JSON.stringify({
  board: { design_settings: { defaults: { silk_line_width: 0.12, apply_defaults_to_fp_text: false }, rules: { min_clearance: 0.15, min_track_width: 0.15, min_via_diameter: 0.5, min_through_hole_diameter: 0.3, min_hole_to_hole: 0.25 } } },
  erc: { rule_severities: { pin_not_connected: 'warning', power_pin_not_driven: 'ignore' } },
  schematic: { drawing: { default_line_thickness: 6, label_size_ratio: 0.3 } },
  meta: { filename: 'mini.kicad_pro', version: 1 },
  net_settings: { classes: [{ name: 'Default', clearance: 0.2, track_width: 0.25, via_diameter: 0.6, via_drill: 0.3, diff_pair_width: 0.2 }, { name: 'Power', clearance: 0.3, track_width: 0.5, via_diameter: 0.8, via_drill: 0.4, diff_pair_width: 0.11, pcb_color: 'rgb(255, 0, 0)' }],
    netclass_patterns: [{ netclass: 'Power', pattern: 'GN?' }], meta: { version: 3 } },
  text_variables: { REV: 'B' },
});
const DRU = '(version 1)\n(rule "HV"\n  (constraint clearance (min 1.5mm))\n  (condition "A.NetClass == \'HV\'"))\n';
const PRL = '{ "board": { "active_layer": 0 } }\n';

async function project(edit?: (board: ReturnType<typeof readPcbDoc>) => void) {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB) },
    { path: 'mini/mini.kicad_dru', bytes: enc(DRU) }, { path: 'mini/mini.kicad_prl', bytes: enc(PRL) }]);
  const p = r.projects[0]!;
  const prj = readPrjPcb(p.prj.bytes, p.prj.name);
  const board = readPcbDoc(p.documents.find((d) => /\.pcbdoc$/i.test(d.name))!.bytes, 'mini.PcbDoc');
  edit?.(board);
  const sheets = p.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
  const out = exportKicad({ name: 'mini', sheets, board, hierarchyMode: 2, variables: projectParameters(prj), kicad: keptProjectFiles((k) => iniGet(prj, 'KiCad', k)) });
  const file = (ext: string) => td.decode(out.files.find((f) => f.path.endsWith(ext))!.bytes);
  return { file, has: (ext: string) => out.files.some((f) => f.path.endsWith(ext)) };
}

describe('KiCad round trip: the project (R9)', () => {
  it('its settings as KiCad had them; its custom rules and local settings as they were', async () => {
    const { file } = await project();
    const j = JSON.parse(file('.kicad_pro'));
    expect(j.erc.rule_severities).toEqual({ pin_not_connected: 'warning', power_pin_not_driven: 'ignore' });
    expect(j.schematic.drawing.label_size_ratio).toBe(0.3);
    expect(j.board.design_settings.defaults.silk_line_width).toBe(0.12);
    expect(j.board.design_settings.rules.min_clearance).toBe(0.15);
    expect(j.net_settings.netclass_patterns).toEqual([{ netclass: 'Power', pattern: 'GN?' }]);
    expect(j.net_settings.classes[1]).toMatchObject({ name: 'Power', clearance: 0.3, diff_pair_width: 0.11, pcb_color: 'rgb(255, 0, 0)' });
    expect(j.text_variables).toEqual({ REV: 'B' });
    expect(file('.kicad_dru')).toBe(DRU);
    expect(file('.kicad_prl')).toBe(PRL);
  });

  it('a net class\'s clearance changed in Konium: Konium\'s, the class\'s other settings KiCad\'s', async () => {
    const { file } = await project((b) => {
      const r = b.rules.find((x) => x.bag.get('NAME') === 'Clearance_Power')!;
      r.bag.set('GAP', '0.45mm');
    });
    const j = JSON.parse(file('.kicad_pro'));
    expect(j.net_settings.classes[1]).toMatchObject({ name: 'Power', clearance: 0.45, diff_pair_width: 0.11 });
    expect(j.erc.rule_severities.power_pin_not_driven).toBe('ignore');
  });

  it('the board\'s uuids: a track\'s, a via\'s, a footprint\'s, its pads\' and fields\'', async () => {
    const pcb = PCB.replace('(segment (start 120.8 80) (end 122.5 80) (width 0.25) (layer "F.Cu") (net 1))', '(segment (start 120.8 80) (end 122.5 80) (width 0.25) (layer "F.Cu") (net 1) (uuid "eeeeeeee-1111-0000-0000-000000000001"))')
      .replace('(via (at 122.5 80) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))', '(via (at 122.5 80) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1) (tstamp "eeeeeeee-1111-0000-0000-000000000002"))')
      .replace('(footprint "MountingHole:Slot" (layer "F.Cu") (at 105 90)', '(footprint "MountingHole:Slot" (layer "F.Cu") (uuid "eeeeeeee-1111-0000-0000-000000000003") (at 105 90)')
      .replace('(pad "" np_thru_hole oval (at 0 0) (size 1.2 2.4) (drill oval 1.2 2.4) (layers "*.Cu" "*.Mask"))', '(pad "" np_thru_hole oval (at 0 0) (size 1.2 2.4) (drill oval 1.2 2.4) (layers "*.Cu" "*.Mask") (uuid "eeeeeeee-1111-0000-0000-000000000004"))')
      .replace('(property "Value" "Slot" (at 0 2 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))', '(property "Value" "Slot" (at 0 2 0) (layer "F.Fab") (uuid "eeeeeeee-1111-0000-0000-000000000005") (effects (font (size 1 1) (thickness 0.15))))');
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_pcb', bytes: enc(pcb) }]);
    const board = readPcbDoc(r.projects[0]!.documents.find((d) => /\.pcbdoc$/i.test(d.name))!.bytes, 'mini.PcbDoc');
    const text = td.decode(exportKicad({ name: 'mini', sheets: [], board }).files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes);
    for (let i = 1; i <= 5; i++) expect(text).toContain(`(uuid "eeeeeeee-1111-0000-0000-00000000000${i}")`);
  });

  it('the schematic\'s library symbols and power symbols as KiCad had them while the parts are unchanged', async () => {
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }]);
    const sheets = r.projects[0]!.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
    const t = parseSexpr(td.decode(exportKicad({ name: 'mini', sheets, hierarchyMode: 2 }).files.find((f) => f.path.endsWith('mini.kicad_sch'))!.bytes));
    const src = parseSexpr(SCH);
    const lib = (x: typeof t) => new Map(kids(kid(x, 'lib_symbols'), 'symbol').map((y) => [str(y, 0), JSON.stringify(y.items.slice(1))]));
    expect(lib(t)).toEqual(lib(src));
    // The GND symbol: KiCad's lib id, its fields where they were, its reference
    const gnd = kids(t, 'symbol').find((x) => str(kid(x, 'lib_id'), 0) === 'power:GND')!;
    expect(kids(gnd, 'property').map((p) => [str(p, 0), str(p, 1)])).toEqual([['Reference', '#PWR01'], ['Value', 'GND']]);
    expect(kid(kids(gnd, 'property')[1], 'at')?.items).toEqual([100, 118, 0]);
  });

  it('the schematic\'s uuids: the file\'s, a symbol\'s and its pins\', a wire\'s, a label\'s', async () => {
    const sch = SCH.replace('(property "Footprint" "Resistor_SMD:R_0603" (at 100 100 0) (effects (font (size 1.27 1.27)) hide))',
      '(property "Footprint" "Resistor_SMD:R_0603" (at 100 100 0) (effects (font (size 1.27 1.27)) hide)) (pin "1" (uuid "dddddddd-0000-0000-0000-000000000011")) (pin "2" (uuid "dddddddd-0000-0000-0000-000000000012"))');
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(sch) }]);
    const sheets = r.projects[0]!.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
    const t = parseSexpr(td.decode(exportKicad({ name: 'mini', sheets, hierarchyMode: 2 }).files.find((f) => f.path.endsWith('mini.kicad_sch'))!.bytes));
    expect(str(kid(t, 'uuid'), 0)).toBe(ROOT);
    expect(str(kid(kids(t, 'wire')[0], 'uuid'), 0)).toBe('bbbbbbbb-0000-0000-0000-000000000001');
    expect(str(kid(kids(t, 'label')[0], 'uuid'), 0)).toBe('bbbbbbbb-0000-0000-0000-000000000002');
    const r1 = kids(t, 'symbol').find((x) => kids(x, 'property').some((p) => str(p, 0) === 'Reference' && str(p, 1) === 'R1'))!;
    expect(str(kid(r1, 'uuid'), 0)).toBe('aaaaaaaa-0000-0000-0000-000000000001');
    expect(kids(r1, 'pin').map((p) => [str(p, 0), str(kid(p, 'uuid'), 0)])).toEqual([['1', 'dddddddd-0000-0000-0000-000000000011'], ['2', 'dddddddd-0000-0000-0000-000000000012']]);
    // (its instance's path from the root's uuid)
    expect(str(kid(kid(kid(r1, 'instances'), 'project'), 'path'), 0)).toBe(`/${ROOT}`);
  });
});
