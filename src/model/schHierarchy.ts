/**
 * Hierarchical design: sheet symbols stand for child sheets (the File Name names the child's
 * document), their sheet entries meet the child's ports of the same name. Here: where an entry
 * sits on its symbol, which sheet a symbol stands for, and the project's sheet tree as the
 * Projects panel shows it after a compile.
 */
import { locale } from '../core/locale';
import type { Vec2 } from '../core/geom';
import { SCH_UNIT } from '../core/units';
import { SR, bagOf, type SchDocument, type SchObject } from './sch';

export type SheetSymbolObject = SchObject & { kind: 'sheetsymbol' };
export type SheetEntryObject = SchObject & { kind: 'sheetentry' };

/** Entry sides, as SIDE stores them. */
export const ENTRY_SIDE = { left: 0, right: 1, top: 2, bottom: 3 } as const;

/** DISTANCEFROMTOP is in 100 mil steps, with DISTANCEFROMTOP_FRAC1 for the rest. */
export const ENTRY_STEP = 10 * SCH_UNIT;

export function entryDistanceProps(d: number): { DISTANCEFROMTOP: string; DISTANCEFROMTOP_FRAC1: string | null } {
  const whole = Math.trunc(d / ENTRY_STEP), frac = d - whole * ENTRY_STEP;
  return { DISTANCEFROMTOP: String(whole), DISTANCEFROMTOP_FRAC1: frac ? String(frac) : null };
}

export function isSymbol(o: SchObject | undefined): o is SheetSymbolObject { return o?.kind === 'sheetsymbol'; }
export function isEntry(o: SchObject | undefined): o is SheetEntryObject { return o?.kind === 'sheetentry'; }

/** The symbol's box: LOCATION is its top-left corner, the box hangs down from it. */
export function symbolBox(s: SheetSymbolObject): { left: number; right: number; top: number; bottom: number } {
  return { left: s.at.x, right: s.at.x + s.w, top: s.at.y, bottom: s.at.y - s.h };
}

/** Where an entry meets wires: the point on the symbol's edge. */
export function entryPoint(doc: SchDocument, e: SchObject): Vec2 | null {
  if (!isEntry(e)) return null;
  const s = doc.objects[e.owner];
  if (!isSymbol(s)) return null;
  const b = symbolBox(s);
  switch (e.side) {
    case 1: return { x: b.right, y: b.top - e.distance };
    case 2: return { x: b.left + e.distance, y: b.top };
    case 3: return { x: b.left + e.distance, y: b.bottom };
    default: return { x: b.left, y: b.top - e.distance };
  }
}

/** The edge of a symbol nearest to p and how far along it (on the grid, clear of the corners). */
export function edgeSlot(s: SheetSymbolObject, p: Vec2, grid: number): { side: number; distance: number } {
  const b = symbolBox(s);
  const d = [Math.abs(p.x - b.left), Math.abs(p.x - b.right), Math.abs(p.y - b.top), Math.abs(p.y - b.bottom)];
  const side = d.indexOf(Math.min(...d));
  const len = side < 2 ? s.h : s.w;
  const raw = side < 2 ? b.top - p.y : p.x - b.left;
  const g = Math.max(1, grid);
  const lo = Math.min(g, len / 2), hi = Math.max(lo, len - g);
  const distance = Math.min(hi, Math.max(lo, Math.round(raw / g) * g));
  return { side, distance };
}

export function childText(doc: SchDocument, sym: number, record: number): SchObject | undefined {
  return doc.objects.find((o) => o.owner === sym && o.record === record);
}
/** The symbol's Designator (sheet name) and File Name. */
export function symbolNames(doc: SchDocument, sym: number): { designator: string; fileName: string } {
  const t = (r: number) => { const c = childText(doc, sym, r); return c ? bagOf(doc, c)?.get('TEXT') ?? '' : ''; };
  return { designator: t(SR.SHEET_NAME), fileName: t(SR.FILE_NAME) };
}

export function entriesOf(doc: SchDocument, sym: number): SheetEntryObject[] {
  return doc.objects.filter((o): o is SheetEntryObject => isEntry(o) && o.owner === sym);
}
export function portsOf(doc: SchDocument): (SchObject & { kind: 'port' })[] {
  return doc.objects.filter((o): o is SchObject & { kind: 'port' } => o.kind === 'port');
}

const natural = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

export const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The sheet a File Name refers to, among these names (case-insensitive, folders ignored, .SchDoc assumed). */
export function resolveSheet(names: readonly string[], fileName: string): string | undefined {
  // A File Name listing several sheets (a;b): the first of them found
  if (fileName.includes(';')) { for (const part of fileName.split(';')) { const r = resolveSheet(names, part); if (r) return r; } return undefined; }
  const f = baseName(fileName.trim()).toLowerCase();
  if (!f) return undefined;
  return names.find((n) => baseName(n).toLowerCase() === f) ?? names.find((n) => baseName(n).toLowerCase() === `${f}.schdoc`);
}

export interface SymbolRef { sheet: string; index: number; designator: string; fileName: string }
export interface HierNode { sheet: string; via?: SymbolRef; children: HierNode[] }
export interface Hierarchy {
  /** Top-level sheets (no symbol stands for them), each with its tree. */
  roots: HierNode[];
  /** Symbols whose child isn't among the sheets. */
  missing: SymbolRef[];
  /** For each child sheet (lower case), the symbols that stand for it. */
  parents: Map<string, SymbolRef[]>;
  /** For each "sheet:index" symbol, the sheet it stands for (the first, where its File Name lists several). */
  childOf: Map<string, string>;
  /** For each "sheet:index" symbol, every sheet it stands for (a File Name may list several, separated by semicolons). */
  childrenOf: Map<string, string[]>;
}

/**
 * The project's sheet tree: tops first, children ordered by designator (or, as the Projects
 * panel shows them, in the project's document order).
 */
export function sheetHierarchy(sheets: readonly { name: string; doc: SchDocument }[], order: 'designator' | 'documents' = 'designator'): Hierarchy {
  const names = sheets.map((s) => s.name);
  const parents = new Map<string, SymbolRef[]>();
  const childOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const missing: SymbolRef[] = [];
  const kids = new Map<string, { child: string; via: SymbolRef }[]>();
  for (const { name, doc } of sheets) {
    const list: { child: string; via: SymbolRef }[] = [];
    for (const o of doc.objects) {
      if (!isSymbol(o)) continue;
      const n = symbolNames(doc, o.index);
      const via: SymbolRef = { sheet: name, index: o.index, ...n };
      // A symbol may stand for several sheets (File Name a;b), off-sheet connectors joining them
      const files = n.fileName.split(';').map((f) => f.trim()).filter(Boolean);
      const found = [...new Set((files.length ? files : [n.fileName]).map((f) => resolveSheet(names, f)).filter((c): c is string => !!c))];
      if (!found.length) { missing.push(via); continue; }
      childOf.set(`${name}:${o.index}`, found[0]!);
      childrenOf.set(`${name}:${o.index}`, found);
      for (const child of found) {
        const k = child.toLowerCase();
        parents.set(k, [...(parents.get(k) ?? []), via]);
        list.push({ child, via });
      }
    }
    const at = (n: string) => names.findIndex((x) => x.toLowerCase() === n.toLowerCase());
    list.sort((a, b) => (order === 'documents' ? at(a.child) - at(b.child) || a.via.index - b.via.index : natural(a.via.designator, b.via.designator)));
    kids.set(name, list);
  }
  const tree = (sheet: string, via: SymbolRef | undefined, seen: Set<string>): HierNode => {
    const next = new Set(seen).add(sheet.toLowerCase());
    const children = (kids.get(sheet) ?? []).filter((c) => !next.has(c.child.toLowerCase())).map((c) => tree(c.child, c.via, next));
    return { sheet, via, children };
  };
  const roots = names.filter((n) => !parents.has(n.toLowerCase())).map((n) => tree(n, undefined, new Set()));
  return { roots, missing, parents, childOf, childrenOf };
}

/** Every sheet of a tree, depth first. */
export function flattenTree(nodes: readonly HierNode[], depth = 0, out: { node: HierNode; depth: number }[] = []): { node: HierNode; depth: number }[] {
  for (const n of nodes) { out.push({ node: n, depth }); flattenTree(n.children, depth + 1, out); }
  return out;
}

/** Reports › Report Project Hierarchy: the sheet tree as a .REP text. */
export function hierarchyReport(project: string, roots: readonly HierNode[], when = new Date()): string {
  const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s + ' '.repeat(n - s.length));
  const lines = [`Design Hierarchy Report for ${project} -- ${when.toLocaleDateString(locale())} ${when.toLocaleTimeString(locale())}`, '-'.repeat(78), '', project];
  for (const { node, depth } of flattenTree(roots)) {
    const indent = '   '.repeat(depth + 1);
    const label = node.via ? `${pad(indent + node.via.designator, 40)}${pad(node.sheet, 28)}` : pad(indent + node.sheet, 68);
    lines.push(`${label}SCH (${node.sheet})`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Input ↔ Output (Unspecified and Bidirectional stay). */
export const toggledIo = (io: number) => (io === 1 ? 2 : io === 2 ? 1 : io);
