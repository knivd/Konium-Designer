/**
 * The showcase design: a USB-powered controller board with an MCU (QFP-100), an FPGA (BGA-100)
 * on a 23-line bus, QSPI flashes, a sub-GHz radio with its matching network and SMA, an IMU,
 * RS-485, analog inputs, a buck converter and LDOs, LEDs, switches and headers. Placement in
 * millimetres on a 115 × 78 mm board (origin bottom left, Y up), rotation anticlockwise.
 */
import * as P from './parts';
import type { Fp } from './parts';

export interface Part {
  ref: string; fp: Fp; x: number; y: number; rot: number; comment: string;
  /** Schematic symbol: 'R', 'C', 'L', 'LED', 'D', 'F', 'Y', 'SW', 'TP', 'MH', 'CP', or 'IC' (a box with pin names). */
  sym: string; nets: Record<string, string>;
  /** Pin names for IC symbols (pad → name). */
  pinNames?: Record<string, string>;
  sheet: 'Power' | 'MCU' | 'FPGA' | 'IO';
  description: string;
}

export const BOARD = { w: 115, h: 78, corner: 3 };
/** The MCU–FPGA bus (external memory controller style), in the order of the MCU's right-hand pins. */
export const BUS = [...['A0', 'A1', 'A2', 'A3'].map((a) => `FMC_${a}`), ...Array.from({ length: 16 }, (_, i) => `FMC_D${i}`), 'FMC_NE1', 'FMC_NOE', 'FMC_NWE'];
export const PLANES = { gnd: 'GND', pwr: '+3V3' };

const parts: Part[] = [];
const fpCache = new Map<string, Fp>();
const fp = (key: string, make: () => Fp): Fp => { if (!fpCache.has(key)) fpCache.set(key, make()); return fpCache.get(key)!; };
const R0402 = () => fp('R0402', () => P.chip('1005', 'R'));
const C0402 = () => fp('C0402', () => P.chip('1005', 'C'));
const C0603 = () => fp('C0603', () => P.chip('1608', 'C'));
const C0805 = () => fp('C0805', () => P.chip('2012', 'C'));
const L0402 = () => fp('L0402', () => P.chip('1005', 'L'));
const LED0603 = (c: number, k: string) => fp(`LED0603${k}`, () => ({ ...P.chip('1608', 'LED', c), name: 'LEDC1608X55N' }));

function add(p: Omit<Part, 'sheet' | 'description'> & { sheet?: Part['sheet']; description?: string }, sheet: Part['sheet']): Part {
  const q = { ...p, sheet: p.sheet ?? sheet, description: p.description ?? p.fp.description };
  parts.push(q);
  return q;
}
/** A two-pin part: pad 1 to n1, pad 2 to n2. */
function two(sheet: Part['sheet'], ref: string, f: Fp, x: number, y: number, rot: number, comment: string, n1: string, n2: string, sym?: string): Part {
  const names = f.pads.map((p) => p.name);
  return add({ ref, fp: f, x, y, rot, comment, sym: sym ?? ref.replace(/\d+$/, '').replace(/^FB$/, 'L'), nets: { [names[0]!]: n1, [names[1]!]: n2 } }, sheet);
}
const R = (s: Part['sheet'], ref: string, x: number, y: number, rot: number, v: string, a: string, b: string) => two(s, ref, R0402(), x, y, rot, v, a, b, 'R');
const C = (s: Part['sheet'], ref: string, x: number, y: number, rot: number, v: string, a: string, b: string, f = C0402()) => two(s, ref, f, x, y, rot, v, a, b, 'C');

/* ── Power: USB-C in, fuse, Schottky, buck to 3V3, LDOs to 1V2 and 3V3A ── */
{
  const S = 'Power';
  add({ ref: 'J1', fp: fp('usbc', P.usbC), x: 3.9, y: 63, rot: 90, comment: 'USB-C', sym: 'IC', nets: {
    GND1: 'GND', GND2: 'GND', SH: 'GND', VBUS1: 'VBUS', VBUS2: 'VBUS', CC1: 'CC1', CC2: 'CC2', DP1: 'USB_DP', DP2: 'USB_DP', DN1: 'USB_DN', DN2: 'USB_DN' },
    pinNames: { GND1: 'GND', VBUS1: 'VBUS', CC1: 'CC1', DP1: 'D+', DN1: 'D−', SBU1: 'SBU1', SBU2: 'SBU2', DN2: 'D−', DP2: 'D+', CC2: 'CC2', VBUS2: 'VBUS', GND2: 'GND', SH: 'SHIELD' } }, S);
  add({ ref: 'U11', fp: fp('sot6', () => P.sot23(6)), x: 12, y: 63, rot: 0, comment: 'USBLC6-2', sym: 'IC', nets: { 1: 'USB_DP', 2: 'GND', 3: 'USB_DN', 4: 'USB_DN', 5: 'VBUS', 6: 'USB_DP' },
    pinNames: { 1: 'I/O1', 2: 'GND', 3: 'I/O2', 4: 'I/O2', 5: 'VBUS', 6: 'I/O1' }, description: 'USB ESD protection, SOT-23-6' }, S);
  R(S, 'R1', 10.5, 57.2, 0, '5k1', 'CC1', 'GND');
  R(S, 'R2', 10.5, 68.8, 0, '5k1', 'CC2', 'GND');
  R(S, 'R3', 16, 64.5, 0, '22R', 'USB_DP', 'MCU_DP');
  R(S, 'R4', 16, 61.5, 0, '22R', 'USB_DN', 'MCU_DN');
  two(S, 'F1', fp('fuse', () => P.chip('3216', 'F')), 11.5, 74, 0, '1.5A PTC', 'VBUS', 'VBUS_F', 'F');
  add({ ref: 'D11', fp: fp('sod', P.sod123), x: 18, y: 74, rot: 180, comment: 'SS14', sym: 'D', nets: { 1: '+5V', 2: 'VBUS_F' }, description: 'Schottky diode, SOD-123' }, S);
  two(S, 'C1', fp('elcap', P.elcap63), 27, 73.6, 0, '47µF 16V', '+5V', 'GND', 'CP');
  C(S, 'C2', 21.5, 68.5, 90, '10µF', '+5V', 'GND', C0805());
  add({ ref: 'U5', fp: fp('sot6', () => P.sot23(6)), x: 25, y: 64.5, rot: 0, comment: 'TPS563200', sym: 'IC', nets: { 1: 'GND', 2: 'SW', 3: '+5V', 4: 'FB', 5: 'EN', 6: 'BST' },
    pinNames: { 1: 'GND', 2: 'SW', 3: 'VIN', 4: 'VFB', 5: 'EN', 6: 'VBST' }, description: 'Synchronous buck converter, 3 A, SOT-23-6' }, S);
  C(S, 'C3', 25, 61.3, 0, '100nF', 'BST', 'SW');
  two(S, 'L1', fp('ind4040', P.inductor4040), 31.5, 64.5, 0, '3.3µH', 'SW', '+3V3', 'L');
  R(S, 'R5', 21, 60.6, 0, '33k', 'FB', '+3V3');
  R(S, 'R6', 21, 58.6, 0, '10k', 'FB', 'GND');
  R(S, 'R7', 21, 66.2, 0, '100k', 'EN', '+5V');
  C(S, 'C4', 36.2, 66, 90, '22µF', '+3V3', 'GND', C0805());
  C(S, 'C5', 38.6, 66, 90, '22µF', '+3V3', 'GND', C0805());
  two(S, 'C6', fp('elcap', P.elcap63), 37, 73.6, 0, '100µF 6V3', '+3V3', 'GND', 'CP');
  R(S, 'R8', 46, 72, 0, '1k', '+3V3', 'LED_PWR');
  two(S, 'D1', LED0603(P.COL.ledGreen, 'g'), 46, 74.5, 0, 'Green', 'LED_PWR', 'GND', 'LED');
  // 1V2 for the FPGA core, 3V3A for the analog side
  add({ ref: 'U6', fp: fp('sot5', () => P.sot23(5)), x: 67, y: 25, rot: 0, comment: 'TLV75512', sym: 'IC', nets: { 1: '+3V3', 2: 'GND', 3: '+3V3', 5: '1V2' },
    pinNames: { 1: 'IN', 2: 'GND', 3: 'EN', 4: 'NC', 5: 'OUT' }, description: 'LDO regulator, 1.2 V 500 mA, SOT-23-5' }, S);
  C(S, 'C7', 63.6, 25, 90, '1µF', '+3V3', 'GND', C0603());
  C(S, 'C8', 70.4, 25, 90, '4.7µF', '1V2', 'GND', C0603());
  add({ ref: 'U7', fp: fp('sot5', () => P.sot23(5)), x: 24, y: 24, rot: 0, comment: 'TLV75533', sym: 'IC', nets: { 1: '+5V', 2: 'GND', 3: '+5V', 5: '+3V3A' },
    pinNames: { 1: 'IN', 2: 'GND', 3: 'EN', 4: 'NC', 5: 'OUT' }, description: 'LDO regulator, 3.3 V 500 mA, SOT-23-5' }, S);
  C(S, 'C9', 20.6, 24, 90, '1µF', '+5V', 'GND', C0603());
  C(S, 'C10', 27.4, 24, 90, '4.7µF', '+3V3A', 'GND', C0603());
}

/* ── MCU: QFP-100 with decoupling, crystal, reset, boot, SWD, UART, QSPI ── */
const MCU = { x: 40, y: 40 };
{
  const S = 'MCU';
  const nets: Record<string, string> = {};
  const names: Record<string, string> = {};
  const pin = (n: number, net: string | null, name: string) => { if (net) nets[n] = net; names[n] = name; };
  for (let n = 1; n <= 100; n++) names[n] = n <= 25 ? `PE${n - 1}` : n <= 50 ? `PA${n - 26}` : n <= 75 ? `PD${n - 51}` : `PB${n - 76}`;
  for (const n of [10, 27, 49, 74, 99]) pin(n, 'GND', 'VSS');
  for (const n of [11, 28, 50, 75, 100]) pin(n, '+3V3', 'VDD');
  pin(19, 'GND', 'VSSA'); pin(20, '+3V3A', 'VREF+'); pin(21, '+3V3A', 'VDDA');
  pin(12, 'XIN', 'PH0-OSC_IN'); pin(13, 'XOUT', 'PH1-OSC_OUT'); pin(14, 'NRST', 'NRST'); pin(94, 'BOOT0', 'BOOT0');
  pin(4, 'SW_USER', 'PE3'); pin(5, 'UART_TX', 'PE4-USART_TX'); pin(6, 'UART_RX', 'PE5-USART_RX');
  pin(7, 'SWDIO', 'PA13-SWDIO'); pin(8, 'SWCLK', 'PA14-SWCLK'); pin(9, 'SWO', 'PB3-SWO');
  ['ADC1', 'ADC2', 'ADC3', 'ADC4'].forEach((a, i) => pin(15 + i, a, `PC${i}-${a}`));
  pin(22, 'I2C_SCL', 'PB6-I2C_SCL'); pin(23, 'I2C_SDA', 'PB7-I2C_SDA'); pin(24, 'SENS_INT', 'PB8-EXTI');
  ['QSPI_CLK', 'QSPI_CS', 'QSPI_IO0', 'QSPI_IO1', 'QSPI_IO2', 'QSPI_IO3'].forEach((q, i) => pin(29 + i, q, `PA${i + 3}-${q}`));
  ['R485_TX', 'R485_RX', 'R485_DE', 'R485_NRE'].forEach((q, i) => pin(35 + i, q, `PA${i + 9}-${q.replace('R485_', 'U2_')}`));
  // The bus to the FPGA, along the right side: bottom to top
  BUS.forEach((b, i) => pin(51 + i, b, `PD${i}-${b}`));
  ['RF_SCK', 'RF_MISO', 'RF_MOSI', 'RF_CS', 'RF_IRQ', 'RF_RST'].forEach((q, i) => pin(76 + i, q, `PB${i}-${q}`));
  pin(82, 'LED_STAT', 'PB6-LED');
  ['FPGA_DONE', 'FPGA_PROGB', 'FPGA_SCK', 'FPGA_MOSI', 'FPGA_MISO', 'FPGA_CS'].forEach((q, i) => pin(42 + i, q, `PC${i + 6}-${q}`));
  pin(95, 'MCU_DN', 'PA11-USB_DM'); pin(96, 'MCU_DP', 'PA12-USB_DP'); pin(97, 'VBUS_SENSE', 'PA9-VBUS');
  add({ ref: 'U1', fp: fp('qfp100', P.qfp100), x: MCU.x, y: MCU.y, rot: 0, comment: 'STM32F407VGT6', sym: 'IC', nets, pinNames: names, description: 'MCU, Arm Cortex-M4, 1 MB flash, LQFP-100' }, S);
  // Decoupling at each supply pair, just outside the pins
  C(S, 'C11', MCU.x - 10.4, MCU.y + 1.25, 90, '100nF', '+3V3', 'GND');
  C(S, 'C12', MCU.x - 4.75, MCU.y - 10.4, 0, '100nF', '+3V3', 'GND');
  C(S, 'C13', MCU.x + 5.75, MCU.y - 10.4, 0, '100nF', '+3V3', 'GND');
  C(S, 'C14', MCU.x + 10.6, MCU.y + 9.2, 0, '100nF', '+3V3', 'GND');
  C(S, 'C15', MCU.x - 5.75, MCU.y + 10.4, 0, '100nF', '+3V3', 'GND');
  C(S, 'C16', MCU.x - 10.4, MCU.y - 3.25, 90, '1µF', '+3V3A', 'GND');
  C(S, 'C17', MCU.x - 12.2, MCU.y - 3.25, 90, '100nF', '+3V3A', 'GND');
  C(S, 'C18', MCU.x + 1, MCU.y + 12.4, 0, '4.7µF', '+3V3', 'GND', C0603());
  add({ ref: 'Y1', fp: fp('xtal', () => P.xtal3225()), x: MCU.x - 14.5, y: MCU.y + 0.25, rot: 90, comment: '8 MHz', sym: 'Y', nets: { 1: 'XIN', 3: 'XOUT', 2: 'GND', 4: 'GND' }, description: 'Crystal, 8 MHz, 3.2 × 2.5 mm' }, S);
  C(S, 'C19', MCU.x - 14.5, MCU.y + 3.6, 0, '12pF', 'XIN', 'GND');
  C(S, 'C20', MCU.x - 14.5, MCU.y - 3.1, 0, '12pF', 'XOUT', 'GND');
  // Reset, boot and user switches with their pull resistors
  add({ ref: 'SW1', fp: fp('tact', P.tact), x: 37, y: 6, rot: 0, comment: 'RESET', sym: 'SW', nets: { 1: 'NRST', 2: 'NRST', 3: 'GND', 4: 'GND' }, description: 'Tactile switch, 6 × 6 mm' }, S);
  add({ ref: 'SW2', fp: fp('tact', P.tact), x: 48.5, y: 6, rot: 0, comment: 'USER', sym: 'SW', nets: { 1: 'SW_USER', 2: 'SW_USER', 3: 'GND', 4: 'GND' }, description: 'Tactile switch, 6 × 6 mm' }, S);
  add({ ref: 'SW3', fp: fp('tact', P.tact), x: 60, y: 6, rot: 0, comment: 'BOOT', sym: 'SW', nets: { 1: '+3V3', 2: '+3V3', 3: 'BOOT0', 4: 'BOOT0' }, description: 'Tactile switch, 6 × 6 mm' }, S);
  C(S, 'C21', 33.5, 12, 90, '100nF', 'NRST', 'GND');
  R(S, 'R9', 35.5, 12, 90, '10k', 'NRST', '+3V3');
  R(S, 'R10', 60, 11.5, 0, '10k', 'BOOT0', 'GND');
  R(S, 'R11', 48.5, 11.5, 0, '10k', 'SW_USER', '+3V3');
  // SWD (Cortex Debug, 2 × 5, 1.27 mm) and UART
  add({ ref: 'J6', fp: fp('swd', () => P.header(5, 2, true)), x: 17, y: 46, rot: 90, comment: 'SWD', sym: 'IC', nets: { 1: '+3V3', 2: 'SWDIO', 3: 'GND', 4: 'SWCLK', 5: 'GND', 6: 'SWO', 9: 'GND', 10: 'NRST' },
    pinNames: { 1: 'VTREF', 2: 'SWDIO', 3: 'GND', 4: 'SWCLK', 5: 'GND', 6: 'SWO', 7: 'KEY', 8: 'NC', 9: 'GND', 10: 'NRST' }, description: 'Cortex Debug connector, 2 × 5, 1.27 mm' }, S);
  add({ ref: 'J7', fp: fp('h4', () => P.header(4, 1)), x: 4, y: 40, rot: 90, comment: 'UART', sym: 'IC', nets: { 1: '+3V3', 2: 'UART_TX', 3: 'UART_RX', 4: 'GND' },
    pinNames: { 1: '3V3', 2: 'TX', 3: 'RX', 4: 'GND' } }, S);
  // QSPI flash under the MCU
  add({ ref: 'U3', fp: fp('soic8', P.soic8), x: 40, y: 21.5, rot: 0, comment: 'W25Q128JV', sym: 'IC', nets: { 1: 'QSPI_CS', 2: 'QSPI_IO1', 3: 'QSPI_IO2', 4: 'GND', 5: 'QSPI_IO0', 6: 'QSPI_CLK', 7: 'QSPI_IO3', 8: '+3V3' },
    pinNames: { 1: '/CS', 2: 'DO(IO1)', 3: '/WP(IO2)', 4: 'GND', 5: 'DI(IO0)', 6: 'CLK', 7: '/HOLD(IO3)', 8: 'VCC' }, description: 'Serial flash, 128 Mbit, QSPI, SOIC-8' }, S);
  C(S, 'C28', 45.4, 21.5, 90, '100nF', '+3V3', 'GND');
  R(S, 'R18', 34.6, 21.5, 90, '10k', 'QSPI_CS', '+3V3');
  // USB VBUS sense divider, status LED
  R(S, 'R21', 26, 54.5, 0, '10k', 'VBUS', 'VBUS_SENSE');
  R(S, 'R22', 26, 52.5, 0, '20k', 'VBUS_SENSE', 'GND');
  R(S, 'R20', 54, 54, 0, '1k', 'LED_STAT', 'LED_STAT_A');
  two(S, 'D10', LED0603(P.COL.ledBlue, 'b'), 54, 56.5, 0, 'Blue', 'LED_STAT_A', 'GND', 'LED');
}


/* ── IO: analog inputs, IMU, RS-485, radio ── */
{
  const S = 'IO';
  add({ ref: 'J8', fp: fp('h6', () => P.header(6, 1)), x: 4, y: 19, rot: 90, comment: 'ANALOG', sym: 'IC', nets: { 1: '+3V3A', 2: 'AIN1', 3: 'AIN2', 4: 'AIN3', 5: 'AIN4', 6: 'GND' },
    pinNames: { 1: '3V3A', 2: 'AIN1', 3: 'AIN2', 4: 'AIN3', 5: 'AIN4', 6: 'AGND' } }, S);
  for (let i = 0; i < 4; i++) {
    const y = 22.2 - i * 2.2;
    R(S, `R${12 + i}`, 10, y, 0, '1k', `AIN${i + 1}`, `ADC${i + 1}`);
    C(S, `C${22 + i}`, 13.4, y, 0, '10nF', `ADC${i + 1}`, 'GND');
  }
  add({ ref: 'U9', fp: fp('qfn16', P.qfn16), x: 21, y: 11, rot: 0, comment: 'LSM6DSO', sym: 'IC', nets: { 1: 'GND', 4: 'I2C_SCL', 5: 'GND', 6: 'I2C_SDA', 7: 'GND', 8: '+3V3', 9: 'SENS_INT', 12: 'GND', 13: 'GND', 14: '+3V3', 17: 'GND', 2: 'GND', 3: 'GND' },
    pinNames: { 1: 'SDO', 2: 'SDX', 3: 'SCX', 4: 'SCL', 5: 'GND', 6: 'SDA', 7: 'SA0', 8: 'CS', 9: 'INT1', 10: 'INT2', 11: 'NC', 12: 'GND', 13: 'GND', 14: 'VDD', 15: 'VDDIO', 16: 'NC', 17: 'EP' }, description: '6-axis IMU, I²C, LGA/QFN-16' }, S);
  C(S, 'C26', 21, 15.4, 0, '100nF', '+3V3', 'GND');
  C(S, 'C27', 25.2, 11, 90, '100nF', '+3V3', 'GND');
  R(S, 'R16', 16.6, 9.6, 90, '4k7', 'I2C_SCL', '+3V3');
  R(S, 'R17', 15, 9.6, 90, '4k7', 'I2C_SDA', '+3V3');
  // RS-485
  add({ ref: 'U10', fp: fp('soic8', P.soic8), x: 98, y: 27, rot: 0, comment: 'MAX3485', sym: 'IC', nets: { 1: 'R485_RX', 2: 'R485_NRE', 3: 'R485_DE', 4: 'R485_TX', 5: 'GND', 6: 'RS485_A', 7: 'RS485_B', 8: '+3V3' },
    pinNames: { 1: 'RO', 2: '/RE', 3: 'DE', 4: 'DI', 5: 'GND', 6: 'A', 7: 'B', 8: 'VCC' }, description: 'RS-485 transceiver, 3.3 V, SOIC-8' }, S);
  C(S, 'C29', 98, 31.6, 0, '100nF', '+3V3', 'GND');
  R(S, 'R19', 103.5, 31, 90, '120R', 'RS485_A', 'RS485_B');
  add({ ref: 'U13', fp: fp('sot3', () => P.sot23(3)), x: 103.5, y: 20, rot: 90, comment: 'SM712', sym: 'IC', nets: { 1: 'RS485_A', 2: 'RS485_B', 3: 'GND' },
    pinNames: { 1: 'A', 2: 'B', 3: 'GND' }, description: 'TVS array for RS-485, SOT-23' }, S);
  add({ ref: 'J3', fp: fp('term3', P.terminal3), x: 110, y: 16.5, rot: 90, comment: 'RS-485', sym: 'IC', nets: { 1: 'RS485_A', 2: 'RS485_B', 3: 'GND' }, pinNames: { 1: 'A', 2: 'B', 3: 'GND' } }, S);
  // Sub-GHz radio with its crystal and the matching network to the SMA
  const rf: Record<string, string> = { 1: '+3V3', 2: 'RF_SCK', 3: 'RF_MISO', 4: 'RF_MOSI', 5: 'RF_CS', 6: 'RF_IRQ', 7: 'RF_RST', 8: 'GND', 9: '+3V3', 10: 'RXTAL1', 11: 'RXTAL2', 12: 'GND',
    17: 'GND', 18: 'GND', 19: 'RF_OUT', 20: 'GND', 21: '+3V3', 25: '+3V3', 26: 'RF_DEC1', 27: 'RF_DEC2', 32: 'GND', 33: 'GND' };
  const rfn: Record<string, string> = { 1: 'VDD', 2: 'SCK', 3: 'MISO', 4: 'MOSI', 5: 'NSS', 6: 'DIO0', 7: 'NRESET', 8: 'GND', 9: 'VDD', 10: 'XTA', 11: 'XTB', 12: 'GND', 13: 'NC', 14: 'NC', 15: 'NC', 16: 'NC',
    17: 'GND', 18: 'GND', 19: 'RFO', 20: 'GND', 21: 'VDD_PA', 22: 'NC', 23: 'NC', 24: 'NC', 25: 'VDD', 26: 'DEC1', 27: 'DEC2', 28: 'NC', 29: 'NC', 30: 'NC', 31: 'NC', 32: 'GND', 33: 'EP' };
  add({ ref: 'U8', fp: fp('qfn32', P.qfn32), x: 100, y: 60, rot: 0, comment: 'SX1276', sym: 'IC', nets: rf, pinNames: rfn, description: 'Sub-GHz LoRa transceiver, QFN-32' }, S);
  two(S, 'L2', L0402(), 105, 59.25, 0, '8.2nH', 'RF_OUT', 'RF_M1', 'L');
  C(S, 'C30', 108, 59.25, 0, '47pF', 'RF_M1', 'RF_ANT');
  C(S, 'C31', 106.5, 61.6, 90, '6.8pF', 'RF_M1', 'GND');
  C(S, 'C32', 109.5, 61.6, 90, '2.2pF', 'RF_ANT', 'GND');
  add({ ref: 'J2', fp: fp('sma', P.sma), x: 113.6, y: 59.25, rot: 0, comment: 'SMA', sym: 'IC', nets: { 1: 'RF_ANT', 2: 'GND', 3: 'GND' }, pinNames: { 1: 'RF', 2: 'GND', 3: 'GND' } }, S);
  add({ ref: 'Y3', fp: fp('xtal', () => P.xtal3225()), x: 98.5, y: 52.5, rot: 0, comment: '32 MHz', sym: 'Y', nets: { 1: 'RXTAL1', 3: 'RXTAL2', 2: 'GND', 4: 'GND' }, description: 'Crystal, 32 MHz, 3.2 × 2.5 mm' }, S);
  C(S, 'C35', 94.6, 52.5, 90, '10pF', 'RXTAL1', 'GND');
  C(S, 'C36', 102.4, 52.5, 90, '10pF', 'RXTAL2', 'GND');
  C(S, 'C33', 98, 65.2, 0, '100nF', 'RF_DEC1', 'GND');
  C(S, 'C34', 100.6, 65.2, 0, '100nF', 'RF_DEC2', 'GND');
  C(S, 'C37', 95.6, 56.6, 0, '100nF', '+3V3', 'GND');
  C(S, 'C38', 104.6, 64.6, 90, '100nF', '+3V3', 'GND');
}

/* ── FPGA: BGA-100 with its flash, oscillator, decoupling, LEDs and IO headers ── */
const FPGA = { x: 82, y: 40 };
{
  const S = 'FPGA';
  const f = P.bga100();
  const balls = f.pads.map((p) => ({ name: p.name, x: p.x, y: p.y, ring: Math.round(4.5 - Math.max(Math.abs(p.x), Math.abs(p.y))) }));
  const nets: Record<string, string> = {};
  const names: Record<string, string> = {};
  // Power on the inner rings: VCCIO and GND alternate on the third ring, VCCINT and GND on the fourth, GND in the middle
  for (const b of balls) {
    const k = (Math.round(b.x + 4.5) + Math.round(b.y + 4.5)) % 2;
    if (b.ring === 2) { nets[b.name] = k ? '+3V3' : 'GND'; names[b.name] = k ? 'VCCIO' : 'GND'; }
    if (b.ring === 3) { nets[b.name] = k ? '1V2' : 'GND'; names[b.name] = k ? 'VCCINT' : 'GND'; }
    if (b.ring === 4) { nets[b.name] = 'GND'; names[b.name] = 'GND'; }
  }
  let free = balls.filter((b) => b.ring <= 1);
  const take = (count: number, score: (b: typeof balls[number]) => number) => {
    const got = [...free].sort((a, b) => score(a) - score(b)).slice(0, count);
    free = free.filter((b) => !got.includes(b));
    return got;
  };
  const assign = (group: string[], got: typeof balls, order: (b: typeof balls[number]) => number, prefix = 'IO') => {
    got.sort((a, b) => order(a) - order(b)).forEach((b, i) => { nets[b.name] = group[i]!; names[b.name] = `${prefix}_${b.name}`; });
  };
  // The bus faces the MCU (left), in its pins' order (bottom to top)
  assign(BUS, take(BUS.length, (b) => b.x * 10 + Math.abs(b.y) * 0.1), (b) => b.y * 10 - b.x * 0.1);
  // Control from the MCU's top pins: top left
  assign(['FPGA_DONE', 'FPGA_PROGB', 'FPGA_SCK', 'FPGA_MOSI', 'FPGA_MISO', 'FPGA_CS'], take(6, (b) => Math.hypot(b.x + 5, b.y + 6)), (b) => b.x, 'CFG');
  // LEDs: the top row, left to right
  const leds = Array.from({ length: 8 }, (_, i) => `LED${i}`);
  assign(leds, take(8, (b) => -b.y * 10 + Math.abs(b.x - 1) * 0.1), (b) => b.x);
  assign(['FPGA_CLK'], take(1, (b) => -b.x * 10 + Math.abs(b.y)), () => 0, 'GCLK');
  assign(['F_CS', 'F_CLK', 'F_DI', 'F_DO'], take(4, (b) => b.y * 10 + Math.abs(b.x) * 0.1), (b) => b.x, 'CFG');
  const top = Array.from({ length: 12 }, (_, i) => `PMOD_A${i}`);
  assign(top, take(12, (b) => -b.y * 10 + -b.x * 0.2), (b) => b.x);
  const bot = Array.from({ length: 10 }, (_, i) => `PMOD_B${i}`);
  assign(bot, take(10, (b) => b.y * 10 - b.x * 0.2), (b) => b.x);
  for (const b of balls) if (!names[b.name]) names[b.name] = `IO_${b.name}`;
  add({ ref: 'U2', fp: fp('bga100', () => f), x: FPGA.x, y: FPGA.y, rot: 0, comment: 'ICE40UP5K', sym: 'IC', nets, pinNames: names, description: 'FPGA, 5k LUT, BGA-100 1.0 mm' }, S);
  // Decoupling round the BGA
  [[-6.2, 7.6], [-2.6, 7.6], [2.6, 7.6], [6.2, 7.6]].forEach(([dx, dy], i) => C(S, `C${41 + i}`, FPGA.x + dx!, FPGA.y + dy!, 0, '100nF', i % 2 ? '1V2' : '+3V3', 'GND'));
  [[-4.4, -7.6], [-1.2, -7.6], [1.2, -7.6], [4.4, -7.6]].forEach(([dx, dy], i) => C(S, `C${45 + i}`, FPGA.x + dx!, FPGA.y + dy!, 0, '100nF', i % 2 ? '+3V3' : '1V2', 'GND'));
  C(S, 'C49', 72, 30.5, 90, '10µF', '1V2', 'GND', C0805());
  C(S, 'C50', 91, 31.5, 90, '10µF', '+3V3', 'GND', C0805());
  add({ ref: 'Y2', fp: fp('osc', () => P.xtal3225(true)), x: 93.5, y: 41, rot: 0, comment: '48 MHz', sym: 'IC', nets: { 1: '+3V3', 2: 'GND', 3: 'FPGA_CLK', 4: '+3V3' },
    pinNames: { 1: 'EN', 2: 'GND', 3: 'OUT', 4: 'VDD' }, description: 'Oscillator, 48 MHz, 3.2 × 2.5 mm' }, S);
  C(S, 'C40', 93.5, 45, 0, '100nF', '+3V3', 'GND');
  add({ ref: 'U4', fp: fp('soic8', P.soic8), x: 82, y: 22, rot: 0, comment: 'AT25SF081', sym: 'IC', nets: { 1: 'F_CS', 2: 'F_DO', 3: '+3V3', 4: 'GND', 5: 'F_DI', 6: 'F_CLK', 7: '+3V3', 8: '+3V3' },
    pinNames: { 1: '/CS', 2: 'SO', 3: '/WP', 4: 'GND', 5: 'SI', 6: 'SCK', 7: '/HOLD', 8: 'VCC' }, description: 'Serial flash, 8 Mbit, SPI, SOIC-8' }, S);
  C(S, 'C39', 87.4, 22, 90, '100nF', '+3V3', 'GND');
  // LED bar
  const colours = [P.COL.ledRed, P.COL.ledRed, P.COL.ledAmber, P.COL.ledAmber, P.COL.ledGreen, P.COL.ledGreen, P.COL.ledBlue, P.COL.ledBlue];
  const keys = ['r', 'r', 'a', 'a', 'g', 'g', 'b', 'b'];
  for (let i = 0; i < 8; i++) {
    const x = 70.6 + i * 2.4;
    R(S, `R${23 + i}`, x, 58.6, 90, '330R', `LED${i}`, `LED${i}_A`);
    two(S, `D${2 + i}`, LED0603(colours[i]!, keys[i]!), x, 62.2, 90, ['Red', 'Red', 'Amber', 'Amber', 'Green', 'Green', 'Blue', 'Blue'][i]!, `LED${i}_A`, 'GND', 'LED');
  }
  // IO headers top and bottom: odd pins on one row, even on the other
  const hdr = (ref: string, x: number, y: number, ios: string[], extra: Record<string, string>) => {
    const nets: Record<string, string> = { 1: '+3V3', 2: 'GND', 19: 'GND', 20: '+5V', ...extra };
    const names: Record<string, string> = { 1: '3V3', 2: 'GND', 19: 'GND', 20: '5V' };
    ios.forEach((n, i) => { nets[i + 3] = n; names[i + 3] = n.replace('PMOD_', ''); });
    for (let n = 1; n <= 20; n++) names[n] ??= nets[n] ?? 'NC';
    add({ ref, fp: fp('h2x10', () => P.header(10, 2)), x, y, rot: 0, comment: ref === 'J4' ? 'EXP A' : 'EXP B', sym: 'IC', nets, pinNames: names }, S);
  };
  hdr('J4', 82, 73, top, {});
  hdr('J5', 84, 5, bot, { 13: 'I2C_SCL', 14: 'I2C_SDA' });
}

/* ── Board furniture ── */
{
  const S = 'Power';
  [[4, 4], [111, 4], [4, 74], [111, 74]].forEach(([x, y], i) => add({ ref: `MH${i + 1}`, fp: fp('mh', P.mountHole), x: x!, y: y!, rot: 0, comment: 'M3', sym: 'MH', nets: { 1: 'GND' } }, S));
  ([['TP1', 32.8, 68.8, '+5V'], ['TP2', 44, 66.5, '+3V3'], ['TP3', 67, 31, '1V2'], ['TP4', 64, 67.4, 'GND'], ['TP5', 29, 21, '+3V3A'], ['TP6', 96, 10, 'GND']] as const)
    .forEach(([ref, x, y, net]) => add({ ref, fp: fp('tp', P.testPoint), x, y, rot: 0, comment: net, sym: 'TP', nets: { 1: net } }, S));
}

export const design = { parts, MCU, FPGA };
