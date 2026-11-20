/**
 * Preferences › PCB Editor › Reports: after Netlist Status, Board Information, a BGA fanout,
 * Move Component Origin To Grid and the Stackup Compatibility Report, the report is shown,
 * generated (written with the project's outputs, as text or HTML), or both.
 */
import { settings } from '../core/settings';
import { reportHtml } from '../core/reportHtml';
import type { PcbEditor } from '../editors/pcb/PcbEditor';
import { showDialog } from './dialogs';
import { ReportDialog } from './dialogs/Hierarchy';
import { deliverOutputs } from './dialogs/Outputs';
import { docs, notify, projects, type Project } from './state';

export type ReportKind = 'netStatus' | 'boardInfo' | 'bgaEscape' | 'originToGrid' | 'stackup';
export const REPORT_ROWS: [ReportKind, string][] = [['netStatus', 'Net Status'], ['boardInfo', 'Board Information'], ['bgaEscape', 'BGA Escape Route'],
  ['originToGrid', 'Move Component Origin To Grid'], ['stackup', 'Embedded Board Stackup Compatibility']];
export const reportSetting = (k: ReportKind) => settings.pcbReports[k] ?? { show: true, generate: false, format: 'TXT' as const };


const projectOf = (e: PcbEditor): Project | null => { const id = docs.value.find((d) => d.editor === e)?.projectId; return id ? projects.value.find((p) => p.id === id) ?? null : null; };

export function reportOut(kind: ReportKind, title: string, text: string, e: PcbEditor): void {
  const r = reportSetting(kind), p = projectOf(e);
  const stem = `${e.doc.name.replace(/\.[^.]+$/, '')} ${title}`;
  if (r.generate) void deliverOutputs(p, e.doc.name, title, [{ name: `${stem}.${r.format === 'HTML' ? 'html' : 'REP'}`, text: r.format === 'HTML' ? reportHtml(title, text) : text }]);
  if (r.show) showDialog(ReportDialog, { title, name: `${stem}.REP`, text, project: p });
  if (!r.show && !r.generate) notify(`${title}: neither shown nor generated (Preferences › PCB Editor › Reports)`);
}
