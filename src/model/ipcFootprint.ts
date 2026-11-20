/**
 * Tools › IPC Compliant Footprint Wizard (and its batch generator): land patterns from a
 * package's datasheet dimensions by IPC-7351B — the pad's outer edge Z, inner edge G and width X
 * from the lead's span L, foot T and width W (each min–max), the toe, heel and side solder
 * fillet goals of the package family at the chosen density (Most, Nominal, Least) and the
 * fabrication and placement tolerances:
 *   Zmax = Lmin + 2·Jt + √(CL² + F² + P²)
 *   Gmin = Smax − 2·Jh − √(CS² + F² + P²)      S = L − 2T, CS = √(CL² + 2·CT²)
 *   Xmax = Wmin + 2·Js + √(CW² + F² + P²)
 * rounded out to 0.05 mm (S's tolerance taken by root sum square, as IPC-7351 does); the courtyard round pads and body by the density's excess (0.05 mm
 * grid), the body on the assembly layer, the silkscreen clear of the pads, a 3D body to the
 * package's height, and IPC-7351's name (RESC1608X55N, SOIC127P600X175-8N …). Millimetres;
 * the footprint's origin at its centre, pin 1 at the upper left [est: fillet goals of the
 * families IPC-7351B leaves to tables, AD17's layers and silkscreen].
 */
import type { Vec2 } from '../core/geom';
import { mm } from '../core/units';
import { encodeArc, encodeBody, encodePad, encodeTrack } from '../formats/altium/pcbdoc';
import type { PcbRawRecord } from '../formats/altium/framing';
import { L, mechLayer } from './layers';
import { ballRow } from './footprintWizard';
import { packagePieces } from './packageBody';

export type IpcFamily = 'CHIP' | 'MOLDED' | 'MELF' | 'SOD' | 'SOT23' | 'SOT223' | 'DPAK' | 'SOIC' | 'SOP' | 'SOJ' | 'QFP' | 'PLCC' | 'SON' | 'QFN' | 'BGA';
export type Density = 'M' | 'N' | 'L';
export interface Range { min: number; max: number }

export const IPC_FAMILIES: [IpcFamily, string][] = [
  ['BGA', 'BGA — Ball Grid Array'], ['CHIP', 'CHIP — Chip resistor, capacitor, inductor'], ['DPAK', 'DPAK — Transistor outline (TO-252, TO-263)'],
  ['MELF', 'MELF — Metal electrode face'], ['MOLDED', 'MOLDED — Molded body (tantalum capacitor, diode)'], ['PLCC', 'PLCC — Plastic leaded chip carrier'],
  ['QFN', 'QFN — Quad flat no-lead'], ['QFP', 'QFP — Quad flat package'], ['SOD', 'SOD — Small outline diode'], ['SOIC', 'SOIC — Small outline IC (1.27 mm)'],
  ['SOJ', 'SOJ — Small outline J-lead'], ['SON', 'SON — Small outline no-lead (DFN)'], ['SOP', 'SOP — Small outline package (TSOP, SSOP, MSOP)'], ['SOT223', 'SOT223 — Small outline transistor with tab'],
  ['SOT23', 'SOT23 — Small outline transistor (3, 5, 6 leads)'],
];

export interface IpcSpec {
  family: IpcFamily;
  /** CHIP: RESC, CAPC, INDC; MOLDED: CAPMP, DIOM; MELF: RESMELF, DIOMELF. */
  prefix: string;
  density: Density;
  /** Body: along the rows of pins (D) and across them (E); its height. */
  bodyD: Range; bodyE: Range; height: number;
  /** Lead span across the rows (L), and for quad packages across the other pair (L2). */
  span: Range; span2: Range;
  /** Foot (terminal) length T and lead width W. */
  term: Range; leadW: Range;
  pitch: number;
  /** Pins in all (quad: on all four sides; BGA: rows × columns less the missing). */
  pins: number;
  /** Quad packages: pins on each left/right side (the rest share the top and bottom). */
  pinsSide: number;
  /** Thermal pad (QFN, SON) or tab (SOT223, DPAK): width, length (0: none). */
  tabW: number; tabL: number;
  /** BGA: ball diameter, rows and columns. */
  ball: number; rows: number; cols: number;
  /** Silkscreen and courtyard line widths. */
  silk: number; courtyardLine: number;
}

const r = (min: number, max: number): Range => ({ min, max });
export function ipcDefaults(family: IpcFamily): IpcSpec {
  const base: IpcSpec = { family, prefix: '', density: 'N', bodyD: r(0, 0), bodyE: r(0, 0), height: 1, span: r(0, 0), span2: r(0, 0), term: r(0, 0), leadW: r(0, 0),
    pitch: 1.27, pins: 8, pinsSide: 0, tabW: 0, tabL: 0, ball: 0, rows: 0, cols: 0, silk: 0.15, courtyardLine: 0.05 };
  switch (family) {
    case 'CHIP': return { ...base, prefix: 'RESC', pins: 2, bodyD: r(1.5, 1.7), bodyE: r(0.7, 0.9), span: r(1.5, 1.7), term: r(0.2, 0.5), leadW: r(0.7, 0.9), height: 0.55 };
    case 'MOLDED': return { ...base, prefix: 'CAPMP', pins: 2, bodyD: r(3.3, 3.7), bodyE: r(2.6, 3.0), span: r(3.3, 3.7), term: r(0.5, 1.1), leadW: r(2.0, 2.4), height: 2.1 };
    case 'MELF': return { ...base, prefix: 'DIOMELF', pins: 2, bodyD: r(3.3, 3.7), bodyE: r(1.4, 1.6), span: r(3.3, 3.7), term: r(0.3, 0.5), leadW: r(1.4, 1.6), height: 1.6 };
    case 'SOD': return { ...base, pins: 2, bodyD: r(1.4, 1.8), bodyE: r(2.5, 2.9), span: r(3.5, 3.9), term: r(0.25, 0.6), leadW: r(0.5, 0.7), height: 1.35, pitch: 0 };
    case 'SOT23': return { ...base, pins: 3, pitch: 0.95, bodyD: r(2.8, 3.0), bodyE: r(1.2, 1.4), span: r(2.1, 2.64), term: r(0.3, 0.6), leadW: r(0.3, 0.5), height: 1.12 };
    case 'SOT223': return { ...base, pins: 4, pitch: 2.3, bodyD: r(6.3, 6.7), bodyE: r(3.3, 3.7), span: r(6.7, 7.3), term: r(0.75, 1.1), leadW: r(0.66, 0.84), tabW: 3.0, height: 1.8 };
    case 'DPAK': return { ...base, pins: 3, pitch: 2.28, bodyD: r(6.35, 6.73), bodyE: r(5.97, 6.22), span: r(9.4, 10.4), term: r(0.89, 1.27), leadW: r(0.64, 0.89), tabW: 5.2, tabL: 1.5, height: 2.38 };
    case 'SOIC': return { ...base, pins: 8, pitch: 1.27, bodyD: r(4.8, 5.0), bodyE: r(3.8, 4.0), span: r(5.8, 6.2), term: r(0.4, 1.27), leadW: r(0.31, 0.51), height: 1.75 };
    case 'SOJ': return { ...base, pins: 36, pitch: 1.27, bodyD: r(23.37, 23.62), bodyE: r(10.03, 10.29), span: r(11.05, 11.30), term: r(0.6, 1.0), leadW: r(0.38, 0.51), height: 3.76 };
    case 'SOP': return { ...base, pins: 14, pitch: 0.65, bodyD: r(4.9, 5.1), bodyE: r(4.3, 4.5), span: r(6.25, 6.55), term: r(0.5, 0.75), leadW: r(0.19, 0.3), height: 1.2 };
    case 'QFP': return { ...base, pins: 64, pinsSide: 16, pitch: 0.5, bodyD: r(9.8, 10.2), bodyE: r(9.8, 10.2), span: r(11.8, 12.2), span2: r(11.8, 12.2), term: r(0.45, 0.75), leadW: r(0.17, 0.27), height: 1.6 };
    case 'PLCC': return { ...base, pins: 44, pinsSide: 11, pitch: 1.27, bodyD: r(16.51, 16.66), bodyE: r(16.51, 16.66), span: r(17.4, 17.65), span2: r(17.4, 17.65), term: r(0.5, 1.0), leadW: r(0.33, 0.53), height: 4.57 };
    case 'SON': return { ...base, pins: 8, pitch: 0.5, bodyD: r(1.9, 2.1), bodyE: r(1.9, 2.1), span: r(1.9, 2.1), term: r(0.3, 0.5), leadW: r(0.2, 0.3), tabW: 0.9, tabL: 1.6, height: 0.8 };
    case 'QFN': return { ...base, pins: 32, pinsSide: 8, pitch: 0.5, bodyD: r(4.9, 5.1), bodyE: r(4.9, 5.1), span: r(4.9, 5.1), span2: r(4.9, 5.1), term: r(0.3, 0.5), leadW: r(0.18, 0.3), tabW: 3.3, tabL: 3.3, height: 0.9 };
    case 'BGA': return { ...base, pins: 100, pitch: 1.0, rows: 10, cols: 10, ball: 0.5, bodyD: r(10.9, 11.1), bodyE: r(10.9, 11.1), height: 1.4 };
  }
}

/** Fillet goals (mm): toe, heel, side, courtyard excess, by family kind and density. */
type Fillets = { toe: number; heel: number; side: number; cy: number };
const T = (toe: number, heel: number, side: number, cy: number): Fillets => ({ toe, heel, side, cy });
const FILLETS: Record<string, Record<Density, Fillets>> = {
  chip: { M: T(0.55, 0, 0.05, 0.5), N: T(0.35, 0, 0, 0.25), L: T(0.15, 0, -0.05, 0.1) },
  chipSmall: { M: T(0.3, 0, 0.05, 0.2), N: T(0.2, 0, 0, 0.15), L: T(0.1, 0, 0, 0.1) },
  molded: { M: T(0.25, 0.8, 0.01, 0.5), N: T(0.15, 0.5, -0.05, 0.25), L: T(0.07, 0.2, -0.1, 0.1) },
  melf: { M: T(0.6, 0.2, 0.1, 0.5), N: T(0.4, 0.1, 0.05, 0.25), L: T(0.2, 0.02, 0.01, 0.1) },
  gull: { M: T(0.55, 0.45, 0.05, 0.5), N: T(0.35, 0.35, 0.03, 0.25), L: T(0.15, 0.25, 0.01, 0.1) },
  gullFine: { M: T(0.55, 0.45, 0.01, 0.5), N: T(0.35, 0.35, -0.02, 0.25), L: T(0.15, 0.25, -0.04, 0.1) },
  jlead: { M: T(0.1, 0.55, 0.05, 0.5), N: T(0, 0.35, 0.03, 0.25), L: T(-0.1, 0.15, 0.01, 0.1) },
  nolead: { M: T(0.4, 0, -0.04, 0.5), N: T(0.3, 0, -0.04, 0.25), L: T(0.2, 0, -0.04, 0.1) },
  bga: { M: T(0, 0, 0, 2), N: T(0, 0, 0, 1), L: T(0, 0, 0, 0.5) },
};
/** Board fabrication and part placement tolerances, and IPC-7351B's land round-off (mm). */
export const FAB_TOL = 0.05, PLACE_TOL = 0.025, ROUND = 0.05;

function filletsFor(s: IpcSpec): Fillets {
  switch (s.family) {
    case 'CHIP': return FILLETS[s.span.max < 1.6 ? 'chipSmall' : 'chip']![s.density];
    case 'MOLDED': return FILLETS.molded![s.density];
    case 'MELF': return FILLETS.melf![s.density];
    case 'PLCC': case 'SOJ': return FILLETS.jlead![s.density];
    case 'SON': case 'QFN': return FILLETS.nolead![s.density];
    case 'BGA': return FILLETS.bga![s.density];
    default: return FILLETS[s.pitch > 0 && s.pitch <= 0.625 ? 'gullFine' : 'gull']![s.density];
  }
}

const up = (v: number, step = 0.01) => +(Math.ceil(v / step - 1e-9) * step).toFixed(3);
const down = (v: number, step = 0.01) => +(Math.floor(v / step + 1e-9) * step).toFixed(3);
const rms = (...v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));

/** One row's land: outer edge Z, inner edge G, width X; pad length and centre-to-centre distance. */
export function land(span: Range, term: Range, w: Range, f: Fillets): { Z: number; G: number; X: number; padL: number; padW: number; C: number } {
  const CL = span.max - span.min, CT = term.max - term.min, CW = w.max - w.min;
  // The span between the feet, its tolerance taken statistically (IPC-7351's RMS S)
  const Smin = span.min - 2 * term.max, Smax = span.max - 2 * term.min;
  const CS = rms(CL, Math.SQRT2 * CT), SmaxRms = Smax - (Smax - Smin - CS) / 2;
  const Z = up(span.min + 2 * f.toe + rms(CL, FAB_TOL, PLACE_TOL), ROUND);
  const G = Math.max(0, down(SmaxRms - 2 * f.heel - rms(CS, FAB_TOL, PLACE_TOL), ROUND));
  const X = up(w.min + 2 * f.side + rms(CW, FAB_TOL, PLACE_TOL), ROUND);
  const padL = +((Z - G) / 2).toFixed(3);
  return { Z, G, X, padL, padW: X, C: +((Z + G) / 2).toFixed(3) };
}

export interface IpcPad {
  name: string; x: number; y: number; w: number; h: number; shape: 'rect' | 'round' | 'roundrect';
  /** Through-hole: the drill (and a slot's length), plated unless said. */
  hole?: number; slot?: number; plated?: boolean;
}
/** A rectangle by its size and (when not at the origin) its centre. */
export interface Box { w: number; h: number; x?: number; y?: number }
export interface IpcFootprint { name: string; description: string; pads: IpcPad[]; body: Box; courtyard: Box; silk: [Vec2, Vec2][]; pin1: Vec2; height: number; land?: ReturnType<typeof land> }

const mid = (v: Range) => (v.min + v.max) / 2;
const h100 = (v: number) => String(Math.round(v * 100));
const h10 = (v: number) => String(Math.round(v * 10)).padStart(2, '0');

/** IPC-7351's name for the land pattern. */
export function ipcName(s: IpcSpec): string {
  const d = s.density, H = h100(s.height);
  switch (s.family) {
    case 'CHIP': case 'MOLDED': return `${s.prefix}${h10(mid(s.bodyD))}${h10(mid(s.bodyE))}X${H}${d}`;
    case 'MELF': return `${s.prefix}${h10(mid(s.bodyD))}${h10(mid(s.bodyE))}${d}`;
    case 'SOD': return `SOD${h10(mid(s.span))}${h10(mid(s.bodyE))}X${H}${d}`;
    case 'SOT23': return `SOT${h100(s.pitch)}P${h100(mid(s.span))}X${H}-${s.pins}${d}`;
    case 'SOT223': return `SOT${h100(s.pitch)}P${h100(mid(s.span))}X${H}-${s.pins}${d}`;
    case 'DPAK': return `TO${h100(s.pitch)}P${h100(mid(s.span))}X${H}-${s.pins}${d}`;
    case 'SOIC': return `SOIC${h100(s.pitch)}P${h100(mid(s.span))}X${H}-${s.pins}${d}`;
    case 'SOP': return `SOP${h100(s.pitch)}P${h100(mid(s.span))}X${H}-${s.pins}${d}`;
    case 'SOJ': return `SOJ${h100(s.pitch)}P${h100(mid(s.span))}X${H}-${s.pins}${d}`;
    case 'QFP': return `QFP${h100(s.pitch)}P${h100(mid(s.span))}X${h100(mid(s.span2))}X${H}-${s.pins}${d}`;
    case 'PLCC': return `PLCC${h100(s.pitch)}P${h100(mid(s.span))}X${h100(mid(s.span2))}X${H}-${s.pins}${d}`;
    case 'SON': return `SON${h100(s.pitch)}P${h100(mid(s.bodyE))}X${h100(mid(s.bodyD))}X${H}-${s.pins + (s.tabW ? 1 : 0)}${d}`;
    case 'QFN': return `QFN${h100(s.pitch)}P${h100(mid(s.bodyD))}X${h100(mid(s.bodyE))}X${H}-${s.pins + (s.tabW ? 1 : 0)}${d}`;
    case 'BGA': return `BGA${s.pins}C${h100(s.pitch)}P${s.cols}X${s.rows}_${h100(mid(s.bodyD))}X${h100(mid(s.bodyE))}X${H}${d}`;
  }
}

/** Pads in a column at x, pins top to bottom (or bottom to top), centred on y = 0. */
function column(x: number, n: number, pitch: number, w: number, h: number, first: number, down2 = true): IpcPad[] {
  return Array.from({ length: n }, (_, i) => ({ name: String(first + i), x, y: (down2 ? 1 : -1) * ((n - 1) / 2 - i) * pitch, w, h, shape: 'rect' as const }));
}

/** The land pattern of a spec (mm, origin at the centre, pin 1 upper left). */
export function ipcFootprint(s: IpcSpec): IpcFootprint {
  const f = filletsFor(s);
  const pads: IpcPad[] = [];
  const name = ipcName(s);
  let landInfo: ReturnType<typeof land> | undefined;
  const bodyW = s.family === 'BGA' || ['QFP', 'QFN', 'PLCC'].includes(s.family) ? s.bodyD.max : ['CHIP', 'MOLDED', 'MELF'].includes(s.family) ? s.bodyD.max : s.bodyE.max;
  const bodyH = ['CHIP', 'MOLDED', 'MELF'].includes(s.family) ? s.bodyE.max : s.family === 'BGA' || ['QFP', 'QFN', 'PLCC'].includes(s.family) ? s.bodyE.max : s.bodyD.max;
  switch (s.family) {
    case 'CHIP': case 'MOLDED': case 'MELF': {
      // Two pads along X, pin 1 on the left
      const l = land(s.span, s.term, s.leadW, f);
      landInfo = l;
      pads.push({ name: '1', x: -l.C / 2, y: 0, w: l.padL, h: l.padW, shape: 'rect' }, { name: '2', x: l.C / 2, y: 0, w: l.padL, h: l.padW, shape: 'rect' });
      break;
    }
    case 'SOD': {
      const l = land(s.span, s.term, s.leadW, f);
      landInfo = l;
      pads.push({ name: '1', x: -l.C / 2, y: 0, w: l.padL, h: l.padW, shape: 'rect' }, { name: '2', x: l.C / 2, y: 0, w: l.padL, h: l.padW, shape: 'rect' });
      break;
    }
    case 'SOT23': case 'SOIC': case 'SOP': case 'SOJ': case 'SON': {
      // Two columns: left top to bottom 1…n, right bottom to top (SOT23-3: 1, 2 left; 3 right, centred)
      const l = land(s.span, s.term, s.leadW, f);
      landInfo = l;
      const left = s.family === 'SOT23' ? (s.pins === 3 ? 2 : 3) : Math.ceil(s.pins / 2), right = s.pins - left;
      pads.push(...column(-l.C / 2, left, s.family === 'SOT23' && s.pins === 3 ? s.pitch * 2 : s.pitch, l.padL, l.padW, 1));
      pads.push(...column(l.C / 2, right, s.family === 'SOT23' && s.pins !== 6 && right < left ? s.pitch * (right === 1 ? 1 : 2) : s.pitch, l.padL, l.padW, left + 1, false));
      if (s.family === 'SON' && s.tabW > 0) pads.push({ name: String(s.pins + 1), x: 0, y: 0, w: s.tabW, h: s.tabL || s.tabW, shape: 'rect' });
      break;
    }
    case 'SOT223': case 'DPAK': {
      // Leads on the left (DPAK: 1 and 3, the middle one cut), the tab on the right
      const l = land(s.span, s.term, s.leadW, f);
      landInfo = l;
      const n = s.family === 'SOT223' ? 3 : 2;
      const pitch = s.family === 'SOT223' ? s.pitch : s.pitch * 2;
      const leads = column(-l.C / 2, n, pitch, l.padL, l.padW, 1);
      if (s.family === 'DPAK') { leads[1]!.name = '3'; }
      pads.push(...leads);
      const tabLen = s.family === 'DPAK' ? Math.max(l.padL, s.tabL + f.toe + f.heel) * 1.6 : l.padL;
      const tabX = s.family === 'DPAK' ? l.Z / 2 - tabLen / 2 + Math.max(0, f.toe) : l.C / 2;
      pads.push({ name: s.family === 'SOT223' ? '4' : '2', x: +tabX.toFixed(3), y: 0, w: +tabLen.toFixed(3), h: up(s.tabW + 2 * f.side + rms(FAB_TOL, PLACE_TOL)), shape: 'rect' });
      break;
    }
    case 'QFP': case 'QFN': case 'PLCC': {
      const side = s.pinsSide || s.pins / 4, top = (s.pins - 2 * side) / 2;
      const lx = land(s.span, s.term, s.leadW, f), ly = land(s.span2.max ? s.span2 : s.span, s.term, s.leadW, f);
      landInfo = lx;
      const run = (n: number) => ((n - 1) / 2) * s.pitch;
      let k = 1;
      const add = (x: number, y: number, w: number, h: number) => pads.push({ name: String(k++), x: +x.toFixed(3), y: +y.toFixed(3), w, h, shape: 'rect' });
      // Left top→bottom, bottom left→right, right bottom→top, top right→left
      for (let i = 0; i < side; i++) add(-lx.C / 2, run(side) - i * s.pitch, lx.padL, lx.padW);
      for (let i = 0; i < top; i++) add(-run(top) + i * s.pitch, -ly.C / 2, ly.padW, ly.padL);
      for (let i = 0; i < side; i++) add(lx.C / 2, -run(side) + i * s.pitch, lx.padL, lx.padW);
      for (let i = 0; i < top; i++) add(run(top) - i * s.pitch, ly.C / 2, ly.padW, ly.padL);
      if (s.family === 'PLCC') {
        // Pin 1 in the middle of the top row, counter-clockwise from there
        const centre = 2 * side + top + Math.floor(top / 2);
        const order = [...pads.slice(centre), ...pads.slice(0, centre)];
        order.forEach((p, i) => { p.name = String(i + 1); });
        pads.splice(0, pads.length, ...order);
      }
      if (s.family === 'QFN' && s.tabW > 0) pads.push({ name: String(s.pins + 1), x: 0, y: 0, w: s.tabW, h: s.tabL || s.tabW, shape: 'rect' });
      break;
    }
    case 'BGA': {
      const k = s.density === 'M' ? 0.85 : s.density === 'N' ? 0.8 : 0.75;
      const d = up(s.ball * k);
      for (let rI = 0; rI < s.rows; rI++) for (let c = 0; c < s.cols; c++) {
        pads.push({ name: `${ballRow(rI)}${c + 1}`, x: +(-((s.cols - 1) / 2) * s.pitch + c * s.pitch).toFixed(3), y: +(((s.rows - 1) / 2) * s.pitch - rI * s.pitch).toFixed(3), w: d, h: d, shape: 'round' });
      }
      break;
    }
  }
  const { courtyard, silk, pin1 } = outlineFor(pads, { w: bodyW, h: bodyH }, f.cy, s.silk, s.family === 'BGA');
  const description = `${IPC_FAMILIES.find(([k]) => k === s.family)?.[1].split(' — ')[1] ?? s.family}, ${s.pins} pins${s.pitch ? `, ${s.pitch} mm pitch` : ''}, ${s.height} mm high; IPC-7351B ${s.density === 'M' ? 'Most' : s.density === 'N' ? 'Nominal' : 'Least'} density`;
  return { name, description, pads, body: { w: bodyW, h: bodyH }, courtyard, silk, pin1, height: s.height, land: landInfo };
}

/**
 * A footprint's courtyard (round the pads and the body, `excess` beyond, on a 0.05 mm grid),
 * silkscreen (the body's outline where it stays 0.2 mm clear of every pad) and pin-1 mark (beside
 * pin 1, on the side of the footprint it is nearest; a grid array's above A1).
 */
export function outlineFor(pads: IpcPad[], body: Box, excess: number, silkW: number, grid = false): { courtyard: Box; silk: [Vec2, Vec2][]; pin1: Vec2 } {
  const bx0 = (body.x ?? 0) - body.w / 2, bx1 = (body.x ?? 0) + body.w / 2, by0 = (body.y ?? 0) - body.h / 2, by1 = (body.y ?? 0) + body.h / 2;
  let x0 = bx0, x1 = bx1, y0 = by0, y1 = by1;
  for (const p of pads) { x0 = Math.min(x0, p.x - p.w / 2); x1 = Math.max(x1, p.x + p.w / 2); y0 = Math.min(y0, p.y - p.h / 2); y1 = Math.max(y1, p.y + p.h / 2); }
  // Centred on the origin when the pads and body are (as IPC's are): the same size each side
  const centred = Math.abs(x0 + x1) < 1e-6 && Math.abs(y0 + y1) < 1e-6;
  const courtyard: Box = centred
    ? { w: up(2 * (x1 + excess), 0.1), h: up(2 * (y1 + excess), 0.1) }
    : { w: up(x1 - x0 + 2 * excess, 0.1), h: up(y1 - y0 + 2 * excess, 0.1), x: +((x0 + x1) / 2).toFixed(3), y: +((y0 + y1) / 2).toFixed(3) };
  const silk: [Vec2, Vec2][] = [];
  const clear = 0.2 + silkW / 2;
  const hits = (a: Vec2, b: Vec2) => pads.some((p) => {
    const px0 = p.x - p.w / 2 - clear, px1 = p.x + p.w / 2 + clear, py0 = p.y - p.h / 2 - clear, py1 = p.y + p.h / 2 + clear;
    return Math.max(a.x, b.x) >= px0 && Math.min(a.x, b.x) <= px1 && Math.max(a.y, b.y) >= py0 && Math.min(a.y, b.y) <= py1;
  });
  const edges: [Vec2, Vec2][] = [[{ x: bx0, y: by1 }, { x: bx1, y: by1 }], [{ x: bx1, y: by1 }, { x: bx1, y: by0 }], [{ x: bx1, y: by0 }, { x: bx0, y: by0 }], [{ x: bx0, y: by0 }, { x: bx0, y: by1 }]];
  for (const [a, b] of edges) {
    // Split each edge in short steps and keep the runs clear of the pads
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05));
    let start: Vec2 | null = null;
    for (let i = 0; i <= n; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
      const q = i < n ? { x: a.x + ((b.x - a.x) * (i + 1)) / n, y: a.y + ((b.y - a.y) * (i + 1)) / n } : p;
      const ok = !hits(p, q);
      if (ok && !start) start = p;
      if ((!ok || i === n) && start) { const end = ok ? p : { x: a.x + ((b.x - a.x) * Math.max(0, i - 1)) / n, y: a.y + ((b.y - a.y) * Math.max(0, i - 1)) / n }; if (Math.hypot(end.x - start.x, end.y - start.y) > 0.1) silk.push([start, end]); start = null; }
    }
  }
  const p1 = pads.find((p) => p.name === '1' || p.name === 'A1') ?? pads.find((p) => p.name) ?? pads[0];
  let pin1: Vec2 = { x: 0, y: 0 };
  if (p1 && grid) pin1 = { x: +(p1.x - p1.w / 2 - clear - 0.3).toFixed(3), y: +(p1.y + p1.h / 2 + clear).toFixed(3) };
  else if (p1) {
    // Out from pin 1's toe: along its longer side, away from the footprint's middle
    const dx = p1.x - (x0 + x1) / 2, dy = p1.y - (y0 + y1) / 2;
    pin1 = p1.w >= p1.h
      ? { x: +(p1.x + Math.sign(dx || -1) * (p1.w / 2 + clear + 0.3)).toFixed(3), y: +p1.y.toFixed(3) }
      : { x: +p1.x.toFixed(3), y: +(p1.y + Math.sign(dy || 1) * (p1.h / 2 + clear + 0.3)).toFixed(3) };
  }
  return { courtyard, silk, pin1 };
}

/**
 * The footprint's records: pads on the top layer, silkscreen on the Top Overlay, the body on Mechanical 13 (and its 3D
 * bodies: the pieces the package is made of, see packageBody), the courtyard on Mechanical 15 [est: AD17's layers].
 * `s` with the wizard's whole specification gives the pieces their family's shapes; without, they go by the pads.
 */
export function ipcRecords(fp: IpcFootprint, s: Pick<IpcSpec, 'silk' | 'courtyardLine'> & Partial<IpcSpec>, padTemplate?: PcbRawRecord): PcbRawRecord[] {
  const P = (v: number) => mm(v);
  const out: PcbRawRecord[] = [];
  for (const p of fp.pads) {
    const th = (p.hole ?? 0) > 0;
    // A slot runs along the pad's longer side
    const slot = th && (p.slot ?? 0) > (p.hole ?? 0) ? { length: P(p.slot!), rotation: p.h > p.w ? 90 : 0 } : undefined;
    out.push(encodePad({
      name: p.name, layer: th ? L.MULTI : L.TOP, at: { x: P(p.x), y: P(p.y) }, w: P(p.w), h: P(p.h), shape: p.shape,
      ...(th ? { hole: P(p.hole!), plated: p.plated !== false } : {}), ...(slot ? { slot } : {}), ...(p.shape === 'roundrect' ? { cornerPct: 25 } : {}),
    }, th ? undefined : padTemplate));
  }
  for (const [a, b] of fp.silk) out.push(encodeTrack({ layer: L.TOP_OVERLAY, a: { x: P(a.x), y: P(a.y) }, b: { x: P(b.x), y: P(b.y) }, width: P(s.silk) }));
  out.push(encodeArc({ layer: L.TOP_OVERLAY, c: { x: P(fp.pin1.x), y: P(fp.pin1.y) }, r: P(0.1), start: 0, end: 360, width: P(0.2) }));
  const rect = (b: Box, layer: number, width: number) => {
    const x = b.x ?? 0, y = b.y ?? 0;
    const c = [{ x: x - b.w / 2, y: y + b.h / 2 }, { x: x + b.w / 2, y: y + b.h / 2 }, { x: x + b.w / 2, y: y - b.h / 2 }, { x: x - b.w / 2, y: y - b.h / 2 }].map((v) => ({ x: P(v.x), y: P(v.y) }));
    for (let i = 0; i < 4; i++) out.push(encodeTrack({ layer, a: c[i]!, b: c[(i + 1) % 4]!, width: P(width) }));
    return c;
  };
  const body = rect(fp.body, mechLayer(13), 0.1);
  rect(fp.courtyard, mechLayer(15), s.courtyardLine);
  const pieces = packagePieces(fp, s);
  if (!pieces.length) out.push(encodeBody({ component: 0xffff, outline: body, standoff: 0, overall: P(fp.height), colour: 0x404040, layer: mechLayer(13) }));
  for (const piece of pieces) out.push(encodeBody({ component: 0xffff, outline: piece.outline.map((v) => ({ x: P(v.x), y: P(v.y) })), standoff: P(piece.from), overall: P(piece.to), colour: piece.colour, layer: mechLayer(13) }));
  return out;
}
