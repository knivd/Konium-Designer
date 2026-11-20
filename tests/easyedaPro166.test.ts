import { describe, expect, it } from 'vitest';
import { demoFiles, demoPcbDoc } from '../src/formats/synthetic/demo';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { DIR_VECTORS, ownedBy, type SchDocument } from '../src/model/sch';
import { readStack } from '../src/model/pcbStack';
import { unzipEntries } from '../src/formats/xlsxRead';
import { EXPORTERS } from '../src/formats/exporters';
import { exportEasyedaPro } from '../src/formats/easyeda/writePro';
import { importEasyeda } from '../src/formats/easyeda/import';
import { readEasyedaPro, v2Recs } from '../src/formats/easyeda/proRead';
import type { PcbDocument } from '../src/model/pcb';
import type { ExportProject } from '../src/formats/exporters';

/**
 * R14 (26.166), EasyEDA Pro export: the project as an EasyEDA Pro project (.epro) that Konium's own
 * EasyEDA Pro import reads back with the same parts, nets, pads, routes, vias and pours.
 */

function project(): ExportProject {
  const board = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  const sheets = demoFiles().filter((f) => /\.schdoc$/i.test(f.name)).map((s) => ({ name: s.name, doc: readSchDoc(s.bytes, s.name) }));
  return { name: 'Demo', sheets, board, schLibs: [], pcbLibs: [], hierarchyMode: 2, variables: [] };
}
const td = new TextDecoder();
async function filesOf(epro: Uint8Array): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const e of unzipEntries(epro)) if (!e.name.endsWith('/')) m.set(e.name, td.decode(await e.data()));
  return m;
}
async function roundTrip() {
  const p = project();
  const r = exportEasyedaPro(p);
  expect(r.files.map((f) => f.path)).toEqual(['Demo/Demo.epro']);
  const back = await importEasyeda(r.files);
  const pr = back.projects[0]!;
  const sheets = pr.documents.filter((d) => /\.SchDoc$/i.test(d.name)).map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) }));
  const board = readPcbDoc(pr.documents.find((d) => /\.PcbDoc$/i.test(d.name))!.bytes, 'B.PcbDoc');
  return { p, r, back, sheets, board };
}
const key = (l: string[]) => [...l].sort().join(',');
const netlist = (c: ReturnType<typeof compileProject>) => new Set(c.nets.filter((n) => n.pins.length > 1).map((n) => key(n.pins.map((q) => `${q.designator}.${q.pin}`))));

describe('EasyEDA Pro export (R14)', () => {
  it('is an Export Wizard type, and writes one .epro: project.json, the pages, the board, symbols, footprints, poured copper', async () => {
    expect(EXPORTERS.some((e) => e.id === 'easyedapro' && /EasyEDA Pro/.test(e.label))).toBe(true);
    const r = exportEasyedaPro(project());
    const f = await filesOf(r.files[0]!.bytes);
    const prj = JSON.parse(f.get('project.json')!) as { schematics: Record<string, { sheets: { id: number }[] }>; pcbs: Record<string, string>; boards: Record<string, { schematic: string; pcb: string }>;
      symbols: Record<string, { type: number }>; footprints: Record<string, unknown>; devices: Record<string, { attributes: Record<string, string> }> };
    const [schId] = Object.keys(prj.schematics), [pcbId] = Object.keys(prj.pcbs);
    expect(prj.boards.Demo).toEqual({ schematic: schId, pcb: pcbId });
    for (const sh of prj.schematics[schId!]!.sheets) expect(f.has(`SHEET/${schId}/${sh.id}.esch`)).toBe(true);
    expect(f.has(`PCB/${pcbId}.epcb`)).toBe(true);
    for (const id of Object.keys(prj.symbols)) expect(f.has(`SYMBOL/${id}.esym`)).toBe(true);
    for (const id of Object.keys(prj.footprints)) expect(f.has(`FOOTPRINT/${id}.efoo`)).toBe(true);
    expect([...f.keys()].some((n) => /^POUR\/.+\.ecop$/.test(n))).toBe(true);
    // Every device's symbol and footprint are in the project; flags and ports are symbols of their kind
    for (const d of Object.values(prj.devices)) {
      expect(prj.symbols[d.attributes.Symbol!]).toBeDefined();
      if (d.attributes.Footprint) expect(prj.footprints[d.attributes.Footprint]).toBeDefined();
    }
    expect(Object.values(prj.symbols).some((s) => s.type === 18)).toBe(true);
    // Records as EasyEDA lays them out: a pad's 22 fields, a board attribute's 22, a schematic attribute's 12
    const pcb = v2Recs(f.get(`PCB/${pcbId}.epcb`)!);
    for (const fp of Object.keys(prj.footprints)) for (const q of v2Recs(f.get(`FOOTPRINT/${fp}.efoo`)!)) if (q[0] === 'PAD') expect(q).toHaveLength(22);
    for (const q of pcb) if (q[0] === 'ATTR') expect(q).toHaveLength(22);
    for (const [n, t] of f) if (n.endsWith('.esch')) for (const q of v2Recs(t)) if (q[0] === 'ATTR') expect(q).toHaveLength(12);
    // The schematic's parts and the board's share their Unique IDs
    const schUid = new Map<string, string>();
    for (const [n, t] of f) if (n.endsWith('.esch')) {
      const recs = v2Recs(t);
      for (const c of recs.filter((q) => q[0] === 'COMPONENT')) {
        const at = (k: string) => recs.find((q) => q[0] === 'ATTR' && q[2] === c[1] && q[3] === k)?.[4] as string | undefined;
        if (at('Unique ID')) schUid.set(at('Designator')!, at('Unique ID')!);
      }
    }
    const comps = pcb.filter((q) => q[0] === 'COMPONENT');
    expect(comps.length).toBe(4);
    for (const c of comps) {
      const des = pcb.find((q) => q[0] === 'ATTR' && q[3] === c[1] && q[7] === 'Designator')![8] as string;
      expect((c[7] as Record<string, string>)['Unique ID']).toBe(schUid.get(des));
    }
    // And Konium's own EasyEDA Pro reader takes it as a project with its board
    const pro = await readEasyedaPro('Demo.epro', r.files[0]!.bytes);
    expect(pro.boards).toEqual([{ name: 'Demo', schematic: schId, pcb: pcbId }]);
  });

  it('read back: the same parts and nets, every pin end where it was (parts turned and mirrored as placed)', async () => {
    const { p, sheets } = await roundTrip();
    const a = compileProject(p.sheets, { scope: 2 }), b = compileProject(sheets, { scope: 3 });
    expect(b.components.map((x) => x.designator).sort()).toEqual(a.components.map((x) => x.designator).sort());
    const nb = netlist(b);
    for (const n of netlist(a)) expect(nb.has(n)).toBe(true);
    const ends = (doc: SchDocument) => {
      const m = new Map<string, { x: number; y: number }>();
      const own = ownedBy(doc);
      for (const o of doc.objects) {
        if (o.kind !== 'component') continue;
        for (const k of own.get(o.index) ?? []) {
          if (k.kind !== 'pin' || (k.ownerPartId > 0 && k.ownerPartId !== o.partId)) continue;
          const d = DIR_VECTORS[k.orient & 3]!;
          m.set(`${o.designator}.${k.designator}`, { x: k.at.x + d.x * k.length, y: k.at.y + d.y * k.length });
        }
      }
      return m;
    };
    let n = 0;
    for (const s of p.sheets) {
      const t = sheets.find((x) => x.name === s.name)!;
      const e0 = ends(s.doc), e1 = ends(t.doc);
      let off: { x: number; y: number } | undefined;
      for (const [k, v] of e0) {
        const w = e1.get(k)!;
        off ??= { x: w.x - v.x, y: w.y - v.y };
        expect(Math.hypot(w.x - v.x - off.x, w.y - v.y - off.y)).toBeLessThan(100);
        n++;
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it('read back: the board\'s parts where they were, pads on their nets, every net routed as before, vias, pours with their copper, the stack', async () => {
    const { p, back, board } = await roundTrip();
    const b0 = p.board!;
    expect(back.messages.some((m) => /not poured|no poured copper/.test(m.message))).toBe(false);
    expect(board.components.length).toBe(b0.components.length);
    for (const c of b0.components) {
      const d = board.components.find((x) => x.designator === c.designator)!;
      expect(d.layer).toBe(c.layer);
      expect(((c.rotation - d.rotation) % 360 + 360) % 360).toBeCloseTo(0, 3);
      expect(Math.hypot(c.at.x - b0.board.origin.x - (d.at.x - board.board.origin.x), c.at.y - b0.board.origin.y - (d.at.y - board.board.origin.y))).toBeLessThan(100);
    }
    const pads = (d: PcbDocument) => new Map(d.prims.filter((q) => q.kind === 'pad' && q.component >= 0 && q.component < d.components.length)
      .map((q) => (q.kind === 'pad' ? [`${d.components[q.component]!.designator}.${q.name}`, { net: d.nets[q.net]?.name ?? '', x: q.at.x - d.board.origin.x, y: q.at.y - d.board.origin.y, w: q.top.w, h: q.top.h, hole: q.hole }] : ['', null])));
    const pa = pads(b0), pb = pads(board);
    expect(pb.size).toBe(pa.size);
    for (const [k, v] of pa) {
      const w = pb.get(k)!;
      expect(w.net).toBe(v!.net);
      expect(Math.hypot(w.x - v!.x, w.y - v!.y)).toBeLessThan(100);
      expect(Math.abs(w.w - v!.w) + Math.abs(w.h - v!.h) + Math.abs(w.hole - v!.hole)).toBeLessThan(10);
    }
    const routed = (d: PcbDocument) => {
      const m = new Map<string, number>();
      for (const q of d.prims) {
        if ((q.kind !== 'track' && q.kind !== 'arc') || (q.component >= 0 && q.component < d.components.length) || q.net < 0 || q.net >= d.nets.length || (q.polygon >= 0 && q.polygon < d.polygons.length)) continue;
        const k = `${d.nets[q.net]!.name}@${q.layer}`;
        const l = q.kind === 'track' ? Math.hypot(q.b.x - q.a.x, q.b.y - q.a.y) : q.r * (((((q.end - q.start) % 360) + 360) % 360 || 360) * Math.PI) / 180;
        m.set(k, (m.get(k) ?? 0) + l);
      }
      return m;
    };
    const ra = routed(b0), rb = routed(board);
    expect([...rb.keys()].sort()).toEqual([...ra.keys()].sort());
    for (const [k, v] of ra) expect(Math.abs(rb.get(k)! - v)).toBeLessThan(Math.max(500, v * 0.001));
    expect(board.prims.filter((q) => q.kind === 'via').length).toBe(b0.prims.filter((q) => q.kind === 'via').length);
    expect(board.polygons.map((q) => [q.layer, board.nets[q.net]?.name])).toEqual(b0.polygons.map((q) => [q.layer, b0.nets[q.net]?.name]));
    expect(board.prims.some((q) => q.kind === 'region' && q.polygon === 0)).toBe(true);
    // The stack: the dielectric's thickness (the physical rows' order)
    const dz = (d: PcbDocument) => readStack(d.board.bag!, d.board.copperStack).filter((x) => x.kind === 'dielectric').map((x) => Math.round(x.height / 100));
    expect(dz(board)).toEqual(dz(b0));
  });
});
