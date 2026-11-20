/**
 * A board to try the Layout Planner on (Tools › Layout Planner, 26.191): Konium's own, drawn here.
 * A small USB sensor node of 50 × 30 mm on two layers, as a board stands after its parts have come
 * over from the schematic: 20 of its 21 parts stacked beside the outline, waiting to be placed (a
 * USB socket, a regulator with its capacitors, a 32-pin microcontroller with its decoupling,
 * crystal and reset resistor, an I²C sensor with its pull-ups, an LED, a debug header), one header
 * locked in place at the right edge, two mounting holes. Every pad has its net.
 */
import { formatAltiumLength, mm } from '../../core/units';
import type { Vec2 } from '../../core/geom';
import { L } from '../../model/layers';
import type { PcbDocument } from '../../model/pcb';
import { PropertyBag } from '../altium/props';
import { assemblePcbDoc } from '../altium/assemble';
import { newBoardRecord } from '../altium/board6';
import type { PcbRawRecord } from '../altium/framing';
import { encodePad, encodeText, encodeTrack, writePcbDoc, type PadFields } from '../altium/pcbdoc';
import { altiumFloat } from '../altium/pcbTransform';

export const LAYOUT_SAMPLE = { name: 'Layout Example.PcbDoc', width: 50, height: 30 };

/** A pad of a footprint: mm from the part's middle at rotation 0; `net` '' for a pin joined to nothing. */
interface Pin { n: string; x: number; y: number; w: number; h: number; net: string; hole?: number; round?: boolean }
interface Part { des: string; value: string; pattern: string; body: [number, number]; pins: Pin[]; at?: [number, number]; rot?: number; locked?: boolean }

const chip = (des: string, value: string, a: string, b: string, big = false): Part => {
  const d = big ? 0.8 : 0.5, w = big ? 0.8 : 0.5, h = big ? 0.9 : 0.6;
  return { des, value, pattern: big ? '0603' : '0402', body: big ? [1.6, 0.8] : [1.0, 0.5], pins: [{ n: '1', x: -d, y: 0, w, h, net: a }, { n: '2', x: d, y: 0, w, h, net: b }] };
};
const header = (des: string, value: string, nets: string[]): Part => ({
  des, value, pattern: `HDR-1x${nets.length}`, body: [2.54, 2.54 * nets.length],
  pins: nets.map((net, i) => ({ n: String(i + 1), x: 0, y: (nets.length - 1) * 1.27 - i * 2.54, w: 1.7, h: 1.7, hole: 1.0, round: i > 0, net })),
});
/** 32 pins, 0.8 mm apart, eight a side: 1 at the top of the left side, going round anticlockwise. */
const qfp32 = (des: string, value: string, nets: string[]): Part => ({
  des, value, pattern: 'TQFP-32', body: [7, 7],
  pins: nets.map((net, i) => {
    const side = Math.floor(i / 8), k = i % 8, along = 2.8 - k * 0.8, out = 4.4;
    const [x, y] = side === 0 ? [-out, along] : side === 1 ? [-along, -out] : side === 2 ? [out, -along] : [along, out];
    return { n: String(i + 1), x, y, w: side % 2 === 0 ? 1.5 : 0.5, h: side % 2 === 0 ? 0.5 : 1.5, net };
  }),
});

function parts(): Part[] {
  const V = '+3V3', G = 'GND';
  const mcu = [V, 'XTAL1', 'XTAL2', 'NRST', V, '', '', G, 'TX', 'RX', '', 'LED', '', '', '', G, V, '', '', '', 'USB_DM', 'USB_DP', 'SWDIO', 'SWCLK', '', '', '', 'SCL', 'SDA', '', G, V];
  return [
    { des: 'J1', value: 'USB Micro-B', pattern: 'USB-MICRO-B', body: [7.5, 5.5], pins: [
      ...['VBUS', 'USB_DM', 'USB_DP', '', G].map((net, i) => ({ n: String(i + 1), x: -1.3 + i * 0.65, y: 2.7, w: 0.38, h: 1.35, net })),
      { n: 'S1', x: -3.6, y: 0, w: 1.6, h: 1.6, hole: 0.9, round: true, net: G }, { n: 'S2', x: 3.6, y: 0, w: 1.6, h: 1.6, hole: 0.9, round: true, net: G }] },
    { des: 'U1', value: 'LDO 3V3', pattern: 'SOT-223', body: [6.5, 3.5], pins: [
      { n: '1', x: -2.3, y: -3.15, w: 1.0, h: 1.8, net: G }, { n: '2', x: 0, y: -3.15, w: 1.0, h: 1.8, net: V }, { n: '3', x: 2.3, y: -3.15, w: 1.0, h: 1.8, net: 'VBUS' }, { n: '4', x: 0, y: 3.15, w: 3.3, h: 1.8, net: V }] },
    chip('C1', '10uF', 'VBUS', G, true), chip('C2', '10uF', V, G, true),
    qfp32('U2', 'MCU 32-pin', mcu),
    chip('C3', '100nF', V, G), chip('C4', '100nF', V, G), chip('C5', '100nF', V, G), chip('C6', '1uF', V, G),
    { des: 'Y1', value: '8MHz', pattern: 'XTAL-3225', body: [3.2, 2.5], pins: [{ n: '1', x: -1.1, y: 0, w: 1.0, h: 1.9, net: 'XTAL1' }, { n: '2', x: 1.1, y: 0, w: 1.0, h: 1.9, net: 'XTAL2' }] },
    chip('C7', '12pF', 'XTAL1', G), chip('C8', '12pF', 'XTAL2', G), chip('R1', '10k', V, 'NRST'),
    { des: 'U3', value: 'I2C sensor', pattern: 'LGA-6', body: [2.5, 3], pins: [V, G, 'SCL', 'SDA', '', G].map((net, i) => ({ n: String(i + 1), x: i < 3 ? -0.9 : 0.9, y: i < 3 ? 1 - i : i - 4, w: 0.6, h: 0.5, net })) },
    chip('C9', '100nF', V, G), chip('R2', '4k7', V, 'SCL'), chip('R3', '4k7', V, 'SDA'),
    chip('D1', 'LED green', 'LED_A', G, true), chip('R4', '330R', 'LED', 'LED_A'),
    { ...header('J2', 'UART', [V, 'TX', 'RX', G]), at: [47, 15], locked: true },
    header('J3', 'SWD', [V, 'SWDIO', 'SWCLK', G]),
  ];
}

export function layoutSampleDoc(): PcbDocument {
  const O = 25, g = LAYOUT_SAMPLE;
  const P = (x: number, y: number): Vec2 => ({ x: mm(O + x), y: mm(O + y) });
  const list = parts();
  const nets = [...new Set(list.flatMap((p) => p.pins.map((q) => q.net)).filter(Boolean))];
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], texts: PcbRawRecord[] = [];
  const comps: PropertyBag[] = [];
  // The parts not yet placed stand in columns beside the outline, as an update from the schematic leaves them
  let colX = g.width + 6, colY = 0, colW = 0;
  list.forEach((p, ci) => {
    const [bw, bh] = p.body;
    const xs = p.pins.flatMap((q) => [q.x - q.w / 2, q.x + q.w / 2]), ys = p.pins.flatMap((q) => [q.y - q.h / 2, q.y + q.h / 2]);
    const w = Math.max(bw, Math.max(...xs) - Math.min(...xs)), h = Math.max(bh, Math.max(...ys) - Math.min(...ys));
    let at: [number, number];
    if (p.at) at = p.at;
    else {
      if (colY + h > g.height + 6) { colX += colW + 2; colY = 0; colW = 0; }
      at = [colX + w / 2, colY + h / 2];
      colY += h + 1.5; colW = Math.max(colW, w);
    }
    const c = P(at[0], at[1]);
    comps.push(PropertyBag.from({
      LAYER: 'TOP', PATTERN: p.pattern, SOURCEDESIGNATOR: p.des, SOURCEFOOTPRINTLIBRARY: 'Layout Example.PcbLib', FOOTPRINTDESCRIPTION: '',
      X: formatAltiumLength(c.x), Y: formatAltiumLength(c.y), ROTATION: altiumFloat(0), HEIGHT: '0mil', NAMEON: 'TRUE', COMMENTON: 'FALSE', LOCKED: p.locked ? 'TRUE' : 'FALSE',
      SOURCELIBREFERENCE: p.value, SOURCEDESCRIPTION: '',
    }));
    for (const q of p.pins) {
      const f: PadFields = { name: q.n, layer: q.hole ? L.MULTI : L.TOP, at: P(at[0] + q.x, at[1] + q.y), w: mm(q.w), h: mm(q.h), shape: q.round ? 'round' : 'rect', component: ci,
        ...(q.hole ? { hole: mm(q.hole) } : {}), ...(q.net ? { net: nets.indexOf(q.net) } : {}) };
      pads.push(encodePad(f));
    }
    // Its body's outline on the overlay
    const b = [[-bw / 2, -bh / 2], [bw / 2, -bh / 2], [bw / 2, bh / 2], [-bw / 2, bh / 2]] as const;
    b.forEach(([x, y], i) => { const [x2, y2] = b[(i + 1) % 4]!; tracks.push(encodeTrack({ layer: L.TOP_OVERLAY, a: P(at[0] + x, at[1] + y), b: P(at[0] + x2, at[1] + y2), width: mm(0.15), component: ci })); });
    const size = mm(Math.min(1, Math.max(0.6, bh * 0.4)));
    texts.push(encodeText({ layer: L.TOP_OVERLAY, at: P(at[0] - bw / 2, at[1] + h / 2 + 0.3), height: size, text: p.des, rotation: 0, component: ci, isDesignator: true }));
    texts.push(encodeText({ layer: L.TOP_OVERLAY, at: P(at[0] - bw / 2, at[1] - h / 2 - 1.2), height: size, text: p.value, rotation: 0, component: ci, isComment: true }));
  });
  // Two mounting holes: pads of no part, with no net
  for (const [x, y] of [[3, 3], [3, g.height - 3]] as const) pads.push(encodePad({ name: '0', layer: L.MULTI, at: P(x, y), w: mm(2.5), h: mm(2.5), shape: 'round', hole: mm(2.5), plated: false }));
  const outline = [P(0, 0), P(g.width, 0), P(g.width, g.height), P(0, g.height)].map((p) => ({ p }));
  const board = newBoardRecord({ fileName: g.name, origin: P(0, 0), outline, date: new Date(Date.UTC(2026, 0, 1)),
    sheet: { x: mm(O - 10), y: mm(O - 10), width: mm(g.width + 60), height: mm(g.height + 30) }, mechanical: [1] });
  return assemblePcbDoc({ board, nets, comps, pads, tracks, texts }, g.name);
}

export const layoutSampleBytes = (): Uint8Array => writePcbDoc(layoutSampleDoc());
