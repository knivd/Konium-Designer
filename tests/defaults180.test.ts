import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newSchDoc } from '../src/formats/altium/schdoc';
import { PropertyBag } from '../src/formats/altium/props';
import { SR, schCoord } from '../src/model/sch';
import { mil } from '../src/core/units';
import { settings } from '../src/core/settings';
import { ensureFont, sheetFonts, type FontSpec } from '../src/model/schProps';
import { wireBag } from '../src/model/schEdit';
import { netLabelBag, offSheetBag, pinFactory, powerBag, rectBag, sheetSymbolItems } from '../src/model/schPlace';
import {
  SCH_GROUPS, SCH_KINDS, capture, defaultHides, defaultItems, exportSchDefaults, forgetSchDefaults, hasSchDefault, importSchDefaults, kindOfBag, onSchDefaults,
  resetSchDefaults, schKind, setSchDefault, storedDefault, withDefault,
} from '../src/model/schDefaults';
import { PAGES } from '../src/app/settingsSchema';

/** A browser's storage to stand for it here. */
const mem = new Map<string, string>();
const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); }, key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
beforeEach(() => { mem.clear(); (globalThis as { localStorage?: unknown }).localStorage = storage; forgetSchDefaults(); });
afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; forgetSchDefaults(); });

const sheet = () => newSchDoc('Sheet1.SchDoc', 0, 0);
const BOLD: FontSpec = { name: 'Arial', size: 14, bold: true, italic: false, underline: false, strikeout: false };
const strip = (b: PropertyBag) => { const o = b.toObject(); delete o.UNIQUEID; return o; };

describe('Preferences › Schematic › Default Primitives (26.180): the store', () => {
  it('lists every kind once, in a group, each made as a record of its own kind', () => {
    expect(new Set(SCH_KINDS.map((k) => k.name)).size).toBe(SCH_KINDS.length);
    expect(SCH_KINDS.length).toBe(31);
    for (const k of SCH_KINDS) {
      expect(SCH_GROUPS, k.name).toContain(k.group);
      const first = k.make()[0]!.bag;
      expect(first.int('RECORD', -1), k.name).toBe(k.record);
      expect(kindOfBag(first)?.name, k.name).toBe(k.name);
    }
    // A power port and an off sheet connector are one record, told apart
    expect(kindOfBag(powerBag(4, 'GND'))?.name).toBe('Power Port');
    expect(kindOfBag(offSheetBag('A'))?.name).toBe('Off Sheet Connector');
    expect(kindOfBag(PropertyBag.from({ RECORD: SR.COMPONENT }))).toBeUndefined();
  });

  it('with nothing set, an object is as it is first made', () => {
    const doc = sheet();
    for (const k of SCH_KINDS) {
      expect(hasSchDefault(k.name)).toBe(false);
      const made = k.make(), got = defaultItems(doc, k);
      expect(got.map((it) => strip(it.bag)), k.name).toEqual(made.map((it) => strip(it.bag)));
      expect(strip(withDefault(doc, made[0]!.bag)), k.name).toEqual(strip(made[0]!.bag));
    }
  });

  it('a stamped object takes all of its default: text, colour, the way it is turned, and its font in the sheet it lands on', () => {
    const a = sheet(), k = schKind('Net Label')!;
    const edited = netLabelBag('CLK');
    edited.set('COLOR', '255'); edited.set('ORIENTATION', '1');
    const { id, change } = ensureFont(a, BOLD); change?.apply();
    edited.set('FONTID', String(id));
    setSchDefault(k.name, capture(a, k, [edited]));
    expect(storedDefault('Net Label')!.fonts).toMatchObject({ FONTID: BOLD });
    expect(storedDefault('Net Label')!.props.FONTID).toBeUndefined();

    // On a sheet that has no such font yet: the font is added, and the label points at it
    const b = sheet(), before = sheetFonts(b).length;
    const placed = withDefault(b, netLabelBag('NetLabel1'));
    expect([placed.get('TEXT'), placed.get('COLOR'), placed.get('ORIENTATION')]).toEqual(['CLK', '255', '1']);
    expect(sheetFonts(b).length).toBe(before + 1);
    expect(sheetFonts(b)[placed.int('FONTID') - 1]).toMatchObject({ name: 'Arial', size: 14, bold: true });
    // A second one finds the font there
    withDefault(b, netLabelBag('NetLabel1'));
    expect(sheetFonts(b).length).toBe(before + 1);
  });

  it('a shape takes its default\'s look and keeps the corners the clicks gave it', () => {
    const doc = sheet(), k = schKind('Rectangle')!;
    const edited = rectBag({ x: 0, y: 0 }, { x: mil(900), y: mil(900) });
    edited.set('COLOR', '32768'); edited.set('AREACOLOR', '16777215'); edited.set('LINEWIDTH', '2'); edited.delete('ISSOLID');
    setSchDefault(k.name, capture(doc, k, [edited]));
    const drawn = withDefault(doc, rectBag({ x: mil(100), y: mil(200) }, { x: mil(400), y: mil(300) }));
    expect([drawn.get('COLOR'), drawn.get('AREACOLOR'), drawn.get('LINEWIDTH'), drawn.has('ISSOLID')]).toEqual(['32768', '16777215', '2', false]);
    expect([schCoord(drawn, 'LOCATION.X'), schCoord(drawn, 'LOCATION.Y'), schCoord(drawn, 'CORNER.X'), schCoord(drawn, 'CORNER.Y')]).toEqual([mil(100), mil(200), mil(400), mil(300)]);
    // A wire: its width and colour, the corners its own
    const w = schKind('Wire')!, wide = wireBag([{ x: 0, y: 0 }, { x: mil(100), y: 0 }], { width: 3, color: 255 });
    setSchDefault(w.name, capture(doc, w, [wide]));
    const wire = withDefault(doc, wireBag([{ x: mil(500), y: mil(500) }, { x: mil(700), y: mil(500) }, { x: mil(700), y: mil(900) }]));
    expect([wire.get('LINEWIDTH'), wire.get('COLOR'), wire.int('LOCATIONCOUNT'), schCoord(wire, 'X3'), schCoord(wire, 'Y3')]).toEqual(['3', '255', 3, mil(700), mil(900)]);
    // A bus is its own kind
    expect(withDefault(doc, wireBag([{ x: 0, y: 0 }, { x: mil(100), y: 0 }], { bus: true })).get('LINEWIDTH')).toBe('2');
  });

  it('a command\'s own properties stay its own: a GND port takes the default\'s colour, not its style or net', () => {
    const doc = sheet(), k = schKind('Power Port')!;
    const edited = powerBag(1, 'VBAT'); edited.set('COLOR', '16711680'); edited.set('SHOWNETNAME', 'F');
    setSchDefault(k.name, capture(doc, k, [edited]));
    const generic = withDefault(doc, powerBag(2, 'VCC'));
    expect([generic.get('STYLE'), generic.get('TEXT'), generic.get('COLOR'), generic.bool('SHOWNETNAME')]).toEqual(['1', 'VBAT', '16711680', false]);
    const gnd = withDefault(doc, powerBag(4, 'GND'), ['STYLE', 'TEXT', 'ORIENTATION']);
    expect([gnd.get('STYLE'), gnd.get('TEXT'), gnd.get('ORIENTATION'), gnd.get('COLOR'), gnd.bool('SHOWNETNAME')]).toEqual(['4', 'GND', '3', '16711680', false]);
    // An off sheet connector has a default of its own
    expect(withDefault(doc, offSheetBag('OffSheet')).get('COLOR')).toBe('128');
  });

  it('a pin takes its default\'s kind and names; its length is Preferences\' own, and it is turned as it is made', () => {
    const doc = sheet(), k = schKind('Pin')!, was = settings.schPinLength;
    try {
      const edited = pinFactory();
      edited.set('ELECTRICAL', '0'); edited.set('NAME', 'IN'); edited.set('PINLENGTH', '99'); edited.set('PINCONGLOMERATE', String(1 | 0x08));
      setSchDefault(k.name, capture(doc, k, [edited]));
      expect(storedDefault('Pin')!.props.PINLENGTH).toBeUndefined();
      settings.schPinLength = 200;
      const pin = withDefault(doc, pinFactory());
      expect([pin.get('ELECTRICAL'), pin.get('NAME'), pin.int('PINLENGTH'), schCoord(pin, 'LOCATION.X')]).toEqual(['0', 'IN', 20, mil(200)]);
      // Turned as the fresh one (2), the designator shown no longer (the default's flag)
      expect([pin.int('PINCONGLOMERATE') & 3, !!(pin.int('PINCONGLOMERATE') & 0x10), !!(pin.int('PINCONGLOMERATE') & 0x08)]).toEqual([2, false, true]);
    } finally { settings.schPinLength = was; }
  });

  it('a sheet symbol\'s default holds its designator and file name too', () => {
    const doc = sheet(), k = schKind('Sheet Symbol')!;
    const items = sheetSymbolItems({ x: 0, y: 0 }, { x: mil(1500), y: -mil(600) }, 'U_Power', 'Power.SchDoc');
    items[0]!.bag.set('COLOR', '0'); items[1]!.bag.set('COLOR', '255'); items[2]!.bag.set('ISHIDDEN', 'T');
    setSchDefault(k.name, capture(doc, k, items.map((it) => it.bag)));
    const [sym, name, file] = defaultItems(doc, k);
    expect([sym!.bag.get('COLOR'), sym!.bag.int('XSIZE'), sym!.bag.int('YSIZE')]).toEqual(['0', 150, 60]);
    expect([name!.bag.get('TEXT'), name!.bag.get('COLOR'), name!.owner]).toEqual(['U_Power', '255', 0]);
    expect([file!.bag.get('TEXT'), file!.bag.bool('ISHIDDEN')]).toEqual(['Power.SchDoc', true]);
  });

  it('is kept from one session to the next; Reset takes one back, Reset All every one; the page is told, a command placing is not', () => {
    const doc = sheet(), k = schKind('Junction')!, heard: (string | null)[] = [];
    const off = onSchDefaults((n) => heard.push(n));
    const j = k.make()[0]!.bag; j.set('COLOR', '255');
    setSchDefault(k.name, capture(doc, k, [j]));
    setSchDefault('Net Label', capture(doc, schKind('Net Label')!, [netLabelBag('A')]), true);   // quiet: Tab while placing
    expect(heard).toEqual(['Junction']);
    forgetSchDefaults();   // a new session reads what was kept
    expect(storedDefault('Junction')!.props.COLOR).toBe('255');
    expect(hasSchDefault('Net Label')).toBe(true);
    resetSchDefaults('Junction');
    expect([hasSchDefault('Junction'), hasSchDefault('Net Label')]).toEqual([false, true]);
    resetSchDefaults();
    expect(hasSchDefault('Net Label')).toBe(false);
    expect(heard).toEqual(['Junction', 'Junction', null]);
    forgetSchDefaults();
    expect(hasSchDefault('Net Label')).toBe(false);
    off();
  });

  it('Save As and Load carry them; a board\'s defaults file is told apart; what Tab had kept before comes along once', () => {
    const doc = sheet(), k = schKind('Text String')!;
    const t = k.make()[0]!.bag; t.set('TEXT', 'Rev A'); t.set('COLOR', '255');
    setSchDefault(k.name, capture(doc, k, [t]));
    const file = exportSchDefaults();
    resetSchDefaults();
    expect(importSchDefaults(file)).toBe(1);
    expect(storedDefault('Text String')!.props).toMatchObject({ TEXT: 'Rev A', COLOR: '255' });
    expect(() => importSchDefaults('{"format":"konium-pcb-defaults","defaults":{}}')).toThrow(/board/);
    expect(() => importSchDefaults('nonsense')).toThrow(/not a Konium Designer/);
    // Before this store, what each stamping command placed last was kept by command: a session's first read takes it over
    mem.clear(); forgetSchDefaults();
    mem.set('konium.sch.placeDefaults.v1', JSON.stringify({ 'place.netLabel': { RECORD: '25', COLOR: '255', FONTID: '3', TEXT: 'D7', 'LOCATION.X': '0' }, 'place.gnd': { RECORD: '17', TEXT: 'AGND' } }));
    expect(storedDefault('Net Label')!.props).toMatchObject({ COLOR: '255', TEXT: 'D7' });
    expect(storedDefault('Net Label')!.fonts).toBeUndefined();
    expect(hasSchDefault('Power Port')).toBe(false);   // a GND port's memory was the command's, not the kind's
  });

  it('a default\'s dialog leaves out what the clicks decide, and a pin\'s length', () => {
    const arc = defaultHides(schKind('Arc')!), round = defaultHides(schKind('Round Rectangle')!), ell = defaultHides(schKind('Ellipse')!), pin = defaultHides(schKind('Pin')!), label = defaultHides(schKind('Net Label')!);
    expect([arc('Radius'), arc('Start Angle'), arc('Colour'), arc('Line Width')]).toEqual([true, true, false, false]);
    expect([round('X Radius'), ell('X Radius')]).toEqual([false, true]);   // a round rectangle's corner radius is its look
    expect([pin('Pin Length'), pin('Electrical Type'), label('Text'), label('Font'), label('Unique ID')]).toEqual([true, false, false, false, true]);
  });

  it('the page is Preferences\' own (not a list to read), and Permanent is a setting', () => {
    const page = PAGES.find((p) => p.id === 'sch-primitives')!;
    expect(page.custom).toBe('schPrimitives');
    expect(settings.schDefaultsPermanent).toBe(false);
  });
});
