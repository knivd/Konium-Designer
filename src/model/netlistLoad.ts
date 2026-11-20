/**
 * Design › Netlist › Load a Netlist... (26.187): a netlist file brought to the board in front.
 * The file (Protel, Protel 2, Tango, PADS, Telesis, KiCad, P-CAD, MultiWire or EDIF: see formats/netlistRead)
 * is read as parts and nets and set against the board as a schematic is by Update PCB Document:
 * the same Engineering Change Order lists what would change (parts added, with their footprints
 * from the libraries in reach, and parts the file does not name taken off; nets added; each pin
 * put on its net or off one), each change to be ticked or not, validated and carried out as one
 * step to undo.
 *
 * A netlist says less than a schematic: a part with no comment in it keeps the one it has on the
 * board, and nothing is said of rooms, classes or rules.
 */
import type { CompiledProject } from '../model/compile';
import type { PcbDocument } from '../model/pcb';
import { itemChange, planPcbUpdate, validateItem, type FootprintFinder, type PcbEcoItem } from '../model/pcbEco';
import type { ReadNetlist } from '../formats/netlistRead';

/** A netlist as the compiled design Update PCB Document works from. */
export function netlistProject(n: ReadNetlist): CompiledProject {
  const ref = { sheet: '', index: -1 };
  return {
    components: n.parts.map((p) => ({ designator: p.designator, comment: p.comment, libRef: p.comment, footprint: p.footprint, description: p.description, sheet: '', parts: 1, refs: [], params: {}, uniqueId: '', kind: 0 })),
    nets: n.nets.map((x) => ({ name: x.name, auto: false, pins: x.pins.map((p) => ({ designator: p.designator, pin: p.pin, name: p.pin, electrical: 4, ref })), sheets: [], refs: [] })),
    messages: [], scope: 'flat', hierarchy: { roots: [], missing: [], parents: new Map(), childOf: new Map() } as unknown as CompiledProject['hierarchy'],
  };
}

/** What loading the netlist would change on the board (a part the file gives no comment keeps its own). */
export function planNetlist(n: ReadNetlist, doc: PcbDocument, find: FootprintFinder): PcbEcoItem[] {
  return planPcbUpdate(netlistProject(n), doc, find).filter((it) => !(it.kind === 'changeComment' && it.to === ''));
}
export { itemChange, validateItem };
