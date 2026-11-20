import { describe, expect, it } from 'vitest';
import { newBomDoc, readBomDoc, writeBomDoc } from '../src/formats/altium/bomdoc';
import { detect } from '../src/formats/registry';
import {
  bomChecks, bomLines, bomTotals, choiceBag, choiceOf, designKeys, ensureItem, jlcBomCsv, lineCells, lineChoices, lineCost, packageOf, refreshChoice, searchFor, setLineNumbers, unitPrice,
} from '../src/model/activeBom';
import { parsePrices, searchJlc } from '../src/platform/jlcSearch';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

/** An ActiveBOM document as AD writes one (made up): a capacitor line with two part choices. */
const AD_BOM = [
  '|RECORD=BOM|VERSION=3|FILENAME=.\\Board.$$$|KIND=ALTIUM_DESIGNER_LIVEBOM|DATE=01.02.2026|TIME=10:00:00|CURRENCY=USD|PRODUCTIONQUANTITY=10|PERUNITTARGETPRICE=0|PERUNITACTUALPRICE=0',
  '|RECORD=GeneralOptions|NOTFITTED=False|INCLUDEDBPARAMETERS=False|SOLUTIONSPERITEM=1',
  '|RECORD=SortOrderOptions|SORTORDER=Line #=Up',
  '|RECORD=GroupOrderOptions|GROUPORDER=',
  '|RECORD=VisibleOrderOptions|VISIBLEORDER=Line #=53!Designator=277!Comment=122!Quantity=65!Manufacturer Part Number 1=162!Supplier Unit Price 1=122',
  '|RECORD=CheckGroupCompParamsOptions|CHECKGROUPCOMPPARAMS=Comment=0,Description=0,Value=0,Footprint=1',
  '|RECORD=LineNumberingOptions|STARTVALUE=10|INCREMENT=10',
  '|RECORD=Catalog|DBLINKFILEPATH=',
  '|RECORD=CatalogItem|ITEMTYPE=Automatic-NonVault|UNIQUEID=Passives.SchLib\\CAP|DESIGNITEMID=CAP|ITEMSOURCE=Passives.SchLib|STATUS=Unknown|DESCRIPTION=Capacitor|USERCOMMENTS=100nF|NOTE=|LINENUMBER=1|SELECTEDPARAMETERSHASH=100nF,Capacitor|COMPONENTPARAMETERS=|CUSTOMPARAMETERS=',
  '|RECORD=PartChoice|PARTCHOICETYPE=AUTO_SCHLINKS|MANUFACTURER=Acme|MANUFACTURERPARTNO=CC0402-104|SUPPLIER=Distributor|SUPPLIERPARTNO=D-104|AVAILABLEQUANTITY=15|CURRENCY=USD|LIFECYCLESTATUS=Volume Production|PRICECOUNT=3|P1=0.1|Q1=1|L1=US|P2=0.05|Q2=10|L2=US|P3=0.01|Q3=100|L3=US',
  '|RECORD=PartChoice|PARTCHOICETYPE=AUTO_SCHLINKS|MANUFACTURER=Other|MANUFACTURERPARTNO=X104|SUPPLIER=|SUPPLIERPARTNO=',
  '|RECORD=PartChoiceGroups|GROUPBYFIELDCOUNT=0',
].join('\r\n') + '\r\n';

/** Parts as a project compiles them, each with its design item. */
function parts(list: [string, string, string, string, Record<string, string>?][]): Record<string, string>[] {
  return list.map(([des, comment, footprint, libRef, extra]) => {
    const it = { Designator: des, Comment: comment, Description: libRef === 'CAP' ? 'Capacitor' : 'Resistor', Footprint: footprint, LibRef: libRef, ...extra };
    designKeys.set(it, { library: 'Passives.SchLib', libRef });
    return it;
  });
}

describe('BOM documents as AD keeps them (records)', () => {
  it('read: columns with their widths, sort, production quantity, the items and their part choices; written back as read', () => {
    const b = enc(AD_BOM);
    expect(detect(b, 'X.BomDoc')).toBe('BomDoc');
    const d = readBomDoc(b, 'Board.BomDoc');
    expect(d.setup.columns).toEqual(['Line #', 'Designator', 'Comment', 'Quantity', 'Manufacturer Part Number 1', 'Supplier Unit Price 1']);
    expect(d.widths.Designator).toBe(277);
    expect(d.setup.sort).toEqual({ column: 'Line #', descending: false });
    expect([d.production, d.currency, d.items.length, d.items[0]!.choices.length]).toEqual([10, 'USD', 1, 2]);
    const c = choiceOf(d.items[0]!.choices[0]!);
    expect([c.mpn, c.supplier, c.stock, c.prices.length, unitPrice(c, 5), unitPrice(c, 10), unitPrice(c, 1000)]).toEqual(['CC0402-104', 'Distributor', 15, 3, 0.1, 0.05, 0.01]);
    expect(dec(writeBomDoc(d))).toBe(AD_BOM);
    // A change rewrites only its record
    d.production = 25;
    const out = dec(writeBomDoc(d)).split('\r\n');
    expect(out[0]).toContain('|PRODUCTIONQUANTITY=25|');
    expect(out.slice(1)).toEqual(AD_BOM.split('\r\n').slice(1));
  });

  it('a new document has AD\'s records; Konium\'s INI documents of before are read', () => {
    const n = dec(writeBomDoc(newBomDoc('New.BomDoc', new Date(2026, 0, 2, 3, 4, 5))));
    expect(n.split('\r\n')[0]).toBe('|RECORD=BOM|VERSION=3|FILENAME=New.$$$|KIND=ALTIUM_DESIGNER_LIVEBOM|DATE=02.01.2026|TIME=03:04:05|CURRENCY=USD|PRODUCTIONQUANTITY=1|PERUNITTARGETPRICE=0|PERUNITACTUALPRICE=0');
    expect(n).toContain('|RECORD=VisibleOrderOptions|VISIBLEORDER=Line #=100!Comment=100!');
    const old = readBomDoc(enc('[ActiveBOM]\r\nVersion=1.0\r\nVariantName=Lite\r\nColumnCount=2\r\nColumn1=Comment\r\nColumn2=Quantity\r\nGroupCount=1\r\nGroup1=Comment\r\n'), 'Old.BomDoc');
    expect([old.variant, old.setup.columns, old.setup.group]).toEqual(['Lite', ['Comment', 'Quantity'], ['Comment']]);
    expect(dec(writeBomDoc(old))).toMatch(/^\|RECORD=BOM\|/);
  });
});

describe('ActiveBOM: lines, part choices, cost, checks', () => {
  it('lines by design item, comment and description (as AD), tied to their catalog items; cost for the run', () => {
    const d = readBomDoc(enc(AD_BOM), 'Board.BomDoc');
    const items = parts([['C1', '100nF', 'C0402', 'CAP'], ['C2', '100nF', 'C0402', 'CAP'], ['R1', '10k', 'R0603', 'RES'], ['R2', '1k', 'R0603', 'RES', { 'Manufacturer 1': 'Yageo', 'Manufacturer Part Number 1': 'RC0603FR-071KL', LCSC: 'C21190' }]]);
    const lines = bomLines(items, { group: [], columns: [] }, d);
    expect(lines.map((l) => [l.designators.join(','), !!l.item])).toEqual([['C1,C2', true], ['R1', false], ['R2', false]]);
    const cap = lines[0]!;
    // 2 a board, 10 boards: 20 at the 10-off price
    expect(lineCost(cap, d.production)).toEqual({ units: 20, unit: 0.05, subtotal: 1, currency: 'USD' });
    expect(lineCells(cap, ['Line #', 'Manufacturer 1', 'Supplier Stock 1', 'Supplier Unit Price 1', 'Supplier Subtotal 1', 'Quantity'], d.production)).toEqual(['1', 'Acme', '15', '$0.0500', '$1.00', '2']);
    // From the parts' parameters, as AD's schematic supplier links
    expect(lineChoices(lines[2]!).map((c) => [c.manufacturer, c.mpn, c.supplier, c.spn, c.from])).toEqual([['Yageo', 'RC0603FR-071KL', 'LCSC', 'C21190', 'parameters']]);
    expect(bomTotals(lines, d.production)).toMatchObject({ run: 1, perBoard: 0.1, priced: 1, lines: 3 });
    expect(bomChecks(d, lines, d.production).map((c) => `${c.check}: ${c.message}`)).toEqual([
      'Insufficient stock: C1, C2: Distributor has 15 of D-104, 20 needed',
      'No part choices: R1: no manufacturer part or supplier',
      'Missing line numbers: R1: no line number',
      'Missing line numbers: R2: no line number',
    ]);
    setLineNumbers(d, lines);
    expect(lines.map((l) => l.item?.bag.get('LINENUMBER'))).toEqual(['10', '20', '30']);
    expect(d.items).toHaveLength(3);
    expect(dec(writeBomDoc(d))).toContain('|RECORD=CatalogItem|ITEMTYPE=Automatic-NonVault|UNIQUEID=Passives.SchLib\\RES|DESIGNITEMID=RES|ITEMSOURCE=Passives.SchLib');
  });

  it('checks: risky lifecycle, a footprint that differs within a line, duplicate designators', () => {
    const d = newBomDoc('B.BomDoc');
    const items = parts([['U1', 'LDO', 'SOT-23', 'LDO'], ['U2', 'LDO', 'SOT-23-5', 'LDO'], ['U2', 'LDO', 'SOT-23', 'LDO']]);
    const lines = bomLines(items, { group: [], columns: [] }, d);
    ensureItem(d, lines[0]!).choices.push(choiceBag({ manufacturer: 'Acme', mpn: 'LDO-1', supplier: 'LCSC', spn: 'C1', stock: 100, prices: [{ qty: 1, price: 0.2 }], currency: 'USD', lifecycle: 'Obsolete', url: '', description: '' }));
    expect(bomChecks(d, lines, 1).map((c) => [c.check, c.level])).toEqual([['Risky lifecycle', 'error'], ['Ambiguous parameters', 'warning'], ['Duplicate designators', 'error']]);
  });

  it('JLCPCB: its assembly BOM; the part looked up by LCSC number, part number, or value and package', () => {
    const items = parts([['C1', '100nF', 'C0402_L', 'CAP', { LCSC: 'C1525' }], ['C2', '100nF', 'C0402_L', 'CAP', { LCSC: 'C1525' }], ['R1', '10k', 'RESC1608X55N_0603', 'RES']]);
    const lines = bomLines(items, { group: [], columns: [] }, null);
    expect(jlcBomCsv(lines).split('\r\n')).toEqual(['Comment,Designator,Footprint,LCSC Part #', '100nF,"C1,C2",C0402_L,C1525', '10k,R1,RESC1608X55N_0603,', '']);
    expect(lines.map(searchFor)).toEqual(['C1525', '10k 0603']);
    expect(['SOT-23-5_L2.9', 'SOIC127P600X175-8N', 'QFN-32_5x5', 'TO-220-3', 'Custom'].map(packageOf)).toEqual(['SOT-23-5', 'SOIC-8', 'QFN-32', 'TO-220', '']);
  });

  it('JLCPCB\'s parts: price breaks in either form; a search answered by the service, the part number asked for first', async () => {
    expect(parsePrices('[{"qFrom":1,"qTo":9,"price":0.0123},{"qFrom":10,"qTo":null,"price":0.008}]')).toEqual([{ qty: 1, price: 0.0123 }, { qty: 10, price: 0.008 }]);
    expect(parsePrices('1-9:0.02,10-99:0.015')).toEqual([{ qty: 1, price: 0.02 }, { qty: 10, price: 0.015 }]);
    let asked = '';
    const fake = (async (url: string) => { asked = url; return new Response(JSON.stringify({ components: [
      { lcsc: 2, mfr: 'ABC-X', package: '0402', description: 'other', stock: 9000, price: '[{"qFrom":1,"price":0.01}]', is_basic: true },
      { lcsc: 1525, mfr: 'CL05B104KO5NNNC', package: '0402', description: '100nF', stock: 500, price: '[{"qFrom":1,"price":0.0021}]', is_basic: false, is_preferred: true },
    ] }), { status: 200 }); }) as unknown as typeof fetch;
    const r = await searchJlc('CL05B104KO5NNNC', fake);
    expect(asked).toBe('https://jlcsearch.tscircuit.com/components/list.json?search=CL05B104KO5NNNC');
    expect(r.map((x) => [x.lcsc, x.library])).toEqual([['C1525', 'Preferred'], ['C2', 'Basic']]);
    expect((await searchJlc('C1525', fake)).map((x) => x.lcsc)).toEqual(['C1525']);
    // Found again: stock and prices refreshed in the part choice
    const b = choiceBag({ manufacturer: '', mpn: 'CL05B104KO5NNNC', supplier: 'LCSC', spn: 'C1525', stock: 1, prices: [{ qty: 1, price: 1 }, { qty: 10, price: 0.5 }], currency: 'USD', lifecycle: '', url: '', description: '' });
    refreshChoice(b, { stock: r[0]!.stock, prices: r[0]!.prices, currency: 'USD', library: r[0]!.library });
    expect(choiceOf(b)).toMatchObject({ stock: 500, prices: [{ qty: 1, price: 0.0021 }], library: 'Preferred' });
    expect(b.has('P2')).toBe(false);
  });
});
