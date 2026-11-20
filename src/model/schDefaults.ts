/**
 * Preferences › Schematic › Default Primitives: what each kind of schematic object starts from
 * when it is placed. A default is the object's own properties (colour, width, font, text, style,
 * orientation …) without where it goes or the shape the clicks give it. Edit Values on the page
 * changes it; so does Tab while placing, unless Permanent is on. Kept from one session to the
 * next; saved to and loaded from a file.
 *
 * A font is kept as the font itself (name, size …), not as a sheet's font number: each sheet has
 * its own list, and the default finds or adds its font in the sheet it is placed on.
 */
import { readLocal, writeLocal } from '../core/storage';
import { mil } from '../core/units';
import { PropertyBag } from '../formats/altium/props';
import { SR, type SchDocument } from './sch';
import { ensureFont, sameFont, sheetFonts, type FontSpec } from './schProps';
import { wireBag } from './schEdit';
import {
  arcBag, bezierBag, blanketBag, busEntryBag, compileMaskBag, directiveItems, ellipseBag, ieeeBag, junctionBagAt, labelBag, netLabelBag, noErcBag, noteBag,
  offSheetBag, pieBag, pinFactory, polygonBag, polylineBag, portBag, powerBag, rectBag, sheetEntryBag, sheetSymbolItems, textFrameBag,
} from './schPlace';
import { harnessConnectorItems, harnessEntryBag, signalHarnessBag } from './schHarness';

export interface SchDefault {
  /** The properties the default sets (display strings by key). */
  props: Record<string, string>;
  /** Its fonts, by the property that names one (FONTID, TEXTFONTID). */
  fonts?: Record<string, FontSpec>;
  /** What the object owns, in the order it is made (a sheet symbol's designator and file name). */
  children?: SchDefault[];
}

export const SCH_GROUPS = ['Wiring Objects', 'Drawing Objects', 'Sheet Symbol Objects', 'Harness Objects', 'Library Objects', 'Other'] as const;
export type SchGroup = typeof SCH_GROUPS[number];
type Item = { bag: PropertyBag; owner: number };

export interface SchKind {
  name: string;
  group: SchGroup;
  record: number;
  /** A power port record that is an off sheet connector. */
  cross?: boolean;
  /** Drawn by its points: where it is and its outline come from the clicks, never from the default. */
  shape?: boolean;
  /** Sits on its owner's edge: its side and place along it come from the cursor. */
  slot?: boolean;
  /** The object as it is first made (with what it owns), at the origin. */
  make(): Item[];
}

const o = { x: 0, y: 0 }, far = { x: mil(500), y: -mil(300) };
const line = [o, { x: mil(300), y: 0 }], tri = [o, { x: mil(300), y: 0 }, { x: mil(300), y: mil(200) }];
const one = (bag: PropertyBag): Item[] => [{ bag, owner: -1 }];

/** The kinds the page lists, each placed by a command that starts from its default. */
export const SCH_KINDS: SchKind[] = [
  { name: 'Arc', group: 'Drawing Objects', record: SR.ARC, shape: true, make: () => one(arcBag(o, mil(100), 0, 90)) },
  { name: 'Bezier', group: 'Drawing Objects', record: SR.BEZIER, shape: true, make: () => one(bezierBag([o, { x: mil(100), y: mil(200) }, { x: mil(200), y: -mil(200) }, { x: mil(300), y: 0 }])) },
  { name: 'Blanket', group: 'Other', record: SR.BLANKET, shape: true, make: () => one(blanketBag(tri)) },
  { name: 'Bus', group: 'Wiring Objects', record: SR.BUS, shape: true, make: () => one(wireBag(line, { bus: true })) },
  { name: 'Bus Entry', group: 'Wiring Objects', record: SR.BUS_ENTRY, make: () => one(busEntryBag()) },
  { name: 'Compile Mask', group: 'Other', record: SR.COMPILE_MASK, shape: true, make: () => one(compileMaskBag(o, far)) },
  { name: 'Ellipse', group: 'Drawing Objects', record: SR.ELLIPSE, shape: true, make: () => one(ellipseBag(o, mil(200), mil(100))) },
  { name: 'Elliptical Arc', group: 'Drawing Objects', record: SR.ELLIPTICAL_ARC, shape: true, make: () => one(arcBag(o, mil(200), 0, 90, mil(100))) },
  { name: 'Harness Connector', group: 'Harness Objects', record: SR.HARNESS_CONNECTOR, shape: true, make: () => harnessConnectorItems(o, { x: mil(600), y: -mil(400) }) },
  { name: 'Harness Entry', group: 'Harness Objects', record: SR.HARNESS_ENTRY, slot: true, make: () => one(harnessEntryBag('Entry1', 0, 0)) },
  { name: 'IEEE Symbol', group: 'Library Objects', record: SR.IEEE_SYMBOL, make: () => one(ieeeBag(1)) },
  { name: 'Junction', group: 'Wiring Objects', record: SR.JUNCTION, make: () => one(junctionBagAt()) },
  { name: 'Line', group: 'Drawing Objects', record: SR.POLYLINE, shape: true, make: () => one(polylineBag(line)) },
  { name: 'Net Label', group: 'Wiring Objects', record: SR.NET_LABEL, make: () => one(netLabelBag('NetLabel1')) },
  { name: 'No ERC', group: 'Wiring Objects', record: SR.NO_ERC, make: () => one(noErcBag()) },
  { name: 'Note', group: 'Drawing Objects', record: SR.NOTE, shape: true, make: () => one(noteBag(o, far)) },
  { name: 'Off Sheet Connector', group: 'Wiring Objects', record: SR.POWER_PORT, cross: true, make: () => one(offSheetBag('OffSheet')) },
  { name: 'Parameter Set', group: 'Other', record: SR.PARAMETER_SET, make: () => directiveItems('parameterset') },
  { name: 'Pie Chart', group: 'Drawing Objects', record: SR.PIECHART, shape: true, make: () => one(pieBag(o, mil(100))) },
  { name: 'Pin', group: 'Library Objects', record: SR.PIN, make: () => one(pinFactory()) },
  { name: 'Polygon', group: 'Drawing Objects', record: SR.POLYGON, shape: true, make: () => one(polygonBag(tri)) },
  { name: 'Port', group: 'Wiring Objects', record: SR.PORT, make: () => one(portBag('Port1', o, mil(500))) },
  { name: 'Power Port', group: 'Wiring Objects', record: SR.POWER_PORT, make: () => one(powerBag(2, 'VCC')) },
  { name: 'Rectangle', group: 'Drawing Objects', record: SR.RECTANGLE, shape: true, make: () => one(rectBag(o, far)) },
  { name: 'Round Rectangle', group: 'Drawing Objects', record: SR.ROUND_RECTANGLE, shape: true, make: () => one(rectBag(o, far, true)) },
  { name: 'Sheet Entry', group: 'Sheet Symbol Objects', record: SR.SHEET_ENTRY, slot: true, make: () => one(sheetEntryBag('Entry1', 0, 0)) },
  { name: 'Sheet Symbol', group: 'Sheet Symbol Objects', record: SR.SHEET_SYMBOL, make: () => sheetSymbolItems(o, { x: mil(1000), y: -mil(800) }) },
  { name: 'Signal Harness', group: 'Harness Objects', record: SR.SIGNAL_HARNESS, shape: true, make: () => one(signalHarnessBag(line)) },
  { name: 'Text Frame', group: 'Drawing Objects', record: SR.TEXT_FRAME, shape: true, make: () => one(textFrameBag(o, far)) },
  { name: 'Text String', group: 'Drawing Objects', record: SR.LABEL, make: () => one(labelBag('Text')) },
  { name: 'Wire', group: 'Wiring Objects', record: SR.WIRE, shape: true, make: () => one(wireBag(line)) },
];

export const schKind = (name: string): SchKind | undefined => SCH_KINDS.find((k) => k.name === name);
/** The kind a record is of (none: a part's own records, a sheet's, a parameter). */
export function kindOfBag(b: PropertyBag): SchKind | undefined {
  const r = b.int('RECORD', -1), cross = b.bool('ISCROSSSHEETCONNECTOR');
  return SCH_KINDS.find((k) => k.record === r && (r !== SR.POWER_PORT || !!k.cross === cross));
}

/* ─── What a default holds ───────────────────────────────────────────────────────────── */

const FONT_KEYS = ['FONTID', 'TEXTFONTID'];
const UTF8 = '%UTF8%';
/** Which object it is and whose: never a default's. */
const IDENT = /^(RECORD|OWNERINDEX|OWNERINDEXADDITIONALLIST|OWNERPARTID|OWNERPARTDISPLAYMODE|INDEXINSHEET|UNIQUEID)$/;
const PLACE = /^LOCATION\.[XY](_FRAC\d*)?$/;
const SHAPE = /^(CORNER\.[XY]|[XY]\d+|LOCATIONCOUNT|RADIUS|SECONDARYRADIUS|STARTANGLE|ENDANGLE|XSIZE|YSIZE|PRIMARYCONNECTIONPOSITION)(_FRAC\d*)?$/;
const SLOT = /^(SIDE|DISTANCEFROMTOP)(_FRAC\d*)?$/;
/** A pin's length is Preferences' own setting, and its place follows from it and from how it is turned. */
const PIN = /^(PINLENGTH|LOCATION\.[XY])(_FRAC\d*)?$/;

/** A property the default leaves to the object being placed (`child`: one of what it owns). */
function held(kind: SchKind, key: string, child = false): boolean {
  const k = key.toUpperCase();
  if (k.startsWith(UTF8) || IDENT.test(k) || FONT_KEYS.includes(k)) return true;
  if (child) return PLACE.test(k);
  if (kind.shape) return PLACE.test(k) || SHAPE.test(k);
  if (kind.slot) return PLACE.test(k) || SLOT.test(k);
  if (kind.record === SR.PIN) return PIN.test(k);
  return false;
}

function capOne(doc: SchDocument | null, kind: SchKind, b: PropertyBag, child: boolean): SchDefault {
  const props: Record<string, string> = {};
  for (const k of b.keys()) if (!held(kind, k, child)) props[k.toUpperCase()] = b.get(k) ?? '';
  const fonts: Record<string, FontSpec> = {};
  if (doc) { const list = sheetFonts(doc); for (const k of FONT_KEYS) { const f = b.has(k) ? list[b.int(k, 1) - 1] : undefined; if (f) fonts[k] = { ...f }; } }
  return Object.keys(fonts).length ? { props, fonts } : { props };
}
/** The default an object stands for (with what it owns), its fonts read from the sheet it is on. */
export function capture(doc: SchDocument | null, kind: SchKind, bags: PropertyBag[]): SchDefault {
  const d = capOne(doc, kind, bags[0]!, false);
  if (bags.length > 1) d.children = bags.slice(1).map((b) => capOne(doc, kind, b, true));
  return d;
}

function layOne(doc: SchDocument | null, kind: SchKind, fresh: PropertyBag, d: SchDefault, child: boolean, keep: readonly string[]): PropertyBag {
  const out = fresh.clone();
  const mine = (k: string) => !held(kind, k, child) && !keep.includes(k.toUpperCase());
  for (const k of out.keys()) if (mine(k)) out.delete(k);
  for (const [k, v] of Object.entries(d.props)) if (mine(k)) out.set(k, v);
  // A pin keeps the way the fresh one is turned (its place goes with it); the rest of its flags are the default's
  if (kind.record === SR.PIN && !child && fresh.has('PINCONGLOMERATE')) out.set('PINCONGLOMERATE', String((out.int('PINCONGLOMERATE') & ~3) | (fresh.int('PINCONGLOMERATE') & 3)));
  if (doc) for (const [k, f] of Object.entries(d.fonts ?? {})) {
    const { id, change } = ensureFont(doc, f);
    // A document with no font list of its own to add to (a library's symbol): the object keeps the font it was made with
    const there = sheetFonts(doc)[id - 1];
    if (!change && !(there && sameFont(there, f))) continue;
    change?.apply();
    out.set(k, String(id));
  }
  return out;
}
/**
 * A freshly made object with a default laid over it: the default's properties in place of its
 * own, what the clicks decide left alone, the default's fonts found (or added) in the sheet.
 * `keep`: properties the command that places it decides (a GND port's style and net).
 */
export function lay(doc: SchDocument | null, fresh: PropertyBag, d: SchDefault | undefined, keep: readonly string[] = []): PropertyBag {
  const kind = kindOfBag(fresh);
  return kind && d ? layOne(doc, kind, fresh, d, false, keep) : fresh;
}

/* ─── The defaults kept ──────────────────────────────────────────────────────────────── */

const KEY = 'sch.primitiveDefaults.v1';
/** Before 26.180: what each stamping command placed last, by command (no fonts kept). */
const OLD_KEY = 'sch.placeDefaults.v1';
const OLD_IDS: Record<string, string> = {
  'place.netLabel': 'Net Label', 'place.power': 'Power Port', 'ad:Sch:PlaceOffsheetConnector': 'Off Sheet Connector', 'place.junction': 'Junction',
  'place.noErc': 'No ERC', 'ad:Sch:PlaceBusEntry': 'Bus Entry', 'place.text': 'Text String',
};

const valid = (d: unknown): d is SchDefault => !!d && typeof d === 'object' && typeof (d as SchDefault).props === 'object' && (d as SchDefault).props !== null
  && Object.values((d as SchDefault).props).every((v) => typeof v === 'string');
function parse(text: string | null): Map<string, SchDefault> {
  const out = new Map<string, SchDefault>();
  if (!text) return out;
  const o = JSON.parse(text) as Record<string, unknown>;
  for (const [k, d] of Object.entries(o)) if (schKind(k) && valid(d)) out.set(k, d);
  return out;
}
function load(): Map<string, SchDefault> {
  try {
    const now = readLocal(KEY);
    if (now !== null) return parse(now);
    // The first run of this store: what Tab had made the default so far comes along
    const out = new Map<string, SchDefault>();
    for (const [id, bag] of Object.entries(JSON.parse(readLocal(OLD_KEY) ?? '{}') as Record<string, Record<string, string>>)) {
      const kind = schKind(OLD_IDS[id] ?? '');
      if (kind && bag && typeof bag === 'object') out.set(kind.name, capture(null, kind, [PropertyBag.from(bag)]));
    }
    return out;
  } catch { return new Map(); }
}
let store: Map<string, SchDefault> | null = null;
const all = () => (store ??= load());
const save = () => { try { writeLocal(KEY, JSON.stringify(Object.fromEntries(all()))); } catch { /* kept for this session */ } };

const listeners = new Set<(name: string | null) => void>();
/** Told when a default is set or reset from the page (`null`: all of them): what a command remembers of it is stale. */
export function onSchDefaults(fn: (name: string | null) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

export const storedDefault = (name: string): SchDefault | undefined => all().get(name);
export const hasSchDefault = (name: string): boolean => all().has(name);
/** `quiet`: set by the command placing it (Tab, the object as last placed), which already has it. */
export function setSchDefault(name: string, d: SchDefault, quiet = false): void {
  if (!schKind(name)) return;
  all().set(name, d);
  save();
  if (!quiet) for (const fn of listeners) fn(name);
}
/** One kind, or all of them, back to how the objects are first made. */
export function resetSchDefaults(name?: string): void {
  if (name) all().delete(name); else all().clear();
  save();
  for (const fn of listeners) fn(name ?? null);
}

/** A freshly made object with its kind's default laid over it. */
export const withDefault = (doc: SchDocument | null, fresh: PropertyBag, keep: readonly string[] = []): PropertyBag => lay(doc, fresh, storedDefault(kindOfBag(fresh)?.name ?? ''), keep);

/** A kind's object as its default has it (with what it owns), for the sheet `doc`: what Edit Values and Tab show. */
export function defaultItems(doc: SchDocument | null, kind: SchKind, d: SchDefault | undefined = storedDefault(kind.name)): Item[] {
  const items = kind.make();
  if (!d) return items;
  return items.map((it, i) => {
    if (i === 0) return { ...it, bag: layOne(doc, kind, it.bag, d, false, []) };
    const c = d.children?.[i - 1];
    return c ? { ...it, bag: layOne(doc, kind, it.bag, c, true, []) } : it;
  });
}

/** The properties a default's dialog leaves out, by their names there: what the clicks decide, and a pin's length (Preferences' own setting). */
export const defaultHides = (kind: SchKind) => (name: string): boolean => name === 'Unique ID' || name === 'Owner Part ID'
  || (kind.record === SR.PIN && name === 'Pin Length')
  || (!!kind.shape && (/^(Radius|Start Angle|End Angle|X Size|Y Size|Primary Position)$/.test(name) || (kind.record !== SR.ROUND_RECTANGLE && /^[XY] Radius$/.test(name))));

/** Save As: every default that is set, as text. */
export const exportSchDefaults = (): string => JSON.stringify({ format: 'konium-sch-defaults', version: 1, defaults: Object.fromEntries(all()) }, null, 1);
/** Load: the defaults of a saved file take the place of those it names; how many it held. */
export function importSchDefaults(text: string): number {
  let o: { format?: string; defaults?: Record<string, unknown> };
  try { o = JSON.parse(text) as typeof o; } catch { throw new Error('not a Konium Designer defaults file'); }
  if (o?.format !== 'konium-sch-defaults' || !o.defaults || typeof o.defaults !== 'object') throw new Error(o?.format === 'konium-pcb-defaults' ? 'these are a board\'s defaults (PCB Editor › Defaults loads them)' : 'not a Konium Designer schematic defaults file');
  let n = 0;
  for (const [k, d] of Object.entries(o.defaults)) if (schKind(k) && valid(d)) { all().set(k, d); n++; }
  save();
  for (const fn of listeners) fn(null);
  return n;
}

/** For tests: forget what was read from storage. */
export function forgetSchDefaults(): void { store = null; }
