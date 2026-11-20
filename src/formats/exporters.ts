/**
 * Konium's Export Wizard's file types: a project (or a document, or a library) written as another
 * tool's files. Each takes the project as Konium has it — its sheets, board, libraries, options —
 * and gives back the files (paths under one folder named after the project) and a report.
 */
import type { SheetInput } from '../model/compile';
import type { PcbDocument } from '../model/pcb';
import type { PcbLibDocument } from '../model/pcbLib';
import type { SchFont } from '../model/sch';
import type { PropertyBag } from './altium/props';
import type { ModelFiles } from '../render/gl3d/stepBodies';
import type { ImportMessage } from './importers';
import { exportKicad } from './kicad/export';
import { exportPads } from './pads/export';
import { exportEasyeda } from './easyeda/export';
import { exportEasyedaPro } from './easyeda/writePro';
import { exportCadence } from './cadenceExport';
import { exportEagle } from './eagle/write';
import { exportEdif } from './edif/write';
import { exportDipTrace } from './diptrace/write';
import { exportSpecctra } from './specctra/dsn';

export interface ExportProject {
  name: string;
  sheets: SheetInput[];
  board?: PcbDocument;
  schLibs: { name: string; symbols: { libRef: string; bags: PropertyBag[] }[]; fonts: SchFont[]; systemFont: number }[];
  pcbLibs: PcbLibDocument[];
  /** Project Options: Net Identifier Scope (HierarchyMode), the channels' designator format and separator. */
  hierarchyMode: number;
  channelFormat?: string;
  channelSeparator?: string;
  /** Project parameters. */
  variables: { name: string; value: string }[];
  /** The board's linked models Konium found. */
  models?: ModelFiles;
  /** KiCad's project files kept from an import (its settings, custom rules, local settings). */
  kicad?: { pro?: string; dru?: string; prl?: string };
}
export interface ExportResult { files: { path: string; bytes: Uint8Array }[]; messages: ImportMessage[] }

export interface Exporter {
  id: string;
  /** As the wizard's type list names it. */
  label: string;
  note: string;
  run(p: ExportProject): ExportResult;
}

const kicad: Exporter = {
  id: 'kicad', label: 'KiCad Project',
  note: 'KiCad 8 files (KiCad 8 and later open them): the project (.kicad_pro with the net classes and design rules), the schematics, the board, a symbol library of the symbols placed and one per schematic library, a footprint library (.pretty) of the board\'s footprints and the PCB libraries\', the library tables and the 3D models the board uses. Harnesses, directives, images, extruded 3D bodies and dimensions have no KiCad counterpart and are left out (the report lists what was).',
  run: (p) => exportKicad(p),
};

const pads: Exporter = {
  id: 'pads', label: 'PADS ASCII Design Files',
  note: 'PADS Logic and PADS Layout ASCII files (PADS 9.x and later import them): the schematics as one design (.txt) — part types with a gate per part, nets by their names, power ports as power and ground symbols, ports and off-sheet connectors as off-page references — and the board (.asc): layers and stack-up, decals, routes, pours, keep-outs, design rules. A multi-channel sheet is written once for each channel; harnesses, images and directives have no PADS counterpart and are left out (the report lists what was).',
  run: (p) => exportPads(p),
};

const easyeda: Exporter = {
  id: 'easyeda', label: 'EasyEDA Source Files',
  note: 'EasyEDA Standard source files (.json; EasyEDA Standard opens them with File › Open › EasyEDA Source, EasyEDA Pro imports them): the schematics as one schematic — parts with their symbols as placed, every net named as the project compiles it (EasyEDA joins nets by name), power ports as power and ground flags, ports and sheet entries as net ports — and the board: layers, footprints, pads, tracks, vias, copper, pours, text, design rules. A multi-channel sheet is written once for each channel; internal planes become copper areas on inner layers; harnesses, images and directives have no EasyEDA counterpart and are left out (the report lists what was).',
  run: (p) => exportEasyeda(p),
};

const easyedaPro: Exporter = {
  id: 'easyedapro', label: 'EasyEDA Pro Project',
  note: 'An EasyEDA Pro project (.epro, the project file EasyEDA Pro imports with File › Import › EasyEDA Professional): the schematic (a page for each sheet), the board, and the symbols, footprints and devices they use. Parts are placed with their designators, comments and parameters and a Unique ID the board\'s part shares; every wire carries its net\'s name as the project compiles it (EasyEDA joins a name\'s wires across the pages); power ports are net flags, and ports, sheet entries and off-sheet connectors net ports of their nets. The board: copper layers and stack-up, outline and cut-outs, footprints with their pads, parts, tracks and arcs, vias, fills, keep-out regions, polygon pours with their poured copper, internal planes as pours, text, the design rules. A multi-channel sheet is written once for each channel; harnesses, images and directives have no EasyEDA counterpart and are left out (the report lists what was).',
  run: (p) => exportEasyedaPro(p),
};

const cadence: Exporter = {
  id: 'cadence', label: 'OrCAD and Allegro (ASCII Files)',
  note: 'The project in the ASCII formats Cadence\'s translators read (OrCAD Capture and PCB Editor 17.2 and later, File › Import): the project file and its structure file (the sheet tree), every schematic as an ASCII schematic and the board as an ASCII PCB file. Capture makes its parts from the schematics, PCB Editor its footprints from the board. Embedded images and embedded 3D models aren\'t carried by the ASCII formats (the report says where there were any).',
  run: (p) => exportCadence(p),
};

const eagle: Exporter = {
  id: 'eagle', label: 'EAGLE Design Files',
  note: 'EAGLE 9 XML files (EAGLE 9 and Fusion Electronics open them): the schematic (.sch) and the board (.brd) of one name, so EAGLE pairs them, and a library (.lbr) of the devices and packages they use. Parts are devices — each library reference a device set, its parts gates, each footprint a package — with every pin connected to its pads; power ports supply symbols; every net named as the project compiles it (EAGLE joins nets by name); ports, sheet entries and off-sheet connectors cross-reference labels. The board: copper layers, outline and cut-outs, elements, tracks, vias, polygon pours (EAGLE pours them), keep-outs as restrict layers, slots as milling, the design rules. A schematic or board read from EAGLE and unchanged is written as EAGLE wrote it; a board changed only by parts moved and nets rerouted is EAGLE\'s file with those changes in it. A multi-channel sheet is written once for each channel; harnesses, images and directives have no EAGLE counterpart and are left out (the report lists what was).',
  run: (p) => exportEagle(p),
};

const diptrace: Exporter = {
  id: 'diptrace', label: 'DipTrace XML Files',
  note: 'DipTrace XML files (DipTrace opens them with File › Import › DipTrace XML in Schematic Capture and PCB Layout, and Library › Import › DipXML in its library editors): the schematic (.dchxml), the board (.dipxml) and a component library (.elixml) of what they use. Parts are components — each library reference a component, its parts sections, each pin bound to the pad of its designator in the footprint\'s pattern; power ports and ports net ports; every net named as the project compiles it, with its pins (DipTrace\'s nets are design-wide). The board: copper layers with planes, outline and cut-outs, patterns with their pad styles, components, the nets\' copper as traces from pad to pad with their vias, polygon pours as copper pours, keep-outs, text, net classes and rules. A board or schematic read from DipTrace and still unchanged is written as DipTrace wrote it. Harnesses, images and directives have no DipTrace counterpart and are left out (the report lists what was).',
  run: (p) => exportDipTrace(p),
};

const specctra: Exporter = {
  id: 'specctra', label: 'Specctra Design (Autorouter)',
  note: 'The board as a Specctra design (.dsn), the file autorouters read (Freerouting opens it with File › Open...): the copper layers (internal planes as power layers with their nets\' planes), the board\'s shape as its boundary, cut-outs and keep-outs as keep-outs, each footprint once as an image with its pins and padstacks, the parts placed on them (bottom ones on the back), every net with its pins, the vias the routes may take, the track width and clearance rules, and the routes the board has (locked ones protected). Polygon pours aren\'t written: bring the router\'s session back with Route › Auto Route › Import Specctra Session... and the pours are poured again round its routes.',
  run: (p) => exportSpecctra(p),
};

const edif: Exporter = {
  id: 'edif', label: 'EDIF Schematic',
  note: 'The schematics as one EDIF 2 0 0 file (.edf), for the tools that read EDIF schematics: a library of the symbols placed (each part of a multi-part symbol a cell of its own, its pins ports with their numbers and directions), the power port symbols, a library for each of the project\'s schematic libraries, and the design — a page for each sheet (each channel of a multi-channel sheet, with its designators and nets), parts turned and mirrored as placed with their designators, comments, footprints and parameters, every net by the name the project compiles it to (EDIF joins a name\'s nets across the pages), drawn as wired, with its labels, power ports, ports and off-sheet connectors. Sheet symbols, bus entries, drawings and texts are comment graphics; harnesses, images, IEEE symbols and directives are left out (the report lists what was). The board has no place in an EDIF schematic.',
  run: (p) => exportEdif(p),
};

export const EXPORTERS: Exporter[] = [kicad, pads, easyeda, easyedaPro, cadence, eagle, diptrace, specctra, edif];
