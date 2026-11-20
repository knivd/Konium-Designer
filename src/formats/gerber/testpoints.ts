/**
 * File › Fabrication Outputs › Test Point Report: the pads and vias marked as fabrication test
 * points (the Pads6 / Vias6 flags KiCad's importer reads: byte 1 bit 0x80 top, byte 2 bit 0x01
 * bottom), as a text report and CSV, and the board's netlist as IPC-D-356A (every pad and via on a
 * net, the test points' access side marked) for bare-board testing.
 * - IPC-D-356A: 317 through-hole and 327 surface records in the standard's fixed columns,
 *   units CUST 0 (0.0001 inch) or CUST 1 (0.001 mm), long net names through NNAME aliases, 999.
 * - The text and CSV layouts are Konium's [est: AD's column set].
 */
import type { Vec2 } from '../../core/geom';
import { L } from '../../model/layers';
import { NO_NET, type PcbDocument } from '../../model/pcb';
import type { OutputFile } from './gerber';

export interface TestPointSetup {
  ipc: boolean; text: boolean; csv: boolean;
  units: 'in' | 'mm';
  relative: boolean;
}
export const defaultTestPointSetup = (): TestPointSetup => ({ ipc: true, text: true, csv: false, units: 'in', relative: true });

export interface TestFeature {
  kind: 'pad' | 'via';
  designator: string; pin: string; net: string;
  at: Vec2; hole: number; plated: boolean;
  /** Pad size on its outer layer, rotation. */
  w: number; h: number; rotation: number;
  /** A pad on one side only (SMD): 1 top, 2 bottom; 0 through-hole. */
  side: 0 | 1 | 2;
  /** Marked as a fabrication test point on the top / bottom. */
  testTop: boolean; testBottom: boolean;
}

/** Every pad and via on the board with its test point flags. */
export function testFeatures(doc: PcbDocument): TestFeature[] {
  const out: TestFeature[] = [];
  const flags = (storage: string, index: number, sub: number) => {
    const s = doc.streams.get(storage)?.records[index]?.subs[sub];
    return { top: !!s && s.length > 2 && (s[1]! & 0x80) !== 0, bottom: !!s && s.length > 2 && (s[2]! & 0x01) !== 0 };
  };
  const bottom = doc.board.copperStack.at(-1);
  for (const p of doc.prims) {
    if (p.kind === 'pad') {
      const f = flags(p.src.storage, p.src.index, 4);
      out.push({ kind: 'pad', designator: doc.components[p.component]?.designator ?? '', pin: p.name, net: p.net === NO_NET ? '' : doc.nets[p.net]?.name ?? '',
        at: p.at, hole: p.hole, plated: p.plated, w: p.top.w, h: p.top.h, rotation: p.rotation,
        side: p.layer === L.MULTI ? 0 : p.layer === bottom ? 2 : 1, testTop: f.top, testBottom: f.bottom });
    } else if (p.kind === 'via') {
      const f = flags(p.src.storage, p.src.index, 0);
      out.push({ kind: 'via', designator: 'VIA', pin: '', net: p.net === NO_NET ? '' : doc.nets[p.net]?.name ?? '',
        at: p.at, hole: p.hole, plated: true, w: p.diameter, h: p.diameter, rotation: 0, side: 0, testTop: f.top, testBottom: f.bottom });
    }
  }
  return out;
}

const pad = (s: string, n: number) => s.slice(0, n).padEnd(n, ' ');
const two = (n: number) => String(n).padStart(2, '0');

/** IPC-D-356A netlist. */
export function ipc356(doc: PcbDocument, s: TestPointSetup, now = new Date()): string {
  const origin = s.relative ? doc.board.origin : { x: 0, y: 0 };
  // CUST 0: 0.0001 inch; CUST 1: 0.001 mm
  const unit = (c: number) => (s.units === 'in' ? Math.round(c / 1000) : Math.round((c * 25.4) / 10000));
  const num = (v: number, n: number) => `${v < 0 ? '-' : '+'}${String(Math.min(Math.abs(v), 10 ** n - 1)).padStart(n, '0')}`;
  const lines = [
    `C  IPC-D-356A netlist of ${doc.name}`,
    `C  Written by Konium Designer ${two(now.getDate())}/${two(now.getMonth() + 1)}/${now.getFullYear()}`,
    'C',
    `P  JOB   ${doc.name.replace(/\.pcbdoc$/i, '')}`,
    `P  UNITS CUST ${s.units === 'in' ? 0 : 1}`,
    'P  DIM   N',
  ];
  const alias = new Map<string, string>();
  const netCol = (n: string) => {
    if (!n) return 'N/C';
    if (n.length <= 14) return n;
    let a = alias.get(n);
    if (!a) { a = `NNAME${alias.size + 1}`; alias.set(n, a); lines.push(`P  ${pad(a, 8)}${n}`); }
    return a;
  };
  const feats = testFeatures(doc);
  for (const f of feats) netCol(f.net); // aliases come before the records
  for (const f of feats) {
    const thru = f.hole > 0;
    const access = f.testTop && f.testBottom ? 0 : f.testTop ? 1 : f.testBottom ? 2 : f.side;
    const mask = f.side === 1 ? 1 : f.side === 2 ? 2 : 3;
    const rec = [
      thru ? '317' : '327',
      pad(netCol(f.net), 14), '   ',
      pad(f.designator, 6), '-', pad(f.pin, 4), ' ',
      thru ? `D${String(Math.min(unit(f.hole), 9999)).padStart(4, '0')}${f.plated ? 'P' : 'U'}` : '      ',
      `A${two(access)}`,
      `X${num(unit(f.at.x - origin.x), 6)}Y${num(unit(f.at.y - origin.y), 6)}`,
      `X${String(Math.min(unit(f.w), 9999)).padStart(4, '0')}Y${String(Math.min(unit(f.h), 9999)).padStart(4, '0')}R${String(Math.round(((f.rotation % 360) + 360) % 360)).padStart(3, '0')}`,
      ' ', `S${mask}`,
    ].join('');
    lines.push(rec.padEnd(80, ' '));
  }
  lines.push('999');
  return lines.join('\r\n') + '\r\n';
}

/** The marked test points as a report (text) and a table (CSV). */
export function testPointFiles(doc: PcbDocument, s: TestPointSetup, now = new Date()): OutputFile[] {
  const base = doc.name.replace(/\.pcbdoc$/i, '');
  const origin = s.relative ? doc.board.origin : { x: 0, y: 0 };
  const u = (c: number) => (s.units === 'in' ? `${(c / 10000).toFixed(2)}mil` : `${((c * 25.4) / 1e7).toFixed(4)}mm`);
  const pts = testFeatures(doc).filter((f) => f.testTop || f.testBottom);
  const rows = pts.map((f) => [f.kind === 'via' ? 'Via' : `${f.designator}-${f.pin}`, f.net || 'No Net', f.testTop && f.testBottom ? 'Both' : f.testTop ? 'Top' : 'Bottom',
    u(f.at.x - origin.x), u(f.at.y - origin.y), f.hole > 0 ? 'THT' : 'SMD', f.hole > 0 ? u(f.hole) : '']);
  const head = ['Test Point', 'Net', 'Side', 'X', 'Y', 'Type', 'Hole'];
  const files: OutputFile[] = [];
  if (s.ipc) files.push({ name: `${base}.ipc`, text: ipc356(doc, s, now) });
  if (s.text) {
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)) + 2);
    const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join('').trimEnd();
    files.push({ name: `${base}-TestPointReport.txt`, text: [
      `Test Point Report for ${doc.name}`, `${two(now.getDate())}/${two(now.getMonth() + 1)}/${now.getFullYear()} ${two(now.getHours())}:${two(now.getMinutes())}`, '',
      line(head), '-'.repeat(widths.reduce((a, b) => a + b, 0)), ...rows.map(line), '', `Total test points: ${rows.length}`, '',
    ].join('\r\n') });
  }
  if (s.csv) {
    const q = (c: string) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);
    files.push({ name: `${base}-TestPointReport.csv`, text: [head, ...rows].map((r) => r.map(q).join(',')).join('\r\n') + '\r\n' });
  }
  return files;
}
