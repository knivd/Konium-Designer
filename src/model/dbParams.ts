/**
 * Tools › Update Parameters From Database: each part's record found in the link's (or its
 * database library's) enabled tables — by the single key lookup or the Where clause — then each
 * mapped field compared with the part's parameter: a different value is a Modify (as Update
 * Values says), a missing parameter an Add (as Add To Design says). A part placed from a
 * database library looks only in its own table. The changes are offered for choosing, as AD's
 * Select Parameter Changes.
 */
import { effectiveMaps, type DbTable, type FieldMap } from '../formats/altium/dbFile';
import type { DbDefaults } from '../formats/altium/dblib';
import type { DataTable } from '../formats/table';
import { findDbRecord } from './dbLibParts';

export interface DbPart {
  sheet: string; index: number; designator: string; params: Map<string, { name: string; value: string }>;
  /** Placed from a database library: its name and table (SOURCELIBRARYNAME, DATABASETABLENAME). */
  library?: string; table?: string;
}
export interface ParamChange { sheet: string; index: number; designator: string; parameter: string; from: string | null; to: string; table: string }
/** A link or a database library: its tables' lookups and mappings, and what Default means. */
export interface DbSourceLike { tables: DbTable[]; defaults: DbDefaults }

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The record a part finds: the table and row, and the table's mappings, or null. */
export function findRecord(src: DbSourceLike, tables: DataTable[], part: DbPart, only?: string): { table: DataTable; row: Record<string, string>; map: FieldMap[]; def: DbTable } | null {
  const param = (n: string) => part.params.get(n.trim().toUpperCase())?.value;
  for (const t of src.tables) {
    if (!t.enabled || (only !== undefined && !same(t.name, only))) continue;
    const data = tables.find((d) => same(d.name, t.name));
    if (!data) continue;
    const row = findDbRecord(t, data, param);
    if (row) return { table: data, row, map: effectiveMaps(t, data.columns), def: t };
  }
  return null;
}

export function dbParamChanges(parts: DbPart[], src: DbSourceLike, tables: DataTable[], onlyTable?: (p: DbPart) => string | undefined): { changes: ParamChange[]; matched: number; unmatched: string[] } {
  const changes: ParamChange[] = [];
  const unmatched: string[] = [];
  let matched = 0;
  for (const part of parts) {
    const hit = findRecord(src, tables, part, onlyTable?.(part));
    if (!hit) { unmatched.push(part.designator); continue; }
    matched++;
    for (const m of hit.map) {
      if (!m.parameter || /^\[.*\]$/.test(m.parameter.trim()) || same(m.field, hit.def.keyField)) continue;
      const value = hit.row[m.field] ?? '';
      const cur = part.params.get(m.parameter.toUpperCase());
      if (cur) {
        const mode = m.update === 'Default' ? src.defaults.update : m.update;
        if (mode === 'Update' && cur.value !== value) changes.push({ sheet: part.sheet, index: part.index, designator: part.designator, parameter: cur.name, from: cur.value, to: value, table: hit.table.name });
      } else {
        const mode = m.add === 'Default' ? src.defaults.add : m.add;
        if (mode === 'Add' || (mode === 'Add only if not blank' && value !== '')) changes.push({ sheet: part.sheet, index: part.index, designator: part.designator, parameter: m.parameter, from: null, to: value, table: hit.table.name });
      }
    }
  }
  return { changes, matched, unmatched };
}
