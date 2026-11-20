import { describe, expect, it } from 'vitest';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readPcbLib, footprintBounds } from '../src/formats/altium/pcblib';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoPcbDoc, demoPcbLib, demoSchDoc } from '../src/formats/synthetic/demo';
import { symbolsSchDoc } from '../src/formats/synthetic/gallery';
import { compileProject } from '../src/model/compile';
import { isModelLibrary, itemChange, planPcbUpdate, validateItem, type FootprintFinder } from '../src/model/pcbEco';
import { SR } from '../src/model/sch';
import { runDrc } from '../src/model/drc';
import { UndoStack } from '../src/core/undo';
import { bytesEqual } from '../src/formats/bin';
import { mm } from '../src/core/units';

const lib = readPcbLib(demoPcbLib(), 'Demo.PcbLib');
const find: FootprintFinder = (p) => { const f = lib.footprints.find((x) => x.name.toLowerCase() === p.toLowerCase()); return f ? { library: lib.name, footprint: f } : undefined; };
// One schematic for the whole file: unique IDs are generated when the demo is written
const compiled = compileProject([
  { name: 'Demo.SchDoc', doc: readSchDoc(demoSchDoc(), 'Demo.SchDoc') },
  { name: 'Symbols.SchDoc', doc: readSchDoc(symbolsSchDoc(), 'Symbols.SchDoc') },
]);
const project = () => compiled;

describe('PcbLib', () => {
  it('reads the demo footprints with their pads', () => {
    expect(lib.footprints.map((f) => f.name)).toEqual(['HDR1X2', '0805', 'LED0805', 'SOT-223']);
    const sot = lib.footprints.find((f) => f.name === 'SOT-223')!;
    expect(sot.prims.filter((p) => p.kind === 'pad').map((p) => (p as { name: string }).name)).toEqual(['1', '2', '3', '4']);
    expect(sot.height).toBe('70mil');
    const b = footprintBounds(sot);
    expect(b.maxX - b.minX).toBeGreaterThan(mm(6.7));
  });
});

describe('Update PCB Document', () => {
  it('plans exactly the LED indicator; graphical gallery parts stay off the board', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const plan = planPcbUpdate(project(), doc, find);
    expect(plan.map((p) => `${p.group}: ${p.object}`)).toEqual([
      'Add Components: D1', 'Add Components: R1',
      'Add Nets: NetD1_A',
      'Add Pins To Nets: D1-A to NetD1_A', 'Add Pins To Nets: D1-K to GND', 'Add Pins To Nets: R1-1 to +3V3', 'Add Pins To Nets: R1-2 to NetD1_A',
    ]);
    expect(plan.every((p) => validateItem(doc, p, plan, find) === null)).toBe(true);
  });

  it('executes as one undo step, saves, and reloads with the new parts netted', () => {
    const bytes = demoPcbDoc();
    const doc = readPcbDoc(bytes, 'Demo.PcbDoc');
    const plan = planPcbUpdate(project(), doc, find);
    const undo = new UndoStack();
    undo.transact('Engineering Change Order', (tx) => { for (const it of plan) tx.add(itemChange(doc, it, find)); });
    expect(doc.components.map((c) => c.designator)).toEqual(['J1', 'C1', 'U1', 'C2', 'D1', 'R1']);
    const again = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    const r1 = again.components.find((c) => c.designator === 'R1')!;
    const pads = again.prims.filter((p) => p.kind === 'pad' && p.component === r1.index) as { name: string; net: number }[];
    expect(pads.map((p) => `${p.name}:${again.nets[p.net]?.name}`).sort()).toEqual(['1:+3V3', '2:NetD1_A']);
    expect(again.prims.some((p) => p.kind === 'text' && p.isDesignator && p.text === 'R1')).toBe(true);
    // Placed beside the board, so the new nets are simply unrouted
    expect(r1.at.x).toBeGreaterThan(again.board.outline.reduce((m, p) => Math.max(m, p.x), 0));
    const drc = runDrc(again);
    // (and the demo's own free +3V3 arc, an antenna at both ends by the suite's default Net Antennae rule)
    expect(drc.violations.filter((v) => v.kind !== 'UnRoutedNet' && !(v.kind === 'NetAntennae' && /^Net Antennae: Arc \(1181\.102mil,275\.591mil\)/.test(v.message)))).toEqual([]);
    expect(drc.violations.some((v) => /NetD1_A/.test(v.message))).toBe(true);
    // and the board is up to date now
    expect(planPcbUpdate(project(), again, find)).toEqual([]);
    undo.undo();
    expect(bytesEqual(writePcbDoc(doc), bytes)).toBe(true);
  });

  it('a footprint model naming its PCB Library is looked for only there', () => {
    const sch = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
    // R1's footprint: Library name Test.PcbLib (not the demo library)
    const r1 = sch.objects.find((o) => o.kind === 'component' && o.designator === 'R1')!;
    const list = sch.objects.find((o) => o.owner === r1.index && o.record === SR.IMPLEMENTATION_LIST)!;
    const impl = sch.objects.find((o) => o.owner === list.index && o.record === SR.IMPLEMENTATION)!;
    const b = sch.records[impl.index + 1]!.bag!;
    b.delete('USECOMPONENTLIBRARY'); b.set('MODELDATAFILE0', 'Test.PcbLib');
    const c = compileProject([{ name: 'Demo.SchDoc', doc: sch }]);
    expect(c.components.find((x) => x.designator === 'R1')?.footprintLibrary).toBe('Test.PcbLib');
    const scoped: FootprintFinder = (p, library) => (library && !isModelLibrary(lib.name, library) ? undefined : find(p));
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const plan = planPcbUpdate(c, doc, scoped);
    const add = plan.find((p) => p.kind === 'addComponent' && p.object === 'R1')!;
    expect(validateItem(doc, add, plan, scoped)).toMatch(/^Footprint Not Found .+ in Test\.PcbLib$/);
    b.set('MODELDATAFILE0', 'C:\\Libs\\Demo.PcbLib');
    const c2 = compileProject([{ name: 'Demo.SchDoc', doc: sch }]);
    const plan2 = planPcbUpdate(c2, doc, scoped);
    expect(validateItem(doc, plan2.find((p) => p.kind === 'addComponent' && p.object === 'R1')!, plan2, scoped)).toBeNull();
  });

  it('designators changed on the schematic follow by unique ID', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const p = project();
    const plan = planPcbUpdate(p, doc, find);
    const undo = new UndoStack();
    undo.transact('ECO', (tx) => { for (const it of plan) tx.add(itemChange(doc, it, find)); });
    // Re-annotate R1 as R5 on the schematic: same UNIQUEID
    const p2 = { ...p, components: p.components.map((c) => (c.designator === 'R1' ? { ...c, designator: 'R5' } : c)),
      nets: p.nets.map((n) => ({ ...n, pins: n.pins.map((x) => (x.designator === 'R1' ? { ...x, designator: 'R5' } : x)) })) };
    const plan2 = planPcbUpdate(p2, doc, find);
    expect(plan2.map((x) => `${x.group}: ${x.object}`)).toEqual(['Change Component Designators: R1 -> R5']);
    undo.transact('ECO', (tx) => { for (const it of plan2) tx.add(itemChange(doc, it, find)); });
    const again = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    expect(again.components.map((c) => c.designator)).toContain('R5');
    expect(planPcbUpdate(p2, again, find)).toEqual([]);
  });
});

describe('connection lines', () => {
  it('the routed demo has none; the LED parts get one per unrouted pad pair', async () => {
    const { connections } = await import('../src/model/drc');
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    expect(connections(doc)).toEqual([]);
    const plan = planPcbUpdate(project(), doc, find);
    new UndoStack().transact('ECO', (tx) => { for (const it of plan) tx.add(itemChange(doc, it, find)); });
    const lines = connections(doc).map((c) => doc.nets[c.net]!.name).sort();
    expect(lines).toEqual(['+3V3', 'GND', 'NetD1_A']);
  });
});

describe('moving components', () => {
  it('moves and turns every owned primitive, writes X/Y/ROTATION, undoes byte-exactly', async () => {
    const { moveComponent } = await import('../src/model/pcbEdit');
    const bytes = demoPcbDoc();
    const doc = readPcbDoc(bytes, 'Demo.PcbDoc');
    const c1 = doc.components.findIndex((c) => c.designator === 'C1');
    const at = doc.components[c1]!.at;
    const undo = new UndoStack();
    undo.transact('Move C1', (tx) => tx.add(moveComponent(doc, c1, { x: mm(2), y: mm(-1) }, 90)));
    const again = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    const c = again.components[c1]!;
    expect(c.at).toEqual({ x: at.x + mm(2), y: at.y - mm(1) });
    expect(c.rotation).toBe(90);
    expect(c.bag.get('ROTATION')).toBe(' 9.00000000000000E+0001');
    // pad 1 was 0.95 mm left of the reference: after a quarter turn it is 0.95 mm below it
    const pad1 = again.prims.find((p) => p.kind === 'pad' && p.component === c1 && p.name === '1') as { at: { x: number; y: number }; rotation: number };
    expect(Math.abs(pad1.at.x - c.at.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(pad1.at.y - (c.at.y - mm(0.95)))).toBeLessThanOrEqual(1);
    expect(pad1.rotation).toBe(90);
    undo.undo();
    expect(bytesEqual(writePcbDoc(doc), bytes)).toBe(true);
  });
});

describe('Change Component Footprints', () => {
  it('a placed component takes another footprint where it is; pads keep their nets; undo restores the file', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    const before = writePcbDoc(doc);
    const c = doc.components.find((x) => x.pattern === '0805')!;
    const pads = () => doc.prims.filter((p) => p.kind === 'pad' && p.component === c.index).map((p) => (p.kind === 'pad' ? `${p.name}:${p.net}@${p.at.x},${p.at.y}` : '')).sort();
    const was = pads();
    const u = new UndoStack();
    u.transact('swap', (tx) => tx.add(itemChange(doc, { kind: 'changeFootprint', group: 'Change Component Footprints', action: 'Modify', object: '', index: c.index, designator: c.designator, from: '0805', to: '0805' }, find)));
    expect(pads()).toEqual(was);
    expect(doc.components[c.index]!.designator).toBe(c.designator);
    u.transact('swap', (tx) => tx.add(itemChange(doc, { kind: 'changeFootprint', group: 'Change Component Footprints', action: 'Modify', object: '', index: c.index, designator: c.designator, from: '0805', to: 'LED0805' }, find)));
    expect(doc.components[c.index]!.pattern).toBe('LED0805');
    const led = doc.prims.filter((p) => p.kind === 'pad' && p.component === c.index).map((p) => (p.kind === 'pad' ? p.name : '')).sort();
    expect(led).toEqual(['A', 'K']);
    u.undo(); u.undo();
    expect(bytesEqual(writePcbDoc(doc), before)).toBe(true);
    expect(validateItem(doc, { kind: 'removeComponent', group: 'Remove Components', action: 'Remove', object: c.designator, designator: c.designator }, [], find)).toBeNull();
  });
});
