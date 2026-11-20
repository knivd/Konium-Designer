import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { moveComponent } from '../src/model/pcbEdit';
import { parseSexpr, kid, kids, num, str, type SList } from '../src/formats/kicad/sexpr';
import type { PcbDocument } from '../src/model/pcb';
import { PCB, PRO, SCH } from './fixtures/kicadMini';

/**
 * R9, a footprint's things KiCad keeps in the board's places: its rule area as the part's keep-out
 * (and in the footprint again), its dimension and its group kept with the part, moved and turned as
 * the part is; KiCad's attributes where Konium's kind writes none. A schematic's last few: a label's
 * stroke thickness and exact size, a tri-state hierarchical label, a text box drawn from its other corner, an empty
 * datasheet field where it was, a symbol in the BOM but not on the board.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
const font = '(effects (font (size 1.27 1.27)))';
const U = (n: number) => `eeeeeeee-0000-0000-0000-00000000000${n}`;
const H1_ITEMS = `
   (fp_line (start -1 -1) (end 1 -1) (stroke (width 0.1) (type solid)) (layer "F.Fab") (uuid "${U(1)}"))
   (fp_line (start -1 1) (end 1 1) (stroke (width 0.1) (type solid)) (layer "F.Fab") (uuid "${U(2)}"))
   (group "" (uuid "${U(3)}") (members "${U(1)}" "${U(2)}"))
   (zone (net 0) (net_name "") (layer "F.Cu") (uuid "${U(4)}") (hatch edge 0.5) (connect_pads (clearance 0)) (min_thickness 0.25)
     (keepout (tracks not_allowed) (vias not_allowed) (pads allowed) (copperpour allowed) (footprints allowed)) (fill (thermal_gap 0.5) (thermal_bridge_width 0.5))
     (polygon (pts (xy 103 88) (xy 107 88) (xy 107 92) (xy 103 92))))
   (dimension (type aligned) (layer "F.Fab") (uuid "${U(5)}") (pts (xy 104 92) (xy 106 92)) (height 1)
     (format (prefix "") (suffix "") (units 3) (units_format 0) (precision 4)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0.5) (keep_text_aligned yes))
     (gr_text "2" (at 105 90.5 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15)))))`;
const pcbWith = () => PCB.replace('(pad "" np_thru_hole oval (at 0 0) (size 1.2 2.4) (drill oval 1.2 2.4) (layers "*.Cu" "*.Mask")))',
  `(pad "" np_thru_hole oval (at 0 0) (size 1.2 2.4) (drill oval 1.2 2.4) (layers "*.Cu" "*.Mask")) ${H1_ITEMS})`)
  .replace('(at 125 80) (path "/aaaaaaaa-0000-0000-0000-000000000002")', '(at 125 80) (path "/aaaaaaaa-0000-0000-0000-000000000002") (attr exclude_from_pos_files)');

async function imported(): Promise<PcbDocument> {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_pcb', bytes: enc(pcbWith()) }]);
  return readPcbDoc(writePcbDoc(readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc');
}
const out = (doc: PcbDocument): SList => parseSexpr(td.decode(exportKicad({ name: 'mini', sheets: [], board: doc }).files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes));
const fpOf = (pcb: SList, ref: string) => kids(pcb, 'footprint').find((f) => kids(f, 'property').some((p) => str(p, 0) === 'Reference' && str(p, 1) === ref))!;
const xy = (n: SList | undefined) => [num(n, 0), num(n, 1)];
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 0.002);

describe('KiCad round trip: a footprint\'s rule areas, dimensions and groups (R9)', () => {
  it('a hatched zone keeps its fill', async () => {
    const pcb = PCB.replace('(fill yes (thermal_gap 0.5) (thermal_bridge_width 0.5))', '(fill yes (mode hatch) (thermal_gap 0.5) (thermal_bridge_width 0.5) (hatch_thickness 1) (hatch_gap 1.5) (hatch_orientation 0))');
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_pcb', bytes: enc(pcb) }]);
    const t = out(readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc'));
    const z = kids(t, 'zone').find((x) => str(kid(kid(x, 'fill'), 'mode'), 0) === 'hatch')!;
    expect(kids(z, 'filled_polygon').length).toBe(1);
  });

  it('back in the footprint where they were; its rule area a keep-out of the part in Konium', async () => {
    const doc = await imported();
    const h = doc.components.findIndex((c) => c.designator === 'H1');
    expect(doc.prims.filter((p) => p.kind === 'region' && p.keepout && p.component === h).length).toBe(1);
    const t = out(doc);
    const h1 = fpOf(t, 'H1');
    const [ax, ay] = xy(kid(h1, 'at'));
    const dx = ax! - 105, dy = ay! - 90;
    const z = kids(h1, 'zone')[0]!;
    expect(kid(z, 'keepout')).toBeTruthy();
    expect(near(xy(kids(kid(kid(z, 'polygon'), 'pts'), 'xy')[0]), [103 + dx, 88 + dy])).toBe(true);
    // (not at the board's level as well)
    expect(kids(t, 'zone').some((x) => near(xy(kids(kid(kid(x, 'polygon'), 'pts'), 'xy')[0]), [103 + dx, 88 + dy]))).toBe(false);
    const d = kids(h1, 'dimension')[0]!;
    expect(near(xy(kids(kid(d, 'pts'), 'xy')[0]), [104 + dx, 92 + dy])).toBe(true);
    const g = kids(h1, 'group')[0]!;
    expect(kid(g, 'members')!.items).toEqual([U(1), U(2)]);
    expect(kids(h1, 'fp_line').map((l) => str(kid(l, 'uuid'), 0)).sort()).toEqual([U(1), U(2)]);
    // KiCad's attributes where Konium's kind writes none of its own
    expect(kid(fpOf(t, 'R2'), 'attr')?.items).toEqual(['exclude_from_pos_files']);
  });

  it('the part moved and turned a quarter: its dimension and rule area with it, its group whole', async () => {
    const doc = await imported();
    const h = doc.components.findIndex((c) => c.designator === 'H1');
    moveComponent(doc, h, { x: 50000 * 39.37 / 10, y: 0 }, 90).apply();
    const t = out(readPcbDoc(writePcbDoc(doc), 'mini.PcbDoc'));
    const h1 = fpOf(t, 'H1');
    const [ax, ay, a] = [num(kid(h1, 'at'), 0), num(kid(h1, 'at'), 1), num(kid(h1, 'at'), 2)];
    expect(a).toBe(90);
    // (KiCad turns anticlockwise with y down: a point (-1, 2) from the part is (2, 1) from it a quarter round)
    const d = kids(h1, 'dimension')[0]!;
    expect(near(xy(kids(kid(d, 'pts'), 'xy')[0]), [ax + 2, ay + 1])).toBe(true);
    expect(num(kid(kid(d, 'gr_text'), 'at'), 2)).toBe(90);
    const z = kids(h1, 'zone')[0]!;
    const corners = kids(kid(kid(z, 'polygon'), 'pts'), 'xy').map(xy);
    expect(corners.some((c) => near(c, [ax - 2, ay + 2]))).toBe(true);
    expect(kid(kids(h1, 'group')[0], 'members')!.items).toEqual([U(1), U(2)]);
  });
});

async function schRoundTrip(sch: string, more: { path: string; text: string }[] = []) {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(sch) }, ...more.map((f) => ({ path: f.path, bytes: enc(f.text) }))]);
  const docs = r.projects[0]!.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
  const files = exportKicad({ name: 'mini', sheets: docs, hierarchyMode: 2 }).files;
  return (name: string) => parseSexpr(td.decode(files.find((f) => f.path.endsWith(name))!.bytes));
}
const add = (extra: string) => SCH.replace(/\)\s*$/, ` ${extra})`);

describe('KiCad round trip: schematics, the last few (R9)', () => {
  it('a label\'s stroke thickness; a text box drawn from its other corner', async () => {
    const t = (await schRoundTrip(add(`(label "THICK" (at 120 70 0) (effects (font (size 1.524 1.524) (thickness 0.305) bold) (justify left bottom)) (uuid "cccccccc-0000-0000-0000-000000000001"))
      (label "SMALL" (at 120 75 0) (effects (font (size 1.1 1.1)) (justify left bottom)) (uuid "cccccccc-0000-0000-0000-000000000003"))
      (text_box "NEG" (exclude_from_sim no) (at 175.26 60 0) (size -20 10) (stroke (width 0) (type default)) (fill (type none)) ${font} (uuid "cccccccc-0000-0000-0000-000000000002"))`)))('mini.kicad_sch');
    const l = kids(t, 'label').find((x) => str(x, 0) === 'THICK')!;
    expect(num(kid(kid(kid(l, 'effects'), 'font'), 'thickness'), 0)).toBe(0.305);
    // (a size between the desktop software's points: KiCad's again)
    const sm = kids(t, 'label').find((x) => str(x, 0) === 'SMALL')!;
    expect(kid(kid(kid(sm, 'effects'), 'font'), 'size')?.items).toEqual([1.1, 1.1]);
    const tb = kids(t, 'text_box')[0]!;
    expect([num(kid(tb, 'size'), 0), num(kid(tb, 'size'), 1)]).toEqual([-20, 10]);
    // (its corner as far from the label MID as it was)
    const m = kid(kids(t, 'label').find((x) => str(x, 0) === 'MID'), 'at');
    expect(Math.round((num(kid(tb, 'at'), 0) - num(m, 0)) * 100) / 100).toBe(75.26);
  });

  it('an empty datasheet field where it was; a symbol in the BOM but not on the board', async () => {
    const t = (await schRoundTrip(SCH.replace('(property "Footprint" "Resistor_SMD:R_0603" (at 100 100 0) (effects (font (size 1.27 1.27)) hide))\n    (instances (project "mini" (path "/11111111-0000-0000-0000-000000000001" (reference "R1")',
      '(property "Footprint" "Resistor_SMD:R_0603" (at 100 100 0) (effects (font (size 1.27 1.27)) hide)) (property "Datasheet" "" (at 103 97 0) (effects (font (size 1.27 1.27)) hide (justify left)))\n    (instances (project "mini" (path "/11111111-0000-0000-0000-000000000001" (reference "R1")')
      .replace('(symbol (lib_id "Device:R") (at 100 110 0) (unit 1) (in_bom yes) (on_board yes)', '(symbol (lib_id "Device:R") (at 100 110 0) (unit 1) (in_bom yes) (on_board no)')))('mini.kicad_sch');
    const ref = (r: string) => kids(t, 'symbol').find((x) => kids(x, 'property').some((p) => str(p, 0) === 'Reference' && str(p, 1) === r))!;
    const ds = kids(ref('R1'), 'property').find((p) => str(p, 0) === 'Datasheet')!;
    expect(str(ds, 1)).toBe('');
    expect(kid(kid(ds, 'effects'), 'justify')?.items).toEqual(['left']);
    expect([str(kid(ref('R2'), 'in_bom'), 0), str(kid(ref('R2'), 'on_board'), 0)]).toEqual(['yes', 'no']);
  });

  it('a tri-state hierarchical label stays one', async () => {
    const sch = add(`(sheet (at 60 50) (size 25.4 12.7) (stroke (width 0) (type solid)) (fill (color 255 255 255 0)) (uuid "cccccccc-0000-0000-0000-000000000008")
      (property "Sheetname" "Sub" (at 60 49 0) ${font}) (property "Sheetfile" "sub.kicad_sch" (at 60 63 0) ${font})
      (pin "DQ" tri_state (at 85.4 55 0) (effects (font (size 1.27 1.27)) (justify right)) (uuid "cccccccc-0000-0000-0000-000000000009")))`);
    const sub = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "dddddddd-0000-0000-0000-000000000001") (paper "A4") (lib_symbols)
      (hierarchical_label "DQ" (shape tri_state) (at 50 50 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "dddddddd-0000-0000-0000-000000000002")))`;
    const t = (await schRoundTrip(sch, [{ path: 'mini/sub.kicad_sch', text: sub }]))('sub.kicad_sch');
    expect(kids(t, 'hierarchical_label').map((x) => str(kid(x, 'shape'), 0))).toEqual(['tri_state']);
  });
});
