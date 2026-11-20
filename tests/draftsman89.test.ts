import { describe, expect, it } from 'vitest';
import { lz4Decode, lz4Encode } from '../src/formats/lz4';
import { parseTree, writeTree, xkid, xnum, xstr } from '../src/formats/xmlTree';
import {
  PX_PER_MM, addPage, draftPages, draftParameter, draftSourceBoard, isPcbDwf, itemLocation, itemScale, itemType, moveItem, newDraftsman, packPcbDwf, pageItems,
  readPcbDwf, redoDraft, removeItem, removePage, setDraftParameter, setItemScale, setPageSize, undoDraft, unpackPcbDwf, writePcbDwf,
} from '../src/formats/altium/pcbdwf';
import { detect, load, save } from '../src/formats/registry';
import { readPcbDoc } from '../src/formats/altium/pcbdoc';
import { demoPcbDoc } from '../src/formats/synthetic/demo';
import { drawPage } from '../src/render/draftDoc';
import { defaultLayout } from '../src/app/draftsmanNew';

const demo = () => readPcbDoc(demoPcbDoc(), 'Demo.PcbDoc');
/** Byte arrays alike (vitest's own comparison is slow on megabytes). */
const same = (a: Uint8Array, b: Uint8Array) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

describe('LZ4 blocks', () => {
  it('round trips text, repeats and noise', () => {
    const text = new TextEncoder().encode('<Document><Item>Hello</Item>'.repeat(5000) + 'end');
    const packed = lz4Encode(text);
    expect(packed.length).toBeLessThan(text.length / 10);
    expect(same(lz4Decode(packed, text.length), text)).toBe(true);
    let seed = 7;
    const noise = Uint8Array.from({ length: 70_000 }, () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; });
    expect(same(lz4Decode(lz4Encode(noise), noise.length), noise)).toBe(true);
    for (const n of [0, 1, 5, 12, 13, 20]) { const a = new Uint8Array(n).fill(65); expect(same(lz4Decode(lz4Encode(a), n), a)).toBe(true); }
  });
});

describe('the lossless XML tree', () => {
  it('writes back what it read, prefixes, entities and empty elements kept', () => {
    const x = '<?xml version="1.0"?><Document xmlns="urn:a" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><Id>0</Id><A i:nil="true"/><B>x &amp; y &lt;z&gt;</B><a:C xmlns:a="urn:c"><a:D>1.5</a:D></a:C><Items><Item i:type="T"><Name>µ</Name></Item></Items></Document>';
    const { prolog, root } = parseTree(x);
    expect(writeTree(root, prolog)).toBe(x);
    expect(xstr(root, 'B')).toBe('x & y <z>');
    expect(xnum(root, 'C/D')).toBe(1.5);
    expect(xkid(root, 'A')?.empty).toBe(true);
  });
});

describe('Draftsman documents (.PCBDwf)', () => {
  it('packed in chunks of LZ4, read back', () => {
    const text = new TextEncoder().encode(`<Document xmlns="http://schemas.datacontract.org/2004/07/Altium.Designer.PcbDrawing.DataSerialization.V1">${'<X>1</X>'.repeat(300_000)}</Document>`);
    const bytes = packPcbDwf(text);
    expect(bytes[0]).toBe(1);
    expect(same(unpackPcbDwf(bytes), text)).toBe(true);
    expect(isPcbDwf(bytes)).toBe(true);
    expect(isPcbDwf(new TextEncoder().encode('[Design]\r\n'))).toBe(false);
    expect(detect(bytes, 'X.PCBDwf')).toBe('Draftsman');
  });
  it('a new one for a board: a sheet with its views, tables, notes and title block', () => {
    const b = demo();
    const d = newDraftsman('Demo1.PCBDwf', 'Demo.PcbDoc', { size: 'A3', layout: defaultLayout(b, 'A3'), params: { Title: 'Demo', Revision: '2' } });
    expect(draftSourceBoard(d)).toBe('Demo.PcbDoc');
    const [p] = draftPages(d);
    expect(p!.sizeName).toBe('A3');
    expect(p!.w / PX_PER_MM).toBeCloseTo(420, 3);
    const types = pageItems(p!.node).map(itemType);
    expect(types).toEqual(['BoardAssemblyViewData', 'BoardAssemblyViewData', 'BoardFabricationViewData', 'DrillTableData', 'LayerStackTableData', 'BillOfMaterialsTableData', 'TextDrawingItemData', 'TitleBlockData']);
    expect(draftParameter(d, 'Revision')).toBe('2');
    // Drawn from the board
    const page = drawPage(d, p!, { board: b, pageNo: 1, pages: 1, when: new Date(2026, 10, 2), docName: d.name });
    for (const t of ['View from Top side (Scale 2:1)', 'View from Bottom side', 'Drill Table', 'Bill of Materials', 'Layer Stack', 'NOTES:', 'Demo.PcbDoc', '02/11/2026', '1 of 1']) expect(page.svg).toContain(t);
    expect(page.items.map((x) => x.label)).toContain('Title Block');
    // Within the sheet
    for (const it of page.items) { expect(it.box.x).toBeGreaterThan(0); expect(it.box.x + it.box.w).toBeLessThan(p!.w); expect(it.box.y + it.box.h).toBeLessThan(p!.h); }
    // Saved and read back the same; the registry reads and writes it
    const bytes = writePcbDwf(d);
    const back = load(bytes, 'Demo1.PCBDwf');
    expect(back.kind).toBe('Draftsman');
    expect(pageItems(draftPages(back as typeof d)[0]!.node).map(itemType)).toEqual(types);
    expect(same(save(back), bytes)).toBe(true);
  });
  it('edits: move, scale, delete, sheets, parameters — each undone and redone', () => {
    const d = newDraftsman('A.PCBDwf', 'B.PcbDoc', { size: 'A4', layout: [{ kind: 'assembly', x: 100, y: 100, scale: 1 }, { kind: 'text', x: 50, y: 500, text: 'Hello & <you>' }] });
    const page = draftPages(d)[0]!.node;
    const [view, text] = pageItems(page);
    moveItem(d, view!, 250.5, 120);
    expect(itemLocation(view!)).toEqual({ x: 250.5, y: 120 });
    expect(undoDraft(d)).toBe('Move');
    expect(itemLocation(view!)).toEqual({ x: 100, y: 100 });
    expect(redoDraft(d)).toBe('Move');
    expect(itemLocation(view!).x).toBe(250.5);
    setItemScale(d, view!, 0.5);
    expect(itemScale(view!)).toBe(0.5);
    expect(xstr(view!, 'Scale/Denominator')).toBe('2');
    setItemScale(d, view!, 1.5);
    expect(itemScale(view!)).toBe(1.5);
    expect(xstr(view!, 'UseCustomScale')).toBe('true');
    expect(xstr(text!, 'Text')).toBe('Hello & <you>');
    removeItem(d, page, text!);
    expect(pageItems(page)).toHaveLength(1);
    undoDraft(d);
    expect(pageItems(page)).toHaveLength(2);
    addPage(d, 'A3');
    expect(draftPages(d).map((p) => p.sizeName)).toEqual(['A4', 'A3']);
    setPageSize(d, draftPages(d)[1]!.node, 'A2');
    expect(draftPages(d)[1]!.w / PX_PER_MM).toBeCloseTo(594, 3);
    removePage(d, draftPages(d)[1]!.node);
    expect(draftPages(d)).toHaveLength(1);
    setDraftParameter(d, 'Title', 'Board X');
    expect(draftParameter(d, 'Title')).toBe('Board X');
    const re = readPcbDwf(writePcbDwf(d), 'A.PCBDwf');
    expect(draftParameter(re, 'Title')).toBe('Board X');
    expect(itemScale(pageItems(draftPages(re)[0]!.node)[0]!)).toBe(1.5);
  });
  it('an item it doesn\'t draw: a box named by its type, kept as it is', () => {
    const d = newDraftsman('A.PCBDwf', 'B.PcbDoc', { size: 'A4' });
    const page = draftPages(d)[0]!;
    const items = xkid(page.node, 'Items')!;
    items.kids.push(parseTree('<Item xmlns:i="http://www.w3.org/2001/XMLSchema-instance" i:type="BoardRealisticViewData"><Id>9</Id><Location><X>10</X><Y>20</Y></Location><Secret>kept</Secret></Item>').root);
    const r = drawPage(d, draftPages(d)[0]!, { board: null, pageNo: 1, pages: 1, when: new Date(), docName: 'A' });
    expect(r.items[0]!.label).toBe('Board Realistic View');
    expect(new TextDecoder().decode(unpackPcbDwf(writePcbDwf(d)))).toContain('<Secret>kept</Secret>');
  });
});
