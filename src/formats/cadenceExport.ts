/**
 * A project for OrCAD and Allegro: AD's own ASCII files, which Cadence's translators for AD designs
 * read (OrCAD X Capture's schematic translator takes the project file; PCB Editor's board
 * translator the board): the project file, its structure file (the sheet tree, as compiling
 * writes it), every schematic in AD's ASCII schematic format and the board in AD's ASCII PCB
 * format. The libraries aren't needed: Capture makes its parts from the schematics' symbols and
 * PCB Editor its footprints from the board's components. A design or board read from Cadence's own
 * files and unchanged goes back as those files, as Capture and Allegro wrote them (R11:
 * cadenceKept.ts); the ASCII files are written for the rest.
 */
import type { ExportProject, ExportResult } from './exporters';
import type { ImportMessage } from './importers';
import { addDocument, iniSet, newPrjPcb, setProjectParameters, writePrjPcb } from './altium/prjpcb';
import { writeSchAscii } from './altium/schdoc';
import { writePcbAscii } from './altium/pcbAscii';
import { sheetHierarchy, type HierNode } from '../model/schHierarchy';
import { binToBytes } from './text';
import type { SheetInput } from '../model/compile';
import { keptBrd, keptDsn } from './cadenceKept';

/** The .PrjPcbStructure AD writes on compiling: each top sheet, then each sheet symbol with the sheet it stands for. */
export function prjPcbStructure(sheets: readonly SheetInput[]): Uint8Array {
  const h = sheetHierarchy(sheets, 'documents');
  const lines: string[] = [];
  let n = 0;
  // Level by level, as AD lists them
  let level: HierNode[] = h.roots;
  while (level.length) {
    const next: HierNode[] = [];
    for (const node of level) {
      n++;
      const v = node.via;
      lines.push(v
        ? `Record=SheetSymbol|SourceDocument=${v.sheet}|Designator=${v.designator}|SchDesignator=${v.designator}|FileName=${node.sheet}|SheetNumber=${n}|SymbolType=Normal|RawFileName=${v.fileName || node.sheet}|DesignItemId= |SourceLibraryName= |ObjectKind=Sheet Symbol|RevisionGUID= |ItemGUID= |VaultGUID= `
        : `Record=TopLevelDocument|FileName=${node.sheet}|SheetNumber=${n}`);
      next.push(...node.children);
    }
    level = next;
  }
  return binToBytes(lines.join('\r\n') + '\r\n');
}

export function exportCadence(p: ExportProject): ExportResult {
  const name = p.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Project';
  const files: ExportResult['files'] = [];
  const messages: ImportMessage[] = [];
  const info = (message: string) => messages.push({ level: 'info', source: name, message });
  const warn = (source: string, message: string) => messages.push({ level: 'warn', source, message });
  const prj = newPrjPcb(`${name}.PrjPcb`);
  iniSet(prj, 'Design', 'HierarchyMode', String(p.hierarchyMode));
  if (p.channelFormat) iniSet(prj, 'Design', 'ChannelDesignatorFormatString', p.channelFormat);
  if (p.channelSeparator) iniSet(prj, 'Design', 'ChannelRoomLevelSeperator', p.channelSeparator);
  // A design and a board read from Cadence's files and unchanged: those files, as Capture and Allegro wrote them (cadenceKept.ts)
  const dsn = p.sheets.length ? keptDsn(p.sheets.map((s) => s.doc)) : null;
  const brd = p.board ? keptBrd(p.board) : null;
  if (dsn) { files.push({ path: `${name}/${dsn.file}`, bytes: dsn.bytes }); info(`The design as it was read from OrCAD Capture, unchanged: ${dsn.file} as Capture wrote it`); }
  if (brd) { files.push({ path: `${name}/${brd.file}`, bytes: brd.bytes }); info(`The board as it was read from Allegro, unchanged: ${brd.file} as Allegro wrote it`); }
  const sheets = dsn ? [] : p.sheets;
  let images = 0;
  for (const s of sheets) {
    const r = writeSchAscii(s.doc);
    files.push({ path: `${name}/${s.name}`, bytes: r.bytes });
    addDocument(prj, s.name);
    images += r.warnings.length;
  }
  if (images) warn('Schematics', `${images} sheet${images === 1 ? '' : 's'} with embedded images: the ASCII schematics don't carry them (they keep their file names)`);
  const ascBoard = p.board && !brd ? p.board : undefined;
  if (ascBoard) {
    const r = writePcbAscii(ascBoard);
    const board = /\.pcbdoc$/i.test(ascBoard.name) ? ascBoard.name : `${name}.PcbDoc`;
    files.push({ path: `${name}/${board}`, bytes: r.bytes });
    addDocument(prj, board);
    for (const w of [...new Set(r.warnings)]) warn('PCB', w);
  }
  if (p.variables.length) setProjectParameters(prj, p.variables);
  if (sheets.length || ascBoard) files.unshift({ path: `${name}/${name}.PrjPcb`, bytes: writePrjPcb(prj) }, { path: `${name}/${name}.PrjPcbStructure`, bytes: prjPcbStructure(sheets) });
  if (!p.sheets.length && !p.board) messages.push({ level: 'error', source: name, message: 'Nothing to export: no schematics or board' });
  else if (sheets.length || ascBoard) {
    info(`${sheets.length ? `${sheets.length} schematic${sheets.length === 1 ? '' : 's'}` : ''}${sheets.length && ascBoard ? ' and ' : ''}${ascBoard ? 'the board' : ''} in the ASCII formats, with the project and its structure file`);
    if (sheets.length) info('OrCAD Capture (17.2 and later): File › Import › the translator for ASCII schematics, from the .PrjPcb, into a folder for the design');
    if (ascBoard) info(`PCB Editor: the netlist from ${dsn ? dsn.file : 'that design'} first (Capture: Tools › Create Netlist), then File › Import › the translator for ASCII boards, from this folder`);
  }
  return { files, messages };
}
