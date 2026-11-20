/**
 * Requirements in and out of tables: a project's requirements as rows (for Excel and CSV), a
 * table's columns matched to a requirement's fields by their headings (ID, Section, Title,
 * Requirement, Type, Priority, Status, Parent, Method, Verification, Note), its rows turned into
 * requirements (words read loosely: "Shall" is Must, "Inspect" is Inspection, "Pass" is Verified),
 * and requirements drafted elsewhere (the AI's) added under their sections.
 */
import {
  METHODS, PRIORITIES, REQ_TYPES, STATUSES, VERIFY_STATES, blankReq, isReq, labelOf, nextId,
  type Priority, type ReqRow, type ReqStatus, type ReqType, type Requirement, type Requirements, type VerifyMethod, type VerifyState,
} from './requirements';
import { checkWords, evalCheck, type DesignFacts } from './reqChecks';
import { LINK_KINDS, inTreeOrder } from './requirements';
import { htmlToText, isRich, textToHtml, type ReqFile } from './richText';

export const EXPORT_HEADER = ['ID', 'Section', 'Title', 'Requirement', 'Type', 'Priority', 'Status', 'Parent', 'Source', 'Method', 'Verification', 'Check', 'Check result', 'Linked to', 'Note', 'Attachments'];

/** The requirements as rows under the header (the verification as it stands, its check's result now). */
export function exportRows(rows: ReqRow[], state: (r: Requirement) => VerifyState, facts: DesignFacts | null): string[][] {
  const out: string[][] = [];
  let section = '';
  // (in the tree's order: each requirement in its parent's section, as the document shows it)
  for (const r of inTreeOrder(rows)) {
    if (r.kind === 'section') { section = r.title; continue; }
    const res = r.check && facts ? evalCheck(r.check, facts) : null;
    out.push([
      r.id, section, r.title, r.text, labelOf(REQ_TYPES, r.type), labelOf(PRIORITIES, r.priority), labelOf(STATUSES, r.status), r.parent ?? '', r.source ?? '',
      labelOf(METHODS, r.verify.method), labelOf(VERIFY_STATES, state(r)),
      r.check ? checkWords(r.check) : '', res ? `${res.status === 'pass' ? 'Passes' : res.status === 'fail' ? 'Fails' : 'Not known'}${res.measured ? `: ${res.measured}` : ''}${res.detail ? ` (${res.detail})` : ''}` : '',
      r.links.map((l) => `${labelOf(LINK_KINDS, l.kind)} ${l.ref}`).join('; '), r.verify.note,
      (r.files ?? []).filter((f) => !f.inline).map((f) => f.name).join('; '),
    ]);
  }
  return out;
}

/** Rows as CSV (commas, quotes where needed, CRLF), with a byte order mark so Excel reads it as UTF-8. */
export function toCsv(header: string[], rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

export type Field = 'id' | 'section' | 'title' | 'text' | 'type' | 'priority' | 'status' | 'parent' | 'source' | 'method' | 'state' | 'note';
export const FIELDS: [Field, string][] = [['id', 'ID'], ['section', 'Section'], ['title', 'Title'], ['text', 'Requirement'], ['type', 'Type'], ['priority', 'Priority'], ['status', 'Status'], ['parent', 'Parent'], ['source', 'Source'], ['method', 'Method'], ['state', 'Verification'], ['note', 'Note']];
const HEADINGS: Record<Field, RegExp> = {
  id: /^(id|req(uirement)?\s*(id|no\.?|number|#)|ref(erence)?|number|no\.?|#)$/i,
  section: /^(section|chapter|heading|group|category|area)$/i,
  title: /^(title|name|summary|short\s*(name|text)|subject)$/i,
  text: /^(requirement|requirement\s*text|text|description|statement|detail(s)?|specification)$/i,
  type: /^(type|kind|class(ification)?)$/i,
  priority: /^(priority|importance|moscow|level)$/i,
  status: /^(status|state|approval)$/i,
  parent: /^(parent|parent\s*(id|requirement)|derived\s*from|traces?\s*to)$/i,
  source: /^(source|origin|reference\s*document|spec(ification)?\s*(ref(erence)?|clause|section)|clause)$/i,
  method: /^(method|verification\s*method|how\s*verified|test\s*method)$/i,
  state: /^(verification|verified|verification\s*(status|state|result)|result|compliance)$/i,
  note: /^(note|notes|comment|comments|remarks?|evidence)$/i,
};

/** Each field's column (its index in the header, -1: none), by the header's words. */
export function guessColumns(header: string[]): Record<Field, number> {
  const out = Object.fromEntries(FIELDS.map(([f]) => [f, -1])) as Record<Field, number>;
  const used = new Set<number>();
  for (const [f] of FIELDS) {
    const i = header.findIndex((h, k) => !used.has(k) && HEADINGS[f].test(h.trim()));
    if (i >= 0) { out[f] = i; used.add(i); }
  }
  // A table with only one long text column: that is the requirement
  if (out.text < 0 && out.title < 0) { const i = header.findIndex((_, k) => !used.has(k)); if (i >= 0) out.text = i; }
  return out;
}

const loose = <T extends string>(list: [T, string][], v: string, extra: Record<string, T> = {}): T | undefined => {
  const w = v.trim().toLowerCase();
  if (!w) return undefined;
  for (const [k, n] of list) if (w === k || w === n.toLowerCase()) return k;
  // Short words (M, T, ok, no) only whole; longer ones at the start ("Inspect" for Inspection)
  for (const [k, n] of Object.entries(extra)) if (k.length <= 2 ? w === k : w.startsWith(k)) return n;
  for (const [k, n] of list) if (n.toLowerCase().startsWith(w) || w.startsWith(n.toLowerCase())) return k;
  return undefined;
};
export const readPriority = (v: string): Priority | undefined => loose(PRIORITIES, v, { shall: 'must', required: 'must', mandatory: 'must', high: 'must', essential: 'must', 'm': 'must', 's': 'should', medium: 'should', desirable: 'should', 'c': 'could', low: 'could', may: 'could', optional: 'could', nice: 'could' });
export const readType = (v: string): ReqType | undefined => loose(REQ_TYPES, v, { elec: 'electrical', mech: 'mechanical', env: 'environmental', func: 'functional', regul: 'compliance', standard: 'compliance', safety: 'compliance', emc: 'compliance', thermal: 'environmental', io: 'interface', connect: 'interface' });
export const readStatus = (v: string): ReqStatus | undefined => loose(STATUSES, v, { accept: 'approved', agreed: 'approved', baselin: 'approved', released: 'approved', propos: 'draft', new: 'draft', open: 'draft', delet: 'obsolete', withdrawn: 'obsolete', superseded: 'obsolete', rejected: 'obsolete' });
export const readMethod = (v: string): VerifyMethod | undefined => loose(METHODS, v, { t: 'test', a: 'analysis', i: 'inspection', inspect: 'inspection', d: 'review', demo: 'test', r: 'review', simul: 'analysis', calc: 'analysis', measure: 'test' });
export const readState = (v: string): VerifyState | undefined => loose(VERIFY_STATES, v, { pass: 'verified', ok: 'verified', yes: 'verified', complian: 'verified', done: 'verified', fail: 'failed', no: 'failed', 'non-compl': 'failed', waive: 'waived', 'n/a': 'waived', deviation: 'waived', todo: 'open', pending: 'open', tbd: 'open', 'not ': 'open' });

/**
 * A table's rows as requirements, under sections (a new section where the Section column
 * changes). Identifiers kept where they are new to the project, else given the next ones; parents
 * kept only when they name a requirement there is.
 */
export function importRows(rows: string[][], cols: Record<Field, number>, prefix: string, existing: Requirement[]): { rows: ReqRow[]; count: number; renamed: number } {
  const cell = (r: string[], f: Field) => (cols[f] >= 0 ? (r[cols[f]] ?? '').trim() : '');
  const out: ReqRow[] = [];
  const taken = new Set(existing.map((r) => r.id));
  const made: Requirement[] = [];
  let section: string | null = null, renamed = 0;
  for (const r of rows) {
    const title = cell(r, 'title'), text = cell(r, 'text');
    if (!title && !text) {
      // A row with a section only: a heading
      const s = cell(r, 'section');
      if (s && s !== section) { out.push({ kind: 'section', title: s }); section = s; }
      continue;
    }
    const s = cell(r, 'section');
    if (s && s !== section) { out.push({ kind: 'section', title: s }); section = s; }
    let id = cell(r, 'id');
    if (!id || taken.has(id)) { if (id) renamed++; id = nextId(prefix, [...existing, ...made]); }
    taken.add(id);
    const q = blankReq(id);
    q.title = title || text.split(/(?<=[.;:])\s/)[0]!.slice(0, 80);
    q.text = text;
    // Tables (Markdown rows) and lists in the text: formatted
    const h = textToHtml(text);
    if (isRich(h)) q.html = h;
    q.type = readType(cell(r, 'type')) ?? q.type;
    q.priority = readPriority(cell(r, 'priority')) ?? (/\bshall\b|\bmust\b/i.test(text) ? 'must' : /\bshould\b/i.test(text) ? 'should' : /\b(may|could)\b/i.test(text) ? 'could' : q.priority);
    q.status = readStatus(cell(r, 'status')) ?? q.status;
    q.verify = { method: readMethod(cell(r, 'method')) ?? q.verify.method, state: readState(cell(r, 'state')) ?? q.verify.state, note: cell(r, 'note') };
    const parent = cell(r, 'parent'), source = cell(r, 'source');
    if (parent) q.parent = parent;
    if (source) q.source = source;
    made.push(q); out.push(q);
  }
  const ids = new Set([...taken]);
  for (const q of made) if (q.parent && !ids.has(q.parent)) delete q.parent;
  return { rows: out, count: made.length, renamed };
}

/** Requirements drafted elsewhere (the AI's), as rows: each section once, the next identifiers given. */
export interface Draft { section: string; title: string; text: string; type: ReqType; priority: Priority; method: VerifyMethod; source?: string; html?: string; files?: ReqFile[] }
export function draftRows(drafts: Draft[], R: Requirements, existing: Requirement[]): ReqRow[] {
  const out: ReqRow[] = [];
  const made: Requirement[] = [];
  let section: string | null = null;
  for (const d of drafts) {
    if (d.section && d.section !== section) { section = d.section; out.push({ kind: 'section', title: d.section }); }
    const q = blankReq(nextId(R.prefix, [...existing, ...R.rows.filter(isReq), ...made]));
    Object.assign(q, { title: d.title, text: d.text, type: d.type, priority: d.priority });
    if (d.source) q.source = d.source;
    if (d.html) { q.html = d.html; q.text = htmlToText(d.html); }
    if (d.files?.length) q.files = d.files;
    q.verify = { ...q.verify, method: d.method };
    made.push(q); out.push(q);
  }
  return out;
}
