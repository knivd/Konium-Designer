/**
 * IEEE symbols (record 3, Place › IEEE Symbols in the library editor). SYMBOL numbers the shape
 * in the same order as pin symbols (Altium's IEEE symbol list: 1 Dot … 34 Bidirectional Signal
 * Flow) [kc]. Geometry [est]: drawn in a cell of `u` = SCALEFACTOR × 10 mil, LOCATION at its
 * lower-left corner; verify against a library drawn in Altium.
 */
import type { Pt } from './powerPort';

export { IEEE_SYMBOLS } from '../../model/schPlace';

/** The Place › IEEE Symbols command for each SYMBOL. */
export const IEEE_COMMANDS: Record<number, string> = {
  1: 'Dot', 2: 'RightLeftSignalFlow', 3: 'Clock', 4: 'ActiveLowInput', 5: 'AnalogSignalIn', 6: 'NotLogicConnection', 7: 'ShiftRight', 8: 'PostponedOutput',
  9: 'OpenCollector', 10: 'Hiz', 11: 'HighCurrent', 12: 'Pulse', 13: 'Schmitt', 14: 'Delay', 15: 'GroupLine', 16: 'GroupBinary', 17: 'ActiveLowOutput',
  18: 'PiSymbol', 19: 'GreaterEqual', 20: 'LessEqual', 21: 'Sigma', 22: 'OpenCollectorPullUp', 23: 'OpenEmitter', 24: 'OpenEmitterPullUp',
  25: 'DigitalSignalIn', 26: 'AndGate', 27: 'Invertor', 28: 'OrGate', 29: 'XorGate', 30: 'ShiftLeft', 31: 'InputOutput',
};
/** Altium's command ids: most are PlaceIEEE<Name>Symbol, a few aren't. */
export function ieeeCommandId(n: number): string {
  if (n === 32) return 'ad:Sch:PlaceIEEEOpenCircuitOutput';
  if (n === 33) return 'ad:Sch:PlaceIEEELeftRightSignalFlow';
  if (n === 34) return 'ad:Sch:PlaceIEEEBidirectionalSignalFlow';
  return `ad:Sch:PlaceIEEE${IEEE_COMMANDS[n]}Symbol`;
}

const arcPts = (cx: number, cy: number, r: number, a0: number, a1: number, n = 12): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => { const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt; });
const diamond: Pt[] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5], [0.5, 0]];
const orBody = (): Pt[][] => {
  const back = arcPts(-0.6, 0.5, 0.8, -39, 39);
  const top = arcPts(0, -0.6, 1.6, 90, 47).map(([x, y]) => [x * 0.75, y] as Pt);
  const bottom = arcPts(0, 1.6, 1.6, -90, -47).map(([x, y]) => [x * 0.75, y] as Pt);
  return [back, [[0, 1], ...top.slice(1)], [[0, 0], ...bottom.slice(1)]];
};

/** The glyph of one IEEE symbol, in cells (1 = u); lines, fills and circles as for pins. */
export function ieeeGlyph(n: number): { lines: Pt[][]; fills: Pt[][]; circles: { c: Pt; r: number }[] } {
  const L = (...l: Pt[][]) => ({ lines: l, fills: [] as Pt[][], circles: [] as { c: Pt; r: number }[] });
  switch (n) {
    case 1: return { lines: [], fills: [], circles: [{ c: [0.5, 0.5], r: 0.5 }] };
    case 2: return { lines: [], fills: [[[0, 0.5], [1, 0.85], [1, 0.15]]], circles: [] };
    case 3: return L([[0, 0], [0.7, 0.5], [0, 1]]);
    case 4: return L([[0, 0], [1, 0.5], [1, 0], [0, 0]]);
    case 5: return L([[0, 0], [0, 0.6], [0.25, 0.9], [0.75, 0.9], [1, 0.6], [1, 0]]);
    case 6: return L([[0, 0], [1, 1]], [[0, 1], [1, 0]]);
    case 7: return L([[0, 0.5], [1, 0.5]], [[0.65, 0.8], [1, 0.5], [0.65, 0.2]]);
    case 8: return L([[0, 1], [0.8, 1], [0.8, 0]]);
    case 9: return L(diamond, [[0, 0], [1, 0]]);
    case 10: return L([[0, 1], [1, 1], [0.5, 0], [0, 1]]);
    case 11: return L([[0, 1], [1, 0.5], [0, 0], [0, 1]]);
    case 12: return L([[0, 0], [0.25, 0], [0.25, 1], [0.75, 1], [0.75, 0], [1, 0]]);
    case 13: return L([[0, 0], [0.7, 0], [0.7, 1]], [[0.3, 0], [0.3, 1], [1, 1]]);
    case 14: return L([[0, 0.2], [0, 0.8]], [[0, 0.5], [1, 0.5]], [[1, 0.2], [1, 0.8]]);
    case 15: return L([[0, 0.5], [1, 0.5]], [[0, 0.3], [0, 0.7]], [[1, 0.3], [1, 0.7]]);
    case 16: return L([[0, 0.35], [1, 0.35]], [[0, 0.65], [1, 0.65]]);
    case 17: return L([[0, 0.5], [1, 0]]);
    case 18: return L([[0, 1], [1, 1]], [[0.3, 1], [0.3, 0]], [[0.7, 1], [0.7, 0]]);
    case 19: return L([[0, 1], [1, 0.65], [0, 0.3]], [[0, 0.1], [1, 0.1]]);
    case 20: return L([[1, 1], [0, 0.65], [1, 0.3]], [[0, 0.1], [1, 0.1]]);
    case 21: return L([[1, 1], [0, 1], [0.5, 0.5], [0, 0], [1, 0]]);
    case 22: return L(diamond, [[0, 0], [1, 0]], [[0, 0.5], [1, 0.5]]);
    case 23: return L(diamond, [[0, 1], [1, 1]]);
    case 24: return L(diamond, [[0, 1], [1, 1]], [[0, 0.5], [1, 0.5]]);
    case 25: return L([[0.3, 0], [0.3, 1]], [[0.7, 0], [0.7, 1]], [[0, 0.35], [1, 0.35]], [[0, 0.65], [1, 0.65]]);
    case 26: return L([[0.5, 0], [0, 0], [0, 1], [0.5, 1]], arcPts(0.5, 0.5, 0.5, 90, -90));
    case 27: return { lines: [[[0, 0], [0, 1], [0.8, 0.5], [0, 0]]], fills: [], circles: [{ c: [0.9, 0.5], r: 0.1 }] };
    case 28: return L(...orBody());
    case 29: return L(...orBody(), arcPts(-0.75, 0.5, 0.8, -39, 39));
    case 30: return L([[0, 0.5], [1, 0.5]], [[0.35, 0.8], [0, 0.5], [0.35, 0.2]]);
    case 31: return L([[0, 0.5], [1, 0.5]], [[0.3, 0.8], [0, 0.5], [0.3, 0.2]], [[0.7, 0.8], [1, 0.5], [0.7, 0.2]]);
    case 32: return L(diamond);
    case 33: return { lines: [], fills: [[[1, 0.5], [0, 0.85], [0, 0.15]]], circles: [] };
    case 34: return { lines: [], fills: [[[0, 0.5], [0.5, 0.85], [0.5, 0.15]], [[1, 0.5], [0.5, 0.85], [0.5, 0.15]]], circles: [] };
    default: return L([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
  }
}

