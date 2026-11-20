import { describe, expect, it } from 'vitest';
import { importEagle } from '../src/formats/eagle/import';
import { exportEagle } from '../src/formats/eagle/write';
import { readEagle } from '../src/formats/eagle/read';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoFiles, demoPcbDoc } from '../src/formats/synthetic/demo';
import { moveComponent, removePrims } from '../src/model/pcbEdit';
import { compileProject } from '../src/model/compile';
import { kid, kidsOf } from '../src/formats/xml';
import { UNITS_PER_MM } from '../src/core/units';
import type { PcbDocument } from '../src/model/pcb';
import type { ExportProject } from '../src/formats/exporters';

/**
 * R13 (26.165), EAGLE's files both ways: a schematic and board read from EAGLE and unchanged are
 * written back as EAGLE wrote them; a board changed only by parts moved and nets rerouted is EAGLE's
 * file with those spliced in; any other change, and the export writes it anew, its signals still
 * named as EAGLE named them so the schematic and board pair.
 */

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const dec = new TextDecoder();

/** EAGLE's files of the demo project (Konium's own export), read back in: what the tests start from. */
async function fromEagle() {
  const board = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const sheets = demoFiles().filter((f) => /\.schdoc$/i.test(f.name)).map((s) => ({ name: s.name, doc: readSchDoc(s.bytes, s.name) }));
  const ex = exportEagle({ name: 'Demo', sheets, board, schLibs: [], pcbLibs: [], hierarchyMode: 2, variables: [] });
  const src = ex.files.filter((f) => /\.(sch|brd)$/.test(f.path)).map((f) => ({ path: f.path.replace(/^Demo\//, 'eagle/'), bytes: f.bytes }));
  const r = await importEagle(src);
  const pr = r.projects[0]!;
  const project = (b?: PcbDocument): ExportProject => ({
    name: 'Demo', sheets: pr.documents.filter((d) => /\.SchDoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) })),
    board: b ?? readPcbDoc(pr.documents.find((d) => /\.PcbDoc$/i.test(d.name))!.bytes, 'Demo.PcbDoc'), schLibs: [], pcbLibs: [], hierarchyMode: 3, variables: [],
  });
  return { src, project, brd: src.find((f) => f.path.endsWith('.brd'))!.bytes, sch: src.find((f) => f.path.endsWith('.sch'))!.bytes };
}
const again = (d: PcbDocument) => readPcbDoc(writePcbDoc(d), d.name);
const fileOf = (r: { files: { path: string; bytes: Uint8Array }[] }, ext: string) => r.files.find((f) => f.path.endsWith(ext))?.bytes;

describe('EAGLE round trip: files kept and spliced (R13)', () => {
  it('unchanged: the .sch and .brd as EAGLE wrote them, under their own name', async () => {
    const f = await fromEagle();
    const r = exportEagle(f.project());
    expect(r.files.map((x) => x.path).filter((p) => /\.(sch|brd)$/.test(p)).sort()).toEqual(['Demo/Demo.brd', 'Demo/Demo.sch']);
    expect(same(fileOf(r, '.brd'), f.brd)).toBe(true);
    expect(same(fileOf(r, '.sch'), f.sch)).toBe(true);
    expect(r.messages.some((m) => /unchanged since EAGLE's file was read/.test(m.message))).toBe(true);
  });

  it('a part moved: EAGLE\'s file with the element at its new place, every other line as it was', async () => {
    const f = await fromEagle();
    const b = f.project().board!;
    const ci = b.components.findIndex((c) => c.layer !== 32);
    const des = b.components[ci]!.designator;
    moveComponent(b, ci, { x: 2 * UNITS_PER_MM, y: UNITS_PER_MM }, 0).apply();
    const r = exportEagle(f.project(again(b)));
    const out = fileOf(r, '.brd')!;
    expect(same(out, f.brd)).toBe(false);
    expect(r.messages.some((m) => /1 part moved, 0 signals rerouted/.test(m.message))).toBe(true);
    const el = (bytes: Uint8Array) => kidsOf(kid(readEagle(bytes).board, 'elements'), 'element');
    const e0 = el(f.brd).find((e) => e.attrs.name === des)!, e1 = el(out).find((e) => e.attrs.name === des)!;
    expect(Number(e1.attrs.x) - Number(e0.attrs.x)).toBeCloseTo(2, 4);
    expect(Number(e1.attrs.y) - Number(e0.attrs.y)).toBeCloseTo(1, 4);
    // Everything but that element's line is EAGLE's
    const a = dec.decode(f.brd).split('\n'), c = dec.decode(out).split('\n');
    expect(c.length).toBe(a.length);
    expect(a.filter((l, i) => l !== c[i]).length).toBeGreaterThanOrEqual(1);
    // (the element's line, and its smashed name and value with it)
    expect(a.filter((l, i) => l !== c[i]).every((l) => l.includes(`name="${des}"`) || l.startsWith('<attribute name='))).toBe(true);
    // And the schematic is EAGLE's still
    expect(same(fileOf(r, '.sch'), f.sch)).toBe(true);
  });

  it('a net rerouted: its signal\'s wires and vias from Konium\'s, the rest EAGLE\'s; read again, the same routes', async () => {
    const f = await fromEagle();
    const b = f.project().board!;
    const track = b.prims.find((q) => q.kind === 'track' && q.net >= 0 && q.net < b.nets.length && q.component === 0xffff && !(q.polygon >= 0 && q.polygon < b.polygons.length))!;
    const net = b.nets[(track as { net: number }).net]!;
    removePrims(b, [track]).apply();
    const r = exportEagle(f.project(again(b)));
    expect(r.messages.some((m) => /0 parts moved, 1 signal rerouted/.test(m.message))).toBe(true);
    const out = fileOf(r, '.brd')!;
    const sig = (bytes: Uint8Array) => kidsOf(kid(readEagle(bytes).board, 'signals'), 'signal').find((s) => s.attrs.name === net.bag.get('EAGLESIGNAL'))!;
    expect(kidsOf(sig(out), 'wire').length).toBe(kidsOf(sig(f.brd), 'wire').length - 1);
    expect(kidsOf(sig(out), 'contactref').length).toBe(kidsOf(sig(f.brd), 'contactref').length);
    // Other signals as they were, character for character
    const others = (bytes: Uint8Array) => dec.decode(bytes).split(/<signal /).slice(1).filter((s) => !s.startsWith(`name="${net.bag.get('EAGLESIGNAL')}"`));
    expect(others(out)).toEqual(others(f.brd));
    // Read again, its copper is Konium's
    const back = await importEagle([{ path: 'x/Demo.sch', bytes: f.sch }, { path: 'x/Demo.brd', bytes: out }]);
    const b2 = readPcbDoc(back.projects[0]!.documents.find((d) => /PcbDoc$/.test(d.name))!.bytes, 'B.PcbDoc');
    const routed = (d: PcbDocument) => d.prims.filter((q) => (q.kind === 'track' || q.kind === 'arc') && q.component === 0xffff && !(q.polygon >= 0 && q.polygon < d.polygons.length) && q.net >= 0 && q.net < d.nets.length).length;
    expect(routed(b2)).toBe(routed(b));
  });

  it('changed otherwise: the board written anew, its signals named as EAGLE named them, pairing with EAGLE\'s schematic', async () => {
    const f = await fromEagle();
    const b = f.project().board!;
    b.board.bag!.set('SNAPGRIDSIZE', '70000'); b.dirty.add('Board6');   // a board setting changed
    const r = exportEagle(f.project(again(b)));
    const out = fileOf(r, '.brd')!;
    expect(same(out, f.brd)).toBe(false);
    expect(r.messages.some((m) => /as EAGLE wrote it but for/.test(m.message))).toBe(false);
    const names = (bytes: Uint8Array) => new Set(kidsOf(kid(readEagle(bytes).board, 'signals'), 'signal').map((s) => s.attrs.name));
    expect(names(out)).toEqual(names(f.brd));
    // The schematic EAGLE's own, every signal with pads one of its nets
    const sch = readEagle(fileOf(r, '.sch')!);
    const schNets = new Set(kidsOf(kid(sch.schematic, 'sheets'), 'sheet').flatMap((sh) => kidsOf(kid(sh, 'nets'), 'net').map((n) => n.attrs.name)));
    const withPads = kidsOf(kid(readEagle(out).board, 'signals'), 'signal').filter((s) => kidsOf(s, 'contactref').length > 1).map((s) => s.attrs.name);
    expect(withPads.length).toBeGreaterThan(0);
    for (const s of withPads) expect(schNets.has(s)).toBe(true);
    // The compile agrees
    expect(compileProject(f.project().sheets, { scope: 3 }).nets.length).toBeGreaterThan(0);
  });
});
