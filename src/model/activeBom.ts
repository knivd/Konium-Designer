/**
 * ActiveBOM, as a BOM document has it: the project's parts in lines (grouped as its columns say),
 * each line tied to its catalog item (by design item and the hash of its comment and
 * description, as AD ties them), the item's part choices — manufacturer parts and their
 * suppliers, best first — and from those the columns AD derives (Manufacturer 1, Supplier Unit
 * Price 1 …), the cost of the production run, and the BOM checks.
 *
 * A line with no part choices of its own takes one from its parts' parameters, as AD's
 * schematic supplier links: Manufacturer 1 / Manufacturer Part Number 1 (or Manufacturer and
 * MPN …), and an LCSC part number (LCSC, LCSC Part #, JLCPCB Part # …) as a supplier.
 */
import type { SupplierPart } from './suppliers';
import { FORMERS_UP } from '../core/former';
/** A part choice's JLCPCB library as BOMs saved under the app's earlier names keep it. */
const FORMER_JLC = FORMERS_UP.map((f) => `${f}JLCLIBRARY`);
import { PropertyBag } from '../formats/altium/props';
import { groupCheckParams, lineNumbering, type BomCatalogItem, type BomDocument } from '../formats/altium/bomdoc';
import { natural, type BomSetup } from './bom';

/* ─── Lines ─── */

/** A part's design item: its library and library reference (AD's UNIQUEID for a part not from a server). */
export interface DesignKey { library: string; libRef: string }
export const designKeys = new WeakMap<Record<string, string>, DesignKey>();

export interface BomLine {
  parts: Record<string, string>[];
  /** The line's catalog item, if the document has one. */
  item: BomCatalogItem | null;
  uid: string;
  hash: string;
  quantity: number;
  designators: string[];
}

/** AD's comma list: a value with a space, comma or quote in quotes [est]. */
export const adCsv = (vals: string[]) => vals.map((v) => (/[\s,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',');
export const uidOf = (k: DesignKey | undefined, it: Record<string, string>) => `${k?.library ?? ''}\\${k?.libRef ?? it.LibRef ?? ''}`;
export const hashOf = (it: Record<string, string>) => adCsv([it.Comment ?? '', it.Description ?? '']);

/**
 * The parts in lines: equal values of the grouped columns share one; with none grouped, as AD's
 * ActiveBOM: parts of one design item (library and library reference) with the same comment and
 * description.
 */
export function bomLines(items: Record<string, string>[], setup: BomSetup, d: BomDocument | null): BomLine[] {
  const groups = new Map<string, Record<string, string>[]>();
  items.forEach((it) => {
    const key = setup.group.length ? setup.group.map((g) => (it[g] ?? '').trim()).join('\u0001') : `${uidOf(designKeys.get(it), it).toLowerCase()}\u0001${hashOf(it)}`;
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); }
    g.push(it);
  });
  return [...groups.values()].map((parts) => {
    parts.sort((a, b) => natural(a.Designator ?? '', b.Designator ?? ''));
    const first = parts[0]!;
    const uid = uidOf(designKeys.get(first), first), hash = hashOf(first);
    return { parts, item: d ? itemFor(d, uid, hash) : null, uid, hash, quantity: parts.length, designators: parts.map((p) => p.Designator ?? '') };
  });
}

/** The catalog item of a design item and its hash (else the design item's only one with no hash). */
export function itemFor(d: BomDocument, uid: string, hash: string): BomCatalogItem | null {
  const same = d.items.filter((x) => (x.bag.get('UNIQUEID') ?? '').toLowerCase() === uid.toLowerCase());
  return same.find((x) => (x.bag.get('SELECTEDPARAMETERSHASH') ?? '') === hash) ?? same.find((x) => !x.bag.get('SELECTEDPARAMETERSHASH')) ?? null;
}

/** The line's catalog item, made (as AD makes one for a part from a file library) if it has none. */
export function ensureItem(d: BomDocument, line: BomLine): BomCatalogItem {
  if (line.item) return line.item;
  const first = line.parts[0]!;
  const k = designKeys.get(first);
  const params = Object.entries(first).filter(([key]) => !/^(Designator|Quantity|LibRef|Fitted)$/.test(key)).map(([key, v]) => `${key}=${v}`);
  const bag = PropertyBag.fromEntries([
    ['RECORD', 'CatalogItem'], ['ITEMTYPE', 'Automatic-NonVault'], ['UNIQUEID', line.uid], ['DESIGNITEMID', k?.libRef ?? first.LibRef ?? ''], ['ITEMSOURCE', k?.library ?? ''],
    ['STATUS', 'Unknown'], ['DESCRIPTION', first.Description ?? ''], ['USERCOMMENTS', first.Comment ?? ''], ['NOTE', ''], ['LINENUMBER', ''], ['SELECTEDPARAMETERSHASH', line.hash],
    ['COMPONENTPARAMETERS', adCsv(params)], ['CUSTOMPARAMETERS', ''],
  ], false);
  const item: BomCatalogItem = { bag, choices: [], rest: [PropertyBag.fromEntries([['RECORD', 'PartChoiceGroups'], ['GROUPBYFIELDCOUNT', '0']], false)] };
  d.items.push(item);
  line.item = item;
  return item;
}

/* ─── Part choices ─── */

export interface PriceBreak { qty: number; price: number }
export interface Choice {
  manufacturer: string;
  mpn: string;
  supplier: string;
  spn: string;
  stock?: number;
  prices: PriceBreak[];
  currency: string;
  lifecycle: string;
  url: string;
  description: string;
  /** JLCPCB's assembly library: Basic, Preferred or Extended. */
  library?: string;
  /** Where it came from: the document (a part choice) or the parts' parameters. */
  from: 'choice' | 'parameters';
  bag?: PropertyBag;
}

export function choiceOf(b: PropertyBag): Choice {
  const n = b.int('PRICECOUNT');
  const prices: PriceBreak[] = [];
  for (let i = 1; i <= n; i++) { const q = b.float(`Q${i}`, NaN), p = b.float(`P${i}`, NaN); if (Number.isFinite(q) && Number.isFinite(p)) prices.push({ qty: q, price: p }); }
  const stock = b.getRaw('AVAILABLEQUANTITY');
  return {
    manufacturer: b.get('MANUFACTURER') ?? '', mpn: b.get('MANUFACTURERPARTNO') ?? '', supplier: b.get('SUPPLIER') ?? '', spn: b.get('SUPPLIERPARTNO') ?? '',
    stock: stock === undefined || stock === '' ? undefined : Number(stock), prices: prices.sort((a, c) => a.qty - c.qty), currency: b.get('CURRENCY') || 'USD',
    lifecycle: b.get('LIFECYCLESTATUS') ?? '', url: b.get('SUPPLIERURL') ?? '', description: b.get('DESCRIPTION') ?? '', library: b.get('KONIUMJLCLIBRARY') || FORMER_JLC.map((k) => b.get(k)).find((v) => v) || undefined, from: 'choice', bag: b,
  };
}

/** A part choice record for a manufacturer part at a supplier [est: PARTCHOICETYPE MANUAL for one added by hand]. */
export function choiceBag(c: Omit<Choice, 'from' | 'bag'>, source = 'Konium', when = new Date()): PropertyBag {
  const e: [string, string][] = [
    ['RECORD', 'PartChoice'], ['PARTCHOICETYPE', 'MANUAL'], ['SUPPLIERSOURCE', source], ['MANUFACTURER', c.manufacturer], ['MANUFACTURERPARTNO', c.mpn],
    ['SUPPLIER', c.supplier], ['SUPPLIERPARTNO', c.spn], ['PROVIDERNAME', source], ['DESCRIPTION', c.description], ['AVAILABLEQUANTITY', c.stock === undefined ? '' : String(c.stock)],
    ['CURRENCY', c.currency], ['ORIGINALCURRENCY', c.currency], ['SUPPLIERURL', c.url], ['LIFECYCLESTATUS', c.lifecycle],
    // AD's date: days since 30 Dec 1899
    ['LASTUPDATEDAT', String(+(when.getTime() / 86_400_000 + 25_569).toFixed(10))],
    ...(c.library ? [['KONIUMJLCLIBRARY', c.library] as [string, string]] : []),
    ['PRICECOUNT', String(c.prices.length)], ...c.prices.flatMap((p, i) => [[`P${i + 1}`, String(p.price)], [`Q${i + 1}`, String(p.qty)], [`L${i + 1}`, 'US']] as [string, string][]),
  ];
  return PropertyBag.fromEntries(e, false);
}

/** Stock and prices updated in a part choice (the rest kept; a lifecycle status when given). */
export function refreshChoice(b: PropertyBag, c: Pick<Choice, 'stock' | 'prices' | 'currency' | 'library'> & { lifecycle?: string }, when = new Date()): void {
  if (c.stock !== undefined) b.set('AVAILABLEQUANTITY', String(c.stock));
  if (c.currency) b.set('CURRENCY', c.currency);
  if (c.lifecycle) b.set('LIFECYCLESTATUS', c.lifecycle);
  b.set('LASTUPDATEDAT', String(+(when.getTime() / 86_400_000 + 25_569).toFixed(10)));
  // The library key as saved under the app's earlier name, taken over
  const was = FORMER_JLC.map((k) => b.get(k)).find((v) => v);
  for (const k of FORMER_JLC) b.delete(k);
  if (c.library) b.set('KONIUMJLCLIBRARY', c.library);
  else if (was && !b.get('KONIUMJLCLIBRARY')) b.set('KONIUMJLCLIBRARY', was);
  if (!c.prices.length) return;
  const n = b.int('PRICECOUNT');
  for (let i = 1; i <= Math.max(n, c.prices.length); i++) for (const k of ['P', 'Q', 'L']) b.delete(`${k}${i}`);
  b.set('PRICECOUNT', String(c.prices.length));
  c.prices.forEach((p, i) => { b.set(`P${i + 1}`, String(p.price)); b.set(`Q${i + 1}`, String(p.qty)); b.set(`L${i + 1}`, 'US'); });
}

const param = (it: Record<string, string>, ...names: string[]) => {
  for (const n of names) for (const [k, v] of Object.entries(it)) if (k.toLowerCase() === n.toLowerCase() && v.trim() && v.trim() !== '*') return v.trim();
  return '';
};
/** An LCSC part number in a part's parameters (C25804). */
export const lcscOf = (it: Record<string, string>) => {
  const v = param(it, 'LCSC', 'LCSC Part', 'LCSC Part #', 'LCSC Part Number', 'LCSC#', 'JLCPCB Part #', 'JLCPCB Part', 'JLC Part', 'JLCPCB');
  const supplierLcsc = /lcsc|jlc/i.test(param(it, 'Supplier 1')) ? param(it, 'Supplier Part Number 1') : '';
  const m = /^C\d+$/i.exec(v || supplierLcsc);
  return m ? m[0].toUpperCase() : '';
};

/** The part choices of a line: its item's, else those its parts' parameters name. */
export function lineChoices(line: BomLine): Choice[] {
  if (line.item?.choices.length) return line.item.choices.map(choiceOf);
  const it = line.parts[0]!;
  const mpn = param(it, 'Manufacturer Part Number 1', 'Manufacturer Part Number', 'MPN', 'Mfr Part Number', 'Manufacturer Part', 'Part Number', 'Mfr. Part #');
  const manufacturer = param(it, 'Manufacturer 1', 'Manufacturer', 'Mfr', 'Mfr.');
  const lcsc = lcscOf(it);
  const supplier = lcsc ? 'LCSC' : param(it, 'Supplier 1', 'Supplier');
  const spn = lcsc || param(it, 'Supplier Part Number 1', 'Supplier Part Number');
  if (!mpn && !spn) return [];
  return [{ manufacturer, mpn, supplier, spn, prices: [], currency: 'USD', lifecycle: '', url: lcsc ? lcscUrl(lcsc) : '', description: '', from: 'parameters' }];
}

export const lcscUrl = (c: string) => `https://www.lcsc.com/product-detail/${c.toUpperCase()}.html`;

/** The price of one at a quantity: the break that quantity reaches (the first break when it reaches none). */
export function unitPrice(c: Choice, qty: number): number | undefined {
  if (!c.prices.length) return undefined;
  let p = c.prices[0]!.price;
  for (const b of c.prices) if (b.qty <= qty) p = b.price;
  return p;
}

/**
 * A part choice added to a line: the first one added goes first, the part its parameters name
 * kept as the next (unless it is the same part); later ones after those.
 */
export function addChoice(d: BomDocument, line: BomLine, b: PropertyBag): void {
  const before = lineChoices(line)[0];
  const it = ensureItem(d, line);
  it.choices.push(b);
  if (it.choices.length === 1 && before?.from === 'parameters' && (!before.mpn || before.mpn.toLowerCase() !== (b.get('MANUFACTURERPARTNO') ?? '').toLowerCase())) it.choices.push(choiceBag({ ...before }, 'Schematic'));
}

/* ─── Columns, cost ─── */

export const SUPPLY_COLUMNS = ['Line #', 'Manufacturer 1', 'Manufacturer Part Number 1', 'Manufacturer Lifecycle 1', 'Supplier 1', 'Supplier Part Number 1', 'Supplier Stock 1', 'Supplier Unit Price 1', 'Supplier Subtotal 1', 'JLCPCB Library 1'];
const money = (v: number | undefined, cur: string) => (v === undefined ? '' : `${cur === 'USD' ? '$' : cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : `${cur} `}${v < 1 ? v.toFixed(4) : v.toFixed(2)}`);

export interface LineCost { units: number; unit?: number; subtotal?: number; currency: string }
/** What a line costs for the run: each board's quantity times the boards, at the price for that many. */
export function lineCost(line: BomLine, production: number): LineCost {
  const c = lineChoices(line)[0];
  const units = line.quantity * production;
  const unit = c ? unitPrice(c, units) : undefined;
  return { units, unit, subtotal: unit === undefined ? undefined : unit * units, currency: c?.currency ?? 'USD' };
}

/** A supply column's value for a line. */
export function supplyCell(line: BomLine, col: string, production: number): string {
  const c = lineChoices(line)[0];
  switch (col) {
    case 'Line #': return line.item?.bag.get('LINENUMBER') ?? '';
    case 'Manufacturer 1': return c?.manufacturer ?? '';
    case 'Manufacturer Part Number 1': return c?.mpn ?? '';
    case 'Manufacturer Lifecycle 1': return c?.lifecycle ?? '';
    case 'Supplier 1': return c?.supplier ?? '';
    case 'Supplier Part Number 1': return c?.spn ?? '';
    case 'Supplier Stock 1': return c?.stock === undefined ? '' : String(c.stock);
    case 'Supplier Unit Price 1': { const k = lineCost(line, production); return money(k.unit, k.currency); }
    case 'Supplier Subtotal 1': { const k = lineCost(line, production); return money(k.subtotal, k.currency); }
    case 'JLCPCB Library 1': return c?.library ?? '';
  }
  return '';
}

/** Each line's cells, in the columns shown. */
export function lineCells(line: BomLine, columns: string[], production: number): string[] {
  return columns.map((col) => {
    if (SUPPLY_COLUMNS.includes(col)) return supplyCell(line, col, production);
    if (col === 'Quantity') return String(line.quantity);
    if (col === 'Designator') return line.designators.join(', ');
    return [...new Set(line.parts.map((x) => x[col] ?? ''))].filter((v) => v !== '').join(', ');
  });
}

/** Lines sorted as the setup says (else by designator); Line # and Quantity as numbers. */
export function sortLines(lines: BomLine[], setup: BomSetup, production: number): BomLine[] {
  const col = setup.sort?.column ?? 'Designator';
  const key = (l: BomLine) => lineCells(l, [col], production)[0]!;
  const numeric = col === 'Quantity' || col === 'Line #' || col === 'Supplier Stock 1';
  const money2 = /Price|Subtotal/.test(col);
  const num = (s: string) => (s === '' ? Infinity : Number(s.replace(/[^0-9.]/g, '')));
  return [...lines].sort((a, b) => ((numeric || money2) ? num(key(a)) - num(key(b)) : natural(key(a), key(b))) * (setup.sort?.descending ? -1 : 1));
}

/**
 * What the priced lines cost, a sum for each currency (prices in different currencies are never
 * added together: there is no exchange rate here). perBoard/run/currency: the first currency's.
 */
export interface BomTotals { perBoard?: number; run?: number; priced: number; lines: number; currency: string; mixed: boolean; byCurrency: { currency: string; perBoard: number; run: number; lines: number }[] }
export function bomTotals(lines: BomLine[], production: number): BomTotals {
  let priced = 0;
  const sums = new Map<string, { run: number; lines: number }>();
  for (const l of lines) {
    const k = lineCost(l, production);
    if (k.subtotal === undefined) continue;
    priced++;
    const s = sums.get(k.currency) ?? { run: 0, lines: 0 };
    s.run += k.subtotal; s.lines++;
    sums.set(k.currency, s);
  }
  const byCurrency = [...sums].map(([currency, s]) => ({ currency, run: s.run, perBoard: s.run / production, lines: s.lines })).sort((a, b) => b.lines - a.lines);
  const first = byCurrency[0];
  return { run: first?.run, perBoard: first?.perBoard, priced, lines: lines.length, currency: first?.currency ?? 'USD', mixed: byCurrency.length > 1, byCurrency };
}

/** A part found at Digi-Key or Mouser as a part choice. */
export function supplierChoiceBag(p: SupplierPart, when = new Date()): PropertyBag {
  return choiceBag({ manufacturer: p.manufacturer, mpn: p.mpn, supplier: p.supplier, spn: p.spn, stock: p.stock, prices: p.prices, currency: p.currency || 'USD', lifecycle: p.lifecycle, url: p.url, description: p.description }, p.supplier, when);
}

/* ─── Checks ─── */

export type CheckLevel = 'warning' | 'error';
export interface BomCheck { check: string; level: CheckLevel; line: BomLine | null; message: string }

/** Lifecycle states that make a part a risk to build with. */
const RISKY = /obsolete|end of life|\beol\b|nrnd|not recommended|last time buy|discontinued/i;

/**
 * AD's BOM checks [est: their names and levels]: no part choices, no suppliers, not enough
 * stock for the run, risky lifecycle, no price, duplicate designators, parts in one line whose
 * grouping parameters differ (Ambiguous parameters), missing or repeated line numbers.
 */
export function bomChecks(d: BomDocument | null, lines: BomLine[], production: number): BomCheck[] {
  const out: BomCheck[] = [];
  const name = (l: BomLine) => l.designators.slice(0, 3).join(', ') + (l.designators.length > 3 ? ` (+${l.designators.length - 3})` : '');
  const must = d ? groupCheckParams(d) : ['Footprint'];
  for (const l of lines) {
    const cs = lineChoices(l), c = cs[0];
    if (!c) { out.push({ check: 'No part choices', level: 'warning', line: l, message: `${name(l)}: no manufacturer part or supplier` }); continue; }
    if (!c.supplier) out.push({ check: 'No suppliers', level: 'warning', line: l, message: `${name(l)}: ${c.mpn || 'the part'} has no supplier` });
    else {
      const units = l.quantity * production;
      if (c.stock !== undefined && c.stock < units) out.push({ check: 'Insufficient stock', level: 'warning', line: l, message: `${name(l)}: ${c.supplier} has ${c.stock} of ${c.spn || c.mpn}, ${units} needed` });
      if (c.from === 'choice' && !c.prices.length) out.push({ check: 'No price', level: 'warning', line: l, message: `${name(l)}: no price from ${c.supplier}` });
    }
    if (c.lifecycle && RISKY.test(c.lifecycle)) out.push({ check: 'Risky lifecycle', level: 'error', line: l, message: `${name(l)}: ${c.mpn} is ${c.lifecycle}` });
    for (const p of must) {
      const vals = new Set(l.parts.map((x) => x[p] ?? ''));
      if (vals.size > 1) out.push({ check: 'Ambiguous parameters', level: 'warning', line: l, message: `${name(l)}: ${p} differs (${[...vals].join(' / ')})` });
    }
  }
  const seen = new Map<string, number>();
  for (const l of lines) for (const des of l.designators) if (des) seen.set(des, (seen.get(des) ?? 0) + 1);
  for (const [des, n] of seen) if (n > 1) out.push({ check: 'Duplicate designators', level: 'error', line: lines.find((l) => l.designators.includes(des)) ?? null, message: `${des} is used ${n} times` });
  const numbered = lines.filter((l) => l.item?.bag.get('LINENUMBER'));
  if (numbered.length) {
    for (const l of lines) if (!l.item?.bag.get('LINENUMBER')) out.push({ check: 'Missing line numbers', level: 'warning', line: l, message: `${name(l)}: no line number` });
    const nums = new Map<string, number>();
    for (const l of numbered) { const n = l.item!.bag.get('LINENUMBER')!; nums.set(n, (nums.get(n) ?? 0) + 1); }
    for (const [n, k] of nums) if (k > 1) out.push({ check: 'Duplicate line numbers', level: 'warning', line: numbered.find((l) => l.item!.bag.get('LINENUMBER') === n) ?? null, message: `Line ${n} is used ${k} times` });
  }
  return out;
}

/** Line numbers in the order shown, from the document's start value and step. */
export function setLineNumbers(d: BomDocument, lines: BomLine[]): void {
  const { start, step } = lineNumbering(d);
  lines.forEach((l, i) => { const it = ensureItem(d, l); it.bag.set('LINENUMBER', String(start + i * step)); });
}

/* ─── JLCPCB ─── */

/** The supplier part number for JLCPCB's assembly (its LCSC number), from the line's choices or parameters. */
export function jlcPart(line: BomLine): string {
  for (const c of lineChoices(line)) if (/lcsc|jlc/i.test(c.supplier) && /^C\d+$/i.test(c.spn)) return c.spn.toUpperCase();
  return lcscOf(line.parts[0]!);
}

/** JLCPCB's assembly BOM: Comment, Designator, Footprint, LCSC Part #. */
export function jlcBomCsv(lines: BomLine[]): string {
  const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ['Comment,Designator,Footprint,LCSC Part #', ...lines.map((l) => [l.parts[0]!.Comment ?? '', l.designators.join(','), l.parts[0]!.Footprint ?? '', jlcPart(l)].map(q).join(','))].join('\r\n') + '\r\n';
}

/** A package name in a footprint (0603, SOT-23, SOIC-8 …), for a search. */
export function packageOf(footprint: string): string {
  const f = footprint.toUpperCase();
  const chip = /(?:^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)(?![0-9])/.exec(f);
  if (chip) return chip[1]!;
  // IPC-7351 names: SOIC127P600X175-8N → SOIC-8
  const ipc = /(SOIC|SOP|SSOP|TSSOP|MSOP|QFN|DFN|LQFP|TQFP|QFP)\d+P\d+X\d+(?:X\d+)?-(\d+)/.exec(f);
  if (ipc) return `${ipc[1]}-${ipc[2]}`;
  const pkg = /(SOT-?23(?:-\d)?|SOT-?223|SOT-?89|SOD-?\d{2,3}|(?:SOIC|SOP|TSSOP|MSOP|QFN|LQFP|TQFP|DFN)-?\d{1,3}(?![\dP])|TO-?\d{2,3}|SMA|SMB|SMC)/.exec(f.replace(/_/g, '-'));
  return pkg ? pkg[1]! : '';
}

/** What to look a line's part up by: its LCSC number, else its part number, else its value and package. */
export function searchFor(line: BomLine): string {
  const it = line.parts[0]!;
  const lcsc = jlcPart(line);
  if (lcsc) return lcsc;
  const c = lineChoices(line)[0];
  if (c?.mpn) return c.mpn;
  const value = param(it, 'Value') || (it.Comment ?? '');
  return [value, packageOf(it.Footprint ?? '')].filter(Boolean).join(' ').trim();
}
