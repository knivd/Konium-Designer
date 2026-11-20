/**
 * The showcase's schematics, one A3 sheet per section (Power, MCU, FPGA, IO), drawn from the
 * design's netlist: ICs as boxes with named pins, passives as their symbols, nets by labels and
 * power ports (net identifiers global across the sheets).
 */
import { SchBuilder, C as COL } from '../../../src/formats/synthetic/schBuilder';
import { cfbPut, newEntry, writeCfb } from '../../../src/formats/cfb/cfb';
import { binToBytes } from '../../../src/formats/text';
import { SR } from '../../../src/model/sch';
import { toBgr } from '../../../src/model/common';
import { uniqueId } from '../../../src/model/schEdit';
import { design, type Part } from './design';

const POWER = new Set(['GND', '+3V3', '+5V', '1V2', '+3V3A', 'VBUS']);
const charW = 6.2;
const tw = (s: string) => Math.ceil(s.length * charW);

type Side = 'L' | 'R' | 'T' | 'B';
const ORIENT: Record<Side, number> = { R: 0, T: 1, L: 2, B: 3 };
const DIR: Record<Side, [number, number]> = { R: [1, 0], T: [0, 1], L: [-1, 0], B: [0, -1] };

class Sheet {
  b = new SchBuilder();
  constructor(title: string, sub: string) {
    this.b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 3, SIZE1: 10, FONTNAME1: 'Arial', SIZE2: 18, FONTNAME2: 'Arial', BOLD2: true, SIZE3: 8, FONTNAME3: 'Arial',
      SHEETSTYLE: 1, BORDERON: true, TITLEBLOCKON: true, AREACOLOR: toBgr(0xffffff), SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 4 });
    this.b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: title, FONTID: 2, COLOR: COL.text }, { LOCATION: { x: 40, y: 1050 } });
    this.b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: sub, FONTID: 1, COLOR: toBgr(0x5a6470) }, { LOCATION: { x: 40, y: 1030 } });
  }
  /** A stub from a pin's end, then a net label, power port or no-ERC mark. */
  stub(net: string | undefined, x: number, y: number, side: Side, len: number): void {
    const [dx, dy] = DIR[side];
    if (!net) { this.b.add({ RECORD: SR.NO_ERC, OWNERPARTID: -1, COLOR: toBgr(0xff0000), SYMBOL: 1 }, { LOCATION: { x, y } }); return; }
    if (POWER.has(net)) {
      const ex = x + dx * 10, ey = y + dy * 10;
      this.b.wire([x, y], [ex, ey]);
      const gnd = net === 'GND';
      // Ground symbols point away from the pin; supply bars too
      this.b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: gnd ? 4 : 2, ORIENTATION: ORIENT[side], TEXT: net, SHOWNETNAME: !gnd, COLOR: COL.wire, FONTID: 1 }, { LOCATION: { x: ex, y: ey } });
      return;
    }
    const ex = x + dx * len, ey = y + dy * len;
    this.b.wire([x, y], [ex, ey]);
    if (side === 'R') this.b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: net, COLOR: COL.wire, FONTID: 1 }, { LOCATION: { x: x + 4, y } });
    else if (side === 'L') this.b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: net, COLOR: COL.wire, FONTID: 1 }, { LOCATION: { x: ex + 2, y } });
    else if (side === 'T') this.b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: net, ORIENTATION: 1, COLOR: COL.wire, FONTID: 1 }, { LOCATION: { x, y: y + 4 } });
    else this.b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: net, ORIENTATION: 1, COLOR: COL.wire, FONTID: 1 }, { LOCATION: { x, y: ey + 2 } });
  }
  component(p: Part, lib: string, at: { x: number; y: number }): { own: { OWNERINDEX: number; OWNERPARTID: number }; ci: number } {
    const ci = this.b.add({ RECORD: SR.COMPONENT, LIBREFERENCE: lib, PARTCOUNT: 2, DISPLAYMODECOUNT: 1, CURRENTPARTID: 1, OWNERPARTID: -1, AREACOLOR: COL.fill, COLOR: COL.body,
      DESIGNITEMID: lib, COMPONENTDESCRIPTION: p.description, UNIQUEID: uniqueId(), SOURCELIBRARYNAME: 'Showcase.SchLib' }, { LOCATION: at });
    return { own: { OWNERINDEX: ci, OWNERPARTID: 1 }, ci };
  }
  texts(ci: number, p: Part, ref: [number, number], comment: [number, number]): void {
    this.b.add({ RECORD: SR.DESIGNATOR, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Designator', TEXT: p.ref, FONTID: 1, COLOR: COL.text }, { LOCATION: { x: ref[0], y: ref[1] } });
    this.b.add({ RECORD: SR.PARAMETER, OWNERINDEX: ci, OWNERPARTID: -1, NAME: 'Comment', TEXT: p.comment, FONTID: 1, COLOR: COL.text }, { LOCATION: { x: comment[0], y: comment[1] } });
    // The footprint link (as Altium writes it)
    const list = this.b.add({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: ci, OWNERPARTID: -1 });
    const impl = this.b.add({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: list, OWNERPARTID: -1, USECOMPONENTLIBRARY: true, DESCRIPTION: p.description, MODELNAME: p.fp.name, MODELTYPE: 'PCBLIB',
      DATAFILECOUNT: 1, MODELDATAFILEENTITY0: p.fp.name, MODELDATAFILEKIND0: 'PCBLib', ISCURRENT: true, UNIQUEID: uniqueId() });
    this.b.add({ RECORD: 46, OWNERINDEX: impl, OWNERPARTID: -1 });
    this.b.add({ RECORD: 48, OWNERINDEX: impl, OWNERPARTID: -1 });
  }
  pin(own: object, x: number, y: number, side: Side, len: number, name: string, des: string, show: boolean, el = 4): void {
    this.b.add({ RECORD: SR.PIN, ...own, ELECTRICAL: el, PINCONGLOMERATE: ORIENT[side] | (show ? 0x18 : 0), PINLENGTH: len, NAME: name, DESIGNATOR: des, COLOR: COL.pin }, { LOCATION: { x, y } });
  }
  line(own: object, pts: [number, number][], w = 1): void {
    for (let i = 1; i < pts.length; i++) this.b.add({ RECORD: SR.LINE, ...own, LINEWIDTH: w, COLOR: COL.body }, { LOCATION: { x: pts[i - 1]![0], y: pts[i - 1]![1] }, CORNER: { x: pts[i]![0], y: pts[i]![1] } });
  }
  bytes(): Uint8Array {
    const root = newEntry('Root Entry', 'root');
    cfbPut(root, 'FileHeader', this.b.bytes());
    cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
    return writeCfb(root);
  }
}

/** An IC: a box with its pins left and right (names inside), stubs out to labels and ports. Returns its width and height. */
function ic(s: Sheet, p: Part, x: number, top: number, order?: (a: string, b: string) => number): { w: number; h: number } {
  const pads = [...new Set(p.fp.pads.map((q) => q.name))];
  const name = (d: string) => (p.pinNames?.[d] ?? d).replace(/\//g, '\\');
  const nat = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  pads.sort(order ?? nat);
  const half = Math.ceil(pads.length / 2);
  const left = pads.slice(0, half), right = pads.slice(half).reverse();
  const nameW = (list: string[]) => Math.max(0, ...list.map((d) => tw(name(d))));
  const w = Math.max(60, Math.ceil((nameW(left) + nameW(right) + 30) / 10) * 10);
  const h = (Math.max(left.length, right.length) + 1) * 10;
  const { own, ci } = s.component(p, p.comment, { x, y: top - h });
  s.b.add({ RECORD: SR.RECTANGLE, ...own, LINEWIDTH: 1, COLOR: COL.body, AREACOLOR: COL.fill, ISSOLID: true }, { LOCATION: { x, y: top - h }, CORNER: { x: x + w, y: top } });
  const lab = (list: string[]) => Math.max(30, ...list.map((d) => (p.nets[d] && !POWER.has(p.nets[d]!) ? tw(p.nets[d]!) + 10 : 0)));
  const lw = lab(left), rw = lab(right);
  left.forEach((d, i) => { const y = top - 10 - i * 10; s.pin(own, x, y, 'L', 20, name(d), d, true); s.stub(p.nets[d], x - 20, y, 'L', lw); });
  right.forEach((d, i) => { const y = top - 10 - i * 10; s.pin(own, x + w, y, 'R', 20, name(d), d, true); s.stub(p.nets[d], x + w + 20, y, 'R', rw); });
  s.texts(ci, p, [x, top + 4], [x, top - h - 12]);
  return { w: w + lw + rw + 40, h };
}

/** A two-pin part, vertical (pin 1 up): its symbol and the stubs. */
function passive(s: Sheet, p: Part, x: number, y: number): void {
  const pads = p.fp.pads.map((q) => q.name);
  const n1 = p.nets[pads[0]!], n2 = p.nets[pads[1]!];
  const lib = { R: 'Res', C: 'Cap', CP: 'Cap Pol', L: 'Inductor', LED: 'LED', D: 'Diode Schottky', F: 'Fuse' }[p.sym] ?? p.sym;
  const { own, ci } = s.component(p, lib, { x, y });
  s.pin(own, x, y + 10, 'T', 10, '1', pads[0]!, false, 4);
  s.pin(own, x, y - 10, 'B', 10, '2', pads[1]!, false, 4);
  switch (p.sym) {
    case 'R': s.b.add({ RECORD: SR.RECTANGLE, ...own, LINEWIDTH: 1, COLOR: COL.body, AREACOLOR: COL.fill, ISSOLID: false }, { LOCATION: { x: x - 4, y: y - 10 }, CORNER: { x: x + 4, y: y + 10 } }); break;
    case 'C': case 'CP':
      s.line(own, [[x, y + 10], [x, y + 2]]); s.line(own, [[x, y - 10], [x, y - 2]]);
      s.line(own, [[x - 8, y + 2], [x + 8, y + 2]], 2); s.line(own, [[x - 8, y - 2], [x + 8, y - 2]], 2);
      if (p.sym === 'CP') { s.line(own, [[x - 9, y + 6], [x - 5, y + 6]]); s.line(own, [[x - 7, y + 4], [x - 7, y + 8]]); }
      break;
    case 'L':
      for (let k = 0; k < 4; k++) s.b.add({ RECORD: SR.ARC, ...own, LINEWIDTH: 1, COLOR: COL.body, RADIUS: 2, RADIUS_FRAC: 50000, STARTANGLE: 270, ENDANGLE: 90 }, { LOCATION: { x, y: y + 7.5 - k * 5 } });
      break;
    case 'LED': case 'D':
      s.b.add({ RECORD: SR.POLYGON, ...own, LINEWIDTH: 1, COLOR: COL.body, AREACOLOR: COL.body, ISSOLID: true, LOCATIONCOUNT: 3, X1: x - 6, Y1: y + 5, X2: x + 6, Y2: y + 5, X3: x, Y3: y - 5 });
      s.line(own, [[x - 6, y - 5], [x + 6, y - 5]], 1);
      s.line(own, [[x, y + 10], [x, y + 5]]); s.line(own, [[x, y - 10], [x, y - 5]]);
      if (p.sym === 'LED') { s.line(own, [[x + 8, y + 1], [x + 13, y + 6]]); s.line(own, [[x + 8, y - 3], [x + 13, y + 2]]); }
      break;
    case 'F': s.b.add({ RECORD: SR.RECTANGLE, ...own, LINEWIDTH: 1, COLOR: COL.body, AREACOLOR: COL.fill, ISSOLID: false }, { LOCATION: { x: x - 3, y: y - 9 }, CORNER: { x: x + 3, y: y + 9 } }); s.line(own, [[x, y - 10], [x, y + 10]]); break;
  }
  s.texts(ci, p, [x + 8, y + 2], [x + 8, y - 8]);
  s.stub(n1, x, y + 20, 'T', Math.max(20, n1 ? tw(n1) + 8 : 0));
  s.stub(n2, x, y - 20, 'B', Math.max(20, n2 ? tw(n2) + 8 : 0));
}

/** Crystals, switches, test points and mounting holes: small symbols of their own. */
function small(s: Sheet, p: Part, x: number, y: number): void {
  const { own, ci } = s.component(p, { Y: 'XTAL', SW: 'SW-PB', TP: 'TestPoint', MH: 'MountingHole' }[p.sym] ?? p.sym, { x, y });
  const pads = [...new Set(p.fp.pads.map((q) => q.name))];
  if (p.sym === 'Y') {
    s.pin(own, x - 10, y, 'L', 10, '1', '1', false); s.pin(own, x + 10, y, 'R', 10, '3', '3', false);
    s.pin(own, x - 4, y - 10, 'B', 10, '2', '2', false); s.pin(own, x + 4, y - 10, 'B', 10, '4', '4', false);
    s.b.add({ RECORD: SR.RECTANGLE, ...own, LINEWIDTH: 1, COLOR: COL.body, AREACOLOR: COL.fill, ISSOLID: false }, { LOCATION: { x: x - 3, y: y - 6 }, CORNER: { x: x + 3, y: y + 6 } });
    s.line(own, [[x - 6, y - 7], [x - 6, y + 7]], 2); s.line(own, [[x + 6, y - 7], [x + 6, y + 7]], 2); s.line(own, [[x - 10, y], [x - 6, y]]); s.line(own, [[x + 10, y], [x + 6, y]]);
    s.stub(p.nets['1'], x - 20, y, 'L', tw(p.nets['1'] ?? '') + 10); s.stub(p.nets['3'], x + 20, y, 'R', tw(p.nets['3'] ?? '') + 10);
    s.stub('GND', x - 4, y - 20, 'B', 10); s.stub('GND', x + 4, y - 20, 'B', 10);
    s.texts(ci, p, [x - 10, y + 10], [x - 10, y + 20]);
  } else if (p.sym === 'SW') {
    s.pin(own, x - 10, y, 'L', 10, '1', '1', false); s.pin(own, x - 10, y, 'L', 10, '2', '2', false);
    s.pin(own, x + 10, y, 'R', 10, '3', '3', false); s.pin(own, x + 10, y, 'R', 10, '4', '4', false);
    s.line(own, [[x - 10, y], [x - 8, y]]); s.line(own, [[x + 10, y], [x + 8, y]]); s.line(own, [[x - 8, y + 4], [x + 8, y + 4]], 2); s.line(own, [[x, y + 4], [x, y + 10]]); s.line(own, [[x - 4, y + 10], [x + 4, y + 10]]);
    s.b.add({ RECORD: SR.ELLIPSE, ...own, LINEWIDTH: 1, COLOR: COL.body, AREACOLOR: COL.fill, ISSOLID: false, RADIUS: 1, SECONDARYRADIUS: 1 }, { LOCATION: { x: x - 8, y } });
    s.b.add({ RECORD: SR.ELLIPSE, ...own, LINEWIDTH: 1, COLOR: COL.body, AREACOLOR: COL.fill, ISSOLID: false, RADIUS: 1, SECONDARYRADIUS: 1 }, { LOCATION: { x: x + 8, y } });
    s.stub(p.nets['1'], x - 20, y, 'L', tw(p.nets['1'] ?? '') + 10); s.stub(p.nets['3'], x + 20, y, 'R', tw(p.nets['3'] ?? '') + 10);
    s.texts(ci, p, [x - 10, y + 14], [x - 10, y - 14]);
  } else {
    s.pin(own, x, y - 6, 'B', 10, '1', pads[0]!, false);
    s.b.add({ RECORD: SR.ELLIPSE, ...own, LINEWIDTH: 1, COLOR: COL.body, AREACOLOR: COL.fill, ISSOLID: p.sym === 'MH', RADIUS: 5, SECONDARYRADIUS: 5 }, { LOCATION: { x, y } });
    s.stub(p.nets[pads[0]!], x, y - 16, 'B', 20);
    s.texts(ci, p, [x + 8, y + 2], [x + 8, y - 8]);
  }
}

/** Lay a sheet out: the ICs across the top, then the rest in rows below. */
function layout(title: string, sub: string, sheet: Part['sheet'], icOrder: Record<string, (a: string, b: string) => number> = {}): Uint8Array {
  const s = new Sheet(title, sub);
  const parts = design.parts.filter((p) => p.sheet === sheet);
  const ics = parts.filter((p) => p.sym === 'IC').sort((a, b) => b.fp.pads.length - a.fp.pads.length);
  let x = 60, rowTop = 990, rowH = 0;
  for (const p of ics) {
    const pads = new Set(p.fp.pads.map((q) => q.name)).size;
    const est = Math.ceil(pads / 2) * 10 + 10;
    // An IC's width with its labels, as ic() works it out (roughly) for wrapping
    const guess = 200 + Math.max(0, ...Object.values(p.nets).map((n) => tw(n))) * 2;
    if (x + guess > 1500 && x > 60) { x = 60; rowTop -= rowH + 60; rowH = 0; }
    const r = ic(s, p, x + Math.max(30, ...[...new Set(p.fp.pads.map((q) => q.name))].slice(0, Math.ceil(pads / 2)).map((d) => (p.nets[d] && !POWER.has(p.nets[d]!) ? tw(p.nets[d]!) + 10 : 0))) + 20, rowTop, icOrder[p.ref]);
    x += r.w + 50; rowH = Math.max(rowH, r.h, est);
  }
  // Passives and the rest in rows of columns 60 apart
  const rest = parts.filter((p) => p.sym !== 'IC');
  let px = x > 900 ? 60 : x + 20, py = x > 900 ? rowTop - rowH - 110 : rowTop - 60;
  const colW = (p: Part) => (p.sym === 'Y' || p.sym === 'SW' ? 150 : 70) + Math.max(0, ...Object.values(p.nets).map((n) => (POWER.has(n) ? 0 : tw(n) - 60)));
  for (const p of rest) {
    const cw = Math.max(60, colW(p));
    if (px + cw > 1500) { px = x > 900 || py < rowTop - rowH - 100 ? 60 : x + 20; py -= 170; }
    if (py < 120) { py = 990; px = 1100; }
    if (p.sym === 'Y' || p.sym === 'SW' || p.sym === 'TP' || p.sym === 'MH') small(s, p, px + (p.sym === 'Y' || p.sym === 'SW' ? tw(p.nets['1'] ?? '') + 40 : 10), py);
    else passive(s, p, px + 10, py);
    px += cw;
  }
  return s.bytes();
}

export function schematics(): { name: string; bytes: Uint8Array }[] {
  const byPort = (a: string, b: string, p: Part) => {
    const n = (d: string) => p.pinNames?.[d] ?? d;
    const key = (d: string) => { const v = n(d); return /^V(DD|SS|REF)|^NRST|^BOOT|^PH/.test(v) ? `0${v}` : v; };
    return key(a).localeCompare(key(b), 'en', { numeric: true });
  };
  const u1 = design.parts.find((p) => p.ref === 'U1')!, u2 = design.parts.find((p) => p.ref === 'U2')!;
  const fpgaKey = (d: string) => { const n = u2.nets[d]; return !n ? `2${d}` : POWER.has(n) ? `3${n}${d}` : `1${n}`; };
  return [
    { name: 'Power.SchDoc', bytes: layout('POWER', 'USB-C input, protection, 3.3 V buck, 1.2 V and analog 3.3 V LDOs', 'Power') },
    { name: 'MCU.SchDoc', bytes: layout('MCU', 'Cortex-M4 controller: clock, reset, boot, debug, QSPI flash', 'MCU', { U1: (a, b) => byPort(a, b, u1) }) },
    { name: 'FPGA.SchDoc', bytes: layout('FPGA', 'FPGA with configuration flash, clock, LED bar and expansion headers', 'FPGA', { U2: (a, b) => fpgaKey(a).localeCompare(fpgaKey(b), 'en', { numeric: true }) }) },
    { name: 'IO.SchDoc', bytes: layout('INTERFACES', 'Analog inputs, IMU, RS-485 and the sub-GHz radio', 'IO') },
  ];
}
