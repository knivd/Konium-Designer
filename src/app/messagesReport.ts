/**
 * Messages › Group By and Export To Report / Print: a message's group (its class, document or
 * source) and the list as a report page, grouped as the panel groups it.
 */
import { locale } from '../core/locale';
import type { Message } from './state';
import { NO_SCRIPT } from '../core/reportHtml';

export type MsgGroup = 'none' | 'class' | 'document' | 'source';
export const msgClassLabel = (m: Pick<Message, 'cls' | 'level'>) => m.cls ?? `[${m.level === 'warn' ? 'Warning' : m.level === 'error' ? 'Error' : 'Info'}]`;
export const msgGroupKey = (m: Message, g: MsgGroup): string => (g === 'class' ? msgClassLabel(m) : g === 'document' ? m.doc : g === 'source' ? m.source : '');

const escHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The Messages Report page. */
export function messagesReportHtml(list: Message[], g: MsgGroup, when = new Date()): string {
  const groups = new Map<string, Message[]>();
  for (const m of list) { const k = msgGroupKey(m, g); groups.set(k, [...(groups.get(k) ?? []), m]); }
  const row = (m: Message) => `<tr class="${m.level}"><td>${escHtml(msgClassLabel(m))}</td><td>${escHtml(m.doc)}</td><td>${escHtml(m.source)}</td><td>${escHtml(m.message)}</td>`
    + `<td>${new Date(m.at).toLocaleTimeString(locale())}</td><td>${new Date(m.at).toLocaleDateString(locale())}</td><td class="n">${m.no}</td></tr>`;
  const head = '<tr><th>Class</th><th>Document</th><th>Source</th><th>Message</th><th>Time</th><th>Date</th><th class="n">No.</th></tr>';
  const body = [...groups].map(([k, ms]) => `${g !== 'none' ? `<tr class="group"><td colspan="7">${escHtml(k || '(none)')} (${ms.length})</td></tr>` : ''}${ms.map(row).join('')}`).join('');
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">${NO_SCRIPT}<title>Messages Report</title><style>
body{font:13px Arial,sans-serif;color:#000;background:#fff;margin:16px}h1{font-size:20px;color:#1a4b8c}
table{border-collapse:collapse;margin:10px 0}td,th{border:1px solid #c8c8c8;padding:3px 8px;text-align:left;vertical-align:top}th{background:#e8edf3}
.n{text-align:right}tr.group td{background:#f2f2f2;font-weight:bold}tr.error td:first-child{color:#b00}tr.warn td:first-child{color:#a60}
</style></head><body><h1>Messages Report</h1><p>${when.toLocaleDateString(locale())} ${when.toLocaleTimeString(locale())} · ${list.length} message${list.length === 1 ? '' : 's'}</p>
${list.length ? `<table>${head}${body}</table>` : '<p>No messages.</p>'}</body></html>`;
}

