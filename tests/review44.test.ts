import { describe, expect, it } from 'vitest';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { newSchDoc, readSchDoc } from '../src/formats/altium/schdoc';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { SR, type SchDocument } from '../src/model/sch';
import { compileProject } from '../src/model/compile';
import { addRecords, junctionBag, removeObjects, reorderObjects, wireBag } from '../src/model/schEdit';
import { crossJunctionChanges } from '../src/model/crossJunctions';
import { planAnnotation } from '../src/model/annotate';
import { mil } from '../src/core/units';
import type { Vec2 } from '../src/core/geom';

function sheet(name: string, build: (b: SchBuilder, part: (des: string, x: number, y: number, uid: string, o?: { parts?: number; part?: number; lib?: string; comment?: string; kind?: number }) => void) => void) {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0 });
  const part = (des: string, x: number, y: number, uid: string, o: { parts?: number; part?: number; lib?: string; comment?: string; kind?: number } = {}) => {
    const ci = b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: o.lib ?? 'Res', PARTCOUNT: (o.parts ?? 1) + 1, CURRENTPARTID: o.part ?? 1, OWNERPARTID: -1, DISPLAYMODECOUNT: 1, UNIQUEID: uid,
      ...(o.kind !== undefined ? { COMPONENTKINDVERSION2: o.kind } : {}) }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: o.part ?? 1, PINCONGLOMERATE: 2 | 0x18, PINLENGTH: 10, NAME: '1', DESIGNATOR: '1', ELECTRICAL: 4 }, { LOCATION: { x, y } });
    b.add({ RECORD: SR.PIN, OWNERINDEX: ci, OWNERPARTID: o.part ?? 1, PINCONGLOMERATE: 0 | 0x18, PINLENGTH: 10, NAME: '2', DESIGNATOR: '2', ELECTRICAL: 4 }, { LOCATION: { x: x + 40, y } });
    b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: des }, { LOCATION: { x, y: y + 10 } });
    if (o.comment) b.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Comment', TEXT: o.comment }, { LOCATION: { x, y: y - 10 } });
  };
  build(b, part);
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  return { name, doc: readSchDoc(writeCfb(root), name) };
}
function symbol(b: SchBuilder, designator: string, file: string, x: number, uid: string, entries: string[]) {
  const s = b.add({ RECORD: SR.SHEET_SYMBOL, OWNERPARTID: -1, XSIZE: 200, YSIZE: 100, UNIQUEID: uid }, { LOCATION: { x, y: 500 } });
  b.add({ RECORD: SR.SHEET_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: designator }, { LOCATION: { x, y: 502 } });
  b.add({ RECORD: SR.FILE_NAME, OWNERINDEX: s, OWNERPARTID: -1, TEXT: file }, { LOCATION: { x, y: 390 } });
  entries.forEach((name, i) => b.add({ RECORD: SR.SHEET_ENTRY, OWNERINDEX: s, OWNERPARTID: -1, DISTANCEFROMTOP: 1 + i * 2, NAME: name, IOTYPE: 2 }));
}
// The channel: R2 pin 1 to port A, R2 pin 2 to R3 pin 1
const channel = sheet('Chan.SchDoc', (b, part) => {
  part('R2', 400, 300, 'RTWOUIDX');
  part('R3', 500, 300, 'RTHREEID');
  b.add({ RECORD: SR.PORT, OWNERPARTID: -1, NAME: 'A', STYLE: 3, IOTYPE: 2, WIDTH: 50, HEIGHT: 10 }, { LOCATION: { x: 300, y: 300 } });
  b.wire([350, 300], [390, 300]);
  b.wire([440, 300], [490, 300]);
});
const pins = (n: { pins: { designator: string; pin: string }[] }) => n.pins.map((p) => `${p.designator}-${p.pin}`).join(' ');

describe('compile (review fixes)', () => {
  it('net labels join whatever their case, under the first name', () => {
    const s = sheet('S.SchDoc', (b, part) => {
      part('R1', 100, 100, 'AAAAAAAA');
      part('R2', 100, 300, 'BBBBBBBB');
      b.wire([140, 100], [200, 100]);
      b.wire([140, 300], [200, 300]);
      b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'VCC' }, { LOCATION: { x: 200, y: 100 } });
      b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'vcc' }, { LOCATION: { x: 200, y: 300 } });
    });
    const r = compileProject([s]);
    const n = r.nets.filter((x) => x.pins.some((p) => p.pin === '2'));
    expect(n.map((x) => [x.name.toUpperCase(), pins(x)])).toEqual([['VCC', 'R1-2 R2-2']]);
  });
  it('one child under two symbols: each symbol\'s entry joins only its own parent net', () => {
    const top = sheet('Top.SchDoc', (b, part) => {
      symbol(b, 'LEFT', 'Chan.SchDoc', 300, 'SYMLEFTX', ['A']);
      symbol(b, 'RIGHT', 'Chan.SchDoc', 700, 'SYMRIGHT', ['A']);
      part('R1', 100, 490, 'RONEUIDX');
      part('R9', 550, 490, 'RNINEUID');
      b.wire([150, 490], [300, 490]);
      b.wire([590, 490], [700, 490]);
    });
    const r = compileProject([top, channel]);
    expect(pins(r.nets.find((n) => n.pins.some((p) => p.designator === 'R1'))!)).toBe('R1-2 R2_LEFT-1');
    expect(pins(r.nets.find((n) => n.pins.some((p) => p.designator === 'R9' && p.pin === '2'))!)).toBe('R2_RIGHT-1 R9-2');
  });
  it('Repeat(A) entries: each channel\'s port A is a net of its own, A1 and A2', () => {
    const top = sheet('Top.SchDoc', (b) => { symbol(b, 'Repeat(CH,1,2)', 'Chan.SchDoc', 300, 'SYMBOLAA', ['Repeat(A)']); });
    const r = compileProject([top, channel]);
    const a = r.nets.filter((n) => n.pins.some((p) => p.designator.startsWith('R2') && p.pin === '1'));
    expect(a.map((n) => [n.name, pins(n)])).toEqual([['A1', 'R2_CH1-1'], ['A2', 'R2_CH2-1']]);
  });
  it('the same sub-part placed twice is reported', () => {
    const s = sheet('S.SchDoc', (_b, part) => {
      part('U1', 100, 100, 'AAAAAAAA', { parts: 2, part: 1, lib: 'Dual' });
      part('U1', 300, 100, 'BBBBBBBB', { parts: 2, part: 1, lib: 'Dual' });
    });
    expect(compileProject([s]).messages.some((m) => /Duplicate Component Designators U1A/.test(m.message))).toBe(true);
  });
  it('Standard (No BOM) from COMPONENTKINDVERSION2', () => {
    const s = sheet('S.SchDoc', (_b, part) => { part('R1', 100, 100, 'AAAAAAAA', { kind: 5 }); });
    expect(compileProject([s]).components[0]!.kind).toBe(5);
  });
  it('unannotated channel parts are reported', () => {
    const ch = sheet('Chan.SchDoc', (_b, part) => { part('R?', 400, 300, 'RQUESTID'); });
    const top = sheet('Top.SchDoc', (b) => { symbol(b, 'Repeat(CH,1,2)', 'Chan.SchDoc', 300, 'SYMBOLAA', []); });
    expect(compileProject([top, ch]).messages.some((m) => /R\?/.test(m.message))).toBe(true);
  });
});

describe('schematic edits keep ownership through undo', () => {
  const owners = (d: SchDocument) => d.records.map((r) => r.bag?.get('OWNERINDEX') ?? '');
  it('remove, undo, redo: children follow their owner; the records as read are never changed', () => {
    const { doc } = sheet('S.SchDoc', (b, part) => { b.wire([0, 0], [50, 0]); part('R1', 100, 100, 'AAAAAAAA'); });
    const before = owners(doc), texts = doc.records.map((r) => r.bag?.toString());
    const wire = doc.objects.find((o) => o.kind === 'wire')!.index;
    const ch = removeObjects(doc, [wire]);
    ch.apply();
    const comp = doc.objects.find((o) => o.kind === 'component')!;
    expect(doc.objects.filter((o) => o.kind === 'pin').every((p) => p.owner === comp.index)).toBe(true);
    ch.revert();
    expect(owners(doc)).toEqual(before);
    expect(doc.records.map((r) => r.bag?.toString())).toEqual(texts);
    ch.apply(); ch.revert();
    expect(owners(doc)).toEqual(before);
  });
  it('reorder (bring to front) and back', () => {
    const { doc } = sheet('S.SchDoc', (b, part) => { part('R1', 100, 100, 'AAAAAAAA'); b.wire([0, 0], [50, 0]); });
    const before = owners(doc);
    const comp = doc.objects.find((o) => o.kind === 'component')!.index;
    const ch = reorderObjects(doc, [comp], 'front');
    ch.apply();
    const c = doc.objects.find((o) => o.kind === 'component')!;
    expect(doc.objects.filter((o) => o.kind === 'pin').every((p) => p.owner === c.index)).toBe(true);
    ch.revert();
    expect(owners(doc)).toEqual(before);
  });
});

describe('Convert Cross Junctions', () => {
  const M = (x: number, y: number): Vec2 => ({ x: mil(x), y: mil(y) });
  it('a down arm from a wire\'s corner: the corner wire splits, nothing is dropped', () => {
    const d = newSchDoc('T.SchDoc');
    addRecords(d, [wireBag([M(1000, 0), M(500, 0), M(500, -500)]), wireBag([M(0, 0), M(500, 0), M(500, 500)]), junctionBag(M(500, 0))]).apply();
    const { changes, count } = crossJunctionChanges(d, mil(100));
    expect(count).toBe(1);
    for (const c of changes) c.apply();
    const wires = d.objects.flatMap((o) => (o.kind === 'wire' ? [o.pts.map((p) => `${p.x / 10_000},${p.y / 10_000}`).join(' ')] : []));
    expect(wires).toContain('1000,0 500,0');
    expect(wires).toContain('600,0 600,-100 500,-100 500,-500');
    expect(wires).toContain('0,0 500,0 500,500');
  });
});

describe('annotation', () => {
  it('multi-part packages fill by library reference and comment', () => {
    const s = sheet('S.SchDoc', (_b, part) => {
      part('U?', 100, 100, 'AAAAAAAA', { parts: 2, part: 1, lib: 'Dual', comment: 'LM358' });
      part('U?', 300, 100, 'BBBBBBBB', { parts: 2, part: 2, lib: 'Dual', comment: 'TL072' });
      part('U?', 500, 100, 'CCCCCCCC', { parts: 2, part: 2, lib: 'Dual', comment: 'LM358' });
    });
    expect(planAnnotation([s]).map((r) => r.proposed)).toEqual(['U1', 'U2', 'U1']);
  });
});

describe('schematic library aliases', async () => {
  const { demoSchLib } = await import('../src/formats/synthetic/demoLib');
  const { openSchLib, writeSchLibDoc } = await import('../src/model/schLib');
  it('stay with their component when another is removed', () => {
    const lib = openSchLib(demoSchLib(), 'Demo.SchLib');
    const keep = lib.symbols[2]!;
    keep.aliases = 'OTHERNAME';
    lib.symbols.splice(0, 1);
    const back = openSchLib(writeSchLibDoc(lib), 'Demo.SchLib');
    expect(back.symbols.filter((s) => s.aliases).map((s) => [s.libRef, s.aliases])).toEqual([[keep.libRef, 'OTHERNAME']]);
  });
});

describe('No ERC properties as compiled', async () => {
  const { schProps } = await import('../src/model/schProps');
  const { PropertyBag } = await import('../src/formats/altium/props');
  const get = (fields: Record<string, string>, name: string) => {
    const d = newSchDoc('T.SchDoc');
    addRecords(d, [PropertyBag.from({ RECORD: SR.NO_ERC, OWNERPARTID: -1, 'LOCATION.X': 0, 'LOCATION.Y': 0, ...fields })]).apply();
    const o = d.objects.at(-1)!;
    return schProps(d, o, false).find((p) => p.name === name)!.get({ doc: d, index: o.index } as never);
  };
  it('old records are active and suppress all; newer ones only what they set', () => {
    expect([get({}, 'Active'), get({}, 'Suppress All Violations')]).toEqual(['true', 'true']);
    expect([get({ SUPPRESSALL: 'T' }, 'Active'), get({ ISACTIVE: 'T', ERRORKINDSETTOSUPPRESS: '"Floating net labels"' }, 'Suppress All Violations')]).toEqual(['false', 'false']);
  });
});

describe('tools and edits from elsewhere', async () => {
  const { SchEditor } = await import('../src/editors/sch/SchEditor');
  const { SchMoveTool } = await import('../src/editors/sch/SchMoveTool');
  const { demoSchDoc } = await import('../src/formats/synthetic/demo');
  const { writeSchDoc } = await import('../src/formats/altium/schdoc');
  const { removeObjects: remove } = await import('../src/model/schEdit');
  const ptr = (x: number, y: number) => ({ world: { x, y }, raw: { x, y }, button: 0, shift: false, ctrl: false, alt: false });
  const u1 = (d: SchDocument) => d.objects.find((o) => o.kind === 'component' && o.designator === 'U1') as Extract<SchDocument['objects'][number], { kind: 'component' }>;

  it('saving mid-move writes the sheet as it was, and the move carries on', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const ed = new SchEditor(doc);
    const was = u1(doc).at, saved = writeSchDoc(doc);
    ed.setTool(new SchMoveTool(ed, 'move', [u1(doc).index], was, true));
    ed.pointerMove(ptr(was.x + mil(500), was.y));
    const moved = u1(doc).at;
    expect(moved.x).toBeGreaterThan(was.x);
    expect([...ed.withToolSuspended(() => writeSchDoc(doc))]).toEqual([...saved]);
    expect(u1(doc).at).toEqual(moved);
  });
  it('undo mid-move puts the move back first and ends it', () => {
    const doc = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    const ed = new SchEditor(doc);
    const first = doc.objects.find((o) => o.kind === 'wire')!.index;
    ed.undo.transact('Delete', (tx) => tx.add(remove(doc, [first])));
    const was = u1(doc).at;
    ed.setTool(new SchMoveTool(ed, 'move', [u1(doc).index], was, true));
    ed.pointerMove(ptr(was.x + mil(500), was.y));
    ed.undo.undo();
    expect(ed.tool.id).not.toBe('sch-move');
    expect(u1(doc).at).toEqual(was);
    ed.pointerUp(ptr(was.x + mil(900), was.y), true);
    expect(u1(doc).at).toEqual(was);
    expect(ed.undo.canRedo).toBe(true);
  });
});

describe('Gerber regions with holes', async () => {
  const { holeFree } = await import('../src/formats/gerber/holeFree');
  const area = (p: Vec2[]) => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]!; return s + a.x * b.y - b.x * a.y; }, 0) / 2);
  const sq = (x: number, y: number, w: number): Vec2[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + w }, { x, y: y + w }];
  it('become pieces without holes covering the same copper', () => {
    const outline = sq(0, 0, 1000), holes = [sq(100, 100, 200), sq(600, 600, 300), sq(150, 650, 100)];
    const pieces = holeFree(outline, holes);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.reduce((s, p) => s + area(p), 0)).toBe(area(outline) - holes.reduce((s, h) => s + area(h), 0));
    expect(holeFree(outline, [])).toEqual([outline]);
  });
});

describe('NC drill', async () => {
  const { readPcbDoc } = await import('../src/formats/altium/pcbdoc');
  const { demoPcbDoc } = await import('../src/formats/synthetic/demo');
  const { drillFiles, defaultDrillSetup } = await import('../src/formats/gerber/drill');
  const { addVias } = await import('../src/model/pcbEdit');
  const { L } = await import('../src/model/layers');
  const { PAD_STACK } = await import('../src/formats/altium/pcbLayouts');
  it('slots as G85 in their own file; blind vias in their layer pair\'s', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'B.PcbDoc');
    doc.board.copperStack = [L.TOP, L.MID1, L.BOTTOM];
    addVias(doc, [{ at: { x: 5_000_000, y: 5_000_000 }, diameter: mil(24), hole: mil(12), layerStart: L.TOP, layerEnd: L.MID1 }]).apply();
    const pad = doc.prims.find((p) => p.kind === 'pad' && p.hole > 0)!;
    const rec = doc.streams.get(pad.src.storage)!.records[pad.src.index]!;
    const st = new Uint8Array(PAD_STACK.minLen);
    st[PAD_STACK.holeShape] = 2;
    new DataView(st.buffer).setInt32(PAD_STACK.slotLength, (pad as { hole: number }).hole * 3, true);
    while (rec.subs.length < 6) rec.subs.push(new Uint8Array(0));
    rec.subs[5] = st;
    const files = drillFiles(doc, { ...defaultDrillSetup(), g85: true });
    const names = files.map((f) => f.name);
    expect(names).toEqual(['B.TXT', 'B-SlotHoles.TXT', 'B-1-2.TXT', 'B.DRR']);
    expect(files[1]!.text).toMatch(/X\d+Y\d+G85X\d+Y\d+/);
    // Use drilled slot command (G85) off, as AD: the slot routed from end to end
    expect(drillFiles(doc, defaultDrillSetup())[1]!.text).toMatch(/G00X\d+Y\d+\r\nM15\r\nG01X\d+Y\d+\r\nM16\r\nG05/);
    expect(files[3]!.text).toContain('Layer Pair : Top Layer to Mid-Layer 1');
  });
});
