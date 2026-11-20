import { describe, expect, it } from 'vitest';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { readPcbLib } from '../src/formats/altium/pcblib';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { demoPcbDoc, demoPcbLib, demoSchDoc } from '../src/formats/synthetic/demo';
import { compileProject } from '../src/model/compile';
import { itemChange, pcbComment, type FootprintFinder } from '../src/model/pcbEco';
import { applySchItem, compareProject, planSchUpdate, refsBySheet, validateSchItem } from '../src/model/comparator';
import { UndoStack } from '../src/core/undo';
import type { SchDocument } from '../src/model/sch';
import { SR, bagOf } from '../src/model/sch';

const lib = readPcbLib(demoPcbLib(), 'Demo.PcbLib');
const find: FootprintFinder = (p) => { const f = lib.footprints.find((x) => x.name.toLowerCase() === p.toLowerCase()); return f ? { library: lib.name, footprint: f } : undefined; };

/** The demo schematic and its board, the board then edited the way a layout changes things. */
function setup() {
  const sheet = readSchDoc(demoSchDoc(), 'Demo.SchDoc');
  const compile = () => compileProject([{ name: 'Demo.SchDoc', doc: sheet }]);
  const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
  // Linked by unique ID, as Update PCB (or Component Links) leaves them
  for (const c of compile().components) doc.components.find((x) => x.designator === c.designator)?.bag.set('SOURCEUNIQUEID', `\\${c.uniqueId}`);
  const idx = (d: string) => doc.components.findIndex((c) => c.designator === d);
  const u = new UndoStack();
  u.transact('layout', (tx) => {
    tx.add(itemChange(doc, { kind: 'changeDesignator', group: 'Change Component Designators', action: 'Modify', object: '', index: idx('C2'), from: 'C2', to: 'C9' }, find));
    tx.add(itemChange(doc, { kind: 'changeFootprint', group: 'Change Component Footprints', action: 'Modify', object: '', index: idx('C1'), designator: 'C1', from: '0805', to: 'LED0805' }, find));
    tx.add(itemChange(doc, { kind: 'changeComment', group: 'Change Component Comments', action: 'Modify', object: '', index: idx('U1'), designator: 'U1', from: '', to: 'LDO 3.3 V' }, find));
  });
  return { sheet, compile, doc };
}

const designatorOf = (doc: SchDocument, d: string) => doc.objects.find((o) => o.kind === 'component' && o.designator === d);
function currentFootprint(doc: SchDocument, comp: number): string {
  const lists = doc.objects.filter((o) => o.owner === comp && o.record === SR.IMPLEMENTATION_LIST).map((o) => o.index);
  const impls = doc.objects.filter((o) => o.record === SR.IMPLEMENTATION && lists.includes(o.owner)).map((o) => bagOf(doc, o)!);
  return (impls.find((b) => b.bool('ISCURRENT')) ?? impls[0])?.get('MODELNAME') ?? '';
}

describe('Show Differences', () => {
  it('finds what the board changed, each with the way it can go', () => {
    const { compile, doc } = setup();
    expect(pcbComment(doc, doc.components.findIndex((c) => c.designator === 'U1'))).toBe('LDO 3.3 V');
    const diffs = compareProject(compile(), doc, find);
    const row = (g: string) => diffs.filter((d) => d.group === g).map((d) => `${d.sch} | ${d.pcb} | ${d.toSch ? '<<' : ''}${d.toPcb ? '>>' : ''}`);
    expect(row('Different Designators')).toEqual(['C2 | C9 | <<>>']);
    expect(row('Different Footprints')).toEqual(['C1: 0805 | C1: LED0805 | <<>>']);
    expect(row('Different Comments')).toEqual(['U1: LDO 3V3 | U1: LDO 3.3 V | <<>>']);
    // The LED indicator isn't on the board yet: only the board can take it
    expect(row('Extra Components')).toEqual(['D1 |  | >>', 'R1 |  | >>']);
    expect(diffs.filter((d) => d.group === 'Extra Pins in Nets').every((d) => d.toPcb && !d.toSch)).toBe(true);
    // The LED footprint's pads (A, K) aren't 1 and 2: those pins show on both sides
    expect(diffs.some((d) => d.group === 'Extra Pins in Nets' && d.pcb.startsWith('C1-'))).toBe(false);
  });

  it('Update Schematics takes designators, footprints and comments back; then they agree', () => {
    const { sheet, compile, doc } = setup();
    const before = writeSchDoc(sheet);
    const items = planSchUpdate(compile(), doc, find);
    expect(items.map((i) => `${i.group}: ${i.object}`)).toEqual([
      'Change Component Designators: C2 -> C9', 'Change Component Footprints: C1: 0805 -> LED0805', 'Change Component Comments: U1: LDO 3V3 -> LDO 3.3 V',
    ]);
    const u = new UndoStack();
    u.transact('Update Schematics', (tx) => {
      for (const it of items) {
        const idx = refsBySheet(it).get('Demo.SchDoc')!;
        expect(validateSchItem(sheet, it, idx)).toBeNull();
        applySchItem(sheet, it, idx, (c) => tx.add(c));
      }
    });
    expect(designatorOf(sheet, 'C9')).toBeDefined();
    expect(currentFootprint(sheet, designatorOf(sheet, 'C1')!.index)).toBe('LED0805');
    const again = compileProject([{ name: 'Demo.SchDoc', doc: readSchDoc(writeSchDoc(sheet), 'Demo.SchDoc') }]);
    expect(again.components.find((c) => c.designator === 'U1')?.comment).toBe('LDO 3.3 V');
    expect(planSchUpdate(again, doc, find)).toEqual([]);
    expect(compareProject(again, doc, find).filter((d) => /^Different/.test(d.group))).toEqual([]);
    u.undo();
    expect(writeSchDoc(sheet)).toEqual(before);
  });

  it('a footprint the part already has is made current, not added again', () => {
    const { sheet, compile, doc } = setup();
    const c1 = designatorOf(sheet, 'C1')!.index;
    const models = () => sheet.objects.filter((o) => o.record === SR.IMPLEMENTATION).length;
    const it = planSchUpdate(compile(), doc, find).find((i) => i.kind === 'schFootprint')!;
    const n = models();
    const u = new UndoStack();
    u.transact('a', (tx) => applySchItem(sheet, it, [c1], (c) => tx.add(c)));
    expect(models()).toBe(n + 1);
    // back to 0805 on the board, and forward again: LED0805 is now one of its models
    u.transact('b', (tx) => applySchItem(sheet, { ...it, to: '0805' }, [c1], (c) => tx.add(c)));
    expect(currentFootprint(sheet, c1)).toBe('0805');
    u.transact('c', (tx) => applySchItem(sheet, it, [c1], (c) => tx.add(c)));
    expect(models()).toBe(n + 1);
    expect(currentFootprint(sheet, c1)).toBe('LED0805');
  });
});
