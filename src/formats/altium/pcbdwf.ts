/**
 * AD's Draftsman documents (.PCBDwf): chunks of [1][varint size][varint packed size][LZ4 block]
 * (1 MiB of text each; a 0 flag keeps a chunk as it is) holding the drawing as .NET DataContract
 * XML (namespace Altium.Designer.PcbDrawing.DataSerialization.V1): the board's data as AD last
 * imported it (assembly, fabrication, layer and drill information, BOM), the document's options,
 * styles and parameters, and its Pages — each a sheet (StandardSizeName, Size in WPF units of
 * 1/96 inch, Margin, zones) with its Items (views, tables, text …, by i:type), each item at a
 * Location (y down) with its Scale (Numenator / Denominator) and Rotation.
 *
 * Konium keeps the XML as it came (a lossless tree) and changes only what is edited: an item's
 * place, scale, side, title, text; items and pages added or removed. Items Konium makes beyond
 * the board assembly view use AD's type names as far as they are known [est].
 */
import { lz4Decode, lz4Encode } from '../lz4';
import { parseTree, writeTree, xattr, xfrom, xkid, xkids, xkidsNamed, xnum, xpath, xset, xstr, xtext, localName, type XNode } from '../xmlTree';

export const DWF_NS = 'http://schemas.datacontract.org/2004/07/Altium.Designer.PcbDrawing.DataSerialization.V1';
/** WPF units (1/96 inch) per millimetre. */
export const PX_PER_MM = 96 / 25.4;

export interface DraftDocument {
  kind: 'Draftsman';
  name: string;
  prolog: string;
  root: XNode;
  dirty: boolean;
  /** Undo and redo: each a change's way back (and forth). */
  undo: DraftChange[];
  redo: DraftChange[];
}
export interface DraftChange { label: string; undo: () => void; redo: () => void }

/* ─── The container ──────────────────────────────────────────────────────────────── */

function varint(b: Uint8Array, i: number): [number, number] {
  let v = 0, s = 0;
  for (;;) { const c = b[i++]!; v += (c & 0x7f) * 2 ** s; s += 7; if (!(c & 0x80)) return [v, i]; }
}
const putVarint = (out: number[], v: number) => { while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } out.push(v); };

export function unpackPcbDwf(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let i = 0, total = 0;
  while (i < b.length) {
    const flag = b[i++]!;
    let ulen: number, clen: number;
    [ulen, i] = varint(b, i);
    [clen, i] = varint(b, i);
    if (i + clen > b.length) throw new Error('Draftsman document: a chunk runs past the end');
    const body = b.subarray(i, i + clen);
    const part = flag === 1 ? lz4Decode(body, ulen) : body.slice();
    parts.push(part); total += part.length;
    i += clen;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function packPcbDwf(text: Uint8Array, chunk = 1 << 20): Uint8Array {
  const out: Uint8Array[] = [];
  for (let at = 0; at < text.length || at === 0; at += chunk) {
    const piece = text.subarray(at, Math.min(text.length, at + chunk));
    const packed = lz4Encode(piece);
    const head: number[] = [1];
    putVarint(head, piece.length); putVarint(head, packed.length);
    out.push(Uint8Array.from(head), packed);
    if (!text.length) break;
  }
  const size = out.reduce((s, p) => s + p.length, 0);
  const all = new Uint8Array(size);
  let o = 0;
  for (const p of out) { all.set(p, o); o += p.length; }
  return all;
}

/** A Draftsman document by its first chunk (the XML's start). */
export function isPcbDwf(b: Uint8Array): boolean {
  if (b.length < 8 || (b[0] !== 1 && b[0] !== 0)) return false;
  try {
    let i = 1, ulen: number, clen: number;
    [ulen, i] = varint(b, i);
    [clen, i] = varint(b, i);
    if (ulen > 64 << 20 || i + clen > b.length) return false;
    const first = b[0] === 1 ? lz4Decode(b.subarray(i, i + clen), ulen) : b.subarray(i, i + clen);
    return /^(﻿)?\s*<Document\b[^>]*PcbDrawing/.test(new TextDecoder().decode(first.subarray(0, 400)));
  } catch { return false; }
}

export function readPcbDwf(bytes: Uint8Array, name: string): DraftDocument {
  const text = new TextDecoder().decode(unpackPcbDwf(bytes));
  const { prolog, root } = parseTree(text);
  if (localName(root.name) !== 'Document') throw new Error(`${name}: not a Draftsman document`);
  return { kind: 'Draftsman', name, prolog, root, dirty: false, undo: [], redo: [] };
}

export function writePcbDwf(d: DraftDocument): Uint8Array {
  return packPcbDwf(new TextEncoder().encode(writeTree(d.root, d.prolog)));
}

/* ─── Pages and items ────────────────────────────────────────────────────────────── */

/** Standard sheets (landscape, mm) [AD's sizes]. */
export const SHEETS: Record<string, [number, number]> = {
  A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841],
  A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6],
  Letter: [279.4, 215.9], Legal: [355.6, 215.9], Tabloid: [431.8, 279.4],
};

export interface DraftPage {
  node: XNode;
  /** Size (WPF units), its standard name ('' for a custom size), margin, zones. */
  w: number; h: number; sizeName: string; margin: number; hZones: number; vZones: number; showZones: boolean;
}

export const pagesNode = (d: DraftDocument) => xkid(d.root, 'Pages');
export function draftPages(d: DraftDocument): DraftPage[] {
  return xkidsNamed(pagesNode(d), 'Page').map((node) => {
    const name = xstr(node, 'StandardSizeName');
    const std = SHEETS[name];
    const w = xnum(node, 'Size/Width', std ? std[0] * PX_PER_MM : 1122.52), h = xnum(node, 'Size/Height', std ? std[1] * PX_PER_MM : 793.7);
    return {
      node, w: w > 0 ? w : 1122.52, h: h > 0 ? h : 793.7, sizeName: name, margin: xnum(node, 'Margin/Left', 10),
      hZones: Math.max(0, xnum(node, 'HorizontalZoneCount', 8)), vZones: Math.max(0, xnum(node, 'VerticalZoneCount', 6)), showZones: xstr(node, 'ShowZones', 'true') !== 'false',
    };
  });
}

export const itemsNode = (page: XNode) => xkid(page, 'Items');
export const pageItems = (page: XNode): XNode[] => xkidsNamed(itemsNode(page), 'Item');
/** An item's type (its i:type, without a prefix). */
export const itemType = (it: XNode) => localName(xattr(it, 'type') ?? '');

export function itemLocation(it: XNode): { x: number; y: number } { return { x: xnum(it, 'Location/X'), y: xnum(it, 'Location/Y') }; }
/** The scale as a factor (4:1 → 4, 1:2 → 0.5). */
export function itemScale(it: XNode): number {
  if (xstr(it, 'UseCustomScale') === 'true') { const c = xnum(it, 'CustomScale', 1); return c > 0 ? c : 1; }
  const n = xnum(it, 'Scale/Numenator', 1), d = xnum(it, 'Scale/Denominator', 1);
  return n > 0 && d > 0 ? n / d : 1;
}
export const scaleText = (s: number) => (s >= 1 ? `${+s.toFixed(3)}:1` : `1:${+(1 / s).toFixed(3)}`);
/** A view's rotation (degrees counter-clockwise: Ccw0, Ccw90 …). */
export const itemRotation = (it: XNode) => { const m = /(\d+)/.exec(xstr(it, 'Rotation')); return m ? Number(m[1]) : xnum(it, 'RotationV2', 0) * 90; };
export const itemSide = (it: XNode): 'Top' | 'Bottom' => (/bottom/i.test(xstr(it, 'ViewSide')) ? 'Bottom' : 'Top');

let idCounter = 0;
/** The next free Id among the document's items and pages. */
export function nextId(d: DraftDocument): number {
  let max = 0;
  for (const p of xkidsNamed(pagesNode(d), 'Page')) {
    max = Math.max(max, xnum(p, 'Id'));
    for (const it of pageItems(p)) max = Math.max(max, xnum(it, 'Id'));
  }
  return Math.max(max, idCounter) + 1;
}

/* ─── Changes (each undoable) ─────────────────────────────────────────────────────── */

export function change(d: DraftDocument, label: string, redo: () => void, undo: () => void): void {
  redo();
  d.undo.push({ label, undo, redo });
  if (d.undo.length > 200) d.undo.shift();
  d.redo = [];
  d.dirty = true;
}
export function undoDraft(d: DraftDocument): string | null {
  const c = d.undo.pop();
  if (!c) return null;
  c.undo(); d.redo.push(c); d.dirty = true;
  return c.label;
}
export function redoDraft(d: DraftDocument): string | null {
  const c = d.redo.pop();
  if (!c) return null;
  c.redo(); d.undo.push(c); d.dirty = true;
  return c.label;
}

/** Sets texts at paths of an item (each path as it is in the item), undoably. */
export function setItemValues(d: DraftDocument, it: XNode, values: Record<string, string | number>, label = 'Change'): void {
  const before = Object.fromEntries(Object.keys(values).map((k) => [k, xpath(it, k) ? xtext(xpath(it, k)) : null]));
  change(d, label, () => { for (const [k, v] of Object.entries(values)) xset(it, k, v); }, () => { for (const [k, v] of Object.entries(before)) if (v !== null) xset(it, k, v); });
}

export function moveItem(d: DraftDocument, it: XNode, x: number, y: number): void {
  setItemValues(d, it, { 'Location/X': round(x), 'Location/Y': round(y) }, 'Move');
}
const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** A scale as AD keeps it: a whole ratio when there is one (4:1, 1:2), else the custom factor. */
export function setItemScale(d: DraftDocument, it: XNode, s: number): void {
  const whole = s >= 1 ? Number.isInteger(+s.toFixed(6)) : Number.isInteger(+(1 / s).toFixed(6));
  const [n, den] = s >= 1 ? [Math.round(s), 1] : [1, Math.round(1 / s)];
  const v: Record<string, string | number> = whole ? { 'Scale/Numenator': n, 'Scale/Denominator': den, UseCustomScale: 'false' } : { CustomScale: round(s), UseCustomScale: 'true' };
  setItemValues(d, it, v, 'Scale');
}

export function addItem(d: DraftDocument, page: XNode, item: XNode): void {
  let items = itemsNode(page);
  if (!items) { items = xfrom('<Items/>'); const at = page.kids.findIndex((k) => typeof k !== 'string' && localName(k.name) > 'Items'); page.kids.splice(at < 0 ? page.kids.length : at, 0, items); }
  const list = items;
  change(d, 'Place', () => { list.kids.push(item); list.empty = false; }, () => { const i = list.kids.indexOf(item); if (i >= 0) list.kids.splice(i, 1); });
}
export function removeItem(d: DraftDocument, page: XNode, item: XNode): void {
  const list = itemsNode(page);
  if (!list) return;
  const i = list.kids.indexOf(item);
  if (i < 0) return;
  change(d, 'Delete', () => { list.kids.splice(list.kids.indexOf(item), 1); }, () => { list.kids.splice(Math.min(i, list.kids.length), 0, item); });
}

/** A new page of a standard size (landscape), its zones as AD gives them [est: 8 × 6 on A3, fewer on smaller sheets]. */
export function pageXml(id: number, size: string): string {
  const [wmm, hmm] = SHEETS[size] ?? SHEETS.A3!;
  const hz = wmm >= 400 ? 8 : 6, vz = wmm >= 400 ? 6 : 4;
  return `<Page><Id>${id}</Id><HorizontalZoneCount>${hz}</HorizontalZoneCount><Items/><Margin><Bottom>10</Bottom><Left>10</Left><Right>10</Right><Top>10</Top></Margin>`
    + `<SheetSizingMode>StandardSize</SheetSizingMode><ShowZones>true</ShowZones><Size><Height>${round(hmm * PX_PER_MM)}</Height><Width>${round(wmm * PX_PER_MM)}</Width></Size>`
    + `<StandardSizeName>${size}</StandardSizeName><TemplateFileName/><VerticalZoneCount>${vz}</VerticalZoneCount></Page>`;
}
export function addPage(d: DraftDocument, size = 'A3'): XNode {
  let pages = pagesNode(d);
  if (!pages) { pages = xfrom('<Pages/>'); insertSorted(d.root, pages); }
  const p = xfrom(pageXml(nextId(d), size));
  const list = pages;
  change(d, 'Add Page', () => { list.kids.push(p); list.empty = false; }, () => { const i = list.kids.indexOf(p); if (i >= 0) list.kids.splice(i, 1); });
  return p;
}
export function removePage(d: DraftDocument, page: XNode): void {
  const list = pagesNode(d);
  if (!list) return;
  const i = list.kids.indexOf(page);
  if (i < 0) return;
  change(d, 'Delete Page', () => { list.kids.splice(list.kids.indexOf(page), 1); }, () => { list.kids.splice(Math.min(i, list.kids.length), 0, page); });
}
/** A page's sheet changed to a standard size. */
export function setPageSize(d: DraftDocument, page: XNode, size: string): void {
  const [wmm, hmm] = SHEETS[size] ?? SHEETS.A3!;
  setItemValues(d, page, { StandardSizeName: size, 'Size/Width': round(wmm * PX_PER_MM), 'Size/Height': round(hmm * PX_PER_MM), SheetSizingMode: 'StandardSize' }, 'Sheet Size');
}

/** A data member put among its siblings in DataContract order (Id first, then by name). */
function insertSorted(parent: XNode, el: XNode): void {
  const name = localName(el.name);
  const at = parent.kids.findIndex((k) => typeof k !== 'string' && localName(k.name) !== 'Id' && localName(k.name) > name);
  parent.kids.splice(at < 0 ? parent.kids.length : at, 0, el);
  parent.empty = false;
}

/* ─── Items Konium places ────────────────────────────────────────────────────────── */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colour = (r: number, g: number, b: number) => `<A>255</A><B>${b}</B><G>${g}</G><R>${r}</R>`;
/** The members every placed item has [AD's, as its board assembly view writes them]. */
const base = (id: number) => `<Id>${id}</Id><Anchor>Top Left</Anchor><OriginatedFromTemplate>false</OriginatedFromTemplate><ElementItems/>`;
const loc = (x: number, y: number) => `<Location><X>${round(x)}</X><Y>${round(y)}</Y></Location>`;

export type PlaceKind = 'assembly' | 'fabrication' | 'drillTable' | 'bom' | 'layerStack' | 'text' | 'titleBlock';
export const PLACE_LABELS: Record<PlaceKind, string> = {
  assembly: 'Board Assembly View', fabrication: 'Board Fabrication View', drillTable: 'Drill Table', bom: 'Bill of Materials',
  layerStack: 'Layer Stack Table', text: 'Text', titleBlock: 'Title Block',
};
/** AD's type for each (the assembly view's as AD writes it; the rest [est]). */
export const PLACE_TYPES: Record<PlaceKind, string> = {
  assembly: 'BoardAssemblyViewData', fabrication: 'BoardFabricationViewData', drillTable: 'DrillTableData', bom: 'BillOfMaterialsTableData',
  layerStack: 'LayerStackTableData', text: 'TextDrawingItemData', titleBlock: 'TitleBlockData',
};

export function itemXml(kind: PlaceKind, id: number, x: number, y: number, o: { board?: string; scale?: number; side?: 'Top' | 'Bottom'; text?: string } = {}): string {
  const type = PLACE_TYPES[kind];
  const open = `<Item xmlns:i="http://www.w3.org/2001/XMLSchema-instance" i:type="${type}">`;
  if (kind === 'assembly' || kind === 'fabrication') {
    const s = o.scale ?? 1;
    const [n, den] = s >= 1 ? [Math.round(s), 1] : [1, Math.round(1 / s)];
    const title = kind === 'assembly' ? 'View from =ViewSide side (Scale =ViewScale)' : 'Fabrication View (Scale =ViewScale)';
    return `${open}${base(id)}<BoardSourceName>${esc(o.board ?? '')}</BoardSourceName><CustomScale>1</CustomScale><HorizontalAlignment>0</HorizontalAlignment>${loc(x, y)}`
      + `<Rotation>Ccw0</Rotation><RotationV2>0</RotationV2><Scale><Denominator>${den}</Denominator><Numenator>${n}</Numenator></Scale><ShowTitle>true</ShowTitle><Size><Height>0</Height><Width>0</Width></Size>`
      + `<Title>${title}</Title><TitleColor>${colour(0, 0, 0)}</TitleColor><TitleFontStyleId>7</TitleFontStyleId><UseCustomScale>false</UseCustomScale><UseDocumentFontForTitle>true</UseDocumentFontForTitle><VerticalAlignment>2</VerticalAlignment>`
      + `<BoardShapeLineStyleId>1</BoardShapeLineStyleId>${kind === 'assembly' ? '<ComponentLineStyleId>2</ComponentLineStyleId>' : ''}<ViewSide>${o.side ?? 'Top'}</ViewSide><ViewSideV2>${o.side === 'Bottom' ? 1 : 0}</ViewSideV2></Item>`;
  }
  if (kind === 'text') {
    return `${open}${base(id)}<Color>${colour(0, 0, 0)}</Color><FontStyleId>7</FontStyleId>${loc(x, y)}<Rotation>Ccw0</Rotation><Text>${esc(o.text ?? 'Text')}</Text></Item>`;
  }
  const title = kind === 'drillTable' ? 'Drill Table' : kind === 'bom' ? 'Bill of Materials' : kind === 'layerStack' ? 'Layer Stack Table' : 'Title Block';
  return `${open}${base(id)}<FontStyleId>7</FontStyleId>${loc(x, y)}<ShowTitle>true</ShowTitle><Title>${title}</Title></Item>`;
}

export function placeItem(d: DraftDocument, page: XNode, kind: PlaceKind, x: number, y: number, o: Parameters<typeof itemXml>[4] = {}): XNode {
  const it = xfrom(itemXml(kind, nextId(d), x, y, o));
  idCounter = Math.max(idCounter, xnum(it, 'Id'));
  addItem(d, page, it);
  return it;
}

/* ─── A new document ─────────────────────────────────────────────────────────────── */

/**
 * A new Draftsman document for a board: one sheet, its views and tables laid out as a
 * fabrication and assembly drawing (AD starts from an empty sheet of its template [est]).
 */
export function newDraftsman(name: string, board: string, o: { size?: string; layout?: { kind: PlaceKind; x: number; y: number; scale?: number; side?: 'Top' | 'Bottom'; text?: string }[]; params?: Record<string, string> } = {}): DraftDocument {
  const size = o.size ?? 'A3';
  const font = (id: number, size: number, bold = false) => `<FontStyleData><Decorations>None</Decorations><DecorationsV2>0</DecorationsV2><FamilyName>Arial</FamilyName><Id>${id}</Id><Size>${size}</Size>${bold ? '<Weight>Bold</Weight>' : ''}</FontStyleData>`;
  const line = (id: number, t: number) => `<LineStyleData><Color/><DashPattern/><DashPatternPresetId>0</DashPatternPresetId><Id>${id}</Id><Thickness>${t}</Thickness><ThicknessPresetId>${id}</ThicknessPresetId></LineStyleData>`;
  const params = Object.entries(o.params ?? {}).map(([k, v]) => `<DrawingDocumentParameterData><Name>${esc(k)}</Name><Value>${esc(v)}</Value><Version/></DrawingDocumentParameterData>`).join('');
  const xml = `<Document xmlns="${DWF_NS}" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Id>0</Id>`
    + `<DocumentOptions><DecimalSeparator>.</DecimalSeparator><FontStyleId>7</FontStyleId><GridSize>${round(PX_PER_MM)}</GridSize><GridVisible>true</GridVisible><SnapToGrid>true</SnapToGrid><ZoneLetterPosition>Columns</ZoneLetterPosition><ZoneOrigin>TopLeft</ZoneOrigin></DocumentOptions>`
    + `<FontStyles>${font(1, 2)}${font(6, 8)}${font(7, 12)}${font(8, 18, true)}</FontStyles><FormatVersion>24</FormatVersion>`
    + `<LineStyles>${line(1, 1.889763779527559)}${line(2, 0.7559055118110238)}</LineStyles><Pages>${pageXml(1, size)}</Pages><Parameters>${params}</Parameters>`
    + `<SourceDocumentName>${esc(board)}</SourceDocumentName></Document>`;
  const { root } = parseTree(xml);
  const d: DraftDocument = { kind: 'Draftsman', name, prolog: '', root, dirty: true, undo: [], redo: [] };
  const page = xkidsNamed(pagesNode(d), 'Page')[0]!;
  for (const it of o.layout ?? []) placeItem(d, page, it.kind, it.x, it.y, { board, scale: it.scale, side: it.side, text: it.text });
  d.undo = [];
  return d;
}

/** The board the document draws: its source document's name (a path in AD's), the first view's board else. */
export function draftSourceBoard(d: DraftDocument): string {
  const src = xstr(d.root, 'SourceDocumentName');
  if (src) return src.split(/[\\/]/).pop()!;
  for (const p of xkidsNamed(pagesNode(d), 'Page')) for (const it of pageItems(p)) { const b = xstr(it, 'BoardSourceName'); if (b) return b.split(/[\\/]/).pop()!; }
  return '';
}

/** A document parameter's value (Title, Revision …), else ''. */
export function draftParameter(d: DraftDocument, name: string): string {
  const p = xkidsNamed(xkid(d.root, 'Parameters'), 'DrawingDocumentParameterData').find((x) => xstr(x, 'Name').toLowerCase() === name.toLowerCase());
  return p ? xstr(p, 'Value') : '';
}
export function setDraftParameter(d: DraftDocument, name: string, value: string): void {
  let list = xkid(d.root, 'Parameters');
  if (!list) { list = xfrom('<Parameters/>'); insertSorted(d.root, list); }
  const p = xkidsNamed(list, 'DrawingDocumentParameterData').find((x) => xstr(x, 'Name').toLowerCase() === name.toLowerCase());
  if (p) { setItemValues(d, p, { Value: value }, 'Parameter'); return; }
  const el = xfrom(`<DrawingDocumentParameterData><Name>${esc(name)}</Name><Value>${esc(value)}</Value><Version/></DrawingDocumentParameterData>`);
  const l = list;
  change(d, 'Parameter', () => { l.kids.push(el); l.empty = false; }, () => { const i = l.kids.indexOf(el); if (i >= 0) l.kids.splice(i, 1); });
}

export { xkids, xnum, xstr };
