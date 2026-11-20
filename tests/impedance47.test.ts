import { describe, expect, it } from 'vitest';
import { DEFAULT_FORMULAS, boardFormulas, checkFormula, evalFormula, impedanceOf, setFormulas, stackGeometry, widthFor } from '../src/model/impedance';
import { PropertyBag } from '../src/formats/altium/props';
import { L } from '../src/model/layers';
import { mil } from '../src/core/units';
import type { StackLayer } from '../src/model/pcbStack';

const row = (p: Partial<StackLayer>): StackLayer => ({ kind: 'signal', layer: null, v7: 0, name: '', copper: 0, placement: 0, pullback: 0, dielType: 0, dielMaterial: '', dielConst: 0, height: 0, coverlay: 0, ...p });
const diel = (h: number, er = 4.2) => row({ kind: 'dielectric', name: 'Dielectric', height: mil(h), dielConst: er });
// Four layers: Top, prepreg 5 mil, GND plane, core 40 mil, Mid 1, prepreg 5 mil, Bottom
const STACK: StackLayer[] = [
  row({ kind: 'solder', name: 'Top Solder' }),
  row({ layer: L.TOP, name: 'Top Layer', copper: mil(1.4) }), diel(5),
  row({ kind: 'plane', layer: L.PLANE1, name: 'GND', copper: mil(1.4) }), diel(40),
  row({ layer: L.MID1, name: 'Mid 1', copper: mil(1.4) }), diel(5),
  row({ layer: L.BOTTOM, name: 'Bottom Layer', copper: mil(1.4) }),
  row({ kind: 'solder', name: 'Bottom Solder' }),
];

describe('impedance calculation', () => {
  it('reads the formulas\' language: precedence, powers, functions, variables in any case', () => {
    expect(evalFormula('1+2*3^2', {})).toBe(19);
    expect(evalFormula('-(2+3)*-2', {})).toBe(10);
    expect(evalFormula('SQRT(16)+LN(EXP(2))+max(1,4)', {})).toBe(10);
    expect(evalFormula('er*2', { Er: 4.5 })).toBe(9);
    expect(() => evalFormula('1+', {})).toThrow();
    expect(checkFormula('SQRT(Er')).toMatch(/expected/);
    expect(checkFormula('Foo*2')).toMatch(/no value for Foo/);
    for (const f of Object.values(DEFAULT_FORMULAS)) expect(checkFormula(f)).toBeNull();
  });

  it('each signal layer: microstrip outside, stripline inside, the nearest plane\'s distance', () => {
    const g = stackGeometry(STACK);
    expect(g.map((x) => [x.name, x.kind])).toEqual([['Top Layer', 'microstrip'], ['Mid 1', 'stripline'], ['Bottom Layer', 'microstrip']]);
    expect(g[0]!.traceToPlane).toBe(mil(5));
    expect(g[1]!.traceToPlane).toBe(mil(5));
    expect(g[1]!.planeToPlane).toBe(mil(40) + mil(5) + mil(1.4));
  });

  it('AD17\'s formulas: width and impedance agree both ways, in the usual range', () => {
    const [top, mid] = stackGeometry(STACK);
    const w = widthFor(DEFAULT_FORMULAS, top!, 50);
    expect(w).toBeGreaterThan(mil(4));
    expect(w).toBeLessThan(mil(12));
    expect(impedanceOf(DEFAULT_FORMULAS, top!, w)).toBeCloseTo(50, 3);
    const z = impedanceOf(DEFAULT_FORMULAS, top!, mil(8));
    expect(z).toBeGreaterThan(35); expect(z).toBeLessThan(60);
    const ws = widthFor(DEFAULT_FORMULAS, mid!, 50);
    expect(impedanceOf(DEFAULT_FORMULAS, mid!, ws)).toBeCloseTo(50, 3);
  });

  it('the board keeps the formulas (Board6), undone as one step', () => {
    const b = PropertyBag.from({ RECORD: 'Board' });
    expect(boardFormulas(b)).toEqual(DEFAULT_FORMULAS);
    let touched = 0;
    const c = setFormulas(b, { ...DEFAULT_FORMULAS, microstripZ: '50' }, () => touched++);
    c.apply();
    expect(b.get('SURFACEMICROSTRIP_I')).toBe('50');
    expect(b.get('SYMMETRICSTRIPLINE_W')).toBe(DEFAULT_FORMULAS.striplineW);
    c.revert();
    expect(b.has('SURFACEMICROSTRIP_I')).toBe(false);
    expect(touched).toBe(2);
  });
});
