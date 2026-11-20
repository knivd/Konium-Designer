import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { parseSexpr, kid, kids, num, str, type SList } from '../src/formats/kicad/sexpr';
import { PRO, SCH } from './fixtures/kicadMini';

/**
 * R9, schematics back to KiCad as KiCad had them: a text of several lines one text again; a
 * no-connect flag on a wire's open end kept; junctions where KiCad has them (a part's stacked
 * pins count once, labels none) and wires not broken at labels; a sheet used more than once that
 * has sheets of its own written as one file too.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
const font = '(effects (font (size 1.27 1.27)))';

async function roundTrip(sch: string, edit?: (docs: { name: string; doc: ReturnType<typeof readSchDoc> }[]) => void): Promise<SList> {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(sch) }]);
  const docs = r.projects[0]!.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
  edit?.(docs);
  const out = exportKicad({ name: 'mini', sheets: docs, hierarchyMode: 2 });
  return parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('mini.kicad_sch'))!.bytes));
}
const add = (extra: string) => SCH.replace(/\)\s*$/, ` ${extra})`);

describe('KiCad round trip: schematics (R9)', () => {
  it('a text of several lines: a text a line in Konium, one text again in KiCad (an empty line kept)', async () => {
    const t = await roundTrip(add(`(text "FIRST LINE\\n\\nTHIRD" (exclude_from_sim no) (at 120 60 0) ${font} (uuid "cccccccc-0000-0000-0000-000000000001"))`));
    const texts = kids(t, 'text').map((x) => str(x, 0));
    expect(texts).toEqual(['FIRST LINE\n\nTHIRD']);
    // At KiCad's anchor again (the first line's place, not the third's), as far from the label MID as it was
    const a = kid(kids(t, 'text')[0], 'at'), m = kid(kids(t, 'label')[0], 'at');
    expect([num(a, 0) - num(m, 0), num(a, 1) - num(m, 1)].map((v) => Math.round(v * 100) / 100)).toEqual([20, -45]);
  });

  it('a line of it changed in Konium: the lines as texts of their own', async () => {
    const t = await roundTrip(add(`(text "FIRST LINE\\nSECOND" (exclude_from_sim no) (at 120 60 0) ${font} (uuid "cccccccc-0000-0000-0000-000000000001"))`), (docs) => {
      const d = docs[0]!.doc;
      const x = d.objects.find((o) => o.kind === 'text' && o.text === 'SECOND');
      if (x?.kind === 'text') x.text = 'CHANGED';
    });
    expect(kids(t, 'text').map((x) => str(x, 0)).sort()).toEqual(['CHANGED', 'FIRST LINE']);
  });

  it('a no-connect flag on a wire\'s open end stays; a global label on a wire leaves it whole', async () => {
    const t = await roundTrip(add(`(wire (pts (xy 120 80) (xy 130 80)) (stroke (width 0) (type default)) (uuid "cccccccc-0000-0000-0000-000000000002"))
      (no_connect (at 130 80) (uuid "cccccccc-0000-0000-0000-000000000003"))
      (global_label "SIG" (shape input) (at 125 80 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "cccccccc-0000-0000-0000-000000000004"))`));
    expect(kids(t, 'no_connect').length).toBe(1);
    // The new wire still one, the fixture's (with MID on it) one: two in all
    expect(kids(t, 'wire').length).toBe(2);
    expect(kids(t, 'junction').length).toBe(0);
  });

  it('labels with KiCad\'s markup (a subscript, an overbar) go back written as they were', async () => {
    const t = await roundTrip(add(`(label "BUS_{A}.SDA" (at 120 70 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "cccccccc-0000-0000-0000-000000000007"))
      (global_label "~{RESET}" (shape input) (at 130 70 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "cccccccc-0000-0000-0000-000000000008"))`));
    expect(kids(t, 'label').map((x) => str(x, 0)).sort()).toEqual(['BUS_{A}.SDA', 'MID']);
    expect(kids(t, 'global_label').map((x) => str(x, 0))).toEqual(['~{RESET}']);
  });

  it('a hierarchical label on a bus, not at a wire\'s end: back at its point, turned as it was', async () => {
    const t = await roundTrip(add(`(bus (pts (xy 110 90) (xy 140 90)) (stroke (width 0) (type default)) (uuid "cccccccc-0000-0000-0000-000000000010"))
      (hierarchical_label "D_{BUS}{D}" (shape input) (at 125 90 180) (effects (font (size 1.27 1.27)) (justify right)) (uuid "cccccccc-0000-0000-0000-000000000011"))`));
    const l = [...kids(t, 'hierarchical_label'), ...kids(t, 'global_label')].find((x) => str(x, 0) === 'D_{BUS}{D}')!;
    const a = kid(l, 'at'), m = kid(kids(t, 'label')[0], 'at');
    expect([num(a, 0) - num(m, 0), num(a, 1) - num(m, 1), num(a, 2)].map((v) => Math.round(v * 100) / 100)).toEqual([25, -15, 180]);
  });

  it('a text of one line with KiCad\'s markup goes back with it', async () => {
    const t = await roundTrip(add(`(text "V_{OUT} = 3.3V" (exclude_from_sim no) (at 120 60 0) ${font} (uuid "cccccccc-0000-0000-0000-000000000009"))`));
    expect(kids(t, 'text').map((x) => str(x, 0))).toEqual(['V_{OUT} = 3.3V']);
  });

  it('a wire to a part\'s two pins stacked on one point: no junction (KiCad counts the part once)', async () => {
    const pin = (n: string) => `(pin passive line (at 0 3.81 270) (length 1.27) (name "~" ${font}) (number "${n}" ${font}))`;
    const sch = SCH.replace('(lib_symbols', `(lib_symbols (symbol "Device:J" (in_bom yes) (on_board yes) (property "Reference" "J" (at 0 0 0) ${font}) (property "Value" "J" (at 0 0 0) ${font})
      (symbol "J_0_1" (rectangle (start -1 -2.5) (end 1 2.5) (stroke (width 0.25) (type default)) (fill (type none)))) (symbol "J_1_1" ${pin('1')} ${pin('2')}))`)
      .replace(/\)\s*$/, ` (symbol (lib_id "Device:J") (at 140 100 0) (unit 1) (in_bom yes) (on_board yes) (uuid "cccccccc-0000-0000-0000-000000000005")
        (property "Reference" "J1" (at 142 100 0) ${font}) (property "Value" "J" (at 144 100 0) ${font})
        (instances (project "mini" (path "/11111111-0000-0000-0000-000000000001" (reference "J1") (unit 1)))))
      (wire (pts (xy 140 96.19) (xy 140 90)) (stroke (width 0) (type default)) (uuid "cccccccc-0000-0000-0000-000000000006")))`);
    const t = await roundTrip(sch);
    expect(kids(t, 'junction').length).toBe(0);
  });

  it('a sheet used twice that has a sheet used twice in it: each written once, every use\'s designators in its symbols', async () => {
    const U = (n: number) => `cccccccc-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
    const sheet = (n: number, name: string, file: string, pages: [string, number][]) => `(sheet (at ${50 + n * 30} 50) (size 20 10) (uuid "${U(n)}")
      (property "Sheetname" "${name}" (at ${50 + n * 30} 49 0) ${font}) (property "Sheetfile" "${file}" (at ${50 + n * 30} 61 0) ${font})
      (instances (project "nest" ${pages.map(([p, g]) => `(path "${p}" (page "${g}"))`).join(' ')})))`;
    const root = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "${U(0)}") (paper "A4") (lib_symbols)
      ${sheet(1, 'A', 'mid.kicad_sch', [[`/${U(0)}`, 2]])} ${sheet(2, 'B', 'mid.kicad_sch', [[`/${U(0)}`, 3]])} (sheet_instances (path "/" (page "1"))))`;
    const mid = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "${U(3)}") (paper "A4") (lib_symbols)
      ${sheet(5, 'X', 'ch.kicad_sch', [[`/${U(0)}/${U(1)}`, 4], [`/${U(0)}/${U(2)}`, 6]])} ${sheet(6, 'Y', 'ch.kicad_sch', [[`/${U(0)}/${U(1)}`, 5], [`/${U(0)}/${U(2)}`, 7]])})`;
    const pin = (n: string, y: number, a: number) => `(pin passive line (at 0 ${y} ${a}) (length 1.27) (name "~" ${font}) (number "${n}" ${font}))`;
    const paths = [[1, 5, 'R1'], [1, 6, 'R2'], [2, 5, 'R3'], [2, 6, 'R4']] as const;
    const child = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "${U(4)}") (paper "A4")
      (lib_symbols (symbol "Device:R" (in_bom yes) (on_board yes) (property "Reference" "R" (at 0 0 0) ${font}) (property "Value" "R" (at 0 0 0) ${font})
        (symbol "R_0_1" (rectangle (start -1 -2.5) (end 1 2.5) (stroke (width 0.25) (type default)) (fill (type none)))) (symbol "R_1_1" ${pin('1', 3.81, 270)} ${pin('2', -3.81, 90)})))
      (symbol (lib_id "Device:R") (at 100 100 0) (unit 1) (in_bom yes) (on_board yes) (uuid "${U(9)}")
        (property "Reference" "R1" (at 102 100 0) ${font}) (property "Value" "10k" (at 104 100 0) ${font}) (property "Footprint" "Resistor_SMD:R_0603" (at 100 100 0) (effects (font (size 1.27 1.27)) hide))
        (instances (project "nest" ${paths.map(([a, b, ref]) => `(path "/${U(0)}/${U(a)}/${U(b)}" (reference "${ref}") (unit 1))`).join(' ')}))))`;
    const r = await importKicad([{ path: 'nest/nest.kicad_pro', bytes: enc('{}') }, { path: 'nest/nest.kicad_sch', bytes: enc(root) }, { path: 'nest/mid.kicad_sch', bytes: enc(mid) }, { path: 'nest/ch.kicad_sch', bytes: enc(child) }]);
    const docs = r.projects[0]!.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
    // In Konium: a sheet per use (2 of mid, 4 of ch)
    expect(docs.length).toBe(7);
    const out = exportKicad({ name: 'nest', sheets: docs, hierarchyMode: 2 });
    const files = out.files.filter((f) => f.path.endsWith('.kicad_sch'));
    expect(files.map((f) => f.path.replace(/^.*\//, '')).sort()).toEqual(['ch.kicad_sch', 'mid.kicad_sch', 'nest.kicad_sch']);
    const tree = (n: string) => parseSexpr(td.decode(files.find((f) => f.path.endsWith(`/${n}`) || f.path === n)!.bytes));
    const top = tree('nest.kicad_sch'), m = tree('mid.kicad_sch'), ch = tree('ch.kicad_sch');
    const rootU = str(kid(top, 'uuid'), 0)!;
    const uuidOf = (x: SList) => str(kid(x, 'uuid'), 0)!;
    const pathsOf = (x: SList) => kids(kid(kid(x, 'instances'), 'project'), 'path').map((p) => str(p, 0)!);
    // The middle sheet's two sheet symbols, each placed under both uses of it
    for (const s of kids(m, 'sheet')) expect(pathsOf(s).sort()).toEqual(kids(top, 'sheet').map((t) => `/${rootU}/${uuidOf(t)}`).sort());
    // The resistor: a designator for each of the four paths through both levels, each path one that is there
    const sym = kids(ch, 'symbol')[0]!;
    const want = kids(top, 'sheet').flatMap((a) => kids(m, 'sheet').map((b) => `/${rootU}/${uuidOf(a)}/${uuidOf(b)}`)).sort();
    expect(pathsOf(sym).sort()).toEqual(want);
    expect(kids(kid(kid(sym, 'instances'), 'project'), 'path').map((p) => str(kid(p, 'reference'), 0)).sort()).toEqual(['R1', 'R2', 'R3', 'R4']);
  });
});
