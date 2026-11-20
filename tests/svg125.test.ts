import { describe, expect, it } from 'vitest';
import { shapesBox, svgShapes, transformOf } from '../src/formats/svgShapes';

const area = (p: [number, number][]) => Math.abs(p.reduce((t, a, i) => { const b = p[(i + 1) % p.length]!; return t + a[0] * b[1] - b[0] * a[1]; }, 0) / 2);

describe('A drawing\'s filled shapes (SVG), for logos on an enclosure', () => {
  it('sizes from width, height and viewBox; y up; transforms of groups and shapes', () => {
    const svg = `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">
<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 400 200">
 <g transform="translate(100 50)"><rect x="0" y="0" width="100" height="50"/></g>
 <rect x="0" y="0" width="10" height="10" fill="none" stroke="black"/>
 <defs><rect width="400" height="200"/></defs>
</svg>`;
    const sh = svgShapes(svg);
    expect(sh).toHaveLength(1);
    const b = shapesBox(sh);
    // 400 user units over 40 mm: 0.1 mm each; y turned up (the drawing's top at 0)
    expect([b.x0, b.x1, b.y0, b.y1].map((v) => Math.round(v * 1000) / 1000)).toEqual([10, 20, -10, -5]);
    expect(area(sh[0]!.rings[0]!)).toBeCloseTo(50, 6);
  });
  it('rotate, scale, matrix and skew; nested groups', () => {
    const m = transformOf('translate(10,0) rotate(90) scale(2)');
    // (1, 0) scaled to (2, 0), turned to (0, 2), moved to (10, 2)
    expect([m[0] * 1 + m[4], m[1] * 1 + m[5]].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([10, 2]);
    expect(transformOf('matrix(1 0 0 1 5 6)')).toEqual([1, 0, 0, 1, 5, 6]);
    const sh = svgShapes('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><g transform="scale(2)"><g transform="rotate(45 10 10)"><rect x="5" y="5" width="10" height="10"/></g></g></svg>');
    // 100 px over 100 user units: 25.4/96 mm each; the square 20 px a side after scale(2)
    const k = 25.4 / 96;
    expect(area(sh[0]!.rings[0]!)).toBeCloseTo(400 * k * k, 4);
  });
  it('a path with a hole: fill-rule kept; circles, ellipses, rounded rectangles, polygons', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100mm" height="100mm">
 <path fill-rule="evenodd" d="M0 0 H50 V50 H0 Z M10 10 h30 v30 h-30 z"/>
 <circle cx="70" cy="20" r="10" style="fill:#000"/>
 <ellipse cx="70" cy="70" rx="10" ry="5"/>
 <rect x="0" y="60" width="40" height="30" rx="5"/>
 <polygon points="50,90 60,99 40,99"/>
 <path d="M0 0 L5 5" style="fill:none;stroke:black"/>
 <text x="0" y="0">Not drawn</text>
</svg>`;
    const sh = svgShapes(svg);
    expect(sh).toHaveLength(5);
    expect(sh[0]!.evenOdd).toBe(true);
    expect(sh[0]!.rings).toHaveLength(2);
    expect(sh[1]!.evenOdd).toBe(false);
    expect(area(sh[1]!.rings[0]!)).toBeCloseTo(Math.PI * 100, -0.5);
    expect(area(sh[2]!.rings[0]!)).toBeCloseTo(Math.PI * 50, -0.5);
    // A rounded rectangle: its corners' area taken off
    expect(area(sh[3]!.rings[0]!)).toBeCloseTo(40 * 30 - (4 - Math.PI) * 25, 0);
    expect(area(sh[4]!.rings[0]!)).toBeCloseTo(90, 3);
  });
  it('style sheets\' class and id rules (as drawing programs export them); a fine curve of many points kept', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10mm" height="10mm"><defs><style>.cls-1{fill:none;stroke:#000}.cls-2,.cls-3{fill:#fff}#dark{fill:#123}</style></defs>
 <rect class="cls-1" width="10" height="10"/><rect width="8" height="8"/><circle class="cls-2" cx="4" cy="4" r="2"/><rect id="dark" class="cls-3" x="8.5" y="8.5" width="1" height="1"/></svg>`;
    const sh = svgShapes(svg);
    expect(sh.map((s) => !!s.knock)).toEqual([false, true, false]);
    const pts = Array.from({ length: 2000 }, (_, k) => `${(5 + Math.cos((2 * Math.PI * k) / 2000)).toFixed(5)},${(5 + Math.sin((2 * Math.PI * k) / 2000)).toFixed(5)}`).join(' ');
    const fine = svgShapes(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10mm" height="10mm"><polygon points="${pts}"/></svg>`);
    expect(fine).toHaveLength(1);
    // Within 0.02 mm of the curve: a little under its area
    expect(area(fine[0]!.rings[0]!)).toBeGreaterThan(3.0);
    expect(area(fine[0]!.rings[0]!)).toBeLessThan(Math.PI);
  });
  it('hidden shapes and those inside clip paths and masks left out; not a drawing: none', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><clipPath id="c"><rect width="10" height="10"/></clipPath><g style="display:none"><rect width="5" height="5"/></g><rect width="2" height="2" visibility="hidden"/><rect width="3" height="3" opacity="0"/></svg>`;
    expect(svgShapes(svg)).toEqual([]);
    expect(svgShapes('not a drawing')).toEqual([]);
  });
});
