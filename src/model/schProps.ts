/**
 * Schematic object properties as Altium Designer 17 names and groups them (SCH Inspector,
 * SCH List, the query language): Kind, Design, Graphical, Object Specific. One definition per
 * property reads it from the object's record and writes it back as an undoable change, so the
 * Inspector, the List, the Filter and the Properties dialogs all agree.
 *
 * Writes touch only the keys a property owns and follow Altium's habits: false booleans are
 * left out, coordinates carry their _FRAC part. Properties whose file key isn't certain are
 * shown read-only rather than guessed at.
 */
import type { Change } from '../core/undo';
import { SCH_UNIT, formatCoord, formatSchField, parseLength, parseSchField, type Coord, type DisplayUnit } from '../core/units';
import { PropertyBag } from '../formats/altium/props';
import { libPinSwapGroup } from '../formats/altium/schlib';
import { fromBgr, toBgr } from './common';
import { ELECTRICAL } from './compile';
import { componentKind, partLetter, SR, bagOf, schCoord, setSchCoord, type SchDocument, type SchFont, type SchObject } from './sch';
import { replaceBags, setProps } from './schEdit';
import { IEEE_SYMBOLS, PORT_IO, PORT_STYLES, POWER_STYLES } from './schPlace';
import { transformBag, withChildren, type SchXform } from './schTransform';

export type InspCat = 'Kind' | 'Design' | 'Graphical' | 'Object Specific';
export const CATEGORIES: InspCat[] = ['Kind', 'Design', 'Graphical', 'Object Specific'];
export type PropType = 'text' | 'multiline' | 'coord' | 'bool' | 'enum' | 'colour' | 'font' | 'number';

export interface SchCtx {
  doc: SchDocument;
  index: number;
  /** The sheet's own unit (DISPLAY_UNIT code) on a sheet; the editor's in a library. */
  units: SchUnits;
  /** Owner Document. */
  docName: string;
  /** Pins and symbol graphics are edited in the library, not on a sheet. */
  libraryMode: boolean;
}

export interface SchProp {
  cat: InspCat;
  name: string;
  type: PropType;
  /** Display values of an enum. */
  options?: readonly string[];
  /** Display values that depend on the object (a part's display modes, its parts A, B …). */
  optionsFor?(x: SchCtx): readonly string[];
  get(x: SchCtx): string;
  /** The change that sets it (from its display form); null when the value is not valid. Absent: read only. */
  set?(x: SchCtx, v: string): Change | null;
  /** The name is a link to another object (Component Designator → the designator). */
  link?(x: SchCtx): number | undefined;
}

/* ─── Values ────────────────────────────────────────────────────────────────────────── */

export const LINE_WIDTHS = ['Smallest', 'Small', 'Medium', 'Large'] as const;
export const ORIENTATIONS = ['0 Degrees', '90 Degrees', '180 Degrees', '270 Degrees'] as const;
export const JUSTIFICATIONS = ['Bottom Left', 'Bottom Centre', 'Bottom Right', 'Centre Left', 'Centre Centre', 'Centre Right', 'Top Left', 'Top Centre', 'Top Right'] as const;
export const LINE_STYLES = ['Solid', 'Dashed', 'Dotted', 'Dash Dotted'] as const;
export const LINE_SHAPES = ['None', 'Arrow', 'Solid Arrow', 'Tail', 'Solid Tail', 'Circle', 'Square'] as const;
export const SHAPE_SIZES = ['XSmall', 'Small', 'Medium', 'Large'] as const;
export const JUNCTION_SIZES = ['Smallest', 'Small', 'Medium', 'Large'] as const;
export const TEXT_ALIGN = ['Left', 'Centre', 'Right'] as const;
export const PORT_ALIGN = ['Centre', 'Left', 'Right'] as const;
export const ENTRY_SIDES = ['Left', 'Right', 'Top', 'Bottom'] as const;
export const NOERC_SYMBOLS = ['Thin Cross', 'Thick Cross', 'Small Cross', 'Checkbox', 'Triangle'] as const;
/** COMPONENTKIND (Standard (No BOM) is written as COMPONENTKINDVERSION2, as Altium does). */
export const COMPONENT_KINDS = ['Standard', 'Mechanical', 'Graphical', 'Net Tie (In BOM)', 'Net Tie', 'Standard (No BOM)'] as const;
/** Pin symbols per slot: [display, SYMBOL_* value]. */
export const PIN_SYMBOLS: Record<'inner' | 'innerEdge' | 'outerEdge' | 'outer', [string, number][]> = {
  inner: [['No Symbol', 0], ['Postponed Output', 8], ['Open Collector', 9], ['HiZ', 10], ['High Current', 11], ['Pulse', 12], ['Schmitt', 13],
    ['Open Collector Pull Up', 22], ['Open Emitter', 23], ['Open Emitter Pull Up', 24], ['Shift Left', 30], ['Open Output', 32]],
  innerEdge: [['No Symbol', 0], ['Clock', 3]],
  outerEdge: [['No Symbol', 0], ['Dot', 1], ['Active Low Input', 4], ['Active Low Output', 17]],
  outer: [['No Symbol', 0], ['Right Left Signal Flow', 2], ['Analogue Signal In', 5], ['Not Logic Connection', 6], ['Digital Signal In', 25],
    ['Left Right Signal Flow', 33], ['Bidirectional Signal Flow', 34]],
};

export const MIXED = '<...>';

export { componentKind } from './sch';
export function componentKindPatch(kind: number): Record<string, string | null> {
  return kind === 5 ? { COMPONENTKIND: null, COMPONENTKINDVERSION2: '5' } : { COMPONENTKIND: kind ? String(kind) : null, COMPONENTKINDVERSION2: null };
}

/** Object Kind, as the query language and the Inspector call it. */
export function objectKind(doc: SchDocument, o: SchObject): string {
  switch (o.record) {
    case SR.COMPONENT: return 'Part';
    case SR.PIN: return 'Pin';
    case SR.IEEE_SYMBOL: return 'IEEE Symbol';
    case SR.LABEL: return 'Text String';
    case SR.BEZIER: return 'Bezier';
    case SR.POLYLINE: return 'Polyline';
    case SR.POLYGON: return 'Polygon';
    case SR.ELLIPSE: return 'Ellipse';
    case SR.PIECHART: return 'Pie Chart';
    case SR.ROUND_RECTANGLE: return 'Round Rectangle';
    case SR.ELLIPTICAL_ARC: return 'Elliptical Arc';
    case SR.ARC: return 'Arc';
    case SR.LINE: return 'Line';
    case SR.RECTANGLE: return 'Rectangle';
    case SR.SHEET_SYMBOL: return 'Sheet Symbol';
    case SR.SHEET_ENTRY: return 'Sheet Entry';
    case SR.POWER_PORT: return bagOf(doc, o)?.bool('ISCROSSSHEETCONNECTOR') ? 'Off Sheet Connector' : 'Power Object';
    case SR.PORT: return 'Port';
    case SR.NO_ERC: return 'No ERC';
    case SR.NET_LABEL: return 'Net Label';
    case SR.BUS: return 'Bus';
    case SR.WIRE: return 'Wire';
    case SR.TEXT_FRAME: return 'Text Frame';
    case SR.NOTE: return 'Note';
    case SR.JUNCTION: return 'Junction';
    case SR.IMAGE: return 'Image';
    case SR.SHEET_NAME: return 'Sheet Symbol Designator';
    case SR.FILE_NAME: return 'Sheet Symbol File Name';
    case SR.DESIGNATOR: return 'Designator';
    case SR.BUS_ENTRY: return 'Bus Entry';
    case SR.PARAMETER: return 'Parameter';
    case SR.PARAMETER_SET: return 'Parameter Set';
    case SR.COMPILE_MASK: return 'Compile Mask';
    case SR.BLANKET: return 'Blanket';
    case SR.HARNESS_CONNECTOR: return 'Harness Connector';
    case SR.HARNESS_ENTRY: return 'Harness Entry';
    case SR.SIGNAL_HARNESS: return 'Signal Harness';
    default: return 'Object';
  }
}

/* ─── Building blocks ───────────────────────────────────────────────────────────────── */

const obj = (x: SchCtx) => x.doc.objects[x.index]!;
const bag = (x: SchCtx) => x.doc.records[x.index + 1]!.bag!;
const patch = (x: SchCtx, props: Record<string, string | null>) => setProps(x.doc, x.index, props);
/** Edit a copy of the record and swap it in (keys with _FRAC parts, several keys at once). */
function edit(x: SchCtx, fn: (b: PropertyBag) => void | false, index = x.index): Change | null {
  const before = x.doc.records[index + 1]?.bag;
  if (!before) return null;
  const after = before.clone();
  if (fn(after) === false) return null;
  return replaceBags(x.doc, [{ index, before: before.clone(), after }]);
}
/** Several changes as one. */
export function both(...cs: (Change | null)[]): Change | null {
  const list = cs.filter((c): c is Change => !!c);
  if (!list.length) return null;
  if (list.length === 1) return list[0]!;
  return { apply: () => list.forEach((c) => c.apply()), revert: () => [...list].reverse().forEach((c) => c.revert()) };
}

/** A schematic length's units: the editor's (mil, mm), or a sheet's own (its DISPLAY_UNIT code, e.g. 4 Dxp Defaults). */
export type SchUnits = DisplayUnit | number;
export const fmtCoord = (c: Coord, u: SchUnits) => (typeof u === 'number' ? formatSchField(c, u) : formatCoord(c, u, u === 'mil' ? 3 : 4));
/** A length typed in a field: a bare number is in the current units. */
export function parseCoord(v: string, u: SchUnits): Coord | undefined {
  if (typeof u === 'number') return parseSchField(v, u);
  const t = v.trim();
  return parseLength(/^-?[0-9]*\.?[0-9]+$/.test(t) ? `${t}${u}` : t);
}
export const hexOf = (bgr: number) => `#${fromBgr(bgr).toString(16).padStart(6, '0')}`;
export const bgrOf = (hex: string): number | undefined => (/^#[0-9a-f]{6}$/i.test(hex.trim()) ? toBgr(parseInt(hex.trim().slice(1), 16)) : undefined);

const truthy = (v: string) => v === 'true' || v === 'T' || v === '1';

/** A T/omitted boolean (or one that is on unless written F, with def = true). */
function boolProp(cat: InspCat, name: string, key: string, opts: { def?: boolean | ((b: PropertyBag) => boolean); invert?: boolean; ro?: boolean } = {}): SchProp {
  const def = (b: PropertyBag) => (typeof opts.def === 'function' ? opts.def(b) : !!opts.def);
  const read = (b: PropertyBag) => { const v = b.has(key) ? b.bool(key) : def(b); return opts.invert ? !v : v; };
  return {
    cat, name, type: 'bool',
    get: (x) => String(read(bag(x))),
    set: opts.ro ? undefined : (x, v) => {
      let on = truthy(v);
      if (opts.invert) on = !on;
      if (on === (bag(x).has(key) ? bag(x).bool(key) : def(bag(x)))) return null;
      // A default that depends on the record's other fields is written out either way
      return patch(x, { [key]: on ? 'T' : (opts.def ? 'F' : null) });
    },
  };
}
function textProp(cat: InspCat, name: string, key: string, opts: { ro?: boolean; multiline?: boolean } = {}): SchProp {
  return {
    cat, name, type: opts.multiline ? 'multiline' : 'text',
    get: (x) => { const t = bag(x).get(key) ?? ''; return opts.multiline ? t.replace(/~1/g, '\n') : t; },
    set: opts.ro ? undefined : (x, v) => patch(x, { [key]: opts.multiline ? v.replace(/\r\n?/g, '\n').replace(/\n/g, '~1') : v }),
  };
}
function coordProp(cat: InspCat, name: string, key: string, opts: { min?: number; ro?: boolean } = {}): SchProp {
  return {
    cat, name, type: 'coord',
    get: (x) => fmtCoord(schCoord(bag(x), key), x.units),
    set: opts.ro ? undefined : (x, v) => {
      const c = parseCoord(v, x.units);
      if (c === undefined || (opts.min !== undefined && c < opts.min)) return null;
      return edit(x, (b) => setSchCoord(b, key, c));
    },
  };
}
/** An enum stored as its index (0 left out unless keep0). */
function enumProp(cat: InspCat, name: string, key: string, options: readonly string[], opts: { keep0?: boolean; ro?: boolean; base?: number } = {}): SchProp {
  const base = opts.base ?? 0;
  return {
    cat, name, type: 'enum', options,
    get: (x) => options[bag(x).int(key, base) - base] ?? String(bag(x).int(key, base)),
    set: opts.ro ? undefined : (x, v) => {
      const i = options.indexOf(v);
      if (i < 0) return null;
      const n = i + base;
      return patch(x, { [key]: n || opts.keep0 ? String(n) : null });
    },
  };
}
function colourProp(cat: InspCat, name: string, key: string, def: number): SchProp {
  return {
    cat, name, type: 'colour',
    get: (x) => hexOf(bag(x).has(key) ? bag(x).int(key) : def),
    set: (x, v) => { const n = bgrOf(v); return n === undefined ? null : patch(x, { [key]: String(n) }); },
  };
}

/* ─── Fonts ─────────────────────────────────────────────────────────────────────────── */

export interface FontSpec { name: string; size: number; bold: boolean; italic: boolean; underline: boolean; strikeout: boolean; rotation?: number }

export function fontLabel(f: Pick<SchFont, 'name' | 'size' | 'bold' | 'italic'> | undefined): string {
  if (!f) return 'Default';
  return `${f.name}, ${f.size}${f.bold ? ', Bold' : ''}${f.italic ? ', Italic' : ''}`;
}

function sheetBagIndex(doc: SchDocument): number {
  return doc.objects.findIndex((o) => o.record === SR.SHEET);
}

/** The sheet's font list (FONTIDCOUNT, SIZEn, FONTNAMEn …), 1-based. */
export function sheetFonts(doc: SchDocument): FontSpec[] {
  const i = sheetBagIndex(doc);
  const b = i >= 0 ? bagOf(doc, doc.objects[i]!) : undefined;
  if (!b) return doc.sheet.fonts.map((f) => ({ ...f, underline: false, strikeout: false }));
  const n = b.int('FONTIDCOUNT');
  const out: FontSpec[] = [];
  for (let k = 1; k <= n; k++) out.push({ name: b.get(`FONTNAME${k}`) ?? 'Times New Roman', size: b.int(`SIZE${k}`, 10), bold: b.bool(`BOLD${k}`), italic: b.bool(`ITALIC${k}`),
    underline: b.bool(`UNDERLINE${k}`), strikeout: b.bool(`STRIKEOUT${k}`), rotation: b.int(`ROTATION${k}`) });
  return out;
}

export const sameFont = (a: FontSpec, b: FontSpec) => a.name.toLowerCase() === b.name.toLowerCase() && a.size === b.size && a.bold === b.bold && a.italic === b.italic
  && a.underline === b.underline && a.strikeout === b.strikeout && (a.rotation ?? 0) === (b.rotation ?? 0);

/** The FONTID for a font, adding it to the sheet's list when it isn't there yet. */
export function ensureFont(doc: SchDocument, f: FontSpec): { id: number; change: Change | null } {
  const fonts = sheetFonts(doc);
  const at = fonts.findIndex((g) => sameFont(g, f));
  if (at >= 0) return { id: at + 1, change: null };
  const i = sheetBagIndex(doc);
  if (i < 0) return { id: 1, change: null };
  const before = doc.records[i + 1]!.bag!;
  const after = before.clone();
  const id = fonts.length + 1;
  after.set('FONTIDCOUNT', String(id));
  after.set(`SIZE${id}`, String(f.size));
  if (f.rotation) after.set(`ROTATION${id}`, String(f.rotation));
  if (f.underline) after.set(`UNDERLINE${id}`, 'T');
  if (f.italic) after.set(`ITALIC${id}`, 'T');
  if (f.bold) after.set(`BOLD${id}`, 'T');
  if (f.strikeout) after.set(`STRIKEOUT${id}`, 'T');
  after.set(`FONTNAME${id}`, f.name);
  const swap = replaceBags(doc, [{ index: i, before: before.clone(), after }]);
  const hook = doc.onSheetChange;
  return { id, change: hook ? { apply: () => { swap.apply(); hook(doc.records[i + 1]!.bag!); }, revert: () => { swap.revert(); hook(doc.records[i + 1]!.bag!); } } : swap };
}

function fontProp(cat: InspCat, key: string): SchProp {
  return {
    cat, name: 'Font', type: 'font',
    get: (x) => { const id = bag(x).int(key, 0) || x.doc.sheet.systemFont; return fontLabel(x.doc.sheet.fonts[id - 1]); },
    set: (x, v) => {
      let f: FontSpec;
      try { f = JSON.parse(v) as FontSpec; } catch { return null; }
      if (!f?.name || !(f.size > 0)) return null;
      const { id, change } = ensureFont(x.doc, f);
      const own: Change = { apply: () => {}, revert: () => {} };
      // FONTID is set after the font exists, so build it lazily inside the pair
      let set: Change | null = null;
      own.apply = () => { set ??= patch(x, { [key]: String(id) }); set.apply(); };
      own.revert = () => set?.revert();
      return both(change, own);
    },
  };
}

/** The current font of an object as a spec (for the font dialog). */
export function fontOf(doc: SchDocument, o: SchObject, key = 'FONTID'): FontSpec {
  const b = bagOf(doc, o);
  const id = (b?.int(key, 0) || doc.sheet.systemFont) - 1;
  return sheetFonts(doc)[id] ?? { name: 'Times New Roman', size: 10, bold: false, italic: false, underline: false, strikeout: false };
}

/* ─── Shared properties ─────────────────────────────────────────────────────────────── */

const KIND: SchProp = { cat: 'Kind', name: 'Object Kind', type: 'text', get: (x) => objectKind(x.doc, obj(x)) };
const OWNER_DOC: SchProp = { cat: 'Design', name: 'Owner Document', type: 'text', get: (x) => x.docName };
const X1 = coordProp('Graphical', 'X1', 'LOCATION.X');
const Y1 = coordProp('Graphical', 'Y1', 'LOCATION.Y');
const X2 = coordProp('Graphical', 'X2', 'CORNER.X');
const Y2 = coordProp('Graphical', 'Y2', 'CORNER.Y');
const LOCKED = boolProp('Graphical', 'Locked', 'GRAPHICALLYLOCKED');
const MIRRORED = boolProp('Graphical', 'Mirrored', 'ISMIRRORED');
const LINE_WIDTH = enumProp('Graphical', 'Line Width', 'LINEWIDTH', LINE_WIDTHS);
const ORIENTATION = enumProp('Graphical', 'Orientation', 'ORIENTATION', ORIENTATIONS);
const JUSTIFY = enumProp('Graphical', 'Justification', 'JUSTIFICATION', JUSTIFICATIONS);
const colour = (def: number, name = 'Colour', key = 'COLOR') => colourProp('Graphical', name, key, def);
const AREA = (def: number) => colourProp('Graphical', 'Area Colour', 'AREACOLOR', def);
const SOLID = boolProp('Graphical', 'Draw Solid', 'ISSOLID');
const TRANSPARENT = boolProp('Graphical', 'Transparent', 'TRANSPARENT');
/** Line Style: AD keeps it twice, LINESTYLE (to Dotted) and LINESTYLEEXT (with Dash Dotted); both written. */
const LINE_STYLE: SchProp = {
  cat: 'Graphical', name: 'Line Style', type: 'enum', options: LINE_STYLES,
  get: (x) => LINE_STYLES[bag(x).has('LINESTYLEEXT') ? bag(x).int('LINESTYLEEXT') : bag(x).int('LINESTYLE')] ?? 'Solid',
  set: (x, v) => {
    const i = LINE_STYLES.indexOf(v as (typeof LINE_STYLES)[number]);
    if (i < 0) return null;
    return patch(x, { LINESTYLE: i ? String(Math.min(i, 2)) : null, LINESTYLEEXT: i ? String(i) : null });
  },
};
const TEXT = textProp('Object Specific', 'Text', 'TEXT');
const FONT = fontProp('Object Specific', 'FONTID');
const angleProp = (name: string, key: string, def: number): SchProp => ({
  cat: 'Graphical', name, type: 'number',
  get: (x) => String(+bag(x).float(key, def).toFixed(3)),
  set: (x, v) => {
    const n = Number(v.replace(/°|deg(rees)?/gi, '').trim());
    if (!Number.isFinite(n)) return null;
    const a = n === 360 ? 360 : ((n % 360) + 360) % 360;
    return patch(x, { [key]: a.toFixed(3) });
  },
});

/** A size kept in whole DXP units (10 mil), as a port's WIDTH and HEIGHT are. */
function dxpLength(name: string, key: string, def: number): SchProp {
  return {
    cat: 'Graphical', name, type: 'coord',
    get: (x) => fmtCoord(bag(x).int(key, def) * SCH_UNIT, x.units),
    set: (x, v) => { const c = parseCoord(v, x.units); if (c === undefined || c < SCH_UNIT) return null; return patch(x, { [key]: String(Math.round(c / SCH_UNIT)) }); },
  };
}

/* ─── Parts: moves and turns carry the pins, graphics and parameters along ─────────── */

function transformWith(x: SchCtx, xf: SchXform): Change {
  const idx = withChildren(x.doc, [x.index]);
  return replaceBags(x.doc, idx.map((i) => { const b = x.doc.records[i + 1]!.bag!; return { index: i, before: b.clone(), after: transformBag(b, xf) }; }));
}
const partAt = (x: SchCtx) => ({ x: schCoord(bag(x), 'LOCATION.X'), y: schCoord(bag(x), 'LOCATION.Y') });
const partCoord = (axis: 'x' | 'y'): SchProp => ({
  cat: 'Graphical', name: axis === 'x' ? 'X1' : 'Y1', type: 'coord',
  get: (x) => fmtCoord(partAt(x)[axis], x.units),
  set: (x, v) => {
    const c = parseCoord(v, x.units);
    if (c === undefined) return null;
    const at = partAt(x), d = { x: axis === 'x' ? c - at.x : 0, y: axis === 'y' ? c - at.y : 0 };
    if (!d.x && !d.y) return null;
    return transformWith(x, { pivot: at, quarter: 0, mirrorX: false, mirrorY: false, d });
  },
});
const PART_ORIENT: SchProp = {
  cat: 'Graphical', name: 'Orientation', type: 'enum', options: ORIENTATIONS,
  get: (x) => ORIENTATIONS[bag(x).int('ORIENTATION') & 3]!,
  set: (x, v) => {
    const n = ORIENTATIONS.indexOf(v as never);
    if (n < 0) return null;
    const q = (n - (bag(x).int('ORIENTATION') & 3) + 4) % 4;
    return q ? transformWith(x, { pivot: partAt(x), quarter: q, mirrorX: false, mirrorY: false, d: { x: 0, y: 0 } }) : null;
  },
};
const PART_MIRROR: SchProp = {
  cat: 'Graphical', name: 'Mirrored', type: 'bool',
  get: (x) => String(bag(x).bool('ISMIRRORED')),
  set: (x, v) => {
    if (truthy(v) === bag(x).bool('ISMIRRORED')) return null;
    // Toggling the mirror flips about the vertical axis of the part as it is turned
    const odd = (bag(x).int('ORIENTATION') & 1) === 1;
    return transformWith(x, { pivot: partAt(x), quarter: 0, mirrorX: !odd, mirrorY: odd, d: { x: 0, y: 0 } });
  },
};
const childOf = (x: SchCtx, rec: number, name?: string) => x.doc.objects.find((o) => o.owner === x.index && o.record === rec
  && (!name || (bagOf(x.doc, o)?.get('NAME') ?? '').toLowerCase() === name.toLowerCase()));
/** A property of one of the part's own texts (designator, comment). */
function childText(name: string, rec: number, pname?: string): SchProp {
  return {
    cat: 'Object Specific', name, type: 'text',
    get: (x) => { const c = childOf(x, rec, pname); return c ? bagOf(x.doc, c)?.get('TEXT') ?? '' : ''; },
    set: (x, v) => { const c = childOf(x, rec, pname); return c ? setProps(x.doc, c.index, { TEXT: v }) : null; },
    link: (x) => childOf(x, rec, pname)?.index,
  };
}
const SHOW_DESIGNATOR: SchProp = {
  cat: 'Graphical', name: 'Show Designator', type: 'bool',
  get: (x) => { const c = childOf(x, SR.DESIGNATOR); return String(!!c && !bagOf(x.doc, c)?.bool('ISHIDDEN')); },
  set: (x, v) => { const c = childOf(x, SR.DESIGNATOR); return c ? setProps(x.doc, c.index, { ISHIDDEN: truthy(v) ? null : 'T' }) : null; },
};
function currentImpl(x: SchCtx): SchObject | undefined {
  const lists = new Set(x.doc.objects.filter((o) => o.owner === x.index && o.record === SR.IMPLEMENTATION_LIST).map((o) => o.index));
  const impls = x.doc.objects.filter((o) => o.record === SR.IMPLEMENTATION && lists.has(o.owner) && (bagOf(x.doc, o)?.get('MODELTYPE') ?? '').toUpperCase() === 'PCBLIB');
  return impls.find((o) => bagOf(x.doc, o)?.bool('ISCURRENT')) ?? impls[0];
}
const partLetters = (n: number) => Array.from({ length: n }, (_, i) => partLetter(i + 1));

const PART: SchProp[] = [
  KIND, OWNER_DOC,
  partCoord('x'), partCoord('y'), PART_ORIENT, LOCKED, PART_MIRROR,
  { cat: 'Graphical', name: 'Display Mode', type: 'enum',
    optionsFor: (x) => ['Normal', ...Array.from({ length: Math.max(1, bag(x).int('DISPLAYMODECOUNT', 1)) - 1 }, (_, i) => `Alternate ${i + 1}`)],
    get: (x) => { const m = bag(x).int('DISPLAYMODE'); return m ? `Alternate ${m}` : 'Normal'; },
    set: (x, v) => {
      const n = v === 'Normal' ? 0 : Number(/^Alternate (\d+)$/.exec(v)?.[1] ?? NaN);
      if (!(n >= 0 && n < Math.max(1, bag(x).int('DISPLAYMODECOUNT', 1)))) return null;
      return patch(x, { DISPLAYMODE: n ? String(n) : null });
    } },
  boolProp('Graphical', 'Show Hidden Pins', 'SHOWHIDDENPINS'),
  SHOW_DESIGNATOR,
  textProp('Object Specific', 'Description', 'COMPONENTDESCRIPTION'),
  boolProp('Object Specific', 'Lock Designator', 'DESIGNATORLOCKED'),
  boolProp('Object Specific', 'Lock Part ID', 'PARTIDLOCKED'),
  boolProp('Object Specific', 'Pins Locked', 'PINSMOVEABLE', { invert: true }),
  { cat: 'Object Specific', name: 'File Name', type: 'text', get: (x) => { const v = bag(x).get('SHEETPARTFILENAME') ?? ''; return v === '*' ? '' : v; } },
  { cat: 'Object Specific', name: 'Configuration', type: 'text', get: (x) => bag(x).get('TARGETFILENAME') ?? '' },
  textProp('Object Specific', 'Library', 'SOURCELIBRARYNAME'),
  textProp('Object Specific', 'Symbol Reference', 'LIBREFERENCE'),
  childText('Component Designator', SR.DESIGNATOR),
  { cat: 'Object Specific', name: 'Current Part', type: 'enum',
    optionsFor: (x) => { const n = Math.max(1, bag(x).int('PARTCOUNT', 2) - 1); return n > 1 ? partLetters(n) : []; },
    get: (x) => { const n = Math.max(1, bag(x).int('PARTCOUNT', 2) - 1); return n > 1 ? partLetters(n)[bag(x).int('CURRENTPARTID', 1) - 1] ?? '' : ''; },
    set: (x, v) => {
      const n = Math.max(1, bag(x).int('PARTCOUNT', 2) - 1), i = partLetters(n).indexOf(v.trim().toUpperCase());
      return i < 0 ? null : patch(x, { CURRENTPARTID: String(i + 1) });
    } },
  childText('Part Comment', SR.PARAMETER, 'Comment'),
  { cat: 'Object Specific', name: 'Current Footprint', type: 'text', get: (x) => { const i = currentImpl(x); return i ? bagOf(x.doc, i)?.get('MODELNAME') ?? '' : ''; } },
  { cat: 'Object Specific', name: 'Component Type', type: 'enum', options: COMPONENT_KINDS,
    get: (x) => COMPONENT_KINDS[componentKind(bag(x))] ?? 'Standard',
    set: (x, v) => { const k = COMPONENT_KINDS.indexOf(v as never); return k < 0 || k === componentKind(bag(x)) ? null : patch(x, componentKindPatch(k)); } },
  textProp('Object Specific', 'Database Table Name', 'DATABASETABLENAME'),
  { cat: 'Object Specific', name: 'Use Library Name', type: 'bool', get: (x) => String(bag(x).has('USELIBRARYNAME') ? bag(x).bool('USELIBRARYNAME') : true) },
  { cat: 'Object Specific', name: 'Use Database Table Name', type: 'bool', get: (x) => String(bag(x).bool('USEDBTABLENAME')) },
  textProp('Object Specific', 'Design Item ID', 'DESIGNITEMID'),
  { cat: 'Object Specific', name: 'Vault', type: 'text', get: (x) => bag(x).get('VAULTGUID') ?? '' },
  { cat: 'Object Specific', name: 'Item', type: 'text', get: (x) => bag(x).get('ITEMGUID') ?? '' },
  { cat: 'Object Specific', name: 'Revision', type: 'text', get: (x) => bag(x).get('REVISIONGUID') ?? '' },
];

/* ─── Pins ──────────────────────────────────────────────────────────────────────────── */

const pc = (x: SchCtx) => bag(x).int('PINCONGLOMERATE');
const pinBit = (name: string, mask: number, invert = false): SchProp => ({
  cat: 'Object Specific', name, type: 'bool',
  get: (x) => String(((pc(x) & mask) !== 0) !== invert),
  set: (x, v) => { const on = truthy(v) !== invert; const n = on ? pc(x) | mask : pc(x) & ~mask; return n === pc(x) ? null : patch(x, { PINCONGLOMERATE: String(n) }); },
});
const pinSymbol = (name: string, key: string, slot: keyof typeof PIN_SYMBOLS): SchProp => ({
  cat: 'Object Specific', name, type: 'enum', options: PIN_SYMBOLS[slot].map(([l]) => l),
  get: (x) => PIN_SYMBOLS[slot].find(([, v]) => v === bag(x).int(key))?.[0] ?? String(bag(x).int(key)),
  set: (x, v) => { const s = PIN_SYMBOLS[slot].find(([l]) => l === v); return s ? patch(x, { [key]: s[1] ? String(s[1]) : null }) : null; },
});
const PIN: SchProp[] = [
  KIND, OWNER_DOC, X1, Y1,
  { cat: 'Graphical', name: 'Orientation', type: 'enum', options: ORIENTATIONS,
    get: (x) => ORIENTATIONS[pc(x) & 3]!,
    set: (x, v) => { const n = ORIENTATIONS.indexOf(v as never); return n < 0 ? null : patch(x, { PINCONGLOMERATE: String((pc(x) & ~3) | n) }); } },
  colour(0), LOCKED,
  textProp('Object Specific', 'Description', 'DESCRIPTION'),
  textProp('Object Specific', 'Name', 'NAME'),
  textProp('Object Specific', 'Pin Designator', 'DESIGNATOR'),
  enumProp('Object Specific', 'Electrical Type', 'ELECTRICAL', ELECTRICAL),
  pinBit('Show Name', 0x08), pinBit('Show Designator', 0x10),
  coordProp('Object Specific', 'Pin Length', 'PINLENGTH', { min: 0 }),
  pinBit('Hide', 0x04),
  // On a sheet SWAPIDPIN; in a library the binary pin's swap group (SWAPIDGROUP), which Configure Pin Swapping edits and a save keeps
  { cat: 'Object Specific', name: 'Swap ID Pin', type: 'text',
    get: (x) => (x.libraryMode ? libPinSwapGroup(bag(x)) : bag(x).get('SWAPIDPIN') ?? ''),
    set: (x, v) => patch(x, x.libraryMode ? { SWAPIDGROUP: v || null, SWAPIDPIN: null } : { SWAPIDPIN: v }) },
  textProp('Object Specific', 'Swap ID Part', 'SWAPIDPART'),
  pinSymbol('Inside', 'SYMBOL_INNER', 'inner'), pinSymbol('Inside Edge', 'SYMBOL_INNEREDGE', 'innerEdge'),
  pinSymbol('Outside Edge', 'SYMBOL_OUTEREDGE', 'outerEdge'), pinSymbol('Outside', 'SYMBOL_OUTER', 'outer'),
  { cat: 'Object Specific', name: 'Owner Part ID', type: 'number', get: (x) => String(bag(x).int('OWNERPARTID')) },
];

/* ─── Everything else ───────────────────────────────────────────────────────────────── */

const TEXT_LIKE = (def: number): SchProp[] => [KIND, OWNER_DOC, X1, Y1, ORIENTATION, colour(def), LOCKED, MIRRORED, JUSTIFY];
const PARAMETER: SchProp[] = [
  ...TEXT_LIKE(8388608),
  textProp('Object Specific', 'Name', 'NAME'),
  textProp('Object Specific', 'Value', 'TEXT'),
  FONT,
  boolProp('Object Specific', 'Hide', 'ISHIDDEN'),
  boolProp('Object Specific', 'Show Name', 'SHOWNAME'),
  boolProp('Object Specific', 'Autoposition', 'OVERRIDENOTAUTOPOSITION', { invert: true }),
  { cat: 'Object Specific', name: 'Owner', type: 'text', get: (x) => { const o = obj(x); const ow = o.owner >= 0 ? x.doc.objects[o.owner] : undefined; return ow?.kind === 'component' ? ow.designator : ''; } },
];
const DESIGNATOR: SchProp[] = PARAMETER.map((p) => (p.name === 'Name' ? { ...p, set: undefined } : p));

const PROPS = new Map<number, SchProp[]>([
  [SR.COMPONENT, PART],
  [SR.PIN, PIN],
  [SR.NET_LABEL, [KIND, OWNER_DOC, X1, Y1, ORIENTATION, colour(128), LOCKED, MIRRORED, TEXT, FONT]],
  [SR.POWER_PORT, [KIND, OWNER_DOC, X1, Y1, ORIENTATION, colour(128), LOCKED,
    TEXT,
    { cat: 'Object Specific', name: 'Style', type: 'enum', options: POWER_STYLES,
      get: (x) => (bag(x).bool('ISCROSSSHEETCONNECTOR') ? (['Left', 'Right'][bag(x).int('STYLE')] ?? 'Left') : POWER_STYLES[bag(x).int('STYLE')] ?? 'Circle'),
      set: (x, v) => { const list: readonly string[] = bag(x).bool('ISCROSSSHEETCONNECTOR') ? ['Left', 'Right'] : POWER_STYLES; const i = list.indexOf(v); return i < 0 ? null : patch(x, { STYLE: i ? String(i) : null }); } },
    boolProp('Object Specific', 'Show Net Name', 'SHOWNETNAME', { def: true }),
    FONT]],
  [SR.PORT, [KIND, OWNER_DOC, X1, Y1,
    dxpLength('Width', 'WIDTH', 50), dxpLength('Height', 'HEIGHT', 10),
    colour(128), AREA(8454143), colourProp('Graphical', 'Text Colour', 'TEXTCOLOR', 128), LOCKED,
    textProp('Object Specific', 'Name', 'NAME'),
    enumProp('Object Specific', 'Style', 'STYLE', PORT_STYLES),
    enumProp('Object Specific', 'I/O Type', 'IOTYPE', PORT_IO),
    enumProp('Object Specific', 'Alignment', 'ALIGNMENT', PORT_ALIGN),
    fontProp('Object Specific', 'TEXTFONTID'),
    textProp('Object Specific', 'Unique ID', 'UNIQUEID'),
    textProp('Object Specific', 'Harness Type', 'HARNESSTYPE')]],
  [SR.JUNCTION, [KIND, OWNER_DOC, X1, Y1, colour(128), boolProp('Graphical', 'Locked', 'LOCKED'), enumProp('Graphical', 'Size', 'SIZE', JUNCTION_SIZES)]],
  [SR.NO_ERC, [KIND, OWNER_DOC, X1, Y1, colour(255), LOCKED,
    { cat: 'Object Specific', name: 'Symbol', type: 'enum', options: NOERC_SYMBOLS, get: (x) => bag(x).get('SYMBOL') ?? 'Thin Cross',
      set: (x, v) => (NOERC_SYMBOLS.includes(v as never) ? patch(x, { SYMBOL: v }) : null) },
    // As compiled: a record from before AD17 (neither field) is active and suppresses all; a newer one names both when set
    boolProp('Object Specific', 'Active', 'ISACTIVE', { def: (b) => !b.has('SUPPRESSALL') }),
    boolProp('Object Specific', 'Suppress All Violations', 'SUPPRESSALL', { def: (b) => !b.has('ISACTIVE') && !b.has('ERRORKINDSETTOSUPPRESS') && !b.has('CONNECTIONPAIRSTOSUPPRESS') })]],
  [SR.WIRE, [KIND, OWNER_DOC, colour(8388608), LINE_WIDTH, LOCKED]],
  [SR.BUS, [KIND, OWNER_DOC, colour(8388608), LINE_WIDTH, LOCKED]],
  [SR.BUS_ENTRY, [KIND, OWNER_DOC, X1, Y1, X2, Y2, colour(8388608), LINE_WIDTH, LOCKED]],
  [SR.LINE, [KIND, OWNER_DOC, X1, Y1, X2, Y2, colour(16711680), LINE_WIDTH, LINE_STYLE, LOCKED]],
  [SR.POLYLINE, [KIND, OWNER_DOC, colour(16711680), LINE_WIDTH, LINE_STYLE,
    enumProp('Graphical', 'Start Line Shape', 'STARTLINESHAPE', LINE_SHAPES), enumProp('Graphical', 'End Line Shape', 'ENDLINESHAPE', LINE_SHAPES),
    enumProp('Graphical', 'Line Shape Size', 'LINESHAPESIZE', SHAPE_SIZES), LOCKED]],
  [SR.POLYGON, [KIND, OWNER_DOC, colour(128), AREA(11599871), LINE_WIDTH, SOLID, TRANSPARENT, LOCKED]],
  [SR.BEZIER, [KIND, OWNER_DOC, colour(16711680), LINE_WIDTH, LOCKED]],
  [SR.RECTANGLE, [KIND, OWNER_DOC, X1, Y1, X2, Y2, colour(128), AREA(11599871), LINE_WIDTH, SOLID, TRANSPARENT, LOCKED]],
  [SR.ROUND_RECTANGLE, [KIND, OWNER_DOC, X1, Y1, X2, Y2, coordProp('Graphical', 'X Radius', 'CORNERXRADIUS', { min: 0 }), coordProp('Graphical', 'Y Radius', 'CORNERYRADIUS', { min: 0 }),
    colour(128), AREA(11599871), LINE_WIDTH, SOLID, TRANSPARENT, LOCKED]],
  [SR.ELLIPSE, [KIND, OWNER_DOC, X1, Y1, coordProp('Graphical', 'X Radius', 'RADIUS', { min: 0 }), coordProp('Graphical', 'Y Radius', 'SECONDARYRADIUS', { min: 0 }),
    colour(128), AREA(11599871), LINE_WIDTH, SOLID, TRANSPARENT, LOCKED]],
  [SR.ARC, [KIND, OWNER_DOC, X1, Y1, coordProp('Graphical', 'Radius', 'RADIUS', { min: 0 }), angleProp('Start Angle', 'STARTANGLE', 0), angleProp('End Angle', 'ENDANGLE', 360),
    colour(128), LINE_WIDTH, LOCKED]],
  [SR.ELLIPTICAL_ARC, [KIND, OWNER_DOC, X1, Y1, coordProp('Graphical', 'X Radius', 'RADIUS', { min: 0 }), coordProp('Graphical', 'Y Radius', 'SECONDARYRADIUS', { min: 0 }),
    angleProp('Start Angle', 'STARTANGLE', 0), angleProp('End Angle', 'ENDANGLE', 360), colour(128), LINE_WIDTH, LOCKED]],
  [SR.LABEL, [...TEXT_LIKE(8388608), TEXT, FONT, textProp('Object Specific', 'URL', 'URL')]],
  [SR.TEXT_FRAME, [KIND, OWNER_DOC, X1, Y1, X2, Y2, colour(0, 'Border Colour'), AREA(16777215), colourProp('Graphical', 'Text Colour', 'TEXTCOLOR', 0),
    LINE_WIDTH, SOLID, boolProp('Graphical', 'Show Border', 'SHOWBORDER'), LOCKED,
    textProp('Object Specific', 'Text', 'TEXT', { multiline: true }), FONT, enumProp('Object Specific', 'Alignment', 'ALIGNMENT', TEXT_ALIGN, { base: 1, keep0: true }),
    boolProp('Object Specific', 'Word Wrap', 'WORDWRAP'), boolProp('Object Specific', 'Clip to Area', 'CLIPTORECT'),
    coordProp('Object Specific', 'Text Margin', 'TEXTMARGIN', { min: 0 })]],
  [SR.DESIGNATOR, DESIGNATOR],
  [SR.PARAMETER, PARAMETER],
  [SR.SHEET_NAME, [...TEXT_LIKE(8388608), TEXT, FONT, boolProp('Object Specific', 'Hide', 'ISHIDDEN'), boolProp('Object Specific', 'Autoposition', 'OVERRIDENOTAUTOPOSITION', { invert: true })]],
  [SR.FILE_NAME, [...TEXT_LIKE(8388608), TEXT, FONT, boolProp('Object Specific', 'Hide', 'ISHIDDEN'), boolProp('Object Specific', 'Autoposition', 'OVERRIDENOTAUTOPOSITION', { invert: true })]],
  [SR.SHEET_SYMBOL, [KIND, OWNER_DOC, X1, Y1, coordProp('Graphical', 'X Size', 'XSIZE', { min: SCH_UNIT }), coordProp('Graphical', 'Y Size', 'YSIZE', { min: SCH_UNIT }),
    colour(128), AREA(11599871), LINE_WIDTH, SOLID, LOCKED,
    childText('Sheet Symbol Designator', SR.SHEET_NAME), childText('Sheet Symbol File Name', SR.FILE_NAME),
    textProp('Object Specific', 'Unique ID', 'UNIQUEID'), boolProp('Object Specific', 'Show Hidden Fields', 'SHOWHIDDENFIELDS')]],
  [SR.SHEET_ENTRY, [KIND, OWNER_DOC, colour(128), AREA(8454143), colourProp('Graphical', 'Text Colour', 'TEXTCOLOR', 128), LOCKED,
    textProp('Object Specific', 'Name', 'NAME'),
    enumProp('Object Specific', 'Side', 'SIDE', ENTRY_SIDES),
    { cat: 'Object Specific', name: 'Distance From Top', type: 'coord',
      get: (x) => fmtCoord(bag(x).int('DISTANCEFROMTOP') * 10 * SCH_UNIT + bag(x).int('DISTANCEFROMTOP_FRAC1'), x.units),
      set: (x, v) => {
        const c = parseCoord(v, x.units);
        if (c === undefined || c < 0) return null;
        const whole = Math.trunc(c / (10 * SCH_UNIT)), frac = c - whole * 10 * SCH_UNIT;
        return patch(x, { DISTANCEFROMTOP: String(whole), DISTANCEFROMTOP_FRAC1: frac ? String(frac) : null });
      } },
    enumProp('Object Specific', 'I/O Type', 'IOTYPE', PORT_IO),
    textProp('Object Specific', 'Harness Type', 'HARNESSTYPE'),
    fontProp('Object Specific', 'TEXTFONTID')]],
  [SR.IMAGE, [KIND, OWNER_DOC, X1, Y1, X2, Y2, colour(0, 'Border Colour'), LINE_WIDTH, LOCKED,
    boolProp('Object Specific', 'Border On', 'ISSOLID'), boolProp('Object Specific', 'Keep Aspect', 'KEEPASPECT'), boolProp('Object Specific', 'Embedded', 'EMBEDIMAGE'),
    textProp('Object Specific', 'File Name', 'FILENAME')]],
  [SR.IEEE_SYMBOL, [KIND, OWNER_DOC, X1, Y1, ORIENTATION, colour(255), LINE_WIDTH, LOCKED, MIRRORED,
    enumProp('Object Specific', 'Symbol', 'SYMBOL', IEEE_SYMBOLS, { keep0: true }),
    { cat: 'Object Specific', name: 'Size', type: 'text', get: (x) => String(bag(x).int('SCALEFACTOR', 4) || 4),
      set: (x, v) => { const n = parseInt(v, 10); return n >= 1 && n <= 100 ? patch(x, { SCALEFACTOR: String(n) }) : null; } }]],
]);
// Directives: moved and turned with their parameters, as parts are
PROPS.set(SR.PARAMETER_SET, [KIND, OWNER_DOC, partCoord('x'), partCoord('y'), PART_ORIENT, colour(255), LOCKED, textProp('Object Specific', 'Name', 'NAME')]);
// Harnesses [est: keys as read from AD files; Side 0 left, 1 right]
PROPS.set(SR.HARNESS_CONNECTOR, [KIND, OWNER_DOC, X1, Y1, coordProp('Graphical', 'X Size', 'XSIZE', { min: SCH_UNIT }), coordProp('Graphical', 'Y Size', 'YSIZE', { min: SCH_UNIT }),
  colour(8388736), AREA(16770815), LINE_WIDTH, LOCKED,
  enumProp('Object Specific', 'Harness Side', 'SIDE', ['Left', 'Right']), coordProp('Object Specific', 'Primary Position', 'PRIMARYCONNECTIONPOSITION', { min: 0 }),
  textProp('Object Specific', 'Unique ID', 'UNIQUEID')]);
PROPS.set(SR.HARNESS_ENTRY, [KIND, OWNER_DOC, colour(8388736), AREA(16770815), colourProp('Graphical', 'Text Colour', 'TEXTCOLOR', 8388736), LOCKED,
  textProp('Object Specific', 'Name', 'NAME'), enumProp('Object Specific', 'Side', 'SIDE', ['Left', 'Right']), fontProp('Object Specific', 'TEXTFONTID'),
  textProp('Object Specific', 'Harness Type', 'HARNESSTYPE')]);
PROPS.set(SR.HARNESS_TYPE, [...TEXT_LIKE(8388736), TEXT, FONT, boolProp('Object Specific', 'Hide', 'ISHIDDEN')]);
PROPS.set(SR.SIGNAL_HARNESS, [KIND, OWNER_DOC, colour(8388608), LINE_WIDTH, LOCKED]);
PROPS.set(SR.PIECHART, [KIND, OWNER_DOC, X1, Y1, coordProp('Graphical', 'Radius', 'RADIUS', { min: 0 }), angleProp('Start Angle', 'STARTANGLE', 0), angleProp('End Angle', 'ENDANGLE', 360),
  colour(16711680), AREA(16711680), LINE_WIDTH, SOLID, LOCKED]);
PROPS.set(SR.COMPILE_MASK, [KIND, OWNER_DOC, X1, Y1, X2, Y2, colour(128), AREA(16448250), LOCKED, boolProp('Object Specific', 'Collapsed', 'ISCOLLAPSED')]);
PROPS.set(SR.BLANKET, [KIND, OWNER_DOC, colour(255), AREA(16777215), SOLID, LINE_STYLE, LOCKED, boolProp('Object Specific', 'Collapsed', 'ISCOLLAPSED')]);
PROPS.set(SR.NOTE, [...PROPS.get(SR.TEXT_FRAME)!, textProp('Object Specific', 'Author', 'AUTHOR'), boolProp('Object Specific', 'Collapsed', 'COLLAPSED')]);

/** Pins and symbol graphics belong to the library: on a sheet they are read only. */
const LIBRARY_ONLY = new Set<number>([SR.PIN, SR.POLYLINE, SR.POLYGON, SR.BEZIER, SR.RECTANGLE, SR.ROUND_RECTANGLE, SR.ELLIPSE, SR.ARC, SR.ELLIPTICAL_ARC, SR.LINE, SR.IEEE_SYMBOL]);

/** The properties of an object, in Altium's order (read only where the object can't be edited here). */
export function schProps(doc: SchDocument, o: SchObject, libraryMode: boolean): SchProp[] {
  const list = PROPS.get(o.record) ?? [KIND, OWNER_DOC];
  const ownedByPart = o.owner >= 0 && doc.objects[o.owner]?.kind === 'component';
  if (!libraryMode && ownedByPart && LIBRARY_ONLY.has(o.record)) return list.map((p) => ({ ...p, set: undefined, link: undefined }));
  return list;
}

/** Display value of one property (by name) of an object, '' when it has none. */
export function propValue(x: SchCtx, name: string): string | undefined {
  const p = schProps(x.doc, x.doc.objects[x.index]!, x.libraryMode).find((q) => q.name.toLowerCase() === name.toLowerCase());
  return p?.get(x);
}
