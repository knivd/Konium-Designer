/**
 * The parts Live Simulation's palette adds to Konium's simulation libraries: parts whose behaviour
 * is set by a few plain values of each one's own (a diode's forward voltage, a transistor's beta,
 * an op-amp's gain and output limits), more passive parts (potentiometer, changeover switch,
 * transformer, relay, crystal), sources by waveform (square, triangle, sawtooth, AM, sweep, and
 * one-pin rails), controlled sources and blocks, logic and chips (a logic input, gates, a Schmitt
 * trigger, a 555 timer, a regulator, an optocoupler, flip-flops, a counter, a seven-segment decoder
 * and display), a fuse, a thyristor and a TRIAC, and meters and outputs (voltmeter, ammeter, test
 * point, lamp, speaker). Most are built-in subcircuits that take their values as parameters
 * (src/sim/library.ts); the symbols are Konium's own drawings.
 */
import { SR, setSchCoord } from '../../model/sch';
import { SCH_UNIT } from '../../core/units';
import { SimSymbolBuilder, ZIGZAG, curvedPlate, inStyle, type SymbolStyle } from './simLib';

type XY = [number, number];
const BODY = 128;
const HIDE = { showName: false, showDesignator: false };
/** The seven segments (a to g) of the display's digit, each a line in the symbol's own tenths of an inch. Live Simulation lights them over these. */
export const SEG7_LINES: [XY, XY][] = [[[6, 26], [22, 26]], [[24, 24], [24, 2]], [[24, -2], [24, -24]], [[6, -26], [22, -26]], [[4, -24], [4, -2]], [[4, 2], [4, 24]], [[6, 0], [22, 0]]];
/** A two-pin part standing up: pin 1 at the top, pin 2 at the bottom, their ends 200 mil from the middle. */
const two = (s: SimSymbolBuilder, top: number, bottom: number, a = '1', b = '2') => s.pin(a, a, [0, top], 1, 20 - top, HIDE).pin(b, b, [0, bottom], 3, 20 + bottom, HIDE);
const arc = (s: SimSymbolBuilder, c: XY, r: number, start: number, end: number) => {
  const i = s.add({ RECORD: SR.ARC, OWNERPARTID: 1, LINEWIDTH: 1, COLOR: BODY, STARTANGLE: start, ENDANGLE: end }, { LOCATION: c });
  setSchCoord(s.bags[i]!, 'RADIUS', r * SCH_UNIT);
  return s;
};
/** A parameterised subcircuit's netlist line: its pins, its name, then each parameter as NAME=value. */
const sub = (pins: number, pairs: [string, string][]) => `@DESIGNATOR ${Array.from({ length: pins }, (_, i) => `%${i + 1}`).join(' ')} @MODEL PARAMS: ${pairs.map(([k, name]) => `${k}=@"${name.toUpperCase()}"`).join(' ')}`;
/** A part that is a built-in subcircuit taking parameters: [the subcircuit's parameter, the name shown, its value]. */
const block = (s: SimSymbolBuilder, entity: string, pins: number, values: [string, string, string][]) => s.sim({
  name: entity, description: s.description, kind: 'General', subKind: 'Spice Subcircuit', prefix: 'X',
  netlist: sub(pins, values.map(([k, name]) => [k, name])), file: { entity, kind: 'CKT' }, params: values.map(([, name, v]): [string, string] => [name, v]),
});

/* ─── Parts ──────────────────────────────────────────────────────────────────────────── */

export function kitPartSymbols(style: SymbolStyle = 'european'): SimSymbolBuilder[] {
  const american = style === 'american';
  const out: SimSymbolBuilder[] = [];
  const S = (libRef: string, description: string) => { const s = new SimSymbolBuilder(libRef, inStyle(description, style)); out.push(s); return s; };

  // Passive
  // The polarised capacitor (an electrolytic, a tantalum): its positive plate (pin 1, marked +) a hollow box over a solid one, or a straight plate over the curved one
  const capPol = S('CAP_POL', 'Polarised capacitor (pin 1 is its positive side)');
  if (american) curvedPlate(capPol.line([-8, 2], [8, 2], 1, 2));
  else { capPol.rect([-8, 1], [8, 3]); capPol.add({ RECORD: SR.RECTANGLE, OWNERPARTID: 1, LINEWIDTH: 1, COLOR: BODY, AREACOLOR: BODY, ISSOLID: true }, { LOCATION: [-8, -3], CORNER: [8, -1] }); }
  capPol.line([3, 7.5], [7, 7.5]).line([5, 5.5], [5, 9.5]);
  // (a pin's length is whole tenths of an inch: the plates are where their pins can end)
  two(capPol, american ? 2 : 3, american ? -2 : -3).designator('C?', [12, 4]).param('Comment', '=Value', [12, -6], true).param('Value', '100u', [12, -6])
    .sim({ name: 'CAP_POL', description: inStyle('Polarised capacitor', style), kind: 'General', subKind: 'Capacitor', prefix: 'C', netlist: '@DESIGNATOR %1 %2 @VALUE ?"INITIAL VOLTAGE"¦IC=@"INITIAL VOLTAGE"¦', params: [['Value', '*'], ['Initial Voltage', '']] });

  const pot = S('POT', 'Potentiometer (its wiper set by Position, 0 to 100 %)');
  if (american) pot.polyline(ZIGZAG); else pot.rect([-3, -10], [3, 10]);
  pot.polygon([[3, 0], [8, 2.5], [8, -2.5]]);
  two(pot, 10, -10).pin('3', '3', [8, 0], 0, 12, HIDE).designator('RV?', [8, 8]).param('Comment', '=Resistance', [8, -12], true).param('Resistance', '10k', [8, -12]);
  block(pot, 'POT', 3, [['R', 'Resistance', '*'], ['POS', 'Position', '50']]);

  const spdt = S('SWITCH_SPDT', 'Changeover switch (a click throws it in Live Simulation)');
  for (const m of [0, 1]) {
    spdt.mode(m).line([0, -6], m ? [9, 5] : [-9, 5], 1, 2).circle([0, -6], 2).circle([-10, 6], 2).circle([10, 6], 2)
      .pin('1', '1', [0, -8], 3, 12, HIDE).pin('2', '2', [-10, 8], 1, 12, HIDE).pin('3', '3', [10, 8], 1, 12, HIDE);
  }
  spdt.mode(0).designator('SW?', [14, -4]).hiddenComment('SWITCH_SPDT', [14, -14])
    .sim({ name: 'SWITCH_SPDT', description: 'Changeover switch', kind: 'General', subKind: 'Switch', prefix: 'X', netlist: '@DESIGNATOR %1 %2 %3 @MODEL PARAMS: RA=@"SWITCH RESISTANCE OTHER" RB=@"SWITCH RESISTANCE"',
      file: { entity: 'SWITCH_SPDT', kind: 'CKT' }, params: [['On Resistance', '1m'], ['Off Resistance', '1G']] });

  const tr = S('TRANSFORMER', 'Transformer (two coupled windings)').line([-2, -10], [-2, 10]).line([2, -10], [2, 10]).circle([-6, 12], 1).circle([6, 12], 1);
  for (let k = 0; k < 4; k++) { arc(tr, [-10, 7.5 - k * 5], 2.5, 270, 90); arc(tr, [10, 7.5 - k * 5], 2.5, 90, 270); }
  tr.pin('1', '1', [-10, 10], 1, 10, HIDE).pin('2', '2', [-10, -10], 3, 10, HIDE).pin('3', '3', [10, 10], 1, 10, HIDE).pin('4', '4', [10, -10], 3, 10, HIDE).designator('T?', [16, 4]).hiddenComment('TRANSFORMER', [16, -6]);
  block(tr, 'TRANSFORMER', 4, [['LP', 'Primary Inductance', '100m'], ['RATIO', 'Ratio', '1'], ['K', 'Coupling', '0.999']]);

  const relay = S('RELAY', 'Relay (a coil closing a contact)').rect([-14, -6], [-6, 6]).line([-14, -3], [-6, 3]).line([-6, 0], [11, 0]).circle([10, 6], 2).circle([10, -6], 2).line([10, -6], [15, 4], 1, 2)
    .pin('1', '1', [-10, 6], 1, 14, HIDE).pin('2', '2', [-10, -6], 3, 14, HIDE).pin('3', '3', [10, 8], 1, 12, HIDE).pin('4', '4', [10, -8], 3, 12, HIDE).designator('K?', [18, 4]).hiddenComment('RELAY', [18, -6]);
  block(relay, 'RELAY', 4, [['RCOIL', 'Coil Resistance', '200'], ['LCOIL', 'Coil Inductance', '20m'], ['ION', 'Pull-In Current', '20m'], ['IOFF', 'Drop-Out Current', '10m'], ['RON', 'On Resistance', '50m'], ['ROFF', 'Off Resistance', '1G']]);

  const xtal = S('XTAL', 'Crystal').line([-7, 5], [7, 5], 1, 2).line([-7, -5], [7, -5], 1, 2).rect([-9, -2.5], [9, 2.5]);
  two(xtal, 5, -5).designator('Y?', [13, 4]).param('Comment', '=Frequency', [13, -6], true).param('Frequency', '1Meg', [13, -6]);
  block(xtal, 'XTAL', 2, [['F', 'Frequency', '*'], ['CS', 'Series Capacitance', '10f'], ['RS', 'Series Resistance', '50'], ['CP', 'Parallel Capacitance', '5p']]);

  // Diodes set by their forward voltage
  const diode = (libRef: string, description: string, kind: '' | 'led' | 'schottky' | 'zener', values: [string, string, string][], des = 'D?') => {
    const s = S(libRef, description).polygon([[-6, 5], [6, 5], [0, -5]]).line([-6, -5], [6, -5], 1, 2);
    if (kind === 'led') s.line([8, 2], [13, 7]).line([8, -2], [13, 3]).polygon([[13, 7], [10.5, 6.3], [12.3, 4.5]]).polygon([[13, 3], [10.5, 2.3], [12.3, 0.5]]);
    if (kind === 'schottky') s.line([-6, -5], [-6, -3], 1, 2).line([-6, -3], [-4, -3], 1, 2).line([6, -5], [6, -7], 1, 2).line([6, -7], [4, -7], 1, 2);
    if (kind === 'zener') s.line([-6, -5], [-8, -3], 1, 2).line([6, -5], [8, -7], 1, 2);
    s.pin('A', 'A', [0, 5], 1, 15, HIDE).pin('K', 'K', [0, -5], 3, 15, HIDE).designator(des, [kind === 'led' ? 16 : 11, 4]).hiddenComment(libRef, [11, -6]);
    s.sim({ name: 'DIODE_VF', description, kind: 'General', subKind: kind === 'led' ? 'Light-Emitting Diode' : 'Spice Subcircuit', prefix: 'X', netlist: sub(2, values.map(([k, name]) => [k, name])),
      file: { entity: 'DIODE_VF', kind: 'CKT' }, params: values.map(([, name, v]): [string, string] => [name, v]), portMap: [['1', 'A'], ['2', 'K']] });
  };
  diode('DIODE_VF', 'Diode (set by its forward voltage)', '', [['VF', 'Forward Voltage', '0.7'], ['IF', 'At Current', '10m'], ['RS', 'Series Resistance', '0.5'], ['BV', 'Breakdown Voltage', '100']]);
  diode('SCHOTTKY', 'Schottky diode (set by its forward voltage)', 'schottky', [['VF', 'Forward Voltage', '0.3'], ['IF', 'At Current', '10m'], ['RS', 'Series Resistance', '0.2'], ['BV', 'Breakdown Voltage', '40'], ['N', 'Emission Coefficient', '1.05']]);
  diode('ZENER', 'Zener diode (set by its Zener voltage)', 'zener', [['BV', 'Zener Voltage', '5.1'], ['VF', 'Forward Voltage', '0.7'], ['IF', 'At Current', '10m'], ['RS', 'Series Resistance', '1']]);
  diode('LED_VF', 'Light-emitting diode (it lights in Live Simulation)', 'led', [['VF', 'Forward Voltage', '1.8'], ['IF', 'At Current', '20m'], ['RS', 'Series Resistance', '1'], ['BV', 'Breakdown Voltage', '5'], ['N', 'Emission Coefficient', '2']], 'LED?');
  out[out.length - 1]!.param('Colour', 'Red', [11, -16]);

  // Transistors set by a value or two
  const bjt = (libRef: string, pnp: boolean, darlington = false) => {
    const s = S(libRef, darlington ? 'Darlington pair (NPN), set by its beta' : `${pnp ? 'PNP' : 'NPN'} transistor (set by its beta)`).circle([3, 0], 12).line([-4, -7], [-4, 7], 1, 2).line([-4, 3], [10, 10]).line([-4, -3], [10, -10]);
    s.polygon(pnp ? [[-3, -3.5], [1.5, -3.2], [0, -6.5]] : [[10, -10], [5, -9.6], [7.5, -6]]);
    if (darlington) arc(s, [3, 0], 14, 0, 360);
    s.pin('1', 'C', [10, 10], 1, 10, HIDE).pin('2', 'B', [-4, 0], 2, 16, HIDE).pin('3', 'E', [10, -10], 3, 10, HIDE).designator('Q?', [19, 4]).hiddenComment(libRef, [19, -6]);
    block(s, darlington ? 'DARLINGTON' : pnp ? 'PNP_BETA' : 'NPN_BETA', 3, darlington ? [['BF', 'Beta', '10k']] : [['BF', 'Beta', '100'], ['VAF', 'Early Voltage', '100']]);
  };
  bjt('NPN_BETA', false); bjt('PNP_BETA', true); bjt('DARLINGTON', false, true);
  const mos = (libRef: string, p: boolean) => {
    const s = S(libRef, `${p ? 'P' : 'N'}-channel MOSFET (set by its threshold voltage and beta)`).line([-6, -6], [-6, 6], 1, 2).line([-3, -8], [-3, 8], 1, 2).line([-3, 5], [10, 5]).line([-3, -5], [10, -5]).line([-3, 0], [10, 0]).line([10, 0], [10, -5]);
    s.polygon(p ? [[4, 0], [0, 2], [0, -2]] : [[-2, 0], [2, 2], [2, -2]]);
    s.pin('1', 'D', [10, 5], 1, 15, HIDE).pin('2', 'G', [-6, 0], 2, 14, HIDE).pin('3', 'S', [10, -5], 3, 15, HIDE).designator('Q?', [16, 4]).hiddenComment(libRef, [16, -6]);
    block(s, libRef, 3, [['VT', 'Threshold Voltage', '1.5'], ['KP', 'Beta', '0.5']]);
  };
  mos('NMOS_VT', false); mos('PMOS_VT', true);
  const jfet = (libRef: string, p: boolean) => {
    const s = S(libRef, `${p ? 'P' : 'N'}-channel JFET (set by its pinch-off voltage and saturation current)`).line([-4, -8], [-4, 8], 1, 2).line([-4, 5], [10, 5]).line([-4, -5], [10, -5]);
    s.polygon(p ? [[-10, 0], [-5, 2.5], [-5, -2.5]] : [[-4, 0], [-9, 2.5], [-9, -2.5]]);
    s.pin('1', 'D', [10, 5], 1, 15, HIDE).pin('2', 'G', [-4, 0], 2, 16, HIDE).pin('3', 'S', [10, -5], 3, 15, HIDE).designator('Q?', [16, 4]).hiddenComment(libRef, [16, -6]);
    block(s, libRef, 3, [['VP', 'Pinch-Off Voltage', '2'], ['IDSS', 'Saturation Current', '5m']]);
  };
  jfet('NJFET', false); jfet('PJFET', true);

  // Amplifiers and blocks
  const tri = (libRef: string, description: string, glyph: (s: SimSymbolBuilder) => void) => {
    const s = S(libRef, description).polygon([[0, -20], [0, 20], [35, 0]], 1, false).line([3, 10], [9, 10]).line([6, 7], [6, 13]).line([3, -10], [9, -10]);
    glyph(s);
    return s.pin('1', '+', [0, 10], 2, 20, { electrical: 0, ...HIDE }).pin('2', '-', [0, -10], 2, 20, { electrical: 0, ...HIDE }).pin('3', 'OUT', [35, 0], 0, 15, { electrical: 2, ...HIDE }).designator('U?', [0, 24]);
  };
  block(tri('OPAMP_IDEAL', 'Operational amplifier (no supply pins: set by its gain and how far its output swings)', () => undefined).hiddenComment('OPAMP_IDEAL', [24, 16]), 'OPAMP_IDEAL', 3,
    [['GAIN', 'Gain', '100k'], ['VMAX', 'Max Output', '15'], ['VMIN', 'Min Output', '-15'], ['GBW', 'Gain-Bandwidth', '1Meg']]);
  block(tri('COMPARATOR', 'Comparator (its output high when + is above -)', (s) => s.polyline([[14, -4], [18, -4], [18, 4], [22, 4]])).hiddenComment('COMPARATOR', [24, 16]), 'COMPARATOR', 3,
    [['VHIGH', 'High Output', '5'], ['VLOW', 'Low Output', '0']]);

  const four = (libRef: string, description: string, des: string, glyph: (s: SimSymbolBuilder) => void) => {
    const s = S(libRef, description).polygon([[10, 9], [17, 0], [10, -9], [3, 0]], 1, false).line([-10, 10], [-4, 10]).line([-10, -10], [-4, -10]);
    glyph(s);
    return s.pin('1', '1', [-10, 10], 2, 10, HIDE).pin('2', '2', [-10, -10], 2, 10, HIDE).pin('3', '3', [10, 9], 1, 11, HIDE).pin('4', '4', [10, -9], 3, 11, HIDE).designator(des, [20, 4]).hiddenComment(libRef, [20, -6]);
  };
  const volts = (s: SimSymbolBuilder) => s.line([8, 4], [12, 4]).line([10, 2], [10, 6]).line([8, -4], [12, -4]);
  const amps = (s: SimSymbolBuilder) => s.line([10, -5], [10, 4]).polygon([[8, 2], [12, 2], [10, 6]]);
  const sensed = (s: SimSymbolBuilder) => s.line([-4, 10], [-4, -10]).polygon([[-5.5, 1.5], [-2.5, 1.5], [-4, -2]]);
  const open = (s: SimSymbolBuilder) => s.circle([-4, 10], 1).circle([-4, -10], 1);
  four('VCVS', 'Voltage-controlled voltage source: its output is Gain times the voltage between its inputs', 'E?', (s) => { open(s); volts(s); })
    .sim({ name: 'VCVS', description: 'Voltage-controlled voltage source', kind: 'Voltage Source', subKind: 'Voltage-Controlled', prefix: 'E', netlist: '@DESIGNATOR %3 %4 %1 %2 @GAIN', params: [['Gain', '10']] });
  four('VCCS', 'Voltage-controlled current source: its current is Gain (siemens) times the voltage between its inputs', 'G?', (s) => { open(s); amps(s); })
    .sim({ name: 'VCCS', description: 'Voltage-controlled current source', kind: 'Current Source', subKind: 'Voltage-Controlled', prefix: 'G', netlist: '@DESIGNATOR %3 %4 %1 %2 @GAIN', params: [['Gain', '1m']] });
  block(four('CCVS', 'Current-controlled voltage source: its output is Gain (ohms) times the current through its inputs', 'H?', (s) => { sensed(s); volts(s); }), 'CCVS', 4, [['GAIN', 'Gain', '1k']]);
  block(four('CCCS', 'Current-controlled current source: its current is Gain times the current through its inputs', 'F?', (s) => { sensed(s); amps(s); }), 'CCCS', 4, [['GAIN', 'Gain', '10']]);

  const asw = S('ANALOG_SWITCH', 'Analogue switch (closed while its control is above the threshold)').rect([-8, -6], [8, 6]).circle([-4, 0], 1.5).circle([4, 0], 1.5).line([-4, 0], [3, 3], 1, 2).line([0, -6], [0, 1])
    .pin('1', '1', [-8, 0], 2, 12, HIDE).pin('2', '2', [8, 0], 0, 12, HIDE).pin('3', 'C', [0, -6], 3, 14, HIDE).designator('S?', [10, 8]).hiddenComment('ANALOG_SWITCH', [10, -12]);
  block(asw, 'ANALOG_SWITCH', 3, [['VT', 'Threshold', '2.5'], ['RON', 'On Resistance', '20'], ['ROFF', 'Off Resistance', '1G']]);

  // Meters and outputs
  const meter = (libRef: string, description: string, des: string, letter: (s: SimSymbolBuilder) => void) => { const s = S(libRef, description).circle([0, 0], 8); letter(s); return two(s, 8, -8).designator(des, [12, 4]).hiddenComment(libRef, [12, -6]); };
  meter('VOLTMETER', 'Voltmeter: reads the voltage across it on the sheet in Live Simulation', 'VM?', (s) => s.polyline([[-3.5, 4], [0, -4], [3.5, 4]]))
    .sim({ name: 'VOLTMETER', description: 'Voltmeter', kind: 'General', subKind: 'Voltmeter', prefix: 'R', netlist: '@DESIGNATOR %1 %2 @RESISTANCE', params: [['Resistance', '10Meg'], ['Shows', 'Value'], ['On Scope', 'None']] });
  meter('AMMETER', 'Ammeter: reads the current through it on the sheet in Live Simulation', 'AM?', (s) => s.polyline([[-3.5, -4], [0, 4], [3.5, -4]]).line([-1.8, -0.5], [1.8, -0.5]))
    .sim({ name: 'AMMETER', description: 'Ammeter', kind: 'General', subKind: 'Ammeter', prefix: 'V', netlist: '@DESIGNATOR %1 %2 DC 0', params: [['Shows', 'Value'], ['On Scope', 'None']] });
  S('TESTPOINT', 'Test point: reads its net\'s voltage on the sheet in Live Simulation').circle([0, 4], 3).pin('1', '1', [0, 1], 3, 11, HIDE).designator('TP?', [-8, 9]).hiddenComment('TESTPOINT', [6, -6])
    .sim({ name: 'TESTPOINT', description: 'Test point', kind: 'General', subKind: 'Test Point', prefix: 'R', netlist: '@DESIGNATOR %1 0 1T', params: [['Shows', 'Value'], ['On Scope', 'None']] });
  const lamp = S('LAMP', 'Lamp (it lights by the power in it in Live Simulation)').circle([0, 0], 8).line([-5.6, -5.6], [5.6, 5.6]).line([-5.6, 5.6], [5.6, -5.6]);
  two(lamp, 8, -8).designator('LA?', [12, 4]).hiddenComment('LAMP', [12, -6])
    .sim({ name: 'LAMP', description: 'Lamp', kind: 'General', subKind: 'Lamp', prefix: 'R', netlist: '@DESIGNATOR %1 %2 {(@"NOMINAL VOLTAGE")*(@"NOMINAL VOLTAGE")/(@"NOMINAL POWER")}', params: [['Nominal Voltage', '12'], ['Nominal Power', '5']] });

  // Logic and chips
  // A logic input: its picture is its state (display mode 0 low, 1 high), as a switch's is; a click changes it
  const input = S('LOGIC_IN', 'Logic input (a click changes it between low and high in Live Simulation)');
  for (const m of [0, 1]) {
    input.mode(m).rect([-7, -7], [7, 7]);
    if (m) input.line([-3, 4], [-3, -4]).line([3, 4], [3, -4]).line([-3, 0], [3, 0]); else input.line([-2.5, 4], [-2.5, -4]).line([-2.5, -4], [3, -4]);
    input.pin('1', '1', [7, 0], 0, 13, HIDE);
  }
  input.mode(0).designator('IN?', [-7, 10]).hiddenComment('LOGIC_IN', [-7, -18])
    .sim({ name: 'LOGIC_IN', description: 'Logic input', kind: 'General', subKind: 'Switch', prefix: 'X', netlist: '@DESIGNATOR %1 @MODEL PARAMS: RA=@"SWITCH RESISTANCE" RB=@"SWITCH RESISTANCE OTHER" VH=@"HIGH LEVEL"',
      file: { entity: 'LOGIC_IN', kind: 'CKT' }, params: [['On Resistance', '1'], ['Off Resistance', '1G'], ['High Level', '5']] });

  // Gates in their distinctive shapes: inputs at the left 100 mil above and below the middle, the output at the right
  const LEVEL: [string, string, string][] = [['VDD', 'High Level', '5']];
  const OR_BACK: XY[] = [14, 10.5, 7, 3.5, 0, -3.5, -7, -10.5, -14].map((y): XY => [-10 + 4 * (1 - (y / 14) ** 2), y]);
  const OR_TOP: XY[] = [[-10, 14], [-3, 13.6], [3, 11.5], [8, 7.5], [11.5, 3.8], [14, 0]];
  const gate = (libRef: string, what: string, shape: 'and' | 'or' | 'xor', bubble: boolean) => {
    const g = S(libRef, `${what} gate (two inputs)`);
    if (shape === 'and') arc(g.polyline([[0, 14], [-10, 14], [-10, -14], [0, -14]]), [0, 0], 14, 270, 90);
    else g.polyline(OR_BACK).polyline(OR_TOP).polyline(OR_TOP.map(([x, y]): XY => [x, -y]));
    if (shape === 'xor') g.polyline(OR_BACK.map(([x, y]): XY => [x - 3.5, y]));
    if (bubble) g.circle([16, 0], 2);
    const back = shape === 'and' ? -10 : -8;
    g.pin('1', 'A', [back, 10], 2, 20 + back, HIDE).pin('2', 'B', [back, -10], 2, 20 + back, HIDE).pin('3', 'OUT', [bubble ? 18 : 14, 0], 0, bubble ? 12 : 16, HIDE).designator('U?', [-10, 18]).hiddenComment(libRef, [-10, -26]);
    block(g, `GATE_${libRef}`, 3, LEVEL);
  };
  const inverter = (libRef: string, description: string, entity: string, values: [string, string, string][], glyph: (g: SimSymbolBuilder) => void) => {
    const g = S(libRef, description).polygon([[-10, 10], [-10, -10], [8, 0]], 1, false).circle([10, 0], 2);
    glyph(g);
    g.pin('1', 'IN', [-10, 0], 2, 10, HIDE).pin('2', 'OUT', [12, 0], 0, 8, HIDE).designator('U?', [-10, 14]).hiddenComment(libRef, [-10, -22]);
    block(g, entity, 2, values);
  };
  inverter('NOT', 'Inverter (NOT gate)', 'GATE_NOT', LEVEL, () => undefined);
  gate('AND', 'AND', 'and', false); gate('NAND', 'NAND', 'and', true); gate('OR', 'OR', 'or', false); gate('NOR', 'NOR', 'or', true); gate('XOR', 'Exclusive-OR', 'xor', false);
  inverter('SCHMITT_NOT', 'Schmitt-trigger inverter (set by its two thresholds)', 'SCHMITT_NOT', [...LEVEL, ['VP', 'Upper Threshold', '3'], ['VN', 'Lower Threshold', '2']],
    (g) => g.polyline([[-8.5, -2.5], [-4, -2.5], [-4, 2.5], [-1.5, 2.5]]).polyline([[-6.5, -2.5], [-6.5, 2.5], [-4, 2.5]]));

  // A 555 timer: the pins by name round a box, numbered as the chip's are
  const NAMED = { showDesignator: false };
  // (the names of the pins at the top and bottom are written along them, so those pins stand clear of the names at the sides)
  S('NE555', '555 timer').rect([-30, -30], [30, 30])
    .pin('7', 'DIS', [-30, 10], 2, 10, NAMED).pin('6', 'THR', [-30, 0], 2, 10, NAMED).pin('2', 'TRIG', [-30, -10], 2, 10, NAMED).pin('3', 'OUT', [30, 0], 0, 10, NAMED)
    .pin('4', 'RESET', [0, 30], 1, 10, NAMED).pin('8', 'VCC', [10, 30], 1, 10, NAMED).pin('1', 'GND', [0, -30], 3, 10, NAMED).pin('5', 'CTRL', [10, -30], 3, 10, NAMED)
    .designator('U?', [16, 33]).param('Comment', '555', [16, -41], true)
    .sim({ name: 'NE555', description: '555 timer', kind: 'General', subKind: 'Spice Subcircuit', prefix: 'X', netlist: '@DESIGNATOR %1 %2 %3 %4 %5 %6 %7 %8 @MODEL', file: { entity: 'NE555', kind: 'CKT' }, params: [] });
  const reg = S('REGULATOR', 'Voltage regulator (set by its output voltage and its dropout)').rect([-15, -10], [15, 10])
    .pin('1', 'IN', [-15, 0], 2, 15, NAMED).pin('2', 'GND', [0, -10], 3, 10, NAMED).pin('3', 'OUT', [15, 0], 0, 15, NAMED).designator('U?', [-15, 13]).hiddenComment('REGULATOR', [6, -20]);
  block(reg, 'REGULATOR', 3, [['VOUT', 'Output Voltage', '5'], ['DROP', 'Dropout', '2']]);
  // An optocoupler: an LED and the transistor its light turns on, in one box
  const opto = S('OPTO', 'Optocoupler (an LED and a transistor its light turns on)').rect([-15, -15], [15, 15])
    .line([-15, 10], [-8, 10]).line([-8, 10], [-8, 4]).polygon([[-12, 4], [-4, 4], [-8, -3]]).line([-12, -3], [-4, -3], 1, 2).line([-8, -3], [-8, -10]).line([-8, -10], [-15, -10])
    .line([-2, 3], [3, 1]).polygon([[3, 1], [0.6, 3.3], [0, 0.9]]).line([-2, -1], [3, -3]).polygon([[3, -3], [0.6, -0.7], [0, -3.1]])
    .line([6, -6], [6, 6], 1, 2).line([6, 3], [12, 10]).line([12, 10], [15, 10]).line([6, -3], [12, -10]).line([12, -10], [15, -10]).polygon([[12, -10], [8.4, -8.6], [10.4, -6]])
    .pin('1', 'A', [-15, 10], 2, 15, HIDE).pin('2', 'K', [-15, -10], 2, 15, HIDE).pin('3', 'C', [15, 10], 0, 15, HIDE).pin('4', 'E', [15, -10], 0, 15, HIDE).designator('U?', [-15, 18]).hiddenComment('OPTO', [-15, -26]);
  block(opto, 'OPTO', 4, [['CTR', 'Transfer Ratio', '100'], ['VF', 'Forward Voltage', '1.2']]);

  // Flip-flops: a box, the clock marked by a wedge, Q and its inverse on the right
  const WEDGE = (s: SimSymbolBuilder, x: number, y: number) => s.polyline([[x, y + 3], [x + 5, y], [x, y - 3]]);
  const flop = (libRef: string, description: string, left: [string, number][], clock: number, h: number, pins: string[]) => {
    const s = S(libRef, description).rect([-20, -h], [20, h]);
    WEDGE(s, -20, clock);
    for (const [name, y] of left) s.pin(String(pins.indexOf(name) + 1), name, [-20, y], 2, 10, NAMED);
    s.pin(String(pins.indexOf('CLK') + 1), 'CLK', [-20, clock], 2, 10, HIDE);
    s.pin(String(pins.indexOf('Q') + 1), 'Q', [20, h - 10], 0, 10, NAMED).pin(String(pins.indexOf('QN') + 1), 'Q\\', [20, 10 - h], 0, 10, NAMED).designator('U?', [-20, h + 3]).hiddenComment(libRef, [-20, -h - 11]);
    block(s, libRef, pins.length, LEVEL);
  };
  flop('DFF', 'D flip-flop: Q takes what D is as the clock rises', [['D', 10]], -10, 20, ['D', 'CLK', 'Q', 'QN']);
  flop('JKFF', 'JK flip-flop: as the clock rises J sets it, K clears it, both turn it over', [['J', 20], ['K', -20]], 0, 30, ['J', 'CLK', 'K', 'Q', 'QN']);
  flop('TFF', 'T flip-flop: Q turns over as the clock rises while T is high', [['T', 10]], -10, 20, ['T', 'CLK', 'Q', 'QN']);
  // A four-bit counter; its outputs stand level with the decoder's inputs, and the decoder's outputs with the display's pins
  const counter = S('COUNTER', 'Four-bit counter: counts up as the clock rises, to its modulus less one and round again; RST high clears it').rect([-20, -20], [20, 30]);
  WEDGE(counter, -20, 20);
  counter.pin('1', 'CLK', [-20, 20], 2, 10, HIDE).pin('2', 'RST', [-20, -10], 2, 10, NAMED);
  ['Q0', 'Q1', 'Q2', 'Q3'].forEach((n, i) => counter.pin(String(3 + i), n, [20, 20 - 10 * i], 0, 10, NAMED));
  counter.designator('U?', [-20, 33]).param('Comment', 'Counter', [-20, -31], true);
  block(counter, 'COUNTER', 6, [...LEVEL, ['MODULUS', 'Modulus', '16']]);
  const decoder = S('DECODER7', 'Seven-segment decoder: a four-bit number in, the seven segments of its digit out').rect([-20, -40], [20, 40]);
  ['A', 'B', 'C', 'D'].forEach((n, i) => decoder.pin(String(1 + i), n, [-20, 20 - 10 * i], 2, 10, NAMED));
  [...'abcdefg'].forEach((n, i) => decoder.pin(String(5 + i), n, [20, 30 - 10 * i], 0, 10, NAMED));
  decoder.designator('U?', [-20, 43]).param('Comment', 'Decoder', [-20, -51], true);
  block(decoder, 'DECODER7', 11, LEVEL);
  // A shift register, a ring counter, a multiplexer and the two converters (26.186): boxes as the counter's, their bits level with its own
  const shift = S('SHIFT', 'Four-bit shift register: as the clock rises Q0 takes what D is and each other bit what the one before it was; RST high clears it').rect([-20, -20], [20, 30]);
  WEDGE(shift, -20, 10);
  shift.pin('1', 'D', [-20, 20], 2, 10, NAMED).pin('2', 'CLK', [-20, 10], 2, 10, HIDE).pin('3', 'RST', [-20, -10], 2, 10, NAMED);
  ['Q0', 'Q1', 'Q2', 'Q3'].forEach((n, i) => shift.pin(String(4 + i), n, [20, 20 - 10 * i], 0, 10, NAMED));
  shift.designator('U?', [-20, 33]).param('Comment', 'Shift register', [-20, -31], true);
  block(shift, 'SHIFT', 7, LEVEL);
  const ring = S('RING', 'Ring counter: one output high at a time, the next as the clock rises, round again after its stages; RST high goes back to Q0').rect([-20, -60], [20, 50]);
  WEDGE(ring, -20, 40);
  ring.pin('1', 'CLK', [-20, 40], 2, 10, HIDE).pin('2', 'RST', [-20, 10], 2, 10, NAMED);
  for (let i = 0; i < 10; i++) ring.pin(String(3 + i), `Q${i}`, [20, 40 - 10 * i], 0, 10, NAMED);
  ring.designator('U?', [-20, 53]).param('Comment', 'Ring counter', [-20, -71], true);
  block(ring, 'RING', 12, [...LEVEL, ['STAGES', 'Stages', '10']]);
  const mux = S('MUX4', 'Multiplexer: its output is the one of its four inputs that S1 and S0 name').rect([-20, -50], [20, 30]);
  ['I0', 'I1', 'I2', 'I3'].forEach((n, i) => mux.pin(String(1 + i), n, [-20, 20 - 10 * i], 2, 10, NAMED));
  mux.pin('5', 'S0', [-20, -30], 2, 10, NAMED).pin('6', 'S1', [-20, -40], 2, 10, NAMED).pin('7', 'Q', [20, 20], 0, 10, NAMED);
  mux.designator('U?', [-20, 33]).param('Comment', 'Multiplexer', [-20, -61], true);
  block(mux, 'MUX4', 7, LEVEL);
  const REF: [string, string, string][] = [...LEVEL, ['VREF', 'Reference', '5']];
  const dac = S('DAC4', 'Digital-to-analogue converter: four bits in, the reference times their number over sixteen out').rect([-20, -20], [20, 30]);
  ['D0', 'D1', 'D2', 'D3'].forEach((n, i) => dac.pin(String(1 + i), n, [-20, 20 - 10 * i], 2, 10, NAMED));
  dac.pin('5', 'OUT', [20, 20], 0, 10, NAMED).designator('U?', [-20, 33]).param('Comment', 'DAC', [-20, -31], true);
  block(dac, 'DAC4', 5, REF);
  const adc = S('ADC4', 'Analogue-to-digital converter: a voltage in, its number of sixteenths of the reference out as four bits').rect([-20, -20], [20, 30]);
  adc.pin('1', 'IN', [-20, 20], 2, 10, NAMED);
  ['D0', 'D1', 'D2', 'D3'].forEach((n, i) => adc.pin(String(2 + i), n, [20, 20 - 10 * i], 0, 10, NAMED));
  adc.designator('U?', [-20, 33]).param('Comment', 'ADC', [-20, -31], true);
  block(adc, 'ADC4', 5, REF);
  const display = S('DISPLAY7', 'Seven-segment display, common cathode (its segments light in Live Simulation)').rect([-20, -40], [30, 40]);
  for (const [a, b] of SEG7_LINES) display.line(a, b);
  [...'abcdefg'].forEach((n, i) => display.pin(String(1 + i), n, [-20, 30 - 10 * i], 2, 10, NAMED));
  display.pin('8', 'K', [0, -40], 3, 10, HIDE).designator('DS?', [-20, 43]).hiddenComment('DISPLAY7', [8, -51]).param('Colour', 'Red', [8, -61]);
  display.sim({ name: 'DISPLAY7', description: 'Seven-segment display', kind: 'General', subKind: 'Seven-Segment Display', prefix: 'X', netlist: sub(8, [['VF', 'Forward Voltage'], ['IF', 'At Current'], ['RS', 'Series Resistance']]),
    file: { entity: 'DISPLAY7', kind: 'CKT' }, params: [['Forward Voltage', '1.8'], ['At Current', '10m'], ['Series Resistance', '220']] });

  // A fuse, a thyristor and a TRIAC
  const fuse = S('FUSE', 'Fuse: open for good once the current through it passes its rating (a click replaces it in Live Simulation)').rect([-3, -9], [3, 9]).line([0, -9], [0, 9]);
  two(fuse, 9, -9).designator('F?', [8, 4]).hiddenComment('FUSE', [8, -6]);
  fuse.sim({ name: 'FUSE', description: 'Fuse', kind: 'General', subKind: 'Fuse', prefix: 'X', netlist: sub(2, [['RATING', 'Rating'], ['R', 'Resistance']]), file: { entity: 'FUSE', kind: 'CKT' }, params: [['Rating', '1'], ['Resistance', '10m']] });
  // …and one that takes its time: the fuse's box with its wire in a wave
  const slow = S('FUSE_SLOW', 'Slow-blow fuse: open for good once a current over its rating has heated it through (a click replaces it in Live Simulation)').rect([-3, -9], [3, 9]).polyline([[0, -9], [2, -5], [-2, 0], [2, 5], [0, 9]]);
  two(slow, 9, -9).designator('F?', [8, 4]).hiddenComment('FUSE_SLOW', [8, -6]);
  slow.sim({ name: 'FUSE_SLOW', description: 'Slow-blow fuse', kind: 'General', subKind: 'Fuse', prefix: 'X', netlist: sub(2, [['RATING', 'Rating'], ['R', 'Resistance'], ['TAU', 'Heats In']]), file: { entity: 'FUSE_SLOW', kind: 'CKT' },
    params: [['Rating', '1'], ['Resistance', '10m'], ['Heats In', '1']] });
  // A DIAC: the TRIAC's two triangles with no gate
  const diac = S('DIAC', 'DIAC: blocks either way until the voltage across it passes its breakover voltage').polygon([[-8, 4], [0, 4], [-4, -4]]).polygon([[0, -4], [8, -4], [4, 4]]).line([-8, 4], [8, 4], 1, 2).line([-8, -4], [8, -4], 1, 2);
  two(diac, 4, -4).designator('D?', [12, 4]).hiddenComment('DIAC', [12, -6]);
  block(diac, 'DIAC', 2, [['VBO', 'Breakover Voltage', '32'], ['DV', 'Breakback Voltage', '8'], ['IH', 'Holding Current', '1m']]);
  const thyristor = (libRef: string, description: string, triac: boolean) => {
    const s = S(libRef, description);
    if (triac) s.polygon([[-8, 4], [0, 4], [-4, -4]]).polygon([[0, -4], [8, -4], [4, 4]]).line([-8, 4], [8, 4], 1, 2).line([-8, -4], [8, -4], 1, 2);
    else s.polygon([[-6, 4], [6, 4], [0, -4]]).line([-6, -4], [6, -4], 1, 2);
    s.line([-4, -4], [-10, -10]);
    two(s, 4, -4).pin('3', 'G', [-10, -10], 2, 10, HIDE).designator(triac ? 'TR?' : 'SCR?', [12, 4]).hiddenComment(libRef, [12, -6]);
    block(s, libRef, 3, [['IGT', 'Gate Trigger Current', '5m'], ['IH', 'Holding Current', '5m']]);
  };
  thyristor('SCR', 'Thyristor (SCR): turned on by its gate, on until its current falls below the holding current', false);
  thyristor('TRIAC', 'TRIAC: a thyristor for either way round', true);

  // A speaker: a resistance of its impedance between its two terminals; the voltage across it is played through the computer's sound in Live Simulation
  const speaker = S('SPEAKER', 'Speaker: the voltage across it played as sound in Live Simulation').rect([-3, -5], [3, 5]).polygon([[3, 5], [10, 12], [10, -12], [3, -5]], 1, false);
  two(speaker, 5, -5).designator('LS?', [14, 4]).hiddenComment('SPEAKER', [14, -6])
    .sim({ name: 'SPEAKER', description: 'Speaker', kind: 'General', subKind: 'Speaker', prefix: 'R', netlist: '@DESIGNATOR %1 %2 @IMPEDANCE', params: [['Impedance', '8'], ['Full Scale', '5'], ['Plays', '0.5']] });
  return out;
}

/* ─── Sources ────────────────────────────────────────────────────────────────────────── */

export function kitSourceSymbols(): SimSymbolBuilder[] {
  const out: SimSymbolBuilder[] = [];
  const wave = (libRef: string, description: string, glyph: XY[], shown: string, netlist: string, params: [string, string][], prefix = 'V') => {
    const s = new SimSymbolBuilder(libRef, description).circle([0, 0], 10).polyline(glyph);
    two(s, 10, -10).line([-7, 14], [-3, 14]).line([-5, 12], [-5, 16]).designator('V?', [14, 4]).param('Comment', `=${shown}`, [14, -6], true);
    const own = params.find(([n]) => n === shown)!;
    s.param(shown, own[1], [14, -6]);
    s.sim({ name: libRef, description, kind: 'Voltage Source', subKind: 'Waveform', prefix, netlist, params: params.map(([n, v]): [string, string] => [n, n === shown ? '*' : v]) });
    out.push(s);
  };
  const F = '(@FREQUENCY)', LO = '{(@OFFSET)-(@AMPLITUDE)}', HI = '{(@OFFSET)+(@AMPLITUDE)}', TD = `{(@PHASE)/360/${F}}`, AC = ' AC @"AC MAGNITUDE"';
  const AOFP: [string, string][] = [['Amplitude', '1'], ['Offset', '0'], ['Frequency', '1k'], ['Phase', '0']];
  wave('VSQUARE', 'Square wave voltage source', [[-7, -4], [-7, 4], [0, 4], [0, -4], [7, -4], [7, 4]], 'Frequency',
    `@DESIGNATOR %1 %2 PULSE(${LO} ${HI} ${TD} {1m/${F}} {1m/${F}} {(@"DUTY CYCLE")/100/${F}-1m/${F}} {1/${F}})${AC}`, [...AOFP, ['Duty Cycle', '50'], ['AC Magnitude', '1']]);
  wave('VTRIANGLE', 'Triangle wave voltage source', [[-7, -4], [-3.5, 4], [0, -4], [3.5, 4], [7, -4]], 'Frequency',
    `@DESIGNATOR %1 %2 PULSE(${LO} ${HI} ${TD} {0.4999/${F}} {0.4999/${F}} {0.0001/${F}} {1/${F}})${AC}`, [...AOFP, ['AC Magnitude', '1']]);
  wave('VSAW', 'Sawtooth voltage source', [[-7, -4], [0, 4], [0, -4], [7, 4], [7, -4]], 'Frequency',
    `@DESIGNATOR %1 %2 PULSE(${LO} ${HI} ${TD} {0.998/${F}} {0.001/${F}} {0.0005/${F}} {1/${F}})${AC}`, [...AOFP, ['AC Magnitude', '1']]);
  wave('VAM', 'Amplitude-modulated voltage source', [[-7, 0], [-6, 1.5], [-5, 0], [-4, -3], [-3, 0], [-2, 5], [-1, 0], [0, -6], [1, 0], [2, 5], [3, 0], [4, -3], [5, 0], [6, 1.5], [7, 0]], 'Carrier Frequency',
    '@DESIGNATOR %1 %2 AM({(@AMPLITUDE)*(@DEPTH)/100} {100/(@DEPTH)} @"SIGNAL FREQUENCY" @"CARRIER FREQUENCY" 0)', [['Amplitude', '1'], ['Carrier Frequency', '10k'], ['Signal Frequency', '1k'], ['Depth', '50']]);
  const T = '(@"SWEEP TIME")', tt = `(time-floor(time/${T})*${T})`;
  wave('VSWEEP', 'Swept sine voltage source (from the start frequency to the end frequency, again and again)', [[-7, 0], [-5.5, 4], [-3.5, -4], [-2, 4], [-0.7, -4], [0.5, 4], [1.6, -4], [2.6, 4], [3.5, -4], [4.3, 4], [5, -4], [5.7, 4], [6.3, -4], [7, 0]], 'End Frequency',
    `@DESIGNATOR %1 %2 V={(@AMPLITUDE)*sin(2*pi*((@"START FREQUENCY")+((@"END FREQUENCY")-(@"START FREQUENCY"))*${tt}/${T}/2)*${tt})}`, [['Amplitude', '1'], ['Start Frequency', '100'], ['End Frequency', '10k'], ['Sweep Time', '10m']], 'B');

  wave('VNOISE', 'Noise voltage source (as much below its bandwidth as it is given, little above; the same noise every run)', [[-7, 1], [-6, -3], [-5, 4], [-4, -1], [-3, 2], [-2, -4], [-1, 3], [0, -2], [1, 4], [2, 0], [3, -3], [4, 2], [5, -4], [6, 3], [7, -1]], 'Amplitude',
    '@DESIGNATOR %1 %2 V={(@OFFSET)+(@AMPLITUDE)*noise(time*(@BANDWIDTH))}', [['Amplitude', '1'], ['Offset', '0'], ['Bandwidth', '10k']], 'B');

  // One-pin sources: their other end is the reference (0 V)
  const rail = (libRef: string, description: string, glyph: (s: SimSymbolBuilder) => void, shown: string, netlist: string, params: [string, string][]) => {
    const s = new SimSymbolBuilder(libRef, description);
    glyph(s);
    s.pin('1', '1', [0, 0], 3, 10, HIDE).designator('V?', [8, 10]).param('Comment', `=${shown}`, [8, 0], true).param(shown, params.find(([n]) => n === shown)![1], [8, 0]);
    s.sim({ name: libRef, description, kind: 'Voltage Source', subKind: 'Waveform', prefix: 'V', netlist, params: params.map(([n, v]): [string, string] => [n, n === shown ? '*' : v]) });
    out.push(s);
  };
  rail('RAIL_DC', 'Voltage rail: a DC voltage against 0 V on one pin', (s) => s.line([-6, 0], [6, 0], 1, 2).line([-2, 4], [2, 4]).line([0, 2], [0, 6]), 'Value', '@DESIGNATOR %1 0 DC @VALUE', [['Value', '5']]);
  rail('RAIL_SIN', 'Signal rail: a sine against 0 V on one pin', (s) => s.circle([0, 7], 7).polyline([[-5, 7], [-3.8, 9.5], [-2.5, 10.5], [-1.2, 9.5], [0, 7], [1.2, 4.5], [2.5, 3.5], [3.8, 4.5], [5, 7]]), 'Frequency',
    `@DESIGNATOR %1 0 SIN(@OFFSET @AMPLITUDE @FREQUENCY 0 0 @PHASE)${AC}`, [...AOFP, ['AC Magnitude', '1']]);
  rail('RAIL_CLOCK', 'Clock: a square wave between 0 V and its voltage on one pin', (s) => s.circle([0, 7], 7).polyline([[-5, 4], [-5, 10], [0, 10], [0, 4], [5, 4], [5, 10]]), 'Frequency',
    `@DESIGNATOR %1 0 PULSE(0 @VOLTAGE 0 {1m/${F}} {1m/${F}} {(@"DUTY CYCLE")/100/${F}-1m/${F}} {1/${F}})`, [['Voltage', '5'], ['Frequency', '1k'], ['Duty Cycle', '50']]);
  return out;
}
