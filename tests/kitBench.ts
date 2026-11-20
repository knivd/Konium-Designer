/**
 * A bench for the kit's tests: one part alone on a sheet, its netlist line naming a node of its own
 * for each pin, to which a test adds what drives and loads it.
 */
import { expect } from 'vitest';
import { SchBuilder } from '../src/formats/synthetic/schBuilder';
import { SIM_PARTS_LIB, type SimSymbolBuilder } from '../src/formats/synthetic/simLib';
import { partRecords } from '../src/model/schPlace';
import { setSimParam } from '../src/model/simModels';
import { SR } from '../src/model/sch';
import { cfbPut, newEntry, writeCfb } from '../src/formats/cfb/cfb';
import { binToBytes } from '../src/formats/text';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { compileProject } from '../src/model/compile';
import { projectNetlist } from '../src/sim/adNetlist';
import { defaultSettings } from '../src/sim/settings';
import { readNetlist } from '../src/sim/netlist';
import { Simulator } from '../src/sim/engine';

/** A sheet with one part on it and nothing joined to it: its netlist line names a node of its own for each pin. */
export function alone(sym: SimSymbolBuilder, values: Record<string, string> = {}): { line: string; text: string; pins: string[]; errors: string[] } {
  const b = new SchBuilder();
  b.add({ RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Arial', SHEETSTYLE: 0, AREACOLOR: 0xffffff, SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10 });
  const items = partRecords({ libRef: sym.libRef, bags: sym.bags }, SIM_PARTS_LIB, 1);
  for (const [k, v] of Object.entries(values)) expect(setSimParam(items, k, v), `${sym.libRef} ${k}`).toBe(true);
  b.placePart(items, [300, 400], { designator: 'X1' });
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', b.bytes());
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  const sheets = [{ name: 'One.SchDoc', doc: readSchDoc(writeCfb(root), 'One.SchDoc') }];
  const net = projectNetlist(compileProject(sheets), sheets, defaultSettings());
  const body = net.text.split('*Schematic Netlist:')[1] ?? '';
  const line = body.split('\n').find((l) => l.trim() && !l.startsWith('*')) ?? '';
  const pins = [...new Set([...line.matchAll(/NC_X1_(\w+)/g)].map((m) => m[0]))];
  return { line, text: net.text, pins, errors: net.messages.filter((m) => m.level === 'error').map((m) => m.text) };
}

/** A part alone with these values and `lines` added to its netlist (p1, p2 and so on stand for its pins, in the order of its netlist line), at rest or (`discharged`) from nothing. */
export function rest(sym: SimSymbolBuilder, values: Record<string, string>, lines: string[], discharged = false): { sim: Simulator; v: (n: string) => number; to: (t: number, hmax?: number) => void } {
  const a = alone(sym, values);
  expect(a.errors, sym.libRef).toEqual([]);
  const pin = (n: string) => a.pins[+n - 1]!;
  const sim = new Simulator(readNetlist(a.text.replace(/^\.END\s*$/m, `${lines.map((l) => l.replace(/\bp(\d+)\b/g, (_, n: string) => pin(n))).join('\n')}\n.END`)));
  sim.liveStart(discharged ? { uic: true } : {});
  return { sim, v: (n) => sim.valueOf(/^p\d+$/.test(n) ? pin(n.slice(1)) : n)!, to: (t, hmax = 2e-5) => { while (sim.liveTime < t - 1e-12) sim.liveAdvance(Math.min(t, sim.liveTime + 20 * hmax), hmax); } };
}
