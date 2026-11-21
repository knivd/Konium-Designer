/**
 * Circuits to start from in Live Simulation: each a sheet drawn here from the palette's parts,
 * with test points on the scopes, opened as a new schematic and run. Konium Designer's own
 * drawings of the standard circuits (a divider, a filter, a rectifier, an amplifier …).
 */
import { SCH_UNIT } from '../core/units';
import { SR, schCoord, setSchCoord } from '../model/sch';
import { toBgr } from '../model/common';
import { partRecords } from '../model/schPlace';
import { setSimParam } from '../model/simModels';
import { cfbPut, newEntry, writeCfb } from '../formats/cfb/cfb';
import { binToBytes } from '../formats/text';
import { C, SchBuilder } from '../formats/synthetic/schBuilder';
import { SIM_PARTS_LIB, SIM_SOURCES_LIB, simPartSymbols, simSourceSymbols, type SimSymbolBuilder, type SymbolStyle } from '../formats/synthetic/simLib';
import { KIT } from './liveKit';

type P = [number, number];
type Values = Record<string, string>;

/** The style the example being built is drawn in (liveExampleBytes sets it). */
let style: SymbolStyle = 'european';
const sets = new Map<SymbolStyle, Map<string, { sym: SimSymbolBuilder; lib: string; prefix: string }>>();
function symbolOf(libRef: string) {
  let symbols = sets.get(style);
  if (!symbols) {
    sets.set(style, symbols = new Map());
    const prefix = new Map(KIT.map((k) => [k.libRef, k.prefix]));
    for (const s of simPartSymbols(style)) symbols.set(s.libRef, { sym: s, lib: SIM_PARTS_LIB, prefix: prefix.get(s.libRef) ?? 'U' });
    for (const s of simSourceSymbols()) symbols.set(s.libRef, { sym: s, lib: SIM_SOURCES_LIB.replace('.SchLib', '.IntLib'), prefix: prefix.get(s.libRef) ?? 'V' });
  }
  const got = symbols.get(libRef);
  if (!got) throw new Error(`no part ${libRef}`);
  return got;
}

/** A sheet being drawn: parts by their library names (each takes the next designator of its kind), wires, grounds, notes. Coordinates in tenths of an inch from the sheet's corner. */
class Sketch {
  private b = new SchBuilder();
  private count = new Map<string, number>();
  constructor(title: string, about: string) {
    this.b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 2, SIZE1: 10, FONTNAME1: 'Arial', SIZE2: 16, FONTNAME2: 'Arial', BOLD2: true,
      SHEETSTYLE: 0, BORDERON: true, TITLEBLOCKON: true, AREACOLOR: toBgr(0xffffff), SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10 });
    this.b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: title, FONTID: 2, COLOR: C.text }, { LOCATION: { x: 100, y: 650 } });
    about.split('\n').forEach((line, i) => this.b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: line, FONTID: 1, COLOR: toBgr(0x55595f) }, { LOCATION: { x: 100, y: 625 - i * 16 } }));
  }
  /** A part: its library name, where, its values; `q` quarter turns anticlockwise, `flip` top to bottom. Its designator comes back. */
  put(libRef: string, at: P, values: Values = {}, o: { q?: number; flip?: boolean; /** A switch closed, a logic input high. */ on?: boolean; /** Its designator centred this far over it (parts close in a row). */ over?: number } = {}): string {
    const { sym, lib, prefix } = symbolOf(libRef);
    const n = (this.count.get(prefix) ?? 0) + 1;
    this.count.set(prefix, n);
    const items = partRecords({ libRef, bags: sym.bags }, lib, 1);
    for (const [k, v] of Object.entries(values)) if (!setSimParam(items, k, v)) throw new Error(`${libRef} has no ${k}`);
    const first = this.b.placePart(items, at, { designator: `${prefix}${n}`, quarter: o.q ?? 0, flip: o.flip });
    // A part on its side keeps its texts level: its designator over it and its value under it (they would stand on end
    // with it). One turned left to right has them on its other side, and they are written towards it.
    if (o.on) this.b.bags[first + 1]!.set('DISPLAYMODE', '1');
    const side = (o.q ?? 0) % 2 === 1, turned = (o.q ?? 0) === 2 && !!o.flip;
    if (side || turned) {
      for (const bag of this.b.bags.slice(first + 2)) {
        const rec = bag.int('RECORD', -1);
        if (bag.int('OWNERINDEX', -1) !== first || (rec !== SR.DESIGNATOR && rec !== SR.PARAMETER) || bag.bool('ISHIDDEN')) continue;
        bag.delete('ORIENTATION'); bag.delete('ISMIRRORED');
        if (side) {
          // (a push button's plunger stands above its contacts: its name goes over that)
          const over = rec === SR.DESIGNATOR, off = Math.abs(schCoord(bag, 'LOCATION.Y') - at[1] * SCH_UNIT) + (libRef === 'PUSHBUTTON' ? 5 * SCH_UNIT : 0);
          setSchCoord(bag, 'LOCATION.X', at[0] * SCH_UNIT); setSchCoord(bag, 'LOCATION.Y', at[1] * SCH_UNIT + (over ? off : -off));
          bag.set('JUSTIFICATION', over ? '1' : '7');
        } else bag.set('JUSTIFICATION', '2');
      }
    }
    if (o.over) for (const bag of this.b.bags.slice(first + 2)) {
      if (bag.int('OWNERINDEX', -1) !== first || bag.int('RECORD', -1) !== SR.DESIGNATOR) continue;
      bag.delete('ORIENTATION'); bag.delete('ISMIRRORED');
      setSchCoord(bag, 'LOCATION.X', at[0] * SCH_UNIT); setSchCoord(bag, 'LOCATION.Y', (at[1] + o.over) * SCH_UNIT);
      bag.set('JUSTIFICATION', '1');
    }
    return `${prefix}${n}`;
  }
  w(...pts: P[]): this { this.b.wire(...pts); return this; }
  /** Junctions: where a wire's end meets another wire along its length. */
  j(...pts: P[]): this { for (const [x, y] of pts) this.b.add({ RECORD: SR.JUNCTION, OWNERPARTID: -1, COLOR: C.wire }, { LOCATION: { x, y } }); return this; }
  gnd(...pts: P[]): this { for (const [x, y] of pts) this.b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: 4, ORIENTATION: 3, TEXT: 'GND', SHOWNETNAME: true, COLOR: C.wire }, { LOCATION: { x, y } }); return this; }
  vcc(...pts: P[]): this { for (const [x, y] of pts) this.b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: 2, ORIENTATION: 1, TEXT: 'VCC', SHOWNETNAME: true, COLOR: C.wire }, { LOCATION: { x, y } }); return this; }
  label(text: string, at: P): this { this.b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: text, COLOR: C.wire, FONTID: 1 }, { LOCATION: { x: at[0], y: at[1] } }); return this; }
  note(text: string, at: P): this { this.b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: text, FONTID: 1, COLOR: toBgr(0x55595f) }, { LOCATION: { x: at[0], y: at[1] } }); return this; }
  /** A test point reading the net at `at` (its pin's end is there), on a scope where one is named. */
  tp(at: P, scope = 0): this { this.put('TESTPOINT', [at[0], at[1] + 10], scope ? { 'On Scope': String(scope) } : {}); return this; }
  bytes(): Uint8Array {
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'FileHeader', this.b.bytes());
    cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
    return writeCfb(root);
  }
}

export interface LiveExample {
  id: string;
  group: string;
  title: string;
  /** What it shows and what to try, in a line or two. */
  about: string;
  /** Started with everything discharged (an oscillator has to be: its balanced state is a state too). */
  zero?: boolean;
  /** The circuit's time for each second of the watcher's, where the pace worked out from the circuit would not show it well. */
  speed?: number;
  draw(s: Sketch): void;
}

/** A source on the left between a top rail (y 460) and a bottom rail (y 340, grounded): the frame most of these stand in. */
const frame = (s: Sketch, libRef: string, values: Values, right: number): void => {
  s.put(libRef, [160, 400], values);
  s.w([160, 380], [160, 340], [right, 340]).gnd([160, 340]);
};
/** A 555 timer on a 9 V supply, its reset and control pins dealt with, its output read by a test point and taken through 330 ohms to an LED or (`sound`) through 100 uF and 100 ohms to a speaker (called after the timing parts, which so are R1, R2 and C1). */
const timer = (s: Sketch, sound = false): void => {
  s.put('VSRC', [160, 400], { Value: '9' }); s.put('NE555', [400, 400]);
  s.w([160, 420], [160, 500], [410, 500], [410, 440]).w([400, 440], [400, 500]).j([400, 500]);
  s.w([160, 380], [160, 280], [580, 280]).gnd([160, 280]).w([400, 360], [400, 280]).j([400, 280]);
  s.put('CAP', [410, 320], { Value: '10n' }); s.w([410, 360], [410, 340]).w([410, 300], [410, 280]);
  // The output: through a capacitor and 100 ohms to a speaker, or through 330 ohms to an LED
  s.j([410, 280]).w([580, 280], [580, sound ? 300 : 340]);
  if (sound) { s.put('CAP', [530, 400], { Value: '100u' }, { q: 1 }); s.put('RES', [580, 370], { Value: '100' }); s.put('SPEAKER', [580, 320], { 'Full Scale': '0.4' }); s.w([580, 350], [580, 340]); }
  else { s.put('RES', [530, 400], { Value: '330' }, { q: 1 }); s.put('LED_VF', [580, 360]); }
  s.w([440, 400], [510, 400]).w([550, 400], [580, 400], [580, sound ? 390 : 380]).tp([470, 400], 1);
};
const SIN1K = { Amplitude: '1', Frequency: '1k' };
const SQUARE = (f: string) => ({ Amplitude: '2.5', Offset: '2.5', Frequency: f });

export const LIVE_EXAMPLES: LiveExample[] = [
  /* ─── Basics ─── */
  { id: 'ohm', group: 'Basics', title: 'Ohm\'s law', about: 'The ammeter reads the current the source drives through R1, the voltmeter the voltage across it.\nSelect V1 or R1 and turn its slider: the current is the voltage over the resistance.',
    draw: (s) => {
      frame(s, 'VSRC', { Value: '5' }, 420);
      s.put('AMMETER', [300, 440]); s.put('RES', [300, 380], { Value: '1k' }); s.put('VOLTMETER', [420, 380]);
      s.w([160, 420], [160, 460], [300, 460]).w([300, 420], [300, 400]).w([300, 400], [420, 400]).j([300, 400]).w([420, 360], [420, 340]).w([300, 360], [300, 340]).j([300, 340]);
    } },
  { id: 'divider', group: 'Basics', title: 'Voltage divider', about: 'Two resistors share the source\'s voltage in the ratio of their resistances.\nSelect R1 or R2 and turn its slider to move the output.',
    draw: (s) => {
      frame(s, 'VSRC', { Value: '10' }, 320);
      s.put('RES', [320, 440], { Value: '10k' }); s.put('RES', [320, 360], { Value: '10k' });
      s.w([160, 420], [160, 460], [320, 460]).w([320, 420], [320, 380]).w([320, 400], [400, 400]).j([320, 400]).label('OUT', [345, 400]).tp([400, 400]);
    } },
  { id: 'pot', group: 'Basics', title: 'Potentiometer', about: 'A potentiometer is a divider in one part: its wiper taps the track.\nSelect RV1 and move its Position slider.',
    draw: (s) => {
      frame(s, 'VSRC', { Value: '10' }, 320);
      s.put('POT', [320, 400], { Resistance: '10k', Position: '30' });
      s.w([160, 420], [160, 460], [320, 460], [320, 420]).w([320, 340], [320, 380]).w([340, 400], [420, 400]).tp([420, 400]);
    } },
  { id: 'rc', group: 'Basics', title: 'Capacitor charging and discharging', about: 'A square wave charges C1 through R1 and lets it discharge: the time constant is R1 times C1 (1 ms).\nTurn R1 or C1 and watch the curve on the scope.',
    draw: (s) => {
      frame(s, 'VSQUARE', SQUARE('100'), 360);
      s.put('RES', [260, 460], { Value: '1k' }, { q: 1 }); s.put('CAP', [360, 400], { Value: '1u' });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [360, 460], [360, 420]).w([360, 340], [360, 380]).tp([200, 460], 1).tp([360, 460], 1);
    } },
  { id: 'rl', group: 'Basics', title: 'Inductor', about: 'An inductor resists a change of its current: the current rises and falls with the time constant L1 over R1 (1 ms).\nScope 1 draws the voltages, scope 2 the current.',
    draw: (s) => {
      frame(s, 'VSQUARE', SQUARE('100'), 380);
      s.put('RES', [260, 480], { Value: '100' }, { q: 1 }); s.put('AMMETER', [380, 440], { 'On Scope': '2' }); s.put('IND', [380, 380], { Value: '100m' });
      s.w([160, 420], [160, 480], [240, 480]).w([280, 480], [380, 480], [380, 460]).w([380, 420], [380, 400]).w([380, 340], [380, 360]).tp([200, 480], 1).tp([320, 480], 1);
    } },
  { id: 'lrc', group: 'Basics', title: 'LRC circuit ringing', about: 'Each edge of the square wave sets L1 and C1 ringing at about 500 Hz; R1 damps it.\nTurn R1 up to damp the ringing out; the Spectrum view shows the ringing\'s frequency.',
    draw: (s) => {
      frame(s, 'VSQUARE', SQUARE('20'), 400);
      s.put('RES', [240, 460], { Value: '10' }, { q: 1 }); s.put('IND', [320, 460], { Value: '100m' }, { q: 1 }); s.put('CAP', [400, 400], { Value: '1u' });
      s.w([160, 420], [160, 460], [220, 460]).w([260, 460], [300, 460]).w([340, 460], [400, 460], [400, 420]).w([400, 340], [400, 380]).tp([190, 460], 1).tp([400, 460], 1);
    } },
  { id: 'fuse', group: 'Basics', title: 'Fuse', about: 'The lamp takes 0.4 A through the 1 A fuse. Click SW1: R1 takes 2 A more, the fuse blows and the lamp goes out.\nOpen SW1 again and click the fuse to put a new one in. Select F1 to set what it blows at.',
    draw: (s) => {
      frame(s, 'VSRC', { Value: '12' }, 440);
      s.put('FUSE', [230, 460], { Rating: '1' }, { q: 1 }); s.put('LAMP', [320, 400]); s.put('SWITCH', [440, 430]); s.put('RES', [440, 380], { Value: '6' });
      s.w([160, 420], [160, 460], [210, 460]).w([250, 460], [320, 460], [320, 420]).w([320, 380], [320, 340]).j([320, 340]);
      s.w([320, 460], [440, 460], [440, 450]).j([320, 460]).w([440, 410], [440, 400]).w([440, 360], [440, 340]).tp([285, 460], 1);
    } },
  { id: 'inrush', group: 'Basics', title: 'Quick and slow-blow fuses', speed: 1, about: 'Click SW1: each capacitor charges through 1 ohm, 12 A at first and for a few milliseconds. The quick fuse F1 blows at once;\nthe slow-blow F2, 1 A as well, hardly warms and its lamp stays lit. Open SW1 and click F1 to put a new one in.',
    draw: (s) => {
      frame(s, 'VSRC', { Value: '12' }, 480);
      s.put('SWITCH', [220, 500], {}, { q: 1 });
      s.w([160, 420], [160, 500], [200, 500]).w([240, 500], [420, 500], [420, 490]).w([280, 500], [280, 490]).j([280, 500]);
      [['FUSE', 280], ['FUSE_SLOW', 420]].forEach(([ref, x], k) => {
        const at = x as number;
        s.put(ref as string, [at, 470], { Rating: '1' }); s.put('RES', [at, 410], { Value: '1' }); s.put('CAP', [at, 370], { Value: '2200u' }); s.put('LAMP', [at + 60, 400]);
        s.w([at, 450], [at, 430]).w([at, 350], [at, 340]).w([at, 440], [at + 60, 440], [at + 60, 420]).j([at, 440]).w([at + 60, 380], [at + 60, 340]).tp([at + 30, 440], k + 1);
      });
    } },

  /* ─── Filters and AC ─── */
  { id: 'lowpass', group: 'Filters and AC', title: 'RC low-pass filter', about: 'R1 and C1 pass what is below about 1 kHz and turn down what is above.\nSet the scope to Frequency response to see the curve; turn V1\'s frequency to walk along it.',
    draw: (s) => {
      frame(s, 'VSIN', SIN1K, 360);
      s.put('RES', [260, 460], { Value: '1.6k' }, { q: 1 }); s.put('CAP', [360, 400], { Value: '100n' });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [360, 460], [360, 420]).w([360, 340], [360, 380]).tp([200, 460], 1).tp([360, 460], 1);
    } },
  { id: 'highpass', group: 'Filters and AC', title: 'RC high-pass filter', about: 'C1 and R1 pass what is above about 1 kHz and turn down what is below.\nSet the scope to Frequency response to see the curve.',
    draw: (s) => {
      frame(s, 'VSIN', SIN1K, 360);
      s.put('CAP', [260, 460], { Value: '100n' }, { q: 1 }); s.put('RES', [360, 400], { Value: '1.6k' });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [360, 460], [360, 420]).w([360, 340], [360, 380]).tp([200, 460], 1).tp([360, 460], 1);
    } },
  { id: 'bandpass', group: 'Filters and AC', title: 'LC band-pass filter', about: 'L1 and C1 resonate at about 1 kHz: there the output is largest.\nSet the scope to Frequency response to see the peak; turn L1 or C1 to move it.',
    draw: (s) => {
      frame(s, 'VSIN', SIN1K, 440);
      s.put('RES', [260, 460], { Value: '1k' }, { q: 1 }); s.put('IND', [360, 400], { Value: '10m' }); s.put('CAP', [440, 400], { Value: '2.5u' });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [440, 460], [440, 420]).w([360, 460], [360, 420]).j([360, 460]).w([440, 340], [440, 380]).w([360, 380], [360, 340]).j([360, 340]).tp([200, 460], 1).tp([400, 460], 1);
    } },
  { id: 'transformer', group: 'Filters and AC', title: 'Transformer stepping down', about: 'Five turns to one: a fifth of the voltage on the secondary, five times the current.\nSelect T1 and change its turns ratio.',
    draw: (s) => {
      s.put('VSIN', [160, 400], { Amplitude: '10', Frequency: '50' }); s.put('TRANSFORMER', [320, 400], { 'Primary Inductance': '1', Ratio: '5' }); s.put('RES', [440, 400], { Value: '100' });
      s.w([160, 420], [160, 440], [310, 440], [310, 420]).w([160, 380], [160, 360], [310, 360], [310, 380]).gnd([160, 360]);
      s.w([330, 420], [330, 440], [440, 440], [440, 420]).w([440, 380], [440, 360], [330, 360], [330, 380]).gnd([440, 360]).tp([240, 440], 1).tp([390, 440], 1);
    } },

  /* ─── Diodes ─── */
  { id: 'halfwave', group: 'Diodes and thyristors', title: 'Half-wave rectifier', about: 'D1 passes the positive half of the sine to the load and blocks the negative.\nSelect D1 and change its forward voltage.',
    draw: (s) => {
      frame(s, 'VSIN', { Amplitude: '10', Frequency: '50' }, 360);
      s.put('DIODE_VF', [260, 460], {}, { q: 1 }); s.put('RES', [360, 400], { Value: '1k' });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [360, 460], [360, 420]).w([360, 340], [360, 380]).tp([200, 460], 1).tp([360, 460], 1);
    } },
  { id: 'smoothing', group: 'Diodes and thyristors', title: 'Rectifier with a smoothing capacitor', about: 'C1 holds the output up between the peaks; the load discharges it a little each cycle (the ripple).\nTurn C1 down or R1 down to see more ripple.',
    draw: (s) => {
      frame(s, 'VSIN', { Amplitude: '10', Frequency: '50' }, 440);
      s.put('DIODE_VF', [260, 460], {}, { q: 1 }); s.put('RES', [360, 400], { Value: '1k' }); s.put('CAP_POL', [440, 400], { Value: '100u' });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [440, 460], [440, 420]).w([360, 460], [360, 420]).j([360, 460]).w([440, 340], [440, 380]).w([360, 380], [360, 340]).j([360, 340]).tp([200, 460], 1).tp([400, 460], 1);
    } },
  { id: 'bridge', group: 'Diodes and thyristors', title: 'Bridge rectifier', about: 'Four diodes turn both halves of the sine the same way into the load.\nThe two wires that cross below the bridge are not joined.',
    draw: (s) => {
      s.put('VSIN', [160, 400], { Amplitude: '10', Frequency: '50' });
      for (const at of [[300, 440], [400, 440], [300, 360], [400, 360]] as P[]) s.put('DIODE_VF', at, {}, { q: 2 });
      s.put('RES', [520, 400], { Value: '1k' });
      s.w([300, 380], [300, 420]).w([400, 380], [400, 420]).w([160, 420], [240, 420], [240, 400], [300, 400]).j([300, 400]).w([160, 380], [160, 300], [450, 300], [450, 400], [400, 400]).j([400, 400]);
      s.w([300, 460], [300, 480], [520, 480], [520, 420]).w([400, 460], [400, 480]).j([400, 480]).w([300, 340], [300, 320], [520, 320], [520, 380]).w([400, 340], [400, 320]).j([400, 320]).gnd([520, 320]).tp([470, 480], 1);
    } },
  { id: 'zener', group: 'Diodes and thyristors', title: 'Zener voltage reference', about: 'The Zener holds its voltage across the load while the supply changes.\nTurn V1 from 6 V to 20 V: the output stays near 5.1 V once the Zener conducts.',
    draw: (s) => {
      frame(s, 'VSRC', { Value: '12' }, 440);
      s.put('RES', [260, 460], { Value: '470' }, { q: 1 }); s.put('ZENER', [360, 400], {}, { q: 2 }); s.put('RES', [440, 400], { Value: '1k' });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [440, 460], [440, 420]).w([360, 460], [360, 420]).j([360, 460]).w([440, 340], [440, 380]).w([360, 380], [360, 340]).j([360, 340]).tp([400, 460]);
    } },
  { id: 'clipper', group: 'Diodes and thyristors', title: 'Diode clipper', about: 'Two diodes back to back hold the output within a forward voltage of 0 V either way.\nSelect a diode and change its forward voltage.',
    draw: (s) => {
      frame(s, 'VSIN', { Amplitude: '5', Frequency: '1k' }, 440);
      s.put('RES', [260, 460], { Value: '1k' }, { q: 1 }); s.put('DIODE_VF', [360, 400]); s.put('DIODE_VF', [440, 400], {}, { q: 2 });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [440, 460], [440, 420]).w([360, 460], [360, 420]).j([360, 460]).w([440, 340], [440, 380]).w([360, 380], [360, 340]).j([360, 340]).tp([200, 460], 1).tp([400, 460], 1);
    } },
  { id: 'led', group: 'Diodes and thyristors', title: 'LED and its resistor', about: 'Click the switch: the LED lights, the brighter the more current R1 lets through.\nTurn R1, or change the LED\'s colour and forward voltage.',
    draw: (s) => {
      frame(s, 'VSRC', { Value: '5' }, 400);
      s.put('SWITCH', [240, 460], {}, { q: 1 }); s.put('RES', [320, 460], { Value: '330' }, { q: 1 }); s.put('LED_VF', [400, 400]);
      s.w([160, 420], [160, 460], [220, 460]).w([260, 460], [300, 460]).w([340, 460], [400, 460], [400, 420]).w([400, 340], [400, 380]);
    } },
  { id: 'scr', group: 'Diodes and thyristors', title: 'Thyristor latching a lamp', about: 'Press SW1: gate current turns the thyristor on and the lamp lights. Let go: it stays on, held by its own current.\nPress SW2: the current goes round the thyristor, which turns off and stays off.',
    draw: (s) => {
      frame(s, 'VSRC', { Value: '12' }, 500);
      s.put('LAMP', [400, 440]); s.put('SCR', [400, 380]); s.put('PUSHBUTTON', [260, 370], {}, { q: 1 }); s.put('RES', [330, 370], { Value: '1k' }, { q: 1 }); s.put('PUSHBUTTON', [500, 380]);
      s.w([160, 420], [160, 480], [400, 480], [400, 460]).w([400, 420], [400, 400]).w([400, 360], [400, 340]).j([400, 340]);
      s.w([240, 370], [240, 480]).j([240, 480]).w([280, 370], [310, 370]).w([350, 370], [380, 370]);
      s.w([400, 400], [500, 400]).j([400, 400]).w([500, 360], [500, 340]).tp([450, 400], 1);
    } },
  { id: 'triac', group: 'Diodes and thyristors', title: 'TRIAC lamp dimmer', about: 'Each half cycle the TRIAC waits until its gate has its trigger current through RV1 and R1, then conducts until the current falls to nothing.\nMove RV1\'s position up to fire it sooner and down to fire it later: the lamp brightens and dims.',
    draw: (s) => {
      frame(s, 'VSIN', { Amplitude: '24', Frequency: '50' }, 400);
      s.put('LAMP', [280, 480], { 'Nominal Voltage': '24', 'Nominal Power': '10' }, { q: 1 }); s.put('TRIAC', [400, 380]); s.put('POT', [300, 410], { Resistance: '4k', Position: '75' }); s.put('RES', [350, 370], { Value: '1k' }, { q: 1 });
      s.w([160, 420], [160, 480], [260, 480]).w([300, 480], [400, 480], [400, 400]).w([400, 360], [400, 340]);
      s.w([400, 440], [300, 440], [300, 430]).j([400, 440]).w([320, 410], [320, 370], [330, 370]).w([300, 390], [300, 380], [320, 380]).j([320, 380]).w([370, 370], [380, 370]);
      s.tp([210, 480], 1).tp([350, 480], 1);
    } },
  { id: 'dimmer', group: 'Diodes and thyristors', title: 'Dimmer with a DIAC and a TRIAC', about: 'C1 charges through RV1 and R1 each half cycle. When it reaches the DIAC\'s 32 V the DIAC breaks over and empties it into the gate,\nand the TRIAC conducts for the rest of the half cycle. Move RV1\'s position up to fire it sooner and brighten the lamp.\nScope 2 is what is left across the TRIAC, scope 3 the capacitor.',
    draw: (s) => {
      frame(s, 'VSIN', { Amplitude: '325', Frequency: '50' }, 480);
      s.put('LAMP', [240, 480], { 'Nominal Voltage': '230', 'Nominal Power': '60' }, { q: 1 }); s.put('POT', [320, 460], { Resistance: '250k', Position: '40' }, { q: 2, flip: true }); s.put('RES', [320, 410], { Value: '3.3k' });
      s.put('CAP', [320, 370], { Value: '100n' }); s.put('DIAC', [420, 390], {}, { q: 1 }); s.put('TRIAC', [480, 400]);
      s.w([160, 420], [160, 480], [220, 480]).w([260, 480], [480, 480], [480, 420]).w([480, 380], [480, 340]);
      s.w([320, 440], [320, 430]).w([300, 460], [300, 440], [320, 440]).w([320, 350], [320, 340]).w([320, 390], [400, 390]).w([440, 390], [460, 390]);
      s.tp([190, 480], 1).tp([420, 480], 2).tp([345, 390], 3);
    } },

  /* ─── Transistors ─── */
  { id: 'npnswitch', group: 'Transistors', title: 'Transistor switch', about: 'Click the switch: a small base current through R1 turns Q1 on, and it lights the LED.\nTurn R1 up until the transistor no longer saturates.',
    draw: (s) => {
      s.put('VSRC', [160, 400], { Value: '5' }); s.put('LED_VF', [450, 500]); s.put('RES', [450, 440], { Value: '330' }); s.put('NPN_BETA', [440, 380]);
      s.put('SWITCH', [260, 380], {}, { q: 1 }); s.put('RES', [340, 380], { Value: '10k' }, { q: 1 });
      s.w([160, 420], [160, 520], [450, 520]).w([450, 480], [450, 460]).w([450, 420], [450, 400]).w([450, 360], [450, 340]).w([160, 380], [160, 340], [450, 340]).gnd([160, 340]);
      s.w([200, 520], [200, 380], [240, 380]).j([200, 520]).w([280, 380], [320, 380]).w([360, 380], [420, 380]);
    } },
  { id: 'ce', group: 'Transistors', title: 'Common-emitter amplifier', about: 'A 5 mV sine at the base comes out at the collector about 190 times larger and turned over.\nSet scope 2 to Frequency response; select C2 or R3 and turn it to see the gain move.',
    draw: (s) => {
      s.put('VSRC', [100, 420], { Value: '12' }); s.put('VSIN', [170, 300], { Amplitude: '5m', Frequency: '1k' });
      s.put('CAP', [240, 400], { Value: '10u' }, { q: 1 }); s.put('RES', [320, 480], { Value: '47k' }); s.put('RES', [320, 320], { Value: '10k' }); s.put('NPN_BETA', [360, 400], { Beta: '200' });
      s.put('RES', [370, 480], { Value: '4.7k' }); s.put('RES', [370, 320], { Value: '1k' }); s.put('CAP', [440, 320], { Value: '100u' }); s.put('CAP', [440, 440], { Value: '10u' }, { q: 1 }); s.put('RES', [520, 400], { Value: '100k' });
      s.w([170, 320], [170, 400], [220, 400]).w([260, 400], [320, 400]).w([320, 400], [340, 400]).w([320, 460], [320, 340]).j([320, 400]);
      s.w([370, 460], [370, 420]).w([370, 440], [420, 440]).j([370, 440]).w([370, 380], [370, 340]).w([370, 360], [440, 360], [440, 340]).j([370, 360]).w([460, 440], [520, 440], [520, 420]);
      s.w([320, 500], [320, 520], [370, 520], [370, 500]).w([100, 440], [100, 460]).vcc([345, 520], [100, 460]);
      s.w([100, 400], [100, 380]).w([170, 280], [170, 260]).w([320, 300], [320, 280]).w([370, 300], [370, 280]).w([440, 300], [440, 280]).w([520, 380], [520, 360]).gnd([100, 380], [170, 260], [320, 280], [370, 280], [440, 280], [520, 360]);
      s.label('IN', [180, 400]).label('OUT', [480, 440]).tp([200, 400], 1).tp([500, 440], 2);
    } },
  { id: 'follower', group: 'Transistors', title: 'Emitter follower', about: 'The emitter follows the base, about 0.65 V below it: no voltage gain, but it can drive a load.\nTurn R1 down: the output hardly moves.',
    draw: (s) => {
      s.put('VSRC', [160, 420], { Value: '10' }); s.put('VSIN', [260, 360], { Amplitude: '1', Offset: '5', Frequency: '1k' }); s.put('NPN_BETA', [360, 400]); s.put('RES', [370, 340], { Value: '1k' });
      s.w([160, 440], [160, 480], [370, 480], [370, 420]).w([260, 380], [260, 400], [340, 400]).w([370, 380], [370, 360]).w([370, 370], [440, 370]).j([370, 370]);
      s.w([160, 400], [160, 300], [370, 300], [370, 320]).w([260, 340], [260, 300]).j([260, 300]).gnd([160, 300]).tp([300, 400], 1).tp([440, 370], 1);
    } },
  { id: 'astable', group: 'Transistors', title: 'Astable multivibrator', zero: true, about: 'Two transistors take turns: each switches the other off through its capacitor.\nIt starts with everything discharged; turn C1 or C2 to change how long each side stays on.',
    draw: (s) => {
      s.put('VSRC', [160, 400], { Value: '5' }); s.put('NPN_BETA', [300, 360], {}, { q: 2, flip: true }); s.put('NPN_BETA', [520, 360]);
      s.put('RES', [290, 480], { Value: '1k' }); s.put('RES', [380, 480], { Value: '47k' }); s.put('RES', [440, 480], { Value: '47k' }); s.put('RES', [530, 480], { Value: '1k' });
      s.put('CAP', [340, 440], { Value: '1u' }, { q: 1 }); s.put('CAP', [480, 440], { Value: '470n' }, { q: 1 });
      // The supply along the top, 0 V along the bottom
      s.w([160, 420], [160, 520], [530, 520], [530, 500]).w([290, 520], [290, 500]).j([290, 520]).w([380, 520], [380, 500]).j([380, 520]).w([440, 520], [440, 500]).j([440, 520]);
      s.w([160, 380], [160, 300], [530, 300], [530, 340]).w([290, 340], [290, 300]).j([290, 300]).gnd([160, 300]);
      // Each collector to its load and, through its capacitor, to the other side's base resistor and base
      s.w([290, 460], [290, 380]).w([290, 440], [320, 440]).j([290, 440]).w([360, 440], [380, 440]).w([380, 460], [380, 400], [470, 400], [470, 360], [500, 360]).j([380, 440]);
      s.w([530, 460], [530, 380]).w([530, 440], [500, 440]).j([530, 440]).w([460, 440], [440, 440]).w([440, 460], [440, 420], [350, 420], [350, 360], [320, 360]).j([440, 440]);
      s.w([290, 400], [220, 400]).j([290, 400]).tp([220, 400], 1).w([530, 400], [590, 400]).j([530, 400]).tp([590, 400], 1);
    } },

  /* ─── MOSFETs and relays ─── */
  { id: 'nmoslamp', group: 'MOSFETs and relays', title: 'MOSFET switching a lamp', about: 'Hold the push button: the gate goes up to the supply, Q1 turns on and the lamp lights.\nSelect Q1 and raise its threshold above the supply: it stays off.',
    draw: (s) => {
      s.put('VSRC', [160, 420], { Value: '12' }); s.put('LAMP', [450, 480]); s.put('NMOS_VT', [440, 400], { 'Threshold Voltage': '2' }); s.put('PUSHBUTTON', [280, 400], {}, { q: 1 }); s.put('RES', [360, 360], { Value: '100k' });
      s.w([160, 440], [160, 500], [450, 500]).w([450, 460], [450, 420]).w([450, 380], [450, 340]).w([160, 400], [160, 340], [450, 340]).gnd([160, 340]);
      s.w([220, 500], [220, 400], [260, 400]).j([220, 500]).w([300, 400], [420, 400]).w([360, 400], [360, 380]).j([360, 400]).j([360, 340]);
    } },
  { id: 'cmos', group: 'MOSFETs and relays', title: 'CMOS inverter', about: 'A P-channel MOSFET above an N-channel one: whichever the input turns on pulls the output its way.\nThe output is the input turned over.',
    draw: (s) => {
      s.put('VSRC', [120, 420], { Value: '5' }); s.put('VSQUARE', [220, 380], SQUARE('1k')); s.put('PMOS_VT', [360, 460], {}, { flip: true }); s.put('NMOS_VT', [360, 360]);
      s.w([370, 440], [370, 380]).w([370, 410], [450, 410]).j([370, 410]).w([340, 460], [320, 460], [320, 360], [340, 360]).w([220, 400], [220, 410], [320, 410]).j([320, 410]);
      s.w([120, 440], [120, 500], [370, 500], [370, 480]).w([120, 400], [120, 320], [370, 320], [370, 340]).w([220, 360], [220, 320]).j([220, 320]).gnd([120, 320]).tp([270, 410], 1).tp([450, 410], 1);
    } },
  { id: 'relay', group: 'MOSFETs and relays', title: 'Relay switching a lamp', about: 'Hold the push button: the coil\'s current pulls the contact in, and the contact lights the lamp.\nThe coil and the lamp are two circuits; only the relay joins them.',
    draw: (s) => {
      s.put('VSRC', [120, 420], { Value: '12' }); s.put('PUSHBUTTON', [240, 480], {}, { q: 1 }); s.put('RELAY', [320, 400]); s.put('LAMP', [400, 360], {}, { q: 1 });
      s.w([120, 440], [120, 480], [220, 480]).w([260, 480], [310, 480], [310, 420]).w([310, 380], [310, 340]).j([310, 340]).w([120, 400], [120, 340], [460, 340]).gnd([120, 340]);
      s.w([120, 480], [120, 520], [330, 520], [330, 420]).w([330, 380], [330, 360], [380, 360]).w([420, 360], [460, 360], [460, 340]);
    } },

  /* ─── Op-amps ─── */
  { id: 'inverting', group: 'Op-amps', title: 'Inverting amplifier', about: 'The output is the input turned over and R2 over R1 times larger (here 10).\nTurn R2 to change the gain; turn the input up until the output reaches the op-amp\'s limits.',
    draw: (s) => {
      s.put('VSIN', [160, 360], { Amplitude: '0.5', Frequency: '1k' }); s.put('RES', [260, 410], { Value: '1k' }, { q: 1 }); s.put('RES', [370, 460], { Value: '10k' }, { q: 1 }); s.put('OPAMP_IDEAL', [360, 400], {}, { flip: true }); s.put('RES', [500, 360], { Value: '10k' });
      s.w([160, 380], [160, 410], [240, 410]).w([280, 410], [340, 410]).w([310, 410], [310, 460], [350, 460]).j([310, 410]).w([390, 460], [440, 460], [440, 400], [410, 400]).w([440, 400], [500, 400], [500, 380]).j([440, 400]);
      s.w([340, 390], [320, 390], [320, 320]).w([160, 340], [160, 320], [500, 320], [500, 340]).j([320, 320]).gnd([160, 320]).tp([200, 410], 1).tp([470, 400], 1);
    } },
  { id: 'noninverting', group: 'Op-amps', title: 'Non-inverting amplifier', about: 'The output is the input, 1 + R1 over R2 times larger (here 11), the same way up.\nTurn R1 or R2 to change the gain.',
    draw: (s) => {
      s.put('VSIN', [160, 370], { Amplitude: '0.2', Frequency: '1k' }); s.put('OPAMP_IDEAL', [360, 400]); s.put('RES', [370, 340], { Value: '10k' }, { q: 1 }); s.put('RES', [320, 300], { Value: '1k' });
      s.w([160, 390], [160, 410], [340, 410]).w([340, 390], [320, 390], [320, 320]).w([320, 340], [350, 340]).j([320, 340]).w([390, 340], [440, 340], [440, 400], [410, 400]).w([440, 400], [500, 400]).j([440, 400]);
      s.w([160, 350], [160, 260], [320, 260], [320, 280]).gnd([160, 260]).tp([250, 410], 1).tp([500, 400], 1);
    } },
  { id: 'buffer', group: 'Op-amps', title: 'Voltage follower', about: 'The output is joined to the inverting input: it follows the other input and takes no current from the source.\nA divider loaded through it keeps its voltage.',
    draw: (s) => {
      s.put('VSIN', [160, 350], { Amplitude: '2', Frequency: '1k' }); s.put('OPAMP_IDEAL', [360, 400], {}, { flip: true }); s.put('RES', [500, 360], { Value: '100' });
      s.w([160, 370], [160, 390], [340, 390]).w([340, 410], [320, 410], [320, 450], [440, 450], [440, 400], [410, 400]).w([440, 400], [500, 400], [500, 380]).j([440, 400]);
      s.w([160, 330], [160, 310], [500, 310], [500, 340]).gnd([160, 310]).tp([250, 390], 1).tp([470, 400], 1);
    } },
  { id: 'integrator', group: 'Op-amps', title: 'Integrator', about: 'A square wave in, a triangle out: C1 adds up the current that R1 lets in.\nR2 across the capacitor keeps the output from drifting away.',
    draw: (s) => {
      s.put('VSQUARE', [160, 360], { Amplitude: '1', Offset: '0', Frequency: '1k' }); s.put('RES', [260, 410], { Value: '10k' }, { q: 1 }); s.put('RES', [370, 500], { Value: '1Meg' }, { q: 1 }); s.put('CAP', [370, 460], { Value: '10n' }, { q: 1 }); s.put('OPAMP_IDEAL', [360, 400], {}, { flip: true });
      s.w([160, 380], [160, 410], [240, 410]).w([280, 410], [340, 410]).w([310, 410], [310, 460], [350, 460]).j([310, 410]).w([310, 460], [310, 500], [350, 500]).w([390, 460], [440, 460], [440, 400], [410, 400]).w([390, 500], [440, 500], [440, 460]);
      s.w([440, 400], [500, 400]).j([440, 400]).w([340, 390], [320, 390], [320, 320]).w([160, 340], [160, 320], [320, 320]).gnd([160, 320]).tp([200, 410], 1).tp([500, 400], 1);
    } },
  { id: 'comparator', group: 'Op-amps', title: 'Comparator with a threshold', about: 'The LED lights while the slow sine is below the voltage the potentiometer sets.\nSelect RV1 and move its Position: the LED is on for more or less of each cycle.',
    draw: (s) => {
      s.put('VSRC', [120, 400], { Value: '5' }); s.put('POT', [220, 400], { Resistance: '10k', Position: '50' }); s.put('VSIN', [300, 330], { Amplitude: '2', Offset: '2.5', Frequency: '2' }); s.put('COMPARATOR', [360, 400]);
      s.put('RES', [460, 400], { Value: '330' }, { q: 1 }); s.put('LED_VF', [520, 380]);
      s.w([120, 420], [120, 460], [220, 460], [220, 420]).w([240, 400], [260, 400], [260, 410], [340, 410]).w([300, 350], [300, 390], [340, 390]).w([410, 400], [440, 400]).w([480, 400], [520, 400]);
      s.w([120, 380], [120, 300], [520, 300], [520, 360]).w([220, 380], [220, 300]).j([220, 300]).w([300, 310], [300, 300]).j([300, 300]).gnd([120, 300]).tp([320, 390], 1).tp([290, 410], 1).tp([425, 400], 2);
    } },
  { id: 'relaxation', group: 'Op-amps', title: 'Relaxation oscillator', zero: true, about: 'C1 charges through R1 until the comparator flips, then discharges until it flips back.\nIt starts with everything discharged; turn R1 or C1 to change the frequency.',
    draw: (s) => {
      s.put('VSRC', [120, 420], { Value: '5' }); s.put('COMPARATOR', [360, 400]); s.put('RES', [300, 480], { Value: '100k' }); s.put('RES', [300, 360], { Value: '100k' }); s.put('RES', [370, 450], { Value: '100k' }, { q: 1 });
      s.put('RES', [390, 350], { Value: '10k' }, { q: 1 }); s.put('CAP', [320, 320], { Value: '1u' });
      s.w([300, 460], [300, 410], [340, 410]).w([300, 410], [300, 380]).w([410, 400], [450, 400], [450, 450], [390, 450]).w([350, 450], [320, 450], [320, 410]).j([320, 410]);
      s.w([340, 390], [320, 390], [320, 340]).w([450, 400], [450, 350], [410, 350]).j([450, 400]).w([370, 350], [320, 350]).j([320, 350]).w([450, 400], [520, 400]);
      s.w([120, 440], [120, 520], [300, 520], [300, 500]).w([120, 400], [120, 280], [320, 280], [320, 300]).w([300, 340], [300, 280]).j([300, 280]).gnd([120, 280]).tp([490, 400], 1).tp([350, 350], 1);
    } },

  /* ─── Logic and chips ─── */
  { id: 'gates', group: 'Logic and chips', title: 'Logic gates', about: 'Click an input to change it between low and high: the AND, OR and exclusive-OR gates answer.\nSelect an input or a gate to set the voltage that is its high level.',
    draw: (s) => {
      s.put('LOGIC_IN', [160, 480]); s.put('LOGIC_IN', [160, 380], {}, { on: true });
      s.put('AND', [360, 500]); s.put('OR', [360, 420]); s.put('XOR', [360, 340]);
      s.w([180, 480], [240, 480]).w([240, 510], [240, 350]).j([240, 480]).w([240, 510], [340, 510]).w([240, 430], [340, 430]).j([240, 430]).w([240, 350], [340, 350]);
      s.w([180, 380], [280, 380]).w([280, 490], [280, 330]).j([280, 380]).w([280, 490], [340, 490]).w([280, 410], [340, 410]).j([280, 410]).w([280, 330], [340, 330]);
      s.w([390, 500], [440, 500]).tp([440, 500]).w([390, 420], [440, 420]).tp([440, 420]).w([390, 340], [440, 340]).tp([440, 340]);
      s.note('AND', [352, 530]).note('OR', [354, 450]).note('XOR', [350, 370]);
    } },
  { id: 'latch', group: 'Logic and chips', title: 'Latch from two NAND gates', about: 'Each gate\'s output is the other\'s input, so the pair remembers. IN1 low sets TP1 high; IN2 low clears it.\nClick IN1 high: TP1 stays as it was. Then click IN2 low and high again.',
    draw: (s) => {
      s.put('LOGIC_IN', [160, 480]); s.put('LOGIC_IN', [160, 360], {}, { on: true });
      s.put('NAND', [360, 470]); s.put('NAND', [360, 370]);
      s.w([180, 480], [340, 480]).w([180, 360], [340, 360]);
      s.w([390, 470], [460, 470]).tp([460, 470]).w([420, 470], [420, 440], [310, 440], [310, 380], [340, 380]).j([420, 470]);
      s.w([390, 370], [460, 370]).tp([460, 370]).w([420, 370], [420, 400], [320, 400], [320, 460], [340, 460]).j([420, 370]);
    } },
  { id: 'schmitt', group: 'Logic and chips', title: 'Schmitt-trigger oscillator', zero: true, about: 'C1 charges through R1 until the input passes the upper threshold, the output turns over and C1 discharges to the lower one.\nTurn R1 or C1, or move U1\'s thresholds apart, to change how often.',
    draw: (s) => {
      s.put('SCHMITT_NOT', [360, 400]); s.put('RES', [360, 460], { Value: '100k' }, { q: 1 }); s.put('CAP', [280, 360], { Value: '10n' });
      s.w([280, 380], [280, 400], [340, 400]).w([340, 460], [340, 400]).j([340, 400]).w([380, 460], [380, 400]).w([380, 400], [450, 400]).j([380, 400]).gnd([280, 340]);
      s.w([280, 400], [220, 400]).j([280, 400]).tp([220, 400], 1).tp([450, 400], 1);
    } },
  { id: 'timer', group: 'Logic and chips', title: '555 timer flashing an LED', zero: true, speed: 0.5, about: 'C1 charges through R1 and R2 to two thirds of the supply and discharges through R2 to a third, over and over.\nTurn R2 or C1 to change how fast the LED flashes.',
    draw: (s) => {
      s.put('RES', [260, 470], { Value: '10k' }); s.put('RES', [260, 380], { Value: '47k' }); s.put('CAP_POL', [260, 310], { Value: '10u' });
      timer(s);
      s.w([260, 490], [260, 500]).j([260, 500]).w([260, 450], [260, 400]).w([360, 410], [260, 410]).j([260, 410]).w([260, 360], [260, 330]).w([260, 290], [260, 280]).j([260, 280]);
      s.w([360, 400], [320, 400], [320, 340], [260, 340]).j([260, 340]).w([360, 390], [320, 390]).j([320, 390]).w([260, 340], [200, 340]).tp([200, 340], 1);
    } },
  { id: 'oneshot', group: 'Logic and chips', title: '555 timer as a one-shot', speed: 0.5, about: 'Press the push button: the output goes high and the LED lights for 1.1 times R1 times C1 (about a second), however short the press.\nTurn R1 or C1 to change how long.',
    draw: (s) => {
      s.put('RES', [260, 470], { Value: '100k' }); s.put('CAP_POL', [260, 370], { Value: '10u' }); s.put('RES', [220, 470], { Value: '10k' }); s.put('PUSHBUTTON', [220, 310]);
      timer(s);
      s.w([260, 490], [260, 500]).j([260, 500]).w([260, 450], [260, 390]).w([360, 410], [260, 410]).j([260, 410]).w([360, 400], [340, 400], [340, 410]).j([340, 410]).w([260, 350], [260, 280]).j([260, 280]).tp([290, 410], 1);
      s.w([220, 490], [220, 500]).j([220, 500]).w([220, 450], [220, 330]).w([360, 390], [350, 390], [350, 330], [220, 330]).j([220, 330]).w([220, 290], [220, 280]).j([220, 280]);
    } },
  { id: 'regulator', group: 'Logic and chips', title: 'Voltage regulator', about: 'The input moves between 6 V and 12 V; the output stays at 5 V while the input is the dropout or more above it.\nSelect U1 to set its output; turn V1\'s offset down until the output follows the input down.',
    draw: (s) => {
      frame(s, 'VSIN', { Amplitude: '3', Offset: '9', Frequency: '100' }, 440);
      s.put('REGULATOR', [320, 460]); s.put('RES', [440, 400], { Value: '100' });
      s.w([160, 420], [160, 460], [290, 460]).w([320, 440], [320, 340]).j([320, 340]).w([350, 460], [440, 460], [440, 420]).w([440, 380], [440, 340]).tp([220, 460], 1).tp([390, 460], 1);
    } },
  { id: 'opto', group: 'Logic and chips', title: 'Optocoupler', about: 'Hold the push button: the LED inside U1 lights, and the transistor its light falls on passes the lamp\'s current.\nOnly light joins the two sides. Select U1 to set its transfer ratio.',
    draw: (s) => {
      s.put('VSRC', [140, 400], { Value: '5' }); s.put('PUSHBUTTON', [220, 460], {}, { q: 1 }); s.put('RES', [290, 460], { Value: '330' }, { q: 1 }); s.put('OPTO', [370, 450]);
      s.put('LAMP', [470, 500], { 'Nominal Power': '0.1' }, { q: 1 }); s.put('VSRC', [540, 400], { Value: '12' });
      s.w([140, 420], [140, 460], [200, 460]).w([240, 460], [270, 460]).w([310, 460], [340, 460]).w([340, 440], [340, 340]).w([140, 380], [140, 340], [340, 340]).gnd([140, 340]);
      s.w([400, 460], [420, 460], [420, 500], [450, 500]).w([490, 500], [540, 500], [540, 420]).w([400, 440], [430, 440], [430, 340], [540, 340], [540, 380]).gnd([430, 340]);
    } },

  { id: 'dff', group: 'Logic and chips', title: 'D flip-flop', about: 'IN1 is D and IN2 the clock. Click D, then click the clock high: Q (TP1) takes what D was as the clock rose, and TP2 is its opposite.\nChange D while the clock stays as it is: nothing happens until the clock rises again.',
    draw: (s) => {
      s.put('LOGIC_IN', [160, 420]); s.put('LOGIC_IN', [160, 380]); s.put('DFF', [300, 410]);
      s.w([180, 420], [270, 420]).w([180, 380], [240, 380], [240, 400], [270, 400]);
      s.w([330, 420], [340, 420], [340, 460], [400, 460]).tp([400, 460]).w([330, 400], [340, 400], [340, 360], [400, 360]).tp([400, 360]);
    } },
  { id: 'halving', group: 'Logic and chips', title: 'Flip-flops halving a clock', about: 'Each T flip-flop turns over as its clock rises: U1 gives half the clock\'s rate (scope 2), and U2, clocked by U1, a quarter (scope 3).\nClick IN1 low: with T low they hold as they are.',
    draw: (s) => {
      s.put('RAIL_CLOCK', [140, 410], { Voltage: '5', Frequency: '1k' }); s.put('LOGIC_IN', [140, 470], {}, { on: true }); s.put('TFF', [260, 410]); s.put('TFF', [420, 410]);
      s.w([140, 400], [230, 400]).tp([190, 400], 1);
      s.w([160, 470], [210, 470], [210, 420], [230, 420]).w([210, 470], [370, 470], [370, 420], [390, 420]).j([210, 470]);
      s.w([290, 420], [340, 420], [340, 400], [390, 400]).tp([315, 420], 2).w([450, 420], [500, 420]).tp([500, 420], 3);
    } },
  { id: 'counter', group: 'Logic and chips', title: 'Counter and a seven-segment display', speed: 1, about: 'The counter counts the clock\'s rises from 0 to 9 and round again; the decoder lights the segments of each digit.\nClick IN1 high to clear the count. Select U1 to change its modulus (16 goes on through A to F), or V1 for the clock\'s rate.',
    draw: (s) => {
      s.put('RAIL_CLOCK', [140, 440], { Voltage: '5', Frequency: '2' }); s.put('LOGIC_IN', [140, 380]);
      s.put('COUNTER', [240, 410], { Modulus: '10' }); s.put('DECODER7', [340, 410]); s.put('DISPLAY7', [440, 410]);
      s.w([140, 430], [210, 430]).tp([175, 430], 1).w([160, 380], [190, 380], [190, 400], [210, 400]);
      for (const y of [430, 420, 410, 400]) s.w([270, y], [310, y]);
      for (const y of [440, 430, 420, 410, 400, 390, 380]) s.w([370, y], [410, y]);
      s.w([440, 360], [440, 340]).gnd([440, 340]);
    } },
  { id: 'chaser', group: 'Logic and chips', title: 'Ring counter running a light along', speed: 1, about: 'The ring counter takes its outputs high one at a time, the next at each rise of the clock, so the light runs along the LEDs.\nOnly one is lit at a time, so R1 serves them all. Select U1 to set how many stages it has; click IN1 high to hold it at the first.',
    draw: (s) => {
      s.put('RAIL_CLOCK', [140, 470], { Voltage: '5', Frequency: '5' }); s.put('LOGIC_IN', [140, 400]); s.put('RING', [240, 420]);
      s.w([140, 460], [210, 460]).w([160, 400], [190, 400], [190, 430], [210, 430]);
      for (let i = 0; i < 10; i++) { const x = 310 + 40 * i; s.put('LED_VF', [x, 520], {}, { q: 2, over: 34 }); s.w([270, 460 - 10 * i], [x, 460 - 10 * i], [x, 500]); }
      s.put('RES', [710, 500], { Value: '330' });
      s.w([310, 540], [710, 540], [710, 520]).w([710, 480], [710, 470]).gnd([710, 470]);
    } },
  { id: 'shift', group: 'Logic and chips', title: 'Shift register', speed: 1, about: 'At each rise of the clock Q0 takes what D (IN1) is, and each other output what the one before it was.\nClick IN1 high for a second or two and low again: the ones move along the LEDs and out at the end.\nIN2 high clears them all.',
    draw: (s) => {
      s.put('LOGIC_IN', [140, 460]); s.put('RAIL_CLOCK', [140, 420], { Voltage: '5', Frequency: '1' }); s.put('LOGIC_IN', [140, 360]); s.put('SHIFT', [260, 400]);
      s.w([160, 460], [200, 460], [200, 420], [230, 420]).w([140, 410], [230, 410]).w([160, 360], [200, 360], [200, 390], [230, 390]);
      for (let i = 0; i < 4; i++) { const x = 330 + 50 * i; s.put('RES', [x, 470], { Value: '330' }); s.put('LED_VF', [x, 510], {}, { q: 2 }); s.w([290, 420 - 10 * i], [x, 420 - 10 * i], [x, 450]); }
      s.w([330, 530], [510, 530], [510, 510]).gnd([510, 510]);
    } },
  { id: 'mux', group: 'Logic and chips', title: 'Multiplexer', speed: 1, about: 'S1 and S0 (IN2 and IN1) name which of the four clocks reaches the output: 1 Hz, 2 Hz, 4 Hz or 8 Hz.\nClick IN1 and IN2 to choose: the LED and scope 1 show the one chosen.',
    draw: (s) => {
      ['1', '2', '4', '8'].forEach((f, i) => { const x = 280 - 50 * i; s.put('RAIL_CLOCK', [x, 510], { Voltage: '5', Frequency: f }); s.w([x, 500], [x, 450 - 10 * i], [330, 450 - 10 * i]); });
      s.put('LOGIC_IN', [220, 380]); s.put('LOGIC_IN', [220, 340]); s.put('MUX4', [360, 430]);
      s.w([240, 380], [300, 380], [300, 400], [330, 400]).w([240, 340], [310, 340], [310, 390], [330, 390]);
      s.put('RES', [470, 450], { Value: '330' }, { q: 1 }); s.put('LED_VF', [520, 450], {}, { q: 1 });
      s.w([390, 450], [450, 450]).tp([405, 450], 1).w([490, 450], [500, 450]).w([540, 450], [560, 450], [560, 420]).gnd([560, 420]);
    } },
  { id: 'staircase', group: 'Logic and chips', title: 'Counter and a DAC: a staircase', speed: 5e-3, about: 'The counter counts the clock\'s rises from 0 to 15, and the converter turns each number into as many sixteenths of 5 V: a staircase.\nR1 and C1 smooth the steps. Select U2 to set its reference, or U1 and a modulus of 10 for a shorter stair.',
    draw: (s) => {
      s.put('RAIL_CLOCK', [140, 440], { Voltage: '5', Frequency: '1k' }); s.put('COUNTER', [240, 410]); s.put('DAC4', [340, 410]);
      s.w([140, 430], [210, 430]).w([210, 400], [190, 400], [190, 380]).gnd([190, 380]);
      for (const y of [430, 420, 410, 400]) s.w([270, y], [310, y]);
      s.put('RES', [480, 430], { Value: '10k' }, { q: 1 }); s.put('CAP', [560, 400], { Value: '100n' });
      s.w([370, 430], [460, 430]).w([500, 430], [560, 430], [560, 420]).w([560, 380], [560, 370]).gnd([560, 370]).tp([395, 430], 1).tp([530, 430], 1);
    } },
  { id: 'converters', group: 'Logic and chips', title: 'ADC and DAC back to back', about: 'The first converter turns the sine into a four-bit number, sixteen steps of 5 V, and the second turns the number back.\nScope 1 draws both. Change V1\'s amplitude or offset to use fewer of the steps;\ngive the two converters different references to scale what comes out.',
    draw: (s) => {
      s.put('VSIN', [160, 420], { Amplitude: '2.4', Offset: '2.5', Frequency: '100' }); s.put('ADC4', [300, 440]); s.put('DAC4', [400, 440]);
      s.w([160, 440], [160, 460], [270, 460]).w([160, 400], [160, 380]).gnd([160, 380]);
      for (const y of [460, 450, 440, 430]) s.w([330, y], [370, y]);
      s.w([430, 460], [490, 460]).tp([215, 460], 1).tp([470, 460], 1);
    } },
  { id: 'tone', group: 'Logic and chips', title: '555 timer playing a tone', zero: true, speed: 1, about: 'The 555 turns over about 220 times a second, the A below middle C, and drives the speaker through C3 and R3: its square wave is heard, half a second of the circuit\'s time at once.\nChange R2 or C1 for another pitch, R3 for how loud.',
    draw: (s) => {
      s.put('RES', [260, 470], { Value: '10k' }); s.put('RES', [260, 380], { Value: '10k' }); s.put('CAP', [260, 310], { Value: '220n' });
      timer(s, true);
      s.w([260, 490], [260, 500]).j([260, 500]).w([260, 450], [260, 400]).w([360, 410], [260, 410]).j([260, 410]).w([260, 360], [260, 330]).w([260, 290], [260, 280]).j([260, 280]);
      s.w([360, 400], [320, 400], [320, 340], [260, 340]).j([260, 340]).w([360, 390], [320, 390]).j([320, 390]).w([260, 340], [200, 340]).tp([200, 340], 1);
    } },

  /* ─── Sources ─── */
  { id: 'waveforms', group: 'Sources', title: 'The waveforms', about: 'A sine, a square, a triangle and a sawtooth source, each on a scope of its own.\nSelect one and change its amplitude, offset, frequency, phase or duty cycle.',
    draw: (s) => {
      ['VSIN', 'VSQUARE', 'VTRIANGLE', 'VSAW'].forEach((ref, k) => {
        const x = 140 + k * 140;
        s.put(ref, [x, 400], { Amplitude: '1', Frequency: '1k' }); s.put('RES', [x + 60, 400], { Value: '1k' });
        s.w([x, 420], [x, 440], [x + 60, 440], [x + 60, 420]).w([x, 380], [x, 360], [x + 60, 360], [x + 60, 380]).gnd([x, 360]).tp([x + 30, 440], k + 1);
      });
    } },
  { id: 'am', group: 'Sources', title: 'AM source and a detector', about: 'A 10 kHz carrier whose size follows a 500 Hz signal; the diode and C1 follow its peaks and give the signal back.\nScope 1 draws the modulated carrier, scope 2 what the detector recovers.',
    draw: (s) => {
      frame(s, 'VAM', { Amplitude: '2', 'Carrier Frequency': '10k', 'Signal Frequency': '500', Depth: '80' }, 440);
      s.put('SCHOTTKY', [260, 460], {}, { q: 1 }); s.put('RES', [360, 400], { Value: '10k' }); s.put('CAP', [440, 400], { Value: '22n' });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [440, 460], [440, 420]).w([360, 460], [360, 420]).j([360, 460]).w([440, 340], [440, 380]).w([360, 380], [360, 340]).j([360, 340]).tp([200, 460], 1).tp([400, 460], 2);
    } },
  { id: 'sweep', group: 'Sources', title: 'Swept sine through a filter', about: 'The source runs from 100 Hz to 10 kHz in 20 ms, again and again: the filter\'s output shrinks as the frequency rises.\nIt is the frequency response drawn against time.',
    draw: (s) => {
      frame(s, 'VSWEEP', { Amplitude: '1', 'Start Frequency': '100', 'End Frequency': '10k', 'Sweep Time': '20m' }, 360);
      s.put('RES', [260, 460], { Value: '1.6k' }, { q: 1 }); s.put('CAP', [360, 400], { Value: '100n' });
      s.w([160, 420], [160, 460], [240, 460]).w([280, 460], [360, 460], [360, 420]).w([360, 340], [360, 380]).tp([200, 460], 1).tp([360, 460], 2);
    } },
  { id: 'noise', group: 'Sources', title: 'Noise through a filter', about: 'Noise with as much at every frequency up to 20 kHz (scope 1), and what a low-pass filter that turns over at 1.6 kHz leaves of it (scope 2).\nSet a scope to Spectrum to see what the filter takes away; turn R1 or C1 to move it.',
    draw: (s) => {
      frame(s, 'VNOISE', { Amplitude: '1', Bandwidth: '20k' }, 400);
      s.put('RES', [280, 460], { Value: '1k' }, { q: 1 }); s.put('CAP', [400, 400], { Value: '100n' });
      s.w([160, 420], [160, 460], [260, 460]).w([300, 460], [400, 460], [400, 420]).w([400, 380], [400, 340]).tp([210, 460], 1).tp([350, 460], 2);
    } },
  { id: 'beats', group: 'Sources', title: 'Two tones beating', speed: 1, about: 'Two sine sources in series, 440 Hz and 444 Hz: their sum swells and fades four times a second, and the speaker across them plays it.\nChange V2\'s frequency to hear the beat quicken. The sound comes half a second of the circuit\'s time at once.',
    draw: (s) => {
      s.put('VSIN', [160, 380], { Amplitude: '1', Frequency: '440' }); s.put('VSIN', [160, 440], { Amplitude: '1', Frequency: '444' }); s.put('SPEAKER', [300, 440], { 'Full Scale': '2' });
      s.w([160, 400], [160, 420]).w([160, 460], [160, 480], [300, 480], [300, 460]).w([300, 420], [300, 340]).w([160, 360], [160, 340], [300, 340]).gnd([160, 340]);
      s.tp([230, 480], 1);
    } },
];

/** An example's sheet as a schematic file. */
export function liveExampleBytes(ex: LiveExample, drawn: SymbolStyle = 'european'): Uint8Array {
  style = drawn;
  const s = new Sketch(ex.title, ex.about);
  ex.draw(s);
  return s.bytes();
}
export const liveExampleFile = (ex: LiveExample): string => `${ex.title.replace(/[\\/:*?"<>|]/g, ' ')}.SchDoc`;
