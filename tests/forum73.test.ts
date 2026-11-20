import { describe, expect, it } from 'vitest';
import { formatSchField, mil, mm, parseSchField } from '../src/core/units';
import { fmtCoord, parseCoord } from '../src/model/schProps';

describe("a schematic's lengths in its own unit (Document Options › Units)", () => {
  it('Dxp Defaults: plain 10 mil units, no suffix', () => {
    expect(formatSchField(mil(100), 4)).toBe('10');
    expect(formatSchField(mil(10_000), 4)).toBe('1000');
    expect(parseSchField('10', 4)).toBe(mil(100));
    expect(fmtCoord(mil(40), 4)).toBe('4');
    expect(parseCoord('4', 4)).toBe(mil(40));
  });
  it('a unit written with the number is taken as written, whatever the sheet\'s', () => {
    expect(parseSchField('100mil', 4)).toBe(mil(100));
    expect(parseSchField('2.54mm', 4)).toBe(mm(2.54));
    expect(parseSchField('0.1in', 1)).toBe(mil(100));
    expect(parseSchField('1cm', 0)).toBe(mm(10));
    expect(parseSchField('ten', 0)).toBeUndefined();
  });
  it('the other units, as the status bar shows them but more precise', () => {
    expect(formatSchField(mil(100), 0)).toBe('100mil');
    expect(formatSchField(mm(2.54), 1)).toBe('2.54mm');
    expect(formatSchField(mil(1500), 2)).toBe('1.5in');
    expect(formatSchField(mil(100), 6)).toBe('100mil');
    expect(formatSchField(mil(1500), 6)).toBe('1.5in');
    // The editor's units still work where a library has them
    expect(fmtCoord(mil(100), 'mm')).toBe('2.54mm');
  });
});
