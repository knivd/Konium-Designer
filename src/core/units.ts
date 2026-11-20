/**
 * Internal coordinate unit: 1/10000 mil (2.54 nm), stored as integers.
 *
 * This is Altium's own PCB binary unit, and the schematic pair X (10 mil steps) + X_FRAC
 * (1/10000 mil) collapses to the same unit: X*100000 + X_FRAC. Keeping the file's native
 * unit means a load/save round-trip never introduces rounding drift.
 */
export type Coord = number;

export const UNITS_PER_MIL = 10_000;
export const UNITS_PER_INCH = 10_000_000;
export const UNITS_PER_MM = UNITS_PER_INCH / 25.4; // 393700.787…

export const mil = (v: number): Coord => Math.round(v * UNITS_PER_MIL);
export const mm = (v: number): Coord => Math.round(v * UNITS_PER_MM);
export const toMil = (c: Coord): number => c / UNITS_PER_MIL;
export const toMm = (c: Coord): number => c / UNITS_PER_MM;

export type DisplayUnit = 'mil' | 'mm';

/**
 * A schematic's DISPLAY_UNIT (Document Options › Units): 0 mils, 1 millimetres, 4 Dxp Defaults
 * (10 mil units, no suffix), 7 Auto-Metric (all four checked against AD17 files);
 * 2 inches, 3 centimetres, 5 metres, 6 Auto-Imperial [est: by the order of the dialog's list].
 */
export const SCH_UNIT_CODES = { mil: 0, mm: 1, in: 2, cm: 3, dxp: 4, m: 5, autoImperial: 6, autoMetric: 7 } as const;
export const isMetricUnit = (code: number) => code === 1 || code === 3 || code === 5 || code === 7;

/** A schematic length as its document's unit shows it in the status bar. */
export function formatSchLength(c: Coord, code: number): string {
  const ml = c / UNITS_PER_MIL, mmv = c / UNITS_PER_MM;
  const f = (v: number, d: number, u: string) => `${trimNum(v.toFixed(d))}${u}`;
  switch (code) {
    case 1: return f(mmv, 3, 'mm');
    case 2: return f(ml / 1000, 4, 'in');
    case 3: return f(mmv / 10, 4, 'cm');
    case 4: return f(ml / 10, 2, '');
    case 5: return f(mmv / 1000, 5, 'm');
    case 6: return Math.abs(ml) >= 1000 ? f(ml / 1000, 4, 'in') : f(ml, 1, 'mil');
    case 7: return Math.abs(mmv) >= 1000 ? f(mmv / 1000, 5, 'm') : Math.abs(mmv) >= 100 ? f(mmv / 10, 4, 'cm') : f(mmv, 3, 'mm');
    default: return f(ml, 1, 'mil');
  }
}

/** A schematic length in a field, in the document's unit (`digits` more precise than the status bar). */
export function formatSchField(c: Coord, code: number): string {
  const ml = c / UNITS_PER_MIL, mmv = c / UNITS_PER_MM;
  const f = (v: number, d: number, u: string) => `${trimNum(v.toFixed(d))}${u}`;
  switch (code) {
    case 1: return f(mmv, 4, 'mm');
    case 2: return f(ml / 1000, 5, 'in');
    case 3: return f(mmv / 10, 5, 'cm');
    case 4: return f(ml / 10, 4, '');
    case 5: return f(mmv / 1000, 6, 'm');
    case 6: return Math.abs(ml) >= 1000 ? f(ml / 1000, 5, 'in') : f(ml, 3, 'mil');
    case 7: return Math.abs(mmv) >= 1000 ? f(mmv / 1000, 6, 'm') : Math.abs(mmv) >= 100 ? f(mmv / 10, 5, 'cm') : f(mmv, 4, 'mm');
    default: return f(ml, 3, 'mil');
  }
}

/** One of a schematic unit's steps, in internal units (Dxp Defaults: 10 mil). */
const SCH_STEP: Record<number, number> = { 0: UNITS_PER_MIL, 1: UNITS_PER_MM, 2: UNITS_PER_INCH, 3: 10 * UNITS_PER_MM, 4: 10 * UNITS_PER_MIL, 5: 1000 * UNITS_PER_MM, 6: UNITS_PER_MIL, 7: UNITS_PER_MM };

/** A schematic length typed in a field: a bare number is in the document's unit (Dxp Defaults: 10 mil units); mil, mm, cm, in, m as written. */
export function parseSchField(v: string, code: number): Coord | undefined {
  const m = /^\s*(-?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*(mil|mm|cm|in|m)?\s*$/i.exec(v);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]!);
  const unit = m[2]?.toLowerCase();
  const per = unit === 'mil' ? UNITS_PER_MIL : unit === 'mm' ? UNITS_PER_MM : unit === 'cm' ? 10 * UNITS_PER_MM : unit === 'in' ? UNITS_PER_INCH : unit === 'm' ? 1000 * UNITS_PER_MM : SCH_STEP[code] ?? UNITS_PER_MIL;
  return Math.round(n * per);
}

export function formatCoord(c: Coord, unit: DisplayUnit, digits = unit === 'mil' ? 1 : 3): string {
  const v = unit === 'mil' ? toMil(c) : toMm(c);
  return `${trimNum(v.toFixed(digits))}${unit}`;
}

export function trimNum(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/**
 * Parse an Altium PCB text-property length, e.g. "1234.5678mil", "1.5mm", "0mil".
 * A bare number is taken as mil. Returns undefined if unparseable.
 */
export function parseLength(s: string | undefined): Coord | undefined {
  if (s == null) return undefined;
  const m = /^\s*(-?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)\s*(mil|mm|in)?\s*$/i.exec(s);
  if (!m) return undefined;
  const v = parseFloat(m[1]!);
  switch ((m[2] ?? 'mil').toLowerCase()) {
    case 'mm': return Math.round(v * UNITS_PER_MM);
    case 'in': return Math.round(v * UNITS_PER_INCH);
    default: return Math.round(v * UNITS_PER_MIL);
  }
}

/** A length typed into a field: a bare number is in the unit shown (`unit`), else as written (10mil, 0.25mm). */
export function parseLengthIn(s: string | undefined, unit: string): Coord | undefined {
  if (s == null) return undefined;
  const t = s.trim();
  return parseLength(/^-?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?$/.test(t) ? `${t}${unit}` : t);
}

/**
 * Format a Coord the way Altium writes PCB text lengths: mil with up to 4 decimals.
 * [est: how many trailing zeros the desktop software writes is not confirmed against its files]
 */
export function formatAltiumLength(c: Coord): string {
  return `${trimNum((c / UNITS_PER_MIL).toFixed(4))}mil`;
}

/** Schematic: one DXP unit = 10 mil. */
export const SCH_UNIT = 100_000;

/** Grid presets offered by the G key, per editor. */
export const SCH_GRIDS: Coord[] = [mil(10), mil(50), mil(100), mil(200)];
export const PCB_GRIDS: Coord[] = [mil(1), mil(5), mil(10), mil(25), mil(50), mm(0.05), mm(0.1), mm(0.25), mm(0.5), mm(1)];
