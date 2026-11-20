import { describe, expect, it } from 'vitest';
import { demoSchLib } from '../src/formats/synthetic/demoLib';
import { readSchLib } from '../src/formats/altium/schlib';
import { openSchLib, symbolView, viewBags, writeSchLibDoc, newSchLib, currentSymbols } from '../src/model/schLib';
import { SchLibEditor } from '../src/editors/sch/SchLibEditor';
import { addRecords } from '../src/model/schEdit';
import { PropertyBag } from '../src/formats/altium/props';
import { SR } from '../src/model/sch';

const bytesOf = (b: PropertyBag) => [...b.toBytes()].join(',');

describe('schematic library editing', () => {
  it('a symbol shown as a sheet comes back as the same library records', () => {
    const lib = openSchLib(demoSchLib(), 'Demo.SchLib');
    for (const s of lib.symbols) {
      const back = viewBags(symbolView(lib, s));
      expect(back.map(bytesOf)).toEqual(s.bags.map(bytesOf));
    }
  });

  it('pins placed on part B belong to it; parts, names and new components save', () => {
    const lib = openSchLib(demoSchLib(), 'Demo.SchLib');
    const ed = new SchLibEditor(lib);
    ed.showSymbol(lib.symbols.findIndex((s) => s.libRef === 'LM358'));
    expect(ed.partCount).toBe(2);
    ed.showPart(2);
    const pins0 = ed.doc.objects.filter((o) => o.kind === 'pin').length;
    const pin = PropertyBag.from({ RECORD: SR.PIN, ELECTRICAL: 4, PINCONGLOMERATE: 0x18, PINLENGTH: 20, NAME: 'NC', DESIGNATOR: '9', 'LOCATION.X': 0, 'LOCATION.Y': -40 });
    ed.undo.transact('Place pin', (tx) => tx.add(addRecords(ed.doc, [pin])));
    const added = ed.doc.objects.at(-1)!;
    expect([added.kind, added.owner, added.ownerPartId]).toEqual(['pin', 1, 2]);
    expect(ed.renameComponent('LM358A')).toBe(true);
    ed.newComponent('Fuse');
    expect(lib.symbols.map((s) => s.libRef)).toContain('Fuse');
    const again = readSchLib(writeSchLibDoc(lib), 'Demo.SchLib');
    const lm = again.symbols.find((s) => s.libRef === 'LM358A')!;
    expect(lm.bags.filter((b) => b.int('RECORD') === SR.PIN).length).toBe(pins0 + 1);
    expect(lm.bags.find((b) => b.get('DESIGNATOR') === '9')!.int('OWNERPARTID')).toBe(2);
    expect(again.symbols.map((s) => s.libRef)).toEqual(['Res', 'Cap', 'LED', 'Header 2', 'LDO SOT-223', 'LM358A', 'Fuse']);
    // undo walks back across components: the new one goes, then the name, then the pin
    ed.undo.undo(); ed.undo.undo(); ed.undo.undo();
    expect(lib.symbols.map((s) => s.libRef)).not.toContain('Fuse');
    expect(currentSymbols(lib).find((s) => s.libRef === 'LM358')!.bags.filter((b) => b.int('RECORD') === SR.PIN).length).toBe(pins0);
    expect(ed.symbol!.libRef).toBe('LM358');
  });

  it('removing a part takes its pins and renumbers the rest', () => {
    const lib = openSchLib(demoSchLib(), 'Demo.SchLib');
    const ed = new SchLibEditor(lib);
    ed.showSymbol(lib.symbols.findIndex((s) => s.libRef === 'LM358'));
    ed.showPart(1);
    expect(ed.removePart()).toBe(true);
    const sym = currentSymbols(lib).find((s) => s.libRef === 'LM358')!;
    expect(sym.parts).toBe(1);
    expect(sym.bags.filter((b) => b.int('RECORD') === SR.PIN).map((b) => b.get('DESIGNATOR')).sort()).toEqual(['5', '6', '7']);
    expect(sym.bags.filter((b) => b.int('RECORD') === SR.PIN).every((b) => b.int('OWNERPARTID') === 1)).toBe(true);
  });

  it('a new library has one component and saves', () => {
    const lib = newSchLib('SchLib1.SchLib');
    const again = readSchLib(writeSchLibDoc(lib), 'SchLib1.SchLib');
    expect(again.symbols.map((s) => s.libRef)).toEqual(['Component_1']);
  });
});
