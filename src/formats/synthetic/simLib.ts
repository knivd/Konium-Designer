/**
 * Konium's simulation libraries, written by its own SchLib writer:
 * - Simulation Sources.SchLib: the sources AD's Simulation Sources library has (VSRC, ISRC,
 *   VSIN, ISIN, VPULSE, IPULSE, VPWL, IPWL, VEXP, IEXP, VSFFM, ISFFM, and the .IC and .NS
 *   directives), each with its SIM model;
 *   what the Simulation Sources toolbar places.
 * - Simulation Parts.SchLib: resistor, capacitor, inductor, diodes, transistors and an op-amp
 *   whose SIM models name Konium's built-in model files.
 * Symbols are Konium's own drawings; model kinds, prefixes and templates follow AD's [est].
 */
import { PropertyBag } from '../altium/props';
import { writeSchLib } from '../altium/schlib';
import { SR, setSchCoord } from '../../model/sch';
import { SCH_UNIT } from '../../core/units';
import { uniqueId } from '../../model/schEdit';
import { SymbolBuilder } from './demoLib';
import { kitPartSymbols, kitSourceSymbols } from './simKit';
import { RATINGS, RATING_PARAMS } from '../../sim/liveStress';

type XY = [number, number];
const C = { body: 128, fill: 11599871, text: 8388608 };

export interface SimModelSpec {
  name: string;
  description: string;
  kind: string;
  subKind: string;
  prefix: string;
  netlist?: string;
  /** The model file (entity and kind), when the model has one. */
  file?: { entity: string; kind: 'MDL' | 'CKT' };
  params: [string, string][];
  /** [model pin, part pin] where they differ. */
  portMap?: [string, string][];
}

export class SimSymbolBuilder extends SymbolBuilder {
  private list = -1;
  circle(c: XY, r: number, part = 1): this {
    const i = this.add({ RECORD: SR.ELLIPSE, OWNERPARTID: part, LINEWIDTH: 1, COLOR: C.body, AREACOLOR: C.fill, ISSOLID: true }, { LOCATION: c });
    setSchCoord(this.bags[i]!, 'RADIUS', r * SCH_UNIT);
    setSchCoord(this.bags[i]!, 'SECONDARYRADIUS', r * SCH_UNIT);
    return this;
  }
  polyline(pts: XY[], part = 1): this {
    const b = PropertyBag.from({ RECORD: SR.POLYLINE, OWNERPARTID: part, LINEWIDTH: 1, COLOR: C.body, LOCATIONCOUNT: pts.length, ...this.modeProp() });
    pts.forEach(([x, y], k) => { setSchCoord(b, `X${k + 1}`, x * SCH_UNIT); setSchCoord(b, `Y${k + 1}`, y * SCH_UNIT); });
    this.bags.push(b);
    return this;
  }
  /** A component parameter (hidden unless asked). */
  param(name: string, text: string, at: XY, shown = false): this {
    this.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: name, TEXT: text, FONTID: 1, COLOR: C.text, ...(shown ? {} : { ISHIDDEN: true }) }, { LOCATION: at });
    return this;
  }
  hiddenComment(text: string, at: XY): this { return this.param('Comment', text, at, false); }
  /** The SIM model: implementation, its port map and its parameters (Kind, SubKind, Spice Prefix, Netlist, model values). */
  sim(m: SimModelSpec): this {
    if (this.list < 0) this.list = this.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERPARTID: -1 });
    const impl = this.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: this.list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: m.description, MODELNAME: m.name, MODELTYPE: 'SIM',
      ...(m.file ? { DATAFILECOUNT: 1, MODELDATAFILEENTITY0: m.file.entity, MODELDATAFILEKIND0: m.file.kind } : {}), ISCURRENT: true, UNIQUEID: uniqueId() });
    const maps = this.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl, OWNERPARTID: -1 });
    for (const [modelPin, partPin] of m.portMap ?? []) this.add({ RECORD: SR.MAP_DEFINER, OWNERINDEX: maps, OWNERPARTID: -1, DESINTF: partPin, DESIMPCOUNT: 1, DESIMP0: modelPin });
    const params = this.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl, OWNERPARTID: -1 });
    const all: [string, string][] = [['Kind', m.kind], ['SubKind', m.subKind], ['Spice Prefix', m.prefix], ...(m.netlist ? [['Netlist', m.netlist] as [string, string]] : []), ...m.params];
    for (const [name, text] of all) this.add({ RECORD: SR.PARAMETER, OWNERINDEX: params, OWNERPARTID: -1, NAME: name, TEXT: text, ISHIDDEN: true, READONLYSTATE: 0 });
    return this;
  }
}

/* ─── Simulation Sources ─────────────────────────────────────────────────────────────── */

const AC: [string, string][] = [['AC Magnitude', ''], ['AC Phase', '']];
const AC1: [string, string][] = [['AC Magnitude', '1'], ['AC Phase', '0']];

function source(libRef: string, description: string, current: boolean, subKind: string, params: [string, string][], glyph: (s: SimSymbolBuilder) => void, value?: string): SimSymbolBuilder {
  const s = new SimSymbolBuilder(libRef, description);
  s.circle([0, 0], 10);
  glyph(s);
  // Pin 1 (+) at the top, 2 (−) at the bottom; current flows out of 1 through the circuit back into 2 [est]
  s.pin('1', '+', [0, 10], 1, 10, { showName: false, showDesignator: false }).pin('2', '-', [0, -10], 3, 10, { showName: false, showDesignator: false });
  s.designator(current ? 'I?' : 'V?', [14, 4]);
  if (value !== undefined) { s.param('Comment', '=Value', [14, -6], true); s.param('Value', value, [14, -6]); }
  else s.hiddenComment(libRef, [14, -6]);
  s.sim({ name: libRef, description, kind: current ? 'Current Source' : 'Voltage Source', subKind, prefix: current ? 'I' : 'V', params: value !== undefined ? [['Value', '*'], ...params] : params });
  return s;
}

/** .IC and .NS: a flag on the net they set (its one pin), the voltage beside it. */
function directive(libRef: string, description: string, subKind: string, des: string): SimSymbolBuilder {
  const s = new SimSymbolBuilder(libRef, description);
  s.polyline([[0, 0], [0, 6], [14, 6], [17, 3], [14, 0], [0, 0]]).polyline([[3, 1.5], [3, 4.5]]);
  s.pin('1', '1', [0, 0], 3, 10, { showName: false, showDesignator: false });
  s.designator(des, [20, 6]).param('Comment', '=Initial Voltage', [20, -4], true).param('Initial Voltage', '0', [20, -4]);
  s.sim({ name: libRef, description, kind: 'Initial Condition', subKind, prefix: '', params: [['Initial Voltage', '*']] });
  return s;
}

const plus = (s: SimSymbolBuilder) => s.line([-2, 6], [2, 6]).line([0, 4], [0, 8]).line([-2, -6], [2, -6]);
const arrow = (s: SimSymbolBuilder) => s.line([0, -6], [0, 6]).polygon([[-3, 2], [3, 2], [0, 7]]);
const sine = (s: SimSymbolBuilder, y = 0) => s.polyline([[-7, y], [-6, y + 2.5], [-5, y + 4], [-4, y + 4.5], [-3, y + 4], [-2, y + 2.5], [-1, y], [0, y - 2.5], [1, y - 4], [2, y - 4.5], [3, y - 4], [4, y - 2.5], [5, y]]);
const pulse = (s: SimSymbolBuilder) => s.polyline([[-7, -3], [-4, -3], [-4, 4], [1, 4], [1, -3], [6, -3]]);
const pwl = (s: SimSymbolBuilder) => s.polyline([[-7, -4], [-3, 3], [0, 0], [3, 5], [6, -4]]);
const expo = (s: SimSymbolBuilder) => s.polyline([[-7, -4], [-6, 0], [-5, 2], [-3, 3.5], [0, 4], [1, 4], [2, 1], [3, -1.5], [5, -3.2], [7, -4]]);
const fm = (s: SimSymbolBuilder) => s.polyline([[-7, 0], [-6, 4], [-5, 0], [-4, -4], [-3, 0], [-1, 4], [1, 0], [3, -4], [5, 0], [6, 4], [7, 0]]);

const SIN_P = (amp: string): [string, string][] => [['DC Magnitude', '0'], ...AC1, ['Offset', '0'], ['Amplitude', amp], ['Frequency', '1K'], ['Delay', '0'], ['Damping Factor', '0'], ['Phase', '0']];
const PULSE_P = (v: string): [string, string][] => [['DC Magnitude', '0'], ...AC1, ['Initial Value', '0'], ['Pulsed Value', v], ['Time Delay', '0'], ['Rise Time', '1u'], ['Fall Time', '1u'], ['Pulse Width', '0.5m'], ['Period', '1m'], ['Phase Delay', '0']];
const PWL_P = (v: string): [string, string][] => [['DC Magnitude', '0'], ...AC1, ['Time / Value Pairs', `0 0 1m ${v} 2m ${v} 3m 0`]];
const EXP_P = (v: string): [string, string][] => [['DC Magnitude', '0'], ...AC1, ['Initial Value', '0'], ['Pulsed Value', v], ['Rise Delay Time', '0'], ['Rise Time Constant', '100u'], ['Fall Delay Time', '1m'], ['Fall Time Constant', '100u']];
const SFFM_P = (v: string): [string, string][] => [['DC Magnitude', '0'], ...AC1, ['Offset', '0'], ['Amplitude', v], ['Carrier Frequency', '100K'], ['Modulation Index', '5'], ['Signal Frequency', '10K']];

export function simSourceSymbols(): SimSymbolBuilder[] {
  return [
    source('VSRC', 'Voltage Source', false, 'DC Source', AC, plus, '5'),
    source('ISRC', 'Current Source', true, 'DC Source', AC, arrow, '1m'),
    source('VSIN', 'Sinusoidal Voltage Source', false, 'Sinusoidal', SIN_P('1'), (s) => sine(s)),
    source('ISIN', 'Sinusoidal Current Source', true, 'Sinusoidal', SIN_P('1m'), (s) => { sine(s, 3); s.line([0, -8], [0, -3]).polygon([[-2, -4.5], [2, -4.5], [0, -2]]); }),
    source('VPULSE', 'Pulse Voltage Source', false, 'Pulse', PULSE_P('1'), pulse),
    source('IPULSE', 'Pulse Current Source', true, 'Pulse', PULSE_P('1m'), (s) => { pulse(s); s.line([7, -6], [7, 0]); }),
    source('VPWL', 'Piecewise Linear Voltage Source', false, 'Piecewise Linear', PWL_P('1'), pwl),
    source('IPWL', 'Piecewise Linear Current Source', true, 'Piecewise Linear', PWL_P('1m'), (s) => { pwl(s); s.line([-7, 6], [-3, 6]); }),
    source('VEXP', 'Exponential Voltage Source', false, 'Exponential', EXP_P('1'), expo),
    source('IEXP', 'Exponential Current Source', true, 'Exponential', EXP_P('1m'), (s) => { expo(s); s.line([-7, 6], [-3, 6]); }),
    source('VSFFM', 'Single-Frequency FM Voltage Source', false, 'Single-Frequency FM', SFFM_P('1'), fm),
    source('ISFFM', 'Single-Frequency FM Current Source', true, 'Single-Frequency FM', SFFM_P('1m'), (s) => { fm(s); s.line([-7, -6], [-3, -6]); }),
    directive('.IC', 'Initial Condition', 'Set Initial Condition', 'IC?'),
    directive('.NS', 'Initial Node Voltage Guess', 'Initial Node Voltage Guess', 'NS?'),
    ...kitSourceSymbols(),
  ];
}

/* ─── Simulation Parts ───────────────────────────────────────────────────────────────── */

export function simPartSymbols(): SimSymbolBuilder[] {
  const two = (s: SimSymbolBuilder, top: number, bottom: number) => s.pin('1', '1', [0, top], 1, 20 - top, { showName: false, showDesignator: false }).pin('2', '2', [0, bottom], 3, 20 + bottom, { showName: false, showDesignator: false });
  const res = new SimSymbolBuilder('RES', 'Resistor').rect([-3, -10], [3, 10]);
  two(res, 10, -10).designator('R?', [8, 4]).param('Comment', '=Value', [8, -6], true).param('Value', '1K', [8, -6])
    .sim({ name: 'RESISTOR', description: 'Resistor', kind: 'General', subKind: 'Resistor', prefix: 'R', netlist: '@DESIGNATOR %1 %2 @VALUE', params: [['Value', '*']] });
  const cap = new SimSymbolBuilder('CAP', 'Capacitor').line([-8, 2], [8, 2], 1, 2).line([-8, -2], [8, -2], 1, 2);
  two(cap, 2, -2).designator('C?', [12, 4]).param('Comment', '=Value', [12, -6], true).param('Value', '100n', [12, -6])
    .sim({ name: 'CAP', description: 'Capacitor', kind: 'General', subKind: 'Capacitor', prefix: 'C', netlist: '@DESIGNATOR %1 %2 @VALUE ?"INITIAL VOLTAGE"¦IC=@"INITIAL VOLTAGE"¦', params: [['Value', '*'], ['Initial Voltage', '']] });
  const ind = new SimSymbolBuilder('IND', 'Inductor');
  for (let k = 0; k < 4; k++) {
    const i = ind.add({ RECORD: SR.ARC, OWNERPARTID: 1, LINEWIDTH: 1, COLOR: C.body, STARTANGLE: 270, ENDANGLE: 90 }, { LOCATION: [0, 7.5 - k * 5] });
    setSchCoord(ind.bags[i]!, 'RADIUS', 2.5 * SCH_UNIT);
  }
  two(ind, 10, -10).designator('L?', [8, 4]).param('Comment', '=Value', [8, -6], true).param('Value', '10u', [8, -6])
    .sim({ name: 'INDUCTOR', description: 'Inductor', kind: 'General', subKind: 'Inductor', prefix: 'L', netlist: '@DESIGNATOR %1 %2 @VALUE ?"INITIAL CURRENT"¦IC=@"INITIAL CURRENT"¦', params: [['Value', '*'], ['Initial Current', '']] });
  const diode = (libRef: string, model: string, description: string, kind: '' | 'led' | 'schottky' | 'zener' = '') => {
    const led = kind === 'led';
    const s = new SimSymbolBuilder(libRef, description).polygon([[-6, 5], [6, 5], [0, -5]]).line([-6, -5], [6, -5], 1, 2);
    if (led) s.line([8, 2], [13, 7]).line([8, -2], [13, 3]);
    // The cathode's bar: hooked at both ends for a Schottky, bent at both for a Zener
    if (kind === 'schottky') s.line([-6, -5], [-6, -3], 1, 2).line([-6, -3], [-4, -3], 1, 2).line([6, -5], [6, -7], 1, 2).line([6, -7], [4, -7], 1, 2);
    if (kind === 'zener') s.line([-6, -5], [-8, -3], 1, 2).line([6, -5], [8, -7], 1, 2);
    return s.pin('A', 'A', [0, 5], 1, 15, { showName: false, showDesignator: false }).pin('K', 'K', [0, -5], 3, 15, { showName: false, showDesignator: false })
      .designator(led ? 'LED?' : 'D?', [10, 4]).param('Comment', model, [10, -6], true)
      .sim({ name: model, description, kind: 'Diode', subKind: 'Diode', prefix: 'D', netlist: '@DESIGNATOR %1 %2 @MODEL ?AREA¦@AREA¦ ?OFF¦OFF¦ ?"INITIAL VOLTAGE"¦IC=@"INITIAL VOLTAGE"¦ ?TEMPERATURE¦TEMP=@TEMPERATURE¦',
        file: { entity: model, kind: 'MDL' }, params: [['Area', ''], ['Off', ''], ['Initial Voltage', ''], ['Temperature', '']], portMap: [['1', 'A'], ['2', 'K']] });
  };
  const bjt = (libRef: string, model: string, pnp: boolean) => {
    const s = new SimSymbolBuilder(libRef, `${pnp ? 'PNP' : 'NPN'} bipolar transistor`).circle([3, 0], 12).line([-4, -7], [-4, 7], 1, 2).line([-4, 3], [10, 10]).line([-4, -3], [10, -10]);
    s.polygon(pnp ? [[-3, -3.5], [1.5, -3.2], [0, -6.5]] : [[10, -10], [5, -9.6], [7.5, -6]]);
    return s.pin('1', 'C', [10, 10], 1, 10, { showName: false, showDesignator: false }).pin('2', 'B', [-4, 0], 2, 16, { showName: false, showDesignator: false }).pin('3', 'E', [10, -10], 3, 10, { showName: false, showDesignator: false })
      .designator('Q?', [18, 4]).param('Comment', model, [18, -6], true)
      .sim({ name: model, description: `${pnp ? 'PNP' : 'NPN'} bipolar transistor`, kind: 'Transistor', subKind: 'BJT', prefix: 'Q',
        netlist: '@DESIGNATOR %1 %2 %3 @MODEL ?AREA¦@AREA¦ ?OFF¦OFF¦ ?TEMPERATURE¦TEMP=@TEMPERATURE¦', file: { entity: model, kind: 'MDL' }, params: [['Area', ''], ['Off', ''], ['Temperature', '']] });
  };
  const mos = (libRef: string, model: string, p: boolean) => {
    const s = new SimSymbolBuilder(libRef, `${p ? 'P' : 'N'}-channel MOSFET`).line([-6, -6], [-6, 6], 1, 2).line([-3, -8], [-3, 8], 1, 2)
      .line([-3, 5], [10, 5]).line([-3, -5], [10, -5]).line([-3, 0], [10, 0]).line([10, 0], [10, -5]);
    s.polygon(p ? [[4, 0], [0, 2], [0, -2]] : [[-2, 0], [2, 2], [2, -2]]);
    return s.pin('1', 'D', [10, 5], 1, 15, { showName: false, showDesignator: false }).pin('2', 'G', [-6, 0], 2, 14, { showName: false, showDesignator: false }).pin('3', 'S', [10, -5], 3, 15, { showName: false, showDesignator: false })
      .designator('Q?', [16, 4]).param('Comment', model, [16, -6], true)
      .sim({ name: model, description: `${p ? 'P' : 'N'}-channel MOSFET`, kind: 'Transistor', subKind: 'MOSFET', prefix: 'M',
        netlist: '@DESIGNATOR %1 %2 %3 %3 @MODEL ?LENGTH¦L=@LENGTH¦ ?WIDTH¦W=@WIDTH¦ ?OFF¦OFF¦', file: { entity: model, kind: 'MDL' }, params: [['Length', ''], ['Width', ''], ['Off', '']] });
  };
  const opamp = new SimSymbolBuilder('OPAMP', 'Operational amplifier (generic model)').polygon([[0, -20], [0, 20], [35, 0]], 1, false)
    .pin('3', '+', [0, 10], 2, 20, { electrical: 0 }).pin('2', '-', [0, -10], 2, 20, { electrical: 0 }).pin('6', 'OUT', [35, 0], 0, 15, { electrical: 2, showName: false })
    .pin('7', 'V+', [10, 14], 1, 16, { electrical: 7, showName: false }).pin('4', 'V-', [10, -14], 3, 16, { electrical: 7, showName: false })
    .designator('U?', [0, 24]).param('Comment', 'OPAMP', [24, 16], true)
    .sim({ name: 'OPAMP', description: 'Generic operational amplifier', kind: 'General', subKind: 'Spice Subcircuit', prefix: 'X', netlist: '@DESIGNATOR %1 %2 %3 %4 %5 @MODEL',
      file: { entity: 'OPAMP', kind: 'CKT' }, params: [], portMap: [['1', '3'], ['2', '2'], ['3', '7'], ['4', '4'], ['5', '6']] });
  // A switch and a push button: the picture is the state. Display mode 0 is open, mode 1 closed (each mode with its own
  // contacts and pins, as the format keeps them); the netlist reads the mode as a resistance (On Resistance, Off Resistance)
  const contact = (libRef: string, description: string, subKind: string, lever: (s: SimSymbolBuilder, closed: boolean) => void) => {
    const s = new SimSymbolBuilder(libRef, description);
    for (const m of [0, 1]) {
      s.mode(m);
      lever(s, m === 1);
      s.circle([0, 6], 2).circle([0, -6], 2);
      two(s, 8, -8);
    }
    return s.mode(0).designator('SW?', [10, 4]).hiddenComment(libRef, [10, -6])
      .sim({ name: libRef, description, kind: 'General', subKind, prefix: 'R', netlist: '@DESIGNATOR %1 %2 @"SWITCH RESISTANCE"', params: [['On Resistance', '1m'], ['Off Resistance', '1G']] });
  };
  const sw = contact('SWITCH', 'Switch (a click opens or closes it in Live Simulation)', 'Switch', (s, closed) => s.line([0, -6], closed ? [0, 6] : [6, 4], 1, 2));
  const push = contact('PUSHBUTTON', 'Push button (closed while it is pressed in Live Simulation)', 'Push Button',
    (s, closed) => s.line([closed ? 1.5 : 5, -7], [closed ? 1.5 : 5, 7], 1, 2).line([closed ? 1.5 : 5, 0], [10, 0]).line([10, -3], [10, 3], 1, 2));
  const all = [res, cap, ind, sw, push, diode('DIODE', '1N4148', 'Signal diode'), diode('RECTIFIER', '1N4001', 'Rectifier diode'), diode('LED', 'LED_RED', 'Light-emitting diode (red)', 'led'),
    bjt('NPN', '2N3904', false), bjt('PNP', '2N3906', true), mos('NMOS', '2N7002', false), mos('PMOS', 'BSS84', true), opamp, ...kitPartSymbols()];
  // What each is rated for (Live Simulation flags a part that takes more): a parameter of the part, not shown
  for (const s of all) { const r = RATINGS[s.libRef]; if (r) s.param(RATING_PARAMS[r.kind], r.text, [8, -16]); }
  return all;
}

const lib = (symbols: SimSymbolBuilder[]) => writeSchLib(symbols.map((s) => ({ libRef: s.libRef, description: s.description, parts: s.parts, bags: s.bags })));
export const simSourcesSchLib = (): Uint8Array => lib(simSourceSymbols());
export const simPartsSchLib = (): Uint8Array => lib(simPartSymbols());

export const SIM_SOURCES_LIB = 'Simulation Sources.SchLib';
export const SIM_PARTS_LIB = 'Simulation Parts.SchLib';
