import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { parseSexpr, kid, kids, num, str, type SList } from '../src/formats/kicad/sexpr';
import { L } from '../src/model/layers';
import type { PcbDocument } from '../src/model/pcb';
import { PCB, PRO, SCH } from './fixtures/kicadMini';

/**
 * R9: KiCad's board graphics and texts kept whole (src/formats/kicad/kept.ts). A Bezier curve
 * stays a curve, a text of two lines one text with KiCad's anchor, size and knockout; anything
 * changed in Konium goes as Konium has it.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
const EXTRA = ` (gr_curve (pts (xy 101 71) (xy 105 72) (xy 108 76) (xy 110 80)) (stroke (width 0.15) (type solid)) (layer "F.SilkS"))
 (gr_text "TWO\\nLINES" (at 120 90 90) (layer "F.SilkS" knockout) (effects (font (size 1.5 0.8) (thickness 0.15)) (justify left bottom)))
 (gr_rect (start 102 92) (end 106 94) (stroke (width 0.12) (type dash)) (fill no) (layer "F.SilkS"))`;

async function board(): Promise<PcbDocument> {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB.replace(/\)\s*$/, `${EXTRA})`)) }]);
  // Saved and opened again on the way, as a project would be
  return readPcbDoc(writePcbDoc(readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc');
}
const out = (doc: PcbDocument) => parseSexpr(td.decode(exportKicad({ name: 'mini', sheets: [], board: doc }).files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes));
const silk = (pcb: SList) => pcb.items.filter((x): x is SList => typeof x === 'object' && /^gr_/.test(x.k) && str(kid(x, 'layer'), 0) === 'F.SilkS');

describe('KiCad round trip: what Konium makes nothing of, passed through (R9)', () => {
  it('the title block, a dimension and an empty text come back as they were, moved with the board', async () => {
    const pass = ` (title_block (title "Mini") (date "2026-11-10") (rev "B") (company "Test") (comment 1 "first note"))
 (dimension (type aligned) (layer "F.Fab") (pts (xy 100 70) (xy 140 70)) (height -5)
   (format (prefix "") (suffix "") (units 3) (units_format 1) (precision 4)) (style (thickness 0.1) (arrow_length 1.27) (text_position_mode 0) (extension_height 0.58642) (extension_offset 0.5) (keep_text_aligned yes))
   (gr_text "40 mm" (at 120 64 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15)))))
 (gr_text "" (at 130 92 0) (layer "Dwgs.User") (effects (font (size 1.5 1.5) (thickness 0.1)) (justify left top)))`;
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB.replace(/\)\s*$/, `${pass})`)) }]);
    const doc = readPcbDoc(writePcbDoc(readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc');
    const pcb = out(doc);
    const tb = kid(pcb, 'title_block')!;
    expect(tb.items.filter((x): x is SList => typeof x === 'object').map((x) => `${x.k}=${x.items.join('|')}`)).toEqual(['title=Mini', 'date=2026-11-10', 'rev=B', 'company=Test', 'comment=1|first note']);
    const dim = kid(pcb, 'dimension')!;
    expect(str(kid(dim, 'type'), 0)).toBe('aligned');
    const [a, b] = kids(kid(dim, 'pts'), 'xy');
    const edge = pcb.items.find((x): x is SList => typeof x === 'object' && x.k === 'gr_rect' && str(kid(x, 'layer'), 0) === 'Edge.Cuts')!;
    // On the outline's top edge, its ends at its corners, as in the file
    expect([num(a, 0) - num(kid(edge, 'start'), 0), num(a, 1) - num(kid(edge, 'start'), 1), num(b, 0) - num(a, 0)].map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 40]);
    expect(str(kid(dim, 'gr_text'), 0)).toBe('40 mm');
    expect(pcb.items.filter((x): x is SList => typeof x === 'object' && x.k === 'gr_text' && str(x, 0) === '').length).toBe(1);
    // Written in quotes where KiCad has them
    const text = td.decode(exportKicad({ name: 'mini', sheets: [], board: doc }).files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes);
    expect(text).toContain('(rev "B")');
    expect(text).toContain('(prefix "")');
  });
});

describe('KiCad round trip: board graphics and texts kept whole (R9)', () => {
  it('a Bezier curve, a dashed rectangle and a text of two lines come back as KiCad had them', async () => {
    const doc = await board();
    // In Konium: the curve as lines, the rectangle as its sides, the text a line each
    expect(doc.prims.filter((p) => p.kind === 'track' && p.layer === L.TOP_OVERLAY).length).toBeGreaterThan(8);
    expect(doc.prims.filter((p) => p.kind === 'text' && p.layer === L.TOP_OVERLAY && p.component === 0xffff).map((p) => p.kind === 'text' && p.text)).toEqual(['MINI', 'BOARD', 'TWO', 'LINES']);
    // (the fixture's own text of two lines, MINI BOARD, besides)
    const g = silk(out(doc));
    expect(g.map((x) => x.k).sort()).toEqual(['gr_curve', 'gr_rect', 'gr_text', 'gr_text']);
    expect(g.filter((x) => x.k === 'gr_text').map((x) => str(x, 0))).toEqual(['MINI\nBOARD', 'TWO\nLINES']);
    const t = g.find((x) => x.k === 'gr_text' && str(x, 0) === 'TWO\nLINES')!;
    expect(str(t, 0)).toBe('TWO\nLINES');
    expect(kid(t, 'layer')!.items).toEqual(['F.SilkS', 'knockout']);
    expect(kid(kid(kid(t, 'effects'), 'font'), 'size')!.items).toEqual([1.5, 0.8]);
    expect(kid(kid(t, 'effects'), 'justify')!.items).toEqual(['left', 'bottom']);
    expect(num(kid(t, 'at'), 2)).toBe(90);
    expect(kids(kid(g.find((x) => x.k === 'gr_curve'), 'pts'), 'xy').length).toBe(4);
    expect(str(kid(kid(g.find((x) => x.k === 'gr_rect'), 'stroke'), 'type'), 0)).toBe('dash');
    // Where the rest of the board is: the curve's first point 1 and 1 mm in from the outline's corner
    const all = out(doc);
    const edge = all.items.find((x): x is SList => typeof x === 'object' && x.k === 'gr_rect' && str(kid(x, 'layer'), 0) === 'Edge.Cuts')!;
    const c0 = kids(kid(g.find((x) => x.k === 'gr_curve'), 'pts'), 'xy')[0]!;
    expect([num(c0, 0) - num(kid(edge, 'start'), 0), num(c0, 1) - num(kid(edge, 'start'), 1)].map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 1]);
  });

  it('a line of the text moved in Konium: the text goes as Konium has it', async () => {
    const doc = await board();
    const i = doc.prims.findIndex((p) => p.kind === 'text' && p.text === 'LINES');
    const t = doc.prims[i]!;
    if (t.kind !== 'text') throw new Error('no text');
    // Moved, as an edit does: a record of its own
    const moved = readPcbDoc(writePcbDoc(doc), 'mini.PcbDoc');
    const { encodeText } = await import('../src/formats/altium/pcbdoc');
    const rec = encodeText({ layer: t.layer, at: { x: t.at.x + 100000, y: t.at.y }, height: t.height, strokeWidth: t.strokeWidth, text: t.text, rotation: t.rotation });
    moved.streams.get(t.src.storage)!.records[t.src.index] = rec;
    const g = silk(out(moved));
    // The curve, the rectangle and the other text still whole; this text (one of its lines changed) as two texts
    expect(g.map((x) => x.k).sort()).toEqual(['gr_curve', 'gr_rect', 'gr_text', 'gr_text', 'gr_text']);
    expect(g.filter((x) => x.k === 'gr_text').map((x) => str(x, 0)).sort()).toEqual(['LINES', 'MINI\nBOARD', 'TWO']);
  });

  it('a part\'s own graphics and fields come back as KiCad had them, the part moved and turned in Konium too', async () => {
    const doc = await board();
    const fpOf = (pcb: SList, ref: string) => kids(pcb, 'footprint').find((f) => kids(f, 'property').some((p) => str(p, 0) === 'Reference' && str(p, 1) === ref))!;
    const items = (f: SList) => f.items.filter((x): x is SList => typeof x === 'object' && /^fp_/.test(x.k)).map((x) => `${x.k} ${(kid(x, 'start')?.items ?? []).join(',')} ${(kid(x, 'end')?.items ?? []).join(',')} ${str(kid(x, 'layer'), 0)}`);
    const want = items(kids(parseSexpr(PCB), 'footprint').find((f) => kids(f, 'property').some((p) => str(p, 1) === 'R1'))!).sort();
    expect(items(fpOf(out(doc), 'R1')).sort()).toEqual(want);
    // Moved 5 mm and turned a quarter in Konium: the same in the part's own frame
    const { moveComponent } = await import('../src/model/pcbEdit');
    const ci = doc.components.findIndex((c) => c.designator === 'R1');
    moveComponent(doc, ci, { x: 1968504, y: 0 }, 90).apply();
    const f = fpOf(out(doc), 'R1');
    expect(items(f).sort()).toEqual(want);
    expect(num(kid(f, 'at'), 2)).toBe(90);
    const ref = kids(f, 'property').find((p) => str(p, 0) === 'Reference')!;
    expect([str(ref, 1), (kid(ref, 'at')?.items ?? []).slice(0, 2).join(',')]).toEqual(['R1', '0,-1.5']);
  });

  it('a footprint\'s hidden texts and its own fields come back too, kept once for footprints alike', async () => {
    const fp = (ref: string, x: number) => ` (footprint "MountingHole:Hole" (layer "F.Cu") (at ${x} 88)
   (property "Reference" "${ref}" (at 0 -3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
   (property "Value" "Hole" (at 0 3 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
   (property "MPN" "HOLE-25" (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 1 1) (thickness 0.15))))
   (fp_text user "\${REFERENCE}" (at 0 0 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15)) hide))
   (fp_circle (center 0 0) (end 1.25 0) (stroke (width 0.15) (type solid)) (fill none) (layer "F.SilkS"))
   (pad "" np_thru_hole circle (at 0 0) (size 2.5 2.5) (drill 2.5) (layers "*.Cu" "*.Mask")))`;
    const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB.replace(/\)\s*$/, `${fp('H8', 104)}${fp('H9', 136)})`)) }]);
    const doc = readPcbDoc(writePcbDoc(readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc');
    // One copy of the items for both holes
    const keys = doc.components.filter((c) => /^H[89]$/.test(c.designator)).map((c) => c.bag.get('KICADFPKEY'));
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
    for (const ref of ['H8', 'H9']) {
      const f = kids(out(doc), 'footprint').find((x) => kids(x, 'property').some((p) => str(p, 0) === 'Reference' && str(p, 1) === ref))!;
      expect(kids(f, 'fp_text').map((t) => [str(t, 0), str(t, 1)])).toEqual([['user', '${REFERENCE}']]);
      expect(kids(f, 'property').find((p) => str(p, 0) === 'MPN')?.items[1]).toBe('HOLE-25');
      expect(kids(f, 'fp_circle').length).toBe(1);
    }
  });
});

