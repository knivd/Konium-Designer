/**
 * BOM documents (.BomDoc, AD's ActiveBOM): a project's bill of materials kept as a document. AD
 * writes one record a line ("|RECORD=…|KEY=VALUE…", ANSI): the BOM's own (currency, production
 * quantity), its options (columns shown with their widths, "!" between them; sort; grouping;
 * not-fitted parts; database parameters; line numbering), then a CatalogItem for each BOM line
 * AD has settled (by its design item — library and library reference — and the hash of its
 * comment and description), each followed by its part choices (PartChoice: manufacturer and part
 * number, a supplier and its part number, stock, price breaks P1/Q1 …) and PartChoiceGroups.
 * The parts themselves always come from the project as compiled now.
 *
 * Every record is kept as read and written back as it was, unless changed. Konium's BOM
 * documents of 26.043–26.091 (INI, [ActiveBOM]) are read too and saved as AD's.
 */
import { binToBytes, bytesToBin } from '../text';
import { PropertyBag } from './props';
import { defaultBomSetup, type BomSetup } from '../../model/bom';

export interface BomCatalogItem {
  /** RECORD=CatalogItem: ITEMTYPE, UNIQUEID (library\design item), DESIGNITEMID, ITEMSOURCE, LINENUMBER, NOTE … */
  bag: PropertyBag;
  /** RECORD=PartChoice, best first. */
  choices: PropertyBag[];
  /** RECORD=PartChoiceGroups (and anything else that followed the item), kept. */
  rest: PropertyBag[];
}

export interface BomDocument {
  kind: 'BomDoc';
  name: string;
  /** The records before the first item: BOM, the options, Catalog. */
  head: PropertyBag[];
  items: BomCatalogItem[];
  /** Line ending as read (AD: CR LF). */
  eol: string;
  setup: BomSetup;
  /** Column widths as AD keeps them (pixels), by column. */
  widths: Record<string, number>;
  /** The variant the BOM is for ('' = [No Variations]). */
  variant: string;
  /** Not-fitted parts listed (marked) rather than left out. */
  showNotFitted: boolean;
  /** Include Parameters From Database: the fields of each part's record in the project's database links. */
  includeDb: boolean;
  /** Production Quantity: boards to build (prices and stock are for this many). */
  production: number;
  currency: string;
  dirty: boolean;
}

/** AD's column names for Konium's where they differ [est: Design Item ID]. */
const AD_NAME: Record<string, string> = { LibRef: 'Design Item ID' };
const FROM_AD: Record<string, string> = Object.fromEntries(Object.entries(AD_NAME).map(([k, v]) => [v, k]));

const rec = (d: BomDocument, kind: string) => d.head.find((b) => b.get('RECORD') === kind);
/** A record of the head, made (in AD's order) if the file had none. */
function headRec(d: BomDocument, kind: string): PropertyBag {
  let b = rec(d, kind);
  if (!b) {
    b = PropertyBag.from({ RECORD: kind }, false);
    const at = d.head.findIndex((x) => x.get('RECORD') === 'Catalog');
    d.head.splice(at < 0 ? d.head.length : at, 0, b);
  }
  return b;
}
const setIf = (b: PropertyBag, key: string, value: string) => { if (b.get(key) !== value) b.set(key, value); };

/** "Line #=53!Designator=277!…": the columns and their widths. */
function readOrder(s: string): { columns: string[]; widths: Record<string, number> } {
  const columns: string[] = [], widths: Record<string, number> = {};
  for (const part of s.split('!')) {
    if (!part) continue;
    const eq = part.lastIndexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    const col = FROM_AD[name] ?? name;
    columns.push(col);
    if (eq >= 0) widths[col] = Number(part.slice(eq + 1)) || 100;
  }
  return { columns, widths };
}
const writeOrder = (columns: string[], widths: Record<string, number>) => columns.map((c) => `${AD_NAME[c] ?? c}=${widths[c] ?? 100}`).join('!');

export function readBomDoc(bytes: Uint8Array, name: string): BomDocument {
  const text = bytesToBin(bytes);
  if (/^\s*\[ActiveBOM\]/.test(text)) return readKoniumIni(text, name);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const d: BomDocument = { kind: 'BomDoc', name, head: [], items: [], eol, setup: defaultBomSetup(), widths: {}, variant: '', showNotFitted: false, includeDb: false, production: 1, currency: 'USD', dirty: false };
  for (const line of text.split(eol)) {
    if (!line.startsWith('|')) continue;
    const b = PropertyBag.parse(binToBytes(line));
    const kind = b.get('RECORD') ?? '';
    const last = d.items[d.items.length - 1];
    if (kind === 'CatalogItem') d.items.push({ bag: b, choices: [], rest: [] });
    else if (kind === 'PartChoice' && last) last.choices.push(b);
    else if (last) last.rest.push(b);
    else d.head.push(b);
  }
  const bom = rec(d, 'BOM'), opts = rec(d, 'GeneralOptions');
  d.production = Math.max(1, bom?.int('PRODUCTIONQUANTITY', 1) ?? 1);
  d.currency = bom?.get('CURRENCY') || 'USD';
  d.variant = bom?.get('VARIANTNAME') ?? '';
  d.showNotFitted = opts?.bool('NOTFITTED') ?? false;
  d.includeDb = opts?.bool('INCLUDEDBPARAMETERS') ?? false;
  const order = readOrder(rec(d, 'VisibleOrderOptions')?.get('VISIBLEORDER') ?? '');
  if (order.columns.length) { d.setup.columns = order.columns; d.widths = order.widths; }
  const group = rec(d, 'GroupOrderOptions');
  if (group) d.setup.group = (group.get('GROUPORDER') ?? '').split('!').map((g) => g.split('=')[0]!).filter(Boolean).map((g) => FROM_AD[g] ?? g);
  const sort = (rec(d, 'SortOrderOptions')?.get('SORTORDER') ?? '').split('!')[0] ?? '';
  if (sort) { const [c, dir] = sort.split('='); d.setup.sort = { column: FROM_AD[c!] ?? c!, descending: /^down$/i.test(dir ?? '') }; }
  return d;
}

/** Konium's own BOM documents before 26.092: INI. */
function readKoniumIni(text: string, name: string): BomDocument {
  const kv = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) { const eq = line.indexOf('='); if (eq > 0 && !line.startsWith('[')) kv.set(line.slice(0, eq).toLowerCase(), line.slice(eq + 1)); }
  const list = (k: string) => { const n = Number(kv.get(`${k}count`) ?? 0); return Array.from({ length: n }, (_, i) => kv.get(`${k}${i + 1}`) ?? '').filter(Boolean); };
  const d = newBomDoc(name);
  const columns = list('column'), group = list('group');
  const sortCol = kv.get('sortcolumn') ?? '';
  d.variant = kv.get('variantname') ?? '';
  d.showNotFitted = kv.get('shownotfitted') === '1';
  d.includeDb = kv.get('includedbparameters') === '1';
  d.setup = { columns: columns.length ? columns : d.setup.columns, group: kv.has('groupcount') ? group : d.setup.group, ...(sortCol ? { sort: { column: sortCol, descending: kv.get('sortdescending') === '1' } } : {}) };
  d.dirty = false;
  return d;
}

export function writeBomDoc(d: BomDocument): Uint8Array {
  const bom = headRec(d, 'BOM');
  setIf(bom, 'CURRENCY', d.currency);
  setIf(bom, 'PRODUCTIONQUANTITY', String(d.production));
  if (d.variant || bom.has('VARIANTNAME')) setIf(bom, 'VARIANTNAME', d.variant);
  const opts = headRec(d, 'GeneralOptions');
  setIf(opts, 'NOTFITTED', d.showNotFitted ? 'True' : 'False');
  setIf(opts, 'INCLUDEDBPARAMETERS', d.includeDb ? 'True' : 'False');
  setIf(headRec(d, 'SortOrderOptions'), 'SORTORDER', d.setup.sort ? `${AD_NAME[d.setup.sort.column] ?? d.setup.sort.column}=${d.setup.sort.descending ? 'Down' : 'Up'}` : '');
  setIf(headRec(d, 'GroupOrderOptions'), 'GROUPORDER', d.setup.group.map((g) => AD_NAME[g] ?? g).join('!'));
  const order = writeOrder(d.setup.columns, d.widths);
  setIf(headRec(d, 'VisibleOrderOptions'), 'VISIBLEORDER', order);
  const v2 = rec(d, 'VisibleOrderOptions2');
  if (v2) setIf(v2, 'BASEVIEW', order);
  const lines: string[] = [];
  for (const b of d.head) lines.push(bytesToBin(b.toBytes()));
  for (const it of d.items) for (const b of [it.bag, ...it.choices, ...it.rest]) lines.push(bytesToBin(b.toBytes()));
  return binToBytes(lines.join(d.eol) + d.eol);
}

/** A new document's columns: the parts, then their manufacturer, supplier and cost, as AD shows them. */
export const NEW_COLUMNS = ['Line #', 'Comment', 'Description', 'Designator', 'Footprint', 'Quantity', 'Manufacturer 1', 'Manufacturer Part Number 1', 'Supplier 1',
  'Supplier Part Number 1', 'Supplier Stock 1', 'Supplier Unit Price 1', 'Supplier Subtotal 1'];

/** A new BOM document, with AD's records and its defaults. */
export function newBomDoc(name: string, when = new Date()): BomDocument {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stem = name.replace(/\.[^.]+$/, '');
  const head: [string, Record<string, string>][] = [
    ['BOM', { VERSION: '3', FILENAME: `${stem}.$$$`, KIND: 'ALTIUM_DESIGNER_LIVEBOM', DATE: `${p2(when.getDate())}.${p2(when.getMonth() + 1)}.${when.getFullYear()}`,
      TIME: `${p2(when.getHours())}:${p2(when.getMinutes())}:${p2(when.getSeconds())}`, CURRENCY: 'USD', PRODUCTIONQUANTITY: '1', PERUNITTARGETPRICE: '0', PERUNITACTUALPRICE: '0' }],
    ['GeneralOptions', { OPENEXPORTED: 'False', ADDTOPROJECT: 'False', FORCEFIT: 'False', NOTFITTED: 'False', TEMPLATEFILENAME: '', BATCHMODE: '0', SUPPLIERPRODQTY: '0', SUPPLIERAUTOQTY: 'False',
      SUPPLIERUSECACHEDPRICING: 'False', SUPPLIERCURRENCY: '', SOLUTIONSPERITEM: '1', SUPPLIERSPERSOLUTION: '1', DISPLAYTOTALROW: 'False', DISPLAYSUBTOTALSFORGROUPS: 'False',
      INCLUDEPCBPARAMETERS: 'False', INCLUDEDBPARAMETERS: 'False', INCLUDEVAULTPARAMETERS: 'False', INCLUDECLOUDPARAMETERS: 'False', INCLUDEDOCUMENTPARAMETERS: 'False', FILTEROUTRISKYSOLUTIONS: 'True', DESIGNATORGROUPING: 'No' }],
    ['SortOrderOptions', { SORTORDER: 'Designator=Up' }], ['GroupOrderOptions', { GROUPORDER: '' }], ['VisibleOrderOptions', { VISIBLEORDER: '' }],
    ['CustomColumns', { CUSTOMCOLUMNS: '' }], ['ColumnsAliases', { COLUMNSALIASES: '' }], ['FilterOptions', { FILTER: '' }],
    ['CheckGroupCompParamsOptions', { CHECKGROUPCOMPPARAMS: 'Comment=0,Description=0,Value=0,Footprint=1' }], ['ManufacturerLinkOptions', { MANUFACTURERLINKPARAMETERS: '' }],
    ['FavoriteSuppliers', { PARTSOURCES: '', SUPPLIERS: '', USESUPPLIERORDER: 'False' }], ['CheckOptions', { CHECKLEVELS: '' }], ['LineNumberingOptions', { STARTVALUE: '1', INCREMENT: '1' }],
    ['Catalog', { DBLINKFILEPATH: '' }],
  ];
  const setup = defaultBomSetup();
  return {
    kind: 'BomDoc', name, head: head.map(([r, o]) => PropertyBag.fromEntries([['RECORD', r], ...Object.entries(o)], false)), items: [], eol: '\r\n',
    setup: { ...setup, group: [], columns: NEW_COLUMNS, sort: { column: 'Designator', descending: false } }, widths: {}, variant: '', showNotFitted: false, includeDb: false, production: 1, currency: 'USD', dirty: true,
  };
}

/** Which parameters must match for parts to share a line (CHECKGROUPCOMPPARAMS: Footprint=1 …). */
export function groupCheckParams(d: BomDocument): string[] {
  const s = rec(d, 'CheckGroupCompParamsOptions')?.get('CHECKGROUPCOMPPARAMS') ?? 'Footprint=1';
  return s.split(',').map((x) => x.split('=')).filter(([, v]) => v === '1').map(([k]) => k!);
}

/** Line numbering: where it starts and its step. */
export function lineNumbering(d: BomDocument): { start: number; step: number } {
  const b = rec(d, 'LineNumberingOptions');
  return { start: b?.int('STARTVALUE', 1) || 1, step: b?.int('INCREMENT', 1) || 1 };
}
