/**
 * Design › Netlist For Project / Document › EDIF for PCB, Pcad for PCB and MultiWire: the
 * compiled design in the netlist formats AD17 writes besides Protel [est: AD's exact layouts].
 * - EDIF 2.0.0: a COMPONENT_LIB of one cell per library part with its pins as ports, the design
 *   cell holding an instance per component (its footprint and comment as properties) and the
 *   nets as joined port references; names EDIF can't take are written renamed.
 * - P-CAD ASCII netlist: a {COMPONENT PCB.PCB … } block with each part as {I footprint.PRT
 *   designator {CN pin net …}}.
 * - MultiWire: a NETLIST header, the parts, then each net with its pins.
 */
import { natural, type CompiledProject } from '../model/compile';

const CRLF = '\r\n';

/** An EDIF identifier for a name (letters, digits, underscores; a digit first takes "&"); else renamed. */
export function edifName(s: string): string {
  const id = s.replace(/[^A-Za-z0-9_]/g, '_');
  const ident = /^[A-Za-z]/.test(id) ? id : `&${id}`;
  return ident === s ? s : `(rename ${ident} "${s.replace(/"/g, '%34%')}")`;
}
const edifRef = (s: string) => { const id = s.replace(/[^A-Za-z0-9_]/g, '_'); return /^[A-Za-z]/.test(id) ? id : `&${id}`; };

export function edifNetlist(c: CompiledProject, design: string, when = new Date(), program = 'Konium Designer'): string {
  const comps = [...c.components].filter((x) => x.kind !== 2).sort((a, b) => natural(a.designator, b.designator));
  const pinsOf = new Map<string, Set<string>>();
  for (const n of c.nets) for (const p of n.pins) {
    const comp = comps.find((x) => x.designator === p.designator);
    if (!comp) continue;
    const k = comp.libRef || comp.footprint || comp.designator;
    (pinsOf.get(k) ?? pinsOf.set(k, new Set()).get(k)!).add(p.pin);
  }
  for (const comp of comps) { const k = comp.libRef || comp.footprint || comp.designator; if (!pinsOf.has(k)) pinsOf.set(k, new Set()); }
  const d = edifRef(design);
  const ts = `(timeStamp ${when.getFullYear()} ${when.getMonth() + 1} ${when.getDate()} ${when.getHours()} ${when.getMinutes()} ${when.getSeconds()})`;
  const lines: string[] = [
    `(edif ${edifName(design)}`, ' (edifVersion 2 0 0)', ' (edifLevel 0)', ' (keywordMap (keywordLevel 0))',
    ` (status (written ${ts} (program "${program}") (author "")))`,
    ' (library COMPONENT_LIB', '  (edifLevel 0)', '  (technology (numberDefinition))',
  ];
  for (const [cell, pins] of [...pinsOf].sort(([a], [b]) => natural(a, b))) {
    lines.push(`  (cell ${edifName(cell)}`, '   (cellType GENERIC)', '   (view netListView', '    (viewType NETLIST)', '    (interface');
    for (const p of [...pins].sort(natural)) lines.push(`     (port ${edifName(p)} (direction INOUT))`);
    lines.push('    )', '   )', '  )');
  }
  lines.push(' )', ' (library SHEET_LIB', '  (edifLevel 0)', '  (technology (numberDefinition))', `  (cell ${edifName(design)}`, '   (cellType GENERIC)', '   (view netListView', '    (viewType NETLIST)', '    (interface)', '    (contents');
  for (const comp of comps) {
    const cell = comp.libRef || comp.footprint || comp.designator;
    lines.push(`     (instance ${edifName(comp.designator)}`, `      (viewRef netListView (cellRef ${edifRef(cell)} (libraryRef COMPONENT_LIB)))`,
      `      (property Footprint (string "${comp.footprint.replace(/"/g, '%34%')}"))`, `      (property Comment (string "${comp.comment.replace(/"/g, '%34%')}"))`, '     )');
  }
  for (const n of [...c.nets].sort((a, b) => natural(a.name, b.name))) {
    const pins = [...new Map(n.pins.filter((p) => comps.some((x) => x.designator === p.designator)).map((p) => [`${p.designator}-${p.pin}`, p])).values()];
    if (!pins.length) continue;
    lines.push(`     (net ${edifName(n.name)}`, '      (joined');
    for (const p of pins.sort((a, b) => natural(`${a.designator}-${a.pin}`, `${b.designator}-${b.pin}`))) lines.push(`       (portRef ${edifRef(p.pin)} (instanceRef ${edifRef(p.designator)}))`);
    lines.push('      )', '     )');
  }
  lines.push('    )', '   )', '  )', ' )', ` (design ${d} (cellRef ${d} (libraryRef SHEET_LIB)))`, ')', '');
  return lines.join(CRLF);
}

/** Each component's pins with the net on them ('?' for none). */
function pinNets(c: CompiledProject): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const comp of c.components) out.set(comp.designator, new Map());
  for (const n of c.nets) for (const p of n.pins) out.get(p.designator)?.set(p.pin, n.name);
  return out;
}

export function pcadNetlist(c: CompiledProject): string {
  const nets = pinNets(c);
  const lines = ['{COMPONENT PCB.PCB', ' {ENVIRONMENT PCB.ENV}', ' {DETAIL', '  {SUBCOMP'];
  for (const comp of [...c.components].filter((x) => x.kind !== 2).sort((a, b) => natural(a.designator, b.designator))) {
    lines.push(`   {I ${(comp.footprint || 'UNKNOWN').replace(/\s+/g, '_')}.PRT ${comp.designator}`, '    {CN');
    for (const [pin, net] of [...(nets.get(comp.designator) ?? new Map())].sort(([a], [b]) => natural(a, b))) lines.push(`     ${pin} ${net.replace(/\s+/g, '_')}`);
    lines.push('    }', '   }');
  }
  lines.push('  }', ' }', '}', '');
  return lines.join(CRLF);
}

export function multiwireNetlist(c: CompiledProject, design: string): string {
  const lines = ['NETLIST', `DESIGN ${design}`, '', 'PARTS'];
  for (const comp of [...c.components].filter((x) => x.kind !== 2).sort((a, b) => natural(a.designator, b.designator))) {
    lines.push(`${comp.designator.padEnd(12)}${(comp.footprint || '').padEnd(24)}${comp.comment}`);
  }
  lines.push('', 'NETS');
  for (const n of [...c.nets].sort((a, b) => natural(a.name, b.name))) {
    const pins = [...new Set(n.pins.map((p) => `${p.designator}-${p.pin}`))].sort(natural);
    if (!pins.length) continue;
    lines.push(`${n.name}`, ...pins.map((p) => `  ${p}`));
  }
  lines.push('', 'END', '');
  return lines.join(CRLF);
}
