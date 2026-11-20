import { describe, expect, it } from 'vitest';
import { cp1252ToStr, strToCp1252 } from '../src/formats/text';
import { PropertyBag } from '../src/formats/altium/props';
import { L, bare, parseSexpr, writeSexpr, written } from '../src/formats/kicad/sexpr';

/**
 * R9, memory: a big KiCad board (85 MB, 3.2 million lists) read and written back within a 1.5 GB
 * heap, where it needed over 2 GB. Plain text through the cp1252 conversions as it is (built a
 * character at a time, a 53 MB value took 1.7 GB of rope); the reader's lists their size and its
 * words once each; the export's footprints written as they are made.
 */

describe('KiCad round trip: memory (R9)', () => {
  it('plain text goes through the cp1252 conversions as the same string; cp1252\'s own block still mapped', () => {
    const s = `${'(fp_line (start 1 2) (end 3 4))'.repeat(1000)} µ°`;
    expect(strToCp1252(s)).toBe(s);
    expect(cp1252ToStr(s)).toBe(s);
    expect(strToCp1252('€ – ™')).toBe('\x80 \x96 \x99');
    expect(cp1252ToStr('\x80 \x96 \x99')).toBe('€ – ™');
    expect(strToCp1252('Ω')).toBeNull();
  });

  it('a 20 MB value into a record and out again quickly', () => {
    const v = 'x'.repeat(20_000_000);
    const t0 = Date.now();
    const bytes = PropertyBag.fromEntries([['KEY', 'k'], ['ITEMS', v]]).toBytes();
    const back = PropertyBag.parse(bytes).getRaw('ITEMS');
    expect(back?.length).toBe(v.length);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('the reader: words shared, lists as before', () => {
    const t = parseSexpr('(a (layer "F.Cu") (layer "F.Cu") (xy 1 2) (b yes yes) (c))');
    const [l1, l2] = t.items as { k: string; items: unknown[] }[];
    expect(l1!.items[0]).toBe(l2!.items[0]);
    expect(JSON.stringify(t)).toBe('{"k":"a","items":[{"k":"layer","items":["F.Cu"]},{"k":"layer","items":["F.Cu"]},{"k":"xy","items":[1,2]},{"k":"b","items":["yes","yes"]},{"k":"c","items":[]}]}');
  });

  it('a list written as it is made reads the same as one written with the rest', () => {
    const fp = (n: number) => L('footprint', `Lib:FP${n}`, L('layer', 'F.Cu'), L('at', n, 2, 0), L('fp_line', L('start', 0, 0), L('end', 1, 0), L('stroke', L('width', 0.1), L('type', bare('solid')))));
    const whole = writeSexpr(L('kicad_pcb', L('version', 20240108), fp(1), fp(2)));
    const parts = writeSexpr(L('kicad_pcb', L('version', 20240108), written(fp(1), 1), written(fp(2), 1)));
    expect(parts).toBe(whole);
  });
});
