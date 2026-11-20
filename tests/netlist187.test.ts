/**
 * Design › Netlist › Load a Netlist (26.187): netlist files of eight formats read as parts and nets, and a board brought
 * to what one says through the same changes Update PCB Document makes.
 */
import { describe, expect, it } from 'vitest';
import { netlistFormat, readNetlistFile } from '../src/formats/netlistRead';
import { protelNetlist } from '../src/formats/netlist';
import { edifNetlist, multiwireNetlist, pcadNetlist } from '../src/formats/netlists';
import { netlistProject, planNetlist } from '../src/model/netlistLoad';
import { itemChange, planPcbUpdate, validateItem, type FootprintFinder } from '../src/model/pcbEco';
import { readPcbDoc, writePcbDoc } from '../src/formats/altium/pcbdoc';
import { readPcbLib } from '../src/formats/altium/pcblib';
import { readSchDoc } from '../src/formats/altium/schdoc';
import { demoPcbDoc, demoPcbLib, demoSchDoc } from '../src/formats/synthetic/demo';
import { compileProject } from '../src/model/compile';
import { UndoStack } from '../src/core/undo';
import { NO_NET } from '../src/model/pcb';

const PROTEL = ['[', 'R1', '0805', '10k', '', '', '', ']', '[', 'C1', '0603', '100n', '', '', '', ']', '[', 'U1', 'SOIC8', 'LM358', '', '', '', ']',
  '(', 'GND', 'C1-2', 'U1-4', ')', '(', 'VCC', 'C1-1', 'R1-1', 'U1-8', ')', '(', 'NetR1_2', 'R1-2', 'U1-3', ')', ''].join('\r\n');

describe('netlist files (26.187)', () => {
  const pins = (n: { pins: { designator: string; pin: string }[] }) => n.pins.map((p) => `${p.designator}.${p.pin}`);

  it('Protel: bracketed parts and nets, as this program writes them', () => {
    expect(netlistFormat(PROTEL)).toBe('NET');
    const n = readNetlistFile(PROTEL)!;
    expect(n.parts).toEqual([{ designator: 'R1', footprint: '0805', comment: '10k', description: '' }, { designator: 'C1', footprint: '0603', comment: '100n', description: '' }, { designator: 'U1', footprint: 'SOIC8', comment: 'LM358', description: '' }]);
    expect(n.nets.map((x) => [x.name, pins(x)])).toEqual([['GND', ['C1.2', 'U1.4']], ['VCC', ['C1.1', 'R1.1', 'U1.8']], ['NetR1_2', ['R1.2', 'U1.3']]]);
    expect(n.notes).toEqual([]);
  });

  it('Tango: the same brackets, a pin written U1,3; a designator with a dash in it keeps it', () => {
    const tango = PROTEL.replace(/^([A-Z]+\d+)-(\d+)$/gm, '$1,$2');
    expect(netlistFormat(tango)).toBe('Tango');
    expect(readNetlistFile(tango)!.nets[1]!.pins).toEqual([{ designator: 'C1', pin: '1' }, { designator: 'R1', pin: '1' }, { designator: 'U1', pin: '8' }]);
    const dashed = readNetlistFile(['[', 'J1-A', 'HDR', 'Header', '', '', '', ']', '(', 'N1', 'J1-A-3', ')', ''].join('\n'))!;
    expect(dashed.nets[0]!.pins).toEqual([{ designator: 'J1-A', pin: '3' }]);
  });

  it('Protel 2: named fields in the brackets, and each pin with its name and type after it', () => {
    const p2 = ['PROTEL NETLIST 2.0', '[', 'DESIGNATOR', 'R1', 'FOOTPRINT', '0805', 'PARTTYPE', '10k', 'DESCRIPTION', 'Resistor', 'Part Field 1', '*', 'LIBRARYFIELD1', '', ']',
      '[', 'DESIGNATOR', 'U1', 'FOOTPRINT', 'SOIC8', 'PARTTYPE', 'LM358', 'DESCRIPTION', 'Dual op-amp', ']', '(', 'VCC', 'R1-1 1 PASSIVE', 'U1-8 V+ POWER', ')', '{', 'TRACK', '10', '}', ''].join('\r\n');
    expect(netlistFormat(p2)).toBe('NET 2');
    const n = readNetlistFile(p2)!;
    expect(n.parts).toEqual([{ designator: 'R1', footprint: '0805', comment: '10k', description: 'Resistor' }, { designator: 'U1', footprint: 'SOIC8', comment: 'LM358', description: 'Dual op-amp' }]);
    expect(n.nets.map((x) => [x.name, pins(x)])).toEqual([['VCC', ['R1.1', 'U1.8']]]);
  });

  it('PADS: *PART* and *NET* with *SIGNAL*, a part type before the @ of its decal, pins over several lines', () => {
    const pads = ['*PADS-PCB*', '*PART*', 'R1 0805', 'C1 CAP100N@0603', 'U1 LM358@SOIC8', '*NET*', '*SIGNAL* GND', 'C1.2 U1.4', '*SIGNAL* VCC 12.00 0', 'C1.1 R1.1', 'U1.8', '*END*', ''].join('\r\n');
    expect(netlistFormat(pads)).toBe('PADS');
    const n = readNetlistFile(pads)!;
    expect(n.parts.map((p) => [p.designator, p.footprint, p.comment])).toEqual([['R1', '0805', ''], ['C1', '0603', 'CAP100N'], ['U1', 'SOIC8', 'LM358']]);
    expect(n.nets.map((x) => [x.name, pins(x)])).toEqual([['GND', ['C1.2', 'U1.4']], ['VCC', ['C1.1', 'R1.1', 'U1.8']]]);
  });

  it('Telesis: $PACKAGES and $NETS, a line carried on by a comma', () => {
    const tel = ['$PACKAGES', "0805! RES! 10k; R1 R2", "SOIC8! 'LM358'; U1", '$NETS', 'GND; R2.2 U1.4', "'VCC'; R1.1 U1.8,", '  R2.1', '$END', ''].join('\n');
    expect(netlistFormat(tel)).toBe('Telesis');
    const n = readNetlistFile(tel)!;
    expect(n.parts.map((p) => [p.designator, p.footprint, p.comment])).toEqual([['R1', '0805', '10k'], ['R2', '0805', '10k'], ['U1', 'SOIC8', 'LM358']]);
    expect(n.nets.map((x) => [x.name, pins(x)])).toEqual([['GND', ['R2.2', 'U1.4']], ['VCC', ['R1.1', 'U1.8', 'R2.1']]]);
  });

  it('KiCad: the export\'s components and nets; a footprint without its library\'s name', () => {
    const k = `(export (version "E")
  (components
    (comp (ref "R1") (value "10k") (footprint "Resistor_SMD:R_0805_2012Metric") (description "Resistor"))
    (comp (ref "U1") (value "LM358") (footprint "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm")))
  (nets
    (net (code "1") (name "GND") (node (ref "U1") (pin "4") (pintype "power_in")))
    (net (code "2") (name "/out put") (node (ref "R1") (pin "2")) (node (ref "U1") (pin "1")))))`;
    expect(netlistFormat(k)).toBe('KiCad');
    const n = readNetlistFile(k)!;
    expect(n.parts).toEqual([{ designator: 'R1', footprint: 'R_0805_2012Metric', comment: '10k', description: 'Resistor' }, { designator: 'U1', footprint: 'SOIC-8_3.9x4.9mm_P1.27mm', comment: 'LM358', description: '' }]);
    expect(n.nets.map((x) => [x.name, pins(x)])).toEqual([['GND', ['U1.4']], ['/out put', ['R1.2', 'U1.1']]]);
  });

  it('P-CAD: ACCEL_ASCII, a pattern from the component\'s definition', () => {
    const pc = `ACCEL_ASCII "board.net"
(asciiHeader (asciiVersion 3 0))
(netlist "Netlist_1"
  (compDef "RES_1" (originalName "RES") (attachedPattern (patternNum 1) (patternName "0805")))
  (compInst "R1" (compRef "RES_1") (originalName "RES") (compValue "10k"))
  (compInst "U1" (compRef "LM358_1") (originalName "LM358") (patternName "SOIC8"))
  (net "GND" (node "U1" "4"))
  (net "N 1" (node "R1" "2") (node "U1" "1")))`;
    expect(netlistFormat(pc)).toBe('P-CAD');
    const n = readNetlistFile(pc)!;
    expect(n.parts.map((p) => [p.designator, p.footprint, p.comment])).toEqual([['R1', '0805', '10k'], ['U1', 'SOIC8', 'LM358']]);
    expect(n.nets.map((x) => [x.name, pins(x)])).toEqual([['GND', ['U1.4']], ['N 1', ['R1.2', 'U1.1']]]);
  });

  it('EDIF: the design page\'s instances and nets; a pin written &1 is 1, a renamed net has its real name', () => {
    const e = `(edif board (edifVersion 2 0 0) (edifLevel 0) (keywordMap (keywordLevel 0))
 (library parts (edifLevel 0) (technology (numberDefinition))
  (cell RES (cellType GENERIC) (view net (viewType NETLIST) (interface (port &1) (port &2)))))
 (library design (edifLevel 0) (technology (numberDefinition))
  (cell board (cellType GENERIC) (view net (viewType NETLIST) (interface)
   (contents
    (instance R1 (viewRef net (cellRef RES (libraryRef parts))) (property Footprint (string "0805")) (property Value (string "10k")))
    (instance (rename U1_A "U1") (viewRef net (cellRef LM358 (libraryRef parts))) (property PCB_FOOTPRINT (string "SOIC8")))
    (net GND (joined (portRef &2 (instanceRef R1)) (portRef &4 (instanceRef U1_A))))
    (net (rename N_1 "N-1") (joined (portRef &1 (instanceRef R1)) (portRef OUT)))))))`;
    expect(netlistFormat(e)).toBe('EDIF');
    const n = readNetlistFile(e)!;
    expect(n.parts.map((p) => [p.designator, p.footprint, p.comment])).toEqual([['R1', '0805', '10k'], ['U1', 'SOIC8', 'LM358']]);
    expect(n.nets.map((x) => [x.name, pins(x)])).toEqual([['GND', ['R1.2', 'U1.4']], ['N-1', ['R1.1']]]);
  });

  it('what is none of these is not a netlist; a part named by nets only is known, a pin in two nets stays in the first, and both are said', () => {
    expect(readNetlistFile('just some text')).toBeNull();
    expect(readNetlistFile('')).toBeNull();
    const n = readNetlistFile(['[', 'R1', '0805', '10k', ']', '(', 'A', 'R1-1', 'C9-1', ')', '(', 'B', 'R1-1', 'R1-2', ')', '(', 'A', 'C9-2', ')', ''].join('\n'))!;
    expect(n.parts.map((p) => p.designator)).toEqual(['R1', 'C9']);
    expect(n.nets.map((x) => [x.name, pins(x)])).toEqual([['A', ['R1.1', 'C9.1', 'C9.2']], ['B', ['R1.2']]]);
    expect(n.notes).toEqual(['1 part is named by nets only, with no footprint', '1 pin is named by more than one net: the first net has it']);
  });
});

describe('a netlist loaded into a board (26.187)', () => {
  const lib = readPcbLib(demoPcbLib(), 'Demo.PcbLib');
  const find: FootprintFinder = (p) => { const f = lib.footprints.find((x) => x.name.toLowerCase() === p.toLowerCase()); return f ? { library: lib.name, footprint: f } : undefined; };
  const compiled = compileProject([{ name: 'Demo.SchDoc', doc: readSchDoc(demoSchDoc(), 'Demo.SchDoc') }]);
  const label = (p: { group: string; object: string }) => `${p.group}: ${p.object}`;

  it('the demo schematic\'s own netlist asks of the demo board what the schematic does: the LED and its resistor', () => {
    const net = readNetlistFile(protelNetlist(compiled))!, doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    expect(net.format).toBe('NET');
    expect(net.parts.length).toBe(compiled.components.length);
    const plan = planNetlist(net, doc, find);
    expect(plan.map(label)).toEqual(planPcbUpdate(compiled, doc, find).map(label));
    expect(plan.map(label)).toEqual(['Add Components: D1', 'Add Components: R1', 'Add Nets: NetD1_A',
      'Add Pins To Nets: D1-A to NetD1_A', 'Add Pins To Nets: D1-K to GND', 'Add Pins To Nets: R1-1 to +3V3', 'Add Pins To Nets: R1-2 to NetD1_A']);
    expect(plan.every((p) => validateItem(doc, p, plan, find) === null)).toBe(true);
    // Carried out as one step, saved and read again, the board is as the netlist says: nothing left to change
    const undo = new UndoStack();
    undo.transact('Load Demo.NET', (tx) => { for (const it of plan) tx.add(itemChange(doc, it, find)); });
    const again = readPcbDoc(writePcbDoc(doc), 'Demo.PcbDoc');
    expect(planNetlist(net, again, find)).toEqual([]);
    const r1 = again.components.find((c) => c.designator === 'R1')!;
    const pads = again.prims.filter((p) => p.kind === 'pad' && p.component === r1.index) as { name: string; net: number }[];
    expect(pads.map((p) => [p.name, p.net === NO_NET ? '' : again.nets[p.net]!.name]).sort()).toEqual([['1', '+3V3'], ['2', 'NetD1_A']]);
    undo.undo();
    expect(planNetlist(net, doc, find).length).toBe(7);
  });

  it('the same netlist in another program\'s format asks the same; a part it leaves out is to be taken off, a pin it moves is moved', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
    // Every netlist this program writes is one it reads: the same parts on the same nets, and the same asked of the board
    const want = planNetlist(readNetlistFile(protelNetlist(compiled))!, doc, find).map(label);
    const pinsOf = (n: ReturnType<typeof readNetlistFile>) => n!.nets.map((x) => `${x.name}: ${x.pins.map((p) => `${p.designator}-${p.pin}`).sort().join(' ')}`).sort();
    const protel = readNetlistFile(protelNetlist(compiled))!;
    for (const [format, text] of [['Pcad', pcadNetlist(compiled)], ['MultiWire', multiwireNetlist(compiled, 'Demo')], ['EDIF', edifNetlist(compiled, 'Demo')]] as const) {
      const got = readNetlistFile(text)!;
      expect(got?.format, format).toBe(format);
      expect(got.parts.map((p) => [p.designator, p.footprint]).sort(), format).toEqual(protel.parts.map((p) => [p.designator, p.footprint]).sort());
      expect(pinsOf(got), format).toEqual(pinsOf(protel));
      expect(planNetlist(got, doc, find).map(label), format).toEqual(want);
      // (the comments too, where the format carries them)
      if (format !== 'Pcad') expect(got.parts.map((p) => p.comment).sort(), format).toEqual(protel.parts.map((p) => p.comment).sort());
    }
    // Without its last part on the board, and one pin of another on a net of its own
    const on = compiled.components.filter((c) => doc.components.some((p) => p.designator === c.designator)), gone = on[on.length - 1]!.designator;
    const text = protelNetlist(compiled), net = readNetlistFile(text)!;
    net.parts = net.parts.filter((p) => p.designator !== gone && p.designator !== 'D1' && p.designator !== 'R1');
    for (const n of net.nets) n.pins = n.pins.filter((p) => p.designator !== gone && p.designator !== 'D1' && p.designator !== 'R1');
    const moved = net.nets.find((n) => n.pins.length > 1)!, pin = moved.pins.pop()!;
    net.nets.push({ name: 'LOADED_1', pins: [pin] });
    const plan = planNetlist(net, doc, find).map(label);
    expect(plan).toContain(`Remove Components: ${gone}`);
    expect(plan).toContain('Add Nets: LOADED_1');
    expect(plan).toContain(`Add Pins To Nets: ${pin.designator}-${pin.pin} to LOADED_1`);
    expect(plan.some((p) => /^Add Components/.test(p))).toBe(false);
  });

  it('a part with no comment in the netlist keeps the one it has on the board', () => {
    const doc = readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc'), net = readNetlistFile(protelNetlist(compiled))!;
    for (const p of net.parts) p.comment = '';
    expect(planNetlist(net, doc, find).some((p) => p.kind === 'changeComment')).toBe(false);
    expect(netlistProject(net).components.every((c) => c.uniqueId === '' && c.kind === 0)).toBe(true);
  });
});

describe('Design › Netlist › Load a Netlist... (26.187)', () => {
  it('is the first item of the board\'s Netlist menu, with a letter of its own', async () => {
    await import('../src/app/menus');
    const { MENUBAR } = await import('../src/app/menus/ad17.gen');
    type Spec = [string, unknown] | 0;
    const design = (MENUBAR.pcb as Spec[]).find((s) => Array.isArray(s) && s[0] === '&Design') as [string, Spec[]];
    const netlist = design[1].find((s) => Array.isArray(s) && s[0] === '&Netlist') as [string, Spec[]];
    expect(netlist[1][0]).toEqual(['&Load a Netlist...', 'pcb.loadNetlist']);
    expect(netlist[1][1]).toBe(0);
    const letters = netlist[1].filter((s): s is [string, unknown] => Array.isArray(s)).map((s) => /&(.)/.exec(s[0])?.[1]?.toUpperCase());
    expect(new Set(letters).size).toBe(letters.length);
  });
});
