import { describe, expect, it } from 'vitest';
import { demoFiles } from '../src/formats/synthetic/demo';
import { load } from '../src/formats/registry';
import { exportKicad } from '../src/formats/kicad/export';
import { kicadTransform } from '../src/formats/kicad/exportSch';
import { fracture } from '../src/formats/kicad/exportPcb';
import { adOrientation, symbolTransform } from '../src/formats/kicad/schematic';
import { kicadMarkup, kuuid } from '../src/formats/kicad/write';
import { importKicad } from '../src/formats/kicad/project';
import { parseSexpr, kids, kid, str } from '../src/formats/kicad/sexpr';
import { compileProject } from '../src/model/compile';
import { connections } from '../src/model/drc';
import { planeCopper } from '../src/model/planes';
import { signedArea } from '../src/formats/features';
import { readPrjPcb, iniGet } from '../src/formats/altium/prjpcb';
import type { SchDocument } from '../src/model/sch';
import type { PcbDocument } from '../src/model/pcb';
import { mil } from '../src/core/units';
import { assemblePcbDoc, applyStackLayers } from '../src/formats/altium/assemble';
import { newBoardRecord } from '../src/formats/altium/board6';
import { encodeVia, readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { defaultGerberSetup, gerberFiles } from '../src/formats/gerber/gerber';
import { ipc2581 } from '../src/formats/ipc2581';

const td = new TextDecoder();
function demo() {
  const files = demoFiles();
  const prj = files.find((f) => /\.prjpcb$/i.test(f.name))!;
  const docs = files.filter((f) => /\.(schdoc|pcbdoc)$/i.test(f.name)).map((f) => load(f.bytes, f.name));
  return {
    sheets: docs.filter((d): d is SchDocument => d.kind === 'SchDoc').map((d) => ({ name: d.name, doc: d })),
    board: docs.find((d): d is PcbDocument => d.kind === 'PcbDoc')!,
    mode: Number(iniGet(readPrjPcb(prj.bytes, prj.name), 'Design', 'HierarchyMode') ?? 0),
  };
}

describe('KiCad export (26.051)', () => {
  it('turns and mirrors parts as AD places them', () => {
    for (const mirrored of [false, true]) for (let o = 0; o < 4; o++) {
      const t = kicadTransform(o, mirrored);
      expect(adOrientation(symbolTransform(t.angle, t.mirror))).toEqual({ orient: o, mirrored });
    }
  });

  it('writes AD overbars as KiCad markup and deterministic UUIDs', () => {
    expect(kicadMarkup('R\\S\\T\\')).toBe('~{RST}');
    expect(kicadMarkup('C\\S\\_N')).toBe('~{CS}_N');
    expect(kuuid('a')).toBe(kuuid('a'));
    expect(kuuid('a')).not.toBe(kuuid('b'));
    expect(kuuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('joins a region\'s holes to its outline (KiCad\'s one outline)', () => {
    const sq = (x0: number, y0: number, s: number) => [{ x: x0, y: y0 }, { x: x0 + s, y: y0 }, { x: x0 + s, y: y0 + s }, { x: x0, y: y0 + s }];
    const ring = fracture(sq(0, 0, 100), [sq(20, 20, 10), sq(60, 50, 20)]);
    expect(ring.length).toBe(4 + 2 * (4 + 3));
    expect(Math.abs(signedArea(ring))).toBeCloseTo(10000 - 100 - 400, 6);
  });

  it('exports the demo project: KiCad files, and back they compile to the same nets and board', async () => {
    const d = demo();
    const r = exportKicad({ name: 'Demo', sheets: d.sheets, board: d.board, hierarchyMode: d.mode });
    const names = r.files.map((f) => f.path);
    expect(names).toContain('Demo/Demo.kicad_pro');
    expect(names).toContain('Demo/Demo.kicad_sch');
    expect(names).toContain('Demo/Demo.kicad_pcb');
    expect(names).toContain('Demo/Demo.kicad_sym');
    expect(names).toContain('Demo/sym-lib-table');
    expect(names).toContain('Demo/fp-lib-table');
    expect(names.some((n) => /^Demo\/Demo\.pretty\/.+\.kicad_mod$/.test(n))).toBe(true);
    expect(r.messages.filter((m) => m.level === 'error')).toEqual([]);
    // The project file is JSON KiCad reads
    const pro = JSON.parse(td.decode(r.files.find((f) => f.path.endsWith('.kicad_pro'))!.bytes));
    expect(pro.meta.filename).toBe('Demo.kicad_pro');
    expect(pro.net_settings.classes[0].name).toBe('Default');
    // Every schematic parses, the root's instances start at its UUID
    const root = parseSexpr(td.decode(r.files.find((f) => f.path === 'Demo/Demo.kicad_sch')!.bytes));
    const rootUuid = str(kid(root, 'uuid'));
    for (const f of r.files.filter((x) => x.path.endsWith('.kicad_sch'))) {
      const t = parseSexpr(td.decode(f.bytes));
      for (const s of kids(t, 'symbol')) for (const p of kids(kid(kid(s, 'instances'), 'project'), 'path')) expect(str(p)!.startsWith(`/${rootUuid}`)).toBe(true);
    }
    // Back in: the same nets and the same board
    const back = await importKicad(r.files.filter((f) => /\.kicad_(pro|sch|pcb)$/.test(f.path)));
    expect(back.messages.filter((m) => m.level === 'error')).toEqual([]);
    const docs = back.projects[0]!.documents.map((x) => load(x.bytes, x.name));
    const sheets2 = docs.filter((x): x is SchDocument => x.kind === 'SchDoc').map((x) => ({ name: x.name, doc: x }));
    const board2 = docs.find((x): x is PcbDocument => x.kind === 'PcbDoc')!;
    const sets = (c: ReturnType<typeof compileProject>) => new Set(c.nets.filter((n) => n.pins.length > 1).map((n) => n.pins.map((p) => `${p.designator}.${p.pin}`).sort().join(' ')));
    expect(sets(compileProject(sheets2, { scope: 2 }))).toEqual(sets(compileProject(d.sheets, { scope: d.mode })));
    const padNets = (b: PcbDocument) => new Map(b.prims.filter((p) => p.kind === 'pad').map((p) => [`${b.components[(p as { component: number }).component]?.designator}.${(p as { name: string }).name}`, b.nets[(p as { net: number }).net]?.name]));
    expect(padNets(board2)).toEqual(padNets(d.board));
    expect(connections(board2).length).toBe(connections(d.board).length);
    for (const c of d.board.components) {
      const c2 = board2.components.find((x) => x.designator === c.designator)!;
      expect(c2.layer).toBe(c.layer);
      expect(Math.abs(c2.at.x - c.at.x - (board2.board.origin.x - d.board.board.origin.x))).toBeLessThan(5);
    }
  });
});

describe('Internal planes as copper (26.051)', () => {
  /** A 1000 mil board with a GND plane, a GND via and a SIG via through it. */
  function planeBoard(): PcbDocument {
    const outline = [{ p: { x: 0, y: 0 } }, { p: { x: mil(1000), y: 0 } }, { p: { x: mil(1000), y: mil(1000) } }, { p: { x: 0, y: mil(1000) } }];
    const doc = assemblePcbDoc({ board: newBoardRecord({ fileName: 'P.PcbDoc', origin: { x: 0, y: 0 }, outline }), nets: ['GND', 'SIG'], comps: [],
      vias: [encodeVia({ at: { x: mil(300), y: mil(300) }, diameter: mil(24), hole: mil(12), net: 0 }), encodeVia({ at: { x: mil(600), y: mil(600) }, diameter: mil(24), hole: mil(12), net: 1 })] }, 'P.PcbDoc');
    applyStackLayers(doc, [{}, { plane: true, net: 'GND' }, {}], [{}, {}]);
    return readPcbDoc(writePcbDoc(doc), 'P.PcbDoc');
  }
  it('a plane layer\'s copper: the board less its pullback, other nets\' holes cleared, the net\'s relieved', () => {
    const doc = planeBoard();
    const plane = doc.board.copperStack.find((l) => l >= 39 && l <= 54)!;
    expect(plane).toBeDefined();
    // (saved, the GND plane is a split over the board, as AD keeps it: the layer's own area is empty)
    const areas = planeCopper(doc, plane).filter((a) => a.regions.length);
    expect(areas.length).toBe(1);
    expect(doc.nets[areas[0]!.net]!.name).toBe('GND');
    const main = areas[0]!.regions.sort((a, b) => Math.abs(signedArea(b.outline)) - Math.abs(signedArea(a.outline)))[0]!;
    // Pulled back 20 mil from the edge
    const xs = main.outline.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(mil(20), -3);
    // The SIG via's clearance and the GND via's relief (four air gaps round it): holes
    expect(main.holes.length).toBe(5);
    expect(areas[0]!.regions.length).toBe(1);
    // Gerber plots it (positive copper), IPC-2581 too
    const { files } = gerberFiles(doc, defaultGerberSetup(doc));
    const gp = files.find((f) => /\.GP1$/i.test(f.name));
    expect(gp?.text).toMatch(/G36\*/);
    expect(ipc2581(doc)).toMatch(/layerFunction="PLANE"/);
  });
  it('KiCad: the plane a power layer, its zone filled with that copper', () => {
    const doc = planeBoard();
    const r = exportKicad({ name: 'P', sheets: [], board: doc });
    const pcb = parseSexpr(td.decode(r.files.find((f) => f.path.endsWith('.kicad_pcb'))!.bytes));
    const layers = kid(pcb, 'layers')!.items.filter((x) => typeof x === 'object') as { k: string; items: unknown[] }[];
    expect(layers.some((l) => l.items[0] === 'In1.Cu' && l.items[1] === 'power')).toBe(true);
    const zones = kids(pcb, 'zone').filter((z) => str(kid(z, 'layer')) === 'In1.Cu');
    expect(zones.length).toBe(1);
    expect(str(kid(zones[0], 'net_name'))).toBe('GND');
    expect(kids(zones[0], 'filled_polygon').length).toBe(1);
  });
});
