/**
 * PCB printouts, as AD's PCB Printout Properties keeps them (PcbPrintView / PcbPrintOut /
 * PcbPrintLayer in an Output Job): a job is a list of printouts, each a page of layers drawn in
 * order, with its own options (components of the top, bottom or both sides, mirror, holes, pad
 * numbers and nets). The fabrication and assembly print outputs are jobs with AD's default
 * printouts:
 * - PCB Prints: Multilayer Composite Print (every used layer);
 * - Final Artwork Prints: one printout per used copper, overlay, mask and paste layer, with the
 *   keep-out and Mechanical 1 [est: AD's exact set];
 * - Composite Drill Guide: the drill guide with the keep-out and Mechanical 1;
 * - Drill Drawings: "Drill Drawing For (Top Layer,Bottom Layer)" and its "Drill Guide For …";
 * - Assembly Drawings: the top and the bottom (mirrored) assembly drawings;
 * - Mask Set: the solder and paste masks; Power-Plane Set: each internal plane.
 */
import { L, isMech, layerName, type LayerId } from './layers';
import type { PcbDocument } from './pcb';
import { boardDrillSymbols, type DrillSymbols } from '../formats/gerber/drillDrawing';

export interface Printout {
  name: string;
  /** Layers in printing order: the first listed is printed on top. */
  layers: LayerId[];
  /** Components included: top side, bottom side, double sided (through-hole). */
  top: boolean; bottom: boolean; multi: boolean;
  mirror: boolean;
  holes: boolean;
  padNumbers: boolean;
  padNets: boolean;
}

export type PrintJobKind = 'pcb' | 'final' | 'composite' | 'drill' | 'assembly' | 'mask' | 'plane';

export interface PrintJob {
  kind: PrintJobKind;
  /** AD's output name (OutputName in an Output Job). */
  title: string;
  printouts: Printout[];
  /** Print area: the design extent (AD's default) or the whole sheet. */
  area: 'extent' | 'sheet';
  symbols: DrillSymbols;
}

export const JOB_TITLES: Record<PrintJobKind, string> = {
  pcb: 'PCB Prints', final: 'Final Artwork Prints', composite: 'Composite Drill Guide', drill: 'Drill Drawing/Guides',
  assembly: 'Assembly Drawings', mask: 'Mask Set', plane: 'Power-Plane Set',
};

export const printout = (name: string, layers: LayerId[], o: Partial<Printout> = {}): Printout =>
  ({ name, layers, top: true, bottom: true, multi: true, mirror: false, holes: false, padNumbers: false, padNets: false, ...o });

/** Layers that hold something, in AD's printing order (overlay over copper, the rest after). */
export function usedLayers(doc: PcbDocument): LayerId[] {
  const used = new Set<LayerId>();
  for (const p of doc.prims) if ('layer' in p && p.kind !== 'body') used.add(p.layer);
  for (const d of doc.dimensions) used.add(d.layer);
  for (const pg of doc.polygons) used.add(pg.layer);
  const order: LayerId[] = [L.TOP_OVERLAY, ...doc.board.copperStack, L.BOTTOM_OVERLAY, L.TOP_PASTE, L.BOTTOM_PASTE, L.TOP_SOLDER, L.BOTTOM_SOLDER,
    L.DRILL_GUIDE, L.KEEPOUT, ...Array.from({ length: 16 }, (_, i) => L.MECH1 + i), L.DRILL_DRAWING, L.MULTI];
  return order.filter((l) => used.has(l) || l === L.MULTI || (doc.board.copperStack.includes(l)));
}

const named = (doc: PcbDocument, l: LayerId) => doc.board.layerNames.get(l) ?? layerName(l);

/** A job's default printouts, as AD sets them up for the output. */
export function defaultJob(doc: PcbDocument, kind: PrintJobKind): PrintJob {
  const frame: LayerId[] = [L.KEEPOUT, L.MECH1];
  const stack = doc.board.copperStack;
  const pair = `(${named(doc, stack[0]!)},${named(doc, stack.at(-1)!)})`;
  const used = new Set(usedLayers(doc));
  // Drill drawings and guides print every mechanical layer in use (AD17's print shows the dimensions on Mechanical 3)
  const mechs = [...new Set([L.MECH1 as LayerId, ...usedLayers(doc).filter(isMech)])];
  const drillFrame: LayerId[] = [L.KEEPOUT, ...mechs];
  let printouts: Printout[] = [];
  switch (kind) {
    case 'pcb':
      printouts = [printout('Multilayer Composite Print', usedLayers(doc), { holes: true })];
      break;
    case 'final': {
      const sets: [LayerId, string][] = [
        ...stack.map((l): [LayerId, string] => [l, named(doc, l)]),
        [L.TOP_OVERLAY, 'Top Overlay'], [L.BOTTOM_OVERLAY, 'Bottom Overlay'],
        [L.TOP_SOLDER, 'Top Solder Mask Print'], [L.BOTTOM_SOLDER, 'Bottom Solder Mask Print'],
        [L.TOP_PASTE, 'Top Paste Mask Print'], [L.BOTTOM_PASTE, 'Bottom Paste Mask Print'],
      ];
      printouts = sets.filter(([l]) => used.has(l) || stack.includes(l) || l === L.TOP_SOLDER || l === L.BOTTOM_SOLDER)
        .map(([l, n]) => printout(n, [l, ...frame], { mirror: l === stack.at(-1) || l === L.BOTTOM_OVERLAY || l === L.BOTTOM_SOLDER || l === L.BOTTOM_PASTE }));
      printouts.push(printout(`Drill Drawing ${pair}`, [L.DRILL_DRAWING, ...drillFrame]), printout(`Drill Guide ${pair}`, [L.DRILL_GUIDE, ...drillFrame]));
      break;
    }
    case 'composite':
      printouts = [printout('Composite Drill Guide', [L.DRILL_GUIDE, ...drillFrame])];
      break;
    case 'drill':
      printouts = [printout(`Drill Drawing For ${pair}`, [L.DRILL_DRAWING, ...drillFrame]), printout(`Drill Guide For ${pair}`, [L.DRILL_GUIDE, ...drillFrame])];
      break;
    case 'assembly':
      printouts = [
        printout(`${named(doc, stack[0]!)} Assembly Drawing`, [L.TOP_OVERLAY, ...frame], { bottom: false, holes: true }),
        printout(`${named(doc, stack.at(-1)!)} Assembly Drawing`, [L.BOTTOM_OVERLAY, ...frame], { top: false, mirror: true, holes: true }),
      ];
      break;
    case 'mask':
      printouts = [L.TOP_SOLDER, L.BOTTOM_SOLDER, L.TOP_PASTE, L.BOTTOM_PASTE].filter((l) => l === L.TOP_SOLDER || l === L.BOTTOM_SOLDER || used.has(l))
        .map((l) => printout(`${layerName(l)} Print`, [l, ...frame], { mirror: l === L.BOTTOM_SOLDER || l === L.BOTTOM_PASTE }));
      break;
    case 'plane':
      printouts = stack.filter((l) => l >= L.PLANE1 && l <= L.PLANE16).map((l) => printout(`${named(doc, l)} Print`, [l, ...frame]));
      break;
  }
  return { kind, title: JOB_TITLES[kind], printouts, area: 'extent', symbols: boardDrillSymbols(doc) };
}

/** Jobs remembered per board for the session (Output Jobs carry their own). */
const jobs = new WeakMap<PcbDocument, Map<PrintJobKind, PrintJob>>();
export function jobFor(doc: PcbDocument, kind: PrintJobKind): PrintJob {
  let m = jobs.get(doc);
  if (!m) jobs.set(doc, (m = new Map()));
  let j = m.get(kind);
  if (!j) m.set(kind, (j = defaultJob(doc, kind)));
  return j;
}
export function setJob(doc: PcbDocument, job: PrintJob): void {
  let m = jobs.get(doc);
  if (!m) jobs.set(doc, (m = new Map()));
  m.set(job.kind, job);
}
