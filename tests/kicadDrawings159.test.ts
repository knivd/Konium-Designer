import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc, schStorage, storedBytes } from '../src/formats/altium/schdoc';
import { parseSexpr, kid, kids, num, str, type SList } from '../src/formats/kicad/sexpr';
import { PCB, PRO, SCH } from './fixtures/kicadMini';

/**
 * R9, schematic drawings and the rest as KiCad had them: a line's width, dashes and colour and a
 * shape's fill; a text box; a picture embedded in the schematic (and in the SchDoc, as the desktop
 * software embeds one); a net class flag as a parameter set; a label in bold italics; sheets back in
 * their folders; a footprint with no attributes.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
const font = '(effects (font (size 1.27 1.27)))';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAIAAAA8r+mnAAAAEklEQVR4nGP4z8CAFWEXJUsCAFpeH+EeQoQoAAAAAElFTkSuQmCC';
const add = (extra: string) => SCH.replace(/\)\s*$/, ` ${extra})`);

async function imported(files: { path: string; text: string }[]) {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, ...files.map((f) => ({ path: f.path, bytes: enc(f.text) }))]);
  return r.projects[0]!.documents.filter((d) => /\.schdoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
}
async function roundTrip(sch: string): Promise<SList> {
  const out = exportKicad({ name: 'mini', sheets: await imported([{ path: 'mini/mini.kicad_sch', text: sch }]), hierarchyMode: 2 });
  return parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('mini.kicad_sch'))!.bytes));
}

describe('KiCad round trip: drawings, pictures, flags (R9)', () => {
  it('a line\'s width, dashes and colour; a rectangle\'s fill; a bezier; a text box', async () => {
    const t = await roundTrip(add(`(polyline (pts (xy 120 60) (xy 140 60) (xy 140 70)) (stroke (width 0.5) (type dash) (color 200 0 0 1)) (fill (type none)) (uuid "cccccccc-0000-0000-0000-000000000001"))
      (rectangle (start 150 60) (end 170 75) (stroke (width 0.254) (type default)) (fill (type color) (color 0 120 255 0.5)) (uuid "cccccccc-0000-0000-0000-000000000002"))
      (bezier (pts (xy 120 90) (xy 125 80) (xy 135 100) (xy 140 90)) (stroke (width 0) (type default)) (fill (type none)) (uuid "cccccccc-0000-0000-0000-000000000003"))
      (text_box "NOTE" (exclude_from_sim no) (at 180 60 0) (size 20 10) (margins 1.5 1.5 1.5 1.5) (stroke (width 0) (type default)) (fill (type none)) ${font} (uuid "cccccccc-0000-0000-0000-000000000004"))`));
    const pl = kids(t, 'polyline').find((p) => kids(kid(p, 'pts'), 'xy').length === 3)!;
    const st = kid(pl, 'stroke')!;
    expect([num(kid(st, 'width'), 0), str(kid(st, 'type'), 0), kid(st, 'color')?.items]).toEqual([0.5, 'dash', [200, 0, 0, 1]]);
    const rc = kids(t, 'rectangle')[0]!;
    expect([str(kid(kid(rc, 'fill'), 'type'), 0), kid(kid(rc, 'fill'), 'color')?.items]).toEqual(['color', [0, 120, 255, 0.5]]);
    expect(kids(kid(kids(t, 'bezier')[0]!, 'pts'), 'xy').length).toBe(4);
    const tb = kids(t, 'text_box')[0]!;
    expect([str(tb, 0), num(kid(tb, 'size'), 0), num(kid(tb, 'size'), 1), num(kid(tb, 'margins'), 0)]).toEqual(['NOTE', 20, 10, 1.5]);
  });

  it('a picture: embedded in the SchDoc as the desktop software embeds one, back in KiCad with the same bytes and scale', async () => {
    const sch = add(`(image (at 150 80) (scale 2) (uuid "cccccccc-0000-0000-0000-000000000005") (data "${PNG}"))`);
    const docs = await imported([{ path: 'mini/mini.kicad_sch', text: sch }]);
    const st = schStorage(docs[0]!.doc);
    expect(st.length).toBe(1);
    const bytes = storedBytes(st[0]!);
    expect(btoa(String.fromCharCode(...bytes))).toBe(PNG);
    const img = docs[0]!.doc.objects.find((o) => o.kind === 'image');
    expect(img).toBeTruthy();
    const out = exportKicad({ name: 'mini', sheets: docs, hierarchyMode: 2 });
    const t = parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('mini.kicad_sch'))!.bytes));
    const im = kids(t, 'image')[0]!;
    expect(kids(im, 'data').flatMap((d) => d.items.map(String)).join('')).toBe(PNG);
    expect(num(kid(im, 'scale'), 0)).toBe(2);
    expect([num(kid(im, 'at'), 0), num(kid(im, 'at'), 1)].map((v) => Math.round(v * 100) / 100)).toEqual([150, 80]);
  });

  it('a rectangle drawn from its bottom right corner: from that corner again', async () => {
    const t = await roundTrip(add(`(rectangle (start 170 75) (end 150 60) (stroke (width 0) (type default)) (fill (type none)) (uuid "cccccccc-0000-0000-0000-000000000009"))`));
    const rc = kids(t, 'rectangle')[0]!;
    const [sx, sy, ex, ey] = [num(kid(rc, 'start'), 0), num(kid(rc, 'start'), 1), num(kid(rc, 'end'), 0), num(kid(rc, 'end'), 1)];
    expect([sx > ex, sy > ey, Math.round((sx - ex) * 100) / 100, Math.round((sy - ey) * 100) / 100]).toEqual([true, true, 20, 15]);
  });

  it('a net class flag: a parameter set in Konium, a net class flag again', async () => {
    const t = await roundTrip(add(`(netclass_flag "" (length 2.54) (shape round) (at 110 100 0) (fields_autoplaced yes) ${font} (uuid "cccccccc-0000-0000-0000-000000000006")
      (property "Netclass" "Power" (at 110.7 97.5 0) (effects (font (size 1.27 1.27) italic) (justify left))))`));
    const f = kids(t, 'netclass_flag')[0]!;
    expect(f).toBeTruthy();
    expect([str(kid(f, 'shape'), 0), num(kid(f, 'length'), 0)]).toEqual(['round', 2.54]);
    expect(kids(f, 'property').map((p) => [str(p, 0), str(p, 1)])).toEqual([['Netclass', 'Power']]);
  });

  it('a label in bold italics', async () => {
    const t = await roundTrip(add(`(label "STYLED" (at 120 70 0) (effects (font (size 1.27 1.27) bold italic) (justify left bottom)) (uuid "cccccccc-0000-0000-0000-000000000007"))`));
    const l = kids(t, 'label').find((x) => str(x, 0) === 'STYLED')!;
    const fo = kid(kid(l, 'effects'), 'font')!;
    expect(fo.items.filter((x) => typeof x === 'string')).toEqual(expect.arrayContaining(['bold', 'italic']));
  });

  it('a sheet in a folder written back into it', async () => {
    const sch = add(`(sheet (at 60 50) (size 25.4 12.7) (stroke (width 0) (type solid)) (fill (color 255 255 255 0)) (uuid "cccccccc-0000-0000-0000-000000000008")
      (property "Sheetname" "Sub" (at 60 49 0) ${font}) (property "Sheetfile" "parts/sub.kicad_sch" (at 60 63 0) ${font}))`);
    const sub = '(kicad_sch (version 20231120) (generator "eeschema") (uuid "dddddddd-0000-0000-0000-000000000001") (paper "A4") (lib_symbols))';
    const docs = await imported([{ path: 'mini/mini.kicad_sch', text: sch }, { path: 'mini/parts/sub.kicad_sch', text: sub }]);
    const out = exportKicad({ name: 'mini', sheets: docs, hierarchyMode: 2 });
    expect(out.files.map((f) => f.path).some((p) => /(^|\/)parts\/sub\.kicad_sch$/.test(p))).toBe(true);
    const t = parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('mini.kicad_sch'))!.bytes));
    const sh = kids(t, 'sheet')[0]!;
    expect(str(kids(sh, 'property').find((p) => str(p, 0) === 'Sheetfile')!, 1)).toBe('parts/sub.kicad_sch');
  });

  it('a footprint with no attributes stays without them', async () => {
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB) }]);
    const doc = readPcbDoc(writePcbDoc(readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc');
    const t = parseSexpr(td.decode(exportKicad({ name: 'mini', sheets: [], board: doc }).files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes));
    // The fixture's footprints have no attr list: none written for them
    const fps = kids(t, 'footprint').filter((f) => str(f, 0) === 'Resistor_SMD:R_0603');
    expect(fps.length).toBeGreaterThan(0);
    expect(fps.map((f) => kid(f, 'attr'))).toEqual(fps.map(() => undefined));
  });
});
