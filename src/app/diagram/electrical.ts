/**
 * The Electrical library: circuit symbols drawn for Konium (original artwork), each an inline
 * stencil in its style (shape=stencil(…)), so a file keeps its own drawing wherever it is
 * opened. Their connection points are their leads' ends; their names go below them.
 */
import { stencilStyle } from '../../formats/stencil';
import type { Entry } from './library';

interface Sym { title: string; w: number; h: number; tags?: string; pts: [number, number][]; lines: string[]; filled?: string[]; text?: [string, number, number][]; shown?: [number, number] }

/** An SVG path (absolute M, L, Q, C, A, Z) as the stencil's path steps. */
export function pathXml(d: string): string {
  const out: string[] = [];
  const toks = d.match(/[MLQCAZ]|-?[\d.]+(?:e-?\d+)?/gi) ?? [];
  let i = 0, cmd = '';
  const num = () => Number(toks[i++]);
  while (i < toks.length) {
    if (/^[MLQCAZ]$/i.test(toks[i]!)) cmd = toks[i++]!.toUpperCase();
    if (cmd === 'Z') { out.push('<close/>'); cmd = ''; continue; }
    if (cmd === 'M') { out.push(`<move x="${num()}" y="${num()}"/>`); cmd = 'L'; }
    else if (cmd === 'L') out.push(`<line x="${num()}" y="${num()}"/>`);
    else if (cmd === 'Q') out.push(`<quad x1="${num()}" y1="${num()}" x2="${num()}" y2="${num()}"/>`);
    else if (cmd === 'C') out.push(`<curve x1="${num()}" y1="${num()}" x2="${num()}" y2="${num()}" x3="${num()}" y3="${num()}"/>`);
    else if (cmd === 'A') out.push(`<arc rx="${num()}" ry="${num()}" x-axis-rotation="${num()}" large-arc-flag="${num()}" sweep-flag="${num()}" x="${num()}" y="${num()}"/>`);
    else i++;
  }
  return `<path>${out.join('')}</path>`;
}
const circle = (cx: number, cy: number, r: number) => `M${cx - r},${cy} A${r},${r} 0 1 1 ${cx + r},${cy} A${r},${r} 0 1 1 ${cx - r},${cy} Z`;
const OR = 'M16,0 Q44,0 75,30 Q44,60 16,60 Q30,30 16,0 Z';
const SYMBOLS: Sym[] = [
  { title: 'Resistor', tags: 'iec', w: 100, h: 20, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,10 L20,10 M80,10 L100,10', 'M20,1 L80,1 L80,19 L20,19 Z'] },
  { title: 'Resistor (Zigzag)', tags: 'ansi us', w: 100, h: 20, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,10 L20,10 L25,1 L35,19 L45,1 L55,19 L65,1 L75,19 L80,10 L100,10'] },
  { title: 'Variable Resistor', tags: 'potentiometer trimmer', w: 100, h: 40, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,20 L20,20 M80,20 L100,20', 'M20,11 L80,11 L80,29 L20,29 Z', 'M28,38 L72,2 M64,3 L72,2 L71,10'] },
  { title: 'Capacitor', w: 60, h: 40, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,20 L26,20 M26,2 L26,38 M34,2 L34,38 M34,20 L60,20'] },
  { title: 'Polarised Capacitor', tags: 'electrolytic', w: 60, h: 40, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,20 L26,20 M26,2 L26,38 M38,2 Q31,20 38,38 M34,20 L60,20', 'M14,7 L20,7 M17,4 L17,10'] },
  { title: 'Inductor', tags: 'coil choke', w: 100, h: 20, pts: [[0, 0.75], [1, 0.75]], lines: ['M0,15 L20,15 A7.5,7.5 0 0 1 35,15 A7.5,7.5 0 0 1 50,15 A7.5,7.5 0 0 1 65,15 A7.5,7.5 0 0 1 80,15 L100,15'] },
  { title: 'Diode', w: 80, h: 30, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,15 L30,15 M52,15 L80,15 M52,1 L52,29'], filled: ['M30,1 L52,15 L30,29 Z'] },
  { title: 'Zener Diode', w: 80, h: 30, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,15 L30,15 M52,15 L80,15 M47,1 L52,4 L52,26 L57,29'], filled: ['M30,1 L52,15 L30,29 Z'] },
  { title: 'Schottky Diode', w: 80, h: 30, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,15 L30,15 M52,15 L80,15 M47,5 L47,1 L52,1 L52,29 L57,29 L57,25'], filled: ['M30,1 L52,15 L30,29 Z'] },
  { title: 'LED', tags: 'light emitting diode', w: 80, h: 40, pts: [[0, 0.7], [1, 0.7]], lines: ['M0,28 L30,28 M52,28 L80,28 M52,16 L52,40', 'M40,13 L50,3 M45,3 L50,3 L50,8', 'M49,15 L59,5 M54,5 L59,5 L59,10'], filled: ['M30,16 L52,28 L30,40 Z'] },
  { title: 'NPN Transistor', tags: 'bjt bipolar', w: 60, h: 80, pts: [[0, 0.5], [0.8667, 0], [0.8667, 1]], lines: ['M0,40 L24,40 M24,16 L24,64 M24,30 L52,10 L52,0 M24,50 L52,70 L52,80'], filled: ['M52,70 L41,69 L46,61 Z'] },
  { title: 'PNP Transistor', tags: 'bjt bipolar', w: 60, h: 80, pts: [[0, 0.5], [0.8667, 0], [0.8667, 1]], lines: ['M0,40 L24,40 M24,16 L24,64 M24,30 L52,10 L52,0 M24,50 L52,70 L52,80'], filled: ['M25,51 L36,52 L31,60 Z'] },
  { title: 'N-channel MOSFET', tags: 'nmos fet', w: 60, h: 80, pts: [[0, 0.75], [0.8667, 0], [0.8667, 1]], lines: ['M0,60 L18,60 M18,20 L18,60', 'M24,16 L24,28 M24,34 L24,46 M24,52 L24,64', 'M24,22 L52,22 L52,0 M24,58 L52,58 L52,80 M24,40 L52,40 L52,58'], filled: ['M25,40 L34,36 L34,44 Z'] },
  { title: 'P-channel MOSFET', tags: 'pmos fet', w: 60, h: 80, pts: [[0, 0.25], [0.8667, 0], [0.8667, 1]], lines: ['M0,20 L18,20 M18,20 L18,60', 'M24,16 L24,28 M24,34 L24,46 M24,52 L24,64', 'M24,22 L52,22 L52,0 M24,58 L52,58 L52,80 M24,40 L52,40 L52,22'], filled: ['M33,40 L24,36 L24,44 Z'] },
  { title: 'Op-amp', tags: 'operational amplifier comparator', w: 100, h: 80, pts: [[0, 0.25], [0, 0.75], [1, 0.5]], lines: ['M20,0 L90,40 L20,80 Z', 'M0,20 L20,20 M0,60 L20,60 M90,40 L100,40', 'M26,20 L34,20 M26,60 L34,60 M30,56 L30,64'] },
  { title: 'Ground', tags: 'gnd earth', w: 40, h: 30, pts: [[0.5, 0]], lines: ['M20,0 L20,12 M4,12 L36,12 M10,19 L30,19 M16,26 L24,26'] },
  { title: 'Power', tags: 'vcc supply rail', w: 40, h: 30, pts: [[0.5, 1]], lines: ['M20,30 L20,10 M6,10 L34,10'] },
  { title: 'Battery', tags: 'cell', w: 60, h: 40, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,20 L24,20 M24,4 L24,36 M32,12 L32,28 M32,20 L60,20', 'M12,6 L18,6 M15,3 L15,9'] },
  { title: 'DC Source', tags: 'voltage supply', w: 60, h: 60, pts: [[0.5, 0], [0.5, 1]], lines: [circle(30, 30, 20), 'M30,0 L30,10 M30,50 L30,60 M26,21 L34,21 M30,17 L30,25 M26,39 L34,39'] },
  { title: 'AC Source', tags: 'voltage sine', w: 60, h: 60, pts: [[0.5, 0], [0.5, 1]], lines: [circle(30, 30, 20), 'M30,0 L30,10 M30,50 L30,60 M18,30 Q24,18 30,30 Q36,42 42,30'] },
  { title: 'Switch', tags: 'spst', w: 80, h: 30, pts: [[0, 0.8333], [1, 0.8333]], lines: ['M0,25 L18,25 M62,25 L80,25 M21,24 L56,8', circle(20, 25, 2), circle(60, 25, 2)] },
  { title: 'Push Button', tags: 'switch tactile', w: 80, h: 40, pts: [[0, 0.875], [1, 0.875]], lines: ['M0,35 L18,35 M62,35 L80,35 M20,25 L60,25 M40,25 L40,6 M32,6 L48,6', circle(20, 35, 2), circle(60, 35, 2)] },
  { title: 'Fuse', w: 100, h: 20, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,10 L100,10', 'M25,3 L75,3 L75,17 L25,17 Z'] },
  { title: 'Crystal', tags: 'xtal oscillator quartz', w: 80, h: 40, pts: [[0, 0.5], [1, 0.5]], lines: ['M0,20 L26,20 M26,8 L26,32 M54,8 L54,32 M54,20 L80,20', 'M32,4 L48,4 L48,36 L32,36 Z'] },
  { title: 'Transformer', w: 80, h: 80, pts: [[0.125, 0], [0.125, 1], [0.875, 0], [0.875, 1]], lines: ['M10,0 L10,10 A7.5,7.5 0 0 1 10,25 A7.5,7.5 0 0 1 10,40 A7.5,7.5 0 0 1 10,55 A7.5,7.5 0 0 1 10,70 L10,80', 'M70,0 L70,10 A7.5,7.5 0 0 0 70,25 A7.5,7.5 0 0 0 70,40 A7.5,7.5 0 0 0 70,55 A7.5,7.5 0 0 0 70,70 L70,80', 'M36,8 L36,72 M44,8 L44,72'] },
  { title: 'AND Gate', tags: 'logic', w: 80, h: 60, pts: [[0, 0.25], [0, 0.75], [1, 0.5]], lines: ['M20,0 L45,0 A30,30 0 0 1 45,60 L20,60 Z', 'M0,15 L20,15 M0,45 L20,45 M75,30 L80,30'] },
  { title: 'NAND Gate', tags: 'logic', w: 80, h: 60, pts: [[0, 0.25], [0, 0.75], [1, 0.5]], lines: ['M15,0 L40,0 A30,30 0 0 1 40,60 L15,60 Z', circle(74, 30, 4), 'M0,15 L15,15 M0,45 L15,45'] },
  { title: 'OR Gate', tags: 'logic', w: 80, h: 60, pts: [[0, 0.25], [0, 0.75], [1, 0.5]], lines: [OR, 'M0,15 L23,15 M0,45 L23,45 M75,30 L80,30'] },
  { title: 'NOR Gate', tags: 'logic', w: 80, h: 60, pts: [[0, 0.25], [0, 0.75], [1, 0.5]], lines: ['M12,0 Q38,0 68,30 Q38,60 12,60 Q26,30 12,0 Z', circle(73, 30, 4), 'M0,15 L19,15 M0,45 L19,45'] },
  { title: 'XOR Gate', tags: 'logic exclusive', w: 80, h: 60, pts: [[0, 0.25], [0, 0.75], [1, 0.5]], lines: [OR, 'M8,0 Q22,30 8,60', 'M0,15 L15,15 M0,45 L15,45 M75,30 L80,30'] },
  { title: 'NOT Gate', tags: 'logic inverter buffer', w: 80, h: 40, pts: [[0, 0.5], [1, 0.5]], lines: ['M15,0 L62,20 L15,40 Z', circle(66, 20, 4), 'M0,20 L15,20 M70,20 L80,20'] },
  { title: 'Lamp', tags: 'bulb light', w: 60, h: 40, pts: [[0, 0.5], [1, 0.5]], lines: [circle(30, 20, 18), 'M17.3,7.3 L42.7,32.7 M42.7,7.3 L17.3,32.7 M0,20 L12,20 M48,20 L60,20'] },
  { title: 'Motor', w: 60, h: 40, pts: [[0, 0.5], [1, 0.5]], lines: [circle(30, 20, 18), 'M0,20 L12,20 M48,20 L60,20', 'M22,28 L22,12 L30,22 L38,12 L38,28'] },
  { title: 'Speaker', tags: 'loudspeaker buzzer', w: 50, h: 60, pts: [[0, 0.4], [0, 0.6]], lines: ['M0,24 L8,24 M0,36 L8,36', 'M8,18 L20,18 L20,42 L8,42 Z', 'M20,18 L44,4 L44,56 L20,42'] },
  { title: 'Antenna', tags: 'aerial', w: 40, h: 60, pts: [[0.5, 1]], lines: ['M20,60 L20,0 M4,0 L20,20 L36,0'] },
  { title: 'Terminal', tags: 'connector pin pad', w: 40, h: 20, pts: [[0, 0.5]], lines: ['M0,10 L28,10', circle(34, 10, 6)] },
  { title: 'IC (8 pins)', tags: 'chip integrated circuit dip', w: 100, h: 120, pts: [[0, 0.125], [0, 0.375], [0, 0.625], [0, 0.875], [1, 0.125], [1, 0.375], [1, 0.625], [1, 0.875]], lines: ['M20,0 L42,0 A8,8 0 0 0 58,0 L80,0 L80,120 L20,120 Z', 'M0,15 L20,15 M0,45 L20,45 M0,75 L20,75 M0,105 L20,105 M80,15 L100,15 M80,45 L100,45 M80,75 L100,75 M80,105 L100,105'] },
];

/** A symbol's stencil XML: its connection points, its filled parts (in the shape's fill) and its lines. */
export function symbolXml(s: Sym): string {
  const pts = s.pts.map(([x, y]) => `<constraint x="${x}" y="${y}" perimeter="0"/>`).join('');
  const filled = (s.filled ?? []).map((d) => `${pathXml(d)}<fillstroke/>`).join('');
  const lines = s.lines.map((d) => `${pathXml(d)}<stroke/>`).join('');
  return `<shape name="${s.title}" w="${s.w}" h="${s.h}" aspect="fixed" strokewidth="inherit"><connections>${pts}</connections><background/><foreground>${lines}${filled}</foreground></shape>`;
}

export const ELECTRICAL: Entry[] = SYMBOLS.map((s) => ({
  title: s.title, tags: `electrical electronic circuit schematic ${s.tags ?? ''}`.trim(), w: s.w, h: s.h, value: '',
  style: `shape=${stencilStyle(symbolXml(s))};whiteSpace=wrap;html=1;verticalLabelPosition=bottom;verticalAlign=top;fillColor=#ffffff;`,
}));
