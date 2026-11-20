import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { readSchLib } from '../src/formats/altium/schlib';
import { deriveSheet } from '../src/model/sch';
import { openPcbLib } from '../src/model/pcbLib';
import { parseSexpr, kid, kids, str, type SList } from '../src/formats/kicad/sexpr';

/**
 * R9, libraries both ways: a KiCad symbol library and footprint library read as a SchLib and a
 * PcbLib and written back as KiCad had them while each symbol and footprint is what the import made
 * (its fields, fonts, pin settings, custom pads, texts and 3D models too); one changed in Konium
 * written from Konium's. A library symbol's fields are its parameters in Konium.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
const SYM = `(kicad_symbol_lib (version 20231120) (generator "kicad_symbol_editor") (generator_version "8.0")
  (symbol "OPA1" (pin_names (offset 0.762)) (exclude_from_sim no) (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 3.81 8.89 0) (effects (font (size 1.524 1.524))))
    (property "Value" "OPA1" (at 5.08 -8.89 0) (effects (font (size 1.524 1.524))))
    (property "Footprint" "Package_SO:SOIC-8" (at -2.54 -5.08 0) (effects (font (size 0.381 0.381)) hide))
    (property "Datasheet" "https://example.com/opa1.pdf" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "Supplier" "ACME 123" (at 0 -12 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_keywords" "amplifier op-amp" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (property "ki_fp_filters" "SOIC*3.9x4.9mm*P1.27mm*" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))
    (symbol "OPA1_0_1" (polyline (pts (xy -5.08 5.08) (xy 5.08 0) (xy -5.08 -5.08) (xy -5.08 5.08)) (stroke (width 0.254) (type default)) (fill (type background))))
    (symbol "OPA1_1_1"
      (pin input line (at -7.62 2.54 0) (length 2.54) (name "+" (effects (font (size 1.016 1.016)))) (number "3" (effects (font (size 1.016 1.016)))))
      (pin input line (at -7.62 -2.54 0) (length 2.54) (name "-" (effects (font (size 1.016 1.016)))) (number "2" (effects (font (size 1.016 1.016)))))
      (pin output line (at 7.62 0 180) (length 2.54) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))))
)`;
const MOD = `(footprint "TP_Custom" (version 20240108) (generator "pcbnew") (generator_version "8.0") (layer "F.Cu")
  (descr "A test point") (tags "test point")
  (property "Reference" "REF**" (at 0 -2 0) (layer "F.SilkS") (uuid "11111111-2222-3333-4444-555555555501") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "TP_Custom" (at 0 2 0) (layer "F.Fab") (uuid "11111111-2222-3333-4444-555555555502") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (fp_circle (center 0 0) (end 1.2 0) (stroke (width 0.12) (type solid)) (fill none) (layer "F.SilkS") (uuid "11111111-2222-3333-4444-555555555503"))
  (fp_text user "\${REFERENCE}" (at 0 0 0) (layer "F.Fab") (uuid "11111111-2222-3333-4444-555555555504") (effects (font (size 0.5 0.5) (thickness 0.08))))
  (pad "1" smd custom (at 0 0) (size 0.5 0.5) (layers "F.Cu" "F.Mask") (options (clearance outline) (anchor circle))
    (primitives (gr_poly (pts (xy -0.8 -0.3) (xy 0.8 -0.3) (xy 0 0.9)) (width 0) (fill yes))) (uuid "11111111-2222-3333-4444-555555555505"))
  (model "\${KICAD8_3DMODEL_DIR}/TestPoint.3dshapes/TP.wrl" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))
)`;

async function symbolsBack(edit?: (bags: ReturnType<typeof readSchLib>['symbols'][number]['bags']) => void) {
  const r = await importKicad([{ path: 'libs/Amps.kicad_sym', bytes: enc(SYM) }]);
  const lib = r.libraries.find((l) => /\.schlib$/i.test(l.name))!;
  const l = readSchLib(lib.bytes, lib.name), sh = deriveSheet(l.header);
  if (edit) edit(l.symbols[0]!.bags);
  const out = exportKicad({ name: 'back', sheets: [], schLibs: [{ name: lib.name, symbols: l.symbols.map((x) => ({ libRef: x.libRef, bags: x.bags })), fonts: sh.fonts, systemFont: sh.systemFont }] });
  return { lib: l, text: td.decode(out.files.find((f) => f.path.endsWith('.kicad_sym'))!.bytes) };
}
async function footprintBack(edit?: (lib: ReturnType<typeof openPcbLib>) => void) {
  const r = await importKicad([{ path: 'libs/Test.pretty/TP_Custom.kicad_mod', bytes: enc(MOD) }]);
  const lib = openPcbLib(r.libraries.find((l) => /\.pcblib$/i.test(l.name))!.bytes, 'Test.PcbLib');
  edit?.(lib);
  const out = exportKicad({ name: 'back', sheets: [], pcbLibs: [lib] });
  return parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('TP_Custom.kicad_mod'))!.bytes));
}
const sym = (t: SList) => kids(t, 'symbol')[0]!;

describe('KiCad libraries round trip (R9)', () => {
  it('a symbol as KiCad had it: its fields, fonts and pin settings; its fields its parameters in Konium', async () => {
    const { lib, text } = await symbolsBack();
    const s = sym(parseSexpr(text));
    expect(str(s, 0)).toBe('OPA1');
    expect(kids(s, 'property').map((p) => str(p, 0))).toEqual(['Reference', 'Value', 'Footprint', 'Datasheet', 'Supplier', 'ki_keywords', 'ki_fp_filters']);
    expect(str(kids(s, 'property').find((p) => str(p, 0) === 'Footprint'), 1)).toBe('Package_SO:SOIC-8');
    expect(kid(kid(kid(kids(s, 'property')[0], 'effects'), 'font'), 'size')?.items).toEqual([1.524, 1.524]);
    expect(kid(kid(s, 'pin_names'), 'offset')?.items).toEqual([0.762]);
    // (pin numbers in quotes, as KiCad writes them)
    expect(text).toContain('(number "3"');
    // In Konium: the datasheet and the supplier as parameters
    const params = lib.symbols[0]!.bags.filter((b) => b.get('RECORD') === '41').map((b) => `${b.get('NAME')}=${b.get('TEXT')}`);
    expect(params).toEqual(expect.arrayContaining(['Datasheet=https://example.com/opa1.pdf', 'Supplier=ACME 123']));
  });

  it('a symbol changed in Konium: written from Konium\'s', async () => {
    const { text } = await symbolsBack((bags) => { const pin = bags.find((b) => b.get('RECORD') === '2')!; pin.set('NAME', 'IN+'); });
    const s = sym(parseSexpr(text));
    const names = kids(s, 'symbol').flatMap((u) => kids(u, 'pin')).map((p) => str(kid(p, 'name'), 0));
    expect(names).toContain('IN+');
  });

  it('a footprint as KiCad had it: its custom pad, texts, tags and model', async () => {
    const t = await footprintBack();
    expect(str(t, 0)).toBe('TP_Custom');
    const pad = kids(t, 'pad')[0]!;
    expect([str(pad, 1), str(pad, 2)]).toEqual(['smd', 'custom']);
    expect(kids(t, 'fp_text').map((x) => str(x, 1))).toEqual(['${REFERENCE}']);
    expect(str(kid(t, 'tags'), 0)).toBe('test point');
    expect(kids(t, 'model').map((m) => str(m, 0))).toEqual(['${KICAD8_3DMODEL_DIR}/TestPoint.3dshapes/TP.wrl']);
  });

  it('a footprint changed in Konium: written from Konium\'s', async () => {
    const t = await footprintBack((lib) => {
      const e = lib.footprints[0]!;
      const c = e.doc.prims.find((p) => p.kind === 'arc');
      if (c && c.kind === 'arc') c.r *= 2;
    });
    expect(kid(t, 'tags')).toBeUndefined();
  });
});
