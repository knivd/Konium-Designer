import { describe, expect, it } from 'vitest';
import { ansiToStr, guessCodePage, langCodePage, strToAnsi, textPrefs } from '../src/formats/text';
import { PropertyBag } from '../src/formats/altium/props';
import { readSchDoc, writeSchDoc } from '../src/formats/altium/schdoc';
import { readPinWideText, readSchLib, writePinWideText, writeSchLib } from '../src/formats/altium/schlib';
import { readPrjPcb, writePrjPcb, iniGet, iniSet } from '../src/formats/altium/prjpcb';
import { deriveSheet } from '../src/model/sch';
import { fromSymbol, isSymbolFamily } from '../src/render/symbolFont';
import { stepCopies } from '../src/model/schPlace';

const enc = (s: string, cp: string) => Uint8Array.from(new TextEncoderLike(cp).encode(s));
/** Text in a Windows code page (Node has no TextEncoder for them: the page's own table, read backwards). */
class TextEncoderLike {
  private rev = new Map<string, number>();
  constructor(cp: string) { const d = new TextDecoder(cp); for (let b = 0; b < 256; b++) this.rev.set(d.decode(new Uint8Array([b])), b); }
  encode(s: string): number[] { return [...s].map((c) => this.rev.get(c) ?? 0x3f); }
}
const bin = (s: string, cp: number) => String.fromCharCode(...enc(s, `windows-${cp}`));
/** An ASCII schematic whose labels are 8-bit text in a code page (no %UTF8% twins), as older files and other systems wrote them. */
const ascii = (texts: string[], cp: number, sheet = '|RECORD=31|SHEETSTYLE=3|WORKSPACEORIENTATION=1|BORDERON=T') => {
  const lines = ['|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=4', sheet,
    ...texts.map((t, i) => `|RECORD=4|LOCATION.X=100|LOCATION.Y=${700 - i * 50}|COLOR=0|FONTID=1|TEXT=${bin(t, cp)}|OWNERPARTID=-1`)];
  return Uint8Array.from(lines.join('\r\n') + '\r\n', (c) => c.charCodeAt(0));
};
const labels = (bytes: Uint8Array) => { const d = readSchDoc(bytes, 'x.SchDoc'); return d.records.filter((r) => r.bag?.int('RECORD', -1) === 4).map((r) => r.bag!.get('TEXT')); };

describe('text in the Windows code page of the system that wrote it (report, 26.163)', () => {
  it('each page both ways', () => {
    for (const [cp, t] of [[1251, 'ЗАХРАНВАНЕ Входове'], [1250, 'Łódź Žluťoučký'], [1253, 'Αντίσταση Ωμ'], [1254, 'Güç İşlemci'], [1255, 'נגד'], [1256, 'مقاومة'], [1257, 'Ąžuolas'], [1252, 'Größe 10µF ±5%']] as const) {
      const b = strToAnsi(t, cp)!;
      expect(b).not.toBeNull();
      expect(ansiToStr(b, cp)).toBe(t);
    }
    expect(strToAnsi('Ω', 1251)).toBeNull();
  });

  it('the page told from the text: Cyrillic, Central European and Western whatever the browser; the rest by its language', () => {
    const g = (t: string, cp: number, lang = 'en-GB') => guessCodePage([bin(t, cp)], lang);
    expect(g('ЗАХРАНВАНЕ 2 Блок-2027', 1251)).toBe(1251);
    expect(g('Кондензатор 10 мкФ х 4', 1251)).toBe(1251);
    expect(g('Łódź Żółw ąę', 1250)).toBe(1250);
    expect(g('Größe Élément 10µF ±5% 25°C', 1252)).toBe(1252);
    expect(g('Größe Élément', 1252, 'bg-BG')).toBe(1252);
    expect(g('Αντίσταση Ωμ', 1253, 'el')).toBe(1253);
    expect(g('Güç İşlemci', 1254, 'tr-TR')).toBe(1254);
    expect(langCodePage('bg-BG')).toBe(1251);
    expect(langCodePage('pt-BR')).toBe(1252);
  });

  it('a Bulgarian sheet reads as written, goes back byte for byte, and a change is written in its page with a %UTF8% twin', () => {
    const bytes = ascii(['ЗАХРАНВАНЕ 12 V', 'Входове', 'Rev 2'], 1251);
    expect(labels(bytes)).toEqual(['ЗАХРАНВАНЕ 12 V', 'Входове', 'Rev 2']);
    const d = readSchDoc(bytes, 'x.SchDoc');
    expect(d.diags.items.some((m) => /code page 1251/.test(m.message))).toBe(true);
    expect([...writeSchDoc(d)]).toEqual([...bytes]);
    const bag = d.records.find((r) => r.bag?.int('RECORD', -1) === 4)!.bag!;
    bag.set('TEXT', 'Нов блок');
    expect(bag.getRaw('TEXT')).toBe(bin('Нов блок', 1251));
    expect(bag.has('%UTF8%TEXT')).toBe(true);
    expect(labels(writeSchDoc(d))[0]).toBe('Нов блок');
  });

  it('Preferences can name the page', () => {
    const bytes = ascii(['Güç İşlemci'], 1254);
    expect(labels(bytes)[0]).not.toBe('Güç İşlemci');
    textPrefs.codePage = 1254;
    try { expect(labels(bytes)[0]).toBe('Güç İşlemci'); } finally { textPrefs.codePage = 'auto'; }
  });

  it('a project file without a BOM: its parameters in its page, written back in it', () => {
    const text = `[Design]\r\nVersion=1.0\r\n[Parameter1]\r\nName=Обект\r\nValue=${'Захранване'}\r\n`;
    const p = readPrjPcb(Uint8Array.from(bin(text, 1251), (c) => c.charCodeAt(0)), 'x.PrjPcb');
    expect(p.parameters.get('Обект') ?? iniGet(p, 'Parameter1', 'Value')).toBe('Захранване');
    iniSet(p, 'Parameter1', 'Value', 'Вход');
    expect(String.fromCharCode(...writePrjPcb(p))).toContain(bin('Value=Вход', 1251));
  });

  it('a library pin\'s text beyond its 8 bits read from PinWideText and written there again', () => {
    const comp = PropertyBag.from({ RECORD: 1, LIBREFERENCE: 'U', PARTCOUNT: 2, DISPLAYMODECOUNT: 1, OWNERPARTID: -1 });
    const pin = PropertyBag.from({ RECORD: 2, OWNERPARTID: 1, PINLENGTH: 30, ELECTRICAL: 4 });
    pin.set('NAME', 'Вход −'); pin.set('DESIGNATOR', '1'); pin.set('DESCRIPTION', 'Input, 10 µF to GND');
    const plain = PropertyBag.from({ RECORD: 2, OWNERPARTID: 1, PINLENGTH: 30, NAME: 'GND', DESIGNATOR: '2' });
    const wide = writePinWideText([pin, plain])!;
    expect([...readPinWideText(wide)]).toEqual([[0, { NAME: 'Вход −', DESC: 'Input, 10 µF to GND' }]]);
    const lib = readSchLib(writeSchLib([{ libRef: 'U', bags: [comp, pin, plain] }]), 'x.SchLib');
    const pins = lib.symbols[0]!.bags.filter((b) => b.int('RECORD', -1) === 2);
    expect(pins.map((b) => b.get('NAME'))).toEqual(['Вход −', 'GND']);
    expect(pins[0]!.get('DESCRIPTION')).toBe('Input, 10 µF to GND');
  });
});

describe('portrait sheets (report, 26.163)', () => {
  it('a standard sheet in portrait stands on its end, its zones with it', () => {
    const b = PropertyBag.from({ RECORD: 31, SHEETSTYLE: 3, WORKSPACEORIENTATION: 1, BORDERON: true });
    const s = deriveSheet(b);
    expect([s.width / 100_000, s.height / 100_000]).toEqual([2230, 3150]);
    expect(s.zonesY).toBeGreaterThan(s.zonesX);
    const land = deriveSheet(PropertyBag.from({ RECORD: 31, SHEETSTYLE: 3 }));
    expect([land.width / 100_000, land.height / 100_000]).toEqual([3150, 2230]);
    // A custom sheet keeps its own size
    expect(deriveSheet(PropertyBag.from({ RECORD: 31, USECUSTOMSHEET: true, CUSTOMX: 1000, CUSTOMY: 800, WORKSPACEORIENTATION: 1 })).width / 100_000).toBe(1000);
  });
});

describe('the Symbol font (26.163)', () => {
  it('its letters as the Greek and math characters Windows draws for them', () => {
    expect(fromSymbol('10kW ±5% m p a')).toBe('10κΩ ±5% μ π α');
    expect(fromSymbol('³ £ Ö')).toBe('≥ ≤ √');
    expect(isSymbolFamily('"Symbol", serif')).toBe(true);
    expect(isSymbolFamily('"Symbola", serif')).toBe(false);
  });
});

describe('Shift+drag copies, named a step on (26.163)', () => {
  const items = () => [
    { bag: PropertyBag.from({ RECORD: 1, LIBREFERENCE: 'RES' }), owner: -1 },
    { bag: PropertyBag.from({ RECORD: 34, TEXT: 'R5' }), owner: 0 },
    { bag: PropertyBag.from({ RECORD: 2, NAME: 'A', DESIGNATOR: '3' }), owner: 0 },
    { bag: PropertyBag.from({ RECORD: 25, TEXT: 'D0' }), owner: -1 },
    { bag: PropertyBag.from({ RECORD: 17, TEXT: 'VCC' }), owner: -1 },
  ];
  const next = (s: string) => { const m = /^(.*?)(\d+)$/.exec(s); return m ? `${m[1]}${Number(m[2]) + 1}` : s; };
  it('a part\'s designator to the next free one; a net label on; its own pins and a power port as they are', () => {
    const out = stepCopies(items(), new Set(['R5', 'R6']), next);
    expect(out.map((it) => it.bag.get('TEXT') ?? it.bag.get('NAME'))).toEqual([undefined, 'R7', 'A', 'D1', 'VCC']);
    expect(out[2]!.bag.get('DESIGNATOR')).toBe('3');
  });
  it('R? stays R?', () => {
    const it2 = items();
    it2[1]!.bag.set('TEXT', 'R?');
    expect(stepCopies(it2, new Set(), next)[1]!.bag.get('TEXT')).toBe('R?');
  });
});
