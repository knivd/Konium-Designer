/**
 * A project as EasyEDA Standard's source files: its schematics as one schematic document
 * (SCH_<name>.json, a sheet per SchDoc) and its board as a PCB document (PCB_<name>.json) —
 * what EasyEDA Standard opens (File › Open › EasyEDA Source) and EasyEDA Pro imports; the
 * schematic's parts and the board's footprints share their ids, as EasyEDA links them.
 */
import type { ExportProject, ExportResult } from '../exporters';
import type { ImportMessage } from '../importers';
import { exportEasyedaPcb } from './writeStdPcb';
import { exportEasyedaSch } from './writeStdSch';

export function exportEasyeda(p: ExportProject): ExportResult {
  const name = (p.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Project');
  const files: ExportResult['files'] = [];
  const messages: ImportMessage[] = [];
  const info = (message: string) => messages.push({ level: 'info', source: name, message });
  const warn = (list: string[], source: string) => { for (const message of list) messages.push({ level: 'warn', source, message }); };
  let ids: Map<string, string> | undefined;
  if (p.sheets.length) {
    const r = exportEasyedaSch({ name, sheets: p.sheets, hierarchyMode: p.hierarchyMode, channelFormat: p.channelFormat, channelSeparator: p.channelSeparator, variables: p.variables });
    files.push({ path: `${name}/SCH_${name}.json`, bytes: r.bytes });
    ids = r.ids;
    info(`Schematic: ${r.stats.sheets} sheet${r.stats.sheets === 1 ? '' : 's'}, ${r.stats.parts} parts, ${r.stats.nets} nets`);
    warn(r.warnings, 'Schematics');
  }
  if (p.board) {
    const r = exportEasyedaPcb(p.board, name, ids);
    files.push({ path: `${name}/PCB_${name}.json`, bytes: r.bytes });
    info(`PCB: ${r.stats.layers} copper layers, ${r.stats.components} components, ${r.stats.nets} nets`);
    warn(r.warnings, 'PCB');
  }
  if (p.schLibs.length || p.pcbLibs.length) info('Libraries aren\'t written on their own: the symbols and footprints the design uses are in its files');
  if (!files.length) messages.push({ level: 'error', source: name, message: 'Nothing to export: no schematics or board' });
  return { files, messages };
}
