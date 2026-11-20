/**
 * Report files the output generator writes beside its outputs.
 * - Electrical Rules Check (Output Job › Validation Outputs): an HTML report in the form of AD's
 *   Design Rule Verification Report — the header (date, time, elapsed, the project, the counts),
 *   a summary by class, then one row per violation with the columns AD's setup offers (Class,
 *   Document, Message) [est: AD's title, file name and layout; only the columns are documented].
 * - Status Report.Txt: what each run generated, as AD writes it in the output folder (AD17-era
 *   reports read): "Output:", "Type  :", "From  :", a "   Generated File[…]" line per file, two
 *   blank lines, "Files Generated   : n", "Documents Printed : n", a blank line, then
 *   "Finished Output Generation At hh:mm:ss On <the short date>", CR LF.
 */
import { locale } from '../core/locale';
import type { CompileMessage } from '../model/compile';
import { NO_SCRIPT } from '../core/reportHtml';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const two = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

/** The violation classes as AD names them, worst first. */
export const ERC_CLASSES = ['Fatal Error', 'Error', 'Warning'] as const;
export const ercClass = (m: CompileMessage): (typeof ERC_CLASSES)[number] | null => (m.fatal ? 'Fatal Error' : m.level === 'error' ? 'Error' : m.level === 'warn' ? 'Warning' : null);

export interface ErcColumns { cls: boolean; document: boolean; message: boolean }

/** The Electrical Rules Check report of a compiled project (violations only; compiler notes are left out). */
export function ercReportHtml(project: string, messages: CompileMessage[], ms: number, columns: ErcColumns = { cls: true, document: true, message: true }, when = new Date()): string {
  const rows = messages.map((m) => ({ cls: ercClass(m), m })).filter((r): r is { cls: (typeof ERC_CLASSES)[number]; m: CompileMessage } => !!r.cls)
    .sort((a, b) => ERC_CLASSES.indexOf(a.cls) - ERC_CLASSES.indexOf(b.cls));
  const count = (c: string) => rows.filter((r) => r.cls === c).length;
  const hms = new Date(ms).toISOString().slice(11, 19);
  const head = [columns.cls && '<th>Class</th>', columns.document && '<th>Document</th>', columns.message && '<th>Message</th>'].filter(Boolean).join('');
  const body = rows.map((r) => `<tr class="${r.cls === 'Warning' ? 'warn' : 'err'}">${[
    columns.cls && `<td>${esc(r.cls)}</td>`, columns.document && `<td>${esc(r.m.sheet)}</td>`, columns.message && `<td>${esc(r.m.message)}</td>`,
  ].filter(Boolean).join('')}</tr>`).join('');
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">${NO_SCRIPT}<title>Electrical Rules Check Report</title><style>
body{font:13px Arial,sans-serif;color:#000;background:#fff;margin:16px}h1{font-size:20px;color:#1a4b8c}
table{border-collapse:collapse;margin:10px 0;min-width:520px}td,th{border:1px solid #c8c8c8;padding:3px 8px;text-align:left}th{background:#e8edf3}
.n{text-align:right;width:60px}.hdr td{border:0;padding:1px 8px 1px 0}tr.total td{font-weight:bold}tr.err td:first-child{color:#b00}tr.warn td:first-child{color:#a60}
</style></head><body>
<h1>Electrical Rules Check Report</h1>
<table class="hdr"><tr><td>Date:</td><td>${when.toLocaleDateString(locale())}</td></tr><tr><td>Time:</td><td>${clock(when)}</td></tr>
<tr><td>Elapsed Time:</td><td>${hms}</td></tr><tr><td>Filename:</td><td>${esc(project)}</td></tr>
<tr><td>Warnings:</td><td>${count('Warning')}</td></tr><tr><td>Errors:</td><td>${count('Error')}</td></tr><tr><td>Fatal Errors:</td><td>${count('Fatal Error')}</td></tr></table>
<h2>Summary</h2>
<table><tr><th>Class</th><th class="n">Count</th></tr>${ERC_CLASSES.map((c) => `<tr><td>${c}</td><td class="n">${count(c)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td class="n">${rows.length}</td></tr></table>
${rows.length ? `<table><tr>${head}</tr>${body}</table>` : '<p>No violations.</p>'}
</body></html>`;
}

export interface StatusEntry {
  /** The output's name (Output:) and type (Type  :). */
  name: string; type: string;
  /** Where its data came from: "Project [X.PrjPcb]", "Variant [[No Variations]] of PCB Document [X.PcbDoc]" … */
  from: string;
  files: string[];
}

/** Status Report.Txt for one run [est: how AD separates several outputs — a blank line]. */
export function statusReport(entries: StatusEntry[], printed: number, when = new Date()): string {
  const lines: string[] = [];
  entries.forEach((e, i) => {
    if (i) lines.push('');
    lines.push(`Output: ${e.name}`, `Type  : ${e.type}`, `From  : ${e.from}`, ...e.files.map((f) => `   Generated File[${f}]`));
  });
  const n = entries.reduce((k, e) => k + e.files.length, 0);
  lines.push('', '', `Files Generated   : ${n}`, `Documents Printed : ${printed}`, '', `Finished Output Generation At ${clock(when)} On ${when.toLocaleDateString(locale())}`);
  return lines.join('\r\n') + '\r\n';
}
