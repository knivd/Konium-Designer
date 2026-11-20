import type { RigidFlex } from './rigidFlex';
import type { Waiver } from './drcOptions';
import type { Coord } from '../core/units';
import type { Vec2 } from '../core/geom';
import type { CfbFile } from '../formats/cfb/cfb';
import type { PcbRawRecord } from '../formats/altium/framing';
import type { PropertyBag } from '../formats/altium/props';
import type { Diagnostics } from './common';
import type { LayerId } from './layers';
import type { PcbClass, PcbRule } from '../formats/altium/rules';
import type { SideState } from '../formats/altium/primInfo';

/** Where a primitive lives in the file: storage name + record index within its Data stream. */
export interface Src { storage: string; index: number }

export const NO_NET = 0xffff;

export interface PcbTrack { kind: 'track'; src: Src; layer: LayerId; a: Vec2; b: Vec2; width: Coord; net: number; component: number; polygon: number; locked: boolean; keepout: boolean; /** A keep-out's restrictions (0x01 vias, 0x02 tracks, 0x04 copper, 0x08 SMD pads, 0x10 through pads; all when absent). */ keepoutRestrictions?: number }
export interface PcbArc { kind: 'arc'; src: Src; layer: LayerId; c: Vec2; r: Coord; start: number; end: number; width: Coord; net: number; component: number; polygon: number; locked: boolean; keepout: boolean; keepoutRestrictions?: number }
export interface PcbVia {
  kind: 'via'; src: Src; at: Vec2; diameter: Coord; hole: Coord; layerStart: LayerId; layerEnd: LayerId; net: number; locked: boolean;
  /** Top-Middle-Bottom or Full Stack: the diameter on each layer (by layer id − 1; the hole's or less where the shape was removed). */
  layerDiameters?: Coord[];
  /** Layers whose shape was removed (Remove Unused Pad Shapes): bit (layer id − 1). */
  removed?: number;
}
/** A footprint's own via (thermal vias under a part): it belongs to a component, and goes where its component goes. */
export interface PcbPartVia extends PcbVia { component: number }
export type PadShape = 'round' | 'rect' | 'octagon' | 'roundrect';
export interface PadStackLayer { w: Coord; h: Coord; shape: PadShape; cornerPct: number }
export interface PcbPad {
  kind: 'pad'; src: Src; name: string; layer: LayerId; at: Vec2; rotation: number;
  top: PadStackLayer; mid: PadStackLayer; bot: PadStackLayer;
  hole: Coord; plated: boolean; net: number; component: number; locked: boolean;
  /** Simple 0 (the top's size everywhere), Top-Middle-Bottom 1, Full Stack 2 (each inner layer its own: `inner`, Mid-Layer 1 first). */
  stackMode?: number; inner?: PadStackLayer[];
  /** Layers whose shape was removed (Remove Unused Pad Shapes): bit (layer id − 1). */
  removed?: number;
  /** A slotted hole (the hole is its width): its length and its turn from the pad's. */
  slot?: { length: Coord; rotation: number };
  /** Jumper ID: a component's pads with the same (non-zero) one are joined inside it (a wire link). */
  jumper?: number;
  /** A polygon pad: the keys of the regions that are its shape (model/padShapes; set when decoded). */
  shapeKeys?: string[];
}
/** A slotted hole's two end centres (its width is the pad's hole). */
export function slotEnds(p: PcbPad): [Vec2, Vec2] | null {
  if (!p.slot || p.slot.length <= p.hole) return null;
  const a = ((p.rotation + p.slot.rotation) * Math.PI) / 180, h = (p.slot.length - p.hole) / 2;
  const d = { x: Math.cos(a) * h, y: Math.sin(a) * h };
  return [{ x: p.at.x - d.x, y: p.at.y - d.y }, { x: p.at.x + d.x, y: p.at.y + d.y }];
}
export interface PcbFill { kind: 'fill'; src: Src; layer: LayerId; a: Vec2; b: Vec2; rotation: number; net: number; component: number; locked: boolean; keepout: boolean; keepoutRestrictions?: number }
export interface PcbText {
  kind: 'text'; src: Src; layer: LayerId; at: Vec2; height: Coord; rotation: number; mirrored: boolean; strokeWidth: Coord;
  text: string; component: number;
  isComment: boolean; isDesignator: boolean;
  /** 0 stroke, 1 TrueType, 2 barcode */
  fontType: number; fontName: string; bold: boolean; italic: boolean;
  /** Font BarCode: its settings (model/barcode.ts). */
  barcode?: import('./barcode').BarcodeSpec;
  /** Hidden by its component's NAMEON / COMMENTON — kept in the file, not drawn. */
  hidden: boolean;
}

/** Regions6 / ShapeBasedRegions6. Poured polygon copper is stored as regions owned by a polygon. */
export interface PcbRegion {
  kind: 'region'; src: Src; layer: LayerId; outline: Vec2[]; holes: Vec2[][];
  /** 0 copper, 1 polygon cutout, 2 dashed outline, 4 cavity definition */
  regionKind: number; boardCutout: boolean; net: number; polygon: number; component: number; locked: boolean; keepout: boolean; keepoutRestrictions?: number;
  /** ARCRESOLUTION: how far the stored outline's chords may lie from its true arcs. */
  arcRes?: Coord;
  /** Part of a polygon pad's shape (KONIUMPADSHAPE: the pad's designator when it was made), and that pad's key once linked (model/padShapes). */
  padShape?: string; shapeOf?: string;
  /** A KiCad teardrop it was read from (KICADTEARDROP: its type; KICADZONE, KICADOUTLINE, KICADPRIORITY), for the way back. */
  kicadTeardrop?: { type: string; zone: string; outline: string; priority: number };
  /** Part of a KiCad rule area on several layers it was read from (KICADZONE, KICADZONELAYERS, KICADKEEPOUT: what it keeps out), for the way back. */
  kicadZone?: { id: string; layers: string; keepout: string; /** KiCad's settings for the rule area (JSON: kept.ts extrasOf). */ x?: string };
  /** A KiCad custom pad's primitive it was drawn from (KICADPRIM, KICADCLEARANCE: the pad's clearance option), for the way back (formats/kicad/padPrims). */
  kicadPrim?: { prim: string; clearance: string };
  /** An opening of a KiCad pad on no copper (KICADAPERTURE: its number in the footprint, KICADPAD: the pad), for the way back. */
  kicadAperture?: { id: string; pad: string };
}

/**
 * ComponentBodies6: a 3D body — an outline on a mechanical layer, extruded from `standoff` to
 * `overall` above the board (below it when `bottom`), or a STEP model placed over it.
 */
export interface PcbBody {
  kind: 'body'; src: Src; layer: LayerId; outline: Vec2[]; component: number; locked: boolean;
  standoff: Coord; overall: Coord; /** COLORREF 0x00BBGGRR */ colour: number; opacity: number; bottom: boolean;
  /** MODEL.MODELTYPE: 0 extruded, 1 generic (STEP), 2 cylinder, 3 sphere */
  modelType: number; identifier: string; modelName: string;
}

export type PcbPrim = PcbTrack | PcbArc | PcbVia | PcbPartVia | PcbPad | PcbFill | PcbText | PcbRegion | PcbBody;

export interface PcbComponent {
  index: number; designator: string; pattern: string; at: Vec2; rotation: number; layer: LayerId; bag: PropertyBag;
  nameOn: boolean; commentOn: boolean;
}
export interface PcbNet { index: number; name: string; bag: PropertyBag }

export interface PcbBoard {
  bag: PropertyBag | undefined;
  origin: Vec2;
  outline: Vec2[];          // closed polygon (arcs flattened) — display only
  /** The board shape as stored (Board6 KINDn / VXn …, arcs kept), without the closing copy. */
  vertices: PolyVertex[];
  copperStack: LayerId[];   // top → bottom
  layerNames: Map<LayerId, string>;
}

/** A primitive storage we decoded: its raw records are the save-time source of truth. */
export interface PrimStream { storage: string; records: PcbRawRecord[] }

/** One outline vertex; `arc` means the edge from here to the next vertex is an arc. */
export interface PolyVertex { p: Vec2; arc?: { c: Vec2; r: Coord; sa: number; ea: number } }

/** A polygon pour definition (Polygons6); its copper is the primitives whose `polygon` is this index. */
export interface PcbPolygon {
  index: number;
  bag: PropertyBag;
  name: string;
  layer: LayerId;
  net: number;
  vertices: PolyVertex[];
  /** Outline with arcs flattened, closed implicitly. */
  outline: Vec2[];
  /** Solid, 45Degree, 90Degree, Horizontal, Vertical, None. */
  hatch: string;
  /** Polygon (pour), or a cutout / split plane. */
  type: string;
}

import type { PcbDimension } from './dimensions';

export interface PcbDocument {
  kind: 'PcbDoc';
  name: string;
  cfb: CfbFile;
  board: PcbBoard;
  nets: PcbNet[];
  components: PcbComponent[];
  prims: PcbPrim[];
  streams: Map<string, PrimStream>;   // keyed by storage name (Tracks6 …)
  /** Storages whose Data must be re-serialised on save. */
  dirty: Set<string>;
  diags: Diagnostics;
  /** Design rules from Rules6 (Altium's defaults when the file has none — see rulesInFile). */
  rules: PcbRule[];
  rulesInFile: boolean;
  classes: PcbClass[];
  polygons: PcbPolygon[];
  /** ExtendedPrimitiveInformation / UniqueIDPrimitiveInformation entries no primitive could be found for. */
  side?: SideState;
  /** Dimensions6: Place › Dimension objects (model/dimensions). */
  dimensions: PcbDimension[];
  /** DifferentialPairs6: NAME, POSITIVENETNAME, NEGATIVENETNAME (model/diffPairs). */
  diffPairs?: PropertyBag[];
  /** UnionNames and SmartUnions (written back when 'UnionNames' / 'SmartUnions' are dirty). */
  unionNames?: { index: number; name: string }[];
  smartUnions?: string[];
  /** Rigid-flex: the regions, split lines and bending lines (BoardRegions; model/rigidFlex). Written back when 'BoardRegions' is dirty. */
  flex?: RigidFlex;
  /** Read from AD's ASCII PCB format: saved in it again. */
  ascii?: boolean;
  /** Design Rule Checker Options6: Rules To Check (Online, Batch) and the violation count DRC stops at (model/drcOptions). */
  drcOptions?: PropertyBag;
  /** WaivedViolations: violations waived in AD, left out of DRC (kept verbatim on save). */
  waivers?: Waiver[];
  /**
   * AD keeps every region twice: in Regions6 and again in ShapeBasedRegions6 (same order, with
   * its arcs). Konium works on the Regions6 one; its twin (Regions6 record → ShapeBasedRegions6
   * record) is written back as it was while the region is unchanged, else made again from it.
   */
  regionTwins?: Map<PcbRawRecord, PcbRawRecord>;
}

/**
 * The net copper belongs to. Pour copper (regions and hatch tracks of a polygon) may carry no net
 * of its own (65535, as AD17 boards keep it): it is the polygon's net, as AD connects it.
 */
/** Whether a primitive is a polygon pour's copper (its polygon index; 0xFFFE is AD's "board", not a pour). */
export const inPour = (p: PcbPrim): boolean => 'polygon' in p && p.polygon !== NO_NET && p.polygon !== 0xfffe;

export function copperNet(doc: PcbDocument, p: PcbPrim): number {
  if (!('net' in p)) return NO_NET;
  if (p.net !== NO_NET || !('polygon' in p) || p.polygon === NO_NET) return p.net;
  return (doc.polygons[p.polygon]?.index === p.polygon ? doc.polygons[p.polygon] : doc.polygons.find((x) => x.index === p.polygon))?.net ?? NO_NET;
}

export function netName(doc: PcbDocument, net: number): string {
  return net === NO_NET ? 'No net' : doc.nets[net]?.name ?? `Net ${net}`;
}
