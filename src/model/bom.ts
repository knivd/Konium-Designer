/**
 * Reports › Bill of Materials: the project's components, grouped as Altium groups them
 * (by Comment and Footprint unless told otherwise), with Designator lists and Quantity, in the
 * columns chosen. Graphical parts, Net Ties (not In BOM) and Standard (No BOM) parts are left out.
 */
import { locale } from '../core/locale';
import type { CompiledComponent } from './compile';
import { isWireLinkComponent } from './wireLink';
import { NO_SCRIPT } from '../core/reportHtml';

export interface BomSetup {
  /** Columns rows are grouped by (equal values → one line). */
  group: string[];
  /** Columns shown, in order. */
  columns: string[];
  sort?: { column: string; descending: boolean };
}

export const BOM_BASE = ['Comment', 'Description', 'Designator', 'Footprint', 'LibRef', 'Quantity'];
export const defaultBomSetup = (): BomSetup => ({ group: ['Comment', 'Footprint'], columns: ['Comment', 'Description', 'Designator', 'Footprint', 'LibRef', 'Quantity'] });

/** COMPONENTKIND 2 Graphical, 4 Net Tie, 5 Standard (No BOM) stay out of a BOM. */
export const inBom = (c: { kind: number }) => c.kind !== 2 && c.kind !== 4 && c.kind !== 5;

/** One record per component: the base columns plus every parameter the parts carry. */
export function bomItems(components: CompiledComponent[]): Record<string, string>[] {
  return components.filter(inBom).map((c) => ({
    ...Object.fromEntries(Object.entries(c.params).filter(([k]) => !/^(Comment|Description|Designator)$/i.test(k))),
    Comment: c.comment, Description: c.description, Designator: c.designator, Footprint: c.footprint, LibRef: c.libRef,
  }));
}

/** Every column the items have: the base ones first, then parameters A–Z. */
export function bomColumns(items: Record<string, string>[]): string[] {
  const extra = new Set<string>();
  for (const it of items) for (const k of Object.keys(it)) if (!BOM_BASE.includes(k)) extra.add(k);
  return [...BOM_BASE, ...[...extra].sort((a, b) => a.localeCompare(b))];
}

/** R2 before R10: numbers compare as numbers. */
export const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** The grouped lines, each a value per shown column. */
export function buildBom(items: Record<string, string>[], setup: BomSetup): string[][] {
  const groups = new Map<string, Record<string, string>[]>();
  for (const it of items) {
    const key = setup.group.length ? setup.group.map((g) => (it[g] ?? '').trim()).join('\u0001') : (it.Designator ?? String(groups.size));
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(it);
  }
  const rows = [...groups.values()].map((g) => {
    g.sort((a, b) => natural(a.Designator ?? '', b.Designator ?? ''));
    return setup.columns.map((col) => {
      if (col === 'Quantity') return String(g.length);
      if (col === 'Designator') return g.map((x) => x.Designator ?? '').join(', ');
      const vals = [...new Set(g.map((x) => x[col] ?? ''))].filter((v) => v !== '');
      return vals.join(', ');
    });
  });
  const s = setup.sort;
  const by = s ? setup.columns.indexOf(s.column) : setup.columns.indexOf('Designator');
  if (by >= 0) {
    const numeric = setup.columns[by] === 'Quantity';
    rows.sort((a, b) => (numeric ? Number(a[by]) - Number(b[by]) : natural(a[by]!, b[by]!)) * (s?.descending ? -1 : 1));
  }
  return rows;
}

/* ─── Formats ─── */

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const bomCsv = (columns: string[], rows: string[][]) => [columns, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
export const bomTsv = (columns: string[], rows: string[][]) => [columns, ...rows].map((r) => r.map((v) => v.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\r\n') + '\r\n';

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function bomHtml(title: string, columns: string[], rows: string[][]): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">${NO_SCRIPT}<title>${esc(title)}</title>\n<style>body{font:13px Arial,sans-serif;margin:24px}table{border-collapse:collapse}th,td{border:1px solid #999;padding:3px 8px;text-align:left;vertical-align:top}th{background:#e8e8e8}</style></head>\n`
    + `<body><h1>${esc(title)}</h1>\n<table><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>\n<tbody>\n`
    + rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('\n') + '\n</tbody></table></body></html>\n';
}

/**
 * Reports › Simple BOM: Altium's two text files — .BOM (columns padded) and .CSV — grouped by
 * Comment and Footprint, listing Comment, Pattern, Quantity and Components.
 */
export function simpleBom(project: string, items: Record<string, string>[], when = new Date()): { bom: string; csv: string } {
  const rows = buildBom(items, { group: ['Comment', 'Footprint'], columns: ['Comment', 'Footprint', 'Quantity', 'Designator'] });
  const head = ['Comment', 'Pattern', 'Quantity', 'Components'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (i === 3 ? 0 : r[i]!.length))) + 2);
  const line = (r: string[]) => r.map((v, i) => (i === 3 ? v : v.padEnd(widths[i]!))).join('').trimEnd();
  const stamp = when.toLocaleString(locale());
  const bom = [`Bill of Material for ${project}`, `On ${stamp}`, '', line(head), '-'.repeat(60), ...rows.map(line), ''].join('\r\n');
  return { bom, csv: bomCsv(head, rows) };
}

/**
 * A board's wire links (Place › Wire Link): parts no schematic has, which a project's BOM takes
 * from its board ("Wire link", "Insulated wire, 23.4 mm", W1 …).
 */
export function wireLinkBomItems(doc: import('./pcb').PcbDocument): Record<string, string>[] {
  const wired = new Set(doc.components.filter((c) => isWireLinkComponent(c) && !c.bag.get('SOURCEUNIQUEID')).map((c) => c.designator));
  return wired.size ? pcbBomItems(doc).filter((it) => wired.has(it.Designator ?? '')) : [];
}

/** From a board alone (no schematics): designator, the comment string, footprint and source library data. */
export function pcbBomItems(doc: import('./pcb').PcbDocument): Record<string, string>[] {
  const comments = new Map<number, string>();
  for (const p of doc.prims) if (p.kind === 'text' && p.isComment && !comments.has(p.component)) comments.set(p.component, p.text);
  return doc.components.filter((c) => c.bag.get('COMPONENTKIND') === undefined || inBom({ kind: c.bag.int('COMPONENTKIND') })).map((c) => ({
    Comment: comments.get(c.index) ?? c.bag.get('COMMENT') ?? '', Description: c.bag.get('SOURCEDESCRIPTION') ?? '',
    Designator: c.designator, Footprint: c.pattern, LibRef: c.bag.get('SOURCELIBREFERENCE') ?? '',
  }));
}
