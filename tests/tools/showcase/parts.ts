/**
 * The showcase project's parts: footprints (IPC-7351 ones from Konium's own wizard, the rest drawn
 * here), each with its 3D bodies (extruded and round, coloured as the real parts are). Local
 * millimetres, origin at the part's centre.
 */
import { ipcDefaults, ipcFootprint, type IpcSpec } from '../../../src/model/ipcFootprint';

export interface FpPad { name: string; x: number; y: number; w: number; h: number; shape: 'rect' | 'round'; hole?: number }
export interface FpBody { box?: [number, number, number, number]; circle?: [number, number, number]; z0: number; z1: number; colour: number }
export interface Fp {
  name: string; description: string; pads: FpPad[];
  /** Silkscreen lines [x0, y0, x1, y1] and dots [x, y, r]. */
  silk: [number, number, number, number][]; dots: [number, number, number][];
  bodies: FpBody[]; height: number;
  /** Courtyard (for placement checks): x0, y0, x1, y1. */
  court: [number, number, number, number];
}

export const rgb = (r: number, g: number, b: number) => r | (g << 8) | (b << 16);
export const COL = {
  black: rgb(30, 30, 33), epoxy: rgb(46, 46, 50), tin: rgb(205, 205, 210), gold: rgb(222, 178, 70), ceramic: rgb(180, 140, 92),
  resistor: rgb(24, 24, 26), silver: rgb(196, 198, 204), steel: rgb(150, 154, 160), green: rgb(40, 140, 72), blueGreen: rgb(30, 110, 90),
  white: rgb(236, 236, 230), ledGreen: rgb(70, 220, 110), ledRed: rgb(235, 60, 50), ledBlue: rgb(70, 130, 255), ledAmber: rgb(250, 170, 40),
  substrate: rgb(48, 92, 64), inductor: rgb(60, 60, 64), aluminium: rgb(200, 204, 210), sleeve: rgb(30, 40, 90), beige: rgb(214, 200, 160),
};

const r = (min: number, max: number) => ({ min, max });
const box = (w: number, h: number, cx = 0, cy = 0): [number, number, number, number] => [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];

/** An IPC footprint with its bodies: `leads` drawn at each pad (gull wings and terminations) or balls. */
function fromIpc(spec: IpcSpec, o: { colour: number; leads?: 'gull' | 'chip' | 'none' | 'ball'; name?: string; description?: string; top?: number; extra?: FpBody[] }): Fp {
  const f = ipcFootprint(spec);
  const pads: FpPad[] = f.pads.map((p) => ({ name: p.name, x: p.x, y: p.y, w: p.w, h: p.h, shape: p.shape }));
  const bw = f.body.w, bh = f.body.h, H = spec.height;
  const bodies: FpBody[] = [];
  if (o.leads === 'chip') {
    // Terminations at each end, the body between
    const tw = Math.min(bw * 0.22, 0.6);
    bodies.push({ box: [-bw / 2 + tw, -bh / 2, bw / 2 - tw, bh / 2], z0: 0, z1: H * 0.96, colour: o.colour });
    bodies.push({ box: [-bw / 2, -bh / 2, -bw / 2 + tw, bh / 2], z0: 0, z1: H, colour: COL.tin }, { box: [bw / 2 - tw, -bh / 2, bw / 2, bh / 2], z0: 0, z1: H, colour: COL.tin });
  } else if (o.leads === 'ball') {
    bodies.push({ box: box(bw, bh), z0: 0.25, z1: 0.6, colour: COL.substrate }, { box: box(bw * 0.86, bh * 0.86), z0: 0.6, z1: H, colour: o.colour });
  } else {
    const standoff = o.leads === 'gull' ? 0.1 : 0;
    bodies.push({ box: box(bw, bh), z0: standoff, z1: H, colour: o.colour });
    if (o.leads === 'gull') {
      for (const p of pads) {
        if (/^(EP|33|17)$/.test(p.name) && p.w > 1.2 && p.h > 1.2) continue;
        // The foot on the pad, a little inside its length
        const long = p.w > p.h;
        const lw = long ? p.w * 0.7 : p.w * 0.6, lh = long ? p.h * 0.6 : p.h * 0.7;
        bodies.push({ box: box(lw, lh, p.x, p.y), z0: 0, z1: 0.22, colour: COL.tin });
      }
    }
  }
  if (o.top !== undefined) bodies.push({ box: box(bw * 0.9, bh * 0.9), z0: H, z1: H + 0.05, colour: o.top });
  bodies.push(...(o.extra ?? []));
  const silk = f.silk.map(([a, b]) => [a.x, a.y, b.x, b.y] as [number, number, number, number]);
  return {
    name: o.name ?? f.name, description: o.description ?? f.description, pads, silk, dots: [[f.pin1.x, f.pin1.y, 0.15]], bodies, height: H,
    court: box(f.courtyard.w, f.courtyard.h),
  };
}

/** Chip sizes by metric code: body L × W, terminal length, height. */
const CHIP: Record<string, [number, number, number, number]> = { '1005': [1.0, 0.5, 0.25, 0.4], '1608': [1.6, 0.8, 0.35, 0.55], '2012': [2.0, 1.25, 0.45, 0.75], '3216': [3.2, 1.6, 0.5, 0.8] };
export function chip(code: keyof typeof CHIP, kind: 'R' | 'C' | 'L' | 'F' | 'LED' | 'X', colour?: number): Fp {
  const [l, w, t, h] = CHIP[code]!;
  const prefix = { R: 'RESC', C: 'CAPC', L: 'INDC', F: 'FUSC', LED: 'LEDC', X: 'XTALC' }[kind];
  const s: IpcSpec = { ...ipcDefaults('CHIP'), prefix, bodyD: r(l - 0.05, l + 0.05), bodyE: r(w - 0.05, w + 0.05), span: r(l - 0.05, l + 0.05), term: r(t * 0.6, t * 1.2), leadW: r(w - 0.05, w + 0.05), height: h };
  const body = colour ?? { R: COL.resistor, C: COL.ceramic, L: COL.inductor, F: COL.beige, LED: COL.white, X: COL.silver }[kind];
  return fromIpc(s, { colour: body, leads: 'chip', top: kind === 'LED' ? colour : undefined });
}

export const qfp100 = () => fromIpc({ ...ipcDefaults('QFP'), pins: 100, pinsSide: 25, bodyD: r(13.8, 14.2), bodyE: r(13.8, 14.2), span: r(15.8, 16.2), span2: r(15.8, 16.2), height: 1.6 },
  { colour: COL.black, leads: 'gull', extra: [{ circle: [-5.6, 5.6, 0.45], z0: 1.6, z1: 1.62, colour: COL.epoxy }] });
export const bga100 = () => fromIpc({ ...ipcDefaults('BGA'), height: 1.4 }, { colour: COL.black, leads: 'ball' });
export const qfn32 = () => fromIpc({ ...ipcDefaults('QFN') }, { colour: COL.black, leads: 'none' });
export const qfn16 = () => fromIpc({ ...ipcDefaults('QFN'), pins: 16, pinsSide: 4, bodyD: r(2.9, 3.1), bodyE: r(2.9, 3.1), span: r(2.9, 3.1), span2: r(2.9, 3.1), tabW: 1.7, tabL: 1.7 }, { colour: COL.black, leads: 'none' });
export const soic8 = () => fromIpc({ ...ipcDefaults('SOIC') }, { colour: COL.black, leads: 'gull' });
export const sot23 = (pins: 3 | 5 | 6) => fromIpc({ ...ipcDefaults('SOT23'), pins }, { colour: COL.black, leads: 'gull' });
export const sot223 = () => fromIpc({ ...ipcDefaults('SOT223') }, { colour: COL.black, leads: 'gull' });
export const sod123 = () => fromIpc({ ...ipcDefaults('SOD') }, { colour: COL.black, leads: 'gull', extra: [{ box: [-0.85, -0.7, -0.55, 0.7], z0: 1.35, z1: 1.37, colour: COL.silver }] });

/** A pad row helper. */
const pad = (name: string, x: number, y: number, w: number, h: number, shape: 'rect' | 'round' = 'rect', hole?: number): FpPad => ({ name, x, y, w, h, shape, hole });
function outline(x0: number, y0: number, x1: number, y1: number): [number, number, number, number][] {
  return [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
}

/** USB Type-C receptacle (mid-mount style): 12 pads at the back, four shell legs, the mouth towards +Y. */
export function usbC(): Fp {
  // GCT USB4105-style 16-pin receptacle: A and B contacts interleaved, GND and VBUS doubled
  const row: [string, number][] = [['GND1', -3.2], ['VBUS1', -2.4], ['SBU2', -1.75], ['CC1', -1.25], ['DN2', -0.75], ['DP1', -0.25], ['DN1', 0.25], ['DP2', 0.75], ['SBU1', 1.25], ['CC2', 1.75], ['VBUS2', 2.4], ['GND2', 3.2]];
  const pads: FpPad[] = row.map(([n, x]) => pad(n, x, -3.0, /^(GND|VBUS)/.test(n) ? 0.6 : 0.3, 1.1));
  for (const [x, y] of [[-4.32, -2.6], [4.32, -2.6], [-4.32, 1.6], [4.32, 1.6]] as const) pads.push(pad('SH', x, y, 1.1, 1.6, 'round', 0.65));
  return {
    name: 'USB-C-16P', description: 'USB Type-C receptacle, 16 contacts', pads, silk: [[-4.6, 3.9, 4.6, 3.9], [-4.6, -1.2, -4.6, 0.6], [4.6, -1.2, 4.6, 0.6]], dots: [],
    bodies: [{ box: [-4.47, -3.4, 4.47, 3.9], z0: 0, z1: 3.26, colour: COL.silver }, { box: [-3.4, 3.4, 3.4, 3.95], z0: 0.45, z1: 2.8, colour: COL.black }],
    height: 3.26, court: [-5.0, -4.0, 5.0, 4.2],
  };
}

/** Pin header (2.54 mm, through-hole) cols × rows, pin 1 square; or a 1.27 mm SMD one. */
export function header(cols: number, rows: number, smd = false): Fp {
  const p = smd ? 1.27 : 2.54, pads: FpPad[] = [], bodies: FpBody[] = [];
  const w = cols * p, h = rows * p;
  let n = 1;
  for (let c = 0; c < cols; c++) for (let k = 0; k < rows; k++) {
    const x = (c - (cols - 1) / 2) * p, y = ((rows - 1) / 2 - k) * p;
    if (smd) pads.push(pad(String(n), x, (k === 0 ? 1 : -1) * 1.95, 0.76, 2.4));
    else pads.push(pad(String(n), x, y, 1.7, 1.7, n === 1 ? 'rect' : 'round', 1.0));
    bodies.push({ box: box(smd ? 0.4 : 0.64, smd ? 0.4 : 0.64, x, smd ? 0 : y), z0: smd ? 0 : -3, z1: smd ? 5.5 : 8.5, colour: COL.gold });
    n++;
  }
  bodies.unshift({ box: box(w, smd ? 3.4 : h), z0: 0, z1: smd ? 1.5 : 2.5, colour: COL.black });
  return {
    name: smd ? `HDR127-${cols}X${rows}-SMD` : `HDR254-${cols}X${rows}`, description: `Pin header, ${rows} × ${cols}, ${p} mm${smd ? ', SMD' : ''}`, pads,
    silk: outline(-w / 2 - 0.2, -(smd ? 1.8 : h / 2) - 0.2, w / 2 + 0.2, (smd ? 1.8 : h / 2) + 0.2), dots: [[-w / 2 - 0.8, (smd ? 2.6 : h / 2), 0.25]], bodies, height: smd ? 5.5 : 8.5,
    court: box(w + 1, (smd ? 5.6 : h) + 1),
  };
}

/** Crystal 3.2 × 2.5 mm, four pads (1 and 3 the crystal, 2 and 4 its case), or an oscillator. */
export function xtal3225(osc = false): Fp {
  const pads = [pad('1', -1.1, -0.8, 1.4, 1.15), pad('2', 1.1, -0.8, 1.4, 1.15), pad('3', 1.1, 0.8, 1.4, 1.15), pad('4', -1.1, 0.8, 1.4, 1.15)];
  return {
    name: osc ? 'OSC3225' : 'XTAL3225', description: osc ? 'Oscillator, 3.2 × 2.5 mm' : 'Crystal, 3.2 × 2.5 mm', pads, silk: [[-2.0, -1.65, -2.0, 1.65], [-2.0, -1.65, -1.0, -1.65]], dots: [[-2.3, -1.6, 0.15]],
    bodies: [{ box: box(3.2, 2.5), z0: 0, z1: 0.25, colour: COL.beige }, { box: box(3.0, 2.3), z0: 0.25, z1: 0.8, colour: COL.silver }], height: 0.8, court: box(4.4, 3.6),
  };
}

/** Tactile switch 6 × 6 mm, SMD. */
export function tact(): Fp {
  return {
    name: 'SW-TACT-6X6', description: 'Tactile switch, 6 × 6 mm', pads: [pad('1', -4.0, 2.25, 1.6, 1.4), pad('2', 4.0, 2.25, 1.6, 1.4), pad('3', -4.0, -2.25, 1.6, 1.4), pad('4', 4.0, -2.25, 1.6, 1.4)],
    silk: [[-3.1, 3.1, 3.1, 3.1], [-3.1, -3.1, 3.1, -3.1], [-3.1, -1.2, -3.1, 1.2], [3.1, -1.2, 3.1, 1.2]], dots: [],
    bodies: [{ box: box(6, 6), z0: 0, z1: 3.1, colour: COL.steel }, { circle: [0, 0, 1.75], z0: 3.1, z1: 4.3, colour: COL.black }], height: 4.3, court: box(9.6, 6.8),
  };
}

/** SMA edge connector: the centre on a pad at the edge, ground pads either side; the body over the edge (+X). */
export function sma(): Fp {
  return {
    name: 'SMA-EDGE', description: 'SMA connector, edge mount', pads: [pad('1', -1.2, 0, 2.6, 1.5), pad('2', -0.6, 2.4, 3.8, 1.6), pad('3', -0.6, -2.4, 3.8, 1.6)], silk: [], dots: [],
    bodies: [{ box: [-0.5, -3.2, 1.0, 3.2], z0: -1.6, z1: 4.8, colour: COL.gold }, { box: [1.0, -2.9, 3.6, 2.9], z0: -1.0, z1: 4.8, colour: COL.gold }, { box: [3.6, -1.7, 9.5, 1.7], z0: 0.2, z1: 3.6, colour: COL.gold }],
    height: 4.8, court: [-3.0, -3.4, 1.2, 3.4],
  };
}

/** Screw terminal, 3 ways, 5.08 mm. */
export function terminal3(): Fp {
  const pads = ['1', '2', '3'].map((n, i) => pad(n, (i - 1) * 5.08, 0, 2.4, 2.4, i === 0 ? 'rect' : 'round', 1.3));
  const bodies: FpBody[] = [{ box: [-7.6, -4.0, 7.6, 4.0], z0: 0, z1: 9.8, colour: COL.green }];
  for (let i = 0; i < 3; i++) bodies.push({ circle: [(i - 1) * 5.08, 1.2, 1.6], z0: 9.8, z1: 10.0, colour: COL.silver });
  return { name: 'TERM-3P-5.08', description: 'Screw terminal, 3 ways, 5.08 mm', pads, silk: outline(-7.8, -4.2, 7.8, 4.2), dots: [], bodies, height: 10, court: box(16.4, 9.2) };
}

/** Power inductor 4 × 4 mm. */
export function inductor4040(): Fp {
  return {
    name: 'IND-4040', description: 'Power inductor, 4 × 4 mm', pads: [pad('1', -1.6, 0, 1.4, 3.6), pad('2', 1.6, 0, 1.4, 3.6)], silk: [[-2.3, 2.3, 2.3, 2.3], [-2.3, -2.3, 2.3, -2.3]], dots: [],
    bodies: [{ box: box(4, 4), z0: 0, z1: 2.8, colour: COL.inductor }, { circle: [0, 0, 1.4], z0: 2.8, z1: 2.85, colour: COL.steel }], height: 2.85, court: box(5.2, 5.2),
  };
}

/** Aluminium electrolytic, 6.3 mm can, SMD. */
export function elcap63(): Fp {
  return {
    name: 'CAPAE-6.3X5.4', description: 'Aluminium electrolytic, 6.3 mm, SMD', pads: [pad('1', -2.7, 0, 3.0, 1.6), pad('2', 2.7, 0, 3.0, 1.6)],
    silk: [[-3.4, 3.4, 2.4, 3.4], [-3.4, -3.4, 2.4, -3.4], [2.4, 3.4, 3.4, 2.4], [2.4, -3.4, 3.4, -2.4], [-3.4, 3.4, -3.4, 1.1], [-3.4, -3.4, -3.4, -1.1]], dots: [],
    bodies: [{ box: box(6.6, 6.6), z0: 0, z1: 0.6, colour: COL.black }, { circle: [0, 0, 3.15], z0: 0.6, z1: 5.4, colour: COL.aluminium }, { circle: [0, 0, 3.17], z0: 0.6, z1: 4.9, colour: COL.sleeve }, { box: [-3.17, -0.6, -2.4, 0.6], z0: 0.6, z1: 4.9, colour: COL.white }],
    height: 5.4, court: box(8.0, 7.4),
  };
}

export function mountHole(): Fp {
  return { name: 'MH-M3', description: 'Mounting hole, M3, plated', pads: [pad('1', 0, 0, 6.0, 6.0, 'round', 3.2)], silk: [], dots: [], bodies: [], height: 0, court: box(6.4, 6.4) };
}
export function testPoint(): Fp {
  return { name: 'TP-1.5', description: 'Test point, 1.5 mm', pads: [pad('1', 0, 0, 1.5, 1.5, 'round')], silk: [], dots: [], bodies: [], height: 0, court: box(2.0, 2.0) };
}
