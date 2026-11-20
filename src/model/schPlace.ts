/**
 * New schematic objects as Altium Designer 17 writes them when you place them: the record type,
 * the properties it sets and its default colours (Altium colours are BGR integers). Every bag
 * is built at its own reference point; placement tools move it under the cursor.
 */
import type { Vec2 } from '../core/geom';
import { SCH_UNIT, mil } from '../core/units';
import { PropertyBag } from '../formats/altium/props';
import { SR, setSchCoord } from './sch';
import { uniqueId } from './schEdit';
import { settings } from '../core/settings';

/** Altium's default object colours (BGR). */
export const SCH_COLOUR = {
  wire: 8388608,        // navy
  netLabel: 128,        // dark red
  power: 128,
  port: 128,
  portFill: 8454143,    // pale yellow
  text: 8388608,
  noErc: 255,           // red
  line: 16711680,       // blue
  body: 128,
  bodyFill: 11599871,   // light yellow
  frameText: 0,
  white: 16777215,
  sheetSymbol: 128,     // dark red border
  sheetSymbolFill: 8454016, // pale green
  sheetText: 8388608,
  entry: 128,
  entryFill: 8454143,
} as const;

const loc = (bag: PropertyBag, at: Vec2, xk = 'LOCATION.X', yk = 'LOCATION.Y') => { setSchCoord(bag, xk, at.x); setSchCoord(bag, yk, at.y); };
const bag = (props: Record<string, string | number | boolean>, at?: Vec2): PropertyBag => {
  const b = PropertyBag.from({ OWNERPARTID: -1, ...props });
  if (at) loc(b, at);
  return b;
};
const withId = (b: PropertyBag) => { b.setRaw('UNIQUEID', uniqueId()); return b; };

/** Power port styles, in Altium's STYLE order. */
export const POWER_STYLES = ['Circle', 'Arrow', 'Bar', 'Wave', 'Power Ground', 'Signal Ground', 'Earth', 'GOST Arrow', 'GOST Power Ground', 'GOST Earth', 'GOST Bar'] as const;
export const PORT_STYLES = ['None (Horizontal)', 'Left', 'Right', 'Left & Right', 'None (Vertical)', 'Top', 'Bottom', 'Top & Bottom'] as const;
export const PORT_IO = ['Unspecified', 'Output', 'Input', 'Bidirectional'] as const;

export function netLabelBag(text: string, at: Vec2 = { x: 0, y: 0 }): PropertyBag {
  return withId(bag({ RECORD: SR.NET_LABEL, COLOR: SCH_COLOUR.netLabel, FONTID: 1, TEXT: text }, at));
}

/** Ground styles point down, supply styles up, as Altium places them. */
export function powerBag(style: number, text: string, at: Vec2 = { x: 0, y: 0 }): PropertyBag {
  const ground = style === 4 || style === 5 || style === 6 || style === 8 || style === 9;
  const b = bag({ RECORD: SR.POWER_PORT, COLOR: SCH_COLOUR.power, FONTID: 1, STYLE: style, SHOWNETNAME: true, TEXT: text }, at);
  b.set('ORIENTATION', ground ? '3' : '1');
  return withId(b);
}

/** Off Sheet Connector: a power-port record marked as a cross-sheet connector. */
export function offSheetBag(text: string, at: Vec2 = { x: 0, y: 0 }): PropertyBag {
  return withId(bag({ RECORD: SR.POWER_PORT, COLOR: SCH_COLOUR.power, FONTID: 1, ISCROSSSHEETCONNECTOR: true, SHOWNETNAME: true, TEXT: text }, at));
}

/** Port: WIDTH / HEIGHT in Altium's 10 mil units. */
export function portBag(name: string, at: Vec2, width: number, style = 3, io = 0): PropertyBag {
  return withId(bag({
    RECORD: SR.PORT, STYLE: style, IOTYPE: io, ALIGNMENT: 0, WIDTH: Math.max(1, Math.round(width / SCH_UNIT)), HEIGHT: 10,
    COLOR: SCH_COLOUR.port, AREACOLOR: SCH_COLOUR.portFill, TEXTCOLOR: SCH_COLOUR.port, FONTID: 1, NAME: name,
  }, at));
}

/**
 * Place › Directives: a Parameter Set record (RECORD 43, red), with its parameters as children
 * (owner 0), as AD17 writes them: Differential Pair is NAME=DIFFPAIR carrying DifferentialPair=True;
 * PCB Layout is NAME=PCB Rule carrying Rule=PcbType=ProtelPcb described as Undefined.
 */
export type DirectiveKind = 'diffpair' | 'parameterset' | 'pcblayout';
/** `style`: STYLE, 0 (absent) Large, 1 Tiny — the only two (Preferences › Parameter Set › Default Parameter Set). */
export function directiveItems(kind: DirectiveKind, at: Vec2 = { x: 0, y: 0 }, style = 0): { bag: PropertyBag; owner: number }[] {
  const name = kind === 'diffpair' ? 'DIFFPAIR' : kind === 'pcblayout' ? 'PCB Rule' : 'Parameter Set';
  const set = bag({ RECORD: SR.PARAMETER_SET, COLOR: SCH_COLOUR.noErc, NAME: name }, at);
  if (style) set.set('STYLE', String(style));
  const param = (props: Record<string, string | number | boolean>) =>
    ({ bag: withId(bag({ RECORD: SR.PARAMETER, COLOR: SCH_COLOUR.text, FONTID: 1, ISHIDDEN: true, SHOWNAME: true, ...props }, at)), owner: 0 });
  if (kind === 'diffpair') return [{ bag: set, owner: -1 }, param({ TEXT: 'True', NAME: 'DifferentialPair' })];
  // PCB Layout: a "PCB Rule" set whose Rule holds the rule (not defined yet) and shows its description
  if (kind === 'pcblayout') return [{ bag: set, owner: -1 }, param({ TEXT: 'PcbType=ProtelPcb', NAME: 'Rule', DESCRIPTION: 'Undefined' })];
  // A plain Parameter Set starts with one unnamed, hidden parameter "*" 160 mil below it (as AD17 writes it)
  const blank = withId(bag({ RECORD: SR.PARAMETER, COLOR: SCH_COLOUR.text, FONTID: 1, ISHIDDEN: true, TEXT: '*' }, { x: at.x, y: at.y - mil(160) }));
  return [{ bag: set, owner: -1 }, { bag: blank, owner: 0 }];
}

export function noErcBag(at: Vec2 = { x: 0, y: 0 }, kinds?: string[]): PropertyBag {
  // Specific No ERC: SUPPRESSALL=F and the violations it covers, each quoted [est: comma-separated]
  if (kinds?.length) {
    return withId(bag({ RECORD: SR.NO_ERC, COLOR: SCH_COLOUR.noErc, ISACTIVE: true, SYMBOL: 'Thin Cross', SUPPRESSALL: 'F',
      ERRORKINDSETTOSUPPRESS: kinds.map((k) => `"${k}"`).join(',') }, at));
  }
  return withId(bag({ RECORD: SR.NO_ERC, COLOR: SCH_COLOUR.noErc, ISACTIVE: true, SYMBOL: 'Thin Cross', SUPPRESSALL: true }, at));
}

/** Place › Directives › Net Class: a Parameter Set carrying ClassName (the PCB net class it puts its nets in). */
export function netClassItems(name = 'NetClass', at: Vec2 = { x: 0, y: 0 }, style = 0): { bag: PropertyBag; owner: number }[] {
  const set = bag({ RECORD: SR.PARAMETER_SET, COLOR: SCH_COLOUR.noErc, NAME: name }, at);
  if (style) set.set('STYLE', String(style));
  const param = withId(bag({ RECORD: SR.PARAMETER, COLOR: SCH_COLOUR.text, FONTID: 1, ISHIDDEN: true, SHOWNAME: true, NAME: 'ClassName', TEXT: name }, at));
  return [{ bag: set, owner: -1 }, { bag: param, owner: 0 }];
}

/** Place › Directives › Compile Mask: two corners, its colours as AD17 writes them. */
export function compileMaskBag(a: Vec2, c: Vec2): PropertyBag {
  const lo = { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y) }, hi = { x: Math.max(a.x, c.x), y: Math.max(a.y, c.y) };
  const b = bag({ RECORD: SR.COMPILE_MASK, COLOR: 128, AREACOLOR: 16448250 }, lo);
  loc(b, hi, 'CORNER.X', 'CORNER.Y');
  return withId(b);
}

/** Place › Directives › Blanket: a polygon (a click per vertex), dashed, red, its bounds as LOCATION / CORNER. */
export function blanketBag(pts: Vec2[]): PropertyBag {
  const b = pointsBag(SR.BLANKET, pts, { COLOR: 255, AREACOLOR: 16777215, LINESTYLE: 1, LINESTYLEEXT: 1 });
  loc(b, { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)) });
  loc(b, { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)) }, 'CORNER.X', 'CORNER.Y');
  return b;
}

/** Place › Notes › Note: a sticky note, word-wrapped, its author kept. */
export function noteBag(a: Vec2, c: Vec2, author = '', text = 'Note'): PropertyBag {
  const { lo, hi } = box(a, c);
  const b = bag({ RECORD: SR.NOTE, COLOR: 0, AREACOLOR: 13434879, TEXTCOLOR: 0, FONTID: 1, ISSOLID: true, SHOWBORDER: true, ALIGNMENT: 1, WORDWRAP: true,
    CLIPTORECT: true, TEXT: text, AUTHOR: author }, lo);
  loc(b, hi, 'CORNER.X', 'CORNER.Y');
  setSchCoord(b, 'TEXTMARGIN', mil(50));
  return withId(b);
}

/** Place › Drawing Tools › Graphic: a linked picture between two corners (Embed Image off), its aspect kept. */
export function imageBag(a: Vec2, c: Vec2, fileName: string): PropertyBag {
  const { lo, hi } = box(a, c);
  const b = bag({ RECORD: SR.IMAGE, COLOR: 0, AREACOLOR: 16777215, LINEWIDTH: 1, KEEPASPECT: true, FILENAME: fileName }, lo);
  loc(b, hi, 'CORNER.X', 'CORNER.Y');
  return withId(b);
}

/** Place › Drawing Tools › Pie Chart: centre, radius, start and end angles; filled. */
export function pieBag(c: Vec2, r: number, start = 0, end = 90): PropertyBag {
  const b = bag({ RECORD: SR.PIECHART, LINEWIDTH: 1, COLOR: SCH_COLOUR.line, AREACOLOR: SCH_COLOUR.line, ISSOLID: true }, c);
  setSchCoord(b, 'RADIUS', Math.max(1, Math.round(r)));
  b.set('STARTANGLE', angle(start));
  b.set('ENDANGLE', end === 360 ? '360' : angle(end));
  return withId(b);
}

export function labelBag(text: string, at: Vec2 = { x: 0, y: 0 }): PropertyBag {
  return withId(bag({ RECORD: SR.LABEL, COLOR: SCH_COLOUR.text, FONTID: 1, TEXT: text }, at));
}

export function junctionBagAt(at: Vec2 = { x: 0, y: 0 }): PropertyBag {
  return withId(bag({ RECORD: SR.JUNCTION, COLOR: SCH_COLOUR.wire, LOCKED: true }, at));
}

/** Bus entry: a 45° stub 100 mil across, from the bus to the wire. */
export function busEntryBag(at: Vec2 = { x: 0, y: 0 }): PropertyBag {
  const b = bag({ RECORD: SR.BUS_ENTRY, COLOR: SCH_COLOUR.wire, LINEWIDTH: 1 }, at);
  loc(b, { x: at.x + mil(100), y: at.y + mil(100) }, 'CORNER.X', 'CORNER.Y');
  return withId(b);
}

const box = (a: Vec2, c: Vec2) => ({ lo: { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y) }, hi: { x: Math.max(a.x, c.x), y: Math.max(a.y, c.y) } });

export function textFrameBag(a: Vec2, c: Vec2, text = 'Text'): PropertyBag {
  const { lo, hi } = box(a, c);
  const b = bag({ RECORD: SR.TEXT_FRAME, COLOR: SCH_COLOUR.frameText, AREACOLOR: SCH_COLOUR.white, TEXTCOLOR: SCH_COLOUR.frameText, FONTID: 1,
    ISSOLID: true, ALIGNMENT: 1, WORDWRAP: true, CLIPTORECT: true, TEXT: text }, lo);
  loc(b, hi, 'CORNER.X', 'CORNER.Y');
  return withId(b);
}

export function rectBag(a: Vec2, c: Vec2, round = false): PropertyBag {
  const { lo, hi } = box(a, c);
  const b = bag({ RECORD: round ? SR.ROUND_RECTANGLE : SR.RECTANGLE, LINEWIDTH: 1, COLOR: SCH_COLOUR.body, AREACOLOR: SCH_COLOUR.bodyFill, ISSOLID: true }, lo);
  loc(b, hi, 'CORNER.X', 'CORNER.Y');
  if (round) { setSchCoord(b, 'CORNERXRADIUS', mil(200)); setSchCoord(b, 'CORNERYRADIUS', mil(200)); }
  return withId(b);
}

function pointsBag(record: number, pts: Vec2[], props: Record<string, string | number | boolean>): PropertyBag {
  const b = bag({ RECORD: record, ...props, LOCATIONCOUNT: pts.length });
  pts.forEach((p, i) => { setSchCoord(b, `X${i + 1}`, p.x); setSchCoord(b, `Y${i + 1}`, p.y); });
  return withId(b);
}
export const polylineBag = (pts: Vec2[]) => pointsBag(SR.POLYLINE, pts, { LINEWIDTH: 1, COLOR: SCH_COLOUR.line });
export const polygonBag = (pts: Vec2[]) => pointsBag(SR.POLYGON, pts, { LINEWIDTH: 1, COLOR: SCH_COLOUR.body, AREACOLOR: SCH_COLOUR.bodyFill, ISSOLID: true });
export const bezierBag = (pts: Vec2[]) => pointsBag(SR.BEZIER, pts, { LINEWIDTH: 1, COLOR: SCH_COLOUR.line });

export function ellipseBag(c: Vec2, rx: number, ry: number): PropertyBag {
  const b = bag({ RECORD: SR.ELLIPSE, LINEWIDTH: 1, COLOR: SCH_COLOUR.body, AREACOLOR: SCH_COLOUR.bodyFill, ISSOLID: true }, c);
  setSchCoord(b, 'RADIUS', Math.max(1, Math.round(rx)));
  setSchCoord(b, 'SECONDARYRADIUS', Math.max(1, Math.round(ry)));
  return withId(b);
}

const angle = (a: number) => String(+(((a % 360) + 360) % 360).toFixed(3));
export function arcBag(c: Vec2, r: number, start = 0, end = 360, ry?: number): PropertyBag {
  const b = bag({ RECORD: ry === undefined ? SR.ARC : SR.ELLIPTICAL_ARC, LINEWIDTH: 1, COLOR: SCH_COLOUR.line }, c);
  setSchCoord(b, 'RADIUS', Math.max(1, Math.round(r)));
  if (ry !== undefined) setSchCoord(b, 'SECONDARYRADIUS', Math.max(1, Math.round(ry)));
  b.set('STARTANGLE', angle(start));
  b.set('ENDANGLE', end === 360 ? '360' : angle(end));
  return b;
}

/** The pin Place › Pin starts with: Preferences' length (the usual one is 300 mil), passive, its hot end (the cross) at the origin, body to the right. */
export function pinFactory(): PropertyBag {
  const len = Math.round(settings.schPinLength / 10);
  const b = PropertyBag.from({ RECORD: SR.PIN, ELECTRICAL: 4, PINCONGLOMERATE: 2 | 0x08 | 0x10, PINLENGTH: len, NAME: '1', DESIGNATOR: '1', COLOR: 0 });
  setSchCoord(b, 'LOCATION.X', len * SCH_UNIT); setSchCoord(b, 'LOCATION.Y', 0);
  return b;
}

/* ─── IEEE symbols ─────────────────────────────────────────────────────────────────── */

/** Names by SYMBOL (index 0 unused), as Altium's Place › IEEE Symbols menu labels them. */
export const IEEE_SYMBOLS = [
  '', 'Dot', 'Right Left Signal Flow', 'Clock', 'Active Low Input', 'Analogue Signal In', 'Not Logic Connection', 'Shift Right', 'Postponed Output',
  'Open Collector', 'HiZ', 'High Current', 'Pulse', 'Schmitt', 'Delay', 'Group Line', 'Group Binary', 'Active Low Output', 'Pi Symbol',
  'Greater Equal', 'Less Equal', 'Sigma', 'Open Collector PullUp', 'Open Emitter', 'Open Emitter PullUp', 'Digital Signal In', 'And Gate',
  'Invertor', 'Or Gate', 'Xor Gate', 'Shift Left', 'Input Output', 'Open Output', 'Left Right Signal Flow', 'Bidirectional Signal Flow',
] as const;

/** Place › IEEE Symbols: SIZE 4 at the cursor, the library's line colour. */
export function ieeeBag(symbol: number): PropertyBag {
  return withId(bag({ RECORD: SR.IEEE_SYMBOL, SYMBOL: symbol, SCALEFACTOR: 4, COLOR: 255 }));
}

/* ─── Hierarchy ────────────────────────────────────────────────────────────────────── */

/**
 * A sheet symbol from two corners, with its Designator above the box and its File Name below,
 * as Altium places them. Children own by position (0 = the symbol), like a part's records.
 */
export function sheetSymbolItems(a: Vec2, c: Vec2, designator = 'Designator', fileName = 'File Name', template?: PropertyBag): { bag: PropertyBag; owner: number }[] {
  const left = Math.min(a.x, c.x), top = Math.max(a.y, c.y);
  const w = Math.max(SCH_UNIT, Math.abs(c.x - a.x)), h = Math.max(SCH_UNIT, Math.abs(c.y - a.y));
  const sym = template?.clone() ?? bag({ RECORD: SR.SHEET_SYMBOL, LINEWIDTH: 1, COLOR: SCH_COLOUR.sheetSymbol, AREACOLOR: SCH_COLOUR.sheetSymbolFill, ISSOLID: true, SYMBOLTYPE: 'Normal' });
  for (const k of ['OWNERINDEX', 'INDEXINSHEET']) sym.delete(k);
  loc(sym, { x: left, y: top });
  setSchCoord(sym, 'XSIZE', w); setSchCoord(sym, 'YSIZE', h);
  if (!template) withId(sym); else sym.setRaw('UNIQUEID', uniqueId());
  const name = bag({ RECORD: SR.SHEET_NAME, COLOR: SCH_COLOUR.sheetText, FONTID: 1, TEXT: designator }, { x: left, y: top + mil(20) });
  const file = bag({ RECORD: SR.FILE_NAME, COLOR: SCH_COLOUR.sheetText, FONTID: 1, TEXT: fileName }, { x: left, y: top - h - mil(100) });
  return [{ bag: sym, owner: -1 }, { bag: name, owner: 0 }, { bag: file, owner: 0 }];
}

/** IOTYPE: 0 Unspecified, 1 Output, 2 Input, 3 Bidirectional. SIDE: 0 left, 1 right, 2 top, 3 bottom. */
export function sheetEntryBag(name: string, side: number, distance: number, io = 0): PropertyBag {
  const whole = Math.trunc(distance / (10 * SCH_UNIT)), frac = distance - whole * 10 * SCH_UNIT;
  const b = bag({ RECORD: SR.SHEET_ENTRY, SIDE: side, DISTANCEFROMTOP: whole, COLOR: SCH_COLOUR.entry, AREACOLOR: SCH_COLOUR.entryFill,
    TEXTCOLOR: SCH_COLOUR.entry, TEXTFONTID: 1, TEXTSTYLE: 'Full', NAME: name, IOTYPE: io });
  if (frac) b.setRaw('DISTANCEFROMTOP_FRAC1', String(frac));
  if (!side) b.delete('SIDE');
  if (!io) b.delete('IOTYPE');
  return b;
}

/**
 * Design › Create Sheet Symbol From Sheet: a symbol for a sheet's ports — inputs (and
 * unspecified, bidirectional) down the left edge, outputs down the right — named U_<sheet>.
 */
export function symbolForPorts(sheetName: string, ports: { name: string; io: number }[], at: Vec2 = { x: 0, y: 0 }): { bag: PropertyBag; owner: number }[] {
  const base = sheetName.replace(/\.schdoc$/i, '');
  const left = ports.filter((p) => p.io !== 1), right = ports.filter((p) => p.io === 1);
  const rows = Math.max(1, left.length, right.length);
  const longest = Math.max(4, ...ports.map((p) => p.name.length));
  const w = Math.max(mil(1000), Math.ceil((longest * 2 * 70 + 400) / 100) * mil(100));
  const h = (rows + 1) * mil(100);
  const items = sheetSymbolItems(at, { x: at.x + w, y: at.y - h }, `U_${base}`, sheetName);
  left.forEach((p, i) => items.push({ bag: sheetEntryBag(p.name, 0, (i + 1) * mil(100), p.io), owner: 0 }));
  right.forEach((p, i) => items.push({ bag: sheetEntryBag(p.name, 1, (i + 1) * mil(100), p.io), owner: 0 }));
  return items;
}

/**
 * Altium's auto-increment on placement: NetLabel1 → NetLabel2, D0 → D1, A → B, by `step`
 * (Preferences › Graphical Editing › Auto-Increment, negative counts down). `stripZeroes`:
 * Remove Leading Zeroes (D01 → D2, not D02).
 */
export function nextName(s: string, step = 1, stripZeroes = false): string {
  const m = /^(.*?)(\d+)$/.exec(s);
  if (m) {
    const n = Math.max(0, Number(m[2]) + step);
    return `${m[1]}${stripZeroes ? String(n) : String(n).padStart(m[2]!.length, '0')}`;
  }
  // A lone letter steps through the alphabet (pin A → B) [est]; a word ending in one stays
  if (/^[A-Za-z]$/.test(s)) {
    const base = s <= 'Z' ? 65 : 97, k = s.charCodeAt(0) - base + step;
    if (k >= 0 && k < 26) return String.fromCharCode(base + k);
  }
  return s;
}

/**
 * Shift+drag copies, as the desktop software makes them: each copy named a step on, as placing it
 * again would (Preferences › Graphical Editing › Auto-Increment During Placement): a part's
 * designator to the next one not on the sheet (R1 → R2; R? stays R?), a net label's, port's and
 * sheet entry's name, a pin's number and name (its name by the secondary step). Only what was
 * copied on its own steps on: the pins and entries of a copied part or sheet symbol stay as they are.
 */
export function stepCopies<T extends { bag: PropertyBag; owner: number }>(items: readonly T[], taken: Set<string>, next: (s: string, secondary?: boolean) => string): T[] {
  return items.map((it) => {
    const rec = it.bag.int('RECORD', -1);
    const owner = it.owner >= 0 ? items[it.owner] : undefined;
    const step = (key: string, secondary = false) => { const v = it.bag.get(key); if (!v) return; const n = next(v, secondary); if (n !== v) { const b = it.bag.clone(); b.set(key, n); it = { ...it, bag: b }; } };
    if (rec === SR.DESIGNATOR && owner?.bag.int('RECORD', -1) === SR.COMPONENT) {
      const d = it.bag.get('TEXT') ?? '';
      if (!d || d.endsWith('?')) return it;
      let n = next(d), guard = 0;
      while (n !== d && taken.has(n.toUpperCase()) && guard++ < 100_000) n = next(n);
      if (n === d) return it;
      taken.add(n.toUpperCase());
      const b = it.bag.clone(); b.set('TEXT', n);
      return { ...it, bag: b };
    }
    if (it.owner >= 0) return it;
    if (rec === SR.NET_LABEL) step('TEXT');
    else if (rec === SR.PORT || rec === SR.SHEET_ENTRY) step('NAME');
    else if (rec === SR.PIN) { step('DESIGNATOR'); step('NAME', true); }
    return it;
  });
}

/* ─── Parts from a schematic library ─────────────────────────────────────────────────── */

/** Library graphics, pins and models nest under the component by record type, as in a schematic. */
const NESTS_UNDER: Record<number, number> = { [SR.IMPLEMENTATION]: SR.IMPLEMENTATION_LIST, [SR.MAP_DEFINER_LIST]: SR.IMPLEMENTATION, [SR.MAP_DEFINER]: SR.MAP_DEFINER_LIST, [SR.IMPL_PARAMS]: SR.IMPLEMENTATION };

/**
 * A library symbol as the records a placed part has: the component (at the origin, showing
 * `part`), then its children owned by index (0 = the component). A symbol without a designator
 * gets one ("U?"), as Altium adds it on placement.
 */
export function partRecords(symbol: { libRef: string; bags: PropertyBag[] }, libraryName: string, part = 1): { bag: PropertyBag; owner: number }[] {
  const [src, ...kids] = symbol.bags;
  if (!src) return [];
  const comp = src.clone();
  for (const k of ['LOCATION.X', 'LOCATION.Y', 'LOCATION.X_FRAC', 'LOCATION.Y_FRAC', 'OWNERINDEX', 'INDEXINSHEET']) comp.delete(k);
  comp.set('RECORD', String(SR.COMPONENT));
  comp.set('OWNERPARTID', '-1');
  comp.set('CURRENTPARTID', String(part));
  comp.set('LIBREFERENCE', symbol.libRef);
  if (!comp.has('DESIGNITEMID')) comp.set('DESIGNITEMID', symbol.libRef);
  comp.set('SOURCELIBRARYNAME', libraryName);
  if (!comp.has('DISPLAYMODECOUNT')) comp.set('DISPLAYMODECOUNT', '1');
  comp.setRaw('UNIQUEID', uniqueId());
  const out: { bag: PropertyBag; owner: number }[] = [{ bag: comp, owner: -1 }];
  const last = new Map<number, number>();
  for (const k of kids) {
    const b = k.clone();
    // Nested records name their parent's position in the symbol (a SIM model's parameters
    // under its parameter list); others follow the record they nest under
    const named = b.has('OWNERINDEX') ? b.int('OWNERINDEX') : -1;
    b.delete('OWNERINDEX'); b.delete('INDEXINSHEET');
    const rec = b.int('RECORD', -1);
    // A library pin's swap group is SWAPIDPIN on a sheet (as AD17 writes placed pins)
    if (rec === SR.PIN && b.has('SWAPIDGROUP')) { const g = b.get('SWAPIDGROUP') ?? ''; b.delete('SWAPIDGROUP'); if (g) b.set('SWAPIDPIN', g); }
    const parent = NESTS_UNDER[rec];
    const owner = named > 0 && named < out.length ? named : parent !== undefined ? last.get(parent) ?? 0 : 0;
    last.set(rec, out.length);
    out.push({ bag: b, owner });
  }
  if (!kids.some((k) => k.int('RECORD', -1) === SR.DESIGNATOR)) {
    const d = bag({ RECORD: SR.DESIGNATOR, NAME: 'Designator', TEXT: 'U?', FONTID: 1, COLOR: SCH_COLOUR.netLabel });
    out.push({ bag: d, owner: 0 });
  }
  return out;
}

/** The footprint a library symbol names (its current PCB model). */
export function symbolFootprint(bags: PropertyBag[]): string {
  let fp = '';
  for (const b of bags) {
    if (b.int('RECORD', -1) !== SR.IMPLEMENTATION || (b.get('MODELTYPE') ?? '').toUpperCase() !== 'PCBLIB') continue;
    if (!fp || b.bool('ISCURRENT')) fp = b.get('MODELNAME') ?? fp;
  }
  return fp;
}
