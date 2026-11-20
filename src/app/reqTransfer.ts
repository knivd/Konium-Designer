/**
 * Requirements out of Konium Designer: as an Excel workbook or a CSV file (one row each, its
 * verification and check as they stand now), and as the compliance report (an HTML page: opened in
 * a new tab to read or print, or saved).
 */
import { saveFileAs } from '../platform/fs';
import { APP_VERSION } from '../platform/distribution';
import { xlsx } from '../formats/xlsx';
import { EXPORT_HEADER, exportRows, toCsv } from '../model/reqIO';
import { reportHtml } from '../model/reqReport';
import { resultOf, stateOf } from '../model/requirements';
import { designFacts } from './reqFacts';
import { reqSources, type ReqSource } from './requirementsData';
import type { Project } from './state';

export type ExportFormat = 'xlsx' | 'csv' | 'html';
const projectBase = (p: Project | null, s: ReqSource[]) => (p ? p.name.replace(/\.prjpcb$/i, '') : (s[0]?.name ?? 'Requirements').replace(/\.reqdoc$/i, ''));

/** The file made: its name and bytes. */
export function exportFile(p: Project | null, sources: ReqSource[], format: ExportFormat, when = new Date()): { name: string; bytes: Uint8Array } {
  const facts = designFacts(p);
  const one = sources.length === 1;
  const base = one ? sources[0]!.name.replace(/\.reqdoc$/i, '') : projectBase(p, sources);
  if (format === 'html') return { name: `Requirements Compliance - ${base}.html`, bytes: new TextEncoder().encode(complianceHtml(p, sources, when)) };
  const header = one ? EXPORT_HEADER : ['Document', ...EXPORT_HEADER];
  const rows = sources.flatMap((s) => exportRows(s.doc.reqs.rows, (r) => stateOf(r, facts), facts).map((r) => (one ? r : [s.name, ...r])));
  if (format === 'csv') return { name: `${base}.csv`, bytes: new TextEncoder().encode(toCsv(header, rows)) };
  return { name: `${base}.xlsx`, bytes: xlsx('Requirements', header, rows, when) };
}

export function complianceHtml(p: Project | null, sources: ReqSource[] = reqSources(p), when = new Date()): string {
  const facts = designFacts(p);
  return reportHtml({ project: projectBase(p, sources), docs: sources.map((s) => ({ name: s.name, reqs: s.doc.reqs })), state: (r) => stateOf(r, facts), result: (r) => resultOf(r, facts), when, version: APP_VERSION });
}

export async function saveExport(p: Project | null, sources: ReqSource[], format: ExportFormat): Promise<boolean> {
  const f = exportFile(p, sources, format);
  // null: cancelled; undefined: downloaded (no file selector)
  return (await saveFileAs(f.name, f.bytes, p?.dir)) !== null;
}

/** The compliance report in a new tab (saved instead where tabs can't be opened). */
export function openComplianceReport(p: Project | null): void {
  const sources = reqSources(p);
  const html = complianceHtml(p, sources);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if (!w) void saveFileAs(exportFile(p, sources, 'html').name, new TextEncoder().encode(html), p?.dir);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
