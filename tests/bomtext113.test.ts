import { describe, expect, it } from 'vitest';
import { PropertyBag } from '../src/formats/altium/props';
import { bomChecks, choiceBag, choiceOf } from '../src/model/activeBom';
import { toPart } from '../src/platform/jlcSearch';

describe('A BOM part choice keeps text cp1252 can\'t hold (26.113)', () => {
  it('Ω and ℃ in a JLCPCB description survive, written as a %UTF8% twin', () => {
    const d = '-55℃~+155℃ 125mW 150V 1kΩ Thick Film Resistor ±1% 0805';
    const b = choiceBag({ manufacturer: 'UNI-ROYAL', mpn: '0805W8F1001T5E', supplier: 'LCSC', spn: 'C17513', stock: 10, prices: [{ qty: 1, price: 0.0032 }], currency: 'USD', lifecycle: '', url: '', description: d, library: 'Basic' }, 'JLCPCB');
    expect(b.get('DESCRIPTION')).toBe(d);
    const back = PropertyBag.parse(b.toBytes());
    expect(back.get('DESCRIPTION')).toBe(d);
    expect(back.getRaw('DESCRIPTION')).toMatch(/1k\? Thick/);
    expect(choiceOf(back).description).toBe(d);
    expect(PropertyBag.fromEntries([['NAME', 'plain']]).getRaw('%UTF8%NAME')).toBeUndefined();
  });

  it('stock JLCPCB doesn\'t give is unknown, not none: no Insufficient stock for it', () => {
    expect(toPart({ lcsc: 15850, mfr: 'CL21A106KAYNNNE', stock: null, price: '1-199:0.0773' }).stock).toBeUndefined();
    expect(toPart({ lcsc: 15850, mfr: 'CL21A106KAYNNNE', stock: 0, price: '1-199:0.0773' }).stock).toBe(0);
    expect(toPart({ lcsc: 15850, mfr: 'CL21A106KAYNNNE', stock: 1200 }).stock).toBe(1200);
    const b = choiceBag({ manufacturer: '', mpn: 'X', supplier: 'LCSC', spn: 'C1', stock: undefined, prices: [{ qty: 1, price: 0.1 }], currency: 'USD', lifecycle: '', url: '', description: '' }, 'JLCPCB');
    expect(choiceOf(b).stock).toBeUndefined();
    expect(typeof bomChecks).toBe('function');
  });
});

import { PropertyBag as Bag } from '../src/formats/altium/props';
import { anyDbTable } from '../src/app/dbLibActions';
describe('Component › Table Name unticked (26.113)', () => {
  it('only an explicit F means any table; absent or T keeps the named one', () => {
    expect(anyDbTable(Bag.fromEntries([['USEDBTABLENAME', 'F']]))).toBe(true);
    expect(anyDbTable(Bag.fromEntries([['USEDBTABLENAME', 'T']]))).toBe(false);
    expect(anyDbTable(Bag.fromEntries([['DATABASETABLENAME', 'Resistors']]))).toBe(false);
    expect(anyDbTable(undefined)).toBe(false);
  });
});
