/**
 * Parts from a database library's records: which symbol and footprints a record names (the
 * fields mapped to [Library Ref] / [Library Path], [Footprint Ref] / [Footprint Path] and their
 * numbered seconds), the parameters it gives a placed part (by the field mappings' Add To Design,
 * Visible On Add and the library's default actions), the record a part finds again (the single
 * key lookup, or the Where clause with its {parameters}), and the records a placed part has.
 */
import { effectiveMaps, type DbTable } from '../formats/altium/dbFile';
import type { DbDefaults } from '../formats/altium/dblib';
import type { DataTable } from '../formats/table';
import { PropertyBag } from '../formats/altium/props';
import { footprintModelBag } from './libModels';
import { SR } from './sch';
import { partRecords } from './schPlace';
import { uniqueId } from './schEdit';

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const isBracketed = (p: string) => /^\[.*\]$/.test(p.trim());

/** The field a bracketed name is mapped from (or, with no mapping, the column of that name). */
function fieldFor(t: DbTable, columns: string[], name: string): string | undefined {
  const m = t.maps.find((x) => same(x.parameter, `[${name}]`));
  if (m) return m.field;
  return columns.find((c) => same(c, name));
}

export interface RecordModels { libRef: string; libPath: string; description: string; footprints: { ref: string; path: string }[] }

/** What a record names: its symbol, description and footprints (the first the current one). */
export function recordModels(t: DbTable, columns: string[], row: Record<string, string>): RecordModels {
  const val = (name: string) => { const f = fieldFor(t, columns, name); return f ? (row[f] ?? '').trim() : ''; };
  const footprints: { ref: string; path: string }[] = [];
  for (let i = 1; i <= 32; i++) {
    const n = i === 1 ? '' : ` ${i}`;
    const ref = val(`Footprint Ref${n}`);
    if (ref) footprints.push({ ref, path: val(`Footprint Path${n}`) });
    else if (i > 2 && !fieldFor(t, columns, `Footprint Ref${n}`)) break;
  }
  return { libRef: val('Library Ref'), libPath: val('Library Path'), description: val('Description'), footprints };
}

/** The record's key: the single key lookup's field value (else the first column's). */
export function recordKey(t: DbTable, columns: string[], row: Record<string, string>): string {
  const f = t.keyField && columns.some((c) => same(c, t.keyField)) ? columns.find((c) => same(c, t.keyField))! : columns[0] ?? '';
  return (row[f] ?? '').trim();
}

/** The parameters a placed part takes from its record: the key's always, the others as Add To Design says. */
export function recordParams(t: DbTable, columns: string[], row: Record<string, string>, defaults: DbDefaults): { name: string; value: string; visible: boolean }[] {
  const out: { name: string; value: string; visible: boolean }[] = [];
  for (const m of effectiveMaps(t, columns)) {
    if (!m.parameter || isBracketed(m.parameter)) continue;
    const value = row[m.field] ?? '';
    const key = same(m.field, t.keyField);
    const mode = m.add === 'Default' ? defaults.add : m.add;
    if (!key && (mode === 'Do not add' || (mode === 'Add only if not blank' && value.trim() === ''))) continue;
    if (out.some((p) => same(p.name, key ? t.keyParameter || m.parameter : m.parameter))) continue;
    out.push({ name: key ? t.keyParameter || m.parameter : m.parameter, value, visible: m.visible });
  }
  return out;
}

/* ─── Where clauses ─────────────────────────────────────────────────────────────────── */

type Tok = { k: 'id' | 'str' | 'num' | 'param' | 'op' | 'lp' | 'rp' | 'and' | 'or' | 'not'; v: string };
function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '[' || c === '`' || c === '"') { const close = c === '[' ? ']' : c; const j = s.indexOf(close, i + 1); out.push({ k: 'id', v: s.slice(i + 1, j < 0 ? s.length : j) }); i = j < 0 ? s.length : j + 1; continue; }
    if (c === "'") { let v = ''; i++; while (i < s.length) { if (s[i] === "'" && s[i + 1] === "'") { v += "'"; i += 2; } else if (s[i] === "'") { i++; break; } else v += s[i++]; } out.push({ k: 'str', v }); continue; }
    if (c === '{') { const j = s.indexOf('}', i); out.push({ k: 'param', v: s.slice(i + 1, j < 0 ? s.length : j) }); i = j < 0 ? s.length : j + 1; continue; }
    if (c === '(') { out.push({ k: 'lp', v: c }); i++; continue; }
    if (c === ')') { out.push({ k: 'rp', v: c }); i++; continue; }
    const op = /^(<>|!=|<=|>=|=|<|>)/.exec(s.slice(i));
    if (op) { out.push({ k: 'op', v: op[1]! }); i += op[1]!.length; continue; }
    const w = /^[^\s()=<>!'[{]+/.exec(s.slice(i))![0];
    if (/^and$/i.test(w)) out.push({ k: 'and', v: w });
    else if (/^or$/i.test(w)) out.push({ k: 'or', v: w });
    else if (/^not$/i.test(w)) out.push({ k: 'not', v: w });
    else if (/^like$/i.test(w)) out.push({ k: 'op', v: 'LIKE' });
    else if (/^-?\d+(\.\d+)?$/.test(w)) out.push({ k: 'num', v: w });
    else out.push({ k: 'id', v: w });
    i += w.length;
  }
  return out;
}

/**
 * Whether a record matches a Where clause for a part: [Field] = 'text {Param}' AND …, OR, NOT,
 * brackets, =, <>, <, >, <=, >=, LIKE (% and _); text compared without case, numbers as numbers.
 */
export function whereMatches(where: string, params: (name: string) => string | undefined, row: Record<string, string>): boolean {
  const ts = tokens(where);
  let i = 0;
  const subst = (s: string) => s.replace(/\{([^}]*)\}/g, (_, n: string) => params(n) ?? '');
  const field = (n: string) => { const k = Object.keys(row).find((c) => same(c, n)); return k === undefined ? undefined : row[k] ?? ''; };
  const operand = (): string | undefined => {
    const t = ts[i++];
    if (!t) return undefined;
    if (t.k === 'str') return subst(t.v);
    if (t.k === 'param') return params(t.v) ?? '';
    if (t.k === 'num') return t.v;
    if (t.k === 'id') return field(t.v) ?? t.v;
    return undefined;
  };
  const compare = (a: string, op: string, b: string): boolean => {
    if (op === 'LIKE') {
      const re = new RegExp(`^${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`, 'is');
      return re.test(a);
    }
    const na = Number(a), nb = Number(b);
    const num = a.trim() !== '' && b.trim() !== '' && !Number.isNaN(na) && !Number.isNaN(nb);
    const c = num ? Math.sign(na - nb) : a.trim().toLowerCase().localeCompare(b.trim().toLowerCase());
    return op === '=' ? c === 0 : op === '<>' || op === '!=' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
  };
  const primary = (): boolean => {
    if (ts[i]?.k === 'not') { i++; return !primary(); }
    if (ts[i]?.k === 'lp') { i++; const v = or(); if (ts[i]?.k === 'rp') i++; return v; }
    const a = operand();
    const op = ts[i]?.k === 'op' ? ts[i++]!.v : '=';
    const b = operand();
    return a !== undefined && b !== undefined && compare(a, op, b);
  };
  const and = (): boolean => { let v = primary(); while (ts[i]?.k === 'and') { i++; const w = primary(); v = v && w; } return v; };
  const or = (): boolean => { let v = and(); while (ts[i]?.k === 'or') { i++; const w = and(); v = v || w; } return v; };
  try { return ts.length ? or() : false; } catch { return false; }
}

/** The record a part finds in a table: by the single key lookup, or by the Where clause. */
export function findDbRecord(t: DbTable, data: DataTable, params: (name: string) => string | undefined): Record<string, string> | undefined {
  if (t.useWhere && t.where.trim()) return data.rows.find((r) => whereMatches(t.where, params, r));
  const key = params(t.keyParameter || t.keyField);
  if (!key) return undefined;
  const col = data.columns.find((c) => same(c, t.keyField)) ?? data.columns[0];
  return col ? data.rows.find((r) => same(r[col] ?? '', key)) : undefined;
}

/* ─── A placed part ─────────────────────────────────────────────────────────────────── */

/**
 * A record as the records a placed part has: the symbol's, its component marked as from the
 * library and table (SOURCELIBRARYNAME, DATABASETABLENAME, DESIGNITEMID the key), the record's
 * description, its parameters (shown when Visible On Add, stacked under the part [est: where AD
 * puts them]) and its footprints in place of the symbol's.
 */
export function dbPartRecords(symbol: { libRef: string; bags: PropertyBag[] }, libraryName: string, t: DbTable, columns: string[], row: Record<string, string>,
  defaults: DbDefaults, part = 1): { bag: PropertyBag; owner: number }[] {
  const items = partRecords(symbol, libraryName, part);
  const comp = items[0]?.bag;
  if (!comp) return items;
  const models = recordModels(t, columns, row);
  comp.set('DATABASETABLENAME', t.name);
  comp.set('DESIGNITEMID', recordKey(t, columns, row) || symbol.libRef);
  if (models.description) comp.set('COMPONENTDESCRIPTION', models.description);
  // Parameters: the symbol's own take the record's values, the others are added
  const loc = (b: PropertyBag) => ({ x: b.int('LOCATION.X'), y: b.int('LOCATION.Y') });
  const texts = items.filter((it) => it.owner === 0 && (it.bag.int('RECORD', -1) === SR.PARAMETER || it.bag.int('RECORD', -1) === SR.DESIGNATOR)).map((it) => loc(it.bag));
  let y = Math.min(0, ...texts.map((p) => p.y)) - 10;
  const x = texts.length ? Math.min(...texts.map((p) => p.x)) : 0;
  for (const p of recordParams(t, columns, row, defaults)) {
    const have = items.find((it) => it.owner === 0 && it.bag.int('RECORD', -1) === SR.PARAMETER && same(it.bag.get('NAME') ?? '', p.name));
    if (have) { have.bag.set('TEXT', p.value); continue; }
    const b = PropertyBag.from({ RECORD: SR.PARAMETER, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, ...(p.visible ? {} : { ISHIDDEN: 'T' }), NAME: p.name, TEXT: p.value, UNIQUEID: uniqueId() });
    b.set('LOCATION.X', String(x)); b.set('LOCATION.Y', String(p.visible ? y : 0));
    if (p.visible) y -= 10;
    items.push({ bag: b, owner: 0 });
  }
  if (!models.footprints.length) return items;
  // The record's footprints replace the symbol's
  const drop = new Set<number>();
  items.forEach((it, i) => { if (it.bag.int('RECORD', -1) === SR.IMPLEMENTATION && (it.bag.get('MODELTYPE') ?? '').toUpperCase() === 'PCBLIB') drop.add(i); });
  let grew = true;
  while (grew) { grew = false; items.forEach((it, i) => { if (!drop.has(i) && drop.has(it.owner)) { drop.add(i); grew = true; } }); }
  const keep: { bag: PropertyBag; owner: number }[] = [];
  const at = new Map<number, number>();
  items.forEach((it, i) => { if (drop.has(i)) return; at.set(i, keep.length); keep.push({ bag: it.bag, owner: it.owner < 0 ? it.owner : at.get(it.owner) ?? 0 }); });
  let list = keep.findIndex((it) => it.owner === 0 && it.bag.int('RECORD', -1) === SR.IMPLEMENTATION_LIST);
  if (list < 0) { keep.push({ bag: PropertyBag.from({ RECORD: SR.IMPLEMENTATION_LIST }), owner: 0 }); list = keep.length - 1; }
  models.footprints.forEach((f, k) => {
    const impl = footprintModelBag(list, { name: f.ref, current: k === 0, library: f.path });
    impl.delete('OWNERINDEX');
    keep.push({ bag: impl, owner: list });
    const idx = keep.length - 1;
    keep.push({ bag: PropertyBag.from({ RECORD: SR.MAP_DEFINER_LIST }), owner: idx }, { bag: PropertyBag.from({ RECORD: SR.IMPL_PARAMS }), owner: idx });
  });
  return keep;
}
