/**
 * Altium power-port glyphs, in mil, in the port's own frame: +a runs from the connection
 * point along the stem, +b is perpendicular. Dimensions follow the geometry KiCad's Altium
 * importer uses to reproduce each STYLE (stroke 10 mil; circle and wave 5 mil).
 *
 *   0 circle   1 arrow   2 bar   3 wave   4 power ground   5 signal ground   6 earth
 *   7 GOST arrow   8 GOST power ground   9 GOST earth   10 GOST bar
 */
export type Pt = [a: number, b: number];

export interface PowerGlyph {
  lines: Pt[][];                                  // open polylines
  circles?: { c: Pt; r: number; w?: number }[];   // w: stroke, mil (default 10)
  beziers?: [Pt, Pt, Pt, Pt][];
  /** Distance along the stem to the label's near edge. */
  labelAt: number;
}

const stem = (len: number): Pt[] => [[0, 0], [len, 0]];
const bar = (a: number, half: number): Pt[] => [[a, -half], [a, half]];

export function powerGlyph(style: number): PowerGlyph {
  switch (style) {
    case 0: return { lines: [stem(50)], circles: [{ c: [75, 0], r: 25, w: 5 }], labelAt: 125 };
    case 1: return { lines: [stem(50), [[50, -25], [50, 25], [100, 0], [50, -25]]], labelAt: 125 };
    case 3: return { lines: [stem(72)], beziers: [[[50, 30], [87, 30], [63, -30], [100, -30]]], labelAt: 125 };
    case 4: return { lines: [stem(100), bar(100, 100), bar(130, 70), bar(160, 40), bar(190, 10)], labelAt: 215 };
    case 5: return { lines: [stem(100), [[100, -100], [100, 100], [200, 0], [100, -100]]], labelAt: 225 };
    case 6: return { lines: [stem(100), [[200, -150], [100, -100], [100, 100], [200, 50]], [[100, 0], [200, -50]]], labelAt: 225 };
    case 7: return { lines: [stem(100), [[50, -25], [100, 0], [50, 25]]], labelAt: 125 };
    case 8: return { lines: [stem(160), bar(160, 100), bar(200, 60), bar(240, 20)], labelAt: 265 };
    case 9: return { lines: [stem(160), bar(160, 100), bar(200, 60), bar(240, 20)], circles: [{ c: [160, 0], r: 120 }], labelAt: 305 };
    case 10: return { lines: [stem(200), bar(200, 100)], labelAt: 225 };
    default: return { lines: [stem(100), bar(100, 50)], labelAt: 125 }; // 2 bar (and unknown)
  }
}

/** Sample a cubic Bézier into a polyline. */
export function bezierPts(p: [Pt, Pt, Pt, Pt], n = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push([
      u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
      u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1],
    ]);
  }
  return out;
}
