/**
 * KiCad's symbols and footprints item by item in a normal form, for the round-trip tools: every
 * setting, uuids aside, lists in any order; KiCad 8's and 9's ways of writing the same thing the same.
 */
import { kid, str, type SList, type SNode } from '../../src/formats/kicad/sexpr';

const isList = (n: SNode): n is SList => typeof n === 'object';

/** Flags written bare (KiCad 8) or as (flag yes) (KiCad 9). */
export const FLAGS = new Set(['hide', 'locked', 'bold', 'italic', 'power']);
/** Settings at their defaults, the same as none written. */
export const nothing = (y: SList): boolean => (y.k === 'fill' && y.items.length === 1 && isList(y.items[0]!) && (y.items[0] as SList).k === 'type' && (y.items[0] as SList).items[0] === 'none')
  || (FLAGS.has(y.k) && y.items[0] === 'no') || (y.k === 'exclude_from_sim' && y.items[0] === 'no') || (y.k === 'in_bom' && y.items[0] === 'yes') || (y.k === 'on_board' && y.items[0] === 'yes')
  || y.k === 'embedded_fonts' || y.k === 'duplicate_pin_numbers_are_jumpers' || (y.k === 'unlocked' && y.items[0] === 'no');
export const norm = (x: SNode): string => {
  if (typeof x === 'number') return String(Math.round(x * 1000) / 1000 + 0);
  if (typeof x === 'string') return JSON.stringify(x);
  let items = x.items.filter((y) => !(isList(y) && (y.k === 'uuid' || y.k === 'tstamp' || nothing(y))))
    .map((y): SNode => (typeof y === 'string' && FLAGS.has(y) ? { k: y, items: ['yes'] } : y));
  if (x.k === 'at' && items.length === 2) items = [...items, 0];
  if (x.k === 'layers') items = [...items].sort((p, q) => String(p).localeCompare(String(q)));
  return `(${x.k} ${[...items.filter((y) => !isList(y)).map(norm), ...items.filter(isList).map(norm).sort()].join(' ')})`;
};

/** An object's items as kind → their normal forms. */
export type Items = Map<string, string[]>;
const put = (m: Items, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);

export function symbolItems(s: SList): Items {
  const m: Items = new Map();
  const own = (n: SList, unit: string) => {
    for (const c of n.items) {
      if (!isList(c)) { if (typeof c === 'string' && FLAGS.has(c)) put(m, 'flag', c); continue; }
      if (c.k === 'symbol') { const u = /_(\d+)_(\d+)$/.exec(str(c) ?? ''); own(c, u ? `${u[1]}.${u[2]}` : '?'); continue; }
      if (nothing(c)) continue;
      if (c.k === 'property') {
        const name = str(c) ?? '', value = str(c, 1) ?? '';
        // (an empty Datasheet, Footprint, Description or ki_ field: the same as none; "~" an empty one)
        if ((value === '' || value === '~') && /^(Datasheet|Footprint|Description|ki_.*)$/.test(name)) continue;
        put(m, `property ${name}`, norm({ ...c, items: c.items.map((y, i) => (i === 1 && y === '~' ? '' : y)) }));
        continue;
      }
      const kind = c.k === 'pin' ? 'pin' : /^(rectangle|polyline|circle|arc|bezier|text|text_box)$/.test(c.k) ? 'graphic' : 'setting';
      put(m, kind, `${unit} ${norm(c)}`);
    }
  };
  own(s, '');
  return m;
}

export function footprintItems(f: SList): Items {
  const m: Items = new Map();
  for (const c of f.items) {
    if (!isList(c)) { if (typeof c === 'string' && FLAGS.has(c)) put(m, 'flag', c); continue; }
    if (nothing(c) || c.k === 'version' || c.k === 'generator' || c.k === 'generator_version' || c.k === 'layer' || c.k === 'uuid' || c.k === 'tstamp') continue;
    // (fp_text reference / value: KiCad 8's Reference and Value fields)
    if (c.k === 'fp_text' && (c.items[0] === 'reference' || c.items[0] === 'value')) {
      put(m, 'field', norm({ k: 'property', items: [c.items[0] === 'reference' ? 'Reference' : 'Value', ...c.items.slice(1)] }));
      continue;
    }
    if (c.k === 'property') {
      const name = str(c) ?? '', value = str(c, 1) ?? '';
      if (name === 'Footprint' || ((value === '' || value === '~') && /^(Datasheet|Description)$/.test(name))) continue;
      put(m, 'field', norm(c));
      continue;
    }
    const kind = c.k === 'pad' ? 'pad' : /^fp_(line|arc|circle|rect|poly|curve)$/.test(c.k) ? 'graphic' : /^fp_text/.test(c.k) ? 'text' : c.k === 'model' ? 'model' : 'setting';
    // (an arc or line drawn the other way round is the same)
    if ((c.k === 'fp_arc' || c.k === 'fp_line') && kid(c, 'start') && kid(c, 'end')) {
      const [s0, e0] = [kid(c, 'start')!, kid(c, 'end')!].sort((p, q) => norm(p).replace(/^\(\w+/, '').localeCompare(norm(q).replace(/^\(\w+/, '')));
      put(m, kind, norm({ ...c, items: c.items.map((y) => (isList(y) && y.k === 'start' ? { ...s0, k: 'start' } : isList(y) && y.k === 'end' ? { ...e0, k: 'end' } : y)) }));
      continue;
    }
    put(m, kind, norm(c));
  }
  return m;
}

