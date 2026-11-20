import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { parseSexpr, kid, kids, num, str, type SList } from '../src/formats/kicad/sexpr';
import { PCB, PRO, SCH } from './fixtures/kicadMini';

/**
 * R9, settings Konium makes nothing of, kept for the way back: a pad's pin name and type and its
 * drill offset, a via's free flag, a footprint's tags, sheet and 3D model as KiCad names them, a
 * zone's own settings while the pour is unchanged; a symbol's fields as placed, its DNP; a global
 * label's Intersheetrefs; a sheet symbol's exact size.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
const font = '(effects (font (size 1.27 1.27)))';

async function board(pcb: string) {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(pcb) }]);
  const doc = readPcbDoc(writePcbDoc(readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc');
  return parseSexpr(td.decode(exportKicad({ name: 'mini', sheets: [], board: doc }).files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes));
}
const fpOf = (pcb: SList, ref: string) => kids(pcb, 'footprint').find((f) => kids(f, 'property').some((p) => str(p, 0) === 'Reference' && str(p, 1) === ref))!;

describe('KiCad round trip: settings kept (R9)', () => {
  it('a pad\'s pin name and type, a drill offset; a via\'s free flag; a footprint\'s tags, sheet and model', async () => {
    const pcb = PCB
      .replace('(pad "2" smd roundrect (at 0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net 1 "/MID"))',
        '(pad "2" smd roundrect (at 0.8 0) (size 0.8 0.9) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25) (net 1 "/MID") (pinfunction "OUT") (pintype "passive") (solder_mask_margin 0.05))')
      .replace('(via (at 122.5 80) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))', '(via (at 122.5 80) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (free yes) (net 1))')
      .replace('(footprint "MountingHole:Slot" (layer "F.Cu") (at 105 90)', '(footprint "MountingHole:Slot" (layer "F.Cu") (at 105 90) (tags "slot hole") (sheetname "/") (sheetfile "mini.kicad_sch")')
      .replace('(pad "" np_thru_hole oval (at 0 0) (size 1.2 2.4) (drill oval 1.2 2.4) (layers "*.Cu" "*.Mask")))',
        '(pad "" np_thru_hole oval (at 0 0) (size 1.2 2.4) (drill oval 1.2 2.4) (layers "*.Cu" "*.Mask")) (model "${KICAD8_3DMODEL_DIR}/Slot.3dshapes/Slot.wrl" hide (offset (xyz 0 0 1))))');
    const t = await board(pcb);
    const r1 = fpOf(t, 'R1');
    const p2 = kids(r1, 'pad').find((p) => str(p, 0) === '2')!;
    expect([str(kid(p2, 'pinfunction'), 0), str(kid(p2, 'pintype'), 0), num(kid(p2, 'solder_mask_margin'), 0)]).toEqual(['OUT', 'passive', 0.05]);
    const v = kids(t, 'via')[0]!;
    expect(str(kid(v, 'free'), 0)).toBe('yes');
    const h1 = fpOf(t, 'H1');
    expect([str(kid(h1, 'tags'), 0), str(kid(h1, 'sheetname'), 0), str(kid(h1, 'sheetfile'), 0)]).toEqual(['slot hole', '/', 'mini.kicad_sch']);
    // A hidden model Konium makes no body of: back as KiCad named it
    expect(kids(h1, 'model').map((m) => str(m, 0))).toEqual(['${KICAD8_3DMODEL_DIR}/Slot.3dshapes/Slot.wrl']);
    // Written in quotes where KiCad has them
    const text = td.decode(exportKicad({ name: 'mini', sheets: [], board: readPcbDoc(writePcbDoc(readPcbDoc((await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_pcb', bytes: enc(pcb) }])).projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc') }).files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes);
    expect(text).toContain('(pinfunction "OUT")');
    expect(text).toContain('(tags "slot hole")');
  });

  it('a zone\'s own settings (no name, its priority, connection, minimum width, thermal settings) while the pour is unchanged', async () => {
    const pcb = PCB.replace('(zone (net 2) (net_name "GND") (layer "B.Cu") (hatch edge 0.5) (priority 1) (connect_pads (clearance 0.2)) (min_thickness 0.25) (fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))',
      '(zone (net 2) (net_name "GND") (layer "B.Cu") (hatch edge 0.5) (priority 3) (connect_pads yes (clearance 0.15)) (min_thickness 0.2) (fill yes (thermal_gap 0.4) (thermal_bridge_width 0.3) (island_removal_mode 2) (island_area_min 5))');
    const t = await board(pcb);
    const z = kids(t, 'zone').find((x) => !kid(x, 'keepout'))!;
    expect(kid(z, 'name')).toBeUndefined();
    expect([num(kid(z, 'priority'), 0), str(kid(z, 'connect_pads'), 0), num(kid(kid(z, 'connect_pads'), 'clearance'), 0), num(kid(z, 'min_thickness'), 0)]).toEqual([3, 'yes', 0.15, 0.2]);
    const fill = kid(z, 'fill')!;
    expect([num(kid(fill, 'thermal_gap'), 0), num(kid(fill, 'thermal_bridge_width'), 0), num(kid(fill, 'island_removal_mode'), 0), num(kid(fill, 'island_area_min'), 0)]).toEqual([0.4, 0.3, 2, 5]);
  });

  it('a symbol\'s fields as placed (an empty one too), its DNP; a global label\'s Intersheetrefs; a sheet symbol\'s exact size', async () => {
    const sch = SCH.replace('(property "Footprint" "Resistor_SMD:R_0603" (at 100 100 0) (effects (font (size 1.27 1.27)) hide))\n    (instances (project "mini" (path "/11111111-0000-0000-0000-000000000001" (reference "R1")',
      '(property "Footprint" "Resistor_SMD:R_0603" (at 97.5 101.5 90) (effects (font (size 1.27 1.27)) hide)) (property "MPN" "" (at 100 104 0) (effects (font (size 1.27 1.27)) hide)) (dnp yes)\n    (instances (project "mini" (path "/11111111-0000-0000-0000-000000000001" (reference "R1")')
      .replace(/\)\s*$/, ` (global_label "SIG" (shape input) (at 150 100 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "cccccccc-0000-0000-0000-000000000001")
        (property "Intersheetrefs" "\${INTERSHEET_REFS}" (at 140 100 0) (effects (font (size 1.27 1.27)) hide)))
        (sheet (at 60 50) (size 25.4 12.065) (stroke (width 0) (type solid)) (fill (color 255 255 255 1)) (uuid "cccccccc-0000-0000-0000-000000000002")
          (property "Sheetname" "Sub" (at 60 49 0) ${font}) (property "Sheetfile" "sub.kicad_sch" (at 60 63 0) ${font})))`);
    expect(sch).toContain('(dnp yes)');
    const sub = '(kicad_sch (version 20231120) (generator "eeschema") (uuid "dddddddd-0000-0000-0000-000000000001") (paper "A4") (lib_symbols))';
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(sch) }, { path: 'mini/sub.kicad_sch', bytes: enc(sub) }]);
    const docs = r.projects[0]!.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
    const out = exportKicad({ name: 'mini', sheets: docs, hierarchyMode: 2 });
    const t = parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('mini.kicad_sch'))!.bytes));
    const r1 = kids(t, 'symbol').find((x) => kids(x, 'property').some((p) => str(p, 0) === 'Reference' && str(p, 1) === 'R1'))!;
    const fp = kids(r1, 'property').find((p) => str(p, 0) === 'Footprint')!;
    expect([num(kid(fp, 'at'), 0), num(kid(fp, 'at'), 1), num(kid(fp, 'at'), 2)]).toEqual([97.5, 101.5, 90]);
    expect(kids(r1, 'property').some((p) => str(p, 0) === 'MPN')).toBe(true);
    expect(str(kid(r1, 'dnp'), 0)).toBe('yes');
    const g = kids(t, 'global_label').find((x) => str(x, 0) === 'SIG')!;
    expect(kids(g, 'property').map((p) => str(p, 0))).toEqual(['Intersheetrefs']);
    // (its name once: the kept settings are its lists, not its name again)
    expect(g.items.filter((x) => typeof x === 'string')).toEqual(['SIG']);
    expect(kids(t, 'label').map((l) => l.items.filter((x) => typeof x === 'string').length)).toEqual([1]);
    const sh = kids(t, 'sheet')[0]!;
    expect([num(kid(sh, 'size'), 0), num(kid(sh, 'size'), 1)]).toEqual([25.4, 12.065]);
    expect(kid(kid(sh, 'fill'), 'color')?.items).toEqual([255, 255, 255, 1]);
  });
});
