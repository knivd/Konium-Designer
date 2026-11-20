/**
 * Demo.SchLib: the demo's parts as a schematic library, written by Konium's own SchLib
 * writer (pins in Altium's binary library form). Footprints point at Demo.PcbLib. It exercises
 * Place › Part end to end; it is not evidence of Altium compatibility — only real files are.
 */
import { PropertyBag } from '../altium/props';
import { writeSchLib } from '../altium/schlib';
import { SR, setSchCoord } from '../../model/sch';
import { SCH_UNIT } from '../../core/units';
import { uniqueId } from '../../model/schEdit';

type XY = [number, number];
const C = { body: 128, fill: 11599871, pin: 0, text: 8388608 };

export class SymbolBuilder {
  bags: PropertyBag[] = [];
  constructor(readonly libRef: string, readonly description: string, readonly parts = 1) {
    this.bags.push(PropertyBag.from({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, COMPONENTDESCRIPTION: description, PARTCOUNT: parts + 1, DISPLAYMODECOUNT: 1,
      OWNERPARTID: -1, CURRENTPARTID: 1, LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', TARGETFILENAME: '*', AREACOLOR: C.fill, COLOR: C.body,
      DESIGNITEMID: libRef, UNIQUEID: uniqueId() }));
  }
  private modeNow = 0;
  /** The display mode's key for a record made beside add(). */
  protected modeProp(): Record<string, number> { return this.modeNow ? { OWNERPARTDISPLAYMODE: this.modeNow } : {}; }
  /** What is drawn from here on belongs to the display mode `n` (0: the first); a part's text and models belong to all of them. */
  mode(n: number): this {
    this.modeNow = n;
    if (n + 1 > this.bags[0]!.int('DISPLAYMODECOUNT', 1)) this.bags[0]!.set('DISPLAYMODECOUNT', String(n + 1));
    return this;
  }
  add(props: Record<string, string | number | boolean>, pts: Record<string, XY> = {}): number {
    const b = PropertyBag.from(this.modeNow && props.OWNERPARTID !== -1 ? { ...props, OWNERPARTDISPLAYMODE: this.modeNow } : props);
    for (const [k, [x, y]] of Object.entries(pts)) { setSchCoord(b, `${k}.X`, x * SCH_UNIT); setSchCoord(b, `${k}.Y`, y * SCH_UNIT); }
    this.bags.push(b);
    return this.bags.length - 1;
  }
  rect(a: XY, c: XY, part = 1): this { this.add({ RECORD: SR.RECTANGLE, OWNERPARTID: part, LINEWIDTH: 1, COLOR: C.body, AREACOLOR: C.fill, ISSOLID: true }, { LOCATION: a, CORNER: c }); return this; }
  line(a: XY, c: XY, part = 1, width = 1): this { this.add({ RECORD: SR.LINE, OWNERPARTID: part, LINEWIDTH: width, COLOR: C.body }, { LOCATION: a, CORNER: c }); return this; }
  polygon(pts: XY[], part = 1, solid = true): this {
    const b = PropertyBag.from({ RECORD: SR.POLYGON, OWNERPARTID: part, LINEWIDTH: 1, COLOR: C.body, AREACOLOR: solid ? C.body : C.fill, ISSOLID: true, LOCATIONCOUNT: pts.length, ...this.modeProp() });
    pts.forEach(([x, y], i) => { setSchCoord(b, `X${i + 1}`, x * SCH_UNIT); setSchCoord(b, `Y${i + 1}`, y * SCH_UNIT); });
    this.bags.push(b);
    return this;
  }
  /** orient: 0 right, 1 up, 2 left, 3 down (the direction the pin points away from the body). */
  pin(designator: string, name: string, at: XY, orient: number, length: number, o: { part?: number; electrical?: number; showName?: boolean; showDesignator?: boolean } = {}): this {
    this.add({ RECORD: SR.PIN, OWNERPARTID: o.part ?? 1, ELECTRICAL: o.electrical ?? 4, PINCONGLOMERATE: orient | ((o.showName ?? true) ? 0x08 : 0) | ((o.showDesignator ?? true) ? 0x10 : 0),
      PINLENGTH: length, NAME: name, DESIGNATOR: designator, COLOR: C.pin }, { LOCATION: at });
    return this;
  }
  designator(text: string, at: XY): this { this.add({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, NAME: 'Designator', TEXT: text, FONTID: 1, COLOR: C.text }, { LOCATION: at }); return this; }
  comment(text: string, at: XY): this { this.add({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: 'Comment', TEXT: text, FONTID: 1, COLOR: C.text }, { LOCATION: at }); return this; }
  footprint(name: string, description: string): this {
    // Nested records name their parent's position in the symbol, as Altium writes them
    const list = this.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERPARTID: -1 });
    const impl = this.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: description, MODELNAME: name, MODELTYPE: 'PCBLIB',
      DATAFILECOUNT: 1, MODELDATAFILEENTITY0: name, MODELDATAFILEKIND0: 'PCBLib', ISCURRENT: true, UNIQUEID: uniqueId() });
    this.add({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl, OWNERPARTID: -1 });
    this.add({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl, OWNERPARTID: -1 });
    return this;
  }
}

export function demoSymbols(): SymbolBuilder[] {
  return [
    new SymbolBuilder('Res', 'Resistor').rect([-4, -10], [4, 10]).pin('1', '1', [0, 10], 1, 10, { showName: false }).pin('2', '2', [0, -10], 3, 10, { showName: false })
      .designator('R?', [8, 4]).comment('1k', [8, -6]).footprint('0805', 'Chip resistor, 0805'),
    new SymbolBuilder('Cap', 'Capacitor').line([-12, 3], [12, 3], 1, 2).line([-12, -3], [12, -3], 1, 2)
      .pin('1', '1', [0, 3], 1, 17, { showName: false }).pin('2', '2', [0, -3], 3, 17, { showName: false })
      .designator('C?', [16, 6]).comment('100nF', [16, -6]).footprint('0805', 'Chip capacitor, 0805'),
    new SymbolBuilder('LED', 'Light-emitting diode').polygon([[-10, 10], [10, 10], [0, -8]]).line([-10, -8], [10, -8], 1, 2)
      .line([13, 4], [20, 11]).line([16, -2], [23, 5])
      .pin('A', 'A', [0, 10], 1, 10, { showName: false }).pin('K', 'K', [0, -8], 3, 12, { showName: false })
      .designator('D?', [26, 6]).comment('Green', [26, -6]).footprint('LED0805', 'Chip LED, 0805'),
    new SymbolBuilder('Header 2', 'Header, 2-Pin').rect([0, 0], [30, 40])
      .pin('1', '1', [30, 30], 0, 20, { electrical: 7, showName: false }).pin('2', '2', [30, 10], 0, 20, { electrical: 7, showName: false })
      .designator('J?', [0, 44]).comment('Header 2', [0, -10]).footprint('HDR1X2', 'Header, 2-Pin'),
    new SymbolBuilder('LDO SOT-223', 'Low-dropout regulator, SOT-223').rect([0, 0], [100, 70])
      .pin('3', 'VIN', [0, 50], 2, 20, { electrical: 0 }).pin('2', 'VOUT', [100, 50], 0, 20, { electrical: 2 })
      .pin('1', 'GND', [50, 0], 3, 20, { electrical: 7 }).pin('4', 'TAB', [100, 30], 0, 20)
      .designator('U?', [0, 80]).comment('LDO 3V3', [50, 80]).footprint('SOT-223', 'SOT-223, 4 leads'),
    (() => {
      const s = new SymbolBuilder('LM358', 'Dual operational amplifier', 2);
      for (const [part, [inp, inn, out]] of [[1, ['3', '2', '1']], [2, ['5', '6', '7']]] as const) {
        s.polygon([[0, -30], [0, 30], [50, 0]], part, false)
          .pin(inp, '+', [0, 10], 2, 20, { part, electrical: 0 }).pin(inn, '-', [0, -10], 2, 20, { part, electrical: 0 })
          .pin(out, 'OUT', [50, 0], 0, 20, { part, electrical: 2, showName: false });
      }
      s.pin('8', 'V+', [20, 20], 1, 20, { part: 1, electrical: 7, showName: false }).pin('4', 'V-', [20, -20], 3, 20, { part: 1, electrical: 7, showName: false });
      return s.designator('U?', [0, 34]).comment('LM358', [30, 34]);
    })(),
  ];
}

export const demoSchLib = (): Uint8Array => writeSchLib(demoSymbols().map((s) => ({ libRef: s.libRef, description: s.description, parts: s.parts, bags: s.bags })));
