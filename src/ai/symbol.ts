/**
 * A schematic symbol from a variant's pins as read: a rectangle with the pins round it on a 100 mil
 * grid — supplies on top, grounds below, inputs down the left, outputs down the right, the rest
 * by function group to balance the sides, each group together with a gap between groups; a
 * connector's pins in number order down one side (two when there are many). Pin names with an
 * active-low mark get AD's overbar (a backslash after each letter); not-connected pins stay
 * (they are pads of the footprint) at the foot of the right side. The designator prefix is the
 * part's (U, J, Q …), the comment the device, and the footprint, given, linked as AD links it.
 */
import type { PinsRead, PinType, SymbolPin } from './jobs';
import { SymbolBuilder } from '../formats/synthetic/demoLib';
import type { PropertyBag } from '../formats/altium/props';
import { SR } from '../model/sch';

export type Side = 'left' | 'right' | 'top' | 'bottom';
export const SIDES: Side[] = ['left', 'right', 'top', 'bottom'];

/** AD's electrical types: Input 0, I/O 1, Output 2, Open Collector 3, Passive 4, HiZ 5, Open Emitter 6, Power 7. */
const ELECTRICAL: Record<PinType, number> = { input: 0, io: 1, output: 2, oc: 3, passive: 4, hiz: 5, oe: 6, power: 7, ground: 7, nc: 4 };

/** A name with AD's overbar (each letter followed by a backslash). */
export const overbar = (name: string) => [...name].map((c) => `${c}\\`).join('');

/** Pin numbers in their natural order (2 before 10, A2 before A10, B1 after A12). */
export const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/** A diode's cathode by its name (K, CATHODE, YG_K, LED-K …); a transistor's terminals by theirs. */
const CATHODE = /(^|[_\-\s.])(K|KA|CATH|CATHODE)\d*$/i;
const CONTROL = /^(B|G|BASE|GATE)\d*$/i, MAIN = /^(C|D|COLLECTOR|DRAIN)\d*$/i, COMMON = /^(E|S|EMITTER|SOURCE)\d*$/i;

/**
 * Each pin's side: supplies on top, grounds below; a connector's in number order down the left
 * (half on the right when there are more than 24); inputs left, outputs, open and three-state
 * outputs right, not-connected right; the other groups (I/O, passive) each whole on the side with
 * fewer pins. A diode's (an LED's) anodes left and cathodes right; a transistor's base or gate
 * left, collector or drain right, emitter or source below.
 */
export function sidesOf(read: Pick<PinsRead, 'kind' | 'pins'>): Side[] {
  const pins = read.pins;
  if (read.kind === 'diode') return pins.map((p) => (CATHODE.test(p.name) || (/cathode/i.test(p.description) && !/anode/i.test(p.description)) ? 'right' : 'left'));
  if (read.kind === 'transistor') {
    return pins.map((p) => (CONTROL.test(p.name) ? 'left' : COMMON.test(p.name) ? 'bottom' : MAIN.test(p.name) ? 'right'
      : p.type === 'input' ? 'left' : p.type === 'ground' ? 'bottom' : 'right'));
  }
  if (read.kind === 'connector' || read.kind === 'passive') {
    const order = pins.map((_, i) => i).sort((a, b) => byNumber(pins[a]!.number, pins[b]!.number));
    const out: Side[] = pins.map(() => 'left');
    if (pins.length > 24) order.forEach((j, k) => { out[j] = k < Math.ceil(order.length / 2) ? 'left' : 'right'; });
    return out;
  }
  const out: Side[] = pins.map((p) => (p.type === 'power' ? 'top' : p.type === 'ground' ? 'bottom' : p.type === 'input' ? 'left'
    : p.type === 'output' || p.type === 'oc' || p.type === 'oe' || p.type === 'hiz' || p.type === 'nc' ? 'right' : 'left'));
  // The rest by group, each group whole, to the lighter side
  const loose = pins.map((_, i) => i).filter((i) => !['power', 'ground', 'input', 'output', 'oc', 'oe', 'hiz', 'nc'].includes(pins[i]!.type));
  const count = (s: Side) => out.filter((x, i) => x === s && !loose.includes(i)).length;
  let left = count('left'), right = count('right');
  const groups = new Map<string, number[]>();
  for (const i of loose) { const g = pins[i]!.group || 'Other'; groups.set(g, [...(groups.get(g) ?? []), i]); }
  for (const list of [...groups.values()].sort((a, b) => b.length - a.length)) {
    const side: Side = left <= right ? 'left' : 'right';
    for (const i of list) out[i] = side;
    if (side === 'left') left += list.length; else right += list.length;
  }
  return out;
}

/** The pins of one side in their order: by group (as they come), then by number; a gap (null) between groups. */
function slots(pins: SymbolPin[], idx: number[], grouped: boolean): (number | null)[] {
  if (!grouped) return [...idx].sort((a, b) => byNumber(pins[a]!.number, pins[b]!.number));
  const groups = new Map<string, number[]>();
  for (const i of idx) { const g = pins[i]!.type === 'nc' ? '~nc' : pins[i]!.group || 'Other'; groups.set(g, [...(groups.get(g) ?? []), i]); }
  const out: (number | null)[] = [];
  // Not connected last; the others in the order they first come
  for (const [, list] of [...groups].sort((a, b) => (a[0] === '~nc' ? 1 : 0) - (b[0] === '~nc' ? 1 : 0))) {
    if (out.length) out.push(null);
    out.push(...list.sort((a, b) => byNumber(pins[a]!.number, pins[b]!.number)));
  }
  return out;
}

export interface MadeSymbol { libRef: string; description: string; parts: number; bags: PropertyBag[] }

/** The text's width in 10 mil units, about (AD's default pin font). */
const wide = (s: string) => Math.ceil(s.replace(/\\/g, '').length * 6.5);
const up10 = (v: number) => Math.ceil(v / 10) * 10;

/** The symbol: its body, pins (on a 100 mil grid, as long as given in 10 mil units: Preferences' default pin length; AD's 300 mil), designator, comment and footprint. */
export function buildSymbol(read: Pick<PinsRead, 'kind' | 'prefix' | 'pins'>, o: { name: string; description?: string; comment?: string; footprint?: string | null; sides?: Side[]; pinLength?: number }): MadeSymbol {
  const pins = read.pins;
  const sides = o.sides && o.sides.length === pins.length ? o.sides : sidesOf(read);
  const grouped = read.kind !== 'connector' && read.kind !== 'passive';
  const at = (s: Side) => slots(pins, pins.map((_, i) => i).filter((i) => sides[i] === s), grouped);
  const L = at('left'), R = at('right'), T = at('top'), B = at('bottom');
  const len = Math.max(0, Math.round(o.pinLength ?? 30));
  const shown = (p: SymbolPin) => (p.activeLow ? overbar(p.name) : p.name);
  // Names inside the body: left and right side by side, top and bottom (turned) above each other
  const maxName = (list: (number | null)[]) => Math.max(0, ...list.filter((i): i is number => i !== null).map((i) => wide(shown(pins[i]!))));
  const named = (list: (number | null)[]) => list.some((i) => i !== null && pins[i]!.name !== pins[i]!.number);
  const w = up10(Math.max(40, (named(L) ? maxName(L) : 0) + (named(R) ? maxName(R) : 0) + 30, (Math.max(T.length, B.length) + 1) * 10));
  const rows = Math.max(L.length, R.length, 1);
  const h = up10(Math.max((rows + 1) * 10, (named(T) ? maxName(T) : 0) + (named(B) ? maxName(B) : 0) + 30));
  const s = new SymbolBuilder(o.name, o.description ?? '');
  s.rect([0, 0], [w, h]);
  const showName = (p: SymbolPin) => p.name !== p.number;
  const pin = (i: number, xy: [number, number], orient: number) => {
    const p = pins[i]!;
    s.pin(p.number, shown(p), xy, orient, len, { electrical: ELECTRICAL[p.type], showName: showName(p) });
  };
  // Left and right from the top down; top and bottom from the left, centred
  L.forEach((i, k) => { if (i !== null) pin(i, [0, h - (k + 1) * 10], 2); });
  R.forEach((i, k) => { if (i !== null) pin(i, [w, h - (k + 1) * 10], 0); });
  const across = (list: (number | null)[], y: number, orient: number) => {
    const x0 = Math.round((w - (list.length - 1) * 10) / 20) * 10;
    list.forEach((i, k) => { if (i !== null) pin(i, [x0 + k * 10, y], orient); });
  };
  across(T, h, 1);
  across(B, 0, 3);
  s.designator(`${read.prefix || 'U'}?`, [0, h + (T.length ? len : 0) + 4]);
  s.comment(o.comment ?? o.name, [0, -(B.length ? len : 0) - 12]);
  if (o.footprint) s.footprint(o.footprint, o.description ?? '');
  else s.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERPARTID: -1 });
  return { libRef: o.name, description: o.description ?? '', parts: 1, bags: s.bags };
}
