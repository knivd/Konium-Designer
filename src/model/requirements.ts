/**
 * A project's requirements: what the product must do and be, each with an identifier that stays
 * with it (REQ-001), a title and its text, a type, a priority, a status, an optional parent (a
 * requirement broken down into smaller ones), and how it is verified: the method (test, analysis,
 * inspection, review) and where that stands (open, verified, failed, waived), with a note. Its
 * text may be formatted (bold, lists, tables, links, pictures: a safe subset of HTML kept beside
 * the plain text) and it may have files attached; pictures and files are kept in the document.
 *
 * A requirements document holds them in order, under sections (headings: a requirement belongs to
 * the section above it). A project may have any number of them; the identifiers are unique across
 * the project, and a new one takes the next number after the highest in it.
 */

export type ReqType = 'functional' | 'electrical' | 'mechanical' | 'environmental' | 'interface' | 'compliance' | 'other';
export type Priority = 'must' | 'should' | 'could';
export type ReqStatus = 'draft' | 'approved' | 'obsolete';
export type VerifyMethod = 'test' | 'analysis' | 'inspection' | 'review';
export type VerifyState = 'open' | 'verified' | 'failed' | 'waived';

export const REQ_TYPES: [ReqType, string][] = [['functional', 'Functional'], ['electrical', 'Electrical'], ['mechanical', 'Mechanical'], ['environmental', 'Environmental'], ['interface', 'Interface'], ['compliance', 'Compliance'], ['other', 'Other']];
export const PRIORITIES: [Priority, string][] = [['must', 'Must'], ['should', 'Should'], ['could', 'Could']];
export const STATUSES: [ReqStatus, string][] = [['draft', 'Draft'], ['approved', 'Approved'], ['obsolete', 'Obsolete']];
export const METHODS: [VerifyMethod, string][] = [['test', 'Test'], ['analysis', 'Analysis'], ['inspection', 'Inspection'], ['review', 'Review']];
export const VERIFY_STATES: [VerifyState, string][] = [['open', 'Not verified'], ['verified', 'Verified'], ['failed', 'Failed'], ['waived', 'Waived']];
export const labelOf = <T extends string>(list: [T, string][], v: T): string => list.find(([k]) => k === v)?.[1] ?? v;

export interface Verification { method: VerifyMethod; state: VerifyState; note: string }

import { htmlToText, isRich, normaliseFiles, sanitiseHtml, type ReqFile } from './richText';
import { evalCheck, normaliseCheck, type CheckResult, type DesignFacts, type ReqCheck } from './reqChecks';

/**
 * Where a requirement is met in the design: a part (its designator), a net (its name), a document
 * (a schematic sheet, or any other document of the project, by its file name) or the board (its
 * PCB document).
 */
export type LinkKind = 'part' | 'net' | 'sheet' | 'board';
export interface ReqLink { kind: LinkKind; ref: string }
export const LINK_KINDS: [LinkKind, string][] = [['part', 'Part'], ['net', 'Net'], ['sheet', 'Document'], ['board', 'Board']];
const linkKey = (l: ReqLink) => `${l.kind}:${l.kind === 'sheet' || l.kind === 'board' ? l.ref.toLowerCase() : l.ref}`;
/** Links put together: each once, in a steady order (parts, nets, documents, the board; by name, numbers in order). */
export function mergeLinks(a: ReqLink[], b: ReqLink[]): ReqLink[] {
  const m = new Map<string, ReqLink>();
  for (const l of [...a, ...b]) if (l.ref.trim()) m.set(linkKey(l), { kind: l.kind, ref: l.ref.trim() });
  const order = (k: LinkKind) => LINK_KINDS.findIndex(([x]) => x === k);
  return [...m.values()].sort((x, y) => order(x.kind) - order(y.kind) || x.ref.localeCompare(y.ref, undefined, { numeric: true, sensitivity: 'base' }));
}
export const sameLink = (a: ReqLink, b: ReqLink) => linkKey(a) === linkKey(b);

export interface Requirement {
  kind: 'req';
  /** Its identifier: the document's prefix and a number (REQ-001); kept when it moves. */
  id: string;
  title: string;
  /** What is required, in full. */
  text: string;
  type: ReqType;
  priority: Priority;
  status: ReqStatus;
  /** The requirement it is part of (its identifier), if any. */
  parent?: string;
  /** Where it comes from: the specification, its clause (e.g. "Customer spec 3.2.1"). */
  source?: string;
  /** The requirement formatted (a safe subset of HTML), when it is more than plain text; text is then its plain text. */
  html?: string;
  /** Pictures in its text and files attached to it, kept in the document. */
  files?: ReqFile[];
  verify: Verification;
  /** Where it is met in the design. */
  links: ReqLink[];
  /** What the design is measured for, against the requirement's figure (none: verified by hand only). */
  check?: ReqCheck;
}

/** A heading: the requirements under it, up to the next one, are its section. */
export interface Section { kind: 'section'; title: string }

export type ReqRow = Requirement | Section;

export interface Requirements {
  /** New requirements' identifiers start with this (REQ). */
  prefix: string;
  rows: ReqRow[];
}

export const isReq = (r: ReqRow): r is Requirement => r.kind === 'req';

const pick = <T extends string>(list: [T, string][], v: unknown, d: T): T => (list.some(([k]) => k === v) ? (v as T) : d);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

/** A prefix as identifiers can carry it: letters, digits and dashes, upper case (REQ when there's nothing left). */
export const cleanPrefix = (p: unknown): string => str(p).toUpperCase().replace(/[^A-Z0-9-]/g, '').replace(/-+$/, '').slice(0, 12) || 'REQ';

/** A requirement as read (anything missing or out of range set to its default). */
export function normaliseReq(o: Partial<Requirement> & Record<string, unknown>, id: string): Requirement {
  const v = (o.verify ?? {}) as Partial<Verification>;
  const r: Requirement = {
    kind: 'req', id: str(o.id).trim() || id, title: str(o.title), text: str(o.text),
    type: pick(REQ_TYPES, o.type, 'functional'), priority: pick(PRIORITIES, o.priority, 'must'), status: pick(STATUSES, o.status, 'draft'),
    verify: { method: pick(METHODS, v.method, 'test'), state: pick(VERIFY_STATES, v.state, 'open'), note: str(v.note) },
    links: mergeLinks([], (Array.isArray(o.links) ? o.links : []).filter((l): l is ReqLink => !!l && typeof l === 'object' && LINK_KINDS.some(([k]) => k === (l as ReqLink).kind) && typeof (l as ReqLink).ref === 'string')),
  };
  if (typeof o.parent === 'string' && o.parent.trim()) r.parent = o.parent.trim();
  if (typeof o.source === 'string' && o.source.trim()) r.source = o.source.trim();
  if (typeof o.html === 'string') {
    const html = sanitiseHtml(o.html);
    r.text = htmlToText(html);
    if (isRich(html)) r.html = html;
  }
  const files = normaliseFiles(o.files, r.html);
  if (files.length) r.files = files;
  const c = normaliseCheck(o.check);
  if (c) r.check = c;
  return r;
}

/** A document's requirements as read: rows checked, identifiers made unique within it, parents that would loop dropped. */
export function normaliseRequirements(o: Partial<Requirements> | null | undefined): Requirements {
  const prefix = cleanPrefix(o?.prefix);
  const rows: ReqRow[] = [];
  const seen = new Set<string>();
  let n = 0;
  for (const raw of Array.isArray(o?.rows) ? o!.rows : []) {
    const x = raw as unknown as Record<string, unknown>;
    if (!x || typeof x !== 'object') continue;
    if (x.kind === 'section') { rows.push({ kind: 'section', title: str(x.title) }); continue; }
    const r = normaliseReq(x as Partial<Requirement> & Record<string, unknown>, '');
    if (!r.id || seen.has(r.id)) { do { r.id = idOf(prefix, ++n); } while (seen.has(r.id)); }
    seen.add(r.id);
    rows.push(r);
  }
  const reqs = rows.filter(isReq);
  for (const r of reqs) if (r.parent && (r.parent === r.id || loops(reqs, r.id, r.parent))) delete r.parent;
  return { prefix, rows };
}

export const newRequirements = (): Requirements => ({ prefix: 'REQ', rows: [{ kind: 'section', title: 'General' }] });

/** An identifier: the prefix and the number, three digits at least (REQ-007, REQ-1234). */
export const idOf = (prefix: string, n: number): string => `${prefix}-${String(n).padStart(3, '0')}`;

/** The number an identifier ends in (0 when it has none). */
export const numberOf = (id: string): number => { const m = /(\d+)\s*$/.exec(id); return m ? Number(m[1]) : 0; };

/** The next identifier for a document, after the highest number among every requirement in the project with its prefix. */
export function nextId(prefix: string, all: Iterable<Requirement>): string {
  let hi = 0;
  for (const r of all) if (r.id.startsWith(`${prefix}-`)) hi = Math.max(hi, numberOf(r.id));
  return idOf(prefix, hi + 1);
}

/** Whether making `parent` the parent of `id` would make a loop (the parent is the requirement itself, or under it). */
export function loops(all: Requirement[], id: string, parent: string): boolean {
  const byId = new Map(all.map((r) => [r.id, r]));
  let at: string | undefined = parent;
  for (let guard = 0; at && guard < 1000; guard++) {
    if (at === id) return true;
    at = byId.get(at)?.parent;
  }
  return false;
}

/** How deep a requirement sits under parents (0: it has none, or its parent isn't known). */
export function depthOf(all: Map<string, Requirement>, r: Requirement): number {
  let d = 0, at = r.parent;
  const seen = new Set<string>([r.id]);
  while (at && all.has(at) && !seen.has(at) && d < 20) { seen.add(at); d++; at = all.get(at)!.parent; }
  return d;
}

/** The section each row is under (its title; '' before the first heading). */
export function sectionsOf(rows: ReqRow[]): string[] {
  let cur = '';
  return rows.map((r) => (r.kind === 'section' ? (cur = r.title) : cur));
}

/** A new requirement, its identifier given. */
export const blankReq = (id: string, parent?: string): Requirement => ({
  kind: 'req', id, title: '', text: '', type: 'functional', priority: 'must', status: 'draft',
  ...(parent ? { parent } : {}), verify: { method: 'test', state: 'open', note: '' }, links: [],
});

/** A requirement's check against the design as it is (none without a check). */
export const resultOf = (r: Requirement, f: DesignFacts): CheckResult | null => (r.check ? evalCheck(r.check, f) : null);

/** Where a requirement's verification stands: its check's result when the verification follows it (and the result is known), else as set by hand. */
export function stateOf(r: Requirement, f: DesignFacts | null): VerifyState {
  if (f && r.check?.follow) { const s = evalCheck(r.check, f).status; if (s === 'pass') return 'verified'; if (s === 'fail') return 'failed'; }
  return r.verify.state;
}

/** Requirements counted: all, approved, verified (or waived), failed; the obsolete left out. */
export function tally(reqs: Iterable<Requirement>, state: (r: Requirement) => VerifyState = (r) => r.verify.state): { all: number; approved: number; verified: number; failed: number; open: number } {
  const t = { all: 0, approved: 0, verified: 0, failed: 0, open: 0 };
  for (const r of reqs) {
    if (r.status === 'obsolete') continue;
    t.all++;
    if (r.status === 'approved') t.approved++;
    const v = state(r);
    if (v === 'verified' || v === 'waived') t.verified++;
    else if (v === 'failed') t.failed++;
    else t.open++;
  }
  return t;
}

/** A requirement matches a search: its identifier, title, text or note has every word typed. */
export function matches(r: Requirement, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${r.id} ${r.title} ${r.text} ${r.source ?? ''} ${r.verify.note}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/* ── the tree: each requirement under its parent ── */

/** A row as the tree shows it: its place in the document's rows and how deep it sits (in this document). */
export interface TreeRow { i: number; depth: number }

/**
 * The rows as the tree shows them: each requirement under its parent when that is in the same
 * document (after it and its other children, in their order), wherever it is in the document; the
 * sections and the other requirements in their order.
 */
export function treeRows(rows: ReqRow[]): TreeRow[] {
  const at = new Map<string, number>();
  rows.forEach((r, i) => { if (isReq(r)) at.set(r.id, i); });
  const kids = new Map<number, number[]>();
  const roots: number[] = [];
  rows.forEach((r, i) => {
    const p = isReq(r) && r.parent ? at.get(r.parent) : undefined;
    if (p !== undefined && p !== i) { const l = kids.get(p); if (l) l.push(i); else kids.set(p, [i]); } else roots.push(i);
  });
  const out: TreeRow[] = [];
  const seen = new Set<number>();
  const walk = (i: number, depth: number) => {
    if (seen.has(i)) return;
    seen.add(i); out.push({ i, depth });
    for (const k of kids.get(i) ?? []) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // (a loop of parents, which reading the document drops: its rows in their order)
  rows.forEach((_, i) => walk(i, 0));
  return out;
}

/** The rows in the tree's order: the document as the tree shows it. */
export const inTreeOrder = (rows: ReqRow[]): ReqRow[] => treeRows(rows).map((t) => rows[t.i]!);

/**
 * A row moved past the one before or after it at its level (with everything under it), in the
 * tree's order; the rows in that order, or null when it can't go further. A section or a requirement
 * without a parent here moves among the others at the top (a requirement into the section it
 * passes), a requirement under another among its parent's other children.
 */
export function moveInTree(rows: ReqRow[], row: ReqRow, by: -1 | 1): ReqRow[] | null {
  const tr = treeRows(rows);
  const list = tr.map((t) => rows[t.i]!), depth = tr.map((t) => t.depth);
  const s = list.indexOf(row);
  if (s < 0) return null;
  const d = depth[s]!;
  let e = s + 1;
  while (e < list.length && depth[e]! > d) e++;
  if (by < 0) {
    let p = s - 1;
    while (p >= 0 && depth[p]! > d) p--;
    if (p < 0 || depth[p]! < d) return null;
    return [...list.slice(0, p), ...list.slice(s, e), ...list.slice(p, s), ...list.slice(e)];
  }
  if (e >= list.length || depth[e]! < d) return null;
  let f = e + 1;
  while (f < list.length && depth[f]! > d) f++;
  return [...list.slice(0, s), ...list.slice(e, f), ...list.slice(s, e), ...list.slice(f)];
}

/** Where a new requirement beside `row` goes in the tree's order: after it and everything under it. */
export function afterSubtree(rows: ReqRow[], row: ReqRow): number {
  const tr = treeRows(rows);
  const s = tr.findIndex((t) => rows[t.i] === row);
  if (s < 0) return rows.length;
  let e = s + 1;
  while (e < tr.length && tr[e]!.depth > tr[s]!.depth) e++;
  return e;
}
