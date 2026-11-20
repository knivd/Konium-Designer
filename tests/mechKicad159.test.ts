import { describe, expect, it } from 'vitest';
import { importKicad } from '../src/formats/kicad/project';
import { exportKicad } from '../src/formats/kicad/export';
import { encodeTrack, readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { mechKinds, mechPairs, setMechLayout } from '../src/model/pcbBoard';
import { moveComponent } from '../src/model/pcbEdit';
import { UndoStack } from '../src/core/undo';
import { mil } from '../src/core/units';
import { mechLayer } from '../src/model/layers';
import { parseSexpr, kid, kids, str, type SList } from '../src/formats/kicad/sexpr';
import type { PcbDocument } from '../src/model/pcb';
import { PCB, PRO } from './fixtures/kicadMini';

/**
 * R9, mechanical layer types both ways: a KiCad board's Fab and courtyard layers read as the
 * desktop software's Assembly and Courtyard types, paired (with the glue layers) so a footprint
 * flipped in Konium takes them to the other side; a board from the desktop software written to
 * KiCad with its typed layers on the KiCad layers of that kind, whatever their numbers.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const td = new TextDecoder();
const M = mechLayer;

async function kicadBoard(): Promise<PcbDocument> {
  const r = await importKicad([{ path: 'mini/mini.kicad_pro', bytes: enc(PRO) }, { path: 'mini/mini.kicad_pcb', bytes: enc(PCB) }]);
  return readPcbDoc(r.projects[0]!.documents.find((d) => d.name === 'mini.PcbDoc')!.bytes, 'mini.PcbDoc');
}
const pcbOf = (doc: PcbDocument): SList => parseSexpr(td.decode(exportKicad({ name: 'mini', sheets: [], board: doc }).files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes));
const refOf = (f: SList) => str(kids(f, 'property').find((p) => str(p, 0) === 'Reference')!, 1);

describe('Mechanical layer types and KiCad (R9)', () => {
  it('a KiCad board: Fab as Assembly, CrtYd as Courtyard, paired; a footprint flipped takes its courtyard to B.CrtYd', async () => {
    const doc = await kicadBoard();
    const k = mechKinds(doc);
    expect([k.get(M(13)), k.get(M(14)), k.get(M(15)), k.get(M(16)), k.get(M(1))]).toEqual(['AssemblyTop', 'AssemblyBottom', 'CourtyardTop', 'CourtyardBottom', 'BoardShape']);
    expect(mechPairs(doc)).toEqual([[M(13), M(14)], [M(15), M(16)], [M(9), M(10)]]);
    const i = doc.components.findIndex((c) => c.designator === 'R1');
    moveComponent(doc, i, { x: 0, y: 0 }, 0, { flip: true }).apply();
    const t = pcbOf(readPcbDoc(writePcbDoc(doc), 'mini.PcbDoc'));
    const r1 = kids(t, 'footprint').find((f) => refOf(f) === 'R1')!;
    expect(str(kid(r1, 'layer'), 0)).toBe('B.Cu');
    expect(kids(r1, 'fp_line').map((l) => str(kid(l, 'layer'), 0))).toContain('B.CrtYd');
    expect(kids(r1, 'fp_line').map((l) => str(kid(l, 'layer'), 0))).not.toContain('F.CrtYd');
  });

  it('a board from the desktop software: typed layers on KiCad\'s layers of that kind, an untyped one by its number, another type on a user layer', () => {
    let doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const u = new UndoStack();
    u.transact('types', (tx) => tx.add(setMechLayout(doc, new Map([[M(20), 'AssemblyTop'], [M(21), 'CourtyardTop'], [M(13), '3DBodyTop']]), [])));
    const at = doc.components[0]!.at;
    for (const n of [20, 21, 13, 3]) {
      doc.streams.get('Tracks6')!.records.push(encodeTrack({ layer: M(n), a: { x: at.x + mil(n * 10), y: at.y + mil(400) }, b: { x: at.x + mil(n * 10 + 50), y: at.y + mil(400) }, width: mil(5 + n / 10) }));
    }
    doc.dirty.add('Tracks6');
    doc = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    const t = pcbOf(doc);
    const byWidth = (w: number) => kids(t, 'gr_line').find((l) => Math.abs(Number(kid(kid(l, 'stroke'), 'width')?.items[0]) - w * 0.0254) < 1e-4);
    const layerOf = (n: number) => str(kid(byWidth(5 + n / 10)!, 'layer'), 0);
    expect(layerOf(20)).toBe('F.Fab');
    expect(layerOf(21)).toBe('F.CrtYd');
    // Mechanical 13 is F.Fab by number, but its type is a 3D body's: a user layer, F.Fab being the assembly layer's
    expect(layerOf(13)).toMatch(/^User\.\d$/);
    expect(layerOf(3)).toBe('Cmts.User');
  });
});
