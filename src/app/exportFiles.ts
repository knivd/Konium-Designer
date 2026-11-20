/**
 * Exporting to other tools' files: what Konium's Export Wizard does. The project as Konium has it
 * (open documents as they are now, the others as saved; a free document or library alone) goes
 * to the exporter (formats/exporters); the files are written into the chosen folder — in a
 * folder named after the project — or, with none, downloaded as a zip; the report goes to
 * Messages.
 */
import type { Exporter, ExportProject, ExportResult } from '../formats/exporters';
import { docBaseName, iniGet, projectParameters } from '../formats/altium/prjpcb';
import { load } from '../formats/registry';
import { readSchLib } from '../formats/altium/schlib';
import { zip } from '../formats/zip';
import { deriveSheet } from '../model/sch';
import { currentSymbols, type SchLibDocument } from '../model/schLib';
import { openPcbLib, type PcbLibDocument } from '../model/pcbLib';
import type { PcbDocument } from '../model/pcb';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { saveFileAs, writeInto } from '../platform/fs';
import { active, docs, log, notify, type Project } from './state';
import { projectSheets } from './project';
import { boardModels } from './dialogs/FabOutputs';
import { keptProjectFiles } from '../formats/kicad/project';

const stem = (n: string) => n.replace(/\.[^.]+$/, '');

/** The project's documents (or the active free document) as an exporter takes them. */
export async function projectForExport(p: Project | null, what: { sheets: boolean; board: boolean; libraries: boolean } = { sheets: true, board: true, libraries: true }): Promise<ExportProject | null> {
  const out: ExportProject = { name: '', sheets: [], schLibs: [], pcbLibs: [], hierarchyMode: 0, variables: [] };
  const schLib = (l: SchLibDocument) => { const s = deriveSheet(l.header); return { name: l.name, symbols: currentSymbols(l).map((x) => ({ libRef: x.libRef, bags: x.bags })), fonts: s.fonts, systemFont: s.systemFont }; };
  let boardDoc: { doc: PcbDocument; editor: PcbEditor | null } | null = null;
  if (p) {
    out.name = stem(p.name);
    out.hierarchyMode = Number(iniGet(p.prj, 'Design', 'HierarchyMode') ?? 0) || 0;
    out.channelFormat = iniGet(p.prj, 'Design', 'ChannelDesignatorFormatString') ?? undefined;
    out.channelSeparator = iniGet(p.prj, 'Design', 'ChannelRoomLevelSeperator') ?? undefined;
    out.variables = projectParameters(p.prj);
    out.kicad = keptProjectFiles((k) => iniGet(p.prj, 'KiCad', k));
    if (what.sheets) out.sheets = projectSheets(p);
    for (const path of p.prj.documents) {
      const name = docBaseName(path);
      const open = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
      const bytes = p.files.get(name.toLowerCase())?.bytes;
      try {
        if (/\.pcbdoc$/i.test(name) && what.board && !boardDoc) {
          if (open?.doc.kind === 'PcbDoc') boardDoc = { doc: open.doc as PcbDocument, editor: open.editor instanceof PcbEditor ? open.editor : null };
          else if (bytes) boardDoc = { doc: load(bytes, name) as PcbDocument, editor: null };
        } else if (/\.schlib$/i.test(name) && what.libraries) {
          if (open?.doc.kind === 'SchLib') out.schLibs.push(schLib(open.doc as SchLibDocument));
          else if (bytes) { const l = readSchLib(bytes, name); const s = deriveSheet(l.header); out.schLibs.push({ name, symbols: l.symbols.map((x) => ({ libRef: x.libRef, bags: x.bags })), fonts: s.fonts, systemFont: s.systemFont }); }
        } else if (/\.pcblib$/i.test(name) && what.libraries) {
          if (open?.doc.kind === 'PcbLib') out.pcbLibs.push(open.doc as PcbLibDocument);
          else if (bytes) out.pcbLibs.push(openPcbLib(bytes, name));
        }
      } catch (e) { log(name, [{ level: 'warn', message: `Not exported: ${(e as Error).message}` }], 'Export Wizard'); }
    }
  } else {
    const d = active.value;
    if (!d) return null;
    out.name = stem(d.name);
    if (d.doc.kind === 'SchDoc') out.sheets = projectSheets(null);
    else if (d.doc.kind === 'PcbDoc') boardDoc = { doc: d.doc as PcbDocument, editor: d.editor instanceof PcbEditor ? d.editor : null };
    else if (d.doc.kind === 'SchLib') out.schLibs.push(schLib(d.doc as SchLibDocument));
    else if (d.doc.kind === 'PcbLib') out.pcbLibs.push(d.doc as PcbLibDocument);
    else return null;
  }
  if (boardDoc) {
    out.board = boardDoc.doc;
    // Linked models: found where the board's editor looks (embedded ones the exporter reads itself)
    if (boardDoc.editor) out.models = await boardModels(boardDoc.editor).catch(() => undefined);
  }
  return out;
}

/** Run an exporter and deliver its files: into `outDir` (in the project's folder there), else a zip download. */
export async function exportAndSave(exporter: Exporter, project: ExportProject, outDir: FileSystemDirectoryHandle | null, progress?: (s: string) => void): Promise<ExportResult | null> {
  progress?.(`${project.name}: ${exporter.label}`);
  await new Promise((r) => setTimeout(r, 0));
  const r = exporter.run(project);
  for (const m of r.messages) log(m.source, [{ level: m.level, message: m.message }], 'Export Wizard');
  if (!r.files.length) { notify('Nothing to export', 'error'); return r; }
  if (outDir) {
    progress?.(`${project.name}: writing`);
    const dirs = new Map<string, FileSystemDirectoryHandle>([['', outDir]]);
    const dirFor = async (path: string): Promise<FileSystemDirectoryHandle> => {
      let d = dirs.get(path);
      if (d) return d;
      const i = path.lastIndexOf('/');
      const parent = await dirFor(i < 0 ? '' : path.slice(0, i));
      d = await parent.getDirectoryHandle(path.slice(i + 1), { create: true });
      dirs.set(path, d);
      return d;
    };
    for (const f of r.files) {
      const i = f.path.lastIndexOf('/');
      await writeInto(await dirFor(i < 0 ? '' : f.path.slice(0, i)), f.path.slice(i + 1), f.bytes);
    }
    notify(`${exporter.label}: ${r.files.length} files written to ${outDir.name}/${project.name}`);
  } else {
    const h = await saveFileAs(`${project.name} - ${exporter.label}.zip`, zip(r.files.map((f) => ({ name: f.path, bytes: f.bytes }))));
    if (h === null) return null;
    notify(`${exporter.label}: ${r.files.length} files in ${project.name} - ${exporter.label}.zip`);
  }
  return r;
}
