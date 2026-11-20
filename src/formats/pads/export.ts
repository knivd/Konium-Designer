/**
 * A project as PADS's ASCII files: its schematics as one PADS Logic file (.txt), its board as a
 * PADS Layout file (.asc), both named after the project — what PADS Logic and PADS Layout import
 * (File › Import), the board's parts on the schematic's part types' decals by name.
 */
import type { ExportProject, ExportResult } from '../exporters';
import type { ImportMessage } from '../importers';
import { exportPadsLogic } from './writeLogic';
import { exportPadsLayout } from './writeLayout';

export function exportPads(p: ExportProject): ExportResult {
  const name = (p.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Project');
  const files: ExportResult['files'] = [];
  const messages: ImportMessage[] = [];
  const info = (message: string) => messages.push({ level: 'info', source: name, message });
  const warn = (list: string[], source: string) => { for (const message of list) messages.push({ level: 'warn', source, message }); };
  if (p.sheets.length) {
    const r = exportPadsLogic({ name, sheets: p.sheets, hierarchyMode: p.hierarchyMode, channelFormat: p.channelFormat, channelSeparator: p.channelSeparator, variables: p.variables });
    files.push({ path: `${name}/${name}.txt`, bytes: r.bytes });
    info(r.kept ? 'PADS Logic: the design as it was read from PADS Logic, unchanged: written back as PADS wrote it' : `PADS Logic: ${r.stats.sheets} sheet${r.stats.sheets === 1 ? '' : 's'}, ${r.stats.parts} parts of ${r.stats.partTypes} part types, ${r.stats.nets} nets`);
    warn(r.warnings, 'Schematics');
  }
  if (p.board) {
    const r = exportPadsLayout(p.board, name);
    files.push({ path: `${name}/${name}.asc`, bytes: r.bytes });
    const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
    info(r.spliced ? `PADS Layout: the board as it was read from PADS but for ${[n(r.spliced.moved, 'part moved', 'parts moved'), n(r.spliced.rerouted, 'net rerouted', 'nets rerouted'), ...(r.spliced.objects ? [n(r.spliced.objects, 'text, drawing or pour changed, added or taken away', 'texts, drawings and pours changed, added or taken away')] : [])].join(', ')}: those written as Konium has them`
      : r.kept ? 'PADS Layout: the board as it was read from PADS, unchanged: written back as PADS wrote it' : `PADS Layout: ${p.board.components.length} components, ${p.board.nets.length} nets`);
    warn(r.warnings, 'PCB');
  }
  if (p.schLibs.length || p.pcbLibs.length) info('Libraries aren\'t written on their own: the part types and decals the design uses are in its files');
  if (!files.length) messages.push({ level: 'error', source: name, message: 'Nothing to export: no schematics or board' });
  return { files, messages };
}
