/**
 * Live Simulation's palette: the parts a sketch is made of, by kind, each with the key that places
 * it and the values the panel offers to change. The parts themselves are in Konium Designer's
 * simulation libraries (src/formats/synthetic/simLib.ts and simKit.ts).
 */
import { RATINGS, RATING_PARAMS, RATING_UNITS } from '../sim/liveStress';

export const KIT_GROUPS = ['Passive', 'Diodes and thyristors', 'Transistors', 'Amplifiers and blocks', 'Logic and chips', 'Sources', 'Instruments and outputs'] as const;
export type KitGroup = (typeof KIT_GROUPS)[number];

export interface KitField {
  /** The parameter's name on the part (its simulation model's, or the part's own). */
  param: string;
  /** Its name in the panel. */
  label: string;
  unit: string;
  /** A slider under its box that turns it from a tenth to ten times. */
  turn?: boolean;
  /** A slider from the one figure to the other (a position, a duty cycle). */
  range?: [number, number];
  /** One of these, in a list. */
  choices?: string[];
}
export interface KitPart {
  id: string;
  /** Its name (the tile's tooltip and the name a screen reader gives it). */
  label: string;
  /** Its name under its tile, where the whole name is too long for one. */
  caption?: string;
  group: KitGroup;
  lib: 'parts' | 'sources';
  libRef: string;
  /** Its designator's letters: R1, R2 … */
  prefix: string;
  hint: string;
  /** The key that places it while the sheet runs (a capital: with Shift). */
  key?: string;
  fields: KitField[];
}

const f = (param: string, label: string, unit: string, extra: Partial<KitField> = {}): KitField => ({ param, label, unit, ...extra });
const T = { turn: true };
const SCOPES = ['None', '1', '2', '3', '4', '5', '6'];
const SHOWS = ['Value', 'Mean', 'RMS', 'Peak to peak'];
const CONTACT = [f('On Resistance', 'Closed', 'Ω'), f('Off Resistance', 'Open', 'Ω')];
const WAVE = (u: string) => [f('Amplitude', 'Amplitude', u, T), f('Offset', 'Offset', u, T), f('Frequency', 'Frequency', 'Hz', T), f('Phase', 'Phase', '°')];
const DUTY = f('Duty Cycle', 'Duty cycle', '%', { range: [1, 99] });
const METER = [f('Shows', 'Shows', '', { choices: SHOWS }), f('On Scope', 'On scope', '', { choices: SCOPES })];
const LOGIC = [f('High Level', 'High level', 'V')];
const THYRISTOR = [f('Gate Trigger Current', 'Gate trigger', 'A', T), f('Holding Current', 'Holding', 'A', T)];
const DIODE = [f('At Current', 'At', 'A'), f('Series Resistance', 'Series resistance', 'Ω')];

export const KIT: KitPart[] = [
  // Passive
  { id: 'res', label: 'Resistor', group: 'Passive', lib: 'parts', libRef: 'RES', prefix: 'R', key: 'r', hint: 'Resistor', fields: [f('Value', 'Resistance', 'Ω', T)] },
  { id: 'cap', label: 'Capacitor', group: 'Passive', lib: 'parts', libRef: 'CAP', prefix: 'C', key: 'c', hint: 'Capacitor', fields: [f('Value', 'Capacitance', 'F', T), f('Initial Voltage', 'Starts at', 'V')] },
  { id: 'capPol', label: 'Polarised capacitor', caption: 'Polarised', group: 'Passive', lib: 'parts', libRef: 'CAP_POL', prefix: 'C', key: 'C', hint: 'Polarised capacitor (an electrolytic or a tantalum one): its positive side is marked +. A voltage the wrong way round is flagged while the sheet runs', fields: [f('Value', 'Capacitance', 'F', T), f('Initial Voltage', 'Starts at', 'V')] },
  { id: 'ind', label: 'Inductor', group: 'Passive', lib: 'parts', libRef: 'IND', prefix: 'L', key: 'L', hint: 'Inductor', fields: [f('Value', 'Inductance', 'H', T), f('Initial Current', 'Starts at', 'A')] },
  { id: 'pot', label: 'Potentiometer', caption: 'Pot', group: 'Passive', lib: 'parts', libRef: 'POT', prefix: 'RV', hint: 'Potentiometer: its wiper is set by Position in the panel', fields: [f('Resistance', 'Resistance', 'Ω', T), f('Position', 'Position', '%', { range: [0, 100] })] },
  { id: 'switch', label: 'Switch', group: 'Passive', lib: 'parts', libRef: 'SWITCH', prefix: 'SW', key: 's', hint: 'Switch: a click opens or closes it while the sheet runs', fields: CONTACT },
  { id: 'spdt', label: 'Changeover switch', caption: 'Ch-over', group: 'Passive', lib: 'parts', libRef: 'SWITCH_SPDT', prefix: 'SW', key: 'S', hint: 'Changeover switch: a click throws it while the sheet runs', fields: CONTACT },
  { id: 'push', label: 'Push button', caption: 'Button', group: 'Passive', lib: 'parts', libRef: 'PUSHBUTTON', prefix: 'SW', key: 'b', hint: 'Push button: closed while it is pressed', fields: CONTACT },
  { id: 'transformer', label: 'Transformer', caption: 'Transf.', group: 'Passive', lib: 'parts', libRef: 'TRANSFORMER', prefix: 'T', key: 'T', hint: 'Transformer: two coupled windings',
    fields: [f('Primary Inductance', 'Primary', 'H', T), f('Ratio', 'Turns ratio', ''), f('Coupling', 'Coupling', '')] },
  { id: 'relay', label: 'Relay', group: 'Passive', lib: 'parts', libRef: 'RELAY', prefix: 'K', key: 'R', hint: 'Relay: its contact closes when the coil\'s current reaches the pull-in current',
    fields: [f('Coil Resistance', 'Coil resistance', 'Ω'), f('Coil Inductance', 'Coil inductance', 'H'), f('Pull-In Current', 'Pulls in at', 'A'), f('Drop-Out Current', 'Drops out at', 'A'), f('On Resistance', 'Closed', 'Ω'), f('Off Resistance', 'Open', 'Ω')] },
  { id: 'xtal', label: 'Crystal', group: 'Passive', lib: 'parts', libRef: 'XTAL', prefix: 'Y', hint: 'Crystal',
    fields: [f('Frequency', 'Frequency', 'Hz', T), f('Series Capacitance', 'Series capacitance', 'F'), f('Series Resistance', 'Series resistance', 'Ω'), f('Parallel Capacitance', 'Across it', 'F')] },
  { id: 'fuse', label: 'Fuse', group: 'Passive', lib: 'parts', libRef: 'FUSE', prefix: 'F', key: 'u', hint: 'Fuse: open for good once its current passes its rating; a click on it replaces it while the sheet runs', fields: [f('Rating', 'Blows at', 'A', T), f('Resistance', 'Resistance', 'Ω')] },
  { id: 'fuseSlow', label: 'Slow-blow fuse', caption: 'Slow fuse', group: 'Passive', lib: 'parts', libRef: 'FUSE_SLOW', prefix: 'F', hint: 'Slow-blow fuse: open for good once a current over its rating has heated it through; a click on it replaces it while the sheet runs',
    fields: [f('Rating', 'Rating', 'A', T), f('Resistance', 'Resistance', 'Ω'), f('Heats In', 'Heats in', 's', T)] },
  // Diodes
  { id: 'diode', label: 'Diode', group: 'Diodes and thyristors', lib: 'parts', libRef: 'DIODE_VF', prefix: 'D', key: 'd', hint: 'Diode: its forward voltage is set in the panel', fields: [f('Forward Voltage', 'Forward voltage', 'V', T), ...DIODE, f('Breakdown Voltage', 'Breaks down at', 'V')] },
  { id: 'schottky', label: 'Schottky diode', caption: 'Schottky', group: 'Diodes and thyristors', lib: 'parts', libRef: 'SCHOTTKY', prefix: 'D', hint: 'Schottky diode: a low forward voltage, set in the panel', fields: [f('Forward Voltage', 'Forward voltage', 'V', T), ...DIODE, f('Breakdown Voltage', 'Breaks down at', 'V')] },
  { id: 'zener', label: 'Zener diode', caption: 'Zener', group: 'Diodes and thyristors', lib: 'parts', libRef: 'ZENER', prefix: 'D', key: 'z', hint: 'Zener diode: its Zener voltage is set in the panel', fields: [f('Zener Voltage', 'Zener voltage', 'V', T), f('Forward Voltage', 'Forward voltage', 'V'), ...DIODE] },
  { id: 'led', label: 'LED', group: 'Diodes and thyristors', lib: 'parts', libRef: 'LED_VF', prefix: 'LED', key: 'l', hint: 'LED: it lights by its current while the sheet runs; its forward voltage and colour are set in the panel',
    fields: [f('Forward Voltage', 'Forward voltage', 'V', T), f('At Current', 'Full brightness at', 'A'), f('Colour', 'Colour', '', { choices: ['Red', 'Green', 'Yellow', 'Blue', 'White'] }), f('Series Resistance', 'Series resistance', 'Ω')] },
  { id: 'scr', label: 'Thyristor (SCR)', caption: 'SCR', group: 'Diodes and thyristors', lib: 'parts', libRef: 'SCR', prefix: 'SCR', hint: 'Thyristor: turned on by its gate, on until its current falls below the holding current', fields: THYRISTOR },
  { id: 'triac', label: 'TRIAC', group: 'Diodes and thyristors', lib: 'parts', libRef: 'TRIAC', prefix: 'TR', hint: 'TRIAC: a thyristor for either way round', fields: THYRISTOR },
  { id: 'diac', label: 'DIAC', group: 'Diodes and thyristors', lib: 'parts', libRef: 'DIAC', prefix: 'D', hint: 'DIAC: blocks either way until the voltage across it passes its breakover voltage, then conducts with less across it',
    fields: [f('Breakover Voltage', 'Breaks over at', 'V', T), f('Breakback Voltage', 'Falls back by', 'V'), f('Holding Current', 'Holding', 'A', T)] },
  // Transistors
  { id: 'npn', label: 'NPN transistor', caption: 'NPN', group: 'Transistors', lib: 'parts', libRef: 'NPN_BETA', prefix: 'Q', key: 'n', hint: 'NPN transistor: its beta is set in the panel', fields: [f('Beta', 'Beta (hFE)', '', T), f('Early Voltage', 'Early voltage', 'V')] },
  { id: 'pnp', label: 'PNP transistor', caption: 'PNP', group: 'Transistors', lib: 'parts', libRef: 'PNP_BETA', prefix: 'Q', key: 'p', hint: 'PNP transistor: its beta is set in the panel', fields: [f('Beta', 'Beta (hFE)', '', T), f('Early Voltage', 'Early voltage', 'V')] },
  { id: 'nmos', label: 'N-channel MOSFET', caption: 'N-MOS', group: 'Transistors', lib: 'parts', libRef: 'NMOS_VT', prefix: 'Q', key: 'N', hint: 'N-channel MOSFET: its threshold voltage and beta are set in the panel', fields: [f('Threshold Voltage', 'Threshold', 'V', T), f('Beta', 'Beta', 'A/V²', T)] },
  { id: 'pmos', label: 'P-channel MOSFET', caption: 'P-MOS', group: 'Transistors', lib: 'parts', libRef: 'PMOS_VT', prefix: 'Q', key: 'P', hint: 'P-channel MOSFET: its threshold voltage and beta are set in the panel', fields: [f('Threshold Voltage', 'Threshold', 'V', T), f('Beta', 'Beta', 'A/V²', T)] },
  { id: 'njfet', label: 'N-channel JFET', caption: 'N-JFET', group: 'Transistors', lib: 'parts', libRef: 'NJFET', prefix: 'Q', hint: 'N-channel JFET: its pinch-off voltage and saturation current are set in the panel', fields: [f('Pinch-Off Voltage', 'Pinch-off', 'V', T), f('Saturation Current', 'IDSS', 'A', T)] },
  { id: 'pjfet', label: 'P-channel JFET', caption: 'P-JFET', group: 'Transistors', lib: 'parts', libRef: 'PJFET', prefix: 'Q', hint: 'P-channel JFET: its pinch-off voltage and saturation current are set in the panel', fields: [f('Pinch-Off Voltage', 'Pinch-off', 'V', T), f('Saturation Current', 'IDSS', 'A', T)] },
  { id: 'darlington', label: 'Darlington pair', caption: 'Darl.', group: 'Transistors', lib: 'parts', libRef: 'DARLINGTON', prefix: 'Q', hint: 'Darlington pair (NPN): its beta is set in the panel', fields: [f('Beta', 'Beta', '', T)] },
  // Amplifiers and blocks
  { id: 'opamp', label: 'Op-amp', group: 'Amplifiers and blocks', lib: 'parts', libRef: 'OPAMP_IDEAL', prefix: 'U', key: 'a', hint: 'Op-amp with no supply pins to wire: its gain and how far its output swings are set in the panel',
    fields: [f('Gain', 'Gain', ''), f('Max Output', 'Output up to', 'V'), f('Min Output', 'Output down to', 'V'), f('Gain-Bandwidth', 'Gain-bandwidth', 'Hz')] },
  { id: 'opamp5', label: 'Op-amp with supplies', caption: 'Supplied', group: 'Amplifiers and blocks', lib: 'parts', libRef: 'OPAMP', prefix: 'U', key: 'A', hint: 'Op-amp with its supply pins: it swings to within 1.2 V of them', fields: [] },
  { id: 'comparator', label: 'Comparator', caption: 'Compar.', group: 'Amplifiers and blocks', lib: 'parts', libRef: 'COMPARATOR', prefix: 'U', hint: 'Comparator: its output is high when + is above -', fields: [f('High Output', 'High output', 'V'), f('Low Output', 'Low output', 'V')] },
  { id: 'aswitch', label: 'Analogue switch', caption: 'An. sw.', group: 'Amplifiers and blocks', lib: 'parts', libRef: 'ANALOG_SWITCH', prefix: 'S', hint: 'Analogue switch: closed while its control is above the threshold',
    fields: [f('Threshold', 'Threshold', 'V', T), f('On Resistance', 'Closed', 'Ω'), f('Off Resistance', 'Open', 'Ω')] },
  { id: 'vcvs', label: 'Voltage-controlled voltage source', caption: 'VCVS', group: 'Amplifiers and blocks', lib: 'parts', libRef: 'VCVS', prefix: 'E', hint: 'Voltage-controlled voltage source: its output is Gain times the voltage between its inputs', fields: [f('Gain', 'Gain', '', T)] },
  { id: 'vccs', label: 'Voltage-controlled current source', caption: 'VCCS', group: 'Amplifiers and blocks', lib: 'parts', libRef: 'VCCS', prefix: 'G', hint: 'Voltage-controlled current source: its current is Gain times the voltage between its inputs', fields: [f('Gain', 'Gain', 'S', T)] },
  { id: 'ccvs', label: 'Current-controlled voltage source', caption: 'CCVS', group: 'Amplifiers and blocks', lib: 'parts', libRef: 'CCVS', prefix: 'H', hint: 'Current-controlled voltage source: its output is Gain times the current through its inputs', fields: [f('Gain', 'Gain', 'Ω', T)] },
  { id: 'cccs', label: 'Current-controlled current source', caption: 'CCCS', group: 'Amplifiers and blocks', lib: 'parts', libRef: 'CCCS', prefix: 'F', hint: 'Current-controlled current source: its current is Gain times the current through its inputs', fields: [f('Gain', 'Gain', '', T)] },
  // Logic and chips
  { id: 'logicIn', label: 'Logic input', caption: 'Input', group: 'Logic and chips', lib: 'parts', libRef: 'LOGIC_IN', prefix: 'IN', key: 'h', hint: 'Logic input: a click changes it between low and high while the sheet runs', fields: [f('High Level', 'High level', 'V', T)] },
  { id: 'not', label: 'Inverter', caption: 'NOT', group: 'Logic and chips', lib: 'parts', libRef: 'NOT', prefix: 'U', hint: 'Inverter (NOT gate)', fields: LOGIC },
  { id: 'and', label: 'AND gate', caption: 'AND', group: 'Logic and chips', lib: 'parts', libRef: 'AND', prefix: 'U', hint: 'AND gate', fields: LOGIC },
  { id: 'nand', label: 'NAND gate', caption: 'NAND', group: 'Logic and chips', lib: 'parts', libRef: 'NAND', prefix: 'U', hint: 'NAND gate', fields: LOGIC },
  { id: 'or', label: 'OR gate', caption: 'OR', group: 'Logic and chips', lib: 'parts', libRef: 'OR', prefix: 'U', hint: 'OR gate', fields: LOGIC },
  { id: 'nor', label: 'NOR gate', caption: 'NOR', group: 'Logic and chips', lib: 'parts', libRef: 'NOR', prefix: 'U', hint: 'NOR gate', fields: LOGIC },
  { id: 'xor', label: 'Exclusive-OR gate', caption: 'XOR', group: 'Logic and chips', lib: 'parts', libRef: 'XOR', prefix: 'U', hint: 'Exclusive-OR gate', fields: LOGIC },
  { id: 'schmitt', label: 'Schmitt-trigger inverter', caption: 'Schmitt', group: 'Logic and chips', lib: 'parts', libRef: 'SCHMITT_NOT', prefix: 'U', hint: 'Schmitt-trigger inverter: its two thresholds are set in the panel',
    fields: [...LOGIC, f('Upper Threshold', 'Upper threshold', 'V', T), f('Lower Threshold', 'Lower threshold', 'V', T)] },
  { id: 'timer', label: '555 timer', caption: '555', group: 'Logic and chips', lib: 'parts', libRef: 'NE555', prefix: 'U', hint: '555 timer', fields: [] },
  { id: 'regulator', label: 'Voltage regulator', caption: 'Regulator', group: 'Logic and chips', lib: 'parts', libRef: 'REGULATOR', prefix: 'U', hint: 'Voltage regulator: its output voltage and dropout are set in the panel',
    fields: [f('Output Voltage', 'Output', 'V', T), f('Dropout', 'Dropout', 'V')] },
  { id: 'opto', label: 'Optocoupler', caption: 'Opto', group: 'Logic and chips', lib: 'parts', libRef: 'OPTO', prefix: 'U', hint: 'Optocoupler: an LED and the transistor its light turns on', fields: [f('Transfer Ratio', 'Transfer ratio', '%', T), f('Forward Voltage', 'Forward voltage', 'V')] },
  { id: 'dff', label: 'D flip-flop', caption: 'D flop', group: 'Logic and chips', lib: 'parts', libRef: 'DFF', prefix: 'U', key: 'e', hint: 'D flip-flop: Q takes what D is as the clock rises', fields: LOGIC },
  { id: 'jkff', label: 'JK flip-flop', caption: 'JK flop', group: 'Logic and chips', lib: 'parts', libRef: 'JKFF', prefix: 'U', key: 'j', hint: 'JK flip-flop: as the clock rises J sets it, K clears it, both turn it over', fields: LOGIC },
  { id: 'tff', label: 'T flip-flop', caption: 'T flop', group: 'Logic and chips', lib: 'parts', libRef: 'TFF', prefix: 'U', hint: 'T flip-flop: Q turns over as the clock rises while T is high', fields: LOGIC },
  { id: 'counter', label: 'Counter', group: 'Logic and chips', lib: 'parts', libRef: 'COUNTER', prefix: 'U', key: 'k', hint: 'Four-bit counter: counts up as the clock rises, to its modulus less one and round again; RST high clears it',
    fields: [...LOGIC, f('Modulus', 'Modulus', '', { choices: Array.from({ length: 15 }, (_, i) => String(i + 2)) })] },
  { id: 'decoder7', label: 'Seven-segment decoder', caption: 'Decoder', group: 'Logic and chips', lib: 'parts', libRef: 'DECODER7', prefix: 'U', hint: 'Seven-segment decoder: a four-bit number in, the segments of its digit out', fields: LOGIC },
  { id: 'shift', label: 'Shift register', caption: 'Shift reg', group: 'Logic and chips', lib: 'parts', libRef: 'SHIFT', prefix: 'U', hint: 'Four-bit shift register: as the clock rises Q0 takes what D is and each other bit what the one before it was; RST high clears it', fields: LOGIC },
  { id: 'ring', label: 'Ring counter', caption: 'Ring', group: 'Logic and chips', lib: 'parts', libRef: 'RING', prefix: 'U', hint: 'Ring counter: one of its outputs high at a time, the next as the clock rises; RST high goes back to Q0',
    fields: [...LOGIC, f('Stages', 'Stages', '', { choices: ['2', '3', '4', '5', '6', '7', '8', '9', '10'] })] },
  { id: 'mux', label: 'Multiplexer', caption: 'Mux', group: 'Logic and chips', lib: 'parts', libRef: 'MUX4', prefix: 'U', hint: 'Multiplexer: its output is the one of its four inputs that S1 and S0 name', fields: LOGIC },
  { id: 'dac', label: 'Digital-to-analogue converter', caption: 'DAC', group: 'Logic and chips', lib: 'parts', libRef: 'DAC4', prefix: 'U', hint: 'Digital-to-analogue converter: four bits in, the reference times their number over sixteen out', fields: [...LOGIC, f('Reference', 'Reference', 'V', T)] },
  { id: 'adc', label: 'Analogue-to-digital converter', caption: 'ADC', group: 'Logic and chips', lib: 'parts', libRef: 'ADC4', prefix: 'U', hint: 'Analogue-to-digital converter: a voltage in, its number of sixteenths of the reference out as four bits', fields: [...LOGIC, f('Reference', 'Reference', 'V', T)] },
  // Sources
  { id: 'vdc', label: 'DC voltage source', caption: 'DC', group: 'Sources', lib: 'sources', libRef: 'VSRC', prefix: 'V', key: 'v', hint: 'DC voltage source', fields: [f('Value', 'Voltage', 'V', T)] },
  { id: 'vsin', label: 'Sine source', caption: 'Sine', group: 'Sources', lib: 'sources', libRef: 'VSIN', prefix: 'V', key: 'f', hint: 'Sine voltage source: amplitude, offset, frequency and phase are set in the panel', fields: [...WAVE('V'), f('Delay', 'Delay', 's'), f('Damping Factor', 'Damping', '1/s')] },
  { id: 'vsquare', label: 'Square wave source', caption: 'Square', group: 'Sources', lib: 'sources', libRef: 'VSQUARE', prefix: 'V', key: 'q', hint: 'Square wave voltage source: amplitude, offset, frequency, phase and duty cycle are set in the panel', fields: [...WAVE('V'), DUTY] },
  { id: 'vtri', label: 'Triangle wave source', caption: 'Triangle', group: 'Sources', lib: 'sources', libRef: 'VTRIANGLE', prefix: 'V', hint: 'Triangle wave voltage source', fields: WAVE('V') },
  { id: 'vsaw', label: 'Sawtooth source', caption: 'Sawtooth', group: 'Sources', lib: 'sources', libRef: 'VSAW', prefix: 'V', hint: 'Sawtooth voltage source', fields: WAVE('V') },
  { id: 'vpulse', label: 'Pulse source', caption: 'Pulse', group: 'Sources', lib: 'sources', libRef: 'VPULSE', prefix: 'V', hint: 'Pulse voltage source: its two levels and every one of its times are set in the panel',
    fields: [f('Initial Value', 'Low', 'V', T), f('Pulsed Value', 'High', 'V', T), f('Period', 'Period', 's', T), f('Pulse Width', 'Width', 's', T), f('Time Delay', 'Delay', 's'), f('Rise Time', 'Rise', 's'), f('Fall Time', 'Fall', 's')] },
  { id: 'vam', label: 'AM source', caption: 'AM', group: 'Sources', lib: 'sources', libRef: 'VAM', prefix: 'V', hint: 'Amplitude-modulated voltage source',
    fields: [f('Amplitude', 'Amplitude', 'V', T), f('Carrier Frequency', 'Carrier', 'Hz', T), f('Signal Frequency', 'Signal', 'Hz', T), f('Depth', 'Depth', '%', { range: [1, 100] })] },
  { id: 'vfm', label: 'FM source', caption: 'FM', group: 'Sources', lib: 'sources', libRef: 'VSFFM', prefix: 'V', hint: 'Frequency-modulated voltage source',
    fields: [f('Amplitude', 'Amplitude', 'V', T), f('Offset', 'Offset', 'V'), f('Carrier Frequency', 'Carrier', 'Hz', T), f('Signal Frequency', 'Signal', 'Hz', T), f('Modulation Index', 'Index', '')] },
  { id: 'vsweep', label: 'Swept sine source', caption: 'Sweep', group: 'Sources', lib: 'sources', libRef: 'VSWEEP', prefix: 'V', hint: 'Swept sine: from the start frequency to the end frequency, again and again',
    fields: [f('Amplitude', 'Amplitude', 'V', T), f('Start Frequency', 'From', 'Hz', T), f('End Frequency', 'To', 'Hz', T), f('Sweep Time', 'In', 's', T)] },
  { id: 'vnoise', label: 'Noise source', caption: 'Noise', group: 'Sources', lib: 'sources', libRef: 'VNOISE', prefix: 'V', key: 'x', hint: 'Noise: as much below its bandwidth as it is given, little above',
    fields: [f('Amplitude', 'Amplitude', 'V', T), f('Offset', 'Offset', 'V', T), f('Bandwidth', 'Bandwidth', 'Hz', T)] },
  { id: 'idc', label: 'DC current source', caption: 'Current', group: 'Sources', lib: 'sources', libRef: 'ISRC', prefix: 'I', key: 'i', hint: 'DC current source', fields: [f('Value', 'Current', 'A', T)] },
  { id: 'isin', label: 'Sine current source', caption: 'Sine I', group: 'Sources', lib: 'sources', libRef: 'ISIN', prefix: 'I', hint: 'Sine current source', fields: [...WAVE('A'), f('Delay', 'Delay', 's'), f('Damping Factor', 'Damping', '1/s')] },
  { id: 'rail', label: 'Voltage rail', caption: 'Rail', group: 'Sources', lib: 'sources', libRef: 'RAIL_DC', prefix: 'V', key: 'V', hint: 'Voltage rail: a DC voltage against 0 V, on one pin', fields: [f('Value', 'Voltage', 'V', T)] },
  { id: 'railSin', label: 'Signal rail', caption: 'Signal', group: 'Sources', lib: 'sources', libRef: 'RAIL_SIN', prefix: 'V', hint: 'Signal rail: a sine against 0 V, on one pin', fields: WAVE('V') },
  { id: 'clock', label: 'Clock', group: 'Sources', lib: 'sources', libRef: 'RAIL_CLOCK', prefix: 'V', hint: 'Clock: a square wave between 0 V and its voltage, on one pin', fields: [f('Voltage', 'Voltage', 'V', T), f('Frequency', 'Frequency', 'Hz', T), DUTY] },
  // Instruments and outputs
  { id: 'voltmeter', label: 'Voltmeter', caption: 'Voltmeter', group: 'Instruments and outputs', lib: 'parts', libRef: 'VOLTMETER', prefix: 'VM', key: 'm', hint: 'Voltmeter: reads the voltage across it on the sheet; it can feed a scope', fields: [...METER, f('Resistance', 'Its resistance', 'Ω')] },
  { id: 'ammeter', label: 'Ammeter', caption: 'Ammeter', group: 'Instruments and outputs', lib: 'parts', libRef: 'AMMETER', prefix: 'AM', key: 'M', hint: 'Ammeter: reads the current through it on the sheet; it can feed a scope', fields: METER },
  { id: 'testpoint', label: 'Test point', caption: 'Test pt', group: 'Instruments and outputs', lib: 'parts', libRef: 'TESTPOINT', prefix: 'TP', key: 'o', hint: 'Test point: reads its net\'s voltage on the sheet; it can feed a scope', fields: METER },
  { id: 'lamp', label: 'Lamp', group: 'Instruments and outputs', lib: 'parts', libRef: 'LAMP', prefix: 'LA', hint: 'Lamp: it lights by the power in it while the sheet runs', fields: [f('Nominal Voltage', 'Made for', 'V', T), f('Nominal Power', 'Takes', 'W', T)] },
  { id: 'display7', label: 'Seven-segment display', caption: 'Display', group: 'Instruments and outputs', lib: 'parts', libRef: 'DISPLAY7', prefix: 'DS', hint: 'Seven-segment display (common cathode): its segments light while the sheet runs; a logic output drives one as it is',
    fields: [f('Colour', 'Colour', '', { choices: ['Red', 'Green', 'Yellow', 'Blue', 'White'] }), f('Forward Voltage', 'Forward voltage', 'V'), f('At Current', 'Full brightness at', 'A'), f('Series Resistance', 'Series resistance', 'Ω')] },
  { id: 'speaker', label: 'Speaker', group: 'Instruments and outputs', lib: 'parts', libRef: 'SPEAKER', prefix: 'LS', key: 'y', hint: 'Speaker: the voltage across it is played through the computer\'s sound while the sheet runs',
    fields: [f('Impedance', 'Impedance', 'Ω'), f('Full Scale', 'Full volume at', 'V', T), f('Plays', 'Plays at a time', 's')] },
];

// What each is rated for (see liveStress): a field of its own, after the others
for (const k of KIT) { const r = RATINGS[k.libRef]; if (r) k.fields = [...k.fields, f(RATING_PARAMS[r.kind], 'Rated for', RATING_UNITS[r.kind])]; }
const BY_REF = new Map(KIT.map((p) => [p.libRef, p]));
/** The palette's part for a library reference (a part placed from it), or undefined. */
export const kitOf = (libRef: string): KitPart | undefined => BY_REF.get(libRef.toUpperCase());
/** The fields the panel offers for a part of the kit; null for a part the kit doesn't have (its model's own parameters are listed instead). */
export const kitFields = (libRef: string): KitField[] | null => BY_REF.get(libRef.toUpperCase())?.fields ?? null;
/** The key (as the window gives it: "R", "Shift+R") that places each part. */
export const KIT_KEYS = new Map(KIT.filter((p) => p.key).map((p) => [p.key! === p.key!.toUpperCase() && p.key!.toLowerCase() !== p.key! ? `Shift+${p.key!}` : p.key!.toUpperCase(), p.id]));
