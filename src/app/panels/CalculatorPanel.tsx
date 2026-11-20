/**
 * Calculators (Tools › Calculators): the sums a designer reaches for with a sheet or a board open,
 * kept beside the work. One list of calculators in two groups: the everyday ones (a divider, parts
 * together, an LED's resistor, RC and LC, Ohm's law, a regulator's feedback pair, reactance, the
 * 555, standard values) and the board's (a track's current and width, its resistance and drop, a
 * via, the spacing for a voltage, impedance). Where a calculator can find any one of its values,
 * Find says which: that box is worked out from the others and cannot be typed in.
 *
 * The sums are src/core/calc.ts and src/analysis/boardCalc.ts; this is their boxes. What is typed
 * is kept from one session to the next.
 */
import { signal } from '@preact/signals';
import { active, tick } from '../state';
import { commands } from '../../core/commands';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../../editors/pcb/PcbLibEditor';
import { isSignal } from '../../model/layers';
import { readStack } from '../../model/pcbStack';
import type { PcbDocument } from '../../model/pcb';
import { METRE } from '../../analysis/copperNet';
import type { LineResult } from '../../analysis/field2d';
import { lineSums, lineWidth, SPACING_COLUMNS, spacingFor, trackSums, viaSums } from '../../analysis/boardCalc';
import {
  bestPair, combine, divider, E_SERIES, feedback, lc, ledResistor, nearestE, ohm, partner, rc, reactance, readQuantity, showQuantity, timerAstable, timerOneShot, typed,
  type ESeries, type OhmPair,
} from '../../core/calc';

type Unit = 'mm' | 'mil';
/** How a box's text is read: a quantity with scale letters, a length in the panel's unit, micrometres, a plain number, a row of quantities. */
type As = 'q' | 'len' | 'um' | 'num' | 'list';
interface Box { id: string; label: string; unit: string; init: string; title: string; as?: As; /** The box's name for a screen reader, where the label alone does not say. */ name?: string }
interface Choice { id: string; label: string; options: [value: string, label: string][]; init: string; title?: string }
interface Out { /** The found box's text. */ found?: Record<string, string>; rows: [string, string][]; note?: string; /** Why there is nothing to show. */ say?: string }
interface Get { q(id: string): number; list(id: string): number[]; pick(id: string): string; find: string; unit: Unit; len(m: number): string }
interface Calc {
  id: string; name: string; group: 'Everyday' | 'Board'; about: string;
  picks?: Choice[];
  /** The values one of which can be found, and the one found to begin with. */
  finds?: [id: string, label: string][];
  boxes(g: Pick<Get, 'pick' | 'unit'>): Box[];
  work(g: Get): Out;
  /** Board calculators: what a board in front can fill in. */
  board?: boolean;
}

const S = (v: number, unit: string, digits = 4) => showQuantity(v, unit, digits);
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(Math.abs(x) < 0.0995 ? 2 : 1)} %`;
const SERIES_PICK: Choice = { id: 'series', label: 'Standard values', options: E_SERIES.map((s) => [s, s]), init: 'E24', title: 'The series the nearest standard values are taken from' };
const NEED = 'Fill in the other boxes.';

const CALCS: Calc[] = [
  {
    id: 'divider', name: 'Voltage divider', group: 'Everyday',
    about: 'R1 from the input to the output, R2 from the output to 0 V. Any one of the four from the other three; a load across R2 is taken in where one is given.',
    picks: [SERIES_PICK],
    finds: [['vout', 'Output voltage'], ['r1', 'R1'], ['r2', 'R2'], ['vin', 'Input voltage']],
    boxes: () => [
      { id: 'vin', label: 'Input', unit: 'V', init: '5', title: 'The voltage across the two resistors' },
      { id: 'r1', label: 'R1', unit: 'Ω', init: '10k', title: 'The upper resistor: from the input to the output' },
      { id: 'r2', label: 'R2', unit: 'Ω', init: '10k', title: 'The lower resistor: from the output to 0 V' },
      { id: 'vout', label: 'Output', unit: 'V', init: '2.5', title: 'The voltage at the join of the two' },
      { id: 'load', label: 'Load', unit: 'Ω', init: '', title: 'What the output feeds, across R2 (empty: nothing)' },
    ],
    work: (g) => {
      const f = g.find as 'vout' | 'r1' | 'r2' | 'vin', load = g.q('load');
      const d = divider(f, { vin: g.q('vin'), r1: g.q('r1'), r2: g.q('r2'), vout: g.q('vout'), load: Number.isFinite(load) ? load : undefined });
      if (!d) return { rows: [], say: f === 'vout' ? NEED : 'These do not make a divider: the output has to be between 0 V and the input.' };
      const rows: [string, string][] = [
        ['Output', S(d.vout, 'V')], ['Output over input', String(Number((d.vout / d.vin).toPrecision(4)))],
        ['Current in R1', S(d.current, 'A')], ['Power in R1', S(d.p1, 'W')], ['Power in R2', S(d.p2, 'W')], ['Output resistance', S(d.rout, 'Ω')],
      ];
      // The nearest standard pair to what was found (with no load, where the pair alone sets the ratio)
      const series = g.pick('series') as ESeries;
      if (!Number.isFinite(load) && d.r1 > 0 && d.r2 > 0) {
        const p = bestPair(d.r1 / d.r2, series, d.r2);
        if (p) { const v = d.vin * p.b / (p.a + p.b); rows.push([`Nearest ${series} pair`, `R1 ${S(p.a, 'Ω')}, R2 ${S(p.b, 'Ω')}: ${S(v, 'V')} (${pct(v / d.vout - 1)})`]); }
      }
      return { found: { vout: typed(d.vout), r1: typed(d.r1), r2: typed(d.r2), vin: typed(d.vin) }, rows };
    },
  },
  {
    id: 'combine', name: 'In series and in parallel', group: 'Everyday',
    about: 'Several parts in a row and side by side. With a value wanted, what to put with the first to make it.',
    picks: [{ id: 'kind', label: 'Parts', options: [['r', 'Resistors or inductors'], ['c', 'Capacitors']], init: 'r' }],
    boxes: (g) => [
      { id: 'values', label: 'Values', unit: '', init: '10k 4k7', title: 'The values, with spaces between them: 10k 4k7 220', as: 'list' },
      { id: 'target', label: 'Wanted', unit: g.pick('kind') === 'c' ? 'F' : 'Ω', init: '', title: 'A value to make from the first of the values and one more part (empty: none)' },
    ],
    work: (g) => {
      const caps = g.pick('kind') === 'c', unit = caps ? 'F' : 'Ω', vals = g.list('values'), c = combine(vals, caps);
      if (!c) return { rows: [], say: 'Type the values with spaces between them: 10k 4k7 220.' };
      const rows: [string, string][] = [['In series', S(c.series, unit)], ['In parallel', S(c.parallel, unit)]];
      const want = g.q('target');
      if (Number.isFinite(want)) {
        const p = partner(vals[0]!, want, caps);
        rows.push([`To make ${S(want, unit)}`, p ? `${S(p.value, unit)} in ${p.how} with ${S(vals[0]!, unit)}` : 'the first value is that already']);
      }
      return { rows };
    },
  },
  {
    id: 'led', name: 'LED resistor', group: 'Everyday',
    about: 'The resistor that sets an LED\'s current from a supply: as worked out, and the next standard value up with the current that gives.',
    picks: [SERIES_PICK],
    boxes: () => [
      { id: 'vs', label: 'Supply', unit: 'V', init: '5', title: 'The supply voltage' },
      { id: 'vf', label: 'LED voltage', unit: 'V', init: '2', title: 'The LED\'s forward voltage at the current wanted' },
      { id: 'i', label: 'Current', unit: 'A', init: '10m', title: 'The current wanted: 10m is 10 mA' },
      { id: 'n', label: 'LEDs in a row', unit: '', init: '1', title: 'How many LEDs are in series with the one resistor', as: 'num' },
    ],
    work: (g) => {
      const series = g.pick('series') as ESeries, r = ledResistor(g.q('vs'), g.q('vf'), g.q('i'), Math.round(g.q('n')), series);
      if (!r) return { rows: [], say: 'The supply has to be more than the LEDs\' voltage together.' };
      return { rows: [['Resistor', S(r.r, 'Ω')], [`Next ${series} value up`, S(r.standard, 'Ω')], ['Current with it', S(r.current, 'A')], ['Power in the resistor', S(r.pResistor, 'W')], ['Power in each LED', S(r.pLed, 'W')]] };
    },
  },
  {
    id: 'rc', name: 'R and C: time constant and corner', group: 'Everyday',
    about: 'A resistor and a capacitor: the time constant RC and the corner frequency 1 / (2πRC). Any one of the three from the other two.',
    finds: [['f', 'Corner frequency'], ['r', 'Resistor'], ['c', 'Capacitor']],
    boxes: () => [
      { id: 'r', label: 'Resistor', unit: 'Ω', init: '10k', title: 'The resistance' },
      { id: 'c', label: 'Capacitor', unit: 'F', init: '100n', title: 'The capacitance: 100n is 100 nF' },
      { id: 'f', label: 'Corner', unit: 'Hz', init: '159.2', title: 'Where the response is 3 dB down' },
    ],
    work: (g) => {
      const x = rc(g.find as 'f' | 'r' | 'c', { r: g.q('r'), c: g.q('c'), f: g.q('f') });
      if (!x) return { rows: [], say: NEED };
      return { found: { r: typed(x.r), c: typed(x.c), f: typed(x.f) }, rows: [['Time constant', S(x.tau, 's')], ['Corner frequency', S(x.f, 'Hz')], ['To 90 % of a step', S(x.tau * Math.LN10, 's')], ['To 99 %', S(x.tau * Math.log(100), 's')], ['Rise time, 10 to 90 %', S(x.tau * Math.log(9), 's')]] };
    },
  },
  {
    id: 'lc', name: 'L and C: resonance', group: 'Everyday',
    about: 'An inductor and a capacitor resonate at 1 / (2π√(LC)). Any one of the three from the other two.',
    finds: [['f', 'Frequency'], ['l', 'Inductor'], ['c', 'Capacitor']],
    boxes: () => [
      { id: 'l', label: 'Inductor', unit: 'H', init: '10u', title: 'The inductance: 10u is 10 µH' },
      { id: 'c', label: 'Capacitor', unit: 'F', init: '100n', title: 'The capacitance' },
      { id: 'f', label: 'Frequency', unit: 'Hz', init: '159.2k', title: 'The resonant frequency' },
    ],
    work: (g) => {
      const x = lc(g.find as 'f' | 'l' | 'c', { l: g.q('l'), c: g.q('c'), f: g.q('f') });
      if (!x) return { rows: [], say: NEED };
      return { found: { l: typed(x.l), c: typed(x.c), f: typed(x.f) }, rows: [['Resonant frequency', S(x.f, 'Hz')], ['Characteristic impedance', S(x.z, 'Ω')]] };
    },
  },
  {
    id: 'ohm', name: 'Ohm\'s law and power', group: 'Everyday',
    about: 'Any two of voltage, current, resistance and power give the other two.',
    picks: [{ id: 'known', label: 'Known', options: [['vi', 'Voltage and current'], ['vr', 'Voltage and resistance'], ['vp', 'Voltage and power'], ['ir', 'Current and resistance'], ['ip', 'Current and power'], ['rp', 'Resistance and power']], init: 'vr' }],
    boxes: (g) => {
      const all: Record<string, Box> = {
        v: { id: 'v', label: 'Voltage', unit: 'V', init: '5', title: 'The voltage across it' },
        i: { id: 'i', label: 'Current', unit: 'A', init: '10m', title: 'The current through it' },
        r: { id: 'r', label: 'Resistance', unit: 'Ω', init: '1k', title: 'Its resistance' },
        p: { id: 'p', label: 'Power', unit: 'W', init: '250m', title: 'The power in it' },
      };
      return [...g.pick('known')].map((k) => all[k]!);
    },
    work: (g) => {
      const known = g.pick('known') as OhmPair, x = ohm(known, g.q(known[0]!), g.q(known[1]!));
      if (!x) return { rows: [], say: NEED };
      return { rows: [['Voltage', S(x.v, 'V')], ['Current', S(x.i, 'A')], ['Resistance', S(x.r, 'Ω')], ['Power', S(x.p, 'W')]] };
    },
  },
  {
    id: 'feedback', name: 'Regulator feedback pair', group: 'Everyday',
    about: 'The two resistors that set an adjustable regulator\'s output. With a feedback pin the reference is across the lower one; with an adjust pin (an LM317 and its like) across the upper, and the pin\'s own current flows in the lower.',
    picks: [{ id: 'kind', label: 'Regulator', options: [['fb', 'With a feedback pin'], ['adj', 'With an adjust pin (LM317)']], init: 'fb' }, SERIES_PICK],
    finds: [['vout', 'Output voltage'], ['upper', 'Upper resistor'], ['lower', 'Lower resistor']],
    boxes: (g) => [
      { id: 'vref', label: 'Reference', unit: 'V', init: g.pick('kind') === 'adj' ? '1.25' : '0.8', title: 'The regulator\'s reference voltage, from its data sheet (an LM317\'s is 1.25 V)' },
      { id: 'vout', label: 'Output', unit: 'V', init: '3.3', title: 'The output voltage' },
      { id: 'upper', label: 'Upper', unit: 'Ω', init: g.pick('kind') === 'adj' ? '240' : '31.25k', title: 'From the output to the pin', name: 'Upper resistor' },
      { id: 'lower', label: 'Lower', unit: 'Ω', init: g.pick('kind') === 'adj' ? '390' : '10k', title: 'From the pin to 0 V', name: 'Lower resistor' },
      ...(g.pick('kind') === 'adj' ? [{ id: 'iadj', label: 'Pin current', unit: 'A', init: '50u', title: 'The adjust pin\'s own current (an LM317\'s is about 50 µA)' } as Box] : []),
    ],
    work: (g) => {
      const kind = g.pick('kind') as 'fb' | 'adj', iadj = g.q('iadj'), vref = g.q('vref');
      const x = feedback(g.find as 'vout' | 'upper' | 'lower', kind, { vref, vout: g.q('vout'), upper: g.q('upper'), lower: g.q('lower'), iadj: Number.isFinite(iadj) ? iadj : 0 });
      if (!x) return { rows: [], say: 'These do not make a pair: the output has to be above the reference.' };
      const rows: [string, string][] = [['Output', S(x.vout, 'V')], ['Upper', S(x.upper, 'Ω')], ['Lower', S(x.lower, 'Ω')], ['Current in the pair', S(x.current, 'A')]];
      // The standard pair: the ratio is other / across, the one the reference stands across kept in its decade
      const series = g.pick('series') as ESeries, across = kind === 'fb' ? x.lower : x.upper, other = kind === 'fb' ? x.upper : x.lower;
      const p = other > 0 ? bestPair(other / across, series, across) : null;
      if (p) {
        const up = kind === 'fb' ? p.a : p.b, low = kind === 'fb' ? p.b : p.a, v = feedback('vout', kind, { vref, upper: up, lower: low, iadj: Number.isFinite(iadj) ? iadj : 0 })!.vout;
        rows.push([`Nearest ${series} pair`, `upper ${S(up, 'Ω')}, lower ${S(low, 'Ω')}: ${S(v, 'V')} (${pct(v / x.vout - 1)})`]);
      }
      return { found: { vout: typed(x.vout), upper: typed(x.upper), lower: typed(x.lower) }, rows };
    },
  },
  {
    id: 'reactance', name: 'Reactance', group: 'Everyday',
    about: 'What a capacitor and an inductor are worth in ohms at a frequency: 1 / (2πfC) and 2πfL. Fill in either or both.',
    boxes: () => [
      { id: 'f', label: 'Frequency', unit: 'Hz', init: '1k', title: 'The frequency' },
      { id: 'c', label: 'Capacitor', unit: 'F', init: '100n', title: 'A capacitance (empty: none)' },
      { id: 'l', label: 'Inductor', unit: 'H', init: '', title: 'An inductance (empty: none)' },
    ],
    work: (g) => {
      const c = g.q('c'), l = g.q('l'), x = reactance(g.q('f'), Number.isFinite(c) ? c : undefined, Number.isFinite(l) ? l : undefined);
      if (!x) return { rows: [], say: 'Give a frequency and a capacitor or an inductor.' };
      const rows: [string, string][] = [];
      if (x.xc !== undefined) rows.push(['The capacitor', S(x.xc, 'Ω')]);
      if (x.xl !== undefined) rows.push(['The inductor', S(x.xl, 'Ω')]);
      if (x.xc !== undefined && x.xl !== undefined) rows.push(['They are equal at', S(1 / (2 * Math.PI * Math.sqrt(l * c)), 'Hz')]);
      return { rows };
    },
  },
  {
    id: 'timer', name: '555 timer', group: 'Everyday',
    about: 'The 555 running free (R1 from the supply to pin 7, R2 from pin 7 to pins 6 and 2, C from there to 0 V) or as a one-shot (R and C on pins 6 and 7).',
    picks: [{ id: 'mode', label: 'Wired as', options: [['astable', 'Running free (astable)'], ['oneshot', 'A one-shot (monostable)']], init: 'astable' }],
    boxes: (g) => (g.pick('mode') === 'astable' ? [
      { id: 'r1', label: 'R1', unit: 'Ω', init: '10k', title: 'From the supply to the discharge pin' },
      { id: 'r2', label: 'R2', unit: 'Ω', init: '47k', title: 'From the discharge pin to the threshold and trigger pins' },
      { id: 'c', label: 'C', unit: 'F', init: '10u', title: 'The timing capacitor' },
    ] : [
      { id: 'r', label: 'R', unit: 'Ω', init: '100k', title: 'From the supply to the threshold and discharge pins' },
      { id: 'c', label: 'C', unit: 'F', init: '10u', title: 'The timing capacitor' },
    ]),
    work: (g) => {
      if (g.pick('mode') === 'oneshot') { const t = timerOneShot(g.q('r'), g.q('c')); return t === null ? { rows: [], say: NEED } : { rows: [['Pulse', S(t, 's')]] }; }
      const x = timerAstable(g.q('r1'), g.q('r2'), g.q('c'));
      if (!x) return { rows: [], say: NEED };
      return { rows: [['Frequency', S(x.f, 'Hz')], ['Period', S(x.period, 's')], ['High for', S(x.high, 's')], ['Low for', S(x.low, 's')], ['High for this much of it', `${(x.duty * 100).toFixed(1)} %`]] };
    },
  },
  {
    id: 'standard', name: 'Nearest standard value', group: 'Everyday',
    about: 'The standard values nearest to a value, series by series, and how far off each is.',
    boxes: () => [{ id: 'v', label: 'Value', unit: '', init: '4.99k', title: 'Any value: 4.99k, 68n, 2.2Meg' }],
    work: (g) => {
      const v = g.q('v');
      if (!(v > 0) || !Number.isFinite(v)) return { rows: [], say: 'Type a value: 4.99k, 68n, 2.2Meg.' };
      return { rows: E_SERIES.map((s) => { const e = nearestE(v, s); return [s, `${S(e.value, '', 5).trim()} (${pct(e.error)})${e.below !== e.above ? `, between ${S(e.below, '', 5).trim()} and ${S(e.above, '', 5).trim()}` : ''}`]; }) };
    },
  },
  {
    id: 'track', name: 'Track: current, width and drop', group: 'Board', board: true,
    about: 'What a track carries for a rise in its temperature, by IPC-2221\'s chart as Power Analysis uses it: any one of width, current and rise from the other two. With a length, its resistance and the voltage it drops.',
    picks: [{ id: 'layer', label: 'Layer', options: [['outer', 'An outer layer'], ['inner', 'Inside the board']], init: 'outer', title: 'A track inside the board sheds its heat less well: half the current for the same rise' }],
    finds: [['width', 'Width'], ['current', 'Current'], ['rise', 'Temperature rise']],
    boxes: (g) => [
      { id: 'current', label: 'Current', unit: 'A', init: '1', title: 'The current the track carries' },
      { id: 'width', label: 'Width', unit: g.unit, init: g.unit === 'mm' ? '0.3' : '12', title: 'The track\'s width', as: 'len' },
      { id: 'rise', label: 'Rise', unit: '°C', init: '10', title: 'How much warmer than the board about it the track may run', as: 'num', name: 'Temperature rise' },
      { id: 'copper', label: 'Copper', unit: 'µm', init: '35', title: 'The copper\'s thickness: 35 µm is 1 oz, 17.5 µm half an ounce, 70 µm two', as: 'um', name: 'Copper thickness' },
      { id: 'length', label: 'Length', unit: g.unit, init: '', title: 'The track\'s length, for its resistance and drop (empty: none)', as: 'len' },
      { id: 'ambient', label: 'Board at', unit: '°C', init: '25', title: 'The temperature of the board about the track', as: 'num', name: 'Board temperature' },
    ],
    work: (g) => {
      const length = g.q('length'), ambient = g.q('ambient');
      const t = trackSums(g.find as 'width' | 'current' | 'rise', { width: g.q('width'), current: g.q('current'), rise: g.q('rise'), thickness: g.q('copper'), inner: g.pick('layer') === 'inner', length: Number.isFinite(length) ? length : undefined, ambient: Number.isFinite(ambient) ? ambient : 25 });
      if (!t) return { rows: [], say: NEED };
      const rows: [string, string][] = [['Width', `${g.len(t.width)} ${g.unit}`], ['Current', S(t.current, 'A')], ['Temperature rise', `${Number(t.rise.toPrecision(3))} °C`], ['Cross-section', `${Number((t.area * 1e6).toPrecision(3))} mm²`]];
      if (t.resistance !== undefined) rows.push(['Resistance', S(t.resistance, 'Ω')], ['Voltage dropped', S(t.drop!, 'V')], ['Power lost', S(t.loss!, 'W')]);
      return { found: { width: g.len(t.width), current: typed(t.current), rise: String(Number(t.rise.toPrecision(3))) }, rows, note: t.outside.length ? `Beyond IPC-2221's chart (${t.outside.join(', ')}): take the figure as a guide.` : undefined };
    },
  },
  {
    id: 'via', name: 'Via: current and resistance', group: 'Board', board: true,
    about: 'A via\'s barrel as a conductor: what it carries for a rise (IPC-2221, as a conductor inside the board, the way Power Analysis rates one), its resistance, thermal resistance and inductance. With a current, what each of several carries and drops.',
    boxes: (g) => [
      { id: 'hole', label: 'Hole', unit: g.unit, init: g.unit === 'mm' ? '0.3' : '12', title: 'The finished hole\'s diameter', as: 'len' },
      { id: 'plating', label: 'Plating', unit: 'µm', init: '25', title: 'The copper on the hole\'s wall: 25 µm (1 mil) is usual', as: 'um' },
      { id: 'length', label: 'Board', unit: g.unit, init: g.unit === 'mm' ? '1.6' : '63', title: 'The via\'s length: the board\'s thickness, for a through via', as: 'len', name: 'Board thickness' },
      { id: 'rise', label: 'Rise', unit: '°C', init: '10', title: 'How much warmer than the board the barrel may run', as: 'num', name: 'Temperature rise' },
      { id: 'current', label: 'Current', unit: 'A', init: '', title: 'A current to carry (empty: none)' },
      { id: 'count', label: 'Vias', unit: '', init: '1', title: 'How many vias share the current', as: 'num' },
    ],
    work: (g) => {
      const current = g.q('current'), count = g.q('count');
      const v = viaSums({ hole: g.q('hole'), plating: g.q('plating'), length: g.q('length'), rise: g.q('rise'), current: Number.isFinite(current) ? current : undefined, count: Number.isFinite(count) ? count : 1 });
      if (!v) return { rows: [], say: NEED };
      const rows: [string, string][] = [['One via carries', S(v.current, 'A')], ['Resistance', S(v.resistance, 'Ω')], ['Thermal resistance', `${Number(v.thermal.toPrecision(3))} °C/W`], ['Inductance', S(v.inductance, 'H')], ['Copper cross-section', `${Number((v.area * 1e6).toPrecision(3))} mm²`]];
      if (v.each !== undefined) rows.push(['Current in each', S(v.each, 'A')], ['Voltage dropped', S(v.drop!, 'V')], ['Its rise', `${Number(v.rise!.toPrecision(3))} °C`]);
      return { rows };
    },
  },
  {
    id: 'spacing', name: 'Spacing for a voltage', group: 'Board',
    about: 'The least spacing between two conductors for the voltage between them, from IPC-2221B\'s table. The voltage is the peak (of AC, or DC). Safety standards for mains ask for more: this is the board standard\'s figure.',
    boxes: () => [{ id: 'v', label: 'Voltage', unit: 'V', init: '50', title: 'The peak voltage between the two conductors' }],
    work: (g) => {
      const mm = spacingFor(g.q('v'));
      if (!mm) return { rows: [], say: 'Give the voltage between the two conductors.' };
      return { rows: SPACING_COLUMNS.map((c, i) => [c.name, `${Number((mm[i]! * 1e3).toPrecision(4))} mm (${Number((mm[i]! / 25.4e-6).toPrecision(3))} mil)`]) };
    },
  },
  {
    id: 'impedance', name: 'Track impedance', group: 'Board', board: true,
    about: 'A single track\'s impedance from its cross-section, as the Field Solver solves it: on the surface over a plane, or between two planes. Either the impedance of a width or the width for an impedance. For a pair, solder mask or grounds beside it, use Tools › Field Solver.',
    picks: [{ id: 'kind', label: 'Track', options: [['microstrip', 'On the surface (microstrip)'], ['stripline', 'Between two planes (stripline)']], init: 'microstrip' }],
    finds: [['z', 'Impedance'], ['width', 'Width']],
    boxes: (g) => [
      { id: 'width', label: 'Width', unit: g.unit, init: g.unit === 'mm' ? '0.36' : '14', title: 'The track\'s width', as: 'len' },
      { id: 'z', label: 'Impedance', unit: 'Ω', init: '50', title: 'The impedance' },
      { id: 'height', label: 'Height', unit: g.unit, init: g.unit === 'mm' ? '0.2' : '8', title: 'The dielectric under the track, down to the plane', as: 'len' },
      ...(g.pick('kind') === 'stripline' ? [{ id: 'above', label: 'To the plane above', unit: g.unit, init: g.unit === 'mm' ? '0.2' : '8', title: 'From the track\'s foot up to the upper plane', as: 'len' } as Box] : []),
      { id: 'er', label: 'Constant', unit: '', init: '4.3', title: 'The dielectric constant', as: 'num', name: 'Dielectric constant' },
      { id: 'copper', label: 'Copper', unit: 'µm', init: '35', title: 'The copper\'s thickness, plating included', as: 'um', name: 'Copper thickness' },
    ],
    work: (g) => {
      const kind = g.pick('kind') as 'microstrip' | 'stripline', base = { kind, thickness: g.q('copper'), height: g.q('height'), er: g.q('er'), above: kind === 'stripline' ? g.q('above') : undefined };
      const key = JSON.stringify([g.find, base, g.find === 'z' ? g.q('width') : g.q('z')]);
      const got = lineJob.value;
      if (got?.key !== key) { startLine(key, () => { const width = g.find === 'z' ? g.q('width') : lineWidth(g.q('z'), base); const r = width ? lineSums({ ...base, width }) : null; return r && width ? { width, r } : null; }); return { rows: [], say: 'Working it out...' }; }
      if (got.busy) return { rows: [], say: 'Working it out...' };
      if (!got.done) return { rows: [], say: NEED };
      const { width, r } = got.done;
      return {
        found: { z: String(Number(r.z0.toPrecision(4))), width: g.len(width) },
        rows: [['Impedance', `${r.z0.toFixed(r.z0 >= 100 ? 1 : 2)} Ω`], ['Width', `${g.len(width)} ${g.unit}`], ['Effective constant', r.eff.toFixed(3)], ['Delay', `${(r.delay * 1e9).toFixed(3)} ps/mm, ${(r.delay * 1e12 * 0.0254).toFixed(1)} ps/in`], ['Capacitance', `${(r.c * 1e10).toFixed(3)} pF/cm`], ['Inductance', `${(r.l * 1e7).toFixed(3)} nH/cm`]],
      };
    },
  },
];

/** The impedance takes a moment (a width for an impedance a second or two): worked out after the panel has drawn, and kept for the boxes as they stand. */
const lineJob = signal<{ key: string; busy: boolean; done: { width: number; r: LineResult } | null } | null>(null);
function startLine(key: string, work: () => { width: number; r: LineResult } | null): void {
  queueMicrotask(() => {
    if (lineJob.peek()?.key === key) return;
    lineJob.value = { key, busy: true, done: null };
    setTimeout(() => { let done: { width: number; r: LineResult } | null = null; try { done = work(); } catch { done = null; } if (lineJob.peek()?.key === key) lineJob.value = { key, busy: false, done }; }, 30);
  });
}

// ---- What is typed, kept ----

interface Kept { calc: string; unit: Unit; text: Record<string, string>; find: Record<string, string>; pick: Record<string, string> }
const KEY = 'calculators.v1';
function readKept(): Kept {
  const fresh: Kept = { calc: 'divider', unit: 'mm', text: {}, find: {}, pick: {} };
  try {
    const j = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? 'null') as Partial<Kept> | null;
    if (j && typeof j === 'object') return { ...fresh, ...j, calc: CALCS.some((c) => c.id === j.calc) ? j.calc! : 'divider', unit: j.unit === 'mil' ? 'mil' : 'mm', text: { ...j.text }, find: { ...j.find }, pick: { ...j.pick } };
  } catch { /* not there, or not JSON */ }
  return fresh;
}
const kept = signal<Kept | null>(null);
const save = (k: Kept) => { kept.value = k; try { globalThis.localStorage?.setItem(KEY, JSON.stringify(k)); } catch { /* no room */ } };

/** The calculators and what each offers, for the tests and the guide. */
export const CALCULATORS: { id: string; name: string; group: string }[] = CALCS.map((c) => ({ id: c.id, name: c.name, group: c.group }));

/** A calculator worked with texts for its boxes (the ones not given stand as they first do), for the tests: the found box's text and the rows. */
export function workCalculator(id: string, text: Record<string, string> = {}, opts: { find?: string; pick?: Record<string, string>; unit?: Unit } = {}): Out {
  const c = CALCS.find((x) => x.id === id)!;
  return work(c, { calc: id, unit: opts.unit ?? 'mm', text: Object.fromEntries(Object.entries(text).map(([k, v]) => [`${id}.${k}`, v])), find: opts.find ? { [id]: opts.find } : {}, pick: Object.fromEntries(Object.entries(opts.pick ?? {}).map(([k, v]) => [`${id}.${k}`, v])) });
}

const unitM = (u: Unit) => (u === 'mil' ? 25.4e-6 : 1e-3);
function getter(c: Calc, k: Kept): Get & { boxes: Box[] } {
  const pick = (id: string) => { const p = c.picks?.find((x) => x.id === id); const v = k.pick[`${c.id}.${id}`]; return p && p.options.some((o) => o[0] === v) ? v! : p?.init ?? ''; };
  const boxes = c.boxes({ pick, unit: k.unit });
  const textOf = (id: string) => k.text[`${c.id}.${id}`] ?? boxes.find((b) => b.id === id)?.init ?? '';
  const plain = (s: string) => { const t = s.trim().replace(',', '.'); return t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) ? NaN : Number(t); };
  return {
    boxes, pick, unit: k.unit, find: c.finds?.some((f) => f[0] === k.find[c.id]) ? k.find[c.id]! : c.finds?.[0]?.[0] ?? '',
    q: (id) => {
      const b = boxes.find((x) => x.id === id), t = textOf(id);
      if (!b || t.trim() === '') return NaN;
      return b.as === 'len' ? plain(t) * unitM(k.unit) : b.as === 'um' ? plain(t) * 1e-6 : b.as === 'num' ? plain(t) : readQuantity(t);
    },
    list: (id) => textOf(id).split(/[\s;+]+/).filter(Boolean).map(readQuantity),
    len: (m) => String(Number((m / unitM(k.unit)).toPrecision(4))),
  };
}
function work(c: Calc, k: Kept): Out {
  try { return c.work(getter(c, k)); } catch { return { rows: [], say: NEED }; }
}

// ---- From the board in front ----

/** A signal layer's copper thickness (m) and whether it is inside the board; the board's thickness (its copper and dielectrics together). */
function stackOf(doc: PcbDocument): { copper(layer: number): { thickness: number; inner: boolean } | null; thickness: number } {
  const rows = doc.board.bag ? readStack(doc.board.bag, doc.board.copperStack) : [];
  const coppers = rows.filter((r) => r.kind === 'signal' || r.kind === 'plane');
  let thickness = 0;
  for (const r of rows) thickness += r.kind === 'signal' || r.kind === 'plane' ? r.copper : r.kind === 'dielectric' ? r.height : 0;
  return {
    thickness: thickness * METRE,
    copper: (layer) => { const at = coppers.findIndex((r) => r.layer === layer); return at < 0 ? null : { thickness: (coppers[at]!.copper > 0 ? coppers[at]!.copper * METRE : 35e-6), inner: at > 0 && at < coppers.length - 1 }; },
  };
}

export function CalculatorPanel() {
  void tick.value; void lineJob.value;
  if (!kept.value) kept.value = readKept();
  const k = kept.value, c = CALCS.find((x) => x.id === k.calc) ?? CALCS[0]!, g = getter(c, k), out = work(c, k);
  const od = active.value, e = od?.editor instanceof PcbEditor && !(od.editor instanceof PcbLibEditor) ? od.editor : null;
  const setText = (id: string, v: string) => save({ ...k, text: { ...k.text, [`${c.id}.${id}`]: v } });
  const setMany = (patch: Record<string, string>, picks: Record<string, string> = {}) => save({
    ...k, text: { ...k.text, ...Object.fromEntries(Object.entries(patch).map(([id, v]) => [`${c.id}.${id}`, v])) }, pick: { ...k.pick, ...Object.fromEntries(Object.entries(picks).map(([id, v]) => [`${c.id}.${id}`, v])) },
  });
  const um = (m: number) => String(Number((m * 1e6).toPrecision(4)));
  const changeUnit = (to: Unit) => {
    if (to === k.unit) return;
    // Every length typed, in every calculator, goes over to the new unit
    const f = to === 'mil' ? 1 / 0.0254 : 0.0254, text = { ...k.text };
    for (const cc of CALCS) for (const b of cc.boxes({ pick: (id) => k.pick[`${cc.id}.${id}`] ?? cc.picks?.find((p) => p.id === id)?.init ?? '', unit: k.unit })) {
      const key = `${cc.id}.${b.id}`, v = parseFloat((text[key] ?? '').replace(',', '.'));
      if (b.as === 'len' && text[key] !== undefined && Number.isFinite(v)) text[key] = String(Number((v * f).toPrecision(4)));
    }
    save({ ...k, unit: to, text });
  };
  // From the board in front: the selected track or via, a layer's stack
  const sel = e ? [...e.selection].map((key) => e.primByKey(key)) : [], stack = e ? stackOf(e.doc) : null;
  const tracks = sel.filter((p) => p?.kind === 'track' || p?.kind === 'arc'), via = sel.find((p) => p?.kind === 'via');
  const fromTrack = () => {
    const first = tracks[0];
    if (!e || !stack || !first || !('width' in first)) return;
    let length = 0;
    for (const p of tracks) if (p?.kind === 'track') length += Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y); else if (p?.kind === 'arc') { let sweep = (p.end - p.start) % 360; if (sweep <= 0) sweep += 360; length += (p.r * sweep * Math.PI) / 180; }
    const cu = stack.copper(first.layer);
    setMany({ width: g.len(first.width * METRE), ...(c.id === 'track' ? { length: g.len(length * METRE) } : {}), ...(cu ? { copper: um(cu.thickness) } : {}) }, c.id === 'track' && cu ? { layer: cu.inner ? 'inner' : 'outer' } : {});
  };
  const fromVia = () => { if (e && stack && via?.kind === 'via') setMany({ hole: g.len(via.hole * METRE), ...(stack.thickness > 0 ? { length: g.len(stack.thickness) } : {}) }); };
  const layers = e && c.id === 'impedance' ? e.doc.board.copperStack.filter(isSignal) : [];
  const fromLayer = (layer: number) => {
    if (!e) return;
    const rows = e.doc.board.bag ? readStack(e.doc.board.bag, e.doc.board.copperStack) : [], at = rows.findIndex((r) => (r.kind === 'signal' || r.kind === 'plane') && r.layer === layer);
    if (at < 0) return;
    const between = (dir: 1 | -1) => {
      let h = 0, hOverE = 0, copper = false;
      for (let i = at + dir; i >= 0 && i < rows.length; i += dir) { const r = rows[i]!; if (r.kind === 'signal' || r.kind === 'plane') { copper = true; break; } if (r.kind === 'dielectric' && r.height > 0) { h += r.height; hOverE += r.height / Math.max(r.dielConst, 1); } }
      return copper && h > 0 ? { h: h * METRE, er: h / hOverE } : null;
    };
    const below = between(1), over = between(-1), t = rows[at]!.copper > 0 ? rows[at]!.copper * METRE : 35e-6, one = below ?? over;
    if (!one) return;
    // An inner layer between two coppers is a stripline (the nearer dielectric under it); an outer one a microstrip
    if (below && over) setMany({ height: g.len(below.h), above: g.len(over.h + t), er: String(Number(((below.h + over.h) / (below.h / below.er + over.h / over.er)).toPrecision(3))), copper: um(t) }, { kind: 'stripline' });
    else setMany({ height: g.len(one.h), er: String(Number(one.er.toPrecision(3))), copper: um(t) }, { kind: 'microstrip' });
  };
  const hasLengths = g.boxes.some((b) => b.as === 'len');
  return (
    <div class="panel-body powerpanel calcpanel">
      <section aria-label="Calculator">
        <label class="pw-field">Calculator <select aria-label="Calculator" value={c.id} onChange={(ev) => save({ ...k, calc: (ev.target as HTMLSelectElement).value })}>
          {(['Everyday', 'Board'] as const).map((grp) => <optgroup key={grp} label={grp === 'Everyday' ? 'Everyday' : 'The board'}>{CALCS.filter((x) => x.group === grp).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>)}
        </select></label>
        <p class="muted small">{c.about}</p>
      </section>
      <section aria-label="Values">
        {c.picks?.filter((p) => p.id !== 'series').map((p) => (
          <label key={p.id} class="pw-field" title={p.title}>{p.label} <select aria-label={p.label} value={g.pick(p.id)} onChange={(ev) => save({ ...k, pick: { ...k.pick, [`${c.id}.${p.id}`]: (ev.target as HTMLSelectElement).value } })}>{p.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        ))}
        {c.finds && <label class="pw-field" title="The value worked out from the others">Find <select aria-label="Find" value={g.find} onChange={(ev) => save({ ...k, find: { ...k.find, [c.id]: (ev.target as HTMLSelectElement).value } })}>{c.finds.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>}
        {hasLengths && <label class="pw-field">Lengths in <select aria-label="Lengths in" value={k.unit} onChange={(ev) => changeUnit((ev.target as HTMLSelectElement).value as Unit)}><option value="mm">mm</option><option value="mil">mil</option></select></label>}
        {g.boxes.map((b) => {
          const found = !!c.finds && b.id === g.find;
          return (
            <label key={`${c.id}.${b.id}`} class={`pw-field${found ? ' calc-found' : ''}`} title={found ? `${b.title}: worked out from the others` : b.title}>{b.label} <input
              aria-label={b.name ?? b.label} inputMode={b.as === 'list' ? 'text' : 'decimal'} readOnly={found}
              value={found ? out.found?.[b.id] ?? '' : k.text[`${c.id}.${b.id}`] ?? b.init}
              onChange={(ev) => { if (!found) setText(b.id, (ev.target as HTMLInputElement).value.trim()); }} /> {b.unit}</label>
          );
        })}
        {c.picks?.filter((p) => p.id === 'series').map((p) => (
          <label key={p.id} class="pw-field" title={p.title}>{p.label} <select aria-label={p.label} value={g.pick(p.id)} onChange={(ev) => save({ ...k, pick: { ...k.pick, [`${c.id}.${p.id}`]: (ev.target as HTMLSelectElement).value } })}>{p.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        ))}
        {e && c.board && (c.id === 'track' || c.id === 'impedance') && <button class="btn" disabled={!tracks.length} title="The selected track's width and its layer's copper; for the current calculator its length too (several tracks: their lengths together)" onClick={fromTrack}>From the selected track</button>}
        {e && c.id === 'via' && <button class="btn" disabled={!via} title="The selected via's hole, and the board's thickness from its layer stack" onClick={fromVia}>From the selected via</button>}
        {e && c.id === 'impedance' && layers.length > 0 && <label class="pw-field" title="The dielectric about a signal layer and its copper, as the Layer Stack Manager has them">From the board <select aria-label="From the board" value="" onChange={(ev) => { const v = (ev.target as HTMLSelectElement).value; if (v) fromLayer(Number(v)); (ev.target as HTMLSelectElement).value = ''; }}>
          <option value="">(take a layer's stack)</option>{layers.map((l) => <option key={l} value={l}>{e.layerLabel(l)}</option>)}
        </select></label>}
      </section>
      <section aria-label="Results" class="pw-results">
        <h4>Results</h4>
        {out.rows.length > 0 && <dl class="field-figures">{out.rows.map(([name, value]) => <><dt>{name}</dt><dd>{value}</dd></>)}</dl>}
        {out.say && <p class="muted small" role="status">{out.say}</p>}
        {out.note && <p class="muted small">{out.note}</p>}
        {c.id === 'impedance' && e && <button class="btn" onClick={() => void commands.run('field.panel', 'pcb')}>Open the Field Solver</button>}
      </section>
    </div>
  );
}
