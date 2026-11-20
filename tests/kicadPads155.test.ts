import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { pasteMask, solderMask } from '../src/formats/gerber/gerber';
import { parseSexpr, kid, kids, num, str, type SList } from '../src/formats/kicad/sexpr';
import { L } from '../src/model/layers';
import type { PcbPad, PcbRegion } from '../src/model/pcb';
import { PCB, PRO, SCH } from './fixtures/kicadMini';

/**
 * R9, the KiCad round trip, pads: edge connector pads, pads with no paste or no mask, custom pads
 * (their primitives), pads on no copper (a paste opening alone) and through-hole pads on the outer
 * copper only come back as KiCad had them.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();

const FP = ` (footprint "Test:Pads" (layer "F.Cu") (at 110 85 90)
   (property "Reference" "J1" (at 0 -3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
   (property "Value" "Pads" (at 0 3 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
   (pad "A1" connect rect (at -2 0 90) (size 1 3) (layers "F.Cu" "F.Mask") (net 2 "GND"))
   (pad "FID" smd circle (at 2 0 90) (size 1 1) (layers "F.Cu" "F.Mask"))
   (pad "T" smd rect (at 0 2 90) (size 0.8 0.8) (layers "F.Cu" "F.Paste"))
   (pad "JP" smd custom (at 0 -2 90) (size 0.3 0.3) (layers "F.Cu" "F.Mask") (net 2 "GND")
     (options (clearance outline) (anchor rect))
     (primitives (gr_poly (pts (xy 0.5 -0.75) (xy -0.65 -0.75) (xy -0.15 0) (xy -0.65 0.75) (xy 0.5 0.75)) (width 0) (fill yes))
       (gr_circle (center 0.5 0) (end 0.9 0) (width 0) (fill yes))))
   (pad "" smd rect (at 0 0 90) (size 0.6 0.4) (layers "F.Paste"))
   (pad "" np_thru_hole circle (at 3 3 90) (size 1 1) (drill 1) (layers "F&B.Cu" "*.Mask"))
   (pad "" np_thru_hole circle (at -3 3 90) (size 1 1) (drill 1) (layers "*.Cu" "*.Mask")))`;

async function roundTrip() {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_sch', bytes: enc(SCH) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB.replace(/\)\s*$/, `${FP})`)) }]);
  // Saved and opened again on the way, as a project would be
  const board = readPcbDoc(writePcbDoc(readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc')), 'mini.PcbDoc');
  const out = exportKicad({ name: 'mini', sheets: [], board });
  const pcb = parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes));
  const fp = kids(pcb, 'footprint').find((f) => str(f, 0) === 'Test:Pads')!;
  return { board, fp };
}
/** A pad as the comparison needs it: number, type, shape, place, size, layers, primitives. */
const said = (p: SList) => `${str(p, 0)} ${str(p, 1)} ${str(p, 2)} ${(kid(p, 'at')?.items ?? []).join(' ')} ${(kid(p, 'size')?.items ?? []).join('x')} ${(kid(p, 'layers')?.items ?? []).join(',')}`;

describe('KiCad round trip: pads (R9)', () => {
  it('in Konium: the edge connector and the fiducial without paste, the test point tented, the custom pad a polygon pad, the paste opening a region', async () => {
    const { board } = await roundTrip();
    const j1 = board.components.findIndex((c) => c.designator === 'J1');
    const pads = board.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.component === j1);
    const by = (n: string) => pads.find((p) => p.name === n)!;
    expect(pads.map((p) => p.name).sort()).toEqual(['', '', 'A1', 'FID', 'JP', 'T']);
    for (const n of ['A1', 'FID']) expect(pasteMask(board, by(n))).toBeLessThanOrEqual(-Math.min(by(n).top.w, by(n).top.h) / 2);
    expect(pasteMask(board, by('T'))).toBe(0);
    expect(solderMask(board, by('T'), true)).toBeNull();
    expect(solderMask(board, by('A1'), true)).not.toBeNull();
    expect(board.components[j1]!.bag.get('KICADCONNECT')).toBe('["A1#0"]');
    // The custom pad: its two primitives as its copper, and its mask opening
    const shape = board.prims.filter((p): p is PcbRegion => p.kind === 'region' && p.padShape === 'JP');
    expect(shape.filter((r) => r.layer === L.TOP).length).toBe(2);
    expect(shape.filter((r) => r.layer === L.TOP_SOLDER).length).toBe(2);
    expect(by('JP').shapeKeys?.length).toBe(4);
    // The paste opening alone: a region on the Top Paste, no copper
    const ap = board.prims.filter((p): p is PcbRegion => p.kind === 'region' && !!p.kicadAperture);
    expect(ap.map((r) => r.layer)).toEqual([L.TOP_PASTE]);
  });

  it('back in KiCad: each pad as it was, the custom pad\'s primitives, the paste opening a pad again', async () => {
    const { fp } = await roundTrip();
    const want = kids(parseSexpr(FP.trim()), 'pad');
    const got = kids(fp, 'pad');
    expect(got.map(said).sort()).toEqual(want.map(said).sort());
    const custom = got.find((p) => str(p, 0) === 'JP')!;
    expect(kid(custom, 'primitives')!.items.filter((x): x is SList => typeof x === 'object').map((g) => g.k)).toEqual(['gr_poly', 'gr_circle']);
    expect(kids(kid(kid(custom, 'primitives'), 'gr_poly'), 'pts')[0]!.items.length).toBe(5);
    expect(num(kid(kid(kid(custom, 'primitives'), 'gr_circle'), 'end'), 0)).toBe(0.9);
    // No copper drawn for its shape beside it
    expect(kids(fp, 'fp_poly').filter((g) => /\.(Cu|Mask|Paste)$/.test(str(kid(g, 'layer'), 0) ?? ''))).toEqual([]);
  });

  it('a polygon pad made in Konium goes to KiCad as a custom pad of its shape', async () => {
    const { board } = await roundTrip();
    // Forget the KiCad primitives: the regions are the shape
    for (const p of board.prims) if (p.kind === 'region' && p.kicadPrim) delete p.kicadPrim;
    const out = exportKicad({ name: 'mini', sheets: [], board });
    const fp = kids(parseSexpr(td.decode(out.files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes)), 'footprint').find((f) => str(f, 0) === 'Test:Pads')!;
    const custom = kids(fp, 'pad').find((p) => str(p, 0) === 'JP')!;
    expect(str(custom, 2)).toBe('custom');
    const prims = kid(custom, 'primitives')!.items.filter((x): x is SList => typeof x === 'object');
    expect(prims.map((g) => g.k)).toEqual(['gr_poly', 'gr_poly']);
    // The pentagon's corners about the pad, as KiCad had them (to a micron)
    const pts = kids(kid(prims[0], 'pts'), 'xy').map((v) => [Math.round(num(v, 0) * 1000), Math.round(num(v, 1) * 1000)].join(','));
    expect(pts.sort()).toEqual(['-150,0', '-650,-750', '-650,750', '500,-750', '500,750'].sort());
  });
});
