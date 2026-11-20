/**
 * Tools › Component Wizard (PCB library): footprints from a handful of numbers, as Altium
 * Designer 17's wizard makes them — Dual In-line (DIP), Small Outline (SOP), Quad Packs
 * (QUAD), Leadless Chip Carriers (LCC), Ball and Pin Grid Arrays (BGA, PGA), Resistors,
 * Capacitors and Diodes (through-hole or surface mount). Pads on the copper (multi-layer
 * with a hole, or the top layer), the outline on the Top Overlay. DIP, SOP and through-hole
 * two-pin parts have pin 1 at the origin; the others are centred [est: AD's reference points].
 */
import type { Vec2 } from '../core/geom';
import { mil } from '../core/units';
import { encodeArc, encodePad, encodeTrack } from '../formats/altium/pcbdoc';
import type { PcbRawRecord } from '../formats/altium/framing';
import { L } from './layers';

export type WizardPattern = 'dip' | 'sop' | 'quad' | 'lcc' | 'bga' | 'pga' | 'res' | 'cap' | 'diode';
export const WIZARD_PATTERNS: [WizardPattern, string][] = [
  ['bga', 'Ball Grid Arrays (BGA)'], ['cap', 'Capacitors'], ['diode', 'Diodes'], ['dip', 'Dual In-line Packages (DIP)'], ['lcc', 'Leadless Chip Carriers (LCC)'],
  ['pga', 'Pin Grid Arrays (PGA)'], ['quad', 'Quad Packs (QUAD)'], ['res', 'Resistors'], ['sop', 'Small Outline Packages (SOP)'],
];

export interface WizardSpec {
  pattern: WizardPattern;
  /** Pins (DIP, SOP, QUAD, LCC: in all), or rows × columns for grid arrays. */
  pins: number; rows: number; cols: number;
  /** Pad size across (X) and along (Y) the row, and the hole (0: surface mount). */
  padX: number; padY: number; hole: number;
  /** Pin pitch along a row; span: centre to centre across the package (two-pin parts: between the pads). */
  pitch: number; span: number;
  outline: number;
  /** Two-pin parts: surface mount (else through-hole). */
  smd: boolean;
}

export function wizardDefaults(p: WizardPattern): WizardSpec {
  const base: WizardSpec = { pattern: p, pins: 14, rows: 8, cols: 8, padX: mil(60), padY: mil(60), hole: mil(32), pitch: mil(100), span: mil(300), outline: mil(10), smd: false };
  switch (p) {
    case 'dip': return base;
    case 'sop': return { ...base, pins: 8, padX: mil(80), padY: mil(24), hole: 0, pitch: mil(50), span: mil(260) };
    case 'quad': return { ...base, pins: 44, padX: mil(60), padY: mil(14), hole: 0, pitch: mil(31.5), span: mil(640) };
    case 'lcc': return { ...base, pins: 20, padX: mil(70), padY: mil(30), hole: 0, pitch: mil(50), span: mil(330) };
    case 'bga': return { ...base, rows: 8, cols: 8, padX: mil(16), padY: mil(16), hole: 0, pitch: mil(31.5), span: 0 };
    case 'pga': return { ...base, rows: 10, cols: 10, padX: mil(62), padY: mil(62), hole: mil(40), pitch: mil(100), span: 0 };
    case 'res': return { ...base, pins: 2, padX: mil(62), padY: mil(62), hole: mil(33), span: mil(400) };
    case 'cap': return { ...base, pins: 2, padX: mil(62), padY: mil(62), hole: mil(33), span: mil(200) };
    case 'diode': return { ...base, pins: 2, padX: mil(62), padY: mil(62), hole: mil(33), span: mil(400) };
  }
}

/** The name the wizard suggests: DIP14, SOP8, QUAD44, BGA8x8, RES400 (span in mil) … */
export function wizardName(s: WizardSpec): string {
  const m = (v: number) => Math.round(v / 10_000);
  switch (s.pattern) {
    case 'bga': case 'pga': return `${s.pattern.toUpperCase()}${s.rows}x${s.cols}`;
    case 'res': case 'cap': case 'diode': return `${s.pattern === 'res' ? 'RES' : s.pattern === 'cap' ? 'CAP' : 'DIODE'}${s.smd ? 'SMD' : ''}${m(s.span)}`;
    default: return `${s.pattern.toUpperCase()}${s.pins}`;
  }
}

/** JEDEC ball rows: A … Z without I, O, Q, S, X, Z, then AA, AB … */
export function ballRow(i: number): string {
  const letters = 'ABCDEFGHJKLMNPRTUVWY';
  return i < letters.length ? letters[i]! : letters[Math.floor(i / letters.length) - 1]! + letters[i % letters.length]!;
}

/** The footprint's records (pads first, then the overlay), coordinates relative to its origin. */
export function wizardRecords(s: WizardSpec, padTemplate?: PcbRawRecord): PcbRawRecord[] {
  const pads: PcbRawRecord[] = [], art: PcbRawRecord[] = [];
  const th = s.hole > 0;
  const pad = (name: string, at: Vec2, w: number, h: number, shape: 'round' | 'rect' = 'round', rotate = false) =>
    pads.push(encodePad({ name, layer: th ? L.MULTI : L.TOP, at, w: rotate ? h : w, h: rotate ? w : h, shape, hole: th ? s.hole : 0 }, padTemplate));
  const line = (a: Vec2, b: Vec2) => art.push(encodeTrack({ layer: L.TOP_OVERLAY, a, b, width: s.outline }));
  const box = (x0: number, y0: number, x1: number, y1: number) => { line({ x: x0, y: y0 }, { x: x1, y: y0 }); line({ x: x1, y: y0 }, { x: x1, y: y1 }); line({ x: x1, y: y1 }, { x: x0, y: y1 }); line({ x: x0, y: y1 }, { x: x0, y: y0 }); };
  const arc = (c: Vec2, r: number, start: number, end: number) => art.push(encodeArc({ layer: L.TOP_OVERLAY, c, r, start, end, width: s.outline }));
  const gap = s.outline / 2 + mil(10);

  switch (s.pattern) {
    case 'dip': case 'sop': {
      // Pin 1 at the origin, down the left; the rest back up the right
      const per = Math.max(1, Math.floor(s.pins / 2));
      for (let i = 0; i < per; i++) pad(String(i + 1), { x: 0, y: -i * s.pitch }, s.padX, s.padY, i === 0 && s.pattern === 'dip' ? 'rect' : s.pattern === 'sop' ? 'rect' : 'round');
      for (let i = 0; i < per; i++) pad(String(per + i + 1), { x: s.span, y: -(per - 1 - i) * s.pitch }, s.padX, s.padY, s.pattern === 'sop' ? 'rect' : 'round');
      const x0 = s.padX / 2 + gap, x1 = s.span - s.padX / 2 - gap, y0 = s.pitch / 2, y1 = -(per - 1) * s.pitch - y0;
      if (x1 > x0) {
        box(x0, y0, x1, y1);
        // DIP: the notch at the pin-1 end; SOP: a dot by pin 1
        if (s.pattern === 'dip') { const r = Math.min(mil(25), (x1 - x0) / 4); arc({ x: (x0 + x1) / 2, y: y0 }, r, 180, 360); }
        else arc({ x: x0 + mil(30), y: y0 - mil(30) }, mil(5), 0, 360);
      }
      break;
    }
    case 'quad': case 'lcc': {
      // Centred; pin 1 at the top of the left side, counter-clockwise
      const per = Math.max(1, Math.floor(s.pins / 4)), half = s.span / 2, run = (per - 1) * s.pitch / 2;
      let n = 1;
      for (let i = 0; i < per; i++) pad(String(n++), { x: -half, y: run - i * s.pitch }, s.padX, s.padY, 'rect');
      for (let i = 0; i < per; i++) pad(String(n++), { x: -run + i * s.pitch, y: -half }, s.padX, s.padY, 'rect', true);
      for (let i = 0; i < per; i++) pad(String(n++), { x: half, y: -run + i * s.pitch }, s.padX, s.padY, 'rect');
      for (let i = 0; i < per; i++) pad(String(n++), { x: run - i * s.pitch, y: half }, s.padX, s.padY, 'rect', true);
      const b = half - s.padX / 2 - gap;
      if (b > 0) {
        // The pin-1 corner cut at 45°
        const c = Math.min(mil(40), b / 3);
        line({ x: -b + c, y: b }, { x: b, y: b }); line({ x: b, y: b }, { x: b, y: -b }); line({ x: b, y: -b }, { x: -b, y: -b }); line({ x: -b, y: -b }, { x: -b, y: b - c }); line({ x: -b, y: b - c }, { x: -b + c, y: b });
      }
      break;
    }
    case 'bga': case 'pga': {
      // Centred; A1 top left, rows down, columns across
      const w = (s.cols - 1) * s.pitch, h = (s.rows - 1) * s.pitch;
      for (let r = 0; r < s.rows; r++) for (let c = 0; c < s.cols; c++) {
        pad(`${ballRow(r)}${c + 1}`, { x: -w / 2 + c * s.pitch, y: h / 2 - r * s.pitch }, s.padX, s.padY, s.pattern === 'pga' && !r && !c ? 'rect' : 'round');
      }
      const b = { x: w / 2 + s.pitch / 2 + gap, y: h / 2 + s.pitch / 2 + gap }, cut = Math.min(s.pitch, b.x / 3);
      line({ x: -b.x + cut, y: b.y }, { x: b.x, y: b.y }); line({ x: b.x, y: b.y }, { x: b.x, y: -b.y }); line({ x: b.x, y: -b.y }, { x: -b.x, y: -b.y }); line({ x: -b.x, y: -b.y }, { x: -b.x, y: b.y - cut }); line({ x: -b.x, y: b.y - cut }, { x: -b.x + cut, y: b.y });
      break;
    }
    case 'res': case 'cap': case 'diode': {
      if (s.smd) {
        // Centred chip: two pads, the body between them
        const half = s.span / 2;
        pad('1', { x: -half, y: 0 }, s.padX, s.padY, 'rect'); pad('2', { x: half, y: 0 }, s.padX, s.padY, 'rect');
        const x = half + s.padX / 2 + gap, y = s.padY / 2 + gap;
        line({ x: -x, y }, { x, y }); line({ x: -x, y: -y }, { x, y: -y });
        if (s.pattern === 'diode') line({ x: -x, y }, { x: -x, y: -y });
        break;
      }
      // Through-hole: pin 1 at the origin, pin 2 along +X
      pad('1', { x: 0, y: 0 }, s.padX, s.padY, s.pattern === 'res' ? 'round' : 'rect'); pad('2', { x: s.span, y: 0 }, s.padX, s.padY);
      if (s.pattern === 'cap') { arc({ x: s.span / 2, y: 0 }, s.span / 2 + s.padX / 2 + gap, 0, 360); break; }
      const x0 = s.padX / 2 + gap, x1 = s.span - s.padX / 2 - gap, y = Math.max(s.padY / 2, mil(30));
      if (x1 > x0) {
        box(x0 + mil(20), y, x1 - mil(20), -y);
        line({ x: x0, y: 0 }, { x: x0 + mil(20), y: 0 }); line({ x: x1 - mil(20), y: 0 }, { x: x1, y: 0 });
        if (s.pattern === 'diode') line({ x: x0 + mil(40), y }, { x: x0 + mil(40), y: -y });   // cathode band by pin 1
      }
      break;
    }
  }
  return [...pads, ...art];
}
