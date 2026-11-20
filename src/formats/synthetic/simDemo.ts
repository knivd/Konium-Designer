/**
 * The simulation demo: a common-emitter amplifier (2N3904, 12 V supply, a 1 kHz 5 mV sine in)
 * drawn with parts from Konium's simulation libraries, its Analyses Setup ready (operating point,
 * transient, AC sweep). Design › Simulate › Mixed Sim runs it. Written by Konium's own encoders.
 */
import { SR } from '../../model/sch';
import { toBgr } from '../../model/common';
import { partRecords } from '../../model/schPlace';
import { setSimParam } from '../../model/simModels';
import { cfbPut, newEntry, writeCfb } from '../cfb/cfb';
import { binToBytes } from '../text';
import { readPrjPcb, writePrjPcb } from '../altium/prjpcb';
import { defaultSettings, writeSimSettings } from '../../sim/settings';
import { C, SchBuilder } from './schBuilder';
import { SIM_PARTS_LIB, SIM_SOURCES_LIB, simPartSymbols, simPartsSchLib, simSourceSymbols, simSourcesSchLib, type SimSymbolBuilder } from './simLib';

export const SIM_DEMO = { project: 'Sim Demo.PrjPcb', sheet: 'Amplifier.SchDoc' };

function place(b: SchBuilder, list: SimSymbolBuilder[], lib: string, libRef: string, designator: string, at: [number, number], values: Record<string, string> = {}, quarter = 0): void {
  const sym = list.find((s) => s.libRef === libRef)!;
  const items = partRecords({ libRef, bags: sym.bags }, lib, 1);
  for (const [k, v] of Object.entries(values)) setSimParam(items, k, v);
  b.placePart(items, at, { designator, quarter });
}

export function simDemoSchDoc(): Uint8Array {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 2, SIZE1: 10, FONTNAME1: 'Arial', SIZE2: 16, FONTNAME2: 'Arial', BOLD2: true,
    SHEETSTYLE: 0, BORDERON: true, TITLEBLOCKON: true, AREACOLOR: toBgr(0xffffff), SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10 });
  const src = simSourceSymbols(), parts = simPartSymbols();
  const S = (libRef: string, des: string, at: [number, number], v: Record<string, string>) => place(b, src, SIM_SOURCES_LIB.replace('.SchLib', '.IntLib'), libRef, des, at, v);
  const P = (libRef: string, des: string, at: [number, number], v: Record<string, string> = {}, q = 0) => place(b, parts, SIM_PARTS_LIB, libRef, des, at, v, q);

  S('VSRC', 'V1', [100, 420], { Value: '12' });
  S('VSIN', 'V2', [170, 300], { Amplitude: '5m', Frequency: '1k' });
  P('CAP', 'C1', [240, 400], { Value: '10u' }, 1);
  P('RES', 'R1', [320, 480], { Value: '47k' });
  P('RES', 'R2', [320, 320], { Value: '10k' });
  P('NPN', 'Q1', [360, 400]);
  P('RES', 'R3', [370, 480], { Value: '4.7k' });
  P('RES', 'R4', [370, 320], { Value: '1k' });
  P('CAP', 'C2', [440, 320], { Value: '100u' });
  P('CAP', 'C3', [440, 440], { Value: '10u' }, 1);
  P('RES', 'R5', [520, 400], { Value: '100k' });

  // Input: V2 + → IN → C1 → base
  b.wire([170, 320], [170, 400], [220, 400]);
  b.wire([260, 400], [320, 400]);
  b.wire([320, 400], [340, 400]);
  b.wire([320, 460], [320, 340]);
  b.add({ RECORD: SR.JUNCTION, OWNERPARTID: -1, COLOR: C.wire }, { LOCATION: { x: 320, y: 400 } });
  // Collector: R3 → C, on to C3; emitter: R4 with C2 across it
  b.wire([370, 460], [370, 420]);
  b.wire([370, 440], [420, 440]);
  b.add({ RECORD: SR.JUNCTION, OWNERPARTID: -1, COLOR: C.wire }, { LOCATION: { x: 370, y: 440 } });
  b.wire([370, 380], [370, 340]);
  b.wire([370, 360], [440, 360], [440, 340]);
  b.add({ RECORD: SR.JUNCTION, OWNERPARTID: -1, COLOR: C.wire }, { LOCATION: { x: 370, y: 360 } });
  b.wire([460, 440], [520, 440], [520, 420]);
  // Supply rail
  b.wire([320, 500], [320, 520], [370, 520], [370, 500]);
  b.wire([100, 440], [100, 460]);
  for (const at of [{ x: 345, y: 520 }, { x: 100, y: 460 }]) b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: 2, ORIENTATION: 1, TEXT: 'VCC', SHOWNETNAME: true, COLOR: C.wire }, { LOCATION: at });
  // Ground
  b.wire([100, 400], [100, 380]);
  b.wire([170, 280], [170, 260]);
  for (const x of [320, 370, 440]) b.wire([x, 300], [x, 280]);
  b.wire([520, 380], [520, 360]);
  for (const at of [{ x: 100, y: 380 }, { x: 170, y: 260 }, { x: 320, y: 280 }, { x: 370, y: 280 }, { x: 440, y: 280 }, { x: 520, y: 360 }]) {
    b.add({ RECORD: SR.POWER_PORT, OWNERPARTID: -1, STYLE: 4, ORIENTATION: 3, TEXT: 'GND', SHOWNETNAME: true, COLOR: C.wire }, { LOCATION: at });
  }
  b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'IN', COLOR: C.wire, FONTID: 1 }, { LOCATION: { x: 180, y: 400 } });
  b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'OUT', COLOR: C.wire, FONTID: 1 }, { LOCATION: { x: 480, y: 440 } });
  b.add({ RECORD: SR.NET_LABEL, OWNERPARTID: -1, TEXT: 'BASE', COLOR: C.wire, FONTID: 1 }, { LOCATION: { x: 270, y: 400 } });
  b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: 'Konium Designer demo — common-emitter amplifier', FONTID: 2, COLOR: C.text }, { LOCATION: { x: 100, y: 650 } });
  b.add({ RECORD: SR.LABEL, OWNERPARTID: -1, TEXT: 'Design › Simulate › Mixed Sim: operating point, transient and AC analyses', FONTID: 1, COLOR: toBgr(0x6a6f76) }, { LOCATION: { x: 100, y: 620 } });

  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  return writeCfb(root);
}

export function simDemoPrjPcb(): Uint8Array {
  const p = readPrjPcb(binToBytes([
    '[Design]', 'Version=1.0', 'HierarchyMode=0', '',
    '[Document1]', `DocumentPath=${SIM_DEMO.sheet}`, 'AnnotationEnabled=1', '',
    '[Document2]', `DocumentPath=${SIM_SOURCES_LIB}`, 'AnnotationEnabled=1', '',
    '[Document3]', `DocumentPath=${SIM_PARTS_LIB}`, 'AnnotationEnabled=1', '',
  ].join('\r\n')), SIM_DEMO.project);
  const s = defaultSettings();
  s.tran.on = true;
  s.ac.on = true;
  s.activeSignals = ['IN', 'OUT'];
  writeSimSettings(p, s);
  return writePrjPcb(p);
}

export function simDemoFiles(): { name: string; bytes: Uint8Array }[] {
  return [
    { name: SIM_DEMO.project, bytes: simDemoPrjPcb() },
    { name: SIM_DEMO.sheet, bytes: simDemoSchDoc() },
    { name: SIM_SOURCES_LIB, bytes: simSourcesSchLib() },
    { name: SIM_PARTS_LIB, bytes: simPartsSchLib() },
  ];
}
