/**
 * The Import Wizard's file types (AD's Select Type of Files to Import): which files each takes,
 * what it lists of them to choose from, and the import itself — AD projects, documents and
 * libraries, and a report. File › Open and drops route files they recognise here too.
 */
import { addDocument, iniSet, newPrjPcb, writePrjPcb } from './altium/prjpcb';
import { importKicad, kicadContents, KICAD_FILE } from './kicad/project';
import { convertIpc2581, ipcFootprintLibrary } from './ipc2581read';
import { convertPadsLayout, isPadsLayout } from './pads/layout';
import { convertPadsLogic, isPadsLogic } from './pads/logic';
import { padsText } from './pads/ascii';
import { importEasyeda, listEasyeda, takesEasyeda } from './easyeda/import';
import { importCadence, listCadence, takesBrd, takesOrcad } from './cadenceImport';
import { importEagle, listEagle, takesEagle } from './eagle/import';
import { importDipTrace, listDipTrace, takesDipTrace } from './diptrace/import';
import { isProtelAscii } from './protel/pcbAscii';
import { convertProtelAscii } from './protel/convert';
import { importEdif, listEdif, takesEdif } from './edif/import';
import { vsdxToDiagram } from './vsdx';
import { isDrawio } from './drawio';
import { featureOn } from '../core/release';
import { breathe } from '../core/breathe';

export interface ImportFile { path: string; bytes: Uint8Array }
export interface ImportedDoc { name: string; bytes: Uint8Array }
export interface ImportedProject { name: string; prj: ImportedDoc; documents: ImportedDoc[] }
export interface ImportMessage { level: 'info' | 'warn' | 'error'; source: string; message: string }
export interface ImportResult { projects: ImportedProject[]; libraries: ImportedDoc[]; messages: ImportMessage[] }
export interface ImportOptions { only?: Set<string>; progress?: (step: string) => void; /** OrCAD: the part field a part's footprint comes from (Preferences › Schematic › Orcad), before PCB Footprint. */ orcadFootprintField?: string }
/** One thing to import, as the wizard lists it. */
export interface ImportItem { path: string; kind: string; note?: string }

export interface Importer {
  id: string;
  /** As the wizard's type list names it. */
  label: string;
  note: string;
  /** Extensions for the file selector. */
  exts: `.${string}`[];
  /** Whether a file is this type's (by name, then by its first bytes). */
  takes(name: string, head: string): boolean;
  /** What the files hold to import. */
  list(files: { path: string; bytes?: Uint8Array }[]): ImportItem[];
  run(files: ImportFile[], opts?: ImportOptions): Promise<ImportResult>;
  /** Offered only while this holds (a feature of a later release). */
  on?: () => boolean;
}

const td = new TextDecoder();
export const headOf = (b: Uint8Array): string => td.decode(b.subarray(0, 4096));
const stemOf = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '');
const yieldNow = breathe;

/** A board import's project: the PcbDoc and its PcbLib. */
export function boardProject(name: string, pcb: ImportedDoc, lib?: ImportedDoc): ImportedProject {
  const prj = newPrjPcb(`${name}.PrjPcb`);
  const documents = [pcb, ...(lib ? [lib] : [])];
  for (const d of documents) addDocument(prj, d.name);
  return { name, prj: { name: `${name}.PrjPcb`, bytes: writePrjPcb(prj) }, documents };
}

const kicad: Importer = {
  id: 'kicad', label: 'KiCad Design Files and Libraries',
  note: 'KiCad 6 and later: projects (.kicad_pro with their schematics and board), symbol libraries (.kicad_sym), footprint libraries (.pretty folders). Add Folder takes a project\'s folder with its sheets.',
  exts: ['.kicad_pro', '.kicad_sch', '.kicad_pcb', '.kicad_sym', '.kicad_mod', '.kicad_dru', '.kicad_prl'],
  takes: (name) => KICAD_FILE.test(name),
  list(files) {
    const c = kicadContents(files);
    const have = new Set(files.map((f) => f.path.replace(/\\/g, '/').toLowerCase()));
    const lone = (p: string) => !['.kicad_sch', '.kicad_pcb'].some((e) => have.has(p.replace(/\.kicad_pro$/i, e).toLowerCase()));
    return [
      ...c.projects.map((p) => ({ path: p, kind: 'Project', note: lone(p) ? 'its schematic and board are missing: Add Folder' : undefined })), ...c.schematics.map((p) => ({ path: p, kind: 'Schematic' })),
      ...c.boards.filter((b) => !c.schematics.includes(b.replace(/\.kicad_pcb$/i, '.kicad_sch'))).map((p) => ({ path: p, kind: 'PCB' })),
      ...c.symbolLibs.map((p) => ({ path: p, kind: 'Symbol library' })), ...c.footprintLibs.map((p) => ({ path: p, kind: 'Footprint library' })),
    ];
  },
  run: (files, opts) => importKicad(files, opts),
};

const ipc: Importer = {
  id: 'ipc2581', label: 'IPC-2581 Files',
  note: 'IPC-2581 (revisions A to C) from Allegro, OrCAD PCB, PADS, Xpedition, Zuken, KiCad and others: the board — layers and stack-up, components, nets, pads, vias, tracks, copper — and its footprints. No design rules or pour settings travel in IPC-2581.',
  exts: ['.xml', '.cvg'],
  takes: (name, head) => /\.cvg$/i.test(name) || (/\.xml$/i.test(name) && /<IPC-2581\b/.test(head)),
  list: (files) => files.filter((f) => /\.cvg$/i.test(f.path) || (f.bytes ? /<IPC-2581\b/.test(headOf(f.bytes)) : /\.xml$/i.test(f.path))).map((f) => ({ path: f.path, kind: 'Board' })),
  async run(files, opts = {}) {
    const out: ImportResult = { projects: [], libraries: [], messages: [] };
    for (const f of files) {
      if (opts.only && !opts.only.has(f.path)) continue;
      if (!/<IPC-2581\b/.test(headOf(f.bytes))) continue;
      opts.progress?.(`${stemOf(f.path)}: board`);
      await yieldNow();
      try {
        const r = convertIpc2581(td.decode(f.bytes), f.path.split('/').pop() ?? f.path);
        out.projects.push(boardProject(r.name, { name: `${r.name}.PcbDoc`, bytes: r.bytes }, r.footprints.length ? { name: `${r.name}.PcbLib`, bytes: ipcFootprintLibrary(r.footprints, `${r.name}.PcbLib`) } : undefined));
        out.messages.push({ level: 'info', source: r.name, message: `Board: ${r.stats.layers} copper layers, ${r.stats.components} components, ${r.stats.pads} pads, ${r.stats.vias} vias, ${r.stats.tracks} tracks and arcs, ${r.stats.nets} nets; ${r.footprints.length} footprints` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: r.name, message: w });
      } catch (e) { out.messages.push({ level: 'error', source: stemOf(f.path), message: `Not imported: ${(e as Error).message}` }); }
    }
    return out;
  },
};

/** PADS's ASCII files: Logic's schematics (*PADS-LOGIC…, .txt) and Layout's boards (!PADS-POWERPCB…, .asc). */
const padsKind = (head: string): 'logic' | 'layout' | null => (isPadsLogic(head) ? 'logic' : isPadsLayout(head) ? 'layout' : null);
const pads: Importer = {
  id: 'pads', label: 'PADS ASCII Design Files',
  note: 'PADS Logic and PADS Layout ASCII exports (PADS 2005 to VX, and PowerLogic and PowerPCB before them): schematics (.txt) with their part types as a schematic library, boards (.asc) with their decals as a PCB library. A schematic and a board of the same name are one project.',
  exts: ['.asc', '.txt'],
  takes: (name, head) => /\.(asc|txt)$/i.test(name) && !!padsKind(head),
  list: (files) => files.flatMap((f) => {
    const k = f.bytes ? padsKind(headOf(f.bytes)) : /\.asc$/i.test(f.path) ? 'layout' : null;
    return k ? [{ path: f.path, kind: k === 'logic' ? 'Schematic' : 'PCB' }] : [];
  }),
  async run(files, opts = {}) {
    const out: ImportResult = { projects: [], libraries: [], messages: [] };
    // A schematic and a board of one name (in one folder): one project
    const groups = new Map<string, { name: string; logic?: ImportFile; layout?: ImportFile }>();
    for (const f of files) {
      if (opts.only && !opts.only.has(f.path)) continue;
      const k = padsKind(headOf(f.bytes));
      if (!k) continue;
      const key = f.path.replace(/\\/g, '/').replace(/\.[^./]+$/, '').toLowerCase();
      const g = groups.get(key) ?? { name: stemOf(f.path) };
      g[k] = f;
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const documents: ImportedDoc[] = [];
      const prj = newPrjPcb(`${g.name}.PrjPcb`);
      try {
        if (g.logic) {
          opts.progress?.(`${g.name}: schematics`);
          await yieldNow();
          const r = convertPadsLogic(padsText(g.logic.bytes), `${g.name}.txt`, g.layout ? `${g.name}.PcbLib` : '', g.logic.bytes);
          documents.push(...r.sheets, { name: `${g.name}.SchLib`, bytes: r.library });
          // PADS joins nets by name across its sheets
          iniSet(prj, 'Design', 'HierarchyMode', '3');
          out.messages.push({ level: 'info', source: g.name, message: `Schematics: ${r.stats.sheets} sheet${r.stats.sheets === 1 ? '' : 's'}, ${r.stats.parts} parts, ${r.stats.nets} named nets; ${r.stats.symbols} symbols` });
          for (const w of r.warnings) out.messages.push({ level: 'warn', source: g.name, message: w });
        }
        if (g.layout) {
          opts.progress?.(`${g.name}: board`);
          await yieldNow();
          const r = convertPadsLayout(padsText(g.layout.bytes), `${g.name}.asc`, g.layout.bytes);
          documents.push({ name: `${g.name}.PcbDoc`, bytes: r.bytes });
          if (r.footprints.length) documents.push({ name: `${g.name}.PcbLib`, bytes: ipcFootprintLibrary(r.footprints, `${g.name}.PcbLib`) });
          out.messages.push({ level: 'info', source: g.name, message: `Board: ${r.stats.layers} copper layers, ${r.stats.components} components, ${r.stats.pads} pads, ${r.stats.vias} vias, ${r.stats.tracks} tracks and arcs, ${r.stats.nets} nets; ${r.footprints.length} decals` });
          for (const w of r.warnings) out.messages.push({ level: 'warn', source: g.name, message: w });
        }
        for (const d of documents) addDocument(prj, d.name);
        out.projects.push({ name: g.name, prj: { name: `${g.name}.PrjPcb`, bytes: writePrjPcb(prj) }, documents });
      } catch (e) { out.messages.push({ level: 'error', source: g.name, message: `Not imported: ${(e as Error).message}` }); }
    }
    return out;
  },
};

/** EasyEDA's Standard JSON documents and backups, and Pro's projects and libraries. */
const easyeda: Importer = {
  id: 'easyeda', label: 'EasyEDA Design Files and Libraries',
  note: 'EasyEDA Standard: schematics and boards (.json, as File › Export › EasyEDA saves them) and project backups (.zip). EasyEDA Pro: projects (.epro, .epro2, a project\'s .zip), each board — its schematic and its PCB — a project, and libraries (.elibz, .elibz2) and lone footprints and symbols (.efoo, .esym).',
  exts: ['.json', '.zip', '.epro', '.epro2', '.elibz', '.elibz2', '.efoo', '.esym'],
  takes: takesEasyeda,
  list: listEasyeda,
  run: importEasyeda,
};

/** OrCAD Capture's designs and libraries, with Allegro boards of the same name (dropped together: one project). */
const orcad: Importer = {
  id: 'orcad', label: 'OrCAD Designs and Libraries Files',
  note: 'OrCAD Capture designs (.dsn, 16.0 and later; flat and hierarchical) as schematics with their parts as a schematic library, and Capture libraries (.olb). An Allegro or OrCAD PCB Editor board (.brd) of the design\'s name — or the only board added with the only design — is the design\'s PCB, in one project.',
  exts: ['.dsn', '.olb', '.brd'],
  takes: (name, head) => takesOrcad(name, head) || takesBrd(name, head),
  list: (files) => listCadence(files),
  run: importCadence,
};
const allegro: Importer = {
  id: 'allegro', label: 'Allegro Design Files',
  note: 'Allegro and OrCAD PCB Editor boards (.brd, 16.0 to 19): layers, components with their padstacks, nets, tracks, vias, dynamic shapes as polygon pours with their copper, keep-outs, drawings and text, the physical constraint sets as rules; the symbols as a PCB library. Older boards: save them again in 16.0 or later, or export IPC-2581.',
  exts: ['.brd'],
  takes: takesBrd,
  list: (files) => listCadence(files),
  run: importCadence,
};

const eagle: Importer = {
  id: 'eagle', label: 'EAGLE Design Files and Libraries',
  note: 'EAGLE 6 and later, and Fusion Electronics\' EAGLE files: schematics (.sch), boards (.brd) and libraries (.lbr). A schematic and a board of one name are one project: its sheets with the SchLib of its devices, the board with the PcbLib of its packages, pads sized by the board\'s design rules, polygons poured. Exported back to EAGLE unchanged, they are the files EAGLE wrote. EAGLE 5 and earlier saved binary files: save them again in EAGLE 6 or later.',
  exts: ['.sch', '.brd', '.lbr'],
  takes: takesEagle,
  list: (files) => listEagle(files),
  run: importEagle,
};

const diptrace: Importer = {
  id: 'diptrace', label: 'DipTrace XML Files',
  note: 'DipTrace\'s XML files (File › Export › DipTrace XML in Schematic Capture and PCB Layout, Library › Export › DipXML in its library editors): schematics (.dchxml), boards (.dipxml), component libraries (.elixml) and pattern libraries. A schematic and a board of one name are one project: its sheets with the SchLib of its components, the board with the PcbLib of its patterns, copper pours poured. Exported back to DipTrace unchanged, they are the files DipTrace wrote. DipTrace\'s own binary files (.dch, .dip, .eli): export them as DipTrace XML first.',
  exts: ['.dchxml', '.dipxml', '.elixml', '.libxml', '.dch', '.dip', '.eli'],
  takes: takesDipTrace,
  list: (files) => listDipTrace(files),
  run: importDipTrace,
};

const edif: Importer = {
  id: 'edif', label: 'EDIF Files',
  note: 'EDIF 2 0 0 schematics and netlists (.edf, .edn, .edif, .eds; told by their content under any name) from OrCAD, Mentor, Cadence, FPGA tools and others: the pages as SchDocs with the SchLib of their cells, parts placed and turned as drawn, nets as their wires with their names; a pin EDIF joins to a net that no wire reaches gets a net label of it. A netlist with no drawings: its parts as boxes in rows, each pin\'s net named at it.',
  exts: ['.edf', '.edn', '.edif', '.eds'],
  takes: takesEdif,
  list: (files) => listEdif(files),
  run: importEdif,
};

/** Diagrams from other tools: .drawio files (the same XML as Konium's own) and Visio drawings, each a .DgmDoc. */
const diagram: Importer = {
  id: 'diagram', label: 'Diagram Files',
  note: 'Diagrams from other tools as Konium Designer diagrams (.DgmDoc): .drawio files as they are (every page, shape and connector), and Visio drawings (.vsdx): their pages, shapes (rectangles and ellipses as such, any other outline as a drawing of its own), groups, connectors glued to their shapes, text, fill and line.',
  exts: ['.drawio', '.vsdx'],
  on: () => featureOn('diagrams'),
  takes: (name) => /\.(drawio|vsdx)$/i.test(name),
  list: (files) => files.filter((f) => /\.(drawio|vsdx)$/i.test(f.path)).map((f) => ({ path: f.path, kind: 'Diagram' })),
  run: async (files) => {
    const r: ImportResult = { projects: [], libraries: [], messages: [] };
    for (const f of files) {
      const base = f.path.split('/').pop()!.replace(/\.[^.]+$/, '');
      try {
        if (/\.vsdx$/i.test(f.path)) {
          const { xml, notes } = vsdxToDiagram(f.bytes);
          r.libraries.push({ name: `${base}.DgmDoc`, bytes: new TextEncoder().encode(xml) });
          for (const n of notes) r.messages.push({ level: 'warn', source: f.path, message: n });
        } else if (isDrawio(f.bytes)) r.libraries.push({ name: `${base}.DgmDoc`, bytes: f.bytes });
        else r.messages.push({ level: 'error', source: f.path, message: 'Not a diagram file' });
      } catch (e) { r.messages.push({ level: 'error', source: f.path, message: (e as Error).message }); }
    }
    return r;
  },
};

/** Boards in the text format of the 1990s' programs (PCB FILE 6: saved today as PCB 2.8 ASCII). */
const pcb28: Importer = {
  id: 'pcb28', label: 'PCB 2.8 ASCII Files',
  note: 'Boards in the text format the programs of the 1990s wrote and the desktop software still saves as PCB 2.8 ASCII (.pcb, first line PCB FILE 6): the components with their pads, outlines and strings, the tracks, arcs, fills, vias and nets. The file says no shape for the board: it is the closed outline drawn on the keep-out layer, or on Mechanical 1.',
  exts: ['.pcb'],
  takes: (_name, head) => isProtelAscii(head),
  list: (files) => files.flatMap((f) => (!f.bytes || isProtelAscii(headOf(f.bytes)) ? [{ path: f.path, kind: 'PCB' }] : [])),
  async run(files, opts = {}) {
    const out: ImportResult = { projects: [], libraries: [], messages: [] };
    for (const f of files) {
      if ((opts.only && !opts.only.has(f.path)) || !isProtelAscii(headOf(f.bytes))) continue;
      const name = stemOf(f.path);
      try {
        opts.progress?.(`${name}: board`);
        await yieldNow();
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(f.bytes); } catch { text = new TextDecoder('windows-1252').decode(f.bytes); }
        const r = convertProtelAscii(text, `${name}.pcb`);
        out.projects.push(boardProject(name, { name: `${name}.PcbDoc`, bytes: r.bytes }));
        for (const m of r.messages) out.messages.push({ level: m.level, source: name, message: m.message });
      } catch (e) { out.messages.push({ level: 'error', source: name, message: `Not imported: ${(e as Error).message}` }); }
    }
    return out;
  },
};

export const IMPORTERS: Importer[] = [kicad, ipc, pads, easyeda, orcad, allegro, eagle, diptrace, edif, pcb28, diagram];
/** The importers offered now. */
export const importersOn = () => IMPORTERS.filter((i) => !i.on || i.on());
export const importerFor = (name: string, bytes: Uint8Array): Importer | undefined => { const head = headOf(bytes); return importersOn().find((i) => i.takes(name, head)); };
/** Every extension an importer takes (for File › Open's selector). */
export const IMPORT_EXTS = [...new Set(IMPORTERS.flatMap((i) => i.exts))];
