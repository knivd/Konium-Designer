/**
 * The Sim Model dialog's choices, as AD17 lists them: each Model Kind's sub-kinds, the Spice
 * Prefix, netlist template and parameters a new model of that sub-kind starts with [est: the
 * parameter lists and defaults].
 */
import { DEFAULT_TEMPLATES } from './simModels';

export interface SubKind { name: string; prefix: string; template: string; params: [name: string, value: string][]; /** Takes a model file (.mdl / .ckt) by its name. */ file?: 'MDL' | 'CKT' }

const SRC = (v: boolean, sub: string, params: [string, string][]): SubKind => ({ name: sub, prefix: v ? 'V' : 'I', template: DEFAULT_TEMPLATES[sub.toLowerCase()] ?? '', params });
const AC: [string, string][] = [['AC Magnitude', '1'], ['AC Phase', '0']];
const sources = (v: boolean): SubKind[] => [
  { name: 'Current-Controlled', prefix: v ? 'H' : 'F', template: DEFAULT_TEMPLATES['current-controlled']!, params: [['Controlling Source', ''], ['Gain', '1']] },
  SRC(v, 'DC Source', [['Value', '*'], ...AC]),
  { name: 'Equation', prefix: 'B', template: v ? DEFAULT_TEMPLATES.equation! : '@DESIGNATOR %1 %2 I=@EQUATION', params: [['Equation', '']] },
  SRC(v, 'Exponential', [['DC Magnitude', '0'], ...AC, ['Initial Value', '0'], ['Pulsed Value', v ? '1' : '1m'], ['Rise Delay Time', '0'], ['Rise Time Constant', '100u'], ['Fall Delay Time', '1m'], ['Fall Time Constant', '100u']]),
  SRC(v, 'Piecewise Linear', [['DC Magnitude', '0'], ...AC, ['Time / Value Pairs', '0 0 1m 1']]),
  SRC(v, 'Pulse', [['DC Magnitude', '0'], ...AC, ['Initial Value', '0'], ['Pulsed Value', v ? '1' : '1m'], ['Time Delay', '0'], ['Rise Time', '1u'], ['Fall Time', '1u'], ['Pulse Width', '0.5m'], ['Period', '1m'], ['Phase Delay', '0']]),
  SRC(v, 'Single-Frequency FM', [['DC Magnitude', '0'], ...AC, ['Offset', '0'], ['Amplitude', v ? '1' : '1m'], ['Carrier Frequency', '100K'], ['Modulation Index', '5'], ['Signal Frequency', '10K']]),
  SRC(v, 'Sinusoidal', [['DC Magnitude', '0'], ...AC, ['Offset', '0'], ['Amplitude', v ? '1' : '1m'], ['Frequency', '1K'], ['Delay', '0'], ['Damping Factor', '0'], ['Phase', '0']]),
  { name: 'Voltage-Controlled', prefix: v ? 'E' : 'G', template: DEFAULT_TEMPLATES['voltage-controlled']!, params: [['Gain', '1']] },
];

export const MODEL_KINDS: Record<string, SubKind[]> = {
  General: [
    { name: 'Capacitor', prefix: 'C', template: DEFAULT_TEMPLATES.capacitor!, params: [['Value', '*'], ['Initial Voltage', '']] },
    { name: 'Capacitor(Semiconductor)', prefix: 'C', template: DEFAULT_TEMPLATES['capacitor(semiconductor)']!, params: [['Value', '*'], ['Length', ''], ['Width', ''], ['Initial Voltage', '']], file: 'MDL' },
    { name: 'Diode', prefix: 'D', template: DEFAULT_TEMPLATES.diode!, params: [['Area', ''], ['Off', ''], ['Initial Voltage', ''], ['Temperature', '']], file: 'MDL' },
    { name: 'Inductor', prefix: 'L', template: DEFAULT_TEMPLATES.inductor!, params: [['Value', '*'], ['Initial Current', '']] },
    { name: 'Resistor', prefix: 'R', template: DEFAULT_TEMPLATES.resistor!, params: [['Value', '*']] },
    { name: 'Resistor(Semiconductor)', prefix: 'R', template: DEFAULT_TEMPLATES['resistor(semiconductor)']!, params: [['Value', '*'], ['Length', ''], ['Width', ''], ['Temperature', '']], file: 'MDL' },
    { name: 'Spice Subcircuit', prefix: 'X', template: DEFAULT_TEMPLATES['spice subcircuit']!, params: [], file: 'CKT' },
  ],
  'Current Source': sources(false),
  'Voltage Source': sources(true),
  'Initial Condition': [
    { name: 'Initial Node Voltage Guess', prefix: '', template: DEFAULT_TEMPLATES['initial node voltage guess']!, params: [['Initial Voltage', '0']] },
    { name: 'Set Initial Condition', prefix: '', template: DEFAULT_TEMPLATES['set initial condition']!, params: [['Initial Voltage', '0']] },
  ],
  Switch: [
    { name: 'Current Controlled Switch', prefix: 'W', template: DEFAULT_TEMPLATES['current controlled switch']!, params: [['Controlling Source', ''], ['Initial State', '']], file: 'MDL' },
    { name: 'Voltage Controlled Switch', prefix: 'S', template: DEFAULT_TEMPLATES['voltage controlled switch']!, params: [['Initial State', '']], file: 'MDL' },
  ],
  Transistor: [
    { name: 'BJT', prefix: 'Q', template: DEFAULT_TEMPLATES.bjt!, params: [['Area', ''], ['Off', ''], ['Initial B-E Voltage', ''], ['Initial C-E Voltage', ''], ['Temperature', '']], file: 'MDL' },
    { name: 'JFET', prefix: 'J', template: DEFAULT_TEMPLATES.jfet!, params: [['Area', ''], ['Off', '']], file: 'MDL' },
    { name: 'MOSFET', prefix: 'M', template: DEFAULT_TEMPLATES.mosfet!, params: [['Length', ''], ['Width', ''], ['Drain Area', ''], ['Source Area', ''], ['Off', '']], file: 'MDL' },
  ],
};
