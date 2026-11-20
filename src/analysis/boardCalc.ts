/**
 * The board's sums behind Tools › Calculators: what a track of a given width carries for a given
 * temperature rise (and the width for a current, the rise for a width), its resistance and the
 * voltage it drops, a via's barrel likewise, the spacing a voltage asks for, and a track's
 * impedance. They are the analysis code's own formulas: IPC-2221's chart as Power Analysis uses it
 * (ipc2221, rail.ts), copper's conductivity as the solver has it, and the Field Solver's
 * cross-section for the impedance, so a number here is the number those tools give.
 *
 * Lengths in metres, currents in amperes, temperatures in degrees Celsius.
 */
import { COPPER_ALPHA, COPPER_SIGMA_20 } from './copperNet';
import { ipc2221 } from './rail';
import { solveLine, widthFor, type LineResult, type LineSetup } from './field2d';

const SQ_MIL = 6.4516e-10;
const K = (inner: boolean) => (inner ? 0.024 : 0.048);

/** The cross-section (m²) IPC-2221 asks for a current and a rise: its formula turned round. */
export function areaFor(current: number, rise: number, inner: boolean): number {
  return (current / (K(inner) * rise ** 0.44)) ** (1 / 0.725) * SQ_MIL;
}

/** The rise (°C) IPC-2221 gives a cross-section carrying a current. */
export function riseFor(current: number, areaM2: number, inner: boolean): number {
  return (current / (K(inner) * (areaM2 / SQ_MIL) ** 0.725)) ** (1 / 0.44);
}

/** Copper's resistance: a length of a cross-section at a temperature. */
export function copperResistance(length: number, areaM2: number, temperature = 20): number {
  return (length / (COPPER_SIGMA_20 * areaM2)) * (1 + COPPER_ALPHA * (temperature - 20));
}

export interface TrackSums {
  width: number; current: number; rise: number; area: number;
  /** With a length given: its resistance at the ambient temperature plus the rise, the voltage it drops and the power it loses at the current. */
  resistance?: number; drop?: number; loss?: number;
  /** Where the chart the formula stands for does not reach: said, not hidden. */
  outside: string[];
}

/**
 * A track: the one of width, current and rise named by `find` from the other two, on copper of a
 * thickness, on an outer layer or inside the board.
 */
export function trackSums(find: 'width' | 'current' | 'rise', given: { width?: number; current?: number; rise?: number; thickness: number; inner: boolean; length?: number; ambient?: number }): TrackSums | null {
  let { width = NaN, current = NaN, rise = NaN } = given;
  const { thickness, inner } = given;
  if (!(thickness > 0)) return null;
  if (find === 'current') current = ipc2221(width * thickness, rise, inner);
  else if (find === 'width') width = areaFor(current, rise, inner) / thickness;
  else rise = riseFor(current, width * thickness, inner);
  if (![width, current, rise].every((v) => Number.isFinite(v) && v > 0)) return null;
  const area = width * thickness, out: TrackSums = { width, current, rise, area, outside: [] };
  // IPC-2221's chart: up to 35 A, rises of 10 to 100 °C, widths up to 400 mil, copper of half an ounce to three
  if (current > 35) out.outside.push('over 35 A');
  if (rise < 10 || rise > 100) out.outside.push('a rise outside 10 to 100 °C');
  if (width > 400 * 25.4e-6) out.outside.push('wider than 400 mil (10.16 mm)');
  if (thickness < 17e-6 || thickness > 106e-6) out.outside.push('copper outside 0.5 to 3 oz');
  if (given.length !== undefined && given.length > 0 && Number.isFinite(given.length)) {
    out.resistance = copperResistance(given.length, area, (given.ambient ?? 25) + rise);
    out.drop = out.resistance * current; out.loss = out.drop * current;
  }
  return out;
}

export interface ViaSums {
  /** The barrel's copper: its cross-section, and what it carries for the rise (IPC-2221, as a conductor inside the board, the way Power Analysis rates a barrel). */
  area: number; current: number;
  /** One via's resistance at the ambient temperature plus the rise, its thermal resistance end to end, and its inductance. */
  resistance: number; thermal: number; inductance: number;
  /** With a current and a count given: the current in each, the voltage dropped and the rise it gives. */
  each?: number; drop?: number; rise?: number;
}

/** Copper's thermal conductivity, W/(m·K). */
export const COPPER_K = 385;

/**
 * A via: a hole of a finished diameter plated to a thickness, as long as the board is thick.
 * Its inductance is the usual estimate for a round wire of its length, 5.08·h·(ln(4h / d) + 1) nH
 * with h and d in inches.
 */
export function viaSums(given: { hole: number; plating: number; length: number; rise: number; ambient?: number; current?: number; count?: number }): ViaSums | null {
  const { hole, plating, length, rise } = given;
  if (![hole, plating, length, rise].every((v) => Number.isFinite(v) && v > 0)) return null;
  const area = Math.PI * (hole + plating) * plating;
  const out: ViaSums = {
    area, current: ipc2221(area, rise, true),
    resistance: copperResistance(length, area, (given.ambient ?? 25) + rise),
    thermal: length / (COPPER_K * area),
    inductance: 2e-7 * length * (Math.log((4 * length) / hole) + 1),
  };
  if (given.current !== undefined && given.current > 0 && Number.isFinite(given.current)) {
    const n = Math.max(1, Math.round(given.count ?? 1));
    out.each = given.current / n; out.drop = out.each * out.resistance; out.rise = riseFor(out.each, area, true);
  }
  return out;
}

/** IPC-2221B's table of electrical conductor spacing: the columns, and the least spacing in millimetres for each band of voltage (peak, between the conductors). */
export const SPACING_COLUMNS: { id: string; name: string }[] = [
  { id: 'B1', name: 'Inside the board' },
  { id: 'B2', name: 'Outer layer, bare, up to 3050 m' },
  { id: 'B3', name: 'Outer layer, bare, above 3050 m' },
  { id: 'B4', name: 'Outer layer under solder mask' },
  { id: 'A5', name: 'Outer layer under conformal coating' },
  { id: 'A6', name: 'Part leads and terminations, bare' },
  { id: 'A7', name: 'Part leads and terminations, coated' },
];
const SPACING: [upTo: number, mm: number[]][] = [
  [15, [0.05, 0.1, 0.1, 0.05, 0.13, 0.13, 0.13]],
  [30, [0.05, 0.1, 0.1, 0.05, 0.13, 0.25, 0.13]],
  [50, [0.1, 0.6, 0.6, 0.13, 0.13, 0.4, 0.13]],
  [100, [0.1, 0.6, 1.5, 0.13, 0.13, 0.5, 0.13]],
  [150, [0.2, 0.6, 3.2, 0.4, 0.4, 0.8, 0.4]],
  [170, [0.2, 1.25, 3.2, 0.4, 0.4, 0.8, 0.4]],
  [250, [0.2, 1.25, 6.4, 0.4, 0.4, 0.8, 0.4]],
  [300, [0.2, 1.25, 12.5, 0.4, 0.4, 0.8, 0.8]],
  [500, [0.25, 2.5, 12.5, 0.8, 0.8, 1.5, 0.8]],
];
/** Over 500 V: millimetres more for each volt over. */
const SPACING_PER_VOLT = [0.0025, 0.005, 0.025, 0.00305, 0.00305, 0.00305, 0.00305];

/** The least spacing (metres) IPC-2221B gives for a voltage, column by column. */
export function spacingFor(voltage: number): number[] | null {
  const v = Math.abs(voltage);
  if (!Number.isFinite(v)) return null;
  const row = SPACING.find(([upTo]) => v <= upTo);
  const mm = row ? row[1] : SPACING[SPACING.length - 1]![1].map((at500, i) => at500 + (v - 500) * SPACING_PER_VOLT[i]!);
  return mm.map((x) => x * 1e-3);
}

/** A single track's impedance from its cross-section (the Field Solver's own solution), on the surface or between two planes. */
export function lineSums(given: { kind: 'microstrip' | 'stripline'; width: number; thickness: number; height: number; er: number; above?: number }): LineResult | null {
  const s = lineSetup(given);
  return s ? solveLine(s) : null;
}

/** The width that gives an impedance, by the same solution. */
export function lineWidth(target: number, given: { kind: 'microstrip' | 'stripline'; thickness: number; height: number; er: number; above?: number }): number | null {
  const s = lineSetup({ ...given, width: given.height });
  if (!s || !(target > 0) || !Number.isFinite(target)) return null;
  const w = widthFor(s, target);
  return Number.isFinite(w) && w > 0 ? w : null;
}

function lineSetup(g: { kind: 'microstrip' | 'stripline'; width: number; thickness: number; height: number; er: number; above?: number }): LineSetup | null {
  if (![g.width, g.thickness, g.height, g.er].every((v) => Number.isFinite(v) && v > 0) || g.er < 1) return null;
  if (g.kind === 'microstrip') return { kind: 'microstrip', width: g.width, thickness: g.thickness, h1: g.height, er1: g.er };
  const above = g.above !== undefined && g.above > 0 && Number.isFinite(g.above) ? g.above : g.height;
  if (above <= g.thickness) return null;
  return { kind: 'stripline', width: g.width, thickness: g.thickness, h1: g.height, er1: g.er, h2: above, er2: g.er };
}
