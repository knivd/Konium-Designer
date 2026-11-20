import type { Vec2 } from '../core/geom';
import type { PropertyBag } from '../formats/altium/props';
import type { PcbRawRecord } from '../formats/altium/framing';

/**
 * Edit › Copy / Cut / Paste between documents of a kind. Schematic objects keep their
 * ownership (a component with its pins and parameters) as positions within the copy.
 */
export interface SchClip { kind: 'sch'; ref: Vec2; items: { bag: PropertyBag; owner: number }[] }
export interface PcbClip {
  kind: 'pcb'; ref: Vec2;
  /** Free primitives, with the storage each came from. */
  records: { storage: string; rec: PcbRawRecord }[];
  /** Components (Components6 properties) with the records they own. */
  components: { bag: PropertyBag; records: { storage: string; rec: PcbRawRecord }[] }[];
  /** Polygon pour definitions (repoured where they land). */
  polygons: PropertyBag[];
  /** Net names by the copied document's net index, so a paste into another board finds its nets. */
  nets: Map<number, string>;
}

/** CAM objects copied: by the layer they came from (its name and type), with the apertures and tools they use. */
export interface CamClip {
  kind: 'cam'; ref: Vec2;
  layers: { name: string; type: string; drill: boolean; units: 'in' | 'mm'; apertures: Map<number, import('../formats/gerber/gerberRead').Aperture>; macros: Map<string, string[]>;
    objects: import('../formats/gerber/gerberRead').GerberObject[]; hits: import('../formats/gerber/gerberRead').DrillHit[]; tools: Map<number, number>;
    groups?: Map<number, import('../formats/cam/camModel').CamGroup> }[];
}

export let clipboard: SchClip | PcbClip | CamClip | null = null;
/** Told of each copy (the Clipboard panel keeps them). */
export const clipboardListeners = new Set<(c: SchClip | PcbClip | CamClip) => void>();
export function setClipboard(c: SchClip | PcbClip | CamClip | null, quiet = false): void {
  clipboard = c;
  if (c && !quiet) for (const l of clipboardListeners) l(c);
}
