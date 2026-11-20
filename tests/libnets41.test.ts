import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { readPcbLib } from '../src/formats/altium/pcblib';
import { demoFiles, demoPcbDoc, demoSchDoc } from '../src/formats/synthetic/demo';
import { compileProject } from '../src/model/compile';
import { UndoStack } from '../src/core/undo';
import { mm } from '../src/core/units';
import { L } from '../src/model/layers';
import type { PcbDocument, PcbPad } from '../src/model/pcb';
import { addTracks, removePrims, replaceRecords } from '../src/model/pcbEdit';
import { connections } from '../src/model/drc';
import { ipcDefaults, ipcFootprint, ipcRecords, land } from '../src/model/ipcFootprint';
import { readIpcBatch } from '../src/model/ipcBatch';
import { edifNetlist, edifName, multiwireNetlist, pcadNetlist } from '../src/formats/netlists';
import { planJumpers, subnets } from '../src/model/subnets';
import { footprintDifference, libSyncRows } from '../src/model/libSync';
import { applyPhysicalNets, physicalNets } from '../src/model/physicalNets';
import { PAD, put } from '../src/formats/altium/pcbLayouts';

const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
const tx = (f: Parameters<UndoStack['transact']>[1]) => { const u = new UndoStack(); u.transact('t', f); return u; };

describe('IPC-7351B land patterns', () => {
  it('SOIC-8 at nominal density: Z, G, X, the name and pin order', () => {
    const s = ipcDefaults('SOIC');
    const l = land(s.span, s.term, s.leadW, { toe: 0.35, heel: 0.35, side: 0.03, cy: 0.25 });
    expect([l.Z, l.G, l.X]).toEqual([6.95, 2.95, 0.6]);
    const fp = ipcFootprint(s);
    expect(fp.name).toBe('SOIC127P600X175-8N');
    const at = (n: string) => fp.pads.find((p) => p.name === n)!;
    expect(at('1').x).toBeLessThan(0); expect(at('1').y).toBeCloseTo(1.905, 3);
    expect(at('4').y).toBeCloseTo(-1.905, 3);
    expect(at('5').x).toBeGreaterThan(0); expect(at('5').y).toBeCloseTo(-1.905, 3);
    expect(at('8').y).toBeCloseTo(1.905, 3);
    expect(fp.courtyard.w).toBeGreaterThan(l.Z);
  });
  it('chips, quads, PLCC, BGA: names, pad sizes and pin 1', () => {
    const chip = ipcFootprint(ipcDefaults('CHIP'));
    expect(chip.name).toBe('RESC1608X55N');
    expect(chip.pads.map((p) => [p.name, p.w, p.h])).toEqual([['1', 0.9, 0.95], ['2', 0.9, 0.95]]);
    const qfp = ipcFootprint(ipcDefaults('QFP'));
    expect(qfp.name).toBe('QFP50P1200X1200X160-64N');
    const q = (n: string) => qfp.pads.find((p) => p.name === n)!;
    expect(q('1').x).toBeLessThan(0); expect(q('1').y).toBeCloseTo(3.75, 3);
    expect(q('17').y).toBeLessThan(0); expect(q('17').x).toBeCloseTo(-3.75, 3);
    expect(q('33').x).toBeGreaterThan(0); expect(q('33').y).toBeCloseTo(-3.75, 3);
    expect(q('49').y).toBeGreaterThan(0); expect(q('49').x).toBeCloseTo(3.75, 3);
    const plcc = ipcFootprint(ipcDefaults('PLCC'));
    const p1 = plcc.pads.find((p) => p.name === '1')!;
    expect(Math.abs(p1.x)).toBeLessThan(1); expect(p1.y).toBeGreaterThan(0);
    const bga = ipcFootprint(ipcDefaults('BGA'));
    expect(bga.pads).toHaveLength(100);
    expect(bga.pads.some((p) => p.name.startsWith('I'))).toBe(false);
    const a1 = bga.pads.find((p) => p.name === 'A1')!;
    expect([a1.x, a1.y]).toEqual([-4.5, 4.5]);
    expect(a1.w).toBe(0.4);
    const qfn = ipcFootprint(ipcDefaults('QFN'));
    expect(qfn.pads.find((p) => p.name === '33')).toEqual(expect.objectContaining({ x: 0, y: 0, w: 3.3 }));
  });
  it('records: pads on the top, silkscreen, the body and courtyard on mechanical layers, a 3D body', () => {
    const s = ipcDefaults('SOIC'), fp = ipcFootprint(s);
    const recs = ipcRecords(fp, s);
    expect(recs.filter((r) => r.tag === 2)).toHaveLength(8);
    expect(recs.some((r) => r.tag === 12)).toBe(true);
  });
  it('the batch table: families, densities, dimensions, errors', () => {
    const rows = readIpcBatch(['Family,Name,Density,SpanMin,SpanMax,Pins', 'SOIC,,M,5.8,6.2,14', 'CHIP,MYCHIP,L,,,', 'WIDGET,,N,,,', 'QFP,,N,13,12,'].join('\n'));
    expect(rows).toHaveLength(4);
    expect(ipcFootprint(rows[0]!.spec).name).toBe('SOIC127P600X175-14M');
    expect(rows[1]).toEqual(expect.objectContaining({ name: 'MYCHIP' }));
    expect(rows[1]!.spec.density).toBe('L');
    expect(rows[2]!.error).toMatch(/Unknown family/);
    expect(rows[3]!.error).toMatch(/min above max/);
  });
});

describe('netlists', () => {
  const res = compileProject([{ name: 'Demo.SchDoc', doc: readSchDoc(demoSchDoc(), 'Demo.SchDoc') }]);
  it('EDIF: balanced, a cell per part, instances and joined nets; names renamed when EDIF can\'t take them', () => {
    const t = edifNetlist(res, 'Demo', new Date(2026, 9, 27));
    let depth = 0;
    for (const ch of t) { if (ch === '(') depth++; if (ch === ')') depth--; expect(depth).toBeGreaterThanOrEqual(0); }
    expect(depth).toBe(0);
    expect(t).toMatch(/\(edif Demo/);
    expect(t).toMatch(/\(instance U1/);
    expect(t).toMatch(/\(net GND\s+\(joined(\s+\(portRef &?\w+ \(instanceRef \w+\)\))+/);
    expect(edifName('+3V3')).toBe('(rename &_3V3 "+3V3")');
    expect(edifName('1')).toBe('(rename &1 "1")');
  });
  it('P-CAD and MultiWire', () => {
    const p = pcadNetlist(res);
    expect(p).toMatch(/^\{COMPONENT PCB\.PCB/);
    expect(p).toMatch(/\{I \S+\.PRT U1\r\n    \{CN\r\n(     \S+ \S+\r\n)+    \}/);
    const m = multiwireNetlist(res, 'Demo');
    expect(m).toMatch(/^NETLIST\r\nDESIGN Demo/);
    expect(m).toMatch(/\r\nNETS\r\n/);
    expect(m).toMatch(/\r\nGND\r\n(  \w+-\w+\r\n)+/);
  });
});

describe('subnet jumpers and physical nets', () => {
  it('a net split in two pieces is joined by a jumper on the current layer', () => {
    const doc = demo();
    // Take the middle out of a top-layer track run: its net falls in two pieces
    const t = doc.prims.find((p) => p.kind === 'track' && p.layer === L.TOP && Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) > mm(3))!;
    tx((x) => x.add(removePrims(doc, [t])));
    const before = connections(doc).length;
    expect([...subnets(doc).keys()]).toContain((t as { net: number }).net);
    const { jumpers } = planJumpers(doc, L.TOP, mm(50));
    expect(jumpers.length).toBeGreaterThan(0);
    tx((x) => x.add(addTracks(doc, jumpers.map((j) => ({ layer: j.layer, a: j.a, b: j.b, width: j.width, net: j.net })))));
    expect(connections(doc).length).toBeLessThan(before);
    expect(subnets(doc).has((t as { net: number }).net)).toBe(false);
  });
  it('copper joining two nets shows as a piece to settle; settling puts it on one net', () => {
    const doc = demo();
    const pads = doc.prims.filter((p): p is PcbPad => p.kind === 'pad' && p.layer === L.TOP && p.net !== 0xffff);
    const a = pads[0]!, b = pads.find((p) => p.net !== a.net)!;
    tx((x) => x.add(addTracks(doc, [{ layer: L.TOP, a: a.at, b: b.at, width: mm(0.2), net: a.net }])));
    const rows = physicalNets(doc);
    const bad = rows.filter((r) => r.conflict);
    expect(bad.length).toBeGreaterThan(0);
    const r = bad.find((x) => x.nets.includes(doc.nets[a.net]!.name) && x.nets.includes(doc.nets[b.net]!.name))!;
    expect(r).toBeTruthy();
    tx((x) => applyPhysicalNets(doc, [{ prims: r.prims, net: 'MERGED' }], (c) => x.add(c)));
    expect(doc.nets.some((n) => n.name === 'MERGED')).toBe(true);
    expect(physicalNets(doc).find((x) => x.nets.includes('MERGED'))!.nets).toEqual(['MERGED']);
  });
});

describe('Update From PCB Libraries', () => {
  it('the demo board matches Demo.PcbLib; a pad moved shows as different', () => {
    const doc: PcbDocument = demo();
    const lib = readPcbLib(demoFiles().find((f) => f.name === 'Demo.PcbLib')!.bytes, 'Demo.PcbLib');
    const find = (name: string) => { const f = lib.footprints.find((x) => x.name.toLowerCase() === name.toLowerCase()); return f ? { library: lib.name, footprint: f } : undefined; };
    const rows = libSyncRows(doc, find);
    expect(rows.filter((r) => r.status === 'Different').map((r) => `${r.designator}: ${r.why}`)).toEqual([]);
    const pad = doc.prims.find((p): p is PcbPad => p.kind === 'pad' && doc.components[p.component]?.designator === 'U1')!;
    const rec = doc.streams.get(pad.src.storage)!.records[pad.src.index]!;
    const subs = rec.subs.map((s) => s.slice());
    put(subs[4]!, PAD.x, pad.at.x + mm(0.3));
    tx((x) => x.add(replaceRecords(doc, [{ storage: pad.src.storage, index: pad.src.index, after: { tag: rec.tag, subs } }])));
    const u1 = doc.components.findIndex((c) => c.designator === 'U1');
    expect(footprintDifference(doc, u1, find(doc.components[u1]!.pattern)!.footprint.prims)).toMatch(/pad \S+ is elsewhere/);
  });
});

