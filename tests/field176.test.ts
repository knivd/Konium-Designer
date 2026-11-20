import { describe, expect, it } from 'vitest';
import { hammerstadJensen, fieldPicture, solveLine, striplineExact, widthFor, type LineSetup } from '../src/analysis/field2d';
import { defaultLineForm, formLine, lineFromStack, shown, unitM } from '../src/app/fieldRun';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { L } from '../src/model/layers';

const mm = 1e-3;

describe('the field solver (26.176)', () => {
  it('a thin microstrip against Hammerstad and Jensen, narrow to wide', () => {
    for (const [w, h, er] of [[0.1, 0.2, 4.3], [0.36, 0.2, 4.3], [1.0, 0.2, 4.3], [0.3, 0.5, 9.8]] as const) {
      const want = hammerstadJensen(w * mm, h * mm, er), got = solveLine({ kind: 'microstrip', width: w * mm, thickness: h * mm * 0.01, h1: h * mm, er1: er }, 6);
      expect(got.z0 / want.z0).toBeGreaterThan(0.98); expect(got.z0 / want.z0).toBeLessThan(1.02);
      expect(got.eff / want.eff).toBeGreaterThan(0.98); expect(got.eff / want.eff).toBeLessThan(1.02);
    }
    // The closed form itself: 50 Ω is near 0.39 mm on 0.2 mm of 4.3
    expect(hammerstadJensen(0.39 * mm, 0.2 * mm, 4.3).z0).toBeGreaterThan(49); expect(hammerstadJensen(0.39 * mm, 0.2 * mm, 4.3).z0).toBeLessThan(51);
  }, 60000);

  it('a thin stripline midway between its planes against the exact formula', () => {
    for (const [w, b, er] of [[0.1, 0.4, 4.3], [0.2, 0.4, 4.3], [0.5, 0.6, 3.5]] as const) {
      const want = striplineExact(w * mm, b * mm, er), got = solveLine({ kind: 'stripline', width: w * mm, thickness: b * mm * 0.004, h1: (b * mm) / 2 - b * mm * 0.002, er1: er, h2: (b * mm) / 2 + b * mm * 0.002, er2: er });
      expect(got.z0 / want).toBeGreaterThan(0.98); expect(got.z0 / want).toBeLessThan(1.02);
      expect(got.eff).toBeCloseTo(er, 2);
    }
  }, 60000);

  const ms: LineSetup = { kind: 'microstrip', width: 0.36 * mm, thickness: 0.035 * mm, h1: 0.2 * mm, er1: 4.3 };

  it('copper with thickness, a solder mask, an etched slope: each moves the impedance the way it should', () => {
    const plain = solveLine(ms);
    expect(plain.z0).toBeGreaterThan(48.5); expect(plain.z0).toBeLessThan(51.5);
    // Thicker copper: lower. A mask over it: lower, and a higher effective constant. A narrower top: higher
    expect(solveLine({ ...ms, thickness: 0.07 * mm }).z0).toBeLessThan(plain.z0 - 0.5);
    const masked = solveLine({ ...ms, mask: { thickness: 0.02 * mm, er: 3.5 } });
    expect(masked.z0).toBeLessThan(plain.z0 - 0.5); expect(masked.z0).toBeGreaterThan(plain.z0 - 4); expect(masked.eff).toBeGreaterThan(plain.eff);
    expect(solveLine({ ...ms, etch: 0.03 * mm }).z0).toBeGreaterThan(plain.z0 + 0.2);
    // What it is made of: the delay from the effective constant, and L·C the delay squared
    expect(plain.delay).toBeCloseTo(Math.sqrt(plain.eff) / 299_792_458, 15);
    expect(Math.sqrt(plain.l * plain.c) / plain.delay).toBeCloseTo(1, 9);
    expect(Math.sqrt(plain.l / plain.c) / plain.z0).toBeCloseTo(1, 9);
    // A finer grid says the same to half a per cent
    expect(solveLine(ms, 12).z0 / solveLine(ms, 6).z0).toBeGreaterThan(0.995);
    expect(solveLine(ms, 12).z0 / solveLine(ms, 6).z0).toBeLessThan(1.005);
  }, 60000);

  it('a pair: close together its modes part, far apart each is the single track; side grounds far off make no difference', () => {
    const single = solveLine({ ...ms, width: 0.2 * mm });
    const close = solveLine({ ...ms, width: 0.2 * mm, pair: 0.2 * mm }).pair!, far = solveLine({ ...ms, width: 0.2 * mm, pair: 3 * mm }).pair!;
    expect(close.odd).toBeLessThan(single.z0); expect(close.even).toBeGreaterThan(single.z0);
    expect(close.differential).toBeCloseTo(2 * close.odd, 9); expect(close.common).toBeCloseTo(close.even / 2, 9);
    expect(close.coupling).toBeGreaterThan(0.1); expect(close.coupling).toBeLessThan(0.3);
    expect(close.effOdd).toBeLessThan(close.effEven);
    expect(far.odd / single.z0).toBeGreaterThan(0.99); expect(far.even / single.z0).toBeLessThan(1.01);
    expect(far.coupling).toBeLessThan(0.01);
    const plain = solveLine(ms);
    expect(solveLine({ ...ms, coplanar: 0.15 * mm }).z0).toBeLessThan(plain.z0 - 2);
    expect(solveLine({ ...ms, coplanar: 3 * mm }).z0 / plain.z0).toBeGreaterThan(0.99);
    // A track buried under more dielectric: lower, and slower
    const buried = solveLine({ kind: 'embedded', width: 0.36 * mm, thickness: 0.035 * mm, h1: 0.2 * mm, er1: 4.3, h2: 0.15 * mm, er2: 4.3 });
    expect(buried.z0).toBeLessThan(plain.z0); expect(buried.eff).toBeGreaterThan(plain.eff); expect(buried.eff).toBeLessThan(4.3);
  }, 60000);

  it('the width for an impedance: 50 Ω alone, 100 Ω as a pair', () => {
    const w = widthFor(ms, 50);
    expect(w / mm).toBeGreaterThan(0.33); expect(w / mm).toBeLessThan(0.39);
    expect(solveLine({ ...ms, width: w }).z0).toBeCloseTo(50, 0);
    const wp = widthFor({ ...ms, pair: 0.2 * mm }, 100);
    expect(solveLine({ ...ms, width: wp, pair: 0.2 * mm }).pair!.differential / 100).toBeGreaterThan(0.99);
    expect(solveLine({ ...ms, width: wp, pair: 0.2 * mm }).pair!.differential / 100).toBeLessThan(1.01);
    // Out of reach: the narrowest or the widest it will try
    expect(widthFor(ms, 500)).toBeCloseTo(0.2 * mm / 20, 12);
    expect(widthFor(ms, 1)).toBeCloseTo(0.2 * mm * 20, 12);
  }, 120000);

  it('the panel\'s form: millimetres or mils, what is missing said, a layer\'s stack taken from the board', () => {
    const f = defaultLineForm(), s = formLine(f) as LineSetup, near = (got: number | undefined, want: number) => expect(got! / want).toBeCloseTo(1, 9);
    expect([s.kind, s.er1, s.h2, s.pair, s.mask]).toEqual(['microstrip', 4.3, undefined, undefined, undefined]);
    near(s.width, 0.36e-3); near(s.thickness, 0.035e-3); near(s.h1, 0.2e-3);
    const inMil = formLine({ ...f, unit: 'mil', width: '10', thickness: '1.4', h1: '8' }) as LineSetup;
    near(inMil.width, 254e-6); near(inMil.thickness, 1.4 * 25.4e-6); near(inMil.h1, 8 * 25.4e-6);
    // A stripline's upper dielectric is given from the track's top; the solver measures from its foot
    const strip = formLine({ ...f, kind: 'stripline', above: '0.2' }) as LineSetup;
    expect([strip.kind, strip.er2]).toEqual(['stripline', 4.3]); near(strip.h2, 0.235e-3);
    const all = formLine({ ...f, pair: true, coplanar: true, mask: true, etch: '0,02' }) as LineSetup;
    near(all.pair, 0.2e-3); near(all.coplanar, 0.2e-3); near(all.mask!.thickness, 0.02e-3); near(all.etch, 0.02e-3); expect(all.mask!.er).toBe(3.5);
    expect(formLine({ ...f, width: '' })).toBe('Give the track\'s width.');
    expect(formLine({ ...f, er1: '0.5' })).toMatch(/^Give the height and the constant of the dielectric under/);
    expect(formLine({ ...f, kind: 'embedded', above: '0' })).toMatch(/^Give the height and the constant of the dielectric over/);
    expect(formLine({ ...f, pair: true, gap: '-1' })).toBe('Give the gap between the two tracks.');
    expect(formLine({ ...f, etch: '0.5' })).toMatch(/^The top cannot be narrower than nothing/);
    expect([unitM('mm'), unitM('mil'), shown(0.36e-3, 'mm'), shown(254e-6, 'mil')]).toEqual([1e-3, 25.4e-6, '0.36', '10']);
    // The demo board's top layer: on the surface, the board's dielectric under it
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'), top = lineFromStack(doc, L.TOP, 'mm')!;
    expect(top.kind).toBe('microstrip');
    expect(parseFloat(top.h1!)).toBeGreaterThan(0.1); expect(parseFloat(top.h1!)).toBeLessThan(3);
    expect(parseFloat(top.er1!)).toBeGreaterThan(2); expect(parseFloat(top.er1!)).toBeLessThan(6);
    expect(parseFloat(top.thickness!)).toBeGreaterThan(0.01); expect(parseFloat(top.thickness!)).toBeLessThan(0.11);
    expect(lineFromStack(doc, L.BOTTOM, 'mm')!.kind).toBe('microstrip');
    expect(lineFromStack(doc, L.MID1, 'mm')).toBeNull();
    // The picture: the track at 1 V, the plane at 0 V, everything else between
    const pic = fieldPicture(s, 4);
    expect(pic.v.length).toBe(pic.xs.length * pic.ys.length);
    let lo = Infinity, hi = -Infinity;
    for (const v of pic.v) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(lo).toBeCloseTo(0, 9); expect(hi).toBeCloseTo(1, 9);
    expect([...new Set(pic.role)].sort()).toEqual([0, 1, 2]);
  }, 60000);
});
