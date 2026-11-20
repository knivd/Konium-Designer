/**
 * Design › Netlist For Project / Document › Protel: the compiled design as a Protel netlist
 * (.NET), as AD writes it — a block per component in brackets (designator, footprint, comment,
 * then three empty lines) and a block per net in parentheses (its name, then each pin as
 * DESIGNATOR-PIN), lines ending CR LF.
 */
import { natural, type CompiledProject } from '../model/compile';

export function protelNetlist(c: CompiledProject): string {
  const out: string[] = [];
  for (const comp of [...c.components].sort((a, b) => natural(a.designator, b.designator))) {
    out.push('[', comp.designator, comp.footprint, comp.comment, '', '', '', ']');
  }
  for (const net of [...c.nets].sort((a, b) => natural(a.name, b.name))) {
    if (!net.pins.length) continue;
    out.push('(', net.name, ...[...new Set(net.pins.map((p) => `${p.designator}-${p.pin}`))].sort(natural), ')');
  }
  return out.join('\r\n') + '\r\n';
}
